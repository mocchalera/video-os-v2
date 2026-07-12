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
  PipelineStageProgressTracker,
  readSegmentCount,
  type PipelineStageProgress,
  type PipelineTimingStage,
} from "../progress.js";
import {
  buildScriptFullPipelineTimingStages,
  shouldRunScriptAnalyze,
  shouldRunScriptFootageDb,
} from "./plan.js";

export interface ProjectPipelineOptions {
  project: string;
  sourceDir?: string;
  contentHint?: string;
  from?: PipelineTimingStage;
  skipAnalyze: boolean;
  skipFootageDb: boolean;
  skipRender: boolean;
  skipQa: boolean;
  qwen3vlEnabled?: boolean;
  clapAudioEnabled?: boolean;
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
}

export interface ProjectPipelineDeps {
  initProject?: (projectId: string, options: { sourceDir: string }) => InitProjectResult;
  runAnalyze?: (projectDir: string, options: AnalyzeCommandOptions) => Promise<AnalyzeCommandResult>;
  buildFootageDb?: (options: BuildFootageDbOptions) => Promise<BuildFootageDbResult>;
  runEditorialPipeline: (options: RunEditorialPipelineOptions) => Promise<void>;
}

export interface ProjectPipelineResult {
  success: boolean;
  projectDir: string;
  failedStage?: PipelineTimingStage;
  error?: unknown;
  message?: string;
}

export async function runProjectPipeline(
  options: ProjectPipelineOptions,
  deps: ProjectPipelineDeps,
): Promise<ProjectPipelineResult> {
  const projectDir = ensureProject(options, deps);
  const stages = buildScriptFullPipelineTimingStages(options);
  const progress = new PipelineStageProgressTracker({
    projectDir,
    entrypoint: "full-pipeline",
    stages,
    segmentCount: readSegmentCount(projectDir),
  });
  let currentStage: PipelineTimingStage = stages[0] ?? "triage";

  try {
    if (shouldRunScriptAnalyze(options)) {
      currentStage = "ingest";
      const sourceFiles = collectSourceFiles(
        options.sourceDir ? path.resolve(options.sourceDir) : path.join(projectDir, "02_media", "source"),
      );
      const analyze = await (deps.runAnalyze ?? runAnalyze)(projectDir, {
        sourceFiles,
        contentHint: options.contentHint,
        stageProgress: progress,
      });
      if (!analyze.success) throw new Error(analyze.error?.message ?? "Analyze failed");
      progress.refreshEstimates(readSegmentCount(projectDir));
    }

    if (shouldRunScriptFootageDb(options)) {
      currentStage = "embeddings";
      await progress.track("embeddings", () => (deps.buildFootageDb ?? buildFootageDb)({
        projectDir,
        embeddingPolicy: "auto",
        qwen3vlEnabled: options.qwen3vlEnabled,
        clapAudioEnabled: options.clapAudioEnabled,
      }));
    }

    currentStage = "triage";
    await deps.runEditorialPipeline({
      projectDir,
      skipFine: false,
      skipRender: options.skipRender,
      qa: !options.skipQa,
      skipQa: options.skipQa,
      stageProgress: progress,
    });

    progress.finish("completed");
    return { success: true, projectDir };
  } catch (error) {
    progress.finish("failed");
    return {
      success: false,
      projectDir,
      failedStage: currentStage,
      error,
      message: formatStageFailureMessage("full-pipeline", projectDir, currentStage, error),
    };
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
  if (!fs.existsSync(sourceDir)) throw new Error(`Source directory not found: ${sourceDir}`);
  const files = fs.readdirSync(sourceDir)
    .map((entry) => path.join(sourceDir, entry))
    .filter((filePath) => fs.statSync(filePath).isFile())
    .filter((filePath) => /\.(mp4|mov|m4v|avi|mkv|webm)$/i.test(filePath));
  if (files.length === 0) throw new Error(`No source video files found in ${sourceDir}`);
  return files;
}
