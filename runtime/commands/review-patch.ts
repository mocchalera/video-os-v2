/**
 * Small owner-operated review-patch/v2 seam.
 *
 * It checks one proposal against the exact approved canonical timeline.
 * Prepare/check do not write the project; install promotes only the accepted
 * patch and never rewrites the canonical timeline.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  draftAndPromote,
  parseJsonRejectDuplicateKeys,
  resolveProjectRoot,
  validateAgainstSchema,
} from "./shared.js";
import {
  buildApprovalRecord,
  readHumanNotes,
  validatePatchSafety,
  type ReviewPatch as ReviewCommandPatch,
} from "./review/index.js";
import {
  snapshotArtifacts,
  type ApprovalRecord,
  type ArtifactHashes,
} from "../state/reconcile.js";
import type { ReviewPatch } from "../compiler/patch.js";
import type { TimelineIR } from "../compiler/types.js";
import { inspectImmutableYamlFile } from "../eval/review-rounds.js";
import { inspectImmutableRecordFile } from "../review/review-rounds-ledger.js";

export type ReviewPatchOperatorMode = "prepare" | "check" | "install";

export interface ReviewPatchOperatorOptions {
  mode: ReviewPatchOperatorMode;
  projectDir: string;
  inputPath: string;
  outputPath?: string;
  accept?: boolean;
  approvedBy?: string;
}

export interface ReviewPatchOperatorResult {
  ok: true;
  mode: ReviewPatchOperatorMode;
  static_ready: true;
  project_id: string;
  timeline_version: string;
  base_timeline_sha256: string;
  input_sha256: string;
  status: "proposed" | "accepted";
  operation_count: number;
  project_writes: string[];
  canonical_timeline_unchanged: true;
  current_artifact_hashes: ArtifactHashes;
  patch: ReviewPatch;
  output_path?: string;
  installed_sha256?: string;
  accepted_by?: string;
}

export class ReviewPatchOperatorError extends Error {
  readonly code: string;
  readonly details?: unknown;

  constructor(code: string, message: string, details?: unknown) {
    super(message);
    this.name = "ReviewPatchOperatorError";
    this.code = code;
    this.details = details;
  }
}

const TIMELINE_PATH = "05_timeline/timeline.json";
const STATE_PATH = "project_state.yaml";
const PATCH_PATH = "06_review/review_patch.json";
const APPROVAL_HASH_KEYS = [
  "timeline_version",
  "review_report_version",
  "review_patch_hash",
  "human_notes_hash",
  "style_hash",
  "editorial_timeline_hash",
] as const;

interface JsonSnapshot {
  sha256: string;
  document: unknown;
}

interface Preflight {
  projectRoot: string;
  timeline: TimelineIR;
  timelineSha256: string;
  artifactHashes: ArtifactHashes;
  state: Record<string, unknown>;
  approval: ApprovalRecord;
  approvedBy: string;
  inputSha256: string;
  patch: ReviewPatch;
}

function fail(code: string, message: string, details?: unknown): never {
  throw new ReviewPatchOperatorError(code, message, details);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isRealIsoInstant(value: unknown): value is string {
  if (typeof value !== "string"
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed)
    && new Date(parsed).toISOString().slice(0, 19) === value.slice(0, 19);
}

function immutableJson(filePath: string, label: string, root?: string): JsonSnapshot {
  const captured = inspectImmutableRecordFile(filePath, root);
  if (!captured.ok) fail("INPUT_INVALID", label + " is not a stable immutable JSON file: " + captured.reason);
  try {
    return {
      sha256: captured.sha256,
      document: parseJsonRejectDuplicateKeys(captured.bytes, label),
    };
  } catch (error) {
    fail("INPUT_INVALID", label + " contains invalid JSON: " + (error instanceof Error ? error.message : String(error)));
  }
}

function projectRoot(input: string): string {
  try {
    const resolved = resolveProjectRoot(input);
    if (!fs.lstatSync(resolved).isDirectory()) fail("PATH_INVALID", "project path is not a directory: " + resolved);
    return fs.realpathSync(resolved);
  } catch (error) {
    if (error instanceof ReviewPatchOperatorError) throw error;
    fail("INPUT_NOT_FOUND", "project directory is not available: " + (error instanceof Error ? error.message : String(error)));
  }
}

function assertReviewNamespace(root: string): void {
  const reviewDir = path.join(root, "06_review");
  if (!fs.existsSync(reviewDir)) return;
  const stats = fs.lstatSync(reviewDir);
  if (stats.isSymbolicLink() || !stats.isDirectory() || fs.realpathSync(reviewDir) !== reviewDir) {
    fail("PATH_INVALID", "06_review is not a real project directory");
  }
}

function readTimeline(root: string): { timeline: TimelineIR; sha256: string } {
  const captured = immutableJson(path.join(root, TIMELINE_PATH), "canonical timeline", root);
  const validation = validateAgainstSchema(captured.document, "timeline-ir.schema.json");
  if (!validation.valid) fail("INPUT_INVALID", "canonical timeline failed schema validation", validation.errors);
  if (!isRecord(captured.document) || !hasText(captured.document.project_id) || !hasText(captured.document.version)) {
    fail("INPUT_INVALID", "canonical timeline must contain project_id and version");
  }
  return { timeline: captured.document as unknown as TimelineIR, sha256: captured.sha256 };
}

function readState(root: string): Record<string, unknown> {
  const captured = inspectImmutableYamlFile(root, STATE_PATH);
  if ("error" in captured) fail("INPUT_INVALID", "project_state.yaml is not stable: " + captured.error);
  const validation = validateAgainstSchema(captured.document, "project-state.schema.json");
  if (!validation.valid) fail("INPUT_INVALID", "project_state.yaml failed schema validation", validation.errors);
  if (!isRecord(captured.document)) fail("INPUT_INVALID", "project_state.yaml must contain an object");
  return captured.document;
}

function approvedRecord(state: Record<string, unknown>): ApprovalRecord {
  if (!isRecord(state.approval_record)
    || (state.approval_record.status !== "clean" && state.approval_record.status !== "creative_override")) {
    fail("NOT_APPROVED", "project_state.yaml does not contain a clean approval_record");
  }
  if (!hasText(state.approval_record.approved_by)
    || !isRealIsoInstant(state.approval_record.approved_at)) {
    fail("NOT_APPROVED", "approval_record is missing approved_by or approved_at");
  }
  if (!isRecord(state.approval_record.artifact_versions)) {
    fail("APPROVAL_STALE", "approval_record has no artifact_versions binding");
  }
  return state.approval_record as unknown as ApprovalRecord;
}

function assertCurrentHashes(
  approval: ApprovalRecord,
  current: ArtifactHashes,
  timeline: TimelineIR,
): void {
  const versions = approval.artifact_versions;
  if (!versions || !hasText(versions.timeline_version)) {
    fail("APPROVAL_STALE", "approval_record has no timeline_version binding");
  }
  for (const key of APPROVAL_HASH_KEYS) {
    const approved = versions[key];
    if (approved !== undefined && (approved !== current[key] || !hasText(current[key]))) {
      fail("APPROVAL_STALE", "approval_record." + key + " does not match the current artifact hash", {
        artifact: key,
        approved,
        current: current[key],
      });
    }
  }
  if (versions.base_timeline_version !== undefined
    && versions.base_timeline_version !== String(timeline.version)) {
    fail("APPROVAL_STALE", "approval_record.base_timeline_version does not match the current timeline version", {
      approved: versions.base_timeline_version,
      current: String(timeline.version),
    });
  }
}

function inputPatch(inputPath: string): { patch: ReviewPatch; sha256: string } {
  const captured = immutableJson(path.resolve(inputPath), "review patch input");
  const validation = validateAgainstSchema(captured.document, "review-patch.schema.json");
  if (!validation.valid) fail("INPUT_INVALID", "review patch input failed schema validation", validation.errors);
  if (!isRecord(captured.document)) fail("INPUT_INVALID", "review patch input must contain an object");
  return { patch: captured.document as unknown as ReviewPatch, sha256: captured.sha256 };
}

function normalizedPatch(
  input: ReviewPatch,
  timeline: TimelineIR,
  timelineSha256: string,
  mode: ReviewPatchOperatorMode,
): ReviewPatch {
  if (mode === "install"
    && (input.patch_version !== "review-patch/v2" || input.status !== "proposed")) {
    fail("PREPARED_INPUT_REQUIRED", "install accepts only a prepared proposed review-patch/v2 candidate");
  }
  if (input.status === "rejected") fail("PATCH_REJECTED", "rejected review patch input cannot be used");
  if (mode !== "check" && input.status === "accepted") {
    fail("ACCEPTED_INPUT", "prepare/install require a proposed patch; acceptance is supplied explicitly at install");
  }
  if (input.timeline_version !== String(timeline.version)) {
    fail("TIMELINE_MISMATCH", "review patch timeline_version does not match the current timeline", {
      patch: input.timeline_version,
      current: String(timeline.version),
    });
  }
  if (input.base_timeline_sha256 !== undefined && input.base_timeline_sha256 !== timelineSha256) {
    fail("TIMELINE_MISMATCH", "review patch base_timeline_sha256 does not match the current timeline", {
      patch: input.base_timeline_sha256,
      current: timelineSha256,
    });
  }
  return {
    patch_version: "review-patch/v2",
    timeline_version: String(timeline.version),
    base_timeline_sha256: timelineSha256,
    status: mode === "check" && input.status === "accepted" ? "accepted" : "proposed",
    operations: input.operations,
  };
}

function assertSafe(patch: ReviewPatch, timeline: TimelineIR, root: string): void {
  const notes = readHumanNotes(root, timeline.project_id);
  if (notes.error) fail("INPUT_INVALID", notes.error.message, notes.error.details);
  const safety = validatePatchSafety(patch as unknown as ReviewCommandPatch, timeline, notes.humanNotes);
  if (!safety.safe) {
    fail("PATCH_UNSAFE", "review patch is outside the existing human-safe correction boundary", safety.rejectedOps);
  }
}

function preflight(options: ReviewPatchOperatorOptions): Preflight {
  const root = projectRoot(options.projectDir);
  assertReviewNamespace(root);
  const current = readTimeline(root);
  const state = readState(root);
  if (state.project_id !== current.timeline.project_id) {
    fail("PROJECT_MISMATCH", "project_state.yaml project_id does not match canonical timeline project_id");
  }
  if (state.current_state !== "approved") {
    fail("NOT_APPROVED", "project_state.yaml current_state is not approved");
  }
  const approval = approvedRecord(state);
  const artifactHashes = snapshotArtifacts(root).hashes;
  assertCurrentHashes(approval, artifactHashes, current.timeline);
  const input = inputPatch(options.inputPath);
  const patch = normalizedPatch(input.patch, current.timeline, current.sha256, options.mode);
  assertSafe(patch, current.timeline, root);
  return {
    projectRoot: root,
    timeline: current.timeline,
    timelineSha256: current.sha256,
    artifactHashes,
    state,
    approval,
    approvedBy: approval.approved_by!.trim(),
    inputSha256: input.sha256,
    patch,
  };
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative.length === 0
    || (relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative));
}

function writePrepared(root: string, input: string, output: string, patch: ReviewPatch): string {
  const target = path.resolve(output);
  if (isInside(root, target) || target === path.resolve(input)) {
    fail("PATH_INVALID", "prepare output must be outside the project and different from the input");
  }
  const parent = path.dirname(target);
  if (!fs.existsSync(parent) || isInside(root, fs.realpathSync(parent))) {
    fail("PATH_INVALID", "prepare output parent must be an existing directory outside the project");
  }
  try {
    fs.writeFileSync(target, JSON.stringify(patch, null, 2), { encoding: "utf8", flag: "wx" });
  } catch (error) {
    fail("PATH_INVALID", "prepare output could not be created: " + (error instanceof Error ? error.message : String(error)));
  }
  return target;
}

export function runReviewPatchOperator(options: ReviewPatchOperatorOptions): ReviewPatchOperatorResult {
  if (!options.inputPath) fail("USAGE", "review patch input path is required");
  const acceptedBy = options.approvedBy?.trim();
  if (options.mode === "install" && (options.accept !== true || !acceptedBy)) {
    fail("ACCEPTANCE_REQUIRED", "install requires --accept and a non-empty --approved-by");
  }
  const checked = preflight(options);
  if (options.mode === "prepare") {
    const outputPath = options.outputPath
      ? writePrepared(checked.projectRoot, options.inputPath, options.outputPath, checked.patch)
      : undefined;
    return {
      ok: true,
      mode: "prepare",
      static_ready: true,
      project_id: checked.timeline.project_id,
      timeline_version: String(checked.timeline.version),
      base_timeline_sha256: checked.timelineSha256,
      input_sha256: checked.inputSha256,
      status: "proposed",
      operation_count: checked.patch.operations.length,
      project_writes: [],
      canonical_timeline_unchanged: true,
      current_artifact_hashes: checked.artifactHashes,
      patch: checked.patch,
      ...(outputPath ? { output_path: outputPath } : {}),
    };
  }
  if (options.outputPath) fail("USAGE", "--output is allowed only for prepare");
  if (options.mode === "check") {
    return {
      ok: true,
      mode: "check",
      static_ready: true,
      project_id: checked.timeline.project_id,
      timeline_version: String(checked.timeline.version),
      base_timeline_sha256: checked.timelineSha256,
      input_sha256: checked.inputSha256,
      status: checked.patch.status === "accepted" ? "accepted" : "proposed",
      operation_count: checked.patch.operations.length,
      project_writes: [],
      canonical_timeline_unchanged: true,
      current_artifact_hashes: checked.artifactHashes,
      patch: checked.patch,
    };
  }
  if (!acceptedBy) fail("ACCEPTANCE_REQUIRED", "install requires --accept and a non-empty --approved-by");
  if (acceptedBy !== checked.approvedBy) {
    fail("APPROVAL_ACTOR_MISMATCH", "--approved-by must match the established approval actor", {
      approved_by: checked.approvedBy,
      requested_by: acceptedBy,
    });
  }
  const accepted: ReviewPatch = { ...checked.patch, status: "accepted" };
  const acceptedPatchHash = crypto.createHash("sha256")
    .update(JSON.stringify(accepted, null, 2), "utf8")
    .digest("hex")
    .slice(0, 16);
  const approvalRecord = buildApprovalRecord(
    checked.approval.status === "creative_override" ? "creative_override" : "clean",
    checked.projectRoot,
    acceptedBy,
    checked.approval.override_reason,
    { includeHumanCorrectionBinding: false },
  );
  approvalRecord.artifact_versions = {
    ...approvalRecord.artifact_versions,
    review_patch_hash: acceptedPatchHash,
    ...(checked.approval.artifact_versions?.base_timeline_version
      ? { base_timeline_version: checked.approval.artifact_versions.base_timeline_version }
      : { base_timeline_version: String(checked.timeline.version) }),
    ...(checked.approval.artifact_versions?.editorial_timeline_hash
      ? { editorial_timeline_hash: checked.approval.artifact_versions.editorial_timeline_hash }
      : { editorial_timeline_hash: checked.artifactHashes.editorial_timeline_hash }),
    ...(checked.approval.artifact_versions?.human_correction_approval
      ? { human_correction_approval: checked.approval.artifact_versions.human_correction_approval }
      : {}),
  };
  const stateToPromote = {
    ...checked.state,
    current_state: "approved",
    last_updated: approvalRecord.approved_at,
    approval_record: approvalRecord,
  };
  const promoted = draftAndPromote(
    checked.projectRoot,
    [
      { relativePath: PATCH_PATH, schemaFile: "review-patch.schema.json", content: accepted, format: "json" },
      { relativePath: STATE_PATH, schemaFile: "project-state.schema.json", content: stateToPromote, format: "yaml" },
    ],
    { preflightHashes: checked.artifactHashes },
  );
  if (!promoted.success) {
    fail("PROMOTE_FAILED", "accepted review patch and approval state were not installed", {
      errors: promoted.errors,
      failure_kind: promoted.failure_kind,
      recovery: promoted.recovery,
    });
  }
  const installed = immutableJson(path.join(checked.projectRoot, PATCH_PATH), "installed review patch", checked.projectRoot);
  const validation = validateAgainstSchema(installed.document, "review-patch.schema.json");
  if (!validation.valid) fail("PROMOTE_FAILED", "installed review patch failed schema validation", validation.errors);
  const currentArtifactHashes = snapshotArtifacts(checked.projectRoot).hashes;
  return {
    ok: true,
    mode: "install",
    static_ready: true,
    project_id: checked.timeline.project_id,
    timeline_version: String(checked.timeline.version),
    base_timeline_sha256: checked.timelineSha256,
    input_sha256: checked.inputSha256,
    status: "accepted",
    operation_count: accepted.operations.length,
    project_writes: [PATCH_PATH, STATE_PATH],
    canonical_timeline_unchanged: true,
    current_artifact_hashes: currentArtifactHashes,
    patch: accepted,
    installed_sha256: installed.sha256,
    accepted_by: acceptedBy,
  };
}

export function reviewPatchOperatorErrorPayload(error: unknown): {
  code: string;
  message: string;
  details?: unknown;
} {
  if (error instanceof ReviewPatchOperatorError) {
    return {
      code: error.code,
      message: error.message,
      ...(error.details !== undefined ? { details: error.details } : {}),
    };
  }
  return { code: "REVIEW_PATCH_FAILED", message: error instanceof Error ? error.message : String(error) };
}
