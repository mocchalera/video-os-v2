/**
 * Caption segmenter: generates caption_source data from transcript artifacts,
 * timeline, and caption policy.
 */

import { cleanupCaptionText } from "./cleanup.js";
import { formatCaption } from "./line-breaker.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CaptionPolicy {
  language: string;
  delivery_mode: "burn_in" | "sidecar" | "both";
  source: "transcript" | "authored" | "none";
  styling_class: string;
}

export interface SpeechCaption {
  caption_id: string;
  asset_id: string;
  segment_id: string;
  timeline_in_frame: number;
  timeline_duration_frames: number;
  text: string;
  transcript_ref: string;
  transcript_item_ids: string[];
  source: "transcript" | "authored";
  styling_class: string;
  metrics: { cps: number; dwell_ms: number };
}

export interface TextOverlay {
  overlay_id: string;
  timeline_in_frame: number;
  timeline_duration_frames: number;
  text: string;
  styling_class: string;
  writing_mode: "horizontal_tb" | "vertical_rl";
  anchor:
    | "top_left"
    | "top_center"
    | "top_right"
    | "center"
    | "bottom_left"
    | "bottom_center"
    | "bottom_right";
  safe_area?: { top: number; right: number; bottom: number; left: number };
  source: "authored";
}

export interface CaptionSource {
  version: string;
  project_id: string;
  base_timeline_version: string;
  caption_policy: CaptionPolicy;
  speech_captions: SpeechCaption[];
  text_overlays: TextOverlay[];
}

export interface LanguageCalibration {
  unit: "character" | "word";
  target_max: number;
  warn: number;
  fail: number;
}

export const LANGUAGE_CALIBRATIONS: Record<string, LanguageCalibration> = {
  ja: { unit: "character", target_max: 4.0, warn: 5.0, fail: 6.0 },
  en: { unit: "character", target_max: 10.0, warn: 12.0, fail: 15.0 },
};

// ---------------------------------------------------------------------------
// Minimal timeline / transcript shapes (avoid importing compiler types)
// ---------------------------------------------------------------------------

interface MinimalClip {
  clip_id: string;
  segment_id: string;
  asset_id: string;
  src_in_us: number;
  src_out_us: number;
  timeline_in_frame: number;
  timeline_duration_frames: number;
  role: string;
}

interface MinimalTrack {
  track_id: string;
  clips: MinimalClip[];
}

interface MinimalTimelineIR {
  project_id?: string;
  timeline_version?: string;
  fps?: number;
  sequence?: {
    fps_num?: number;
    fps_den?: number;
  };
  tracks: {
    video?: MinimalTrack[];
    audio?: MinimalTrack[];
    overlay?: MinimalTrack[];
    caption?: MinimalTrack[];
  };
}

interface TranscriptItem {
  item_id: string;
  speaker: string;
  speaker_key: string;
  start_us: number;
  end_us: number;
  text: string;
  confidence?: number;
  words?: Array<{ word: string; start_us: number; end_us: number }>;
  word_timing_mode?: "word" | "char" | "none";
}

