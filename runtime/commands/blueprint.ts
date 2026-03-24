/**
 * /blueprint Command
 *
 * Wraps blueprint-planner agent to produce:
 * - 04_plan/edit_blueprint.yaml
 * - 04_plan/uncertainty_register.yaml
 *
 * Narrative loop (design doc §8.1):
 * 1. frame — message frame + quality targets
 * 2. read — material reading review
 * 3. draft — beat assignment + delivery order
 * 4. evaluate — deterministic gate + continuity + advisory
 * 5. reject? — if gate fails, revision brief → re-draft (max 3)
 * 6. confirm — collaborative mode human confirmation
 * 7. promote — accepted artifacts to canonical
 *
 * LLM agent is injectable for testability.
 * When iterativeEngine is disabled, falls back to single-pass agent.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import {
  initCommand,
  isCommandError,
  draftAndPromote,
  transitionState,
  type CommandError,
  type DraftFile,
} from "./shared.js";
import { ProgressTracker } from "../progress.js";
import type { ProjectState, GateStatus } from "../state/reconcile.js";
import { buildMessageFrame, type FrameInput } from "../script/frame.js";
import { buildMaterialReading, type ReadInput } from "../script/read.js";
import { buildScriptDraft, type DraftInput } from "../script/draft.js";
import { evaluateScript, type EvaluateInput } from "../script/evaluate.js";
import type {
  Candidate,
  NormalizedBeat,
  EditBlueprint,
  Beat,
  ConfirmedPreferences,
  QualityTargets,
} from "../artifacts/types.js";
import { inferAutonomyMode } from "../autonomy.js";

// Re-export artifact types used by consumers of this module
export type { EditBlueprint, Beat, ConfirmedPreferences };

export interface Uncertainty {
  id: string;
  type: "message" | "structure" | "coverage" | "pacing" | "audio" | "music" | "ending" | "brand" | "continuity" | "technical" | "legal" | "other";
  question: string;
  status: "open" | "monitoring" | "resolved" | "waived" | "blocker";
  evidence: string[];
  alternatives: Array<{ label: string; description: string; impact?: string }>;
  escalation_required: boolean;
  resolution_note?: string;
}

export interface UncertaintyRegister {
  version: string;
  project_id: string;
  created_at?: string;
  uncertainties: Uncertainty[];
}

/** The agent function signature — injectable for testing */
export interface BlueprintAgent {
  run(ctx: BlueprintAgentContext): Promise<BlueprintAgentResult>;
}

export interface BlueprintAgentContext {
  projectDir: string;
  projectId: string;
  currentState: ProjectState;
  autonomyMode: "full" | "collaborative";
  briefContent: unknown;
  blockersContent: unknown;
  selectsContent: unknown;
  styleContent: string | null;
}

export interface BlueprintAgentResult {
  blueprint: EditBlueprint;
  uncertaintyRegister: UncertaintyRegister;
  /** If false, human declined the beat proposal readback */
  confirmed: boolean;
}

// ── Narrative Loop Types ────────────────────────────────────────

/** Injectable narrative phase functions for testability */
export interface NarrativePhases {
  /** Phase A: Build message frame */
  frame(ctx: NarrativePhaseContext): Promise<FrameResult>;
  /** Phase B: Material reading review */
  read(ctx: NarrativePhaseContext, frame: FrameResult): Promise<ReadResult>;
  /** Phase C: Script draft */
  draft(ctx: NarrativePhaseContext, frame: FrameResult, reading: ReadResult, revisionBrief?: RevisionBrief): Promise<DraftResult>;
  /** Phase D: Evaluate — deterministic gate */
  evaluate(ctx: NarrativePhaseContext, frame: FrameResult, reading: ReadResult, draft: DraftResult): Promise<EvaluateResult>;
  /** Phase E: Confirm — collaborative human confirmation */
  confirm(ctx: NarrativePhaseContext, draft: DraftResult, evaluation: EvaluateResult): Promise<ConfirmResult>;
  /** Phase F: Project to canonical artifacts */
  project(ctx: NarrativePhaseContext, draft: DraftResult, evaluation: EvaluateResult): Promise<BlueprintAgentResult>;
}

export interface NarrativePhaseContext {
  projectDir: string;
  projectId: string;
  autonomyMode: "full" | "collaborative";
  briefContent: unknown;
  blockersContent: unknown;
  selectsContent: unknown;
  styleContent: string | null;
}

