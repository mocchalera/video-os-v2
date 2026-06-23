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
  MARLIN_EVENTS_RELATIVE_PATH,
  marlinModelFromEnvironment,
  marlinQueriesFromEnvironment,
  runMarlinAnalysis,
  selectMarlinAssetInputsForRun,
} from "../runtime/pipeline/stages/marlin.js";

export interface MarlinEvaluateOptions {
  projectDir: string;
  repoRoot?: string;
  sourceFiles: string[];
  mock: boolean;
  requestTimeoutMs?: number;
  maxSources?: number;
  skipExisting: boolean;
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
  let requestTimeoutMs: number | undefined;
  let maxSources: number | undefined;
  let skipExisting = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--project" || arg === "-p") {
      projectDir = args[++index] ?? "";
    } else if (arg === "--repo-root") {
      repoRoot = args[++index] ?? undefined;
    } else if (arg === "--mock") {
      mock = true;
    } else if (arg === "--request-timeout-ms" || arg === "--timeout-ms") {
      requestTimeoutMs = parsePositiveIntegerOption(arg, args[++index]);
    } else if (arg.startsWith("--request-timeout-ms=")) {
      requestTimeoutMs = parsePositiveIntegerOption("--request-timeout-ms", arg.slice("--request-timeout-ms=".length));
    } else if (arg.startsWith("--timeout-ms=")) {
      requestTimeoutMs = parsePositiveIntegerOption("--timeout-ms", arg.slice("--timeout-ms=".length));
    } else if (arg === "--max-sources") {
      maxSources = parsePositiveIntegerOption(arg, args[++index]);
    } else if (arg.startsWith("--max-sources=")) {
      maxSources = parsePositiveIntegerOption("--max-sources", arg.slice("--max-sources=".length));
    } else if (arg === "--skip-existing") {
      skipExisting = true;
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
    requestTimeoutMs,
    maxSources,
    skipExisting,
  };
}

function parsePositiveIntegerOption(name: string, value?: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} requires a positive integer value`);
  }
  return parsed;
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

  const outputPath = path.join(projectDir, MARLIN_EVENTS_RELATIVE_PATH);
  const allInputs = loadMarlinAssetInputs(projectDir, sourceFiles);
  if (allInputs.length === 0) {
    throw new Error("No Marlin source inputs found. Pass source files or run analysis to create 03_analysis/assets.json.");
  }

  const inputs = selectMarlinAssetInputsForRun(
    allInputs,
    {
      outputPath,
      skipExisting: options.skipExisting,
      maxSources: options.maxSources,
    },
  );

  const missing = inputs.filter((input) => !fs.existsSync(input.sourcePath));
  if (missing.length > 0) {
    throw new Error(`Marlin source inputs are missing: ${missing.map((input) => input.sourcePath).join(", ")}`);
  }

  const model = marlinModelFromEnvironment(projectDir, repoRoot);
  const marlinFn = createMarlinFnFromEnvironment(projectDir, repoRoot, {
    requestTimeoutMs: options.requestTimeoutMs,
  });
  try {
    const outputPath = await runMarlinAnalysis({
      projectDir,
      projectId: path.basename(projectDir),
      sourceFiles,
      marlinFn,
      model,
      queries: marlinQueriesFromEnvironment(projectDir, repoRoot),
      skipExisting: options.skipExisting,
      maxSources: options.maxSources,
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
  --request-timeout-ms, --timeout-ms
                 Worker request timeout in milliseconds for slow live caption runs
  --max-sources   Evaluate only the next N selected sources
  --skip-existing Skip asset IDs already present in 03_analysis/marlin_events.json
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
