import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import { resolveAudioGainWithFallback } from "../../editor/shared/audio-gain.js";
import type { AudioMix, ClipOutput, TimelineIR } from "../compiler/types.js";
import { loadSourceMap } from "../media/source-map.js";
import {
  resolveExplicitBgmTrack,
  type ResolvedPinnedBgmTrack,
} from "../music/cue-planner.js";
import type { PackRegistryOptions } from "../music/pack-registry.js";
import {
  resolveAudioFinishPolicy,
  type ResolvedAudioFinishPolicy,
} from "./dialogue-finishing.js";
import {
  validateMusicCues,
  type MusicCueV2,
  type MusicCuesDoc,
} from "./music-cues.js";
import { DEFAULT_MASTERING, type MasteringDefaults } from "./mastering.js";
import {
  MUSIC_MASTER_MVP_POLICY,
  hashMusicMasterMvpPolicy,
  type MusicMasterMvpPolicy,
} from "./music-master-mvp.js";
import {
  resolveSfxCuePlan,
  SfxCueContractError,
  type ResolvedSfxCue,
  type ResolvedSfxCuePlan,
  type SfxSemanticRole,
} from "./sfx-cues.js";
import {
  loadAudioDeliveryProfile,
  parseAudioDeliveryProfile,
  selectAudioDeliveryProfile,
  audioDeliveryProfileContentHash,
  AudioDeliveryProfileError,
  type AudioDeliveryProfile,
  type AudioDeliveryProfileSelection,
  type LoadedAudioDeliveryProfile,
  type SelectAudioDeliveryProfileOptions,
} from "./delivery-profile.js";

export type AudioRenderStrategy =
  | "explicit_music_cues_v2"
  | "explicit_sfx_cues_v1"
  | "explicit_music_and_sfx_cues_v1"
  | "dialogue_only"
  | "original_passthrough"
  | "legacy_embedded_bgm"
  | "music_master";

export type AudioDecision = "preserve" | "mastering";

export type MusicMasterProcessingOperation =
  | "stream_copy"
  | "trim_reencode"
  | "shared_final_mastering";

export interface MusicMasterAudioSource {
  role: "music_master";
  asset_id: string;
  /** Project-relative logical reference; absolute source paths never enter the plan. */
  source_ref: string;
  source_content_hash: string;
  source_size_bytes: number;
  source_duration_us: number;
  source_range_us: { in_us: number; out_us: number };
  timeline_range: { in_frame: number; out_frame: number };
  gain_linear: 1;
  channel_layout: string;
  codec: string;
}

export interface MusicMasterProcessingGraph {
  version: "audio-processing-graph/v1";
  operations: MusicMasterProcessingOperation[];
}

export interface MusicMasterAudioPlan {
  enabled: true;
  source: MusicMasterAudioSource;
  audio_decision: AudioDecision;
  input_audio_hash: string;
  policy_hash: string;
  /** Present only for explicit Issue #38 mastering; absent for preserve. */
  mastering_policy?: MusicMasterMvpPolicy;
  processing_graph: MusicMasterProcessingGraph;
  codec: {
    input: string;
    output: string;
    operation: "stream_copy" | "reencode";
  };
  measurement_tolerance: {
    integrated_lufs_db: number;
    lra_lu: number;
    true_peak_dbtp: number;
  };
}

export type DialogueFinishScope =
  | "a1_only"
  | "none"
  | "none_original_passthrough"
  | "none_mixed_legacy";

export interface AudioRenderSourceClip {
  track_id: "A1";
  clip_id: string;
  asset_id: string;
  role: "dialogue" | "nat_sound";
  source_path: string;
  source_content_hash: string;
  source_size_bytes: number;
  source_range_us: { in_us: number; out_us: number };
  timeline_range: { in_frame: number; out_frame: number };
  gain_linear: number;
}

/** Authored A3 ambience is retained as a timed, hashed stem even when the
 * formal rights-pinned SFX executor cannot render it. */
export interface AudioRenderAmbientClip {
  track_id: "A3";
  clip_id: string;
  asset_id: string;
  role: "ambient";
  source_path: string;
  source_content_hash: string;
  source_size_bytes: number;
  source_range_us: { in_us: number; out_us: number };
  timeline_range: { in_frame: number; out_frame: number };
  gain_linear: number;
}

export interface AudioRenderResolvedTrack {
  track_id: string;
  pack_id: string;
  pack_version: string;
  pack_manifest_hash: string;
  full_mix_path: string;
  full_mix_content_hash: string;
  full_mix_size_bytes: number;
  analysis_content_hash: string;
  analysis_size_bytes: number;
  analysis_status: "ready" | "degraded" | "failed" | "unavailable";
  duration_us: number;
}

export interface AudioRenderCue {
  cue_id: string;
  track_id: string;
  source_path: string;
  source_range_us: { in_us: number; out_us: number };
  timeline_range: { in_frame: number; out_frame: number };
  semantic_anchor: MusicCueV2["semantic_anchor"];
  section: string;
  phase: string;
  applied: {
    base_gain_db: number;
    duck_gain_db: number;
    fade_in_ms: number;
    fade_out_ms: number;
    attack_ms: number;
    release_ms: number;
  };
  pins: {
    pack_id: string;
    pack_version: string;
    pack_manifest_hash: string;
    full_mix_content_hash: string;
    full_mix_size_bytes: number;
    analysis_content_hash: string;
    analysis_size_bytes: number;
    analysis_status: AudioRenderResolvedTrack["analysis_status"];
  };
}

export interface AudioRenderSfxCue {
  cue_id: string;
  semantic_role: SfxSemanticRole;
  asset_id: string;
  source_path: string;
  source_range_us: { in_us: number; out_us: number };
  timeline_range: { in_frame: number; out_frame: number };
  trigger_frame: number;
  duration_frames: number;
  dialogue_overlap_frames: number;
  applied: {
    gain_db: number;
    fade_in_ms: number;
    fade_out_ms: number;
    duck_group: "dialogue" | "none";
    duck_gain_db: number;
    attack_ms: number;
    release_ms: number;
  };
  tail_processing: ResolvedSfxCue["tail_processing"];
  pins: ResolvedSfxCue["asset_pin"] & {
    library_id: string;
    library_version: string;
    library_manifest_hash: string;
  };
  intent: string;
  decision_pin?: ResolvedSfxCue["decision_pin"];
}

export interface AudioRenderPolicySourceHashes {
  A1: Array<{ clip_id: string; content_hash: string; size_bytes: number }>;
  A2: Array<{ cue_id: string; content_hash: string; size_bytes: number }>;
  A3: Array<{ cue_id: string; content_hash: string; size_bytes: number }>;
}

export interface SceneAudioRenderPolicy {
  version: "scene-audio-render-policy/v1";
  lane_semantics: {
    A1: "dialogue_and_natural_sound";
    A2: "music_bgm";
    A3: "texture_ambient_and_sfx";
  };
  music_master?: {
    authority: "music_master";
    requested: true;
    audio_decision: AudioDecision;
    source_content_hash: string;
    timeline_range: { in_frame: number; out_frame: number };
  };
  dialogue: {
    authority: "A1";
    conflict_policy: "dialogue_first";
    outcome: "active" | "silenced" | "degraded";
    timing_owner: "timeline";
  };
  bgm: {
    authority: "A2";
    requested: boolean;
    conflict_outcome: "ducked" | "allowed" | "denied" | "silenced" | "not_requested";
    permission: "allowed" | "denied" | "not_requested";
    reason: string;
  };
  sfx: {
    authority: "A3";
    requested: boolean;
    permission: "allowed" | "denied" | "human_hold" | "not_requested";
    outcome: "allowed" | "muted" | "denied" | "silenced" | "degraded" | "human_hold" | "not_requested";
    reason: string;
  };
  ambient: {
    authority: "A3";
    requested: boolean;
    permission: "allowed" | "human_hold" | "not_requested";
    outcome: "preserved" | "human_hold" | "not_requested";
    clips: Array<{
      clip_id: string;
      asset_id: string;
      source_content_hash: string;
      timeline_range: { in_frame: number; out_frame: number };
    }>;
    reason: string;
  };
  silence_and_degrade: {
    dialogue: "preserve_timeline_silence" | "not_needed";
    optional_tools: "fail_open";
    missing_profile: "human_hold";
  };
  timing: {
    picture_timing_immutable: true;
    dialogue_timing_immutable: true;
    caption_timing_immutable: true;
    audio_displacement_frames: 0;
    cue_timing_source: "timeline";
  };
  source_hashes: AudioRenderPolicySourceHashes;
  single_mastering: {
    owner: "shared_audio_render_plan";
    stage: "after_mix" | "not_applied";
    count: 0 | 1;
    route_normalization: "none_outside_final_mastering";
  };
}

export interface AudioDeliveryProfileRef {
  profile_id: string;
  profile_version: string;
  platform: string;
  surface: string;
  release_scope: "organic" | "ads" | "internal";
  delivery_variant: string;
  path: string;
  /** Raw bytes hash of the registered profile file. Kept as content_hash for v1 callers. */
  source_hash: string;
  /** Hash of the canonical normalized parsed profile. */
  profile_hash: string;
  content_hash: string;
  selection_status: "verified" | "human_hold";
  freshness: "current" | "stale" | "unknown";
  human_preview_required: boolean;
}

export interface AudioMeasurementRequirements {
  encoded_result_required: true;
  measurement_stage: "encoded_deliverable";
  loudness: {
    integrated_lufs: "measure";
    short_term_lufs: "measure_if_supported";
    lra: "measure_if_supported";
    true_peak_dbtp: "measure";
  };
  format: {
    container: "ffprobe";
    codec: "ffprobe";
    sample_rate_hz: "ffprobe";
    channels: "ffprobe";
  };
  duration_and_sync: {
    duration: "measure";
    av_sync: "measure_when_video_present";
    timing_displacement_allowed_frames: 0;
  };
  playback: {
    mono_fold_down: "machine_fixture_or_hold";
    mobile: "human_audition";
  };
  human_audition: {
    required: boolean;
    status: "pending";
    automated_quality_claim: "not_allowed";
  };
}

export interface AudioRenderPlan {
  version: "audio-render-plan/v1";
  project_id: string;
  strategy: AudioRenderStrategy;
  timeline: {
    path: string;
    version: string;
    content_hash: string;
    duration_frames: number;
    fps: { num: number; den: number };
  };
  inputs: {
    music_cues_path?: string;
    music_cues_content_hash?: string;
    selection_content_hash?: string;
    sfx_cues_path?: string;
    sfx_cues_content_hash?: string;
    sfx_library_manifest_path?: string;
    sfx_library_manifest_hash?: string;
    sound_design_decision_path?: string;
    sound_design_decision_content_hash?: string;
  };
  dialogue: {
    source_track_id: "A1";
    clips: AudioRenderSourceClip[];
    finish_scope: DialogueFinishScope;
    finish_policy?: ResolvedAudioFinishPolicy;
  };
  music: {
    enabled: boolean;
    source_track_id: "A2";
    cues: AudioRenderCue[];
  };
  /** Independent full-song source. It is never inferred from A1/A2/A3. */
  music_master?: MusicMasterAudioPlan;
  sfx?: {
    enabled: boolean;
    required: boolean;
    source_track_id: "A3";
    library?: {
      library_id: string;
      library_version: string;
      manifest_path: string;
      manifest_hash: string;
    };
    cues: AudioRenderSfxCue[];
  };
  /** Formal SFX stays non-renderable until this HOLD is resolved. */
  sfx_hold?: {
    code: string;
    reason: string;
  };
  ambient?: {
    enabled: boolean;
    source_track_id: "A3";
    clips: AudioRenderAmbientClip[];
  };
  final_mastering: MasteringDefaults & {
    count: 0 | 1;
    stage: "after_mix" | "not_applied";
    /** Added by RFA-011; omitted by legacy in-memory callers. */
    owner?: "shared_audio_render_plan";
  };
  /** Added by RFA-011; legacy v1 plans may omit it. */
  scene_audio_policy?: SceneAudioRenderPolicy;
  /** Added by RFA-012; legacy v1 plans may omit it. */
  audio_measurement_requirements?: AudioMeasurementRequirements;
  audio_delivery_profile?: AudioDeliveryProfileRef;
  expected_artifacts: {
    dialogue_stem: "raw_dialogue.wav";
    final_mix: "final_mix.wav";
    report: "audio-mix-report.json";
    mastered_mp3?: "music_master_320.mp3";
  };
  warnings: string[];
}

