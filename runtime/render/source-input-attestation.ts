import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { loadSourceMap, type MediaSourceMapEntry } from "../media/source-map.js";
import { computeFileHash } from "../state/reconcile.js";
import { sha256FileHex } from "../source-content-identity.js";
import type { TimelineIR } from "../compiler/types.js";
import { CanonicalRenderInputError, resolveCanonicalRenderInputs } from "./canonical-render-input.js";
import { assertCaptionCleanSourceEligibility } from "./clean-source-policy.js";

export const SOURCE_INPUT_ATTESTATION_VERSION = "source-input-attestation/v3" as const;
export const MAX_PERSISTED_SOURCE_INPUTS = 256;
export const MAX_SOURCE_INPUT_WARNINGS = 64;
export const SOURCE_INPUT_IDENTITY_MODEL = "original_or_normalized_render_input_v3" as const;
const PREVIOUS_SOURCE_INPUT_ATTESTATION_VERSION = "source-input-attestation/v2";
const PREVIOUS_SOURCE_INPUT_IDENTITY_MODEL = "original_or_normalized_render_input_v2";
const LEGACY_SOURCE_INPUT_ATTESTATION_VERSION = "source-input-attestation/v1";
const LEGACY_SOURCE_INPUT_IDENTITY_MODEL = "original_source_equals_render_input_v1";

export type SourceInputIdentityStatus = "verified" | "live_only";
export type SourceInputAttestationStatus = "verified" | "live_only" | "not_applicable";

export interface SourceInputUsagePolicy {
  include_video: boolean;
  include_audio: boolean;
}

export interface CanonicalSourceInputEntry {
  asset_id: string;
  media_kind: string;
  content_sha256: string;
  identity_status: SourceInputIdentityStatus;
  render_input_identity: {
    relationship: "same_as_original";
    content_sha256: string;
  } | {
    relationship: "normalized_still_frame";
    content_sha256: string;
    original_content_sha256: string;
    analysis_path: string;
    normalization_producer: string;
    normalization_producer_version: string;
  } | {
    relationship: "normalized_image_sequence_proxy";
    content_sha256: string;
    original_frame_set_content_sha256: string;
    frame_count: number;
    analysis_path: string;
    normalization_producer: string;
    normalization_producer_version: string;
  };
}

export interface SourceInputAttestation {
  version: typeof SOURCE_INPUT_ATTESTATION_VERSION;
  status: SourceInputAttestationStatus;
  source_inputs_hash: string;
  source_inputs: CanonicalSourceInputEntry[];
  source_input_count: number;
  persisted_source_input_count: number;
  source_inputs_truncated: boolean;
  warnings: string[];
  warning_count: number;
  warnings_suppressed: number;
  usage_policy: SourceInputUsagePolicy;
  timeline_hash: string;
}

export interface SourceInputRenderMetadata {
  source_inputs_hash?: string;
  source_inputs?: CanonicalSourceInputEntry[];
  source_inputs_attestation?: {
    version?: string;
    status?: SourceInputAttestationStatus;
    source_input_count?: number;
    persisted_source_input_count?: number;
    source_inputs_truncated?: boolean;
    warnings?: string[];
    warning_count?: number;
    warnings_suppressed?: number;
    identity_model?: string;
    usage_policy?: SourceInputUsagePolicy;
  };
}

export type RenderArtifactFreshnessStatus = "fresh" | "missing" | "missing_timeline" | "stale";

export interface RenderArtifactFreshness {
  status: RenderArtifactFreshnessStatus;
  reason?: string;
  artifactPath: string;
  timelinePath: string;
  timelineHash?: string;
  timelineVersion?: string;
  artifactHash?: string;
  metaPath?: string;
  sourceInputsHash?: string;
  sourceInputsStatus?: SourceInputAttestationStatus;
  sourceInputWarnings?: string[];
}

export class SourceInputAttestationError extends Error {
  constructor(
    public readonly reason:
      | "timeline_missing"
      | "source_map_entry_missing"
      | "source_missing"
      | "source_unreadable"
      | "source_analysis_identity_mismatch"
      | "source_analysis_identity_invalid"
      | "render_input_identity_mismatch"
      | "timeline_changed_during_render"
      | "source_changed_during_render",
    message: string,
    public readonly assetId?: string,
  ) {
    super(`${reason}: ${message}`);
    this.name = "SourceInputAttestationError";
  }
}

