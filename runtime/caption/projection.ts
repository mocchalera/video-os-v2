import type { CaptionDraftEntry } from "./editorial.js";
import type { SpeechCaption } from "./segmenter.js";

/** Timing metadata shared by draft, review preview, and approval projections. */
export interface CaptionTimingMetadata {
  source:
    | "word_remap"
    | "clip_item_remap"
    | "offset_map"
    | "offset_map_fallback"
    | "authored_timing_plan"
    | "authored_stt_word_timing"
    | "authored_onset"
    | "authored_section_cue"
    | "authored_unmatched";
  confidence: number;
  sourceWordRefs?: Array<{ word: string; start_us: number; end_us: number; confidence?: number }>;
  clipMapRefs?: string[];
  authority?: "A1" | "legacy-role" | "fallback" | "authored";
  offsetMapFingerprint?: string;
  stale?: boolean;
  triggeredFallback: boolean;
  timelineInFrame: number;
  timelineDurationFrames: number;
}

/** Project a draft/review entry without dropping provenance or timing fields. */
export function projectCaptionEntry(entry: CaptionDraftEntry): SpeechCaption {
  return {
    caption_id: entry.caption_id,
    asset_id: entry.asset_id,
    segment_id: entry.segment_id,
    timeline_in_frame: entry.timeline_in_frame,
    timeline_duration_frames: entry.timeline_duration_frames,
    text: entry.text,
    transcript_ref: entry.transcript_ref,
    transcript_item_ids: [...entry.transcript_item_ids],
    source: entry.source,
    styling_class: entry.styling_class,
    metrics: { ...entry.metrics },
    ...(entry.line_id ? { line_id: entry.line_id } : {}),
    ...(entry.cue_id ? { cue_id: entry.cue_id } : {}),
    ...(entry.root_id ? { root_id: entry.root_id } : {}),
    ...(entry.parent_ids ? { parent_ids: [...entry.parent_ids] } : {}),
    ...(entry.lineage_hash ? { lineage_hash: entry.lineage_hash } : {}),
    ...(entry.timing ? { timing: structuredClone(entry.timing) } : {}),
    ...(entry.reveal_timing ? { reveal_timing: structuredClone(entry.reveal_timing) } : {}),
  };
}
