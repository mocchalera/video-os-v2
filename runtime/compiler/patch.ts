// Review Patch Applicator
// Applies roughcut-critic review patches to a compiled timeline.
// After all ops, re-runs Phase 4 constraint resolution.
// Deterministic: same patch + same timeline = same output.

import { resolve } from "./resolve.js";
import type {
  AssembledTimeline,
  AudioPolicy,
  Candidate,
  ClipOutput,
  ClipRole,
  Marker,
  TimelineClip,
  TimelineIR,
  TrackOutput,
} from "./types.js";

// ── Patch document types ────────────────────────────────────────────

export type PatchOpType =
  | "replace_segment"
  | "trim_segment"
  | "move_segment"
  | "insert_segment"
  | "remove_segment"
  | "change_audio_policy"
  | "add_marker"
  | "add_note";

export interface PatchOperation {
  op: PatchOpType;
  target_clip_id?: string;
  with_segment_id?: string;
  new_src_in_us?: number;
  new_src_out_us?: number;
  new_timeline_in_frame?: number;
  new_duration_frames?: number;
  reason: string;
  confidence?: number;
  evidence?: string[];
  audio_policy?: AudioPolicy;
  beat_id?: string;
  role?: string;
  label?: string;
}

export interface ReviewPatch {
  timeline_version: string;
  operations: PatchOperation[];
}

export interface PatchError {
  op_index: number;
  op: string;
  message: string;
}

export interface PatchResult {
  timeline: TimelineIR;
  appliedOps: number;
  errors: PatchError[];
}

// ── Helpers ──────────────────────────────────────────────────────────

function findClip(
  timeline: TimelineIR,
  clipId: string,
): { track: TrackOutput; clipIndex: number; clip: ClipOutput } | null {
  for (const trackGroup of [timeline.tracks.video, timeline.tracks.audio]) {
    for (const track of trackGroup) {
      const idx = track.clips.findIndex((c) => c.clip_id === clipId);
      if (idx !== -1) {
        return { track, clipIndex: idx, clip: track.clips[idx] };
      }
    }
  }
  return null;
}

function generateClipId(timeline: TimelineIR): string {
  let maxNum = 0;
  for (const trackGroup of [timeline.tracks.video, timeline.tracks.audio]) {
    for (const track of trackGroup) {
      for (const clip of track.clips) {
        const match = clip.clip_id.match(/^CLP_(\d+)$/);
        if (match) {
          const num = parseInt(match[1], 10);
          if (num > maxNum) maxNum = num;
        }
      }
    }
  }
  return `CLP_${String(maxNum + 1).padStart(4, "0")}`;
}

function getTargetTrackId(role: string): string {
  switch (role) {
    case "hero":
      return "V1";
    case "dialogue":
      return "A1";
    case "music":
      return "A2";
    default:
      return "V2";
  }
}

// ── Patch applicator ────────────────────────────────────────────────

export function applyPatch(
  timeline: TimelineIR,
  patch: ReviewPatch,
  candidates: Candidate[],
): PatchResult {
  // 1. Version check — reject if patch targets a different version
  if (patch.timeline_version !== timeline.version) {
    return {
      timeline,
      appliedOps: 0,
      errors: [
        {
          op_index: -1,
          op: "version_check",
          message: `Patch targets version "${patch.timeline_version}" but timeline is version "${timeline.version}"`,
        },
      ],
    };
  }

  // 2. Deep clone to avoid mutating original
  const patched: TimelineIR = JSON.parse(JSON.stringify(timeline));

  // 3. Build candidate lookup
  const candidateMap = new Map<string, Candidate>();
  for (const c of candidates) {
    candidateMap.set(c.segment_id, c);
  }

  // 4. Apply each operation sequentially
  const errors: PatchError[] = [];
  let appliedOps = 0;

  for (let i = 0; i < patch.operations.length; i++) {
    const op = patch.operations[i];
    const err = applyOp(patched, op, candidateMap, i);
    if (err) {
      errors.push(err);
    } else {
      appliedOps++;
    }
  }

  // 5. Re-run Phase 4 constraint resolution
  reRunPhase4(patched, candidates);

  // 6. Increment version
  const currentVersion = parseInt(patched.version, 10);
  patched.version = isNaN(currentVersion) ? "2" : String(currentVersion + 1);

  return { timeline: patched, appliedOps, errors };
}

