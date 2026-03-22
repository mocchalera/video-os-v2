/**
 * Tests for VLM Peak Detector — Progressive Resolution peak detection.
 *
 * All tests use mock VlmFn — no real API calls.
 */
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { createRequire } from "node:module";
import {
  buildCoarsePrompt,
  buildRefinePrompt,
  buildPrecisionPrompt,
  normalizeCoarseResponse,
  normalizeRefineResponse,
  normalizePrecisionResponse,
  runCoarsePass,
  runRefinePass,
  runPrecisionPass,
  mapCoarseToSegments,
  generateFilmstripTileMap,
  shouldRunPrecision,
  fusePeakConfidence,
  mirrorPeakToInterestPoints,
  buildPeakAnalysis,
  computeCoarsePromptHash,
  computeRefinePromptHash,
  computePrecisionPromptHash,
  DEFAULT_PEAK_POLICY,
  COARSE_PROMPT_TEMPLATE_ID,
  REFINE_PROMPT_TEMPLATE_ID,
  PRECISION_PROMPT_TEMPLATE_ID,
  type CoarseInput,
  type RefineInput,
  type PrecisionInput,
  type CoarseCandidate,
  type TileMapEntry,
  type FilmstripTileEntry,
  type PeakMoment,
  type PeakDetectionPolicy,
} from "../runtime/connectors/vlm-peak-detector.js";
import type { VlmFn } from "../runtime/connectors/gemini-vlm.js";
import {
  computeMotionSupportScore,
  createStubMotionAnalyzeFn,
  type MotionBin,
} from "../runtime/connectors/ffmpeg-motion.js";
import { computePeakSalienceBonus } from "../runtime/compiler/score.js";
import { resolveTrim, type TrimContext } from "../runtime/compiler/trim.js";
import type { Candidate, NormalizedBeat } from "../runtime/compiler/types.js";

// ── Schema Validator ────────────────────────────────────────────────

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

// ── Mock VlmFn Helpers ──────────────────────────────────────────────

function mockVlmFn(response: unknown): VlmFn {
  return async () => ({ rawJson: JSON.stringify(response) });
}

function mockVlmFnError(message: string): VlmFn {
  return async () => { throw new Error(message); };
}

// ── Test Data ───────────────────────────────────────────────────────

const TILE_MAP: TileMapEntry[] = [
  { tile_index: 0, rep_frame_us: 0 },
  { tile_index: 1, rep_frame_us: 1_000_000 },
  { tile_index: 2, rep_frame_us: 2_000_000 },
  { tile_index: 3, rep_frame_us: 3_000_000 },
  { tile_index: 4, rep_frame_us: 4_000_000 },
  { tile_index: 5, rep_frame_us: 5_000_000 },
];

const COARSE_INPUT: CoarseInput = {
  asset_id: "AST_001",
  contact_sheet_id: "CS_001",
  image_path: "/tmp/contact_sheet.jpg",
  tile_map: TILE_MAP,
  transcript_context: "Runner takes off from blocks",
};

const SEGMENTS = [
  { segment_id: "SEG_001", src_in_us: 0, src_out_us: 2_000_000 },
  { segment_id: "SEG_002", src_in_us: 2_000_000, src_out_us: 4_000_000 },
  { segment_id: "SEG_003", src_in_us: 4_000_000, src_out_us: 6_000_000 },
];

// ── Tests: Prompt Building ──────────────────────────────────────────

describe("VLM Peak Detector — Prompt Building", () => {
  it("buildCoarsePrompt includes tile_map and tile-index-only contract", () => {
    const prompt = buildCoarsePrompt(COARSE_INPUT);
    expect(prompt).toContain("tile_map");
    expect(prompt).toContain("tile_start_index");
    expect(prompt).toContain("Do not return exact timestamps");
    expect(prompt).toContain("AST_001");
  });

  it("buildRefinePrompt includes filmstrip tile_map and variant guidance", () => {
    const input: RefineInput = {
      segment_id: "SEG_002",
      segment_type: "action",
      filmstrip_path: "/tmp/filmstrip.jpg",
      src_in_us: 2_000_000,
      src_out_us: 4_000_000,
      tile_map: [{ tile_index: 0, frame_us: 2_333_333 }],
      transcript_excerpt: "test",
    };
    const prompt = buildRefinePrompt(input);
    expect(prompt).toContain("filmstrip_tile_map");
    expect(prompt).toContain("SEG_002");
    // Action guidance
    expect(prompt).toContain("takeoff, impact, catch");
  });

  it("buildRefinePrompt adds dialogue guidance for dialogue segments", () => {
    const input: RefineInput = {
      segment_id: "SEG_001",
      segment_type: "dialogue",
      filmstrip_path: "/tmp/filmstrip.jpg",
      src_in_us: 0,
      src_out_us: 2_000_000,
      tile_map: [],
    };
    const prompt = buildRefinePrompt(input);
    expect(prompt).toContain("decisive answer landing");
  });

  it("buildPrecisionPrompt includes window and refine peak", () => {
    const input: PrecisionInput = {
      segment_id: "SEG_002",
      segment_type: "action",
      frame_paths: ["/tmp/f1.jpg"],
      frame_timestamps_us: [3_000_000],
      window_start_us: 2_500_000,
      window_end_us: 3_500_000,
      refine_peak_timestamp_us: 3_000_000,
    };
    const prompt = buildPrecisionPrompt(input);
    expect(prompt).toContain("2500000..3500000");
    expect(prompt).toContain("3000000");
  });
});

// ── Tests: Prompt Hashes ────────────────────────────────────────────

