import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { AssetItem } from "../connectors/ffprobe.js";
import type { SegmentItem } from "../connectors/ffmpeg-segmenter.js";
import type { AssetSttResult } from "../connectors/openai-stt.js";
import { discoverRequestedSources } from "../media/source-discovery.js";
import type { ConsumerImpact } from "../media/media-kind-registry.js";
import { buildSourceLedger, type SourceLedger } from "./source-ledger.js";
import { hasTemporalVideo } from "./source-media-capabilities.js";
import { atomicWriteJson } from "../pipeline/stages/_util.js";

export interface RunnerValidationResult {
  valid: boolean;
  violations: string[];
}

export interface SourceMediaManifestItem {
  asset_id: string | null;
  source_id?: string;
  source_locator: string;
  filename: string;
  content_hash: string | null;
  fingerprint: string | null;
  size_bytes: number | null;
  mtime: string | null;
  media_kind: "video" | "audio" | "image" | "sequence" | "unknown";
  ingest_status: "ready" | "missing" | "stale" | "unsupported" | "failed" | "excluded";
  reason?: string | null;
  consumer_impact?: ConsumerImpact;
  rights_status: "unknown" | "operator_declared_ok" | "licensed" | "restricted" | "blocked";
  privacy_status: "unknown" | "operator_declared_ok" | "contains_people" | "sensitive" | "blocked";
  analysis_policy_ref: string;
  capture_started_at: string | null;
  capture_timezone: string | null;
  timecode_start: string | null;
  timecode_format: "none" | "non_drop" | "drop_frame" | "inferred" | "unknown";
  sample_rate: number | null;
  duration_us: number | null;
  frame_rate_mode: "cfr" | "vfr" | "audio_only" | "still_image" | "unknown";
  rotation: 0 | 90 | 180 | 270 | null;
  audio_video_offset_ms: number | null;
  clock_source: "file_metadata" | "timecode_track" | "operator_declared" | "inferred" | "unknown";
}

export interface SourceMediaManifest {
  version: "1.0.0";
  project_id: string;
  artifact_version: "manifest-v1";
  created_at: string;
  source_root: {
    locator: string;
    locator_kind: "local_path" | "symlink" | "external_drive" | "cloud_uri" | "mixed";
  };
  items: SourceMediaManifestItem[];
  provenance: {
    producer: "init-project" | "analysis-ingest" | "ingest-command";
    inputs: Array<{ path: string; hash: string }>;
    hash_policy: {
      algorithm: "sha256";
      canonicalization: "normalized-json-v1";
      excluded_fields: string[];
    };
  };
}

export interface LaneStatus {
  lane_id: string;
  status: "pending" | "ready" | "partial" | "skipped" | "failed" | "waived";
  required: boolean;
  reason?: string | null;
  consumer_impact: string;
  asset_ids: string[];
  artifact_hash?: string | null;
}

export interface AnalysisCoverageReport {
  version: "1.0.0";
  project_id: string;
  artifact_version: "analysis-v1";
  created_at: string;
  source_media_manifest_hash: string;
  summary: {
    status: "ready" | "partial_override" | "blocked";
    required_lane_count: number;
    ready_lane_count: number;
    blocked_lane_count: number;
    partial_lane_count: number;
    source_counts?: {
      requested: number;
      ready: number;
      unsupported: number;
      failed: number;
    };
  };
  lanes: LaneStatus[];
  assets: Array<{
    asset_id: string;
    status: "ready" | "partial" | "blocked" | "excluded";
    lanes: LaneStatus[];
  }>;
  blockers: Array<{
    blocker_id: string;
    severity: "warning" | "blocker";
    lane_id: string;
    asset_ids: string[];
    message: string;
  }>;
  overrides: Array<{
    override_id: string;
    status: "active" | "stale" | "expired";
    scope: string;
    approved_by: string;
    approved_at: string;
    expires_at?: string | null;
    applies_to_artifact_hash?: string | null;
  }>;
  provenance: {
    producer: "scripts/analyze.ts" | "analysis-pipeline";
    inputs: Array<Record<string, unknown>>;
    hash_policy: Record<string, unknown>;
  };
}

export function isP1ManifestCoverageEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.ENABLE_P1_MANIFEST_COVERAGE ?? env.ENABLE_P1_MANIFEST ?? "";
  return /^(1|true|yes|on)$/i.test(raw);
}

