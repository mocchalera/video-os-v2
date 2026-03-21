/**
 * M3.5 Phase 4: M3 Re-entry Bridge
 *
 * Converts human_revision_diff into input for existing M3 agents and commands:
 * - roughcut-critic: trim / reorder / timeline_marker_add → review_patch proposal
 * - blueprint-planner: track_move / transition / structural changes → blueprint revision
 *
 * Does NOT auto-mutate canonical artifacts. Produces evidence for M3 loop re-entry.
 *
 * State contract:
 * - /handoff-import completion → no canonical mutation, approval_record unchanged
 * - diff → new review_patch → approval_record stale, state → critique_ready
 * - diff → blueprint revision → approval_record stale, state → blueprint_ready or blocked
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import * as os from "node:os";
import { fileURLToPath } from "node:url";
import { stringify as stringifyYaml, parse as parseYaml } from "yaml";
import type {
  HumanRevisionDiff,
  DiffOperation,
  UnmappedEdit,
} from "./diff.js";
import { validateHumanRevisionDiff as validateDiffSchema } from "./diff.js";
import type {
  ProjectStateDoc,
  ProjectState,
} from "../state/reconcile.js";
import { writeProjectState } from "../state/reconcile.js";
import type { CompileResult, ReviewPatch } from "../compiler/index.js";
import { compile } from "../compiler/index.js";
import type { EditBlueprint } from "../compiler/types.js";
import { draftAndPromote, type DraftFile } from "../commands/shared.js";

// ── Types ──────────────────────────────────────────────────────────

/**
 * Consumer classification for diff operations.
 * - roughcut_critic: ops that map directly to M3 patch contract
 * - blueprint_planner: ops that require structural/policy revision
 * - report_only: ops that stay in the diff for human review only
 */
export type DiffConsumer = "roughcut_critic" | "blueprint_planner" | "report_only";

export interface ClassifiedDiffOp {
  operation: DiffOperation;
  consumer: DiffConsumer;
}

export interface ClassifiedUnmapped {
  unmapped: UnmappedEdit;
  consumer: DiffConsumer;
}

/**
 * Evidence package for roughcut-critic re-entry.
 * Contains diff operations that can be expressed as M3 patch operations.
 */
export interface CriticReentryEvidence {
  consumer: "roughcut_critic";
  handoff_id: string;
  base_timeline_version: string;
  /** Diff operations that the critic can convert to patch ops */
  operations: DiffOperation[];
  /** Summary text for the agent context */
  context_summary: string;
}

/**
 * Evidence package for blueprint-planner re-entry.
 * Contains structural changes that need blueprint revision.
 */
export interface BlueprintReentryEvidence {
  consumer: "blueprint_planner";
  handoff_id: string;
  base_timeline_version: string;
  /** Structural operations requiring blueprint revision */
  operations: DiffOperation[];
  /** Unmapped edits requiring structural attention */
  unmapped_edits: UnmappedEdit[];
  /** Summary text for the agent context */
  context_summary: string;
}

export interface ReentryResult {
  criticEvidence: CriticReentryEvidence | null;
  blueprintEvidence: BlueprintReentryEvidence | null;
  /** Classified breakdown of all diff items */
  classification: {
    ops: ClassifiedDiffOp[];
    unmapped: ClassifiedUnmapped[];
  };
}

export interface RecompileInput {
  projectDir: string;
  diff: HumanRevisionDiff;
  createdAt?: string;
}

export interface RecompileResult {
  reentry: ReentryResult;
  compileResult?: CompileResult;
  approvalInvalidated: boolean;
  promotedArtifacts?: string[];
  stateTransition?: {
    from: ProjectState;
    to: ProjectState;
    reason: string;
  };
}

export interface CriticProposal {
  reviewPatch: ReviewPatch;
  reviewReport?: unknown;
}

export interface BlueprintProposal {
  editBlueprint: EditBlueprint;
  uncertaintyRegister?: unknown;
}

/**
 * Injectable agent interface for re-entry.
 * Mock this in tests.
 */
export interface ReentryAgent {
  applyCriticEvidence?(evidence: CriticReentryEvidence): Promise<CriticProposal | null>;
  applyBlueprintEvidence?(evidence: BlueprintReentryEvidence): Promise<BlueprintProposal | null>;
}

// ── Consumer Classification ────────────────────────────────────────

