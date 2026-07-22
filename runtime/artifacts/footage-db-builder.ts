import Database from "better-sqlite3";
import { execFile } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { computeNormalizedJsonHash } from "./p1-manifest-coverage.js";
import {
  EDITORIAL_OBSERVATION_MATERIALIZATION_REVISION,
  footageDbPath,
} from "./footage-db.js";
import {
  extractAudioLevels,
  extractCameraMotion,
  extractEditorialObservation,
  extractSceneShotTake,
  extractShotScale,
  type EditorialObservationExtraction,
  type EditorialObservationField,
} from "./footage-metadata-extractor.js";
import {
  SEMANTIC_EMBEDDING_DTYPE,
  SEMANTIC_EMBEDDING_MODEL,
  embedTexts,
} from "../eval/semantic-match.js";
import type {
  Qwen3VlBatchItem,
  Qwen3VlEmbeddingClient,
  Qwen3VlVectorResult,
} from "../connectors/qwen3vl-embedding-local.js";
import type {
  ClapAudioEmbeddingClient,
  ClapAudioVectorResult,
} from "../connectors/clap-audio-local.js";

export type FootageDbEmbeddingPolicy = "auto" | "skip" | "require";
export type FootageDbRebuildMode = "full" | "incremental";
export type Qwen3VlBuildEmbeddingType = "visual_representative" | "text_combined_qwen";

export interface Qwen3VlBuildProgress {
  phase: "frames" | "visual" | "text";
  completed: number;
  total: number;
}

export interface ClapAudioBuildProgress {
  phase: "windows" | "audio" | "text";
  completed: number;
  total: number;
}

export interface BuildFootageDbOptions {
  projectDir: string;
  outputPath?: string;
  embeddingPolicy?: FootageDbEmbeddingPolicy;
  rebuildMode?: FootageDbRebuildMode;
  allowRemoteEmbeddingModels?: boolean;
  skipAudioAnalysis?: boolean;
  qwen3vlEnabled?: boolean;
  qwen3vlEmbedTypes?: Qwen3VlBuildEmbeddingType[];
  qwen3vlRequestTimeoutMs?: number;
  onQwen3VlProgress?: (progress: Qwen3VlBuildProgress) => void;
  clapAudioEnabled?: boolean;
  clapAudioRequestTimeoutMs?: number;
  onClapAudioProgress?: (progress: ClapAudioBuildProgress) => void;
  now?: Date;
}

export interface EmbeddingCounts {
  e5_text: number;
  qwen_text: number;
  qwen_visual: number;
  qwen_mixed: number;
  qwen_reranker: number;
  clap_audio: number;
}

export type EmbeddingStatus = "ready" | "skipped" | "unavailable" | "error";

export interface EmbeddingStatuses {
  e5_text: EmbeddingStatus;
  qwen_text: EmbeddingStatus;
  qwen_visual: EmbeddingStatus;
  qwen_mixed: EmbeddingStatus | "unsupported";
  qwen_reranker: EmbeddingStatus | "deferred";
  clap_audio: EmbeddingStatus;
}

export interface BuildFootageDbResult {
  db_path: string;
  report_path: string;
  artifact_version: "footage-db-v1";
  schema_version: "1";
  counts: {
    assets: number;
    segments: number;
    fts_rows: number;
    marlin_events: number;
    transcript_segments: number;
    asset_technical_metadata: number;
    segment_visual_profiles: number;
    segment_audio_profiles: number;
    segment_logging_profiles: number;
    metadata_fts_rows: number;
    embeddings: number;
  };
  embedding_status: EmbeddingStatus;
  embedding_counts?: EmbeddingCounts;
  embedding_statuses?: EmbeddingStatuses;
  warnings: string[];
  source_hashes: Record<string, string>;
}

type JsonRecord = Record<string, unknown>;
type EmbeddingField = "summary" | "transcript" | "scene" | "combined";

interface SourceRecord {
  source_name: string;
  rel_path: string;
  hash: string;
  required: boolean;
}

interface LoadedInputs {
  projectId: string;
  assetsJson: JsonRecord;
  segmentsJson: JsonRecord;
  marlinJson: JsonRecord | null;
  transcripts: TranscriptDocument[];
  annotations: UserAnnotations;
  filenameParser: FilenameParserConfig;
  sources: SourceRecord[];
  warnings: string[];
}

interface TranscriptDocument {
  relPath: string;
  transcriptRef: string;
  assetId: string;
  text: string;
  items: TranscriptItem[];
  hash: string;
}

interface TranscriptItem {
  item_id?: string;
  start_us?: number;
  end_us?: number;
  text: string;
  confidence?: number;
}

interface TranscriptSlice {
  text: string;
  language: string | null;
  confidenceMin: number | null;
  hasDialogue: boolean;
  itemRefs: Array<{ transcript_ref: string; item_id?: string; start_us?: number; end_us?: number }>;
  transcriptHash: string | null;
}

interface SegmentBuildRecord {
  segment: JsonRecord;
  asset: JsonRecord;
  segmentId: string;
  assetId: string;
  srcInUs: number;
  srcOutUs: number;
  summary: string;
  transcriptExcerpt: string;
  transcript: TranscriptSlice;
  tags: string[];
  qualityFlags: string[];
  qualityLabels: string[];
  marlinSceneText: string;
  marlinEvents: string[];
  extractedTextFlat: string;
  placeText: string;
  aestheticNotesFlat: string;
  editorialObservation: EditorialObservationExtraction;
}

interface PopulationResult {
  counts: BuildFootageDbResult["counts"];
  embeddingTexts: Array<{ segment_id: string; field: EmbeddingField; text: string; content_hash: string }>;
  segments: SegmentBuildRecord[];
  warnings: string[];
}

interface EmbeddingModelInput {
  name: string;
  model_revision: string;
  output_dimension: number;
  input_modality: string;
  instruction: string;
  preprocess_version: string;
  runner_name: string;
  runner_version: string;
  precision: string;
  normalized: boolean;
  distance_metric: string;
  license: string;
  created_at: string;
}

interface EmbeddingPopulationResult {
  status: EmbeddingStatus;
  count: number;
  counts: EmbeddingCounts;
  statuses: EmbeddingStatuses;
}

interface Qwen3VlPopulationOptions {
  projectDir: string;
  outputPath: string;
  segments: SegmentBuildRecord[];
  embeddingTexts: Array<{ segment_id: string; field: EmbeddingField; text: string; content_hash: string }>;
  enabled: boolean;
  embedTypes: Qwen3VlBuildEmbeddingType[];
  requestTimeoutMs: number;
  createdAt: string;
  warnings: string[];
  onProgress?: (progress: Qwen3VlBuildProgress) => void;
}

interface Qwen3VlPopulationResult {
  count: number;
  counts: Pick<EmbeddingCounts, "qwen_text" | "qwen_visual" | "qwen_mixed" | "qwen_reranker">;
  statuses: Pick<EmbeddingStatuses, "qwen_text" | "qwen_visual" | "qwen_mixed" | "qwen_reranker">;
}

interface ClapAudioPopulationOptions {
  projectDir: string;
  outputPath: string;
  segments: SegmentBuildRecord[];
  embeddingTexts: Array<{ segment_id: string; field: EmbeddingField; text: string; content_hash: string }>;
  enabled: boolean;
  requestTimeoutMs: number;
  createdAt: string;
  warnings: string[];
  onProgress?: (progress: ClapAudioBuildProgress) => void;
}

interface ClapAudioPopulationResult {
  count: number;
  counts: Pick<EmbeddingCounts, "clap_audio">;
  statuses: Pick<EmbeddingStatuses, "clap_audio">;
}

interface RepresentativeFrameRecord {
  segmentId: string;
  framePath: string;
  outputRelPath: string;
  contentHash: string;
  timestampUs: number;
}

interface QwenTextEmbeddingInput {
  segmentId: string;
  text: string;
  contentHash: string;
}

interface AudioWindowRecord {
  segmentId: string;
  windowPath: string;
  outputRelPath: string;
  contentHash: string;
  startUs: number;
  endUs: number;
}

interface ClapTextEmbeddingInput {
  segmentId: string;
  text: string;
  contentHash: string;
}

interface UserAnnotations {
  bySegmentId: Map<string, JsonRecord>;
  byAssetId: Map<string, JsonRecord>;
}

interface FilenameParserConfig {
  enabled: boolean;
}

interface UsabilityClassification {
  usability: "fully_usable" | "partially_usable" | "unusable";
  confidence: number;
  evidence: string[];
}

const ARTIFACT_VERSION = "footage-db-v1" as const;
const SCHEMA_VERSION = "1" as const;
const REPORT_ARTIFACT_VERSION = "footage-db-build-report-v1";
const EMBEDDING_MODEL_ID = `${SEMANTIC_EMBEDDING_MODEL}:${SEMANTIC_EMBEDDING_DTYPE}`;
const E5_MODEL_REVISION = "legacy-unpinned";
const E5_OUTPUT_DIMENSION = 384;
const E5_INSTRUCTION = "e5-query-passage-prefix-v1";
const E5_PREPROCESS_VERSION = "footage-db-text-bundle-v1";
const E5_RUNNER_NAME = "transformers.js";
const E5_RUNNER_VERSION = "unknown";
const E5_LICENSE = "model-card-verified-before-release";
const QWEN3VL_MODEL_NAME = "Qwen/Qwen3-VL-Embedding-2B";
const QWEN3VL_MODEL_REVISION = "local-cache";
const QWEN3VL_OUTPUT_DIMENSION = 2048;
const QWEN3VL_INSTRUCTION = "Retrieve relevant video footage for editing.";
const QWEN3VL_PREPROCESS_VERSION = "qwen3vl-frame-v1";
const QWEN3VL_RUNNER_NAME = "python-qwen3vl-worker";
const QWEN3VL_RUNNER_VERSION = "qwen3vl-worker-v1";
const QWEN3VL_PRECISION = "fp16";
const QWEN3VL_LICENSE = "Apache-2.0";
const QWEN3VL_DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const QWEN3VL_DEFAULT_EMBED_TYPES: Qwen3VlBuildEmbeddingType[] = ["visual_representative", "text_combined_qwen"];
const QWEN3VL_TEXT_MAX_CHARS = 4_096;
const QWEN3VL_TEXT_CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
const FRAME_CACHE_REL_ROOT = "03_analysis/frames";
const REPRESENTATIVE_FRAME_FILENAME = "representative.jpg";
const AUDIO_WINDOW_CACHE_REL_ROOT = "03_analysis/audio_windows";
const AUDIO_WINDOW_FILENAME = "full.wav";
const CLAP_AUDIO_MODEL_NAME = "laion/clap-htsat-fused";
const CLAP_AUDIO_MODEL_REVISION = "local-cache";
const CLAP_AUDIO_OUTPUT_DIMENSION = 512;
const CLAP_AUDIO_INSTRUCTION = "";
const CLAP_AUDIO_PREPROCESS_VERSION = "clap-audio-window-v1";
const CLAP_AUDIO_RUNNER_NAME = "python-clap-audio-worker";
const CLAP_AUDIO_RUNNER_VERSION = "clap-audio-worker-v1";
const CLAP_AUDIO_PRECISION = "fp32";
const CLAP_AUDIO_LICENSE = "Apache-2.0";
const CLAP_AUDIO_DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const VALID_SEGMENT_TYPES = new Set(["dialogue", "music_driven", "action", "static", "general"]);