describe("VLM Peak Detector — Prompt Hashes", () => {
  it("prompt hashes are stable 16-char hex strings", () => {
    const h1 = computeCoarsePromptHash();
    const h2 = computeRefinePromptHash();
    const h3 = computePrecisionPromptHash();
    expect(h1).toMatch(/^[0-9a-f]{16}$/);
    expect(h2).toMatch(/^[0-9a-f]{16}$/);
    expect(h3).toMatch(/^[0-9a-f]{16}$/);
    // All different
    expect(h1).not.toBe(h2);
    expect(h2).not.toBe(h3);
    // Deterministic
    expect(computeCoarsePromptHash()).toBe(h1);
  });
});

// ── Tests: Coarse Normalization ─────────────────────────────────────

describe("VLM Peak Detector — Coarse Normalization", () => {
  it("normalizes valid coarse candidates", () => {
    const raw = {
      coarse_candidates: [
        { tile_start_index: 2, tile_end_index: 3, likely_peak_type: "action_peak", confidence: 0.85, rationale: "runner takeoff" },
        { tile_start_index: 4, tile_end_index: 5, likely_peak_type: "visual_peak", confidence: 0.72, rationale: "reveal" },
      ],
    };
    const result = normalizeCoarseResponse(raw, TILE_MAP, 3);
    expect(result).toHaveLength(2);
    expect(result[0].tile_start_index).toBe(2);
    expect(result[0].likely_peak_type).toBe("action_peak");
  });

  it("drops candidates with out-of-range tile indices", () => {
    const raw = {
      coarse_candidates: [
        { tile_start_index: 0, tile_end_index: 99, likely_peak_type: "action_peak", confidence: 0.9, rationale: "test" },
      ],
    };
    const result = normalizeCoarseResponse(raw, TILE_MAP, 3);
    expect(result).toHaveLength(0);
  });

  it("drops candidates with invalid peak types", () => {
    const raw = {
      coarse_candidates: [
        { tile_start_index: 0, tile_end_index: 1, likely_peak_type: "unknown_type", confidence: 0.9, rationale: "test" },
      ],
    };
    const result = normalizeCoarseResponse(raw, TILE_MAP, 3);
    expect(result).toHaveLength(0);
  });

  it("respects max candidates limit", () => {
    const raw = {
      coarse_candidates: [
        { tile_start_index: 0, tile_end_index: 1, likely_peak_type: "action_peak", confidence: 0.9, rationale: "a" },
        { tile_start_index: 2, tile_end_index: 3, likely_peak_type: "visual_peak", confidence: 0.8, rationale: "b" },
        { tile_start_index: 4, tile_end_index: 5, likely_peak_type: "emotional_peak", confidence: 0.7, rationale: "c" },
      ],
    };
    const result = normalizeCoarseResponse(raw, TILE_MAP, 2);
    expect(result).toHaveLength(2);
  });

  it("returns empty for empty/invalid input", () => {
    expect(normalizeCoarseResponse(null, TILE_MAP, 3)).toHaveLength(0);
    expect(normalizeCoarseResponse({}, TILE_MAP, 3)).toHaveLength(0);
    expect(normalizeCoarseResponse({ coarse_candidates: "not_array" }, TILE_MAP, 3)).toHaveLength(0);
  });

  it("drops candidates where start > end", () => {
    const raw = {
      coarse_candidates: [
        { tile_start_index: 3, tile_end_index: 1, likely_peak_type: "action_peak", confidence: 0.9, rationale: "test" },
      ],
    };
    const result = normalizeCoarseResponse(raw, TILE_MAP, 3);
    expect(result).toHaveLength(0);
  });
});

// ── Tests: Coarse -> Segment Mapping ────────────────────────────────

describe("VLM Peak Detector — Coarse to Segment Mapping", () => {
  it("maps coarse tile candidates to overlapping segments", () => {
    const candidates: CoarseCandidate[] = [
      { tile_start_index: 2, tile_end_index: 3, likely_peak_type: "action_peak", confidence: 0.85, rationale: "test" },
    ];
    const overlaps = mapCoarseToSegments(candidates, TILE_MAP, SEGMENTS);
    // Tiles 2,3 → rep_frame_us 2_000_000 to 3_000_000
    // Overlaps SEG_002 (2M-4M) and SEG_001 partially (if considering boundary)
    expect(overlaps.length).toBeGreaterThanOrEqual(1);
    const segIds = overlaps.map((o) => o.segment_id);
    expect(segIds).toContain("SEG_002");
  });

  it("returns empty for no overlapping segments", () => {
    const candidates: CoarseCandidate[] = [
      { tile_start_index: 0, tile_end_index: 0, likely_peak_type: "action_peak", confidence: 0.5, rationale: "test" },
    ];
    // Tile 0 → rep_frame_us 0, which overlaps SEG_001 start only
    const farSegments = [{ segment_id: "SEG_FAR", src_in_us: 10_000_000, src_out_us: 12_000_000 }];
    const overlaps = mapCoarseToSegments(candidates, TILE_MAP, farSegments);
    expect(overlaps).toHaveLength(0);
  });
});

// ── Tests: Filmstrip Tile Map Generation ────────────────────────────

describe("VLM Peak Detector — Filmstrip Tile Map", () => {
  it("generates deterministic 6-tile filmstrip map", () => {
    const tiles = generateFilmstripTileMap(0, 6_000_000, 6);
    expect(tiles).toHaveLength(6);
    expect(tiles[0].tile_index).toBe(0);
    expect(tiles[0].frame_us).toBe(500_000);
    expect(tiles[5].tile_index).toBe(5);
    expect(tiles[5].frame_us).toBe(5_500_000);
  });

  it("returns empty for zero-length segment", () => {
    expect(generateFilmstripTileMap(1000, 1000, 6)).toHaveLength(0);
  });
});

