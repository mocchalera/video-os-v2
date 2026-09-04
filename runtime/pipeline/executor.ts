import * as fs from "node:fs";
import * as path from "node:path";
import {
  buildFootageDb,
  type BuildFootageDbOptions,
  type BuildFootageDbResult,
} from "../artifacts/footage-db-builder.js";
import {
  runAnalyze,
  type AnalyzeCommandOptions,
  type AnalyzeCommandResult,
} from "../commands/analyze.js";
import {
  formatStageFailureMessage,
  FIRST_PREVIEW_SLA_MS,
  estimateFirstPreviewStageBudget,
  PipelineStageProgressTracker,
  readFirstPreviewSlaCheckpoint,
  readSegmentCount,
  writeFirstPreviewSlaReceipt,
  type FirstPreviewSlaReceipt,
  type PipelineStageProgress,
  type PipelineTimingStage,
} from "../progress.js";
import {
  buildScriptFullPipelineTimingStages,
  shouldRunScriptAnalyze,
  shouldRunScriptFootageDb,
  type FullPipelineResumeStage,
} from "./plan.js";
import {
  discoverRequestedSources,
  type SourceDiscoveryOptions,
  type SourceDiscoveryResult,
} from "../media/source-discovery.js";
import {
  executePipelinePhases,
  type PipelinePhaseStep,
} from "./phase-executor.js";
import { readCoverageSummary } from "../artifacts/p1-manifest-coverage.js";
import { resolveEditorialStageTimeoutMs } from "../connectors/editorial-llm.js";
import { readProjectState } from "../state/reconcile.js";

export interface ProjectPipelineOptions {
  project: string;
  sourceDir?: string;
  contentHint?: string;
  from?: FullPipelineResumeStage;
  skipAnalyze: boolean;
  skipFootageDb: boolean;
  skipRender: boolean;
  skipQa: boolean;
  qwen3vlEnabled?: boolean;
  clapAudioEnabled?: boolean;
  /** Optional Issue #41 authored-caption inputs. */
  lyricsPath?: string;
  timingPlanPath?: string;
}

export interface InitProjectResult {
  projectDir: string;
}

export interface RunEditorialPipelineOptions {
  projectDir: string;
  skipFine: boolean;
  skipRender: boolean;
  qa?: boolean;
  skipQa?: boolean;
  stageProgress?: PipelineStageProgress;
  firstPreviewDeadlineAtMs?: number;
  firstPreviewCompileRenderReserveMs?: number;
  firstPreviewFineEstimateMs?: number;
  firstPreviewFineProviderBudgetMs?: number;
  now?: () => number;
  onFirstPreviewReady?: () => void;
  lyricsPath?: string;
  timingPlanPath?: string;
}

export interface ProjectPipelineDeps {
  initProject?: (projectId: string, options: { sourceDir: string }) => InitProjectResult;
  runAnalyze?: (projectDir: string, options: AnalyzeCommandOptions) => Promise<AnalyzeCommandResult>;
  buildFootageDb?: (options: BuildFootageDbOptions) => Promise<BuildFootageDbResult>;
  discoverSources?: (locators: string[]) => SourceDiscoveryResult;
  runEditorialPipeline: (options: RunEditorialPipelineOptions) => Promise<void>;
  now?: () => number;
}

export interface ProjectPipelineResult {
  success: boolean;
  projectDir: string;
  failedStage?: PipelineTimingStage;
  error?: unknown;
  message?: string;
  firstPreviewSla: FirstPreviewSlaReceipt;
}

type ProjectPipelinePhase = "analyze" | "footageDb" | "editorial";

