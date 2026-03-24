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
  extractAudioProxy,
  type AssetSttResult,
  type TranscriptItem,
} from "../connectors/openai-stt.js";
import {
  createGroqTranscribeFn,
  assignSpeakersToUtterances,
  normalizeSpeakerLabels,
} from "../connectors/groq-stt.js";
import {
  diarizeAsset,
  type DiarizeTurn,
  type DiarizeOptions,
} from "../connectors/pyannote-diarizer.js";
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
  computeVlmRequestHash,
  guessAssetRole,
} from "../connectors/gemini-vlm.js";
import {
  type PeakAnalysis,
  type PeakDetectionPolicy,
  type TileMapEntry,
  type CoarseCandidate,
  DEFAULT_PEAK_POLICY,
  PEAK_DETECTOR_VERSION,
  COARSE_PROMPT_TEMPLATE_ID,
  REFINE_PROMPT_TEMPLATE_ID,
  runCoarsePass,
  mapCoarseToSegments,
  generateFilmstripTileMap,
  runRefinePass,
  runPrecisionPass,
  shouldRunPrecision,
  fusePeakConfidence,
  buildPeakAnalysis,
  type CoarseLocator,
} from "../connectors/vlm-peak-detector.js";
import type { ContactSheetManifest } from "../connectors/ffmpeg-derivatives.js";
import { resolvePolicy } from "../policy-resolver.js";
import {
  generateDisplayNames,
  type DisplayNameInput,
} from "./display-name.js";
import {
  createMediaLinks,
  type MediaSourceMapDoc,
} from "../media/source-map.js";
import { runProjectBgmAnalysis } from "../media/bgm-analyzer.js";
import {
  hydrateCachedVlmSegments,
  runParallelVlmAnalysis,
  type VlmAssetRunSummary,
  type VlmProgressReporter,
  type VlmShard,
} from "./vlm-analysis.js";
import { type ProgressTracker } from "../progress.js";
import {
  computeCacheHash,
  loadCacheManifest,
  saveCacheManifest,
  clearCacheManifest,
  lookupCache,
  type CacheManifestEntry,
} from "./analysis-cache.js";

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
  /** Override STT language (ISO-639-1, e.g. "ja") — merged into resolved policy */
  sttLanguageOverride?: string;
  /** Override STT provider: "groq" | "openai" (auto-detected from model_alias if omitted) */
  sttProvider?: string;
  /** Skip pyannote speaker diarization (e.g. when pyannote is not installed) */
  skipDiarize?: boolean;
  /** Injectable diarize function for testing (bypasses real pyannote bridge) */
  diarizeFn?: (audioPath: string, options?: DiarizeOptions) => Promise<DiarizeTurn[]>;
  /** Skip VLM peak detection stage */
  skipPeak?: boolean;
  /** Content hint for VLM recognition accuracy (e.g. "child learning to ride a bicycle") */
  contentHint?: string;
  /** Skip 02_media symlink generation */
  skipMediaLink?: boolean;
  /** Skip canonical 03_analysis/bgm_analysis.json generation */
  skipBgmAnalysis?: boolean;
  /** Max number of assets to analyze concurrently during VLM enrichment */
  vlmConcurrency?: number;
  /** Optional progress hooks for VLM enrichment */
  vlmProgressReporter?: VlmProgressReporter;
  /** Disable analysis cache (always re-analyze everything) */
  noCache?: boolean;
  /** Clear existing cache before analysis */
  clearCache?: boolean;
  /** Optional progress tracker for structured progress reporting */
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

