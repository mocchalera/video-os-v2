// Shared types for the timeline compiler.
// These mirror the YAML/JSON artifact shapes used across phases.

import type { RegisteredVisualIntent, VisualFramingProvenance } from "../visual/types.js";
import type { ResolutionReport } from "./resolve.js";

// ── Duration Mode types ─────────────────────────────────────────────

export type DurationMode = "strict" | "guide";
export type TrackLayout = "single" | "multi";
export type CaptionPolicySource = "transcript" | "authored" | "none";
export type BriefCaptionPolicy = "auto" | "manual" | "off";
export type CaptionRevealRole = "punchline" | "surprise" | "reaction" | "payoff";

export interface CaptionRevealAnchor {
  anchor_id: string;
  role: CaptionRevealRole;
  anchor_text: string;
  segment_id?: string;
  transcript_item_id?: string;
  timeline_frame?: number;
  source_start_us?: number;
  audio_first_frames?: number;
}

export interface CaptionSemanticTimingPolicy {
  mode: "off" | "speech_sync" | "protect_reveals";
  ordinary_lead_frames?: number;
  audio_first_frames?: number;
  question_audio_first_frames?: number;
  gap_ownership?: "previous" | "blank";
  anchors?: CaptionRevealAnchor[];
}
export type BriefAudioPolicy = "ducking" | "bgm_only" | "original_only" | "music_master";
export type NarrativeMode = "personal_challenge" | "day_log";
export type SelectStoryRole = "hook" | "setup" | "experience" | "payoff" | "reaction" | "closing";

export interface DurationPolicy {
  mode: DurationMode;
  source: "explicit_brief" | "profile_default" | "global_default";
  target_source: "explicit_brief" | "material_total";
  target_duration_sec: number;
  min_duration_sec: number;
  max_duration_sec: number | null;
  hard_gate: boolean;
  protect_vlm_peaks: boolean;
}

// ── Input artifact types ────────────────────────────────────────────

export interface CreativeBriefEditorial {
  distribution_channel?: string;
  aspect_ratio?: "16:9" | "9:16" | "1:1" | "4:5" | "unknown";
  embed_context?: string;
  hook_priority?: string;
  credibility_bias?: string;
  profile_hint?: string;
  policy_hint?: string;
  allow_inference?: boolean;
}

export interface LongformEditConfig {
  mode?: "reduction";
  source_selection?: "auto_primary_lane" | "all" | "explicit";
  primary_asset_ids?: string[];
  min_window_sec?: number;
  max_window_sec?: number;
  silence_gap_cut_sec?: number;
  chapter_max_sec?: number;
  coverage_interval_sec?: number;
}

/**
 * Canonical brief-side declaration for an independent full-song master.
 * The compiler copies this declaration into TimelineIR provenance; the audio
 * plan resolver then binds it to the project file bytes before rendering.
 */
export interface CreativeBriefMusicMaster {
  asset_id?: string;
  source_ref: string;
  source_content_hash: string;
  source_size_bytes: number;
  source_duration_us: number;
  source_range_us?: { in_us: number; out_us: number };
  timeline_range?: { in_frame: number; out_frame: number };
  gain_linear?: 1;
  audio_decision?: "preserve" | "mastering";
  channel_layout?: string;
  codec?: string;
  processing_graph?: {
    version: "audio-processing-graph/v1";
    operations: Array<"stream_copy" | "trim_reencode" | "shared_final_mastering">;
  };
  measurement_tolerance?: {
    integrated_lufs_db: number;
    lra_lu: number;
    true_peak_dbtp: number;
  };
  policy_hash?: string;
}

export type LongformExclusionReason =
  | "alternate_angle_lane"
  | "duplicate_utterance"
  | "filler_only"
  | "housekeeping"
  | "invalid_transcript"
  | "silence_gap"
  | "low_priority_for_target"
  | "short_fragment";

export interface LongformExclusion {
  asset_id: string;
  src_in_us: number;
  src_out_us: number;
  reason: LongformExclusionReason;
  utterance_ids?: string[];
}

export interface LongformChapter {
  id: string;
  label: string;
  asset_ids: string[];
  source_in_us: number;
  source_out_us: number;
  available_duration_us: number;
  selected_duration_us: number;
  candidate_refs: string[];
  beat_ids?: string[];
}

export interface LongformPlan {
  version: "1";
  mode: "reduction";
  source_selection: "auto_primary_lane" | "all" | "explicit";
  selected_asset_ids: string[];
  excluded_asset_ids: string[];
  source_duration_us: number;
  speech_duration_us: number;
  target_duration_us: number;
  selected_duration_us: number;
  keep_ratio: number;
  coverage_status: "ready" | "insufficient";
  chapters: LongformChapter[];
  exclusions: LongformExclusion[];
}

export interface CreativeBrief {
  version: string;
  project_id: string;
  project: { id: string; title: string; strategy: string; runtime_target_sec?: number; duration_mode?: DurationMode };
  message: { primary: string; secondary?: string[] };
  emotion_curve: string[];
  narrative_mode?: NarrativeMode;
  subject?: { birth_date?: string };
  order_policy?: "chronological" | "editorial";
  caption_policy?: BriefCaptionPolicy;
  audio_policy?: BriefAudioPolicy;
  music_master?: CreativeBriefMusicMaster;
  a1_loudnorm?: boolean;
  editorial?: CreativeBriefEditorial;
  longform?: LongformEditConfig;
  still_image_intent?: StillImageIntentPolicy;
  [key: string]: unknown;
}

export interface CandidatePlan {
  primary_candidate_ref?: string;
  fallback_candidate_refs?: string[];
  still_image?: StillImageCandidateIntent;
  freeze_frame_hold?: FreezeFrameHoldIntent;
}

export type StillCameraMotionPreset =
  | "push_in"
  | "pull_out"
  | "horizontal_tracking"
  | "tilt_down"
  | "diagonal_drift"
  | "pan_zoom";

export type StillHoldUnit = "frames" | "seconds" | "beats" | "section_boundary";

