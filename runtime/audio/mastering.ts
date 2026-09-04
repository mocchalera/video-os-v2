/**
 * Loudnorm 2-pass mastering via ffmpeg.
 *
 * Per milestone-4-design §Mastering:
 * - Pass 1: measure loudness (loudnorm print_format=json)
 * - Pass 2: apply loudnorm with measured values + linear=true
 * - Target: -16 LUFS, LRA 7, TP -1.5 dBTP
 */

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";

// ── Types ──────────────────────────────────────────────────────────

export interface MasteringDefaults {
  loudness_target_lufs: number;
  lra_target: number;
  true_peak_target_dbtp: number;
}

export const DEFAULT_MASTERING: MasteringDefaults = {
  loudness_target_lufs: -16,
  lra_target: 7,
  true_peak_target_dbtp: -1.5,
};

export const MASTERING_SAMPLE_RATE_HZ = 48_000;

export interface LoudnormMeasurement {
  input_i: string;
  input_tp: string;
  input_lra: string;
  input_thresh: string;
  target_offset: string;
}

export type EncodedAudioEvidenceStatus = "verified" | "unavailable" | "failed" | "not_run";

export interface EncodedAudioMeasurement {
  version: "encoded-audio-measurement/v1";
  status: EncodedAudioEvidenceStatus;
  path: string;
  content_hash: string | null;
  container: {
    format_name: string | null;
    format_long_name: string | null;
  };
  audio_stream: {
    codec_name: string | null;
    codec_long_name: string | null;
    sample_rate_hz: number | null;
    channels: number | null;
    channel_layout: string | null;
    bit_rate: number | null;
    duration_sec: number | null;
    start_time_sec: number | null;
  };
  video_stream: {
    codec_name: string | null;
    duration_sec: number | null;
    start_time_sec: number | null;
  } | null;
  duration_and_sync: {
    audio_duration_sec: number | null;
    video_duration_sec: number | null;
    duration_delta_sec: number | null;
    audio_start_time_sec: number | null;
    video_start_time_sec: number | null;
    start_time_delta_sec: number | null;
    status: "measured" | "not_applicable" | "unavailable";
  };
  loudness: {
    status: "measured" | "unavailable" | "failed";
    method: "ffmpeg_loudnorm_pass1" | "unavailable";
    integrated_lufs: number | null;
    short_term_lufs: number | null;
    lra_lu: number | null;
    true_peak_dbtp: number | null;
    raw: LoudnormMeasurement | null;
    notes: string[];
  };
  diagnostics: {
    clipping: { status: "not_run" | "measured" | "unavailable"; reason: string };
    silence: { status: "not_run" | "measured" | "unavailable"; reason: string };
    dropout: { status: "not_run" | "measured" | "unavailable"; reason: string };
    channel: { status: "not_run" | "measured" | "unavailable"; reason: string };
    phase: { status: "not_run" | "measured" | "unavailable"; reason: string };
  };
  playback: {
    mono_fold_down: {
      status: "verified" | "unavailable" | "not_run";
      method: string;
      evidence: string | null;
    };
    mobile: {
      status: "human_required";
      method: "human_audition";
      evidence: string | null;
    };
  };
  speech_intelligibility: {
    status: "not_claimed";
    proxies: string[];
    human_audition_required: boolean;
  };
  human_audition: {
    required: boolean;
    status: "pending" | "accepted" | "rejected" | "not_recorded";
    record_ref?: string;
    notes?: string;
  };
  mastering: {
    owner: string;
    stage: string;
    pass_count: number;
    applied_processing: string[];
  };
  tool_availability: {
    ffprobe: "available" | "unavailable";
    ffmpeg: "available" | "unavailable";
  };
  error?: {
    tool: "ffprobe" | "ffmpeg";
    code?: string;
    message: string;
  };
  warnings: string[];
}

