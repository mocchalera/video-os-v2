// Adaptive Trim Phase
// Resolves optimal in/out points using center-based trimming
// when trim_hint or interest_points are available.
// Falls back to fixed authored range when no hint data exists.
// Deterministic. No LLM calls. No randomness.

import type {
  Candidate,
  TrimHint,
  TrimPolicy,
  EditBlueprint,
  NormalizedBeat,
  TimelineClip,
} from "./types.js";

export interface ResolvedTrim {
  src_in_us: number;
  src_out_us: number;
  mode: "adaptive_center" | "adaptive_interest" | "adaptive_peak_center" | "fixed_midpoint" | "fixed_authored";
  source_center_us?: number;
  preferred_duration_us?: number;
  interest_point_label?: string;
  peak_type?: string;
  peak_confidence?: number;
  peak_ref?: string;
}

export interface TrimContext {
  /** Beat target duration in microseconds */
  beatTargetDurationUs: number;
  /** Trim policy from blueprint (optional) */
  trimPolicy?: TrimPolicy;
  /** Skill-driven duration bias in microseconds */
  skillDurationBiasUs?: number;
  /** Skill-driven trim bias: positive = extend post-roll, negative = extend pre-roll */
  skillTrimBias?: number;
  /** Microseconds per frame */
  usPerFrame: number;
}

/**
 * Resolve the optimal in/out for a candidate based on trim_hint,
 * beat context, and skill biases.
 *
 * Logic (per design doc §4):
 * 1. Determine center: trim_hint.source_center_us > interest point > midpoint
 * 2. Determine desired duration: beat target + profile + skill bias, clamped
 * 3. Apply asymmetry based on role/skill
 * 4. Clamp to authored window
 */
export function resolveTrim(
  candidate: Candidate,
  ctx: TrimContext,
): ResolvedTrim {
  const authoredIn = candidate.src_in_us;
  const authoredOut = candidate.src_out_us;
  const authoredDuration = authoredOut - authoredIn;
  const hint = candidate.trim_hint;

  // If no hint and no policy, use authored range as-is
  if (!hint && !ctx.trimPolicy) {
    return {
      src_in_us: authoredIn,
      src_out_us: authoredOut,
      mode: "fixed_authored",
    };
  }

  // If trim policy is "fixed", use authored range
  if (ctx.trimPolicy?.mode === "fixed") {
    return {
      src_in_us: authoredIn,
      src_out_us: authoredOut,
      mode: "fixed_authored",
    };
  }

  // Step 1: Determine center
  let center: number;
  let mode: ResolvedTrim["mode"];
  let interestLabel: string | undefined;
  let peakType: string | undefined;
  let peakConfidence: number | undefined;
  let peakRef: string | undefined;

  // Check for recommended_in_out first (strong peak with high confidence)
  const hasRecommendedInOut = hint?.recommended_in_us !== undefined &&
    hint?.recommended_out_us !== undefined &&
    hint.recommended_in_us < hint.recommended_out_us;

  if (hint?.source_center_us !== undefined && hint?.peak_type) {
    // Peak-centered trim
    center = hint.source_center_us;
    mode = "adaptive_peak_center";
    interestLabel = hint.interest_point_label;
    peakType = hint.peak_type;
    peakConfidence = hint.interest_point_confidence;
    peakRef = hint.peak_ref;
  } else if (hint?.source_center_us !== undefined) {
    center = hint.source_center_us;
    mode = "adaptive_center";
    interestLabel = hint.interest_point_label;
  } else {
    // Fallback: midpoint of authored range
    center = Math.round((authoredIn + authoredOut) / 2);
    mode = "fixed_midpoint";
  }

  // Step 2: Determine desired duration
  let desiredDurationUs = ctx.beatTargetDurationUs;

  // Apply trim policy preferred duration if available
  if (ctx.trimPolicy?.default_preferred_duration_frames) {
    desiredDurationUs = ctx.trimPolicy.default_preferred_duration_frames * ctx.usPerFrame;
  }

  // Apply hint preferred duration if available (overrides policy)
  if (hint?.preferred_duration_us) {
    desiredDurationUs = hint.preferred_duration_us;
  }

  // Apply skill duration bias
  if (ctx.skillDurationBiasUs) {
    desiredDurationUs += ctx.skillDurationBiasUs;
  }

  // Clamp to hint min/max if available
  if (hint?.min_duration_us) {
    desiredDurationUs = Math.max(desiredDurationUs, hint.min_duration_us);
  }
  if (hint?.max_duration_us) {
    desiredDurationUs = Math.min(desiredDurationUs, hint.max_duration_us);
  }

  // Clamp to trim policy min/max
  if (ctx.trimPolicy?.default_min_duration_frames) {
    const minUs = ctx.trimPolicy.default_min_duration_frames * ctx.usPerFrame;
    desiredDurationUs = Math.max(desiredDurationUs, minUs);
  }
  if (ctx.trimPolicy?.default_max_duration_frames) {
    const maxUs = ctx.trimPolicy.default_max_duration_frames * ctx.usPerFrame;
    desiredDurationUs = Math.min(desiredDurationUs, maxUs);
  }

  // Cannot exceed authored range
  desiredDurationUs = Math.min(desiredDurationUs, authoredDuration);
  desiredDurationUs = Math.max(desiredDurationUs, 1); // at least 1us

  // Step 3: Apply asymmetry
  // Peak-type-based asymmetry (design doc §11.4)
  let preRollRatio = 0.5;
  if (peakType === "action_peak") {
    preRollRatio = 0.60; // longer pre-roll for anticipation
  } else if (peakType === "emotional_peak") {
    preRollRatio = 0.40; // longer post-roll for reaction
  } else if (peakType === "visual_peak") {
    preRollRatio = 0.45; // slightly longer post-roll for hold
  }
  // Apply skill trim bias on top
  if (ctx.skillTrimBias) {
    // clamp bias to [-0.3, 0.3] to prevent extreme asymmetry
    const bias = Math.max(-0.3, Math.min(0.3, ctx.skillTrimBias));
    preRollRatio = Math.max(0.2, Math.min(0.8, preRollRatio - bias));
  }

  // Step 4: Compute in/out from center
  const preRoll = Math.round(desiredDurationUs * preRollRatio);
  const postRoll = desiredDurationUs - preRoll;

  let resolvedIn = center - preRoll;
  let resolvedOut = center + postRoll;

  // Step 5: Clamp to authored window
  const windowStart = hint?.window_start_us ?? authoredIn;
  const windowEnd = hint?.window_end_us ?? authoredOut;

  if (resolvedIn < windowStart) {
    const shift = windowStart - resolvedIn;
    resolvedIn = windowStart;
    resolvedOut = Math.min(resolvedOut + shift, windowEnd);
  }
  if (resolvedOut > windowEnd) {
    const shift = resolvedOut - windowEnd;
    resolvedOut = windowEnd;
    resolvedIn = Math.max(resolvedIn - shift, windowStart);
  }

  // Final safety: ensure in < out
  if (resolvedIn >= resolvedOut) {
    resolvedIn = authoredIn;
    resolvedOut = authoredOut;
    mode = "fixed_authored";
  }

  // Round to integer microseconds
  resolvedIn = Math.round(resolvedIn);
  resolvedOut = Math.round(resolvedOut);

  return {
    src_in_us: resolvedIn,
    src_out_us: resolvedOut,
    mode,
    source_center_us: center,
    preferred_duration_us: desiredDurationUs,
    interest_point_label: interestLabel,
    peak_type: peakType,
    peak_confidence: peakConfidence,
    peak_ref: peakRef,
  };
}

