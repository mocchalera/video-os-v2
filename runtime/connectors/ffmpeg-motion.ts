/**
 * ffmpeg-based deterministic visual quality measurement.
 *
 * The connector intentionally stays small: it samples a segment at low FPS and
 * uses stock ffmpeg filters only. It is fail-open and returns explicit measured
 * status instead of neutral fake values when a filter or binary is unavailable.
 */

import { execFile } from "node:child_process";
import { computeRequestHash } from "./ffprobe.js";

// ── Types ──────────────────────────────────────────────────────────

export const FFMPEG_MOTION_CONNECTOR_VERSION = "ffmpeg-motion-v1.0.0";
export const DEFAULT_MOTION_SAMPLE_FPS = 2;
export const DEFAULT_MOTION_MAX_WIDTH = 160;
export const DEFAULT_MOTION_BIN_COUNT = 8;
const MOTION_YAVG_FULL_SCALE = 32;
const BLUR_MEAN_FULL_SCALE = 20;
const BLACKFRAME_THRESHOLD = 32;

export interface MotionBin {
  /** Bin start timestamp in microseconds */
  start_us: number;
  /** Bin end timestamp in microseconds */
  end_us: number;
  /** Normalized motion energy score (0-1) */
  energy: number;
}

export interface MotionAnalysisResult {
  /** Per-bin motion energy scores */
  bins: MotionBin[];
  /** Overall segment motion energy (average) */
  average_energy: number;
  /** Peak motion energy in the segment */
  peak_energy: number;
  /** Timestamp of peak motion energy in microseconds */
  peak_timestamp_us: number;
}

export interface ShakeMeasurement extends MotionAnalysisResult {
  measured: true;
  /** Camera/body motion proxy normalized to 0-1. */
  score: number;
  sample_count: number;
}

export interface SharpnessMeasurement {
  measured: true;
  /** Higher is sharper, normalized 0-1. */
  sharpness_score: number;
  /** Higher is blurrier, normalized 0-1. */
  blur_score: number;
  /** blurdetect's raw blur mean when that filter is available. */
  blur_mean?: number;
  /** Laplacian edge mean fallback when blurdetect is unavailable. */
  edge_mean?: number;
  method: "blurdetect" | "laplacian_convolution";
  sample_count: number;
}

export interface ExposureMeasurement {
  measured: true;
  /** Higher is better exposed, normalized 0-1. */
  exposure_score: number;
  black_clip_ratio: number;
  white_clip_ratio: number;
  avg_luma: number;
  underexposed: boolean;
  overexposed: boolean;
  sample_count: number;
}

export interface VisualQualityMeasurements {
  measured: boolean;
  connector_version: string;
  method: "ffmpeg_sampled_signals" | "ffmpeg_single_frame_signals";
  sample_fps: number;
  max_width: number;
  duration_us: number;
  metrics_measured: {
    shake: boolean;
    sharpness: boolean;
    exposure: boolean;
  };
  shake?: ShakeMeasurement;
  sharpness?: SharpnessMeasurement;
  exposure?: ExposureMeasurement;
  failure_reason?: string;
  warnings?: string[];
}

export type ExecFileLike = (
  command: string,
  args: string[],
  options: { maxBuffer: number },
  callback: (error: Error | null, stdout: string, stderr: string) => void,
) => void;

export interface FfmpegMotionOptions {
  sampleFps?: number;
  maxWidth?: number;
  binCount?: number;
  execFileImpl?: ExecFileLike;
}

/** Injectable function for running ffmpeg motion analysis. */
export type MotionAnalyzeFn = (
  sourcePath: string,
  srcInUs: number,
  srcOutUs: number,
  binCount: number,
) => Promise<MotionAnalysisResult>;

// ── Motion Support Score ───────────────────────────────────────────

/**
 * Compute the motion support score for a VLM peak.
 * Checks if there is a local motion maximum near the peak timestamp.
 *
 * @param bins - Motion energy bins for the segment
 * @param peakTimestampUs - VLM-detected peak timestamp
 * @param windowMs - Search window around the peak (default 500ms)
 * @returns motion support score (0-1)
 */
