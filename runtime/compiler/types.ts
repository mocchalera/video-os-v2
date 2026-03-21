// Shared types for the timeline compiler.
// These mirror the YAML/JSON artifact shapes used across phases.

// ── Input artifact types ────────────────────────────────────────────

export interface CreativeBrief {
  version: string;
  project_id: string;
  project: { id: string; title: string; strategy: string; runtime_target_sec?: number };
  message: { primary: string; secondary?: string[] };
  emotion_curve: string[];
  [key: string]: unknown;
}

export interface Beat {
  id: string;
  label: string;
  purpose?: string;
  target_duration_frames: number;
  required_roles: Role[];
  preferred_roles?: Role[];
  notes?: string;
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
  };
  music_policy: {
    start_sparse: boolean;
    allow_release_late: boolean;
    entry_beat: string;
    avoid_anthemic_lift: boolean;
    permitted_energy_curve: string;
  };
  dialogue_policy: {
    preserve_natural_breath: boolean;
    avoid_wall_to_wall_voiceover: boolean;
    prioritize_lines?: string[];
  };
  [key: string]: unknown;
}

export type Role = "hero" | "support" | "transition" | "texture" | "dialogue";
export type ClipRole = Role | "music" | "title";

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
}

export interface SelectsCandidates {
  version: string;
  project_id: string;
  candidates: Candidate[];
  [key: string]: unknown;
}

export interface ScoringParams {
  motif_reuse_max: number;
  adjacency_penalty: number;
  beat_alignment_tolerance_frames: number;
  duration_fit_tolerance_frames: number;
  quality_flag_penalty: number;
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
  };
  tracks: {
    video: TrackOutput[];
    audio: TrackOutput[];
  };
  markers: MarkerOutput[];
  provenance: {
    brief_path: string;
    blueprint_path: string;
    selects_path: string;
    compiler_version: string;
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
}

export interface MarkerOutput {
  frame: number;
  kind: "note" | "warning" | "beat" | "transition" | "review";
  label: string;
}

// ── Compiler options ────────────────────────────────────────────────

export interface CompileOptions {
  projectPath: string;
  createdAt: string;
}