// ── Tests: Refine Normalization ─────────────────────────────────────

describe("VLM Peak Detector — Refine Normalization", () => {
  const srcIn = 2_000_000;
  const srcOut = 4_000_000;
  const segId = "SEG_002";

  it("normalizes a complete valid refine response", () => {
    const raw = {
      summary: "Runner launches from blocks",
      tags: ["action", "sports"],
      interest_points: [
        { frame_us: 3_200_000, label: "takeoff moment", confidence: 0.9 },
      ],
      peak_moment: {
        timestamp_us: 3_200_000,
        type: "action_peak",
        confidence: 0.88,
        description: "runner launches forward",
      },
      recommended_in_out: {
        best_in_us: 2_500_000,
        best_out_us: 3_800_000,
        rationale: "preserve anticipation",
        needs_precision: false,
      },
      visual_energy_curve: [
        { timestamp_us: 2_500_000, energy: 0.4 },
        { timestamp_us: 3_200_000, energy: 0.95 },
      ],
      quality_flags: [],
      confidence: { summary: 0.85, tags: 0.8, quality_flags: 0.9 },
      peak_confidence: { vlm: 0.88 },
    };

    const result = normalizeRefineResponse(raw, srcIn, srcOut, segId, 12);
    expect(result.summary).toBe("Runner launches from blocks");
    expect(result.tags).toEqual(["action", "sports"]);
    expect(result.interest_points).toHaveLength(1);
    expect(result.peak_moment).toBeDefined();
    expect(result.peak_moment!.peak_ref).toBe("SEG_002@3200000");
    expect(result.peak_moment!.type).toBe("action_peak");
    expect(result.recommended_in_out).toBeDefined();
    expect(result.recommended_in_out!.best_in_us).toBe(2_500_000);
    expect(result.visual_energy_curve).toHaveLength(2);
    expect(result.peak_confidence_vlm).toBe(0.88);
    expect(result.needs_precision).toBe(false);
  });

  it("clamps recommended_in_out to segment range", () => {
    const raw = {
      recommended_in_out: {
        best_in_us: 1_000_000, // Before segment start
        best_out_us: 5_000_000, // After segment end
        rationale: "test",
      },
    };
    const result = normalizeRefineResponse(raw, srcIn, srcOut, segId, 12);
    expect(result.recommended_in_out!.best_in_us).toBe(srcIn);
    expect(result.recommended_in_out!.best_out_us).toBe(srcOut);
  });

  it("drops peak_moment outside segment range", () => {
    const raw = {
      peak_moment: {
        timestamp_us: 1_000_000, // Before segment
        type: "action_peak",
        confidence: 0.9,
        description: "test",
      },
    };
    const result = normalizeRefineResponse(raw, srcIn, srcOut, segId, 12);
    expect(result.peak_moment).toBeUndefined();
  });

  it("drops invalid recommended_in_out (out <= in)", () => {
    const raw = {
      recommended_in_out: {
        best_in_us: 3_500_000,
        best_out_us: 2_500_000,
        rationale: "invalid",
      },
    };
    const result = normalizeRefineResponse(raw, srcIn, srcOut, segId, 12);
    expect(result.recommended_in_out).toBeUndefined();
  });

  it("handles empty/null input gracefully", () => {
    const result = normalizeRefineResponse(null, srcIn, srcOut, segId, 12);
    expect(result.summary).toBe("");
    expect(result.tags).toHaveLength(0);
    expect(result.peak_moment).toBeUndefined();
  });
});

// ── Tests: Precision Normalization ──────────────────────────────────

describe("VLM Peak Detector — Precision Normalization", () => {
  it("normalizes valid precision response", () => {
    const raw = {
      peak_moment: {
        timestamp_us: 3_100_000,
        type: "action_peak",
        confidence: 0.92,
        description: "exact apex",
      },
      recommended_in_out: {
        best_in_us: 2_800_000,
        best_out_us: 3_400_000,
        rationale: "tightened window",
      },
    };
    const result = normalizePrecisionResponse(raw, 2_500_000, 3_500_000, "SEG_002");
    expect(result.peak_moment).toBeDefined();
    expect(result.peak_moment!.timestamp_us).toBe(3_100_000);
    expect(result.peak_moment!.source_pass).toBe("precision_dense_frames");
    expect(result.recommended_in_out).toBeDefined();
    expect(result.recommended_in_out!.best_in_us).toBe(2_800_000);
  });

  it("drops peak outside precision window", () => {
    const raw = {
      peak_moment: {
        timestamp_us: 1_000_000,
        type: "action_peak",
        confidence: 0.9,
        description: "out of range",
      },
    };
    const result = normalizePrecisionResponse(raw, 2_500_000, 3_500_000, "SEG_002");
    expect(result.peak_moment).toBeUndefined();
  });
});

// ── Tests: Full Pass Execution (Mock VLM) ───────────────────────────

describe("VLM Peak Detector — Coarse Pass Execution", () => {
  it("runs coarse pass with mock VLM and returns candidates", async () => {
    const vlm = mockVlmFn({
      coarse_candidates: [
        { tile_start_index: 2, tile_end_index: 3, likely_peak_type: "action_peak", confidence: 0.85, rationale: "runner takeoff" },
      ],
    });

    const result = await runCoarsePass(vlm, COARSE_INPUT, DEFAULT_PEAK_POLICY);
    expect(result.success).toBe(true);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].likely_peak_type).toBe("action_peak");
  });

  it("handles VLM error gracefully", async () => {
    const vlm = mockVlmFnError("API timeout");
    const result = await runCoarsePass(vlm, COARSE_INPUT, DEFAULT_PEAK_POLICY);
    expect(result.success).toBe(false);
    expect(result.candidates).toHaveLength(0);
    expect(result.error).toContain("API timeout");
  });
});

