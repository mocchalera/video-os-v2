import * as fs from "node:fs";
import * as path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { computeNormalizedJsonHash } from "../artifacts/p1-manifest-coverage.js";
import { atomicWriteJson } from "../pipeline/stages/_util.js";
import {
  createDraftApproval,
  type CaptionApproval,
} from "./approval.js";
import {
  buildGlossary,
  type CaptionDraft,
  type CaptionDraftEntry,
} from "./editorial.js";
import { loadProjectCaptionGlossary } from "./project-glossary.js";
import {
  applyCaptionReviewPatch,
  buildCaptionReviewQueue,
  computeCaptionDraftHash,
  type CaptionReviewDiff,
  type CaptionGlossaryProposal,
  type CaptionReviewPatch,
  type CaptionReviewPreview,
  type CaptionReviewQueueItem,
  type CaptionReviewState,
} from "./review-core.js";

const require = createRequire(import.meta.url);
const Ajv2020 = require("ajv/dist/2020") as new (options: Record<string, unknown>) => {
  compile(schema: object): {
    (data: unknown): boolean;
    errors?: Array<{ instancePath: string; message?: string }> | null;
  };
};
const addFormats = require("ajv-formats") as (ajv: unknown) => void;

const SCHEMA_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../schemas",
);

export const CAPTION_DRAFT_PATH = "07_package/caption_draft.json";
export const CAPTION_REVIEW_PATCH_PATH = "07_package/caption_review_patch.json";
export const CAPTION_REVIEW_PREVIEW_PATH = "07_package/caption_review_preview.json";
export const CAPTION_APPROVAL_PATH = "07_package/caption_approval.json";
export const TIMELINE_PATH = "05_timeline/timeline.json";

export interface CaptionReviewContext {
  projectDir: string;
  draft: CaptionDraft;
  timeline: unknown;
  timelineHash: string;
  fps: number;
  protectedTerms: string[];
}

export interface ApplyCaptionReviewResult {
  patch: CaptionReviewPatch;
  preview: CaptionReviewPreview;
  diffs: CaptionReviewDiff[];
  patchPath: string;
  previewPath: string;
}

export interface ValidateCaptionReviewResult {
  valid: boolean;
  patch?: CaptionReviewPatch;
  preview?: CaptionReviewPreview;
  diffs?: CaptionReviewDiff[];
  errors: string[];
}

export interface ApproveCaptionReviewResult {
  approval: CaptionApproval;
  approvalPath: string;
  patchHash: string;
  validationHash: string;
}

export interface EditCaptionReviewOptions {
  captionID: string;
  text?: string;
  state?: CaptionReviewState;
  startFrame?: number;
  endFrame?: number;
  expectedTextHash?: string;
  note?: string;
  category?: "stt" | "proper_noun" | "kanji" | "punctuation" | "other";
  updatedAt?: string;
}

export interface SplitCaptionReviewOptions {
  captionID: string;
  splitFrame: number;
  firstText?: string;
  secondText?: string;
  expectedTextHash?: string;
  updatedAt?: string;
}

export interface MergeCaptionReviewOptions {
  firstCaptionID: string;
  secondCaptionID: string;
  text?: string;
  expectedFirstTextHash?: string;
  expectedSecondTextHash?: string;
  updatedAt?: string;
}

export interface ProposeCaptionGlossaryOptions {
  canonical: string;
  variants?: string[];
  sourceCaptionIDs: string[];
  updatedAt?: string;
}

export function loadCaptionReviewContext(projectDir: string): CaptionReviewContext {
  const absoluteProjectDir = path.resolve(projectDir);
  const draft = readRequiredJson<CaptionDraft>(absoluteProjectDir, CAPTION_DRAFT_PATH);
  const timeline = readRequiredJson<unknown>(absoluteProjectDir, TIMELINE_PATH);
  const glossary = loadProjectCaptionGlossary(absoluteProjectDir);
  return {
    projectDir: absoluteProjectDir,
    draft,
    timeline,
    timelineHash: computeNormalizedJsonHash(timeline),
    fps: timelineFps(timeline),
    protectedTerms: buildGlossary(glossary.sources),
  };
}