/** Authored hold unit. The original unit is retained through compilation. */
export interface StillHoldIntent {
  unit: StillHoldUnit;
  /** Frames, seconds, or beat count. Section-boundary holds may omit it. */
  value?: number;
  section_id?: string;
  boundary?: "start" | "end";
  /** Required by lyric_mv when a hold exceeds the normal background cadence. */
  reason?: string;
}

/** Resolved frame projection carried beside the authored hold. */
export interface StillHoldResolution {
  unit: StillHoldUnit;
  requested_frames: number;
  resolved_frames: number;
  requested_value?: number;
  section_id?: string;
  boundary?: "start" | "end";
  boundary_frame?: number;
  status: "resolved" | "clamped";
}

/** Per-instance still framing in normalized source coordinates. */
export interface StillImageTransform {
  crop?: { x: number; y: number; width: number; height: number };
  scale?: number;
  pan?: { x: number; y: number };
  zoom?: number;
  anchor?: { x: number; y: number };
}

/** Small, explicit in-frame parallax carried into the camera-motion worker. */
export interface StillParallaxIntent {
  amount: number;
  axis: "horizontal" | "vertical" | "both";
}

export interface StillCameraMotionIntent {
  preset: StillCameraMotionPreset;
  easing?: "smoothstep" | "linear";
  intensity?: number;
  transform?: StillImageTransform;
  parallax?: StillParallaxIntent;
}

/** Readable alias for authored Ken Burns intent in lyric_mv plans. */
export type StillKenBurnsIntent = StillCameraMotionIntent;

export interface StillCameraMotionPlan extends StillCameraMotionIntent {
  easing: "smoothstep" | "linear";
  intensity: number;
  /** Displayed frame count the motion is synchronized to (== hold_frames). */
  frame_count: number;
  policy: "still-camera-motion/v1";
}

export interface StillImageIntentPolicy {
  min_hold_sec?: number;
  default_hold_sec?: number;
  max_hold_sec?: number;
  motion_mode?: "static" | "subtle_ken_burns";
  camera_motion?: StillCameraMotionIntent;
  ken_burns?: StillKenBurnsIntent;
  parallax?: StillParallaxIntent;
  transform?: StillImageTransform;
  hold?: StillHoldIntent;
  long_hold_reason?: string;
  fit_mode?: "contain" | "cover" | "full_bleed";
  background?: string;
  composition?: "fit" | "vertical_blur_backdrop";
}

export interface StillImageCandidateIntent extends StillImageIntentPolicy {
  hold_duration_sec?: number;
  source_still_id?: string;
  still_instance_id?: string;
  reuse?: "unique" | "intentional";
}

export interface StillDurationPolicy {
  source: "explicit_brief" | "profile_default" | "global_default";
  fps_num: number;
  fps_den: number;
  min_hold_frames: number;
  default_hold_frames: number;
  max_hold_frames: number;
  motion_mode: "static";
  requested_motion_mode?: "subtle_ken_burns";
  motion_status?: "pending_EYE-070C2B";
  camera_motion?: StillCameraMotionIntent;
  ken_burns?: StillKenBurnsIntent;
  parallax?: StillParallaxIntent;
  transform?: StillImageTransform;
  composition?: "fit" | "vertical_blur_backdrop";
  fit_mode: "contain" | "cover" | "full_bleed";
  background: string;
}

export interface StillImageTimelineMetadata {
  hold_frames: number;
  min_hold_frames: number;
  max_hold_frames: number;
  hold_source: "candidate_override" | "explicit_brief" | "profile_default" | "global_default";
  policy_clamp: "none" | "min" | "max" | "beat_budget" | "duration_cap";
  hold?: StillHoldIntent;
  hold_resolution?: StillHoldResolution;
  source_still_id?: string;
  still_instance_id?: string;
  reuse?: "unique" | "intentional";
  long_hold_reason?: string;
  motion_mode: "static" | "camera_motion";
  requested_motion_mode?: "subtle_ken_burns";
  motion_status?: "pending_EYE-070C2B";
  /** Executable subpixel camera plan; presence means renderers must move. */
  camera_motion?: StillCameraMotionPlan;
  ken_burns?: StillCameraMotionPlan;
  parallax?: StillParallaxIntent;
  transform?: StillImageTransform;
  /** Optional authored override of the automatic vertical composition. */
  composition?: "fit" | "vertical_blur_backdrop";
  fit_mode: "contain" | "cover" | "full_bleed";
  background: string;
}

export interface FreezeFrameHoldIntent {
  /** Absolute source-media time of the authored freeze frame. */
  source_time_us: number;
  /** Optional authored hold. The active skill supplies a provisional default. */
  hold_frames?: number;
}

export interface FreezeFrameHoldTimelineMetadata {
  /** Absolute source-media time of the frame duplicated by the renderer. */
  source_time_us: number;
  hold_frames: number;
  hold_source: "candidate_override" | "skill_default";
  policy_clamp: "none" | "min" | "max";
  policy: "apex-freeze-hold/v1";
}

export interface AllowRevisitDirective {
  semantic_cluster_ids?: string[];
  asset_ids?: string[];
  reason?: string;
}

export type AllowRevisit = boolean | AllowRevisitDirective;

export type CraftInPoint =
  | "cut_on_action"
  | "peak_hold"
  | "pre_roll_enter"
  | "post_action_hold"
  | "clean_in_clean_out";

export type CraftOutPoint =
  | "cut_on_action"
  | "peak_hold"
  | "post_action_hold"
  | "clean_in_clean_out";

export type CraftTransition =
  | "hard_cut"
  | "dissolve"
  | "dip_to_black"
  | "j_cut"
  | "l_cut"
  | "match_cut"
  // Issue #34 semantic presets (craft directives map 1:1 to transition types)
  | "film_crossfade"
  | "light_leak_flash"
  | "dreamy_focus_blur";

export type CraftRhythm =
  | "accelerando"
  | "ritardando"
  | "steady"
  | "syncopated"
  | "breath";

export type CraftShotProgression =
  | "wide_to_close"
  | "close_to_wide"
  | "scale_match"
  | "free";

