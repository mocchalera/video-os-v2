/**
 * Stage 11–12: VLM peak detection (coarse → refine → precision).
 *
 * peakMap    — per-asset coarse pass + per-segment refine/precision.
 * peakReduce — write peak_analysis to segments.json.
 */

import * as path from "node:path";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import type { DerivativeResults } from "../../connectors/ffmpeg-derivatives.js";
import type { SegmentItem } from "../../connectors/ffmpeg-segmenter.js";
import { computeMotionSupportScore, hasPositiveMotionContrast } from "../../connectors/ffmpeg-motion.js";
import {
  type PeakAnalysis,
  type PeakDetectionPolicy,
  type TileMapEntry,
  type CoarseLocator,
  runCoarsePass,
  mapCoarseToSegments,
  generateFilmstripTileMap,
  runRefinePass,
  runPrecisionPass,
  shouldRunPrecision,
  fusePeakConfidence,
  buildPeakAnalysis,
  computePrecisionPromptHash,
  PEAK_DETECTOR_VERSION,
  PRECISION_PROMPT_TEMPLATE_ID,
} from "../../connectors/vlm-peak-detector.js";
import type { VlmFn } from "../../connectors/gemini-vlm.js";
import { atomicWriteJson } from "./_util.js";
import {
  extractGroundedFrames,
  GROUNDED_FRAME_CACHE_VERSION,
  GROUNDED_FRAME_PRODUCER_VERSION,
  inspectGroundedFrameCache,
  isVerifiedImagePath,
} from "./grounded-frames.js";
import { SourceContentIdentityCache } from "../../source-content-identity.js";
import type { AssetsJson, SegmentsJson } from "../pipeline-types.js";
import { mapWithConcurrency } from "./vlm.js";
import { hasTemporalVideo } from "../../artifacts/source-media-capabilities.js";

export interface DegradedPeakSignals {
  motion?: number;
  audio_rms?: number;
  speech_keyword?: string[];
}

/** Measured audio evidence used by the degraded visual-peak fallback. */
export interface DegradedAudioMeasurement {
  score: number;
  timestamp_us?: number;
}

/** Existing meaningful-support cutoff for degraded peak materialization. */
export const DEGRADED_PEAK_MEANINGFUL_SUPPORT_THRESHOLD = 0.35;

export interface ResolvedMotionSupport {
  score: number;
  measured: boolean;
  fallback_reason?: string;
}

/** Per-segment peak detection result shard. */
export interface PeakShard {
  segment_id: string;
  peak_analysis?: PeakAnalysis;
  error?: string;
}

export type AudioRmsExecFileLike = (
  command: string,
  args: string[],
  options: { maxBuffer: number },
  callback: (error: Error | null, stdout: string, stderr: string) => void,
) => Pick<ChildProcess, "kill" | "once">;

export const PEAK_PROVENANCE_SCHEMA_VERSION = "peak-provenance-v2";

export interface PeakCacheContext {
  policyHash?: string;
  sourceIdentityCache?: SourceContentIdentityCache;
  concurrency?: number;
  deadlineAtMs?: number;
  now?: () => number;
}

export class PeakStageDeadlineError extends Error {
  constructor() {
    super("peak stage deadline exceeded");
    this.name = "PeakStageDeadlineError";
  }
}

export function computePeakCachePolicyHash(policy: PeakDetectionPolicy): string {
  return hashJson(policy);
}

/**
 * Stage 11: peak.map — per-asset coarse pass + per-segment refine/precision.
 * Uses the same VlmFn as VLM enrichment.
 */
