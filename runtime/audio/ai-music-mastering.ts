/**
 * AI-music dedicated mastering chain (Issue #38).
 *
 * AI-generated music masters (Suno/Udio raw stems) get a dedicated 3-stage
 * tone chain followed by an EBU R128 two-pass loudnorm when the route is
 * `standalone_sns_master`:
 *
 *   Stage 1 (cleanup)      35 Hz HPF, 280 Hz mud cut (Q 1.5, -2.0 dB),
 *                          100 Hz tight boost (Q 1.2, +1.8 dB)
 *   Stage 2 (presence/air) 3.2 kHz vocal presence (Q 1.2, +2.5 dB),
 *                          12 kHz silky air (Q 1.0, +2.2 dB)
 *   Stage 3 (spatial/glue) 120 % stereo width (extrastereo),
 *                          soft-knee multiband compand (mcompand)
 *   Loudness (SNS route)   2-pass loudnorm, target -13.3 LUFS
 *
 * True-peak targets are separated (Claude review C1, Issue #38):
 *   - Processing target: loudnorm limits to -2.0 dBTP. Hot material whose
 *     limiter engages needs headroom below the acceptance ceiling because
 *     the loudnorm true-peak limiter can overshoot its own target and the
 *     320 kbps MP3 re-encode raises true peak again (measured up to ~1 dB
 *     combined on inter-sample-peak-heavy material).
 *   - Acceptance ceiling: verification still fails anything above
 *     -1.0 dBTP. The two values are independent policy fields, and the
 *     processing target is fail-closed validated to sit at or below the
 *     ceiling.
 *
 * Route semantics keep the #23 shared mastering identity intact:
 * - `source_premaster` applies the tone chain only — no loudnorm anywhere —
 *   so loudness normalization stays owned by the single shared post-mix
 *   mastering pass (`shared_audio_render_plan`, stage `after_mix`).
 * - `standalone_sns_master` is a dedicated finishing route for AI music
 *   delivered directly (like `audio-finish-remux`); it runs exactly one
 *   loudnorm stage inside its own chain.
 *
 * The chain is executed by ffmpeg (real filter path), the result is
 * re-measured, and verification is fail-closed: an output outside the
 * Issue #38 acceptance band (-13.3 ± 0.5 LUFS, TP <= -1.0 dBTP) or with
 * missing clipping evidence throws after the evidence receipt has been
 * written. Missing optional tooling is reported as explicit capability,
 * never as fabricated numbers.
 */

import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { validateAgainstSchema } from "../commands/shared.js";
import { computeSha256 } from "../packaging/manifest.js";
import {
  MASTERING_SAMPLE_RATE_HZ,
  parseLoudnormOutput,
  type LoudnormMeasurement,
} from "./mastering.js";

// ── Policy ─────────────────────────────────────────────────────────

export type AiMusicMasteringRoute =
  | "standalone_sns_master"
  | "source_premaster";

export interface AiMusicMasteringPolicy {
  route?: AiMusicMasteringRoute;
  loudness_target_lufs?: number;
  lra_target?: number;
  true_peak_target_dbtp?: number;
  processing_true_peak_target_dbtp?: number;
  loudness_tolerance_lufs?: number;
  highpass_hz?: number;
  mud_cut_hz?: number;
  mud_cut_q?: number;
  mud_cut_gain_db?: number;
  low_tight_hz?: number;
  low_tight_q?: number;
  low_tight_gain_db?: number;
  presence_hz?: number;
  presence_q?: number;
  presence_gain_db?: number;
  air_hz?: number;
  air_q?: number;
  air_gain_db?: number;
  stereo_width?: number;
  encode_mp3_320?: boolean;
}

export interface ResolvedAiMusicMasteringPolicy {
  route: AiMusicMasteringRoute;
  loudness_target_lufs: number;
  lra_target: number;
  true_peak_target_dbtp: number;
  processing_true_peak_target_dbtp: number;
  loudness_tolerance_lufs: number;
  highpass_hz: number;
  mud_cut_hz: number;
  mud_cut_q: number;
  mud_cut_gain_db: number;
  low_tight_hz: number;
  low_tight_q: number;
  low_tight_gain_db: number;
  presence_hz: number;
  presence_q: number;
  presence_gain_db: number;
  air_hz: number;
  air_q: number;
  air_gain_db: number;
  stereo_width: number;
  encode_mp3_320: boolean;
}

/**
 * Issue #38 acceptance values. `true_peak_target_dbtp` is the acceptance
 * ceiling enforced by verification; `processing_true_peak_target_dbtp` is
 * the separate loudnorm processing target that keeps hot material whose
 * limiter engages inside that ceiling (see the header note). The
 * loudness/true-peak targets are the internal SNS mastering decision from
 * the issue, not a platform claim: platform normalization stays opaque
 * (see delivery profile `audio-internal-ai-music-sns-v1`).
 */
export const DEFAULT_AI_MUSIC_MASTERING: ResolvedAiMusicMasteringPolicy = {
  route: "standalone_sns_master",
  loudness_target_lufs: -13.3,
  lra_target: 11,
  true_peak_target_dbtp: -1.0,
  processing_true_peak_target_dbtp: -2.0,
  loudness_tolerance_lufs: 0.5,
  highpass_hz: 35,
  mud_cut_hz: 280,
  mud_cut_q: 1.5,
  mud_cut_gain_db: -2.0,
  low_tight_hz: 100,
  low_tight_q: 1.2,
  low_tight_gain_db: 1.8,
  presence_hz: 3_200,
  presence_q: 1.2,
  presence_gain_db: 2.5,
  air_hz: 12_000,
  air_q: 1.0,
  air_gain_db: 2.2,
  stereo_width: 1.2,
  encode_mp3_320: true,
};

const POLICY_BOUNDS = {
  loudness_target_lufs: { min: -24, max: -8 },
  lra_target: { min: 1, max: 20 },
  true_peak_target_dbtp: { min: -6, max: -0.1 },
  processing_true_peak_target_dbtp: { min: -12, max: -0.2 },
  loudness_tolerance_lufs: { min: 0.1, max: 2 },
  highpass_hz: { min: 20, max: 120 },
  mud_cut_hz: { min: 120, max: 500 },
  mud_cut_q: { min: 0.3, max: 8 },
  mud_cut_gain_db: { min: -12, max: 0 },
  low_tight_hz: { min: 40, max: 160 },
  low_tight_q: { min: 0.3, max: 8 },
  low_tight_gain_db: { min: 0, max: 8 },
  presence_hz: { min: 1_000, max: 6_000 },
  presence_q: { min: 0.3, max: 8 },
  presence_gain_db: { min: 0, max: 8 },
  air_hz: { min: 8_000, max: 18_000 },
  air_q: { min: 0.3, max: 8 },
  air_gain_db: { min: 0, max: 8 },
  stereo_width: { min: 1, max: 2 },
} as const;

export class AiMusicMasteringPolicyError extends Error {
  constructor(issues: string[]) {
    super(`invalid AI music mastering policy: ${issues.join("; ")}`);
    this.name = "AiMusicMasteringPolicyError";
  }
}

