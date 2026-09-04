import { describe, expect, it } from "vitest";
import {
  assertSameSourceTalkCutsSynchronized,
  synchronizeSameSourceTalkCuts,
} from "../runtime/compiler/av-sync.js";
import type { AssembledTimeline, TimelineClip } from "../runtime/compiler/types.js";

function clip(overrides: Partial<TimelineClip>): TimelineClip {
  return {
    clip_id: "CLP_BASE",
    segment_id: "SEG_TALK",
    asset_id: "AST_TALK",
    src_in_us: 1_000_000,
    src_out_us: 4_000_000,
    timeline_in_frame: 0,
    timeline_duration_frames: 72,
    role: "dialogue",
    motivation: "talk",
    beat_id: "b01",
    fallback_segment_ids: [],
    confidence: 1,
    quality_flags: [],
    candidate_ref: "cand_talk",
    ...overrides,
  };
}

function timeline(video: TimelineClip, audio: TimelineClip): AssembledTimeline {
  return {
    tracks: {
      video: [{ track_id: "V1", kind: "video", clips: [video] }],
      audio: [{ track_id: "A1", kind: "audio", clips: [audio] }],
    },
    markers: [],
  };
}

describe("same-source talk A/V synchronization", () => {
  it("locks the audio mirror to the exact video source and timeline geometry", () => {
    const video = clip({ clip_id: "V_TALK" });
    const audio = clip({
      clip_id: "A_TALK",
      src_in_us: 1_041_000,
      src_out_us: 4_041_000,
      timeline_in_frame: 1,
      role: "nat_sound",
      motivation: "original clip audio",
    });
    const assembled = timeline(video, audio);

    expect(synchronizeSameSourceTalkCuts(assembled)).toEqual({
      synchronized_clip_ids: ["A_TALK"],
      checked_pairs: 1,
    });
    expect(audio).toMatchObject({
      src_in_us: video.src_in_us,
      src_out_us: video.src_out_us,
      timeline_in_frame: video.timeline_in_frame,
      timeline_duration_frames: video.timeline_duration_frames,
    });
    expect(() => assertSameSourceTalkCutsSynchronized(assembled)).not.toThrow();
  });

  it("does not bind dialogue VO to a different B-roll source", () => {
    const video = clip({
      clip_id: "V_BROLL",
      segment_id: "SEG_RUN",
      asset_id: "AST_RUN",
      role: "support",
    });
    const audio = clip({ clip_id: "A_VO", timeline_in_frame: 1 });
    const assembled = timeline(video, audio);

    expect(synchronizeSameSourceTalkCuts(assembled)).toEqual({
      synchronized_clip_ids: [],
      checked_pairs: 0,
    });
    expect(audio.timeline_in_frame).toBe(1);
  });

  it("fails closed when a post-compile same-source drift is introduced", () => {
    const video = clip({ clip_id: "V_TALK" });
    const audio = clip({
      clip_id: "A_TALK",
      src_in_us: 1_020_000,
      role: "nat_sound",
      motivation: "original clip audio",
    });

    expect(() => assertSameSourceTalkCutsSynchronized(timeline(video, audio)))
      .toThrow("same_source_talk_av_sync_mismatch");
  });
});
