import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { mediaKindForExtension, type MediaKind } from "../media/media-kind-registry.js";

export class StillImageGroundingError extends Error {
  readonly code = "STILL_IMAGE_GROUNDING_INVALID";
  constructor(readonly issues: string[]) {
    super(`still_image_grounding_invalid: ${issues.join("; ")}`);
    this.name = "StillImageGroundingError";
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function sha256(filePath: string): string {
  return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function addRecognizedKind(kinds: Set<MediaKind>, value: unknown): void {
  if (value === "video" || value === "audio" || value === "image" || value === "sequence") {
    kinds.add(value);
  }
}

function addLocatorKind(kinds: Set<MediaKind>, value: unknown): void {
  if (typeof value !== "string") return;
  const kind = mediaKindForExtension(value);
  if (kind !== "unknown") kinds.add(kind);
}

function readSourceMapKinds(projectDir: string): Map<string, Set<MediaKind>> {
  const result = new Map<string, Set<MediaKind>>();
  const sourceMapPath = path.join(projectDir, "02_media", "source_map.json");
  if (!fs.existsSync(sourceMapPath)) return result;
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(sourceMapPath, "utf8"));
  } catch {
    return result;
  }
  const doc = record(raw);
  const rows: Array<{ assetId: string; value: unknown }> = [];
  if (Array.isArray(doc?.items)) {
    for (const value of doc.items) {
      const item = record(value);
      if (typeof item?.asset_id === "string") rows.push({ assetId: item.asset_id, value: item });
    }
  } else if (Array.isArray(doc?.source_map)) {
    for (const value of doc.source_map) {
      const item = record(value);
      if (typeof item?.asset_id === "string") rows.push({ assetId: item.asset_id, value: item });
    }
  } else if (doc) {
    for (const [assetId, value] of Object.entries(doc)) rows.push({ assetId, value });
  }
  for (const { assetId, value } of rows) {
    const kinds = result.get(assetId) ?? new Set<MediaKind>();
    if (typeof value === "string") {
      addLocatorKind(kinds, value);
    } else {
      const item = record(value);
      addRecognizedKind(kinds, item?.media_kind);
      for (const key of ["source_locator", "local_source_path", "link_path", "filename"]) {
        addLocatorKind(kinds, item?.[key]);
      }
    }
    result.set(assetId, kinds);
  }
  return result;
}

function assetTruthKinds(asset: Record<string, unknown>): Set<MediaKind> {
  const kinds = new Set<MediaKind>();
  addRecognizedKind(kinds, asset.media_kind);
  const sequence = asset.media_kind === "sequence" || Boolean(record(asset.image_sequence));
  if (!sequence) {
    addLocatorKind(kinds, asset.filename);
    addLocatorKind(kinds, asset.source_locator);
  }
  if (record(asset.still_image) || asset.duration_semantics === "single_frame_zero_duration" || asset.frame_rate_mode === "still_image") {
    kinds.add("image");
  }
  return kinds;
}

function hasKindConflict(kinds: Set<MediaKind>): boolean {
  return kinds.has("image") && [...kinds].some((kind) => kind !== "image");
}

function verifiedArtifactRealpath(evidence: Record<string, unknown>, realFrame: string): string | undefined {
  const artifact = typeof evidence.artifact_ref === "string" ? evidence.artifact_ref : "";
  if (!artifact || !path.isAbsolute(artifact)) return undefined;
  try {
    const realArtifact = fs.realpathSync(artifact);
    const stat = fs.statSync(realArtifact);
    return stat.isFile() && stat.size > 0 && realArtifact === realFrame ? realArtifact : undefined;
  } catch {
    return undefined;
  }
}

function evidenceIdentity(evidence: Record<string, unknown>, realArtifact: string | undefined): string {
  return JSON.stringify({
    evidence_ref: evidence.evidence_ref,
    producer: evidence.producer,
    evidence_type: evidence.evidence_type,
    frame_us: evidence.frame_us,
    fields: strings(evidence.fields).slice().sort(),
    artifact_realpath: realArtifact,
  });
}

export function readValidatedStillImageFrames(projectDir: string): Map<string, string> {
  const analysisDir = path.join(projectDir, "03_analysis");
  const assetsPath = path.join(analysisDir, "assets.json");
  const segmentsPath = path.join(analysisDir, "segments.json");
  const assets = fs.existsSync(assetsPath)
    ? JSON.parse(fs.readFileSync(assetsPath, "utf8")) as { items?: unknown[] }
    : { items: [] };
  const assetRows = (assets.items ?? []).map(record).filter((asset): asset is Record<string, unknown> => Boolean(asset));
  const assetById = new Map(assetRows.flatMap((asset) =>
    typeof asset.asset_id === "string" ? [[asset.asset_id, asset] as const] : []));
  const sourceMapKinds = readSourceMapKinds(projectDir);
  const imageAssetIds = new Set<string>();
  for (const asset of assetRows) {
    if (typeof asset.asset_id !== "string") continue;
    const combined = new Set<MediaKind>([...assetTruthKinds(asset), ...(sourceMapKinds.get(asset.asset_id) ?? [])]);
    if (combined.has("image")) imageAssetIds.add(asset.asset_id);
  }
  for (const [assetId, kinds] of sourceMapKinds) {
    if (kinds.has("image")) imageAssetIds.add(assetId);
  }
  if (imageAssetIds.size === 0) return new Map();
  const segments = fs.existsSync(segmentsPath)
    ? JSON.parse(fs.readFileSync(segmentsPath, "utf8")) as { items?: unknown[] }
    : { items: [] };
  const segmentRows = (segments.items ?? []).map(record).filter((item): item is Record<string, unknown> => Boolean(item));
  const issues: string[] = [];
  const validated = new Map<string, string>();

  for (const assetId of [...imageAssetIds].sort()) {
    const asset = assetById.get(assetId);
    if (!asset) {
      issues.push(`${assetId}:authoritative_image_asset_missing_from_assets`);
      continue;
    }
    const combinedKinds = new Set<MediaKind>([...assetTruthKinds(asset), ...(sourceMapKinds.get(assetId) ?? [])]);
    if (hasKindConflict(combinedKinds)) issues.push(`${assetId}:authoritative_media_kind_conflict`);
    const still = record(asset.still_image);
    const relative = typeof still?.normalized_frame_path === "string" ? still.normalized_frame_path : "";
    const expectedHash = typeof still?.normalized_frame_content_sha256 === "string" ? still.normalized_frame_content_sha256 : "";
    if (!relative || path.isAbsolute(relative) || relative.split(/[\\/]/).includes("..")) {
      issues.push(`${assetId}:normalized_frame_path_not_project_relative`);
      continue;
    }
    const framePath = path.resolve(analysisDir, relative);
    if (!framePath.startsWith(`${path.resolve(analysisDir)}${path.sep}`)) {
      issues.push(`${assetId}:normalized_frame_path_escape`);
      continue;
    }
    if (!fs.existsSync(framePath) || !fs.statSync(framePath).isFile() || fs.statSync(framePath).size <= 0) {
      issues.push(`${assetId}:normalized_frame_missing_or_empty`);
      continue;
    }
    const realAnalysis = fs.realpathSync(analysisDir);
    const realFrame = fs.realpathSync(framePath);
    if (fs.lstatSync(framePath).isSymbolicLink() ||
      (realFrame !== realAnalysis && !realFrame.startsWith(`${realAnalysis}${path.sep}`))) {
      issues.push(`${assetId}:normalized_frame_symlink_or_realpath_escape`);
      continue;
    }
    if (!isSha256(expectedHash) || sha256(framePath) !== expectedHash) {
      issues.push(`${assetId}:normalized_frame_hash_mismatch`);
    }

    const assetSha = typeof asset.source_content_sha256 === "string" ? asset.source_content_sha256 : "";
    if (!isSha256(assetSha)) issues.push(`${assetId}:source_content_sha256_invalid`);
    const imageSegments = segmentRows.filter((segment) => segment.asset_id === assetId);
    if (imageSegments.length !== 1) issues.push(`${assetId}:image_identity_segment_count_${imageSegments.length}`);
    for (const segment of imageSegments) {
      const segmentId = typeof segment.segment_id === "string" ? segment.segment_id : "unknown";
      if (segment.src_in_us !== 0 || segment.src_out_us !== 1) issues.push(`${segmentId}:source_identity_range_mismatch`);
      const tags = record(record(segment.provenance)?.tags);
      const tagSourceSha = tags?.source_content_sha256;
      const frameHashes = strings(tags?.frame_content_sha256);
      if (!isSha256(tagSourceSha) || tagSourceSha !== assetSha) issues.push(`${segmentId}:source_identity_mismatch`);
      if (frameHashes.length !== 1 || !isSha256(frameHashes[0]) || frameHashes[0] !== expectedHash) {
        issues.push(`${segmentId}:frame_content_sha256_mismatch`);
      }
      if (tags?.frame_count !== 1 || frameHashes.length !== 1) issues.push(`${segmentId}:frame_count_mismatch`);
      const observation = record(segment.editorial_observation);
      const grounded = record(record(observation?.producer_snapshots)?.grounded_vlm);
      const observationProvenance = record(observation?.provenance);
      const provenanceProducers = Array.isArray(observationProvenance?.producers)
        ? observationProvenance.producers.map(record).filter((item): item is Record<string, unknown> => Boolean(item))
        : [];
      const producer = provenanceProducers.find((item) => item.producer === "grounded_vlm");
      const snapshotProducer = record(grounded?.producer);
      const evidence = Array.isArray(observation?.evidence)
        ? observation.evidence.map(record).filter((item): item is Record<string, unknown> => Boolean(item))
        : [];
      const groundedEvidence = evidence.filter((item) => item.producer === "grounded_vlm" && item.evidence_type === "verified_frame");
      const snapshotEvidence = Array.isArray(grounded?.evidence)
        ? grounded.evidence.map(record).filter((item): item is Record<string, unknown> => item?.evidence_type === "verified_frame")
        : [];
      const evidenceRefs = groundedEvidence.flatMap((item) => typeof item.evidence_ref === "string" ? [item.evidence_ref] : []);
      const snapshotRefs = snapshotEvidence.flatMap((item) => typeof item.evidence_ref === "string" ? [item.evidence_ref] : []);
      const producerRefs = strings(producer?.evidence_refs);
      const expectedCacheIdentity = typeof tags?.cache_identity === "string" ? tags.cache_identity : undefined;
      if (!observation || observation.status !== "ready" || strings(observation.warnings).length > 0 || !grounded) {
        issues.push(`${segmentId}:editorial_observation_not_grounded`);
      } else if (!producer || !snapshotProducer) {
        issues.push(`${segmentId}:grounded_vlm_producer_missing`);
      } else {
        if (producer.actual_verified_frame_count !== 1 ||
          snapshotProducer.actual_verified_frame_count !== 1 ||
          groundedEvidence.length !== 1 || snapshotEvidence.length !== 1) {
          issues.push(`${segmentId}:verified_frame_count_mismatch`);
        }
        if (!isSha256(producer.source_content_sha256) ||
          producer.source_content_sha256 !== assetSha ||
          producer.source_content_sha256 !== tagSourceSha) issues.push(`${segmentId}:producer_source_identity_mismatch`);
        if (!expectedCacheIdentity || producer.cache_identity !== expectedCacheIdentity) issues.push(`${segmentId}:producer_cache_identity_mismatch`);
        if (!isSha256(snapshotProducer.source_content_sha256) ||
          snapshotProducer.actual_verified_frame_count !== producer.actual_verified_frame_count ||
          snapshotProducer.source_content_sha256 !== producer.source_content_sha256 ||
          snapshotProducer.cache_identity !== producer.cache_identity) issues.push(`${segmentId}:snapshot_producer_mismatch`);
        if (evidenceRefs.length !== 1 || snapshotRefs.length !== 1 || producerRefs.length !== 1 ||
          !evidenceRefs[0] || !snapshotRefs[0] || !producerRefs[0] ||
          evidenceRefs[0] !== snapshotRefs[0] || evidenceRefs[0] !== producerRefs[0]) {
          issues.push(`${segmentId}:verified_frame_evidence_set_mismatch`);
        }
        const evidenceArtifacts = groundedEvidence.map((item) => verifiedArtifactRealpath(item, realFrame));
        const snapshotArtifacts = snapshotEvidence.map((item) => verifiedArtifactRealpath(item, realFrame));
        if (evidenceArtifacts.some((artifact) => artifact === undefined)) {
          issues.push(`${segmentId}:verified_frame_artifact_mismatch`);
        }
        if (snapshotArtifacts.some((artifact) => artifact === undefined)) {
          issues.push(`${segmentId}:snapshot_verified_frame_artifact_mismatch`);
        }
        const evidenceArtifactSet = [...new Set(evidenceArtifacts.filter((value): value is string => Boolean(value)))].sort();
        const snapshotArtifactSet = [...new Set(snapshotArtifacts.filter((value): value is string => Boolean(value)))].sort();
        if (evidenceArtifactSet.length !== 1 || snapshotArtifactSet.length !== 1 ||
          evidenceArtifactSet[0] !== snapshotArtifactSet[0]) {
          issues.push(`${segmentId}:verified_frame_artifact_set_mismatch`);
        }
        if (groundedEvidence.length === 1 && snapshotEvidence.length === 1 &&
          evidenceIdentity(groundedEvidence[0], evidenceArtifacts[0]) !==
            evidenceIdentity(snapshotEvidence[0], snapshotArtifacts[0])) {
          issues.push(`${segmentId}:verified_frame_evidence_identity_mismatch`);
        }
      }
    }
    if (!issues.some((issue) => issue.startsWith(`${assetId}:`) || imageSegments.some((segment) => issue.startsWith(`${String(segment.segment_id)}:`)))) {
      validated.set(assetId, path.relative(fs.realpathSync(projectDir), realFrame).split(path.sep).join("/"));
    }
  }

  if (issues.length > 0) throw new StillImageGroundingError(issues.sort());
  return validated;
}

export function assertStillImageGrounding(projectDir: string): void {
  readValidatedStillImageFrames(projectDir);
}

export function assertStillImageSegmentGrounding(projectDir: string): void {
  const segmentsPath = path.join(projectDir, "03_analysis", "segments.json");
  if (!fs.existsSync(segmentsPath)) {
    readValidatedStillImageFrames(projectDir);
    return;
  }
  const segments = JSON.parse(fs.readFileSync(segmentsPath, "utf8")) as { items?: unknown[] };
  const expected = (segments.items ?? [])
    .map(record)
    .filter((segment): segment is Record<string, unknown> => Boolean(segment))
    .filter((segment) => segment.media_kind === "image" ||
      record(segment.source_interval)?.semantics === "schema_compatible_single_frame_interval" ||
      record(record(segment.provenance)?.boundary)?.method === "still_image_single_frame")
    .flatMap((segment) => typeof segment.asset_id === "string" ? [segment.asset_id] : []);
  assertExpectedStillImageAssets(projectDir, expected, "segment");
}

export function assertStillImageCandidateGrounding(
  projectDir: string,
  candidates: Array<{ asset_id?: unknown; media_kind?: unknown }>,
): void {
  const expected = candidates
    .filter((candidate) => candidate.media_kind === "image")
    .flatMap((candidate) => typeof candidate.asset_id === "string" ? [candidate.asset_id] : ["unknown"]);
  assertExpectedStillImageAssets(projectDir, expected, "candidate");
}

function assertExpectedStillImageAssets(
  projectDir: string,
  expectedAssetIds: string[],
  consumer: "segment" | "candidate",
): void {
  if (expectedAssetIds.length === 0) {
    // Still validate authoritative image assets even if this consumer has none.
    readValidatedStillImageFrames(projectDir);
    return;
  }
  const validated = readValidatedStillImageFrames(projectDir);
  const missing = [...new Set(expectedAssetIds)]
    .filter((assetId) => !validated.has(assetId))
    .sort()
    .map((assetId) => `${assetId}:${consumer}_image_asset_not_grounded`);
  if (missing.length > 0) throw new StillImageGroundingError(missing);
}
