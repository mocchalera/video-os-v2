import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const { execFileMock } = vi.hoisted(() => ({
  execFileMock: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  execFile: execFileMock,
}));

import {
  collectQaMeasurementWarnings,
  measureQaMedia,
  parseNonSilentIntervals,
} from "../runtime/packaging/qa-measure.js";

describe("dialogue signal placement measurement", () => {
  it("inverts silencedetect output into timeline signal intervals", () => {
    expect(parseNonSilentIntervals([
      "[silencedetect] silence_start: 0",
      "[silencedetect] silence_end: 3.33 | silence_duration: 3.33",
      "[silencedetect] silence_start: 7.5",
    ].join("\n"), 10_000)).toEqual([
      { start_ms: 3330, end_ms: 7500 },
    ]);
  });
});

describe("qa measurement", () => {
  let tmpDir: string;
  let videoPath: string;
  let audioPath: string;
  let outputPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vos-qa-measure-"));
    videoPath = path.join(tmpDir, "assembly.mp4");
    audioPath = path.join(tmpDir, "final_mix.wav");
    outputPath = path.join(tmpDir, "07_package", "qa-measurements.json");

    fs.writeFileSync(videoPath, "stub-video", "utf-8");
    fs.writeFileSync(audioPath, "stub-audio", "utf-8");

    execFileMock.mockReset();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("invokes ffprobe with explicit stream selectors and persists measurements", async () => {
    execFileMock.mockImplementation((
      cmd: string,
      args: string[],
      _opts: unknown,
      cb: (err: Error | null, stdout?: string, stderr?: string) => void,
    ) => {
      if (cmd === "ffprobe" && args.includes("stream=width,height,sample_aspect_ratio,display_aspect_ratio,avg_frame_rate,r_frame_rate")) {
        cb(null, JSON.stringify({
          streams: [{
            width: 1920,
            height: 1080,
            sample_aspect_ratio: "1:1",
            display_aspect_ratio: "16:9",
            avg_frame_rate: "24/1",
            r_frame_rate: "24/1",
          }],
        }), "");
        return;
      }

      if (cmd === "ffprobe" && args.includes("v:0")) {
        cb(null, JSON.stringify({
          streams: [{ duration: "12.345" }],
          format: { duration: "12.345" },
        }), "");
        return;
      }

      if (cmd === "ffprobe" && args.includes("a:0")) {
        cb(null, JSON.stringify({
          streams: [{ duration: "12.300" }],
          format: { duration: "12.300" },
        }), "");
        return;
      }

      if (cmd === "ffmpeg" && args.includes("-filter_complex")) {
        cb(null, "", [
          "  Integrated loudness:",
          "    I:         -16.2 LUFS",
          "  True peak:",
          "    Peak:      -1.1 dBFS",
        ].join("\n"));
        return;
      }

      if (cmd === "ffmpeg" && args.includes("-af")) {
        cb(null, "", [
          "[silencedetect @ 0x0] silence_start: 1.0",
          "[silencedetect @ 0x0] silence_end: 2.0 | silence_duration: 1.0",
        ].join("\n"));
        return;
      }

      cb(new Error(`Unexpected command: ${cmd} ${args.join(" ")}`));
    });

    const result = await measureQaMedia({
      videoPath,
      audioPath,
      expectedDialogueWindowsMs: [{ start_ms: 2000, end_ms: 12300 }],
      outputPath,
      createdAt: "2026-03-24T00:00:00.000Z",
    });

    const ffprobeCalls = execFileMock.mock.calls.filter(([cmd]) => cmd === "ffprobe");
    const durationProbeCalls = ffprobeCalls.filter(([, args]) =>
      (args as string[]).includes("stream=duration:format=duration")
    );
    const frameProbeCalls = ffprobeCalls.filter(([, args]) =>
      (args as string[]).includes("stream=width,height,sample_aspect_ratio,display_aspect_ratio,avg_frame_rate,r_frame_rate")
    );
    expect(durationProbeCalls).toHaveLength(2);
    expect(frameProbeCalls).toHaveLength(1);
    expect(durationProbeCalls[0][1]).toEqual([
      "-v", "error",
      "-select_streams", "v:0",
      "-show_entries", "stream=duration:format=duration",
      "-of", "json",
      path.resolve(videoPath),
    ]);
    expect(durationProbeCalls[1][1]).toEqual([
      "-v", "error",
      "-select_streams", "a:0",
      "-show_entries", "stream=duration:format=duration",
      "-of", "json",
      path.resolve(audioPath),
    ]);

    expect(result.video_duration_ms).toBe(12345);
    expect(result.audio_duration_ms).toBe(12300);
    expect(result.av_duration_delta_ms).toBe(45);
    expect(result.av_drift_ms).toBe(45);
    expect(result.loudness_integrated).toBe(-16.2);
    expect(result.loudness_true_peak).toBe(-1.1);
    expect(result.dialogue_occupancy).toBe(1);
    expect(result.dialogue_outside_expected_ms).toBe(1000);
    expect(result.dialogue_first_signal_ms).toBe(0);
    expect(result.expected_dialogue_start_ms).toBe(2000);
    expect(result.video_frame).toEqual({
      width: 1920,
      height: 1080,
      sar: "1:1",
      dar: "16:9",
      fps_num: 24,
      fps_den: 1,
      fps: 24,
    });

    const persisted = JSON.parse(fs.readFileSync(outputPath, "utf-8")) as {
      video_duration_ms: number;
      audio_duration_ms: number;
      av_duration_delta_ms: number;
      av_drift_ms: number;
      loudness_integrated: number;
      video_frame: {
        width: number;
        height: number;
        dar: string | null;
      };
    };
    expect(persisted.video_duration_ms).toBe(12345);
    expect(persisted.audio_duration_ms).toBe(12300);
    expect(persisted.av_duration_delta_ms).toBe(45);
    expect(persisted.av_drift_ms).toBe(45);
    expect(persisted.loudness_integrated).toBe(-16.2);
    expect(persisted.video_frame.width).toBe(1920);
    expect(persisted.video_frame.height).toBe(1080);
    expect(persisted.video_frame.dar).toBe("16:9");
  });

  it("emits an A/V drift warning at 100ms or more", () => {
    const warnings = collectQaMeasurementWarnings({
      av_drift_ms: 100,
      loudness_integrated: -16.0,
    });

    expect(warnings).toEqual([
      expect.objectContaining({
        code: "AV_DRIFT_WARNING",
      }),
    ]);
  });

  it("emits a loudness warning at -23 LUFS or lower", () => {
    const warnings = collectQaMeasurementWarnings({
      av_drift_ms: 12,
      loudness_integrated: -23.1,
    });

    expect(warnings).toEqual([
      expect.objectContaining({
        code: "LOW_LOUDNESS_WARNING",
      }),
    ]);
  });

  // ── C-03 edge case: ebur128 stderr parse failure returns fallback ──

  it("returns fallback loudness when ffmpeg ebur128 output is unparseable", async () => {
    execFileMock.mockImplementation((
      cmd: string,
      args: string[],
      _opts: unknown,
      cb: (err: Error | null, stdout?: string, stderr?: string) => void,
    ) => {
      if (cmd === "ffprobe") {
        cb(null, JSON.stringify({
          streams: [{ duration: "10.0" }],
          format: { duration: "10.0" },
        }), "");
        return;
      }

      if (cmd === "ffmpeg" && args.includes("-filter_complex")) {
        // Simulate unparseable ebur128 output (no I: or Peak: lines)
        cb(null, "", "some random ffmpeg output without ebur128 summary");
        return;
      }

      if (cmd === "ffmpeg" && args.includes("-af")) {
        cb(null, "", "");
        return;
      }

      cb(new Error(`Unexpected command: ${cmd} ${args.join(" ")}`));
    });

    const result = await measureQaMedia({
      videoPath,
      audioPath,
      outputPath,
      createdAt: "2026-03-24T00:00:00.000Z",
    });

    // Should use fallback values instead of throwing
    expect(result.loudness_integrated).toBe(-24);
    expect(result.loudness_true_peak).toBe(-1);
  });

  it("returns fallback loudness when ffmpeg exits with error and no stderr", async () => {
    execFileMock.mockImplementation((
      cmd: string,
      args: string[],
      _opts: unknown,
      cb: (err: Error | null, stdout?: string, stderr?: string) => void,
    ) => {
      if (cmd === "ffprobe") {
        cb(null, JSON.stringify({
          streams: [{ duration: "5.0" }],
          format: { duration: "5.0" },
        }), "");
        return;
      }

      if (cmd === "ffmpeg" && args.includes("-filter_complex")) {
        // Simulate complete failure with no output
        cb(new Error("ffmpeg crashed"), "", "");
        return;
      }

      if (cmd === "ffmpeg" && args.includes("-af")) {
        cb(null, "", "");
        return;
      }

      cb(new Error(`Unexpected command: ${cmd} ${args.join(" ")}`));
    });

    const result = await measureQaMedia({
      videoPath,
      audioPath,
      outputPath,
      createdAt: "2026-03-24T00:00:00.000Z",
    });

    // Should use fallback values
    expect(result.loudness_integrated).toBe(-24);
    expect(result.loudness_true_peak).toBe(-1);
  });
});
