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
import type { QualityThresholds, SegmentItem } from "../connectors/ffmpeg-segmenter.js";
import { computePolicyHash, getFfmpegVersion, type AssetItem } from "../connectors/ffprobe.js";
import type { ContactSheetManifest, DerivativeResults } from "../connectors/ffmpeg-derivatives.js";
import type { AssetSttResult } from "../connectors/openai-stt.js";
import type { VlmFn, VlmPolicy, SamplingPolicy } from "../connectors/gemini-vlm.js";
import type { DiarizeOptions, DiarizeTurn } from "../connectors/pyannote-diarizer.js";
import type { TranscribeFn, SttPolicy, TranscriptAlignmentThresholds } from "../connectors/stt-interface.js";
import type { PeakDetectionPolicy } from "../connectors/vlm-peak-detector.js";
import { DEFAULT_PEAK_POLICY } from "../connectors/vlm-peak-detector.js";
import type { MarlinFn, MarlinModelRecord } from "../connectors/marlin-types.js";
import { resolvePolicy } from "../policy-resolver.js";
import { generateDisplayNames, type DisplayNameInput } from "./display-name.js";
import { createMediaLinks, loadSourceMap, type MediaSourceMapDoc } from "../media/source-map.js";
import { runProjectBgmAnalysis } from "../media/bgm-analyzer.js";
import type { PipelineStageProgress, ProgressTracker } from "../progress.js";
import {
  type CacheManifestEntry,
  computeCacheHash,
  loadCacheManifest,
  saveCacheManifest,
  clearCacheManifest,
  lookupCache,
} from "./analysis-cache.js";

// ── Stage imports ──────────────────────────────────────────────────
import { atomicWriteJson, atomicWriteYaml, readJsonIfExists } from "./stages/_util.js";
import { ingestMap, ingestReduce, type IngestShard } from "./stages/ingest-map.js";
import { segmentMap, segmentReduce } from "./stages/segment.js";
import { derivativesMap, derivativesReduce } from "./stages/derivatives.js";
import { resolveTranscribeFn, sttMap, sttReduce } from "./stages/stt.js";
import { hydrateCachedVlmSegments, runParallelVlmAnalysis, vlmReduce, type VlmShard, type VlmAssetRunSummary, type VlmProgressReporter } from "./stages/vlm.js";
import { DEFAULT_APPRAISER_CONCURRENCY, runAppraiserStage, type AppraiserFn } from "./stages/appraiser.js";
import { runVisualQualityMeasurementStage } from "./stages/visual-quality.js";
import { degradedPeakMap, peakMap, peakReduce, type PeakShard } from "./stages/peak.js";
import { buildGapReport, buildManifestEntries } from "./stages/gap-report.js";
import { runMarlinAnalysis } from "./stages/marlin.js";

// ── Re-exports for backward compatibility ──────────────────────────
export type { AssetsJson, SegmentsJson, GapEntry, GapReport } from "./pipeline-types.js";
export type { PeakShard } from "./stages/peak.js";
export { resolveTranscribeFn } from "./stages/stt.js";
import type { AssetsJson, SegmentsJson, GapReport, GapEntry } from "./pipeline-types.js";

// ── Types ──────────────────────────────────────────────────────────

export interface PipelineOptions {
  sourceFiles: string[];
  projectDir: string;
  repoRoot?: string;
  transcribeFn?: TranscribeFn;
  vlmFn?: VlmFn;
  marlinFn?: MarlinFn;
  marlinModel?: MarlinModelRecord;
  marlinQueries?: string[];
  appraiserFn?: AppraiserFn;
  appraiserModel?: string;
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
  vlmConcurrency?: number;
  vlmProgressReporter?: VlmProgressReporter;
  noCache?: boolean;
  clearCache?: boolean;
  progressTracker?: ProgressTracker;
  stageProgress?: PipelineStageProgress;
  vlmOnly?: boolean;
  sttStrategy?: SttStrategy;
}

