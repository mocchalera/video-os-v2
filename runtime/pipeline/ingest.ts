/**
 * Pipeline orchestrator — map/reduce stages for ingest, segment, derivatives.
 *
 * Per milestone-2-design.md §Pipeline Orchestration (stages 1–6)
 *
 * Canonical write discipline: assets.json, segments.json, and gap_report.yaml
 * are written only by reducers through temp file + atomic rename.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { stringify as stringifyYaml } from "yaml";
import {
  ingestAsset,
  computePolicyHash,
  getFfmpegVersion,
  type AssetItem,
} from "../connectors/ffprobe.js";
import {
  segmentAsset,
  type SegmentItem,
  type SegmentAssetResult,
  type QualityThresholds,
} from "../connectors/ffmpeg-segmenter.js";
import {
  generateAllDerivatives,
  type DerivativeResults,
} from "../connectors/ffmpeg-derivatives.js";
import {
  processAssetStt,
  computeTranscriptExcerpt,
  createOpenAiTranscribeFn,
  type AssetSttResult,
  type TranscriptItem,
} from "../connectors/openai-stt.js";
import type {
  TranscribeFn,
  SttPolicy,
  TranscriptAlignmentThresholds,
} from "../connectors/stt-interface.js";
import {
  type VlmFn,
  type VlmPolicy,
  type SamplingPolicy,
  type VlmEnrichmentResult,
  VLM_CONNECTOR_VERSION,
  getAdaptiveSampleFps,
  computeFrameCount,
  computeSampleTimestamps,
  adjustFpsForBudget,
  enrichSegment,
  shouldSkipVlm,
  computePromptHash,
  computeVlmRequestHash,
  guessAssetRole,
  type SegmentType,
} from "../connectors/gemini-vlm.js";
import { resolvePolicy } from "../policy-resolver.js";

// ── Types ──────────────────────────────────────────────────────────

export interface PipelineOptions {
  /** Source file paths (absolute or project-relative) */
  sourceFiles: string[];
  /** Project directory for output (03_analysis/ is created under this) */
  projectDir: string;
  /** Repository root override (for policy resolution) */
  repoRoot?: string;
  /** Injectable TranscribeFn for testing (bypasses real OpenAI API) */
  transcribeFn?: TranscribeFn;
  /** Injectable VlmFn for testing (bypasses real Gemini API) */
  vlmFn?: VlmFn;
  /** Skip STT stage entirely (e.g. when no audio streams present) */
  skipStt?: boolean;
  /** Skip VLM stage entirely */
  skipVlm?: boolean;
}

export interface PipelineResult {
  assetsJson: AssetsJson;
  segmentsJson: SegmentsJson;
  gapReport: GapReport;
  outputDir: string;
}

export interface AssetsJson {
  project_id: string;
  artifact_version: string;
  items: AssetItem[];
}

export interface SegmentsJson {
  project_id: string;
  artifact_version: string;
  items: SegmentItem[];
}

export interface GapEntry {
  stage: string;
  asset_id: string;
  issue: string;
  severity: "warning" | "error";
  segment_id?: string;
  blocking?: boolean;
  retriable?: boolean;
  attempted_at?: string;
}

export interface GapReport {
  version: string;
  entries: GapEntry[];
}

// ── Atomic Write ───────────────────────────────────────────────────

/**
 * Write JSON to a file atomically via temp file + rename.
 */
function atomicWriteJson(filePath: string, data: unknown): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = filePath + ".tmp." + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, filePath);
}

/**
 * Write YAML to a file atomically via temp file + rename.
 */
function atomicWriteYaml(filePath: string, data: unknown): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = filePath + ".tmp." + process.pid;
  fs.writeFileSync(tmp, stringifyYaml(data));
  fs.renameSync(tmp, filePath);
}

// ── Pipeline Stages ────────────────────────────────────────────────

/** A shard binding a source file to its ingested asset. */
interface IngestShard {
  sourceFile: string;
  asset: AssetItem;
}

