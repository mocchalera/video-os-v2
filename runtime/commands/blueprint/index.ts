import * as fs from "node:fs";
import * as path from "node:path";
import {
  assertStillImageCandidateGrounding,
  assertStillImageSegmentGrounding,
} from "../../artifacts/still-image-grounding.js";
import {
  assertImageSequenceCandidateGrounding,
  assertImageSequenceGrounding,
} from "../../artifacts/image-sequence-grounding.js";
import {
  assertCandidatePlanningMediaKindsSupported,
  assertProjectPlanningMediaKindsSupported,
  MediaKindPlanningBlockedError,
} from "../../artifacts/source-media-capabilities.js";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import {
  draftAndPromote,
  initCommand,
  isCommandError,
  resolveProjectRoot,
  transitionState,
  validateAgainstSchema,
  type CommandError,
  type DraftFile,
} from "../shared.js";
import { ProgressTracker } from "../../progress.js";
import type { GateStatus, ProjectState } from "../../state/reconcile.js";
import type {
  Beat,
  ConfirmedPreferences,
  CreativeBrief,
  EditBlueprint,
  ProfileDefaults,
  QualityTargets,
  ResolvedRef,
  SelectsCandidates,
} from "../../artifacts/types.js";
import type { MessageFrameDiagnostic } from "../../script/frame.js";
import type { MarlinEventsArtifact } from "../../connectors/marlin-types.js";
import { loadSourceMap } from "../../media/source-map.js";
import {
  extractCraftKeyFrames,
  type KeyFrame,
} from "../../pipeline/stages/craft-frames.js";
import { inferAutonomyMode } from "../../autonomy.js";
import {
  applyCraftRevisions,
  renderCraftReviewMarkdown,
  reviewBlueprintCraft,
} from "../../agents/editorial-craft-agent.js";
import type { CraftDecision } from "../../agents/editorial-craft-types.js";
import { buildDefaultPhases, runNarrativeLoop } from "./narrative.js";
import {
  recordAutonomousConfirmedPreferences,
  validateConfirmedPreferences,
} from "./preferences.js";
import {
  buildLongformBlueprint,
  isLongformEventBrief,
} from "../../editorial/longform-event.js";
import {
  evaluateNarrativeArcBlueprintContract,
  NarrativeArcContractError,
  narrativeArcContractMessages,
} from "../../eval/narrative-arc-contract.js";

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
    frame: FrameResult,
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
  resolvedProfile?: ResolvedRef;
  resolvedPolicy?: ResolvedRef;
  profileDefaults?: ProfileDefaults;
  diagnostics?: MessageFrameDiagnostic[];
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
  craftDecision?: CraftDecision;
}

