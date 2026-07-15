import { describe, expect, it } from "vitest";
import { applyCutBreathTreatment } from "../runtime/compiler/cut-breath-treatment.js";
import type { SegmentItem } from "../runtime/connectors/ffmpeg-segmenter.js";
import type { ClipOutput, TimelineIR } from "../runtime/compiler/types.js";

describe("cut breath treatment", () => {
  it("retains only room tone before the next utterance and fades that shortened tail", () => {
    const timeline = makeTimeline();
    const result = applyCutBreathTreatment(
      timeline,
      {
        preserve_natural_breath: true,
        cut_tail_hold_sec: 0.35,
        cut_audio_fade_out_sec: 0.2,
      },
      [segment("SEG_1", "AST_1"), segment("SEG_2", "AST_2")],
      new Map([
        ["AST_1", [
          { start_us: 1_000_000, end_us: 10_000_000 },
          { start_us: 10_100_000, end_us: 11_000_000 },
        ]],
      ]),
      30,
    );

    expect(result).toEqual({ extendedCuts: 1, totalExtendedFrames: 3, fadedCuts: 1 });
    const firstVideo = timeline.tracks.video[0].clips[0];
    const secondVideo = timeline.tracks.video[0].clips[1];
    const firstAudio = timeline.tracks.audio[0].clips[0];
    const secondAudio = timeline.tracks.audio[0].clips[1];
    expect(firstVideo.src_out_us).toBe(10_100_000);
    expect(firstVideo.timeline_duration_frames).toBe(273);
    expect(secondVideo.timeline_in_frame).toBe(273);
    expect(secondAudio.timeline_in_frame).toBe(273);
    expect(firstAudio.audio_policy?.fade_out_frames).toBe(3);
    expect(firstVideo.metadata?.cut_breath_treatment).toEqual({
      extended_frames: 3,
      audio_fade_out_frames: 3,
      next_speech_intrusion: false,
      clamped_before_next_speech: true,
    });
    expect(timeline.markers[0].frame).toBe(273);
  });

  it("does not extend a cut when overlapping ASR says the next utterance is already active", () => {
    const timeline = makeTimeline();
    const before = structuredClone(timeline);
    const result = applyCutBreathTreatment(
      timeline,
      { preserve_natural_breath: true, cut_tail_hold_sec: 0.35, cut_audio_fade_out_sec: 0.2 },
      [segment("SEG_1", "AST_1"), segment("SEG_2", "AST_2")],
      new Map([
        ["AST_1", [
          { start_us: 1_000_000, end_us: 10_000_000 },
          { start_us: 9_900_000, end_us: 11_000_000 },
        ]],
      ]),
      30,
    );

    expect(result).toEqual({ extendedCuts: 0, totalExtendedFrames: 0, fadedCuts: 0 });
    expect(timeline).toEqual(before);
  });

  it("is timing-compatible unless cut post-roll is explicitly enabled", () => {
    const timeline = makeTimeline();
    const before = structuredClone(timeline);
    const result = applyCutBreathTreatment(
      timeline,
      { preserve_natural_breath: true },
      [segment("SEG_1", "AST_1")],
      new Map(),
      30,
    );
    expect(result.totalExtendedFrames).toBe(0);
    expect(timeline).toEqual(before);
  });

  it("does not duplicate a contiguous retained range", () => {
    const timeline = makeTimeline();
    timeline.tracks.video[0].clips[1].asset_id = "AST_1";
    timeline.tracks.video[0].clips[1].segment_id = "SEG_1";
    timeline.tracks.video[0].clips[1].src_in_us = 10_000_000;
    timeline.tracks.audio[0].clips[1].asset_id = "AST_1";
    timeline.tracks.audio[0].clips[1].segment_id = "SEG_1";
    timeline.tracks.audio[0].clips[1].src_in_us = 10_000_000;

    const result = applyCutBreathTreatment(
      timeline,
      { preserve_natural_breath: true, cut_tail_hold_sec: 0.35 },
      [segment("SEG_1", "AST_1")],
      new Map(),
      30,
    );
    expect(result.totalExtendedFrames).toBe(0);
    expect(timeline.tracks.video[0].clips[1].timeline_in_frame).toBe(270);
  });
});

function makeTimeline(): TimelineIR {
  const firstVideo = clip("V1_1", "SEG_1", "AST_1", 0, 10_000_000, 0, 270, "dialogue");
  const secondVideo = clip("V1_2", "SEG_2", "AST_2", 0, 10_000_000, 270, 300, "dialogue");
  const firstAudio = clip("A1_1", "SEG_1", "AST_1", 0, 10_000_000, 0, 270, "dialogue");
  const secondAudio = clip("A1_2", "SEG_2", "AST_2", 0, 10_000_000, 270, 300, "dialogue");
  return {
    version: "1",
    project_id: "cut-breath-test",
    created_at: "2026-07-14T00:00:00Z",
    sequence: {
      name: "Cut breath test",
      fps_num: 30,
      fps_den: 1,
      width: 1920,
      height: 1080,
      start_frame: 0,
      sample_rate: 48_000,
    },
    tracks: {
      video: [{ track_id: "V1", kind: "video", clips: [firstVideo, secondVideo] }],
      audio: [{ track_id: "A1", kind: "audio", clips: [firstAudio, secondAudio] }],
    },
    transitions: [],
    markers: [{ frame: 270, kind: "beat", label: "B2" }],
    provenance: {
      brief_path: "01_intent/creative_brief.yaml",
      blueprint_path: "04_plan/edit_blueprint.yaml",
      selects_path: "04_plan/selects_candidates.yaml",
      compiler_version: "test",
    },
  };
}

function clip(
  clipId: string,
  segmentId: string,
  assetId: string,
  srcInUs: number,
  srcOutUs: number,
  timelineInFrame: number,
  timelineDurationFrames: number,
  role: string,
): ClipOutput {
  return {
    clip_id: clipId,
    segment_id: segmentId,
    asset_id: assetId,
    src_in_us: srcInUs,
    src_out_us: srcOutUs,
    timeline_in_frame: timelineInFrame,
    timeline_duration_frames: timelineDurationFrames,
    role,
    motivation: "test",
    beat_id: clipId,
    fallback_segment_ids: [],
    confidence: 1,
    quality_flags: [],
  };
}

function segment(segmentId: string, assetId: string): SegmentItem {
  return {
    segment_id: segmentId,
    asset_id: assetId,
    src_in_us: 0,
    src_out_us: 30_000_000,
    duration_us: 30_000_000,
    rep_frame_us: 15_000_000,
  } as SegmentItem;
}
