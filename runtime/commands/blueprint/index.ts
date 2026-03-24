import * as fs from "node:fs";
import * as path from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import {
  draftAndPromote,
  initCommand,
  isCommandError,
  transitionState,
  type CommandError,
  type DraftFile,
} from "../shared.js";
import { ProgressTracker } from "../../progress.js";
import type { GateStatus, ProjectState } from "../../state/reconcile.js";
import type {
  Beat,
  ConfirmedPreferences,
  EditBlueprint,
  QualityTargets,
} from "../../artifacts/types.js";
import { inferAutonomyMode } from "../../autonomy.js";
import { buildDefaultPhases, runNarrativeLoop } from "./narrative.js";
import {
  recordAutonomousConfirmedPreferences,
  validateConfirmedPreferences,
} from "./preferences.js";

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
  confirmed: boolean;
}

export interface NarrativePhases {
  frame(ctx: NarrativePhaseContext): Promise<FrameResult>;
  read(ctx: NarrativePhaseContext, frame: FrameResult): Promise<ReadResult>;
  draft(
    ctx: NarrativePhaseContext,
    frame: FrameResult,
    reading: ReadResult,
    revisionBrief?: RevisionBrief,
  ): Promise<DraftResult>;
  evaluate(
    ctx: NarrativePhaseContext,
    frame: FrameResult,
    reading: ReadResult,
    draft: DraftResult,
  ): Promise<EvaluateResult>;
  confirm(
    ctx: NarrativePhaseContext,
    draft: DraftResult,
    evaluation: EvaluateResult,
  ): Promise<ConfirmResult>;
  project(
    ctx: NarrativePhaseContext,
    draft: DraftResult,
    evaluation: EvaluateResult,
  ): Promise<BlueprintAgentResult>;
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
  iterativeEngine?: boolean;
  maxIterations?: number;
  requireConfirmationInCollaborative?: boolean;
}

const ALLOWED_STATES: ProjectState[] = [
  "selects_ready",
  "blueprint_ready",
  "blocked",
  "timeline_drafted",
  "critique_ready",
  "approved",
  "packaged",
];

export async function runBlueprint(
  projectDir: string,
  agent: BlueprintAgent,
  options?: BlueprintCommandOptions,
  phases?: NarrativePhases,
): Promise<BlueprintCommandResult> {
  const pt = new ProgressTracker(projectDir, "blueprint", 4);
  const ctx = initCommand(projectDir, "/blueprint", ALLOWED_STATES);
  if (isCommandError(ctx)) {
    pt.fail("init", ctx.message);
    return { success: false, error: ctx };
  }
  pt.advance();

  const { projectDir: absDir, reconcileResult, doc, preflightHashes } = ctx;
  const previousState = doc.current_state;
  const projectId = doc.project_id || "";

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
  const blockersContent = parseYaml(fs.readFileSync(blockersPath, "utf-8"));

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
  const selectsContent = parseYaml(fs.readFileSync(selectsPath, "utf-8"));

  const stylePath = path.join(absDir, "STYLE.md");
  const styleContent = fs.existsSync(stylePath)
    ? fs.readFileSync(stylePath, "utf-8")
    : null;

  const useLegacy = options?.iterativeEngine === false;
  const effectivePhases = phases ?? (useLegacy ? undefined : buildDefaultPhases(
    absDir, projectId, selectsContent, briefContent, autonomyMode,
  ));
  const useIterative = !useLegacy && !!effectivePhases;

  let agentResult: BlueprintAgentResult;
  let loopSummary: LoopSummary | undefined;

  if (useIterative && effectivePhases) {
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
      phaseCtx,
      effectivePhases,
      agent,
      maxIter,
      requireConfirm,
    );

    if (!result.success) {
      persistScriptEvaluation(absDir, projectId, result.evaluateResult, result.loopSummary, result.confirmResult);

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

        const drafts: DraftFile[] = [{
          relativePath: "04_plan/uncertainty_register.yaml",
          schemaFile: "uncertainty-register.schema.json",
          content: register,
          format: "yaml",
        }];
        draftAndPromote(absDir, drafts, { preflightHashes });

        const updatedDoc = transitionState(
          absDir,
          doc,
          "blocked",
          "/blueprint",
          "blueprint-planner",
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
    persistScriptEvaluation(absDir, projectId, result.evaluateResult, loopSummary, result.confirmResult);
    pt.advance("04_plan/script_evaluation.yaml");
  } else {
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

  const hasPlanningBlocker = agentResult.uncertaintyRegister.uncertainties.some(
    (uncertainty) => uncertainty.status === "blocker",
  );
  const hasCompileBlocker = reconcileResult.gates.compile_gate === "blocked";
  const targetState: ProjectState = hasPlanningBlocker || hasCompileBlocker
    ? "blocked"
    : "blueprint_ready";
  const note = hasPlanningBlocker || hasCompileBlocker
    ? "blueprint finalized with unresolved blockers"
    : "blueprint and uncertainty register finalized";

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

function persistScriptEvaluation(
  projectDir: string,
  projectId: string,
  evaluateResult?: EvaluateResult,
  loopSummary?: LoopSummary,
  confirmResult?: ConfirmResult,
): void {
  if (!evaluateResult && !loopSummary) {
    return;
  }

  const planDir = path.join(projectDir, "04_plan");
  fs.mkdirSync(planDir, { recursive: true });
  fs.writeFileSync(
    path.join(planDir, "script_evaluation.yaml"),
    stringifyYaml({
      version: "1",
      project_id: projectId,
      loop_summary: loopSummary,
      gate_pass: evaluateResult?.gatePassed ?? false,
      metrics: evaluateResult?.metrics,
      warnings: evaluateResult?.warnings,
      confirmation_status: confirmResult?.status ?? "skipped",
      decline_reason: confirmResult?.declineReason,
    }),
    "utf-8",
  );
}

export {
  buildDefaultPhases,
  recordAutonomousConfirmedPreferences,
  runNarrativeLoop,
  validateConfirmedPreferences,
} from "./index-reexports.js";
