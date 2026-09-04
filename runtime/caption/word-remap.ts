/**
 * Word-level timing remap for caption precision.
 *
 * Uses Groq Whisper word-level timestamps to compute precise
 * caption start/end times within the timeline.
 *
 * Strategy (design doc §7.4):
 * - Primary: word-level timestamps → per-caption precise remap
 * - Fallback: clip/item remap (existing segmenter behavior)
 * - Optional: final_audio_realign adapter (future)
 */

import {
  projectSourceRange,
  type TimelineOffsetMap,
} from "../compiler/timeline-offset-engine.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WordTimestamp {
  word: string;
  start_us: number;
  end_us: number;
  confidence?: number;
}

export interface TranscriptItemWithWords {
  item_id: string;
  start_us: number;
  end_us: number;
  text: string;
  words?: WordTimestamp[];
  word_timing_mode?: "word" | "char" | "none";
}

export interface TimingRemapInput {
  captionId: string;
  text: string;
  transcriptItemIds: string[];
  /** Clip-level timing (fallback) */
  clipTimelineInFrame: number;
  clipTimelineDurationFrames: number;
  clipSrcInUs: number;
  clipSrcOutUs: number;
  clipTimelineInFrameBase: number;
  fps: number;
  assetId?: string;
  segmentId?: string;
  offsetMap?: TimelineOffsetMap;
}

export interface TimingRemapResult {
  timelineInFrame: number;
  timelineDurationFrames: number;
  timingSource: "word_remap" | "clip_item_remap" | "offset_map" | "offset_map_fallback";
  timingConfidence: number;
  sourceWordRefs?: Array<{ word: string; start_us: number; end_us: number; confidence?: number }>;
  clipMapRefs?: string[];
  authority?: "A1" | "legacy-role" | "fallback";
  offsetMapFingerprint?: string;
  fallbackReason?: string;
}

interface NormalizedWordSpan {
  word: WordTimestamp;
  start: number;
  end: number;
}

function normalizeAlignmentText(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/^(?:AI|画面|坂本)[｜|]/u, "")
    .replace(/[\p{P}\p{S}\s\u200B-\u200D\uFEFF]/gu, "")
    .toLowerCase();
}

