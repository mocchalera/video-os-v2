/**
 * Pipeline orchestrator — coordinates stage modules for the ingest pipeline.
 *
 * Per milestone-2-design.md §Pipeline Orchestration (stages 1–12)
 *
 * Stage implementations live in ./stages/. This module wires them together,
 * handles caching, policy resolution, and progress tracking.
 */

import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { QualityThresholds } from "../connectors/ffmpeg-segmenter.js";
import { computePolicyHash, getFfmpegVersion, type AssetItem } from "../connectors/ffprobe.js";
import type { AssetSttResult } from "../connectors/openai-stt.js";
import type { VlmFn, VlmPolicy, SamplingPolicy } from "../connectors/gemini-vlm.js";
import type { DiarizeOptions, DiarizeTurn } from "../connectors/pyannote-diarizer.js";
import type { TranscribeFn, SttPolicy, TranscriptAlignmentThresholds } from "../connectors/stt-interface.js";
import type { PeakDetectionPolicy } from "../connectors/vlm-peak-detector.js";
import { DEFAULT_PEAK_POLICY } from "../connectors/vlm-peak-detector.js";
import type { MarlinFn, MarlinModelRecord } from "../connectors/marlin-types.js";
import { resolvePolicy } from "../policy-resolver.js";
import { generateDisplayNames, type DisplayNameInput } from "./display-name.js";
import { createMediaLinks, type MediaSourceMapDoc } from "../media/source-map.js";
import type { PipelineStageProgress, ProgressTracker } from "../progress.js";
import {
  type CacheManifestEntry,
  computeCacheHash,
  loadCacheManifest,
  saveCacheManifest,
  clearCacheManifest,
  lookupCache,
} from "./analysis-cache.js";
import { SourceContentIdentityCache } from "../source-content-identity.js";

// ── Stage imports ──────────────────────────────────────────────────
import { atomicWriteJson, atomicWriteYaml, readJsonIfExists } from "./stages/_util.js";
import { ingestMapWithFailures, ingestReduce, type IngestShard } from "./stages/ingest-map.js";
import { segmentMap, segmentReduce } from "./stages/segment.js";
import { derivativesMap, derivativesReduce } from "./stages/derivatives.js";
import { resolveTranscribeFn, sttMap, sttReduce } from "./stages/stt.js";
import { computeVlmCachePolicyHash, hydrateCachedVlmSegments, runParallelVlmAnalysis, vlmReduce, type VlmShard, type VlmAssetRunSummary, type VlmProgressReporter } from "./stages/vlm.js";
import { DEFAULT_APPRAISER_CONCURRENCY, runAppraiserStage, type AppraiserFn } from "./stages/appraiser.js";
import { runVisualQualityMeasurementStage, type VisualQualityAnalyzeFn } from "./stages/visual-quality.js";
import {
  degradedPeakMap,
  computePeakCachePolicyHash,
  inspectPeakPrecisionCache,
  peakClaimsVisualPrecision,
  peakMap,
  peakReduce,
  type PeakShard,
} from "./stages/peak.js";
import { buildGapReport, buildManifestEntries } from "./stages/gap-report.js";
import {
  appendMarlinGap,
  buildAnalysisReadiness,
  initialMarlinReadiness,
  runMarlinStage,
  type AnalysisReadiness,
} from "./ingest-marlin.js";
import { restoreSourceFileMap } from "./source-file-map.js";
import {
  buildManifestEntriesFromExistingAssets,
  groupSegmentsByAsset,
  loadExistingDerivativeResults,
  preserveVlmOnlySegmentFields,
} from "./analysis-artifact-restoration.js";
import { discoverRequestedSources, normalizeSourceLocators } from "../media/source-discovery.js";
import type { SourceDiscoveryResult } from "../media/source-discovery.js";
import { groupImageSequenceRequests, resolveImageSequencePolicy } from "../media/image-sequence.js";
import { ingestImageSequence } from "../connectors/image-sequence-ingest.js";
import {
  buildSourceLedger,
  type SourceLedger,
  type SourceIngestOutcome,
} from "../artifacts/source-ledger.js";
import type { AnalysisCoverageReport, SourceMediaManifest } from "../artifacts/p1-manifest-coverage.js";
import { readProjectState } from "../state/reconcile.js";
import { SourceReadinessError, persistSourceReadinessArtifacts } from "./source-readiness.js";
import { finalizeAudioAnalysisArtifacts, isExplicitAudioOnly } from "./audio-analysis-artifacts.js";
import { cleanupAnalysisSourceArtifacts } from "./analysis-artifact-cleanup.js";

// ── Re-exports for backward compatibility ──────────────────────────
export type { AssetsJson, SegmentsJson, GapEntry, GapReport } from "./pipeline-types.js";
export type { PeakShard } from "./stages/peak.js";
export type { AnalysisStageReadiness, AnalysisReadiness } from "./ingest-marlin.js";
export { resolveTranscribeFn } from "./stages/stt.js";
export { SourceReadinessError } from "./source-readiness.js";
import type { AssetsJson, SegmentsJson, GapReport, GapEntry } from "./pipeline-types.js";

// ── Types ──────────────────────────────────────────────────────────

export interface PipelineOptions {
  sourceFiles: string[];
  projectDir: string;
  projectId?: string;
  repoRoot?: string;
  transcribeFn?: TranscribeFn;
  vlmFn?: VlmFn;
  marlinFn?: MarlinFn;
  marlinModel?: MarlinModelRecord;
  marlinQueries?: string[];
  appraiserFn?: AppraiserFn;
  appraiserModel?: string;
  visualQualityAnalyzeFn?: VisualQualityAnalyzeFn;
  skipStt?: boolean;
  skipVlm?: boolean;
  skipAppraiser?: boolean;
  sttLanguageOverride?: string;
  sttProvider?: string;
  skipMarlin?: boolean;
  skipDiarize?: boolean;
  diarizeFn?: (audioPath: string, options?: DiarizeOptions) => Promise<DiarizeTurn[]>;
  skipPeak?: boolean;
  contentHint?: string;
  skipMediaLink?: boolean;
  skipBgmAnalysis?: boolean;
  /** Explicit editorial role assignment. Arbitrary audio sources are never auto-BGM. */
  bgmSourceFiles?: string[];
  vlmConcurrency?: number;
  vlmProgressReporter?: VlmProgressReporter;
  noCache?: boolean;
  clearCache?: boolean;
  progressTracker?: ProgressTracker;
  stageProgress?: PipelineStageProgress;
  vlmOnly?: boolean;
  sttStrategy?: SttStrategy;
  sourceDiscovery?: SourceDiscoveryResult;
  sourceIdentityCache?: SourceContentIdentityCache;
}

export interface PipelineResult {
  assetsJson: AssetsJson;
  segmentsJson: SegmentsJson;
  gapReport: GapReport;
  outputDir: string;
  mediaSourceMap?: MediaSourceMapDoc;
  mediaSourceMapPath?: string;
  vlmSummary?: VlmAssetRunSummary;
  sourceLedger?: SourceLedger;
  sourceMediaManifest?: SourceMediaManifest;
  analysisCoverageReport?: AnalysisCoverageReport;
  analysisReadiness: AnalysisReadiness;
}

const DEFAULT_PEAK_STAGE_TIMEOUT_MS = 5 * 60 * 1000;
const STT_AUTO_SILENCE_THRESHOLD = 0.85;
const STT_AUTO_SILENCE_NOISE_DB = "-50dB";
const STT_AUTO_SILENCE_DURATION_SEC = 0.2;

type SttStrategy = "full" | "skip" | "auto";

// ── Main Pipeline ──────────────────────────────────────────────────