export async function peakMap(
  assetsJson: AssetsJson,
  segmentsJson: SegmentsJson,
  derivativeResults: Map<string, DerivativeResults>,
  sourceFileMap: Map<string, string>,
  vlmFn: VlmFn,
  policy: PeakDetectionPolicy,
  outputDir: string,
  contentHint?: string,
  cacheContext: PeakCacheContext = {},
): Promise<PeakShard[]> {
  const sourceIdentityCache = cacheContext.sourceIdentityCache ?? new SourceContentIdentityCache();
  const policyHash = cacheContext.policyHash ?? computePeakCachePolicyHash(policy);
  const now = cacheContext.now ?? Date.now;
  const assertWithinDeadline = (): void => {
    if (cacheContext.deadlineAtMs !== undefined && now() >= cacheContext.deadlineAtMs) {
      throw new PeakStageDeadlineError();
    }
  };
  async function analyzeAsset(asset: AssetsJson["items"][number]): Promise<PeakShard[]> {
    assertWithinDeadline();
    const shards: PeakShard[] = [];
    const derivs = derivativeResults.get(asset.asset_id);
    if (!derivs || derivs.contactSheets.length === 0) return shards;

    const assetSegments = segmentsJson.items.filter(
      (s) => s.asset_id === asset.asset_id,
    );
    if (assetSegments.length === 0) return shards;

    // Use the first overview contact sheet (preferred) or shot_keyframes
    const overviewCS = derivs.contactSheets.find((cs) => cs.mode === "overview")
      ?? derivs.contactSheets[0];

    // Build tile map for coarse pass
    const tileMap: TileMapEntry[] = overviewCS.tile_map.map((t) => ({
      tile_index: t.tile_index,
      rep_frame_us: t.rep_frame_us,
    }));

    const absImagePath = path.resolve(outputDir, overviewCS.image_path);
    if (!isVerifiedImagePath(absImagePath)) {
      for (const segment of assetSegments) {
        shards.push({
          segment_id: segment.segment_id,
          error: `coarse_frame_missing_or_empty:${absImagePath}`,
        });
      }
      return shards;
    }

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
    assertWithinDeadline();

    if (!coarseResult.success) {
      console.warn(`[peak] Coarse pass failed or no candidates for ${asset.asset_id}: ${coarseResult.error ?? "no candidates"}`);
      for (const segment of assetSegments) {
        shards.push({
          segment_id: segment.segment_id,
          error: `coarse_vlm_failed:${coarseResult.error ?? "unknown"}`,
        });
      }
      return shards;
    }
    if (coarseResult.candidates.length === 0) {
      console.warn(`[peak] Coarse pass produced no candidates for ${asset.asset_id}`);
      return shards;
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
      assertWithinDeadline();
      const seg = assetSegments.find((s) => s.segment_id === overlap.segment_id);
      if (!seg) continue;

      const filmstripPath = seg.filmstrip_path
        ? path.resolve(outputDir, seg.filmstrip_path)
        : undefined;
      const refineImagePath = filmstripPath && isVerifiedImagePath(filmstripPath)
        ? filmstripPath
        : absImagePath;
      if (!isVerifiedImagePath(refineImagePath)) {
        shards.push({
          segment_id: seg.segment_id,
          error: `refine_frame_missing_or_empty:${refineImagePath}`,
        });
        continue;
      }

      // Generate tile map for filmstrip (or synthetic if no filmstrip)
      const filmstripTileMap = generateFilmstripTileMap(seg.src_in_us, seg.src_out_us);

      console.log(`[peak] Refine pass: ${seg.segment_id}`);
      const refineResult = await runRefinePass(vlmFn, {
        segment_id: seg.segment_id,
        segment_type: seg.segment_type ?? "general",
        filmstrip_path: refineImagePath,
        src_in_us: seg.src_in_us,
        src_out_us: seg.src_out_us,
        tile_map: filmstripTileMap,
        coarse_hint: overlap.coarse_candidate,
        transcript_excerpt: seg.transcript_excerpt || undefined,
      }, policy);
      assertWithinDeadline();

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
      let precisionFrameCount = 0;
      let precisionSampleTimestampsUs: number[] = [];
      let precisionRequestedSampleTimestampsUs: number[] = [];
      let precisionCacheHits = 0;
      let precisionFrameExtractionFailures: string[] = [];
      const precisionFailures: string[] = [];

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
        assertWithinDeadline();
        console.log(`[peak] Precision pass: ${seg.segment_id}`);
        const precisionFrames = await extractGroundedFrames({
          sourcePath: sourceFileMap.get(asset.asset_id),
          outputDir,
          namespace: "peak_precision_frames",
          assetId: asset.asset_id,
          segmentId: seg.segment_id,
          segmentStartUs: seg.src_in_us,
          segmentEndUs: seg.src_out_us,
          timestampsUs: filmstripTileMap.map((tile) => tile.frame_us),
          sourceIdentityCache,
        });
        assertWithinDeadline();
        precisionFrameCount = precisionFrames.framePaths.length;
        precisionSampleTimestampsUs = precisionFrames.sampleTimestampsUs;
        precisionRequestedSampleTimestampsUs = precisionFrames.requestedSampleTimestampsUs;
        precisionCacheHits = precisionFrames.cacheHits;
        precisionFrameExtractionFailures = precisionFrames.failures;

        if (precisionFrames.framePaths.length === 0) {
          precisionFailures.push(
            `precision_frame_extraction_failed:${precisionFrames.failures.join(";") || "no_verified_frames"}`,
          );
        } else {
          if (precisionFrames.failures.length > 0) {
            precisionFailures.push(
              `precision_frame_extraction_partial:${precisionFrames.failures.join(";")}`,
            );
          }
          const precisionResult = await runPrecisionPass(vlmFn, {
            segment_id: seg.segment_id,
            segment_type: seg.segment_type ?? "general",
            frame_paths: precisionFrames.framePaths,
            frame_timestamps_us: precisionFrames.sampleTimestampsUs,
            window_start_us: seg.src_in_us,
            window_end_us: seg.src_out_us,
            refine_peak_timestamp_us: refineResult.peak_moment.timestamp_us,
          }, policy);
          assertWithinDeadline();

          if (precisionResult.success) {
            precisionPeakMoment = precisionResult.peak_moment;
            precisionRecommendedInOut = precisionResult.recommended_in_out;
          } else {
            precisionFailures.push(`precision_vlm_failed:${precisionResult.error ?? "unknown"}`);
          }
        }
      }

      // Fuse confidence with deterministic ffmpeg motion support when present.
      const motionSupport = resolveMotionSupportForPeak(
        seg,
        refineResult.peak_moment?.timestamp_us,
      );
      const motionSupportScore = motionSupport.score;
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
          motion_support_measured: motionSupport.measured,
          ...(motionSupport.fallback_reason
            ? { motion_support_fallback_reason: motionSupport.fallback_reason }
            : {}),
          audio_support_score: 0.5,
          fused_peak_score: fusedScore,
        },
        precisionMode: policy.peak_precision_mode,
      });
      peakAnalysis.provenance.coarse_frame_count = 1;
      peakAnalysis.provenance.refine_frame_count = 1;
      peakAnalysis.provenance.precision_frame_count = precisionFrameCount;
      peakAnalysis.provenance.precision_sample_timestamps_us = precisionSampleTimestampsUs;
      peakAnalysis.provenance.precision_requested_sample_timestamps_us =
        precisionRequestedSampleTimestampsUs;
      peakAnalysis.provenance.frame_cache_version = GROUNDED_FRAME_CACHE_VERSION;
      peakAnalysis.provenance.frame_producer_version = GROUNDED_FRAME_PRODUCER_VERSION;
      peakAnalysis.provenance.precision_frame_cache_hits = precisionCacheHits;
      const sourceContentSha256 = tryResolveSourceContentSha256(
        sourceFileMap.get(asset.asset_id),
        sourceIdentityCache,
      );
      if (sourceContentSha256) {
        peakAnalysis.provenance.source_content_sha256 = sourceContentSha256;
      }
      peakAnalysis.provenance.segment_src_in_us = seg.src_in_us;
      peakAnalysis.provenance.segment_src_out_us = seg.src_out_us;
      peakAnalysis.provenance.policy_hash = policyHash;
      peakAnalysis.provenance.model_alias = policy.model_alias;
      peakAnalysis.provenance.precision_prompt_template_id = PRECISION_PROMPT_TEMPLATE_ID;
      peakAnalysis.provenance.precision_prompt_hash = computePrecisionPromptHash();
      peakAnalysis.provenance.detector_version = PEAK_DETECTOR_VERSION;
      peakAnalysis.provenance.provenance_schema_version = PEAK_PROVENANCE_SCHEMA_VERSION;
      if (sourceContentSha256) {
        peakAnalysis.provenance.cache_identity = computePeakCacheIdentity(
          seg,
          sourceContentSha256,
          precisionRequestedSampleTimestampsUs,
          policyHash,
          policy,
        );
      }
      peakAnalysis.provenance.cache_decision = precisionCacheHits === precisionRequestedSampleTimestampsUs.length &&
          precisionRequestedSampleTimestampsUs.length > 0
        ? "accepted"
        : "refreshed";
      peakAnalysis.provenance.cache_decision_reasons = precisionRequestedSampleTimestampsUs.length === 0
        ? ["precision_not_requested"]
        : precisionCacheHits === precisionRequestedSampleTimestampsUs.length
        ? ["cache_identity_match", "verified_frame_cache_match"]
        : ["precision_frame_cache_refreshed"];
      if (precisionFrameExtractionFailures.length > 0) {
        peakAnalysis.provenance.precision_frame_extraction_failures =
          precisionFrameExtractionFailures;
      }
      if (precisionFailures.length > 0) {
        peakAnalysis.provenance.precision_failure_reason = precisionFailures.join(";");
      }

      shards.push({
        segment_id: seg.segment_id,
        peak_analysis: peakAnalysis,
        ...(precisionFailures.length > 0 ? { error: precisionFailures.join(";") } : {}),
      });
    }
    return shards;
  }

  const eligibleAssets = assetsJson.items.filter((asset) =>
    asset.media_kind !== "image" && (
      hasTemporalVideo(asset)
      // Legacy unit fixtures/artifacts may have derivative evidence without
      // the newer stream/capability fields; preserve their prior peak path.
      || (!asset.source_capabilities && !asset.video_stream && !asset.audio_stream && asset.contact_sheet_ids.length > 0)
    )
  );
  const shardGroups = cacheContext.deadlineAtMs === undefined
    ? await mapWithConcurrency(eligibleAssets, cacheContext.concurrency ?? 1, analyzeAsset)
    : await mapPeakAssetsUntilDeadline(
        eligibleAssets,
        cacheContext.concurrency ?? 1,
        cacheContext.deadlineAtMs,
        now,
        analyzeAsset,
      );

  return shardGroups.flat();
}

