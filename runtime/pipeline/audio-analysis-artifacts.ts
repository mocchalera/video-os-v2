import * as fs from "node:fs";
import * as path from "node:path";
import type { QualityThresholds } from "../connectors/ffmpeg-segmenter.js";
import type { AssetItem } from "../connectors/ffprobe.js";
import type { AssetSttResult } from "../connectors/openai-stt.js";
import { hasTemporalVideo } from "../artifacts/source-media-capabilities.js";
import { buildCurrentAudioEvents, writeAudioEvents } from "../artifacts/audio-events.js";
import { buildProjectAudioStoryGraph } from "../artifacts/audio-story-project-builder.js";
import {
  buildAnalysisCoverageReport,
  computeNormalizedJsonHash,
  writeAnalysisCoverageReport,
  type AnalysisCoverageReport,
  type SourceMediaManifest,
  type StageAssetResults,
} from "../artifacts/p1-manifest-coverage.js";
import { readAudioStoryGraph } from "../artifacts/p2-audio-story-graph.js";
import type { SourceLedger } from "../artifacts/source-ledger.js";
import { runProjectBgmAnalysis } from "../media/bgm-analyzer.js";
import type { BgmMeasuredBackend } from "../media/bgm-analyzer.js";
import { sha256FileHex } from "../source-content-identity.js";
import type { AssetsJson, SegmentsJson } from "./pipeline-types.js";
import type { PeakShard } from "./stages/peak.js";
import type { VlmShard } from "./stages/vlm.js";
import { inspectAnalysisCacheEligibility } from "./analysis-cache.js";

export type AudioStoryGraphStatus = "ready" | "partial" | "skipped";

export interface AudioStoryStatusAnalysis {
  assets: AssetItem[];
  sttAttempted: boolean;
  sttResults?: Map<string, AssetSttResult>;
  sttSkippedAssetIds?: Set<string>;
  audioEvents: { failures: Map<string, string>; itemCount: number };
  bgm: {
    requestedAssetIds: string[];
    readyAssetIds: string[];
    failedAssetIds: string[];
    unmatchedRequestedCount: number;
    bindingFailures?: string[];
  };
}

export interface FinalizeAudioAnalysisArtifactsOptions {
  projectDir: string;
  projectId: string;
  manifest: SourceMediaManifest;
  ledger: SourceLedger;
  assetsJson: AssetsJson;
  segmentsJson: SegmentsJson;
  sourceFileMap: Map<string, string>;
  thresholds: QualityThresholds;
  policyHash: string;
  ffmpegVersion: string;
  sttAttempted: boolean;
  sttSkipReason?: string;
  sttResults?: Map<string, AssetSttResult>;
  sttSkippedAssetIds?: Set<string>;
  vlmShards?: VlmShard[];
  peakShards?: PeakShard[];
  bgmSourceFiles?: string[];
  /** Force one built-in detector for deterministic public-route fixtures. */
  bgmForceBackend?: "aubiotrack" | "ffmpeg" | "librosa";
  /** Optional deterministic measured backend; null records provider unavailability. */
  bgmBackend?: BgmMeasuredBackend | null;
  skipBgmAnalysis?: boolean;
  skipVlm?: boolean;
  vlmProviderAvailable?: boolean;
  skipPeak?: boolean;
}

export function isExplicitAudioOnly(asset: AssetItem): boolean {
  return Boolean(asset.audio_stream) && !hasTemporalVideo(asset);
}