/**
 * Classify which consumer should handle each diff operation.
 *
 * From design doc § Downstream Consumption Rule:
 * - roughcut-critic: trim, reorder, timeline_marker_add
 * - blueprint-planner: track_move, simple_transition, enable_disable (intent re-expression)
 */
export function classifyOperation(op: DiffOperation): DiffConsumer {
  switch (op.type) {
    case "trim":
    case "reorder":
    case "timeline_marker_add":
      return "roughcut_critic";
    case "track_move":
    case "simple_transition":
      return "blueprint_planner";
    case "enable_disable":
      // enable_disable requires intent re-expression → blueprint revision
      return "blueprint_planner";
    default:
      return "report_only";
  }
}

/**
 * Classify which consumer should handle each unmapped edit.
 *
 * All unmapped edits go to blueprint-planner or report-only.
 * Split/duplicate/structural items need blueprint revision.
 * Lossy/vendor items are report-only.
 */
export function classifyUnmapped(unmapped: UnmappedEdit): DiffConsumer {
  switch (unmapped.classification) {
    case "split_clip":
    case "duplicated_clip":
    case "ambiguous_one_to_many":
    case "track_reorder":
    case "deleted_clip_without_disable":
      return "blueprint_planner";
    case "plugin_effect":
    case "color_finish":
    case "advanced_audio_finish":
    case "complex_title":
    case "speed_change":
    case "nested_sequence":
    case "clip_marker_add":
    case "note_text_add":
    case "missing_stable_id":
    case "ambiguous_mapping":
    case "unknown_vendor_extension":
      return "report_only";
    default:
      return "report_only";
  }
}

// ── Re-entry Evidence Building ─────────────────────────────────────

/**
 * Build re-entry evidence packages from a human revision diff.
 * Does NOT mutate any canonical artifacts.
 */
export function buildReentryEvidence(diff: HumanRevisionDiff): ReentryResult {
  const classifiedOps: ClassifiedDiffOp[] = [];
  const classifiedUnmapped: ClassifiedUnmapped[] = [];

  // Classify operations
  for (const op of diff.operations ?? []) {
    classifiedOps.push({
      operation: op,
      consumer: classifyOperation(op),
    });
  }

  // Classify unmapped edits
  for (const unmapped of diff.unmapped_edits ?? []) {
    classifiedUnmapped.push({
      unmapped,
      consumer: classifyUnmapped(unmapped),
    });
  }

  // Build critic evidence
  const criticOps = classifiedOps
    .filter((c) => c.consumer === "roughcut_critic")
    .map((c) => c.operation);

  let criticEvidence: CriticReentryEvidence | null = null;
  if (criticOps.length > 0) {
    criticEvidence = {
      consumer: "roughcut_critic",
      handoff_id: diff.handoff_id,
      base_timeline_version: diff.base_timeline_version,
      operations: criticOps,
      context_summary: buildCriticSummary(criticOps),
    };
  }

  // Build blueprint evidence
  const blueprintOps = classifiedOps
    .filter((c) => c.consumer === "blueprint_planner")
    .map((c) => c.operation);
  const blueprintUnmapped = classifiedUnmapped
    .filter((c) => c.consumer === "blueprint_planner")
    .map((c) => c.unmapped);

  let blueprintEvidence: BlueprintReentryEvidence | null = null;
  if (blueprintOps.length > 0 || blueprintUnmapped.length > 0) {
    blueprintEvidence = {
      consumer: "blueprint_planner",
      handoff_id: diff.handoff_id,
      base_timeline_version: diff.base_timeline_version,
      operations: blueprintOps,
      unmapped_edits: blueprintUnmapped,
      context_summary: buildBlueprintSummary(blueprintOps, blueprintUnmapped),
    };
  }

  return {
    criticEvidence,
    blueprintEvidence,
    classification: {
      ops: classifiedOps,
      unmapped: classifiedUnmapped,
    },
  };
}

// ── Approval Invalidation ──────────────────────────────────────────

/**
 * Invalidate the approval_record in project_state.yaml.
 *
 * Per design doc state contract:
 * - When diff-driven artifacts are produced, approval_record → stale
 */
export function invalidateApproval(
  projectDir: string,
  doc: ProjectStateDoc,
  _handoffId: string,
  reason: string,
): ProjectStateDoc {
  if (doc.approval_record) {
    doc.approval_record.status = "stale";
  }

  if (!doc.history) doc.history = [];
  doc.history.push({
    from_state: doc.current_state,
    to_state: doc.current_state,
    trigger: "/handoff-reentry",
    actor: "diff-analyzer",
    timestamp: new Date().toISOString(),
    note: reason,
  });

  writeProjectState(projectDir, doc);
  return doc;
}

