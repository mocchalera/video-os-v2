/**
 * Shared timeline validation and normalization module.
 *
 * Used by both editor/client and editor/server to guarantee identical
 * canonical normalization and overlap validation semantics.
 */

// ── Shared types ─────────────────────────────────────────────────────

export interface TimelineValidationIssue {
  path: string;
  message: string;
}

/** Minimal clip shape that both client Clip and server TimelineClip satisfy. */
interface MinimalClip {
  clip_id: string;
  segment_id: string;
  asset_id: string;
  src_in_us: number;
  src_out_us: number;
  timeline_in_frame: number;
  timeline_duration_frames: number;
  motivation: string;
}

interface MinimalTrack {
  track_id: string;
  clips: MinimalClip[];
}

interface MinimalSequence {
  fps_num: number;
  fps_den: number;
}

interface MinimalTimeline {
  sequence: MinimalSequence;
  tracks: { video: MinimalTrack[]; audio: MinimalTrack[] };
}

// ── Pure helpers ─────────────────────────────────────────────────────

export function durationFramesFromSource(
  srcInUs: number,
  srcOutUs: number,
  fps: number,
): number {
  const durationUs = srcOutUs - srcInUs;
  return Math.max(1, Math.round((durationUs / 1_000_000) * fps));
}

function getFps(sequence: MinimalSequence): number {
  return sequence.fps_num / sequence.fps_den;
}

function resolveClipDuration(clip: MinimalClip, fps: number): number {
  if (
    typeof clip.timeline_duration_frames === 'number' &&
    Number.isFinite(clip.timeline_duration_frames) &&
    clip.timeline_duration_frames >= 1
  ) {
    return Math.round(clip.timeline_duration_frames);
  }
  return durationFramesFromSource(clip.src_in_us, clip.src_out_us, fps);
}

function clipEndFrame(clip: MinimalClip, fps: number): number {
  return clip.timeline_in_frame + resolveClipDuration(clip, fps);
}

// ── Sort ─────────────────────────────────────────────────────────────

export function sortTrackClips<C extends MinimalClip>(clips: C[]): C[] {
  return [...clips].sort((a, b) => {
    if (a.timeline_in_frame !== b.timeline_in_frame) {
      return a.timeline_in_frame - b.timeline_in_frame;
    }
    return a.clip_id.localeCompare(b.clip_id);
  });
}

// ── Normalize ────────────────────────────────────────────────────────

/**
 * Canonical normalization: sort clips by timeline_in_frame, recalculate
 * timeline_duration_frames from source in/out. Returns a deep clone.
 *
 * Both client and server apply identical normalization through this function.
 */
export function normalizeTimeline<T extends MinimalTimeline>(timeline: T): T {
  const result: T = structuredClone(timeline);
  const fps = getFps(result.sequence);

  for (const group of [result.tracks.video, result.tracks.audio]) {
    for (const track of group) {
      track.clips = sortTrackClips(
        track.clips.map((clip) => ({
          ...clip,
          timeline_duration_frames: durationFramesFromSource(
            clip.src_in_us,
            clip.src_out_us,
            fps,
          ),
        })),
      );
    }
  }

  return result;
}

// ── Validate ─────────────────────────────────────────────────────────

/**
 * Validate overlaps within a single track.
 *
 * Same-start stack groups (legacy timelines with stacked alternatives at
 * identical timeline_in_frame) are treated as legal — only true temporal
 * overlaps are flagged.
 */
export function validateOverlaps(
  trackType: 'video' | 'audio',
  track: MinimalTrack,
  fps: number,
): TimelineValidationIssue[] {
  const issues: TimelineValidationIssue[] = [];
  const sorted = sortTrackClips(track.clips);
  let lastEndFrame = -1;

  for (let i = 0; i < sorted.length; ) {
    const groupStart = sorted[i].timeline_in_frame;
    const groupStartIndex = i;
    let groupEnd = Number.POSITIVE_INFINITY;

    // Collect all clips that share the same start frame (stack group)
    while (i < sorted.length && sorted[i].timeline_in_frame === groupStart) {
      groupEnd = Math.min(groupEnd, clipEndFrame(sorted[i], fps));
      i += 1;
    }

    if (lastEndFrame > groupStart) {
      issues.push({
        path: `${trackType}.${track.track_id}.clips[${groupStartIndex}].timeline_in_frame`,
        message: `Track ${track.track_id} has overlapping clips.`,
      });
    }

    // Use the earliest end in that stack as the boundary for the next group
    lastEndFrame = groupEnd;
  }

  return issues;
}

/**
 * Full timeline validation: required fields, source range, duration, and
 * overlap checks across all tracks.
 */
export function validateTimeline(timeline: MinimalTimeline): TimelineValidationIssue[] {
  const issues: TimelineValidationIssue[] = [];
  const fps = getFps(timeline.sequence);

  function checkTrack(trackType: 'video' | 'audio', track: MinimalTrack): void {
    sortTrackClips(track.clips).forEach((clip, index) => {
      const basePath = `${trackType}.${track.track_id}.clips[${index}]`;

      if (!clip.clip_id || !clip.segment_id || !clip.asset_id || !clip.motivation) {
        issues.push({
          path: basePath,
          message: 'clip_id, segment_id, asset_id, motivation are required.',
        });
      }

      if (clip.src_in_us >= clip.src_out_us) {
        issues.push({
          path: `${basePath}.src_in_us`,
          message: 'src_in_us must be less than src_out_us.',
        });
      }

      if (clip.timeline_duration_frames < 1) {
        issues.push({
          path: `${basePath}.timeline_duration_frames`,
          message: 'timeline_duration_frames must be at least 1.',
        });
      }
    });

    issues.push(...validateOverlaps(trackType, track, fps));
  }

  timeline.tracks.video.forEach((track) => checkTrack('video', track));
  timeline.tracks.audio.forEach((track) => checkTrack('audio', track));

  return issues;
}
