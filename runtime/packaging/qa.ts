/**
 * Post-render QA validation.
 *
 * Provides path-specific QA profiles for engine_render and nle_finishing,
 * with individual metric checks for caption density, caption alignment,
 * dialogue occupancy, A/V drift, audio-mix policy, loudness targets, and package
 * completeness.
 */

import type { AudioMixReport } from "../audio/mixer.js";
import type { MusicCuesDoc } from "../audio/music-cues.js";
import type { SfxCuesDoc } from "../audio/sfx-cues.js";
import { equivalentFrameRates } from "../../editor/shared/rational-timebase.js";
import {
  MIN_CAPTION_HARD_FLOOR_MS,
  MIN_CAPTION_TARGET_DWELL_MS,
} from "../caption/segmenter.js";
import type { DeterministicOutputQAResult } from "../review/deterministic-output-qa.js";
import type { DeterministicLayoutQAResult } from "../review/deterministic-layout-qa.js";
import type { SpeechCadenceQAResult } from "../review/speech-cadence-qa.js";
import type { CaptionDeliveryQAResult } from "../review/caption-delivery-qa.js";
import {
  validateFinalCaptionInvariants,
} from "../caption/final-invariants.js";
import type { CaptionDraftEntry } from "../caption/editorial.js";

// ── Types ──────────────────────────────────────────────────────────

export interface QaCheckResult {
  name: string;
  passed: boolean;
  details: string;
}

export type ResolutionCheckStatus = "passed" | "failed" | "skipped" | "blocked";

export interface VideoFrameMetrics {
  width: number;
  height: number;
  sar: string | null;
  dar: string | null;
  fps_num: number | null;
  fps_den: number | null;
  fps: number | null;
}

export interface ExpectedVideoFrameSpec {
  source: "package_settings" | "timeline" | "creative_brief";
  source_detail?: string;
  width?: number;
  height?: number;
  sar?: string | null;
  dar?: string | null;
  fps_num?: number | null;
  fps_den?: number | null;
  fps?: number | null;
  aspect_ratio?: string;
}

export interface ResolutionCheckMetrics {
  resolution_check: ResolutionCheckStatus;
  actual_video_frame?: VideoFrameMetrics;
  expected_video_frame?: ExpectedVideoFrameSpec;
  resolution_mismatches?: string[];
}

export interface QaReport {
  version: string;
  project_id: string;
  source_of_truth: "engine_render" | "nle_finishing";
  qa_profile: "engine_render" | "nle_finishing";
  passed: boolean;
  checks: QaCheckResult[];
  metrics: {
    caption_max_density?: number;
    dialogue_occupancy_ratio?: number;
    dialogue_outside_expected_ms?: number;
    dialogue_first_signal_ms?: number;
    dialogue_last_signal_ms?: number;
    expected_dialogue_start_ms?: number;
    expected_dialogue_end_ms?: number;
    av_duration_delta_ms?: number;
    av_drift_ms?: number;
    integrated_lufs?: number;
    true_peak_dbtp?: number;
    resolution_check?: ResolutionCheckStatus;
    actual_video_frame?: VideoFrameMetrics;
    expected_video_frame?: ExpectedVideoFrameSpec;
    resolution_mismatches?: string[];
    deterministic_output_qa?: DeterministicOutputQAResult;
    deterministic_layout_qa?: DeterministicLayoutQAResult;
    speech_cadence_qa?: SpeechCadenceQAResult;
    caption_delivery_qa?: CaptionDeliveryQAResult;
  };
  artifacts: {
    final_video?: string;
    final_mix?: string;
    audio_mix_report?: string;
    layout_snapshot?: string;
  };
  source_inputs_freshness?: {
    status: "fresh" | "stale";
    reason?: string;
    source_inputs_hash?: string;
    attestation_status?: "verified" | "live_only" | "not_applicable";
    warnings?: string[];
  };
}

export function checkDeterministicFinalOutput(
  result: DeterministicOutputQAResult | undefined,
): QaCheckResult[] {
  const issues = result?.issues ?? [];
  const summarize = (kind: "black" | "freeze" | "inset"): string => {
    const matching = issues.filter((issue) => issue.kind === kind);
    return matching.length === 0
      ? `no unexpected ${kind} region detected in the complete final output`
      : matching.map((issue) => issue.detail).join("; ");
  };
  return [
    {
      name: "final_decode_valid",
      passed: result !== undefined && result.status !== "incomplete",
      details: result
        ? `status=${result.status}` + (result.reason ? ` reason=${result.reason}` : "")
        : "deterministic full-output scan is missing",
    },
    {
      name: "unexpected_black_region_absent",
      passed: !issues.some((issue) => issue.kind === "black"),
      details: summarize("black"),
    },
    {
      name: "unexpected_freeze_region_absent",
      passed: !issues.some((issue) => issue.kind === "freeze"),
      details: summarize("freeze"),
    },
    {
      name: "unexpected_inset_region_absent",
      passed: !issues.some((issue) => issue.kind === "inset"),
      details: summarize("inset"),
    },
  ];
}