export async function runProjectPipeline(
  options: ProjectPipelineOptions,
  deps: ProjectPipelineDeps,
): Promise<ProjectPipelineResult> {
  if ((options.lyricsPath && !options.timingPlanPath) || (!options.lyricsPath && options.timingPlanPath)) {
    throw new Error("--lyrics and --timing-plan must be supplied together");
  }
  const now = deps.now ?? Date.now;
  const invokedAtMs = now();
  const projectDir = ensureProject(options, deps);
  let firstPreviewSla = initializeFirstPreviewSla(projectDir, options, invokedAtMs);
  writeFirstPreviewSlaReceipt(projectDir, firstPreviewSla);
  const firstPreviewDeadlineAtMs = firstPreviewSla.deadline_at_ms;
  const stages = buildScriptFullPipelineTimingStages(options);
  const progress = new PipelineStageProgressTracker({
    projectDir,
    entrypoint: "full-pipeline",
    stages,
    segmentCount: readSegmentCount(projectDir),
    now,
  });
  let currentStage: PipelineTimingStage = stages[0] ?? "triage";

  try {
    const phaseSteps: Array<PipelinePhaseStep<ProjectPipelinePhase, never>> = [];

    if (shouldRunScriptAnalyze(options)) {
      phaseSteps.push({
        phase: "analyze",
        run: async () => {
          currentStage = "ingest";
          const sourceDirectory = options.sourceDir
            ? path.resolve(options.sourceDir)
            : path.join(projectDir, "02_media", "source");
          if (!fs.existsSync(sourceDirectory)) throw new Error(`Source directory not found: ${sourceDirectory}`);
          const sourceDiscovery = (deps.discoverSources ?? discoverRequestedSources)([sourceDirectory]);
          const sourceFiles = sourceDiscovery.requests.map((request) => request.lexical_path);
          const initialBudget = estimateFirstPreviewStageBudget(
            projectDir,
            readSegmentCount(projectDir) ?? sourceFiles.length,
            !options.skipRender,
          );
          const analyze = await (deps.runAnalyze ?? runAnalyze)(projectDir, {
            sourceFiles,
            sourceDiscovery,
            contentHint: options.contentHint,
            stageProgress: progress,
            firstPreviewDeadlineAtMs,
            firstPreviewCompileRenderReserveMs: initialBudget.compileRenderReserveMs,
          });
          if (!analyze.success) throw new Error(analyze.error?.message ?? "Analyze failed");
          const coverage = readCoverageSummary(projectDir);
          if (coverage) {
            if (coverage.status === "blocked") {
              throw new Error(
                `Analysis coverage is blocked: ${coverage.blockedLaneCount}/${coverage.requiredLaneCount} required lanes are not ready.`,
              );
            }
            const state = readProjectState(projectDir);
            if (state?.gates?.analysis_gate === "blocked") {
              throw new Error("Analysis gate is blocked in authoritative project state.");
            }
          }
          progress.refreshEstimates(readSegmentCount(projectDir));
        },
      });
    }

    if (shouldRunScriptFootageDb(options)) {
      phaseSteps.push({
        phase: "footageDb",
        run: async () => {
          currentStage = "embeddings";
          await progress.track("embeddings", () => (deps.buildFootageDb ?? buildFootageDb)({
            projectDir,
            embeddingPolicy: "auto",
            qwen3vlEnabled: options.qwen3vlEnabled,
            clapAudioEnabled: options.clapAudioEnabled,
          }));
        },
      });
    }

    phaseSteps.push({
      phase: "editorial",
      run: async () => {
        currentStage = "triage";
        const stageBudget = estimateFirstPreviewStageBudget(
          projectDir,
          readSegmentCount(projectDir) ?? 0,
          !options.skipRender,
        );
        const fineProviderBudgetMs = resolveEditorialStageTimeoutMs();
        const fineRequiredMs = Math.max(stageBudget.fineEstimateMs, fineProviderBudgetMs);
        const skipFineForBudget = now() + fineRequiredMs +
          stageBudget.compileRenderReserveMs > firstPreviewDeadlineAtMs;
        await deps.runEditorialPipeline({
          projectDir,
          skipFine: skipFineForBudget,
          skipRender: options.skipRender,
          qa: !options.skipQa,
          skipQa: options.skipQa,
          stageProgress: progress,
          firstPreviewDeadlineAtMs,
          firstPreviewCompileRenderReserveMs: stageBudget.compileRenderReserveMs,
          firstPreviewFineEstimateMs: stageBudget.fineEstimateMs,
          firstPreviewFineProviderBudgetMs: fineProviderBudgetMs,
          now,
          onFirstPreviewReady: () => {
            firstPreviewSla = finalizeFirstPreviewSla(projectDir, firstPreviewSla, now());
            writeFirstPreviewSlaReceipt(projectDir, firstPreviewSla);
          },
          ...(options.lyricsPath && options.timingPlanPath ? {
            lyricsPath: path.resolve(options.lyricsPath),
            timingPlanPath: path.resolve(options.timingPlanPath),
          } : {}),
        });
      },
    });

    await executePipelinePhases(phaseSteps);
    if (firstPreviewSla.status === "running") {
      firstPreviewSla = { ...firstPreviewSla, status: "hold", reason: "preview_missing" };
      writeFirstPreviewSlaReceipt(projectDir, firstPreviewSla);
    }
    progress.finish("completed");
    return { success: true, projectDir, firstPreviewSla };
  } catch (error) {
    if (firstPreviewSla.eligible) {
      firstPreviewSla = {
        ...firstPreviewSla,
        status: "hold",
        reason: "pipeline_failed",
        ended_at_ms: now(),
      };
      writeFirstPreviewSlaReceipt(projectDir, firstPreviewSla);
    } else if (firstPreviewSla.status === "not_eligible") {
      firstPreviewSla = { ...firstPreviewSla, ended_at_ms: now() };
      writeFirstPreviewSlaReceipt(projectDir, firstPreviewSla);
    }
    progress.finish("failed");
    return {
      success: false,
      projectDir,
      failedStage: currentStage,
      error,
      message: formatStageFailureMessage("full-pipeline", projectDir, currentStage, error),
      firstPreviewSla,
    };
  }
}

