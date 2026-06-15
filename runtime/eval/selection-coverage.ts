import type { Candidate, CreativeBrief, SelectsCandidates } from "../artifacts/types.js";

export const DENSITY_MIN = 0.55;
export const CLUSTER_MIN_SIZE = 3;
export const CLUSTER_MIN_SELECTED_RATIO = 0.5;
export const CLUSTER_JACCARD_MIN = 0.6;
export const CLUSTER_PREFIX_CHARS = 60;
export const DENSITY_SCORE_WEIGHT = 0.5;
export const CLUSTER_SCORE_WEIGHT = 0.5;
export const NON_CONTENT_SUMMARY_MARKERS = [
  "title card",
  "end screen",
  "thank you for watching",
  "視聴ありがとう",
] as const;

const US_PER_SEC = 1_000_000;
const MUST_HAVE_NOTE = "low-confidence (cross-language)";

export interface SelectionCoverageSegment {
  segment_id: string;
  summary?: string;
}

export interface RuntimeCoverage {
  selected_sec: number;
  target_sec: number;
  ratio: number;
}

export interface RoleDistribution {
  hero: number;
  support: number;
  texture: number;
  transition: number;
  dialogue: number;
}

export interface SelectionDensity {
  selected_count: number;
  segment_pool_size: number;
  value: number;
  sparse: boolean;
}

export interface ClusterCoverage {
  cluster_id: string;
  representative_segment_id: string;
  representative_summary: string;
  segment_ids: string[];
  cluster_size: number;
  selected_count: number;
  selected_ratio: number;
  under_sampled: boolean;
}

export interface MustHaveCoverage {
  item: string;
  matched: boolean;
  note: string;
}

export interface SelectionCoverageReport {
  runtime_coverage: RuntimeCoverage;
  role_distribution: RoleDistribution;
  density: SelectionDensity;
  cluster_coverage: ClusterCoverage[];
  must_have_coverage: MustHaveCoverage[];
  gaps: string[];
  score: number;
}