export interface PipelineResult {
  assetsJson: AssetsJson;
  segmentsJson: SegmentsJson;
  gapReport: GapReport;
  outputDir: string;
  mediaSourceMap?: MediaSourceMapDoc;
  mediaSourceMapPath?: string;
  vlmSummary?: VlmAssetRunSummary;
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
  const existingAssetsJson = readJsonIfExists<AssetsJson>(assetsPath);
  const existingSegmentsJson = readJsonIfExists<SegmentsJson>(segmentsPath);
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
  const sourceFiles = opts.sourceFiles.map((f) => path.resolve(absProjectDir, f));
  const projectId = path.basename(absProjectDir);
  const pt = opts.progressTracker;
  const stageProgress = opts.stageProgress;
  const shouldRunMarlinStage = Boolean(opts.marlinFn) && !opts.skipMarlin && !opts.vlmOnly;

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
  let allIngestShards: IngestShard[];
  try {
    console.log("[pipeline] Stage 1/12 ingest.map starting");
    allIngestShards = await ingestMap(sourceFiles, { projectRoot: absProjectDir, policyHash, ffmpegVersion });
    pt?.advance();
  } catch (error) {
    ingestProgress?.fail(error);
    throw error;
  }

  // ── Cache Check ──
  const { cacheHitIds, cacheHashMap, cachedAssetItems, cachedSegmentItems, newIngestShards } =
    checkCache(allIngestShards, useCache, manifest, existingAssetsJson, existingSegmentsJson);