export function resolveExplicitBgmSources(
  bgmSourceFiles: string[] | undefined,
  assetsJson: AssetsJson,
  sourceFileMap: Map<string, string>,
): {
  sources: Array<{ sourceFile: string; assetId: string }>;
  requestedCount: number;
  unmatchedCount: number;
  bindingFailures?: string[];
  bindingFailedAssetIds?: string[];
} {
  const requested = new Set((bgmSourceFiles ?? []).map(canonicalFileIdentity));
  if (requested.size === 0) return { sources: [], requestedCount: 0, unmatchedCount: 0 };
  const matchedAssetIds: string[] = [];
  const sources = assetsJson.items.flatMap((asset) => {
    const sourceFile = sourceFileMap.get(asset.asset_id);
    if (!sourceFile || !requested.has(canonicalFileIdentity(sourceFile))) return [];
    matchedAssetIds.push(asset.asset_id);
    if (!asset.audio_stream) return [];
    const expectedHash = asset.source_content_sha256;
    if (!expectedHash || !/^[0-9a-f]{64}$/.test(expectedHash)) return [];
    try {
      if (!fs.statSync(sourceFile).isFile()) return [];
      if (sha256FileHex(sourceFile) !== expectedHash) return [];
    } catch {
      return [];
    }
    return [{ sourceFile, assetId: asset.asset_id }];
  });
  const unmatchedCount = Math.max(0, requested.size - matchedAssetIds.length);
  const bindingFailures = new Set<string>();
  const bindingFailedAssetIds = new Set<string>();
  if (unmatchedCount > 0) bindingFailures.add("bgm_source_unmatched");
  if (requested.size > 1 || matchedAssetIds.length > 1) bindingFailures.add("bgm_source_multiple");
  for (const assetId of matchedAssetIds) {
    if (!sources.some((source) => source.assetId === assetId)) {
      bindingFailedAssetIds.add(assetId);
      const asset = assetsJson.items.find((item) => item.asset_id === assetId);
      const sourceFile = sourceFileMap.get(assetId);
      if (!asset?.audio_stream) bindingFailures.add("bgm_source_not_audio");
      else if (!asset.source_content_sha256 || !/^[0-9a-f]{64}$/.test(asset.source_content_sha256)) {
        bindingFailures.add("bgm_source_identity_missing");
      } else if (!sourceFile) {
        bindingFailures.add("bgm_source_identity_unverifiable");
      } else {
        try {
          if (!fs.statSync(sourceFile).isFile()) bindingFailures.add("bgm_source_identity_unverifiable");
          else if (sha256FileHex(sourceFile) !== asset.source_content_sha256) bindingFailures.add("bgm_source_hash_mismatch");
          else bindingFailures.add("bgm_source_identity_unverifiable");
        } catch {
          bindingFailures.add("bgm_source_identity_unverifiable");
        }
      }
    }
  }
  if (bindingFailures.size > 0) {
    // A role is atomic: a partially resolved or multiply resolved request is
    // not allowed to publish analysis for whichever source happened to match.
    for (const assetId of matchedAssetIds) bindingFailedAssetIds.add(assetId);
    return {
      sources: [],
      requestedCount: requested.size,
      unmatchedCount,
      bindingFailures: [...bindingFailures].sort(),
      ...(bindingFailedAssetIds.size > 0 ? { bindingFailedAssetIds: [...bindingFailedAssetIds].sort() } : {}),
    };
  }
  return { sources, requestedCount: requested.size, unmatchedCount };
}

