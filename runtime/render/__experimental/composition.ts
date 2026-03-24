/**
 * Experimental Remotion composition stub.
 *
 * This module is quarantined under __experimental because the production
 * render pipeline does not import it and Video OS currently ships the
 * ffmpeg-based fallback pipeline instead of a real Remotion renderer.
 */

import * as path from "node:path";
import type { TimelineIR, TrackOutput } from "../../compiler/types.js";

// ── Types ──────────────────────────────────────────────────────────

export interface CompositionProps {
  timeline: TimelineIR;
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
  timeline: TimelineIR,
  outputDir: string,
): RenderConfig {
  const seq = timeline.sequence;
  const fps = seq.fps_num / seq.fps_den;
  const trackGroups: TrackOutput[][] = [timeline.tracks.video, timeline.tracks.audio];

  let maxFrame = 0;
  for (const trackGroup of trackGroups) {
    for (const track of trackGroup) {
      for (const clip of track.clips) {
        const end = clip.timeline_in_frame + clip.timeline_duration_frames;
        if (end > maxFrame) {
          maxFrame = end;
        }
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
 * Stub only: Remotion rendering is intentionally not implemented here.
 * Production callers should use the ffmpeg fallback pipeline.
 */
export async function renderAssembly(_config: RenderConfig): Promise<string> {
  throw new Error(
    "Remotion rendering not available - use ffmpeg fallback pipeline",
  );
}