interface SummaryCluster {
  representative: SelectionCoverageSegment;
  segmentIds: string[];
  summaries: string[];
  tokenSet: Set<string>;
  normalizedPrefix: string;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function normalizeText(value: string): string {
  return value.normalize("NFKC").toLowerCase();
}

function compactText(value: string): string {
  return normalizeText(value).replace(/[\s、。，．・:：;；,."'“”‘’!?！？()[\]{}<>「」『』【】\-_/]+/g, "");
}

function normalizeSummary(value: string | undefined): string {
  return normalizeText(value ?? "")
    .replace(/[^a-z0-9\u3040-\u30ff\u3400-\u9fff]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function summaryTokens(value: string | undefined): Set<string> {
  const normalized = normalizeSummary(value);
  if (!normalized) return new Set();
  return new Set(normalized.split(" ").filter((token) => token.length >= 2));
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const token of a) {
    if (b.has(token)) intersection += 1;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function prefix(value: string): string {
  return value.slice(0, CLUSTER_PREFIX_CHARS);
}

function belongsToCluster(segment: SelectionCoverageSegment, cluster: SummaryCluster): boolean {
  const normalized = normalizeSummary(segment.summary);
  if (!normalized) return false;
  const segmentPrefix = prefix(normalized);
  if (segmentPrefix.length > 0 && segmentPrefix === cluster.normalizedPrefix) return true;
  return jaccard(summaryTokens(segment.summary), cluster.tokenSet) >= CLUSTER_JACCARD_MIN;
}

function buildSummaryClusters(segments: SelectionCoverageSegment[]): SummaryCluster[] {
  const clusters: SummaryCluster[] = [];
  for (const segment of segments) {
    const normalized = normalizeSummary(segment.summary);
    if (!normalized) continue;
    const existing = clusters.find((cluster) => belongsToCluster(segment, cluster));
    if (existing) {
      existing.segmentIds.push(segment.segment_id);
      existing.summaries.push(segment.summary ?? "");
      continue;
    }
    clusters.push({
      representative: segment,
      segmentIds: [segment.segment_id],
      summaries: [segment.summary ?? ""],
      tokenSet: summaryTokens(segment.summary),
      normalizedPrefix: prefix(normalized),
    });
  }
  return clusters;
}

function hasNonContentMarker(summary: string): boolean {
  const normalized = normalizeText(summary);
  const compact = compactText(summary);
  return NON_CONTENT_SUMMARY_MARKERS.some((marker) => {
    const normalizedMarker = normalizeText(marker);
    return normalized.includes(normalizedMarker) || compact.includes(compactText(marker));
  });
}

function isNonContentCluster(cluster: SummaryCluster): boolean {
  if (hasNonContentMarker(cluster.representative.summary ?? "")) return true;
  const marked = cluster.summaries.filter(hasNonContentMarker).length;
  return marked > cluster.summaries.length / 2;
}

function subscore(value: number, threshold: number): number {
  if (threshold <= 0) return 1;
  return value >= threshold ? 1 : clamp01(value / threshold);
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map((item) => String(item)) : [];
}

function mustHaveItems(brief: CreativeBrief): string[] {
  const value = (brief as { must_have?: unknown }).must_have;
  return stringArray(value).filter((item) => item.trim().length > 0);
}

function searchableCandidateText(
  candidates: Candidate[],
  segmentById: Map<string, SelectionCoverageSegment>,
): string {
  return candidates
    .map((candidate) =>
      [
        candidate.why_it_matches,
        ...(candidate.evidence ?? []),
        segmentById.get(candidate.segment_id)?.summary ?? "",
      ].join(" "),
    )
    .join(" ");
}

function itemMatchesSearchText(item: string, searchText: string): boolean {
  const target = compactText(searchText);
  const compactItem = compactText(item);
  if (!target || !compactItem) return false;
  if (target.includes(compactItem)) return true;

  const normalizedItem = normalizeText(item);
  const tokens = normalizedItem
    .split(/[\s、。，．・:：;；,."'“”‘’!?！？()[\]{}<>「」『』【】\-_/]+/)
    .map((token) => compactText(token))
    .filter((token) => token.length >= 2);
  if (tokens.some((token) => target.includes(token))) return true;

  const chars = [...compactItem];
  const minLength = chars.length >= 8 ? 4 : Math.min(3, chars.length);
  if (minLength <= 0) return false;
  for (let i = 0; i <= chars.length - minLength; i += 1) {
    if (target.includes(chars.slice(i, i + minLength).join(""))) return true;
  }
  return false;
}

export function analyzeSelectionCoverage(
  selects: SelectsCandidates,
  brief: CreativeBrief,
  segments: SelectionCoverageSegment[],
): SelectionCoverageReport {
  const active = selects.candidates.filter((candidate) => candidate.role !== "reject");
  const targetSec = Number(brief.project?.runtime_target_sec ?? 0);
  const selectedSec =
    active.reduce((total, candidate) => total + (candidate.src_out_us - candidate.src_in_us), 0) /
    US_PER_SEC;
  const runtimeRatio = targetSec > 0 ? selectedSec / targetSec : 1;

  const roleDistribution: RoleDistribution = {
    hero: 0,
    support: 0,
    texture: 0,
    transition: 0,
    dialogue: 0,
  };
  for (const candidate of active) {
    if (candidate.role in roleDistribution) {
      roleDistribution[candidate.role as keyof RoleDistribution] += 1;
    }
  }

  const segmentPoolSize = segments.length;
  const densityValue = segmentPoolSize > 0 ? active.length / segmentPoolSize : 1;
  const density: SelectionDensity = {
    selected_count: active.length,
    segment_pool_size: segmentPoolSize,
    value: densityValue,
    sparse: densityValue < DENSITY_MIN,
  };

  const selectedSegmentIds = new Set(active.map((candidate) => candidate.segment_id));
  const clusterCoverage = buildSummaryClusters(segments)
    .filter((cluster) => cluster.segmentIds.length >= CLUSTER_MIN_SIZE)
    .filter((cluster) => !isNonContentCluster(cluster))
    .map((cluster, index): ClusterCoverage => {
      const selectedInCluster = cluster.segmentIds.filter((id) => selectedSegmentIds.has(id)).length;
      const selectedRatio = selectedInCluster / cluster.segmentIds.length;
      return {
        cluster_id: `cluster_${index + 1}`,
        representative_segment_id: cluster.representative.segment_id,
        representative_summary: cluster.representative.summary ?? "",
        segment_ids: cluster.segmentIds,
        cluster_size: cluster.segmentIds.length,
        selected_count: selectedInCluster,
        selected_ratio: selectedRatio,
        under_sampled: selectedRatio < CLUSTER_MIN_SELECTED_RATIO,
      };
    });

  const segmentById = new Map(segments.map((segment) => [segment.segment_id, segment]));
  const searchText = searchableCandidateText(active, segmentById);
  const mustHaveCoverage = mustHaveItems(brief).map((item): MustHaveCoverage => ({
    item,
    matched: itemMatchesSearchText(item, searchText),
    note: MUST_HAVE_NOTE,
  }));

  const gaps: string[] = [];
  if (density.sparse) {
    gaps.push(
      `selection sparse: ${density.selected_count}/${density.segment_pool_size} segments (${(
        density.value * 100
      ).toFixed(0)}%)`,
    );
  }
  for (const cluster of clusterCoverage) {
    if (!cluster.under_sampled) continue;
    gaps.push(
      `dense cluster (${cluster.cluster_size} similar shots) under-sampled: picked ${cluster.selected_count}/${cluster.cluster_size} -- montage candidate may be missing`,
    );
  }
  for (const coverage of mustHaveCoverage) {
    if (!coverage.matched) gaps.push(`must_have uncertain: ${coverage.item}`);
  }

  const densityScore = subscore(density.value, DENSITY_MIN);
  const clusterScore =
    clusterCoverage.length === 0
      ? 1
      : clusterCoverage.reduce(
          (total, cluster) => total + subscore(cluster.selected_ratio, CLUSTER_MIN_SELECTED_RATIO),
          0,
        ) / clusterCoverage.length;

  return {
    runtime_coverage: {
      selected_sec: selectedSec,
      target_sec: targetSec,
      ratio: runtimeRatio,
    },
    role_distribution: roleDistribution,
    density,
    cluster_coverage: clusterCoverage,
    must_have_coverage: mustHaveCoverage,
    gaps,
    score: clamp01(densityScore * DENSITY_SCORE_WEIGHT + clusterScore * CLUSTER_SCORE_WEIGHT),
  };
}
