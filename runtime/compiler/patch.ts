// Review Patch Applicator
// Applies roughcut-critic review patches to a compiled timeline.
// After all ops, re-runs Phase 4 constraint resolution.
// Deterministic: same patch + same timeline = same output.

import { resolve, type ResolutionReport } from "./resolve.js";
import type { AudioFinishPolicy } from "../audio/dialogue-finishing.js";
import type {
  AssembledTimeline,
  AudioPolicy,
  Candidate,
  ClipOutput,
  ClipRole,
  DurationPolicy,
  Marker,
  TimelineClip,
  TimelineIR,
  TrackOutput,
} from "./types.js";
import { candidateSupportsVisual, inferAudioRole, isAudioOnlyCandidate } from "../artifacts/source-media-capabilities.js";
import { assertStillImageTimelineTruthForTimeline } from "./still-image.js";
import { assertHookPatchOperationAllowed, HookLockViolationError } from "./hook-lock.js";
import type { ContentElementV1 } from "../content/types.js";

// ── Patch document types ────────────────────────────────────────────

export type PatchOpType =
  | "replace_segment"
  | "trim_segment"
  | "move_segment"
  | "split_segment"
  | "set_transition"
  | "insert_segment"
  | "remove_segment"
  | "change_audio_policy"
  | "change_visual_transform"
  | "change_audio_finish"
  | "add_overlay"
  | "update_overlay"
  | "remove_overlay"
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
  target_track_id?: string;
  from_clip_id?: string;
  to_clip_id?: string;
  track_id?: string;
  transition_type?: string;
  transition_frames?: number;
  transition_params?: Record<string, unknown>;
  applied_skill_id?: string;
  reason: string;
  confidence?: number;
  evidence?: string[];
  audio_policy?: AudioPolicy;
  visual_transform?: {
    zoom?: number;
    crop?: { x: number; y: number; width: number; height: number };
    position?: { x: number; y: number };
  };
  audio_finish?: AudioFinishPolicy;
  beat_id?: string;
  role?: string;
  label?: string;
  with_candidate_ref?: string;
  ripple?: boolean;
  overlay?: {
    clip_id: string;
    timeline_in_frame: number;
    timeline_duration_frames: number;
    beat_id?: string;
    track_id?: string;
    content_element: ContentElementV1;
  };
}

export interface ReviewPatch {
  patch_version?: "review-patch/v2";
  timeline_version: string;
  base_timeline_sha256?: string;
  status?: "accepted" | "proposed" | "rejected";
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
  resolution: ResolutionReport;
}

// ── Helpers ──────────────────────────────────────────────────────────

function allTracks(timeline: TimelineIR): TrackOutput[] {
  return [
    ...timeline.tracks.video,
    ...timeline.tracks.audio,
    ...(timeline.tracks.overlay ?? []),
    ...(timeline.tracks.caption ?? []),
  ];
}

function findClip(
  timeline: TimelineIR,
  clipId: string,
): { track: TrackOutput; clipIndex: number; clip: ClipOutput } | null {
  for (const track of allTracks(timeline)) {
    const idx = track.clips.findIndex((c) => c.clip_id === clipId);
    if (idx !== -1) {
      return { track, clipIndex: idx, clip: track.clips[idx] };
    }
  }
  return null;
}

function findTrack(timeline: TimelineIR, trackId: string): TrackOutput | null {
  const track = allTracks(timeline).find((item) => item.track_id === trackId);
  if (track) return track;
  return null;
}

function trackGroupForKind(timeline: TimelineIR, kind: TrackOutput["kind"]): TrackOutput[] {
  if (kind === "audio") return timeline.tracks.audio;
  if (kind === "overlay") return timeline.tracks.overlay ??= [];
  if (kind === "caption") return timeline.tracks.caption ??= [];
  return timeline.tracks.video;
}

function findOrCreateCompatibleTrack(
  timeline: TimelineIR,
  sourceTrack: TrackOutput,
  targetTrackId: string,
): TrackOutput | PatchError {
  const existing = findTrack(timeline, targetTrackId);
  if (existing) {
    if (existing.kind !== sourceTrack.kind) {
      return {
        op_index: -1,
        op: "move_segment",
        message: `Target track ${targetTrackId} is ${existing.kind}, expected ${sourceTrack.kind}`,
      };
    }
    return existing;
  }

  return findOrCreateTrackByKind(timeline, sourceTrack.kind, targetTrackId);
}

function findOrCreateTrackByKind(
  timeline: TimelineIR,
  kind: TrackOutput["kind"],
  targetTrackId: string,
): TrackOutput {
  const group = trackGroupForKind(timeline, kind);
  const existing = group.find((item) => item.track_id === targetTrackId);
  if (existing) return existing;

  const track: TrackOutput = {
    track_id: targetTrackId,
    kind,
    clips: [],
  };
  group.push(track);
  group.sort((a, b) => a.track_id.localeCompare(b.track_id));
  return track;
}

function sortTrackClips(track: TrackOutput): void {
  track.clips.sort((a, b) => {
    const diff = a.timeline_in_frame - b.timeline_in_frame;
    if (diff !== 0) return diff;
    return a.clip_id.localeCompare(b.clip_id);
  });
}

function removeTransitionsForClip(timeline: TimelineIR, clipId: string): void {
  if (!timeline.transitions) return;
  timeline.transitions = timeline.transitions.filter(
    (transition) => transition.from_clip_id !== clipId && transition.to_clip_id !== clipId,
  );
}

