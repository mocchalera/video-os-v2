import type { TimelineClip } from "./types.js";
import { enumerateTimelineClipValues } from "../timeline/track-clips.js";

export function isStillImageClip(clip: Pick<TimelineClip, "media_kind">): boolean {
  return clip.media_kind === "image";
}

export function setStillImageHoldFrames(
  clip: TimelineClip,
  frames: number,
  clamp: NonNullable<TimelineClip["still_image"]>["policy_clamp"],
): void {
  const duration = Math.max(1, Math.trunc(frames));
  const previousDuration = clip.timeline_duration_frames;
  clip.timeline_duration_frames = duration;
  if (clip.media_kind === "image") {
    if (!clip.still_image) throw new Error(`still_image_metadata_missing:${clip.clip_id}`);
    clip.still_image.hold_frames = duration;
    if (duration !== previousDuration) clip.still_image.policy_clamp = clamp;
  }
}

export function assertStillImageTimelineTruth(clips: TimelineClip[]): void {
  for (const clip of clips) {
    if (clip.media_kind !== "image") continue;
    if (!clip.still_image) throw new Error(`still_image_metadata_missing:${clip.clip_id}`);
    if (clip.src_in_us !== 0 || clip.src_out_us !== 1) {
      throw new Error(`still_image_source_identity_changed:${clip.clip_id}:${clip.src_in_us}-${clip.src_out_us}`);
    }
    if (clip.timeline_duration_frames !== clip.still_image.hold_frames) {
      throw new Error(`still_image_hold_mismatch:${clip.clip_id}`);
    }
    if (clip.still_image.hold_frames < clip.still_image.min_hold_frames ||
      clip.still_image.hold_frames > clip.still_image.max_hold_frames) {
      throw new Error(`still_image_hold_out_of_policy:${clip.clip_id}`);
    }
  }
}

export function assertStillImageTimelineTruthForTimeline(timeline: {
  tracks?: {
    video?: Array<{ clips?: unknown[] }>;
    audio?: Array<{ clips?: unknown[] }>;
    overlay?: Array<{ clips?: unknown[] }>;
    caption?: Array<{ clips?: unknown[] }>;
  };
}): void {
  assertStillImageTimelineTruth(enumerateTimelineClipValues(timeline) as TimelineClip[]);
}
