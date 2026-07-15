import { describe, expect, it } from "vitest";
import {
  applyDialogueSemanticRepair,
  repairDialogueRange,
} from "../runtime/compiler/dialogue-semantic-repair.js";
import type { SegmentItem } from "../runtime/connectors/ffmpeg-segmenter.js";
import type { AssembledTimeline, TimelineClip } from "../runtime/compiler/types.js";
import type { UtteranceSpan } from "../runtime/compiler/trim.js";

const UTTERANCES: UtteranceSpan[] = [
  {
    start_us: 0,
    end_us: 2_000_000,
    speaker: "guest",
    text: "受講前はAIを資料作成に使っていました",
  },
  {
    start_us: 2_100_000,
    end_us: 4_000_000,
    speaker: "guest",
    text: "ってことは僕も変わらなかったと思いますけど",
  },
  {
    start_us: 4_100_000,
    end_us: 6_000_000,
    speaker: "guest",
    text: "実際に受講して使い方が変わりました",
  },
];

describe("dialogue semantic repair", () => {
  it("expands both boundaries until a dependent fragment becomes self-contained", () => {
    const result = repairDialogueRange(
      2_100_000,
      4_000_000,
      UTTERANCES,
      { min_us: 0, max_us: 10_000_000 },
    );

    expect(result).toMatchObject({
      status: "repaired",
      src_in_us: 0,
      src_out_us: 6_000_000,
      attempts: 1,
      added_utterance_count: 2,
      issues_after: [],
    });
    expect(result.issues_before.map((issue) => issue.code)).toEqual([
      "dependent_opening",
      "dependent_ending",
    ]);
  });

  it("does not import an interviewer line to repair a missing antecedent", () => {
    const result = repairDialogueRange(
      2_100_000,
      6_000_000,
      [
        { ...UTTERANCES[0], speaker: "interviewer" },
        UTTERANCES[1],
        UTTERANCES[2],
      ],
      { min_us: 0, max_us: 10_000_000 },
    );

    expect(result.status).toBe("unresolved");
    expect(result.src_in_us).toBe(2_100_000);
    expect(result.issues_after.map((issue) => issue.code)).toContain("dependent_opening");
  });

  it("keeps the original range when the bounded loop cannot complete safely", () => {
    const result = repairDialogueRange(
      2_100_000,
      4_000_000,
      UTTERANCES,
      { min_us: 2_100_000, max_us: 4_000_000 },
    );

    expect(result).toMatchObject({
      status: "unresolved",
      src_in_us: 2_100_000,
      src_out_us: 4_000_000,
      added_utterance_count: 0,
    });
  });

  it("ripples later clips and mirrors after a successful repair", () => {
    const timeline = makeTimeline();
    const result = applyDialogueSemanticRepair(
      timeline,
      new Map([["AST_INTERVIEW", UTTERANCES]]),
      [segment("SEG_INTERVIEW", "AST_INTERVIEW")],
      24,
    );

    expect(result).toEqual({
      attemptedClips: 1,
      repairedClips: 1,
      unresolvedClips: 0,
      totalAddedFrames: 98,
    });
    const firstVideo = timeline.tracks.video[0].clips[0];
    const firstAudio = timeline.tracks.audio[0].clips[0];
    const secondVideo = timeline.tracks.video[0].clips[1];
    expect(firstVideo.src_in_us).toBe(0);
    expect(firstVideo.src_out_us).toBe(6_000_000);
    expect(firstVideo.timeline_duration_frames).toBe(144);
    expect(firstAudio).toMatchObject({
      src_in_us: 0,
      src_out_us: 6_000_000,
      timeline_duration_frames: 144,
    });
    expect(secondVideo.timeline_in_frame).toBe(144);
    expect(timeline.tracks.audio[0].clips[1].timeline_in_frame).toBe(144);
    expect(timeline.markers[0].frame).toBe(144);
    expect(firstVideo.metadata?.dialogue_semantic_repair).toMatchObject({
      status: "repaired",
      attempts: 1,
      added_utterance_count: 2,
      added_frames: 98,
      issues_after: [],
    });
  });
});

function makeTimeline(): AssembledTimeline {
  const firstVideo = clip("V1_1", "SEG_INTERVIEW", "AST_INTERVIEW", 2_100_000, 4_000_000, 0, 46);
  const secondVideo = clip("V1_2", "SEG_OTHER", "AST_OTHER", 0, 2_000_000, 46, 48);
  const firstAudio = clip("A1_1", "SEG_INTERVIEW", "AST_INTERVIEW", 2_100_000, 4_000_000, 0, 46);
  const secondAudio = clip("A1_2", "SEG_OTHER", "AST_OTHER", 0, 2_000_000, 46, 48);
  return {
    tracks: {
      video: [{ track_id: "V1", kind: "video", clips: [firstVideo, secondVideo] }],
      audio: [{ track_id: "A1", kind: "audio", clips: [firstAudio, secondAudio] }],
    },
    markers: [{ frame: 46, kind: "beat", label: "b02" }],
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
): TimelineClip {
  return {
    clip_id: clipId,
    segment_id: segmentId,
    asset_id: assetId,
    src_in_us: srcInUs,
    src_out_us: srcOutUs,
    timeline_in_frame: timelineInFrame,
    timeline_duration_frames: timelineDurationFrames,
    role: "dialogue",
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
    src_out_us: 10_000_000,
    duration_us: 10_000_000,
    rep_frame_us: 5_000_000,
  } as SegmentItem;
}
