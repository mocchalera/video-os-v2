import type { CaptionDraftEntry, RevealTimingMetadata } from "./editorial.js";
import type { CaptionRevealAnchor, CaptionSemanticTimingPolicy } from "./segmenter.js";
import { projectSourceRange, type TimelineOffsetMap } from "../compiler/timeline-offset-engine.js";

export interface RevealTranscriptItem {
  item_id: string;
  start_us: number;
  end_us: number;
  text: string;
  words?: Array<{ word: string; start_us: number; end_us: number }>;
  word_timing_mode?: "word" | "char" | "none";
}

export interface RevealClipContext {
  segment_id: string;
  asset_id: string;
  src_in_us: number;
  src_out_us: number;
  timeline_in_frame: number;
  timeline_duration_frames: number;
}

export type CaptionTimingIssueCode =
  | "premature_caption_lead"
  | "question_caption_lead"
  | "previous_speech_overlap"
  | "unresolved_reveal_anchor"
  | "ambiguous_reveal_anchor"
  | "reveal_after_caption";

export interface CaptionTimingIssue {
  code: CaptionTimingIssueCode;
  severity: "warn" | "block";
  caption_id?: string;
  anchor_id?: string;
  lead_frames?: number;
  message: string;
}

export interface CaptionTimingReport {
  version: "caption-timing-report/v1" | "caption-timing-report/v2";
  mode: CaptionSemanticTimingPolicy["mode"];
  checked_caption_count: number;
  protected_caption_count: number;
  split_count: number;
  adjusted_lead_count: number;
  question_caption_count?: number;
  question_adjusted_count?: number;
  previous_speech_guard_count?: number;
  gap_tail_hold_count?: number;
  unresolved_count: number;
  issues: CaptionTimingIssue[];
  offset_map_fingerprint?: string;
  dialogue_authority?: "A1" | "legacy-role";
}

export interface ApplyCaptionSemanticTimingInput {
  captions: CaptionDraftEntry[];
  policy?: CaptionSemanticTimingPolicy;
  transcriptItems: Map<string, RevealTranscriptItem>;
  clips: RevealClipContext[];
  fps: number;
  offsetMap?: TimelineOffsetMap;
}

export interface ApplyCaptionSemanticTimingResult {
  captions: CaptionDraftEntry[];
  report: CaptionTimingReport;
}

const DEFAULT_ORDINARY_LEAD_FRAMES = 2;
const DEFAULT_AUDIO_FIRST_FRAMES = 1;
const DEFAULT_QUESTION_AUDIO_FIRST_FRAMES = 0;

function cloneCaption(entry: CaptionDraftEntry): CaptionDraftEntry {
  return structuredClone(entry);
}

function normalizeToken(value: string): string {
  return value
    .replace(/^(?:AI|画面|坂本)[｜|]/, "")
    .replace(/[\s、。！？!?・♪…「」『』（）()\-ー]/g, "")
    .toLowerCase();
}

function splitSpeakerPrefix(text: string): { prefix: string; body: string } {
  const match = text.match(/^((?:AI|画面|坂本)[｜|])/);
  if (!match) return { prefix: "", body: text };
  return { prefix: match[1], body: text.slice(match[1].length) };
}

function mapSourceUsToTimelineFrame(
  sourceUs: number,
  entry: CaptionDraftEntry,
  clips: RevealClipContext[],
  fps: number,
  offsetMap?: TimelineOffsetMap,
): number | undefined {
  if (offsetMap) {
    const projected = projectSourceRange(offsetMap, {
      asset_id: entry.asset_id,
      segment_id: entry.segment_id,
      source_start_us: sourceUs,
      source_end_us: sourceUs + 1,
    });
    if (projected.status === "exact" && projected.segments.length > 0) return projected.timeline_in_frame;
  }
  const matching = clips.find((clip) =>
    clip.asset_id === entry.asset_id
    && clip.segment_id === entry.segment_id
    && sourceUs >= clip.src_in_us
    && sourceUs < clip.src_out_us
  ) ?? clips.find((clip) =>
    clip.asset_id === entry.asset_id
    && sourceUs >= clip.src_in_us
    && sourceUs < clip.src_out_us
  );
  if (!matching) return undefined;
  return matching.timeline_in_frame + Math.round((sourceUs - matching.src_in_us) / 1_000_000 * fps);
}

