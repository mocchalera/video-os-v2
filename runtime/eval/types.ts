// Editorial agreement eval — report type definitions.
//
// The eval harness measures how closely a candidate run's artifacts
// (selects, blueprint, timeline) agree with a human/operator-approved
// golden project. All metric scores are normalized to 0..1; the
// composite report exposes a 0..100 overall score.

// ── Matching primitives ─────────────────────────────────────────────

export type MatchKind = "exact" | "temporal";

export interface MatchableSegment {
  /** segment_id for selects, clip occurrence key for timelines */
  id: string;
  asset_id: string;
  src_in_us: number;
  src_out_us: number;
}

export interface SegmentMatchPair {
  golden: MatchableSegment;
  candidate: MatchableSegment;
  kind: MatchKind;
  iou: number;
}

export interface SegmentMatchResult {
  pairs: SegmentMatchPair[];
  unmatched_golden: MatchableSegment[];
  unmatched_candidate: MatchableSegment[];
}

// ── Stage reports ───────────────────────────────────────────────────

export interface SelectsAgreementReport {
  golden_count: number;
  candidate_count: number;
  matched_count: number;
  precision: number;
  recall: number;
  f1: number;
  /** Fraction of matched pairs whose role (hero/texture/...) agrees */
  role_agreement: number | null;
  /** Spearman correlation of semantic_rank over matched pairs (null if <3 pairs) */
  rank_correlation: number | null;
  /** Mean Jaccard of eligible_beats over matched pairs (null if unavailable) */
  beat_eligibility_overlap: number | null;
  missing_from_candidate: string[];
  extra_in_candidate: string[];
  score: number;
}

export interface TimelineAgreementReport {
  golden_clip_count: number;
  candidate_clip_count: number;
  matched_clip_count: number;
  /** F1 over clip occurrences (which segments were used, multiset) */
  clip_usage_f1: number;
  /** Longest-increasing-subsequence ratio over matched pairs (cut order) */
  order_agreement: number | null;
  /** Mean |src_in difference| over matched pairs, microseconds */
  mean_cut_in_deviation_us: number | null;
  /** Mean |duration difference| over matched pairs, frames */
  mean_duration_deviation_frames: number | null;
  /** |total duration delta| / golden total duration */
  total_duration_deviation_pct: number;
  /** Jaccard of beat_id sets weighted by per-beat duration-share deviation */
  beat_structure_score: number | null;
  score: number;
}

export interface BlueprintAgreementReport {
  golden_beat_count: number;
  candidate_beat_count: number;
  beat_count_score: number;
  /** LCS ratio over ordered canonical beat IDs. */
  beat_id_agreement: number;
  /** LCS ratio over the story_role sequence (null when either side lacks story roles) */
  story_role_agreement: number | null;
  /** Ordered equality of emotional_valence (null when absent on both sides). */
  emotional_valence_agreement: number | null;
  /** Ordered equality of evidence_required (null when absent on both sides). */
  evidence_required_agreement: number | null;
  /** 1 - mean |duration-share difference| over order-aligned beats */
  duration_share_score: number;
  /** Fraction of equal pacing cadence fields (opening/middle/ending) */
  pacing_agreement: number;
  /** Music policy agreement (entry beat + start_sparse) */
  music_agreement: number;
  score: number;
}

// ── LLM judge ───────────────────────────────────────────────────────

export interface LlmJudgeScores {
  /** Rule of Six-inspired dimensions, each 0..10 */
  emotion: number;
  story: number;
  rhythm: number;
  /** How close the candidate's editorial choices feel to the golden, 0..10 */
  agreement_with_golden: number;
}

export interface LlmJudgeReport {
  model: string;
  scores: LlmJudgeScores;
  /** 0..1 normalized composite of the four dimensions */
  score: number;
  rationale: string;
}

// ── Composite report ────────────────────────────────────────────────

export type EvalMode = "compare" | "self";

export interface EvalStageScores {
  selects?: SelectsAgreementReport;
  blueprint?: BlueprintAgreementReport;
  timeline?: TimelineAgreementReport;
}

export interface EvalReport {
  version: "1";
  mode: EvalMode;
  golden_project: string;
  candidate_project: string;
  evaluated_at: string;
  /** Who approved the golden — "operator" is human-tier ground truth */
  golden_approved_by: string | null;
  timeline_identity?: {
    golden_cut_identity: string;
    candidate_cut_identity: string;
    candidate_review_mode: "derived" | "legacy_canonical";
  };
  stages: EvalStageScores;
  llm_judge?: LlmJudgeReport | null;
  /** Weighted composite of available stage scores, 0..100 */
  overall_score: number;
  min_score: number | null;
  pass: boolean | null;
}

// ── Golden registry ─────────────────────────────────────────────────

export interface GoldenProject {
  project_id: string;
  project_dir: string;
  approved_by: string;
  approved_at: string | null;
  /** "human" when approved_by is operator, otherwise "agent" */
  tier: "human" | "agent";
  has_selects: boolean;
  has_blueprint: boolean;
  has_timeline: boolean;
  has_analysis: boolean;
}
