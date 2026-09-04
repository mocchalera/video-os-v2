export type BriefAlignmentAxis =
  | "intent_message_alignment"
  | "must_have_coverage"
  | "emotion_curve_alignment"
  | "narrative_structure"
  | "pacing_coherence"
  | "visual_variety_and_focus";

export type BriefAlignmentStage = "selects" | "blueprint" | "timeline" | "final_output";

export type BriefAlignmentJudgeSource = "deterministic" | "llm_artifact" | "vlm";

export type BriefAlignmentCompositeJudgeSource = "deterministic-only" | "llm-assisted";

/**
 * How a confidence claim is grounded. Canonical truth contract (Issue #32 M0):
 * only "measured" confidence backed by evidence may be presented as high
 * confidence. "degraded" and "unmeasured" claims must be capped before they
 * reach an operator.
 */
export type ConfidenceBasis = "measured" | "degraded" | "unmeasured";

/**
 * Confidence at or above this threshold counts as a high-confidence claim
 * (boundary inclusive: 0.70 itself is a high-confidence claim) and requires a
 * measured basis plus evidence. Unsupported claims are demoted.
 */
export const HIGH_CONFIDENCE_THRESHOLD = 0.7;

/**
 * Hard ceiling for degraded or unmeasured confidence claims, e.g. when the
 * optional judge provider is unavailable or only deterministic heuristics ran.
 * Such claims must never exceed 0.5.
 */
export const DEGRADED_CONFIDENCE_CEILING = 0.5;

/** Ceiling applied to confidence claims that lack a measured, evidenced basis. */
export const UNSUPPORTED_CONFIDENCE_CEILING = 0.5;

export interface AxisScore {
  score: number;
  confidence: number;
  judge_source: BriefAlignmentJudgeSource;
  evidence: string[];
  gaps: string[];
  confidence_basis?: ConfidenceBasis;
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
  judge_source?: BriefAlignmentCompositeJudgeSource;
  decision_runtime?: Array<{
    runtime: string;
    role: string;
    attempted_runtimes: Array<{
      runtime: string;
      status: "success" | "failed" | "skipped";
      message?: string;
    }>;
    fallback_warnings?: string[];
  }>;
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