export function computeMotionSupportScore(
  bins: MotionBin[],
  peakTimestampUs: number,
  windowMs: number = 500,
): number {
  if (bins.length === 0) return 0.5; // Neutral when no data

  const windowUs = windowMs * 1000;
  const searchStart = peakTimestampUs - windowUs;
  const searchEnd = peakTimestampUs + windowUs;

  // Find max energy in the search window
  let maxEnergyInWindow = 0;
  let maxEnergyOverall = 0;

  for (const bin of bins) {
    const binMid = (bin.start_us + bin.end_us) / 2;
    if (bin.energy > maxEnergyOverall) {
      maxEnergyOverall = bin.energy;
    }
    if (binMid >= searchStart && binMid <= searchEnd) {
      if (bin.energy > maxEnergyInWindow) {
        maxEnergyInWindow = bin.energy;
      }
    }
  }

  if (maxEnergyOverall <= 0) return 0.5; // Neutral for no-motion segments

  // Support score is how close the local max is to the global max
  return maxEnergyInWindow / maxEnergyOverall;
}

// ── Stub Motion Analyzer (for testing / when ffmpeg is not available) ──

/**
 * Create a stub motion analyzer that returns uniform energy.
 * Used when ffmpeg is not available or for testing.
 */
export function createStubMotionAnalyzeFn(defaultEnergy: number = 0.5): MotionAnalyzeFn {
  return async (
    _sourcePath: string,
    srcInUs: number,
    srcOutUs: number,
    binCount: number,
  ): Promise<MotionAnalysisResult> => {
    const duration = srcOutUs - srcInUs;
    const binDuration = duration / binCount;
    const bins: MotionBin[] = [];

    for (let i = 0; i < binCount; i++) {
      bins.push({
        start_us: srcInUs + Math.floor(binDuration * i),
        end_us: srcInUs + Math.floor(binDuration * (i + 1)),
        energy: defaultEnergy,
      });
    }

    return {
      bins,
      average_energy: defaultEnergy,
      peak_energy: defaultEnergy,
      peak_timestamp_us: Math.floor((srcInUs + srcOutUs) / 2),
    };
  };
}

// ── ffmpeg Measurements ────────────────────────────────────────────

export async function analyzeSegmentVisualQuality(
  sourcePath: string,
  srcInUs: number,
  srcOutUs: number,
  options: FfmpegMotionOptions = {},
): Promise<VisualQualityMeasurements> {
  const sampleFps = options.sampleFps ?? DEFAULT_MOTION_SAMPLE_FPS;
  const maxWidth = options.maxWidth ?? DEFAULT_MOTION_MAX_WIDTH;
  const durationUs = Math.max(0, srcOutUs - srcInUs);
  const failures: string[] = [];

  if (durationUs <= 0) {
    return failedVisualQualityMeasurement("invalid_segment_duration", {
      sampleFps,
      maxWidth,
      durationUs,
    });
  }

  const shake = await measureShake(sourcePath, srcInUs, srcOutUs, options).catch((error: unknown) => {
    failures.push(`shake:${errorMessage(error)}`);
    return undefined;
  });
  const sharpness = await measureSharpness(sourcePath, srcInUs, srcOutUs, options).catch((error: unknown) => {
    failures.push(`sharpness:${errorMessage(error)}`);
    return undefined;
  });
  const exposure = await measureExposure(sourcePath, srcInUs, srcOutUs, options).catch((error: unknown) => {
    failures.push(`exposure:${errorMessage(error)}`);
    return undefined;
  });

  const metricsMeasured = {
    shake: !!shake,
    sharpness: !!sharpness,
    exposure: !!exposure,
  };
  const measured = metricsMeasured.shake && metricsMeasured.sharpness && metricsMeasured.exposure;

  return {
    measured,
    connector_version: FFMPEG_MOTION_CONNECTOR_VERSION,
    method: "ffmpeg_sampled_signals",
    sample_fps: sampleFps,
    max_width: maxWidth,
    duration_us: durationUs,
    metrics_measured: metricsMeasured,
    ...(shake ? { shake } : {}),
    ...(sharpness ? { sharpness } : {}),
    ...(exposure ? { exposure } : {}),
    ...(failures.length > 0 ? { failure_reason: failures.join("; ") } : {}),
  };
}

