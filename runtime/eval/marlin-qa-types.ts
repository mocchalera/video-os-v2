export interface MarlinQAIssue {
  timestamp_sec: number;
  duration_sec: number;
  category: "camera_shake" | "dark_exposure" | "pacing" | "continuity" | "weak_content" | "micro_clip" | "other";
  severity: "critical" | "warning" | "info";
  description: string;
  suggestion: string;
}

export type VisualQAStatus = "verified" | "blocked" | "unverified";

export interface MarlinQAReport {
  version: "1";
  project_id: string;
  video_path: string;
  video_duration_sec: number;
  overall_assessment: string;
  scene_descriptions: Array<{ start_sec: number; end_sec: number; description: string }>;
  issues: MarlinQAIssue[];
  pacing_assessment: { too_fast: boolean; too_slow: boolean; notes: string };
  emotion_arc_assessment: { follows_brief: boolean; notes: string };
  score: number;
  visual_qa?: VisualQAStatus;
  visual_qa_reason?: string;
  mock?: boolean;
}

export function marlinQAStatus(
  report: Pick<MarlinQAReport, "visual_qa" | "mock" | "score" | "video_duration_sec" | "overall_assessment">,
): VisualQAStatus {
  if (report.visual_qa) return report.visual_qa;
  if (isLegacySkippedPlaceholder(report)) return "blocked";
  return report.mock === true ? "unverified" : "verified";
}

export function isMarlinQAReportVerified(
  report: Pick<MarlinQAReport, "visual_qa" | "mock" | "score" | "video_duration_sec" | "overall_assessment">,
): boolean {
  return marlinQAStatus(report) === "verified" && report.mock !== true;
}

function isLegacySkippedPlaceholder(
  report: Pick<MarlinQAReport, "score" | "video_duration_sec" | "overall_assessment">,
): boolean {
  return report.score === 100 &&
    report.video_duration_sec === 0 &&
    /\bMarlin QA skipped\b/i.test(report.overall_assessment);
}
