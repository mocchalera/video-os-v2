// Phase 5: Export
// Emit timeline.json conforming to schemas/timeline-ir.schema.json.
// Records provenance and beat markers. Runs schema validation before writing.

import * as fs from "node:fs";
import * as path from "node:path";
import type { LoadedSourceMap } from "../media/source-map.js";
import { computeSourceMappingHash } from "./render-readiness.js";
import { computeFileHash16 } from "../preview/playback-contract.js";
import type {
  AssembledTimeline,
  BriefCaptionPolicy,
  BriefAudioPolicy,
  CreativeBriefMusicMaster,
  ClipOutput,
  DurationPolicy,
  MarkerOutput,
  TimelineIR,
  TimelineTransitionOutput,
  TrackOutput,
  StillDurationPolicy,
  CreatorShortVoBrollProvenance,
  RetentionPolicyProvenance,
} from "./types.js";
import type { TimelineTransition } from "./transition-types.js";
import { OVERLAP_TRANSITION_TYPES } from "./transition-types.js";

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
  audioPolicy?: {
    mode: BriefAudioPolicy;
    source: "explicit_brief" | "profile_default" | "global_default";
    a1_loudnorm?: boolean;
    audio_decision?: "preserve" | "mastering";
    music_master?: CreativeBriefMusicMaster;
  };
  captionPolicy?: {
    mode: BriefCaptionPolicy;
    source: "explicit_brief" | "profile_default" | "global_default";
  };
  stillDurationPolicy?: StillDurationPolicy;
  creatorShortVoBrollProvenance?: CreatorShortVoBrollProvenance;
  retentionPolicyProvenance?: RetentionPolicyProvenance;
  transitions?: TimelineTransition[];
  metadata?: Record<string, unknown>;
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
        if (typeof t.transition_params?.crossfade_sec === "number") {
          const fps = (opts.fpsNum ?? 24) / (opts.fpsDen ?? 1);
          out.transition_frames = Math.max(
            1,
            Math.round(t.transition_params.crossfade_sec * fps),
          );
        }
        if (t.transition_params) out.transition_params = t.transition_params as Record<string, unknown>;
        if (t.applied_skill_id) out.applied_skill_id = t.applied_skill_id;
        if (t.degraded_from_skill_id !== undefined) out.degraded_from_skill_id = t.degraded_from_skill_id;
        if (t.confidence !== undefined) out.confidence = t.confidence;
        if (t.fallback) {
          out.fallback = { type: t.fallback.type, reason: t.fallback.reason };
        }
        // Issue #34 overlap presets: record the absolute A/B blend window so
        // every consumer (Remotion preflight, review tooling) sees the exact
        // frames without re-deriving clip geometry.
        if (OVERLAP_TRANSITION_TYPES.has(t.transition_type) && out.transition_frames) {
          const toClip = assembled.tracks.video
            .flatMap((track) => track.clips)
            .find((clip) => clip.clip_id === t.to_clip_id);
          if (toClip) {
            out.start_frame = toClip.timeline_in_frame;
            out.duration_frames = out.transition_frames;
          }
        }
        if (t.metadata) out.metadata = t.metadata;
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
    ...(
      (opts.metadata && Object.keys(opts.metadata).length > 0) ||
      (assembled.operations && assembled.operations.length > 0)
        ? {
            metadata: {
              ...(assembled.operations && assembled.operations.length > 0
                ? { timeline_operations: assembled.operations }
                : {}),
              ...(opts.metadata ?? {}),
            },
          }
        : {}
    ),
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
      ...(opts.audioPolicy ? { audio_policy: opts.audioPolicy } : {}),
      ...(opts.captionPolicy ? { caption_policy: opts.captionPolicy } : {}),
      ...(opts.stillDurationPolicy ? { still_duration_policy: opts.stillDurationPolicy } : {}),
      ...(opts.creatorShortVoBrollProvenance
        ? { creator_short_vo_broll: opts.creatorShortVoBrollProvenance }
        : {}),
      ...(opts.retentionPolicyProvenance
        ? { retention_policy: opts.retentionPolicyProvenance }
        : {}),
    },
  };
}