export async function analyzeStillImageVisualQuality(
  sourcePath: string,
  options: FfmpegMotionOptions = {},
): Promise<VisualQualityMeasurements> {
  const sampleFps = options.sampleFps ?? DEFAULT_MOTION_SAMPLE_FPS;
  const maxWidth = options.maxWidth ?? DEFAULT_MOTION_MAX_WIDTH;
  const failures: string[] = [];
  const sharpness = await measureStillSharpness(sourcePath, options).catch((error: unknown) => {
    failures.push(`sharpness:${errorMessage(error)}`);
    return undefined;
  });
  const exposure = await measureStillExposure(sourcePath, options).catch((error: unknown) => {
    failures.push(`exposure:${errorMessage(error)}`);
    return undefined;
  });
  return {
    measured: Boolean(sharpness && exposure),
    connector_version: FFMPEG_MOTION_CONNECTOR_VERSION,
    method: "ffmpeg_single_frame_signals",
    sample_fps: sampleFps,
    max_width: maxWidth,
    duration_us: 0,
    metrics_measured: {
      shake: false,
      sharpness: Boolean(sharpness),
      exposure: Boolean(exposure),
    },
    ...(sharpness ? { sharpness } : {}),
    ...(exposure ? { exposure } : {}),
    ...(failures.length > 0 ? { failure_reason: failures.join("; ") } : {}),
    warnings: ["motion_not_applicable_still_image"],
  };
}

export function failedVisualQualityMeasurement(
  reason: string,
  options: { sampleFps?: number; maxWidth?: number; durationUs?: number } = {},
): VisualQualityMeasurements {
  return {
    measured: false,
    connector_version: FFMPEG_MOTION_CONNECTOR_VERSION,
    method: "ffmpeg_sampled_signals",
    sample_fps: options.sampleFps ?? DEFAULT_MOTION_SAMPLE_FPS,
    max_width: options.maxWidth ?? DEFAULT_MOTION_MAX_WIDTH,
    duration_us: Math.max(0, options.durationUs ?? 0),
    metrics_measured: {
      shake: false,
      sharpness: false,
      exposure: false,
    },
    failure_reason: reason,
  };
}

export async function analyzeMotionWithFfmpeg(
  sourcePath: string,
  srcInUs: number,
  srcOutUs: number,
  options: FfmpegMotionOptions = {},
): Promise<MotionAnalysisResult> {
  const sampleFps = options.sampleFps ?? DEFAULT_MOTION_SAMPLE_FPS;
  const maxWidth = options.maxWidth ?? DEFAULT_MOTION_MAX_WIDTH;
  const binCount = options.binCount ?? DEFAULT_MOTION_BIN_COUNT;
  const durationUs = Math.max(0, srcOutUs - srcInUs);
  if (durationUs <= 0) {
    throw new Error("invalid_segment_duration");
  }

  const { stderr } = await execFilePromise(options.execFileImpl, "ffmpeg", [
    "-hide_banner",
    "-nostats",
    "-ss", formatSeconds(srcInUs),
    "-t", formatSeconds(durationUs),
    "-i", sourcePath,
    "-vf", [
      `fps=${sampleFps}`,
      `scale=${maxWidth}:-2`,
      "tblend=all_mode=difference",
      "signalstats",
      "metadata=print:key=lavfi.signalstats.YAVG",
    ].join(","),
    "-an",
    "-f", "null",
    "-",
  ]);

  const samples = parseMetadataSamples(stderr, "lavfi.signalstats.YAVG")
    .map((sample) => ({
      timestamp_us: clampTimestamp(srcInUs + Math.round(sample.ptsTimeSec * 1_000_000), srcInUs, srcOutUs),
      energy: clamp01(sample.value / MOTION_YAVG_FULL_SCALE),
    }));
  if (samples.length === 0) {
    throw new Error("motion_samples_missing");
  }

  const bins = buildMotionBins(samples, srcInUs, srcOutUs, binCount);
  const averageEnergy = round3(samples.reduce((sum, sample) => sum + sample.energy, 0) / samples.length);
  const peakSample = samples.reduce((best, sample) => sample.energy > best.energy ? sample : best, samples[0]);

  return {
    bins,
    average_energy: averageEnergy,
    peak_energy: round3(peakSample.energy),
    peak_timestamp_us: peakSample.timestamp_us,
  };
}