describe("VLM Peak Detector — Refine Pass Execution", () => {
  it("runs refine pass with mock VLM and returns peak moment", async () => {
    const vlm = mockVlmFn({
      summary: "Runner launches",
      tags: ["action"],
      interest_points: [{ frame_us: 3_200_000, label: "takeoff", confidence: 0.9 }],
      peak_moment: { timestamp_us: 3_200_000, type: "action_peak", confidence: 0.88, description: "runner launches" },
      recommended_in_out: { best_in_us: 2_500_000, best_out_us: 3_800_000, rationale: "test", needs_precision: false },
      visual_energy_curve: [],
      quality_flags: [],
      confidence: { summary: 0.85, tags: 0.8, quality_flags: 0.9 },
      peak_confidence: { vlm: 0.88 },
    });

    const input: RefineInput = {
      segment_id: "SEG_002",
      segment_type: "action",
      filmstrip_path: "/tmp/filmstrip.jpg",
      src_in_us: 2_000_000,
      src_out_us: 4_000_000,
      tile_map: generateFilmstripTileMap(2_000_000, 4_000_000),
    };

    const result = await runRefinePass(vlm, input, DEFAULT_PEAK_POLICY);
    expect(result.success).toBe(true);
    expect(result.peak_moment).toBeDefined();
    expect(result.peak_moment!.type).toBe("action_peak");
    expect(result.recommended_in_out).toBeDefined();
  });

  it("handles VLM error gracefully", async () => {
    const vlm = mockVlmFnError("rate limit");
    const input: RefineInput = {
      segment_id: "SEG_002",
      segment_type: "action",
      filmstrip_path: "/tmp/filmstrip.jpg",
      src_in_us: 2_000_000,
      src_out_us: 4_000_000,
      tile_map: [],
    };
    const result = await runRefinePass(vlm, input, DEFAULT_PEAK_POLICY);
    expect(result.success).toBe(false);
    expect(result.peak_moment).toBeUndefined();
  });
});

describe("VLM Peak Detector — Precision Pass Execution", () => {
  it("runs precision pass with mock VLM", async () => {
    const vlm = mockVlmFn({
      peak_moment: { timestamp_us: 3_100_000, type: "action_peak", confidence: 0.92, description: "exact apex" },
      recommended_in_out: { best_in_us: 2_800_000, best_out_us: 3_400_000, rationale: "tightened" },
    });

    const input: PrecisionInput = {
      segment_id: "SEG_002",
      segment_type: "action",
      frame_paths: ["/tmp/f1.jpg", "/tmp/f2.jpg"],
      frame_timestamps_us: [3_000_000, 3_100_000],
      window_start_us: 2_500_000,
      window_end_us: 3_500_000,
      refine_peak_timestamp_us: 3_000_000,
    };

    const result = await runPrecisionPass(vlm, input, DEFAULT_PEAK_POLICY);
    expect(result.success).toBe(true);
    expect(result.peak_moment!.timestamp_us).toBe(3_100_000);
    expect(result.peak_moment!.source_pass).toBe("precision_dense_frames");
  });
});

// ── Tests: Precision Eligibility ────────────────────────────────────

describe("VLM Peak Detector — Precision Eligibility", () => {
  it("action_only mode: precision for action segments when needed", () => {
    const policy: PeakDetectionPolicy = { ...DEFAULT_PEAK_POLICY, peak_precision_mode: "action_only" };
    expect(shouldRunPrecision("action", true, 0.7, policy)).toBe(true);
    expect(shouldRunPrecision("action", false, 0.7, policy)).toBe(false);
    expect(shouldRunPrecision("dialogue", true, 0.7, policy)).toBe(false);
  });

  it("never mode: no precision regardless", () => {
    const policy: PeakDetectionPolicy = { ...DEFAULT_PEAK_POLICY, peak_precision_mode: "never" };
    expect(shouldRunPrecision("action", true, 0.7, policy)).toBe(false);
  });

  it("always mode: precision for any segment when needed", () => {
    const policy: PeakDetectionPolicy = { ...DEFAULT_PEAK_POLICY, peak_precision_mode: "always" };
    expect(shouldRunPrecision("dialogue", true, 0.7, policy)).toBe(true);
    expect(shouldRunPrecision("dialogue", false, 0.7, policy)).toBe(false);
  });
});

// ── Tests: Confidence Fusion ────────────────────────────────────────

describe("VLM Peak Detector — Confidence Fusion", () => {
  it("fuses VLM + motion without audio (default weights)", () => {
    const fused = fusePeakConfidence(0.90, 0.80);
    // 0.75 * 0.90 + 0.25 * 0.80 = 0.675 + 0.20 = 0.875
    expect(fused).toBeCloseTo(0.875, 2);
  });

  it("fuses VLM + motion + audio", () => {
    const fused = fusePeakConfidence(0.90, 0.80, 0.60);
    // 0.70 * 0.90 + 0.20 * 0.80 + 0.10 * 0.60 = 0.63 + 0.16 + 0.06 = 0.85
    expect(fused).toBeCloseTo(0.85, 2);
  });

  it("action_peak: higher motion weight without audio", () => {
    const fused = fusePeakConfidence(0.90, 0.80, undefined, "action_peak");
    // 0.65 * 0.90 + 0.35 * 0.80 = 0.585 + 0.28 = 0.865
    expect(fused).toBeCloseTo(0.865, 2);
  });

  it("emotional_peak: higher audio weight with audio", () => {
    const fused = fusePeakConfidence(0.90, 0.50, 0.80, "emotional_peak");
    // 0.65 * 0.90 + 0.15 * 0.50 + 0.20 * 0.80 = 0.585 + 0.075 + 0.16 = 0.82
    expect(fused).toBeCloseTo(0.82, 2);
  });

  it("clamps to [0, 1]", () => {
    expect(fusePeakConfidence(1.5, 1.5)).toBeLessThanOrEqual(1);
    expect(fusePeakConfidence(0, 0)).toBeGreaterThanOrEqual(0);
  });
});

