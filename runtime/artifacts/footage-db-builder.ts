import Database from "better-sqlite3";
import * as fs from "node:fs";
import * as path from "node:path";
import { computeNormalizedJsonHash } from "./p1-manifest-coverage.js";
import { footageDbPath } from "./footage-db.js";
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
    const population = populateStructuredTables(db, inputs, indexedAt);
    warnings.push(...population.warnings);
    const embedding = await populateEmbeddings(db, population.embeddingTexts, embeddingPolicy, indexedAt, warnings);
    insertMeta(db, {
      schema_version: SCHEMA_VERSION,
      artifact_version: ARTIFACT_VERSION,
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
    sources,
    warnings,
  };
}

function populateStructuredTables(db: Database.Database, inputs: LoadedInputs, indexedAt: string): PopulationResult {
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
      assetCount += 1;
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
  const insertFts = db.prepare(`
    INSERT INTO segments_fts (
      segment_id, asset_id, summary, transcript, marlin_scene, marlin_events, tags,
      quality_labels, extracted_text, place, aesthetic_notes
    ) VALUES (
      @segment_id, @asset_id, @summary, @transcript, @marlin_scene, @marlin_events, @tags,
      @quality_labels, @extracted_text, @place, @aesthetic_notes
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
  const segmentTx = db.transaction(() => {
    segmentItems.forEach((segment, index) => {
      const segmentId = stringValue(segment.segment_id) || `SEG_${index + 1}`;
      const assetId = stringValue(segment.asset_id);
      const asset = assetById.get(assetId);
      if (!asset) {
        warnings.push(`segment ${segmentId} skipped: missing asset_id ${assetId || "unknown"}`);
        return;
      }
      const srcInUs = nonNegativeInteger(segment.src_in_us ?? segment.start_us);
      const srcOutUs = nonNegativeInteger(segment.src_out_us ?? segment.end_us);
      if (srcInUs == null || srcOutUs == null || srcOutUs <= srcInUs) {
        warnings.push(`segment ${segmentId} skipped: invalid source range`);
        return;
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
      insertTranscript.run({
        segment_id: segmentId,
        text: transcript.text,
        language: transcript.language,
        confidence_min: transcript.confidenceMin,
        has_dialogue: transcript.hasDialogue ? 1 : 0,
        item_refs_json: JSON.stringify(transcript.itemRefs),
      });
      if (transcript.text.trim()) transcriptSegments += 1;
      insertFts.run(ftsRow(record));
      ftsRows += 1;

      const fieldTexts = embeddingTextBundles(record);
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
    });
  });
  segmentTx();

  return {
    counts: {
      assets: assetCount,
      segments: segmentCount,
      fts_rows: ftsRows,
      marlin_events: marlinEventCount,
      transcript_segments: transcriptSegments,
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

function ftsRow(record: SegmentBuildRecord): Record<string, string> {
  return {
    segment_id: record.segmentId,
    asset_id: record.assetId,
    summary: searchFieldText([record.summary]),
    transcript: searchFieldText([record.transcript.text, record.transcriptExcerpt]),
    marlin_scene: searchFieldText([record.marlinSceneText]),
    marlin_events: searchFieldText(record.marlinEvents),
    tags: searchFieldText(record.tags),
    quality_labels: searchFieldText([...record.qualityLabels, ...record.qualityFlags]),
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

function embeddingTextBundles(record: SegmentBuildRecord): Record<EmbeddingField, string> {
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
  ].join(" ");
  return { summary, transcript, scene, combined };
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

function integerOrNull(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.trunc(value);
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
