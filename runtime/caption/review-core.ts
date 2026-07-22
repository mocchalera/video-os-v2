import { computeNormalizedJsonHash } from "../artifacts/p1-manifest-coverage.js";
import type { CaptionDraft, CaptionDraftEntry } from "./editorial.js";
import { getLayoutPolicy } from "./line-breaker.js";

export type CaptionReviewState = "unreviewed" | "verified" | "flagged";
export type CaptionReviewSeverity = "info" | "warn" | "block";

export type CaptionReviewIssueCode =
  | "empty_text"
  | "too_many_lines"
  | "line_too_long"
  | "orphan_character"
  | "protected_term_split"
  | "unnatural_line_break"
  | "density_violation"
  | "low_timing_confidence"
  | "timing_fallback"
  | "unresolved_reveal_anchor"
  | "invalid_timing"
  | "overlap"
  | "flagged";

export interface CaptionReviewIssue {
  code: CaptionReviewIssueCode;
  severity: CaptionReviewSeverity;
  message: string;
  evidence?: string[];
}

export interface CaptionReviewMetadata {
  state: CaptionReviewState;
  edited: boolean;
  source_text: string;
  note?: string;
}

export interface ReviewedCaptionEntry extends CaptionDraftEntry {
  text_hash: string;
  review: CaptionReviewMetadata;
  issues: CaptionReviewIssue[];
  risk_score: number;
}

export interface CaptionGlossaryProposal {
  canonical: string;
  variants: string[];
  source_caption_ids: string[];
}

interface CaptionPatchBase {
  caption_id: string;
}

export type CaptionReviewOperation =
  | (CaptionPatchBase & {
      op: "replace_text";
      base_text_hash: string;
      text: string;
      category: "stt" | "proper_noun" | "kanji" | "punctuation" | "other";
    })
  | (CaptionPatchBase & {
      op: "set_line_break";
      base_text_hash: string;
      lines: [string] | [string, string];
    })
  | (CaptionPatchBase & {
      op: "split_caption";
      base_text_hash: string;
      parts: Array<{
        caption_id: string;
        text: string;
        start_frame: number;
        end_frame: number;
      }>;
    })
  | {
      op: "merge_captions";
      caption_ids: [string, string];
      base_text_hashes: [string, string];
      result: {
        caption_id: string;
        text: string;
        start_frame: number;
        end_frame: number;
      };
    }
  | (CaptionPatchBase & {
      op: "adjust_timing";
      start_frame: number;
      end_frame: number;
    })
  | (CaptionPatchBase & {
      op: "set_review_state";
      state: CaptionReviewState;
      note?: string;
    })
  | {
      op: "propose_glossary_term";
      canonical: string;
      variants: string[];
      source_caption_ids: string[];
    };

export interface CaptionReviewPatch {
  version: "caption-review-patch/v1";
  project_id: string;
  base_caption_draft_hash: string;
  base_timeline_hash: string;
  operations: CaptionReviewOperation[];
  session: {
    reviewer: string;
    started_at: string;
    updated_at: string;
    last_action_operation_count?: number;
    action_operation_counts?: number[];
  };
}

export interface CaptionReviewValidation {
  valid: boolean;
  blocking_issue_count: number;
  warning_issue_count: number;
  unreviewed_count: number;
  verified_count: number;
  edited_count: number;
  flagged_count: number;
}

export interface CaptionReviewPreview {
  version: "caption-review-preview/v1";
  project_id: string;
  base_caption_draft_hash: string;
  base_timeline_hash: string;
  caption_policy: CaptionDraft["caption_policy"];
  speech_captions: ReviewedCaptionEntry[];
  glossary_proposals: CaptionGlossaryProposal[];
  validation: CaptionReviewValidation;
}

export interface CaptionReviewDiff {
  operation_index: number;
  op: CaptionReviewOperation["op"];
  caption_ids: string[];
  before: Array<{ caption_id: string; text: string; start_frame: number; end_frame: number }>;
  after: Array<{ caption_id: string; text: string; start_frame: number; end_frame: number }>;
}

export interface CaptionReviewQueueItem {
  caption_id: string;
  timeline_in_frame: number;
  timeline_duration_frames: number;
  text: string;
  source_text: string;
  text_hash: string;
  review_state: CaptionReviewState;
  risk_score: number;
  issues: CaptionReviewIssue[];
}

