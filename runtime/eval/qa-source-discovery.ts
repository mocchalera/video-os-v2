import * as fs from "node:fs";
import * as path from "node:path";
import type { Candidate, SelectsCandidates, TimelineIR } from "../artifacts/types.js";
import { loadSourceMap } from "../media/source-map.js";
import type { FootageEvidenceRef, FootageSearchResult } from "../tools/footage-search.js";
import { primaryVideoClips } from "./qa-issue-detector.js";

export const QA_FIX_SNAPSHOT_LIMITS = Object.freeze({
  reason_chars: 512,
  summary_chars: 512,
  transcript_chars: 1_024,
  array_items: 16,
  array_item_chars: 256,
  evidence_refs: 12,
  evidence_source_refs: 8,
});

export interface QADiscoveryContract {
  projectId: string;
  minQualityScore: number;
  iterationExcludedSegmentIds?: readonly string[];
}

export interface QAReplacementSnapshot {
  version: "1";
  project_id: string;
  segment: {
    segment_id: string;
    asset_id: string;
    src_in_us: number;
    src_out_us: number;
  };
  target: {
    clip_id: string;
    beat_id: string;
  };
  search: {
    mode: "visual" | "audio" | "hybrid";
    score: number;
    reason: string;
  };
  quality: {
    score: number;
    fields: string[];
    scores: Record<string, number>;
    source: "segments.visual_quality.scores";
    flags: string[];
  };
  summary: string;
  transcript_excerpt: string;
  tags: string[];
  search_evidence_refs: Array<{
    field: string;
    value: string;
    score?: number;
    source_refs?: string[];
  }>;
  canonical_evidence_refs: string[];
  canonical_source_ref: string;
  asset_source_ref: string;
}

export interface CanonicalSegment {
  segment_id: string;
  asset_id: string;
  src_in_us: number;
  src_out_us: number;
  summary?: string;
  transcript_excerpt?: string;
  quality_flags?: string[];
  tags?: string[];
  visual_quality?: { scores?: Record<string, unknown> };
  editorial_observation?: { evidence?: Array<{ evidence_ref?: unknown; artifact_ref?: unknown }> };
}

interface AssetRecord {
  asset_id: string;
  source_locator?: string;
}

interface CanonicalArtifacts {
  segmentsProjectId?: string;
  assetsProjectId?: string;
  segments: Map<string, CanonicalSegment>;
  assets: Map<string, AssetRecord>;
}

export interface CanonicalReplacement {
  segment: CanonicalSegment;
  qualityScore: number;
  qualityFields: string[];
  qualityScores: Record<string, number>;
  sourceRef: string;
}

export function defaultDiscoveryContract(projectId: string, minQualityScore = 0.5): QADiscoveryContract {
  return { projectId, minQualityScore };
}

export function resolveCanonicalReplacement(
  projectDir: string,
  segmentId: string,
  contract: QADiscoveryContract,
): CanonicalReplacement | null {
  if (!isQASnapshotSafeIdentifier(contract.projectId) || !isQASnapshotSafeIdentifier(segmentId)) return null;
  const artifacts = loadCanonicalArtifacts(projectDir);
  if (artifacts.segmentsProjectId !== contract.projectId || artifacts.assetsProjectId !== contract.projectId) return null;
  const segment = artifacts.segments.get(segmentId);
  if (!isCompleteSegment(segment)) return null;
  if (!isQASnapshotSafeIdentifier(segment.asset_id)) return null;
  const quality = canonicalQuality(segment);
  if (!quality || quality.score < contract.minQualityScore) return null;
  const asset = artifacts.assets.get(segment.asset_id);
  if (!asset) return null;
  const source = resolveExistingAssetSource(projectDir, asset, contract.projectId);
  if (!source) return null;
  return {
    segment,
    qualityScore: quality.score,
    qualityFields: quality.fields,
    qualityScores: quality.scores,
    sourceRef: source.ref,
  };
}