interface TimelineClipLike {
  asset_id?: unknown;
  media_kind?: unknown;
}

interface TimelineLike {
  version?: unknown;
  tracks?: {
    video?: Array<{ clips?: TimelineClipLike[] }>;
    audio?: Array<{ clips?: TimelineClipLike[] }>;
  };
  audio_mix?: { bgm_asset_id?: unknown };
}

interface SourceUse {
  assetId: string;
  usageKinds: Set<string>;
}

export interface CreateSourceInputAttestationOptions {
  timelinePath?: string;
  sourceOverrides?: Record<string, string>;
  includeVideo?: boolean;
  includeAudio?: boolean;
}

export interface WriteRenderFreshnessMetadataOptions {
  createdAt?: string;
  sourceInputsBefore?: SourceInputAttestation;
  sourceOverrides?: Record<string, string>;
}

function hashSourceFile(filePath: string, assetId: string): string {
  try {
    return sha256FileHex(filePath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new SourceInputAttestationError(
        "source_missing",
        `Referenced source is missing for asset ${assetId}`,
        assetId,
      );
    }
    throw new SourceInputAttestationError(
      "source_unreadable",
      `Referenced source cannot be read for asset ${assetId}: ${err instanceof Error ? err.message : String(err)}`,
      assetId,
    );
  }
}

function normalizeSha(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  return /^[a-f0-9]{64}$/.test(normalized) ? normalized : undefined;
}

function readDeclaredSourceIdentities(sourceMapPath: string | undefined): Map<string, unknown> {
  if (!sourceMapPath || !fs.existsSync(sourceMapPath)) return new Map();
  try {
    const raw = JSON.parse(fs.readFileSync(sourceMapPath, "utf-8")) as {
      items?: Array<Record<string, unknown>>;
    };
    return new Map(
      (raw.items ?? [])
        .filter((item) => typeof item.asset_id === "string" && Object.hasOwn(item, "source_content_sha256"))
        .map((item) => [item.asset_id as string, item.source_content_sha256]),
    );
  } catch {
    return new Map();
  }
}

function collectSourceUses(timeline: TimelineLike, policy: SourceInputUsagePolicy): SourceUse[] {
  const uses = new Map<string, Set<string>>();
  const add = (assetId: unknown, usageKind: string): void => {
    if (typeof assetId !== "string" || assetId.trim().length === 0) return;
    const normalized = assetId.trim();
    const kinds = uses.get(normalized) ?? new Set<string>();
    kinds.add(usageKind);
    uses.set(normalized, kinds);
  };

  if (policy.include_video) {
    for (const track of timeline.tracks?.video ?? []) {
      for (const clip of track.clips ?? []) {
        add(clip.asset_id, typeof clip.media_kind === "string" ? clip.media_kind : "video");
      }
    }
  }
  if (policy.include_audio) {
    for (const track of timeline.tracks?.audio ?? []) {
      for (const clip of track.clips ?? []) {
        add(clip.asset_id, "audio");
      }
    }
    add(timeline.audio_mix?.bgm_asset_id, "bgm");
  }

  return [...uses.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([assetId, usageKinds]) => ({ assetId, usageKinds }));
}

function canonicalMediaKind(use: SourceUse, entry: MediaSourceMapEntry): string {
  if (entry.media_kind === "image" || entry.media_kind === "sequence") return entry.media_kind;
  const kinds = use.usageKinds;
  if (kinds.has("video") && kinds.has("audio")) return "mixed";
  if (kinds.has("bgm") && kinds.size === 1) return "bgm";
  if (kinds.has("audio") || kinds.has("bgm")) return "audio";
  if (kinds.has("video")) return entry.media_kind === "unknown" ? "unknown" : "video";
  return entry.media_kind ?? "unknown";
}

function canonicalHashForVersion(entries: CanonicalSourceInputEntry[], usagePolicy: SourceInputUsagePolicy, version: string): string {
  const canonical = JSON.stringify({
    version,
    usage_policy: usagePolicy,
    source_inputs: entries,
  });
  return crypto.createHash("sha256").update(canonical).digest("hex");
}

