/**
 * Stage 1–2: File enumeration and metadata collection.
 *
 * ingestMap  — run ffprobe per source file, return per-asset shards.
 * ingestReduce — write canonical assets.json, return asset_id → sourceFile map.
 */

import {
  ingestAsset,
  type AssetItem,
} from "../../connectors/ffprobe.js";
import { atomicWriteJson } from "./_util.js";
import type { AssetsJson } from "../pipeline-types.js";

/** A shard binding a source file to its ingested asset. */
export interface IngestShard {
  sourceFile: string;
  asset: AssetItem;
}

/**
 * Stage 1: ingest.map — run ffprobe per asset, return per-asset shards.
 * Each shard binds the sourceFile to its asset so the pairing survives sorting.
 */
export async function ingestMap(
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
export function ingestReduce(
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