/**
 * Update the handoff_resolution with diff hash.
 */
export function updateHandoffResolution(
  doc: ProjectStateDoc,
  handoffId: string,
  diffHash: string,
): ProjectStateDoc {
  if (!doc.handoff_resolution || doc.handoff_resolution.handoff_id !== handoffId) {
    doc.handoff_resolution = {
      handoff_id: handoffId,
      status: "pending",
    };
  }

  if (!doc.handoff_resolution.basis_report_hashes) {
    doc.handoff_resolution.basis_report_hashes = {};
  }
  doc.handoff_resolution.basis_report_hashes.human_revision_diff = diffHash;

  return doc;
}

/**
 * Compute SHA-256 hash of a string (first 16 hex chars).
 */
export function computeHash(content: string): string {
  return crypto.createHash("sha256").update(content).digest("hex").slice(0, 16);
}

function repoRootForReentry(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
}

function stageProjectForCompile(projectDir: string): string {
  const stageRoot = fs.mkdtempSync(path.join(os.tmpdir(), "video-os-reentry-"));
  const filesToCopy = [
    "01_intent/creative_brief.yaml",
    "04_plan/selects_candidates.yaml",
    "04_plan/edit_blueprint.yaml",
  ];

  for (const relativePath of filesToCopy) {
    const sourcePath = path.join(projectDir, relativePath);
    if (!fs.existsSync(sourcePath)) continue;
    const destinationPath = path.join(stageRoot, relativePath);
    fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
    fs.copyFileSync(sourcePath, destinationPath);
  }

  return stageRoot;
}

function buildProposalDrafts(
  criticProposal: CriticProposal | null,
  blueprintProposal: BlueprintProposal | null,
): DraftFile[] {
  const drafts: DraftFile[] = [];

  if (blueprintProposal) {
    drafts.push({
      relativePath: "04_plan/edit_blueprint.yaml",
      schemaFile: "edit-blueprint.schema.json",
      content: blueprintProposal.editBlueprint,
      format: "yaml",
    });

    if (blueprintProposal.uncertaintyRegister !== undefined) {
      drafts.push({
        relativePath: "04_plan/uncertainty_register.yaml",
        schemaFile: "uncertainty-register.schema.json",
        content: blueprintProposal.uncertaintyRegister,
        format: "yaml",
      });
    }
  }

  if (criticProposal) {
    if (criticProposal.reviewReport !== undefined) {
      drafts.push({
        relativePath: "06_review/review_report.yaml",
        schemaFile: "review-report.schema.json",
        content: criticProposal.reviewReport,
        format: "yaml",
      });
    }

    drafts.push({
      relativePath: "06_review/review_patch.json",
      schemaFile: "review-patch.schema.json",
      content: criticProposal.reviewPatch,
      format: "json",
    });
  }

  return drafts;
}

function compileProposalArtifacts(
  projectDir: string,
  createdAt: string,
  criticProposal: CriticProposal | null,
  blueprintProposal: BlueprintProposal | null,
): CompileResult {
  const stagedProjectDir = stageProjectForCompile(projectDir);
  return compile({
    projectPath: stagedProjectDir,
    createdAt,
    repoRoot: repoRootForReentry(),
    blueprintOverride: blueprintProposal?.editBlueprint,
    reviewPatch: criticProposal?.reviewPatch,
  });
}

// ── Recompile Trigger ──────────────────────────────────────────────

/**
 * Execute the recompile loop:
 * 1. Build re-entry evidence from diff
 * 2. Optionally call agent (if provided)
 * 3. Trigger compiler re-execution
 * 4. Invalidate approval_record
 * 5. Update project state
 *
 * Agent calls are injectable/mockable.
 */