// ── Tests: Peak -> Interest Point Mirror ────────────────────────────

describe("VLM Peak Detector — Peak to Interest Point Mirror", () => {
  it("mirrors peak moments to interest_points format", () => {
    const peaks: PeakMoment[] = [
      {
        peak_ref: "SEG_002@3200000",
        timestamp_us: 3_200_000,
        type: "action_peak",
        confidence: 0.88,
        description: "runner launches",
        source_pass: "refine_filmstrip",
      },
    ];
    const ips = mirrorPeakToInterestPoints(peaks);
    expect(ips).toHaveLength(1);
    expect(ips[0].frame_us).toBe(3_200_000);
    expect(ips[0].label).toBe("action_peak: runner launches");
    expect(ips[0].confidence).toBe(0.88);
  });
});

// ── Tests: Peak Analysis Assembly ───────────────────────────────────

describe("VLM Peak Detector — Peak Analysis Assembly", () => {
  it("builds complete peak analysis with refine result", () => {
    const pa = buildPeakAnalysis({
      coarseLocator: {
        contact_sheet_id: "CS_001",
        tile_start_index: 2,
        tile_end_index: 3,
        coarse_window_start_us: 2_000_000,
        coarse_window_end_us: 3_000_000,
      },
      refinePeakMoment: {
        peak_ref: "SEG_002@3200000",
        timestamp_us: 3_200_000,
        type: "action_peak",
        confidence: 0.88,
        description: "runner launches",
        source_pass: "refine_filmstrip",
      },
      refineRecommendedInOut: {
        best_in_us: 2_500_000,
        best_out_us: 3_800_000,
        rationale: "anticipation",
        source_pass: "refine_filmstrip",
      },
      visualEnergyCurve: [{ timestamp_us: 3_200_000, energy: 0.95 }],
      supportSignals: { motion_support_score: 0.91, audio_support_score: 0.22, fused_peak_score: 0.89 },
      precisionMode: "not_run",
    });

    expect(pa.peak_moments).toHaveLength(1);
    expect(pa.peak_moments[0].type).toBe("action_peak");
    expect(pa.recommended_in_out).toBeDefined();
    expect(pa.coarse_locator).toBeDefined();
    expect(pa.provenance.fusion_version).toBe("peak-fusion-v1");
  });

  it("precision overrides refine when both present", () => {
    const pa = buildPeakAnalysis({
      refinePeakMoment: {
        peak_ref: "SEG_002@3200000",
        timestamp_us: 3_200_000,
        type: "action_peak",
        confidence: 0.88,
        description: "refine",
        source_pass: "refine_filmstrip",
      },
      precisionPeakMoment: {
        peak_ref: "SEG_002@3100000",
        timestamp_us: 3_100_000,
        type: "action_peak",
        confidence: 0.92,
        description: "precision",
        source_pass: "precision_dense_frames",
      },
      refineRecommendedInOut: {
        best_in_us: 2_500_000,
        best_out_us: 3_800_000,
        rationale: "refine",
        source_pass: "refine_filmstrip",
      },
      precisionRecommendedInOut: {
        best_in_us: 2_800_000,
        best_out_us: 3_400_000,
        rationale: "precision",
        source_pass: "precision_dense_frames",
      },
      visualEnergyCurve: [],
      precisionMode: "action_only",
    });

    expect(pa.peak_moments[0].timestamp_us).toBe(3_100_000);
    expect(pa.peak_moments[0].source_pass).toBe("precision_dense_frames");
    expect(pa.recommended_in_out!.best_in_us).toBe(2_800_000);
  });
});

// ── Tests: Motion Support Score ─────────────────────────────────────

describe("ffmpeg Motion — Support Score", () => {
  it("returns high score when motion peak aligns with VLM peak", () => {
    const bins: MotionBin[] = [
      { start_us: 0, end_us: 1_000_000, energy: 0.3 },
      { start_us: 1_000_000, end_us: 2_000_000, energy: 0.5 },
      { start_us: 2_000_000, end_us: 3_000_000, energy: 0.95 },
      { start_us: 3_000_000, end_us: 4_000_000, energy: 0.4 },
    ];
    const score = computeMotionSupportScore(bins, 2_500_000);
    expect(score).toBe(1); // 0.95 / 0.95 = 1
  });

  it("returns low score when motion peak is far from VLM peak", () => {
    const bins: MotionBin[] = [
      { start_us: 0, end_us: 1_000_000, energy: 0.95 },
      { start_us: 1_000_000, end_us: 2_000_000, energy: 0.2 },
      { start_us: 2_000_000, end_us: 3_000_000, energy: 0.1 },
      { start_us: 3_000_000, end_us: 4_000_000, energy: 0.1 },
    ];
    const score = computeMotionSupportScore(bins, 3_500_000);
    // Max in window is 0.1, overall max is 0.95
    expect(score).toBeCloseTo(0.1 / 0.95, 2);
  });

  it("returns 0.5 (neutral) for empty bins", () => {
    expect(computeMotionSupportScore([], 1_000_000)).toBe(0.5);
  });

  it("stub motion analyzer returns uniform energy", async () => {
    const analyze = createStubMotionAnalyzeFn(0.6);
    const result = await analyze("/tmp/test.mp4", 0, 4_000_000, 4);
    expect(result.bins).toHaveLength(4);
    expect(result.average_energy).toBe(0.6);
  });
});

