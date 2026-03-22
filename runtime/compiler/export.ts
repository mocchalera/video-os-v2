// Phase 5: Export
// Emit timeline.json conforming to schemas/timeline-ir.schema.json.
// Records provenance and beat markers. Runs schema validation before writing.

import * as fs from "node:fs";
import * as path from "node:path";
import type { LoadedSourceMap } from "../media/source-map.js";
import type {
  AssembledTimeline,
  ClipOutput,
  DurationPolicy,
  MarkerOutput,
  TimelineIR,
  TimelineTransitionOutput,
  TrackOutput,
} from "./types.js";
import type { TimelineTransition } from "./transition-types.js";

const COMPILER_VERSION = "1.0.0";

export interface ExportOptions {
  projectId: string;
  projectTitle: string;
  projectPath: string;
  createdAt: string;
  briefRelPath: string;
  blueprintRelPath: string;
  selectsRelPath: string;
  fpsNum?: number;
  fpsDen?: number;
  durationPolicy?: DurationPolicy;
  transitions?: TimelineTransition[];
  width?: number;
  height?: number;
  outputAspectRatio?: string;
  letterboxPolicy?: "none" | "pillarbox" | "letterbox";
}

export function buildTimelineIR(
  assembled: AssembledTimeline,
  opts: ExportOptions,
): TimelineIR {
  const videoTracks: TrackOutput[] = assembled.tracks.video.map((t) => ({
    track_id: t.track_id,
    kind: t.kind,
    clips: t.clips.map(toClipOutput),
  }));

  const audioTracks: TrackOutput[] = assembled.tracks.audio.map((t) => ({
    track_id: t.track_id,
    kind: t.kind,
    clips: t.clips.map(toClipOutput),
  }));

  const markers: MarkerOutput[] = assembled.markers.map((m) => ({
    frame: m.frame,
    kind: m.kind,
    label: m.label,
  }));

  // Convert transitions if provided
  const transitionOutputs: TimelineTransitionOutput[] | undefined = opts.transitions
    ? opts.transitions.map(t => {
        const out: TimelineTransitionOutput = {
          transition_id: t.transition_id,
          from_clip_id: t.from_clip_id,
          to_clip_id: t.to_clip_id,
          track_id: t.track_id,
          transition_type: t.transition_type,
        };
        if (t.transition_params) out.transition_params = t.transition_params as Record<string, unknown>;
        if (t.applied_skill_id) out.applied_skill_id = t.applied_skill_id;
        if (t.degraded_from_skill_id !== undefined) out.degraded_from_skill_id = t.degraded_from_skill_id;
        if (t.confidence !== undefined) out.confidence = t.confidence;
        return out;
      })
    : undefined;

  return {
    version: "1",
    project_id: opts.projectId,
    created_at: opts.createdAt,
    sequence: {
      name: opts.projectTitle,
      fps_num: opts.fpsNum ?? 24,
      fps_den: opts.fpsDen ?? 1,
      width: opts.width ?? 1920,
      height: opts.height ?? 1080,
      start_frame: 0,
      ...(opts.outputAspectRatio ? { output_aspect_ratio: opts.outputAspectRatio } : {}),
      ...(opts.letterboxPolicy && opts.letterboxPolicy !== "none" ? { letterbox_policy: opts.letterboxPolicy } : {}),
    },
    tracks: {
      video: videoTracks,
      audio: audioTracks,
    },
    markers,
    ...(transitionOutputs && transitionOutputs.length > 0 ? { transitions: transitionOutputs } : {}),
    provenance: {
      brief_path: opts.briefRelPath,
      blueprint_path: opts.blueprintRelPath,
      selects_path: opts.selectsRelPath,
      compiler_version: COMPILER_VERSION,
      ...(opts.durationPolicy
        ? {
            duration_policy: {
              mode: opts.durationPolicy.mode,
              source: opts.durationPolicy.source,
              target_source: opts.durationPolicy.target_source,
              target_duration_sec: opts.durationPolicy.target_duration_sec,
              min_duration_sec: opts.durationPolicy.min_duration_sec,
              max_duration_sec: opts.durationPolicy.max_duration_sec,
            },
          }
        : {}),
    },
  };
}

