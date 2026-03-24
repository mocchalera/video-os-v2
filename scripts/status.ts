#!/usr/bin/env npx tsx

import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { runStatus, type StatusResult } from "../runtime/commands/status.js";

export interface StatusCliArgs {
  projectDir: string;
  json: boolean;
}

export function parseArgs(argv: string[]): StatusCliArgs {
  const args = argv.slice(2);
  let projectDir = "";
  let json = false;

  for (const arg of args) {
    if (arg === "--json") {
      json = true;
    } else if (arg === "--help" || arg === "-h") {
      console.log("Usage: npx tsx scripts/status.ts <project-path> [--json]");
      process.exit(0);
    } else if (!arg.startsWith("-") && !projectDir) {
      projectDir = arg;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!projectDir) {
    throw new Error("Error: <project-path> is required");
  }

  return { projectDir, json };
}

export function formatStatusResult(projectDir: string, result: StatusResult): string {
  if (!result.success || !result.gates || !result.currentState || !result.nextCommand) {
    return `[status] ${projectDir}`;
  }

  const staleArtifacts = result.staleArtifacts && result.staleArtifacts.length > 0
    ? result.staleArtifacts.join(", ")
    : "none";

  return [
    `[status] Project: ${path.resolve(projectDir)}`,
    `State: ${result.currentState}`,
    `Gates: analysis=${result.gates.analysis_gate}, planning=${result.gates.planning_gate}, compile=${result.gates.compile_gate}`,
    `Stale artifacts: ${staleArtifacts}`,
    `Next: ${result.nextCommand} (${result.nextCommandReason ?? "no reason provided"})`,
  ].join("\n");
}

function main(): void {
  try {
    const args = parseArgs(process.argv);
    const result = runStatus(args.projectDir);

    if (!result.success) {
      console.error(`[status] ${result.error?.code ?? "ERROR"}: ${result.error?.message ?? "Unknown error"}`);
      process.exit(1);
    }

    if (args.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    console.log(formatStatusResult(args.projectDir, result));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[status] ${message}`);
    process.exit(1);
  }
}

const isMain = process.argv[1]
  ? import.meta.url === pathToFileURL(process.argv[1]).href
  : false;

if (isMain) {
  main();
}