/**
 * Stage 1: ingest.map — run ffprobe per asset, return per-asset shards.
 * Each shard binds the sourceFile to its asset so the pairing survives sorting.
 */
async function ingestMap(
  sourceFiles: string[],
  opts: { projectRoot?: string; policyHash: string; ffmpegVersion: string },
): Promise<IngestShard[]> {
  const shards: IngestShard[] = [];
  for (const file of sourceFiles) {
    try {
      const asset = await ingestAsset(file, {
        projectRoot: opts.projectRoot,
        policyHash: opts.policyHash,
        ffmpegVersion: opts.ffmpegVersion,
      });
      shards.push({ sourceFile: file, asset });
    } catch (err) {
      console.error(`[ingest.map] Failed to ingest ${file}:`, err);
    }
  }
  return shards;
}

/**
 * Stage 2: ingest.reduce — write canonical assets.json.
 * Also returns the asset_id → sourceFile map for downstream stages.
 */
function ingestReduce(
  shards: IngestShard[],
  projectId: string,
  outputPath: string,
): { assetsJson: AssetsJson; sourceFileMap: Map<string, string> } {
  // Build asset_id → sourceFile map BEFORE sorting, so pairing is preserved
  const sourceFileMap = new Map<string, string>();
  for (const shard of shards) {
    sourceFileMap.set(shard.asset.asset_id, shard.sourceFile);
  }

  // Sort by asset_id for determinism
  const sorted = [...shards]
    .sort((a, b) => a.asset.asset_id.localeCompare(b.asset.asset_id))
    .map((s) => s.asset);
  const assetsJson: AssetsJson = {
    project_id: projectId,
    artifact_version: "2.0.0",
    items: sorted,
  };
  atomicWriteJson(outputPath, assetsJson);
  return { assetsJson, sourceFileMap };
}

/** Result from segmentMap including per-asset detector failures. */
interface SegmentMapResult {
  shards: Map<string, SegmentItem[]>;
  /** asset_id → list of detector failure messages */
  detectorFailures: Map<string, string[]>;
}

/**
 * Stage 3: segment.map — run scene detection per asset.
 * Uses sourceFileMap (asset_id → sourceFile) instead of index-based pairing.
 */
async function segmentMap(
  sourceFileMap: Map<string, string>,
  assets: AssetItem[],
  thresholds: QualityThresholds,
  opts: { policyHash: string; ffmpegVersion: string },
): Promise<SegmentMapResult> {
  const shards = new Map<string, SegmentItem[]>();
  const detectorFailures = new Map<string, string[]>();

  for (const asset of assets) {
    const file = sourceFileMap.get(asset.asset_id);
    if (!file) {
      console.error(`[segment.map] No source file for ${asset.asset_id}`);
      continue;
    }
    try {
      const result: SegmentAssetResult = await segmentAsset(file, asset, thresholds, {
        policyHash: opts.policyHash,
        ffmpegVersion: opts.ffmpegVersion,
      });
      shards.set(asset.asset_id, result.segments);
      if (result.detectorFailures.length > 0) {
        detectorFailures.set(asset.asset_id, result.detectorFailures);
      }
    } catch (err) {
      console.error(`[segment.map] Failed to segment ${asset.asset_id}:`, err);
      detectorFailures.set(asset.asset_id, [
        `segment_stage: ${err instanceof Error ? err.message : String(err)}`,
      ]);
    }
  }

  return { shards, detectorFailures };
}

/**
 * Stage 4: segment.reduce — write canonical segments.json + update assets.
 */
