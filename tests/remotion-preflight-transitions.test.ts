import { describe, expect, it } from "vitest";
import { preflightTransition } from "../runtime/render/remotion/preflight-transitions.js";

const BASE_TRANSITION = {
  transition_id: "TR_001",
  from_clip_id: "CLIP_A",
  to_clip_id: "CLIP_B",
};

const BASE_CLIP = {
  src_in_us: 0,
  src_out_us: 5_000_000,
  timeline_duration_frames: 120,
};

describe("preflightTransition", () => {
  it("keeps cut transitions as non-degraded", () => {
    expect(
      preflightTransition(
        { ...BASE_TRANSITION, transition_type: "cut", duration_frames: 24 },
        BASE_CLIP,
        BASE_CLIP,
        24,
      ),
    ).toEqual({
      transition_id: "TR_001",
      effective_type: "cut",
      degraded: false,
    });
  });

  it("does not require handles for fade_to_black or dip_to_white", () => {
    for (const transition_type of ["fade_to_black", "dip_to_white"]) {
      expect(
        preflightTransition(
          { ...BASE_TRANSITION, transition_type, duration_frames: 240 },
          { ...BASE_CLIP, timeline_duration_frames: 1 },
          { ...BASE_CLIP, timeline_duration_frames: 1 },
          24,
        ),
      ).toEqual({
        transition_id: "TR_001",
        effective_type: transition_type,
        degraded: false,
      });
    }
  });

  it("keeps crossfade when both clips are at least the transition duration", () => {
    expect(
      preflightTransition(
        { ...BASE_TRANSITION, transition_type: "crossfade", duration_frames: 24 },
        { ...BASE_CLIP, timeline_duration_frames: 24 },
        { ...BASE_CLIP, timeline_duration_frames: 36 },
        24,
      ),
    ).toEqual({
      transition_id: "TR_001",
      effective_type: "crossfade",
      degraded: false,
    });
  });

  it("degrades crossfade when the outgoing clip is shorter than the transition duration", () => {
    expect(
      preflightTransition(
        { ...BASE_TRANSITION, transition_type: "crossfade", duration_frames: 24 },
        { ...BASE_CLIP, timeline_duration_frames: 23 },
        { ...BASE_CLIP, timeline_duration_frames: 36 },
        24,
      ),
    ).toEqual({
      transition_id: "TR_001",
      effective_type: "cut",
      degraded: true,
      degraded_reason: "insufficient_clip_duration_for_handle",
    });
  });

  it("uses the same handle check for match_cut_soft", () => {
    expect(
      preflightTransition(
        { ...BASE_TRANSITION, transition_type: "match_cut_soft", duration_frames: 12 },
        { ...BASE_CLIP, timeline_duration_frames: 12 },
        { ...BASE_CLIP, timeline_duration_frames: 11 },
        24,
      ),
    ).toEqual({
      transition_id: "TR_001",
      effective_type: "cut",
      degraded: true,
      degraded_reason: "insufficient_clip_duration_for_handle",
    });
  });

  it("skips handle checks when duration_frames and transition_frames are missing or zero", () => {
    for (const transition of [
      { ...BASE_TRANSITION, transition_type: "crossfade" },
      { ...BASE_TRANSITION, transition_type: "crossfade", duration_frames: 0 },
    ]) {
      expect(
        preflightTransition(
          transition,
          { ...BASE_CLIP, timeline_duration_frames: 1 },
          { ...BASE_CLIP, timeline_duration_frames: 1 },
          24,
        ),
      ).toEqual({
        transition_id: "TR_001",
        effective_type: "crossfade",
        degraded: false,
      });
    }
  });
});
