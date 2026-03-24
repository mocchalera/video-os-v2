/**
 * Shared pipeline data types used across stage modules.
 */

import type { AssetItem } from "../connectors/ffprobe.js";
import type { SegmentItem } from "../connectors/ffmpeg-segmenter.js";

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