export interface TranscriptArtifact {
  project_id: string;
  artifact_version: string;
  transcript_ref: string;
  asset_id: string;
  items: TranscriptItem[];
  language?: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const GAP_SPLIT_US = 500_000; // 500 ms in microseconds
const MIN_DWELL_MS = 800;
const SENTENCE_END_RE = /[。！？.!?]$/;
const JA_LINE_START_PARTICLES = new Set([
  "は",
  "が",
  "を",
  "に",
  "で",
  "と",
  "も",
  "の",
  "へ",
  "や",
  "か",
]);
const DEFAULT_FPS = 30;

/**
 * Japanese filler patterns — ported from filler_gap_detector.py.
 * Also includes common English fillers for mixed-language transcripts.
 * Matches common speech fillers that should be stripped from captions.
 */
export const FILLER_PATTERN =
  /(?:えーと|えーっと|えっと|えー|あー|うーん|うん|まあ|なんか|あの|その|\buh\b|\bum\b)/gi;

/**
 * Remove Japanese filler words from text.
 * Returns the cleaned text with leading/trailing whitespace trimmed.
 */
export function removeFillers(text: string): string {
  return text.replace(FILLER_PATTERN, "").replace(/\s{2,}/g, " ").trim();
}

/**
 * Check if text consists entirely of filler words (and optional punctuation/whitespace).
 */
export function isFillerOnly(text: string): boolean {
  const cleaned = removeFillers(text);
  // After removing fillers, if only whitespace, punctuation, or empty → filler-only
  return cleaned.replace(/[\s。、,.!?！？・…\-ー]+/g, "").length === 0;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function framesToMs(frames: number, fps: number): number {
  return (frames / fps) * 1000;
}

function computeCps(
  text: string,
  durationMs: number,
  language: string,
): number {
  if (durationMs <= 0) return 0;
  const seconds = durationMs / 1000;
  const cal = LANGUAGE_CALIBRATIONS[language];
  if (cal && cal.unit === "character") {
    return text.length / seconds;
  }
  // word-based (English default)
  const words = text.split(/\s+/).filter((w) => w.length > 0);
  return words.length / seconds;
}

function getMaxCps(language: string): number {
  const cal = LANGUAGE_CALIBRATIONS[language];
  return cal ? cal.fail : 15.0;
}

/**
 * Check if a character is a Japanese line-start particle that should not begin
 * a new caption segment.
 */
function startsWithParticle(text: string): boolean {
  if (text.length === 0) return false;
  return JA_LINE_START_PARTICLES.has(text[0]);
}

// ---------------------------------------------------------------------------
// Core segmentation
// ---------------------------------------------------------------------------

interface PendingItem {
  item: TranscriptItem;
  clip: MinimalClip;
  timelineInFrame: number;
  timelineDurationFrames: number;
}

function segmentItems(
  pending: PendingItem[],
  language: string,
  fps: number,
  maxCps: number,
): PendingItem[][] {
  if (pending.length === 0) return [];

  const segments: PendingItem[][] = [];
  let current: PendingItem[] = [pending[0]];

  for (let i = 1; i < pending.length; i++) {
    const prev = pending[i - 1];
    const cur = pending[i];
    const clipBoundary = prev.clip.clip_id !== cur.clip.clip_id;
    let shouldSplit = clipBoundary;

    // Rule 1: Gap >= 500ms → hard split
    const prevEndUs = prev.item.end_us;
    const curStartUs = cur.item.start_us;
    if (curStartUs - prevEndUs >= GAP_SPLIT_US) {
      shouldSplit = true;
    }

    // Rule 2: Sentence-ending punctuation on previous item
    if (!shouldSplit && SENTENCE_END_RE.test(prev.item.text.trim())) {
      shouldSplit = true;
    }

    // Rule 3: Max CPS exceeded if we add this item to current segment
    if (!shouldSplit) {
      const combinedText = [...current, cur]
        .map((p) => p.item.text)
        .join("");
      const segStart = current[0].timelineInFrame;
      const segEnd =
        cur.timelineInFrame + cur.timelineDurationFrames;
      const segDurationMs = framesToMs(segEnd - segStart, fps);
      const cps = computeCps(combinedText, segDurationMs, language);
      if (cps > maxCps) {
        shouldSplit = true;
      }
    }

    // Rule 4 (Japanese): avoid line-start particles
    if (
      shouldSplit &&
      (language === "ja" || language.startsWith("ja-"))
    ) {
      if (!clipBoundary && startsWithParticle(cur.item.text.trim())) {
        // Don't split here - absorb particle into current segment
        shouldSplit = false;
      }
    }

    if (shouldSplit) {
      segments.push(current);
      current = [cur];
    } else {
      current.push(cur);
    }
  }

  if (current.length > 0) {
    segments.push(current);
  }

  return segments;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Options for filtering and cleaning transcript content during caption generation.
 */
export interface CaptionGenerationOptions {
  /** Speaker keys to exclude (e.g. interviewer speakers). */
  excludeSpeakers?: string[];
  /** If true, remove Japanese filler words from caption text. Default: false. */
  removeFillers?: boolean;
  /** If true, apply deterministic cleanup (acronym rejoin, punctuation normalization). Default: true. */
  deterministicCleanup?: boolean;
  /** If true, apply auto line-breaking per layout policy. Default: false (opt-in). */
  autoLineBreak?: boolean;
  /**
   * Split caption units before layout so no unit exceeds this many characters.
   * Timing for an oversized transcript item is distributed proportionally.
   * Intended for long-form transcript captions where ASR items can span many
   * sentences. Undefined preserves the legacy segmentation contract.
   */
  maxCharsPerCaption?: number;
  /** Override the language CPS split threshold for a delivery profile. */
  maxCps?: number;
  /** Drop clipped edge fragments shorter than this duration. */
  minCaptionDurationMs?: number;
  /** Deterministic project-dictionary replacements applied before splitting. */
  operatorCorrections?: Array<{ from: string; to: string }>;
  /** Canonical names that must not be split across caption lines. */
  protectedTerms?: string[];
  /** Blank frames enforced between adjacent captions. Default: 1. */
  interCaptionGapFrames?: number;
}

function applyOperatorCorrections(
  text: string,
  corrections: Array<{ from: string; to: string }> | undefined,
): string {
  let result = text;
  for (const correction of corrections ?? []) {
    if (!correction.from || correction.from === correction.to) continue;
    result = result.split(correction.from).join(correction.to);
  }
  return result;
}

function preferredChunkEnd(
  text: string,
  start: number,
  maxChars: number,
  language: string,
  protectedTerms: string[],
): number {
  const hardEnd = Math.min(text.length, start + maxChars);
  if (hardEnd >= text.length) return text.length;
  const softStart = start + Math.max(1, Math.floor(maxChars * 0.55));
  const window = text.slice(start, hardEnd);
  const punctuation = [...window.matchAll(/[。！？!?、,]/g)]
    .map((match) => start + (match.index ?? 0) + 1)
    .filter((index) => index >= softStart && !breaksProtectedTerm(text, index, protectedTerms));
  if (punctuation.length > 0) return punctuation[punctuation.length - 1];

  if (language.startsWith("ja") && typeof Intl.Segmenter === "function") {
    const boundaries = [...new Intl.Segmenter("ja", { granularity: "word" }).segment(text)]
      .map((segment) => segment.index)
      .filter((index) => index >= softStart && index <= hardEnd &&
        !breaksProtectedTerm(text, index, protectedTerms));
    if (boundaries.length > 0) return boundaries[boundaries.length - 1];
  }
  return hardEnd;
}

function breaksProtectedTerm(text: string, index: number, protectedTerms: string[]): boolean {
  for (const term of protectedTerms) {
    if (!term) continue;
    let start = text.indexOf(term);
    while (start >= 0) {
      if (index > start && index < start + term.length) return true;
      start = text.indexOf(term, start + term.length);
    }
  }
  return false;
}

function splitPendingItemByCharacters(
  pending: PendingItem,
  maxChars: number,
  language: string,
  protectedTerms: string[],
): PendingItem[] {
  const text = pending.item.text;
  if (text.length <= maxChars) return [pending];

  const chunks: PendingItem[] = [];
  let charStart = 0;
  while (charStart < text.length) {
    const charEnd = preferredChunkEnd(
      text,
      charStart,
      maxChars,
      language,
      protectedTerms,
    );
    const frameStart = Math.round(
      pending.timelineDurationFrames * charStart / text.length,
    );
    const frameEnd = Math.round(
      pending.timelineDurationFrames * charEnd / text.length,
    );
    chunks.push({
      ...pending,
      item: {
        ...pending.item,
        text: text.slice(charStart, charEnd),
      },
      timelineInFrame: pending.timelineInFrame + frameStart,
      timelineDurationFrames: Math.max(1, frameEnd - frameStart),
    });
    charStart = charEnd;
  }
  return chunks;
}

function splitSegmentByCharacters(
  segment: PendingItem[],
  maxChars: number,
  language: string,
  protectedTerms: string[],
): PendingItem[][] {
  if (!Number.isFinite(maxChars) || maxChars < 1) return [segment];

  const result: PendingItem[][] = [];
  let current: PendingItem[] = [];
  let currentLength = 0;

  for (const pending of segment) {
    if (pending.item.text.length > maxChars) {
      if (current.length > 0) result.push(current);
      current = [];
      currentLength = 0;
      result.push(...splitPendingItemByCharacters(
        pending,
        Math.floor(maxChars),
        language,
        protectedTerms,
      ).map((chunk) => [chunk]));
      continue;
    }
    const itemLength = pending.item.text.length;
    if (current.length > 0 && currentLength + itemLength > maxChars) {
      result.push(current);
      current = [];
      currentLength = 0;
    }
    current.push(pending);
    currentLength += itemLength;
  }
  if (current.length > 0) result.push(current);
  return result;
}

export function generateCaptionSource(
  timeline: MinimalTimelineIR,
  transcripts: Map<string, TranscriptArtifact>,
  policy: CaptionPolicy,
  projectId: string,
  baseTimelineVersion: string,
  options?: CaptionGenerationOptions,
): CaptionSource {
  if (policy.source === "none") {
    return {
      version: "1.0",
      project_id: projectId,
      base_timeline_version: baseTimelineVersion,
      caption_policy: policy,
      speech_captions: [],
      text_overlays: [],
    };
  }

  const sequenceFps = timeline.sequence?.fps_num && timeline.sequence?.fps_den
    ? timeline.sequence.fps_num / timeline.sequence.fps_den
    : undefined;
  const fps = timeline.fps ?? sequenceFps ?? DEFAULT_FPS;
  const language = policy.language;
  const maxCps = options?.maxCps ?? getMaxCps(language);

  // Step 1: Prefer canonical A1 audio clips. Compiler timelines mirror the
  // same editorial clip on V1 and A1, so collecting both creates duplicate
  // captions. Fall back to role-based video/audio discovery only when A1 is
  // absent (legacy or hand-authored timelines).
  const dialogueClips: MinimalClip[] = [];

  const a1Tracks = (timeline.tracks.audio ?? []).filter(
    (track) => track.track_id === "A1" && track.clips.length > 0,
  );
  if (a1Tracks.length > 0) {
    dialogueClips.push(...a1Tracks.flatMap((track) => track.clips));
  } else {
    const allTracks = [
      ...(timeline.tracks.video ?? []),
      ...(timeline.tracks.audio ?? []),
    ];
    for (const track of allTracks) {
      for (const clip of track.clips) {
        if (clip.role === "A1" || clip.role === "dialogue") {
          dialogueClips.push(clip);
        }
      }
    }
  }

  dialogueClips.sort((a, b) => a.timeline_in_frame - b.timeline_in_frame);

  // Step 2: For each clip, find matching transcript items
  const allPending: PendingItem[] = [];
  let captionCounter = 0;

  for (const clip of dialogueClips) {
    const transcript = transcripts.get(clip.asset_id);
    if (!transcript) continue;

    // Find items that overlap with the clip's source range
    let matchingItems = transcript.items.filter((item) => {
      const overlapUs = Math.max(
        0,
        Math.min(item.end_us, clip.src_out_us) - Math.max(item.start_us, clip.src_in_us),
      );
      const itemDurationUs = Math.max(1, item.end_us - item.start_us);
      return overlapUs > 0 && overlapUs / itemDurationUs >= 0.25;
    });

    // Filter out excluded speakers (e.g. interviewer)
    if (options?.excludeSpeakers && options.excludeSpeakers.length > 0) {
      const excluded = new Set(options.excludeSpeakers);
      matchingItems = matchingItems.filter(
        (item) =>
          !excluded.has(item.speaker) && !excluded.has(item.speaker_key),
      );
    }

    // Sort by source start time
    matchingItems.sort((a, b) => a.start_us - b.start_us);

    // Map transcript times to timeline frames
    for (const item of matchingItems) {
      // Clamp item to clip source range
      const clampedStartUs = Math.max(item.start_us, clip.src_in_us);
      const clampedEndUs = Math.min(item.end_us, clip.src_out_us);

      // Convert source offset to timeline offset
      const offsetStartUs = clampedStartUs - clip.src_in_us;
      const offsetEndUs = clampedEndUs - clip.src_in_us;

      const timelineInFrame =
        clip.timeline_in_frame + usToFrames(offsetStartUs, fps);
      const timelineOutFrame =
        clip.timeline_in_frame + usToFrames(offsetEndUs, fps);
      const durationFrames = Math.max(1, timelineOutFrame - timelineInFrame);

      allPending.push({
        item: (() => {
          const clipped = clipTranscriptItemToRange(item, clampedStartUs, clampedEndUs);
          return {
            ...clipped,
            text: applyOperatorCorrections(clipped.text, options?.operatorCorrections),
          };
        })(),
        clip,
        timelineInFrame: timelineInFrame,
        timelineDurationFrames: durationFrames,
      });
    }
  }

  // Step 3: Segment into caption units
  const baseSegments = segmentItems(allPending, language, fps, maxCps);
  const segments = options?.maxCharsPerCaption
    ? baseSegments.flatMap((segment) =>
        splitSegmentByCharacters(
          segment,
          options.maxCharsPerCaption!,
          language,
          options.protectedTerms ?? [],
        )
      )
    : baseSegments;

  // Step 4: Build SpeechCaption entries
  const speechCaptions: SpeechCaption[] = [];

  for (let si = 0; si < segments.length; si++) {
    const seg = segments[si];
    if (seg.length === 0) continue;

    captionCounter++;
    const captionId = `SC_${String(captionCounter).padStart(4, "0")}`;

    let text = seg.map((p) => p.item.text).join("");

    // Apply filler removal if enabled
    if (options?.removeFillers) {
      text = removeFillers(text);
    }

    // Apply deterministic cleanup (default: true)
    if (options?.deterministicCleanup !== false) {
      text = cleanupCaptionText(text);
    }

    // Skip segments that are empty or filler-only after cleaning
    if (text.trim().length === 0 || isFillerOnly(text)) {
      continue;
    }

    // Apply auto line-breaking (opt-in to preserve backward compatibility)
    if (options?.autoLineBreak === true) {
      const breakResult = formatCaption(text, language, options?.protectedTerms);
      text = breakResult.lines.join("\n");
    }

    const inFrame = seg[0].timelineInFrame;
    const lastItem = seg[seg.length - 1];
    const outFrame =
      lastItem.timelineInFrame + lastItem.timelineDurationFrames;
    let durationFrames = outFrame - inFrame;

    // Apply minimum dwell time
    const minDwellFrames = Math.ceil((MIN_DWELL_MS / 1000) * fps);
    if (durationFrames < minDwellFrames) {
      // Check if extending would collide with next segment
      const nextSeg = si + 1 < segments.length ? segments[si + 1] : null;
      const maxExtend = nextSeg
        ? nextSeg[0].timelineInFrame - inFrame
        : durationFrames + minDwellFrames; // no limit if last
      durationFrames = Math.min(minDwellFrames, maxExtend);
    }

    if (
      durationFrames <= 0 ||
      (options?.minCaptionDurationMs !== undefined &&
        framesToMs(durationFrames, fps) < options.minCaptionDurationMs)
    ) {
      continue;
    }

    const dwellMs = framesToMs(durationFrames, fps);
    const cps = computeCps(text, dwellMs, language);

    // Determine asset_id and segment_id from first item's clip context
    const firstPending = seg[0];
    const assetId = firstPending.clip.asset_id;
    const segmentId = firstPending.clip.segment_id;
    const transcriptRef = transcripts.get(assetId)?.transcript_ref ?? "";

    speechCaptions.push({
      caption_id: captionId,
      asset_id: assetId,
      segment_id: segmentId,
      timeline_in_frame: inFrame,
      timeline_duration_frames: durationFrames,
      text,
      transcript_ref: transcriptRef,
      transcript_item_ids: seg.map((p) => p.item.item_id),
      source: policy.source as "transcript" | "authored",
      styling_class: policy.styling_class,
      metrics: {
        cps: Math.round(cps * 100) / 100,
        dwell_ms: Math.round(dwellMs),
      },
    });
  }

  const separatedCaptions = enforceCaptionSeparation(
    speechCaptions,
    options?.interCaptionGapFrames ?? 1,
    fps,
    language,
  );

  return {
    version: "1.0",
    project_id: projectId,
    base_timeline_version: baseTimelineVersion,
    caption_policy: policy,
    speech_captions: separatedCaptions,
    text_overlays: [],
  };
}

export function enforceCaptionSeparation(
  captions: SpeechCaption[],
  gapFrames: number,
  fps: number,
  language: string,
): SpeechCaption[] {
  const gap = Math.max(0, Math.floor(gapFrames));
  const result: SpeechCaption[] = [];
  for (let index = 0; index < captions.length; index++) {
    const caption = { ...captions[index], metrics: { ...captions[index].metrics } };
    const next = captions[index + 1];
    if (next) {
      const latestOut = next.timeline_in_frame - gap;
      const currentOut = caption.timeline_in_frame + caption.timeline_duration_frames;
      if (currentOut > latestOut) {
        caption.timeline_duration_frames = latestOut - caption.timeline_in_frame;
      }
    }
    if (caption.timeline_duration_frames <= 0) continue;
    const dwellMs = framesToMs(caption.timeline_duration_frames, fps);
    caption.metrics.dwell_ms = Math.round(dwellMs);
    caption.metrics.cps = Math.round(computeCps(caption.text, dwellMs, language) * 100) / 100;
    result.push(caption);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function usToFrames(us: number, fps: number): number {
  return Math.round((us / 1_000_000) * fps);
}

function clipTranscriptItemToRange(
  item: TranscriptItem,
  clampedStartUs: number,
  clampedEndUs: number,
): TranscriptItem {
  const durationUs = Math.max(1, item.end_us - item.start_us);
  if (clampedStartUs <= item.start_us && clampedEndUs >= item.end_us) {
    return item;
  }

  const startRatio = Math.max(0, (clampedStartUs - item.start_us) / durationUs);
  const endRatio = Math.min(1, (clampedEndUs - item.start_us) / durationUs);
  const startIndex = Math.min(
    item.text.length,
    Math.floor(item.text.length * startRatio),
  );
  const endIndex = Math.max(
    startIndex + 1,
    Math.min(item.text.length, Math.ceil(item.text.length * endRatio)),
  );
  return {
    ...item,
    start_us: clampedStartUs,
    end_us: clampedEndUs,
    text: item.text.slice(startIndex, endIndex),
  };
}
