import * as fs from "node:fs";
import * as path from "node:path";
import { parse as parseYaml } from "yaml";
import {
  draftAndPromote,
  initCommand,
  isCommandError,
  transitionState,
  validateAgainstSchema,
  type CommandError,
  type DraftFile,
} from "../shared.js";
import { ProgressTracker } from "../../progress.js";
import type {
  ApprovalRecord,
  ProjectState,
} from "../../state/reconcile.js";
import {
  computeFileHash,
  snapshotArtifacts,
  writeProjectState,
} from "../../state/reconcile.js";
import type { CompileResult } from "../../compiler/index.js";
import { readCreativeBriefAutonomyMode } from "../../autonomy.js";
import {
  runReviewExistingTimelinePreflight,
  runReviewPreflight,
} from "./preflight.js";

export interface ReviewReport {
  version: string;
  project_id: string;
  timeline_version: string;
  created_at?: string;
  summary_judgment: {
    status: "approved" | "needs_revision" | "blocked";
    rationale: string;
    confidence?: number;
  };
  strengths: Array<{
    summary: string;
    details?: string;
    evidence?: string[];
    affected_beat_ids?: string[];
    affected_clip_ids?: string[];
  }>;
  weaknesses: Array<{
    summary: string;
    details?: string;
    evidence?: string[];
    affected_beat_ids?: string[];
    affected_clip_ids?: string[];
  }>;
  fatal_issues: Array<{
    summary: string;
    severity: "fatal";
    details?: string;
    evidence?: string[];
    affected_beat_ids?: string[];
    affected_clip_ids?: string[];
  }>;
  warnings: Array<{
    summary: string;
    severity: "warning";
    details?: string;
    evidence?: string[];
    affected_beat_ids?: string[];
    affected_clip_ids?: string[];
  }>;
  mismatches_to_brief: Array<{
    expected_ref: string;
    observed_issue: string;
    why_it_matters: string;
    evidence?: string[];
    affected_beat_ids?: string[];
    affected_clip_ids?: string[];
  }>;
  mismatches_to_blueprint: Array<{
    expected_ref: string;
    observed_issue: string;
    why_it_matters: string;
    evidence?: string[];
    affected_beat_ids?: string[];
    affected_clip_ids?: string[];
  }>;
  recommended_next_pass: {
    goal: string;
    actions: string[];
    preserve?: string[];
    alternative_directions?: string[];
  };
  preview_path?: string;
}

export interface PatchOperation {
  op: "replace_segment" | "trim_segment" | "move_segment" | "insert_segment"
    | "remove_segment" | "change_audio_policy" | "add_marker" | "add_note";
  target_clip_id?: string;
  with_segment_id?: string;
  new_src_in_us?: number;
  new_src_out_us?: number;
  new_timeline_in_frame?: number;
  new_duration_frames?: number;
  reason: string;
  confidence?: number;
  evidence?: string[];
  audio_policy?: {
    duck_music_db?: number;
    preserve_nat_sound?: boolean;
    fade_in_frames?: number;
    fade_out_frames?: number;
  };
  beat_id?: string;
  role?: string;
  label?: string;
}

export interface ReviewPatch {
  timeline_version: string;
  operations: PatchOperation[];
}

export interface HumanNote {
  id: string;
  timestamp: string;
  reviewer: string;
  observation: string;
  severity: "observation" | "suggestion" | "concern";
  directive_type?: "observation" | "replace_segment" | "insert_segment"
    | "remove_segment" | "move_segment" | "trim_segment";
  clip_ids?: string[];
  clip_refs?: string[];
  approved_segment_ids?: string[];
  timeline_in_frame?: number;
  timeline_us?: number;
  timeline_tc?: string;
}

export interface HumanNotes {
  version: string | number;
  project_id: string;
  notes: HumanNote[];
}

export interface ReviewAgent {
  run(ctx: ReviewAgentContext): Promise<ReviewAgentResult>;
}

export interface ReviewAgentContext {
  projectDir: string;
  projectId: string;
  currentState: ProjectState;
  timelineVersion: string;
  humanNotes: HumanNotes | null;
  styleMd: string | null;
}

export interface ReviewAgentResult {
  report: ReviewReport;
  patch: ReviewPatch;
}

export interface PatchSafetyResult {
  safe: boolean;
  rejectedOps: Array<{
    opIndex: number;
    op: string;
    reason: string;
  }>;
  filteredPatch: ReviewPatch;
}