export function createFfmpegMotionAnalyzeFn(
  options: Omit<FfmpegMotionOptions, "binCount"> = {},
): MotionAnalyzeFn {
  return (sourcePath, srcInUs, srcOutUs, binCount) =>
    analyzeMotionWithFfmpeg(sourcePath, srcInUs, srcOutUs, { ...options, binCount });
}

export function computeVisualQualityRequestHash(params: {
  sourcePath: string;
  segmentId: string;
  srcInUs: number;
  srcOutUs: number;
  policyHash: string;
  sampleFps?: number;
  maxWidth?: number;
}): string {
  return computeRequestHash({
    connector_version: FFMPEG_MOTION_CONNECTOR_VERSION,
    source_path: params.sourcePath,
    segment_id: params.segmentId,
    src_in_us: params.srcInUs,
    src_out_us: params.srcOutUs,
    policy_hash: params.policyHash,
    sample_fps: params.sampleFps ?? DEFAULT_MOTION_SAMPLE_FPS,
    max_width: params.maxWidth ?? DEFAULT_MOTION_MAX_WIDTH,
  });
}

async function measureShake(
  sourcePath: string,
  srcInUs: number,
  srcOutUs: number,
  options: FfmpegMotionOptions,
): Promise<ShakeMeasurement> {
  const motion = await analyzeMotionWithFfmpeg(sourcePath, srcInUs, srcOutUs, options);
  return {
    measured: true,
    score: round3(motion.average_energy),
    sample_count: motion.bins.length,
    ...motion,
  };
}

async function measureSharpness(
  sourcePath: string,
  srcInUs: number,
  srcOutUs: number,
  options: FfmpegMotionOptions,
): Promise<SharpnessMeasurement> {
  try {
    return await measureSharpnessWithBlurdetect(sourcePath, srcInUs, srcOutUs, options);
  } catch {
    return measureSharpnessWithConvolution(sourcePath, srcInUs, srcOutUs, options);
  }
}

async function measureSharpnessWithBlurdetect(
  sourcePath: string,
  srcInUs: number,
  srcOutUs: number,
  options: FfmpegMotionOptions,
): Promise<SharpnessMeasurement> {
  const sampleFps = options.sampleFps ?? DEFAULT_MOTION_SAMPLE_FPS;
  const maxWidth = options.maxWidth ?? DEFAULT_MOTION_MAX_WIDTH;
  const durationUs = srcOutUs - srcInUs;
  const { stderr } = await execFilePromise(options.execFileImpl, "ffmpeg", [
    "-hide_banner",
    "-nostats",
    "-ss", formatSeconds(srcInUs),
    "-t", formatSeconds(durationUs),
    "-i", sourcePath,
    "-vf", [`fps=${sampleFps}`, `scale=${maxWidth}:-2`, "blurdetect"].join(","),
    "-an",
    "-f", "null",
    "-",
  ]);
  const match = stderr.match(/blur mean:\s*([-+]?\d+(?:\.\d+)?)/);
  if (!match) {
    throw new Error("blurdetect_output_missing");
  }
  const blurMean = Number.parseFloat(match[1]);
  if (!Number.isFinite(blurMean)) {
    throw new Error("blurdetect_output_invalid");
  }
  const blurScore = clamp01(blurMean / BLUR_MEAN_FULL_SCALE);
  return {
    measured: true,
    sharpness_score: round3(1 - blurScore),
    blur_score: round3(blurScore),
    blur_mean: round3(blurMean),
    method: "blurdetect",
    sample_count: parseFrameCount(stderr),
  };
}

