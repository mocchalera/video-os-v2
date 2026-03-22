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
  ja: { unit: "character", target_max: 6.0, warn: 7.0, fail: 10.0 },
  en: { unit: "word", target_max: 3.0, warn: 3.5, fail: 4.5 },
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
}

interface TranscriptArtifact {
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
  return cal ? cal.fail : 4.5;
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
    let shouldSplit = false;

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
      if (startsWithParticle(cur.item.text.trim())) {
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

  const fps = timeline.fps ?? DEFAULT_FPS;
  const language = policy.language;
  const maxCps = getMaxCps(language);

  // Step 1: Collect A1 dialogue clips from all video + audio tracks, sorted
  // by timeline position. "A1" role = dialogue audio.
  const dialogueClips: MinimalClip[] = [];

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

  dialogueClips.sort((a, b) => a.timeline_in_frame - b.timeline_in_frame);

  // Step 2: For each clip, find matching transcript items
  const allPending: PendingItem[] = [];
  let captionCounter = 0;

  for (const clip of dialogueClips) {
    const transcript = transcripts.get(clip.asset_id);
    if (!transcript) continue;

    // Find items that overlap with the clip's source range
    let matchingItems = transcript.items.filter((item) => {
      return (
        item.start_us < clip.src_out_us && item.end_us > clip.src_in_us
      );
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
        item,
        timelineInFrame: timelineInFrame,
        timelineDurationFrames: durationFrames,
      });
    }
  }

  // Step 3: Segment into caption units
  const segments = segmentItems(allPending, language, fps, maxCps);

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
      const breakResult = formatCaption(text, language);
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

    const dwellMs = framesToMs(durationFrames, fps);
    const cps = computeCps(text, dwellMs, language);

    // Determine asset_id and segment_id from first item's clip context
    const firstPending = seg[0];
    const matchingClip = dialogueClips.find(
      (c) =>
        c.asset_id ===
          findAssetForItem(firstPending.item, dialogueClips, transcripts) &&
        firstPending.timelineInFrame >= c.timeline_in_frame &&
        firstPending.timelineInFrame <
          c.timeline_in_frame + c.timeline_duration_frames,
    );

    const assetId = matchingClip?.asset_id ?? "";
    const segmentId = matchingClip?.segment_id ?? "";
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

  return {
    version: "1.0",
    project_id: projectId,
    base_timeline_version: baseTimelineVersion,
    caption_policy: policy,
    speech_captions: speechCaptions,
    text_overlays: [],
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function usToFrames(us: number, fps: number): number {
  return Math.round((us / 1_000_000) * fps);
}

function findAssetForItem(
  item: TranscriptItem,
  clips: MinimalClip[],
  transcripts: Map<string, TranscriptArtifact>,
): string {
  for (const [assetId, transcript] of transcripts) {
    if (transcript.items.some((ti) => ti.item_id === item.item_id)) {
      return assetId;
    }
  }
  return "";
}