// ── Operation dispatcher ────────────────────────────────────────────

function applyOp(
  timeline: TimelineIR,
  op: PatchOperation,
  candidateMap: Map<string, Candidate>,
  index: number,
): PatchError | null {
  switch (op.op) {
    case "replace_segment":
      return opReplaceSegment(timeline, op, candidateMap, index);
    case "trim_segment":
      return opTrimSegment(timeline, op, index);
    case "move_segment":
      return opMoveSegment(timeline, op, index);
    case "insert_segment":
      return opInsertSegment(timeline, op, candidateMap, index);
    case "remove_segment":
      return opRemoveSegment(timeline, op, index);
    case "change_audio_policy":
      return opChangeAudioPolicy(timeline, op, index);
    case "add_marker":
      return opAddMarker(timeline, op, index, "review");
    case "add_note":
      return opAddMarker(timeline, op, index, "note");
    default:
      return { op_index: index, op: op.op, message: `Unknown operation: ${op.op}` };
  }
}

// ── Individual operation handlers ───────────────────────────────────

function opReplaceSegment(
  timeline: TimelineIR,
  op: PatchOperation,
  candidateMap: Map<string, Candidate>,
  index: number,
): PatchError | null {
  if (!op.target_clip_id) {
    return { op_index: index, op: op.op, message: "Missing target_clip_id" };
  }
  if (!op.with_segment_id) {
    return { op_index: index, op: op.op, message: "Missing with_segment_id" };
  }

  const found = findClip(timeline, op.target_clip_id);
  if (!found) {
    return { op_index: index, op: op.op, message: `Clip not found: ${op.target_clip_id}` };
  }

  const candidate = candidateMap.get(op.with_segment_id);
  if (!candidate) {
    return { op_index: index, op: op.op, message: `Candidate not found for segment: ${op.with_segment_id}` };
  }

  const clip = found.clip;
  clip.segment_id = candidate.segment_id;
  clip.asset_id = candidate.asset_id;
  clip.src_in_us = candidate.src_in_us;
  clip.src_out_us = candidate.src_out_us;
  clip.confidence = candidate.confidence;
  clip.quality_flags = candidate.quality_flags ?? [];
  clip.motivation = `[patch] ${op.reason}`;
  if (candidate.role !== "reject") {
    clip.role = candidate.role;
  }

  return null;
}

function opTrimSegment(
  timeline: TimelineIR,
  op: PatchOperation,
  index: number,
): PatchError | null {
  if (!op.target_clip_id) {
    return { op_index: index, op: op.op, message: "Missing target_clip_id" };
  }

  const found = findClip(timeline, op.target_clip_id);
  if (!found) {
    return { op_index: index, op: op.op, message: `Clip not found: ${op.target_clip_id}` };
  }

  const clip = found.clip;
  if (op.new_src_in_us !== undefined) clip.src_in_us = op.new_src_in_us;
  if (op.new_src_out_us !== undefined) clip.src_out_us = op.new_src_out_us;
  clip.motivation = `[patch:trim] ${op.reason}`;

  return null;
}

function opMoveSegment(
  timeline: TimelineIR,
  op: PatchOperation,
  index: number,
): PatchError | null {
  if (!op.target_clip_id) {
    return { op_index: index, op: op.op, message: "Missing target_clip_id" };
  }

  const found = findClip(timeline, op.target_clip_id);
  if (!found) {
    return { op_index: index, op: op.op, message: `Clip not found: ${op.target_clip_id}` };
  }

  const clip = found.clip;
  if (op.new_timeline_in_frame !== undefined) {
    clip.timeline_in_frame = op.new_timeline_in_frame;
  }
  if (op.new_duration_frames !== undefined) {
    clip.timeline_duration_frames = op.new_duration_frames;
  }
  clip.motivation = `[patch:move] ${op.reason}`;

  return null;
}