function earliestReferencedFrame(
  entry: CaptionDraftEntry,
  transcriptItems: Map<string, RevealTranscriptItem>,
  clips: RevealClipContext[],
  fps: number,
  offsetMap?: TimelineOffsetMap,
): number | undefined {
  const wordFrames = entry.timing?.sourceWordRefs
    ?.map((word) => mapSourceUsToTimelineFrame(word.start_us, entry, clips, fps, offsetMap))
    .filter((frame): frame is number => frame !== undefined);
  if (wordFrames && wordFrames.length > 0) return Math.min(...wordFrames);
  const frames = entry.transcript_item_ids
    .map((id) => transcriptItems.get(id))
    .filter((item): item is RevealTranscriptItem => Boolean(item))
    .map((item) => mapSourceUsToTimelineFrame(item.start_us, entry, clips, fps, offsetMap))
    .filter((frame): frame is number => frame !== undefined);
  if (frames.length > 0) return Math.min(...frames);
  if (entry.timing?.source === "clip_item_remap" || entry.timing?.source === "offset_map_fallback") {
    return entry.timing.timelineInFrame;
  }
  return undefined;
}

function latestReferencedFrame(
  entry: CaptionDraftEntry,
  transcriptItems: Map<string, RevealTranscriptItem>,
  clips: RevealClipContext[],
  fps: number,
  offsetMap?: TimelineOffsetMap,
): number | undefined {
  const wordFrames = entry.timing?.sourceWordRefs
    ?.map((word) => mapSourceUsToTimelineFrame(word.end_us, entry, clips, fps, offsetMap))
    .filter((frame): frame is number => frame !== undefined);
  if (wordFrames && wordFrames.length > 0) return Math.max(...wordFrames);
  const frames = entry.transcript_item_ids
    .map((id) => transcriptItems.get(id))
    .filter((item): item is RevealTranscriptItem => Boolean(item))
    .map((item) => mapSourceUsToTimelineFrame(item.end_us, entry, clips, fps, offsetMap))
    .filter((frame): frame is number => frame !== undefined);
  if (frames.length > 0) return Math.max(...frames);
  if (entry.timing?.source === "clip_item_remap" || entry.timing?.source === "offset_map_fallback") {
    return entry.timing.timelineInFrame + entry.timing.timelineDurationFrames;
  }
  return undefined;
}

function isQuestionCaption(text: string): boolean {
  const body = splitSpeakerPrefix(text).body.replace(/\s+/g, "");
  return /[?？]/u.test(body)
    || /(?:ですか|ますか|でしょうか|ませんか|だろうか|なんだろう|できるかな|じゃないかな)[。！!…]*$/u.test(body);
}

function findWordStartUs(
  words: Array<{ word: string; start_us: number; end_us: number }>,
  anchorText: string,
): number | undefined {
  const target = normalizeToken(anchorText);
  if (!target) return undefined;
  for (let start = 0; start < words.length; start += 1) {
    let combined = "";
    for (let end = start; end < words.length; end += 1) {
      combined += normalizeToken(words[end].word);
      if (combined.includes(target) || target.startsWith(combined)) {
        if (combined.includes(target)) return words[start].start_us;
        continue;
      }
      if (combined.length >= target.length) break;
    }
  }
  return undefined;
}

function resolveAnchorFrame(
  anchor: CaptionRevealAnchor,
  entry: CaptionDraftEntry,
  transcriptItems: Map<string, RevealTranscriptItem>,
  clips: RevealClipContext[],
  fps: number,
  offsetMap?: TimelineOffsetMap,
): { frame?: number; source?: RevealTimingMetadata["source"] } {
  if (anchor.timeline_frame !== undefined) {
    return { frame: anchor.timeline_frame, source: "explicit_timeline_frame" };
  }
  if (anchor.source_start_us !== undefined) {
    return {
      frame: mapSourceUsToTimelineFrame(anchor.source_start_us, entry, clips, fps, offsetMap),
      source: "explicit_source_time",
    };
  }

  const itemIds = anchor.transcript_item_id
    ? [anchor.transcript_item_id]
    : entry.transcript_item_ids;
  for (const itemId of itemIds) {
    const item = transcriptItems.get(itemId);
    if (!item) continue;
    if (item.words && item.words.length > 0 && item.word_timing_mode !== "none") {
      const wordStartUs = findWordStartUs(item.words, anchor.anchor_text);
      if (wordStartUs !== undefined) {
        return {
          frame: mapSourceUsToTimelineFrame(wordStartUs, entry, clips, fps, offsetMap),
          source: "word_timing",
        };
      }
    }

    // Item onset is precise enough only when the protected text begins the item.
    // Never interpolate a later punchline from character count: that recreates spoilers.
    if (normalizeToken(item.text).startsWith(normalizeToken(anchor.anchor_text))) {
      return {
        frame: mapSourceUsToTimelineFrame(item.start_us, entry, clips, fps, offsetMap),
        source: "transcript_item_onset",
      };
    }
  }
  return {};
}