export function checkDeterministicLayoutQA(
  result: DeterministicLayoutQAResult | undefined,
): QaCheckResult[] {
  const issues = result?.issues ?? [];
  const has = (...codes: Array<DeterministicLayoutQAResult["issues"][number]["code"]>) =>
    issues.some((issue) => codes.includes(issue.code));
  const details = (
    ...codes: Array<DeterministicLayoutQAResult["issues"][number]["code"]>
  ): string => {
    const matching = issues.filter((issue) => codes.includes(issue.code));
    return matching.length > 0
      ? matching.map((issue) => issue.detail).join("; ")
      : "no blocking finding";
  };
  return [
    {
      name: "render_layout_evidence_complete",
      passed: result?.status !== "incomplete" && result !== undefined,
      details: result
        ? `status=${result.status} snapshot_sha256=${result.snapshot_sha256 ?? "missing"}`
        : "deterministic layout QA is missing",
    },
    {
      name: "caption_safe_area_valid",
      passed: !has("caption_outside_safe_area", "glyph_clipped"),
      details: details("caption_outside_safe_area", "glyph_clipped"),
    },
    {
      name: "caption_font_glyphs_valid",
      passed: !has("font_fallback", "missing_glyph"),
      details: details("font_fallback", "missing_glyph"),
    },
    {
      name: "single_speech_caption_layer_valid",
      passed: !has("duplicate_speech_caption_layer"),
      details: details("duplicate_speech_caption_layer"),
    },
    {
      name: "caption_visual_collision_absent",
      passed: !has("caption_visual_collision"),
      details: details("caption_visual_collision"),
    },
    {
      name: "end_state_valid",
      passed: !has("end_card_hold_invalid", "final_frame_state_invalid"),
      details: details("end_card_hold_invalid", "final_frame_state_invalid"),
    },
  ];
}

export function checkFinalCaptionStructuralInvariants(
  captions: CaptionDraftEntry[],
  fps: number,
  language: string,
): QaCheckResult {
  const blocking = validateFinalCaptionInvariants(captions, fps, language)
    .filter((issue) => issue.severity === "block");
  return {
    name: "caption_final_invariants_valid",
    passed: blocking.length === 0,
    details: blocking.length === 0
      ? "final caption durations, separation, metrics, and reveal anchors are valid"
      : blocking.map((issue) => `${issue.code}:${issue.caption_id}`).join("; "),
  };
}

// ── Caption Density ────────────────────────────────────────────────

/**
 * Check caption density:
 * - Japanese: CPS (characters per second) <= 10.0
 * - English: WPS (words per second) <= 4.5
 * - No overlapping captions
 * - All durations must be positive
 */
export function checkCaptionDensity(
  captions: Array<{
    caption_id: string;
    text: string;
    timeline_in_frame: number;
    timeline_duration_frames: number;
  }>,
  fps: number,
  language: string,
  stylingClass?: string,
  options: { humanApproved?: boolean } = {},
): QaCheckResult {
  const blockingErrors: string[] = [];
  const advisoryErrors: string[] = [];
  let maxDensity = 0;

  for (const cap of captions) {
    // Positive duration check
    if (cap.timeline_duration_frames <= 0) {
      blockingErrors.push(
        `${cap.caption_id}: non-positive duration (${cap.timeline_duration_frames} frames)`,
      );
      continue;
    }

    const durationSec = cap.timeline_duration_frames / fps;
    const dwellMs = durationSec * 1000;
    if (dwellMs < MIN_CAPTION_HARD_FLOOR_MS) {
      blockingErrors.push(
        `${cap.caption_id}: dwell ${dwellMs.toFixed(0)} ms is below the non-waivable ${MIN_CAPTION_HARD_FLOOR_MS} ms safety floor`,
      );
    } else if (dwellMs < MIN_CAPTION_TARGET_DWELL_MS) {
      advisoryErrors.push(
        `${cap.caption_id}: dwell ${dwellMs.toFixed(0)} ms is below the ${MIN_CAPTION_TARGET_DWELL_MS} ms readability target`,
      );
    }

    // Both languages use CPS (characters per second) aligned with line-breaker policy
    // Speaker-separated presets render the leading label as a small stacked
    // badge, not as part of the readable subtitle body. Density and line-width
    // checks must measure what the viewer reads as the caption sentence.
    const visibleText = cap.text.replace(/^(?:AI|画面|坂本)[｜|]/, "");
    const charCount = visibleText.length;
    const cps = charCount / durationSec;
    if (cps > maxDensity) maxDensity = cps;

    const japanese = language === "ja" || language === "jp" || language.startsWith("ja-");
    const shortFormOutline = japanese && Boolean(
      stylingClass &&
      /(?:sns-vertical|speaker-separated.*outline|outline.*speaker-separated|social-short)/i.test(stylingClass),
    );
    // Keep the conservative long-form Japanese limit unchanged. Dialogue-led
    // shorts use brief, speech-synchronous bursts and need a separate ceiling;
    // applying the long-form 6 CPS gate makes ordinary one-second reactions
    // impossible even when the typography is large and the line is short.
    const cpsLimit = japanese ? (shortFormOutline ? 16.0 : 6.0) : 15.0;
    if (cps > cpsLimit) {
      advisoryErrors.push(
        `${cap.caption_id}: CPS ${cps.toFixed(2)} exceeds ${cpsLimit.toFixed(1)} limit`,
      );
    }

    const maxCharsPerLine = shortFormOutline ? 13 : japanese ? 20 : 42;
    for (const line of visibleText.split("\n")) {
      if ([...line].length > maxCharsPerLine) {
        advisoryErrors.push(
          `${cap.caption_id}: line length ${[...line].length} exceeds ${maxCharsPerLine} character layout limit`,
        );
      }
    }
  }

  // Check for overlapping captions
  const sorted = [...captions].sort(
    (a, b) => a.timeline_in_frame - b.timeline_in_frame,
  );
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    const curr = sorted[i];
    const prevEnd = prev.timeline_in_frame + prev.timeline_duration_frames;
    if (prevEnd > curr.timeline_in_frame) {
      blockingErrors.push(
        `Overlap: ${prev.caption_id} ends at frame ${prevEnd}, ` +
        `${curr.caption_id} starts at frame ${curr.timeline_in_frame}`,
      );
    }
  }

  const errors = options.humanApproved
    ? blockingErrors
    : [...blockingErrors, ...advisoryErrors];
  return {
    name: "caption_density_valid",
    passed: errors.length === 0,
    details:
      errors.length === 0
        ? options.humanApproved && advisoryErrors.length > 0
          ? `Human-approved caption layout (${advisoryErrors.length} density/line finding(s) acknowledged; max: ${maxDensity.toFixed(2)} CPS)`
          : `Caption density OK (max: ${maxDensity.toFixed(2)})`
        : errors.join("; "),
  };
}

