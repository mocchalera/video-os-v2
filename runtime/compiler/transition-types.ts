// Transition Skill Card types for the cut transition system.
// See docs/cut-transition-design.md for full specification.

// ── Transition type vocabulary ──────────────────────────────────────

export type TransitionType =
  | "cut"
  | "crossfade"
  | "j_cut"
  | "l_cut"
  | "match_cut"
  | "fade_to_black"
  // Issue #34 semantic presets (true A/B roll overlap engine)
  | "film_crossfade"
  | "light_leak_flash"
  | "dreamy_focus_blur";

/**
 * Transition types whose rendering requires a physical A/B roll overlap:
 * clip B extends its head `transition_frames` earlier so the renderer can
 * blend clip A's tail with clip B's head without changing the program
 * duration (Gap 0 / Overrun 0). See runtime/compiler/transition-overlap.ts.
 */
export const OVERLAP_TRANSITION_TYPES: ReadonlySet<TransitionType> = new Set([
  "film_crossfade",
  "light_leak_flash",
  "dreamy_focus_blur",
]);

/**
 * Issue #34 preset duration defaults (seconds). The issue's frame guidance
 * (film 10–12f / leak 6–8f / blur 12–15f) corresponds to ~30fps; seconds are
 * canonical and frames derive from the timeline fps.
 */
export const TRANSITION_PRESET_DEFAULT_CROSSFADE_SEC: Record<
  "film_crossfade" | "light_leak_flash" | "dreamy_focus_blur",
  number
> = {
  film_crossfade: 0.35,
  light_leak_flash: 0.2,
  dreamy_focus_blur: 0.45,
};

export type SkillScope = "adjacent_pair" | "scene_span";

// ── Murch weights ───────────────────────────────────────────────────

export interface MurchWeights {
  emotion: number;
  story: number;
  rhythm: number;
  eye_trace: number;
  plane_2d: number;
  space_3d: number;
}

// ── Predicate system ────────────────────────────────────────────────

export interface Predicate {
  path: string;
  op: "eq" | "neq" | "gt" | "gte" | "lt" | "lte" | "in" | "contains";
  value: string | number | boolean | string[];
}

export interface PredicateGroup {
  all?: Predicate[];
  any?: Predicate[];
}

// ── Viability gates ─────────────────────────────────────────────────

export interface ViabilityGate {
  id: string;
  predicate: PredicateGroup;
  failure_reason: string;
}

// ── Fallback chain ──────────────────────────────────────────────────

export interface FallbackStep {
  kind: "same_asset_punch_in" | "crossfade" | "freeze_hold" | "hard_cut" | "skip_skill";
  lower_to: "transition" | "clip_effect" | "marker_only";
  transition_type?: TransitionType;
  crossfade_sec?: number;
  hold_side?: "left" | "right";
  hold_frames?: number;
  punch_in_scale?: number;
}

// ── Pipeline effects ────────────────────────────────────────────────

export interface TransitionEffects {
  transition_type: TransitionType;
  crossfade_sec?: number;
  audio_overlap_sec?: number;
  zoom?: {
    enabled: boolean;
    start_scale: number;
    end_scale: number;
    anchor?: "face" | "center";
  };
  beat_snap?: "none" | "beat" | "downbeat";
  snap_anchor?: "cut_frame" | "transition_center";
}

// ── Transition Skill Card ───────────────────────────────────────────

export interface TransitionSkillCard {
  id: string;
  version: "1";
  scope: SkillScope;
  phase: "p0" | "p1";
  intent: string;
  audience_effect: string;
  murch_weights: MurchWeights;
  min_score_threshold: number;
  when: PredicateGroup;
  avoid_when?: PredicateGroup;
  minimum_viable: ViabilityGate[];
  fallback_order: FallbackStep[];
  pipeline_effects: TransitionEffects;
}

// ── PairEvidence ────────────────────────────────────────────────────

export type StoryRole = "hook" | "setup" | "experience" | "closing";
export type PeakType = "action_peak" | "emotional_peak" | "visual_peak";

export type MotionType =
  | "static"
  | "pan"
  | "tilt"
  | "push_in"
  | "pull_out"
  | "tracking"
  | "handheld"
  | "fast_action"
  | "reveal"
  | "subtle"
  | "continuous"
  | "intermittent"
  | "rapid"
  | "mixed"
  | "unknown"
  | "not_applicable";