function dedupeWordsInProviderOrder(words: WordTimestamp[]): WordTimestamp[] {
  const seen = new Set<string>();
  // Provider order is the lexical authority. Boundary words can overlap in
  // time, and sorting those timestamps can scramble Japanese text even when
  // the provider's returned word sequence is correct.
  return words.filter((word) => {
      const key = `${word.start_us}:${word.end_us}:${normalizeAlignmentText(word.word)}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

/**
 * Resolve the subset of referenced words represented by this caption.
 *
 * A long transcript item can be split into several caption cues. Returning
 * every word for every cue makes all cues inherit the full utterance range,
 * which is the source of early, spoiler-like cue changes.
 */
function selectCaptionWords(
  input: TimingRemapInput,
  words: WordTimestamp[],
  referencedItems: TranscriptItemWithWords[],
): WordTimestamp[] | undefined {
  const target = normalizeAlignmentText(input.text);
  if (!target) return undefined;

  const spans: NormalizedWordSpan[] = [];
  let combined = "";
  for (const word of dedupeWordsInProviderOrder(words)) {
    const normalized = normalizeAlignmentText(word.word);
    if (!normalized) continue;
    const start = combined.length;
    combined += normalized;
    spans.push({ word, start, end: combined.length });
  }
  if (!combined || spans.length === 0) return undefined;

  const occurrences: number[] = [];
  let offset = combined.indexOf(target);
  while (offset >= 0) {
    occurrences.push(offset);
    offset = combined.indexOf(target, offset + 1);
  }

  if (occurrences.length === 0) {
    const referencedText = normalizeAlignmentText(referencedItems.map((item) => item.text).join(""));
    if (target === referencedText) return spans.map((span) => span.word);
    return undefined;
  }

  const predictedSourceStartUs = input.clipSrcInUs
    + Math.round((input.clipTimelineInFrame - input.clipTimelineInFrameBase) / input.fps * 1_000_000);
  const candidates = occurrences.map((start) => {
    const end = start + target.length;
    const matched = spans.filter((span) => span.end > start && span.start < end);
    return {
      words: matched.map((span) => span.word),
      distance: matched.length > 0
        ? Math.abs(matched[0].word.start_us - predictedSourceStartUs)
        : Number.POSITIVE_INFINITY,
    };
  }).filter((candidate) => candidate.words.length > 0);
  candidates.sort((a, b) => a.distance - b.distance);
  return candidates[0]?.words;
}

// ---------------------------------------------------------------------------
// Word-level remap
// ---------------------------------------------------------------------------

/**
 * Remap caption timing using word-level timestamps.
 *
 * Finds the word timestamps that correspond to the caption's transcript items,
 * then maps the earliest word start and latest word end to timeline frames.
 */
export function remapWithWordTimestamps(
  input: TimingRemapInput,
  itemsWithWords: Map<string, TranscriptItemWithWords>,
): TimingRemapResult {
  // Collect all words from referenced transcript items
  const allWords: WordTimestamp[] = [];
  const referencedItems: TranscriptItemWithWords[] = [];
  let hasWordTiming = false;

  for (const itemId of input.transcriptItemIds) {
    const item = itemsWithWords.get(itemId);
    if (!item) continue;
    referencedItems.push(item);
    if (item.words && item.words.length > 0 &&
        item.word_timing_mode !== "none") {
      hasWordTiming = true;
      allWords.push(...item.words);
    }
  }

  // Fallback to clip/item remap if no word timestamps
  if (!hasWordTiming || allWords.length === 0) {
    return {
      timelineInFrame: input.clipTimelineInFrame,
      timelineDurationFrames: input.clipTimelineDurationFrames,
      timingSource: "clip_item_remap",
      timingConfidence: 0.5,
    };
  }

  const selectedWords = selectCaptionWords(input, allWords, referencedItems);
  if (!selectedWords || selectedWords.length === 0) {
    return {
      timelineInFrame: input.clipTimelineInFrame,
      timelineDurationFrames: input.clipTimelineDurationFrames,
      timingSource: "clip_item_remap",
      timingConfidence: 0.4,
    };
  }

  // Find earliest and latest word timestamps
  let earliestUs = Infinity;
  let latestUs = -Infinity;
  const sourceWordRefs: Array<{ word: string; start_us: number; end_us: number }> = [];

  for (const word of selectedWords) {
    if (word.start_us < earliestUs) earliestUs = word.start_us;
    if (word.end_us > latestUs) latestUs = word.end_us;
    sourceWordRefs.push({
      word: word.word,
      start_us: word.start_us,
      end_us: word.end_us,
    });
  }

  // Clamp to clip source range
  earliestUs = Math.max(earliestUs, input.clipSrcInUs);
  latestUs = Math.min(latestUs, input.clipSrcOutUs);

  if (earliestUs >= latestUs) {
    // Invalid range after clamping — fallback
    return {
      timelineInFrame: input.clipTimelineInFrame,
      timelineDurationFrames: input.clipTimelineDurationFrames,
      timingSource: "clip_item_remap",
      timingConfidence: 0.3,
    };
  }

  // Map source microseconds to timeline frames
  const offsetStartUs = earliestUs - input.clipSrcInUs;
  const offsetEndUs = latestUs - input.clipSrcInUs;

  const projected = input.offsetMap && input.assetId
    ? projectSourceRange(input.offsetMap, {
        asset_id: input.assetId,
        segment_id: input.segmentId,
        source_start_us: earliestUs,
        source_end_us: latestUs,
        source_word_refs: sourceWordRefs,
      })
    : undefined;
  const usableProjection = projected?.status === "exact" ? projected : undefined;
  const timelineInFrame = usableProjection && usableProjection.segments.length > 0
    ? usableProjection.timeline_in_frame
    : input.clipTimelineInFrameBase + usToFrames(offsetStartUs, input.fps);
  const timelineOutFrame = usableProjection && usableProjection.segments.length > 0
    ? usableProjection.timeline_in_frame + usableProjection.timeline_duration_frames
    : input.clipTimelineInFrameBase + usToFrames(offsetEndUs, input.fps);
  const durationFrames = Math.max(1, timelineOutFrame - timelineInFrame);

  // Confidence based on word-level coverage
  const avgConfidence = selectedWords.reduce(
    (sum, w) => sum + (w.confidence ?? 0.8), 0,
  ) / selectedWords.length;

  return {
    timelineInFrame,
    timelineDurationFrames: durationFrames,
    timingSource: projected && projected.status !== "exact" ? "offset_map_fallback" : projected ? "offset_map" : "word_remap",
    timingConfidence: projected?.confidence !== undefined
      ? Math.min(Math.round(avgConfidence * projected.confidence * 100) / 100, 1)
      : Math.round(avgConfidence * 100) / 100,
    sourceWordRefs,
    clipMapRefs: projected?.clip_map_refs,
    authority: projected?.authority,
    offsetMapFingerprint: input.offsetMap?.fingerprint,
    fallbackReason: projected?.fallback_reason,
  };
}

// ---------------------------------------------------------------------------
// Batch remap for all captions
// ---------------------------------------------------------------------------

export interface CaptionTimingInput {
  captionId: string;
  text: string;
  transcriptItemIds: string[];
  /** Current clip-based timing */
  timelineInFrame: number;
  timelineDurationFrames: number;
}

export interface ClipContext {
  clipId: string;
  assetId: string;
  srcInUs: number;
  srcOutUs: number;
  timelineInFrame: number;
  timelineDurationFrames: number;
  segmentId?: string;
  trackId?: string;
}

/**
 * Remap timing for multiple captions using word-level timestamps.
 * Returns a map of caption_id → TimingRemapResult.
 */
export function batchWordRemap(
  captions: CaptionTimingInput[],
  clips: ClipContext[],
  itemsWithWords: Map<string, TranscriptItemWithWords>,
  fps: number,
  offsetMap?: TimelineOffsetMap,
): Map<string, TimingRemapResult> {
  const results = new Map<string, TimingRemapResult>();

  for (const caption of captions) {
    // Find the clip that contains this caption's timeline position
    const clip = clips.find(
      (c) =>
        caption.timelineInFrame >= c.timelineInFrame &&
        caption.timelineInFrame < c.timelineInFrame + c.timelineDurationFrames,
    );

    if (!clip) {
      // No matching clip — keep current timing
      results.set(caption.captionId, {
        timelineInFrame: caption.timelineInFrame,
        timelineDurationFrames: caption.timelineDurationFrames,
        timingSource: "clip_item_remap",
        timingConfidence: 0.4,
      });
      continue;
    }

    const input: TimingRemapInput = {
      captionId: caption.captionId,
      text: caption.text,
      transcriptItemIds: caption.transcriptItemIds,
      clipTimelineInFrame: caption.timelineInFrame,
      clipTimelineDurationFrames: caption.timelineDurationFrames,
      clipSrcInUs: clip.srcInUs,
      clipSrcOutUs: clip.srcOutUs,
      clipTimelineInFrameBase: clip.timelineInFrame,
      fps,
      assetId: clip.assetId,
      segmentId: clip.segmentId,
      offsetMap,
    };

    results.set(caption.captionId, remapWithWordTimestamps(input, itemsWithWords));
  }

  return results;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function usToFrames(us: number, fps: number): number {
  return Math.round((us / 1_000_000) * fps);
}