const FOOTAGE_DB_DDL = `
PRAGMA foreign_keys = ON;

CREATE TABLE footage_db_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE footage_db_sources (
  source_name TEXT PRIMARY KEY,
  rel_path TEXT NOT NULL,
  hash TEXT NOT NULL,
  required INTEGER NOT NULL CHECK (required IN (0, 1)),
  indexed_at TEXT NOT NULL
);

CREATE TABLE footage_db_warnings (
  warning_id TEXT PRIMARY KEY,
  severity TEXT NOT NULL CHECK (severity IN ('info', 'warning', 'error')),
  message TEXT NOT NULL,
  source_name TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE assets (
  asset_id TEXT PRIMARY KEY,
  filename TEXT NOT NULL,
  display_name TEXT,
  role_guess TEXT,
  duration_us INTEGER NOT NULL CHECK (duration_us >= 0),
  has_transcript INTEGER NOT NULL DEFAULT 0 CHECK (has_transcript IN (0, 1)),
  transcript_ref TEXT,
  source_locator TEXT,
  source_fingerprint TEXT,
  poster_path TEXT,
  waveform_path TEXT,
  tags_json TEXT NOT NULL DEFAULT '[]',
  quality_flags_json TEXT NOT NULL DEFAULT '[]',
  source_order INTEGER NOT NULL,
  shooting_date TEXT,
  shooting_time TEXT,
  camera_type TEXT
);

CREATE INDEX idx_assets_source_order ON assets(source_order);
CREATE INDEX idx_assets_shooting_date ON assets(shooting_date);
CREATE INDEX idx_assets_shooting_time ON assets(shooting_time);
CREATE INDEX idx_assets_camera_type ON assets(camera_type);

CREATE TABLE asset_technical_metadata (
  asset_id TEXT PRIMARY KEY REFERENCES assets(asset_id) ON DELETE CASCADE,

  container_format TEXT,
  container_long_name TEXT,
  recording_format TEXT,

  video_codec TEXT,
  video_profile TEXT,
  codec_tag TEXT,
  width INTEGER CHECK (width IS NULL OR width > 0),
  height INTEGER CHECK (height IS NULL OR height > 0),
  fps_num INTEGER CHECK (fps_num IS NULL OR fps_num > 0),
  fps_den INTEGER CHECK (fps_den IS NULL OR fps_den > 0),
  r_frame_rate TEXT,
  time_base TEXT,
  frame_rate_mode TEXT CHECK (
    frame_rate_mode IS NULL OR frame_rate_mode IN ('cfr', 'vfr', 'audio_only', 'unknown')
  ),
  pix_fmt TEXT,
  bit_depth INTEGER CHECK (bit_depth IS NULL OR bit_depth > 0),

  color_primaries TEXT,
  color_transfer TEXT,
  color_space TEXT,
  color_range TEXT,
  rotation INTEGER CHECK (rotation IS NULL OR rotation IN (0, 90, 180, 270)),

  stream_duration_json TEXT NOT NULL DEFAULT '[]',
  audio_streams_json TEXT NOT NULL DEFAULT '[]',

  timecode_start TEXT,
  timecode_format TEXT CHECK (
    timecode_format IS NULL OR timecode_format IN ('none', 'non_drop', 'drop_frame', 'inferred', 'unknown')
  ),
  reel_name TEXT,
  card_id TEXT,
  camera_id TEXT,

  extraction_source_json TEXT NOT NULL DEFAULT '{}',
  evidence_json TEXT NOT NULL DEFAULT '[]'
);

CREATE INDEX idx_asset_technical_codec
  ON asset_technical_metadata(video_codec, video_profile, recording_format);

CREATE INDEX idx_asset_technical_resolution
  ON asset_technical_metadata(width, height);

CREATE INDEX idx_asset_technical_rate
  ON asset_technical_metadata(fps_num, fps_den, frame_rate_mode);

CREATE INDEX idx_asset_technical_color
  ON asset_technical_metadata(color_primaries, color_transfer, color_space);

CREATE INDEX idx_asset_technical_reel
  ON asset_technical_metadata(reel_name, card_id, camera_id);

CREATE TABLE segments (
  segment_id TEXT PRIMARY KEY,
  asset_id TEXT NOT NULL REFERENCES assets(asset_id) ON DELETE CASCADE,
  src_in_us INTEGER NOT NULL CHECK (src_in_us >= 0),
  src_out_us INTEGER NOT NULL CHECK (src_out_us > src_in_us),
  duration_us INTEGER GENERATED ALWAYS AS (src_out_us - src_in_us) VIRTUAL,
  rep_frame_us INTEGER CHECK (rep_frame_us IS NULL OR rep_frame_us >= 0),
  segment_type TEXT CHECK (
    segment_type IS NULL OR segment_type IN ('dialogue', 'music_driven', 'action', 'static', 'general')
  ),
  summary TEXT NOT NULL DEFAULT '',
  transcript_excerpt TEXT NOT NULL DEFAULT '',
  transcript_ref TEXT,
  tags_json TEXT NOT NULL DEFAULT '[]',
  quality_flags_json TEXT NOT NULL DEFAULT '[]',
  interest_points_json TEXT NOT NULL DEFAULT '[]',
  filmstrip_path TEXT,
  waveform_path TEXT
);

CREATE INDEX idx_segments_asset_time ON segments(asset_id, src_in_us, src_out_us);
CREATE INDEX idx_segments_duration ON segments(duration_us);
CREATE INDEX idx_segments_type ON segments(segment_type);

CREATE TABLE segment_visual_profile (
  segment_id TEXT PRIMARY KEY REFERENCES segments(segment_id) ON DELETE CASCADE,

  camera_motion_description TEXT NOT NULL DEFAULT '',
  camera_motion_type TEXT NOT NULL DEFAULT 'unknown' CHECK (
    camera_motion_type IN (
      'static', 'pan', 'tilt', 'push_in', 'pull_out', 'tracking',
      'handheld', 'reveal', 'fast_action', 'mixed', 'unknown'
    )
  ),
  camera_motion_direction TEXT NOT NULL DEFAULT 'unknown' CHECK (
    camera_motion_direction IN (
      'none', 'ltr', 'rtl', 'up', 'down', 'toward_camera', 'away_camera', 'mixed', 'unknown'
    )
  ),
  camera_stability TEXT NOT NULL DEFAULT 'unknown' CHECK (
    camera_stability IN ('stable', 'slight', 'shaky', 'unknown')
  ),
  motion_energy REAL CHECK (motion_energy IS NULL OR (motion_energy >= 0 AND motion_energy <= 1)),
  camera_motion_energy REAL CHECK (
    camera_motion_energy IS NULL OR (camera_motion_energy >= 0 AND camera_motion_energy <= 1)
  ),

  shot_scale TEXT NOT NULL DEFAULT 'unknown' CHECK (
    shot_scale IN (
      'extreme_wide', 'wide', 'medium_wide', 'medium',
      'medium_close', 'close', 'extreme_close', 'detail', 'unknown'
    )
  ),
  composition_anchor TEXT NOT NULL DEFAULT 'unknown' CHECK (
    composition_anchor IN ('left', 'center_left', 'center', 'center_right', 'right', 'unknown')
  ),
  subject_screen_side TEXT NOT NULL DEFAULT 'unknown' CHECK (
    subject_screen_side IN ('left', 'center', 'right', 'mixed', 'none', 'unknown')
  ),
  dominant_subject_type TEXT NOT NULL DEFAULT 'unknown' CHECK (
    dominant_subject_type IN ('person', 'group', 'object', 'vehicle', 'environment', 'none', 'unknown')
  ),
  subject_movement_direction TEXT NOT NULL DEFAULT 'unknown' CHECK (
    subject_movement_direction IN ('ltr', 'rtl', 'toward_camera', 'away_camera', 'static', 'mixed', 'unknown')
  ),

  exposure_label TEXT NOT NULL DEFAULT 'unknown' CHECK (
    exposure_label IN ('under', 'normal', 'over', 'mixed', 'unknown')
  ),
  color_temperature TEXT NOT NULL DEFAULT 'unknown' CHECK (
    color_temperature IN ('warm', 'neutral', 'cool', 'mixed', 'unknown')
  ),
  contrast_label TEXT NOT NULL DEFAULT 'unknown' CHECK (
    contrast_label IN ('low', 'normal', 'high', 'mixed', 'unknown')
  ),
  saturation_label TEXT NOT NULL DEFAULT 'unknown' CHECK (
    saturation_label IN ('muted', 'normal', 'vivid', 'mixed', 'unknown')
  ),
  dominant_colors_json TEXT NOT NULL DEFAULT '[]',
  sampled_frame_count INTEGER NOT NULL DEFAULT 0 CHECK (sampled_frame_count >= 0),

  depth_of_field TEXT NOT NULL DEFAULT 'unknown' CHECK (
    depth_of_field IN ('shallow', 'medium', 'deep', 'unknown')
  ),

  motion_confidence REAL CHECK (motion_confidence IS NULL OR (motion_confidence >= 0 AND motion_confidence <= 1)),
  scale_confidence REAL CHECK (scale_confidence IS NULL OR (scale_confidence >= 0 AND scale_confidence <= 1)),
  subject_confidence REAL CHECK (subject_confidence IS NULL OR (subject_confidence >= 0 AND subject_confidence <= 1)),
  color_confidence REAL CHECK (color_confidence IS NULL OR (color_confidence >= 0 AND color_confidence <= 1)),
  depth_confidence REAL CHECK (depth_confidence IS NULL OR (depth_confidence >= 0 AND depth_confidence <= 1)),

  extraction_source_json TEXT NOT NULL DEFAULT '{}',
  evidence_json TEXT NOT NULL DEFAULT '[]'
);

CREATE INDEX idx_segment_visual_motion
  ON segment_visual_profile(camera_motion_type, camera_motion_direction, camera_stability);

CREATE INDEX idx_segment_visual_energy
  ON segment_visual_profile(motion_energy, camera_motion_energy);

CREATE INDEX idx_segment_visual_scale
  ON segment_visual_profile(shot_scale, scale_confidence);

CREATE INDEX idx_segment_visual_subject
  ON segment_visual_profile(subject_screen_side, dominant_subject_type, subject_movement_direction);

CREATE INDEX idx_segment_visual_color
  ON segment_visual_profile(exposure_label, color_temperature, contrast_label, saturation_label);

CREATE TABLE segment_audio_profile (
  segment_id TEXT PRIMARY KEY REFERENCES segments(segment_id) ON DELETE CASCADE,

  audio_role TEXT NOT NULL DEFAULT 'unknown' CHECK (
    audio_role IN ('dialogue', 'music', 'ambient', 'silence', 'mixed', 'unknown')
  ),
  has_dialogue INTEGER NOT NULL DEFAULT 0 CHECK (has_dialogue IN (0, 1)),
  has_music INTEGER NOT NULL DEFAULT 0 CHECK (has_music IN (0, 1)),
  has_ambient INTEGER NOT NULL DEFAULT 0 CHECK (has_ambient IN (0, 1)),

  peak_dbfs REAL,
  rms_dbfs REAL,
  integrated_lufs REAL,
  silence_ratio REAL CHECK (silence_ratio IS NULL OR (silence_ratio >= 0 AND silence_ratio <= 1)),
  silence_head_us INTEGER CHECK (silence_head_us IS NULL OR silence_head_us >= 0),
  silence_tail_us INTEGER CHECK (silence_tail_us IS NULL OR silence_tail_us >= 0),
  speech_density REAL CHECK (speech_density IS NULL OR (speech_density >= 0 AND speech_density <= 1)),
  music_density REAL CHECK (music_density IS NULL OR (music_density >= 0 AND music_density <= 1)),

  noise_flags_json TEXT NOT NULL DEFAULT '[]',
  audio_handle_head_us INTEGER CHECK (audio_handle_head_us IS NULL OR audio_handle_head_us >= 0),
  audio_handle_tail_us INTEGER CHECK (audio_handle_tail_us IS NULL OR audio_handle_tail_us >= 0),

  confidence REAL CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  extraction_source_json TEXT NOT NULL DEFAULT '{}',
  evidence_json TEXT NOT NULL DEFAULT '[]'
);

CREATE INDEX idx_segment_audio_role
  ON segment_audio_profile(audio_role, has_dialogue, has_music, has_ambient);

CREATE INDEX idx_segment_audio_levels
  ON segment_audio_profile(peak_dbfs, integrated_lufs);

CREATE INDEX idx_segment_audio_silence
  ON segment_audio_profile(silence_ratio, silence_head_us, silence_tail_us);

CREATE TABLE segment_logging_profile (
  segment_id TEXT PRIMARY KEY REFERENCES segments(segment_id) ON DELETE CASCADE,

  scene_number TEXT,
  shot_number TEXT,
  take_number TEXT,
  camera_id TEXT,
  card_id TEXT,

  circle_take INTEGER CHECK (circle_take IS NULL OR circle_take IN (0, 1)),
  best_take INTEGER CHECK (best_take IS NULL OR best_take IN (0, 1)),
  custom_tags_json TEXT NOT NULL DEFAULT '[]',
  operator_notes TEXT NOT NULL DEFAULT '',

  source TEXT NOT NULL CHECK (
    source IN ('user_annotation', 'filename_parser', 'manifest', 'imported_log', 'unknown')
  ),
  confidence REAL CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  evidence_json TEXT NOT NULL DEFAULT '[]'
);

CREATE INDEX idx_segment_logging_scene_take
  ON segment_logging_profile(scene_number, shot_number, take_number);

CREATE INDEX idx_segment_logging_camera
  ON segment_logging_profile(camera_id, card_id);

CREATE INDEX idx_segment_logging_circle
  ON segment_logging_profile(circle_take, best_take);

CREATE TABLE segment_usability_profile (
  segment_id TEXT PRIMARY KEY REFERENCES segments(segment_id) ON DELETE CASCADE,
  usability TEXT NOT NULL CHECK (
    usability IN ('fully_usable', 'partially_usable', 'unusable')
  ),
  confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  evidence_json TEXT NOT NULL DEFAULT '[]'
);

CREATE INDEX idx_segment_usability
  ON segment_usability_profile(usability, confidence);

CREATE TABLE visual_quality (
  segment_id TEXT PRIMARY KEY REFERENCES segments(segment_id) ON DELETE CASCADE,
  light_quality REAL CHECK (light_quality IS NULL OR (light_quality >= 0 AND light_quality <= 1)),
  subject_prominence REAL CHECK (subject_prominence IS NULL OR (subject_prominence >= 0 AND subject_prominence <= 1)),
  emotional_expression REAL CHECK (emotional_expression IS NULL OR (emotional_expression >= 0 AND emotional_expression <= 1)),
  composition_score REAL CHECK (composition_score IS NULL OR (composition_score >= 0 AND composition_score <= 1)),
  motion_quality REAL CHECK (motion_quality IS NULL OR (motion_quality >= 0 AND motion_quality <= 1)),
  lighting_style_json TEXT NOT NULL DEFAULT '[]',
  composition_tags_json TEXT NOT NULL DEFAULT '[]',
  expression_tags_json TEXT NOT NULL DEFAULT '[]',
  motion_tags_json TEXT NOT NULL DEFAULT '[]'
);

CREATE INDEX idx_visual_quality_light ON visual_quality(light_quality);
CREATE INDEX idx_visual_quality_subject ON visual_quality(subject_prominence);
CREATE INDEX idx_visual_quality_emotion ON visual_quality(emotional_expression);
CREATE INDEX idx_visual_quality_composition ON visual_quality(composition_score);
CREATE INDEX idx_visual_quality_motion ON visual_quality(motion_quality);

CREATE TABLE visual_appraisal (
  segment_id TEXT PRIMARY KEY REFERENCES segments(segment_id) ON DELETE CASCADE,
  frame_us INTEGER CHECK (frame_us IS NULL OR frame_us >= 0),
  frame_path TEXT,
  extracted_text_json TEXT NOT NULL DEFAULT '[]',
  extracted_text_flat TEXT NOT NULL DEFAULT '',
  place_hint_name TEXT,
  place_hint_category TEXT,
  place_hint_confidence REAL CHECK (
    place_hint_confidence IS NULL OR (place_hint_confidence >= 0 AND place_hint_confidence <= 1)
  ),
  place_hint_evidence_json TEXT NOT NULL DEFAULT '[]',
  aesthetic_notes_json TEXT NOT NULL DEFAULT '[]',
  aesthetic_notes_flat TEXT NOT NULL DEFAULT ''
);

CREATE INDEX idx_visual_appraisal_place ON visual_appraisal(place_hint_category, place_hint_name);
CREATE INDEX idx_visual_appraisal_text ON visual_appraisal(extracted_text_flat);

CREATE TABLE peak_analysis (
  segment_id TEXT PRIMARY KEY REFERENCES segments(segment_id) ON DELETE CASCADE,
  recommended_in_us INTEGER CHECK (recommended_in_us IS NULL OR recommended_in_us >= 0),
  recommended_out_us INTEGER CHECK (recommended_out_us IS NULL OR recommended_out_us >= 0),
  recommended_rationale TEXT,
  motion_support_score REAL CHECK (motion_support_score IS NULL OR (motion_support_score >= 0 AND motion_support_score <= 1)),
  audio_support_score REAL CHECK (audio_support_score IS NULL OR (audio_support_score >= 0 AND audio_support_score <= 1)),
  fused_peak_score REAL CHECK (fused_peak_score IS NULL OR (fused_peak_score >= 0 AND fused_peak_score <= 1))
);

CREATE TABLE peak_moments (
  peak_ref TEXT PRIMARY KEY,
  segment_id TEXT NOT NULL REFERENCES segments(segment_id) ON DELETE CASCADE,
  timestamp_us INTEGER NOT NULL CHECK (timestamp_us >= 0),
  type TEXT NOT NULL CHECK (type IN ('action_peak', 'emotional_peak', 'visual_peak')),
  confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  description TEXT NOT NULL DEFAULT '',
  source_pass TEXT NOT NULL
);

CREATE INDEX idx_peak_moments_segment ON peak_moments(segment_id);
CREATE INDEX idx_peak_moments_type ON peak_moments(type, confidence);

CREATE TABLE segment_transcripts (
  segment_id TEXT PRIMARY KEY REFERENCES segments(segment_id) ON DELETE CASCADE,
  text TEXT NOT NULL DEFAULT '',
  language TEXT,
  confidence_min REAL CHECK (confidence_min IS NULL OR (confidence_min >= 0 AND confidence_min <= 1)),
  has_dialogue INTEGER NOT NULL DEFAULT 0 CHECK (has_dialogue IN (0, 1)),
  item_refs_json TEXT NOT NULL DEFAULT '[]'
);

CREATE INDEX idx_segment_transcripts_dialogue ON segment_transcripts(has_dialogue);

CREATE TABLE marlin_assets (
  asset_id TEXT PRIMARY KEY REFERENCES assets(asset_id) ON DELETE CASCADE,
  source_path TEXT,
  scene TEXT NOT NULL DEFAULT '',
  caption TEXT NOT NULL DEFAULT ''
);

CREATE TABLE marlin_events (
  event_id TEXT PRIMARY KEY,
  asset_id TEXT NOT NULL REFERENCES assets(asset_id) ON DELETE CASCADE,
  start_us INTEGER NOT NULL CHECK (start_us >= 0),
  end_us INTEGER NOT NULL CHECK (end_us >= start_us),
  description TEXT NOT NULL DEFAULT '',
  confidence REAL CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  source_pass TEXT,
  chunk_index INTEGER,
  chunk_offset_us INTEGER
);

CREATE INDEX idx_marlin_events_asset_time ON marlin_events(asset_id, start_us, end_us);

CREATE TABLE embedding_texts (
  segment_id TEXT NOT NULL REFERENCES segments(segment_id) ON DELETE CASCADE,
  field TEXT NOT NULL CHECK (field IN ('summary', 'transcript', 'scene', 'combined')),
  text TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (segment_id, field)
);

CREATE TABLE embeddings (
  segment_id TEXT NOT NULL REFERENCES segments(segment_id) ON DELETE CASCADE,
  field TEXT NOT NULL CHECK (field IN ('summary', 'transcript', 'scene', 'combined')),
  model_id TEXT NOT NULL,
  dimension INTEGER NOT NULL CHECK (dimension > 0),
  vector BLOB NOT NULL,
  content_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (segment_id, field, model_id),
  FOREIGN KEY (segment_id, field) REFERENCES embedding_texts(segment_id, field) ON DELETE CASCADE
);

CREATE INDEX idx_embeddings_model_field ON embeddings(model_id, field);

CREATE TABLE segment_index_state (
  segment_id TEXT PRIMARY KEY REFERENCES segments(segment_id) ON DELETE CASCADE,
  segment_hash TEXT NOT NULL,
  asset_hash TEXT NOT NULL,
  transcript_hash TEXT,
  marlin_hash TEXT,
  appraisal_hash TEXT,
  embedding_combined_hash TEXT,
  indexed_at TEXT NOT NULL
);

CREATE VIRTUAL TABLE segments_fts USING fts5(
  segment_id UNINDEXED,
  asset_id UNINDEXED,
  summary,
  transcript,
  marlin_scene,
  marlin_events,
  tags,
  quality_labels,
  extracted_text,
  place,
  aesthetic_notes,
  tokenize = "unicode61 remove_diacritics 2 tokenchars '_-'"
);

CREATE VIRTUAL TABLE segment_metadata_fts USING fts5(
  segment_id UNINDEXED,
  cinematography,
  technical,
  audio,
  logging,
  tokenize = "unicode61 remove_diacritics 2 tokenchars '_-'"
);

CREATE TABLE embedding_models (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  model_revision TEXT NOT NULL,
  output_dimension INTEGER NOT NULL CHECK (output_dimension >= 0),
  input_modality TEXT NOT NULL CHECK (
    input_modality IN ('text', 'image', 'screenshot', 'video', 'audio', 'audio_text', 'mixed', 'multimodal', 'reranker')
  ),
  instruction TEXT NOT NULL DEFAULT '',
  preprocess_version TEXT NOT NULL,
  runner_name TEXT NOT NULL,
  runner_version TEXT NOT NULL,
  precision TEXT NOT NULL,
  normalized INTEGER NOT NULL CHECK (normalized IN (0, 1)),
  distance_metric TEXT NOT NULL CHECK (distance_metric IN ('cosine', 'dot', 'l2', 'rerank_score')),
  license TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (name, model_revision, output_dimension, input_modality, instruction, preprocess_version, runner_name, runner_version, precision, normalized, distance_metric)
) STRICT;

CREATE TABLE segment_embeddings (
  id INTEGER PRIMARY KEY,
  segment_id TEXT NOT NULL REFERENCES segments(segment_id) ON DELETE CASCADE,
  embedding_type TEXT NOT NULL CHECK (
    embedding_type IN (
      'summary', 'transcript', 'scene', 'combined',
      'visual_representative', 'visual_keyframe_in', 'visual_keyframe_peak',
      'visual_keyframe_out', 'text_combined_qwen', 'mixed_representative',
      'audio_representative', 'audio_text_clap'
    )
  ),
  model_id INTEGER NOT NULL REFERENCES embedding_models(id) ON DELETE RESTRICT,
  source_ref TEXT NOT NULL DEFAULT '',
  source_timestamp_us INTEGER CHECK (source_timestamp_us IS NULL OR source_timestamp_us >= 0),
  content_hash TEXT NOT NULL,
  dimension INTEGER NOT NULL CHECK (dimension > 0),
  vector BLOB NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (segment_id, embedding_type, model_id, source_ref, content_hash)
) STRICT;

CREATE INDEX idx_segment_embeddings_segment ON segment_embeddings(segment_id);
CREATE INDEX idx_segment_embeddings_model ON segment_embeddings(model_id);
CREATE INDEX idx_segment_embeddings_type_model ON segment_embeddings(embedding_type, model_id);
`;

export async function buildFootageDb(options: BuildFootageDbOptions): Promise<BuildFootageDbResult> {
  const projectDir = path.resolve(options.projectDir);
  const outputPath = path.resolve(options.outputPath ?? footageDbPath(projectDir));
  const reportPath = path.join(path.dirname(outputPath), "footage-db-build-report.json");
  const embeddingPolicy = options.embeddingPolicy ?? "auto";
  const now = options.now ?? new Date();
  const indexedAt = now.toISOString();
  const inputs = loadInputs(projectDir);
  const warnings = [...inputs.warnings];

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const tempPath = `${outputPath}.tmp-${process.pid}-${Date.now()}`;
  fs.rmSync(tempPath, { force: true });

  const previousRemoteSetting = process.env.VIDEO_OS_ALLOW_REMOTE_EMBEDDING_MODELS;
  process.env.VIDEO_OS_ALLOW_REMOTE_EMBEDDING_MODELS = options.allowRemoteEmbeddingModels ? "1" : "0";

  let db: Database.Database | null = null;
  try {
    db = new Database(tempPath);
    db.pragma("journal_mode = DELETE");
    db.pragma("foreign_keys = ON");
    db.exec(FOOTAGE_DB_DDL);

    insertSources(db, inputs.sources, indexedAt);
    const population = await populateStructuredTables(db, inputs, indexedAt, {
      skipAudioAnalysis: options.skipAudioAnalysis === true,
      projectDir,
    });
    warnings.push(...population.warnings);
    const e5Embedding = await populateEmbeddings(db, population.embeddingTexts, embeddingPolicy, indexedAt, warnings);
    const qwenEmbedding = await populateQwen3VlEmbeddings(db, {
      projectDir,
      outputPath,
      segments: population.segments,
      embeddingTexts: population.embeddingTexts,
      enabled: options.qwen3vlEnabled === true || (embeddingPolicy !== "skip" && options.qwen3vlEnabled !== false),
      embedTypes: normalizeQwen3VlEmbedTypes(options.qwen3vlEmbedTypes),
      requestTimeoutMs: options.qwen3vlRequestTimeoutMs ?? QWEN3VL_DEFAULT_REQUEST_TIMEOUT_MS,
      createdAt: indexedAt,
      warnings,
      onProgress: options.onQwen3VlProgress,
    });
    const clapEmbedding = await populateClapAudioEmbeddings(db, {
      projectDir,
      outputPath,
      segments: population.segments,
      embeddingTexts: population.embeddingTexts,
      enabled: options.clapAudioEnabled === true || (
        embeddingPolicy !== "skip"
        && options.clapAudioEnabled !== false
        && clapAudioWorkerAvailable(projectDir)
      ),
      requestTimeoutMs: options.clapAudioRequestTimeoutMs ?? CLAP_AUDIO_DEFAULT_REQUEST_TIMEOUT_MS,
      createdAt: indexedAt,
      warnings,
      onProgress: options.onClapAudioProgress,
    });
    const embedding = mergeEmbeddingResults(e5Embedding, qwenEmbedding, clapEmbedding);
    insertMeta(db, {
      schema_version: SCHEMA_VERSION,
      artifact_version: ARTIFACT_VERSION,
      metadata_schema_version: "1",
      editorial_observation_materialization_revision: EDITORIAL_OBSERVATION_MATERIALIZATION_REVISION,
      project_id: inputs.projectId,
      created_at: indexedAt,
      builder: "scripts/build-footage-db.ts",
      embedding_status: embedding.status,
      embedding_model_id: embedding.status === "ready" ? EMBEDDING_MODEL_ID : "",
      source_hash_policy: "normalized-json-v1",
    });
    insertWarnings(db, warnings, indexedAt);

    const integrity = db.prepare("PRAGMA integrity_check").pluck().get();
    if (integrity !== "ok") throw new Error(`footage DB integrity_check failed: ${String(integrity)}`);
    db.close();
    db = null;
    fs.renameSync(tempPath, outputPath);

    const sourceHashes = Object.fromEntries(inputs.sources.map((source) => [source.rel_path, source.hash]));
    const result: BuildFootageDbResult = {
      db_path: outputPath,
      report_path: reportPath,
      artifact_version: ARTIFACT_VERSION,
      schema_version: SCHEMA_VERSION,
      counts: {
        ...population.counts,
        embeddings: embedding.count,
      },
      embedding_status: embedding.status,
      embedding_counts: embedding.counts,
      embedding_statuses: embedding.statuses,
      warnings,
      source_hashes: sourceHashes,
    };
    writeBuildReport(reportPath, projectDir, outputPath, result, inputs.projectId, indexedAt);
    return result;
  } catch (error) {
    if (db) db.close();
    fs.rmSync(tempPath, { force: true });
    if (embeddingPolicy === "require") {
      throw error;
    }
    throw error;
  } finally {
    if (previousRemoteSetting === undefined) delete process.env.VIDEO_OS_ALLOW_REMOTE_EMBEDDING_MODELS;
    else process.env.VIDEO_OS_ALLOW_REMOTE_EMBEDDING_MODELS = previousRemoteSetting;
  }
}