function segmentReduce(
  segmentShards: Map<string, SegmentItem[]>,
  assetsJson: AssetsJson,
  segmentsOutputPath: string,
  assetsOutputPath: string,
): { segments: SegmentsJson; assets: AssetsJson } {
  // Flatten all segments, sorted by asset_id then src_in_us
  const allSegments: SegmentItem[] = [];
  for (const segs of segmentShards.values()) {
    allSegments.push(...segs);
  }
  allSegments.sort((a, b) => {
    if (a.asset_id !== b.asset_id) return a.asset_id.localeCompare(b.asset_id);
    return a.src_in_us - b.src_in_us;
  });

  const segmentsJson: SegmentsJson = {
    project_id: assetsJson.project_id,
    artifact_version: "2.0.0",
    items: allSegments,
  };
  atomicWriteJson(segmentsOutputPath, segmentsJson);

  // Update assets with segment info
  for (const asset of assetsJson.items) {
    const assetSegments = segmentShards.get(asset.asset_id) ?? [];
    asset.segments = assetSegments.length;
    asset.segment_ids = assetSegments.map((s) => s.segment_id);
  }
  atomicWriteJson(assetsOutputPath, assetsJson);

  return { segments: segmentsJson, assets: assetsJson };
}

/**
 * Stage 5: derivatives.map — generate contact sheets, posters, filmstrips, waveforms.
 * Uses sourceFileMap (asset_id → sourceFile) instead of index-based pairing.
 */
async function derivativesMap(
  sourceFileMap: Map<string, string>,
  assets: AssetItem[],
  segmentShards: Map<string, SegmentItem[]>,
  outputDir: string,
): Promise<Map<string, DerivativeResults>> {
  const results = new Map<string, DerivativeResults>();

  for (const asset of assets) {
    const file = sourceFileMap.get(asset.asset_id);
    if (!file) {
      console.error(`[derivatives.map] No source file for ${asset.asset_id}`);
      continue;
    }
    const segments = segmentShards.get(asset.asset_id) ?? [];

    try {
      const derivs = await generateAllDerivatives(file, asset, segments, outputDir);
      results.set(asset.asset_id, derivs);
    } catch (err) {
      console.error(`[derivatives.map] Failed for ${asset.asset_id}:`, err);
    }
  }

  return results;
}

/**
 * Stage 6: derivatives.reduce — update assets and segments with derivative refs.
 */
function derivativesReduce(
  derivativeResults: Map<string, DerivativeResults>,
  assetsJson: AssetsJson,
  segmentsJson: SegmentsJson,
  assetsOutputPath: string,
  segmentsOutputPath: string,
): { assets: AssetsJson; segments: SegmentsJson } {
  for (const asset of assetsJson.items) {
    const derivs = derivativeResults.get(asset.asset_id);
    if (!derivs) continue;

    asset.contact_sheet_ids = derivs.contactSheets.map((cs) => cs.contact_sheet_id);
    if (derivs.posterPath) asset.poster_path = derivs.posterPath;
    if (derivs.waveformPath) asset.waveform_path = derivs.waveformPath;
  }
  atomicWriteJson(assetsOutputPath, assetsJson);

  for (const seg of segmentsJson.items) {
    const derivs = derivativeResults.get(seg.asset_id);
    if (!derivs) continue;

    const filmstripPath = derivs.filmstripPaths.get(seg.segment_id);
    if (filmstripPath) seg.filmstrip_path = filmstripPath;
  }
  atomicWriteJson(segmentsOutputPath, segmentsJson);

  return { assets: assetsJson, segments: segmentsJson };
}

// ── Stage 7+8: STT ─────────────────────────────────────────────────

/**
 * Stage 7: stt.map — per-asset audio extraction + STT API call.
 */
async function sttMap(
  sourceFileMap: Map<string, string>,
  assets: AssetItem[],
  projectId: string,
  outputDir: string,
  sttPolicy: SttPolicy,
  alignmentThresholds: TranscriptAlignmentThresholds,
  policyHash: string,
  transcribeFn: TranscribeFn,
): Promise<Map<string, AssetSttResult>> {
  const results = new Map<string, AssetSttResult>();

  for (const asset of assets) {
    // Skip assets without audio
    if (!asset.audio_stream) {
      continue;
    }

    const sourceFile = sourceFileMap.get(asset.asset_id);
    if (!sourceFile) {
      console.error(`[stt.map] No source file for ${asset.asset_id}`);
      continue;
    }

    const result = await processAssetStt({
      sourceFile,
      asset,
      projectId,
      outputDir,
      sttPolicy,
      policyHash,
      alignmentThresholds,
      transcribeFn,
    });
    results.set(asset.asset_id, result);
  }

  return results;
}