/**
 * Resolve a policy with the Issue #38 defaults. Unlike the dialogue
 * finishing resolver this is fail-closed: an explicit out-of-range value
 * throws instead of being silently clamped, so a master is never produced
 * with different parameters than the caller asked for.
 */
export function resolveAiMusicMasteringPolicy(
  value: unknown = {},
): ResolvedAiMusicMasteringPolicy {
  const issues: string[] = [];
  const resolved: ResolvedAiMusicMasteringPolicy = {
    ...DEFAULT_AI_MUSIC_MASTERING,
  };
  if (value === null || value === undefined) {
    return resolved;
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new AiMusicMasteringPolicyError(["policy must be an object"]);
  }
  const input = value as Record<string, unknown>;
  const route = input.route;
  if (route !== undefined) {
    if (route === "standalone_sns_master" || route === "source_premaster") {
      resolved.route = route;
    } else {
      issues.push(`route must be standalone_sns_master or source_premaster, got ${String(route)}`);
    }
  }
  const numericKeys = Object.keys(POLICY_BOUNDS) as Array<
    keyof typeof POLICY_BOUNDS
  >;
  for (const key of numericKeys) {
    const raw = input[key];
    if (raw === undefined) continue;
    if (typeof raw !== "number" || !Number.isFinite(raw)) {
      issues.push(`${key} must be a finite number, got ${String(raw)}`);
      continue;
    }
    const { min, max } = POLICY_BOUNDS[key];
    if (raw < min || raw > max) {
      issues.push(`${key} must be within [${min}, ${max}], got ${String(raw)}`);
      continue;
    }
    (resolved[key] as number) = raw;
  }
  const mp3 = input.encode_mp3_320;
  if (mp3 !== undefined) {
    if (typeof mp3 !== "boolean") {
      issues.push(`encode_mp3_320 must be a boolean, got ${String(mp3)}`);
    } else {
      resolved.encode_mp3_320 = mp3;
    }
  }
  // Cross-field fail-closed check: the loudnorm processing target must
  // never sit above the acceptance ceiling, or every limiter-engaged
  // master would be rejected after the fact.
  if (resolved.processing_true_peak_target_dbtp > resolved.true_peak_target_dbtp) {
    issues.push(
      `processing_true_peak_target_dbtp (${resolved.processing_true_peak_target_dbtp}) must be at or below the acceptance ceiling true_peak_target_dbtp (${resolved.true_peak_target_dbtp})`,
    );
  }
  if (issues.length > 0) throw new AiMusicMasteringPolicyError(issues);
  return resolved;
}

// ── Filter chain construction ──────────────────────────────────────

/**
 * Soft-knee multiband compand (ffmpeg `mcompand`): three bands split at
 * 120 Hz and 8 kHz, 3 dB soft-knee radius, gentle upward glue
 * (-30 dB in -> -27.5/-28 dB out) with unity gain at loud levels.
 * Band format: `<attack>,<decay> <knee> <in/out points> <crossover_hz>`.
 */
export const AI_MUSIC_MULTIBAND_COMPAND_ARGS = [
  "0.02,0.25 3 -60/-60,-30/-27.5,-10/-10 120",
  "0.01,0.2 3 -60/-60,-30/-28,-10/-10 8000",
  "0.002,0.1 3 -60/-60,-30/-28,-10/-10 22000",
].join("|");

/** Stage 1+2+3 tone filters (cleanup, presence/air, spatial/glue). */
export function buildAiMusicToneFilters(
  policy: ResolvedAiMusicMasteringPolicy,
): string[] {
  return [
    `highpass=f=${formatNumber(policy.highpass_hz)}:p=2`,
    `equalizer=f=${formatNumber(policy.mud_cut_hz)}:t=q:w=${formatNumber(policy.mud_cut_q)}:g=${formatNumber(policy.mud_cut_gain_db)}`,
    `equalizer=f=${formatNumber(policy.low_tight_hz)}:t=q:w=${formatNumber(policy.low_tight_q)}:g=${formatNumber(policy.low_tight_gain_db)}`,
    `equalizer=f=${formatNumber(policy.presence_hz)}:t=q:w=${formatNumber(policy.presence_q)}:g=${formatNumber(policy.presence_gain_db)}`,
    `equalizer=f=${formatNumber(policy.air_hz)}:t=q:w=${formatNumber(policy.air_q)}:g=${formatNumber(policy.air_gain_db)}`,
    `extrastereo=m=${formatNumber(policy.stereo_width)}:c=false`,
    `mcompand='${AI_MUSIC_MULTIBAND_COMPAND_ARGS}'`,
  ];
}

/** Tone chain only — for the `source_premaster` route and pass-2 reuse. */
export function buildAiMusicToneFilterChain(
  policy: ResolvedAiMusicMasteringPolicy,
): string {
  return buildAiMusicToneFilters(policy).join(",");
}

/**
 * Loudnorm argument block. Uses the *processing* true-peak target: the
 * limiter must leave headroom below the -1.0 dBTP acceptance ceiling so
 * hot material (limiter overshoot plus MP3 inter-sample-peak overshoot)
 * still verifies inside the band. Acceptance is checked separately
 * against `true_peak_target_dbtp` in `buildVerification`.
 */
function loudnormBase(policy: ResolvedAiMusicMasteringPolicy, measurement: boolean): string {
  return [
    `loudnorm=I=${formatNumber(policy.loudness_target_lufs)}`,
    `LRA=${formatNumber(policy.lra_target)}`,
    `TP=${formatNumber(policy.processing_true_peak_target_dbtp)}`,
    ...(measurement ? ["print_format=json"] : []),
  ].join(":");
}

/** Pass 1 filter: full tone chain + loudnorm measurement. */
export function buildAiMusicMeasurementFilter(
  policy: ResolvedAiMusicMasteringPolicy,
): string {
  return [
    buildAiMusicToneFilterChain(policy),
    loudnormBase(policy, true),
  ].join(",");
}