function anchorMatchesEntry(anchor: CaptionRevealAnchor, entry: CaptionDraftEntry): boolean {
  if (anchor.segment_id && entry.segment_id !== anchor.segment_id) return false;
  if (anchor.transcript_item_id && !entry.transcript_item_ids.includes(anchor.transcript_item_id)) return false;
  return splitSpeakerPrefix(entry.text).body.includes(anchor.anchor_text);
}

function metricsFor(text: string, durationFrames: number, fps: number): CaptionDraftEntry["metrics"] {
  const dwellMs = Math.round(durationFrames / fps * 1000);
  const body = splitSpeakerPrefix(text).body.replace(/\n/g, "");
  return {
    cps: Math.round(body.length / Math.max(0.001, dwellMs / 1000) * 100) / 100,
    dwell_ms: dwellMs,
  };
}

function withTiming(
  entry: CaptionDraftEntry,
  startFrame: number,
  endFrame: number,
  text: string,
  revealTiming?: RevealTimingMetadata,
  fps = 24,
): CaptionDraftEntry {
  const duration = Math.max(1, endFrame - startFrame);
  return {
    ...entry,
    timeline_in_frame: startFrame,
    timeline_duration_frames: duration,
    text,
    metrics: metricsFor(text, duration, fps),
    timing: entry.timing
      ? {
        ...entry.timing,
        timelineInFrame: startFrame,
        timelineDurationFrames: duration,
      }
      : undefined,
    reveal_timing: revealTiming,
  };
}

function unresolvedMetadata(
  anchor: CaptionRevealAnchor,
  entry: CaptionDraftEntry,
  audioFirstFrames: number,
): RevealTimingMetadata {
  return {
    anchor_id: anchor.anchor_id,
    role: anchor.role,
    anchor_text: anchor.anchor_text,
    status: "unresolved",
    source: "unresolved",
    audio_first_frames: audioFirstFrames,
    original_timeline_in_frame: entry.timeline_in_frame,
  };
}