export interface CraftDirective {
  in_point?: CraftInPoint;
  out_point?: CraftOutPoint;
  transition_in?: CraftTransition;
  transition_out?: CraftTransition;
  rhythm?: CraftRhythm;
  shot_progression?: CraftShotProgression;
  beat_sync?: boolean;
  hold_duration_bias?: number;
  flash_cut?: boolean;
}

export interface Beat {
  id: string;
  label: string;
  /** Audience-facing chapter/section copy. Structural labels stay in `label`. */
  viewer_label?: string;
  purpose?: string;
  target_duration_frames: number;
  required_roles: Role[];
  preferred_roles?: Role[];
  notes?: string;
  // M4.5 additive fields
  story_role?: "hook" | "setup" | "experience" | "closing";
  /** Provisional emotional position for future curve audits. */
  emotional_valence?: number;
  /** Whether this beat's claim must be backed by source-grounded evidence. */
  evidence_required?: boolean;
  craft?: CraftDirective;
  skill_hints?: string[];
  candidate_plan?: CandidatePlan;
  allow_revisit?: AllowRevisit;
  candidate_constraints?: {
    allow_interviewer_support?: boolean;
    force_unique_utterances?: boolean;
  };
}

export type StoryArcStrategy = "chronological" | "peak_first" | "testimonial_highlight" | "problem_to_solution" | "release_after_peak";

export interface StoryArc {
  summary?: string;
  strategy?: StoryArcStrategy;
  chronology_bias?: string;
  allow_time_reorder?: boolean;
  causal_links?: string[];
}

export interface ResolvedRef {
  id?: string;
  source?: "explicit_hint" | "inferred" | "default";
  rationale?: string;
}

export interface DedupeRules {
  utterance_consumption?: "unique" | "allow_repeat";
  semantic_similarity_threshold?: number;
  allow_intentional_repetition?: boolean;
}

export interface QualityTargets {
  hook_density_min?: number;
  novelty_rate_min?: number;
  duration_pacing_tolerance_pct?: number;
  emotion_gradient_min?: number;
  causal_connectivity_min?: number;
}

export interface TrimPolicy {
  mode?: "adaptive" | "fixed" | "center_first";
  default_preferred_duration_frames?: number;
  default_min_duration_frames?: number;
  default_max_duration_frames?: number;
  action_cut_guard?: boolean;
}

export interface ConfirmedPreferences {
  mode: "full" | "collaborative";
  source: "human_confirmed" | "ai_autonomous";
  duration_target_sec: number;
  confirmed_at: string;
  structure_choice?: string;
  pacing_notes?: string;
}

export interface TransitionPolicy {
  prefer_match_texture_over_flashy_fx: boolean;
  allow_hard_cuts?: boolean;
  allow_crossfade_for_time_passage?: boolean;
  avoid_speed_ramps?: boolean;
  dissolve_overlap_frames?: number;
  keep_milestone_cuts_clean?: boolean;
}

export interface EndingPolicy {
  should_feel: string;
  final_line_strategy?: string;
  avoid_cta?: boolean;
  final_hold_min_frames?: number;
  final_visual_strategy?: string;
  final_audio_strategy?: string;
  tail_hold_sec?: number;
  audio_fade_out_sec?: number;
  video_fade_out_sec?: number;
  video_fade_color?: "none" | "black" | "white";
}

export interface EditBlueprint {
  version: string;
  project_id: string;
  created_at?: string;
  decision_runtime?: DecisionRuntimeMetadata;
  source_media?: SourceMediaSummary;
  sequence_goals: string[];
  beats: Beat[];
  pacing: {
    opening_cadence: string;
    middle_cadence: string;
    ending_cadence: string;
    max_shot_length_frames?: number;
    default_duration_target_sec?: number;
    confirmed_preferences?: ConfirmedPreferences;
  };
  music_policy: {
    start_sparse: boolean;
    allow_release_late: boolean;
    entry_beat: string;
    avoid_anthemic_lift?: boolean;
    permitted_energy_curve?: string;
    bgm_asset_id?: string;
    bgm_segment_id?: string;
    bgm_duration_sec?: number;
  };
  caption_policy?: {
    language?: string;
    delivery_mode?: "burn_in" | "sidecar" | "both";
    source?: CaptionPolicySource;
    styling_class?: string;
    semantic_timing?: CaptionSemanticTimingPolicy;
  };
  dialogue_policy: {
    preserve_natural_breath: boolean;
    avoid_wall_to_wall_voiceover: boolean;
    prioritize_lines?: string[];
    /** Source post-roll retained after each dialogue cut. Opt-in for timing compatibility. */
    cut_tail_hold_sec?: number;
    /** Minimum fade used when retained post-roll reaches the next utterance. */
    cut_audio_fade_out_sec?: number;
  };
  transition_policy?: TransitionPolicy;
  ending_policy?: EndingPolicy;
  rejection_rules?: string[];
  // M4.5 additive fields
  story_arc?: StoryArc;
  resolved_profile?: ResolvedRef;
  resolved_policy?: ResolvedRef;
  active_editing_skills?: string[];
  dedupe_rules?: DedupeRules;
  quality_targets?: QualityTargets;
  trim_policy?: TrimPolicy;
  // Duration Mode additive field
  duration_policy?: DurationPolicy;
  still_duration_policy?: StillDurationPolicy;
  // Timeline ordering: chronological (source timestamp) or editorial (score-based)
  timeline_order?: "chronological" | "editorial";
  // Track layout: single keeps visual story on V1; multi preserves overlay-style V2 inserts.
  track_layout?: TrackLayout;
  longform_plan?: LongformPlan;
  /** Blueprint v2 policy/profile references. Values stay in their source artifacts. */
  policy_refs?: BlueprintPolicyRefs;
  /** Registered visual transforms/cuts; source evidence stays in the Blueprint. */
  visual_intents?: RegisteredVisualIntent[];
  /** Optional explicit v2 sequence intent; v1 blueprints do not acquire locks. */
  hook_sequence?: BlueprintSequence;
  body_sequence?: BlueprintSequence;
  /** Short aliases accepted by the v2 sanitizer for hand-authored fixtures. */
  hook?: BlueprintSequence;
  body?: BlueprintSequence;
  /** Explicitly authorized non-coverage operations such as an intentional gap or hold. */
  timeline_operations?: IntentionalGapOperation[];
  /** Explicit mix policy authorizing a primary audio lane that is not wall-to-wall. */
  audio_mix_policy?: PrimaryAudioMixPolicy;
  [key: string]: unknown;
}