  // ── All cached — short-circuit ──
  if (newIngestShards.length === 0 && cacheHitIds.size > 0) {
    ingestProgress?.complete();
    const cachedResult = finalizeCached(allIngestShards, cachedAssetItems, cachedSegmentItems, cacheHashMap,
      projectId, assetsPath, segmentsPath, gapReportPath, manifestPath, outputDir,
      absProjectDir, sourceFiles, opts, pt);
    if (shouldRunMarlinStage) {
      const marlinProgress = stageProgress?.beginStage("marlin");
      try {
        const refreshedSegments = await runMarlinStage(opts, projectId, absProjectDir, sourceFiles, segmentsPath);
        if (refreshedSegments) {
          cachedResult.segmentsJson = refreshedSegments;
        }
        marlinProgress?.complete();
      } catch (error) {
        marlinProgress?.fail(error);
        throw error;
      }
    }
    const allSourceFileMap = new Map<string, string>();
    for (const shard of allIngestShards) allSourceFileMap.set(shard.asset.asset_id, shard.sourceFile);
    const visualQualityProgress = stageProgress?.beginStage("visual-quality");
    try {
      cachedResult.segmentsJson = await runVisualQualityPipelineStage(
        cachedResult.segmentsJson,
        allSourceFileMap,
        segmentsPath,
        policyHash,
      );
      if (!opts.skipAppraiser) {
        cachedResult.segmentsJson = await runAppraiserPipelineStage(
          opts,
          cachedResult.segmentsJson,
          allSourceFileMap,
          outputDir,
          segmentsPath,
          policyHash,
        );
      }
      visualQualityProgress?.complete();
    } catch (error) {
      visualQualityProgress?.fail(error);
      throw error;
    }
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

  // ── Stage 8.5: Marlin reporter ──
  if (shouldRunMarlinStage) {
    const marlinProgress = stageProgress?.beginStage("marlin");
    try {
      const refreshedSegments = await runMarlinStage(opts, projectId, absProjectDir, sourceFiles, segmentsPath);
      if (refreshedSegments) {
        segmentsJson = refreshedSegments;
      }
      pt?.advance("marlin_events.json");
      marlinProgress?.complete();
    } catch (error) {
      marlinProgress?.fail(error);
      throw error;
    }
  }

  let vlmShards: VlmShard[] | undefined;
  let vlmSummary: VlmAssetRunSummary | undefined;
  const visualQualityProgress = stageProgress?.beginStage("visual-quality");
  try {
    // ── Stage 9–10: VLM ──
    if (!opts.skipVlm) {
      console.log("[pipeline] Stage 9-10/12 VLM starting");
      const result = await runVlmStage(opts, policy, assetsJson, segmentsJson, existingSegmentsJson,
        policyHash, segmentsPath, assetsPath);
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
      );
      pt?.advance("segments.json");
    }

    segmentsJson = await runVisualQualityPipelineStage(
      segmentsJson,
      sourceFileMap,
      segmentsPath,
      policyHash,
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
          peakMap(assetsJson, segmentsJson, derivativeResults, opts.vlmFn, peakPolicy ?? DEFAULT_PEAK_POLICY, outputDir, opts.contentHint),
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

  // ── Merge cached data ──
  if (cacheHitIds.size > 0) {
    assetsJson.items.push(...cachedAssetItems);
    assetsJson.items.sort((a, b) => a.asset_id.localeCompare(b.asset_id));
    segmentsJson.items.push(...cachedSegmentItems);
    segmentsJson.items.sort((a, b) => a.asset_id !== b.asset_id ? a.asset_id.localeCompare(b.asset_id) : a.src_in_us - b.src_in_us);
    atomicWriteJson(assetsPath, assetsJson);
    atomicWriteJson(segmentsPath, segmentsJson);
    for (const shard of allIngestShards) {
      if (cacheHitIds.has(shard.asset.asset_id)) sourceFileMap.set(shard.asset.asset_id, shard.sourceFile);
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
  const gapReport = buildGapReport(newAssetItems, segmentShards, derivativeResults, segMapResult.detectorFailures, sttResults, vlmShards, peakShards);
  if (sttSkippedAssetIds.size > 0) {
    gapReport.entries = gapReport.entries.filter((entry) =>
      !(entry.stage === "stt" && entry.issue === "stt_not_attempted" && sttSkippedAssetIds.has(entry.asset_id))
    );
  }
  gapReport.entries.push(...diarizeGapEntries);
  atomicWriteYaml(gapReportPath, gapReport);

  // ── Media links + BGM ──
  console.log("[pipeline] Stage media-links/BGM starting");
  let mediaSourceMap: MediaSourceMapDoc | undefined;
  let mediaSourceMapPath: string | undefined;
  if (!opts.skipBgmAnalysis) { runProjectBgmAnalysis({ sourceFiles, projectDir: absProjectDir, projectId }); }
  if (!opts.skipMediaLink) {
    const mediaLinks = createMediaLinks({ projectPath: absProjectDir, projectId, assets: assetsJson.items, sourceFileMap });
    mediaSourceMap = mediaLinks.doc; mediaSourceMapPath = mediaLinks.sourceMapPath;
    for (const warning of mediaLinks.warnings) console.warn(`[pipeline] ${warning}`);
  }

  saveCacheManifest(manifestPath, buildManifestEntries(allIngestShards, cacheHashMap));
  pt?.complete(["assets.json", "segments.json", "gap_report.yaml"]);

  return { assetsJson, segmentsJson, gapReport, outputDir, mediaSourceMap, mediaSourceMapPath, vlmSummary };
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
      policyHash, segmentsPath, assetsPath);
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
    );
    pt?.advance("segments.json");
  }

  segmentsJson = await runVisualQualityPipelineStage(
    segmentsJson,
    sourceFileMap,
    segmentsPath,
    policyHash,
  );
  pt?.advance("segments.json");

  let peakShards: PeakShard[] | undefined;
  if (!opts.skipPeak && !opts.skipVlm && opts.vlmFn) {
    const peakPolicy = (policy as Record<string, unknown>)["peak_detection"] as PeakDetectionPolicy | undefined;
    console.log("[pipeline] Stage 11-12/12 VLM peak detection starting (--vlm-only)");
    const timeoutMs = readPeakTimeoutMs();
    try {
      peakShards = await withTimeout(
        peakMap(assetsJson, segmentsJson, derivativeResults, opts.vlmFn, peakPolicy ?? DEFAULT_PEAK_POLICY, outputDir, opts.contentHint),
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
  saveCacheManifest(manifestPath, buildManifestEntriesFromExistingAssets(assetsJson.items, sourceFileMap, manifest));
  pt?.complete(["segments.json", "gap_report.yaml", "cache_manifest.json"]);

  return { assetsJson, segmentsJson, gapReport, outputDir, vlmSummary };
}

// ── Private Helpers ────────────────────────────────────────────────

function checkCache(
  allIngestShards: IngestShard[],
  useCache: boolean,
  manifest: CacheManifestEntry[],
  existingAssetsJson: AssetsJson | undefined,
  existingSegmentsJson: SegmentsJson | undefined,
) {
  const cacheHitIds = new Set<string>();
  const cacheHashMap = new Map<string, string>();

  for (const shard of allIngestShards) {
    const absPath = path.resolve(shard.sourceFile);
    const stat = fs.statSync(absPath);
    const hash = computeCacheHash(absPath, stat.size, shard.asset.duration_us);
    cacheHashMap.set(shard.asset.asset_id, hash);

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

  return { cacheHitIds, cacheHashMap, cachedAssetItems, cachedSegmentItems, newIngestShards };
}

function restoreSourceFileMap(
  absProjectDir: string,
  assetsJson: AssetsJson,
  sourceFiles: string[],
): Map<string, string> {
  const sourceMap = loadSourceMap(absProjectDir);
  const sourceFilesByBasename = new Map<string, string>();
  for (const file of sourceFiles) {
    if (!sourceFilesByBasename.has(path.basename(file))) {
      sourceFilesByBasename.set(path.basename(file), file);
    }
  }

  const result = new Map<string, string>();
  for (const asset of assetsJson.items) {
    const entry = sourceMap.entryMap.get(asset.asset_id);
    const candidates = uniqueStrings([
      entry?.local_source_path,
      entry?.source_locator,
      asset.source_locator ? resolveProjectPath(absProjectDir, asset.source_locator) : undefined,
      sourceFilesByBasename.get(asset.filename),
      resolveProjectPath(absProjectDir, asset.filename),
      resolveProjectPath(absProjectDir, path.join("00_sources", asset.filename)),
      resolveProjectPath(absProjectDir, path.join("02_media", asset.filename)),
    ]);
    const existing = candidates.find((candidate) => fs.existsSync(candidate));
    const selected = existing ?? candidates[0];
    if (selected) {
      result.set(asset.asset_id, selected);
    }
    if (!existing) {
      console.warn(`[pipeline] --vlm-only: source file not found for ${asset.asset_id}; source-dependent fallbacks may be skipped`);
    }
  }
  return result;
}

function loadExistingDerivativeResults(
  assetsJson: AssetsJson,
  segmentsJson: SegmentsJson,
  outputDir: string,
): Map<string, DerivativeResults> {
  const result = new Map<string, DerivativeResults>();
  const segmentsByAsset = groupSegmentsByAsset(segmentsJson.items);

  for (const asset of assetsJson.items) {
    const contactSheets: ContactSheetManifest[] = [];
    for (const contactSheetId of asset.contact_sheet_ids ?? []) {
      const manifestPath = path.join(outputDir, "contact_sheets", `${contactSheetId}.json`);
      const manifest = readJsonIfExists<ContactSheetManifest>(manifestPath);
      if (!manifest) {
        console.warn(`[pipeline] --vlm-only: missing contact sheet manifest ${manifestPath}; peak detection may skip ${asset.asset_id}`);
        continue;
      }
      if (!derivativeRelPathExists(outputDir, manifest.image_path)) {
        console.warn(`[pipeline] --vlm-only: missing contact sheet image ${manifest.image_path}; peak detection may skip ${asset.asset_id}`);
        continue;
      }
      contactSheets.push(manifest);
    }

    const posterPath = readExistingDerivativePath(outputDir, asset.poster_path, `${asset.asset_id} poster`);
    const waveformPath = readExistingDerivativePath(outputDir, asset.waveform_path, `${asset.asset_id} waveform`);
    const filmstripPaths = new Map<string, string>();
    for (const segment of segmentsByAsset.get(asset.asset_id) ?? []) {
      if (!segment.filmstrip_path) continue;
      if (!derivativeRelPathExists(outputDir, segment.filmstrip_path)) {
        console.warn(`[pipeline] --vlm-only: missing filmstrip ${segment.filmstrip_path}; peak detection may use contact sheet fallback`);
        continue;
      }
      filmstripPaths.set(segment.segment_id, segment.filmstrip_path);
    }

    result.set(asset.asset_id, {
      contactSheets,
      posterPath,
      filmstripPaths,
      waveformPath,
    });
  }

  return result;
}

function preserveVlmOnlySegmentFields(
  nextSegmentsJson: SegmentsJson,
  originalSegmentsJson: SegmentsJson,
): SegmentsJson {
  const originalById = new Map(
    originalSegmentsJson.items.map((segment) => [segment.segment_id, segment]),
  );
  return {
    ...nextSegmentsJson,
    items: nextSegmentsJson.items.map((segment) => {
      const original = originalById.get(segment.segment_id);
      if (!original) return segment;
      return {
        ...original,
        summary: segment.summary,
        tags: segment.tags,
        confidence: segment.confidence,
        provenance: segment.provenance,
        ...((segment as unknown as Record<string, unknown>).visual_quality ? { visual_quality: (segment as unknown as Record<string, unknown>).visual_quality } : {}),
        ...(segment.visual_quality_measurements ? { visual_quality_measurements: segment.visual_quality_measurements } : {}),
      };
    }),
  };
}

function groupSegmentsByAsset(segments: SegmentItem[]): Map<string, SegmentItem[]> {
  const grouped = new Map<string, SegmentItem[]>();
  for (const segment of segments) {
    const current = grouped.get(segment.asset_id);
    if (current) {
      current.push(segment);
    } else {
      grouped.set(segment.asset_id, [segment]);
    }
  }
  return grouped;
}

function buildManifestEntriesFromExistingAssets(
  assets: AssetItem[],
  sourceFileMap: Map<string, string>,
  previousManifest: CacheManifestEntry[],
): CacheManifestEntry[] {
  const now = new Date().toISOString();
  const previousByAssetId = new Map(previousManifest.map((entry) => [entry.asset_id, entry]));
  const entries: CacheManifestEntry[] = [];

  for (const asset of assets) {
    const sourcePath = sourceFileMap.get(asset.asset_id);
    if (sourcePath && fs.existsSync(sourcePath)) {
      const stat = fs.statSync(sourcePath);
      entries.push({
        hash: computeCacheHash(sourcePath, stat.size, asset.duration_us),
        asset_id: asset.asset_id,
        cached_at: now,
        source_path: sourcePath,
      });
      continue;
    }

    const previous = previousByAssetId.get(asset.asset_id);
    if (previous) {
      entries.push({ ...previous, cached_at: now });
    } else {
      console.warn(`[cache] --vlm-only: cache manifest entry skipped for ${asset.asset_id}; source file unavailable`);
    }
  }

  return entries;
}

function readExistingDerivativePath(
  outputDir: string,
  relPath: string | undefined,
  label: string,
): string | null {
  if (!relPath) return null;
  if (derivativeRelPathExists(outputDir, relPath)) return relPath;
  console.warn(`[pipeline] --vlm-only: missing ${label} derivative ${relPath}`);
  return null;
}

function derivativeRelPathExists(outputDir: string, relPath: string | undefined): boolean {
  if (!relPath) return false;
  return fs.existsSync(path.isAbsolute(relPath) ? relPath : path.join(outputDir, relPath));
}

function resolveProjectPath(absProjectDir: string, value: string): string {
  return path.isAbsolute(value) ? value : path.resolve(absProjectDir, value);
}

function uniqueStrings(values: Array<string | undefined>): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (!value || seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function finalizeCached(
  allIngestShards: IngestShard[],
  cachedAssetItems: import("../connectors/ffprobe.js").AssetItem[],
  cachedSegmentItems: import("../connectors/ffmpeg-segmenter.js").SegmentItem[],
  cacheHashMap: Map<string, string>,
  projectId: string, assetsPath: string, segmentsPath: string,
  gapReportPath: string, manifestPath: string, outputDir: string,
  absProjectDir: string, sourceFiles: string[],
  opts: PipelineOptions, pt: ProgressTracker | undefined,
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
  if (!opts.skipBgmAnalysis) { runProjectBgmAnalysis({ sourceFiles, projectDir: absProjectDir, projectId }); }
  if (!opts.skipMediaLink) {
    const mediaLinks = createMediaLinks({ projectPath: absProjectDir, projectId, assets: assetsJson.items, sourceFileMap: allSourceFileMap });
    mediaSourceMap = mediaLinks.doc; mediaSourceMapPath = mediaLinks.sourceMapPath;
  }

  saveCacheManifest(manifestPath, buildManifestEntries(allIngestShards, cacheHashMap));
  pt?.complete(["assets.json", "segments.json"]);
  return { assetsJson, segmentsJson, gapReport: { version: "1", entries: [] }, outputDir, mediaSourceMap, mediaSourceMapPath };
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
  policyHash: string, segmentsPath: string, assetsPath: string,
): Promise<{ assets: AssetsJson; segments: SegmentsJson; vlmShards?: VlmShard[]; vlmSummary?: VlmAssetRunSummary } | null> {
  const vlmPolicy = (policy as Record<string, unknown>)["vlm"] as VlmPolicy | undefined;
  const samplingPolicy = (policy as Record<string, unknown>)["sampling"] as SamplingPolicy | undefined;
  const qualThresholds = (policy as Record<string, unknown>)["quality_thresholds"] as Record<string, unknown> | undefined;
  if (!vlmPolicy || !samplingPolicy) return null;

  const minSegDuration = (qualThresholds?.min_segment_duration_us as number) ?? 750_000;
  const cachedSegmentIds = opts.vlmOnly
    ? new Set<string>()
    : hydrateCachedVlmSegments({ currentSegments: segmentsJson.items, cachedSegments: existingSegmentsJson?.items, vlmPolicy, policyHash });

  let vlmShards: VlmShard[] = [];
  let vlmSummary: VlmAssetRunSummary | undefined;
  if (opts.vlmFn) {
    const liveVlm = await runParallelVlmAnalysis({
      assets: assetsJson.items, segments: segmentsJson.items, vlmPolicy, samplingPolicy,
      minSegmentDurationUs: minSegDuration, vlmFn: opts.vlmFn, contentHint: opts.contentHint,
      concurrency: opts.vlmConcurrency, reporter: opts.vlmProgressReporter, cachedSegmentIds,
    });
    vlmShards = liveVlm.shards; vlmSummary = liveVlm.summary;
  }

  if (vlmShards.length > 0 || cachedSegmentIds.size > 0) {
    const result = vlmReduce(vlmShards, assetsJson, segmentsJson, policyHash, vlmPolicy.response_format, segmentsPath, assetsPath);
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
): Promise<SegmentsJson> {
  console.log("[pipeline] Stage 10.6/12 ffmpeg visual quality measurements starting");
  const result = await runVisualQualityMeasurementStage({
    segmentsJson,
    sourceFileMap,
    segmentsOutputPath: segmentsPath,
    policyHash,
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

async function runMarlinStage(
  opts: PipelineOptions,
  projectId: string,
  absProjectDir: string,
  sourceFiles: string[],
  segmentsPath: string,
): Promise<SegmentsJson | undefined> {
  if (!opts.marlinFn) return undefined;

  console.log("[pipeline] Stage 8.5/12 Marlin reporter starting");
  await runMarlinAnalysis({
    projectDir: absProjectDir,
    projectId,
    sourceFiles,
    marlinFn: opts.marlinFn,
    model: opts.marlinModel,
    queries: opts.marlinQueries,
  });
  return readJsonIfExists<SegmentsJson>(segmentsPath);
}
