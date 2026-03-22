// Phase 3.5b: Duration Adjustment
// Strict mode: recovers underfill/overfill to meet target window.
// Guide mode: no-op (compaction handles placement).
// Deterministic. No LLM calls.

import type {
  AssembledTimeline,
  Candidate,
  DurationPolicy,
  NormalizedBeat,
  TimelineClip,
} from "./types.js";
import { computeFrameBounds, type DurationFrameBounds } from "./duration-helpers.js";

export interface DurationAdjustResult {
  adjusted: boolean;
  extensions: number;
  insertions: number;
  tail_trims: number;
  clip_drops: number;
}

/**
 * Apply strict duration adjustment after assemble+trim.
 * Guide mode is a no-op by design.
 */
export function applyDurationAdjust(
  timeline: AssembledTimeline,
  beats: NormalizedBeat[],
  candidates: Candidate[],
  policy: DurationPolicy | undefined,
  fpsNum: number,
  fpsDen: number,
): DurationAdjustResult {
  const result: DurationAdjustResult = {
    adjusted: false,
    extensions: 0,
    insertions: 0,
    tail_trims: 0,
    clip_drops: 0,
  };

  if (!policy || policy.mode !== "strict") {
    return result;
  }

  const bounds = computeFrameBounds(policy, fpsNum, fpsDen);
  const actual = getActualEndFrame(timeline);

  if (bounds.max_target_frames != null && actual > bounds.max_target_frames) {
    // Overfill: trim from tail
    recoverOverfill(timeline, actual, bounds.max_target_frames, result);
  } else if (actual < bounds.min_target_frames) {
    // Underfill: extend clips or insert fallbacks
    recoverUnderfill(timeline, beats, candidates, actual, bounds.min_target_frames, fpsNum, fpsDen, result);
  }

  if (result.extensions > 0 || result.insertions > 0 || result.tail_trims > 0 || result.clip_drops > 0) {
    result.adjusted = true;
  }

  return result;
}

function getActualEndFrame(timeline: AssembledTimeline): number {
  let maxFrame = 0;
  for (const track of timeline.tracks.video) {
    for (const clip of track.clips) {
      const end = clip.timeline_in_frame + clip.timeline_duration_frames;
      if (end > maxFrame) maxFrame = end;
    }
  }
  return maxFrame;
}

// ── Overfill recovery ──────────────────────────────────────────────

function recoverOverfill(
  timeline: AssembledTimeline,
  actual: number,
  maxTarget: number,
  result: DurationAdjustResult,
): void {
  let overflow = actual - maxTarget;
  if (overflow <= 0) return;

  // Get all video clips sorted by end frame descending
  const allVideoClips: { clip: TimelineClip; trackIdx: number }[] = [];
  for (let ti = 0; ti < timeline.tracks.video.length; ti++) {
    for (const clip of timeline.tracks.video[ti].clips) {
      allVideoClips.push({ clip, trackIdx: ti });
    }
  }
  allVideoClips.sort((a, b) => {
    const aEnd = a.clip.timeline_in_frame + a.clip.timeline_duration_frames;
    const bEnd = b.clip.timeline_in_frame + b.clip.timeline_duration_frames;
    return bEnd - aEnd;
  });

  // Phase 1: Tail-trim support/texture/transition clips
  for (const { clip } of allVideoClips) {
    if (overflow <= 0) break;
    if (clip.role !== "support" && clip.role !== "texture" && clip.role !== "transition") continue;

    const trimAmount = Math.min(overflow, clip.timeline_duration_frames - 1);
    if (trimAmount > 0) {
      clip.timeline_duration_frames -= trimAmount;
      overflow -= trimAmount;
      result.tail_trims++;
    }
  }

  // Phase 2: Drop whole clips if still over
  for (const { clip, trackIdx } of allVideoClips) {
    if (overflow <= 0) break;
    if (clip.role !== "support" && clip.role !== "texture" && clip.role !== "transition") continue;

    const track = timeline.tracks.video[trackIdx];
    const idx = track.clips.indexOf(clip);
    if (idx !== -1) {
      overflow -= clip.timeline_duration_frames;
      track.clips.splice(idx, 1);
      result.clip_drops++;
    }
  }

  // Phase 3: Trim non-protected hero clips as last resort
  for (const { clip } of allVideoClips) {
    if (overflow <= 0) break;
    if (clip.role !== "hero") continue;

    const trimAmount = Math.min(overflow, clip.timeline_duration_frames - 1);
    if (trimAmount > 0) {
      clip.timeline_duration_frames -= trimAmount;
      overflow -= trimAmount;
      result.tail_trims++;
    }
  }
}

