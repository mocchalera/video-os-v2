/**
 * Post-render QA validation.
 *
 * Provides path-specific QA profiles for engine_render and nle_finishing,
 * with individual metric checks for caption density, caption alignment,
 * dialogue occupancy, A/V drift, loudness targets, and package
 * completeness.
 */

// ── Types ──────────────────────────────────────────────────────────

export interface QaCheckResult {
  name: string;
  passed: boolean;
  details: string;
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
    av_drift_ms?: number;
    integrated_lufs?: number;
    true_peak_dbtp?: number;
  };
  artifacts: {
    final_video?: string;
    final_mix?: string;
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
): QaCheckResult {
  const errors: string[] = [];
  let maxDensity = 0;

  for (const cap of captions) {
    // Positive duration check
    if (cap.timeline_duration_frames <= 0) {
      errors.push(
        `${cap.caption_id}: non-positive duration (${cap.timeline_duration_frames} frames)`,
      );
      continue;
    }

    const durationSec = cap.timeline_duration_frames / fps;

    // Both languages use CPS (characters per second) aligned with line-breaker policy
    const charCount = cap.text.length;
    const cps = charCount / durationSec;
    if (cps > maxDensity) maxDensity = cps;

    const cpsLimit = (language === "ja" || language === "jp") ? 6.0 : 15.0;
    if (cps > cpsLimit) {
      errors.push(
        `${cap.caption_id}: CPS ${cps.toFixed(2)} exceeds ${cpsLimit.toFixed(1)} limit`,
      );
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
      errors.push(
        `Overlap: ${prev.caption_id} ends at frame ${prevEnd}, ` +
        `${curr.caption_id} starts at frame ${curr.timeline_in_frame}`,
      );
    }
  }

  return {
    name: "caption_density_valid",
    passed: errors.length === 0,
    details:
      errors.length === 0
        ? `Caption density OK (max: ${maxDensity.toFixed(2)})`
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

// ── A/V Drift ──────────────────────────────────────────────────────

/**
 * Duration delta between video and audio must be less than 1 frame
 * duration.
 */
export function checkAvDrift(
  videoDurationMs: number,
  audioDurationMs: number,
  frameDurationMs: number,
): QaCheckResult {
  const driftMs = Math.abs(videoDurationMs - audioDurationMs);

  return {
    name: "av_drift_valid",
    passed: driftMs < frameDurationMs,
    details:
      driftMs < frameDurationMs
        ? `A/V drift ${driftMs.toFixed(2)}ms < frame duration ${frameDurationMs.toFixed(2)}ms`
        : `A/V drift ${driftMs.toFixed(2)}ms >= frame duration ${frameDurationMs.toFixed(2)}ms`,
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

// ── Package Completeness ───────────────────────────────────────────

/**
 * Check that all required artifacts exist for the given source of truth
 * and caption policy.
 */
export function checkPackageCompleteness(
  sourceOfTruth: "engine_render" | "nle_finishing",
  captionPolicy: { source: string; delivery_mode: string },
  existingArtifacts: Set<string>,
): QaCheckResult {
  const required: string[] = [];
  const missing: string[] = [];

  // Common required artifacts
  required.push("final_video");
  required.push("qa_report");
  // Note: package_manifest is generated AFTER QA, so it is NOT required here.

  if (sourceOfTruth === "engine_render") {
    required.push("raw_video");
    required.push("raw_dialogue");
    required.push("final_mix");
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
 *   loudness_target_valid, package_completeness_valid
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
): string[] {
  const checks: string[] = [];

  if (profile === "engine_render") {
    checks.push(
      "timeline_schema_valid",
      "caption_policy_valid",
      "caption_density_valid",
      "caption_alignment_valid",
      "dialogue_occupancy_valid",
      "av_drift_valid",
      "loudness_target_valid",
      "package_completeness_valid",
    );
  } else {
    // nle_finishing
    checks.push(
      "timeline_schema_valid",
      "caption_policy_valid",
      "supplied_export_probe_valid",
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
