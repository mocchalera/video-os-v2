// Phase 4: Constraint Resolution
// Resolves overlaps, repeated shot overuse, invalid source ranges,
// and checks total duration fit.

import type { AssembledTimeline, Candidate, DurationPolicy, Track } from "./types.js";
import { computeFrameBounds, isWithinWindow } from "./duration-helpers.js";
import { primaryContentClips } from "./primary-content.js";

export type DurationStatus = "pass" | "short" | "over";

export interface BeatFillDiagnostic {
  beat_id: string;
  target: number;
  actual: number;
  fill_ratio: number;
}

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
  content_frames: number;
  content_fill_ratio: number;
  gap_frames: number;
  gap_count: number;
  beat_fill: BeatFillDiagnostic[];
}

const DEFAULT_CONTENT_FILL_THRESHOLD = 0.9;

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
      if (clip.media_kind === "image") continue;
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
        if (prev.media_kind === "image" || curr.media_kind === "image") continue;
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
        const usageKey = clip.media_kind === "image"
          ? `${track.kind}:still:${clip.clip_id}`
          : `${track.kind}:${clipUsageKey(clip)}`;
        const list = segmentUsage.get(usageKey) ?? [];
        list.push({ trackId: track.track_id, clipId: clip.clip_id });
        segmentUsage.set(usageKey, list);
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
            const trackAcceptsCandidate = fallbackCandidate &&
              fallbackCandidate.media_kind !== "image" && clip.media_kind !== "image" &&
              (track.kind === "audio" || fallbackCandidate.source_capabilities?.has_video !== false) &&
              (track.kind === "video" || fallbackCandidate.source_capabilities?.has_video === false || fallbackCandidate.role === "dialogue");
            if (fallbackCandidate && trackAcceptsCandidate) {
              // Full clip replacement from candidate data
              clip.segment_id = fallbackCandidate.segment_id;
              clip.asset_id = fallbackCandidate.asset_id;
              clip.src_in_us = fallbackCandidate.src_in_us;
              clip.src_out_us = fallbackCandidate.src_out_us;
              clip.confidence = fallbackCandidate.confidence;
              clip.quality_flags = fallbackCandidate.quality_flags ?? [];
              clip.motivation = `[fallback] replaced duplicate ${segId} with ${fallbackSegId}`;
              clip.role = fallbackCandidate.role as typeof clip.role;
              clip.media_kind = fallbackCandidate.media_kind;
              clip.source_capabilities = fallbackCandidate.source_capabilities
                ? { ...fallbackCandidate.source_capabilities }
                : undefined;
              clip.audio_role = fallbackCandidate.audio_role;
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
  for (const clip of primaryContentClips(timeline)) {
    const end = clip.timeline_in_frame + clip.timeline_duration_frames;
    if (end > maxFrame) maxFrame = end;
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
    duration_delta_frames = 0;
    duration_delta_pct = bounds.target_frames > 0
      ? (duration_delta_frames / bounds.target_frames) * 100
      : 0;

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

  const content_frames = sumPrimaryContentFrames(timeline);
  const content_fill_ratio = resolved_target_frames > 0
    ? content_frames / resolved_target_frames
    : 1;
  const gapSummary = computeGapSummary(timeline, resolved_target_frames);
  const beat_fill = computeBeatFill(timeline, resolved_target_frames);

  if (durationPolicy && fpsNum && fpsDen) {
    duration_delta_frames = content_frames - resolved_target_frames;
    duration_delta_pct = resolved_target_frames > 0
      ? (duration_delta_frames / resolved_target_frames) * 100
      : 0;

    const isShort = content_fill_ratio < DEFAULT_CONTENT_FILL_THRESHOLD ||
      (min_target_frames !== undefined && content_frames < min_target_frames);
    const isOver = max_target_frames != null
      ? maxFrame > max_target_frames || content_frames > max_target_frames
      : durationPolicy.mode === "strict" && maxFrame > resolved_target_frames;

    if (isShort) {
      duration_status = "short";
    } else if (isOver) {
      duration_status = "over";
    } else if (durationPolicy.mode === "strict" && !isWithinWindow(maxFrame, {
      target_frames: resolved_target_frames,
      min_target_frames: min_target_frames ?? resolved_target_frames,
      max_target_frames: max_target_frames ?? resolved_target_frames,
    })) {
      duration_status = maxFrame < (min_target_frames ?? resolved_target_frames) ? "short" : "over";
    } else {
      duration_status = "pass";
    }
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
    content_frames,
    content_fill_ratio,
    gap_frames: gapSummary.gap_frames,
    gap_count: gapSummary.gap_count,
    beat_fill,
  };
}

function sumPrimaryContentFrames(timeline: AssembledTimeline): number {
  return primaryContentClips(timeline).reduce(
    (sum, clip) => sum + Math.max(0, clip.timeline_duration_frames),
    0,
  );
}

function computeGapSummary(
  timeline: AssembledTimeline,
  targetFrames: number,
): { gap_frames: number; gap_count: number } {
  if (targetFrames <= 0) return { gap_frames: 0, gap_count: 0 };
  const intervals = primaryContentClips(timeline)
    .map((clip) => ({
      start: Math.max(0, Math.min(targetFrames, clip.timeline_in_frame)),
      end: Math.max(0, Math.min(targetFrames, clip.timeline_in_frame + clip.timeline_duration_frames)),
    }))
    .filter((interval) => interval.end > interval.start)
    .sort((a, b) => a.start - b.start || a.end - b.end);

  let cursor = 0;
  let gapFrames = 0;
  let gapCount = 0;
  for (const interval of intervals) {
    if (interval.start > cursor) {
      gapFrames += interval.start - cursor;
      gapCount += 1;
    }
    cursor = Math.max(cursor, interval.end);
  }
  if (cursor < targetFrames) {
    gapFrames += targetFrames - cursor;
    gapCount += 1;
  }

  return { gap_frames: gapFrames, gap_count: gapCount };
}

function computeBeatFill(
  timeline: AssembledTimeline,
  targetFrames: number,
): BeatFillDiagnostic[] {
  const beatWindows = getBeatWindows(timeline, targetFrames);
  const clips = primaryContentClips(timeline);

  return beatWindows.map((beat) => {
    const actual = clips
      .filter((clip) => clip.beat_id === beat.beat_id)
      .reduce((sum, clip) => sum + Math.max(0, clip.timeline_duration_frames), 0);
    return {
      beat_id: beat.beat_id,
      target: beat.target,
      actual,
      fill_ratio: beat.target > 0 ? actual / beat.target : 1,
    };
  });
}

function getBeatWindows(
  timeline: AssembledTimeline,
  targetFrames: number,
): Array<{ beat_id: string; start: number; target: number }> {
  const markers = timeline.markers
    .filter((marker) => marker.kind === "beat")
    .map((marker) => ({
      beat_id: marker.label.split(":")[0]?.trim(),
      start: marker.frame,
    }))
    .filter((marker): marker is { beat_id: string; start: number } =>
      Boolean(marker.beat_id) && Number.isFinite(marker.start)
    )
    .sort((a, b) => a.start - b.start || a.beat_id.localeCompare(b.beat_id));

  if (markers.length > 0) {
    return markers.map((marker, index) => {
      const nextStart = markers[index + 1]?.start ?? targetFrames;
      return {
        beat_id: marker.beat_id,
        start: marker.start,
        target: Math.max(0, nextStart - marker.start),
      };
    });
  }

  const beatIds = [...new Set(
    primaryContentClips(timeline).map((clip) => clip.beat_id),
  )].sort();
  if (beatIds.length === 0) return [];
  const fallbackTarget = Math.floor(targetFrames / beatIds.length);
  let remainder = targetFrames - fallbackTarget * beatIds.length;
  let cursor = 0;
  return beatIds.map((beatId) => {
    const target = fallbackTarget + (remainder > 0 ? 1 : 0);
    if (remainder > 0) remainder -= 1;
    const window = { beat_id: beatId, start: cursor, target };
    cursor += target;
    return window;
  });
}

function clipUsageKey(clip: {
  segment_id: string;
  src_in_us: number;
  src_out_us: number;
}): string {
  return `${clip.segment_id}:${clip.src_in_us}:${clip.src_out_us}`;
}
