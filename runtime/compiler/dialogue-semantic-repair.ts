import type { SegmentItem } from "../connectors/ffmpeg-segmenter.js";
import {
  assessDialogueCompleteness,
  type DialogueCompletenessIssue,
} from "../editorial/dialogue-completeness.js";
import type { AssembledTimeline, TimelineClip } from "./types.js";
import type { UtteranceSpan } from "./trim.js";

export interface DialogueSemanticRepairOptions {
  maxIterations?: number;
  maxExtensionUs?: number;
  maxInterUtteranceGapUs?: number;
  repairSoftIssues?: boolean;
}

export interface DialogueRangeRepairResult {
  status: "unchanged" | "repaired" | "unresolved";
  src_in_us: number;
  src_out_us: number;
  attempts: number;
  added_utterance_count: number;
  issues_before: DialogueCompletenessIssue[];
  issues_after: DialogueCompletenessIssue[];
}

export interface AppliedDialogueSemanticRepair {
  attemptedClips: number;
  repairedClips: number;
  unresolvedClips: number;
  totalAddedFrames: number;
}

const DEFAULT_MAX_ITERATIONS = 4;
const DEFAULT_MAX_EXTENSION_US = 15_000_000;
const DEFAULT_MAX_GAP_US = 2_500_000;

/**
 * Expand a dialogue window one adjacent utterance at a time until its selected
 * text no longer starts or ends as a dependent fragment. The original range is
 * returned when the bounded loop cannot prove a complete repair.
 */
export function repairDialogueRange(
  srcInUs: number,
  srcOutUs: number,
  utterances: UtteranceSpan[],
  bounds: { min_us: number; max_us: number },
  options: DialogueSemanticRepairOptions = {},
): DialogueRangeRepairResult {
  const ordered = utterances
    .filter((item) => item.end_us > item.start_us && item.text?.trim())
    .slice()
    .sort((left, right) => left.start_us - right.start_us || left.end_us - right.end_us);
  const overlappingIndexes = ordered.flatMap((item, index) =>
    item.start_us < srcOutUs && srcInUs < item.end_us ? [index] : [],
  );
  if (overlappingIndexes.length === 0) {
    return unchanged(srcInUs, srcOutUs);
  }

  let first = overlappingIndexes[0];
  let last = overlappingIndexes.at(-1)!;
  const initialFirst = first;
  const initialLast = last;
  const issuesBefore = assessWindow(ordered, first, last);
  const repairSoftIssues = options.repairSoftIssues ?? true;
  if (!hasRepairableIssues(issuesBefore, repairSoftIssues)) {
    return {
      status: "unchanged",
      src_in_us: srcInUs,
      src_out_us: srcOutUs,
      attempts: 0,
      added_utterance_count: 0,
      issues_before: issuesBefore,
      issues_after: issuesBefore,
    };
  }

  const maxIterations = positiveInteger(options.maxIterations, DEFAULT_MAX_ITERATIONS);
  const maxExtensionUs = nonNegative(options.maxExtensionUs, DEFAULT_MAX_EXTENSION_US);
  const maxGapUs = nonNegative(options.maxInterUtteranceGapUs, DEFAULT_MAX_GAP_US);
  let attempts = 0;
  let issuesAfter = issuesBefore;

  while (attempts < maxIterations && hasRepairableIssues(issuesAfter, repairSoftIssues)) {
    attempts++;
    const repairable = issuesAfter.filter((issue) =>
      repairSoftIssues || issue.severity === "hard",
    );
    const needsIn = repairable.some((issue) => issue.boundary === "in");
    const needsOut = repairable.some((issue) => issue.boundary === "out");
    const needsWhole = repairable.some((issue) => issue.boundary === "whole");
    let changed = false;

    if ((needsIn || (needsWhole && last >= ordered.length - 1)) && first > 0) {
      const previous = ordered[first - 1];
      const current = ordered[first];
      if (
        canJoin(previous, current, maxGapUs) &&
        previous.start_us >= bounds.min_us &&
        extensionUs(srcInUs, srcOutUs, previous.start_us, ordered[last].end_us) <= maxExtensionUs
      ) {
        first--;
        changed = true;
      }
    }

    if ((needsOut || needsWhole) && last < ordered.length - 1) {
      const current = ordered[last];
      const next = ordered[last + 1];
      if (
        canJoin(current, next, maxGapUs) &&
        next.end_us <= bounds.max_us &&
        extensionUs(srcInUs, srcOutUs, ordered[first].start_us, next.end_us) <= maxExtensionUs
      ) {
        last++;
        changed = true;
      }
    }

    if (!changed) break;
    issuesAfter = assessWindow(ordered, first, last);
  }

  const addedUtterances = Math.max(0, initialFirst - first) + Math.max(0, last - initialLast);
  if (hasRepairableIssues(issuesAfter, repairSoftIssues) || addedUtterances === 0) {
    return {
      status: "unresolved",
      src_in_us: srcInUs,
      src_out_us: srcOutUs,
      attempts,
      added_utterance_count: addedUtterances,
      issues_before: issuesBefore,
      issues_after: issuesAfter,
    };
  }

  return {
    status: "repaired",
    src_in_us: Math.min(srcInUs, ordered[first].start_us),
    src_out_us: Math.max(srcOutUs, ordered[last].end_us),
    attempts,
    added_utterance_count: addedUtterances,
    issues_before: issuesBefore,
    issues_after: issuesAfter,
  };
}

