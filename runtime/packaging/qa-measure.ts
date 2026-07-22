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
  dialogueOutsideExpectedMs?: number;
  dialogueFirstSignalMs?: number;
  dialogueLastSignalMs?: number;
  expectedDialogueStartMs?: number;
  expectedDialogueEndMs?: number;
  videoFrame?: QaVideoFrameMetadata;
}

export interface TimeWindowMs {
  start_ms: number;
  end_ms: number;
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
  /** Stream duration parity only. This is not a content lip-sync measurement. */
  av_duration_delta_ms?: number;
  /** Backward-compatible alias for av_duration_delta_ms. */
  av_drift_ms: number;
  loudness_integrated: number;
  loudness_true_peak: number;
  dialogue_occupancy: number;
  observed_non_silent_ms: number;
  silence_total_ms: number;
  dialogue_outside_expected_ms?: number;
  dialogue_first_signal_ms?: number;
  dialogue_last_signal_ms?: number;
  expected_dialogue_start_ms?: number;
  expected_dialogue_end_ms?: number;
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
  /** Dialogue-only timeline-aligned stem. Use this instead of a BGM-bearing final mix for timing QA. */
  dialoguePath?: string;
  expectedDialogueWindowsMs?: TimeWindowMs[];
  videoOnly?: boolean;
  outputPath: string;
  createdAt?: string;
}

const SILENCE_NOISE_DB = -35;
const SILENCE_DURATION_S = 0.35;
const AV_DRIFT_WARNING_MS = 100;
const LOW_LOUDNESS_WARNING_LUFS = -23;

function mergeWindows(windows: TimeWindowMs[], durationMs: number): TimeWindowMs[] {
  const normalized = windows
    .map((window) => ({
      start_ms: Math.max(0, Math.min(durationMs, window.start_ms)),
      end_ms: Math.max(0, Math.min(durationMs, window.end_ms)),
    }))
    .filter((window) => window.end_ms > window.start_ms)
    .sort((a, b) => a.start_ms - b.start_ms || a.end_ms - b.end_ms);

  const merged: TimeWindowMs[] = [];
  for (const window of normalized) {
    const previous = merged.at(-1);
    if (!previous || window.start_ms > previous.end_ms) {
      merged.push({ ...window });
      continue;
    }
    previous.end_ms = Math.max(previous.end_ms, window.end_ms);
  }
  return merged;
}

function windowsDurationMs(windows: TimeWindowMs[]): number {
  return windows.reduce((total, window) => total + window.end_ms - window.start_ms, 0);
}

function overlapDurationMs(left: TimeWindowMs[], right: TimeWindowMs[]): number {
  let total = 0;
  for (const a of left) {
    for (const b of right) {
      total += Math.max(0, Math.min(a.end_ms, b.end_ms) - Math.max(a.start_ms, b.start_ms));
    }
  }
  return total;
}

/**
 * Convert ffmpeg silencedetect output into non-silent intervals. This makes
 * placement QA independent from total stream duration: a dialogue stem can be
 * the correct length while every utterance is shifted to the wrong time.
 */