// ── Caption Alignment ──────────────────────────────────────────────

/**
 * Transcript-backed captions must have transcript_item_ids.
 */
export function checkCaptionAlignment(
  captions: Array<{
    caption_id: string;
    source: string;
    transcript_item_ids?: string[];
  }>,
): QaCheckResult {
  const errors: string[] = [];

  for (const cap of captions) {
    if (cap.source === "transcript") {
      if (
        !cap.transcript_item_ids ||
        cap.transcript_item_ids.length === 0
      ) {
        errors.push(
          `${cap.caption_id}: transcript-backed caption missing transcript_item_ids`,
        );
      }
    }
  }

  return {
    name: "caption_alignment_valid",
    passed: errors.length === 0,
    details:
      errors.length === 0
        ? `All transcript-backed captions have transcript_item_ids`
        : errors.join("; "),
  };
}

// ── Dialogue Occupancy ─────────────────────────────────────────────

/**
 * Ratio of non-silent audio within expected dialogue windows >= 0.65.
 */
export function checkDialogueOccupancy(
  dialogueWindowMs: number,
  observedNonSilentMs: number,
): QaCheckResult {
  if (dialogueWindowMs <= 0) {
    return {
      name: "dialogue_occupancy_valid",
      passed: true,
      details: "No dialogue windows to check",
    };
  }

  const ratio = observedNonSilentMs / dialogueWindowMs;

  return {
    name: "dialogue_occupancy_valid",
    passed: ratio >= 0.65,
    details:
      ratio >= 0.65
        ? `Dialogue occupancy ratio ${ratio.toFixed(3)} >= 0.65`
        : `Dialogue occupancy ratio ${ratio.toFixed(3)} < 0.65 threshold`,
  };
}

/**
 * The dialogue-only stem must not contain meaningful signal outside the
 * timeline windows that own dialogue. Duration parity cannot catch this class
 * of error: adelay followed by atrim(start=0), for example, keeps stream
 * lengths equal while moving speech to the head of the file.
 */
export function checkDialogueTimelineAlignment(
  observedOutsideExpectedMs: number | null | undefined,
  frameDurationMs: number,
): QaCheckResult {
  if (observedOutsideExpectedMs == null) {
    return {
      name: "dialogue_timeline_alignment_valid",
      passed: true,
      details: "not_applicable: dialogue-only timing measurement unavailable",
    };
  }

  const thresholdMs = frameDurationMs / 2;
  const passed = observedOutsideExpectedMs <= thresholdMs;
  return {
    name: "dialogue_timeline_alignment_valid",
    passed,
    details: passed
      ? `outside_expected_ms=${observedOutsideExpectedMs.toFixed(2)} threshold_ms=${thresholdMs.toFixed(2)}`
      : `outside_expected_ms=${observedOutsideExpectedMs.toFixed(2)} threshold_ms=${thresholdMs.toFixed(2)} reason=dialogue_signal_outside_timeline_windows`,
  };
}

// ── A/V Drift ──────────────────────────────────────────────────────

/**
 * Duration delta between video and audio must be at most half a frame.
 * This verifies stream parity, not content or lip sync; content placement is
 * checked separately by checkDialogueTimelineAlignment.
 */
export function checkAvDrift(
  videoDurationMs: number,
  audioDurationMs: number,
  frameDurationMs: number,
): QaCheckResult {
  const driftMs = Math.abs(videoDurationMs - audioDurationMs);
  const thresholdMs = frameDurationMs / 2;

  return {
    name: "av_drift_valid",
    passed: driftMs <= thresholdMs,
    details:
      driftMs <= thresholdMs
        ? `A/V duration delta ${driftMs.toFixed(2)}ms <= half-frame ${thresholdMs.toFixed(2)}ms`
        : `A/V duration delta ${driftMs.toFixed(2)}ms > half-frame ${thresholdMs.toFixed(2)}ms`,
  };
}

// ── Loudness Target ────────────────────────────────────────────────

/**
 * Loudness target: -17.0 <= LUFS <= -15.0, true peak <= -1.5 dBTP.
 */
export function checkLoudnessTarget(
  integratedLufs: number,
  truePeakDbtp: number,
): QaCheckResult {
  const errors: string[] = [];

  if (integratedLufs < -17.0) {
    errors.push(
      `Integrated LUFS ${integratedLufs.toFixed(1)} below -17.0`,
    );
  }
  if (integratedLufs > -15.0) {
    errors.push(
      `Integrated LUFS ${integratedLufs.toFixed(1)} above -15.0`,
    );
  }
  if (truePeakDbtp > -1.5) {
    errors.push(
      `True peak ${truePeakDbtp.toFixed(1)} dBTP exceeds -1.5 dBTP`,
    );
  }

  return {
    name: "loudness_target_valid",
    passed: errors.length === 0,
    details:
      errors.length === 0
        ? `Loudness OK: ${integratedLufs.toFixed(1)} LUFS, ${truePeakDbtp.toFixed(1)} dBTP`
        : errors.join("; "),
  };
}

// ── Audio Mix Policy ──────────────────────────────────────────────

/**
 * Validate that engine-render audio used the production mixing contract.
 * Final loudness is independently measured by checkLoudnessTarget; this check
 * proves how the mix was made (reference normalization, waveform ducking, MA).
 */
