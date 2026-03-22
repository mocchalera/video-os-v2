// Transition Skill Card types for the cut transition system.
// See docs/cut-transition-design.md for full specification.

// ── Transition type vocabulary ──────────────────────────────────────

export type TransitionType =
  | "cut"
  | "crossfade"
  | "j_cut"
  | "l_cut"
  | "match_cut"
  | "fade_to_black";

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
  | "unknown";

export type ShotScale = "extreme_close" | "close" | "medium_close" | "medium" | "medium_wide" | "wide" | "extreme_wide" | "unknown";
export type CompositionAnchor = "left" | "center_left" | "center" | "center_right" | "right";
export type ScreenSide = "left" | "center" | "right" | "mixed";
export type GazeDirection = "left" | "camera" | "right" | "unknown";
export type CameraAxis = "ltr" | "rtl" | "neutral" | "unknown";

export interface AdjacencyFeatures {
  visual_tags: string[];
  motion_type: MotionType;
  shot_scale?: ShotScale;
  composition_anchor?: CompositionAnchor;
  screen_side?: ScreenSide;
  gaze_direction?: GazeDirection;
  camera_axis?: CameraAxis;
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
  bgm_snap_distance_frames?: number;
  duration_mode: "strict" | "guide";
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
}

export interface AdjacencyAnalysis {
  version: "1";
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
}

// ── BGM Analysis ────────────────────────────────────────────────────

export interface BgmSection {
  id: string;
  label: string;
  start_sec: number;
  end_sec: number;
  energy: number;
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
  };
  bpm: number;
  meter: string;
  duration_sec: number;
  beats_sec: number[];
  downbeats_sec: number[];
  sections: BgmSection[];
  editorial_arc_map?: BgmEditorialArcMap[];
  provenance: {
    detector: string;
    sample_rate_hz: number;
  };
}