/**
 * Stage 8: stt.reduce — write transcript files + update assets.json and segments.json.
 *
 * Per design doc: stt.reduce writes final transcripts/TR_*.json files.
 * Both successful and failed transcript artifacts are persisted.
 */
function sttReduce(
  sttResults: Map<string, AssetSttResult>,
  assetsJson: AssetsJson,
  segmentsJson: SegmentsJson,
  alignmentThresholds: TranscriptAlignmentThresholds,
  assetsOutputPath: string,
  segmentsOutputPath: string,
  outputDir: string,
): { assets: AssetsJson; segments: SegmentsJson } {
  // Write transcript files (both successful and failed)
  const transcriptsDir = path.join(outputDir, "transcripts");
  fs.mkdirSync(transcriptsDir, { recursive: true });

  for (const [, sttResult] of sttResults) {
    const transcriptRef = sttResult.transcript.transcript_ref;
    atomicWriteJson(path.join(transcriptsDir, `${transcriptRef}.json`), sttResult.transcript);
  }

  // Update assets with transcript info
  for (const asset of assetsJson.items) {
    const sttResult = sttResults.get(asset.asset_id);
    if (sttResult && sttResult.success) {
      asset.has_transcript = true;
      asset.transcript_ref = sttResult.transcript.transcript_ref;
    }
    // If no result (no audio), leave has_transcript as false (already default)
  }
  atomicWriteJson(assetsOutputPath, assetsJson);

  // Update segments with transcript excerpts
  for (const seg of segmentsJson.items) {
    const sttResult = sttResults.get(seg.asset_id);
    if (sttResult && sttResult.success && sttResult.transcript.items.length > 0) {
      seg.transcript_excerpt = computeTranscriptExcerpt(
        seg.src_in_us,
        seg.src_out_us,
        sttResult.transcript.items,
        alignmentThresholds,
      );
      seg.transcript_ref = sttResult.transcript.transcript_ref;
    }
  }
  atomicWriteJson(segmentsOutputPath, segmentsJson);

  return { assets: assetsJson, segments: segmentsJson };
}

// ── Stage 9+10: VLM ─────────────────────────────────────────────────

/** Per-segment VLM enrichment result shard. */
export interface VlmShard {
  segment_id: string;
  result: VlmEnrichmentResult;
}

/**
 * Stage 9: vlm.map — per-segment frame sampling + VLM call.
 * Uses mock-injectable VlmFn for testing.
 */
async function vlmMap(
  segments: SegmentItem[],
  vlmPolicy: VlmPolicy,
  samplingPolicy: SamplingPolicy,
  minSegmentDurationUs: number,
  policyHash: string,
  vlmFn: VlmFn,
): Promise<VlmShard[]> {
  const shards: VlmShard[] = [];

  for (const seg of segments) {
    const durationUs = seg.src_out_us - seg.src_in_us;

    // Check skip conditions
    if (shouldSkipVlm(seg.quality_flags, durationUs, minSegmentDurationUs)) {
      continue;
    }

    // Adaptive sampling
    const segType = (seg.segment_type || "general") as SegmentType;
    let fps = getAdaptiveSampleFps(segType, samplingPolicy);

    // Adjust for token budget
    fps = adjustFpsForBudget(
      durationUs,
      fps,
      vlmPolicy.segment_visual_frame_cap,
      vlmPolicy.segment_visual_token_budget_max,
    );

    const frameCount = computeFrameCount(durationUs, fps, vlmPolicy.segment_visual_frame_cap);
    const timestamps = computeSampleTimestamps(seg.src_in_us, seg.src_out_us, frameCount);

    // In real pipeline, frame extraction would happen here via ffmpeg.
    // For the VLM call, we pass timestamp-based "virtual" frame paths.
    // The actual VlmFn implementation handles frame data.
    const framePaths = timestamps.map((ts) => `frame_${ts}.jpg`);

    const transcriptContext = seg.transcript_excerpt || undefined;

    try {
      const result = await enrichSegment(
        vlmFn,
        framePaths,
        seg.src_in_us,
        seg.src_out_us,
        vlmPolicy,
        transcriptContext,
      );
      shards.push({ segment_id: seg.segment_id, result });
    } catch (err) {
      shards.push({
        segment_id: seg.segment_id,
        result: {
          success: false,
          error: `vlm_exception: ${err instanceof Error ? err.message : String(err)}`,
          prompt_hash: computePromptHash(),
          model_alias: vlmPolicy.model_alias,
          model_snapshot: vlmPolicy.model_snapshot,
        },
      });
    }
  }

  return shards;
}