function canonicalHash(entries: CanonicalSourceInputEntry[], usagePolicy: SourceInputUsagePolicy): string {
  return canonicalHashForVersion(entries, usagePolicy, SOURCE_INPUT_ATTESTATION_VERSION);
}

function readLegacyAssetSourceEntries(projectDir: string): Map<string, MediaSourceMapEntry> {
  const assetsPath = path.join(projectDir, "03_analysis/assets.json");
  const assets = readJsonIfExists<{ items?: Array<{ asset_id?: unknown; filename?: unknown; media_kind?: unknown }> }>(assetsPath);
  const entries = new Map<string, MediaSourceMapEntry>();
  for (const asset of assets?.items ?? []) {
    if (typeof asset.asset_id !== "string" || typeof asset.filename !== "string") continue;
    if (path.isAbsolute(asset.filename) || path.basename(asset.filename) !== asset.filename ||
      asset.filename === "." || asset.filename === "..") continue;
    const sourcePath = path.join(projectDir, "00_sources", asset.filename);
    if (!fs.existsSync(sourcePath)) continue;
    entries.set(asset.asset_id, {
      asset_id: asset.asset_id,
      source_locator: sourcePath,
      local_source_path: sourcePath,
      link_path: path.join("00_sources", asset.filename),
      media_kind: asset.media_kind === "audio" ? "audio" : "video",
    });
  }
  return entries;
}