export interface ResolveAudioRenderPlanOptions {
  projectDir: string;
  repoSfxRoot?: string;
  timelinePath: string;
  musicCuesPath?: string;
  sfxCuesPath?: string;
  sourceOverrides?: Record<string, string>;
  packRegistryOptions?: PackRegistryOptions;
  resolveTrackImpl?: (
    musicCues: MusicCuesDoc,
    registryOptions?: PackRegistryOptions,
  ) => AudioRenderResolvedTrack;
  masteringDefaults?: MasteringDefaults;
  /** Exact registered audio profile path, id, or an already parsed profile. */
  audioDeliveryProfile?: string | AudioDeliveryProfile | LoadedAudioDeliveryProfile;
  audioProfilePath?: string;
  audioProfileId?: string;
  audioProfilePlatform?: string;
  audioProfileSurface?: string;
  audioProfileReleaseScope?: "organic" | "ads" | "internal";
  audioProfileVariant?: string;
  audioProfileRootDir?: string;
  now?: Date;
}

export class AudioRenderPlanError extends Error {
  constructor(
    readonly code:
      | "AUDIO_RENDER_PLAN_INVALID"
      | "AUDIO_RENDER_SOURCE_MISSING"
      | "AUDIO_RENDER_PACK_DRIFT"
      | "AUDIO_RENDER_PROFILE_SCOPE_MISMATCH"
      | "AUDIO_RENDER_PROFILE_UNKNOWN"
      | "AUDIO_RENDER_PLAN_STALE",
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = "AudioRenderPlanError";
  }
}

export function hashFile(filePath: string): string {
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

function normalized(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalized);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right, "en"))
      .map(([key, entry]) => [key, normalized(entry)]),
  );
}

export function hashAudioRenderPlan(plan: AudioRenderPlan): string {
  return `sha256:${createHash("sha256")
    .update(JSON.stringify(normalized(plan)))
    .digest("hex")}`;
}

/**
 * A supplied plan is executable only when it is byte-identical to the plan
 * freshly resolved from the canonical timeline.  The explicit music-master
 * comparison keeps source/policy drift diagnosable while the full plan hash
 * closes every other identity-bearing field.
 */
export function assertAudioRenderPlanMatchesCanonical(
  supplied: AudioRenderPlan,
  canonical: AudioRenderPlan,
): void {
  assertAudioRenderPlanContract(supplied);
  assertAudioRenderPlanContract(canonical);
  const suppliedMaster = supplied.music_master;
  const canonicalMaster = canonical.music_master;
  if (Boolean(suppliedMaster) !== Boolean(canonicalMaster)) {
    throw new AudioRenderPlanError(
      "AUDIO_RENDER_PLAN_STALE",
      "supplied audio plan does not match the canonical timeline music_master declaration",
    );
  }
  if (suppliedMaster && canonicalMaster) {
    const identityKeys = [
      "source",
      "audio_decision",
      "input_audio_hash",
      "policy_hash",
      "mastering_policy",
      "processing_graph",
      "codec",
    ] as const;
    for (const key of identityKeys) {
      if (JSON.stringify(normalized(suppliedMaster[key])) !== JSON.stringify(normalized(canonicalMaster[key]))) {
        throw new AudioRenderPlanError(
          "AUDIO_RENDER_PLAN_STALE",
          `supplied music_master ${key} does not match the canonical timeline declaration`,
        );
      }
    }
  }
  if (hashAudioRenderPlan(supplied) !== hashAudioRenderPlan(canonical)) {
    throw new AudioRenderPlanError(
      "AUDIO_RENDER_PLAN_STALE",
      "supplied audio render plan identity does not match the freshly resolved canonical plan",
    );
  }
}

/** Stable identity for the independent music_master policy, excluding its hash field. */
export function hashMusicMasterPolicy(
  policy: Omit<MusicMasterAudioPlan, "policy_hash">,
): string {
  return `sha256:${createHash("sha256")
    .update(JSON.stringify(normalized(policy)))
    .digest("hex")}`;
}

