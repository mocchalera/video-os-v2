import { describe, expect, it } from "vitest";
import type { BriefAlignmentAxis, BriefAlignmentReport, StageResult } from "../runtime/eval/brief-alignment-types.js";
import type { MarlinQAReport } from "../runtime/eval/marlin-qa-types.js";
import { buildQAReport } from "../runtime/eval/qa-improvement-report.js";
import type { QAIssue } from "../runtime/eval/qa-issue-detector.js";
import type { QAFix } from "../runtime/eval/qa-fix-proposer.js";

describe("buildQAReport", () => {
  it("persists all detected issues, including non-fixable issues", () => {
    const fixable = issue("QAISSUE_FIXABLE", true);
    const nonFixable = issue("QAISSUE_OPEN", false);
    const report = buildQAReport(
      2,
      [fixable, nonFixable],
      [fixFor(fixable)],
      marlinReport(),
      briefReport(),
      { now: () => new Date("2026-06-22T00:00:00.000Z") },
    );

    expect(report.total_issues).toBe(2);
    expect(report.fixable_issues).toBe(1);
    expect(report.issues.map((item) => item.issue_id)).toEqual(["QAISSUE_FIXABLE", "QAISSUE_OPEN"]);
    expect(report.fixes).toHaveLength(1);
    expect(report.timestamp).toBe("2026-06-22T00:00:00.000Z");
  });

  it("keeps selects and blueprint brief alignment scores as separate namespaced series", () => {
    const report = buildQAReport(
      1,
      [],
      [],
      marlinReport(),
      briefReport(),
    );

    expect(report.brief_alignment_scores["selects.intent_message_alignment"]).toBe(0.2);
    expect(report.brief_alignment_scores["blueprint.intent_message_alignment"]).toBe(0.7);
    expect(report.brief_alignment_scores.intent_message_alignment).toBe(0.2);
  });

  it("adds backward-compatible fix dispositions and canonical timeline hash", () => {
    const item = issue("QAISSUE_DISPOSITION", true);
    const dispositions = ["proposed", "applied", "rolled_back", "skipped", "rejected"] as const;
    const report = buildQAReport(
      3,
      [item],
      dispositions.map((disposition) => ({
        ...fixFor(item),
        issue_id: `${item.issue_id}_${disposition}`,
        disposition,
        disposition_reason: `${disposition} fixture`,
      })),
      marlinReport(),
      briefReport(),
      {
        evaluationStatus: "available",
        timelineHash: "a".repeat(64),
      },
    );

    expect(report.fixes.map((fix) => fix.disposition)).toEqual(dispositions);
    expect(report.evaluation_status).toBe("available");
    expect(report.timeline_hash).toBe("a".repeat(64));
  });
});

function issue(issueID: string, fixable: boolean): QAIssue {
  return {
    issue_id: issueID,
    type: "quality",
    severity: fixable ? 0.7 : 0.4,
    timestamp_sec: fixable ? 12.5 : 18.25,
    clip_id: fixable ? "CLP_A" : undefined,
    beat_id: "b01",
    description: fixable ? "Camera shakes." : "Unmapped exposure issue.",
    fixable,
    suggested_fix_type: fixable ? "swap" : undefined,
    source: "marlin_qa",
  };
}

function fixFor(item: QAIssue): QAFix {
  return {
    issue_id: item.issue_id,
    issue: item,
    fix_type: "swap",
    target_clip_id: item.clip_id ?? "CLP_A",
    target_beat_id: item.beat_id ?? "b01",
    expected_improvement: 0.4,
    risk: "low",
  };
}

function marlinReport(): MarlinQAReport {
  return {
    version: "1",
    project_id: "qa-report-fixture",
    video_path: "09_output/rough-cut.mp4",
    video_duration_sec: 10,
    overall_assessment: "fixture",
    scene_descriptions: [],
    issues: [],
    pacing_assessment: { too_fast: false, too_slow: false, notes: "" },
    emotion_arc_assessment: { follows_brief: true, notes: "" },
    score: 84,
  };
}

function briefReport(): BriefAlignmentReport {
  const axes = (selectsScore: number, blueprintScore: number, stage: "selects" | "blueprint"): StageResult["axes"] =>
    Object.fromEntries(
      ([
        "intent_message_alignment",
        "must_have_coverage",
        "emotion_curve_alignment",
        "narrative_structure",
        "pacing_coherence",
        "visual_variety_and_focus",
      ] as BriefAlignmentAxis[]).map((axisName): [BriefAlignmentAxis, StageResult["axes"][BriefAlignmentAxis]] => [
        axisName,
        {
          score: axisName === "intent_message_alignment"
            ? (stage === "selects" ? selectsScore : blueprintScore)
            : 1,
          confidence: 0.8,
          judge_source: "deterministic",
          evidence: ["fixture"],
          gaps: [],
        },
      ]),
    ) as unknown as StageResult["axes"];

  return {
    version: "1",
    project: "qa-report-fixture",
    evaluated_at: "2026-06-22T00:00:00.000Z",
    brief_hash: "sha256:test",
    stages: {
      selects: { score: 0.8, axes: axes(0.2, 0.7, "selects") },
      blueprint: { score: 0.9, axes: axes(0.2, 0.7, "blueprint") },
    },
    composite: 0.85,
    notes: [],
  };
}
