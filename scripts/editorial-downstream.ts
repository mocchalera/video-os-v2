import { config as dotenvConfig } from "dotenv";
import * as fs from "node:fs";
import * as path from "node:path";
import { validateArtifact } from "../runtime/artifacts/loaders.js";
import type {
  CreativeBrief,
  EditBlueprint,
  SelectsCandidates,
  TimelineIR,
} from "../runtime/artifacts/types.js";
import { runQALoop, type QALoopResult } from "../runtime/eval/qa-loop.js";
import { assertDeferredProductionDirectivesSatisfied } from "../runtime/eval/selection-coverage.js";
import {
  formatStageFailureMessage,
  type PipelineTimingStage,
} from "../runtime/progress.js";
import { writeJsonArtifact } from "../runtime/pipeline/editorial-context.js";
import { FULL_PIPELINE_CANONICAL_OUTPUTS } from "../runtime/pipeline/full-pipeline-contract.js";
import { readAuthoredCaptionStatus } from "../runtime/caption/authored-lyrics.js";
import { runEditorialCompile, runEditorialRender } from "./editorial-stages.js";

const [ROUGH_RENDER_ARTIFACT_PATH] = FULL_PIPELINE_CANONICAL_OUTPUTS;
const EDITORIAL_PIPELINE_STATUS_PATH = "06_review/editorial_pipeline_status.json";

export type EditorialPipelineEntrypoint = "editorial-pipeline" | "editorial-agent-task";
export type EditorialPipelinePreviewStatus = "available" | "skipped" | "missing";
export type EditorialPipelineQAStatus = "passed" | "failed" | "skipped";
export type EditorialPipelineTerminalStatus = "not_requested" | "blocked";

export interface EditorialPipelineStatusArtifact {
  version: "1";
  project_id: string;
  entrypoint: EditorialPipelineEntrypoint;
  created_at: string;
  preview: {
    status: EditorialPipelinePreviewStatus;
    artifact_path?: string;
    render_skipped: boolean;
  };
  qa: {
    status: EditorialPipelineQAStatus;
    stage: "QA";
    iterations?: number;
    fixes_applied_total?: number;
    initial_score?: number;
    final_score?: number;
    warnings_count?: number;
    visual_qa?: QALoopResult["visual_qa"];
    message?: string;
  };
  final_render: {
    status: EditorialPipelineTerminalStatus;
    reason?: string;
  };
  package: {
    status: EditorialPipelineTerminalStatus;
    reason?: string;
  };
  blocking_issues: Array<{
    code: "QA_LOOP_FAILED" | "QA_SKIPPED" | "QA_RENDER_MISSING";
    severity: "fatal";
    stage: "QA";
    message: string;
  }>;
}

export interface BuildEditorialPipelineStatusInput {
  projectId: string;
  entrypoint?: EditorialPipelineEntrypoint;
  createdAt: string;
  renderSkipped: boolean;
  roughRenderExists: boolean;
  qaStatus: EditorialPipelineQAStatus;
  qaMessage?: string;
  qaResult?: Pick<
    QALoopResult,
    "iterations" | "fixes_applied_total" | "initial_score" | "final_score" | "warnings"
  > & { visual_qa?: QALoopResult["visual_qa"] };
}

export interface EditorialDownstreamOptions {
  projectDir: string;
  brief: CreativeBrief;
  selects: SelectsCandidates;
  blueprint: EditBlueprint;
  entrypoint: EditorialPipelineEntrypoint;
  skipRender: boolean;
  qa?: boolean;
  skipQa?: boolean;
  logPrefix?: string;
  runStage?: <T>(stage: PipelineTimingStage, fn: () => Promise<T>) => Promise<T>;
  onFirstPreviewReady?: () => void;
  /** Preserve an already approved authored C1 projection for this run. */
  shouldSkipCompile?: () => boolean | Promise<boolean>;
  /** Gate immediately after compile and before any render/review consumer. */
  beforeRender?: () => Promise<void>;
}