export interface CaptionReviewOptions {
  fps?: number;
  protectedTerms?: string[];
}

export type ApplyCaptionReviewPatchResult =
  | { success: true; preview: CaptionReviewPreview; diffs: CaptionReviewDiff[] }
  | { success: false; errors: string[] };

const SEVERITY_SCORE: Record<CaptionReviewSeverity, number> = {
  block: 100,
  warn: 20,
  info: 5,
};

export function computeCaptionDraftHash(draft: CaptionDraft): string {
  return computeNormalizedJsonHash(draft);
}

export function computeCaptionTextHash(text: string): string {
  return computeNormalizedJsonHash({ text });
}

export function buildCaptionReviewQueue(
  draft: CaptionDraft,
  options: CaptionReviewOptions = {},
): CaptionReviewQueueItem[] {
  const entries = draft.speech_captions.map(toReviewedEntry);
  validateEntries(
    entries,
    draft.caption_policy.language,
    draft.caption_policy.styling_class,
    options,
  );
  return entries
    .map((entry) => ({
      caption_id: entry.caption_id,
      timeline_in_frame: entry.timeline_in_frame,
      timeline_duration_frames: entry.timeline_duration_frames,
      text: entry.text,
      source_text: entry.review.source_text,
      text_hash: entry.text_hash,
      review_state: entry.review.state,
      risk_score: entry.risk_score,
      issues: entry.issues,
    }))
    .sort((a, b) => b.risk_score - a.risk_score ||
      a.timeline_in_frame - b.timeline_in_frame ||
      a.caption_id.localeCompare(b.caption_id));
}

export function applyCaptionReviewPatch(
  draft: CaptionDraft,
  patch: CaptionReviewPatch,
  currentTimelineHash: string,
  options: CaptionReviewOptions = {},
): ApplyCaptionReviewPatchResult {
  const errors: string[] = [];
  const expectedDraftHash = computeCaptionDraftHash(draft);
  if (patch.version !== "caption-review-patch/v1") {
    errors.push(`Unsupported caption review patch version: ${patch.version}`);
  }
  if (patch.project_id !== draft.project_id) {
    errors.push(`Patch project_id ${patch.project_id} does not match draft ${draft.project_id}`);
  }
  if (patch.base_caption_draft_hash !== expectedDraftHash) {
    errors.push("Caption review patch is stale: base_caption_draft_hash does not match the current draft");
  }
  if (patch.base_timeline_hash !== currentTimelineHash) {
    errors.push("Caption review patch is stale: base_timeline_hash does not match the current timeline");
  }
  if (errors.length > 0) return { success: false, errors };

  const entries = draft.speech_captions.map(toReviewedEntry);
  const diffs: CaptionReviewDiff[] = [];
  const glossaryProposals: CaptionGlossaryProposal[] = [];

  for (let operationIndex = 0; operationIndex < patch.operations.length; operationIndex += 1) {
    const operation = patch.operations[operationIndex];
    const result = applyOperation(entries, operation, glossaryProposals);
    if (!result.success) {
      return { success: false, errors: [`operations/${operationIndex}: ${result.error}`] };
    }
    diffs.push({ operation_index: operationIndex, op: operation.op, ...result.diff });
  }

  entries.sort((a, b) => a.timeline_in_frame - b.timeline_in_frame ||
    a.caption_id.localeCompare(b.caption_id));
  for (const entry of entries) entry.text_hash = computeCaptionTextHash(entry.text);
  validateEntries(
    entries,
    draft.caption_policy.language,
    draft.caption_policy.styling_class,
    options,
  );

  return {
    success: true,
    diffs,
    preview: {
      version: "caption-review-preview/v1",
      project_id: draft.project_id,
      base_caption_draft_hash: expectedDraftHash,
      base_timeline_hash: currentTimelineHash,
      caption_policy: structuredClone(draft.caption_policy),
      speech_captions: entries,
      glossary_proposals: glossaryProposals,
      validation: summarizeValidation(entries),
    },
  };
}

type OperationResult =
  | { success: true; diff: Omit<CaptionReviewDiff, "operation_index" | "op"> }
  | { success: false; error: string };

