/**
 * /review Command
 *
 * Wraps roughcut-critic agent to produce:
 * - 06_review/review_report.yaml
 * - 06_review/review_patch.json
 *
 * Preflight sequence (design doc §4):
 * 1. Compile preflight: runs M1 compiler → timeline.json
 * 2. Gate 1 check: unresolved_blockers blocker → compile blocked
 * 3. roughcut-critic agent → critique
 * 4. Patch safety guard
 * 5. State transition based on fatal_issues / creative override
 *
 * LLM agent is injectable for testability.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { parse as parseYaml } from "yaml";
import {
  initCommand,
  isCommandError,
  draftAndPromote,
  transitionState,
  validateAgainstSchema,
  type CommandError,
  type DraftFile,
} from "./shared.js";
import { ProgressTracker } from "../progress.js";
import type {
  ProjectState,
  GateStatus,
  ApprovalRecord,
} from "../state/reconcile.js";
import { computeFileHash, snapshotArtifacts, writeProjectState } from "../state/reconcile.js";
import { compile, type CompileResult } from "../compiler/index.js";
import { readCreativeBriefAutonomyMode } from "../autonomy.js";
import { loadSourceMap } from "../media/source-map.js";
import { renderPreviewSegment } from "../preview/segment-renderer.js";
import { generateTimelineOverview } from "../preview/timeline-overview.js";

// ── Types ────────────────────────────────────────────────────────

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

/** The agent function signature — injectable for testing */
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
  /** If true, override fatal issues and force approved state */
  creativeOverride?: boolean;
  /** Who is approving (required for creative override) */
  approvedBy?: string;
  /** Reason for creative override */
  overrideReason?: string;
  /** Deterministic timestamp for compile */
  createdAt?: string;
  /** Explicit human-in-the-loop approval callback for clean approval */
  operatorAccept?: ReviewOperatorAccept;
  /** Phase-split mode: refuse to auto-compile and require timeline.json to exist already */
  requireCompiledTimeline?: boolean;
  /** Skip preview/overview generation (--skip-preview) */
  skipPreview?: boolean;
}

// ── Patch Safety Guard ──────────────────────────────────────────

/**
 * Validates that patch operations only use safe replacement sources:
 * - replace_segment: with_segment_id must be in the target clip's
 *   fallback_segment_ids OR in human_notes approved_segment_ids
 * - insert_segment: must have deterministic target and human note
 *   with directive_type: insert_segment + machine-readable anchor
 */