export async function runPipeline(opts: PipelineOptions): Promise<PipelineResult> {
  const absProjectDir = path.resolve(opts.projectDir);
  const outputDir = path.join(absProjectDir, "03_analysis");
  fs.mkdirSync(outputDir, { recursive: true });

  const assetsPath = path.join(outputDir, "assets.json");
  const segmentsPath = path.join(outputDir, "segments.json");
  const gapReportPath = path.join(outputDir, "gap_report.yaml");
  const manifestPath = path.join(outputDir, "cache_manifest.json");

  // ── Cache Setup ──
  if (opts.clearCache) {
    clearCacheManifest(manifestPath);
    console.log("[cache] Cache cleared");
  }
  const useCache = !opts.noCache;
  const manifest: CacheManifestEntry[] = useCache ? loadCacheManifest(manifestPath) : [];
  const existingAssetsJson = readCanonicalJsonIfExists<AssetsJson>(assetsPath);
  const existingSegmentsJson = readCanonicalJsonIfExists<SegmentsJson>(segmentsPath);
  const sttStrategy: SttStrategy = opts.skipStt ? "skip" : opts.sttStrategy ?? "full";
  const effectiveSkipStt = sttStrategy === "skip" || !!opts.vlmOnly;

  if (opts.vlmOnly && (!existingAssetsJson || !existingSegmentsJson)) {
    const missing = [
      !existingAssetsJson ? assetsPath : undefined,
      !existingSegmentsJson ? segmentsPath : undefined,
    ].filter((value): value is string => !!value);
    throw new Error(`--vlm-only requires existing analysis artifacts; missing: ${missing.join(", ")}`);
  }

  // Resolve policy
  const { resolved: policy } = resolvePolicy(absProjectDir, opts.repoRoot);
  const policyHash = computePolicyHash(policy);
  const thresholds = (policy as Record<string, unknown>)["quality_thresholds"] as QualityThresholds;
  const ffmpegVersion = await getFfmpegVersion();
  const normalizedSourceLocators = normalizeSourceLocators(opts.sourceFiles, absProjectDir);
  const discovery = opts.vlmOnly
    ? opts.sourceDiscovery
    : opts.sourceDiscovery ?? discoverRequestedSources(normalizedSourceLocators);
  const imageSequenceGrouping = discovery
    ? groupImageSequenceRequests(discovery, resolveImageSequencePolicy(policy))
    : { groups: [], member_group_by_canonical_path: new Map() };
  const imageSequenceMemberPaths = new Set(imageSequenceGrouping.member_group_by_canonical_path.keys());
  const sourceFiles = discovery
    ? [...new Set(discovery.requests
      .filter((request) => request.disposition === "candidate")
      .flatMap((request) => request.canonical_path ? [request.canonical_path] : []))]
    : normalizedSourceLocators.filter((locator) => !locator.startsWith("external://"));
  const projectId = opts.projectId ?? readPipelineProjectId(absProjectDir);
  const pt = opts.progressTracker;
  const stageProgress = opts.stageProgress;
  const shouldRunMarlinStage = Boolean(opts.marlinFn) && !opts.skipMarlin && !opts.vlmOnly;
  let marlinReadiness = initialMarlinReadiness(opts);
  const sourceIdentityCache = opts.sourceIdentityCache ?? new SourceContentIdentityCache();
  for (const request of discovery?.requests ?? []) {
    if (!request.canonical_path || !request.content_hash || request.size_bytes === null || !request.mtime) continue;
    sourceIdentityCache.prime({
      absolutePath: request.canonical_path,
      sha256: request.content_hash.replace(/^sha256:/, ""),
      sizeBytes: request.size_bytes,
      mtimeMs: request.mtime_ms ?? new Date(request.mtime).getTime(),
    });
  }

  if (!opts.vlmOnly && normalizedSourceLocators.length === 0) {
    const emptyDiscovery = discoverRequestedSources([]);
    const sourceLedger = buildSourceLedger(projectId, emptyDiscovery, new Map(), undefined, absProjectDir);
    persistSourceReadinessArtifacts({
      projectDir: absProjectDir,
      projectId,
      ledger: sourceLedger,
      assets: [],
      assetsPath,
      segmentsPath,
      gapReportPath,
    });
    throw new SourceReadinessError("No requested source inputs were provided.", sourceLedger);
  }

  if (opts.vlmOnly) {
    return runVlmOnlyPipeline(
      opts,
      policy,
      policyHash,
      projectId,
      absProjectDir,
      outputDir,
      assetsPath,
      segmentsPath,
      gapReportPath,
      manifestPath,
      manifest,
      existingAssetsJson,
      existingSegmentsJson,
      sourceFiles,
      sourceIdentityCache,
      pt,
    );
  }

  // Progress tracking
  let totalStages = 6;
  if (!effectiveSkipStt) totalStages += 1;
  if (shouldRunMarlinStage) totalStages += 1;
  if (!opts.skipVlm) totalStages += 1;
  if (!opts.skipAppraiser) totalStages += 1;
  totalStages += 1;
  if (!opts.skipPeak) totalStages += 1;
  pt?.setTotal(totalStages);

  // ── Stage 1: Ingest ──
  const ingestProgress = stageProgress?.beginStage("ingest");
  if (!discovery) throw new Error("Source discovery is required outside --vlm-only mode.");
  let allIngestShards: IngestShard[];
  let sourceLedger: SourceLedger;
  let sourceMediaManifest: SourceMediaManifest;
  let analysisCoverageReport: AnalysisCoverageReport;
  try {
    console.log("[pipeline] Stage 1/12 ingest.map starting");
    const ingestPaths = [...new Set(discovery.requests
      .filter((request) =>
        request.disposition === "candidate" &&
        !request.canonical_request_source_id &&
        (!request.canonical_path || !imageSequenceMemberPaths.has(path.resolve(request.canonical_path)))
      )
      .flatMap((request) => request.canonical_path ? [request.canonical_path] : []))];
    const ingestSourceFacts = new Map(discovery.requests.flatMap((request) =>
      request.canonical_path && request.disposition === "candidate"
        ? [[request.canonical_path, {
          mediaKind: request.media_kind,
          ...(request.content_hash?.startsWith("sha256:")
            ? { contentSha256: request.content_hash.slice("sha256:".length) }
            : {}),
          ...(request.size_bytes !== null ? { sizeBytes: request.size_bytes } : {}),
          ...(request.mtime_ms !== null ? { mtimeMs: request.mtime_ms } : {}),
        }] as const]
        : []
    ));
    const ingestResult = await ingestMapWithFailures(ingestPaths, {
      projectRoot: absProjectDir,
      policyHash,
      ffmpegVersion,
      sourceFacts: ingestSourceFacts,
    });
    allIngestShards = ingestResult.shards;
    const sequenceOutcomes = new Map<string, SourceIngestOutcome>();
    for (const group of imageSequenceGrouping.groups) {
      if (group.status === "failed") {
        for (const frame of group.frames) {
          sequenceOutcomes.set(path.resolve(frame.canonical_path), {
            canonicalPath: path.resolve(frame.canonical_path),
            mediaKind: "sequence",
            error: group.reason ?? "image_sequence_group_failed",
          });
        }
        continue;
      }
      try {
        const sequence = await ingestImageSequence(group, {
          projectRoot: absProjectDir,
          policyHash,
          ffmpegVersion,
        });
        allIngestShards.push(sequence);
        for (const frame of group.frames) {
          sequenceOutcomes.set(path.resolve(frame.canonical_path), {
            canonicalPath: path.resolve(frame.canonical_path),
            asset: sequence.asset,
          });
        }
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        for (const frame of group.frames) {
          sequenceOutcomes.set(path.resolve(frame.canonical_path), {
            canonicalPath: path.resolve(frame.canonical_path),
            mediaKind: "sequence",
            error: reason,
          });
        }
      }
    }
    cleanupAnalysisSourceArtifacts({
      projectDir: absProjectDir,
      currentImageSequenceGroupIds: new Set(imageSequenceGrouping.groups
        .filter((group) => group.status === "candidate")
        .map((group) => group.group_id)),
      currentStillAssetIds: new Set(allIngestShards
        .filter((shard) => shard.asset.media_kind === "image")
        .map((shard) => shard.asset.asset_id)),
    });
    const outcomes = new Map<string, SourceIngestOutcome>();
    for (const shard of ingestResult.shards) outcomes.set(path.resolve(shard.sourceFile), { canonicalPath: path.resolve(shard.sourceFile), asset: shard.asset });
    for (const failure of ingestResult.failures) outcomes.set(path.resolve(failure.sourceFile), { canonicalPath: path.resolve(failure.sourceFile), error: failure.reason });
    for (const [sourcePath, outcome] of sequenceOutcomes) outcomes.set(sourcePath, outcome);
    sourceLedger = buildSourceLedger(projectId, discovery, outcomes, undefined, absProjectDir);
    const readinessArtifacts = persistSourceReadinessArtifacts({
      projectDir: absProjectDir,
      projectId,
      ledger: sourceLedger,
      assets: allIngestShards.map((shard) => shard.asset),
      assetsPath,
      segmentsPath,
      gapReportPath,
      writeEmptyAnalysis: false,
    });
    sourceMediaManifest = readinessArtifacts.manifest;
    analysisCoverageReport = readinessArtifacts.coverage;
    if (sourceLedger.summary.ready === 0) {
      persistSourceReadinessArtifacts({
        projectDir: absProjectDir,
        projectId,
        ledger: sourceLedger,
        assets: [],
        assetsPath,
        segmentsPath,
        gapReportPath,
      });
      throw new SourceReadinessError("No requested source was ready for analysis.", sourceLedger);
    }
    pt?.advance();
  } catch (error) {
    ingestProgress?.fail(error);
    throw error;
  }

  // ── Cache Check ──
  const { cacheHitIds, cacheHashMap, sourceContentHashMap, cachedAssetItems, cachedSegmentItems, newIngestShards } =
    checkCache(allIngestShards, useCache, manifest, existingAssetsJson, existingSegmentsJson, sourceIdentityCache);

  // ── All cached — short-circuit ──
  if (newIngestShards.length === 0 && cacheHitIds.size > 0) {
    ingestProgress?.complete();
    const allSourceFileMap = new Map<string, string>();
    for (const shard of allIngestShards) {
      allSourceFileMap.set(shard.asset.asset_id, shard.sourceFile);
    }
    const cachedResult = finalizeCached(allIngestShards, cachedAssetItems, cachedSegmentItems, cacheHashMap, sourceContentHashMap,
      projectId, assetsPath, segmentsPath, gapReportPath, manifestPath, outputDir,
      absProjectDir, sourceFiles, opts, pt, imageSequenceGrouping.groups);
    if (shouldRunMarlinStage) {
      const marlinProgress = stageProgress?.beginStage("marlin");
      const marlinResult = await runMarlinStage(
        opts, projectId, absProjectDir, visualSourceFiles(cachedResult.assetsJson, allSourceFileMap), segmentsPath,
        sourceIdentityCache, expectedSourceHashes(allIngestShards, sourceContentHashMap),
      );
      marlinReadiness = marlinResult.readiness;
      if (marlinResult.segmentsJson) {
        cachedResult.segmentsJson = marlinResult.segmentsJson;
      }
      if (marlinReadiness.status === "partial") {
        pt?.recordError("marlin", marlinReadiness.reason ?? "marlin_worker_failure", true);
      }
      marlinProgress?.complete();
    }
    let cachedVlmShards: VlmShard[] | undefined;
    if (!opts.skipVlm) {
      console.log("[pipeline] Stage 9-10/12 cached VLM compatibility check starting");
      const result = await runVlmStage(
        opts,
        policy,
        cachedResult.assetsJson,
        cachedResult.segmentsJson,
        existingSegmentsJson,
        allSourceFileMap,
        outputDir,
        policyHash,
        segmentsPath,
        assetsPath,
        sourceIdentityCache,
      );
      if (result) {
        cachedResult.assetsJson = result.assets;
        cachedResult.segmentsJson = result.segments;
        cachedResult.vlmSummary = result.vlmSummary;
        cachedVlmShards = result.vlmShards;
      }
    }
    const visualQualityProgress = stageProgress?.beginStage("visual-quality");
    try {
      if (!opts.skipAppraiser) {
        cachedResult.segmentsJson = await runAppraiserPipelineStage(
          opts,
          cachedResult.segmentsJson,
          allSourceFileMap,
          outputDir,
          segmentsPath,
          policyHash,
          visualAssetIds(cachedResult.assetsJson),
        );
      }
      cachedResult.segmentsJson = await runVisualQualityPipelineStage(
        cachedResult.segmentsJson,
        allSourceFileMap,
        segmentsPath,
        policyHash,
        cachedResult.assetsJson,
        opts.visualQualityAnalyzeFn,
        visualAssetIds(cachedResult.assetsJson),
      );
      visualQualityProgress?.complete();
    } catch (error) {
      visualQualityProgress?.fail(error);
      throw error;
    }
    const cachedPeakShards = await revalidateCachedPrecisionPeaks({
      opts,
      policy,
      assetsJson: cachedResult.assetsJson,
      segmentsJson: cachedResult.segmentsJson,
      sourceFileMap: allSourceFileMap,
      outputDir,
      segmentsPath,
      sourceIdentityCache,
    });
    cachedResult.gapReport = buildGapReport(
      [],
      new Map(),
      new Map(),
      new Map(),
      undefined,
      cachedVlmShards,
      cachedPeakShards,
      sourceLedger,
    );
    appendMarlinGap(cachedResult.gapReport, projectId, marlinReadiness);
    atomicWriteYaml(gapReportPath, cachedResult.gapReport);
    analysisCoverageReport = await finalizeAudioAnalysisArtifacts({
      projectDir: absProjectDir,
      projectId,
      manifest: sourceMediaManifest,
      ledger: sourceLedger,
      assetsJson: cachedResult.assetsJson,
      segmentsJson: cachedResult.segmentsJson,
      sourceFileMap: allSourceFileMap,
      thresholds,
      policyHash,
      ffmpegVersion,
      sttAttempted: false,
      sttSkipReason: effectiveSkipStt ? "stt skipped by request" : "stt not attempted on cached run",
      vlmShards: cachedVlmShards,
      peakShards: cachedPeakShards,
      bgmSourceFiles: opts.bgmSourceFiles,
      skipBgmAnalysis: opts.skipBgmAnalysis,
      skipVlm: opts.skipVlm,
      vlmProviderAvailable: Boolean(opts.vlmFn),
      skipPeak: opts.skipPeak,
    });
    cachedResult.sourceLedger = sourceLedger;
    cachedResult.sourceMediaManifest = sourceMediaManifest;
    cachedResult.analysisCoverageReport = analysisCoverageReport;
    cachedResult.analysisReadiness = buildAnalysisReadiness(marlinReadiness);
    return cachedResult;
  }

  // ── Stage 2: Reduce ──
  let sourceFileMap!: Map<string, string>;
  let assetsJson!: AssetsJson;
  let segmentsJson!: SegmentsJson;
  let segmentShards!: Awaited<ReturnType<typeof segmentMap>>["shards"];
  let derivativeResults!: Awaited<ReturnType<typeof derivativesMap>>;
  let segMapResult!: Awaited<ReturnType<typeof segmentMap>>;
  try {
    console.log("[pipeline] Stage 2/12 ingest.reduce writing assets");
    const { assetsJson: initialAssetsJson, sourceFileMap: reducedSourceFileMap } = ingestReduce(newIngestShards, projectId, assetsPath);
    sourceFileMap = reducedSourceFileMap;
    assetsJson = initialAssetsJson;
    pt?.advance("assets.json");

    // ── Stage 3–4: Segment ──
    console.log("[pipeline] Stage 3-4/12 segmentation starting");
    segMapResult = await segmentMap(sourceFileMap, assetsJson.items, thresholds, { policyHash, ffmpegVersion });
    segmentShards = segMapResult.shards;
    const segResult = segmentReduce(segmentShards, assetsJson, segmentsPath, assetsPath);
    assetsJson = segResult.assets;
    segmentsJson = segResult.segments;
    pt?.advance("segments.json");

    // ── Stage 5–6: Derivatives ──
    console.log("[pipeline] Stage 5-6/12 derivatives starting");
    derivativeResults = await derivativesMap(sourceFileMap, assetsJson.items, segmentShards, outputDir);
    const derivResult = derivativesReduce(derivativeResults, assetsJson, segmentsJson, assetsPath, segmentsPath);
    assetsJson = derivResult.assets;
    segmentsJson = derivResult.segments;
    pt?.advance();
    ingestProgress?.complete();
  } catch (error) {
    ingestProgress?.fail(error);
    throw error;
  }

  // ── Stage 7–8: STT ──
  let sttResults: Map<string, AssetSttResult> | undefined;
  let sttSkippedAssetIds = new Set<string>();
  const diarizeGapEntries: GapEntry[] = [];
  if (!effectiveSkipStt) {
    const sttProgress = stageProgress?.beginStage("stt");
    try {
      console.log("[pipeline] Stage 7-8/12 STT starting");
      const result = await runSttStage(opts, policy, sourceFileMap, assetsJson, segmentsJson,
        projectId, outputDir, policyHash, assetsPath, segmentsPath, diarizeGapEntries);
      if (result) {
        assetsJson = result.assets;
        segmentsJson = result.segments;
        sttResults = result.sttResults;
        sttSkippedAssetIds = result.skippedAssetIds;
      }
      pt?.advance();
      sttProgress?.complete();
    } catch (error) {
      sttProgress?.fail(error);
      throw error;
    }
  }

  // Complete the current requested/ready source set before Marlin. New-source
  // STT results stay in place while cached assets/segments are added exactly
  // once, so Marlin and every downstream stage observe the same canonical set.
  if (cacheHitIds.size > 0) {
    assetsJson.items.push(...cachedAssetItems);
    assetsJson.items.sort((a, b) => a.asset_id.localeCompare(b.asset_id));
    segmentsJson.items.push(...cachedSegmentItems);
    segmentsJson.items.sort((a, b) => a.asset_id !== b.asset_id ? a.asset_id.localeCompare(b.asset_id) : a.src_in_us - b.src_in_us);
    for (const shard of allIngestShards) {
      if (cacheHitIds.has(shard.asset.asset_id)) sourceFileMap.set(shard.asset.asset_id, shard.sourceFile);
    }
    atomicWriteJson(assetsPath, assetsJson);
    atomicWriteJson(segmentsPath, segmentsJson);
  }

  // ── Stage 8.5: Marlin reporter ──
  if (shouldRunMarlinStage) {
    const marlinProgress = stageProgress?.beginStage("marlin");
    const marlinResult = await runMarlinStage(
      opts, projectId, absProjectDir, visualSourceFiles(assetsJson, sourceFileMap), segmentsPath,
      sourceIdentityCache, expectedSourceHashes(allIngestShards, sourceContentHashMap),
    );
    marlinReadiness = marlinResult.readiness;
    if (marlinResult.segmentsJson) {
      segmentsJson = marlinResult.segmentsJson;
    }
    if (marlinReadiness.status === "partial") {
      pt?.advance();
      pt?.recordError("marlin", marlinReadiness.reason ?? "marlin_worker_failure", true);
    } else {
      pt?.advance("marlin_events.json");
    }
    marlinProgress?.complete();
  }

  let vlmShards: VlmShard[] | undefined;
  let vlmSummary: VlmAssetRunSummary | undefined;
  const visualQualityProgress = stageProgress?.beginStage("visual-quality");
  try {
    // ── Stage 9–10: VLM ──
    if (!opts.skipVlm) {
      console.log("[pipeline] Stage 9-10/12 VLM starting");
      const result = await runVlmStage(opts, policy, assetsJson, segmentsJson, existingSegmentsJson,
        sourceFileMap, outputDir, policyHash, segmentsPath, assetsPath, sourceIdentityCache);
      if (result) { assetsJson = result.assets; segmentsJson = result.segments; vlmShards = result.vlmShards; vlmSummary = result.vlmSummary; }
      pt?.advance();
    }

    // ── Stage 10.5: Gemini Appraiser ──
    if (!opts.skipAppraiser) {
      segmentsJson = await runAppraiserPipelineStage(
        opts,
        segmentsJson,
        sourceFileMap,
        outputDir,
        segmentsPath,
        policyHash,
        visualAssetIds(assetsJson),
      );
      pt?.advance("segments.json");
    }

    segmentsJson = await runVisualQualityPipelineStage(
      segmentsJson,
      sourceFileMap,
      segmentsPath,
      policyHash,
      assetsJson,
      opts.visualQualityAnalyzeFn,
      visualAssetIds(assetsJson),
    );
    pt?.advance("segments.json");
    visualQualityProgress?.complete();
  } catch (error) {
    visualQualityProgress?.fail(error);
    throw error;
  }

  // ── Stage 11–12: Peak Detection ──
  let peakShards: PeakShard[] | undefined;
  if (!opts.skipPeak && !opts.skipVlm && opts.vlmFn) {
    const peakProgress = stageProgress?.beginStage("peak");
    try {
      const peakPolicy = (policy as Record<string, unknown>)["peak_detection"] as PeakDetectionPolicy | undefined;
      console.log("[pipeline] Stage 11-12/12 VLM peak detection starting");
      const timeoutMs = readPeakTimeoutMs();
      try {
        peakShards = await withTimeout(
          peakMap(assetsJson, segmentsJson, derivativeResults, sourceFileMap, opts.vlmFn, peakPolicy ?? DEFAULT_PEAK_POLICY, outputDir, opts.contentHint, { policyHash: computePeakCachePolicyHash(peakPolicy ?? DEFAULT_PEAK_POLICY), sourceIdentityCache }),
          timeoutMs,
          `peak detection timed out after ${timeoutMs}ms`,
        );
      } catch (err) {
        console.warn(`[pipeline] Peak detection degraded: ${err instanceof Error ? err.message : String(err)}`);
        peakShards = await degradedPeakMap(assetsJson, segmentsJson, sourceFileMap);
      }
      if (peakShards.length > 0) {
        segmentsJson = peakReduce(peakShards, segmentsJson, segmentsPath);
        console.log(`[pipeline] Peak detection: ${peakShards.filter((s) => s.peak_analysis).length}/${peakShards.length} segments enriched`);
      }
      pt?.advance();
      peakProgress?.complete();
    } catch (error) {
      peakProgress?.fail(error);
      throw error;
    }
  } else if (!opts.skipPeak) {
    const peakProgress = stageProgress?.beginStage("peak");
    try {
      console.log("[pipeline] Stage 11-12/12 degraded peak detection starting");
      peakShards = await degradedPeakMap(assetsJson, segmentsJson, sourceFileMap);
      if (peakShards.length > 0) {
        segmentsJson = peakReduce(peakShards, segmentsJson, segmentsPath);
        console.log(`[pipeline] Peak detection: ${peakShards.filter((s) => s.peak_analysis).length}/${peakShards.length} degraded segments enriched`);
      }
      pt?.advance();
      peakProgress?.complete();
    } catch (error) {
      peakProgress?.fail(error);
      throw error;
    }
  }

  // ── Revalidate cached peak data ──
  if (cacheHitIds.size > 0) {
    const cachedPeakShards = await revalidateCachedPrecisionPeaks({
      opts,
      policy,
      assetsJson,
      segmentsJson,
      sourceFileMap,
      outputDir,
      segmentsPath,
      sourceIdentityCache,
    });
    if (cachedPeakShards.length > 0) {
      peakShards = [...(peakShards ?? []), ...cachedPeakShards];
    }
  }

  // ── Display names ──
  console.log("[pipeline] Stage display-name starting");
  const displayNameInputs: DisplayNameInput[] = assetsJson.items
    .filter((asset) => sourceFileMap.has(asset.asset_id))
    .map((asset) => ({ asset, filePath: sourceFileMap.get(asset.asset_id)!, segments: segmentsJson.items.filter((s) => s.asset_id === asset.asset_id) }));
  const displayNames = generateDisplayNames(displayNameInputs);
  for (const asset of assetsJson.items) { const dn = displayNames.get(asset.asset_id); if (dn) asset.display_name = dn; }
  atomicWriteJson(assetsPath, assetsJson);
  pt?.advance();

  // ── Gap report ──
  console.log("[pipeline] Stage gap-report starting");
  const newAssetItems = assetsJson.items.filter((a) => !cacheHitIds.has(a.asset_id));
  const gapReport = buildGapReport(newAssetItems, segmentShards, derivativeResults, segMapResult.detectorFailures, sttResults, vlmShards, peakShards, sourceLedger);
  if (sttSkippedAssetIds.size > 0) {
    gapReport.entries = gapReport.entries.filter((entry) =>
      !(entry.stage === "stt" && entry.issue === "stt_not_attempted" && sttSkippedAssetIds.has(entry.asset_id))
    );
  }
  gapReport.entries.push(...diarizeGapEntries);
  appendMarlinGap(gapReport, projectId, marlinReadiness);
  atomicWriteYaml(gapReportPath, gapReport);

  // ── Media links + BGM ──
  console.log("[pipeline] Stage media-links/BGM starting");
  let mediaSourceMap: MediaSourceMapDoc | undefined;
  let mediaSourceMapPath: string | undefined;
  if (!opts.skipMediaLink) {
    const mediaLinks = createMediaLinks({
      projectPath: absProjectDir,
      projectId,
      assets: assetsJson.items,
      sourceFileMap,
      imageSequenceGroupsByAssetId: matchImageSequenceGroups(assetsJson.items, imageSequenceGrouping.groups),
    });
    mediaSourceMap = mediaLinks.doc; mediaSourceMapPath = mediaLinks.sourceMapPath;
    for (const warning of mediaLinks.warnings) console.warn(`[pipeline] ${warning}`);
  }

  analysisCoverageReport = await finalizeAudioAnalysisArtifacts({
    projectDir: absProjectDir,
    projectId,
    manifest: sourceMediaManifest,
    ledger: sourceLedger,
    assetsJson,
    segmentsJson,
    sourceFileMap,
    thresholds,
    policyHash,
    ffmpegVersion,
    sttAttempted: !effectiveSkipStt,
    sttSkipReason: effectiveSkipStt ? "stt skipped by request" : undefined,
    sttResults,
    sttSkippedAssetIds,
    vlmShards,
    peakShards,
    bgmSourceFiles: opts.bgmSourceFiles,
    skipBgmAnalysis: opts.skipBgmAnalysis,
    skipVlm: opts.skipVlm,
    vlmProviderAvailable: Boolean(opts.vlmFn),
    skipPeak: opts.skipPeak,
  });

  saveCacheManifest(manifestPath, buildManifestEntries(allIngestShards, cacheHashMap, sourceContentHashMap));
  pt?.complete(["assets.json", "segments.json", "gap_report.yaml"]);

  return {
    assetsJson,
    segmentsJson,
    gapReport,
    outputDir,
    mediaSourceMap,
    mediaSourceMapPath,
    vlmSummary,
    sourceLedger,
    sourceMediaManifest,
    analysisCoverageReport,
    analysisReadiness: buildAnalysisReadiness(marlinReadiness),
  };
}

