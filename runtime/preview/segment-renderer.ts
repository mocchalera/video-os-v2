/**
 * Preview Segment Renderer (M4-1)
 *
 * Renders a low-res (720p) preview of specific beats or the first N seconds
 * from a compiled timeline. Uses ffmpeg to extract and concatenate clips
 * from source media files.
 */

import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { LoadedSourceMap } from "../media/source-map.js";

// ── Types ──────────────────────────────────────────────────────────

export interface PreviewClip {
  clip_id: string;
  asset_id: string;
  src_in_us: number;
  src_out_us: number;
  timeline_in_frame: number;
  timeline_duration_frames: number;
  beat_id: string;
}

export interface PreviewSegmentOptions {
  projectDir: string;
  timelinePath: string;
  sourceMap: LoadedSourceMap;
  /** Render only clips belonging to this beat */
  beatId?: string;
  /** Render only the first N seconds of the timeline */
  firstNSec?: number;
  /** Output file path override */
  outputPath?: string;
}

export interface PreviewSegmentResult {
  outputPath: string;
  clipCount: number;
  durationSec: number;
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
        segment_id: string;
        asset_id: string;
        src_in_us: number;
        src_out_us: number;
        timeline_in_frame: number;
        timeline_duration_frames: number;
        beat_id: string;
      }>;
    }>;
  };
  markers: Array<{ frame: number; kind: string; label: string }>;
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
 * Extract V1 (hero track) clips from timeline, sorted by timeline position.
 */
export function extractVideoClips(timeline: TimelineData): PreviewClip[] {
  const allClips: PreviewClip[] = [];

  // Use only the first video track (V1 = hero) for preview
  const v1 = timeline.tracks.video[0];
  if (!v1) return allClips;

  for (const clip of v1.clips) {
    allClips.push({
      clip_id: clip.clip_id,
      asset_id: clip.asset_id,
      src_in_us: clip.src_in_us,
      src_out_us: clip.src_out_us,
      timeline_in_frame: clip.timeline_in_frame,
      timeline_duration_frames: clip.timeline_duration_frames,
      beat_id: clip.beat_id,
    });
  }

  return allClips.sort((a, b) => a.timeline_in_frame - b.timeline_in_frame);
}

/**
 * Filter clips by beat ID.
 */
export function filterByBeat(clips: PreviewClip[], beatId: string): PreviewClip[] {
  return clips.filter((c) => c.beat_id === beatId);
}

/**
 * Filter clips to include only those within the first N seconds.
 */
export function filterByDuration(
  clips: PreviewClip[],
  maxSec: number,
  fpsNum: number,
  fpsDen: number,
): PreviewClip[] {
  const fps = fpsNum / fpsDen;
  const maxFrame = Math.ceil(maxSec * fps);

  return clips.filter((c) => c.timeline_in_frame < maxFrame).map((c) => {
    const clipEndFrame = c.timeline_in_frame + c.timeline_duration_frames;
    if (clipEndFrame <= maxFrame) return c;
    // Truncate the clip to fit within maxFrame
    const trimmedDuration = maxFrame - c.timeline_in_frame;
    const srcDurationUs = c.src_out_us - c.src_in_us;
    const ratio = trimmedDuration / c.timeline_duration_frames;
    return {
      ...c,
      timeline_duration_frames: trimmedDuration,
      src_out_us: c.src_in_us + Math.round(srcDurationUs * ratio),
    };
  });
}

/**
 * Resolve the source file path for an asset ID using the source map.
 */
export function resolveSourcePath(
  sourceMap: LoadedSourceMap,
  assetId: string,
): string | undefined {
  const entry = sourceMap.entryMap.get(assetId);
  if (!entry) return undefined;

  // Try local_source_path first, then source_locator
  if (entry.local_source_path && fs.existsSync(entry.local_source_path)) {
    return entry.local_source_path;
  }
  if (entry.source_locator && fs.existsSync(entry.source_locator)) {
    return entry.source_locator;
  }
  return undefined;
}

/**
 * Build ffmpeg arguments for a single clip extraction at 720p.
 */
export function buildClipExtractArgs(
  sourcePath: string,
  srcInUs: number,
  srcOutUs: number,
  outputPath: string,
): string[] {
  const startSec = srcInUs / 1_000_000;
  const durationSec = (srcOutUs - srcInUs) / 1_000_000;

  return [
    "-y",
    "-ss", startSec.toFixed(6),
    "-i", sourcePath,
    "-t", durationSec.toFixed(6),
    "-vf", "scale=-2:720",
    "-c:v", "libx264",
    "-preset", "ultrafast",
    "-crf", "28",
    "-an",
    "-pix_fmt", "yuv420p",
    outputPath,
  ];
}

