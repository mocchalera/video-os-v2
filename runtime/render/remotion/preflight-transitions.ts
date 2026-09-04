export interface TransitionPreflightResult {
  transition_id: string;
  effective_type: string;
  degraded: boolean;
  degraded_reason?: string;
}

export interface PreflightTransitionInput {
  transition_id: string;
  transition_type: string;
  from_clip_id: string;
  to_clip_id: string;
  duration_frames?: number;
  transition_frames?: number;
}

export interface PreflightClipInput {
  src_in_us: number;
  src_out_us: number;
  timeline_duration_frames: number;
}

export function preflightTransition(
  t: PreflightTransitionInput,
  fromClip: PreflightClipInput,
  toClip: PreflightClipInput,
  fps: number,
): TransitionPreflightResult {
  const requiresHandles =
    t.transition_type === "crossfade" ||
    t.transition_type === "match_cut_soft" ||
    // Issue #34 A/B roll presets consume head/tail handles too.
    t.transition_type === "film_crossfade" ||
    t.transition_type === "light_leak_flash" ||
    t.transition_type === "dreamy_focus_blur";
  if (!requiresHandles) {
    return {
      transition_id: t.transition_id,
      effective_type: t.transition_type,
      degraded: false,
    };
  }

  const durFrames = t.duration_frames ?? t.transition_frames ?? 0;
  if (durFrames <= 0) {
    return {
      transition_id: t.transition_id,
      effective_type: t.transition_type,
      degraded: false,
    };
  }

  const requiredUs = Math.round((durFrames / fps) * 1_000_000);
  void requiredUs;
  const fromOk = fromClip.timeline_duration_frames >= durFrames;
  const toOk = toClip.timeline_duration_frames >= durFrames;

  if (!fromOk || !toOk) {
    return {
      transition_id: t.transition_id,
      effective_type: "cut",
      degraded: true,
      degraded_reason: "insufficient_clip_duration_for_handle",
    };
  }

  return {
    transition_id: t.transition_id,
    effective_type: t.transition_type,
    degraded: false,
  };
}