export function normalizeSearchText(value: string): string {
  return value.normalize("NFC").replace(/\s+/g, " ").trim();
}

export function cjkSearchExpansions(value: string): string[] {
  const chars = Array.from(value).filter((char) => /[\u3040-\u30ff\u3400-\u9fff]/u.test(char));
  const bigrams: string[] = [];
  for (let i = 0; i < chars.length - 1; i += 1) bigrams.push(chars[i] + chars[i + 1]);
  return Array.from(new Set([...chars, ...bigrams]));
}

function loadInputs(projectDir: string): LoadedInputs {
  const assetsPath = path.join(projectDir, "03_analysis/assets.json");
  const segmentsPath = path.join(projectDir, "03_analysis/segments.json");
  const marlinPath = path.join(projectDir, "03_analysis/marlin_events.json");
  const annotationsPath = path.join(projectDir, "03_analysis/footage_user_annotations.json");
  const filenameParserPath = path.join(projectDir, "03_analysis/footage_filename_parser.json");
  const assetsJson = readRequiredJson(assetsPath);
  const segmentsJson = readRequiredJson(segmentsPath);
  const warnings: string[] = [];
  const sources: SourceRecord[] = [
    sourceRecord(projectDir, "assets", "03_analysis/assets.json", true, assetsJson),
    sourceRecord(projectDir, "segments", "03_analysis/segments.json", true, segmentsJson),
  ];

  let marlinJson: JsonRecord | null = null;
  if (fs.existsSync(marlinPath)) {
    marlinJson = readRequiredJson(marlinPath);
    sources.push(sourceRecord(projectDir, "marlin_events", "03_analysis/marlin_events.json", false, marlinJson));
  } else {
    warnings.push("optional source missing: 03_analysis/marlin_events.json");
  }

  const annotations = loadUserAnnotations(projectDir, annotationsPath, sources, warnings);
  const filenameParser = loadFilenameParser(projectDir, filenameParserPath, sources, warnings);
  const transcripts = readTranscriptDocuments(projectDir);
  for (const transcript of transcripts) {
    sources.push({
      source_name: `transcript:${path.basename(transcript.relPath)}`,
      rel_path: transcript.relPath,
      hash: transcript.hash,
      required: false,
    });
  }

  return {
    projectId: readProjectId(projectDir, assetsJson, segmentsJson),
    assetsJson,
    segmentsJson,
    marlinJson,
    transcripts,
    annotations,
    filenameParser,
    sources,
    warnings,
  };
}

async function populateStructuredTables(
  db: Database.Database,
  inputs: LoadedInputs,
  indexedAt: string,
  options: { projectDir: string; skipAudioAnalysis: boolean },
): Promise<PopulationResult> {
  const warnings: string[] = [];
  const assetItems = readArrayFrom(inputs.assetsJson, "items", "assets");
  const segmentItems = readArrayFrom(inputs.segmentsJson, "items", "segments");
  const assetById = new Map<string, JsonRecord>();
  const marlinByAsset = buildMarlinMap(inputs.marlinJson);
  const transcripts = buildTranscriptMap(inputs.transcripts);
  const embeddingTexts: PopulationResult["embeddingTexts"] = [];
  const segmentRecords: SegmentBuildRecord[] = [];

  const insertAsset = db.prepare(`
    INSERT INTO assets (
      asset_id, filename, display_name, role_guess, duration_us, has_transcript, transcript_ref,
      source_locator, source_fingerprint, poster_path, waveform_path, tags_json, quality_flags_json,
      source_order, shooting_date, shooting_time, camera_type
    ) VALUES (
      @asset_id, @filename, @display_name, @role_guess, @duration_us, @has_transcript, @transcript_ref,
      @source_locator, @source_fingerprint, @poster_path, @waveform_path, @tags_json, @quality_flags_json,
      @source_order, @shooting_date, @shooting_time, @camera_type
    )
  `);
  const insertAssetTechnical = db.prepare(`
    INSERT INTO asset_technical_metadata (
      asset_id, container_format, container_long_name, recording_format, video_codec, video_profile,
      codec_tag, width, height, fps_num, fps_den, r_frame_rate, time_base, frame_rate_mode,
      pix_fmt, bit_depth, color_primaries, color_transfer, color_space, color_range, rotation,
      stream_duration_json, audio_streams_json, timecode_start, timecode_format, reel_name,
      card_id, camera_id, extraction_source_json, evidence_json
    ) VALUES (
      @asset_id, @container_format, @container_long_name, @recording_format, @video_codec, @video_profile,
      @codec_tag, @width, @height, @fps_num, @fps_den, @r_frame_rate, @time_base, @frame_rate_mode,
      @pix_fmt, @bit_depth, @color_primaries, @color_transfer, @color_space, @color_range, @rotation,
      @stream_duration_json, @audio_streams_json, @timecode_start, @timecode_format, @reel_name,
      @card_id, @camera_id, @extraction_source_json, @evidence_json
    )
  `);
  const insertMarlinAsset = db.prepare(`
    INSERT INTO marlin_assets (asset_id, source_path, scene, caption)
    VALUES (@asset_id, @source_path, @scene, @caption)
  `);
  const insertMarlinEvent = db.prepare(`
    INSERT INTO marlin_events (
      event_id, asset_id, start_us, end_us, description, confidence, source_pass, chunk_index, chunk_offset_us
    ) VALUES (
      @event_id, @asset_id, @start_us, @end_us, @description, @confidence, @source_pass, @chunk_index, @chunk_offset_us
    )
  `);

  let assetCount = 0;
  let assetTechnicalCount = 0;
  let marlinEventCount = 0;
  const assetTx = db.transaction(() => {
    assetItems.forEach((asset, index) => {
      const assetId = stringValue(asset.asset_id);
      if (!assetId) {
        warnings.push(`assets[${index}] skipped: missing asset_id`);
        return;
      }
      assetById.set(assetId, asset);
      insertAsset.run({
        asset_id: assetId,
        filename: stringValue(asset.filename) || path.basename(stringValue(asset.path) || assetId),
        display_name: nullableString(asset.display_name),
        role_guess: nullableString(asset.role_guess),
        duration_us: nonNegativeInteger(asset.duration_us) ?? 0,
        has_transcript: truthy(asset.has_transcript) ? 1 : 0,
        transcript_ref: nullableString(asset.transcript_ref),
        source_locator: nullableString(asset.source_locator ?? asset.path),
        source_fingerprint: nullableString(asset.source_fingerprint ?? asset.fingerprint ?? asset.content_hash),
        poster_path: nullableString(asset.poster_path),
        waveform_path: nullableString(asset.waveform_path),
        tags_json: jsonArray(asset.tags),
        quality_flags_json: jsonArray(asset.quality_flags),
        source_order: index,
        shooting_date: nullableString(asset.shooting_date),
        shooting_time: nullableString(asset.shooting_time),
        camera_type: nullableString(asset.camera_type),
      });
      insertAssetTechnical.run(assetTechnicalRow(assetId, asset));
      assetCount += 1;
      assetTechnicalCount += 1;
    });

    for (const marlin of marlinByAsset.values()) {
      if (!assetById.has(marlin.asset_id)) {
        warnings.push(`marlin_events skipped for missing asset_id ${marlin.asset_id}`);
        continue;
      }
      insertMarlinAsset.run({
        asset_id: marlin.asset_id,
        source_path: marlin.source_path,
        scene: marlin.scene,
        caption: marlin.caption,
      });
      const seenEventIds = new Set<string>();
      marlin.events.forEach((event, index) => {
        const eventId = stringValue(event.event_id) || `MEV_${marlin.asset_id}_${String(index + 1).padStart(4, "0")}`;
        const startUs = nonNegativeInteger(event.start_us) ?? 0;
        const endUs = nonNegativeInteger(event.end_us) ?? startUs;
        const uniqueEventId = seenEventIds.has(eventId) ? `${eventId}_${index + 1}` : eventId;
        seenEventIds.add(uniqueEventId);
        insertMarlinEvent.run({
          event_id: uniqueEventId,
          asset_id: marlin.asset_id,
          start_us: startUs,
          end_us: Math.max(startUs, endUs),
          description: stringValue(event.description),
          confidence: scoreOrNull(event.confidence),
          source_pass: nullableString(event.source_pass),
          chunk_index: integerOrNull(event.chunk_index),
          chunk_offset_us: integerOrNull(event.chunk_offset_us),
        });
        marlinEventCount += 1;
      });
    }
  });
  assetTx();

  const insertSegment = db.prepare(`
    INSERT INTO segments (
      segment_id, asset_id, src_in_us, src_out_us, rep_frame_us, segment_type, summary,
      transcript_excerpt, transcript_ref, tags_json, quality_flags_json, interest_points_json,
      filmstrip_path, waveform_path
    ) VALUES (
      @segment_id, @asset_id, @src_in_us, @src_out_us, @rep_frame_us, @segment_type, @summary,
      @transcript_excerpt, @transcript_ref, @tags_json, @quality_flags_json, @interest_points_json,
      @filmstrip_path, @waveform_path
    )
  `);
  const insertVisualQuality = db.prepare(`
    INSERT INTO visual_quality (
      segment_id, light_quality, subject_prominence, emotional_expression, composition_score, motion_quality,
      lighting_style_json, composition_tags_json, expression_tags_json, motion_tags_json
    ) VALUES (
      @segment_id, @light_quality, @subject_prominence, @emotional_expression, @composition_score, @motion_quality,
      @lighting_style_json, @composition_tags_json, @expression_tags_json, @motion_tags_json
    )
  `);
  const insertVisualAppraisal = db.prepare(`
    INSERT INTO visual_appraisal (
      segment_id, frame_us, frame_path, extracted_text_json, extracted_text_flat, place_hint_name,
      place_hint_category, place_hint_confidence, place_hint_evidence_json, aesthetic_notes_json,
      aesthetic_notes_flat
    ) VALUES (
      @segment_id, @frame_us, @frame_path, @extracted_text_json, @extracted_text_flat, @place_hint_name,
      @place_hint_category, @place_hint_confidence, @place_hint_evidence_json, @aesthetic_notes_json,
      @aesthetic_notes_flat
    )
  `);
  const insertPeakAnalysis = db.prepare(`
    INSERT INTO peak_analysis (
      segment_id, recommended_in_us, recommended_out_us, recommended_rationale,
      motion_support_score, audio_support_score, fused_peak_score
    ) VALUES (
      @segment_id, @recommended_in_us, @recommended_out_us, @recommended_rationale,
      @motion_support_score, @audio_support_score, @fused_peak_score
    )
  `);
  const insertPeakMoment = db.prepare(`
    INSERT INTO peak_moments (
      peak_ref, segment_id, timestamp_us, type, confidence, description, source_pass
    ) VALUES (
      @peak_ref, @segment_id, @timestamp_us, @type, @confidence, @description, @source_pass
    )
  `);
  const insertTranscript = db.prepare(`
    INSERT INTO segment_transcripts (segment_id, text, language, confidence_min, has_dialogue, item_refs_json)
    VALUES (@segment_id, @text, @language, @confidence_min, @has_dialogue, @item_refs_json)
  `);
  const insertVisualProfile = db.prepare(`
    INSERT INTO segment_visual_profile (
      segment_id, camera_motion_description, camera_motion_type, camera_motion_direction, camera_stability,
      motion_energy, camera_motion_energy, shot_scale, composition_anchor, subject_screen_side,
      dominant_subject_type, subject_movement_direction, exposure_label, color_temperature,
      contrast_label, saturation_label, dominant_colors_json, sampled_frame_count, depth_of_field,
      motion_confidence, scale_confidence, subject_confidence, color_confidence, depth_confidence,
      extraction_source_json, evidence_json
    ) VALUES (
      @segment_id, @camera_motion_description, @camera_motion_type, @camera_motion_direction, @camera_stability,
      @motion_energy, @camera_motion_energy, @shot_scale, @composition_anchor, @subject_screen_side,
      @dominant_subject_type, @subject_movement_direction, @exposure_label, @color_temperature,
      @contrast_label, @saturation_label, @dominant_colors_json, @sampled_frame_count, @depth_of_field,
      @motion_confidence, @scale_confidence, @subject_confidence, @color_confidence, @depth_confidence,
      @extraction_source_json, @evidence_json
    )
  `);
  const insertAudioProfile = db.prepare(`
    INSERT INTO segment_audio_profile (
      segment_id, audio_role, has_dialogue, has_music, has_ambient, peak_dbfs, rms_dbfs,
      integrated_lufs, silence_ratio, silence_head_us, silence_tail_us, speech_density,
      music_density, noise_flags_json, audio_handle_head_us, audio_handle_tail_us, confidence,
      extraction_source_json, evidence_json
    ) VALUES (
      @segment_id, @audio_role, @has_dialogue, @has_music, @has_ambient, @peak_dbfs, @rms_dbfs,
      @integrated_lufs, @silence_ratio, @silence_head_us, @silence_tail_us, @speech_density,
      @music_density, @noise_flags_json, @audio_handle_head_us, @audio_handle_tail_us, @confidence,
      @extraction_source_json, @evidence_json
    )
  `);
  const insertLogging = db.prepare(`
    INSERT INTO segment_logging_profile (
      segment_id, scene_number, shot_number, take_number, camera_id, card_id, circle_take,
      best_take, custom_tags_json, operator_notes, source, confidence, evidence_json
    ) VALUES (
      @segment_id, @scene_number, @shot_number, @take_number, @camera_id, @card_id, @circle_take,
      @best_take, @custom_tags_json, @operator_notes, @source, @confidence, @evidence_json
    )
  `);
  const insertUsability = db.prepare(`
    INSERT INTO segment_usability_profile (
      segment_id, usability, confidence, evidence_json
    ) VALUES (
      @segment_id, @usability, @confidence, @evidence_json
    )
  `);
  const insertFts = db.prepare(`
    INSERT INTO segments_fts (
      segment_id, asset_id, summary, transcript, marlin_scene, marlin_events, tags,
      quality_labels, extracted_text, place, aesthetic_notes
    ) VALUES (
      @segment_id, @asset_id, @summary, @transcript, @marlin_scene, @marlin_events, @tags,
      @quality_labels, @extracted_text, @place, @aesthetic_notes
    )
  `);
  const insertMetadataFts = db.prepare(`
    INSERT INTO segment_metadata_fts (
      segment_id, cinematography, technical, audio, logging
    ) VALUES (
      @segment_id, @cinematography, @technical, @audio, @logging
    )
  `);
  const insertEmbeddingText = db.prepare(`
    INSERT INTO embedding_texts (segment_id, field, text, content_hash, updated_at)
    VALUES (@segment_id, @field, @text, @content_hash, @updated_at)
  `);
  const insertIndexState = db.prepare(`
    INSERT INTO segment_index_state (
      segment_id, segment_hash, asset_hash, transcript_hash, marlin_hash, appraisal_hash,
      embedding_combined_hash, indexed_at
    ) VALUES (
      @segment_id, @segment_hash, @asset_hash, @transcript_hash, @marlin_hash, @appraisal_hash,
      @embedding_combined_hash, @indexed_at
    )
  `);

  let segmentCount = 0;
  let ftsRows = 0;
  let transcriptSegments = 0;
  let segmentVisualProfiles = 0;
  let segmentAudioProfiles = 0;
  let segmentLogging = 0;
  let metadataFtsRows = 0;
  for (const [index, segment] of segmentItems.entries()) {
    const segmentId = stringValue(segment.segment_id) || `SEG_${index + 1}`;
    const assetId = stringValue(segment.asset_id);
    const asset = assetById.get(assetId);
    if (!asset) {
      warnings.push(`segment ${segmentId} skipped: missing asset_id ${assetId || "unknown"}`);
      continue;
    }
    const srcInUs = nonNegativeInteger(segment.src_in_us ?? segment.start_us);
    const srcOutUs = nonNegativeInteger(segment.src_out_us ?? segment.end_us);
    if (srcInUs == null || srcOutUs == null || srcOutUs <= srcInUs) {
      warnings.push(`segment ${segmentId} skipped: invalid source range`);
      continue;
    }

    const transcript = transcriptForSegment(segment, asset, transcripts, srcInUs, srcOutUs);
    const appraisal = recordValue(segment.visual_appraisal);
    const quality = recordValue(segment.visual_quality);
    const record = segmentBuildRecord(segment, asset, segmentId, assetId, srcInUs, srcOutUs, transcript, marlinByAsset);
    const segmentType = stringValue(segment.segment_type);
    const normalizedSegmentType = VALID_SEGMENT_TYPES.has(segmentType) ? segmentType : null;
    insertSegment.run({
      segment_id: segmentId,
      asset_id: assetId,
      src_in_us: srcInUs,
      src_out_us: srcOutUs,
      rep_frame_us: nonNegativeInteger(segment.rep_frame_us),
      segment_type: normalizedSegmentType,
      summary: record.summary,
      transcript_excerpt: record.transcriptExcerpt,
      transcript_ref: nullableString(segment.transcript_ref ?? asset.transcript_ref),
      tags_json: JSON.stringify(record.tags),
      quality_flags_json: JSON.stringify(record.qualityFlags),
      interest_points_json: jsonArray(segment.interest_points),
      filmstrip_path: nullableString(segment.filmstrip_path),
      waveform_path: nullableString(segment.waveform_path),
    });
    insertVisualQuality.run(visualQualityRow(segmentId, quality));
    insertVisualAppraisal.run(visualAppraisalRow(segmentId, appraisal));
    insertPeakAnalysis.run(peakAnalysisRow(segmentId, recordValue(segment.peak_analysis)));
    insertPeakMoments(insertPeakMoment, segmentId, recordValue(segment.peak_analysis), warnings);
    const visualProfile = segmentVisualProfileRow(segmentId, record);
    const audioProfile = await segmentAudioProfileRow(segmentId, record, transcript, normalizedSegmentType, options, warnings);
    const logging = segmentLoggingRow(segmentId, segment, asset, inputs.annotations, inputs.filenameParser);
    const usability = classifyUsability(segmentId, quality, record.qualityFlags);
    insertTranscript.run({
      segment_id: segmentId,
      text: transcript.text,
      language: transcript.language,
      confidence_min: transcript.confidenceMin,
      has_dialogue: transcript.hasDialogue ? 1 : 0,
      item_refs_json: JSON.stringify(transcript.itemRefs),
    });
    if (transcript.text.trim()) transcriptSegments += 1;
    insertVisualProfile.run(visualProfile);
    segmentVisualProfiles += 1;
    insertAudioProfile.run(audioProfile);
    segmentAudioProfiles += 1;
    insertLogging.run(logging);
    insertUsability.run({
      segment_id: segmentId,
      usability: usability.usability,
      confidence: usability.confidence,
      evidence_json: JSON.stringify(usability.evidence),
    });
    segmentLogging += 1;
    insertFts.run(ftsRow(record, visualProfile, logging, audioProfile, usability));
    ftsRows += 1;
    insertMetadataFts.run(metadataFtsRow(record, visualProfile, audioProfile, logging, usability));
    metadataFtsRows += 1;

    const fieldTexts = embeddingTextBundles(record, visualProfile, logging, audioProfile, usability);
    for (const field of Object.keys(fieldTexts) as EmbeddingField[]) {
      const text = normalizeSearchText(fieldTexts[field]);
      const contentHash = hashValue(text);
      const row = { segment_id: segmentId, field, text, content_hash: contentHash, updated_at: indexedAt };
      insertEmbeddingText.run(row);
      embeddingTexts.push(row);
    }
    insertIndexState.run({
      segment_id: segmentId,
      segment_hash: hashValue(segment),
      asset_hash: hashValue(asset),
      transcript_hash: transcript.transcriptHash,
      marlin_hash: record.marlinSceneText || record.marlinEvents.length > 0 ? hashValue([record.marlinSceneText, record.marlinEvents]) : null,
      appraisal_hash: segment.visual_appraisal ? hashValue(segment.visual_appraisal) : null,
      embedding_combined_hash: hashValue(fieldTexts.combined),
      indexed_at: indexedAt,
    });
    segmentRecords.push(record);
    segmentCount += 1;
  }

  return {
    counts: {
      assets: assetCount,
      segments: segmentCount,
        fts_rows: ftsRows,
        marlin_events: marlinEventCount,
        transcript_segments: transcriptSegments,
        asset_technical_metadata: assetTechnicalCount,
        segment_visual_profiles: segmentVisualProfiles,
        segment_audio_profiles: segmentAudioProfiles,
        segment_logging_profiles: segmentLogging,
        metadata_fts_rows: metadataFtsRows,
        embeddings: 0,
      },
    embeddingTexts,
    segments: segmentRecords,
    warnings,
  };
}

