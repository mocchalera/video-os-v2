import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  assembleTimelineToMp4,
  buildAudioAssemblyPlan,
  buildVideoAssemblyPlan,
  type ExecFileLike,
  formatFfmpegTimestamp,
  readTimeline,
} from "../runtime/render/assembler.js";
import { buildAspectRatioFitFilter } from "../runtime/render/pipeline.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0, tempDirs.length)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function createTempDemoProject(): string {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vos-assembler-test-"));
  tempDirs.push(tmpDir);

  for (const relPath of [
    "03_analysis/assets.json",
    "05_timeline/timeline.json",
    "05_timeline/preview-manifest.json",
  ]) {
    const src = path.resolve("projects/demo", relPath);
    const dest = path.join(tmpDir, relPath);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
  }

  const assets = JSON.parse(
    fs.readFileSync(path.join(tmpDir, "03_analysis/assets.json"), "utf-8"),
  ) as { items: Array<{ filename: string }> };
  const sourcesDir = path.join(tmpDir, "00_sources");
  fs.mkdirSync(sourcesDir, { recursive: true });
  for (const asset of assets.items) {
    fs.writeFileSync(path.join(sourcesDir, asset.filename), "stub-media", "utf-8");
  }

  return tmpDir;
}

function createExecMock(calls: Array<{ cmd: string; args: string[] }>): ExecFileLike {
  return (
    cmd,
    args,
    _opts,
    cb,
  ) => {
    calls.push({ cmd, args: [...args] });
    const outputPath = args[args.length - 1];
    if (typeof outputPath === "string" && !outputPath.startsWith("-")) {
      fs.mkdirSync(path.dirname(outputPath), { recursive: true });
      fs.writeFileSync(outputPath, "stub-output", "utf-8");
    }
    cb(null, "", "");
  };
}

describe("ffmpeg assembler", () => {
  it("builds deterministic video/audio plans from projects/demo timeline", () => {
    const timeline = readTimeline(path.resolve("projects/demo/05_timeline/timeline.json"));

    const videoPlans = buildVideoAssemblyPlan(timeline);
    const audioPlans = buildAudioAssemblyPlan(timeline);

    expect(videoPlans[0]).toMatchObject({
      kind: "clip",
      track_id: "V1",
      clip_id: "CLP_0001",
      asset_id: "AST_005",
      start_frame: 0,
      end_frame: 92,
      source_in_sec: 1.4,
      source_out_sec: 5.808333333333334,
    });
    expect(videoPlans.some((plan) => plan.kind === "gap")).toBe(true);

    expect(audioPlans).toHaveLength(4);
    expect(audioPlans[0]).toMatchObject({
      track_id: "A1",
      clip_id: "CLP_0005",
      asset_id: "AST_001",
      source_in_sec: 6.4,
      source_out_sec: 11,
      delay_ms: 4000,
    });
  });

  it("generates trim, concat, and audio mix ffmpeg arguments", async () => {
    const projectDir = createTempDemoProject();
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const timeline = readTimeline(path.join(projectDir, "05_timeline", "timeline.json"));
    const firstVideoPlan = buildVideoAssemblyPlan(timeline)[0];
    const firstAudioPlan = buildAudioAssemblyPlan(timeline)[0];

    const result = await assembleTimelineToMp4({
      projectDir,
      cleanupTemp: false,
      workingDirRoot: projectDir,
      execFileImpl: createExecMock(calls),
    });

    const trimCall = calls.find((call) =>
      call.args.includes("-vf") &&
      call.args.includes(buildAspectRatioFitFilter(1920, 1080)) &&
      call.args.some((arg) => arg.endsWith("video-segment-0001.mp4"))
    );
    expect(trimCall).toBeDefined();
    expect(trimCall!.args).toContain("-ss");
    expect(trimCall!.args).toContain(formatFfmpegTimestamp(firstVideoPlan.source_in_sec!));
    expect(trimCall!.args).toContain("-to");
    expect(trimCall!.args).toContain(formatFfmpegTimestamp(firstVideoPlan.source_out_sec!));

    const audioTrimCall = calls.find((call) =>
      call.args.includes("-vn") &&
      call.args.some((arg) => arg.endsWith("audio-segment-0001.wav"))
    );
    expect(audioTrimCall).toBeDefined();
    expect(audioTrimCall!.args).toContain(formatFfmpegTimestamp(firstAudioPlan.source_in_sec));
    expect(audioTrimCall!.args).toContain(formatFfmpegTimestamp(firstAudioPlan.source_out_sec));

    const concatList = fs.readFileSync(
      path.join(result.workingDir, "video.concat.txt"),
      "utf-8",
    ).trim().split("\n");
    expect(concatList[0]).toContain("video-segment-0001.mp4");
    expect(concatList[1]).toContain("video-segment-0002.mp4");

    const audioMixCall = calls.find((call) =>
      call.args.includes("-filter_complex") &&
      call.args.some((arg) => arg.endsWith("assembly.audio.m4a"))
    );
    expect(audioMixCall).toBeDefined();
    const filter = audioMixCall!.args[audioMixCall!.args.indexOf("-filter_complex") + 1];
    expect(filter).toContain("adelay=4000|4000");
    expect(filter).toContain("amix=inputs=5:duration=longest:dropout_transition=0[aout]");

    expect(result.outputPath).toBe(path.join(projectDir, "05_timeline", "assembly.mp4"));
    expect(fs.existsSync(result.outputPath)).toBe(true);
  });

  it("throws a clear error when ffmpeg is not available", async () => {
    const projectDir = createTempDemoProject();
    const execMissing: ExecFileLike = (_cmd, _args, _opts, cb) => {
      const err = new Error("spawn ffmpeg ENOENT") as NodeJS.ErrnoException;
      err.code = "ENOENT";
      cb(err);
    };

    await expect(
      assembleTimelineToMp4({
        projectDir,
        execFileImpl: execMissing,
      }),
    ).rejects.toThrow("ffmpeg is not installed or not available on PATH");
  });
});
