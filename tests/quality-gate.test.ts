import { describe, expect, it } from "vitest";
import {
  DEFAULT_QUALITY_GATE_THRESHOLDS,
  applyQualityGateToSelects,
} from "../runtime/editorial/quality-gate.js";
import type { Candidate, CreativeBrief, SelectsCandidates } from "../runtime/artifacts/types.js";
import type { QualityGateSegment } from "../runtime/editorial/quality-gate.js";
import type { VisualQualityMeasurements } from "../runtime/connectors/ffmpeg-motion.js";

describe("quality gate", () => {
  it("marks audio-only visual quality not applicable without degrading it", () => {
    const result = applyQualityGateToSelects(selects([candidate("SEG_AUDIO", {
      media_kind: "audio",
      source_capabilities: { has_video: false, has_audio: true },
      quality_flags: ["preexisting_audio_flag"],
    })]), []);

    expect(result.candidates[0].quality_gate).toMatchObject({
      decision: "not_applicable",
      confidence: "not_applicable",
      reasons: ["visual_quality_not_applicable_audio_only"],
    });
    expect(result.candidates[0].quality_flags).toEqual(["preexisting_audio_flag"]);
    expect(result.quality_gate?.counts).toEqual({ reject: 0, warn: 0, pass: 0, unmeasured: 0, not_applicable: 1 });
  });

  it("rejects obvious measured shake, blur, black crush, and blown highlights", () => {
    const rejects = [
      ["SEG_SHAKE", measurement({ shake: 0.9 })],
      ["SEG_BLUR", measurement({ sharpness: 0.1 })],
      ["SEG_BLACK", measurement({ black: 0.95 })],
      ["SEG_WHITE", measurement({ white: 0.95 })],
    ] as const;

    for (const [segmentId, visual_quality_measurements] of rejects) {
      const result = applyQualityGateToSelects(
        selects([
          candidate(segmentId, { editorial_signals: { semantic_cluster_id: "shared_cluster" } }),
          candidate(`${segmentId}_ALT`, { editorial_signals: { semantic_cluster_id: "shared_cluster" } }),
        ]),
        [
          segment(segmentId, { visual_quality_measurements }),
          segment(`${segmentId}_ALT`, { visual_quality_measurements: measurement({}) }),
        ],
      );

      expect(result.candidates[0].role, segmentId).toBe("reject");
      expect(result.candidates[0].quality_gate?.decision, segmentId).toBe("reject");
      expect(result.quality_gate?.counts.reject, segmentId).toBe(1);
    }
  });

  it("warns on reject-boundary values and passes below warning thresholds", () => {
    const boundary = applyQualityGateToSelects(
      selects([candidate("SEG_BOUNDARY")]),
      [
        segment("SEG_BOUNDARY", {
          visual_quality_measurements: measurement({
            shake: DEFAULT_QUALITY_GATE_THRESHOLDS.shake_reject_above,
            sharpness: DEFAULT_QUALITY_GATE_THRESHOLDS.sharpness_reject_below,
            black: DEFAULT_QUALITY_GATE_THRESHOLDS.exposure_crush_reject_above,
            white: DEFAULT_QUALITY_GATE_THRESHOLDS.exposure_clip_reject_above,
          }),
        }),
      ],
    );

    expect(boundary.candidates[0].role).toBe("support");
    expect(boundary.candidates[0].quality_gate?.decision).toBe("warn");

    const pass = applyQualityGateToSelects(
      selects([candidate("SEG_PASS")]),
      [
        segment("SEG_PASS", {
          visual_quality_measurements: measurement({
            shake: DEFAULT_QUALITY_GATE_THRESHOLDS.shake_warn_above - 0.01,
            sharpness: DEFAULT_QUALITY_GATE_THRESHOLDS.sharpness_warn_below + 0.01,
            black: DEFAULT_QUALITY_GATE_THRESHOLDS.exposure_crush_warn_above - 0.01,
            white: DEFAULT_QUALITY_GATE_THRESHOLDS.exposure_clip_warn_above - 0.01,
          }),
        }),
      ],
    );

    expect(pass.candidates[0].quality_gate?.decision).toBe("pass");
  });

  it("downgrades reject to warn for must-have and unique-cluster recall protection", () => {
    const brief: CreativeBrief = {
      version: "1",
      project_id: "quality-gate-test",
      project: { id: "quality-gate-test", title: "test", strategy: "test", runtime_target_sec: 30 },
      message: { primary: "test" },
      emotion_curve: ["hook"],
      must_have: ["hands preparing"],
      must_avoid: [],
    } as CreativeBrief;

    const mustHave = applyQualityGateToSelects(
      selects([
        candidate("SEG_MUST", {
          why_it_matches: "hands preparing the product",
          editorial_signals: { semantic_cluster_id: "shared_cluster" },
        }),
        candidate("SEG_ALT", { editorial_signals: { semantic_cluster_id: "shared_cluster" } }),
      ]),
      [
        segment("SEG_MUST", { visual_quality_measurements: measurement({ sharpness: 0.1 }) }),
        segment("SEG_ALT", { visual_quality_measurements: measurement({}) }),
      ],
      { brief },
    );

    expect(mustHave.candidates[0].role).toBe("support");
    expect(mustHave.candidates[0].quality_gate?.decision).toBe("warn");
    expect(mustHave.candidates[0].quality_gate?.protected_by).toContain("brief_must_have_match");

    const uniqueCluster = applyQualityGateToSelects(
      selects([
        candidate("SEG_UNIQUE", { editorial_signals: { semantic_cluster_id: "unique_scene" } }),
        candidate("SEG_OTHER", { editorial_signals: { semantic_cluster_id: "other_scene" } }),
        candidate("SEG_OTHER_2", { editorial_signals: { semantic_cluster_id: "other_scene" } }),
      ]),
      [
        segment("SEG_UNIQUE", { visual_quality_measurements: measurement({ white: 0.95 }) }),
        segment("SEG_OTHER", { visual_quality_measurements: measurement({}) }),
        segment("SEG_OTHER_2", { visual_quality_measurements: measurement({}) }),
      ],
    );

    expect(uniqueCluster.candidates[0].role).toBe("support");
    expect(uniqueCluster.candidates[0].quality_gate?.decision).toBe("warn");
    expect(uniqueCluster.candidates[0].quality_gate?.protected_by).toContain("unique_cluster:unique_scene");
  });

  it("marks candidates with no measurement, appraiser score, or quality flag as unmeasured low-confidence", () => {
    const result = applyQualityGateToSelects(selects([candidate("SEG_UNKNOWN")]), [segment("SEG_UNKNOWN")]);

    expect(result.candidates[0].role).toBe("support");
    expect(result.candidates[0].quality_confidence).toBe("low");
    expect(result.candidates[0].quality_flags).toContain("quality_confidence_low");
    expect(result.candidates[0].quality_gate).toMatchObject({
      decision: "unmeasured",
      confidence: "low",
      reasons: ["visual_quality_unmeasured"],
    });
    expect(result.quality_gate?.counts.unmeasured).toBe(1);
  });

  it("uses appraiser scores as fallback when deterministic measurements are absent", () => {
    const result = applyQualityGateToSelects(
      selects([
        candidate("SEG_APPRAISER", { editorial_signals: { semantic_cluster_id: "shared_cluster" } }),
        candidate("SEG_ALT", { editorial_signals: { semantic_cluster_id: "shared_cluster" } }),
      ]),
      [
        segment("SEG_APPRAISER", {
          visual_quality: {
            scores: {
              composition_score: 0.1,
              subject_prominence: 0.1,
            },
          },
        }),
        segment("SEG_ALT", { visual_quality_measurements: measurement({}) }),
      ],
    );

    expect(result.candidates[0].role).toBe("reject");
    expect(result.candidates[0].quality_gate?.confidence).toBe("appraiser");
    expect(result.candidates[0].quality_gate?.reasons).toContain(
      "appraiser_composition_and_subject_below_reject",
    );
  });

  it("ignores stale appraiser scores when the appraiser artifact is explicitly skipped", () => {
    const result = applyQualityGateToSelects(
      selects([candidate("SEG_SKIPPED")]),
      [
        segment("SEG_SKIPPED", {
          visual_appraisal: {
            status: "skipped",
            skipped_reason: "no_image_capable_editorial_llm_runtime",
          },
          visual_quality: {
            scores: {
              composition_score: 0.1,
              subject_prominence: 0.1,
            },
          },
        }),
      ],
    );

    expect(result.candidates[0].role).toBe("support");
    expect(result.candidates[0].quality_confidence).toBe("low");
    expect(result.candidates[0].quality_gate).toMatchObject({
      decision: "unmeasured",
      confidence: "low",
      reasons: ["visual_quality_unmeasured"],
    });
  });
});

