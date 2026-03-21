/**
 * Tests for Gemini VLM Connector — adaptive sampling, output normalization,
 * tag cleaning, prompt hash, parse retry, and mocked integration.
 *
 * All tests use mock VlmFn — no real Gemini API calls.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { createRequire } from "node:module";
import {
  getAdaptiveSampleFps,
  computeFrameCount,
  computeSampleTimestamps,
  adjustFpsForBudget,
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
  VLM_CONNECTOR_VERSION,
  PROMPT_TEMPLATE_ID,
  type VlmFn,
  type VlmPolicy,
  type SamplingPolicy,
  type VlmRawResponse,
} from "../runtime/connectors/gemini-vlm.js";
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
  prompt_template_id: "m2-segment-v1",
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
  });

  it("falls back on API failure after retries", async () => {
    const vlmFn = createFailingVlmFn();
    const result = await enrichSegment(
      vlmFn,
      ["frame_1.jpg"],
      0,
      5_000_000,
      MOCK_VLM_POLICY,
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain("API timeout");
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
});

// ── Constants ───────────────────────────────────────────────────────

describe("Constants", () => {
  it("has connector version", () => {
    expect(VLM_CONNECTOR_VERSION).toBe("gemini-vlm-v2.0.0");
  });

  it("has prompt template ID", () => {
    expect(PROMPT_TEMPLATE_ID).toBe("m2-segment-v1");
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
      expect(conf.summary.source).toBe("gemini-2.0-flash");
      expect(conf.summary.status).toBe("ready");
    }
  });

  it("enriched segments have VLM provenance records", () => {
    const enriched = result.segmentsJson.items.filter(
      (s) => (s.provenance as Record<string, unknown>).summary !== undefined,
    );
    expect(enriched.length).toBeGreaterThanOrEqual(1);
    for (const seg of enriched) {
      const prov = seg.provenance as Record<string, Record<string, string>>;
      expect(prov.summary.stage).toBe("vlm");
      expect(prov.summary.method).toBe("gemini_frame_bundle");
      expect(prov.summary.connector_version).toBe(VLM_CONNECTOR_VERSION);
      expect(prov.summary.prompt_hash).toMatch(/^[0-9a-f]{16}$/);
      expect(prov.summary.model_alias).toBe("gemini-2.0-flash");
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
      });

      expect(vlmCalled).toBe(false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }, 60_000);
});
