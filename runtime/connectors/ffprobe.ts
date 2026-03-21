/**
 * ffprobe connector — inspects source media, computes deterministic asset IDs,
 * and produces assets.json items.
 *
 * Per milestone-2-design.md §Connector Design > 1. ffmpeg / ffprobe Connector
 */

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

// ── Types ──────────────────────────────────────────────────────────

export interface FfprobeStream {
  index: number;
  codec_type: string;
  codec_name: string;
  width?: number;
  height?: number;
  avg_frame_rate?: string;
  sample_rate?: string;
  channels?: number;
  [key: string]: unknown;
}

export interface FfprobeFormat {
  filename: string;
  duration?: string;
  size?: string;
  [key: string]: unknown;
}

export interface FfprobeOutput {
  streams: FfprobeStream[];
  format: FfprobeFormat;
}

export interface VideoStream {
  width: number;
  height: number;
  fps_num: number;
  fps_den: number;
  codec: string;
}

export interface AudioStream {
  sample_rate: number;
  channels: number;
  codec: string;
}

export interface AssetItem {
  asset_id: string;
  filename: string;
  duration_us: number;
  has_transcript: boolean;
  transcript_ref: string | null;
  segments: number;
  segment_ids: string[];
  quality_flags: string[];
  tags: string[];
  source_fingerprint: string;
  source_locator?: string;
  video_stream?: VideoStream;
  audio_stream?: AudioStream;
  contact_sheet_ids: string[];
  poster_path?: string;
  waveform_path?: string;
  role_guess?: string;
  analysis_status: string;
  confidence?: {
    score: number;
    source: string;
    status: string;
  };
  provenance?: {
    stage: string;
    method: string;
    connector_version: string;
    policy_hash: string;
    request_hash: string;
    ffmpeg_version?: string;
  };
}

// ── Constants ──────────────────────────────────────────────────────

export const CONNECTOR_VERSION = "ffprobe-v2.0.0";
const FINGERPRINT_CHUNK_SIZE = 16 * 1024 * 1024; // 16 MB

// ── Helpers ────────────────────────────────────────────────────────

function execFilePromise(
  cmd: string,
  args: string[],
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 50 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(err);
      resolve({ stdout, stderr });
    });
  });
}

/**
 * Parse a fractional frame rate string like "30/1" or "30000/1001" into
 * reduced numerator/denominator.
 */
export function parseFps(avgFrameRate: string): { fps_num: number; fps_den: number } {
  const parts = avgFrameRate.split("/");
  let num = parseInt(parts[0], 10);
  let den = parts.length > 1 ? parseInt(parts[1], 10) : 1;
  if (!num || !den || den === 0) return { fps_num: 30, fps_den: 1 };

  // Reduce fraction
  const g = gcd(Math.abs(num), Math.abs(den));
  num = num / g;
  den = den / g;
  return { fps_num: num, fps_den: den };
}

function gcd(a: number, b: number): number {
  while (b !== 0) {
    const t = b;
    b = a % b;
    a = t;
  }
  return a;
}

/**
 * Compute source_fingerprint: sha1(first_16mb + file_size + duration_us + normalized_stream_signature)
 *
 * Path is intentionally excluded so file moves do not change identity.
 */
export async function computeFingerprint(
  filePath: string,
  durationUs: number,
  streams: FfprobeStream[],
): Promise<string> {
  const stat = fs.statSync(filePath);
  const fileSize = stat.size;

  // Read first 16MB
  const fd = fs.openSync(filePath, "r");
  const chunkSize = Math.min(FINGERPRINT_CHUNK_SIZE, fileSize);
  const buffer = Buffer.alloc(chunkSize);
  fs.readSync(fd, buffer, 0, chunkSize, 0);
  fs.closeSync(fd);

  // Normalized stream signature: sorted codec_type:codec_name pairs
  const streamSig = streams
    .map((s) => `${s.codec_type}:${s.codec_name}`)
    .sort()
    .join("|");

  const hash = createHash("sha1");
  hash.update(buffer);
  hash.update(String(fileSize));
  hash.update(String(durationUs));
  hash.update(streamSig);

  return hash.digest("hex");
}

/**
 * Generate asset_id from fingerprint: AST_<fingerprint[0:8].upper()>
 * If a collision is detected (same prefix maps to different fingerprint),
 * extend the suffix by 2 hex chars until unique.
 */
export function generateAssetId(
  fingerprint: string,
  existingIds?: Map<string, string>,
): string {
  const BASE_LEN = 8;
  let len = BASE_LEN;
  while (len <= fingerprint.length) {
    const candidate = `AST_${fingerprint.substring(0, len).toUpperCase()}`;
    if (!existingIds) return candidate;
    const existing = existingIds.get(candidate);
    if (!existing || existing === fingerprint) {
      existingIds.set(candidate, fingerprint);
      return candidate;
    }
    // Collision: extend by 2
    len += 2;
  }
  // Exhausted fingerprint length — use full fingerprint
  return `AST_${fingerprint.toUpperCase()}`;
}

// ── Main ───────────────────────────────────────────────────────────

/**
 * Run ffprobe on a source file and return parsed JSON output.
 */
