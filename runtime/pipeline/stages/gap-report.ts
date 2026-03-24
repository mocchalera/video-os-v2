/**
 * Gap report generation and cache manifest helpers.
 */

import type { AssetItem } from "../../connectors/ffprobe.js";
import type { SegmentItem } from "../../connectors/ffmpeg-segmenter.js";
import type { DerivativeResults } from "../../connectors/ffmpeg-derivatives.js";
import type { AssetSttResult } from "../../connectors/openai-stt.js";
import type { CacheManifestEntry } from "../analysis-cache.js";
import type { VlmShard } from "./vlm.js";
import type { PeakShard } from "./peak.js";
import type { IngestShard } from "./ingest-map.js";
import type { GapEntry, GapReport } from "../pipeline-types.js";

export function buildGapReport(
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

export function buildManifestEntries(
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
