// Shared types for the timeline compiler.
// These mirror the YAML/JSON artifact shapes used across phases.

// ── Duration Mode types ─────────────────────────────────────────────

export type DurationMode = "strict" | "guide";
export type CaptionPolicySource = "transcript" | "authored" | "none";

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

export interface CreativeBrief {
  version: string;
  project_id: string;
  project: { id: string; title: string; strategy: string; runtime_target_sec?: number; duration_mode?: DurationMode };
  message: { primary: string; secondary?: string[] };
  emotion_curve: string[];
  editorial?: CreativeBriefEditorial;
  [key: string]: unknown;
}

export interface CandidatePlan {
  primary_candidate_ref?: string;
  fallback_candidate_refs?: string[];
}

export interface Beat {
  id: string;
  label: string;
  purpose?: string;
  target_duration_frames: number;
  required_roles: Role[];
  preferred_roles?: Role[];
  notes?: string;
  // M4.5 additive fields
  story_role?: "hook" | "setup" | "experience" | "closing";
  skill_hints?: string[];
  candidate_plan?: CandidatePlan;
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

export interface EditBlueprint {
  version: string;
  project_id: string;
  sequence_goals: string[];
  beats: Beat[];
  pacing: {
    opening_cadence: string;
    middle_cadence: string;
    ending_cadence: string;
    max_shot_length_frames?: number;
    default_duration_target_sec?: number;
  };
  music_policy: {
    start_sparse: boolean;
    allow_release_late: boolean;
    entry_beat: string;
    avoid_anthemic_lift: boolean;
    permitted_energy_curve: string;
  };
  caption_policy?: {
    language?: string;
    delivery_mode?: "burn_in" | "sidecar" | "both";
    source?: CaptionPolicySource;
    styling_class?: string;
  };
  dialogue_policy: {
    preserve_natural_breath: boolean;
    avoid_wall_to_wall_voiceover: boolean;
    prioritize_lines?: string[];
  };
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
  // Timeline ordering: chronological (source timestamp) or editorial (score-based)
  timeline_order?: "chronological" | "editorial";
  [key: string]: unknown;
}

export type Role = "hero" | "support" | "transition" | "texture" | "dialogue";
export type ClipRole = Role | "music" | "nat_sound" | "bgm" | "title";

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
  semantic_rank?: number;
  quality_flags?: string[];
  evidence?: string[];
  eligible_beats?: string[];
  transcript_excerpt?: string;
  motif_tags?: string[];
  // M4.5 additive fields
  candidate_id?: string;
  utterance_ids?: string[];
  speaker_role?: "primary" | "interviewer" | "secondary" | "unknown";
  semantic_dedupe_key?: string;
  editorial_signals?: EditorialSignals;
  trim_hint?: TrimHint;
}

export interface SelectsCandidates {
  version: string;
  project_id: string;
  candidates: Candidate[];
  editorial_summary?: EditorialSummary;
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
}

export interface ProfileDefinition {
  id: string;
  defaults: ProfileDefaults;
  default_policy?: string;
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
}

// ── Normalized types (Phase 1 output) ───────────────────────────────

export interface NormalizedBeat {
  beat_id: string;
  label: string;
  target_duration_frames: number;
  required_roles: Role[];
  preferred_roles: Role[];
  purpose: string;
  // Peak-aware extensions (vlm-peak-detection-design.md §11.1)
  story_role?: "hook" | "setup" | "experience" | "closing";
  skill_hints?: string[];
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
    bgm_bonus?: number;
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
  // M4.5 additive fields
  candidate_ref?: string;
  fallback_candidate_refs?: string[];
  metadata?: Record<string, unknown>;
}

export interface Track {
  track_id: string;
  kind: "video" | "audio" | "overlay" | "caption";
  clips: TimelineClip[];
}

export interface AssembledTimeline {
  tracks: {
    video: Track[];
    audio: Track[];
  };
  markers: Marker[];
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
  transition_params?: Record<string, unknown>;
  applied_skill_id?: string;
  degraded_from_skill_id?: string | null;
  confidence?: number;
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
  };
  markers: MarkerOutput[];
  transitions?: TimelineTransitionOutput[];
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
  };
}

export interface TrackOutput {
  track_id: string;
  kind: "video" | "audio" | "overlay" | "caption";
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
  duck_music_db?: number;
  nat_gain?: number;
  nat_sound_gain?: number;
  bgm_gain?: number;
  preserve_nat_sound?: boolean;
  fade_in_frames?: number;
  fade_out_frames?: number;
  nat_sound_fade_in_frames?: number;
  nat_sound_fade_out_frames?: number;
  bgm_fade_in_frames?: number;
  bgm_fade_out_frames?: number;
}

// ── Compiler options ────────────────────────────────────────────────

export interface CompileOptions {
  projectPath: string;
  createdAt: string;
  repoRoot?: string;
  blueprintOverride?: EditBlueprint;
  reviewPatch?: import("./patch.js").ReviewPatch;
  /** Timeline framerate numerator (default: 24). Use 30 for 29.97fps source material. */
  fpsNum?: number;
  /** Optional source map override for preview-manifest media locators. */
  sourceMapPath?: string;
}
