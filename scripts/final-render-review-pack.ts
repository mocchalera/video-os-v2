#!/usr/bin/env npx tsx

import * as path from "node:path";
import { pathToFileURL } from "node:url";
import {
  buildFinalRenderReviewPack,
  inspectFinalRenderReviewPack,
  planFinalRenderReviewPack,
} from "../runtime/packaging/final-render-review-pack.js";

const USAGE = `Usage:
  npm run final-render-review-pack -- build --project <dir> --source <timeline-aligned base.mp4> [options]
  npm run final-render-review-pack -- plan --project <dir> [--sample-duration <seconds>] [--json]
  npm run final-render-review-pack -- status --project <dir> [--manifest <project-relative path>] [--json]

Build options:
  --sample-duration <seconds>   Per selected review window (default: 8, range: 2..30)
  --output-dir <path>           Must remain inside the project
  --json`;

interface Args {
  command: "build" | "plan" | "status";
  projectDir: string;
  sourcePath?: string;
  manifestPath?: string;
  outputDir?: string;
  sampleDurationSec?: number;
  json: boolean;
}

export function parseFinalRenderReviewPackArgs(argv: string[]): Args {
  const values = argv.slice(2);
  const command = values.shift();
  if (command !== "build" && command !== "plan" && command !== "status") throw new Error(USAGE);
  let projectDir: string | undefined;
  let sourcePath: string | undefined;
  let manifestPath: string | undefined;
  let outputDir: string | undefined;
  let sampleDurationSec: number | undefined;
  let json = false;
  for (let index = 0; index < values.length; index += 1) {
    const flag = values[index];
    if (flag === "--project") projectDir = required(values, ++index, flag);
    else if (flag === "--source") sourcePath = required(values, ++index, flag);
    else if (flag === "--manifest") manifestPath = required(values, ++index, flag);
    else if (flag === "--output-dir") outputDir = required(values, ++index, flag);
    else if (flag === "--sample-duration") {
      sampleDurationSec = Number(required(values, ++index, flag));
    } else if (flag === "--json") json = true;
    else if (flag === "--help" || flag === "-h") throw new Error(USAGE);
    else throw new Error(`unknown argument: ${flag}\n${USAGE}`);
  }
  if (!projectDir) throw new Error(`--project is required\n${USAGE}`);
  if (command === "build" && !sourcePath) throw new Error(`--source is required for build\n${USAGE}`);
  return {
    command,
    projectDir: path.resolve(projectDir),
    ...(sourcePath ? { sourcePath: path.resolve(sourcePath) } : {}),
    ...(manifestPath ? { manifestPath } : {}),
    ...(outputDir ? { outputDir: path.resolve(outputDir) } : {}),
    ...(sampleDurationSec !== undefined ? { sampleDurationSec } : {}),
    json,
  };
}

export async function runFinalRenderReviewPackCli(argv = process.argv): Promise<number> {
  if (argv.slice(2).some((value) => value === "--help" || value === "-h")) {
    console.log(USAGE);
    return 0;
  }
  try {
    const args = parseFinalRenderReviewPackArgs(argv);
    if (args.command === "status") {
      const result = inspectFinalRenderReviewPack(args.projectDir, args.manifestPath);
      console.log(args.json ? JSON.stringify(result, null, 2) : [
        `[final-render-review-pack] ${result.ready ? "ready" : "blocked"}`,
        `manifest: ${result.manifestPath}`,
        ...result.issues.map((issue) => `- ${issue}`),
      ].join("\n"));
      return result.ready ? 0 : 1;
    }
    if (args.command === "plan") {
      const plan = planFinalRenderReviewPack(
        args.projectDir,
        args.sampleDurationSec,
      );
      console.log(args.json ? JSON.stringify(plan, null, 2) : [
        "[final-render-review-pack] plan",
        `project: ${plan.project_id}`,
        `windows: ${plan.window_count}`,
        `review duration: ${plan.total_sample_duration_sec}s`,
        ...plan.windows.map((window, index) =>
          `${String(index + 1).padStart(2, "0")} ${window.start_sec.toFixed(3)}s +${window.duration_sec.toFixed(3)}s ${window.reasons.join(",")}`
        ),
      ].join("\n"));
      return 0;
    }
    const result = await buildFinalRenderReviewPack({
      projectDir: args.projectDir,
      sourcePath: args.sourcePath!,
      outputDir: args.outputDir,
      sampleDurationSec: args.sampleDurationSec,
    });
    console.log(args.json ? JSON.stringify(result, null, 2) : [
      `[final-render-review-pack] ${result.reused ? "reused" : "built"}`,
      `manifest: ${result.manifestPath}`,
      `samples: ${result.manifest.samples.length}`,
      `review duration: ${result.manifest.total_sample_duration_sec}s`,
    ].join("\n"));
    return 0;
  } catch (error) {
    console.error(`[final-render-review-pack] ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

function required(values: string[], index: number, flag: string): string {
  const value = values[index];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

const isMain = process.argv[1]
  ? import.meta.url === pathToFileURL(process.argv[1]).href
  : false;
if (isMain) {
  runFinalRenderReviewPackCli().then((code) => { process.exitCode = code; });
}