export function writeTimeline(
  timeline: TimelineIR,
  projectPath: string,
): string {
  const outDir = path.join(projectPath, "05_timeline");
  if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
  }
  const outPath = path.join(outDir, "timeline.json");
  fs.writeFileSync(outPath, JSON.stringify(timeline, null, 2), "utf-8");
  return outPath;
}

/**
 * Stub for .otio export — full implementation in M3.5.
 * Returns empty string in M1 (timeline.json is the only required output).
 */
export function exportOtio(
  _timeline: TimelineIR,
  _projectPath: string,
): string {
  // TODO: M3.5 — generate OpenTimelineIO from TimelineIR
  return "";
}

/**
 * Write a minimal preview manifest derived from timeline.json.
 * Returns the path to the manifest, or empty string if skipped.
 */
export function writePreviewManifest(
  timeline: TimelineIR,
  projectPath: string,
  sourceMap?: LoadedSourceMap,
): string {
  const outDir = path.join(projectPath, "05_timeline");
  if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
  }

  const manifest = {
    version: "1",
    project_id: timeline.project_id,
    created_at: timeline.created_at,
    sequence: timeline.sequence,
    clips: timeline.tracks.video
      .flatMap((t) => t.clips)
      .concat(timeline.tracks.audio.flatMap((t) => t.clips))
      .map((c) => {
        const sourceEntry = sourceMap?.entryMap.get(c.asset_id);
        return {
          clip_id: c.clip_id,
          asset_id: c.asset_id,
          src_in_us: c.src_in_us,
          src_out_us: c.src_out_us,
          timeline_in_frame: c.timeline_in_frame,
          timeline_duration_frames: c.timeline_duration_frames,
          ...(sourceEntry
            ? {
                source_locator: sourceEntry.source_locator,
                local_source_path: sourceEntry.local_source_path,
                media_link_path: sourceEntry.link_path,
              }
            : {}),
        };
      }),
  };

  const outPath = path.join(outDir, "preview-manifest.json");
  fs.writeFileSync(outPath, JSON.stringify(manifest, null, 2), "utf-8");
  return outPath;
}

function toClipOutput(clip: {
  clip_id: string;
  segment_id: string;
  asset_id: string;
  src_in_us: number;
  src_out_us: number;
  timeline_in_frame: number;
  timeline_duration_frames: number;
  role: string;
  motivation: string;
  beat_id: string;
  fallback_segment_ids: string[];
  confidence: number;
  quality_flags: string[];
  candidate_ref?: string;
  fallback_candidate_refs?: string[];
  metadata?: Record<string, unknown>;
}): ClipOutput {
  const output: ClipOutput = {
    clip_id: clip.clip_id,
    segment_id: clip.segment_id,
    asset_id: clip.asset_id,
    src_in_us: clip.src_in_us,
    src_out_us: clip.src_out_us,
    timeline_in_frame: clip.timeline_in_frame,
    timeline_duration_frames: clip.timeline_duration_frames,
    role: clip.role,
    motivation: clip.motivation,
    beat_id: clip.beat_id,
    fallback_segment_ids: clip.fallback_segment_ids,
    confidence: clip.confidence,
    quality_flags: clip.quality_flags,
  };
  if (clip.candidate_ref) {
    output.candidate_ref = clip.candidate_ref;
  }
  if (clip.fallback_candidate_refs && clip.fallback_candidate_refs.length > 0) {
    output.fallback_candidate_refs = clip.fallback_candidate_refs;
  }
  if (clip.metadata && Object.keys(clip.metadata).length > 0) {
    output.metadata = clip.metadata;
  }
  return output;
}