// ── Underfill recovery ─────────────────────────────────────────────

function recoverUnderfill(
  timeline: AssembledTimeline,
  beats: NormalizedBeat[],
  candidates: Candidate[],
  actual: number,
  minTarget: number,
  fpsNum: number,
  fpsDen: number,
  result: DurationAdjustResult,
): void {
  const usPerFrame = (1_000_000 * fpsDen) / fpsNum;
  let deficit = minTarget - actual;
  if (deficit <= 0) return;

  // Build a set of used clip keys to avoid duplicates
  const usedKeys = new Set<string>();
  for (const track of [...timeline.tracks.video, ...timeline.tracks.audio]) {
    for (const clip of track.clips) {
      usedKeys.add(`${clip.segment_id}:${clip.src_in_us}:${clip.src_out_us}`);
    }
  }

  // Phase 1: Extend existing non-dialogue video clips
  for (const track of timeline.tracks.video) {
    if (deficit <= 0) break;
    for (const clip of [...track.clips].reverse()) {
      if (deficit <= 0) break;
      if (clip.role === "dialogue") continue;

      // Calculate how much we can extend from source
      const sourceCandidate = candidates.find(
        (c) => c.segment_id === clip.segment_id,
      );
      if (!sourceCandidate) continue;

      const sourceTotalFrames = Math.ceil(
        (sourceCandidate.src_out_us - sourceCandidate.src_in_us) / usPerFrame,
      );
      const extendable = sourceTotalFrames - clip.timeline_duration_frames;
      const extendFrames = Math.min(deficit, Math.max(0, extendable));

      if (extendFrames > 0) {
        clip.timeline_duration_frames += extendFrames;
        deficit -= extendFrames;
        result.extensions++;
      }
    }
  }

  // Phase 2: Insert unused support/texture candidates
  if (deficit > 0) {
    const unused = candidates.filter(
      (c) =>
        c.role !== "reject" &&
        c.role !== "dialogue" &&
        !usedKeys.has(`${c.segment_id}:${c.src_in_us}:${c.src_out_us}`),
    );

    // Sort by confidence descending for deterministic best-first
    unused.sort((a, b) => b.confidence - a.confidence);

    const v2Track = timeline.tracks.video.find((t) => t.track_id === "V2");
    if (v2Track) {
      for (const candidate of unused) {
        if (deficit <= 0) break;

        const sourceDurationFrames = Math.ceil(
          (candidate.src_out_us - candidate.src_in_us) / usPerFrame,
        );
        const insertDuration = Math.min(deficit, sourceDurationFrames);
        if (insertDuration <= 0) continue;

        const insertFrame = getActualEndFrame(timeline);
        const newClip: TimelineClip = {
          clip_id: `CLP_ADJ_${String(result.insertions + 1).padStart(3, "0")}`,
          segment_id: candidate.segment_id,
          asset_id: candidate.asset_id,
          src_in_us: candidate.src_in_us,
          src_out_us: candidate.src_out_us,
          timeline_in_frame: insertFrame,
          timeline_duration_frames: insertDuration,
          role: candidate.role as TimelineClip["role"],
          motivation: `[duration-adjust] fill underfill gap`,
          beat_id: "",
          fallback_segment_ids: [],
          confidence: candidate.confidence,
          quality_flags: candidate.quality_flags ?? [],
        };

        v2Track.clips.push(newClip);
        usedKeys.add(`${candidate.segment_id}:${candidate.src_in_us}:${candidate.src_out_us}`);
        deficit -= insertDuration;
        result.insertions++;
      }
    }
  }
}
