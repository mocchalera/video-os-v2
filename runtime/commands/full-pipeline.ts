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

export type FullPipelinePhase =
  | "analyze"
  | "triage"
  | "blueprint"
  | "compile"
  | "review"
  | "render";

export interface FullPipelineDeps {
  intentAgent: IntentAgent;
  triageAgent: TriageAgent;
  blueprintAgent: BlueprintAgent;
  reviewAgent: ReviewAgent;
  analyzeRunner?: AnalyzeRunner;
}

export interface FullPipelineOptions {
  from?: FullPipelinePhase;
  target?: "roughcut" | "package";
  analyze?: AnalyzeCommandOptions;
  blueprint?: BlueprintCommandOptions;
  compile?: CompileCommandOptions;
  review?: ReviewCommandOptions;
  render?: PackageCommandOptions;
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

const PHASE_ORDER: FullPipelinePhase[] = [
  "analyze",
  "triage",
  "blueprint",
  "compile",
  "review",
  "render",
];

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

  const startedAt = PHASE_ORDER.indexOf(from);
  const completedPhases: FullPipelinePhase[] = [];
  const result: FullPipelineResult = {
    success: false,
    from,
    completedPhases,
  };

  for (let i = startedAt; i < PHASE_ORDER.length; i++) {
    const phase = PHASE_ORDER[i];
    if (target === "roughcut" && phase === "render") {
      break;
    }

    if (phase === "analyze") {
      const analyze = await runAnalyze(projectDir, options?.analyze ?? { sourceFiles: [] }, deps.analyzeRunner);
      result.analyze = analyze;
      if (!analyze.success) {
        return finishFailure(projectDir, result, analyze.error);
      }
      completedPhases.push("analyze");
      continue;
    }

    if (phase === "triage") {
      const intent = await ensureIntent(projectDir, deps.intentAgent);
      if (intent) {
        result.intent = intent;
        if (!intent.success) {
          return finishFailure(projectDir, result, intent.error);
        }
      }

      const triage = await runTriage(projectDir, deps.triageAgent, options?.triage);
      result.triage = triage;
      if (!triage.success) {
        return finishFailure(projectDir, result, triage.error);
      }
      completedPhases.push("triage");
      continue;
    }

    if (phase === "blueprint") {
      const intent = await ensureIntent(projectDir, deps.intentAgent);
      if (intent) {
        result.intent = intent;
        if (!intent.success) {
          return finishFailure(projectDir, result, intent.error);
        }
      }

      const blueprint = await runBlueprint(
        projectDir,
        deps.blueprintAgent,
        options?.blueprint,
      );
      result.blueprint = blueprint;
      if (!blueprint.success) {
        return finishFailure(projectDir, result, blueprint.error);
      }
      completedPhases.push("blueprint");
      continue;
    }

    if (phase === "compile") {
      const compile = runCompilePhase(projectDir, options?.compile);
      result.compile = compile;
      if (!compile.success) {
        return finishFailure(projectDir, result, compile.error);
      }
      completedPhases.push("compile");
      continue;
    }

    if (phase === "review") {
      const reviewOptions: ReviewCommandOptions = {
        ...options?.review,
        requireCompiledTimeline: true,
      };

      const review = await runReview(projectDir, deps.reviewAgent, reviewOptions);
      result.review = review;
      if (!review.success) {
        return finishFailure(projectDir, result, review.error);
      }
      completedPhases.push("review");

      if (review.patch && review.patch.operations.length > 0) {
        const patchCompile = runCompilePhase(projectDir, {
          ...options?.compile,
          reviewPatch: review.patch,
        });
        result.compile = patchCompile;
        if (!patchCompile.success) {
          return finishFailure(projectDir, result, patchCompile.error);
        }

        const rereview = await runReview(projectDir, deps.reviewAgent, reviewOptions);
        result.review = rereview;
        if (!rereview.success) {
          return finishFailure(projectDir, result, rereview.error);
        }
      }

      continue;
    }

    if (phase === "render") {
      const render = await runRender(projectDir, options?.render);
      result.render = render;
      if (!render.success) {
        return finishFailure(projectDir, result, render.error);
      }
      completedPhases.push("render");
    }
  }

  return {
    ...result,
    success: true,
    finalState: runStatus(projectDir).currentState,
  };
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
): FullPipelineResult {
  return {
    ...result,
    success: false,
    error,
    finalState: runStatus(projectDir).currentState,
  };
}
