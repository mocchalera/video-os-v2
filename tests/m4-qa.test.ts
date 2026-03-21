/**
 * M4 QA Tests — Gate 10, QA Checks, QA Report, Manifest
 *
 * Unit-level tests for the packaging pipeline's validation layer:
 * - Gate 10 source-of-truth preconditions
 * - Individual QA metric checks (caption density, alignment, occupancy, drift, loudness, completeness)
 * - QA report assembly
 * - Manifest projection hash determinism
 */

import { describe, it, expect } from "vitest";

import {
  checkGate10,
  type Gate10Check,
} from "../runtime/packaging/gate10.js";

import {
  checkCaptionDensity,
  checkCaptionAlignment,
  checkDialogueOccupancy,
  checkAvDrift,
  checkLoudnessTarget,
  checkPackageCompleteness,
  buildQaReport,
  getRequiredChecks,
  type QaCheckResult,
} from "../runtime/packaging/qa.js";

import {
  computePackagingProjectionHash,
} from "../runtime/packaging/manifest.js";

// ── Helpers ───────────────────────────────────────────────────────

function validProjectState() {
  return {
    current_state: "approved",
    approval_record: { status: "clean" },
    handoff_resolution: {
      handoff_id: "HND_0001_20260321T100000Z",
      status: "decided",
      source_of_truth_decision: "engine_render",
    },
    gates: { review_gate: "open" },
  };
}

// ── Gate 10 Tests ─────────────────────────────────────────────────

describe("Gate 10", () => {
  it("passes with valid state", () => {
    const result = checkGate10(validProjectState());
    expect(result.passed).toBe(true);
    expect(result.source_of_truth).toBe("engine_render");
    expect(result.errors).toHaveLength(0);
  });

  it("fails if not approved state", () => {
    const state = validProjectState();
    state.current_state = "blueprint_ready";
    const result = checkGate10(state);
    expect(result.passed).toBe(false);
    expect(result.errors.some((e) => e.includes("approved"))).toBe(true);
  });

  it("fails if handoff not decided", () => {
    const state = validProjectState();
    state.handoff_resolution.status = "pending";
    const result = checkGate10(state);
    expect(result.passed).toBe(false);
    expect(result.errors.some((e) => e.includes("decided"))).toBe(true);
  });

  it("fails if review_gate blocked", () => {
    const state = validProjectState();
    state.gates.review_gate = "blocked";
    const result = checkGate10(state);
    expect(result.passed).toBe(false);
    expect(result.errors.some((e) => e.includes("review_gate"))).toBe(true);
  });

  it("returns correct source_of_truth for nle_finishing", () => {
    const state = validProjectState();
    state.handoff_resolution.source_of_truth_decision = "nle_finishing";
    const result = checkGate10(state);
    expect(result.passed).toBe(true);
    expect(result.source_of_truth).toBe("nle_finishing");
  });
});

// ── Caption Density Tests ─────────────────────────────────────────

describe("checkCaptionDensity", () => {
  it("pass - Japanese 5.2 CPS under 10.0 threshold", () => {
    // 10 chars over ~1.92 seconds (46 frames at 24fps) = ~5.2 CPS
    const captions = [
      {
        caption_id: "SC_001",
        text: "ここで静かになる", // 8 chars
        timeline_in_frame: 0,
        timeline_duration_frames: 37, // 8 / (37/24) ≈ 5.19 CPS
      },
    ];
    const result = checkCaptionDensity(captions, 24, "ja");
    expect(result.passed).toBe(true);
    expect(result.name).toBe("caption_density_valid");
  });

  it("fail - Japanese 12.0 CPS over 10.0 threshold", () => {
    // 12 chars over 1 second (24 frames at 24fps) = 12.0 CPS
    const captions = [
      {
        caption_id: "SC_002",
        text: "ここで静かになるために", // 10 chars
        timeline_in_frame: 0,
        timeline_duration_frames: 20, // 10 / (20/24) ≈ 12.0 CPS
      },
    ];
    const result = checkCaptionDensity(captions, 24, "ja");
    expect(result.passed).toBe(false);
    expect(result.details).toContain("exceeds 10.0");
  });

  it("fail - overlapping captions", () => {
    const captions = [
      {
        caption_id: "SC_A",
        text: "First line",
        timeline_in_frame: 0,
        timeline_duration_frames: 48, // ends at frame 48
      },
      {
        caption_id: "SC_B",
        text: "Second line",
        timeline_in_frame: 24, // starts at frame 24 → overlap
        timeline_duration_frames: 48,
      },
    ];
    const result = checkCaptionDensity(captions, 24, "en");
    expect(result.passed).toBe(false);
    expect(result.details).toContain("Overlap");
  });
});