function readPipelineProjectId(projectDir: string): string {
  try {
    return readProjectState(projectDir)?.project_id || path.basename(projectDir);
  } catch {
    return path.basename(projectDir);
  }
}

function visualAssetIds(assetsJson: AssetsJson): Set<string> {
  return new Set(assetsJson.items.filter((asset) => !isExplicitAudioOnly(asset)).map((asset) => asset.asset_id));
}

function visualSourceFiles(assetsJson: AssetsJson, sourceFileMap: Map<string, string>): string[] {
  return assetsJson.items.flatMap((asset) => {
    if (!asset.video_stream || asset.media_kind === "image") return [];
    const sourcePath = sourceFileMap.get(asset.asset_id);
    return sourcePath ? [sourcePath] : [];
  });
}

function readPeakTimeoutMs(): number {
  const raw = Number.parseInt(process.env.VOS_PEAK_TIMEOUT_MS ?? "", 10);
  if (Number.isInteger(raw) && raw > 0) return raw;
  return DEFAULT_PEAK_STAGE_TIMEOUT_MS;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

async function runVlmOnlyPipeline(
  opts: PipelineOptions,
  policy: Record<string, unknown>,
  policyHash: string,
  projectId: string,
  absProjectDir: string,
  outputDir: string,
  assetsPath: string,
  segmentsPath: string,
  gapReportPath: string,
  manifestPath: string,
  manifest: CacheManifestEntry[],
  existingAssetsJson: AssetsJson | undefined,
  existingSegmentsJson: SegmentsJson | undefined,
  sourceFiles: string[],
  sourceIdentityCache: SourceContentIdentityCache,
  pt: ProgressTracker | undefined,
): Promise<PipelineResult> {
  const missing = [
    !existingAssetsJson ? assetsPath : undefined,
    !existingSegmentsJson ? segmentsPath : undefined,
  ].filter((value): value is string => !!value);
  if (missing.length > 0) {
    throw new Error(`--vlm-only requires existing analysis artifacts; missing: ${missing.join(", ")}`);
  }

  console.log("[pipeline] --vlm-only: skipping Stage 1-8 and loading existing assets/segments");
  pt?.setTotal((opts.skipVlm ? 0 : 1) + (opts.skipAppraiser ? 0 : 1) + (opts.skipPeak ? 0 : 1) + 2);

  let assetsJson = existingAssetsJson!;
  let segmentsJson = existingSegmentsJson!;
  const sourceFileMap = restoreSourceFileMap(absProjectDir, assetsJson, sourceFiles);
  const derivativeResults = loadExistingDerivativeResults(assetsJson, segmentsJson, outputDir);

  let vlmShards: VlmShard[] | undefined;
  let vlmSummary: VlmAssetRunSummary | undefined;
  if (!opts.skipVlm) {
    console.log("[pipeline] Stage 9-10/12 VLM starting (--vlm-only, cache ignored)");
    const beforeVlm = cloneJson(segmentsJson);
    const result = await runVlmStage(opts, policy, assetsJson, segmentsJson, undefined,
      sourceFileMap, outputDir, policyHash, segmentsPath, assetsPath, sourceIdentityCache);
    if (result) {
      assetsJson = result.assets;
      segmentsJson = preserveVlmOnlySegmentFields(result.segments, beforeVlm);
      vlmShards = result.vlmShards;
      vlmSummary = result.vlmSummary;
      atomicWriteJson(assetsPath, assetsJson);
      atomicWriteJson(segmentsPath, segmentsJson);
    }
    pt?.advance("segments.json");
  }

  if (!opts.skipAppraiser) {
    segmentsJson = await runAppraiserPipelineStage(
      opts,
      segmentsJson,
      sourceFileMap,
      outputDir,
      segmentsPath,
      policyHash,
      visualAssetIds(assetsJson),
    );
    pt?.advance("segments.json");
  }

  segmentsJson = await runVisualQualityPipelineStage(
    segmentsJson,
    sourceFileMap,
    segmentsPath,
    policyHash,
    assetsJson,
    opts.visualQualityAnalyzeFn,
    visualAssetIds(assetsJson),
  );
  pt?.advance("segments.json");

  let peakShards: PeakShard[] | undefined;
  if (!opts.skipPeak && !opts.skipVlm && opts.vlmFn) {
    const peakPolicy = (policy as Record<string, unknown>)["peak_detection"] as PeakDetectionPolicy | undefined;
    console.log("[pipeline] Stage 11-12/12 VLM peak detection starting (--vlm-only)");
    const timeoutMs = readPeakTimeoutMs();
    try {
      peakShards = await withTimeout(
        peakMap(assetsJson, segmentsJson, derivativeResults, sourceFileMap, opts.vlmFn, peakPolicy ?? DEFAULT_PEAK_POLICY, outputDir, opts.contentHint, { policyHash: computePeakCachePolicyHash(peakPolicy ?? DEFAULT_PEAK_POLICY), sourceIdentityCache }),
        timeoutMs,
        `peak detection timed out after ${timeoutMs}ms`,
      );
    } catch (err) {
      console.warn(`[pipeline] Peak detection degraded: ${err instanceof Error ? err.message : String(err)}`);
      peakShards = await degradedPeakMap(assetsJson, segmentsJson, sourceFileMap);
    }
    if (peakShards.length > 0) {
      segmentsJson = peakReduce(peakShards, segmentsJson, segmentsPath);
      console.log(`[pipeline] Peak detection: ${peakShards.filter((s) => s.peak_analysis).length}/${peakShards.length} segments enriched`);
    }
    pt?.advance("segments.json");
  } else if (!opts.skipPeak) {
    console.log("[pipeline] Stage 11-12/12 degraded peak detection starting (--vlm-only)");
    peakShards = await degradedPeakMap(assetsJson, segmentsJson, sourceFileMap);
    if (peakShards.length > 0) {
      segmentsJson = peakReduce(peakShards, segmentsJson, segmentsPath);
      console.log(`[pipeline] Peak detection: ${peakShards.filter((s) => s.peak_analysis).length}/${peakShards.length} degraded segments enriched`);
    }
    pt?.advance("segments.json");
  }

  console.log("[pipeline] Stage gap-report/cache starting (--vlm-only)");
  const gapReport = buildGapReport(
    assetsJson.items,
    groupSegmentsByAsset(segmentsJson.items),
    derivativeResults,
    new Map(),
    undefined,
    vlmShards,
    peakShards,
  );
  atomicWriteYaml(gapReportPath, gapReport);
  saveCacheManifest(manifestPath, buildManifestEntriesFromExistingAssets(assetsJson.items, sourceFileMap, manifest, sourceIdentityCache));
  pt?.complete(["segments.json", "gap_report.yaml", "cache_manifest.json"]);

  return {
    assetsJson,
    segmentsJson,
    gapReport,
    outputDir,
    vlmSummary,
    analysisReadiness: buildAnalysisReadiness(initialMarlinReadiness(opts)),
  };
}

// ── Private Helpers ────────────────────────────────────────────────

function readCanonicalJsonIfExists<T>(filePath: string): T | undefined {
  try {
    return readJsonIfExists<T>(filePath);
  } catch (error) {
    throw new Error(
      `canonical_artifact_corrupt:${filePath}:${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function revalidateCachedPrecisionPeaks(options: {
  opts: PipelineOptions;
  policy: Record<string, unknown>;
  assetsJson: AssetsJson;
  segmentsJson: SegmentsJson;
  sourceFileMap: Map<string, string>;
  outputDir: string;
  segmentsPath: string;
  sourceIdentityCache: SourceContentIdentityCache;
}): Promise<PeakShard[]> {
  const peakPolicy = (options.policy as Record<string, unknown>)["peak_detection"] as PeakDetectionPolicy | undefined
    ?? DEFAULT_PEAK_POLICY;
  const peakPolicyHash = computePeakCachePolicyHash(peakPolicy);
  const invalid = options.segmentsJson.items.flatMap((segment) => {
    if (!peakClaimsVisualPrecision(segment)) return [];
    const sourcePath = options.sourceFileMap.get(segment.asset_id);
    let sourceContentSha256: string | undefined;
    try {
      sourceContentSha256 = sourcePath
        ? options.sourceIdentityCache.resolve(sourcePath).sha256
        : undefined;
    } catch {
      sourceContentSha256 = undefined;
    }
    const inspection = inspectPeakPrecisionCache(segment, {
      sourcePath,
      sourceContentSha256,
      outputDir: options.outputDir,
      policyHash: peakPolicyHash,
      policy: peakPolicy,
      sourceIdentityCache: options.sourceIdentityCache,
    });
    return inspection.accepted ? [] : [{ segment, reasons: inspection.reasons }];
  });
  if (invalid.length === 0) return [];

  const fallbackGaps = new Map<string, PeakShard>();
  for (const { segment, reasons } of invalid) {
    delete segment.peak_analysis;
    fallbackGaps.set(segment.segment_id, {
      segment_id: segment.segment_id,
      error: `ungrounded_precision_cache_invalidated:${reasons.join(",")}`,
    });
  }
  atomicWriteJson(options.segmentsPath, options.segmentsJson);

  if (options.opts.skipPeak || options.opts.skipVlm || !options.opts.vlmFn) {
    return [...fallbackGaps.values()];
  }

  const invalidAssetIds = new Set(invalid.map(({ segment }) => segment.asset_id));
  const invalidSegmentIds = new Set(invalid.map(({ segment }) => segment.segment_id));
  const assetsJson: AssetsJson = {
    ...options.assetsJson,
    items: options.assetsJson.items.filter((asset) => invalidAssetIds.has(asset.asset_id)),
  };
  const segmentsJson: SegmentsJson = {
    ...options.segmentsJson,
    items: options.segmentsJson.items.filter((segment) => invalidSegmentIds.has(segment.segment_id)),
  };
  const derivatives = loadExistingDerivativeResults(assetsJson, segmentsJson, options.outputDir);
  let refreshed: PeakShard[];
  try {
    refreshed = await peakMap(
      assetsJson,
      segmentsJson,
      derivatives,
      options.sourceFileMap,
      options.opts.vlmFn,
      peakPolicy,
      options.outputDir,
      options.opts.contentHint,
      { policyHash: peakPolicyHash, sourceIdentityCache: options.sourceIdentityCache },
    );
  } catch (error) {
    console.warn(`[pipeline] Cached precision peak reanalysis degraded: ${error instanceof Error ? error.message : String(error)}`);
    return [...fallbackGaps.values()];
  }

  for (const shard of refreshed) {
    const target = options.segmentsJson.items.find((segment) => segment.segment_id === shard.segment_id);
    if (target && shard.peak_analysis) target.peak_analysis = shard.peak_analysis;
    fallbackGaps.set(shard.segment_id, shard);
  }
  atomicWriteJson(options.segmentsPath, options.segmentsJson);
  return [...fallbackGaps.values()];
}

function checkCache(
  allIngestShards: IngestShard[],
  useCache: boolean,
  manifest: CacheManifestEntry[],
  existingAssetsJson: AssetsJson | undefined,
  existingSegmentsJson: SegmentsJson | undefined,
  sourceIdentityCache: SourceContentIdentityCache,
) {
  const cacheHitIds = new Set<string>();
  const cacheHashMap = new Map<string, string>();
  const sourceContentHashMap = new Map<string, string>();

  for (const shard of allIngestShards) {
    const absPath = path.resolve(shard.sourceFile);
    const identity = sourceIdentityCache.resolve(absPath);
    const hash = computeCacheHash(absPath, identity.sizeBytes, shard.asset.duration_us, identity.sha256);
    cacheHashMap.set(shard.asset.asset_id, hash);
    sourceContentHashMap.set(shard.asset.asset_id, identity.sha256);

    if (useCache && manifest.length > 0) {
      const entry = lookupCache(manifest, hash);
      if (entry && entry.asset_id === shard.asset.asset_id && existingAssetsJson) {
        const priorAsset = existingAssetsJson.items.find((a) => a.asset_id === shard.asset.asset_id);
        if (priorAsset) { cacheHitIds.add(shard.asset.asset_id); console.log(`[cache hit] ${shard.asset.asset_id}`); }
      }
    }
  }

  const cachedAssetItems = existingAssetsJson?.items.filter((a) => cacheHitIds.has(a.asset_id)) ?? [];
  const cachedSegmentItems = existingSegmentsJson?.items.filter((s) => cacheHitIds.has(s.asset_id)) ?? [];
  const newIngestShards = allIngestShards.filter((s) => !cacheHitIds.has(s.asset.asset_id));
  if (cacheHitIds.size > 0) console.log(`[cache] ${cacheHitIds.size} cached, ${newIngestShards.length} new`);

  return { cacheHitIds, cacheHashMap, sourceContentHashMap, cachedAssetItems, cachedSegmentItems, newIngestShards };
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function finalizeCached(
  allIngestShards: IngestShard[],
  cachedAssetItems: import("../connectors/ffprobe.js").AssetItem[],
  cachedSegmentItems: import("../connectors/ffmpeg-segmenter.js").SegmentItem[],
  cacheHashMap: Map<string, string>,
  sourceContentHashMap: Map<string, string>,
  projectId: string, assetsPath: string, segmentsPath: string,
  gapReportPath: string, manifestPath: string, outputDir: string,
  absProjectDir: string, sourceFiles: string[],
  opts: PipelineOptions, pt: ProgressTracker | undefined,
  imageSequenceGroups: ReturnType<typeof groupImageSequenceRequests>["groups"],
): PipelineResult {
  const assetsJson: AssetsJson = { project_id: projectId, artifact_version: "2.0.0",
    items: [...cachedAssetItems].sort((a, b) => a.asset_id.localeCompare(b.asset_id)) };
  const segmentsJson: SegmentsJson = { project_id: projectId, artifact_version: "2.0.0",
    items: [...cachedSegmentItems].sort((a, b) => a.asset_id !== b.asset_id ? a.asset_id.localeCompare(b.asset_id) : a.src_in_us - b.src_in_us) };
  atomicWriteJson(assetsPath, assetsJson);
  atomicWriteJson(segmentsPath, segmentsJson);
  atomicWriteYaml(gapReportPath, { version: "1", entries: [] } satisfies GapReport);

  const allSourceFileMap = new Map<string, string>();
  for (const shard of allIngestShards) allSourceFileMap.set(shard.asset.asset_id, shard.sourceFile);

  let mediaSourceMap: MediaSourceMapDoc | undefined;
  let mediaSourceMapPath: string | undefined;
  if (!opts.skipMediaLink) {
    const mediaLinks = createMediaLinks({
      projectPath: absProjectDir,
      projectId,
      assets: assetsJson.items,
      sourceFileMap: allSourceFileMap,
      imageSequenceGroupsByAssetId: matchImageSequenceGroups(assetsJson.items, imageSequenceGroups),
    });
    mediaSourceMap = mediaLinks.doc; mediaSourceMapPath = mediaLinks.sourceMapPath;
  }

  saveCacheManifest(manifestPath, buildManifestEntries(allIngestShards, cacheHashMap, sourceContentHashMap));
  pt?.complete(["assets.json", "segments.json"]);
  return {
    assetsJson,
    segmentsJson,
    gapReport: { version: "1", entries: [] },
    outputDir,
    mediaSourceMap,
    mediaSourceMapPath,
    analysisReadiness: buildAnalysisReadiness(initialMarlinReadiness(opts)),
  };
}

function matchImageSequenceGroups(
  assets: AssetItem[],
  groups: ReturnType<typeof groupImageSequenceRequests>["groups"],
): Map<string, ReturnType<typeof groupImageSequenceRequests>["groups"][number]> {
  const byFrameSet = new Map(groups.map((group) => [group.frame_set_content_sha256, group]));
  return new Map(assets.flatMap((asset) => {
    const frameSet = asset.image_sequence?.frame_set_content_sha256;
    const group = frameSet ? byFrameSet.get(frameSet) : undefined;
    return group ? [[asset.asset_id, group] as const] : [];
  }));
}

async function runSttStage(
  opts: PipelineOptions, policy: Record<string, unknown>,
  sourceFileMap: Map<string, string>, assetsJson: AssetsJson, segmentsJson: SegmentsJson,
  projectId: string, outputDir: string, policyHash: string,
  assetsPath: string, segmentsPath: string, diarizeGapEntries: GapEntry[],
): Promise<{ assets: AssetsJson; segments: SegmentsJson; sttResults: Map<string, AssetSttResult>; skippedAssetIds: Set<string> } | null> {
  const sttPolicy = (policy as Record<string, unknown>)["stt"] as SttPolicy | undefined;
  const qualThresholds = (policy as Record<string, unknown>)["quality_thresholds"] as Record<string, unknown> | undefined;
  if (!sttPolicy) return null;

  const effectiveSttPolicy: SttPolicy = opts.sttLanguageOverride ? { ...sttPolicy, language: opts.sttLanguageOverride } : sttPolicy;
  const alignmentThresholds: TranscriptAlignmentThresholds = {
    transcript_overlap_min_us: (qualThresholds?.transcript_overlap_min_us as number) ?? 250_000,
    transcript_overlap_fraction_min: (qualThresholds?.transcript_overlap_fraction_min as number) ?? 0.25,
  };

  let sttSourceFileMap = sourceFileMap;
  let sttAssets = assetsJson.items;
  let skippedAssetIds = new Set<string>();
  if (opts.sttStrategy === "auto") {
    const auto = await applyAutoSttStrategy(sourceFileMap, assetsJson.items);
    sttSourceFileMap = auto.sourceFileMap;
    sttAssets = auto.assets;
    skippedAssetIds = auto.skippedAssetIds;
  }

  const hasCandidates = sttAssets.some((asset) =>
    !!asset.audio_stream && sttSourceFileMap.has(asset.asset_id)
  );
  if (!hasCandidates) {
    if (opts.sttStrategy === "auto") {
      console.log("[stt] No assets selected for STT after auto silence check");
    }
    return { assets: assetsJson, segments: segmentsJson, sttResults: new Map(), skippedAssetIds };
  }

  let transcribeFn: TranscribeFn; let providerName: string;
  if (opts.transcribeFn) { transcribeFn = opts.transcribeFn; providerName = opts.sttProvider ?? "injected"; }
  else {
    const resolved = resolveTranscribeFn(effectiveSttPolicy, opts.sttProvider);
    transcribeFn = resolved.transcribeFn; providerName = resolved.providerName;
    console.log(`[pipeline] STT provider: ${providerName} (model: ${effectiveSttPolicy.model_alias})`);
  }

  const sttResults = await sttMap(sttSourceFileMap, sttAssets, projectId, outputDir,
    effectiveSttPolicy, alignmentThresholds, policyHash, transcribeFn,
    { skipDiarize: opts.skipDiarize ?? false, providerName, diarizeFn: opts.diarizeFn, gapEntries: diarizeGapEntries });
  const result = sttReduce(sttResults, assetsJson, segmentsJson, alignmentThresholds, assetsPath, segmentsPath, outputDir);
  return { assets: result.assets, segments: result.segments, sttResults, skippedAssetIds };
}

async function applyAutoSttStrategy(
  sourceFileMap: Map<string, string>,
  assets: AssetItem[],
): Promise<{ sourceFileMap: Map<string, string>; assets: AssetItem[]; skippedAssetIds: Set<string> }> {
  const nextSourceFileMap = new Map(sourceFileMap);
  const skippedAssetIds = new Set<string>();

  for (const asset of assets) {
    if (!asset.audio_stream) continue;
    const sourceFile = sourceFileMap.get(asset.asset_id);
    if (!sourceFile) continue;

    try {
      const silenceRatio = await measureAudioSilenceRatio(sourceFile, asset.duration_us);
      if (silenceRatio > STT_AUTO_SILENCE_THRESHOLD) {
        skippedAssetIds.add(asset.asset_id);
        nextSourceFileMap.delete(asset.asset_id);
        console.log(
          `[stt] Skipping ${asset.asset_id} (silence ratio ${silenceRatio.toFixed(2)}, threshold ${STT_AUTO_SILENCE_THRESHOLD.toFixed(2)})`,
        );
      }
    } catch (err) {
      console.warn(`[stt] Auto silence check failed for ${asset.asset_id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return {
    sourceFileMap: nextSourceFileMap,
    assets: assets.filter((asset) => !skippedAssetIds.has(asset.asset_id)),
    skippedAssetIds,
  };
}

async function measureAudioSilenceRatio(
  sourceFile: string,
  durationUs: number,
): Promise<number> {
  const durationSec = Math.max(0, durationUs / 1_000_000);
  if (durationSec === 0) return 0;

  const { stderr } = await execFilePromise("ffmpeg", [
    "-hide_banner",
    "-nostats",
    "-v", "info",
    "-i", sourceFile,
    "-vn",
    "-af", `silencedetect=noise=${STT_AUTO_SILENCE_NOISE_DB}:d=${STT_AUTO_SILENCE_DURATION_SEC}`,
    "-f", "null",
    "-",
  ]);

  return parseSilenceRatio(stderr, durationSec);
}

function parseSilenceRatio(stderr: string, durationSec: number): number {
  let silenceStart: number | undefined;
  let silenceDurationSec = 0;

  for (const line of stderr.split(/\r?\n/)) {
    const startMatch = line.match(/silence_start:\s*([0-9.]+)/);
    if (startMatch) {
      silenceStart = Number.parseFloat(startMatch[1]);
      continue;
    }

    const endMatch = line.match(/silence_end:\s*([0-9.]+)\s*\|\s*silence_duration:\s*([0-9.]+)/);
    if (endMatch) {
      const parsedDuration = Number.parseFloat(endMatch[2]);
      if (Number.isFinite(parsedDuration)) {
        silenceDurationSec += parsedDuration;
      } else if (silenceStart != null) {
        const silenceEnd = Number.parseFloat(endMatch[1]);
        if (Number.isFinite(silenceEnd)) silenceDurationSec += Math.max(0, silenceEnd - silenceStart);
      }
      silenceStart = undefined;
    }
  }

  if (silenceStart != null && Number.isFinite(silenceStart)) {
    silenceDurationSec += Math.max(0, durationSec - silenceStart);
  }

  return Math.max(0, Math.min(1, silenceDurationSec / durationSec));
}

function execFilePromise(
  cmd: string,
  args: string[],
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 50 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(stderr || err.message));
        return;
      }
      resolve({ stdout: stdout ?? "", stderr: stderr ?? "" });
    });
  });
}

