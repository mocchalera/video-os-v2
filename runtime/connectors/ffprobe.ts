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
import type { MediaKind } from "../media/media-kind-registry.js";
import { classifyMediaKind } from "../media/media-kind-registry.js";
import { sha256FileHex } from "../source-content-identity.js";

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
  r_frame_rate?: string;
  tags?: { rotate?: string; [key: string]: unknown };
  side_data_list?: Array<{ rotation?: number; [key: string]: unknown }>;
  pix_fmt?: string;
  color_range?: string;
  color_space?: string;
  color_transfer?: string;
  color_primaries?: string;
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
  /** New ingest producers always emit this; optional only for legacy artifact compatibility. */
  media_kind?: MediaKind;
  display_name?: string;
  duration_us: number;
  duration_semantics?: "physical_media_duration" | "single_frame_zero_duration";
  has_transcript: boolean;
  transcript_ref: string | null;
  segments: number;
  segment_ids: string[];
  quality_flags: string[];
  tags: string[];
  source_fingerprint: string;
  source_locator?: string;
  video_stream?: VideoStream;
  frame_rate_mode?: "cfr" | "vfr" | "audio_only" | "still_image" | "unknown";
  rotation?: 0 | 90 | 180 | 270 | null;
  audio_stream?: AudioStream;
  contact_sheet_ids: string[];
  poster_path?: string;
  waveform_path?: string;
  role_guess?: string;
  analysis_status: string;
  source_content_sha256?: string;
  source_size_bytes?: number;
  source_mtime_ms?: number;
  still_image?: StillImageMetadata;
  image_sequence?: ImageSequenceMetadata;
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
    source_content_sha256?: string;
  };
}

export interface StillImageMetadata {
  normalization_producer: "ffmpeg-still-normalizer";
  normalization_producer_version: "1";
  normalized_frame_path: string;
  normalized_frame_content_sha256: string;
  source_width: number;
  source_height: number;
  decoded_width: number;
  decoded_height: number;
  source_pixel_format: string | null;
  normalized_pixel_format: string;
  source_has_alpha: boolean | null;
  normalized_has_alpha: boolean;
  source_rotation: 0 | 90 | 180 | 270 | null;
  orientation_normalization: {
    status: "applied" | "not_needed" | "unknown";
    method: "ffmpeg_explicit_transform" | "none" | "unknown";
    transform: "transpose_clockwise" | "transpose_counterclockwise" | "rotate_180" | "none" | "unknown";
    orientation_source: "display_matrix_or_tag" | "exif" | "none" | "unknown";
  };
  color_profile: {
    icc_profile: "present" | "absent" | "unknown";
    color_range: string | null;
    color_space: string | null;
    color_transfer: string | null;
    color_primaries: string | null;
  };
}