function readJsonIfExists<T>(filePath: string): T | undefined {
  if (!fs.existsSync(filePath)) return undefined;
  return JSON.parse(fs.readFileSync(filePath, "utf-8")) as T;
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

// ── STT Provider Selection ──────────────────────────────────────────

/**
 * Resolve which STT provider to use based on:
 * 1. Explicit provider override from CLI
 * 2. Model alias in analysis policy
 * 3. Available API keys (GROQ_API_KEY → Groq, OPENAI_API_KEY → OpenAI)
 */
export function resolveTranscribeFn(
  sttPolicy: SttPolicy,
  providerOverride?: string,
): { transcribeFn: TranscribeFn; providerName: string } {
  // Explicit override takes priority
  if (providerOverride === "groq") {
    return { transcribeFn: createGroqTranscribeFn(), providerName: "groq-whisper" };
  }
  if (providerOverride === "openai") {
    return { transcribeFn: createOpenAiTranscribeFn(), providerName: "openai" };
  }

  // Infer from model_alias
  const model = sttPolicy.model_alias;
  if (model.startsWith("whisper-large-v3")) {
    return { transcribeFn: createGroqTranscribeFn(), providerName: "groq-whisper" };
  }
  if (model.startsWith("gpt-4o-transcribe")) {
    return { transcribeFn: createOpenAiTranscribeFn(), providerName: "openai" };
  }

  // Fallback: check available API keys
  if (process.env.GROQ_API_KEY) {
    return { transcribeFn: createGroqTranscribeFn(), providerName: "groq-whisper" };
  }
  return { transcribeFn: createOpenAiTranscribeFn(), providerName: "openai" };
}

// ── Stage 7+8: STT ─────────────────────────────────────────────────

/**
 * Stage 7: stt.map — per-asset audio extraction + STT API call + optional diarization.
 *
 * When diarization is enabled (skipDiarize=false) and the STT provider is Groq:
 * 1. processAssetStt runs Groq Whisper (all segments labeled S1)
 * 2. pyannote bridge runs on the same audio proxy → speaker turns
 * 3. Speaker turns are merged with STT utterances via time-overlap matching
 * 4. Labels are normalized to S1, S2, S3... in order of first appearance
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
  diarizeOpts?: {
    skipDiarize: boolean;
    providerName: string;
    diarizeFn?: (audioPath: string, options?: DiarizeOptions) => Promise<DiarizeTurn[]>;
    gapEntries: GapEntry[];
  },
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

    // Diarization sub-stage: merge pyannote speaker turns with Groq STT output
    if (
      result.success &&
      result.transcript.items.length > 0 &&
      diarizeOpts &&
      !diarizeOpts.skipDiarize &&
      diarizeOpts.providerName === "groq-whisper"
    ) {
      try {
        // Extract a separate audio proxy for diarization
        // (processAssetStt cleans up its own tmp dir in a finally block)
        const diaTmpDir = path.join(outputDir, "_diarize_tmp", asset.asset_id);
        fs.mkdirSync(diaTmpDir, { recursive: true });

        console.log(`[diarize] Extracting audio proxy for ${asset.asset_id}...`);
        const wavPath = await extractAudioProxy(sourceFile, diaTmpDir, asset.asset_id);

        {
          console.log(`[diarize] Running pyannote on ${asset.asset_id}...`);

          const diaFn = diarizeOpts.diarizeFn ?? diarizeAsset;
          const turns = await diaFn(wavPath);

          if (turns.length > 0) {
            console.log(`[diarize] ${asset.asset_id}: ${new Set(turns.map(t => t.speaker_id)).size} speakers detected, ${turns.length} turns`);

            // Convert TranscriptItems to SttUtterances for speaker assignment
            const utterances = result.transcript.items.map((item) => ({
              speaker: item.speaker,
              start_us: item.start_us,
              end_us: item.end_us,
              text: item.text,
            }));

            // Assign speakers and normalize labels
            const withSpeakers = assignSpeakersToUtterances(utterances, turns);
            const normalized = normalizeSpeakerLabels(withSpeakers);

            // Update transcript items with diarized speaker labels
            for (let i = 0; i < result.transcript.items.length; i++) {
              result.transcript.items[i].speaker = normalized[i].speaker;
              result.transcript.items[i].speaker_key =
                `${asset.asset_id}:${normalized[i].speaker}`;
            }

            // Record diarization provenance
            const diarization = {
              provider: "pyannote",
              speaker_count: new Set(normalized.map((u) => u.speaker)).size,
              turn_count: turns.length,
            };
            (result.transcript as unknown as Record<string, unknown>).diarization = diarization;
          } else {
            console.warn(`[diarize] ${asset.asset_id}: no speaker turns detected (pyannote may not be available)`);
            if (diarizeOpts.gapEntries) {
              diarizeOpts.gapEntries.push({
                stage: "diarize",
                asset_id: asset.asset_id,
                issue: "diarization_no_turns: pyannote returned no speaker turns",
                severity: "warning",
              });
            }
          }

          // Clean up diarization temp dir
          try {
            fs.rmSync(diaTmpDir, { recursive: true, force: true });
          } catch {
            // Ignore cleanup errors
          }
        }
      } catch (err) {
        console.warn(`[diarize] ${asset.asset_id}: diarization failed: ${err instanceof Error ? err.message : String(err)}`);
        if (diarizeOpts?.gapEntries) {
          diarizeOpts.gapEntries.push({
            stage: "diarize",
            asset_id: asset.asset_id,
            issue: `diarization_failed: ${err instanceof Error ? err.message : String(err)}`,
            severity: "warning",
          });
        }
      }
    }

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

function vlmReduce(
  vlmShards: VlmShard[],
  assetsJson: AssetsJson,
  segmentsJson: SegmentsJson,
  policyHash: string,
  responseFormat: string,
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
      response_format: responseFormat,
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

// ── Stage 11+12: VLM Peak Detection ─────────────────────────────────

/** Per-segment peak detection result shard. */
export interface PeakShard {
  segment_id: string;
  peak_analysis?: PeakAnalysis;
  error?: string;
}

/**
 * Stage 11: peak.map — per-asset coarse pass + per-segment refine/precision.
 * Uses the same VlmFn as VLM enrichment.
 */
async function peakMap(
  assetsJson: AssetsJson,
  segmentsJson: SegmentsJson,
  derivativeResults: Map<string, DerivativeResults>,
  vlmFn: VlmFn,
  policy: PeakDetectionPolicy,
  outputDir: string,
  contentHint?: string,
): Promise<PeakShard[]> {
  const shards: PeakShard[] = [];

  for (const asset of assetsJson.items) {
    const derivs = derivativeResults.get(asset.asset_id);
    if (!derivs || derivs.contactSheets.length === 0) continue;

    const assetSegments = segmentsJson.items.filter(
      (s) => s.asset_id === asset.asset_id,
    );
    if (assetSegments.length === 0) continue;

    // Use the first overview contact sheet (preferred) or shot_keyframes
    const overviewCS = derivs.contactSheets.find((cs) => cs.mode === "overview")
      ?? derivs.contactSheets[0];

    // Build tile map for coarse pass
    const tileMap: TileMapEntry[] = overviewCS.tile_map.map((t) => ({
      tile_index: t.tile_index,
      rep_frame_us: t.rep_frame_us,
    }));

    const absImagePath = path.join(outputDir, overviewCS.image_path);

    // Build transcript context from segment excerpts
    const transcriptContext = assetSegments
      .filter((s) => s.transcript_excerpt)
      .map((s) => s.transcript_excerpt)
      .join(" ")
      .slice(0, 1000) || undefined;

    // Pass 1: Coarse
    console.log(`[peak] Coarse pass: ${asset.asset_id} (${tileMap.length} tiles)`);
    const coarseResult = await runCoarsePass(vlmFn, {
      asset_id: asset.asset_id,
      contact_sheet_id: overviewCS.contact_sheet_id,
      image_path: absImagePath,
      tile_map: tileMap,
      transcript_context: contentHint
        ? `Content: ${contentHint}. ${transcriptContext ?? ""}`
        : transcriptContext,
    }, policy);

    if (!coarseResult.success || coarseResult.candidates.length === 0) {
      console.warn(`[peak] Coarse pass failed or no candidates for ${asset.asset_id}: ${coarseResult.error ?? "no candidates"}`);
      continue;
    }

    console.log(`[peak] Coarse candidates: ${coarseResult.candidates.length} for ${asset.asset_id}`);

    // Map coarse candidates to overlapping segments
    const overlaps = mapCoarseToSegments(
      coarseResult.candidates,
      tileMap,
      assetSegments.map((s) => ({
        segment_id: s.segment_id,
        src_in_us: s.src_in_us,
        src_out_us: s.src_out_us,
      })),
    );

    // Pass 2: Refine each overlapping segment
    for (const overlap of overlaps) {
      const seg = assetSegments.find((s) => s.segment_id === overlap.segment_id);
      if (!seg) continue;

      const filmstripPath = seg.filmstrip_path
        ? path.join(outputDir, seg.filmstrip_path)
        : undefined;

      // Generate tile map for filmstrip (or synthetic if no filmstrip)
      const filmstripTileMap = generateFilmstripTileMap(seg.src_in_us, seg.src_out_us);

      console.log(`[peak] Refine pass: ${seg.segment_id}`);
      const refineResult = await runRefinePass(vlmFn, {
        segment_id: seg.segment_id,
        segment_type: seg.segment_type ?? "general",
        filmstrip_path: filmstripPath ?? absImagePath,
        src_in_us: seg.src_in_us,
        src_out_us: seg.src_out_us,
        tile_map: filmstripTileMap,
        coarse_hint: overlap.coarse_candidate,
        transcript_excerpt: seg.transcript_excerpt || undefined,
      }, policy);

      if (!refineResult.success) {
        shards.push({
          segment_id: seg.segment_id,
          error: refineResult.error,
        });
        continue;
      }

      // Compute coarse locator from the tile map
      const coarseLocator: CoarseLocator = {
        contact_sheet_id: overviewCS.contact_sheet_id,
        tile_start_index: overlap.coarse_candidate.tile_start_index,
        tile_end_index: overlap.coarse_candidate.tile_end_index,
        coarse_window_start_us: seg.src_in_us,
        coarse_window_end_us: seg.src_out_us,
      };

      // Pass 3: Precision (conditional)
      let precisionPeakMoment = undefined;
      let precisionRecommendedInOut = undefined;

      if (
        refineResult.needs_precision &&
        refineResult.peak_moment &&
        shouldRunPrecision(
          seg.segment_type ?? "general",
          refineResult.needs_precision,
          refineResult.peak_confidence_vlm,
          policy,
        )
      ) {
        console.log(`[peak] Precision pass: ${seg.segment_id}`);
        // Use filmstrip tile map timestamps as frame paths (synthetic)
        const precisionResult = await runPrecisionPass(vlmFn, {
          segment_id: seg.segment_id,
          segment_type: seg.segment_type ?? "general",
          frame_paths: filmstripTileMap.map((t) => `frame_${t.frame_us}.jpg`),
          frame_timestamps_us: filmstripTileMap.map((t) => t.frame_us),
          window_start_us: seg.src_in_us,
          window_end_us: seg.src_out_us,
          refine_peak_timestamp_us: refineResult.peak_moment.timestamp_us,
        }, policy);

        if (precisionResult.success) {
          precisionPeakMoment = precisionResult.peak_moment;
          precisionRecommendedInOut = precisionResult.recommended_in_out;
        }
      }

      // Fuse confidence
      const motionSupportScore = 0.5; // Placeholder — would come from motion analysis
      const fusedScore = refineResult.peak_moment
        ? fusePeakConfidence(
            refineResult.peak_confidence_vlm,
            motionSupportScore,
            undefined,
            refineResult.peak_moment.type,
          )
        : 0;

      // Build final PeakAnalysis
      const peakAnalysis = buildPeakAnalysis({
        coarseLocator,
        refinePeakMoment: refineResult.peak_moment,
        precisionPeakMoment,
        refineRecommendedInOut: refineResult.recommended_in_out,
        precisionRecommendedInOut,
        visualEnergyCurve: refineResult.visual_energy_curve,
        supportSignals: {
          motion_support_score: motionSupportScore,
          audio_support_score: 0.5,
          fused_peak_score: fusedScore,
        },
        precisionMode: policy.peak_precision_mode,
      });

      shards.push({ segment_id: seg.segment_id, peak_analysis: peakAnalysis });
    }
  }

  return shards;
}

/**
 * Stage 12: peak.reduce — write peak_analysis to segments.json.
 */
function peakReduce(
  peakShards: PeakShard[],
  segmentsJson: SegmentsJson,
  segmentsOutputPath: string,
): SegmentsJson {
  const shardMap = new Map<string, PeakShard>();
  for (const shard of peakShards) {
    shardMap.set(shard.segment_id, shard);
  }

  for (const seg of segmentsJson.items) {
    const shard = shardMap.get(seg.segment_id);
    if (!shard || !shard.peak_analysis) continue;
    seg.peak_analysis = shard.peak_analysis;
  }

  atomicWriteJson(segmentsOutputPath, segmentsJson);
  return segmentsJson;
}

// ── Gap Report ─────────────────────────────────────────────────────

function buildGapReport(
  assets: AssetItem[],
  segmentShards: Map<string, SegmentItem[]>,
  derivativeResults: Map<string, DerivativeResults>,
  detectorFailures: Map<string, string[]>,
  sttResults?: Map<string, AssetSttResult>,
  vlmShards?: VlmShard[],
  peakShards?: PeakShard[],
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

  // Peak detection gap entries
  if (peakShards) {
    for (const shard of peakShards) {
      if (shard.error) {
        entries.push({
          stage: "peak_detection",
          asset_id: shard.segment_id.split("_").slice(1, -1).join("_") || shard.segment_id,
          segment_id: shard.segment_id,
          issue: `peak_detection_failed: ${shard.error}`,
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

// ── Cache Helpers ──────────────────────────────────────────────────

function buildManifestEntries(
  shards: IngestShard[],
  hashMap: Map<string, string>,
): CacheManifestEntry[] {
  const now = new Date().toISOString();
  return shards.map((shard) => ({
    hash: hashMap.get(shard.asset.asset_id) ?? "",
    asset_id: shard.asset.asset_id,
    cached_at: now,
    source_path: shard.sourceFile,
  }));
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
  const manifestPath = path.join(outputDir, "cache_manifest.json");

  // ── Cache Setup ──
  if (opts.clearCache) {
    clearCacheManifest(manifestPath);
    console.log("[cache] Cache cleared");
  }
  const useCache = !opts.noCache;
  const manifest = useCache ? loadCacheManifest(manifestPath) : [];

  // Load prior analysis data BEFORE pipeline may overwrite files
  const existingAssetsJson = readJsonIfExists<AssetsJson>(assetsPath);
  const existingSegmentsJson = readJsonIfExists<SegmentsJson>(segmentsPath);

  // Resolve policy
  const { resolved: policy } = resolvePolicy(absProjectDir, opts.repoRoot);
  const policyHash = computePolicyHash(policy);
  const thresholds = (policy as Record<string, unknown>)["quality_thresholds"] as QualityThresholds;
  const ffmpegVersion = await getFfmpegVersion();

  // Resolve absolute source file paths
  const sourceFiles = opts.sourceFiles.map((f) => path.resolve(absProjectDir, f));

  // Project ID from directory name
  const projectId = path.basename(absProjectDir);

  // Progress tracking — count stages that will run
  const pt = opts.progressTracker;
  // Base stages: ingest(1) + reduce(2) + segment(3) + derivatives(4) + display_names(5) + finalize(6)
  let totalStages = 6;
  if (!opts.skipStt) totalStages += 1;  // STT
  if (!opts.skipVlm) totalStages += 1;  // VLM
  if (!opts.skipVlm && !opts.skipPeak) totalStages += 1;  // Peak
  pt?.setTotal(totalStages);

  // Stage 1: Ingest (always runs for all files to get asset IDs + durations)
  const allIngestShards = await ingestMap(sourceFiles, {
    projectRoot: absProjectDir,
    policyHash,
    ffmpegVersion,
  });
  pt?.advance();

  // ── Cache Check ──
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
        const priorAsset = existingAssetsJson.items.find(
          (a) => a.asset_id === shard.asset.asset_id,
        );
        if (priorAsset) {
          cacheHitIds.add(shard.asset.asset_id);
          console.log(`[cache hit] ${shard.asset.asset_id}`);
        }
      }
    }
  }

  // Collect prior data for cached assets
  const cachedAssetItems: AssetItem[] = [];
  const cachedSegmentItems: SegmentItem[] = [];
  if (cacheHitIds.size > 0 && existingAssetsJson && existingSegmentsJson) {
    for (const id of cacheHitIds) {
      const pa = existingAssetsJson.items.find((a) => a.asset_id === id);
      if (pa) cachedAssetItems.push(pa);
      cachedSegmentItems.push(
        ...existingSegmentsJson.items.filter((s) => s.asset_id === id),
      );
    }
  }

  const newIngestShards = allIngestShards.filter(
    (s) => !cacheHitIds.has(s.asset.asset_id),
  );
  if (cacheHitIds.size > 0) {
    console.log(`[cache] ${cacheHitIds.size} cached, ${newIngestShards.length} new`);
  }

  // ── All cached — short-circuit ──
  if (newIngestShards.length === 0 && cacheHitIds.size > 0) {
    const assetsJson: AssetsJson = {
      project_id: projectId,
      artifact_version: "2.0.0",
      items: [...cachedAssetItems].sort((a, b) =>
        a.asset_id.localeCompare(b.asset_id),
      ),
    };
    const segmentsJson: SegmentsJson = {
      project_id: projectId,
      artifact_version: "2.0.0",
      items: [...cachedSegmentItems].sort((a, b) => {
        if (a.asset_id !== b.asset_id)
          return a.asset_id.localeCompare(b.asset_id);
        return a.src_in_us - b.src_in_us;
      }),
    };
    atomicWriteJson(assetsPath, assetsJson);
    atomicWriteJson(segmentsPath, segmentsJson);

    const gapReport: GapReport = { version: "1", entries: [] };
    atomicWriteYaml(gapReportPath, gapReport);

    const allSourceFileMap = new Map<string, string>();
    for (const shard of allIngestShards) {
      allSourceFileMap.set(shard.asset.asset_id, shard.sourceFile);
    }

    let mediaSourceMap: MediaSourceMapDoc | undefined;
    let mediaSourceMapPath: string | undefined;
    if (!opts.skipBgmAnalysis) {
      runProjectBgmAnalysis({
        sourceFiles,
        projectDir: absProjectDir,
        projectId,
      });
    }
    if (!opts.skipMediaLink) {
      const mediaLinks = createMediaLinks({
        projectPath: absProjectDir,
        projectId,
        assets: assetsJson.items,
        sourceFileMap: allSourceFileMap,
      });
      mediaSourceMap = mediaLinks.doc;
      mediaSourceMapPath = mediaLinks.sourceMapPath;
    }

    saveCacheManifest(
      manifestPath,
      buildManifestEntries(allIngestShards, cacheHashMap),
    );
    pt?.complete(["assets.json", "segments.json"]);
    return {
      assetsJson,
      segmentsJson,
      gapReport,
      outputDir,
      mediaSourceMap,
      mediaSourceMapPath,
    };
  }

  // Stage 2: Reduce (new assets only)
  const { assetsJson: initialAssetsJson, sourceFileMap } = ingestReduce(
    newIngestShards, projectId, assetsPath,
  );
  let assetsJson = initialAssetsJson;
  pt?.advance("assets.json");

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
  pt?.advance("segments.json");

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
  pt?.advance();

  // Stage 7+8: STT (optional — skipped when no audio or when explicitly disabled)
  let sttResults: Map<string, AssetSttResult> | undefined;
  const diarizeGapEntries: GapEntry[] = [];
  if (!opts.skipStt) {
    const sttPolicy = (policy as Record<string, unknown>)["stt"] as SttPolicy | undefined;
    const qualThresholds = (policy as Record<string, unknown>)["quality_thresholds"] as
      Record<string, unknown> | undefined;

    if (sttPolicy) {
      // Apply language override from CLI if provided
      const effectiveSttPolicy: SttPolicy = opts.sttLanguageOverride
        ? { ...sttPolicy, language: opts.sttLanguageOverride }
        : sttPolicy;

      const alignmentThresholds: TranscriptAlignmentThresholds = {
        transcript_overlap_min_us: (qualThresholds?.transcript_overlap_min_us as number) ?? 250_000,
        transcript_overlap_fraction_min: (qualThresholds?.transcript_overlap_fraction_min as number) ?? 0.25,
      };

      // Use injected transcribeFn if provided (for testing), otherwise resolve from policy
      let transcribeFn: TranscribeFn;
      let providerName: string;
      if (opts.transcribeFn) {
        transcribeFn = opts.transcribeFn;
        providerName = opts.sttProvider ?? "injected";
      } else {
        const resolved = resolveTranscribeFn(effectiveSttPolicy, opts.sttProvider);
        transcribeFn = resolved.transcribeFn;
        providerName = resolved.providerName;
        console.log(`[pipeline] STT provider: ${providerName} (model: ${effectiveSttPolicy.model_alias})`);
      }

      sttResults = await sttMap(
        sourceFileMap,
        assetsJson.items,
        projectId,
        outputDir,
        effectiveSttPolicy,
        alignmentThresholds,
        policyHash,
        transcribeFn,
        {
          skipDiarize: opts.skipDiarize ?? false,
          providerName,
          diarizeFn: opts.diarizeFn,
          gapEntries: diarizeGapEntries,
        },
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
    pt?.advance();
  }

  // Stage 9+10: VLM (optional — skipped when explicitly disabled or no vlmFn)
  let vlmShards: VlmShard[] | undefined;
  let vlmSummary: VlmAssetRunSummary | undefined;
  if (!opts.skipVlm) {
    const vlmPolicy = (policy as Record<string, unknown>)["vlm"] as VlmPolicy | undefined;
    const samplingPolicy = (policy as Record<string, unknown>)["sampling"] as SamplingPolicy | undefined;
    const qualThresholds2 = (policy as Record<string, unknown>)["quality_thresholds"] as
      Record<string, unknown> | undefined;
    const minSegDuration = (qualThresholds2?.min_segment_duration_us as number) ?? 750_000;

    if (vlmPolicy && samplingPolicy) {
      const cachedSegmentIds = hydrateCachedVlmSegments({
        currentSegments: segmentsJson.items,
        cachedSegments: existingSegmentsJson?.items,
        vlmPolicy,
        policyHash,
      });

      vlmShards = [];
      if (opts.vlmFn) {
        const liveVlm = await runParallelVlmAnalysis({
          assets: assetsJson.items,
          segments: segmentsJson.items,
          vlmPolicy,
          samplingPolicy,
          minSegmentDurationUs: minSegDuration,
          vlmFn: opts.vlmFn,
          contentHint: opts.contentHint,
          concurrency: opts.vlmConcurrency,
          reporter: opts.vlmProgressReporter,
          cachedSegmentIds,
        });
        vlmShards = liveVlm.shards;
        vlmSummary = liveVlm.summary;
      }

      if (vlmShards.length > 0 || cachedSegmentIds.size > 0) {
        const vlmReduceResult = vlmReduce(
          vlmShards,
          assetsJson,
          segmentsJson,
          policyHash,
          vlmPolicy.response_format,
          segmentsPath,
          assetsPath,
        );
        assetsJson = vlmReduceResult.assets;
        segmentsJson = vlmReduceResult.segments;
      }
    }
    pt?.advance();
  }

  // Stage 11+12: Peak Detection (optional — requires VLM, not skipped, and derivatives)
  let peakShards: PeakShard[] | undefined;
  if (!opts.skipVlm && !opts.skipPeak && opts.vlmFn) {
    const peakPolicy = (policy as Record<string, unknown>)["peak_detection"] as PeakDetectionPolicy | undefined;
    const effectivePeakPolicy = peakPolicy ?? DEFAULT_PEAK_POLICY;

    console.log("[pipeline] Running VLM peak detection...");
    peakShards = await peakMap(
      assetsJson,
      segmentsJson,
      derivativeResults,
      opts.vlmFn,
      effectivePeakPolicy,
      outputDir,
      opts.contentHint,
    );

    if (peakShards.length > 0) {
      segmentsJson = peakReduce(peakShards, segmentsJson, segmentsPath);
      const peaksFound = peakShards.filter((s) => s.peak_analysis).length;
      console.log(`[pipeline] Peak detection: ${peaksFound}/${peakShards.length} segments enriched`);
    }
    pt?.advance();
  }

  // ── Merge cached data ──
  if (cacheHitIds.size > 0) {
    assetsJson.items.push(...cachedAssetItems);
    assetsJson.items.sort((a, b) => a.asset_id.localeCompare(b.asset_id));
    segmentsJson.items.push(...cachedSegmentItems);
    segmentsJson.items.sort((a, b) => {
      if (a.asset_id !== b.asset_id)
        return a.asset_id.localeCompare(b.asset_id);
      return a.src_in_us - b.src_in_us;
    });
    atomicWriteJson(assetsPath, assetsJson);
    atomicWriteJson(segmentsPath, segmentsJson);

    // Add cached source files for display names + media links
    for (const shard of allIngestShards) {
      if (cacheHitIds.has(shard.asset.asset_id)) {
        sourceFileMap.set(shard.asset.asset_id, shard.sourceFile);
      }
    }
  }

  // Stage 13: display_name generation — assign human-readable names from VLM summaries + creation dates
  const displayNameInputs: DisplayNameInput[] = assetsJson.items
    .filter((asset) => sourceFileMap.has(asset.asset_id))
    .map((asset) => ({
      asset,
      filePath: sourceFileMap.get(asset.asset_id)!,
      segments: segmentsJson.items.filter((s) => s.asset_id === asset.asset_id),
    }));
  const displayNames = generateDisplayNames(displayNameInputs);
  for (const asset of assetsJson.items) {
    const dn = displayNames.get(asset.asset_id);
    if (dn) asset.display_name = dn;
  }
  atomicWriteJson(assetsPath, assetsJson);
  pt?.advance();

  // Gap report — only check new (non-cached) assets
  const newAssetItems = assetsJson.items.filter(
    (a) => !cacheHitIds.has(a.asset_id),
  );
  const gapReport = buildGapReport(
    newAssetItems, segmentShards, derivativeResults, segMapResult.detectorFailures, sttResults, vlmShards, peakShards,
  );
  // Merge diarization gap entries
  gapReport.entries.push(...diarizeGapEntries);
  atomicWriteYaml(gapReportPath, gapReport);

  let mediaSourceMap: MediaSourceMapDoc | undefined;
  let mediaSourceMapPath: string | undefined;
  if (!opts.skipBgmAnalysis) {
    runProjectBgmAnalysis({
      sourceFiles,
      projectDir: absProjectDir,
      projectId,
    });
  }
  if (!opts.skipMediaLink) {
    const mediaLinks = createMediaLinks({
      projectPath: absProjectDir,
      projectId,
      assets: assetsJson.items,
      sourceFileMap,
    });
    mediaSourceMap = mediaLinks.doc;
    mediaSourceMapPath = mediaLinks.sourceMapPath;
    for (const warning of mediaLinks.warnings) {
      console.warn(`[pipeline] ${warning}`);
    }
  }

  // ── Update cache manifest ──
  saveCacheManifest(
    manifestPath,
    buildManifestEntries(allIngestShards, cacheHashMap),
  );

  pt?.complete(["assets.json", "segments.json", "gap_report.yaml"]);

  return {
    assetsJson,
    segmentsJson,
    gapReport,
    outputDir,
    mediaSourceMap,
    mediaSourceMapPath,
    vlmSummary,
  };
}
