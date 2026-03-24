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
} from "../runtime/packaging/qa-measure.js";

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
      outputPath,
      createdAt: "2026-03-24T00:00:00.000Z",
    });

    const ffprobeCalls = execFileMock.mock.calls.filter(([cmd]) => cmd === "ffprobe");
    expect(ffprobeCalls).toHaveLength(2);
    expect(ffprobeCalls[0][1]).toEqual([
      "-v", "error",
      "-select_streams", "v:0",
      "-show_entries", "stream=duration:format=duration",
      "-of", "json",
      path.resolve(videoPath),
    ]);
    expect(ffprobeCalls[1][1]).toEqual([
      "-v", "error",
      "-select_streams", "a:0",
      "-show_entries", "stream=duration:format=duration",
      "-of", "json",
      path.resolve(audioPath),
    ]);

    expect(result.video_duration_ms).toBe(12345);
    expect(result.audio_duration_ms).toBe(12300);
    expect(result.av_drift_ms).toBe(45);
    expect(result.loudness_integrated).toBe(-16.2);
    expect(result.loudness_true_peak).toBe(-1.1);
    expect(result.dialogue_occupancy).toBeCloseTo(11300 / 12300, 6);

    const persisted = JSON.parse(fs.readFileSync(outputPath, "utf-8")) as {
      video_duration_ms: number;
      audio_duration_ms: number;
      av_drift_ms: number;
      loudness_integrated: number;
    };
    expect(persisted.video_duration_ms).toBe(12345);
    expect(persisted.audio_duration_ms).toBe(12300);
    expect(persisted.av_drift_ms).toBe(45);
    expect(persisted.loudness_integrated).toBe(-16.2);
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
});