export async function finalizeAudioAnalysisArtifacts(
  options: FinalizeAudioAnalysisArtifactsOptions,
): Promise<AnalysisCoverageReport> {
  const audioEvents = await buildCurrentAudioEvents({
    projectId: options.projectId,
    assets: options.assetsJson.items,
    sourceFileMap: options.sourceFileMap,
    thresholds: options.thresholds,
    policyHash: options.policyHash,
    ffmpegVersion: options.ffmpegVersion,
  });
  writeAudioEvents(options.projectDir, audioEvents.artifact);

  const bgmResolution = resolveExplicitBgmSources(
    options.bgmSourceFiles,
    options.assetsJson,
    options.sourceFileMap,
  );
  const bgmSources = bgmResolution.sources;
  const bgmBindingFailed = (bgmResolution.bindingFailures?.length ?? 0) > 0;
  if (bgmBindingFailed) fs.rmSync(path.join(options.projectDir, "03_analysis/bgm_analysis.json"), { force: true });
  const bgmResult = options.skipBgmAnalysis
    ? runProjectBgmAnalysis({
      bgmSources: [],
      explicitRequestCount: 0,
      projectDir: options.projectDir,
      projectId: options.projectId,
      forceBackend: options.bgmForceBackend,
    })
    : bgmBindingFailed
      ? {
        writtenPaths: [],
        readyAssetIds: [],
        failures: (bgmResolution.bindingFailedAssetIds ?? []).map((assetId) => ({
          assetId,
          reason: "bgm_source_binding_failed",
        })),
      }
    : runProjectBgmAnalysis({
      bgmSources,
      explicitRequestCount: bgmResolution.requestedCount,
      projectDir: options.projectDir,
      projectId: options.projectId,
      forceBackend: options.bgmForceBackend,
      measuredBackend: options.bgmBackend,
    });
  const vlm = collectVlmStageResults(
    options.assetsJson,
    options.segmentsJson,
    options.vlmShards,
    !options.skipVlm && Boolean(options.vlmProviderAvailable),
  );
  const peaks = collectPeakStageResults(
    options.assetsJson,
    options.segmentsJson,
    options.peakShards,
    !options.skipPeak,
  );
  const bgmReadyAssetIds = bgmResult.readyAssetIds;
  const bgmArtifactPath = path.join(options.projectDir, "03_analysis/bgm_analysis.json");
  let bgmArtifactHash: string | null = null;
  if (fs.existsSync(bgmArtifactPath)) {
    try {
      bgmArtifactHash = computeNormalizedJsonHash(JSON.parse(fs.readFileSync(bgmArtifactPath, "utf-8")));
    } catch {
      bgmArtifactHash = null;
    }
  }
  const bgmFailedAssetIds = [...new Set([
    ...bgmResult.failures.map((failure) => failure.assetId),
    ...(bgmResolution.bindingFailedAssetIds ?? []),
  ])].sort();
  const baseAnalysis = {
    assets: options.assetsJson.items,
    segments: options.segmentsJson.items,
    sttAttempted: options.sttAttempted,
    sttSkipReason: options.sttSkipReason,
    sttResults: options.sttResults,
    sttSkippedAssetIds: options.sttSkippedAssetIds,
    audioEvents: {
      attemptedAssetIds: audioEvents.attemptedAssetIds,
      failures: audioEvents.failures,
      artifactHash: computeNormalizedJsonHash(audioEvents.artifact),
      itemCount: audioEvents.artifact.items.length,
    },
    vlm,
    peaks,
    bgm: {
      attempted: bgmResolution.requestedCount > 0 && !options.skipBgmAnalysis,
      requestedCount: bgmResolution.requestedCount,
      unmatchedRequestedCount: bgmResolution.unmatchedCount,
      requestedAssetIds: bgmSources.map((source) => source.assetId),
      readyAssetIds: bgmReadyAssetIds,
      failedAssetIds: bgmFailedAssetIds,
      ...(bgmResolution.bindingFailures ? { bindingFailures: bgmResolution.bindingFailures } : {}),
      artifactHash: bgmArtifactHash,
    },
  };
  const currentAssetIds = new Set(options.assetsJson.items.map((asset) => asset.asset_id));
  const audioStoryAssetIds = new Set([
    ...currentTranscriptAssetIds(options.projectDir, currentAssetIds),
    ...audioEvents.artifact.items.map((item) => item.asset_id),
    ...bgmReadyAssetIds,
  ]);
  const predictedGraphStatus = predictAudioStoryGraphStatus(baseAnalysis, options.projectDir);
  const coverage = buildAnalysisCoverageReport({
    projectId: options.projectId,
    manifest: options.manifest,
    ledger: options.ledger,
    analysis: {
      ...baseAnalysis,
      segmentsSchemaValid: inspectAnalysisCacheEligibility(options.projectDir).eligible,
      audioStoryGraph: {
        status: predictedGraphStatus,
        assetIds: [...audioStoryAssetIds].sort(),
        artifactHash: null,
      },
    },
  });
  writeAnalysisCoverageReport(options.projectDir, coverage);
  const graphResult = buildProjectAudioStoryGraph({ projectDir: options.projectDir, write: true });
  assertAudioStoryGraphResult(
    predictedGraphStatus,
    graphResult.status,
    readAudioStoryGraph(options.projectDir) !== null,
  );
  return coverage;
}

export function predictAudioStoryGraphStatus(
  analysis: AudioStoryStatusAnalysis,
  projectDir: string,
): AudioStoryGraphStatus {
  const currentAssetIds = new Set(analysis.assets.map((asset) => asset.asset_id));
  const hasTranscriptNodes = currentTranscriptItemCount(projectDir, currentAssetIds) > 0;
  const audioAssetIds = analysis.assets.filter((asset) => !!asset.audio_stream).map((asset) => asset.asset_id);
  const sttNeutral = audioAssetIds.length === 0
    || audioAssetIds.every((assetId) => analysis.sttSkippedAssetIds?.has(assetId));
  const sttFailed = Boolean(
    analysis.sttResults && [...analysis.sttResults.values()].some((result) => !result.success),
  );
  const bgmFailed = analysis.bgm.failedAssetIds.length > 0
    || analysis.bgm.unmatchedRequestedCount > 0
    || (analysis.bgm.bindingFailures?.length ?? 0) > 0;
  if (sttFailed || analysis.audioEvents.failures.size > 0 || bgmFailed) return "partial";
  const hasNodes = hasTranscriptNodes
    || analysis.audioEvents.itemCount > 0
    || analysis.bgm.readyAssetIds.length > 0;
  if (!hasNodes) return "skipped";
  return hasTranscriptNodes || sttNeutral || !analysis.sttAttempted ? "ready" : "partial";
}

