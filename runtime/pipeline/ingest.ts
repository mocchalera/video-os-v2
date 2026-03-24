/**
 * Pipeline orchestrator — coordinates stage modules for the ingest pipeline.
 *
 * Per milestone-2-design.md §Pipeline Orchestration (stages 1–12)
 *
 * Stage implementations live in ./stages/. This module wires them together,
 * handles caching, policy resolution, and progress tracking.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { QualityThresholds } from "../connectors/ffmpeg-segmenter.js";
import { computePolicyHash, getFfmpegVersion } from "../connectors/ffprobe.js";
import type { AssetSttResult } from "../connectors/openai-stt.js";
import type { VlmFn, VlmPolicy, SamplingPolicy } from "../connectors/gemini-vlm.js";
import type { DiarizeOptions, DiarizeTurn } from "../connectors/pyannote-diarizer.js";
import type { TranscribeFn, SttPolicy, TranscriptAlignmentThresholds } from "../connectors/stt-interface.js";
import type { PeakDetectionPolicy } from "../connectors/vlm-peak-detector.js";
import { DEFAULT_PEAK_POLICY } from "../connectors/vlm-peak-detector.js";
import { resolvePolicy } from "../policy-resolver.js";
import { generateDisplayNames, type DisplayNameInput } from "./display-name.js";
import { createMediaLinks, type MediaSourceMapDoc } from "../media/source-map.js";
import { runProjectBgmAnalysis } from "../media/bgm-analyzer.js";
import type { ProgressTracker } from "../progress.js";
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
import { peakMap, peakReduce, type PeakShard } from "./stages/peak.js";
import { buildGapReport, buildManifestEntries } from "./stages/gap-report.js";

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
  skipStt?: boolean;
  skipVlm?: boolean;
  sttLanguageOverride?: string;
  sttProvider?: string;
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

  // Resolve policy
  const { resolved: policy } = resolvePolicy(absProjectDir, opts.repoRoot);
  const policyHash = computePolicyHash(policy);
  const thresholds = (policy as Record<string, unknown>)["quality_thresholds"] as QualityThresholds;
  const ffmpegVersion = await getFfmpegVersion();
  const sourceFiles = opts.sourceFiles.map((f) => path.resolve(absProjectDir, f));
  const projectId = path.basename(absProjectDir);

  // Progress tracking
  const pt = opts.progressTracker;
  let totalStages = 6;
  if (!opts.skipStt) totalStages += 1;
  if (!opts.skipVlm) totalStages += 1;
  if (!opts.skipVlm && !opts.skipPeak) totalStages += 1;
  pt?.setTotal(totalStages);

  // ── Stage 1: Ingest ──
  const allIngestShards = await ingestMap(sourceFiles, { projectRoot: absProjectDir, policyHash, ffmpegVersion });
  pt?.advance();

  // ── Cache Check ──
  const { cacheHitIds, cacheHashMap, cachedAssetItems, cachedSegmentItems, newIngestShards } =
    checkCache(allIngestShards, useCache, manifest, existingAssetsJson, existingSegmentsJson);

  // ── All cached — short-circuit ──
  if (newIngestShards.length === 0 && cacheHitIds.size > 0) {
    return finalizeCached(allIngestShards, cachedAssetItems, cachedSegmentItems, cacheHashMap,
      projectId, assetsPath, segmentsPath, gapReportPath, manifestPath, outputDir,
      absProjectDir, sourceFiles, opts, pt);
  }

  // ── Stage 2: Reduce ──
  const { assetsJson: initialAssetsJson, sourceFileMap } = ingestReduce(newIngestShards, projectId, assetsPath);
  let assetsJson = initialAssetsJson;
  pt?.advance("assets.json");

  // ── Stage 3–4: Segment ──
  const segMapResult = await segmentMap(sourceFileMap, assetsJson.items, thresholds, { policyHash, ffmpegVersion });
  const segmentShards = segMapResult.shards;
  const segResult = segmentReduce(segmentShards, assetsJson, segmentsPath, assetsPath);
  assetsJson = segResult.assets;
  let segmentsJson = segResult.segments;
  pt?.advance("segments.json");

  // ── Stage 5–6: Derivatives ──
  const derivativeResults = await derivativesMap(sourceFileMap, assetsJson.items, segmentShards, outputDir);
  const derivResult = derivativesReduce(derivativeResults, assetsJson, segmentsJson, assetsPath, segmentsPath);
  assetsJson = derivResult.assets;
  segmentsJson = derivResult.segments;
  pt?.advance();

  // ── Stage 7–8: STT ──
  let sttResults: Map<string, AssetSttResult> | undefined;
  const diarizeGapEntries: GapEntry[] = [];
  if (!opts.skipStt) {
    const result = await runSttStage(opts, policy, sourceFileMap, assetsJson, segmentsJson,
      projectId, outputDir, policyHash, assetsPath, segmentsPath, diarizeGapEntries);
    if (result) { assetsJson = result.assets; segmentsJson = result.segments; sttResults = result.sttResults; }
    pt?.advance();
  }

  // ── Stage 9–10: VLM ──
  let vlmShards: VlmShard[] | undefined;
  let vlmSummary: VlmAssetRunSummary | undefined;
  if (!opts.skipVlm) {
    const result = await runVlmStage(opts, policy, assetsJson, segmentsJson, existingSegmentsJson,
      policyHash, segmentsPath, assetsPath);
    if (result) { assetsJson = result.assets; segmentsJson = result.segments; vlmShards = result.vlmShards; vlmSummary = result.vlmSummary; }
    pt?.advance();
  }

  // ── Stage 11–12: Peak Detection ──
  let peakShards: PeakShard[] | undefined;
  if (!opts.skipVlm && !opts.skipPeak && opts.vlmFn) {
    const peakPolicy = (policy as Record<string, unknown>)["peak_detection"] as PeakDetectionPolicy | undefined;
    console.log("[pipeline] Running VLM peak detection...");
    peakShards = await peakMap(assetsJson, segmentsJson, derivativeResults, opts.vlmFn, peakPolicy ?? DEFAULT_PEAK_POLICY, outputDir, opts.contentHint);
    if (peakShards.length > 0) {
      segmentsJson = peakReduce(peakShards, segmentsJson, segmentsPath);
      console.log(`[pipeline] Peak detection: ${peakShards.filter((s) => s.peak_analysis).length}/${peakShards.length} segments enriched`);
    }
    pt?.advance();
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
  const displayNameInputs: DisplayNameInput[] = assetsJson.items
    .filter((asset) => sourceFileMap.has(asset.asset_id))
    .map((asset) => ({ asset, filePath: sourceFileMap.get(asset.asset_id)!, segments: segmentsJson.items.filter((s) => s.asset_id === asset.asset_id) }));
  const displayNames = generateDisplayNames(displayNameInputs);
  for (const asset of assetsJson.items) { const dn = displayNames.get(asset.asset_id); if (dn) asset.display_name = dn; }
  atomicWriteJson(assetsPath, assetsJson);
  pt?.advance();

  // ── Gap report ──
  const newAssetItems = assetsJson.items.filter((a) => !cacheHitIds.has(a.asset_id));
  const gapReport = buildGapReport(newAssetItems, segmentShards, derivativeResults, segMapResult.detectorFailures, sttResults, vlmShards, peakShards);
  gapReport.entries.push(...diarizeGapEntries);
  atomicWriteYaml(gapReportPath, gapReport);

  // ── Media links + BGM ──
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
): Promise<{ assets: AssetsJson; segments: SegmentsJson; sttResults: Map<string, AssetSttResult> } | null> {
  const sttPolicy = (policy as Record<string, unknown>)["stt"] as SttPolicy | undefined;
  const qualThresholds = (policy as Record<string, unknown>)["quality_thresholds"] as Record<string, unknown> | undefined;
  if (!sttPolicy) return null;

  const effectiveSttPolicy: SttPolicy = opts.sttLanguageOverride ? { ...sttPolicy, language: opts.sttLanguageOverride } : sttPolicy;
  const alignmentThresholds: TranscriptAlignmentThresholds = {
    transcript_overlap_min_us: (qualThresholds?.transcript_overlap_min_us as number) ?? 250_000,
    transcript_overlap_fraction_min: (qualThresholds?.transcript_overlap_fraction_min as number) ?? 0.25,
  };

  let transcribeFn: TranscribeFn; let providerName: string;
  if (opts.transcribeFn) { transcribeFn = opts.transcribeFn; providerName = opts.sttProvider ?? "injected"; }
  else {
    const resolved = resolveTranscribeFn(effectiveSttPolicy, opts.sttProvider);
    transcribeFn = resolved.transcribeFn; providerName = resolved.providerName;
    console.log(`[pipeline] STT provider: ${providerName} (model: ${effectiveSttPolicy.model_alias})`);
  }

  const sttResults = await sttMap(sourceFileMap, assetsJson.items, projectId, outputDir,
    effectiveSttPolicy, alignmentThresholds, policyHash, transcribeFn,
    { skipDiarize: opts.skipDiarize ?? false, providerName, diarizeFn: opts.diarizeFn, gapEntries: diarizeGapEntries });
  const result = sttReduce(sttResults, assetsJson, segmentsJson, alignmentThresholds, assetsPath, segmentsPath, outputDir);
  return { assets: result.assets, segments: result.segments, sttResults };
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
  const cachedSegmentIds = hydrateCachedVlmSegments({ currentSegments: segmentsJson.items, cachedSegments: existingSegmentsJson?.items, vlmPolicy, policyHash });

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
