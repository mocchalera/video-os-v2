import * as fs from "node:fs";
import * as path from "node:path";
import {
  computeNormalizedJsonHash,
  type AnalysisCoverageReport,
  type RunnerValidationResult,
  type SourceMediaManifest,
} from "./p1-manifest-coverage.js";

type EntityType = "subject_cluster" | "location" | "prop" | "motif" | "action";
type EntityStatus = "hypothesis" | "confirmed_editing_continuity" | "human_confirmed" | "redacted";
type ContinuityEdgeType =
  | "same_subject"
  | "same_location"
  | "chronologically_before"
  | "action_continues"
  | "screen_direction_consistent"
  | "screen_direction_break"
  | "visual_match"
  | "visual_contrast"
  | "duplicate_semantic_content";

export interface ContinuityGraphEntity {
  entity_id: string;
  entity_type: EntityType;
  status: EntityStatus;
  label?: string | null;
  evidence_segment_ids: string[];
  confidence: {
    score: number;
    source: string;
    status: string;
    label?: string;
  };
}

export interface ContinuityGraphSegment {
  segment_id: string;
  asset_id: string;
  src_in_us: number;
  src_out_us: number;
  capture_basis?: "manifest_timecode" | "file_metadata" | "inferred" | "unknown";
  entity_ids: string[];
}

export interface ContinuityGraphEdge {
  edge_id: string;
  from_ref: string;
  to_ref: string;
  type: ContinuityEdgeType;
  confidence: {
    score: number;
    source: string;
    status: string;
    label?: string;
  };
}

export interface ContinuityGraphRisk {
  risk_id: string;
  severity: "info" | "warning" | "blocker";
  type: "identity_uncertain" | "chronology_uncertain" | "axis_break" | "duplicate_content" | "privacy_sensitive" | "missing_evidence";
  refs: string[];
  message: string;
}

export interface ContinuityGraph {
  version: "1.0.0";
  project_id: string;
  artifact_version: "analysis-v3";
  created_at: string;
  source_media_manifest_hash: string;
  entities: ContinuityGraphEntity[];
  segments: ContinuityGraphSegment[];
  edges: ContinuityGraphEdge[];
  risks: ContinuityGraphRisk[];
  provenance: {
    producer: "analysis-pipeline" | "triage-projection";
    inputs: Array<Record<string, unknown>>;
    hash_policy: {
      algorithm: "sha256";
      canonicalization: "normalized-json-v1";
      excluded_fields: string[];
    };
  };
}

interface SegmentLike {
  segment_id?: string;
  asset_id?: string;
  src_in_us?: number;
  src_out_us?: number;
  tags?: string[];
}

interface AssetsLike {
  items?: Array<{ asset_id?: string; segment_ids?: string[] }>;
}

export interface BuildContinuityGraphOptions {
  projectId: string;
  manifest: SourceMediaManifest | { source_media_manifest_hash?: string; items?: Array<{ asset_id?: string }> };
  coverageReport: AnalysisCoverageReport | { hash?: string; lanes?: Array<{ lane_id?: string; status?: string }> };
  assets?: AssetsLike | null;
  segments?: { items?: SegmentLike[] } | null;
  createdAt?: string;
}

export interface ValidateContinuityGraphOptions {
  manifestAssetIds?: string[];
  sourceMediaManifestHash?: string;
}

export function isP3ContinuityPreferenceEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return /^(1|true|yes|on)$/i.test(env.ENABLE_P3_CONTINUITY_PREFERENCE ?? "");
}

export function computeContinuityGraphHash(graph: unknown): string {
  const excluded = graph && typeof graph === "object"
    ? (((graph as ContinuityGraph).provenance?.hash_policy?.excluded_fields) ?? ["created_at"])
    : ["created_at"];
  return computeNormalizedJsonHash(sortContinuityGraphIfPossible(graph), excluded);
}

export function isContinuityGraphStale(graph: unknown, currentSourceMediaManifestHash: string): boolean {
  return (graph as Partial<ContinuityGraph>)?.source_media_manifest_hash !== currentSourceMediaManifestHash;
}