export interface EncodedAudioMeasurementOptions {
  path: string;
  expectedTimelineDurationSec?: number;
  humanAuditionRequired?: boolean;
  humanAudition?: Partial<EncodedAudioMeasurement["human_audition"]>;
  mastering?: Partial<EncodedAudioMeasurement["mastering"]>;
  runMonoFoldDown?: boolean;
  silenceThresholdDb?: number;
}

export interface AudioDiagnosticCommandOptions {
  silenceThresholdDb: number;
}

// ── Pass 1: Measurement ────────────────────────────────────────────

/**
 * Build ffmpeg args for loudnorm pass 1 (measurement).
 *
 * Returns args for: ffmpeg -i <input> -af loudnorm=I=...:LRA=...:TP=...:print_format=json -f null -
 */
export function buildLoudnormPass1Args(
  inputPath: string,
  defaults?: MasteringDefaults,
): string[] {
  const d = defaults ?? DEFAULT_MASTERING;
  return [
    "-i", inputPath,
    "-af", `loudnorm=I=${d.loudness_target_lufs}:LRA=${d.lra_target}:TP=${d.true_peak_target_dbtp}:print_format=json`,
    "-f", "null",
    "-",
  ];
}

// ── Parse Measurement Output ───────────────────────────────────────

/**
 * Parse loudnorm pass 1 output (JSON from stderr).
 *
 * ffmpeg writes the loudnorm JSON block to stderr. This function
 * extracts the JSON object containing the measurement values.
 */
export function parseLoudnormOutput(stderr: string): LoudnormMeasurement {
  // The loudnorm JSON block is embedded in ffmpeg's stderr output.
  // It looks like:
  // {
  //   "input_i" : "-20.50",
  //   "input_tp" : "-3.01",
  //   ...
  // }
  const jsonMatch = stderr.match(/\{[^{}]*"input_i"\s*:[^{}]*\}/s);
  if (!jsonMatch) {
    throw new Error("Could not find loudnorm JSON in ffmpeg output");
  }

  const parsed = JSON.parse(jsonMatch[0]);

  return {
    input_i: String(parsed.input_i),
    input_tp: String(parsed.input_tp),
    input_lra: String(parsed.input_lra),
    input_thresh: String(parsed.input_thresh),
    target_offset: String(parsed.target_offset),
  };
}

// ── Pass 2: Apply ──────────────────────────────────────────────────

/**
 * Build ffmpeg args for loudnorm pass 2 (apply).
 *
 * Uses the measured values from pass 1 to apply precise loudness normalization
 * with linear=true for highest quality.
 */
export function buildLoudnormPass2Args(
  inputPath: string,
  outputPath: string,
  measurement: LoudnormMeasurement,
  defaults?: MasteringDefaults,
): string[] {
  const d = defaults ?? DEFAULT_MASTERING;
  const filterStr = [
    `loudnorm=I=${d.loudness_target_lufs}`,
    `LRA=${d.lra_target}`,
    `TP=${d.true_peak_target_dbtp}`,
    `measured_I=${measurement.input_i}`,
    `measured_LRA=${measurement.input_lra}`,
    `measured_TP=${measurement.input_tp}`,
    `measured_thresh=${measurement.input_thresh}`,
    `offset=${measurement.target_offset}`,
    "linear=true",
  ].join(":");

  return [
    "-y",
    "-i", inputPath,
    "-af", filterStr,
    "-ar", String(MASTERING_SAMPLE_RATE_HZ),
    outputPath,
  ];
}

// ── 2-Pass Mastering ───────────────────────────────────────────────

/**
 * Helper: run ffmpeg with given args, returning stdout + stderr.
 */
function execFfmpeg(
  args: string[],
  allowMeasurementOnError = false,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      "ffmpeg",
      args,
      { maxBuffer: 50 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          if (allowMeasurementOnError && /"input_i"\s*:/.test(stderr ?? "")) {
            resolve({ stdout: stdout ?? "", stderr: stderr ?? "" });
            return;
          }
          reject(Object.assign(
            new Error(`ffmpeg loudnorm failed: ${stderr || err.message}`),
            { code: (err as NodeJS.ErrnoException).code },
          ));
          return;
        }
        resolve({ stdout: stdout ?? "", stderr: stderr ?? "" });
      },
    );
  });
}

