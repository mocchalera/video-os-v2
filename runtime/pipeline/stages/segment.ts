/**
 * Stage 3–4: Segment splitting (scene detection + reduce).
 *
 * segmentMap    — run scene detection per asset.
 * segmentReduce — write canonical segments.json + update assets.
 */

import {
  segmentAsset,
  type SegmentItem,
  type SegmentAssetResult,
  type QualityThresholds,
} from "../../connectors/ffmpeg-segmenter.js";
import type { AssetItem } from "../../connectors/ffprobe.js";
import { atomicWriteJson } from "./_util.js";
import type { AssetsJson, SegmentsJson } from "../pipeline-types.js";

/** Result from segmentMap including per-asset detector failures. */
export interface SegmentMapResult {
  shards: Map<string, SegmentItem[]>;
  /** asset_id → list of detector failure messages */
  detectorFailures: Map<string, string[]>;
}

/**
 * Stage 3: segment.map — run scene detection per asset.
 * Uses sourceFileMap (asset_id → sourceFile) instead of index-based pairing.
 */
export async function segmentMap(
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
export function segmentReduce(
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