export function buildReplacementSnapshot(input: {
  canonical: CanonicalReplacement;
  result: FootageSearchResult;
  contract: QADiscoveryContract;
  targetClipId: string;
  targetBeatId: string;
  searchMode: QAReplacementSnapshot["search"]["mode"];
  searchScore: number;
  reason: string;
}): QAReplacementSnapshot {
  const { canonical, result, contract } = input;
  return {
    version: "1",
    project_id: contract.projectId,
    segment: {
      segment_id: canonical.segment.segment_id,
      asset_id: canonical.segment.asset_id,
      src_in_us: canonical.segment.src_in_us,
      src_out_us: canonical.segment.src_out_us,
    },
    target: { clip_id: input.targetClipId, beat_id: input.targetBeatId },
    search: {
      mode: input.searchMode,
      score: finiteRound3(input.searchScore),
      reason: normalizeQASnapshotString(input.reason, QA_FIX_SNAPSHOT_LIMITS.reason_chars),
    },
    quality: {
      score: finiteRound3(canonical.qualityScore),
      fields: boundedStrings(canonical.qualityFields),
      scores: Object.fromEntries(Object.entries(canonical.qualityScores).map(([field, score]) => [field, finiteRound3(score)])),
      source: "segments.visual_quality.scores",
      flags: boundedStrings(canonical.segment.quality_flags),
    },
    summary: normalizeQASnapshotString(canonical.segment.summary ?? "", QA_FIX_SNAPSHOT_LIMITS.summary_chars),
    transcript_excerpt: normalizeQASnapshotString(canonical.segment.transcript_excerpt ?? "", QA_FIX_SNAPSHOT_LIMITS.transcript_chars),
    tags: boundedStrings(canonical.segment.tags),
    search_evidence_refs: boundedEvidenceRefs(result.evidence_refs),
    canonical_evidence_refs: canonicalEvidenceRefs(canonical),
    canonical_source_ref: `03_analysis/segments.json#${encodeURIComponent(canonical.segment.segment_id)}`,
    asset_source_ref: canonical.sourceRef,
  };
}

export function validateExternalReplacement(input: {
  projectDir: string;
  snapshot: QAReplacementSnapshot | undefined;
  segmentId: string;
  contract: QADiscoveryContract;
  targetClipId: string;
  targetBeatId: string;
  searchMode: QAReplacementSnapshot["search"]["mode"];
  searchScore: number;
  reason: string;
}): CanonicalReplacement | null {
  const snapshot = input.snapshot;
  if (!snapshot || !hasSnapshotShape(snapshot) || snapshot.version !== "1") return null;
  if (snapshot.project_id !== input.contract.projectId) return null;
  if (snapshot.target.clip_id !== input.targetClipId || snapshot.target.beat_id !== input.targetBeatId) return null;
  if (snapshot.segment.segment_id !== input.segmentId) return null;
  if (
    !isQASnapshotSafeIdentifier(snapshot.project_id)
    || !isQASnapshotSafeIdentifier(snapshot.segment.segment_id)
    || !isQASnapshotSafeIdentifier(snapshot.segment.asset_id)
    || !isQASnapshotSafeIdentifier(snapshot.target.clip_id)
    || !isQASnapshotSafeIdentifier(snapshot.target.beat_id)
  ) return null;
  if (
    snapshot.search.mode !== input.searchMode
    || !["visual", "audio", "hybrid"].includes(input.searchMode)
    || !Number.isFinite(input.searchScore)
    || input.searchScore < 0
    || input.searchScore > 1
    || snapshot.search.score !== finiteRound3(input.searchScore)
    || typeof input.reason !== "string"
    || input.reason !== normalizeQASnapshotString(input.reason, QA_FIX_SNAPSHOT_LIMITS.reason_chars)
    || snapshot.search.reason !== input.reason
    || !validSearchEvidenceRefs(snapshot.search_evidence_refs)
  ) return null;
  const canonical = resolveCanonicalReplacement(input.projectDir, input.segmentId, input.contract);
  if (!canonical) return null;
  if (
    snapshot.segment.asset_id !== canonical.segment.asset_id
    || snapshot.segment.src_in_us !== canonical.segment.src_in_us
    || snapshot.segment.src_out_us !== canonical.segment.src_out_us
    || snapshot.quality.score !== finiteRound3(canonical.qualityScore)
    || JSON.stringify(snapshot.quality.fields) !== JSON.stringify(boundedStrings(canonical.qualityFields))
    || JSON.stringify(snapshot.quality.scores) !== JSON.stringify(
      Object.fromEntries(Object.entries(canonical.qualityScores).map(([field, score]) => [field, finiteRound3(score)])),
    )
    || snapshot.quality.source !== "segments.visual_quality.scores"
    || JSON.stringify(snapshot.quality.flags) !== JSON.stringify(boundedStrings(canonical.segment.quality_flags))
    || JSON.stringify(snapshot.canonical_evidence_refs) !== JSON.stringify(canonicalEvidenceRefs(canonical))
    || snapshot.summary !== normalizeQASnapshotString(canonical.segment.summary ?? "", QA_FIX_SNAPSHOT_LIMITS.summary_chars)
    || snapshot.transcript_excerpt !== normalizeQASnapshotString(canonical.segment.transcript_excerpt ?? "", QA_FIX_SNAPSHOT_LIMITS.transcript_chars)
    || JSON.stringify(snapshot.tags) !== JSON.stringify(boundedStrings(canonical.segment.tags))
    || snapshot.canonical_source_ref !== `03_analysis/segments.json#${encodeURIComponent(input.segmentId)}`
    || snapshot.asset_source_ref !== canonical.sourceRef
  ) return null;
  return canonical;
}

