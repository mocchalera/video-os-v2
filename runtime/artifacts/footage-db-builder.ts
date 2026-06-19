import Database from "better-sqlite3";
import * as fs from "node:fs";
import * as path from "node:path";
import { computeNormalizedJsonHash } from "./p1-manifest-coverage.js";
import { footageDbPath } from "./footage-db.js";
import {
  extractAudioLevels,
  extractCameraMotion,
  extractSceneShotTake,
  extractShotScale,
} from "./footage-metadata-extractor.js";
import {
  SEMANTIC_EMBEDDING_DTYPE,
  SEMANTIC_EMBEDDING_MODEL,
  embedTexts,
} from "../eval/semantic-match.js";

export type FootageDbEmbeddingPolicy = "auto" | "skip" | "require";
export type FootageDbRebuildMode = "full" | "incremental";

export interface BuildFootageDbOptions {
  projectDir: string;
  outputPath?: string;
  embeddingPolicy?: FootageDbEmbeddingPolicy;
  rebuildMode?: FootageDbRebuildMode;
  allowRemoteEmbeddingModels?: boolean;
  skipAudioAnalysis?: boolean;
  now?: Date;
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
  embedding_status: "ready" | "skipped" | "unavailable" | "error";
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
}

interface PopulationResult {
  counts: BuildFootageDbResult["counts"];
  embeddingTexts: Array<{ segment_id: string; field: EmbeddingField; text: string; content_hash: string }>;
  warnings: string[];
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
    const embedding = await populateEmbeddings(db, population.embeddingTexts, embeddingPolicy, indexedAt, warnings);
    insertMeta(db, {
      schema_version: SCHEMA_VERSION,
      artifact_version: ARTIFACT_VERSION,
      metadata_schema_version: "1",
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
    warnings,
  };
}

async function populateEmbeddings(
  db: Database.Database,
  embeddingTexts: Array<{ segment_id: string; field: EmbeddingField; text: string; content_hash: string }>,
  policy: FootageDbEmbeddingPolicy,
  createdAt: string,
  warnings: string[],
): Promise<{ status: BuildFootageDbResult["embedding_status"]; count: number }> {
  if (policy === "skip") return { status: "skipped", count: 0 };

  const rows = embeddingTexts.filter((row) => row.text.trim().length > 0);
  if (rows.length === 0) return { status: "ready", count: 0 };

  try {
    const vectors = await embedTexts(rows.map((row) => row.text), "passage");
    if (vectors.length !== rows.length || vectors.length === 0) {
      const message = "embedding model unavailable or returned no vectors";
      if (policy === "require") throw new Error(message);
      warnings.push(message);
      return { status: "unavailable", count: 0 };
    }

    const insertEmbedding = db.prepare(`
      INSERT INTO embeddings (
        segment_id, field, model_id, dimension, vector, content_hash, created_at
      ) VALUES (
        @segment_id, @field, @model_id, @dimension, @vector, @content_hash, @created_at
      )
    `);
    let count = 0;
    const tx = db.transaction(() => {
      rows.forEach((row, index) => {
        const vector = vectors[index];
        if (vector.length === 0) return;
        insertEmbedding.run({
          segment_id: row.segment_id,
          field: row.field,
          model_id: EMBEDDING_MODEL_ID,
          dimension: vector.length,
          vector: Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength),
          content_hash: row.content_hash,
          created_at: createdAt,
        });
        count += 1;
      });
    });
    tx();
    if (count === 0 && policy === "require") {
      throw new Error("embedding model returned only empty vectors");
    }
    return { status: count > 0 ? "ready" : "unavailable", count };
  } catch (error) {
    const message = `embedding population failed: ${error instanceof Error ? error.message : String(error)}`;
    if (policy === "require") throw new Error(message);
    warnings.push(message);
    return { status: "unavailable", count: 0 };
  }
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
  const tags = uniqueStrings([...arrayStrings(segment.tags), ...arrayStrings(segment.visual_tags)]);
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
  const quality = recordValue(record.segment.visual_quality);
  const qualityLabelsRecord = recordValue(quality.labels);
  return {
    segment_id: segmentId,
    camera_motion_description: motion.camera_motion_description,
    camera_motion_type: motion.camera_motion_type,
    camera_motion_direction: motion.camera_motion_direction,
    camera_stability: motion.camera_stability,
    motion_energy: scoreOrNull(recordValue(record.segment.peak_analysis).motion_energy),
    camera_motion_energy: scoreOrNull(recordValue(record.segment.peak_analysis).camera_motion_energy),
    shot_scale: shotScale,
    composition_anchor: compositionAnchor(description),
    subject_screen_side: dominantSubjectPosition(description),
    dominant_subject_type: dominantSubjectType(description),
    subject_movement_direction: subjectMovementDirection(description),
    exposure_label: exposureLabel(description, record.qualityFlags),
    color_temperature: colorTemperature(description, record.qualityLabels),
    contrast_label: contrastLabel(description, record.qualityLabels),
    saturation_label: saturationLabel(description, record.qualityLabels),
    dominant_colors_json: jsonArray(qualityLabelsRecord.dominant_colors ?? quality.dominant_colors),
    sampled_frame_count: nonNegativeInteger(quality.sampled_frame_count) ?? 0,
    depth_of_field: depthOfField(description),
    motion_confidence: motion.motion_confidence,
    scale_confidence: shotScale === "unknown" ? null : 0.55,
    subject_confidence: dominantSubjectPosition(description) === "unknown" ? null : 0.45,
    color_confidence: hasColorCue(description, record.qualityLabels, record.qualityFlags) ? 0.45 : null,
    depth_confidence: depthOfField(description) === "unknown" ? null : 0.45,
    extraction_source_json: JSON.stringify({ motion: "marlin_phrase_parser", shot_scale: "marlin_phrase_parser" }),
    evidence_json: JSON.stringify([...motion.evidence, ...record.qualityFlags, ...record.qualityLabels]),
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
