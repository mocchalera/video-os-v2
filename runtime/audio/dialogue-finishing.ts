import type { LoudnormMeasurement } from "./mastering.js";

export type AudioFinishPreset = "dialogue-clean" | "loudness-only" | "none";

export interface AudioFinishPolicy {
  preset: AudioFinishPreset;
  loudness_target_lufs?: number;
  lra_target?: number;
  true_peak_target_dbtp?: number;
  codec_headroom_db?: number;
  highpass_hz?: number;
  lowpass_hz?: number;
  noise_reduction_db?: number;
  noise_floor_db?: number;
  mud_cut_db?: number;
  presence_gain_db?: number;
  compressor_threshold_db?: number;
  compressor_ratio?: number;
  compressor_attack_ms?: number;
  compressor_release_ms?: number;
  compressor_makeup_db?: number;
}

export interface ResolvedAudioFinishPolicy {
  preset: Exclude<AudioFinishPreset, "none">;
  loudness_target_lufs: number;
  lra_target: number;
  true_peak_target_dbtp: number;
  codec_headroom_db: number;
  highpass_hz: number;
  lowpass_hz: number;
  noise_reduction_db: number;
  noise_floor_db: number;
  mud_cut_db: number;
  presence_gain_db: number;
  compressor_threshold_db: number;
  compressor_ratio: number;
  compressor_attack_ms: number;
  compressor_release_ms: number;
  compressor_makeup_db: number;
}

export const DEFAULT_DIALOGUE_FINISH: ResolvedAudioFinishPolicy = {
  preset: "dialogue-clean",
  loudness_target_lufs: -16,
  lra_target: 7,
  true_peak_target_dbtp: -1.5,
  codec_headroom_db: 0.3,
  highpass_hz: 70,
  lowpass_hz: 15_000,
  noise_reduction_db: 8,
  noise_floor_db: -50,
  mud_cut_db: -1.5,
  presence_gain_db: 1.5,
  compressor_threshold_db: -27,
  compressor_ratio: 3,
  compressor_attack_ms: 15,
  compressor_release_ms: 180,
  compressor_makeup_db: 6,
};

export const DEFAULT_LOUDNESS_ONLY_FINISH: ResolvedAudioFinishPolicy = {
  ...DEFAULT_DIALOGUE_FINISH,
  preset: "loudness-only",
  codec_headroom_db: 0,
};

export function resolveAudioFinishPolicy(
  value: unknown,
): ResolvedAudioFinishPolicy | undefined {
  if (!isRecord(value)) return undefined;
  const preset = value.preset;
  if (preset === "none") return undefined;
  if (preset !== "dialogue-clean" && preset !== "loudness-only") return undefined;
  const defaults = preset === "dialogue-clean"
    ? DEFAULT_DIALOGUE_FINISH
    : DEFAULT_LOUDNESS_ONLY_FINISH;
  return {
    preset,
    loudness_target_lufs: bounded(value.loudness_target_lufs, -24, -8, defaults.loudness_target_lufs),
    lra_target: bounded(value.lra_target, 1, 20, defaults.lra_target),
    true_peak_target_dbtp: bounded(value.true_peak_target_dbtp, -6, -0.1, defaults.true_peak_target_dbtp),
    codec_headroom_db: bounded(value.codec_headroom_db, 0, 3, defaults.codec_headroom_db),
    highpass_hz: bounded(value.highpass_hz, 20, 300, defaults.highpass_hz),
    lowpass_hz: bounded(value.lowpass_hz, 5_000, 22_000, defaults.lowpass_hz),
    noise_reduction_db: bounded(value.noise_reduction_db, 0, 30, defaults.noise_reduction_db),
    noise_floor_db: bounded(value.noise_floor_db, -80, -20, defaults.noise_floor_db),
    mud_cut_db: bounded(value.mud_cut_db, -12, 0, defaults.mud_cut_db),
    presence_gain_db: bounded(value.presence_gain_db, 0, 8, defaults.presence_gain_db),
    compressor_threshold_db: bounded(value.compressor_threshold_db, -60, -1, defaults.compressor_threshold_db),
    compressor_ratio: bounded(value.compressor_ratio, 1, 12, defaults.compressor_ratio),
    compressor_attack_ms: bounded(value.compressor_attack_ms, 0.1, 500, defaults.compressor_attack_ms),
    compressor_release_ms: bounded(value.compressor_release_ms, 10, 3_000, defaults.compressor_release_ms),
    compressor_makeup_db: bounded(value.compressor_makeup_db, 0, 18, defaults.compressor_makeup_db),
  };
}

export function buildAudioFinishMeasurementFilter(
  policy: ResolvedAudioFinishPolicy,
): string {
  return [
    ...buildAudioFinishPreFilters(policy),
    loudnormBase(policy, true),
  ].join(",");
}

export function buildAudioFinishApplyFilter(
  policy: ResolvedAudioFinishPolicy,
  measurement: LoudnormMeasurement,
): string {
  return [
    ...buildAudioFinishPreFilters(policy),
    [
      loudnormBase(policy, false),
      `measured_I=${measurement.input_i}`,
      `measured_LRA=${measurement.input_lra}`,
      `measured_TP=${measurement.input_tp}`,
      `measured_thresh=${measurement.input_thresh}`,
      `offset=${measurement.target_offset}`,
      "linear=true",
    ].join(":"),
  ].join(",");
}

export function buildAudioFinishPass1Args(
  inputPath: string,
  policy: ResolvedAudioFinishPolicy,
): string[] {
  return [
    "-i", inputPath,
    "-af", buildAudioFinishMeasurementFilter(policy),
    "-f", "null",
    "-",
  ];
}

function buildAudioFinishPreFilters(policy: ResolvedAudioFinishPolicy): string[] {
  if (policy.preset === "loudness-only") return [];
  return [
    `highpass=f=${formatNumber(policy.highpass_hz)}:p=2`,
    `lowpass=f=${formatNumber(policy.lowpass_hz)}:p=2`,
    `afftdn=nr=${formatNumber(policy.noise_reduction_db)}:nf=${formatNumber(policy.noise_floor_db)}:tn=1`,
    `equalizer=f=250:t=q:w=1:g=${formatNumber(policy.mud_cut_db)}`,
    `equalizer=f=3500:t=q:w=0.8:g=${formatNumber(policy.presence_gain_db)}`,
    [
      `acompressor=threshold=${formatNumber(dbToLinear(policy.compressor_threshold_db))}`,
      `ratio=${formatNumber(policy.compressor_ratio)}`,
      `attack=${formatNumber(policy.compressor_attack_ms)}`,
      `release=${formatNumber(policy.compressor_release_ms)}`,
      `makeup=${formatNumber(dbToLinear(policy.compressor_makeup_db))}`,
      "knee=2.5",
    ].join(":"),
  ];
}

function loudnormBase(policy: ResolvedAudioFinishPolicy, measurement: boolean): string {
  const processingPeak = policy.true_peak_target_dbtp - policy.codec_headroom_db;
  return [
    `loudnorm=I=${formatNumber(policy.loudness_target_lufs)}`,
    `LRA=${formatNumber(policy.lra_target)}`,
    `TP=${formatNumber(processingPeak)}`,
    ...(measurement ? ["print_format=json"] : []),
  ].join(":");
}

function dbToLinear(db: number): number {
  return 10 ** (db / 20);
}

function formatNumber(value: number): string {
  return value.toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
}

function bounded(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(max, Math.max(min, value))
    : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
