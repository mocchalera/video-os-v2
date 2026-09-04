import { execFile } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { validateArtifact } from "../artifacts/loaders.js";
import {
  resolveExplicitBgmTrack,
} from "../music/cue-planner.js";
import { finishDialogueAudio, preprocessDialogueAudio } from "./finish-runner.js";
import {
  masterAudio,
  measureEncodedAudioResult,
  measureAudioLoudness,
  type LoudnormMeasurement,
} from "./mastering.js";
import { assertAudioDeliveryProfileFresh } from "./delivery-profile.js";
import type { AudioMixReport, MusicMasterAudioReceipt } from "./mixer.js";
import {
  hashAudioRenderPlan,
  hashFile,
  assertAudioRenderPlanContract,
  type AudioRenderCue,
  type AudioRenderPlan,
  type AudioRenderSfxCue,
  type MusicMasterAudioPlan,
} from "./render-plan.js";
import {
  executeMusicMasterMvp,
  type MusicMasterMvpExecution,
} from "./music-master-mvp.js";

const SAMPLE_RATE_HZ = 48_000;
const CHANNELS = 2;
const SIDECHAIN_THRESHOLD = 0.03;

export interface ExecuteAudioRenderPlanOptions {
  plan: AudioRenderPlan;
  outputDir: string;
  outputPaths?: {
    rawDialoguePath: string;
    premasterMixPath?: string;
    finalMixPath: string;
    masteredMp3Path?: string;
    reportPath: string;
  };
  workDirRoot?: string;
  replaceExisting?: boolean;
  cleanupWorkDir?: boolean;
  verifyPackPinsImpl?: (plan: AudioRenderPlan) => void;
}

export interface ExecutedAudioRenderPlan {
  planHash: string;
  rawDialoguePath: string;
  premasterMixPath: string;
  finalMixPath: string;
  masteredMp3Path?: string;
  reportPath: string;
  report: AudioMixReport;
  /** Retained only when cleanupWorkDir=false, for internal audition evidence. */
  workDir?: string;
}

export class AudioRenderExecutionError extends Error {
  constructor(
    readonly code:
      | "AUDIO_RENDER_INPUT_DRIFT"
      | "AUDIO_RENDER_OUTPUT_EXISTS"
      | "AUDIO_RENDER_LEGACY_MIXED_INPUT_FORBIDDEN"
      | "AUDIO_RENDER_EXECUTION_FAILED",
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = "AudioRenderExecutionError";
  }
}

function number(value: number): string {
  return value.toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
}

function seconds(us: number): string {
  return number(us / 1_000_000);
}

function durationSeconds(cue: AudioRenderCue): number {
  return (cue.source_range_us.out_us - cue.source_range_us.in_us) / 1_000_000;
}

function frameSeconds(plan: AudioRenderPlan, frames: number): number {
  return frames * plan.timeline.fps.den / plan.timeline.fps.num;
}

function delayMs(plan: AudioRenderPlan, frame: number): string {
  return number(frameSeconds(plan, frame) * 1000);
}

function totalDurationSeconds(plan: AudioRenderPlan): number {
  return frameSeconds(plan, plan.timeline.duration_frames);
}

function totalSamples(plan: AudioRenderPlan): number {
  return Math.round(totalDurationSeconds(plan) * SAMPLE_RATE_HZ);
}

function ratioForCue(cue: AudioRenderCue): number {
  const depth = Math.max(0, cue.applied.base_gain_db - cue.applied.duck_gain_db);
  return Number(Math.min(20, Math.max(2, 1 + depth * 1.5)).toFixed(2));
}

function ratioForSfxCue(cue: AudioRenderSfxCue): number {
  const depth = Math.max(0, cue.applied.gain_db - cue.applied.duck_gain_db);
  return Number(Math.min(20, Math.max(2, 1 + depth * 1.5)).toFixed(2));
}

export function buildDialogueStemArgs(
  plan: AudioRenderPlan,
  outputPath: string,
): string[] {
  const totalDuration = totalDurationSeconds(plan);
  const inputs = plan.dialogue.clips.flatMap((clip) => [
    "-ss", seconds(clip.source_range_us.in_us),
    "-t", seconds(clip.source_range_us.out_us - clip.source_range_us.in_us),
    "-i", clip.source_path,
  ]);
  const filters: string[] = [
    `[0:a]atrim=duration=${number(totalDuration)},asetpts=PTS-STARTPTS[silent]`,
  ];
  const labels = ["[silent]"];
  plan.dialogue.clips.forEach((clip, index) => {
    const label = `a1_${String(index).padStart(3, "0")}`;
    const clipDuration = frameSeconds(
      plan,
      clip.timeline_range.out_frame - clip.timeline_range.in_frame,
    );
    filters.push(
      `[${index + 1}:a]atrim=start=0:duration=${number(clipDuration)},asetpts=PTS-STARTPTS,`
      + `volume=${number(clip.gain_linear)},aresample=${SAMPLE_RATE_HZ},`
      + `aformat=channel_layouts=stereo,adelay=${delayMs(plan, clip.timeline_range.in_frame)}`
      + `|${delayMs(plan, clip.timeline_range.in_frame)}[${label}]`,
    );
    labels.push(`[${label}]`);
  });
  filters.push(
    `${labels.join("")}amix=inputs=${labels.length}:duration=first:dropout_transition=0:normalize=0,`
    + `atrim=duration=${number(totalDuration)}[dialogue]`,
  );
  return [
    "-y",
    "-f", "lavfi",
    "-t", number(totalDuration),
    "-i", `anullsrc=channel_layout=stereo:sample_rate=${SAMPLE_RATE_HZ}`,
    ...inputs,
    "-filter_complex_threads", "1",
    "-filter_complex", filters.join(";"),
    "-map", "[dialogue]",
    "-ar", String(SAMPLE_RATE_HZ),
    "-ac", String(CHANNELS),
    "-c:a", "pcm_s24le",
    outputPath,
  ];
}

export function buildCueRenderArgs(
  cue: AudioRenderCue,
  outputPath: string,
): string[] {
  const duration = durationSeconds(cue);
  const fadeIn = Math.min(duration, cue.applied.fade_in_ms / 1000);
  const fadeOut = Math.min(duration, cue.applied.fade_out_ms / 1000);
  const filters = [
    `volume=${number(cue.applied.base_gain_db)}dB`,
    ...(fadeIn > 0 ? [`afade=t=in:d=${number(fadeIn)}`] : []),
    ...(fadeOut > 0
      ? [`afade=t=out:st=${number(Math.max(0, duration - fadeOut))}:d=${number(fadeOut)}`]
      : []),
  ];
  return [
    "-y",
    "-ss", seconds(cue.source_range_us.in_us),
    "-t", number(duration),
    "-i", cue.source_path,
    "-vn",
    "-filter_threads", "1",
    "-af", filters.join(","),
    "-ar", String(SAMPLE_RATE_HZ),
    "-ac", String(CHANNELS),
    "-c:a", "pcm_s24le",
    outputPath,
  ];
}

