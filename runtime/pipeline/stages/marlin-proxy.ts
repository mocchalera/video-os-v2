/**
 * Bounded evaluation proxies for Marlin video inputs.
 *
 * The Marlin worker hands the raw source path to the model's own video
 * loader. On real footage that is unbounded: a 272-second 1080p clip drove
 * the worker's memory footprint past 40GB on a 32GB machine and the
 * evaluation thrashed forever (smoke projects never caught this — their
 * synthetic sources are seconds long).
 *
 * Before any caption/find request, sources wider than the proxy width are
 * transcoded once to a downscaled, audio-free H.264 proxy. Duration and
 * timestamps are preserved, so every span the model returns is valid for
 * the original source. Proxies are cached per source content
 * (path + size + mtime) under the project's .marlin-proxy-cache/.
 *
 * Env knobs:
 *   VOS_MARLIN_PROXY_MAX_WIDTH  proxy width in px (default 640)
 *   VOS_MARLIN_PROXY_DISABLE=1  pass sources through untouched
 */

import { execFile } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

const DEFAULT_PROXY_MAX_WIDTH = 640;
export const MARLIN_PROXY_CACHE_DIRNAME = ".marlin-proxy-cache";

export interface MarlinProxyResult {
  /** Path to hand to the Marlin worker. */
  evaluationPath: string;
  /** True when a downscaled proxy is in use. */
  proxied: boolean;
}

function execFilePromise(
  cmd: string,
  args: string[],
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 50 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(err);
      else resolve({ stdout: stdout ?? "", stderr: stderr ?? "" });
    });
  });
}

export function marlinProxyMaxWidth(): number {
  const raw = Number(process.env.VOS_MARLIN_PROXY_MAX_WIDTH);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_PROXY_MAX_WIDTH;
}

export function marlinProxyDisabled(): boolean {
  return process.env.VOS_MARLIN_PROXY_DISABLE === "1";
}

/** Cache key from source identity — path, size, mtime. */
export function marlinProxyCacheKey(sourcePath: string, size: number, mtimeMs: number): string {
  return crypto
    .createHash("sha256")
    .update(`${sourcePath}:${size}:${Math.floor(mtimeMs)}`)
    .digest("hex")
    .slice(0, 16);
}

async function probeWidth(sourcePath: string): Promise<number | null> {
  try {
    const { stdout } = await execFilePromise("ffprobe", [
      "-v", "error",
      "-select_streams", "v:0",
      "-show_entries", "stream=width",
      "-of", "csv=p=0",
      sourcePath,
    ]);
    const width = Number(stdout.trim().split(",")[0]);
    return Number.isFinite(width) && width > 0 ? width : null;
  } catch {
    return null;
  }
}

/**
 * Return a bounded evaluation path for a Marlin source. Small sources and
 * probe failures pass through unchanged (the worker then behaves exactly
 * as before this layer existed).
 */
export async function prepareMarlinProxy(
  projectDir: string,
  sourcePath: string,
): Promise<MarlinProxyResult> {
  if (marlinProxyDisabled()) {
    return { evaluationPath: sourcePath, proxied: false };
  }

  const maxWidth = marlinProxyMaxWidth();
  const width = await probeWidth(sourcePath);
  if (width === null || width <= maxWidth) {
    return { evaluationPath: sourcePath, proxied: false };
  }

  const stat = fs.statSync(sourcePath);
  const key = marlinProxyCacheKey(sourcePath, stat.size, stat.mtimeMs);
  const cacheDir = path.join(projectDir, MARLIN_PROXY_CACHE_DIRNAME);
  const proxyPath = path.join(cacheDir, `${key}-w${maxWidth}.mp4`);
  if (fs.existsSync(proxyPath)) {
    return { evaluationPath: proxyPath, proxied: true };
  }

  fs.mkdirSync(cacheDir, { recursive: true });
  const tmpPath = `${proxyPath}.tmp-${process.pid}.mp4`;
  try {
    await execFilePromise("ffmpeg", [
      "-y",
      "-i", sourcePath,
      // Even width, preserve aspect; duration/timestamps unchanged.
      "-vf", `scale=${maxWidth}:-2`,
      "-c:v", "libx264",
      "-preset", "ultrafast",
      "-crf", "28",
      "-an",
      "-pix_fmt", "yuv420p",
      tmpPath,
    ]);
    fs.renameSync(tmpPath, proxyPath);
    return { evaluationPath: proxyPath, proxied: true };
  } catch (err) {
    try {
      fs.rmSync(tmpPath, { force: true });
    } catch {
      // ignore
    }
    // Degrade to the original source rather than failing the evaluation.
    console.error(
      `[marlin-proxy] transcode failed for ${path.basename(sourcePath)}; using original source: ${String(err)}`,
    );
    return { evaluationPath: sourcePath, proxied: false };
  }
}