export function normalizeJsonValue(value: unknown, excludedFields: string[] = []): unknown {
  if (typeof value === "string") return value.normalize("NFC");
  if (Array.isArray(value)) return value.map((item) => normalizeJsonValue(item, excludedFields));
  if (!value || typeof value !== "object") return value;

  const source = value as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(source).sort()) {
    if (excludedFields.includes(key)) continue;
    result[key.normalize("NFC")] = normalizeJsonValue(source[key], excludedFields);
  }
  return result;
}

export function computeNormalizedJsonHash(value: unknown, excludedFields: string[] = []): string {
  const normalized = JSON.stringify(normalizeJsonValue(value, excludedFields));
  return `sha256:${crypto.createHash("sha256").update(normalized, "utf-8").digest("hex")}`;
}

export function validateSourceMediaManifest(data: unknown): RunnerValidationResult {
  const violations: string[] = [];
  const manifest = data as Partial<SourceMediaManifest>;
  if (!Array.isArray(manifest.items)) {
    violations.push("items must be an array");
  } else {
    manifest.items.forEach((item, index) => {
      if (item.source_id && item.ingest_status === "ready" && (!item.asset_id || !item.fingerprint)) {
        violations.push(`items/${index} canonical ready item must have asset_id and fingerprint`);
      }
      if (item.ingest_status === "ready" && !item.content_hash && !item.fingerprint) {
        violations.push(`items/${index} ready item must have content_hash or fingerprint`);
      }
    });
  }
  return { valid: violations.length === 0, violations };
}

export function validateAnalysisCoverageReport(data: unknown): RunnerValidationResult {
  const violations: string[] = [];
  const report = data as Partial<AnalysisCoverageReport>;
  const lanes = Array.isArray(report.lanes) ? report.lanes : [];
  const sourceLane = lanes.find((lane) => lane.lane_id === "source_manifest");
  const requiredBlocked = lanes.filter((lane) =>
    lane.required && ["pending", "partial", "skipped", "failed"].includes(lane.status)
  );

  if (report.summary?.status === "ready") {
    if (!sourceLane || sourceLane.status !== "ready") {
      violations.push("ready coverage requires source_manifest lane ready");
    }
    if (requiredBlocked.length > 0) {
      violations.push("ready coverage cannot include blocked required lanes");
    }
  }

  if (report.summary?.status === "partial_override") {
    const hasActiveOverride = Array.isArray(report.overrides) &&
      report.overrides.some((override) => override.status === "active");
    if (!hasActiveOverride) {
      violations.push("partial_override coverage requires an active override");
    }
  }

  for (const lane of lanes) {
    if (lane.status === "skipped" && !lane.reason) {
      violations.push(`skipped lane ${lane.lane_id} requires reason`);
    }
  }

  return { valid: violations.length === 0, violations };
}

export function validateAnalysisCoverageFreshness(projectDir: string): RunnerValidationResult {
  const manifestPath = path.join(projectDir, "02_media/source_media_manifest.json");
  const coveragePath = path.join(projectDir, "03_analysis/analysis_coverage_report.json");
  if (!fs.existsSync(manifestPath) || !fs.existsSync(coveragePath)) {
    return { valid: false, violations: ["source manifest and analysis coverage report are required"] };
  }
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8")) as SourceMediaManifest;
    const coverage = JSON.parse(fs.readFileSync(coveragePath, "utf-8")) as AnalysisCoverageReport;
    const excludedFields = manifest.provenance?.hash_policy?.excluded_fields ?? [];
    const currentHash = computeNormalizedJsonHash(manifest, excludedFields);
    if (coverage.source_media_manifest_hash !== currentHash) {
      return {
        valid: false,
        violations: [
          `source_media_manifest_hash ${String(coverage.source_media_manifest_hash)} does not match current manifest ${currentHash}`,
        ],
      };
    }
    return { valid: true, violations: [] };
  } catch (error) {
    return { valid: false, violations: [error instanceof Error ? error.message : String(error)] };
  }
}

export interface BuildManifestOptions {
  projectDir: string;
  projectId: string;
  sourceFiles?: string[];
  sourceRoot?: string;
  sourceRootKind?: SourceMediaManifest["source_root"]["locator_kind"];
  producer?: SourceMediaManifest["provenance"]["producer"];
  createdAt?: string;
  ledger?: SourceLedger;
  assets?: AssetItem[];
}

