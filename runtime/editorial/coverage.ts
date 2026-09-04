import type { Candidate, CreativeBrief, SelectsCandidates } from "../artifacts/types.js";
import { loadDefaults, resolvePolicy } from "../policy-resolver.js";
import { deriveSemanticClusterId } from "./clustering.js";
import { mustHaveMatches, type QualityGateSegment } from "./quality-gate.js";
import { isProductionDirective } from "../eval/selection-coverage.js";

export const SELECTION_COVERAGE_POLICY_NAME = "analysis-defaults.selection";

export type ClusterSamplingScale = "none" | "sqrt";

export interface SelectionCoverageConfig {
  min_candidates_per_cluster: number;
  cluster_sampling_scale: ClusterSamplingScale;
  max_candidates_per_cluster: number;
}

export interface SelectionCoverageSegment extends QualityGateSegment {
  editorial_signals?: {
    semantic_cluster_id?: string;
  };
}

export interface CoverageClusterRecord {
  cluster_id: string;
  cluster_size: number;
  required_count: number;
  selected_count: number;
  status: "met" | "unmet" | "exempt_all_rejected";
  segment_ids: string[];
  selected_segment_ids: string[];
  unused_segment_ids: string[];
  quality_rejected_segment_ids: string[];
  exempt_reason?: string;
}

export interface CoverageMustHaveRecord {
  item: string;
  status: "met" | "unmet";
  matched_segment_ids: string[];
}

export interface CoverageUnmetItem {
  type: "cluster_minimum" | "must_have";
  id: string;
  message: string;
  cluster_id?: string;
  must_have?: string;
  required_count?: number;
  selected_count?: number;
  unused_segment_ids?: string[];
}

export interface SelectsCoverageSummary {
  version: "1";
  policy: string;
  status: "met" | "failed";
  config: SelectionCoverageConfig;
  clusters: CoverageClusterRecord[];
  must_have: CoverageMustHaveRecord[];
  unmet: CoverageUnmetItem[];
  notes?: string[];
}

export const DEFAULT_SELECTION_COVERAGE_CONFIG: SelectionCoverageConfig = {
  min_candidates_per_cluster: 1,
  cluster_sampling_scale: "sqrt",
  max_candidates_per_cluster: 4,
};

export function loadSelectionCoverageConfig(projectDir?: string): {
  config: SelectionCoverageConfig;
  policyName: string;
} {
  try {
    const policy = projectDir ? resolvePolicy(projectDir).resolved : loadDefaults();
    const policyName = stringValue(policy.policy_name) ?? "analysis-defaults";
    return {
      config: selectionCoverageConfigFromPolicy(policy),
      policyName: `${policyName}.selection`,
    };
  } catch {
    return {
      config: { ...DEFAULT_SELECTION_COVERAGE_CONFIG },
      policyName: SELECTION_COVERAGE_POLICY_NAME,
    };
  }
}

export function selectionCoverageConfigFromPolicy(
  policy: Record<string, unknown> | undefined,
): SelectionCoverageConfig {
  const raw = isRecord(policy?.selection) ? policy.selection : {};
  const minCandidates = positiveInteger(
    raw.min_candidates_per_cluster,
    DEFAULT_SELECTION_COVERAGE_CONFIG.min_candidates_per_cluster,
  );
  const maxCandidates = positiveInteger(
    raw.max_candidates_per_cluster,
    DEFAULT_SELECTION_COVERAGE_CONFIG.max_candidates_per_cluster,
  );
  return {
    min_candidates_per_cluster: minCandidates,
    cluster_sampling_scale: raw.cluster_sampling_scale === "none" ? "none" : "sqrt",
    max_candidates_per_cluster: Math.max(minCandidates, maxCandidates),
  };
}

export function requiredCandidatesForCluster(
  clusterSize: number,
  config: SelectionCoverageConfig = DEFAULT_SELECTION_COVERAGE_CONFIG,
): number {
  const normalized = normalizeConfig(config);
  const scaled = normalized.cluster_sampling_scale === "sqrt"
    ? Math.ceil(Math.sqrt(Math.max(0, clusterSize)))
    : normalized.min_candidates_per_cluster;
  return Math.min(
    normalized.max_candidates_per_cluster,
    Math.max(normalized.min_candidates_per_cluster, scaled),
  );
}

