import type { Clip, EditorLane, SelectionState, TimelineIR } from '../types';
import { clamp } from './time';

export const MAX_ZOOM = 24;
export const MIN_ZOOM = 1.25;
export const FALLBACK_ZOOM = 6;

export function buildLanes(timeline: TimelineIR | null): EditorLane[] {
  if (!timeline) {
    return [
      { laneId: 'V1', label: 'V1', trackKind: 'video', trackId: null, clips: [] },
      { laneId: 'A1', label: 'A1', trackKind: 'audio', trackId: null, clips: [] },
      { laneId: 'A2', label: 'A2', trackKind: 'audio', trackId: null, clips: [] },
    ];
  }

  const lanes: EditorLane[] = [];

  for (const track of timeline.tracks.video) {
    lanes.push({
      laneId: track.track_id,
      label: track.track_id,
      trackKind: 'video',
      trackId: track.track_id,
      clips: track.clips,
    });
  }

  for (const track of timeline.tracks.audio) {
    if (track.clips.length > 0) {
      lanes.push({
        laneId: track.track_id,
        label: track.track_id,
        trackKind: 'audio',
        trackId: track.track_id,
        clips: track.clips,
      });
    }
  }

  if (lanes.length === 0) {
    return [
      { laneId: 'V1', label: 'V1', trackKind: 'video', trackId: null, clips: [] },
      { laneId: 'A1', label: 'A1', trackKind: 'audio', trackId: null, clips: [] },
    ];
  }

  return lanes;
}

export function computeAutoFitZoom(totalFrames: number): number {
  const availableWidth = Math.max(560, window.innerWidth - 160);
  const fitted = availableWidth / Math.max(1, totalFrames);
  return clamp(fitted, MIN_ZOOM, MAX_ZOOM);
}

export function findSelectedClip(
  timeline: TimelineIR | null,
  selection: SelectionState | null,
): Clip | null {
  if (!timeline || !selection) return null;
  const track = timeline.tracks[selection.trackKind].find(
    (candidate) => candidate.track_id === selection.trackId,
  );
  return track?.clips.find((candidate) => candidate.clip_id === selection.clipId) ?? null;
}

export function getTotalFrames(timeline: TimelineIR | null): number {
  if (!timeline) return 24 * 12;
  const startFrame = timeline.sequence.start_frame ?? 0;
  const clipEnds = [...timeline.tracks.video, ...timeline.tracks.audio]
    .flatMap((track) => track.clips)
    .map((clip) => clip.timeline_in_frame + clip.timeline_duration_frames);
  const markerFrames = (timeline.markers ?? []).map((marker) => marker.frame);
  // Ensure durationFrames >= start_frame so clamp(x, startFrame, durationFrames) is always valid.
  // Empty timeline: returns start_frame (playhead sits at sequence origin).
  return Math.max(...clipEnds, ...markerFrames, startFrame, 1);
}

