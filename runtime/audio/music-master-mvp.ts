/**
 * Small, fixed Issue #38 music-master MVP.
 *
 * This module deliberately owns only the closed policy, the deterministic
 * ffmpeg graph, capability checks, and measured WAV/MP3 execution. The
 * canonical source/plan/receipt/package identities remain owned by the
 * shared AudioRenderPlan route.
 */

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";

import {
  MASTERING_SAMPLE_RATE_HZ,
  parseLoudnormOutput,
  type LoudnormMeasurement,
} from "./mastering.js";

export interface MusicMasterMvpPolicy {
  version: "music-master-mvp-policy/v1";
  cleanup: {
    highpass_hz: 35;
    cut_280_hz: { q: 1.5; gain_db: -2 };
    boost_100_hz: { q: 1.2; gain_db: 1.8 };
  };
  presence_air: {
    presence_3200_hz: { q: 1.2; gain_db: 2.5 };
    air_12000_hz: { q: 1; gain_db: 2.2 };
  };
  spatial_glue: {
    stereo_width_percent: 120;
    compand: "soft_knee_multiband";
    compand_args: string;
  };
  loudnorm: {
    target_lufs: -13.3;
    lra_target: 11;
    processing_true_peak_dbtp: -2;
    acceptance_true_peak_dbtp: -1;
    loudness_tolerance_lufs: 0.5;
  };
}

const MULTIBAND_COMPAND_ARGS = [
  "0.02,0.25 3 -60/-60,-30/-27.5,-10/-10 120",
  "0.01,0.2 3 -60/-60,-30/-28,-10/-10 8000",
  "0.002,0.1 3 -60/-60,-30/-28,-10/-10 22000",
].join("|");

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== "object") return value;
  Object.freeze(value);
  for (const child of Object.values(value as Record<string, unknown>)) {
    if (child && typeof child === "object" && !Object.isFrozen(child)) deepFreeze(child);
  }
  return value;
}

export const MUSIC_MASTER_MVP_POLICY = deepFreeze({
  version: "music-master-mvp-policy/v1",
  cleanup: {
    highpass_hz: 35,
    cut_280_hz: { q: 1.5, gain_db: -2 },
    boost_100_hz: { q: 1.2, gain_db: 1.8 },
  },
  presence_air: {
    presence_3200_hz: { q: 1.2, gain_db: 2.5 },
    air_12000_hz: { q: 1, gain_db: 2.2 },
  },
  spatial_glue: {
    stereo_width_percent: 120,
    compand: "soft_knee_multiband",
    compand_args: MULTIBAND_COMPAND_ARGS,
  },
  loudnorm: {
    target_lufs: -13.3,
    lra_target: 11,
    processing_true_peak_dbtp: -2,
    acceptance_true_peak_dbtp: -1,
    loudness_tolerance_lufs: 0.5,
  },
} satisfies MusicMasterMvpPolicy);

function normalized(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalized);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right, "en"))
      .map(([key, entry]) => [key, normalized(entry)]),
  );
}

export function hashMusicMasterMvpPolicy(
  policy: MusicMasterMvpPolicy = MUSIC_MASTER_MVP_POLICY,
): string {
  return `sha256:${createHash("sha256")
    .update(JSON.stringify(normalized(policy)))
    .digest("hex")}`;
}

export function assertMusicMasterMvpPolicy(policy: unknown): asserts policy is MusicMasterMvpPolicy {
  if (JSON.stringify(normalized(policy)) !== JSON.stringify(normalized(MUSIC_MASTER_MVP_POLICY))) {
    throw new MusicMasterMvpError(
      "POLICY_MISMATCH",
      "Issue #38 music_master mastering policy is fixed; runtime policy overrides are rejected",
    );
  }
}

function formatNumber(value: number): string {
  return String(value);
}

function formatSeconds(microseconds: number): string {
  return formatNumber(microseconds / 1_000_000);
}