async function populateEmbeddings(
  db: Database.Database,
  embeddingTexts: Array<{ segment_id: string; field: EmbeddingField; text: string; content_hash: string }>,
  policy: FootageDbEmbeddingPolicy,
  createdAt: string,
  warnings: string[],
): Promise<EmbeddingPopulationResult> {
  if (policy === "skip") return embeddingPopulationResult("skipped", 0);

  const rows = embeddingTexts.filter((row) => row.text.trim().length > 0);
  if (rows.length === 0) return embeddingPopulationResult("ready", 0);

  try {
    const vectors = await embedTexts(rows.map((row) => row.text), "passage");
    if (vectors.length !== rows.length || vectors.length === 0) {
      const message = "embedding model unavailable or returned no vectors";
      if (policy === "require") throw new Error(message);
      warnings.push(message);
      return embeddingPopulationResult("unavailable", 0);
    }

    const e5ModelId = upsertEmbeddingModel(db, e5EmbeddingModel(createdAt));
    const insertEmbedding = db.prepare(`
      INSERT INTO embeddings (
        segment_id, field, model_id, dimension, vector, content_hash, created_at
      ) VALUES (
        @segment_id, @field, @model_id, @dimension, @vector, @content_hash, @created_at
      )
    `);
    const insertSegmentEmbedding = db.prepare(`
      INSERT INTO segment_embeddings (
        segment_id, embedding_type, model_id, source_ref, source_timestamp_us,
        content_hash, dimension, vector, created_at
      ) VALUES (
        @segment_id, @embedding_type, @model_id, @source_ref, @source_timestamp_us,
        @content_hash, @dimension, @vector, @created_at
      )
    `);
    let count = 0;
    const tx = db.transaction(() => {
      rows.forEach((row, index) => {
        const vector = vectors[index];
        if (vector.length === 0) return;
        if (vector.length !== E5_OUTPUT_DIMENSION) {
          warnings.push(`embedding for ${row.segment_id}/${row.field} skipped: expected ${E5_OUTPUT_DIMENSION} dimensions, got ${vector.length}`);
          return;
        }
        const vectorBlob = Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength);
        insertEmbedding.run({
          segment_id: row.segment_id,
          field: row.field,
          model_id: EMBEDDING_MODEL_ID,
          dimension: E5_OUTPUT_DIMENSION,
          vector: vectorBlob,
          content_hash: row.content_hash,
          created_at: createdAt,
        });
        insertSegmentEmbedding.run({
          segment_id: row.segment_id,
          embedding_type: row.field,
          model_id: e5ModelId,
          source_ref: `embedding_texts:${row.field}`,
          source_timestamp_us: null,
          content_hash: row.content_hash,
          dimension: E5_OUTPUT_DIMENSION,
          vector: vectorBlob,
          created_at: createdAt,
        });
        count += 1;
      });
    });
    tx();
    if (count === 0 && policy === "require") {
      throw new Error("embedding model returned only empty vectors");
    }
    return embeddingPopulationResult(count > 0 ? "ready" : "unavailable", count);
  } catch (error) {
    const message = `embedding population failed: ${error instanceof Error ? error.message : String(error)}`;
    if (policy === "require") throw new Error(message);
    warnings.push(message);
    return embeddingPopulationResult("unavailable", 0);
  }
}

async function populateQwen3VlEmbeddings(
  db: Database.Database,
  options: Qwen3VlPopulationOptions,
): Promise<Qwen3VlPopulationResult> {
  const result = qwen3VlPopulationResult();
  const wantsVisual = options.embedTypes.includes("visual_representative");
  const wantsText = options.embedTypes.includes("text_combined_qwen");
  if (!options.enabled || (!wantsVisual && !wantsText)) {
    return result;
  }

  const modelId = upsertEmbeddingModel(db, qwen3VlEmbeddingModel(options.createdAt));
  let previousDb: Database.Database | null = null;
  let client: Qwen3VlEmbeddingClient | null = null;

  try {
    previousDb = openReusableFootageDb(options.outputPath);

    if (wantsVisual) {
      const frames = await buildRepresentativeFrameCache(options.projectDir, options.segments, options.createdAt, options.warnings, options.onProgress);
      copyReusableQwenRows(db, previousDb, modelId, "visual_representative", frames.map((frame) => ({
        segmentId: frame.segmentId,
        sourceRef: frame.outputRelPath,
        sourceTimestampUs: frame.timestampUs,
        contentHash: frame.contentHash,
      })), options.createdAt);
      const pendingFrames = frames.filter((frame) => !segmentEmbeddingExists(db, frame.segmentId, "visual_representative", modelId, frame.contentHash));
      if (pendingFrames.length > 0) {
        options.onProgress?.({ phase: "visual", completed: 0, total: pendingFrames.length });
        client ??= await createQwen3VlBuilderClient(options.requestTimeoutMs);
        await embedAndInsertQwenRows(db, client, {
          modelId,
          embeddingType: "visual_representative",
          createdAt: options.createdAt,
          requestTimeoutMs: options.requestTimeoutMs,
          warnings: options.warnings,
          items: pendingFrames.map((frame) => ({
            ref: `${frame.segmentId}:visual_representative`,
            kind: "image",
            imagePath: frame.framePath,
          })),
          rowByRef: new Map(pendingFrames.map((frame) => [
            `${frame.segmentId}:visual_representative`,
            {
              segmentId: frame.segmentId,
              sourceRef: frame.outputRelPath,
              sourceTimestampUs: frame.timestampUs,
              contentHash: frame.contentHash,
            },
          ])),
        });
        options.onProgress?.({ phase: "visual", completed: pendingFrames.length, total: pendingFrames.length });
      }
      result.counts.qwen_visual = countSegmentEmbeddings(db, modelId, "visual_representative");
      result.statuses.qwen_visual = result.counts.qwen_visual > 0 ? "ready" : "skipped";
    }

    if (wantsText) {
      const textRows = qwenTextEmbeddingInputs(options.embeddingTexts);
      copyReusableQwenRows(db, previousDb, modelId, "text_combined_qwen", textRows.map((row) => ({
        segmentId: row.segmentId,
        sourceRef: "embedding_texts:combined",
        sourceTimestampUs: null,
        contentHash: row.contentHash,
      })), options.createdAt);
      const pendingTextRows = textRows.filter((row) => !segmentEmbeddingExists(db, row.segmentId, "text_combined_qwen", modelId, row.contentHash));
      if (pendingTextRows.length > 0) {
        options.onProgress?.({ phase: "text", completed: 0, total: pendingTextRows.length });
        client ??= await createQwen3VlBuilderClient(options.requestTimeoutMs);
        await embedAndInsertQwenRows(db, client, {
          modelId,
          embeddingType: "text_combined_qwen",
          createdAt: options.createdAt,
          requestTimeoutMs: options.requestTimeoutMs,
          warnings: options.warnings,
          items: pendingTextRows.map((row) => ({
            ref: `${row.segmentId}:text_combined_qwen`,
            kind: "text",
            text: row.text,
          })),
          rowByRef: new Map(pendingTextRows.map((row) => [
            `${row.segmentId}:text_combined_qwen`,
            {
              segmentId: row.segmentId,
              sourceRef: "embedding_texts:combined",
              sourceTimestampUs: null,
              contentHash: row.contentHash,
            },
          ])),
        });
        options.onProgress?.({ phase: "text", completed: pendingTextRows.length, total: pendingTextRows.length });
      }
      result.counts.qwen_text = countSegmentEmbeddings(db, modelId, "text_combined_qwen");
      result.statuses.qwen_text = result.counts.qwen_text > 0 ? "ready" : "skipped";
    }

    result.count = result.counts.qwen_visual + result.counts.qwen_text;
    return result;
  } catch (error) {
    const status = qwenFailureStatus(error);
    options.warnings.push(`qwen3vl embedding ${status === "unavailable" ? "unavailable" : "failed"}: ${error instanceof Error ? error.message : String(error)}`);
    if (wantsVisual) {
      result.counts.qwen_visual = countSegmentEmbeddings(db, modelId, "visual_representative");
      result.statuses.qwen_visual = result.counts.qwen_visual > 0 ? "ready" : status;
    }
    if (wantsText) {
      result.counts.qwen_text = countSegmentEmbeddings(db, modelId, "text_combined_qwen");
      result.statuses.qwen_text = result.counts.qwen_text > 0 ? "ready" : status;
    }
    result.count = result.counts.qwen_visual + result.counts.qwen_text;
    return result;
  } finally {
    previousDb?.close();
    if (client) {
      try {
        await client.shutdown();
      } catch {
        // Shutdown should not turn a fail-open optional channel into a build failure.
      }
    }
  }
}

async function populateClapAudioEmbeddings(
  db: Database.Database,
  options: ClapAudioPopulationOptions,
): Promise<ClapAudioPopulationResult> {
  const result = clapAudioPopulationResult();
  if (!options.enabled) return result;

  const modelId = upsertEmbeddingModel(db, clapAudioEmbeddingModel(options.createdAt));
  let previousDb: Database.Database | null = null;
  let client: ClapAudioEmbeddingClient | null = null;

  try {
    previousDb = openReusableFootageDb(options.outputPath);
    const windows = await buildAudioWindowCache(
      options.projectDir,
      options.segments,
      options.createdAt,
      options.warnings,
      options.onProgress,
    );
    const textRows = clapTextEmbeddingInputs(options.embeddingTexts);

    copyReusableClapRows(db, previousDb, modelId, "audio_representative", windows.map((window) => ({
      segmentId: window.segmentId,
      sourceRef: window.outputRelPath,
      sourceTimestampUs: window.startUs,
      contentHash: window.contentHash,
    })), options.createdAt);
    copyReusableClapRows(db, previousDb, modelId, "audio_text_clap", textRows.map((row) => ({
      segmentId: row.segmentId,
      sourceRef: "embedding_texts:combined",
      sourceTimestampUs: null,
      contentHash: row.contentHash,
    })), options.createdAt);

    const pendingWindows = windows.filter((window) => !segmentEmbeddingExists(db, window.segmentId, "audio_representative", modelId, window.contentHash));
    const pendingTextRows = textRows.filter((row) => !segmentEmbeddingExists(db, row.segmentId, "audio_text_clap", modelId, row.contentHash));
    if (pendingWindows.length > 0 || pendingTextRows.length > 0) {
      client = await createClapAudioBuilderClient(options.requestTimeoutMs);
    }

    if (pendingWindows.length > 0 && client) {
      options.onProgress?.({ phase: "audio", completed: 0, total: pendingWindows.length });
      await embedAndInsertClapAudioRows(db, client, {
        modelId,
        createdAt: options.createdAt,
        requestTimeoutMs: options.requestTimeoutMs,
        warnings: options.warnings,
        windows: pendingWindows,
      });
      options.onProgress?.({ phase: "audio", completed: pendingWindows.length, total: pendingWindows.length });
    }

    if (pendingTextRows.length > 0 && client) {
      options.onProgress?.({ phase: "text", completed: 0, total: pendingTextRows.length });
      await embedAndInsertClapTextRows(db, client, {
        modelId,
        createdAt: options.createdAt,
        requestTimeoutMs: options.requestTimeoutMs,
        warnings: options.warnings,
        rows: pendingTextRows,
      });
      options.onProgress?.({ phase: "text", completed: pendingTextRows.length, total: pendingTextRows.length });
    }

    result.counts.clap_audio = countClapSegmentEmbeddings(db, modelId);
    result.statuses.clap_audio = result.counts.clap_audio > 0 ? "ready" : "skipped";
    result.count = result.counts.clap_audio;
    return result;
  } catch (error) {
    const status = clapAudioFailureStatus(error);
    options.warnings.push(`clap audio embedding ${status === "unavailable" ? "unavailable" : "failed"}: ${error instanceof Error ? error.message : String(error)}`);
    result.counts.clap_audio = countClapSegmentEmbeddings(db, modelId);
    result.statuses.clap_audio = result.counts.clap_audio > 0 ? "ready" : status;
    result.count = result.counts.clap_audio;
    return result;
  } finally {
    previousDb?.close();
    if (client) {
      try {
        await Promise.resolve(client.shutdown());
      } catch {
        // Shutdown should not turn a fail-open optional channel into a build failure.
      }
    }
  }
}

function mergeEmbeddingResults(
  e5: EmbeddingPopulationResult,
  qwen: Qwen3VlPopulationResult,
  clap: ClapAudioPopulationResult,
): EmbeddingPopulationResult {
  const counts: EmbeddingCounts = {
    ...e5.counts,
    qwen_text: qwen.counts.qwen_text,
    qwen_visual: qwen.counts.qwen_visual,
    qwen_mixed: qwen.counts.qwen_mixed,
    qwen_reranker: qwen.counts.qwen_reranker,
    clap_audio: clap.counts.clap_audio,
  };
  const statuses: EmbeddingStatuses = {
    ...e5.statuses,
    qwen_text: qwen.statuses.qwen_text,
    qwen_visual: qwen.statuses.qwen_visual,
    qwen_mixed: qwen.statuses.qwen_mixed,
    qwen_reranker: qwen.statuses.qwen_reranker,
    clap_audio: clap.statuses.clap_audio,
  };
  return {
    status: aggregateEmbeddingStatus(e5, qwen, clap),
    count: e5.count + qwen.count + clap.count,
    counts,
    statuses,
  };
}

function aggregateEmbeddingStatus(
  e5: EmbeddingPopulationResult,
  qwen: Qwen3VlPopulationResult,
  clap: ClapAudioPopulationResult,
): EmbeddingStatus {
  const retrievalStatuses = [
    e5.status,
    qwen.statuses.qwen_text,
    qwen.statuses.qwen_visual,
    qwen.statuses.qwen_mixed,
    clap.statuses.clap_audio,
  ];
  if (retrievalStatuses.includes("ready")) return "ready";
  if (retrievalStatuses.includes("error")) return "error";
  if (retrievalStatuses.includes("unavailable")) return "unavailable";
  return "skipped";
}

function embeddingPopulationResult(status: EmbeddingStatus, e5TextCount: number): EmbeddingPopulationResult {
  const counts: EmbeddingCounts = {
    e5_text: e5TextCount,
    qwen_text: 0,
    qwen_visual: 0,
    qwen_mixed: 0,
    qwen_reranker: 0,
    clap_audio: 0,
  };
  const statuses: EmbeddingStatuses = {
    e5_text: status,
    qwen_text: "skipped",
    qwen_visual: "skipped",
    qwen_mixed: "unsupported",
    qwen_reranker: "deferred",
    clap_audio: "skipped",
  };
  return { status, count: e5TextCount, counts, statuses };
}

function qwen3VlPopulationResult(): Qwen3VlPopulationResult {
  return {
    count: 0,
    counts: {
      qwen_text: 0,
      qwen_visual: 0,
      qwen_mixed: 0,
      qwen_reranker: 0,
    },
    statuses: {
      qwen_text: "skipped",
      qwen_visual: "skipped",
      qwen_mixed: "unsupported",
      qwen_reranker: "deferred",
    },
  };
}

function clapAudioPopulationResult(): ClapAudioPopulationResult {
  return {
    count: 0,
    counts: {
      clap_audio: 0,
    },
    statuses: {
      clap_audio: "skipped",
    },
  };
}

function qwen3VlEmbeddingModel(createdAt: string): EmbeddingModelInput {
  return {
    name: QWEN3VL_MODEL_NAME,
    model_revision: QWEN3VL_MODEL_REVISION,
    output_dimension: QWEN3VL_OUTPUT_DIMENSION,
    input_modality: "multimodal",
    instruction: QWEN3VL_INSTRUCTION,
    preprocess_version: QWEN3VL_PREPROCESS_VERSION,
    runner_name: QWEN3VL_RUNNER_NAME,
    runner_version: QWEN3VL_RUNNER_VERSION,
    precision: QWEN3VL_PRECISION,
    normalized: true,
    distance_metric: "cosine",
    license: QWEN3VL_LICENSE,
    created_at: createdAt,
  };
}

function clapAudioEmbeddingModel(createdAt: string): EmbeddingModelInput {
  return {
    name: CLAP_AUDIO_MODEL_NAME,
    model_revision: CLAP_AUDIO_MODEL_REVISION,
    output_dimension: CLAP_AUDIO_OUTPUT_DIMENSION,
    input_modality: "audio",
    instruction: CLAP_AUDIO_INSTRUCTION,
    preprocess_version: CLAP_AUDIO_PREPROCESS_VERSION,
    runner_name: CLAP_AUDIO_RUNNER_NAME,
    runner_version: CLAP_AUDIO_RUNNER_VERSION,
    precision: CLAP_AUDIO_PRECISION,
    normalized: true,
    distance_metric: "cosine",
    license: CLAP_AUDIO_LICENSE,
    created_at: createdAt,
  };
}

async function createQwen3VlBuilderClient(requestTimeoutMs: number): Promise<Qwen3VlEmbeddingClient> {
  const connector = await import("../connectors/qwen3vl-embedding-local.js");
  return connector.createQwen3VlEmbeddingLocalClient({ requestTimeoutMs });
}

async function createClapAudioBuilderClient(requestTimeoutMs: number): Promise<ClapAudioEmbeddingClient> {
  const connector = await import("../connectors/clap-audio-local.js");
  return connector.createClapAudioEmbeddingLocalClient({ requestTimeoutMs });
}

function clapAudioWorkerAvailable(projectDir: string): boolean {
  if (process.env.VOS_CLAP_MOCK === "1") return true;
  if (
    process.env.VOS_CLAP_PYTHON
    || process.env.VOS_CLAP_WORKER
    || process.env.VOS_CLAP_MODEL
    || process.env.VOS_CLAP_CACHE_DIR
  ) {
    return true;
  }
  return [
    path.resolve(process.cwd(), "python/.venv-clap/bin/python3"),
    path.resolve(projectDir, "python/.venv-clap/bin/python3"),
    path.resolve(process.cwd(), ".venv-clap/bin/python3"),
    path.resolve(process.cwd(), ".venv/bin/python3"),
  ].some((candidate) => fs.existsSync(candidate));
}

function normalizeQwen3VlEmbedTypes(values: Qwen3VlBuildEmbeddingType[] | undefined): Qwen3VlBuildEmbeddingType[] {
  if (!values) return [...QWEN3VL_DEFAULT_EMBED_TYPES];
  const allowed = new Set<Qwen3VlBuildEmbeddingType>(QWEN3VL_DEFAULT_EMBED_TYPES);
  return Array.from(new Set(values.filter((value): value is Qwen3VlBuildEmbeddingType => allowed.has(value))));
}

