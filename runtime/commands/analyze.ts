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
import { runPipeline, SourceReadinessError } from "../pipeline/ingest.js";
import { createGeminiVlmFn } from "../connectors/gemini-vlm.js";
import type { MarlinFn } from "../connectors/marlin-types.js";
import { DEFAULT_VLM_CONCURRENCY } from "../pipeline/vlm-analysis.js";
import type { ProjectState } from "../state/reconcile.js";
import { ProgressTracker, type PipelineStageProgress } from "../progress.js";
import { runPreflight } from "../preflight.js";
import {
  buildAnalysisCoverageReport,
  writeAnalysisCoverageReport,
  writeSourceMediaManifest,
} from "../artifacts/p1-manifest-coverage.js";
import {
  buildSourceLedger,
  writeSourceLedger,
  type SourceLedger,
} from "../artifacts/source-ledger.js";
import {
  discoverRequestedSources,
  normalizeSourceLocators,
  type SourceDiscoveryResult,
} from "../media/source-discovery.js";
import { atomicWriteJson, atomicWriteYaml } from "../pipeline/stages/_util.js";
import { buildGapReport } from "../pipeline/stages/gap-report.js";
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
  skipAppraiser?: boolean;
  skipMediaLink?: boolean;
  skipPreflight?: boolean;
  skipBgmAnalysis?: boolean;
  language?: string;
  sttProvider?: string;
  contentHint?: string;
  concurrency?: number;
  noCache?: boolean;
  clearCache?: boolean;
  stageProgress?: PipelineStageProgress;
  sourceDiscovery?: SourceDiscoveryResult;
}

export interface AnalyzeRunnerContext extends AnalyzeCommandOptions {
  projectDir: string;
  projectId: string;
  currentState: ProjectState;
}

export interface AnalyzeRunnerResult {
  artifactsCreated?: string[];
  sourceLedger?: SourceLedger;
}

export interface AnalyzeRunner {
  run(ctx: AnalyzeRunnerContext): Promise<AnalyzeRunnerResult>;
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
  const projectId = ctx.doc.project_id || path.basename(ctx.projectDir);
  const normalizedSourceFiles = normalizeSourceLocators(options.sourceFiles ?? [], process.cwd());

  if (normalizedSourceFiles.length === 0) {
    persistAnalyzeReadinessArtifacts(
      ctx.projectDir,
      projectId,
      discoverRequestedSources([]),
    );
    const error: CommandError = {
      code: "GATE_CHECK_FAILED",
      message: "Analyze phase requires at least one source file.",
    };
    pt.block("inputs", error.message);
    return { success: false, error };
  }

  let sourceDiscovery = options.sourceDiscovery;
  if (!options.skipPreflight) {
    const preflight = runPreflight(normalizedSourceFiles, sourceDiscovery);
    sourceDiscovery = preflight.discovery;
    if (!preflight.ok) {
      const failedChecks = preflight.checks.filter((check) => check.status === "fail");
      const ledger = persistAnalyzeReadinessArtifacts(
        ctx.projectDir,
        projectId,
        preflight.discovery,
        undefined,
        {
          stage: "preflight",
          reason: `preflight_failed:${failedChecks.map((check) => `${check.name}:${check.detail}`).join(" | ")}`,
        },
      );
      const error: CommandError = {
        code: "GATE_CHECK_FAILED",
        message: "Analyze preflight failed. Fix environment or re-run with skipPreflight.",
        details: {
          checks: preflight.checks,
          source_readiness: {
            summary: ledger.summary,
            items: ledger.items,
          },
        },
      };
      pt.block("preflight", error.message);
      return { success: false, error };
    }
  }
  sourceDiscovery ??= discoverRequestedSources(normalizedSourceFiles);

  const previousState = ctx.doc.current_state;