export function checkAudioMixPolicy(
  report: AudioMixReport | null | undefined,
  expectedHasBgm: boolean,
  requireDialogueFirst = false,
  expectedMusicCues?: MusicCuesDoc | null,
  expectedSfxCues?: SfxCuesDoc | null,
): QaCheckResult {
  const errors: string[] = [];
  if (!report) {
    return {
      name: "audio_mix_policy_valid",
      passed: false,
      details: "audio-mix-report.json is missing or unreadable",
    };
  }

  const requireSharedPlan = expectedMusicCues?.version === "2.0.0"
    || expectedSfxCues?.version === "sfx-cues/v1";
  if (requireSharedPlan && report.version !== "audio-mix-report/v2") {
    errors.push(`version expected=audio-mix-report/v2 actual=${String(report.version)}`);
  } else if (
    !requireSharedPlan
    && report.version !== "audio-mix-report/v1"
    && report.version !== "audio-mix-report/v2"
  ) {
    errors.push(`unsupported audio mix report version=${String(report.version)}`);
  }
  if (report.has_bgm !== expectedHasBgm) {
    errors.push(`has_bgm expected=${expectedHasBgm} actual=${report.has_bgm}`);
  }
  const originalPassthrough = report.strategy === "original_passthrough_v1";
  if (originalPassthrough && report.final_mastering?.applied !== false) {
    errors.push("original passthrough must record final_mastering.applied=false");
  }
  if (!originalPassthrough && report.final_mastering?.loudness_target_lufs !== -16) {
    errors.push("final loudness target must be -16 LUFS");
  }
  if (!originalPassthrough && report.final_mastering?.true_peak_target_dbtp !== -1.5) {
    errors.push("final true-peak target must be -1.5 dBTP");
  }

  if (expectedHasBgm) {
    if (requireSharedPlan) {
      if (report.strategy !== "shared_audio_render_plan_v1") {
        errors.push(`strategy expected=shared_audio_render_plan_v1 actual=${report.strategy}`);
      }
      if (!report.plan_hash) errors.push("shared plan_hash is required");
      if (report.dialogue_finish_scope !== "a1_only" && report.dialogue_finish_scope !== "none") {
        errors.push(`dialogue_finish_scope must be a1_only or none (actual=${String(report.dialogue_finish_scope)})`);
      }
      if (report.mastering_count !== 1 || report.final_mastering?.applied !== true) {
        errors.push("shared BGM mix must record exactly one final mastering pass");
      }
      if (!report.sidechain_evidence || report.sidechain_evidence.per_cue.length === 0) {
        errors.push("shared BGM mix requires waveform sidechain evidence");
      }
      if (report.stems?.some((stem) => stem.role === "music" && stem.finish_applied)) {
        errors.push("A2 music stems must never receive dialogue finishing");
      }
      if (requireDialogueFirst) {
        for (const cue of report.cues ?? []) {
          if (cue.applied.base_gain_db > -10) {
            errors.push(
              `${cue.cue_id} dialogue-first base gain must be <= -10 dB (actual=${cue.applied.base_gain_db})`,
            );
          }
          if (cue.applied.duck_gain_db > -18) {
            errors.push(
              `${cue.cue_id} dialogue-first duck gain must be <= -18 dB (actual=${cue.applied.duck_gain_db})`,
            );
          }
        }
      }
      const reportCues = new Map((report.cues ?? []).map((cue) => [cue.cue_id, cue]));
      for (const cue of expectedMusicCues?.cues ?? []) {
        const actual = reportCues.get(cue.cue_id);
        if (!actual) {
          errors.push(`audio report cue missing=${cue.cue_id}`);
          continue;
        }
        const expectedRange = cue.source_range;
        const expectedTimeline = cue.timeline_range;
        const checks: Array<[string, unknown, unknown]> = [
          ["track_id", cue.track_id, actual.track_id],
          ["source_in_us", expectedRange?.in_us, actual.source_range_us.in_us],
          ["source_out_us", expectedRange?.out_us, actual.source_range_us.out_us],
          ["timeline_in_frame", expectedTimeline?.in_frame, actual.timeline_range.in_frame],
          ["timeline_out_frame", expectedTimeline?.out_frame, actual.timeline_range.out_frame],
          ["base_gain_db", cue.ducking.base_gain_db, actual.applied.base_gain_db],
          ["duck_gain_db", cue.ducking.duck_gain_db, actual.applied.duck_gain_db],
          ["attack_ms", cue.ducking.attack_ms, actual.applied.attack_ms],
          ["release_ms", cue.ducking.release_ms, actual.applied.release_ms],
          ["fade_in_ms", cue.fade_in_ms, actual.applied.fade_in_ms],
          ["fade_out_ms", cue.fade_out_ms, actual.applied.fade_out_ms],
          ["pack_manifest_hash", expectedMusicCues?.music_asset.pack_manifest_hash, actual.pins.pack_manifest_hash],
          ["full_mix_content_hash", expectedMusicCues?.music_asset.full_mix_content_hash, actual.pins.full_mix_content_hash],
          ["analysis_content_hash", expectedMusicCues?.music_asset.analysis_content_hash, actual.pins.analysis_content_hash],
        ];
        for (const [label, expected, value] of checks) {
          if (expected !== value) {
            errors.push(`${cue.cue_id}.${label} expected=${String(expected)} actual=${String(value)}`);
          }
        }
      }
      if ((report.cues?.length ?? 0) !== (expectedMusicCues?.cues.length ?? 0)) {
        errors.push("shared report cue count does not match music_cues");
      }
    }
    const embeddedBgm = report.strategy === "timeline_embedded_bgm_mastering_v1";
    if (!requireSharedPlan && report.strategy !== "waveform_sidechain_v1" && !embeddedBgm) {
      errors.push(`strategy expected=waveform_sidechain_v1 actual=${report.strategy}`);
    }
    if (embeddedBgm && (!Array.isArray(report.bgm_ownership?.asset_ids) || report.bgm_ownership.asset_ids.length === 0 || report.bgm_ownership.owner !== "timeline_assembler")) {
      errors.push("timeline-embedded BGM requires explicit timeline_assembler ownership evidence");
    }
    if (!requireSharedPlan && !embeddedBgm && report.bgm_reference_mastering?.loudness_target_lufs !== -23) {
      errors.push("BGM reference normalization target must be -23 LUFS");
    }
    if (!requireSharedPlan && !embeddedBgm && report.sidechain?.detector !== "dialogue_waveform_rms") {
      errors.push("BGM ducking detector must use the dialogue waveform");
    }
    if (!requireSharedPlan && !embeddedBgm && (!report.sidechain || report.sidechain.attack_ms <= 0 || report.sidechain.release_ms <= 0)) {
      errors.push("BGM sidechain attack/release must be positive");
    }
    if (!embeddedBgm && requireDialogueFirst && report.sidechain) {
      if (report.sidechain.base_gain_db > -10) {
        errors.push(`dialogue-first BGM base gain must be <= -10 dB (actual=${report.sidechain.base_gain_db})`);
      }
      if (report.sidechain.requested_duck_gain_db > -18) {
        errors.push(`dialogue-first BGM duck gain must be <= -18 dB (actual=${report.sidechain.requested_duck_gain_db})`);
      }
    }
  } else if (
    report.strategy !== "dialogue_only_mastering_v1"
    && !originalPassthrough
    && !(expectedSfxCues?.version === "sfx-cues/v1"
      && report.strategy === "shared_audio_render_plan_v1")
  ) {
    errors.push(`strategy expected=dialogue_only_mastering_v1 actual=${report.strategy}`);
  }

  return {
    name: "audio_mix_policy_valid",
    passed: errors.length === 0,
    details: errors.length === 0
      ? expectedHasBgm
        ? requireSharedPlan
          ? "Shared plan pins and applies cue gain/fade/duck values, waveform sidechain, A1-only finishing, and one final mastering pass"
        : requireDialogueFirst
          ? "BGM dialogue-first limited, reference-normalized, waveform-sidechained, and final-mastered"
          : "BGM reference-normalized, waveform-sidechained, and final-mastered"
        : originalPassthrough
          ? "Original-only dialogue level preserved without mastering"
          : "Dialogue-only mix final-mastered"
      : errors.join("; "),
  };
}

