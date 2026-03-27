/**
 * Waveform peaks generation API route.
 *
 * GET /api/projects/:id/waveform/:assetId?detail=coarse|medium|fine
 *
 * Extracts audio peaks from the source file via ffmpeg (raw PCM f32le),
 * downsamples to the requested detail level, and caches results as JSON.
 */

import { Router } from "express";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { safeProjectDir } from "../utils.js";

// ── Detail level configuration ───────────────────────────────────────

const DETAIL_SAMPLE_COUNTS: Record<string, number> = {
  coarse: 128,
  medium: 512,
  fine: 2048,
};

const DEFAULT_DETAIL = "medium";

// ── Source map resolution ─────────────────────────────────────────────

interface SourceMapEntry {
  asset_id?: string;
  local_source_path?: string;
  link_path?: string;
  source_locator?: string;
  filename?: string;
}

/** Resolve asset_id to a local file path using source_map, mirroring media.ts pattern. */
function resolveAssetPath(
  projectDir: string,
  assetId: string,
): string | null {
  for (const smName of [
    "02_media/source_map.json",
    "03_analysis/source_map.json",
  ]) {
    const smPath = path.join(projectDir, smName);
    if (!fs.existsSync(smPath)) continue;
    try {
      const sm = JSON.parse(fs.readFileSync(smPath, "utf-8")) as {
        items?: SourceMapEntry[];
      };
      const entry = (sm.items ?? []).find((i) => i.asset_id === assetId);
      if (!entry) continue;
      const srcPath =
        entry.local_source_path ?? entry.link_path ?? entry.source_locator;
      if (srcPath && fs.existsSync(srcPath)) return srcPath;
    } catch {
      /* ignore parse errors */
    }
  }
  return null;
}

// ── ffmpeg audio peak extraction ──────────────────────────────────────

interface WaveformResult {
  peaks: number[];
  sample_count: number;
  duration_sec: number;
  detail: string;
}

// ── Concurrency limiter for ffmpeg processes ──────────────────────────

const MAX_CONCURRENT_FFMPEG = 3;
let activeFfmpeg = 0;
const ffmpegQueue: Array<() => void> = [];

function acquireFfmpegSlot(): Promise<void> {
  if (activeFfmpeg < MAX_CONCURRENT_FFMPEG) {
    activeFfmpeg++;
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    ffmpegQueue.push(resolve);
  });
}

function releaseFfmpegSlot(): void {
  const next = ffmpegQueue.shift();
  if (next) {
    next();
  } else {
    activeFfmpeg--;
  }
}

/**
 * Extract raw f32le mono PCM from the source file via ffmpeg piped to stdout.
 * Streams data and downsamples on the fly to avoid buffering the entire file.
 * Supports abort signal to kill ffmpeg on client disconnect.
 */