export interface BlueprintPolicyReference {
  ref: string;
  version?: string;
  source_hash?: string;
  profile_hash?: string;
}

export interface BlueprintPolicyRefs {
  composition_policy_ref?: BlueprintPolicyReference;
  vertical_composition_policy_ref?: BlueprintPolicyReference;
  retention_policy_ref?: BlueprintPolicyReference;
  caption_policy_ref?: BlueprintPolicyReference;
  platform_safe_zone_profile_ref?: BlueprintPolicyReference;
  audio_delivery_profile_ref?: BlueprintPolicyReference;
  sfx_library_ref?: BlueprintPolicyReference;
}

export interface BlueprintShotAnchor {
  anchor_id: string;
  asset_id: string;
  source_content_hash: string;
  segment_id: string;
  src_in_us: number;
  src_out_us: number;
  transcript_item_ids?: string[];
  source_start_us?: number;
  source_end_us?: number;
}

export interface BlueprintShot {
  shot_id: string;
  beat_id?: string;
  scene_type?: string;
  shot_anchor?: BlueprintShotAnchor;
  candidate_ref?: string;
}

export interface BlueprintSequence {
  sequence_id: string;
  locked?: boolean;
  lock_revision?: number;
  shots: BlueprintShot[];
}

export interface ShotAnchorEvidence {
  source_content_hash: string;
  source_range: {
    src_in_us: number;
    src_out_us: number;
  };
  source_identity: {
    asset_id: string;
    segment_id: string;
  };
  evidence_source: "source_map" | "assets" | "provided";
}

export interface ResolvedShotAnchor {
  sequence_id: string;
  sequence_kind: "hook" | "body";
  shot_id: string;
  beat_id?: string;
  scene_type?: string;
  anchor_id: string;
  asset_id: string;
  segment_id: string;
  source_content_hash: string;
  src_in_us: number;
  src_out_us: number;
  candidate_ref: string;
  evidence: ShotAnchorEvidence;
}

export interface ShotAnchorResolutionProvenance {
  policy: "shot-anchor-resolution/v1";
  fingerprint: string;
  anchors: ResolvedShotAnchor[];
}

export interface HookLockProvenance {
  policy: "hook-lock/v1";
  locked: true;
  sequence_id: string;
  lock_revision: number;
  fingerprint: string;
  anchor_ids: string[];
  protected_clip_ids: string[];
  protected_beat_ids: string[];
  reason: "explicit_blueprint_lock" | "preserved_existing_lock";
}

export type Role = "hero" | "support" | "transition" | "texture" | "dialogue";
export type ClipRole = Role | "music" | "nat_sound" | "bgm" | "sfx" | "music_master" | "title";
export type SourceMediaKind = "video" | "audio" | "image" | "sequence" | "unknown";
export type AudioSemanticRole = "dialogue" | "music" | "nat_sound" | "ambient" | "sfx" | "music_master";

export interface SourceCapabilities {
  has_video: boolean;
  has_audio: boolean;
}

export interface SourceMediaSummary {
  mode: "video" | "audio_only" | "mixed";
  media_kinds: SourceMediaKind[];
  visual_candidate_count: number;
  audio_only_candidate_count: number;
}

export interface TrimHint {
  source_center_us?: number;
  preferred_duration_us?: number;
  min_duration_us?: number;
  max_duration_us?: number;
  window_start_us?: number;
  window_end_us?: number;
  interest_point_label?: string;
  interest_point_confidence?: number;
  // Peak-aware extensions (vlm-peak-detection-design.md §7.2)
  peak_ref?: string;
  peak_type?: "action_peak" | "emotional_peak" | "visual_peak";
  center_source?: "refine_filmstrip" | "precision_dense_frames" | "precision_proxy_clip" | "interest_point_fallback" | "midpoint_fallback";
  rationale?: string;
  recommended_in_us?: number;
  recommended_out_us?: number;
}

export interface EditorialSignals {
  silence_ratio?: number;
  afterglow_score?: number;
  speech_intensity_score?: number;
  reaction_intensity_score?: number;
  authenticity_score?: number;
  surprise_signal?: number;
  hope_signal?: number;
  face_detected?: boolean;
  visual_tags?: string[];
  semantic_cluster_id?: string;
  // Peak-aware extensions (vlm-peak-detection-design.md §7.2)
  peak_ref?: string;
  peak_strength_score?: number;
  motion_energy_score?: number;
  audio_energy_score?: number;
  peak_type?: "action_peak" | "emotional_peak" | "visual_peak";
  peak_source_pass?: string;
}

export interface PeakSignals {
  motion?: number;
  audio_rms?: number;
  speech_keyword?: string[];
}

export type QualityGateDecision = "reject" | "warn" | "pass" | "unmeasured" | "not_applicable";
export type QualityConfidence = "measured" | "partial" | "appraiser" | "low" | "not_applicable";

export interface QualityGateMeasurements {
  shake_score?: number;
  sharpness_score?: number;
  exposure_score?: number;
  black_clip_ratio?: number;
  white_clip_ratio?: number;
  composition_score?: number;
  subject_prominence?: number;
}

export interface QualityGateThresholds {
  shake_reject_above: number;
  shake_warn_above: number;
  sharpness_reject_below: number;
  sharpness_warn_below: number;
  exposure_crush_reject_above: number;
  exposure_crush_warn_above: number;
  exposure_clip_reject_above: number;
  exposure_clip_warn_above: number;
  appraiser_composition_reject_below: number;
  appraiser_subject_prominence_reject_below: number;
  appraiser_composition_warn_below: number;
  appraiser_subject_prominence_warn_below: number;
}

