/**
 * Stage 5–6: Contact sheet, filmstrip, poster, waveform generation.
 *
 * derivativesMap    — generate visual derivatives per asset.
 * derivativesReduce — update assets and segments with derivative refs.
 */

import type { AssetItem } from "../../connectors/ffprobe.js";
import type { SegmentItem } from "../../connectors/ffmpeg-segmenter.js";
import {
  generateAllDerivatives,
  type DerivativeResults,
} from "../../connectors/ffmpeg-derivatives.js";
import { atomicWriteJson } from "./_util.js";
import type { AssetsJson, SegmentsJson } from "../pipeline-types.js";

/**
 * Stage 5: derivatives.map — generate contact sheets, posters, filmstrips, waveforms.
 * Uses sourceFileMap (asset_id → sourceFile) instead of index-based pairing.
 */
export async function derivativesMap(
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
export function derivativesReduce(
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
