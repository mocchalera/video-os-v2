import type {
  AssembledTimeline,
  IntentionalGapOperation,
  PrimaryAudioMixPolicy,
  TimelineClip,
  Track,
} from "./types.js";
import { hasVisualProgram, isAuthoredProgramAudio } from "./primary-content.js";

export interface GapClipContext {
  clip_id: string;
  beat_id: string;
  timeline_in_frame: number;
  timeline_end_frame: number;
}

/**
 * Uncovered interval on a primary track. The shape is shared by the primary
 * video (V1) and primary audio (A1) invariants; `track_id` distinguishes them.
 */
export interface PrimaryTrackGap {
  track_id: string;
  start_frame: number;
  end_frame: number;
  duration_frames: number;
  previous_clip?: GapClipContext;
  next_clip?: GapClipContext;
  previous_beat_id?: string;
  next_beat_id?: string;
  recommended_fix: string;
}

export type PrimaryVideoGap = PrimaryTrackGap;
export type PrimaryAudioGap = PrimaryTrackGap;

export interface IntentionalGapOperationValidation {
  operation: IntentionalGapOperation;
  valid: boolean;
  errors: string[];
}

export interface PrimaryAudioMixPolicyValidation {
  policy: PrimaryAudioMixPolicy;
  valid: boolean;
  errors: string[];
}

export function primaryVideoTrack(timeline: AssembledTimeline): Track | undefined {
  return timeline.tracks.video.find((track) => track.track_id === "V1")
    ?? timeline.tracks.video[0];
}

/** The primary audio lane: A1, or the first audio track when A1 is absent. */
export function primaryAudioTrack(timeline: AssembledTimeline): Track | undefined {
  return timeline.tracks.audio.find((track) => track.track_id === "A1")
    ?? timeline.tracks.audio[0];
}

export function primaryVideoEndFrame(timeline: AssembledTimeline): number {
  return (primaryVideoTrack(timeline)?.clips ?? []).reduce(
    (end, clip) => Math.max(end, clip.timeline_in_frame + clip.timeline_duration_frames),
    0,
  );
}

export function validateIntentionalGapOperation(
  operation: IntentionalGapOperation,
): IntentionalGapOperationValidation {
  const errors: string[] = [];
  if (typeof operation.operation_id !== "string" || !operation.operation_id.trim()) {
    errors.push("operation_id must be a non-empty string");
  }
  if (typeof operation.track_id !== "string" || operation.track_id.trim() === "") {
    errors.push("track_id must be a non-empty string");
  }
  if (![
    "gap",
    "hold",
    "freeze",
    "ambient_continuation",
  ].includes(operation.type)) {
    errors.push("type must be gap, hold, freeze, or ambient_continuation");
  }
  if (![
    "blueprint",
    "human_golden_order",
    "operator",
    "compiler",
  ].includes(operation.authority)) {
    errors.push("authority must be blueprint, human_golden_order, operator, or compiler");
  }
  if (!Number.isInteger(operation.start_frame) || operation.start_frame < 0) {
    errors.push("start_frame must be a non-negative integer");
  }
  if (!Number.isInteger(operation.duration_frames) || operation.duration_frames <= 0) {
    errors.push("duration_frames must be a positive integer");
  }
  if (typeof operation.reason !== "string" || !operation.reason.trim()) errors.push("reason must be non-empty");
  return { operation, valid: errors.length === 0, errors };
}

/**
 * Validate an explicit primary-audio mix policy (Issue #6 P0). A valid policy
 * declares that the primary audio lane is intentionally not wall-to-wall, so
 * sparse A1 coverage is authorized without a per-range operation.
 */
export function validatePrimaryAudioMixPolicy(
  policy: PrimaryAudioMixPolicy,
): PrimaryAudioMixPolicyValidation {
  const errors: string[] = [];
  if (typeof policy?.policy !== "string" || policy.policy !== "primary-audio-mix/v1") {
    errors.push('policy must be "primary-audio-mix/v1"');
  }
  if (policy?.mode !== "selective_authorization") {
    errors.push('mode must be "selective_authorization"');
  }
  if (![
    "blueprint",
    "human_golden_order",
    "operator",
  ].includes(policy?.authority as never)) {
    errors.push("authority must be blueprint, human_golden_order, or operator");
  }
  if (typeof policy?.reason !== "string" || !policy.reason.trim()) {
    errors.push("reason must be non-empty");
  }
  return { policy, valid: errors.length === 0, errors };
}

/**
 * Return every uncovered interval on the primary video track in [0, target).
 * An interval is exempt only when one valid, authority-bearing explicit
 * operation covers it completely. Overlaps are treated as coverage; they do
 * not hide a hole between the union of clips.
 */
export function findPrimaryVideoGaps(
  timeline: AssembledTimeline,
  targetEndFrame: number,
): PrimaryVideoGap[] {
  if (targetEndFrame <= 0) return [];
  const track = primaryVideoTrack(timeline);
  return scanPrimaryGaps(
    track?.clips ?? [],
    track?.track_id ?? "V1",
    targetEndFrame,
    timeline.operations ?? [],
    "video",
  );
}