export function buildSidechainCueArgs(
  plan: AudioRenderPlan,
  cue: AudioRenderCue,
  dialoguePath: string,
  renderedCuePath: string,
  outputPath: string,
): string[] {
  const sampleCount = totalSamples(plan);
  const delay = delayMs(plan, cue.timeline_range.in_frame);
  const ratio = ratioForCue(cue).toFixed(2);
  const filter = [
    `[0:a]aresample=${SAMPLE_RATE_HZ},asetpts=PTS-STARTPTS,`
      + "asetnsamples=n=1024:p=1[dialogue]",
    `[1:a]asetpts=PTS-STARTPTS,adelay=${delay}|${delay},apad,`
      + `atrim=end_sample=${sampleCount},asetnsamples=n=1024:p=1[bed]`,
    `[bed][dialogue]sidechaincompress=threshold=${SIDECHAIN_THRESHOLD}:ratio=${ratio}`
      + `:attack=${number(cue.applied.attack_ms)}:release=${number(cue.applied.release_ms)}`
      + ":knee=2.8:detection=rms[ducked]",
    `[ducked]apad,atrim=end_sample=${sampleCount}[out]`,
  ].join(";");
  return [
    "-y",
    "-i", dialoguePath,
    "-i", renderedCuePath,
    "-filter_complex_threads", "1",
    "-filter_complex", filter,
    "-map", "[out]",
    "-ar", String(SAMPLE_RATE_HZ),
    "-ac", String(CHANNELS),
    "-c:a", "pcm_s24le",
    outputPath,
  ];
}

export function buildSfxCueRenderArgs(
  cue: AudioRenderSfxCue,
  outputPath: string,
): string[] {
  const renderDuration = cue.tail_processing.render_duration_us / 1_000_000;
  const sourceDuration =
    (cue.source_range_us.out_us - cue.source_range_us.in_us) / 1_000_000;
  const fadeIn = Math.min(renderDuration, cue.applied.fade_in_ms / 1000);
  const fadeOut = Math.min(renderDuration, cue.applied.fade_out_ms / 1000);
  const filters = [
    `atrim=duration=${number(sourceDuration)}`,
    "asetpts=PTS-STARTPTS",
    `volume=${number(cue.applied.gain_db)}dB`,
    "apad",
    `atrim=duration=${number(renderDuration)}`,
    ...(fadeIn > 0 ? [`afade=t=in:d=${number(fadeIn)}`] : []),
    ...(fadeOut > 0
      ? [`afade=t=out:st=${number(Math.max(0, renderDuration - fadeOut))}:d=${number(fadeOut)}`]
      : []),
  ];
  return [
    "-y",
    "-ss", seconds(cue.source_range_us.in_us),
    "-i", cue.source_path,
    "-vn",
    "-filter_threads", "1",
    "-af", filters.join(","),
    "-ar", String(SAMPLE_RATE_HZ),
    "-ac", String(CHANNELS),
    "-c:a", "pcm_s24le",
    outputPath,
  ];
}

export function buildPlacedSfxCueArgs(
  plan: AudioRenderPlan,
  cue: AudioRenderSfxCue,
  dialoguePath: string,
  renderedCuePath: string,
  outputPath: string,
): string[] {
  const sampleCount = totalSamples(plan);
  const delay = delayMs(plan, cue.timeline_range.in_frame);
  const placed =
    `[1:a]asetpts=PTS-STARTPTS,adelay=${delay}|${delay},apad,`
    + `atrim=end_sample=${sampleCount},asetnsamples=n=1024:p=1[placed]`;
  const filters = cue.applied.duck_group === "dialogue"
    ? [
        `[0:a]aresample=${SAMPLE_RATE_HZ},asetpts=PTS-STARTPTS,`
          + "asetnsamples=n=1024:p=1[dialogue]",
        placed,
        `[placed][dialogue]sidechaincompress=threshold=${SIDECHAIN_THRESHOLD}`
          + `:ratio=${ratioForSfxCue(cue).toFixed(2)}`
          + `:attack=${number(cue.applied.attack_ms)}`
          + `:release=${number(cue.applied.release_ms)}`
          + ":knee=2.8:detection=rms[ducked]",
        `[ducked]apad,atrim=end_sample=${sampleCount}[out]`,
      ]
    : [
        placed,
        `[placed]apad,atrim=end_sample=${sampleCount}[out]`,
      ];
  return [
    "-y",
    "-i", dialoguePath,
    "-i", renderedCuePath,
    "-filter_complex_threads", "1",
    "-filter_complex", filters.join(";"),
    "-map", "[out]",
    "-ar", String(SAMPLE_RATE_HZ),
    "-ac", String(CHANNELS),
    "-c:a", "pcm_s24le",
    outputPath,
  ];
}

export function buildPremasterMixArgs(
  plan: AudioRenderPlan,
  dialoguePath: string,
  duckedCuePaths: string[],
  outputPath: string,
): string[] {
  const sampleCount = totalSamples(plan);
  const inputIndexes = [0, ...duckedCuePaths.map((_, index) => index + 1)];
  const labels = inputIndexes
    .map((index) => `[mix_${index}]`)
    .join("");
  const filters = [
    ...inputIndexes.map((index) =>
      `[${index}:a]aresample=${SAMPLE_RATE_HZ},asetpts=PTS-STARTPTS,`
      + `apad,atrim=end_sample=${sampleCount},asetnsamples=n=1024:p=1[mix_${index}]`
    ),
    `${labels}amix=inputs=${duckedCuePaths.length + 1}:duration=longest:`
      + `dropout_transition=0:normalize=0,apad,atrim=end_sample=${sampleCount}[mix]`,
  ];
  return [
    "-y",
    "-i", dialoguePath,
    ...duckedCuePaths.flatMap((cuePath) => ["-i", cuePath]),
    "-filter_complex_threads", "1",
    "-filter_complex",
    filters.join(";"),
    "-map", "[mix]",
    "-ar", String(SAMPLE_RATE_HZ),
    "-ac", String(CHANNELS),
    "-c:a", "pcm_s24le",
    outputPath,
  ];
}

