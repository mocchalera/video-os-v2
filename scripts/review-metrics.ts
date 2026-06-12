#!/usr/bin/env npx tsx

import { pathToFileURL } from "node:url";
import { runReviewMetrics } from "../runtime/review/metrics.js";

function parseArgs(argv: string[]): { projectPath: string } {
  const projectPath = argv[2];
  if (!projectPath) {
    console.error("Usage: npx tsx scripts/review-metrics.ts <project-path>");
    process.exit(1);
  }
  return { projectPath };
}

export function runReviewMetricsCli(argv = process.argv): void {
  const { projectPath } = parseArgs(argv);
  const { metrics } = runReviewMetrics(projectPath);
  console.log(JSON.stringify(metrics, null, 2));
}

const isMain = process.argv[1]
  ? import.meta.url === pathToFileURL(process.argv[1]).href
  : false;

if (isMain) {
  runReviewMetricsCli(process.argv);
}