function readJson<T>(filePath: string): T {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
  } catch (error) {
    throw new AudioRenderPlanError(
      "AUDIO_RENDER_PLAN_INVALID",
      `Cannot read ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function requiredFile(filePath: string, label: string): string {
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
    throw new AudioRenderPlanError(
      "AUDIO_RENDER_SOURCE_MISSING",
      `${label} is missing: ${resolved}`,
    );
  }
  return resolved;
}

function resolveA1Source(
  projectDir: string,
  clip: ClipOutput,
  overrides: Record<string, string> | undefined,
  sourceMap: ReturnType<typeof loadSourceMap> | undefined,
): string {
  const explicit = overrides?.[clip.asset_id];
  const mapped = sourceMap?.entryMap.get(clip.asset_id)?.source_locator;
  const metadata = clip.metadata as Record<string, unknown> | undefined;
  const hinted = ["source_path", "source_locator", "local_source_path"]
    .map((key) => metadata?.[key])
    .find((value): value is string =>
      typeof value === "string" && value.trim().length > 0
    );
  const candidate = explicit ?? mapped ?? hinted;
  if (!candidate) {
    throw new AudioRenderPlanError(
      "AUDIO_RENDER_SOURCE_MISSING",
      `A1 clip ${clip.clip_id} has no source for asset ${clip.asset_id}.`,
    );
  }
  return requiredFile(
    path.isAbsolute(candidate) ? candidate : path.resolve(projectDir, candidate),
    `A1 clip ${clip.clip_id}`,
  );
}

function audioPolicyMode(timeline: TimelineIR): "ducking" | "bgm_only" | "original_only" | "music_master" {
  const mode = timeline.provenance?.audio_policy?.mode;
  return mode === "bgm_only" || mode === "original_only" || mode === "music_master"
    ? mode
    : "ducking";
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function firstString(record: Record<string, unknown>, keys: string[]): string | undefined {
  return keys
    .map((key) => record[key])
    .find((value): value is string => typeof value === "string" && value.trim().length > 0);
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isSafeProjectRelativeAudioRef(value: string): boolean {
  const normalized = value.replace(/\\/g, "/");
  return normalized.length > 0
    && !path.isAbsolute(value)
    && !normalized.startsWith("/")
    && !/^[A-Za-z]:\//.test(normalized)
    && !normalized.split("/").includes("..");
}

/**
 * The resolver intentionally accepts the existing canonical spellings and
 * compatibility aliases below, but nested music_master declarations are
 * otherwise closed-world. In particular, processing controls must not be
 * silently ignored and converted into a stream-copy plan.
 */
const MUSIC_MASTER_DECLARATION_KEYS: ReadonlySet<string> = new Set([
  "asset_id",
  "source_asset_id",
  "source_ref",
  "source_path",
  "path",
  "source_content_hash",
  "source_hash",
  "hash",
  "source_size_bytes",
  "source_duration_us",
  "duration_us",
  "source_range_us",
  "source_start_us",
  "source_end_us",
  "timeline_range",
  "timeline_start_frame",
  "timeline_end_frame",
  "gain_linear",
  "gain",
  "audio_decision",
  "decision",
  "channel_layout",
  "channels",
  "codec",
  "codec_name",
  "processing_graph",
  "measurement_tolerance",
  "policy_hash",
]);

function assertMusicMasterDeclarationKeys(declaration: Record<string, unknown>): void {
  const unknownKeys = Object.keys(declaration)
    .filter((key) => !MUSIC_MASTER_DECLARATION_KEYS.has(key))
    .sort((left, right) => left.localeCompare(right, "en"));
  if (unknownKeys.length > 0) {
    throw new AudioRenderPlanError(
      "AUDIO_RENDER_PLAN_INVALID",
      `music_master declaration contains non-canonical field(s): ${unknownKeys.join(", ")}`,
    );
  }
}

function readMusicMasterDeclaration(timeline: TimelineIR): Record<string, unknown> | undefined {
  const policy = recordValue(timeline.provenance?.audio_policy);
  const provenance = recordValue(timeline.provenance);
  const metadata = recordValue(timeline.metadata);
  const candidates = [policy?.music_master, provenance?.music_master, metadata?.music_master]
    .filter((value) => value !== undefined);
  if (candidates.length === 0) return undefined;
  const declaration = recordValue(candidates[0]);
  if (!declaration || candidates.some((candidate) => JSON.stringify(candidate) !== JSON.stringify(candidates[0]))) {
    throw new AudioRenderPlanError(
      "AUDIO_RENDER_PLAN_INVALID",
      "music_master declaration must be one consistent object.",
    );
  }
  assertMusicMasterDeclarationKeys(declaration);
  return declaration;
}

function projectRelativeAudioSource(
  projectDir: string,
  declaration: Record<string, unknown>,
): { path: string; ref: string } {
  const declared = firstString(declaration, ["source_ref", "source_path", "path"]);
  if (!declared) {
    throw new AudioRenderPlanError(
      "AUDIO_RENDER_SOURCE_MISSING",
      "music_master requires a source_ref.",
    );
  }
  if (!isSafeProjectRelativeAudioRef(declared)) {
    throw new AudioRenderPlanError(
      "AUDIO_RENDER_SOURCE_MISSING",
      "music_master source_ref must be a project-relative canonical reference.",
    );
  }
  const projectRoot = fs.realpathSync(projectDir);
  const candidate = path.resolve(projectRoot, declared);
  if (!fs.existsSync(candidate) || !fs.statSync(candidate).isFile()) {
    throw new AudioRenderPlanError(
      "AUDIO_RENDER_SOURCE_MISSING",
      "music_master source_ref does not resolve to a project file.",
    );
  }
  const real = fs.realpathSync(candidate);
  const relative = path.relative(projectRoot, real);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new AudioRenderPlanError(
      "AUDIO_RENDER_SOURCE_MISSING",
      "music_master source_ref must remain inside the project.",
    );
  }
  return { path: real, ref: relative.split(path.sep).join("/") };
}

function rangeFromDeclaration(
  declaration: Record<string, unknown>,
  rangeKey: "source_range_us" | "timeline_range",
  startKey: string,
  endKey: string,
): { in: number; out: number } | undefined {
  const range = recordValue(declaration[rangeKey]);
  const input = range
    ? { in: finiteNumber(range.in_us ?? range.in_frame), out: finiteNumber(range.out_us ?? range.out_frame) }
    : { in: finiteNumber(declaration[startKey]), out: finiteNumber(declaration[endKey]) };
  if (input.in === undefined && input.out === undefined) return undefined;
  if (input.in === undefined || input.out === undefined || input.in < 0 || input.out <= input.in) {
    throw new AudioRenderPlanError(
      "AUDIO_RENDER_PLAN_INVALID",
      `${rangeKey} must have a non-empty non-negative range.`,
    );
  }
  return { in: input.in, out: input.out };
}

const DEFAULT_MUSIC_MASTER_TOLERANCE = {
  integrated_lufs_db: 0.5,
  lra_lu: 0.5,
  true_peak_dbtp: 0.5,
};

const MUSIC_MASTER_PROCESSING_OPERATIONS: readonly MusicMasterProcessingOperation[] = [
  "stream_copy",
  "trim_reencode",
  "shared_final_mastering",
];

function resolveMusicMasterAudioDecision(
  timeline: TimelineIR,
  declaration: Record<string, unknown>,
): AudioDecision {
  const policy = recordValue(timeline.provenance?.audio_policy);
  const provenance = recordValue(timeline.provenance);
  const rootValues = [policy?.audio_decision ?? policy?.decision, provenance?.audio_decision ?? provenance?.decision]
    .filter((value) => value !== undefined);
  const nestedValue = declaration.audio_decision ?? declaration.decision;
  if (rootValues.length === 0 || nestedValue === undefined) {
    throw new AudioRenderPlanError(
      "AUDIO_RENDER_PLAN_INVALID",
      "music_master requires matching root and nested audio_decision declarations; one is missing.",
    );
  }
  const parse = (value: unknown, label: string): AudioDecision => {
    if (value !== "preserve" && value !== "mastering") {
      throw new AudioRenderPlanError(
        "AUDIO_RENDER_PLAN_INVALID",
        `music_master ${label} audio_decision must be preserve or mastering.`,
      );
    }
    return value;
  };
  const rootDecision = parse(rootValues[0], "root");
  if (rootValues.slice(1).some((value) => parse(value, "root") !== rootDecision)) {
    throw new AudioRenderPlanError(
      "AUDIO_RENDER_PLAN_INVALID",
      "music_master root audio_decision declarations conflict.",
    );
  }
  const nestedDecision = parse(nestedValue, "nested");
  if (nestedDecision !== rootDecision) {
    throw new AudioRenderPlanError(
      "AUDIO_RENDER_PLAN_INVALID",
      "music_master root and nested audio_decision declarations conflict.",
    );
  }
  return rootDecision;
}

function buildMusicMasterAudioPlan(
  projectDir: string,
  timeline: TimelineIR,
  declaration: Record<string, unknown>,
  audioDecision: AudioDecision,
): MusicMasterAudioPlan {
  const source = projectRelativeAudioSource(projectDir, declaration);
  const sourceContentHash = firstString(declaration, ["source_content_hash", "source_hash", "hash"]);
  const hashPattern = /^sha256:[a-f0-9]{64}$/;
  if (!sourceContentHash || !hashPattern.test(sourceContentHash)) {
    throw new AudioRenderPlanError(
      "AUDIO_RENDER_PLAN_INVALID",
      "music_master source_content_hash must be a SHA-256 identity.",
    );
  }
  const sourceSize = finiteNumber(declaration.source_size_bytes);
  if (sourceSize === undefined || !Number.isSafeInteger(sourceSize) || sourceSize < 1) {
    throw new AudioRenderPlanError(
      "AUDIO_RENDER_PLAN_INVALID",
      "music_master source_size_bytes is required for identity binding.",
    );
  }
  const actualSize = fs.statSync(source.path).size;
  const actualHash = hashFile(source.path);
  if (actualSize !== sourceSize || actualHash !== sourceContentHash) {
    throw new AudioRenderPlanError(
      "AUDIO_RENDER_PLAN_INVALID",
      "music_master source identity/hash does not match the declared source.",
    );
  }

  const sourceDuration = finiteNumber(declaration.source_duration_us)
    ?? finiteNumber(declaration.duration_us)
    ?? finiteNumber(recordValue(declaration.source_range_us)?.out_us)
    ?? 0;
  const sourceRange = rangeFromDeclaration(
    declaration,
    "source_range_us",
    "source_start_us",
    "source_end_us",
  ) ?? { in: 0, out: sourceDuration };
  if (sourceDuration <= 0 || sourceRange.out > sourceDuration) {
    throw new AudioRenderPlanError(
      "AUDIO_RENDER_PLAN_INVALID",
      "music_master source_duration_us must cover source_range_us.",
    );
  }

  const fpsNum = timeline.sequence.fps_num;
  const fpsDen = timeline.sequence.fps_den;
  const timelineRange = rangeFromDeclaration(
    declaration,
    "timeline_range",
    "timeline_start_frame",
    "timeline_end_frame",
  ) ?? {
    in: 0,
    out: Math.max(1, Math.round((sourceRange.out - sourceRange.in) * fpsNum / fpsDen / 1_000_000)),
  };
  const gain = finiteNumber(declaration.gain_linear ?? declaration.gain) ?? 1;
  if (gain !== 1) {
    throw new AudioRenderPlanError(
      "AUDIO_RENDER_PLAN_INVALID",
      "music_master audio_decision=preserve requires gain_linear=1.0.",
    );
  }
  const nestedAudioDecision = firstString(declaration, ["audio_decision", "decision"]);
  if (nestedAudioDecision !== audioDecision) {
    throw new AudioRenderPlanError(
      "AUDIO_RENDER_PLAN_INVALID",
      "music_master nested audio_decision is missing or conflicts with the root decision.",
    );
  }
  const audioDecisionValue = audioDecision;
  const channelLayout = firstString(declaration, ["channel_layout", "channels"]) ?? "unknown";
  const inputCodec = firstString(declaration, ["codec", "codec_name"]) ?? "unknown";
  const fullSource = sourceRange.in === 0 && sourceRange.out === sourceDuration;
  const processingOperation: MusicMasterProcessingOperation = audioDecisionValue === "mastering"
    ? "shared_final_mastering"
    : fullSource ? "stream_copy" : "trim_reencode";
  const declaredProcessingGraph = recordValue(declaration.processing_graph);
  if (declaredProcessingGraph) {
    const operations = declaredProcessingGraph.operations;
    if (declaredProcessingGraph.version !== "audio-processing-graph/v1"
      || !Array.isArray(operations)
      || operations.length !== 1
      || typeof operations[0] !== "string"
      || !MUSIC_MASTER_PROCESSING_OPERATIONS.includes(operations[0] as MusicMasterProcessingOperation)
      || operations[0] !== processingOperation) {
      throw new AudioRenderPlanError(
        "AUDIO_RENDER_PLAN_INVALID",
        "music_master processing_graph contains an unknown or non-canonical operation.",
      );
    }
  }
  const codecOperation: "stream_copy" | "reencode" = processingOperation === "stream_copy"
    ? "stream_copy"
    : "reencode";
  const toleranceRecord = recordValue(declaration.measurement_tolerance);
  const measurementTolerance = {
    integrated_lufs_db: finiteNumber(toleranceRecord?.integrated_lufs_db) ?? DEFAULT_MUSIC_MASTER_TOLERANCE.integrated_lufs_db,
    lra_lu: finiteNumber(toleranceRecord?.lra_lu) ?? DEFAULT_MUSIC_MASTER_TOLERANCE.lra_lu,
    true_peak_dbtp: finiteNumber(toleranceRecord?.true_peak_dbtp) ?? DEFAULT_MUSIC_MASTER_TOLERANCE.true_peak_dbtp,
  };
  if (Object.values(measurementTolerance).some((value) => value < 0)) {
    throw new AudioRenderPlanError(
      "AUDIO_RENDER_PLAN_INVALID",
      "music_master measurement tolerances must be non-negative.",
    );
  }
  const sourceDescriptor: MusicMasterAudioSource = {
    role: "music_master",
    asset_id: firstString(declaration, ["asset_id", "source_asset_id"]) ?? "music_master",
    source_ref: source.ref,
    source_content_hash: sourceContentHash,
    source_size_bytes: sourceSize,
    source_duration_us: sourceDuration,
    source_range_us: { in_us: sourceRange.in, out_us: sourceRange.out },
    timeline_range: { in_frame: timelineRange.in, out_frame: timelineRange.out },
    gain_linear: 1,
    channel_layout: channelLayout,
    codec: inputCodec,
  };
  const basePlan = {
    enabled: true as const,
    source: sourceDescriptor,
    audio_decision: audioDecisionValue as AudioDecision,
    input_audio_hash: sourceContentHash,
    ...(audioDecisionValue === "mastering"
      ? { mastering_policy: structuredClone(MUSIC_MASTER_MVP_POLICY) }
      : {}),
    processing_graph: {
      version: "audio-processing-graph/v1" as const,
      operations: [processingOperation],
    },
    codec: {
      input: inputCodec,
      output: codecOperation === "stream_copy" ? inputCodec : "pcm_s24le",
      operation: codecOperation,
    },
    measurement_tolerance: measurementTolerance,
  };
  const policyHash = hashMusicMasterPolicy(basePlan);
  const declaredPolicyHash = firstString(declaration, ["policy_hash"]);
  if (declaredPolicyHash && declaredPolicyHash !== policyHash) {
    throw new AudioRenderPlanError(
      "AUDIO_RENDER_PLAN_INVALID",
      "music_master policy_hash does not match the canonical policy.",
    );
  }
  return { ...basePlan, policy_hash: policyHash };
}

function timelineDurationFrames(timeline: TimelineIR): number {
  const trackGroups = Object.values(
    timeline.tracks as Record<string, Array<{ clips: ClipOutput[] }>>,
  );
  return trackGroups
    .flatMap((tracks) => tracks ?? [])
    .flatMap((track) => track.clips ?? [])
    .reduce(
      (tail, clip) =>
        Math.max(tail, clip.timeline_in_frame + clip.timeline_duration_frames),
      0,
    );
}

function profileSelectionForOptions(
  options: ResolveAudioRenderPlanOptions,
  timeline: TimelineIR,
): AudioDeliveryProfileSelection | undefined {
  const metadata = timeline.metadata as Record<string, unknown> | undefined;
  const provenance = timeline.provenance as Record<string, unknown> | undefined;
  const metadataRef = metadata?.audio_delivery_profile_ref;
  const provenanceRef = provenance?.audio_delivery_profile_ref;
  const metadataRefPath = typeof metadataRef === "string"
    ? metadataRef
    : metadataRef && typeof metadataRef === "object" && !Array.isArray(metadataRef)
      && typeof (metadataRef as Record<string, unknown>).ref === "string"
      ? (metadataRef as Record<string, unknown>).ref as string
      : undefined;
  const provenanceRefPath = typeof provenanceRef === "string"
    ? provenanceRef
    : provenanceRef && typeof provenanceRef === "object" && !Array.isArray(provenanceRef)
      && typeof (provenanceRef as Record<string, unknown>).ref === "string"
      ? (provenanceRef as Record<string, unknown>).ref as string
      : undefined;
  const profileReferenceObjects = [metadataRef, provenanceRef]
    .filter((value): value is Record<string, unknown> =>
      Boolean(value && typeof value === "object" && !Array.isArray(value)),
    );
  const declaredSourceHashes = profileReferenceObjects
    .map((value) => value.source_hash)
    .filter((value): value is string => typeof value === "string" && value.length > 0);
  const declaredProfileHashes = profileReferenceObjects
    .map((value) => value.profile_hash)
    .filter((value): value is string => typeof value === "string" && value.length > 0);
  const configuredPath = options.audioProfilePath
    ?? (typeof options.audioDeliveryProfile === "string" ? options.audioDeliveryProfile : undefined)
    ?? metadataRefPath
    ?? provenanceRefPath;
  const configuredInline = options.audioDeliveryProfile
    && typeof options.audioDeliveryProfile !== "string"
    ? options.audioDeliveryProfile
    : undefined;
  if (!configuredPath && !configuredInline && !options.audioProfileId) return undefined;

  if (configuredInline && !("profile" in configuredInline)) {
    const profile = parseAudioDeliveryProfile(configuredInline);
    const now = options.now ?? new Date();
    const stale = profile.status === "stale"
      || profile.status === "superseded"
      || profile.supersession.state !== "active"
      || Boolean(profile.verification.review_due_at && new Date(profile.verification.review_due_at).getTime() <= now.getTime());
    const loaded: LoadedAudioDeliveryProfile = {
      path: "<inline-audio-delivery-profile>",
      hash: `sha256:${createHash("sha256").update(JSON.stringify(normalized(profile)), "utf8").digest("hex")}`,
      profile,
      warnings: profile.status === "verified" ? [] : [`profile status is ${profile.status}`],
    };
    return stale || profile.status !== "verified"
      ? {
          status: "human_hold",
          profile: loaded,
          reason: stale ? "inline audio profile is stale" : `inline audio profile is ${profile.status}`,
          human_preview_required: true,
          freshness: stale ? "stale" : "unknown",
        }
      : {
          status: "verified",
          profile: loaded,
          reason: "inline audio profile is current",
          human_preview_required: profile.human_preview.required,
          freshness: "current",
        };
  }

  let loaded: LoadedAudioDeliveryProfile | undefined;
  if (configuredPath) {
    const candidatePath = path.isAbsolute(configuredPath)
      ? configuredPath
      : path.resolve(options.audioProfileRootDir ?? options.projectDir, configuredPath);
    loaded = loadAudioDeliveryProfile(candidatePath);
  } else if (configuredInline && "profile" in configuredInline) {
    loaded = configuredInline;
  }
  if (loaded && declaredSourceHashes.some((hash) => hash !== loaded.hash)) {
    throw new AudioDeliveryProfileError(
      "AUDIO_DELIVERY_PROFILE_STALE",
      `${loaded.profile.profile_id} source hash does not match the timeline profile reference`,
    );
  }
  if (loaded && declaredProfileHashes.some((hash) => hash !== audioDeliveryProfileContentHash(loaded.profile))) {
    throw new AudioDeliveryProfileError(
      "AUDIO_DELIVERY_PROFILE_STALE",
      `${loaded.profile.profile_id} profile hash does not match the timeline profile reference`,
    );
  }
  const profile = loaded?.profile;
  const selectionOptions: SelectAudioDeliveryProfileOptions = {
    rootDir: options.audioProfileRootDir ?? options.projectDir,
    platform: options.audioProfilePlatform ?? profile?.platform ?? "",
    surface: options.audioProfileSurface ?? profile?.surface ?? "",
    releaseScope: options.audioProfileReleaseScope ?? profile?.release_scope ?? "internal",
    ...(options.audioProfileVariant || profile?.delivery_variant
      ? { deliveryVariant: options.audioProfileVariant ?? profile?.delivery_variant }
      : {}),
    ...(options.audioProfileId ? { profileId: options.audioProfileId } : {}),
    ...(loaded?.path && !loaded.path.startsWith("<") ? { profilePath: loaded.path } : {}),
    ...(options.now ? { now: options.now } : {}),
  };
  return selectAudioDeliveryProfile(selectionOptions);
}

function sourceHashes(
  dialogueClips: AudioRenderSourceClip[],
  cues: AudioRenderCue[],
  sfxCues: AudioRenderSfxCue[],
): AudioRenderPolicySourceHashes {
  return {
    A1: dialogueClips.map((clip) => ({
      clip_id: clip.clip_id,
      content_hash: clip.source_content_hash,
      size_bytes: clip.source_size_bytes,
    })),
    A2: cues.map((cue) => ({
      cue_id: cue.cue_id,
      content_hash: cue.pins.full_mix_content_hash,
      size_bytes: cue.pins.full_mix_size_bytes,
    })),
    A3: sfxCues.map((cue) => ({
      cue_id: cue.cue_id,
      content_hash: cue.pins.asset_content_hash,
      size_bytes: cue.pins.asset_size_bytes,
    })),
  };
}

function buildSceneAudioRenderPolicy(input: {
  policyMode: "ducking" | "bgm_only" | "original_only" | "music_master";
  dialogueClips: AudioRenderSourceClip[];
  timelineA2Clips: ClipOutput[];
  timelineA3Clips: ClipOutput[];
  ambientClips: AudioRenderAmbientClip[];
  musicCuesPath?: string;
  musicEnabled: boolean;
  cues: AudioRenderCue[];
  sfxCuesPath?: string;
  resolvedSfx?: ResolvedSfxCuePlan;
  sfxHoldReason?: string;
  sfxCues: AudioRenderSfxCue[];
  masteringCount: 0 | 1;
}): SceneAudioRenderPolicy {
  const bgmRequested = Boolean(input.musicCuesPath || input.musicEnabled || input.timelineA2Clips.length > 0);
  const bgmConflict = input.cues.some((cue) => input.dialogueClips.some((dialogue) => {
    const start = Math.max(cue.timeline_range.in_frame, dialogue.timeline_range.in_frame);
    const end = Math.min(cue.timeline_range.out_frame, dialogue.timeline_range.out_frame);
    return end > start;
  }));
  const bgmDenied = input.policyMode === "original_only";
  const bgmConflictOutcome: SceneAudioRenderPolicy["bgm"]["conflict_outcome"] = !bgmRequested
    ? "not_requested"
    : bgmDenied
      ? "denied"
      : input.musicEnabled
        ? bgmConflict ? "ducked" : "allowed"
        : input.timelineA2Clips.length > 0
          ? "denied"
          : "silenced";

  const formalA3Clips = input.timelineA3Clips.filter((clip) => !isAuthoredAmbientClip(clip));
  const sfxRequested = Boolean(
    input.sfxCuesPath
    || input.resolvedSfx
    || input.sfxHoldReason
    || formalA3Clips.length > 0,
  );
  const unsupportedFormalA3 = formalA3Clips.length > 0
    && (!input.resolvedSfx || input.sfxHoldReason !== undefined);
  const sfxDenied = input.policyMode === "original_only"
    || unsupportedFormalA3
    || input.sfxHoldReason !== undefined;
  const sfxOutcome: SceneAudioRenderPolicy["sfx"]["outcome"] = !sfxRequested
    ? "not_requested"
    : sfxDenied
      ? (unsupportedFormalA3 || input.sfxHoldReason !== undefined) ? "human_hold" : "denied"
      : input.sfxCues.length > 0
        ? "allowed"
        : "silenced";

  return {
    version: "scene-audio-render-policy/v1",
    lane_semantics: {
      A1: "dialogue_and_natural_sound",
      A2: "music_bgm",
      A3: "texture_ambient_and_sfx",
    },
    dialogue: {
      authority: "A1",
      conflict_policy: "dialogue_first",
      outcome: input.dialogueClips.length > 0 ? "active" : "silenced",
      timing_owner: "timeline",
    },
    bgm: {
      authority: "A2",
      requested: bgmRequested,
      conflict_outcome: bgmConflictOutcome,
      permission: bgmConflictOutcome === "allowed" || bgmConflictOutcome === "ducked"
        ? "allowed"
        : bgmRequested ? "denied" : "not_requested",
      reason: bgmDenied
        ? "original_only preserves source audio and denies separate A2 rendering"
        : bgmConflict
          ? "dialogue_first sidechain ducking is applied without moving cue frames"
          : bgmRequested ? "A2 is permitted without dialogue overlap" : "no formal A2 cue requested",
    },
    sfx: {
      authority: "A3",
      requested: sfxRequested,
      permission: sfxOutcome === "allowed"
        ? "allowed"
        : sfxOutcome === "human_hold"
          ? "human_hold"
          : sfxRequested ? "denied" : "not_requested",
      outcome: sfxOutcome,
      reason: input.policyMode === "original_only"
        ? "original_only denies formal A3 rendering"
        : input.sfxHoldReason
          ? "HOLD: formal A3 SFX was not selected: " + input.sfxHoldReason
          : unsupportedFormalA3
            ? "HOLD: formal A3 SFX requires a rights-pinned sfx-cues/v1 artifact"
            : input.sfxCues.length > 0
              ? "A3 cue permission and provenance were resolved before rendering"
              : "no permitted A3 cue was requested",
    },
    ambient: {
      authority: "A3",
      requested: input.ambientClips.length > 0,
      permission: input.ambientClips.length > 0 ? "human_hold" : "not_requested",
      outcome: input.ambientClips.length > 0 ? "human_hold" : "not_requested",
      clips: input.ambientClips.map((clip) => ({
        clip_id: clip.clip_id,
        asset_id: clip.asset_id,
        source_content_hash: clip.source_content_hash,
        timeline_range: clip.timeline_range,
      })),
      reason: input.ambientClips.length > 0
        ? "HOLD: authored A3 ambience is retained as a hashed timed stem; the formal rights-pinned SFX executor does not support it"
        : "no authored A3 ambience was requested",
    },
    silence_and_degrade: {
      dialogue: input.dialogueClips.length > 0 ? "not_needed" : "preserve_timeline_silence",
      optional_tools: "fail_open",
      missing_profile: "human_hold",
    },
    timing: {
      picture_timing_immutable: true,
      dialogue_timing_immutable: true,
      caption_timing_immutable: true,
      audio_displacement_frames: 0,
      cue_timing_source: "timeline",
    },
    source_hashes: sourceHashes(input.dialogueClips, input.cues, input.sfxCues),
    single_mastering: {
      owner: "shared_audio_render_plan",
      stage: input.masteringCount === 1 ? "after_mix" : "not_applied",
      count: input.masteringCount,
      route_normalization: "none_outside_final_mastering",
    },
  };
}

function buildAudioMeasurementRequirements(humanRequired: boolean): AudioMeasurementRequirements {
  return {
    encoded_result_required: true,
    measurement_stage: "encoded_deliverable",
    loudness: {
      integrated_lufs: "measure",
      short_term_lufs: "measure_if_supported",
      lra: "measure_if_supported",
      true_peak_dbtp: "measure",
    },
    format: {
      container: "ffprobe",
      codec: "ffprobe",
      sample_rate_hz: "ffprobe",
      channels: "ffprobe",
    },
    duration_and_sync: {
      duration: "measure",
      av_sync: "measure_when_video_present",
      timing_displacement_allowed_frames: 0,
    },
    playback: {
      mono_fold_down: "machine_fixture_or_hold",
      mobile: "human_audition",
    },
    human_audition: {
      required: humanRequired,
      status: "pending",
      automated_quality_claim: "not_allowed",
    },
  };
}

function resolveProductionTrack(
  musicCues: MusicCuesDoc,
  registryOptions?: PackRegistryOptions,
): AudioRenderResolvedTrack {
  const asset = musicCues.music_asset;
  if (!asset.track_id || !asset.full_mix_content_hash) {
    throw new AudioRenderPlanError(
      "AUDIO_RENDER_PLAN_INVALID",
      "music_cues/v2 requires track_id and full_mix_content_hash.",
    );
  }
  const resolved: ResolvedPinnedBgmTrack = resolveExplicitBgmTrack(
    asset.track_id,
    asset.full_mix_content_hash,
    registryOptions,
  );
  if (!resolved.full_mix_path) {
    throw new AudioRenderPlanError(
      "AUDIO_RENDER_SOURCE_MISSING",
      `verified Pack full mix path is unavailable for ${resolved.track_id}.`,
    );
  }
  return {
    track_id: resolved.track_id,
    pack_id: resolved.pack_id,
    pack_version: resolved.pack_version,
    pack_manifest_hash: resolved.manifest_hash,
    full_mix_path: resolved.full_mix_path,
    full_mix_content_hash: resolved.full_mix_ref.content_hash,
    full_mix_size_bytes: resolved.full_mix_ref.size_bytes,
    analysis_content_hash: resolved.analysis_ref.content_hash,
    analysis_size_bytes: resolved.analysis_ref.size_bytes,
    analysis_status: resolved.analysis.status ?? "unavailable",
    duration_us: resolved.duration_us,
  };
}

function mismatch(label: string, expected: unknown, actual: unknown): never {
  throw new AudioRenderPlanError(
    "AUDIO_RENDER_PACK_DRIFT",
    `${label} expected=${String(expected)} actual=${String(actual)}`,
  );
}

function assertMusicAssetPins(
  doc: MusicCuesDoc,
  resolved: AudioRenderResolvedTrack,
): void {
  const asset = doc.music_asset;
  const checks: Array<[string, unknown, unknown]> = [
    ["track_id", asset.track_id, resolved.track_id],
    ["pack_id", asset.pack_id, resolved.pack_id],
    ["pack_version", asset.pack_version, resolved.pack_version],
    ["pack_manifest_hash", asset.pack_manifest_hash, resolved.pack_manifest_hash],
    ["full_mix_content_hash", asset.full_mix_content_hash, resolved.full_mix_content_hash],
    ["full_mix_size_bytes", asset.full_mix_size_bytes, resolved.full_mix_size_bytes],
    ["analysis_content_hash", asset.analysis_content_hash, resolved.analysis_content_hash],
    ["analysis_size_bytes", asset.analysis_size_bytes, resolved.analysis_size_bytes],
  ];
  for (const [label, expected, actual] of checks) {
    if (expected !== actual) mismatch(label, expected, actual);
  }
  if (asset.analysis_status && asset.analysis_status !== resolved.analysis_status) {
    mismatch("analysis_status", asset.analysis_status, resolved.analysis_status);
  }
  const fullMixPath = requiredFile(resolved.full_mix_path, "verified Pack full mix");
  const actualHash = hashFile(fullMixPath);
  const actualSize = fs.statSync(fullMixPath).size;
  if (actualHash !== resolved.full_mix_content_hash) {
    mismatch("full_mix file hash", resolved.full_mix_content_hash, actualHash);
  }
  if (actualSize !== resolved.full_mix_size_bytes) {
    mismatch("full_mix file size", resolved.full_mix_size_bytes, actualSize);
  }
}

function cueIdFromTimelineClip(clip: ClipOutput): string | undefined {
  const cue = (clip.metadata as Record<string, unknown> | undefined)?.music_cue;
  return cue && typeof cue === "object" && !Array.isArray(cue)
    && typeof (cue as Record<string, unknown>).cue_id === "string"
    ? (cue as Record<string, unknown>).cue_id as string
    : undefined;
}

function sfxCueIdFromTimelineClip(clip: ClipOutput): string | undefined {
  const cue = (clip.metadata as Record<string, unknown> | undefined)?.sfx_cue;
  return cue && typeof cue === "object" && !Array.isArray(cue)
    && typeof (cue as Record<string, unknown>).cue_id === "string"
    ? (cue as Record<string, unknown>).cue_id as string
    : undefined;
}

function isAuthoredAmbientClip(clip: ClipOutput): boolean {
  const metadata = clip.metadata as Record<string, unknown> | undefined;
  const hasFormalSfxPin = Boolean(
    metadata?.sfx_cue
    || metadata?.sfx_asset
    || clip.audio_role === "sfx"
    || clip.role === "sfx",
  );
  if (hasFormalSfxPin) return false;
  return clip.role === "ambient"
    || clip.audio_role === "ambient"
    || metadata?.audio_semantic_role === "ambient"
    || metadata?.authored_ambient === true;
}

function resolveA3AmbientSource(
  projectDir: string,
  clip: ClipOutput,
  overrides: Record<string, string> | undefined,
  sourceMap: ReturnType<typeof loadSourceMap> | undefined,
): string {
  const explicit = overrides?.[clip.asset_id];
  const mapped = sourceMap?.entryMap.get(clip.asset_id)?.source_locator;
  const metadata = clip.metadata as Record<string, unknown> | undefined;
  const hinted = ["source_path", "source_locator", "local_source_path"]
    .map((key) => metadata?.[key])
    .find((value): value is string => typeof value === "string" && value.trim().length > 0);
  const candidate = explicit ?? mapped ?? hinted;
  if (!candidate) {
    throw new AudioRenderPlanError(
      "AUDIO_RENDER_SOURCE_MISSING",
      `authored A3 ambient clip ${clip.clip_id} has no source for asset ${clip.asset_id}.`,
    );
  }
  return requiredFile(
    path.isAbsolute(candidate) ? candidate : path.resolve(projectDir, candidate),
    `authored A3 ambient clip ${clip.clip_id}`,
  );
}

function resolveAmbientClips(
  projectDir: string,
  timeline: TimelineIR,
  sourceOverrides?: Record<string, string>,
): AudioRenderAmbientClip[] {
  const clips = timeline.tracks.audio
    .filter((track) => track.track_id === "A3")
    .flatMap((track) => track.clips)
    .filter(isAuthoredAmbientClip)
    .sort((left, right) => left.timeline_in_frame - right.timeline_in_frame || left.clip_id.localeCompare(right.clip_id, "en"));
  const needsSourceMap = clips.some((clip) => !sourceOverrides?.[clip.asset_id]);
  const sourceMap = needsSourceMap ? loadSourceMap(projectDir) : undefined;
  return clips.map((clip) => {
    const sourcePath = resolveA3AmbientSource(projectDir, clip, sourceOverrides, sourceMap);
    const gain = resolveAudioGainWithFallback(
      clip.audio_policy,
      timeline.audio_mix as AudioMix | undefined,
      "nat",
    ).gainLinear;
    return {
      track_id: "A3" as const,
      clip_id: clip.clip_id,
      asset_id: clip.asset_id,
      role: "ambient" as const,
      source_path: sourcePath,
      source_content_hash: hashFile(sourcePath),
      source_size_bytes: fs.statSync(sourcePath).size,
      source_range_us: { in_us: clip.src_in_us, out_us: clip.src_out_us },
      timeline_range: {
        in_frame: clip.timeline_in_frame,
        out_frame: clip.timeline_in_frame + clip.timeline_duration_frames,
      },
      gain_linear: gain,
    };
  });
}

function assertTimelineSfxCueMatches(
  cue: ResolvedSfxCue,
  timelineClip: ClipOutput | undefined,
  plan: ResolvedSfxCuePlan,
): void {
  if (!timelineClip) {
    throw new AudioRenderPlanError(
      "AUDIO_RENDER_PLAN_INVALID",
      `A3 projection for SFX cue ${cue.cue_id} is missing.`,
    );
  }
  const checks: Array<[string, unknown, unknown]> = [
    ["role", "sfx", timelineClip.role],
    ["asset_id", cue.asset_id, timelineClip.asset_id],
    ["timeline_in_frame", cue.timeline_range.in_frame, timelineClip.timeline_in_frame],
    [
      "timeline_duration_frames",
      cue.timeline_range.out_frame - cue.timeline_range.in_frame,
      timelineClip.timeline_duration_frames,
    ],
    ["src_in_us", cue.source_range_us.in_us, timelineClip.src_in_us],
    ["src_out_us", cue.source_range_us.out_us, timelineClip.src_out_us],
  ];
  for (const [label, expected, actual] of checks) {
    if (expected !== actual) {
      throw new AudioRenderPlanError(
        "AUDIO_RENDER_PLAN_INVALID",
        `A3 SFX cue ${cue.cue_id} ${label} expected=${String(expected)} actual=${String(actual)}`,
      );
    }
  }
  const metadata = timelineClip.metadata as Record<string, unknown> | undefined;
  const asset = metadata?.sfx_asset;
  if (!asset || typeof asset !== "object" || Array.isArray(asset)) {
    throw new AudioRenderPlanError(
      "AUDIO_RENDER_PLAN_INVALID",
      `A3 SFX cue ${cue.cue_id} has no sfx_asset pin metadata.`,
    );
  }
  const pins = asset as Record<string, unknown>;
  for (const [label, expected] of [
    ["library_id", plan.library.library_id],
    ["library_version", plan.library.library_version],
    ["library_manifest_hash", plan.library.manifest_hash],
    ["library_scope", plan.library.scope],
    ["asset_content_hash", cue.asset_pin.asset_content_hash],
    ["asset_size_bytes", cue.asset_pin.asset_size_bytes],
    ["rights_evidence_ref", cue.asset_pin.rights_evidence_ref],
    ["provenance_ref", cue.asset_pin.provenance_ref],
    ["asset_path", cue.asset_pin.asset_path],
    ["rights_status", cue.asset_pin.rights_status],
    ["provenance_status", cue.asset_pin.provenance_status],
    ["review_status", cue.asset_pin.review_status],
    ["rights_expires_at", cue.asset_pin.rights_expires_at],
    ["permitted_derivatives", cue.asset_pin.permitted_derivatives],
  ] as Array<[string, unknown]>) {
    if (expected === undefined) continue;
    const equal = Array.isArray(expected)
      ? JSON.stringify(pins[label]) === JSON.stringify(expected)
      : pins[label] === expected;
    if (!equal) {
      mismatch(`A3 ${cue.cue_id} ${label}`, expected, pins[label]);
    }
  }
  if (cue.decision_pin) {
    const cueMetadata = metadata?.sfx_cue;
    const projectedPin = cueMetadata
      && typeof cueMetadata === "object"
      && !Array.isArray(cueMetadata)
      ? (cueMetadata as Record<string, unknown>).decision_pin
      : undefined;
    if (
      !projectedPin
      || JSON.stringify(projectedPin) !== JSON.stringify(cue.decision_pin)
    ) {
      mismatch(
        `A3 ${cue.cue_id} decision_pin`,
        JSON.stringify(cue.decision_pin),
        JSON.stringify(projectedPin),
      );
    }
  }
}

function overlapFrames(
  target: { in_frame: number; out_frame: number },
  dialogueClips: AudioRenderSourceClip[],
): number {
  return dialogueClips.reduce((total, clip) => {
    const start = Math.max(target.in_frame, clip.timeline_range.in_frame);
    const end = Math.min(target.out_frame, clip.timeline_range.out_frame);
    return total + Math.max(0, end - start);
  }, 0);
}

function assertTimelineCueMatches(
  cue: MusicCueV2,
  timelineClip: ClipOutput | undefined,
  musicCues: MusicCuesDoc,
): void {
  if (!timelineClip) {
    throw new AudioRenderPlanError(
      "AUDIO_RENDER_PLAN_INVALID",
      `A2 projection for cue ${cue.cue_id} is missing.`,
    );
  }
  const expectedDuration =
    cue.timeline_range.out_frame - cue.timeline_range.in_frame;
  const checks: Array<[string, unknown, unknown]> = [
    ["asset_id", musicCues.music_asset.asset_id, timelineClip.asset_id],
    ["timeline_in_frame", cue.timeline_range.in_frame, timelineClip.timeline_in_frame],
    ["timeline_duration_frames", expectedDuration, timelineClip.timeline_duration_frames],
    ["src_in_us", cue.source_range.in_us, timelineClip.src_in_us],
    ["src_out_us", cue.source_range.out_us, timelineClip.src_out_us],
  ];
  for (const [label, expected, actual] of checks) {
    if (expected !== actual) {
      throw new AudioRenderPlanError(
        "AUDIO_RENDER_PLAN_INVALID",
        `A2 cue ${cue.cue_id} ${label} expected=${String(expected)} actual=${String(actual)}`,
      );
    }
  }
  const assetMeta =
    (timelineClip.metadata as Record<string, unknown> | undefined)?.music_asset;
  if (!assetMeta || typeof assetMeta !== "object" || Array.isArray(assetMeta)) {
    throw new AudioRenderPlanError(
      "AUDIO_RENDER_PLAN_INVALID",
      `A2 cue ${cue.cue_id} has no music_asset pin metadata.`,
    );
  }
  const pins = assetMeta as Record<string, unknown>;
  for (const [label, expected] of [
    ["pack_id", musicCues.music_asset.pack_id],
    ["pack_version", musicCues.music_asset.pack_version],
    ["pack_manifest_hash", musicCues.music_asset.pack_manifest_hash],
    ["full_mix_content_hash", musicCues.music_asset.full_mix_content_hash],
    ["analysis_content_hash", musicCues.music_asset.analysis_content_hash],
  ] as Array<[string, unknown]>) {
    if (pins[label] !== expected) {
      mismatch(`A2 ${cue.cue_id} ${label}`, expected, pins[label]);
    }
  }
}

function resolveDialogueClips(
  projectDir: string,
  timeline: TimelineIR,
  sourceOverrides?: Record<string, string>,
): AudioRenderSourceClip[] {
  const a1Tracks = timeline.tracks.audio.filter((track) => track.track_id === "A1");
  const needsSourceMap = a1Tracks.some((track) =>
    track.clips.some((clip) => !sourceOverrides?.[clip.asset_id])
  );
  const sourceMap = needsSourceMap ? loadSourceMap(projectDir) : undefined;
  return a1Tracks
    .flatMap((track) => track.clips)
    .sort((left, right) =>
      left.timeline_in_frame - right.timeline_in_frame
      || left.clip_id.localeCompare(right.clip_id, "en")
    )
    .map((clip) => {
      const sourcePath = resolveA1Source(
        projectDir,
        clip,
        sourceOverrides,
        sourceMap,
      );
      const gainRole = clip.role === "nat_sound" ? "nat_sound" : "nat";
      const gain = resolveAudioGainWithFallback(
        clip.audio_policy,
        timeline.audio_mix as AudioMix | undefined,
        gainRole,
      ).gainLinear;
      return {
        track_id: "A1" as const,
        clip_id: clip.clip_id,
        asset_id: clip.asset_id,
        role: clip.role === "nat_sound"
          ? "nat_sound" as const
          : "dialogue" as const,
        source_path: sourcePath,
        source_content_hash: hashFile(sourcePath),
        source_size_bytes: fs.statSync(sourcePath).size,
        source_range_us: { in_us: clip.src_in_us, out_us: clip.src_out_us },
        timeline_range: {
          in_frame: clip.timeline_in_frame,
          out_frame:
            clip.timeline_in_frame + clip.timeline_duration_frames,
        },
        gain_linear: gain,
      };
  });
}

function assertCompiledA1ProjectionFresh(
  timeline: TimelineIR,
  dialogueClips: AudioRenderSourceClip[],
): void {
  const projection = timeline.provenance?.audio_render_projection
    ?? (timeline.metadata as Record<string, unknown> | undefined)?.audio_render_projection;
  if (!projection || typeof projection !== "object" || Array.isArray(projection)) return;
  const refs = (projection as { source_refs?: unknown }).source_refs;
  if (!Array.isArray(refs)) return;

  const byClipId = new Map(dialogueClips.map((clip) => [clip.clip_id, clip]));
  const byAssetId = new Map<string, AudioRenderSourceClip[]>();
  for (const clip of dialogueClips) {
    const existing = byAssetId.get(clip.asset_id) ?? [];
    existing.push(clip);
    byAssetId.set(clip.asset_id, existing);
  }
  for (const value of refs) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const ref = value as Record<string, unknown>;
    if (ref.track_id !== "A1" || typeof ref.source_content_hash !== "string") continue;
    const clipId = typeof ref.clip_id === "string" ? ref.clip_id : undefined;
    const assetId = typeof ref.asset_id === "string" ? ref.asset_id : undefined;
    const clipMatch = clipId ? byClipId.get(clipId) : undefined;
    const matches = clipMatch
      ? [clipMatch]
      : (assetId ? byAssetId.get(assetId) ?? [] : []);
    if (matches.length === 0 || matches.some((clip) => clip.source_content_hash !== ref.source_content_hash)) {
      throw new AudioRenderPlanError(
        "AUDIO_RENDER_PLAN_STALE",
        `compiled A1 projection hash is stale for clip=${String(ref.clip_id)} asset=${String(ref.asset_id)} expected=${String(ref.source_content_hash)} actual=${matches.map((clip) => clip.source_content_hash).join(",") || "missing"}`,
      );
    }
  }
}

export function resolveAudioRenderPlan(
  options: ResolveAudioRenderPlanOptions,
): AudioRenderPlan {
  const projectDir = path.resolve(options.projectDir);
  const timelinePath = requiredFile(options.timelinePath, "timeline");
  const timeline = readJson<TimelineIR>(timelinePath);
  if (
    !timeline.project_id
    || !timeline.sequence?.fps_num
    || !timeline.sequence?.fps_den
  ) {
    throw new AudioRenderPlanError(
      "AUDIO_RENDER_PLAN_INVALID",
      "timeline project_id and rational fps are required.",
    );
  }
  const musicMasterDeclaration = readMusicMasterDeclaration(timeline);
  const musicMasterAudioDecision = musicMasterDeclaration
    ? resolveMusicMasterAudioDecision(timeline, musicMasterDeclaration)
    : undefined;
  const profileSelection = profileSelectionForOptions(options, timeline);
  assertMusicMasterProfilePriority(profileSelection, musicMasterAudioDecision);
  const dialogueClips = resolveDialogueClips(
    projectDir,
    timeline,
    options.sourceOverrides,
  );
  assertCompiledA1ProjectionFresh(timeline, dialogueClips);
  const ambientClips = resolveAmbientClips(
    projectDir,
    timeline,
    options.sourceOverrides,
  );
  const finishPolicy = resolveAudioFinishPolicy(timeline.metadata?.audio_finish);
  const policyMode = audioPolicyMode(timeline);
  const timelineA2Clips = timeline.tracks.audio
    .filter((track) => track.track_id === "A2")
    .flatMap((track) => track.clips);
  const timelineA3Clips = timeline.tracks.audio
    .filter((track) => track.track_id === "A3")
    .flatMap((track) => track.clips);
  if (policyMode === "music_master" && !musicMasterDeclaration) {
    throw new AudioRenderPlanError(
      "AUDIO_RENDER_PLAN_INVALID",
      "music_master mode requires an explicit music_master source declaration.",
    );
  }
  if (policyMode !== "music_master" && musicMasterDeclaration) {
    throw new AudioRenderPlanError(
      "AUDIO_RENDER_PLAN_INVALID",
      "music_master source declarations require audio_policy.mode=music_master; no fallback is allowed.",
    );
  }
  const musicMaster = musicMasterDeclaration
    ? buildMusicMasterAudioPlan(projectDir, timeline, musicMasterDeclaration, musicMasterAudioDecision!)
    : undefined;
  if (musicMaster?.audio_decision === "preserve" && options.masteringDefaults) {
    throw new AudioRenderPlanError(
      "AUDIO_RENDER_PLAN_INVALID",
      "music_master preserve cannot be combined with an explicit mastering request.",
    );
  }
  if (musicMaster?.audio_decision === "mastering" && options.masteringDefaults) {
    const fixedMastering = {
      loudness_target_lufs: MUSIC_MASTER_MVP_POLICY.loudnorm.target_lufs,
      lra_target: MUSIC_MASTER_MVP_POLICY.loudnorm.lra_target,
      true_peak_target_dbtp: MUSIC_MASTER_MVP_POLICY.loudnorm.acceptance_true_peak_dbtp,
    };
    if (JSON.stringify(options.masteringDefaults) !== JSON.stringify(fixedMastering)) {
      throw new AudioRenderPlanError(
        "AUDIO_RENDER_PLAN_INVALID",
        "music_master mastering uses the fixed Issue #38 policy; masteringDefaults overrides are rejected.",
      );
    }
  }
  if (musicMaster && (
    dialogueClips.length > 0
    || timelineA2Clips.length > 0
    || timelineA3Clips.length > 0
    || ambientClips.length > 0
    || finishPolicy
    || options.musicCuesPath
    || options.sfxCuesPath
  )) {
    throw new AudioRenderPlanError(
      "AUDIO_RENDER_PLAN_INVALID",
      "music_master is an independent source and cannot be mixed with A1/A2/A3 or dialogue finishing.",
    );
  }
  const musicCuesPath =
    options.musicCuesPath && fs.existsSync(options.musicCuesPath)
      ? path.resolve(options.musicCuesPath)
      : undefined;
  const musicCues = musicCuesPath
    ? readJson<MusicCuesDoc>(musicCuesPath)
    : undefined;
  const explicitV2 = musicCues?.version === "2.0.0";
  const sfxCuesPath =
    options.sfxCuesPath && fs.existsSync(options.sfxCuesPath)
      ? path.resolve(options.sfxCuesPath)
      : undefined;
  let resolvedSfx: ResolvedSfxCuePlan | undefined;
  let sfxHoldReason: string | undefined;
  if (sfxCuesPath && policyMode !== "original_only" && policyMode !== "music_master") {
    try {
      resolvedSfx = resolveSfxCuePlan({
        projectDir,
        ...(options.repoSfxRoot ? { repoSfxRoot: options.repoSfxRoot } : {}),
        timeline,
        cuesPath: sfxCuesPath,
      });
    } catch (error) {
      if (
        error instanceof SfxCueContractError
        && (
          error.code === "SFX_RIGHTS_HOLD"
          || error.code === "SFX_ASSET_MISSING"
          || error.code === "SFX_LIBRARY_MISSING"
        )
      ) {
        sfxHoldReason = error.message;
      } else {
        throw error;
      }
    }
  }
  const warnings: string[] = [];
  const formalA3Clips = timelineA3Clips.filter((clip) => !isAuthoredAmbientClip(clip));
  if (ambientClips.length > 0) {
    warnings.push(
      "HOLD: authored A3 ambience is preserved as a hashed timed stem but is unsupported by the formal rights-pinned SFX executor.",
    );
  }
  if (formalA3Clips.length > 0 && !resolvedSfx && policyMode !== "original_only") {
    warnings.push(
      sfxHoldReason
        ? "HOLD: formal A3 SFX was not rendered: " + sfxHoldReason
        : "HOLD: formal A3 SFX was not rendered because a rights-pinned sfx-cues/v1 artifact is missing.",
    );
  }
  if (sfxHoldReason && formalA3Clips.length === 0) {
    warnings.push("HOLD: formal SFX selection was not rendered: " + sfxHoldReason);
  }

  let strategy: AudioRenderStrategy;
  let finishScope: DialogueFinishScope;
  let musicEnabled = false;
  let cues: AudioRenderCue[] = [];
  let sfxCues: AudioRenderSfxCue[] = [];
  if (policyMode === "music_master" && musicMaster) {
    strategy = "music_master";
    finishScope = "none";
  } else if (policyMode === "original_only") {
    strategy = "original_passthrough";
    finishScope = "none_original_passthrough";
    if (timelineA2Clips.length > 0 || musicCues || timelineA3Clips.some(sfxCueIdFromTimelineClip) || sfxCuesPath) {
      warnings.push(
        "original_only disables formal A2/A3 rendering until an explicit project copy changes the audio policy.",
      );
    }
  } else if (explicitV2 && musicCues) {
    const validation = validateMusicCues(musicCues);
    if (!validation.valid) {
      throw new AudioRenderPlanError(
        "AUDIO_RENDER_PLAN_INVALID",
        validation.errors.join("; "),
      );
    }
    if (musicCues.project_id !== timeline.project_id) {
      throw new AudioRenderPlanError(
        "AUDIO_RENDER_PLAN_INVALID",
        "music_cues project_id does not match timeline project_id.",
      );
    }
    if (musicCues.base_timeline_version !== timeline.version) {
      throw new AudioRenderPlanError(
        "AUDIO_RENDER_PLAN_INVALID",
        "music_cues base_timeline_version is stale.",
      );
    }
    if (
      musicCues.timeline_fps?.num !== timeline.sequence.fps_num
      || musicCues.timeline_fps?.den !== timeline.sequence.fps_den
    ) {
      throw new AudioRenderPlanError(
        "AUDIO_RENDER_PLAN_INVALID",
        "music_cues rational fps does not match timeline.",
      );
    }
    const resolved = (options.resolveTrackImpl ?? resolveProductionTrack)(
      musicCues,
      options.packRegistryOptions,
    );
    assertMusicAssetPins(musicCues, resolved);
    const byCueId = new Map(
      timelineA2Clips.map((clip) => [cueIdFromTimelineClip(clip), clip]),
    );
    cues = (musicCues.cues as MusicCueV2[])
      .map((cue) => {
        assertTimelineCueMatches(cue, byCueId.get(cue.cue_id), musicCues);
        if (cue.source_range.out_us > resolved.duration_us) {
          throw new AudioRenderPlanError(
            "AUDIO_RENDER_PLAN_INVALID",
            `cue ${cue.cue_id} exceeds verified source duration.`,
          );
        }
        return {
          cue_id: cue.cue_id,
          track_id: cue.track_id,
          source_path: path.resolve(resolved.full_mix_path),
          source_range_us: { ...cue.source_range },
          timeline_range: { ...cue.timeline_range },
          semantic_anchor: { ...cue.semantic_anchor },
          section: cue.section,
          phase: cue.phase,
          applied: {
            base_gain_db: cue.ducking.base_gain_db,
            duck_gain_db: cue.ducking.duck_gain_db,
            fade_in_ms: cue.fade_in_ms,
            fade_out_ms: cue.fade_out_ms,
            attack_ms: cue.ducking.attack_ms,
            release_ms: cue.ducking.release_ms,
          },
          pins: {
            pack_id: resolved.pack_id,
            pack_version: resolved.pack_version,
            pack_manifest_hash: resolved.pack_manifest_hash,
            full_mix_content_hash: resolved.full_mix_content_hash,
            full_mix_size_bytes: resolved.full_mix_size_bytes,
            analysis_content_hash: resolved.analysis_content_hash,
            analysis_size_bytes: resolved.analysis_size_bytes,
            analysis_status: resolved.analysis_status,
          },
        };
      })
      .sort((left, right) =>
        left.timeline_range.in_frame - right.timeline_range.in_frame
        || left.cue_id.localeCompare(right.cue_id, "en")
      );
    strategy = "explicit_music_cues_v2";
    finishScope = finishPolicy ? "a1_only" : "none";
    musicEnabled = true;
    warnings.push(...(musicCues.warnings ?? []));
  } else if (timelineA2Clips.length > 0 || musicCues) {
    strategy = "legacy_embedded_bgm";
    finishScope = "none_mixed_legacy";
    warnings.push(
      "Legacy embedded BGM remains on the compatibility path and may not be passed through dialogue finishing.",
    );
  } else {
    strategy = "dialogue_only";
    finishScope = finishPolicy ? "a1_only" : "none";
  }

  if (resolvedSfx) {
    if (strategy === "legacy_embedded_bgm") {
      throw new AudioRenderPlanError(
        "AUDIO_RENDER_PLAN_INVALID",
        "formal A3 SFX cannot share the legacy embedded-BGM compatibility path.",
      );
    }
    const byCueId = new Map(
      timelineA3Clips.map((clip) => [sfxCueIdFromTimelineClip(clip), clip]),
    );
    sfxCues = resolvedSfx.cues.map((cue) => {
      assertTimelineSfxCueMatches(cue, byCueId.get(cue.cue_id), resolvedSfx);
      return {
        cue_id: cue.cue_id,
        semantic_role: cue.semantic_role,
        asset_id: cue.asset_id,
        source_path: cue.source_path,
        source_range_us: { ...cue.source_range_us },
        timeline_range: { ...cue.timeline_range },
        trigger_frame: cue.trigger_frame,
        duration_frames: cue.duration_frames,
        dialogue_overlap_frames: overlapFrames(cue.timeline_range, dialogueClips),
        applied: {
          gain_db: cue.gain_db,
          fade_in_ms: cue.fade_in_ms,
          fade_out_ms: cue.fade_out_ms,
          duck_group: cue.duck_group,
          duck_gain_db: cue.ducking.duck_gain_db,
          attack_ms: cue.ducking.attack_ms,
          release_ms: cue.ducking.release_ms,
        },
        tail_processing: { ...cue.tail_processing },
        pins: {
          ...cue.asset_pin,
          library_id: resolvedSfx.library.library_id,
          library_version: resolvedSfx.library.library_version,
          library_manifest_hash: resolvedSfx.library.manifest_hash,
        },
        intent: cue.intent,
        ...(cue.decision_pin
          ? { decision_pin: structuredClone(cue.decision_pin) }
          : {}),
      };
    });
    strategy = musicEnabled
      ? "explicit_music_and_sfx_cues_v1"
      : "explicit_sfx_cues_v1";
    finishScope = finishPolicy ? "a1_only" : "none";
  }

  const mastering = musicMaster?.audio_decision === "mastering"
    ? {
        loudness_target_lufs: MUSIC_MASTER_MVP_POLICY.loudnorm.target_lufs,
        lra_target: MUSIC_MASTER_MVP_POLICY.loudnorm.lra_target,
        true_peak_target_dbtp: MUSIC_MASTER_MVP_POLICY.loudnorm.acceptance_true_peak_dbtp,
      }
    : options.masteringDefaults ?? DEFAULT_MASTERING;
  const masteringCount = strategy === "original_passthrough" || (strategy === "music_master" && musicMaster?.audio_decision === "preserve")
    ? 0
    : 1;
  const sceneAudioPolicy = buildSceneAudioRenderPolicy({
    policyMode,
    dialogueClips,
    timelineA2Clips,
    timelineA3Clips,
    ambientClips,
    musicCuesPath,
    musicEnabled,
    cues,
    sfxCuesPath,
    resolvedSfx,
    sfxHoldReason,
    sfxCues,
    masteringCount,
  });
  if (musicMaster) {
    sceneAudioPolicy.music_master = {
      authority: "music_master",
      requested: true,
      audio_decision: musicMaster.audio_decision,
      source_content_hash: musicMaster.source.source_content_hash,
      timeline_range: musicMaster.source.timeline_range,
    };
  }
  const audioDeliveryProfile = profileSelection?.profile
    ? {
        profile_id: profileSelection.profile.profile.profile_id,
        profile_version: profileSelection.profile.profile.profile_version,
        platform: profileSelection.profile.profile.platform,
        surface: profileSelection.profile.profile.surface,
        release_scope: profileSelection.profile.profile.release_scope,
        delivery_variant: profileSelection.profile.profile.delivery_variant,
        path: profileSelection.profile.path,
        source_hash: profileSelection.profile.hash,
        profile_hash: audioDeliveryProfileContentHash(profileSelection.profile.profile),
        content_hash: profileSelection.profile.hash,
        selection_status: profileSelection.status,
        freshness: profileSelection.freshness,
        human_preview_required: profileSelection.human_preview_required,
      } satisfies AudioDeliveryProfileRef
    : undefined;
  const plan: AudioRenderPlan = {
    version: "audio-render-plan/v1",
    project_id: timeline.project_id,
    strategy,
    timeline: {
      path: timelinePath,
      version: timeline.version,
      content_hash: hashFile(timelinePath),
      duration_frames: Math.max(
        timelineDurationFrames(timeline),
        musicMaster?.source.timeline_range.out_frame ?? 0,
      ),
      fps: {
        num: timeline.sequence.fps_num,
        den: timeline.sequence.fps_den,
      },
    },
    inputs: {
      ...(musicCuesPath
        ? {
            music_cues_path: musicCuesPath,
            music_cues_content_hash: hashFile(musicCuesPath),
          }
        : {}),
      ...(musicCues?.selection_ref?.content_hash
        ? { selection_content_hash: musicCues.selection_ref.content_hash }
        : {}),
      ...(resolvedSfx
        ? {
            sfx_cues_path: resolvedSfx.cues_path,
            sfx_cues_content_hash: resolvedSfx.cues_content_hash,
            sfx_library_manifest_path: resolvedSfx.library.manifest_path,
            sfx_library_manifest_hash: resolvedSfx.library.manifest_hash,
            ...(resolvedSfx.decision_ref
              ? {
                  sound_design_decision_path:
                    resolvedSfx.decision_ref.resolved_path,
                  sound_design_decision_content_hash:
                    resolvedSfx.decision_ref.content_hash,
                }
              : {}),
          }
        : {}),
      ...(sfxCuesPath && sfxHoldReason
        ? {
            sfx_cues_path: sfxCuesPath,
            sfx_cues_content_hash: hashFile(sfxCuesPath),
          }
        : {}),
    },
    dialogue: {
      source_track_id: "A1",
      clips: dialogueClips,
      finish_scope: finishScope,
      ...(finishScope === "a1_only" && finishPolicy
        ? { finish_policy: finishPolicy }
        : {}),
    },
    music: {
      enabled: musicEnabled,
      source_track_id: "A2",
      cues,
    },
    ...(musicMaster ? { music_master: musicMaster } : {}),
    ...(ambientClips.length > 0
      ? {
          ambient: {
            enabled: false,
            source_track_id: "A3" as const,
            clips: ambientClips,
          },
        }
      : {}),
    ...(resolvedSfx
      ? {
          sfx: {
            enabled: sfxCues.length > 0,
            required: resolvedSfx.required,
            source_track_id: "A3" as const,
            library: {
              library_id: resolvedSfx.library.library_id,
              library_version: resolvedSfx.library.library_version,
              manifest_path: resolvedSfx.library.manifest_path,
              manifest_hash: resolvedSfx.library.manifest_hash,
              ...(resolvedSfx.library.scope
                ? { scope: resolvedSfx.library.scope }
                : {}),
            },
            cues: sfxCues,
          },
        }
      : {}),
    ...(sfxHoldReason
      ? {
          sfx_hold: {
            code: "SFX_SELECTION_HOLD",
            reason: sfxHoldReason,
          },
        }
      : {}),
    final_mastering: {
      ...mastering,
      count: masteringCount,
      stage: masteringCount === 1 ? "after_mix" : "not_applied",
      owner: "shared_audio_render_plan",
    },
    scene_audio_policy: sceneAudioPolicy,
    audio_measurement_requirements: buildAudioMeasurementRequirements(
      profileSelection?.human_preview_required ?? true,
    ),
    ...(audioDeliveryProfile ? { audio_delivery_profile: audioDeliveryProfile } : {}),
    expected_artifacts: {
      dialogue_stem: "raw_dialogue.wav",
      final_mix: "final_mix.wav",
      report: "audio-mix-report.json",
      ...(musicMaster?.audio_decision === "mastering"
        ? { mastered_mp3: "music_master_320.mp3" as const }
        : {}),
    },
    warnings: [...new Set(warnings)],
  };
  if (profileSelection?.status === "human_hold") {
    plan.warnings.push(`audio delivery profile requires human platform audition: ${profileSelection.reason}`);
  }
  assertAudioRenderPlanContract(plan);
  return plan;
}

function assertMusicMasterProfilePriority(
  selection: AudioDeliveryProfileSelection | undefined,
  decision: AudioDecision | undefined,
): void {
  if (decision !== "preserve" || !selection?.profile) return;
  const profile = selection.profile.profile;
  const routeLabel = [profile.profile_id, profile.surface, profile.delivery_variant]
    .join(" ")
    .toLowerCase();
  if (
    routeLabel.includes("sns")
    || routeLabel.includes("social")
    || routeLabel.includes("short")
    || profile.normalization.status !== "not_applied"
  ) {
    throw new AudioDeliveryProfileError(
      "AUDIO_DELIVERY_PROFILE_SCOPE_MISMATCH",
      `${profile.profile_id} would apply a short-social or normalization policy to music_master preserve; select a full-song preserve profile or omit the profile`,
    );
  }
}

export function validateAudioRenderPlanContract(
  plan: AudioRenderPlan,
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  if (plan.dialogue.source_track_id !== "A1") errors.push("dialogue authority must be A1");
  if (plan.music.source_track_id !== "A2") errors.push("music authority must be A2");
  if (plan.sfx && plan.sfx.source_track_id !== "A3") errors.push("SFX authority must be A3");
  if (plan.ambient && plan.ambient.source_track_id !== "A3") errors.push("ambient authority must be A3");
  if (plan.final_mastering.count > 1) errors.push("more than one final mastering pass is forbidden");
  if (plan.strategy === "original_passthrough") {
    if (plan.final_mastering.count !== 0 || plan.final_mastering.stage !== "not_applied") {
      errors.push("original_passthrough must record zero mastering passes and not_applied");
    }
  } else if (
    plan.strategy !== "music_master"
    || plan.music_master?.audio_decision !== "preserve"
  ) {
    if (plan.final_mastering.count !== 1 || plan.final_mastering.stage !== "after_mix") {
    errors.push("every executable non-passthrough strategy must record exactly one after_mix mastering pass");
    }
  }
  if (plan.final_mastering.owner !== undefined && plan.final_mastering.owner !== "shared_audio_render_plan") {
    errors.push("final mastering owner must be shared_audio_render_plan");
  }
  if (plan.strategy === "music_master") {
    const musicMaster = plan.music_master;
    if (!musicMaster) {
      errors.push("music_master strategy requires an explicit music_master plan");
    } else {
      const source = musicMaster.source;
      const hashPattern = /^sha256:[a-f0-9]{64}$/;
      if (musicMaster.enabled !== true || source.role !== "music_master") {
        errors.push("music_master source role and enabled marker are required");
      }
      if (!hashPattern.test(source.source_content_hash) || musicMaster.input_audio_hash !== source.source_content_hash) {
        errors.push("music_master source and input audio hashes must be the same SHA-256 identity");
      }
      if (!isSafeProjectRelativeAudioRef(source.source_ref)) {
        errors.push("music_master source_ref must be a project-relative safe reference");
      }
      if (source.gain_linear !== 1) {
        errors.push("music_master gain_linear must be exactly 1.0");
      }
      if (source.source_range_us.in_us < 0 || source.source_range_us.out_us <= source.source_range_us.in_us
        || source.source_range_us.out_us > source.source_duration_us
        || source.timeline_range.in_frame < 0
        || source.timeline_range.out_frame <= source.timeline_range.in_frame) {
        errors.push("music_master source and timeline ranges must be non-empty and bounded");
      }
      const expectedOperation: MusicMasterProcessingOperation = musicMaster.audio_decision === "mastering"
        ? "shared_final_mastering"
        : source.source_range_us.in_us === 0 && source.source_range_us.out_us === source.source_duration_us
          ? "stream_copy"
          : "trim_reencode";
      if (musicMaster.processing_graph?.version !== "audio-processing-graph/v1"
        || !Array.isArray(musicMaster.processing_graph?.operations)
        || musicMaster.processing_graph.operations.length !== 1
        || musicMaster.processing_graph.operations[0] !== expectedOperation) {
        errors.push("music_master processing_graph does not match the canonical decision");
      }
      const expectedCodecOperation = expectedOperation === "stream_copy" ? "stream_copy" : "reencode";
      if (musicMaster.codec.operation !== expectedCodecOperation
        || (expectedCodecOperation === "stream_copy" && musicMaster.codec.input !== musicMaster.codec.output)) {
        errors.push("music_master codec operation does not match the processing graph");
      }
      const { policy_hash: policyHash, ...policyWithoutHash } = musicMaster;
      if (!hashPattern.test(policyHash) || hashMusicMasterPolicy(policyWithoutHash) !== policyHash) {
        errors.push("music_master policy_hash does not match the canonical policy");
      }
      if (musicMaster.audio_decision === "preserve") {
        if (plan.final_mastering.count !== 0 || plan.final_mastering.stage !== "not_applied") {
          errors.push("music_master preserve requires zero final mastering passes");
        }
        if (musicMaster.mastering_policy !== undefined || plan.expected_artifacts.mastered_mp3 !== undefined) {
          errors.push("music_master preserve cannot carry Issue #38 mastering policy or MP3 deliverables");
        }
        if (musicMaster.processing_graph.operations.some((operation) => operation === "shared_final_mastering")) {
          errors.push("music_master preserve cannot include mastering in its processing graph");
        }
      } else if (musicMaster.audio_decision === "mastering") {
        if (plan.final_mastering.count !== 1 || plan.final_mastering.stage !== "after_mix") {
          errors.push("music_master mastering requires an explicit single after_mix pass");
        }
        if (plan.final_mastering.loudness_target_lufs !== MUSIC_MASTER_MVP_POLICY.loudnorm.target_lufs
          || plan.final_mastering.lra_target !== MUSIC_MASTER_MVP_POLICY.loudnorm.lra_target
          || plan.final_mastering.true_peak_target_dbtp !== MUSIC_MASTER_MVP_POLICY.loudnorm.acceptance_true_peak_dbtp) {
          errors.push("music_master mastering final target is not the fixed Issue #38 target");
        }
        if (!musicMaster.mastering_policy
          || hashMusicMasterMvpPolicy(musicMaster.mastering_policy) !== hashMusicMasterMvpPolicy()) {
          errors.push("music_master mastering policy is missing or not the fixed Issue #38 policy");
        }
        if (musicMaster.codec.output !== "pcm_s24le"
          || plan.expected_artifacts.mastered_mp3 !== "music_master_320.mp3") {
          errors.push("music_master mastering must declare the 24-bit WAV and 320kbps MP3 deliverables");
        }
      } else {
        errors.push("music_master audio_decision must be preserve or mastering");
      }
      if (plan.dialogue.clips.length > 0 || plan.music.enabled || plan.music.cues.length > 0
        || (plan.sfx?.cues.length ?? 0) > 0 || (plan.ambient?.clips.length ?? 0) > 0) {
        errors.push("music_master must be independent from dialogue, BGM cues, ambient, and SFX lanes");
      }
      if (plan.scene_audio_policy?.music_master
        && plan.scene_audio_policy.music_master.source_content_hash !== source.source_content_hash) {
        errors.push("scene music_master source identity does not match the plan");
      }
    }
  } else if (plan.music_master) {
    errors.push("music_master data requires strategy=music_master; implicit fallback is forbidden");
  }
  if (plan.strategy !== "music_master" && plan.expected_artifacts.mastered_mp3 !== undefined) {
    errors.push("mastered_mp3 is only valid for an explicit music_master mastering plan");
  }
  if (plan.scene_audio_policy) {
    if (plan.scene_audio_policy.dialogue.conflict_policy !== "dialogue_first") {
      errors.push("dialogue-first conflict policy is required");
    }
    if (plan.scene_audio_policy.timing.audio_displacement_frames !== 0) {
      errors.push("audio projection may not displace picture/dialogue/caption timing");
    }
    if (!plan.scene_audio_policy.timing.picture_timing_immutable
      || !plan.scene_audio_policy.timing.dialogue_timing_immutable
      || !plan.scene_audio_policy.timing.caption_timing_immutable) {
      errors.push("picture, dialogue, and caption timing must be immutable");
    }
    if (plan.scene_audio_policy.single_mastering.count !== plan.final_mastering.count) {
      errors.push("scene policy and final mastering count disagree");
    }
    const ambient = plan.scene_audio_policy.ambient;
    if (ambient.clips.length > 0
      && (ambient.permission !== "human_hold" || ambient.outcome !== "human_hold")) {
      errors.push("unsupported authored A3 ambience must remain an explicit human_hold");
    }
    if (ambient.clips.length === 0 && ambient.permission !== "not_requested") {
      errors.push("empty authored A3 ambience must be not_requested");
    }
  }
  if (plan.audio_delivery_profile) {
    const hashPattern = /^sha256:[a-f0-9]{64}$/;
    if (!hashPattern.test(plan.audio_delivery_profile.source_hash)) {
      errors.push("audio delivery profile source_hash must be the raw bytes SHA-256");
    }
    if (!hashPattern.test(plan.audio_delivery_profile.profile_hash)) {
      errors.push("audio delivery profile profile_hash must be the canonical profile SHA-256");
    }
    if (plan.audio_delivery_profile.content_hash !== plan.audio_delivery_profile.source_hash) {
      errors.push("audio delivery profile content_hash must remain the raw source_hash alias");
    }
  }
  if (plan.audio_measurement_requirements
    && plan.audio_measurement_requirements.encoded_result_required !== true) {
    errors.push("encoded-result measurement is required");
  }
  return { valid: errors.length === 0, errors };
}

export function assertAudioRenderPlanContract(plan: AudioRenderPlan): void {
  const validation = validateAudioRenderPlanContract(plan);
  if (!validation.valid) {
    throw new AudioRenderPlanError(
      "AUDIO_RENDER_PLAN_INVALID",
      validation.errors.join("; "),
    );
  }
}

/**
 * Public RFA-011 entrypoint. It resolves the existing shared plan while
 * making profile selection and encoded-result requirements explicit.
 */
export function resolveAudioDeliveryPlan(
  options: ResolveAudioRenderPlanOptions,
): AudioRenderPlan {
  return resolveAudioRenderPlan(options);
}
