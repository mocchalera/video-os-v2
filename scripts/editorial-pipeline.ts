#!/usr/bin/env tsx
/**
 * Canonical two-pass editorial pipeline.
 *
 * Hybrid two-pass editorial pipeline.
 *
 *   npx tsx scripts/editorial-pipeline.ts --project <dir> [--skip-fine] [--skip-render] [--skip-qa]
 */

import { config as dotenvConfig } from "dotenv";
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { stringify as stringifyYaml } from "yaml";
import { runCompileTimeline } from "./compile-timeline.js";
import { renderRoughCut } from "./render-rough-cut.js";
import {
  fineCutRefinement,
  roughCutPlanning,
} from "../runtime/agents/unified-editorial-agent.js";
import {
  buildLongformBlueprint,
  buildLongformSelectsFromProject,
  isLongformEventBrief,
  type LongformPlanningResult,
} from "../runtime/editorial/longform-event.js";
import {
  buildSelectedLinkage,
  buildVisualRetrievalTrace,
  extractAudioQueries,
  extractVisualQueries,
  runAudioRetrieval,
  runVisualRetrieval,
} from "../runtime/agents/visual-retrieval-evidence.js";
import { loadCreativeBrief, validateArtifact } from "../runtime/artifacts/loaders.js";
import type {
  CreativeBrief,
  EditBlueprint,
  SelectsCandidates,
  TimelineIR,
} from "../runtime/artifacts/types.js";
import type { SegmentItem } from "../runtime/connectors/ffmpeg-segmenter.js";
import type { MarlinEventsArtifact } from "../runtime/connectors/marlin-types.js";
import { detectProjectBgm } from "../runtime/compiler/index.js";
import { loadSourceMap } from "../runtime/media/source-map.js";
import { runQALoop, type QALoopResult } from "../runtime/eval/qa-loop.js";
import {
  formatStageFailureMessage,
  PipelineStageProgressTracker,
  readSegmentCount,
  type PipelineStageProgress,
  type PipelineTimingStage,
} from "../runtime/progress.js";
import {
  extractCraftKeyFrames,
  extractRepresentativeFrames,
} from "../runtime/pipeline/stages/craft-frames.js";
import { buildEditorialPipelineTimingStages } from "../runtime/pipeline/plan.js";

const USAGE = "Usage: npx tsx scripts/editorial-pipeline.ts --project <dir> [--skip-fine] [--skip-render] [--qa] [--skip-qa]";
const ROUGH_RENDER_ARTIFACT_PATH = "09_output/rough-cut.mp4";
const EDITORIAL_PIPELINE_STATUS_PATH = "06_review/editorial_pipeline_status.json";

export interface EditorialPipelineArgs {
  projectDir: string;
  skipFine: boolean;
  skipRender: boolean;
  qa?: boolean;
  skipQa?: boolean;
  stageProgress?: PipelineStageProgress;
}

interface SegmentsDoc {
  items?: SegmentItem[];
}

export type EditorialPipelinePreviewStatus = "available" | "skipped" | "missing";
export type EditorialPipelineQAStatus = "passed" | "failed" | "skipped";
export type EditorialPipelineTerminalStatus = "not_requested" | "blocked";

export interface EditorialPipelineStatusArtifact {
  version: "1";
  project_id: string;
  entrypoint: "editorial-pipeline";
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
  createdAt: string;
  renderSkipped: boolean;
  roughRenderExists: boolean;
  qaStatus: EditorialPipelineQAStatus;
  qaMessage?: string;
  qaResult?: Pick<
    QALoopResult,
    "iterations" | "fixes_applied_total" | "initial_score" | "final_score" | "warnings"
  >;
}

