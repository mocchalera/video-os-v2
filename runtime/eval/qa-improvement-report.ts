import * as fs from "node:fs";
import * as path from "node:path";
import type { BriefAlignmentAxis, BriefAlignmentReport } from "./brief-alignment-types.js";
import {
  isMarlinQAReportVerified,
  marlinQAStatus,
  type MarlinQAReport,
  type VisualQAStatus,
} from "./marlin-qa-types.js";
import type { QAFix } from "./qa-fix-proposer.js";
import type { QAIssue } from "./qa-issue-detector.js";

export type QAFixDisposition = "proposed" | "applied" | "rolled_back" | "skipped" | "rejected";

export interface QAReportedFix extends QAFix {
  disposition?: QAFixDisposition;
  disposition_reason?: string;
}

export interface QAImprovementReport {
  iteration: number;
  total_issues: number;
  fixable_issues: number;
  proposed_fixes: number;
  issues: QAIssue[];
  fixes: QAReportedFix[];
  overall_qa_score: number;
  visual_qa: VisualQAStatus | "not_applicable";
  visual_qa_reason?: string;
  visual_qa_mock?: boolean;
  evaluation_status?: "available" | "unavailable";
  evaluation_unavailable_reason?: string;
  timeline_hash?: string;
  brief_alignment_scores: Record<string, number>;
  timestamp: string;
}

export function buildQAReport(
  iteration: number,
  issues: QAIssue[],
  fixes: QAReportedFix[],
  marlinQaResult: MarlinQAReport,
  briefAlignmentResult: BriefAlignmentReport,
  options: {
    now?: () => Date;
    evaluationStatus?: "available" | "unavailable";
    evaluationUnavailableReason?: string;
    timelineHash?: string;
    visualQaApplicable?: boolean;
  } = {},
): QAImprovementReport {
  return {
    iteration,
    total_issues: issues.length,
    fixable_issues: issues.filter((issue) => issue.fixable).length,
    proposed_fixes: fixes.length,
    issues,
    fixes,
    overall_qa_score: options.visualQaApplicable === false
      ? briefAlignmentResult.composite
      : isMarlinQAReportVerified(marlinQaResult) ? marlinQaResult.score : 0,
    visual_qa: options.visualQaApplicable === false
      ? "not_applicable"
      : marlinQAStatus(marlinQaResult),
    ...(options.visualQaApplicable === false
      ? { visual_qa_reason: "audio_only_timeline" }
      : marlinQaResult.visual_qa_reason ? { visual_qa_reason: marlinQaResult.visual_qa_reason } : {}),
    ...(marlinQaResult.mock === true ? { visual_qa_mock: true } : {}),
    ...(options.evaluationStatus ? { evaluation_status: options.evaluationStatus } : {}),
    ...(options.evaluationUnavailableReason
      ? { evaluation_unavailable_reason: options.evaluationUnavailableReason }
      : {}),
    ...(options.timelineHash ? { timeline_hash: options.timelineHash } : {}),
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
