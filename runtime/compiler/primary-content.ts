import type { AssembledTimeline, TimelineClip, Track } from "./types.js";

export function hasVisualProgram(timeline: AssembledTimeline): boolean {
  return timeline.tracks.video.some((track) => track.clips.length > 0);
}

/**
 * Preserve the legacy visual program definition for video/mixed timelines.
 * Only a timeline with no video clips falls back to authored audio. Selected
 * source music remains program content; generated BGM beds and video mirrors do not.
 */
export function primaryContentTracks(timeline: AssembledTimeline): Track[] {
  if (hasVisualProgram(timeline)) return timeline.tracks.video;
  return timeline.tracks.audio
    .filter((track) => track.clips.some(isAuthoredProgramAudio));
}

export function primaryContentClips(timeline: AssembledTimeline): TimelineClip[] {
  return primaryContentTracks(timeline).flatMap((track) => track.clips.filter(isAuthoredProgramAudio));
}

export function primarySequentialClips(timeline: AssembledTimeline): TimelineClip[] {
  if (hasVisualProgram(timeline)) {
    const v1 = timeline.tracks.video.find((track) => track.track_id === "V1") ?? timeline.tracks.video[0];
    return v1?.clips ?? [];
  }
  return primaryContentClips(timeline).sort((left, right) =>
    left.timeline_in_frame - right.timeline_in_frame || left.clip_id.localeCompare(right.clip_id)
  );
}

export function isAuthoredProgramAudio(clip: TimelineClip): boolean {
  if (clip.motivation === "original clip audio") return false;
  if (clip.role === "bgm") return false;
  return clip.media_kind === "audio" || clip.source_capabilities?.has_video === false || clip.role !== "music";
}