export function buildMusicMasterMvpToneFilterChain(
  policy: MusicMasterMvpPolicy = MUSIC_MASTER_MVP_POLICY,
): string {
  assertMusicMasterMvpPolicy(policy);
  return [
    `highpass=f=${formatNumber(policy.cleanup.highpass_hz)}:p=2`,
    `equalizer=f=280:t=q:w=${formatNumber(policy.cleanup.cut_280_hz.q)}:g=${formatNumber(policy.cleanup.cut_280_hz.gain_db)}`,
    `equalizer=f=100:t=q:w=${formatNumber(policy.cleanup.boost_100_hz.q)}:g=${formatNumber(policy.cleanup.boost_100_hz.gain_db)}`,
    `equalizer=f=3200:t=q:w=${formatNumber(policy.presence_air.presence_3200_hz.q)}:g=${formatNumber(policy.presence_air.presence_3200_hz.gain_db)}`,
    `equalizer=f=12000:t=q:w=${formatNumber(policy.presence_air.air_12000_hz.q)}:g=${formatNumber(policy.presence_air.air_12000_hz.gain_db)}`,
    `extrastereo=m=${formatNumber(policy.spatial_glue.stereo_width_percent / 100)}:c=false`,
    `mcompand='${policy.spatial_glue.compand_args}'`,
  ].join(",");
}

export function buildMusicMasterMvpPass1Filter(
  policy: MusicMasterMvpPolicy = MUSIC_MASTER_MVP_POLICY,
): string {
  return [
    buildMusicMasterMvpToneFilterChain(policy),
    `loudnorm=I=${formatNumber(policy.loudnorm.target_lufs)}:LRA=${formatNumber(policy.loudnorm.lra_target)}:TP=${formatNumber(policy.loudnorm.processing_true_peak_dbtp)}:print_format=json`,
  ].join(",");
}

export function buildMusicMasterMvpPass2Filter(
  measurement: LoudnormMeasurement,
  policy: MusicMasterMvpPolicy = MUSIC_MASTER_MVP_POLICY,
): string {
  assertFiniteMeasurement(measurement, "pass1");
  return [
    buildMusicMasterMvpToneFilterChain(policy),
    [
      `loudnorm=I=${formatNumber(policy.loudnorm.target_lufs)}`,
      `LRA=${formatNumber(policy.loudnorm.lra_target)}`,
      `TP=${formatNumber(policy.loudnorm.processing_true_peak_dbtp)}`,
      `measured_I=${measurement.input_i}`,
      `measured_LRA=${measurement.input_lra}`,
      `measured_TP=${measurement.input_tp}`,
      `measured_thresh=${measurement.input_thresh}`,
      `offset=${measurement.target_offset}`,
      "linear=true",
    ].join(":"),
  ].join(",");
}

export function buildMusicMasterMvpPass1Args(
  inputPath: string,
  sourceRangeUs: { in_us: number; out_us: number },
  policy: MusicMasterMvpPolicy = MUSIC_MASTER_MVP_POLICY,
): string[] {
  return [
    "-hide_banner",
    "-nostdin",
    "-ss", formatSeconds(sourceRangeUs.in_us),
    "-t", formatSeconds(sourceRangeUs.out_us - sourceRangeUs.in_us),
    "-i", inputPath,
    "-map", "0:a:0",
    "-vn",
    "-af", buildMusicMasterMvpPass1Filter(policy),
    "-f", "null",
    "-",
  ];
}

export function buildMusicMasterMvpPass2Args(
  inputPath: string,
  outputPath: string,
  sourceRangeUs: { in_us: number; out_us: number },
  measurement: LoudnormMeasurement,
  policy: MusicMasterMvpPolicy = MUSIC_MASTER_MVP_POLICY,
): string[] {
  return [
    "-hide_banner",
    "-nostdin",
    "-y",
    "-ss", formatSeconds(sourceRangeUs.in_us),
    "-t", formatSeconds(sourceRangeUs.out_us - sourceRangeUs.in_us),
    "-i", inputPath,
    "-map", "0:a:0",
    "-vn",
    "-af", buildMusicMasterMvpPass2Filter(measurement, policy),
    "-ar", String(MASTERING_SAMPLE_RATE_HZ),
    "-ac", "2",
    "-c:a", "pcm_s24le",
    outputPath,
  ];
}