export interface BlueprintCommandOptions {
  iterativeEngine?: boolean;
  maxIterations?: number;
  requireConfirmationInCollaborative?: boolean;
  skipCraftReview?: boolean;
  skipCraftFrames?: boolean;
  craftReviewModel?: string;
  craftReviewer?: (
    brief: CreativeBrief,
    selects: SelectsCandidates,
    blueprint: EditBlueprint,
    marlinEvents: MarlinEventsArtifact | null,
    keyFrames?: Map<string, KeyFrame[]>,
  ) => Promise<CraftDecision>;
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

function readCanonicalBrief(briefPath: string): { content?: unknown; errors: string[] } {
  try {
    const content = parseYaml(fs.readFileSync(briefPath, "utf-8"));
    // narrative_mode is additive. Validate its complete canonical brief while
    // preserving the established command ordering for legacy briefs that omit it.
    const hasNarrativeMode = typeof content === "object"
      && content !== null
      && Object.prototype.hasOwnProperty.call(content, "narrative_mode");
    if (hasNarrativeMode) {
      const validation = validateAgainstSchema(content, "creative-brief.schema.json");
      if (!validation.valid) return { errors: validation.errors };
    }
    return { content, errors: [] };
  } catch (error) {
    return { errors: [error instanceof Error ? error.message : String(error)] };
  }
}

export async function runBlueprint(
  projectDir: string,
  agent: BlueprintAgent,
  options?: BlueprintCommandOptions,
  phases?: NarrativePhases,
): Promise<BlueprintCommandResult> {
  const preflightProjectDir = resolveProjectRoot(projectDir);
  // Grounding is read-only; run it before ProgressTracker/initCommand persist
  // progress and reconciled project state.
  assertBlueprintGroundingPreflight(preflightProjectDir);
  const preflightBriefPath = path.join(preflightProjectDir, "01_intent/creative_brief.yaml");
  if (fs.existsSync(preflightBriefPath)) {
    const preflightBrief = readCanonicalBrief(preflightBriefPath);
    if (preflightBrief.errors.length > 0) {
      return {
        success: false,
        error: {
          code: "VALIDATION_FAILED",
          message: `creative_brief.yaml validation failed: ${preflightBrief.errors.join("; ")}`,
          details: preflightBrief.errors,
        },
      };
    }
  }

  const pt = new ProgressTracker(preflightProjectDir, "blueprint", 5);
  const ctx = initCommand(preflightProjectDir, "/blueprint", ALLOWED_STATES);
  if (isCommandError(ctx)) {
    pt.fail("init", ctx.message);
    return { success: false, error: ctx };
  }
  pt.advance();

  const { projectDir: absDir, reconcileResult, doc, preflightHashes } = ctx;
  const previousState = doc.current_state;
  const projectId = doc.project_id || "";
  try {
    assertProjectPlanningMediaKindsSupported(absDir);
  } catch (error) {
    if (!(error instanceof MediaKindPlanningBlockedError)) throw error;
    pt.block("gate", error.message);
    return {
      success: false,
      error: {
        code: "GATE_CHECK_FAILED",
        message: error.message,
        details: { consumer_impact: "planning_block", reason: "media_kind_not_plannable", asset_ids: error.assetIds },
      },
      previousState,
      planningBlocked: true,
    };
  }
  assertStillImageSegmentGrounding(absDir);


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
  const canonicalBrief = readCanonicalBrief(briefPath);
  if (canonicalBrief.errors.length > 0) {
    pt.fail("brief", `creative_brief.yaml validation failed: ${canonicalBrief.errors.join("; ")}`);
    return {
      success: false,
      error: {
        code: "VALIDATION_FAILED",
        message: `creative_brief.yaml validation failed: ${canonicalBrief.errors.join("; ")}`,
        details: canonicalBrief.errors,
      },
      previousState,
    };
  }
  const briefContent = canonicalBrief.content as {
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
  try {
    assertCandidatePlanningMediaKindsSupported((selectsContent as SelectsCandidates).candidates ?? []);
  } catch (error) {
    if (!(error instanceof MediaKindPlanningBlockedError)) throw error;
    pt.block("gate", error.message);
    return {
      success: false,
      error: {
        code: "GATE_CHECK_FAILED",
        message: error.message,
        details: { consumer_impact: "planning_block", reason: "media_kind_not_plannable", asset_ids: error.assetIds },
      },
      previousState,
      planningBlocked: true,
    };
  }
  assertStillImageCandidateGrounding(absDir, (selectsContent as SelectsCandidates).candidates ?? []);
  assertImageSequenceCandidateGrounding(absDir, (selectsContent as SelectsCandidates).candidates ?? []);

  const stylePath = path.join(absDir, "STYLE.md");
  const styleContent = fs.existsSync(stylePath)
    ? fs.readFileSync(stylePath, "utf-8")
    : null;

  const longformMode = isLongformEventBrief(briefContent);

  const useLegacy = options?.iterativeEngine === false;
  const effectivePhases = longformMode ? undefined : phases ?? (useLegacy ? undefined : buildDefaultPhases(
    absDir, projectId, selectsContent, briefContent, autonomyMode,
  ));
  const useIterative = !longformMode && !useLegacy && !!effectivePhases;

  let agentResult: BlueprintAgentResult;
  let loopSummary: LoopSummary | undefined;

  if (longformMode) {
    try {
      agentResult = {
        blueprint: buildLongformBlueprint(
          projectId,
          briefContent as CreativeBrief,
          selectsContent as SelectsCandidates,
        ),
        uncertaintyRegister: {
          version: "1",
          project_id: projectId,
          created_at: new Date().toISOString(),
          uncertainties: [{
            id: "U_LONGFORM_VISUAL_QA",
            type: "technical",
            question: "Do optional visual models reveal camera accidents inside retained transcript windows?",
            status: "monitoring",
            evidence: [
              "Longform selection is transcript-first and fail-open when optional visual models are unavailable.",
              "Final render QA must sample every chapter before packaging.",
            ],
            alternatives: [{
              label: "chapter-sampled visual QA",
              description: "Run Marlin or human samples per chapter without blocking deterministic planning.",
            }],
            escalation_required: false,
          }],
        },
        confirmed: true,
      };
      loopSummary = {
        totalIterations: 1,
        evaluateRejectCount: 0,
        humanDeclineCount: 0,
        finalStatus: "accepted",
      };
      console.log(
        `[blueprint:longform] chapters=${agentResult.blueprint.longform_plan?.chapters.length ?? 0} ` +
          `beats=${agentResult.blueprint.beats.length} deterministic=true`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      pt.fail("longform", `Longform blueprint planning failed: ${message}`);
      return {
        success: false,
        error: {
          code: "VALIDATION_FAILED",
          message: `Longform blueprint planning failed: ${message}`,
        },
        previousState,
        planningBlocked: true,
      };
    }
  } else if (useIterative && effectivePhases) {
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
      if (result.contractResult?.status === "fail") {
        const contractError = new NarrativeArcContractError(result.contractResult);
        pt.fail("validate", contractError.message);
        return {
          success: false,
          error: {
            code: "VALIDATION_FAILED",
            message: contractError.message,
            details: result.contractResult,
          },
          previousState,
          loopSummary: result.loopSummary,
        };
      }
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

  // This validation deliberately precedes any confirmation/approval handling
  // for direct, longform, and autonomous paths. The iterative path performs
  // the same check inside runNarrativeLoop immediately before phases.confirm.
  const preApprovalContract = evaluateNarrativeArcBlueprintContract(
    briefContent as CreativeBrief,
    agentResult.blueprint,
    selectsContent as SelectsCandidates,
  );
  if (preApprovalContract.status === "fail") {
    const contractError = new NarrativeArcContractError(preApprovalContract);
    pt.fail("validate", contractError.message);
    return {
      success: false,
      error: {
        code: "VALIDATION_FAILED",
        message: contractError.message,
        details: preApprovalContract,
      },
      previousState,
      loopSummary,
    };
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

  let craftDecision: CraftDecision | undefined;
  let appliedCraftRevisionCount = 0;
  if (!options?.skipCraftReview && !longformMode) {
    const marlinEvents = readProjectMarlinEvents(absDir);
    let keyFrames: Map<string, KeyFrame[]> | undefined;
    try {
      if (!options?.skipCraftFrames) {
        keyFrames = await extractCraftKeyFrames(
          absDir,
          (selectsContent as SelectsCandidates).candidates ?? [],
          marlinEvents,
          loadSourceMap(absDir).entryMap,
        );
      }
      craftDecision = options?.craftReviewer
        ? await options.craftReviewer(
          briefContent as CreativeBrief,
          selectsContent as SelectsCandidates,
          agentResult.blueprint,
          marlinEvents,
          keyFrames,
        )
        : await reviewBlueprintCraft(
          briefContent as CreativeBrief,
          selectsContent as SelectsCandidates,
          agentResult.blueprint,
          marlinEvents,
          keyFrames ?? new Map(),
          { model: options?.craftReviewModel },
        );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      pt.fail("craft", `Editorial craft review failed: ${message}`);
      return {
        success: false,
        error: {
          code: "VALIDATION_FAILED",
          message: `Editorial craft review failed: ${message}`,
        },
        previousState,
        loopSummary,
      };
    }

    if (craftDecision.verdict === "block") {
      writeCraftReviewTrace(absDir, craftDecision, 0);
      const message = `Editorial craft review blocked promotion: ${craftDecision.summary}`;
      const updatedDoc = transitionState(
        absDir,
        doc,
        "blocked",
        "/blueprint",
        "editorial-craft-reviewer",
        message,
      );
      pt.fail("craft", message);
      return {
        success: false,
        error: {
          code: "VALIDATION_FAILED",
          message,
          details: craftDecision.issues,
        },
        previousState,
        newState: updatedDoc.current_state,
        planningBlocked: true,
        loopSummary,
        craftDecision,
      };
    }

    if (craftDecision.verdict === "revise") {
      agentResult.blueprint = applyCraftRevisions(agentResult.blueprint, craftDecision);
      appliedCraftRevisionCount = craftDecision.revisions.length;
      console.log(`[craft-review] applied ${appliedCraftRevisionCount} blueprint revision(s)`);
    }
  } else if (longformMode) {
    console.log("[blueprint:longform] skipped per-candidate craft review; chapter-sampled visual QA remains monitoring.");
  }

  const narrativeArcContract = evaluateNarrativeArcBlueprintContract(
    briefContent as CreativeBrief,
    agentResult.blueprint,
    selectsContent as SelectsCandidates,
  );
  if (narrativeArcContract.status === "fail") {
    const errors = narrativeArcContractMessages(narrativeArcContract);
    pt.fail("validate", `Narrative arc contract failed: ${errors.join("; ")}`);
    return {
      success: false,
      error: {
        code: "VALIDATION_FAILED",
        message: `Narrative arc contract failed: ${errors.join("; ")}`,
        details: errors,
      },
      previousState,
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
  if (craftDecision) {
    writeCraftReviewTrace(absDir, craftDecision, appliedCraftRevisionCount);
  }

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
    craftDecision,
  };
}

function assertBlueprintGroundingPreflight(projectDir: string): void {
  assertStillImageSegmentGrounding(projectDir);
  assertImageSequenceGrounding(projectDir);

  const selectsPath = path.join(projectDir, "04_plan/selects_candidates.yaml");
  if (!fs.existsSync(selectsPath)) return;

  let selects: SelectsCandidates;
  try {
    selects = parseYaml(fs.readFileSync(selectsPath, "utf-8")) as SelectsCandidates;
  } catch {
    return;
  }
  const candidates = Array.isArray(selects?.candidates) ? selects.candidates : [];
  assertStillImageCandidateGrounding(projectDir, candidates);
  assertImageSequenceCandidateGrounding(projectDir, candidates);
}

function readProjectMarlinEvents(projectDir: string): MarlinEventsArtifact | null {
  const marlinPath = path.join(projectDir, "03_analysis", "marlin_events.json");
  if (!fs.existsSync(marlinPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(marlinPath, "utf-8")) as MarlinEventsArtifact;
  } catch {
    return null;
  }
}

function writeCraftReviewTrace(
  projectDir: string,
  decision: CraftDecision,
  appliedRevisionCount: number,
): void {
  const planDir = path.join(projectDir, "04_plan");
  fs.mkdirSync(planDir, { recursive: true });
  fs.writeFileSync(
    path.join(planDir, "editorial_craft_review.md"),
    renderCraftReviewMarkdown(decision, appliedRevisionCount),
    "utf-8",
  );
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