async function buildRepresentativeFrameCache(
  projectDir: string,
  segments: SegmentBuildRecord[],
  createdAt: string,
  warnings: string[],
  onProgress?: (progress: Qwen3VlBuildProgress) => void,
): Promise<RepresentativeFrameRecord[]> {
  const frames: RepresentativeFrameRecord[] = [];
  let completed = 0;
  onProgress?.({ phase: "frames", completed, total: segments.length });
  for (const record of segments) {
    const frame = await buildRepresentativeFrame(projectDir, record, createdAt, warnings);
    if (frame) frames.push(frame);
    completed += 1;
    onProgress?.({ phase: "frames", completed, total: segments.length });
  }
  return frames;
}

async function buildRepresentativeFrame(
  projectDir: string,
  record: SegmentBuildRecord,
  createdAt: string,
  warnings: string[],
): Promise<RepresentativeFrameRecord | null> {
  const outputDir = path.join(projectDir, FRAME_CACHE_REL_ROOT, record.segmentId);
  const outputPath = path.join(outputDir, REPRESENTATIVE_FRAME_FILENAME);
  const manifestPath = path.join(outputDir, "manifest.json");
  const outputRelPath = toProjectRelativePath(projectDir, outputPath);
  const timestampUs = representativeTimestampUs(record);

  const source = representativeFrameSource(projectDir, record, timestampUs);
  if (!source) {
    warnings.push(`qwen3vl frame skipped for ${record.segmentId}: source media not accessible`);
    return null;
  }
  const sourceHash = stringValue(record.asset.source_fingerprint) || null;
  const sourceRelPath = toProjectRelativePath(projectDir, source.path);

  const existingHash = existingFrameCacheHash(outputPath, manifestPath, {
    source,
    sourceRelPath,
    sourceHash,
    timestampUs,
    outputRelPath,
  });
  if (existingHash) {
    return {
      segmentId: record.segmentId,
      framePath: outputPath,
      outputRelPath,
      contentHash: existingHash,
      timestampUs,
    };
  }

  fs.mkdirSync(outputDir, { recursive: true });
  fs.rmSync(outputPath, { force: true });
  const args = source.kind === "video"
    ? [
        "-ss",
        formatTimestampSeconds(timestampUs),
        "-i",
        source.path,
        "-vframes",
        "1",
        "-q:v",
        "2",
        "-vf",
        "scale=384:-2",
        outputPath,
      ]
    : [
        "-i",
        source.path,
        "-vframes",
        "1",
        "-q:v",
        "2",
        "-vf",
        "scale=384:-2",
        outputPath,
      ];

  try {
    await execFilePromise("ffmpeg", args);
  } catch (error) {
    warnings.push(`qwen3vl frame extraction failed for ${record.segmentId}: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }

  if (!fs.existsSync(outputPath) || !fs.statSync(outputPath).isFile()) {
    warnings.push(`qwen3vl frame extraction failed for ${record.segmentId}: ffmpeg did not create ${outputRelPath}`);
    return null;
  }

  const contentHash = sha256File(outputPath);
  fs.writeFileSync(manifestPath, `${JSON.stringify({
    segment_id: record.segmentId,
    frame_type: "visual_representative",
    source_video_path: source.kind === "video" ? sourceRelPath : null,
    source_frame_path: source.kind === "image" ? sourceRelPath : null,
    source_timestamp_us: timestampUs,
    output_path: outputRelPath,
    source_hash: sourceHash,
    frame_content_hash: contentHash,
    preprocess_version: QWEN3VL_PREPROCESS_VERSION,
    created_at: createdAt,
  }, null, 2)}\n`, "utf-8");

  return {
    segmentId: record.segmentId,
    framePath: outputPath,
    outputRelPath,
    contentHash,
    timestampUs,
  };
}

function representativeFrameSource(
  projectDir: string,
  record: SegmentBuildRecord,
  timestampUs: number,
): { kind: "image" | "video"; path: string } | null {
  const appraisal = recordValue(record.segment.visual_appraisal);
  const appraisalFrame = resolveAnalysisFilePath(projectDir, appraisal.frame_path);
  if (appraisalFrame) return { kind: "image", path: appraisalFrame };
  const sourceMedia = resolveSourceMediaPath(projectDir, record.asset);
  if (!sourceMedia || timestampUs < 0) return null;
  return { kind: "video", path: sourceMedia };
}

function representativeTimestampUs(record: SegmentBuildRecord): number {
  const appraisal = recordValue(record.segment.visual_appraisal);
  return nonNegativeInteger(appraisal.frame_us)
    ?? nonNegativeInteger(record.segment.rep_frame_us)
    ?? Math.trunc((record.srcInUs + record.srcOutUs) / 2);
}

function resolveAnalysisFilePath(projectDir: string, value: unknown): string | null {
  const filePath = nullableString(value);
  if (!filePath) return null;
  const candidates = path.isAbsolute(filePath)
    ? [filePath]
    : [
        path.resolve(projectDir, "03_analysis", filePath),
        path.resolve(projectDir, filePath),
      ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  return null;
}

function existingFrameCacheHash(
  outputPath: string,
  manifestPath: string,
  expected: {
    source: { kind: "image" | "video"; path: string };
    sourceRelPath: string;
    sourceHash: string | null;
    timestampUs: number;
    outputRelPath: string;
  },
): string | null {
  if (!fs.existsSync(outputPath) || !fs.statSync(outputPath).isFile()) return null;
  if (!fs.existsSync(manifestPath) || !fs.statSync(manifestPath).isFile()) return null;
  try {
    const currentHash = sha256File(outputPath);
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8")) as JsonRecord;
    const sourcePathMatches = expected.source.kind === "video"
      ? manifest.source_video_path === expected.sourceRelPath && manifest.source_frame_path == null
      : manifest.source_frame_path === expected.sourceRelPath && manifest.source_video_path == null;
    if (
      manifest.frame_content_hash === currentHash
      && manifest.preprocess_version === QWEN3VL_PREPROCESS_VERSION
      && manifest.source_timestamp_us === expected.timestampUs
      && manifest.output_path === expected.outputRelPath
      && manifest.source_hash === expected.sourceHash
      && sourcePathMatches
    ) {
      return currentHash;
    }
  } catch {
    return null;
  }
  return null;
}

async function buildAudioWindowCache(
  projectDir: string,
  segments: SegmentBuildRecord[],
  createdAt: string,
  warnings: string[],
  onProgress?: (progress: ClapAudioBuildProgress) => void,
): Promise<AudioWindowRecord[]> {
  const windows: AudioWindowRecord[] = [];
  let completed = 0;
  onProgress?.({ phase: "windows", completed, total: segments.length });
  for (const record of segments) {
    const window = await buildAudioWindow(projectDir, record, createdAt, warnings);
    if (window) windows.push(window);
    completed += 1;
    onProgress?.({ phase: "windows", completed, total: segments.length });
  }
  return windows;
}

async function buildAudioWindow(
  projectDir: string,
  record: SegmentBuildRecord,
  createdAt: string,
  warnings: string[],
): Promise<AudioWindowRecord | null> {
  const sourcePath = resolveSourceMediaPath(projectDir, record.asset);
  if (!sourcePath) {
    warnings.push(`clap audio window skipped for ${record.segmentId}: source media not accessible`);
    return null;
  }
  if (assetAudioStreamState(record.asset) === "no") {
    warnings.push(`clap audio window skipped for ${record.segmentId}: source has no audio stream`);
    return null;
  }

  const durationUs = record.srcOutUs - record.srcInUs;
  if (durationUs <= 0) {
    warnings.push(`clap audio window skipped for ${record.segmentId}: segment duration is not positive`);
    return null;
  }

  const outputDir = path.join(projectDir, AUDIO_WINDOW_CACHE_REL_ROOT, record.segmentId);
  const outputPath = path.join(outputDir, AUDIO_WINDOW_FILENAME);
  const manifestPath = path.join(outputDir, "manifest.json");
  const outputRelPath = toProjectRelativePath(projectDir, outputPath);
  const sourceRelPath = toProjectRelativePath(projectDir, sourcePath);
  const sourceHash = stringValue(record.asset.source_fingerprint) || null;

  const existingHash = existingAudioWindowHash(outputPath, manifestPath, {
    sourceRelPath,
    sourceHash,
    startUs: record.srcInUs,
    endUs: record.srcOutUs,
    outputRelPath,
  });
  if (existingHash) {
    return {
      segmentId: record.segmentId,
      windowPath: outputPath,
      outputRelPath,
      contentHash: existingHash,
      startUs: record.srcInUs,
      endUs: record.srcOutUs,
    };
  }

  fs.mkdirSync(outputDir, { recursive: true });
  fs.rmSync(outputPath, { force: true });
  const args = [
    "-ss",
    formatTimestampSeconds(record.srcInUs),
    "-t",
    formatTimestampSeconds(durationUs),
    "-i",
    sourcePath,
    "-ac",
    "1",
    "-ar",
    "48000",
    "-f",
    "wav",
    "-acodec",
    "pcm_s16le",
    "-map",
    "0:a:0",
    outputPath,
  ];

  try {
    await execFilePromise("ffmpeg", args);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/0:a:0|matches no streams|audio stream/i.test(message)) {
      warnings.push(`clap audio window skipped for ${record.segmentId}: source has no audio stream`);
    } else {
      warnings.push(`clap audio window extraction failed for ${record.segmentId}: ${message}`);
    }
    return null;
  }

  if (!fs.existsSync(outputPath) || !fs.statSync(outputPath).isFile()) {
    warnings.push(`clap audio window extraction failed for ${record.segmentId}: ffmpeg did not create ${outputRelPath}`);
    return null;
  }

  const contentHash = sha256File(outputPath);
  fs.writeFileSync(manifestPath, `${JSON.stringify({
    segment_id: record.segmentId,
    window_type: "full",
    source_ref: sourceRelPath,
    start_us: record.srcInUs,
    end_us: record.srcOutUs,
    duration_us: durationUs,
    sample_rate: 48000,
    channels: 1,
    output_path: outputRelPath,
    source_hash: sourceHash,
    content_hash: contentHash,
    preprocess_version: CLAP_AUDIO_PREPROCESS_VERSION,
    created_at: createdAt,
  }, null, 2)}\n`, "utf-8");

  return {
    segmentId: record.segmentId,
    windowPath: outputPath,
    outputRelPath,
    contentHash,
    startUs: record.srcInUs,
    endUs: record.srcOutUs,
  };
}

function existingAudioWindowHash(
  outputPath: string,
  manifestPath: string,
  expected: {
    sourceRelPath: string;
    sourceHash: string | null;
    startUs: number;
    endUs: number;
    outputRelPath: string;
  },
): string | null {
  if (!fs.existsSync(outputPath) || !fs.statSync(outputPath).isFile()) return null;
  if (!fs.existsSync(manifestPath) || !fs.statSync(manifestPath).isFile()) return null;
  try {
    const currentHash = sha256File(outputPath);
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8")) as JsonRecord;
    if (
      manifest.window_type === "full"
      && manifest.source_ref === expected.sourceRelPath
      && manifest.start_us === expected.startUs
      && manifest.end_us === expected.endUs
      && manifest.output_path === expected.outputRelPath
      && manifest.source_hash === expected.sourceHash
      && manifest.content_hash === currentHash
      && manifest.preprocess_version === CLAP_AUDIO_PREPROCESS_VERSION
    ) {
      return currentHash;
    }
  } catch {
    return null;
  }
  return null;
}

function assetAudioStreamState(asset: JsonRecord): "yes" | "no" | "unknown" {
  const streams = Array.isArray(asset.audio_streams) ? asset.audio_streams : [];
  if (Array.isArray(asset.audio_streams)) return streams.length > 0 ? "yes" : "no";
  const audio = recordValue(asset.audio_stream ?? asset.audio ?? asset.audio_track);
  if (Object.keys(audio).length > 0) return "yes";
  const channels = nonNegativeIntegerLike(asset.audio_channels);
  if (channels != null) return channels > 0 ? "yes" : "no";
  return "unknown";
}

function execFilePromise(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { windowsHide: true }, (error, _stdout, stderr) => {
      if (error) {
        const suffix = typeof stderr === "string" && stderr.trim() ? `: ${stderr.trim()}` : "";
        reject(new Error(`${error.message}${suffix}`));
        return;
      }
      resolve();
    });
  });
}

function openReusableFootageDb(outputPath: string): Database.Database | null {
  if (!fs.existsSync(outputPath) || !fs.statSync(outputPath).isFile()) return null;
  try {
    const db = new Database(outputPath, { readonly: true, fileMustExist: true });
    const tableCount = db.prepare(`
      SELECT COUNT(*)
      FROM sqlite_master
      WHERE type = 'table' AND name IN ('embedding_models', 'segment_embeddings')
    `).pluck().get() as number;
    if (tableCount !== 2) {
      db.close();
      return null;
    }
    return db;
  } catch {
    return null;
  }
}

function copyReusableQwenRows(
  db: Database.Database,
  previousDb: Database.Database | null,
  modelId: number,
  embeddingType: "visual_representative" | "text_combined_qwen",
  rows: Array<{ segmentId: string; sourceRef: string; sourceTimestampUs: number | null; contentHash: string }>,
  createdAt: string,
): void {
  if (!previousDb || rows.length === 0) return;
  const previousModelId = previousQwenModelId(previousDb);
  if (previousModelId == null) return;

  const selectPrevious = previousDb.prepare(`
    SELECT dimension, vector
    FROM segment_embeddings
    WHERE segment_id = @segment_id
      AND embedding_type = @embedding_type
      AND model_id = @model_id
      AND content_hash = @content_hash
    LIMIT 1
  `);
  const insertCurrent = db.prepare(`
    INSERT OR IGNORE INTO segment_embeddings (
      segment_id, embedding_type, model_id, source_ref, source_timestamp_us,
      content_hash, dimension, vector, created_at
    ) VALUES (
      @segment_id, @embedding_type, @model_id, @source_ref, @source_timestamp_us,
      @content_hash, @dimension, @vector, @created_at
    )
  `);
  const tx = db.transaction(() => {
    for (const row of rows) {
      if (segmentEmbeddingExists(db, row.segmentId, embeddingType, modelId, row.contentHash)) continue;
      const previous = selectPrevious.get({
        segment_id: row.segmentId,
        embedding_type: embeddingType,
        model_id: previousModelId,
        content_hash: row.contentHash,
      }) as { dimension: number; vector: Buffer } | undefined;
      if (!previous || previous.dimension !== QWEN3VL_OUTPUT_DIMENSION) continue;
      insertCurrent.run({
        segment_id: row.segmentId,
        embedding_type: embeddingType,
        model_id: modelId,
        source_ref: row.sourceRef,
        source_timestamp_us: row.sourceTimestampUs,
        content_hash: row.contentHash,
        dimension: previous.dimension,
        vector: Buffer.from(previous.vector),
        created_at: createdAt,
      });
    }
  });
  tx();
}

function copyReusableClapRows(
  db: Database.Database,
  previousDb: Database.Database | null,
  modelId: number,
  embeddingType: "audio_representative" | "audio_text_clap",
  rows: Array<{ segmentId: string; sourceRef: string; sourceTimestampUs: number | null; contentHash: string }>,
  createdAt: string,
): void {
  if (!previousDb || rows.length === 0) return;
  const previousModelId = previousClapModelId(previousDb);
  if (previousModelId == null) return;

  const selectPrevious = previousDb.prepare(`
    SELECT dimension, vector
    FROM segment_embeddings
    WHERE segment_id = @segment_id
      AND embedding_type = @embedding_type
      AND model_id = @model_id
      AND content_hash = @content_hash
    LIMIT 1
  `);
  const insertCurrent = db.prepare(`
    INSERT OR IGNORE INTO segment_embeddings (
      segment_id, embedding_type, model_id, source_ref, source_timestamp_us,
      content_hash, dimension, vector, created_at
    ) VALUES (
      @segment_id, @embedding_type, @model_id, @source_ref, @source_timestamp_us,
      @content_hash, @dimension, @vector, @created_at
    )
  `);
  const tx = db.transaction(() => {
    for (const row of rows) {
      if (segmentEmbeddingExists(db, row.segmentId, embeddingType, modelId, row.contentHash)) continue;
      const previous = selectPrevious.get({
        segment_id: row.segmentId,
        embedding_type: embeddingType,
        model_id: previousModelId,
        content_hash: row.contentHash,
      }) as { dimension: number; vector: Buffer } | undefined;
      if (!previous || previous.dimension !== CLAP_AUDIO_OUTPUT_DIMENSION) continue;
      insertCurrent.run({
        segment_id: row.segmentId,
        embedding_type: embeddingType,
        model_id: modelId,
        source_ref: row.sourceRef,
        source_timestamp_us: row.sourceTimestampUs,
        content_hash: row.contentHash,
        dimension: previous.dimension,
        vector: Buffer.from(previous.vector),
        created_at: createdAt,
      });
    }
  });
  tx();
}

function previousQwenModelId(db: Database.Database): number | null {
  const model = qwen3VlEmbeddingModel("");
  const row = db.prepare(`
    SELECT id
    FROM embedding_models
    WHERE name = @name
      AND model_revision = @model_revision
      AND output_dimension = @output_dimension
      AND input_modality = @input_modality
      AND instruction = @instruction
      AND preprocess_version = @preprocess_version
      AND runner_name = @runner_name
      AND runner_version = @runner_version
      AND precision = @precision
      AND normalized = @normalized
      AND distance_metric = @distance_metric
    LIMIT 1
  `).get({
    ...model,
    normalized: model.normalized ? 1 : 0,
  }) as { id: number } | undefined;
  return row?.id ?? null;
}

function previousClapModelId(db: Database.Database): number | null {
  const model = clapAudioEmbeddingModel("");
  const row = db.prepare(`
    SELECT id
    FROM embedding_models
    WHERE name = @name
      AND model_revision = @model_revision
      AND output_dimension = @output_dimension
      AND input_modality = @input_modality
      AND instruction = @instruction
      AND preprocess_version = @preprocess_version
      AND runner_name = @runner_name
      AND runner_version = @runner_version
      AND precision = @precision
      AND normalized = @normalized
      AND distance_metric = @distance_metric
    LIMIT 1
  `).get({
    ...model,
    normalized: model.normalized ? 1 : 0,
  }) as { id: number } | undefined;
  return row?.id ?? null;
}

function segmentEmbeddingExists(
  db: Database.Database,
  segmentId: string,
  embeddingType: string,
  modelId: number,
  contentHash: string,
): boolean {
  return Boolean(db.prepare(`
    SELECT 1
    FROM segment_embeddings
    WHERE segment_id = @segment_id
      AND embedding_type = @embedding_type
      AND model_id = @model_id
      AND content_hash = @content_hash
    LIMIT 1
  `).pluck().get({
    segment_id: segmentId,
    embedding_type: embeddingType,
    model_id: modelId,
    content_hash: contentHash,
  }));
}

async function embedAndInsertQwenRows(
  db: Database.Database,
  client: Qwen3VlEmbeddingClient,
  options: {
    modelId: number;
    embeddingType: "visual_representative" | "text_combined_qwen";
    createdAt: string;
    requestTimeoutMs: number;
    warnings: string[];
    items: Qwen3VlBatchItem[];
    rowByRef: Map<string, { segmentId: string; sourceRef: string; sourceTimestampUs: number | null; contentHash: string }>;
  },
): Promise<void> {
  if (options.items.length === 0) return;
  const response = await client.embedBatch(options.items, {
    instruction: QWEN3VL_INSTRUCTION,
    outputDimension: QWEN3VL_OUTPUT_DIMENSION,
    normalize: true,
    preprocessVersion: QWEN3VL_PREPROCESS_VERSION,
    timeoutMs: options.requestTimeoutMs * Math.max(1, options.items.length),
  });

  const insert = db.prepare(`
    INSERT OR IGNORE INTO segment_embeddings (
      segment_id, embedding_type, model_id, source_ref, source_timestamp_us,
      content_hash, dimension, vector, created_at
    ) VALUES (
      @segment_id, @embedding_type, @model_id, @source_ref, @source_timestamp_us,
      @content_hash, @dimension, @vector, @created_at
    )
  `);
  const tx = db.transaction(() => {
    for (const vector of response.vectors) {
      const row = options.rowByRef.get(vector.ref);
      if (!row) {
        options.warnings.push(`qwen3vl embedding skipped for ${vector.ref}: no matching input row`);
        continue;
      }
      if (!validQwenVector(vector)) {
        options.warnings.push(`qwen3vl embedding skipped for ${vector.ref}: expected ${QWEN3VL_OUTPUT_DIMENSION} dimensions, got ${vector.dimension}`);
        continue;
      }
      insert.run({
        segment_id: row.segmentId,
        embedding_type: options.embeddingType,
        model_id: options.modelId,
        source_ref: row.sourceRef,
        source_timestamp_us: row.sourceTimestampUs,
        content_hash: row.contentHash,
        dimension: QWEN3VL_OUTPUT_DIMENSION,
        vector: float32ArrayToLittleEndianBlob(vector.vector),
        created_at: options.createdAt,
      });
    }
  });
  tx();
}

async function embedAndInsertClapAudioRows(
  db: Database.Database,
  client: ClapAudioEmbeddingClient,
  options: {
    modelId: number;
    createdAt: string;
    requestTimeoutMs: number;
    warnings: string[];
    windows: AudioWindowRecord[];
  },
): Promise<void> {
  if (options.windows.length === 0) return;
  const response = await client.embedAudio(options.windows.map((window) => window.windowPath), {
    outputDimension: CLAP_AUDIO_OUTPUT_DIMENSION,
    normalize: true,
    preprocessVersion: CLAP_AUDIO_PREPROCESS_VERSION,
    timeoutMs: options.requestTimeoutMs * Math.max(1, options.windows.length),
  });

  const rowByRef = new Map(options.windows.map((window, index) => [String(index), window]));
  insertClapVectors(db, {
    modelId: options.modelId,
    embeddingType: "audio_representative",
    createdAt: options.createdAt,
    warnings: options.warnings,
    vectors: response.vectors,
    rowForVector: (vector) => {
      const row = rowByRef.get(vector.ref);
      return row ? {
        segmentId: row.segmentId,
        sourceRef: row.outputRelPath,
        sourceTimestampUs: row.startUs,
        contentHash: row.contentHash,
      } : null;
    },
  });
}

async function embedAndInsertClapTextRows(
  db: Database.Database,
  client: ClapAudioEmbeddingClient,
  options: {
    modelId: number;
    createdAt: string;
    requestTimeoutMs: number;
    warnings: string[];
    rows: ClapTextEmbeddingInput[];
  },
): Promise<void> {
  if (options.rows.length === 0) return;
  const response = await client.embedText(options.rows.map((row) => row.text), {
    outputDimension: CLAP_AUDIO_OUTPUT_DIMENSION,
    normalize: true,
    preprocessVersion: CLAP_AUDIO_PREPROCESS_VERSION,
    timeoutMs: options.requestTimeoutMs * Math.max(1, options.rows.length),
  });

  const rowByRef = new Map(options.rows.map((row, index) => [String(index), row]));
  insertClapVectors(db, {
    modelId: options.modelId,
    embeddingType: "audio_text_clap",
    createdAt: options.createdAt,
    warnings: options.warnings,
    vectors: response.vectors,
    rowForVector: (vector) => {
      const row = rowByRef.get(vector.ref);
      return row ? {
        segmentId: row.segmentId,
        sourceRef: "embedding_texts:combined",
        sourceTimestampUs: null,
        contentHash: row.contentHash,
      } : null;
    },
  });
}

function insertClapVectors(
  db: Database.Database,
  options: {
    modelId: number;
    embeddingType: "audio_representative" | "audio_text_clap";
    createdAt: string;
    warnings: string[];
    vectors: ClapAudioVectorResult[];
    rowForVector: (vector: ClapAudioVectorResult) => { segmentId: string; sourceRef: string; sourceTimestampUs: number | null; contentHash: string } | null;
  },
): void {
  const insert = db.prepare(`
    INSERT OR IGNORE INTO segment_embeddings (
      segment_id, embedding_type, model_id, source_ref, source_timestamp_us,
      content_hash, dimension, vector, created_at
    ) VALUES (
      @segment_id, @embedding_type, @model_id, @source_ref, @source_timestamp_us,
      @content_hash, @dimension, @vector, @created_at
    )
  `);
  const tx = db.transaction(() => {
    for (const vector of options.vectors) {
      const row = options.rowForVector(vector);
      if (!row) {
        options.warnings.push(`clap audio embedding skipped for ${vector.ref}: no matching input row`);
        continue;
      }
      if (!validClapVector(vector)) {
        options.warnings.push(`clap audio embedding skipped for ${vector.ref}: expected ${CLAP_AUDIO_OUTPUT_DIMENSION} dimensions, got ${vector.dimension}`);
        continue;
      }
      insert.run({
        segment_id: row.segmentId,
        embedding_type: options.embeddingType,
        model_id: options.modelId,
        source_ref: row.sourceRef,
        source_timestamp_us: row.sourceTimestampUs,
        content_hash: row.contentHash,
        dimension: CLAP_AUDIO_OUTPUT_DIMENSION,
        vector: float32ArrayToLittleEndianBlob(vector.vector),
        created_at: options.createdAt,
      });
    }
  });
  tx();
}

function validQwenVector(result: Qwen3VlVectorResult): boolean {
  return result.dimension === QWEN3VL_OUTPUT_DIMENSION && result.vector.length === QWEN3VL_OUTPUT_DIMENSION;
}

function validClapVector(result: ClapAudioVectorResult): boolean {
  if (result.dimension !== CLAP_AUDIO_OUTPUT_DIMENSION || result.vector.length !== CLAP_AUDIO_OUTPUT_DIMENSION) {
    return false;
  }
  for (let index = 0; index < result.vector.length; index += 1) {
    if (!Number.isFinite(result.vector[index])) return false;
  }
  return true;
}

function countSegmentEmbeddings(
  db: Database.Database,
  modelId: number,
  embeddingType: string,
): number {
  return db.prepare(`
    SELECT COUNT(*)
    FROM segment_embeddings
    WHERE model_id = @model_id AND embedding_type = @embedding_type
  `).pluck().get({
    model_id: modelId,
    embedding_type: embeddingType,
  }) as number;
}

function countClapSegmentEmbeddings(db: Database.Database, modelId: number): number {
  return db.prepare(`
    SELECT COUNT(*)
    FROM segment_embeddings
    WHERE model_id = @model_id
      AND embedding_type IN ('audio_representative', 'audio_text_clap')
  `).pluck().get({
    model_id: modelId,
  }) as number;
}

function qwenTextEmbeddingInputs(
  embeddingTexts: Array<{ segment_id: string; field: EmbeddingField; text: string; content_hash: string }>,
): QwenTextEmbeddingInput[] {
  return embeddingTexts
    .filter((row) => row.field === "combined")
    .map((row) => ({
      segmentId: row.segment_id,
      text: prepareQwenTextInput(row.text),
    }))
    .filter((row) => row.text.length > 0)
    .map((row) => ({
      ...row,
      contentHash: hashValue({
        embedding_type: "text_combined_qwen",
        preprocess_version: QWEN3VL_PREPROCESS_VERSION,
        text: row.text,
      }),
    }));
}

function clapTextEmbeddingInputs(
  embeddingTexts: Array<{ segment_id: string; field: EmbeddingField; text: string; content_hash: string }>,
): ClapTextEmbeddingInput[] {
  return embeddingTexts
    .filter((row) => row.field === "combined")
    .map((row) => ({
      segmentId: row.segment_id,
      text: normalizeSearchText(row.text),
    }))
    .filter((row) => row.text.length > 0)
    .map((row) => ({
      ...row,
      contentHash: hashValue({
        embedding_type: "audio_text_clap",
        preprocess_version: CLAP_AUDIO_PREPROCESS_VERSION,
        text: row.text,
      }),
    }));
}

function qwenFailureStatus(error: unknown): EmbeddingStatus {
  const code = typeof error === "object" && error && "code" in error ? String((error as { code?: unknown }).code) : "";
  return code === "invalid_input" ? "error" : "unavailable";
}

function clapAudioFailureStatus(error: unknown): EmbeddingStatus {
  const code = typeof error === "object" && error && "code" in error ? String((error as { code?: unknown }).code) : "";
  return code === "invalid_input" ? "error" : "unavailable";
}

function prepareQwenTextInput(text: string): string {
  const sanitized = text
    .replace(QWEN3VL_TEXT_CONTROL_CHARS, " ")
    .replace(/\s+/g, " ")
    .trim();
  return sanitized.length > QWEN3VL_TEXT_MAX_CHARS
    ? sanitized.slice(0, QWEN3VL_TEXT_MAX_CHARS).trimEnd()
    : sanitized;
}

function sha256File(filePath: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function float32ArrayToLittleEndianBlob(vector: Float32Array): Buffer {
  const buffer = Buffer.alloc(vector.length * 4);
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  for (let index = 0; index < vector.length; index += 1) {
    view.setFloat32(index * 4, vector[index], true);
  }
  return buffer;
}

function formatTimestampSeconds(timestampUs: number): string {
  const seconds = (timestampUs / 1_000_000).toFixed(6);
  return seconds.replace(/\.?0+$/u, "") || "0";
}

function toProjectRelativePath(projectDir: string, filePath: string): string {
  return path.relative(projectDir, filePath).split(path.sep).join("/");
}

function e5EmbeddingModel(createdAt: string): EmbeddingModelInput {
  return {
    name: SEMANTIC_EMBEDDING_MODEL,
    model_revision: E5_MODEL_REVISION,
    output_dimension: E5_OUTPUT_DIMENSION,
    input_modality: "text",
    instruction: E5_INSTRUCTION,
    preprocess_version: E5_PREPROCESS_VERSION,
    runner_name: E5_RUNNER_NAME,
    runner_version: E5_RUNNER_VERSION,
    precision: SEMANTIC_EMBEDDING_DTYPE,
    normalized: true,
    distance_metric: "cosine",
    license: E5_LICENSE,
    created_at: createdAt,
  };
}

function upsertEmbeddingModel(db: Database.Database, model: EmbeddingModelInput): number {
  const params = {
    ...model,
    normalized: model.normalized ? 1 : 0,
  };
  db.prepare(`
    INSERT OR IGNORE INTO embedding_models (
      name, model_revision, output_dimension, input_modality, instruction, preprocess_version,
      runner_name, runner_version, precision, normalized, distance_metric, license, created_at
    ) VALUES (
      @name, @model_revision, @output_dimension, @input_modality, @instruction, @preprocess_version,
      @runner_name, @runner_version, @precision, @normalized, @distance_metric, @license, @created_at
    )
  `).run(params);

  const row = db.prepare(`
    SELECT id
    FROM embedding_models
    WHERE name = @name
      AND model_revision = @model_revision
      AND output_dimension = @output_dimension
      AND input_modality = @input_modality
      AND instruction = @instruction
      AND preprocess_version = @preprocess_version
      AND runner_name = @runner_name
      AND runner_version = @runner_version
      AND precision = @precision
      AND normalized = @normalized
      AND distance_metric = @distance_metric
    LIMIT 1
  `).get(params) as { id: number } | undefined;

  if (!row) throw new Error(`embedding model registry upsert failed for ${model.name}`);
  return row.id;
}

function insertMeta(db: Database.Database, meta: Record<string, string>): void {
  const stmt = db.prepare("INSERT INTO footage_db_meta (key, value) VALUES (@key, @value)");
  const tx = db.transaction(() => {
    for (const [key, value] of Object.entries(meta)) stmt.run({ key, value });
  });
  tx();
}

function insertSources(db: Database.Database, sources: SourceRecord[], indexedAt: string): void {
  const stmt = db.prepare(`
    INSERT INTO footage_db_sources (source_name, rel_path, hash, required, indexed_at)
    VALUES (@source_name, @rel_path, @hash, @required, @indexed_at)
  `);
  const tx = db.transaction(() => {
    for (const source of sources) {
      stmt.run({
        source_name: source.source_name,
        rel_path: source.rel_path,
        hash: source.hash,
        required: source.required ? 1 : 0,
        indexed_at: indexedAt,
      });
    }
  });
  tx();
}

function insertWarnings(db: Database.Database, warnings: string[], createdAt: string): void {
  const stmt = db.prepare(`
    INSERT INTO footage_db_warnings (warning_id, severity, message, source_name, created_at)
    VALUES (@warning_id, @severity, @message, @source_name, @created_at)
  `);
  const unique = Array.from(new Set(warnings));
  const tx = db.transaction(() => {
    unique.forEach((message, index) => {
      stmt.run({
        warning_id: `FDB_WARN_${String(index + 1).padStart(4, "0")}`,
        severity: message.includes("skipped") || message.includes("invalid") ? "warning" : "info",
        message,
        source_name: null,
        created_at: createdAt,
      });
    });
  });
  tx();
}

function writeBuildReport(
  reportPath: string,
  projectDir: string,
  outputPath: string,
  result: BuildFootageDbResult,
  projectId: string,
  createdAt: string,
): void {
  const report = {
    artifact_version: REPORT_ARTIFACT_VERSION,
    project_id: projectId,
    db_path: path.relative(projectDir, outputPath),
    created_at: createdAt,
    schema_version: SCHEMA_VERSION,
    embedding_status: result.embedding_status,
    embedding_model_id: result.embedding_status === "ready" ? EMBEDDING_MODEL_ID : null,
    embedding_counts: result.embedding_counts,
    embedding_statuses: result.embedding_statuses,
    source_hashes: result.source_hashes,
    counts: result.counts,
    warnings: result.warnings,
  };
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf-8");
}

function segmentBuildRecord(
  segment: JsonRecord,
  asset: JsonRecord,
  segmentId: string,
  assetId: string,
  srcInUs: number,
  srcOutUs: number,
  transcript: TranscriptSlice,
  marlinByAsset: Map<string, ReturnType<typeof normalizeMarlinAsset>>,
): SegmentBuildRecord {
  const appraisal = recordValue(segment.visual_appraisal);
  const marlin = marlinByAsset.get(assetId);
  const overlappingEvents = (marlin?.events ?? [])
    .filter((event) => overlaps(nonNegativeInteger(event.start_us) ?? 0, nonNegativeInteger(event.end_us) ?? 0, srcInUs, srcOutUs))
    .map((event) => stringValue(event.description))
    .filter(Boolean);
  const editorialObservation = extractEditorialObservation(segment.editorial_observation);
  const tags = uniqueStrings([
    ...arrayStrings(segment.tags),
    ...observationStringArray(editorialObservation, "visual_tags"),
  ]);
  const assetTags = arrayStrings(asset.tags);
  return {
    segment,
    asset,
    segmentId,
    assetId,
    srcInUs,
    srcOutUs,
    summary: stringValue(segment.summary),
    transcriptExcerpt: stringValue(segment.transcript_excerpt),
    transcript,
    tags: uniqueStrings([...tags, ...assetTags]),
    qualityFlags: uniqueStrings([...arrayStrings(segment.quality_flags), ...arrayStrings(asset.quality_flags)]),
    qualityLabels: qualityLabels(segment),
    marlinSceneText: normalizeSearchText([marlin?.scene, marlin?.caption].map(stringValue).filter(Boolean).join(" ")),
    marlinEvents: overlappingEvents,
    extractedTextFlat: extractedTextFlat(appraisal.extracted_text),
    placeText: placeText(recordValue(appraisal.place_hint)),
    aestheticNotesFlat: arrayStrings(appraisal.aesthetic_notes).join(" "),
    editorialObservation,
  };
}

function ftsRow(
  record: SegmentBuildRecord,
  visualProfile: JsonRecord,
  logging: JsonRecord,
  audioProfile: JsonRecord,
  usability: UsabilityClassification,
): Record<string, string> {
  const metadataTerms = metadataTermsForSearch(visualProfile, logging, audioProfile, usability);
  return {
    segment_id: record.segmentId,
    asset_id: record.assetId,
    summary: searchFieldText([record.summary]),
    transcript: searchFieldText([record.transcript.text, record.transcriptExcerpt]),
    marlin_scene: searchFieldText([record.marlinSceneText]),
    marlin_events: searchFieldText(record.marlinEvents),
    tags: searchFieldText(record.tags),
    quality_labels: searchFieldText([...record.qualityLabels, ...record.qualityFlags, ...metadataTerms]),
    extracted_text: searchFieldText([record.extractedTextFlat]),
    place: searchFieldText([record.placeText]),
    aesthetic_notes: searchFieldText([record.aestheticNotesFlat]),
  };
}

function searchFieldText(parts: string[]): string {
  const normalizedParts = parts.map(normalizeSearchText).filter(Boolean);
  const expansions = normalizedParts.flatMap(cjkSearchExpansions);
  return normalizeSearchText([...normalizedParts, ...expansions].join(" "));
}

function embeddingTextBundles(
  record: SegmentBuildRecord,
  visualProfile: JsonRecord,
  logging: JsonRecord,
  audioProfile: JsonRecord,
  usability: UsabilityClassification,
): Record<EmbeddingField, string> {
  const metadataTerms = metadataTermsForSearch(visualProfile, logging, audioProfile, usability).join(" ");
  const summary = [
    record.summary,
    ...record.tags,
    ...record.qualityLabels,
    ...record.qualityFlags,
    ...record.editorialObservation.index_terms,
  ].join(" ");
  const transcript = [record.transcript.text, record.transcriptExcerpt].join(" ");
  const scene = [
    record.marlinSceneText,
    ...record.marlinEvents,
    record.placeText,
  ].join(" ");
  const combined = [
    summary,
    transcript,
    scene,
    record.extractedTextFlat,
    record.aestheticNotesFlat,
    metadataTerms,
  ].join(" ");
  return { summary, transcript, scene, combined };
}

function assetTechnicalRow(assetId: string, asset: JsonRecord): JsonRecord {
  const video = recordValue(asset.video_stream ?? asset.video ?? asset.video_track);
  const audio = recordValue(asset.audio_stream ?? asset.audio ?? asset.audio_track);
  const audioStreams = Array.isArray(asset.audio_streams) ? asset.audio_streams : audio && Object.keys(audio).length > 0 ? [audio] : [];
  const format = recordValue(asset.format);
  const tags = recordValue(asset.tags);
  const videoTags = recordValue(video.tags);
  const fps = fpsParts(video.r_frame_rate ?? video.avg_frame_rate ?? asset.r_frame_rate);
  const width = positiveInteger(video.width ?? asset.width);
  const height = positiveInteger(video.height ?? asset.height);
  const fpsNum = positiveInteger(video.fps_num ?? fps?.fps_num);
  const fpsDen = positiveInteger(video.fps_den ?? fps?.fps_den);
  const audioChannelCount = nonNegativeIntegerLike(audio.channels ?? asset.audio_channels);
  const audioSampleRate = nonNegativeIntegerLike(audio.sample_rate ?? audio.sample_rate_hz ?? asset.audio_sample_rate);
  const recordingFormat = nullableString(asset.recording_format ?? format.format_name ?? format.format_long_name ?? extensionFormat(stringValue(asset.filename)));
  return {
    asset_id: assetId,
    container_format: nullableString(format.format_name ?? asset.container_format),
    container_long_name: nullableString(format.format_long_name ?? asset.container_long_name),
    recording_format: recordingFormat,
    video_codec: nullableString(
      video.codec_name ??
      video.codec ??
      asset.codec_name ??
      asset.codec,
    ),
    video_profile: nullableString(video.profile ?? asset.video_profile),
    codec_tag: nullableString(video.codec_tag_string ?? video.codec_tag ?? asset.codec_tag),
    width,
    height,
    fps_num: fpsNum,
    fps_den: fpsDen,
    r_frame_rate: nullableString(video.r_frame_rate ?? asset.r_frame_rate),
    time_base: nullableString(video.time_base ?? asset.time_base),
    frame_rate_mode: frameRateMode(fpsNum, fpsDen, audioStreams.length > 0, width, height),
    pix_fmt: nullableString(video.pix_fmt ?? asset.pix_fmt),
    bit_depth: positiveInteger(video.bit_depth ?? video.bits_per_raw_sample ?? asset.bit_depth) ?? bitDepthFromPixelFormat(stringValue(video.pix_fmt ?? asset.pix_fmt)),
    color_primaries: nullableString(video.color_primaries ?? asset.color_primaries),
    color_transfer: nullableString(video.color_transfer ?? asset.color_transfer),
    color_space: nullableString(video.color_space ?? asset.color_space),
    color_range: nullableString(video.color_range ?? asset.color_range),
    rotation: normalizedRotation(video.rotation ?? videoTags.rotate ?? asset.rotation),
    stream_duration_json: JSON.stringify(streamDurations(video, audioStreams)),
    audio_streams_json: JSON.stringify(audioStreams.map(normalizeAudioStream)),
    timecode_start: nullableString(asset.timecode ?? video.timecode ?? videoTags.timecode ?? tags.timecode),
    timecode_format: nullableString(asset.timecode_format) ?? (asset.timecode || video.timecode || videoTags.timecode || tags.timecode ? "unknown" : "none"),
    reel_name: nullableString(asset.reel_name ?? tags.reel_name),
    card_id: nullableString(asset.card_id),
    camera_id: nullableString(asset.camera_id),
    extraction_source_json: JSON.stringify({ source: "assets_json" }),
    evidence_json: JSON.stringify([
      width && height ? `resolution:${width}x${height}` : null,
      fpsNum && fpsDen ? `fps:${fpsNum}/${fpsDen}` : null,
      audioChannelCount != null ? `audio_channels:${audioChannelCount}` : null,
      audioSampleRate != null ? `audio_sample_rate:${audioSampleRate}` : null,
    ].filter(Boolean)),
  };
}

function segmentVisualProfileRow(segmentId: string, record: SegmentBuildRecord): JsonRecord {
  const description = [
    record.marlinSceneText,
    ...record.marlinEvents,
    record.summary,
    ...record.qualityFlags,
    ...record.qualityLabels,
  ].join(" ");
  const motion = extractCameraMotion(description);
  const shotScale = extractShotScale(description);
  const observation = record.editorialObservation;
  const quality = recordValue(record.segment.visual_quality);
  const qualityLabelsRecord = recordValue(quality.labels);
  return {
    segment_id: segmentId,
    camera_motion_description: motion.camera_motion_description,
    camera_motion_type: motion.camera_motion_type,
    camera_motion_direction: canonicalMotionDirection(observation, "camera_motion_direction") ?? motion.camera_motion_direction,
    camera_stability: motion.camera_stability,
    motion_energy: scoreOrNull(recordValue(record.segment.peak_analysis).motion_energy),
    camera_motion_energy: scoreOrNull(recordValue(record.segment.peak_analysis).camera_motion_energy),
    shot_scale: canonicalShotScale(observation) ?? shotScale,
    composition_anchor: canonicalCompositionAnchor(observation) ?? compositionAnchor(description),
    subject_screen_side: canonicalScreenSide(observation) ?? dominantSubjectPosition(description),
    dominant_subject_type: canonicalDominantSubjectType(observation) ?? dominantSubjectType(description),
    subject_movement_direction: canonicalMotionDirection(observation, "subject_motion_direction") ?? subjectMovementDirection(description),
    exposure_label: exposureLabel(description, record.qualityFlags),
    color_temperature: colorTemperature(description, record.qualityLabels),
    contrast_label: contrastLabel(description, record.qualityLabels),
    saturation_label: saturationLabel(description, record.qualityLabels),
    dominant_colors_json: JSON.stringify(
      observationHasField(observation, "dominant_colors")
        ? observationStringArray(observation, "dominant_colors")
        : arrayStrings(qualityLabelsRecord.dominant_colors ?? quality.dominant_colors),
    ),
    sampled_frame_count: nonNegativeInteger(quality.sampled_frame_count) ?? 0,
    depth_of_field: depthOfField(description),
    motion_confidence: observationFieldConfidence(observation, "camera_motion_direction") ?? motion.motion_confidence,
    scale_confidence: observationFieldConfidence(observation, "shot_scale") ?? (shotScale === "unknown" ? null : 0.55),
    subject_confidence: observationFieldConfidence(
      observation,
      "dominant_subject_type",
      "screen_side",
      "composition_anchor",
      "subject_motion_direction",
    ) ?? (dominantSubjectPosition(description) === "unknown" ? null : 0.45),
    color_confidence: observationFieldConfidence(observation, "dominant_colors")
      ?? (hasColorCue(description, record.qualityLabels, record.qualityFlags) ? 0.45 : null),
    depth_confidence: depthOfField(description) === "unknown" ? null : 0.45,
    extraction_source_json: JSON.stringify(visualProfileExtractionSources(observation)),
    evidence_json: JSON.stringify([
      ...observation.evidence_terms,
      ...observation.evidence_refs.map((ref) => `editorial_observation.evidence_ref=${ref}`),
      ...motion.evidence,
      ...record.qualityFlags,
      ...record.qualityLabels,
    ]),
  };
}

function observationHasField(observation: EditorialObservationExtraction, field: EditorialObservationField): boolean {
  return Object.prototype.hasOwnProperty.call(observation.values, field);
}

function observationString(
  observation: EditorialObservationExtraction,
  field: EditorialObservationField,
): string | undefined {
  const value = observation.values[field];
  return typeof value === "string" ? value : undefined;
}

function observationStringArray(
  observation: EditorialObservationExtraction,
  field: "visual_tags" | "dominant_colors",
): string[] {
  const value = observation.values[field];
  return Array.isArray(value) ? value : [];
}

function observationFieldConfidence(
  observation: EditorialObservationExtraction,
  ...fields: EditorialObservationField[]
): number | null {
  for (const field of fields) {
    if (!observationHasField(observation, field)) continue;
    const confidence = observation.field_confidence[field];
    return confidence ?? null;
  }
  return null;
}

function canonicalMotionDirection(
  observation: EditorialObservationExtraction,
  field: "camera_motion_direction" | "subject_motion_direction",
): string | null {
  if (!observationHasField(observation, field)) return null;
  const value = observationString(observation, field);
  return ({
    left: "rtl",
    right: "ltr",
    up: "up",
    down: "down",
    toward_camera: "toward_camera",
    away_from_camera: "away_camera",
    mixed: "mixed",
    unknown: "unknown",
    not_applicable: "unknown",
  } as Record<string, string>)[value ?? ""] ?? "unknown";
}

function canonicalShotScale(observation: EditorialObservationExtraction): string | null {
  if (!observationHasField(observation, "shot_scale")) return null;
  const value = observationString(observation, "shot_scale");
  return ({
    extreme_wide: "extreme_wide",
    wide: "wide",
    medium_wide: "medium_wide",
    medium: "medium",
    medium_close_up: "medium_close",
    close_up: "close",
    extreme_close_up: "extreme_close",
    insert: "detail",
    unknown: "unknown",
    not_applicable: "unknown",
  } as Record<string, string>)[value ?? ""] ?? "unknown";
}

function canonicalCompositionAnchor(observation: EditorialObservationExtraction): string | null {
  if (!observationHasField(observation, "composition_anchor")) return null;
  const value = observationString(observation, "composition_anchor");
  return value === "left" || value === "center" || value === "right" ? value : "unknown";
}

function canonicalScreenSide(observation: EditorialObservationExtraction): string | null {
  if (!observationHasField(observation, "screen_side")) return null;
  const value = observationString(observation, "screen_side");
  if (value === "left" || value === "center" || value === "right") return value;
  if (value === "multiple") return "mixed";
  return "unknown";
}

function canonicalDominantSubjectType(observation: EditorialObservationExtraction): string | null {
  if (!observationHasField(observation, "dominant_subject_type")) return null;
  const value = observationString(observation, "dominant_subject_type");
  if (value === "person" || value === "group" || value === "object") return value;
  if (value === "landscape") return "environment";
  return "unknown";
}

function visualProfileExtractionSources(observation: EditorialObservationExtraction): JsonRecord {
  const fields = Object.fromEntries(Object.entries(observation.values).map(([field, value]) => [field, {
    source: "editorial_observation",
    exact_value: value,
    confidence: observation.field_confidence[field as EditorialObservationField] ?? null,
    evidence_refs: observation.field_evidence_refs[field as EditorialObservationField] ?? [],
  }]));
  return {
    motion: observationHasField(observation, "camera_motion_direction")
      ? "editorial_observation"
      : "marlin_phrase_parser",
    shot_scale: observationHasField(observation, "shot_scale")
      ? "editorial_observation"
      : "marlin_phrase_parser",
    ...(observation.present ? {
      editorial_observation: {
        values: observation.values,
        fields,
        evidence_refs: observation.evidence_refs,
      },
    } : {}),
  };
}

async function segmentAudioProfileRow(
  segmentId: string,
  record: SegmentBuildRecord,
  transcript: TranscriptSlice,
  segmentType: string | null,
  options: { projectDir: string; skipAudioAnalysis: boolean },
  warnings: string[],
): Promise<JsonRecord> {
  const hasDialogue = transcript.hasDialogue || segmentType === "dialogue";
  const hasMusic = segmentType === "music_driven";
  const sourcePath = resolveSourceMediaPath(options.projectDir, record.asset);
  const audio = sourcePath && !options.skipAudioAnalysis
    ? await extractAudioLevels(sourcePath, { startUs: record.srcInUs, endUs: record.srcOutUs })
    : null;
  if (options.skipAudioAnalysis) {
    warnings.push(`audio analysis skipped for ${segmentId}: --skip-audio-analysis`);
  } else if (!sourcePath) {
    warnings.push(`audio analysis unavailable for ${segmentId}: source media not accessible`);
  } else if (!audio) {
    warnings.push(`audio analysis unavailable for ${segmentId}: ffmpeg analysis failed`);
  }
  const silenceRole = audio?.has_silence && audio.silence_ratio != null && audio.silence_ratio > 0.8;
  return {
    segment_id: segmentId,
    audio_role: audioRole(hasDialogue, hasMusic, silenceRole),
    has_dialogue: hasDialogue ? 1 : 0,
    has_music: hasMusic ? 1 : 0,
    has_ambient: !hasDialogue && !hasMusic ? 1 : 0,
    peak_dbfs: audio?.peak_dbfs ?? null,
    rms_dbfs: audio?.rms_dbfs ?? null,
    integrated_lufs: audio?.integrated_lufs ?? null,
    silence_ratio: audio?.silence_ratio ?? null,
    silence_head_us: audio?.silence_head_us ?? null,
    silence_tail_us: audio?.silence_tail_us ?? null,
    speech_density: transcriptDensity(transcript, record.srcOutUs - record.srcInUs),
    music_density: hasMusic ? 1 : null,
    noise_flags_json: JSON.stringify(audio?.has_silence ? ["silence_detected"] : []),
    audio_handle_head_us: null,
    audio_handle_tail_us: null,
    confidence: audio ? 0.8 : hasDialogue || hasMusic ? 0.65 : null,
    extraction_source_json: JSON.stringify(audio ? { levels: "ffmpeg", role: "transcript_segment_type" } : { role: "transcript_segment_type" }),
    evidence_json: JSON.stringify([
      hasDialogue ? "transcript_dialogue" : null,
      hasMusic ? "segment_type:music_driven" : null,
      ...(audio?.evidence ?? []),
    ].filter(Boolean)),
  };
}

function segmentLoggingRow(
  segmentId: string,
  segment: JsonRecord,
  asset: JsonRecord,
  annotations: UserAnnotations,
  filenameParser: FilenameParserConfig,
): JsonRecord {
  const annotation = annotations.bySegmentId.get(segmentId) ?? annotations.byAssetId.get(stringValue(segment.asset_id)) ?? null;
  if (annotation) {
    return {
      segment_id: segmentId,
      scene_number: nullableString(annotation.scene ?? annotation.scene_number),
      shot_number: nullableString(annotation.shot ?? annotation.shot_number),
      take_number: nullableString(annotation.take ?? annotation.take_number),
      camera_id: nullableString(annotation.camera_id),
      card_id: nullableString(annotation.card_id),
      circle_take: optionalBooleanInt(annotation.circle_take),
      best_take: optionalBooleanInt(annotation.best_take),
      custom_tags_json: JSON.stringify(uniqueStrings([...arrayStrings(annotation.custom_tags), ...arrayStrings(annotation.tags)])),
      operator_notes: stringValue(annotation.operator_notes ?? annotation.notes),
      source: "user_annotation",
      confidence: scoreOrNull(annotation.confidence) ?? 1,
      evidence_json: JSON.stringify(["03_analysis/footage_user_annotations.json"]),
    };
  }
  const parsed = filenameParser.enabled
    ? extractSceneShotTake(stringValue(asset.filename) || stringValue(asset.source_locator))
    : null;
  return {
    segment_id: segmentId,
    scene_number: parsed?.scene_number ?? null,
    shot_number: parsed?.shot_number ?? null,
    take_number: parsed?.take_number ?? null,
    camera_id: parsed?.camera_id ?? null,
    card_id: parsed?.card_id ?? null,
    circle_take: null,
    best_take: null,
    custom_tags_json: "[]",
    operator_notes: "",
    source: parsed?.source === "filename_parser" ? "filename_parser" : "unknown",
    confidence: parsed?.confidence ?? null,
    evidence_json: JSON.stringify(parsed?.evidence ?? []),
  };
}

function metadataFtsRow(
  record: SegmentBuildRecord,
  visualProfile: JsonRecord,
  audioProfile: JsonRecord,
  logging: JsonRecord,
  usability: UsabilityClassification,
): JsonRecord {
  const technical = assetTechnicalTerms(record.asset);
  return {
    segment_id: stringValue(visualProfile.segment_id),
    cinematography: searchFieldText([
      ...record.editorialObservation.index_terms,
      stringValue(visualProfile.camera_motion_description),
      stringValue(visualProfile.camera_motion_type),
      stringValue(visualProfile.camera_motion_direction),
      stringValue(visualProfile.camera_stability),
      stringValue(visualProfile.shot_scale),
      stringValue(visualProfile.subject_screen_side),
      stringValue(visualProfile.dominant_subject_type),
      stringValue(visualProfile.exposure_label),
      stringValue(visualProfile.color_temperature),
      stringValue(visualProfile.contrast_label),
      stringValue(visualProfile.saturation_label),
    ]),
    technical: searchFieldText(technical),
    audio: searchFieldText([
      stringValue(audioProfile.audio_role),
      stringValue(audioProfile.peak_dbfs),
      stringValue(audioProfile.integrated_lufs),
      ...jsonStringArray(audioProfile.noise_flags_json),
    ]),
    logging: searchFieldText([
      stringValue(logging.scene_number),
      stringValue(logging.shot_number),
      stringValue(logging.take_number),
      stringValue(logging.camera_id),
      stringValue(logging.card_id),
      ...jsonStringArray(logging.custom_tags_json),
      stringValue(logging.operator_notes),
      usability.usability,
      ...usability.evidence,
    ]),
  };
}

function metadataTermsForSearch(
  visualProfile: JsonRecord,
  logging: JsonRecord,
  audioProfile: JsonRecord,
  usability: UsabilityClassification,
): string[] {
  return uniqueStrings([
    stringValue(visualProfile.camera_motion_type),
    stringValue(visualProfile.camera_motion_direction),
    stringValue(visualProfile.camera_stability),
    stringValue(visualProfile.shot_scale),
    stringValue(visualProfile.subject_screen_side),
    stringValue(visualProfile.dominant_subject_type),
    stringValue(visualProfile.exposure_label),
    stringValue(visualProfile.color_temperature),
    stringValue(audioProfile.audio_role),
    stringValue(logging.scene_number),
    stringValue(logging.shot_number),
    stringValue(logging.take_number),
    stringValue(logging.camera_id),
    stringValue(logging.card_id),
    ...jsonStringArray(logging.custom_tags_json),
    stringValue(logging.operator_notes),
    usability.usability,
    ...usability.evidence,
  ]);
}

function visualQualityRow(segmentId: string, quality: JsonRecord): JsonRecord {
  const scores = recordValue(quality.scores);
  const labels = recordValue(quality.labels);
  return {
    segment_id: segmentId,
    light_quality: scoreOrNull(scores.light_quality ?? quality.light_quality),
    subject_prominence: scoreOrNull(scores.subject_prominence ?? quality.subject_prominence),
    emotional_expression: scoreOrNull(scores.emotional_expression ?? quality.emotional_expression),
    composition_score: scoreOrNull(scores.composition_score ?? quality.composition_score),
    motion_quality: scoreOrNull(scores.motion_quality ?? quality.motion_quality),
    lighting_style_json: jsonArray(labels.lighting_style),
    composition_tags_json: jsonArray(labels.composition_tags),
    expression_tags_json: jsonArray(labels.expression_tags),
    motion_tags_json: jsonArray(labels.motion_tags),
  };
}

function visualAppraisalRow(segmentId: string, appraisal: JsonRecord): JsonRecord {
  const place = recordValue(appraisal.place_hint);
  return {
    segment_id: segmentId,
    frame_us: nonNegativeInteger(appraisal.frame_us),
    frame_path: nullableString(appraisal.frame_path),
    extracted_text_json: jsonArray(appraisal.extracted_text),
    extracted_text_flat: extractedTextFlat(appraisal.extracted_text),
    place_hint_name: nullableString(place.name),
    place_hint_category: nullableString(place.category),
    place_hint_confidence: scoreOrNull(place.confidence),
    place_hint_evidence_json: jsonArray(place.evidence),
    aesthetic_notes_json: jsonArray(appraisal.aesthetic_notes),
    aesthetic_notes_flat: arrayStrings(appraisal.aesthetic_notes).join(" "),
  };
}

function peakAnalysisRow(segmentId: string, peak: JsonRecord): JsonRecord {
  const recommended = recordValue(peak.recommended_in_out);
  const support = recordValue(peak.support_signals);
  return {
    segment_id: segmentId,
    recommended_in_us: nonNegativeInteger(recommended.recommended_in_us ?? recommended.best_in_us),
    recommended_out_us: nonNegativeInteger(recommended.recommended_out_us ?? recommended.best_out_us),
    recommended_rationale: nullableString(recommended.rationale ?? recommended.reason),
    motion_support_score: scoreOrNull(support.motion_support_score),
    audio_support_score: scoreOrNull(support.audio_support_score),
    fused_peak_score: scoreOrNull(support.fused_peak_score),
  };
}

function insertPeakMoments(
  stmt: Database.Statement,
  segmentId: string,
  peak: JsonRecord,
  warnings: string[],
): void {
  const moments = readArrayFrom(peak, "peak_moments");
  moments.forEach((moment, index) => {
    const type = stringValue(moment.type);
    if (type !== "action_peak" && type !== "emotional_peak" && type !== "visual_peak") {
      warnings.push(`peak moment skipped for ${segmentId}: invalid type ${type || "missing"}`);
      return;
    }
    const timestampUs = nonNegativeInteger(moment.timestamp_us);
    const confidence = scoreOrNull(moment.confidence);
    if (timestampUs == null || confidence == null) {
      warnings.push(`peak moment skipped for ${segmentId}: missing timestamp/confidence`);
      return;
    }
    stmt.run({
      peak_ref: stringValue(moment.peak_ref) || `PK_${segmentId}_${index + 1}`,
      segment_id: segmentId,
      timestamp_us: timestampUs,
      type,
      confidence,
      description: stringValue(moment.description),
      source_pass: stringValue(moment.source_pass) || "unknown",
    });
  });
}

function qualityLabels(segment: JsonRecord): string[] {
  const quality = recordValue(segment.visual_quality);
  const labels = recordValue(quality.labels);
  return uniqueStrings([
    ...arrayStrings(labels.lighting_style),
    ...arrayStrings(labels.composition_tags),
    ...arrayStrings(labels.expression_tags),
    ...arrayStrings(labels.motion_tags),
  ]);
}

function dominantSubjectPosition(description: string): string {
  const text = description.toLowerCase();
  if (/\b(left\s+side|on\s+the\s+left|left\s+of\s+frame|frame\s+left)\b/.test(text)) return "left";
  if (/\b(right\s+side|on\s+the\s+right|right\s+of\s+frame|frame\s+right)\b/.test(text)) return "right";
  if (/\b(center(?:ed)?|centre(?:d)?|middle|center\s+of\s+frame)\b/.test(text)) return "center";
  return "unknown";
}

function compositionAnchor(description: string): string {
  const side = dominantSubjectPosition(description);
  return side === "unknown" ? "unknown" : side;
}

function dominantSubjectType(description: string): string {
  const text = description.toLowerCase();
  if (/\b(person|child|man|woman|face|hand|speaker|worker|vendor)\b/.test(text)) return "person";
  if (/\b(people|group|crowd|family|team)\b/.test(text)) return "group";
  if (/\b(car|bus|bike|bicycle|train|vehicle)\b/.test(text)) return "vehicle";
  if (/\b(river|mountain|forest|landscape|environment|street|room|market)\b/.test(text)) return "environment";
  if (/\b(object|tool|dial|food|chestnut|table)\b/.test(text)) return "object";
  return "unknown";
}

function subjectMovementDirection(description: string): string {
  const text = description.toLowerCase();
  if (/\b(subject|person|child|people|vehicle|object).{0,30}(left\s+to\s+right|toward\s+the\s+right|rightward)\b/.test(text)) return "ltr";
  if (/\b(subject|person|child|people|vehicle|object).{0,30}(right\s+to\s+left|toward\s+the\s+left|leftward)\b/.test(text)) return "rtl";
  if (/\b(subject|person|child|people|vehicle|object).{0,30}(toward|closer|approaches)\b/.test(text)) return "toward_camera";
  if (/\b(subject|person|child|people|vehicle|object).{0,30}(away|recedes|leaves)\b/.test(text)) return "away_camera";
  if (/\b(static subject|subject remains|still subject)\b/.test(text)) return "static";
  return "unknown";
}

function exposureLabel(description: string, qualityFlags: string[]): string {
  const text = `${description} ${qualityFlags.join(" ")}`.toLowerCase();
  if (/\b(overexposed|over exposure|blown\s+out|too\s+bright)\b/.test(text)) return "over";
  if (/\b(underexposed|under exposure|too\s+dark)\b/.test(text)) return "under";
  if (/\b(normal exposure|well exposed|properly exposed)\b/.test(text)) return "normal";
  return "unknown";
}

function colorTemperature(description: string, qualityLabels: string[]): string {
  const text = `${description} ${qualityLabels.join(" ")}`.toLowerCase();
  if (/\b(warm|golden|sunset)\b/.test(text)) return "warm";
  if (/\b(cool|blue|cold)\b/.test(text)) return "cool";
  if (/\b(neutral|daylight)\b/.test(text)) return "neutral";
  return "unknown";
}

function contrastLabel(description: string, qualityLabels: string[]): string {
  const text = `${description} ${qualityLabels.join(" ")}`.toLowerCase();
  if (/\b(high contrast|harsh contrast)\b/.test(text)) return "high";
  if (/\b(low contrast|flat_light|flat light)\b/.test(text)) return "low";
  if (/\b(normal contrast)\b/.test(text)) return "normal";
  return "unknown";
}

function saturationLabel(description: string, qualityLabels: string[]): string {
  const text = `${description} ${qualityLabels.join(" ")}`.toLowerCase();
  if (/\b(vivid|saturated|colorful)\b/.test(text)) return "vivid";
  if (/\b(muted|desaturated)\b/.test(text)) return "muted";
  if (/\b(normal saturation)\b/.test(text)) return "normal";
  return "unknown";
}

function depthOfField(description: string): string {
  const text = description.toLowerCase();
  if (/\b(shallow depth|shallow focus|bokeh)\b/.test(text)) return "shallow";
  if (/\b(deep focus|deep depth)\b/.test(text)) return "deep";
  if (/\b(medium depth)\b/.test(text)) return "medium";
  return "unknown";
}

function hasColorCue(description: string, qualityLabels: string[], qualityFlags: string[]): boolean {
  return /warm|cool|neutral|contrast|saturation|muted|vivid|overexposed|underexposed/i.test([
    description,
    ...qualityLabels,
    ...qualityFlags,
  ].join(" "));
}

function audioRole(hasDialogue: boolean, hasMusic: boolean, silenceRole: boolean | null | undefined): string {
  if (silenceRole) return "silence";
  if (hasDialogue && hasMusic) return "mixed";
  if (hasDialogue) return "dialogue";
  if (hasMusic) return "music";
  return "ambient";
}

function transcriptDensity(transcript: TranscriptSlice, durationUs: number): number | null {
  if (durationUs <= 0 || transcript.itemRefs.length === 0) return transcript.hasDialogue ? 0.5 : null;
  const spokenUs = transcript.itemRefs.reduce((sum, item) => {
    if (item.start_us == null || item.end_us == null || item.end_us <= item.start_us) return sum;
    return sum + item.end_us - item.start_us;
  }, 0);
  return Math.max(0, Math.min(1, spokenUs / durationUs));
}

function resolveSourceMediaPath(projectDir: string, asset: JsonRecord): string | null {
  const candidates = [
    stringValue(asset.source_locator),
    stringValue(asset.path),
    stringValue(asset.file_path),
    stringValue(asset.filename),
  ].filter(Boolean);
  for (const candidate of candidates) {
    const resolved = path.isAbsolute(candidate) ? candidate : path.resolve(projectDir, candidate);
    if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) return resolved;
  }
  return null;
}

function classifyUsability(segmentId: string, quality: JsonRecord, qualityFlags: string[]): UsabilityClassification {
  const scores = recordValue(quality.scores);
  const values = [
    scores.light_quality ?? quality.light_quality,
    scores.subject_prominence ?? quality.subject_prominence,
    scores.emotional_expression ?? quality.emotional_expression,
    scores.composition_score ?? quality.composition_score,
    scores.motion_quality ?? quality.motion_quality,
  ].map(scoreNumber).filter((value): value is number => value != null);
  const lowerFlags = qualityFlags.map((flag) => flag.toLowerCase());
  const explicitBadFlags = lowerFlags.filter((flag) => /\b(blur|blurry|overexposure|overexposed|shake|shaky|underexposed|clipping|unusable)\b/.test(flag));
  const evidence = [
    `segment:${segmentId}`,
    ...values.map((value) => `quality_score:${value.toFixed(2)}`),
    ...explicitBadFlags.map((flag) => `quality_flag:${flag}`),
  ];
  if (values.length > 0 && values.every((value) => value < 0.3)) {
    return { usability: "unusable", confidence: 0.8, evidence };
  }
  if (values.some((value) => value < 0.3) || explicitBadFlags.length > 0) {
    return { usability: "partially_usable", confidence: explicitBadFlags.length > 0 ? 0.75 : 0.65, evidence };
  }
  return { usability: "fully_usable", confidence: values.length > 0 ? 0.6 : 0.4, evidence };
}

function frameRateMode(
  fpsNum: number | null,
  fpsDen: number | null,
  hasAudio: boolean,
  width: number | null,
  height: number | null,
): string {
  if (!width && !height && hasAudio) return "audio_only";
  if (!fpsNum || !fpsDen) return "unknown";
  return "unknown";
}

function normalizedRotation(value: unknown): number | null {
  const parsed = integerLike(value);
  if (parsed == null) return null;
  const normalized = ((parsed % 360) + 360) % 360;
  return normalized === 0 || normalized === 90 || normalized === 180 || normalized === 270 ? normalized : null;
}

function streamDurations(video: JsonRecord, audioStreams: unknown[]): JsonRecord[] {
  const rows: JsonRecord[] = [];
  const videoDuration = nullableString(video.duration);
  if (videoDuration) rows.push({ type: "video", duration: videoDuration });
  audioStreams.forEach((stream, index) => {
    const record = recordValue(stream);
    const duration = nullableString(record.duration);
    if (duration) rows.push({ type: "audio", index, duration });
  });
  return rows;
}

function normalizeAudioStream(value: unknown): JsonRecord {
  const stream = recordValue(value);
  return {
    codec: nullableString(stream.codec_name ?? stream.codec),
    channels: nonNegativeIntegerLike(stream.channels),
    sample_rate: nonNegativeIntegerLike(stream.sample_rate ?? stream.sample_rate_hz),
    channel_layout: nullableString(stream.channel_layout),
  };
}

function optionalBooleanInt(value: unknown): number | null {
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "number" && (value === 0 || value === 1)) return value;
  return null;
}

function jsonStringArray(value: unknown): string[] {
  if (typeof value !== "string") return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return arrayStrings(parsed);
  } catch {
    return [];
  }
}

function assetTechnicalTerms(asset: JsonRecord): string[] {
  const row = assetTechnicalRow(stringValue(asset.asset_id), asset);
  return uniqueStrings([
    stringValue(row.video_codec),
    stringValue(row.video_profile),
    stringValue(row.recording_format),
    stringValue(row.container_format),
    stringValue(row.width),
    stringValue(row.height),
    stringValue(row.frame_rate_mode),
    stringValue(row.color_primaries),
    stringValue(row.color_transfer),
    stringValue(row.color_space),
    stringValue(row.reel_name),
    stringValue(row.card_id),
    stringValue(row.camera_id),
  ]);
}

function transcriptForSegment(
  segment: JsonRecord,
  asset: JsonRecord,
  transcripts: Map<string, TranscriptDocument>,
  srcInUs: number,
  srcOutUs: number,
): TranscriptSlice {
  const transcriptRef = stringValue(segment.transcript_ref ?? asset.transcript_ref);
  const assetId = stringValue(segment.asset_id);
  const doc = transcripts.get(transcriptRef) ?? transcripts.get(assetId) ?? null;
  if (!doc) {
    const fallback = stringValue(segment.transcript_excerpt);
    return {
      text: fallback,
      language: null,
      confidenceMin: null,
      hasDialogue: fallback.trim().length > 0,
      itemRefs: [],
      transcriptHash: null,
    };
  }
  if (doc.items.length === 0) {
    return {
      text: doc.text || stringValue(segment.transcript_excerpt),
      language: null,
      confidenceMin: null,
      hasDialogue: Boolean(doc.text.trim()),
      itemRefs: [],
      transcriptHash: doc.hash,
    };
  }
  const overlapping = doc.items.filter((item) => (
    typeof item.start_us === "number" &&
    typeof item.end_us === "number" &&
    item.end_us > srcInUs &&
    item.start_us < srcOutUs
  ));
  const text = overlapping.map((item) => item.text).filter(Boolean).join(" ") || stringValue(segment.transcript_excerpt);
  const confidences = overlapping
    .map((item) => item.confidence)
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  return {
    text,
    language: null,
    confidenceMin: confidences.length > 0 ? Math.min(...confidences) : null,
    hasDialogue: text.trim().length > 0,
    itemRefs: overlapping.map((item) => ({
      transcript_ref: doc.transcriptRef,
      item_id: item.item_id,
      start_us: item.start_us,
      end_us: item.end_us,
    })),
    transcriptHash: doc.hash,
  };
}

function loadUserAnnotations(
  projectDir: string,
  annotationsPath: string,
  sources: SourceRecord[],
  warnings: string[],
): UserAnnotations {
  const empty = { bySegmentId: new Map<string, JsonRecord>(), byAssetId: new Map<string, JsonRecord>() };
  if (!fs.existsSync(annotationsPath)) return empty;
  try {
    const data = JSON.parse(fs.readFileSync(annotationsPath, "utf-8")) as JsonRecord;
    sources.push(sourceRecord(projectDir, "footage_user_annotations", "03_analysis/footage_user_annotations.json", false, data));
    for (const annotation of readArrayFrom(data, "annotations")) {
      const segmentId = stringValue(annotation.segment_id);
      const assetId = stringValue(annotation.asset_id);
      if (segmentId) empty.bySegmentId.set(segmentId, annotation);
      else if (assetId) empty.byAssetId.set(assetId, annotation);
      else warnings.push("footage_user_annotations entry skipped: missing segment_id or asset_id");
    }
  } catch (error) {
    warnings.push(`footage_user_annotations skipped: ${error instanceof Error ? error.message : String(error)}`);
  }
  return empty;
}

function loadFilenameParser(
  projectDir: string,
  configPath: string,
  sources: SourceRecord[],
  warnings: string[],
): FilenameParserConfig {
  if (!fs.existsSync(configPath)) return { enabled: false };
  try {
    const data = JSON.parse(fs.readFileSync(configPath, "utf-8")) as JsonRecord;
    sources.push(sourceRecord(projectDir, "footage_filename_parser", "03_analysis/footage_filename_parser.json", false, data));
    return { enabled: data.enabled !== false };
  } catch (error) {
    warnings.push(`footage_filename_parser skipped: ${error instanceof Error ? error.message : String(error)}`);
    return { enabled: false };
  }
}

function readTranscriptDocuments(projectDir: string): TranscriptDocument[] {
  const transcriptsDir = path.join(projectDir, "03_analysis/transcripts");
  if (!fs.existsSync(transcriptsDir)) return [];
  return fs.readdirSync(transcriptsDir)
    .filter((file) => file.endsWith(".json"))
    .sort()
    .flatMap((file) => {
      const filePath = path.join(transcriptsDir, file);
      try {
        const data = JSON.parse(fs.readFileSync(filePath, "utf-8")) as JsonRecord;
        const items = readArrayFrom(data, "items").map((item): TranscriptItem => ({
          item_id: nullableString(item.item_id) ?? undefined,
          start_us: nonNegativeInteger(item.start_us) ?? undefined,
          end_us: nonNegativeInteger(item.end_us) ?? undefined,
          text: stringValue(item.text),
          confidence: scoreOrNull(item.confidence) ?? undefined,
        }));
        const relPath = path.relative(projectDir, filePath);
        return [{
          relPath,
          transcriptRef: stringValue(data.transcript_ref) || path.basename(file, ".json"),
          assetId: stringValue(data.asset_id) || path.basename(file, ".json"),
          text: stringValue(data.text) || items.map((item) => item.text).filter(Boolean).join(" "),
          items,
          hash: computeNormalizedJsonHash(data, ["created_at"]),
        }];
      } catch {
        return [];
      }
    });
}

function buildTranscriptMap(transcripts: TranscriptDocument[]): Map<string, TranscriptDocument> {
  const map = new Map<string, TranscriptDocument>();
  for (const transcript of transcripts) {
    map.set(transcript.transcriptRef, transcript);
    map.set(transcript.assetId, transcript);
  }
  return map;
}

function buildMarlinMap(data: JsonRecord | null): Map<string, ReturnType<typeof normalizeMarlinAsset>> {
  const map = new Map<string, ReturnType<typeof normalizeMarlinAsset>>();
  for (const item of readArrayFrom(data, "items", "assets")) {
    const asset = normalizeMarlinAsset(item);
    if (asset.asset_id) map.set(asset.asset_id, asset);
  }
  return map;
}

function normalizeMarlinAsset(item: JsonRecord) {
  return {
    asset_id: stringValue(item.asset_id),
    source_path: nullableString(item.source_path),
    scene: stringValue(item.scene),
    caption: stringValue(item.caption),
    events: readArrayFrom(item, "events"),
  };
}

function extractedTextFlat(value: unknown): string {
  if (!Array.isArray(value)) return "";
  return value.map((item) => {
    if (typeof item === "string") return item;
    if (item && typeof item === "object" && typeof (item as JsonRecord).text === "string") {
      return (item as JsonRecord).text as string;
    }
    return "";
  }).filter(Boolean).join(" ");
}

function placeText(place: JsonRecord): string {
  return [
    stringValue(place.name),
    stringValue(place.category),
    ...arrayStrings(place.evidence),
  ].filter(Boolean).join(" ");
}

function readRequiredJson(filePath: string): JsonRecord {
  if (!fs.existsSync(filePath)) throw new Error(`required source missing: ${filePath}`);
  return JSON.parse(fs.readFileSync(filePath, "utf-8")) as JsonRecord;
}

function sourceRecord(projectDir: string, sourceName: string, relPath: string, required: boolean, data: unknown): SourceRecord {
  return {
    source_name: sourceName,
    rel_path: relPath,
    hash: computeNormalizedJsonHash(data, ["created_at"]),
    required,
  };
}

function readProjectId(projectDir: string, assetsJson: JsonRecord, segmentsJson: JsonRecord): string {
  for (const data of [assetsJson, segmentsJson]) {
    if (typeof data.project_id === "string" && data.project_id.trim()) return data.project_id;
  }
  return path.basename(projectDir);
}

function readArrayFrom(data: JsonRecord | null, ...keys: string[]): JsonRecord[] {
  if (!data) return [];
  for (const key of keys) {
    const value = data[key];
    if (Array.isArray(value)) return value.filter((item): item is JsonRecord => !!item && typeof item === "object" && !Array.isArray(item));
  }
  return [];
}

function recordValue(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {};
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function nullableString(value: unknown): string | null {
  const text = stringValue(value).trim();
  return text ? text : null;
}

function arrayStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (typeof item === "string") return item.trim() ? [item.trim()] : [];
    if (item && typeof item === "object" && typeof (item as JsonRecord).text === "string") {
      const text = ((item as JsonRecord).text as string).trim();
      return text ? [text] : [];
    }
    return [];
  });
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

function jsonArray(value: unknown): string {
  return JSON.stringify(Array.isArray(value) ? value : []);
}

function nonNegativeInteger(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  return Math.trunc(value);
}

function positiveInteger(value: unknown): number | null {
  const parsed = integerLike(value);
  return parsed != null && parsed > 0 ? parsed : null;
}

function nonNegativeIntegerLike(value: unknown): number | null {
  const parsed = integerLike(value);
  return parsed != null && parsed >= 0 ? parsed : null;
}

function integerLike(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === "string" && value.trim()) {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function integerOrNull(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.trunc(value);
}

function scoreNumber(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return value;
}

function scoreOrNull(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  if (value < 0 || value > 1) return null;
  return value;
}

function truthy(value: unknown): boolean {
  return value === true || value === 1 || value === "true";
}

function overlaps(startA: number, endA: number, startB: number, endB: number): boolean {
  return endA > startB && startA < endB;
}

function hashValue(value: unknown): string {
  return computeNormalizedJsonHash(value, ["created_at"]);
}

function fpsParts(value: unknown): { fps_num: number; fps_den: number } | null {
  if (typeof value !== "string") return null;
  const match = value.trim().match(/^(?<num>\d+(?:\.\d+)?)(?:\/(?<den>\d+(?:\.\d+)?))?$/);
  if (!match?.groups) return null;
  const rawNum = Number.parseFloat(match.groups.num);
  const rawDen = match.groups.den ? Number.parseFloat(match.groups.den) : 1;
  if (!Number.isFinite(rawNum) || !Number.isFinite(rawDen) || rawNum <= 0 || rawDen <= 0) return null;
  const scale = 1_000_000;
  let num = Math.round(rawNum * scale);
  let den = Math.round(rawDen * scale);
  const divisor = gcd(Math.abs(num), Math.abs(den));
  num = Math.trunc(num / divisor);
  den = Math.trunc(den / divisor);
  return { fps_num: num, fps_den: den };
}

function gcd(a: number, b: number): number {
  while (b !== 0) {
    const t = b;
    b = a % b;
    a = t;
  }
  return a || 1;
}

function bitDepthFromPixelFormat(value: string): number | null {
  const match = value.match(/(?:p|yuv|rgb|gbrp|gray)(?<depth>8|10|12|14|16)(?:le|be)?/i);
  return positiveInteger(match?.groups?.depth);
}

function extensionFormat(filename: string): string | null {
  const ext = path.extname(filename).replace(/^\./, "").toLowerCase();
  return ext || null;
}