export function checkSfxMixPolicy(
  report: AudioMixReport | null | undefined,
  expectedSfxCues?: SfxCuesDoc | null,
): QaCheckResult {
  if (!expectedSfxCues) {
    return {
      name: "sfx_mix_policy_valid",
      passed: true,
      details: "not_applicable: SFX is not required for this project",
    };
  }
  const errors: string[] = [];
  if (!report) {
    errors.push("audio-mix-report.json is missing or unreadable");
  } else {
    if (report.version !== "audio-mix-report/v2") {
      errors.push(`version expected=audio-mix-report/v2 actual=${report.version}`);
    }
    if (report.strategy !== "shared_audio_render_plan_v1") {
      errors.push(`strategy expected=shared_audio_render_plan_v1 actual=${report.strategy}`);
    }
    if (report.has_sfx !== true) errors.push("has_sfx must be true");
    if (report.mastering_count !== 1 || report.final_mastering.applied !== true) {
      errors.push("formal A3 mix must record exactly one final mastering pass");
    }
    if (report.stems?.some((stem) => stem.role === "sfx" && stem.finish_applied)) {
      errors.push("A3 SFX stems must never receive dialogue finishing");
    }
    if (
      expectedSfxCues.decision_ref
      && report.input_hashes?.sound_design_decision
        !== expectedSfxCues.decision_ref.content_hash
    ) {
      errors.push("sound-design decision content hash does not match sfx_cues");
    }
    const evidence = new Map(
      (report.sfx_sidechain_evidence?.per_cue ?? [])
        .map((cue) => [cue.cue_id, cue]),
    );
    const actualCues = new Map((report.sfx_cues ?? []).map((cue) => [cue.cue_id, cue]));
    for (const cue of expectedSfxCues.cues) {
      const actual = actualCues.get(cue.cue_id);
      if (!actual) {
        errors.push(`audio report SFX cue missing=${cue.cue_id}`);
        continue;
      }
      for (const [label, expected, value] of [
        ["asset_id", cue.asset_id, actual.asset_id],
        ["semantic_role", cue.semantic_role, actual.semantic_role],
        ["timeline_in_frame", cue.trigger_frame, actual.timeline_range.in_frame],
        ["source_in_us", cue.source_range.in_us, actual.source_range_us.in_us],
        ["source_out_us", cue.source_range.out_us, actual.source_range_us.out_us],
        ["gain_db", cue.gain_db, actual.applied.gain_db],
        ["fade_in_ms", cue.fade_in_ms, actual.applied.fade_in_ms],
        ["fade_out_ms", cue.fade_out_ms, actual.applied.fade_out_ms],
        ["duck_group", cue.duck_group, actual.applied.duck_group],
        ["duck_gain_db", cue.ducking.duck_gain_db, actual.applied.duck_gain_db],
        ["attack_ms", cue.ducking.attack_ms, actual.applied.attack_ms],
        ["release_ms", cue.ducking.release_ms, actual.applied.release_ms],
        ["requested_tail_frames", cue.tail.max_frames, actual.tail_processing.requested_tail_frames],
        ["library_id", cue.asset_pin.library_id, actual.pins.library_id],
        ["library_version", cue.asset_pin.library_version, actual.pins.library_version],
        ["library_manifest_hash", cue.asset_pin.library_manifest_hash, actual.pins.library_manifest_hash],
        ["asset_content_hash", cue.asset_pin.asset_content_hash, actual.pins.asset_content_hash],
        ["asset_size_bytes", cue.asset_pin.asset_size_bytes, actual.pins.asset_size_bytes],
        ["rights_evidence_ref", cue.asset_pin.rights_evidence_ref, actual.pins.rights_evidence_ref],
        ["provenance_ref", cue.asset_pin.provenance_ref, actual.pins.provenance_ref],
      ] as Array<[string, unknown, unknown]>) {
        if (expected !== value) {
          errors.push(`${cue.cue_id}.${label} expected=${String(expected)} actual=${String(value)}`);
        }
      }
      if (
        JSON.stringify(actual.decision_pin)
        !== JSON.stringify(cue.decision_pin)
      ) {
        errors.push(`${cue.cue_id}.decision_pin does not match sfx_cues`);
      }
      if (actual.timeline_range.out_frame > actual.timeline_range.in_frame + cue.duration_frames + cue.tail.max_frames) {
        errors.push(`${cue.cue_id} applied tail exceeds the pinned maximum`);
      }
      if (actual.peak_dbtp !== null && actual.peak_dbtp > 0) {
        errors.push(`${cue.cue_id} A3 peak exceeds 0 dBTP`);
      }
      const sidechain = evidence.get(cue.cue_id);
      if (!sidechain) {
        errors.push(`${cue.cue_id} SFX sidechain evidence is missing`);
      } else if (
        cue.duck_group === "dialogue"
        && actual.dialogue_overlap_frames > 0
        && sidechain.sidechain_applied !== true
      ) {
        errors.push(`${cue.cue_id} overlaps dialogue but sidechain was not applied`);
      }
    }
    if ((report.sfx_cues?.length ?? 0) !== expectedSfxCues.cues.length) {
      errors.push("shared report SFX cue count does not match sfx_cues");
    }
    const finalPeak = Number.parseFloat(
      report.final_mastering.output_measurement?.input_tp ?? "NaN",
    );
    if (Number.isFinite(finalPeak) && finalPeak > -1.5) {
      errors.push(`final true peak ${finalPeak} dBTP exceeds -1.5 dBTP`);
    }
  }
  return {
    name: "sfx_mix_policy_valid",
    passed: errors.length === 0,
    details: errors.length === 0
      ? "A3 library/asset pins, cue range/gain/fade/tail/duck values, headroom, A1-only finishing, and one mastering pass verified"
      : errors.join("; "),
  };
}