async function mapPeakAssetsUntilDeadline<T, TResult>(
  items: T[],
  concurrency: number,
  deadlineAtMs: number,
  now: () => number,
  worker: (item: T) => Promise<TResult>,
): Promise<TResult[]> {
  if (items.length === 0) return [];
  if (now() >= deadlineAtMs) throw new PeakStageDeadlineError();

  const limit = Number.isFinite(concurrency) && concurrency >= 1
    ? Math.max(1, Math.floor(concurrency))
    : 2;
  const results = new Array<TResult>(items.length);
  let nextIndex = 0;
  let deadlineExceeded = false;

  async function runWorker(): Promise<void> {
    while (!deadlineExceeded && now() < deadlineAtMs) {
      const currentIndex = nextIndex++;
      if (currentIndex >= items.length) return;
      results[currentIndex] = await worker(items[currentIndex]);
    }
  }

  const completion = Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => runWorker()),
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      completion,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          deadlineExceeded = true;
          reject(new PeakStageDeadlineError());
        }, Math.max(0, deadlineAtMs - now()));
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
  return results;
}

export async function degradedPeakMap(
  assetsJson: AssetsJson,
  segmentsJson: SegmentsJson,
  sourceFileMap: Map<string, string>,
  options: {
    deadlineAtMs?: number;
    now?: () => number;
    estimateAudioRms?: (
      sourcePath: string,
      segment: SegmentItem,
    ) => Promise<number | DegradedAudioMeasurement | undefined>;
    audioRmsExecFile?: AudioRmsExecFileLike;
  } = {},
): Promise<PeakShard[]> {
  const shards: PeakShard[] = [];
  const now = options.now ?? Date.now;
  const deadlineReached = (): boolean =>
    options.deadlineAtMs !== undefined && now() >= options.deadlineAtMs;
  if (deadlineReached()) return shards;
  console.log("[peak:fallback] Running degraded peak detection from measured motion/audio signals...");

  for (const asset of assetsJson.items) {
    if (deadlineReached()) break;
    if (asset.media_kind === "image") continue;
    if (!hasTemporalVideo(asset)) continue;
    const sourcePath = sourceFileMap.get(asset.asset_id);
    const assetSegments = segmentsJson.items.filter((s) => s.asset_id === asset.asset_id);
    if (assetSegments.length === 0) continue;

    for (const seg of assetSegments) {
      if (deadlineReached()) return shards;
      const audioMeasurement = sourcePath && asset.audio_stream
        ? options.estimateAudioRms
          ? normalizeDegradedAudioMeasurement(
              await estimateDegradedAudioMeasurementBeforeDeadline(
                options.estimateAudioRms(sourcePath, seg),
                options.deadlineAtMs,
                now,
              ),
              seg,
            )
          : await estimateSegmentAudioRms(
              sourcePath,
              seg,
              options.deadlineAtMs,
              now,
              options.audioRmsExecFile,
            )
        : undefined;
      if (deadlineReached()) return shards;
      // Boundary confidence, transcript keywords, and segment duration are
      // editorial hints, not measured visual/audio support. They must not
      // manufacture a visual peak or supply its timestamp.
      const motionMeasurement = resolveMeasuredMotionSupportForDegradedPeak(seg);
      const motionScore = motionMeasurement?.score ?? 0;
      const audioScore = audioMeasurement?.score ?? 0;
      const strength = Math.max(motionScore, audioScore);
      if (strength < DEGRADED_PEAK_MEANINGFUL_SUPPORT_THRESHOLD) continue;

      // Every degraded peak needs a measured local timestamp. The injected
      // numeric estimator remains a test seam, but cannot authorize a
      // duration-midpoint proxy without a timestamp of its own.
      const timestampUs = motionMeasurement?.timestamp_us ?? audioMeasurement?.timestamp_us;
      if (timestampUs === undefined) continue;
      const signalSource = motionMeasurement
        ? "degraded_motion_measurement"
        : "degraded_audio_measurement";
      shards.push({
        segment_id: seg.segment_id,
        peak_analysis: {
          peak_moments: [{
            peak_ref: `PK_${seg.segment_id}_degraded`,
            timestamp_us: timestampUs,
            type: motionScore >= audioScore ? "action_peak" : "emotional_peak",
            confidence: round3(Math.min(0.85, Math.max(0.35, strength))),
            description: "degraded fallback peak from measured local motion/audio support",
            source_pass: "degraded_ffmpeg_signals",
          }],
          visual_energy_curve: [
            { timestamp_us: seg.src_in_us, energy: round3(Math.max(0, motionScore * 0.6)), source: signalSource },
            { timestamp_us: timestampUs, energy: round3(strength), source: signalSource },
            { timestamp_us: seg.src_out_us, energy: round3(Math.max(0, motionScore * 0.6)), source: signalSource },
          ],
          support_signals: {
            motion_support_score: round3(motionScore),
            motion_support_measured: Boolean(motionMeasurement),
            audio_support_score: round3(audioScore),
            fused_peak_score: round3(strength),
          },
          provenance: {
            coarse_prompt_template_id: "degraded-fallback",
            refine_prompt_template_id: "degraded-fallback",
            precision_mode: "never",
            fusion_version: "degraded-peak-fusion-v1",
            support_signal_version: "ffmpeg-sad-rms-v1",
          },
        },
      });
    }
  }

  console.log(`[peak:fallback] Degraded peak detection: ${shards.length}/${segmentsJson.items.length} segments labeled`);
  return shards;
}

