#!/usr/bin/env tsx
import * as path from "node:path";
import type { FootageSearchMode, SearchFootageInput } from "./footage-search.js";

type CliSearchMode = Extract<FootageSearchMode, "text" | "visual" | "audio" | "hybrid" | "multimodal">;

interface Args {
  project?: string;
  mode?: CliSearchMode;
  query?: string;
  imageQueryPath?: string;
  audioQueryPath?: string;
  limit?: number;
  json?: boolean;
}

const VALID_MODES = new Set<CliSearchMode>(["text", "visual", "audio", "hybrid", "multimodal"]);
let disposeSearch: (() => Promise<void>) | null = null;

function parseArgs(argv: string[]): Args {
  const args: Args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = argv[index + 1];
    if (arg === "--project") {
      args.project = requiredValue(arg, value);
      index += 1;
    } else if (arg === "--mode") {
      const mode = requiredValue(arg, value);
      if (!isValidMode(mode)) throw new Error("--mode must be text, visual, audio, hybrid, or multimodal");
      args.mode = mode;
      index += 1;
    } else if (arg === "--query") {
      args.query = requiredValue(arg, value);
      index += 1;
    } else if (arg === "--image-query-path") {
      args.imageQueryPath = requiredValue(arg, value);
      index += 1;
    } else if (arg === "--audio-query-path") {
      args.audioQueryPath = requiredValue(arg, value);
      index += 1;
    } else if (arg === "--limit") {
      args.limit = parseLimit(requiredValue(arg, value));
      index += 1;
    } else if (arg === "--json") {
      args.json = true;
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
  if (!args.project) throw new Error("--project is required");
  if (!path.isAbsolute(args.project)) throw new Error("--project must be an absolute path");
  if (!args.json) throw new Error("--json is required");

  const projectDir = path.resolve(args.project);
  const query = args.query ?? "";
  const input: SearchFootageInput = {
    query,
    mode: args.mode ?? "hybrid",
    semantic: query || undefined,
    image_query_path: resolveProjectPath(projectDir, args.imageQueryPath),
    audio_query_path: resolveProjectPath(projectDir, args.audioQueryPath),
    limit: args.limit ?? 20,
  };

  try {
    const { disposeFootageSearch, searchFootage } = await import("./footage-search.js");
    disposeSearch = disposeFootageSearch;
    const response = await searchFootage(projectDir, input);
    process.stdout.write(`${JSON.stringify(response, null, 2)}\n`);
  } finally {
    if (disposeSearch) await disposeSearch();
  }
}

function requiredValue(flag: string, value: string | undefined): string {
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

function isValidMode(value: string): value is CliSearchMode {
  return VALID_MODES.has(value as CliSearchMode);
}

function parseLimit(value: string): number {
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit <= 0) throw new Error("--limit must be a positive integer");
  return limit;
}

function resolveProjectPath(projectDir: string, value: string | undefined): string | undefined {
  if (!value) return undefined;
  return path.isAbsolute(value) ? value : path.resolve(projectDir, value);
}

function usage(exitCode: number): never {
  const out = exitCode === 0 ? process.stdout : process.stderr;
  out.write(`Usage: npx tsx runtime/tools/footage-search-cli.ts --project <absolute-path> --mode text|visual|audio|hybrid|multimodal [options] --json

Options:
  --query <text>
  --image-query-path <absolute-path>
  --audio-query-path <absolute-path>
  --limit <number>              default: 20
  --json                        required
`);
  process.exit(exitCode);
}

main().catch(async (error) => {
  try {
    if (disposeSearch) await disposeSearch();
  } catch {
    // Preserve the original error as the CLI diagnostic.
  }
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
