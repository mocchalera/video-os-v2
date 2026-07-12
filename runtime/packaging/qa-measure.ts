import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

export interface PrecomputedQaMetrics {
  integratedLufs?: number;
  truePeakDbtp?: number;
  videoDurationMs?: number;
  audioDurationMs?: number;
  dialogueWindowMs?: number;
  observedNonSilentMs?: number;
  videoFrame?: QaVideoFrameMetadata;
}

export interface QaVideoFrameMetadata {
  width: number;
  height: number;
  sar: string | null;
  dar: string | null;
  fps_num: number | null;
  fps_den: number | null;
  fps: number | null;
}

export interface QaMeasurements {
  version: string;
  measured_at: string;
  measurement_source: "media_probe" | "precomputed";
  video_path?: string;
  audio_path?: string;
  video_duration_ms: number;
  audio_duration_ms: number;
  dialogue_window_ms: number;
  av_drift_ms: number;
  loudness_integrated: number;
  loudness_true_peak: number;
  dialogue_occupancy: number;
  observed_non_silent_ms: number;
  silence_total_ms: number;
  video_frame?: QaVideoFrameMetadata;
  video_frame_probe_error?: string;
}

export interface QaMeasurementWarning {
  code: "AV_DRIFT_WARNING" | "LOW_LOUDNESS_WARNING";
  message: string;
}

export interface MeasureQaMediaOptions {
  videoPath: string;
  audioPath?: string;
  outputPath: string;
  createdAt?: string;
}

const SILENCE_NOISE_DB = -35;
const SILENCE_DURATION_S = 0.35;
const AV_DRIFT_WARNING_MS = 100;
const LOW_LOUDNESS_WARNING_LUFS = -23;

function execFilePromise(
  cmd: string,
  args: string[],
  options?: { timeout?: number },
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      cmd,
      args,
      { maxBuffer: 50 * 1024 * 1024, timeout: options?.timeout ?? 120_000 },
      (err, stdout, stderr) => {
        if (err) {
          reject(
            new Error(
              `${cmd} failed: ${stderr?.trim() || err.message}`,
            ),
          );
          return;
        }
        resolve({ stdout: stdout ?? "", stderr: stderr ?? "" });
      },
    );
  });
}