// ── Caption Alignment Tests ───────────────────────────────────────

describe("checkCaptionAlignment", () => {
  it("pass - captions with transcript_item_ids", () => {
    const captions = [
      {
        caption_id: "SC_001",
        source: "transcript",
        transcript_item_ids: ["TI_001"],
      },
      {
        caption_id: "SC_002",
        source: "authored",
        // authored captions don't need transcript_item_ids
      },
    ];
    const result = checkCaptionAlignment(captions);
    expect(result.passed).toBe(true);
    expect(result.name).toBe("caption_alignment_valid");
  });

  it("fail - transcript source but no transcript_item_ids", () => {
    const captions = [
      {
        caption_id: "SC_003",
        source: "transcript",
        // missing transcript_item_ids
      },
    ];
    const result = checkCaptionAlignment(captions);
    expect(result.passed).toBe(false);
    expect(result.details).toContain("missing transcript_item_ids");
  });
});

// ── Dialogue Occupancy Tests ──────────────────────────────────────

describe("checkDialogueOccupancy", () => {
  it("pass - ratio 0.82 above 0.65 floor", () => {
    const result = checkDialogueOccupancy(10000, 8200);
    expect(result.passed).toBe(true);
    expect(result.name).toBe("dialogue_occupancy_valid");
    expect(result.details).toContain("0.820");
  });

  it("fail - ratio 0.50 below 0.65 floor", () => {
    const result = checkDialogueOccupancy(10000, 5000);
    expect(result.passed).toBe(false);
    expect(result.details).toContain("0.500");
    expect(result.details).toContain("< 0.65");
  });
});

// ── A/V Drift Tests ──────────────────────────────────────────────

describe("checkAvDrift", () => {
  it("pass - delta 8ms under 41.67ms frame duration at 24fps", () => {
    const frameDurationMs = 1000 / 24; // ≈ 41.67ms
    const result = checkAvDrift(10000, 10008, frameDurationMs);
    expect(result.passed).toBe(true);
    expect(result.name).toBe("av_drift_valid");
  });

  it("fail - delta 100ms", () => {
    const frameDurationMs = 1000 / 24; // ≈ 41.67ms
    const result = checkAvDrift(10000, 10100, frameDurationMs);
    expect(result.passed).toBe(false);
    expect(result.details).toContain("100.00ms");
  });
});

// ── Loudness Target Tests ─────────────────────────────────────────

describe("checkLoudnessTarget", () => {
  it("pass - -15.9 LUFS, -1.8 dBTP", () => {
    const result = checkLoudnessTarget(-15.9, -1.8);
    expect(result.passed).toBe(true);
    expect(result.name).toBe("loudness_target_valid");
  });

  it("fail - LUFS too low at -18.0", () => {
    const result = checkLoudnessTarget(-18.0, -1.8);
    expect(result.passed).toBe(false);
    expect(result.details).toContain("-18.0");
    expect(result.details).toContain("below -17.0");
  });

  it("fail - true peak too high at -1.0 dBTP", () => {
    const result = checkLoudnessTarget(-16.0, -1.0);
    expect(result.passed).toBe(false);
    expect(result.details).toContain("-1.0");
    expect(result.details).toContain("exceeds -1.5");
  });
});

// ── Package Completeness Tests ────────────────────────────────────

