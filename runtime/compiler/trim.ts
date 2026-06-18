// Adaptive Trim Phase
// Resolves optimal in/out points using center-based trimming
// when trim_hint or interest_points are available.
// Falls back to fixed authored range when no hint data exists.
// Deterministic. No LLM calls. No randomness.

import type {
  Candidate,
  CraftInPoint,
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
  craft_in_point?: CraftInPoint;
  craft_degraded?: boolean;
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
  /** Beat-level craft trim directive */
  craftInPoint?: CraftInPoint;
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
  const craftInPoint = ctx.craftInPoint;

  // If no hint and no policy, use authored range as-is
  if (!hint && !ctx.trimPolicy && !craftInPoint) {
    return {
      src_in_us: authoredIn,
      src_out_us: authoredOut,
      mode: "fixed_authored",
    };
  }

  // If trim policy is "fixed", use authored range
  if (ctx.trimPolicy?.mode === "fixed" && !craftInPoint) {
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
  let craftDegraded = false;
  let craftPreferredDurationUs: number | undefined;

  // Check for recommended_in_out first (strong peak with high confidence)
  const hasRecommendedInOut = hint?.recommended_in_us !== undefined &&
    hint?.recommended_out_us !== undefined &&
    hint.recommended_in_us < hint.recommended_out_us;
  const recommendedRange = hasRecommendedInOut
    ? clampRangeToWindow(
      {
        inUs: hint!.recommended_in_us!,
        outUs: hint!.recommended_out_us!,
      },
      hint?.window_start_us ?? authoredIn,
      hint?.window_end_us ?? authoredOut,
    )
    : undefined;

  if (craftInPoint === "peak_hold" && recommendedRange) {
    center = Math.round((recommendedRange.inUs + recommendedRange.outUs) / 2);
    craftPreferredDurationUs = recommendedRange.outUs - recommendedRange.inUs;
    mode = "adaptive_peak_center";
    interestLabel = hint?.interest_point_label;
    peakType = hint?.peak_type ?? candidate.editorial_signals?.peak_type;
    peakConfidence = hint?.interest_point_confidence ?? candidate.editorial_signals?.peak_strength_score;
    peakRef = hint?.peak_ref ?? candidate.editorial_signals?.peak_ref;
  } else if (hint?.source_center_us !== undefined && hint?.peak_type) {
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
    if (craftInPoint) craftDegraded = true;
  }

  if (
    craftInPoint === "cut_on_action" &&
    recommendedRange &&
    hasActionEvidence(candidate)
  ) {
    center = Math.round((recommendedRange.inUs + recommendedRange.outUs) / 2);
    craftPreferredDurationUs = recommendedRange.outUs - recommendedRange.inUs;
    mode = "adaptive_peak_center";
    peakType = peakType ?? "action_peak";
    peakConfidence = peakConfidence ?? hint?.interest_point_confidence ?? candidate.editorial_signals?.peak_strength_score;
    peakRef = peakRef ?? hint?.peak_ref ?? candidate.editorial_signals?.peak_ref;
  } else if (craftInPoint === "cut_on_action" && !hasActionEvidence(candidate)) {
    craftDegraded = true;
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

  if (craftPreferredDurationUs !== undefined) {
    desiredDurationUs = craftPreferredDurationUs;
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
  if (craftInPoint === "post_action_hold") {
    preRollRatio = Math.max(0.2, Math.min(0.8, preRollRatio - 0.2));
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

  if (craftInPoint === "peak_hold" && recommendedRange) {
    resolvedIn = recommendedRange.inUs;
    resolvedOut = recommendedRange.outUs;
  } else if (
    craftInPoint === "cut_on_action" &&
    recommendedRange &&
    hasActionEvidence(candidate)
  ) {
    resolvedIn = recommendedRange.inUs;
    resolvedOut = recommendedRange.outUs;
  } else if (craftInPoint === "pre_roll_enter") {
    const shifted = shiftRangeWithinWindow(resolvedIn, resolvedOut, -500_000, windowStart, windowEnd);
    resolvedIn = shifted.inUs;
    resolvedOut = shifted.outUs;
  } else if (craftInPoint === "post_action_hold") {
    const extendedOut = Math.min(windowEnd, resolvedOut + 1_000_000);
    if (extendedOut === resolvedOut) craftDegraded = true;
    resolvedOut = extendedOut;
  } else if (craftInPoint === "clean_in_clean_out") {
    const snapped = snapCleanInOut(resolvedIn, resolvedOut, hint, authoredIn, authoredOut);
    if (snapped.degraded) craftDegraded = true;
    resolvedIn = snapped.inUs;
    resolvedOut = snapped.outUs;
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
    craft_in_point: craftInPoint,
    craft_degraded: craftDegraded || undefined,
  };
}

function clampRangeToWindow(
  range: { inUs: number; outUs: number },
  windowStart: number,
  windowEnd: number,
): { inUs: number; outUs: number } | undefined {
  const inUs = Math.max(windowStart, range.inUs);
  const outUs = Math.min(windowEnd, range.outUs);
  return inUs < outUs ? { inUs, outUs } : undefined;
}

function shiftRangeWithinWindow(
  inUs: number,
  outUs: number,
  shiftUs: number,
  windowStart: number,
  windowEnd: number,
): { inUs: number; outUs: number } {
  const duration = outUs - inUs;
  if (duration <= 0) return { inUs, outUs };
  let nextIn = inUs + shiftUs;
  let nextOut = outUs + shiftUs;
  if (nextIn < windowStart) {
    nextIn = windowStart;
    nextOut = Math.min(windowEnd, nextIn + duration);
  }
  if (nextOut > windowEnd) {
    nextOut = windowEnd;
    nextIn = Math.max(windowStart, nextOut - duration);
  }
  return { inUs: nextIn, outUs: nextOut };
}

function hasActionEvidence(candidate: Candidate): boolean {
  return candidate.trim_hint?.peak_type === "action_peak" ||
    candidate.editorial_signals?.peak_type === "action_peak" ||
    (candidate.peak_signals?.motion ?? 0) >= 0.55;
}

function snapCleanInOut(
  inUs: number,
  outUs: number,
  hint: TrimHint | undefined,
  authoredIn: number,
  authoredOut: number,
): { inUs: number; outUs: number; degraded: boolean } {
  const snapToleranceUs = 500_000;
  let nextIn = inUs;
  let nextOut = outUs;
  let snapped = false;

  const cleanIn = hint?.window_start_us ?? authoredIn;
  const cleanOut = hint?.window_end_us ?? authoredOut;
  if (Math.abs(nextIn - cleanIn) <= snapToleranceUs) {
    nextIn = cleanIn;
    snapped = true;
  }
  if (Math.abs(nextOut - cleanOut) <= snapToleranceUs) {
    nextOut = cleanOut;
    snapped = true;
  }
  if (nextIn >= nextOut) {
    return { inUs, outUs, degraded: true };
  }
  return { inUs: nextIn, outUs: nextOut, degraded: !snapped };
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

    const beat = beatMap.get(clip.beat_id);
    const craftInPoint = beat?.craft?.in_point;

    // Skip if no trim hint, no trim policy, and no beat craft trim directive.
    if (!candidate.trim_hint && !blueprint.trim_policy && !craftInPoint) continue;

    const beatTargetDurationUs = beat
      ? beat.target_duration_frames * usPerFrame
      : clip.timeline_duration_frames * usPerFrame;

    const resolved = resolveTrim(candidate, {
      beatTargetDurationUs,
      trimPolicy: blueprint.trim_policy,
      usPerFrame,
      craftInPoint,
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
    if (resolved.craft_in_point) trimMeta.craft_in_point = resolved.craft_in_point;
    if (resolved.craft_degraded) trimMeta.craft_degraded = true;
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

// ── Utterance-boundary snapping (talking_head_pacing increment 1) ──────────
// Pure, deterministic. Snaps a clip's in/out to the nearest transcript utterance
// edge so cuts land on phrase boundaries instead of mid-word — this is what
// makes review metric audio.speech_cut pass. Operates on the existing single
// clip; no within-beat IR. Filler excision / pause tightening remain deferred.

export interface UtteranceSpan {
  start_us: number;
  end_us: number;
}

// Mirror of review's audio.speech_cut guard: a boundary strictly inside an
// utterance (> 80ms from both edges) counts as a speech cut. Snapping onto an
// exact edge therefore always clears the guard.
const SPEECH_CUT_GUARD_US = 80_000;

/** Sorted, de-duplicated utterance edge timestamps for one asset. */
export function utteranceBoundaryTimestamps(utterances: UtteranceSpan[]): number[] {
  const set = new Set<number>();
  for (const u of utterances) {
    if (u.end_us <= u.start_us) continue;
    set.add(u.start_us);
    set.add(u.end_us);
  }
  return [...set].sort((a, b) => a - b);
}

/**
 * A point is "inside speech" if it falls within the guarded interior of ANY
 * utterance. Transcripts can carry overlapping utterances (diarization / STT
 * redundancy), so a boundary that sits exactly on one utterance's edge may still
 * be mid-word for an overlapping neighbour — this checks them all, matching the
 * review metric's behaviour.
 */
function insideAnyUtterance(value: number, utterances: UtteranceSpan[], guardUs: number): boolean {
  for (const u of utterances) {
    if (value > u.start_us + guardUs && value < u.end_us - guardUs) return true;
  }
  return false;
}

/**
 * Nearest CLEAN utterance edge to `value` within tolerance — "clean" meaning it
 * clears every overlapping utterance's guard, so moving the cut there actually
 * satisfies audio.speech_cut. Returns null when `value` is already clean or no
 * clean edge is reachable. Ties resolve to the smaller timestamp (edges are
 * ascending, first-wins).
 */
function nearestCleanBoundary(
  value: number,
  boundaries: number[],
  utterances: UtteranceSpan[],
  toleranceUs: number,
  guardUs: number,
): number | null {
  if (!insideAnyUtterance(value, utterances, guardUs)) return null; // already clean
  let best: number | null = null;
  let bestDist = Infinity;
  for (const b of boundaries) {
    const dist = Math.abs(b - value);
    if (dist > toleranceUs) continue;
    if (insideAnyUtterance(b, utterances, guardUs)) continue; // edge still mid-speech
    if (dist < bestDist) {
      best = b;
      bestDist = dist;
    }
  }
  return best;
}

export interface UtteranceSnapResult {
  src_in_us: number;
  src_out_us: number;
  snapped_in: boolean;
  snapped_out: boolean;
}

/**
 * Snap [srcIn, srcOut] to the nearest CLEAN utterance edges within tolerance.
 * A boundary only moves to a point that clears every overlapping utterance, so a
 * snap never trades one speech cut for another. Returns null when nothing moved.
 * Keeps in < out with at least the guard window of duration so snapping never
 * inverts or collapses a clip.
 */
export function snapRangeToUtteranceBoundaries(
  srcInUs: number,
  srcOutUs: number,
  utterances: UtteranceSpan[],
  toleranceUs: number,
): UtteranceSnapResult | null {
  if (utterances.length === 0 || toleranceUs <= 0) return null;
  const boundaries = utteranceBoundaryTimestamps(utterances);
  if (boundaries.length === 0) return null;
  const guardUs = SPEECH_CUT_GUARD_US;
  const minDurationUs = guardUs * 2 + 1;

  let snappedIn = srcInUs;
  let snappedOut = srcOutUs;

  const inTarget = nearestCleanBoundary(srcInUs, boundaries, utterances, toleranceUs, guardUs);
  if (inTarget !== null && inTarget >= 0 && inTarget < snappedOut - minDurationUs) {
    snappedIn = inTarget;
  }

  const outTarget = nearestCleanBoundary(srcOutUs, boundaries, utterances, toleranceUs, guardUs);
  if (outTarget !== null && outTarget > snappedIn + minDurationUs) {
    snappedOut = outTarget;
  }

  if (snappedIn === srcInUs && snappedOut === srcOutUs) return null;
  return {
    src_in_us: snappedIn,
    src_out_us: snappedOut,
    snapped_in: snappedIn !== srcInUs,
    snapped_out: snappedOut !== srcOutUs,
  };
}

/**
 * Apply utterance-boundary snapping to every clip whose source asset has a
 * transcript. Mutates clips in place and records provenance under a sibling
 * metadata.talking_head_pacing key (Phase 5.5 owns metadata.editorial). The
 * snap-skill metadata tag is emitted separately by getSkillMetadataTags.
 * Returns the number of clips adjusted.
 */
export function applyUtteranceSnap(
  clips: TimelineClip[],
  utteranceMap: Map<string, UtteranceSpan[]>,
  toleranceUs: number,
  metadataTags: string[] = [],
): number {
  let snappedCount = 0;

  for (const clip of clips) {
    const utterances = utteranceMap.get(clip.asset_id);
    if (!utterances || utterances.length === 0) continue;

    const result = snapRangeToUtteranceBoundaries(
      clip.src_in_us,
      clip.src_out_us,
      utterances,
      toleranceUs,
    );
    if (!result) continue;

    clip.src_in_us = result.src_in_us;
    clip.src_out_us = result.src_out_us;
    snappedCount++;

    if (!clip.metadata) clip.metadata = {};
    const meta = clip.metadata as Record<string, unknown>;
    meta.talking_head_pacing = {
      snapped_in: result.snapped_in,
      snapped_out: result.snapped_out,
      tolerance_us: toleranceUs,
      ...(metadataTags.length > 0 ? { tags: [...metadataTags].sort() } : {}),
    };
  }

  return snappedCount;
}