export interface EditorialDownstreamDeps {
  runCompile?: (projectDir: string) => Promise<void>;
  runRender?: (projectDir: string) => Promise<void>;
  runQaLoop?: typeof runQALoop;
  roughRenderExists?: (projectDir: string) => boolean;
  loadQaEnvironment?: () => void;
  now?: () => Date;
}

export function buildEditorialPipelineStatus(
  input: BuildEditorialPipelineStatusInput,
): EditorialPipelineStatusArtifact {
  const previewStatus: EditorialPipelinePreviewStatus = input.renderSkipped
    ? "skipped"
    : input.roughRenderExists
      ? "available"
      : "missing";
  const blocking_issues: EditorialPipelineStatusArtifact["blocking_issues"] = [];

  if (input.qaStatus === "failed") {
    blocking_issues.push({
      code: "QA_LOOP_FAILED",
      severity: "fatal",
      stage: "QA",
      message: input.qaMessage ?? "QA loop failed; rough preview may exist but final/package output is blocked.",
    });
  } else if (input.qaStatus === "skipped") {
    blocking_issues.push({
      code: "QA_SKIPPED",
      severity: "fatal",
      stage: "QA",
      message: "QA loop was skipped; rough preview may exist but final/package output is blocked until QA runs.",
    });
  }

  if (!input.renderSkipped && !input.roughRenderExists) {
    blocking_issues.push({
      code: "QA_RENDER_MISSING",
      severity: "fatal",
      stage: "QA",
      message: "Rough render artifact is missing; final/package output is blocked until preview render is available.",
    });
  }

  const terminalBlocked = blocking_issues.length > 0;
  const firstBlockerCode = blocking_issues[0]?.code;

  return {
    version: "1",
    project_id: input.projectId,
    entrypoint: input.entrypoint ?? "editorial-pipeline",
    created_at: input.createdAt,
    preview: {
      status: previewStatus,
      ...(previewStatus === "available" ? { artifact_path: ROUGH_RENDER_ARTIFACT_PATH } : {}),
      render_skipped: input.renderSkipped,
    },
    qa: {
      status: input.qaStatus,
      stage: "QA",
      ...(input.qaResult ? {
        iterations: input.qaResult.iterations,
        fixes_applied_total: input.qaResult.fixes_applied_total,
        initial_score: input.qaResult.initial_score,
        final_score: input.qaResult.final_score,
        warnings_count: input.qaResult.warnings.length,
        ...(input.qaResult.visual_qa ? { visual_qa: input.qaResult.visual_qa } : {}),
      } : {}),
      ...(input.qaMessage ? { message: input.qaMessage } : {}),
    },
    final_render: {
      status: terminalBlocked ? "blocked" : "not_requested",
      ...(firstBlockerCode ? { reason: firstBlockerCode } : {}),
    },
    package: {
      status: terminalBlocked ? "blocked" : "not_requested",
      ...(firstBlockerCode ? { reason: firstBlockerCode } : {}),
    },
    blocking_issues,
  };
}