export function buildSourceMediaManifest(options: BuildManifestOptions): SourceMediaManifest {
  const projectDir = path.resolve(options.projectDir);
  const requestedLocators = options.sourceFiles?.length
    ? options.sourceFiles
    : options.sourceRoot
      ? [options.sourceRoot]
      : [];
  const ledger = options.ledger ?? buildSourceLedger(
    options.projectId,
    discoverRequestedSources(requestedLocators),
    new Map(),
    options.createdAt,
    projectDir,
  );
  const sourceFiles = ledger.items
    .map((item) => item.canonical_locator)
    .filter((item): item is string => !!item);
  const hasExternalSources = sourceFiles.some((filePath) => filePath.startsWith("external://"));
  const localSourceFiles = sourceFiles
    .filter((filePath) => !filePath.startsWith("external://"))
    .map((filePath) => path.isAbsolute(filePath) ? filePath : path.resolve(projectDir, filePath));
  const sourceRoot = options.sourceRoot && !options.sourceRoot.startsWith("external://")
    ? (path.isAbsolute(options.sourceRoot) ? options.sourceRoot : path.resolve(projectDir, options.sourceRoot))
    : inferSourceRoot(localSourceFiles, projectDir);
  const sourceRootLocator = hasExternalSources
    ? "external://mixed"
    : path.relative(projectDir, sourceRoot) || ".";
  const assetMap = new Map((options.assets ?? []).map((asset) => [asset.asset_id, asset]));
  const items = ledger.items.map((item) => ledgerItemToManifestItem(projectDir, item, assetMap));
  const rootHash = computeNormalizedJsonHash(ledger.items.map((item) => ({
    source_id: item.source_id,
    path: item.requested_locator,
    hash: item.content_hash,
  })));

  return {
    version: "1.0.0",
    project_id: options.projectId,
    artifact_version: "manifest-v1",
    created_at: options.createdAt ?? new Date().toISOString(),
    source_root: {
      locator: sourceRootLocator,
      locator_kind: options.sourceRootKind ?? (hasExternalSources ? "mixed" : "local_path"),
    },
    items,
    provenance: {
      producer: options.producer ?? "analysis-ingest",
      inputs: [{ path: sourceRootLocator, hash: rootHash }],
      hash_policy: {
        algorithm: "sha256",
        canonicalization: "normalized-json-v1",
        excluded_fields: ["created_at"],
      },
    },
  };
}

export function writeSourceMediaManifest(options: BuildManifestOptions): SourceMediaManifest {
  const manifest = buildSourceMediaManifest(options);
  const outPath = path.join(options.projectDir, "02_media/source_media_manifest.json");
  atomicWriteJson(outPath, manifest);
  return manifest;
}

export interface BuildCoverageOptions {
  projectId: string;
  manifest: unknown;
  createdAt?: string;
  ledger?: SourceLedger;
  analysis?: {
    assets: AssetItem[];
    segments: SegmentItem[];
    segmentsSchemaValid?: boolean;
    sttAttempted: boolean;
    sttSkipReason?: string;
    sttResults?: Map<string, AssetSttResult>;
    sttSkippedAssetIds?: Set<string>;
    audioEvents?: {
      attemptedAssetIds: string[];
      failures: Map<string, string>;
      artifactHash: string;
    };
    audioStoryGraph?: {
      status: LaneStatus["status"];
      assetIds: string[];
      artifactHash: string | null;
    };
    vlm: StageAssetResults;
    peaks: StageAssetResults;
    bgm: StageAssetResults & {
      requestedAssetIds: string[];
      requestedCount: number;
      unmatchedRequestedCount: number;
      bindingFailures?: string[];
      artifactHash?: string | null;
    };
  };
}

export interface StageAssetResults {
  attempted: boolean;
  readyAssetIds: string[];
  failedAssetIds: string[];
}

