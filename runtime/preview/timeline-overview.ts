/**
 * Timeline Overview Image Generator (M4-1)
 *
 * Generates a contact sheet image from timeline.json by extracting
 * a representative frame from each V1 clip and tiling them horizontally
 * into a single PNG overview image.
 */

import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { LoadedSourceMap } from "../media/source-map.js";

// ── Types ──────────────────────────────────────────────────────────

export interface TimelineOverviewOptions {
  projectDir: string;
  timelinePath: string;
  sourceMap: LoadedSourceMap;
  /** Output file path override */
  outputPath?: string;
  /** Thumbnail height in pixels (default: 180) */
  thumbHeight?: number;
}

export interface TimelineOverviewResult {
  outputPath: string;
  clipCount: number;
}

interface TimelineData {
  sequence: {
    fps_num: number;
    fps_den: number;
    width: number;
    height: number;
  };
  tracks: {
    video: Array<{
      clips: Array<{
        clip_id: string;
        asset_id: string;
        src_in_us: number;
        src_out_us: number;
        timeline_in_frame: number;
        timeline_duration_frames: number;
        beat_id: string;
      }>;
    }>;
  };
}

// ── Helpers ────────────────────────────────────────────────────────

function execFilePromise(
  cmd: string,
  args: string[],
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 100 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(err);
      resolve({ stdout: stdout ?? "", stderr: stderr ?? "" });
    });
  });
}

/**
 * Compute the midpoint timestamp (in seconds) of a clip's source range.
 * This is used to extract the most representative frame.
 */
export function clipMidpointSec(srcInUs: number, srcOutUs: number): number {
  return (srcInUs + srcOutUs) / 2 / 1_000_000;
}

/**
 * Resolve the source file path for an asset ID using the source map.
 */
function resolveSourcePath(
  sourceMap: LoadedSourceMap,
  assetId: string,
): string | undefined {
  const entry = sourceMap.entryMap.get(assetId);
  if (!entry) return undefined;

  if (entry.local_source_path && fs.existsSync(entry.local_source_path)) {
    return entry.local_source_path;
  }
  if (entry.source_locator && fs.existsSync(entry.source_locator)) {
    return entry.source_locator;
  }
  return undefined;
}

/**
 * Build ffmpeg arguments to extract a single frame as a thumbnail image.
 */
export function buildFrameExtractArgs(
  sourcePath: string,
  seekSec: number,
  thumbHeight: number,
  outputPath: string,
): string[] {
  return [
    "-y",
    "-ss", seekSec.toFixed(6),
    "-i", sourcePath,
    "-vframes", "1",
    "-vf", `scale=-2:${thumbHeight}`,
    outputPath,
  ];
}

/**
 * Build an ffmpeg filter_complex for horizontal tiling of N images.
 *
 * Uses hstack filter to tile images horizontally. Each image is first
 * scaled to a uniform height to ensure alignment.
 */
export function buildHstackFilter(count: number, thumbHeight: number): string {
  if (count === 1) {
    return `[0:v]scale=-2:${thumbHeight}[out]`;
  }

  const scaleFilters = Array.from({ length: count }, (_, i) =>
    `[${i}:v]scale=-2:${thumbHeight}[s${i}]`,
  ).join("; ");

  const inputs = Array.from({ length: count }, (_, i) => `[s${i}]`).join("");

  return `${scaleFilters}; ${inputs}hstack=inputs=${count}[out]`;
}

/**
 * Build ffmpeg arguments for assembling thumbnails into a contact sheet.
 */
export function buildContactSheetArgs(
  thumbPaths: string[],
  thumbHeight: number,
  outputPath: string,
): string[] {
  const inputs: string[] = [];
  for (const p of thumbPaths) {
    inputs.push("-i", p);
  }

  const filter = buildHstackFilter(thumbPaths.length, thumbHeight);

  return [
    "-y",
    ...inputs,
    "-filter_complex", filter,
    "-map", "[out]",
    outputPath,
  ];
}

// ── Main Generation Function ───────────────────────────────────────

/**
 * Generate a timeline overview contact sheet image.
 *
 * 1. Load timeline and extract V1 clips (sorted by timeline position)
 * 2. For each clip, extract a representative frame at the source midpoint
 * 3. Tile all frames horizontally into a single PNG
 */
export async function generateTimelineOverview(
  opts: TimelineOverviewOptions,
): Promise<TimelineOverviewResult> {
  const timeline: TimelineData = JSON.parse(
    fs.readFileSync(opts.timelinePath, "utf-8"),
  );

  const thumbHeight = opts.thumbHeight ?? 180;

  // Extract V1 clips sorted by timeline position
  const v1 = timeline.tracks.video[0];
  if (!v1 || v1.clips.length === 0) {
    throw new Error("No video clips found in V1 track for overview generation");
  }

  const clips = [...v1.clips].sort(
    (a, b) => a.timeline_in_frame - b.timeline_in_frame,
  );

  // Prepare output
  const outputPath = opts.outputPath ??
    path.join(opts.projectDir, "05_timeline", "timeline-overview.png");
  const outputDir = path.dirname(outputPath);
  fs.mkdirSync(outputDir, { recursive: true });

  // Create temp directory for thumbnails
  const tmpDir = path.join(outputDir, `.overview-tmp-${Date.now()}`);
  fs.mkdirSync(tmpDir, { recursive: true });

  try {
    const thumbPaths: string[] = [];

    // Extract a representative frame from each clip
    for (let i = 0; i < clips.length; i++) {
      const clip = clips[i];
      const sourcePath = resolveSourcePath(opts.sourceMap, clip.asset_id);

      if (!sourcePath) {
        // Skip clips without source — generate a placeholder would be complex;
        // instead, just skip and note it
        continue;
      }

      const seekSec = clipMidpointSec(clip.src_in_us, clip.src_out_us);
      const thumbPath = path.join(tmpDir, `thumb_${String(i).padStart(4, "0")}.png`);

      const args = buildFrameExtractArgs(sourcePath, seekSec, thumbHeight, thumbPath);
      await execFilePromise("ffmpeg", args);
      thumbPaths.push(thumbPath);
    }

    if (thumbPaths.length === 0) {
      throw new Error(
        "No thumbnails could be extracted — source files may be missing. " +
        "Ensure source_map.json exists in 02_media/ with valid paths.",
      );
    }

    // Tile thumbnails into a contact sheet
    if (thumbPaths.length === 1) {
      // Single thumbnail — just copy it
      fs.copyFileSync(thumbPaths[0], outputPath);
    } else {
      const args = buildContactSheetArgs(thumbPaths, thumbHeight, outputPath);
      await execFilePromise("ffmpeg", args);
    }

    return {
      outputPath,
      clipCount: thumbPaths.length,
    };
  } finally {
    // Clean up temp directory
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}
