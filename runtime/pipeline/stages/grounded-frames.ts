import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { SourceContentIdentityCache } from "../../source-content-identity.js";
import { atomicWriteJson } from "./_util.js";

export const GROUNDED_FRAME_CACHE_VERSION = "grounded-frame-cache-v2";
export const GROUNDED_FRAME_PRODUCER_VERSION = "ffmpeg-single-frame-v2";

export type FrameExecFileLike = (
  command: string,
  args: string[],
  options: { maxBuffer: number },
  callback: (error: Error | null, stdout: string, stderr: string) => void,
) => void;

export interface GroundedFrameBundle {
  framePaths: string[];
  sampleTimestampsUs: number[];
  requestedSampleTimestampsUs: number[];
  cacheHits: number;
  failures: string[];
  cacheVersion: string;
  producerVersion: string;
  sourceContentSha256?: string;
  segmentStartUs: number;
  segmentEndUs: number;
  cacheDecision: "accepted" | "refreshed" | "unavailable";
  cacheDecisionReasons: string[];
}

interface GroundedFrameManifest {
  version: string;
  producer_version: string;
  source_path: string;
  source_size: number;
  source_mtime_ms: number;
  source_content_sha256: string;
  asset_id: string;
  segment_id: string;
  segment_start_us: number;
  segment_end_us: number;
  requested_sample_timestamps_us: number[];
  frames: Array<{ timestamp_us: number; path: string; size_bytes: number }>;
  extraction_failures: string[];
}

export interface ExtractGroundedFramesOptions {
  sourcePath: string | undefined;
  outputDir: string;
  namespace: "vlm_frames" | "peak_precision_frames";
  assetId: string;
  segmentId: string;
  segmentStartUs: number;
  segmentEndUs: number;
  timestampsUs: number[];
  sourceContentSha256?: string;
  sourceIdentityCache?: SourceContentIdentityCache;
  execFileImpl?: FrameExecFileLike;
}

export type InspectGroundedFrameCacheOptions = Omit<ExtractGroundedFramesOptions, "execFileImpl"> & {
  requiredTimestampsUs?: number[];
};

export interface GroundedFrameCacheInspection {
  accepted: boolean;
  reasons: string[];
}

export function isVerifiedImagePath(filePath: string): boolean {
  if (!path.isAbsolute(filePath)) return false;
  try {
    const stat = fs.statSync(filePath);
    return stat.isFile() && stat.size > 0;
  } catch {
    return false;
  }
}

export function verifyImagePaths(framePaths: string[]): string[] {
  return framePaths.filter(isVerifiedImagePath);
}

export function inspectGroundedFrameCache(
  options: InspectGroundedFrameCacheOptions,
): GroundedFrameCacheInspection {
  const requestedSampleTimestampsUs = normalizeTimestamps(options.timestampsUs);
  const requiredTimestampsUs = normalizeTimestamps(
    options.requiredTimestampsUs ?? requestedSampleTimestampsUs,
  );
  if (!options.sourcePath) return { accepted: false, reasons: ["source_file_not_mapped"] };
  const sourcePath = path.resolve(options.sourcePath);
  let identity;
  try {
    const sourceStat = fs.statSync(sourcePath);
    if (!sourceStat.isFile() || sourceStat.size <= 0) {
      return { accepted: false, reasons: ["source_file_missing_or_empty"] };
    }
    identity = (options.sourceIdentityCache ?? new SourceContentIdentityCache()).resolve(sourcePath);
  } catch (error) {
    return { accepted: false, reasons: [`source_content_hash_failed:${errorMessage(error)}`] };
  }
  if (options.sourceContentSha256 && options.sourceContentSha256 !== identity.sha256) {
    return { accepted: false, reasons: ["source_content_mismatch"] };
  }
  const frameDir = frameCacheDir(options);
  const manifest = readManifest(path.join(frameDir, "manifest.json"));
  const reasons = frameCacheMismatchReasons(manifest, {
    sourcePath,
    sourceSize: identity.sizeBytes,
    sourceMtimeMs: identity.mtimeMs,
    sourceContentSha256: identity.sha256,
    assetId: options.assetId,
    segmentId: options.segmentId,
    segmentStartUs: options.segmentStartUs,
    segmentEndUs: options.segmentEndUs,
    requestedSampleTimestampsUs,
  });
  if (reasons.length > 0 || !manifest) return { accepted: false, reasons };
  for (const timestampUs of requiredTimestampsUs) {
    const expectedPath = path.resolve(frameDir, `${timestampUs}.jpg`);
    const frame = manifest.frames.find((candidate) => candidate.timestamp_us === timestampUs);
    if (!frame || path.resolve(options.outputDir, frame.path) !== expectedPath || !isVerifiedImagePath(expectedPath)) {
      reasons.push(`verified_frame_missing:${timestampUs}`);
    }
  }
  return { accepted: reasons.length === 0, reasons: reasons.length === 0 ? ["identity_match"] : reasons };
}