export function checkAudioRenderPlanParity(
  finalReport: AudioMixReport | null | undefined,
  socialReport: AudioMixReport | null | undefined,
  requireSharedPlan: boolean,
): QaCheckResult {
  if (!requireSharedPlan) {
    return {
      name: "audio_render_plan_parity_valid",
      passed: true,
      details: "not_applicable: no enabled music-cues/v2 shared plan",
    };
  }
  const errors: string[] = [];
  if (finalReport?.version !== "audio-mix-report/v2") {
    errors.push("final audio-mix-report/v2 is missing");
  }
  if (socialReport?.version !== "audio-mix-report/v2") {
    errors.push("social-review audio-mix-report/v2 is missing");
  }
  if (finalReport?.plan_hash !== socialReport?.plan_hash) {
    errors.push(
      `plan_hash mismatch final=${String(finalReport?.plan_hash)} social=${String(socialReport?.plan_hash)}`,
    );
  }
  if (finalReport?.mastering_count !== 1 || socialReport?.mastering_count !== 1) {
    errors.push("social and final must each execute one mastering pass");
  }
  const cueContract = (report: AudioMixReport | null | undefined): string =>
    JSON.stringify((report?.cues ?? []).map((cue) => ({
      cue_id: cue.cue_id,
      timeline_range: cue.timeline_range,
      source_range_us: cue.source_range_us,
      applied: cue.applied,
      pins: cue.pins,
    })));
  if (cueContract(finalReport) !== cueContract(socialReport)) {
    errors.push("social and final cue gain/fade/duck/pin contracts differ");
  }
  const sfxCueContract = (report: AudioMixReport | null | undefined): string =>
    JSON.stringify((report?.sfx_cues ?? []).map((cue) => ({
      cue_id: cue.cue_id,
      semantic_role: cue.semantic_role,
      asset_id: cue.asset_id,
      timeline_range: cue.timeline_range,
      source_range_us: cue.source_range_us,
      applied: cue.applied,
      tail_processing: cue.tail_processing,
      pins: cue.pins,
      decision_pin: cue.decision_pin,
      a3_output_content_hash: cue.a3_output_content_hash,
    })));
  if (sfxCueContract(finalReport) !== sfxCueContract(socialReport)) {
    errors.push("social and final SFX cue/tail/duck/pin/A3 contracts differ");
  }
  if (finalReport?.output?.content_hash !== socialReport?.output?.content_hash) {
    errors.push(
      `final-mix hash mismatch final=${String(finalReport?.output?.content_hash)} social=${String(socialReport?.output?.content_hash)}`,
    );
  }
  return {
    name: "audio_render_plan_parity_valid",
    passed: errors.length === 0,
    details: errors.length === 0
      ? `social/final AudioRenderPlan parity verified plan_hash=${finalReport?.plan_hash}`
      : errors.join("; "),
  };
}

// ── Output Resolution / Frame Metadata ────────────────────────────

const FPS_TOLERANCE = 0.02;
const ASPECT_RATIO_TOLERANCE = 0.002;

function ratioValue(rawValue: string | null | undefined): number | null {
  if (!rawValue) return null;
  const match = rawValue.match(/^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/);
  if (!match) return null;
  const width = Number.parseFloat(match[1]);
  const height = Number.parseFloat(match[2]);
  if (!Number.isFinite(width) || !Number.isFinite(height) || height === 0) return null;
  return width / height;
}

function ratioFromDimensions(width: number, height: number): string {
  const divisor = gcd(width, height);
  return `${width / divisor}:${height / divisor}`;
}

function gcd(a: number, b: number): number {
  return b === 0 ? Math.abs(a) : gcd(b, a % b);
}

