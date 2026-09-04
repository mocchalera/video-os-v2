/**
 * Issue #41: authored lyrics as caption body authority.
 *
 * This is deliberately a small adapter around the existing caption source,
 * draft, approval, projection, caption separation, and rhythm time helpers.
 * It never edits authored text and it never promotes timing evidence to body
 * authority.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { parse as parseYaml } from "yaml";
import {
  createDraftApproval,
  projectCaptionsToTimeline,
  type CaptionApproval,
} from "./approval.js";
import {
  computeCaptionCps,
  enforceCaptionSeparation,
  MIN_CAPTION_HARD_FLOOR_MS,
  MIN_CAPTION_TARGET_DWELL_MS,
  type CaptionPolicy,
  type CaptionSource,
  type SpeechCaption,
} from "./segmenter.js";
import type { CaptionDraft, CaptionDraftEntry } from "./editorial.js";
import { captionLineage } from "./identity.js";
import {
  buildTimelineOffsetMapFromTimeline,
  projectSourceRange,
  type TimelineOffsetMap,
} from "../compiler/timeline-offset-engine.js";
import {
  secondsToRhythmFrame,
  usToRhythmFrame,
} from "../compiler/rhythm-sync.js";
import type { TimelineIR } from "../artifacts/types.js";

export const AUTHORED_LYRICS_VERSION = "authored-lyrics/v1";
export const AUTHORED_TIMING_PLAN_VERSION = "authored-lyrics-timing-plan/v1";
export const AUTHORED_CAPTION_PREVIEW_VERSION = "authored-caption-preview/v1";
export const AUTHORED_CAPTION_PROJECTION_VERSION = "authored-caption-projection/v1";
export const AUTHORED_ALIGNMENT_VERSION = "authored-lyrics-align/v1";
export const AUTHORED_CONFIDENCE_THRESHOLD = 0.75;
export const AUTHORED_INTER_CAPTION_GAP_FRAMES = 1;

export type AuthoredCueStatus = "matched" | "human_confirmation_pending" | "unmatched";

export interface AuthoredTextLine {
  line_id: string;
  line_number: number;
  text: string;
  text_sha256: string;
}

export interface AuthoredTextAuthority {
  authority: "authored";
  source_path: string;
  source_sha256: string;
  /** Alias retained in the artifact so operators can find the source hash. */
  source_hash: string;
  declared_normalization: "preserve_bytes";
  line_ending_mode: "preserved";
  line_count: number;
  body_sha256: string;
  lines: AuthoredTextLine[];
}

export interface AuthoredTimingSourceRef {
  kind: "timing_plan_cue" | "stt_word" | "onset" | "section_cue";
  id?: string;
  text?: string;
  start_us?: number;
  end_us?: number;
  confidence?: number;
}

export interface AuthoredTimingCue {
  cue_id: string;
  line_id: string;
  line_number: number;
  status: AuthoredCueStatus;
  confidence: number;
  source_kind: "direct_cue" | "stt_word_timing" | "onset" | "section_cue" | "unmatched";
  source_refs: AuthoredTimingSourceRef[];
  raw_start_frame: number;
  raw_end_frame: number;
  timeline_in_frame: number;
  timeline_duration_frames: number;
  one_frame_gap_applied: boolean;
  minimum_display_duration_applied: boolean;
  cps_before: number;
  cps_after: number;
}

export interface AuthoredTimingAuthority {
  authority: "timing_plan";
  source_path: string;
  source_sha256: string;
  source_hash: string;
  declared_normalization: "preserve_values";
  plan_version: string;
  alignment_version: typeof AUTHORED_ALIGNMENT_VERSION;
  confidence_threshold: number;
  cue_count: number;
  matched_count: number;
  pending_count: number;
  unmatched_count: number;
  cues: AuthoredTimingCue[];
}

export interface AuthoredCaptionPreview {
  version: typeof AUTHORED_CAPTION_PREVIEW_VERSION;
  project_id: string;
  base_timeline_hash: string;
  projected_timeline_hash: string;
  approval_required: true;
  text_authority: AuthoredTextAuthority;
  timing_authority: AuthoredTimingAuthority;
  changes: {
    one_frame_gap_handling: {
      gap_frames: number;
      adjusted_cue_ids: string[];
    };
    minimum_display_duration: {
      target_ms: number;
      hard_floor_ms: number;
      adjusted_cue_ids: string[];
    };
    cps: Array<{
      cue_id: string;
      before: number;
      after: number;
    }>;
  };
  next_command: string;
}

export interface AuthoredCaptionProjectionReceipt {
  version: typeof AUTHORED_CAPTION_PROJECTION_VERSION;
  project_id: string;
  base_timeline_hash: string;
  projected_timeline_hash: string;
  caption_approval_sha256: string;
  caption_text_sha256: string;
  caption_timing_sha256: string;
  text_authority: AuthoredTextAuthority;
  timing_authority: AuthoredTimingAuthority;
  projection: {
    track_id: "C1";
    cue_count: number;
    gap_frames: number;
  };
}

export interface AuthoredCaptionArtifacts {
  captionSource: CaptionSource;
  captionDraft: CaptionDraft;
  preview: AuthoredCaptionPreview;
}

export interface BuildAuthoredCaptionOptions {
  projectDir: string;
  lyricsPath: string;
  timingPlanPath: string;
  timeline: TimelineIR;
  captionPolicy: CaptionPolicy;
  projectId: string;
  baseTimelineVersion: string;
  baseTimelineHash: string;
  nextCommand?: string;
  maxCps?: number;
  gapFrames?: number;
}

interface RawRecord {
  [key: string]: unknown;
}

interface TimeRange {
  startFrame: number;
  endFrame: number;
  startUs?: number;
  endUs?: number;
}

interface DirectCue {
  ordinal: number;
  lineId?: string;
  lineNumber?: number;
  text?: string;
  confidence?: number;
  range?: TimeRange;
  sourceRefs: AuthoredTimingSourceRef[];
}

interface WordTiming {
  ordinal: number;
  id?: string;
  text: string;
  lineId?: string;
  lineNumber?: number;
  confidence?: number;
  range: TimeRange;
}

interface TimedEvent {
  ordinal: number;
  id?: string;
  confidence?: number;
  range: TimeRange;
  kind: "onset" | "section_cue";
  label?: string;
}