/**
 * Build ffmpeg concat demuxer file content from a list of clip file paths.
 */
export function buildConcatFileContent(clipPaths: string[]): string {
  return clipPaths
    .map((p) => `file '${p.replace(/'/g, "'\\''")}'`)
    .join("\n");
}

/**
 * Compute the default output path for a preview.
 */
export function defaultOutputPath(
  projectDir: string,
  beatId?: string,
  firstNSec?: number,
): string {
  const dir = path.join(projectDir, "05_timeline");
  if (beatId) {
    return path.join(dir, `preview-${beatId}.mp4`);
  }
  if (firstNSec) {
    return path.join(dir, `preview-first${firstNSec}s.mp4`);
  }
  return path.join(dir, "preview-full.mp4");
}

// ── Main Render Function ───────────────────────────────────────────

/**
 * Render a preview segment from the timeline.
 *
 * 1. Load timeline and extract V1 clips
 * 2. Filter by beat or duration
 * 3. For each clip, extract from source at 720p via ffmpeg
 * 4. Concatenate all extracted clips into a single preview MP4
 */
export async function renderPreviewSegment(
  opts: PreviewSegmentOptions,
): Promise<PreviewSegmentResult> {
  const timeline: TimelineData = JSON.parse(
    fs.readFileSync(opts.timelinePath, "utf-8"),
  );

  const fps = timeline.sequence.fps_num / timeline.sequence.fps_den;
  let clips = extractVideoClips(timeline);

  // Apply filters
  if (opts.beatId) {
    clips = filterByBeat(clips, opts.beatId);
    if (clips.length === 0) {
      throw new Error(`No clips found for beat: ${opts.beatId}`);
    }
  }
  if (opts.firstNSec) {
    clips = filterByDuration(
      clips,
      opts.firstNSec,
      timeline.sequence.fps_num,
      timeline.sequence.fps_den,
    );
    if (clips.length === 0) {
      throw new Error(`No clips within the first ${opts.firstNSec} seconds`);
    }
  }

  // Prepare output directory
  const outputPath = opts.outputPath ??
    defaultOutputPath(opts.projectDir, opts.beatId, opts.firstNSec);
  const outputDir = path.dirname(outputPath);
  fs.mkdirSync(outputDir, { recursive: true });

  // Create a temp directory for intermediate clip files
  const tmpDir = path.join(outputDir, `.preview-tmp-${Date.now()}`);
  fs.mkdirSync(tmpDir, { recursive: true });

  try {
    const clipPaths: string[] = [];

    // Extract each clip
    for (let i = 0; i < clips.length; i++) {
      const clip = clips[i];
      const sourcePath = resolveSourcePath(opts.sourceMap, clip.asset_id);
      if (!sourcePath) {
        throw new Error(
          `Source file not found for asset ${clip.asset_id}. ` +
          `Ensure source_map.json exists in 02_media/ with valid paths.`,
        );
      }

      const clipOutPath = path.join(tmpDir, `clip_${String(i).padStart(4, "0")}.mp4`);
      const args = buildClipExtractArgs(
        sourcePath,
        clip.src_in_us,
        clip.src_out_us,
        clipOutPath,
      );
      await execFilePromise("ffmpeg", args);
      clipPaths.push(clipOutPath);
    }

    // Concatenate clips
    if (clipPaths.length === 1) {
      // Single clip — just move it
      fs.renameSync(clipPaths[0], outputPath);
    } else {
      // Multiple clips — use concat demuxer
      const concatFilePath = path.join(tmpDir, "concat.txt");
      fs.writeFileSync(concatFilePath, buildConcatFileContent(clipPaths), "utf-8");

      await execFilePromise("ffmpeg", [
        "-y",
        "-f", "concat",
        "-safe", "0",
        "-i", concatFilePath,
        "-c", "copy",
        outputPath,
      ]);
    }

    // Compute total duration
    const totalFrames = clips.reduce((sum, c) => sum + c.timeline_duration_frames, 0);
    const durationSec = totalFrames / fps;

    return {
      outputPath,
      clipCount: clips.length,
      durationSec,
    };
  } finally {
    // Clean up temp directory
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}
