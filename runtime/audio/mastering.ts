/**
 * Loudnorm 2-pass mastering via ffmpeg.
 *
 * Per milestone-4-design §Mastering:
 * - Pass 1: measure loudness (loudnorm print_format=json)
 * - Pass 2: apply loudnorm with measured values + linear=true
 * - Target: -16 LUFS, LRA 7, TP -1.5 dBTP
 */

import { execFile } from "node:child_process";

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

export interface LoudnormMeasurement {
  input_i: string;
  input_tp: string;
  input_lra: string;
  input_thresh: string;
  target_offset: string;
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
    outputPath,
  ];
}

// ── 2-Pass Mastering ───────────────────────────────────────────────

/**
 * Helper: run ffmpeg with given args, returning stdout + stderr.
 */
function execFfmpeg(args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      "ffmpeg",
      args,
      { maxBuffer: 50 * 1024 * 1024 },
      (err, stdout, stderr) => {
        // Pass 1 writes to null output; ffmpeg may still exit 0
        // with loudnorm output on stderr
        if (err && !stderr) {
          reject(err);
          return;
        }
        if (err) {
          // For pass 1, ffmpeg writes measurement to stderr and may
          // report a non-zero exit for -f null. Check if we got output.
          resolve({ stdout: stdout ?? "", stderr: stderr ?? "" });
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
  // Pass 1: Measurement
  const pass1Args = buildLoudnormPass1Args(inputPath, defaults);
  const pass1Result = await execFfmpeg(pass1Args);
  const measurement = parseLoudnormOutput(pass1Result.stderr);

  // Pass 2: Apply
  const pass2Args = buildLoudnormPass2Args(inputPath, outputPath, measurement, defaults);
  await execFfmpeg(pass2Args);

  return { measurement };
}
