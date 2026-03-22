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
import type { ProjectState, GateStatus } from "../state/reconcile.js";

// ── Types ────────────────────────────────────────────────────────

export interface ConfirmedPreferences {
  mode: "full" | "collaborative";
  source: "human_confirmed" | "ai_autonomous";
  duration_target_sec: number;
  confirmed_at: string;
  structure_choice?: string;
  pacing_notes?: string;
}

export interface Beat {
  id: string;
  label: string;
  purpose?: string;
  target_duration_frames: number;
  required_roles: Array<"hero" | "support" | "transition" | "texture" | "dialogue">;
  preferred_roles?: Array<"hero" | "support" | "transition" | "texture" | "dialogue">;
  notes?: string;
}

export interface EditBlueprint {
  version?: string;
  project_id?: string;
  created_at?: string;
  sequence_goals: string[];
  beats: Beat[];
  pacing: {
    opening_cadence: string;
    middle_cadence: string;
    ending_cadence: string;
    max_shot_length_frames?: number;
    confirmed_preferences?: ConfirmedPreferences;
  };
  music_policy: {
    start_sparse: boolean;
    allow_release_late: boolean;
    entry_beat: string;
    avoid_anthemic_lift?: boolean;
    permitted_energy_curve?: string;
  };
  caption_policy?: {
    language: string;
    delivery_mode: "burn_in" | "sidecar" | "both";
    source: "transcript" | "authored" | "none";
    styling_class: string;
  };
  dialogue_policy: {
    preserve_natural_breath: boolean;
    avoid_wall_to_wall_voiceover: boolean;
    prioritize_lines?: string[];
  };
  transition_policy: {
    prefer_match_texture_over_flashy_fx: boolean;
    allow_hard_cuts?: boolean;
    avoid_speed_ramps?: boolean;
  };
  ending_policy: {
    should_feel: string;
    final_line_strategy?: string;
    avoid_cta?: boolean;
    final_hold_min_frames?: number;
  };
  rejection_rules: string[];
}

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
  qualityTargets?: Record<string, number>;
}

export interface ReadResult {
  beatReadings: Array<{
    beatId: string;
    topCandidates: string[];
    coverageGaps: string[];
  }>;
}

export interface DraftResult {
  deliveryOrder: string[];
  beatAssignments: Array<{
    beatId: string;
    primaryCandidateRef: string;
    backupCandidateRefs: string[];
    storyRole: string;
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
];

function inferAutonomyMode(
  briefContent: {
    autonomy?: { mode?: "full" | "collaborative"; must_ask?: string[] };
  },
): "full" | "collaborative" {
  if (briefContent.autonomy?.mode) {
    return briefContent.autonomy.mode;
  }
  return (briefContent.autonomy?.must_ask?.length ?? 0) === 0 ? "full" : "collaborative";
}

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

// ── Main entry: supports both legacy agent and iterative engine ──

export async function runBlueprint(
  projectDir: string,
  agent: BlueprintAgent,
  options?: BlueprintCommandOptions,
  phases?: NarrativePhases,
): Promise<BlueprintCommandResult> {
  // 1. Init command (reconcile + state check)
  const ctx = initCommand(projectDir, "/blueprint", ALLOWED_STATES);
  if (isCommandError(ctx)) {
    return { success: false, error: ctx };
  }

  const { projectDir: absDir, reconcileResult, doc, preflightHashes } = ctx;
  const previousState = doc.current_state;
  const projectId = doc.project_id || "";

  // 2. Read creative_brief.yaml to determine autonomy mode
  const briefPath = path.join(absDir, "01_intent/creative_brief.yaml");
  if (!fs.existsSync(briefPath)) {
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

  // 5. Decide path: iterative engine or legacy single-pass
  const useIterative = (options?.iterativeEngine !== false) && !!phases;

  let agentResult: BlueprintAgentResult;
  let loopSummary: LoopSummary | undefined;

  if (useIterative && phases) {
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
      phaseCtx, phases, agent, maxIter, requireConfirm,
    );

    if (!result.success) {
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

  // 6. If human declined beat proposal readback, abort
  if (!agentResult.confirmed) {
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
