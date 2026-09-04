#!/usr/bin/env npx tsx
/**
 * Read-only RFA-016 private-pilot gate evaluator.
 *
 * Usage:
 *   npm run pilot:verify -- --project projects/<project-id> [--json]
 */

import * as path from "node:path";
import { pathToFileURL } from "node:url";
import {
  evaluatePrivatePilot,
  PRIVATE_PILOT_GATES,
  type PrivatePilotEvaluation,
} from "../runtime/pilot/private-pilot-gates.js";

const USAGE = [
  "Usage: npm run pilot:verify -- --project <project-path> [options]",
  "",
  "Options:",
  "  --project <path>     Project containing 07_package/private-pilot/manifest.json",
  "  --manifest <path>    Project-relative manifest override",
  "  --json               Print machine-readable evaluation JSON",
].join("\n");

export interface PrivatePilotCliArgs {
  projectDir: string;
  manifestPath?: string;
  json: boolean;
}

export function parsePrivatePilotArgs(argv: string[]): PrivatePilotCliArgs {
  const args = argv.slice(2);
  let projectDir = "";
  let manifestPath: string | undefined;
  let json = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--help" || arg === "-h") throw new Error(USAGE);
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (arg === "--project" && index + 1 < args.length) {
      projectDir = args[++index];
      continue;
    }
    if (arg === "--manifest" && index + 1 < args.length) {
      manifestPath = args[++index];
      continue;
    }
    if (arg.startsWith("-")) throw new Error(`Unknown or incomplete argument: ${arg}\n${USAGE}`);
    if (projectDir) throw new Error(`Unexpected argument: ${arg}\n${USAGE}`);
    projectDir = arg;
  }
  if (!projectDir) throw new Error(`--project is required\n${USAGE}`);
  return {
    projectDir: path.resolve(projectDir),
    manifestPath,
    json,
  };
}

export function formatPrivatePilotEvaluation(evaluation: PrivatePilotEvaluation): string {
  return [
    `[private-pilot] ${evaluation.decision}`,
    `project: ${evaluation.project_id ?? "-"}`,
    `pilot: ${evaluation.pilot_id ?? "-"}`,
    ...PRIVATE_PILOT_GATES.map((gate) => {
      const result = evaluation.gates[gate];
      return `${gate}: ${result.status}/${result.decision}/${result.freshness} ${result.ready ? "READY" : "HOLD"}`;
    }),
    ...evaluation.reasons.map((reason) => `- ${reason}`),
    "public promotion: out_of_scope",
  ].join("\n");
}

export function runPrivatePilotCli(argv = process.argv): number {
  try {
    const args = parsePrivatePilotArgs(argv);
    const evaluation = evaluatePrivatePilot(args.projectDir, { manifestPath: args.manifestPath });
    console.log(args.json ? JSON.stringify(evaluation, null, 2) : formatPrivatePilotEvaluation(evaluation));
    return evaluation.ready ? 0 : 1;
  } catch (error) {
    if (error instanceof Error && error.message === USAGE) {
      console.log(USAGE);
      return 0;
    }
    console.error(`[private-pilot] ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

const isMain = process.argv[1]
  ? import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
  : false;

if (isMain) process.exitCode = runPrivatePilotCli();