export function assertAudioStoryGraphResult(
  expected: AudioStoryGraphStatus,
  actual: AudioStoryGraphStatus | "failed",
  graphPresent: boolean,
): void {
  if (!graphPresent) throw new Error("canonical_artifact_missing:03_analysis/audio_story_graph.json");
  if (actual !== expected) {
    throw new Error(`audio_story_graph_coverage_prediction_mismatch:${expected}:${actual}`);
  }
}

function canonicalFileIdentity(value: string): string {
  const absolute = path.resolve(value);
  try {
    return fs.realpathSync(absolute);
  } catch {
    return absolute;
  }
}

function currentTranscriptItemCount(projectDir: string, currentAssetIds: Set<string>): number {
  return currentTranscriptAssetIds(projectDir, currentAssetIds, true).length;
}

function currentTranscriptAssetIds(
  projectDir: string,
  currentAssetIds: Set<string>,
  countItems = false,
): string[] {
  const transcriptDir = path.join(projectDir, "03_analysis", "transcripts");
  if (!fs.existsSync(transcriptDir)) return [];
  const result: string[] = [];
  for (const filename of fs.readdirSync(transcriptDir).filter((name) => name.endsWith(".json")).sort()) {
    const value = JSON.parse(fs.readFileSync(path.join(transcriptDir, filename), "utf-8")) as {
      asset_id?: string;
      items?: unknown[];
    };
    if (!value.asset_id || !currentAssetIds.has(value.asset_id) || (value.items?.length ?? 0) === 0) continue;
    if (countItems) result.push(...Array.from({ length: value.items?.length ?? 0 }, () => value.asset_id!));
    else result.push(value.asset_id);
  }
  return result;
}

function collectVlmStageResults(
  assetsJson: AssetsJson,
  segmentsJson: SegmentsJson,
  shards: VlmShard[] | undefined,
  attempted: boolean,
): StageAssetResults {
  const assetBySegment = new Map(segmentsJson.items.map((segment) => [segment.segment_id, segment.asset_id]));
  const ready = new Set<string>();
  const failed = new Set<string>();
  for (const segment of segmentsJson.items) {
    const provenance = segment.provenance as Record<string, Record<string, unknown> | undefined>;
    if (provenance.summary?.stage === "vlm" || provenance.tags?.stage === "vlm") ready.add(segment.asset_id);
  }
  for (const shard of shards ?? []) {
    const assetId = assetBySegment.get(shard.segment_id);
    if (!assetId) continue;
    if (shard.result.success) ready.add(assetId);
    else failed.add(assetId);
  }
  for (const assetId of ready) failed.delete(assetId);
  const videoIds = new Set(assetsJson.items.filter((asset) => !isExplicitAudioOnly(asset)).map((asset) => asset.asset_id));
  return {
    attempted,
    readyAssetIds: [...ready].filter((assetId) => videoIds.has(assetId)).sort(),
    failedAssetIds: [...failed].filter((assetId) => videoIds.has(assetId)).sort(),
  };
}

function collectPeakStageResults(
  assetsJson: AssetsJson,
  segmentsJson: SegmentsJson,
  shards: PeakShard[] | undefined,
  attempted: boolean,
): StageAssetResults {
  const assetBySegment = new Map(segmentsJson.items.map((segment) => [segment.segment_id, segment.asset_id]));
  const ready = new Set(segmentsJson.items
    .filter((segment) => !!segment.peak_analysis)
    .map((segment) => segment.asset_id));
  const failed = new Set<string>();
  for (const shard of shards ?? []) {
    const assetId = assetBySegment.get(shard.segment_id);
    if (!assetId) continue;
    if (shard.peak_analysis) ready.add(assetId);
    if (shard.error && !shard.peak_analysis) failed.add(assetId);
  }
  for (const assetId of ready) failed.delete(assetId);
  const videoIds = new Set(assetsJson.items.filter((asset) => !isExplicitAudioOnly(asset)).map((asset) => asset.asset_id));
  return {
    attempted,
    readyAssetIds: [...ready].filter((assetId) => videoIds.has(assetId)).sort(),
    failedAssetIds: [...failed].filter((assetId) => videoIds.has(assetId)).sort(),
  };
}
