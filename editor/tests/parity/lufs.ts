/**
 * lufs — measure integrated LUFS / true peak via ffmpeg's loudnorm filter.
 *
 * Same algorithm as `editor/server/services/preview-job-service.ts`
 * `masterAudioTwoPass`. Phase 5 acceptance criteria:
 *   - integrated LUFS difference ≤ 0.1 LU
 *   - true peak difference        ≤ 0.2 dBTP
 */

import { execFile } from "node:child_process";

export interface LoudnessMeasurement {
  /** Integrated loudness in LUFS. */
  integratedLufs: number;
  /** True peak in dBTP. */
  truePeakDbtp: number;
  /** Loudness range in LU. */
  lra: number;
}

export interface MeasureLoudnessOptions {
  audioOrVideoPath: string;
  /** Loudnorm target (matches preview-job-service defaults). */
  targetLufs?: number;
  truePeakDbtp?: number;
  lra?: number;
  ffmpegBin?: string;
}

/**
 * Run pass-1 of `loudnorm` to measure integrated loudness, true peak,
 * and LRA. Does NOT apply normalization — just reads the JSON block
 * loudnorm prints to stderr.
 */
export function measureLoudness(
  opts: MeasureLoudnessOptions,
): Promise<LoudnessMeasurement> {
  return new Promise((resolve, reject) => {
    const ffmpeg = opts.ffmpegBin ?? "ffmpeg";
    const targetLufs = opts.targetLufs ?? -16;
    const truePeak = opts.truePeakDbtp ?? -1.5;
    const lra = opts.lra ?? 7;
    execFile(
      ffmpeg,
      [
        "-i",
        opts.audioOrVideoPath,
        "-af",
        `loudnorm=I=${targetLufs}:LRA=${lra}:TP=${truePeak}:print_format=json`,
        "-f",
        "null",
        "-",
      ],
      { maxBuffer: 50 * 1024 * 1024 },
      (err, _stdout, stderr) => {
        if (err && !stderr) {
          reject(err);
          return;
        }
        try {
          resolve(parseLoudnormJson(stderr));
        } catch (parseErr) {
          reject(parseErr);
        }
      },
    );
  });
}

/** Find and parse the JSON block loudnorm prints when print_format=json. */
export function parseLoudnormJson(stderr: string): LoudnessMeasurement {
  const match = stderr.match(/\{[^{}]*"input_i"\s*:[^{}]*\}/s);
  if (!match) {
    throw new Error(
      `Could not find loudnorm JSON in stderr: ${stderr.slice(-400)}`,
    );
  }
  const json = JSON.parse(match[0]) as Record<string, unknown>;
  const integratedLufs = Number.parseFloat(String(json.input_i ?? "NaN"));
  const truePeakDbtp = Number.parseFloat(String(json.input_tp ?? "NaN"));
  const lra = Number.parseFloat(String(json.input_lra ?? "NaN"));
  if (
    !Number.isFinite(integratedLufs) ||
    !Number.isFinite(truePeakDbtp) ||
    !Number.isFinite(lra)
  ) {
    throw new Error(`Loudnorm measurement parsed as non-finite: ${match[0]}`);
  }
  return { integratedLufs, truePeakDbtp, lra };
}
