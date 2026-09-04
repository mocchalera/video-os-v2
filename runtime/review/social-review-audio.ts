import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { validateArtifact } from "../artifacts/loaders.js";
import {
  buildLoudnormPass1Args,
  parseLoudnormOutput,
  type LoudnormMeasurement,
  type MasteringDefaults,
} from "../audio/mastering.js";
import type { MusicMasterAudioPlan } from "../audio/render-plan.js";

const SHA256 = /^sha256:[a-f0-9]{64}$/;
const streamPresenceCache = new Map<string, boolean>();
const channelCountCache = new Map<string, number>();
const fingerprintCache = new Map<string, DecodedAudioFingerprint>();
const measurementCache = new Map<string, LoudnormMeasurement>();

export interface SocialReviewAudioPolicyBinding {
  values: MasteringDefaults;
  profile_sha256: string | null;
  sha256: string;
}

export interface SocialReviewAudioReceipt {
  version: "social-review-audio-mastering-receipt/v1";
  state: "mastered" | "not_applicable";
  reason: "shared_audio_render_plan_exactly_once" | "shared_audio_render_plan_preserve" | "review_video_has_no_audio_stream";
  generation_id: string;
  shared_audio_plan_sha256: string | null;
  audio_plan_sha256: string;
  mastering_count: 0 | 1;
  input_audio: { path: string; sha256: string } | null;
  policy: SocialReviewAudioPolicyBinding;
  measurement_method: "ffmpeg_loudnorm_pass1" | "not_applicable";
  measurement_raw: LoudnormMeasurement | null;
  measurement: { integrated_lufs: number; true_peak_dbtp: number } | null;
  output_audio: ({ path: string; sha256: string } & AudioContentFingerprint) | null;
  music_master?: SocialReviewMusicMasterBinding;
  review_video: { path: string; sha256: string };
  review_video_audio: ({ state: "present" } & AudioContentFingerprint) | {
    state: "absent";
    content_fingerprint_sha256: null;
    duration_ms: null;
    channel_count: null;
    channel_fingerprint_sha256: null;
  };
}

export interface SocialReviewMusicMasterBinding {
  role: "music_master";
  audio_decision: MusicMasterAudioPlan["audio_decision"];
  source: MusicMasterAudioPlan["source"];
  input_audio_hash: string;
  policy_hash: string;
  processing_graph: MusicMasterAudioPlan["processing_graph"];
  codec: MusicMasterAudioPlan["codec"];
  final_mux: {
    operation: "stream_copy" | "reencode";
    codec: string;
    output_audio_hash: string;
    output_container_hash: string;
  };
}

type SocialReviewMusicMasterIdentity = Omit<SocialReviewMusicMasterBinding, "final_mux">;

interface AudioContentFingerprint {
  content_fingerprint_sha256: string;
  duration_ms: number;
  channel_count: number;
  channel_fingerprint_sha256: string[];
}

interface DecodedAudioFingerprint {
  receipt: AudioContentFingerprint;
  sample_count: number;
  frequency_hz: number;
  rms_db: number;
  envelope_db: number[];
  pcm: Int16Array[];
}

const DECODED_SAMPLE_RATE = 8_000;
const MAX_CODEC_EDGE_SAMPLES = 96;
const MIN_FULL_WAVEFORM_CORRELATION = 0.985;
const MIN_ACTIVE_WINDOW_CORRELATION = 0.96;
const MAX_CODEC_LEVEL_DIFFERENCE_DB = 0.1;

interface MasteredInput {
  state: "mastered";
  generationId: string;
  sharedAudioPlanHash: string;
  projectDir: string;
  inputAudioPath: string;
  outputAudioPath: string;
  reviewVideoPath: string;
  policy: MasteringDefaults;
  policyProfileHash?: string | null;
  masteringCount: number;
  inputKind: "premaster" | "mixed" | "already_mastered";
  musicMaster?: MusicMasterAudioPlan;
}

interface NotApplicableInput {
  state: "not_applicable";
  reason: "review_video_has_no_audio_stream";
  generationId: string;
  projectDir: string;
  reviewVideoPath: string;
  policy: MasteringDefaults;
  policyProfileHash?: string | null;
}

export type BuildSocialReviewAudioReceiptInput = MasteredInput | NotApplicableInput;

/**
 * Receipt paths are canonical project-relative locations (realpath-normalized
 * before conversion) so identical evidence produced in different project roots
 * hashes identically. Absolute locations never enter hashed receipt material.
 */
