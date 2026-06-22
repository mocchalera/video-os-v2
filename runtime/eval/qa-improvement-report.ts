import * as fs from "node:fs";
import * as path from "node:path";
import type { BriefAlignmentAxis, BriefAlignmentReport } from "./brief-alignment-types.js";
import type { MarlinQAReport } from "./marlin-qa-types.js";
import type { QAFix } from "./qa-fix-proposer.js";
import type { QAIssue } from "./qa-issue-detector.js";

export interface QAImprovementReport {
  iteration: number;
  total_issues: number;
  fixable_issues: number;
  proposed_fixes: number;
  issues: QAIssue[];
  fixes: QAFix[];
  overall_qa_score: number;
  brief_alignment_scores: Record<string, number>;
  timestamp: string;
}

export function buildQAReport(
  iteration: number,
  issues: QAIssue[],
  fixes: QAFix[],
  marlinQaResult: MarlinQAReport,
  briefAlignmentResult: BriefAlignmentReport,
  options: { now?: () => Date } = {},
): QAImprovementReport {
  return {
    iteration,
    total_issues: issues.length,
    fixable_issues: issues.filter((issue) => issue.fixable).length,
    proposed_fixes: fixes.length,
    issues,
    fixes,
    overall_qa_score: marlinQaResult.score,
    brief_alignment_scores: flattenBriefAlignmentScores(briefAlignmentResult),
    timestamp: (options.now ?? (() => new Date()))().toISOString(),
  };
}

export function writeQAImprovementReport(
  projectDir: string,
  report: QAImprovementReport,
  relativePath = "06_review/qa-improvement-report.json",
): string {
  const filePath = path.join(projectDir, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(report, null, 2)}\n`, "utf-8");
  fs.renameSync(tmp, filePath);
  return filePath;
}

function flattenBriefAlignmentScores(report: BriefAlignmentReport): Record<string, number> {
  const scores: Record<string, number> = {
    composite: report.composite,
  };
  for (const stageName of ["selects", "blueprint"] as const) {
    const stage = report.stages[stageName];
    if (!stage) continue;
    scores[`${stageName}.score`] = stage.score;
    for (const [axisName, axis] of Object.entries(stage.axes) as Array<[BriefAlignmentAxis, { score: number }]>) {
      scores[`${stageName}.${axisName}`] = axis.score;
      if (scores[axisName] === undefined) scores[axisName] = axis.score;
    }
  }
  return scores;
}