/**
 * Stage 10: vlm.reduce — update segments.json with enrichment fields.
 */
function vlmReduce(
  vlmShards: VlmShard[],
  assetsJson: AssetsJson,
  segmentsJson: SegmentsJson,
  policyHash: string,
  segmentsOutputPath: string,
  assetsOutputPath: string,
): { segments: SegmentsJson; assets: AssetsJson } {
  // Build lookup by segment_id
  const shardMap = new Map<string, VlmShard>();
  for (const shard of vlmShards) {
    shardMap.set(shard.segment_id, shard);
  }

  // Enrich segments
  for (const seg of segmentsJson.items) {
    const shard = shardMap.get(seg.segment_id);
    if (!shard || !shard.result.success || !shard.result.output) continue;

    const out = shard.result.output;

    // Update enrichment fields
    seg.summary = out.summary || seg.summary;
    seg.tags = out.tags.length > 0 ? out.tags : seg.tags;
    seg.quality_flags = out.quality_flags.length > 0
      ? [...new Set([...seg.quality_flags, ...out.quality_flags])]
      : seg.quality_flags;
    seg.interest_points = out.interest_points;

    // Confidence records
    if (!seg.confidence) {
      seg.confidence = {} as SegmentItem["confidence"];
    }
    (seg.confidence as Record<string, unknown>).summary = {
      score: out.confidence.summary,
      source: `${shard.result.model_alias}`,
      status: "ready",
    };
    (seg.confidence as Record<string, unknown>).tags = {
      score: out.confidence.tags,
      source: `${shard.result.model_alias}`,
      status: "ready",
    };
    (seg.confidence as Record<string, unknown>).quality_flags = {
      score: out.confidence.quality_flags,
      source: `${shard.result.model_alias}`,
      status: "ready",
    };

    // Provenance records
    if (!seg.provenance) {
      seg.provenance = {} as SegmentItem["provenance"];
    }
    const vlmProvenance = {
      stage: "vlm",
      method: "gemini_frame_bundle",
      connector_version: VLM_CONNECTOR_VERSION,
      policy_hash: policyHash,
      request_hash: computeVlmRequestHash({
        segment_id: seg.segment_id,
        model_snapshot: shard.result.model_snapshot,
        prompt_hash: shard.result.prompt_hash,
        frame_count: out.interest_points.length,
      }),
      model_alias: shard.result.model_alias,
      model_snapshot: shard.result.model_snapshot,
      prompt_hash: shard.result.prompt_hash,
    };
    (seg.provenance as Record<string, unknown>).summary = vlmProvenance;
    (seg.provenance as Record<string, unknown>).tags = vlmProvenance;
    (seg.provenance as Record<string, unknown>).quality_flags = vlmProvenance;
  }

  // Update asset role_guess based on combined STT + VLM evidence
  for (const asset of assetsJson.items) {
    const assetSegments = segmentsJson.items.filter((s) => s.asset_id === asset.asset_id);
    asset.role_guess = guessAssetRole(
      !!asset.has_transcript,
      assetSegments,
    );
  }

  atomicWriteJson(segmentsOutputPath, segmentsJson);
  atomicWriteJson(assetsOutputPath, assetsJson);

  return { segments: segmentsJson, assets: assetsJson };
}

// ── Gap Report ─────────────────────────────────────────────────────

