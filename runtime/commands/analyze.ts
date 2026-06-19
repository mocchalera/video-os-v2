import { config as dotenvConfig } from "dotenv";
dotenvConfig({ path: ".env.local" });
dotenvConfig();

import * as fs from "node:fs";
import * as path from "node:path";
import {
  initCommand,
  isCommandError,
  reconcileAndPersist,
  type CommandError,
} from "./shared.js";
import { runPipeline } from "../pipeline/ingest.js";
import { createGeminiVlmFn } from "../connectors/gemini-vlm.js";
import type { MarlinFn } from "../connectors/marlin-types.js";
import { DEFAULT_VLM_CONCURRENCY } from "../pipeline/vlm-analysis.js";
import type { ProjectState } from "../state/reconcile.js";
import { ProgressTracker } from "../progress.js";
import { runPreflight } from "../preflight.js";
import {
  buildAnalysisCoverageReport,
  isP1ManifestCoverageEnabled,
  writeAnalysisCoverageReport,
  writeSourceMediaManifest,
} from "../artifacts/p1-manifest-coverage.js";
import {
  createMarlinFnFromEnvironment,
  marlinModelFromEnvironment,
  marlinQueriesFromEnvironment,
  MARLIN_EVENTS_RELATIVE_PATH,
  shouldRunMarlinAnalysis,
} from "../pipeline/stages/marlin.js";

export interface AnalyzeCommandOptions {
  sourceFiles: string[];
  skipStt?: boolean;
  skipVlm?: boolean;
  skipDiarize?: boolean;
  skipPeak?: boolean;
  skipMarlin?: boolean;
  skipMediaLink?: boolean;
  skipPreflight?: boolean;
  skipBgmAnalysis?: boolean;
  language?: string;
  sttProvider?: string;
  contentHint?: string;
  concurrency?: number;
  noCache?: boolean;
  clearCache?: boolean;
}

export interface AnalyzeRunnerContext extends AnalyzeCommandOptions {
  projectDir: string;
  projectId: string;
  currentState: ProjectState;
}

export interface AnalyzeRunnerResult {
  artifactsCreated?: string[];
}

export interface AnalyzeRunner {
  run(ctx: AnalyzeRunnerContext): Promise<AnalyzeRunnerResult | void>;
}

export interface AnalyzeCommandResult {
  success: boolean;
  error?: CommandError;
  previousState?: ProjectState;
  newState?: ProjectState;
  artifactsCreated?: string[];
  progressPath?: string;
}

const ANALYZE_ARTIFACT_CANDIDATES = [
  "03_analysis/assets.json",
  "03_analysis/segments.json",
  "03_analysis/gap_report.yaml",
  "03_analysis/bgm_analysis.json",
  MARLIN_EVENTS_RELATIVE_PATH,
];

