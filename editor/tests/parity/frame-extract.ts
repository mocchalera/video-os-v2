/**
 * frame-extract — pull a single PNG frame from a video at a given offset.
 *
 * Used by parity tests to compare representative frames between preview
 * and final renders. Wraps `ffmpeg -ss ... -frames:v 1` so callers don't
 * have to think about codec details.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface ExtractFrameOptions {
  /** Path to the source video. */
  videoPath: string;
  /** Where to write the extracted PNG. */
  outputPath: string;
  /** Time offset in seconds. */
  timeSec: number;
  /** Optional ffmpeg binary override. Defaults to "ffmpeg". */
  ffmpegBin?: string;
}

/**
 * Extract a single PNG frame at the requested timestamp.
 *
 * Uses fast input seek (`-ss` before `-i`) plus a single output frame
 * (`-frames:v 1`). Throws if ffmpeg fails.
 */
export async function extractFrame(opts: ExtractFrameOptions): Promise<void> {
  const ffmpeg = opts.ffmpegBin ?? "ffmpeg";
  await execFileAsync(ffmpeg, [
    "-y",
    "-ss",
    opts.timeSec.toFixed(6),
    "-i",
    opts.videoPath,
    "-frames:v",
    "1",
    "-q:v",
    "2",
    opts.outputPath,
  ]);
}