/** Apply repairs to audible V1 dialogue placements and ripple later clips. */
export function applyDialogueSemanticRepair(
  timeline: AssembledTimeline,
  utteranceMap: Map<string, UtteranceSpan[]>,
  segments: SegmentItem[],
  fps: number,
  options: DialogueSemanticRepairOptions = {},
): AppliedDialogueSemanticRepair {
  const result: AppliedDialogueSemanticRepair = {
    attemptedClips: 0,
    repairedClips: 0,
    unresolvedClips: 0,
    totalAddedFrames: 0,
  };
  if (!Number.isFinite(fps) || fps <= 0) return result;

  const v1 = timeline.tracks.video.find((track) => track.track_id === "V1")
    ?? timeline.tracks.video[0];
  if (!v1) return result;
  const segmentById = new Map(segments.map((segment) => [segment.segment_id, segment]));
  const ordered = v1.clips
    .slice()
    .sort((left, right) => left.timeline_in_frame - right.timeline_in_frame || left.clip_id.localeCompare(right.clip_id));

  for (let index = 0; index < ordered.length; index++) {
    const clip = ordered[index];
    const utterances = utteranceMap.get(clip.asset_id) ?? [];
    if (utterances.every((item) => !item.text?.trim())) continue;
    const mirroredAudio = findMirroredAudio(timeline, clip);
    if (clip.role !== "dialogue" && !mirroredAudio.some((audio) => audio.role === "dialogue")) continue;

    const segment = segmentById.get(clip.segment_id);
    const previous = previousSameAssetClip(ordered, index, clip.asset_id, clip.src_in_us);
    const next = nextSameAssetClip(ordered, index, clip.asset_id, clip.src_out_us);
    const bounds = {
      min_us: Math.max(segment?.src_in_us ?? 0, previous?.src_out_us ?? 0),
      max_us: Math.min(
        segment?.src_out_us ?? Number.POSITIVE_INFINITY,
        next?.src_in_us ?? Number.POSITIVE_INFINITY,
      ),
    };
    const repair = repairDialogueRange(
      clip.src_in_us,
      clip.src_out_us,
      utterances,
      bounds,
      options,
    );
    if (repair.status === "unchanged") continue;

    result.attemptedClips++;
    if (repair.status === "unresolved") {
      result.unresolvedClips++;
      annotateRepair([clip, ...mirroredAudio], repair, 0);
      continue;
    }

    const originalCutFrame = clip.timeline_in_frame + clip.timeline_duration_frames;
    const addedSourceUs = Math.max(0, clip.src_in_us - repair.src_in_us) +
      Math.max(0, repair.src_out_us - clip.src_out_us);
    const addedFrames = Math.max(0, Math.round(addedSourceUs * fps / 1_000_000));
    const excluded = new Set([clip.clip_id, ...mirroredAudio.map((item) => item.clip_id)]);
    if (addedFrames > 0) shiftTimelineAfter(timeline, originalCutFrame, addedFrames, excluded);
    applyRepair([clip, ...mirroredAudio], repair, addedFrames);
    result.repairedClips++;
    result.totalAddedFrames += addedFrames;
  }

  return result;
}