export function queueCaptionReview(
  projectDir: string,
  patchInputPath?: string,
): CaptionReviewQueueItem[] {
  const context = loadCaptionReviewContext(projectDir);
  const canonicalPatchPath = path.join(context.projectDir, CAPTION_REVIEW_PATCH_PATH);
  const activePatchPath = patchInputPath
    ? path.resolve(patchInputPath)
    : fs.existsSync(canonicalPatchPath) ? canonicalPatchPath : undefined;
  if (activePatchPath) {
    const patch = readJsonFile<CaptionReviewPatch>(activePatchPath);
    assertSchema("caption-review-patch.schema.json", patch);
    const result = evaluateCaptionReviewPatch(context, patch);
    return result.preview.speech_captions
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
  return buildCaptionReviewQueue(context.draft, {
    fps: context.fps,
    protectedTerms: context.protectedTerms,
  });
}

export function canUndoCaptionReview(projectDir: string): boolean {
  const patchPath = path.join(path.resolve(projectDir), CAPTION_REVIEW_PATCH_PATH);
  if (!fs.existsSync(patchPath)) return false;
  const patch = readJsonFile<CaptionReviewPatch>(patchPath);
  assertSchema("caption-review-patch.schema.json", patch);
  return captionReviewUndoDepthFromPatch(patch) > 0;
}

export function captionReviewUndoDepth(projectDir: string): number {
  const patchPath = path.join(path.resolve(projectDir), CAPTION_REVIEW_PATCH_PATH);
  if (!fs.existsSync(patchPath)) return 0;
  const patch = readJsonFile<CaptionReviewPatch>(patchPath);
  assertSchema("caption-review-patch.schema.json", patch);
  return captionReviewUndoDepthFromPatch(patch);
}

export function captionGlossaryProposals(projectDir: string): CaptionGlossaryProposal[] {
  const context = loadCaptionReviewContext(projectDir);
  const patchPath = path.join(context.projectDir, CAPTION_REVIEW_PATCH_PATH);
  if (!fs.existsSync(patchPath)) return [];
  const patch = readJsonFile<CaptionReviewPatch>(patchPath);
  assertSchema("caption-review-patch.schema.json", patch);
  return evaluateCaptionReviewPatch(context, patch).preview.glossary_proposals;
}

export function initializeCaptionReviewPatch(
  projectDir: string,
  reviewer: string,
  options: { outputPath?: string; now?: string; overwrite?: boolean } = {},
): { patch: CaptionReviewPatch; patchPath: string } {
  const actor = reviewer.trim();
  if (!actor) throw new Error("reviewer is required");
  const context = loadCaptionReviewContext(projectDir);
  const patchPath = options.outputPath
    ? path.resolve(options.outputPath)
    : path.join(context.projectDir, CAPTION_REVIEW_PATCH_PATH);
  if (fs.existsSync(patchPath) && !options.overwrite) {
    throw new Error(`Caption review patch already exists: ${patchPath}`);
  }
  const timestamp = options.now ?? new Date().toISOString();
  const patch: CaptionReviewPatch = {
    version: "caption-review-patch/v1",
    project_id: context.draft.project_id,
    base_caption_draft_hash: computeCaptionDraftHash(context.draft),
    base_timeline_hash: context.timelineHash,
    operations: [],
    session: {
      reviewer: actor,
      started_at: timestamp,
      updated_at: timestamp,
    },
  };
  assertSchema("caption-review-patch.schema.json", patch);
  atomicWriteJson(patchPath, patch);
  return { patch, patchPath };
}

export function applyCaptionReview(
  projectDir: string,
  patchInputPath?: string,
): ApplyCaptionReviewResult {
  const context = loadCaptionReviewContext(projectDir);
  const sourcePath = patchInputPath
    ? path.resolve(patchInputPath)
    : path.join(context.projectDir, CAPTION_REVIEW_PATCH_PATH);
  const patch = readJsonFile<CaptionReviewPatch>(sourcePath);
  assertSchema("caption-review-patch.schema.json", patch);
  const result = evaluateCaptionReviewPatch(context, patch);

  const canonicalPatchPath = path.join(context.projectDir, CAPTION_REVIEW_PATCH_PATH);
  const previewPath = path.join(context.projectDir, CAPTION_REVIEW_PREVIEW_PATH);
  atomicWriteJson(canonicalPatchPath, patch);
  atomicWriteJson(previewPath, result.preview);
  return {
    patch,
    preview: result.preview,
    diffs: result.diffs,
    patchPath: canonicalPatchPath,
    previewPath,
  };
}

export function editCaptionReview(
  projectDir: string,
  options: EditCaptionReviewOptions,
): ApplyCaptionReviewResult {
  const context = loadCaptionReviewContext(projectDir);
  const patchPath = path.join(context.projectDir, CAPTION_REVIEW_PATCH_PATH);
  const patch = readJsonFile<CaptionReviewPatch>(patchPath);
  assertSchema("caption-review-patch.schema.json", patch);
  const current = evaluateCaptionReviewPatch(context, patch);
  const entry = current.preview.speech_captions.find(
    (candidate) => candidate.caption_id === options.captionID,
  );
  if (!entry) throw new Error(`caption ${options.captionID} not found`);
  assertExpectedTextHash(entry.caption_id, entry.text_hash, options.expectedTextHash);

  const operationCountBefore = patch.operations.length;
  if (options.text !== undefined && options.text !== entry.text) {
    const text = options.text.trim();
    if (!text) throw new Error("replacement text is empty");
    patch.operations.push({
      op: "replace_text",
      caption_id: entry.caption_id,
      base_text_hash: entry.text_hash,
      text,
      category: options.category ?? "other",
    });
  }
  const currentEndFrame = entry.timeline_in_frame + entry.timeline_duration_frames;
  const startFrame = options.startFrame ?? entry.timeline_in_frame;
  const endFrame = options.endFrame ?? currentEndFrame;
  if (startFrame !== entry.timeline_in_frame || endFrame !== currentEndFrame) {
    patch.operations.push({
      op: "adjust_timing",
      caption_id: entry.caption_id,
      start_frame: startFrame,
      end_frame: endFrame,
    });
  }
  const changed = patch.operations.length > operationCountBefore;
  if (options.state !== undefined &&
      (options.state !== entry.review.state || options.note !== entry.review.note || changed)) {
    patch.operations.push({
      op: "set_review_state",
      caption_id: entry.caption_id,
      state: options.state,
      ...(options.note === undefined ? {} : { note: options.note }),
    });
  }
  if (patch.operations.length === operationCountBefore) {
    throw new Error("caption review edit does not change text, timing, or review state");
  }
  return persistCaptionReviewMutation(
    context,
    patch,
    patchPath,
    patch.operations.length - operationCountBefore,
    options.updatedAt,
  );
}

export function splitCaptionReview(
  projectDir: string,
  options: SplitCaptionReviewOptions,
): ApplyCaptionReviewResult {
  const { context, patch, patchPath, preview } = loadMutableCaptionReview(projectDir);
  const entry = preview.speech_captions.find((candidate) => candidate.caption_id === options.captionID);
  if (!entry) throw new Error(`caption ${options.captionID} not found`);
  assertExpectedTextHash(entry.caption_id, entry.text_hash, options.expectedTextHash);
  const endFrame = entry.timeline_in_frame + entry.timeline_duration_frames;
  if (options.splitFrame <= entry.timeline_in_frame || options.splitFrame >= endFrame) {
    throw new Error(`split frame must be inside caption ${entry.caption_id}`);
  }
  const [fallbackFirst, fallbackSecond] = splitCaptionText(entry.text);
  const firstText = (options.firstText ?? fallbackFirst).trim();
  const secondText = (options.secondText ?? fallbackSecond).trim();
  if (!firstText || !secondText) throw new Error("split caption parts must contain text");
  const existingIDs = new Set(preview.speech_captions.map((candidate) => candidate.caption_id));
  const firstID = uniqueCaptionID(`${entry.caption_id}_A`, existingIDs);
  existingIDs.add(firstID);
  const secondID = uniqueCaptionID(`${entry.caption_id}_B`, existingIDs);
  patch.operations.push({
    op: "split_caption",
    caption_id: entry.caption_id,
    base_text_hash: entry.text_hash,
    parts: [
      { caption_id: firstID, text: firstText, start_frame: entry.timeline_in_frame, end_frame: options.splitFrame },
      { caption_id: secondID, text: secondText, start_frame: options.splitFrame, end_frame: endFrame },
    ],
  });
  return persistCaptionReviewMutation(context, patch, patchPath, 1, options.updatedAt);
}

export function mergeCaptionReview(
  projectDir: string,
  options: MergeCaptionReviewOptions,
): ApplyCaptionReviewResult {
  const { context, patch, patchPath, preview } = loadMutableCaptionReview(projectDir);
  const ordered = [...preview.speech_captions].sort((a, b) =>
    a.timeline_in_frame - b.timeline_in_frame || a.caption_id.localeCompare(b.caption_id));
  const firstIndex = ordered.findIndex((entry) => entry.caption_id === options.firstCaptionID);
  const secondIndex = ordered.findIndex((entry) => entry.caption_id === options.secondCaptionID);
  if (firstIndex < 0 || secondIndex < 0) throw new Error("merge target caption not found");
  if (secondIndex !== firstIndex + 1) throw new Error("merge captions must be adjacent in timeline order");
  const first = ordered[firstIndex];
  const second = ordered[secondIndex];
  assertExpectedTextHash(first.caption_id, first.text_hash, options.expectedFirstTextHash);
  assertExpectedTextHash(second.caption_id, second.text_hash, options.expectedSecondTextHash);
  patch.operations.push({
    op: "merge_captions",
    caption_ids: [first.caption_id, second.caption_id],
    base_text_hashes: [first.text_hash, second.text_hash],
    result: {
      caption_id: first.caption_id,
      text: (options.text ?? joinCaptionText(first.text, second.text)).trim(),
      start_frame: first.timeline_in_frame,
      end_frame: second.timeline_in_frame + second.timeline_duration_frames,
    },
  });
  return persistCaptionReviewMutation(context, patch, patchPath, 1, options.updatedAt);
}

export function proposeCaptionGlossaryTerm(
  projectDir: string,
  options: ProposeCaptionGlossaryOptions,
): ApplyCaptionReviewResult {
  const { context, patch, patchPath, preview } = loadMutableCaptionReview(projectDir);
  const canonical = options.canonical.trim();
  if (!canonical) throw new Error("canonical glossary term is required");
  const sourceCaptionIDs = uniqueStrings(options.sourceCaptionIDs);
  if (sourceCaptionIDs.length === 0) throw new Error("at least one source caption is required");
  const availableCaptionIDs = new Set(preview.speech_captions.map((entry) => entry.caption_id));
  const missing = sourceCaptionIDs.filter((captionID) => !availableCaptionIDs.has(captionID));
  if (missing.length > 0) throw new Error(`glossary source caption not found: ${missing.join(", ")}`);
  const variants = uniqueStrings(options.variants ?? [])
    .filter((variant) => variant !== canonical);
  const duplicate = preview.glossary_proposals.some((proposal) =>
    proposal.canonical === canonical &&
    proposal.variants.length === variants.length &&
    proposal.variants.every((variant) => variants.includes(variant)) &&
    proposal.source_caption_ids.length === sourceCaptionIDs.length &&
    proposal.source_caption_ids.every((captionID) => sourceCaptionIDs.includes(captionID))
  );
  if (duplicate) throw new Error("the same glossary proposal already exists");
  patch.operations.push({
    op: "propose_glossary_term",
    canonical,
    variants,
    source_caption_ids: sourceCaptionIDs,
  });
  return persistCaptionReviewMutation(context, patch, patchPath, 1, options.updatedAt);
}

export function undoCaptionReview(
  projectDir: string,
  updatedAt?: string,
): ApplyCaptionReviewResult {
  const { context, patch, patchPath } = loadMutableCaptionReview(projectDir);
  const history = normalizedActionHistory(patch);
  const operationCount = history.pop() ?? 0;
  if (operationCount <= 0 || operationCount > patch.operations.length) {
    throw new Error("no caption review action is available to undo");
  }
  patch.operations.splice(patch.operations.length - operationCount, operationCount);
  patch.session.action_operation_counts = history;
  patch.session.last_action_operation_count = history.at(-1) ?? 0;
  return persistCaptionReviewMutation(context, patch, patchPath, 0, updatedAt, false);
}

function loadMutableCaptionReview(projectDir: string): {
  context: CaptionReviewContext;
  patch: CaptionReviewPatch;
  patchPath: string;
  preview: CaptionReviewPreview;
} {
  const context = loadCaptionReviewContext(projectDir);
  const patchPath = path.join(context.projectDir, CAPTION_REVIEW_PATCH_PATH);
  const patch = readJsonFile<CaptionReviewPatch>(patchPath);
  assertSchema("caption-review-patch.schema.json", patch);
  const preview = evaluateCaptionReviewPatch(context, patch).preview;
  return { context, patch, patchPath, preview };
}

function persistCaptionReviewMutation(
  context: CaptionReviewContext,
  patch: CaptionReviewPatch,
  patchPath: string,
  operationCount: number,
  updatedAt?: string,
  recordAction = true,
): ApplyCaptionReviewResult {
  patch.session.updated_at = updatedAt ?? new Date().toISOString();
  if (recordAction && operationCount > 0) {
    const history = normalizedActionHistory(patch);
    history.push(operationCount);
    patch.session.action_operation_counts = history;
    patch.session.last_action_operation_count = operationCount;
  }
  assertSchema("caption-review-patch.schema.json", patch);
  const result = evaluateCaptionReviewPatch(context, patch);
  const previewPath = path.join(context.projectDir, CAPTION_REVIEW_PREVIEW_PATH);
  atomicWriteJson(patchPath, patch);
  atomicWriteJson(previewPath, result.preview);
  return { patch, preview: result.preview, diffs: result.diffs, patchPath, previewPath };
}

function normalizedActionHistory(patch: CaptionReviewPatch): number[] {
  const explicit = patch.session.action_operation_counts;
  if (explicit) return explicit.filter((count) => count > 0);
  const legacy = patch.session.last_action_operation_count ?? 0;
  return legacy > 0 ? [legacy] : [];
}

function captionReviewUndoDepthFromPatch(patch: CaptionReviewPatch): number {
  const history = normalizedActionHistory(patch);
  let remaining = patch.operations.length;
  let validDepth = 0;
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const count = history[index];
    if (count > remaining) break;
    remaining -= count;
    validDepth += 1;
  }
  return validDepth;
}

