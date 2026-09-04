/**
 * Bounded, deterministic, fail-open frame extraction for the storyboard.
 *
 * When ffmpeg/ffprobe or the source file is unavailable the generator still
 * produces the full HTML skeleton and records explicit warnings — it never
 * substitutes a silent placeholder for missing visual evidence.
 */

import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { promisify } from "node:util";
import { runFfprobe } from "../../connectors/ffprobe.js";
import type { RepresentativeFramePlan, ResolvedCandidateBinding } from "./types.js";

const execFileAsync = promisify(execFile);

const FRAME_HEIGHT = 480;
const FILMSTRIP_TILES = 4;
const FILMSTRIP_TILE_WIDTH = 220;
const WAVEFORM_SIZE = "1200x160";

export interface FrameToolchainStatus {
  ffmpeg: boolean;
  ffmpegError: string | null;
}

/** Probe the local toolchain once per run. Absence is a warning, not an error. */
export async function probeFrameToolchain(): Promise<FrameToolchainStatus> {
  try {
    await execFileAsync("ffmpeg", ["-version"]);
    return { ffmpeg: true, ffmpegError: null };
  } catch (error) {
    return {
      ffmpeg: false,
      ffmpegError: error instanceof Error ? error.message : String(error),
    };
  }
}

export interface SourceVisualInfo {
  /** width/height ratio of the source; null when unknown. */
  aspect: number | null;
  width: number | null;
  height: number | null;
  note: string | null;
}