export interface QualityGateRecord {
  candidate_id?: string;
  segment_id: string;
  decision: QualityGateDecision;
  confidence: QualityConfidence;
  reasons: string[];
  measurements: QualityGateMeasurements;
  thresholds: QualityGateThresholds;
  protected_by?: string[];
}

export interface SelectsQualityGateSummary {
  version: string;
  policy: string;
  counts: {
    reject: number;
    warn: number;
    pass: number;
    unmeasured: number;
    not_applicable?: number;
  };
  decisions: QualityGateRecord[];
}

export interface SelectsCoverageConfig {
  min_candidates_per_cluster: number;
  cluster_sampling_scale: "none" | "sqrt";
  max_candidates_per_cluster: number;
}

export interface SelectsCoverageCluster {
  cluster_id: string;
  cluster_size: number;
  required_count: number;
  selected_count: number;
  status: "met" | "unmet" | "exempt_all_rejected";
  segment_ids: string[];
  selected_segment_ids: string[];
  unused_segment_ids: string[];
  quality_rejected_segment_ids: string[];
  exempt_reason?: string;
}

export interface SelectsCoverageMustHave {
  item: string;
  status: "met" | "unmet";
  matched_segment_ids: string[];
}

export interface SelectsCoverageUnmetItem {
  type: "cluster_minimum" | "must_have";
  id: string;
  message: string;
  cluster_id?: string;
  must_have?: string;
  required_count?: number;
  selected_count?: number;
  unused_segment_ids?: string[];
}

export interface SelectsCoverageSummary {
  version: "1";
  policy: string;
  status: "met" | "failed";
  config: SelectsCoverageConfig;
  clusters: SelectsCoverageCluster[];
  must_have: SelectsCoverageMustHave[];
  unmet: SelectsCoverageUnmetItem[];
  notes?: string[];
}

export interface EditorialSummary {
  dominant_visual_mode?: "talking_head" | "screen_demo" | "event_broll" | "mixed" | "unknown";
  speaker_topology?: "solo_primary" | "interviewer_guest" | "multi_speaker" | "unknown";
  motion_profile?: "low" | "medium" | "high" | "unknown";
  transcript_density?: "sparse" | "medium" | "dense" | "unknown";
}

export interface Candidate {
  segment_id: string;
  asset_id: string;
  src_in_us: number;
  src_out_us: number;
  role: Role | "reject";
  why_it_matches: string;
  risks: string[];
  confidence: number;
  media_kind?: SourceMediaKind;
  source_capabilities?: SourceCapabilities;
  audio_role?: AudioSemanticRole;
  semantic_rank?: number;
  quality_flags?: string[];
  evidence?: string[];
  eligible_beats?: string[];
  story_role?: SelectStoryRole;
  transcript_excerpt?: string;
  motif_tags?: string[];
  rejection_reason?: string;
  // M4.5 additive fields
  candidate_id?: string;
  utterance_ids?: string[];
  speaker_role?: "primary" | "interviewer" | "secondary" | "unknown";
  semantic_dedupe_key?: string;
  editorial_signals?: EditorialSignals;
  peak_signals?: PeakSignals;
  trim_hint?: TrimHint;
  still_image?: StillImageCandidateIntent;
  freeze_frame_hold?: FreezeFrameHoldIntent;
  quality_confidence?: QualityConfidence;
  quality_gate?: QualityGateRecord;
}

export interface DecisionRuntimeMetadata {
  runtime: string;
  role?: string;
  author?: "llm" | "deterministic_fallback" | "human" | "agent_evidence_synthesis";
  attempted_runtimes?: Array<{
    runtime: string;
    status: "success" | "failed" | "skipped";
    message?: string;
    error_kind?: "transport_timeout" | "transport_error" | "json_parse" | "schema_validation";
  }>;
  fallback_warnings?: string[];
}

export interface SelectsCandidates {
  version: string;
  project_id: string;
  decision_runtime?: DecisionRuntimeMetadata;
  candidates: Candidate[];
  source_media?: SourceMediaSummary;
  editorial_summary?: EditorialSummary;
  quality_gate?: SelectsQualityGateSummary;
  coverage?: SelectsCoverageSummary;
  longform_plan?: LongformPlan;
  [key: string]: unknown;
}

export interface ScoringParams {
  motif_reuse_max: number;
  adjacency_penalty: number;
  beat_alignment_tolerance_frames: number;
  duration_fit_tolerance_frames: number;
  quality_flag_penalty: number;
}

export interface SkillEffect {
  score_bonus?: number;
  score_penalty?: number;
  transition_override?: string;
  trim_bias?: number;
  duration_bias_frames?: number;
  metadata_tags?: string[];
  /**
   * talking_head_pacing increment 1: snap clip in/out to the nearest
   * transcript utterance boundary so cuts land on phrase edges instead of
   * mid-word (satisfies review metric audio.speech_cut). Pure trim refinement;
   * filler excision / pause tightening remain deferred (need within-beat IR).
   */
  utterance_boundary_snap?: boolean;
  /** Max distance (us) a clip boundary may move to reach an utterance edge. */
  utterance_snap_tolerance_us?: number;
  /** Resolve explicitly-authored source freeze frames into timeline holds. */
  apex_freeze_hold?: boolean;
  freeze_hold_min_sec?: number;
  freeze_hold_default_sec?: number;
  freeze_hold_max_sec?: number;
}

export interface SkillDefinition {
  id: string;
  category: "linear_sequence" | "trim" | "metadata";
  primary_phase: "normalize" | "score" | "assemble" | "resolve" | "export";
  required_signals: string[];
  when: string[];
  avoid_when: string[];
  effects: SkillEffect;
  status?: "active" | "deferred_ir_required";
}

export interface LyricMvCadenceThreshold {
  min_sec: number;
  target_sec: number;
  max_sec: number;
}

export interface LyricMvBackgroundHoldThreshold extends LyricMvCadenceThreshold {
  intentional_long_hold_sec: number;
}

