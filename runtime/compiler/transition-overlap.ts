// Issue #34 — physical A/B roll overlap geometry for semantic transitions.
//
// A true crossfade needs real material on both sides: clip A's tail N frames
// and clip B's head N frames must exist simultaneously in the output. The
// renderer's xfade collapses the overlap window, so the timeline geometry
// must declare it: clip B is placed `transition_frames` earlier and its head
// is extended `transition_frames` back into its source. Both sides keep their
// full content, the program duration is unchanged (max end stays identical),
// and the render-time blend consumes exactly the declared overlap —
// Gap 0 / Overrun 0 by construction.
//
// The flash envelope is anchored to the SEAM frame (B's original content
// start = B.timeline_in_frame + overlap after this pass): the light-leak
// ramps up across the blend window, peaks exactly on the seam (the chorus
// head), and decays over one window length. The recorded metadata mirrors
// those rendered frames.
//
// When a transition cannot receive the overlap (no source headroom, still
// hold policy, speech-protected boundary, non-adjacent placement, missing
// clip reference, or a chained overlap that would exceed the outgoing
// clip's ORIGINAL content) it is degraded EXPLICITLY to a cut with a
// recorded reason — never silently.

import type { TimelineClip, Track } from "./types.js";
import type { TimelineTransition } from "./transition-types.js";
import { OVERLAP_TRANSITION_TYPES } from "./transition-types.js";
import { isSpeechProtectedBeatBoundary } from "./beat-sync.js";
import { setStillImageHoldFrames } from "./still-image.js";

export interface TransitionOverlapOptions {
  fpsNum: number;
  fpsDen: number;
}

export interface TransitionOverlapApplied {
  transition_id: string;
  to_clip_id: string;
  overlap_frames: number;
  /** First frame of the incoming clip's original content (flash peak). */
  seam_frame: number;
}

export interface TransitionOverlapDegraded {
  transition_id: string;
  to_clip_id: string;
  reason:
    | "missing_crossfade_sec"
    | "missing_clip_reference"
    | "non_adjacent_placement"
    | "overlap_exceeds_clip_duration"
    | "chained_overlap_exceeds_original_content"
    | "insufficient_source_head_handle"
    | "still_hold_policy_limit"
    | "speech_protected_boundary";
  overlap_frames_requested: number;
}

export interface TransitionOverlapResult {
  applied: TransitionOverlapApplied[];
  degraded: TransitionOverlapDegraded[];
}

/**
 * Apply physical A/B overlap geometry for overlap-preset transitions on a
 * video track. Mutates the right-hand clips in place (placement, duration,
 * source range, still-image hold) so `getTimelineDurationFrames` stays
 * identical and the renderer's xfade lands exactly on the declared window.
 */