export async function extractGroundedFrames(
  options: ExtractGroundedFramesOptions,
): Promise<GroundedFrameBundle> {
  const requestedSampleTimestampsUs = normalizeTimestamps(options.timestampsUs);
  const empty = (failure: string): GroundedFrameBundle => ({
    framePaths: [],
    sampleTimestampsUs: [],
    requestedSampleTimestampsUs,
    cacheHits: 0,
    failures: [failure],
    cacheVersion: GROUNDED_FRAME_CACHE_VERSION,
    producerVersion: GROUNDED_FRAME_PRODUCER_VERSION,
    ...(options.sourceContentSha256
      ? { sourceContentSha256: options.sourceContentSha256 }
      : {}),
    segmentStartUs: options.segmentStartUs,
    segmentEndUs: options.segmentEndUs,
    cacheDecision: "unavailable",
    cacheDecisionReasons: [failure],
  });

  if (requestedSampleTimestampsUs.length === 0) {
    return empty("no_sample_timestamps");
  }
  if (!options.sourcePath) {
    return empty("source_file_not_mapped");
  }

  const sourcePath = path.resolve(options.sourcePath);
  let sourceStat: fs.Stats;
  try {
    sourceStat = fs.statSync(sourcePath);
  } catch (error) {
    return empty(`source_file_unavailable:${errorMessage(error)}`);
  }
  if (!sourceStat.isFile() || sourceStat.size <= 0) {
    return empty("source_file_missing_or_empty");
  }
  let sourceContentSha256 = options.sourceContentSha256;
  try {
    sourceContentSha256 ??= (options.sourceIdentityCache ?? new SourceContentIdentityCache())
      .resolve(sourcePath).sha256;
  } catch (error) {
    return empty(`source_content_hash_failed:${errorMessage(error)}`);
  }

  const frameDir = frameCacheDir(options);
  const manifestPath = path.join(frameDir, "manifest.json");
  const cachedManifest = readManifest(manifestPath);
  const cacheDecisionReasons = frameCacheMismatchReasons(cachedManifest, {
    sourcePath,
    sourceSize: sourceStat.size,
    sourceMtimeMs: Math.round(sourceStat.mtimeMs),
    sourceContentSha256,
    assetId: options.assetId,
    segmentId: options.segmentId,
    segmentStartUs: options.segmentStartUs,
    segmentEndUs: options.segmentEndUs,
    requestedSampleTimestampsUs,
  });
  const cacheMatches = cacheDecisionReasons.length === 0;

  fs.mkdirSync(frameDir, { recursive: true });
  const framePaths: string[] = [];
  const sampleTimestampsUs: number[] = [];
  const failures: string[] = [];
  let cacheHits = 0;

  for (const timestampUs of requestedSampleTimestampsUs) {
    const framePath = path.resolve(frameDir, `${timestampUs}.jpg`);
    const cachedFrame = cacheMatches && cachedManifest
      ? cachedManifest.frames.find((frame) => frame.timestamp_us === timestampUs)
      : undefined;
    if (
      cachedFrame &&
      path.resolve(options.outputDir, cachedFrame.path) === framePath &&
      isVerifiedImagePath(framePath)
    ) {
      framePaths.push(framePath);
      sampleTimestampsUs.push(timestampUs);
      cacheHits += 1;
      continue;
    }

    try {
      fs.rmSync(framePath, { force: true });
      await execFilePromise(options.execFileImpl ?? defaultExecFile, "ffmpeg", [
        "-y",
        "-ss",
        formatSeconds(timestampUs),
        "-i",
        sourcePath,
        "-frames:v",
        "1",
        "-q:v",
        "2",
        framePath,
      ]);
      if (!isVerifiedImagePath(framePath)) {
        throw new Error("ffmpeg_produced_no_nonempty_frame");
      }
      framePaths.push(framePath);
      sampleTimestampsUs.push(timestampUs);
    } catch (error) {
      fs.rmSync(framePath, { force: true });
      failures.push(`${timestampUs}:${errorMessage(error)}`);
    }
  }

  const frames = framePaths.map((framePath, index) => ({
    timestamp_us: sampleTimestampsUs[index],
    path: toPosixPath(path.relative(path.resolve(options.outputDir), framePath)),
    size_bytes: fs.statSync(framePath).size,
  }));
  const manifest: GroundedFrameManifest = {
    version: GROUNDED_FRAME_CACHE_VERSION,
    producer_version: GROUNDED_FRAME_PRODUCER_VERSION,
    source_path: sourcePath,
    source_size: sourceStat.size,
    source_mtime_ms: Math.round(sourceStat.mtimeMs),
    source_content_sha256: sourceContentSha256,
    asset_id: options.assetId,
    segment_id: options.segmentId,
    segment_start_us: options.segmentStartUs,
    segment_end_us: options.segmentEndUs,
    requested_sample_timestamps_us: requestedSampleTimestampsUs,
    frames,
    extraction_failures: failures,
  };
  atomicWriteJson(manifestPath, manifest);

  return {
    framePaths,
    sampleTimestampsUs,
    requestedSampleTimestampsUs,
    cacheHits,
    failures,
    cacheVersion: GROUNDED_FRAME_CACHE_VERSION,
    producerVersion: GROUNDED_FRAME_PRODUCER_VERSION,
    sourceContentSha256,
    segmentStartUs: options.segmentStartUs,
    segmentEndUs: options.segmentEndUs,
    cacheDecision: cacheHits === requestedSampleTimestampsUs.length && failures.length === 0
      ? "accepted"
      : "refreshed",
    cacheDecisionReasons: cacheMatches
      ? (failures.length > 0 ? ["cached_frames_incomplete"] : ["identity_match"])
      : cacheDecisionReasons,
  };
}