function assertExpectedTextHash(captionID: string, current: string, expected?: string): void {
  if (expected !== undefined && expected !== current) {
    throw new Error(`caption ${captionID} changed since it was loaded; reload before editing`);
  }
}

function splitCaptionText(text: string): [string, string] {
  const flat = text.replace(/\n/g, "").trim();
  if ([...flat].length < 2) throw new Error("caption text is too short to split");
  const characters = [...flat];
  const center = Math.floor(characters.length / 2);
  const punctuation = new Set(["。", "、", "！", "？", "!", "?", ",", "."]);
  let splitIndex = center;
  for (let distance = 0; distance < characters.length; distance += 1) {
    const right = center + distance;
    const left = center - distance;
    if (right > 0 && right < characters.length && punctuation.has(characters[right - 1])) {
      splitIndex = right;
      break;
    }
    if (left > 0 && left < characters.length && punctuation.has(characters[left - 1])) {
      splitIndex = left;
      break;
    }
  }
  return [characters.slice(0, splitIndex).join(""), characters.slice(splitIndex).join("")];
}

function uniqueCaptionID(preferred: string, existing: Set<string>): string {
  if (!existing.has(preferred)) return preferred;
  for (let suffix = 2; suffix < 10_000; suffix += 1) {
    const candidate = `${preferred}_${suffix}`;
    if (!existing.has(candidate)) return candidate;
  }
  throw new Error(`unable to allocate split caption ID from ${preferred}`);
}