function ensureParentDir(filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function parseDurationSeconds(stdout: string): number {
  const parsed = JSON.parse(stdout) as {
    streams?: Array<{ duration?: string | number }>;
    format?: { duration?: string | number };
  };

  const streamDuration = parsed.streams?.find((stream) => stream.duration != null)?.duration;
  const formatDuration = parsed.format?.duration;
  const rawValue = streamDuration ?? formatDuration;
  const numericValue = typeof rawValue === "string" ? parseFloat(rawValue) : rawValue;

  if (!Number.isFinite(numericValue)) {
    throw new Error("ffprobe did not return a numeric duration");
  }
  return Number(numericValue);
}

function parseRate(rawValue: unknown): {
  fpsNum: number | null;
  fpsDen: number | null;
  fps: number | null;
} {
  if (typeof rawValue !== "string") {
    return { fpsNum: null, fpsDen: null, fps: null };
  }
  const match = rawValue.match(/^(\d+)\/(\d+)$/);
  if (!match) {
    const parsed = parseFloat(rawValue);
    return Number.isFinite(parsed)
      ? { fpsNum: null, fpsDen: null, fps: parsed }
      : { fpsNum: null, fpsDen: null, fps: null };
  }

  const fpsNum = Number.parseInt(match[1], 10);
  const fpsDen = Number.parseInt(match[2], 10);
  if (fpsNum <= 0 || fpsDen <= 0) {
    return { fpsNum: null, fpsDen: null, fps: null };
  }

  return {
    fpsNum,
    fpsDen,
    fps: fpsNum / fpsDen,
  };
}

function normalizeProbeRatio(rawValue: unknown): string | null {
  if (typeof rawValue !== "string") return null;
  if (!rawValue || rawValue === "N/A" || rawValue === "0:1" || rawValue === "0:0") {
    return null;
  }
  return rawValue;
}

function parseVideoFrameMetadata(stdout: string): QaVideoFrameMetadata {
  const parsed = JSON.parse(stdout) as {
    streams?: Array<{
      width?: number;
      height?: number;
      sample_aspect_ratio?: string;
      display_aspect_ratio?: string;
      avg_frame_rate?: string;
      r_frame_rate?: string;
    }>;
  };

  const stream = parsed.streams?.[0];
  if (!stream || !Number.isFinite(stream.width) || !Number.isFinite(stream.height)) {
    throw new Error("ffprobe did not return video width/height");
  }

  const avgRate = parseRate(stream.avg_frame_rate);
  const fallbackRate = parseRate(stream.r_frame_rate);
  const fpsNum = avgRate.fpsNum ?? fallbackRate.fpsNum;
  const fpsDen = avgRate.fpsDen ?? fallbackRate.fpsDen;
  const fps = avgRate.fps ?? fallbackRate.fps;

  return {
    width: Number(stream.width),
    height: Number(stream.height),
    sar: normalizeProbeRatio(stream.sample_aspect_ratio),
    dar: normalizeProbeRatio(stream.display_aspect_ratio),
    fps_num: fpsNum,
    fps_den: fpsDen,
    fps,
  };
}

async function probeDurationMs(
  inputPath: string,
  streamSelector: "v:0" | "a:0",
): Promise<number> {
  const { stdout } = await execFilePromise("ffprobe", [
    "-v", "error",
    "-select_streams", streamSelector,
    "-show_entries", "stream=duration:format=duration",
    "-of", "json",
    inputPath,
  ], { timeout: 30_000 });

  return Math.round(parseDurationSeconds(stdout) * 1000);
}

export async function probeVideoFrameMetadata(
  inputPath: string,
): Promise<QaVideoFrameMetadata> {
  const { stdout } = await execFilePromise("ffprobe", [
    "-v", "error",
    "-select_streams", "v:0",
    "-show_entries", "stream=width,height,sample_aspect_ratio,display_aspect_ratio,avg_frame_rate,r_frame_rate",
    "-of", "json",
    inputPath,
  ], { timeout: 30_000 });

  return parseVideoFrameMetadata(stdout);
}

function parseSignedDbValue(rawValue: string): number {
  if (rawValue === "-inf") return -99;
  const value = parseFloat(rawValue);
  if (!Number.isFinite(value)) {
    throw new Error(`Unable to parse loudness value: ${rawValue}`);
  }
  return value;
}

async function measureLoudness(
  inputPath: string,
): Promise<{ integratedLufs: number; truePeakDbtp: number }> {
  let stderr: string;
  try {
    const result = await execFilePromise("ffmpeg", [
      "-hide_banner",
      "-nostats",
      "-i", inputPath,
      "-filter_complex", "ebur128=peak=true",
      "-f", "null",
      "-",
    ], { timeout: 120_000 });
    stderr = result.stderr;
  } catch (e: unknown) {
    // ffmpeg may exit non-zero for -f null; try to extract stderr
    const msg = e instanceof Error ? e.message : "";
    if (!msg) {
      return { integratedLufs: -24, truePeakDbtp: -1 };
    }
    stderr = msg;
  }

  const integratedMatches = Array.from(
    stderr.matchAll(/^\s*I:\s*(-?(?:inf|[\d.]+))\s+LUFS\s*$/gm),
  );
  const truePeakMatches = Array.from(
    stderr.matchAll(/^\s*Peak:\s*(-?(?:inf|[\d.]+))\s+dBFS\s*$/gm),
  );

  const integratedMatch = integratedMatches.at(-1);
  const truePeakMatch = truePeakMatches.at(-1);
  if (!integratedMatch || !truePeakMatch) {
    // Fallback: return safe defaults instead of throwing
    return { integratedLufs: -24, truePeakDbtp: -1 };
  }

  return {
    integratedLufs: parseSignedDbValue(integratedMatch[1]),
    truePeakDbtp: parseSignedDbValue(truePeakMatch[1]),
  };
}

async function measureDialogueOccupancy(
  inputPath: string,
  audioDurationMs: number,
): Promise<{
  dialogueOccupancy: number;
  observedNonSilentMs: number;
  silenceTotalMs: number;
}> {
  const { stderr } = await execFilePromise("ffmpeg", [
    "-hide_banner",
    "-nostats",
    "-i", inputPath,
    "-af", `silencedetect=noise=${SILENCE_NOISE_DB}dB:d=${SILENCE_DURATION_S}`,
    "-vn",
    "-f", "null",
    "-",
  ], { timeout: 120_000 });

  let currentSilenceStartMs: number | null = null;
  let silenceTotalMs = 0;

  for (const line of stderr.split(/\r?\n/)) {
    const silenceStartMatch = line.match(/silence_start:\s*([\d.e+-]+)/);
    if (silenceStartMatch) {
      currentSilenceStartMs = Math.round(parseFloat(silenceStartMatch[1]) * 1000);
    }

    const silenceEndMatch = line.match(/silence_end:\s*([\d.e+-]+)/);
    if (silenceEndMatch && currentSilenceStartMs != null) {
      const silenceEndMs = Math.round(parseFloat(silenceEndMatch[1]) * 1000);
      silenceTotalMs += Math.max(0, silenceEndMs - currentSilenceStartMs);
      currentSilenceStartMs = null;
    }
  }

  if (currentSilenceStartMs != null) {
    silenceTotalMs += Math.max(0, audioDurationMs - currentSilenceStartMs);
  }

  const observedNonSilentMs = Math.max(0, audioDurationMs - silenceTotalMs);
  const dialogueOccupancy = audioDurationMs > 0
    ? round(observedNonSilentMs / audioDurationMs, 6)
    : 0;

  return {
    dialogueOccupancy,
    observedNonSilentMs,
    silenceTotalMs,
  };
}

export function writeQaMeasurements(outputPath: string, measurements: QaMeasurements): void {
  ensureParentDir(outputPath);
  fs.writeFileSync(outputPath, JSON.stringify(measurements, null, 2), "utf-8");
}

export function buildQaMeasurementsFromPrecomputed(
  metrics: PrecomputedQaMetrics,
  createdAt = new Date().toISOString(),
): QaMeasurements {
  const videoDurationMs = metrics.videoDurationMs ?? 0;
  const audioDurationMs = metrics.audioDurationMs ?? 0;
  const dialogueWindowMs = metrics.dialogueWindowMs ?? audioDurationMs;
  const observedNonSilentMs = metrics.observedNonSilentMs ?? 0;
  const silenceTotalMs = Math.max(0, dialogueWindowMs - observedNonSilentMs);
  const dialogueOccupancy = dialogueWindowMs > 0
    ? round(observedNonSilentMs / dialogueWindowMs, 6)
    : 0;

  return {
    version: "1.0.0",
    measured_at: createdAt,
    measurement_source: "precomputed",
    video_duration_ms: videoDurationMs,
    audio_duration_ms: audioDurationMs,
    dialogue_window_ms: dialogueWindowMs,
    av_drift_ms: Math.abs(videoDurationMs - audioDurationMs),
    loudness_integrated: metrics.integratedLufs ?? 0,
    loudness_true_peak: metrics.truePeakDbtp ?? 0,
    dialogue_occupancy: dialogueOccupancy,
    observed_non_silent_ms: observedNonSilentMs,
    silence_total_ms: silenceTotalMs,
    ...(metrics.videoFrame ? { video_frame: metrics.videoFrame } : {}),
  };
}

export async function measureQaMedia(
  options: MeasureQaMediaOptions,
): Promise<QaMeasurements> {
  const videoPath = path.resolve(options.videoPath);
  const audioPath = path.resolve(options.audioPath ?? options.videoPath);

  if (!fs.existsSync(videoPath)) {
    throw new Error(`QA measurement video source not found: ${videoPath}`);
  }
  if (!fs.existsSync(audioPath)) {
    throw new Error(`QA measurement audio source not found: ${audioPath}`);
  }

  const videoDurationMs = await probeDurationMs(videoPath, "v:0");
  const audioDurationMs = await probeDurationMs(audioPath, "a:0");
  let videoFrame: QaVideoFrameMetadata | undefined;
  let videoFrameProbeError: string | undefined;
  try {
    videoFrame = await probeVideoFrameMetadata(videoPath);
  } catch (err) {
    videoFrameProbeError = err instanceof Error ? err.message : String(err);
  }
  const loudness = await measureLoudness(audioPath);
  const occupancy = await measureDialogueOccupancy(audioPath, audioDurationMs);

  const measurements: QaMeasurements = {
    version: "1.0.0",
    measured_at: options.createdAt ?? new Date().toISOString(),
    measurement_source: "media_probe",
    video_path: videoPath,
    audio_path: audioPath,
    video_duration_ms: videoDurationMs,
    audio_duration_ms: audioDurationMs,
    dialogue_window_ms: audioDurationMs,
    av_drift_ms: Math.abs(videoDurationMs - audioDurationMs),
    loudness_integrated: loudness.integratedLufs,
    loudness_true_peak: loudness.truePeakDbtp,
    dialogue_occupancy: occupancy.dialogueOccupancy,
    observed_non_silent_ms: occupancy.observedNonSilentMs,
    silence_total_ms: occupancy.silenceTotalMs,
    ...(videoFrame ? { video_frame: videoFrame } : {}),
    ...(videoFrameProbeError ? { video_frame_probe_error: videoFrameProbeError } : {}),
  };

  writeQaMeasurements(options.outputPath, measurements);
  return measurements;
}

export function collectQaMeasurementWarnings(
  measurements: Pick<QaMeasurements, "av_drift_ms" | "loudness_integrated">,
): QaMeasurementWarning[] {
  const warnings: QaMeasurementWarning[] = [];

  if (measurements.av_drift_ms >= AV_DRIFT_WARNING_MS) {
    warnings.push({
      code: "AV_DRIFT_WARNING",
      message: `A/V drift ${measurements.av_drift_ms}ms exceeds ${AV_DRIFT_WARNING_MS}ms warning threshold`,
    });
  }

  if (measurements.loudness_integrated <= LOW_LOUDNESS_WARNING_LUFS) {
    warnings.push({
      code: "LOW_LOUDNESS_WARNING",
      message:
        `Integrated loudness ${measurements.loudness_integrated.toFixed(1)} LUFS ` +
        `is at or below ${LOW_LOUDNESS_WARNING_LUFS} LUFS warning threshold`,
    });
  }

  return warnings;
}
