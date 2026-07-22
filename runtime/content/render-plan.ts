import * as fs from "node:fs";
import type { TrackOutput } from "../compiler/types.js";
import { normalizeOverlayClipContent } from "./normalize.js";
import type { TimedContentElement } from "./types.js";

export interface ContentRenderPlanIssue {
  clip_id: string;
  message: string;
}

export interface ContentRenderPlan {
  width: number;
  height: number;
  fps: number;
  duration_frames: number;
  hyperframes_elements: TimedContentElement[];
  remotion_clip_ids: string[];
  issues: ContentRenderPlanIssue[];
}

interface TimelineForContentPlan {
  sequence: {
    width: number;
    height: number;
    fps_num: number;
    fps_den: number;
  };
  tracks?: Record<string, TrackOutput[]>;
}

const HYPERFRAMES_V1_TEMPLATES = new Set([
  "vos:content.section-label/v1",
  "vos:content.question-card/v1",
  "vos:content.lower-third/v1",
]);

export function buildContentRenderPlan(timeline: TimelineForContentPlan): ContentRenderPlan {
  const fps = timeline.sequence.fps_num / timeline.sequence.fps_den;
  let durationFrames = 1;
  for (const tracks of Object.values(timeline.tracks ?? {})) {
    for (const track of tracks ?? []) {
      for (const clip of track.clips ?? []) {
        durationFrames = Math.max(
          durationFrames,
          clip.timeline_in_frame + clip.timeline_duration_frames,
        );
      }
    }
  }

  const hyperframesElements: TimedContentElement[] = [];
  const remotionClipIds: string[] = [];
  const issues: ContentRenderPlanIssue[] = [];

  for (const [trackIndex, track] of (timeline.tracks?.overlay ?? []).entries()) {
    for (const clip of track.clips ?? []) {
      const normalized = normalizeOverlayClipContent(clip);
      if (normalized.renderer_owner === "remotion") {
        remotionClipIds.push(clip.clip_id);
        continue;
      }
      if (normalized.renderer_owner === "hyperframes" && normalized.element) {
        if (!normalized.element.template_ref || !HYPERFRAMES_V1_TEMPLATES.has(normalized.element.template_ref)) {
          issues.push({
            clip_id: clip.clip_id,
            message: `HyperFrames adapter does not support template ${normalized.element.template_ref ?? "(none)"}`,
          });
          continue;
        }
        hyperframesElements.push({
          element: normalized.element,
          start_frame: clip.timeline_in_frame,
          duration_frames: clip.timeline_duration_frames,
          track_index: normalized.element.layout.z_index + trackIndex,
        });
        continue;
      }
      for (const issue of normalized.issues) {
        issues.push({ clip_id: clip.clip_id, message: `${issue.path}: ${issue.message}` });
      }
    }
  }

  return {
    width: timeline.sequence.width,
    height: timeline.sequence.height,
    fps,
    duration_frames: durationFrames,
    hyperframes_elements: hyperframesElements,
    remotion_clip_ids: remotionClipIds,
    issues,
  };
}

export function loadContentRenderPlan(timelinePath: string): ContentRenderPlan {
  const timeline = JSON.parse(fs.readFileSync(timelinePath, "utf8")) as TimelineForContentPlan;
  return buildContentRenderPlan(timeline);
}
