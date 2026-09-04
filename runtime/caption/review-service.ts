import * as fs from "node:fs";
import * as path from "node:path";
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
  type CaptionAccessibilitySelection,
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
import {
  applyCaptionVisualTreatmentPatch,
  captionApprovalBindingHash,
  captionRendererCapabilitiesForPolicy,
  captionVisualTreatmentCanonicalInputHash,
  captionVisualTreatmentPreapprovalReceiptHash,
  captionVisualTreatmentReceiptSummary,
  captionVisualTreatmentPatchHash,
  loadCaptionVisualTreatmentPatch,
  resolveCaptionVisualTreatmentInput,
  type CaptionRendererCapabilities,
  type CaptionVisualTreatmentInput,
  type CaptionVisualTreatmentPatch,
  type CaptionVisualTreatmentPreapprovalReceipt,
} from "./visual-treatment.js";
import { loadTypographyPolicy, typographyPolicyContentHash } from "./typography-policy.js";
import { inspectCaptionFontContract, type CaptionFontContract } from "./font-contract.js";
import { projectCaptionEntry } from "./projection.js";
import { loadPlatformSafeZoneProfile, type PlatformSafeZoneProfile } from "../platform/safe-zone-profile.js";
import { computeSha256 } from "../packaging/manifest.js";

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
export const CAPTION_VISUAL_TREATMENT_PATCH_PATH = "07_package/caption_visual_treatment_patch.json";
export const CAPTION_VISUAL_TREATMENT_INPUT_PATH = "07_package/caption_visual_treatment_input.json";
export const CAPTION_VISUAL_TREATMENT_PREAPPROVAL_INPUT_PATH = "07_package/caption_visual_treatment_preapproval_input.json";
export const CAPTION_VISUAL_TREATMENT_PREAPPROVAL_RECEIPT_PATH = "07_package/caption_visual_treatment_preapproval_receipt.json";
export const CAPTION_VISUAL_TREATMENT_PREVIEW_OUTPUT_PATH = "05_timeline/preview-baseline-fast-full.mp4";
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

function resolveProjectArtifactPath(projectDir: string, candidate: string | undefined, defaultRelativePath: string): string {
  const root = path.resolve(projectDir);
  const resolved = path.resolve(root, candidate ?? defaultRelativePath);
  if (resolved === root || !resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error(`caption review artifact path must be project-contained: ${candidate ?? defaultRelativePath}`);
  }
  let cursor = root;
  for (const component of path.relative(root, resolved).split(path.sep)) {
    cursor = path.join(cursor, component);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(cursor);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") break;
      throw error;
    }
    if (stat.isSymbolicLink()) {
      throw new Error(`caption review artifact path must not contain a symlink: ${candidate ?? defaultRelativePath}`);
    }
  }
  return resolved;
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
  visualTreatment?: CaptionVisualTreatmentReviewResult;
}

export interface CaptionVisualTreatmentReviewOptions {
  reviewer?: string;
  /** Reject an append/undo when the Studio projection is no longer current. */
  expectedPatchHash?: string;
  /** Candidate receipt required by the Studio approval path. */
  preapprovalReceiptPath?: string;
  patchPath?: string;
  typographyPolicyPath?: string;
  platformSafeZoneProfileHash?: string;
  platformSafeZoneProfileId?: string;
  platformSafeZoneProfilePath?: string;
  platformSafeZoneProfile?: PlatformSafeZoneProfile;
  capabilities?: CaptionRendererCapabilities;
  accessibility?: { reduced_motion?: boolean; high_contrast?: boolean; audio_off?: boolean; small_screen?: boolean };
}

export interface CaptionVisualTreatmentApprovalOptions extends CaptionVisualTreatmentReviewOptions {
  expectedPatchHash: string;
  preapprovalReceiptPath: string;
}

export interface CaptionVisualTreatmentReviewResult {
  patch: CaptionVisualTreatmentPatch;
  input: CaptionVisualTreatmentInput;
  patchPath: string;
  inputPath: string;
  patchHash: string;
  inputHash: string;
}

export interface CaptionVisualTreatmentPreapprovalResult extends CaptionVisualTreatmentReviewResult {
  receipt: CaptionVisualTreatmentPreapprovalReceipt;
  receiptPath: string;
}

export interface CaptionVisualTreatmentAuthorPreviewResult extends CaptionVisualTreatmentPreapprovalResult {
  approvalHashBefore: string;
  approvalHashAfter: string;
  textTimingHashBefore: string;
  textTimingHashAfter: string;
  productionApprovalUnchanged: true;
}

export interface CaptionVisualTreatmentPreviewOutputBinding {
  outputPath: string;
  receiptPath: string;
  contentType: "video/mp4";
}