function buildOutputMeasurementArgs(
  inputPath: string,
  policy: MusicMasterMvpPolicy,
): string[] {
  return [
    "-hide_banner",
    "-nostdin",
    "-i", inputPath,
    "-map", "0:a:0",
    "-vn",
    "-af", `loudnorm=I=${formatNumber(policy.loudnorm.target_lufs)}:LRA=${formatNumber(policy.loudnorm.lra_target)}:TP=${formatNumber(policy.loudnorm.acceptance_true_peak_dbtp)}:print_format=json`,
    "-f", "null",
    "-",
  ];
}

function buildMp3EncodeArgs(inputPath: string, outputPath: string): string[] {
  return [
    "-hide_banner",
    "-nostdin",
    "-y",
    "-i", inputPath,
    "-map", "0:a:0",
    "-vn",
    "-ar", String(MASTERING_SAMPLE_RATE_HZ),
    "-ac", "2",
    "-c:a", "libmp3lame",
    "-b:a", "320k",
    "-write_xing", "0",
    outputPath,
  ];
}

export interface MusicMasterMvpMeasurement {
  raw: LoudnormMeasurement;
  integrated_lufs: number;
  lra_lu: number;
  true_peak_dbtp: number;
}

export interface MusicMasterMvpAudioEvidence {
  content_hash: string;
  size_bytes: number;
  codec: "pcm_s24le" | "mp3";
  sample_rate_hz: 48_000;
  channels: 2;
  bit_depth: number | null;
  bit_rate_bps: number | null;
}

export interface MusicMasterMvpExecutionGraph {
  version: "music-master-mvp-graph/v1";
  stages: [
    "cleanup",
    "presence_air",
    "spatial_glue",
    "loudnorm_pass1",
    "loudnorm_pass2",
    "wav24",
    "mp3_320",
  ];
  tone_filter_chain: string;
  pass1_filter: string;
  pass2_filter: string;
  wav_codec: {
    codec: "pcm_s24le";
    bit_depth: 24;
    sample_rate_hz: 48_000;
    channels: 2;
  };
  mp3_codec: {
    codec: "mp3";
    encoder: "libmp3lame";
    bit_rate_bps: 320_000;
    sample_rate_hz: 48_000;
    channels: 2;
  };
}

export interface MusicMasterMvpExecution {
  execution_graph: MusicMasterMvpExecutionGraph;
  pass1: MusicMasterMvpMeasurement;
  pass2: MusicMasterMvpMeasurement;
  mp3: MusicMasterMvpMeasurement;
  wav: MusicMasterMvpAudioEvidence;
  mp3_output: MusicMasterMvpAudioEvidence;
}

export type MusicMasterMvpErrorCode =
  | "POLICY_MISMATCH"
  | "UNSUPPORTED_TOOLCHAIN"
  | "MEASUREMENT_INVALID"
  | "FORMAT_INVALID"
  | "OUTPUT_EXISTS"
  | "OUTPUT_REJECTED"
  | "EXECUTION_FAILED";

export class MusicMasterMvpError extends Error {
  constructor(readonly code: MusicMasterMvpErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = "MusicMasterMvpError";
  }
}

interface CommandResult {
  stdout: string;
  stderr: string;
}

function runCommand(command: string, args: string[]): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { maxBuffer: 100 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        reject(Object.assign(new Error(stderr?.trim() || error.message), {
          code: (error as NodeJS.ErrnoException).code,
        }));
        return;
      }
      resolve({ stdout: stdout ?? "", stderr: stderr ?? "" });
    });
  });
}

const REQUIRED_FILTERS = ["highpass", "equalizer", "extrastereo", "mcompand", "loudnorm"] as const;

function listingHas(listing: string, name: string): boolean {
  return new RegExp(`^\\s*\\S+\\s+${name}(?:\\s|$)`, "m").test(listing);
}

