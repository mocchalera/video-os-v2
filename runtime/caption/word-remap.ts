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
}

export interface TimingRemapResult {
  timelineInFrame: number;
  timelineDurationFrames: number;
  timingSource: "word_remap" | "clip_item_remap";
  timingConfidence: number;
  sourceWordRefs?: Array<{ word: string; start_us: number; end_us: number }>;
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
  let hasWordTiming = false;

  for (const itemId of input.transcriptItemIds) {
    const item = itemsWithWords.get(itemId);
    if (!item) continue;
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

  // Find earliest and latest word timestamps
  let earliestUs = Infinity;
  let latestUs = -Infinity;
  const sourceWordRefs: Array<{ word: string; start_us: number; end_us: number }> = [];

  for (const word of allWords) {
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

  const timelineInFrame = input.clipTimelineInFrameBase +
    usToFrames(offsetStartUs, input.fps);
  const timelineOutFrame = input.clipTimelineInFrameBase +
    usToFrames(offsetEndUs, input.fps);
  const durationFrames = Math.max(1, timelineOutFrame - timelineInFrame);

  // Confidence based on word-level coverage
  const avgConfidence = allWords.reduce(
    (sum, w) => sum + (w.confidence ?? 0.8), 0,
  ) / allWords.length;

  return {
    timelineInFrame,
    timelineDurationFrames: durationFrames,
    timingSource: "word_remap",
    timingConfidence: Math.round(avgConfidence * 100) / 100,
    sourceWordRefs,
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