function canonicalReceiptPath(projectDir: string, absolutePath: string): string {
  const root = fs.realpathSync(path.resolve(projectDir));
  const real = fs.realpathSync(path.resolve(absolutePath));
  if (real !== root && !real.startsWith(`${root}${path.sep}`)) {
    throw new Error("audio receipt evidence must be contained within the project");
  }
  return path.relative(root, real).split(path.sep).join("/");
}

function resolveReceiptPath(projectDir: string, value: { path: string }): string {
  return fs.realpathSync(path.resolve(fs.realpathSync(path.resolve(projectDir)), value.path));
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right, "en"))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function hashBytes(value: string | Buffer): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function hashFile(filePath: string): string {
  return hashBytes(fs.readFileSync(filePath));
}

function isSafeMusicMasterRef(value: string): boolean {
  const normalized = value.replace(/\\/g, "/");
  return normalized.length > 0
    && !path.isAbsolute(value)
    && !normalized.startsWith("/")
    && !/^[A-Za-z]:\//.test(normalized)
    && !normalized.split("/").includes("..");
}

function assertMusicMasterIdentity(binding: SocialReviewMusicMasterIdentity): void {
  if (binding.role !== "music_master"
    || (binding.audio_decision !== "preserve" && binding.audio_decision !== "mastering")
    || !SHA256.test(binding.source.source_content_hash)
    || binding.input_audio_hash !== binding.source.source_content_hash
    || !SHA256.test(binding.policy_hash)
    || !isSafeMusicMasterRef(binding.source.source_ref)
    || binding.source.gain_linear !== 1
    || !Number.isInteger(binding.source.source_size_bytes)
    || binding.source.source_size_bytes < 1
    || !Number.isFinite(binding.source.source_duration_us)
    || binding.source.source_duration_us < 1
    || !Number.isFinite(binding.source.source_range_us.in_us)
    || !Number.isFinite(binding.source.source_range_us.out_us)
    || binding.source.source_range_us.in_us < 0
    || binding.source.source_range_us.out_us <= binding.source.source_range_us.in_us
    || binding.source.source_range_us.out_us > binding.source.source_duration_us
    || !Number.isInteger(binding.source.timeline_range.in_frame)
    || !Number.isInteger(binding.source.timeline_range.out_frame)
    || binding.source.timeline_range.in_frame < 0
    || binding.source.timeline_range.out_frame <= binding.source.timeline_range.in_frame) {
    throw new Error("music_master preserve receipt has invalid source or policy identity");
  }
  const fullSource = binding.source.source_range_us.in_us === 0
    && binding.source.source_range_us.out_us === binding.source.source_duration_us;
  const expectedOperation = binding.audio_decision === "mastering"
    ? "shared_final_mastering"
    : fullSource ? "stream_copy" : "trim_reencode";
  if (binding.processing_graph.version !== "audio-processing-graph/v1"
    || binding.processing_graph.operations.length !== 1
    || binding.processing_graph.operations[0] !== expectedOperation) {
    throw new Error("music_master receipt processing graph identity mismatch");
  }
  const expectedCodecOperation = expectedOperation === "stream_copy" ? "stream_copy" : "reencode";
  if (binding.codec.operation !== expectedCodecOperation
    || (expectedCodecOperation === "stream_copy" && binding.codec.input !== binding.codec.output)) {
    throw new Error("music_master receipt codec identity mismatch");
  }
}

export function musicMasterIdentityFromPlan(plan: MusicMasterAudioPlan): SocialReviewMusicMasterIdentity {
  const identity: SocialReviewMusicMasterIdentity = {
    role: "music_master",
    audio_decision: plan.audio_decision,
    source: {
      ...plan.source,
      source_range_us: { ...plan.source.source_range_us },
      timeline_range: { ...plan.source.timeline_range },
    },
    input_audio_hash: plan.input_audio_hash,
    policy_hash: plan.policy_hash,
    processing_graph: {
      version: plan.processing_graph.version,
      operations: [...plan.processing_graph.operations],
    },
    codec: { ...plan.codec },
  };
  assertMusicMasterIdentity(identity);
  return identity;
}

function identityFromReceipt(binding: SocialReviewMusicMasterBinding): SocialReviewMusicMasterIdentity {
  const { final_mux: _finalMux, ...identity } = binding;
  assertMusicMasterIdentity(identity);
  return identity;
}

function audioCodec(filePath: string): string {
  const codec = runMediaTool("ffprobe", [
    "-v", "error", "-select_streams", "a:0", "-show_entries", "stream=codec_name",
    "-of", "default=nw=1:nk=1", filePath,
  ]).toString("utf8").trim();
  if (!codec) throw new Error("final review audio codec could not be measured");
  return codec;
}

