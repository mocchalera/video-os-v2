import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const ffmpegAvailable = spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).status === 0;
const ffprobeAvailable = spawnSync("ffprobe", ["-version"], { stdio: "ignore" }).status === 0;
const describeIf = ffmpegAvailable && ffprobeAvailable ? describe : describe.skip;
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describeIf("rational FFmpeg timebase smoke", () => {
  it("ffprobe observes 30000/1001 and the requested final frame count", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "vos-rational-ffprobe-"));
    tempDirs.push(tempDir);
    const outputPath = path.join(tempDir, "rational.mp4");

    execFileSync("ffmpeg", [
      "-v", "error",
      "-f", "lavfi",
      "-i", "color=c=black:s=64x64:r=30000/1001",
      "-frames:v", "120",
      "-r", "30000/1001",
      "-fps_mode", "cfr",
      "-c:v", "libx264",
      "-pix_fmt", "yuv420p",
      outputPath,
    ]);

    const probe = JSON.parse(execFileSync("ffprobe", [
      "-v", "error",
      "-select_streams", "v:0",
      "-show_entries", "stream=r_frame_rate,avg_frame_rate,time_base,nb_frames",
      "-of", "json",
      outputPath,
    ], { encoding: "utf8" })) as {
      streams?: Array<{
        r_frame_rate?: string;
        avg_frame_rate?: string;
        time_base?: string;
        nb_frames?: string;
      }>;
    };

    expect(probe.streams?.[0]).toMatchObject({
      r_frame_rate: "30000/1001",
      avg_frame_rate: "30000/1001",
      time_base: "1/30000",
      nb_frames: "120",
    });
  });
});
