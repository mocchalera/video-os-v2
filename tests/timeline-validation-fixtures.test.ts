import { describe, expect, it } from "vitest";
import { validateTimeline } from "../editor/shared/timeline-validation.js";

type ValidatableTimeline = Parameters<typeof validateTimeline>[0];

function makeClip(
  clipId: string,
  timelineInFrame: number,
  timelineDurationFrames = 48,
) {
  return {
    clip_id: clipId,
    segment_id: `SEG_${clipId}`,
    asset_id: `AST_${clipId}`,
    src_in_us: 0,
    src_out_us: 2_000_000,
    timeline_in_frame: timelineInFrame,
    timeline_duration_frames: timelineDurationFrames,
    motivation: "test clip",
  };
}

function makeTimelineFixture(
  videoClips: ReturnType<typeof makeClip>[],
  audioClips: ReturnType<typeof makeClip>[] = [],
): ValidatableTimeline {
  return {
    sequence: {
      fps_num: 24,
      fps_den: 1,
    },
    tracks: {
      video: [{ track_id: "V1", clips: videoClips }],
      audio: [{ track_id: "A1", clips: audioClips }],
    },
  };
}

describe("timeline validation fixtures", () => {
  it("keeps representative UI save timelines valid", () => {
    const normalSave = makeTimelineFixture([
      makeClip("001", 0),
      makeClip("002", 48),
    ]);
    const saveWithStackedAudioAlternatives = makeTimelineFixture(
      [makeClip("003", 0), makeClip("004", 48)],
      [
        makeClip("005", 0, 48),
        makeClip("006", 0, 72),
        makeClip("007", 48),
      ],
    );

    expect(validateTimeline(normalSave)).toEqual([]);
    expect(validateTimeline(saveWithStackedAudioAlternatives)).toEqual([]);
  });

  it("reports true temporal overlaps for the save validation guard", () => {
    const issues = validateTimeline({
      sequence: {
        fps_num: 24,
        fps_den: 1,
      },
      tracks: {
        video: [
          {
            track_id: "V1",
            clips: [
              makeClip("001", 0),
              makeClip("002", 24),
            ],
          },
        ],
        audio: [],
      },
    });

    expect(issues).toEqual([
      {
        path: "video.V1.clips[1].timeline_in_frame",
        message: "Track V1 has overlapping clips.",
      },
    ]);
  });
});