function joinCaptionText(first: string, second: string): string {
  const left = first.trim();
  const right = second.trim();
  if (!left || !right) return `${left}${right}`;
  return /[A-Za-z0-9]$/.test(left) && /^[A-Za-z0-9]/.test(right)
    ? `${left} ${right}`
    : `${left}${right}`;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

export function validateCaptionReview(
  projectDir: string,
  patchInputPath?: string,
): ValidateCaptionReviewResult {
  try {
    const context = loadCaptionReviewContext(projectDir);
    const sourcePath = patchInputPath
      ? path.resolve(patchInputPath)
      : path.join(context.projectDir, CAPTION_REVIEW_PATCH_PATH);
    const patch = readJsonFile<CaptionReviewPatch>(sourcePath);
    assertSchema("caption-review-patch.schema.json", patch);
    const result = applyCaptionReviewPatch(context.draft, patch, context.timelineHash, {
      fps: context.fps,
      protectedTerms: context.protectedTerms,
    });
    if (!result.success) {
      return { valid: false, patch, errors: result.errors };
    }
    assertSchema("caption-review-preview.schema.json", result.preview);
    return {
      valid: result.preview.validation.valid,
      patch,
      preview: result.preview,
      diffs: result.diffs,
      errors: result.preview.validation.valid ? [] : validationErrors(result.preview),
    };
  } catch (error) {
    return {
      valid: false,
      errors: [error instanceof Error ? error.message : String(error)],
    };
  }
}

export function approveCaptionReview(
  projectDir: string,
  reviewer: string,
  options: { patchPath?: string; approvedAt?: string } = {},
): ApproveCaptionReviewResult {
  const actor = reviewer.trim();
  if (!actor) throw new Error("reviewer is required");
  const context = loadCaptionReviewContext(projectDir);
  const validation = validateCaptionReview(context.projectDir, options.patchPath);
  if (!validation.valid || !validation.preview || !validation.patch) {
    throw new Error(`Caption review cannot be approved:\n${validation.errors.join("\n")}`);
  }

  const speechCaptions = validation.preview.speech_captions.map(stripReviewFields);
  const approvalSource = {
    version: context.draft.version,
    project_id: context.draft.project_id,
    base_timeline_version: context.draft.base_timeline_version,
    caption_policy: context.draft.caption_policy,
    speech_captions: speechCaptions,
    text_overlays: context.draft.text_overlays,
  };
  const patchHash = computeNormalizedJsonHash(validation.patch);
  const validationHash = computeNormalizedJsonHash(validation.preview.validation);
  const approval = createDraftApproval(
    approvalSource,
    actor,
    options.approvedAt,
    {
      base_caption_draft_hash: validation.preview.base_caption_draft_hash,
      caption_review_patch_hash: patchHash,
      validation_hash: validationHash,
    },
  );
  assertSchema("caption-approval.schema.json", approval);
  const approvalPath = path.join(context.projectDir, CAPTION_APPROVAL_PATH);
  atomicWriteJson(approvalPath, approval);
  return { approval, approvalPath, patchHash, validationHash };
}

function stripReviewFields(entry: CaptionReviewPreview["speech_captions"][number]): CaptionDraftEntry {
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
    ...(entry.reveal_timing ? { reveal_timing: structuredClone(entry.reveal_timing) } : {}),
  };
}

