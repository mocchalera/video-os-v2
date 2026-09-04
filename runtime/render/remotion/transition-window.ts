// Issue #34 — transition window geometry shared by the Remotion renderer.
//
// Pure resolution of the absolute transition window from timeline.json so
// tests can assert three-way agreement (Remotion Sequence span == compiler
// provenance == ffmpeg filtergraph envelope) without mounting React.

export interface ResolvedTransitionWindow {
  /** Absolute first frame of the window (start_frame in timeline.json). */
  startFrame: number;
  /** A/B blend length in frames (duration_frames in timeline.json). */
  blendFrames: number;
  /**
   * Total Sequence span. light_leak_flash is two-sided: the blend window
   * plus one extra blend-length decay tail, so the flare can ramp to its
   * peak exactly on the seam and decay while B remains visible.
   */
  durationInFrames: number;
}

/**
 * Resolve the absolute transition window from timeline.json.
 *
 * By construction this agrees with:
 * - the compiler's post-overlap provenance (chorus_entry.flash_start_frame
 *   == startFrame, flash_peak_frame == startFrame + blendFrames == the seam,
 *   flash_end_frame == startFrame + durationInFrames), and
 * - the ffmpeg filtergraph's flash window (trim [startFrame,
 *   startFrame + durationInFrames) with fade-in over the blend and fade-out
 *   over the tail).
 */
export function resolveTransitionWindow(
  transition: {
    transition_type?: string;
    start_frame?: number;
    duration_frames?: number;
    transition_frames?: number;
  },
  toClip: { timeline_in_frame: number },
): ResolvedTransitionWindow {
  const blendFrames = transition.duration_frames ?? transition.transition_frames ?? 0;
  const startFrame =
    transition.start_frame ?? Math.max(0, toClip.timeline_in_frame - blendFrames);
  const tailFrames = transition.transition_type === "light_leak_flash" ? blendFrames : 0;
  return { startFrame, blendFrames, durationInFrames: blendFrames + tailFrames };
}
