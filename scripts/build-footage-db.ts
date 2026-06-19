#!/usr/bin/env tsx
import * as path from "node:path";
import {
  buildFootageDb,
  type FootageDbEmbeddingPolicy,
  type FootageDbRebuildMode,
} from "../runtime/artifacts/footage-db-builder.js";

interface Args {
  project?: string;
  output?: string;
  embeddingPolicy?: FootageDbEmbeddingPolicy;
  rebuildMode?: FootageDbRebuildMode;
  allowRemoteEmbeddingModels?: boolean;
  skipAudioAnalysis?: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = argv[index + 1];
    if (arg === "--project") {
      args.project = value;
      index += 1;
    } else if (arg === "--output") {
      args.output = value;
      index += 1;
    } else if (arg === "--embedding-policy") {
      if (!isEmbeddingPolicy(value)) throw new Error("--embedding-policy must be skip, auto, or require");
      args.embeddingPolicy = value;
      index += 1;
    } else if (arg === "--rebuild-mode") {
      if (!isRebuildMode(value)) throw new Error("--rebuild-mode must be full or incremental");
      args.rebuildMode = value;
      index += 1;
    } else if (arg === "--allow-remote-embedding-models") {
      args.allowRemoteEmbeddingModels = true;
    } else if (arg === "--skip-audio-analysis") {
      args.skipAudioAnalysis = true;
    } else if (arg === "--help" || arg === "-h") {
      usage(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.project) usage(1);
  const result = await buildFootageDb({
    projectDir: path.resolve(args.project),
    outputPath: args.output ? path.resolve(args.output) : undefined,
    embeddingPolicy: args.embeddingPolicy ?? "auto",
    rebuildMode: args.rebuildMode ?? "full",
    allowRemoteEmbeddingModels: args.allowRemoteEmbeddingModels ?? false,
    skipAudioAnalysis: args.skipAudioAnalysis ?? false,
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

function isEmbeddingPolicy(value: string | undefined): value is FootageDbEmbeddingPolicy {
  return value === "skip" || value === "auto" || value === "require";
}

function isRebuildMode(value: string | undefined): value is FootageDbRebuildMode {
  return value === "full" || value === "incremental";
}

function usage(exitCode: number): never {
  const out = exitCode === 0 ? process.stdout : process.stderr;
  out.write(`Usage: npx tsx scripts/build-footage-db.ts --project <path> [options]

Options:
  --output <path>                  default: <project>/03_analysis/search/footage.db
  --embedding-policy auto|skip|require  default: auto
  --rebuild-mode full|incremental
  --skip-audio-analysis          leave audio level/silence fields null
  --allow-remote-embedding-models  default false
`);
  process.exit(exitCode);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