function runMediaTool(command: "ffmpeg" | "ffprobe", args: string[]): Buffer {
  const result = spawnSync(command, args, { encoding: null, maxBuffer: 50 * 1024 * 1024 });
  if (result.error || result.status !== 0) {
    const detail = result.stderr?.toString("utf8").trim() || result.error?.message || `status ${result.status}`;
    throw new Error(`${command} audio verification failed: ${detail}`);
  }
  return result.stdout;
}

function hasAudioStream(filePath: string): boolean {
  const contentHash = hashFile(filePath);
  const cached = streamPresenceCache.get(contentHash);
  if (cached !== undefined) return cached;
  const stdout = runMediaTool("ffprobe", [
    "-v", "error", "-select_streams", "a:0", "-show_entries", "stream=index",
    "-of", "json", filePath,
  ]).toString("utf8");
  const parsed = JSON.parse(stdout) as { streams?: unknown[] };
  const present = Array.isArray(parsed.streams) && parsed.streams.length > 0;
  streamPresenceCache.set(contentHash, present);
  return present;
}

function audioChannelCount(filePath: string): number {
  const contentHash = hashFile(filePath);
  const cached = channelCountCache.get(contentHash);
  if (cached !== undefined) return cached;
  const stdout = runMediaTool("ffprobe", [
    "-v", "error", "-select_streams", "a:0", "-show_entries", "stream=channels",
    "-of", "json", filePath,
  ]).toString("utf8");
  const parsed = JSON.parse(stdout) as { streams?: Array<{ channels?: number }> };
  const channels = parsed.streams?.[0]?.channels;
  if (!Number.isInteger(channels) || channels === undefined || channels < 1) {
    throw new Error(`audio content fingerprint requires a valid channel count: ${filePath}`);
  }
  channelCountCache.set(contentHash, channels);
  return channels;
}

function cloneFingerprint(fingerprint: DecodedAudioFingerprint): DecodedAudioFingerprint {
  return {
    ...fingerprint,
    receipt: {
      ...fingerprint.receipt,
      channel_fingerprint_sha256: [...fingerprint.receipt.channel_fingerprint_sha256],
    },
    envelope_db: [...fingerprint.envelope_db],
    pcm: fingerprint.pcm.map((channel) => channel.slice()),
  };
}

function audioContentFingerprint(filePath: string): DecodedAudioFingerprint {
  const contentHash = hashFile(filePath);
  const cached = fingerprintCache.get(contentHash);
  if (cached) return cloneFingerprint(cached);
  if (!hasAudioStream(filePath)) throw new Error(`audio content fingerprint requires an audio stream: ${filePath}`);
  const channelCount = audioChannelCount(filePath);
  const pcm = runMediaTool("ffmpeg", [
    "-v", "error", "-i", filePath, "-map", "0:a:0", "-ac", String(channelCount), "-ar", "8000",
    "-f", "s16le", "-",
  ]);
  const frameBytes = channelCount * 2;
  if (pcm.length < frameBytes * 2) throw new Error(`audio content fingerprint decoded no samples: ${filePath}`);
  const samples = Math.floor(pcm.length / frameBytes);
  const decoded = Array.from({ length: channelCount }, () => new Int16Array(samples));
  const channelBytes = Array.from({ length: channelCount }, () => Buffer.alloc(samples * 2));
  let crossings = 0;
  let energy = 0;
  for (let channel = 0; channel < channelCount; channel += 1) {
    let previous = pcm.readInt16LE(channel * 2);
    for (let index = 0; index < samples; index += 1) {
      const sample = pcm.readInt16LE(index * frameBytes + channel * 2);
      decoded[channel]![index] = sample;
      channelBytes[channel]!.writeInt16LE(sample, index * 2);
      energy += sample * sample;
      if ((previous < 0 && sample >= 0) || (previous >= 0 && sample < 0)) crossings += 1;
      previous = sample;
    }
  }
  const windowSamples = 800;
  const envelopeDb: number[] = [];
  for (let start = 0; start < samples; start += windowSamples) {
    const end = Math.min(samples, start + windowSamples);
    let windowEnergy = 0;
    for (let index = start; index < end; index += 1) {
      for (let channel = 0; channel < channelCount; channel += 1) {
        const sample = decoded[channel]![index]!;
        windowEnergy += sample * sample;
      }
    }
    const windowRms = Math.sqrt(windowEnergy / ((end - start) * channelCount)) / 32768;
    envelopeDb.push(windowRms > 0 ? 20 * Math.log10(windowRms) : -120);
  }
  const fingerprint = {
    receipt: {
      content_fingerprint_sha256: hashBytes(pcm),
      duration_ms: Math.round(samples / 8),
      channel_count: channelCount,
      channel_fingerprint_sha256: channelBytes.map(hashBytes),
    },
    sample_count: samples,
    frequency_hz: (crossings / 2) / (samples / DECODED_SAMPLE_RATE) / channelCount,
    rms_db: 20 * Math.log10(Math.sqrt(energy / (samples * channelCount)) / 32768),
    envelope_db: envelopeDb,
    pcm: decoded,
  };
  fingerprintCache.set(contentHash, fingerprint);
  return cloneFingerprint(fingerprint);
}