async function runVlmStage(
  opts: PipelineOptions, policy: Record<string, unknown>,
  assetsJson: AssetsJson, segmentsJson: SegmentsJson,
  existingSegmentsJson: SegmentsJson | undefined,
  sourceFileMap: Map<string, string>, outputDir: string,
  _policyHash: string, segmentsPath: string, assetsPath: string,
  sourceIdentityCache: SourceContentIdentityCache,
  persistOutputs = true,
): Promise<{ assets: AssetsJson; segments: SegmentsJson; vlmShards?: VlmShard[]; vlmSummary?: VlmAssetRunSummary } | null> {
  const vlmPolicy = (policy as Record<string, unknown>)["vlm"] as VlmPolicy | undefined;
  const samplingPolicy = (policy as Record<string, unknown>)["sampling"] as SamplingPolicy | undefined;
  const qualThresholds = (policy as Record<string, unknown>)["quality_thresholds"] as Record<string, unknown> | undefined;
  if (!vlmPolicy || !samplingPolicy) return null;

  const minSegDuration = (qualThresholds?.min_segment_duration_us as number) ?? 750_000;
  const vlmPolicyHash = computeVlmCachePolicyHash(
    vlmPolicy,
    samplingPolicy,
    minSegDuration,
    opts.contentHint,
  );
  const cacheDecisions = new Map<string, import("./stages/vlm.js").VlmCacheDecision>();
  const cachedSegmentIds = opts.vlmOnly
    ? new Set<string>()
    : hydrateCachedVlmSegments({
      currentSegments: segmentsJson.items,
      cachedSegments: existingSegmentsJson?.items,
      vlmPolicy,
      policyHash: vlmPolicyHash,
      samplingPolicy,
      minSegmentDurationUs: minSegDuration,
      sourceFileMap,
      outputDir,
      sourceIdentityCache,
      cacheDecisions,
      eligibleAssetIds: visualAssetIds(assetsJson),
      assets: assetsJson.items,
    });

  let vlmShards: VlmShard[] = [];
  let vlmSummary: VlmAssetRunSummary | undefined;
  if (opts.vlmFn) {
    const liveVlm = await runParallelVlmAnalysis({
      assets: assetsJson.items, segments: segmentsJson.items, vlmPolicy, samplingPolicy,
      minSegmentDurationUs: minSegDuration, vlmFn: opts.vlmFn, contentHint: opts.contentHint,
      concurrency: opts.vlmConcurrency, reporter: opts.vlmProgressReporter, cachedSegmentIds,
      sourceFileMap, outputDir,
      policyHash: vlmPolicyHash, sourceIdentityCache, cacheDecisions,
    });
    vlmShards = liveVlm.shards; vlmSummary = liveVlm.summary;
  }

  if (vlmShards.length > 0 || cachedSegmentIds.size > 0) {
    const result = vlmReduce(
      vlmShards,
      assetsJson,
      segmentsJson,
      vlmPolicyHash,
      vlmPolicy.response_format,
      segmentsPath,
      assetsPath,
      persistOutputs,
    );
    return { assets: result.assets, segments: result.segments, vlmShards, vlmSummary };
  }
  return { assets: assetsJson, segments: segmentsJson, vlmShards, vlmSummary };
}

