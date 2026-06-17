export type BriefAlignmentAxis =
  | "intent_message_alignment"
  | "must_have_coverage"
  | "emotion_curve_alignment"
  | "narrative_structure"
  | "pacing_coherence"
  | "visual_variety_and_focus";

export type BriefAlignmentStage = "selects" | "blueprint" | "timeline" | "final_output";

export interface AxisScore {
  score: number;
  confidence: number;
  judge_source: "deterministic" | "llm_artifact" | "vlm";
  evidence: string[];
  gaps: string[];
}

export interface StageResult {
  score: number;
  axes: Record<BriefAlignmentAxis, AxisScore>;
}

export interface BriefAlignmentReport {
  version: "1";
  project: string;
  evaluated_at: string;
  brief_hash: string;
  stages: {
    selects?: StageResult;
    blueprint?: StageResult;
  };
  composite: number;
  notes: string[];
}

export const BRIEF_ALIGNMENT_AXES: BriefAlignmentAxis[] = [
  "intent_message_alignment",
  "must_have_coverage",
  "emotion_curve_alignment",
  "narrative_structure",
  "pacing_coherence",
  "visual_variety_and_focus",
];

export const AXIS_WEIGHTS: Record<BriefAlignmentAxis, number> = {
  intent_message_alignment: 0.2,
  must_have_coverage: 0.2,
  emotion_curve_alignment: 0.2,
  narrative_structure: 0.15,
  pacing_coherence: 0.15,
  visual_variety_and_focus: 0.1,
};

export const STAGE_WEIGHTS: Record<BriefAlignmentStage, number> = {
  selects: 0.3,
  blueprint: 0.25,
  timeline: 0.3,
  final_output: 0.15,
};