export function buildAnalysisCoverageReport(options: BuildCoverageOptions): AnalysisCoverageReport {
  const manifest = options.manifest as SourceMediaManifest;
  const items = Array.isArray(manifest.items) ? manifest.items : [];
  const manifestHash = computeNormalizedJsonHash(manifest, manifest.provenance?.hash_policy?.excluded_fields ?? []);
  const blockedItems = items.filter((item) => ["missing", "stale", "failed"].includes(item.ingest_status));
  const readyItems = items.filter((item) => item.ingest_status === "ready");
  const identifiedReadyItems = uniqueIdentifiedItems(readyItems);
  const identifiedBlockedItems = uniqueIdentifiedItems(blockedItems);
  const unsupportedItems = items.filter((item) => item.ingest_status === "unsupported");
  const excludedItems = items.filter((item) => item.ingest_status === "excluded");
  const hasPlanningBlockedReady = readyItems.some((item) => item.consumer_impact === "planning_block");
  const sourceStatus: LaneStatus["status"] = readyItems.length === 0
    ? "failed"
    : blockedItems.length > 0 || unsupportedItems.length > 0 || hasPlanningBlockedReady
      ? "partial"
      : "ready";
  const sourceReason = sourceStatus === "ready"
    ? null
    : hasPlanningBlockedReady && blockedItems.length === 0 && unsupportedItems.length === 0
      ? "one or more analysis-ready sources remain blocked by a pending downstream media-kind lane"
      : "manifest contains unsupported or failed requested sources";
  const sourceLane: LaneStatus =
    {
      lane_id: "source_manifest",
      status: sourceStatus,
      required: true,
      reason: sourceReason,
      consumer_impact: sourceStatus === "ready" ? "none" : "planning_block",
      asset_ids: identifiedReadyItems.map((item) => item.asset_id),
      artifact_hash: manifestHash,
    };
  const ffprobeLane: LaneStatus = {
      lane_id: "ffprobe",
      status: readyItems.length > 0 ? "ready" : "pending",
      required: true,
      reason: readyItems.length > 0 ? null : "no ready source items to probe",
      consumer_impact: readyItems.length > 0 ? "none" : "planning_block",
      asset_ids: identifiedReadyItems.map((item) => item.asset_id),
      artifact_hash: null,
    };
  const lanes: LaneStatus[] = [sourceLane, ffprobeLane, ...buildAnalysisLanes(options.analysis)];
  const blockers = [
    ...blockedItems,
    ...unsupportedItems,
    ...readyItems.filter((item) => item.consumer_impact === "planning_block" || item.consumer_impact === "package_block"),
  ].map((item) => ({
    blocker_id: `COVBLK_${(item.source_id ?? item.asset_id ?? "source").replace(/^(AST|SRC)_/, "")}`,
    severity: (item.ingest_status === "ready" && item.consumer_impact === "package_block"
      ? "warning"
      : readyItems.length === 0 || item.ingest_status !== "unsupported"
        ? "blocker"
        : "warning") as "warning" | "blocker",
    lane_id: "source_manifest",
    asset_ids: item.asset_id ? [item.asset_id] : [],
    message: item.ingest_status === "ready"
      ? item.consumer_impact === "package_block"
        ? `Source ${item.source_id ?? item.asset_id ?? item.source_locator} is analysis/plan/compile-ready but package-blocked: ${item.reason ?? "render consumer unavailable"}`
        : `Source ${item.source_id ?? item.asset_id ?? item.source_locator} is analysis-ready but planning-blocked: ${item.reason ?? "downstream consumer unavailable"}`
      : `Source ${item.source_id ?? item.asset_id ?? item.source_locator} is ${item.ingest_status}: ${item.reason ?? "no reason recorded"}`,
  }));
  const requiredLanes = lanes.filter((lane) => lane.required);
  const blockedLaneCount = requiredLanes.filter((lane) => ["pending", "partial", "skipped", "failed"].includes(lane.status)).length;
  const readyLaneCount = requiredLanes.filter((lane) => lane.status === "ready").length;
  const status = blockedLaneCount > 0 ? "blocked" : "ready";

  return {
    version: "1.0.0",
    project_id: options.projectId,
    artifact_version: "analysis-v1",
    created_at: options.createdAt ?? new Date().toISOString(),
    source_media_manifest_hash: manifestHash,
    summary: {
      status,
      required_lane_count: requiredLanes.length,
      ready_lane_count: readyLaneCount,
      blocked_lane_count: blockedLaneCount,
      partial_lane_count: requiredLanes.filter((lane) => lane.status === "partial").length,
      source_counts: options.ledger?.summary,
    },
    lanes,
    assets: [
      ...identifiedReadyItems.map((item) => {
        const itemLanes = lanesForAsset(item, lanes, options.analysis);
        return {
        asset_id: item.asset_id,
        status: (item.consumer_impact === "planning_block" || itemLanes.some((lane) => ["partial", "failed"].includes(lane.status))
          ? "partial"
          : "ready") as "ready" | "partial",
        lanes: itemLanes,
      };
      }),
      ...identifiedBlockedItems.map((item) => ({
        asset_id: item.asset_id,
        status: "blocked" as const,
        lanes: lanes.filter((lane) => lane.asset_ids.includes(item.asset_id)),
      })),
      ...excludedItems.filter((item): item is SourceMediaManifestItem & { asset_id: string } => !!item.asset_id).map((item) => ({
        asset_id: item.asset_id,
        status: "excluded" as const,
        lanes: [],
      })),
    ],
    blockers,
    overrides: [],
    provenance: {
      producer: "scripts/analyze.ts",
      inputs: [
        {
          path: "02_media/source_media_manifest.json",
          hash: manifestHash,
        },
      ],
      hash_policy: {
        algorithm: "sha256",
        canonicalization: "normalized-json-v1",
        excluded_fields: ["created_at"],
      },
    },
  };
}

