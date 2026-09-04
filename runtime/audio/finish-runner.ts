import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  buildAudioFinishApplyFilter,
  buildAudioFinishPass1Args,
  buildAudioFinishPreprocessFilter,
  type ResolvedAudioFinishPolicy,
} from "./dialogue-finishing.js";
import {
  buildLoudnormPass1Args,
  parseLoudnormOutput,
  type LoudnormMeasurement,
} from "./mastering.js";

export interface AudioFinishRunReport {
  version: "audio-finish-run-report/v1";
  policy: ResolvedAudioFinishPolicy;
  input_path: string;
  output_path: string;
  premaster_measurement: LoudnormMeasurement;
  output_measurement: LoudnormMeasurement;
}

export type AudioFinishExec = (
  command: string,
  args: string[],
  options: { maxBuffer: number },
  callback: (error: Error | null, stdout: string, stderr: string) => void,
) => void;

export async function finishDialogueAudio(input: {
  inputPath: string;
  outputPath: string;
  policy: ResolvedAudioFinishPolicy;
  ffmpegBin?: string;
  execFileImpl?: AudioFinishExec;
}): Promise<AudioFinishRunReport> {
  const inputPath = path.resolve(input.inputPath);
  const outputPath = path.resolve(input.outputPath);
  if (!fs.existsSync(inputPath)) throw new Error(`audio finish input is missing: ${inputPath}`);
  if (inputPath === outputPath) throw new Error("audio finish output must differ from input");
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const ffmpegBin = input.ffmpegBin ?? "ffmpeg";
  const runner = input.execFileImpl ?? execFile;

  const measurementResult = await runFfmpeg(
    runner,
    ffmpegBin,
    buildAudioFinishPass1Args(inputPath, input.policy),
    true,
  );
  const premasterMeasurement = parseLoudnormOutput(measurementResult.stderr);
  const filter = buildAudioFinishApplyFilter(input.policy, premasterMeasurement);
  await runFfmpeg(runner, ffmpegBin, [
    "-y",
    "-i", inputPath,
    "-af", filter,
    "-ar", "48000",
    outputPath,
  ]);
  if (!fs.existsSync(outputPath)) throw new Error(`audio finish output is missing: ${outputPath}`);

  const outputMeasurementResult = await runFfmpeg(
    runner,
    ffmpegBin,
    buildLoudnormPass1Args(outputPath, {
      loudness_target_lufs: input.policy.loudness_target_lufs,
      lra_target: input.policy.lra_target,
      true_peak_target_dbtp: input.policy.true_peak_target_dbtp,
    }),
    true,
  );
  return {
    version: "audio-finish-run-report/v1",
    policy: input.policy,
    input_path: inputPath,
    output_path: outputPath,
    premaster_measurement: premasterMeasurement,
    output_measurement: parseLoudnormOutput(outputMeasurementResult.stderr),
  };
}

export async function preprocessDialogueAudio(input: {
  inputPath: string;
  outputPath: string;
  policy: ResolvedAudioFinishPolicy;
  ffmpegBin?: string;
  execFileImpl?: AudioFinishExec;
}): Promise<void> {
  const inputPath = path.resolve(input.inputPath);
  const outputPath = path.resolve(input.outputPath);
  if (!fs.existsSync(inputPath)) throw new Error(`audio finish input is missing: ${inputPath}`);
  if (inputPath === outputPath) throw new Error("audio finish output must differ from input");
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const filter = buildAudioFinishPreprocessFilter(input.policy);
  if (!filter) {
    fs.copyFileSync(inputPath, outputPath);
    return;
  }
  await runFfmpeg(input.execFileImpl ?? execFile, input.ffmpegBin ?? "ffmpeg", [
    "-y", "-i", inputPath, "-af", filter, "-ar", "48000", outputPath,
  ]);
  if (!fs.existsSync(outputPath)) throw new Error(`audio finish output is missing: ${outputPath}`);
}

function runFfmpeg(
  runner: AudioFinishExec,
  command: string,
  args: string[],
  allowMeasurementOnError = false,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    runner(command, args, { maxBuffer: 50 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error && !(allowMeasurementOnError && /"input_i"\s*:/.test(stderr ?? ""))) {
        reject(new Error(`audio finish ffmpeg failed: ${stderr || error.message}`));
        return;
      }
      resolve({ stdout: stdout ?? "", stderr: stderr ?? "" });
    });
  });
}
