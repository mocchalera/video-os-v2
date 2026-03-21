/**
 * ffmpeg derivatives — contact sheets, posters, filmstrips, waveforms.
 *
 * Per milestone-2-design.md §Contact Sheets, §Posters, §Filmstrips, §Waveforms
 */

import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { AssetItem } from "./ffprobe.js";
import type { SegmentItem } from "./ffmpeg-segmenter.js";

// ── Types ──────────────────────────────────────────────────────────

export interface ContactSheetManifest {
  contact_sheet_id: string;
  asset_id: string;
  image_path: string;
  tile_map: Array<{
    tile_index: number;
    segment_id: string;
    rep_frame_us: number;
    src_in_us: number;
    src_out_us: number;
  }>;
}

// ── Helpers ────────────────────────────────────────────────────────

function execFilePromise(
  cmd: string,
  args: string[],
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 50 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(err);
      resolve({ stdout: stdout ?? "", stderr: stderr ?? "" });
    });
  });
}

function ensureDir(dirPath: string): void {
  fs.mkdirSync(dirPath, { recursive: true });
}

// ── Contact Sheets ─────────────────────────────────────────────────

const TILES_PER_PAGE = 16;
const TILE_COLS = 4;

/**
 * Generate paginated contact sheets for an asset.
 * Each page has up to 16 tiles (4x4 grid) of segment representative frames.
 */
export async function generateContactSheets(
  filePath: string,
  asset: AssetItem,
  segments: SegmentItem[],
  outputDir: string,
): Promise<ContactSheetManifest[]> {
  const csDir = path.join(outputDir, "contact_sheets");
  ensureDir(csDir);

  const manifests: ContactSheetManifest[] = [];
  const pageCount = Math.ceil(segments.length / TILES_PER_PAGE);

  for (let page = 0; page < pageCount; page++) {
    const pageSegments = segments.slice(
      page * TILES_PER_PAGE,
      (page + 1) * TILES_PER_PAGE,
    );
    const pageStr = String(page + 1).padStart(2, "0");
    const csId = `CS_${asset.asset_id}_${pageStr}`;
    const imagePath = `contact_sheets/${csId}.png`;
    const absImagePath = path.join(outputDir, imagePath);

    // Extract representative frames and tile them
    const tmpFrames: string[] = [];
    for (let i = 0; i < pageSegments.length; i++) {
      const seg = pageSegments[i];
      const timeSec = seg.rep_frame_us / 1_000_000;
      const tmpPath = path.join(csDir, `_tmp_${csId}_tile_${i}.png`);
      tmpFrames.push(tmpPath);

      await execFilePromise("ffmpeg", [
        "-y",
        "-ss", String(timeSec),
        "-i", path.resolve(filePath),
        "-vframes", "1",
        "-vf", "scale=240:-1",
        tmpPath,
      ]);
    }

    // Tile frames into a grid using ffmpeg
    if (tmpFrames.length > 0) {
      const cols = Math.min(TILE_COLS, tmpFrames.length);
      const rows = Math.ceil(tmpFrames.length / cols);

      // Build filter_complex for tiling
      const inputs: string[] = [];
      const filterParts: string[] = [];

      for (let i = 0; i < tmpFrames.length; i++) {
        inputs.push("-i", tmpFrames[i]);
      }

      // Pad to fill the grid if needed
      const totalTiles = rows * cols;
      const padCount = totalTiles - tmpFrames.length;

      if (tmpFrames.length === 1) {
        // Single tile — just copy
        await execFilePromise("ffmpeg", [
          "-y", "-i", tmpFrames[0], absImagePath,
        ]);
      } else {
        // Use xstack for tiling
        const layoutParts: string[] = [];
        const inputLabels: string[] = [];

        for (let i = 0; i < tmpFrames.length; i++) {
          inputLabels.push(`[${i}:v]`);
          const col = i % cols;
          const row = Math.floor(i / cols);
          layoutParts.push(`${col * 240}_${row * 180}`);
        }

        // For padding, duplicate the last frame
        for (let i = 0; i < padCount; i++) {
          inputLabels.push(`[${tmpFrames.length - 1}:v]`);
          const idx = tmpFrames.length + i;
          const col = idx % cols;
          const row = Math.floor(idx / cols);
          layoutParts.push(`${col * 240}_${row * 180}`);
        }

        // xstack needs all inputs
        const filterStr = `${inputLabels.join("")}xstack=inputs=${totalTiles}:layout=${layoutParts.join("|")}`;

        try {
          await execFilePromise("ffmpeg", [
            "-y",
            ...inputs,
            // Re-add last input for pad tiles
            ...Array(padCount).fill(null).flatMap(() => ["-i", tmpFrames[tmpFrames.length - 1]]),
            "-filter_complex", filterStr,
            "-frames:v", "1",
            absImagePath,
          ]);
        } catch {
          // Fallback: just use the first frame as the contact sheet
          await execFilePromise("ffmpeg", [
            "-y", "-i", tmpFrames[0], absImagePath,
          ]);
        }
      }
    }

    // Clean up tmp frames
    for (const tmp of tmpFrames) {
      try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    }

    const manifest: ContactSheetManifest = {
      contact_sheet_id: csId,
      asset_id: asset.asset_id,
      image_path: imagePath,
      tile_map: pageSegments.map((seg, i) => ({
        tile_index: i,
        segment_id: seg.segment_id,
        rep_frame_us: seg.rep_frame_us,
        src_in_us: seg.src_in_us,
        src_out_us: seg.src_out_us,
      })),
    };

    manifests.push(manifest);

    // Write manifest JSON
    const manifestPath = path.join(csDir, `${csId}.json`);
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  }

  return manifests;
}

