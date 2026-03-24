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
}

export interface PreviewResponse {
  previewUrl: string;
  clipCount: number;
  durationSec: number;
}

export interface TimelineValidationIssue {
  path: string;
  message: string;
}

export interface TimelineSaveResult {
  ok: boolean;
  mode: 'api' | 'mock';
  error?: string;
}