export interface FrameResult {
  storyPromise: string;
  hookAngle: string;
  closingIntent: string;
  beatCount: number;
  qualityTargets?: Partial<QualityTargets>;
}

export interface ReadResult {
  beatReadings: Array<{
    beatId: string;
    topCandidates: string[];
    coverageGaps: string[];
  }>;
}

export type StoryRole = "hook" | "setup" | "experience" | "closing";

export interface DraftResult {
  deliveryOrder: string[];
  beatAssignments: Array<{
    beatId: string;
    primaryCandidateRef: string;
    backupCandidateRefs: string[];
    storyRole: StoryRole;
  }>;
  draftSummary?: string;
}

export interface EvaluateResult {
  gatePassed: boolean;
  metrics: {
    hookDensity: number;
    noveltyRate: number;
  };
  warnings: string[];
  revisionBrief?: RevisionBrief;
}

export interface RevisionBrief {
  preserve: string[];
  mustFix: string[];
  brokenBeats: string[];
  preferBackups: string[];
}

export interface ConfirmResult {
  status: "confirmed" | "declined" | "skipped";
  declineReason?: string;
}

export interface LoopSummary {
  totalIterations: number;
  evaluateRejectCount: number;
  humanDeclineCount: number;
  finalStatus: "accepted" | "rejected_max_iterations" | "human_declined" | "blocked";
}

export interface BlueprintCommandResult {
  success: boolean;
  error?: CommandError;
  blueprint?: EditBlueprint;
  uncertaintyRegister?: UncertaintyRegister;
  previousState?: ProjectState;
  newState?: ProjectState;
  promoted?: string[];
  planningBlocked?: boolean;
  loopSummary?: LoopSummary;
}

export interface BlueprintCommandOptions {
  /** Enable iterative narrative engine. Default: true. */
  iterativeEngine?: boolean;
  /** Max draft→evaluate iterations. Default: 3. */
  maxIterations?: number;
  /** Require human confirmation in collaborative mode. Default: true. */
  requireConfirmationInCollaborative?: boolean;
}

// ── Command Implementation ───────────────────────────────────────

/**
 * Allowed start state: selects_ready.
 * Also re-runnable from blueprint_ready and beyond.
 */
const ALLOWED_STATES: ProjectState[] = [
  "selects_ready",
  "blueprint_ready",
  "blocked",
  "timeline_drafted",
  "critique_ready",
  "approved",
  "packaged",
];

export function validateConfirmedPreferences(
  blueprint: EditBlueprint,
  autonomyMode: "full" | "collaborative",
): string[] {
  const prefs = blueprint.pacing?.confirmed_preferences;
  if (!prefs) {
    return ["pacing.confirmed_preferences is required"];
  }

  const expectedSource = autonomyMode === "full" ? "ai_autonomous" : "human_confirmed";
  const errors: string[] = [];
  if (prefs.mode !== autonomyMode) {
    errors.push(`pacing.confirmed_preferences.mode must be "${autonomyMode}"`);
  }
  if (prefs.source !== expectedSource) {
    errors.push(`pacing.confirmed_preferences.source must be "${expectedSource}"`);
  }
  if (typeof prefs.duration_target_sec !== "number" || prefs.duration_target_sec <= 0) {
    errors.push("pacing.confirmed_preferences.duration_target_sec must be > 0");
  }
  if (typeof prefs.confirmed_at !== "string" || prefs.confirmed_at.length === 0) {
    errors.push("pacing.confirmed_preferences.confirmed_at is required");
  }
  return errors;
}

function recordAutonomousConfirmedPreferences(
  blueprint: EditBlueprint,
  briefContent: {
    project?: { runtime_target_sec?: number };
  },
): void {
  const existing = blueprint.pacing?.confirmed_preferences;
  if (!blueprint.pacing) {
    return;
  }

  blueprint.pacing.confirmed_preferences = {
    ...existing,
    mode: "full",
    source: "ai_autonomous",
    duration_target_sec: typeof existing?.duration_target_sec === "number" &&
        existing.duration_target_sec > 0
      ? existing.duration_target_sec
      : briefContent.project?.runtime_target_sec ?? 120,
    confirmed_at: typeof existing?.confirmed_at === "string" &&
        existing.confirmed_at.length > 0
      ? existing.confirmed_at
      : new Date().toISOString(),
  };
}

// ── Main entry: supports both legacy agent and iterative engine ──