export interface ImageSequenceMetadata {
  grouping_producer: "image-sequence-grouper";
  grouping_producer_version: "1";
  normalization_producer: "ffmpeg-image-sequence-normalizer";
  normalization_producer_version: "1";
  pattern_basename: string;
  start_number: number;
  end_number: number;
  frame_count: number;
  padding: number;
  fps_num: number;
  fps_den: number;
  frame_set_content_sha256: string;
  frame_content_sha256: string[];
  analysis_proxy_path: string;
  analysis_proxy_content_sha256: string;
  analysis_proxy_frame_count: number;
  source_width: number;
  source_height: number;
  decoded_width: number;
  decoded_height: number;
  normalized_pixel_format: string;
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

export function extractFrameRateMode(probe: FfprobeOutput): "cfr" | "vfr" | "audio_only" | "unknown" {
  const stream = probe.streams.find((item) => item.codec_type === "video");
  if (!stream && probe.streams.some((item) => item.codec_type === "audio")) return "audio_only";
  if (!stream?.avg_frame_rate || !stream.r_frame_rate) return "unknown";
  const average = rationalValue(stream.avg_frame_rate);
  const real = rationalValue(stream.r_frame_rate);
  if (average === null || real === null) return "unknown";
  return Math.abs(average - real) < 1e-9 ? "cfr" : "vfr";
}

export function extractRotation(probe: FfprobeOutput): 0 | 90 | 180 | 270 | null {
  const stream = probe.streams.find((item) => item.codec_type === "video");
  if (!stream) return null;
  const raw = stream.side_data_list?.find((item) => typeof item.rotation === "number")?.rotation
    ?? (stream.tags?.rotate !== undefined ? Number(stream.tags.rotate) : undefined);
  if (raw === undefined || !Number.isFinite(raw)) return null;
  const normalized = ((Math.round(raw) % 360) + 360) % 360;
  return normalized === 0 || normalized === 90 || normalized === 180 || normalized === 270
    ? normalized
    : null;
}

function rationalValue(value: string): number | null {
  const [numeratorRaw, denominatorRaw = "1"] = value.split("/");
  const numerator = Number(numeratorRaw);
  const denominator = Number(denominatorRaw);
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) return null;
  return numerator / denominator;
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
    mediaKind?: MediaKind;
    sourceContentSha256?: string;
    sourceSizeBytes?: number;
    sourceMtimeMs?: number;
    /** Deterministic test seam for simulating replacement after frame decode. */
    afterStillImageDecode?: () => void | Promise<void>;
  } = {},
): Promise<AssetItem> {
  const absPath = path.resolve(filePath);
  const ingestStartIdentity = readLiveSourceIdentity(absPath);
  assertDiscoveryIdentityMatches(opts, ingestStartIdentity);
  const probe = await runFfprobe(absPath);
  const mediaKind = opts.mediaKind ?? classifyMediaKind(absPath).kind;
  const probedDurationUs = extractDurationUs(probe);
  const durationUs = mediaKind === "image" ? 0 : probedDurationUs;
  const videoStream = extractVideoStream(probe);
  const frameRateMode = extractFrameRateMode(probe);
  const probedRotation = extractRotation(probe);
  const exifRotation = mediaKind === "image" ? extractJpegExifRotation(absPath) : null;
  const rotation = probedRotation ?? exifRotation;
  const orientationSource = probedRotation !== null
    ? "display_matrix_or_tag" as const
    : exifRotation !== null
      ? "exif" as const
      : "unknown" as const;
  const audioStream = extractAudioStream(probe);
  if (mediaKind === "image" && !videoStream) {
    throw new Error("still_image_decode_failed:no_decodable_video_frame");
  }
  const fingerprint = await computeFingerprint(absPath, durationUs, probe.streams);
  const assetId = generateAssetId(fingerprint);
  let stillImage: StillImageMetadata | undefined;
  if (mediaKind === "image") {
    try {
      stillImage = await decodeStillImageFrame({
        sourcePath: absPath,
        projectRoot: opts.projectRoot,
        assetId,
        sourceRotation: rotation,
        orientationSource,
        sourceProbe: probe,
      });
      await opts.afterStillImageDecode?.();
      const ingestEndIdentity = readLiveSourceIdentity(absPath);
      if (!sameSourceIdentity(ingestStartIdentity, ingestEndIdentity)) {
        throw new Error("still_image_source_changed_during_ingest");
      }
    } catch (error) {
      removeNormalizedStillFrame(opts.projectRoot, assetId);
      throw error;
    }
  }

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
    media_kind: mediaKind,
    duration_us: durationUs,
    duration_semantics: mediaKind === "image" ? "single_frame_zero_duration" : "physical_media_duration",
    has_transcript: false,
    transcript_ref: audioStream ? `TR_${assetId}` : null,
    segments: 0,
    segment_ids: [],
    quality_flags: [],
    tags: [],
    source_fingerprint: fingerprint,
    source_locator: sourceLocator,
    video_stream: videoStream,
    frame_rate_mode: mediaKind === "image" ? "still_image" : frameRateMode,
    rotation,
    audio_stream: audioStream,
    contact_sheet_ids: [],
    analysis_status: "pending",
    source_content_sha256: ingestStartIdentity.sha256,
    source_size_bytes: ingestStartIdentity.sizeBytes,
    source_mtime_ms: ingestStartIdentity.mtimeMs,
    ...(stillImage ? { still_image: stillImage } : {}),
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
      source_content_sha256: ingestStartIdentity.sha256,
    },
  };
}

interface LiveSourceIdentity {
  sha256: string;
  sizeBytes: number;
  mtimeMs: number;
}