function alignedSpan(
  output: Int16Array,
  video: Int16Array,
  offset: number,
): { outputStart: number; videoStart: number; length: number } {
  const outputStart = offset < 0 ? -offset : 0;
  const videoStart = offset > 0 ? offset : 0;
  return {
    outputStart,
    videoStart,
    length: Math.min(output.length - outputStart, video.length - videoStart),
  };
}

function waveformCorrelation(
  output: Int16Array,
  video: Int16Array,
  offset: number,
  stride: number,
  relativeStart = 0,
  requestedLength?: number,
): number {
  const span = alignedSpan(output, video, offset);
  const length = Math.min(requestedLength ?? span.length, span.length - relativeStart);
  if (length <= 0) return Number.NEGATIVE_INFINITY;
  let dot = 0;
  let outputEnergy = 0;
  let videoEnergy = 0;
  for (let index = 0; index < length; index += stride) {
    const outputSample = output[span.outputStart + relativeStart + index]!;
    const videoSample = video[span.videoStart + relativeStart + index]!;
    dot += outputSample * videoSample;
    outputEnergy += outputSample * outputSample;
    videoEnergy += videoSample * videoSample;
  }
  if (outputEnergy === 0 || videoEnergy === 0) return Number.NEGATIVE_INFINITY;
  return dot / Math.sqrt(outputEnergy * videoEnergy);
}

function bestCodecAlignment(output: Int16Array, video: Int16Array): number {
  let bestOffset = 0;
  let bestCorrelation = Number.NEGATIVE_INFINITY;
  for (let offset = -MAX_CODEC_EDGE_SAMPLES; offset <= MAX_CODEC_EDGE_SAMPLES; offset += 1) {
    const correlation = waveformCorrelation(output, video, offset, 4);
    if (correlation > bestCorrelation + 1e-9
      || (Math.abs(correlation - bestCorrelation) <= 1e-9 && Math.abs(offset) < Math.abs(bestOffset))) {
      bestCorrelation = correlation;
      bestOffset = offset;
    }
  }
  return bestOffset;
}

function assertAlignedWaveformContent(output: Int16Array, video: Int16Array): void {
  if (Math.abs(output.length - video.length) > MAX_CODEC_EDGE_SAMPLES) {
    throw new Error("final review video audio decoded duration exceeds codec edge allowance");
  }
  const offset = bestCodecAlignment(output, video);
  const span = alignedSpan(output, video, offset);
  const outputTrimmed = span.outputStart + (output.length - span.outputStart - span.length);
  const videoTrimmed = span.videoStart + (video.length - span.videoStart - span.length);
  if (span.length <= 0 || outputTrimmed > MAX_CODEC_EDGE_SAMPLES || videoTrimmed > MAX_CODEC_EDGE_SAMPLES) {
    throw new Error("final review video audio decoded alignment exceeds codec edge allowance");
  }
  const fullCorrelation = waveformCorrelation(output, video, offset, 1);
  if (!Number.isFinite(fullCorrelation) || fullCorrelation < MIN_FULL_WAVEFORM_CORRELATION) {
    throw new Error("final review video audio decoded waveform does not match mastered output");
  }

  const windowSamples = 800;
  const activeEnergyFloor = windowSamples * (32768 * 10 ** (-45 / 20)) ** 2;
  for (let start = 0; start < span.length; start += windowSamples) {
    const length = Math.min(windowSamples, span.length - start);
    let outputEnergy = 0;
    let videoEnergy = 0;
    for (let index = 0; index < length; index += 1) {
      const outputSample = output[span.outputStart + start + index]!;
      const videoSample = video[span.videoStart + start + index]!;
      outputEnergy += outputSample * outputSample;
      videoEnergy += videoSample * videoSample;
    }
    const scaledFloor = activeEnergyFloor * (length / windowSamples);
    if (outputEnergy < scaledFloor && videoEnergy < scaledFloor) continue;
    const correlation = waveformCorrelation(output, video, offset, 1, start, length);
    if (!Number.isFinite(correlation) || correlation < MIN_ACTIVE_WINDOW_CORRELATION) {
      throw new Error("final review video audio decoded window does not match mastered output");
    }
  }
}

