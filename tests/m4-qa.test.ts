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
  checkDialogueTimelineAlignment,
  checkAvDrift,
  checkLoudnessTarget,
  checkAudioMixPolicy,
  checkResolutionSpec,
  checkDeterministicFinalOutput,
  checkFinalCaptionStructuralInvariants,
  checkPackageCompleteness,
  buildQaReport,
  getRequiredChecks,
  type QaCheckResult,
} from "../runtime/packaging/qa.js";
import type { AudioMixReport } from "../runtime/audio/mixer.js";

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

function validReviewReport() {
  return {
    visual_qa: {
      status: "verified" as const,
      score: 90,
      min_score: 70,
      issues: { total: 0, critical: 0, warning: 0, info: 0 },
      issue_summaries: [],
      deterministic_scan: {
        status: "verified" as const,
        duration_sec: 10,
        width: 1920,
        height: 1080,
        issues: [],
      },
    },
  };
}

function validGate10Options(overrides: Parameters<typeof checkGate10>[1] = {}) {
  return {
    reviewReport: validReviewReport(),
    ...overrides,
  };
}

// ── Gate 10 Tests ─────────────────────────────────────────────────

describe("Gate 10", () => {
  it("passes with valid state", () => {
    const result = checkGate10(validProjectState(), validGate10Options());
    expect(result.passed).toBe(true);
    expect(result.source_of_truth).toBe("engine_render");
    expect(result.errors).toHaveLength(0);
  });

  it("fails if not approved state", () => {
    const state = validProjectState();
    state.current_state = "blueprint_ready";
    const result = checkGate10(state, validGate10Options());
    expect(result.passed).toBe(false);
    expect(result.errors.some((e) => e.includes("approved"))).toBe(true);
  });

  it("passes for re-render of an already-packaged project", () => {
    const state = validProjectState();
    state.current_state = "packaged";
    const result = checkGate10(state, validGate10Options());
    expect(result.passed).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("fails if handoff not decided", () => {
    const state = validProjectState();
    state.handoff_resolution.status = "pending";
    const result = checkGate10(state, validGate10Options());
    expect(result.passed).toBe(false);
    expect(result.errors.some((e) => e.includes("decided"))).toBe(true);
  });

  it("fails if review_gate blocked", () => {
    const state = validProjectState();
    state.gates.review_gate = "blocked";
    const result = checkGate10(state, validGate10Options());
    expect(result.passed).toBe(false);
    expect(result.errors.some((e) => e.includes("review_gate"))).toBe(true);
  });

  it("returns correct source_of_truth for nle_finishing", () => {
    const state = validProjectState();
    state.handoff_resolution.source_of_truth_decision = "nle_finishing";
    const result = checkGate10(state, validGate10Options());
    expect(result.passed).toBe(true);
    expect(result.source_of_truth).toBe("nle_finishing");
  });

  it("autonomy:full defaults missing handoff_resolution to engine_render", () => {
    const state = validProjectState();
    delete (state as { handoff_resolution?: unknown }).handoff_resolution;

    const result = checkGate10(state, validGate10Options({
      autonomyMode: "full",
      decidedAt: "2026-03-22T01:02:03Z",
    }));

    expect(result.passed).toBe(true);
    expect(result.source_of_truth).toBe("engine_render");
    expect(result.auto_defaulted_handoff).toBe(true);
    expect(result.handoff_resolution?.status).toBe("decided");
    expect(result.handoff_resolution?.decided_by).toBe("auto:full_autonomy");
    expect(result.handoff_resolution?.source_of_truth_decision).toBe("engine_render");
  });

  it("skips missing caption_approval and music_cues checks", () => {
    const result = checkGate10(validProjectState(), validGate10Options({
      currentTimelineVersion: "timeline-v2",
      blueprint: {
        caption_policy: {
          source: "transcript",
        },
      },
      captionApproval: null,
      musicCues: null,
    }));

    expect(result.passed).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("fails if caption_approval is stale", () => {
    const result = checkGate10(validProjectState(), validGate10Options({
      currentTimelineVersion: "timeline-v2",
      blueprint: {
        caption_policy: {
          source: "transcript",
        },
      },
      captionApproval: {
        base_timeline_version: "timeline-v1",
        approval: {
          status: "approved",
        },
      },
    }));

    expect(result.passed).toBe(false);
    expect(result.errors).toContain("caption_approval is stale");
  });

  it("fails if music_cues is stale", () => {
    const result = checkGate10(validProjectState(), validGate10Options({
      currentTimelineVersion: "timeline-v2",
      musicCues: {
        base_timeline_version: "timeline-v1",
      },
    }));

    expect(result.passed).toBe(false);
    expect(result.errors).toContain("music_cues is stale");
  });

  it("fails when review_report visual QA is not verified", () => {
    const result = checkGate10(validProjectState(), {
      reviewReport: {
        visual_qa: {
          status: "blocked",
          reason: "render_missing",
          min_score: 70,
          issues: { total: 0, critical: 0, warning: 0, info: 0 },
          issue_summaries: [],
          deterministic_scan: {
            status: "verified",
            issues: [],
          },
        },
      },
    });

    expect(result.passed).toBe(false);
    expect(result.errors).toContain('review_report.visual_qa.status must be "verified", got "blocked"');
  });

  it("accepts canonical audio-only visual QA as not applicable", () => {
    const result = checkGate10(validProjectState(), {
      visualQaApplicable: false,
      reviewReport: {
        visual_qa: {
          status: "not_applicable",
          reason: "audio_only_timeline",
          min_score: 70,
          issues: { total: 0, critical: 0, warning: 0, info: 0 },
          issue_summaries: [],
        },
      },
    });
    expect(result.passed).toBe(true);
  });

  it("does not accept not_applicable for a mixed or video timeline", () => {
    const result = checkGate10(validProjectState(), {
      visualQaApplicable: true,
      reviewReport: {
        visual_qa: {
          status: "not_applicable",
          reason: "audio_only_timeline",
          min_score: 70,
          issues: { total: 0, critical: 0, warning: 0, info: 0 },
          issue_summaries: [],
          deterministic_scan: {
            status: "verified",
            issues: [],
          },
        },
      },
    });
    expect(result.passed).toBe(false);
    expect(result.errors).toContain('review_report.visual_qa.status must be "verified", got "not_applicable"');
  });

  it("fails when review_report contains unresolved fatal issues", () => {
    const result = checkGate10(validProjectState(), validGate10Options({
      reviewReport: {
        ...validReviewReport(),
        fatal_issues: [
          {
            summary: "Opening beat contradicts the brief",
            severity: "fatal",
          },
        ],
      },
    }));

    expect(result.passed).toBe(false);
    expect(result.errors).toContain(
      "review_report contains 1 fatal issue(s); final package is blocked until they are resolved or explicitly approved with creative_override",
    );
  });

  it("allows review_report fatal issues only with creative_override approval", () => {
    const state = validProjectState();
    state.approval_record.status = "creative_override";
    const result = checkGate10(state, validGate10Options({
      reviewReport: {
        ...validReviewReport(),
        fatal_issues: [
          {
            summary: "Operator accepts this fatal issue as intentional",
            severity: "fatal",
          },
        ],
      },
    }));

    expect(result.passed).toBe(true);
  });

  it("does not let a visual QA waiver bypass an incomplete deterministic scan", () => {
    const result = checkGate10(validProjectState(), {
      reviewReport: {
        visual_qa: {
          status: "blocked",
          reason: "marlin_unavailable",
          min_score: 70,
          issues: { total: 0, critical: 0, warning: 0, info: 0 },
          issue_summaries: [],
          deterministic_scan: {
            status: "incomplete",
            reason: "ffmpeg_scan_failed",
            issues: [],
          },
        },
        visual_qa_waiver: true,
        visual_qa_waiver_reason: "Operator accepts model QA unavailability.",
      },
    });

    expect(result.passed).toBe(false);
    expect(result.errors).toContain(
      'review_report.visual_qa.deterministic_scan.status must be "verified", got "incomplete"',
    );
  });

  it("passes when review_report carries an explicit visual QA waiver", () => {
    const result = checkGate10(validProjectState(), {
      reviewReport: {
        visual_qa: {
          status: "blocked",
          reason: "render_missing",
          min_score: 70,
          issues: { total: 0, critical: 0, warning: 0, info: 0 },
          issue_summaries: [],
          deterministic_scan: {
            status: "verified",
            issues: [],
          },
        },
        visual_qa_waiver: true,
        visual_qa_waiver_reason: "Operator reviewed the final MP4 externally.",
      },
    });

    expect(result.passed).toBe(true);
  });

  it("fails closed when deterministic output QA is missing", () => {
    const result = checkGate10(validProjectState(), {
      reviewReport: {
        visual_qa: {
          status: "verified",
          score: 90,
          min_score: 70,
          issues: { total: 0, critical: 0, warning: 0, info: 0 },
          issue_summaries: [],
        },
      },
    });

    expect(result.passed).toBe(false);
    expect(result.errors).toContain(
      "review_report.visual_qa.deterministic_scan is missing",
    );
  });
});

describe("checkDeterministicFinalOutput", () => {
  it("blocks publication when the full-output scan is incomplete", () => {
    const checks = checkDeterministicFinalOutput({
      status: "incomplete",
      reason: "scanned 1.000s of 30.000s",
      issues: [],
    });
    expect(checks.find((check) => check.name === "final_decode_valid"))
      .toMatchObject({ passed: false });
  });

  it("projects a persistent inset into a blocking package QA check", () => {
    const checks = checkDeterministicFinalOutput({
      status: "blocked",
      duration_sec: 30,
      scanned_duration_sec: 30,
      width: 1080,
      height: 1920,
      issues: [{
        kind: "inset",
        severity: "blocking",
        detail: "persistent four-sided inset from 7.000s to 7.550s",
        start_sec: 7,
        end_sec: 7.55,
      }],
    });
    expect(checks.find((check) =>
      check.name === "unexpected_inset_region_absent"
    )).toMatchObject({ passed: false });
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

  it("fail - Japanese 12.0 CPS over 6.0 threshold", () => {
    // 10 chars over 20/24 ≈ 0.833 seconds = ~12.0 CPS (exceeds 6.0 limit)
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
    expect(result.details).toContain("exceeds 6.0");
  });

  it("allows speech-synchronous Japanese short-form captions up to 16 CPS", () => {
    const captions = [
      {
        caption_id: "SC_SHORT",
        text: "坂本｜プリキュアわかる？",
        timeline_in_frame: 0,
        timeline_duration_frames: 24,
      },
    ];
    const result = checkCaptionDensity(
      captions,
      30,
      "ja",
      "single-layer-speaker-separated-bold-outline-safe-area-ja",
    );
    expect(result.passed).toBe(true);
    expect(result.details).toContain("max: 11.25");
  });

  it("does not count a stacked speaker badge as subtitle body density", () => {
    const captions = [{
      caption_id: "SC_BADGE",
      text: "坂本｜あと あれだよね",
      timeline_in_frame: 0,
      timeline_duration_frames: 24,
    }];
    const result = checkCaptionDensity(
      captions,
      30,
      "ja",
      "bold-outline-speaker-separated-safe-area-ja",
    );
    expect(result.passed).toBe(true);
    expect(result.details).toContain("max: 10.00");
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

  it("treats density and line-length findings as acknowledged after caption approval", () => {
    expect(checkCaptionDensity([{
      caption_id: "SC_APPROVED",
      timeline_in_frame: 0,
      timeline_duration_frames: 30,
      text: "一行二十文字を超えていても人間が確認済みの字幕です",
    }], 30, "ja", "longform-event", { humanApproved: true })).toMatchObject({
      name: "caption_density_valid",
      passed: true,
    });
  });

  it("requires approval for sub-target dwell but never waives unreadable flashes", () => {
    const briefImpactCaption = [{
      caption_id: "SC_IMPACT",
      timeline_in_frame: 0,
      timeline_duration_frames: 15,
      text: "危機です",
    }];
    const unreadableFlash = [{
      caption_id: "SC_FLASH",
      timeline_in_frame: 0,
      timeline_duration_frames: 8,
      text: "一瞬",
    }];

    expect(checkCaptionDensity(
      briefImpactCaption,
      30,
      "ja",
      "social-short",
    ).passed).toBe(false);
    expect(checkCaptionDensity(
      briefImpactCaption,
      30,
      "ja",
      "social-short",
      { humanApproved: true },
    ).passed).toBe(true);
    const approvedFlash = checkCaptionDensity(
      unreadableFlash,
      30,
      "ja",
      "social-short",
      { humanApproved: true },
    );
    expect(approvedFlash.passed).toBe(false);
    expect(approvedFlash.details).toContain("non-waivable");
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

describe("checkDialogueTimelineAlignment", () => {
  it("passes when dialogue signal outside its timeline windows is under one frame", () => {
    const result = checkDialogueTimelineAlignment(12, 1000 / 30);
    expect(result.passed).toBe(true);
    expect(result.name).toBe("dialogue_timeline_alignment_valid");
  });

  it("fails when an adelay/atrim regression moves dialogue to the file head", () => {
    const result = checkDialogueTimelineAlignment(3330, 1000 / 30);
    expect(result.passed).toBe(false);
    expect(result.details).toContain("dialogue_signal_outside_timeline_windows");
    expect(result.details).toContain("3330.00");
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

// ── Resolution / Frame Size Tests ────────────────────────────────

describe("checkResolutionSpec", () => {
  const actual = {
    width: 1920,
    height: 1080,
    sar: "1:1",
    dar: "16:9",
    fps_num: 24,
    fps_den: 1,
    fps: 24,
  };
  const expected = {
    source: "timeline" as const,
    source_detail: "05_timeline/timeline.json#sequence",
    width: 1920,
    height: 1080,
    dar: "16:9",
    fps_num: 24,
    fps_den: 1,
    fps: 24,
    aspect_ratio: "16:9",
  };

  it("passes when measured frame metadata matches expected spec", () => {
    const result = checkResolutionSpec(actual, expected);
    expect(result.passed).toBe(true);
    expect(result.name).toBe("resolution_valid");
    expect(result.metrics.resolution_check).toBe("passed");
    expect(result.metrics.actual_video_frame).toEqual(actual);
    expect(result.metrics.expected_video_frame).toEqual(expected);
  });

  it("fails when measured frame size or display aspect ratio differs", () => {
    const result = checkResolutionSpec(
      { ...actual, width: 960, height: 540, dar: "16:9" },
      expected,
    );
    expect(result.passed).toBe(false);
    expect(result.metrics.resolution_check).toBe("failed");
    expect(result.metrics.resolution_mismatches).toEqual([
      "width expected=1920 actual=960",
      "height expected=1080 actual=540",
    ]);
  });

  it("records skipped only when no expected spec exists", () => {
    const result = checkResolutionSpec(actual, null);
    expect(result.passed).toBe(true);
    expect(result.metrics.resolution_check).toBe("skipped");
    expect(result.details).toContain("reason=no_expected_spec");
  });

  it("records blocked and fails when ffprobe cannot provide frame metadata", () => {
    const result = checkResolutionSpec(null, expected, "ffprobe failed: not found");
    expect(result.passed).toBe(false);
    expect(result.metrics.resolution_check).toBe("blocked");
    expect(result.details).toContain("ffprobe failed");
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
      "audio_mix_report",
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
      "audio_mix_report",
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

// ── Audio Mix Policy Tests ───────────────────────────────────────

function validAudioMixReport(hasBgm: boolean): AudioMixReport {
  const measurement = {
    input_i: "-20.00",
    input_tp: "-3.00",
    input_lra: "4.00",
    input_thresh: "-30.00",
    target_offset: "0.00",
  };
  if (!hasBgm) {
    return {
      version: "audio-mix-report/v1",
      has_bgm: false,
      strategy: "dialogue_only_mastering_v1",
      final_mastering: {
        loudness_target_lufs: -16,
        lra_target: 7,
        true_peak_target_dbtp: -1.5,
        premaster_measurement: measurement,
      },
    };
  }
  return {
    version: "audio-mix-report/v1",
    has_bgm: true,
    strategy: "waveform_sidechain_v1",
    final_mastering: {
      loudness_target_lufs: -16,
      lra_target: 7,
      true_peak_target_dbtp: -1.5,
      premaster_measurement: measurement,
    },
    bgm_reference_mastering: {
      loudness_target_lufs: -23,
      lra_target: 7,
      true_peak_target_dbtp: -2,
      source_measurement: measurement,
    },
    sidechain: {
      detector: "dialogue_waveform_rms",
      threshold: 0.03,
      ratio: 13,
      attack_ms: 80,
      release_ms: 180,
      base_gain_db: -16,
      requested_duck_gain_db: -24,
    },
  };
}

describe("checkAudioMixPolicy", () => {
  it("accepts explicit original-audio passthrough evidence", () => {
    const report: AudioMixReport = {
      version: "audio-mix-report/v1",
      has_bgm: false,
      strategy: "original_passthrough_v1",
      final_mastering: {
        applied: false,
        loudness_target_lufs: -16,
        lra_target: 7,
        true_peak_target_dbtp: -1.5,
        premaster_measurement: {
          input_i: "-23.61",
          input_tp: "-1.00",
          input_lra: "11.60",
          input_thresh: "-35.47",
          target_offset: "1.21",
        },
      },
    };

    expect(checkAudioMixPolicy(report, false).passed).toBe(true);
  });

  it("accepts multiple timeline-owned music assets without external re-add evidence", () => {
    const report: AudioMixReport = {
      version: "audio-mix-report/v1",
      has_bgm: true,
      strategy: "timeline_embedded_bgm_mastering_v1",
      bgm_ownership: { owner: "timeline_assembler", asset_ids: ["AST_A", "AST_B"] },
      final_mastering: {
        loudness_target_lufs: -16,
        lra_target: 7,
        true_peak_target_dbtp: -1.5,
        premaster_measurement: {
          input_i: "-18.00",
          input_tp: "-3.00",
          input_lra: "4.00",
          input_thresh: "-28.00",
          target_offset: "0.00",
        },
      },
    };
    expect(checkAudioMixPolicy(report, true).passed).toBe(true);
  });

  it("fails malformed timeline ownership evidence without throwing", () => {
    const malformed = {
      version: "audio-mix-report/v1",
      has_bgm: true,
      strategy: "timeline_embedded_bgm_mastering_v1",
      bgm_ownership: { owner: "timeline_assembler" },
      final_mastering: {
        loudness_target_lufs: -16,
        lra_target: 7,
        true_peak_target_dbtp: -1.5,
        premaster_measurement: {},
      },
    } as unknown as AudioMixReport;
    expect(() => checkAudioMixPolicy(malformed, true)).not.toThrow();
    expect(checkAudioMixPolicy(malformed, true).passed).toBe(false);
  });
  it("passes a reference-normalized waveform-sidechained BGM mix", () => {
    expect(checkAudioMixPolicy(validAudioMixReport(true), true).passed).toBe(true);
  });

  it("enforces quieter dialogue-first gains only when requested", () => {
    const loud = validAudioMixReport(true);
    loud.sidechain!.base_gain_db = -4;
    loud.sidechain!.requested_duck_gain_db = -12;
    expect(checkAudioMixPolicy(loud, true).passed).toBe(true);
    const social = checkAudioMixPolicy(loud, true, true);
    expect(social.passed).toBe(false);
    expect(social.details).toContain("dialogue-first BGM base gain");
  });

  it("fails when a BGM mix lacks waveform sidechain evidence", () => {
    const report = validAudioMixReport(true);
    delete report.sidechain;
    const result = checkAudioMixPolicy(report, true);
    expect(result.passed).toBe(false);
    expect(result.details).toContain("dialogue waveform");
  });

  it("passes a final-mastered dialogue-only mix", () => {
    expect(checkAudioMixPolicy(validAudioMixReport(false), false).passed).toBe(true);
  });

  it("fails closed when the report is missing", () => {
    expect(checkAudioMixPolicy(null, true)).toMatchObject({
      name: "audio_mix_policy_valid",
      passed: false,
    });
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
    expect(engineChecks).toContain("dialogue_timeline_alignment_valid");
    expect(engineChecks).toContain("audio_mix_policy_valid");
    // nle_finishing does not include those but has supplied_export_probe_valid
    expect(nleChecks).not.toContain("caption_density_valid");
    expect(nleChecks).toContain("supplied_export_probe_valid");
  });
});

describe("final caption structural QA", () => {
  it("does not let human approval hide a protected reveal that starts early", () => {
    const result = checkFinalCaptionStructuralInvariants([{
      caption_id: "SC_1",
      asset_id: "AST_1",
      segment_id: "SEG_1",
      timeline_in_frame: 30,
      timeline_duration_frames: 30,
      text: "価値",
      transcript_ref: "TR_1",
      transcript_item_ids: ["ITEM_1"],
      source: "transcript",
      styling_class: "social-short",
      metrics: { dwell_ms: 1000, cps: 2 },
      reveal_timing: {
        anchor_id: "A1",
        role: "payoff",
        anchor_text: "価値",
        status: "protected",
        source: "word_timing",
        anchor_frame: 30,
        audio_first_frames: 1,
        original_timeline_in_frame: 30,
      },
    }], 30, "ja");

    expect(result).toMatchObject({
      name: "caption_final_invariants_valid",
      passed: false,
    });
    expect(result.details).toContain("premature_protected_reveal");
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