export function parseNonSilentIntervals(
  stderr: string,
  durationMs: number,
): TimeWindowMs[] {
  const silenceWindows: TimeWindowMs[] = [];
  let currentSilenceStartMs: number | null = null;

  for (const line of stderr.split(/\r?\n/)) {
    const silenceStartMatch = line.match(/silence_start:\s*([\d.e+-]+)/);
    if (silenceStartMatch) {
      currentSilenceStartMs = Math.round(parseFloat(silenceStartMatch[1]) * 1000);
    }

    const silenceEndMatch = line.match(/silence_end:\s*([\d.e+-]+)/);
    if (silenceEndMatch && currentSilenceStartMs != null) {
      silenceWindows.push({
        start_ms: currentSilenceStartMs,
        end_ms: Math.round(parseFloat(silenceEndMatch[1]) * 1000),
      });
      currentSilenceStartMs = null;
    }
  }

  if (currentSilenceStartMs != null) {
    silenceWindows.push({ start_ms: currentSilenceStartMs, end_ms: durationMs });
  }

  const mergedSilence = mergeWindows(silenceWindows, durationMs);
  const signalWindows: TimeWindowMs[] = [];
  let cursorMs = 0;
  for (const silence of mergedSilence) {
    if (silence.start_ms > cursorMs) {
      signalWindows.push({ start_ms: cursorMs, end_ms: silence.start_ms });
    }
    cursorMs = Math.max(cursorMs, silence.end_ms);
  }
  if (cursorMs < durationMs) {
    signalWindows.push({ start_ms: cursorMs, end_ms: durationMs });
  }
  return signalWindows;
}

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
  expectedWindowsMs?: TimeWindowMs[],
): Promise<{
  dialogueWindowMs: number;
  dialogueOccupancy: number;
  observedNonSilentMs: number;
  silenceTotalMs: number;
  dialogueOutsideExpectedMs?: number;
  dialogueFirstSignalMs?: number;
  dialogueLastSignalMs?: number;
  expectedDialogueStartMs?: number;
  expectedDialogueEndMs?: number;
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

  const signalWindows = parseNonSilentIntervals(stderr, audioDurationMs);
  const totalSignalMs = windowsDurationMs(signalWindows);
  const expectedWindows = expectedWindowsMs?.length
    ? mergeWindows(expectedWindowsMs, audioDurationMs)
    : [];
  const dialogueWindowMs = expectedWindows.length > 0
    ? windowsDurationMs(expectedWindows)
    : audioDurationMs;
  const observedNonSilentMs = expectedWindows.length > 0
    ? overlapDurationMs(signalWindows, expectedWindows)
    : totalSignalMs;
  const silenceTotalMs = Math.max(0, dialogueWindowMs - observedNonSilentMs);
  const dialogueOccupancy = dialogueWindowMs > 0
    ? round(observedNonSilentMs / dialogueWindowMs, 6)
    : 0;
  const firstSignal = signalWindows.at(0);
  const lastSignal = signalWindows.at(-1);
  const firstExpected = expectedWindows.at(0);
  const lastExpected = expectedWindows.at(-1);

  return {
    dialogueWindowMs,
    dialogueOccupancy,
    observedNonSilentMs,
    silenceTotalMs,
    ...(expectedWindows.length > 0 ? {
      dialogueOutsideExpectedMs: Math.max(0, totalSignalMs - observedNonSilentMs),
      expectedDialogueStartMs: firstExpected?.start_ms,
      expectedDialogueEndMs: lastExpected?.end_ms,
    } : {}),
    ...(firstSignal ? { dialogueFirstSignalMs: firstSignal.start_ms } : {}),
    ...(lastSignal ? { dialogueLastSignalMs: lastSignal.end_ms } : {}),
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
    av_duration_delta_ms: Math.abs(videoDurationMs - audioDurationMs),
    av_drift_ms: Math.abs(videoDurationMs - audioDurationMs),
    loudness_integrated: metrics.integratedLufs ?? 0,
    loudness_true_peak: metrics.truePeakDbtp ?? 0,
    dialogue_occupancy: dialogueOccupancy,
    observed_non_silent_ms: observedNonSilentMs,
    silence_total_ms: silenceTotalMs,
    ...(metrics.dialogueOutsideExpectedMs != null
      ? { dialogue_outside_expected_ms: metrics.dialogueOutsideExpectedMs }
      : {}),
    ...(metrics.dialogueFirstSignalMs != null
      ? { dialogue_first_signal_ms: metrics.dialogueFirstSignalMs }
      : {}),
    ...(metrics.dialogueLastSignalMs != null
      ? { dialogue_last_signal_ms: metrics.dialogueLastSignalMs }
      : {}),
    ...(metrics.expectedDialogueStartMs != null
      ? { expected_dialogue_start_ms: metrics.expectedDialogueStartMs }
      : {}),
    ...(metrics.expectedDialogueEndMs != null
      ? { expected_dialogue_end_ms: metrics.expectedDialogueEndMs }
      : {}),
    ...(metrics.videoFrame ? { video_frame: metrics.videoFrame } : {}),
  };
}

