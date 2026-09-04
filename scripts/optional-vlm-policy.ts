#!/usr/bin/env npx tsx

import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import {
  evaluateProjectOptionalVlmPolicy,
  inspectOptionalVlmPolicy,
} from "../runtime/review/optional-vlm-policy.js";

const USAGE = "Usage: npx tsx scripts/optional-vlm-policy.ts evaluate --project <dir> [--result <json-file> | --result-stdin] [--profile <profile-id>] | status --project <dir>";

export interface OptionalVlmPolicyCliDependencies {
  resultStdin?: string;
}

function valueAfter(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

function readResult(args: string[], dependencies: OptionalVlmPolicyCliDependencies): unknown | undefined {
  const resultFile = valueAfter(args, "--result");
  const useStdin = args.includes("--result-stdin");
  if ((resultFile ? 1 : 0) + (useStdin ? 1 : 0) > 1) throw new Error(USAGE);
  if (!resultFile && !useStdin) return undefined;
  const bytes = useStdin
    ? dependencies.resultStdin ?? fs.readFileSync(0, "utf8")
    : fs.readFileSync(path.resolve(resultFile!), "utf8");
  try {
    return JSON.parse(bytes);
  } catch {
    // Let the policy classifier persist the fixed invalid_result taxonomy;
    // the malformed provider bytes are never copied into the artifact.
    return bytes;
  }
}

export function runOptionalVlmPolicyCli(
  args: string[],
  dependencies: OptionalVlmPolicyCliDependencies = {},
): unknown {
  const command = args[0];
  const project = valueAfter(args, "--project");
  if (!project) throw new Error(USAGE);
  const projectDir = path.resolve(project);
  if (command === "status") return inspectOptionalVlmPolicy(projectDir);
  if (command !== "evaluate") throw new Error(USAGE);
  return evaluateProjectOptionalVlmPolicy(
    projectDir,
    readResult(args, dependencies),
    valueAfter(args, "--profile"),
  );
}

async function main(): Promise<void> {
  try {
    process.stdout.write(`${JSON.stringify(await runOptionalVlmPolicyCli(process.argv.slice(2)), null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

const isMain = process.argv[1]
  ? import.meta.url === pathToFileURL(process.argv[1]).href
  : false;

if (isMain) void main();