describe("checkPackageCompleteness", () => {
  it("pass - engine_render with all required artifacts", () => {
    const artifacts = new Set([
      "final_video",
      "qa_report",
      "raw_video",
      "raw_dialogue",
      "final_mix",
      "srt_sidecar",
      "vtt_sidecar",
    ]);
    const result = checkPackageCompleteness(
      "engine_render",
      { source: "transcript", delivery_mode: "sidecar" },
      artifacts,
    );
    expect(result.passed).toBe(true);
    expect(result.name).toBe("package_completeness_valid");
  });

  it("fail - engine_render missing final_mix", () => {
    const artifacts = new Set([
      "final_video",
      "qa_report",
      "raw_video",
      "raw_dialogue",
      // final_mix missing
    ]);
    const result = checkPackageCompleteness(
      "engine_render",
      { source: "none", delivery_mode: "burn_in" },
      artifacts,
    );
    expect(result.passed).toBe(false);
    expect(result.details).toContain("final_mix");
  });

  it("pass - nle_finishing with only final_video + qa_report", () => {
    const artifacts = new Set([
      "final_video",
      "qa_report",
    ]);
    const result = checkPackageCompleteness(
      "nle_finishing",
      { source: "none", delivery_mode: "burn_in" },
      artifacts,
    );
    expect(result.passed).toBe(true);
  });
});

// ── Required Checks by Profile ────────────────────────────────────

describe("getRequiredChecks", () => {
  it("engine_render has more checks than nle_finishing", () => {
    const engineChecks = getRequiredChecks("engine_render");
    const nleChecks = getRequiredChecks("nle_finishing");
    expect(engineChecks.length).toBeGreaterThanOrEqual(7);
    expect(nleChecks.length).toBeGreaterThanOrEqual(6);
    // engine_render includes caption_density_valid and dialogue_occupancy_valid
    expect(engineChecks).toContain("caption_density_valid");
    expect(engineChecks).toContain("dialogue_occupancy_valid");
    // nle_finishing does not include those but has supplied_export_probe_valid
    expect(nleChecks).not.toContain("caption_density_valid");
    expect(nleChecks).toContain("supplied_export_probe_valid");
  });
});

// ── QA Report Tests ───────────────────────────────────────────────

describe("buildQaReport", () => {
  it("with all passing checks: passed=true", () => {
    const checks: QaCheckResult[] = [
      { name: "timeline_schema_valid", passed: true, details: "ok" },
      { name: "caption_density_valid", passed: true, details: "ok" },
      { name: "loudness_target_valid", passed: true, details: "ok" },
    ];
    const report = buildQaReport(
      "test-project",
      "engine_render",
      checks,
      { integrated_lufs: -16.0, true_peak_dbtp: -1.8 },
      { final_video: "07_package/video/final.mp4" },
    );
    expect(report.passed).toBe(true);
    expect(report.project_id).toBe("test-project");
    expect(report.source_of_truth).toBe("engine_render");
    expect(report.qa_profile).toBe("engine_render");
    expect(report.version).toBe("1.0.0");
    expect(report.checks).toHaveLength(3);
  });

  it("with one failing check: passed=false", () => {
    const checks: QaCheckResult[] = [
      { name: "timeline_schema_valid", passed: true, details: "ok" },
      { name: "loudness_target_valid", passed: false, details: "too quiet" },
    ];
    const report = buildQaReport(
      "test-project",
      "nle_finishing",
      checks,
      { integrated_lufs: -18.0 },
      {},
    );
    expect(report.passed).toBe(false);
    expect(report.qa_profile).toBe("nle_finishing");
  });
});

// ── Manifest Projection Hash Tests ────────────────────────────────

describe("computePackagingProjectionHash", () => {
  it("deterministic - same inputs produce same hash", () => {
    const components = {
      captionApprovalHash: "abc123",
      musicCuesHash: "def456",
      renderDefaultsHash: "ghi789",
    };
    const hash1 = computePackagingProjectionHash(components);
    const hash2 = computePackagingProjectionHash(components);
    expect(hash1).toBe(hash2);
    expect(typeof hash1).toBe("string");
    expect(hash1.length).toBe(64); // sha256 hex length
  });

  it("changes with different inputs", () => {
    const hash1 = computePackagingProjectionHash({
      captionApprovalHash: "abc123",
      musicCuesHash: "def456",
    });
    const hash2 = computePackagingProjectionHash({
      captionApprovalHash: "abc123",
      musicCuesHash: "DIFFERENT",
    });
    expect(hash1).not.toBe(hash2);
  });
});