export async function runEditorialDownstream(
  options: EditorialDownstreamOptions,
  deps: EditorialDownstreamDeps = {},
): Promise<EditorialPipelineStatusArtifact> {
  const runStage = options.runStage ?? (async <T>(_stage: PipelineTimingStage, fn: () => Promise<T>) => fn());
  const logPrefix = options.logPrefix ?? "editorial";
  const initialAuthoredCaptionStatus = readAuthoredCaptionStatus(options.projectDir);
  const authoredCaptionRoute = initialAuthoredCaptionStatus.detected || options.blueprint.caption_policy?.source === "authored";

  const skipCompile = options.shouldSkipCompile
    ? await options.shouldSkipCompile()
    : authoredCaptionRoute && initialAuthoredCaptionStatus.status === "ready";
  if (skipCompile) {
    console.log(`[${logPrefix}] compile skipped; preserving current approved caption projection`);
  } else {
    await runStage("compile", async () => {
      console.log(`[${logPrefix}] compile`);
      await (deps.runCompile ?? runEditorialCompile)(options.projectDir);
    });
  }
  const compiledTimeline = JSON.parse(
    fs.readFileSync(path.join(options.projectDir, "05_timeline", "timeline.json"), "utf-8"),
  ) as TimelineIR;
  assertDeferredProductionDirectivesSatisfied(options.brief, options.blueprint, compiledTimeline);
  await options.beforeRender?.();
  if (authoredCaptionRoute) {
    const authoredCaptionStatus = readAuthoredCaptionStatus(options.projectDir);
    if (authoredCaptionStatus.status !== "ready") {
      throw new Error(
        `authored caption gate pending (${authoredCaptionStatus.status}); explicit human approval is required before render/review. Next: ${authoredCaptionStatus.next_command}`,
      );
    }
  }

  if (options.skipRender) {
    console.log(`[${logPrefix}] render skipped`);
  } else {
    await runStage("render", async () => {
      console.log(`[${logPrefix}] render`);
      await (deps.runRender ?? runEditorialRender)(options.projectDir);
    });
    options.onFirstPreviewReady?.();
  }

  if (options.skipQa === true || options.qa === false) {
    console.log(`[${logPrefix}] qa skipped`);
    return writeStatusForQA(options, deps, "skipped");
  }

  return runStage("QA", async () => {
    (deps.loadQaEnvironment ?? loadLocalEnvForMarlinQA)();
    console.log(`[${logPrefix}] qa improvement loop`);
    try {
      const timeline = JSON.parse(
        fs.readFileSync(path.join(options.projectDir, "05_timeline", "timeline.json"), "utf-8"),
      ) as TimelineIR;
      const loopResult = await (deps.runQaLoop ?? runQALoop)(
        options.projectDir,
        options.brief,
        options.selects,
        options.blueprint,
        timeline,
        {
          maxIterations: 3,
          skipRender: options.skipRender,
        },
      );
      console.log(
        `[${logPrefix}] QA loop: ${loopResult.iterations} iterations, ` +
        `${loopResult.fixes_applied_total} fixes, score ` +
        `${loopResult.initial_score.toFixed(2)} -> ${loopResult.final_score.toFixed(2)}`,
      );
      if (loopResult.warnings.length > 0) {
        console.warn(`[${logPrefix}] QA loop warnings: ${loopResult.warnings.length}`);
      }
      return writeStatusForQA(options, deps, "passed", { qaResult: loopResult });
    } catch (error) {
      const message = formatStageFailureMessage(
        options.entrypoint,
        options.projectDir,
        "QA",
        error,
      );
      const status = writeStatusForQA(options, deps, "failed", { message });
      console.warn(
        `[${logPrefix}] qa improvement loop failed; preview remains available if rendered: ${message}`,
      );
      return status;
    }
  });
}

function writeStatusForQA(
  options: EditorialDownstreamOptions,
  deps: EditorialDownstreamDeps,
  qaStatus: EditorialPipelineQAStatus,
  result: { message?: string; qaResult?: QALoopResult } = {},
): EditorialPipelineStatusArtifact {
  const roughRenderExists = deps.roughRenderExists
    ? deps.roughRenderExists(options.projectDir)
    : fs.existsSync(path.join(options.projectDir, ROUGH_RENDER_ARTIFACT_PATH));
  const status = buildEditorialPipelineStatus({
    projectId: projectIdFromBrief(options.brief, options.projectDir),
    entrypoint: options.entrypoint,
    createdAt: (deps.now?.() ?? new Date()).toISOString(),
    renderSkipped: options.skipRender,
    roughRenderExists,
    qaStatus,
    qaMessage: result.message,
    qaResult: result.qaResult,
  });
  validateArtifact(status, "editorial-pipeline-status.schema.json");
  writeJsonArtifact(options.projectDir, EDITORIAL_PIPELINE_STATUS_PATH, status);
  return status;
}

function loadLocalEnvForMarlinQA(): void {
  dotenvConfig({ path: ".env.local" });
  dotenvConfig();
}

function projectIdFromBrief(brief: CreativeBrief, projectDir: string): string {
  return brief.project_id || brief.project?.id || path.basename(projectDir);
}
