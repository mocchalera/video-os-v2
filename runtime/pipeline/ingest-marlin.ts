/**
 * Optional Marlin analysis boundary for ingest.
 *
 * Owns staged artifact publication, rollback/scrubbing, and readiness reporting
 * so the main ingest orchestrator only coordinates when the stage runs.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { SegmentItem } from "../connectors/ffmpeg-segmenter.js";
import type { MarlinEventsArtifact, MarlinFn, MarlinModelRecord } from "../connectors/marlin-types.js";
import type { SourceContentIdentityCache } from "../source-content-identity.js";
import { atomicWriteJson, readJsonIfExists } from "./stages/_util.js";
import {
  applyMarlinEventsToSegments,
  extractTagsFromScene,
  MARLIN_REPORTER_METHOD,
  MarlinOptionalAnalysisError,
  runMarlinAnalysis,
} from "./stages/marlin.js";
import type { GapReport, SegmentsJson } from "./pipeline-types.js";

export interface AnalysisStageReadiness {
  status: "ready" | "partial" | "skipped";
  reason?: string;
  affectedCapabilities: string[];
}

export interface AnalysisReadiness {
  overall: "ready" | "partial";
  stages: {
    marlin: AnalysisStageReadiness;
  };
}

export interface MarlinStageOptions {
  marlinFn?: MarlinFn;
  marlinModel?: MarlinModelRecord;
  marlinQueries?: string[];
  skipMarlin?: boolean;
  vlmOnly?: boolean;
}

function readCanonicalJsonIfExists<T>(filePath: string): T | undefined {
  try {
    return readJsonIfExists<T>(filePath);
  } catch (error) {
    throw new Error(
      `canonical_artifact_corrupt:${filePath}:${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export async function runMarlinStage(
  opts: MarlinStageOptions,
  projectId: string,
  absProjectDir: string,
  sourceFiles: string[],
  segmentsPath: string,
  sourceIdentityCache: SourceContentIdentityCache,
  expectedSourceHashByPath: Map<string, string>,
): Promise<{ readiness: AnalysisStageReadiness; segmentsJson?: SegmentsJson }> {
  if (!opts.marlinFn) return { readiness: skippedMarlinReadiness("marlin_worker_not_configured") };

  if (sourceFiles.length === 0) {
    invalidateFile(path.join(absProjectDir, "03_analysis", "marlin_events.json"), "marlin_artifact_invalidation_failed");
    invalidateFile(path.join(absProjectDir, "03_analysis", "marlin_rollback.json"), "marlin_rollback_invalidation_failed");
    return { readiness: skippedMarlinReadiness("not_applicable_no_video_stream") };
  }

  console.log("[pipeline] Stage 8.5/12 Marlin reporter starting");
  const canonicalArtifactPath = path.join(absProjectDir, "03_analysis", "marlin_events.json");
  const rollbackPath = path.join(absProjectDir, "03_analysis", "marlin_rollback.json");
  const stagedArtifactPath = path.join(
    absProjectDir,
    "03_analysis",
    `.marlin_events.current-run-${process.pid}-${Date.now()}.json`,
  );
  // Parse and snapshot canonical segments before entering the optional boundary.
  // This is also the rollback source if publishing the derived artifact fails.
  const canonicalSegmentsBeforeMarlin = readCanonicalJsonIfExists<SegmentsJson>(segmentsPath);
  if (!canonicalSegmentsBeforeMarlin) {
    throw new Error("canonical_artifact_missing:03_analysis/segments.json");
  }
  const previousRollback = readCanonicalJsonIfExists<MarlinRollbackArtifact>(rollbackPath);
  const previousMarlinArtifact = readCanonicalJsonIfExists<MarlinEventsArtifact>(canonicalArtifactPath);
  if (previousRollback) validateMarlinRollback(previousRollback);
  if (previousMarlinArtifact) validateMarlinArtifact(previousMarlinArtifact, projectId);
  const baseSegments = previousRollback
    ? rollbackMarlinEnrichment(canonicalSegmentsBeforeMarlin, previousRollback, previousMarlinArtifact)
    : previousMarlinArtifact
      ? scrubLegacyMarlinEnrichment(canonicalSegmentsBeforeMarlin, previousMarlinArtifact)
      : canonicalSegmentsBeforeMarlin;
  for (const sourceFile of sourceFiles) {
    const expectedHash = expectedSourceHashByPath.get(path.resolve(sourceFile));
    if (!expectedHash) throw new Error("source_content_integrity_failed:identity_missing");
    sourceIdentityCache.assertExpected(sourceFile, expectedHash);
  }
  try {
    await runMarlinAnalysis({
      projectDir: absProjectDir,
      projectId,
      sourceFiles,
      marlinFn: opts.marlinFn,
      model: opts.marlinModel,
      queries: opts.marlinQueries,
      outputPath: stagedArtifactPath,
      applyToSegments: false,
    });
  } catch (error) {
    invalidateFile(stagedArtifactPath, "marlin_staged_artifact_cleanup_failed");
    if (!(error instanceof MarlinOptionalAnalysisError)) throw error;
    const reason = classifyMarlinFailure(error.originalError);
    atomicWriteJson(segmentsPath, baseSegments);
    invalidateFile(canonicalArtifactPath, "marlin_artifact_invalidation_failed");
    invalidateFile(rollbackPath, "marlin_rollback_invalidation_failed");
    console.warn(`[pipeline] Marlin reporter degraded: ${reason}`);
    return {
      readiness: {
        status: "partial",
        reason,
        affectedCapabilities: [...MARLIN_AFFECTED_CAPABILITIES],
      },
      segmentsJson: baseSegments,
    };
  }

  // Parse/apply/publish are canonical artifact operations and intentionally live
  // outside the optional worker catch boundary.
  let stagedArtifact: MarlinEventsArtifact;
  try {
    const parsedArtifact = readCanonicalJsonIfExists<MarlinEventsArtifact>(stagedArtifactPath);
    if (!parsedArtifact) throw new Error("marlin_staged_artifact_missing");
    stagedArtifact = parsedArtifact;
    const segmentsImmediatelyBeforeApply = readCanonicalJsonIfExists<SegmentsJson>(segmentsPath);
    if (!segmentsImmediatelyBeforeApply) {
      throw new Error("canonical_artifact_missing:03_analysis/segments.json");
    }
    if (stableValueKey(segmentsImmediatelyBeforeApply) !== stableValueKey(canonicalSegmentsBeforeMarlin)) {
      throw new Error("canonical_artifact_changed_during_marlin:03_analysis/segments.json");
    }
  } catch (error) {
    atomicWriteJson(segmentsPath, canonicalSegmentsBeforeMarlin);
    invalidateFile(stagedArtifactPath, "marlin_staged_artifact_cleanup_failed");
    throw error;
  }
  try {
    atomicWriteJson(segmentsPath, baseSegments);
    applyMarlinEventsToSegments(absProjectDir, stagedArtifact);
    const segmentsAfterMarlin = readCanonicalJsonIfExists<SegmentsJson>(segmentsPath);
    if (!segmentsAfterMarlin) throw new Error("canonical_artifact_missing:03_analysis/segments.json");
    atomicWriteJson(rollbackPath, buildMarlinRollback(baseSegments, segmentsAfterMarlin));
    fs.renameSync(stagedArtifactPath, canonicalArtifactPath);
  } catch (error) {
    atomicWriteJson(segmentsPath, canonicalSegmentsBeforeMarlin);
    invalidateFile(stagedArtifactPath, "marlin_staged_artifact_cleanup_failed");
    invalidateFile(rollbackPath, "marlin_rollback_cleanup_failed");
    throw error;
  }
  const segmentsJson = readCanonicalJsonIfExists<SegmentsJson>(segmentsPath);
  return {
    readiness: { status: "ready", affectedCapabilities: [] },
    segmentsJson,
  };
}

interface MarlinFieldSnapshot {
  present: boolean;
  value?: unknown;
}

interface MarlinSegmentRollback {
  segment_id: string;
  summary: MarlinFieldSnapshot;
  confidence_summary: MarlinFieldSnapshot;
  provenance_summary: MarlinFieldSnapshot;
  peak_analysis: MarlinFieldSnapshot;
  added_tags: string[];
  added_interest_points: unknown[];
}

interface MarlinRollbackArtifact {
  version: "1";
  segments: MarlinSegmentRollback[];
}

// Internal derived artifact: it is deliberately not a canonical schema surface.
// Malformed rollback structure is a hard failure. Segment-set mismatch is only
// cache staleness: current IDs use the intersection and unmatched IDs fall back
// to provenance-aware legacy scrubbing when the prior artifact is available.
function validateMarlinRollback(rollback: MarlinRollbackArtifact): void {
  if (rollback.version !== "1" || !Array.isArray(rollback.segments)) {
    throw new Error("marlin_rollback_artifact_malformed");
  }
  const seen = new Set<string>();
  for (const entry of rollback.segments) {
    if (!entry || typeof entry.segment_id !== "string" || seen.has(entry.segment_id)) {
      throw new Error("marlin_rollback_artifact_malformed");
    }
    seen.add(entry.segment_id);
    if (
      !validFieldSnapshot(entry.summary) ||
      !validFieldSnapshot(entry.confidence_summary) ||
      !validFieldSnapshot(entry.provenance_summary) ||
      !validFieldSnapshot(entry.peak_analysis) ||
      !Array.isArray(entry.added_tags) || !entry.added_tags.every(isString) ||
      !Array.isArray(entry.added_interest_points)
    ) {
      throw new Error("marlin_rollback_artifact_malformed");
    }
  }
}

function validFieldSnapshot(value: unknown): value is MarlinFieldSnapshot {
  return Boolean(value && typeof value === "object" && typeof (value as MarlinFieldSnapshot).present === "boolean");
}

function validateMarlinArtifact(artifact: MarlinEventsArtifact, projectId: string): void {
  if (artifact.project_id !== projectId || !Array.isArray(artifact.items)) {
    throw new Error("marlin_events_artifact_mismatched");
  }
}

function buildMarlinRollback(before: SegmentsJson, after: SegmentsJson): MarlinRollbackArtifact {
  const beforeById = new Map(before.items.map((segment) => [segment.segment_id, segment]));
  return {
    version: "1",
    segments: after.items.flatMap((afterSegment) => {
      const beforeSegment = beforeById.get(afterSegment.segment_id);
      if (!beforeSegment) return [];
      const beforeRecord = beforeSegment as unknown as Record<string, unknown>;
      const afterRecord = afterSegment as unknown as Record<string, unknown>;
      const beforeTags = new Set(Array.isArray(beforeRecord.tags) ? beforeRecord.tags.filter(isString) : []);
      const beforeInterest = Array.isArray(beforeRecord.interest_points) ? beforeRecord.interest_points : [];
      const beforeInterestKeys = new Set(beforeInterest.map(stableValueKey));
      return [{
        segment_id: afterSegment.segment_id,
        summary: fieldSnapshot(beforeRecord, "summary"),
        confidence_summary: fieldSnapshot(asRecord(beforeRecord.confidence), "summary"),
        provenance_summary: fieldSnapshot(asRecord(beforeRecord.provenance), "summary"),
        peak_analysis: fieldSnapshot(beforeRecord, "peak_analysis"),
        added_tags: (Array.isArray(afterRecord.tags) ? afterRecord.tags.filter(isString) : [])
          .filter((tag) => !beforeTags.has(tag)),
        added_interest_points: (Array.isArray(afterRecord.interest_points) ? afterRecord.interest_points : [])
          .filter((point) => !beforeInterestKeys.has(stableValueKey(point))),
      }];
    }),
  };
}

function rollbackMarlinEnrichment(
  segmentsJson: SegmentsJson,
  rollback: MarlinRollbackArtifact,
  previousArtifact?: MarlinEventsArtifact,
): SegmentsJson {
  if (rollback.version !== "1" || !Array.isArray(rollback.segments)) {
    throw new Error("marlin_rollback_artifact_malformed");
  }
  const rollbackById = new Map(rollback.segments.map((entry) => [entry.segment_id, entry]));
  const legacyScrubbedById = previousArtifact
    ? new Map(scrubLegacyMarlinEnrichment(segmentsJson, previousArtifact).items.map((segment) => [segment.segment_id, segment]))
    : new Map<string, SegmentItem>();
  return {
    ...segmentsJson,
    items: segmentsJson.items.map((segment) => {
      const entry = rollbackById.get(segment.segment_id);
      if (!entry) return legacyScrubbedById.get(segment.segment_id) ?? segment;
      const next = cloneJson(segment) as unknown as Record<string, unknown>;
      const provenance = asRecord(next.provenance);
      const summaryProvenance = asRecord(provenance.summary);
      if (summaryProvenance.method === MARLIN_REPORTER_METHOD) {
        restoreField(next, "summary", entry.summary);
        const confidence = { ...asRecord(next.confidence) };
        restoreField(confidence, "summary", entry.confidence_summary);
        next.confidence = confidence;
        const nextProvenance = { ...provenance };
        restoreField(nextProvenance, "summary", entry.provenance_summary);
        next.provenance = nextProvenance;
      }

      const addedTags = new Set(entry.added_tags);
      if (Array.isArray(next.tags)) next.tags = next.tags.filter((tag) => !addedTags.has(String(tag)));
      const addedInterest = new Set(entry.added_interest_points.map(stableValueKey));
      if (Array.isArray(next.interest_points)) {
        next.interest_points = next.interest_points.filter((point) => !addedInterest.has(stableValueKey(point)));
      }
      const peakProvenance = asRecord(asRecord(next.peak_analysis).provenance);
      if (peakProvenance.precision_mode === "marlin_temporal_semantics") {
        restoreField(next, "peak_analysis", entry.peak_analysis);
      }
      return next as unknown as SegmentItem;
    }),
  };
}

function scrubLegacyMarlinEnrichment(
  segmentsJson: SegmentsJson,
  artifact: MarlinEventsArtifact,
): SegmentsJson {
  const evidenceByAsset = new Map(artifact.items.map((item) => [item.asset_id, {
    tags: new Set(extractTagsFromScene(item.scene)),
    descriptions: new Set([
      ...item.events.map((event) => event.description),
      ...item.find_results.map((result) => result.query),
    ].filter(Boolean)),
  }]));
  return {
    ...segmentsJson,
    items: segmentsJson.items.map((segment) => {
      const evidence = evidenceByAsset.get(segment.asset_id);
      const next = cloneJson(segment) as unknown as Record<string, unknown>;
      const provenance = { ...asRecord(next.provenance) };
      if (asRecord(provenance.summary).method === MARLIN_REPORTER_METHOD) {
        next.summary = "";
        const confidence = { ...asRecord(next.confidence) };
        delete confidence.summary;
        next.confidence = confidence;
        delete provenance.summary;
        next.provenance = provenance;
      }
      if (evidence && Array.isArray(next.tags)) {
        next.tags = next.tags.filter((tag) => !evidence.tags.has(String(tag)));
      }
      if (evidence && Array.isArray(next.interest_points)) {
        next.interest_points = next.interest_points.filter((point) => {
          const label = String(asRecord(point).label ?? "");
          return ![...evidence.descriptions].some((description) => label.endsWith(description));
        });
      }
      if (asRecord(asRecord(next.peak_analysis).provenance).precision_mode === "marlin_temporal_semantics") {
        delete next.peak_analysis;
      }
      return next as unknown as SegmentItem;
    }),
  };
}

function fieldSnapshot(record: Record<string, unknown>, key: string): MarlinFieldSnapshot {
  return Object.prototype.hasOwnProperty.call(record, key)
    ? { present: true, value: cloneArtifactValue(record[key]) }
    : { present: false };
}

function restoreField(record: Record<string, unknown>, key: string, snapshot: MarlinFieldSnapshot): void {
  if (snapshot.present) record[key] = cloneArtifactValue(snapshot.value);
  else delete record[key];
}

function cloneArtifactValue(value: unknown): unknown {
  return value === undefined ? undefined : cloneJson(value);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stableValueKey(value: unknown): string {
  return JSON.stringify(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

const MARLIN_AFFECTED_CAPABILITIES = [
  "marlin_scene_reporting",
  "marlin_event_detection",
  "marlin_temporal_peak_evidence",
] as const;

export function initialMarlinReadiness(opts: MarlinStageOptions): AnalysisStageReadiness {
  if (opts.skipMarlin) return skippedMarlinReadiness("marlin_skipped_by_request");
  if (!opts.marlinFn) return skippedMarlinReadiness("marlin_worker_not_configured");
  if (opts.vlmOnly) return skippedMarlinReadiness("marlin_outside_vlm_only_route");
  return { status: "ready", affectedCapabilities: [] };
}

function skippedMarlinReadiness(reason: string): AnalysisStageReadiness {
  return { status: "skipped", reason, affectedCapabilities: [] };
}

export function buildAnalysisReadiness(marlin: AnalysisStageReadiness): AnalysisReadiness {
  return {
    overall: marlin.status === "partial" ? "partial" : "ready",
    stages: { marlin },
  };
}

export function appendMarlinGap(
  gapReport: GapReport,
  projectId: string,
  readiness: AnalysisStageReadiness,
): void {
  if (readiness.status !== "partial") return;
  const reason = readiness.reason ?? "marlin_worker_failure";
  gapReport.entries.push({
    stage: "marlin",
    asset_id: projectId,
    issue: `marlin_failed: ${reason}`,
    severity: "warning",
    blocking: false,
    retriable: true,
    consumer_impact: "Marlin-derived scene, event, and temporal peak evidence unavailable for this run.",
    affected_capabilities: [...readiness.affectedCapabilities],
    attempted_at: new Date().toISOString(),
  });
}

function classifyMarlinFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/timed?\s*out|timeout/i.test(message)) return "marlin_worker_timeout";
  if (/model[^\n]*(?:missing|not found|unavailable)|model_not_found/i.test(message)) {
    return "marlin_model_unavailable";
  }
  if (/\bENOENT\b|\bspawn\b|worker[^\n]*(?:missing|not found|unavailable)/i.test(message)) {
    return "marlin_worker_unavailable";
  }
  return "marlin_worker_failure";
}

function invalidateFile(filePath: string, errorCode: string): void {
  try {
    fs.rmSync(filePath, { force: true });
  } catch (error) {
    throw new Error(
      `${errorCode}:${error instanceof Error ? error.name : "unknown"}`,
    );
  }
}
