#!/usr/bin/env tsx
/**
 * Canonical two-pass editorial pipeline.
 *
 * Hybrid two-pass editorial pipeline.
 *
 *   npx tsx scripts/editorial-pipeline.ts --project <dir> [--skip-fine] [--skip-render] [--skip-qa]
 */

import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { runEditorialDownstream } from "./editorial-downstream.js";
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
import type {
  CreativeBrief,
  EditBlueprint,
  SelectsCandidates,
} from "../runtime/artifacts/types.js";
import { detectProjectBgm } from "../runtime/compiler/index.js";
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
import {
  loadEditorialPlanningContext,
  writeJsonArtifact,
  writeValidatedYamlArtifact,
} from "../runtime/pipeline/editorial-context.js";
import {
  readAssetMediaCapabilities,
} from "../runtime/artifacts/source-media-capabilities.js";

export { loadMarlinEvents } from "../runtime/pipeline/editorial-context.js";
export {
  buildEditorialPipelineStatus,
  type BuildEditorialPipelineStatusInput,
  type EditorialPipelineEntrypoint,
  type EditorialPipelinePreviewStatus,
  type EditorialPipelineQAStatus,
  type EditorialPipelineStatusArtifact,
  type EditorialPipelineTerminalStatus,
} from "./editorial-downstream.js";

const USAGE = "Usage: npx tsx scripts/editorial-pipeline.ts --project <dir> [--skip-fine] [--skip-render] [--qa] [--skip-qa]";

export interface EditorialPipelineArgs {
  projectDir: string;
  skipFine: boolean;
  skipRender: boolean;
  qa?: boolean;
  skipQa?: boolean;
  stageProgress?: PipelineStageProgress;
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

export async function runEditorialPipeline(args: EditorialPipelineArgs): Promise<void> {
  const {
    projectDir,
    brief,
    marlinEvents,
    segments,
    sourceMap,
  } = loadEditorialPlanningContext(args.projectDir);
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
        writeValidatedYamlArtifact(
          projectDir,
          "04_plan/selects_candidates.yaml",
          planned.selects,
          "selects-candidates.schema.json",
        );
        writeValidatedYamlArtifact(
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
      const sourceCapabilities = readAssetMediaCapabilities(projectDir);
      const hasVisualSource = segments.some((segment) =>
        sourceCapabilities.get(segment.asset_id)?.source_capabilities.has_video !== false
      );

      console.log(hasVisualSource
        ? "[editorial] extracting representative frames"
        : "[editorial] representative frames N/A (audio-only sources)");
      const representativeFrames = await extractRepresentativeFrames(
        projectDir,
        segments,
        marlinEvents,
        sourceMap,
      );

      const visualEvidence = hasVisualSource
        ? await runVisualRetrieval(projectDir, extractVisualQueries(brief), { limitPerQuery: 8 })
        : [];
      console.log(hasVisualSource ? "[editorial] visual retrieval" : "[editorial] visual retrieval N/A (audio-only sources)");

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
      writeValidatedYamlArtifact(
        projectDir,
        "04_plan/selects_candidates.yaml",
        planned.selects,
        "selects-candidates.schema.json",
      );
      writeValidatedYamlArtifact(
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
        writeValidatedYamlArtifact(
          projectDir,
          "04_plan/selects_candidates.yaml",
          selects,
          "selects-candidates.schema.json",
        );
        writeValidatedYamlArtifact(
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

    await runEditorialDownstream({
      projectDir,
      brief,
      selects,
      blueprint,
      entrypoint: "editorial-pipeline",
      skipRender: args.skipRender,
      qa: args.qa,
      skipQa: args.skipQa,
      runStage,
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