async function estimateDegradedAudioMeasurementBeforeDeadline(
  measurement: Promise<number | DegradedAudioMeasurement | undefined>,
  deadlineAtMs: number | undefined,
  now: () => number,
): Promise<number | DegradedAudioMeasurement | undefined> {
  if (deadlineAtMs === undefined) return measurement.catch(() => undefined);
  const remainingMs = deadlineAtMs - now();
  if (remainingMs <= 0) return undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      measurement.catch(() => undefined),
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), remainingMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function normalizeDegradedAudioMeasurement(
  value: number | DegradedAudioMeasurement | undefined,
  segment: SegmentItem,
): DegradedAudioMeasurement | undefined {
  if (typeof value === "number") {
    return Number.isFinite(value) ? { score: clamp01(value) } : undefined;
  }
  if (!value || typeof value.score !== "number" || !Number.isFinite(value.score)) return undefined;
  const timestampUs = strictLocalTimestamp(value.timestamp_us, segment);
  return {
    score: round3(clamp01(value.score)),
    ...(timestampUs === undefined ? {} : { timestamp_us: timestampUs }),
  };
}

export function peakClaimsVisualPrecision(segment: SegmentItem): boolean {
  return Boolean(
    segment.peak_analysis?.peak_moments.some((moment) => moment.source_pass === "precision_dense_frames") ||
      segment.peak_analysis?.recommended_in_out?.source_pass === "precision_dense_frames",
  );
}