/** Build the only permitted executor graph for an independent music master. */
export function buildMusicMasterAudioArgs(
  plan: AudioRenderPlan,
  sourcePath: string,
  outputPath: string,
): string[] {
  const musicMaster = plan.music_master;
  if (!musicMaster) throw new Error("music_master plan is required");
  if (musicMaster.codec.operation === "stream_copy") {
    return [
      "-y",
      "-i", sourcePath,
      "-map", "0:a:0",
      "-vn",
      "-c:a", "copy",
      outputPath,
    ];
  }
  const source = musicMaster.source;
  return [
    "-y",
    "-ss", seconds(source.source_range_us.in_us),
    "-t", seconds(source.source_range_us.out_us - source.source_range_us.in_us),
    "-i", sourcePath,
    "-map", "0:a:0",
    "-vn",
    "-ar", String(SAMPLE_RATE_HZ),
    "-ac", String(CHANNELS),
    "-c:a", "pcm_s24le",
    outputPath,
  ];
}

function runFfmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile("ffmpeg", args, { maxBuffer: 100 * 1024 * 1024 }, (error, _stdout, stderr) => {
      if (error) {
        reject(new AudioRenderExecutionError(
          "AUDIO_RENDER_EXECUTION_FAILED",
          stderr?.trim() || error.message,
        ));
        return;
      }
      resolve();
    });
  });
}

function assertHashAndSize(
  filePath: string,
  expectedHash: string,
  expectedSize: number,
  label: string,
): void {
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    throw new AudioRenderExecutionError(
      "AUDIO_RENDER_INPUT_DRIFT",
      `${label} is missing: ${filePath}`,
    );
  }
  const actualSize = fs.statSync(filePath).size;
  if (actualSize !== expectedSize) {
    throw new AudioRenderExecutionError(
      "AUDIO_RENDER_INPUT_DRIFT",
      `${label} size expected=${expectedSize} actual=${actualSize}`,
    );
  }
  const actualHash = hashFile(filePath);
  if (actualHash !== expectedHash) {
    throw new AudioRenderExecutionError(
      "AUDIO_RENDER_INPUT_DRIFT",
      `${label} hash expected=${expectedHash} actual=${actualHash}`,
    );
  }
}

function resolveMusicMasterSourcePath(plan: AudioRenderPlan): string {
  const musicMaster: MusicMasterAudioPlan | undefined = plan.music_master;
  if (!musicMaster) {
    throw new AudioRenderExecutionError(
      "AUDIO_RENDER_INPUT_DRIFT",
      "music_master source binding is missing",
    );
  }
  const timelineDir = path.dirname(plan.timeline.path);
  const roots = [
    timelineDir,
    path.basename(timelineDir) === "05_timeline" ? path.dirname(timelineDir) : undefined,
  ].filter((root): root is string => Boolean(root));
  for (const root of roots) {
    const candidate = path.resolve(root, musicMaster.source.source_ref);
    if (!fs.existsSync(candidate) || !fs.statSync(candidate).isFile()) continue;
    if (
      fs.statSync(candidate).size === musicMaster.source.source_size_bytes
      && hashFile(candidate) === musicMaster.source.source_content_hash
    ) {
      return candidate;
    }
  }
  throw new AudioRenderExecutionError(
    "AUDIO_RENDER_INPUT_DRIFT",
    `music_master source identity does not match source_ref=${musicMaster.source.source_ref}`,
  );
}

function assertInstalledPackPins(plan: AudioRenderPlan): void {
  const byTrack = new Map<string, AudioRenderCue>();
  for (const cue of plan.music.cues) byTrack.set(cue.track_id, cue);
  for (const cue of byTrack.values()) {
    const resolved = resolveExplicitBgmTrack(
      cue.track_id,
      cue.pins.full_mix_content_hash,
    );
    const checks: Array<[string, unknown, unknown]> = [
      ["pack_id", cue.pins.pack_id, resolved.pack_id],
      ["pack_version", cue.pins.pack_version, resolved.pack_version],
      ["pack_manifest_hash", cue.pins.pack_manifest_hash, resolved.manifest_hash],
      ["analysis_content_hash", cue.pins.analysis_content_hash, resolved.analysis_ref.content_hash],
    ];
    for (const [label, expected, actual] of checks) {
      if (expected !== actual) {
        throw new AudioRenderExecutionError(
          "AUDIO_RENDER_INPUT_DRIFT",
          `${cue.cue_id} ${label} expected=${String(expected)} actual=${String(actual)}`,
        );
      }
    }
  }
}

export function assertAudioRenderPlanFresh(
  plan: AudioRenderPlan,
  verifyPackPinsImpl: (plan: AudioRenderPlan) => void = assertInstalledPackPins,
): void {
  if (plan.audio_delivery_profile && !plan.audio_delivery_profile.path.startsWith("<")) {
    assertAudioDeliveryProfileFresh({
      path: plan.audio_delivery_profile.path,
      hash: plan.audio_delivery_profile.source_hash,
    });
  }
  assertHashAndSize(
    plan.timeline.path,
    plan.timeline.content_hash,
    fs.existsSync(plan.timeline.path) ? fs.statSync(plan.timeline.path).size : -1,
    "timeline",
  );
  if (plan.inputs.music_cues_path && plan.inputs.music_cues_content_hash) {
    assertHashAndSize(
      plan.inputs.music_cues_path,
      plan.inputs.music_cues_content_hash,
      fs.existsSync(plan.inputs.music_cues_path)
        ? fs.statSync(plan.inputs.music_cues_path).size
        : -1,
      "music_cues",
    );
  }
  if (plan.inputs.sfx_cues_path && plan.inputs.sfx_cues_content_hash) {
    assertHashAndSize(
      plan.inputs.sfx_cues_path,
      plan.inputs.sfx_cues_content_hash,
      fs.existsSync(plan.inputs.sfx_cues_path)
        ? fs.statSync(plan.inputs.sfx_cues_path).size
        : -1,
      "sfx_cues",
    );
  }
  if (
    plan.inputs.sfx_library_manifest_path
    && plan.inputs.sfx_library_manifest_hash
  ) {
    assertHashAndSize(
      plan.inputs.sfx_library_manifest_path,
      plan.inputs.sfx_library_manifest_hash,
      fs.existsSync(plan.inputs.sfx_library_manifest_path)
        ? fs.statSync(plan.inputs.sfx_library_manifest_path).size
        : -1,
      "SFX library manifest",
    );
  }
  if (
    plan.inputs.sound_design_decision_path
    && plan.inputs.sound_design_decision_content_hash
  ) {
    assertHashAndSize(
      plan.inputs.sound_design_decision_path,
      plan.inputs.sound_design_decision_content_hash,
      fs.existsSync(plan.inputs.sound_design_decision_path)
        ? fs.statSync(plan.inputs.sound_design_decision_path).size
        : -1,
      "sound-design decision",
    );
  }
  const checkedDialogue = new Set<string>();
  for (const clip of plan.dialogue.clips) {
    if (checkedDialogue.has(clip.source_path)) continue;
    assertHashAndSize(
      clip.source_path,
      clip.source_content_hash,
      clip.source_size_bytes,
      `A1 source ${clip.asset_id}`,
    );
    checkedDialogue.add(clip.source_path);
  }
  if (plan.strategy === "music_master") {
    const sourcePath = resolveMusicMasterSourcePath(plan);
    assertHashAndSize(
      sourcePath,
      plan.music_master!.source.source_content_hash,
      plan.music_master!.source.source_size_bytes,
      "music_master source",
    );
  }
  const checkedCueSources = new Set<string>();
  for (const cue of plan.music.cues) {
    if (checkedCueSources.has(cue.source_path)) continue;
    assertHashAndSize(
      cue.source_path,
      cue.pins.full_mix_content_hash,
      cue.pins.full_mix_size_bytes,
      `A2 source ${cue.track_id}`,
    );
    checkedCueSources.add(cue.source_path);
  }
  if (plan.music.enabled) verifyPackPinsImpl(plan);
  const checkedSfxSources = new Set<string>();
  for (const cue of plan.sfx?.cues ?? []) {
    if (checkedSfxSources.has(cue.source_path)) continue;
    assertHashAndSize(
      cue.source_path,
      cue.pins.asset_content_hash,
      cue.pins.asset_size_bytes,
      `A3 source ${cue.asset_id}`,
    );
    checkedSfxSources.add(cue.source_path);
  }
}

