/**
 * filter-parity.test.ts — pure-function parity tests for the shared
 * filtergraph builder. Always runs (no ffmpeg dependency).
 *
 * Phase 5 / Section 9.5: preview and final must use the same effect
 * filter serialization. Because both call the same shared builders,
 * structural equivalence is guaranteed by construction. These tests
 * lock that contract in place against accidental drift.
 */

import { describe, expect, it } from "vitest";

import {
  buildEffectFilter,
  buildVideoClipFilter,
  buildVideoClipFilterString,
} from "../../shared/filtergraph.js";
import type {
  RenderEffectSpec,
  RenderVideoClip,
} from "../../shared/render-spec.js";

const SEQ = { width: 1920, height: 1080 };

function clip(overrides: Partial<RenderVideoClip> = {}): RenderVideoClip {
  return {
    clipId: "c0",
    assetId: "a0",
    sourcePath: "/dev/null",
    timelineInFrame: 0,
    durationFrames: 30,
    sourceInSec: 0,
    sourceOutSec: 1,
    transform: { mode: "cover", zoom: 1, anchor: "center" },
    effects: [],
    ...overrides,
  };
}

describe("buildVideoClipFilter — determinism", () => {
  it("produces byte-identical output across repeated calls (no effects)", () => {
    const c = clip();
    const a = buildVideoClipFilterString(c, SEQ);
    const b = buildVideoClipFilterString(c, SEQ);
    expect(a).toBe(b);
  });

  it("produces byte-identical output across repeated calls (with effects)", () => {
    const c = clip({
      effects: [
        { type: "eq", params: { contrast: 1.1, brightness: 0.05 } },
        { type: "curves", params: { preset: "increase_contrast" } },
      ],
    });
    const a = buildVideoClipFilterString(c, SEQ);
    const b = buildVideoClipFilterString(c, SEQ);
    expect(a).toBe(b);
  });
});

describe("buildVideoClipFilter — effect chain placement", () => {
  it("inserts effects between transform and format/setsar", () => {
    const c = clip({
      effects: [{ type: "eq", params: { contrast: 1.2 } }],
    });
    const filters = buildVideoClipFilter(c, SEQ);
    const eqIdx = filters.findIndex((f) => f.startsWith("eq="));
    const formatIdx = filters.indexOf("format=yuv420p");
    const setsarIdx = filters.indexOf("setsar=1");
    expect(eqIdx).toBeGreaterThan(-1);
    expect(eqIdx).toBeLessThan(formatIdx);
    expect(formatIdx).toBeLessThan(setsarIdx);
  });

  it("preserves effect declaration order", () => {
    const c = clip({
      effects: [
        { type: "brightness", params: { value: 0.1 } },
        { type: "saturation", params: { value: 1.4 } },
        { type: "contrast", params: { value: 1.2 } },
      ],
    });
    const filters = buildVideoClipFilter(c, SEQ);
    const onlyEffects = filters.filter((f) => f.startsWith("eq="));
    expect(onlyEffects).toEqual([
      "eq=brightness=0.1",
      "eq=saturation=1.4",
      "eq=contrast=1.2",
    ]);
  });

  it("an empty effect list does not change the baseline filter chain", () => {
    const baseline = buildVideoClipFilterString(clip(), SEQ);
    const noOpEffects = buildVideoClipFilterString(
      clip({ effects: [{ type: "none", params: {} }] }),
      SEQ,
    );
    expect(noOpEffects).toBe(baseline);
  });
});

