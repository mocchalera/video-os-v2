/**
 * ssim — Structural Similarity comparison between two videos.
 *
 * Uses ffmpeg's built-in `ssim` filter (-lavfi "ssim") and parses the
 * "All:<value>" line from stderr. Returns the global SSIM as a number
 * in [0, 1]. The Phase 5 acceptance criterion is SSIM ≥ 0.999.
 */

import { execFile } from "node:child_process";

export interface SsimResult {
  /** Global SSIM (0..1). 1.0 = pixel-identical. */
  all: number;
  /** Per-channel SSIM if reported by ffmpeg. */
  y?: number;
  u?: number;
  v?: number;
}

export interface SsimOptions {
  /** Reference video path (becomes the second input to ffmpeg). */
  referencePath: string;
  /** Distorted/test video path (becomes the first input). */
  testPath: string;
  /** Optional ffmpeg binary override. */
  ffmpegBin?: string;
}

/**
 * Compute SSIM between two videos with the same dimensions.
 *
 * Throws if ffmpeg cannot run, the videos differ in dimensions, or
 * the SSIM line cannot be parsed.
 */
export function computeSsim(opts: SsimOptions): Promise<SsimResult> {
  return new Promise((resolve, reject) => {
    const ffmpeg = opts.ffmpegBin ?? "ffmpeg";
    execFile(
      ffmpeg,
      [
        "-i",
        opts.testPath,
        "-i",
        opts.referencePath,
        "-lavfi",
        "ssim",
        "-f",
        "null",
        "-",
      ],
      { maxBuffer: 50 * 1024 * 1024 },
      (err, _stdout, stderr) => {
        // ffmpeg writes ssim output to stderr even on success.
        if (err && !stderr) {
          reject(err);
          return;
        }
        try {
          resolve(parseSsimOutput(stderr));
        } catch (parseErr) {
          reject(parseErr);
        }
      },
    );
  });
}

/**
 * Parse the "Parsed_ssim_0 @ 0x...] SSIM Y:... U:... V:... All:0.999 (...)"
 * line out of ffmpeg's stderr.
 */
export function parseSsimOutput(stderr: string): SsimResult {
  // The summary appears at the end of stderr — capture the LAST match.
  const allMatch = stderr.match(/All:([0-9]+\.[0-9]+)/g);
  if (!allMatch || allMatch.length === 0) {
    throw new Error(`Could not parse SSIM output: ${stderr.slice(-400)}`);
  }
  const last = allMatch[allMatch.length - 1];
  const all = Number.parseFloat(last.replace("All:", ""));
  if (!Number.isFinite(all)) {
    throw new Error(`Parsed SSIM is not finite: ${last}`);
  }

  const yMatch = /\bY:([0-9]+\.[0-9]+)/g.exec(stderr);
  const uMatch = /\bU:([0-9]+\.[0-9]+)/g.exec(stderr);
  const vMatch = /\bV:([0-9]+\.[0-9]+)/g.exec(stderr);

  return {
    all,
    ...(yMatch ? { y: Number.parseFloat(yMatch[1]) } : {}),
    ...(uMatch ? { u: Number.parseFloat(uMatch[1]) } : {}),
    ...(vMatch ? { v: Number.parseFloat(vMatch[1]) } : {}),
  };
}