/** Typed cadence contract for the music-led still-image lyric_mv profile. */
export interface LyricMvProfileThresholds {
  background_hold: LyricMvBackgroundHoldThreshold;
  caption_cadence: LyricMvCadenceThreshold;
  music_section_cadence: LyricMvCadenceThreshold;
  motion_cadence: LyricMvCadenceThreshold;
}

export interface LyricMvTimelineMetadata {
  version: "lyric-mv/v1";
  profile_id: "lyric_mv";
  thresholds: LyricMvProfileThresholds;
  music_sections: Array<{
    id: string;
    label: string;
    start_frame: number;
    end_frame: number;
    evidence_classification?: "measured" | "synthetic" | "unavailable";
  }>;
  music_events: Array<{
    kind: "onset" | "section_start";
    frame: number;
    section_id?: string;
    provenance: string;
    evidence_classification?: "measured" | "synthetic" | "unavailable";
  }>;
}

export interface ProfileDefaults {
  target_duration_sec?: number;
  opening_cadence?: string;
  middle_cadence?: string;
  ending_cadence?: string;
  max_shot_length_frames?: number;
  default_transition?: string;
  crossfade_frames?: number;
  adjacency_penalty_overrides?: Partial<ScoringParams>;
  active_editing_skills?: string[];
  quality_target_overrides?: Partial<QualityTargets>;
  trim_policy_overrides?: Partial<TrimPolicy>;
  audio_policy?: BriefAudioPolicy;
  a1_loudnorm?: boolean;
  caption_policy?: BriefCaptionPolicy;
  still_image_intent?: StillImageIntentPolicy;
  lyric_mv_thresholds?: LyricMvProfileThresholds;
}

export interface ProfileDefinition {
  id: string;
  defaults: ProfileDefaults;
  default_policy?: string;
  capabilities?: {
    visual_model?: {
      requirement: "required" | "optional";
      provider?: string;
      model?: string;
    };
    visual_qa?: {
      requirement: "required" | "optional";
      provider?: string;
      model?: string;
    };
  };
}

export interface PolicyDefinition {
  id: string;
  story_arc_strategy?: StoryArcStrategy;
  chronology_bias?: string;
  allow_time_reorder?: boolean;
  preserve_natural_breath?: boolean;
  avoid_wall_to_wall_voiceover?: boolean;
  skill_suppressions?: string[];
  skill_enforcements?: string[];
}

export interface CompilerDefaults {
  version: string;
  scoring: ScoringParams;
  beat_sync?: {
    cut_quantize?: "auto" | "on" | "off";
    max_shift_frames?: number;
  };
  /** Issue #35 rhythm sync: multi-source rhythm snap config. */
  rhythm_sync?: {
    mode?: "auto" | "on" | "off";
    search_window_sec?: number;
    max_shift_frames?: number;
    parity_max_offset_frames?: number;
    /** Minimum per-cue confidence for measured onset/section/downbeat snaps. */
    min_cue_confidence?: number;
    /**
     * Chorus parity gate. "enforce" (default): a chorus section whose start
     * stays beyond parity_max_offset_frames of the nearest primary V1 cut
     * after snapping blocks the canonical compile (RhythmParityGateError).
     * "off" is the explicit, documented opt-out: parity is still measured
     * and stamped honestly, but never blocks the compile.
     */
    parity_gate?: "enforce" | "off";
  };
  continuity?: Partial<ContinuityPolicy>;
}

export type ContinuityRepeatPolicy = "reorder_or_fail" | "warn" | "off";

export interface ContinuityPolicy {
  same_asset_repeat: ContinuityRepeatPolicy;
  same_cluster_repeat: ContinuityRepeatPolicy;
}

export interface ContinuityReorderEvent {
  code: "beat_semantic_cluster_order" | "beat_same_asset_coalesce";
  track_id: string;
  beat_id: string;
  before_clip_ids: string[];
  after_clip_ids: string[];
  reason: string;
}

export interface ContinuityRun {
  track_ids: string[];
  beat_ids: string[];
  clip_ids: string[];
  segment_ids: string[];
  asset_ids: string[];
  start_frame: number;
  end_frame: number;
}

export interface ContinuityIssue {
  code: "same_asset_non_adjacent" | "same_cluster_non_adjacent";
  severity: "warning" | "error";
  key: string;
  asset_id?: string;
  semantic_cluster_id?: string;
  runs: ContinuityRun[];
  message: string;
  suggested_fix: string;
}

export interface ContinuityExemption {
  code: "allow_revisit";
  beat_id: string;
  clip_ids: string[];
  semantic_cluster_ids?: string[];
  asset_ids?: string[];
  reason?: string;
}

export interface ContinuityCompileMetadata {
  policy: ContinuityPolicy;
  scope: "video_tracks";
  reorders: ContinuityReorderEvent[];
  exemptions: ContinuityExemption[];
  warnings: ContinuityIssue[];
  errors: ContinuityIssue[];
}

// ── Normalized types (Phase 1 output) ───────────────────────────────

export interface NormalizedBeat {
  beat_id: string;
  label: string;
  viewer_label?: string;
  target_duration_frames: number;
  required_roles: Role[];
  preferred_roles: Role[];
  purpose: string;
  // Peak-aware extensions (vlm-peak-detection-design.md §11.1)
  story_role?: "hook" | "setup" | "experience" | "closing";
  emotional_valence?: number;
  evidence_required?: boolean;
  craft?: CraftDirective;
  skill_hints?: string[];
  candidate_plan?: CandidatePlan;
  allow_revisit?: AllowRevisit;
}

export interface RoleQuotas {
  hero: number;
  support: number;
  transition: number;
  texture: number;
  dialogue: number;
}

export interface NormalizedData {
  project_id: string;
  project_title: string;
  beats: NormalizedBeat[];
  role_quotas: RoleQuotas;
  total_duration_frames: number;
  duration_policy?: DurationPolicy;
}

// ── Scoring types (Phase 2 output) ──────────────────────────────────

