import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { validateTimeline } from "../editor/shared/timeline-validation.js";

type ValidatableTimeline = Parameters<typeof validateTimeline>[0];

const FIXTURE_ROOT = path.resolve(
  "outputs/019eee15-26e2-7cd0-b070-cb96ee4ee5ed/ui-test-projects",
);

function loadFixtureTimeline(projectId: string): ValidatableTimeline {
  const timelinePath = path.join(projectId, "05_timeline", "timeline.json");
  return JSON.parse(
    fs.readFileSync(path.join(FIXTURE_ROOT, timelinePath), "utf-8"),
  ) as ValidatableTimeline;
}

function makeClip(clipId: string, timelineInFrame: number) {
  return {
    clip_id: clipId,
    segment_id: `SEG_${clipId}`,
    asset_id: `AST_${clipId}`,
    src_in_us: 0,
    src_out_us: 2_000_000,
    timeline_in_frame: timelineInFrame,
    timeline_duration_frames: 48,
    motivation: "test clip",
  };
}

describe("timeline validation fixtures", () => {
  it("keeps the UI save fixtures valid for normal save-story coverage", () => {
    expect(validateTimeline(loadFixtureTimeline("clean-ui"))).toEqual([]);
    expect(validateTimeline(loadFixtureTimeline("sample-ui"))).toEqual([]);
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
