import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { computeNormalizedJsonHash } from "../artifacts/p1-manifest-coverage.js";
import { atomicWriteJson } from "../pipeline/stages/_util.js";
import {
  applyCaptionSemanticTimingPhase,
  applyCaptionWordTiming,
  captionCommand,
  type CaptionCommandResult,
} from "../commands/caption.js";
import {
  createDraftApproval,
  type CaptionApproval,
} from "./approval.js";
import {
  buildGlossary,
  type CaptionDraft,
  type CaptionDraftEntry,
} from "./editorial.js";
import { finalizeCaptionDraftTiming } from "./final-invariants.js";
import type { TranscriptArtifact } from "./segmenter.js";
import type { CaptionTimingReport } from "./semantic-timing.js";
import type { TimelineIR } from "../compiler/types.js";
import { loadProjectCaptionGlossary } from "./project-glossary.js";
import {
  applyCaptionReviewPatch,
  assessSafeBulkReview,
  buildCaptionApprovalReadiness,
  buildCaptionReviewQueue,
  computeCaptionDraftHash,
  type CaptionReviewDiff,
  type CaptionGlossaryProposal,
  type CaptionReviewPatch,
  type CaptionReviewPreview,
  type CaptionReviewQueueItem,
  type CaptionReviewState,
  type CaptionApprovalReadiness,
  type SafeBulkReviewAssessment,
} from "./review-core.js";
import { inspectCaptionFontContract, type CaptionFontContract } from "./font-contract.js";

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
export const CAPTION_REVIEW_TIMING_REPORT_PATH = "07_package/caption_review_timing_report.json";
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

export interface RetimeCaptionReviewResult extends ApplyCaptionReviewResult {
  adjustedCaptionCount: number;
  timingReport?: CaptionTimingReport;
  timingReportPath?: string;
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
  approvalHash: string;
}

export interface CaptionReviewRecoveryAction {
  code: "prepare_caption_draft" | "protected_existing_review";
  label: string;
  command: string[];
  safe_to_run: boolean;
  message: string;
}

export interface CaptionReviewOperationalState {
  status: "ready" | "needs_recovery";
  items: CaptionReviewQueueItem[];
  baseCaptionDraftHash?: string;
  approvalReadiness: CaptionApprovalReadiness;
  safeBulk: SafeBulkReviewAssessment;
  fontContract?: CaptionFontContract;
  recoveryAction?: CaptionReviewRecoveryAction;
  currentApproval?: { status: "approved"; hash: string };
  approvalWarning?: { code: "stale_approval"; message: string };
}