function assessWindow(
  utterances: UtteranceSpan[],
  first: number,
  last: number,
): DialogueCompletenessIssue[] {
  return assessDialogueCompleteness(
    utterances.slice(first, last + 1).map((item) => item.text ?? "").join(" "),
  ).issues;
}

function hasRepairableIssues(issues: DialogueCompletenessIssue[], repairSoft: boolean): boolean {
  return issues.some((issue) => repairSoft || issue.severity === "hard");
}

function canJoin(left: UtteranceSpan, right: UtteranceSpan, maxGapUs: number): boolean {
  const sameSpeaker = !left.speaker || !right.speaker || left.speaker === right.speaker;
  return sameSpeaker && right.start_us - left.end_us <= maxGapUs;
}

function extensionUs(
  originalInUs: number,
  originalOutUs: number,
  nextInUs: number,
  nextOutUs: number,
): number {
  return Math.max(0, originalInUs - nextInUs) + Math.max(0, nextOutUs - originalOutUs);
}

function previousSameAssetClip(
  clips: TimelineClip[],
  index: number,
  assetId: string,
  sourceInUs: number,
): TimelineClip | undefined {
  return clips.slice(0, index).reverse().find((item) =>
    item.asset_id === assetId && item.src_out_us <= sourceInUs,
  );
}

function nextSameAssetClip(
  clips: TimelineClip[],
  index: number,
  assetId: string,
  sourceOutUs: number,
): TimelineClip | undefined {
  return clips.slice(index + 1).find((item) =>
    item.asset_id === assetId && item.src_in_us >= sourceOutUs,
  );
}

function findMirroredAudio(timeline: AssembledTimeline, videoClip: TimelineClip): TimelineClip[] {
  return timeline.tracks.audio.flatMap((track) => track.clips).filter((clip) =>
    clip.asset_id === videoClip.asset_id &&
    clip.segment_id === videoClip.segment_id &&
    clip.timeline_in_frame === videoClip.timeline_in_frame &&
    clip.src_in_us === videoClip.src_in_us &&
    clip.src_out_us === videoClip.src_out_us,
  );
}

function shiftTimelineAfter(
  timeline: AssembledTimeline,
  cutFrame: number,
  addedFrames: number,
  excludedClipIds: Set<string>,
): void {
  for (const track of [...timeline.tracks.video, ...timeline.tracks.audio]) {
    for (const clip of track.clips) {
      if (excludedClipIds.has(clip.clip_id) || clip.timeline_in_frame < cutFrame) continue;
      clip.timeline_in_frame += addedFrames;
    }
  }
  for (const marker of timeline.markers) {
    if (marker.frame >= cutFrame) marker.frame += addedFrames;
  }
}

function applyRepair(
  clips: TimelineClip[],
  repair: DialogueRangeRepairResult,
  addedFrames: number,
): void {
  for (const clip of clips) {
    clip.src_in_us = repair.src_in_us;
    clip.src_out_us = repair.src_out_us;
    clip.timeline_duration_frames += addedFrames;
  }
  annotateRepair(clips, repair, addedFrames);
}

function annotateRepair(
  clips: TimelineClip[],
  repair: DialogueRangeRepairResult,
  addedFrames: number,
): void {
  for (const clip of clips) {
    clip.metadata = {
      ...(clip.metadata ?? {}),
      dialogue_semantic_repair: {
        status: repair.status,
        attempts: repair.attempts,
        added_utterance_count: repair.added_utterance_count,
        added_frames: addedFrames,
        issues_before: repair.issues_before.map((issue) => issue.code),
        issues_after: repair.issues_after.map((issue) => issue.code),
      },
    };
  }
}

function unchanged(srcInUs: number, srcOutUs: number): DialogueRangeRepairResult {
  return {
    status: "unchanged",
    src_in_us: srcInUs,
    src_out_us: srcOutUs,
    attempts: 0,
    added_utterance_count: 0,
    issues_before: [],
    issues_after: [],
  };
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.max(1, Math.floor(value))
    : fallback;
}

function nonNegative(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
}
