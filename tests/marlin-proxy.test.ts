import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  createMarlinRangeProxy,
  MARLIN_PROXY_CACHE_DIRNAME,
  marlinRangeCacheKey,
  marlinProxyCacheKey,
  marlinProxyMaxWidth,
  prepareMarlinProxy,
  probeVideoDurationSeconds,
} from "../runtime/pipeline/stages/marlin-proxy.js";

function ffmpegAvailable(): boolean {
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const fxit = ffmpegAvailable() ? it : it.skip;

let workdir: string;

beforeEach(() => {
  workdir = fs.mkdtempSync(path.join(os.tmpdir(), "marlin-proxy-"));
  delete process.env.VOS_MARLIN_PROXY_DISABLE;
  delete process.env.VOS_MARLIN_PROXY_MAX_WIDTH;
});

afterEach(() => {
  fs.rmSync(workdir, { recursive: true, force: true });
  delete process.env.VOS_MARLIN_PROXY_DISABLE;
  delete process.env.VOS_MARLIN_PROXY_MAX_WIDTH;
});

function makeVideo(name: string, width: number, height: number, seconds = 1): string {
  const out = path.join(workdir, name);
  execFileSync("ffmpeg", [
    "-y", "-f", "lavfi",
    "-i", `testsrc2=d=${seconds}:s=${width}x${height}:r=10`,
    "-pix_fmt", "yuv420p",
    out,
  ], { stdio: "ignore" });
  return out;
}

describe("marlin proxy config", () => {
  it("defaults to 640 and honors the env override", () => {
    expect(marlinProxyMaxWidth()).toBe(640);
    process.env.VOS_MARLIN_PROXY_MAX_WIDTH = "480";
    expect(marlinProxyMaxWidth()).toBe(480);
    process.env.VOS_MARLIN_PROXY_MAX_WIDTH = "bogus";
    expect(marlinProxyMaxWidth()).toBe(640);
  });

  it("derives a stable cache key from source identity", () => {
    const a = marlinProxyCacheKey("/x/a.mov", 100, 1000);
    expect(marlinProxyCacheKey("/x/a.mov", 100, 1000)).toBe(a);
    expect(marlinProxyCacheKey("/x/a.mov", 101, 1000)).not.toBe(a);
    expect(marlinProxyCacheKey("/x/a.mov", 100, 2000)).not.toBe(a);
    expect(marlinProxyCacheKey("/x/b.mov", 100, 1000)).not.toBe(a);
  });

  it("derives a stable range cache key from source identity and range", () => {
    const a = marlinRangeCacheKey("/x/a.mov", 100, 1000, 10, 40);
    expect(marlinRangeCacheKey("/x/a.mov", 100, 1000, 10, 40)).toBe(a);
    expect(marlinRangeCacheKey("/x/a.mov", 100, 1000, 11, 40)).not.toBe(a);
    expect(marlinRangeCacheKey("/x/a.mov", 100, 1000, 10, 41)).not.toBe(a);
  });
});

describe("prepareMarlinProxy", () => {
  fxit("passes small sources through unchanged", async () => {
    const src = makeVideo("small.mp4", 320, 180);
    const result = await prepareMarlinProxy(workdir, src);
    expect(result.proxied).toBe(false);
    expect(result.evaluationPath).toBe(src);
  });

  fxit("downscales large sources into the cache and reuses the proxy", async () => {
    const src = makeVideo("large.mp4", 1280, 720);
    const first = await prepareMarlinProxy(workdir, src);
    expect(first.proxied).toBe(true);
    expect(first.evaluationPath).toContain(MARLIN_PROXY_CACHE_DIRNAME);
    expect(fs.existsSync(first.evaluationPath)).toBe(true);

    // Proxy is downscaled to the max width and keeps the duration.
    const probe = execFileSync("ffprobe", [
      "-v", "error",
      "-select_streams", "v:0",
      "-show_entries", "stream=width",
      "-show_entries", "format=duration",
      "-of", "csv=p=0",
      first.evaluationPath,
    ]).toString();
    expect(probe).toContain("640");
    const duration = Number(probe.trim().split("\n").pop());
    expect(Math.abs(duration - 1)).toBeLessThan(0.2);

    // Second call hits the cache (same path, same mtime).
    const mtimeBefore = fs.statSync(first.evaluationPath).mtimeMs;
    const second = await prepareMarlinProxy(workdir, src);
    expect(second.evaluationPath).toBe(first.evaluationPath);
    expect(fs.statSync(second.evaluationPath).mtimeMs).toBe(mtimeBefore);
  }, 30_000);

  fxit("creates and reuses range proxies for long-source chunks", async () => {
    const src = makeVideo("range-source.mp4", 320, 180, 4);
    const first = await createMarlinRangeProxy(workdir, src, 1, 3);
    expect(first.rangePath).toContain(path.join(MARLIN_PROXY_CACHE_DIRNAME, "ranges"));
    expect(fs.existsSync(first.rangePath)).toBe(true);

    const duration = await probeVideoDurationSeconds(first.rangePath);
    expect(duration).not.toBeNull();
    expect(Math.abs((duration ?? 0) - 2)).toBeLessThan(0.4);

    const mtimeBefore = fs.statSync(first.rangePath).mtimeMs;
    const second = await createMarlinRangeProxy(workdir, src, 1, 3);
    expect(second.rangePath).toBe(first.rangePath);
    expect(fs.statSync(second.rangePath).mtimeMs).toBe(mtimeBefore);
  }, 30_000);

  fxit("respects the disable flag", async () => {
    const src = makeVideo("large2.mp4", 1280, 720);
    process.env.VOS_MARLIN_PROXY_DISABLE = "1";
    const result = await prepareMarlinProxy(workdir, src);
    expect(result.proxied).toBe(false);
    expect(result.evaluationPath).toBe(src);
  });

  it("degrades to the original path when the source is unreadable", async () => {
    const missing = path.join(workdir, "nope.mov");
    const result = await prepareMarlinProxy(workdir, missing);
    expect(result.proxied).toBe(false);
    expect(result.evaluationPath).toBe(missing);
  });
});
