import { describe, expect, it } from "vitest";
import {
  boundaryErrorFrames,
  equivalentFrameRates,
  frameRateRatio,
  frameRateValue,
  framesToMicroseconds,
  framesToMilliseconds,
  framesToSeconds,
  microsecondsToFrames,
  rationalFrameRate,
  secondsToFrames,
} from "../editor/shared/rational-timebase.js";
import { previewOutputFrameRateArgs } from "../editor/server/services/preview-job-service.js";
import { checkAvDrift, checkResolutionSpec } from "../runtime/packaging/qa.js";
import { buildFinalMuxArgs, generateSrt } from "../runtime/render/pipeline.js";
import { preserveRemotionFfmpegFrameRate } from "../runtime/render/remotion/render-remotion.js";

describe("rational timeline timebase", () => {
  it.each([
    [24, 1],
    [25, 1],
    [24_000, 1_001],
    [30_000, 1_001],
  ])("round-trips frame boundaries at %i/%i", (fpsNum, fpsDen) => {
    const rate = rationalFrameRate(fpsNum, fpsDen);
    const frame = 43_219;
    const microseconds = framesToMicroseconds(frame, rate);

    expect(microsecondsToFrames(microseconds, rate)).toBe(frame);
    expect(secondsToFrames(framesToSeconds(frame, rate), rate)).toBe(frame);
    expect(frameRateValue(rate)).toBe(fpsNum / fpsDen);
    expect(frameRateRatio(rate)).toBe(`${fpsNum}/${fpsDen}`);
  });

  it("keeps final video, audio, and subtitle boundaries within half a frame at 30 minutes", () => {
    const rate = rationalFrameRate(30_000, 1_001);
    const finalFrame = secondsToFrames(30 * 60, rate);
    const exactSeconds = framesToSeconds(finalFrame, rate);
    const audioSample = Math.round(exactSeconds * 48_000);
    const subtitleMilliseconds = framesToMilliseconds(finalFrame, rate);

    expect(finalFrame).toBe(53_946);
    expect(boundaryErrorFrames(30 * 60, finalFrame, rate)).toBeLessThanOrEqual(0.5);
    expect(boundaryErrorFrames(audioSample / 48_000, finalFrame, rate)).toBeLessThanOrEqual(0.5);
    expect(boundaryErrorFrames(subtitleMilliseconds / 1_000, finalFrame, rate)).toBeLessThanOrEqual(0.5);
    expect(buildFinalMuxArgs(
      "video.mp4",
      "audio.wav",
      "final.mp4",
      exactSeconds,
      finalFrame,
    )).toEqual(expect.arrayContaining([
      "-t", "1799.998200",
      "-frames:v", "53946",
    ]));
    expect(generateSrt([{
      timeline_in_frame: finalFrame - 1,
      timeline_duration_frames: 1,
      text: "end",
    }], rate)).toContain("00:29:59,965 --> 00:29:59,998");
  });

  it("serializes the declared ratio for Studio preview and Remotion FFmpeg", () => {
    const rate = rationalFrameRate(30_000, 1_001);
    expect(previewOutputFrameRateArgs(rate)).toEqual([
      "-r", "30000/1001", "-fps_mode", "cfr",
    ]);
    expect(preserveRemotionFfmpegFrameRate([
      "-framerate", "29.97002997002997",
      "-i", "frames/%06d.png",
      "-r", "29.97002997002997",
      "out.mp4",
    ], rate)).toEqual([
      "-framerate", "30000/1001",
      "-i", "frames/%06d.png",
      "-r", "30000/1001",
      "out.mp4",
    ]);
  });

  it("QA compares rational identity and enforces the half-frame drift budget", () => {
    const expected = {
      source: "timeline" as const,
      fps_num: 30_000,
      fps_den: 1_001,
      fps: 30_000 / 1_001,
    };
    const actual = {
      width: 1_920,
      height: 1_080,
      sar: "1:1",
      dar: "16:9",
      fps_num: 60_000,
      fps_den: 2_002,
      fps: 30_000 / 1_001,
    };

    expect(equivalentFrameRates(
      { fpsNum: 30_000, fpsDen: 1_001 },
      { fpsNum: 60_000, fpsDen: 2_002 },
    )).toBe(true);
    expect(checkResolutionSpec(actual, expected).passed).toBe(true);
    expect(checkResolutionSpec({
      ...actual,
      fps_num: 30,
      fps_den: 1,
      fps: 30,
    }, expected).metrics.resolution_mismatches).toEqual([
      "fps expected=30000/1001 actual=30/1",
    ]);

    const frameDurationMs = 1_000 * 1_001 / 30_000;
    expect(checkAvDrift(0, frameDurationMs / 2, frameDurationMs).passed).toBe(true);
    expect(checkAvDrift(0, frameDurationMs / 2 + 0.001, frameDurationMs).passed).toBe(false);
  });
});