export function parseArgs(argv: string[] = process.argv): EditorialPipelineArgs {
  const args = argv.slice(2);
  let projectDir: string | undefined;
  let skipFine = false;
  let skipRender = false;
  let qa = true;
  let skipQa = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--help" || arg === "-h") {
      throw new Error(USAGE);
    }
    if (arg === "--project" && index + 1 < args.length) {
      projectDir = args[++index];
      continue;
    }
    if (arg === "--skip-fine") {
      skipFine = true;
      continue;
    }
    if (arg === "--skip-render") {
      skipRender = true;
      continue;
    }
    if (arg === "--qa") {
      qa = true;
      skipQa = false;
      continue;
    }
    if (arg === "--skip-qa") {
      qa = false;
      skipQa = true;
      continue;
    }
    if (arg.startsWith("--")) {
      throw new Error(`Unknown argument: ${arg}`);
    }
    if (!projectDir) {
      projectDir = arg;
      continue;
    }
    throw new Error(`Unexpected extra argument: ${arg}`);
  }

  if (!projectDir) throw new Error(USAGE);
  return {
    projectDir: path.resolve(projectDir),
    skipFine,
    skipRender,
    qa,
    skipQa,
  };
}

function readJson<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, "utf-8")) as T;
}

function loadSegments(projectDir: string): SegmentItem[] {
  const filePath = path.join(projectDir, "03_analysis", "segments.json");
  if (!fs.existsSync(filePath)) throw new Error(`segments.json not found: ${filePath}`);
  const doc = readJson<SegmentsDoc>(filePath);
  if (!Array.isArray(doc.items)) throw new Error(`segments.json must contain an items array: ${filePath}`);
  return doc.items;
}

export function loadMarlinEvents(projectDir: string): MarlinEventsArtifact {
  const filePath = path.join(projectDir, "03_analysis", "marlin_events.json");
  if (!fs.existsSync(filePath)) {
    console.warn(`[editorial] optional Marlin evidence missing; continuing text-first: ${filePath}`);
    return {
      project_id: path.basename(projectDir),
      artifact_version: "1.0.0",
      model: {
        provider: "marlin",
        model_alias: "optional-unavailable",
        model_snapshot: "not-generated",
      },
      items: [],
    };
  }
  return readJson<MarlinEventsArtifact>(filePath);
}

function writeYamlArtifact(
  projectDir: string,
  relativePath: string,
  data: unknown,
  schemaFile: string,
): void {
  validateArtifact(data, schemaFile);
  const filePath = path.join(projectDir, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, stringifyYaml(data), "utf-8");
  fs.renameSync(tmp, filePath);
}

