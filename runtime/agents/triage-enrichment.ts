import type { SegmentItem as BaseSegmentItem } from "../connectors/ffmpeg-segmenter.js";
import type { Candidate, SelectsCandidates } from "../artifacts/types.js";

type PeakType = "action_peak" | "emotional_peak" | "visual_peak";
type CandidateWithRejection = Candidate & { rejection_reason?: string };
type ClusterEntry = {
  candidateIndex: number;
  summary: string;
};

const DEFAULT_CLUSTER_SIMILARITY_THRESHOLD = 0.85;

export type SegmentItem = BaseSegmentItem & {
  visual_quality?: {
    scores?: {
      light_quality?: number;
      subject_prominence?: number;
      motion_quality?: number;
      emotional_expression?: number;
      composition_score?: number;
    };
    labels?: {
      lighting_style?: string[];
      composition_tags?: string[];
      expression_tags?: string[];
      motion_tags?: string[];
    };
  };
};

export function enrichSelectsFromAnalysis(
  selects: SelectsCandidates,
  segments: SegmentItem[],
): SelectsCandidates {
  const segmentsById = new Map(segments.map((segment) => [segment.segment_id, segment]));
  let qualityRejectedCount = 0;

  const enriched = {
    ...selects,
    candidates: selects.candidates.map((candidate) => {
      const segment = segmentsById.get(candidate.segment_id);
      if (!segment) return cloneCandidate(candidate);
      const enrichedCandidate = enrichCandidate(candidate, segment);
      const gatedCandidate = applyQualityGate(enrichedCandidate, segment);
      if (gatedCandidate.role === "reject" && enrichedCandidate.role !== "reject") {
        qualityRejectedCount += 1;
      }
      return gatedCandidate;
    }),
  };
  console.error(`[triage:quality-gate] rejected ${qualityRejectedCount} candidates due to low technical quality`);
  return enriched;
}

export async function refineClusters(
  selects: SelectsCandidates,
  segments: SegmentItem[],
): Promise<SelectsCandidates> {
  const segmentsById = new Map(segments.map((segment) => [segment.segment_id, segment]));
  const entries: ClusterEntry[] = [];
  for (let candidateIndex = 0; candidateIndex < selects.candidates.length; candidateIndex += 1) {
    const candidate = selects.candidates[candidateIndex];
    if (candidate.role === "reject") continue;
    const segment = segmentsById.get(candidate.segment_id);
    const summary = segment?.summary?.trim();
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

function enrichCandidate(candidate: Candidate, segment: SegmentItem): Candidate {
  const next: Candidate = cloneCandidate(candidate);
  const editorial = { ...(next.editorial_signals ?? {}) };
  const peakSignals = { ...(next.peak_signals ?? {}) };

  const firstPeak = segment.peak_analysis?.peak_moments?.[0];
  const peakType = normalizePeakType(firstPeak?.type);
  if (peakType && !hasValue(editorial.peak_type)) editorial.peak_type = peakType;
  if (isScore(firstPeak?.confidence) && !hasValue(editorial.peak_strength_score)) {
    editorial.peak_strength_score = clamp01(firstPeak.confidence);
  }
  if (isNonEmptyString(firstPeak?.peak_ref) && !hasValue(editorial.peak_ref)) {
    editorial.peak_ref = firstPeak.peak_ref;
  }

  const support = segment.peak_analysis?.support_signals;
  if (isScore(support?.motion_support_score) && !hasValue(peakSignals.motion)) {
    peakSignals.motion = clamp01(support.motion_support_score);
  }
  if (isScore(support?.audio_support_score) && !hasValue(peakSignals.audio_rms)) {
    peakSignals.audio_rms = clamp01(support.audio_support_score);
  }

  const scores = segment.visual_quality?.scores;
  if (isScore(scores?.motion_quality) && !hasValue(editorial.motion_energy_score)) {
    editorial.motion_energy_score = clamp01(scores.motion_quality);
  }
  if (
    isScore(scores?.emotional_expression) &&
    scores.emotional_expression > 0.5 &&
    !hasValue(editorial.reaction_intensity_score)
  ) {
    editorial.reaction_intensity_score = clamp01(scores.emotional_expression);
  }

  const visualTags = visualQualityTags(segment);
  if (visualTags.length > 0) {
    editorial.visual_tags = mergeTags(editorial.visual_tags, visualTags);
  }

  if (!hasValue(editorial.semantic_cluster_id)) {
    editorial.semantic_cluster_id = deriveSemanticClusterId(segment);
  }

  if (Object.keys(editorial).length > 0) next.editorial_signals = editorial;
  if (Object.keys(peakSignals).length > 0) next.peak_signals = peakSignals;
  if (!hasValue(next.motif_tags)) {
    const motifTags = deriveMotifTags(segment.tags);
    if (motifTags.length > 0) next.motif_tags = motifTags;
  }
  if (!hasValue(next.story_role) && hasValue(next.eligible_beats)) {
    next.story_role = deriveStoryRole(next.eligible_beats);
  }

  return next;
}

function applyQualityGate(candidate: Candidate, segment: SegmentItem): Candidate {
  const scores = segment.visual_quality?.scores;
  if (!scores || !isScore(scores.composition_score) || !isScore(scores.subject_prominence)) return candidate;
  if (scores.composition_score >= 0.2 || scores.subject_prominence >= 0.2) return candidate;
  const rejected: CandidateWithRejection = {
    ...candidate,
    role: "reject",
    rejection_reason: "auto-rejected: technical quality below threshold",
  };
  return rejected;
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

function visualQualityTags(segment: SegmentItem): string[] {
  const labels = segment.visual_quality?.labels;
  if (!labels) return [];
  return [
    ...(labels.lighting_style ?? []),
    ...(labels.composition_tags ?? []),
    ...(labels.expression_tags ?? []),
    ...(labels.motion_tags ?? []),
  ].map(normalizeTag).filter(isNonEmptyString);
}

function deriveMotifTags(tags: string[] | undefined): string[] {
  return mergeTags([], (tags ?? []).map(normalizeTag).filter(isNonEmptyString)).slice(0, 8);
}

function deriveStoryRole(eligibleBeats: string[] | undefined): NonNullable<Candidate["story_role"]> {
  const beats = (eligibleBeats ?? []).map(normalizeTag).filter(isNonEmptyString);
  const joined = beats.join(" ");
  if (/\b(hook|opening)\b/.test(joined)) return "hook";
  if (/\bsetup\b/.test(joined)) return "setup";
  if (/\b(closing|ending|payoff|release)\b/.test(joined)) return "closing";
  if (/\b(experience|development|immersion|middle)\b/.test(joined)) return "experience";
  return "experience";
}

function deriveSemanticClusterId(segment: SegmentItem): string {
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

function mergeTags(existing: string[] | undefined, additions: string[]): string[] {
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const tag of [...(existing ?? []), ...additions]) {
    const normalized = normalizeTag(tag);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    merged.push(normalized);
  }
  return merged;
}

function normalizeTag(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

function normalizePeakType(value: string | undefined): PeakType | undefined {
  if (value === "action_peak" || value === "emotional_peak" || value === "visual_peak") return value;
  return undefined;
}

function hasValue(value: unknown): boolean {
  if (value == null) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

function isScore(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}