// ── Tests: Peak Salience Bonus (score.ts) ───────────────────────────

describe("Compiler Score — Peak Salience Bonus", () => {
  it("returns positive bonus for candidate with peak signals", () => {
    const candidate: Candidate = {
      segment_id: "SEG_001",
      asset_id: "AST_001",
      src_in_us: 0,
      src_out_us: 2_000_000,
      role: "hero",
      why_it_matches: "test",
      risks: [],
      confidence: 0.9,
      editorial_signals: {
        peak_strength_score: 0.89,
        peak_type: "action_peak",
      },
    };
    const beat: NormalizedBeat = {
      beat_id: "beat_1",
      label: "Hook",
      target_duration_frames: 72,
      required_roles: ["hero"],
      preferred_roles: [],
      purpose: "opening hook",
      story_role: "hook",
    };
    const bonus = computePeakSalienceBonus(candidate, beat);
    // 0.89 * 1.00 (hook) * 1.00 (action_peak on hero) = 0.89
    expect(bonus).toBeCloseTo(0.89, 2);
  });

  it("returns 0 for candidate without peak signals", () => {
    const candidate: Candidate = {
      segment_id: "SEG_001",
      asset_id: "AST_001",
      src_in_us: 0,
      src_out_us: 2_000_000,
      role: "hero",
      why_it_matches: "test",
      risks: [],
      confidence: 0.9,
    };
    const beat: NormalizedBeat = {
      beat_id: "beat_1",
      label: "Hook",
      target_duration_frames: 72,
      required_roles: ["hero"],
      preferred_roles: [],
      purpose: "test",
      story_role: "hook",
    };
    const bonus = computePeakSalienceBonus(candidate, beat);
    expect(bonus).toBe(0);
  });

  it("applies reduced weight for type mismatch", () => {
    const candidate: Candidate = {
      segment_id: "SEG_001",
      asset_id: "AST_001",
      src_in_us: 0,
      src_out_us: 2_000_000,
      role: "texture",
      why_it_matches: "test",
      risks: [],
      confidence: 0.9,
      editorial_signals: {
        peak_strength_score: 0.89,
        peak_type: "action_peak",
      },
    };
    const beat: NormalizedBeat = {
      beat_id: "beat_1",
      label: "Setup",
      target_duration_frames: 72,
      required_roles: ["texture"],
      preferred_roles: [],
      purpose: "test",
      story_role: "setup",
    };
    const bonus = computePeakSalienceBonus(candidate, beat);
    // 0.89 * 0.45 (setup) * 0.55 (action_peak on texture) ≈ 0.220
    expect(bonus).toBeCloseTo(0.89 * 0.45 * 0.55, 2);
  });

  it("peak candidates rerank above non-peak candidates", () => {
    const withPeak: Candidate = {
      segment_id: "SEG_001",
      asset_id: "AST_001",
      src_in_us: 0,
      src_out_us: 2_000_000,
      role: "hero",
      why_it_matches: "test",
      risks: [],
      confidence: 0.8,
      semantic_rank: 2,
      editorial_signals: {
        peak_strength_score: 0.85,
        peak_type: "action_peak",
      },
    };
    const withoutPeak: Candidate = {
      segment_id: "SEG_002",
      asset_id: "AST_002",
      src_in_us: 0,
      src_out_us: 2_000_000,
      role: "hero",
      why_it_matches: "test",
      risks: [],
      confidence: 0.9,
      semantic_rank: 1,
    };
    const beat: NormalizedBeat = {
      beat_id: "beat_1",
      label: "Hook",
      target_duration_frames: 72,
      required_roles: ["hero"],
      preferred_roles: [],
      purpose: "test",
      story_role: "hook",
    };
    const bonusWithPeak = computePeakSalienceBonus(withPeak, beat);
    const bonusWithoutPeak = computePeakSalienceBonus(withoutPeak, beat);
    expect(bonusWithPeak).toBeGreaterThan(bonusWithoutPeak);
  });
});

// ── Tests: Trim with Peak Center ────────────────────────────────────