export function applyTransitionOverlaps(
  track: Track,
  transitions: TimelineTransition[],
  opts: TransitionOverlapOptions,
): TransitionOverlapResult {
  const result: TransitionOverlapResult = { applied: [], degraded: [] };
  const clipsById = new Map<string, TimelineClip>();
  for (const clip of track.clips) clipsById.set(clip.clip_id, clip);
  // Immutable baseline: every overlap is validated against the content each
  // clip brought INTO this pass, never against a duration already extended
  // by an earlier overlap in the same chain (the pass mutates clips in
  // place). Duration neutrality keeps every clip's END frame fixed, so
  // validating an outgoing overlap against the ORIGINAL duration also
  // guarantees the blend windows on both sides of a chained clip stay
  // disjoint — no triple A/B/C coverage.
  const originalDurationFrames = new Map<string, number>();
  for (const clip of track.clips) {
    originalDurationFrames.set(clip.clip_id, clip.timeline_duration_frames);
  }

  for (const transition of transitions) {
    if (!OVERLAP_TRANSITION_TYPES.has(transition.transition_type)) continue;
    const crossfadeSec = transition.transition_params?.crossfade_sec;
    if (typeof crossfadeSec !== "number" || !(crossfadeSec > 0)) {
      // Degrade through the same explicit path as every other refusal so the
      // transition never survives as an unrenderable preset type: it becomes
      // a cut with fallback + degraded_reason metadata, like all refusals.
      degrade(transition, "missing_crossfade_sec", 0, result);
      continue;
    }

    const fps = opts.fpsNum / opts.fpsDen;
    const overlapFrames = Math.max(1, Math.round(crossfadeSec * fps));
    const headUs = Math.round((overlapFrames * 1_000_000 * opts.fpsDen) / opts.fpsNum);

    const fromClip = clipsById.get(transition.from_clip_id);
    const toClip = clipsById.get(transition.to_clip_id);
    if (!fromClip || !toClip) {
      // A dangling clip reference can never render; degrade explicitly
      // instead of silently dropping the transition.
      degrade(transition, "missing_clip_reference", overlapFrames, result);
      continue;
    }

    const isAdjacent =
      toClip.timeline_in_frame ===
      fromClip.timeline_in_frame + fromClip.timeline_duration_frames;
    if (!isAdjacent) {
      degrade(transition, "non_adjacent_placement", overlapFrames, result);
      continue;
    }

    // Dialogue boundaries must not be smeared through an A/B blend — the
    // incoming clip's nat sound would crossfade under speech.
    if (isSpeechProtectedBeatBoundary(fromClip, toClip)) {
      degrade(transition, "speech_protected_boundary", overlapFrames, result);
      continue;
    }

    const fromOriginal = originalDurationFrames.get(transition.from_clip_id) ??
      fromClip.timeline_duration_frames;
    const toOriginal = originalDurationFrames.get(transition.to_clip_id) ??
      toClip.timeline_duration_frames;
    if (overlapFrames >= toOriginal || overlapFrames >= fromOriginal) {
      // When the outgoing clip was already head-extended as an incoming clip
      // earlier in the chain, its current duration overstates its own
      // content — record the chained reason so provenance shows exactly why
      // the second blend was refused.
      const chained = fromClip.timeline_duration_frames > fromOriginal;
      degrade(
        transition,
        chained
          ? "chained_overlap_exceeds_original_content"
          : "overlap_exceeds_clip_duration",
        overlapFrames,
        result,
      );
      continue;
    }

    if (toClip.media_kind === "image") {
      // Stills have unlimited source headroom, but the hold must stay in
      // policy and the metadata must mirror the new duration exactly.
      const still = toClip.still_image;
      if (!still) {
        degrade(transition, "still_hold_policy_limit", overlapFrames, result);
        continue;
      }
      const newHold = toClip.timeline_duration_frames + overlapFrames;
      if (
        newHold < still.min_hold_frames ||
        newHold > still.max_hold_frames
      ) {
        degrade(transition, "still_hold_policy_limit", overlapFrames, result);
        continue;
      }
      toClip.timeline_in_frame -= overlapFrames;
      setStillImageHoldFrames(toClip, newHold, "none");
      recordApplied(transition, toClip, overlapFrames, result);
      continue;
    }

    if (toClip.freeze_frame_hold || toClip.src_in_us < headUs) {
      degrade(transition, "insufficient_source_head_handle", overlapFrames, result);
      continue;
    }

    toClip.timeline_in_frame -= overlapFrames;
    toClip.timeline_duration_frames += overlapFrames;
    toClip.src_in_us -= headUs;
    recordApplied(transition, toClip, overlapFrames, result);
  }

  return result;
}

/**
 * Record provenance on the applied transition: the physical overlap and the
 * rendered flash window (for light_leak_flash). The metadata always matches
 * the post-geometry frames the renderer will produce.
 */
function recordApplied(
  transition: TimelineTransition,
  toClip: TimelineClip,
  overlapFrames: number,
  result: TransitionOverlapResult,
): void {
  const seamFrame = toClip.timeline_in_frame + overlapFrames;
  transition.metadata = {
    ...transition.metadata,
    overlap_applied: {
      overlap_frames: overlapFrames,
      seam_frame: seamFrame,
    },
  };
  if (
    transition.transition_type === "light_leak_flash" &&
    transition.metadata.chorus_entry
  ) {
    // Flash window mirrors the renderer's triangle envelope: ramp across the
    // blend window [seam - D, seam), peak on the seam, decay to zero at
    // seam + D (exclusive).
    transition.metadata.chorus_entry = {
      ...(transition.metadata.chorus_entry as Record<string, unknown>),
      flash_start_frame: toClip.timeline_in_frame,
      flash_peak_frame: seamFrame,
      flash_end_frame: seamFrame + overlapFrames,
    };
  }
  result.applied.push({
    transition_id: transition.transition_id,
    to_clip_id: toClip.clip_id,
    overlap_frames: overlapFrames,
    seam_frame: seamFrame,
  });
}

/**
 * Explicit degradation: the transition becomes a cut with a recorded reason.
 * The program duration is untouched, no silent behavior change remains, and
 * flash provenance that would no longer be rendered is stripped.
 */
function degrade(
  transition: TimelineTransition,
  reason: TransitionOverlapDegraded["reason"],
  overlapFramesRequested: number,
  result: TransitionOverlapResult,
): void {
  transition.transition_type = "cut";
  if (transition.transition_params) {
    delete transition.transition_params.crossfade_sec;
    delete transition.transition_params.easing;
  }
  if (transition.metadata?.chorus_entry) {
    const chorus = { ...(transition.metadata.chorus_entry as Record<string, unknown>) };
    delete chorus.flash_start_frame;
    delete chorus.flash_peak_frame;
    delete chorus.flash_end_frame;
    transition.metadata = { ...transition.metadata, chorus_entry: chorus };
  }
  transition.metadata = {
    ...transition.metadata,
    degraded_reason: `transition_overlap_${reason}`,
  };
  transition.fallback = {
    type: "cut",
    reason: `overlap_preset_unrenderable:${reason}`,
  };
  result.degraded.push({
    transition_id: transition.transition_id,
    to_clip_id: transition.to_clip_id,
    reason,
    overlap_frames_requested: overlapFramesRequested,
  });
}