async function assertToolchain(
  ffmpegBin: string,
  ffprobeBin: string,
): Promise<void> {
  try {
    await runCommand(ffmpegBin, ["-version"]);
    await runCommand(ffprobeBin, ["-version"]);
    const [filters, encoders] = await Promise.all([
      runCommand(ffmpegBin, ["-hide_banner", "-filters"]),
      runCommand(ffmpegBin, ["-hide_banner", "-encoders"]),
    ]);
    const missingFilters = REQUIRED_FILTERS.filter((name) => !listingHas(filters.stdout + filters.stderr, name));
    const missingEncoders = ["pcm_s24le", "libmp3lame"].filter(
      (name) => !listingHas(encoders.stdout + encoders.stderr, name),
    );
    if (missingFilters.length > 0 || missingEncoders.length > 0) {
      throw new MusicMasterMvpError(
        "UNSUPPORTED_TOOLCHAIN",
        `required ffmpeg capabilities are missing filters=${missingFilters.join(",") || "none"} encoders=${missingEncoders.join(",") || "none"}`,
      );
    }
  } catch (error) {
    if (error instanceof MusicMasterMvpError) throw error;
    throw new MusicMasterMvpError(
      "UNSUPPORTED_TOOLCHAIN",
      `ffmpeg/ffprobe capability probe failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function assertFiniteMeasurement(
  measurement: LoudnormMeasurement,
  label: string,
): MusicMasterMvpMeasurement {
  const values = {
    integrated_lufs: Number(measurement.input_i),
    lra_lu: Number(measurement.input_lra),
    true_peak_dbtp: Number(measurement.input_tp),
  };
  const allValues = [
    values.integrated_lufs,
    values.lra_lu,
    values.true_peak_dbtp,
    Number(measurement.input_thresh),
    Number(measurement.target_offset),
  ];
  if (allValues.some((value) => !Number.isFinite(value))) {
    throw new MusicMasterMvpError(
      "MEASUREMENT_INVALID",
      `${label} loudnorm measurement is incomplete or non-finite`,
    );
  }
  return { raw: measurement, ...values };
}

async function measure(
  ffmpegBin: string,
  args: string[],
  label: string,
): Promise<MusicMasterMvpMeasurement> {
  let result: CommandResult;
  try {
    result = await runCommand(ffmpegBin, args);
  } catch (error) {
    throw new MusicMasterMvpError(
      "EXECUTION_FAILED",
      `${label} ffmpeg measurement failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  let raw: LoudnormMeasurement;
  try {
    raw = parseLoudnormOutput(result.stderr);
  } catch (error) {
    throw new MusicMasterMvpError(
      "MEASUREMENT_INVALID",
      `${label} loudnorm JSON is missing: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return assertFiniteMeasurement(raw, label);
}

function hashFile(filePath: string): string {
  const hash = createHash("sha256");
  const fd = fs.openSync(filePath, "r");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let bytesRead = 0;
    do {
      bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (bytesRead > 0) hash.update(buffer.subarray(0, bytesRead));
    } while (bytesRead > 0);
  } finally {
    fs.closeSync(fd);
  }
  return `sha256:${hash.digest("hex")}`;
}

interface ProbeResult {
  codec: string | null;
  sample_rate: number | null;
  channels: number | null;
  bit_depth: number | null;
  bit_rate: number | null;
}

async function probeAudio(ffprobeBin: string, filePath: string): Promise<ProbeResult> {
  let result: CommandResult;
  try {
    result = await runCommand(ffprobeBin, [
      "-v", "error",
      "-select_streams", "a:0",
      "-show_entries", "stream=codec_name,sample_rate,channels,bits_per_sample,bits_per_raw_sample,bit_rate",
      "-of", "json",
      filePath,
    ]);
  } catch (error) {
    throw new MusicMasterMvpError(
      "EXECUTION_FAILED",
      `ffprobe failed for ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  try {
    const parsed = JSON.parse(result.stdout) as {
      streams?: Array<Record<string, unknown>>;
    };
    const stream = parsed.streams?.[0];
    if (!stream) throw new Error("audio stream is missing");
    const numeric = (value: unknown): number | null => {
      const numberValue = Number(value);
      return Number.isFinite(numberValue) ? numberValue : null;
    };
    return {
      codec: typeof stream.codec_name === "string" ? stream.codec_name : null,
      sample_rate: numeric(stream.sample_rate),
      channels: numeric(stream.channels),
      bit_depth: numeric(stream.bits_per_raw_sample ?? stream.bits_per_sample),
      bit_rate: numeric(stream.bit_rate),
    };
  } catch (error) {
    throw new MusicMasterMvpError(
      "FORMAT_INVALID",
      `ffprobe audio evidence is incomplete for ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function verifyWav(
  ffprobeBin: string,
  filePath: string,
): Promise<MusicMasterMvpAudioEvidence> {
  const probe = await probeAudio(ffprobeBin, filePath);
  if (probe.codec !== "pcm_s24le" || probe.sample_rate !== MASTERING_SAMPLE_RATE_HZ
    || probe.channels !== 2 || probe.bit_depth !== 24) {
    throw new MusicMasterMvpError(
      "FORMAT_INVALID",
      `WAV deliverable must be pcm_s24le/24-bit/48k/stereo; observed codec=${probe.codec ?? "missing"} bit_depth=${probe.bit_depth ?? "missing"} sample_rate=${probe.sample_rate ?? "missing"} channels=${probe.channels ?? "missing"}`,
    );
  }
  return {
    content_hash: hashFile(filePath),
    size_bytes: fs.statSync(filePath).size,
    codec: "pcm_s24le",
    sample_rate_hz: MASTERING_SAMPLE_RATE_HZ,
    channels: 2,
    bit_depth: 24,
    bit_rate_bps: probe.bit_rate,
  };
}

async function verifyMp3(
  ffprobeBin: string,
  filePath: string,
): Promise<MusicMasterMvpAudioEvidence> {
  const probe = await probeAudio(ffprobeBin, filePath);
  if (probe.codec !== "mp3" || probe.sample_rate !== MASTERING_SAMPLE_RATE_HZ
    || probe.channels !== 2 || probe.bit_rate !== 320_000) {
    throw new MusicMasterMvpError(
      "FORMAT_INVALID",
      `MP3 deliverable must be mp3/320000bps/48k/stereo; observed codec=${probe.codec ?? "missing"} bit_rate=${probe.bit_rate ?? "missing"} sample_rate=${probe.sample_rate ?? "missing"} channels=${probe.channels ?? "missing"}`,
    );
  }
  return {
    content_hash: hashFile(filePath),
    size_bytes: fs.statSync(filePath).size,
    codec: "mp3",
    sample_rate_hz: MASTERING_SAMPLE_RATE_HZ,
    channels: 2,
    bit_depth: null,
    bit_rate_bps: 320_000,
  };
}

function assertAccepted(
  label: string,
  measurement: MusicMasterMvpMeasurement,
  policy: MusicMasterMvpPolicy,
): void {
  if (Math.abs(measurement.integrated_lufs - policy.loudnorm.target_lufs)
      > policy.loudnorm.loudness_tolerance_lufs
    || measurement.true_peak_dbtp > policy.loudnorm.acceptance_true_peak_dbtp) {
    throw new MusicMasterMvpError(
      "OUTPUT_REJECTED",
      `${label} is outside Issue #38 acceptance: integrated=${measurement.integrated_lufs} LUFS true_peak=${measurement.true_peak_dbtp} dBTP`,
    );
  }
}

export async function executeMusicMasterMvp(options: {
  sourcePath: string;
  sourceRangeUs: { in_us: number; out_us: number };
  outputWavPath: string;
  outputMp3Path: string;
  policy?: MusicMasterMvpPolicy;
  ffmpegBin?: string;
  ffprobeBin?: string;
}): Promise<MusicMasterMvpExecution> {
  const policy = options.policy ?? MUSIC_MASTER_MVP_POLICY;
  assertMusicMasterMvpPolicy(policy);
  const ffmpegBin = options.ffmpegBin ?? "ffmpeg";
  const ffprobeBin = options.ffprobeBin ?? "ffprobe";
  const outputPaths = [options.outputWavPath, options.outputMp3Path];
  if (new Set(outputPaths).size !== outputPaths.length) {
    throw new MusicMasterMvpError("OUTPUT_EXISTS", "WAV and MP3 deliverables must use distinct paths");
  }
  if (!fs.existsSync(options.sourcePath) || !fs.statSync(options.sourcePath).isFile()) {
    throw new MusicMasterMvpError("EXECUTION_FAILED", `music_master source is missing: ${options.sourcePath}`);
  }
  const existing = outputPaths.find((filePath) => fs.existsSync(filePath));
  if (existing) {
    throw new MusicMasterMvpError("OUTPUT_EXISTS", `refusing to overwrite existing deliverable: ${existing}`);
  }
  if (!Number.isSafeInteger(options.sourceRangeUs.in_us)
    || !Number.isSafeInteger(options.sourceRangeUs.out_us)
    || options.sourceRangeUs.in_us < 0
    || options.sourceRangeUs.out_us <= options.sourceRangeUs.in_us) {
    throw new MusicMasterMvpError("EXECUTION_FAILED", "music_master source range is invalid");
  }

  await assertToolchain(ffmpegBin, ffprobeBin);
  fs.mkdirSync(requireDirectory(options.outputWavPath), { recursive: true });
  fs.mkdirSync(requireDirectory(options.outputMp3Path), { recursive: true });

  try {
    const pass1 = await measure(
      ffmpegBin,
      buildMusicMasterMvpPass1Args(options.sourcePath, options.sourceRangeUs, policy),
      "pass1",
    );
    const pass2Args = buildMusicMasterMvpPass2Args(
      options.sourcePath,
      options.outputWavPath,
      options.sourceRangeUs,
      pass1.raw,
      policy,
    );
    try {
      await runCommand(ffmpegBin, pass2Args);
    } catch (error) {
      throw new MusicMasterMvpError(
        "EXECUTION_FAILED",
        `pass2 WAV render failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (!fs.existsSync(options.outputWavPath)) {
      throw new MusicMasterMvpError("EXECUTION_FAILED", "pass2 did not produce the WAV deliverable");
    }
    const wav = await verifyWav(ffprobeBin, options.outputWavPath);
    const pass2 = await measure(
      ffmpegBin,
      buildOutputMeasurementArgs(options.outputWavPath, policy),
      "pass2 output",
    );
    assertAccepted("WAV", pass2, policy);

    try {
      await runCommand(ffmpegBin, buildMp3EncodeArgs(options.outputWavPath, options.outputMp3Path));
    } catch (error) {
      throw new MusicMasterMvpError(
        "EXECUTION_FAILED",
        `MP3 encode failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (!fs.existsSync(options.outputMp3Path)) {
      throw new MusicMasterMvpError("EXECUTION_FAILED", "MP3 encode did not produce the deliverable");
    }
    const mp3Output = await verifyMp3(ffprobeBin, options.outputMp3Path);
    const mp3 = await measure(
      ffmpegBin,
      buildOutputMeasurementArgs(options.outputMp3Path, policy),
      "MP3 output",
    );
    assertAccepted("MP3", mp3, policy);

    return {
      execution_graph: {
        version: "music-master-mvp-graph/v1",
        stages: [
          "cleanup",
          "presence_air",
          "spatial_glue",
          "loudnorm_pass1",
          "loudnorm_pass2",
          "wav24",
          "mp3_320",
        ],
        tone_filter_chain: buildMusicMasterMvpToneFilterChain(policy),
        pass1_filter: buildMusicMasterMvpPass1Filter(policy),
        pass2_filter: buildMusicMasterMvpPass2Filter(pass1.raw, policy),
        wav_codec: {
          codec: "pcm_s24le",
          bit_depth: 24,
          sample_rate_hz: MASTERING_SAMPLE_RATE_HZ,
          channels: 2,
        },
        mp3_codec: {
          codec: "mp3",
          encoder: "libmp3lame",
          bit_rate_bps: 320_000,
          sample_rate_hz: MASTERING_SAMPLE_RATE_HZ,
          channels: 2,
        },
      },
      pass1,
      pass2,
      mp3,
      wav,
      mp3_output: mp3Output,
    };
  } catch (error) {
    for (const filePath of outputPaths) {
      try {
        fs.rmSync(filePath, { force: true });
      } catch {
        // Preserve the original failure; a later package gate will HOLD if
        // an external filesystem prevented cleanup.
      }
    }
    throw error;
  }
}

function requireDirectory(filePath: string): string {
  const directory = filePath.slice(0, Math.max(0, filePath.lastIndexOf("/")));
  return directory || ".";
}
