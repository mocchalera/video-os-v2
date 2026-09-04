import { describe, expect, it } from "vitest";
import { createElement } from "react";
import {
  resolveTransitionPreset,
  transitionPresets,
} from "../runtime/render/remotion/styles/transition-presets.js";

const EXPECTED_PRESETS = [
  ["cut", false],
  ["crossfade", true],
  ["fade_to_black", false],
  ["dip_to_white", false],
  ["match_cut_soft", true],
  // Issue #34 semantic presets (A/B roll overlap)
  ["film_crossfade", true],
  ["light_leak_flash", true],
  ["dreamy_focus_blur", true],
] as const;

describe("Remotion transition preset registry", () => {
  it.each(EXPECTED_PRESETS)(
    "resolves %s with requiresHandles=%s",
    (transitionType, requiresHandles) => {
      const preset = resolveTransitionPreset(transitionType);

      expect(preset).not.toBeNull();
      expect(preset?.id).toBe(transitionType);
      expect(preset?.requiresHandles).toBe(requiresHandles);
    },
  );

  it("returns null for visual no-op legacy audio transitions and unknown transitions", () => {
    expect(resolveTransitionPreset("j_cut")).toBeNull();
    expect(resolveTransitionPreset("unknown")).toBeNull();
  });

  it("contains the renderable presets with render functions", () => {
    expect(transitionPresets.size).toBe(EXPECTED_PRESETS.length);

    for (const [transitionType] of EXPECTED_PRESETS) {
      const preset = resolveTransitionPreset(transitionType);
      expect(typeof preset?.render).toBe("function");
    }
  });
});

// ── Issue #34 A/B children compositing ────────────────────────────────

describe("Remotion A/B roll presets composite real A and B children", () => {
  const childA = createElement("div", { id: "clip-a" });
  const childB = createElement("div", { id: "clip-b" });

  /** The A/B presets wrap their layers in a Fragment inside the root fill. */
  const fragmentChildren = (element: unknown): unknown[] => {
    const fragment = (element as { props: { children: { props: { children: unknown[] } } } })
      .props.children;
    return fragment.props.children;
  };

  it("film_crossfade dissolves A out on top of B", () => {
    const preset = resolveTransitionPreset("film_crossfade")!;
    const element = preset.render({ progress: 0.25, childrenA: childA, childrenB: childB });

    expect(element).not.toBeNull();
    const [under, over] = fragmentChildren(element);
    // B sits beneath untouched…
    expect(under).toBe(childB);
    // …and A fades out on top with linear opacity 1 - progress.
    const overlay = over as { props: { style: { opacity: number }; children: unknown } };
    expect(overlay.props.style.opacity).toBeCloseTo(0.75, 9);
    expect(overlay.props.children).toBe(childA);
  });

  it("film_crossfade drops the A overlay once the blend completes", () => {
    const preset = resolveTransitionPreset("film_crossfade")!;
    const element = preset.render({ progress: 1, childrenA: childA, childrenB: childB });
    const [, over] = fragmentChildren(element);
    expect(over).toBeNull();
  });

  it("film_crossfade stays a passthrough fill without children", () => {
    const preset = resolveTransitionPreset("film_crossfade")!;
    const element = preset.render({ progress: 0.25 });
    const [under, over] = fragmentChildren(element);
    expect(under).toBeNull();
    expect(over).toBeNull();
  });

  it("dreamy_focus_blur shares a smooth sine blur ramp across A and B", () => {
    const preset = resolveTransitionPreset("dreamy_focus_blur")!;

    // Mid-window: peak blur, A half faded.
    const [under, over] = fragmentChildren(
      preset.render({ progress: 0.5, childrenA: childA, childrenB: childB }),
    ) as Array<{
      props: { style: { filter: string; opacity?: number }; children: unknown };
    }>;
    expect(under.props.style.filter).toBe("blur(6.00px)");
    expect(under.props.children).toBe(childB);
    expect(over.props.style.filter).toBe("blur(6.00px)");
    expect(over.props.style.opacity).toBeCloseTo(0.5, 9);
    expect(over.props.children).toBe(childA);

    // Window boundaries: zero blur — and the filter property is omitted
    // entirely so the edge frames rasterize identically to the unstyled
    // render (no boundary pop).
    for (const progress of [0, 1]) {
      const [underEdge] = fragmentChildren(
        preset.render({ progress, childrenA: childA, childrenB: childB }),
      ) as Array<{ props: { style: { filter?: string } } }>;
      expect(underEdge.props.style.filter).toBeUndefined();
    }
  });

  it("light_leak_flash composites A and B with a two-sided flare envelope", () => {
    const preset = resolveTransitionPreset("light_leak_flash")!;
    const window = 12; // blend 6 + decay 6
    type LayerNode = { props: { style: { opacity?: number }; children?: unknown } } | null;

    // Blend phase start: B beneath, A fully opaque, flare 0 (absent).
    const [bStart, aStart, flareStart] = fragmentChildren(
      preset.render({ progress: 0, localFrame: 0, durationInFrames: window, childrenA: childA, childrenB: childB }),
    ) as Array<LayerNode>;
    expect(bStart).toBe(childB);
    expect(aStart!.props.style.opacity).toBe(1);
    expect(aStart!.props.children).toBe(childA);
    expect(flareStart).toBeNull();

    // Seam frame (peakAt = durationInFrames / 2): flare peak, A dissolved.
    const [bSeam, aSeam, flareSeam] = fragmentChildren(
      preset.render({ progress: 1, localFrame: 6, durationInFrames: window, childrenA: childA, childrenB: childB }),
    ) as Array<LayerNode>;
    expect(bSeam).toBe(childB);
    expect(aSeam).toBeNull();
    expect(flareSeam!.props.style.opacity).toBe(1);

    // Decay: flare halfway gone while B remains visible and A stays gone.
    const [bDecay, aDecay, flareDecay] = fragmentChildren(
      preset.render({ progress: 1, localFrame: 9, durationInFrames: window, childrenA: childA, childrenB: childB }),
    ) as Array<LayerNode>;
    expect(bDecay).toBe(childB);
    expect(aDecay).toBeNull();
    expect(flareDecay!.props.style.opacity).toBeCloseTo(0.5, 9);

    // Window end: flare fully decayed.
    const [, , flareEnd] = fragmentChildren(
      preset.render({ progress: 1, localFrame: 12, durationInFrames: window, childrenA: childA, childrenB: childB }),
    );
    expect(flareEnd).toBeNull();
  });
});