// ── Posters ────────────────────────────────────────────────────────

/**
 * Select the best segment for the poster based on ranking rules:
 * 1. Filter out hard-rejected segments (black_segment, frozen_frame)
 * 2. If all segments are hard-rejected, fallback to asset midpoint
 * 3. Among non-rejected: longer duration_us → higher confidence → earlier src_in_us
 */
export function selectPosterSegment(
  segments: SegmentItem[],
  assetDurationUs: number,
): { rep_frame_us: number } {
  if (segments.length === 0) {
    return { rep_frame_us: Math.round(assetDurationUs / 2) };
  }

  const hardRejectFlags = new Set(["black_segment", "frozen_frame"]);

  // First: filter to non-rejected segments
  const nonRejected = segments.filter(
    (s) => !s.quality_flags.some((f) => hardRejectFlags.has(f)),
  );

  // If ALL segments are hard-rejected, fallback to asset midpoint
  if (nonRejected.length === 0) {
    return { rep_frame_us: Math.round(assetDurationUs / 2) };
  }

  // Rank non-rejected segments
  const ranked = [...nonRejected].sort((a, b) => {
    if (a.duration_us !== b.duration_us) return b.duration_us - a.duration_us;

    const aScore = a.confidence?.boundary?.score ?? 0;
    const bScore = b.confidence?.boundary?.score ?? 0;
    if (aScore !== bScore) return bScore - aScore;

    return a.src_in_us - b.src_in_us;
  });

  return { rep_frame_us: ranked[0].rep_frame_us };
}

/**
 * Generate a poster image for an asset.
 */
export async function generatePoster(
  filePath: string,
  asset: AssetItem,
  segments: SegmentItem[],
  outputDir: string,
): Promise<string> {
  const posterDir = path.join(outputDir, "posters");
  ensureDir(posterDir);

  const posterPath = `posters/${asset.asset_id}.jpg`;
  const absPosterPath = path.join(outputDir, posterPath);

  const best = selectPosterSegment(segments, asset.duration_us);
  const timeSec = best.rep_frame_us / 1_000_000;

  await execFilePromise("ffmpeg", [
    "-y",
    "-ss", String(timeSec),
    "-i", path.resolve(filePath),
    "-vframes", "1",
    "-q:v", "2",
    absPosterPath,
  ]);

  return posterPath;
}

// ── Filmstrips ─────────────────────────────────────────────────────

const FILMSTRIP_FRAMES = 6;
const FILMSTRIP_TILE_WIDTH = 240;
const EDGE_TRIM_FRACTION = 0.05;

/**
 * Generate a filmstrip image for a segment.
 * Sample 6 evenly spaced frames inside the segment after trimming 5% from each edge.
 */