export function validateContinuityGraph(
  data: unknown,
  options: ValidateContinuityGraphOptions = {},
): RunnerValidationResult {
  const violations: string[] = [];
  const graph = data as Partial<ContinuityGraph>;
  const entityIds = new Set<string>();
  const segmentIds = new Set<string>();
  const edgeIds = new Set<string>();

  if (!Array.isArray(graph.entities)) {
    violations.push("entities must be an array");
  } else {
    for (const [index, entity] of graph.entities.entries()) {
      if (entityIds.has(entity.entity_id)) violations.push(`entities/${index} duplicate entity_id ${entity.entity_id}`);
      entityIds.add(entity.entity_id);
      if (
        entity.entity_type === "subject_cluster" &&
        typeof entity.label === "string" &&
        entity.label.trim() !== "" &&
        entity.status !== "human_confirmed"
      ) {
        violations.push(`entities/${index} subject identity label requires human_confirmed status`);
      }
    }
  }

  if (!Array.isArray(graph.segments)) {
    violations.push("segments must be an array");
  } else {
    for (const [index, segment] of graph.segments.entries()) {
      if (segmentIds.has(segment.segment_id)) violations.push(`segments/${index} duplicate segment_id ${segment.segment_id}`);
      segmentIds.add(segment.segment_id);
      if (segment.src_out_us <= segment.src_in_us) {
        violations.push(`segments/${index} src_out_us must be greater than src_in_us`);
      }
      if (options.manifestAssetIds && !options.manifestAssetIds.includes(segment.asset_id)) {
        violations.push(`segments/${index} asset_id ${segment.asset_id} not found in source_media_manifest`);
      }
      for (const entityId of segment.entity_ids ?? []) {
        if (!entityIds.has(entityId)) violations.push(`segments/${index} entity_id ${entityId} not found in entities`);
      }
    }
  }

  if (Array.isArray(graph.entities)) {
    for (const [index, entity] of graph.entities.entries()) {
      for (const segmentId of entity.evidence_segment_ids ?? []) {
        if (!segmentIds.has(segmentId)) {
          violations.push(`entities/${index} evidence_segment_id ${segmentId} not found in segments`);
        }
      }
    }
  }

  if (Array.isArray(graph.edges)) {
    for (const [index, edge] of graph.edges.entries()) {
      if (edgeIds.has(edge.edge_id)) violations.push(`edges/${index} duplicate edge_id ${edge.edge_id}`);
      edgeIds.add(edge.edge_id);
      for (const [field, ref] of [["from_ref", edge.from_ref], ["to_ref", edge.to_ref]] as const) {
        if (!entityIds.has(ref) && !segmentIds.has(ref)) {
          violations.push(`edges/${index} ${field} ${ref} not found in graph refs`);
        }
      }
    }
  }

  if (
    options.sourceMediaManifestHash &&
    graph.source_media_manifest_hash &&
    graph.source_media_manifest_hash !== options.sourceMediaManifestHash
  ) {
    violations.push("source_media_manifest_hash is stale");
  }

  return { valid: violations.length === 0, violations };
}

