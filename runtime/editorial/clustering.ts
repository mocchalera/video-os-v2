import * as fs from "node:fs";
import * as path from "node:path";
import type { Candidate, SelectsCandidates } from "../artifacts/types.js";
import type { SegmentItem as BaseSegmentItem } from "../connectors/ffmpeg-segmenter.js";

type ClusterEntry = {
  candidateIndex: number;
  summary: string;
};

type TimestampClusterEntry = {
  candidateIndex: number;
  segment: SegmentItem;
  candidate: Candidate;
  timestamp: FilmingTimestamp;
};

const DEFAULT_CLUSTER_SIMILARITY_THRESHOLD = 0.92;
const TIMESTAMP_SESSION_GAP_MS = 10 * 60 * 1000;

export interface ClusterAssetMetadata {
  asset_id: string;
  filename?: string;
  display_name?: string;
  source_locator?: string;
  mtime?: string | number | Date;
  mtime_ms?: number;
  modified_at?: string;
  source_mtime?: string | number | Date;
}

export interface RefineClusterOptions {
  assets?: ClusterAssetMetadata[];
  projectDir?: string;
}

export interface FilmingTimestamp {
  dateKey: string;
  monthDayKey: string;
  timeKey: string;
  epochMs: number;
  source: "filename" | "mtime";
}

export type SegmentItem = BaseSegmentItem;

export function loadClusterAssetMetadata(projectDir: string): ClusterAssetMetadata[] | undefined {
  const assetsPath = path.join(projectDir, "03_analysis/assets.json");
  if (!fs.existsSync(assetsPath)) return undefined;
  try {
    const parsed = JSON.parse(fs.readFileSync(assetsPath, "utf-8")) as { items?: unknown };
    if (!Array.isArray(parsed.items)) return undefined;
    return parsed.items.flatMap((item): ClusterAssetMetadata[] => {
      if (!item || typeof item !== "object") return [];
      const asset = item as {
        asset_id?: unknown;
        filename?: unknown;
        display_name?: unknown;
        source_locator?: unknown;
        mtime?: unknown;
        mtime_ms?: unknown;
        modified_at?: unknown;
        source_mtime?: unknown;
      };
      if (typeof asset.asset_id !== "string" || asset.asset_id.length === 0) return [];
      const result: ClusterAssetMetadata = {
        asset_id: asset.asset_id,
        ...(typeof asset.filename === "string" ? { filename: asset.filename } : {}),
        ...(typeof asset.display_name === "string" ? { display_name: asset.display_name } : {}),
        ...(typeof asset.source_locator === "string" ? { source_locator: asset.source_locator } : {}),
        ...(typeof asset.mtime === "string" || typeof asset.mtime === "number" ? { mtime: asset.mtime } : {}),
        ...(typeof asset.mtime_ms === "number" ? { mtime_ms: asset.mtime_ms } : {}),
        ...(typeof asset.modified_at === "string" ? { modified_at: asset.modified_at } : {}),
        ...(typeof asset.source_mtime === "string" || typeof asset.source_mtime === "number"
          ? { source_mtime: asset.source_mtime }
          : {}),
      };
      return [result];
    });
  } catch {
    return undefined;
  }
}

export async function refineClusters(
  selects: SelectsCandidates,
  segments: SegmentItem[],
  options: RefineClusterOptions = {},
): Promise<SelectsCandidates> {
  const segmentsById = new Map(segments.map((segment) => [segment.segment_id, segment]));
  const timestampClusters = buildTimestampClusterAssignments(selects, segmentsById, options);
  if (timestampClusters.size > 0) {
    const clusterableCandidates = selects.candidates.filter(
      (candidate) => candidate.role !== "reject" && segmentsById.has(candidate.segment_id),
    ).length;
    if (timestampClusters.size === clusterableCandidates) {
      return applyRefinedClusters(selects, segmentsById, timestampClusters);
    }
    const fallbackSelects = await refineClustersWithoutTimestamps(selects, segmentsById);
    return applyRefinedClusters(fallbackSelects, segmentsById, timestampClusters);
  }

  return refineClustersWithoutTimestamps(selects, segmentsById);
}

