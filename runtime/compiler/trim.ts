// Adaptive Trim Phase
// Resolves optimal in/out points using center-based trimming
// when trim_hint or interest_points are available.
// Falls back to fixed authored range when no hint data exists.
// Deterministic. No LLM calls. No randomness.

import type {
  Candidate,
  CraftInPoint,
  CraftOutPoint,
  TrimHint,
  TrimPolicy,
  EditBlueprint,
  Marker,
  NormalizedBeat,
  TimelineClip,
} from "./types.js";
import type { ClipTrimPlan } from "../agents/clip-trim-agent.js";

export interface ResolvedTrim {
  src_in_us: number;
  src_out_us: number;
  mode: "adaptive_center" | "adaptive_interest" | "adaptive_peak_center" | "clip_trim_plan" | "fixed_midpoint" | "fixed_authored";
  source_center_us?: number;
  preferred_duration_us?: number;
  interest_point_label?: string;
  peak_type?: string;
  peak_confidence?: number;
  peak_ref?: string;
  craft_in_point?: CraftInPoint;
  craft_out_point?: CraftOutPoint;
  craft_degraded?: boolean;
  clip_trim_rationale?: string;
  clip_trim_technique?: string;
  clip_trim_source?: string;
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
  /** Beat-level craft exit directive */
  craftOutPoint?: CraftOutPoint;
  /** Clip-level deterministic plan from Marlin temporal events */
  clipTrimPlan?: ClipTrimPlan;
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
  const craftOutPoint = ctx.craftOutPoint;
  const clipTrimPlan = ctx.clipTrimPlan;

  if (clipTrimPlan) {
    const plannedRange = clampRangeToWindow(
      {
        inUs: clipTrimPlan.best_in_us,
        outUs: clipTrimPlan.best_out_us,
      },
      authoredIn,
      authoredOut,
    );
    if (plannedRange) {
      const durationUs = plannedRange.outUs - plannedRange.inUs;
      return {
        src_in_us: Math.round(plannedRange.inUs),
        src_out_us: Math.round(plannedRange.outUs),
        mode: "clip_trim_plan",
        source_center_us: Math.round((plannedRange.inUs + plannedRange.outUs) / 2),
        preferred_duration_us: durationUs,
        interest_point_label: clipTrimPlan.rationale,
        peak_type: peakTypeForTechnique(clipTrimPlan.technique),
        peak_confidence: typeof clipTrimPlan.score === "number" ? clipTrimPlan.score : undefined,
        peak_ref: clipTrimPlan.event_id,
        craft_in_point: craftInPoint,
        craft_out_point: craftOutPoint,
        clip_trim_rationale: clipTrimPlan.rationale,
        clip_trim_technique: clipTrimPlan.technique,
        clip_trim_source: clipTrimPlan.source,
      };
    }
  }

  // If no hint and no policy, use authored range as-is
  if (!hint && !ctx.trimPolicy && !craftInPoint && !craftOutPoint) {
    return {
      src_in_us: authoredIn,
      src_out_us: authoredOut,
      mode: "fixed_authored",
    };
  }

