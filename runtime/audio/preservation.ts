interface TimelineAudioClip {
  role?: unknown;
  audio_policy?: { a1_loudnorm?: unknown };
}

interface TimelineAudioTrack {
  track_id?: unknown;
  clips?: TimelineAudioClip[];
}

interface TimelineAudioPolicyInput {
  provenance?: { audio_policy?: { mode?: unknown } };
  tracks?: { audio?: TimelineAudioTrack[] };
  audio_mix?: { bgm_asset_id?: unknown };
}

function isMusicClip(track: TimelineAudioTrack, clip: TimelineAudioClip): boolean {
  return track.track_id === "A2" || track.track_id === "A3" ||
    clip.role === "music" || clip.role === "bgm";
}

/** True only when the timeline explicitly requires unchanged original audio level. */
export function shouldPreserveOriginalAudioLevel(
  timeline: TimelineAudioPolicyInput,
): boolean {
  if (timeline.provenance?.audio_policy?.mode !== "original_only") return false;
  if (typeof timeline.audio_mix?.bgm_asset_id === "string") return false;

  const tracks = Array.isArray(timeline.tracks?.audio) ? timeline.tracks.audio : [];
  const allClips = tracks.flatMap((track) =>
    (Array.isArray(track.clips) ? track.clips : []).map((clip) => ({ track, clip }))
  );
  if (allClips.some(({ track, clip }) => isMusicClip(track, clip))) return false;

  const originalClips = allClips.filter(({ track, clip }) => !isMusicClip(track, clip));
  return originalClips.length > 0 &&
    originalClips.every(({ clip }) => clip.audio_policy?.a1_loudnorm === false);
}
