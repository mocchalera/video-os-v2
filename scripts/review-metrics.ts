#!/usr/bin/env npx tsx

import { pathToFileURL } from "node:url";
import {
  computeReviewMetrics,
  loadReviewMetricsInputs,
  runReviewMetrics,
  validateReviewMetricsArtifact,
} from "../runtime/review/metrics.js";

export interface ReviewMetricsCliArgs {
  projectPath: string;
  noWrite: boolean;
}

export function parseReviewMetricsArgs(argv: string[]): ReviewMetricsCliArgs {
  let projectPath: string | undefined;
  let noWrite = false;

  for (const arg of argv.slice(2)) {
    if (arg === "--no-write") {
      noWrite = true;
    } else if (arg.startsWith("-")) {
      throw new Error(`Unknown option: ${arg}`);
    } else if (projectPath === undefined) {
      projectPath = arg;
    } else {
      throw new Error(`Unexpected argument: ${arg}`);
    }
  }

  if (!projectPath) {
    throw new Error("Usage: npx tsx scripts/review-metrics.ts <project-path> [--no-write]");
  }
  return { projectPath, noWrite };
}

export function runReviewMetricsCli(argv = process.argv): void {
  const { projectPath, noWrite } = parseReviewMetricsArgs(argv);
  const metrics = noWrite
    ? computeReviewMetrics(loadReviewMetricsInputs(projectPath))
    : runReviewMetrics(projectPath).metrics;
  if (noWrite) validateReviewMetricsArtifact(metrics);
  console.log(JSON.stringify(metrics, null, 2));
}

const isMain = process.argv[1]
  ? import.meta.url === pathToFileURL(process.argv[1]).href
  : false;

if (isMain) {
  runReviewMetricsCli(process.argv);
}