async function measureSharpnessWithConvolution(
  sourcePath: string,
  srcInUs: number,
  srcOutUs: number,
  options: FfmpegMotionOptions,
): Promise<SharpnessMeasurement> {
  const sampleFps = options.sampleFps ?? DEFAULT_MOTION_SAMPLE_FPS;
  const maxWidth = options.maxWidth ?? DEFAULT_MOTION_MAX_WIDTH;
  const durationUs = srcOutUs - srcInUs;
  const { stderr } = await execFilePromise(options.execFileImpl, "ffmpeg", [
    "-hide_banner",
    "-nostats",
    "-ss", formatSeconds(srcInUs),
    "-t", formatSeconds(durationUs),
    "-i", sourcePath,
    "-vf", [
      `fps=${sampleFps}`,
      `scale=${maxWidth}:-2`,
      "format=gray",
      "convolution='0 -1 0 -1 4 -1 0 -1 0'",
      "signalstats",
      "metadata=print:key=lavfi.signalstats.YAVG",
    ].join(","),
    "-an",
    "-f", "null",
    "-",
  ]);
  const values = parseMetadataValues(stderr, "lavfi.signalstats.YAVG");
  if (values.length === 0) {
    throw new Error("laplacian_samples_missing");
  }
  const edgeMean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const sharpness = clamp01(edgeMean / 12);
  return {
    measured: true,
    sharpness_score: round3(sharpness),
    blur_score: round3(1 - sharpness),
    edge_mean: round3(edgeMean),
    method: "laplacian_convolution",
    sample_count: values.length,
  };
}

async function measureExposure(
  sourcePath: string,
  srcInUs: number,
  srcOutUs: number,
  options: FfmpegMotionOptions,
): Promise<ExposureMeasurement> {
  const sampleFps = options.sampleFps ?? DEFAULT_MOTION_SAMPLE_FPS;
  const maxWidth = options.maxWidth ?? DEFAULT_MOTION_MAX_WIDTH;
  const durationUs = srcOutUs - srcInUs;
  const baseArgs = [
    "-hide_banner",
    "-nostats",
    "-ss", formatSeconds(srcInUs),
    "-t", formatSeconds(durationUs),
    "-i", sourcePath,
  ];
  const sampledScale = [`fps=${sampleFps}`, `scale=${maxWidth}:-2`];
  const blackRun = await execFilePromise(options.execFileImpl, "ffmpeg", [
    ...baseArgs,
    "-vf", [
      ...sampledScale,
      "signalstats",
      "metadata=print:key=lavfi.signalstats.YAVG",
      `blackframe=amount=0:threshold=${BLACKFRAME_THRESHOLD}`,
    ].join(","),
    "-an",
    "-f", "null",
    "-",
  ]);
  const whiteRun = await execFilePromise(options.execFileImpl, "ffmpeg", [
    ...baseArgs,
    "-vf", [
      ...sampledScale,
      "negate",
      `blackframe=amount=0:threshold=${BLACKFRAME_THRESHOLD}`,
    ].join(","),
    "-an",
    "-f", "null",
    "-",
  ]);

  const blackValues = parsePblackValues(blackRun.stderr);
  const whiteValues = parsePblackValues(whiteRun.stderr);
  const yValues = parseMetadataValues(blackRun.stderr, "lavfi.signalstats.YAVG");
  if (blackValues.length === 0 || whiteValues.length === 0 || yValues.length === 0) {
    throw new Error("exposure_samples_missing");
  }

  const blackClipRatio = average(blackValues) / 100;
  const whiteClipRatio = average(whiteValues) / 100;
  const avgLuma = average(yValues);
  const lumaPenalty = avgLuma < 48
    ? (48 - avgLuma) / 48
    : avgLuma > 208
      ? (avgLuma - 208) / 47
      : 0;
  const worstPenalty = Math.max(blackClipRatio, whiteClipRatio, clamp01(lumaPenalty));

  return {
    measured: true,
    exposure_score: round3(1 - clamp01(worstPenalty)),
    black_clip_ratio: round3(blackClipRatio),
    white_clip_ratio: round3(whiteClipRatio),
    avg_luma: round3(avgLuma),
    underexposed: blackClipRatio >= 0.3 || avgLuma < 48,
    overexposed: whiteClipRatio >= 0.3 || avgLuma > 208,
    sample_count: Math.min(blackValues.length, whiteValues.length, yValues.length),
  };
}