function buildAnalysisLanes(analysis: BuildCoverageOptions["analysis"]): LaneStatus[] {
  const laneIds = [
    "segments", "contact_sheets", "filmstrips", "visual_quality", "stt", "diarization", "vlm_tags",
    "vlm_peaks", "audio_events", "bgm_analysis", "audio_story_graph", "continuity_graph",
    "embeddings", "sync_quality",
  ];
  if (!analysis) {
    return laneIds.map((laneId) => ({
      lane_id: laneId,
      status: ["diarization", "continuity_graph", "embeddings", "sync_quality"].includes(laneId) ? "skipped" : "pending",
      required: laneId === "segments",
      reason: ["diarization", "continuity_graph", "embeddings", "sync_quality"].includes(laneId)
        ? "not produced by EYE-070B1 analysis lane"
        : "analysis stage not completed",
      consumer_impact: laneId === "segments" ? "planning_block" : "planning_warn",
      asset_ids: [],
      artifact_hash: null,
    }));
  }
  const visualAssets = analysis.assets.filter((asset) => asset.media_kind === "image" || hasTemporalVideo(asset));
  const temporalVideoAssets = analysis.assets.filter((asset) => asset.media_kind !== "image" && hasTemporalVideo(asset));
  const audioAssets = analysis.assets.filter((asset) => !!asset.audio_stream);
  const segmentAssetIds = analysis.segmentsSchemaValid === false
    ? new Set<string>()
    : new Set(analysis.segments.map((segment) => segment.asset_id));
  const segmentsReady = analysis.assets.filter((asset) => segmentAssetIds.has(asset.asset_id)).map((asset) => asset.asset_id);
  const sttReady = audioAssets.filter((asset) => analysis.sttResults?.get(asset.asset_id)?.success || asset.has_transcript).map((asset) => asset.asset_id);
  const sttFailed = audioAssets.filter((asset) => analysis.sttResults?.has(asset.asset_id) && !analysis.sttResults.get(asset.asset_id)?.success);
  const sttSkipped = analysis.sttSkippedAssetIds ?? new Set<string>();
  const eventAttempted = new Set(analysis.audioEvents?.attemptedAssetIds ?? []);
  const eventReady = audioAssets.filter((asset) => eventAttempted.has(asset.asset_id) && !analysis.audioEvents?.failures.has(asset.asset_id)).map((asset) => asset.asset_id);
  const visualLane = (laneId: string, applicableAssets: AssetItem[], result: StageAssetResults): LaneStatus => ({
    lane_id: laneId,
    status: aggregateStageStatus(applicableAssets.map((asset) => asset.asset_id), result),
    required: false,
    reason: applicableAssets.length === 0 ? "not_applicable_no_eligible_visual_source" : !result.attempted ? "stage skipped by request or runtime" : result.failedAssetIds.length > 0 ? "one or more visual assets failed" : result.readyAssetIds.length < applicableAssets.length ? "one or more visual assets produced no result" : null,
    consumer_impact: result.failedAssetIds.length > 0 ? "triage_warn" : "none",
    asset_ids: result.readyAssetIds,
    artifact_hash: null,
  });
  const contactReady = visualAssets.filter((asset) => asset.contact_sheet_ids.length > 0).map((asset) => asset.asset_id);
  const filmstripReady = temporalVideoAssets.filter((asset) => analysis.segments.some((segment) => segment.asset_id === asset.asset_id && !!segment.filmstrip_path)).map((asset) => asset.asset_id);
  const visualQualityReady = visualAssets.filter((asset) => analysis.segments.some((segment) => {
    if (segment.asset_id !== asset.asset_id) return false;
    const measurements = segment.visual_quality_measurements;
    return asset.media_kind === "image"
      ? Boolean(measurements?.metrics_measured.sharpness && measurements.metrics_measured.exposure && !measurements.metrics_measured.shake)
      : Boolean(measurements?.measured);
  })).map((asset) => asset.asset_id);
  return [
    {
      lane_id: "segments",
      status: segmentsReady.length === analysis.assets.length && analysis.assets.length > 0 ? "ready" : segmentsReady.length > 0 ? "partial" : "failed",
      required: true,
      reason: analysis.segmentsSchemaValid === false
        ? "canonical segments artifact failed schema validation"
        : segmentsReady.length === analysis.assets.length
          ? null
          : "one or more ready assets have no deterministic segments",
      consumer_impact: segmentsReady.length === analysis.assets.length ? "none" : "planning_block",
      asset_ids: segmentsReady,
      artifact_hash: null,
    },
    visualLane("contact_sheets", visualAssets, derivativeStageResults(visualAssets, contactReady)),
    visualLane("filmstrips", temporalVideoAssets, derivativeStageResults(temporalVideoAssets, filmstripReady)),
    visualLane("visual_quality", visualAssets, derivativeStageResults(visualAssets, visualQualityReady)),
    {
      lane_id: "stt",
      status: audioAssets.length === 0 ? "skipped" : sttReady.length === audioAssets.length ? "ready" : !analysis.sttAttempted ? "skipped" : sttFailed.length > 0 || sttReady.length + sttSkipped.size < audioAssets.length ? (sttReady.length > 0 ? "partial" : "failed") : sttReady.length > 0 ? "ready" : "skipped",
      required: false,
      reason: audioAssets.length === 0 ? "not_applicable_no_audio_stream" : sttReady.length === audioAssets.length ? null : !analysis.sttAttempted ? analysis.sttSkipReason ?? "stt not attempted" : sttFailed.length > 0 ? "one or more STT attempts failed" : sttReady.length === 0 && sttSkipped.size === audioAssets.length ? "not_applicable_silent_audio" : sttReady.length === 0 ? "no STT result produced" : null,
      consumer_impact: sttFailed.length > 0 ? "planning_warn" : "none",
      asset_ids: sttReady,
      artifact_hash: null,
    },
    skippedLane("diarization", "optional diarization coverage is not materialized by EYE-070B1"),
    visualLane("vlm_tags", visualAssets, analysis.vlm),
    visualLane("vlm_peaks", temporalVideoAssets, analysis.peaks),
    {
      lane_id: "audio_events",
      status: audioAssets.length === 0 ? "skipped" : !analysis.audioEvents ? "skipped" : analysis.audioEvents.failures.size > 0 ? "partial" : "ready",
      required: false,
      reason: audioAssets.length === 0 ? "not_applicable_no_audio_stream" : !analysis.audioEvents ? "audio event producer not run" : analysis.audioEvents.failures.size > 0 ? "one or more silencedetect runs failed" : null,
      consumer_impact: analysis.audioEvents?.failures.size ? "planning_warn" : "none",
      asset_ids: eventReady,
      artifact_hash: analysis.audioEvents?.artifactHash ?? null,
    },
    {
      lane_id: "bgm_analysis",
      status: analysis.bgm.requestedCount === 0 || !analysis.bgm.attempted ? "skipped" : analysis.bgm.readyAssetIds.length === analysis.bgm.requestedCount ? "ready" : analysis.bgm.readyAssetIds.length > 0 ? "partial" : "failed",
      required: analysis.bgm.requestedCount > 0 && analysis.bgm.attempted,
      reason: analysis.bgm.requestedCount === 0 ? "no_explicit_bgm_role_input" : !analysis.bgm.attempted ? "bgm analysis skipped by request" : analysis.bgm.unmatchedRequestedCount > 0 ? "one or more explicit BGM requests did not match the current source set" : (analysis.bgm.bindingFailures?.length ?? 0) > 0 ? "explicit BGM role binding failed closed" : analysis.bgm.failedAssetIds.length > 0 ? "one or more explicit BGM analyses failed" : null,
      consumer_impact: analysis.bgm.failedAssetIds.length > 0 || analysis.bgm.unmatchedRequestedCount > 0 || (analysis.bgm.bindingFailures?.length ?? 0) > 0 ? "planning_block" : "none",
      asset_ids: analysis.bgm.readyAssetIds,
      artifact_hash: analysis.bgm.artifactHash ?? null,
    },
    {
      lane_id: "audio_story_graph",
      status: analysis.audioStoryGraph?.status ?? "skipped",
      required: false,
      reason: analysis.audioStoryGraph ? (analysis.audioStoryGraph.status === "ready" ? null : `audio story graph ${analysis.audioStoryGraph.status}`) : "audio story graph not produced",
      consumer_impact: analysis.audioStoryGraph?.status === "failed" ? "planning_warn" : "none",
      asset_ids: analysis.audioStoryGraph?.assetIds ?? [],
      artifact_hash: analysis.audioStoryGraph?.artifactHash ?? null,
    },
    skippedLane("continuity_graph", "outside EYE-070B1"),
    skippedLane("embeddings", "outside EYE-070B1"),
    skippedLane("sync_quality", "outside EYE-070B1"),
  ];
}

