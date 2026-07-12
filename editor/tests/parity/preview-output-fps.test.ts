import { describe, expect, it } from "vitest";
import {
  previewOutputFrameRateArgs,
  previewTimelineDurationFrames,
} from "../../server/services/preview-job-service.js";

describe("Studio exact-preview output frame rate", () => {
  it("pins integer sequence rates as CFR", () => {
    expect(previewOutputFrameRateArgs(24)).toEqual([
      "-r", "24", "-fps_mode", "cfr",
    ]);
  });

  it("preserves fractional sequence rates with stable precision", () => {
    expect(previewOutputFrameRateArgs(30_000 / 1_001)).toEqual([
      "-r", "29.970030", "-fps_mode", "cfr",
    ]);
  });

  it("derives the output frame count from the latest timeline out point", () => {
    expect(previewTimelineDurationFrames([
      { timelineInFrame: 0, durationFrames: 120 },
      { timelineInFrame: 120, durationFrames: 72 },
    ] as never)).toBe(192);
  });
});