describe("Compiler Trim — Peak Center Trim", () => {
  const ctx: TrimContext = {
    beatTargetDurationUs: 2_000_000,
    usPerFrame: 41_667, // ~24fps
  };

  it("uses peak center when trim_hint has peak_type", () => {
    const candidate: Candidate = {
      segment_id: "SEG_002",
      asset_id: "AST_001",
      src_in_us: 2_000_000,
      src_out_us: 6_000_000,
      role: "hero",
      why_it_matches: "test",
      risks: [],
      confidence: 0.9,
      trim_hint: {
        source_center_us: 4_000_000,
        preferred_duration_us: 2_000_000,
        peak_type: "action_peak",
        peak_ref: "SEG_002@4000000",
        interest_point_confidence: 0.88,
        center_source: "refine_filmstrip",
      },
    };

    const resolved = resolveTrim(candidate, ctx);
    expect(resolved.mode).toBe("adaptive_peak_center");
    expect(resolved.source_center_us).toBe(4_000_000);
    expect(resolved.peak_type).toBe("action_peak");
    expect(resolved.peak_ref).toBe("SEG_002@4000000");
    // Action peak: pre-roll 0.60 → center - 1.2M, post-roll 0.40 → center + 0.8M
    expect(resolved.src_in_us).toBe(2_800_000);
    expect(resolved.src_out_us).toBe(4_800_000);
  });

  it("emotional_peak gets longer post-roll", () => {
    const candidate: Candidate = {
      segment_id: "SEG_001",
      asset_id: "AST_001",
      src_in_us: 0,
      src_out_us: 4_000_000,
      role: "dialogue",
      why_it_matches: "test",
      risks: [],
      confidence: 0.9,
      trim_hint: {
        source_center_us: 2_000_000,
        preferred_duration_us: 2_000_000,
        peak_type: "emotional_peak",
        center_source: "refine_filmstrip",
      },
    };

    const resolved = resolveTrim(candidate, ctx);
    expect(resolved.mode).toBe("adaptive_peak_center");
    // Emotional peak: pre-roll 0.40, post-roll 0.60
    // In = 2M - 0.8M = 1.2M, Out = 2M + 1.2M = 3.2M
    expect(resolved.src_in_us).toBe(1_200_000);
    expect(resolved.src_out_us).toBe(3_200_000);
  });

  it("falls back to midpoint when no peak data", () => {
    const candidate: Candidate = {
      segment_id: "SEG_001",
      asset_id: "AST_001",
      src_in_us: 0,
      src_out_us: 4_000_000,
      role: "hero",
      why_it_matches: "test",
      risks: [],
      confidence: 0.9,
    };

    const resolved = resolveTrim(candidate, { ...ctx, trimPolicy: { mode: "adaptive" } });
    expect(resolved.mode).toBe("fixed_midpoint");
    expect(resolved.source_center_us).toBe(2_000_000);
    expect(resolved.peak_type).toBeUndefined();
  });

  it("uses adaptive_center when hint has center but no peak_type", () => {
    const candidate: Candidate = {
      segment_id: "SEG_001",
      asset_id: "AST_001",
      src_in_us: 0,
      src_out_us: 4_000_000,
      role: "hero",
      why_it_matches: "test",
      risks: [],
      confidence: 0.9,
      trim_hint: {
        source_center_us: 1_500_000,
        preferred_duration_us: 2_000_000,
      },
    };

    const resolved = resolveTrim(candidate, ctx);
    expect(resolved.mode).toBe("adaptive_center");
    expect(resolved.source_center_us).toBe(1_500_000);
  });

  it("clamps to authored window", () => {
    const candidate: Candidate = {
      segment_id: "SEG_001",
      asset_id: "AST_001",
      src_in_us: 1_000_000,
      src_out_us: 3_000_000,
      role: "hero",
      why_it_matches: "test",
      risks: [],
      confidence: 0.9,
      trim_hint: {
        source_center_us: 1_200_000,
        preferred_duration_us: 2_000_000,
        peak_type: "action_peak",
        window_start_us: 1_000_000,
        window_end_us: 3_000_000,
      },
    };

    const resolved = resolveTrim(candidate, ctx);
    expect(resolved.src_in_us).toBeGreaterThanOrEqual(1_000_000);
    expect(resolved.src_out_us).toBeLessThanOrEqual(3_000_000);
  });
});

// ── Tests: Schema Validation ────────────────────────────────────────

describe("Segments Schema — peak_analysis validation", () => {
  const validate = createSegmentsValidator();

  it("validates segment with peak_analysis", () => {
    const data = {
      project_id: "test",
      artifact_version: "2.0.0",
      items: [
        {
          segment_id: "SEG_001",
          asset_id: "AST_001",
          src_in_us: 0,
          src_out_us: 4_000_000,
          summary: "test",
          transcript_excerpt: "",
          quality_flags: [],
          tags: ["action"],
          peak_analysis: {
            peak_moments: [
              {
                peak_ref: "SEG_001@3200000",
                timestamp_us: 3_200_000,
                type: "action_peak",
                confidence: 0.88,
                description: "runner launches",
                source_pass: "refine_filmstrip",
              },
            ],
            visual_energy_curve: [
              { timestamp_us: 3_200_000, energy: 0.95 },
            ],
            provenance: {
              coarse_prompt_template_id: "m2-asset-peak-coarse-v2",
              refine_prompt_template_id: "m2-segment-peak-refine-v2",
              precision_mode: "not_run",
              fusion_version: "peak-fusion-v1",
              support_signal_version: "motion-v1",
            },
          },
        },
      ],
    };
    const valid = validate(data);
    if (!valid) {
      console.error("Schema errors:", validate.errors);
    }
    expect(valid).toBe(true);
  });

  it("validates segment without peak_analysis (backward compat)", () => {
    const data = {
      project_id: "test",
      artifact_version: "2.0.0",
      items: [
        {
          segment_id: "SEG_001",
          asset_id: "AST_001",
          src_in_us: 0,
          src_out_us: 4_000_000,
          summary: "test",
          transcript_excerpt: "",
          quality_flags: [],
          tags: [],
        },
      ],
    };
    const valid = validate(data);
    expect(valid).toBe(true);
  });

  it("validates full peak_analysis with all optional fields", () => {
    const data = {
      project_id: "test",
      artifact_version: "2.0.0",
      items: [
        {
          segment_id: "SEG_001",
          asset_id: "AST_001",
          src_in_us: 0,
          src_out_us: 6_000_000,
          summary: "test",
          transcript_excerpt: "",
          quality_flags: [],
          tags: [],
          peak_analysis: {
            coarse_locator: {
              contact_sheet_id: "CS_001",
              tile_start_index: 2,
              tile_end_index: 3,
              coarse_window_start_us: 2_000_000,
              coarse_window_end_us: 3_000_000,
            },
            peak_moments: [
              {
                peak_ref: "SEG_001@4820000",
                timestamp_us: 4_820_000,
                type: "action_peak",
                confidence: 0.89,
                description: "runner launches",
                source_pass: "refine_filmstrip",
              },
            ],
            recommended_in_out: {
              best_in_us: 3_720_000,
              best_out_us: 5_480_000,
              rationale: "preserve anticipation",
              source_pass: "refine_filmstrip",
            },
            visual_energy_curve: [
              { timestamp_us: 3_600_000, energy: 0.34, source: "motion" },
              { timestamp_us: 4_800_000, energy: 0.94, source: "fused" },
            ],
            support_signals: {
              motion_support_score: 0.91,
              audio_support_score: 0.22,
              fused_peak_score: 0.89,
            },
            provenance: {
              coarse_prompt_template_id: "m2-asset-peak-coarse-v2",
              refine_prompt_template_id: "m2-segment-peak-refine-v2",
              precision_mode: "action_only",
              fusion_version: "peak-fusion-v1",
              support_signal_version: "motion-v1",
            },
          },
        },
      ],
    };
    const valid = validate(data);
    if (!valid) {
      console.error("Schema errors:", validate.errors);
    }
    expect(valid).toBe(true);
  });

  it("rejects peak_analysis with additional properties", () => {
    const data = {
      project_id: "test",
      artifact_version: "2.0.0",
      items: [
        {
          segment_id: "SEG_001",
          asset_id: "AST_001",
          src_in_us: 0,
          src_out_us: 4_000_000,
          summary: "test",
          transcript_excerpt: "",
          quality_flags: [],
          tags: [],
          peak_analysis: {
            peak_moments: [],
            visual_energy_curve: [],
            provenance: {
              coarse_prompt_template_id: "test",
              refine_prompt_template_id: "test",
              precision_mode: "not_run",
              fusion_version: "v1",
              support_signal_version: "v1",
            },
            extra_field: "should_fail",
          },
        },
      ],
    };
    const valid = validate(data);
    expect(valid).toBe(false);
  });
});

