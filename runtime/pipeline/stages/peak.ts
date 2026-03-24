/**
 * Stage 11–12: VLM peak detection (coarse → refine → precision).
 *
 * peakMap    — per-asset coarse pass + per-segment refine/precision.
 * peakReduce — write peak_analysis to segments.json.
 */

import * as path from "node:path";
import type { DerivativeResults } from "../../connectors/ffmpeg-derivatives.js";
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