export function inspectPeakPrecisionCache(
  segment: SegmentItem,
  options: {
    sourcePath: string | undefined;
    sourceContentSha256: string | undefined;
    outputDir: string;
    policyHash: string;
    policy: PeakDetectionPolicy;
    sourceIdentityCache?: SourceContentIdentityCache;
  },
): { accepted: boolean; reasons: string[] } {
  if (!peakClaimsVisualPrecision(segment)) return { accepted: true, reasons: ["no_visual_precision_claim"] };
  const provenance = segment.peak_analysis?.provenance;
  if (!provenance) return { accepted: false, reasons: ["precision_provenance_missing"] };
  const reasons: string[] = [];
  const requestedTimestampsUs = generateFilmstripTileMap(segment.src_in_us, segment.src_out_us)
    .map((tile) => tile.frame_us);
  if (!options.sourceContentSha256 || provenance.source_content_sha256 !== options.sourceContentSha256) {
    reasons.push("source_content_mismatch");
  }
  if (provenance.segment_src_in_us !== segment.src_in_us || provenance.segment_src_out_us !== segment.src_out_us) {
    reasons.push("segment_range_mismatch");
  }
  if (provenance.frame_cache_version !== GROUNDED_FRAME_CACHE_VERSION) reasons.push("frame_cache_revision_mismatch");
  if (provenance.frame_producer_version !== GROUNDED_FRAME_PRODUCER_VERSION) reasons.push("frame_producer_revision_mismatch");
  if (typeof provenance.precision_frame_count !== "number" || provenance.precision_frame_count < 1) {
    reasons.push("verified_precision_frame_count_missing");
  }
  if (!sameNumbers(provenance.precision_sample_timestamps_us, provenance.precision_frame_count)) {
    reasons.push("verified_precision_frame_timestamps_mismatch");
  }
  if (!sameExactNumbers(provenance.precision_requested_sample_timestamps_us, requestedTimestampsUs)) {
    reasons.push("requested_timestamps_mismatch");
  }
  if (provenance.policy_hash !== options.policyHash) reasons.push("policy_hash_mismatch");
  if (provenance.model_alias !== options.policy.model_alias) reasons.push("model_alias_mismatch");
  if (provenance.precision_prompt_template_id !== PRECISION_PROMPT_TEMPLATE_ID ||
      provenance.precision_prompt_hash !== computePrecisionPromptHash()) {
    reasons.push("precision_prompt_mismatch");
  }
  if (provenance.detector_version !== PEAK_DETECTOR_VERSION) reasons.push("detector_revision_mismatch");
  if (provenance.provenance_schema_version !== PEAK_PROVENANCE_SCHEMA_VERSION) reasons.push("provenance_schema_mismatch");
  if (options.sourceContentSha256) {
    const expectedIdentity = computePeakCacheIdentity(
      segment,
      options.sourceContentSha256,
      requestedTimestampsUs,
      options.policyHash,
      options.policy,
    );
    if (provenance.cache_identity !== expectedIdentity) reasons.push("cache_identity_mismatch");
  }
  const frameInspection = inspectGroundedFrameCache({
    sourcePath: options.sourcePath,
    outputDir: options.outputDir,
    namespace: "peak_precision_frames",
    assetId: segment.asset_id,
    segmentId: segment.segment_id,
    segmentStartUs: segment.src_in_us,
    segmentEndUs: segment.src_out_us,
    timestampsUs: requestedTimestampsUs,
    requiredTimestampsUs: provenance.precision_sample_timestamps_us ?? [],
    sourceContentSha256: options.sourceContentSha256,
    sourceIdentityCache: options.sourceIdentityCache,
  });
  if (!frameInspection.accepted) reasons.push(...frameInspection.reasons);
  return { accepted: reasons.length === 0, reasons: [...new Set(reasons)] };
}

