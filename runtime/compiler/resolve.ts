// Phase 4: Constraint Resolution
// Resolves overlaps, repeated shot overuse, invalid source ranges,
// and checks total duration fit.

import type { AssembledTimeline, Candidate, DurationPolicy, Track } from "./types.js";
import { computeFrameBounds, isWithinWindow } from "./duration-helpers.js";

export type DurationStatus = "pass" | "advisory" | "fail";

export interface ResolutionReport {
  resolved_overlaps: number;
  resolved_duplicates: number;
  resolved_invalid_ranges: number;
  duration_fit: boolean;
  total_frames: number;
  target_frames: number;
  // Duration policy fields
  duration_mode?: string;
  target_source?: string;
  min_target_frames?: number;
  max_target_frames?: number | null;
  duration_status?: DurationStatus;
  duration_delta_frames?: number;
  duration_delta_pct?: number;
}

export function resolve(
  timeline: AssembledTimeline,
  totalTargetFrames: number,
  candidates: Candidate[] = [],
  durationPolicy?: DurationPolicy,
  fpsNum?: number,
  fpsDen?: number,
): ResolutionReport {
  // Build candidate lookup by segment_id for fallback replacement
  const candidateMap = new Map<string, Candidate>();
  for (const c of candidates) {
    candidateMap.set(c.segment_id, c);
  }
  let resolvedOverlaps = 0;
  let resolvedDuplicates = 0;
  let resolvedInvalidRanges = 0;

  const allTracks: Track[] = [
    ...timeline.tracks.video,
    ...timeline.tracks.audio,
  ];

  // 1. Fix invalid source ranges: ensure src_in_us < src_out_us
  //    If inverted, swap. If equal (zero-duration), extend out by 1 second.
  for (const track of allTracks) {
    for (const clip of track.clips) {
      if (clip.src_in_us > clip.src_out_us) {
        // Swap if inverted
        const tmp = clip.src_in_us;
        clip.src_in_us = clip.src_out_us;
        clip.src_out_us = tmp;
        resolvedInvalidRanges++;
      }
      if (clip.src_in_us === clip.src_out_us) {
        // Zero-duration: guarantee minimum 1 second
        clip.src_out_us = clip.src_in_us + 1_000_000;
        resolvedInvalidRanges++;
      }
    }
  }

  // 2. Resolve same-asset source time overlaps within the same track
  for (const track of allTracks) {
    const byAsset = new Map<string, typeof track.clips>();
    for (const clip of track.clips) {
      const list = byAsset.get(clip.asset_id) ?? [];
      list.push(clip);
      byAsset.set(clip.asset_id, list);
    }

    for (const [, clips] of byAsset) {
      if (clips.length < 2) continue;
      // Sort by src_in_us (stable)
      clips.sort((a, b) => {
        const diff = a.src_in_us - b.src_in_us;
        if (diff !== 0) return diff;
        return a.clip_id.localeCompare(b.clip_id);
      });

      for (let i = 1; i < clips.length; i++) {
        const prev = clips[i - 1];
        const curr = clips[i];
        if (curr.src_in_us < prev.src_out_us) {
          // Trim current clip's in-point to resolve overlap
          curr.src_in_us = prev.src_out_us;
          resolvedOverlaps++;
          // Re-validate after trim
          if (curr.src_in_us >= curr.src_out_us) {
            curr.src_out_us = curr.src_in_us + 1;
          }
        }
      }
    }
  }

  // 3. Resolve repeated shot overuse: the exact same source range must not
  //    appear more than once across ALL tracks. Different excerpts from the
  //    same transcript segment are valid and should survive assembly.
  //    Loop until no duplicates remain (fallback replacement may introduce new ones).
  let duplicatePassLimit = 10;
  while (duplicatePassLimit-- > 0) {
    const segmentUsage = new Map<string, { trackId: string; clipId: string }[]>();
    for (const track of allTracks) {
      for (const clip of track.clips) {
        const list = segmentUsage.get(clipUsageKey(clip)) ?? [];
        list.push({ trackId: track.track_id, clipId: clip.clip_id });
        segmentUsage.set(clipUsageKey(clip), list);
      }
    }

    let foundDuplicate = false;
    for (const [segId, usages] of segmentUsage) {
      if (usages.length <= 1) continue;

      foundDuplicate = true;
      // Keep the first usage, replace or remove duplicates
      const toRemove = usages.slice(1);
      for (const { trackId, clipId } of toRemove) {
        const track = allTracks.find((t) => t.track_id === trackId);
        if (!track) continue;
        const idx = track.clips.findIndex((c) => c.clip_id === clipId);
        if (idx !== -1) {
          const clip = track.clips[idx];
          let replaced = false;

          // Try each fallback until we find a valid candidate
          while (clip.fallback_segment_ids.length > 0) {
            const fallbackSegId = clip.fallback_segment_ids.shift()!;
            const fallbackCandidate = candidateMap.get(fallbackSegId);
            if (fallbackCandidate) {
              // Full clip replacement from candidate data
              clip.segment_id = fallbackCandidate.segment_id;
              clip.asset_id = fallbackCandidate.asset_id;
              clip.src_in_us = fallbackCandidate.src_in_us;
              clip.src_out_us = fallbackCandidate.src_out_us;
              clip.confidence = fallbackCandidate.confidence;
              clip.quality_flags = fallbackCandidate.quality_flags ?? [];
              clip.motivation = `[fallback] replaced duplicate ${segId} with ${fallbackSegId}`;
              clip.role = fallbackCandidate.role as typeof clip.role;
              replaced = true;
              break;
            }
          }

          if (!replaced) {
            // No valid fallback found — remove the clip
            track.clips.splice(idx, 1);
          }
          resolvedDuplicates++;
        }
      }
    }

    if (!foundDuplicate) break;
  }

  // 4. Duration fit check
  let maxFrame = 0;
  for (const track of timeline.tracks.video) {
    for (const clip of track.clips) {
      const end = clip.timeline_in_frame + clip.timeline_duration_frames;
      if (end > maxFrame) maxFrame = end;
    }
  }

  // Duration fit: for guide mode, use policy max bounds (target is a floor, not a cap).
  // For strict mode or when no policy, use totalTargetFrames as the ceiling.
  let durationFit: boolean | undefined;

  // Duration policy-aware status
  let duration_status: DurationStatus | undefined;
  let min_target_frames: number | undefined;
  let max_target_frames: number | null | undefined;
  let duration_delta_frames: number | undefined;
  let duration_delta_pct: number | undefined;
  let resolved_target_frames = totalTargetFrames;

  if (durationPolicy && fpsNum && fpsDen) {
    const bounds = computeFrameBounds(durationPolicy, fpsNum, fpsDen);
    min_target_frames = bounds.min_target_frames;
    max_target_frames = bounds.max_target_frames;
    resolved_target_frames = bounds.target_frames;
    duration_delta_frames = maxFrame - bounds.target_frames;
    duration_delta_pct = bounds.target_frames > 0
      ? ((maxFrame - bounds.target_frames) / bounds.target_frames) * 100
      : 0;

    if (durationPolicy.mode === "strict") {
      duration_status = isWithinWindow(maxFrame, bounds) ? "pass" : "fail";
    } else {
      // guide mode
      if (maxFrame > 0) {
        duration_status = isWithinWindow(maxFrame, bounds) ? "pass" : "advisory";
      } else {
        duration_status = "pass";
      }
    }

    // Guide mode: duration_fit uses policy max bounds (target is a floor).
    // Strict mode: use window check.
    if (durationPolicy.mode === "guide") {
      durationFit = bounds.max_target_frames != null
        ? maxFrame <= bounds.max_target_frames
        : true; // unbounded max → always fits
    } else {
      durationFit = isWithinWindow(maxFrame, bounds);
    }
  }

  // Fallback when no policy: legacy check against beat target sum
  if (durationFit === undefined) {
    durationFit = maxFrame <= totalTargetFrames;
  }

  return {
    resolved_overlaps: resolvedOverlaps,
    resolved_duplicates: resolvedDuplicates,
    resolved_invalid_ranges: resolvedInvalidRanges,
    duration_fit: durationFit,
    total_frames: maxFrame,
    target_frames: resolved_target_frames,
    duration_mode: durationPolicy?.mode,
    target_source: durationPolicy?.target_source,
    min_target_frames,
    max_target_frames,
    duration_status,
    duration_delta_frames,
    duration_delta_pct,
  };
}

function clipUsageKey(clip: {
  segment_id: string;
  src_in_us: number;
  src_out_us: number;
}): string {
  return `${clip.segment_id}:${clip.src_in_us}:${clip.src_out_us}`;
}