async function runAppraiserPipelineStage(
  opts: PipelineOptions,
  segmentsJson: SegmentsJson,
  sourceFileMap: Map<string, string>,
  outputDir: string,
  segmentsPath: string,
  policyHash: string,
  eligibleAssetIds: ReadonlySet<string>,
): Promise<SegmentsJson> {
  console.log("[pipeline] Stage 10.5/12 editorial appraiser starting");
  const summary = await runAppraiserStage({
    segmentsJson,
    sourceFileMap,
    outputDir,
    segmentsOutputPath: segmentsPath,
    policyHash,
    skip: opts.skipAppraiser,
    model: opts.appraiserModel,
    concurrency: opts.vlmConcurrency ?? DEFAULT_APPRAISER_CONCURRENCY,
    appraiserFn: opts.appraiserFn,
    eligibleAssetIds,
  });

  if (!summary.skippedNoRuntime) {
    console.log(
      `[pipeline] Appraiser: ${summary.appraisedSegments}/${summary.totalSegments} segments appraised, ` +
      `${summary.cachedFrames} cached frames, ${summary.cachedAppraisals} cached appraisals`,
    );
  } else {
    console.log(`[pipeline] Appraiser skipped: ${summary.skipReason ?? "runtime_unavailable"}`);
  }
  if (summary.failedSegments.length > 0) {
    console.warn(`[pipeline] Appraiser degraded: ${summary.failedSegments.length} segments failed`);
  }
  return segmentsJson;
}