/** Pass 2 filter: full tone chain + loudnorm apply (linear mode). */
export function buildAiMusicApplyFilter(
  policy: ResolvedAiMusicMasteringPolicy,
  measurement: LoudnormMeasurement,
): string {
  return [
    buildAiMusicToneFilterChain(policy),
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

export function buildAiMusicMasteringPass1Args(
  inputPath: string,
  policy: ResolvedAiMusicMasteringPolicy,
): string[] {
  return [
    "-i", inputPath,
    "-af", buildAiMusicMeasurementFilter(policy),
    "-f", "null",
    "-",
  ];
}

export function buildAiMusicMasteringPass2Args(
  inputPath: string,
  outputPath: string,
  measurement: LoudnormMeasurement,
  policy: ResolvedAiMusicMasteringPolicy,
): string[] {
  return [
    "-y",
    "-i", inputPath,
    "-af", buildAiMusicApplyFilter(policy, measurement),
    "-ar", String(MASTERING_SAMPLE_RATE_HZ),
    "-c:a", "pcm_s24le",
    outputPath,
  ];
}

// ── Capability detection ───────────────────────────────────────────

export interface AiMusicMasteringCapability {
  available: boolean;
  ffmpeg: "available" | "unavailable";
  ffprobe: "available" | "unavailable";
  filters: Record<"mcompand" | "extrastereo" | "loudnorm" | "equalizer" | "highpass", "available" | "unavailable">;
  encoders: Record<"pcm_s24le" | "libmp3lame", "available" | "unavailable">;
  missing: string[];
  error?: { tool: "ffmpeg" | "ffprobe"; code?: string; message: string };
}

/**
 * Pure listing parser for `ffmpeg -filters` / `ffmpeg -encoders` output.
 *
 * Column layout varies across ffmpeg 4 through 8 (flag column width,
 * presence of the channel-layout/codec column), so detection only relies
 * on what is stable in every version: each listing row starts with a
 * flag token, then whitespace, then the exact name, then more columns.
 * Word-boundary anchoring prevents prefix confusion (e.g. `anequalizer`
 * must not satisfy `equalizer`, `pcm_s24le_planar` must not satisfy
 * `pcm_s24le`).
 */
export function parseToolListingAvailability(
  filtersListing: string,
  encodersListing: string,
): {
  filters: Record<"mcompand" | "extrastereo" | "loudnorm" | "equalizer" | "highpass", "available" | "unavailable">;
  encoders: Record<"pcm_s24le" | "libmp3lame", "available" | "unavailable">;
} {
  const filterNames = ["mcompand", "extrastereo", "loudnorm", "equalizer", "highpass"] as const;
  const encoderNames = ["pcm_s24le", "libmp3lame"] as const;
  const matchRow = (listing: string, name: string): boolean =>
    new RegExp(`^\\s*\\S+\\s+${name}\\s`, "m").test(listing);
  const filters = Object.fromEntries(
    filterNames.map((name) => [name, matchRow(filtersListing, name) ? "available" : "unavailable"]),
  ) as Record<(typeof filterNames)[number], "available" | "unavailable">;
  const encoders = Object.fromEntries(
    encoderNames.map((name) => [name, matchRow(encodersListing, name) ? "available" : "unavailable"]),
  ) as Record<(typeof encoderNames)[number], "available" | "unavailable">;
  return { filters, encoders };
}

/** Probe the local toolchain for everything the chain requires. */
export async function detectAiMusicMasteringCapability(
  options: { env?: NodeJS.ProcessEnv } = {},
): Promise<AiMusicMasteringCapability> {
  const capability: AiMusicMasteringCapability = {
    available: false,
    ffmpeg: "unavailable",
    ffprobe: "unavailable",
    filters: {
      mcompand: "unavailable",
      extrastereo: "unavailable",
      loudnorm: "unavailable",
      equalizer: "unavailable",
      highpass: "unavailable",
    },
    encoders: {
      pcm_s24le: "unavailable",
      libmp3lame: "unavailable",
    },
    missing: [],
  };
  let listing: { filters: string; encoders: string };
  try {
    listing = {
      filters: await execText("ffmpeg", ["-hide_banner", "-filters"], options.env),
      encoders: await execText("ffmpeg", ["-hide_banner", "-encoders"], options.env),
    };
    capability.ffmpeg = "available";
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    capability.error = {
      tool: "ffmpeg",
      code,
      message: error instanceof Error ? error.message : String(error),
    };
    capability.missing.push("ffmpeg");
    if (code !== "ENOENT") capability.missing.push("ffprobe");
    return finalizeCapability(capability);
  }
  try {
    await execText("ffprobe", ["-hide_banner", "-version"], options.env);
    capability.ffprobe = "available";
  } catch {
    capability.missing.push("ffprobe");
  }
  const parsed = parseToolListingAvailability(listing.filters, listing.encoders);
  capability.filters = parsed.filters;
  capability.encoders = parsed.encoders;
  for (const [name, status] of Object.entries(capability.filters)) {
    if (status === "unavailable") capability.missing.push(`ffmpeg filter ${name}`);
  }
  for (const [name, status] of Object.entries(capability.encoders)) {
    if (status === "unavailable") capability.missing.push(`ffmpeg encoder ${name}`);
  }
  return finalizeCapability(capability);
}

function finalizeCapability(capability: AiMusicMasteringCapability): AiMusicMasteringCapability {
  capability.available = capability.missing.length === 0;
  return capability;
}

export class AiMusicMasteringCapabilityError extends Error {
  readonly capability: AiMusicMasteringCapability;

  constructor(capability: AiMusicMasteringCapability) {
    super(
      `AI music mastering is unavailable on this machine (explicit capability): missing ${capability.missing.join(", ")}`,
    );
    this.name = "AiMusicMasteringCapabilityError";
    this.capability = capability;
  }
}

// ── Receipt ────────────────────────────────────────────────────────

export type AiMusicMasteringReceiptState =
  | "mastered"
  | "tone_conditioned"
  | "verification_failed";

export interface AiMusicAudioEvidence {
  path: string;
  sha256: string;
  duration_ms: number | null;
  channel_count: number | null;
  sample_rate_hz: number | null;
  codec_name: string | null;
  bit_depth: number | null;
  bit_rate_bps: number | null;
}

export interface AiMusicMasteringVerification {
  method: "ffmpeg_loudnorm_pass1_on_output";
  integrated_lufs_target: number;
  integrated_lufs_tolerance: number;
  true_peak_limit_dbtp: number;
  integrated_lufs: number;
  true_peak_dbtp: number;
  integrated_lufs_within_target: boolean;
  true_peak_within_limit: boolean;
  status: "passed" | "failed" | "not_applicable";
  notes: string[];
}

/** Objective clipped-sample evidence for a decoded deliverable (astats). */
export interface AiMusicClippingEvidence {
  status: "no_clipping" | "full_scale_samples_present" | "unavailable";
  peak_sample_db: number | null;
  basis: string;
  method: "ffmpeg_astats_peak_level";
}

/**
 * Pre-limiter headroom evidence: the true peak the tone chain handed to
 * loudnorm. Values above full scale prove the chain carried overrange in
 * the float domain instead of hard-clipping (extrastereo runs with
 * c=false) and that the true-peak limiter brought the deliverable back
 * inside the acceptance limit.
 */
export interface AiMusicPremasterHeadroom {
  pre_limiter_true_peak_dbtp: number;
  full_scale_exceeded_pre_limiter: boolean;
  note: string;
}

export interface AiMusicMasteringReceipt {
  version: "ai-music-mastering-receipt/v1";
  state: AiMusicMasteringReceiptState;
  route: AiMusicMasteringRoute;
  policy: ResolvedAiMusicMasteringPolicy;
  filter_chain: string;
  measurement_filter_chain: string | null;
  apply_filter_chain: string | null;
  tool_availability: AiMusicMasteringCapability;
  input_audio: AiMusicAudioEvidence;
  output_audio: AiMusicAudioEvidence | null;
  mp3_output_audio: AiMusicAudioEvidence | null;
  premaster_raw_measurement: LoudnormMeasurement | null;
  output_raw_measurement: LoudnormMeasurement | null;
  mp3_raw_measurement: LoudnormMeasurement | null;
  output_measurement: {
    integrated_lufs: number;
    true_peak_dbtp: number;
    lra_lu: number | null;
  } | null;
  mp3_measurement: {
    integrated_lufs: number;
    true_peak_dbtp: number;
    lra_lu: number | null;
  } | null;
  premaster_headroom: AiMusicPremasterHeadroom | null;
  output_clipping: AiMusicClippingEvidence | null;
  mp3_output_clipping: AiMusicClippingEvidence | null;
  verification: AiMusicMasteringVerification | null;
  mp3_verification: AiMusicMasteringVerification | null;
  shared_mastering: {
    single_final_mastering_owner: "shared_audio_render_plan";
    note: string;
  };
  human_audition: {
    required: true;
    status: "pending";
    method: "human_audition";
    note: string;
  };
  warnings: string[];
}

export interface MasterAiMusicInput {
  inputPath: string;
  outputDir: string;
  policy?: ResolvedAiMusicMasteringPolicy;
  createdAt?: string;
  receiptPath?: string;
  ffmpegBin?: string;
  /** Injected ffprobe binary (defaults to `ffprobe` on PATH). */
  ffprobeBin?: string;
  capability?: AiMusicMasteringCapability;
}

export class AiMusicMasteringVerificationError extends Error {
  readonly receipt: AiMusicMasteringReceipt;

  constructor(message: string, receipt: AiMusicMasteringReceipt) {
    super(message);
    this.name = "AiMusicMasteringVerificationError";
    this.receipt = receipt;
  }
}

const RECEIPT_SCHEMA = "ai-music-mastering-receipt.schema.json";

/**
 * The dedicated Issue #38 acceptance contract is immutable at run time.
 * The receipt schema binds the mastered branch to the shipped policy
 * values, so an in-range override such as loudness_target_lufs=-14 would
 * survive policy resolution and real ffmpeg processing and only then die
 * at receipt persistence — wasting the run and orphaning a canonical
 * deliverable. Instead, the override is rejected fail-fast here, before
 * any input is read, directory created, or ffmpeg executed: zero output.
 * Tone-chain (EQ) overrides stay allowed on the premaster route and as
 * non-contract fields, since the schema does not pin them.
 */
const ISSUE38_CONTRACT_POLICY_FIELDS = [
  "loudness_target_lufs",
  "loudness_tolerance_lufs",
  "true_peak_target_dbtp",
  "processing_true_peak_target_dbtp",
  "lra_target",
] as const;

export function assertAiMusicIssue38ShippedContractPolicy(
  policy: ResolvedAiMusicMasteringPolicy,
): void {
  if (policy.route !== "standalone_sns_master") return;
  const overridden = ISSUE38_CONTRACT_POLICY_FIELDS.filter(
    (field) => policy[field] !== DEFAULT_AI_MUSIC_MASTERING[field],
  );
  if (overridden.length > 0) {
    throw new AiMusicMasteringPolicyError(
      overridden.map(
        (field) =>
          `the dedicated Issue #38 standalone_sns_master contract masters only with the shipped policy: ${field}=${policy[field]} overrides the shipped ${DEFAULT_AI_MUSIC_MASTERING[field]}; the acceptance band and the receipt schema are bound to the shipped values, so the run is rejected before any processing`,
      ),
    );
  }
}

/** Run the full AI-music mastering route (executes ffmpeg). */
export async function masterAiMusic(input: MasterAiMusicInput): Promise<AiMusicMasteringReceipt> {
  const policy = input.policy ?? resolveAiMusicMasteringPolicy();
  // Fail-fast on contract overrides before any filesystem or ffmpeg work.
  assertAiMusicIssue38ShippedContractPolicy(policy);
  const inputPath = path.resolve(input.inputPath);
  if (!fs.existsSync(inputPath)) {
    throw new Error(`AI music mastering input is missing: ${inputPath}`);
  }
  const outputDir = path.resolve(input.outputDir);
  fs.mkdirSync(outputDir, { recursive: true });

  const capability = input.capability ?? await detectAiMusicMasteringCapability();
  if (!capability.available) {
    throw new AiMusicMasteringCapabilityError(capability);
  }
  const ffmpegBin = input.ffmpegBin ?? "ffmpeg";
  const ffprobeBin = input.ffprobeBin ?? "ffprobe";

  const inputEvidence = await probeAudioEvidence(inputPath, ffprobeBin);
  const warnings: string[] = [];
  const baseName = path.basename(inputPath).replace(/\.[^.]+$/, "");
  const receiptPath = path.resolve(
    input.receiptPath ?? path.join(outputDir, "ai-music-mastering-receipt.json"),
  );

  if (policy.route === "source_premaster") {
    const premasterPath = path.join(outputDir, `${baseName}-ai-premaster.wav`);
    await runFfmpeg(ffmpegBin, [
      "-y",
      "-i", inputPath,
      "-af", buildAiMusicToneFilterChain(policy),
      "-ar", String(MASTERING_SAMPLE_RATE_HZ),
      "-c:a", "pcm_s24le",
      premasterPath,
    ]);
    const outputEvidence = await probeAudioEvidence(premasterPath, ffprobeBin);
    const receipt: AiMusicMasteringReceipt = {
      version: "ai-music-mastering-receipt/v1",
      state: "tone_conditioned",
      route: policy.route,
      policy,
      filter_chain: buildAiMusicToneFilterChain(policy),
      measurement_filter_chain: null,
      apply_filter_chain: null,
      tool_availability: capability,
      input_audio: inputEvidence,
      output_audio: outputEvidence,
      mp3_output_audio: null,
      premaster_raw_measurement: null,
      output_raw_measurement: null,
      mp3_raw_measurement: null,
      output_measurement: null,
      mp3_measurement: null,
      premaster_headroom: null,
      output_clipping: null,
      mp3_output_clipping: null,
      verification: null,
      mp3_verification: null,
      shared_mastering: {
        single_final_mastering_owner: "shared_audio_render_plan",
        note: "tone conditioning only; loudness normalization stays owned by the single shared post-mix mastering pass (after_mix)",
      },
      human_audition: {
        required: true,
        status: "pending",
        method: "human_audition",
        note: "tone chain effect on vocals must be auditioned by a human; no automated claim",
      },
      warnings,
    };
    try {
      return persistReceipt(receipt, receiptPath);
    } catch (persistError) {
      keepNoDeliverableOnPersistenceFailure(outputEvidence.path, outputDir, receipt);
      throw persistError;
    }
  }

  // ── standalone_sns_master: tone chain + 2-pass loudnorm ──
  const outputPath = path.join(outputDir, `${baseName}-ai-mastered.wav`);
  const pass1 = await runFfmpeg(
    ffmpegBin,
    buildAiMusicMasteringPass1Args(inputPath, policy),
    true,
  );
  const premasterMeasurement = parseLoudnormOutput(pass1.stderr);
  assertFiniteMeasurement(premasterMeasurement, inputPath);
  if (Number(premasterMeasurement.input_tp) > -0.01) {
    warnings.push(
      `hot source: pre-limiter true peak ${premasterMeasurement.input_tp} dBTP exceeds full scale; the loudnorm true-peak limiter engaged at processing target ${policy.processing_true_peak_target_dbtp} dBTP (acceptance ceiling ${policy.true_peak_target_dbtp} dBTP)`,
    );
  }
  const pass2 = await runFfmpeg(
    ffmpegBin,
    buildAiMusicMasteringPass2Args(inputPath, outputPath, premasterMeasurement, policy),
  );
  if (!fs.existsSync(outputPath)) {
    throw new Error(`AI music mastering did not produce output: ${outputPath}`);
  }
  const outputMeasure = await measureOutput(ffmpegBin, outputPath, policy);
  const outputEvidence = await probeAudioEvidence(outputPath, ffprobeBin);
  const outputClipping = await measureClippingEvidence(ffmpegBin, outputPath);
  const verification = buildVerification(
    { integrated_lufs: outputMeasure.integratedLufs, true_peak_dbtp: outputMeasure.truePeakDbtp },
    policy,
    outputClipping.status,
    "mastered WAV output carries full-scale samples",
  );
  const mp3EvidencePass = policy.encode_mp3_320
    ? await encodeAndMeasureMp3(ffmpegBin, ffprobeBin, outputDir, baseName, outputPath, policy)
    : null;

  // Issue #38 receipt state: failed when the WAV OR the MP3 verification
  // fails; schema enforces both directions.
  const wavFailed = verification.status !== "passed";
  const mp3Failed = mp3EvidencePass !== null
    && mp3EvidencePass.verification.status !== "passed";
  const state: AiMusicMasteringReceiptState = wavFailed || mp3Failed
    ? "verification_failed"
    : "mastered";

  if (outputClipping.status === "unavailable") {
    warnings.push("WAV clipping evidence unavailable (astats peak level not measurable); verification fails closed");
  }
  if (mp3EvidencePass?.clipping.status === "unavailable") {
    warnings.push("MP3 clipping evidence unavailable (astats peak level not measurable); verification fails closed");
  }

  // Rejected outputs: a deliverable that failed acceptance must never stay
  // under its canonical name where downstream consumers could pick it up.
  // Rename to *.rejected so the measured bytes remain as receipt evidence
  // while the canonical deliverable path is freed.
  const rejectedPaths: string[] = [];
  if (state === "verification_failed") {
    const deliverables = [
      outputEvidence,
      ...(mp3EvidencePass ? [mp3EvidencePass.evidence] : []),
    ];
    for (const evidence of deliverables) {
      const rejectedPath = `${evidence.path}.rejected`;
      fs.renameSync(evidence.path, rejectedPath);
      evidence.path = rejectedPath;
      rejectedPaths.push(rejectedPath);
    }
    warnings.push(
      `acceptance failed: rejected deliverable(s) kept as evidence at ${rejectedPaths.join(", ")}`,
    );
  }

  const receipt: AiMusicMasteringReceipt = {
    version: "ai-music-mastering-receipt/v1",
    state,
    route: policy.route,
    policy,
    filter_chain: buildAiMusicToneFilterChain(policy),
    measurement_filter_chain: buildAiMusicMeasurementFilter(policy),
    apply_filter_chain: buildAiMusicApplyFilter(policy, premasterMeasurement),
    tool_availability: capability,
    input_audio: inputEvidence,
    output_audio: outputEvidence,
    mp3_output_audio: mp3EvidencePass?.evidence ?? null,
    premaster_raw_measurement: premasterMeasurement,
    output_raw_measurement: outputMeasure.raw,
    mp3_raw_measurement: mp3EvidencePass?.raw ?? null,
    output_measurement: {
      integrated_lufs: outputMeasure.integratedLufs,
      true_peak_dbtp: outputMeasure.truePeakDbtp,
      lra_lu: outputMeasure.lraLu,
    },
    mp3_measurement: mp3EvidencePass?.measurement ?? null,
    premaster_headroom: {
      pre_limiter_true_peak_dbtp: Number(premasterMeasurement.input_tp),
      full_scale_exceeded_pre_limiter: Number(premasterMeasurement.input_tp) > -0.01,
      note: "true peak handed to loudnorm; values above full scale are carried in the float domain (extrastereo c=false removes the pre-loudnorm hard clipper) and limited by loudnorm to the processing true-peak target, which sits below the acceptance ceiling to absorb limiter and MP3 inter-sample-peak overshoot",
    },
    output_clipping: outputClipping,
    mp3_output_clipping: mp3EvidencePass?.clipping ?? null,
    verification,
    mp3_verification: mp3EvidencePass?.verification ?? null,
    shared_mastering: {
      single_final_mastering_owner: "shared_audio_render_plan",
      note: "standalone AI-music finishing route (one loudnorm stage inside this chain); do not feed the mastered output back as a premaster for the shared route",
    },
    human_audition: {
      required: true,
      status: "pending",
      method: "human_audition",
      note: "Issue #38 vocal clarity on phone speakers must be auditioned by a human; measurement proxies do not claim intelligibility",
    },
    warnings,
  };

  try {
    persistReceipt(receipt, receiptPath);
  } catch (persistError) {
    // Persistence failed after real processing: keep no deliverable under
    // its canonical name (best effort — the verification_failed state has
    // already renamed its deliverables before this point), and keep the
    // receipt bytes for debugging when the filesystem allows it.
    keepNoDeliverableOnPersistenceFailure(
      outputEvidence.path,
      outputDir,
      receipt,
      mp3EvidencePass ? mp3EvidencePass.evidence.path : undefined,
    );
    throw persistError;
  }
  if (state !== "mastered") {
    const failures: string[] = [];
    if (verification.status === "failed") {
      const reason = verification.notes.length > 0 ? `; ${verification.notes.join("; ")}` : "";
      failures.push(
        `WAV integrated ${receipt.output_measurement?.integrated_lufs} LUFS (target ${policy.loudness_target_lufs} ± ${policy.loudness_tolerance_lufs}), true peak ${receipt.output_measurement?.true_peak_dbtp} dBTP (acceptance limit ${policy.true_peak_target_dbtp})${reason}`,
      );
    }
    if (mp3EvidencePass?.verification.status === "failed") {
      const reason = mp3EvidencePass.verification.notes.length > 0
        ? `; ${mp3EvidencePass.verification.notes.join("; ")}`
        : "";
      failures.push(
        `MP3 integrated ${mp3EvidencePass.measurement.integrated_lufs} LUFS (target ${policy.loudness_target_lufs} ± ${policy.loudness_tolerance_lufs}), true peak ${mp3EvidencePass.measurement.true_peak_dbtp} dBTP (acceptance limit ${policy.true_peak_target_dbtp})${reason}`,
      );
    }
    throw new AiMusicMasteringVerificationError(
      `AI music mastering failed the Issue #38 acceptance band: ${failures.join("; ")}`,
      receipt,
    );
  }
  return receipt;
}

export function buildVerification(
  measurement: { integrated_lufs: number; true_peak_dbtp: number },
  policy: ResolvedAiMusicMasteringPolicy,
  clippingStatus?: AiMusicClippingEvidence["status"],
  clippingFailureNote?: string,
): AiMusicMasteringVerification {
  const lufsOk = Math.abs(measurement.integrated_lufs - policy.loudness_target_lufs)
    <= policy.loudness_tolerance_lufs;
  const tpOk = measurement.true_peak_dbtp <= policy.true_peak_target_dbtp;
  // Fail closed (M-a): clipping evidence must positively prove
  // "no_clipping". A missing or unavailable astats reading is a
  // verification failure, never a pass.
  const clippingOk = clippingStatus === "no_clipping";
  const notes: string[] = [];
  if (clippingStatus === "full_scale_samples_present" && clippingFailureNote) {
    notes.push(clippingFailureNote);
  }
  if (clippingStatus !== "no_clipping" && clippingStatus !== "full_scale_samples_present") {
    notes.push(
      "clipping evidence unavailable (astats peak level not measurable); verification fails closed",
    );
  }
  return {
    method: "ffmpeg_loudnorm_pass1_on_output",
    integrated_lufs_target: policy.loudness_target_lufs,
    integrated_lufs_tolerance: policy.loudness_tolerance_lufs,
    true_peak_limit_dbtp: policy.true_peak_target_dbtp,
    integrated_lufs: measurement.integrated_lufs,
    true_peak_dbtp: measurement.true_peak_dbtp,
    integrated_lufs_within_target: lufsOk,
    true_peak_within_limit: tpOk,
    status: lufsOk && tpOk && clippingOk ? "passed" : "failed",
    notes,
  };
}

interface Mp3Pass {
  evidence: AiMusicAudioEvidence;
  raw: LoudnormMeasurement;
  measurement: { integrated_lufs: number; true_peak_dbtp: number; lra_lu: number | null };
  verification: AiMusicMasteringVerification;
  clipping: AiMusicClippingEvidence;
}

async function encodeAndMeasureMp3(
  ffmpegBin: string,
  ffprobeBin: string,
  outputDir: string,
  baseName: string,
  masteredWavPath: string,
  policy: ResolvedAiMusicMasteringPolicy,
): Promise<Mp3Pass> {
  const mp3Path = path.join(outputDir, `${baseName}-ai-mastered-320k.mp3`);
  await runFfmpeg(ffmpegBin, [
    "-y",
    "-i", masteredWavPath,
    "-c:a", "libmp3lame",
    "-b:a", "320k",
    mp3Path,
  ]);
  const measure = await measureOutput(ffmpegBin, mp3Path, policy);
  const measurement = {
    integrated_lufs: measure.integratedLufs,
    true_peak_dbtp: measure.truePeakDbtp,
    lra_lu: measure.lraLu,
  };
  const clipping = await measureClippingEvidence(ffmpegBin, mp3Path);
  const verification = buildVerification(
    measurement,
    policy,
    clipping.status,
    "320 kbps MP3 delivery carries full-scale samples",
  );
  return {
    evidence: await probeAudioEvidence(mp3Path, ffprobeBin),
    raw: measure.raw,
    measurement,
    verification,
    clipping,
  };
}

/**
 * Objective clipped-sample evidence via ffmpeg astats on the decoded
 * deliverable: a peak sample at or below -0.01 dBFS proves no
 * full-scale (clipped) samples. Anything that cannot be measured
 * positively (missing Overall section, non-finite peak such as digital
 * silence) is reported as "unavailable" and fails verification closed —
 * absence of clipping evidence is never treated as absence of clipping.
 */
export async function measureClippingEvidence(
  ffmpegBin: string,
  filePath: string,
): Promise<AiMusicClippingEvidence> {
  const basis =
    "astats Peak level dB on the decoded deliverable; peak <= -0.01 dBFS proves no full-scale samples; unavailable evidence fails verification closed";
  const result = await runFfmpeg(ffmpegBin, [
    "-i", filePath,
    "-af", "astats",
    "-f", "null",
    "-",
  ]);
  // The Overall section is printed after the per-channel sections.
  const overallMatch = /Overall[\s\S]*?Peak level dB:\s*(-?[^\s]+)/.exec(result.stderr);
  if (!overallMatch) {
    return { status: "unavailable", peak_sample_db: null, basis, method: "ffmpeg_astats_peak_level" };
  }
  const peak = Number(overallMatch[1]);
  if (!Number.isFinite(peak)) {
    // Digital silence reports -inf; still not a positive no-clipping
    // measurement, so it fails closed like any other unavailable reading.
    return { status: "unavailable", peak_sample_db: null, basis, method: "ffmpeg_astats_peak_level" };
  }
  return {
    status: peak <= -0.01 ? "no_clipping" : "full_scale_samples_present",
    peak_sample_db: peak,
    basis,
    method: "ffmpeg_astats_peak_level",
  };
}

async function measureOutput(
  ffmpegBin: string,
  filePath: string,
  policy: ResolvedAiMusicMasteringPolicy,
): Promise<{ raw: LoudnormMeasurement; integratedLufs: number; truePeakDbtp: number; lraLu: number | null }> {
  const result = await runFfmpeg(ffmpegBin, [
    "-i", filePath,
    "-af", `loudnorm=I=${formatNumber(policy.loudness_target_lufs)}:LRA=${formatNumber(policy.lra_target)}:TP=${formatNumber(policy.true_peak_target_dbtp)}:print_format=json`,
    "-f", "null",
    "-",
  ], true);
  const raw = parseLoudnormOutput(result.stderr);
  const integratedLufs = Number(raw.input_i);
  const truePeakDbtp = Number(raw.input_tp);
  // Fail closed on degenerate inputs (e.g. digital silence reports
  // "-inf"): never serialize non-finite numbers into a receipt.
  if (!Number.isFinite(integratedLufs) || !Number.isFinite(truePeakDbtp)) {
    throw new Error(
      `non-finite loudness measurement for ${filePath} (integrated="${raw.input_i}", true peak="${raw.input_tp}"): input may be silent, digital zero, or corrupted; refusing to master or fabricate numbers`,
    );
  }
  return {
    raw,
    integratedLufs,
    truePeakDbtp,
    lraLu: finiteOrNull(raw.input_lra),
  };
}

async function probeAudioEvidence(
  filePath: string,
  ffprobeBin = "ffprobe",
): Promise<AiMusicAudioEvidence> {
  const ffprobeJson = await execText(ffprobeBin, [
    "-v", "error",
    "-select_streams", "a:0",
    "-show_entries",
    "stream=codec_name,sample_rate,channels,bits_per_raw_sample,bits_per_sample,bit_rate,duration",
    "-show_entries", "format=duration",
    "-of", "json", filePath,
  ]);
  const parsed = JSON.parse(ffprobeJson) as {
    streams?: Array<{
      codec_name?: string;
      sample_rate?: string;
      channels?: number;
      bits_per_raw_sample?: string;
      bits_per_sample?: string;
      bit_rate?: string;
      duration?: string;
    }>;
    format?: { duration?: string };
  };
  const stream = parsed.streams?.[0] ?? {};
  const durationSec = Number(stream.duration ?? parsed.format?.duration ?? "nan");
  return {
    path: filePath,
    sha256: computeSha256(filePath),
    duration_ms: Number.isFinite(durationSec) ? Math.round(durationSec * 1000) : null,
    channel_count: stream.channels ?? null,
    sample_rate_hz: stream.sample_rate ? Number(stream.sample_rate) : null,
    codec_name: stream.codec_name ?? null,
    bit_depth: Number(stream.bits_per_raw_sample ?? stream.bits_per_sample ?? "nan") || null,
    bit_rate_bps: stream.bit_rate ? Number(stream.bit_rate) : null,
  };
}

function persistReceipt(
  receipt: AiMusicMasteringReceipt,
  receiptPath: string,
): AiMusicMasteringReceipt {
  // Serialize first, then validate the serialized bytes: JSON.stringify
  // silently coerces Infinity/NaN to null and drops undefined fields, so
  // only the round-tripped document proves what will actually be read.
  const serialized = `${JSON.stringify(receipt, null, 2)}\n`;
  const roundTripped: unknown = JSON.parse(serialized);
  const validation = validateAiMusicMasteringReceipt(roundTripped);
  if (!validation.valid) {
    throw new Error(
      `AI music mastering receipt failed schema/integrity validation: ${validation.errors.join("; ")}`,
    );
  }
  // A custom receipt path may point into a directory that does not exist
  // yet (e.g. a nested audit trail); create it before writing.
  fs.mkdirSync(path.dirname(receiptPath), { recursive: true });
  fs.writeFileSync(receiptPath, serialized, "utf8");
  return receipt;
}

/**
 * Best-effort cleanup when receipt persistence fails after real
 * processing: deliverables still under their canonical name are rejected
 * to `<path>.rejected`, and the receipt bytes are kept as
 * `ai-music-mastering-receipt.invalid.json` in the output directory for
 * debugging. Every step tolerates filesystem errors; the original
 * persistence error is what the caller rethrows.
 */
function keepNoDeliverableOnPersistenceFailure(
  wavPath: string,
  outputDir: string,
  receipt: AiMusicMasteringReceipt,
  mp3Path?: string,
): void {
  const canonicalPaths = [wavPath, ...(mp3Path ? [mp3Path] : [])];
  for (const evidencePath of canonicalPaths) {
    if (evidencePath.endsWith(".rejected")) continue;
    try {
      fs.renameSync(evidencePath, `${evidencePath}.rejected`);
      if (receipt.output_audio?.path === evidencePath) {
        receipt.output_audio.path = `${evidencePath}.rejected`;
      }
      if (receipt.mp3_output_audio?.path === evidencePath) {
        receipt.mp3_output_audio.path = `${evidencePath}.rejected`;
      }
    } catch {
      // best effort; the persistence error is rethrown by the caller
    }
  }
  try {
    fs.writeFileSync(
      path.join(outputDir, "ai-music-mastering-receipt.invalid.json"),
      `${JSON.stringify(receipt, null, 2)}\n`,
      "utf8",
    );
  } catch {
    // best effort
  }
}

// ── Receipt integrity (semantic validation) ────────────────────────

export interface AiMusicReceiptValidationResult {
  valid: boolean;
  errors: string[];
}

function isReceiptRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finiteReceiptNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Semantic receipt-integrity validation: recomputes every derived
 * verification boolean and status from the receipt's own policy and
 * measurement values, cross-checks the verification block against the
 * measured deliverable, and enforces the state/status coupling. Each
 * recorded clipping status (output_clipping and mp3_output_clipping) is
 * recomputed from its own peak_sample_db with the exact production
 * astats semantics: peak <= -0.01 dBFS proves no full-scale samples, a
 * hotter peak is full-scale evidence, and a missing or non-finite peak
 * is unavailable (fail-closed).
 *
 * A receipt whose measurements were tampered to -30 LUFS or +4 dBTP
 * cannot pass, whether the booleans were left stale, forged back to
 * "passed", or re-derived as failures while the state still claims
 * "mastered". This is belt-and-suspenders on top of the schema: schema
 * validation pins shapes and the mastered-branch acceptance band, this
 * pins internal consistency.
 *
 * Defensive by design: malformed documents produce errors, not throws
 * (shape rejection stays the schema's job).
 */
export function validateAiMusicMasteringReceiptIntegrity(
  document: unknown,
): AiMusicReceiptValidationResult {
  const errors: string[] = [];
  if (!isReceiptRecord(document)) {
    return { valid: false, errors: ["receipt is not an object"] };
  }
  const receipt = document;
  const policy = isReceiptRecord(receipt.policy) ? receipt.policy : null;
  const state = receipt.state;

  const checkVerificationBlock = (
    label: "WAV" | "MP3",
    verification: unknown,
    measurement: unknown,
    clipping: unknown,
  ): void => {
    if (verification === null || verification === undefined) return;
    if (!isReceiptRecord(verification)) {
      errors.push(`${label}: verification present but not an object`);
      return;
    }
    if (!policy) {
      errors.push(`${label}: verification present without a policy object`);
      return;
    }
    const target = finiteReceiptNumber(policy.loudness_target_lufs);
    const tolerance = finiteReceiptNumber(policy.loudness_tolerance_lufs);
    const ceiling = finiteReceiptNumber(policy.true_peak_target_dbtp);
    if (target === null || tolerance === null || ceiling === null) {
      errors.push(
        `${label}: policy numeric fields missing or non-finite; cannot recompute booleans`,
      );
      return;
    }
    if (verification.integrated_lufs_target !== target) {
      errors.push(
        `${label}: verification.integrated_lufs_target (${String(verification.integrated_lufs_target)}) does not match policy loudness_target_lufs (${target})`,
      );
    }
    if (verification.integrated_lufs_tolerance !== tolerance) {
      errors.push(
        `${label}: verification.integrated_lufs_tolerance (${String(verification.integrated_lufs_tolerance)}) does not match policy loudness_tolerance_lufs (${tolerance})`,
      );
    }
    if (verification.true_peak_limit_dbtp !== ceiling) {
      errors.push(
        `${label}: verification.true_peak_limit_dbtp (${String(verification.true_peak_limit_dbtp)}) does not match policy true_peak_target_dbtp (${ceiling})`,
      );
    }
    // Booleans and status are recomputed from the measured deliverable —
    // the source of truth — not from the verification block's own copy.
    const evidence = isReceiptRecord(measurement) ? measurement : null;
    const evidenceIntegrated = evidence ? finiteReceiptNumber(evidence.integrated_lufs) : null;
    const evidenceTruePeak = evidence ? finiteReceiptNumber(evidence.true_peak_dbtp) : null;
    let basisIntegrated: number;
    let basisTruePeak: number;
    if (evidence && evidenceIntegrated !== null && evidenceTruePeak !== null) {
      if (verification.integrated_lufs !== evidence.integrated_lufs) {
        errors.push(
          `${label}: verification.integrated_lufs (${String(verification.integrated_lufs)}) does not match the measured deliverable (${String(evidence.integrated_lufs)})`,
        );
      }
      if (verification.true_peak_dbtp !== evidence.true_peak_dbtp) {
        errors.push(
          `${label}: verification.true_peak_dbtp (${String(verification.true_peak_dbtp)}) does not match the measured deliverable (${String(evidence.true_peak_dbtp)})`,
        );
      }
      basisIntegrated = evidenceIntegrated;
      basisTruePeak = evidenceTruePeak;
    } else {
      errors.push(
        `${label}: verification present without matching measurement evidence; recomputing from the verification block only`,
      );
      const verificationIntegrated = finiteReceiptNumber(verification.integrated_lufs);
      const verificationTruePeak = finiteReceiptNumber(verification.true_peak_dbtp);
      if (verificationIntegrated === null || verificationTruePeak === null) {
        errors.push(`${label}: verification numeric fields missing or non-finite`);
        return;
      }
      basisIntegrated = verificationIntegrated;
      basisTruePeak = verificationTruePeak;
    }
    const lufsOk = Math.abs(basisIntegrated - target) <= tolerance;
    const tpOk = basisTruePeak <= ceiling;
    // The recorded clipping status is recomputed from its own
    // peak_sample_db with the exact production semantics of
    // measureClippingEvidence, so a forged "no_clipping" over a hot or
    // full-scale peak is caught even when the verification block agrees
    // with it.
    const clippingRecord = isReceiptRecord(clipping) ? clipping : null;
    const clippingPeak = clippingRecord ? finiteReceiptNumber(clippingRecord.peak_sample_db) : null;
    const expectedClippingStatus = !clippingRecord || clippingPeak === null
      ? "unavailable"
      : clippingPeak <= -0.01
      ? "no_clipping"
      : "full_scale_samples_present";
    if (clippingRecord && clippingRecord.status !== expectedClippingStatus) {
      errors.push(
        `${label}: clipping status=${String(clippingRecord.status)} but recomputed ${expectedClippingStatus} from peak_sample_db ${String(clippingRecord.peak_sample_db)} dBFS (production astats semantics: peak <= -0.01 dBFS proves no full-scale samples; a hotter peak is full-scale evidence; a missing or non-finite peak is unavailable)`,
      );
    }
    const clippingOk = expectedClippingStatus === "no_clipping";
    const recomputedStatus = lufsOk && tpOk && clippingOk ? "passed" : "failed";
    if (verification.integrated_lufs_within_target !== lufsOk) {
      errors.push(
        `${label}: integrated_lufs_within_target=${String(verification.integrated_lufs_within_target)} but recomputed ${lufsOk} from measured integrated ${basisIntegrated} LUFS vs target ${target} ± ${tolerance}`,
      );
    }
    if (verification.true_peak_within_limit !== tpOk) {
      errors.push(
        `${label}: true_peak_within_limit=${String(verification.true_peak_within_limit)} but recomputed ${tpOk} from measured true peak ${basisTruePeak} dBTP vs acceptance ceiling ${ceiling} dBTP`,
      );
    }
    if (verification.status !== recomputedStatus) {
      errors.push(
        `${label}: verification.status=${String(verification.status)} but recomputed ${recomputedStatus} from policy and measurements`,
      );
    }
  };

  checkVerificationBlock("WAV", receipt.verification, receipt.output_measurement, receipt.output_clipping);
  checkVerificationBlock("MP3", receipt.mp3_verification, receipt.mp3_measurement, receipt.mp3_output_clipping);

  const statusOf = (value: unknown): unknown =>
    isReceiptRecord(value) ? value.status : undefined;
  if (state === "mastered") {
    if (statusOf(receipt.verification) !== "passed") {
      errors.push(
        `state=mastered requires the WAV verification status "passed", got ${String(statusOf(receipt.verification))}`,
      );
    }
    if (receipt.mp3_verification !== null && receipt.mp3_verification !== undefined
      && statusOf(receipt.mp3_verification) !== "passed") {
      errors.push(
        `state=mastered requires the MP3 verification status "passed", got ${String(statusOf(receipt.mp3_verification))}`,
      );
    }
  } else if (state === "verification_failed") {
    if (statusOf(receipt.verification) !== "failed" && statusOf(receipt.mp3_verification) !== "failed") {
      errors.push(
        "state=verification_failed requires the WAV or MP3 verification status \"failed\"",
      );
    }
  } else if (state === "tone_conditioned") {
    if (receipt.verification !== null || receipt.mp3_verification !== null) {
      errors.push("state=tone_conditioned must not carry verification evidence");
    }
  }

  const headroom = receipt.premaster_headroom;
  if (isReceiptRecord(headroom) && typeof headroom.full_scale_exceeded_pre_limiter === "boolean") {
    const preLimiterTruePeak = finiteReceiptNumber(headroom.pre_limiter_true_peak_dbtp);
    if (preLimiterTruePeak !== null) {
      const expected = preLimiterTruePeak > -0.01;
      if (headroom.full_scale_exceeded_pre_limiter !== expected) {
        errors.push(
          `premaster_headroom.full_scale_exceeded_pre_limiter=${String(headroom.full_scale_exceeded_pre_limiter)} but recomputed ${expected} from pre-limiter true peak ${preLimiterTruePeak} dBTP`,
        );
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Project-facing receipt validation entry point: JSON-schema validation
 * followed by semantic integrity recomputation. Used before every
 * receipt persistence, by receipt verification consumers, and by the
 * `--verify-receipt` CLI mode.
 */
export function validateAiMusicMasteringReceipt(
  document: unknown,
): AiMusicReceiptValidationResult {
  const schemaValidation = validateAgainstSchema(document, RECEIPT_SCHEMA);
  const errors = [...schemaValidation.errors];
  if (!schemaValidation.valid) {
    // Keep the integrity diagnostics when they can be produced safely;
    // shape-level rejection is already recorded by the schema result.
    try {
      errors.push(...validateAiMusicMasteringReceiptIntegrity(document).errors);
    } catch {
      // malformed shapes stay rejected via the schema errors above
    }
  } else {
    errors.push(...validateAiMusicMasteringReceiptIntegrity(document).errors);
  }
  return { valid: errors.length === 0, errors };
}

// ── ffmpeg plumbing ────────────────────────────────────────────────

function execText(
  command: string,
  args: string[],
  env?: NodeJS.ProcessEnv,
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      { maxBuffer: 50 * 1024 * 1024, ...(env ? { env } : {}) },
      (error, stdout, stderr) => {
        if (error) {
          reject(Object.assign(
            new Error(`${command} failed: ${stderr || error.message}`),
            { code: (error as NodeJS.ErrnoException).code },
          ));
          return;
        }
        resolve(stdout ?? "");
      },
    );
  });
}

function runFfmpeg(
  ffmpegBin: string,
  args: string[],
  allowMeasurementOnError = false,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      ffmpegBin,
      args,
      { maxBuffer: 50 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          if (allowMeasurementOnError && /"input_i"\s*:/.test(stderr ?? "")) {
            resolve({ stdout: stdout ?? "", stderr: stderr ?? "" });
            return;
          }
          reject(Object.assign(
            new Error(`AI music mastering ffmpeg failed: ${stderr || error.message}`),
            { code: (error as NodeJS.ErrnoException).code },
          ));
          return;
        }
        resolve({ stdout: stdout ?? "", stderr: stderr ?? "" });
      },
    );
  });
}

function finiteOrNull(value: string): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Every loudnorm field is replayed into pass-2 ffmpeg arguments, so a
 * non-finite value ("-inf"/"nan", e.g. from silent or corrupt input)
 * must fail closed before anything is produced or recorded.
 */
function assertFiniteMeasurement(
  measurement: LoudnormMeasurement,
  inputPath: string,
): void {
  const nonFinite = Object.entries(measurement)
    .filter(([, value]) => !Number.isFinite(Number(value)))
    .map(([field, value]) => `${field}="${value}"`);
  if (nonFinite.length > 0) {
    throw new Error(
      `non-finite loudness measurement for ${inputPath}: ${nonFinite.join(", ")}; input may be silent, digital zero, or corrupted; refusing to master or fabricate numbers`,
    );
  }
}

function formatNumber(value: number): string {
  return value.toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
}
