/**
 * Remotion composition types (stub - no actual Remotion dependency).
 *
 * Type-only Remotion composition definition for M4.
 * Real Remotion rendering is out of scope - this defines the contract.
 */

import * as path from "node:path";

// ── Types ──────────────────────────────────────────────────────────

export interface CompositionProps {
  timeline: any; // Full timeline.json
  fps: number;
  width: number;
  height: number;
  durationInFrames: number;
}

export interface RenderConfig {
  compositionId: string;
  props: CompositionProps;
  outputLocation: string;
  codec: "h264";
  imageFormat: "jpeg";
}

// ── Build Render Config ────────────────────────────────────────────

/**
 * Build render config from a timeline object.
 * Computes total duration from all video and audio track clips.
 */
export function buildRenderConfig(
  timeline: any,
  outputDir: string,
): RenderConfig {
  const seq = timeline.sequence;
  const fps = seq.fps_num / seq.fps_den;

  // Calculate total duration from all tracks
  let maxFrame = 0;
  for (const trackGroup of [timeline.tracks.video, timeline.tracks.audio]) {
    for (const track of trackGroup || []) {
      for (const clip of track.clips || []) {
        const end = clip.timeline_in_frame + clip.timeline_duration_frames;
        if (end > maxFrame) maxFrame = end;
      }
    }
  }

  return {
    compositionId: "VideoTimeline",
    props: {
      timeline,
      fps,
      width: seq.width,
      height: seq.height,
      durationInFrames: maxFrame,
    },
    outputLocation: path.join(outputDir, "assembly.mp4"),
    codec: "h264",
    imageFormat: "jpeg",
  };
}

// ── Stub Renderer ──────────────────────────────────────────────────

/**
 * Stub: in real implementation, this would call Remotion's renderMedia.
 * For M4, we use the ffmpeg fallback pipeline instead of actual Remotion.
 */
export async function renderAssembly(config: RenderConfig): Promise<string> {
  throw new Error(
    "Remotion rendering not available - use ffmpeg fallback pipeline",
  );
}