/**
 * Run 2-pass mastering (executes ffmpeg).
 *
 * Pass 1: Measure loudness characteristics.
 * Pass 2: Apply loudnorm with measured values for precise normalization.
 */
export async function masterAudio(
  inputPath: string,
  outputPath: string,
  defaults?: MasteringDefaults,
): Promise<{ measurement: LoudnormMeasurement }> {
  const measurement = await measureAudioLoudness(inputPath, defaults);

  // Pass 2: Apply
  const pass2Args = buildLoudnormPass2Args(inputPath, outputPath, measurement, defaults);
  await execFfmpeg(pass2Args);
  if (!fs.existsSync(outputPath)) {
    throw new Error(`ffmpeg loudnorm did not produce output: ${outputPath}`);
  }

  return { measurement };
}

/** Measure loudness without changing or producing an audio stream. */
export async function measureAudioLoudness(
  inputPath: string,
  defaults?: MasteringDefaults,
): Promise<LoudnormMeasurement> {
  const pass1Args = buildLoudnormPass1Args(inputPath, defaults);
  const pass1Result = await execFfmpeg(pass1Args, true);
  return parseLoudnormOutput(pass1Result.stderr);
}

function finiteNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string" || value.trim().length === 0) return null;
  if (value.trim().toLowerCase() === "-inf" || value.trim().toLowerCase() === "inf") return null;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function hashIfReadable(filePath: string): string | null {
  let fd: number | undefined;
  try {
    const hash = createHash("sha256");
    fd = fs.openSync(filePath, "r");
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let bytesRead = 0;
    do {
      bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (bytesRead > 0) hash.update(buffer.subarray(0, bytesRead));
    } while (bytesRead > 0);
    return `sha256:${hash.digest("hex")}`;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function execTool(
  command: string,
  args: string[],
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { maxBuffer: 50 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        const typed = error as NodeJS.ErrnoException;
        reject(Object.assign(new Error(stderr?.trim() || error.message), { code: typed.code }));
        return;
      }
      resolve({ stdout: stdout ?? "", stderr: stderr ?? "" });
    });
  });
}

export function buildEncodedAudioProbeArgs(inputPath: string): string[] {
  return [
    "-v", "error",
    "-show_entries",
    "stream=index,codec_type,codec_name,codec_long_name,sample_rate,channels,channel_layout,bit_rate,duration,start_time:format=format_name,format_long_name,duration",
    "-of", "json",
    inputPath,
  ];
}

export function buildMonoFoldDownArgs(inputPath: string): string[] {
  return [
    "-hide_banner",
    "-nostdin",
    "-i", inputPath,
    "-map", "0:a:0",
    "-af", "pan=mono|c0=0.5*c0+0.5*c1",
    "-f", "null",
    "-",
  ];
}

export function buildAudioDiagnosticArgs(
  inputPath: string,
  options: AudioDiagnosticCommandOptions,
): string[] {
  return [
    "-hide_banner",
    "-nostdin",
    "-i", inputPath,
    "-map", "0:a:0",
    "-af", `silencedetect=noise=${options.silenceThresholdDb}dB:d=0.5,astats=metadata=1:reset=1`,
    "-f", "null",
    "-",
  ];
}