function applyOperation(
  entries: ReviewedCaptionEntry[],
  operation: CaptionReviewOperation,
  glossaryProposals: CaptionGlossaryProposal[],
): OperationResult {
  if (operation.op === "propose_glossary_term") {
    if (!operation.canonical.trim()) return { success: false, error: "canonical glossary term is empty" };
    glossaryProposals.push({
      canonical: operation.canonical.trim(),
      variants: uniqueStrings(operation.variants),
      source_caption_ids: uniqueStrings(operation.source_caption_ids),
    });
    return { success: true, diff: { caption_ids: operation.source_caption_ids, before: [], after: [] } };
  }

  if (operation.op === "merge_captions") {
    const [firstId, secondId] = operation.caption_ids;
    const firstIndex = entries.findIndex((entry) => entry.caption_id === firstId);
    const secondIndex = entries.findIndex((entry) => entry.caption_id === secondId);
    if (firstIndex < 0 || secondIndex < 0) return { success: false, error: "merge target caption not found" };
    if (secondIndex !== firstIndex + 1) return { success: false, error: "merge captions must be adjacent" };
    const first = entries[firstIndex];
    const second = entries[secondIndex];
    if (computeCaptionTextHash(first.text) !== operation.base_text_hashes[0] ||
        computeCaptionTextHash(second.text) !== operation.base_text_hashes[1]) {
      return { success: false, error: "merge caption text hash mismatch" };
    }
    if (!validFrameRange(operation.result.start_frame, operation.result.end_frame)) {
      return { success: false, error: "invalid merged caption timing" };
    }
    const merged = cloneEntry(first);
    merged.caption_id = operation.result.caption_id;
    merged.text = operation.result.text.trim();
    merged.timeline_in_frame = operation.result.start_frame;
    merged.timeline_duration_frames = operation.result.end_frame - operation.result.start_frame;
    merged.transcript_item_ids = uniqueStrings([
      ...first.transcript_item_ids,
      ...second.transcript_item_ids,
    ]);
    merged.review = {
      state: "unreviewed",
      edited: true,
      source_text: `${first.review.source_text}\n${second.review.source_text}`,
    };
    const before = [snapshot(first), snapshot(second)];
    entries.splice(firstIndex, 2, merged);
    return { success: true, diff: { caption_ids: [firstId, secondId], before, after: [snapshot(merged)] } };
  }

  const index = entries.findIndex((entry) => entry.caption_id === operation.caption_id);
  if (index < 0) return { success: false, error: `caption ${operation.caption_id} not found` };
  const entry = entries[index];
  const before = [snapshot(entry)];

  if ("base_text_hash" in operation &&
      computeCaptionTextHash(entry.text) !== operation.base_text_hash) {
    return { success: false, error: `caption ${operation.caption_id} text hash mismatch` };
  }

  switch (operation.op) {
    case "replace_text":
      if (!operation.text.trim()) return { success: false, error: "replacement text is empty" };
      entry.text = operation.text.trim();
      markEdited(entry);
      break;
    case "set_line_break": {
      const lines = operation.lines.map((line) => line.trim());
      if (lines.some((line) => !line)) return { success: false, error: "line break contains an empty line" };
      entry.text = lines.join("\n");
      markEdited(entry);
      break;
    }
    case "adjust_timing":
      if (!validFrameRange(operation.start_frame, operation.end_frame)) {
        return { success: false, error: "invalid caption timing" };
      }
      entry.timeline_in_frame = operation.start_frame;
      entry.timeline_duration_frames = operation.end_frame - operation.start_frame;
      if (entry.timing) {
        entry.timing.timelineInFrame = operation.start_frame;
        entry.timing.timelineDurationFrames = operation.end_frame - operation.start_frame;
      }
      markEdited(entry);
      break;
    case "set_review_state":
      entry.review.state = operation.state;
      entry.review.note = operation.note;
      break;
    case "split_caption": {
      if (operation.parts.length < 2) return { success: false, error: "split requires at least two parts" };
      const ids = operation.parts.map((part) => part.caption_id);
      if (new Set(ids).size !== ids.length) return { success: false, error: "split caption IDs must be unique" };
      for (let partIndex = 0; partIndex < operation.parts.length; partIndex += 1) {
        const part = operation.parts[partIndex];
        if (!part.text.trim() || !validFrameRange(part.start_frame, part.end_frame)) {
          return { success: false, error: "split contains empty text or invalid timing" };
        }
        if (partIndex > 0 && part.start_frame < operation.parts[partIndex - 1].end_frame) {
          return { success: false, error: "split caption parts overlap" };
        }
      }
      const splitEntries = operation.parts.map((part) => {
        const split = cloneEntry(entry);
        split.caption_id = part.caption_id;
        split.text = part.text.trim();
        split.timeline_in_frame = part.start_frame;
        split.timeline_duration_frames = part.end_frame - part.start_frame;
        split.review = {
          state: "unreviewed",
          edited: true,
          source_text: entry.review.source_text,
        };
        return split;
      });
      entries.splice(index, 1, ...splitEntries);
      return {
        success: true,
        diff: {
          caption_ids: [operation.caption_id],
          before,
          after: splitEntries.map(snapshot),
        },
      };
    }
    default:
      return assertNever(operation);
  }

  return {
    success: true,
    diff: { caption_ids: [operation.caption_id], before, after: [snapshot(entry)] },
  };
}

