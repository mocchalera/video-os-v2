/**
 * spec-builder-effects.test.ts — Phase 5 / Section 9.5
 *
 * Verifies that buildRenderSpec correctly:
 *   1. maps clip.metadata.render.effects[] → RenderVideoClip.effects in order
 *   2. preserves params (numeric and string)
 *   3. degrades unknown effect types to a warning (no error thrown)
 *   4. returns the same renderSpecHash for the same input (determinism)
 */

import { describe, expect, it } from "vitest";
import { buildRenderSpec } from "../../shared/render-spec.js";

const FAKE_PATH = "/dev/null/source.mp4";
const resolver = () => FAKE_PATH;

interface ClipInput {
  clip_id: string;
  asset_id: string;
  src_in_us: number;
  src_out_us: number;
  timeline_in_frame: number;
  timeline_duration_frames: number;
  metadata?: Record<string, unknown>;
}

function makeTimeline(clips: ClipInput[]) {
  return {
    sequence: { fps_num: 30, fps_den: 1, width: 1920, height: 1080 },
    tracks: {
      video: [{ track_id: "v0", kind: "video", clips }],
      audio: [],
    },
  };
}

describe("buildRenderSpec — effect chain mapping", () => {
  it("maps metadata.render.effects[] in declared order", () => {
    const tl = makeTimeline([
      {
        clip_id: "c1",
        asset_id: "a1",
        src_in_us: 0,
        src_out_us: 1_000_000,
        timeline_in_frame: 0,
        timeline_duration_frames: 30,
        metadata: {
          render: {
            effects: [
              { type: "brightness", params: { value: 0.1 } },
              { type: "saturation", params: { value: 1.2 } },
            ],
          },
        },
      },
    ]);

    const spec = buildRenderSpec(tl, "rev1", resolver);
    expect(spec.video.clips[0].effects).toEqual([
      { type: "brightness", params: { value: 0.1 } },
      { type: "saturation", params: { value: 1.2 } },
    ]);
    expect(spec.warnings.some((w) => w.includes("unsupported"))).toBe(false);
  });

  it("degrades unsupported effect types to a warning, not an error", () => {
    const tl = makeTimeline([
      {
        clip_id: "c1",
        asset_id: "a1",
        src_in_us: 0,
        src_out_us: 1_000_000,
        timeline_in_frame: 0,
        timeline_duration_frames: 30,
        metadata: {
          render: {
            effects: [
              { type: "lut3d", params: { file: "preset.cube" } },
              { type: "eq", params: { contrast: 1.1 } },
            ],
          },
        },
      },
    ]);

    const spec = buildRenderSpec(tl, "rev1", resolver);
    // lut3d skipped, eq retained
    expect(spec.video.clips[0].effects).toEqual([
      { type: "eq", params: { contrast: 1.1 } },
    ]);
    expect(
      spec.warnings.some(
        (w) => w.includes("lut3d") && w.includes("unsupported"),
      ),
    ).toBe(true);
  });

  it("treats type=none as a no-op (filtered out of effects[])", () => {
    const tl = makeTimeline([
      {
        clip_id: "c1",
        asset_id: "a1",
        src_in_us: 0,
        src_out_us: 1_000_000,
        timeline_in_frame: 0,
        timeline_duration_frames: 30,
        metadata: {
          render: {
            effects: [{ type: "none", params: {} }],
          },
        },
      },
    ]);

    const spec = buildRenderSpec(tl, "rev1", resolver);
    expect(spec.video.clips[0].effects).toEqual([]);
  });

  it("emits a deterministic hash for the same input", () => {
    const tl = makeTimeline([
      {
        clip_id: "c1",
        asset_id: "a1",
        src_in_us: 0,
        src_out_us: 1_000_000,
        timeline_in_frame: 0,
        timeline_duration_frames: 30,
        metadata: {
          render: {
            effects: [{ type: "eq", params: { contrast: 1.2 } }],
          },
        },
      },
    ]);

    const a = buildRenderSpec(tl, "rev1", resolver).renderSpecHash;
    const b = buildRenderSpec(tl, "rev1", resolver).renderSpecHash;
    expect(a).toBe(b);
  });

  it("hash changes when an effect parameter changes", () => {
    const make = (contrast: number) =>
      buildRenderSpec(
        makeTimeline([
          {
            clip_id: "c1",
            asset_id: "a1",
            src_in_us: 0,
            src_out_us: 1_000_000,
            timeline_in_frame: 0,
            timeline_duration_frames: 30,
            metadata: {
              render: { effects: [{ type: "eq", params: { contrast } }] },
            },
          },
        ]),
        "rev1",
        resolver,
      ).renderSpecHash;

    expect(make(1.1)).not.toBe(make(1.2));
  });
});