function opInsertSegment(
  timeline: TimelineIR,
  op: PatchOperation,
  candidateMap: Map<string, Candidate>,
  index: number,
): PatchError | null {
  if (!op.with_segment_id) {
    return { op_index: index, op: op.op, message: "Missing with_segment_id for insert" };
  }

  const candidate = candidateMap.get(op.with_segment_id);
  if (!candidate) {
    return { op_index: index, op: op.op, message: `Candidate not found for segment: ${op.with_segment_id}` };
  }

  const role = op.role ?? (candidate.role === "reject" ? "support" : candidate.role);
  const targetTrackId = getTargetTrackId(role);
  const trackGroup = role === "dialogue" || role === "music"
    ? timeline.tracks.audio
    : timeline.tracks.video;

  const track = trackGroup.find((t) => t.track_id === targetTrackId);
  if (!track) {
    return { op_index: index, op: op.op, message: `Target track not found: ${targetTrackId}` };
  }

  const newClip: ClipOutput = {
    clip_id: generateClipId(timeline),
    segment_id: candidate.segment_id,
    asset_id: candidate.asset_id,
    src_in_us: candidate.src_in_us,
    src_out_us: candidate.src_out_us,
    timeline_in_frame: op.new_timeline_in_frame ?? 0,
    timeline_duration_frames: op.new_duration_frames ?? 24,
    role,
    motivation: `[patch:insert] ${op.reason}`,
    beat_id: op.beat_id ?? "",
    fallback_segment_ids: [],
    confidence: candidate.confidence,
    quality_flags: candidate.quality_flags ?? [],
  };

  track.clips.push(newClip);
  // Sort by timeline_in_frame for deterministic ordering
  track.clips.sort((a, b) => {
    const diff = a.timeline_in_frame - b.timeline_in_frame;
    if (diff !== 0) return diff;
    return a.clip_id.localeCompare(b.clip_id);
  });

  return null;
}

function opRemoveSegment(
  timeline: TimelineIR,
  op: PatchOperation,
  index: number,
): PatchError | null {
  if (!op.target_clip_id) {
    return { op_index: index, op: op.op, message: "Missing target_clip_id" };
  }

  const found = findClip(timeline, op.target_clip_id);
  if (!found) {
    return { op_index: index, op: op.op, message: `Clip not found: ${op.target_clip_id}` };
  }

  found.track.clips.splice(found.clipIndex, 1);
  return null;
}

function opChangeAudioPolicy(
  timeline: TimelineIR,
  op: PatchOperation,
  index: number,
): PatchError | null {
  if (!op.target_clip_id) {
    return { op_index: index, op: op.op, message: "Missing target_clip_id" };
  }

  const found = findClip(timeline, op.target_clip_id);
  if (!found) {
    return { op_index: index, op: op.op, message: `Clip not found: ${op.target_clip_id}` };
  }

  if (op.audio_policy) {
    found.clip.audio_policy = op.audio_policy;
  }

  return null;
}

function opAddMarker(
  timeline: TimelineIR,
  op: PatchOperation,
  index: number,
  kind: "review" | "note",
): PatchError | null {
  if (op.new_timeline_in_frame === undefined) {
    return { op_index: index, op: op.op, message: "Missing new_timeline_in_frame for marker" };
  }

  timeline.markers.push({
    frame: op.new_timeline_in_frame,
    kind,
    label: op.label ?? op.reason,
  });

  // Sort markers by frame for deterministic ordering
  timeline.markers.sort((a, b) => {
    const diff = a.frame - b.frame;
    if (diff !== 0) return diff;
    return a.label.localeCompare(b.label);
  });

  return null;
}

// ── Phase 4 re-run ──────────────────────────────────────────────────
//
// Convert TimelineIR tracks to AssembledTimeline, run resolve(),
// mutations propagate back to the IR via shared array references.

function reRunPhase4(timeline: TimelineIR, candidates: Candidate[]): void {
  const assembled: AssembledTimeline = {
    tracks: {
      video: timeline.tracks.video.map((t) => ({
        track_id: t.track_id,
        kind: t.kind,
        clips: t.clips as unknown as TimelineClip[],
      })),
      audio: timeline.tracks.audio.map((t) => ({
        track_id: t.track_id,
        kind: t.kind,
        clips: t.clips as unknown as TimelineClip[],
      })),
    },
    markers: timeline.markers as Marker[],
  };

  // Calculate total target frames from timeline extent
  let maxFrame = 0;
  for (const track of [...timeline.tracks.video, ...timeline.tracks.audio]) {
    for (const clip of track.clips) {
      const end = clip.timeline_in_frame + clip.timeline_duration_frames;
      if (end > maxFrame) maxFrame = end;
    }
  }

  resolve(assembled, maxFrame, candidates);
}