export function applyCaptionSemanticTiming(
  input: ApplyCaptionSemanticTimingInput,
): ApplyCaptionSemanticTimingResult {
  const policy = input.policy ?? { mode: "off" as const };
  const report: CaptionTimingReport = {
    version: input.offsetMap ? "caption-timing-report/v2" : "caption-timing-report/v1",
    mode: policy.mode,
    checked_caption_count: input.captions.length,
    protected_caption_count: 0,
    split_count: 0,
    adjusted_lead_count: 0,
    question_caption_count: 0,
    question_adjusted_count: 0,
    previous_speech_guard_count: 0,
    gap_tail_hold_count: 0,
    unresolved_count: 0,
    issues: [],
    offset_map_fingerprint: input.offsetMap?.fingerprint,
    dialogue_authority: input.offsetMap?.dialogue_authority,
  };
  if (policy.mode === "off") {
    return { captions: input.captions, report };
  }

  const ordinaryLeadFrames = Math.max(0, policy.ordinary_lead_frames ?? DEFAULT_ORDINARY_LEAD_FRAMES);
  const defaultAudioFirstFrames = Math.max(0, policy.audio_first_frames ?? DEFAULT_AUDIO_FIRST_FRAMES);
  const questionAudioFirstFrames = Math.max(
    0,
    policy.question_audio_first_frames ?? DEFAULT_QUESTION_AUDIO_FIRST_FRAMES,
  );

  let previousSpeechEnd: number | undefined;
  let captions = input.captions
    .map(cloneCaption)
    .sort((a, b) => a.timeline_in_frame - b.timeline_in_frame || a.caption_id.localeCompare(b.caption_id))
    .map((entry) => {
    const speechFrame = earliestReferencedFrame(entry, input.transcriptItems, input.clips, input.fps, input.offsetMap);
    const speechEnd = latestReferencedFrame(entry, input.transcriptItems, input.clips, input.fps, input.offsetMap);
    if (speechFrame === undefined) {
      if (speechEnd !== undefined) previousSpeechEnd = speechEnd;
      return entry;
    }
    const question = isQuestionCaption(entry.text);
    if (question) report.question_caption_count = (report.question_caption_count ?? 0) + 1;
    let allowedStart = Math.max(
      0,
      question ? speechFrame + questionAudioFirstFrames : speechFrame - ordinaryLeadFrames,
    );
    // A real pause belongs to the tail of the previous caption. Ordinary
    // reading lead is allowed only when it does not consume that silence.
    if (!question && previousSpeechEnd !== undefined && speechFrame > previousSpeechEnd) {
      allowedStart = speechFrame;
    }
    // ASR word ranges can overlap at chunk boundaries. Never let a noisy
    // previous end delay the next cue beyond the next cue's own audio onset.
    const guardedStart = previousSpeechEnd === undefined
      ? allowedStart
      : Math.max(allowedStart, Math.min(previousSpeechEnd, speechFrame));
    const targetStart = Math.max(entry.timeline_in_frame, guardedStart);
    const originalStart = entry.timeline_in_frame;
    const originalOut = entry.timeline_in_frame + entry.timeline_duration_frames;
    const targetOut = Math.max(originalOut, speechEnd ?? originalOut, targetStart + 1);

    if (question && originalStart < allowedStart) {
      const leadFrames = allowedStart - originalStart;
      report.adjusted_lead_count += 1;
      report.question_adjusted_count = (report.question_adjusted_count ?? 0) + 1;
      report.issues.push({
        code: "question_caption_lead",
        severity: "warn",
        caption_id: entry.caption_id,
        lead_frames: leadFrames,
        message: `${entry.caption_id} question was ${leadFrames} frames ahead of audio; aligned to question onset`,
      });
    } else if (!question && originalStart < allowedStart) {
      const leadFrames = speechFrame - originalStart;
      const appliedLeadFrames = Math.max(0, speechFrame - allowedStart);
      report.adjusted_lead_count += 1;
      report.issues.push({
        code: "premature_caption_lead",
        severity: "warn",
        caption_id: entry.caption_id,
        lead_frames: leadFrames,
        message: `${entry.caption_id} was ${leadFrames} frames ahead of referenced speech; clamped to ${appliedLeadFrames}-frame reading lead`,
      });
    }
    if (previousSpeechEnd !== undefined && originalStart < previousSpeechEnd) {
      const overlapFrames = previousSpeechEnd - originalStart;
      report.previous_speech_guard_count = (report.previous_speech_guard_count ?? 0) + 1;
      report.issues.push({
        code: "previous_speech_overlap",
        severity: "warn",
        caption_id: entry.caption_id,
        lead_frames: overlapFrames,
        message: `${entry.caption_id} began ${overlapFrames} frames before the previous utterance ended; moved behind the prior speech boundary`,
      });
    }

    previousSpeechEnd = speechEnd ?? previousSpeechEnd;
    if (targetStart === originalStart && targetOut === originalOut) return entry;
    return withTiming(entry, targetStart, targetOut, entry.text, entry.reveal_timing, input.fps);
  });

  if (policy.mode === "protect_reveals") for (const anchor of policy.anchors ?? []) {
    const matches = captions.filter((entry) => anchorMatchesEntry(anchor, entry));
    if (matches.length !== 1) {
      report.unresolved_count += 1;
      report.issues.push({
        code: matches.length === 0 ? "unresolved_reveal_anchor" : "ambiguous_reveal_anchor",
        severity: "block",
        anchor_id: anchor.anchor_id,
        message: matches.length === 0
          ? `${anchor.anchor_id} did not match a caption; use exact anchor_text plus segment_id or transcript_item_id`
          : `${anchor.anchor_id} matched ${matches.length} captions; add segment_id or transcript_item_id`,
      });
      continue;
    }

    const entry = matches[0];
    const audioFirstFrames = Math.max(0, anchor.audio_first_frames ?? defaultAudioFirstFrames);
    const resolved = resolveAnchorFrame(anchor, entry, input.transcriptItems, input.clips, input.fps, input.offsetMap);
    if (resolved.frame === undefined || !resolved.source) {
      report.unresolved_count += 1;
      report.issues.push({
        code: "unresolved_reveal_anchor",
        severity: "block",
        caption_id: entry.caption_id,
        anchor_id: anchor.anchor_id,
        message: `${anchor.anchor_id} needs word timing, an item-onset anchor, source_start_us, or timeline_frame; character interpolation is intentionally disabled`,
      });
      captions = captions.map((candidate) => candidate.caption_id === entry.caption_id
        ? { ...candidate, reveal_timing: unresolvedMetadata(anchor, candidate, audioFirstFrames) }
        : candidate);
      continue;
    }

    const revealStart = resolved.frame + audioFirstFrames;
    const originalOut = entry.timeline_in_frame + entry.timeline_duration_frames;
    if (revealStart >= originalOut) {
      report.unresolved_count += 1;
      report.issues.push({
        code: "reveal_after_caption",
        severity: "block",
        caption_id: entry.caption_id,
        anchor_id: anchor.anchor_id,
        message: `${anchor.anchor_id} resolves at frame ${revealStart}, outside ${entry.caption_id}`,
      });
      captions = captions.map((candidate) => candidate.caption_id === entry.caption_id
        ? { ...candidate, reveal_timing: unresolvedMetadata(anchor, candidate, audioFirstFrames) }
        : candidate);
      continue;
    }

    const { prefix, body } = splitSpeakerPrefix(entry.text);
    const anchorIndex = body.indexOf(anchor.anchor_text);
    const setupText = body.slice(0, anchorIndex).trimEnd();
    const revealText = body.slice(anchorIndex).trimStart();
    const metadata: RevealTimingMetadata = {
      anchor_id: anchor.anchor_id,
      role: anchor.role,
      anchor_text: anchor.anchor_text,
      status: "protected",
      source: resolved.source,
      anchor_frame: resolved.frame,
      audio_first_frames: audioFirstFrames,
      original_timeline_in_frame: entry.timeline_in_frame,
    };

    const replacement: CaptionDraftEntry[] = [];
    if (setupText && revealStart - entry.timeline_in_frame >= 2) {
      const setupEnd = Math.max(entry.timeline_in_frame + 1, revealStart - 1);
      replacement.push(withTiming(
        { ...entry, caption_id: `${entry.caption_id}_SETUP` },
        entry.timeline_in_frame,
        setupEnd,
        `${prefix}${setupText}`,
        {
          ...metadata,
          status: "setup_only",
        },
        input.fps,
      ));
      report.split_count += 1;
    }
    replacement.push(withTiming(
      entry,
      Math.max(entry.timeline_in_frame, revealStart),
      originalOut,
      `${prefix}${revealText}`,
      metadata,
      input.fps,
    ));
    report.protected_caption_count += 1;

    captions = captions.flatMap((candidate) =>
      candidate.caption_id === entry.caption_id ? replacement : [candidate]
    );
  }

  if ((policy.gap_ownership ?? "previous") === "previous") {
    captions.sort((a, b) => a.timeline_in_frame - b.timeline_in_frame || a.caption_id.localeCompare(b.caption_id));
    captions = captions.map((entry, index) => {
      const next = captions[index + 1];
      if (!next || next.timeline_in_frame <= entry.timeline_in_frame) return entry;
      const currentOut = entry.timeline_in_frame + entry.timeline_duration_frames;
      if (currentOut === next.timeline_in_frame) return entry;
      if (currentOut < next.timeline_in_frame) {
        report.gap_tail_hold_count = (report.gap_tail_hold_count ?? 0) + 1;
      }
      return withTiming(
        entry,
        entry.timeline_in_frame,
        next.timeline_in_frame,
        entry.text,
        entry.reveal_timing,
        input.fps,
      );
    });
  }

  captions.sort((a, b) => a.timeline_in_frame - b.timeline_in_frame || a.caption_id.localeCompare(b.caption_id));
  return { captions, report };
}
