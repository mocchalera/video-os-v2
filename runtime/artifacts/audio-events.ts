import * as path from "node:path";
import {
  CONNECTOR_VERSION,
  computeRequestHash,
  type AssetItem,
} from "../connectors/ffprobe.js";
import {
  detectSilenceRegionsStrict,
  type QualityThresholds,
  type TimeRange,
} from "../connectors/ffmpeg-segmenter.js";
import { atomicWriteJson } from "../pipeline/stages/_util.js";

export const AUDIO_EVENTS_RELATIVE_PATH = "03_analysis/audio_events.json";

export interface AudioEventItem {
  event_id: string;
  asset_id: string;
  type: "silence";
  start_us: number;
  end_us: number;
  label: string;
  confidence: { score: number; source: string; status: "ready" };
  provenance: {
    stage: string;
    method: string;
    connector_version: string;
    policy_hash: string;
    request_hash: string;
    ffmpeg_version?: string;
  };
}

export interface AudioEventsArtifact {
  project_id: string;
  artifact_version: "analysis-v1";
  items: AudioEventItem[];
}

export interface BuildAudioEventsResult {
  artifact: AudioEventsArtifact;
  failures: Map<string, string>;
  attemptedAssetIds: string[];
}

export async function buildCurrentAudioEvents(options: {
  projectId: string;
  assets: AssetItem[];
  sourceFileMap: Map<string, string>;
  thresholds: QualityThresholds;
  policyHash: string;
  ffmpegVersion?: string;
}): Promise<BuildAudioEventsResult> {
  const items: AudioEventItem[] = [];
  const failures = new Map<string, string>();
  const attemptedAssetIds: string[] = [];
  for (const asset of [...options.assets].sort((a, b) => a.asset_id.localeCompare(b.asset_id))) {
    if (!asset.audio_stream) continue;
    attemptedAssetIds.push(asset.asset_id);
    const sourcePath = options.sourceFileMap.get(asset.asset_id);
    if (!sourcePath) {
      failures.set(asset.asset_id, "source_file_missing");
      continue;
    }
    let ranges: TimeRange[];
    try {
      ranges = normalizeRanges(
        await detectSilenceRegionsStrict(sourcePath, options.thresholds),
        asset.duration_us,
      );
    } catch {
      failures.set(asset.asset_id, "silencedetect_failed");
      continue;
    }
    ranges.forEach((range, index) => {
      items.push({
        event_id: `AE_${asset.asset_id}_SILENCE_${String(index + 1).padStart(4, "0")}`,
        asset_id: asset.asset_id,
        type: "silence",
        start_us: range.start_us,
        end_us: range.end_us,
        label: "ffmpeg silencedetect interval",
        confidence: { score: 1, source: "ffmpeg_silencedetect", status: "ready" },
        provenance: {
          stage: "audio_events",
          method: "ffmpeg_silencedetect",
          connector_version: CONNECTOR_VERSION,
          policy_hash: options.policyHash,
          request_hash: computeRequestHash({
            asset_id: asset.asset_id,
            event_ordinal: index + 1,
            start_us: range.start_us,
            end_us: range.end_us,
            silence_noise_db: options.thresholds.silencedetect_noise_db,
            silence_duration_s: options.thresholds.silencedetect_duration_s,
          }),
          ...(options.ffmpegVersion ? { ffmpeg_version: options.ffmpegVersion } : {}),
        },
      });
    });
  }
  return {
    artifact: { project_id: options.projectId, artifact_version: "analysis-v1", items },
    failures,
    attemptedAssetIds,
  };
}

export function writeAudioEvents(projectDir: string, artifact: AudioEventsArtifact): string {
  const outputPath = path.join(projectDir, AUDIO_EVENTS_RELATIVE_PATH);
  atomicWriteJson(outputPath, artifact);
  return outputPath;
}

function normalizeRanges(ranges: TimeRange[], durationUs: number): TimeRange[] {
  const clamped = ranges
    .map((range) => ({
      start_us: clamp(range.start_us, 0, durationUs),
      end_us: clamp(range.end_us, 0, durationUs),
    }))
    .filter((range) => range.end_us > range.start_us)
    .sort((a, b) => a.start_us - b.start_us || a.end_us - b.end_us);
  const merged: TimeRange[] = [];
  for (const range of clamped) {
    const previous = merged[merged.length - 1];
    if (previous && range.start_us <= previous.end_us) previous.end_us = Math.max(previous.end_us, range.end_us);
    else merged.push({ ...range });
  }
  return merged;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.round(value)));
}
