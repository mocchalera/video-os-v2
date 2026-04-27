import { describe, expect, it } from "vitest";
import type { TimelineIR, ClipOutput } from "../runtime/compiler/types.js";
import { timelineToCompositionProps } from "../runtime/render/remotion/timeline-to-props.js";

function makeClip(overrides: Partial<ClipOutput>): ClipOutput {
  return {
    clip_id: "clip-1",
    segment_id: "segment-1",
    asset_id: "asset-1",
    src_in_us: 0,
    src_out_us: 1_000_000,
    timeline_in_frame: 0,
    timeline_duration_frames: 30,
    role: "primary",
    motivation: "test",
    beat_id: "beat-1",
    fallback_segment_ids: [],
    confidence: 1,
    quality_flags: [],
    ...overrides,
  };
}

function makeTimeline(clips: ClipOutput[], fpsNum = 30, fpsDen = 1): TimelineIR {
  return {
    version: "1",
    project_id: "remotion-test",
    created_at: "2026-04-27T00:00:00.000Z",
    sequence: {
      name: "Remotion Test",
      fps_num: fpsNum,
      fps_den: fpsDen,
      width: 1920,
      height: 1080,
      start_frame: 0,
      letterbox_policy: "none",
    },
    tracks: {
      video: [
        {
          track_id: "V1",
          kind: "video",
          clips,
        },
      ],
      audio: [],
    },
    markers: [],
    provenance: {
      brief_path: "01_intent/creative_brief.yaml",
      blueprint_path: "02_blueprint/edit_blueprint.yaml",
      selects_path: "04_selects/selects_candidates.yaml",
      compiler_version: "test",
    },
  };
}

describe("timelineToCompositionProps", () => {
  it("uses fail-safe duration for an empty timeline", () => {
    const props = timelineToCompositionProps(makeTimeline([]), {});

    expect(props.durationInFrames).toBe(1);
    expect(props.fps).toBe(30);
    expect(props.width).toBe(1920);
    expect(props.height).toBe(1080);
  });

  it("computes duration from a single video clip", () => {
    const timeline = makeTimeline([
      makeClip({ timeline_in_frame: 12, timeline_duration_frames: 48 }),
    ]);

    expect(timelineToCompositionProps(timeline, {}).durationInFrames).toBe(60);
  });

  it("computes duration from the maximum clip end across gaps", () => {
    const timeline = makeTimeline([
      makeClip({
        clip_id: "clip-1",
        timeline_in_frame: 0,
        timeline_duration_frames: 30,
      }),
      makeClip({
        clip_id: "clip-2",
        timeline_in_frame: 72,
        timeline_duration_frames: 24,
      }),
    ]);

    expect(timelineToCompositionProps(timeline, {}).durationInFrames).toBe(96);
  });

  it("rounds non-integer fps for Remotion", () => {
    const timeline = makeTimeline([], 24_000, 1_001);

    expect(timelineToCompositionProps(timeline, {}).fps).toBe(24);
  });
});

