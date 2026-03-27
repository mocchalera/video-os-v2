export type TrackKind = 'video' | 'audio' | 'overlay' | 'caption';

export type ClipRole =
  | 'hero'
  | 'support'
  | 'transition'
  | 'texture'
  | 'dialogue'
  | 'music'
  | 'nat_sound'
  | 'ambient'
  | 'bgm'
  | 'title';

export interface Sequence {
  name: string;
  fps_num: number;
  fps_den: number;
  width: number;
  height: number;
  start_frame: number;
  sample_rate?: number;
  timecode_format?: 'NDF' | 'DF' | 'AUTO';
  output_aspect_ratio?: string;
  letterbox_policy?: 'none' | 'pillarbox' | 'letterbox';
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

export interface Clip {
  clip_id: string;
  segment_id: string;
  asset_id: string;
  src_in_us: number;
  src_out_us: number;
  src_in_tc?: string;
  src_out_tc?: string;
  timeline_in_frame: number;
  timeline_duration_frames: number;
  role: ClipRole;
  motivation: string;
  beat_id?: string;
  fallback_segment_ids?: string[];
  confidence?: number;
  quality_flags?: string[];
  audio_policy?: AudioPolicy;
  candidate_ref?: string;
  fallback_candidate_refs?: string[];
  metadata?: Record<string, unknown>;
  /** Total source media duration in microseconds (from analysis). Used for hard stop. */
  source_duration_us?: number;
}

export interface Track {
  track_id: string;
  kind: TrackKind;
  clips: Clip[];
}

export interface Marker {
  frame: number;
  kind: 'note' | 'warning' | 'beat' | 'caption' | 'transition' | 'review';
  label: string;
  metadata?: Record<string, unknown>;
}

export interface Transition {
  transition_id: string;
  from_clip_id: string;
  to_clip_id: string;
  track_id: string;
  transition_type:
    | 'cut'
    | 'crossfade'
    | 'j_cut'
    | 'l_cut'
    | 'match_cut'
    | 'fade_to_black';
  transition_frames?: number;
  transition_params?: Record<string, unknown>;
  applied_skill_id?: string;
  degraded_from_skill_id?: string | null;
  confidence?: number;
}

export interface AudioMix {
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
  strategy?: 'manual_mix' | 'nat_under_bgm' | 'dialogue_ducked_bgm';
  notes?: string;
}

export interface Provenance {
  brief_path: string;
  blueprint_path: string;
  selects_path: string;
  compiler_version?: string;
  review_report_path?: string;
  compiler_defaults_hash?: string;
  editorial_registry_hash?: string;
  editor_version?: string;
  last_editor_save?: string;
  duration_policy?: {
    mode?: 'strict' | 'guide';
    source?: 'explicit_brief' | 'profile_default' | 'global_default';
    target_source?: 'explicit_brief' | 'material_total';
    target_duration_sec?: number;
    min_duration_sec?: number;
    max_duration_sec?: number | null;
  };
}

export interface TimelineIR {
  version: string;
  project_id: string;
  created_at?: string;
  sequence: Sequence;
  tracks: {
    video: Track[];
    audio: Track[];
    overlay?: Track[];
    caption?: Track[];
  };
  markers?: Marker[];
  transitions?: Transition[];
  audio_mix?: AudioMix;
  provenance: Provenance;
}

export interface ProjectSummary {
  id: string;
  name: string;
  hasTimeline: boolean;
  path?: string;
}

export interface SelectionState {
  trackKind: 'video' | 'audio';
  trackId: string;
  clipId: string;
}

// ── Phase 1: Track header state & multi-selection ─────────────────

export type TrackHeight = 'S' | 'M' | 'L';

export const TRACK_HEIGHT_PX: Record<TrackHeight, number> = {
  S: 32,
  M: 64,
  L: 128,
};

export interface TrackHeaderState {
  locked: boolean;
  muted: boolean;
  solo: boolean;
  syncLock: boolean;
  height: TrackHeight;
}

export const DEFAULT_TRACK_HEADER_STATE: TrackHeaderState = {
  locked: false,
  muted: false,
  solo: false,
  syncLock: false,
  height: 'M',
};

/** Waveform peaks data returned by server */
export interface WaveformData {
  peaks: number[];
  sample_count: number;
  duration_sec: number;
  detail: 'coarse' | 'medium' | 'fine';
}

/** Snap target for magnetic snapping */
export interface SnapTarget {
  frame: number;
  kind: 'playhead' | 'clip_in' | 'clip_out' | 'marker' | 'ruler_tick';
  label?: string;
}

export interface EditorLane {
  laneId: string;
  label: string;
  trackKind: 'video' | 'audio';
  trackId: string | null;
  clips: Clip[];
}

export interface PreviewRequest {
  mode: 'range' | 'clip' | 'full';
  startFrame?: number;
  endFrame?: number;
  clipId?: string;
  resolution?: '720p' | '1080p';
  timelineRevision?: string;
}

export interface PreviewResponse {
  previewUrl: string;
  clipCount: number;
  durationSec: number;
  timelineRevision?: string;
  generatedAt?: string;
}

// Re-exported from shared module for backward compatibility
export type { TimelineValidationIssue } from '@shared/timeline-validation';

export interface TimelineSaveResult {
  ok: boolean;
  mode: 'api' | 'mock';
  error?: string;
  timelineRevision?: string;
}

// ── Phase 2b-1: Review & Patch types ──────────────────────────────

export interface ReviewSummaryJudgment {
  status: 'approved' | 'needs_revision' | 'blocked';
  rationale: string;
  confidence: number;
}

export interface ReviewWeakness {
  clip_id?: string;
  beat_id?: string;
  severity: 'minor' | 'major' | 'critical';
  description: string;
  suggestion?: string;
}

export interface ReviewWarning {
  clip_id?: string;
  category: string;
  description: string;
}

export interface ReviewReport {
  summary_judgment?: ReviewSummaryJudgment;
  strengths?: string[];
  weaknesses?: ReviewWeakness[];
  warnings?: ReviewWarning[];
  fatal_issues?: string[];
  recommended_next_pass?: string;
}

export interface ReviewReportResponse {
  exists: boolean;
  revision?: string;
  data: ReviewReport | null;
}

export type PatchOpType =
  | 'replace_segment'
  | 'trim_segment'
  | 'move_segment'
  | 'insert_segment'
  | 'remove_segment'
  | 'change_audio_policy'
  | 'add_marker'
  | 'add_note';

/** Schema-compliant patch operation (review-patch.schema.json). */
export interface PatchOperation {
  op: PatchOpType;
  target_clip_id?: string;
  /** Target track for insert_segment (when no target_clip_id) */
  target_track_id?: string;
  with_segment_id?: string;
  new_src_in_us?: number;
  new_src_out_us?: number;
  new_timeline_in_frame?: number;
  new_duration_frames?: number;
  reason: string;
  confidence?: number;
  evidence?: string[];
  audio_policy?: AudioPolicy;
  beat_id?: string;
  role?: ClipRole;
  label?: string;
  with_candidate_ref?: string;
  /** Index of this operation in the original (unfiltered) patch. Set by safety filter. */
  original_index?: number;
}

export interface ReviewPatch {
  timeline_version: string;
  operations: PatchOperation[];
}

export interface PatchSafety {
  safe: boolean;
  rejected_ops: number[];
  filtered_patch: ReviewPatch;
}

export interface ReviewPatchResponse {
  exists: boolean;
  revision?: string;
  data: ReviewPatch | null;
  safety?: PatchSafety;
}

export interface PatchApplyRequest {
  base_timeline_revision: string;
  operation_indexes: number[];
}

export interface PatchApplyResponse {
  ok: boolean;
  timeline_revision_before: string;
  timeline_revision_after: string;
  applied_operation_indexes: number[];
  rejected_operations: number[];
  timeline: TimelineIR;
}

// ── History origin tracking (undo stack) ──────────────────────────

export type TrimMode = 'selection' | 'ripple' | 'roll' | 'slip' | 'slide';

export interface TrimTarget {
  /** The clip whose edit point is being trimmed */
  clipId: string;
  trackId: string;
  trackKind: 'video' | 'audio';
  /** Which side of the clip is the active edit point */
  side: 'head' | 'tail';
}

export type HistoryOrigin =
  | 'manual_edit'
  | 'manual_swap'
  | 'manual_trim'
  | 'manual_audio'
  | 'patch_apply'
  | 'server_reload';

/** Summary of clip-level changes (added/removed/modified counts). */
export interface ChangesSummary {
  added: number;
  removed: number;
  modified: number;
}

/** Client-side session baseline for diff comparison. Not persisted to server. */
export interface SessionBaseline {
  timeline: TimelineIR;
  baselineRevision: string;
  establishedBy: 'initial_load' | 'reload_after_compile';
}

export interface SelectsCandidate {
  segment_id: string;
  asset_id: string;
  src_in_us: number;
  src_out_us: number;
  role: ClipRole;
  why_it_matches?: string;
  risks?: string[];
  confidence: number;
  semantic_rank?: number;
  quality_flags?: string[];
  eligible_beats?: string[];
  trim_hint?: {
    source_center_us: number;
    preferred_duration_us: number;
  };
}

export interface SelectsCandidatesData {
  version?: string;
  project_id?: string;
  candidates: SelectsCandidate[];
}

export interface SelectsResponse {
  exists: boolean;
  revision?: string;
  data: SelectsCandidatesData | null;
}

// ── Shared confidence thresholds ──────────────────────────────────
export const CONFIDENCE_HIGH = 0.8;
export const CONFIDENCE_MEDIUM = 0.6;