export function createSourceInputAttestation(
  projectDir: string,
  options: CreateSourceInputAttestationOptions = {},
): SourceInputAttestation {
  const absDir = path.resolve(projectDir);
  const timelinePath = options.timelinePath
    ? path.resolve(options.timelinePath)
    : path.join(absDir, "05_timeline/timeline.json");
  if (!fs.existsSync(timelinePath)) {
    throw new SourceInputAttestationError("timeline_missing", `Timeline not found: ${timelinePath}`);
  }

  const timeline = JSON.parse(fs.readFileSync(timelinePath, "utf-8")) as TimelineLike;
  const usagePolicy: SourceInputUsagePolicy = {
    include_video: options.includeVideo !== false,
    include_audio: options.includeAudio !== false,
  };
  const sourceMap = loadSourceMap(absDir);
  const canonicalInputs = resolveCanonicalRenderInputs(timeline as TimelineIR, {
    projectDir: absDir,
    timelinePath,
    sourceOverrides: options.sourceOverrides,
    includeVideo: usagePolicy.include_video,
    includeAudio: usagePolicy.include_audio,
  });
  const declaredIdentities = readDeclaredSourceIdentities(sourceMap.filePath);
  const sourceUses = collectSourceUses(timeline, usagePolicy);
  const warnings: string[] = [];
  const entries: CanonicalSourceInputEntry[] = [];
  const legacyAssetEntries = readLegacyAssetSourceEntries(absDir);

  for (const use of sourceUses) {
    const registeredMapEntry = sourceMap.entryMap.get(use.assetId);
    const legacyOverride = options.sourceOverrides?.[use.assetId];
    const mapEntry: MediaSourceMapEntry | undefined = registeredMapEntry ?? legacyAssetEntries.get(use.assetId) ?? (legacyOverride ? {
      asset_id: use.assetId,
      source_locator: legacyOverride,
      local_source_path: legacyOverride,
      link_path: legacyOverride,
      media_kind: use.usageKinds.has("audio") && !use.usageKinds.has("video") ? "audio" : "video",
    } : undefined);
    if (!mapEntry) {
      throw new SourceInputAttestationError(
        "source_map_entry_missing",
        `Timeline references asset ${use.assetId}, but source_map.json has no matching entry`,
        use.assetId,
      );
    }
    const canonicalInput = canonicalInputs.byAssetId.get(use.assetId);
    const isDerivedStill = canonicalInput?.relationship === "normalized_still_frame";
    const isDerivedSequence = canonicalInput?.relationship === "normalized_image_sequence_proxy";
    const hasSourceOverride = !isDerivedStill && !isDerivedSequence && options.sourceOverrides !== undefined &&
      Object.hasOwn(options.sourceOverrides, use.assetId);
    const sourcePath = hasSourceOverride
      ? options.sourceOverrides?.[use.assetId]
      : mapEntry.source_locator;
    if (!sourcePath || !fs.existsSync(sourcePath)) {
      throw new SourceInputAttestationError(
        "source_missing",
        `Source file not found for asset ${use.assetId}`,
        use.assetId,
      );
    }

    const contentSha = isDerivedSequence
      ? canonicalInput.originalContentSha256
      : hashSourceFile(sourcePath, use.assetId);
    if (hasSourceOverride && registeredMapEntry) {
      const originalSourceSha = hashSourceFile(mapEntry.source_locator, use.assetId);
      if (originalSourceSha !== contentSha) {
        throw new SourceInputAttestationError(
          "render_input_identity_mismatch",
          `Renderer override for asset ${use.assetId} is not byte-identical to the source-map original; derived render inputs require a future attestation contract`,
          use.assetId,
        );
      }
    }
    const hasDeclaredIdentity = declaredIdentities.has(use.assetId) || mapEntry.source_content_sha256 !== undefined;
    const rawDeclaredIdentity = declaredIdentities.has(use.assetId)
      ? declaredIdentities.get(use.assetId)
      : mapEntry.source_content_sha256;
    const declaredSha = normalizeSha(rawDeclaredIdentity);
    if (hasDeclaredIdentity && !declaredSha) {
      throw new SourceInputAttestationError(
        "source_analysis_identity_invalid",
        `source_map.json has an invalid source_content_sha256 for asset ${use.assetId}; rerun ingest before rendering`,
        use.assetId,
      );
    }
    if (!isDerivedSequence && declaredSha && declaredSha !== contentSha) {
      throw new SourceInputAttestationError(
        "source_analysis_identity_mismatch",
        `Live source SHA-256 for asset ${use.assetId} does not match source_map.json; rerun ingest before rendering`,
        use.assetId,
      );
    }
    const identityStatus: SourceInputIdentityStatus = isDerivedStill || isDerivedSequence || declaredSha ? "verified" : "live_only";
    if (identityStatus === "live_only") {
      warnings.push(`ingest_identity_unproven:${use.assetId}`);
    }
    const mediaKind = isDerivedStill
      ? "image"
      : isDerivedSequence
        ? "sequence"
        : canonicalMediaKind(use, mapEntry);
    assertCaptionCleanSourceEligibility({
      projectDir: absDir,
      assetId: use.assetId,
      sourcePath,
      contentSha256: contentSha,
      mediaKind,
      declaredOrigin: mapEntry.source_origin,
      cleanBaseAttestation: mapEntry.clean_base_attestation,
    });
    entries.push({
      asset_id: use.assetId,
      media_kind: mediaKind,
      content_sha256: contentSha,
      identity_status: identityStatus,
      render_input_identity: isDerivedStill
        ? {
            relationship: "normalized_still_frame",
            content_sha256: canonicalInput.renderInputContentSha256,
            original_content_sha256: contentSha,
            analysis_path: canonicalInput.analysisPath!,
            normalization_producer: canonicalInput.normalizationProducer!,
            normalization_producer_version: canonicalInput.normalizationProducerVersion!,
          }
        : isDerivedSequence
          ? {
              relationship: "normalized_image_sequence_proxy",
              content_sha256: canonicalInput.renderInputContentSha256,
              original_frame_set_content_sha256: canonicalInput.originalFrameSetContentSha256!,
              frame_count: canonicalInput.frameCount!,
              analysis_path: canonicalInput.analysisPath!,
              normalization_producer: canonicalInput.normalizationProducer!,
              normalization_producer_version: canonicalInput.normalizationProducerVersion!,
            }
        : {
            relationship: "same_as_original",
            content_sha256: contentSha,
          },
    });
  }

  entries.sort((left, right) => left.asset_id.localeCompare(right.asset_id));
  warnings.sort();
  const status: SourceInputAttestationStatus = entries.length === 0
    ? "not_applicable"
    : entries.some((entry) => entry.identity_status === "live_only")
      ? "live_only"
      : "verified";
  const persisted = entries.slice(0, MAX_PERSISTED_SOURCE_INPUTS);
  const persistedWarnings = warnings.slice(0, MAX_SOURCE_INPUT_WARNINGS);
  return {
    version: SOURCE_INPUT_ATTESTATION_VERSION,
    status,
    source_inputs_hash: canonicalHash(entries, usagePolicy),
    source_inputs: persisted,
    source_input_count: entries.length,
    persisted_source_input_count: persisted.length,
    source_inputs_truncated: persisted.length !== entries.length,
    warnings: persistedWarnings,
    warning_count: warnings.length,
    warnings_suppressed: warnings.length - persistedWarnings.length,
    usage_policy: usagePolicy,
    timeline_hash: computeFileHash(timelinePath),
  };
}