  // If trim policy is "fixed", use authored range
  if (ctx.trimPolicy?.mode === "fixed" && !craftInPoint && !craftOutPoint) {
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

  if (craftOutPoint) {
    const adjusted = applyCraftOutPoint(
      {
        inUs: resolvedIn,
        outUs: resolvedOut,
      },
      {
        candidate,
        hint,
        recommendedRange,
        center,
        windowStart,
        windowEnd,
        authoredIn,
        authoredOut,
        craftOutPoint,
      },
    );
    if (adjusted.degraded) craftDegraded = true;
    resolvedIn = adjusted.inUs;
    resolvedOut = adjusted.outUs;
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
    craft_out_point: craftOutPoint,
    craft_degraded: craftDegraded || undefined,
  };
}

function applyCraftOutPoint(
  range: { inUs: number; outUs: number },
  ctx: {
    candidate: Candidate;
    hint: TrimHint | undefined;
    recommendedRange: { inUs: number; outUs: number } | undefined;
    center: number;
    windowStart: number;
    windowEnd: number;
    authoredIn: number;
    authoredOut: number;
    craftOutPoint: CraftOutPoint;
  },
): { inUs: number; outUs: number; degraded: boolean } {
  let nextIn = range.inUs;
  let nextOut = range.outUs;
  let degraded = false;

  if (ctx.craftOutPoint === "cut_on_action") {
    if (!hasActionEvidence(ctx.candidate)) {
      return { inUs: nextIn, outUs: nextOut, degraded: true };
    }
    const actionPoint = ctx.hint?.source_center_us ??
      (ctx.recommendedRange ? Math.round((ctx.recommendedRange.inUs + ctx.recommendedRange.outUs) / 2) : undefined);
    if (actionPoint !== undefined && actionPoint > nextIn) {
      nextOut = Math.min(ctx.windowEnd, Math.max(nextIn + 1, actionPoint));
    } else {
      degraded = true;
    }
  } else if (ctx.craftOutPoint === "peak_hold") {
    const holdUntil = ctx.recommendedRange?.outUs ?? ctx.center + 750_000;
    const extended = Math.min(ctx.windowEnd, Math.max(nextOut, holdUntil));
    if (extended === nextOut && nextOut >= ctx.windowEnd) degraded = true;
    nextOut = extended;
  } else if (ctx.craftOutPoint === "post_action_hold") {
    const actionEnd = ctx.recommendedRange?.outUs ?? ctx.center;
    const extended = Math.min(ctx.windowEnd, Math.max(nextOut, actionEnd + 1_500_000));
    if (extended === nextOut && nextOut >= ctx.windowEnd) degraded = true;
    nextOut = extended;
  } else if (ctx.craftOutPoint === "clean_in_clean_out") {
    const snapped = snapCleanOut(nextIn, nextOut, ctx.hint, ctx.authoredIn, ctx.authoredOut);
    nextIn = snapped.inUs;
    nextOut = snapped.outUs;
    degraded = snapped.degraded;
  }

  if (nextIn >= nextOut) {
    return { inUs: range.inUs, outUs: range.outUs, degraded: true };
  }

  return { inUs: nextIn, outUs: nextOut, degraded };
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

function peakTypeForTechnique(technique: string): "action_peak" | "emotional_peak" | "visual_peak" | undefined {
  if (technique === "cut_on_action") return "action_peak";
  if (technique === "peak_hold" || technique === "post_action_hold") return "emotional_peak";
  if (technique === "clean_in_clean_out" || technique === "pre_roll_enter") return "visual_peak";
  return undefined;
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

function snapCleanOut(
  inUs: number,
  outUs: number,
  hint: TrimHint | undefined,
  authoredIn: number,
  authoredOut: number,
): { inUs: number; outUs: number; degraded: boolean } {
  const snapToleranceUs = 500_000;
  const cleanOut = hint?.window_end_us ?? authoredOut;
  if (Math.abs(outUs - cleanOut) > snapToleranceUs || inUs >= cleanOut) {
    return { inUs, outUs, degraded: true };
  }
  return { inUs, outUs: cleanOut, degraded: false };
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
  clipTrimPlans: ClipTrimPlan[] = [],
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

  const clipTrimPlanMap = new Map<string, ClipTrimPlan>();
  for (const plan of clipTrimPlans) {
    if (plan.source === "marlin_event") {
      clipTrimPlanMap.set(plan.segment_id, plan);
    }
  }

  for (const clip of clips) {
    if (clip.media_kind === "image") continue;
    const key = `${clip.segment_id}:${clip.src_in_us}:${clip.src_out_us}`;
    const candidate = candidateMap.get(key);
    if (!candidate) continue;

    const beat = beatMap.get(clip.beat_id);
    const craftInPoint = beat?.craft?.in_point;
    const craftOutPoint = beat?.craft?.out_point;
    const rawClipTrimPlan = clipTrimPlanMap.get(clip.segment_id);
    const clipTrimPlan = rawClipTrimPlan && clipTrimPlanOverlapsCandidate(rawClipTrimPlan, candidate)
      ? rawClipTrimPlan
      : undefined;

    // Skip if no trim hint, no trim policy, and no beat craft trim directive.
    if (!clipTrimPlan && !candidate.trim_hint && !blueprint.trim_policy && !craftInPoint && !craftOutPoint) continue;

    const beatTargetDurationUs = beat
      ? beat.target_duration_frames * usPerFrame
      : clip.timeline_duration_frames * usPerFrame;

    const resolved = resolveTrim(candidate, {
      beatTargetDurationUs,
      trimPolicy: blueprint.trim_policy,
      usPerFrame,
      craftInPoint,
      craftOutPoint,
      clipTrimPlan,
    });

    // Apply resolved trim to clip
    if (resolved.mode !== "fixed_authored") {
      clip.src_in_us = resolved.src_in_us;
      clip.src_out_us = resolved.src_out_us;
      const newDurationUs = clip.src_out_us - clip.src_in_us;
      const newDurationFrames = Math.ceil(newDurationUs / usPerFrame);
      if (newDurationFrames < clip.timeline_duration_frames) {
        clip.timeline_duration_frames = newDurationFrames;
      }
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
    if (resolved.craft_out_point) trimMeta.craft_out_point = resolved.craft_out_point;
    if (resolved.craft_degraded) trimMeta.craft_degraded = true;
    if (resolved.peak_type) trimMeta.peak_type = resolved.peak_type;
    if (resolved.peak_confidence !== undefined) trimMeta.peak_confidence = resolved.peak_confidence;
    if (resolved.peak_ref) trimMeta.peak_ref = resolved.peak_ref;
    if (resolved.clip_trim_rationale) trimMeta.clip_trim_rationale = resolved.clip_trim_rationale;
    if (resolved.clip_trim_technique) trimMeta.clip_trim_technique = resolved.clip_trim_technique;
    if (resolved.clip_trim_source) trimMeta.clip_trim_source = resolved.clip_trim_source;
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

function clipTrimPlanOverlapsCandidate(plan: ClipTrimPlan, candidate: Candidate): boolean {
  return plan.best_in_us < candidate.src_out_us && candidate.src_in_us < plan.best_out_us;
}

/**
 * Adaptive trim can shorten clips after assembly has already placed later
 * clips. Close only intra-beat gaps by moving each beat's clips left from the
 * beat marker; do not pull material across beat boundaries.
 */
export function compactTrimmedClipsWithinBeats(
  clips: TimelineClip[],
  beats: NormalizedBeat[],
  markers: Marker[] = [],
): void {
  const beatStarts = buildBeatStartFrames(beats, markers);

  for (const beat of beats) {
    const beatClips = clips
      .filter((clip) => clip.beat_id === beat.beat_id)
      .sort((a, b) => a.timeline_in_frame - b.timeline_in_frame || a.clip_id.localeCompare(b.clip_id));
    if (beatClips.length === 0) continue;

    const fallbackStart = Math.min(...beatClips.map((clip) => clip.timeline_in_frame));
    let cursor = beatStarts.get(beat.beat_id) ?? fallbackStart;
    for (const clip of beatClips) {
      if (clip.timeline_in_frame > cursor) {
        clip.timeline_in_frame = cursor;
      }
      cursor = Math.max(cursor, clip.timeline_in_frame + clip.timeline_duration_frames);
    }
  }
}

function buildBeatStartFrames(beats: NormalizedBeat[], markers: Marker[]): Map<string, number> {
  const starts = new Map<string, number>();
  for (const marker of markers) {
    if (marker.kind !== "beat") continue;
    const beatId = marker.label.split(":")[0]?.trim();
    if (beatId) starts.set(beatId, marker.frame);
  }

  let cursor = 0;
  for (const beat of beats) {
    if (!starts.has(beat.beat_id)) starts.set(beat.beat_id, cursor);
    cursor += Math.max(0, beat.target_duration_frames);
  }
  return starts;
}

// ── Utterance-boundary snapping (talking_head_pacing increment 1) ──────────
// Pure, deterministic. Snaps a clip's in/out to the nearest transcript utterance
// edge so cuts land on phrase boundaries instead of mid-word — this is what
// makes review metric audio.speech_cut pass. Operates on the existing single
// clip; no within-beat IR. Filler excision / pause tightening remain deferred.

export interface UtteranceSpan {
  start_us: number;
  end_us: number;
  text?: string;
  speaker?: string;
}

type UtteranceBoundaryKind = "start" | "end";

interface UtteranceBoundaryEdge {
  value: number;
  kind: UtteranceBoundaryKind;
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

function utteranceBoundaryEdges(utterances: UtteranceSpan[]): UtteranceBoundaryEdge[] {
  const seen = new Set<string>();
  const edges: UtteranceBoundaryEdge[] = [];
  for (const u of utterances) {
    if (u.end_us <= u.start_us) continue;
    for (const edge of [
      { value: u.start_us, kind: "start" as const },
      { value: u.end_us, kind: "end" as const },
    ]) {
      const key = `${edge.kind}:${edge.value}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push(edge);
    }
  }
  return edges.sort((a, b) => a.value - b.value || a.kind.localeCompare(b.kind));
}

function boundaryValues(edges: UtteranceBoundaryEdge[], kind: UtteranceBoundaryKind): number[] {
  return edges
    .filter((edge) => edge.kind === kind)
    .map((edge) => edge.value)
    .filter((value, index, values) => index === 0 || value !== values[index - 1]);
}

function isExactUtteranceEdge(value: number, edges: UtteranceBoundaryEdge[]): boolean {
  return edges.some((edge) => edge.value === value);
}

/**
 * A point is "inside speech" if it falls within the guarded interior of ANY
 * utterance. Transcripts can carry small overlaps between adjacent STT items; an
 * exact edge from any utterance is treated as a clean editorial cut point even
 * if another overlapping item still covers it.
 */
function insideAnyUtterance(
  value: number,
  utterances: UtteranceSpan[],
  guardUs: number,
  edges: UtteranceBoundaryEdge[],
): boolean {
  if (isExactUtteranceEdge(value, edges)) return false;
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
  edges: UtteranceBoundaryEdge[],
): number | null {
  if (!insideAnyUtterance(value, utterances, guardUs, edges)) return null; // already clean
  let best: number | null = null;
  let bestDist = Infinity;
  for (const b of boundaries) {
    const dist = Math.abs(b - value);
    if (dist > toleranceUs) continue;
    if (insideAnyUtterance(b, utterances, guardUs, edges)) continue; // edge still mid-speech
    if (dist < bestDist) {
      best = b;
      bestDist = dist;
    }
  }
  return best;
}

function nextCleanBoundary(
  value: number,
  boundaries: number[],
  utterances: UtteranceSpan[],
  toleranceUs: number,
  guardUs: number,
  edges: UtteranceBoundaryEdge[],
): number | null {
  if (!insideAnyUtterance(value, utterances, guardUs, edges)) return null;
  for (const b of boundaries) {
    if (b < value) continue;
    if (b - value > toleranceUs) break;
    if (insideAnyUtterance(b, utterances, guardUs, edges)) continue;
    return b;
  }
  return null;
}

function boundedUtteranceRange(
  srcInUs: number,
  srcOutUs: number,
  startBoundaries: number[],
  endBoundaries: number[],
  toleranceUs: number,
  minDurationUs: number,
  maxDurationUs: number | undefined,
  targetDurationUs: number | undefined,
  maxDurationToleranceUs: number,
): { src_in_us: number; src_out_us: number; duration_bound: boolean } | null {
  if (maxDurationUs === undefined && targetDurationUs === undefined) return null;

  const originalDurationUs = Math.max(1, srcOutUs - srcInUs);
  const targetUs = Math.max(1, Math.min(
    targetDurationUs ?? originalDurationUs,
    maxDurationUs ?? Number.POSITIVE_INFINITY,
  ));
  const originalCenter = (srcInUs + srcOutUs) / 2;
  let best: { src_in_us: number; src_out_us: number; score: number; duration_bound: boolean } | null = null;

  for (const start of startBoundaries) {
    if (Math.abs(start - srcInUs) > toleranceUs && Math.abs(start - originalCenter) > toleranceUs) continue;
    for (const end of endBoundaries) {
      if (end <= start + minDurationUs) continue;
      if (Math.abs(end - srcOutUs) > toleranceUs && Math.abs(end - originalCenter) > toleranceUs) continue;
      if (start >= srcOutUs || srcInUs >= end) continue;

      const duration = end - start;
      if (
        maxDurationUs !== undefined &&
        duration > maxDurationUs + maxDurationToleranceUs
      ) continue;

      const durationScore = Math.abs(duration - targetUs) / targetUs;
      const centerScore = Math.abs(((start + end) / 2) - originalCenter) / Math.max(toleranceUs, targetUs);
      const movementScore = (Math.abs(start - srcInUs) + Math.abs(end - srcOutUs)) /
        Math.max(1, toleranceUs * 2);
      const score = durationScore * 4 + centerScore + movementScore * 0.25;

      if (
        !best ||
        score < best.score ||
        (score === best.score && (start < best.src_in_us || (start === best.src_in_us && end < best.src_out_us)))
      ) {
        best = {
          src_in_us: start,
          src_out_us: end,
          score,
          duration_bound: maxDurationUs !== undefined || targetDurationUs !== undefined,
        };
      }
    }
  }

  if (!best) return null;
  return {
    src_in_us: best.src_in_us,
    src_out_us: best.src_out_us,
    duration_bound: best.duration_bound,
  };
}

export interface UtteranceSnapResult {
  src_in_us: number;
  src_out_us: number;
  snapped_in: boolean;
  snapped_out: boolean;
  duration_bound?: boolean;
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
  options: {
    preferNextOutBoundary?: boolean;
    maxDurationUs?: number;
    targetDurationUs?: number;
    durationFrameUs?: number;
  } = {},
): UtteranceSnapResult | null {
  if (utterances.length === 0 || toleranceUs <= 0) return null;
  const edges = utteranceBoundaryEdges(utterances);
  if (edges.length === 0) return null;
  const startBoundaries = boundaryValues(edges, "start");
  const endBoundaries = boundaryValues(edges, "end");
  const guardUs = SPEECH_CUT_GUARD_US;
  const minDurationUs = guardUs * 2 + 1;
  // Timeline duration is rounded to frames below. Admit the same source ranges
  // here so a sub-half-frame overage cannot displace an authored utterance.
  const maxDurationToleranceUs = options.durationFrameUs && options.durationFrameUs > 0
    ? Math.max(0, options.durationFrameUs / 2 - 1)
    : 0;

  const bounded = boundedUtteranceRange(
    srcInUs,
    srcOutUs,
    startBoundaries,
    endBoundaries,
    toleranceUs,
    minDurationUs,
    options.maxDurationUs,
    options.targetDurationUs,
    maxDurationToleranceUs,
  );
  if (bounded) {
    if (bounded.src_in_us === srcInUs && bounded.src_out_us === srcOutUs) return null;
    return {
      src_in_us: bounded.src_in_us,
      src_out_us: bounded.src_out_us,
      snapped_in: bounded.src_in_us !== srcInUs,
      snapped_out: bounded.src_out_us !== srcOutUs,
      duration_bound: bounded.duration_bound,
    };
  }

  let snappedIn = srcInUs;
  let snappedOut = srcOutUs;

  const inTarget = nearestCleanBoundary(srcInUs, startBoundaries, utterances, toleranceUs, guardUs, edges);
  if (inTarget !== null && inTarget >= 0 && inTarget < snappedOut - minDurationUs) {
    snappedIn = inTarget;
  }

  const outTarget = options.preferNextOutBoundary
    ? nextCleanBoundary(srcOutUs, endBoundaries, utterances, toleranceUs, guardUs, edges) ??
      nearestCleanBoundary(srcOutUs, endBoundaries, utterances, toleranceUs, guardUs, edges)
    : nearestCleanBoundary(srcOutUs, endBoundaries, utterances, toleranceUs, guardUs, edges);
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
  options: {
    preferNextOutBoundary?: boolean;
    updateTimelineDuration?: boolean;
    usPerFrame?: number;
    maxDurationUsByBeat?: Map<string, number>;
    targetDurationUsByBeat?: Map<string, number>;
  } = {},
): number {
  let snappedCount = 0;

  for (const clip of clips) {
    if (clip.media_kind === "image") continue;
    const utterances = utteranceMap.get(clip.asset_id);
    if (!utterances || utterances.length === 0) continue;

    const result = snapRangeToUtteranceBoundaries(
      clip.src_in_us,
      clip.src_out_us,
      utterances,
      toleranceUs,
      {
        preferNextOutBoundary: options.preferNextOutBoundary,
        maxDurationUs: clip.beat_id ? options.maxDurationUsByBeat?.get(clip.beat_id) : undefined,
        targetDurationUs: clip.beat_id ? options.targetDurationUsByBeat?.get(clip.beat_id) : undefined,
        durationFrameUs: options.usPerFrame,
      },
    );
    if (!result) continue;

    const previousDurationFrames = clip.timeline_duration_frames;
    clip.src_in_us = result.src_in_us;
    clip.src_out_us = result.src_out_us;
    if (options.updateTimelineDuration && options.usPerFrame && options.usPerFrame > 0) {
      clip.timeline_duration_frames = Math.max(
        1,
        Math.round((clip.src_out_us - clip.src_in_us) / options.usPerFrame),
      );
    }
    snappedCount++;

    if (!clip.metadata) clip.metadata = {};
    const meta = clip.metadata as Record<string, unknown>;
    meta.talking_head_pacing = {
      snapped_in: result.snapped_in,
      snapped_out: result.snapped_out,
      tolerance_us: toleranceUs,
      ...(options.updateTimelineDuration
        ? { previous_timeline_duration_frames: previousDurationFrames }
        : {}),
      ...(result.duration_bound ? { duration_bound: true } : {}),
      ...(metadataTags.length > 0 ? { tags: [...metadataTags].sort() } : {}),
    };
  }

  return snappedCount;
}
