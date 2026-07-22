import type { CaptionDraftEntry, RevealTimingMetadata } from "./editorial.js";
import type { CaptionRevealAnchor, CaptionSemanticTimingPolicy } from "./segmenter.js";

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
  version: "caption-timing-report/v1";
  mode: CaptionSemanticTimingPolicy["mode"];
  checked_caption_count: number;
  protected_caption_count: number;
  split_count: number;
  adjusted_lead_count: number;
  unresolved_count: number;
  issues: CaptionTimingIssue[];
}

export interface ApplyCaptionSemanticTimingInput {
  captions: CaptionDraftEntry[];
  policy?: CaptionSemanticTimingPolicy;
  transcriptItems: Map<string, RevealTranscriptItem>;
  clips: RevealClipContext[];
  fps: number;
}

export interface ApplyCaptionSemanticTimingResult {
  captions: CaptionDraftEntry[];
  report: CaptionTimingReport;
}

const DEFAULT_ORDINARY_LEAD_FRAMES = 2;
const DEFAULT_AUDIO_FIRST_FRAMES = 1;

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
): number | undefined {
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
): number | undefined {
  const frames = entry.transcript_item_ids
    .map((id) => transcriptItems.get(id))
    .filter((item): item is RevealTranscriptItem => Boolean(item))
    .map((item) => mapSourceUsToTimelineFrame(item.start_us, entry, clips, fps))
    .filter((frame): frame is number => frame !== undefined);
  return frames.length > 0 ? Math.min(...frames) : undefined;
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
): { frame?: number; source?: RevealTimingMetadata["source"] } {
  if (anchor.timeline_frame !== undefined) {
    return { frame: anchor.timeline_frame, source: "explicit_timeline_frame" };
  }
  if (anchor.source_start_us !== undefined) {
    return {
      frame: mapSourceUsToTimelineFrame(anchor.source_start_us, entry, clips, fps),
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
          frame: mapSourceUsToTimelineFrame(wordStartUs, entry, clips, fps),
          source: "word_timing",
        };
      }
    }

    // Item onset is precise enough only when the protected text begins the item.
    // Never interpolate a later punchline from character count: that recreates spoilers.
    if (normalizeToken(item.text).startsWith(normalizeToken(anchor.anchor_text))) {
      return {
        frame: mapSourceUsToTimelineFrame(item.start_us, entry, clips, fps),
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
    version: "caption-timing-report/v1",
    mode: policy.mode,
    checked_caption_count: input.captions.length,
    protected_caption_count: 0,
    split_count: 0,
    adjusted_lead_count: 0,
    unresolved_count: 0,
    issues: [],
  };
  if (policy.mode === "off") {
    return { captions: input.captions, report };
  }

  const ordinaryLeadFrames = Math.max(0, policy.ordinary_lead_frames ?? DEFAULT_ORDINARY_LEAD_FRAMES);
  const defaultAudioFirstFrames = Math.max(0, policy.audio_first_frames ?? DEFAULT_AUDIO_FIRST_FRAMES);

  let captions = input.captions.map(cloneCaption).map((entry) => {
    const speechFrame = earliestReferencedFrame(entry, input.transcriptItems, input.clips, input.fps);
    if (speechFrame === undefined) return entry;
    const allowedStart = Math.max(0, speechFrame - ordinaryLeadFrames);
    if (entry.timeline_in_frame >= allowedStart) return entry;
    const originalOut = entry.timeline_in_frame + entry.timeline_duration_frames;
    if (allowedStart >= originalOut) return entry;
    const leadFrames = speechFrame - entry.timeline_in_frame;
    report.adjusted_lead_count += 1;
    report.issues.push({
      code: "premature_caption_lead",
      severity: "warn",
      caption_id: entry.caption_id,
      lead_frames: leadFrames,
      message: `${entry.caption_id} was ${leadFrames} frames ahead of referenced speech; clamped to ${ordinaryLeadFrames}-frame reading lead`,
    });
    return withTiming(entry, allowedStart, originalOut, entry.text, entry.reveal_timing, input.fps);
  });

  if (policy.mode !== "protect_reveals") {
    return { captions, report };
  }

  for (const anchor of policy.anchors ?? []) {
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
    const resolved = resolveAnchorFrame(anchor, entry, input.transcriptItems, input.clips, input.fps);
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

  captions.sort((a, b) => a.timeline_in_frame - b.timeline_in_frame || a.caption_id.localeCompare(b.caption_id));
  return { captions, report };
}