// ── Tests: E2E Peak -> Trim -> Score Integration ────────────────────

describe("E2E — Peak through Trim and Score", () => {
  it("peak-centered candidate scores higher and trims to peak", () => {
    const peakCandidate: Candidate = {
      segment_id: "SEG_002",
      asset_id: "AST_001",
      src_in_us: 2_000_000,
      src_out_us: 6_000_000,
      role: "hero",
      why_it_matches: "strong action",
      risks: [],
      confidence: 0.85,
      semantic_rank: 2,
      editorial_signals: {
        peak_strength_score: 0.89,
        peak_type: "action_peak",
        motion_energy_score: 0.91,
      },
      trim_hint: {
        source_center_us: 4_200_000,
        preferred_duration_us: 2_000_000,
        min_duration_us: 1_200_000,
        max_duration_us: 2_800_000,
        window_start_us: 2_500_000,
        window_end_us: 5_500_000,
        peak_type: "action_peak",
        peak_ref: "SEG_002@4200000",
        interest_point_confidence: 0.89,
        center_source: "refine_filmstrip",
        interest_point_label: "action_peak: runner launches forward",
      },
    };

    const noPeakCandidate: Candidate = {
      segment_id: "SEG_003",
      asset_id: "AST_002",
      src_in_us: 4_000_000,
      src_out_us: 8_000_000,
      role: "hero",
      why_it_matches: "decent footage",
      risks: [],
      confidence: 0.9,
      semantic_rank: 1,
    };

    const beat: NormalizedBeat = {
      beat_id: "beat_hook",
      label: "Opening Hook",
      target_duration_frames: 72,
      required_roles: ["hero"],
      preferred_roles: [],
      purpose: "grab attention",
      story_role: "hook",
    };

    // Score comparison
    const peakBonus = computePeakSalienceBonus(peakCandidate, beat);
    const noPeakBonus = computePeakSalienceBonus(noPeakCandidate, beat);
    expect(peakBonus).toBeGreaterThan(0.5);
    expect(noPeakBonus).toBe(0);

    // Trim resolves to peak center, not midpoint
    const ctx: TrimContext = {
      beatTargetDurationUs: 3_000_000,
      usPerFrame: 41_667,
    };
    const trimmed = resolveTrim(peakCandidate, ctx);
    expect(trimmed.mode).toBe("adaptive_peak_center");
    expect(trimmed.source_center_us).toBe(4_200_000);
    expect(trimmed.peak_type).toBe("action_peak");

    // Verify trim is within window
    expect(trimmed.src_in_us).toBeGreaterThanOrEqual(2_500_000);
    expect(trimmed.src_out_us).toBeLessThanOrEqual(5_500_000);

    // Verify asymmetry: action_peak pre-roll > post-roll
    const preRoll = trimmed.source_center_us! - trimmed.src_in_us;
    const postRoll = trimmed.src_out_us - trimmed.source_center_us!;
    expect(preRoll).toBeGreaterThan(postRoll);
  });

  it("legacy path works when no peak data present", () => {
    const candidate: Candidate = {
      segment_id: "SEG_001",
      asset_id: "AST_001",
      src_in_us: 0,
      src_out_us: 4_000_000,
      role: "hero",
      why_it_matches: "test",
      risks: [],
      confidence: 0.9,
    };

    const beat: NormalizedBeat = {
      beat_id: "beat_1",
      label: "Test",
      target_duration_frames: 72,
      required_roles: ["hero"],
      preferred_roles: [],
      purpose: "test",
    };

    const bonus = computePeakSalienceBonus(candidate, beat);
    expect(bonus).toBe(0);

    // Without any hint, should return fixed_authored
    const resolved = resolveTrim(candidate, {
      beatTargetDurationUs: 3_000_000,
      usPerFrame: 41_667,
    });
    expect(resolved.mode).toBe("fixed_authored");
    expect(resolved.src_in_us).toBe(0);
    expect(resolved.src_out_us).toBe(4_000_000);
  });
});
