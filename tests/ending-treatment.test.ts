import { describe, expect, it } from "vitest";
import {
  applyEndingTreatment,
  resolveEndingTreatment,
} from "../runtime/compiler/ending-treatment.js";
import type { SegmentItem } from "../runtime/connectors/ffmpeg-segmenter.js";
import type { ClipOutput, TimelineIR } from "../runtime/compiler/types.js";

describe("ending treatment", () => {
  it("applies fade and tail metadata directly to a pure-audio program clip", () => {
    const timeline = timelineWithMirroredEnding();
    timeline.tracks.video = [];
    timeline.tracks.audio[0].clips = [endingClip("AUDIO_END", "dialogue")];
    timeline.tracks.audio[0].clips[0].media_kind = "audio";
    timeline.tracks.audio[0].clips[0].source_capabilities = { has_video: false, has_audio: true };
    const result = applyEndingTreatment(timeline, { should_feel: "resolved", tail_hold_sec: 1, audio_fade_out_sec: 0.5 }, [{
      segment_id: "SEG_END", asset_id: "AST_END", src_in_us: 0, src_out_us: 20_000_000, duration_us: 20_000_000,
    } as SegmentItem], 24);

    expect(result).toMatchObject({ extendedFrames: 24, audioClipCount: 0 });
    expect(timeline.tracks.audio[0].clips[0].audio_policy?.fade_out_frames).toBe(12);
    expect(timeline.tracks.audio[0].clips[0].metadata?.ending_treatment).toMatchObject({
      extended_frames: 24, audio_fade_out_frames: 12,
    });
  });

  it("keeps legacy blueprints unchanged unless an ending treatment is requested", () => {
    expect(resolveEndingTreatment({ should_feel: "resolved" })).toEqual({
      tailHoldSec: 0,
      audioFadeOutSec: 0,
      videoFadeOutSec: 0,
      videoFadeColor: "none",
    });

    const timeline = timelineWithMirroredEnding();
    const before = structuredClone(timeline);
    applyEndingTreatment(timeline, { should_feel: "resolved" }, [], 24);
    expect(timeline).toEqual(before);
  });

  it("extends the final mirrored clips and records audio/video fades", () => {
    const timeline = timelineWithMirroredEnding();
    const result = applyEndingTreatment(
      timeline,
      {
        should_feel: "resolved",
        tail_hold_sec: 3,
        audio_fade_out_sec: 2,
        video_fade_out_sec: 1.5,
        video_fade_color: "black",
      },
      [{
        segment_id: "SEG_END",
        asset_id: "AST_END",
        src_in_us: 0,
        src_out_us: 20_000_000,
        duration_us: 20_000_000,
        rep_frame_us: 10_000_000,
      } as SegmentItem],
      24,
    );

    const video = timeline.tracks.video[0].clips[0];
    const audio = timeline.tracks.audio[0].clips[0];
    expect(result).toMatchObject({
      extendedFrames: 72,
      audioClipCount: 1,
      finalVideoClipId: "CLP_END",
    });
    expect(video.src_out_us).toBe(13_000_000);
    expect(video.timeline_duration_frames).toBe(312);
    expect(audio.src_out_us).toBe(13_000_000);
    expect(audio.timeline_duration_frames).toBe(312);
    expect(audio.audio_policy).toMatchObject({
      fade_out_frames: 48,
      nat_sound_fade_out_frames: 48,
    });
    expect(video.metadata?.ending_treatment).toEqual({
      extended_frames: 72,
      audio_fade_out_frames: 48,
      video_fade_out_frames: 36,
      video_fade_color: "black",
      clamped_before_next_speech: false,
    });
  });

  it("caps post-roll at the available source handle", () => {
    const timeline = timelineWithMirroredEnding();
    const result = applyEndingTreatment(
      timeline,
      { should_feel: "resolved", tail_hold_sec: 3, audio_fade_out_sec: 1 },
      [{
        segment_id: "SEG_END",
        asset_id: "AST_END",
        src_in_us: 0,
        src_out_us: 10_500_000,
        duration_us: 10_500_000,
        rep_frame_us: 5_000_000,
      } as SegmentItem],
      24,
    );

    expect(result.extendedFrames).toBe(12);
    expect(timeline.tracks.video[0].clips[0].src_out_us).toBe(10_500_000);
  });

  it("clamps final post-roll before the next transcript utterance", () => {
    const timeline = timelineWithMirroredEnding();
    const result = applyEndingTreatment(
      timeline,
      {
        should_feel: "resolved",
        tail_hold_sec: 3,
        audio_fade_out_sec: 2,
        video_fade_out_sec: 1.5,
        video_fade_color: "black",
      },
      [{
        segment_id: "SEG_END",
        asset_id: "AST_END",
        src_in_us: 0,
        src_out_us: 20_000_000,
        duration_us: 20_000_000,
        rep_frame_us: 10_000_000,
      } as SegmentItem],
      24,
      new Map([["AST_END", [
        { start_us: 0, end_us: 10_000_000, text: "complete final assertion" },
        { start_us: 10_500_000, end_us: 12_000_000, text: "next assertion" },
      ]]]),
    );

    expect(result.extendedFrames).toBe(12);
    expect(timeline.tracks.video[0].clips[0].src_out_us).toBe(10_500_000);
    expect(timeline.tracks.video[0].clips[0].metadata?.ending_treatment).toMatchObject({
      clamped_before_next_speech: true,
    });
  });
});

function timelineWithMirroredEnding(): TimelineIR {
  const video = endingClip("CLP_END", "dialogue");
  const audio = endingClip("ACL_END", "nat_sound");
  return {
    version: "1",
    project_id: "ending-test",
    created_at: "2026-07-14T00:00:00Z",
    sequence: {
      name: "Ending test",
      fps_num: 24,
      fps_den: 1,
      width: 1920,
      height: 1080,
      start_frame: 0,
      sample_rate: 48_000,
    },
    tracks: {
      video: [{ track_id: "V1", kind: "video", clips: [video] }],
      audio: [{ track_id: "A1", kind: "audio", clips: [audio] }],
    },
    transitions: [],
    markers: [],
    provenance: {
      brief_path: "01_intent/creative_brief.yaml",
      blueprint_path: "04_plan/edit_blueprint.yaml",
      selects_path: "04_plan/selects_candidates.yaml",
      compiler_version: "test",
    },
  };
}

function endingClip(clipId: string, role: string): ClipOutput {
  return {
    clip_id: clipId,
    segment_id: "SEG_END",
    asset_id: "AST_END",
    src_in_us: 0,
    src_out_us: 10_000_000,
    timeline_in_frame: 0,
    timeline_duration_frames: 240,
    role,
    motivation: "ending",
    beat_id: "B_END",
    fallback_segment_ids: [],
    confidence: 1,
    quality_flags: [],
  };
}
