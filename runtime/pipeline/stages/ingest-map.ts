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
import type { MediaKind } from "../../media/media-kind-registry.js";
import { atomicWriteJson } from "./_util.js";
import type { AssetsJson } from "../pipeline-types.js";

/** A shard binding a source file to its ingested asset. */
export interface IngestShard {
  sourceFile: string;
  asset: AssetItem;
}

export interface IngestFailure {
  sourceFile: string;
  stage: "ingest";
  reason: string;
}

export interface IngestMapResult {
  shards: IngestShard[];
  failures: IngestFailure[];
}

export interface IngestSourceFacts {
  mediaKind: MediaKind;
  contentSha256?: string;
  sizeBytes?: number;
  mtimeMs?: number;
}

/**
 * Truthful ingest API. A failed ffprobe is data returned to the caller rather
 * than a console-only side effect.
 */
export async function ingestMapWithFailures(
  sourceFiles: string[],
  opts: {
    projectRoot?: string;
    policyHash: string;
    ffmpegVersion: string;
    sourceFacts?: ReadonlyMap<string, IngestSourceFacts>;
  },
): Promise<IngestMapResult> {
  const shards: IngestShard[] = [];
  const failures: IngestFailure[] = [];
  for (const file of sourceFiles) {
    try {
      const facts = opts.sourceFacts?.get(file);
      const asset = await ingestAsset(file, {
        projectRoot: opts.projectRoot,
        policyHash: opts.policyHash,
        ffmpegVersion: opts.ffmpegVersion,
        mediaKind: facts?.mediaKind,
        sourceContentSha256: facts?.contentSha256,
        sourceSizeBytes: facts?.sizeBytes,
        sourceMtimeMs: facts?.mtimeMs,
      });
      shards.push({ sourceFile: file, asset });
    } catch (err) {
      failures.push({
        sourceFile: file,
        stage: "ingest",
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return { shards, failures };
}

/**
 * Stage 1: ingest.map — run ffprobe per asset, return per-asset shards.
 * Each shard binds the sourceFile to its asset so the pairing survives sorting.
 */
export async function ingestMap(
  sourceFiles: string[],
  opts: {
    projectRoot?: string;
    policyHash: string;
    ffmpegVersion: string;
    sourceFacts?: ReadonlyMap<string, IngestSourceFacts>;
  },
): Promise<IngestShard[]> {
  const result = await ingestMapWithFailures(sourceFiles, opts);
  for (const failure of result.failures) {
    console.error(`[ingest.map] Failed to ingest ${failure.sourceFile}: ${failure.reason}`);
  }
  return result.shards;
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
