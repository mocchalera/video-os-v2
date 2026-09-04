import { computeNormalizedJsonHash } from "../artifacts/p1-manifest-coverage.js";

export interface CaptionLineage {
  root_id: string;
  parent_ids: string[];
  lineage_hash: string;
}

/** Stable source identity; deliberately excludes output frame/order information. */
export function stableCaptionRootId(input: {
  asset_id: string;
  segment_id: string;
  transcript_item_ids: string[];
  source_start_us: number;
  source_end_us: number;
  semantic_partition: string[];
}): string {
  const hash = computeNormalizedJsonHash({
    asset_id: input.asset_id,
    segment_id: input.segment_id,
    transcript_item_ids: [...input.transcript_item_ids].sort(),
    source_start_us: input.source_start_us,
    source_end_us: input.source_end_us,
    semantic_partition: [...input.semantic_partition],
  });
  return `SC_${hash.slice("sha256:".length, "sha256:".length + 16)}`;
}

export function captionLineage(input: {
  caption_id: string;
  root_id?: string;
  parent_ids?: string[];
  stable_root_id?: string;
  asset_id: string;
  segment_id: string;
  transcript_item_ids: string[];
  text: string;
    operation?: "source" | "split" | "merge" | "migration" | "text_edit" | "timing_edit";
    timeline_in_frame?: number;
    timeline_duration_frames?: number;
}): CaptionLineage {
  const rootId = input.root_id ?? input.stable_root_id ?? input.caption_id;
  const parentIds = [...new Set(input.parent_ids ?? [])].sort();
  return {
    root_id: rootId,
    parent_ids: parentIds,
    lineage_hash: computeNormalizedJsonHash({
      root_id: rootId,
      parent_ids: parentIds,
      asset_id: input.asset_id,
      segment_id: input.segment_id,
      transcript_item_ids: [...input.transcript_item_ids].sort(),
      text: input.text,
      operation: input.operation ?? "source",
      timeline_in_frame: input.timeline_in_frame,
      timeline_duration_frames: input.timeline_duration_frames,
    }),
  };
}

export function migrateCaptionLineage(entry: {
  caption_id: string;
  asset_id: string;
  segment_id: string;
  transcript_item_ids?: string[];
  text: string;
  root_id?: string;
  parent_ids?: string[];
  lineage_hash?: string;
  timeline_in_frame?: number;
  timeline_duration_frames?: number;
}): CaptionLineage {
  if (entry.root_id && entry.parent_ids && entry.lineage_hash) {
    return { root_id: entry.root_id, parent_ids: [...entry.parent_ids], lineage_hash: entry.lineage_hash };
  }
  return captionLineage({
    caption_id: entry.caption_id,
    root_id: entry.root_id,
    parent_ids: entry.parent_ids,
    asset_id: entry.asset_id,
    segment_id: entry.segment_id,
    transcript_item_ids: entry.transcript_item_ids ?? [],
    text: entry.text,
    operation: "migration",
    timeline_in_frame: entry.timeline_in_frame,
    timeline_duration_frames: entry.timeline_duration_frames,
  });
}