export function assertSourceInputsUnchanged(
  before: SourceInputAttestation,
  after: SourceInputAttestation,
): void {
  if (before.timeline_hash !== after.timeline_hash) {
    throw new SourceInputAttestationError(
      "timeline_changed_during_render",
      `Timeline changed while rendering (${before.timeline_hash} -> ${after.timeline_hash})`,
    );
  }
  if (before.source_inputs_hash !== after.source_inputs_hash) {
    throw new SourceInputAttestationError(
      "source_changed_during_render",
      `Source inputs changed while rendering (${before.source_inputs_hash} -> ${after.source_inputs_hash})`,
    );
  }
}

export function sourceInputMetadata(attestation: SourceInputAttestation): Required<SourceInputRenderMetadata> {
  return {
    source_inputs_hash: attestation.source_inputs_hash,
    source_inputs: attestation.source_inputs,
    source_inputs_attestation: {
      version: attestation.version,
      status: attestation.status,
      source_input_count: attestation.source_input_count,
      persisted_source_input_count: attestation.persisted_source_input_count,
      source_inputs_truncated: attestation.source_inputs_truncated,
      warnings: attestation.warnings,
      warning_count: attestation.warning_count,
      warnings_suppressed: attestation.warnings_suppressed,
      identity_model: SOURCE_INPUT_IDENTITY_MODEL,
      usage_policy: attestation.usage_policy,
    },
  };
}

export function writeRenderFreshnessMetadata(
  projectDir: string,
  artifactPath: string,
  options: WriteRenderFreshnessMetadataOptions = {},
): string | undefined {
  const absDir = path.resolve(projectDir);
  const absArtifact = path.resolve(artifactPath);
  const timelinePath = path.join(absDir, "05_timeline/timeline.json");
  if (!fs.existsSync(timelinePath) || !fs.existsSync(absArtifact)) return undefined;

  const before = options.sourceInputsBefore ?? createSourceInputAttestation(absDir, {
    timelinePath,
    sourceOverrides: options.sourceOverrides,
  });
  const liveTimelineHash = computeFileHash(timelinePath);
  if (before.timeline_hash !== liveTimelineHash) {
    throw new SourceInputAttestationError(
      "timeline_changed_during_render",
      `Timeline changed while rendering (${before.timeline_hash} -> ${liveTimelineHash})`,
    );
  }
  const after = createSourceInputAttestation(absDir, {
    timelinePath,
    sourceOverrides: options.sourceOverrides,
    includeVideo: before.usage_policy.include_video,
    includeAudio: before.usage_policy.include_audio,
  });
  assertSourceInputsUnchanged(before, after);
  const timeline = JSON.parse(fs.readFileSync(timelinePath, "utf-8")) as TimelineLike;
  const metaPath = path.join(path.dirname(absArtifact), "render-report.json");
  const existing = readJsonIfExists<Record<string, unknown>>(metaPath) ?? {};
  const next = {
    ...existing,
    timeline_path: path.relative(absDir, timelinePath),
    timeline_hash: liveTimelineHash,
    timeline_version: typeof timeline.version === "string" ? timeline.version : "unknown",
    video_path: path.relative(absDir, absArtifact),
    video_hash: computeFileHash(absArtifact),
    rendered_at: options.createdAt ?? new Date().toISOString(),
    ...sourceInputMetadata(after),
  };
  fs.mkdirSync(path.dirname(metaPath), { recursive: true });
  fs.writeFileSync(metaPath, `${JSON.stringify(next, null, 2)}\n`, "utf-8");
  return metaPath;
}

