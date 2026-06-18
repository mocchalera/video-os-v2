#!/usr/bin/env tsx
/**
 * Headless in-runtime LLM blueprint planning.
 *
 *   npx tsx scripts/blueprint-llm.ts <projectDir> [--model <model>] [--skip-craft-review]
 */

import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { createLlmBlueprintAgent } from "../runtime/agents/llm-blueprint-agent.js";
import { runBlueprint } from "../runtime/commands/blueprint.js";

const USAGE = "Usage: npx tsx scripts/blueprint-llm.ts <projectDir> [--model <model>] [--skip-craft-review]";

interface Args {
  projectDir: string;
  model?: string;
  skipCraftReview: boolean;
}

export function parseArgs(argv: string[]): Args {
  const args = argv.slice(2);
  let projectDir: string | undefined;
  let model: string | undefined;
  let skipCraftReview = false;

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--help" || arg === "-h") {
      throw new Error(USAGE);
    }
    if (arg === "--model") {
      model = args[i + 1];
      if (!model) throw new Error("--model requires a value");
      i += 1;
      continue;
    }
    if (arg === "--skip-craft-review") {
      skipCraftReview = true;
      continue;
    }
    if (arg.startsWith("--")) throw new Error(`Unknown argument: ${arg}`);
    if (projectDir) throw new Error(`Unexpected extra argument: ${arg}`);
    projectDir = arg;
  }

  if (!projectDir) throw new Error(USAGE);
  return { projectDir, model, skipCraftReview };
}

export async function main(argv: string[] = process.argv): Promise<number> {
  let args: Args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }

  const projectDir = path.resolve(args.projectDir);
  const agent = createLlmBlueprintAgent(args.model ? { model: args.model } : {});
  const result = await runBlueprint(projectDir, agent, {
    iterativeEngine: false,
    skipCraftReview: args.skipCraftReview,
  });
  if (!result.success) {
    console.error(`blueprint-llm failed: ${result.error?.message ?? "unknown error"}`);
    return 1;
  }
  if (result.blueprint) {
    console.log(JSON.stringify(result.blueprint, null, 2));
  }
  return 0;
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