function generateClipId(timeline: TimelineIR): string {
  let maxNum = 0;
  for (const track of allTracks(timeline)) {
    for (const clip of track.clips) {
      const match = clip.clip_id.match(/^CLP_(\d+)$/);
      if (match) {
        const num = parseInt(match[1], 10);
        if (num > maxNum) maxNum = num;
      }
    }
  }
  return `CLP_${String(maxNum + 1).padStart(4, "0")}`;
}

function transitionIdFor(trackId: string, fromClipId: string, toClipId: string): string {
  const stable = `${trackId}_${fromClipId}_${toClipId}`
    .replace(/[^A-Za-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return `patch_tr_${stable || "transition"}`;
}

function sortTransitions(timeline: TimelineIR): void {
  timeline.transitions?.sort((a, b) => {
    if (a.track_id !== b.track_id) return a.track_id.localeCompare(b.track_id);
    const aClip = findClip(timeline, a.from_clip_id)?.clip;
    const bClip = findClip(timeline, b.from_clip_id)?.clip;
    const aBoundary = aClip ? aClip.timeline_in_frame + aClip.timeline_duration_frames : 0;
    const bBoundary = bClip ? bClip.timeline_in_frame + bClip.timeline_duration_frames : 0;
    if (aBoundary !== bBoundary) return aBoundary - bBoundary;
    if (a.from_clip_id !== b.from_clip_id) return a.from_clip_id.localeCompare(b.from_clip_id);
    return a.to_clip_id.localeCompare(b.to_clip_id);
  });
}

function cloneClip(clip: ClipOutput): ClipOutput {
  return JSON.parse(JSON.stringify(clip));
}

function sourceTimeAtTimelineFrame(clip: ClipOutput, frame: number): number | null {
  const sourceDurationUS = clip.src_out_us - clip.src_in_us;
  if (sourceDurationUS <= 0 || clip.timeline_duration_frames <= 0) {
    return null;
  }
  const frameOffset = frame - clip.timeline_in_frame;
  if (frameOffset <= 0 || frameOffset >= clip.timeline_duration_frames) {
    return null;
  }
  return clip.src_in_us + Math.round((sourceDurationUS * frameOffset) / clip.timeline_duration_frames);
}

function splitCaptions(
  captions: ClipOutput["captions"],
  clipTimelineInFrame: number,
  splitFrame: number,
  clipTimelineOutFrame: number,
): { left?: ClipOutput["captions"]; right?: ClipOutput["captions"] } {
  if (!captions || captions.length === 0) {
    return {};
  }

  const left: NonNullable<ClipOutput["captions"]> = [];
  const right: NonNullable<ClipOutput["captions"]> = [];

  for (const caption of captions) {
    const leftIn = Math.max(clipTimelineInFrame, caption.in_frame);
    const leftOut = Math.min(splitFrame, caption.out_frame);
    if (leftOut > leftIn) {
      left.push({ ...caption, in_frame: leftIn, out_frame: leftOut });
    }

    const rightIn = Math.max(splitFrame, caption.in_frame);
    const rightOut = Math.min(clipTimelineOutFrame, caption.out_frame);
    if (rightOut > rightIn) {
      right.push({ ...caption, in_frame: rightIn, out_frame: rightOut });
    }
  }

  return {
    left: left.length > 0 ? left : undefined,
    right: right.length > 0 ? right : undefined,
  };
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

function candidateSupportsTrack(candidate: Candidate, trackKind: TrackOutput["kind"]): boolean {
  if (trackKind === "video") return candidateSupportsVisual(candidate);
  if (candidate.source_capabilities) return candidate.source_capabilities.has_audio === true;
  // Legacy selects predate source capabilities. Preserve the established
  // dialogue/music-to-audio route only when the semantic intent is explicit.
  return candidate.role === "dialogue" || candidate.audio_role === "music";
}

// ── Patch applicator ────────────────────────────────────────────────

export function applyPatch(
  timeline: TimelineIR,
  patch: ReviewPatch,
  candidates: Candidate[],
  targetDurationFrames?: number,
  durationPolicy?: DurationPolicy,
  fpsNum?: number,
  fpsDen?: number,
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
      resolution: {
        resolved_overlaps: 0,
        resolved_duplicates: 0,
        resolved_invalid_ranges: 0,
        duration_fit: true,
        total_frames: 0,
        target_frames: 0,
        content_frames: 0,
        content_fill_ratio: 1,
        gap_frames: 0,
        gap_count: 0,
        beat_fill: [],
      },
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
    try {
      assertHookPatchOperationAllowed(patched, op);
    } catch (error) {
      if (error instanceof HookLockViolationError) {
        errors.push({ op_index: i, op: op.op, message: error.message });
        continue;
      }
      throw error;
    }
    const err = applyOp(patched, op, candidateMap, i, targetDurationFrames);
    if (err) {
      errors.push(err);
    } else {
      appliedOps++;
    }
  }

  // 5. Re-run Phase 4 constraint resolution with blueprint target
  const resolution = reRunPhase4(patched, candidates, targetDurationFrames, durationPolicy, fpsNum, fpsDen);
  assertStillImageTimelineTruthForTimeline(patched);

  // 6. Increment version
  const currentVersion = parseInt(patched.version, 10);
  patched.version = isNaN(currentVersion) ? "2" : String(currentVersion + 1);

  return { timeline: patched, appliedOps, errors, resolution };
}

// ── Operation dispatcher ────────────────────────────────────────────

function applyOp(
  timeline: TimelineIR,
  op: PatchOperation,
  candidateMap: Map<string, Candidate>,
  index: number,
  targetDurationFrames?: number,
): PatchError | null {
  switch (op.op) {
    case "replace_segment":
      return opReplaceSegment(timeline, op, candidateMap, index);
    case "trim_segment":
      return opTrimSegment(timeline, op, index);
    case "move_segment":
      return opMoveSegment(timeline, op, index, targetDurationFrames);
    case "split_segment":
      return opSplitSegment(timeline, op, index);
    case "set_transition":
      return opSetTransition(timeline, op, index);
    case "insert_segment":
      return opInsertSegment(timeline, op, candidateMap, index);
    case "remove_segment":
      return opRemoveSegment(timeline, op, index);
    case "change_audio_policy":
      return opChangeAudioPolicy(timeline, op, index);
    case "change_visual_transform":
      return opChangeVisualTransform(timeline, op, index);
    case "change_audio_finish":
      return opChangeAudioFinish(timeline, op, index);
    case "add_overlay":
      return opAddOverlay(timeline, op, index);
    case "update_overlay":
      return opUpdateOverlay(timeline, op, index);
    case "remove_overlay":
      return opRemoveOverlay(timeline, op, index);
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
  if (found.clip.media_kind === "image" || candidate.media_kind === "image") {
    return { op_index: index, op: op.op, message: "Still-image replacement is not supported; preserve source identity and recompile from selects." };
  }
  const candidateIsAudioOnly = isAudioOnlyCandidate(candidate);
  if (!candidateSupportsTrack(candidate, found.track.kind)) {
    return {
      op_index: index,
      op: op.op,
      message: `Cannot replace ${found.track.kind} clip ${op.target_clip_id} with candidate ${candidate.segment_id}: source lacks ${found.track.kind} capability`,
    };
  }
  const sourceInUS = op.new_src_in_us ?? candidate.src_in_us;
  const sourceOutUS = op.new_src_out_us ?? candidate.src_out_us;
  if (sourceInUS < candidate.src_in_us || sourceOutUS > candidate.src_out_us || sourceOutUS <= sourceInUS) {
    return {
      op_index: index,
      op: op.op,
      message: `Invalid replacement source range ${sourceInUS}-${sourceOutUS} for candidate ${candidate.segment_id}`,
    };
  }

  const clip = found.clip;
  if (clip.media_kind === "image") {
    return { op_index: index, op: op.op, message: "Still-image source ranges are immutable; adjust hold duration with move_segment.new_duration_frames." };
  }
  clip.segment_id = candidate.segment_id;
  clip.asset_id = candidate.asset_id;
  clip.src_in_us = sourceInUS;
  clip.src_out_us = sourceOutUS;
  clip.confidence = candidate.confidence;
  clip.quality_flags = candidate.quality_flags ?? [];
  clip.candidate_ref = op.with_candidate_ref ?? candidate.candidate_id ?? candidate.segment_id;
  clip.fallback_candidate_refs = [];
  clip.media_kind = candidate.media_kind;
  clip.source_capabilities = candidate.source_capabilities ? { ...candidate.source_capabilities } : undefined;
  clip.audio_role = candidateIsAudioOnly ? (candidate.audio_role ?? inferAudioRole(candidate)) : candidate.audio_role;
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
  if (clip.media_kind === "image") {
    return { op_index: index, op: op.op, message: "Still-image source ranges are immutable; adjust hold duration with move_segment.new_duration_frames." };
  }
  if (op.new_src_in_us !== undefined) clip.src_in_us = op.new_src_in_us;
  if (op.new_src_out_us !== undefined) clip.src_out_us = op.new_src_out_us;
  clip.motivation = `[patch:trim] ${op.reason}`;

  return null;
}

function opMoveSegment(
  timeline: TimelineIR,
  op: PatchOperation,
  index: number,
  targetDurationFrames?: number,
): PatchError | null {
  if (!op.target_clip_id) {
    return { op_index: index, op: op.op, message: "Missing target_clip_id" };
  }

  const found = findClip(timeline, op.target_clip_id);
  if (!found) {
    return { op_index: index, op: op.op, message: `Clip not found: ${op.target_clip_id}` };
  }

  const clip = found.clip;
  const originalTrack = found.track;
  const previousStart = clip.timeline_in_frame;
  const nextStart = op.new_timeline_in_frame ?? clip.timeline_in_frame;
  const nextDuration = op.new_duration_frames ?? clip.timeline_duration_frames;
  const requestedTrack = op.target_track_id && op.target_track_id !== originalTrack.track_id
    ? findTrack(timeline, op.target_track_id)
    : originalTrack;
  if (requestedTrack && requestedTrack.kind !== originalTrack.kind) {
    return {
      op_index: index,
      op: op.op,
      message: `Target track ${requestedTrack.track_id} is ${requestedTrack.kind}, expected ${originalTrack.kind}`,
    };
  }
  if (op.new_duration_frames !== undefined) {
    if (clip.media_kind === "image") {
      if (!clip.still_image) return { op_index: index, op: op.op, message: "Still-image metadata is missing." };
      if (op.new_duration_frames < clip.still_image.min_hold_frames || op.new_duration_frames > clip.still_image.max_hold_frames) {
        return { op_index: index, op: op.op, message: `Still-image hold must be within ${clip.still_image.min_hold_frames}-${clip.still_image.max_hold_frames} frames.` };
      }
    }
  }
  if (clip.media_kind === "image") {
    const range = stillImageBeatRange(timeline, clip, targetDurationFrames);
    if (nextStart < range.start) {
      return {
        op_index: index,
        op: op.op,
        message: `Still-image hold start ${nextStart} precedes beat boundary ${range.start}.`,
      };
    }
    if (range.end !== undefined && nextStart + nextDuration > range.end) {
      return {
        op_index: index,
        op: op.op,
        message: `Still-image hold end ${nextStart + nextDuration} exceeds beat boundary ${range.end}.`,
      };
    }
    const overlapTrack = requestedTrack;
    if (overlapTrack?.clips.some((other) => other.clip_id !== clip.clip_id &&
      nextStart < other.timeline_in_frame + other.timeline_duration_frames &&
      nextStart + nextDuration > other.timeline_in_frame)) {
      return { op_index: index, op: op.op, message: "Still-image move overlaps another clip on the target track." };
    }
  }
  if (op.new_timeline_in_frame !== undefined) {
    const frameDelta = op.new_timeline_in_frame - previousStart;
    clip.timeline_in_frame = op.new_timeline_in_frame;
    if (frameDelta !== 0) {
      for (const caption of clip.captions ?? []) {
        caption.in_frame += frameDelta;
        caption.out_frame += frameDelta;
      }
      if (originalTrack.kind === "video") {
        for (const marker of timeline.markers) {
          if (
            marker.kind === "beat" &&
            marker.frame === previousStart &&
            (marker.label === clip.beat_id || marker.label.startsWith(`${clip.beat_id}:`))
          ) {
            marker.frame += frameDelta;
          }
        }
      }
    }
  }
  if (op.new_duration_frames !== undefined) {
    clip.timeline_duration_frames = op.new_duration_frames;
    if (clip.media_kind === "image") {
      clip.still_image!.hold_frames = op.new_duration_frames;
      clip.still_image!.policy_clamp = "none";
    }
  }
  clip.motivation = `[patch:move] ${op.reason}`;

  if (op.target_track_id && op.target_track_id !== originalTrack.track_id) {
    const targetTrack = findOrCreateCompatibleTrack(timeline, originalTrack, op.target_track_id);
    if ("message" in targetTrack) {
      return { ...targetTrack, op_index: index };
    }
    originalTrack.clips.splice(found.clipIndex, 1);
    targetTrack.clips.push(clip);
    sortTrackClips(originalTrack);
    sortTrackClips(targetTrack);
    removeTransitionsForClip(timeline, clip.clip_id);
  } else {
    sortTrackClips(originalTrack);
  }

  return null;
}

function stillImageBeatRange(
  timeline: TimelineIR,
  clip: ClipOutput,
  targetDurationFrames?: number,
): { start: number; end?: number } {
  const beatMarkers = timeline.markers
    .filter((marker) => marker.kind === "beat")
    .sort((a, b) => a.frame - b.frame);
  const namedIndex = beatMarkers.findIndex((marker) =>
    marker.label === clip.beat_id || marker.label.startsWith(`${clip.beat_id}:`));
  const owningIndex = namedIndex >= 0
    ? namedIndex
    : beatMarkers.reduce((index, marker, markerIndex) =>
        marker.frame <= clip.timeline_in_frame ? markerIndex : index, -1);
  const start = owningIndex >= 0 ? beatMarkers[owningIndex].frame : 0;
  const end = owningIndex >= 0 && owningIndex + 1 < beatMarkers.length
    ? beatMarkers[owningIndex + 1].frame
    : typeof targetDurationFrames === "number" && targetDurationFrames > 0
      ? targetDurationFrames
      : undefined;
  return { start, ...(end !== undefined ? { end } : {}) };
}

function opSplitSegment(
  timeline: TimelineIR,
  op: PatchOperation,
  index: number,
): PatchError | null {
  if (!op.target_clip_id) {
    return { op_index: index, op: op.op, message: "Missing target_clip_id" };
  }
  if (op.new_timeline_in_frame === undefined) {
    return { op_index: index, op: op.op, message: "Missing new_timeline_in_frame for split" };
  }

  const found = findClip(timeline, op.target_clip_id);
  if (!found) {
    return { op_index: index, op: op.op, message: `Clip not found: ${op.target_clip_id}` };
  }

  const clip = found.clip;
  if (clip.media_kind === "image") {
    return { op_index: index, op: op.op, message: "Still-image clips cannot be split because their 0..1 source identity range is immutable." };
  }
  const splitFrame = op.new_timeline_in_frame;
  const clipOutFrame = clip.timeline_in_frame + clip.timeline_duration_frames;
  if (splitFrame <= clip.timeline_in_frame || splitFrame >= clipOutFrame) {
    return {
      op_index: index,
      op: op.op,
      message: `Split frame ${splitFrame} must be inside clip ${clip.clip_id} (${clip.timeline_in_frame}-${clipOutFrame})`,
    };
  }

  const splitSourceUS = sourceTimeAtTimelineFrame(clip, splitFrame);
  if (splitSourceUS === null || splitSourceUS <= clip.src_in_us || splitSourceUS >= clip.src_out_us) {
    return {
      op_index: index,
      op: op.op,
      message: `Split frame ${splitFrame} does not map to a valid source time for clip ${clip.clip_id}`,
    };
  }

  const originalSourceOutUS = clip.src_out_us;
  const originalDurationFrames = clip.timeline_duration_frames;
  const leftDurationFrames = splitFrame - clip.timeline_in_frame;
  const rightDurationFrames = clipOutFrame - splitFrame;
  if (leftDurationFrames <= 0 || rightDurationFrames <= 0 || leftDurationFrames + rightDurationFrames !== originalDurationFrames) {
    return { op_index: index, op: op.op, message: `Invalid split durations for clip ${clip.clip_id}` };
  }

  const rightClip = cloneClip(clip);
  rightClip.clip_id = generateClipId(timeline);
  rightClip.timeline_in_frame = splitFrame;
  rightClip.timeline_duration_frames = rightDurationFrames;
  rightClip.src_in_us = splitSourceUS;
  rightClip.src_out_us = originalSourceOutUS;
  rightClip.motivation = `[patch:split:right] ${op.reason}`;

  clip.timeline_duration_frames = leftDurationFrames;
  clip.src_out_us = splitSourceUS;
  clip.motivation = `[patch:split:left] ${op.reason}`;

  const captions = splitCaptions(
    rightClip.captions,
    clip.timeline_in_frame,
    splitFrame,
    clipOutFrame,
  );
  if (captions.left) {
    clip.captions = captions.left;
  } else {
    delete clip.captions;
  }
  if (captions.right) {
    rightClip.captions = captions.right;
  } else {
    delete rightClip.captions;
  }

  found.track.clips.splice(found.clipIndex + 1, 0, rightClip);
  found.track.clips.sort((a, b) => {
    const diff = a.timeline_in_frame - b.timeline_in_frame;
    if (diff !== 0) return diff;
    return a.clip_id.localeCompare(b.clip_id);
  });
  if (timeline.transitions) {
    timeline.transitions = timeline.transitions.map((transition) =>
      transition.from_clip_id === clip.clip_id
        ? { ...transition, from_clip_id: rightClip.clip_id }
        : transition,
    );
  }

  return null;
}

function opSetTransition(
  timeline: TimelineIR,
  op: PatchOperation,
  index: number,
): PatchError | null {
  if (!op.from_clip_id) {
    return { op_index: index, op: op.op, message: "Missing from_clip_id for transition" };
  }
  if (!op.to_clip_id) {
    return { op_index: index, op: op.op, message: "Missing to_clip_id for transition" };
  }
  if (!op.track_id) {
    return { op_index: index, op: op.op, message: "Missing track_id for transition" };
  }
  if (!op.transition_type) {
    return { op_index: index, op: op.op, message: "Missing transition_type" };
  }

  const track = findTrack(timeline, op.track_id);
  if (!track) {
    return { op_index: index, op: op.op, message: `Track not found: ${op.track_id}` };
  }

  const fromClip = track.clips.find((clip) => clip.clip_id === op.from_clip_id);
  const toClip = track.clips.find((clip) => clip.clip_id === op.to_clip_id);
  if (!fromClip) {
    return { op_index: index, op: op.op, message: `From clip not found on ${op.track_id}: ${op.from_clip_id}` };
  }
  if (!toClip) {
    return { op_index: index, op: op.op, message: `To clip not found on ${op.track_id}: ${op.to_clip_id}` };
  }

  const boundary = fromClip.timeline_in_frame + fromClip.timeline_duration_frames;
  if (boundary !== toClip.timeline_in_frame) {
    return {
      op_index: index,
      op: op.op,
      message: `Transition clips must be adjacent: ${op.from_clip_id} ends at ${boundary}, ${op.to_clip_id} starts at ${toClip.timeline_in_frame}`,
    };
  }

  const transitionFrames = op.transition_frames ?? op.new_duration_frames;
  if (transitionFrames === undefined || transitionFrames <= 0) {
    return { op_index: index, op: op.op, message: "transition_frames must be greater than 0" };
  }

  const handles = Math.min(fromClip.timeline_duration_frames, toClip.timeline_duration_frames);
  if (transitionFrames > handles) {
    return {
      op_index: index,
      op: op.op,
      message: `transition_frames ${transitionFrames} exceeds available clip handles ${handles}`,
    };
  }

  const existingIndex = timeline.transitions?.findIndex((transition) =>
    transition.track_id === op.track_id &&
    transition.from_clip_id === op.from_clip_id &&
    transition.to_clip_id === op.to_clip_id
  ) ?? -1;
  if (op.transition_type.toLowerCase() === "cut") {
    if (existingIndex >= 0) {
      timeline.transitions?.splice(existingIndex, 1);
      sortTransitions(timeline);
    }
    return null;
  }
  const existing = existingIndex >= 0 ? timeline.transitions?.[existingIndex] : undefined;
  const transition = {
    transition_id: existing?.transition_id ?? transitionIdFor(op.track_id, op.from_clip_id, op.to_clip_id),
    from_clip_id: op.from_clip_id,
    to_clip_id: op.to_clip_id,
    track_id: op.track_id,
    transition_type: op.transition_type,
    transition_frames: transitionFrames,
    ...(op.transition_params ? { transition_params: op.transition_params } : {}),
    ...(op.applied_skill_id ? { applied_skill_id: op.applied_skill_id } : {}),
    ...(op.confidence !== undefined ? { confidence: op.confidence } : {}),
  };

  if (!timeline.transitions) {
    timeline.transitions = [];
  }
  if (existingIndex >= 0) {
    timeline.transitions[existingIndex] = transition;
  } else {
    timeline.transitions.push(transition);
  }
  sortTransitions(timeline);

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
  if (candidate.media_kind === "image") {
    return { op_index: index, op: op.op, message: "Still-image insertion requires selects/blueprint hold resolution; recompile from selects." };
  }

  const role = op.role ?? (candidate.role === "reject" ? "support" : candidate.role);
  const candidateIsAudioOnly = isAudioOnlyCandidate(candidate);
  const audioRole = candidate.audio_role ?? inferAudioRole(candidate);
  const targetKind = candidateIsAudioOnly || role === "dialogue" || role === "music" ? "audio" : "video";
  const targetTrackId = op.target_track_id ?? (candidateIsAudioOnly
    ? audioRole === "dialogue" ? "A1" : audioRole === "music" ? "A2" : "A3"
    : getTargetTrackId(role));
  const existingTargetTrack = findTrack(timeline, targetTrackId);
  if (existingTargetTrack && existingTargetTrack.kind !== targetKind) {
    return {
      op_index: index,
      op: op.op,
      message: `Target track ${targetTrackId} is ${existingTargetTrack.kind}, expected ${targetKind}`,
    };
  }
  const track = existingTargetTrack ?? findOrCreateTrackByKind(timeline, targetKind, targetTrackId);
  if (!candidateSupportsTrack(candidate, track.kind)) {
    return {
      op_index: index,
      op: op.op,
      message: `Cannot insert candidate ${candidate.segment_id} on ${track.kind} track ${track.track_id}: source lacks ${track.kind} capability`,
    };
  }
  const sourceInUS = op.new_src_in_us ?? candidate.src_in_us;
  const sourceOutUS = op.new_src_out_us ?? candidate.src_out_us;
  if (sourceInUS < candidate.src_in_us || sourceOutUS > candidate.src_out_us || sourceOutUS <= sourceInUS) {
    return {
      op_index: index,
      op: op.op,
      message: `Invalid insert source range ${sourceInUS}-${sourceOutUS} for candidate ${candidate.segment_id}`,
    };
  }

  const insertFrame = op.new_timeline_in_frame ?? 0;
  const insertDuration = op.new_duration_frames ?? 24;
  if (op.ripple) rippleInsert(timeline, insertFrame, insertDuration);

  const newClip: ClipOutput = {
    clip_id: generateClipId(timeline),
    segment_id: candidate.segment_id,
    asset_id: candidate.asset_id,
    src_in_us: sourceInUS,
    src_out_us: sourceOutUS,
    timeline_in_frame: insertFrame,
    timeline_duration_frames: insertDuration,
    role,
    motivation: `[patch:insert] ${op.reason}`,
    beat_id: op.beat_id ?? "",
    fallback_segment_ids: [],
    confidence: candidate.confidence,
    quality_flags: candidate.quality_flags ?? [],
    media_kind: candidate.media_kind,
    source_capabilities: candidate.source_capabilities ? { ...candidate.source_capabilities } : undefined,
    audio_role: candidateIsAudioOnly ? audioRole : candidate.audio_role,
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
  const removedStart = found.clip.timeline_in_frame;
  const removedDuration = found.clip.timeline_duration_frames;
  found.track.clips.splice(found.clipIndex, 1);
  removeTransitionsForClip(timeline, op.target_clip_id);
  if (op.ripple) rippleRemove(timeline, removedStart, removedDuration);
  return null;
}

function mapRemovedPoint(frame: number, start: number, end: number): number {
  if (frame < start) return frame;
  if (frame >= end) return frame - (end - start);
  return start;
}

function sourceAtOffset(clip: ClipOutput, offsetFrames: number): number {
  if (offsetFrames <= 0) return clip.src_in_us;
  if (offsetFrames >= clip.timeline_duration_frames) return clip.src_out_us;
  const sourceDuration = clip.src_out_us - clip.src_in_us;
  return clip.src_in_us + Math.round(sourceDuration * offsetFrames / clip.timeline_duration_frames);
}

function allocateRippleClipId(usedIds: Set<string>, clipId: string, boundaryFrame: number): string {
  const base = `${clipId}__ripple_${boundaryFrame}`;
  let candidate = base;
  let suffix = 2;
  while (usedIds.has(candidate)) candidate = `${base}_${suffix++}`;
  usedIds.add(candidate);
  return candidate;
}

function sliceClip(
  clip: ClipOutput,
  sourceTimelineStart: number,
  sourceTimelineEnd: number,
  targetTimelineStart: number,
  clipId: string,
  mapCaptionFrame: (frame: number) => number,
): ClipOutput {
  const clipStart = clip.timeline_in_frame;
  const startOffset = sourceTimelineStart - clipStart;
  const endOffset = sourceTimelineEnd - clipStart;
  const sliced = structuredClone(clip);
  sliced.clip_id = clipId;
  sliced.src_in_us = sourceAtOffset(clip, startOffset);
  sliced.src_out_us = sourceAtOffset(clip, endOffset);
  sliced.timeline_in_frame = targetTimelineStart;
  sliced.timeline_duration_frames = sourceTimelineEnd - sourceTimelineStart;
  sliced.captions = clip.captions?.flatMap((caption) => {
    const captionStart = Math.max(caption.in_frame, sourceTimelineStart);
    const captionEnd = Math.min(caption.out_frame, sourceTimelineEnd);
    return captionEnd > captionStart
      ? [{ ...caption, in_frame: mapCaptionFrame(captionStart), out_frame: mapCaptionFrame(captionEnd) }]
      : [];
  });
  if (sliced.captions?.length === 0) delete sliced.captions;
  return sliced;
}

function rippleInsert(timeline: TimelineIR, frame: number, duration: number): void {
  const usedIds = new Set(allTracks(timeline).flatMap((track) => track.clips.map((clip) => clip.clip_id)));
  for (const track of allTracks(timeline)) {
    const mapped: ClipOutput[] = [];
    for (const clip of track.clips) {
      const clipStart = clip.timeline_in_frame;
      const clipEnd = clipStart + clip.timeline_duration_frames;
      if (clipStart < frame && clipEnd > frame) {
        mapped.push(sliceClip(clip, clipStart, frame, clipStart, clip.clip_id, (captionFrame) => captionFrame));
        mapped.push(sliceClip(
          clip,
          frame,
          clipEnd,
          frame + duration,
          allocateRippleClipId(usedIds, clip.clip_id, frame),
          (captionFrame) => captionFrame + duration,
        ));
      } else if (clipStart >= frame) {
        const shifted = structuredClone(clip);
        shifted.timeline_in_frame += duration;
        shifted.captions = shifted.captions?.map((caption) => ({
          ...caption,
          in_frame: caption.in_frame + duration,
          out_frame: caption.out_frame + duration,
        }));
        mapped.push(shifted);
      } else {
        mapped.push(clip);
      }
    }
    track.clips = mapped;
    sortTrackClips(track);
  }
  for (const marker of timeline.markers) if (marker.frame >= frame) marker.frame += duration;
}

function rippleRemove(timeline: TimelineIR, start: number, duration: number): void {
  const end = start + duration;
  const usedIds = new Set(allTracks(timeline).flatMap((track) => track.clips.map((clip) => clip.clip_id)));
  for (const track of allTracks(timeline)) {
    const retained: ClipOutput[] = [];
    for (const clip of track.clips) {
      const clipStart = clip.timeline_in_frame;
      const clipEnd = clipStart + clip.timeline_duration_frames;
      if (clipEnd <= start) {
        retained.push(clip);
        continue;
      }
      if (clipStart >= end) {
        const shifted = structuredClone(clip);
        shifted.timeline_in_frame -= duration;
        shifted.captions = shifted.captions?.map((caption) => ({
          ...caption,
          in_frame: caption.in_frame - duration,
          out_frame: caption.out_frame - duration,
        }));
        retained.push(shifted);
        continue;
      }

      const intervals: Array<{ sourceStart: number; sourceEnd: number; targetStart: number }> = [];
      if (clipStart < start) intervals.push({ sourceStart: clipStart, sourceEnd: Math.min(clipEnd, start), targetStart: clipStart });
      if (clipEnd > end) intervals.push({ sourceStart: Math.max(clipStart, end), sourceEnd: clipEnd, targetStart: Math.max(clipStart, end) - duration });
      if (intervals.length === 0) {
        removeTransitionsForClip(timeline, clip.clip_id);
        continue;
      }
      intervals.forEach((interval, intervalIndex) => {
        retained.push(sliceClip(
          clip,
          interval.sourceStart,
          interval.sourceEnd,
          interval.targetStart,
          intervalIndex === 0 ? clip.clip_id : allocateRippleClipId(usedIds, clip.clip_id, start),
          (captionFrame) => captionFrame >= end ? captionFrame - duration : captionFrame,
        ));
      });
    }
    track.clips = retained;
    sortTrackClips(track);
  }
  timeline.markers = timeline.markers.map((marker) => ({ ...marker, frame: mapRemovedPoint(marker.frame, start, end) }));
}

function overlayTrack(timeline: TimelineIR, trackId = "O1"): TrackOutput {
  const existing = findTrack(timeline, trackId);
  if (existing) {
    if (existing.kind !== "overlay") throw new Error(`Overlay track ${trackId} has incompatible kind ${existing.kind}`);
    return existing;
  }
  return findOrCreateTrackByKind(timeline, "overlay", trackId);
}

function opAddOverlay(timeline: TimelineIR, op: PatchOperation, index: number): PatchError | null {
  const overlay = op.overlay;
  if (!overlay) return { op_index: index, op: op.op, message: "Missing overlay" };
  if (findClip(timeline, overlay.clip_id)) return { op_index: index, op: op.op, message: `Overlay clip already exists: ${overlay.clip_id}` };
  const track = overlayTrack(timeline, overlay.track_id);
  track.clips.push({
    clip_id: overlay.clip_id,
    segment_id: `TXT_${overlay.content_element.element_id}`,
    asset_id: "__overlay__",
    src_in_us: 0,
    src_out_us: Math.max(1, Math.round(overlay.timeline_duration_frames * 1_000_000 * timeline.sequence.fps_den / timeline.sequence.fps_num)),
    timeline_in_frame: overlay.timeline_in_frame,
    timeline_duration_frames: overlay.timeline_duration_frames,
    role: "title",
    motivation: `[patch:add_overlay] ${op.reason}`,
    beat_id: overlay.beat_id ?? "",
    fallback_segment_ids: [],
    confidence: op.confidence ?? 1,
    quality_flags: [],
    metadata: { content_element: structuredClone(overlay.content_element) },
  });
  sortTrackClips(track);
  return null;
}

function opUpdateOverlay(timeline: TimelineIR, op: PatchOperation, index: number): PatchError | null {
  if (!op.target_clip_id) return { op_index: index, op: op.op, message: "Missing target_clip_id" };
  const found = findClip(timeline, op.target_clip_id);
  if (!found || found.track.kind !== "overlay") return { op_index: index, op: op.op, message: `Overlay clip not found: ${op.target_clip_id}` };
  const overlay = op.overlay;
  if (overlay?.beat_id !== undefined && op.beat_id !== undefined && overlay.beat_id !== op.beat_id) {
    return { op_index: index, op: op.op, message: "Conflicting overlay beat_id fields" };
  }
  if (overlay && op.new_timeline_in_frame !== undefined && overlay.timeline_in_frame !== op.new_timeline_in_frame) {
    return { op_index: index, op: op.op, message: "Conflicting overlay timeline_in_frame fields" };
  }
  if (overlay && op.new_duration_frames !== undefined && overlay.timeline_duration_frames !== op.new_duration_frames) {
    return { op_index: index, op: op.op, message: "Conflicting overlay duration fields" };
  }
  const requestedTracks = [overlay?.track_id, op.target_track_id, op.track_id].filter((value): value is string => value !== undefined);
  if (new Set(requestedTracks).size > 1) {
    return { op_index: index, op: op.op, message: "Conflicting overlay track fields" };
  }
  const nextClipId = overlay?.clip_id ?? found.clip.clip_id;
  const collision = findClip(timeline, nextClipId);
  if (collision && collision.clip !== found.clip) {
    return { op_index: index, op: op.op, message: `Overlay clip already exists: ${nextClipId}` };
  }
  const nextTimelineIn = overlay?.timeline_in_frame ?? op.new_timeline_in_frame ?? found.clip.timeline_in_frame;
  const nextDuration = overlay?.timeline_duration_frames ?? op.new_duration_frames ?? found.clip.timeline_duration_frames;
  const targetTrack = requestedTracks[0] ? overlayTrack(timeline, requestedTracks[0]) : found.track;
  found.clip.clip_id = nextClipId;
  found.clip.timeline_in_frame = nextTimelineIn;
  found.clip.timeline_duration_frames = nextDuration;
  found.clip.src_out_us = Math.max(1, Math.round(nextDuration * 1_000_000 * timeline.sequence.fps_den / timeline.sequence.fps_num));
  if (overlay?.beat_id !== undefined || op.beat_id !== undefined) found.clip.beat_id = overlay?.beat_id ?? op.beat_id!;
  if (op.role !== undefined) found.clip.role = op.role as ClipRole;
  if (overlay?.content_element) {
    found.clip.segment_id = `TXT_${overlay.content_element.element_id}`;
    found.clip.metadata = { ...(found.clip.metadata ?? {}), content_element: structuredClone(overlay.content_element) };
  }
  found.clip.motivation = `[patch:update_overlay] ${op.reason}`;
  if (targetTrack !== found.track) {
    found.track.clips.splice(found.clipIndex, 1);
    targetTrack.clips.push(found.clip);
  }
  sortTrackClips(found.track);
  if (targetTrack !== found.track) sortTrackClips(targetTrack);
  return null;
}

function opRemoveOverlay(timeline: TimelineIR, op: PatchOperation, index: number): PatchError | null {
  if (!op.target_clip_id) return { op_index: index, op: op.op, message: "Missing target_clip_id" };
  const found = findClip(timeline, op.target_clip_id);
  if (!found || found.track.kind !== "overlay") return { op_index: index, op: op.op, message: `Overlay clip not found: ${op.target_clip_id}` };
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
  if (found.clip.media_kind === "image") {
    return { op_index: index, op: op.op, message: "Still images have no audio policy and cannot fabricate audio." };
  }

  if (op.audio_policy) {
    found.clip.audio_policy = op.audio_policy;
  }

  return null;
}

function opChangeVisualTransform(
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
  if (found.track.kind !== "video") {
    return { op_index: index, op: op.op, message: "Visual transforms require a video clip" };
  }
  if (found.clip.media_kind === "image") {
    return { op_index: index, op: op.op, message: "Still-image visual transforms are pending EYE-070C2B; C2A is static-only." };
  }
  const transform = op.visual_transform;
  if (!transform || Object.keys(transform).length === 0) {
    return { op_index: index, op: op.op, message: "Missing visual_transform" };
  }
  found.clip.metadata = {
    ...(found.clip.metadata ?? {}),
    ...(transform.zoom !== undefined ? { zoom: transform.zoom } : {}),
    ...(transform.crop !== undefined ? { crop: transform.crop } : {}),
    ...(transform.position !== undefined ? { position: transform.position } : {}),
    interview_finish: {
      reason: op.reason,
      ...(op.confidence !== undefined ? { confidence: op.confidence } : {}),
    },
  };
  return null;
}

function opChangeAudioFinish(
  timeline: TimelineIR,
  op: PatchOperation,
  index: number,
): PatchError | null {
  if (!op.audio_finish) {
    return { op_index: index, op: op.op, message: "Missing audio_finish" };
  }
  timeline.metadata = {
    ...(timeline.metadata ?? {}),
    audio_finish: op.audio_finish,
  };
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
// When targetDurationFrames is provided (from edit_blueprint.yaml),
// it is used as the duration target so post-patch duration violations
// are correctly detected.

function reRunPhase4(
  timeline: TimelineIR,
  candidates: Candidate[],
  targetDurationFrames?: number,
  durationPolicy?: DurationPolicy,
  fpsNum?: number,
  fpsDen?: number,
): ResolutionReport {
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

  // Use blueprint target if provided; otherwise fall back to timeline extent
  let target: number;
  if (targetDurationFrames !== undefined && targetDurationFrames > 0) {
    target = targetDurationFrames;
  } else {
    let maxFrame = 0;
    for (const track of [...timeline.tracks.video, ...timeline.tracks.audio]) {
      for (const clip of track.clips) {
        const end = clip.timeline_in_frame + clip.timeline_duration_frames;
        if (end > maxFrame) maxFrame = end;
      }
    }
    target = maxFrame;
  }

  // Phase 4 only repairs constraints. It must never synthesize an image from a
  // fallback candidate because that route has neither the blueprint's resolved
  // hold policy nor a legal 0..1 still source identity. Image insertion remains
  // a selects -> compile operation; existing image clips are preserved in-place
  // by resolve's still-specific skip rules.
  const phase4Candidates = candidates.filter((candidate) => candidate.media_kind !== "image");
  return resolve(assembled, target, phase4Candidates, durationPolicy, fpsNum, fpsDen);
}