export function validatePatchSafety(
  patch: ReviewPatch,
  timelineJson: unknown,
  humanNotes: HumanNotes | null,
): PatchSafetyResult {
  const rejectedOps: PatchSafetyResult["rejectedOps"] = [];
  const safeOps: PatchOperation[] = [];

  // Build lookup: clip_id → fallback_segment_ids from timeline
  const fallbackMap = buildFallbackMap(timelineJson);

  // Build lookup: approved_segment_ids from human notes with directive_type
  const humanApprovedSegments = buildHumanApprovedSegments(humanNotes);

  // Build lookup: insert directives from human notes
  const humanInsertDirectives = buildHumanInsertDirectives(humanNotes);

  for (let i = 0; i < patch.operations.length; i++) {
    const op = patch.operations[i];

    if (op.op === "replace_segment") {
      const isValid = validateReplaceSegment(
        op,
        fallbackMap,
        humanApprovedSegments,
      );
      if (!isValid) {
        rejectedOps.push({
          opIndex: i,
          op: op.op,
          reason: `with_segment_id "${op.with_segment_id}" is not in fallback_segment_ids of ` +
            `"${op.target_clip_id}" and not in human_notes approved_segment_ids`,
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
          reason: `insert_segment for "${op.with_segment_id}" has no human_notes directive ` +
            `with directive_type: insert_segment and machine-readable timeline anchor`,
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

  const tl = timelineJson as {
    tracks?: {
      video?: Array<{ clips?: Array<{ clip_id?: string; fallback_segment_ids?: string[] }> }>;
      audio?: Array<{ clips?: Array<{ clip_id?: string; fallback_segment_ids?: string[] }> }>;
    };
  };

  const trackGroups = [tl.tracks?.video, tl.tracks?.audio].filter(Boolean);
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
  // Maps clip_id → set of approved_segment_ids from human notes
  // with directive_type: replace_segment
  const map = new Map<string, Set<string>>();
  if (!humanNotes) return map;

  for (const note of humanNotes.notes) {
    if (note.directive_type === "replace_segment" && note.approved_segment_ids) {
      for (const clipId of note.clip_ids ?? []) {
        if (!map.has(clipId)) map.set(clipId, new Set());
        for (const segId of note.approved_segment_ids) {
          map.get(clipId)!.add(segId);
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
      for (const segId of note.approved_segment_ids) {
        const entry: HumanInsertDirective = {
          segmentId: segId,
          clipIds: note.clip_ids ?? [],
          timelineInFrame: note.timeline_in_frame,
          timelineUs: note.timeline_us,
        };
        if (!directives.has(segId)) directives.set(segId, []);
        directives.get(segId)!.push(entry);
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

  // Check fallback_segment_ids
  const fallbacks = fallbackMap.get(op.target_clip_id);
  if (fallbacks && fallbacks.includes(op.with_segment_id)) {
    return true;
  }

  // Check human_notes approved_segment_ids
  const humanApproved = humanApprovedSegments.get(op.target_clip_id);
  if (humanApproved && humanApproved.has(op.with_segment_id)) {
    return true;
  }

  return false;
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

// ── Command Implementation ───────────────────────────────────────

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

  // 1. Init command (reconcile + state check)
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

  // 2. Gate 1 check: compile_gate must be open
  if (gates.compile_gate === "blocked") {
    return fail("gate", {
      code: "GATE_CHECK_FAILED",
      message: "Compile gate is blocked — unresolved blockers with status 'blocker' exist. " +
        "Resolve blockers before running /review.",
      details: { compile_gate: gates.compile_gate },
    });
  }

  // 3. Planning gate check
  if (gates.planning_gate === "blocked") {
    return fail("gate", {
      code: "GATE_CHECK_FAILED",
      message: "Planning gate is blocked — uncertainty_register has status 'blocker' entries. " +
        "Resolve planning blockers before running /review.",
      details: { planning_gate: gates.planning_gate },
    });
  }

  const createdAt = options?.createdAt ?? new Date().toISOString();

  // 4. Deterministic preflight: compile → preview → QC summary
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

  // 5. Read optional inputs: human_notes.yaml, STYLE.md
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

  // 6. Run roughcut-critic agent (LLM or mock)
  const agentResult = await agent.run({
    projectDir: absDir,
    projectId,
    currentState: previousState,
    timelineVersion,
    humanNotes,
    styleMd,
  });

  pt.advance();

  // 7. Patch safety guard
  const patchSafety = validatePatchSafety(
    agentResult.patch,
    timelineJson,
    humanNotes,
  );

  // Use the filtered patch (safe operations only)
  const safePatch = patchSafety.filteredPatch;

  // 7b. Inject preview_path into report if preview was generated
  if (preflight.previewPath) {
    agentResult.report.preview_path = path.relative(absDir, preflight.previewPath);
  }

  // 8. Draft review artifacts
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

  // 9. Validate + promote
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

  // 10. Determine state transition based on fatal_issues / operator accept
  const hasFatal = agentResult.report.fatal_issues.length > 0;

  let newState: ProjectState;
  let approvalRecord: ApprovalRecord | undefined;

  if (hasFatal && !options?.creativeOverride) {
    // Fatal issues present, no override → critique_ready (can re-review)
    newState = "critique_ready";
  } else if (hasFatal && options?.creativeOverride) {
    // Fatal issues present but operator overrides → approved with creative_override
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

  // 11. Record approval_record in doc if transitioning to approved
  if (approvalRecord) {
    doc.approval_record = approvalRecord;
    writeProjectState(absDir, doc);
  }

  // 12. State transition
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

// ── Helpers ──────────────────────────────────────────────────────

async function runReviewExistingTimelinePreflight(
  projectDir: string,
  createdAt: string,
  skipPreview: boolean,
): Promise<{
  compileResult: CompileResult;
  timelineJson: unknown;
  timelineVersion: string;
  preflight: ReviewPreflightResult;
}> {
  const timelinePath = path.join(projectDir, "05_timeline/timeline.json");
  if (!fs.existsSync(timelinePath)) {
    throw new Error("timeline.json not found");
  }

  const timelineJson = JSON.parse(fs.readFileSync(timelinePath, "utf-8"));
  const timelineVersion = (timelineJson as { version?: string }).version ?? "unknown";
  const compileResult = buildCompileResultFromExistingTimeline(projectDir, timelineJson);
  const preflight = await generateReviewPreviewAndQc(projectDir, createdAt, timelineJson, timelineVersion, skipPreview);

  return {
    compileResult,
    timelineJson,
    timelineVersion,
    preflight,
  };
}

async function runReviewPreflight(
  projectDir: string,
  createdAt: string,
  skipPreview: boolean,
): Promise<{
  compileResult: CompileResult;
  timelineJson: unknown;
  timelineVersion: string;
  preflight: ReviewPreflightResult;
}> {
  const steps: ReviewPreflightStep[] = [];
  const gapReport: string[] = [];

  const compileResult = compile({
    projectPath: projectDir,
    createdAt,
  });
  steps.push({
    step: "compile",
    status: "completed",
    detail: "Compiled timeline.json deterministically from canonical artifacts.",
    artifactPath: compileResult.outputPath,
  });

  const timelinePath = path.join(projectDir, "05_timeline/timeline.json");
  const timelineJson = JSON.parse(fs.readFileSync(timelinePath, "utf-8"));
  const timelineVersion = (timelineJson as { version?: string }).version ?? "unknown";
  const preflight = await generateReviewPreviewAndQc(projectDir, createdAt, timelineJson, timelineVersion, skipPreview);
  steps.push(...preflight.steps);
  gapReport.push(...preflight.gapReport);

  return {
    compileResult,
    timelineJson,
    timelineVersion,
    preflight: {
      steps,
      gapReport,
      previewPath: preflight.previewPath,
      overviewPath: preflight.overviewPath,
      qcSummaryPath: preflight.qcSummaryPath,
    },
  };
}

async function generateReviewPreviewAndQc(
  projectDir: string,
  createdAt: string,
  timelineJson: unknown,
  timelineVersion: string,
  skipPreview: boolean,
): Promise<ReviewPreflightResult> {
  const steps: ReviewPreflightStep[] = [];
  const gapReport: string[] = [];
  let previewPath: string | undefined;
  let overviewPath: string | undefined;

  const timelinePath = path.join(projectDir, "05_timeline/timeline.json");

  if (!skipPreview) {
    const sourceMap = loadSourceMap(projectDir);

    // 1. Generate timeline-overview.png if missing
    const overviewTarget = path.join(projectDir, "05_timeline/timeline-overview.png");
    if (!fs.existsSync(overviewTarget)) {
      try {
        const overview = await generateTimelineOverview({
          projectDir,
          timelinePath,
          sourceMap,
        });
        overviewPath = overview.outputPath;
      } catch (err) {
        gapReport.push(
          `timeline-overview.png generation failed (degraded): ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    } else {
      overviewPath = overviewTarget;
    }

    // 2. Render preview-first30s.mp4 at 720p
    const previewTarget = path.join(projectDir, "05_timeline/preview-first30s.mp4");
    try {
      const previewResult = await renderPreviewSegment({
        projectDir,
        timelinePath,
        sourceMap,
        firstNSec: 30,
        outputPath: previewTarget,
      });
      previewPath = previewResult.outputPath;
      steps.push({
        step: "preview",
        status: "completed",
        detail: `Rendered preview-first30s.mp4 (${previewResult.clipCount} clips, ${previewResult.durationSec.toFixed(1)}s).`,
        artifactPath: previewResult.outputPath,
      });
    } catch (err) {
      gapReport.push(
        `preview render failed (degraded review): ${err instanceof Error ? err.message : String(err)}`,
      );
      steps.push({
        step: "preview",
        status: "skipped",
        detail: `Preview render failed (degraded): ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  } else {
    gapReport.push("preview generation skipped via --skip-preview");
    steps.push({
      step: "preview",
      status: "skipped",
      detail: "Preview generation skipped via --skip-preview.",
    });
  }

  // QC validation
  const qcValidation = validateAgainstSchema(timelineJson, "timeline-ir.schema.json");
  const qcSummaryPath = path.join(projectDir, "05_timeline/review-qc-summary.json");
  fs.writeFileSync(
    qcSummaryPath,
    JSON.stringify({
      version: "1",
      created_at: createdAt,
      timeline_path: "05_timeline/timeline.json",
      preview_path: previewPath ? path.relative(projectDir, previewPath) : null,
      overview_path: overviewPath ? path.relative(projectDir, overviewPath) : null,
      schema_valid: qcValidation.valid,
      errors: qcValidation.errors,
      gap_report: gapReport,
    }, null, 2),
    "utf-8",
  );
  if (!qcValidation.valid) {
    throw new Error(`QC schema validation failed: ${qcValidation.errors.join("; ")}`);
  }
  steps.push({
    step: "qc",
    status: "completed",
    detail: "QC completed via schema validation and summary emission.",
    artifactPath: qcSummaryPath,
  });

  return {
    steps,
    gapReport,
    previewPath,
    overviewPath,
    qcSummaryPath,
  };
}

function buildCompileResultFromExistingTimeline(
  projectDir: string,
  timelineJson: unknown,
): CompileResult {
  const timeline = timelineJson as CompileResult["timeline"];
  return {
    timeline,
    outputPath: path.join(projectDir, "05_timeline/timeline.json"),
    otioPath: path.join(projectDir, "05_timeline/timeline.otio"),
    previewManifestPath: path.join(projectDir, "05_timeline/preview-manifest.json"),
    resolution: {
      resolved_overlaps: 0,
      resolved_duplicates: 0,
      resolved_invalid_ranges: 0,
      duration_fit: true,
      total_frames: 0,
      target_frames: 0,
    },
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
    const raw = fs.readFileSync(notesPath, "utf-8");
    parsed = parseYaml(raw);
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

  // Snapshot current artifact versions
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