export type ShotScale = "extreme_close" | "close" | "medium_close" | "medium" | "medium_wide" | "wide" | "extreme_wide" | "extreme_close_up" | "close_up" | "medium_close_up" | "insert" | "unknown" | "not_applicable";
export type CompositionAnchor = "left" | "center_left" | "center" | "center_right" | "right" | "balanced" | "multiple" | "full_frame" | "unknown" | "not_applicable";
export type ScreenSide = "left" | "center" | "right" | "mixed" | "multiple" | "full_frame" | "unknown" | "not_applicable";
export type GazeDirection = "left" | "camera" | "right" | "screen_left" | "screen_right" | "away" | "up" | "down" | "mixed" | "unknown" | "not_applicable";
export type CameraAxis = "ltr" | "rtl" | "neutral" | "axis_left" | "axis_right" | "on_axis" | "establishing" | "unknown" | "not_applicable";

export type EvidenceCoverageStatus = "known" | "unknown" | "not_applicable" | "missing";

export type SegmentEvidenceConfidenceGroup =
  | "tags"
  | "motion"
  | "framing"
  | "direction"
  | "appearance"
  | "text";

export interface SegmentEvidenceConfidence {
  score: number;
  evidence_refs: string[];
}

export interface FieldEvidenceCoverage {
  left: EvidenceCoverageStatus;
  right: EvidenceCoverageStatus;
  pair: EvidenceCoverageStatus;
}

export type DerivedEvidenceSource =
  | "canonical_metadata"
  | "candidate_metadata"
  | "none";

export interface DerivedFeatureEvidenceCoverage extends FieldEvidenceCoverage {
  source: {
    left: DerivedEvidenceSource;
    right: DerivedEvidenceSource;
  };
}

export type LegacySegmentEvidenceCoverage = Record<
  "visual_tags" | "motion_type" | "shot_scale" | "composition_anchor" | "screen_side" | "gaze_direction" | "camera_axis",
  EvidenceCoverageStatus
>;

export type ExtendedSegmentEvidenceCoverage = Partial<Record<
  "camera_motion_direction" | "subject_motion_direction" | "dominant_subject_type" | "avg_luma" | "dominant_colors" | "text_presence",
  EvidenceCoverageStatus
>>;

/** Existing fields stay required; EYE-030 fields are additive for old callers. */
export type SegmentEvidenceCoverage = LegacySegmentEvidenceCoverage & ExtendedSegmentEvidenceCoverage;

export type PairEvidenceCoverage = Record<keyof LegacySegmentEvidenceCoverage, FieldEvidenceCoverage> &
  Partial<Record<keyof ExtendedSegmentEvidenceCoverage, FieldEvidenceCoverage>> & {
  visual_tag_overlap_score?: DerivedFeatureEvidenceCoverage;
  semantic_cluster_change?: DerivedFeatureEvidenceCoverage;
  energy_delta_score?: DerivedFeatureEvidenceCoverage;
};

export interface AdjacencyFeatures {
  visual_tags: string[];
  motion_type: MotionType;
  shot_scale?: ShotScale;
  composition_anchor?: CompositionAnchor;
  screen_side?: ScreenSide;
  gaze_direction?: GazeDirection;
  camera_axis?: CameraAxis;
  camera_motion_direction?: "left" | "right" | "up" | "down" | "toward_camera" | "away_from_camera" | "mixed" | "unknown" | "not_applicable";
  subject_motion_direction?: "left" | "right" | "up" | "down" | "toward_camera" | "away_from_camera" | "mixed" | "unknown" | "not_applicable";
  dominant_subject_type?: "person" | "group" | "animal" | "object" | "landscape" | "architecture" | "text_graphic" | "mixed" | "unknown" | "not_applicable";
  avg_luma?: number;
  dominant_colors?: string[];
  text_presence?: "present" | "absent" | "unknown" | "not_applicable";
  confidence?: number;
}