function assertSameDecodedAudioContent(
  output: DecodedAudioFingerprint,
  video: DecodedAudioFingerprint,
): void {
  if (output.receipt.channel_count !== video.receipt.channel_count
    || output.pcm.length !== video.pcm.length) {
    throw new Error("final review video audio channel count does not match mastered output");
  }
  for (let channel = 0; channel < output.pcm.length; channel += 1) {
    assertAlignedWaveformContent(output.pcm[channel]!, video.pcm[channel]!);
  }
  const frequencyToleranceHz = Math.max(10, Math.max(output.frequency_hz, video.frequency_hz) * 0.05);
  if (!Number.isFinite(output.frequency_hz) || !Number.isFinite(video.frequency_hz)
    || Math.abs(output.frequency_hz - video.frequency_hz) > frequencyToleranceHz) {
    throw new Error("final review video audio decoded frequency does not match mastered output");
  }
  if (!Number.isFinite(output.rms_db) || !Number.isFinite(video.rms_db)
    || Math.abs(output.rms_db - video.rms_db) > MAX_CODEC_LEVEL_DIFFERENCE_DB) {
    throw new Error("final review video audio decoded level does not match mastered output");
  }
  const windows = Math.min(output.envelope_db.length, video.envelope_db.length);
  if (windows === 0) throw new Error("final review video audio decoded no comparable samples");
  let compared = 0;
  let difference = 0;
  for (let index = 0; index < windows; index += 1) {
    const outputDb = output.envelope_db[index]!;
    const videoDb = video.envelope_db[index]!;
    if (outputDb < -60 && videoDb < -60) continue;
    difference += Math.abs(Math.max(-60, outputDb) - Math.max(-60, videoDb));
    compared += 1;
  }
  if (compared > 0 && difference / compared > 3) {
    throw new Error("final review video audio decoded envelope does not match mastered output");
  }
}

function measureBoundOutput(filePath: string, policy: MasteringDefaults): LoudnormMeasurement {
  const cacheKey = `${hashFile(filePath)}:${hashBytes(canonicalJson(policy))}`;
  const cached = measurementCache.get(cacheKey);
  if (cached) return { ...cached };
  const result = spawnSync("ffmpeg", buildLoudnormPass1Args(filePath, policy), {
    encoding: "utf8",
    maxBuffer: 50 * 1024 * 1024,
  });
  if (result.error || (result.status !== 0 && !/"input_i"\s*:/.test(result.stderr ?? ""))) {
    throw new Error(`ffmpeg loudness remeasurement failed: ${result.stderr || result.error?.message || result.status}`);
  }
  const measurement = parseLoudnormOutput(result.stderr ?? "");
  measurementCache.set(cacheKey, measurement);
  return { ...measurement };
}

function assertMeasurementMatches(actual: LoudnormMeasurement, claimed: LoudnormMeasurement): void {
  for (const field of ["input_i", "input_tp", "input_lra", "input_thresh", "target_offset"] as const) {
    const actualValue = Number(actual[field]);
    const claimedValue = Number(claimed[field]);
    if (!Number.isFinite(actualValue) || !Number.isFinite(claimedValue)
      || Math.abs(actualValue - claimedValue) > 0.1) {
      throw new Error(`bound output audio loudness remeasurement mismatch: ${field}`);
    }
  }
}

function policyBinding(
  values: MasteringDefaults,
  profileHash: string | null = null,
): SocialReviewAudioPolicyBinding {
  if (profileHash !== null && !SHA256.test(profileHash)) {
    throw new Error("audio policy profile hash must be a sha256 identity");
  }
  const normalized = {
    loudness_target_lufs: values.loudness_target_lufs,
    lra_target: values.lra_target,
    true_peak_target_dbtp: values.true_peak_target_dbtp,
  };
  return {
    values: normalized,
    profile_sha256: profileHash,
    sha256: hashBytes(canonicalJson({ values: normalized, profile_sha256: profileHash })),
  };
}

export function deriveSocialReviewAudioPlanIdentity(input: {
  state: "mastered" | "not_applicable";
  sharedAudioPlanHash: string | null;
  policy: MasteringDefaults;
  policyProfileHash?: string | null;
  musicMaster?: SocialReviewMusicMasterIdentity;
}): string {
  if (input.sharedAudioPlanHash !== null && !SHA256.test(input.sharedAudioPlanHash)) {
    throw new Error("shared audio plan hash must be a sha256 identity");
  }
  if (input.state === "mastered" && input.sharedAudioPlanHash === null) {
    throw new Error("mastered audio identity requires a shared audio plan hash");
  }
  if (input.state === "not_applicable" && input.sharedAudioPlanHash !== null) {
    throw new Error("not_applicable audio identity cannot claim a shared audio plan");
  }
  if (input.musicMaster) assertMusicMasterIdentity(input.musicMaster);
  return hashBytes(canonicalJson({
    version: "social-review-audio-plan-identity/v1",
    state: input.state,
    shared_audio_plan_sha256: input.sharedAudioPlanHash,
    policy: policyBinding(input.policy, input.policyProfileHash ?? null),
    ...(input.musicMaster ? { music_master: input.musicMaster } : {}),
  }));
}