/**
 * Return every unintended silent interval on the primary audio program.
 *
 * With a visual program the primary audio lane is A1: any hole under picture
 * renders as silence, so it must be covered or explicitly authorized.
 * Without picture, the union of authored audio lanes is the program; holes
 * between authored clips are equally audible.
 *
 * A timeline that declares no audio tracks at all has no primary lane to
 * enforce; the video invariant still covers its picture.
 */
export function findPrimaryAudioGaps(
  timeline: AssembledTimeline,
  targetEndFrame: number,
): PrimaryAudioGap[] {
  if (targetEndFrame <= 0 || timeline.tracks.audio.length === 0) return [];
  if (hasVisualProgram(timeline)) {
    const track = primaryAudioTrack(timeline);
    return scanPrimaryGaps(
      track?.clips ?? [],
      track?.track_id ?? "A1",
      targetEndFrame,
      timeline.operations ?? [],
      "audio",
    );
  }
  const authored = timeline.tracks.audio
    .flatMap((track) => track.clips)
    .filter(isAuthoredProgramAudio)
    .filter((clip) => clip.timeline_duration_frames > 0);
  return scanPrimaryGaps(
    authored,
    primaryAudioTrack(timeline)?.track_id ?? "A1",
    targetEndFrame,
    timeline.operations ?? [],
    "audio",
  );
}

function scanPrimaryGaps(
  clips: TimelineClip[],
  trackId: string,
  targetEndFrame: number,
  operations: IntentionalGapOperation[],
  flavor: "video" | "audio",
): PrimaryTrackGap[] {
  if (targetEndFrame <= 0) return [];
  const positive = clips
    .filter((clip) => clip.timeline_duration_frames > 0)
    .slice()
    .sort((left, right) =>
      left.timeline_in_frame - right.timeline_in_frame || left.clip_id.localeCompare(right.clip_id),
    );

  if (positive.length === 0) {
    return [buildGap(trackId, 0, targetEndFrame, undefined, undefined, flavor)];
  }

  const gaps: PrimaryTrackGap[] = [];
  let cursor = 0;
  let previous: TimelineClip | undefined;
  for (const clip of positive) {
    const start = Math.max(0, Math.min(targetEndFrame, clip.timeline_in_frame));
    const end = Math.max(0, Math.min(targetEndFrame, clip.timeline_in_frame + clip.timeline_duration_frames));
    if (end <= start) continue;
    if (start > cursor) {
      gaps.push(buildGap(trackId, cursor, start, previous, clip, flavor));
    }
    if (end > cursor) {
      cursor = end;
      previous = clip;
    }
  }
  if (cursor < targetEndFrame) {
    gaps.push(buildGap(trackId, cursor, targetEndFrame, previous, undefined, flavor));
  }

  return gaps.filter((gap) => !isExplicitlyAuthorized(gap, operations));
}

function buildGap(
  trackId: string,
  startFrame: number,
  endFrame: number,
  previous: TimelineClip | undefined,
  next: TimelineClip | undefined,
  flavor: "video" | "audio",
): PrimaryTrackGap {
  return {
    track_id: trackId,
    start_frame: startFrame,
    end_frame: endFrame,
    duration_frames: endFrame - startFrame,
    ...(previous ? {
      previous_clip: clipContext(previous),
      previous_beat_id: previous.beat_id,
    } : {}),
    ...(next ? {
      next_clip: clipContext(next),
      next_beat_id: next.beat_id,
    } : {}),
    recommended_fix: recommendedFix(flavor, next != null),
  };
}

/**
 * Video texts stay byte-identical to the pre-audio invariant wording because
 * remedy classification keys on their prefixes.
 */
function recommendedFix(flavor: "video" | "audio", hasNextClip: boolean): string {
  if (flavor === "audio") {
    const authorization =
      "authorize an explicit silence/ambient-continuation operation or a declared primary-audio mix policy";
    return hasNextClip
      ? `Place the next approved audio clip at the previous coverage end, or ${authorization}.`
      : `Extend or replace the final approved audio source range, or ${authorization}.`;
  }
  return hasNextClip
    ? "Place the next approved clip at the previous coverage end or authorize an explicit gap/hold operation."
    : "Extend or replace the final approved source range, or authorize an explicit gap/hold operation.";
}

function clipContext(clip: TimelineClip): GapClipContext {
  return {
    clip_id: clip.clip_id,
    beat_id: clip.beat_id,
    timeline_in_frame: clip.timeline_in_frame,
    timeline_end_frame: clip.timeline_in_frame + clip.timeline_duration_frames,
  };
}

function isExplicitlyAuthorized(
  gap: PrimaryTrackGap,
  operations: IntentionalGapOperation[],
): boolean {
  return operations.some((operation) => {
    const validation = validateIntentionalGapOperation(operation);
    if (!validation.valid || operation.track_id !== gap.track_id) return false;
    const operationEnd = operation.start_frame + operation.duration_frames;
    return operation.start_frame <= gap.start_frame && operationEnd >= gap.end_frame;
  });
}