describe("buildVideoClipFilter — safe zoom pan", () => {
  it("pans inside zoom overscan without introducing a black pad", () => {
    const filters = buildVideoClipFilter(
      clip({
        transform: {
          mode: "cover",
          anchor: "center",
          zoom: 1.15,
          position: { x: -144, y: -39 },
        },
      }),
      SEQ,
    );

    expect(filters).toContain("scale=2208:1242:force_original_aspect_ratio=increase");
    expect(filters).toContain(
      "crop=1920:1080:max(0\\,min(iw-1920\\,(iw-1920)/2--144)):max(0\\,min(ih-1080\\,(ih-1080)/2--39))",
    );
    expect(filters.some((filter) => filter.startsWith("pad=2208:") || filter.includes(":black"))).toBe(false);
  });

  it("clamps a requested pan to the available zoom overscan", () => {
    const filters = buildVideoClipFilter(
      clip({
        transform: {
          mode: "cover",
          anchor: "center",
          zoom: 1.1,
          position: { x: 500, y: -500 },
        },
      }),
      SEQ,
    );

    expect(filters).toContain(
      "crop=1920:1080:max(0\\,min(iw-1920\\,(iw-1920)/2-500)):max(0\\,min(ih-1080\\,(ih-1080)/2--500))",
    );
  });

  it("centers a landscape source after force-increase scaling into portrait output", () => {
    const filters = buildVideoClipFilter(
      clip({
        transform: {
          mode: "cover",
          anchor: "center",
          zoom: 1.01,
          position: { x: 0, y: 0 },
        },
      }),
      { width: 1080, height: 1920 },
    );

    expect(filters).toContain("scale=1091:1939:force_original_aspect_ratio=increase");
    expect(filters).toContain(
      "crop=1080:1920:max(0\\,min(iw-1080\\,(iw-1080)/2-0)):max(0\\,min(ih-1920\\,(ih-1920)/2-0))",
    );
  });
});

describe("buildEffectFilter — supported types", () => {
  it("eq collapses multiple params into a single node", () => {
    const out = buildEffectFilter({
      type: "eq",
      params: { contrast: 1.2, brightness: 0.05, saturation: 1.1, gamma: 1 },
    } satisfies RenderEffectSpec);
    expect(out).toBe("eq=contrast=1.2:brightness=0.05:saturation=1.1:gamma=1");
  });

  it("eq with no recognized keys returns empty string", () => {
    const out = buildEffectFilter({ type: "eq", params: { unknown: 1 } });
    expect(out).toBe("");
  });

  it("brightness shorthand emits eq=brightness=...", () => {
    expect(buildEffectFilter({ type: "brightness", params: { value: 0.2 } })).toBe(
      "eq=brightness=0.2",
    );
    // alias key
    expect(
      buildEffectFilter({ type: "brightness", params: { brightness: -0.1 } }),
    ).toBe("eq=brightness=-0.1");
  });

  it("contrast shorthand emits eq=contrast=...", () => {
    expect(buildEffectFilter({ type: "contrast", params: { value: 1.3 } })).toBe(
      "eq=contrast=1.3",
    );
  });

  it("saturation shorthand emits eq=saturation=...", () => {
    expect(buildEffectFilter({ type: "saturation", params: { value: 0.8 } })).toBe(
      "eq=saturation=0.8",
    );
  });

  it("curves preset", () => {
    expect(
      buildEffectFilter({ type: "curves", params: { preset: "vintage" } }),
    ).toBe("curves=preset=vintage");
  });

  it("curves manual control points", () => {
    expect(
      buildEffectFilter({
        type: "curves",
        params: { red: "0/0 0.5/0.4 1/1", blue: "0/0.1 1/0.9" },
      }),
    ).toBe("curves=red='0/0 0.5/0.4 1/1':blue='0/0.1 1/0.9'");
  });

  it("none returns empty string", () => {
    expect(buildEffectFilter({ type: "none", params: {} })).toBe("");
  });

  it("unknown type returns empty string (degraded, not error)", () => {
    expect(buildEffectFilter({ type: "lut3d", params: { file: "x.cube" } })).toBe(
      "",
    );
  });
});

describe("buildEffectFilter — numeric formatting", () => {
  it("strips trailing zeros without losing precision", () => {
    expect(
      buildEffectFilter({ type: "eq", params: { contrast: 1 } }),
    ).toBe("eq=contrast=1");
    expect(
      buildEffectFilter({ type: "eq", params: { contrast: 1.5 } }),
    ).toBe("eq=contrast=1.5");
    expect(
      buildEffectFilter({ type: "eq", params: { contrast: 1.234567 } }),
    ).toBe("eq=contrast=1.234567");
  });

  it("handles negative values", () => {
    expect(
      buildEffectFilter({ type: "eq", params: { brightness: -0.25 } }),
    ).toBe("eq=brightness=-0.25");
  });
});
