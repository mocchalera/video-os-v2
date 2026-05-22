#!/usr/bin/env npx tsx
import { config as dotenvConfig } from "dotenv";
dotenvConfig({ path: ".env.local" });
dotenvConfig();

import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import {
  createMarlinFnFromEnvironment,
  loadMarlinAssetInputs,
  marlinModelFromEnvironment,
  marlinQueriesFromEnvironment,
  runMarlinAnalysis,
} from "../runtime/pipeline/stages/marlin.js";

export interface MarlinEvaluateOptions {
  projectDir: string;
  repoRoot?: string;
  sourceFiles: string[];
  mock: boolean;
}

export interface MarlinEvaluateResult {
  outputPath: string;
  sourceCount: number;
  modelAlias: string;
  mock: boolean;
}

export function parseArgs(argv: string[]): MarlinEvaluateOptions {
  const args = argv.slice(2);
  const sourceFiles: string[] = [];
  let projectDir = "";
  let repoRoot: string | undefined;
  let mock = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--project" || arg === "-p") {
      projectDir = args[++index] ?? "";
    } else if (arg === "--repo-root") {
      repoRoot = args[++index] ?? undefined;
    } else if (arg === "--mock") {
      mock = true;
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else if (!arg.startsWith("-")) {
      sourceFiles.push(arg);
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  if (!projectDir) {
    throw new Error("--project <project-dir> is required");
  }

  return {
    projectDir,
    repoRoot,
    sourceFiles,
    mock,
  };
}

export async function runMarlinEvaluate(options: MarlinEvaluateOptions): Promise<MarlinEvaluateResult> {
  const projectDir = path.resolve(options.projectDir);
  const repoRoot = options.repoRoot ? path.resolve(options.repoRoot) : undefined;
  const sourceFiles = options.sourceFiles.map((source) =>
    path.isAbsolute(source) ? source : path.resolve(projectDir, source)
  );

  if (options.mock) {
    process.env.VOS_MARLIN_MOCK = "1";
  }

  const inputs = loadMarlinAssetInputs(projectDir, sourceFiles);
  if (inputs.length === 0) {
    throw new Error("No Marlin source inputs found. Pass source files or run analysis to create 03_analysis/assets.json.");
  }

  const missing = inputs.filter((input) => !fs.existsSync(input.sourcePath));
  if (missing.length > 0) {
    throw new Error(`Marlin source inputs are missing: ${missing.map((input) => input.sourcePath).join(", ")}`);
  }

  const model = marlinModelFromEnvironment(projectDir, repoRoot);
  const marlinFn = createMarlinFnFromEnvironment(projectDir, repoRoot);
  try {
    const outputPath = await runMarlinAnalysis({
      projectDir,
      projectId: path.basename(projectDir),
      sourceFiles,
      marlinFn,
      model,
      queries: marlinQueriesFromEnvironment(projectDir, repoRoot),
    });

    return {
      outputPath,
      sourceCount: inputs.length,
      modelAlias: model.model_alias,
      mock: options.mock,
    };
  } finally {
    await marlinFn.close?.();
  }
}

function printHelp(): void {
  console.log(`Usage: npx tsx scripts/marlin-evaluate.ts --project <project-dir> [source-files...]

Options:
  --project, -p  Project directory with existing 03_analysis artifacts
  --repo-root    Repository root for policy and worker resolution
  --mock         Use deterministic mock Marlin worker output
  --help, -h     Show this help

If source files are omitted, assets are resolved from 03_analysis/assets.json source_locator fields.
`);
}

const isMain = process.argv[1]
  ? import.meta.url === pathToFileURL(process.argv[1]).href
  : false;

if (isMain) {
  runMarlinEvaluate(parseArgs(process.argv))
    .then((result) => {
      console.log("[marlin-evaluate] complete");
      console.log(`  Output: ${result.outputPath}`);
      console.log(`  Sources: ${result.sourceCount}`);
      console.log(`  Model: ${result.modelAlias}`);
      console.log(`  Mock: ${result.mock}`);
    })
    .catch((error) => {
      console.error("[marlin-evaluate] failed:", error instanceof Error ? error.message : String(error));
      process.exit(1);
    });
}