export async function runFfprobe(filePath: string): Promise<FfprobeOutput> {
  const absPath = path.resolve(filePath);
  const { stdout } = await execFilePromise("ffprobe", [
    "-v", "quiet",
    "-show_format",
    "-show_streams",
    "-print_format", "json",
    absPath,
  ]);
  return JSON.parse(stdout) as FfprobeOutput;
}

/**
 * Extract duration in microseconds from ffprobe output.
 * Prefers format.duration, falls back to first video/audio stream duration.
 */
export function extractDurationUs(probe: FfprobeOutput): number {
  if (probe.format.duration) {
    return Math.round(parseFloat(probe.format.duration) * 1_000_000);
  }
  for (const s of probe.streams) {
    if ((s as Record<string, unknown>)["duration"]) {
      return Math.round(
        parseFloat(String((s as Record<string, unknown>)["duration"])) * 1_000_000,
      );
    }
  }
  return 0;
}

/**
 * Extract video stream info from ffprobe output.
 */
export function extractVideoStream(probe: FfprobeOutput): VideoStream | undefined {
  const vs = probe.streams.find((s) => s.codec_type === "video");
  if (!vs || !vs.width || !vs.height) return undefined;

  const fps = parseFps(vs.avg_frame_rate ?? "30/1");
  return {
    width: vs.width,
    height: vs.height,
    fps_num: fps.fps_num,
    fps_den: fps.fps_den,
    codec: vs.codec_name,
  };
}

/**
 * Extract audio stream info from ffprobe output.
 */
export function extractAudioStream(probe: FfprobeOutput): AudioStream | undefined {
  const as_ = probe.streams.find((s) => s.codec_type === "audio");
  if (!as_) return undefined;
  return {
    sample_rate: parseInt(as_.sample_rate ?? "0", 10),
    channels: as_.channels ?? 0,
    codec: as_.codec_name,
  };
}

/**
 * Get ffmpeg version string for provenance records.
 */
export async function getFfmpegVersion(): Promise<string> {
  try {
    const { stdout } = await execFilePromise("ffmpeg", ["-version"]);
    const firstLine = stdout.split("\n")[0] ?? "";
    const match = firstLine.match(/ffmpeg version (\S+)/);
    return match ? match[1] : "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * Compute a policy hash for provenance tracking.
 */
export function computePolicyHash(policy: Record<string, unknown>): string {
  const hash = createHash("sha256");
  hash.update(JSON.stringify(policy, null, 0));
  return hash.digest("hex").substring(0, 16);
}

/**
 * Compute a request hash for cache/provenance tracking.
 */
export function computeRequestHash(params: Record<string, unknown>): string {
  const hash = createHash("sha256");
  hash.update(JSON.stringify(params, null, 0));
  return hash.digest("hex").substring(0, 16);
}

/**
 * Ingest a single source file and return an AssetItem.
 */
export async function ingestAsset(
  filePath: string,
  opts: {
    projectRoot?: string;
    policyHash?: string;
    ffmpegVersion?: string;
  } = {},
): Promise<AssetItem> {
  const absPath = path.resolve(filePath);
  const probe = await runFfprobe(absPath);
  const durationUs = extractDurationUs(probe);
  const videoStream = extractVideoStream(probe);
  const audioStream = extractAudioStream(probe);
  const fingerprint = await computeFingerprint(absPath, durationUs, probe.streams);
  const assetId = generateAssetId(fingerprint);

  // Compute source locator (project-relative if under project root)
  let sourceLocator: string | undefined;
  if (opts.projectRoot) {
    const projRoot = path.resolve(opts.projectRoot);
    // Boundary check: ensure path is under projRoot with separator boundary
    // (prevents /proj-evil matching /proj)
    const projRootWithSep = projRoot.endsWith(path.sep)
      ? projRoot
      : projRoot + path.sep;
    if (absPath.startsWith(projRootWithSep) || absPath === projRoot) {
      const relative = path.relative(projRoot, absPath);
      // Reject relative paths that escape the project (../) or are absolute
      if (!relative.startsWith("..") && !path.isAbsolute(relative)) {
        sourceLocator = relative;
      }
    }
  }

  const policyHash = opts.policyHash ?? "none";
  const ffmpegVersion = opts.ffmpegVersion ?? "unknown";
  const requestHash = computeRequestHash({
    connector_version: CONNECTOR_VERSION,
    ffmpeg_version: ffmpegVersion,
    file_fingerprint: fingerprint,
  });

  return {
    asset_id: assetId,
    filename: path.basename(absPath),
    duration_us: durationUs,
    has_transcript: false,
    transcript_ref: audioStream ? `TR_${assetId}` : null,
    segments: 0,
    segment_ids: [],
    quality_flags: [],
    tags: [],
    source_fingerprint: fingerprint,
    source_locator: sourceLocator,
    video_stream: videoStream,
    audio_stream: audioStream,
    contact_sheet_ids: [],
    analysis_status: "pending",
    confidence: {
      score: 1.0,
      source: "ffprobe",
      status: "ready",
    },
    provenance: {
      stage: "ingest",
      method: "ffprobe",
      connector_version: CONNECTOR_VERSION,
      policy_hash: policyHash,
      request_hash: requestHash,
      ffmpeg_version: ffmpegVersion,
    },
  };
}