export function buildContinuityGraph(options: BuildContinuityGraphOptions): ContinuityGraph {
  const manifestItems = Array.isArray(options.manifest.items) ? options.manifest.items : [];
  const manifestHash = getManifestHash(options.manifest);
  const coverageHash = getCoverageHash(options.coverageReport);
  const rawSegments = options.segments?.items ?? [];
  const entitiesByKey = new Map<string, ContinuityGraphEntity>();
  const graphSegments: ContinuityGraphSegment[] = [];

  for (const segment of rawSegments) {
    if (!segment.segment_id || !segment.asset_id || typeof segment.src_in_us !== "number" || typeof segment.src_out_us !== "number") continue;
    const entityIds = collectEntitiesForSegment(segment, entitiesByKey);
    graphSegments.push({
      segment_id: segment.segment_id,
      asset_id: segment.asset_id,
      src_in_us: segment.src_in_us,
      src_out_us: segment.src_out_us,
      capture_basis: "inferred",
      entity_ids: entityIds,
    });
  }

  const graph = sortContinuityGraph({
    version: "1.0.0",
    project_id: options.projectId,
    artifact_version: "analysis-v3",
    created_at: options.createdAt ?? new Date().toISOString(),
    source_media_manifest_hash: manifestHash,
    entities: Array.from(entitiesByKey.values()),
    segments: graphSegments,
    edges: buildEdges(graphSegments),
    risks: buildRisks(graphSegments),
    provenance: {
      producer: "analysis-pipeline",
      inputs: [
        { path: "02_media/source_media_manifest.json", hash: manifestHash },
        { path: "03_analysis/analysis_coverage_report.json", hash: coverageHash },
      ],
      hash_policy: {
        algorithm: "sha256",
        canonicalization: "normalized-json-v1",
        excluded_fields: ["created_at"],
      },
    },
  });

  const integrity = validateContinuityGraph(graph, {
    manifestAssetIds: manifestItems.map((item) => item.asset_id).filter((id): id is string => typeof id === "string"),
    sourceMediaManifestHash: manifestHash,
  });
  if (!integrity.valid) {
    throw new Error(`continuity_graph validation failed: ${integrity.violations.join("; ")}`);
  }
  return graph;
}

export function sortContinuityGraph(graph: ContinuityGraph): ContinuityGraph {
  return {
    ...graph,
    entities: [...graph.entities].sort((a, b) => a.entity_id.localeCompare(b.entity_id)),
    segments: [...graph.segments].sort((a, b) =>
      a.asset_id.localeCompare(b.asset_id) ||
      a.src_in_us - b.src_in_us ||
      a.segment_id.localeCompare(b.segment_id)
    ),
    edges: [...graph.edges].sort((a, b) =>
      a.type.localeCompare(b.type) ||
      a.from_ref.localeCompare(b.from_ref) ||
      a.to_ref.localeCompare(b.to_ref) ||
      a.edge_id.localeCompare(b.edge_id)
    ),
    risks: [...graph.risks].sort((a, b) => a.risk_id.localeCompare(b.risk_id)),
  };
}