async function runVisualQualityPipelineStage(
  segmentsJson: SegmentsJson,
  sourceFileMap: Map<string, string>,
  segmentsPath: string,
  policyHash: string,
  assetsJson: AssetsJson,
  analyzeFn?: VisualQualityAnalyzeFn,
  eligibleAssetIds?: ReadonlySet<string>,
): Promise<SegmentsJson> {
  console.log("[pipeline] Stage 10.6/12 ffmpeg visual quality measurements starting");
  const result = await runVisualQualityMeasurementStage({
    segmentsJson,
    sourceFileMap,
    segmentsOutputPath: segmentsPath,
    policyHash,
    analyzeFn,
    eligibleAssetIds,
    assetMediaKinds: new Map(assetsJson.items.map((asset) => [asset.asset_id, asset.media_kind ?? "unknown"])),
  });
  const { summary } = result;
  console.log(
    `[pipeline] Visual quality measurements: ${summary.measuredSegments}/${summary.totalSegments} complete, ` +
    `${summary.partialSegments} partial, ${summary.failedSegments.length} failed`,
  );
  if (summary.failedSegments.length > 0) {
    const first = summary.failedSegments[0];
    console.warn(
      `[pipeline] Visual quality degraded: ${summary.failedSegments.length} segments failed ` +
      `(first: ${first.segment_id} ${first.error})`,
    );
  }
  return result.segmentsJson;
}

function expectedSourceHashes(
  shards: IngestShard[],
  sourceContentHashMap: Map<string, string>,
): Map<string, string> {
  return new Map(shards.flatMap((shard) => {
    const hash = sourceContentHashMap.get(shard.asset.asset_id);
    return hash ? [[path.resolve(shard.sourceFile), hash] as const] : [];
  }));
}