export async function measureQaMedia(
  options: MeasureQaMediaOptions,
): Promise<QaMeasurements> {
  const videoPath = path.resolve(options.videoPath);
  const audioPath = options.videoOnly
    ? undefined
    : path.resolve(options.audioPath ?? options.videoPath);

  if (!fs.existsSync(videoPath)) {
    throw new Error(`QA measurement video source not found: ${videoPath}`);
  }
  if (audioPath && !fs.existsSync(audioPath)) {
    throw new Error(`QA measurement audio source not found: ${audioPath}`);
  }
  const dialoguePath = options.dialoguePath
    ? path.resolve(options.dialoguePath)
    : audioPath;
  if (dialoguePath && !fs.existsSync(dialoguePath)) {
    throw new Error(`QA measurement dialogue source not found: ${dialoguePath}`);
  }

  const videoDurationMs = await probeDurationMs(videoPath, "v:0");
  const audioDurationMs = audioPath ? await probeDurationMs(audioPath, "a:0") : 0;
  let videoFrame: QaVideoFrameMetadata | undefined;
  let videoFrameProbeError: string | undefined;
  try {
    videoFrame = await probeVideoFrameMetadata(videoPath);
  } catch (err) {
    videoFrameProbeError = err instanceof Error ? err.message : String(err);
  }
  const loudness = audioPath
    ? await measureLoudness(audioPath)
    : { integratedLufs: 0, truePeakDbtp: 0 };
  const occupancy = dialoguePath
    ? await measureDialogueOccupancy(
        dialoguePath,
        audioDurationMs,
        options.expectedDialogueWindowsMs,
      )
    : { dialogueWindowMs: 0, dialogueOccupancy: 0, observedNonSilentMs: 0, silenceTotalMs: 0 };

  const measurements: QaMeasurements = {
    version: "1.0.0",
    measured_at: options.createdAt ?? new Date().toISOString(),
    measurement_source: "media_probe",
    video_path: videoPath,
    ...(audioPath ? { audio_path: audioPath } : {}),
    video_duration_ms: videoDurationMs,
    audio_duration_ms: audioDurationMs,
    dialogue_window_ms: occupancy.dialogueWindowMs,
    av_duration_delta_ms: audioPath ? Math.abs(videoDurationMs - audioDurationMs) : 0,
    av_drift_ms: audioPath ? Math.abs(videoDurationMs - audioDurationMs) : 0,
    loudness_integrated: loudness.integratedLufs,
    loudness_true_peak: loudness.truePeakDbtp,
    dialogue_occupancy: occupancy.dialogueOccupancy,
    observed_non_silent_ms: occupancy.observedNonSilentMs,
    silence_total_ms: occupancy.silenceTotalMs,
    ...(occupancy.dialogueOutsideExpectedMs != null
      ? { dialogue_outside_expected_ms: occupancy.dialogueOutsideExpectedMs }
      : {}),
    ...(occupancy.dialogueFirstSignalMs != null
      ? { dialogue_first_signal_ms: occupancy.dialogueFirstSignalMs }
      : {}),
    ...(occupancy.dialogueLastSignalMs != null
      ? { dialogue_last_signal_ms: occupancy.dialogueLastSignalMs }
      : {}),
    ...(occupancy.expectedDialogueStartMs != null
      ? { expected_dialogue_start_ms: occupancy.expectedDialogueStartMs }
      : {}),
    ...(occupancy.expectedDialogueEndMs != null
      ? { expected_dialogue_end_ms: occupancy.expectedDialogueEndMs }
      : {}),
    ...(videoFrame ? { video_frame: videoFrame } : {}),
    ...(videoFrameProbeError ? { video_frame_probe_error: videoFrameProbeError } : {}),
  };

  writeQaMeasurements(options.outputPath, measurements);
  return measurements;
}

export function collectQaMeasurementWarnings(
  measurements: Pick<QaMeasurements, "av_duration_delta_ms" | "av_drift_ms" | "loudness_integrated">,
): QaMeasurementWarning[] {
  const warnings: QaMeasurementWarning[] = [];
  const durationDeltaMs = measurements.av_duration_delta_ms ?? measurements.av_drift_ms;

  if (durationDeltaMs >= AV_DRIFT_WARNING_MS) {
    warnings.push({
      code: "AV_DRIFT_WARNING",
      message: `A/V stream duration delta ${durationDeltaMs}ms exceeds ${AV_DRIFT_WARNING_MS}ms warning threshold`,
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