function writeJsonArtifact(projectDir: string, relativePath: string, data: unknown): void {
  const filePath = path.join(projectDir, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, "utf-8");
  fs.renameSync(tmp, filePath);
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
    entrypoint: "editorial-pipeline",
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

function writeEditorialPipelineStatus(
  projectDir: string,
  status: EditorialPipelineStatusArtifact,
): void {
  validateArtifact(status, "editorial-pipeline-status.schema.json");
  writeJsonArtifact(projectDir, EDITORIAL_PIPELINE_STATUS_PATH, status);
}

function writeEditorialPipelineStatusForQA(
  projectDir: string,
  brief: CreativeBrief,
  qaStatus: EditorialPipelineQAStatus,
  args: EditorialPipelineArgs,
  options: {
    message?: string;
    qaResult?: QALoopResult;
  } = {},
): void {
  writeEditorialPipelineStatus(
    projectDir,
    buildEditorialPipelineStatus({
      projectId: projectIdFromBrief(brief, projectDir),
      createdAt: new Date().toISOString(),
      renderSkipped: args.skipRender,
      roughRenderExists: fs.existsSync(path.join(projectDir, ROUGH_RENDER_ARTIFACT_PATH)),
      qaStatus,
      qaMessage: options.message,
      qaResult: options.qaResult,
    }),
  );
}

function projectIdFromBrief(brief: CreativeBrief, projectDir: string): string {
  return brief.project_id || brief.project?.id || path.basename(projectDir);
}

export function buildLongformEditorialPass(
  projectDir: string,
  brief: CreativeBrief,
): LongformPlanningResult & { blueprint: EditBlueprint } {
  const planned = buildLongformSelectsFromProject(projectDir, brief);
  if (planned.plan.coverage_status !== "ready") {
    throw new Error(
      `longform-event coverage cannot satisfy target duration: ` +
      `${(planned.plan.selected_duration_us / 1_000_000).toFixed(1)}s selected for ` +
      `${(planned.plan.target_duration_us / 1_000_000).toFixed(1)}s target`,
    );
  }
  return {
    ...planned,
    blueprint: buildLongformBlueprint(
      projectIdFromBrief(brief, projectDir),
      brief,
      planned.selects,
    ),
  };
}

async function runCompile(projectDir: string): Promise<void> {
  await runCompileTimeline({
    projectPath: projectDir,
    skipPreview: true,
    skipConfirmations: true,
  });
}

async function runRender(projectDir: string): Promise<void> {
  await renderRoughCut({
    projectPath: projectDir,
    noAudio: false,
  });
}

function loadLocalEnvForMarlinQA(): void {
  dotenvConfig({ path: ".env.local" });
  dotenvConfig();
}

export async function runEditorialPipeline(args: EditorialPipelineArgs): Promise<void> {
  const projectDir = path.resolve(args.projectDir);
  const briefPath = path.join(projectDir, "01_intent", "creative_brief.yaml");
  const brief: CreativeBrief = loadCreativeBrief(briefPath);
  const marlinEvents = loadMarlinEvents(projectDir);
  const segments = loadSegments(projectDir);
  const sourceMap = loadSourceMap(projectDir).entryMap;
  const ownProgress = args.stageProgress ? null : new PipelineStageProgressTracker({
    projectDir,
    entrypoint: "editorial-pipeline",
    stages: buildEditorialPipelineTimingStages(args),
    segmentCount: readSegmentCount(projectDir) ?? segments.length,
  });
  const progress = args.stageProgress ?? ownProgress;
  let currentStage: PipelineTimingStage | "startup" = "startup";

  const runStage = async <T>(stage: PipelineTimingStage, fn: () => Promise<T>): Promise<T> => {
    currentStage = stage;
    return progress ? progress.track(stage, fn) : fn();
  };

  try {
    const rough = await runStage("triage", async () => {
      if (isLongformEventBrief(brief)) {
        console.log("[editorial] longform transcript reduction");
        const planned = buildLongformEditorialPass(projectDir, brief);
        writeJsonArtifact(
          projectDir,
          "04_plan/visual_search_trace.json",
          buildVisualRetrievalTrace(
            projectIdFromBrief(brief, projectDir),
            [],
            new Date().toISOString(),
            [],
          ),
        );
        writeYamlArtifact(
          projectDir,
          "04_plan/selects_candidates.yaml",
          planned.selects,
          "selects-candidates.schema.json",
        );
        writeYamlArtifact(
          projectDir,
          "04_plan/edit_blueprint.yaml",
          planned.blueprint,
          "edit-blueprint.schema.json",
        );
        console.log(
          `[editorial] longform ready: ${planned.selects.candidates.length} windows, ` +
          `${planned.plan.chapters.length} chapters, ` +
          `${(planned.plan.selected_duration_us / 60_000_000).toFixed(1)} min`,
        );
        return { selects: planned.selects, blueprint: planned.blueprint, bgmDurationSec: null };
      }

      const bgm = await detectProjectBgm(projectDir, (message) => console.warn(message));
      const bgmDurationSec = bgm ? bgm.durationUs / 1_000_000 : null;

      console.log("[editorial] extracting representative frames");
      const representativeFrames = await extractRepresentativeFrames(
        projectDir,
        segments,
        marlinEvents,
        sourceMap,
      );

      console.log("[editorial] visual retrieval");
      const visualEvidence = await runVisualRetrieval(projectDir, extractVisualQueries(brief), {
        limitPerQuery: 8,
      });

      console.log("[editorial] audio retrieval");
      const audioEvidence = await runAudioRetrieval(projectDir, extractAudioQueries(brief), {
        limitPerQuery: 5,
      });

      console.log("[editorial] rough pass");
      const planned = await roughCutPlanning(
        brief,
        marlinEvents,
        representativeFrames,
        segments,
        bgmDurationSec,
        { mode: "headless", projectDir, visualEvidence, audioEvidence },
      );
      writeJsonArtifact(
        projectDir,
        "04_plan/visual_search_trace.json",
        buildVisualRetrievalTrace(
          projectIdFromBrief(brief, projectDir),
          [...visualEvidence, ...audioEvidence],
          new Date().toISOString(),
          buildSelectedLinkage(planned.selects, visualEvidence),
        ),
      );
      writeYamlArtifact(
        projectDir,
        "04_plan/selects_candidates.yaml",
        planned.selects,
        "selects-candidates.schema.json",
      );
      writeYamlArtifact(
        projectDir,
        "04_plan/edit_blueprint.yaml",
        planned.blueprint,
        "edit-blueprint.schema.json",
      );
      return { ...planned, bgmDurationSec };
    });

    let selects: SelectsCandidates = rough.selects;
    let blueprint: EditBlueprint = rough.blueprint;
    if (!args.skipFine && !isLongformEventBrief(brief)) {
      blueprint = await runStage("blueprint", async () => {
        console.log("[editorial] extracting fine-cut key frames");
        const keyFrames = await extractCraftKeyFrames(
          projectDir,
          selects.candidates,
          marlinEvents,
          sourceMap,
        );

        console.log("[editorial] fine pass");
        const refinedBlueprint = await fineCutRefinement(
          brief,
          selects,
          blueprint,
          marlinEvents,
          keyFrames,
          rough.bgmDurationSec,
        );
        writeYamlArtifact(
          projectDir,
          "04_plan/selects_candidates.yaml",
          selects,
          "selects-candidates.schema.json",
        );
        writeYamlArtifact(
          projectDir,
          "04_plan/edit_blueprint.yaml",
          refinedBlueprint,
          "edit-blueprint.schema.json",
        );
        return refinedBlueprint;
      });
    } else {
      await runStage("blueprint", async () => {
        console.log(isLongformEventBrief(brief)
          ? "[editorial] longform deterministic blueprint ready"
          : "[editorial] fine pass skipped");
      });
    }

    await runStage("compile", async () => {
      console.log("[editorial] compile");
      await runCompile(projectDir);
    });

    if (args.skipRender) {
      console.log("[editorial] render skipped");
    } else {
      await runStage("render", async () => {
        console.log("[editorial] render");
        await runRender(projectDir);
      });
    }

    if (args.skipQa === true || args.qa === false) {
      console.log("[editorial] qa skipped");
      writeEditorialPipelineStatusForQA(projectDir, brief, "skipped", args);
      ownProgress?.finish("completed");
      return;
    }

    await runStage("QA", async () => {
      loadLocalEnvForMarlinQA();
      console.log("[editorial] qa improvement loop");
      try {
        const timeline = readJson<TimelineIR>(path.join(projectDir, "05_timeline", "timeline.json"));
        const loopResult = await runQALoop(
          projectDir,
          brief,
          selects,
          blueprint,
          timeline,
          {
            maxIterations: 3,
            skipRender: args.skipRender,
          },
        );
        console.log(
          `[editorial] QA loop: ${loopResult.iterations} iterations, ${loopResult.fixes_applied_total} fixes, score ${loopResult.initial_score.toFixed(2)} -> ${loopResult.final_score.toFixed(2)}`,
        );
        if (loopResult.warnings.length > 0) {
          console.warn(`[editorial] QA loop warnings: ${loopResult.warnings.length}`);
        }
        writeEditorialPipelineStatusForQA(projectDir, brief, "passed", args, {
          qaResult: loopResult,
        });
      } catch (error) {
        const message = formatStageFailureMessage("editorial-pipeline", projectDir, "QA", error);
        writeEditorialPipelineStatusForQA(projectDir, brief, "failed", args, { message });
        console.warn(`[editorial] qa improvement loop failed; preview remains available if rendered: ${message}`);
      }
    });
    ownProgress?.finish("completed");
  } catch (error) {
    ownProgress?.finish("failed");
    throw new Error(formatStageFailureMessage("editorial-pipeline", projectDir, currentStage, error));
  }
}

export async function main(argv: string[] = process.argv): Promise<number> {
  let args: EditorialPipelineArgs;
  try {
    args = parseArgs(argv);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }

  try {
    await runEditorialPipeline(args);
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

const isDirectRun =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  main().then((code) => {
    process.exitCode = code;
  }).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
