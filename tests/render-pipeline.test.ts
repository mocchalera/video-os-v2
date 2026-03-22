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

  it("buildAspectRatioFitFilter generates scale+pad filter", () => {
    expect(buildAspectRatioFitFilter(1920, 1080)).toBe(
      "scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:black",
    );
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