/**
 * Legacy synthetic-fixture signal adapter. Production degraded detection uses
 * measured signal records directly and intentionally does not use boundary or
 * speech heuristics as visual-peak support.
 */
export function derivePeakSignalsForSegment(
  segment: SegmentItem,
  audioRms?: number,
): DegradedPeakSignals {
  const boundaryScore = segment.confidence?.boundary?.score ?? 0;
  const durationSec = Math.max(0.001, segment.duration_us / 1_000_000);
  const shortActionBoost = durationSec <= 8 ? 0.15 : 0;
  const motion = round3(Math.max(0, Math.min(1, boundaryScore + shortActionBoost)));
  const speech_keyword = extractSpeechKeywords(
    [segment.summary, segment.transcript_excerpt, ...(segment.tags ?? [])].join(" "),
  );
  return {
    ...(motion > 0 ? { motion } : {}),
    ...(audioRms != null ? { audio_rms: round3(audioRms) } : {}),
    ...(speech_keyword.length > 0 ? { speech_keyword } : {}),
  };
}

export function resolveMotionSupportForPeak(
  segment: SegmentItem,
  peakTimestampUs?: number,
): ResolvedMotionSupport {
  if (typeof peakTimestampUs !== "number" || !Number.isFinite(peakTimestampUs)) {
    return {
      score: 0.5,
      measured: false,
      fallback_reason: "peak_timestamp_missing",
    };
  }

  const measurement = segment.visual_quality_measurements;
  if (!measurement?.metrics_measured?.shake || !measurement.shake) {
    return {
      score: 0.5,
      measured: false,
      fallback_reason: measurement?.failure_reason
        ? `visual_quality_measurement_missing:${measurement.failure_reason}`
        : "visual_quality_measurement_missing",
    };
  }

  if (measurement.shake.bins.length === 0) {
    return {
      score: 0.5,
      measured: false,
      fallback_reason: "motion_bins_missing",
    };
  }

  return {
    score: round3(computeMotionSupportScore(measurement.shake.bins, peakTimestampUs)),
    measured: true,
  };
}

function resolveMeasuredMotionSupportForDegradedPeak(
  segment: SegmentItem,
): { score: number; timestamp_us: number } | undefined {
  const measurement = segment.visual_quality_measurements;
  const shake = measurement?.shake;
  if (!measurement?.metrics_measured?.shake || !shake?.measured || shake.bins.length === 0) return undefined;
  if (!Number.isFinite(shake.peak_energy) ||
      shake.peak_energy < DEGRADED_PEAK_MEANINGFUL_SUPPORT_THRESHOLD ||
      !Number.isFinite(shake.peak_timestamp_us)) {
    return undefined;
  }
  if (!hasPositiveMotionContrast(shake.bins, shake.peak_timestamp_us)) return undefined;
  const score = round3(computeMotionSupportScore(shake.bins, shake.peak_timestamp_us));
  if (score < DEGRADED_PEAK_MEANINGFUL_SUPPORT_THRESHOLD) return undefined;
  const timestampUs = strictLocalTimestamp(shake.peak_timestamp_us, segment);
  if (timestampUs === undefined) return undefined;
  return {
    score,
    timestamp_us: timestampUs,
  };
}