function skippedLane(laneId: string, reason: string): LaneStatus {
  return { lane_id: laneId, status: "skipped", required: false, reason, consumer_impact: "none", asset_ids: [], artifact_hash: null };
}

function lanesForAsset(
  item: SourceMediaManifestItem & { asset_id: string },
  lanes: LaneStatus[],
  analysis: BuildCoverageOptions["analysis"],
): LaneStatus[] {
  const analysisAsset = analysis?.assets.find((asset) => asset.asset_id === item.asset_id);
  const audioOnly = item.media_kind === "audio"
    || Boolean(analysisAsset?.audio_stream && !hasTemporalVideo(analysisAsset));
  return lanes.map((lane) => {
    if (!analysis) return lane;
    if (lane.lane_id === "source_manifest") {
      return {
        ...lane,
        status: item.consumer_impact === "planning_block" ? "partial" : "ready",
        reason: item.consumer_impact === "planning_block" ? item.reason ?? "downstream consumer unavailable" : null,
        consumer_impact: item.consumer_impact ?? "none",
        asset_ids: [item.asset_id],
      };
    }
    if (audioOnly && ["contact_sheets", "filmstrips", "visual_quality", "vlm_tags", "vlm_peaks"].includes(lane.lane_id)) {
      return { ...lane, status: "skipped", reason: "not_applicable_no_video_stream", consumer_impact: "none", asset_ids: [] };
    }
    if (item.media_kind === "image" && ["filmstrips", "vlm_peaks", "stt", "diarization", "audio_events", "bgm_analysis", "audio_story_graph", "sync_quality"].includes(lane.lane_id)) {
      return { ...lane, status: "skipped", reason: "not_applicable_still_image", consumer_impact: "none", asset_ids: [] };
    }
    const included = lane.asset_ids.includes(item.asset_id);
    const failed = stageFailedForAsset(lane.lane_id, item.asset_id, analysis);
    return {
      ...lane,
      status: included ? (lane.lane_id === "audio_story_graph" && lane.status === "partial" ? "partial" : "ready") : failed ? "failed" : lane.status === "pending" ? "pending" : "skipped",
      reason: included ? null : failed ? `${lane.lane_id} failed for asset` : lane.reason,
      asset_ids: included ? [item.asset_id] : [],
    };
  });
}

