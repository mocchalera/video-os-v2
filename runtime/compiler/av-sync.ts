import type { AssembledTimeline, ClipOutput, TimelineClip } from "./types.js";

type TalkClip = TimelineClip | ClipOutput;
type TalkTracks = {
  video: Array<{ clips: TalkClip[] }>;
  audio: Array<{ clips: TalkClip[] }>;
};

export interface TalkCutSyncResult {
  synchronized_clip_ids: string[];
  checked_pairs: number;
}

function isGeneratedSourceAudio(clip: TalkClip): boolean {
  return clip.motivation === "original clip audio" || clip.role === "nat_sound";
}

function isTalkVideo(clip: TalkClip): boolean {
  return clip.role === "dialogue";
}

function timelineRangesOverlap(left: TalkClip, right: TalkClip): boolean {
  const leftEnd = left.timeline_in_frame + left.timeline_duration_frames;
  const rightEnd = right.timeline_in_frame + right.timeline_duration_frames;
  return left.timeline_in_frame < rightEnd && right.timeline_in_frame < leftEnd;
}

function hasSharedSourceIdentity(video: TalkClip, audio: TalkClip): boolean {
  if (video.asset_id !== audio.asset_id) return false;
  if (video.candidate_ref && audio.candidate_ref) {
    return video.candidate_ref === audio.candidate_ref;
  }
  return video.segment_id === audio.segment_id;
}

function matchingTalkVideo(
  videoClips: TalkClip[],
  audio: TalkClip,
): TalkClip | undefined {
  if (audio.role !== "dialogue" && !isGeneratedSourceAudio(audio)) return undefined;
  const matches = videoClips.filter((video) =>
    hasSharedSourceIdentity(video, audio) &&
    timelineRangesOverlap(video, audio) &&
    (isTalkVideo(video) || isGeneratedSourceAudio(audio))
  );
  if (matches.length === 0) return undefined;
  return matches.sort((left, right) => {
    const leftStartDelta = Math.abs(left.timeline_in_frame - audio.timeline_in_frame);
    const rightStartDelta = Math.abs(right.timeline_in_frame - audio.timeline_in_frame);
    return leftStartDelta - rightStartDelta || left.clip_id.localeCompare(right.clip_id);
  })[0];
}

function geometryMatches(video: TalkClip, audio: TalkClip): boolean {
  return video.asset_id === audio.asset_id &&
    video.src_in_us === audio.src_in_us &&
    video.src_out_us === audio.src_out_us &&
    video.timeline_in_frame === audio.timeline_in_frame &&
    video.timeline_duration_frames === audio.timeline_duration_frames &&
    JSON.stringify(video.freeze_frame_hold ?? null) ===
      JSON.stringify(audio.freeze_frame_hold ?? null);
}

/**
 * Lock same-source talk picture and production audio to one source/timeline
 * geometry. B-roll-over-VO remains untouched because its visual asset/segment
 * is intentionally different from the dialogue source.
 */
export function synchronizeSameSourceTalkCuts(
  assembled: AssembledTimeline,
): TalkCutSyncResult {
  const videos = assembled.tracks.video.flatMap((track) => track.clips);
  const synchronized: string[] = [];
  let checkedPairs = 0;

  for (const audio of assembled.tracks.audio.flatMap((track) => track.clips)) {
    const video = matchingTalkVideo(videos, audio);
    if (!video) continue;
    checkedPairs += 1;
    if (!geometryMatches(video, audio)) {
      audio.src_in_us = video.src_in_us;
      audio.src_out_us = video.src_out_us;
      audio.timeline_in_frame = video.timeline_in_frame;
      audio.timeline_duration_frames = video.timeline_duration_frames;
      audio.beat_id = video.beat_id;
      audio.freeze_frame_hold = video.freeze_frame_hold
        ? { ...video.freeze_frame_hold }
        : undefined;
      synchronized.push(audio.clip_id);
    }
  }

  assertSameSourceTalkCutsSynchronized(assembled);
  return {
    synchronized_clip_ids: synchronized.sort(),
    checked_pairs: checkedPairs,
  };
}

/** Fail closed if a later compiler phase reintroduces same-source A/V drift. */
export function assertSameSourceTalkCutsSynchronized(
  input: { tracks: TalkTracks },
): void {
  const videos = input.tracks.video.flatMap((track) => track.clips);
  for (const audio of input.tracks.audio.flatMap((track) => track.clips)) {
    const video = matchingTalkVideo(videos, audio);
    if (!video || geometryMatches(video, audio)) continue;
    throw new Error(
      `same_source_talk_av_sync_mismatch: video=${video.clip_id} audio=${audio.clip_id} ` +
      `source=${video.asset_id} video_range=${video.src_in_us}-${video.src_out_us} ` +
      `audio_range=${audio.src_in_us}-${audio.src_out_us}`,
    );
  }
}
