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
  buildAspectRatioFitFilter,
  buildFinalMuxArgs,
  readTimelineDurationSeconds,
  runRenderPipeline,
} from "../runtime/render/pipeline.js";

describe("render pipeline aspect ratio fitting", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vos-render-pipeline-"));
    execFileMock.mockReset();
    execFileMock.mockImplementation((
      _cmd: string,
      args: string[],
      _opts: unknown,
      cb: (err: Error | null, stdout?: string, stderr?: string) => void,
    ) => {
      const outputPath = args[args.length - 1];
      if (typeof outputPath === "string" && !outputPath.startsWith("-")) {
        fs.mkdirSync(path.dirname(outputPath), { recursive: true });
        fs.writeFileSync(outputPath, "stub", "utf-8");
      }
      cb(null, "", "");
    });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("buildAspectRatioFitFilter delegates to the shared filtergraph builder", () => {
    // FATAL-1 fix (Phase 5 review R1): preview and final must serialize the
    // video filter chain through the same shared builder. The legacy bespoke
    // string `scale=...,pad=...:black` has been replaced with the shared
    // builder's no-transform output, which uses ffmpeg's default pad colour
    // (black) and appends format/setsar to keep concat streams uniform.
    expect(buildAspectRatioFitFilter(1920, 1080)).toBe(
      "scale=1920:1080:force_original_aspect_ratio=decrease," +
        "pad=1920:1080:(ow-iw)/2:(oh-ih)/2,format=yuv420p,setsar=1",
    );
  });

  it("pins final mux to timeline duration, frame count, and 48 kHz delivery audio", () => {
    expect(buildFinalMuxArgs("video.mp4", "audio.wav", "final.mp4", 91.333333, 2192)).toEqual([
      "-y",
      "-i", "video.mp4",
      "-i", "audio.wav",
      "-t", "91.333333",
      "-frames:v", "2192",
      "-c:v", "copy",
      "-c:a", "aac",
      "-b:a", "192k",
      "-ar", "48000",
      "final.mp4",
    ]);
  });

  it("uses shortest-stream fallback when timeline duration is unavailable", () => {
    expect(buildFinalMuxArgs("video.mp4", "audio.wav", "final.mp4")).toContain("-shortest");
  });

  it("derives sequence duration from the latest clip out point", () => {
    const timelinePath = path.join(tmpDir, "timeline-duration.json");
    fs.writeFileSync(timelinePath, JSON.stringify({
      sequence: { fps_num: 24, fps_den: 1 },
      tracks: {
        video: [{ clips: [{ timeline_in_frame: 0, timeline_duration_frames: 120 }] }],
        audio: [{ clips: [{ timeline_in_frame: 120, timeline_duration_frames: 72 }] }],
      },
    }));

    expect(readTimelineDurationSeconds(timelinePath)).toBe(8);
  });

  it("runRenderPipeline fits raw video to timeline dimensions before final mux", async () => {
    const timelinePath = path.join(tmpDir, "05_timeline", "timeline.json");
    const assemblyPath = path.join(tmpDir, "05_timeline", "assembly.mp4");
    const outputDir = path.join(tmpDir, "07_package");

    fs.mkdirSync(path.dirname(timelinePath), { recursive: true });
    fs.writeFileSync(
      timelinePath,
      JSON.stringify({
        sequence: {
          fps_num: 30,
          fps_den: 1,
          width: 1920,
          height: 1080,
          output_aspect_ratio: "16:9",
        },
      }, null, 2),
      "utf-8",
    );
    fs.writeFileSync(assemblyPath, "stub-assembly", "utf-8");

    const result = await runRenderPipeline({
      projectDir: tmpDir,
      timelinePath,
      assemblyPath,
      captionPolicy: {
        language: "ja",
        delivery_mode: "sidecar",
        source: "none",
        styling_class: "clean-lower-third",
      },
      outputDir,
      fps: 30,
    });

    const ffmpegCalls = execFileMock.mock.calls.map((call) => call[1] as string[]);
    const fitCall = ffmpegCalls.find((args) =>
      args.includes("-vf") && args.includes(buildAspectRatioFitFilter(1920, 1080))
    );

    expect(fitCall).toBeDefined();
    expect(result.rawVideoPath).toBe(path.join(outputDir, "video", "raw_video.mp4"));
    expect(fs.existsSync(result.rawVideoPath)).toBe(true);
    expect(fs.existsSync(result.finalVideoPath)).toBe(true);
  });
});