export async function runBlueprint(
  projectDir: string,
  agent: BlueprintAgent,
  options?: BlueprintCommandOptions,
  phases?: NarrativePhases,
): Promise<BlueprintCommandResult> {
  const pt = new ProgressTracker(projectDir, "blueprint", 4);
  // 1. Init command (reconcile + state check)
  const ctx = initCommand(projectDir, "/blueprint", ALLOWED_STATES);
  if (isCommandError(ctx)) {
    pt.fail("init", ctx.message);
    return { success: false, error: ctx };
  }
  pt.advance();

  const { projectDir: absDir, reconcileResult, doc, preflightHashes } = ctx;
  const previousState = doc.current_state;
  const projectId = doc.project_id || "";

  // 2. Read creative_brief.yaml to determine autonomy mode
  const briefPath = path.join(absDir, "01_intent/creative_brief.yaml");
  if (!fs.existsSync(briefPath)) {
    pt.block("brief", "creative_brief.yaml not found. Run /intent first.");
    return {
      success: false,
      error: {
        code: "GATE_CHECK_FAILED",
        message: "creative_brief.yaml not found. Run /intent first.",
      },
    };
  }
  const briefRaw = fs.readFileSync(briefPath, "utf-8");
  const briefContent = parseYaml(briefRaw) as {
    autonomy?: { mode?: "full" | "collaborative"; must_ask?: string[] };
    project?: { runtime_target_sec?: number };
  };

  const autonomyMode = inferAutonomyMode(briefContent);

  const blockersPath = path.join(absDir, "01_intent/unresolved_blockers.yaml");
  if (!fs.existsSync(blockersPath)) {
    pt.block("blockers", "unresolved_blockers.yaml not found. Run /intent first.");
    return {
      success: false,
      error: {
        code: "GATE_CHECK_FAILED",
        message: "unresolved_blockers.yaml not found. Run /intent first.",
      },
    };
  }
  const blockersRaw = fs.readFileSync(blockersPath, "utf-8");
  const blockersContent = parseYaml(blockersRaw);

  // 3. Read selects_candidates.yaml
  const selectsPath = path.join(absDir, "04_plan/selects_candidates.yaml");
  if (!fs.existsSync(selectsPath)) {
    pt.block("selects", "selects_candidates.yaml not found. Run /triage first.");
    return {
      success: false,
      error: {
        code: "GATE_CHECK_FAILED",
        message: "selects_candidates.yaml not found. Run /triage first.",
      },
    };
  }
  const selectsRaw = fs.readFileSync(selectsPath, "utf-8");
  const selectsContent = parseYaml(selectsRaw);

  // 4. Read optional STYLE.md
  const stylePath = path.join(absDir, "STYLE.md");
  const styleContent = fs.existsSync(stylePath)
    ? fs.readFileSync(stylePath, "utf-8")
    : null;

  // 5. Decide path: iterative engine (default) or legacy single-pass (explicit opt-in)
  const useLegacy = options?.iterativeEngine === false;
  const effectivePhases = phases ?? (useLegacy ? undefined : buildDefaultPhases(
    absDir, projectId, selectsContent, briefContent, autonomyMode,
  ));
  const useIterative = !useLegacy && !!effectivePhases;

  let agentResult: BlueprintAgentResult;
  let loopSummary: LoopSummary | undefined;

  if (useIterative && effectivePhases) {
    // ── Iterative narrative loop ──────────────────────────────
    const maxIter = options?.maxIterations ?? 3;
    const requireConfirm = options?.requireConfirmationInCollaborative !== false;

    const phaseCtx: NarrativePhaseContext = {
      projectDir: absDir,
      projectId,
      autonomyMode,
      briefContent,
      blockersContent,
      selectsContent,
      styleContent,
    };

    const result = await runNarrativeLoop(
      phaseCtx, effectivePhases, agent, maxIter, requireConfirm,
    );

    if (!result.success) {
      // Persist script_evaluation.yaml on ALL failure paths (NOTE 1)
      const planDirFail = path.join(absDir, "04_plan");
      fs.mkdirSync(planDirFail, { recursive: true });
      if (result.evaluateResult || result.loopSummary) {
        fs.writeFileSync(
          path.join(planDirFail, "script_evaluation.yaml"),
          stringifyYaml({
            version: "1",
            project_id: projectId,
            loop_summary: result.loopSummary,
            gate_pass: result.evaluateResult?.gatePassed ?? false,
            metrics: result.evaluateResult?.metrics,
            warnings: result.evaluateResult?.warnings,
            confirmation_status: result.confirmResult?.status ?? "skipped",
            decline_reason: result.confirmResult?.declineReason,
          }),
          "utf-8",
        );
      }

      // 3x fail → blocked
      if (result.loopSummary?.finalStatus === "rejected_max_iterations") {
        const blocker: Uncertainty = {
          id: "U_LOOP_FAIL",
          type: "structure",
          question: "Blueprint narrative loop exhausted max iterations without passing quality gate",
          status: "blocker",
          evidence: result.lastWarnings ?? [],
          alternatives: [],
          escalation_required: true,
        };
        const register: UncertaintyRegister = {
          version: "1",
          project_id: projectId,
          uncertainties: [blocker],
        };

        // Write uncertainty register and transition to blocked
        const drafts: DraftFile[] = [{
          relativePath: "04_plan/uncertainty_register.yaml",
          schemaFile: "uncertainty-register.schema.json",
          content: register,
          format: "yaml",
        }];
        draftAndPromote(absDir, drafts, { preflightHashes });

        const updatedDoc = transitionState(
          absDir, doc, "blocked", "/blueprint", "blueprint-planner",
          "blueprint loop exhausted — quality gate failed after max iterations",
        );
        pt.fail("loop", `Narrative loop failed after ${maxIter} iterations`);

        return {
          success: false,
          error: {
            code: "VALIDATION_FAILED",
            message: `Narrative loop failed after ${maxIter} iterations`,
          },
          previousState,
          newState: updatedDoc.current_state,
          planningBlocked: true,
          loopSummary: result.loopSummary,
        };
      }

      // Human declined
      if (result.loopSummary?.finalStatus === "human_declined") {
        pt.fail("approval", "Human declined narrative confirmation");
        return {
          success: false,
          error: {
            code: "VALIDATION_FAILED",
            message: "Human declined narrative confirmation",
          },
          previousState,
          loopSummary: result.loopSummary,
        };
      }

      pt.fail("loop", result.errorMessage ?? "Narrative loop failed");
      return {
        success: false,
        error: {
          code: "VALIDATION_FAILED",
          message: result.errorMessage ?? "Narrative loop failed",
        },
        previousState,
        loopSummary: result.loopSummary,
      };
    }

    agentResult = result.agentResult!;
    loopSummary = result.loopSummary;

    // Write operational artifacts
    const planDir = path.join(absDir, "04_plan");
    fs.mkdirSync(planDir, { recursive: true });

    if (result.evaluateResult) {
      fs.writeFileSync(
        path.join(planDir, "script_evaluation.yaml"),
        stringifyYaml({
          version: "1",
          project_id: projectId,
          loop_summary: loopSummary,
          gate_pass: result.evaluateResult.gatePassed,
          metrics: result.evaluateResult.metrics,
          warnings: result.evaluateResult.warnings,
          confirmation_status: result.confirmResult?.status ?? "skipped",
          decline_reason: result.confirmResult?.declineReason,
        }),
        "utf-8",
      );
    }
    pt.advance("04_plan/script_evaluation.yaml");
  } else {
    // ── Legacy single-pass agent ──────────────────────────────
    agentResult = await agent.run({
      projectDir: absDir,
      projectId,
      currentState: previousState,
      autonomyMode,
      briefContent,
      blockersContent,
      selectsContent,
      styleContent,
    });
  }

  // 6. Gate 5: beat proposal readback
  if (autonomyMode === "full") {
    recordAutonomousConfirmedPreferences(agentResult.blueprint, briefContent);
    console.log("[auto:full_autonomy] /blueprint skipped beat proposal readback.");
  } else if (!agentResult.confirmed) {
    pt.fail("approval", "Human declined beat proposal readback");
    return {
      success: false,
      error: {
        code: "VALIDATION_FAILED",
        message: "Human declined beat proposal readback",
      },
      loopSummary,
    };
  }

  const confirmedPreferenceErrors = validateConfirmedPreferences(
    agentResult.blueprint,
    autonomyMode,
  );
  if (confirmedPreferenceErrors.length > 0) {
    pt.fail("validate", `Blueprint preference contract failed: ${confirmedPreferenceErrors.join("; ")}`);
    return {
      success: false,
      error: {
        code: "VALIDATION_FAILED",
        message: `Blueprint preference contract failed: ${confirmedPreferenceErrors.join("; ")}`,
        details: confirmedPreferenceErrors,
      },
      loopSummary,
    };
  }

  // 7. Draft both artifacts
  const drafts: DraftFile[] = [
    {
      relativePath: "04_plan/edit_blueprint.yaml",
      schemaFile: "edit-blueprint.schema.json",
      content: agentResult.blueprint,
      format: "yaml",
    },
    {
      relativePath: "04_plan/uncertainty_register.yaml",
      schemaFile: "uncertainty-register.schema.json",
      content: agentResult.uncertaintyRegister,
      format: "yaml",
    },
  ];

  // 8. Validate + promote (both must be valid)
  const promoteResult = draftAndPromote(absDir, drafts, {
    preflightHashes,
    guardKeys: [
      "brief_hash",
      "blockers_hash",
      "selects_hash",
      "style_hash",
      "blueprint_hash",
      "uncertainty_hash",
    ],
  });
  if (!promoteResult.success) {
    const code = promoteResult.failure_kind === "validation"
      ? "VALIDATION_FAILED"
      : "PROMOTE_FAILED";
    const message = promoteResult.failure_kind === "concurrent_edit"
      ? `Artifact promote aborted due to concurrent edits: ${promoteResult.errors.join("; ")}`
      : promoteResult.failure_kind === "promote"
        ? `Artifact promote failed: ${promoteResult.errors.join("; ")}`
        : `Artifact validation failed: ${promoteResult.errors.join("; ")}`;
    pt.fail("promote", message);
    return {
      success: false,
      error: {
        code,
        message,
        details: promoteResult.errors,
      },
      loopSummary,
    };
  }
  pt.advance("04_plan/edit_blueprint.yaml");

  // 9. Planning blocker check: if uncertainty_register has status:blocker → blocked
  const hasPlanningBlocker = agentResult.uncertaintyRegister.uncertainties.some(
    (u) => u.status === "blocker",
  );
  const hasCompileBlocker = reconcileResult.gates.compile_gate === "blocked";

  const targetState: ProjectState = hasPlanningBlocker || hasCompileBlocker
    ? "blocked"
    : "blueprint_ready";
  const note = hasPlanningBlocker || hasCompileBlocker
    ? "blueprint finalized with unresolved blockers"
    : "blueprint and uncertainty register finalized";

  // 10. State transition
  const updatedDoc = transitionState(
    absDir,
    doc,
    targetState,
    "/blueprint",
    "blueprint-planner",
    note,
  );
  pt.complete([
    "04_plan/edit_blueprint.yaml",
    "04_plan/uncertainty_register.yaml",
  ]);

  return {
    success: true,
    blueprint: agentResult.blueprint,
    uncertaintyRegister: agentResult.uncertaintyRegister,
    previousState,
    newState: updatedDoc.current_state,
    promoted: promoteResult.promoted,
    planningBlocked: hasPlanningBlocker || hasCompileBlocker,
    loopSummary,
  };
}

