import * as fs from "node:fs";
import { createHash } from "node:crypto";
import * as path from "node:path";
import { parse as parseYaml } from "yaml";

import { validateAgainstSchema } from "../commands/shared.js";

export type AudioDeliveryProfileStatus =
  | "verified"
  | "partial"
  | "unknown"
  | "stale"
  | "hold"
  | "superseded";
export type AudioDeliveryReleaseScope = "organic" | "ads" | "internal";
export type AudioEvidenceStatus = Exclude<AudioDeliveryProfileStatus, "superseded">;

export interface AudioDeliverySourceReference {
  url: string;
  title: string;
  retrieved_at: string;
  published_date: string | null;
  owner: string;
  evidence_kind:
    | "official_documentation"
    | "primary_source"
    | "internal_policy"
    | "synthetic_fixture"
    | "decision_hold";
  notes?: string;
}

export interface AudioNumericEvidence {
  status: AudioEvidenceStatus;
  value?: number;
  minimum?: number;
  maximum?: number;
  unit?: string;
  basis:
    | "official_source"
    | "primary_source"
    | "internal_target"
    | "synthetic_fixture"
    | "unknown";
  source_ref?: string;
  notes?: string;
}

export interface AudioIntegerEvidence extends AudioNumericEvidence {
  value?: number;
  minimum?: number;
  maximum?: number;
}

export interface AudioTextEvidence {
  status: AudioEvidenceStatus;
  value?: string;
  basis:
    | "official_source"
    | "primary_source"
    | "internal_target"
    | "synthetic_fixture"
    | "unknown";
  source_ref?: string;
  notes?: string;
}

export interface AudioVoiceEvidence {
  status: AudioEvidenceStatus | "not_claimed";
  basis:
    | "official_source"
    | "primary_source"
    | "internal_target"
    | "synthetic_fixture"
    | "unknown";
  proxies: string[];
  target?: string;
  human_required: boolean;
  source_ref?: string;
  notes?: string;
}

export interface AudioPlaybackEvidence {
  status: "verified" | "partial" | "unknown" | "stale" | "not_run";
  method: string;
  human_required: boolean;
  fixture_ref?: string;
  record_ref?: string;
  notes?: string;
}

export interface AudioDeliveryProfile {
  version: "audio-delivery-profile/v1";
  profile_id: string;
  profile_version: string;
  platform: string;
  surface: string;
  release_scope: AudioDeliveryReleaseScope;
  delivery_variant: string;
  status: AudioDeliveryProfileStatus;
  source_references: AudioDeliverySourceReference[];
  published_at?: string | null;
  retrieved_at: string;
  owner: string;
  verification: {
    owner: string;
    verified_at: string | null;
    review_due_at: string | null;
    notes?: string;
  };
  supersession: {
    state: "active" | "superseded" | "deprecated";
    superseded_by?: string;
    reason?: string;
  };
  assumptions: string[];
  dialogue_processing: {
    authority_track: "A1";
    conflict_policy: "dialogue_first";
    finishing_engine: "existing_dialogue_finishing";
    optional_stages: string[];
    single_mastering_owner: string;
    single_mastering_stage: "after_mix";
    max_mastering_passes: 1;
    notes?: string;
  };
  measurement_requirements: {
    encoded_result_required: boolean;
    method: {
      loudness: string;
      true_peak: string;
      format: string;
      duration: string;
      av_sync: string;
    };
    integrated_loudness: AudioNumericEvidence;
    short_term_loudness: AudioNumericEvidence;
    lra: AudioNumericEvidence;
    true_peak: AudioNumericEvidence;
    voice_intelligibility: AudioVoiceEvidence;
    diagnostics: {
      clipping: string;
      silence: string;
      dropout: string;
      channel: string;
      phase: string;
    };
  };
  encoding_requirements: {
    container: AudioTextEvidence;
    codec: AudioTextEvidence;
    sample_rate_hz: AudioIntegerEvidence;
    channels: AudioIntegerEvidence;
    true_peak_margin_dbtp: AudioNumericEvidence;
    true_peak_processing_target_dbtp?: AudioNumericEvidence;
    encode_preview: {
      status: "verified" | "partial" | "unknown" | "stale" | "not_run";
      method: string;
      human_required: boolean;
      record_ref?: string;
    };
  };
  playback_evidence: {
    stereo: AudioPlaybackEvidence;
    mono_fold_down: AudioPlaybackEvidence;
    mobile_fixture: AudioPlaybackEvidence;
  };
  normalization: {
    status: "not_applied" | "simulated" | "observed" | "unknown";
    assumption: string;
    source_ref?: string;
  };
  human_preview: {
    required: boolean;
    gates: string[];
    status: "pending" | "accepted" | "rejected" | "not_recorded";
    record_ref?: string;
    notes?: string;
  };
  fallback: {
    on_missing_tool: "fail_open" | "hold";
    on_stale_or_unknown: "human_hold";
    reason: string;
  };
}