function aggregateStageStatus(assetIds: string[], result: StageAssetResults): LaneStatus["status"] {
  if (assetIds.length === 0 || !result.attempted) return "skipped";
  if (result.readyAssetIds.length === assetIds.length && result.failedAssetIds.length === 0) return "ready";
  if (result.readyAssetIds.length > 0) return "partial";
  return result.failedAssetIds.length > 0 ? "failed" : "skipped";
}

function derivativeStageResults(videoAssets: AssetItem[], readyAssetIds: string[]): StageAssetResults {
  const ready = new Set(readyAssetIds);
  return {
    attempted: videoAssets.length > 0,
    readyAssetIds,
    failedAssetIds: videoAssets.filter((asset) => !ready.has(asset.asset_id)).map((asset) => asset.asset_id),
  };
}

function stageFailedForAsset(laneId: string, assetId: string, analysis: NonNullable<BuildCoverageOptions["analysis"]>): boolean {
  const asset = analysis.assets.find((item) => item.asset_id === assetId);
  if (laneId === "segments") return !analysis.segments.some((segment) => segment.asset_id === assetId);
  if (laneId === "contact_sheets") return Boolean(asset && hasTemporalVideo(asset)) && (asset?.contact_sheet_ids.length ?? 0) === 0;
  if (laneId === "filmstrips") return Boolean(asset && hasTemporalVideo(asset)) && !analysis.segments.some((segment) => segment.asset_id === assetId && !!segment.filmstrip_path);
  if (laneId === "visual_quality") return !analysis.segments.some((segment) => segment.asset_id === assetId && !!segment.visual_quality_measurements);
  if (laneId === "vlm_tags") return analysis.vlm.failedAssetIds.includes(assetId);
  if (laneId === "vlm_peaks") return analysis.peaks.failedAssetIds.includes(assetId);
  if (laneId === "bgm_analysis") return analysis.bgm.failedAssetIds.includes(assetId);
  if (laneId === "stt") return Boolean(analysis.sttResults?.has(assetId) && !analysis.sttResults.get(assetId)?.success);
  if (laneId === "audio_events") return Boolean(analysis.audioEvents?.failures.has(assetId));
  return false;
}

