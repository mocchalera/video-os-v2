#!/usr/bin/env npx tsx
import { config as dotenvConfig } from "dotenv";
dotenvConfig({ path: ".env.local" });
dotenvConfig();

import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { loadCreativeBrief } from "../runtime/artifacts/loaders.js";
import {
  defaultMarlinQAVideoPath,
  runMarlinQA,
  summarizeMarlinQAReport,
} from "../runtime/eval/marlin-qa.js";

const USAGE = "Usage: npx tsx scripts/marlin-qa.ts --project <dir> [--video <path>]";

export interface MarlinQACliArgs {
  projectDir: string;
  videoPath: string | null;
}

export function parseArgs(argv: string[] = process.argv): MarlinQACliArgs {
  const args = argv.slice(2);
  let projectDir = "";
  let videoPath: string | null = null;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--help" || arg === "-h") {
      throw new Error(USAGE);
    }
    if (arg === "--project" || arg === "-p") {
      projectDir = args[++index] ?? "";
      continue;
    }
    if (arg === "--video") {
      videoPath = args[++index] ?? "";
      continue;
    }
    if (!arg.startsWith("-") && !projectDir) {
      projectDir = arg;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}\n${USAGE}`);
  }

  if (!projectDir) {
    throw new Error(USAGE);
  }

  return { projectDir, videoPath };
}

export async function main(argv: string[] = process.argv): Promise<number> {
  let args: MarlinQACliArgs;
  try {
    args = parseArgs(argv);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }

  const projectDir = path.resolve(args.projectDir);
  const videoPath = args.videoPath
    ? path.isAbsolute(args.videoPath)
      ? args.videoPath
      : path.resolve(projectDir, args.videoPath)
    : defaultMarlinQAVideoPath(projectDir);
  const briefPath = path.join(projectDir, "01_intent", "creative_brief.yaml");
  let reportPath = "";

  try {
    const brief = loadCreativeBrief(briefPath);
    const report = await runMarlinQA(projectDir, videoPath, brief, {
      onReportPath: (writtenPath) => {
        reportPath = writtenPath;
      },
    });

    console.log("[marlin-qa] complete");
    console.log(`  Report: ${path.relative(process.cwd(), reportPath)}`);
    console.log(`  Video: ${path.relative(process.cwd(), videoPath)}`);
    for (const line of summarizeMarlinQAReport(report)) {
      console.log(`  ${line}`);
    }
    return 0;
  } catch (error) {
    console.error("[marlin-qa] failed:", error instanceof Error ? error.message : String(error));
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