export interface ScoredCandidate {
  candidate: Candidate;
  beat_id: string;
  score: number;
  breakdown: {
    semantic_rank_score: number;
    quality_penalty: number;
    duration_fit_score: number;
    motif_reuse_penalty: number;
    adjacency_penalty: number;
    peak_salience_bonus?: number;
    peak_priority_bonus?: number;
    bgm_bonus?: number;
    plan_priority_bonus?: number;
    beat_match_bonus?: number;
    generic_beat_penalty?: number;
  };
}

export type RankedCandidateTable = Map<string, ScoredCandidate[]>;

// ── Assembly types (Phase 3 output) ─────────────────────────────────

export interface TimelineClip {
  clip_id: string;
  segment_id: string;
  asset_id: string;
  src_in_us: number;
  src_out_us: number;
  timeline_in_frame: number;
  timeline_duration_frames: number;
  role: ClipRole;
  motivation: string;
  beat_id: string;
  fallback_segment_ids: string[];
  confidence: number;
  quality_flags: string[];
  media_kind?: SourceMediaKind;
  source_capabilities?: SourceCapabilities;
  audio_role?: AudioSemanticRole;
  still_image?: StillImageTimelineMetadata;
  freeze_frame_hold?: FreezeFrameHoldTimelineMetadata;
  captions?: CaptionOverlay[];
  audio_policy?: AudioPolicy;
  // M4.5 additive fields
  candidate_ref?: string;
  fallback_candidate_refs?: string[];
  metadata?: Record<string, unknown>;
}

export interface CaptionOverlay {
  text: string;
  /** Absolute sequence frame, matching clip.timeline_in_frame and Studio's caption lane. */
  in_frame: number;
  /** Absolute sequence frame, exclusive. */
  out_frame: number;
  style: "gentle-lower-third" | "simple-shadow";
}

export interface Track {
  track_id: string;
  kind: "video" | "audio" | "overlay" | "caption";
  role?: "dialogue" | "music" | "nat_sound" | "ambient" | "sfx";
  clips: TimelineClip[];
}

export interface AssembledTimeline {
  tracks: {
    video: Track[];
    audio: Track[];
  };
  markers: Marker[];
  operations?: IntentionalGapOperation[];
}

export type IntentionalGapOperationType =
  | "gap"
  | "hold"
  | "freeze"
  | "ambient_continuation";

export interface IntentionalGapOperation {
  operation_id: string;
  type: IntentionalGapOperationType;
  track_id: string;
  start_frame: number;
  duration_frames: number;
  authority: "blueprint" | "human_golden_order" | "operator" | "compiler";
  reason: string;
}

/**
 * Explicit primary-audio mix policy (Issue #6 P0). A valid policy declares
 * that the primary audio lane is intentionally not wall-to-wall, so sparse
 * A1 coverage is authorized without a per-range timeline operation.
 */
export interface PrimaryAudioMixPolicy {
  policy: "primary-audio-mix/v1";
  mode: "selective_authorization";
  authority: "blueprint" | "human_golden_order" | "operator";
  reason: string;
}

export interface Marker {
  frame: number;
  kind: "note" | "warning" | "beat" | "transition" | "review";
  label: string;
}

// ── Final output types (Phase 5) ────────────────────────────────────

export interface TimelineTransitionOutput {
  transition_id: string;
  from_clip_id: string;
  to_clip_id: string;
  track_id: string;
  transition_type: string;
  transition_frames?: number;
  /** Absolute start frame of the transition window (= to_clip.timeline_in_frame for overlap presets). */
  start_frame?: number;
  duration_frames?: number;
  transition_params?: Record<string, unknown>;
  applied_skill_id?: string;
  degraded_from_skill_id?: string | null;
  confidence?: number;
  metadata?: Record<string, unknown>;
  fallback?: {
    type: string;
    reason: string;
  };
}

export interface TimelineIR {
  version: string;
  project_id: string;
  created_at: string;
  sequence: {
    name: string;
    fps_num: number;
    fps_den: number;
    width: number;
    height: number;
    start_frame: number;
    sample_rate?: number;
    timecode_format?: "NDF" | "DF" | "AUTO";
    output_aspect_ratio?: string;
    letterbox_policy?: "none" | "pillarbox" | "letterbox";
  };
  tracks: {
    video: TrackOutput[];
    audio: TrackOutput[];
    overlay?: TrackOutput[];
    caption?: TrackOutput[];
  };
  markers: MarkerOutput[];
  transitions?: TimelineTransitionOutput[];
  metadata?: Record<string, unknown>;
  audio_mix?: AudioMix;
  provenance: {
    brief_path: string;
    blueprint_path: string;
    selects_path: string;
    compiler_version: string;
    compiler_defaults_hash?: string;
    editorial_registry_hash?: string;
    duration_policy?: {
      mode: DurationMode;
      source: string;
      target_source: string;
      target_duration_sec: number;
      min_duration_sec: number;
      max_duration_sec: number | null;
    };
    audio_policy?: {
      mode: BriefAudioPolicy;
      source: "explicit_brief" | "profile_default" | "global_default";
      a1_loudnorm?: boolean;
      audio_decision?: "preserve" | "mastering";
      music_master?: CreativeBriefMusicMaster;
    };
    audio_render_projection?: {
      version: "audio-render-projection/v1";
      lane_semantics: {
        A1: "dialogue_and_natural_sound";
        A2: "music_bgm";
        A3: "texture_ambient_and_sfx";
      };
      dialogue_authority: "A1";
      conflict_policy: "dialogue_first";
      picture_dialogue_caption_timing_immutable: true;
      audio_displacement_frames: 0;
      source_refs: Array<{
        track_id: "A1" | "A2" | "A3";
        clip_id: string;
        asset_id: string;
        timeline_in_frame: number;
        timeline_duration_frames: number;
        source_ref?: string;
        source_content_hash?: string;
      }>;
    };
    caption_policy?: {
      mode: BriefCaptionPolicy;
      source: "explicit_brief" | "profile_default" | "global_default";
    };
    still_duration_policy?: StillDurationPolicy;
    creator_short_vo_broll?: CreatorShortVoBrollProvenance;
    shot_anchor_resolution?: ShotAnchorResolutionProvenance;
    hook_lock?: HookLockProvenance;
    visual_framing?: VisualFramingProvenance;
    vertical_composition?: VerticalCompositionProvenance;
    retention_policy?: RetentionPolicyProvenance;
    review_derivation?: {
      version: "review-derivation/v1";
      canonical_timeline_sha256: string;
      canonical_timeline_path: "05_timeline/canonical-timeline.json";
      accepted_patch_sha256: string;
      derived_mapping_sha256: string;
      derived_mapping_path: string;
      identity_receipt_path: string;
    };
  };
}