/**
 * Apply adaptive trim to all clips in the assembled timeline.
 * Mutates clips in place. Returns trim metadata for each clip.
 */
export function applyAdaptiveTrim(
  clips: TimelineClip[],
  candidates: Candidate[],
  blueprint: EditBlueprint,
  beats: NormalizedBeat[],
  usPerFrame: number,
): Map<string, ResolvedTrim> {
  const trimResults = new Map<string, ResolvedTrim>();
  const candidateMap = new Map<string, Candidate>();
  for (const c of candidates) {
    // Index by segment_id + range for lookup
    const key = `${c.segment_id}:${c.src_in_us}:${c.src_out_us}`;
    candidateMap.set(key, c);
  }

  const beatMap = new Map<string, NormalizedBeat>();
  for (const b of beats) {
    beatMap.set(b.beat_id, b);
  }

  for (const clip of clips) {
    const key = `${clip.segment_id}:${clip.src_in_us}:${clip.src_out_us}`;
    const candidate = candidateMap.get(key);
    if (!candidate) continue;

    // Skip if no trim hint and no trim policy
    if (!candidate.trim_hint && !blueprint.trim_policy) continue;

    const beat = beatMap.get(clip.beat_id);
    const beatTargetDurationUs = beat
      ? beat.target_duration_frames * usPerFrame
      : clip.timeline_duration_frames * usPerFrame;

    const resolved = resolveTrim(candidate, {
      beatTargetDurationUs,
      trimPolicy: blueprint.trim_policy,
      usPerFrame,
    });

    // Apply resolved trim to clip
    if (resolved.mode !== "fixed_authored") {
      clip.src_in_us = resolved.src_in_us;
      clip.src_out_us = resolved.src_out_us;
    }

    // Store trim metadata
    if (!clip.metadata) clip.metadata = {};
    const trimMeta: Record<string, unknown> = {
      mode: resolved.mode,
      source_center_us: resolved.source_center_us,
      preferred_duration_us: resolved.preferred_duration_us,
      resolved_src_in_us: resolved.src_in_us,
      resolved_src_out_us: resolved.src_out_us,
      interest_point_label: resolved.interest_point_label,
    };
    if (resolved.peak_type) trimMeta.peak_type = resolved.peak_type;
    if (resolved.peak_confidence !== undefined) trimMeta.peak_confidence = resolved.peak_confidence;
    if (resolved.peak_ref) trimMeta.peak_ref = resolved.peak_ref;
    (clip.metadata as Record<string, unknown>).trim = trimMeta;

    // Peak editorial metadata (design doc §7.3)
    if (resolved.peak_ref && resolved.peak_confidence !== undefined && resolved.peak_confidence >= 0.55) {
      const editorial = ((clip.metadata as Record<string, unknown>).editorial ?? {}) as Record<string, unknown>;
      const peakMeta: Record<string, unknown> = {
        primary_peak_ref: resolved.peak_ref,
        peak_type: resolved.peak_type,
        peak_confidence: resolved.peak_confidence,
      };
      if (resolved.peak_confidence >= 0.70 && resolved.interest_point_label) {
        peakMeta.peak_summary = resolved.interest_point_label;
      }
      editorial.peak = peakMeta;
      (clip.metadata as Record<string, unknown>).editorial = editorial;
    }

    trimResults.set(clip.clip_id, resolved);
  }

  return trimResults;
}