async function measureStillSharpness(
  sourcePath: string,
  options: FfmpegMotionOptions,
): Promise<SharpnessMeasurement> {
  const maxWidth = options.maxWidth ?? DEFAULT_MOTION_MAX_WIDTH;
  try {
    const { stderr } = await execFilePromise(options.execFileImpl, "ffmpeg", [
      "-hide_banner", "-nostats", "-i", sourcePath,
      "-vf", [`scale=${maxWidth}:-2`, "blurdetect"].join(","),
      "-frames:v", "1", "-an", "-f", "null", "-",
    ]);
    const match = stderr.match(/blur mean:\s*([-+]?\d+(?:\.\d+)?)/);
    if (!match) throw new Error("blurdetect_output_missing");
    const blurMean = Number.parseFloat(match[1]);
    const blurScore = clamp01(blurMean / BLUR_MEAN_FULL_SCALE);
    return {
      measured: true,
      sharpness_score: round3(1 - blurScore),
      blur_score: round3(blurScore),
      blur_mean: round3(blurMean),
      method: "blurdetect",
      sample_count: 1,
    };
  } catch {
    const { stderr } = await execFilePromise(options.execFileImpl, "ffmpeg", [
      "-hide_banner", "-nostats", "-i", sourcePath,
      "-vf", [`scale=${maxWidth}:-2`, "format=gray", "convolution='0 -1 0 -1 4 -1 0 -1 0'", "signalstats", "metadata=print:key=lavfi.signalstats.YAVG"].join(","),
      "-frames:v", "1", "-an", "-f", "null", "-",
    ]);
    const values = parseMetadataValues(stderr, "lavfi.signalstats.YAVG");
    if (values.length === 0) throw new Error("laplacian_samples_missing");
    const edgeMean = average(values);
    const sharpness = clamp01(edgeMean / 12);
    return {
      measured: true,
      sharpness_score: round3(sharpness),
      blur_score: round3(1 - sharpness),
      edge_mean: round3(edgeMean),
      method: "laplacian_convolution",
      sample_count: 1,
    };
  }
}

async function measureStillExposure(
  sourcePath: string,
  options: FfmpegMotionOptions,
): Promise<ExposureMeasurement> {
  const maxWidth = options.maxWidth ?? DEFAULT_MOTION_MAX_WIDTH;
  const base = ["-hide_banner", "-nostats", "-i", sourcePath];
  const blackRun = await execFilePromise(options.execFileImpl, "ffmpeg", [
    ...base,
    "-vf", [`scale=${maxWidth}:-2`, "signalstats", "metadata=print:key=lavfi.signalstats.YAVG", `blackframe=amount=0:threshold=${BLACKFRAME_THRESHOLD}`].join(","),
    "-frames:v", "1", "-an", "-f", "null", "-",
  ]);
  const whiteRun = await execFilePromise(options.execFileImpl, "ffmpeg", [
    ...base,
    "-vf", [`scale=${maxWidth}:-2`, "negate", `blackframe=amount=0:threshold=${BLACKFRAME_THRESHOLD}`].join(","),
    "-frames:v", "1", "-an", "-f", "null", "-",
  ]);
  const blackValues = parsePblackValues(blackRun.stderr);
  const whiteValues = parsePblackValues(whiteRun.stderr);
  const yValues = parseMetadataValues(blackRun.stderr, "lavfi.signalstats.YAVG");
  if (!blackValues.length || !whiteValues.length || !yValues.length) throw new Error("exposure_samples_missing");
  const blackClipRatio = average(blackValues) / 100;
  const whiteClipRatio = average(whiteValues) / 100;
  const avgLuma = average(yValues);
  const lumaPenalty = avgLuma < 48 ? (48 - avgLuma) / 48 : avgLuma > 208 ? (avgLuma - 208) / 47 : 0;
  const worstPenalty = Math.max(blackClipRatio, whiteClipRatio, clamp01(lumaPenalty));
  return {
    measured: true,
    exposure_score: round3(1 - clamp01(worstPenalty)),
    black_clip_ratio: round3(blackClipRatio),
    white_clip_ratio: round3(whiteClipRatio),
    avg_luma: round3(avgLuma),
    underexposed: blackClipRatio >= 0.3 || avgLuma < 48,
    overexposed: whiteClipRatio >= 0.3 || avgLuma > 208,
    sample_count: 1,
  };
}