async function refineClustersWithoutTimestamps(
  selects: SelectsCandidates,
  segmentsById: Map<string, SegmentItem>,
): Promise<SelectsCandidates> {
  const hasMotifs = selects.candidates.some((c) => c.role !== "reject" && c.motif_tags && c.motif_tags.length > 0);
  if (hasMotifs) {
    return refineClustersByMotifTags(selects, segmentsById);
  }

  const entries: ClusterEntry[] = [];
  for (let candidateIndex = 0; candidateIndex < selects.candidates.length; candidateIndex += 1) {
    const candidate = selects.candidates[candidateIndex];
    if (candidate.role === "reject") continue;
    const segment = segmentsById.get(candidate.segment_id);
    const motifs = (candidate.motif_tags ?? []).join(", ");
    const firstEvidence = (candidate.evidence ?? [])[0] ?? "";
    const segSummary = segment?.summary?.trim() ?? "";
    const summary = [motifs, firstEvidence, segSummary].filter(Boolean).join(". ");
    if (!summary) continue;
    entries.push({ candidateIndex, summary });
  }

  if (entries.length === 0) {
    return applyFallbackClusters(selects, segmentsById);
  }

  try {
    const { embedTexts } = await import("../eval/semantic-match.js");
    const embeddings = await embedTexts(entries.map((entry) => entry.summary), "passage");
    if (embeddings.length !== entries.length) {
      return applyFallbackClusters(selects, segmentsById);
    }

    const clusterByEntryIndex = agglomerativeClusters(
      embeddings,
      entries.map((entry) => entry.summary),
      DEFAULT_CLUSTER_SIMILARITY_THRESHOLD,
    );
    const clusterByCandidateIndex = new Map<number, string>();
    for (let entryIndex = 0; entryIndex < entries.length; entryIndex += 1) {
      const clusterId = clusterByEntryIndex.get(entryIndex);
      if (clusterId) {
        clusterByCandidateIndex.set(entries[entryIndex].candidateIndex, clusterId);
      }
    }
    return applyRefinedClusters(selects, segmentsById, clusterByCandidateIndex);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[triage:semantic-clusters] embedding refinement skipped (${message})`);
    return applyFallbackClusters(selects, segmentsById);
  }
}

export function parseFilmingTimestamp(value: string): FilmingTimestamp | undefined {
  const match = value.match(/(\d{4})-(\d{2})-(\d{2})[_\s-](\d{2})(\d{2})(?=\D|$)/);
  if (!match) return undefined;
  const [, yearText, monthText, dayText, hourText, minuteText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  if (!isValidDateTime(year, month, day, hour, minute)) return undefined;
  return {
    dateKey: `${yearText}${monthText}${dayText}`,
    monthDayKey: `${monthText}${dayText}`,
    timeKey: `${hourText}${minuteText}`,
    epochMs: Date.UTC(year, month - 1, day, hour, minute),
    source: "filename",
  };
}

function buildTimestampClusterAssignments(
  selects: SelectsCandidates,
  segmentsById: Map<string, SegmentItem>,
  options: RefineClusterOptions,
): Map<number, string> {
  const assetsById = new Map((options.assets ?? []).map((asset) => [asset.asset_id, asset]));
  const entries: TimestampClusterEntry[] = [];
  for (let candidateIndex = 0; candidateIndex < selects.candidates.length; candidateIndex += 1) {
    const candidate = selects.candidates[candidateIndex];
    if (candidate.role === "reject") continue;
    const segment = segmentsById.get(candidate.segment_id);
    if (!segment) continue;
    const asset = assetsById.get(candidate.asset_id) ?? assetsById.get(segment.asset_id);
    const timestamp = timestampForAsset(asset, segment, options.projectDir);
    if (!timestamp) continue;
    entries.push({ candidateIndex, segment, candidate, timestamp });
  }
  if (entries.length === 0) return new Map();

  const sortedEntries = [...entries].sort((a, b) => {
    if (a.timestamp.epochMs !== b.timestamp.epochMs) return a.timestamp.epochMs - b.timestamp.epochMs;
    return a.candidateIndex - b.candidateIndex;
  });

  const sessions: TimestampClusterEntry[][] = [];
  for (const entry of sortedEntries) {
    const current = sessions[sessions.length - 1];
    const previous = current?.[current.length - 1];
    if (
      previous &&
      previous.timestamp.dateKey === entry.timestamp.dateKey &&
      entry.timestamp.epochMs - previous.timestamp.epochMs <= TIMESTAMP_SESSION_GAP_MS
    ) {
      current.push(entry);
    } else {
      sessions.push([entry]);
    }
  }

  const usedClusterIds = new Map<string, number>();
  const clusterByCandidateIndex = new Map<number, string>();
  for (const session of sessions) {
    const firstTimestamp = session[0].timestamp;
    const semanticName = timestampSessionSemanticName(session);
    const baseClusterId = semanticName
      ? `${semanticName}_${firstTimestamp.monthDayKey}_${firstTimestamp.timeKey}`
      : `scene_${firstTimestamp.dateKey}_${firstTimestamp.timeKey}`;
    const useCount = usedClusterIds.get(baseClusterId) ?? 0;
    usedClusterIds.set(baseClusterId, useCount + 1);
    const clusterId = useCount === 0 ? baseClusterId : `${baseClusterId}_${useCount + 1}`;
    for (const entry of session) {
      clusterByCandidateIndex.set(entry.candidateIndex, clusterId);
    }
  }
  return clusterByCandidateIndex;
}

function timestampForAsset(
  asset: ClusterAssetMetadata | undefined,
  segment: SegmentItem,
  projectDir: string | undefined,
): FilmingTimestamp | undefined {
  const sourceNames = assetSourceNames(asset, segment);
  for (const name of sourceNames) {
    const timestamp = parseFilmingTimestamp(name);
    if (timestamp) return timestamp;
  }
  if (!asset || !sourceNames.some(isActionCameraFilename)) return undefined;
  const mtimeDate = explicitMtimeDate(asset) ?? statMtimeDate(asset, projectDir);
  return mtimeDate ? timestampFromDate(mtimeDate) : undefined;
}

function assetSourceNames(asset: ClusterAssetMetadata | undefined, segment: SegmentItem): string[] {
  return [
    asset?.display_name,
    asset?.filename,
    asset?.source_locator ? basenameLike(asset.source_locator) : undefined,
    segment.asset_id,
  ].filter(isNonEmptyString);
}

function basenameLike(value: string): string {
  try {
    if (value.startsWith("file://")) {
      return path.basename(decodeURIComponent(new URL(value).pathname));
    }
  } catch {
    // Fall back to raw basename parsing below.
  }
  return path.basename(value);
}

function isActionCameraFilename(value: string): boolean {
  const basename = basenameLike(value).replace(/\.[^.]+$/, "").toUpperCase();
  return /^(?:GOPR|GP\d{2}|DJI_)\d+/.test(basename);
}

function explicitMtimeDate(asset: ClusterAssetMetadata): Date | undefined {
  return coerceMtimeDate(asset.mtime_ms) ??
    coerceMtimeDate(asset.mtime) ??
    coerceMtimeDate(asset.modified_at) ??
    coerceMtimeDate(asset.source_mtime);
}

function statMtimeDate(asset: ClusterAssetMetadata, projectDir: string | undefined): Date | undefined {
  for (const candidatePath of candidateAssetPaths(asset, projectDir)) {
    try {
      return fs.statSync(candidatePath).mtime;
    } catch {
      // Keep trying likely project-relative source locations.
    }
  }
  return undefined;
}

function candidateAssetPaths(asset: ClusterAssetMetadata, projectDir: string | undefined): string[] {
  const rawPaths = [asset.source_locator, asset.filename].filter(isNonEmptyString);
  const candidates = new Set<string>();
  for (const rawPath of rawPaths) {
    const normalized = rawPath.startsWith("file://") ? new URL(rawPath).pathname : rawPath;
    if (path.isAbsolute(normalized)) {
      candidates.add(normalized);
    } else if (projectDir) {
      candidates.add(path.join(projectDir, normalized));
      candidates.add(path.join(projectDir, "00_sources", normalized));
      candidates.add(path.join(projectDir, "02_media", normalized));
    }
  }
  return [...candidates];
}

function coerceMtimeDate(value: string | number | Date | undefined): Date | undefined {
  if (value instanceof Date && Number.isFinite(value.getTime())) return value;
  if (typeof value === "number" && Number.isFinite(value)) {
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date : undefined;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date : undefined;
  }
  return undefined;
}

function timestampFromDate(date: Date): FilmingTimestamp {
  const year = String(date.getUTCFullYear()).padStart(4, "0");
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  const hour = String(date.getUTCHours()).padStart(2, "0");
  const minute = String(date.getUTCMinutes()).padStart(2, "0");
  return {
    dateKey: `${year}${month}${day}`,
    monthDayKey: `${month}${day}`,
    timeKey: `${hour}${minute}`,
    epochMs: Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute)),
    source: "mtime",
  };
}

function timestampSessionSemanticName(entries: TimestampClusterEntry[]): string | undefined {
  const combinedText = entries
    .map((entry) => [
      ...(entry.candidate.evidence ?? []),
      entry.segment.summary,
      ...(entry.segment.tags ?? []),
    ].filter(isNonEmptyString).join(" "))
    .filter(isNonEmptyString);
  const tokens = new Set(combinedText.flatMap(tokenizeClusterTerms));
  for (const term of TIMESTAMP_SCENE_TERMS) {
    if (tokens.has(term)) return term;
  }
  const summaryName = clusterIdFromSummaries(combinedText);
  return summaryName || undefined;
}

function isValidDateTime(year: number, month: number, day: number, hour: number, minute: number): boolean {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return false;
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) return false;
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    return false;
  }
  const date = new Date(Date.UTC(year, month - 1, day, hour, minute));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day &&
    date.getUTCHours() === hour &&
    date.getUTCMinutes() === minute
  );
}

function refineClustersByMotifTags(
  selects: SelectsCandidates,
  segmentsById: Map<string, SegmentItem>,
): SelectsCandidates {
  const candidates = selects.candidates.map((candidate) => {
    if (candidate.role === "reject") return candidate;
    const motifs = (candidate.motif_tags ?? []).filter(isNonEmptyString);
    const segment = segmentsById.get(candidate.segment_id);
    const clusterId = motifs[0] ?? (segment ? deriveSemanticClusterId(segment) : "unknown");
    const editorial = { ...(candidate.editorial_signals ?? {}) };
    editorial.semantic_cluster_id = clusterId;
    return { ...candidate, editorial_signals: editorial };
  });
  return { ...selects, candidates };
}

export function agglomerativeClusters(
  embeddings: Float32Array[],
  labels: string[],
  threshold: number,
): Map<number, string> {
  if (embeddings.length !== labels.length) {
    throw new Error(`cluster input mismatch: ${embeddings.length} embeddings for ${labels.length} labels`);
  }

  const parent = embeddings.map((_, index) => index);
  const find = (index: number): number => {
    let root = index;
    while (parent[root] !== root) root = parent[root];
    while (parent[index] !== index) {
      const next = parent[index];
      parent[index] = root;
      index = next;
    }
    return root;
  };
  const union = (left: number, right: number): void => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot === rightRoot) return;
    parent[Math.max(leftRoot, rightRoot)] = Math.min(leftRoot, rightRoot);
  };

  for (let left = 0; left < embeddings.length; left += 1) {
    for (let right = left + 1; right < embeddings.length; right += 1) {
      if (cosineSimilarity(embeddings[left], embeddings[right]) > threshold) {
        union(left, right);
      }
    }
  }

  const groups = new Map<number, number[]>();
  for (let index = 0; index < embeddings.length; index += 1) {
    const root = find(index);
    const group = groups.get(root) ?? [];
    group.push(index);
    groups.set(root, group);
  }

  const usedClusterIds = new Map<string, number>();
  const result = new Map<number, string>();
  const sortedGroups = Array.from(groups.values()).sort((a, b) => a[0] - b[0]);
  for (const group of sortedGroups) {
    const baseClusterId = clusterIdFromSummaries(group.map((index) => labels[index])) || `semantic_${group[0] + 1}`;
    const useCount = usedClusterIds.get(baseClusterId) ?? 0;
    usedClusterIds.set(baseClusterId, useCount + 1);
    const clusterId = useCount === 0 ? baseClusterId : `${baseClusterId}_${useCount + 1}`;
    for (const index of group) {
      result.set(index, clusterId);
    }
  }
  return result;
}

function applyRefinedClusters(
  selects: SelectsCandidates,
  segmentsById: Map<string, SegmentItem>,
  clusterByCandidateIndex: Map<number, string>,
): SelectsCandidates {
  return {
    ...selects,
    candidates: selects.candidates.map((candidate, index) => {
      const next = cloneCandidate(candidate);
      const editorial = { ...(next.editorial_signals ?? {}) };
      const refinedClusterId = clusterByCandidateIndex.get(index);
      if (refinedClusterId && next.role !== "reject") {
        editorial.semantic_cluster_id = refinedClusterId;
      } else if (!hasValue(editorial.semantic_cluster_id)) {
        const segment = segmentsById.get(next.segment_id);
        if (segment) editorial.semantic_cluster_id = deriveSemanticClusterId(segment);
      }
      if (Object.keys(editorial).length > 0) next.editorial_signals = editorial;
      return next;
    }),
  };
}

function applyFallbackClusters(
  selects: SelectsCandidates,
  segmentsById: Map<string, SegmentItem>,
): SelectsCandidates {
  return {
    ...selects,
    candidates: selects.candidates.map((candidate) => {
      const next = cloneCandidate(candidate);
      if (next.role === "reject" || hasValue(next.editorial_signals?.semantic_cluster_id)) return next;
      const segment = segmentsById.get(next.segment_id);
      if (!segment) return next;
      next.editorial_signals = {
        ...(next.editorial_signals ?? {}),
        semantic_cluster_id: deriveSemanticClusterId(segment),
      };
      return next;
    }),
  };
}

function cloneCandidate(candidate: Candidate): Candidate {
  return {
    ...candidate,
    risks: [...candidate.risks],
    ...(candidate.quality_flags ? { quality_flags: [...candidate.quality_flags] } : {}),
    ...(candidate.evidence ? { evidence: [...candidate.evidence] } : {}),
    ...(candidate.eligible_beats ? { eligible_beats: [...candidate.eligible_beats] } : {}),
    ...(candidate.motif_tags ? { motif_tags: [...candidate.motif_tags] } : {}),
    ...(candidate.utterance_ids ? { utterance_ids: [...candidate.utterance_ids] } : {}),
    ...(candidate.editorial_signals
      ? {
          editorial_signals: {
            ...candidate.editorial_signals,
            ...(candidate.editorial_signals.visual_tags
              ? { visual_tags: [...candidate.editorial_signals.visual_tags] }
              : {}),
          },
        }
      : {}),
    ...(candidate.peak_signals
      ? {
          peak_signals: {
            ...candidate.peak_signals,
            ...(candidate.peak_signals.speech_keyword ? { speech_keyword: [...candidate.peak_signals.speech_keyword] } : {}),
          },
        }
      : {}),
    ...(candidate.trim_hint ? { trim_hint: { ...candidate.trim_hint } } : {}),
  };
}

export function deriveSemanticClusterId(segment: Pick<SegmentItem, "asset_id" | "tags">): string {
  const tags = (segment.tags ?? []).map(normalizeTag).filter(isNonEmptyString);
  const joined = tags.join(" ");
  if (/\b(aerial|drone|overhead)\b/.test(joined)) return "aerial";

  const location = /\b(indoor|interior|kitchen|workshop|restaurant|room|craft)\b/.test(joined)
    ? "indoor"
    : /\b(outdoor|landscape|mountain|forest|tree|river|snow|field|nature|sky)\b/.test(joined)
      ? "outdoor"
      : normalizeAssetPrefix(segment.asset_id);

  const primary = primaryClusterTag(tags);
  return `${location}_${primary}`;
}

function primaryClusterTag(tags: string[]): string {
  const joined = tags.join(" ");
  if (/\b(craft|artisan|handmade|woodwork|pottery|weaving)\b/.test(joined)) return "craft";
  if (/\b(landscape|mountain|forest|tree|river|snow|field|nature|sky)\b/.test(joined)) return "landscape";
  if (/\b(food|meal|kitchen|cooking|dish)\b/.test(joined)) return "food";
  if (/\b(face|person|people|smile|reaction|portrait)\b/.test(joined)) return "people";
  if (/\b(motion|walking|running|vehicle|action)\b/.test(joined)) return "motion";
  return tags.find((tag) => !GENERIC_TAGS.has(tag)) ?? "general";
}

const GENERIC_TAGS = new Set(["indoor", "outdoor", "scene", "shot", "video", "clip", "general"]);

const GENERIC_CLUSTER_TERMS = new Set([
  "a",
  "an",
  "and",
  "around",
  "at",
  "by",
  "camera",
  "clip",
  "close",
  "closeup",
  "closeups",
  "footage",
  "for",
  "frame",
  "from",
  "group",
  "in",
  "indoor",
  "inside",
  "into",
  "man",
  "medium",
  "near",
  "of",
  "on",
  "outdoor",
  "outside",
  "people",
  "person",
  "scene",
  "shot",
  "someone",
  "subject",
  "the",
  "to",
  "video",
  "view",
  "wide",
  "with",
  "woman",
]);

const ACTION_CLUSTER_TERMS = new Set([
  "bike",
  "cast",
  "climb",
  "cook",
  "cycle",
  "dance",
  "fish",
  "fishing",
  "frisbee",
  "laugh",
  "prepare",
  "run",
  "smile",
  "speak",
  "swim",
  "talk",
  "walk",
]);

const CONTEXT_CLUSTER_TERMS = new Set([
  "beach",
  "camp",
  "campfire",
  "campsite",
  "city",
  "forest",
  "garden",
  "kitchen",
  "lake",
  "mountain",
  "night",
  "ocean",
  "park",
  "river",
  "room",
  "sea",
  "snow",
  "street",
  "sunset",
  "tent",
  "trail",
  "workshop",
]);

const TIMESTAMP_SCENE_TERMS = [
  "vineyard",
  "orchard",
  "garden",
  "forest",
  "mountain",
  "river",
  "lake",
  "campfire",
  "camp",
  "tent",
  "kitchen",
  "workshop",
  "restaurant",
  "street",
  "beach",
  "snow",
  "field",
  "trail",
  "park",
  "aerial",
  "drone",
  "interview",
  "people",
];

function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let aMagnitude = 0;
  let bMagnitude = 0;
  for (let index = 0; index < a.length; index += 1) {
    dot += a[index] * b[index];
    aMagnitude += a[index] * a[index];
    bMagnitude += b[index] * b[index];
  }
  if (aMagnitude <= 0 || bMagnitude <= 0) return 0;
  return dot / (Math.sqrt(aMagnitude) * Math.sqrt(bMagnitude));
}

function clusterIdFromSummaries(summaries: string[]): string {
  const stats = new Map<string, { count: number; firstSeen: number; sourceCount: number; sources: Set<number> }>();
  let globalIndex = 0;
  for (let sourceIndex = 0; sourceIndex < summaries.length; sourceIndex += 1) {
    const seenInSource = new Set<string>();
    for (const term of tokenizeClusterTerms(summaries[sourceIndex])) {
      const existing = stats.get(term) ?? {
        count: 0,
        firstSeen: globalIndex,
        sourceCount: 0,
        sources: new Set<number>(),
      };
      existing.count += 1;
      if (!seenInSource.has(term)) {
        existing.sources.add(sourceIndex);
        existing.sourceCount = existing.sources.size;
      }
      seenInSource.add(term);
      stats.set(term, existing);
      globalIndex += 1;
    }
  }

  const ranked = Array.from(stats.entries())
    .map(([term, stat]) => ({ term, ...stat }))
    .sort((a, b) => {
      if (b.sourceCount !== a.sourceCount) return b.sourceCount - a.sourceCount;
      if (b.count !== a.count) return b.count - a.count;
      return a.firstSeen - b.firstSeen;
    });
  if (ranked.length === 0) return "";

  const sharedTerms = ranked.filter((item) => item.sourceCount > 1).map((item) => item.term);
  const selected = sharedTerms.length > 0
    ? sharedTerms.slice(0, 3)
    : ranked.slice(0, 2).map((item) => item.term);

  return orderClusterTerms(selected).join("_");
}

function tokenizeClusterTerms(summary: string): string[] {
  return summary
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .map(normalizeClusterTerm)
    .filter((term): term is string => !!term && !GENERIC_CLUSTER_TERMS.has(term));
}

function normalizeClusterTerm(term: string): string {
  if (!term) return "";
  if (term === "casting" || term === "casts" || term === "casted") return "cast";
  if (term === "walking" || term === "walks" || term === "walked") return "walk";
  if (term === "running" || term === "runs") return "run";
  if (term === "cycling" || term === "bicycle" || term === "biking") return "bike";
  if (term === "cooking" || term === "cooks") return "cook";
  if (term === "talking" || term === "speaking") return "talk";
  if (term === "smiling" || term === "smiles") return "smile";
  if (term === "camping") return "camp";
  if (term.length > 4 && term.endsWith("ies")) return `${term.slice(0, -3)}y`;
  if (term.length > 4 && term.endsWith("es")) return term.slice(0, -2);
  if (term.length > 4 && term.endsWith("s")) return term.slice(0, -1);
  return term;
}

function orderClusterTerms(terms: string[]): string[] {
  const uniqueTerms = Array.from(new Set(terms)).slice(0, 3);
  return uniqueTerms.sort((a, b) => {
    const aRank = clusterTermOrderRank(a);
    const bRank = clusterTermOrderRank(b);
    if (aRank !== bRank) return aRank - bRank;
    return uniqueTerms.indexOf(a) - uniqueTerms.indexOf(b);
  });
}

function clusterTermOrderRank(term: string): number {
  if (CONTEXT_CLUSTER_TERMS.has(term)) return 0;
  if (ACTION_CLUSTER_TERMS.has(term)) return 1;
  return 2;
}

function normalizeAssetPrefix(assetId: string): string {
  return normalizeTag(assetId.split(/[-_]/)[0] || "asset") || "asset";
}

function normalizeTag(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

function hasValue(value: unknown): boolean {
  if (value == null) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}