export interface PairEvidence {
  left_candidate_ref: string;
  right_candidate_ref: string;
  same_asset: boolean;
  same_speaker_role: boolean;
  semantic_cluster_change: boolean;
  left_story_role?: StoryRole;
  right_story_role?: StoryRole;
  motif_overlap_score: number;
  setup_payoff_relation_score: number;
  visual_tag_overlap_score: number;
  motion_continuity_score: number;
  cadence_fit_score: number;
  shot_scale_continuity_score: number;
  composition_match_score: number;
  axis_consistency_score: number;
  axis_break_readiness_score: number;
  /** Signed right_energy - left_energy delta in [-1, 1]. */
  energy_delta_score: number;
  outgoing_silence_ratio: number;
  outgoing_afterglow_score: number;
  incoming_reaction_score: number;
  left_peak_strength_score?: number;
  right_peak_strength_score?: number;
  effective_peak_strength_score: number;
  left_peak_type?: PeakType;
  right_peak_type?: PeakType;
  effective_peak_type?: PeakType;
  has_b_roll_candidate: boolean;
  same_asset_gap_us?: number;
  visual_coherence_score?: number;
  visual_transition_hint?: "dissolve" | "hard_cut";
  bgm_snap_distance_frames?: number;
  duration_mode: "strict" | "guide";
  evidence_coverage?: PairEvidenceCoverage;
  evidence_diagnostics?: {
    shot_scale_continuity?: string;
  };
}

// ── Murch axis scores (resolved from PairEvidence) ──────────────────

export interface MurchAxisScores {
  emotion: number;
  story: number;
  rhythm: number;
  eye_trace: number;
  plane_2d: number;
  space_3d: number;
}

// ── Adjacency analysis output ───────────────────────────────────────

export interface AdjacencyPairResult {
  pair_id: string;
  left_clip_id?: string;
  right_clip_id?: string;
  left_candidate_ref: string;
  right_candidate_ref: string;
  selected_skill_id: string | null;
  selected_skill_score: number;
  min_score_threshold: number;
  transition_type: TransitionType;
  confidence: number;
  below_threshold: boolean;
  evidence: Partial<PairEvidence>;
  degraded_from_skill_id: string | null;
  selection_rationale?: SkillSelectionRationale;
  cut_relation?: CutRelationResult;
}

export type CutRelationship = "continuous" | "intentional_contrast" | "risky_jump" | "unknown";

export type CutRelationAxis =
  | "shot_scale"
  | "composition"
  | "gaze_axis"
  | "motion_flow"
  | "luma"
  | "dominant_color"
  | "asset_identity"
  | "visual_coherence"
  | "visual_tags"
  | "subject_type"
  | "text_presence"
  | "story_boundary";

export type CutRelationSignalCoverage = EvidenceCoverageStatus | "low_confidence";
export type CutRelationSignalEvaluation = "match" | "contrast" | "neutral" | "unknown";

export interface CutRelationSignal {
  coverage: CutRelationSignalCoverage;
  evaluation: CutRelationSignalEvaluation;
  major_discontinuity: boolean;
  raw: { left: unknown; right: unknown; pair?: unknown };
  raw_coverage: FieldEvidenceCoverage;
  source_refs: { left: string[]; right: string[] };
  confidence: { left: number | null; right: number | null };
  reason_codes: string[];
}

export interface ExplicitIntentEvidence {
  source: "beat_craft" | "human_annotation";
  source_ref: string;
  intent: string;
}

export interface CutRelationCoverageSummary {
  total_axes: number;
  comparable_axes: number;
  comparable_axis_ids: CutRelationAxis[];
  missing_axis_ids: CutRelationAxis[];
  unknown_axis_ids: CutRelationAxis[];
  not_applicable_axis_ids: CutRelationAxis[];
  low_confidence_axis_ids: CutRelationAxis[];
}

export interface CutRelationResult {
  relationship: CutRelationship;
  confidence: number;
  coverage: CutRelationCoverageSummary;
  reason_codes: string[];
  explicit_intent_evidence: ExplicitIntentEvidence[];
  signals: Record<CutRelationAxis, CutRelationSignal>;
}

export type SkillCardEvaluationReason =
  | "eligible"
  | "avoid_matched"
  | "when_failed"
  | "viability_failed"
  | "below_threshold";

