export interface MarlinQAIssue {
  timestamp_sec: number;
  duration_sec: number;
  category: "camera_shake" | "dark_exposure" | "pacing" | "continuity" | "weak_content" | "other";
  severity: "critical" | "warning" | "info";
  description: string;
  suggestion: string;
}

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
}