function streamExtractAndDownsample(
  sourcePath: string,
  targetSamples: number,
  abortSignal?: AbortSignal,
): Promise<{ peaks: number[]; totalSamples: number }> {
  return new Promise((resolve, reject) => {
    if (abortSignal?.aborted) {
      reject(new Error("Aborted"));
      return;
    }

    const proc = spawn(
      "ffmpeg",
      [
        "-i",
        sourcePath,
        "-ac",
        "1", // downmix to mono
        "-f",
        "f32le",
        "-acodec",
        "pcm_f32le",
        "pipe:1",
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );

    // Kill ffmpeg on abort
    const onAbort = () => {
      proc.kill("SIGKILL");
      reject(new Error("Aborted"));
    };
    abortSignal?.addEventListener("abort", onAbort, { once: true });

    // Streaming downsample state
    // First pass: collect total sample count to know window size.
    // Since we can't know total in advance, use two-pass or adaptive approach.
    // For streaming: accumulate peaks per fixed-size window, then resample at end.
    // Use a reasonable window: collect ~16k buckets, then resample to targetSamples.
    const BUCKET_COUNT = Math.max(targetSamples, 4096);
    const bucketMaxAbs: number[] = [];
    const bucketMaxSigned: number[] = [];
    let leftover = Buffer.alloc(0);
    let totalSamples = 0;
    let currentBucket = 0;
    let samplesInBucket = 0;
    let bucketMaxAbsVal = 0;
    let bucketMaxSignedVal = 0;
    // We'll set samplesPerBucket after seeing total — use adaptive: resize buckets
    // Actually for streaming we don't know total. Use a fixed bucket size based on
    // typical audio length. Better approach: accumulate all bucket peaks, then
    // downsample the buckets array to targetSamples at the end.
    const SAMPLES_PER_BUCKET = 4096; // ~0.09s at 44100Hz

    proc.stdout.on("data", (chunk: Buffer) => {
      // Prepend leftover bytes from previous chunk
      const buf = leftover.length > 0 ? Buffer.concat([leftover, chunk]) : chunk;
      const usableBytes = buf.length - (buf.length % 4);
      leftover = buf.length > usableBytes ? Buffer.from(buf.subarray(usableBytes)) : Buffer.alloc(0);

      for (let i = 0; i < usableBytes; i += 4) {
        const val = buf.readFloatLE(i);
        const abs = Math.abs(val);
        if (abs > bucketMaxAbsVal) {
          bucketMaxAbsVal = abs;
          bucketMaxSignedVal = val;
        }
        samplesInBucket++;
        totalSamples++;

        if (samplesInBucket >= SAMPLES_PER_BUCKET) {
          bucketMaxAbs.push(bucketMaxAbsVal);
          bucketMaxSigned.push(Math.max(-1, Math.min(1, bucketMaxSignedVal)));
          bucketMaxAbsVal = 0;
          bucketMaxSignedVal = 0;
          samplesInBucket = 0;
          currentBucket++;
        }
      }
    });

    let stderr = "";
    proc.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    proc.on("close", (code) => {
      abortSignal?.removeEventListener("abort", onAbort);

      if (abortSignal?.aborted) return;

      // Flush remaining samples
      if (samplesInBucket > 0) {
        bucketMaxSigned.push(Math.max(-1, Math.min(1, bucketMaxSignedVal)));
      }

      if ((code !== 0 && code !== null) && bucketMaxSigned.length === 0) {
        reject(new Error(`ffmpeg exited with code ${code}: ${stderr.slice(-500)}`));
        return;
      }

      // Resample buckets to targetSamples
      const peaks: number[] = [];
      if (bucketMaxSigned.length === 0) {
        resolve({ peaks: new Array(targetSamples).fill(0), totalSamples: 0 });
        return;
      }

      const bucketsPerPeak = bucketMaxSigned.length / targetSamples;
      for (let i = 0; i < targetSamples; i++) {
        const start = Math.floor(i * bucketsPerPeak);
        const end = Math.min(bucketMaxSigned.length, Math.floor((i + 1) * bucketsPerPeak));
        let maxAbs = 0;
        let maxSigned = 0;
        for (let j = start; j < end; j++) {
          const abs = Math.abs(bucketMaxSigned[j]);
          if (abs > maxAbs) {
            maxAbs = abs;
            maxSigned = bucketMaxSigned[j];
          }
        }
        peaks.push(maxSigned);
      }

      resolve({ peaks, totalSamples });
    });

    proc.on("error", (err) => {
      abortSignal?.removeEventListener("abort", onAbort);
      reject(err);
    });
  });
}

/**
 * Use ffprobe to get the duration of the source file in seconds.
 * Falls back to computing from sample count if ffprobe is unavailable.
 */
function probeDuration(sourcePath: string): Promise<number> {
  return new Promise((resolve) => {
    const proc = spawn(
      "ffprobe",
      [
        "-v",
        "quiet",
        "-print_format",
        "json",
        "-show_format",
        sourcePath,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );

    let stdout = "";
    proc.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    proc.on("close", (code) => {
      if (code === 0) {
        try {
          const data = JSON.parse(stdout) as {
            format?: { duration?: string };
          };
          const dur = parseFloat(data.format?.duration ?? "0");
          resolve(isFinite(dur) && dur > 0 ? dur : 0);
          return;
        } catch {
          /* fall through */
        }
      }
      resolve(0);
    });

    proc.on("error", () => resolve(0));
  });
}

// ── Router factory ────────────────────────────────────────────────────

export function createWaveformRouter(projectsDir: string): Router {
  const router = Router();

  // GET /api/projects/:id/waveform/:assetId?detail=coarse|medium|fine
  router.get("/:id/waveform/:assetId", async (req, res) => {
    // Validate project
    const projectDir = safeProjectDir(projectsDir, req.params.id);
    if (!projectDir) {
      res.status(400).json({ error: "Invalid project ID" });
      return;
    }

    // Validate assetId — prevent path traversal
    const assetId = req.params.assetId;
    if (
      !assetId ||
      assetId.includes("..") ||
      assetId.includes("/") ||
      assetId.includes("\\") ||
      assetId.includes("%2F") ||
      assetId.includes("%2f") ||
      assetId.includes("\0")
    ) {
      res.status(400).json({ error: "Invalid asset ID" });
      return;
    }

    // Validate detail level
    const rawDetail = (req.query.detail as string) ?? DEFAULT_DETAIL;
    const detail = rawDetail in DETAIL_SAMPLE_COUNTS ? rawDetail : DEFAULT_DETAIL;
    const targetSamples = DETAIL_SAMPLE_COUNTS[detail];

    // Resolve source path
    const sourcePath = resolveAssetPath(projectDir, assetId);
    if (!sourcePath) {
      res.status(404).json({
        error: "Asset not found",
        asset_id: assetId,
      });
      return;
    }

    // Ensure cache directory exists
    const cacheDir = path.join(projectDir, ".waveform-cache");
    try {
      fs.mkdirSync(cacheDir, { recursive: true });
    } catch (err) {
      res.status(500).json({
        error: "Failed to create cache directory",
        details: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    // Include mtime in cache key so stale cache is invalidated on asset replacement
    let mtimeHash: string;
    try {
      const stat = fs.statSync(sourcePath);
      mtimeHash = createHash("sha1")
        .update(String(stat.mtimeMs))
        .digest("hex")
        .slice(0, 8);
    } catch {
      mtimeHash = "0";
    }
    const cacheKey = `${assetId}.${mtimeHash}.${detail}.json`;
    const cachePath = path.join(cacheDir, cacheKey);

    // Return cached result if available
    if (fs.existsSync(cachePath)) {
      try {
        const cached = JSON.parse(
          fs.readFileSync(cachePath, "utf-8"),
        ) as WaveformResult;
        res.setHeader("Content-Type", "application/json");
        res.setHeader("Cache-Control", "public, max-age=3600");
        res.json(cached);
        return;
      } catch {
        // Cache corrupted — regenerate below
        try { fs.unlinkSync(cachePath); } catch { /* ignore */ }
      }
    }

    // Create abort controller tied to request close
    const abortController = new AbortController();
    req.on("close", () => abortController.abort());

    // Acquire concurrency slot
    await acquireFfmpegSlot();

    try {
      // Run ffprobe and streaming PCM extraction in parallel
      const [{ peaks, totalSamples }, durationSec] = await Promise.all([
        streamExtractAndDownsample(sourcePath, targetSamples, abortController.signal),
        probeDuration(sourcePath),
      ]);

      if (totalSamples === 0) {
        res.status(422).json({
          error: "No audio stream found in asset",
          asset_id: assetId,
        });
        return;
      }

      // Compute duration from sample count if ffprobe returned 0
      // (assume 44100 Hz mono after aresample — ffmpeg default output rate)
      const effectiveDuration =
        durationSec > 0
          ? durationSec
          : totalSamples / 44100;

      const result: WaveformResult = {
        peaks,
        sample_count: peaks.length,
        duration_sec: Math.round(effectiveDuration * 1000) / 1000,
        detail,
      };

      // Write to cache atomically (temp + rename)
      const tmpPath = `${cachePath}.tmp`;
      fs.writeFileSync(tmpPath, JSON.stringify(result));
      fs.renameSync(tmpPath, cachePath);

      res.setHeader("Content-Type", "application/json");
      res.setHeader("Cache-Control", "public, max-age=3600");
      res.json(result);
    } catch (err) {
      if (err instanceof Error && err.message === "Aborted") {
        // Client disconnected — no response needed
        return;
      }
      res.status(500).json({
        error: "Waveform generation failed",
        details: err instanceof Error ? err.message : String(err),
      });
    } finally {
      releaseFfmpegSlot();
    }
  });

  return router;
}
