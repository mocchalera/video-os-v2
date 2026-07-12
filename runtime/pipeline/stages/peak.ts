/**
 * Stage 11–12: VLM peak detection (coarse → refine → precision).
 *
 * peakMap    — per-asset coarse pass + per-segment refine/precision.
 * peakReduce — write peak_analysis to segments.json.
 */

import * as path from "node:path";
import { execFile } from "node:child_process";
import type { DerivativeResults } from "../../connectors/ffmpeg-derivatives.js";
import type { SegmentItem } from "../../connectors/ffmpeg-segmenter.js";
import { computeMotionSupportScore } from "../../connectors/ffmpeg-motion.js";
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
} from "../../connectors/vlm-peak-detector.js";
import type { VlmFn } from "../../connectors/gemini-vlm.js";
import { atomicWriteJson } from "./_util.js";
import type { AssetsJson, SegmentsJson } from "../pipeline-types.js";

export interface DegradedPeakSignals {
  motion?: number;
  audio_rms?: number;
  speech_keyword?: string[];
}

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

/**
 * Stage 11: peak.map — per-asset coarse pass + per-segment refine/precision.
 * Uses the same VlmFn as VLM enrichment.
 */
export async function peakMap(
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

      shards.push({ segment_id: seg.segment_id, peak_analysis: peakAnalysis });
    }
  }

  return shards;
}

export async function degradedPeakMap(
  assetsJson: AssetsJson,
  segmentsJson: SegmentsJson,
  sourceFileMap: Map<string, string>,
): Promise<PeakShard[]> {
  const shards: PeakShard[] = [];
  console.log("[peak:fallback] Running degraded peak detection (motion/audio/transcript heuristics)...");

  for (const asset of assetsJson.items) {
    const sourcePath = sourceFileMap.get(asset.asset_id);
    const assetSegments = segmentsJson.items.filter((s) => s.asset_id === asset.asset_id);
    if (assetSegments.length === 0) continue;

    for (const seg of assetSegments) {
      const audioRms = sourcePath && asset.audio_stream
        ? await estimateSegmentAudioRms(sourcePath, seg).catch(() => undefined)
        : undefined;
      const signals = derivePeakSignalsForSegment(seg, audioRms);
      const strength = Math.max(signals.motion ?? 0, signals.audio_rms ?? 0, (signals.speech_keyword?.length ?? 0) > 0 ? 0.75 : 0);

      if (strength < 0.35) continue;

      const timestampUs = Math.round((seg.src_in_us + seg.src_out_us) / 2);
      shards.push({
        segment_id: seg.segment_id,
        peak_analysis: {
          peak_moments: [{
            peak_ref: `PK_${seg.segment_id}_degraded`,
            timestamp_us: timestampUs,
            type: (signals.motion ?? 0) >= (signals.audio_rms ?? 0) ? "action_peak" : "emotional_peak",
            confidence: round3(Math.min(0.85, Math.max(0.35, strength))),
            description: "degraded fallback peak from local motion/audio/speech heuristics",
            source_pass: "degraded_ffmpeg_signals",
          }],
          visual_energy_curve: [
            { timestamp_us: seg.src_in_us, energy: round3(Math.max(0, (signals.motion ?? 0) * 0.6)), source: "degraded_motion_proxy" },
            { timestamp_us: timestampUs, energy: round3(signals.motion ?? strength), source: "degraded_motion_proxy" },
            { timestamp_us: seg.src_out_us, energy: round3(Math.max(0, (signals.motion ?? 0) * 0.6)), source: "degraded_motion_proxy" },
          ],
          support_signals: {
            motion_support_score: round3(signals.motion ?? 0),
            audio_support_score: round3(signals.audio_rms ?? 0),
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
): Promise<number | undefined> {
  const startSec = segment.src_in_us / 1_000_000;
  const durationSec = Math.max(0.1, segment.duration_us / 1_000_000);
  const { stderr } = await execFilePromise("ffmpeg", [
    "-v", "info",
    "-ss", String(startSec),
    "-t", String(durationSec),
    "-i", sourcePath,
    "-vn",
    "-af", "astats=metadata=1:reset=1",
    "-f", "null",
    "-",
  ]);
  const matches = [...stderr.matchAll(/RMS level dB:\s*(-?\d+(?:\.\d+)?)/g)];
  const last = matches.at(-1)?.[1];
  if (!last) return undefined;
  const db = Number.parseFloat(last);
  if (!Number.isFinite(db)) return undefined;
  return Math.max(0, Math.min(1, (db + 60) / 60));
}

function execFilePromise(
  cmd: string,
  args: string[],
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 50 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err && !stderr) {
        reject(err);
        return;
      }
      resolve({ stdout: stdout ?? "", stderr: stderr ?? "" });
    });
  });
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/**
 * Stage 12: peak.reduce — write peak_analysis to segments.json.
 */
export function peakReduce(
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
