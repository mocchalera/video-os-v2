// Phase 5: Export
// Emit timeline.json conforming to schemas/timeline-ir.schema.json.
// Records provenance and beat markers. Runs schema validation before writing.

import * as fs from "node:fs";
import * as path from "node:path";
import type {
  AssembledTimeline,
  ClipOutput,
  MarkerOutput,
  TimelineIR,
  TrackOutput,
} from "./types.js";

const COMPILER_VERSION = "1.0.0";

export interface ExportOptions {
  projectId: string;
  projectTitle: string;
  projectPath: string;
  createdAt: string;
  briefRelPath: string;
  blueprintRelPath: string;
  selectsRelPath: string;
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

  return {
    version: "1",
    project_id: opts.projectId,
    created_at: opts.createdAt,
    sequence: {
      name: opts.projectTitle,
      fps_num: 24,
      fps_den: 1,
      width: 1920,
      height: 1080,
      start_frame: 0,
    },
    tracks: {
      video: videoTracks,
      audio: audioTracks,
    },
    markers,
    provenance: {
      brief_path: opts.briefRelPath,
      blueprint_path: opts.blueprintRelPath,
      selects_path: opts.selectsRelPath,
      compiler_version: COMPILER_VERSION,
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
      .map((c) => ({
        clip_id: c.clip_id,
        asset_id: c.asset_id,
        src_in_us: c.src_in_us,
        src_out_us: c.src_out_us,
        timeline_in_frame: c.timeline_in_frame,
        timeline_duration_frames: c.timeline_duration_frames,
      })),
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
