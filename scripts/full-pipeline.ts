#!/usr/bin/env tsx
/**
 * Official single-command project pipeline.
 *
 * This keeps the historical manual chain intact:
 *   analyze -> build-footage-db -> editorial-pipeline
 */

import { pathToFileURL } from "node:url";
import type { PipelineTimingStage } from "../runtime/progress.js";
import {
  FULL_PIPELINE_TIMING_STAGE_ORDER,
  isFullPipelineTimingStage,
} from "../runtime/pipeline/plan.js";
import { runProjectPipeline, type ProjectPipelineOptions } from "../runtime/pipeline/executor.js";
import { initProject } from "./init-project.js";
import { runEditorialPipeline } from "./editorial-pipeline.js";

const USAGE = `Usage: npm run full-pipeline -- --project <project-id|project-dir> [options]

Options:
  --source-dir <path>       Source footage directory. Required when creating a new project.
  --content-hint <text>     Context hint for VLM analysis.
  --from <stage>            Resume hint: ingest|stt|marlin|visual-quality|peak|embeddings|triage|blueprint|compile|render|QA.
  --skip-analyze            Start from existing 03_analysis artifacts.
  --skip-footage-db         Skip 03_analysis/search/footage.db rebuild.
  --skip-render             Run planning/compile but do not render rough-cut.mp4.
  --skip-qa                 Skip QA improvement loop.
  --no-qwen3vl              Disable Qwen3-VL embeddings.
  --no-clap-audio           Disable CLAP audio embeddings.
`;

export function parseArgs(argv: string[]): ProjectPipelineOptions {
  const args = argv.slice(2);
  let project = "";
  let sourceDir: string | undefined;
  let contentHint: string | undefined;
  let from: PipelineTimingStage | undefined;
  let skipAnalyze = false;
  let skipFootageDb = false;
  let skipRender = false;
  let skipQa = false;
  let qwen3vlEnabled: boolean | undefined;
  let clapAudioEnabled: boolean | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const value = args[index + 1];
    if (arg === "--help" || arg === "-h") throw new Error(USAGE);
    if (arg === "--project") {
      project = value ?? "";
      index += 1;
      continue;
    }
    if (arg === "--source-dir") {
      sourceDir = value;
      index += 1;
      continue;
    }
    if (arg === "--content-hint") {
      contentHint = value;
      index += 1;
      continue;
    }
    if (arg === "--from") {
      if (!isFullPipelineTimingStage(value)) throw new Error(`--from must be one of: ${FULL_PIPELINE_TIMING_STAGE_ORDER.join(", ")}`);
      from = value;
      index += 1;
      continue;
    }
    if (arg === "--skip-analyze") {
      skipAnalyze = true;
      continue;
    }
    if (arg === "--skip-footage-db") {
      skipFootageDb = true;
      continue;
    }
    if (arg === "--skip-render") {
      skipRender = true;
      continue;
    }
    if (arg === "--skip-qa") {
      skipQa = true;
      continue;
    }
    if (arg === "--no-qwen3vl") {
      qwen3vlEnabled = false;
      continue;
    }
    if (arg === "--no-clap-audio") {
      clapAudioEnabled = false;
      continue;
    }
    if (arg.startsWith("--")) throw new Error(`Unknown argument: ${arg}`);
    if (!project) {
      project = arg;
      continue;
    }
    throw new Error(`Unexpected extra argument: ${arg}`);
  }

  if (!project) throw new Error(USAGE);
  return {
    project,
    sourceDir,
    contentHint,
    from,
    skipAnalyze,
    skipFootageDb,
    skipRender,
    skipQa,
    qwen3vlEnabled,
    clapAudioEnabled,
  };
}

export async function main(argv: string[] = process.argv): Promise<number> {
  let args: ProjectPipelineOptions;
  try {
    args = parseArgs(argv);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }

  try {
    const result = await runProjectPipeline(args, {
      initProject,
      runEditorialPipeline,
    });
    if (result.success) return 0;
    console.error(result.message ?? "full-pipeline failed");
    return 1;
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
