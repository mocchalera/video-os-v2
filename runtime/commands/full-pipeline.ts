import * as fs from "node:fs";
import * as path from "node:path";
import { runAnalyze, type AnalyzeCommandOptions, type AnalyzeCommandResult, type AnalyzeRunner } from "./analyze.js";
import { runIntent, type IntentAgent, type IntentCommandResult } from "./intent.js";
import { runTriage, type TriageAgent, type TriageCommandResult } from "./triage.js";
import {
  runBlueprint,
  type BlueprintAgent,
  type BlueprintCommandOptions,
  type BlueprintCommandResult,
} from "./blueprint.js";
import { runCompilePhase, type CompileCommandOptions, type CompileCommandResult } from "./compile.js";
import {
  runReview,
  type ReviewAgent,
  type ReviewCommandOptions,
  type ReviewCommandResult,
} from "./review.js";
import { runRender, type RenderCommandResult } from "./render.js";
import { runStatus } from "./status.js";
import type { PackageCommandOptions } from "./package.js";
import type { CommandError } from "./shared.js";
import type { ProjectState } from "../state/reconcile.js";
import {
  formatStageFailureMessage,
  PipelineStageProgressTracker,
  readSegmentCount,
  type PipelineStageProgress,
  type PipelineTimingStage,
} from "../progress.js";
import {
  buildFullPipelineCommandPhases,
  buildFullPipelineCommandTimingStages,
  type FullPipelinePhase,
  type FullPipelineTarget,
} from "../pipeline/plan.js";
import {
  executePipelinePhases,
  failPipelinePhase,
  type PipelinePhaseFailure,
  type PipelinePhaseStep,
} from "../pipeline/phase-executor.js";

export type { FullPipelinePhase, FullPipelineTarget } from "../pipeline/plan.js";

export interface FullPipelineDeps {
  intentAgent: IntentAgent;
  triageAgent: TriageAgent;
  blueprintAgent: BlueprintAgent;
  reviewAgent: ReviewAgent;
  analyzeRunner?: AnalyzeRunner;
}

export interface FullPipelineOptions {
  from?: FullPipelinePhase;
  target?: FullPipelineTarget;
  analyze?: AnalyzeCommandOptions;
  blueprint?: BlueprintCommandOptions;
  compile?: CompileCommandOptions;
  review?: ReviewCommandOptions;
  render?: PackageCommandOptions;
  stageProgress?: PipelineStageProgress;
  triage?: {
    analysisOverride?: boolean;
  };
}

export interface FullPipelineResult {
  success: boolean;
  from?: FullPipelinePhase;
  completedPhases: FullPipelinePhase[];
  finalState?: ProjectState;
  error?: CommandError;
  analyze?: AnalyzeCommandResult;
  intent?: IntentCommandResult;
  triage?: TriageCommandResult;
  blueprint?: BlueprintCommandResult;
  compile?: CompileCommandResult;
  review?: ReviewCommandResult;
  render?: RenderCommandResult;
}

interface FullPipelinePhaseFailure {
  error?: CommandError;
  stage: PipelineTimingStage;
}

export async function runFullPipeline(
  projectDir: string,
  deps: FullPipelineDeps,
  options?: FullPipelineOptions,
): Promise<FullPipelineResult> {
  const target = options?.target ?? "roughcut";
  const from = options?.from ?? detectResumePhase(projectDir, target);
  if (!from) {
    return {
      success: true,
      completedPhases: [],
      finalState: runStatus(projectDir).currentState,
    };
  }

  const ownProgress = options?.stageProgress ? null : new PipelineStageProgressTracker({
    projectDir,
    entrypoint: "full-pipeline",
    stages: buildFullPipelineCommandTimingStages({ from, target, analyze: options?.analyze }),
    segmentCount: readSegmentCount(projectDir),
  });
  const stageProgress = options?.stageProgress ?? ownProgress ?? undefined;
  const result: FullPipelineResult = {
    success: false,
    from,
    completedPhases: [],
  };

  const steps: Array<PipelinePhaseStep<FullPipelinePhase, FullPipelinePhaseFailure>> =
    buildFullPipelineCommandPhases({ from, target }).map((phase) => ({
      phase,
      run: () => executeFullPipelinePhase(
        phase,
        projectDir,
        deps,
        options,
        result,
        stageProgress,
        ownProgress,
      ),
    }));
  const execution = await executePipelinePhases(steps);
  result.completedPhases.push(...execution.completedPhases);

  if (!execution.success) {
    const failure = execution.failure;
    return finishFailure(
      projectDir,
      result,
      failure?.error,
      failure?.stage ?? "triage",
      ownProgress,
    );
  }

  ownProgress?.finish("completed");
  return {
    ...result,
    success: true,
    finalState: runStatus(projectDir).currentState,
  };
}