function emptyEncodedMeasurement(
  inputPath: string,
  status: EncodedAudioEvidenceStatus,
  warnings: string[],
  ffprobe: "available" | "unavailable",
  ffmpeg: "available" | "unavailable",
  humanRequired: boolean,
  humanAudition?: Partial<EncodedAudioMeasurement["human_audition"]>,
  mastering?: Partial<EncodedAudioMeasurement["mastering"]>,
  error?: EncodedAudioMeasurement["error"],
): EncodedAudioMeasurement {
  return {
    version: "encoded-audio-measurement/v1",
    status,
    path: inputPath,
    content_hash: hashIfReadable(inputPath),
    container: { format_name: null, format_long_name: null },
    audio_stream: {
      codec_name: null,
      codec_long_name: null,
      sample_rate_hz: null,
      channels: null,
      channel_layout: null,
      bit_rate: null,
      duration_sec: null,
      start_time_sec: null,
    },
    video_stream: null,
    duration_and_sync: {
      audio_duration_sec: null,
      video_duration_sec: null,
      duration_delta_sec: null,
      audio_start_time_sec: null,
      video_start_time_sec: null,
      start_time_delta_sec: null,
      status: "unavailable",
    },
    loudness: {
      status: "unavailable",
      method: "unavailable",
      integrated_lufs: null,
      short_term_lufs: null,
      lra_lu: null,
      true_peak_dbtp: null,
      raw: null,
      notes: ["encoded loudness could not be measured"],
    },
    diagnostics: {
      clipping: { status: "not_run", reason: "diagnostic pass was not run" },
      silence: { status: "not_run", reason: "diagnostic pass was not run" },
      dropout: { status: "not_run", reason: "diagnostic pass was not run" },
      channel: { status: "not_run", reason: "diagnostic pass was not run" },
      phase: { status: "not_run", reason: "diagnostic pass was not run" },
    },
    playback: {
      mono_fold_down: { status: "not_run", method: "ffmpeg pan mono fixture", evidence: null },
      mobile: { status: "human_required", method: "human_audition", evidence: null },
    },
    speech_intelligibility: {
      status: "not_claimed",
      proxies: [],
      human_audition_required: humanRequired,
    },
    human_audition: {
      required: humanRequired,
      status: "pending",
      ...humanAudition,
    },
    mastering: {
      owner: "unknown",
      stage: "unknown",
      pass_count: 0,
      applied_processing: [],
      ...mastering,
    },
    tool_availability: { ffprobe, ffmpeg },
    ...(error ? { error } : {}),
    warnings,
  };
}

/**
 * Measure the encoded audio result. This intentionally reports machine
 * observations and leaves audition/voice-quality acceptance to a human.
 * Missing optional ffmpeg/ffprobe tooling produces explicit unavailable
 * evidence instead of blocking the render route.
 */
