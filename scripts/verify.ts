#!/usr/bin/env tsx
/**
 * Aggregate verification gate — the single command an agent (or a human)
 * runs before declaring work done.
 *
 *   npm run verify           fast: typecheck + unit tests + schema validation
 *   npm run verify -- --full also: golden agreement eval (eval --all
 *                            --min-score) and PARITY=1 render parity
 *
 * Each step reports pass/fail; the process exits non-zero if any step
 * fails. Steps run sequentially so failures stay attributable.
 */

import { spawnSync } from "node:child_process";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

const repoRoot = path.resolve(import.meta.dirname, "..");

interface Step {
  name: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
  /** Only run with --full. */
  full?: boolean;
}

/**
 * Minimum overall agreement score for the golden eval gate.
 *
 * Calibrated 2026-06-13: current goldens self-recompile at 100 / 75.6 /
 * 55.5. The 55.5 (fumoto-growth) is known drift — it was approved on
 * compiler 1.0.0 in March and the compiler has intentionally evolved
 * since; the golden needs human re-approval (docs/eval-harness.md). The
 * gate sits below that legitimate floor so it only trips on catastrophic
 * regressions. Raise toward 75+ once stale goldens are re-approved.
 */
const EVAL_MIN_SCORE = "50";

export const VERIFY_STEPS: Step[] = [
  {
    name: "typecheck",
    command: "npx",
    args: ["tsc", "--noEmit"],
  },
  {
    name: "unit-tests",
    command: "npx",
    args: ["vitest", "run", "--reporter=dot"],
  },
  {
    name: "schema-validation (demo)",
    command: "npx",
    args: ["tsx", "scripts/validate-schemas.ts", "projects/demo"],
  },
  {
    name: "review-metrics (demo)",
    command: "npx",
    args: ["tsx", "scripts/review-metrics.ts", "projects/demo", "--no-write"],
  },
  {
    name: "golden-eval (agreement >= " + EVAL_MIN_SCORE + ")",
    command: "npx",
    args: ["tsx", "scripts/eval.ts", "--all", "--min-score", EVAL_MIN_SCORE, "--no-write"],
    full: true,
  },
  {
    name: "render-parity (PARITY=1)",
    command: "npx",
    args: ["vitest", "run", "editor/tests/parity/", "--reporter=dot"],
    env: { PARITY: "1" },
    full: true,
  },
];

export function parseArgs(argv: string[]): { full: boolean } {
  const args = argv.slice(2);
  let full = false;
  for (const arg of args) {
    if (arg === "--full") full = true;
    else if (arg === "--help" || arg === "-h") {
      console.log("Usage: npm run verify [-- --full]");
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return { full };
}

export function main(argv: string[] = process.argv): number {
  const { full } = parseArgs(argv);
  const results: Array<{ name: string; ok: boolean; seconds: number }> = [];

  for (const step of VERIFY_STEPS) {
    if (step.full && !full) continue;
    console.log(`\n━━ verify: ${step.name} ━━`);
    const startedAt = Date.now();
    const run = spawnSync(step.command, step.args, {
      cwd: repoRoot,
      stdio: "inherit",
      env: { ...process.env, ...step.env },
    });
    const seconds = (Date.now() - startedAt) / 1000;
    const ok = run.status === 0;
    results.push({ name: step.name, ok, seconds });
    if (!ok) {
      // Keep going so the summary shows every broken gate, not just the first.
      console.error(`✗ ${step.name} failed (exit ${run.status})`);
    }
  }

  console.log("\n━━ verify summary ━━");
  for (const r of results) {
    console.log(`  ${r.ok ? "✓" : "✗"} ${r.name} (${r.seconds.toFixed(1)}s)`);
  }
  const failed = results.filter((r) => !r.ok);
  if (failed.length > 0) {
    console.error(`\n${failed.length} gate(s) failed.`);
    return 1;
  }
  console.log("\nAll gates passed.");
  return 0;
}

const isDirectRun =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  process.exitCode = main();
}