function formatFps(value: number | null | undefined): string {
  return typeof value === "number" && Number.isFinite(value)
    ? value.toFixed(3)
    : "unknown";
}

function actualDisplayAspectValue(actual: VideoFrameMetrics): number | null {
  const dar = ratioValue(actual.dar);
  if (dar != null) return dar;

  if (actual.width <= 0 || actual.height <= 0) return null;
  const sar = ratioValue(actual.sar) ?? 1;
  return (actual.width / actual.height) * sar;
}

function expectedDisplayAspectValue(expected: ExpectedVideoFrameSpec): number | null {
  const dar = ratioValue(expected.dar);
  if (dar != null) return dar;
  const aspect = ratioValue(expected.aspect_ratio);
  if (aspect != null) return aspect;
  if (
    typeof expected.width === "number" &&
    typeof expected.height === "number" &&
    expected.width > 0 &&
    expected.height > 0
  ) {
    return expected.width / expected.height;
  }
  return null;
}

function displayAspectLabel(spec: ExpectedVideoFrameSpec | VideoFrameMetrics): string {
  if ("aspect_ratio" in spec && spec.aspect_ratio) return spec.aspect_ratio;
  if (spec.dar) return spec.dar;
  if (typeof spec.width === "number" && typeof spec.height === "number") {
    return ratioFromDimensions(spec.width, spec.height);
  }
  return "unknown";
}

export function checkResolutionSpec(
  actual: VideoFrameMetrics | null | undefined,
  expected: ExpectedVideoFrameSpec | null | undefined,
  probeError?: string,
): QaCheckResult & { metrics: ResolutionCheckMetrics } {
  if (!expected) {
    return {
      name: "resolution_valid",
      passed: true,
      details: "resolution_check=skipped reason=no_expected_spec",
      metrics: {
        resolution_check: "skipped",
        ...(actual ? { actual_video_frame: actual } : {}),
      },
    };
  }

  if (!actual) {
    return {
      name: "resolution_valid",
      passed: false,
      details: `resolution_check=blocked reason=${probeError || "video_frame_probe_unavailable"}`,
      metrics: {
        resolution_check: "blocked",
        expected_video_frame: expected,
      },
    };
  }

  const mismatches: string[] = [];
  if (typeof expected.width === "number" && actual.width !== expected.width) {
    mismatches.push(`width expected=${expected.width} actual=${actual.width}`);
  }
  if (typeof expected.height === "number" && actual.height !== expected.height) {
    mismatches.push(`height expected=${expected.height} actual=${actual.height}`);
  }
  if (expected.sar && actual.sar && actual.sar !== expected.sar) {
    mismatches.push(`sar expected=${expected.sar} actual=${actual.sar}`);
  }

  const expectedDar = expectedDisplayAspectValue(expected);
  const actualDar = actualDisplayAspectValue(actual);
  if (
    expectedDar != null &&
    (actualDar == null || Math.abs(actualDar - expectedDar) > ASPECT_RATIO_TOLERANCE)
  ) {
    mismatches.push(
      `dar expected=${displayAspectLabel(expected)} actual=${actual.dar ?? displayAspectLabel(actual)}`,
    );
  }

  if (
    typeof expected.fps_num === "number" && expected.fps_num > 0 &&
    typeof expected.fps_den === "number" && expected.fps_den > 0
  ) {
    if (
      typeof actual.fps_num !== "number" || actual.fps_num <= 0 ||
      typeof actual.fps_den !== "number" || actual.fps_den <= 0
    ) {
      mismatches.push(
        `fps expected=${expected.fps_num}/${expected.fps_den} actual=unknown`,
      );
    } else if (!equivalentFrameRates(
      { fpsNum: expected.fps_num, fpsDen: expected.fps_den },
      { fpsNum: actual.fps_num, fpsDen: actual.fps_den },
    )) {
      mismatches.push(
        `fps expected=${expected.fps_num}/${expected.fps_den} actual=${actual.fps_num}/${actual.fps_den}`,
      );
    }
  } else if (typeof expected.fps === "number" && Number.isFinite(expected.fps)) {
    if (typeof actual.fps !== "number" || !Number.isFinite(actual.fps)) {
      mismatches.push(`fps expected=${formatFps(expected.fps)} actual=unknown`);
    } else if (Math.abs(actual.fps - expected.fps) > FPS_TOLERANCE) {
      mismatches.push(`fps expected=${formatFps(expected.fps)} actual=${formatFps(actual.fps)}`);
    }
  }

  const passed = mismatches.length === 0;
  return {
    name: "resolution_valid",
    passed,
    details: passed
      ? `resolution_check=passed source=${expected.source} width=${actual.width} height=${actual.height} dar=${actual.dar ?? displayAspectLabel(actual)} fps=${formatFps(actual.fps)}`
      : `resolution_check=failed source=${expected.source} ${mismatches.join("; ")}`,
    metrics: {
      resolution_check: passed ? "passed" : "failed",
      actual_video_frame: actual,
      expected_video_frame: expected,
      ...(mismatches.length > 0 ? { resolution_mismatches: mismatches } : {}),
    },
  };
}

// ── Package Completeness ───────────────────────────────────────────

/**
 * Check that all required artifacts exist for the given source of truth
 * and caption policy.
 */