interface Candidate {
  line: AuthoredTextLine;
  status: AuthoredCueStatus;
  confidence: number;
  sourceKind: AuthoredTimingCue["source_kind"];
  sourceRefs: AuthoredTimingSourceRef[];
  rawStartFrame: number;
  rawEndFrame: number;
}

export function sha256Bytes(value: Buffer | string): string {
  return `sha256:${crypto.createHash("sha256").update(value).digest("hex")}`;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().filter((key) => record[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

export function hashAuthoredCanonical(value: unknown): string {
  return sha256Bytes(canonicalJson(value));
}

export function serializeAuthoredJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function readUtf8(filePath: string): { bytes: Buffer; text: string } {
  const bytes = fs.readFileSync(filePath);
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  return { bytes, text };
}

function asRecord(value: unknown): RawRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as RawRecord
    : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function finiteNumber(record: RawRecord, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = record[key];
    const parsed = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : NaN;
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function integerNumber(record: RawRecord, keys: string[]): number | undefined {
  const value = finiteNumber(record, keys);
  return value !== undefined && Number.isInteger(value) ? value : undefined;
}

function clampConfidence(value: number | undefined, fallback: number): number {
  const candidate = value ?? fallback;
  return Math.max(0, Math.min(1, Number.isFinite(candidate) ? candidate : fallback));
}

function pathForArtifact(projectDir: string, inputPath: string): string {
  const absolute = path.resolve(inputPath);
  const relative = path.relative(path.resolve(projectDir), absolute);
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative)
    ? relative.split(path.sep).join("/")
    : absolute;
}

function resolveArtifactPath(projectDir: string, storedPath: string): string {
  return path.isAbsolute(storedPath) ? storedPath : path.resolve(projectDir, storedPath);
}

function normalizeLineText(text: string): string {
  return text.normalize("NFKC").toLowerCase();
}

function tokens(text: string, language: string): string[] {
  const normalized = normalizeLineText(text);
  const direct = normalized.match(/[\p{L}\p{N}]+/gu) ?? [];
  if (direct.length > 1 || !language.toLowerCase().startsWith("ja") || typeof Intl.Segmenter !== "function") {
    return direct;
  }
  return [...new Intl.Segmenter("ja", { granularity: "word" }).segment(normalized)]
    .map((segment) => segment.segment.match(/[\p{L}\p{N}]+/gu)?.[0] ?? "")
    .filter(Boolean);
}

function textSimilarity(left: string, right: string, language: string): number {
  const leftTokens = tokens(left, language);
  const rightTokens = tokens(right, language);
  if (leftTokens.length === 0 || rightTokens.length === 0) return 0;
  const remaining = [...rightTokens];
  let matched = 0;
  for (const token of leftTokens) {
    const index = remaining.indexOf(token);
    if (index >= 0) {
      matched += 1;
      remaining.splice(index, 1);
    }
  }
  return matched / Math.max(leftTokens.length, rightTokens.length);
}

function lineIdFromRecord(record: RawRecord): string | undefined {
  const explicit = record.line_id ?? record.lineId;
  if (typeof explicit === "string" && explicit.length > 0) return explicit;
  const number = integerNumber(record, ["line_number", "lineNumber"]);
  if (number !== undefined) return `AL_${String(number).padStart(4, "0")}`;
  return undefined;
}

function lineNumberFromRecord(record: RawRecord): number | undefined {
  const number = integerNumber(record, ["line_number", "lineNumber"]);
  if (number !== undefined && number > 0) return number;
  const index = integerNumber(record, ["line_index", "lineIndex", "index"]);
  if (index !== undefined && index >= 0) return index + 1;
  const line = record.line;
  if (typeof line === "number" && Number.isInteger(line) && line >= 1) return line;
  if (typeof line === "string" && /^\d+$/.test(line.trim())) return Number(line);
  return undefined;
}

function textFromRecord(record: RawRecord): string | undefined {
  for (const key of ["text", "lyric", "line_text", "lineText", "value"]) {
    if (typeof record[key] === "string") return record[key] as string;
  }
  if (typeof record.line === "string" && !/^\d+$/.test(record.line.trim())) return record.line;
  return undefined;
}

function timePair(
  record: RawRecord,
  fpsNum: number,
  fpsDen: number,
  offsetMap?: TimelineOffsetMap,
): TimeRange | undefined {
  const explicitStartFrame = integerNumber(record, ["timeline_in_frame", "in_frame", "start_frame", "startFrame", "frame"]);
  const explicitEndFrame = integerNumber(record, ["timeline_out_frame", "out_frame", "end_frame", "endFrame"]);
  const explicitDuration = integerNumber(record, ["timeline_duration_frames", "duration_frames", "durationFrame"]);
  if (explicitStartFrame !== undefined) {
    const end = explicitEndFrame ?? explicitStartFrame + Math.max(1, explicitDuration ?? 1);
    return { startFrame: Math.max(0, explicitStartFrame), endFrame: Math.max(explicitStartFrame + 1, end) };
  }

  const startUs = finiteNumber(record, ["timeline_start_us", "source_start_us", "start_us", "startUs"]);
  const endUs = finiteNumber(record, ["timeline_end_us", "source_end_us", "end_us", "endUs"]);
  if (startUs !== undefined) {
    const end = endUs ?? startUs + 1;
    if (offsetMap && typeof record.asset_id === "string" && end > startUs) {
      const projection = projectSourceRange(offsetMap, {
        asset_id: record.asset_id,
        segment_id: typeof record.segment_id === "string" ? record.segment_id : undefined,
        source_start_us: startUs,
        source_end_us: end,
      });
      if (projection.status === "exact") {
        return {
          startFrame: projection.timeline_in_frame,
          endFrame: Math.max(projection.timeline_in_frame + 1, projection.timeline_in_frame + projection.timeline_duration_frames),
          startUs,
          endUs: end,
        };
      }
    }
    return {
      startFrame: Math.max(0, usToRhythmFrame(startUs, fpsNum, fpsDen)),
      endFrame: Math.max(1, usToRhythmFrame(end, fpsNum, fpsDen)),
      startUs,
      endUs: end,
    };
  }

  const startSeconds = finiteNumber(record, ["start_sec", "start_seconds", "start_time", "time_sec", "time", "start"]);
  if (startSeconds !== undefined) {
    const endSeconds = finiteNumber(record, ["end_sec", "end_seconds", "end_time", "end"]);
    const end = endSeconds ?? startSeconds + 1 / Math.max(1, fpsNum / fpsDen);
    return {
      startFrame: Math.max(0, secondsToRhythmFrame(startSeconds, fpsNum, fpsDen)),
      endFrame: Math.max(1, secondsToRhythmFrame(end, fpsNum, fpsDen)),
    };
  }
  return undefined;
}

function collectArray(root: RawRecord | null, keys: string[]): unknown[] {
  for (const key of keys) {
    if (Array.isArray(root?.[key])) return root[key] as unknown[];
  }
  return [];
}

function parseTimingPlan(
  projectDir: string,
  timingPlanPath: string,
  timeline: TimelineIR,
): {
  sourcePath: string;
  sourceSha256: string;
  planVersion: string;
  directCues: DirectCue[];
  words: WordTiming[];
  onsets: TimedEvent[];
  sections: TimedEvent[];
  offsetMap: TimelineOffsetMap;
} {
  const absolutePath = path.resolve(timingPlanPath);
  const { bytes, text } = readUtf8(absolutePath);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = parseYaml(text);
  }
  const root = asRecord(parsed);
  const fpsNum = timeline.sequence.fps_num;
  const fpsDen = timeline.sequence.fps_den;
  const offsetMap = buildTimelineOffsetMapFromTimeline(timeline);
  const directValues = Array.isArray(parsed)
    ? parsed
    : collectArray(root, ["cues", "lines", "timings", "line_timings", "caption_cues"]);
  const directCues = directValues.flatMap((value, ordinal): DirectCue[] => {
    const record = asRecord(value);
    if (!record) return [];
    const range = timePair(record, fpsNum, fpsDen, offsetMap);
    if (!range) return [];
    const cueId = typeof record.cue_id === "string" ? record.cue_id : undefined;
    return [{
      ordinal,
      lineId: lineIdFromRecord(record),
      lineNumber: lineNumberFromRecord(record),
      text: textFromRecord(record),
      confidence: finiteNumber(record, ["confidence", "score"]),
      range,
      sourceRefs: [{
        kind: "timing_plan_cue",
        ...(cueId ? { id: cueId } : {}),
        ...(range.startUs !== undefined ? { start_us: range.startUs } : {}),
        ...(range.endUs !== undefined ? { end_us: range.endUs } : {}),
      }],
    }];
  });

  const sttRoot = asRecord(root?.stt) ?? asRecord(root?.speech);
  const wordValues = collectArray(root, ["words", "stt_words", "word_timing"]);
  const words = [...wordValues, ...collectArray(sttRoot, ["words", "word_timing"])].flatMap((value, ordinal): WordTiming[] => {
    const record = asRecord(value);
    if (!record) return [];
    const range = timePair(record, fpsNum, fpsDen, offsetMap);
    const textValue = typeof record.word === "string" ? record.word : typeof record.text === "string" ? record.text : "";
    if (!range || textValue.length === 0) return [];
    return [{
      ordinal,
      id: typeof record.word_id === "string" ? record.word_id : typeof record.id === "string" ? record.id : undefined,
      text: textValue,
      lineId: lineIdFromRecord(record),
      lineNumber: lineNumberFromRecord(record),
      confidence: finiteNumber(record, ["confidence", "score"]),
      range,
    }];
  });

  const parseEvents = (values: unknown[], kind: TimedEvent["kind"]): TimedEvent[] => values.flatMap((value, ordinal): TimedEvent[] => {
    const record = asRecord(value);
    if (!record) return [];
    const range = timePair(record, fpsNum, fpsDen);
    if (!range) return [];
    return [{
      ordinal,
      id: typeof record.id === "string" ? record.id : typeof record.event_id === "string" ? record.event_id : undefined,
      confidence: finiteNumber(record, ["confidence", "score", "strength"]),
      range,
      kind,
      label: typeof record.label === "string" ? record.label : typeof record.section === "string" ? record.section : undefined,
    }];
  });

  return {
    sourcePath: pathForArtifact(projectDir, absolutePath),
    sourceSha256: sha256Bytes(bytes),
    planVersion: typeof root?.version === "string" ? root.version : AUTHORED_TIMING_PLAN_VERSION,
    directCues,
    words,
    onsets: parseEvents(collectArray(root, ["onsets", "onset_events", "beats"]), "onset"),
    sections: parseEvents(collectArray(root, ["sections", "section_cues", "section_starts"]), "section_cue"),
    offsetMap,
  };
}

function makeTextAuthority(projectDir: string, lyricsPath: string): AuthoredTextAuthority {
  const absolutePath = path.resolve(lyricsPath);
  const { bytes, text } = readUtf8(absolutePath);
  const rawLines = text.split(/\r\n|\n|\r/);
  // A terminal line ending terminates the final authored line; it does not
  // create an additional lyric cue. The original bytes remain authoritative
  // in source_sha256/body_sha256.
  if (rawLines.length > 1 && rawLines[rawLines.length - 1] === "") rawLines.pop();
  const lines = rawLines.map((line, index) => ({
    line_id: `AL_${String(index + 1).padStart(4, "0")}`,
    line_number: index + 1,
    text: line,
    text_sha256: sha256Bytes(Buffer.from(line, "utf8")),
  }));
  const sourceSha256 = sha256Bytes(bytes);
  return {
    authority: "authored",
    source_path: pathForArtifact(projectDir, absolutePath),
    source_sha256: sourceSha256,
    source_hash: sourceSha256,
    declared_normalization: "preserve_bytes",
    line_ending_mode: "preserved",
    line_count: lines.length,
    body_sha256: sourceSha256,
    lines,
  };
}

function cueMatchesLine(cue: DirectCue, line: AuthoredTextLine, ordinal: number): boolean {
  if (cue.lineId) return cue.lineId === line.line_id || cue.lineId === `line_${line.line_number}`;
  if (cue.lineNumber !== undefined) return cue.lineNumber === line.line_number;
  if (cue.text !== undefined) return normalizeLineText(cue.text) === normalizeLineText(line.text);
  return cue.ordinal === ordinal;
}

function candidateStatus(confidence: number, hasTiming: boolean): AuthoredCueStatus {
  if (!hasTiming || confidence <= 0) return "unmatched";
  return confidence < AUTHORED_CONFIDENCE_THRESHOLD ? "human_confirmation_pending" : "matched";
}

function wordCandidate(
  line: AuthoredTextLine,
  ordinal: number,
  words: WordTiming[],
  language: string,
  cursor: { value: number },
): Candidate | undefined {
  const explicit = words.filter((word) =>
    word.lineId === line.line_id || word.lineNumber === line.line_number,
  );
  let selected = explicit;
  if (selected.length === 0 && words.length > cursor.value) {
    const targetTokens = tokens(line.text, language);
    const expectedLength = Math.max(1, targetTokens.length);
    let best: { start: number; end: number; score: number } | undefined;
    const startLimit = Math.min(words.length - 1, cursor.value + 4);
    for (let start = cursor.value; start <= startLimit; start += 1) {
      for (let length = 1; length <= Math.min(words.length - start, expectedLength + 2); length += 1) {
        const end = start + length;
        const score = textSimilarity(line.text, words.slice(start, end).map((word) => word.text).join(" "), language);
        if (!best || score > best.score || (score === best.score && start < best.start)) best = { start, end, score };
      }
    }
    if (best) {
      selected = words.slice(best.start, best.end);
      cursor.value = best.end;
    }
  } else if (selected.length > 0) {
    cursor.value = Math.max(cursor.value, Math.max(...selected.map((word) => word.ordinal + 1)));
  }
  if (selected.length === 0) return undefined;
  const first = selected[0];
  const last = selected[selected.length - 1];
  const averageConfidence = selected.reduce((sum, word) => sum + clampConfidence(word.confidence, 0.8), 0) / selected.length;
  const similarity = textSimilarity(line.text, selected.map((word) => word.text).join(" "), language);
  const confidence = Math.round(averageConfidence * similarity * 100) / 100;
  return {
    line,
    status: candidateStatus(confidence, true),
    confidence,
    sourceKind: "stt_word_timing",
    sourceRefs: selected.map((word) => ({
      kind: "stt_word" as const,
      ...(word.id ? { id: word.id } : {}),
      text: word.text,
      ...(word.range.startUs !== undefined ? { start_us: word.range.startUs } : {}),
      ...(word.range.endUs !== undefined ? { end_us: word.range.endUs } : {}),
      ...(word.confidence !== undefined ? { confidence: word.confidence } : {}),
    })),
    rawStartFrame: first.range.startFrame,
    rawEndFrame: Math.max(first.range.startFrame + 1, last.range.endFrame),
  };
}

function eventCandidate(
  line: AuthoredTextLine,
  event: TimedEvent,
): Candidate {
  const confidence = clampConfidence(event.confidence, event.kind === "onset" ? 0.55 : 0.5);
  return {
    line,
    status: candidateStatus(confidence, true),
    confidence,
    sourceKind: event.kind,
    sourceRefs: [{
      kind: event.kind,
      ...(event.id ? { id: event.id } : {}),
      ...(event.label ? { text: event.label } : {}),
      ...(event.range.startUs !== undefined ? { start_us: event.range.startUs } : {}),
      ...(event.range.endUs !== undefined ? { end_us: event.range.endUs } : {}),
      ...(event.confidence !== undefined ? { confidence: event.confidence } : {}),
    }],
    rawStartFrame: event.range.startFrame,
    rawEndFrame: Math.max(event.range.startFrame + 1, event.range.endFrame),
  };
}

function timelineEndFrame(timeline: TimelineIR): number {
  let end = timeline.sequence.start_frame;
  for (const tracks of Object.values(timeline.tracks)) {
    for (const track of tracks ?? []) {
      for (const clip of track.clips ?? []) {
        end = Math.max(end, clip.timeline_in_frame + clip.timeline_duration_frames);
      }
    }
  }
  return Math.max(end, timeline.sequence.start_frame + 1);
}

function sourceKindToTimingSource(kind: Candidate["sourceKind"]): NonNullable<SpeechCaption["timing"]>["source"] {
  switch (kind) {
    case "direct_cue": return "authored_timing_plan";
    case "stt_word_timing": return "authored_stt_word_timing";
    case "onset": return "authored_onset";
    case "section_cue": return "authored_section_cue";
    default: return "authored_unmatched";
  }
}

function sourceKindToAuthorityKind(kind: Candidate["sourceKind"]): AuthoredTimingSourceRef["kind"] | undefined {
  if (kind === "direct_cue") return "timing_plan_cue";
  if (kind === "stt_word_timing") return "stt_word";
  if (kind === "onset") return "onset";
  if (kind === "section_cue") return "section_cue";
  return undefined;
}

function buildApprovalProjectionInput(
  source: CaptionSource,
): CaptionApproval {
  return {
    ...createDraftApproval(source, "preview-only", "1970-01-01T00:00:00.000Z"),
    approval: { status: "stale" },
  };
}

export function hashAuthoredTextAuthority(authority: AuthoredTextAuthority): string {
  return hashAuthoredCanonical({
    source_sha256: authority.source_sha256,
    declared_normalization: authority.declared_normalization,
    line_ending_mode: authority.line_ending_mode,
    lines: authority.lines.map((line) => ({
      line_id: line.line_id,
      line_number: line.line_number,
      text: line.text,
      text_sha256: line.text_sha256,
    })),
  });
}

export function hashAuthoredTimingAuthority(authority: AuthoredTimingAuthority): string {
  return hashAuthoredCanonical({
    source_sha256: authority.source_sha256,
    declared_normalization: authority.declared_normalization,
    plan_version: authority.plan_version,
    alignment_version: authority.alignment_version,
    confidence_threshold: authority.confidence_threshold,
    cues: authority.cues.map((cue) => ({
      cue_id: cue.cue_id,
      line_id: cue.line_id,
      line_number: cue.line_number,
      status: cue.status,
      confidence: cue.confidence,
      source_kind: cue.source_kind,
      source_refs: cue.source_refs,
      timeline_in_frame: cue.timeline_in_frame,
      timeline_duration_frames: cue.timeline_duration_frames,
    })),
  });
}

export function buildAuthoredCaptionArtifacts(options: BuildAuthoredCaptionOptions): AuthoredCaptionArtifacts {
  const fps = options.timeline.sequence.fps_num / options.timeline.sequence.fps_den;
  const gapFrames = Math.max(0, Math.floor(options.gapFrames ?? AUTHORED_INTER_CAPTION_GAP_FRAMES));
  const textAuthority = makeTextAuthority(options.projectDir, options.lyricsPath);
  const timingPlan = parseTimingPlan(options.projectDir, options.timingPlanPath, options.timeline);
  const maxCps = options.maxCps ?? (options.captionPolicy.language.toLowerCase().startsWith("ja") ? 6 : 15);
  const nonEmptyOrdinal = new Map<number, number>();
  let nonEmptyIndex = 0;
  for (const line of textAuthority.lines) {
    if (line.text.length > 0) nonEmptyOrdinal.set(line.line_number, nonEmptyIndex++);
  }
  const wordCursor = { value: 0 };
  let onsetCursor = 0;
  let sectionCursor = 0;
  const usedDirect = new Set<number>();
  const candidates: Candidate[] = textAuthority.lines.filter((line) => line.text.length > 0).map((line, lineIndex) => {
    const directIndex = timingPlan.directCues.findIndex((cue, index) => !usedDirect.has(index) && cueMatchesLine(cue, line, lineIndex));
    if (directIndex >= 0) {
      usedDirect.add(directIndex);
      const direct = timingPlan.directCues[directIndex];
      const confidence = clampConfidence(
        direct.confidence,
        direct.text === undefined ? 0.9 : Math.max(0.1, textSimilarity(line.text, direct.text, options.captionPolicy.language)),
      );
      return {
        line,
        status: candidateStatus(confidence, true),
        confidence,
        sourceKind: "direct_cue",
        sourceRefs: direct.sourceRefs,
        rawStartFrame: direct.range!.startFrame,
        rawEndFrame: Math.max(direct.range!.startFrame + 1, direct.range!.endFrame),
      };
    }

    const word = wordCandidate(line, lineIndex, timingPlan.words, options.captionPolicy.language, wordCursor);
    if (word) return word;
    const event = timingPlan.onsets[onsetCursor];
    if (event) {
      onsetCursor += 1;
      return eventCandidate(line, event);
    }
    const section = timingPlan.sections[sectionCursor];
    if (section) {
      sectionCursor += 1;
      return eventCandidate(line, section);
    }
    return {
      line,
      status: "unmatched",
      confidence: 0,
      sourceKind: "unmatched",
      sourceRefs: [],
      rawStartFrame: 0,
      rawEndFrame: 1,
    };
  });

  const sorted = [...candidates].sort((left, right) =>
    left.rawStartFrame - right.rawStartFrame || left.line.line_number - right.line.line_number);
  const targetFrames = Math.max(1, Math.ceil((MIN_CAPTION_TARGET_DWELL_MS / 1000) * fps));
  const hardFloorFrames = Math.max(1, Math.ceil((MIN_CAPTION_HARD_FLOOR_MS / 1000) * fps));
  const projectEnd = timelineEndFrame(options.timeline);
  const geometry = new Map<string, { start: number; end: number; gap: boolean; minimum: boolean; cpsBefore: number; cpsAfter: number }>();
  for (let index = 0; index < sorted.length; index += 1) {
    const candidate = sorted[index];
    const start = Math.max(0, Math.floor(candidate.rawStartFrame));
    const rawEnd = Math.max(start + 1, Math.ceil(candidate.rawEndFrame));
    const nextStart = sorted[index + 1]?.rawStartFrame;
    const boundedNext = nextStart !== undefined && nextStart > start ? Math.max(start + 1, Math.floor(nextStart) - gapFrames) : Number.POSITIVE_INFINITY;
    let end = Math.max(rawEnd, start + targetFrames);
    if (Number.isFinite(boundedNext)) end = Math.min(end, boundedNext);
    if (!Number.isFinite(boundedNext)) end = Math.min(Math.max(end, rawEnd), Math.max(projectEnd, end));
    if (end <= start) end = start + 1;
    const durationMs = end / fps * 1000;
    const rawDurationMs = Math.max(1, rawEnd - start) / fps * 1000;
    const cpsBefore = Math.round(computeCaptionCps(candidate.line.text, rawDurationMs, options.captionPolicy.language) * 100) / 100;
    const cpsAfter = Math.round(computeCaptionCps(candidate.line.text, durationMs, options.captionPolicy.language) * 100) / 100;
    const minimum = end > rawEnd;
    const gap = nextStart !== undefined && rawEnd > end;
    if (end - start < hardFloorFrames && candidate.status === "matched") candidate.status = "human_confirmation_pending";
    if (candidate.line.text.length > 0 && cpsAfter > maxCps && candidate.status === "matched") candidate.status = "human_confirmation_pending";
    geometry.set(candidate.line.line_id, { start, end, gap, minimum, cpsBefore, cpsAfter });
  }

  const draftEntries: CaptionDraftEntry[] = candidates
    .filter((candidate) => candidate.line.text.length > 0)
    .map((candidate) => {
      const frame = geometry.get(candidate.line.line_id)!;
      const duration = frame.end - frame.start;
      const captionId = `SC_${candidate.line.line_id}`;
      const lineage = captionLineage({
        caption_id: captionId,
        root_id: captionId,
        asset_id: "__authored_lyrics__",
        segment_id: `LYRIC_${candidate.line.line_id}`,
        transcript_item_ids: [candidate.line.line_id],
        text: candidate.line.text,
        timeline_in_frame: frame.start,
        timeline_duration_frames: duration,
      });
      const timingSource = sourceKindToTimingSource(candidate.sourceKind);
      return {
        caption_id: captionId,
        asset_id: "__authored_lyrics__",
        segment_id: `LYRIC_${candidate.line.line_id}`,
        timeline_in_frame: frame.start,
        timeline_duration_frames: duration,
        text: candidate.line.text,
        transcript_ref: `authored:${textAuthority.source_sha256}`,
        transcript_item_ids: [candidate.line.line_id],
        source: "authored" as const,
        styling_class: options.captionPolicy.styling_class,
        metrics: {
          cps: frame.cpsAfter,
          dwell_ms: Math.round(duration / fps * 1000),
        },
        line_id: candidate.line.line_id,
        cue_id: `AC_${String(candidate.line.line_number).padStart(4, "0")}`,
        ...lineage,
        timing: {
          source: timingSource,
          confidence: candidate.confidence,
          ...(candidate.sourceKind === "stt_word_timing"
            ? { sourceWordRefs: candidate.sourceRefs.filter((ref) => ref.kind === "stt_word").map((ref) => ({ word: ref.text ?? "", start_us: ref.start_us ?? 0, end_us: ref.end_us ?? 0, ...(ref.confidence !== undefined ? { confidence: ref.confidence } : {}) })) }
            : {}),
          authority: "authored" as const,
          offsetMapFingerprint: timingPlan.offsetMap.fingerprint,
          triggeredFallback: candidate.status !== "matched",
          timelineInFrame: frame.start,
          timelineDurationFrames: duration,
        },
      };
    })
    .sort((left, right) => left.timeline_in_frame - right.timeline_in_frame || left.line_id!.localeCompare(right.line_id!));

  // Use the existing separation primitive as the final metric/separation pass.
  // Geometry remains explicit in the authority cues even when a collision is
  // too severe for the helper to retain a cue.
  const separated = enforceCaptionSeparation(draftEntries, gapFrames, fps, options.captionPolicy.language);
  const separatedById = new Map(separated.map((entry) => [entry.caption_id, entry]));
  for (const entry of draftEntries) {
    const finalEntry = separatedById.get(entry.caption_id);
    if (finalEntry) {
      entry.timeline_in_frame = finalEntry.timeline_in_frame;
      entry.timeline_duration_frames = finalEntry.timeline_duration_frames;
      entry.metrics = { ...finalEntry.metrics };
      if (entry.timing) {
        entry.timing.timelineInFrame = finalEntry.timeline_in_frame;
        entry.timing.timelineDurationFrames = finalEntry.timeline_duration_frames;
      }
    }
  }

  const timingCues: AuthoredTimingCue[] = candidates.map((candidate) => {
    const frame = geometry.get(candidate.line.line_id)!;
    const entry = draftEntries.find((item) => item.line_id === candidate.line.line_id);
    const finalStart = entry?.timeline_in_frame ?? frame.start;
    const finalDuration = entry?.timeline_duration_frames ?? frame.end - frame.start;
    const sourceKind = sourceKindToAuthorityKind(candidate.sourceKind);
    return {
      cue_id: `AC_${String(candidate.line.line_number).padStart(4, "0")}`,
      line_id: candidate.line.line_id,
      line_number: candidate.line.line_number,
      status: candidate.status,
      confidence: candidate.confidence,
      source_kind: candidate.sourceKind,
      source_refs: sourceKind ? candidate.sourceRefs : [],
      raw_start_frame: frame.start,
      raw_end_frame: frame.end,
      timeline_in_frame: finalStart,
      timeline_duration_frames: finalDuration,
      one_frame_gap_applied: frame.gap,
      minimum_display_duration_applied: frame.minimum,
      cps_before: frame.cpsBefore,
      cps_after: entry?.metrics.cps ?? frame.cpsAfter,
    };
  });
  const timingAuthority: AuthoredTimingAuthority = {
    authority: "timing_plan",
    source_path: timingPlan.sourcePath,
    source_sha256: timingPlan.sourceSha256,
    source_hash: timingPlan.sourceSha256,
    declared_normalization: "preserve_values",
    plan_version: timingPlan.planVersion,
    alignment_version: AUTHORED_ALIGNMENT_VERSION,
    confidence_threshold: AUTHORED_CONFIDENCE_THRESHOLD,
    cue_count: timingCues.length,
    matched_count: timingCues.filter((cue) => cue.status === "matched").length,
    pending_count: timingCues.filter((cue) => cue.status === "human_confirmation_pending").length,
    unmatched_count: timingCues.filter((cue) => cue.status === "unmatched").length,
    cues: timingCues,
  };
  const captionPolicy: CaptionPolicy = { ...options.captionPolicy, source: "authored" };
  const captionSource: CaptionSource = {
    version: "caption-draft/v2",
    project_id: options.projectId,
    base_timeline_version: options.baseTimelineVersion,
    caption_policy: captionPolicy,
    speech_captions: draftEntries,
    text_overlays: [],
    text_authority: textAuthority,
    timing_authority: timingAuthority,
  };
  const draft: CaptionDraft = {
    ...captionSource,
    draft_status: timingCues.every((cue) => cue.status === "matched") &&
      draftEntries.every((entry) => entry.metrics.cps <= maxCps && entry.timeline_duration_frames / fps * 1000 >= MIN_CAPTION_HARD_FLOOR_MS)
      ? "ready_for_human_approval"
      : "needs_operator_fix",
    degraded_count: timingCues.filter((cue) => cue.status !== "matched").length,
  };
  const previewApproval = buildApprovalProjectionInput(captionSource);
  const projectedTimeline = projectCaptionsToTimeline(options.timeline, previewApproval, fps);
  const preview: AuthoredCaptionPreview = {
    version: AUTHORED_CAPTION_PREVIEW_VERSION,
    project_id: options.projectId,
    base_timeline_hash: options.baseTimelineHash,
    projected_timeline_hash: sha256Bytes(serializeAuthoredJson(projectedTimeline)),
    approval_required: true,
    text_authority: textAuthority,
    timing_authority: timingAuthority,
    changes: {
      one_frame_gap_handling: {
        gap_frames: gapFrames,
        adjusted_cue_ids: timingCues.filter((cue) => cue.one_frame_gap_applied).map((cue) => cue.cue_id),
      },
      minimum_display_duration: {
        target_ms: MIN_CAPTION_TARGET_DWELL_MS,
        hard_floor_ms: MIN_CAPTION_HARD_FLOOR_MS,
        adjusted_cue_ids: timingCues.filter((cue) => cue.minimum_display_duration_applied).map((cue) => cue.cue_id),
      },
      cps: timingCues.filter((cue) => Math.abs(cue.cps_before - cue.cps_after) > 0.001).map((cue) => ({
        cue_id: cue.cue_id,
        before: cue.cps_before,
        after: cue.cps_after,
      })),
    },
    next_command: options.nextCommand ?? `npm run caption -- approve --project ${options.projectDir} --approved-by <human>`,
  };
  return { captionSource, captionDraft: draft, preview };
}

export function buildAuthoredCaptionApproval(
  source: CaptionSource,
  draft: CaptionDraft,
  approvedBy: string,
  approvedAt: string,
): CaptionApproval {
  if (!source.text_authority || !source.timing_authority || !draft.text_authority || !draft.timing_authority) {
    throw new Error("authored caption authority is missing from source or draft");
  }
  const sourceForApproval: CaptionSource = {
    ...source,
    speech_captions: draft.speech_captions,
    text_authority: structuredClone(draft.text_authority),
    timing_authority: structuredClone(draft.timing_authority),
  };
  return {
    ...createDraftApproval(sourceForApproval, approvedBy, approvedAt),
    text_authority: structuredClone(draft.text_authority),
    timing_authority: structuredClone(draft.timing_authority),
  };
}

export function buildAuthoredProjectionReceipt(
  projectId: string,
  baseTimelineHash: string,
  projectedTimelineHash: string,
  approval: CaptionApproval,
  approvalHash: string,
): AuthoredCaptionProjectionReceipt {
  if (!approval.text_authority || !approval.timing_authority) throw new Error("authored approval authority is missing");
  return {
    version: AUTHORED_CAPTION_PROJECTION_VERSION,
    project_id: projectId,
    base_timeline_hash: baseTimelineHash,
    projected_timeline_hash: projectedTimelineHash,
    caption_approval_sha256: approvalHash,
    caption_text_sha256: hashAuthoredTextAuthority(approval.text_authority),
    caption_timing_sha256: hashAuthoredTimingAuthority(approval.timing_authority),
    text_authority: structuredClone(approval.text_authority),
    timing_authority: structuredClone(approval.timing_authority),
    projection: {
      track_id: "C1",
      cue_count: approval.speech_captions.length,
      gap_frames: AUTHORED_INTER_CAPTION_GAP_FRAMES,
    },
  };
}

export interface AuthoredCaptionStatus {
  detected: boolean;
  status: "not_detected" | "draft_missing" | "approval_pending" | "projection_pending" | "ready" | "stale";
  text_authority?: AuthoredTextAuthority;
  timing_authority?: AuthoredTimingAuthority;
  draft_status?: CaptionDraft["draft_status"];
  approval_status?: CaptionApproval["approval"]["status"];
  unmatched_line_ids: string[];
  low_confidence_line_ids: string[];
  preview_path?: string;
  diff?: AuthoredCaptionPreview["changes"];
  projected_timeline_hash?: string;
  current_timeline_hash?: string;
  next_command: string;
  reason: string;
}

function authoredDraftBodyMatchesAuthority(draft: CaptionDraft, authority: AuthoredTextAuthority): boolean {
  const lines = authority.lines.filter((line) => line.text.length > 0);
  const entries = [...draft.speech_captions].sort((left, right) =>
    (left.line_id ?? "").localeCompare(right.line_id ?? ""));
  return entries.length === lines.length && lines.every((line, index) => {
    const entry = entries[index];
    return !!entry && entry.line_id === line.line_id && entry.cue_id === `AC_${String(line.line_number).padStart(4, "0")}` && entry.text === line.text;
  });
}

function readJsonIfExists<T>(filePath: string): T | undefined {
  if (!fs.existsSync(filePath)) return undefined;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
  } catch {
    return undefined;
  }
}

function hasCurrentReviewArtifacts(projectDir: string): boolean {
  const ready = readJsonIfExists<{ status?: string; artifacts?: Record<string, string> }>(path.join(projectDir, "06_review/review-ready-state.json"));
  if (ready?.status === "ready" && Object.values(ready.artifacts ?? {}).every((value) => value === "CURRENT")) return true;
  try {
    const state = parseYaml(fs.readFileSync(path.join(projectDir, "project_state.yaml"), "utf8")) as Record<string, unknown>;
    if (state?.review_transaction && typeof state.review_transaction === "object" && (state.review_transaction as Record<string, unknown>).status === "ready") return true;
  } catch {
    // The JSON review-ready receipt above is the normal source of truth.
  }
  return false;
}

export function authoredReviewIsCurrent(projectDir: string): boolean {
  return hasCurrentReviewArtifacts(path.resolve(projectDir));
}

export function readAuthoredCaptionStatus(projectDirInput: string): AuthoredCaptionStatus {
  const projectDir = path.resolve(projectDirInput);
  const packageDir = path.join(projectDir, "07_package");
  let blueprintAuthored = false;
  try {
    if (fs.existsSync(path.join(projectDir, "04_plan/edit_blueprint.yaml"))) {
      const parsed = parseYaml(fs.readFileSync(path.join(projectDir, "04_plan/edit_blueprint.yaml"), "utf8")) as Record<string, unknown>;
      const policy = asRecord(parsed?.caption_policy);
      blueprintAuthored = policy?.source === "authored";
    }
  } catch {
    // Status remains read-only and reports the artifact-level evidence below.
  }
  const source = readJsonIfExists<CaptionSource>(path.join(packageDir, "caption_source.json"));
  const draft = readJsonIfExists<CaptionDraft>(path.join(packageDir, "caption_draft.json"));
  const approval = readJsonIfExists<CaptionApproval>(path.join(packageDir, "caption_approval.json"));
  const preview = readJsonIfExists<AuthoredCaptionPreview>(path.join(packageDir, "caption_preview.json"));
  const receipt = readJsonIfExists<AuthoredCaptionProjectionReceipt>(path.join(packageDir, "caption_projection_receipt.json"));
  const textAuthority = draft?.text_authority ?? source?.text_authority ?? approval?.text_authority;
  const timingAuthority = draft?.timing_authority ?? source?.timing_authority ?? approval?.timing_authority;
  const detected = blueprintAuthored || !!textAuthority || source?.caption_policy?.source === "authored" || approval?.caption_policy?.source === "authored";
  const unmatched = timingAuthority?.cues.filter((cue) => cue.status === "unmatched").map((cue) => cue.line_id) ?? [];
  const lowConfidence = timingAuthority?.cues.filter((cue) => cue.status === "human_confirmation_pending").map((cue) => cue.line_id) ?? [];
  const currentTimelinePath = path.join(projectDir, "05_timeline/timeline.json");
  const currentTimelineHash = fs.existsSync(currentTimelinePath) ? sha256Bytes(fs.readFileSync(currentTimelinePath)) : undefined;
  let sourceStale = false;
  let timingStale = false;
  let draftBodyStale = false;
  if (textAuthority) {
    try { sourceStale = sha256Bytes(readUtf8(resolveArtifactPath(projectDir, textAuthority.source_path)).bytes) !== textAuthority.source_sha256; } catch { sourceStale = true; }
  }
  if (timingAuthority) {
    try { timingStale = sha256Bytes(readUtf8(resolveArtifactPath(projectDir, timingAuthority.source_path)).bytes) !== timingAuthority.source_sha256; } catch { timingStale = true; }
  }
  if (draft && textAuthority) draftBodyStale = !authoredDraftBodyMatchesAuthority(draft, textAuthority);
  const approvalCurrent = !!approval && approval.approval.status === "approved" &&
    !!draft && !!approval.text_authority && !!draft.text_authority && !!approval.timing_authority && !!draft.timing_authority &&
    hashAuthoredTextAuthority(approval.text_authority) === hashAuthoredTextAuthority(draft.text_authority) &&
    hashAuthoredTimingAuthority(approval.timing_authority) === hashAuthoredTimingAuthority(draft.timing_authority);
  const projectionCurrent = !!receipt && !!currentTimelineHash && receipt.projected_timeline_hash === currentTimelineHash &&
    !!approval && receipt.caption_approval_sha256 === sha256Bytes(fs.readFileSync(path.join(packageDir, "caption_approval.json")));
  const previewCurrent = !!preview && !!currentTimelineHash && preview.base_timeline_hash === currentTimelineHash &&
    !!draft?.text_authority && !!draft.timing_authority &&
    hashAuthoredTextAuthority(preview.text_authority) === hashAuthoredTextAuthority(draft.text_authority) &&
    hashAuthoredTimingAuthority(preview.timing_authority) === hashAuthoredTimingAuthority(draft.timing_authority);
  const nextDraftCommand = textAuthority && timingAuthority
    ? `npm run caption -- --project ${projectDir} --source authored --lyrics ${textAuthority.source_path} --timing-plan ${timingAuthority.source_path}`
    : `npm run caption -- --project ${projectDir} --source authored --lyrics <lyrics> --timing-plan <timing-plan>`;
  let status: AuthoredCaptionStatus["status"] = "not_detected";
  let reason = "no authored-lyrics caption artifacts detected";
  if (detected) {
    status = "draft_missing";
    reason = "authored caption draft and timing plan are required";
    if (sourceStale || timingStale || draftBodyStale) {
      status = "stale";
      reason = sourceStale ? "authored lyric bytes changed" : timingStale ? "timing plan bytes changed" : "draft text differs from authored body";
    } else if (draft) {
      const priorApprovalIsStale = !!approval && approval.approval.status === "approved" && !approvalCurrent;
      status = priorApprovalIsStale
        ? "stale"
        : draft.draft_status === "ready_for_human_approval" && unmatched.length === 0 && lowConfidence.length === 0
          ? "approval_pending"
          : "stale";
      reason = priorApprovalIsStale
        ? "caption approval is stale after authored text or timing evidence changed"
        : status === "approval_pending" ? "explicit human caption approval is pending" : "unmatched or low-confidence timing requires human confirmation";
      if (approvalCurrent && !projectionCurrent) {
        status = "projection_pending";
        reason = "caption approval exists but C1 projection is missing or stale";
      } else if (approvalCurrent && projectionCurrent) {
        status = "ready";
        reason = "caption approval and C1 projection are current";
      }
    }
  }
  const nextApprovalCommand = `npm run caption -- approve --project ${projectDir} --approved-by <human>`;
  const nextCommand = status === "approval_pending"
    ? nextApprovalCommand
    : status === "projection_pending"
      ? previewCurrent ? nextApprovalCommand : nextDraftCommand
      : status === "ready" ? "/review" : nextDraftCommand;
  return {
    detected,
    status,
    ...(textAuthority ? { text_authority: textAuthority } : {}),
    ...(timingAuthority ? { timing_authority: timingAuthority } : {}),
    ...(draft?.draft_status ? { draft_status: draft.draft_status } : {}),
    ...(approval?.approval.status ? { approval_status: approval.approval.status } : {}),
    unmatched_line_ids: unmatched,
    low_confidence_line_ids: lowConfidence,
    ...(preview ? { preview_path: "07_package/caption_preview.json", diff: preview.changes } : {}),
    ...((receipt?.projected_timeline_hash ?? preview?.projected_timeline_hash)
      ? { projected_timeline_hash: receipt?.projected_timeline_hash ?? preview?.projected_timeline_hash }
      : {}),
    ...(currentTimelineHash ? { current_timeline_hash: currentTimelineHash } : {}),
    next_command: nextCommand,
    reason,
  };
}

export interface AuthoredCaptionIdentity {
  caption_text_sha256: string;
  caption_timing_sha256: string;
  caption_approval_sha256: string;
  caption_projection_receipt_sha256: string;
  timeline_sha256: string;
  base_timeline_hash: string;
}

export function readAuthoredCaptionIdentity(projectDirInput: string): AuthoredCaptionIdentity | null {
  const projectDir = path.resolve(projectDirInput);
  const packageDir = path.join(projectDir, "07_package");
  const approvalPath = path.join(packageDir, "caption_approval.json");
  const receiptPath = path.join(packageDir, "caption_projection_receipt.json");
  const timelinePath = path.join(projectDir, "05_timeline/timeline.json");
  if (!fs.existsSync(approvalPath) || !fs.existsSync(receiptPath) || !fs.existsSync(timelinePath)) return null;
  const approval = readJsonIfExists<CaptionApproval>(approvalPath);
  const receipt = readJsonIfExists<AuthoredCaptionProjectionReceipt>(receiptPath);
  if (!approval?.text_authority || !approval.timing_authority || !receipt) return null;
  const timelineSha = sha256Bytes(fs.readFileSync(timelinePath));
  if (approval.approval.status !== "approved" || receipt.projected_timeline_hash !== timelineSha) return null;
  try {
    if (sha256Bytes(readUtf8(resolveArtifactPath(projectDir, approval.text_authority.source_path)).bytes) !== approval.text_authority.source_sha256 ||
      sha256Bytes(readUtf8(resolveArtifactPath(projectDir, approval.timing_authority.source_path)).bytes) !== approval.timing_authority.source_sha256) return null;
  } catch {
    return null;
  }
  const approvalSha = sha256Bytes(fs.readFileSync(approvalPath));
  const receiptSha = sha256Bytes(fs.readFileSync(receiptPath));
  if (receipt.caption_approval_sha256 !== approvalSha || receipt.caption_text_sha256 !== hashAuthoredTextAuthority(approval.text_authority) || receipt.caption_timing_sha256 !== hashAuthoredTimingAuthority(approval.timing_authority)) return null;
  return {
    caption_text_sha256: receipt.caption_text_sha256,
    caption_timing_sha256: receipt.caption_timing_sha256,
    caption_approval_sha256: approvalSha,
    caption_projection_receipt_sha256: receiptSha,
    timeline_sha256: timelineSha,
    base_timeline_hash: receipt.base_timeline_hash,
  };
}