function hasSnapshotShape(snapshot: unknown): snapshot is QAReplacementSnapshot {
  if (!isRecord(snapshot)) return false;
  const segment = snapshot.segment;
  const target = snapshot.target;
  const search = snapshot.search;
  const quality = snapshot.quality;
  return isRecord(segment)
    && typeof segment.segment_id === "string"
    && typeof segment.asset_id === "string"
    && typeof segment.src_in_us === "number"
    && typeof segment.src_out_us === "number"
    && isRecord(target)
    && typeof target.clip_id === "string"
    && typeof target.beat_id === "string"
    && isRecord(search)
    && typeof search.mode === "string"
    && typeof search.score === "number"
    && typeof search.reason === "string"
    && isRecord(quality)
    && typeof quality.score === "number"
    && Array.isArray(quality.fields)
    && isRecord(quality.scores)
    && typeof quality.source === "string"
    && Array.isArray(quality.flags)
    && typeof snapshot.summary === "string"
    && typeof snapshot.transcript_excerpt === "string"
    && Array.isArray(snapshot.tags)
    && Array.isArray(snapshot.search_evidence_refs)
    && Array.isArray(snapshot.canonical_evidence_refs)
    && typeof snapshot.canonical_source_ref === "string"
    && typeof snapshot.asset_source_ref === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

export function replacementIsExcluded(
  segmentId: string,
  timeline: TimelineIR,
  selects: SelectsCandidates,
  contract: QADiscoveryContract,
): boolean {
  if (primaryVideoClips(timeline).some((clip) => clip.segment_id === segmentId)) return true;
  if (selects.candidates.some((candidate) => candidate.segment_id === segmentId && candidate.role === "reject")) return true;
  return contract.iterationExcludedSegmentIds?.includes(segmentId) ?? false;
}

export function existingEligibleCandidate(
  selects: SelectsCandidates,
  segmentId: string,
  beatId: string,
): Candidate | undefined {
  return selects.candidates.find((candidate) =>
    candidate.segment_id === segmentId
    && candidate.role !== "reject"
    && (!candidate.eligible_beats || candidate.eligible_beats.includes(beatId))
  );
}

function loadCanonicalArtifacts(projectDir: string): CanonicalArtifacts {
  const segmentsDoc = readObject(path.join(projectDir, "03_analysis", "segments.json"));
  const assetsDoc = readObject(path.join(projectDir, "03_analysis", "assets.json"));
  return {
    segmentsProjectId: stringField(segmentsDoc, "project_id"),
    assetsProjectId: stringField(assetsDoc, "project_id"),
    segments: itemMap<CanonicalSegment>(segmentsDoc, "segment_id"),
    assets: itemMap<AssetRecord>(assetsDoc, "asset_id"),
  };
}

function resolveExistingAssetSource(projectDir: string, asset: AssetRecord, projectId: string): { ref: string } | null {
  const sourceMapPath = path.join(projectDir, "02_media", "source_map.json");
  if (fs.existsSync(sourceMapPath)) {
    const sourceMapDoc = readObject(sourceMapPath);
    if (stringField(sourceMapDoc, "project_id") !== projectId) return null;
    try {
      const mapped = loadSourceMap(projectDir).locatorMap.get(asset.asset_id);
      if (!mapped || !isRegularFile(mapped)) return null;
      return { ref: `02_media/source_map.json#${encodeURIComponent(asset.asset_id)}` };
    } catch {
      return null;
    }
  }
  if (typeof asset.source_locator !== "string" || asset.source_locator.length === 0) return null;
  const sourcePath = path.isAbsolute(asset.source_locator)
    ? asset.source_locator
    : path.resolve(projectDir, asset.source_locator);
  if (!isRegularFile(sourcePath)) return null;
  return { ref: `03_analysis/assets.json#${encodeURIComponent(asset.asset_id)}` };
}

const CANONICAL_QUALITY_FIELDS = [
  "composition_score",
  "emotional_expression",
  "light_quality",
  "motion_quality",
  "subject_prominence",
] as const;

function canonicalQuality(segment: CanonicalSegment): { score: number; fields: string[]; scores: Record<string, number> } | null {
  const scores = segment.visual_quality?.scores ?? {};
  const fields = CANONICAL_QUALITY_FIELDS
    .flatMap((field) => {
      const value = scores[field];
      return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1
        ? [[field, value] as const]
        : [];
    })
    .sort(([left], [right]) => left.localeCompare(right));
  if (fields.length === 0) return null;
  return {
    score: fields.reduce((sum, [, score]) => sum + score, 0) / fields.length,
    fields: fields.map(([field]) => field),
    scores: Object.fromEntries(fields),
  };
}

function isCompleteSegment(segment: CanonicalSegment | undefined): segment is CanonicalSegment {
  return Boolean(
    segment
    && typeof segment.segment_id === "string"
    && typeof segment.asset_id === "string"
    && Number.isFinite(segment.src_in_us)
    && Number.isFinite(segment.src_out_us)
    && segment.src_out_us > segment.src_in_us
    && typeof segment.summary === "string"
    && typeof segment.transcript_excerpt === "string"
    && Array.isArray(segment.quality_flags)
    && segment.quality_flags.every((flag) => typeof flag === "string")
    && Array.isArray(segment.tags)
    && segment.tags.every((tag) => typeof tag === "string"),
  );
}

function readObject(filePath: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

function stringField(doc: Record<string, unknown> | undefined, field: string): string | undefined {
  const value = doc?.[field];
  return typeof value === "string" ? value : undefined;
}

function itemMap<T extends object>(doc: Record<string, unknown> | undefined, idField: string): Map<string, T> {
  const items = Array.isArray(doc?.items) ? doc.items : [];
  return new Map(items.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const id = (item as Record<string, unknown>)[idField];
    return typeof id === "string" ? [[id, item as T] as const] : [];
  }));
}