function extractSpeechKeywords(text: string): string[] {
  const lower = text.toLowerCase();
  const keywords = [
    ["laugh", /laugh|laughter|smile|笑|笑顔|笑い/],
    ["cheer", /cheer|applause|歓声|応援|拍手|すごい|がんば/],
    ["voice", /voice|speech|speaker|parent|family|声|会話|パパ|ママ/],
    ["success", /success|ride|bicycle|bike|こげ|漕|自転車|成功/],
  ] as const;
  return keywords.filter(([, pattern]) => pattern.test(lower)).map(([label]) => label);
}

async function estimateSegmentAudioRms(
  sourcePath: string,
  segment: SegmentItem,
  deadlineAtMs?: number,
  now: () => number = Date.now,
  execFileImpl: AudioRmsExecFileLike = execFile as unknown as AudioRmsExecFileLike,
): Promise<DegradedAudioMeasurement | undefined> {
  const startSec = segment.src_in_us / 1_000_000;
  const durationSec = Math.max(0.1, segment.duration_us / 1_000_000);
  const { stderr } = await execFilePromise("ffmpeg", [
    "-v", "info",
    "-ss", String(startSec),
    "-t", String(durationSec),
    "-i", sourcePath,
    "-vn",
    "-af", "astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.RMS_level",
    "-f", "null",
    "-",
  ], { deadlineAtMs, now, execFileImpl });
  const measuredSamples = parseAudioRmsSamples(stderr, segment);
  if (measuredSamples.length > 0) {
    return measuredSamples.reduce((loudest, sample) =>
      sample.score > loudest.score ? sample : loudest,
    );
  }

  const matches = [...stderr.matchAll(/RMS level dB:\s*(-?\d+(?:\.\d+)?)/g)];
  const last = matches.at(-1)?.[1];
  if (!last) return undefined;
  const db = Number.parseFloat(last);
  if (!Number.isFinite(db)) return undefined;
  // Older/alternate ffmpeg output can expose only the aggregate RMS. Keep it
  // as measured support for diagnostics, but do not let it create a visual
  // peak without a measured local timestamp.
  return { score: Math.max(0, Math.min(1, (db + 60) / 60)) };
}

function parseAudioRmsSamples(
  stderr: string,
  segment: SegmentItem,
): DegradedAudioMeasurement[] {
  const samples: DegradedAudioMeasurement[] = [];
  let pendingTimestampUs: number | undefined;
  for (const line of stderr.split(/\r?\n/)) {
    const frame = line.match(/pts_time:(-?\d+(?:\.\d+)?)/);
    if (frame) {
      const timestamp = Number.parseFloat(frame[1]);
      pendingTimestampUs = Number.isFinite(timestamp)
        ? strictLocalTimestamp(segment.src_in_us + timestamp * 1_000_000, segment)
        : undefined;
      continue;
    }
    const rms = line.match(/lavfi\.astats\.Overall\.RMS_level=(-?\d+(?:\.\d+)?)/);
    if (!rms || pendingTimestampUs === undefined) continue;
    const db = Number.parseFloat(rms[1]);
    if (Number.isFinite(db)) {
      samples.push({
        score: round3(Math.max(0, Math.min(1, (db + 60) / 60))),
        timestamp_us: pendingTimestampUs,
      });
    }
    pendingTimestampUs = undefined;
  }
  return samples;
}