export function assessRenderArtifactFreshness(
  projectDir: string,
  artifactPath: string,
): RenderArtifactFreshness {
  const absDir = path.resolve(projectDir);
  const absArtifact = path.resolve(artifactPath);
  const timelinePath = path.join(absDir, "05_timeline/timeline.json");
  if (!fs.existsSync(timelinePath)) {
    return { status: "missing_timeline", reason: "timeline_missing", artifactPath: absArtifact, timelinePath };
  }
  const timeline = JSON.parse(fs.readFileSync(timelinePath, "utf-8")) as TimelineLike;
  const timelineVersion = typeof timeline.version === "string" ? timeline.version : "unknown";
  const timelineHash = computeFileHash(timelinePath);
  if (!fs.existsSync(absArtifact)) {
    return { status: "missing", reason: "render_missing", artifactPath: absArtifact, timelinePath, timelineHash, timelineVersion };
  }

  const artifactHash = computeFileHash(absArtifact);
  const renderMeta = readRenderMetadata(absArtifact);
  const base = {
    artifactPath: absArtifact,
    timelinePath,
    timelineHash,
    timelineVersion,
    artifactHash,
    ...(renderMeta.path ? { metaPath: renderMeta.path } : {}),
  };
  if (renderMeta.meta?.timeline_hash && renderMeta.meta.timeline_hash !== timelineHash) {
    return { status: "stale", reason: "render_timeline_hash_mismatch", ...base };
  }
  if (renderMeta.meta?.video_hash && renderMeta.meta.video_hash !== artifactHash) {
    return { status: "stale", reason: "render_video_hash_mismatch", ...base };
  }

  let live: SourceInputAttestation;
  try {
    const metadataPolicy = renderMeta.meta?.source_inputs_hash
      ? readMetadataUsagePolicy(renderMeta.meta)
      : undefined;
    if (renderMeta.meta?.source_inputs_hash && !metadataPolicy) {
      return { status: "stale", reason: "source_inputs_attestation_invalid", ...base };
    }
    live = createSourceInputAttestation(absDir, {
      timelinePath,
      includeVideo: metadataPolicy?.include_video,
      includeAudio: metadataPolicy?.include_audio,
    });
  } catch (err) {
    if (err instanceof SourceInputAttestationError) {
      return { status: "stale", reason: err.reason, ...base };
    }
    if (err instanceof CanonicalRenderInputError) {
      return { status: "stale", reason: err.reason, ...base };
    }
    return { status: "stale", reason: "source_input_attestation_failed", ...base };
  }
  const sourceBase = {
    ...base,
    sourceInputsHash: live.source_inputs_hash,
    sourceInputsStatus: live.status,
    sourceInputWarnings: live.warnings,
  };
  if (!renderMeta.meta?.source_inputs_hash) {
    if (live.status !== "not_applicable") {
      return { status: "stale", reason: "source_inputs_unverifiable", ...sourceBase };
    }
  } else {
    const metadataVersion = renderMeta.meta.source_inputs_attestation?.version;
    const expectedMetadataHash = metadataVersion === LEGACY_SOURCE_INPUT_ATTESTATION_VERSION
      ? canonicalHashForVersion(live.source_inputs, live.usage_policy, LEGACY_SOURCE_INPUT_ATTESTATION_VERSION)
      : metadataVersion === PREVIOUS_SOURCE_INPUT_ATTESTATION_VERSION
        ? canonicalHashForVersion(live.source_inputs, live.usage_policy, PREVIOUS_SOURCE_INPUT_ATTESTATION_VERSION)
        : live.source_inputs_hash;
    if (renderMeta.meta.source_inputs_hash !== expectedMetadataHash) {
      const persistedEntries = renderMeta.meta.source_inputs;
      const liveByAssetId = new Map(live.source_inputs.map((entry) => [entry.asset_id, entry]));
      const hasChangedPersistedContent = Array.isArray(persistedEntries) && persistedEntries.some((entry) => {
        if (!entry || typeof entry.asset_id !== "string") return false;
        const liveEntry = liveByAssetId.get(entry.asset_id);
        return liveEntry !== undefined && entry.content_sha256 !== liveEntry.content_sha256;
      });
      return {
        status: "stale",
        reason: hasChangedPersistedContent
          ? "source_inputs_hash_mismatch"
          : "source_inputs_attestation_invalid",
        ...sourceBase,
      };
    }
    const metadataContractReason = validateSourceInputMetadata(renderMeta.meta, live);
    if (metadataContractReason) {
      return { status: "stale", reason: metadataContractReason, ...sourceBase };
    }
  }
  if (!renderMeta.meta?.timeline_hash) {
    const artifactStat = fs.statSync(absArtifact);
    const timelineStat = fs.statSync(timelinePath);
    if (artifactStat.mtimeMs + 1 < timelineStat.mtimeMs) {
      return { status: "stale", reason: "render_older_than_timeline", ...sourceBase };
    }
  }
  return { status: "fresh", ...sourceBase };
}