function validateEntries(
  entries: ReviewedCaptionEntry[],
  language: string,
  stylingClass: string,
  options: CaptionReviewOptions,
): void {
  const fps = options.fps ?? 24;
  const policy = getLayoutPolicy(language, stylingClass);
  const protectedTerms = options.protectedTerms ?? [];
  for (const entry of entries) {
    const issues: CaptionReviewIssue[] = [];
    const lines = entry.text.split("\n");
    if (!entry.text.trim()) addIssue(issues, "empty_text", "block", "字幕本文が空です");
    if (lines.length > policy.maxLines) {
      addIssue(issues, "too_many_lines", "block", `${lines.length}行あります（最大${policy.maxLines}行）`);
    }
    if (lines.some((line) => [...line].length > policy.maxCharsPerLine)) {
      addIssue(issues, "line_too_long", "block", `1行${policy.maxCharsPerLine}文字を超えています`);
    }
    if (lines.length > 1 && lines.some((line) => [...line.trim()].length <= 1)) {
      addIssue(issues, "orphan_character", "block", "1文字だけの孤立行があります");
    }
    if (splitsProtectedTerm(entry.text, protectedTerms)) {
      addIssue(issues, "protected_term_split", "block", "固有名詞・保護語の内部で改行されています");
    }
    if (hasUnnaturalJapaneseLineBreak(entry.text, language)) {
      addIssue(issues, "unnatural_line_break", "block", "日本語の語幹・送り仮名・活用語をまたぐ改行候補です");
    }
    if (entry.timeline_duration_frames <= 0) {
      addIssue(issues, "invalid_timing", "block", "字幕の表示時間が不正です");
    } else {
      const durationSec = entry.timeline_duration_frames / fps;
      const cps = entry.text.replace(/\n/g, "").length / durationSec;
      entry.metrics = { cps: round2(cps), dwell_ms: Math.round(durationSec * 1000) };
      if (cps > policy.maxCps) {
        addIssue(issues, "density_violation", "warn", `字幕密度${round2(cps)} CPSが上限${policy.maxCps}を超えています`);
      }
    }
    if (entry.timing?.triggeredFallback) {
      addIssue(issues, "timing_fallback", "warn", "word timingを使えずclip/item timingへfallbackしています");
    }
    if (entry.timing && entry.timing.confidence < 0.75) {
      addIssue(issues, "low_timing_confidence", "warn", `timing confidenceが${entry.timing.confidence}です`);
    }
    if (entry.reveal_timing?.status === "unresolved") {
      addIssue(
        issues,
        "unresolved_reveal_anchor",
        "block",
        `情報解禁アンカー ${entry.reveal_timing.anchor_id} の音声時刻を精密に解決できません`,
      );
    }
    if (entry.review.state === "flagged") {
      addIssue(issues, "flagged", "block", entry.review.note || "人間レビューで要確認に設定されています");
    }
    entry.issues = issues;
  }

  const sorted = [...entries].sort((a, b) => a.timeline_in_frame - b.timeline_in_frame);
  for (let index = 1; index < sorted.length; index += 1) {
    const previous = sorted[index - 1];
    const current = sorted[index];
    const previousEnd = previous.timeline_in_frame + previous.timeline_duration_frames;
    if (current.timeline_in_frame < previousEnd) {
      addIssue(current.issues, "overlap", "block", `直前字幕${previous.caption_id}と重なっています`);
    }
  }
  for (const entry of entries) {
    entry.risk_score = entry.issues.reduce((sum, issue) => sum + SEVERITY_SCORE[issue.severity], 0);
  }
}

