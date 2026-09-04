import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { compositeRemotionAlphaLayers } from "../runtime/render/remotion/render-remotion.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function alphaLayer(target: string, color: string, x: number): void {
  execFileSync("ffmpeg", [
    "-v", "error",
    "-y",
    "-f", "lavfi",
    "-i", "color=c=black@0.0:s=96x160:r=6:d=1",
    "-vf", `format=rgba,drawbox=x=${x}:y=40:w=64:h=64:color=${color}@0.75:t=fill`,
    "-frames:v", "6",
    "-c:v", "libvpx-vp9",
    "-pix_fmt", "yuva420p",
    "-auto-alt-ref", "0",
    "-metadata:s:v:0", "alpha_mode=1",
    target,
  ]);
}

function decodedFrameHash(target: string): string {
  const frames = execFileSync("ffmpeg", [
    "-v", "error",
    "-c:v", "libvpx-vp9",
    "-i", target,
    "-f", "rawvideo",
    "-pix_fmt", "rgba",
    "-",
  ], { maxBuffer: 20 * 1024 * 1024 });
  return createHash("sha256").update(frames).digest("hex");
}

describe("Remotion incremental alpha compositor", () => {
  it("is cold/warm pixel-equivalent and deterministic while z-order remains observable", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vos-remotion-alpha-vertical-"));
    tempDirs.push(dir);
    const first = path.join(dir, "first.webm");
    const second = path.join(dir, "second.webm");
    alphaLayer(first, "red", 0);
    alphaLayer(second, "blue", 24);
    const elements = [
      { elementId: "FIRST", path: first, fingerprint: "a".repeat(64) },
      { elementId: "SECOND", path: second, fingerprint: "b".repeat(64) },
    ];
    const render = (outputPath: string, order = elements) => compositeRemotionAlphaLayers({
      elements: order,
      outputPath,
      width: 96,
      height: 160,
      fpsNum: 6,
      fpsDen: 1,
      durationFrames: 6,
    });
    const cold = path.join(dir, "cold.webm");
    const warm = path.join(dir, "warm.webm");
    const reversed = path.join(dir, "reversed.webm");
    await render(cold);
    await render(warm);
    await render(reversed, [...elements].reverse());

    expect(decodedFrameHash(warm)).toBe(decodedFrameHash(cold));
    expect(decodedFrameHash(reversed)).not.toBe(decodedFrameHash(cold));
  });
});