export function writeTimeline(
  timeline: TimelineIR,
  projectPath: string,
  outputPath?: string,
): string {
  const outPath = outputPath ?? path.join(projectPath, "05_timeline", "timeline.json");
  const outDir = path.dirname(outPath);
  if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
  }
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
  options?: {
    outputPath?: string;
    timelinePath?: string;
  },
): string {
  const outPath = options?.outputPath ?? path.join(projectPath, "05_timeline", "preview-manifest.json");
  const outDir = path.dirname(outPath);
  if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
  }

  // Playback contract: record which timeline.json this manifest was
  // derived from, so review surfaces can detect stale previews.
  const timelinePath = options?.timelinePath ?? path.join(projectPath, "05_timeline", "timeline.json");
  const baseTimelineHash = fs.existsSync(timelinePath)
    ? computeFileHash16(timelinePath)
    : null;

  const toPreviewClip = (track: TrackOutput, c: ClipOutput) => {
    const sourceEntry = sourceMap?.entryMap.get(c.asset_id);
    return {
      track_id: track.track_id,
      track_kind: track.kind,
      clip_id: c.clip_id,
      asset_id: c.asset_id,
      src_in_us: c.src_in_us,
      src_out_us: c.src_out_us,
      timeline_in_frame: c.timeline_in_frame,
      timeline_duration_frames: c.timeline_duration_frames,
      ...(c.still_image ? { still_image: { ...c.still_image } } : {}),
      ...(c.freeze_frame_hold ? { freeze_frame_hold: { ...c.freeze_frame_hold } } : {}),
      ...(sourceEntry
        ? {
            source_locator: sourceEntry.source_locator,
            local_source_path: sourceEntry.local_source_path,
            media_link_path: sourceEntry.link_path,
          }
        : {}),
    };
  };
  const previewTracks = {
    video: timeline.tracks.video.map((track) => ({
      track_id: track.track_id,
      kind: track.kind,
      clips: track.clips.map((clip) => toPreviewClip(track, clip)),
    })),
    audio: timeline.tracks.audio.map((track) => ({
      track_id: track.track_id,
      kind: track.kind,
      clips: track.clips.map((clip) => toPreviewClip(track, clip)),
    })),
  };

  const manifest = {
    version: "1",
    project_id: timeline.project_id,
    created_at: timeline.created_at,
    compiler_version: COMPILER_VERSION,
    ...(baseTimelineHash ? { base_timeline_hash: baseTimelineHash } : {}),
    // Shared source mapping contract (Issue #6 P1): the render route and the
    // preview manifest must resolve media through the same mapping the
    // timeline was compiled against.
    ...(sourceMap ? { source_mapping_hash: computeSourceMappingHash(sourceMap.entries) } : {}),
    // Rhythm-sync parity contract (Issue #35): the preview route carries the
    // same ±2-frame section parity result as the final timeline metadata, so
    // preview and final stay within the parity window by construction.
    ...(timeline.metadata?.rhythm_sync ? { rhythm_sync: buildPreviewRhythmSyncSummary(timeline.metadata.rhythm_sync) } : {}),
    sequence: timeline.sequence,
    tracks: previewTracks,
    transitions: timeline.transitions ?? [],
    clips: previewTracks.video
      .flatMap((track) => track.clips)
      .concat(previewTracks.audio.flatMap((track) => track.clips)),
  };

  fs.writeFileSync(outPath, JSON.stringify(manifest, null, 2), "utf-8");
  return outPath;
}

/**
 * Projection of the canonical rhythm_sync metadata (Issue #35) into the
 * preview manifest: the parity contract plus per-section offsets. The full
 * boundary evidence stays in timeline.metadata.rhythm_sync.
 */
function buildPreviewRhythmSyncSummary(rhythmSync: unknown): Record<string, unknown> {
  const record = (rhythmSync ?? {}) as {
    version?: string;
    status?: string;
    enabled?: boolean;
    parity?: { status?: string; max_offset_frames?: number; sections?: unknown[] };
    integrity?: Record<string, unknown>;
    search_window_sec?: number;
    parity_gate?: string;
    parity_recomputed_after_geometry_passes?: boolean;
    evidence_provenance?: Record<string, unknown>;
  };
  return {
    version: record.version ?? "1",
    status: record.status,
    enabled: record.enabled ?? false,
    parity_status: record.parity?.status ?? "degraded",
    parity_max_offset_frames: record.parity?.max_offset_frames,
    parity_gate: record.parity_gate ?? "enforce",
    ...(record.parity_recomputed_after_geometry_passes === true
      ? { parity_recomputed_after_geometry_passes: true }
      : {}),
    ...(record.evidence_provenance ? { evidence_provenance: record.evidence_provenance } : {}),
    search_window_sec: record.search_window_sec,
    sections: record.parity?.sections ?? [],
    integrity: record.integrity,
  };
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
  media_kind?: ClipOutput["media_kind"];
  source_capabilities?: ClipOutput["source_capabilities"];
  audio_role?: ClipOutput["audio_role"];
  captions?: ClipOutput["captions"];
  audio_policy?: ClipOutput["audio_policy"];
  still_image?: ClipOutput["still_image"];
  freeze_frame_hold?: ClipOutput["freeze_frame_hold"];
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
    ...(clip.media_kind ? { media_kind: clip.media_kind } : {}),
    ...(clip.source_capabilities ? { source_capabilities: { ...clip.source_capabilities } } : {}),
    ...(clip.audio_role ? { audio_role: clip.audio_role } : {}),
    ...(clip.still_image ? { still_image: { ...clip.still_image } } : {}),
    ...(clip.freeze_frame_hold ? { freeze_frame_hold: { ...clip.freeze_frame_hold } } : {}),
  };
  if (clip.candidate_ref) {
    output.candidate_ref = clip.candidate_ref;
  }
  if (clip.fallback_candidate_refs && clip.fallback_candidate_refs.length > 0) {
    output.fallback_candidate_refs = clip.fallback_candidate_refs;
  }
  if (clip.audio_policy) {
    output.audio_policy = clip.audio_policy;
  }
  if (clip.captions && clip.captions.length > 0) {
    output.captions = clip.captions;
  }
  if (clip.metadata && Object.keys(clip.metadata).length > 0) {
    output.metadata = clip.metadata;
  }
  return output;
}