/** Probe source aspect via ffprobe; fail-open to unknown. */
export async function probeSourceAspect(filePath: string | null): Promise<SourceVisualInfo> {
  if (!filePath || !fs.existsSync(filePath)) {
    return {
      aspect: null,
      width: null,
      height: null,
      note: filePath ? "source file is missing on disk" : "source asset is not registered in the source map",
    };
  }
  try {
    const probe = await runFfprobe(filePath);
    const video = probe.streams.find((stream) => stream.codec_type === "video");
    const width = video?.width ?? null;
    const height = video?.height ?? null;
    if (width && height) {
      return { aspect: width / height, width, height, note: null };
    }
    return {
      aspect: null,
      width: null,
      height: null,
      note: "source has no decodable video dimensions (audio-only or still-image asset)",
    };
  } catch (error) {
    return {
      aspect: null,
      width: null,
      height: null,
      note: `ffprobe failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export interface FrameExtractionResult {
  /** Project-relative path (from projection dir) of the produced file. */
  file: string | null;
  warning: string | null;
}

function clampSeek(sourceDurationSec: number | null, seekSec: number): number {
  if (sourceDurationSec === null || !Number.isFinite(sourceDurationSec) || sourceDurationSec <= 0) {
    return Math.max(0, seekSec);
  }
  return Math.min(Math.max(0, seekSec), Math.max(0, sourceDurationSec - 0.05));
}

/** Extract a single representative frame as webp. */
export async function extractRepresentativeFrame(options: {
  sourcePath: string;
  timestampUs: number | null;
  outputPath: string;
  sourceDurationUs?: number | null;
}): Promise<FrameExtractionResult> {
  const seekSec = clampSeek(
    options.sourceDurationUs ? options.sourceDurationUs / 1_000_000 : null,
    (options.timestampUs ?? 0) / 1_000_000,
  );
  try {
    await execFileAsync("ffmpeg", [
      "-y",
      "-ss", seekSec.toFixed(6),
      "-i", path.resolve(options.sourcePath),
      "-vframes", "1",
      "-vf", `scale=-2:${FRAME_HEIGHT}`,
      path.resolve(options.outputPath),
    ]);
    if (!fs.existsSync(options.outputPath) || fs.statSync(options.outputPath).size === 0) {
      return { file: null, warning: `ffmpeg produced no frame for ${path.basename(options.sourcePath)}` };
    }
    return { file: path.basename(options.outputPath), warning: null };
  } catch (error) {
    return {
      file: null,
      warning: `frame extraction failed for ${path.basename(options.sourcePath)}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
}

/** Extract a small horizontal filmstrip for the candidate range. */
export async function extractFilmstrip(options: {
  sourcePath: string;
  srcInUs: number;
  srcOutUs: number;
  outputPath: string;
  sourceDurationUs?: number | null;
}): Promise<FrameExtractionResult> {
  const durationUs = options.srcOutUs - options.srcInUs;
  if (durationUs <= 0) return { file: null, warning: "candidate range is empty; filmstrip skipped" };
  const tmpDir = path.join(path.dirname(options.outputPath), `.tmp-filmstrip-${path.basename(options.outputPath, ".webp")}`);
  fs.mkdirSync(tmpDir, { recursive: true });
  const tiles: string[] = [];
  try {
    const step = durationUs / FILMSTRIP_TILES;
    for (let i = 0; i < FILMSTRIP_TILES; i += 1) {
      const seekUs = options.srcInUs + step * (i + 0.5);
      const tilePath = path.join(tmpDir, `tile-${i}.png`);
      const seekSec = clampSeek(
        options.sourceDurationUs ? options.sourceDurationUs / 1_000_000 : null,
        seekUs / 1_000_000,
      );
      try {
        await execFileAsync("ffmpeg", [
          "-y",
          "-ss", seekSec.toFixed(6),
          "-i", path.resolve(options.sourcePath),
          "-vframes", "1",
          "-vf", `scale=${FILMSTRIP_TILE_WIDTH}:-2`,
          tilePath,
        ]);
        if (fs.existsSync(tilePath) && fs.statSync(tilePath).size > 0) tiles.push(tilePath);
      } catch {
        // Individual tile failures degrade the strip; keep going.
      }
    }
    if (tiles.length === 0) {
      return { file: null, warning: `filmstrip extraction failed for ${path.basename(options.sourcePath)}` };
    }
    if (tiles.length === 1) {
      fs.copyFileSync(tiles[0], options.outputPath);
    } else {
      const inputs = tiles.flatMap((tile) => ["-i", tile]);
      const filter =
        `${tiles.map((_, i) => `[${i}:v]scale=${FILMSTRIP_TILE_WIDTH}:-2,pad=iw+4:ih+4:2:2:black[p${i}]`).join(";")};` +
        `${tiles.map((_, i) => `[p${i}]`).join("")}hstack=inputs=${tiles.length}`;
      await execFileAsync("ffmpeg", [
        "-y",
        ...inputs,
        "-filter_complex", filter,
        "-frames:v", "1",
        path.resolve(options.outputPath),
      ]);
    }
    if (!fs.existsSync(options.outputPath) || fs.statSync(options.outputPath).size === 0) {
      return { file: null, warning: `filmstrip assembly failed for ${path.basename(options.sourcePath)}` };
    }
    return { file: path.basename(options.outputPath), warning: null };
  } catch (error) {
    return {
      file: null,
      warning: `filmstrip extraction failed for ${path.basename(options.sourcePath)}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

/** Render a waveform image for an audio-bearing source. */
export async function extractWaveform(options: {
  sourcePath: string;
  srcInUs: number | null;
  srcOutUs: number | null;
  outputPath: string;
}): Promise<FrameExtractionResult> {
  try {
    if (options.srcInUs !== null && options.srcOutUs !== null && options.srcOutUs > options.srcInUs) {
      const seekSec = options.srcInUs / 1_000_000;
      const durationSec = (options.srcOutUs - options.srcInUs) / 1_000_000;
      await execFileAsync("ffmpeg", [
        "-y",
        "-ss", seekSec.toFixed(6),
        "-t", durationSec.toFixed(6),
        "-i", path.resolve(options.sourcePath),
        "-filter_complex",
        `aformat=channel_layouts=mono,showwavespic=s=${WAVEFORM_SIZE}:colors=0x3388ff`,
        "-frames:v", "1",
        path.resolve(options.outputPath),
      ]);
    } else {
      await execFileAsync("ffmpeg", [
        "-y",
        "-i", path.resolve(options.sourcePath),
        "-filter_complex",
        `aformat=channel_layouts=mono,showwavespic=s=${WAVEFORM_SIZE}:colors=0x3388ff`,
        "-frames:v", "1",
        path.resolve(options.outputPath),
      ]);
    }
    if (!fs.existsSync(options.outputPath) || fs.statSync(options.outputPath).size === 0) {
      return { file: null, warning: `waveform rendering produced no image for ${path.basename(options.sourcePath)}` };
    }
    return { file: path.basename(options.outputPath), warning: null };
  } catch (error) {
    return {
      file: null,
      warning: `waveform rendering failed for ${path.basename(options.sourcePath)}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
}

/** Copy/convert a still image into the projection frames dir. */
export async function importStillImage(options: {
  sourcePath: string;
  outputPath: string;
}): Promise<FrameExtractionResult> {
  try {
    await execFileAsync("ffmpeg", [
      "-y",
      "-i", path.resolve(options.sourcePath),
      "-vf", `scale='min(${FRAME_HEIGHT * 4},iw)':-2`,
      path.resolve(options.outputPath),
    ]);
    if (fs.existsSync(options.outputPath) && fs.statSync(options.outputPath).size > 0) {
      return { file: path.basename(options.outputPath), warning: null };
    }
    return { file: null, warning: `still image conversion produced no output for ${path.basename(options.sourcePath)}` };
  } catch (error) {
    return {
      file: null,
      warning: `still image conversion failed for ${path.basename(options.sourcePath)}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
}

export function resolveSourceFilePath(options: {
  sourceMapEntry: { local_source_path: string | null; exists: boolean } | undefined;
}): string | null {
  const entry = options.sourceMapEntry;
  if (!entry || !entry.exists || !entry.local_source_path) return null;
  return entry.local_source_path;
}

/** Deterministic frame file naming: beat-01-primary.webp etc. */
export function frameFileName(beatIndex: number, kind: "primary" | "fallback" | "waveform", slot: number): string {
  const padded = String(beatIndex).padStart(2, "0");
  if (kind === "primary") return `beat-${padded}-primary.webp`;
  if (kind === "waveform") return `beat-${padded}-waveform.webp`;
  return `beat-${padded}-fallback-${slot}.webp`;
}

export function describeFrameProvenance(plan: RepresentativeFramePlan, binding: ResolvedCandidateBinding | null): string {
  const parts = [
    plan.basis_detail,
    binding?.asset_id ? `asset ${binding.asset_id}` : null,
    binding?.asset_hash ? `asset hash ${binding.asset_hash}` : null,
  ].filter((value): value is string => Boolean(value));
  return parts.join(" · ");
}