export function evaluateSelectionCoverage(
  selects: SelectsCandidates,
  brief: CreativeBrief | undefined,
  segments: SelectionCoverageSegment[],
  options: {
    config?: Partial<SelectionCoverageConfig>;
    policyName?: string;
  } = {},
): SelectsCoverageSummary {
  const config = normalizeConfig(options.config);
  const policy = options.policyName ?? SELECTION_COVERAGE_POLICY_NAME;
  const candidates = Array.isArray((selects as { candidates?: unknown }).candidates)
    ? selects.candidates
    : [];
  const segmentById = new Map(segments.map((segment) => [segment.segment_id, segment]));
  const clustersById = buildSegmentClusters(segments);
  const candidatesBySegmentId = groupCandidatesBySegment(candidates);
  const selectedByClusterId = new Map<string, Set<string>>();
  const rejectedSegmentIds = new Set<string>();

  for (const candidate of candidates) {
    if (isQualityRejected(candidate)) {
      rejectedSegmentIds.add(candidate.segment_id);
      continue;
    }
    const clusterId = candidateClusterId(candidate, segmentById.get(candidate.segment_id), clustersById);
    if (!clusterId) continue;
    const selected = selectedByClusterId.get(clusterId) ?? new Set<string>();
    selected.add(candidate.segment_id);
    selectedByClusterId.set(clusterId, selected);
  }

  const notes: string[] = [];
  const unmet: CoverageUnmetItem[] = [];
  const clusters: CoverageClusterRecord[] = [];

  for (const [clusterId, segmentIds] of [...clustersById.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const selectedSegmentIds = [...(selectedByClusterId.get(clusterId) ?? new Set<string>())]
      .filter((segmentId) => segmentIds.includes(segmentId))
      .sort();
    const qualityRejectedSegmentIds = segmentIds
      .filter((segmentId) => allCandidatesForSegmentRejected(candidatesBySegmentId.get(segmentId)))
      .sort();
    const unusedSegmentIds = segmentIds
      .filter((segmentId) => !selectedSegmentIds.includes(segmentId))
      .sort();
    const requiredCount = requiredCandidatesForCluster(segmentIds.length, config);
    const allMembersRejected =
      segmentIds.length > 0 &&
      qualityRejectedSegmentIds.length === segmentIds.length;

    if (selectedSegmentIds.length >= requiredCount) {
      clusters.push({
        cluster_id: clusterId,
        cluster_size: segmentIds.length,
        required_count: requiredCount,
        selected_count: selectedSegmentIds.length,
        status: "met",
        segment_ids: [...segmentIds],
        selected_segment_ids: selectedSegmentIds,
        unused_segment_ids: unusedSegmentIds,
        quality_rejected_segment_ids: qualityRejectedSegmentIds,
      });
      continue;
    }

    if (allMembersRejected) {
      notes.push(`cluster ${clusterId} exempted because every member was quality-gate rejected`);
      clusters.push({
        cluster_id: clusterId,
        cluster_size: segmentIds.length,
        required_count: requiredCount,
        selected_count: selectedSegmentIds.length,
        status: "exempt_all_rejected",
        segment_ids: [...segmentIds],
        selected_segment_ids: selectedSegmentIds,
        unused_segment_ids: unusedSegmentIds,
        quality_rejected_segment_ids: qualityRejectedSegmentIds,
        exempt_reason: "all cluster members were rejected by the quality gate",
      });
      continue;
    }

    const availableUnusedSegmentIds = unusedSegmentIds.filter(
      (segmentId) => !qualityRejectedSegmentIds.includes(segmentId),
    );
    const message =
      `cluster ${clusterId} selected ${selectedSegmentIds.length}/${requiredCount} required ` +
      `from ${segmentIds.length} segments`;
    unmet.push({
      type: "cluster_minimum",
      id: `cluster:${clusterId}`,
      message,
      cluster_id: clusterId,
      required_count: requiredCount,
      selected_count: selectedSegmentIds.length,
      unused_segment_ids: availableUnusedSegmentIds,
    });
    clusters.push({
      cluster_id: clusterId,
      cluster_size: segmentIds.length,
      required_count: requiredCount,
      selected_count: selectedSegmentIds.length,
      status: "unmet",
      segment_ids: [...segmentIds],
      selected_segment_ids: selectedSegmentIds,
      unused_segment_ids: unusedSegmentIds,
      quality_rejected_segment_ids: qualityRejectedSegmentIds,
    });
  }

  if (clusters.length === 0) {
    notes.push("cluster coverage skipped: no semantic cluster evidence was available");
  }

  const mustHave = evaluateMustHaveCoverage(candidates, brief, segmentById);
  const deferredDirectiveCount = mustHave.filter((item) => isProductionDirective(item.item)).length;
  if (deferredDirectiveCount > 0) {
    notes.push(
      `${deferredDirectiveCount} production directive must_have items deferred to blueprint/timeline validation`,
    );
  }
  for (const item of mustHave) {
    if (item.status === "met") continue;
    unmet.push({
      type: "must_have",
      id: `must_have:${item.item}`,
      message: `must_have '${item.item}' has no matching non-rejected candidate`,
      must_have: item.item,
    });
  }

  return {
    version: "1",
    policy,
    status: unmet.length === 0 ? "met" : "failed",
    config,
    clusters,
    must_have: mustHave,
    unmet,
    ...(notes.length > 0 ? { notes } : {}),
  };
}

export function attachSelectionCoverage(
  selects: SelectsCandidates,
  brief: CreativeBrief | undefined,
  segments: SelectionCoverageSegment[],
  options: {
    config?: Partial<SelectionCoverageConfig>;
    policyName?: string;
  } = {},
): SelectsCandidates {
  return {
    ...selects,
    coverage: evaluateSelectionCoverage(selects, brief, segments, options),
  };
}

export function coverageFeedbackGaps(coverage: SelectsCoverageSummary): string[] {
  return coverage.unmet.map((item) => {
    if (item.type === "cluster_minimum") {
      return [
        item.message,
        `unused_segment_ids=${JSON.stringify(item.unused_segment_ids ?? [])}`,
      ].join("; ");
    }
    return item.message;
  });
}

function evaluateMustHaveCoverage(
  candidates: Candidate[],
  brief: CreativeBrief | undefined,
  segmentById: Map<string, SelectionCoverageSegment>,
): CoverageMustHaveRecord[] {
  const mustHaves = briefMustHaveStrings(brief);
  if (mustHaves.length === 0) return [];
  const active = candidates.filter(
    (candidate) => !isQualityRejected(candidate) && segmentById.has(candidate.segment_id),
  );
  return mustHaves.map((item) => {
    if (isProductionDirective(item)) {
      return { item, status: "met", matched_segment_ids: [] };
    }
    const matchedSegmentIds = active
      .filter((candidate) => mustHaveMatches(candidate, segmentById.get(candidate.segment_id), [item]).length > 0)
      .map((candidate) => candidate.segment_id)
      .sort();
    return {
      item,
      status: matchedSegmentIds.length > 0 ? "met" : "unmet",
      matched_segment_ids: [...new Set(matchedSegmentIds)],
    };
  });
}

function buildSegmentClusters(segments: SelectionCoverageSegment[]): Map<string, string[]> {
  const clusters = new Map<string, string[]>();
  for (const segment of segments) {
    const clusterId = segmentClusterId(segment);
    if (!clusterId) continue;
    const segmentIds = clusters.get(clusterId) ?? [];
    if (!segmentIds.includes(segment.segment_id)) segmentIds.push(segment.segment_id);
    clusters.set(clusterId, segmentIds);
  }
  return clusters;
}

function groupCandidatesBySegment(candidates: Candidate[]): Map<string, Candidate[]> {
  const grouped = new Map<string, Candidate[]>();
  for (const candidate of candidates) {
    const items = grouped.get(candidate.segment_id) ?? [];
    items.push(candidate);
    grouped.set(candidate.segment_id, items);
  }
  return grouped;
}

function allCandidatesForSegmentRejected(candidates: Candidate[] | undefined): boolean {
  return candidates !== undefined && candidates.length > 0 && candidates.every(isQualityRejected);
}

function isQualityRejected(candidate: Candidate): boolean {
  return candidate.role === "reject" || candidate.quality_gate?.decision === "reject";
}

function candidateClusterId(
  candidate: Candidate,
  segment: SelectionCoverageSegment | undefined,
  clustersById: Map<string, string[]>,
): string | undefined {
  const candidateCluster = stringValue(candidate.editorial_signals?.semantic_cluster_id);
  if (candidateCluster && clustersById.has(candidateCluster)) return candidateCluster;
  return segmentClusterId(segment) ?? candidateCluster;
}

function segmentClusterId(segment: SelectionCoverageSegment | undefined): string | undefined {
  const explicit = stringValue(segment?.editorial_signals?.semantic_cluster_id);
  if (explicit) return explicit;
  if (!segment?.asset_id) return undefined;
  return deriveSemanticClusterId({
    asset_id: segment.asset_id,
    tags: segment.tags ?? [],
  });
}

function briefMustHaveStrings(brief: CreativeBrief | undefined): string[] {
  const value = (brief as Record<string, unknown> | undefined)?.must_have;
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter((item) => item.length > 0);
}

function normalizeConfig(config: Partial<SelectionCoverageConfig> | undefined): SelectionCoverageConfig {
  const minCandidates = positiveInteger(
    config?.min_candidates_per_cluster,
    DEFAULT_SELECTION_COVERAGE_CONFIG.min_candidates_per_cluster,
  );
  const maxCandidates = positiveInteger(
    config?.max_candidates_per_cluster,
    DEFAULT_SELECTION_COVERAGE_CONFIG.max_candidates_per_cluster,
  );
  return {
    min_candidates_per_cluster: minCandidates,
    cluster_sampling_scale: config?.cluster_sampling_scale === "none" ? "none" : "sqrt",
    max_candidates_per_cluster: Math.max(minCandidates, maxCandidates),
  };
}

function positiveInteger(value: unknown, fallback: number): number {
  const n = typeof value === "number" ? Math.floor(value) : NaN;
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}