function validationErrors(preview: CaptionReviewPreview): string[] {
  const summary = preview.validation;
  const errors = [
    summary.blocking_issue_count > 0
      ? `${summary.blocking_issue_count} blocking issue(s) remain`
      : undefined,
    summary.flagged_count > 0 ? `${summary.flagged_count} caption(s) are flagged` : undefined,
    summary.unreviewed_count > 0
      ? `${summary.unreviewed_count} caption(s) are unreviewed`
      : undefined,
  ].filter((message): message is string => Boolean(message));
  return errors.length > 0 ? errors : ["caption review validation failed"];
}

function evaluateCaptionReviewPatch(
  context: CaptionReviewContext,
  patch: CaptionReviewPatch,
): { preview: CaptionReviewPreview; diffs: CaptionReviewDiff[] } {
  const result = applyCaptionReviewPatch(context.draft, patch, context.timelineHash, {
    fps: context.fps,
    protectedTerms: context.protectedTerms,
  });
  if (!result.success) throw new Error(result.errors.join("\n"));
  assertSchema("caption-review-preview.schema.json", result.preview);
  return result;
}

function readRequiredJson<T>(projectDir: string, relativePath: string): T {
  const filePath = path.join(projectDir, relativePath);
  if (!fs.existsSync(filePath)) throw new Error(`Required artifact not found: ${filePath}`);
  return readJsonFile<T>(filePath);
}

function readJsonFile<T>(filePath: string): T {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8")) as T;
  } catch (error) {
    throw new Error(`Failed to read JSON ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function timelineFps(timeline: unknown): number {
  const sequence = (timeline as { sequence?: { fps_num?: number; fps_den?: number } })?.sequence;
  const numerator = sequence?.fps_num ?? 24;
  const denominator = sequence?.fps_den ?? 1;
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) return 24;
  return numerator / denominator;
}

function assertSchema(schemaFile: string, data: unknown): void {
  const schemaPath = path.join(SCHEMA_DIR, schemaFile);
  const schema = JSON.parse(fs.readFileSync(schemaPath, "utf-8")) as object;
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  const validate = ajv.compile(schema);
  if (validate(data)) return;
  const details = (validate.errors ?? [])
    .map((error) => `${error.instancePath || "/"} ${error.message ?? "is invalid"}`)
    .join("; ");
  throw new Error(`${schemaFile} validation failed: ${details}`);
}
