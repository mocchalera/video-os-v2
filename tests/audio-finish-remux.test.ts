import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  buildVideoPreservingRemuxArgs,
  finishAndRemuxVideo,
} from "../runtime/audio/finish-remux.js";
import { DEFAULT_LOUDNESS_ONLY_FINISH } from "../runtime/audio/dialogue-finishing.js";
import { computeVideoStreamHash } from "../runtime/media/video-stream-hash.js";
import { parseAudioFinishRemuxArgs } from "../scripts/audio-finish-remux.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const directory of tempDirs.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("audio finish remux", () => {
  it("builds a video-copy/audio-only remux command", () => {
    const args = buildVideoPreservingRemuxArgs(
      "/tmp/source.mp4",
      "/tmp/mastered.wav",
      "/tmp/final.mp4",
    );
    expect(args).toContain("-map");
    expect(args).toContain("0:v:0");
    expect(args).toContain("1:a:0");
    expect(args.slice(args.indexOf("-c:v"), args.indexOf("-c:v") + 2))
      .toEqual(["-c:v", "copy"]);
    expect(args.slice(args.indexOf("-c:a"), args.indexOf("-c:a") + 2))
      .toEqual(["-c:a", "aac"]);
  });

  it("preserves the exact video stream and reuses a verified result", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "audio-finish-remux-"));
    tempDirs.push(directory);
    const source = path.join(directory, "source.mp4");
    execFileSync("ffmpeg", [
      "-v", "error", "-y",
      "-f", "lavfi", "-i", "color=c=blue:s=320x180:r=24:d=2",
      "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:d=2",
      "-c:v", "libx264", "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-shortest", source,
    ]);

    const first = await finishAndRemuxVideo({
      sourceVideoPath: source,
      outputRoot: path.join(directory, "outputs"),
      policy: DEFAULT_LOUDNESS_ONLY_FINISH,
      createdAt: "2026-07-24T00:00:00Z",
    });
    const second = await finishAndRemuxVideo({
      sourceVideoPath: source,
      outputRoot: path.join(directory, "outputs"),
      policy: DEFAULT_LOUDNESS_ONLY_FINISH,
      createdAt: "2026-07-24T00:00:01Z",
    });

    expect(first.reused).toBe(false);
    expect(second.reused).toBe(true);
    expect(computeVideoStreamHash(first.outputPath)).toBe(computeVideoStreamHash(source));
    expect(first.receipt.verification.video_stream_preserved).toBe(true);
  }, 30_000);

  it("requires an explicit proven caption generation", () => {
    expect(() => parseAudioFinishRemuxArgs([
      "node", "audio-finish-remux",
      "--project", "/tmp/project",
    ])).toThrow("--source-receipt is required");
    expect(parseAudioFinishRemuxArgs([
      "node", "audio-finish-remux",
      "--project", "/tmp/project",
      "--source-receipt", "/tmp/receipt.json",
      "--finalize",
    ])).toMatchObject({
      projectDir: "/tmp/project",
      sourceReceiptPath: "/tmp/receipt.json",
      finalize: true,
    });
  });
});