interface HumanInsertDirective {
  segmentId: string;
  clipIds: string[];
  timelineInFrame?: number;
  timelineUs?: number;
}

export interface ReviewCommandResult {
  success: boolean;
  error?: CommandError;
  report?: ReviewReport;
  patch?: ReviewPatch;
  patchSafety?: PatchSafetyResult;
  compileResult?: CompileResult;
  preflight?: ReviewPreflightResult;
  previousState?: ProjectState;
  newState?: ProjectState;
  promoted?: string[];
  approvalRecord?: ApprovalRecord;
}

export interface ReviewPreflightStep {
  step: "compile" | "preview" | "qc";
  status: "completed" | "skipped";
  detail: string;
  artifactPath?: string;
}

export interface ReviewPreflightResult {
  steps: ReviewPreflightStep[];
  gapReport: string[];
  previewPath?: string;
  overviewPath?: string;
  qcSummaryPath: string;
}

export interface ReviewOperatorDecision {
  accepted: boolean;
  approvedBy?: string;
}

export type ReviewOperatorAccept = (ctx: {
  projectDir: string;
  projectId: string;
  report: ReviewReport;
  patch: ReviewPatch;
  patchSafety: PatchSafetyResult;
  preflight: ReviewPreflightResult;
}) => Promise<ReviewOperatorDecision> | ReviewOperatorDecision;

export interface ReviewCommandOptions {
  creativeOverride?: boolean;
  approvedBy?: string;
  overrideReason?: string;
  createdAt?: string;
  operatorAccept?: ReviewOperatorAccept;
  requireCompiledTimeline?: boolean;
  skipPreview?: boolean;
}

export function validatePatchSafety(
  patch: ReviewPatch,
  timelineJson: unknown,
  humanNotes: HumanNotes | null,
): PatchSafetyResult {
  const rejectedOps: PatchSafetyResult["rejectedOps"] = [];
  const safeOps: PatchOperation[] = [];
  const fallbackMap = buildFallbackMap(timelineJson);
  const humanApprovedSegments = buildHumanApprovedSegments(humanNotes);
  const humanInsertDirectives = buildHumanInsertDirectives(humanNotes);

  for (let i = 0; i < patch.operations.length; i++) {
    const op = patch.operations[i];
    if (op.op === "replace_segment") {
      const isValid = validateReplaceSegment(op, fallbackMap, humanApprovedSegments);
      if (!isValid) {
        rejectedOps.push({
          opIndex: i,
          op: op.op,
          reason: `with_segment_id "${op.with_segment_id}" is not in fallback_segment_ids of "${op.target_clip_id}" and not in human_notes approved_segment_ids`,
        });
        continue;
      }
    }

    if (op.op === "insert_segment") {
      const isValid = validateInsertSegment(op, humanInsertDirectives);
      if (!isValid) {
        rejectedOps.push({
          opIndex: i,
          op: op.op,
          reason: `insert_segment for "${op.with_segment_id}" has no human_notes directive with directive_type: insert_segment and machine-readable timeline anchor`,
        });
        continue;
      }
    }

    safeOps.push(op);
  }

  return {
    safe: rejectedOps.length === 0,
    rejectedOps,
    filteredPatch: {
      timeline_version: patch.timeline_version,
      operations: safeOps,
    },
  };
}

function buildFallbackMap(timelineJson: unknown): Map<string, string[]> {
  const map = new Map<string, string[]>();
  if (!timelineJson || typeof timelineJson !== "object") return map;

  const timeline = timelineJson as {
    tracks?: {
      video?: Array<{ clips?: Array<{ clip_id?: string; fallback_segment_ids?: string[] }> }>;
      audio?: Array<{ clips?: Array<{ clip_id?: string; fallback_segment_ids?: string[] }> }>;
    };
  };

  const trackGroups = [timeline.tracks?.video, timeline.tracks?.audio].filter(Boolean);
  for (const group of trackGroups) {
    for (const track of group!) {
      for (const clip of track.clips ?? []) {
        if (clip.clip_id) {
          map.set(clip.clip_id, clip.fallback_segment_ids ?? []);
        }
      }
    }
  }

  return map;
}

function buildHumanApprovedSegments(
  humanNotes: HumanNotes | null,
): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>();
  if (!humanNotes) return map;

  for (const note of humanNotes.notes) {
    if (note.directive_type === "replace_segment" && note.approved_segment_ids) {
      for (const clipId of note.clip_ids ?? []) {
        if (!map.has(clipId)) map.set(clipId, new Set());
        for (const segmentId of note.approved_segment_ids) {
          map.get(clipId)!.add(segmentId);
        }
      }
    }
  }

  return map;
}

