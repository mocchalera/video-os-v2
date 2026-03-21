// Phase 4: Constraint Resolution
// Resolves overlaps, repeated shot overuse, invalid source ranges,
// and checks total duration fit.

import type { AssembledTimeline, Candidate, Track } from "./types.js";

export interface ResolutionReport {
  resolved_overlaps: number;
  resolved_duplicates: number;
  resolved_invalid_ranges: number;
  duration_fit: boolean;
  total_frames: number;
  target_frames: number;
}

export function resolve(
  timeline: AssembledTimeline,
  totalTargetFrames: number,
  candidates: Candidate[] = [],
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

  // 3. Resolve repeated shot overuse: same segment_id must not appear
  //    more than once across ALL tracks.
  //    Loop until no duplicates remain (fallback replacement may introduce new ones).
  let duplicatePassLimit = 10;
  while (duplicatePassLimit-- > 0) {
    const segmentUsage = new Map<string, { trackId: string; clipId: string }[]>();
    for (const track of allTracks) {
      for (const clip of track.clips) {
        const list = segmentUsage.get(clip.segment_id) ?? [];
        list.push({ trackId: track.track_id, clipId: clip.clip_id });
        segmentUsage.set(clip.segment_id, list);
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

  const durationFit = maxFrame <= totalTargetFrames;

  return {
    resolved_overlaps: resolvedOverlaps,
    resolved_duplicates: resolvedDuplicates,
    resolved_invalid_ranges: resolvedInvalidRanges,
    duration_fit: durationFit,
    total_frames: maxFrame,
    target_frames: totalTargetFrames,
  };
}