export interface VerifySafeCaptionsOptions {
  reviewer: string;
  baseCaptionDraftHash: string;
  captionTextHashes: Record<string, string>;
  updatedAt?: string;
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

export function inspectCaptionReviewOperationalState(
  projectDir: string,
  reviewer = "",
  patchInputPath?: string,
  checkExistingApproval = true,
): CaptionReviewOperationalState {
  const absoluteProjectDir = path.resolve(projectDir);
  const draftPath = path.join(absoluteProjectDir, CAPTION_DRAFT_PATH);
  if (!fs.existsSync(draftPath)) {
    const protectedReview = [CAPTION_REVIEW_PATCH_PATH, CAPTION_APPROVAL_PATH]
      .some((relativePath) => fs.existsSync(path.join(absoluteProjectDir, relativePath)));
    return {
      status: "needs_recovery",
      items: [],
      approvalReadiness: buildCaptionApprovalReadiness({
        reviewer,
        validation: emptyValidation(),
        stale: true,
        fontReady: false,
        staleMessage: "caption_draft.json がありません。字幕ドラフトを準備してください。",
        fontMessage: "字幕ドラフトがないためフォント契約を確認できません。",
      }),
      safeBulk: { eligible_caption_ids: [], eligible_count: 0, excluded: [], exclusion_reason_counts: {} },
      recoveryAction: protectedReview ? {
        code: "prepare_caption_draft",
        label: "字幕ドラフトを準備",
        command: ["npx", "tsx", "scripts/caption-review.ts", "prepare", "--project", absoluteProjectDir],
        safe_to_run: true,
        message: "隔離領域で再生成して既存patch/approvalの基準hashと照合し、一致した場合だけdraftを復元します。",
      } : {
        code: "prepare_caption_draft",
        label: "字幕ドラフトを準備",
        command: ["npx", "tsx", "scripts/caption-review.ts", "prepare", "--project", absoluteProjectDir],
        safe_to_run: true,
        message: "canonical caption生成器でcaption_draft.jsonを準備します。",
      },
    };
  }

  const context = loadCaptionReviewContext(absoluteProjectDir);
  const rawItems = buildCaptionReviewQueue(context.draft, {
    fps: context.fps,
    protectedTerms: context.protectedTerms,
  });
  let items = rawItems;
  let stale = false;
  let staleMessage: string | undefined;
  try {
    items = queueCaptionReview(absoluteProjectDir, patchInputPath);
  } catch (error) {
    stale = true;
    staleMessage = error instanceof Error ? error.message : String(error);
  }
  let currentApproval: CaptionReviewOperationalState["currentApproval"];
  let approvalWarning: CaptionReviewOperationalState["approvalWarning"];
  if (checkExistingApproval && fs.existsSync(path.join(context.projectDir, CAPTION_APPROVAL_PATH))) {
    try {
      const approval = readJsonFile<CaptionApproval>(path.join(context.projectDir, CAPTION_APPROVAL_PATH));
      const approvalHash = assertCaptionApprovalCurrent(context.projectDir, approval, patchInputPath);
      currentApproval = { status: "approved", hash: approvalHash };
    } catch (error) {
      approvalWarning = {
        code: "stale_approval",
        message: `既存caption_approval.jsonは現行レビューと不一致です。再承認してください: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }
  const validation = validationFromQueue(items);
  const fontContract = inspectCaptionFontContract(context.draft.caption_policy.styling_class);
  return {
    status: "ready",
    items,
    baseCaptionDraftHash: computeCaptionDraftHash(context.draft),
    approvalReadiness: buildCaptionApprovalReadiness({
      reviewer,
      validation,
      stale,
      fontReady: fontContract.status === "ready" && !fontContract.fallback_used,
      staleMessage,
      fontMessage: fontContract.diagnostics.map((entry) => entry.message).join("; ") || undefined,
    }),
    safeBulk: assessSafeBulkReview(items, { protectedTerms: context.protectedTerms }),
    fontContract,
    ...(currentApproval ? { currentApproval } : {}),
    ...(approvalWarning ? { approvalWarning } : {}),
  };
}

export function assertCaptionApprovalCurrent(
  projectDir: string,
  approval: CaptionApproval,
  patchInputPath?: string,
): string {
  assertSchema("caption-approval.schema.json", approval);
  const context = loadCaptionReviewContext(projectDir);
  const patchPath = patchInputPath
    ? path.resolve(patchInputPath)
    : path.join(context.projectDir, CAPTION_REVIEW_PATCH_PATH);
  if (!fs.existsSync(patchPath)) throw new Error("caption review patch is missing");
  const patch = readJsonFile<CaptionReviewPatch>(patchPath);
  assertSchema("caption-review-patch.schema.json", patch);
  const evaluated = evaluateCaptionReviewPatch(context, patch);
  const expectedPatchHash = computeNormalizedJsonHash(patch);
  const expectedValidationHash = computeNormalizedJsonHash(evaluated.preview.validation);
  if (
    approval.approval.status !== "approved"
    || approval.approval.base_caption_draft_hash !== computeCaptionDraftHash(context.draft)
    || approval.approval.caption_review_patch_hash !== expectedPatchHash
    || approval.approval.validation_hash !== expectedValidationHash
  ) throw new Error("approval provenance does not match the current draft/patch/validation");

  const expectedContent = {
    version: context.draft.version,
    project_id: context.draft.project_id,
    base_timeline_version: context.draft.base_timeline_version,
    caption_policy: context.draft.caption_policy,
    speech_captions: evaluated.preview.speech_captions.map(stripReviewFields),
    text_overlays: context.draft.text_overlays,
  };
  const actualContent = {
    version: approval.version,
    project_id: approval.project_id,
    base_timeline_version: approval.base_timeline_version,
    caption_policy: approval.caption_policy,
    speech_captions: approval.speech_captions,
    text_overlays: approval.text_overlays,
  };
  if (computeNormalizedJsonHash(actualContent) !== computeNormalizedJsonHash(expectedContent)) {
    throw new Error("approval captions do not match the current reviewed output");
  }
  return computeNormalizedJsonHash(approval);
}

export function prepareCaptionReviewDraft(
  projectDir: string,
  generator?: (stagingProjectDir: string) => CaptionCommandResult,
): { status: "prepared" | "already_exists"; draftPath: string; draftHash: string } {
  const absoluteProjectDir = path.resolve(projectDir);
  const draftPath = path.join(absoluteProjectDir, CAPTION_DRAFT_PATH);
  if (fs.existsSync(draftPath)) {
    const draft = readJsonFile<CaptionDraft>(draftPath);
    return { status: "already_exists", draftPath, draftHash: computeCaptionDraftHash(draft) };
  }
  const expectedHashes = protectedDraftHashes(absoluteProjectDir);
  const stagingProjectDir = fs.mkdtempSync(path.join(os.tmpdir(), "caption-draft-recovery-"));
  try {
    stageCaptionRecoveryInputs(absoluteProjectDir, stagingProjectDir);
    const runGenerator = generator ?? ((dir: string) => captionCommand(dir, { editorialEnabled: false }));
    const result = runGenerator(stagingProjectDir);
    const stagedDraftPath = path.join(stagingProjectDir, CAPTION_DRAFT_PATH);
    if (!result.success || !result.captionDraft || !fs.existsSync(stagedDraftPath)) {
      throw new Error(`Caption draft recovery failed: ${result.error?.message ?? "canonical generator did not produce caption_draft.json"}`);
    }
    const draftHash = computeCaptionDraftHash(result.captionDraft);
    if (expectedHashes.length > 0 && expectedHashes.some((expected) => expected !== draftHash)) {
      throw new Error(
        `Caption draft recovery hash mismatch: generated=${draftHash} protected=${expectedHashes.join(",")}; existing review artifacts were preserved`,
      );
    }
    atomicWriteJson(draftPath, result.captionDraft);
    return { status: "prepared", draftPath, draftHash };
  } finally {
    fs.rmSync(stagingProjectDir, { recursive: true, force: true });
  }
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

/**
 * Recompute an existing reviewed caption set from transcript word boundaries.
 *
 * Text and caption IDs remain unchanged. Deterministic timing adjustments are
 * appended to the review patch, so approval provenance becomes stale until the
 * operator explicitly approves the reviewed result again.
 */
export function retimeCaptionReview(
  projectDir: string,
  reviewer: string,
  updatedAt?: string,
): RetimeCaptionReviewResult {
  const actor = reviewer.trim();
  if (!actor) throw new Error("reviewer is required");
  const { context, patch, patchPath, preview } = loadMutableCaptionReview(projectDir);
  const transcripts = loadCaptionReviewTranscripts(context.projectDir);
  const workingDraft: CaptionDraft = {
    ...context.draft,
    speech_captions: preview.speech_captions.map(reviewedEntryToDraft),
  };
  const wordTimed = applyCaptionWordTiming(
    workingDraft,
    workingDraft.caption_policy,
    context.timeline as TimelineIR,
    transcripts,
  );
  const retimed = applyCaptionSemanticTimingPhase(
    wordTimed,
    workingDraft.caption_policy,
    context.timeline as TimelineIR,
    transcripts,
  );
  const reviewTimeline = context.timeline as TimelineIR;
  const fps =
    reviewTimeline.sequence.fps_num / reviewTimeline.sequence.fps_den;
  const finalized = finalizeCaptionDraftTiming(
    retimed.draft,
    fps,
    workingDraft.caption_policy.language,
  );
  const blockingFinalIssues = finalized.issues.filter(
    (issue) => issue.severity === "block",
  );
  if (blockingFinalIssues.length > 0) {
    throw new Error(
      "Final caption invariants failed after retime: " +
      blockingFinalIssues.map((issue) => issue.message).join("; "),
    );
  }
  const desiredByID = new Map(
    finalized.draft.speech_captions.map((entry) => [entry.caption_id, entry]),
  );
  let adjustedCaptionCount = 0;
  const operationCountBefore = patch.operations.length;
  for (const entry of preview.speech_captions) {
    const desired = desiredByID.get(entry.caption_id);
    if (!desired) throw new Error(`Retimed caption missing from result: ${entry.caption_id}`);
    const currentEnd = entry.timeline_in_frame + entry.timeline_duration_frames;
    const desiredEnd = desired.timeline_in_frame + desired.timeline_duration_frames;
    if (entry.timeline_in_frame === desired.timeline_in_frame && currentEnd === desiredEnd) continue;
    patch.operations.push({
      op: "adjust_timing",
      caption_id: entry.caption_id,
      start_frame: desired.timeline_in_frame,
      end_frame: desiredEnd,
    });
    if (entry.review.state === "verified") {
      patch.operations.push({
        op: "set_review_state",
        caption_id: entry.caption_id,
        state: "verified",
        note: "Speech-boundary retime: question onset and prior-speech guard verified.",
      });
    }
    adjustedCaptionCount += 1;
  }
  patch.session.reviewer = actor;
  const persisted = persistCaptionReviewMutation(
    context,
    patch,
    patchPath,
    patch.operations.length - operationCountBefore,
    updatedAt,
  );
  const timingReportPath = retimed.report
    ? path.join(context.projectDir, CAPTION_REVIEW_TIMING_REPORT_PATH)
    : undefined;
  if (retimed.report && timingReportPath) atomicWriteJson(timingReportPath, retimed.report);
  return {
    ...persisted,
    adjustedCaptionCount,
    timingReport: retimed.report,
    timingReportPath,
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

export function verifySafeCaptionReview(
  projectDir: string,
  options: VerifySafeCaptionsOptions,
): ApplyCaptionReviewResult & { assessment: SafeBulkReviewAssessment } {
  const actor = options.reviewer.trim();
  if (!actor) throw new Error("reviewer is required");
  const context = loadCaptionReviewContext(projectDir);
  const currentDraftHash = computeCaptionDraftHash(context.draft);
  if (!options.baseCaptionDraftHash || options.baseCaptionDraftHash !== currentDraftHash) {
    throw new Error("Caption review bulk input is stale: base_caption_draft_hash does not match");
  }

  const patchPath = path.join(context.projectDir, CAPTION_REVIEW_PATCH_PATH);
  let patch: CaptionReviewPatch;
  let preview: CaptionReviewPreview;
  if (fs.existsSync(patchPath)) {
    patch = readJsonFile<CaptionReviewPatch>(patchPath);
    assertSchema("caption-review-patch.schema.json", patch);
    preview = evaluateCaptionReviewPatch(context, patch).preview;
  } else {
    const timestamp = options.updatedAt ?? new Date().toISOString();
    patch = {
      version: "caption-review-patch/v1",
      project_id: context.draft.project_id,
      base_caption_draft_hash: currentDraftHash,
      base_timeline_hash: context.timelineHash,
      operations: [],
      session: { reviewer: actor, started_at: timestamp, updated_at: timestamp },
    };
    const evaluated = applyCaptionReviewPatch(context.draft, patch, context.timelineHash, {
      fps: context.fps,
      protectedTerms: context.protectedTerms,
    });
    if (!evaluated.success) throw new Error(evaluated.errors.join("\n"));
    preview = evaluated.preview;
  }

  const currentItems = preview.speech_captions.map((entry) => ({
    caption_id: entry.caption_id,
    timeline_in_frame: entry.timeline_in_frame,
    timeline_duration_frames: entry.timeline_duration_frames,
    text: entry.text,
    source_text: entry.review.source_text,
    text_hash: entry.text_hash,
    review_state: entry.review.state,
    risk_score: entry.risk_score,
    issues: entry.issues,
  }));
  for (const item of currentItems) {
    if (!options.captionTextHashes[item.caption_id]) {
      throw new Error(`Caption review bulk input is incomplete: text hash missing for ${item.caption_id}`);
    }
    if (options.captionTextHashes[item.caption_id] !== item.text_hash) {
      throw new Error(`Caption review bulk input is stale: ${item.caption_id} text hash does not match`);
    }
  }
  const assessment = assessSafeBulkReview(currentItems, { protectedTerms: context.protectedTerms });
  if (assessment.eligible_count === 0) {
    throw new Error("No safe captions are eligible for bulk verification");
  }
  const byID = new Map(currentItems.map((item) => [item.caption_id, item]));
  for (const captionID of assessment.eligible_caption_ids) {
    patch.operations.push({
      op: "set_review_state",
      caption_id: captionID,
      base_text_hash: byID.get(captionID)!.text_hash,
      state: "verified",
      note: "safe_bulk_review/v1",
    });
  }
  patch.session.reviewer = actor;
  return {
    ...persistCaptionReviewMutation(
      context,
      patch,
      patchPath,
      assessment.eligible_count,
      options.updatedAt,
    ),
    assessment,
  };
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
  const operational = inspectCaptionReviewOperationalState(context.projectDir, actor, options.patchPath, false);
  if (!operational.approvalReadiness.can_approve) {
    throw new Error(`Caption review cannot be approved:\n${operational.approvalReadiness.blockers
      .map((blocker) => `${blocker.code}: ${blocker.message}`).join("\n")}`);
  }
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
  return {
    approval,
    approvalPath,
    patchHash,
    validationHash,
    approvalHash: computeNormalizedJsonHash(approval),
  };
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

function reviewedEntryToDraft(
  entry: CaptionReviewPreview["speech_captions"][number],
): CaptionDraftEntry {
  const copy = structuredClone(entry) as unknown as Record<string, unknown>;
  delete copy.text_hash;
  delete copy.review;
  delete copy.issues;
  delete copy.risk_score;
  return copy as unknown as CaptionDraftEntry;
}

function loadCaptionReviewTranscripts(projectDir: string): Map<string, TranscriptArtifact> {
  const transcripts = new Map<string, TranscriptArtifact>();
  const transcriptDir = path.join(projectDir, "03_analysis", "transcripts");
  if (!fs.existsSync(transcriptDir)) return transcripts;
  for (const file of fs.readdirSync(transcriptDir)) {
    if (!file.startsWith("TR_") || !file.endsWith(".json")) continue;
    const transcript = readJsonFile<TranscriptArtifact>(path.join(transcriptDir, file));
    transcripts.set(transcript.asset_id, transcript);
  }
  return transcripts;
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

function emptyValidation(): CaptionReviewPreview["validation"] {
  return {
    valid: false,
    blocking_issue_count: 0,
    warning_issue_count: 0,
    unreviewed_count: 0,
    verified_count: 0,
    edited_count: 0,
    flagged_count: 0,
  };
}

function validationFromQueue(items: CaptionReviewQueueItem[]): CaptionReviewPreview["validation"] {
  const blockingIssueCount = items.flatMap((item) => item.issues)
    .filter((issue) => issue.severity === "block").length;
  const unreviewedCount = items.filter((item) => item.review_state === "unreviewed").length;
  const flaggedCount = items.filter((item) => item.review_state === "flagged").length;
  return {
    valid: blockingIssueCount === 0 && unreviewedCount === 0 && flaggedCount === 0,
    blocking_issue_count: blockingIssueCount,
    warning_issue_count: items.flatMap((item) => item.issues).filter((issue) => issue.severity === "warn").length,
    unreviewed_count: unreviewedCount,
    verified_count: items.filter((item) => item.review_state === "verified").length,
    edited_count: 0,
    flagged_count: flaggedCount,
  };
}

function protectedDraftHashes(projectDir: string): string[] {
  const hashes: string[] = [];
  const patchPath = path.join(projectDir, CAPTION_REVIEW_PATCH_PATH);
  if (fs.existsSync(patchPath)) {
    const patch = readJsonFile<CaptionReviewPatch>(patchPath);
    if (typeof patch.base_caption_draft_hash === "string") hashes.push(patch.base_caption_draft_hash);
  }
  const approvalPath = path.join(projectDir, CAPTION_APPROVAL_PATH);
  if (fs.existsSync(approvalPath)) {
    const approval = readJsonFile<CaptionApproval>(approvalPath);
    const hash = approval.approval?.base_caption_draft_hash;
    if (typeof hash === "string") hashes.push(hash);
  }
  return [...new Set(hashes)];
}

function stageCaptionRecoveryInputs(projectDir: string, stagingProjectDir: string): void {
  for (const relativePath of ["01_intent", "02_ingest", "03_analysis", "04_plan", "05_timeline", "06_review"]) {
    const source = path.join(projectDir, relativePath);
    if (fs.existsSync(source)) fs.symlinkSync(source, path.join(stagingProjectDir, relativePath), "dir");
  }
  const statePath = path.join(projectDir, "project_state.yaml");
  if (fs.existsSync(statePath)) fs.copyFileSync(statePath, path.join(stagingProjectDir, "project_state.yaml"));
  fs.mkdirSync(path.join(stagingProjectDir, "07_package"), { recursive: true });
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
