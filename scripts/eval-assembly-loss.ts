#!/usr/bin/env tsx
/**
 * CLI entry point for the assembly-loss project diagnostic (Issue #11 M2B).
 *
 * Usage:
 *   npx tsx scripts/eval-assembly-loss.ts <project-dir> [options]
 *
 * Thin adapter: all logic lives in runtime/eval/assembly-loss-project.ts.
 * Importing this module never executes the CLI; the guard below only runs
 * it when invoked directly as a script. Termination uses process.exitCode
 * (never process.exit).
 */

import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { runAssemblyLossCli } from "../runtime/eval/assembly-loss-project.js";

const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (invokedDirectly) {
  void runAssemblyLossCli(process.argv.slice(2)).then((exitCode) => {
    process.exitCode = exitCode;
  });
}