export interface LoadedAudioDeliveryProfile {
  path: string;
  hash: string;
  profile: AudioDeliveryProfile;
  warnings: string[];
}

export interface AudioDeliveryProfileSelection {
  status: "verified" | "human_hold";
  profile?: LoadedAudioDeliveryProfile;
  reason: string;
  human_preview_required: boolean;
  freshness: "current" | "stale" | "unknown";
}

export interface SelectAudioDeliveryProfileOptions {
  rootDir: string;
  platform?: string;
  surface?: string;
  releaseScope?: AudioDeliveryReleaseScope;
  deliveryVariant?: string;
  profileId?: string;
  profilePath?: string;
  now?: Date;
}

export class AudioDeliveryProfileError extends Error {
  constructor(
    readonly code:
      | "AUDIO_DELIVERY_PROFILE_INVALID"
      | "AUDIO_DELIVERY_PROFILE_UNKNOWN"
      | "AUDIO_DELIVERY_PROFILE_SCOPE_MISMATCH"
      | "AUDIO_DELIVERY_PROFILE_STALE",
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = "AudioDeliveryProfileError";
  }
}

function profileHash(raw: string): string {
  return `sha256:${createHash("sha256").update(raw, "utf8").digest("hex")}`;
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

function parseInput(filePath: string, raw: string): unknown {
  try {
    return path.extname(filePath).toLowerCase() === ".json"
      ? JSON.parse(raw)
      : parseYaml(raw);
  } catch (error) {
    throw new AudioDeliveryProfileError(
      "AUDIO_DELIVERY_PROFILE_INVALID",
      `cannot parse ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function allEvidence(profile: AudioDeliveryProfile): Array<AudioNumericEvidence | AudioTextEvidence> {
  return [
    profile.measurement_requirements.integrated_loudness,
    profile.measurement_requirements.short_term_loudness,
    profile.measurement_requirements.lra,
    profile.measurement_requirements.true_peak,
    profile.encoding_requirements.container,
    profile.encoding_requirements.codec,
    profile.encoding_requirements.sample_rate_hz,
    profile.encoding_requirements.channels,
    profile.encoding_requirements.true_peak_margin_dbtp,
  ];
}

function validateSemanticRules(profile: AudioDeliveryProfile): void {
  const issues: string[] = [];
  for (const source of profile.source_references) {
    if (!source.url.startsWith("https://")) issues.push("source_references.url must use https");
  }
  if (profile.dialogue_processing.authority_track !== "A1") {
    issues.push("dialogue authority must remain A1");
  }
  if (profile.dialogue_processing.conflict_policy !== "dialogue_first") {
    issues.push("audio conflicts must use dialogue_first");
  }
  if (profile.dialogue_processing.max_mastering_passes !== 1) {
    issues.push("audio delivery profiles allow one mastering pass");
  }
  if (profile.status === "verified" && profile.supersession.state !== "active") {
    issues.push("verified profiles must be active");
  }
  if (profile.status === "verified" && profile.platform !== "internal" && profile.platform !== "fixture") {
    for (const evidence of allEvidence(profile)) {
      if (evidence.status === "verified" && evidence.basis !== "official_source" && evidence.basis !== "primary_source") {
        issues.push("production verified values require official or primary evidence");
      }
      if (evidence.status === "verified" && !evidence.source_ref) {
        issues.push("production verified values require source_ref");
      }
    }
  }
  if (profile.status !== "verified" && !profile.human_preview.required) {
    issues.push("partial, unknown, stale, and hold profiles require human_preview.required=true");
  }
  if (profile.status === "unknown" && profile.normalization.status !== "unknown") {
    issues.push("unknown profiles must keep normalization status unknown");
  }
  if (issues.length > 0) {
    throw new AudioDeliveryProfileError(
      "AUDIO_DELIVERY_PROFILE_INVALID",
      issues.join("; "),
    );
  }
}

export function parseAudioDeliveryProfile(input: unknown): AudioDeliveryProfile {
  const validation = validateAgainstSchema(input, "audio-delivery-profile.schema.json");
  if (!validation.valid) {
    throw new AudioDeliveryProfileError(
      "AUDIO_DELIVERY_PROFILE_INVALID",
      validation.errors.join("; "),
    );
  }
  const profile = structuredClone(input) as AudioDeliveryProfile;
  validateSemanticRules(profile);
  return profile;
}

export function loadAudioDeliveryProfile(filePath: string): LoadedAudioDeliveryProfile {
  const resolvedPath = path.resolve(filePath);
  let raw: string;
  try {
    raw = fs.readFileSync(resolvedPath, "utf8");
  } catch (error) {
    throw new AudioDeliveryProfileError(
      "AUDIO_DELIVERY_PROFILE_UNKNOWN",
      `cannot read profile ${resolvedPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const profile = parseAudioDeliveryProfile(parseInput(resolvedPath, raw));
  return {
    path: resolvedPath,
    hash: profileHash(raw),
    profile,
    warnings: profile.status === "verified" ? [] : [`profile status is ${profile.status}`],
  };
}

function walkProfiles(directory: string): string[] {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return walkProfiles(entryPath);
    return /\.(yaml|yml|json)$/i.test(entry.name) ? [entryPath] : [];
  }).sort();
}

export function loadAudioDeliveryRegistry(rootDir: string): {
  profiles: LoadedAudioDeliveryProfile[];
  malformed: Array<{ path: string; error: string }>;
} {
  const profiles: LoadedAudioDeliveryProfile[] = [];
  const malformed: Array<{ path: string; error: string }> = [];
  for (const filePath of walkProfiles(path.join(rootDir, "delivery_profiles", "audio"))) {
    try {
      profiles.push(loadAudioDeliveryProfile(filePath));
    } catch (error) {
      malformed.push({
        path: filePath,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { profiles, malformed };
}

function requestedScope(options: SelectAudioDeliveryProfileOptions): string {
  return `${options.platform ?? "*"}/${options.surface ?? "*"}/${options.releaseScope ?? "*"}/${options.deliveryVariant ?? "*"}`;
}

function isReviewDue(profile: AudioDeliveryProfile, now: Date): boolean {
  const due = profile.verification.review_due_at;
  return Boolean(due && new Date(due).getTime() <= now.getTime());
}

export function selectAudioDeliveryProfile(
  options: SelectAudioDeliveryProfileOptions,
): AudioDeliveryProfileSelection {
  const registry = loadAudioDeliveryRegistry(options.rootDir);
  if (registry.malformed.length > 0 && options.profilePath) {
    const malformed = registry.malformed.find((entry) => path.resolve(entry.path) === path.resolve(options.profilePath!));
    if (malformed) {
      throw new AudioDeliveryProfileError("AUDIO_DELIVERY_PROFILE_INVALID", malformed.error);
    }
  }

  let candidates = registry.profiles;
  const idMatches = options.profileId
    ? registry.profiles.filter((item) => item.profile.profile_id === options.profileId)
    : [];
  if (options.profileId && idMatches.length !== 1) {
    throw new AudioDeliveryProfileError(
      "AUDIO_DELIVERY_PROFILE_UNKNOWN",
      idMatches.length === 0
        ? `no registered profile matches ${options.profileId}`
        : `profile id ${options.profileId} is ambiguous across ${idMatches.length} registered files`,
    );
  }
  if (options.profilePath) {
    const selectedPath = path.resolve(options.profilePath);
    const loaded = candidates.find((item) => item.path === selectedPath) ?? loadAudioDeliveryProfile(selectedPath);
    if (options.profileId && idMatches[0].path !== loaded.path) {
      throw new AudioDeliveryProfileError(
        "AUDIO_DELIVERY_PROFILE_UNKNOWN",
        `profile id ${options.profileId} does not identify ${selectedPath}`,
      );
    }
    candidates = [loaded];
  }
  if (options.profileId) {
    candidates = candidates.filter((item) => item.profile.profile_id === options.profileId);
  }
  const explicitSelection = Boolean(options.profilePath || options.profileId);
  if (explicitSelection) {
    const selected = candidates[0];
    if (!selected) {
      throw new AudioDeliveryProfileError(
        "AUDIO_DELIVERY_PROFILE_UNKNOWN",
        `no registered profile matches ${options.profileId ?? options.profilePath ?? requestedScope(options)}`,
      );
    }
    if (
      (options.platform && selected.profile.platform !== options.platform)
      || (options.surface && selected.profile.surface !== options.surface)
      || (options.releaseScope && selected.profile.release_scope !== options.releaseScope)
      || (options.deliveryVariant && selected.profile.delivery_variant !== options.deliveryVariant)
    ) {
      throw new AudioDeliveryProfileError(
        "AUDIO_DELIVERY_PROFILE_SCOPE_MISMATCH",
        `${selected.profile.profile_id} does not match requested ${requestedScope(options)}`,
      );
    }
    return selectionForLoadedProfile(selected, options.now ?? new Date());
  }

  if (!options.platform || !options.surface || !options.releaseScope) {
    throw new AudioDeliveryProfileError(
      "AUDIO_DELIVERY_PROFILE_UNKNOWN",
      `platform, surface, and releaseScope are required for registry selection (${requestedScope(options)})`,
    );
  }
  candidates = candidates.filter((item) =>
    item.profile.platform === options.platform
    && item.profile.surface === options.surface
    && item.profile.release_scope === options.releaseScope
    && (!options.deliveryVariant || item.profile.delivery_variant === options.deliveryVariant),
  );
  if (candidates.length > 1 && !options.deliveryVariant) {
    throw new AudioDeliveryProfileError(
      "AUDIO_DELIVERY_PROFILE_UNKNOWN",
      `multiple registered profiles match ${requestedScope(options)}; deliveryVariant is required`,
    );
  }
  const selected = candidates.find((item) => item.profile.supersession.state === "active") ?? candidates[0];
  if (!selected) {
    throw new AudioDeliveryProfileError(
      "AUDIO_DELIVERY_PROFILE_UNKNOWN",
      `no registered profile matches ${requestedScope(options)}`,
    );
  }

  return selectionForLoadedProfile(selected, options.now ?? new Date());
}

function selectionForLoadedProfile(
  selected: LoadedAudioDeliveryProfile,
  now: Date,
): AudioDeliveryProfileSelection {
  const stale = selected.profile.status === "stale"
    || selected.profile.status === "superseded"
    || selected.profile.supersession.state !== "active"
    || isReviewDue(selected.profile, now);
  if (stale || selected.profile.status !== "verified") {
    const reason = stale
      ? `${selected.profile.profile_id} is stale or superseded`
      : `${selected.profile.profile_id} is ${selected.profile.status}; platform values are not fully evidenced`;
    return {
      status: "human_hold",
      profile: selected,
      reason,
      human_preview_required: true,
      freshness: stale ? "stale" : "unknown",
    };
  }
  return {
    status: "verified",
    profile: selected,
    reason: "registered profile is active and current",
    human_preview_required: selected.profile.human_preview.required,
    freshness: "current",
  };
}

export function assertAudioDeliveryProfileFresh(
  loaded: Pick<LoadedAudioDeliveryProfile, "path" | "hash">,
  now: Date = new Date(),
): void {
  const current = loadAudioDeliveryProfile(loaded.path);
  if (current.hash !== loaded.hash) {
    throw new AudioDeliveryProfileError(
      "AUDIO_DELIVERY_PROFILE_STALE",
      `${current.profile.profile_id} changed after selection`,
    );
  }
  if (
    current.profile.status === "stale"
    || current.profile.status === "superseded"
    || current.profile.supersession.state !== "active"
    || isReviewDue(current.profile, now)
  ) {
    throw new AudioDeliveryProfileError(
      "AUDIO_DELIVERY_PROFILE_STALE",
      `${current.profile.profile_id} is stale, superseded, or review-due (${current.profile.status}/${current.profile.supersession.state})`,
    );
  }
}

export function audioDeliveryProfileContentHash(profile: AudioDeliveryProfile): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(normalized(profile)), "utf8").digest("hex")}`;
}