export async function executeRecompileLoop(
  input: RecompileInput,
  agent?: ReentryAgent,
): Promise<RecompileResult> {
  const { projectDir, diff, createdAt } = input;
  validateDiffSchema(diff);

  const reentry = buildReentryEvidence(diff);

  const stateFile = path.join(projectDir, "project_state.yaml");
  let doc: ProjectStateDoc | null = null;
  if (fs.existsSync(stateFile)) {
    doc = parseYaml(fs.readFileSync(stateFile, "utf-8")) as ProjectStateDoc;
  }

  if (!doc) {
    return {
      reentry,
      approvalInvalidated: false,
    };
  }

  const previousState = doc.current_state;
  let approvalInvalidated = false;
  const diffYaml = stringifyYaml(diff);
  const diffHash = computeHash(diffYaml);
  updateHandoffResolution(doc, diff.handoff_id, diffHash);

  const criticProposal = agent?.applyCriticEvidence && reentry.criticEvidence
    ? await agent.applyCriticEvidence(reentry.criticEvidence)
    : null;
  const blueprintProposal = agent?.applyBlueprintEvidence && reentry.blueprintEvidence
    ? await agent.applyBlueprintEvidence(reentry.blueprintEvidence)
    : null;

  const hasProposal = criticProposal !== null || blueprintProposal !== null;
  if (!hasProposal) {
    writeProjectState(projectDir, doc);
    return {
      reentry,
      approvalInvalidated: false,
    };
  }

  const compileResult = compileProposalArtifacts(
    projectDir,
    createdAt ?? new Date().toISOString(),
    criticProposal,
    blueprintProposal,
  );

  const drafts = buildProposalDrafts(criticProposal, blueprintProposal);
  const promoteResult = draftAndPromote(projectDir, drafts);
  if (!promoteResult.success) {
    writeProjectState(projectDir, doc);
    throw new Error(`Failed to promote re-entry proposal artifacts: ${promoteResult.errors.join("; ")}`);
  }

  if (doc.approval_record) {
    invalidateApproval(
      projectDir,
      doc,
      diff.handoff_id,
      `Handoff diff produced proposal artifacts: ${buildActionSummary(reentry)}`,
    );
    approvalInvalidated = true;
  }

  let newState: ProjectState = previousState;
  let transitionReason = "";

  if (blueprintProposal) {
    newState = "blueprint_ready";
    transitionReason = "Handoff diff requires blueprint revision for structural changes";
  } else if (criticProposal) {
    newState = "critique_ready";
    transitionReason = "Handoff diff contains critic-actionable edits (trim/reorder/marker)";
  }

  if (newState !== previousState) {
    doc.current_state = newState;
    if (!doc.history) doc.history = [];
    doc.history.push({
      from_state: previousState,
      to_state: newState,
      trigger: "/handoff-reentry",
      actor: "diff-analyzer",
      timestamp: new Date().toISOString(),
      note: transitionReason,
    });
    writeProjectState(projectDir, doc);
  } else if (!approvalInvalidated) {
    writeProjectState(projectDir, doc);
  }

  return {
    reentry,
    compileResult,
    approvalInvalidated,
    promotedArtifacts: promoteResult.promoted,
    stateTransition:
      newState !== previousState
        ? { from: previousState, to: newState, reason: transitionReason }
        : undefined,
  };
}

// ── Summary Builders ───────────────────────────────────────────────

function buildCriticSummary(ops: DiffOperation[]): string {
  const counts = new Map<string, number>();
  for (const op of ops) {
    counts.set(op.type, (counts.get(op.type) ?? 0) + 1);
  }
  const parts: string[] = [];
  for (const [type, count] of counts) {
    parts.push(`${count} ${type}`);
  }
  return `Human NLE edits for critic review: ${parts.join(", ")}`;
}

function buildBlueprintSummary(
  ops: DiffOperation[],
  unmapped: UnmappedEdit[],
): string {
  const parts: string[] = [];
  if (ops.length > 0) {
    const counts = new Map<string, number>();
    for (const op of ops) {
      counts.set(op.type, (counts.get(op.type) ?? 0) + 1);
    }
    for (const [type, count] of counts) {
      parts.push(`${count} ${type}`);
    }
  }
  if (unmapped.length > 0) {
    const counts = new Map<string, number>();
    for (const u of unmapped) {
      counts.set(u.classification, (counts.get(u.classification) ?? 0) + 1);
    }
    for (const [cls, count] of counts) {
      parts.push(`${count} ${cls}`);
    }
  }
  return `Structural changes requiring blueprint revision: ${parts.join(", ")}`;
}

function buildActionSummary(reentry: ReentryResult): string {
  const parts: string[] = [];
  if (reentry.criticEvidence) {
    parts.push(`critic: ${reentry.criticEvidence.operations.length} ops`);
  }
  if (reentry.blueprintEvidence) {
    const opCount = reentry.blueprintEvidence.operations.length;
    const unmappedCount = reentry.blueprintEvidence.unmapped_edits.length;
    parts.push(`blueprint: ${opCount} ops, ${unmappedCount} unmapped`);
  }
  return parts.join("; ");
}
