import { describe, expect, it } from "vitest";
import {
  enforceReviewMetricVerdict,
  type ReviewReport,
} from "../runtime/commands/review/index.js";
import type { ReviewMetricsArtifact } from "../runtime/review/metrics.js";

describe("review metric verdict enforcement", () => {
  it("turns a hard dialogue-completeness failure into a fatal approval blocker", () => {
    const report = cleanReport();
    enforceReviewMetricVerdict(report, metrics("fail", "CLP_BAD"));

    expect(report.summary_judgment.status).toBe("needs_revision");
    expect(report.fatal_issues).toEqual([
      expect.objectContaining({
        severity: "fatal",
        affected_clip_ids: ["CLP_BAD"],
      }),
    ]);
    expect(report.summary_judgment.rationale).toContain("Dialogue completeness gate: fail");
  });

  it("keeps a soft context warning reviewable without blocking approval", () => {
    const report = cleanReport();
    enforceReviewMetricVerdict(report, metrics("warn", "CLP_SOFT"));

    expect(report.summary_judgment.status).toBe("approved");
    expect(report.fatal_issues).toEqual([]);
    expect(report.warnings).toEqual([
      expect.objectContaining({
        severity: "warning",
        affected_clip_ids: ["CLP_SOFT"],
      }),
    ]);
  });
});

function cleanReport(): ReviewReport {
  return {
    version: "1",
    project_id: "dialogue-gate-test",
    timeline_version: "1",
    summary_judgment: {
      status: "approved",
      rationale: "Editorial review passed.",
    },
    strengths: [],
    weaknesses: [],
    fatal_issues: [],
    warnings: [],
    mismatches_to_brief: [],
    mismatches_to_blueprint: [],
    recommended_next_pass: {
      goal: "Preserve the approved cut.",
      actions: [],
    },
  };
}

function metrics(
  status: "fail" | "warn",
  clipId: string,
): ReviewMetricsArtifact {
  return {
    version: "1",
    project_id: "dialogue-gate-test",
    timeline_version: "1",
    summary: {
      total_checks: 1,
      by_status: {
        pass: 0,
        warn: status === "warn" ? 1 : 0,
        fail: status === "fail" ? 1 : 0,
        skipped: 0,
      },
      by_tier: {
        emotion: emptyCounts(),
        story: {
          pass: 0,
          warn: status === "warn" ? 1 : 0,
          fail: status === "fail" ? 1 : 0,
          skipped: 0,
        },
        rhythm: emptyCounts(),
        eye_trace: emptyCounts(),
        plane_2d: emptyCounts(),
        audio: emptyCounts(),
      },
    },
    checks: [{
      id: "story.dialogue_completeness",
      tier: "story",
      status,
      measured: {
        findings: [{ clip_id: clipId, code: "dependent_ending" }],
      },
      threshold: { hard_issue_max: 0 },
      evidence: [`${clipId}: incomplete dialogue boundary`],
    }],
  };
}

function emptyCounts() {
  return { pass: 0, warn: 0, fail: 0, skipped: 0 };
}