function buildGapReport(
  assets: AssetItem[],
  segmentShards: Map<string, SegmentItem[]>,
  derivativeResults: Map<string, DerivativeResults>,
  detectorFailures: Map<string, string[]>,
  sttResults?: Map<string, AssetSttResult>,
  vlmShards?: VlmShard[],
): GapReport {
  const entries: GapEntry[] = [];

  for (const asset of assets) {
    // Report detector failures with stderr summaries
    const failures = detectorFailures.get(asset.asset_id);
    if (failures && failures.length > 0) {
      entries.push({
        stage: "segment",
        asset_id: asset.asset_id,
        issue: `detector_failure: ${failures.join("; ")}`,
        severity: "error",
      });
    }

    const segments = segmentShards.get(asset.asset_id);
    if (!segments || segments.length === 0) {
      // Only add no_segments_detected if we haven't already reported a detector failure
      if (!failures || failures.length === 0) {
        entries.push({
          stage: "segment",
          asset_id: asset.asset_id,
          issue: "no_segments_detected",
          severity: "error",
        });
      }
    }

    const derivs = derivativeResults.get(asset.asset_id);
    if (!derivs) {
      entries.push({
        stage: "derivatives",
        asset_id: asset.asset_id,
        issue: "derivatives_not_generated",
        severity: "warning",
      });
    } else {
      if (!derivs.posterPath && asset.video_stream) {
        entries.push({
          stage: "derivatives",
          asset_id: asset.asset_id,
          issue: "poster_not_generated",
          severity: "warning",
        });
      }
    }

    // STT gap entries
    if (sttResults) {
      const sttResult = sttResults.get(asset.asset_id);
      if (asset.audio_stream && !sttResult) {
        entries.push({
          stage: "stt",
          asset_id: asset.asset_id,
          issue: "stt_not_attempted",
          severity: "warning",
        });
      } else if (sttResult && !sttResult.success) {
        entries.push({
          stage: "stt",
          asset_id: asset.asset_id,
          issue: `stt_failed: ${sttResult.error ?? "unknown"}`,
          severity: "error",
        });
      }
    }
  }

  // VLM gap entries — include segment_id and detail fields per design doc
  if (vlmShards) {
    for (const shard of vlmShards) {
      if (!shard.result.success) {
        entries.push({
          stage: "vlm",
          asset_id: shard.segment_id.split("_").slice(1, -1).join("_") || shard.segment_id,
          segment_id: shard.segment_id,
          issue: `vlm_failed: ${shard.result.error ?? "unknown"}`,
          severity: "warning",
          blocking: false,
          retriable: true,
          attempted_at: new Date().toISOString(),
        });
      }
    }
  }

  return { version: "1", entries };
}

// ── Main Pipeline ──────────────────────────────────────────────────

/**
 * Run the full M2 Phase 2 pipeline: ingest → segment → derivatives.
 */