  try {
    const runnerResult = await runner.run({
      ...options,
      sourceFiles: normalizedSourceFiles,
      sourceDiscovery,
      projectDir: ctx.projectDir,
      projectId,
      currentState: previousState,
      concurrency: options.concurrency ?? DEFAULT_VLM_CONCURRENCY,
    });
    const p1Artifacts = [
      "03_analysis/source_ledger.json",
      "02_media/source_media_manifest.json",
      "03_analysis/analysis_coverage_report.json",
    ];
    if (!runnerResult.sourceLedger) {
      throw new Error("AnalyzeRunner must return the source ledger produced by the current run.");
    }
    if (runnerResult.sourceLedger.summary.requested === 0 || runnerResult.sourceLedger.summary.ready === 0) {
      throw new Error("AnalyzeRunner source ledger has no ready requested source.");
    }
    const requestedSourceIds = new Set(sourceDiscovery.requests.map((request) => request.source_id));
    if (
      runnerResult.sourceLedger.project_id !== projectId ||
      runnerResult.sourceLedger.items.length !== requestedSourceIds.size ||
      runnerResult.sourceLedger.items.some((item) => !requestedSourceIds.has(item.source_id))
    ) {
      throw new Error(
        "AnalyzeRunner source ledger does not match the current project and requested inputs: " +
        `project=${runnerResult.sourceLedger.project_id}, expected_project=${projectId}, ` +
        `source_ids=${runnerResult.sourceLedger.items.map((item) => item.source_id).join(",")}, ` +
        `expected_source_ids=${[...requestedSourceIds].join(",")}`,
      );
    }
    persistAnalyzeReadinessArtifacts(
      ctx.projectDir,
      projectId,
      sourceDiscovery,
      runnerResult.sourceLedger,
      undefined,
      true,
    );
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
    if (err instanceof SourceReadinessError) {
      const error: CommandError = {
        code: "GATE_CHECK_FAILED",
        message: err.message,
        details: {
          source_readiness: {
            summary: err.sourceLedger.summary,
            items: err.sourceLedger.items,
          },
        },
      };
      pt.block("source-readiness", error.message);
      return { success: false, error, previousState };
    }
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
      const result = await runPipeline({
        sourceFiles: ctx.sourceFiles,
        projectDir: ctx.projectDir,
        projectId: ctx.projectId,
        skipStt: ctx.skipStt,
        skipVlm: ctx.skipVlm,
        skipDiarize: ctx.skipDiarize,
        skipPeak: ctx.skipPeak,
        skipMarlin: ctx.skipMarlin,
        skipAppraiser: ctx.skipAppraiser,
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
        stageProgress: ctx.stageProgress,
        sourceDiscovery: ctx.sourceDiscovery,
      });
      return {
        artifactsCreated: collectExistingAnalyzeArtifacts(ctx.projectDir),
        sourceLedger: result.sourceLedger,
      };
    } finally {
      await marlinFn?.close?.();
    }
  }
}

export function persistAnalyzeReadinessArtifacts(
  projectDir: string,
  projectId: string,
  discovery: SourceDiscoveryResult,
  suppliedLedger?: SourceLedger,
  failureOverride?: { stage: string; reason: string },
  preserveExistingAnalysis = false,
): SourceLedger {
  const ledger = suppliedLedger ?? buildSourceLedger(projectId, discovery, new Map(), undefined, projectDir);
  if (failureOverride) {
    const candidateIds = new Set(discovery.requests
      .filter((request) => request.disposition === "candidate")
      .map((request) => request.source_id));
    for (const item of ledger.items) {
      if (!candidateIds.has(item.source_id) || item.status !== "failed") continue;
      item.stage = failureOverride.stage;
      item.reason = failureOverride.reason;
      item.consumer_impact = "planning_block";
    }
  }
  writeSourceLedger(projectDir, ledger);
  const assetsPath = path.join(projectDir, "03_analysis/assets.json");
  const existingAssets = fs.existsSync(assetsPath)
    ? (JSON.parse(fs.readFileSync(assetsPath, "utf-8")) as { items?: import("../connectors/ffprobe.js").AssetItem[] }).items ?? []
    : [];
  const manifest = writeSourceMediaManifest({ projectDir, projectId, ledger, assets: existingAssets, producer: "analysis-ingest" });
  const coverage = buildAnalysisCoverageReport({ projectId, manifest, ledger });
  writeAnalysisCoverageReport(projectDir, coverage);
  const analysisDir = path.join(projectDir, "03_analysis");
  fs.mkdirSync(analysisDir, { recursive: true });
  const segmentsPath = path.join(analysisDir, "segments.json");
  if (!preserveExistingAnalysis || !fs.existsSync(assetsPath)) {
    atomicWriteJson(assetsPath, { project_id: projectId, artifact_version: "2.0.0", items: [] });
  }
  if (!preserveExistingAnalysis || !fs.existsSync(segmentsPath)) {
    atomicWriteJson(segmentsPath, { project_id: projectId, artifact_version: "2.0.0", items: [] });
  }
  const gapPath = path.join(analysisDir, "gap_report.yaml");
  if (!preserveExistingAnalysis || !fs.existsSync(gapPath)) {
    atomicWriteYaml(
      gapPath,
      buildGapReport([], new Map(), new Map(), new Map(), undefined, undefined, undefined, ledger),
    );
  }
  return ledger;
}

function collectExistingAnalyzeArtifacts(projectDir: string): string[] {
  return ANALYZE_ARTIFACT_CANDIDATES.filter((relativePath) =>
    fs.existsSync(path.join(projectDir, relativePath))
  );
}