function validateSourceInputMetadata(
  metadata: RenderMetadata,
  live: SourceInputAttestation,
): "source_inputs_attestation_invalid" | "source_inputs_attestation_unsupported" | undefined {
  const contract = metadata.source_inputs_attestation;
  if (!contract || typeof contract.version !== "string") return "source_inputs_attestation_invalid";
  const hasDerivedStill = live.source_inputs.some((entry) => entry.render_input_identity.relationship === "normalized_still_frame");
  const hasDerivedSequence = live.source_inputs.some((entry) => entry.render_input_identity.relationship === "normalized_image_sequence_proxy");
  const currentContract = contract.version === SOURCE_INPUT_ATTESTATION_VERSION &&
    contract.identity_model === SOURCE_INPUT_IDENTITY_MODEL;
  const previousContract = !hasDerivedSequence && contract.version === PREVIOUS_SOURCE_INPUT_ATTESTATION_VERSION &&
    contract.identity_model === PREVIOUS_SOURCE_INPUT_IDENTITY_MODEL;
  const legacyVideoContract = !hasDerivedStill && !hasDerivedSequence && contract.version === LEGACY_SOURCE_INPUT_ATTESTATION_VERSION &&
    contract.identity_model === LEGACY_SOURCE_INPUT_IDENTITY_MODEL;
  if (!currentContract && !previousContract && !legacyVideoContract) {
    return contract.version === SOURCE_INPUT_ATTESTATION_VERSION ||
      contract.version === PREVIOUS_SOURCE_INPUT_ATTESTATION_VERSION ||
      contract.version === LEGACY_SOURCE_INPUT_ATTESTATION_VERSION
      ? "source_inputs_attestation_invalid"
      : "source_inputs_attestation_unsupported";
  }
  if (JSON.stringify(contract.usage_policy) !== JSON.stringify(live.usage_policy)) {
    return "source_inputs_attestation_invalid";
  }
  if (contract.status !== "verified" && contract.status !== "live_only" && contract.status !== "not_applicable") {
    return "source_inputs_attestation_invalid";
  }
  if (
    contract.status !== live.status ||
    !Number.isInteger(contract.source_input_count) ||
    contract.source_input_count !== live.source_input_count ||
    !Number.isInteger(contract.persisted_source_input_count) ||
    contract.persisted_source_input_count !== live.persisted_source_input_count ||
    contract.source_inputs_truncated !== live.source_inputs_truncated ||
    !Array.isArray(metadata.source_inputs) ||
    metadata.source_inputs.length !== live.persisted_source_input_count ||
    JSON.stringify(metadata.source_inputs) !== JSON.stringify(live.source_inputs) ||
    !Array.isArray(contract.warnings) ||
    JSON.stringify(contract.warnings) !== JSON.stringify(live.warnings) ||
    contract.warning_count !== live.warning_count ||
    contract.warnings_suppressed !== live.warnings_suppressed
  ) {
    return "source_inputs_attestation_invalid";
  }
  return undefined;
}

function readMetadataUsagePolicy(metadata: RenderMetadata): SourceInputUsagePolicy | undefined {
  const policy = metadata.source_inputs_attestation?.usage_policy;
  return policy &&
      typeof policy.include_video === "boolean" &&
      typeof policy.include_audio === "boolean"
    ? policy
    : undefined;
}

interface RenderMetadata extends SourceInputRenderMetadata {
  timeline_hash?: string;
  timeline_version?: string;
  video_hash?: string;
}

function readRenderMetadata(artifactPath: string): { path?: string; meta?: RenderMetadata } {
  for (const candidate of [
    path.join(path.dirname(artifactPath), "render-report.json"),
    path.join(path.dirname(artifactPath), "render-meta.json"),
  ]) {
    const parsed = readJsonIfExists<RenderMetadata>(candidate);
    if (parsed) return { path: candidate, meta: parsed };
  }
  return {};
}

function readJsonIfExists<T>(filePath: string): T | undefined {
  if (!fs.existsSync(filePath)) return undefined;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8")) as T;
  } catch {
    return undefined;
  }
}
