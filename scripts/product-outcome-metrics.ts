#!/usr/bin/env tsx
import * as path from "node:path";
import { writeProductOutcomeMetrics } from "../runtime/eval/product-outcome-metrics.js";

interface Args {
  project?: string;
  output?: string;
}

export function parseProductOutcomeMetricsArgs(argv: string[]): Args {
  const args: Args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--project") {
      args.project = argv[index + 1];
      index += 1;
    } else if (arg === "--output") {
      args.output = argv[index + 1];
      index += 1;
    } else if (arg === "--help" || arg === "-h") {
      usage(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

export function runProductOutcomeMetricsCli(argv: string[]): {
  output: string;
  report_id: string;
  hash: string;
  degraded_run_flags: string[];
} {
  const args = parseProductOutcomeMetricsArgs(argv);
  if (!args.project) usage(1);
  const result = writeProductOutcomeMetrics(path.resolve(args.project), args.output);
  return {
    output: result.outputPath,
    report_id: result.report.report_id,
    hash: result.hash,
    degraded_run_flags: result.report.degraded_run_flags.map((flag) => flag.code),
  };
}

function usage(code: number): never {
  const message = "Usage: tsx scripts/product-outcome-metrics.ts --project <path> [--output <path>]";
  if (code === 0) {
    process.stdout.write(`${message}\n`);
    process.exit(0);
  }
  throw new Error(message);
}

const isDirectRun = import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith("product-outcome-metrics.ts");

if (isDirectRun) {
  try {
    process.stdout.write(`${JSON.stringify(runProductOutcomeMetricsCli(process.argv.slice(2)))}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