function readLiveSourceIdentity(filePath: string): LiveSourceIdentity {
  const before = fs.statSync(filePath);
  const sha256 = sha256FileHex(filePath);
  const after = fs.statSync(filePath);
  const beforeMtimeMs = Math.round(before.mtimeMs);
  const afterMtimeMs = Math.round(after.mtimeMs);
  if (before.size !== after.size || beforeMtimeMs !== afterMtimeMs) {
    throw new Error("source_changed_during_identity_read");
  }
  return { sha256, sizeBytes: after.size, mtimeMs: afterMtimeMs };
}

function assertDiscoveryIdentityMatches(
  expected: {
    sourceContentSha256?: string;
    sourceSizeBytes?: number;
    sourceMtimeMs?: number;
  },
  live: LiveSourceIdentity,
): void {
  if (
    (expected.sourceContentSha256 !== undefined && expected.sourceContentSha256 !== live.sha256) ||
    (expected.sourceSizeBytes !== undefined && expected.sourceSizeBytes !== live.sizeBytes) ||
    (expected.sourceMtimeMs !== undefined && Math.round(expected.sourceMtimeMs) !== live.mtimeMs)
  ) {
    throw new Error("source_identity_changed_since_discovery");
  }
}

function sameSourceIdentity(a: LiveSourceIdentity, b: LiveSourceIdentity): boolean {
  return a.sha256 === b.sha256 && a.sizeBytes === b.sizeBytes && a.mtimeMs === b.mtimeMs;
}

function removeNormalizedStillFrame(projectRoot: string | undefined, assetId: string): void {
  if (!projectRoot) return;
  const frameDir = path.join(path.resolve(projectRoot), "03_analysis", "still_frames", assetId);
  fs.rmSync(frameDir, { recursive: true, force: true });
}