export function writeAnalysisCoverageReport(projectDir: string, report: AnalysisCoverageReport): void {
  const outPath = path.join(projectDir, "03_analysis/analysis_coverage_report.json");
  atomicWriteJson(outPath, report);
}

export function readCoverageSummary(projectDir: string): {
  status: string;
  requiredLaneCount: number;
  readyLaneCount: number;
  blockedLaneCount: number;
  partialLaneCount: number;
  reportPath: string;
} | undefined {
  const reportPath = path.join(projectDir, "03_analysis/analysis_coverage_report.json");
  if (!fs.existsSync(reportPath)) return undefined;
  const report = JSON.parse(fs.readFileSync(reportPath, "utf-8")) as AnalysisCoverageReport;
  return {
    status: report.summary.status,
    requiredLaneCount: report.summary.required_lane_count,
    readyLaneCount: report.summary.ready_lane_count,
    blockedLaneCount: report.summary.blocked_lane_count,
    partialLaneCount: report.summary.partial_lane_count,
    reportPath,
  };
}

function inferSourceRoot(sourceFiles: string[], projectDir: string): string {
  if (sourceFiles.length === 0) return path.join(projectDir, "02_media/source");
  if (sourceFiles.length === 1) return path.dirname(sourceFiles[0]);
  return commonDir(sourceFiles.map((filePath) => path.dirname(filePath)));
}

function commonDir(dirs: string[]): string {
  const parts = dirs.map((dir) => path.resolve(dir).split(path.sep));
  const first = parts[0] ?? [];
  let end = first.length;
  for (const current of parts.slice(1)) {
    end = Math.min(end, current.length);
    for (let i = 0; i < end; i++) {
      if (first[i] !== current[i]) {
        end = i;
        break;
      }
    }
  }
  return first.slice(0, end).join(path.sep) || path.sep;
}

function ledgerItemToManifestItem(
  projectDir: string,
  item: SourceLedger["items"][number],
  assetMap: Map<string, AssetItem>,
): SourceMediaManifestItem {
  const asset = item.canonical_asset_id ? assetMap.get(item.canonical_asset_id) : undefined;
  const sourcePath = item.canonical_locator ?? item.requested_locator;
  return {
    asset_id: item.canonical_asset_id,
    source_id: item.source_id,
    source_locator: locatorForArtifact(projectDir, sourcePath),
    filename: path.basename(sourcePath),
    content_hash: item.content_hash,
    fingerprint: item.fingerprint,
    size_bytes: item.size_bytes,
    mtime: item.mtime,
    media_kind: item.media_kind,
    ingest_status: item.status,
    reason: item.reason,
    consumer_impact: item.consumer_impact,
    rights_status: "unknown",
    privacy_status: "unknown",
    analysis_policy_ref: "APOL_default",
    capture_started_at: null,
    capture_timezone: null,
    timecode_start: null,
    timecode_format: "none",
    sample_rate: asset?.audio_stream?.sample_rate ?? null,
    duration_us: asset?.duration_us ?? null,
    frame_rate_mode: asset?.frame_rate_mode ?? "unknown",
    rotation: asset?.rotation ?? null,
    audio_video_offset_ms: null,
    clock_source: "unknown",
  };
}

function locatorForArtifact(projectDir: string, sourcePath: string): string {
  if (sourcePath.startsWith("external://")) return sourcePath;
  if (!path.isAbsolute(sourcePath)) return path.normalize(sourcePath).split(path.sep).join("/");
  const absolute = path.resolve(sourcePath);
  const relative = path.relative(projectDir, absolute);
  return relative && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative)
    ? relative
    : sourcePath;
}

function uniqueIdentifiedItems(
  items: SourceMediaManifestItem[],
): Array<SourceMediaManifestItem & { asset_id: string }> {
  const byAssetId = new Map<string, SourceMediaManifestItem & { asset_id: string }>();
  for (const item of items) {
    if (item.asset_id && !byAssetId.has(item.asset_id)) byAssetId.set(item.asset_id, item as SourceMediaManifestItem & { asset_id: string });
  }
  return [...byAssetId.values()];
}