export async function runPipeline(opts: PipelineOptions): Promise<PipelineResult> {
  const absProjectDir = path.resolve(opts.projectDir);
  const outputDir = path.join(absProjectDir, "03_analysis");
  fs.mkdirSync(outputDir, { recursive: true });

  const assetsPath = path.join(outputDir, "assets.json");
  const segmentsPath = path.join(outputDir, "segments.json");
  const gapReportPath = path.join(outputDir, "gap_report.yaml");

  // Resolve policy
  const { resolved: policy } = resolvePolicy(absProjectDir, opts.repoRoot);
  const policyHash = computePolicyHash(policy);
  const thresholds = (policy as Record<string, unknown>)["quality_thresholds"] as QualityThresholds;
  const ffmpegVersion = await getFfmpegVersion();

  // Resolve absolute source file paths
  const sourceFiles = opts.sourceFiles.map((f) => path.resolve(absProjectDir, f));

  // Project ID from directory name
  const projectId = path.basename(absProjectDir);

  // Stage 1+2: Ingest
  const ingestShards = await ingestMap(sourceFiles, {
    projectRoot: absProjectDir,
    policyHash,
    ffmpegVersion,
  });
  const { assetsJson: initialAssetsJson, sourceFileMap } = ingestReduce(
    ingestShards, projectId, assetsPath,
  );
  let assetsJson = initialAssetsJson;

  // Stage 3+4: Segment (uses sourceFileMap for correct asset↔file pairing)
  const segMapResult = await segmentMap(
    sourceFileMap,
    assetsJson.items,
    thresholds,
    { policyHash, ffmpegVersion },
  );
  const segmentShards = segMapResult.shards;
  const segResult = segmentReduce(segmentShards, assetsJson, segmentsPath, assetsPath);
  assetsJson = segResult.assets;
  let segmentsJson = segResult.segments;

  // Stage 5+6: Derivatives (uses sourceFileMap for correct asset↔file pairing)
  const derivativeResults = await derivativesMap(
    sourceFileMap,
    assetsJson.items,
    segmentShards,
    outputDir,
  );
  const derivResult = derivativesReduce(
    derivativeResults,
    assetsJson,
    segmentsJson,
    assetsPath,
    segmentsPath,
  );
  assetsJson = derivResult.assets;
  segmentsJson = derivResult.segments;

  // Stage 7+8: STT (optional — skipped when no audio or when explicitly disabled)
  let sttResults: Map<string, AssetSttResult> | undefined;
  if (!opts.skipStt) {
    const sttPolicy = (policy as Record<string, unknown>)["stt"] as SttPolicy | undefined;
    const qualThresholds = (policy as Record<string, unknown>)["quality_thresholds"] as
      Record<string, unknown> | undefined;

    if (sttPolicy) {
      const alignmentThresholds: TranscriptAlignmentThresholds = {
        transcript_overlap_min_us: (qualThresholds?.transcript_overlap_min_us as number) ?? 250_000,
        transcript_overlap_fraction_min: (qualThresholds?.transcript_overlap_fraction_min as number) ?? 0.25,
      };

      // Use injected transcribeFn if provided (for testing), otherwise create real one
      const transcribeFn = opts.transcribeFn ?? createOpenAiTranscribeFn();

      sttResults = await sttMap(
        sourceFileMap,
        assetsJson.items,
        projectId,
        outputDir,
        sttPolicy,
        alignmentThresholds,
        policyHash,
        transcribeFn,
      );

      const sttReduceResult = sttReduce(
        sttResults,
        assetsJson,
        segmentsJson,
        alignmentThresholds,
        assetsPath,
        segmentsPath,
        outputDir,
      );
      assetsJson = sttReduceResult.assets;
      segmentsJson = sttReduceResult.segments;
    }
  }

  // Stage 9+10: VLM (optional — skipped when explicitly disabled or no vlmFn)
  let vlmShards: VlmShard[] | undefined;
  if (!opts.skipVlm) {
    const vlmPolicy = (policy as Record<string, unknown>)["vlm"] as VlmPolicy | undefined;
    const samplingPolicy = (policy as Record<string, unknown>)["sampling"] as SamplingPolicy | undefined;
    const qualThresholds2 = (policy as Record<string, unknown>)["quality_thresholds"] as
      Record<string, unknown> | undefined;
    const minSegDuration = (qualThresholds2?.min_segment_duration_us as number) ?? 750_000;

    if (vlmPolicy && samplingPolicy && opts.vlmFn) {
      vlmShards = await vlmMap(
        segmentsJson.items,
        vlmPolicy,
        samplingPolicy,
        minSegDuration,
        policyHash,
        opts.vlmFn,
      );

      const vlmReduceResult = vlmReduce(
        vlmShards,
        assetsJson,
        segmentsJson,
        policyHash,
        segmentsPath,
        assetsPath,
      );
      assetsJson = vlmReduceResult.assets;
      segmentsJson = vlmReduceResult.segments;
    }
  }

  // Gap report (includes detector failure reasons + STT + VLM results)
  const gapReport = buildGapReport(
    assetsJson.items, segmentShards, derivativeResults, segMapResult.detectorFailures, sttResults, vlmShards,
  );
  atomicWriteYaml(gapReportPath, gapReport);

  return {
    assetsJson,
    segmentsJson,
    gapReport,
    outputDir,
  };
}