export function checkPackageCompleteness(
  sourceOfTruth: "engine_render" | "nle_finishing",
  captionPolicy: { source: string; delivery_mode: string },
  existingArtifacts: Set<string>,
  requireAudio = true,
): QaCheckResult {
  const required: string[] = [];
  const missing: string[] = [];

  // Common required artifacts
  required.push("final_video");
  required.push("qa_report");
  // Note: package_manifest is generated AFTER QA, so it is NOT required here.

  if (sourceOfTruth === "engine_render") {
    required.push("raw_video");
    if (requireAudio) {
      required.push("raw_dialogue");
      required.push("final_mix");
      required.push("audio_mix_report");
    }
  }

  // Caption artifacts based on policy
  if (captionPolicy.source !== "none") {
    if (
      captionPolicy.delivery_mode === "sidecar" ||
      captionPolicy.delivery_mode === "both"
    ) {
      required.push("srt_sidecar");
      required.push("vtt_sidecar");
    }
  }

  for (const artifact of required) {
    if (!existingArtifacts.has(artifact)) {
      missing.push(artifact);
    }
  }

  return {
    name: "package_completeness_valid",
    passed: missing.length === 0,
    details:
      missing.length === 0
        ? `All ${required.length} required artifacts present`
        : `Missing artifacts: ${missing.join(", ")}`,
  };
}

// ── Duration Policy Validation ────────────────────────────────────

export interface DurationPolicyInput {
  mode: "strict" | "guide";
  target_duration_sec: number;
  min_duration_sec: number;
  max_duration_sec: number | null;
}

/**
 * Check that actual duration is within the duration policy window.
 *
 * - strict: required check; actual must be within min/max
 * - guide: info-only; reports drift but never fails
 */
export function checkDurationPolicy(
  actualDurationSec: number,
  policy: DurationPolicyInput,
): QaCheckResult & {
  metrics: {
    duration_mode: string;
    target_duration_sec: number;
    actual_duration_sec: number;
    duration_delta_sec: number;
    duration_delta_pct: number;
  };
} {
  const delta = actualDurationSec - policy.target_duration_sec;
  const deltaPct = policy.target_duration_sec > 0
    ? (delta / policy.target_duration_sec) * 100
    : 0;

  const metrics = {
    duration_mode: policy.mode,
    target_duration_sec: policy.target_duration_sec,
    actual_duration_sec: actualDurationSec,
    duration_delta_sec: Math.round(delta * 1000) / 1000,
    duration_delta_pct: Math.round(deltaPct * 100) / 100,
  };

  if (policy.mode === "strict") {
    const withinMin = actualDurationSec >= policy.min_duration_sec;
    const withinMax = policy.max_duration_sec == null || actualDurationSec <= policy.max_duration_sec;
    const passed = withinMin && withinMax;

    return {
      name: "duration_policy_valid",
      passed,
      details: passed
        ? `Duration ${actualDurationSec.toFixed(2)}s within strict window [${policy.min_duration_sec.toFixed(1)}s, ${(policy.max_duration_sec ?? Infinity).toFixed(1)}s]`
        : `Duration ${actualDurationSec.toFixed(2)}s outside strict window [${policy.min_duration_sec.toFixed(1)}s, ${(policy.max_duration_sec ?? Infinity).toFixed(1)}s]`,
      metrics,
    };
  }

  // guide: always passes
  return {
    name: "duration_policy_valid",
    passed: true,
    details: `Duration ${actualDurationSec.toFixed(2)}s (guide advisory: target ${policy.target_duration_sec.toFixed(1)}s, delta ${delta >= 0 ? "+" : ""}${delta.toFixed(2)}s / ${deltaPct >= 0 ? "+" : ""}${deltaPct.toFixed(1)}%)`,
    metrics,
  };
}

// ── QA Report Builder ──────────────────────────────────────────────

/**
 * Build a full QA report from individual check results.
 */
export function buildQaReport(
  projectId: string,
  sourceOfTruth: "engine_render" | "nle_finishing",
  checks: QaCheckResult[],
  metrics: QaReport["metrics"],
  artifacts: QaReport["artifacts"],
): QaReport {
  const allPassed = checks.every((c) => c.passed);

  return {
    version: "1.0.0",
    project_id: projectId,
    source_of_truth: sourceOfTruth,
    qa_profile: sourceOfTruth,
    passed: allPassed,
    checks,
    metrics,
    artifacts,
  };
}

// ── Required Checks Per Profile ────────────────────────────────────

/**
 * Get the list of required check names for a given QA profile.
 *
 * engine_render profile checks:
 *   timeline_schema_valid, caption_policy_valid, caption_density_valid,
 *   caption_alignment_valid, dialogue_occupancy_valid, av_drift_valid,
 *   audio_mix_policy_valid, loudness_target_valid, package_completeness_valid
 *
 * nle_finishing profile checks:
 *   timeline_schema_valid, caption_policy_valid,
 *   supplied_export_probe_valid, caption_delivery_valid,
 *   supplied_av_sync_valid, loudness_target_valid,
 *   package_completeness_valid
 */
export function getRequiredChecks(
  profile: "engine_render" | "nle_finishing",
  durationMode?: "strict" | "guide",
  requiresSharedAudioPlan = false,
  requiresSfx = false,
): string[] {
  const checks: string[] = [];

  if (profile === "engine_render") {
    checks.push(
      "timeline_schema_valid",
      "caption_policy_valid",
      "caption_density_valid",
      "caption_alignment_valid",
      "render_layout_evidence_complete",
      "resolution_valid",
      "dialogue_occupancy_valid",
      "dialogue_timeline_alignment_valid",
      "av_drift_valid",
      "audio_mix_policy_valid",
      "source_inputs_freshness_valid",
      "loudness_target_valid",
      "package_completeness_valid",
    );
    if (requiresSharedAudioPlan) {
      checks.push("audio_render_plan_parity_valid");
    }
    if (requiresSfx) {
      checks.push("sfx_mix_policy_valid");
    }
  } else {
    // nle_finishing
    checks.push(
      "timeline_schema_valid",
      "caption_policy_valid",
      "supplied_export_probe_valid",
      "resolution_valid",
      "caption_delivery_valid",
      "supplied_av_sync_valid",
      "loudness_target_valid",
      "package_completeness_valid",
    );
  }

  // Duration policy check is required only for strict mode
  if (durationMode === "strict") {
    checks.push("duration_policy_valid");
  }

  return checks;
}
