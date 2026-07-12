import { describe, expect, it } from "vitest";
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

  it("contains the five renderable presets with render functions", () => {
    expect(transitionPresets.size).toBe(5);

    for (const [transitionType] of EXPECTED_PRESETS) {
      const preset = resolveTransitionPreset(transitionType);
      expect(typeof preset?.render).toBe("function");
    }
  });
});