export async function measureEncodedAudioResult(
  options: EncodedAudioMeasurementOptions,
): Promise<EncodedAudioMeasurement> {
  const inputPath = options.path;
  const humanRequired = options.humanAuditionRequired ?? true;
  let probe: Record<string, unknown>;
  try {
    const result = await execTool("ffprobe", buildEncodedAudioProbeArgs(inputPath));
    probe = JSON.parse(result.stdout) as Record<string, unknown>;
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error
      ? String((error as { code?: unknown }).code)
      : "";
    const unavailable = code === "ENOENT";
    const message = error instanceof Error ? error.message : String(error);
    const errorEvidence: EncodedAudioMeasurement["error"] = {
      tool: "ffprobe",
      ...(code ? { code } : {}),
      message,
    };
    return emptyEncodedMeasurement(
      inputPath,
      unavailable ? "unavailable" : "failed",
      [unavailable
        ? `ffprobe is unavailable (${code || "unknown"}); encoded QA is on HOLD: ${message}`
        : `ffprobe output was unavailable or invalid: ${message}`],
      unavailable ? "unavailable" : "available",
      unavailable ? "unavailable" : "available",
      humanRequired,
      options.humanAudition,
      options.mastering,
      errorEvidence,
    );
  }

  const streams = Array.isArray(probe.streams) ? probe.streams as Array<Record<string, unknown>> : [];
  const audio = streams.find((stream) => stream.codec_type === "audio");
  const video = streams.find((stream) => stream.codec_type === "video");
  if (!audio) {
    return emptyEncodedMeasurement(
      inputPath,
      "failed",
      ["encoded result has no audio stream"],
      "available",
      "available",
      humanRequired,
      options.humanAudition,
      options.mastering,
    );
  }

  const format = (probe.format && typeof probe.format === "object" ? probe.format : {}) as Record<string, unknown>;
  const audioDuration = finiteNumber(audio.duration);
  const videoDuration = video ? finiteNumber(video.duration) : null;
  const audioStart = finiteNumber(audio.start_time);
  const videoStart = video ? finiteNumber(video.start_time) : null;
  const durationDelta = audioDuration !== null && videoDuration !== null
    ? Number((audioDuration - videoDuration).toFixed(6))
    : null;
  const startDelta = audioStart !== null && videoStart !== null
    ? Number((audioStart - videoStart).toFixed(6))
    : null;
  const warnings: string[] = [];
  if (options.expectedTimelineDurationSec !== undefined && audioDuration !== null) {
    warnings.push(`timeline duration comparison delta_sec=${(audioDuration - options.expectedTimelineDurationSec).toFixed(6)}; no universal pass threshold applied`);
  }

  let loudness: EncodedAudioMeasurement["loudness"] = {
    status: "unavailable",
    method: "unavailable",
    integrated_lufs: null,
    short_term_lufs: null,
    lra_lu: null,
    true_peak_dbtp: null,
    raw: null,
    notes: [],
  };
  let ffmpegStatus: "available" | "unavailable" = "available";
  let measurementError: EncodedAudioMeasurement["error"] | undefined;
  try {
    const raw = await measureAudioLoudness(inputPath);
    loudness = {
      status: "measured",
      method: "ffmpeg_loudnorm_pass1",
      integrated_lufs: finiteNumber(raw.input_i),
      short_term_lufs: null,
      lra_lu: finiteNumber(raw.input_lra),
      true_peak_dbtp: finiteNumber(raw.input_tp),
      raw,
      notes: ["short-term loudness was not emitted by the existing loudnorm parser"],
    };
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error
      ? String((error as { code?: unknown }).code)
      : "";
    ffmpegStatus = code === "ENOENT" ? "unavailable" : "available";
    const message = error instanceof Error ? error.message : String(error);
    const errorEvidence: EncodedAudioMeasurement["error"] = {
      tool: "ffmpeg",
      ...(code ? { code } : {}),
      message,
    };
    loudness.notes.push(ffmpegStatus === "unavailable"
      ? `ffmpeg is unavailable (${code || "unknown"}); encoded loudness is on HOLD: ${message}`
      : `ffmpeg loudnorm measurement failed: ${message}`);
    warnings.push(loudness.notes[loudness.notes.length - 1]);
    loudness.status = ffmpegStatus === "unavailable" ? "unavailable" : "failed";
    measurementError = errorEvidence;
  }

  let mono: EncodedAudioMeasurement["playback"]["mono_fold_down"] = {
    status: "not_run",
    method: "ffmpeg pan mono fixture",
    evidence: null,
  };
  if (options.runMonoFoldDown !== false && Number(audio.channels ?? 0) >= 2) {
    try {
      await execTool("ffmpeg", buildMonoFoldDownArgs(inputPath));
      mono = { status: "verified", method: "ffmpeg pan mono fixture completed", evidence: "machine fold-down command completed" };
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error
        ? String((error as { code?: unknown }).code)
        : "";
      const message = error instanceof Error ? error.message : String(error);
      warnings.push(`mono fold-down unavailable/failed (${code || "unknown"}): ${message}`);
      mono = {
        status: code === "ENOENT" ? "unavailable" : "not_run",
        method: "ffmpeg pan mono fixture",
        evidence: code === "ENOENT" ? `ffmpeg unavailable (${code}): ${message}` : `fold-down command failed: ${message}`,
      };
    }
  } else if (Number(audio.channels ?? 0) < 2) {
    mono = { status: "verified", method: "mono input; fold-down is identity", evidence: "machine channel inspection" };
  }

  let diagnostics: EncodedAudioMeasurement["diagnostics"] = {
    clipping: { status: "not_run" as const, reason: "no clipping threshold was asserted" },
    silence: { status: "not_run" as const, reason: "no silence threshold was asserted" },
    dropout: { status: "not_run" as const, reason: "dropout detector not requested" },
    channel: { status: "measured" as const, reason: "ffprobe reported audio channel count and layout" },
    phase: { status: "not_run" as const, reason: "phase detector not requested" },
  };
  if (options.silenceThresholdDb !== undefined) {
    try {
      const diagnosticResult = await execTool(
        "ffmpeg",
        buildAudioDiagnosticArgs(inputPath, { silenceThresholdDb: options.silenceThresholdDb }),
      );
      const silenceEvents = (diagnosticResult.stderr.match(/silence_(?:start|end)/g) ?? []).length;
      diagnostics = {
        ...diagnostics,
        clipping: { status: "measured", reason: "astats diagnostic completed; no clipping claim was inferred" },
        silence: { status: "measured", reason: `silencedetect completed events=${silenceEvents}; no universal silence threshold was asserted` },
      };
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error
        ? String((error as { code?: unknown }).code)
        : "";
      diagnostics = {
        ...diagnostics,
        clipping: { status: code === "ENOENT" ? "unavailable" : "not_run", reason: code === "ENOENT" ? "ffmpeg unavailable" : "diagnostic command failed" },
        silence: { status: code === "ENOENT" ? "unavailable" : "not_run", reason: code === "ENOENT" ? "ffmpeg unavailable" : "diagnostic command failed" },
      };
    }
  }
  const result: EncodedAudioMeasurement = {
    version: "encoded-audio-measurement/v1",
    status: "verified",
    path: inputPath,
    content_hash: hashIfReadable(inputPath),
    container: {
      format_name: typeof format.format_name === "string" ? format.format_name : null,
      format_long_name: typeof format.format_long_name === "string" ? format.format_long_name : null,
    },
    audio_stream: {
      codec_name: typeof audio.codec_name === "string" ? audio.codec_name : null,
      codec_long_name: typeof audio.codec_long_name === "string" ? audio.codec_long_name : null,
      sample_rate_hz: finiteNumber(audio.sample_rate),
      channels: finiteNumber(audio.channels),
      channel_layout: typeof audio.channel_layout === "string" ? audio.channel_layout : null,
      bit_rate: finiteNumber(audio.bit_rate),
      duration_sec: audioDuration,
      start_time_sec: audioStart,
    },
    video_stream: video
      ? {
          codec_name: typeof video.codec_name === "string" ? video.codec_name : null,
          duration_sec: videoDuration,
          start_time_sec: videoStart,
        }
      : null,
    duration_and_sync: {
      audio_duration_sec: audioDuration,
      video_duration_sec: videoDuration,
      duration_delta_sec: durationDelta,
      audio_start_time_sec: audioStart,
      video_start_time_sec: videoStart,
      start_time_delta_sec: startDelta,
      status: video ? "measured" : "not_applicable",
    },
    loudness,
    diagnostics,
    playback: {
      mono_fold_down: mono,
      mobile: { status: "human_required", method: "human_audition", evidence: null },
    },
    speech_intelligibility: {
      status: "not_claimed",
      proxies: ["encoded format and loudness fields only; no perceptual intelligibility claim"],
      human_audition_required: humanRequired,
    },
    human_audition: {
      required: humanRequired,
      status: "pending",
      ...options.humanAudition,
    },
    mastering: {
      owner: "unknown",
      stage: "unknown",
      pass_count: 0,
      applied_processing: [],
      ...options.mastering,
    },
    tool_availability: { ffprobe: "available", ffmpeg: ffmpegStatus },
    ...(measurementError ? { error: measurementError } : {}),
    warnings,
  };
  if (loudness.status !== "measured") {
    result.status = ffmpegStatus === "unavailable" ? "unavailable" : "failed";
  }
  return result;
}

/** Alias used by render/report callers that describe the input as a deliverable. */
export const measureEncodedDeliverableAudio = measureEncodedAudioResult;
