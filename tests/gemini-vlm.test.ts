/**
 * Tests for Gemini VLM Connector — adaptive sampling, output normalization,
 * tag cleaning, prompt hash, parse retry, and mocked integration.
 *
 * All tests use mock VlmFn — no real Gemini API calls.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { createRequire } from "node:module";
import {
  getAdaptiveSampleFps,
  computeFrameCount,
  computeVlmOutputTokenBudget,
  computeSampleTimestamps,
  classifyVlmTruncationReason,
  adjustFpsForBudget,
  estimateVlmSchemaOutputTokens,
  toSnakeCase,
  normalizeTags,
  normalizeQualityFlags,
  normalizeInterestPoints,
  normalizeVlmOutput,
  parseVlmJson,
  enrichSegment,
  shouldSkipVlm,
  computePromptHash,
  computeRepairPromptHash,
  computeVlmRequestHash,
  guessAssetRole,
  buildSegmentPrompt,
  createGeminiVlmFn,
  VLM_CONNECTOR_VERSION,
  VLM_OUTPUT_TOKEN_BUDGET_HARD_MAX,
  VLM_TRUNCATED_RESPONSE_ERROR,
  PROMPT_TEMPLATE_ID,
  type VlmFn,
  type VlmPolicy,
  type SamplingPolicy,
  type VlmRawResponse,
} from "../runtime/connectors/gemini-vlm.js";
import {
  getVlmProviderResponseSchema,
  validateVlmGroundingResponse,
} from "../runtime/validation/vlm-grounding-response-validator.js";
import { runPipeline, type PipelineResult } from "../runtime/pipeline/ingest.js";

// ── Schema Validator Setup ──────────────────────────────────────────

const require_ = createRequire(import.meta.url);
const Ajv2020 = require_("ajv/dist/2020") as new (opts: Record<string, unknown>) => {
  compile(schema: object): {
    (data: unknown): boolean;
    errors?: Array<{ instancePath: string; message?: string }> | null;
  };
  addSchema(schema: object): void;
};
const addFormats = require_("ajv-formats") as (ajv: unknown) => void;

const REPO_ROOT = path.resolve(import.meta.dirname, "..");

function createSegmentsValidator() {
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats(ajv);
  const schemasDir = path.join(REPO_ROOT, "schemas");
  const commonSchema = JSON.parse(
    fs.readFileSync(path.join(schemasDir, "analysis-common.schema.json"), "utf-8"),
  );
  ajv.addSchema(commonSchema);
  const segmentsSchema = JSON.parse(
    fs.readFileSync(path.join(schemasDir, "segments.schema.json"), "utf-8"),
  );
  return ajv.compile(segmentsSchema);
}

// ── Mock VLM Policy ─────────────────────────────────────────────────

const MOCK_VLM_POLICY: VlmPolicy = {
  model_alias: "gemini-2.0-flash",
  model_snapshot: "test-snapshot-vlm",
  input_mode: "frame_bundle_plus_text_context",
  response_format: "json_schema_v1",
  prompt_template_id: "m2-segment-grounded-v3",
  max_frame_width_px: 1024,
  segment_visual_token_budget_max: 8192,
  segment_visual_output_tokens_max: 512,
  segment_visual_frame_cap: 90,
  parse_retry_max: 1,
};

const MOCK_SAMPLING_POLICY: SamplingPolicy = {
  static: { sample_fps: 0.5 },
  action: { sample_fps_default: 4, sample_fps_min: 3, sample_fps_max: 5 },
  dialogue: { sample_fps: 0.5 },
  music_driven: { sample_fps: 1 },
  general: { sample_fps: 1 },
};

// ── Mock VLM Function ───────────────────────────────────────────────

function createMockVlmFn(overrides?: Partial<VlmRawResponse>): VlmFn {
  return async (_framePaths, _prompt, _options) => {
    const response: VlmRawResponse = {
      summary: "A person walks through an outdoor garden scene.",
      tags: ["outdoor_scene", "garden", "Walking Person", "daylight"],
      interest_points: [
        { frame_us: 1_000_000, label: "Person enters frame", confidence: 0.85 },
        { frame_us: 3_000_000, label: "Close-up of flowers", confidence: 0.72 },
      ],
      quality_flags: ["underexposed"],
      confidence: { summary: 0.88, tags: 0.79, quality_flags: 0.65 },
      ...overrides,
    };
    return { rawJson: JSON.stringify(response), provider_request_id: "mock-req-001" };
  };
}

const M1_CONFIDENCE_GROUPS = [
  "tags",
  "motion",
  "framing",
  "direction",
  "appearance",
  "text",
] as const;

function createM1CanonicalResponse(): VlmRawResponse {
  return {
    summary: "A repaired grounded response.",
    tags: ["grounded_response"],
    interest_points: [],
    quality_flags: [],
    confidence: { summary: 0.9, tags: 0.9, quality_flags: 0.9 },
    editorial_observation: {
      motion_type: "static",
      shot_scale: "medium",
      text_presence: "absent",
      confidence: Object.fromEntries(M1_CONFIDENCE_GROUPS.map((group) => [group, 0.9])),
    },
  };
}

function createFailingVlmFn(): VlmFn {
  return async () => {
    throw new Error("API timeout");
  };
}

function createBadJsonVlmFn(): VlmFn {
  return async () => {
    return { rawJson: "This is not JSON at all" };
  };
}

// ── Unit Tests: Adaptive Sampling ───────────────────────────────────

describe("Adaptive Sampling", () => {
  it("returns correct FPS for each segment type", () => {
    expect(getAdaptiveSampleFps("static", MOCK_SAMPLING_POLICY)).toBe(0.5);
    expect(getAdaptiveSampleFps("action", MOCK_SAMPLING_POLICY)).toBe(4);
    expect(getAdaptiveSampleFps("dialogue", MOCK_SAMPLING_POLICY)).toBe(0.5);
    expect(getAdaptiveSampleFps("music_driven", MOCK_SAMPLING_POLICY)).toBe(1);
    expect(getAdaptiveSampleFps("general", MOCK_SAMPLING_POLICY)).toBe(1);
  });

  it("computes frame count with cap", () => {
    // 10 seconds at 4 FPS = 40 frames
    expect(computeFrameCount(10_000_000, 4, 90)).toBe(40);
    // 60 seconds at 4 FPS = 240, capped at 90
    expect(computeFrameCount(60_000_000, 4, 90)).toBe(90);
    // Very short segment: at least 1 frame
    expect(computeFrameCount(100_000, 0.5, 90)).toBe(1);
  });

  it("computes evenly-spaced sample timestamps", () => {
    const ts = computeSampleTimestamps(0, 10_000_000, 5);
    expect(ts).toHaveLength(5);
    // All timestamps within bounds
    for (const t of ts) {
      expect(t).toBeGreaterThanOrEqual(0);
      expect(t).toBeLessThan(10_000_000);
    }
    // Evenly spaced
    for (let i = 1; i < ts.length; i++) {
      expect(ts[i] - ts[i - 1]).toBe(ts[1] - ts[0]);
    }
  });

  it("single frame gets midpoint", () => {
    const ts = computeSampleTimestamps(2_000_000, 4_000_000, 1);
    expect(ts).toEqual([3_000_000]);
  });

  it("zero frames returns empty", () => {
    expect(computeSampleTimestamps(0, 10_000_000, 0)).toEqual([]);
  });

  it("adjusts FPS for token budget", () => {
    // 30 seconds at 4 FPS = 120 frames × 258 tokens = 30,960 → over 8192 budget
    const adjusted = adjustFpsForBudget(30_000_000, 4, 90, 8192, 258);
    expect(adjusted).toBeLessThan(4);
    expect(adjusted).toBeGreaterThan(0);

    // Short segment under budget: no adjustment
    const noAdj = adjustFpsForBudget(2_000_000, 1, 90, 8192, 258);
    expect(noAdj).toBe(1);
  });
});

describe("VLM output token budget", () => {
  it("is bounded and responds to frame count and schema size", () => {
    const compactSchema = { type: "object", properties: {} };
    const compactOneFrame = computeVlmOutputTokenBudget(1, compactSchema, 4096);
    const compactManyFrames = computeVlmOutputTokenBudget(20, compactSchema, 4096);
    const canonicalManyFrames = computeVlmOutputTokenBudget(
      20,
      getVlmProviderResponseSchema(),
      4096,
    );

    expect(estimateVlmSchemaOutputTokens(getVlmProviderResponseSchema())).toBeGreaterThan(0);
    expect(compactManyFrames).toBeGreaterThan(compactOneFrame);
    expect(canonicalManyFrames).toBeGreaterThanOrEqual(compactManyFrames);
    expect(canonicalManyFrames).toBeLessThanOrEqual(VLM_OUTPUT_TOKEN_BUDGET_HARD_MAX);
    expect(computeVlmOutputTokenBudget(20, getVlmProviderResponseSchema(), 512)).toBe(512);
  });

  it("classifies MAX_TOKENS and EOF-equivalent output without retaining content", () => {
    expect(classifyVlmTruncationReason('{"summary":"partial"', null)).toBe("eof");
    expect(classifyVlmTruncationReason('{"summary":"partial }', null)).toBe("eof");
    expect(classifyVlmTruncationReason('{"outer":{"inner":1}', null)).toBe("eof");
    expect(classifyVlmTruncationReason('{"summary":"complete"}', "EOF")).toBe("eof");
    expect(classifyVlmTruncationReason('{"summary":"complete"}', "MAX_TOKENS")).toBe("max_tokens");
    expect(classifyVlmTruncationReason('{"summary":"complete"}', "STOP")).toBeNull();
  });
});

// ── Unit Tests: Tag Normalization ───────────────────────────────────

describe("Tag Normalization", () => {
  it("converts to lower_snake_case", () => {
    expect(toSnakeCase("Outdoor Scene")).toBe("outdoor_scene");
    expect(toSnakeCase("CLOSE-UP")).toBe("close_up");
    expect(toSnakeCase("  mixed  CASE  ")).toBe("mixed_case");
    expect(toSnakeCase("already_snake")).toBe("already_snake");
  });

  it("handles special characters", () => {
    expect(toSnakeCase("person's face")).toBe("person_s_face");
    expect(toSnakeCase("100% zoom")).toBe("100_zoom");
  });

  it("deduplicates tags", () => {
    const result = normalizeTags(["outdoor", "OUTDOOR", "Outdoor"]);
    expect(result).toEqual(["outdoor"]);
  });

  it("caps at maxTags", () => {
    const tags = Array.from({ length: 30 }, (_, i) => `tag_${i}`);
    const result = normalizeTags(tags, 10);
    expect(result).toHaveLength(10);
  });

  it("filters non-string items", () => {
    const result = normalizeTags(["valid", 123, null, undefined, "also_valid"]);
    expect(result).toEqual(["valid", "also_valid"]);
  });

  it("removes empty tags", () => {
    const result = normalizeTags(["", "  ", "valid"]);
    expect(result).toEqual(["valid"]);
  });
});

// ── Unit Tests: Quality Flags ───────────────────────────────────────

describe("Quality Flag Normalization", () => {
  it("passes through vocabulary terms", () => {
    expect(normalizeQualityFlags(["underexposed", "blurry"])).toEqual(["underexposed", "blurry"]);
  });

  it("maps aliases to canonical terms", () => {
    expect(normalizeQualityFlags(["dark", "out_of_focus"])).toEqual(["underexposed", "blurry"]);
  });

  it("drops unknown flags", () => {
    expect(normalizeQualityFlags(["unknown_flag", "blurry"])).toEqual(["blurry"]);
  });

  it("deduplicates after alias mapping", () => {
    expect(normalizeQualityFlags(["dark", "underexposed"])).toEqual(["underexposed"]);
  });
});

// ── Unit Tests: Interest Points ─────────────────────────────────────

describe("Interest Point Normalization", () => {
  it("filters out-of-bounds points", () => {
    const result = normalizeInterestPoints(
      [
        { frame_us: 500_000, label: "in bounds", confidence: 0.8 },
        { frame_us: 20_000_000, label: "out of bounds", confidence: 0.9 },
      ],
      0,
      10_000_000,
    );
    expect(result).toHaveLength(1);
    expect(result[0].label).toBe("in bounds");
  });

  it("clamps confidence to [0, 1]", () => {
    const result = normalizeInterestPoints(
      [{ frame_us: 1_000, label: "test", confidence: 1.5 }],
      0,
      10_000,
    );
    expect(result[0].confidence).toBe(1);
  });

  it("defaults confidence to 0.5 when missing", () => {
    const result = normalizeInterestPoints(
      [{ frame_us: 1_000, label: "test" }],
      0,
      10_000,
    );
    expect(result[0].confidence).toBe(0.5);
  });

  it("filters entries with invalid types", () => {
    const result = normalizeInterestPoints(
      [
        { frame_us: "not_a_number" as unknown, label: "test", confidence: 0.5 },
        { frame_us: 1_000, label: 42 as unknown, confidence: 0.5 },
      ],
      0,
      10_000,
    );
    expect(result).toHaveLength(0);
  });

  it("filters empty labels", () => {
    const result = normalizeInterestPoints(
      [{ frame_us: 1_000, label: "  ", confidence: 0.5 }],
      0,
      10_000,
    );
    expect(result).toHaveLength(0);
  });
});

// ── Unit Tests: Full Output Normalization ───────────────────────────

describe("VLM Output Normalization", () => {
  it("normalizes a complete response", () => {
    const raw: VlmRawResponse = {
      summary: "  A person walks through a garden.  ",
      tags: ["Outdoor", "Garden", "outdoor"],
      interest_points: [
        { frame_us: 1_000_000, label: "Entry", confidence: 0.9 },
      ],
      quality_flags: ["dark"],
      confidence: { summary: 0.85, tags: 0.78, quality_flags: 0.6 },
    };
    const result = normalizeVlmOutput(raw, 0, 5_000_000);

    expect(result.summary).toBe("A person walks through a garden.");
    expect(result.tags).toEqual(["outdoor", "garden"]);
    expect(result.interest_points).toHaveLength(1);
    expect(result.quality_flags).toEqual(["underexposed"]);
    expect(result.confidence.summary).toBe(0.85);
  });

  it("handles missing fields gracefully", () => {
    const raw: VlmRawResponse = {};
    const result = normalizeVlmOutput(raw, 0, 5_000_000);

    expect(result.summary).toBe("");
    expect(result.tags).toEqual([]);
    expect(result.interest_points).toEqual([]);
    expect(result.quality_flags).toEqual([]);
    expect(result.confidence.summary).toBe(0.5);
  });
});

// ── Unit Tests: JSON Parsing ────────────────────────────────────────

describe("VLM JSON Parsing", () => {
  it("parses clean JSON", () => {
    const result = parseVlmJson('{"summary": "test", "tags": ["a"]}');
    expect(result.summary).toBe("test");
    expect(result.tags).toEqual(["a"]);
  });

  it("strips markdown fences", () => {
    const result = parseVlmJson('```json\n{"summary": "test"}\n```');
    expect(result.summary).toBe("test");
  });

  it("finds JSON in noisy output", () => {
    const result = parseVlmJson('Here is the result: {"summary": "test"} hope that helps');
    expect(result.summary).toBe("test");
  });

  it("throws on non-JSON", () => {
    expect(() => parseVlmJson("no json here")).toThrow();
  });

  it("throws on empty input", () => {
    expect(() => parseVlmJson("")).toThrow();
  });
});

// ── Unit Tests: Prompt Hash ─────────────────────────────────────────

describe("Prompt Hash", () => {
  it("is deterministic", () => {
    const h1 = computePromptHash();
    const h2 = computePromptHash();
    expect(h1).toBe(h2);
  });

  it("is a 16-char hex string", () => {
    const h = computePromptHash();
    expect(h).toMatch(/^[0-9a-f]{16}$/);
  });

  it("changes with schema version", () => {
    const h1 = computePromptHash("2.0.0");
    const h2 = computePromptHash("3.0.0");
    expect(h1).not.toBe(h2);
  });

  it("repair hash is different from main hash", () => {
    const main = computePromptHash();
    const repair = computeRepairPromptHash();
    expect(main).not.toBe(repair);
  });
});

// ── Unit Tests: Skip Conditions ─────────────────────────────────────

describe("VLM Skip Conditions", () => {
  it("skips black_segment", () => {
    expect(shouldSkipVlm(["black_segment"], 5_000_000, 750_000)).toBe(true);
  });

  it("skips segments below minimum duration", () => {
    expect(shouldSkipVlm([], 500_000, 750_000)).toBe(true);
  });

  it("does not skip normal segments", () => {
    expect(shouldSkipVlm(["underexposed"], 5_000_000, 750_000)).toBe(false);
  });
});

// ── Unit Tests: Role Guess ──────────────────────────────────────────

describe("Role Guess", () => {
  it("guesses interview for dialogue-heavy with transcript", () => {
    const segs = [
      { segment_type: "dialogue", transcript_excerpt: "Hello, welcome to the show today", tags: [], summary: "" },
      { segment_type: "dialogue", transcript_excerpt: "Thanks for having me here", tags: [], summary: "" },
      { segment_type: "general", transcript_excerpt: "", tags: [], summary: "" },
    ];
    expect(guessAssetRole(true, segs)).toBe("interview");
  });

  it("guesses b-roll for action without speech", () => {
    const segs = [
      { segment_type: "action", transcript_excerpt: "", tags: [], summary: "" },
      { segment_type: "general", transcript_excerpt: "", tags: [], summary: "" },
    ];
    expect(guessAssetRole(false, segs)).toBe("b-roll");
  });

  it("guesses texture for mostly static without speech", () => {
    const segs = Array.from({ length: 10 }, () => ({
      segment_type: "static",
      transcript_excerpt: "",
      tags: [],
      summary: "",
    }));
    expect(guessAssetRole(false, segs)).toBe("texture");
  });

  it("guesses hybrid for mixed content with transcript", () => {
    const segs = [
      { segment_type: "dialogue", transcript_excerpt: "Some speech content here today", tags: [], summary: "" },
      { segment_type: "action", transcript_excerpt: "", tags: [], summary: "" },
      { segment_type: "general", transcript_excerpt: "", tags: [], summary: "" },
    ];
    expect(guessAssetRole(true, segs)).toBe("hybrid");
  });

  it("returns unknown for empty segments", () => {
    expect(guessAssetRole(false, [])).toBe("unknown");
  });
});

// ── Unit Tests: Build Segment Prompt ────────────────────────────────

describe("Build Segment Prompt", () => {
  it("builds prompt without transcript", () => {
    const prompt = buildSegmentPrompt();
    expect(prompt).toContain("Analyze the following video segment");
    expect(prompt).not.toContain("Transcript context");
  });

  it("includes transcript context when provided", () => {
    const prompt = buildSegmentPrompt("Hello, welcome to the show.");
    expect(prompt).toContain("Transcript context");
    expect(prompt).toContain("Hello, welcome to the show.");
  });
});

// ── Unit Tests: Enrichment with Mock VLM ────────────────────────────

describe("Segment Enrichment", () => {
  it("enriches a segment with successful VLM call", async () => {
    const vlmFn = createMockVlmFn();
    const result = await enrichSegment(
      vlmFn,
      ["frame_1.jpg", "frame_2.jpg"],
      0,
      5_000_000,
      MOCK_VLM_POLICY,
    );

    expect(result.success).toBe(true);
    expect(result.output).toBeDefined();
    expect(result.output!.summary).toContain("garden");
    expect(result.output!.tags).toContain("outdoor_scene");
    expect(result.output!.tags).toContain("walking_person");
    expect(result.prompt_hash).toMatch(/^[0-9a-f]{16}$/);
    expect(result.model_alias).toBe("gemini-2.0-flash");
    expect(result.requested_output_tokens).toBe(
      computeVlmOutputTokenBudget(2, getVlmProviderResponseSchema(), 512),
    );
    expect(result.finish_reason).toBeNull();
    expect(result.attempt_count).toBe(1);
    expect(result.retry_reason).toBeNull();
  });

  it("uses one bounded budget for a truncated response and its single repair", async () => {
    const framePaths = Array.from({ length: 20 }, (_, index) => `/frames/source-${index}.jpg`);
    const calls: Array<{ framePaths: string[]; maxOutputTokens: number }> = [];
    const policy = { ...MOCK_VLM_POLICY, segment_visual_output_tokens_max: 4096 };
    const vlmFn: VlmFn = async (receivedFramePaths, _prompt, options) => {
      calls.push({ framePaths: [...receivedFramePaths], maxOutputTokens: options.maxOutputTokens });
      return {
        rawJson: calls.length === 1
          ? '{"summary":"truncated'
          : JSON.stringify(createM1CanonicalResponse()),
      };
    };

    const result = await enrichSegment(vlmFn, framePaths, 0, 5_000_000, policy);
    const expectedBudget = computeVlmOutputTokenBudget(
      framePaths.length,
      getVlmProviderResponseSchema(),
      policy.segment_visual_output_tokens_max,
    );

    expect(result.success).toBe(true);
    expect(calls).toHaveLength(2);
    expect(calls.map((call) => call.maxOutputTokens)).toEqual([expectedBudget, expectedBudget]);
    expect(calls[1].framePaths).toEqual(calls[0].framePaths);
    expect(result.requested_output_tokens).toBe(expectedBudget);
    expect(result.finish_reason).toBeNull();
    expect(result.attempt_count).toBe(2);
    expect(result.retry_reason).toBe("truncated_json");
  });

  it("repairs missing nested editorial confidence once while preserving the grounded frame set", async () => {
    const calls: Array<{
      framePaths: string[];
      prompt: string;
      responseSchema?: Record<string, unknown>;
    }> = [];
    const validResponse = createM1CanonicalResponse();
    const missingNestedConfidence = {
      ...validResponse,
      editorial_observation: {},
      provider_private: "SECRET-RAW-RESPONSE",
    };
    const vlmFn: VlmFn = async (framePaths, prompt, options) => {
      calls.push({ framePaths: [...framePaths], prompt, responseSchema: options.responseSchema });
      // A provider must not be able to alter the frame identity used by the
      // bounded repair attempt.
      framePaths.length = 0;
      return {
        rawJson: JSON.stringify(calls.length === 1 ? missingNestedConfidence : validResponse),
      };
    };

    const result = await enrichSegment(
      vlmFn,
      ["/frames/source-a.jpg", "/frames/source-b.jpg"],
      0,
      5_000_000,
      MOCK_VLM_POLICY,
    );

    expect(result.success).toBe(true);
    expect(calls).toHaveLength(2);
    expect(calls[1].framePaths).toEqual(calls[0].framePaths);
    expect(calls[1].framePaths).toEqual(["/frames/source-a.jpg", "/frames/source-b.jpg"]);
    expect(calls[0].responseSchema).toEqual(getVlmProviderResponseSchema());
    expect(calls[1].responseSchema).toEqual(getVlmProviderResponseSchema());
    for (const group of M1_CONFIDENCE_GROUPS) {
      expect(calls[1].prompt).toContain(`editorial_observation.confidence.${group}`);
    }
    expect(calls[1].prompt).not.toContain("Analyze the following video segment frames");
    expect(calls[1].prompt).not.toContain("SECRET-RAW-RESPONSE");
    expect(result.output?.editorial_observation?.confidence).toMatchObject({
      tags: 0.9,
      motion: 0.9,
      framing: 0.9,
      direction: 0.9,
      appearance: 0.9,
      text: 0.9,
    });
  });

  it.each([
    [
      "enum",
      "editorial_observation.motion_type",
      (response: VlmRawResponse) => {
        (response.editorial_observation as Record<string, unknown>).motion_type = "sideways";
      },
    ],
    [
      "range",
      "editorial_observation.confidence.tags",
      (response: VlmRawResponse) => {
        ((response.editorial_observation as Record<string, unknown>).confidence as Record<string, unknown>).tags = 1.5;
      },
    ],
    [
      "type",
      "editorial_observation.confidence.tags",
      (response: VlmRawResponse) => {
        ((response.editorial_observation as Record<string, unknown>).confidence as Record<string, unknown>).tags = "high";
      },
    ],
  ] as const)("does not normalize a persistent %s violation into ready output", async (kind, pathValue, mutate) => {
    const invalid = createM1CanonicalResponse();
    mutate(invalid);
    let calls = 0;
    const result = await enrichSegment(
      async () => {
        calls += 1;
        return { rawJson: JSON.stringify(invalid) };
      },
      ["/frames/source.jpg"],
      0,
      5_000_000,
      MOCK_VLM_POLICY,
    );

    expect(calls).toBe(2);
    expect(result.success).toBe(false);
    expect(result.error).toBe("vlm_schema_validation_failed");
    expect(result.output).toBeUndefined();
    expect(result.parse_diagnostics?.at(-1)?.validation_errors).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: pathValue, kind })]),
    );
  });

  it("collapses arbitrary provider throws to a stable non-secret failure", async () => {
    const vlmFn = createFailingVlmFn();
    const result = await enrichSegment(
      vlmFn,
      ["frame_1.jpg"],
      0,
      5_000_000,
      MOCK_VLM_POLICY,
    );

    expect(result.success).toBe(false);
    expect(result.error).toBe("vlm_call_failed");
    expect(result.error).not.toContain("API timeout");
  });

  it("converts cancel/abort errors to a fixed non-secret code without the message body", async () => {
    const vlmFn: VlmFn = async () => {
      const err = new Error("SECRET_ABORT_BODY");
      err.name = "AbortError";
      throw err;
    };
    const result = await enrichSegment(
      vlmFn,
      ["frame_1.jpg"],
      0,
      5_000_000,
      MOCK_VLM_POLICY,
    );

    expect(result.success).toBe(false);
    expect(result.error).toBe("vlm_cancelled");
    expect(result.error).not.toContain("SECRET_ABORT_BODY");
  });

  it("converts timeout errors to a fixed non-secret code without the message body", async () => {
    const vlmFn: VlmFn = async () => {
      const err = new Error("SECRET_TIMEOUT_BODY");
      err.name = "TimeoutError";
      throw err;
    };
    const result = await enrichSegment(
      vlmFn,
      ["frame_1.jpg"],
      0,
      5_000_000,
      MOCK_VLM_POLICY,
    );

    expect(result.success).toBe(false);
    expect(result.error).toBe("vlm_deadline_exceeded");
    expect(result.error).not.toContain("SECRET_TIMEOUT_BODY");
  });

  it("does not let message keywords borrow the deadline/cancel conversion", async () => {
    const vlmFn: VlmFn = async () => {
      throw new Error("deadline SECRET_BODY");
    };
    const result = await enrichSegment(
      vlmFn,
      ["frame_1.jpg"],
      0,
      5_000_000,
      MOCK_VLM_POLICY,
    );

    expect(result.success).toBe(false);
    expect(result.error).toBe("vlm_call_failed");
    expect(result.error).not.toContain("SECRET_BODY");
  });

  it("does not let spoofed guard codes with trailing content pass through", async () => {
    const vlmFn: VlmFn = async () => {
      throw new Error("grounded_vlm_empty_candidate_text:SAFETY SECRET_BODY");
    };
    const result = await enrichSegment(
      vlmFn,
      ["frame_1.jpg"],
      0,
      5_000_000,
      MOCK_VLM_POLICY,
    );

    expect(result.success).toBe(false);
    expect(result.error).toBe("vlm_call_failed");
    expect(result.error).not.toContain("SECRET_BODY");
  });

  it("falls back on non-JSON response after retries", async () => {
    const vlmFn = createBadJsonVlmFn();
    const result = await enrichSegment(
      vlmFn,
      ["frame_1.jpg"],
      0,
      5_000_000,
      MOCK_VLM_POLICY,
    );

    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });

  it("filters interest points outside segment bounds", async () => {
    const vlmFn = createMockVlmFn({
      interest_points: [
        { frame_us: 1_000_000, label: "In bounds", confidence: 0.9 },
        { frame_us: 99_000_000, label: "Way out of bounds", confidence: 0.5 },
      ],
    });
    const result = await enrichSegment(
      vlmFn,
      ["frame_1.jpg"],
      0,
      5_000_000,
      MOCK_VLM_POLICY,
    );

    expect(result.success).toBe(true);
    expect(result.output!.interest_points).toHaveLength(1);
    expect(result.output!.interest_points[0].label).toBe("In bounds");
  });

  // ── Empty / semantically-empty responses must not be successes ─────

  it("rejects an empty {} provider response after the bounded repair attempt", async () => {
    let calls = 0;
    const vlmFn: VlmFn = async () => {
      calls += 1;
      return { rawJson: "{}" };
    };
    const result = await enrichSegment(
      vlmFn,
      ["frame_1.jpg"],
      0,
      5_000_000,
      MOCK_VLM_POLICY,
    );

    expect(result.success).toBe(false);
    expect(result.error).toBe("vlm_semantically_empty_response");
    // Initial call + parse_retry_max(=1) repair — no unbounded retry.
    expect(calls).toBe(2);
  });

  it("recovers when the single bounded repair attempt returns valid content", async () => {
    const payloads = [
      "{}",
      JSON.stringify({
        summary: "A recovered summary.",
        tags: ["recovered"],
        interest_points: [],
        quality_flags: [],
        confidence: { summary: 0.8, tags: 0.8, quality_flags: 0.5 },
      }),
    ];
    let calls = 0;
    const vlmFn: VlmFn = async () => ({
      rawJson: payloads[Math.min(calls++, payloads.length - 1)],
    });
    const result = await enrichSegment(
      vlmFn,
      ["frame_1.jpg"],
      0,
      5_000_000,
      MOCK_VLM_POLICY,
    );

    expect(result.success).toBe(true);
    expect(result.output!.summary).toBe("A recovered summary.");
    expect(calls).toBe(2);
  });

  it("rejects a missing candidate text (empty rawJson) with a stable non-secret error", async () => {
    const vlmFn: VlmFn = async () => ({ rawJson: "" });
    const result = await enrichSegment(
      vlmFn,
      ["frame_1.jpg"],
      0,
      5_000_000,
      MOCK_VLM_POLICY,
    );

    expect(result.success).toBe(false);
    expect(result.error).toBe("vlm_parse_failed");
  });

  it("does not leak raw provider bodies through parse failures", async () => {
    const secretBody = 'SECRET-PROVIDER-PAYLOAD {"partial';
    const vlmFn: VlmFn = async () => ({ rawJson: secretBody });
    const result = await enrichSegment(
      vlmFn,
      ["frame_1.jpg"],
      0,
      5_000_000,
      MOCK_VLM_POLICY,
    );

    expect(result.success).toBe(false);
    expect(result.error).toBe(VLM_TRUNCATED_RESPONSE_ERROR);
    expect(result.error).not.toContain("SECRET-PROVIDER-PAYLOAD");
  });

  it("treats a whitespace-only summary and blank tags as semantically empty", async () => {
    const vlmFn: VlmFn = async () => ({
      rawJson: JSON.stringify({ summary: "   ", tags: ["", "  "] }),
    });
    const result = await enrichSegment(
      vlmFn,
      ["frame_1.jpg"],
      0,
      5_000_000,
      MOCK_VLM_POLICY,
    );

    expect(result.success).toBe(false);
    expect(result.error).toBe("vlm_semantically_empty_response");
  });

  it("treats an observation-only response of unknown placeholders as semantically empty", async () => {
    const vlmFn: VlmFn = async () => ({
      rawJson: JSON.stringify({
        editorial_observation: {
          motion_type: "unknown",
          shot_scale: "not_applicable",
          visual_tags: [],
          confidence: {
            tags: 0.5,
            motion: 0.5,
            framing: 0.5,
            direction: 0.5,
            appearance: 0.5,
            text: 0.5,
          },
        },
      }),
    });
    const result = await enrichSegment(
      vlmFn,
      ["frame_1.jpg"],
      0,
      5_000_000,
      MOCK_VLM_POLICY,
    );

    expect(result.success).toBe(false);
    expect(result.error).toBe("vlm_semantically_empty_response");
  });

  it("treats placeholder-only observation arrays as semantically empty", async () => {
    const vlmFn: VlmFn = async () => ({
      rawJson: JSON.stringify({
        editorial_observation: {
          visual_tags: ["unknown"],
          dominant_colors: ["not_applicable"],
          confidence: {
            tags: 0.5,
            motion: 0.5,
            framing: 0.5,
            direction: 0.5,
            appearance: 0.5,
            text: 0.5,
          },
        },
      }),
    });
    const result = await enrichSegment(
      vlmFn,
      ["frame_1.jpg"],
      0,
      5_000_000,
      MOCK_VLM_POLICY,
    );

    expect(result.success).toBe(false);
    expect(result.error).toBe("vlm_semantically_empty_response");
  });

  it.each([
    [
      "valid-score-only visual_quality",
      { visual_quality: { scores: { composition_score: 0.9 } } },
    ],
    [
      "valid-label-only visual_quality",
      { visual_quality: { labels: { motion_tags: ["handheld"] } } },
    ],
  ])(
    "keeps a minimal valid %s response successful",
    async (_name, payload) => {
      const vlmFn: VlmFn = async () => ({ rawJson: JSON.stringify(payload) });
      const result = await enrichSegment(
        vlmFn,
        ["frame_1.jpg"],
        0,
        5_000_000,
        MOCK_VLM_POLICY,
      );

      expect(result.success).toBe(true);
      expect(result.output!.visual_quality).toBeDefined();
    },
  );

  it("treats a garbage-only visual_quality payload as semantically empty", async () => {
    const vlmFn: VlmFn = async () => ({
      rawJson: JSON.stringify({
        visual_quality: {
          scores: { composition_score: "high" },
          labels: { motion_tags: ["unknown", "not_applicable", ""] },
        },
      }),
    });
    const result = await enrichSegment(
      vlmFn,
      ["frame_1.jpg"],
      0,
      5_000_000,
      MOCK_VLM_POLICY,
    );

    expect(result.success).toBe(false);
    expect(result.error).toBe("vlm_semantically_empty_response");
  });

  it.each([
    [
      "unknown numeric score keys",
      { visual_quality: { scores: { provider_internal_counter: 1 } } },
    ],
    [
      "unknown label keys",
      { visual_quality: { labels: { provider_notes: ["SECRET_LABEL"] } } },
    ],
    [
      "placeholder-only canonical labels after snake-case normalization",
      { visual_quality: { labels: { motion_tags: ["not applicable"] } } },
    ],
  ])(
    "ignores non-canonical or placeholder visual_quality content (%s)",
    async (_name, payload) => {
      const vlmFn: VlmFn = async () => ({
        rawJson: JSON.stringify(payload),
      });
      const result = await enrichSegment(
        vlmFn,
        ["frame_1.jpg"],
        0,
        5_000_000,
        MOCK_VLM_POLICY,
      );

      expect(result.success).toBe(false);
      expect(result.error).toBe("vlm_semantically_empty_response");
      expect(JSON.stringify(result)).not.toContain("SECRET_LABEL");
    },
  );

  it("treats out-of-range canonical scores as non-semantic", async () => {
    const vlmFn: VlmFn = async () => ({
      rawJson: JSON.stringify({
        visual_quality: { scores: { composition_score: 42 } },
      }),
    });
    const result = await enrichSegment(
      vlmFn,
      ["frame_1.jpg"],
      0,
      5_000_000,
      MOCK_VLM_POLICY,
    );

    expect(result.success).toBe(false);
    expect(result.error).toBe("vlm_semantically_empty_response");
  });

  it.each([
    ["summary-only", { summary: "A person walks a dog." }],
    ["tags-only", { tags: ["outdoor_scene"] }],
    ["quality-flags-only", { quality_flags: ["blurry"] }],
    [
      "meaningful-observation-only",
      {
        editorial_observation: {
          motion_type: "continuous",
          confidence: {
            tags: 0.8,
            motion: 0.8,
            framing: 0.8,
            direction: 0.8,
            appearance: 0.8,
            text: 0.8,
          },
        },
      },
    ],
  ])("keeps a minimal valid %s response successful", async (_name, payload) => {
    const vlmFn: VlmFn = async () => ({ rawJson: JSON.stringify(payload) });
    const result = await enrichSegment(
      vlmFn,
      ["frame_1.jpg"],
      0,
      5_000_000,
      MOCK_VLM_POLICY,
    );

    expect(result.success).toBe(true);
    expect(result.output).toBeDefined();
  });
});

// ── Unit Tests: Request Hash ────────────────────────────────────────

describe("VLM Request Hash", () => {
  it("is deterministic", () => {
    const params = {
      segment_id: "SEG_001",
      model_snapshot: "snap-1",
      prompt_hash: "abc123",
      frame_count: 10,
    };
    expect(computeVlmRequestHash(params)).toBe(computeVlmRequestHash(params));
  });

  it("changes with different params", () => {
    const h1 = computeVlmRequestHash({
      segment_id: "SEG_001",
      model_snapshot: "snap-1",
      prompt_hash: "abc123",
      frame_count: 10,
    });
    const h2 = computeVlmRequestHash({
      segment_id: "SEG_002",
      model_snapshot: "snap-1",
      prompt_hash: "abc123",
      frame_count: 10,
    });
    expect(h1).not.toBe(h2);
  });

  it("binds the requested output budget when present", () => {
    const base = {
      segment_id: "SEG_001",
      model_snapshot: "snap-1",
      prompt_hash: "abc123",
      frame_count: 10,
    };
    expect(computeVlmRequestHash({ ...base, requested_output_tokens: 512 }))
      .not.toBe(computeVlmRequestHash({ ...base, requested_output_tokens: 1024 }));
  });
});

// ── Constants ───────────────────────────────────────────────────────

describe("Constants", () => {
  it("has connector version", () => {
    expect(VLM_CONNECTOR_VERSION).toBe("gemini-vlm-v3.3.0");
  });

  it("has prompt template ID", () => {
    expect(PROMPT_TEMPLATE_ID).toBe("m2-segment-grounded-v3");
  });
});

describe("Gemini live connector grounding guard", () => {
  it("rejects zero-image and non-absolute image requests before provider access", async () => {
    const connector = createGeminiVlmFn();
    const options = { model: "test", maxOutputTokens: 1 };

    await expect(connector([], "prompt", options)).rejects.toThrow(
      "grounded_vlm_requires_at_least_one_image",
    );
    await expect(connector(["relative-frame.jpg"], "prompt", options)).rejects.toThrow(
      "grounded_vlm_invalid_image_paths",
    );
  });
});

// ── Unit Tests: Live connector empty-candidate / error hygiene ──────

describe("Gemini live connector response handling", () => {
  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.GEMINI_API_KEY;
  const testFrame = path.resolve(import.meta.dirname, "fixtures/media/test-clip-5s.mp4");

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalApiKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = originalApiKey;
  });

  function stubFetchOnce(payload: unknown, ok = true, status = 200): void {
    process.env.GEMINI_API_KEY = "test-key";
    globalThis.fetch = (async () =>
      new Response(JSON.stringify(payload), {
        status,
        headers: { "Content-Type": "application/json" },
      })) as typeof fetch;
  }

  it("throws a stable non-secret error when candidate text is missing", async () => {
    stubFetchOnce({ candidates: [{ finishReason: "SAFETY" }] });
    const connector = createGeminiVlmFn();

    await expect(connector([testFrame], "prompt", { model: "m", maxOutputTokens: 1 }))
      .rejects.toThrow("grounded_vlm_empty_candidate_text:SAFETY");
  });

  it("omits unknown finishReason values from the empty-candidate error", async () => {
    stubFetchOnce({ candidates: [{ finishReason: "SECRET_FINISH_REASON" }] });
    const connector = createGeminiVlmFn();

    await expect(connector([testFrame], "prompt", { model: "m", maxOutputTokens: 1 }))
      .rejects.toThrow(/^grounded_vlm_empty_candidate_text$/);
  });

  it.each([
    ["MAX_TOKENS", "{\"summary\":\"complete\"}"],
    ["STOP", "{\"summary\":\"partial\""],
  ] as const)("classifies %s or EOF-equivalent candidate output as truncation", async (finishReason, text) => {
    stubFetchOnce({
      candidates: [{ finishReason, content: { parts: [{ text }] } }],
    });
    const connector = createGeminiVlmFn();

    await expect(connector([testFrame], "prompt", { model: "m", maxOutputTokens: 1 }))
      .rejects.toThrow(VLM_TRUNCATED_RESPONSE_ERROR);
  });

  it("does not include the raw provider error body in HTTP failure messages", async () => {
    stubFetchOnce({ error: "SECRET-PROVIDER-ERROR-BODY" }, false, 500);
    const connector = createGeminiVlmFn();

    await expect(connector([testFrame], "prompt", { model: "m", maxOutputTokens: 1 }))
      .rejects.toThrow(/Gemini API error 500/);
    await expect(connector([testFrame], "prompt", { model: "m", maxOutputTokens: 1 }))
      .rejects.not.toThrow(/SECRET-PROVIDER-ERROR-BODY/);
  });

  it("uses the canonical response schema for structured output and the same validator for text fallback", async () => {
    const canonical = createM1CanonicalResponse();
    const frame = path.resolve(import.meta.dirname, "fixtures/media/test-clip-5s.mp4");
    const schema = getVlmProviderResponseSchema();
    let requestSchema: Record<string, unknown> | undefined;
    process.env.GEMINI_API_KEY = "test-key";
    globalThis.fetch = (async (_input, init) => {
      const request = JSON.parse(String(init?.body)) as {
        generationConfig: { responseSchema: Record<string, unknown> };
      };
      requestSchema = request.generationConfig.responseSchema;
      return new Response(JSON.stringify({
        candidates: [{ content: { parts: [{ text: JSON.stringify(canonical) }] } }],
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    const structured = await enrichSegment(
      createGeminiVlmFn(),
      [frame],
      0,
      5_000_000,
      MOCK_VLM_POLICY,
    );
    const textFallback = await enrichSegment(
      async () => ({ rawJson: JSON.stringify(canonical) }),
      ["/frames/text-fallback.jpg"],
      0,
      5_000_000,
      MOCK_VLM_POLICY,
    );

    const confidenceSchema = ((schema.properties as Record<string, unknown>)
      .editorial_observation as Record<string, unknown>);
    const nestedConfidence = (confidenceSchema.properties as Record<string, unknown>)
      .confidence as Record<string, unknown>;
    expect(nestedConfidence.required).toEqual(M1_CONFIDENCE_GROUPS);
    expect(requestSchema).toEqual(schema);
    expect(validateVlmGroundingResponse(canonical)).toEqual({ valid: true, errors: [] });
    expect(structured.success).toBe(true);
    expect(textFallback.success).toBe(true);
    expect(structured.output).toEqual(textFallback.output);
  });
});

// ── Integration: Mock VLM → Pipeline → Schema Validate ─────────────

const FIXTURES_DIR = path.join(import.meta.dirname, "fixtures/media");
const TEST_CLIP = path.join(FIXTURES_DIR, "test-clip-5s.mp4");
const TMP_VLM_PROJECT = path.join(import.meta.dirname, "_tmp_vlm_pipeline");

describe("Pipeline: VLM enrichment integration", () => {
  let result: PipelineResult;

  beforeAll(async () => {
    fs.mkdirSync(TMP_VLM_PROJECT, { recursive: true });

    const mockVlmFn = createMockVlmFn();

    result = await runPipeline({
      sourceFiles: [TEST_CLIP],
      projectDir: TMP_VLM_PROJECT,
      repoRoot: REPO_ROOT,
      skipStt: true,
      vlmFn: mockVlmFn,
      skipAppraiser: true,
    });
  }, 60_000);

  afterAll(() => {
    fs.rmSync(TMP_VLM_PROJECT, { recursive: true, force: true });
  });

  it("produces segments.json that passes schema validation", () => {
    const validate = createSegmentsValidator();
    const valid = validate(result.segmentsJson);
    if (!valid) {
      console.error("segments.json validation errors:", validate.errors);
    }
    expect(valid).toBe(true);
  });

  it("segments have VLM-enriched summary", () => {
    // At least one non-skipped segment should have VLM summary
    const enriched = result.segmentsJson.items.filter(
      (s) => s.summary.length > 0 && s.summary !== "",
    );
    expect(enriched.length).toBeGreaterThanOrEqual(1);
  });

  it("segments have VLM-enriched tags", () => {
    const enriched = result.segmentsJson.items.filter(
      (s) => s.tags.length > 0,
    );
    expect(enriched.length).toBeGreaterThanOrEqual(1);
    // Tags should be normalized (lower_snake_case)
    for (const seg of enriched) {
      for (const tag of seg.tags) {
        expect(tag).toMatch(/^[a-z0-9_]+$/);
      }
    }
  });

  it("segments have interest_points within bounds", () => {
    for (const seg of result.segmentsJson.items) {
      if (seg.interest_points && seg.interest_points.length > 0) {
        for (const pt of seg.interest_points) {
          expect(pt.frame_us).toBeGreaterThanOrEqual(seg.src_in_us);
          expect(pt.frame_us).toBeLessThanOrEqual(seg.src_out_us);
          expect(pt.confidence).toBeGreaterThanOrEqual(0);
          expect(pt.confidence).toBeLessThanOrEqual(1);
        }
      }
    }
  });

  it("enriched segments have VLM confidence records", () => {
    const enriched = result.segmentsJson.items.filter(
      (s) => (s.confidence as Record<string, unknown>).summary !== undefined,
    );
    expect(enriched.length).toBeGreaterThanOrEqual(1);
    for (const seg of enriched) {
      const conf = seg.confidence as Record<string, { score: number; source: string; status: string }>;
      expect(conf.summary.score).toBeGreaterThanOrEqual(0);
      expect(conf.summary.score).toBeLessThanOrEqual(1);
      expect(conf.summary.source).toBe("gemini-2.5-flash-lite");
      expect(conf.summary.status).toBe("ready");
    }
  });

  it("enriched segments have VLM provenance records", () => {
    const enriched = result.segmentsJson.items.filter(
      (s) => (s.provenance as Record<string, unknown>).summary !== undefined,
    );
    expect(enriched.length).toBeGreaterThanOrEqual(1);
    for (const seg of enriched) {
      const prov = seg.provenance as Record<string, Record<string, unknown>>;
      expect(prov.summary.stage).toBe("vlm");
      expect(prov.summary.method).toBe("gemini_frame_bundle");
      expect(prov.summary.connector_version).toBe(VLM_CONNECTOR_VERSION);
      expect(prov.summary.prompt_hash).toMatch(/^[0-9a-f]{16}$/);
      expect(prov.summary.model_alias).toBe("gemini-2.5-flash-lite");
      expect(prov.summary.frame_count).toBeGreaterThan(0);
      expect(prov.summary.sample_timestamps_us).toHaveLength(
        prov.summary.frame_count as number,
      );
      expect(prov.summary.frame_cache_version).toBe("grounded-frame-cache-v2");
      expect(prov.summary.frame_producer_version).toBe("ffmpeg-single-frame-v2");
      expect(prov.summary.source_content_sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(prov.summary.cache_identity).toMatch(/^[0-9a-f]{64}$/);
      expect(prov.summary.requested_output_tokens).toEqual(expect.any(Number));
      expect(prov.summary.requested_output_tokens as number).toBeGreaterThan(0);
      expect(prov.summary.requested_output_tokens as number).toBeLessThanOrEqual(1024);
      expect(prov.summary.finish_reason).toBeNull();
      expect(prov.summary.attempt_count).toBe(1);
      expect(prov.summary.retry_reason).toBeNull();
    }
  });

  it("asset has role_guess after VLM enrichment", () => {
    const asset = result.assetsJson.items[0];
    expect(asset.role_guess).toBeDefined();
    expect(["interview", "b-roll", "texture", "hybrid", "unknown"]).toContain(
      asset.role_guess,
    );
  });

  it("gap report has no VLM errors for successful enrichment", () => {
    const vlmGaps = result.gapReport.entries.filter((e) => e.stage === "vlm");
    expect(vlmGaps).toHaveLength(0);
  });
});

// ── Integration: empty VLM responses → gap + re-call on next run ────

describe("Pipeline: semantically empty VLM response stays a gap", () => {
  const tmpDir = path.join(import.meta.dirname, "_tmp_vlm_empty");
  let firstRunCalls = 0;
  let secondRunCalls = 0;
  let first: PipelineResult;
  let second: PipelineResult;

  beforeAll(async () => {
    fs.mkdirSync(tmpDir, { recursive: true });
    const emptyVlmFn = (counter: { value: number }): VlmFn => async () => {
      counter.value += 1;
      return { rawJson: "{}" };
    };
    const firstCounter = { value: 0 };
    first = await runPipeline({
      sourceFiles: [TEST_CLIP],
      projectDir: tmpDir,
      repoRoot: REPO_ROOT,
      skipStt: true,
      vlmFn: emptyVlmFn(firstCounter),
      skipAppraiser: true,
    });
    firstRunCalls = firstCounter.value;

    const secondCounter = { value: 0 };
    second = await runPipeline({
      sourceFiles: [TEST_CLIP],
      projectDir: tmpDir,
      repoRoot: REPO_ROOT,
      skipStt: true,
      vlmFn: emptyVlmFn(secondCounter),
      skipAppraiser: true,
    });
    secondRunCalls = secondCounter.value;

    // Cleanup scheduled
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }, 120_000);

  it("first run records at least one VLM gap for the empty response", () => {
    expect(firstRunCalls).toBeGreaterThanOrEqual(1);
    const vlmGaps = first.gapReport.entries.filter((e) => e.stage === "vlm");
    expect(vlmGaps.length).toBeGreaterThanOrEqual(1);
    for (const gap of vlmGaps) {
      expect(gap.issue).toContain("vlm_semantically_empty_response");
      expect(gap.severity).toBe("warning");
    }
  });

  it("first run attaches no ready VLM provenance or confidence to segments", () => {
    for (const seg of first.segmentsJson.items) {
      const prov = seg.provenance as Record<string, Record<string, unknown> | undefined>;
      expect(prov.summary?.stage).not.toBe("vlm");
      expect(prov.tags?.stage).not.toBe("vlm");
      const confidence = seg.confidence as Record<string, { status?: string } | undefined>;
      expect(confidence.tags?.status).not.toBe("ready");
      expect(confidence.summary?.status).not.toBe("ready");
    }
  });

  it("second run does not reuse the failed segment as cache and re-calls the provider", () => {
    expect(secondRunCalls).toBeGreaterThanOrEqual(1);
    const vlmGaps = second.gapReport.entries.filter((e) => e.stage === "vlm");
    expect(vlmGaps.length).toBeGreaterThanOrEqual(1);
  });
});


// ── Integration: VLM failure → gap report ───────────────────────────

describe("Pipeline: VLM failure produces gap entries", () => {
  let result: PipelineResult;

  beforeAll(async () => {
    const tmpDir = path.join(import.meta.dirname, "_tmp_vlm_fail");
    fs.mkdirSync(tmpDir, { recursive: true });

    const failingVlmFn = createFailingVlmFn();

    result = await runPipeline({
      sourceFiles: [TEST_CLIP],
      projectDir: tmpDir,
      repoRoot: REPO_ROOT,
      skipStt: true,
      vlmFn: failingVlmFn,
      skipAppraiser: true,
    });

    // Cleanup scheduled
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }, 60_000);

  it("still produces valid segments.json", () => {
    const validate = createSegmentsValidator();
    expect(validate(result.segmentsJson)).toBe(true);
  });

  it("gap report contains VLM failure entries", () => {
    const vlmGaps = result.gapReport.entries.filter((e) => e.stage === "vlm");
    expect(vlmGaps.length).toBeGreaterThanOrEqual(1);
    for (const gap of vlmGaps) {
      expect(gap.issue).toContain("vlm_failed");
      expect(gap.severity).toBe("warning");
    }
  });

  it("segments retain pre-VLM values on failure", () => {
    // Segments should still have their original ffmpeg-derived data
    for (const seg of result.segmentsJson.items) {
      expect(seg.segment_id).toBeTruthy();
      expect(seg.src_in_us).toBeDefined();
      expect(seg.src_out_us).toBeDefined();
      expect(seg.confidence.boundary).toBeDefined();
    }
  });
});

// ── Integration: skipVlm flag ───────────────────────────────────────

describe("Pipeline: skipVlm flag", () => {
  it("does not run VLM when skipVlm is true", async () => {
    const tmpDir = path.join(import.meta.dirname, "_tmp_vlm_skip");
    fs.mkdirSync(tmpDir, { recursive: true });

    let vlmCalled = false;
    const spyVlmFn: VlmFn = async () => {
      vlmCalled = true;
      return { rawJson: '{"summary":"should not appear"}' };
    };

    try {
      await runPipeline({
        sourceFiles: [TEST_CLIP],
        projectDir: tmpDir,
        repoRoot: REPO_ROOT,
        skipStt: true,
        skipVlm: true,
        vlmFn: spyVlmFn,
        skipAppraiser: true,
      });

      expect(vlmCalled).toBe(false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }, 60_000);
});

function writeLegacyTextOnlyVlmCache(projectDir: string): void {
  const segmentsPath = path.join(projectDir, "03_analysis", "segments.json");
  const segments = JSON.parse(fs.readFileSync(segmentsPath, "utf-8")) as {
    items: Array<Record<string, unknown>>;
  };
  for (const segment of segments.items) {
    const legacyProvenance = {
      stage: "vlm",
      method: "gemini_frame_bundle",
      connector_version: "gemini-vlm-v2.0.0",
      policy_hash: "legacy-policy",
      request_hash: "legacy-text-only-request",
      model_alias: "gemini-2.0-flash",
      model_snapshot: "legacy-text-only",
      prompt_template_id: "m2-segment-v2",
      prompt_hash: "legacy-text-only",
      response_format: "json_schema_v1",
    };
    segment.summary = "Legacy text-only visual summary";
    segment.tags = ["legacy_visual_tag"];
    segment.quality_flags = ["blurry"];
    segment.interest_points = [{
      frame_us: 1_000_000,
      label: "legacy text-only point",
      confidence: 0.9,
    }];
    segment.confidence = {
      ...(segment.confidence as Record<string, unknown>),
      summary: { score: 0.9, source: "gemini-2.0-flash", status: "ready" },
      tags: { score: 0.9, source: "gemini-2.0-flash", status: "ready" },
      quality_flags: { score: 0.9, source: "gemini-2.0-flash", status: "ready" },
    };
    segment.provenance = {
      ...(segment.provenance as Record<string, unknown>),
      summary: legacyProvenance,
      tags: legacyProvenance,
      quality_flags: legacyProvenance,
    };
  }
  fs.writeFileSync(segmentsPath, JSON.stringify(segments, null, 2));
}

function writePeakCache(
  projectDir: string,
  sourcePass: "precision_dense_frames" | "degraded_ffmpeg_signals" | "marlin_temporal_semantics",
): string {
  const segmentsPath = path.join(projectDir, "03_analysis", "segments.json");
  const segments = JSON.parse(fs.readFileSync(segmentsPath, "utf-8")) as {
    items: Array<Record<string, unknown>>;
  };
  const segment = segments.items[0];
  const segmentId = segment.segment_id as string;
  segment.peak_analysis = {
    peak_moments: [{
      peak_ref: `PK_${segmentId}`,
      timestamp_us: 2_500_000,
      type: "action_peak",
      confidence: 0.9,
      description: "cached peak",
      source_pass: sourcePass,
    }],
    visual_energy_curve: [],
    provenance: {
      coarse_prompt_template_id: sourcePass === "marlin_temporal_semantics" ? "marlin" : "legacy",
      refine_prompt_template_id: sourcePass === "marlin_temporal_semantics" ? "marlin" : "legacy",
      precision_mode: sourcePass === "precision_dense_frames" ? "always" : "never",
      fusion_version: "legacy",
      support_signal_version: "legacy",
    },
  };
  fs.writeFileSync(segmentsPath, JSON.stringify(segments, null, 2));
  return segmentId;
}

async function seedSourceAnalysisCache(projectDir: string, sourceFile: string): Promise<void> {
  await runPipeline({
    sourceFiles: [sourceFile],
    projectDir,
    repoRoot: REPO_ROOT,
    skipStt: true,
    skipVlm: true,
    skipPeak: true,
    skipAppraiser: true,
    skipMediaLink: true,
    skipBgmAnalysis: true,
  });
}

describe("Pipeline: all-cached VLM grounding compatibility", () => {
  it("re-analyzes legacy text-only VLM cache with real frames", async () => {
    const tmpDir = path.join(import.meta.dirname, "_tmp_vlm_cached_legacy");
    fs.mkdirSync(tmpDir, { recursive: true });

    try {
      await seedSourceAnalysisCache(tmpDir, TEST_CLIP);
      writeLegacyTextOnlyVlmCache(tmpDir);
      const received: string[][] = [];

      const result = await runPipeline({
        sourceFiles: [TEST_CLIP],
        projectDir: tmpDir,
        repoRoot: REPO_ROOT,
        skipStt: true,
        skipPeak: true,
        skipAppraiser: true,
        skipMediaLink: true,
        skipBgmAnalysis: true,
        vlmFn: async (framePaths) => {
          received.push(framePaths);
          return {
            rawJson: JSON.stringify({
              summary: "Grounded replacement summary",
              tags: ["grounded_replacement"],
              interest_points: [],
              quality_flags: [],
              confidence: { summary: 0.9, tags: 0.9, quality_flags: 0.9 },
            }),
          };
        },
      });

      expect(received.length).toBeGreaterThan(0);
      for (const framePath of received.flat()) {
        expect(path.isAbsolute(framePath)).toBe(true);
        expect(fs.statSync(framePath).size).toBeGreaterThan(0);
      }
      const segment = result.segmentsJson.items[0];
      expect(segment.summary).toBe("Grounded replacement summary");
      expect(segment.tags).toContain("grounded_replacement");
      expect(segment.tags).not.toContain("legacy_visual_tag");
      const provenance = segment.provenance.summary as Record<string, unknown>;
      expect(provenance.connector_version).toBe(VLM_CONNECTOR_VERSION);
      expect(provenance.frame_count).toBe(received[0].length);
      expect(provenance.sample_timestamps_us).toHaveLength(received[0].length);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }, 120_000);

  it("drops legacy visual success and preserves a gap when cached-source frame extraction fails", async () => {
    const tmpDir = path.join(import.meta.dirname, "_tmp_vlm_cached_extract_fail");
    const sourceCopy = path.join(tmpDir, "source.mp4");
    fs.mkdirSync(tmpDir, { recursive: true });
    fs.copyFileSync(TEST_CLIP, sourceCopy);

    try {
      await seedSourceAnalysisCache(tmpDir, sourceCopy);
      writeLegacyTextOnlyVlmCache(tmpDir);
      const legacyPeakSegmentId = writePeakCache(tmpDir, "precision_dense_frames");
      let vlmCalls = 0;
      let removedSource = false;

      const result = await runPipeline({
        sourceFiles: [sourceCopy],
        projectDir: tmpDir,
        repoRoot: REPO_ROOT,
        skipStt: true,
        skipPeak: true,
        skipAppraiser: true,
        skipMediaLink: true,
        skipBgmAnalysis: true,
        vlmProgressReporter: {
          onAssetProgress(event) {
            if (event.status === "analyzing" && !removedSource) {
              fs.rmSync(sourceCopy, { force: true });
              removedSource = true;
            }
          },
        },
        vlmFn: async () => {
          vlmCalls += 1;
          return { rawJson: "{}" };
        },
      });

      expect(removedSource).toBe(true);
      expect(vlmCalls).toBe(0);
      const segment = result.segmentsJson.items[0];
      expect(segment.summary).toBe("");
      expect(segment.tags).not.toContain("legacy_visual_tag");
      expect(segment.interest_points).toEqual([]);
      expect(segment.provenance.summary).toBeUndefined();
      const vlmGaps = result.gapReport.entries.filter((entry) => entry.stage === "vlm");
      expect(vlmGaps.length).toBeGreaterThan(0);
      expect(vlmGaps[0].issue).toContain("vlm_frame_extraction_failed");
      expect(result.gapReport.entries.some((entry) =>
        entry.stage === "peak_detection" && entry.segment_id === legacyPeakSegmentId
      )).toBe(true);
      const persistedGap = fs.readFileSync(
        path.join(tmpDir, "03_analysis", "gap_report.yaml"),
        "utf-8",
      );
      expect(persistedGap).toContain("vlm_frame_extraction_failed");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }, 120_000);

  it("keeps compatible grounded VLM cache without another live call", async () => {
    const tmpDir = path.join(import.meta.dirname, "_tmp_vlm_cached_grounded");
    fs.mkdirSync(tmpDir, { recursive: true });
    let firstRunCalls = 0;
    const groundedVlm: VlmFn = async () => {
      firstRunCalls += 1;
      return {
        rawJson: JSON.stringify({
          summary: "Compatible grounded summary",
          tags: ["compatible_grounded"],
          interest_points: [],
          quality_flags: [],
          confidence: { summary: 0.9, tags: 0.9, quality_flags: 0.9 },
        }),
      };
    };

    try {
      await runPipeline({
        sourceFiles: [TEST_CLIP],
        projectDir: tmpDir,
        repoRoot: REPO_ROOT,
        skipStt: true,
        skipPeak: true,
        skipAppraiser: true,
        skipMediaLink: true,
        skipBgmAnalysis: true,
        vlmFn: groundedVlm,
      });
      expect(firstRunCalls).toBeGreaterThan(0);

      let cachedRunCalls = 0;
      const result = await runPipeline({
        sourceFiles: [TEST_CLIP],
        projectDir: tmpDir,
        repoRoot: REPO_ROOT,
        skipStt: true,
        skipPeak: true,
        skipAppraiser: true,
        skipMediaLink: true,
        skipBgmAnalysis: true,
        vlmFn: async () => {
          cachedRunCalls += 1;
          return { rawJson: "{}" };
        },
      });

      expect(cachedRunCalls).toBe(0);
      expect(result.segmentsJson.items[0].summary).toBe("Compatible grounded summary");
      expect(result.vlmSummary?.cachedAssets).toBe(1);
      expect(result.gapReport.entries.filter((entry) => entry.stage === "vlm")).toHaveLength(0);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }, 120_000);

  it("invalidates grounded VLM cache when the cached segment range changes", async () => {
    const tmpDir = path.join(import.meta.dirname, "_tmp_vlm_cached_range");
    fs.mkdirSync(tmpDir, { recursive: true });
    try {
      await runPipeline({
        sourceFiles: [TEST_CLIP], projectDir: tmpDir, repoRoot: REPO_ROOT,
        skipStt: true, skipPeak: true, skipAppraiser: true, skipMediaLink: true,
        skipBgmAnalysis: true, vlmFn: createMockVlmFn(),
      });
      const segmentsPath = path.join(tmpDir, "03_analysis", "segments.json");
      const segments = JSON.parse(fs.readFileSync(segmentsPath, "utf-8")) as {
        items: Array<Record<string, unknown>>;
      };
      segments.items[0].src_out_us = (segments.items[0].src_out_us as number) - 500_000;
      segments.items[0].duration_us = (segments.items[0].duration_us as number) - 500_000;
      fs.writeFileSync(segmentsPath, JSON.stringify(segments, null, 2));
      let calls = 0;
      const result = await runPipeline({
        sourceFiles: [TEST_CLIP], projectDir: tmpDir, repoRoot: REPO_ROOT,
        skipStt: true, skipPeak: true, skipAppraiser: true, skipMediaLink: true,
        skipBgmAnalysis: true,
        vlmFn: async (...args) => {
          calls += 1;
          return createMockVlmFn()(...args);
        },
      });
      expect(calls).toBeGreaterThan(0);
      const provenance = result.segmentsJson.items[0].provenance.summary as Record<string, unknown>;
      expect(provenance.segment_src_out_us).toBe(result.segmentsJson.items[0].src_out_us);
      expect(provenance.cache_decision_reasons).toContain("segment_range_mismatch");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }, 120_000);

  it("invalidates frame and VLM caches when source bytes change beyond the legacy prefix", async () => {
    const tmpDir = path.join(import.meta.dirname, "_tmp_vlm_full_source_hash");
    const sourcePath = path.join(tmpDir, "padded-source.mp4");
    fs.mkdirSync(tmpDir, { recursive: true });
    fs.copyFileSync(TEST_CLIP, sourcePath);
    const targetSize = 18 * 1024 * 1024;
    fs.appendFileSync(sourcePath, Buffer.alloc(targetSize - fs.statSync(sourcePath).size));
    try {
      let firstCalls = 0;
      const first = await runPipeline({
        sourceFiles: [sourcePath], projectDir: tmpDir, repoRoot: REPO_ROOT,
        skipStt: true, skipPeak: true, skipAppraiser: true, skipMediaLink: true,
        skipBgmAnalysis: true,
        vlmFn: async (...args) => {
          firstCalls += 1;
          return createMockVlmFn()(...args);
        },
      });
      expect(firstCalls).toBeGreaterThan(0);
      const firstAssetId = first.assetsJson.items[0].asset_id;
      const firstHash = (first.segmentsJson.items[0].provenance.summary as Record<string, unknown>)
        .source_content_sha256;

      let cachedCalls = 0;
      await runPipeline({
        sourceFiles: [sourcePath], projectDir: tmpDir, repoRoot: REPO_ROOT,
        skipStt: true, skipPeak: true, skipAppraiser: true, skipMediaLink: true,
        skipBgmAnalysis: true,
        vlmFn: async (...args) => {
          cachedCalls += 1;
          return createMockVlmFn()(...args);
        },
      });
      expect(cachedCalls).toBe(0);

      const originalStat = fs.statSync(sourcePath);
      const fd = fs.openSync(sourcePath, "r+");
      try {
        fs.writeSync(fd, Buffer.from([0x55]), 0, 1, 17 * 1024 * 1024);
      } finally {
        fs.closeSync(fd);
      }
      fs.utimesSync(sourcePath, originalStat.atime, originalStat.mtime);

      let changedCalls = 0;
      const changed = await runPipeline({
        sourceFiles: [sourcePath], projectDir: tmpDir, repoRoot: REPO_ROOT,
        skipStt: true, skipPeak: true, skipAppraiser: true, skipMediaLink: true,
        skipBgmAnalysis: true,
        vlmFn: async (...args) => {
          changedCalls += 1;
          return createMockVlmFn()(...args);
        },
      });
      expect(changed.assetsJson.items[0].asset_id).toBe(firstAssetId);
      expect(changedCalls).toBeGreaterThan(0);
      expect((changed.segmentsJson.items[0].provenance.summary as Record<string, unknown>)
        .source_content_sha256).not.toBe(firstHash);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }, 120_000);
});

describe("Pipeline: cached peak compatibility", () => {
  it("fails loudly when a canonical cached artifact is corrupt", async () => {
    const tmpDir = path.join(import.meta.dirname, "_tmp_cached_canonical_corrupt");
    fs.mkdirSync(tmpDir, { recursive: true });
    try {
      await seedSourceAnalysisCache(tmpDir, TEST_CLIP);
      fs.writeFileSync(path.join(tmpDir, "03_analysis", "segments.json"), "{not-json");
      await expect(runPipeline({
        sourceFiles: [TEST_CLIP], projectDir: tmpDir, repoRoot: REPO_ROOT,
        skipStt: true, skipVlm: true, skipPeak: true, skipAppraiser: true,
        skipMediaLink: true, skipBgmAnalysis: true,
      })).rejects.toThrow("canonical_artifact_corrupt");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }, 120_000);

  it("removes old precision success without grounded provenance and keeps a peak gap", async () => {
    const tmpDir = path.join(import.meta.dirname, "_tmp_peak_cached_legacy");
    fs.mkdirSync(tmpDir, { recursive: true });
    try {
      await seedSourceAnalysisCache(tmpDir, TEST_CLIP);
      const segmentId = writePeakCache(tmpDir, "precision_dense_frames");
      const result = await runPipeline({
        sourceFiles: [TEST_CLIP], projectDir: tmpDir, repoRoot: REPO_ROOT,
        skipStt: true, skipVlm: true, skipPeak: true, skipAppraiser: true,
        skipMediaLink: true, skipBgmAnalysis: true,
      });
      expect(result.segmentsJson.items.find((segment) => segment.segment_id === segmentId)?.peak_analysis)
        .toBeUndefined();
      expect(result.gapReport.entries.some((entry) =>
        entry.stage === "peak_detection" &&
        entry.segment_id === segmentId &&
        entry.issue.includes("ungrounded_precision_cache_invalidated")
      )).toBe(true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }, 120_000);

  it.each(["degraded_ffmpeg_signals", "marlin_temporal_semantics"] as const)(
    "keeps non-precision %s peak cache valid",
    async (sourcePass) => {
      const tmpDir = path.join(import.meta.dirname, `_tmp_peak_cached_${sourcePass}`);
      fs.mkdirSync(tmpDir, { recursive: true });
      try {
        await seedSourceAnalysisCache(tmpDir, TEST_CLIP);
        const segmentId = writePeakCache(tmpDir, sourcePass);
        const result = await runPipeline({
          sourceFiles: [TEST_CLIP], projectDir: tmpDir, repoRoot: REPO_ROOT,
          skipStt: true, skipVlm: true, skipPeak: true, skipAppraiser: true,
          skipMediaLink: true, skipBgmAnalysis: true,
        });
        expect(result.segmentsJson.items.find((segment) => segment.segment_id === segmentId)
          ?.peak_analysis?.peak_moments[0].source_pass).toBe(sourcePass);
        expect(result.gapReport.entries.filter((entry) => entry.stage === "peak_detection"))
          .toHaveLength(0);
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    },
    120_000,
  );

  it("revalidates cached VLM and peak fields on a mixed partial cache hit", async () => {
    const tmpDir = path.join(import.meta.dirname, "_tmp_mixed_visual_cache");
    const secondClip = path.join(FIXTURES_DIR, "test-scene-changes.mp4");
    fs.mkdirSync(tmpDir, { recursive: true });
    try {
      await seedSourceAnalysisCache(tmpDir, TEST_CLIP);
      writeLegacyTextOnlyVlmCache(tmpDir);
      const cachedSegmentId = writePeakCache(tmpDir, "precision_dense_frames");
      const received: string[][] = [];
      const result = await runPipeline({
        sourceFiles: [TEST_CLIP, secondClip], projectDir: tmpDir, repoRoot: REPO_ROOT,
        skipStt: true, skipAppraiser: true, skipMediaLink: true, skipBgmAnalysis: true,
        vlmFn: async (framePaths, prompt) => {
          received.push(framePaths);
          if (prompt.includes("editorial peak discovery")) {
            return { rawJson: JSON.stringify({ coarse_candidates: [] }) };
          }
          return createMockVlmFn()(framePaths, prompt, {
            model: "gemini-2.0-flash",
            maxOutputTokens: 512,
          });
        },
      });
      const cachedSegment = result.segmentsJson.items.find((segment) =>
        segment.segment_id === cachedSegmentId
      );
      expect(cachedSegment?.tags).not.toContain("legacy_visual_tag");
      expect(cachedSegment?.provenance.summary?.source_content_sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(cachedSegment?.peak_analysis).toBeUndefined();
      expect(result.gapReport.entries.some((entry) =>
        entry.stage === "peak_detection" && entry.segment_id === cachedSegmentId
      )).toBe(true);
      for (const framePath of received.flat()) {
        expect(path.isAbsolute(framePath)).toBe(true);
        expect(fs.statSync(framePath).size).toBeGreaterThan(0);
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }, 120_000);
});
