#!/usr/bin/env tsx
/**
 * Legacy standalone triage — use editorial-pipeline for new projects.
 *
 * Headless in-runtime LLM triage.
 *
 *   npx tsx scripts/triage-llm.ts <projectDir> [--model <model>] [--text-only-triage|--multimodal]
 */

import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { createLlmTriageAgent } from "../runtime/agents/llm-triage-agent.js";
import { runTriage } from "../runtime/commands/triage.js";

const USAGE = "Usage: npx tsx scripts/triage-llm.ts <projectDir> [--model <model>] [--text-only-triage|--multimodal]";

interface Args {
  projectDir: string;
  model?: string;
  textOnlyTriage?: boolean;
}

export function parseArgs(argv: string[]): Args {
  const args = argv.slice(2);
  let projectDir: string | undefined;
  let model: string | undefined;
  let textOnlyTriage: boolean | undefined;

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
    if (arg === "--text-only-triage") {
      if (textOnlyTriage === false) throw new Error("Use only one of --text-only-triage or --multimodal");
      textOnlyTriage = true;
      continue;
    }
    if (arg === "--multimodal") {
      if (textOnlyTriage === true) throw new Error("Use only one of --text-only-triage or --multimodal");
      textOnlyTriage = false;
      continue;
    }
    if (arg.startsWith("--")) throw new Error(`Unknown argument: ${arg}`);
    if (projectDir) throw new Error(`Unexpected extra argument: ${arg}`);
    projectDir = arg;
  }

  if (!projectDir) throw new Error(USAGE);
  return { projectDir, model, textOnlyTriage };
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
  const agent = createLlmTriageAgent({
    ...(args.model ? { model: args.model } : {}),
    ...(args.textOnlyTriage === undefined ? {} : { textOnlyTriage: args.textOnlyTriage }),
  });
  const result = await runTriage(projectDir, agent);
  if (!result.success) {
    console.error(`triage-llm failed: ${result.error?.message ?? "unknown error"}`);
    return 1;
  }
  if (result.selects) {
    console.log(JSON.stringify(result.selects, null, 2));
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
