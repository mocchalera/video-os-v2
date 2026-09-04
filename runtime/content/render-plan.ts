import * as fs from "node:fs";
import type { TrackOutput } from "../compiler/types.js";
import { normalizeOverlayClipContent } from "./normalize.js";
import { isUnownedElement } from "../render/remotion/overlay-capability.js";
import type {
  ContentRendererId,
  CreativeCompositeStage,
  CreativeLayerMode,
  CreativeReuseScope,
  TimedContentElement,
} from "./types.js";

export interface ContentRenderPlanIssue {
  clip_id: string;
  message: string;
}

export interface ContentRenderPlan {
  width: number;
  height: number;
  fps: number;
  fps_num: number;
  fps_den: number;
  duration_frames: number;
  hyperframes_elements: TimedContentElement[];
  remotion_clip_ids: string[];
  remotion_elements: TimedContentElement[];
  remotion_base_required_clip_ids: string[];
  /** Additive v2 projection; legacy callers may omit it. */
  visual_elements?: ContentVisualElementPlan[];
  issues: ContentRenderPlanIssue[];
}

export interface ContentVisualElementPlan {
  clip_id: string;
  element_id: string;
  renderer: ContentRendererId;
  layer_mode: CreativeLayerMode;
  composite_stage: CreativeCompositeStage;
  reuse_scope: CreativeReuseScope;
  requires_base_frame: boolean;
  z_index: number;
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
  const remotionElements: TimedContentElement[] = [];
  const remotionBaseRequiredClipIds: string[] = [];
  const visualElements: ContentVisualElementPlan[] = [];
  const issues: ContentRenderPlanIssue[] = [];

  for (const [trackIndex, track] of (timeline.tracks?.overlay ?? []).entries()) {
    for (const clip of track.clips ?? []) {
      const normalized = normalizeOverlayClipContent(clip);
      // Fail closed before render starts: a canonical element that no
      // production renderer owns (e.g. template-less raw auto-hinted kinds
      // falling through to the ffmpeg default, which never draws content
      // overlays) must surface as an explicit issue instead of a silent drop.
      const ownership = normalized.element
        ? isUnownedElement(normalized.element, normalized.renderer_owner)
        : { unowned: false as const, field: "" };
      if (ownership.unowned) {
        issues.push({
          clip_id: clip.clip_id,
          message:
            `element ${normalized.element?.element_id} is unowned via ${ownership.field}: ` +
            `unsupported ContentElement route would be silently dropped`,
        });
        continue;
      }
      if (normalized.renderer_owner !== null) {
        const recipe = normalized.element?.creative_recipe;
        const renderer = normalized.renderer_owner;
        const layerMode = recipe?.layer_mode
          ?? (renderer === "ffmpeg" ? "native_filter" : "alpha_overlay");
        const requiresBaseFrame = recipe?.requires_base_frame ?? false;
        visualElements.push({
          clip_id: clip.clip_id,
          element_id: normalized.element?.element_id ?? clip.clip_id,
          renderer,
          layer_mode: layerMode,
          composite_stage: recipe?.composite_stage ?? "under_caption",
          reuse_scope: recipe?.reuse_scope ?? "project",
          requires_base_frame: requiresBaseFrame,
          z_index: normalized.element?.layout.z_index ?? trackIndex,
        });
      }
      if (normalized.renderer_owner === "remotion") {
        remotionClipIds.push(clip.clip_id);
        if (normalized.element) {
          remotionElements.push({
            element: normalized.element,
            start_frame: clip.timeline_in_frame,
            duration_frames: clip.timeline_duration_frames,
            track_index: normalized.element.layout.z_index + trackIndex,
          });
        }
        if (normalized.element?.creative_recipe?.requires_base_frame === true) {
          remotionBaseRequiredClipIds.push(clip.clip_id);
        }
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
      if (normalized.renderer_owner === "ffmpeg") {
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
    fps_num: timeline.sequence.fps_num,
    fps_den: timeline.sequence.fps_den,
    duration_frames: durationFrames,
    hyperframes_elements: hyperframesElements,
    remotion_clip_ids: remotionClipIds,
    remotion_elements: remotionElements,
    remotion_base_required_clip_ids: remotionBaseRequiredClipIds,
    visual_elements: visualElements,
    issues,
  };
}

export function loadContentRenderPlan(timelinePath: string): ContentRenderPlan {
  const timeline = JSON.parse(fs.readFileSync(timelinePath, "utf8")) as TimelineForContentPlan;
  return buildContentRenderPlan(timeline);
}