async function decodeStillImageFrame(options: {
  sourcePath: string;
  projectRoot?: string;
  assetId: string;
  sourceRotation: 0 | 90 | 180 | 270 | null;
  orientationSource: "display_matrix_or_tag" | "exif" | "none" | "unknown";
  sourceProbe: FfprobeOutput;
}): Promise<StillImageMetadata> {
  if (!options.projectRoot) {
    throw new Error("still_image_decode_failed:project_root_required_for_normalized_frame");
  }
  const relativePath = path.posix.join("still_frames", options.assetId, "frame_0.png");
  const outputPath = path.join(path.resolve(options.projectRoot), "03_analysis", ...relativePath.split("/"));
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  try {
    const sourceStream = options.sourceProbe.streams.find((stream) => stream.codec_type === "video");
    if (!sourceStream?.width || !sourceStream.height) throw new Error("source_frame_dimensions_missing");
    const orientation = resolveOrientationNormalization(options.sourceRotation);
    const orientationArgs = orientation.filter ? ["-vf", orientation.filter] : [];
    await execFilePromise("ffmpeg", [
      "-v", "error",
      "-y",
      "-noautorotate",
      "-i", options.sourcePath,
      "-map", "0:v:0",
      "-frames:v", "1",
      ...orientationArgs,
      outputPath,
    ]);
    const stat = fs.statSync(outputPath);
    if (!stat.isFile() || stat.size <= 0) throw new Error("normalized_frame_missing_or_empty");
    const normalizedProbe = await runFfprobe(outputPath);
    const normalizedStream = normalizedProbe.streams.find((stream) => stream.codec_type === "video");
    if (!normalizedStream?.width || !normalizedStream.height || !normalizedStream.pix_fmt) {
      throw new Error("normalized_frame_metadata_missing");
    }
    return {
      normalization_producer: "ffmpeg-still-normalizer",
      normalization_producer_version: "1",
      normalized_frame_path: relativePath,
      normalized_frame_content_sha256: sha256FileHex(outputPath),
      source_width: sourceStream.width,
      source_height: sourceStream.height,
      decoded_width: normalizedStream.width,
      decoded_height: normalizedStream.height,
      source_pixel_format: sourceStream.pix_fmt ?? null,
      normalized_pixel_format: normalizedStream.pix_fmt,
      source_has_alpha: sourceStream.pix_fmt ? pixelFormatHasAlpha(sourceStream.pix_fmt) : null,
      normalized_has_alpha: pixelFormatHasAlpha(normalizedStream.pix_fmt) ?? false,
      source_rotation: options.sourceRotation,
      orientation_normalization: {
        status: orientation.status,
        method: orientation.method,
        transform: orientation.transform,
        orientation_source: options.orientationSource,
      },
      color_profile: {
        icc_profile: iccProfileStatus(sourceStream),
        color_range: sourceStream?.color_range ?? null,
        color_space: sourceStream?.color_space ?? null,
        color_transfer: sourceStream?.color_transfer ?? null,
        color_primaries: sourceStream?.color_primaries ?? null,
      },
    };
  } catch (error) {
    fs.rmSync(outputPath, { force: true });
    throw new Error(`still_image_decode_failed:${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Reads the orientation tag from a JPEG EXIF APP1 block without adding an image dependency. */
export function extractJpegExifRotation(filePath: string): 0 | 90 | 180 | 270 | null {
  let bytes: Buffer;
  try {
    const size = Math.min(fs.statSync(filePath).size, 256 * 1024);
    const fd = fs.openSync(filePath, "r");
    bytes = Buffer.alloc(size);
    fs.readSync(fd, bytes, 0, size, 0);
    fs.closeSync(fd);
  } catch {
    return null;
  }
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) break;
    const marker = bytes[offset + 1];
    if (marker === 0xda || marker === 0xd9) break;
    const length = bytes.readUInt16BE(offset + 2);
    if (length < 2 || offset + 2 + length > bytes.length) break;
    if (marker === 0xe1) {
      const payloadStart = offset + 4;
      if (bytes.subarray(payloadStart, payloadStart + 6).toString("binary") === "Exif\0\0") {
        const tiff = payloadStart + 6;
        const endian = bytes.subarray(tiff, tiff + 2).toString("ascii");
        const little = endian === "II";
        if (!little && endian !== "MM") return null;
        const read16 = (at: number): number => little ? bytes.readUInt16LE(at) : bytes.readUInt16BE(at);
        const read32 = (at: number): number => little ? bytes.readUInt32LE(at) : bytes.readUInt32BE(at);
        if (read16(tiff + 2) !== 42) return null;
        const ifd = tiff + read32(tiff + 4);
        if (ifd + 2 > bytes.length) return null;
        const count = read16(ifd);
        for (let index = 0; index < count; index++) {
          const entry = ifd + 2 + index * 12;
          if (entry + 12 > bytes.length) return null;
          if (read16(entry) !== 0x0112 || read16(entry + 2) !== 3 || read32(entry + 4) !== 1) continue;
          const orientation = read16(entry + 8);
          return orientation === 1 ? 0 : orientation === 3 ? 180 : orientation === 6 ? 90 : orientation === 8 ? 270 : null;
        }
      }
    }
    offset += 2 + length;
  }
  return null;
}

function pixelFormatHasAlpha(pixelFormat: string): boolean | null {
  if (pixelFormat === "pal8") return null;
  return /^(?:rgba|bgra|argb|abgr|ya\d*|yuva|gbrap)/i.test(pixelFormat);
}

function resolveOrientationNormalization(rotation: 0 | 90 | 180 | 270 | null): {
  status: "applied" | "not_needed" | "unknown";
  method: "ffmpeg_explicit_transform" | "none" | "unknown";
  transform: "transpose_clockwise" | "transpose_counterclockwise" | "rotate_180" | "none" | "unknown";
  filter?: string;
} {
  if (rotation === 90) return { status: "applied", method: "ffmpeg_explicit_transform", transform: "transpose_clockwise", filter: "transpose=clock" };
  if (rotation === 270) return { status: "applied", method: "ffmpeg_explicit_transform", transform: "transpose_counterclockwise", filter: "transpose=cclock" };
  if (rotation === 180) return { status: "applied", method: "ffmpeg_explicit_transform", transform: "rotate_180", filter: "hflip,vflip" };
  if (rotation === 0) return { status: "not_needed", method: "none", transform: "none" };
  return { status: "unknown", method: "unknown", transform: "unknown" };
}

function iccProfileStatus(stream: FfprobeStream | undefined): "present" | "absent" | "unknown" {
  if (!stream) return "unknown";
  const sideData = stream.side_data_list;
  if (!Array.isArray(sideData)) return "unknown";
  return sideData.some((entry) => String(entry.side_data_type ?? "").toLowerCase().includes("icc"))
    ? "present"
    : "absent";
}
