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
import { writeProjectState, snapshotArtifacts, computeFileHash, ARTIFACT_IDENTITY_HASH_KEYS, type ArtifactHashes } from "../state/reconcile.js";
import type { CompileResult, ReviewPatch } from "../compiler/index.js";
import { runCanonicalCompile } from "../compiler/index.js";
import type { ReviewReport } from "../commands/review/index.js";
import type { EditBlueprint } from "../compiler/types.js";
import { draftAndPromote, type DraftFile } from "../commands/shared.js";
import {
  CANONICAL_REVIEW_REPORT_VERSION,
  enforceCanonicalReviewReportGate,
  enforceReviewJudgmentIntegrity,
} from "../commands/review/index.js";

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

function isContainedPath(parentPath: string, childPath: string): boolean {
  const relative = path.relative(parentPath, childPath);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function copyStagedFile(
  projectRoot: string,
  stageRoot: string,
  relativePath: string,
  options: { allowMissing?: boolean } = {},
): void {
  const sourcePath = path.resolve(projectRoot, relativePath);
  if (!isContainedPath(projectRoot, sourcePath)) {
    throw new Error(`Reentry compile input escapes the project: ${relativePath}`);
  }
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(sourcePath);
  } catch {
    if (options.allowMissing) return;
    throw new Error(`Reentry compile input is missing: ${relativePath}`);
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`Reentry compile input is not a regular file: ${relativePath}`);
  }
  const realSource = fs.realpathSync(sourcePath);
  if (!isContainedPath(projectRoot, realSource)) {
    throw new Error(`Reentry compile input resolves outside the project: ${relativePath}`);
  }
  const destinationPath = path.join(stageRoot, relativePath);
  fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
  fs.copyFileSync(realSource, destinationPath);
}

interface StagedBgmSource {
  /** The source selected by the canonical loader, if it needed relocation. */
  mediaPathOverride?: string;
}