function buildMotionBins(
  samples: Array<{ timestamp_us: number; energy: number }>,
  srcInUs: number,
  srcOutUs: number,
  requestedBinCount: number,
): MotionBin[] {
  const durationUs = Math.max(1, srcOutUs - srcInUs);
  const binCount = Math.max(1, Math.min(requestedBinCount, samples.length));
  const bins: MotionBin[] = [];

  for (let i = 0; i < binCount; i++) {
    const start = srcInUs + Math.floor((durationUs * i) / binCount);
    const end = i === binCount - 1
      ? srcOutUs
      : srcInUs + Math.floor((durationUs * (i + 1)) / binCount);
    const binSamples = samples.filter((sample) =>
      sample.timestamp_us >= start && (i === binCount - 1 ? sample.timestamp_us <= end : sample.timestamp_us < end)
    );
    const energy = binSamples.length > 0
      ? binSamples.reduce((sum, sample) => sum + sample.energy, 0) / binSamples.length
      : 0;
    bins.push({
      start_us: start,
      end_us: end,
      energy: round3(energy),
    });
  }

  return bins;
}

function execFilePromise(
  execFileImpl: ExecFileLike | undefined,
  cmd: string,
  args: string[],
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const runner = execFileImpl ?? (execFile as unknown as ExecFileLike);
    runner(cmd, args, { maxBuffer: 50 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        reject(err);
        return;
      }
      resolve({ stdout: stdout ?? "", stderr: stderr ?? "" });
    });
  });
}

function parseMetadataSamples(
  stderr: string,
  key: string,
): Array<{ ptsTimeSec: number; value: number }> {
  const result: Array<{ ptsTimeSec: number; value: number }> = [];
  let currentPtsTime = 0;
  const keyPattern = escapeRegExp(key);
  const valueRegex = new RegExp(`${keyPattern}=([-+]?\\d+(?:\\.\\d+)?)`);

  for (const line of stderr.split("\n")) {
    const ptsMatch = line.match(/pts_time:([-+]?\d+(?:\.\d+)?)/);
    if (ptsMatch) {
      currentPtsTime = Number.parseFloat(ptsMatch[1]);
    }
    const valueMatch = line.match(valueRegex);
    if (valueMatch) {
      const value = Number.parseFloat(valueMatch[1]);
      if (Number.isFinite(value) && Number.isFinite(currentPtsTime)) {
        result.push({ ptsTimeSec: currentPtsTime, value });
      }
    }
  }
  return result;
}

function parseMetadataValues(stderr: string, key: string): number[] {
  return parseMetadataSamples(stderr, key).map((sample) => sample.value);
}

function parsePblackValues(stderr: string): number[] {
  const result: number[] = [];
  for (const match of stderr.matchAll(/pblack:\s*([-+]?\d+(?:\.\d+)?)/g)) {
    const value = Number.parseFloat(match[1]);
    if (Number.isFinite(value)) result.push(value);
  }
  return result;
}

function parseFrameCount(stderr: string): number {
  const match = stderr.match(/frame=\s*(\d+)/g)?.at(-1)?.match(/(\d+)/);
  return match ? Number.parseInt(match[1], 10) : 0;
}

function formatSeconds(us: number): string {
  return (Math.max(0, us) / 1_000_000).toFixed(6).replace(/\.?0+$/, "") || "0";
}

function clampTimestamp(value: number, startUs: number, endUs: number): number {
  return Math.max(startUs, Math.min(endUs, value));
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function average(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
