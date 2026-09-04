#!/usr/bin/env npx tsx
/**
 * Prepare/check/install one review-patch/v2 artifact.
 * Providers, NLEs, renderers, and canonical timeline writes are out of scope.
 */

import { pathToFileURL } from "node:url";
import {
  ReviewPatchOperatorError,
  reviewPatchOperatorErrorPayload,
  runReviewPatchOperator,
  type ReviewPatchOperatorMode,
  type ReviewPatchOperatorResult,
} from "../runtime/commands/review-patch.js";

const USAGE = [
  "Usage: npx tsx scripts/review-patch.ts <prepare|check|install> --project <path> --input <patch.json> [--output <external.json>] [--accept --approved-by <human>] [--json]",
  "",
  "prepare: normalize to review-patch/v2 (no project writes)",
  "check: validate approval, hashes, identity, and safety (no writes)",
  "install: promote accepted v2 to 06_review/review_patch.json",
].join("\n");

interface CliArgs {
  mode?: ReviewPatchOperatorMode;
  project?: string;
  input?: string;
  output?: string;
  accept: boolean;
  approvedBy?: string;
  json: boolean;
  help: boolean;
}

function fail(message: string): never {
  throw new ReviewPatchOperatorError("USAGE", message + "\n" + USAGE);
}

function value(args: string[], index: number, option: string): string {
  const result = args[index + 1];
  if (!result || result.startsWith("--")) fail(option + " requires a value");
  return result;
}

export function parseArgs(argv: string[]): CliArgs {
  const first = argv[0] ?? "";
  const second = argv[1] ?? "";
  const args = (first === process.execPath || first.endsWith("/node"))
    && (second.endsWith(".ts") || second.endsWith(".js"))
    ? argv.slice(2)
    : argv;
  const parsed: CliArgs = { accept: false, json: false, help: false };
  const positional: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--help" || arg === "-h") parsed.help = true;
    else if (arg === "--json") parsed.json = true;
    else if (arg === "--accept") parsed.accept = true;
    else if (arg === "--project") {
      parsed.project = value(args, index, "--project");
      index += 1;
    } else if (arg === "--input") {
      parsed.input = value(args, index, "--input");
      index += 1;
    } else if (arg === "--output") {
      parsed.output = value(args, index, "--output");
      index += 1;
    } else if (arg === "--approved-by") {
      parsed.approvedBy = value(args, index, "--approved-by");
      index += 1;
    } else if (arg.startsWith("-")) fail("unknown option " + arg);
    else positional.push(arg);
  }
  if (parsed.help) return parsed;
  if (positional.length !== 1
    || (positional[0] !== "prepare" && positional[0] !== "check" && positional[0] !== "install")) {
    fail("one mode is required: prepare, check, or install");
  }
  parsed.mode = positional[0] as ReviewPatchOperatorMode;
  if (!parsed.project) fail("--project is required");
  if (!parsed.input) fail("--input is required");
  if (parsed.mode !== "prepare" && parsed.output) fail("--output is allowed only for prepare");
  if (parsed.mode !== "install" && (parsed.accept || parsed.approvedBy)) {
    fail("--accept and --approved-by are allowed only for install");
  }
  return parsed;
}

export function runReviewPatchCli(argv: string[]): ReviewPatchOperatorResult {
  const args = parseArgs(argv);
  if (args.help) throw new ReviewPatchOperatorError("USAGE", USAGE);
  return runReviewPatchOperator({
    mode: args.mode!,
    projectDir: args.project!,
    inputPath: args.input!,
    ...(args.output ? { outputPath: args.output } : {}),
    ...(args.accept ? { accept: true } : {}),
    ...(args.approvedBy !== undefined ? { approvedBy: args.approvedBy } : {}),
  });
}

export function main(argv = process.argv): void {
  const wantsJson = argv.includes("--json");
  try {
    const args = parseArgs(argv);
    if (args.help) {
      process.stdout.write(USAGE + "\n");
      return;
    }
    const result = runReviewPatchCli(argv);
    if (args.json) process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    else if (result.mode === "install") {
      process.stdout.write("Installed accepted review-patch/v2; canonical timeline unchanged\n");
    } else {
      process.stdout.write(result.mode + " OK; no project writes\n");
    }
  } catch (error) {
    const payload = reviewPatchOperatorErrorPayload(error);
    if (wantsJson) process.stderr.write(JSON.stringify({ ok: false, error: payload }, null, 2) + "\n");
    else process.stderr.write(payload.code + ": " + payload.message + "\n");
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();
