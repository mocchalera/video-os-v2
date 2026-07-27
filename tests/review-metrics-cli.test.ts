import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  parseReviewMetricsArgs,
  runReviewMetricsCli,
} from "../scripts/review-metrics.js";
import { VERIFY_STEPS } from "../scripts/verify.js";

const repoRoot = path.resolve(import.meta.dirname, "..");
const demoDir = path.join(repoRoot, "projects/demo");
const metricsPath = path.join(demoDir, "06_review/review_metrics.json");

afterEach(() => {
  vi.restoreAllMocks();
});

describe("review metrics CLI", () => {
  it("parses the explicit no-write mode", () => {
    expect(parseReviewMetricsArgs([
      "node",
      "review-metrics",
      demoDir,
      "--no-write",
    ])).toEqual({ projectPath: demoDir, noWrite: true });
  });

  it("computes and validates metrics without changing the existing artifact", () => {
    const before = fs.readFileSync(metricsPath);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    runReviewMetricsCli(["node", "review-metrics", demoDir, "--no-write"]);

    expect(fs.readFileSync(metricsPath)).toEqual(before);
    expect(JSON.parse(String(log.mock.calls.at(-1)?.[0]))).toMatchObject({
      version: "2",
      project_id: "sample-mountain-reset",
    });
  });

  it("keeps the aggregate verification gate read-only", () => {
    const step = VERIFY_STEPS.find((item) => item.name === "review-metrics (demo)");
    expect(step?.args).toContain("--no-write");
  });
});