export function writeContinuityGraph(projectDir: string, graph: ContinuityGraph): void {
  const outPath = path.join(projectDir, "03_analysis/continuity_graph.json");
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(sortContinuityGraph(graph), null, 2)}\n`, "utf-8");
}

export function readContinuityGraph(projectDir: string): ContinuityGraph | null {
  const graphPath = path.join(projectDir, "03_analysis/continuity_graph.json");
  if (!fs.existsSync(graphPath)) return null;
  return JSON.parse(fs.readFileSync(graphPath, "utf-8")) as ContinuityGraph;
}

export function continuityRisksForWindow(
  graph: ContinuityGraph,
  assetId: string,
  startUs: number,
  endUs: number,
): ContinuityGraphRisk[] {
  const segmentIds = new Set(graph.segments.filter((segment) =>
    segment.asset_id === assetId &&
    segment.src_in_us < endUs &&
    segment.src_out_us > startUs
  ).map((segment) => segment.segment_id));
  return graph.risks.filter((risk) => risk.refs.some((ref) => segmentIds.has(ref)));
}

function sortContinuityGraphIfPossible(graph: unknown): unknown {
  const candidate = graph as Partial<ContinuityGraph>;
  if (
    candidate &&
    Array.isArray(candidate.entities) &&
    Array.isArray(candidate.segments) &&
    Array.isArray(candidate.edges) &&
    Array.isArray(candidate.risks)
  ) {
    return sortContinuityGraph(candidate as ContinuityGraph);
  }
  return graph;
}

function collectEntitiesForSegment(segment: SegmentLike, entitiesByKey: Map<string, ContinuityGraphEntity>): string[] {
  const tags = (segment.tags ?? []).map((tag) => tag.toLowerCase());
  const entities: Array<{ type: EntityType; key: string; label: string | null; status: EntityStatus }> = [];
  if (tags.includes("child") || tags.includes("person") || tags.includes("family")) {
    entities.push({ type: "subject_cluster", key: "subject_cluster", label: null, status: "hypothesis" });
  }
  if (tags.includes("park")) entities.push({ type: "location", key: "park", label: "park", status: "confirmed_editing_continuity" });
  if (tags.includes("ball")) entities.push({ type: "prop", key: "ball", label: "ball", status: "confirmed_editing_continuity" });
  if (tags.includes("jump")) entities.push({ type: "action", key: "jump", label: "jump", status: "confirmed_editing_continuity" });

  const ids: string[] = [];
  for (const entity of entities) {
    const entityId = entityIdFor(entity.type, entity.key);
    ids.push(entityId);
    const existing = entitiesByKey.get(entityId);
    if (existing) {
      if (segment.segment_id && !existing.evidence_segment_ids.includes(segment.segment_id)) {
        existing.evidence_segment_ids.push(segment.segment_id);
      }
      continue;
    }
    entitiesByKey.set(entityId, {
      entity_id: entityId,
      entity_type: entity.type,
      status: entity.status,
      label: entity.label,
      evidence_segment_ids: segment.segment_id ? [segment.segment_id] : [],
      confidence: { score: 0.7, source: "segments.tags", status: "partial" },
    });
  }
  return ids.sort();
}

function buildEdges(segments: ContinuityGraphSegment[]): ContinuityGraphEdge[] {
  const sorted = [...segments].sort((a, b) => a.asset_id.localeCompare(b.asset_id) || a.src_in_us - b.src_in_us);
  const edges: ContinuityGraphEdge[] = [];
  for (let index = 0; index < sorted.length - 1; index++) {
    edges.push({
      edge_id: `CONEDGE_chrono_${index + 1}`,
      from_ref: sorted[index].segment_id,
      to_ref: sorted[index + 1].segment_id,
      type: "chronologically_before",
      confidence: { score: 0.75, source: "segment_order", status: "partial" },
    });
  }
  return edges;
}

function buildRisks(segments: ContinuityGraphSegment[]): ContinuityGraphRisk[] {
  const risks: ContinuityGraphRisk[] = [];
  const byEntity = new Map<string, string[]>();
  for (const segment of segments) {
    for (const entityId of segment.entity_ids) {
      const list = byEntity.get(entityId) ?? [];
      list.push(segment.segment_id);
      byEntity.set(entityId, list);
    }
  }
  for (const [entityId, refs] of [...byEntity.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    if (entityId.startsWith("ENT_SUBJECT_") && refs.length > 0) {
      risks.push({
        risk_id: `CONRISK_identity_${risks.length + 1}`,
        severity: "warning",
        type: "identity_uncertain",
        refs: [entityId, ...refs],
        message: "Anonymous subject cluster is editing-continuity only until human confirmed.",
      });
    }
  }
  return risks;
}

function entityIdFor(type: EntityType, key: string): string {
  const prefix = {
    subject_cluster: "ENT_SUBJECT",
    location: "ENT_LOCATION",
    prop: "ENT_PROP",
    motif: "ENT_MOTIF",
    action: "ENT_ACTION",
  }[type];
  return `${prefix}_${makeId(key)}`;
}

function getManifestHash(manifest: BuildContinuityGraphOptions["manifest"]): string {
  const supplied = (manifest as { source_media_manifest_hash?: string }).source_media_manifest_hash;
  if (supplied) return supplied;
  return computeNormalizedJsonHash(manifest, (manifest as SourceMediaManifest).provenance?.hash_policy?.excluded_fields ?? []);
}

function getCoverageHash(report: BuildContinuityGraphOptions["coverageReport"]): string {
  const supplied = (report as { hash?: string }).hash;
  if (supplied) return supplied;
  const excludedFields = (report as AnalysisCoverageReport).provenance?.hash_policy?.excluded_fields;
  return computeNormalizedJsonHash(report, Array.isArray(excludedFields) ? excludedFields : []);
}

function makeId(value: string): string {
  return value.normalize("NFKD").replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "") || "unknown";
}