function initializeFirstPreviewSla(
  projectDir: string,
  options: ProjectPipelineOptions,
  invokedAtMs: number,
): FirstPreviewSlaReceipt {
  if (options.from) {
    const checkpoint = readFirstPreviewSlaCheckpoint(projectDir);
    if (checkpoint.kind === "valid" && checkpoint.receipt.eligible && checkpoint.receipt.status === "hold") {
      const {
        completed_at_ms: _completed,
        ended_at_ms: _ended,
        preview_artifact_path: _preview,
        reason: _reason,
        ...rest
      } = checkpoint.receipt;
      return { ...rest, status: "running" };
    }
    if (checkpoint.kind === "valid") return { ...checkpoint.receipt };
    return {
      version: 1,
      original_started_at_ms: invokedAtMs,
      deadline_at_ms: invokedAtMs + FIRST_PREVIEW_SLA_MS,
      eligible: false,
      status: "not_eligible",
      reason: checkpoint.kind === "invalid"
        ? "invalid_resume_checkpoint"
        : "legacy_resume_without_checkpoint",
    };
  }
  if (options.skipRender) {
    return {
      version: 1,
      original_started_at_ms: invokedAtMs,
      deadline_at_ms: invokedAtMs + FIRST_PREVIEW_SLA_MS,
      eligible: false,
      status: "not_eligible",
      reason: "render_skipped",
    };
  }
  return {
    version: 1,
    original_started_at_ms: invokedAtMs,
    deadline_at_ms: invokedAtMs + FIRST_PREVIEW_SLA_MS,
    eligible: true,
    status: "running",
  };
}

function finalizeFirstPreviewSla(
  projectDir: string,
  receipt: FirstPreviewSlaReceipt,
  completedAtMs: number,
): FirstPreviewSlaReceipt {
  if (!receipt.eligible || receipt.status !== "running") return receipt;
  if (!hasCanonicalReviewablePreview(projectDir)) {
    return {
      ...receipt,
      status: "hold",
      reason: "preview_missing",
    };
  }
  const preview_artifact_path = "09_output/rough-cut.mp4";
  return completedAtMs <= receipt.deadline_at_ms
    ? {
        ...receipt,
        status: "passed",
        completed_at_ms: completedAtMs,
        preview_artifact_path,
      }
    : {
        ...receipt,
        status: "missed",
        completed_at_ms: completedAtMs,
        preview_artifact_path,
        reason: "deadline_exceeded",
      };
}

function hasCanonicalReviewablePreview(projectDir: string): boolean {
  const previewPath = path.join(projectDir, "09_output", "rough-cut.mp4");
  const reportPath = path.join(projectDir, "09_output", "render-report.json");
  try {
    if (!fs.statSync(previewPath).isFile() || fs.statSync(previewPath).size <= 0) return false;
    const report = JSON.parse(fs.readFileSync(reportPath, "utf-8")) as Record<string, unknown>;
    return Number.isFinite(report.expected_rendered_sec) &&
      Number.isFinite(report.actual_rendered_sec) &&
      Number.isFinite(report.parity_delta_sec) &&
      report.parity_pass === true;
  } catch {
    return false;
  }
}

export function ensureProject(
  options: ProjectPipelineOptions,
  deps: Pick<ProjectPipelineDeps, "initProject">,
): string {
  const projectDir = resolveProjectDir(options.project);
  if (fs.existsSync(projectDir)) return projectDir;
  if (!options.sourceDir) {
    throw new Error(`Project not found: ${projectDir}. Pass --source-dir to create it.`);
  }
  if (!deps.initProject) {
    throw new Error("Project creation requires an initProject dependency.");
  }
  const projectId = path.basename(projectDir);
  return deps.initProject(projectId, { sourceDir: options.sourceDir }).projectDir;
}

export function resolveProjectDir(project: string): string {
  if (project.includes(path.sep) || project.startsWith(".")) return path.resolve(project);
  return path.resolve("projects", project);
}

export function collectSourceFiles(sourceDir: string): string[] {
  return collectSourceDiscovery(sourceDir).requests.map((request) => request.lexical_path);
}

export function collectSourceDiscovery(
  sourceDir: string,
  discoveryOptions?: SourceDiscoveryOptions,
): SourceDiscoveryResult {
  if (!fs.existsSync(sourceDir)) throw new Error(`Source directory not found: ${sourceDir}`);
  return discoverRequestedSources([sourceDir], discoveryOptions);
}