function execFilePromise(
  cmd: string,
  args: string[],
  options: {
    deadlineAtMs?: number;
    now: () => number;
    execFileImpl: AudioRmsExecFileLike;
  },
): Promise<{ stdout: string; stderr: string }> {
  const remainingMs = options.deadlineAtMs === undefined
    ? undefined
    : options.deadlineAtMs - options.now();
  if (remainingMs !== undefined && remainingMs <= 0) {
    return Promise.resolve({ stdout: "", stderr: "" });
  }
  return new Promise((resolve, reject) => {
    let callbackResult: { error: Error | null; stdout: string; stderr: string } | undefined;
    let closed = false;
    let timedOut = false;
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const finish = (): void => {
      if (settled || !closed || !callbackResult) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (timedOut) {
        resolve({ stdout: "", stderr: "" });
      } else if (callbackResult.error && !callbackResult.stderr) {
        reject(callbackResult.error);
      } else {
        resolve({ stdout: callbackResult.stdout, stderr: callbackResult.stderr });
      }
    };

    let child: Pick<ChildProcess, "kill" | "once">;
    try {
      child = options.execFileImpl(
        cmd,
        args,
        { maxBuffer: 50 * 1024 * 1024 },
        (error, stdout, stderr) => {
          callbackResult = { error, stdout: stdout ?? "", stderr: stderr ?? "" };
          finish();
        },
      );
    } catch (error) {
      reject(error);
      return;
    }
    child.once("close", () => {
      closed = true;
      finish();
    });
    if (remainingMs !== undefined) {
      timer = setTimeout(() => {
        if (settled) return;
        timedOut = true;
        child.kill("SIGKILL");
      }, remainingMs);
    }
  });
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function strictLocalTimestamp(timestampUs: number | undefined, segment: SegmentItem): number | undefined {
  if (typeof timestampUs !== "number" || !Number.isFinite(timestampUs)) return undefined;
  if (timestampUs <= segment.src_in_us || timestampUs >= segment.src_out_us) return undefined;
  const rounded = Math.round(timestampUs);
  return rounded > segment.src_in_us && rounded < segment.src_out_us ? rounded : undefined;
}

function computePeakCacheIdentity(
  segment: SegmentItem,
  sourceContentSha256: string,
  requestedTimestampsUs: number[],
  policyHash: string,
  policy: PeakDetectionPolicy,
): string {
  return createHash("sha256").update(JSON.stringify({
    source_content_sha256: sourceContentSha256,
    segment_id: segment.segment_id,
    segment_src_in_us: segment.src_in_us,
    segment_src_out_us: segment.src_out_us,
    requested_sample_timestamps_us: requestedTimestampsUs,
    policy_hash: policyHash,
    model_alias: policy.model_alias,
    precision_prompt_template_id: PRECISION_PROMPT_TEMPLATE_ID,
    precision_prompt_hash: computePrecisionPromptHash(),
    detector_version: PEAK_DETECTOR_VERSION,
    provenance_schema_version: PEAK_PROVENANCE_SCHEMA_VERSION,
    frame_cache_version: GROUNDED_FRAME_CACHE_VERSION,
    frame_producer_version: GROUNDED_FRAME_PRODUCER_VERSION,
  })).digest("hex");
}

function tryResolveSourceContentSha256(
  sourcePath: string | undefined,
  cache: SourceContentIdentityCache,
): string | undefined {
  if (!sourcePath) return undefined;
  try {
    return cache.resolve(sourcePath).sha256;
  } catch {
    return undefined;
  }
}

function hashJson(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function sameNumbers(values: number[] | undefined, count: number | undefined): boolean {
  return Array.isArray(values) && typeof count === "number" && values.length === count;
}

function sameExactNumbers(values: number[] | undefined, expected: number[]): boolean {
  return Array.isArray(values) && values.length === expected.length &&
    values.every((value, index) => value === expected[index]);
}

/**
 * Stage 12: peak.reduce — write peak_analysis to segments.json.
 */
export function peakReduce(
  peakShards: PeakShard[],
  segmentsJson: SegmentsJson,
  segmentsOutputPath: string,
  assetsJson?: AssetsJson,
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

  if (assetsJson) clearNonTemporalVisualPeakAnalysis(assetsJson, segmentsJson);

  atomicWriteJson(segmentsOutputPath, segmentsJson);
  return segmentsJson;
}

/** Remove stale visual peak artifacts from canonical non-temporal assets. */
export function clearNonTemporalVisualPeakAnalysis(
  assetsJson: AssetsJson,
  segmentsJson: SegmentsJson,
): number {
  const nonTemporalAssetIds = new Set(
    assetsJson.items
      .filter((asset) => isAuthoritativeNonTemporalAsset(asset))
      .map((asset) => asset.asset_id),
  );
  let removed = 0;
  for (const segment of segmentsJson.items) {
    if (!nonTemporalAssetIds.has(segment.asset_id) || segment.peak_analysis === undefined) continue;
    delete segment.peak_analysis;
    removed += 1;
  }
  return removed;
}

function isAuthoritativeNonTemporalAsset(asset: AssetsJson["items"][number]): boolean {
  if (asset.media_kind === "image") return false;
  if (asset.media_kind === "audio") return true;
  const declared = asset.source_capabilities?.has_temporal_video;
  if (typeof declared === "boolean") return !declared;
  // Legacy fixtures without canonical media metadata may still exercise the
  // synthetic peak adapter; only an explicit audio kind is fail-closed here.
  return false;
}