export async function generateFilmstrip(
  filePath: string,
  segment: SegmentItem,
  outputDir: string,
): Promise<string> {
  const filmstripDir = path.join(outputDir, "filmstrips");
  ensureDir(filmstripDir);

  const filmstripPath = `filmstrips/${segment.segment_id}.png`;
  const absFilmstripPath = path.join(outputDir, filmstripPath);

  const segDuration = segment.src_out_us - segment.src_in_us;
  const trimUs = Math.round(segDuration * EDGE_TRIM_FRACTION);
  const usableStart = segment.src_in_us + trimUs;
  const usableEnd = segment.src_out_us - trimUs;
  const usableDuration = usableEnd - usableStart;

  // Calculate sample timestamps
  const timestamps: number[] = [];
  if (usableDuration <= 0 || FILMSTRIP_FRAMES <= 1) {
    // Segment too short for distinct samples
    const mid = Math.round((segment.src_in_us + segment.src_out_us) / 2);
    for (let i = 0; i < FILMSTRIP_FRAMES; i++) {
      timestamps.push(mid);
    }
  } else {
    const step = usableDuration / (FILMSTRIP_FRAMES - 1);
    for (let i = 0; i < FILMSTRIP_FRAMES; i++) {
      timestamps.push(Math.round(usableStart + step * i));
    }
  }

  // Extract frames
  const tmpFrames: string[] = [];
  for (let i = 0; i < timestamps.length; i++) {
    const timeSec = timestamps[i] / 1_000_000;
    const tmpPath = path.join(filmstripDir, `_tmp_fs_${segment.segment_id}_${i}.png`);
    tmpFrames.push(tmpPath);

    await execFilePromise("ffmpeg", [
      "-y",
      "-ss", String(timeSec),
      "-i", path.resolve(filePath),
      "-vframes", "1",
      "-vf", `scale=${FILMSTRIP_TILE_WIDTH}:-1`,
      tmpPath,
    ]);
  }

  // Stitch horizontally using hstack
  if (tmpFrames.length === 1) {
    fs.renameSync(tmpFrames[0], absFilmstripPath);
  } else {
    const inputArgs = tmpFrames.flatMap((f) => ["-i", f]);
    const filterStr = tmpFrames.map((_, i) => `[${i}:v]`).join("") +
      `hstack=inputs=${tmpFrames.length}`;

    try {
      await execFilePromise("ffmpeg", [
        "-y",
        ...inputArgs,
        "-filter_complex", filterStr,
        "-frames:v", "1",
        absFilmstripPath,
      ]);
    } catch {
      // Fallback: use first frame
      fs.copyFileSync(tmpFrames[0], absFilmstripPath);
    }

    // Clean up
    for (const tmp of tmpFrames) {
      try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    }
  }

  return filmstripPath;
}

// ── Waveforms ──────────────────────────────────────────────────────

/**
 * Generate a waveform master image for an asset.
 */
export async function generateWaveform(
  filePath: string,
  asset: AssetItem,
  outputDir: string,
): Promise<string | null> {
  if (!asset.audio_stream) return null;

  const waveformDir = path.join(outputDir, "waveforms");
  ensureDir(waveformDir);

  const wfId = `WF_${asset.asset_id}`;
  const waveformPath = `waveforms/${wfId}.png`;
  const absWaveformPath = path.join(outputDir, waveformPath);

  try {
    await execFilePromise("ffmpeg", [
      "-y",
      "-i", path.resolve(filePath),
      "-filter_complex", "aformat=channel_layouts=mono,showwavespic=s=1200x120:colors=0x3388ff",
      "-frames:v", "1",
      absWaveformPath,
    ]);
    return waveformPath;
  } catch {
    // Audio extraction failed
    return null;
  }
}

// ── Batch Derivative Generation ────────────────────────────────────

export interface DerivativeResults {
  contactSheets: ContactSheetManifest[];
  posterPath: string | null;
  filmstripPaths: Map<string, string>;
  waveformPath: string | null;
}

/**
 * Generate all derivatives for an asset and its segments.
 */
export async function generateAllDerivatives(
  filePath: string,
  asset: AssetItem,
  segments: SegmentItem[],
  outputDir: string,
): Promise<DerivativeResults> {
  // Contact sheets
  const contactSheets = await generateContactSheets(
    filePath, asset, segments, outputDir,
  );

  // Poster
  let posterPath: string | null = null;
  if (asset.video_stream) {
    posterPath = await generatePoster(filePath, asset, segments, outputDir);
  }

  // Filmstrips
  const filmstripPaths = new Map<string, string>();
  for (const seg of segments) {
    if (asset.video_stream) {
      const fPath = await generateFilmstrip(filePath, seg, outputDir);
      filmstripPaths.set(seg.segment_id, fPath);
    }
  }

  // Waveform
  const waveformPath = await generateWaveform(filePath, asset, outputDir);

  return { contactSheets, posterPath, filmstripPaths, waveformPath };
}