// ── Narrative Loop Implementation ──────────────────────────────

interface NarrativeLoopResult {
  success: boolean;
  agentResult?: BlueprintAgentResult;
  loopSummary?: LoopSummary;
  evaluateResult?: EvaluateResult;
  confirmResult?: ConfirmResult;
  lastWarnings?: string[];
  errorMessage?: string;
}

async function runNarrativeLoop(
  ctx: NarrativePhaseContext,
  phases: NarrativePhases,
  agent: BlueprintAgent,
  maxIterations: number,
  requireConfirmation: boolean,
): Promise<NarrativeLoopResult> {
  let evaluateRejectCount = 0;
  let humanDeclineCount = 0;
  let lastEvaluation: EvaluateResult | undefined;
  let lastConfirm: ConfirmResult | undefined;

  // Phase A: Frame
  const frameResult = await phases.frame(ctx);

  // Phase B: Read
  const readResult = await phases.read(ctx, frameResult);

  // Phase C-D loop: Draft → Evaluate → (reject → re-draft)
  let revisionBrief: RevisionBrief | undefined;
  let draftResult: DraftResult | undefined;

  for (let iteration = 0; iteration < maxIterations; iteration++) {
    // Phase C: Draft (with revision brief if re-drafting)
    draftResult = await phases.draft(ctx, frameResult, readResult, revisionBrief);

    // Phase D: Evaluate
    lastEvaluation = await phases.evaluate(ctx, frameResult, readResult, draftResult);

    if (lastEvaluation.gatePassed) {
      break; // Gate passed, proceed to confirm
    }

    // Gate failed — prepare revision brief for next iteration
    evaluateRejectCount++;
    revisionBrief = lastEvaluation.revisionBrief;

    if (iteration === maxIterations - 1) {
      // Max iterations reached
      return {
        success: false,
        loopSummary: {
          totalIterations: iteration + 1,
          evaluateRejectCount,
          humanDeclineCount,
          finalStatus: "rejected_max_iterations",
        },
        evaluateResult: lastEvaluation,
        lastWarnings: lastEvaluation.warnings,
      };
    }
  }

  if (!draftResult || !lastEvaluation?.gatePassed) {
    return {
      success: false,
      errorMessage: "Draft loop ended without passing gate",
      loopSummary: {
        totalIterations: evaluateRejectCount,
        evaluateRejectCount,
        humanDeclineCount,
        finalStatus: "rejected_max_iterations",
      },
      evaluateResult: lastEvaluation,
    };
  }

  // Phase E: Confirm (collaborative mode only)
  if (ctx.autonomyMode === "collaborative" && requireConfirmation) {
    lastConfirm = await phases.confirm(ctx, draftResult, lastEvaluation);

    if (lastConfirm.status === "declined") {
      humanDeclineCount++;
      return {
        success: false,
        loopSummary: {
          totalIterations: evaluateRejectCount + 1,
          evaluateRejectCount,
          humanDeclineCount,
          finalStatus: "human_declined",
        },
        evaluateResult: lastEvaluation,
        confirmResult: lastConfirm,
      };
    }
  }

  // Phase F: Project to canonical artifacts
  const agentResult = await phases.project(ctx, draftResult, lastEvaluation);

  return {
    success: true,
    agentResult,
    loopSummary: {
      totalIterations: evaluateRejectCount + 1,
      evaluateRejectCount,
      humanDeclineCount,
      finalStatus: "accepted",
    },
    evaluateResult: lastEvaluation,
    confirmResult: lastConfirm,
  };
}