export function normalizeQASnapshotString(value: string, limit: number): string {
  const normalized = value.replace(/[\u0000-\u001f\u007f]/gu, " ").trim();
  return (containsAbsolutePath(normalized) ? "[absolute-path-omitted]" : normalized).slice(0, limit);
}

export function isQASnapshotSafeIdentifier(value: string): boolean {
  return value.length > 0
    && value === normalizeQASnapshotString(value, QA_FIX_SNAPSHOT_LIMITS.array_item_chars)
    && value !== "[absolute-path-omitted]";
}

function boundedStrings(values: readonly string[] | undefined): string[] {
  return [...new Set((values ?? []).filter((value): value is string => typeof value === "string")
    .map((value) => normalizeQASnapshotString(value, QA_FIX_SNAPSHOT_LIMITS.array_item_chars))
    .filter(Boolean))]
    .sort((left, right) => left.localeCompare(right))
    .slice(0, QA_FIX_SNAPSHOT_LIMITS.array_items);
}

function boundedEvidenceRefs(values: FootageEvidenceRef[] | undefined): QAReplacementSnapshot["search_evidence_refs"] {
  return [...(values ?? [])]
    .sort((left, right) => `${left.field}\u0000${left.value}`.localeCompare(`${right.field}\u0000${right.value}`))
    .slice(0, QA_FIX_SNAPSHOT_LIMITS.evidence_refs).map((ref) => ({
    field: normalizeQASnapshotString(ref.field, QA_FIX_SNAPSHOT_LIMITS.array_item_chars),
    value: normalizeQASnapshotString(ref.value, QA_FIX_SNAPSHOT_LIMITS.array_item_chars),
    ...(typeof ref.score === "number" && Number.isFinite(ref.score) ? { score: finiteRound3(ref.score) } : {}),
    ...(ref.source_refs?.length ? {
      source_refs: boundedStrings(ref.source_refs.filter(isSafeArtifactRef))
        .slice(0, QA_FIX_SNAPSHOT_LIMITS.evidence_source_refs),
    } : {}),
  }));
}