export interface CaptionVisualTreatmentUndoResult extends CaptionVisualTreatmentReviewResult {
  removedOperationCount: number;
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

/**
 * Validate the complete human-reviewed caption contract at an export
 * boundary.  The approval status is intentionally only one part of this
 * check: an export must be bound to the current project, timeline, draft,
 * review patch, and validation result.
 */
export function assertCaptionApprovalForExport(
  projectDir: string,
  approvalPath = path.join(path.resolve(projectDir), CAPTION_APPROVAL_PATH),
): {
  approval: CaptionApproval;
  timelineHash: string;
  textTimingHash: string;
} {
  const absoluteProjectDir = path.resolve(projectDir);
  const approval = readJsonFile<CaptionApproval>(path.resolve(approvalPath));
  assertSchema("caption-approval.schema.json", approval);
  const context = loadCaptionReviewContext(absoluteProjectDir);
  assertSchema("timeline-ir.schema.json", context.timeline);
  const timeline = context.timeline as { project_id?: unknown; version?: unknown };
  if (approval.approval.status !== "approved") {
    throw new Error(`caption approval status must be approved, got ${approval.approval.status}`);
  }
  if (
    typeof approval.approval.approved_by !== "string"
    || approval.approval.approved_by.trim().length === 0
    || typeof approval.approval.approved_at !== "string"
    || !Number.isFinite(Date.parse(approval.approval.approved_at))
  ) {
    throw new Error("caption approval human reviewer and valid approval time are required");
  }
  if (approval.project_id !== context.draft.project_id || approval.project_id !== timeline.project_id) {
    throw new Error("caption approval project_id does not match the current project/timeline");
  }
  if (typeof timeline.version !== "string" || approval.base_timeline_version !== timeline.version) {
    throw new Error("caption approval base_timeline_version is stale");
  }
  if (approval.approval.base_timeline_hash !== context.timelineHash) {
    throw new Error("caption approval base_timeline_hash is stale");
  }
  const provenance = approval.approval;
  for (const [label, value] of [
    ["base_caption_draft_hash", provenance.base_caption_draft_hash],
    ["caption_review_patch_hash", provenance.caption_review_patch_hash],
    ["validation_hash", provenance.validation_hash],
  ] as const) {
    if (typeof value !== "string") throw new Error(`caption approval ${label} provenance is missing`);
  }
  assertCaptionApprovalCurrent(absoluteProjectDir, approval);
  const textTimingHash = computeNormalizedJsonHash(approval.speech_captions.map((caption) => {
    const { treatment: _treatment, requested_treatment: _requestedTreatment, ...identity } = caption as unknown as Record<string, unknown>;
    return identity;
  }));
  return { approval, timelineHash: context.timelineHash, textTimingHash };
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
  // captionCommand reconciles and schema-validates the staged project by
  // walking upward to the repository schemas/ directory. Keep recovery
  // isolated, but stage it under the repository root so the canonical
  // generator has the same runtime context as the source project.
  const stagingProjectDir = fs.mkdtempSync(
    path.join(path.dirname(SCHEMA_DIR), ".caption-draft-recovery-"),
  );
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

/**
 * Initialize the visual treatment stream independently from text/timing
 * review. The patch is bound to the current approved caption identity and
 * timeline, but writing it never changes caption_draft, review_patch, or the
 * approval record.
 */
export function initializeCaptionVisualTreatmentPatch(
  projectDir: string,
  reviewer: string,
  options: { outputPath?: string; now?: string; overwrite?: boolean; approvalPath?: string; typographyPolicyPath?: string } = {},
): { patch: CaptionVisualTreatmentPatch; patchPath: string } {
  const actor = reviewer.trim();
  if (!actor) throw new Error("reviewer is required");
  const context = loadCaptionReviewContext(projectDir);
  const absoluteProjectDir = context.projectDir;
  const approvalPath = resolveProjectArtifactPath(absoluteProjectDir, options.approvalPath, CAPTION_APPROVAL_PATH);
  const approval = readJsonFile<CaptionApproval>(approvalPath);
  assertSchema("caption-approval.schema.json", approval);
  const policyPath = resolveProjectArtifactPath(absoluteProjectDir, options.typographyPolicyPath, "04_plan/typography_policy.json");
  const policy = loadTypographyPolicy(policyPath);
  const patchPath = options.outputPath
    ? resolveProjectArtifactPath(absoluteProjectDir, options.outputPath, CAPTION_VISUAL_TREATMENT_PATCH_PATH)
    : path.join(absoluteProjectDir, CAPTION_VISUAL_TREATMENT_PATCH_PATH);
  if (fs.existsSync(patchPath) && !options.overwrite) {
    throw new Error(`Caption visual-treatment patch already exists: ${patchPath}`);
  }
  const timestamp = options.now ?? new Date().toISOString();
  const patch: CaptionVisualTreatmentPatch = {
    version: "caption-visual-treatment-patch/v1",
    project_id: approval.project_id,
    base_caption_draft_hash: approval.approval.base_caption_draft_hash ?? computeCaptionDraftHash(context.draft),
    base_timeline_hash: approval.approval.base_timeline_hash ?? context.timelineHash,
    typography_policy_hash: typographyPolicyContentHash(policy),
    caption_approval_hash: captionApprovalBindingHash(approval),
    operations: [],
    session: { reviewer: actor, started_at: timestamp, updated_at: timestamp },
  };
  assertSchema("caption-visual-treatment-patch.schema.json", patch);
  atomicWriteJson(patchPath, patch);
  return { patch, patchPath };
}

function visualTreatmentApproval(projectDir: string, approvalPath?: string): { approval: CaptionApproval; approvalPath: string } {
  const absoluteProjectDir = path.resolve(projectDir);
  const resolvedApprovalPath = resolveProjectArtifactPath(absoluteProjectDir, approvalPath, CAPTION_APPROVAL_PATH);
  const approval = readJsonFile<CaptionApproval>(resolvedApprovalPath);
  assertSchema("caption-approval.schema.json", approval);
  return { approval, approvalPath: resolvedApprovalPath };
}

function visualTreatmentPolicy(projectDir: string, policyPath?: string) {
  const resolvedPolicyPath = resolveProjectArtifactPath(projectDir, policyPath, "04_plan/typography_policy.json");
  if (!fs.existsSync(resolvedPolicyPath)) throw new Error(`Typography policy is required for visual treatment: ${resolvedPolicyPath}`);
  const policy = loadTypographyPolicy(resolvedPolicyPath);
  return { policy, hash: typographyPolicyContentHash(policy), path: resolvedPolicyPath };
}

function visualTreatmentReviewInput(
  projectDir: string,
  approval: CaptionApproval,
  patch: CaptionVisualTreatmentPatch,
  options: CaptionVisualTreatmentReviewOptions = {},
): CaptionVisualTreatmentInput {
  const { policy } = visualTreatmentPolicy(projectDir, options.typographyPolicyPath);
  const capabilities = options.capabilities ?? captionRendererCapabilitiesForPolicy(policy);
  const context = resolveVisualTreatmentContext(projectDir, approval, patch, options);
  return resolveCaptionVisualTreatmentInput({
    approval,
    patch,
    typography_policy: policy,
    typography_policy_hash: typographyPolicyContentHash(policy),
    platform_safe_zone_profile_hash: context.safeZoneHash,
    platform_safe_zone_profile_id: context.safeZoneId,
    platform_safe_zone_profile_path: context.safeZonePath,
    platform_safe_zone_profile: context.safeZoneProfile,
    capabilities,
    accessibility: context.accessibility,
    require_approval_binding: false,
  });
}

interface ResolvedVisualTreatmentContext {
  accessibility?: CaptionAccessibilitySelection;
  safeZoneHash?: string;
  safeZoneId?: string;
  safeZonePath?: string;
  safeZoneProfile?: PlatformSafeZoneProfile;
}

function normalizeAccessibility(
  value: CaptionVisualTreatmentReviewOptions["accessibility"] | undefined,
): CaptionAccessibilitySelection | undefined {
  if (!value) return undefined;
  return {
    reduced_motion: value.reduced_motion === true,
    high_contrast: value.high_contrast === true,
    audio_off: value.audio_off === true,
    small_screen: value.small_screen === true,
  };
}

function resolveVisualTreatmentContext(
  projectDir: string,
  approval: CaptionApproval,
  patch: CaptionVisualTreatmentPatch,
  options: CaptionVisualTreatmentReviewOptions,
): ResolvedVisualTreatmentContext {
  const persisted = approval.approval.visual_treatment_context;
  const safeZonePathCandidate = options.platformSafeZoneProfilePath ?? persisted?.safe_zone_profile?.path;
  const safeZoneHashCandidate = options.platformSafeZoneProfileHash
    ?? persisted?.safe_zone_profile?.sha256
    ?? patch.platform_safe_zone_profile_hash
    ?? approval.approval.platform_safe_zone_profile_hash;
  const safeZoneIdCandidate = options.platformSafeZoneProfileId ?? persisted?.safe_zone_profile?.profile_id;
  let safeZoneProfile = options.platformSafeZoneProfile;
  let safeZonePath = safeZonePathCandidate;
  let safeZoneHash = safeZoneHashCandidate;
  let safeZoneId = safeZoneIdCandidate;
  if (safeZonePath) {
    const absolutePath = resolveProjectArtifactPath(projectDir, safeZonePath, safeZonePath);
    const relativePath = path.relative(path.resolve(projectDir), absolutePath);
    if (relativePath === ".." || relativePath.startsWith(`..${path.sep}`) || path.isAbsolute(relativePath)) {
      throw new Error(`safe-zone profile must be project-contained: ${safeZonePath}`);
    }
    const loaded = loadPlatformSafeZoneProfile(absolutePath);
    if (safeZoneHash && loaded.hash !== safeZoneHash) throw new Error(`safe-zone profile hash mismatch: ${safeZonePath}`);
    if (safeZoneId && loaded.profile.profile_id !== safeZoneId) throw new Error(`safe-zone profile identity mismatch: ${safeZonePath}`);
    safeZoneProfile = loaded.profile;
    safeZoneHash = loaded.hash;
    safeZoneId = loaded.profile.profile_id;
    safeZonePath = path.relative(path.resolve(projectDir), absolutePath).split(path.sep).join("/");
  } else if (safeZoneProfile) {
    safeZoneId = safeZoneId ?? safeZoneProfile.profile_id;
  }
  return {
    accessibility: normalizeAccessibility(options.accessibility) ?? persisted?.accessibility,
    ...(safeZoneHash ? { safeZoneHash } : {}),
    ...(safeZoneId ? { safeZoneId } : {}),
    ...(safeZonePath ? { safeZonePath } : {}),
    ...(safeZoneProfile ? { safeZoneProfile } : {}),
  };
}

/** Read-only visual status for CLI/operator clients; no artifact is written. */
export function inspectCaptionVisualTreatment(
  projectDir: string,
  options: CaptionVisualTreatmentReviewOptions = {},
): CaptionVisualTreatmentReviewResult {
  const absoluteProjectDir = path.resolve(projectDir);
  const patchPath = resolveProjectArtifactPath(absoluteProjectDir, options.patchPath, CAPTION_VISUAL_TREATMENT_PATCH_PATH);
  const patch = loadCaptionVisualTreatmentPatch(patchPath);
  const { approval } = visualTreatmentApproval(absoluteProjectDir);
  const input = visualTreatmentReviewInput(absoluteProjectDir, approval, patch, {
    ...options,
    accessibility: options.accessibility ?? { reduced_motion: false, high_contrast: false, audio_off: false, small_screen: false },
  });
  return {
    patch,
    input,
    patchPath: path.join(absoluteProjectDir, CAPTION_VISUAL_TREATMENT_PATCH_PATH),
    inputPath: path.join(absoluteProjectDir, CAPTION_VISUAL_TREATMENT_INPUT_PATH),
    patchHash: captionVisualTreatmentPatchHash(patch),
    inputHash: input.input_hash,
  };
}

function preapprovalReceiptPath(projectDir: string, candidate?: string): string {
  return resolveProjectArtifactPath(projectDir, candidate, CAPTION_VISUAL_TREATMENT_PREAPPROVAL_RECEIPT_PATH);
}

function preapprovalInputPath(projectDir: string): string {
  return path.join(path.resolve(projectDir), CAPTION_VISUAL_TREATMENT_PREAPPROVAL_INPUT_PATH);
}

function preapprovalReceiptForInput(
  input: CaptionVisualTreatmentInput,
  expectedPatchHash: string,
  previewOutput?: CaptionVisualTreatmentPreapprovalReceipt["preview_output"],
): CaptionVisualTreatmentPreapprovalReceipt {
  const receipt = {
    version: "caption-visual-treatment-preapproval-receipt/v1" as const,
    project_id: input.project_id,
    expected_patch_hash: expectedPatchHash,
    ...captionVisualTreatmentReceiptSummary(input),
    ...(previewOutput ? { preview_output: previewOutput } : {}),
  };
  const resolved = { ...receipt, receipt_hash: captionVisualTreatmentPreapprovalReceiptHash(receipt) };
  assertSchema("caption-visual-treatment-preapproval-receipt.schema.json", resolved);
  return resolved;
}

function assertExistingAuthorPreviewEvidence(
  projectDir: string,
  input: CaptionVisualTreatmentInput,
  patchHash: string,
): void {
  const inputPath = preapprovalInputPath(projectDir);
  const receiptPath = preapprovalReceiptPath(projectDir);
  const previewPath = path.join(projectDir, CAPTION_VISUAL_TREATMENT_PREVIEW_OUTPUT_PATH);
  const previewReceiptPath = `${previewPath}.receipt.json`;
  const paths = [inputPath, receiptPath, previewPath, previewReceiptPath];
  const present = paths.map((candidate) => fs.existsSync(candidate));
  if (!present.some(Boolean)) return;
  if (!present.every(Boolean)) {
    throw new Error("existing visual author-preview evidence is incomplete or stale");
  }
  const existingInput = readJsonFile<CaptionVisualTreatmentInput>(inputPath);
  assertSchema("caption-visual-treatment-input.schema.json", existingInput);
  if (computeNormalizedJsonHash(existingInput) !== computeNormalizedJsonHash(input)) {
    throw new Error("existing visual preapproval input is stale or forged");
  }
  const receipt = readJsonFile<CaptionVisualTreatmentPreapprovalReceipt>(receiptPath);
  assertPreapprovalReceiptMatches(projectDir, receiptPath, receipt, input, patchHash);
  const preview = receipt.preview_output;
  if (!preview) throw new Error("existing visual preapproval receipt is missing preview output binding");
  const expectedPreviewPath = path.relative(projectDir, previewPath).split(path.sep).join("/");
  const expectedPreviewReceiptPath = path.relative(projectDir, previewReceiptPath).split(path.sep).join("/");
  if (preview.path !== expectedPreviewPath || preview.receipt_path !== expectedPreviewReceiptPath || preview.content_type !== "video/mp4") {
    throw new Error("existing visual preview identity is stale or forged");
  }
  if (computeSha256(previewPath) !== preview.sha256 || computeSha256(previewReceiptPath) !== preview.receipt_sha256) {
    throw new Error("existing visual preview bytes are stale or forged");
  }
}

function assertPreapprovalReceiptMatches(
  projectDir: string,
  receiptPathCandidate: string | undefined,
  receipt: CaptionVisualTreatmentPreapprovalReceipt,
  input: CaptionVisualTreatmentInput,
  expectedPatchHash: string,
): void {
  assertSchema("caption-visual-treatment-preapproval-receipt.schema.json", receipt);
  const receiptPath = preapprovalReceiptPath(projectDir, receiptPathCandidate);
  const expected = preapprovalReceiptForInput(input, expectedPatchHash);
  if (receipt.version !== expected.version || receipt.project_id !== expected.project_id) {
    throw new Error("visual preapproval receipt identity is stale or mismatched");
  }
  if (receipt.expected_patch_hash !== expectedPatchHash || receipt.visual_treatment_patch_hash !== expectedPatchHash) {
    throw new Error(`visual preapproval receipt patch hash mismatch; expected=${expectedPatchHash}`);
  }
  if (receipt.receipt_hash !== captionVisualTreatmentPreapprovalReceiptHash(receipt)) {
    throw new Error("visual preapproval receipt hash is invalid");
  }
  const fields: Array<keyof CaptionVisualTreatmentPreapprovalReceipt> = [
    "approval_hash",
    "typography_policy_hash",
    "platform_safe_zone_profile_id",
    "platform_safe_zone_profile_path",
    "platform_safe_zone_profile_hash",
    "accessibility",
    "text_timing_hash",
    "capability_hash",
    "input_hash",
    "status",
    "applied_caption_ids",
    "degraded_reasons",
    "blocked_reasons",
  ];
  for (const field of fields) {
    if (JSON.stringify(receipt[field]) !== JSON.stringify(expected[field])) {
      throw new Error(`visual preapproval receipt ${String(field)} is stale or mismatched`);
    }
  }
  if (!fs.existsSync(receiptPath)) throw new Error(`visual preapproval receipt is missing: ${receiptPath}`);
}

function requireVisualApprovalOptions(
  options: CaptionVisualTreatmentReviewOptions | undefined,
): CaptionVisualTreatmentApprovalOptions {
  if (!options?.expectedPatchHash?.trim()) {
    throw new Error("expectedPatchHash is required for visual approval");
  }
  if (!options.preapprovalReceiptPath?.trim()) {
    throw new Error("preapprovalReceiptPath is required for visual approval");
  }
  return options as CaptionVisualTreatmentApprovalOptions;
}

/** Resolve and record candidate canonical evidence without changing approval. */
export function previewCaptionVisualTreatment(
  projectDir: string,
  reviewer: string,
  options: CaptionVisualTreatmentReviewOptions & { expectedPatchHash: string } = { expectedPatchHash: "" },
): CaptionVisualTreatmentPreapprovalResult {
  const actor = reviewer.trim();
  if (!actor) throw new Error("reviewer is required");
  if (!options.expectedPatchHash) throw new Error("expectedPatchHash is required for visual preapproval preview");
  const absoluteProjectDir = path.resolve(projectDir);
  const patchPath = resolveProjectArtifactPath(absoluteProjectDir, options.patchPath, CAPTION_VISUAL_TREATMENT_PATCH_PATH);
  const patch = loadCaptionVisualTreatmentPatch(patchPath);
  const currentPatchHash = captionVisualTreatmentPatchHash(patch);
  if (options.expectedPatchHash !== currentPatchHash) {
    throw new Error(`visual treatment patch changed since it was loaded; expected=${options.expectedPatchHash} current=${currentPatchHash}`);
  }
  const { approval } = visualTreatmentApproval(absoluteProjectDir);
  const input = visualTreatmentReviewInput(absoluteProjectDir, approval, patch, {
    ...options,
    accessibility: options.accessibility ?? { reduced_motion: false, high_contrast: false, audio_off: false, small_screen: false },
  });
  if (input.status === "blocked" || input.status === "human_hold") {
    throw new Error(`visual preapproval preview cannot be resolved: ${input.status}`);
  }
  const receipt = preapprovalReceiptForInput(input, currentPatchHash);
  const receiptPath = preapprovalReceiptPath(absoluteProjectDir, options.preapprovalReceiptPath);
  const inputPath = preapprovalInputPath(absoluteProjectDir);
  atomicWriteJson(inputPath, input);
  atomicWriteJson(receiptPath, receipt);
  return {
    patch,
    input,
    patchPath,
    inputPath,
    patchHash: currentPatchHash,
    inputHash: input.input_hash,
    receipt,
    receiptPath,
  };
}

/**
 * Atomically validates a visual operation against the approval and current
 * patch identity before persisting the candidate patch + preapproval evidence.
 * It never writes caption approval or speech text/timing.
 */
export function authorPreviewCaptionVisualTreatment(
  projectDir: string,
  reviewer: string,
  operation: CaptionVisualTreatmentPatch["operations"][number],
  options: CaptionVisualTreatmentReviewOptions & {
    expectedPatchHash: string;
    expectedApprovalHash: string;
    updatedAt?: string;
  },
): CaptionVisualTreatmentAuthorPreviewResult {
  const actor = reviewer.trim();
  if (!actor) throw new Error("reviewer is required");
  if (!options.expectedPatchHash) throw new Error("expectedPatchHash is required for visual author-preview");
  if (!options.expectedApprovalHash) throw new Error("expectedApprovalHash is required for visual author-preview");
  const absoluteProjectDir = path.resolve(projectDir);
  const { approval, approvalPath } = visualTreatmentApproval(absoluteProjectDir);
  const live = assertCaptionApprovalForExport(absoluteProjectDir, approvalPath);
  const approvalHashBefore = captionApprovalBindingHash(approval);
  if (approvalHashBefore !== options.expectedApprovalHash) {
    throw new Error(`caption approval changed since it was loaded; expected=${options.expectedApprovalHash} current=${approvalHashBefore}`);
  }
  if (approval.approval.status !== "approved") throw new Error("caption approval is stale or not approved");

  const context = loadCaptionReviewContext(absoluteProjectDir);
  const { policy } = visualTreatmentPolicy(absoluteProjectDir, options.typographyPolicyPath);
  const patchPath = resolveProjectArtifactPath(absoluteProjectDir, options.patchPath, CAPTION_VISUAL_TREATMENT_PATCH_PATH);
  const patchExists = fs.existsSync(patchPath);
  let patch: CaptionVisualTreatmentPatch;
  if (patchExists) {
    patch = loadCaptionVisualTreatmentPatch(patchPath);
    const currentPatchHash = captionVisualTreatmentPatchHash(patch);
    if (options.expectedPatchHash === "absent" || options.expectedPatchHash !== currentPatchHash) {
      throw new Error(`visual treatment patch changed since it was loaded; expected=${options.expectedPatchHash} current=${currentPatchHash}`);
    }
    if (patch.base_timeline_hash !== live.timelineHash) throw new Error("visual treatment patch base_timeline_hash is stale");
    if (patch.base_caption_draft_hash !== approval.approval.base_caption_draft_hash) throw new Error("visual treatment patch base_caption_draft_hash is stale");
    if (patch.caption_approval_hash !== approvalHashBefore) throw new Error("visual treatment patch caption approval binding is stale");
    const currentInput = visualTreatmentReviewInput(absoluteProjectDir, approval, patch, {
      ...options,
      accessibility: options.accessibility ?? { reduced_motion: false, high_contrast: false, audio_off: false, small_screen: false },
    });
    assertExistingAuthorPreviewEvidence(absoluteProjectDir, currentInput, currentPatchHash);
  } else {
    if (options.expectedPatchHash !== "absent") {
      throw new Error(`visual treatment patch is absent; expected=${options.expectedPatchHash}`);
    }
    const timestamp = options.updatedAt ?? new Date().toISOString();
    patch = {
      version: "caption-visual-treatment-patch/v1",
      project_id: approval.project_id,
      base_caption_draft_hash: approval.approval.base_caption_draft_hash ?? computeCaptionDraftHash(context.draft),
      base_timeline_hash: approval.approval.base_timeline_hash ?? context.timelineHash,
      typography_policy_hash: typographyPolicyContentHash(policy),
      caption_approval_hash: approvalHashBefore,
      operations: [],
      session: { reviewer: actor, started_at: timestamp, updated_at: timestamp },
    };
  }

  const currentPatchHash = captionVisualTreatmentPatchHash(patch);
  if (operation.expected_current_hash && operation.expected_current_hash !== currentPatchHash) {
    throw new Error(`visual treatment caption ${operation.caption_id} changed since it was loaded; expected=${operation.expected_current_hash} current=${currentPatchHash}`);
  }
  patch.operations.push(structuredClone(operation));
  patch.session.reviewer = actor;
  patch.session.updated_at = options.updatedAt ?? new Date().toISOString();
  const history = patch.session.action_operation_counts?.filter((count) => count > 0) ?? [];
  history.push(1);
  patch.session.action_operation_counts = history;
  patch.session.last_action_operation_count = 1;
  assertSchema("caption-visual-treatment-patch.schema.json", patch);

  const input = visualTreatmentReviewInput(absoluteProjectDir, approval, patch, {
    ...options,
    accessibility: options.accessibility ?? { reduced_motion: false, high_contrast: false, audio_off: false, small_screen: false },
  });
  if (input.status !== "ready") {
    throw new Error(`visual author-preview cannot be resolved: ${input.status}: ${input.blocked_reasons.map((item) => item.reason).join("; ")}`);
  }
  const patchHash = captionVisualTreatmentPatchHash(patch);
  const receipt = preapprovalReceiptForInput(input, patchHash);
  const receiptPath = preapprovalReceiptPath(absoluteProjectDir, options.preapprovalReceiptPath);
  const inputPath = preapprovalInputPath(absoluteProjectDir);

  // All validation and stale checks complete before the first write.
  atomicWriteJson(patchPath, patch);
  atomicWriteJson(inputPath, input);
  atomicWriteJson(receiptPath, receipt);

  const approvalAfter = readJsonFile<CaptionApproval>(approvalPath);
  const approvalHashAfter = captionApprovalBindingHash(approvalAfter);
  if (approvalHashAfter !== approvalHashBefore) {
    throw new Error("production caption approval changed during visual author-preview");
  }
  return {
    patch,
    input,
    patchPath,
    inputPath,
    patchHash,
    inputHash: input.input_hash,
    receipt,
    receiptPath,
    approvalHashBefore,
    approvalHashAfter,
    textTimingHashBefore: input.text_timing_hash,
    textTimingHashAfter: input.text_timing_hash,
    productionApprovalUnchanged: true,
  };
}

export function bindCaptionVisualTreatmentPreviewOutput(
  projectDir: string,
  result: CaptionVisualTreatmentAuthorPreviewResult,
  previewOutput: CaptionVisualTreatmentPreviewOutputBinding,
): CaptionVisualTreatmentPreapprovalReceipt {
  const root = path.resolve(projectDir);
  const outputPath = resolveProjectArtifactPath(root, previewOutput.outputPath, CAPTION_VISUAL_TREATMENT_PREVIEW_OUTPUT_PATH);
  const previewReceiptPath = resolveProjectArtifactPath(root, previewOutput.receiptPath, `${CAPTION_VISUAL_TREATMENT_PREVIEW_OUTPUT_PATH}.receipt.json`);
  if (path.extname(outputPath).toLowerCase() !== ".mp4" || previewOutput.contentType !== "video/mp4") {
    throw new Error("visual preview output must be a canonical video/mp4 artifact");
  }
  if (!fs.existsSync(outputPath) || !fs.existsSync(previewReceiptPath)) {
    throw new Error("visual preview output or canonical preview receipt is missing");
  }
  const live = assertCaptionApprovalForExport(root);
  if (live.timelineHash !== result.patch.base_timeline_hash) throw new Error("live timeline changed during visual preview rendering");
  const approval = readJsonFile<CaptionApproval>(path.join(root, CAPTION_APPROVAL_PATH));
  if (captionApprovalBindingHash(approval) !== result.approvalHashBefore) throw new Error("caption approval changed during visual preview rendering");
  const previewReceipt = readJsonFile<Record<string, any>>(previewReceiptPath);
  assertSchema("timeline-preview-receipt.schema.json", previewReceipt);
  const outputHash = computeSha256(outputPath);
  if (previewReceipt.actual_output?.sha256 !== outputHash) throw new Error("canonical visual preview receipt output hash mismatch");
  if (previewReceipt.parity?.caption_visual_treatment?.resolved_input_hash !== result.inputHash
    || previewReceipt.parity?.caption_visual_treatment?.matches !== true
    || previewReceipt.parity?.caption_visual_treatment?.route !== "ffmpeg-libass") {
    throw new Error("canonical renderer did not verify the visual-treatment preview");
  }
  const binding = {
    path: path.relative(root, outputPath).split(path.sep).join("/"),
    sha256: outputHash,
    content_type: "video/mp4" as const,
    receipt_path: path.relative(root, previewReceiptPath).split(path.sep).join("/"),
    receipt_sha256: computeSha256(previewReceiptPath),
  };
  const receipt = preapprovalReceiptForInput(result.input, result.patchHash, binding);
  atomicWriteJson(result.receiptPath, receipt);
  return receipt;
}

function persistCaptionVisualTreatmentResult(
  projectDir: string,
  patchPath: string,
  patch: CaptionVisualTreatmentPatch,
  input: CaptionVisualTreatmentInput,
): CaptionVisualTreatmentReviewResult {
  const absoluteProjectDir = path.resolve(projectDir);
  const canonicalPatchPath = path.join(absoluteProjectDir, CAPTION_VISUAL_TREATMENT_PATCH_PATH);
  const canonicalInputPath = path.join(absoluteProjectDir, CAPTION_VISUAL_TREATMENT_INPUT_PATH);
  atomicWriteJson(canonicalPatchPath, patch);
  atomicWriteJson(canonicalInputPath, input);
  return {
    patch,
    input,
    patchPath: canonicalPatchPath,
    inputPath: canonicalInputPath,
    patchHash: captionVisualTreatmentPatchHash(patch),
    inputHash: input.input_hash,
  };
}

/** Load and resolve the visual stream; a human hold is retained as evidence. */
export function applyCaptionVisualTreatmentReview(
  projectDir: string,
  options: CaptionVisualTreatmentReviewOptions = {},
): CaptionVisualTreatmentReviewResult {
  const absoluteProjectDir = path.resolve(projectDir);
  const patchPath = resolveProjectArtifactPath(absoluteProjectDir, options.patchPath, CAPTION_VISUAL_TREATMENT_PATCH_PATH);
  const patch = loadCaptionVisualTreatmentPatch(patchPath);
  const { approval } = visualTreatmentApproval(absoluteProjectDir);
  const input = visualTreatmentReviewInput(absoluteProjectDir, approval, patch, options);
  if (input.status === "blocked") throw new Error(`Caption visual-treatment patch is blocked: ${input.blocked_reasons.map((item) => item.reason).join("; ")}`);
  return persistCaptionVisualTreatmentResult(absoluteProjectDir, patchPath, patch, input);
}

/** Append a reviewed visual operation and record an undo boundary. */
export function appendCaptionVisualTreatmentOperations(
  projectDir: string,
  reviewer: string,
  operations: CaptionVisualTreatmentPatch["operations"],
  options: CaptionVisualTreatmentReviewOptions & { updatedAt?: string } = {},
): CaptionVisualTreatmentReviewResult {
  const actor = reviewer.trim();
  if (!actor) throw new Error("reviewer is required");
  if (operations.length === 0) throw new Error("at least one visual-treatment operation is required");
  const absoluteProjectDir = path.resolve(projectDir);
  const patchPath = resolveProjectArtifactPath(absoluteProjectDir, options.patchPath, CAPTION_VISUAL_TREATMENT_PATCH_PATH);
  const patch = loadCaptionVisualTreatmentPatch(patchPath);
  const currentPatchHash = captionVisualTreatmentPatchHash(patch);
  if (options.expectedPatchHash && options.expectedPatchHash !== currentPatchHash) {
    throw new Error(`visual treatment patch changed since it was loaded; expected=${options.expectedPatchHash} current=${currentPatchHash}`);
  }
  for (const operation of operations) {
    if (operation.expected_current_hash && operation.expected_current_hash !== currentPatchHash) {
      throw new Error(`visual treatment caption ${operation.caption_id} changed since it was loaded; expected=${operation.expected_current_hash} current=${currentPatchHash}`);
    }
  }
  patch.operations.push(...structuredClone(operations));
  patch.session.reviewer = actor;
  patch.session.updated_at = options.updatedAt ?? new Date().toISOString();
  const history = patch.session.action_operation_counts?.filter((count) => count > 0) ?? [];
  history.push(operations.length);
  patch.session.action_operation_counts = history;
  patch.session.last_action_operation_count = operations.length;
  assertSchema("caption-visual-treatment-patch.schema.json", patch);
  const { approval } = visualTreatmentApproval(absoluteProjectDir);
  const input = visualTreatmentReviewInput(absoluteProjectDir, approval, patch, options);
  if (input.status === "blocked") throw new Error(`Caption visual-treatment operation is blocked: ${input.blocked_reasons.map((item) => item.reason).join("; ")}`);
  return persistCaptionVisualTreatmentResult(absoluteProjectDir, patchPath, patch, input);
}

export function canUndoCaptionVisualTreatment(projectDir: string): boolean {
  const patchPath = path.join(path.resolve(projectDir), CAPTION_VISUAL_TREATMENT_PATCH_PATH);
  if (!fs.existsSync(patchPath)) return false;
  const patch = loadCaptionVisualTreatmentPatch(patchPath);
  return (patch.session.action_operation_counts?.length ?? (patch.session.last_action_operation_count ? 1 : 0)) > 0;
}

/** Undo only the last visual operation boundary; text/timing review is untouched. */
export function undoCaptionVisualTreatment(
  projectDir: string,
  options: CaptionVisualTreatmentReviewOptions & { updatedAt?: string } = {},
): CaptionVisualTreatmentUndoResult {
  const absoluteProjectDir = path.resolve(projectDir);
  const patchPath = resolveProjectArtifactPath(absoluteProjectDir, options.patchPath, CAPTION_VISUAL_TREATMENT_PATCH_PATH);
  const patch = loadCaptionVisualTreatmentPatch(patchPath);
  const currentPatchHash = captionVisualTreatmentPatchHash(patch);
  if (options.expectedPatchHash && options.expectedPatchHash !== currentPatchHash) {
    throw new Error(`visual treatment patch changed since it was loaded; expected=${options.expectedPatchHash} current=${currentPatchHash}`);
  }
  const history = patch.session.action_operation_counts?.filter((count) => count > 0) ?? (patch.session.last_action_operation_count ? [patch.session.last_action_operation_count] : []);
  const removedOperationCount = history.at(-1) ?? 0;
  if (removedOperationCount <= 0 || removedOperationCount > patch.operations.length) throw new Error("No visual-treatment operation is available to undo");
  patch.operations.splice(patch.operations.length - removedOperationCount, removedOperationCount);
  history.pop();
  patch.session.action_operation_counts = history;
  patch.session.last_action_operation_count = history.at(-1) ?? 0;
  if (options.reviewer?.trim()) patch.session.reviewer = options.reviewer.trim();
  patch.session.updated_at = options.updatedAt ?? new Date().toISOString();
  assertSchema("caption-visual-treatment-patch.schema.json", patch);
  const { approval } = visualTreatmentApproval(absoluteProjectDir);
  const input = visualTreatmentReviewInput(absoluteProjectDir, approval, patch, options);
  if (input.status === "blocked") throw new Error(`Caption visual-treatment undo is blocked: ${input.blocked_reasons.map((item) => item.reason).join("; ")}`);
  return { ...persistCaptionVisualTreatmentResult(absoluteProjectDir, patchPath, patch, input), removedOperationCount };
}

/** Naming alias used by review clients that treat undo as a review action. */
export const undoCaptionVisualTreatmentReview = undoCaptionVisualTreatment;

interface PreparedCaptionVisualTreatmentApproval {
  approvalForBinding: CaptionApproval;
  approvalPath: string;
  patch: CaptionVisualTreatmentPatch;
  patchPath: string;
  input: CaptionVisualTreatmentInput;
}

/** Validate a visual approval without writing any approval artifact. */
function prepareCaptionVisualTreatmentApproval(
  projectDir: string,
  reviewer: string,
  options: CaptionVisualTreatmentApprovalOptions,
  approvalOverride?: CaptionApproval,
): PreparedCaptionVisualTreatmentApproval {
  requireVisualApprovalOptions(options);
  const actor = reviewer.trim();
  if (!actor) throw new Error("reviewer is required");
  const absoluteProjectDir = path.resolve(projectDir);
  const approvalPath = path.join(absoluteProjectDir, CAPTION_APPROVAL_PATH);
  const approval = approvalOverride ?? visualTreatmentApproval(absoluteProjectDir).approval;
  if (!approvalOverride && (approval.approval.status !== "approved" || approval.approval.approved_by !== actor)) {
    throw new Error("visual treatment requires the existing human caption approval and reviewer identity");
  }
  const patchPath = resolveProjectArtifactPath(absoluteProjectDir, options.patchPath, CAPTION_VISUAL_TREATMENT_PATCH_PATH);
  const patch = loadCaptionVisualTreatmentPatch(patchPath);
  const currentPatchHash = captionVisualTreatmentPatchHash(patch);
  if (options.expectedPatchHash !== currentPatchHash) {
    throw new Error(`visual treatment patch changed since it was loaded; expected=${options.expectedPatchHash} current=${currentPatchHash}`);
  }
  const candidateReceiptPath = preapprovalReceiptPath(absoluteProjectDir, options.preapprovalReceiptPath);
  if (!fs.existsSync(candidateReceiptPath)) throw new Error(`visual preapproval receipt is required: ${candidateReceiptPath}`);
  const candidateReceipt = readJsonFile<CaptionVisualTreatmentPreapprovalReceipt>(candidateReceiptPath);
  const policyInfo = visualTreatmentPolicy(absoluteProjectDir, options.typographyPolicyPath);
  const capabilities = options.capabilities ?? captionRendererCapabilitiesForPolicy(policyInfo.policy);
  const context = resolveVisualTreatmentContext(absoluteProjectDir, approval, patch, options);
  const accessibility = context.accessibility ?? {
    reduced_motion: false,
    high_contrast: false,
    audio_off: false,
    small_screen: false,
  };
  if (context.safeZoneHash && !context.safeZonePath) {
    throw new Error("visual treatment safe-zone binding requires a registered profile path");
  }
  const approvalForBinding = structuredClone(approval);
  approvalForBinding.approval.visual_treatment_context = {
    accessibility,
    ...(context.safeZoneHash && context.safeZoneId && context.safeZonePath
      ? { safe_zone_profile: { profile_id: context.safeZoneId, path: context.safeZonePath, sha256: context.safeZoneHash } }
      : {}),
  };
  const candidateInput = visualTreatmentReviewInput(absoluteProjectDir, approvalForBinding, patch, {
    ...options,
    accessibility,
    platformSafeZoneProfileHash: context.safeZoneHash,
    platformSafeZoneProfileId: context.safeZoneId,
    platformSafeZoneProfilePath: context.safeZonePath,
    platformSafeZoneProfile: context.safeZoneProfile,
  });
  if (candidateInput.status === "blocked" || candidateInput.status === "human_hold") {
    throw new Error(`visual treatment cannot be human-approved: ${candidateInput.status}`);
  }
  assertPreapprovalReceiptMatches(absoluteProjectDir, options.preapprovalReceiptPath, candidateReceipt, candidateInput, options.expectedPatchHash);
  const result = applyCaptionVisualTreatmentPatch({
    approval: approvalForBinding,
    patch,
    typography_policy: policyInfo.policy,
    typography_policy_hash: policyInfo.hash,
    platform_safe_zone_profile_hash: context.safeZoneHash,
    platform_safe_zone_profile_id: context.safeZoneId,
    platform_safe_zone_profile_path: context.safeZonePath,
    platform_safe_zone_profile: context.safeZoneProfile,
    capabilities,
    accessibility,
    require_approval_binding: false,
  });
  if (!result.success || result.input.status === "blocked" || result.input.status === "human_hold") {
    throw new Error(`visual treatment cannot be human-approved: ${result.success ? result.input.status : result.errors.join("; ")}`);
  }
  const inputHash = captionVisualTreatmentCanonicalInputHash({
    approval: approvalForBinding,
    patch,
    typography_policy: policyInfo.policy,
    typography_policy_hash: policyInfo.hash,
    platform_safe_zone_profile_hash: context.safeZoneHash,
    platform_safe_zone_profile_id: context.safeZoneId,
    platform_safe_zone_profile_path: context.safeZonePath,
    platform_safe_zone_profile: context.safeZoneProfile,
    capabilities,
    accessibility,
    require_approval_binding: false,
  });
  approvalForBinding.approval.typography_policy_hash = policyInfo.hash;
  if (context.safeZoneHash) approvalForBinding.approval.platform_safe_zone_profile_hash = context.safeZoneHash;
  approvalForBinding.approval.caption_visual_treatment_patch_hash = captionVisualTreatmentPatchHash(patch);
  approvalForBinding.approval.visual_treatment_input_hash = inputHash;
  // Re-read immediately before the only approval write. A concurrent patch
  // must fail closed and leave the approval artifact byte-for-byte untouched.
  const finalPatch = loadCaptionVisualTreatmentPatch(patchPath);
  const finalPatchHash = captionVisualTreatmentPatchHash(finalPatch);
  if (options.expectedPatchHash !== finalPatchHash) {
    throw new Error(`visual treatment patch changed since it was loaded; expected=${options.expectedPatchHash} current=${finalPatchHash}`);
  }
  const finalReceipt = readJsonFile<CaptionVisualTreatmentPreapprovalReceipt>(candidateReceiptPath);
  assertPreapprovalReceiptMatches(absoluteProjectDir, options.preapprovalReceiptPath, finalReceipt, candidateInput, finalPatchHash);
  const input = visualTreatmentReviewInput(absoluteProjectDir, approvalForBinding, patch, {
    ...options,
    accessibility,
    platformSafeZoneProfileHash: context.safeZoneHash,
    platformSafeZoneProfileId: context.safeZoneId,
    platformSafeZoneProfilePath: context.safeZonePath,
    platformSafeZoneProfile: context.safeZoneProfile,
  });
  if (input.status !== "ready" && input.status !== "fallback") throw new Error(`visual treatment binding changed during approval: ${input.status}`);
  assertSchema("caption-approval.schema.json", approvalForBinding);
  return { approvalForBinding, approvalPath, patch, patchPath, input };
}

/** Bind a reviewed visual stream to the existing human caption approval. */
export function approveCaptionVisualTreatment(
  projectDir: string,
  reviewer: string,
  options: CaptionVisualTreatmentApprovalOptions,
): CaptionVisualTreatmentReviewResult & { approval: CaptionApproval; approvalPath: string; approvalHash: string } {
  const prepared = prepareCaptionVisualTreatmentApproval(projectDir, reviewer, options);
  atomicWriteJson(prepared.approvalPath, prepared.approvalForBinding);
  const persisted = persistCaptionVisualTreatmentResult(path.resolve(projectDir), prepared.patchPath, prepared.patch, prepared.input);
  return { ...persisted, approval: prepared.approvalForBinding, approvalPath: prepared.approvalPath, approvalHash: computeNormalizedJsonHash(prepared.approvalForBinding) };
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
  options: { patchPath?: string; approvedAt?: string; visualTreatment?: CaptionVisualTreatmentApprovalOptions; visualTreatmentPatchPath?: string; typographyPolicyPath?: string } = {},
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
      base_timeline_hash: context.timelineHash,
    },
  );
  assertSchema("caption-approval.schema.json", approval);
  const approvalPath = path.join(context.projectDir, CAPTION_APPROVAL_PATH);
  const visualTreatmentOptions = options.visualTreatment ?? (options.visualTreatmentPatchPath || options.typographyPolicyPath
    ? { patchPath: options.visualTreatmentPatchPath, typographyPolicyPath: options.typographyPolicyPath }
    : undefined);
  const requiredVisualTreatmentOptions = visualTreatmentOptions
    ? requireVisualApprovalOptions(visualTreatmentOptions)
    : undefined;
  const preparedVisualTreatment = requiredVisualTreatmentOptions
    ? prepareCaptionVisualTreatmentApproval(context.projectDir, actor, requiredVisualTreatmentOptions, approval)
    : undefined;
  atomicWriteJson(approvalPath, preparedVisualTreatment?.approvalForBinding ?? approval);
  const visualTreatment = preparedVisualTreatment
    ? persistCaptionVisualTreatmentResult(context.projectDir, preparedVisualTreatment.patchPath, preparedVisualTreatment.patch, preparedVisualTreatment.input)
    : undefined;
  const effectiveApproval = preparedVisualTreatment?.approvalForBinding ?? approval;
  return {
    approval: effectiveApproval,
    approvalPath,
    patchHash,
    validationHash,
    approvalHash: preparedVisualTreatment ? computeNormalizedJsonHash(preparedVisualTreatment.approvalForBinding) : computeNormalizedJsonHash(approval),
    ...(visualTreatment ? { visualTreatment } : {}),
  };
}

function stripReviewFields(entry: CaptionReviewPreview["speech_captions"][number]): CaptionDraftEntry {
  return projectCaptionEntry(entry) as CaptionDraftEntry;
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
  // Reconcile hashes root-level policy/style files as well as phase folders.
  // Omitting STYLE.md can demote an otherwise critique-ready staged project to
  // selects_ready before the caption generator is allowed to run.
  for (const relativePath of ["project_state.yaml", "STYLE.md", "analysis_policy.yaml"]) {
    const source = path.join(projectDir, relativePath);
    if (fs.existsSync(source)) fs.copyFileSync(source, path.join(stagingProjectDir, relativePath));
  }
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
