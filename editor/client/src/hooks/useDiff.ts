import { useMemo } from 'react';
import type { Clip, HistoryOrigin, SessionBaseline, TimelineIR } from '../types';

export type DiffChangeType =
  | 'trimmed'
  | 'swapped'
  | 'audio_adjusted'
  | 'moved'
  | 'added'
  | 'removed'
  | 'patch_apply';

export interface ClipDiff {
  clip_id: string;
  changes: DiffChangeType[];
  baselineClip: Clip | null;
  currentClip: Clip | null;
}

function getAllClips(timeline: TimelineIR): Map<string, Clip> {
  const map = new Map<string, Clip>();
  for (const group of [timeline.tracks.video, timeline.tracks.audio]) {
    for (const track of group) {
      for (const clip of track.clips) {
        map.set(clip.clip_id, clip);
      }
    }
  }
  return map;
}

/**
 * Build a set of clip IDs that were affected by patch_apply history entries.
 * Compares each patch_apply snapshot with its predecessor to find which clips changed.
 */
function buildPatchAffectedClips(
  historyOrigins: HistoryOrigin[],
  historySnapshots: TimelineIR[],
  currentTimeline: TimelineIR,
): Set<string> {
  const affected = new Set<string>();

  for (let i = 0; i < historyOrigins.length; i++) {
    if (historyOrigins[i] !== 'patch_apply') continue;

    // The snapshot at index i is the timeline BEFORE the patch was applied.
    // The timeline AFTER is either the next snapshot's pre-state or the current timeline.
    // When this is the last entry, fall back to the live currentTimeline.
    const before = getAllClips(historySnapshots[i]);
    const after = i + 1 < historySnapshots.length
      ? getAllClips(historySnapshots[i + 1])
      : getAllClips(currentTimeline);

    const allIds = new Set([...before.keys(), ...after.keys()]);
    for (const clipId of allIds) {
      const b = before.get(clipId);
      const a = after.get(clipId);
      // remove_segment: clip existed before but gone after
      if (!b && a) { affected.add(clipId); continue; }
      if (b && !a) { affected.add(clipId); continue; }
      if (b && a) {
        if (b.segment_id !== a.segment_id || b.asset_id !== a.asset_id ||
            b.src_in_us !== a.src_in_us || b.src_out_us !== a.src_out_us ||
            b.timeline_in_frame !== a.timeline_in_frame ||
            // change_audio_policy: detect audio_policy changes
            JSON.stringify(b.audio_policy ?? {}) !== JSON.stringify(a.audio_policy ?? {})) {
          affected.add(clipId);
        }
      }
    }
  }

  return affected;
}

function hasPatchMotivation(clip: Clip): boolean {
  return (
    clip.motivation?.startsWith('[patch]') === true ||
    clip.motivation?.startsWith('[patch:') === true
  );
}

export function computeDiff(
  baseline: TimelineIR,
  current: TimelineIR,
  patchAffectedClips: Set<string>,
): ClipDiff[] {
  const baseClips = getAllClips(baseline);
  const curClips = getAllClips(current);
  const diffs: ClipDiff[] = [];
  const allIds = new Set([...baseClips.keys(), ...curClips.keys()]);

  for (const clipId of allIds) {
    const base = baseClips.get(clipId) ?? null;
    const cur = curClips.get(clipId) ?? null;
    const changes: DiffChangeType[] = [];

    if (!base && cur) {
      changes.push('added');
      // If this added clip was part of a patch_apply operation
      if (patchAffectedClips.has(clipId) || hasPatchMotivation(cur)) {
        changes.push('patch_apply');
      }
    } else if (base && !cur) {
      changes.push('removed');
      // If this removed clip was part of a patch_apply operation
      if (patchAffectedClips.has(clipId)) {
        changes.push('patch_apply');
      }
    } else if (base && cur) {
      // Check for swapped (segment_id or asset_id changed)
      if (base.segment_id !== cur.segment_id || base.asset_id !== cur.asset_id) {
        changes.push('swapped');
      }

      // Check for trimmed (src_in/out changed)
      if (base.src_in_us !== cur.src_in_us || base.src_out_us !== cur.src_out_us) {
        changes.push('trimmed');
      }

      // Check for moved (timeline_in_frame changed)
      if (base.timeline_in_frame !== cur.timeline_in_frame) {
        changes.push('moved');
      }

      // Check for audio_adjusted
      const baseAudio = JSON.stringify(base.audio_policy ?? {});
      const curAudio = JSON.stringify(cur.audio_policy ?? {});
      if (baseAudio !== curAudio) {
        changes.push('audio_adjusted');
      }

      // Check for patch_apply origin:
      // 1. History origin tracking (covers insert/remove/trim/move from patches)
      // 2. Motivation prefix fallback (for clips modified by server-side patch apply)
      if (patchAffectedClips.has(clipId)) {
        changes.push('patch_apply');
      } else if (hasPatchMotivation(cur) && !hasPatchMotivation(base)) {
        changes.push('patch_apply');
      }
    }

    if (changes.length > 0) {
      diffs.push({ clip_id: clipId, changes, baselineClip: base, currentClip: cur });
    }
  }

  return diffs;
}

/**
 * Compute clip-level diff between session baseline and current timeline.
 * Accepts history origins and snapshots to accurately detect patch_apply changes.
 */
export function useDiff(
  sessionBaseline: SessionBaseline | null,
  currentTimeline: TimelineIR | null,
  historyOrigins?: HistoryOrigin[],
  historySnapshots?: TimelineIR[],
): ClipDiff[] {
  return useMemo(() => {
    if (!sessionBaseline || !currentTimeline) return [];

    const patchAffected = (historyOrigins && historySnapshots)
      ? buildPatchAffectedClips(historyOrigins, historySnapshots, currentTimeline)
      : new Set<string>();

    return computeDiff(sessionBaseline.timeline, currentTimeline, patchAffected);
  }, [sessionBaseline, currentTimeline, historyOrigins, historySnapshots]);
}