function buildHumanInsertDirectives(
  humanNotes: HumanNotes | null,
): Map<string, HumanInsertDirective[]> {
  const directives = new Map<string, HumanInsertDirective[]>();
  if (!humanNotes) return directives;

  for (const note of humanNotes.notes) {
    if (
      note.directive_type === "insert_segment" &&
      note.approved_segment_ids &&
      (
        note.timeline_in_frame !== undefined ||
        note.timeline_us !== undefined ||
        (note.clip_ids?.length ?? 0) > 0
      )
    ) {
      for (const segmentId of note.approved_segment_ids) {
        const entry: HumanInsertDirective = {
          segmentId,
          clipIds: note.clip_ids ?? [],
          timelineInFrame: note.timeline_in_frame,
          timelineUs: note.timeline_us,
        };
        if (!directives.has(segmentId)) directives.set(segmentId, []);
        directives.get(segmentId)!.push(entry);
      }
    }
  }

  return directives;
}

function validateReplaceSegment(
  op: PatchOperation,
  fallbackMap: Map<string, string[]>,
  humanApprovedSegments: Map<string, Set<string>>,
): boolean {
  if (!op.target_clip_id || !op.with_segment_id) return false;
  const fallbacks = fallbackMap.get(op.target_clip_id);
  if (fallbacks?.includes(op.with_segment_id)) {
    return true;
  }
  return humanApprovedSegments.get(op.target_clip_id)?.has(op.with_segment_id) ?? false;
}

function validateInsertSegment(
  op: PatchOperation,
  humanInsertDirectives: Map<string, HumanInsertDirective[]>,
): boolean {
  if (!op.with_segment_id) return false;
  const directives = humanInsertDirectives.get(op.with_segment_id) ?? [];
  return directives.some((directive) => {
    const frameMatches = directive.timelineInFrame !== undefined &&
      op.new_timeline_in_frame === directive.timelineInFrame;
    const clipMatches = directive.clipIds.length > 0 &&
      !!op.target_clip_id &&
      directive.clipIds.includes(op.target_clip_id);
    return frameMatches || clipMatches;
  });
}

const ALLOWED_STATES: ProjectState[] = [
  "blueprint_ready",
  "timeline_drafted",
  "critique_ready",
];