function summarizeValidation(entries: ReviewedCaptionEntry[]): CaptionReviewValidation {
  const allIssues = entries.flatMap((entry) => entry.issues);
  const blockingIssueCount = allIssues.filter((issue) => issue.severity === "block").length;
  return {
    valid: blockingIssueCount === 0 && entries.every((entry) => entry.review.state === "verified"),
    blocking_issue_count: blockingIssueCount,
    warning_issue_count: allIssues.filter((issue) => issue.severity === "warn").length,
    unreviewed_count: entries.filter((entry) => entry.review.state === "unreviewed").length,
    verified_count: entries.filter((entry) => entry.review.state === "verified").length,
    edited_count: entries.filter((entry) => entry.review.edited).length,
    flagged_count: entries.filter((entry) => entry.review.state === "flagged").length,
  };
}

function toReviewedEntry(entry: CaptionDraftEntry): ReviewedCaptionEntry {
  const sourceText = entry.editorial?.sourceText ?? entry.text;
  return {
    ...structuredClone(entry),
    text_hash: computeCaptionTextHash(entry.text),
    review: { state: "unreviewed", edited: false, source_text: sourceText },
    issues: [],
    risk_score: 0,
  };
}

function cloneEntry(entry: ReviewedCaptionEntry): ReviewedCaptionEntry {
  return structuredClone(entry);
}

function markEdited(entry: ReviewedCaptionEntry): void {
  entry.review.edited = true;
  entry.review.state = "unreviewed";
}

function snapshot(entry: ReviewedCaptionEntry): CaptionReviewDiff["before"][number] {
  return {
    caption_id: entry.caption_id,
    text: entry.text,
    start_frame: entry.timeline_in_frame,
    end_frame: entry.timeline_in_frame + entry.timeline_duration_frames,
  };
}

function validFrameRange(startFrame: number, endFrame: number): boolean {
  return Number.isInteger(startFrame) && Number.isInteger(endFrame) && startFrame >= 0 && endFrame > startFrame;
}

function addIssue(
  issues: CaptionReviewIssue[],
  code: CaptionReviewIssueCode,
  severity: CaptionReviewSeverity,
  message: string,
): void {
  if (!issues.some((issue) => issue.code === code)) issues.push({ code, severity, message });
}

function splitsProtectedTerm(text: string, protectedTerms: string[]): boolean {
  if (!text.includes("\n")) return false;
  const flat = text.replace(/\n/g, "");
  const breakOffsets: number[] = [];
  let flatOffset = 0;
  for (const char of text) {
    if (char === "\n") breakOffsets.push(flatOffset);
    else flatOffset += 1;
  }
  for (const term of protectedTerms.filter(Boolean)) {
    let start = flat.indexOf(term);
    while (start >= 0) {
      if (breakOffsets.some((offset) => offset > start && offset < start + term.length)) return true;
      start = flat.indexOf(term, start + 1);
    }
  }
  return false;
}

function hasUnnaturalJapaneseLineBreak(text: string, language: string): boolean {
  if (!language.startsWith("ja") || !text.includes("\n")) return false;
  const lines = text.split("\n");
  for (let index = 1; index < lines.length; index += 1) {
    const left = lines[index - 1].trim();
    const right = lines[index].trim();
    if (!left || !right) return true;
    if (/[一-龯々][ぁ-ゖ]{0,4}[たな]$/.test(left) && /^[いくけ]/.test(right)) return true;
    if (/[一-龯々]$/.test(left) && /^[ぁ-ゖ]/.test(right) && !/^[はがをにでとのへもやか]/.test(right)) return true;
    if (/[A-Za-z0-9]$/.test(left) && /^[A-Za-z0-9]/.test(right)) return true;
  }
  return false;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function assertNever(value: never): OperationResult {
  return { success: false, error: `Unsupported caption review operation: ${JSON.stringify(value)}` };
}