function validSearchEvidenceRefs(value: unknown): value is QAReplacementSnapshot["search_evidence_refs"] {
  if (!Array.isArray(value) || value.length > QA_FIX_SNAPSHOT_LIMITS.evidence_refs) return false;
  return value.every((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
    const record = entry as Record<string, unknown>;
    if (Object.keys(record).some((key) => !["field", "value", "score", "source_refs"].includes(key))) return false;
    if (!isNormalizedSnapshotString(record.field, QA_FIX_SNAPSHOT_LIMITS.array_item_chars)) return false;
    if (!isNormalizedSnapshotString(record.value, QA_FIX_SNAPSHOT_LIMITS.array_item_chars)) return false;
    if (record.score !== undefined && (
      typeof record.score !== "number"
      || !Number.isFinite(record.score)
      || record.score !== finiteRound3(record.score)
    )) return false;
    if (record.source_refs !== undefined && (
      !Array.isArray(record.source_refs)
      || record.source_refs.length > QA_FIX_SNAPSHOT_LIMITS.evidence_source_refs
      || !record.source_refs.every((sourceRef) =>
        isNormalizedSnapshotString(sourceRef, QA_FIX_SNAPSHOT_LIMITS.array_item_chars)
        && isSafeArtifactRef(sourceRef)
      )
    )) return false;
    return true;
  });
}

function isNormalizedSnapshotString(value: unknown, limit: number): value is string {
  return typeof value === "string" && value === normalizeQASnapshotString(value, limit);
}

function canonicalEvidenceRefs(canonical: CanonicalReplacement): string[] {
  const observationRefs = canonical.segment.editorial_observation?.evidence?.flatMap((evidence) => [
    typeof evidence.evidence_ref === "string" ? evidence.evidence_ref : undefined,
    typeof evidence.artifact_ref === "string" ? evidence.artifact_ref : undefined,
  ].filter((value): value is string => Boolean(value))) ?? [];
  return boundedStrings([
    ...canonical.qualityFields.map((field) => `03_analysis/segments.json#${encodeURIComponent(canonical.segment.segment_id)}/visual_quality/scores/${field}`),
    ...(canonical.segment.tags?.length ? [`03_analysis/segments.json#${encodeURIComponent(canonical.segment.segment_id)}/tags`] : []),
    ...observationRefs.filter(isSafeArtifactRef),
  ]);
}

function containsAbsolutePath(value: string): boolean {
  const normalized = value.trim();
  return path.posix.isAbsolute(normalized)
    || path.win32.isAbsolute(normalized)
    || /^file:\/\//iu.test(normalized)
    || /(?:^|\s)\/(?:[^\s]+)/u.test(normalized)
    || /(?:^|\s)[A-Za-z]:\\(?:[^\s]+)/u.test(normalized)
    || /(?:^|\s)\\\\(?:[^\s]+)/u.test(normalized);
}

function isSafeArtifactRef(value: unknown): value is string {
  if (typeof value !== "string" || containsAbsolutePath(value) || /^file:\/\//iu.test(value)) return false;
  const normalized = value.replace(/\\/gu, "/");
  return normalized !== ".." && !normalized.startsWith("../") && !normalized.includes("/../");
}

function isRegularFile(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function finiteRound3(value: number): number {
  return Number.isFinite(value) ? Math.round(value * 1_000) / 1_000 : 0;
}