function fileEvidence(filePath: string): { content_hash: string; size_bytes: number } {
  return {
    content_hash: hashFile(filePath),
    size_bytes: fs.statSync(filePath).size,
  };
}

function copyArtifact(source: string, destination: string, replaceExisting: boolean): void {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  if (replaceExisting) {
    const tempPath = `${destination}.tmp-${process.pid}`;
    fs.copyFileSync(source, tempPath);
    fs.renameSync(tempPath, destination);
    return;
  }
  fs.copyFileSync(source, destination, fsConstants.COPYFILE_EXCL);
}

function ensureOutputsAvailable(
  outputPaths: string[],
  replaceExisting: boolean,
): void {
  if (replaceExisting) return;
  const existing = outputPaths.find((filePath) => fs.existsSync(filePath));
  if (existing) {
    throw new AudioRenderExecutionError(
      "AUDIO_RENDER_OUTPUT_EXISTS",
      `existing artifacts are never overwritten: ${existing}`,
    );
  }
}

async function tryMeasureAudioLoudness(
  inputPath: string,
  defaults: AudioRenderPlan["final_mastering"],
): Promise<LoudnormMeasurement | null> {
  try {
    return await measureAudioLoudness(inputPath, defaults);
  } catch {
    return null;
  }
}

function measurementNumber(value: string): number | null {
  if (value.trim().toLowerCase() === "-inf") return null;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function buildMusicMasterMeasurements(
  plan: MusicMasterAudioPlan,
  input: LoudnormMeasurement | null,
  output: LoudnormMeasurement | null,
): MusicMasterAudioReceipt["measurements"] {
  const inputValues = input
    ? {
        integrated_lufs_db: measurementNumber(input.input_i),
        lra_lu: measurementNumber(input.input_lra),
        true_peak_dbtp: measurementNumber(input.input_tp),
      }
    : null;
  const outputValues = output
    ? {
        integrated_lufs_db: measurementNumber(output.input_i),
        lra_lu: measurementNumber(output.input_lra),
        true_peak_dbtp: measurementNumber(output.input_tp),
      }
    : null;
  const delta = {
    integrated_lufs_db: inputValues && outputValues && inputValues.integrated_lufs_db !== null && outputValues.integrated_lufs_db !== null
      ? Number((outputValues.integrated_lufs_db - inputValues.integrated_lufs_db).toFixed(3))
      : null,
    lra_lu: inputValues && outputValues && inputValues.lra_lu !== null && outputValues.lra_lu !== null
      ? Number((outputValues.lra_lu - inputValues.lra_lu).toFixed(3))
      : null,
    true_peak_dbtp: inputValues && outputValues && inputValues.true_peak_dbtp !== null && outputValues.true_peak_dbtp !== null
      ? Number((outputValues.true_peak_dbtp - inputValues.true_peak_dbtp).toFixed(3))
      : null,
  };
  const complete = Object.values(delta).every((value) => value !== null);
  return {
    status: complete ? "measured" : "hold",
    input,
    output,
    delta,
    tolerance: plan.measurement_tolerance,
    reason: complete
      ? "input/output loudness measurements were captured"
      : "optional loudness analyzer unavailable; preserve receipt is explicitly HOLD/degraded",
  };
}

function assertMusicMasterMeasurementTolerance(
  plan: MusicMasterAudioPlan,
  measurements: MusicMasterAudioReceipt["measurements"],
): void {
  if (plan.audio_decision !== "preserve" || plan.codec.operation !== "reencode") return;
  if (measurements.status !== "measured") return;
  const checks: Array<[number | null, number]> = [
    [measurements.delta.integrated_lufs_db, plan.measurement_tolerance.integrated_lufs_db],
    [measurements.delta.lra_lu, plan.measurement_tolerance.lra_lu],
    [measurements.delta.true_peak_dbtp, plan.measurement_tolerance.true_peak_dbtp],
  ];
  const exceeded = checks.some(([delta, tolerance]) => delta !== null && Math.abs(delta) > tolerance);
  if (exceeded) {
    throw new AudioRenderExecutionError(
      "AUDIO_RENDER_EXECUTION_FAILED",
      "music_master preserve reencode exceeded the declared LUFS/LRA/true-peak tolerance",
    );
  }
}

export async function executeAudioRenderPlan(
  options: ExecuteAudioRenderPlanOptions,
): Promise<ExecutedAudioRenderPlan> {
  const { plan } = options;
  if (plan.sfx_hold) {
    throw new AudioRenderExecutionError(
      "AUDIO_RENDER_EXECUTION_FAILED",
      "HOLD: formal A3 SFX selection is blocked: " + plan.sfx_hold.reason,
    );
  }
  if (plan.strategy === "legacy_embedded_bgm") {
    throw new AudioRenderExecutionError(
      "AUDIO_RENDER_LEGACY_MIXED_INPUT_FORBIDDEN",
      "legacy embedded BGM cannot enter the shared A1 dialogue-finishing executor",
    );
  }
  assertAudioRenderPlanContract(plan);
  if (plan.scene_audio_policy?.sfx.outcome === "human_hold") {
    throw new AudioRenderExecutionError(
      "AUDIO_RENDER_EXECUTION_FAILED",
      "HOLD: formal A3 SFX is not rights-pinned in the shared plan; no silent mute or partial render is allowed",
    );
  }
  if (plan.ambient?.clips.length && plan.scene_audio_policy?.ambient.outcome === "human_hold") {
    throw new AudioRenderExecutionError(
      "AUDIO_RENDER_EXECUTION_FAILED",
      "HOLD: authored A3 ambience is retained in the plan but unsupported by the shared executor; no silent mute or partial render is allowed",
    );
  }
  assertAudioRenderPlanFresh(
    plan,
    options.verifyPackPinsImpl ?? assertInstalledPackPins,
  );

  const outputDir = path.resolve(options.outputDir);
  const rawDialoguePath = path.resolve(
    options.outputPaths?.rawDialoguePath
      ?? path.join(outputDir, plan.expected_artifacts.dialogue_stem),
  );
  const finalMixPath = path.resolve(
    options.outputPaths?.finalMixPath
      ?? path.join(outputDir, plan.expected_artifacts.final_mix),
  );
  const masteredMp3Path = plan.strategy === "music_master"
    && plan.music_master?.audio_decision === "mastering"
    ? path.resolve(
        options.outputPaths?.masteredMp3Path
          ?? path.join(outputDir, plan.expected_artifacts.mastered_mp3!),
      )
    : undefined;
  const premasterMixPath = path.resolve(
    options.outputPaths?.premasterMixPath
      ?? path.join(outputDir, "premaster_mix.wav"),
  );
  const reportPath = path.resolve(
    options.outputPaths?.reportPath
      ?? path.join(outputDir, plan.expected_artifacts.report),
  );
  ensureOutputsAvailable(
    [
      rawDialoguePath,
      premasterMixPath,
      finalMixPath,
      ...(masteredMp3Path ? [masteredMp3Path] : []),
      reportPath,
    ],
    options.replaceExisting === true,
  );

  const workRoot = path.resolve(options.workDirRoot ?? os.tmpdir());
  fs.mkdirSync(workRoot, { recursive: true });
  const workDir = fs.mkdtempSync(path.join(workRoot, "vos-audio-render-"));
  const stagedRawDialogue = path.join(workDir, "raw_dialogue.wav");
  const stagedFinishedDialogue = path.join(workDir, "dialogue_finished.wav");
  const stagedPremaster = path.join(workDir, "premaster_mix.wav");
  const stagedFinalMix = path.join(workDir, "final_mix.wav");
  const stagedMasteredMp3 = path.join(workDir, "music_master_320.mp3");
  const planHash = hashAudioRenderPlan(plan);

  try {
    if (plan.strategy === "music_master") {
      const musicMaster = plan.music_master!;
      const sourcePath = resolveMusicMasterSourcePath(plan);
      let inputMeasurement = await tryMeasureAudioLoudness(sourcePath, plan.final_mastering);
      let mvpExecution: MusicMasterMvpExecution | undefined;
      let sourceBytesPreserved = musicMaster.codec.operation === "stream_copy";
      if (musicMaster.audio_decision === "mastering") {
        if (!musicMaster.mastering_policy || !masteredMp3Path) {
          throw new AudioRenderExecutionError(
            "AUDIO_RENDER_EXECUTION_FAILED",
            "music_master mastering is missing its fixed policy or MP3 output contract",
          );
        }
        if (!inputMeasurement) {
          throw new AudioRenderExecutionError(
            "AUDIO_RENDER_EXECUTION_FAILED",
            "music_master mastering source loudness measurement is unavailable",
          );
        }
        mvpExecution = await executeMusicMasterMvp({
          sourcePath,
          sourceRangeUs: musicMaster.source.source_range_us,
          outputWavPath: stagedFinalMix,
          outputMp3Path: stagedMasteredMp3,
          policy: musicMaster.mastering_policy,
        });
        fs.copyFileSync(sourcePath, stagedPremaster);
        sourceBytesPreserved = false;
      } else if (musicMaster.codec.operation === "stream_copy") {
        fs.copyFileSync(sourcePath, stagedFinalMix);
        fs.copyFileSync(sourcePath, stagedRawDialogue);
        fs.copyFileSync(sourcePath, stagedPremaster);
      } else {
        await runFfmpeg(buildMusicMasterAudioArgs(plan, sourcePath, stagedFinalMix));
        fs.copyFileSync(stagedFinalMix, stagedPremaster);
        fs.copyFileSync(sourcePath, stagedRawDialogue);
        sourceBytesPreserved = false;
      }
      if (musicMaster.audio_decision === "mastering") {
        fs.copyFileSync(sourcePath, stagedRawDialogue);
      }
      const outputMeasurement = mvpExecution?.pass2.raw
        ?? await tryMeasureAudioLoudness(stagedFinalMix, plan.final_mastering);
      if (musicMaster.audio_decision === "mastering" && !outputMeasurement) {
        throw new AudioRenderExecutionError(
          "AUDIO_RENDER_EXECUTION_FAILED",
          "music_master mastering output loudness measurement is unavailable",
        );
      }
      const measurements = buildMusicMasterMeasurements(musicMaster, inputMeasurement, outputMeasurement);
      assertMusicMasterMeasurementTolerance(musicMaster, measurements);
      const outputEvidence = fileEvidence(stagedFinalMix);
      if (musicMaster.codec.operation === "stream_copy"
        && outputEvidence.content_hash !== musicMaster.source.source_content_hash) {
        throw new AudioRenderExecutionError(
          "AUDIO_RENDER_EXECUTION_FAILED",
          "music_master stream-copy output hash differs from the source hash",
        );
      }
      const encodedResult = await measureEncodedAudioResult({
        path: stagedFinalMix,
        humanAuditionRequired: plan.audio_measurement_requirements?.human_audition.required ?? true,
        mastering: {
          owner: plan.final_mastering.owner ?? "shared_audio_render_plan",
          stage: plan.final_mastering.stage,
          pass_count: plan.final_mastering.count,
          applied_processing: plan.final_mastering.count === 1 ? ["shared_final_mastering"] : [],
        },
      });
      encodedResult.path = plan.expected_artifacts.final_mix;
      if (encodedResult.status === "failed") {
        throw new AudioRenderExecutionError(
          "AUDIO_RENDER_EXECUTION_FAILED",
          "music_master output failed encoded audio inspection",
        );
      }
      if (musicMaster.audio_decision === "mastering"
        && (encodedResult.status !== "verified" || encodedResult.loudness.status !== "measured")) {
        throw new AudioRenderExecutionError(
          "AUDIO_RENDER_EXECUTION_FAILED",
          "music_master mastering encoded WAV evidence is unavailable; final-ready output is forbidden",
        );
      }
      const warnings = [...plan.warnings];
      if (measurements.status !== "measured") {
        warnings.push("HOLD: optional loudness analyzer was unavailable; no tolerance claim was made for music_master preserve.");
      }
      if (encodedResult.status === "unavailable") {
        warnings.push("HOLD: optional encoded audio analyzer was unavailable; output codec/loudness evidence is degraded.");
      }
      const musicMasterReceipt: MusicMasterAudioReceipt = {
        role: "music_master",
        audio_decision: musicMaster.audio_decision,
        source: musicMaster.source,
        input_audio_hash: musicMaster.input_audio_hash,
        output_audio_hash: outputEvidence.content_hash,
        source_bytes_preserved: sourceBytesPreserved,
        processing_graph: musicMaster.processing_graph,
        codec: {
          input: musicMaster.codec.input,
          output: musicMaster.audio_decision === "mastering"
            ? "pcm_s24le"
            : encodedResult.audio_stream.codec_name ?? musicMaster.codec.output,
          operation: musicMaster.codec.operation,
        },
        ...(mvpExecution ? {
          mastering: {
            version: "music-master-mvp-receipt/v1" as const,
            plan_hash: planHash,
            policy_hash: musicMaster.policy_hash,
            execution_graph: mvpExecution.execution_graph,
            pass1: mvpExecution.pass1,
            pass2: mvpExecution.pass2,
            mp3: mvpExecution.mp3,
            deliverables: {
              wav24: {
                path: plan.expected_artifacts.final_mix,
                ...mvpExecution.wav,
              },
              mp3_320: {
                path: plan.expected_artifacts.mastered_mp3!,
                ...mvpExecution.mp3_output,
              },
            },
            human_approval: {
              stereo_width: "pending" as const,
              tonal_balance: "pending" as const,
              lyric_clarity: "pending" as const,
              automated_quality_claim: "not_allowed" as const,
            },
          },
        } : {}),
        measurements,
      };
      const report: AudioMixReport = {
        version: "audio-mix-report/v2",
        project_id: plan.project_id,
        plan_hash: planHash,
        has_bgm: false,
        strategy: "shared_audio_render_plan_v1",
        input_hashes: {
          timeline: plan.timeline.content_hash,
          dialogue_sources: [],
          cue_sources: [],
          music_master: {
            asset_id: musicMaster.source.asset_id,
            content_hash: musicMaster.source.source_content_hash,
            size_bytes: musicMaster.source.source_size_bytes,
          },
        },
        output: {
          ...outputEvidence,
          sample_rate_hz: encodedResult.audio_stream.sample_rate_hz ?? SAMPLE_RATE_HZ,
          channels: encodedResult.audio_stream.channels ?? CHANNELS,
        },
        ...(plan.audio_measurement_requirements
          ? { audio_measurement_requirements: plan.audio_measurement_requirements }
          : {}),
        encoded_result: encodedResult,
        music_master: musicMasterReceipt,
        stems: [{
          stem_id: "music_master",
          role: "music_master",
          source_track_id: "music_master",
          ...outputEvidence,
          finish_applied: false,
        }],
        cues: [],
        dialogue_finish_scope: "none",
        mastering_count: plan.final_mastering.count,
        execution_strategy: {
          id: "shared_audio_render_plan_executor_v1",
          stages: [
            "bind_music_master",
            ...(mvpExecution
              ? mvpExecution.execution_graph.stages
              : [musicMaster.codec.operation === "stream_copy" ? "stream_copy_source" : "trim_reencode_source"]),
          ],
          deterministic_input_order: ["music_master"],
        },
        final_mastering: {
          applied: plan.final_mastering.count === 1,
          loudness_target_lufs: plan.final_mastering.loudness_target_lufs,
          lra_target: plan.final_mastering.lra_target,
          true_peak_target_dbtp: plan.final_mastering.true_peak_target_dbtp,
          premaster_measurement: inputMeasurement,
          output_measurement: outputMeasurement,
          owner: plan.final_mastering.owner ?? "shared_audio_render_plan",
          stage: plan.final_mastering.stage,
          applied_processing: mvpExecution
            ? ["music_master_mvp/v1"]
            : plan.final_mastering.count === 1 ? ["shared_final_mastering"] : [],
        },
        warnings,
      };
      validateArtifact(report, "audio-mix-report.schema.json");
      const stagedReport = path.join(workDir, "audio-mix-report.json");
      fs.writeFileSync(stagedReport, `${JSON.stringify(report, null, 2)}\n`, "utf8");
      copyArtifact(stagedRawDialogue, rawDialoguePath, options.replaceExisting === true);
      copyArtifact(stagedPremaster, premasterMixPath, options.replaceExisting === true);
      copyArtifact(stagedFinalMix, finalMixPath, options.replaceExisting === true);
      if (mvpExecution && masteredMp3Path) {
        copyArtifact(stagedMasteredMp3, masteredMp3Path, options.replaceExisting === true);
      }
      copyArtifact(stagedReport, reportPath, options.replaceExisting === true);
      return {
        planHash,
        rawDialoguePath,
        premasterMixPath,
        finalMixPath,
        ...(masteredMp3Path ? { masteredMp3Path } : {}),
        reportPath,
        report,
        ...(options.cleanupWorkDir === false ? { workDir } : {}),
      };
    }
    await runFfmpeg(buildDialogueStemArgs(plan, stagedRawDialogue));

    let dialogueForMix = stagedRawDialogue;
    let dialogueFinishApplied = false;
    if (plan.dialogue.finish_scope === "a1_only" && plan.dialogue.finish_policy) {
      if (plan.final_mastering.count === 1) {
        await preprocessDialogueAudio({
          inputPath: stagedRawDialogue,
          outputPath: stagedFinishedDialogue,
          policy: plan.dialogue.finish_policy,
        });
      } else {
        await finishDialogueAudio({
          inputPath: stagedRawDialogue,
          outputPath: stagedFinishedDialogue,
          policy: plan.dialogue.finish_policy,
        });
      }
      dialogueForMix = stagedFinishedDialogue;
      dialogueFinishApplied = true;
    }

    const cueArtifacts: Array<{
      cue: AudioRenderCue;
      renderedPath: string;
      sidechainPath: string;
    }> = [];
    for (const [index, cue] of plan.music.cues.entries()) {
      const prefix = `${String(index + 1).padStart(3, "0")}-${cue.cue_id}`;
      const renderedPath = path.join(workDir, `${prefix}-gain-fade.wav`);
      const sidechainPath = path.join(workDir, `${prefix}-sidechain.wav`);
      await runFfmpeg(buildCueRenderArgs(cue, renderedPath));
      await runFfmpeg(buildSidechainCueArgs(
        plan,
        cue,
        dialogueForMix,
        renderedPath,
        sidechainPath,
      ));
      cueArtifacts.push({ cue, renderedPath, sidechainPath });
    }
    const sfxArtifacts: Array<{
      cue: AudioRenderSfxCue;
      renderedPath: string;
      a3Path: string;
    }> = [];
    for (const [index, cue] of (plan.sfx?.cues ?? []).entries()) {
      const prefix = `sfx-${String(index + 1).padStart(3, "0")}-${cue.cue_id}`;
      const renderedPath = path.join(workDir, `${prefix}-cut-gain-fade-tail.wav`);
      const a3Path = path.join(workDir, `${prefix}-a3.wav`);
      await runFfmpeg(buildSfxCueRenderArgs(cue, renderedPath));
      await runFfmpeg(buildPlacedSfxCueArgs(
        plan,
        cue,
        dialogueForMix,
        renderedPath,
        a3Path,
      ));
      sfxArtifacts.push({ cue, renderedPath, a3Path });
    }

    if (plan.strategy === "original_passthrough") {
      fs.copyFileSync(stagedRawDialogue, stagedFinalMix);
    } else {
      await runFfmpeg(buildPremasterMixArgs(
        plan,
        dialogueForMix,
        [
          ...cueArtifacts.map((artifact) => artifact.sidechainPath),
          ...sfxArtifacts.map((artifact) => artifact.a3Path),
        ],
        stagedPremaster,
      ));
      await masterAudio(stagedPremaster, stagedFinalMix, plan.final_mastering);
    }

    const premasterMeasurement = plan.final_mastering.count === 1
      ? await tryMeasureAudioLoudness(stagedPremaster, plan.final_mastering)
      : await tryMeasureAudioLoudness(stagedFinalMix, plan.final_mastering);
    const outputMeasurement = await tryMeasureAudioLoudness(
      stagedFinalMix,
      plan.final_mastering,
    );
    const encodedResult = await measureEncodedAudioResult({
      path: stagedFinalMix,
      humanAuditionRequired: plan.audio_measurement_requirements?.human_audition.required ?? true,
      mastering: {
        owner: plan.final_mastering.owner ?? "shared_audio_render_plan",
        stage: plan.final_mastering.stage,
        pass_count: plan.final_mastering.count,
        applied_processing: [
          ...(dialogueFinishApplied ? ["existing_dialogue_finishing:a1_only"] : []),
          ...(plan.final_mastering.count === 1 ? ["loudnorm:single_final_mastering"] : []),
        ],
      },
    });
    // Keep the report canonical across output/work directories. The content
    // hash remains the actual staged result hash.
    encodedResult.path = plan.expected_artifacts.final_mix;
    const rawDialogueEvidence = fileEvidence(stagedRawDialogue);
    const dialogueForMixEvidence = fileEvidence(dialogueForMix);
    const outputEvidence = fileEvidence(stagedFinalMix);
    const firstCue = plan.music.cues[0];
    const sfxMeasurements = await Promise.all(
      sfxArtifacts.map(async ({ cue, a3Path }) => ({
        cue_id: cue.cue_id,
        measurement: await tryMeasureAudioLoudness(a3Path, plan.final_mastering),
      })),
    );
    const sfxMeasurementByCue = new Map(
      sfxMeasurements.map((entry) => [entry.cue_id, entry.measurement]),
    );
    const peakForSfx = (cueId: string): number | null => {
      const raw = sfxMeasurementByCue.get(cueId)?.input_tp;
      if (raw === undefined || raw === "-inf") return null;
      const value = Number.parseFloat(raw);
      return Number.isFinite(value) ? value : null;
    };
    const report: AudioMixReport = {
      version: "audio-mix-report/v2",
      project_id: plan.project_id,
      plan_hash: planHash,
      has_bgm: plan.music.enabled,
      ...(plan.sfx ? { has_sfx: plan.sfx.enabled } : {}),
      strategy: "shared_audio_render_plan_v1",
      input_hashes: {
        timeline: plan.timeline.content_hash,
        ...(plan.inputs.music_cues_content_hash
          ? { music_cues: plan.inputs.music_cues_content_hash }
          : {}),
        ...(plan.inputs.sfx_cues_content_hash
          ? { sfx_cues: plan.inputs.sfx_cues_content_hash }
          : {}),
        ...(plan.inputs.sfx_library_manifest_hash
          ? { sfx_library_manifest: plan.inputs.sfx_library_manifest_hash }
          : {}),
        ...(plan.inputs.sound_design_decision_content_hash
          ? {
              sound_design_decision:
                plan.inputs.sound_design_decision_content_hash,
            }
          : {}),
        dialogue_sources: plan.dialogue.clips.map((clip) => ({
          clip_id: clip.clip_id,
          content_hash: clip.source_content_hash,
          size_bytes: clip.source_size_bytes,
        })),
        cue_sources: plan.music.cues.map((cue) => ({
          cue_id: cue.cue_id,
          content_hash: cue.pins.full_mix_content_hash,
          size_bytes: cue.pins.full_mix_size_bytes,
        })),
        ...(plan.sfx
          ? {
              sfx_sources: plan.sfx.cues.map((cue) => ({
                cue_id: cue.cue_id,
                asset_id: cue.asset_id,
                content_hash: cue.pins.asset_content_hash,
                size_bytes: cue.pins.asset_size_bytes,
              })),
            }
          : {}),
      },
      output: {
        ...outputEvidence,
        sample_rate_hz: SAMPLE_RATE_HZ,
        channels: CHANNELS,
      },
      ...(plan.audio_delivery_profile ? { audio_delivery_profile: plan.audio_delivery_profile } : {}),
      ...(plan.scene_audio_policy ? { scene_audio_policy: plan.scene_audio_policy } : {}),
      ...(plan.audio_measurement_requirements
        ? { audio_measurement_requirements: plan.audio_measurement_requirements }
        : {}),
      encoded_result: encodedResult,
      stems: [
        {
          stem_id: "A1",
          role: "dialogue",
          source_track_id: "A1",
          ...dialogueForMixEvidence,
          finish_applied: dialogueFinishApplied,
        },
        ...cueArtifacts.map(({ cue, sidechainPath }) => ({
          stem_id: cue.cue_id,
          role: "music" as const,
          source_track_id: "A2" as const,
          ...fileEvidence(sidechainPath),
          finish_applied: false,
        })),
        ...sfxArtifacts.map(({ cue, a3Path }) => ({
          stem_id: cue.cue_id,
          role: "sfx" as const,
          source_track_id: "A3" as const,
          ...fileEvidence(a3Path),
          finish_applied: false,
        })),
      ],
      cues: cueArtifacts.map(({ cue, renderedPath, sidechainPath }) => ({
        cue_id: cue.cue_id,
        track_id: cue.track_id,
        timeline_range: cue.timeline_range,
        source_range_us: cue.source_range_us,
        applied: cue.applied,
        pins: cue.pins,
        rendered_content_hash: hashFile(renderedPath),
        sidechain_content_hash: hashFile(sidechainPath),
      })),
      ...(plan.sfx
        ? {
            sfx_cues: sfxArtifacts.map(({ cue, renderedPath, a3Path }) => {
              const peak = peakForSfx(cue.cue_id);
              return {
                cue_id: cue.cue_id,
                semantic_role: cue.semantic_role,
                asset_id: cue.asset_id,
                timeline_range: cue.timeline_range,
                source_range_us: cue.source_range_us,
                dialogue_overlap_frames: cue.dialogue_overlap_frames,
                applied: cue.applied,
                tail_processing: cue.tail_processing,
                pins: cue.pins,
                ...(cue.decision_pin
                  ? { decision_pin: cue.decision_pin }
                  : {}),
                rendered_content_hash: hashFile(renderedPath),
                a3_output_content_hash: hashFile(a3Path),
                peak_dbtp: peak,
                headroom_db: peak === null ? null : Number((-peak).toFixed(3)),
              };
            }),
          }
        : {}),
      dialogue_finish_scope: plan.dialogue.finish_scope,
      mastering_count: plan.final_mastering.count,
      execution_strategy: {
        id: "shared_audio_render_plan_executor_v1",
        stages: [
          "extract_a1_stem",
          ...(dialogueFinishApplied ? ["finish_a1_only"] : []),
          ...(plan.music.enabled
            ? ["cut_a2_cues", "apply_cue_gain_and_fades", "waveform_sidechain_ducking"]
            : []),
          ...(plan.sfx?.enabled
            ? [
                "cut_a3_cues",
                "apply_sfx_gain_fades_and_tail",
                "apply_sfx_dialogue_sidechain",
              ]
            : []),
          "mix_stems",
          ...(plan.final_mastering.count === 1 ? ["single_final_mastering"] : []),
        ],
        deterministic_input_order: [
          ...plan.dialogue.clips.map((clip) => `A1:${clip.clip_id}`),
          ...plan.music.cues.map((cue) => `A2:${cue.cue_id}`),
          ...(plan.sfx?.cues ?? []).map((cue) => `A3:${cue.cue_id}`),
        ],
      },
      ...(plan.music.enabled ? {
        sidechain_evidence: {
          detector: "dialogue_waveform_rms",
          dialogue_stem_content_hash: dialogueForMixEvidence.content_hash,
          threshold: SIDECHAIN_THRESHOLD,
          per_cue: cueArtifacts.map(({ cue, sidechainPath }) => ({
            cue_id: cue.cue_id,
            ratio: ratioForCue(cue),
            attack_ms: cue.applied.attack_ms,
            release_ms: cue.applied.release_ms,
            requested_duck_gain_db: cue.applied.duck_gain_db,
            sidechain_output_content_hash: hashFile(sidechainPath),
          })),
        },
        ...(firstCue ? {
          sidechain: {
            detector: "dialogue_waveform_rms" as const,
            threshold: SIDECHAIN_THRESHOLD,
            ratio: ratioForCue(firstCue),
            attack_ms: firstCue.applied.attack_ms,
            release_ms: firstCue.applied.release_ms,
            base_gain_db: firstCue.applied.base_gain_db,
            requested_duck_gain_db: firstCue.applied.duck_gain_db,
          },
        } : {}),
      } : {}),
      ...(plan.sfx?.enabled ? {
        sfx_sidechain_evidence: {
          detector: "dialogue_waveform_rms",
          dialogue_stem_content_hash: dialogueForMixEvidence.content_hash,
          threshold: SIDECHAIN_THRESHOLD,
          per_cue: sfxArtifacts.map(({ cue, a3Path }) => ({
            cue_id: cue.cue_id,
            duck_group: cue.applied.duck_group,
            ratio: ratioForSfxCue(cue),
            attack_ms: cue.applied.attack_ms,
            release_ms: cue.applied.release_ms,
            requested_duck_gain_db: cue.applied.duck_gain_db,
            dialogue_overlap_frames: cue.dialogue_overlap_frames,
            sidechain_applied: cue.applied.duck_group === "dialogue",
            a3_output_content_hash: hashFile(a3Path),
          })),
        },
        sfx_peak: {
          maximum_peak_dbtp: (() => {
            const values = sfxArtifacts
              .map(({ cue }) => peakForSfx(cue.cue_id))
              .filter((value): value is number => value !== null);
            return values.length > 0 ? Math.max(...values) : null;
          })(),
          minimum_headroom_db: (() => {
            const values = sfxArtifacts
              .map(({ cue }) => peakForSfx(cue.cue_id))
              .filter((value): value is number => value !== null)
              .map((value) => -value);
            return values.length > 0
              ? Number(Math.min(...values).toFixed(3))
              : null;
          })(),
        },
      } : {}),
      final_mastering: {
        applied: plan.final_mastering.count === 1,
        loudness_target_lufs: plan.final_mastering.loudness_target_lufs,
        lra_target: plan.final_mastering.lra_target,
        true_peak_target_dbtp: plan.final_mastering.true_peak_target_dbtp,
        premaster_measurement: premasterMeasurement,
        output_measurement: outputMeasurement,
        owner: plan.final_mastering.owner ?? "shared_audio_render_plan",
        stage: plan.final_mastering.stage,
        applied_processing: [
          ...(dialogueFinishApplied ? ["existing_dialogue_finishing:a1_only"] : []),
          ...(plan.final_mastering.count === 1 ? ["loudnorm:single_final_mastering"] : []),
        ],
      },
      warnings: plan.warnings,
    };
    validateArtifact(report, "audio-mix-report.schema.json");

    const stagedReport = path.join(workDir, "audio-mix-report.json");
    fs.writeFileSync(stagedReport, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    copyArtifact(
      stagedRawDialogue,
      rawDialoguePath,
      options.replaceExisting === true,
    );
    copyArtifact(
      plan.final_mastering.count === 1 ? stagedPremaster : stagedRawDialogue,
      premasterMixPath,
      options.replaceExisting === true,
    );
    copyArtifact(stagedFinalMix, finalMixPath, options.replaceExisting === true);
    copyArtifact(stagedReport, reportPath, options.replaceExisting === true);
    return {
      planHash,
      rawDialoguePath,
      premasterMixPath,
      finalMixPath,
      reportPath,
      report,
      ...(options.cleanupWorkDir === false ? { workDir } : {}),
    };
  } finally {
    if (options.cleanupWorkDir !== false) {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  }
}