function numericMeasurement(raw: LoudnormMeasurement): {
  integrated_lufs: number;
  true_peak_dbtp: number;
} {
  const integrated = Number(raw.input_i);
  const peak = Number(raw.input_tp);
  if (!Number.isFinite(integrated) || !Number.isFinite(peak)) {
    throw new Error("shared loudnorm measurement must contain finite loudness and true peak");
  }
  return { integrated_lufs: integrated, true_peak_dbtp: peak };
}

export function buildSocialReviewAudioReceipt(
  input: BuildSocialReviewAudioReceiptInput,
): SocialReviewAudioReceipt {
  if (!SHA256.test(input.generationId)) throw new Error("audio receipt generation ID must be a sha256 identity");
  const policy = policyBinding(input.policy, input.policyProfileHash ?? null);
  const sharedAudioPlanHash = input.state === "mastered" ? input.sharedAudioPlanHash : null;
  const musicMasterIdentity = input.state === "mastered" && input.musicMaster
    ? musicMasterIdentityFromPlan(input.musicMaster)
    : undefined;
  if (input.state === "not_applicable" && "musicMaster" in input && input.musicMaster) {
    throw new Error("not_applicable audio receipt cannot claim a music_master plan");
  }
  const audioPlanHash = deriveSocialReviewAudioPlanIdentity({
    state: input.state,
    sharedAudioPlanHash,
    policy: input.policy,
    policyProfileHash: input.policyProfileHash ?? null,
    ...(musicMasterIdentity ? { musicMaster: musicMasterIdentity } : {}),
  });
  if (input.state === "not_applicable") {
    if (hasAudioStream(input.reviewVideoPath)) {
      throw new Error("not_applicable review video must not contain an audio stream");
    }
    return {
      version: "social-review-audio-mastering-receipt/v1",
      state: "not_applicable",
      reason: input.reason,
      generation_id: input.generationId,
      shared_audio_plan_sha256: null,
      audio_plan_sha256: audioPlanHash,
      mastering_count: 0,
      input_audio: null,
      policy,
      measurement_method: "not_applicable",
      measurement_raw: null,
      measurement: null,
      output_audio: null,
      review_video: { path: canonicalReceiptPath(input.projectDir, input.reviewVideoPath), sha256: hashFile(input.reviewVideoPath) },
      review_video_audio: {
        state: "absent", content_fingerprint_sha256: null, duration_ms: null,
        channel_count: null, channel_fingerprint_sha256: null,
      },
    };
  }
  if (input.inputKind === "mixed") {
    throw new Error("mixed audio input cannot enter social-review mastering; use the shared premaster plan");
  }
  if (input.inputKind === "already_mastered") {
    throw new Error("already-mastered input cannot be mastered again");
  }
  const preservingMusicMaster = musicMasterIdentity?.audio_decision === "preserve";
  if (preservingMusicMaster ? input.masteringCount !== 0 : input.masteringCount !== 1) {
    throw new Error("social-review mastering count must be exactly once");
  }
  const inputAudioHash = hashFile(input.inputAudioPath);
  if (musicMasterIdentity
    && (inputAudioHash !== musicMasterIdentity.input_audio_hash
      || inputAudioHash !== musicMasterIdentity.source.source_content_hash)) {
    throw new Error("music_master receipt input audio identity does not match the bound plan");
  }
  if (preservingMusicMaster && hashFile(input.outputAudioPath) !== musicMasterIdentity!.source.source_content_hash) {
    throw new Error("music_master preserve receipt output audio bytes do not match the source identity");
  }
  const measurement = measureBoundOutput(input.outputAudioPath, input.policy);
  const outputFingerprint = audioContentFingerprint(input.outputAudioPath);
  const videoFingerprint = audioContentFingerprint(input.reviewVideoPath);
  assertSameDecodedAudioContent(outputFingerprint, videoFingerprint);
  const musicMaster = musicMasterIdentity
    ? {
        ...musicMasterIdentity,
        final_mux: {
          // The public social-review mux currently uses -c:a aac; record the
          // actual delivery operation instead of claiming source byte-copy.
          operation: "reencode" as const,
          codec: audioCodec(input.reviewVideoPath),
          output_audio_hash: videoFingerprint.receipt.content_fingerprint_sha256,
          output_container_hash: hashFile(input.reviewVideoPath),
        },
      }
    : undefined;
  return {
    version: "social-review-audio-mastering-receipt/v1",
    state: "mastered",
    reason: preservingMusicMaster
      ? "shared_audio_render_plan_preserve"
      : "shared_audio_render_plan_exactly_once",
    generation_id: input.generationId,
    shared_audio_plan_sha256: input.sharedAudioPlanHash,
    audio_plan_sha256: audioPlanHash,
    mastering_count: input.masteringCount as 0 | 1,
    input_audio: { path: canonicalReceiptPath(input.projectDir, input.inputAudioPath), sha256: hashFile(input.inputAudioPath) },
    policy,
    measurement_method: "ffmpeg_loudnorm_pass1",
    measurement_raw: measurement,
    measurement: numericMeasurement(measurement),
    output_audio: { path: canonicalReceiptPath(input.projectDir, input.outputAudioPath), sha256: hashFile(input.outputAudioPath), ...outputFingerprint.receipt },
    ...(musicMaster ? { music_master: musicMaster } : {}),
    review_video: { path: canonicalReceiptPath(input.projectDir, input.reviewVideoPath), sha256: hashFile(input.reviewVideoPath) },
    review_video_audio: { state: "present", ...videoFingerprint.receipt },
  };
}