async function executeFullPipelinePhase(
  phase: FullPipelinePhase,
  projectDir: string,
  deps: FullPipelineDeps,
  options: FullPipelineOptions | undefined,
  result: FullPipelineResult,
  stageProgress: PipelineStageProgress | undefined,
  ownProgress: PipelineStageProgressTracker | null,
): Promise<void | PipelinePhaseFailure<FullPipelinePhaseFailure>> {
  if (phase === "analyze") {
    const analyze = await runAnalyze(
      projectDir,
      { ...(options?.analyze ?? { sourceFiles: [] }), stageProgress },
      deps.analyzeRunner,
    );
    result.analyze = analyze;
    if (!analyze.success) return failPipelinePhase({ error: analyze.error, stage: "ingest" });
    ownProgress?.refreshEstimates(readSegmentCount(projectDir));
    return;
  }

  if (phase === "triage") {
    const stage = stageProgress?.beginStage("triage");
    const intent = await ensureIntent(projectDir, deps.intentAgent);
    if (intent) {
      result.intent = intent;
      if (!intent.success) {
        stage?.fail(intent.error?.message ?? "intent failed");
        return failPipelinePhase({ error: intent.error, stage: "triage" });
      }
    }
    const triage = await runTriage(projectDir, deps.triageAgent, options?.triage);
    result.triage = triage;
    if (!triage.success) {
      stage?.fail(triage.error?.message ?? "triage failed");
      return failPipelinePhase({ error: triage.error, stage: "triage" });
    }
    stage?.complete();
    return;
  }

  if (phase === "blueprint") {
    const stage = stageProgress?.beginStage("blueprint");
    const intent = await ensureIntent(projectDir, deps.intentAgent);
    if (intent) {
      result.intent = intent;
      if (!intent.success) {
        stage?.fail(intent.error?.message ?? "intent failed");
        return failPipelinePhase({ error: intent.error, stage: "blueprint" });
      }
    }
    const blueprint = await runBlueprint(projectDir, deps.blueprintAgent, options?.blueprint);
    result.blueprint = blueprint;
    if (!blueprint.success) {
      stage?.fail(blueprint.error?.message ?? "blueprint failed");
      return failPipelinePhase({ error: blueprint.error, stage: "blueprint" });
    }
    stage?.complete();
    return;
  }

  if (phase === "compile") {
    const stage = stageProgress?.beginStage("compile");
    const compile = await runCompilePhase(projectDir, options?.compile);
    result.compile = compile;
    if (!compile.success) {
      stage?.fail(compile.error?.message ?? "compile failed");
      return failPipelinePhase({ error: compile.error, stage: "compile" });
    }
    stage?.complete();
    return;
  }

  if (phase === "review") {
    const stage = stageProgress?.beginStage("QA");
    const reviewOptions: ReviewCommandOptions = {
      ...options?.review,
      requireCompiledTimeline: true,
    };
    const review = await runReview(projectDir, deps.reviewAgent, reviewOptions);
    result.review = review;
    if (!review.success) {
      stage?.fail(review.error?.message ?? "review failed");
      return failPipelinePhase({ error: review.error, stage: "QA" });
    }

    if (review.patch && review.patch.operations.length > 0) {
      const patchCompile = await runCompilePhase(projectDir, {
        ...options?.compile,
        reviewPatch: review.patch,
      });
      result.compile = patchCompile;
      if (!patchCompile.success) {
        stage?.fail(patchCompile.error?.message ?? "review patch compile failed");
        return failPipelinePhase(
          { error: patchCompile.error, stage: "QA" },
          { phaseCompleted: true },
        );
      }

      const rereview = await runReview(projectDir, deps.reviewAgent, reviewOptions);
      result.review = rereview;
      if (!rereview.success) {
        stage?.fail(rereview.error?.message ?? "review failed");
        return failPipelinePhase(
          { error: rereview.error, stage: "QA" },
          { phaseCompleted: true },
        );
      }
    }
    stage?.complete();
    return;
  }

  const stage = stageProgress?.beginStage("render");
  const render = await runRender(projectDir, options?.render);
  result.render = render;
  if (!render.success) {
    stage?.fail(render.error?.message ?? "render failed");
    return failPipelinePhase({ error: render.error, stage: "render" });
  }
  stage?.complete();
}

function detectResumePhase(
  projectDir: string,
  target: "roughcut" | "package",
): FullPipelinePhase | undefined {
  const status = runStatus(projectDir);
  if (!status.success) {
    return "analyze";
  }

  const absDir = path.resolve(projectDir);
  const gates = status.gates;
  const state = status.currentState;

  if (target === "package" && state === "packaged") {
    return undefined;
  }
  if (target === "roughcut" && (state === "critique_ready" || state === "approved" || state === "packaged")) {
    return undefined;
  }

  if (gates?.analysis_gate === "blocked") {
    return "analyze";
  }

  if (!hasIntentArtifacts(absDir) || !fs.existsSync(path.join(absDir, "04_plan/selects_candidates.yaml"))) {
    return "triage";
  }
  if (!fs.existsSync(path.join(absDir, "04_plan/edit_blueprint.yaml"))) {
    return "blueprint";
  }
  if (!fs.existsSync(path.join(absDir, "05_timeline/timeline.json"))) {
    return "compile";
  }
  if (!fs.existsSync(path.join(absDir, "06_review/review_report.yaml")) ||
      !fs.existsSync(path.join(absDir, "06_review/review_patch.json"))) {
    return "review";
  }
  if (target === "package") {
    return "render";
  }

  if (state === "timeline_drafted") return "review";
  if (state === "blueprint_ready" || state === "blocked") return "compile";
  return undefined;
}

async function ensureIntent(
  projectDir: string,
  intentAgent: IntentAgent,
): Promise<IntentCommandResult | null> {
  if (hasIntentArtifacts(projectDir)) {
    return null;
  }
  return runIntent(projectDir, intentAgent);
}

function hasIntentArtifacts(projectDir: string): boolean {
  return fs.existsSync(path.join(projectDir, "01_intent/creative_brief.yaml")) &&
    fs.existsSync(path.join(projectDir, "01_intent/unresolved_blockers.yaml"));
}

function finishFailure(
  projectDir: string,
  result: FullPipelineResult,
  error: CommandError | undefined,
  stage: PipelineTimingStage,
  progress?: PipelineStageProgressTracker | null,
): FullPipelineResult {
  progress?.finish("failed");
  const enhancedError = error
    ? {
        ...error,
        message: formatStageFailureMessage("full-pipeline", projectDir, stage, error.message),
      }
    : undefined;
  return {
    ...result,
    success: false,
    error: enhancedError,
    finalState: runStatus(projectDir).currentState,
  };
}