export interface SkillCardEvaluation {
  skill_id: string;
  when_passed: boolean;
  avoid_matched: boolean;
  viability_passed: boolean;
  viability_gates: Array<{
    gate_id: string;
    passed: boolean;
    failure_reason: string;
  }>;
  score: number;
  threshold: number;
  threshold_passed: boolean;
  reason_code: SkillCardEvaluationReason;
}

export type SkillSelectionOutcome =
  | "selected"
  | "below_threshold_fallback"
  | "viability_fallback"
  | "no_eligible"
  | "craft_override"
  | "visual_override";

export interface SkillSelectionRationale {
  outcome: SkillSelectionOutcome;
  reason_codes: string[];
  active_cards: SkillCardEvaluation[];
  applied_skill_id: string | null;
  fallback_from_skill_id: string | null;
  override?: {
    kind: "craft" | "visual";
    selected_skill_id: string;
    replaced_outcome: Exclude<SkillSelectionOutcome, "craft_override" | "visual_override">;
  };
}

export interface AdjacencyAnalysis {
  version: "1" | "2";
  project_id: string;
  pairs: AdjacencyPairResult[];
}

// ── Timeline transition (emitted in timeline.json) ──────────────────

export interface TransitionParams {
  crossfade_sec?: number;
  audio_overlap_sec?: number;
  cut_frame_before_snap?: number;
  cut_frame_after_snap?: number;
  snap_delta_frames?: number;
  hold_side?: "left" | "right";
  hold_frames?: number;
  zoom?: {
    type: string;
    start_scale: number;
    end_scale: number;
  };
  beat_snapped?: boolean;
  beat_ref_sec?: number;
  /** Blend easing law. The A/B roll engine implements linear only. */
  easing?: "linear";
}

export interface TimelineTransition {
  transition_id: string;
  from_clip_id: string;
  to_clip_id: string;
  track_id: string;
  transition_type: TransitionType;
  transition_params?: TransitionParams;
  applied_skill_id?: string;
  degraded_from_skill_id?: string | null;
  confidence?: number;
  metadata?: Record<string, unknown>;
  fallback?: {
    type: TransitionType;
    reason: string;
  };
}

// ── BGM Analysis ────────────────────────────────────────────────────

export interface BgmSection {
  id: string;
  label: string;
  start_sec: number;
  end_sec: number;
  energy: number;
  /** Whether this cue came from measurement or a generated fallback. */
  evidence_classification?: "measured" | "synthetic" | "unavailable";
}

export interface BgmCueEvent {
  time_sec: number;
  strength: number;
  /** Whether this cue came from measurement or a generated fallback. */
  evidence_classification?: "measured" | "synthetic" | "unavailable";
}

export interface BgmEditorialArcMap {
  story_role: StoryRole;
  preferred_sections: string[];
}

export interface BgmAnalysis {
  version: "1";
  project_id: string;
  analysis_status: "ready" | "partial" | "failed";
  music_asset: {
    asset_id: string;
    path: string;
    source_hash?: string;
    source_content_sha256?: string;
  };
  bpm: number;
  meter: string;
  duration_sec: number;
  beats_sec: number[];
  downbeats_sec: number[];
  sections: BgmSection[];
  /** Measured onset cues, kept separate from the beat projection. */
  onsets?: BgmCueEvent[];
  /** Optional measured downbeat cues with per-cue confidence. */
  downbeats?: BgmCueEvent[];
  editorial_arc_map?: BgmEditorialArcMap[];
  provenance: {
    detector: string;
    /** Processing rate when the backend measured it; omitted when unavailable. */
    sample_rate_hz?: number;
    /** Source rate observed before any backend processing/resampling. */
    input_sample_rate_hz?: number;
    /** Rate actually used by the backend's analysis operation. */
    processing_sample_rate_hz?: number;
    /** Full source-content SHA-256 for canonical analysis artifacts. */
    source_content_sha256?: string;
    backend_name?: string;
    backend_version?: string;
    hop_length_samples?: number;
    window_length_samples?: number;
    time_unit?: "seconds";
    evidence_classification?: "measured" | "synthetic" | "unavailable";
    measurement_status?: "complete" | "partial" | "unavailable";
    tempo_confidence?: number;
    fallback_used?: boolean;
  };
}