export interface VerifySocialReviewAudioReceiptOptions {
  generationId: string;
  projectDir: string;
  expectedAudioPlanHash?: string;
  expectedSharedAudioPlanHash?: string | null;
  reviewVideoPath: string;
  expectedPolicy?: MasteringDefaults;
  expectedPolicyProfileHash?: string | null;
  reportMeasurement?: { integrated_lufs: number; true_peak_dbtp: number } | null;
}

export function verifySocialReviewAudioReceipt(
  receipt: SocialReviewAudioReceipt,
  options: VerifySocialReviewAudioReceiptOptions,
): void {
  validateArtifact<SocialReviewAudioReceipt>(receipt, "social-review-audio-mastering-receipt.schema.json");
  if (receipt.generation_id !== options.generationId) throw new Error("audio receipt generation binding mismatch");
  if (options.expectedAudioPlanHash !== undefined
    && receipt.audio_plan_sha256 !== options.expectedAudioPlanHash) {
    throw new Error("audio receipt plan/policy generation binding mismatch");
  }
  if (options.expectedSharedAudioPlanHash !== undefined
    && receipt.shared_audio_plan_sha256 !== options.expectedSharedAudioPlanHash) {
    throw new Error("audio receipt shared plan does not match the current canonical source");
  }
  if (resolveReceiptPath(options.projectDir, receipt.review_video) !== fs.realpathSync(options.reviewVideoPath)
    || hashFile(options.reviewVideoPath) !== receipt.review_video.sha256) {
    throw new Error("audio receipt review video bytes/hash mismatch");
  }
  const expectedPolicy = policyBinding(
    options.expectedPolicy ?? receipt.policy.values,
    options.expectedPolicyProfileHash === undefined
      ? receipt.policy.profile_sha256
      : options.expectedPolicyProfileHash,
  );
  if (canonicalJson(expectedPolicy) !== canonicalJson(receipt.policy)) {
    throw new Error("audio policy/profile hash binding mismatch");
  }
  const derivedAudioPlanHash = deriveSocialReviewAudioPlanIdentity({
    state: receipt.state,
    sharedAudioPlanHash: receipt.shared_audio_plan_sha256,
    policy: receipt.policy.values,
    policyProfileHash: receipt.policy.profile_sha256,
    ...(receipt.music_master
      ? { musicMaster: identityFromReceipt(receipt.music_master) }
      : {}),
  });
  if (receipt.audio_plan_sha256 !== derivedAudioPlanHash) {
    throw new Error("audio plan/policy identity hash mismatch");
  }
  if (receipt.state === "not_applicable") {
    if (receipt.mastering_count !== 0 || receipt.input_audio !== null
      || receipt.output_audio !== null || receipt.measurement_raw !== null
      || receipt.measurement !== null || receipt.measurement_method !== "not_applicable"
      || receipt.review_video_audio.state !== "absent" || receipt.music_master !== undefined) {
      throw new Error("not_applicable audio receipt contains fictional mastering evidence");
    }
    if (hasAudioStream(options.reviewVideoPath)) {
      throw new Error("not_applicable review video contains an audio stream");
    }
  } else {
    const preservingMusicMaster = receipt.music_master?.audio_decision === "preserve";
    const expectedReason = preservingMusicMaster
      ? "shared_audio_render_plan_preserve"
      : "shared_audio_render_plan_exactly_once";
    const expectedMasteringCount = preservingMusicMaster ? 0 : 1;
    if (receipt.reason !== expectedReason || receipt.mastering_count !== expectedMasteringCount
      || receipt.measurement_method !== "ffmpeg_loudnorm_pass1"
      || !receipt.input_audio || !receipt.output_audio || !receipt.measurement_raw || !receipt.measurement) {
      throw new Error("audio receipt must prove the plan-bound mastering or preserve decision");
    }
    const inputAudioPath = resolveReceiptPath(options.projectDir, receipt.input_audio);
    if (hashFile(inputAudioPath) !== receipt.input_audio.sha256) {
      throw new Error("input audio bytes/hash mismatch");
    }
    if (preservingMusicMaster && hashFile(inputAudioPath) !== receipt.music_master!.input_audio_hash) {
      throw new Error("music_master preserve input audio identity mismatch");
    }
    const outputAudioPath = resolveReceiptPath(options.projectDir, receipt.output_audio);
    if (hashFile(outputAudioPath) !== receipt.output_audio.sha256) {
      throw new Error("output audio bytes/hash mismatch");
    }
    if (preservingMusicMaster && receipt.output_audio.sha256 !== receipt.music_master!.source.source_content_hash) {
      throw new Error("music_master preserve output audio identity mismatch");
    }
    if (canonicalJson(numericMeasurement(receipt.measurement_raw)) !== canonicalJson(receipt.measurement)) {
      throw new Error("measured loudness/true peak does not derive from measurement receipt");
    }
    const remeasured = measureBoundOutput(outputAudioPath, receipt.policy.values);
    assertMeasurementMatches(remeasured, receipt.measurement_raw);
    const outputFingerprint = audioContentFingerprint(outputAudioPath);
    const videoFingerprint = audioContentFingerprint(options.reviewVideoPath);
    if (receipt.music_master) {
      const finalMux = receipt.music_master.final_mux;
      if (finalMux.operation !== "reencode"
        || !SHA256.test(finalMux.output_audio_hash)
        || !SHA256.test(finalMux.output_container_hash)
        || finalMux.output_audio_hash !== videoFingerprint.receipt.content_fingerprint_sha256
        || finalMux.output_container_hash !== hashFile(options.reviewVideoPath)
        || finalMux.codec !== audioCodec(options.reviewVideoPath)) {
        throw new Error("music_master final mux codec/processing/hash binding mismatch");
      }
    }
    if (canonicalJson(outputFingerprint.receipt) !== canonicalJson({
      content_fingerprint_sha256: receipt.output_audio.content_fingerprint_sha256,
      duration_ms: receipt.output_audio.duration_ms,
      channel_count: receipt.output_audio.channel_count,
      channel_fingerprint_sha256: receipt.output_audio.channel_fingerprint_sha256,
    }) || receipt.review_video_audio.state !== "present"
      || canonicalJson(videoFingerprint.receipt) !== canonicalJson({
        content_fingerprint_sha256: receipt.review_video_audio.content_fingerprint_sha256,
        duration_ms: receipt.review_video_audio.duration_ms,
        channel_count: receipt.review_video_audio.channel_count,
        channel_fingerprint_sha256: receipt.review_video_audio.channel_fingerprint_sha256,
      })) {
      throw new Error("final review video audio content fingerprint mismatch");
    }
    assertSameDecodedAudioContent(outputFingerprint, videoFingerprint);
  }
  if (options.reportMeasurement !== undefined
    && canonicalJson(options.reportMeasurement) !== canonicalJson(receipt.measurement)) {
    throw new Error("report measurement must be derived from the audio measurement receipt");
  }
}

export function audioReportFromReceipt(receipt: SocialReviewAudioReceipt): {
  state: SocialReviewAudioReceipt["state"];
  reason: SocialReviewAudioReceipt["reason"];
  mastering_count: 0 | 1;
  policy_sha256: string;
  measurement_method: SocialReviewAudioReceipt["measurement_method"];
  integrated_lufs: number | null;
  true_peak_dbtp: number | null;
} {
  return {
    state: receipt.state,
    reason: receipt.reason,
    mastering_count: receipt.mastering_count,
    policy_sha256: receipt.policy.sha256,
    measurement_method: receipt.measurement_method,
    integrated_lufs: receipt.measurement?.integrated_lufs ?? null,
    true_peak_dbtp: receipt.measurement?.true_peak_dbtp ?? null,
  };
}