export async function runAnalyze(
  projectDir: string,
  options: AnalyzeCommandOptions,
  runner: AnalyzeRunner = new DefaultAnalyzeRunner(),
): Promise<AnalyzeCommandResult> {
  const pt = new ProgressTracker(projectDir, "analysis", 3);
  const ctx = initCommand(projectDir, "/analyze", []);
  if (isCommandError(ctx)) {
    pt.fail("init", ctx.message);
    return { success: false, error: ctx };
  }
  pt.advance();

  if (!options.sourceFiles || options.sourceFiles.length === 0) {
    const error: CommandError = {
      code: "GATE_CHECK_FAILED",
      message: "Analyze phase requires at least one source file.",
    };
    pt.block("inputs", error.message);
    return { success: false, error };
  }

  if (!options.skipPreflight) {
    const preflight = runPreflight(path.dirname(path.resolve(options.sourceFiles[0])));
    if (!preflight.ok) {
    const error: CommandError = {
      code: "GATE_CHECK_FAILED",
      message: "Analyze preflight failed. Fix environment or re-run with skipPreflight.",
      details: preflight.checks,
    };
      pt.block("preflight", error.message);
      return { success: false, error };
    }
  }

  const previousState = ctx.doc.current_state;

  try {
    const runnerResult = await runner.run({
      ...options,
      projectDir: ctx.projectDir,
      projectId: ctx.doc.project_id || "",
      currentState: previousState,
      concurrency: options.concurrency ?? DEFAULT_VLM_CONCURRENCY,
    });
    const p1Artifacts: string[] = [];
    if (isP1ManifestCoverageEnabled()) {
      const projectId = ctx.doc.project_id || path.basename(ctx.projectDir);
      const manifest = writeSourceMediaManifest({
        projectDir: ctx.projectDir,
        projectId,
        sourceFiles: options.sourceFiles,
        producer: "analysis-ingest",
      });
      const coverage = buildAnalysisCoverageReport({
        projectId,
        manifest,
      });
      writeAnalysisCoverageReport(ctx.projectDir, coverage);
      p1Artifacts.push(
        "02_media/source_media_manifest.json",
        "03_analysis/analysis_coverage_report.json",
      );
    }
    pt.advance("03_analysis/assets.json");

    const reconcileResult = reconcileAndPersist(
      ctx.projectDir,
      "analyze-footage",
      "/analyze",
    );
    pt.advance("03_analysis/segments.json");
    const artifactsCreated = [
      ...(runnerResult?.artifactsCreated ?? collectExistingAnalyzeArtifacts(ctx.projectDir)),
      ...p1Artifacts,
    ];
    pt.complete(artifactsCreated);

    return {
      success: true,
      previousState,
      newState: reconcileResult.reconciled_state,
      artifactsCreated,
      progressPath: pt.filePath,
    };
  } catch (err) {
    const error: CommandError = {
      code: "VALIDATION_FAILED",
      message: `Analyze phase failed: ${err instanceof Error ? err.message : String(err)}`,
    };
    pt.fail("pipeline", error.message);
    return {
      success: false,
      error,
      previousState,
    };
  }
}

class DefaultAnalyzeRunner implements AnalyzeRunner {
  async run(ctx: AnalyzeRunnerContext): Promise<AnalyzeRunnerResult> {
    let vlmFn;
    if (!ctx.skipVlm && process.env.GEMINI_API_KEY) {
      vlmFn = createGeminiVlmFn();
    }

    let marlinFn: MarlinFn | undefined;
    if (!ctx.skipMarlin && shouldRunMarlinAnalysis(ctx.projectDir)) {
      marlinFn = createMarlinFnFromEnvironment(ctx.projectDir);
    }

    try {
      await runPipeline({
        sourceFiles: ctx.sourceFiles,
        projectDir: ctx.projectDir,
        skipStt: ctx.skipStt,
        skipVlm: ctx.skipVlm,
        skipDiarize: ctx.skipDiarize,
        skipPeak: ctx.skipPeak,
        skipMarlin: ctx.skipMarlin,
        vlmFn,
        marlinFn,
        marlinModel: marlinFn ? marlinModelFromEnvironment(ctx.projectDir) : undefined,
        marlinQueries: marlinFn ? marlinQueriesFromEnvironment(ctx.projectDir) : undefined,
        sttLanguageOverride: ctx.language,
        sttProvider: ctx.sttProvider,
        contentHint: ctx.contentHint,
        skipMediaLink: ctx.skipMediaLink,
        skipBgmAnalysis: ctx.skipBgmAnalysis,
        vlmConcurrency: ctx.concurrency ?? DEFAULT_VLM_CONCURRENCY,
        noCache: ctx.noCache,
        clearCache: ctx.clearCache,
      });
    } finally {
      await marlinFn?.close?.();
    }

    return {
      artifactsCreated: collectExistingAnalyzeArtifacts(ctx.projectDir),
    };
  }
}

function collectExistingAnalyzeArtifacts(projectDir: string): string[] {
  return ANALYZE_ARTIFACT_CANDIDATES.filter((relativePath) =>
    fs.existsSync(path.join(projectDir, relativePath))
  );
}