function frameCacheDir(options: Pick<ExtractGroundedFramesOptions, "outputDir" | "namespace" | "assetId" | "segmentId">): string {
  return path.join(
    path.resolve(options.outputDir),
    options.namespace,
    safePathPart(options.assetId),
    safePathPart(options.segmentId),
  );
}

function frameCacheMismatchReasons(
  manifest: GroundedFrameManifest | null,
  expected: {
    sourcePath: string;
    sourceSize: number;
    sourceMtimeMs: number;
    sourceContentSha256: string;
    assetId: string;
    segmentId: string;
    segmentStartUs: number;
    segmentEndUs: number;
    requestedSampleTimestampsUs: number[];
  },
): string[] {
  if (!manifest) return ["manifest_missing_or_unreadable"];
  const reasons: string[] = [];
  if (manifest.version !== GROUNDED_FRAME_CACHE_VERSION) reasons.push("cache_revision_mismatch");
  if (manifest.producer_version !== GROUNDED_FRAME_PRODUCER_VERSION) reasons.push("producer_revision_mismatch");
  if (manifest.source_path !== expected.sourcePath) reasons.push("source_path_mismatch");
  if (manifest.source_size !== expected.sourceSize) reasons.push("source_size_mismatch");
  if (manifest.source_mtime_ms !== expected.sourceMtimeMs) reasons.push("source_mtime_mismatch");
  if (manifest.source_content_sha256 !== expected.sourceContentSha256) reasons.push("source_content_mismatch");
  if (manifest.asset_id !== expected.assetId) reasons.push("asset_id_mismatch");
  if (manifest.segment_id !== expected.segmentId) reasons.push("segment_id_mismatch");
  if (manifest.segment_start_us !== expected.segmentStartUs || manifest.segment_end_us !== expected.segmentEndUs) {
    reasons.push("segment_range_mismatch");
  }
  if (!sameNumbers(manifest.requested_sample_timestamps_us, expected.requestedSampleTimestampsUs)) {
    reasons.push("requested_timestamps_mismatch");
  }
  return reasons;
}

function sameNumbers(left: number[] | undefined, right: number[]): boolean {
  return Array.isArray(left) && left.length === right.length &&
    left.every((value, index) => value === right[index]);
}

function normalizeTimestamps(values: number[]): number[] {
  return [...new Set(values.filter((value) => Number.isInteger(value) && value >= 0))];
}

function safePathPart(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "") || "unknown";
}

function formatSeconds(timestampUs: number): string {
  return (timestampUs / 1_000_000).toFixed(6);
}

function toPosixPath(value: string): string {
  return value.split(path.sep).join(path.posix.sep);
}

function readManifest(filePath: string): GroundedFrameManifest | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8")) as GroundedFrameManifest;
  } catch {
    return null;
  }
}

function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/\s+/g, " ")
    .slice(0, 300);
}

const defaultExecFile = execFile as unknown as FrameExecFileLike;

function execFilePromise(
  execFileImpl: FrameExecFileLike,
  command: string,
  args: string[],
): Promise<void> {
  return new Promise((resolve, reject) => {
    execFileImpl(command, args, { maxBuffer: 4 * 1024 * 1024 }, (error, _stdout, stderr) => {
      if (error) {
        reject(new Error(stderr || error.message));
        return;
      }
      resolve();
    });
  });
}