export interface VerticalCompositionProvenance {
  policy: "vertical-composition-resolution/v1";
  policy_ref: string;
  policy_hash: string;
  results: Array<{
    intent_id: string;
    status: "ready" | "degraded" | "human_hold";
    receipt_hash: string;
    reason?: string;
  }>;
}

export interface RetentionPolicyProvenance {
  policy: "retention-policy/v1";
  policy_ref: string;
  policy_id: string;
  policy_hash: string;
  degrade_order: ShortFormRetentionMode[];
}

export type ShortFormRetentionMode = "off" | "standard" | "aggressive" | "credibility_first";

export interface CreatorShortVoBrollProvenance {
  policy: "creator-short-vo-broll/v1";
  phrase_policy: "creator-short-kickoff-phrases/v1";
  min_insert_frames: number;
  max_insert_frames: number;
  audio_mode: "dialogue_voice_over";
  anchor_status: "detected" | "degraded_no_kickoff_phrase";
  degraded: boolean;
  degrade_reason?: "kickoff_phrase_not_detected";
  matched_phrase?: string;
  candidate_ref?: string;
  asset_id?: string;
  source_time_us?: number;
  detection_source?: "transcript_item" | "candidate_transcript_excerpt";
}

export interface TrackOutput {
  track_id: string;
  kind: "video" | "audio" | "overlay" | "caption";
  role?: "dialogue" | "music" | "nat_sound" | "ambient" | "sfx";
  clips: ClipOutput[];
}

export interface ClipOutput {
  clip_id: string;
  segment_id: string;
  asset_id: string;
  src_in_us: number;
  src_out_us: number;
  timeline_in_frame: number;
  timeline_duration_frames: number;
  role: string;
  motivation: string;
  beat_id: string;
  fallback_segment_ids: string[];
  confidence: number;
  quality_flags: string[];
  media_kind?: SourceMediaKind;
  source_capabilities?: SourceCapabilities;
  audio_role?: AudioSemanticRole;
  still_image?: StillImageTimelineMetadata;
  freeze_frame_hold?: FreezeFrameHoldTimelineMetadata;
  captions?: CaptionOverlay[];
  audio_policy?: AudioPolicy;
  // M4.5 additive fields
  candidate_ref?: string;
  fallback_candidate_refs?: string[];
  metadata?: Record<string, unknown>;
}

export interface MarkerOutput {
  frame: number;
  kind: "note" | "warning" | "beat" | "transition" | "review";
  label: string;
}

export interface AudioPolicy {
  mode?: BriefAudioPolicy;
  gain_unit?: "linear" | "db";
  duck_music_db?: number;
  nat_gain?: number;
  nat_sound_gain?: number;
  bgm_gain?: number;
  a1_loudnorm?: boolean;
  preserve_nat_sound?: boolean;
  fade_in_frames?: number;
  fade_out_frames?: number;
  nat_sound_fade_in_frames?: number;
  nat_sound_fade_out_frames?: number;
  bgm_fade_in_frames?: number;
  bgm_fade_out_frames?: number;
}

export interface AudioMix {
  gain_unit?: "linear" | "db";
  nat_sound_gain?: number;
  bgm_gain?: number;
  duck_music_db?: number;
  fade_in_frames?: number;
  fade_out_frames?: number;
  nat_sound_fade_in_frames?: number;
  nat_sound_fade_out_frames?: number;
  bgm_fade_in_frames?: number;
  bgm_fade_out_frames?: number;
  bgm_asset_id?: string;
  bgm_clip_id?: string;
  strategy?: "manual_mix" | "nat_under_bgm" | "dialogue_ducked_bgm";
  notes?: string;
}

// ── Compiler options ────────────────────────────────────────────────

export interface CompileArtifactReceipt {
  relative_path: string;
  path: string;
  sha256: string;
  bytes: number;
}

export interface CompilePromotionContext {
  timeline: TimelineIR;
  resolution: ResolutionReport;
  duration_policy: DurationPolicy;
}

export interface CompileOptions {
  projectPath: string;
  createdAt: string;
  repoRoot?: string;
  /** Isolated BGM media path used only to verify a staged rhythm artifact. */
  bgmMediaPathOverride?: string;
  /** Explicit repository-common SFX authority root. */
  repoSfxRoot?: string;
  blueprintOverride?: EditBlueprint;
  reviewPatch?: import("./patch.js").ReviewPatch;
  /** Optional BGM duration cap, in microseconds. When set, assembly will not exceed it. */
  bgm_duration_us?: number;
  /** Timeline framerate numerator (default: 24). Use 30000 with fpsDen=1001 for 29.97fps. */
  fpsNum?: number;
  /** Timeline framerate denominator (default: 1). Use 1001 with fpsNum=30000 for 29.97fps. */
  fpsDen?: number;
  /** Optional source map override for preview-manifest media locators. */
  sourceMapPath?: string;
  /**
   * Shallow override of runtime/compiler-defaults.yaml (e.g. tests opting out
   * of the Issue #35 chorus parity gate with rhythm_sync.parity_gate: "off").
   */
  defaultsOverride?: Partial<CompilerDefaults>;
  /** Verify every source referenced by the final timeline before promotion. */
  validateSourceArtifacts?: boolean;
  /** Hook called while canonical artifact backups are still available for rollback. */
  onArtifactsPromoted?: (receipts: CompileArtifactReceipt[], context: CompilePromotionContext) => void;
  /** Optional compiler logger for non-fatal compile notes. */
  log?: (message: string) => void;
}