function selects(candidates: Candidate[]): SelectsCandidates {
  return {
    version: "1",
    project_id: "quality-gate-test",
    candidates,
  };
}

function candidate(segmentId: string, overrides: Partial<Candidate> = {}): Candidate {
  return {
    segment_id: segmentId,
    asset_id: "AST_001",
    src_in_us: 0,
    src_out_us: 1_500_000,
    role: "support",
    why_it_matches: `candidate ${segmentId}`,
    risks: [],
    confidence: 0.8,
    ...overrides,
  };
}

function segment(segmentId: string, overrides: Partial<QualityGateSegment> = {}): QualityGateSegment {
  return {
    segment_id: segmentId,
    asset_id: "AST_001",
    summary: `segment ${segmentId}`,
    tags: ["shared", "test"],
    quality_flags: [],
    ...overrides,
  };
}

function measurement(overrides: {
  shake?: number;
  sharpness?: number;
  exposure?: number;
  black?: number;
  white?: number;
}): VisualQualityMeasurements {
  return {
    measured: true,
    connector_version: "ffmpeg-motion-test",
    method: "ffmpeg_sampled_signals",
    sample_fps: 4,
    max_width: 160,
    duration_us: 1_500_000,
    metrics_measured: { shake: true, sharpness: true, exposure: true },
    shake: {
      measured: true,
      score: overrides.shake ?? 0.1,
      sample_count: 4,
      bins: [{ start_us: 0, end_us: 1_500_000, energy: overrides.shake ?? 0.1 }],
      average_energy: overrides.shake ?? 0.1,
      peak_energy: overrides.shake ?? 0.1,
      peak_timestamp_us: 750_000,
    },
    sharpness: {
      measured: true,
      sharpness_score: overrides.sharpness ?? 0.8,
      blur_score: 1 - (overrides.sharpness ?? 0.8),
      method: "blurdetect",
      sample_count: 4,
    },
    exposure: {
      measured: true,
      exposure_score: overrides.exposure ?? 0.9,
      black_clip_ratio: overrides.black ?? 0.02,
      white_clip_ratio: overrides.white ?? 0.01,
      avg_luma: 120,
      underexposed: false,
      overexposed: false,
      sample_count: 4,
    },
  };
}