function copyReferencedBgmMedia(
  projectRoot: string,
  stageRoot: string,
  analysisRelativePath: string,
  origin: "primary" | "legacy",
): StagedBgmSource | undefined {
  const stagedAnalysisPath = path.join(stageRoot, analysisRelativePath);
  if (!fs.existsSync(stagedAnalysisPath)) return undefined;
  let analysis: Record<string, unknown>;
  try {
    analysis = JSON.parse(fs.readFileSync(stagedAnalysisPath, "utf8")) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  if (analysis.analysis_status !== "ready") return undefined;
  const musicAsset = analysis.music_asset;
  if (!musicAsset || typeof musicAsset !== "object" || Array.isArray(musicAsset)) return {};
  const declaredPath = (musicAsset as Record<string, unknown>).path;
  if (typeof declaredPath !== "string" || declaredPath.length === 0) return {};
  const sourcePath = path.isAbsolute(declaredPath)
    ? declaredPath
    : path.resolve(projectRoot, declaredPath);
  let realSource: string;
  try {
    realSource = fs.realpathSync(sourcePath);
    if (!fs.statSync(realSource).isFile()) return {};
  } catch {
    return {};
  }
  const projectReal = fs.realpathSync(projectRoot);
  const sourceInsideProject = isContainedPath(projectReal, realSource);
  const declaredRelative = path.isAbsolute(declaredPath)
    ? ""
    : path.relative(projectRoot, sourcePath).split(path.sep).join("/");
  if (sourceInsideProject && declaredRelative && !declaredRelative.split("/").includes("..")) {
    copyStagedFile(projectRoot, stageRoot, declaredRelative);
    return {};
  }
  const sourceIdentity = crypto.createHash("sha256")
    .update(`${realSource}\0${String((musicAsset as Record<string, unknown>).source_hash ?? "")}`)
    .digest("hex");
  const safeBasename = path.basename(realSource).replace(/[^A-Za-z0-9._-]/g, "_");
  const destinationRelative = path.join(
    "02_media",
    ".reentry-sources",
    `${origin}-${sourceIdentity}-${safeBasename}`,
  );
  const destinationPath = path.join(stageRoot, destinationRelative);
  fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
  fs.copyFileSync(realSource, destinationPath);
  return { mediaPathOverride: destinationPath };
}

function copyStagedAnalysisInputs(projectDir: string, stageRoot: string): string | undefined {
  const projectRoot = fs.realpathSync(path.resolve(projectDir));
  const requiredFiles = [
    "project_state.yaml",
    "01_intent/creative_brief.yaml",
    "04_plan/selects_candidates.yaml",
    "04_plan/edit_blueprint.yaml",
    "02_media/source_map.json",
    "03_analysis/assets.json",
    "03_analysis/segments.json",
    "03_analysis/bgm_analysis.json",
    "03_analysis/marlin_events.json",
    "07_package/audio/bgm-analysis.json",
  ];
  for (const relativePath of requiredFiles) {
    copyStagedFile(projectRoot, stageRoot, relativePath, { allowMissing: true });
  }

  const analysisDefaults = path.join(repoRootForReentry(), "runtime/analysis-defaults.yaml");
  fs.mkdirSync(path.join(stageRoot, "runtime"), { recursive: true });
  fs.copyFileSync(analysisDefaults, path.join(stageRoot, "runtime/analysis-defaults.yaml"));

  const transcriptsDir = path.join(projectRoot, "03_analysis/transcripts");
  if (fs.existsSync(transcriptsDir)) {
    const transcriptEntries = fs.readdirSync(transcriptsDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => `03_analysis/transcripts/${entry.name}`);
    for (const relativePath of transcriptEntries) {
      copyStagedFile(projectRoot, stageRoot, relativePath);
    }
  }

  const assetsPath = path.join(projectRoot, "03_analysis/assets.json");
  if (fs.existsSync(assetsPath)) {
    try {
      const assets = JSON.parse(fs.readFileSync(assetsPath, "utf8")) as { items?: unknown[] };
      for (const item of assets.items ?? []) {
        if (!item || typeof item !== "object" || Array.isArray(item)) continue;
        const still = (item as Record<string, unknown>).still_image;
        if (!still || typeof still !== "object" || Array.isArray(still)) continue;
        const framePath = (still as Record<string, unknown>).normalized_frame_path;
        if (typeof framePath !== "string" || framePath.length === 0 || path.isAbsolute(framePath)) continue;
        copyStagedFile(projectRoot, stageRoot, path.join("03_analysis", framePath));
      }
    } catch {
      // The canonical compiler owns malformed-artifact handling; retain the
      // malformed bytes in the stage so direct and reentry routes fail alike.
    }
  }

  const primaryBgmSource = copyReferencedBgmMedia(
    projectRoot,
    stageRoot,
    "03_analysis/bgm_analysis.json",
    "primary",
  );
  const legacyBgmSource = copyReferencedBgmMedia(
    projectRoot,
    stageRoot,
    "07_package/audio/bgm-analysis.json",
    "legacy",
  );
  return (primaryBgmSource ?? legacyBgmSource)?.mediaPathOverride;
}

interface StagedProjectForCompile {
  projectPath: string;
  bgmMediaPathOverride?: string;
}

function stageProjectForCompile(projectDir: string): StagedProjectForCompile {
  const stageRoot = fs.mkdtempSync(path.join(os.tmpdir(), "video-os-reentry-"));
  try {
    const bgmMediaPathOverride = copyStagedAnalysisInputs(projectDir, stageRoot);
    return { projectPath: stageRoot, bgmMediaPathOverride };
  } catch (error) {
    fs.rmSync(stageRoot, { recursive: true, force: true });
    throw error;
  }
}

function buildProposalDrafts(
  criticProposal: CriticProposal | null,
  blueprintProposal: BlueprintProposal | null,
  reviewReportDraft: DraftFile | null,
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
    if (reviewReportDraft) {
      drafts.push(reviewReportDraft);
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

/**
 * Artifacts the reentry loop itself legitimately regenerates via the compile
 * pipeline. Only these may adopt post-compile bytes as evidence identity —
 * and only after their pre-transform authority was verified against the
 * recorded project identity.
 */
/**
 * Issue #32 M0 supplemental HOLD fix: anchor every tracked canonical evidence
 * artifact to the state document's recorded artifact_hashes. Current foreign
 * bytes are never snapshotted or adopted as new truth — a tracked artifact
 * whose bytes do not match the recorded identity throws (fail closed).
 *
 * The reentry compile writes to a staged project copy; it does not produce
 * the canonical timeline.json. Timeline evidence therefore stays bound to the
 * original recorded canonical hash until the exact compiler-produced bytes
 * are promoted through their own transaction. This closes the ABA window: a
 * foreign timeline swap during the compile window fails the post-compile
 * verification even if the attacker restores the original bytes afterwards,
 * because nothing from the foreign window was ever validated or promoted.
 */
export function resolveReentryEvidenceIdentity(
  projectDir: string,
  doc: ProjectStateDoc,
): ArtifactHashes {
  const recorded = doc.artifact_hashes ?? {};
  const identity: ArtifactHashes = { ...recorded };

  for (const [relPath, hashKey] of Object.entries(ARTIFACT_IDENTITY_HASH_KEYS)) {
    const absPath = path.join(projectDir, relPath);
    if (!fs.existsSync(absPath)) continue;
    const current = computeFileHash(absPath);
    const recordedHash = recorded[hashKey];
    if (recordedHash && current !== recordedHash) {
      throw new Error(
        `Refusing to promote canonical review report: tracked artifact ${relPath} does not match the recorded project identity (foreign or stale bytes); current bytes are never adopted as truth`,
      );
    }
    if (recordedHash) {
      identity[hashKey] = recordedHash;
    }
    // No recorded identity: leave the key unset so evidence on this artifact
    // can only ever be contextual, never measured.
  }

  return identity;
}

/**
 * Derive the authoritative identity a canonical (version 2) review report must
 * carry: the project id from project state and the current timeline version
 * from the canonical timeline artifact. Undefined when either is missing —
 * v2 promotion then fails closed.
 */
function canonicalReviewReportIdentity(
  projectDir: string,
  doc: ProjectStateDoc,
): { project_id: string; timeline_version: string } | undefined {
  const projectId = typeof doc.project_id === "string" ? doc.project_id : "";
  let timelineVersion = "";
  const timelinePath = path.join(projectDir, "05_timeline/timeline.json");
  if (fs.existsSync(timelinePath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(timelinePath, "utf-8")) as { version?: unknown };
      if (typeof parsed.version === "string" || typeof parsed.version === "number") {
        timelineVersion = String(parsed.version);
      }
    } catch {
      // Fail closed via undefined identity.
    }
  }
  if (!projectId || !timelineVersion) return undefined;
  return { project_id: projectId, timeline_version: timelineVersion };
}

/**
 * Issue #32 M0 identity + truth-contract gate for the reentry promotion
 * route — the same canonical contract runReview enforces. A canonical
 * (version 2) review report may only enter canonical state when it passes the
 * shared acceptance gate (schema, canonical version, non-empty judgment
 * envelope, exact project/timeline identity) and then the shared
 * enforceReviewJudgmentIntegrity normalization against a fresh current
 * artifact snapshot. Report-supplied visual QA is stripped by the shared gate
 * and never trusted. Version 2 with foreign identity or invalid structure
 * throws (fail closed, no canonical mutation); legacy version 1 reports are
 * non-promotable and are skipped.
 */
function gateReviewReportDraft(
  projectDir: string,
  doc: ProjectStateDoc,
  reviewReport: unknown,
  evidenceIdentity: ArtifactHashes,
): DraftFile | null {
  const version = reviewReport && typeof reviewReport === "object" && !Array.isArray(reviewReport)
    ? (reviewReport as Record<string, unknown>).version
    : undefined;
  if (version !== CANONICAL_REVIEW_REPORT_VERSION) {
    // Legacy (v1) and unknown versions are non-promotable through reentry.
    return null;
  }
  const identity = canonicalReviewReportIdentity(projectDir, doc);
  if (!identity) {
    throw new Error("Refusing to promote canonical review report: authoritative project or timeline identity is missing.");
  }
  let report: ReviewReport;
  try {
    report = enforceCanonicalReviewReportGate(reviewReport, identity);
  } catch (error) {
    throw new Error(
      `Refusing to promote canonical review report: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  // Anchored evidence identity: untouched tracked artifacts are bound to the
  // recorded project identity (re-verified here), and only the explicitly
  // regenerated timeline adopts post-compile bytes. Report-supplied visual QA
  // was already stripped by the shared gate.
  enforceReviewJudgmentIntegrity(report, projectDir, evidenceIdentity);
  return {
    relativePath: "06_review/review_report.yaml",
    schemaFile: "review-report.schema.json",
    content: report,
    format: "yaml",
    serializedContentGate: (parsed) => {
      enforceCanonicalReviewReportGate(parsed, identity);
    },
  };
}

async function compileProposalArtifacts(
  projectDir: string,
  createdAt: string,
  criticProposal: CriticProposal | null,
  blueprintProposal: BlueprintProposal | null,
): Promise<CompileResult> {
  const stagedProject = stageProjectForCompile(projectDir);
  try {
    return await runCanonicalCompile({
      projectPath: stagedProject.projectPath,
      createdAt,
      repoRoot: repoRootForReentry(),
      bgmMediaPathOverride: stagedProject.bgmMediaPathOverride,
      blueprintOverride: blueprintProposal?.editBlueprint,
      reviewPatch: criticProposal?.reviewPatch,
    });
  } finally {
    fs.rmSync(stagedProject.projectPath, { recursive: true, force: true });
  }
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

  // Pre-transform authority: anchor every tracked canonical artifact to the
  // recorded project identity BEFORE the recompile runs. Foreign or stale
  // bytes on any tracked input fail closed here and are never adopted.
  resolveReentryEvidenceIdentity(projectDir, doc);
  // Guard baseline for the promotion transaction (taken pre-compile; the
  // compile itself writes only into the staged copy).
  const promoteGuardHashes = snapshotArtifacts(projectDir).hashes;

  const compileResult = await compileProposalArtifacts(
    projectDir,
    createdAt ?? new Date().toISOString(),
    criticProposal,
    blueprintProposal,
  );

  // Post-compile evidence identity: the reentry compile writes to a staged
  // copy and does not produce the canonical timeline, so NO artifact adopts
  // current bytes. Every tracked input — including timeline.json — stays
  // anchored to the recorded identity and is re-verified here, which closes
  // the ABA window: a foreign timeline swap during the compile window fails
  // closed even if the original bytes are restored afterwards.
  const evidenceIdentity = resolveReentryEvidenceIdentity(projectDir, doc);

  const reviewReportDraft = criticProposal?.reviewReport !== undefined
    ? gateReviewReportDraft(projectDir, doc, criticProposal.reviewReport, evidenceIdentity)
    : null;
  const drafts = buildProposalDrafts(criticProposal, blueprintProposal, reviewReportDraft);
  // Transactional promotion guard: the reentry door passes the same guard as
  // runReview — precondition/under-lock/postcondition hash verification with
  // rollback inside draftAndPromote.
  const promoteResult = draftAndPromote(projectDir, drafts, {
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
