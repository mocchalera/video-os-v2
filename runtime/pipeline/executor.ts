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
  discoverSources?: (locators: string[]) => SourceDiscoveryResult;
  runEditorialPipeline: (options: RunEditorialPipelineOptions) => Promise<void>;
}

export interface ProjectPipelineResult {
  success: boolean;
  projectDir: string;
  failedStage?: PipelineTimingStage;
  error?: unknown;
  message?: string;
}

type ProjectPipelinePhase = "analyze" | "footageDb" | "editorial";

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
          const analyze = await (deps.runAnalyze ?? runAnalyze)(projectDir, {
            sourceFiles,
            sourceDiscovery,
            contentHint: options.contentHint,
            stageProgress: progress,
          });
          if (!analyze.success) throw new Error(analyze.error?.message ?? "Analyze failed");
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
        await deps.runEditorialPipeline({
          projectDir,
          skipFine: false,
          skipRender: options.skipRender,
          qa: !options.skipQa,
          skipQa: options.skipQa,
          stageProgress: progress,
        });
      },
    });

    await executePipelinePhases(phaseSteps);
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
  return collectSourceDiscovery(sourceDir).requests.map((request) => request.lexical_path);
}

export function collectSourceDiscovery(
  sourceDir: string,
  discoveryOptions?: SourceDiscoveryOptions,
): SourceDiscoveryResult {
  if (!fs.existsSync(sourceDir)) throw new Error(`Source directory not found: ${sourceDir}`);
  return discoverRequestedSources([sourceDir], discoveryOptions);
}