export async function runReview(
  projectDir: string,
  agent: ReviewAgent,
  options?: ReviewCommandOptions,
): Promise<ReviewCommandResult> {
  const pt = new ProgressTracker(projectDir, "review", 5);
  const ctx = initCommand(projectDir, "/review", ALLOWED_STATES);
  if (isCommandError(ctx)) {
    pt.fail("init", ctx.message);
    return { success: false, error: ctx };
  }
  pt.advance();

  const { projectDir: absDir, reconcileResult, doc } = ctx;
  const previousState = doc.current_state;
  const projectId = doc.project_id || "";
  const gates = reconcileResult.gates;
  const fail = (
    stage: string,
    error: CommandError,
    extras: Omit<ReviewCommandResult, "success" | "error"> = {},
  ): ReviewCommandResult => {
    pt.fail(stage, error.message);
    return {
      success: false,
      error,
      previousState,
      ...extras,
    };
  };

  const autonomyMode = readCreativeBriefAutonomyMode(absDir);
  if (!autonomyMode) {
    return fail("brief", {
      code: "GATE_CHECK_FAILED",
      message: "creative_brief.yaml not found. Run /intent first.",
    });
  }

  if (gates.compile_gate === "blocked") {
    return fail("gate", {
      code: "GATE_CHECK_FAILED",
      message: "Compile gate is blocked — unresolved blockers with status 'blocker' exist. Resolve blockers before running /review.",
      details: { compile_gate: gates.compile_gate },
    });
  }

  if (gates.planning_gate === "blocked") {
    return fail("gate", {
      code: "GATE_CHECK_FAILED",
      message: "Planning gate is blocked — uncertainty_register has status 'blocker' entries. Resolve planning blockers before running /review.",
      details: { planning_gate: gates.planning_gate },
    });
  }

  const createdAt = options?.createdAt ?? new Date().toISOString();
  let compileResult: CompileResult;
  let timelineJson: unknown;
  let timelineVersion = "unknown";
  let preflight: ReviewPreflightResult;
  const skipPreview = options?.skipPreview ?? false;

  try {
    if (options?.requireCompiledTimeline) {
      if (gates.timeline_gate === "blocked") {
        return fail("preflight", {
          code: "GATE_CHECK_FAILED",
          message: "Timeline gate is blocked — run /compile before running /review.",
          details: { timeline_gate: gates.timeline_gate },
        });
      }
      const preflightResult = await runReviewExistingTimelinePreflight(absDir, createdAt, skipPreview);
      compileResult = preflightResult.compileResult;
      timelineJson = preflightResult.timelineJson;
      timelineVersion = preflightResult.timelineVersion;
      preflight = preflightResult.preflight;
    } else {
      const preflightResult = await runReviewPreflight(absDir, createdAt, skipPreview);
      compileResult = preflightResult.compileResult;
      timelineJson = preflightResult.timelineJson;
      timelineVersion = preflightResult.timelineVersion;
      preflight = preflightResult.preflight;
    }
  } catch (err) {
    return fail("preflight", {
      code: "GATE_CHECK_FAILED",
      message: `Deterministic preflight failed: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
  pt.advance("timeline.json");

  const humanNotesResult = readHumanNotes(absDir);
  if (humanNotesResult.error) {
    return fail("human_notes", humanNotesResult.error, {
      compileResult,
      preflight,
    });
  }
  const humanNotes = humanNotesResult.humanNotes;
  const styleMd = readStyleMd(absDir);
  const promoteGuardHashes = snapshotArtifacts(absDir).hashes;

  const agentResult = await agent.run({
    projectDir: absDir,
    projectId,
    currentState: previousState,
    timelineVersion,
    humanNotes,
    styleMd,
  });
  pt.advance();

  const patchSafety = validatePatchSafety(
    agentResult.patch,
    timelineJson,
    humanNotes,
  );
  const safePatch = patchSafety.filteredPatch;

  if (preflight.previewPath) {
    agentResult.report.preview_path = path.relative(absDir, preflight.previewPath);
  }

  const drafts: DraftFile[] = [
    {
      relativePath: "06_review/review_report.yaml",
      schemaFile: "review-report.schema.json",
      content: agentResult.report,
      format: "yaml",
    },
    {
      relativePath: "06_review/review_patch.json",
      schemaFile: "review-patch.schema.json",
      content: safePatch,
      format: "json",
    },
  ];

  const promoteResult = draftAndPromote(absDir, drafts, {
    preflightHashes: promoteGuardHashes,
    guardKeys: [
      "brief_hash",
      "blockers_hash",
      "selects_hash",
      "blueprint_hash",
      "uncertainty_hash",
      "timeline_version",
      "human_notes_hash",
      "style_hash",
      "review_report_version",
      "review_patch_hash",
    ],
  });
  pt.advance("review_report.yaml");
  if (!promoteResult.success) {
    const code = promoteResult.failure_kind === "validation"
      ? "VALIDATION_FAILED"
      : "PROMOTE_FAILED";
    const message = promoteResult.failure_kind === "concurrent_edit"
      ? `Artifact promote aborted due to concurrent edits: ${promoteResult.errors.join("; ")}`
      : promoteResult.failure_kind === "promote"
        ? `Artifact promote failed: ${promoteResult.errors.join("; ")}`
        : `Artifact validation failed: ${promoteResult.errors.join("; ")}`;
    return fail("promote", {
      code,
      message,
      details: promoteResult.errors,
    }, {
      compileResult,
      preflight,
    });
  }

  const hasFatal = agentResult.report.fatal_issues.length > 0;
  let newState: ProjectState;
  let approvalRecord: ApprovalRecord | undefined;

  if (hasFatal && !options?.creativeOverride) {
    newState = "critique_ready";
  } else if (hasFatal && options?.creativeOverride) {
    if (!options.approvedBy || !options.overrideReason) {
      return fail("approval", {
        code: "VALIDATION_FAILED",
        message: "Creative override requires approved_by and override_reason",
      });
    }
    newState = "approved";
    approvalRecord = buildApprovalRecord(
      "creative_override",
      absDir,
      options.approvedBy,
      options.overrideReason,
    );
  } else {
    const operatorDecision = autonomyMode === "full"
      ? (() => {
          console.log("[auto:full_autonomy] /review auto-approved clean review.");
          return {
            accepted: true,
            approvedBy: "auto:full_autonomy",
          };
        })()
      : options?.operatorAccept
        ? await options.operatorAccept({
          projectDir: absDir,
          projectId,
          report: agentResult.report,
          patch: safePatch,
          patchSafety,
          preflight,
        })
        : { accepted: false };

    if (operatorDecision.accepted) {
      const approvedBy = operatorDecision.approvedBy ?? options?.approvedBy;
      if (!approvedBy) {
        return fail("approval", {
          code: "VALIDATION_FAILED",
          message: "Operator acceptance requires approvedBy",
        }, {
          compileResult,
          preflight,
        });
      }
      newState = "approved";
      approvalRecord = buildApprovalRecord("clean", absDir, approvedBy);
    } else {
      newState = "critique_ready";
    }
  }

  if (approvalRecord) {
    doc.approval_record = approvalRecord;
    writeProjectState(absDir, doc);
  }

  const note = hasFatal && options?.creativeOverride
    ? `creative override: ${options.overrideReason}`
    : hasFatal
      ? "critique ready — fatal issues found"
      : approvalRecord
        ? autonomyMode === "full"
          ? "approved — clean review auto-approved"
          : "approved — operator accepted review"
        : "critique ready — awaiting operator acceptance";
  const updatedDoc = transitionState(
    absDir,
    doc,
    newState,
    "/review",
    "roughcut-critic",
    note,
  );

  pt.complete(["review_report.yaml", "review_patch.json"]);
  return {
    success: true,
    report: agentResult.report,
    patch: safePatch,
    patchSafety,
    compileResult,
    preflight,
    previousState,
    newState: updatedDoc.current_state,
    promoted: promoteResult.promoted,
    approvalRecord,
  };
}

function readHumanNotes(projectDir: string): {
  humanNotes: HumanNotes | null;
  error?: CommandError;
} {
  const notesPath = path.join(projectDir, "06_review/human_notes.yaml");
  if (!fs.existsSync(notesPath)) {
    return { humanNotes: null };
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(fs.readFileSync(notesPath, "utf-8"));
  } catch (err) {
    return {
      humanNotes: null,
      error: {
        code: "VALIDATION_FAILED",
        message: `Failed to parse human_notes.yaml: ${err instanceof Error ? err.message : String(err)}`,
      },
    };
  }

  const validation = validateAgainstSchema(parsed, "human-notes.schema.json");
  if (!validation.valid) {
    return {
      humanNotes: null,
      error: {
        code: "VALIDATION_FAILED",
        message: `human_notes.yaml failed schema validation: ${validation.errors.join("; ")}`,
        details: validation.errors,
      },
    };
  }

  return { humanNotes: parsed as HumanNotes };
}

function readStyleMd(projectDir: string): string | null {
  const stylePath = path.join(projectDir, "STYLE.md");
  if (!fs.existsSync(stylePath)) return null;
  try {
    return fs.readFileSync(stylePath, "utf-8");
  } catch {
    return null;
  }
}

function buildApprovalRecord(
  status: "clean" | "creative_override",
  projectDir: string,
  approvedBy: string,
  overrideReason?: string,
): ApprovalRecord {
  const hashes: ApprovalRecord["artifact_versions"] = {};

  const timelinePath = path.join(projectDir, "05_timeline/timeline.json");
  if (fs.existsSync(timelinePath)) {
    hashes.timeline_version = computeFileHash(timelinePath);
  }

  const reportPath = path.join(projectDir, "06_review/review_report.yaml");
  if (fs.existsSync(reportPath)) {
    hashes.review_report_version = computeFileHash(reportPath);
  }

  const patchPath = path.join(projectDir, "06_review/review_patch.json");
  if (fs.existsSync(patchPath)) {
    hashes.review_patch_hash = computeFileHash(patchPath);
  }

  const notesPath = path.join(projectDir, "06_review/human_notes.yaml");
  if (fs.existsSync(notesPath)) {
    hashes.human_notes_hash = computeFileHash(notesPath);
  }

  const stylePath = path.join(projectDir, "STYLE.md");
  if (fs.existsSync(stylePath)) {
    hashes.style_hash = computeFileHash(stylePath);
  }

  const record: ApprovalRecord = {
    status,
    approved_by: approvedBy,
    approved_at: new Date().toISOString(),
    artifact_versions: hashes,
  };

  if (overrideReason) {
    record.override_reason = overrideReason;
  }

  return record;
}

export {
  runReviewExistingTimelinePreflight,
  runReviewPreflight,
} from "./preflight.js";