// ── Default Narrative Phases (built from script/* modules) ───────

/**
 * Build default NarrativePhases using the deterministic script engine.
 * This wires frame → read → draft → evaluate → confirm → project
 * using the existing script/* module implementations.
 */
function buildDefaultPhases(
  absDir: string,
  projectId: string,
  selectsContent: unknown,
  briefContent: unknown,
  autonomyMode: "full" | "collaborative",
): NarrativePhases {
  // Parse selects into candidates + beats
  const selects = selectsContent as {
    candidates?: Candidate[];
    beats?: NormalizedBeat[];
  };
  const candidates = selects?.candidates ?? [];

  // Read blueprint if it already exists (for re-run scenarios)
  const blueprintPath = path.join(absDir, "04_plan/edit_blueprint.yaml");
  let existingBlueprint: EditBlueprint | undefined;
  if (fs.existsSync(blueprintPath)) {
    try {
      existingBlueprint = parseYaml(
        fs.readFileSync(blueprintPath, "utf-8"),
      ) as EditBlueprint;
    } catch { /* ignore parse errors for re-run */ }
  }

  // Extract beats from existing blueprint or selects
  const beats: NormalizedBeat[] = selects?.beats
    ?? (existingBlueprint?.beats?.map((b) => ({
      beat_id: b.id,
      label: b.label,
      target_duration_frames: b.target_duration_frames,
      required_roles: b.required_roles,
      preferred_roles: b.preferred_roles ?? [],
      purpose: b.purpose ?? b.label,
    })) ?? []);

  // Stub blueprint for phases that require EditBlueprint
  const stubBlueprint: EditBlueprint = {
    version: "1",
    project_id: projectId,
    sequence_goals: [],
    beats: [],
    pacing: { opening_cadence: "medium", middle_cadence: "varied", ending_cadence: "slow-fade" },
    music_policy: { start_sparse: true, allow_release_late: true, entry_beat: beats[0]?.beat_id ?? "B1", avoid_anthemic_lift: false, permitted_energy_curve: "default" },
    dialogue_policy: { preserve_natural_breath: true, avoid_wall_to_wall_voiceover: true },
  };

  return {
    async frame(ctx) {
      const brief = ctx.briefContent as {
        project?: {
          story_promise?: string;
          hook_angle?: string;
          closing_intent?: string;
          runtime_target_sec?: number;
        };
        editorial_profile_hint?: string;
        editorial_policy_hint?: string;
      };

      const frameInput: FrameInput = {
        projectId: ctx.projectId,
        createdAt: new Date().toISOString(),
        storyPromise: brief?.project?.story_promise ?? "Untitled story",
        hookAngle: brief?.project?.hook_angle ?? "cold open",
        closingIntent: brief?.project?.closing_intent ?? "resolve and reflect",
        resolutionInput: {
          briefEditorial: {
            profile_hint: brief?.editorial_profile_hint ?? "interview-highlight",
            policy_hint: brief?.editorial_policy_hint ?? "default",
          },
          runtimeTargetSec: brief?.project?.runtime_target_sec,
        },
        beatCount: beats.length || 4,
      };

      const { frame } = buildMessageFrame(frameInput);

      return {
        storyPromise: frame.story_promise,
        hookAngle: frame.hook_angle,
        closingIntent: frame.closing_intent,
        beatCount: frame.beat_strategy.beat_count,
        qualityTargets: frame.quality_targets,
      };
    },

    async read(ctx, frameResult) {
      const readInput: ReadInput = {
        projectId: ctx.projectId,
        createdAt: new Date().toISOString(),
        beats,
        candidates,
        blueprint: existingBlueprint ?? stubBlueprint,
      };

      const reading = buildMaterialReading(readInput);

      return {
        beatReadings: reading.beat_readings.map((br) => ({
          beatId: br.beat_id,
          topCandidates: br.top_candidates.map((tc) => tc.candidate_ref),
          coverageGaps: br.coverage_gaps,
        })),
      };
    },

    async draft(ctx, frameResult, readResult, revisionBrief) {
      // Build reading from readResult for draft input
      const readingForDraft = {
        version: "1",
        project_id: ctx.projectId,
        created_at: new Date().toISOString(),
        beat_readings: readResult.beatReadings.map((br) => ({
          beat_id: br.beatId,
          top_candidates: br.topCandidates.map((ref) => ({
            candidate_ref: ref,
            why_primary: "matched by reading",
          })),
          backup_candidates: [] as Array<{ candidate_ref: string; why_backup?: string }>,
          coverage_gaps: br.coverageGaps,
          asset_concentration: 0,
          speaker_risks: [] as string[],
          tone_risks: [] as string[],
        })),
        dedupe_groups: [],
      };

      // If revision brief suggests backup preferences, inject them
      if (revisionBrief?.preferBackups) {
        for (const beatReading of readingForDraft.beat_readings) {
          const backups = revisionBrief.preferBackups.filter((b) =>
            !beatReading.top_candidates.some((tc) => tc.candidate_ref === b),
          );
          beatReading.backup_candidates = backups.map((ref) => ({
            candidate_ref: ref,
            why_backup: "suggested by revision brief",
          }));
        }
      }

      const draftFrame: import("../script/frame.js").MessageFrame = {
        version: "1",
        project_id: ctx.projectId,
        created_at: new Date().toISOString(),
        story_promise: frameResult.storyPromise,
        hook_angle: frameResult.hookAngle,
        closing_intent: frameResult.closingIntent,
        resolved_profile_candidate: { id: "default", source: "default" },
        resolved_policy_candidate: { id: "default", source: "default" },
        beat_strategy: {
          beat_count: frameResult.beatCount,
          role_sequence: buildDefaultRoleSequenceFromCount(frameResult.beatCount),
        },
      };

      const draftInput: DraftInput = {
        projectId: ctx.projectId,
        createdAt: new Date().toISOString(),
        frame: draftFrame,
        reading: readingForDraft,
        blueprint: existingBlueprint ?? stubBlueprint,
        beats,
      };

      const scriptDraft = buildScriptDraft(draftInput);

      return {
        deliveryOrder: scriptDraft.delivery_order,
        beatAssignments: scriptDraft.beat_assignments.map((a) => ({
          beatId: a.beat_id,
          primaryCandidateRef: a.primary_candidate_ref,
          backupCandidateRefs: a.backup_candidate_refs,
          storyRole: a.story_role,
        })),
      };
    },

    async evaluate(ctx, frameResult, readResult, draftResult) {
      const evalInput: EvaluateInput = {
        projectId: ctx.projectId,
        createdAt: new Date().toISOString(),
        draft: {
          version: "1",
          project_id: ctx.projectId,
          created_at: new Date().toISOString(),
          delivery_order: draftResult.deliveryOrder,
          beat_assignments: draftResult.beatAssignments.map((a) => ({
            beat_id: a.beatId,
            primary_candidate_ref: a.primaryCandidateRef,
            backup_candidate_refs: a.backupCandidateRefs,
            story_role: a.storyRole,
            active_skill_hints: [],
            rationale: "",
          })),
        },
        candidates,
        blueprint: existingBlueprint ?? stubBlueprint,
        beats,
        qualityTargets: frameResult.qualityTargets,
      };

      const evaluation = evaluateScript(evalInput);

      const revisionBrief: RevisionBrief | undefined = !evaluation.gate_pass
        ? {
            preserve: evaluation.warnings
              .filter((w) => w.type !== "missing_assignment")
              .map((w) => w.beat_id ?? "")
              .filter(Boolean),
            mustFix: evaluation.warnings.map((w) => w.message),
            brokenBeats: evaluation.missing_beats,
            preferBackups: evaluation.repairs.map((r) => r.to_candidate_ref),
          }
        : undefined;

      return {
        gatePassed: evaluation.gate_pass,
        metrics: {
          hookDensity: evaluation.metrics.hook_density,
          noveltyRate: evaluation.metrics.novelty_rate,
        },
        warnings: evaluation.warnings.map((w) => w.message),
        revisionBrief,
      };
    },

    async confirm(ctx, draftResult, evaluation) {
      // In default phases, collaborative mode skips interactive confirmation
      // (agent.run handles it). Return "skipped" for deterministic phases.
      if (ctx.autonomyMode === "collaborative") {
        return { status: "skipped" };
      }
      return { status: "skipped" };
    },

    async project(ctx, draftResult, evaluation) {
      // Build the final EditBlueprint from the draft result
      const now = new Date().toISOString();
      const blueprint: EditBlueprint = {
        version: "1",
        project_id: ctx.projectId,
        created_at: now,
        sequence_goals: existingBlueprint?.sequence_goals ?? [],
        beats: beats.map((b) => ({
          id: b.beat_id,
          label: b.label,
          target_duration_frames: b.target_duration_frames,
          required_roles: b.required_roles,
          preferred_roles: b.preferred_roles,
        })),
        pacing: {
          opening_cadence: existingBlueprint?.pacing?.opening_cadence ?? "medium",
          middle_cadence: existingBlueprint?.pacing?.middle_cadence ?? "varied",
          ending_cadence: existingBlueprint?.pacing?.ending_cadence ?? "slow-fade",
          confirmed_preferences: {
            mode: ctx.autonomyMode,
            source: ctx.autonomyMode === "full" ? "ai_autonomous" : "human_confirmed",
            duration_target_sec: (ctx.briefContent as { project?: { runtime_target_sec?: number } })?.project?.runtime_target_sec ?? 120,
            confirmed_at: now,
          },
        },
        music_policy: existingBlueprint?.music_policy ?? {
          start_sparse: true,
          allow_release_late: true,
          entry_beat: beats[0]?.beat_id ?? "B1",
        },
        caption_policy: existingBlueprint?.caption_policy,
        dialogue_policy: existingBlueprint?.dialogue_policy ?? {
          preserve_natural_breath: true,
          avoid_wall_to_wall_voiceover: true,
        },
        transition_policy: existingBlueprint?.transition_policy ?? {
          prefer_match_texture_over_flashy_fx: true,
        },
        ending_policy: existingBlueprint?.ending_policy ?? {
          should_feel: "resolved",
        },
        rejection_rules: existingBlueprint?.rejection_rules ?? [],
      };

      const register: UncertaintyRegister = {
        version: "1",
        project_id: ctx.projectId,
        created_at: now,
        uncertainties: [],
      };

      return {
        blueprint,
        uncertaintyRegister: register,
        confirmed: true,
      };
    },
  };
}

function buildDefaultRoleSequenceFromCount(
  count: number,
): Array<"hook" | "setup" | "experience" | "closing"> {
  if (count <= 1) return ["hook"];
  if (count === 2) return ["hook", "closing"];
  if (count === 3) return ["hook", "experience", "closing"];
  const seq: Array<"hook" | "setup" | "experience" | "closing"> = ["hook", "setup"];
  for (let i = 2; i < count - 1; i++) seq.push("experience");
  seq.push("closing");
  return seq;
}
