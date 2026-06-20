import Database from "better-sqlite3";
import * as fs from "node:fs";
import * as path from "node:path";
import { footageDbPath, readFootageDbStatus } from "../artifacts/footage-db.js";
import { cjkSearchExpansions, normalizeSearchText } from "../artifacts/footage-db-builder.js";
import type { Qwen3VlEmbeddingClient } from "../connectors/qwen3vl-embedding-local.js";
import type { ClapAudioEmbeddingClient } from "../connectors/clap-audio-local.js";
import {
  SEMANTIC_EMBEDDING_DTYPE,
  SEMANTIC_EMBEDDING_MODEL,
  cosineSimilarity,
  embedTexts,
} from "../eval/semantic-match.js";

export type FootageSearchMode = "hybrid" | "text" | "semantic" | "structured" | "visual" | "multimodal" | "audio";
export type FootageSortBy = "relevance" | "quality" | "chronological" | "duration";
export type VisualFrameType =
  | "visual_representative"
  | "visual_keyframe_in"
  | "visual_keyframe_peak"
  | "visual_keyframe_out";

export type FootageQualityField =
  | "light_quality"
  | "subject_prominence"
  | "emotional_expression"
  | "composition_score"
  | "motion_quality";

export interface FootageSearchFilters {
  shooting_date?: string;
  shooting_time_start?: string;
  shooting_time_end?: string;
  camera_type?: string;
  asset_ids?: string[];
  segment_type?: "dialogue" | "music_driven" | "action" | "static" | "general";
  min_duration_us?: number;
  max_duration_us?: number;
  quality_min?: Partial<Record<FootageQualityField, number>>;
  place_hint_name?: string;
  place_hint_category?: string;
  has_text?: boolean;
  has_dialogue?: boolean;
  has_music?: boolean;
  has_ambient?: boolean;
  video_codec?: string;
  recording_format?: string;
  frame_rate_mode?: "cfr" | "vfr" | "audio_only" | "unknown";
  min_width?: number;
  min_height?: number;
  color_primaries?: string;
  color_transfer?: string;
  reel_name?: string;
  card_id?: string;
  camera_id?: string;
  camera_motion?: string;
  camera_motion_type?: string | string[];
  camera_motion_direction?: string | string[];
  shot_scale?: string;
  stability?: string;
  camera_stability?: string | string[];
  audio_role?: string | string[];
  peak_dbfs_max?: number;
  integrated_lufs_min?: number;
  integrated_lufs_max?: number;
  silence_ratio_min?: number;
  silence_ratio_max?: number;
  scene_number?: string;
  shot_number?: string;
  take_number?: string;
  circle_take?: boolean;
  best_take?: boolean;
  usability?: string;
  min_metadata_confidence?: number;
  include_tags_any?: string[];
  custom_tags_any?: string[];
  exclude_quality_flags?: string[];
  noise_flags_exclude?: string[];
  exclude_segment_ids?: string[];
}

export interface FootageSearchContext {
  project_id?: string;
  terminology?: Array<{ term: string; meaning: string; aliases?: string[] }>;
  locations?: Array<{ name: string; description?: string; category?: string; aliases?: string[] }>;
  subjects?: Array<{ name: string; role?: string; appearance?: string; aliases?: string[] }>;
}

export interface FootageVisualAnchor {
  segment_id: string;
  frame_type?: VisualFrameType;
}

export interface SearchFootageInput {
  query: string;
  mode?: FootageSearchMode;
  explicitBoolean?: boolean;
  text_match?: string;
  semantic?: string;
  image_query_path?: string;
  audio_query_path?: string;
  visual_anchor?: FootageVisualAnchor;
  visual_goal?: "similarity" | "palette" | "shot_scale" | "match_cut";
  filters?: FootageSearchFilters;
  sort_by?: FootageSortBy;
  limit?: number;
  context?: FootageSearchContext;
  rerank?: {
    enabled?: boolean;
    top_n?: number;
  };
}

export interface SearchEmbeddingMatch {
  embedding_type: string;
  model_id: number;
  score: number;
  source_ref?: string;
  segment_embedding_id?: number;
  source_timestamp_us?: number;
}

export interface FootageScoreBreakdown {
  semantic?: number;
  e5_text?: number;
  lexical?: number;
  qwen_text?: number;
  qwen_visual?: number;
  qwen_mixed?: number;
  audio_similarity?: number;
  clap_audio?: number;
  structured?: number;
  quality?: number;
  peak?: number;
  duration?: number;
  final: number;
  weights?: Record<string, number>;
  embedding_matches?: SearchEmbeddingMatch[];
  unavailable_channels?: string[];
}

export interface FootageEvidenceRef {
  field:
    | "summary"
    | "transcript"
    | "marlin_scene"
    | "marlin_event"
    | "tag"
    | "quality_label"
    | "quality_score"
    | "quality_flag"
    | "ocr"
    | "place_hint"
    | "aesthetic_note"
    | "peak"
    | "context_expansion";
  value: string;
  score?: number;
}

export interface FootageSearchResult {
  segment_id: string;
  asset_id: string;
  src_in_us: number;
  src_out_us: number;
  duration_us: number;
  score: number;
  scores: FootageScoreBreakdown;
  match_reason: string;
  summary: string;
  key_frame_path?: string;
  tags: string[];
  quality_flags: string[];
  transcript_excerpt?: string;
  marlin_events?: string[];
  quality?: Partial<Record<FootageQualityField, number>>;
  place_hint?: {
    name?: string | null;
    category?: string;
    confidence?: number;
  };
  extracted_text?: Array<{
    text: string;
    language?: string;
    confidence?: number;
  }>;
  peak?: {
    timestamp_us?: number;
    type?: "action_peak" | "emotional_peak" | "visual_peak";
    confidence?: number;
    description?: string;
  };
  metadata?: {
    camera_motion?: string;
    camera_motion_type?: string;
    camera_motion_direction?: string;
    shot_scale?: string;
    stability?: string;
    camera_stability?: string;
    audio_role?: string;
    scene_number?: string;
    shot_number?: string;
    take_number?: string;
    circle_take?: boolean;
    dominant_subject_position?: string;
    usability?: string;
    has_dialogue?: boolean;
  };
  evidence_refs: FootageEvidenceRef[];
}

export type FootageResult = FootageSearchResult;

export interface FootageSearchResponse {
  query: SearchFootageInput;
  db_path?: string;
  db_status: "ready" | "missing" | "stale" | "malformed" | "fallback";
  mode_used: FootageSearchMode;
  rewritten_query?: {
    semantic?: string;
    text_terms?: string[];
    context_expansions?: string[];
    fts_match?: string;
  };
  results: FootageSearchResult[];
  warnings: string[];
}

export interface SimilarFootageInput {
  segment_id: string;
  different_location?: boolean;
  different_asset?: boolean;
  min_quality?: number;
  exclude_segment_ids?: string[];
  limit?: number;
}

export interface UnusedFootageInput {
  selected_segment_ids: string[];
  semantic?: string;
  min_quality?: number;
  limit?: number;
}

export interface BestForBeatInput {
  beat_id?: string;
  story_role?: "hook" | "setup" | "experience" | "payoff" | "reaction" | "closing";
  beat_purpose: string;
  required_visuals?: string[];
  avoid_segment_ids?: string[];
  limit?: number;
}

interface DbSearchRow {
  segment_id: string;
  asset_id: string;
  src_in_us: number;
  src_out_us: number;
  duration_us: number;
  segment_type: string | null;
  summary: string;
  transcript_excerpt: string;
  transcript_text: string;
  tags_json: string;
  quality_flags_json: string;
  asset_tags_json: string;
  asset_quality_flags_json: string;
  filmstrip_path: string | null;
  source_order: number;
  shooting_date?: string | null;
  shooting_time?: string | null;
  camera_type?: string | null;
  light_quality: number | null;
  subject_prominence: number | null;
  emotional_expression: number | null;
  composition_score: number | null;
  motion_quality: number | null;
  frame_path: string | null;
  extracted_text_json: string;
  extracted_text_flat: string;
  place_hint_name: string | null;
  place_hint_category: string | null;
  place_hint_confidence: number | null;
  aesthetic_notes_flat: string;
  has_dialogue: number;
  fused_peak_score: number | null;
  peak_timestamp_us: number | null;
  peak_type: "action_peak" | "emotional_peak" | "visual_peak" | null;
  peak_confidence: number | null;
  peak_description: string | null;
  camera_motion: string | null;
  camera_motion_type: string | null;
  camera_motion_direction: string | null;
  shot_scale: string | null;
  stability: string | null;
  camera_stability: string | null;
  audio_role: string | null;
  has_music: number | null;
  has_ambient: number | null;
  peak_dbfs: number | null;
  integrated_lufs: number | null;
  silence_ratio: number | null;
  noise_flags_json: string;
  scene_number: string | null;
  shot_number: string | null;
  take_number: string | null;
  circle_take: number | null;
  best_take: number | null;
  custom_tags_json: string;
  logging_confidence: number | null;
  audio_confidence: number | null;
  visual_motion_confidence: number | null;
  visual_scale_confidence: number | null;
  dominant_subject_position: string | null;
  usability: string | null;
}

interface EmbeddingVectorRow {
  segment_id: string;
  vector: Float32Array;
}

type QwenSearchEmbeddingType =
  | "visual_representative"
  | "visual_keyframe_in"
  | "visual_keyframe_peak"
  | "visual_keyframe_out"
  | "text_combined_qwen";

type AudioSearchEmbeddingType = "audio_representative" | "audio_text_clap";

interface SegmentEmbeddingDbRow {
  id: number;
  segment_id: string;
  embedding_type: string;
  dimension: number;
  vector: Buffer;
  model_id: number;
  output_dimension: number;
  normalized: number;
  source_ref: string;
  source_timestamp_us: number | null;
}

interface BuiltWhere {
  sql: string;
  params: Record<string, unknown>;
}

interface MetadataAvailability {
  assetTechnical: boolean;
  visualProfile: boolean;
  audioProfile: boolean;
  logging: boolean;
  usability: boolean;
  metadataFts: boolean;
}

interface SegmentEmbeddingVectorRow {
  id: number;
  segment_id: string;
  embedding_type: string;
  model_id: number;
  source_ref: string;
  source_timestamp_us: number | null;
  vector: Float32Array;
}

type SegmentEmbeddingVectorMap = Map<string, Map<string, SegmentEmbeddingVectorRow[]>>;

interface VisualInputValidation {
  imageQueryPath?: string;
  visualAnchor?: FootageVisualAnchor;
  hasVisualIntent: boolean;
  hasValidVisualQuery: boolean;
  shouldReturnEmpty: boolean;
}

interface AudioInputValidation {
  audioQueryPath?: string;
  hasAudioIntent: boolean;
  hasValidAudioQuery: boolean;
  shouldReturnEmpty: boolean;
}

interface QwenScoreResult {
  present: boolean;
  available: boolean;
  scores: Map<string, {
    qwenVisual?: number;
    qwenText?: number;
    matches: SearchEmbeddingMatch[];
  }>;
  unavailableChannels: string[];
}

interface AudioScoreResult {
  present: boolean;
  available: boolean;
  scores: Map<string, {
    audioSimilarity?: number;
    matches: SearchEmbeddingMatch[];
  }>;
  unavailableChannels: string[];
}

interface ScoreFusionResult {
  final: number;
  weights: Record<string, number>;
  unavailableChannels: string[];
}

type QwenFusionMode = "text" | "image" | "mixed";

const DEFAULT_FOOTAGE_SEARCH_LIMIT = 12;
const MAX_FOOTAGE_SEARCH_LIMIT = 50;
const QUALITY_FIELDS: FootageQualityField[] = [
  "light_quality",
  "subject_prominence",
  "emotional_expression",
  "composition_score",
  "motion_quality",
];
const EMBEDDING_MODEL_ID = `${SEMANTIC_EMBEDDING_MODEL}:${SEMANTIC_EMBEDDING_DTYPE}`;
const E5_MODEL_REVISION = "legacy-unpinned";
const E5_OUTPUT_DIMENSION = 384;
const E5_INSTRUCTION = "e5-query-passage-prefix-v1";
const E5_PREPROCESS_VERSION = "footage-db-text-bundle-v1";
const E5_RUNNER_NAME = "transformers.js";
const QWEN3VL_MODEL_NAME = "Qwen/Qwen3-VL-Embedding-2B";
const QWEN3VL_OUTPUT_DIMENSION = 2048;
const QWEN3VL_INSTRUCTION = "Retrieve relevant video footage for editing.";
const QWEN3VL_PREPROCESS_VERSION = "qwen3vl-frame-v1";
const CLAP_AUDIO_MODEL_NAME = "laion/clap-htsat-fused";
const CLAP_AUDIO_OUTPUT_DIMENSION = 512;
const CLAP_AUDIO_PREPROCESS_VERSION = "clap-audio-window-v1";
const VALID_IMAGE_QUERY_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp"]);
const VALID_AUDIO_QUERY_EXTENSIONS = new Set([".wav", ".mp3", ".flac"]);
const IMAGE_QUERY_APPROVED_DIRS_ENV = "VOS_FOOTAGE_SEARCH_APPROVED_FRAME_DIRS";
const AUDIO_QUERY_APPROVED_DIRS_ENV = "VOS_FOOTAGE_SEARCH_APPROVED_AUDIO_DIRS";
const QWEN_VISUAL_EMBEDDING_TYPES: QwenSearchEmbeddingType[] = [
  "visual_representative",
  "visual_keyframe_in",
  "visual_keyframe_peak",
  "visual_keyframe_out",
];
const QWEN_TEXT_QUERY_EMBEDDING_TYPES: QwenSearchEmbeddingType[] = [
  "visual_representative",
  "text_combined_qwen",
];
const QWEN_IMAGE_QUERY_EMBEDDING_TYPES: QwenSearchEmbeddingType[] = [
  "visual_representative",
];
const CLAP_AUDIO_EMBEDDING_TYPES: AudioSearchEmbeddingType[] = [
  "audio_representative",
  "audio_text_clap",
];
const segmentEmbeddingTableCache = new WeakMap<Database.Database, boolean>();
let qwenClientPromise: Promise<Qwen3VlEmbeddingClient | null> | null = null;
let qwenClientUnavailable = false;
let clapClientPromise: Promise<ClapAudioEmbeddingClient | null> | null = null;
let clapClientUnavailable = false;

function baseSelect(metadata: MetadataAvailability): string {
  return `
    SELECT
      s.segment_id,
      s.asset_id,
      s.src_in_us,
      s.src_out_us,
      s.duration_us,
      s.segment_type,
      s.summary,
      s.transcript_excerpt,
      COALESCE(st.text, '') AS transcript_text,
      s.tags_json,
      s.quality_flags_json,
      a.tags_json AS asset_tags_json,
      a.quality_flags_json AS asset_quality_flags_json,
      s.filmstrip_path,
      a.source_order,
      a.shooting_date,
      a.shooting_time,
      a.camera_type,
      v.light_quality,
      v.subject_prominence,
      v.emotional_expression,
      v.composition_score,
      v.motion_quality,
      app.frame_path,
      COALESCE(app.extracted_text_json, '[]') AS extracted_text_json,
      COALESCE(app.extracted_text_flat, '') AS extracted_text_flat,
      app.place_hint_name,
      app.place_hint_category,
      app.place_hint_confidence,
      COALESCE(app.aesthetic_notes_flat, '') AS aesthetic_notes_flat,
      ${metadata.audioProfile ? "COALESCE(sap.has_dialogue, st.has_dialogue, 0)" : "COALESCE(st.has_dialogue, 0)"} AS has_dialogue,
      ${metadata.audioProfile ? "sap.has_music" : "NULL"} AS has_music,
      ${metadata.audioProfile ? "sap.has_ambient" : "NULL"} AS has_ambient,
      pa.fused_peak_score,
      pm.timestamp_us AS peak_timestamp_us,
      pm.type AS peak_type,
      pm.confidence AS peak_confidence,
      pm.description AS peak_description,
      ${metadata.visualProfile ? "svp.camera_motion_type" : "NULL"} AS camera_motion,
      ${metadata.visualProfile ? "svp.camera_motion_type" : "NULL"} AS camera_motion_type,
      ${metadata.visualProfile ? "svp.camera_motion_direction" : "NULL"} AS camera_motion_direction,
      ${metadata.visualProfile ? "svp.shot_scale" : "NULL"} AS shot_scale,
      ${metadata.visualProfile ? "svp.camera_stability" : "NULL"} AS stability,
      ${metadata.visualProfile ? "svp.camera_stability" : "NULL"} AS camera_stability,
      ${metadata.visualProfile ? "svp.subject_screen_side" : "NULL"} AS dominant_subject_position,
      ${metadata.visualProfile ? "svp.motion_confidence" : "NULL"} AS visual_motion_confidence,
      ${metadata.visualProfile ? "svp.scale_confidence" : "NULL"} AS visual_scale_confidence,
      ${metadata.audioProfile ? "sap.audio_role" : "NULL"} AS audio_role,
      ${metadata.audioProfile ? "sap.peak_dbfs" : "NULL"} AS peak_dbfs,
      ${metadata.audioProfile ? "sap.integrated_lufs" : "NULL"} AS integrated_lufs,
      ${metadata.audioProfile ? "sap.silence_ratio" : "NULL"} AS silence_ratio,
      ${metadata.audioProfile ? "sap.noise_flags_json" : "'[]'"} AS noise_flags_json,
      ${metadata.audioProfile ? "sap.confidence" : "NULL"} AS audio_confidence,
      ${metadata.logging ? "slp.scene_number" : "NULL"} AS scene_number,
      ${metadata.logging ? "slp.shot_number" : "NULL"} AS shot_number,
      ${metadata.logging ? "slp.take_number" : "NULL"} AS take_number,
      ${metadata.logging ? "slp.circle_take" : "NULL"} AS circle_take,
      ${metadata.logging ? "slp.best_take" : "NULL"} AS best_take,
      ${metadata.logging ? "slp.custom_tags_json" : "'[]'"} AS custom_tags_json,
      ${metadata.logging ? "slp.confidence" : "NULL"} AS logging_confidence,
      ${metadata.usability ? "sup.usability" : "NULL"} AS usability
    FROM segments s
    JOIN assets a ON a.asset_id = s.asset_id
    LEFT JOIN visual_quality v ON v.segment_id = s.segment_id
    LEFT JOIN visual_appraisal app ON app.segment_id = s.segment_id
    LEFT JOIN segment_transcripts st ON st.segment_id = s.segment_id
    ${metadataJoinSql(metadata)}
    LEFT JOIN peak_analysis pa ON pa.segment_id = s.segment_id
    LEFT JOIN peak_moments pm ON pm.peak_ref = (
      SELECT pm2.peak_ref
      FROM peak_moments pm2
      WHERE pm2.segment_id = s.segment_id
      ORDER BY pm2.confidence DESC, pm2.timestamp_us ASC, pm2.peak_ref ASC
      LIMIT 1
    )
  `;
}

export function buildFtsMatchQuery(input: {
  text: string;
  explicitBoolean?: boolean;
  contextTerms?: string[];
}): { match: string; warnings: string[] } {
  const warnings: string[] = [];
  const text = normalizeSearchText(input.text);
  const contextTerms = (input.contextTerms ?? []).map(normalizeSearchText).filter(Boolean);
  const clauses: string[] = [];

  if (text) {
    if (input.explicitBoolean) clauses.push(booleanFtsExpression(text));
    else clauses.push(naturalFtsExpression(text));
  }
  for (const term of contextTerms) {
    const clause = groupedPhraseClauses(term);
    if (clause) clauses.push(clause);
  }

  const match = clauses.filter(Boolean).join(" OR ");
  if (!match) warnings.push("FTS query became empty; text search skipped");
  return { match, warnings };
}

export async function searchFootage(
  projectDir: string,
  input: SearchFootageInput,
): Promise<FootageSearchResponse> {
  const absProjectDir = path.resolve(projectDir);
  const status = readFootageDbStatus(absProjectDir);
  const warnings = [...(status.stale_reasons ?? [])];
  const mode = input.mode ?? (input.audio_query_path ? "audio" : "hybrid");
  const limit = clampLimit(input.limit);
  const visualInput = validateVisualInput(absProjectDir, input, mode, warnings);
  if (visualInput.shouldReturnEmpty) {
    return emptySearchResponse(absProjectDir, input, mode, status.status, warnings);
  }
  const audioInput = validateAudioInput(absProjectDir, input, mode, warnings);
  if (audioInput.shouldReturnEmpty) {
    return emptySearchResponse(absProjectDir, input, mode, status.status, warnings);
  }

  if (status.status === "missing" || status.status === "malformed") {
    return fallbackSearch(absProjectDir, input, mode, limit, [
      ...warnings,
      status.status === "missing"
        ? "footage DB missing; using segments.json fallback"
        : `footage DB malformed; using segments.json fallback: ${(status.errors ?? []).join("; ")}`,
    ]);
  }

  const dbPath = footageDbPath(absProjectDir);
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    db.pragma("foreign_keys = ON");
    const response = await searchFootageWithDb(db, dbPath, input, mode, limit, warnings, status.status, visualInput, audioInput);
    return response;
  } catch (error) {
    return fallbackSearch(absProjectDir, input, mode, limit, [
      ...warnings,
      `footage DB search failed; using segments.json fallback: ${error instanceof Error ? error.message : String(error)}`,
    ]);
  } finally {
    db.close();
  }
}

export async function disposeFootageSearch(): Promise<void> {
  const qwenClient = await qwenClientPromise;
  const clapClient = await clapClientPromise;
  qwenClientPromise = null;
  qwenClientUnavailable = false;
  clapClientPromise = null;
  clapClientUnavailable = false;
  await qwenClient?.shutdown();
  await clapClient?.shutdown();
}

function validateVisualInput(projectDir: string, input: SearchFootageInput, mode: FootageSearchMode, warnings: string[]): VisualInputValidation {
  const hasVisualIntent = mode === "visual" || mode === "multimodal" || Boolean(input.image_query_path || input.visual_anchor);
  const validation: VisualInputValidation = {
    hasVisualIntent,
    hasValidVisualQuery: false,
    shouldReturnEmpty: false,
  };

  if (input.image_query_path) {
    const pathValidation = validateImageQueryPath(projectDir, input.image_query_path);
    if (pathValidation.validPath) {
      validation.imageQueryPath = pathValidation.validPath;
      validation.hasValidVisualQuery = true;
    } else {
      warnings.push(pathValidation.warning);
    }
  }

  if (input.visual_anchor?.segment_id) {
    validation.visualAnchor = {
      segment_id: input.visual_anchor.segment_id,
      frame_type: input.visual_anchor.frame_type,
    };
    validation.hasValidVisualQuery = true;
  } else if (input.visual_anchor && !input.visual_anchor.segment_id) {
    warnings.push("visual_anchor.segment_id is required when visual_anchor is provided");
  }

  const text = normalizeSearchText(input.text_match ?? input.query);
  if (mode === "visual" && !validation.hasValidVisualQuery) {
    warnings.push("visual mode requires image_query_path or visual_anchor");
    validation.shouldReturnEmpty = true;
  }

  return validation;
}

function validateImageQueryPath(projectDir: string, imagePath: string): { validPath: string; warning: string } | { validPath?: undefined; warning: string } {
  if (!path.isAbsolute(imagePath)) {
    return { warning: "image_query_path must be an absolute path" };
  }
  if (!VALID_IMAGE_QUERY_EXTENSIONS.has(path.extname(imagePath).toLowerCase())) {
    return { warning: "image_query_path must be a .jpg, .jpeg, .png, or .webp file" };
  }
  if (!fs.existsSync(imagePath)) {
    return { warning: `image_query_path does not exist: ${imagePath}` };
  }

  let projectRoot: string;
  let realPath: string;
  let approvedRoots: string[];
  try {
    projectRoot = fs.realpathSync(projectDir);
    realPath = fs.realpathSync(imagePath);
    approvedRoots = imageQueryApprovedRoots(projectDir, projectRoot);
  } catch (error) {
    return { warning: `image_query_path could not be resolved: ${imagePath}: ${error instanceof Error ? error.message : String(error)}` };
  }

  let stat: fs.Stats;
  try {
    stat = fs.statSync(realPath);
  } catch (error) {
    return { warning: `image_query_path is not readable: ${imagePath}: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (!stat.isFile()) {
    return { warning: `image_query_path is not a regular file: ${imagePath}` };
  }

  if (!approvedRoots.some((root) => isPathWithin(realPath, root))) {
    return { warning: `image_query_path must resolve under the project root or approved frame cache directories: ${imagePath}` };
  }

  return { validPath: realPath, warning: "" };
}

function validateAudioInput(projectDir: string, input: SearchFootageInput, mode: FootageSearchMode, warnings: string[]): AudioInputValidation {
  const hasAudioIntent = mode === "audio" || Boolean(input.audio_query_path);
  const validation: AudioInputValidation = {
    hasAudioIntent,
    hasValidAudioQuery: false,
    shouldReturnEmpty: false,
  };

  if (input.audio_query_path) {
    const pathValidation = validateAudioQueryPath(projectDir, input.audio_query_path);
    if (pathValidation.validPath) {
      validation.audioQueryPath = pathValidation.validPath;
      validation.hasValidAudioQuery = true;
    } else {
      warnings.push(pathValidation.warning);
    }
  }

  const text = normalizeSearchText(input.text_match ?? input.query);
  if (mode === "audio" && !validation.hasValidAudioQuery && !text) {
    warnings.push("audio mode requires audio_query_path or query text");
    validation.shouldReturnEmpty = true;
  }

  return validation;
}

function validateAudioQueryPath(projectDir: string, audioPath: string): { validPath: string; warning: string } | { validPath?: undefined; warning: string } {
  if (!path.isAbsolute(audioPath)) {
    return { warning: "audio_query_path must be an absolute path" };
  }
  if (!VALID_AUDIO_QUERY_EXTENSIONS.has(path.extname(audioPath).toLowerCase())) {
    return { warning: "audio_query_path must be a .wav, .mp3, or .flac file" };
  }
  if (!fs.existsSync(audioPath)) {
    return { warning: `audio_query_path does not exist: ${audioPath}` };
  }

  let projectRoot: string;
  let realPath: string;
  let approvedRoots: string[];
  try {
    projectRoot = fs.realpathSync(projectDir);
    realPath = fs.realpathSync(audioPath);
    approvedRoots = audioQueryApprovedRoots(projectDir, projectRoot);
  } catch (error) {
    return { warning: `audio_query_path could not be resolved: ${audioPath}: ${error instanceof Error ? error.message : String(error)}` };
  }

  let stat: fs.Stats;
  try {
    stat = fs.statSync(realPath);
  } catch (error) {
    return { warning: `audio_query_path is not readable: ${audioPath}: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (!stat.isFile()) {
    return { warning: `audio_query_path is not a regular file: ${audioPath}` };
  }

  if (!approvedRoots.some((root) => isPathWithin(realPath, root))) {
    return { warning: `audio_query_path must resolve under the project root or approved audio cache directories: ${audioPath}` };
  }

  return { validPath: realPath, warning: "" };
}

function imageQueryApprovedRoots(projectDir: string, projectRoot: string): string[] {
  const roots = [projectRoot];
  for (const relPath of ["03_analysis", "02_media"]) {
    addRealDirectoryRoot(roots, path.join(projectDir, relPath));
  }
  for (const configuredRoot of configuredImageQueryRoots(projectDir)) {
    addRealDirectoryRoot(roots, configuredRoot);
  }
  return Array.from(new Set(roots));
}

function audioQueryApprovedRoots(projectDir: string, projectRoot: string): string[] {
  const roots = [projectRoot];
  for (const relPath of ["03_analysis", "02_media"]) {
    addRealDirectoryRoot(roots, path.join(projectDir, relPath));
  }
  for (const configuredRoot of configuredAudioQueryRoots(projectDir)) {
    addRealDirectoryRoot(roots, configuredRoot);
  }
  return Array.from(new Set(roots));
}

function configuredImageQueryRoots(projectDir: string): string[] {
  const value = process.env[IMAGE_QUERY_APPROVED_DIRS_ENV];
  if (!value) return [];
  return value
    .split(path.delimiter)
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => path.isAbsolute(item) ? item : path.resolve(projectDir, item));
}

function configuredAudioQueryRoots(projectDir: string): string[] {
  const value = process.env[AUDIO_QUERY_APPROVED_DIRS_ENV];
  if (!value) return [];
  return value
    .split(path.delimiter)
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => path.isAbsolute(item) ? item : path.resolve(projectDir, item));
}

function addRealDirectoryRoot(roots: string[], dirPath: string): void {
  try {
    const realDir = fs.realpathSync(dirPath);
    if (fs.statSync(realDir).isDirectory()) {
      roots.push(realDir);
    }
  } catch {
    // Optional roots are approved only when they exist and resolve cleanly.
  }
}

function isPathWithin(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function emptySearchResponse(
  projectDir: string,
  input: SearchFootageInput,
  mode: FootageSearchMode,
  dbStatus: FootageSearchResponse["db_status"],
  warnings: string[],
): FootageSearchResponse {
  return {
    query: input,
    db_path: footageDbPath(projectDir),
    db_status: dbStatus,
    mode_used: mode,
    results: [],
    warnings: Array.from(new Set(warnings)),
  };
}

export async function similarFootage(
  projectDir: string,
  input: SimilarFootageInput,
): Promise<FootageSearchResponse> {
  const query = await segmentTextForSimilarity(projectDir, input.segment_id);
  return searchFootage(projectDir, {
    query,
    semantic: query,
    mode: "hybrid",
    filters: {
      exclude_segment_ids: [input.segment_id, ...(input.exclude_segment_ids ?? [])],
      quality_min: input.min_quality == null ? undefined : { composition_score: input.min_quality },
    },
    limit: input.limit,
  });
}

export async function unusedFootage(
  projectDir: string,
  input: UnusedFootageInput,
): Promise<FootageSearchResponse> {
  return searchFootage(projectDir, {
    query: input.semantic ?? "",
    semantic: input.semantic,
    mode: input.semantic ? "hybrid" : "structured",
    filters: {
      exclude_segment_ids: input.selected_segment_ids,
      quality_min: input.min_quality == null ? undefined : { composition_score: input.min_quality },
    },
    limit: input.limit,
  });
}

export async function bestForBeat(
  projectDir: string,
  input: BestForBeatInput,
): Promise<FootageSearchResponse> {
  const query = [input.story_role, input.beat_purpose, ...(input.required_visuals ?? [])].filter(Boolean).join(" ");
  return searchFootage(projectDir, {
    query,
    semantic: query,
    mode: "hybrid",
    filters: { exclude_segment_ids: input.avoid_segment_ids },
    limit: input.limit,
  });
}

async function searchFootageWithDb(
  db: Database.Database,
  dbPath: string,
  input: SearchFootageInput,
  mode: FootageSearchMode,
  limit: number,
  warnings: string[],
  dbStatus: "ready" | "stale",
  visualInput: VisualInputValidation,
  audioInput: AudioInputValidation,
): Promise<FootageSearchResponse> {
  const filters = input.filters ?? {};
  const metadata = metadataAvailability(db);
  appendMissingIndexedDataWarnings(db, filters, metadata, warnings);
  const contextExpansions = contextTermsForQuery(input.query, input.context);
  const text = normalizeSearchText(input.text_match ?? input.query);
  const semanticText = normalizeSearchText(input.semantic ?? input.query);
  const structuredWhere = buildStructuredWhere(filters, metadata);
  const eligibleRows = loadRows(db, metadata, structuredWhere);
  let rows = applyPostFilters(eligibleRows, filters);
  const allowedIds = new Set(rows.map((row) => row.segment_id));

  const fts = text
    ? buildFtsMatchQuery({ text, explicitBoolean: input.explicitBoolean === true, contextTerms: contextExpansions })
    : { match: "", warnings: [] };
  warnings.push(...fts.warnings);

  const lexicalRaw = (mode === "structured" || !fts.match)
    ? new Map<string, number>()
    : ftsScores(db, metadata, structuredWhere, fts.match, allowedIds, warnings);
  const lexicalScores = normalizeRankScores(lexicalRaw);

  const qwenEmbeddingTypes = qwenEmbeddingTypesForQuery(mode, text, visualInput);
  const qwenEmbeddings = qwenEmbeddingTypes.length > 0
    ? loadQwenEmbeddingRows(db, rows.map((row) => row.segment_id), qwenEmbeddingTypes, warnings)
    : new Map<string, Map<string, SegmentEmbeddingVectorRow[]>>();
  const qwenRowsPresent = segmentEmbeddingVectorCount(qwenEmbeddings) > 0;
  const audioEmbeddingTypes = audioEmbeddingTypesForQuery(mode, text, audioInput);
  const audioEmbeddings = audioEmbeddingTypes.length > 0
    ? loadClapEmbeddingRows(db, rows.map((row) => row.segment_id), audioEmbeddingTypes, warnings)
    : new Map<string, Map<string, SegmentEmbeddingVectorRow[]>>();
  const audioRowsPresent = segmentEmbeddingVectorCount(audioEmbeddings) > 0;

  let semanticScores = new Map<string, number>();
  let semanticAvailable = false;
  const needsSemantic =
    (mode === "hybrid" || mode === "semantic" || mode === "multimodal" || mode === "visual" || mode === "audio" || (mode === "text" && qwenRowsPresent))
    && Boolean(semanticText);
  if (needsSemantic) {
    const semantic = await semanticScoresForRows(db, rows, semanticText, warnings);
    semanticScores = semantic.scores;
    semanticAvailable = semantic.available;
  }

  const qwen = qwenRowsPresent
    ? await qwenScoresForRows({
      db,
      rows,
      text,
      mode,
      visualInput,
      embeddings: qwenEmbeddings,
      warnings,
    })
    : {
      present: false,
      available: false,
      scores: new Map<string, { qwenVisual?: number; qwenText?: number; matches: SearchEmbeddingMatch[] }>(),
      unavailableChannels: [],
    };
  const audio = audioRowsPresent
    ? await audioScoresForRows({
      rows,
      text,
      mode,
      audioInput,
      embeddings: audioEmbeddings,
      warnings,
    })
    : {
      present: false,
      available: false,
      scores: new Map<string, { audioSimilarity?: number; matches: SearchEmbeddingMatch[] }>(),
      unavailableChannels: [],
    };

  if (mode === "text") {
    rows = rows.filter((row) => lexicalScores.has(row.segment_id) || qwen.scores.has(row.segment_id));
  } else if (mode === "semantic") {
    if (semanticAvailable) {
      rows = rows.filter((row) => semanticScores.has(row.segment_id));
    } else if (fts.match) {
      warnings.push("semantic embeddings unavailable; falling back to text search");
      rows = rows.filter((row) => lexicalScores.has(row.segment_id));
    } else {
      warnings.push("semantic embeddings unavailable and no text query was usable");
      rows = [];
    }
  } else if (mode === "visual") {
    if (qwen.available) {
      rows = rows.filter((row) => qwen.scores.has(row.segment_id));
    } else if (text && (semanticAvailable || lexicalScores.size > 0)) {
      warnings.push("visual search unavailable; falling back to text/semantic channels");
      rows = rows.filter((row) => semanticScores.has(row.segment_id) || lexicalScores.has(row.segment_id));
    } else {
      warnings.push("visual search unavailable; no text fallback was usable");
      rows = [];
    }
  } else if (mode === "multimodal") {
    if (!qwen.available && !text) {
      warnings.push("multimodal visual search unavailable; no text fallback was usable");
      rows = [];
    }
  } else if (mode === "audio") {
    if (audio.available) {
      rows = rows.filter((row) => audio.scores.has(row.segment_id));
    } else {
      warnings.push("audio search unavailable; no CLAP audio channel was usable");
      rows = [];
    }
  } else if (mode === "hybrid" && fts.match && !semanticAvailable && !qwen.available && !audio.available) {
    rows = rows.filter((row) => lexicalScores.has(row.segment_id));
  }

  const durationScores = normalizeDurationScores(rows);
  const eventLookup = marlinEventLookup(db, rows);
  const results = rows.map((row) => {
    const quality = qualityScore(row);
    const peak = peakScore(row);
    const lexical = lexicalScores.get(row.segment_id);
    const semantic = semanticScores.get(row.segment_id);
    const qwenScore = qwen.scores.get(row.segment_id);
    const audioScore = audio.scores.get(row.segment_id);
    const fusion = finalScore({
      semantic,
      lexical,
      qwenVisual: qwenScore?.qwenVisual,
      qwenText: qwenScore?.qwenText,
      audioSimilarity: audioScore?.audioSimilarity,
      quality,
      peak,
      duration: durationScores.get(row.segment_id) ?? 0,
      qwenPresent: qwen.present && (mode === "hybrid" || mode === "text" || mode === "visual" || mode === "multimodal"),
      audioPresent: audio.present && (mode === "hybrid" || mode === "audio" || mode === "multimodal"),
      qwenMode: qwenFusionMode(mode, text, visualInput),
      audioMode: mode === "audio" ? "audio" : "hybrid",
    });
    return rowToResult(row, {
      semantic,
      lexical,
      qwenText: qwenScore?.qwenText,
      qwenVisual: qwenScore?.qwenVisual,
      audioSimilarity: audioScore?.audioSimilarity,
      quality,
      peak,
      duration: durationScores.get(row.segment_id) ?? 0,
      final: fusion.final,
      weights: fusion.weights,
      unavailableChannels: Array.from(new Set([...fusion.unavailableChannels, ...qwen.unavailableChannels, ...audio.unavailableChannels])),
      embeddingMatches: [...(qwenScore?.matches ?? []), ...(audioScore?.matches ?? [])],
      marlinEvents: eventLookup.get(row.segment_id) ?? [],
      contextExpansions,
      query: input,
    });
  });

  const sorted = sortResults(results, rows, input.sort_by ?? "relevance").slice(0, limit);
  return {
    query: input,
    db_path: dbPath,
    db_status: dbStatus,
    mode_used: mode,
    rewritten_query: {
      semantic: semanticText || undefined,
      text_terms: text ? [text] : undefined,
      context_expansions: contextExpansions.length > 0 ? contextExpansions : undefined,
      fts_match: fts.match || undefined,
    },
    results: sorted,
    warnings: Array.from(new Set(warnings)),
  };
}

function buildStructuredWhere(filters: FootageSearchFilters, metadata: MetadataAvailability): BuiltWhere {
  const clauses: string[] = ["1 = 1"];
  const params: Record<string, unknown> = {};
  if (filters.shooting_date) {
    clauses.push("a.shooting_date = @shooting_date");
    params.shooting_date = filters.shooting_date;
  }
  if (filters.shooting_time_start) {
    clauses.push("a.shooting_time >= @shooting_time_start");
    params.shooting_time_start = filters.shooting_time_start;
  }
  if (filters.shooting_time_end) {
    clauses.push("a.shooting_time <= @shooting_time_end");
    params.shooting_time_end = filters.shooting_time_end;
  }
  if (filters.camera_type) {
    clauses.push("a.camera_type = @camera_type");
    params.camera_type = filters.camera_type;
  }
  if (filters.asset_ids && filters.asset_ids.length > 0) {
    clauses.push(inClause("s.asset_id", "asset_id", filters.asset_ids, params));
  }
  if (filters.segment_type) {
    clauses.push("s.segment_type = @segment_type");
    params.segment_type = filters.segment_type;
  }
  if (typeof filters.min_duration_us === "number") {
    clauses.push("s.duration_us >= @min_duration_us");
    params.min_duration_us = filters.min_duration_us;
  }
  if (typeof filters.max_duration_us === "number") {
    clauses.push("s.duration_us <= @max_duration_us");
    params.max_duration_us = filters.max_duration_us;
  }
  for (const field of QUALITY_FIELDS) {
    const min = filters.quality_min?.[field];
    if (typeof min === "number") {
      clauses.push(`v.${field} >= @quality_${field}`);
      params[`quality_${field}`] = min;
    }
  }
  if (filters.place_hint_name) {
    clauses.push("app.place_hint_name = @place_hint_name");
    params.place_hint_name = filters.place_hint_name;
  }
  if (filters.place_hint_category) {
    clauses.push("app.place_hint_category = @place_hint_category");
    params.place_hint_category = filters.place_hint_category;
  }
  if (filters.has_text === true) {
    clauses.push("(COALESCE(app.extracted_text_flat, '') <> '' OR COALESCE(st.text, '') <> '')");
  } else if (filters.has_text === false) {
    clauses.push("(COALESCE(app.extracted_text_flat, '') = '' AND COALESCE(st.text, '') = '')");
  }
  if (filters.has_dialogue === true) {
    clauses.push(`(${metadata.audioProfile ? "COALESCE(sap.has_dialogue, st.has_dialogue, 0)" : "COALESCE(st.has_dialogue, 0)"} = 1 OR s.segment_type = 'dialogue')`);
  } else if (filters.has_dialogue === false) {
    clauses.push(`(${metadata.audioProfile ? "COALESCE(sap.has_dialogue, st.has_dialogue, 0)" : "COALESCE(st.has_dialogue, 0)"} = 0 AND COALESCE(s.segment_type, '') <> 'dialogue')`);
  }
  if (filters.has_music != null) addBooleanFilter(clauses, params, metadata.audioProfile, "sap.has_music", "has_music", filters.has_music);
  if (filters.has_ambient != null) addBooleanFilter(clauses, params, metadata.audioProfile, "sap.has_ambient", "has_ambient", filters.has_ambient);
  addStringFilter(clauses, params, metadata.assetTechnical, "atm.video_codec", "video_codec", filters.video_codec);
  addStringFilter(clauses, params, metadata.assetTechnical, "atm.recording_format", "recording_format", filters.recording_format);
  addStringFilter(clauses, params, metadata.assetTechnical, "atm.frame_rate_mode", "frame_rate_mode", filters.frame_rate_mode);
  addStringFilter(clauses, params, metadata.assetTechnical, "atm.color_primaries", "color_primaries", filters.color_primaries);
  addStringFilter(clauses, params, metadata.assetTechnical, "atm.color_transfer", "color_transfer", filters.color_transfer);
  addStringFilter(clauses, params, metadata.assetTechnical, "atm.reel_name", "reel_name", filters.reel_name);
  addStringFilter(clauses, params, metadata.assetTechnical, "atm.card_id", "technical_card_id", filters.card_id);
  addStringFilter(clauses, params, metadata.assetTechnical, "atm.camera_id", "technical_camera_id", filters.camera_id);
  if (typeof filters.min_width === "number") addRangeFilter(clauses, params, metadata.assetTechnical, "atm.width", "min_width", ">=", filters.min_width);
  if (typeof filters.min_height === "number") addRangeFilter(clauses, params, metadata.assetTechnical, "atm.height", "min_height", ">=", filters.min_height);
  addStringArrayFilter(clauses, params, metadata.visualProfile, "svp.camera_motion_type", "camera_motion_type", filters.camera_motion_type ?? filters.camera_motion);
  addStringArrayFilter(clauses, params, metadata.visualProfile, "svp.camera_motion_direction", "camera_motion_direction", filters.camera_motion_direction);
  addStringArrayFilter(clauses, params, metadata.visualProfile, "svp.shot_scale", "shot_scale", filters.shot_scale);
  addStringArrayFilter(clauses, params, metadata.visualProfile, "svp.camera_stability", "camera_stability", filters.camera_stability ?? filters.stability);
  addStringArrayFilter(clauses, params, metadata.audioProfile, "sap.audio_role", "audio_role", filters.audio_role);
  if (typeof filters.peak_dbfs_max === "number") addRangeFilter(clauses, params, metadata.audioProfile, "sap.peak_dbfs", "peak_dbfs_max", "<=", filters.peak_dbfs_max);
  if (typeof filters.integrated_lufs_min === "number") addRangeFilter(clauses, params, metadata.audioProfile, "sap.integrated_lufs", "integrated_lufs_min", ">=", filters.integrated_lufs_min);
  if (typeof filters.integrated_lufs_max === "number") addRangeFilter(clauses, params, metadata.audioProfile, "sap.integrated_lufs", "integrated_lufs_max", "<=", filters.integrated_lufs_max);
  if (typeof filters.silence_ratio_min === "number") addRangeFilter(clauses, params, metadata.audioProfile, "sap.silence_ratio", "silence_ratio_min", ">=", filters.silence_ratio_min);
  if (typeof filters.silence_ratio_max === "number") addRangeFilter(clauses, params, metadata.audioProfile, "sap.silence_ratio", "silence_ratio_max", "<=", filters.silence_ratio_max);
  addStringFilter(clauses, params, metadata.logging, "slp.scene_number", "scene_number", filters.scene_number);
  addStringFilter(clauses, params, metadata.logging, "slp.shot_number", "shot_number", filters.shot_number);
  addStringFilter(clauses, params, metadata.logging, "slp.take_number", "take_number", filters.take_number);
  if (filters.circle_take != null) addBooleanFilter(clauses, params, metadata.logging, "slp.circle_take", "circle_take", filters.circle_take);
  if (filters.best_take != null) addBooleanFilter(clauses, params, metadata.logging, "slp.best_take", "best_take", filters.best_take);
  addStringFilter(clauses, params, metadata.usability, "sup.usability", "usability", filters.usability);
  if (typeof filters.min_metadata_confidence === "number") {
    if (metadata.visualProfile || metadata.audioProfile || metadata.logging) {
      const confidenceClauses = [
        metadata.visualProfile ? "COALESCE(svp.motion_confidence, svp.scale_confidence, 0)" : "0",
        metadata.audioProfile ? "COALESCE(sap.confidence, 0)" : "0",
        metadata.logging ? "COALESCE(slp.confidence, 0)" : "0",
      ];
      clauses.push(`MAX(${confidenceClauses.join(", ")}) >= @min_metadata_confidence`);
      params.min_metadata_confidence = filters.min_metadata_confidence;
    } else {
      clauses.push("0 = 1");
    }
  }
  if (filters.exclude_segment_ids && filters.exclude_segment_ids.length > 0) {
    clauses.push(`s.segment_id NOT IN (${filters.exclude_segment_ids.map((id, index) => {
      const key = `exclude_segment_id_${index}`;
      params[key] = id;
      return `@${key}`;
    }).join(", ")})`);
  }
  return { sql: clauses.join(" AND "), params };
}

function loadRows(db: Database.Database, metadata: MetadataAvailability, where: BuiltWhere): DbSearchRow[] {
  return db.prepare(`${baseSelect(metadata)} WHERE ${where.sql}`).all(where.params) as DbSearchRow[];
}

function ftsScores(
  db: Database.Database,
  metadata: MetadataAvailability,
  where: BuiltWhere,
  match: string,
  allowedIds: Set<string>,
  warnings: string[],
): Map<string, number> {
  try {
    const rows = db.prepare(`
      SELECT s.segment_id, bm25(segments_fts) AS rank
      FROM segments_fts
      JOIN segments s ON s.segment_id = segments_fts.segment_id
      JOIN assets a ON a.asset_id = s.asset_id
      LEFT JOIN visual_quality v ON v.segment_id = s.segment_id
      LEFT JOIN visual_appraisal app ON app.segment_id = s.segment_id
      LEFT JOIN segment_transcripts st ON st.segment_id = s.segment_id
      ${metadataJoinSql(metadata)}
      WHERE segments_fts MATCH @fts_match AND ${where.sql}
      ORDER BY rank ASC, s.segment_id ASC
    `).all({ ...where.params, fts_match: match }) as Array<{ segment_id: string; rank: number }>;
    const rankMap = new Map(rows
      .filter((row) => allowedIds.has(row.segment_id))
      .map((row) => [row.segment_id, row.rank]));
    if (metadata.metadataFts) {
      const metadataRows = db.prepare(`
        SELECT s.segment_id, bm25(segment_metadata_fts) AS rank
        FROM segment_metadata_fts
        JOIN segments s ON s.segment_id = segment_metadata_fts.segment_id
        JOIN assets a ON a.asset_id = s.asset_id
        LEFT JOIN visual_quality v ON v.segment_id = s.segment_id
        LEFT JOIN visual_appraisal app ON app.segment_id = s.segment_id
        LEFT JOIN segment_transcripts st ON st.segment_id = s.segment_id
        ${metadataJoinSql(metadata)}
        WHERE segment_metadata_fts MATCH @fts_match AND ${where.sql}
        ORDER BY rank ASC, s.segment_id ASC
      `).all({ ...where.params, fts_match: match }) as Array<{ segment_id: string; rank: number }>;
      for (const row of metadataRows) {
        if (!allowedIds.has(row.segment_id)) continue;
        const previous = rankMap.get(row.segment_id);
        rankMap.set(row.segment_id, previous == null ? row.rank : Math.min(previous, row.rank));
      }
    }
    return rankMap;
  } catch (error) {
    warnings.push(`FTS search skipped: ${error instanceof Error ? error.message : String(error)}`);
    return new Map();
  }
}

async function semanticScoresForRows(
  db: Database.Database,
  rows: DbSearchRow[],
  semanticText: string,
  warnings: string[],
): Promise<{ available: boolean; scores: Map<string, number> }> {
  if (rows.length === 0) return { available: false, scores: new Map() };
  const vectorRows = loadEmbeddingRows(db, rows.map((row) => row.segment_id), warnings);
  if (vectorRows.length === 0) {
    warnings.push("semantic embeddings unavailable; FTS/structured search only");
    return { available: false, scores: new Map() };
  }
  try {
    const queryVectors = await embedTexts([semanticText], "query");
    const queryVector = queryVectors[0];
    if (!queryVector || queryVector.length === 0) {
      warnings.push("semantic query embedding unavailable; FTS/structured search only");
      return { available: false, scores: new Map() };
    }
    const raw = new Map<string, number>();
    for (const row of vectorRows) {
      raw.set(row.segment_id, cosineSimilarity(queryVector, row.vector));
    }
    return { available: true, scores: normalizeCosineScores(raw) };
  } catch (error) {
    warnings.push(`semantic search skipped: ${error instanceof Error ? error.message : String(error)}`);
    return { available: false, scores: new Map() };
  }
}

function loadEmbeddingRows(
  db: Database.Database,
  segmentIds: string[],
  warnings: string[],
): EmbeddingVectorRow[] {
  if (segmentIds.length === 0) return [];
  if (hasSegmentEmbeddingsTables(db)) {
    return loadSegmentEmbeddingRows(db, segmentIds, warnings);
  }
  const params: Record<string, unknown> = { model_id: EMBEDDING_MODEL_ID };
  const clause = inClause("segment_id", "semantic_segment_id", segmentIds, params);
  const rows = db.prepare(`
    SELECT segment_id, vector
    FROM embeddings
    WHERE model_id = @model_id AND field = 'combined' AND ${clause}
  `).all(params) as Array<{ segment_id: string; vector: Buffer }>;
  return rows.map((row) => ({ segment_id: row.segment_id, vector: decodeVector(row.vector) }));
}

function loadSegmentEmbeddingRows(
  db: Database.Database,
  segmentIds: string[],
  warnings: string[],
): EmbeddingVectorRow[] {
  const model = db.prepare(`
    SELECT id
    FROM embedding_models
    WHERE name = @name
      AND model_revision = @model_revision
      AND output_dimension = @output_dimension
      AND input_modality = @input_modality
      AND instruction = @instruction
      AND preprocess_version = @preprocess_version
      AND runner_name = @runner_name
      AND precision = @precision
      AND normalized = @normalized
      AND distance_metric = @distance_metric
    ORDER BY id ASC
    LIMIT 1
  `).get({
    name: SEMANTIC_EMBEDDING_MODEL,
    model_revision: E5_MODEL_REVISION,
    output_dimension: E5_OUTPUT_DIMENSION,
    input_modality: "text",
    instruction: E5_INSTRUCTION,
    preprocess_version: E5_PREPROCESS_VERSION,
    runner_name: E5_RUNNER_NAME,
    precision: SEMANTIC_EMBEDDING_DTYPE,
    normalized: 1,
    distance_metric: "cosine",
  }) as { id: number } | undefined;
  if (!model) {
    warnings.push("semantic embeddings unavailable: E5 model registry row missing");
    return [];
  }

  const params: Record<string, unknown> = { model_id: model.id };
  const clause = inClause("se.segment_id", "semantic_segment_id", segmentIds, params);
  const rows = db.prepare(`
    SELECT
      se.id,
      se.segment_id,
      se.embedding_type,
      se.dimension,
      se.vector,
      se.model_id,
      se.source_ref,
      se.source_timestamp_us,
      em.output_dimension,
      em.normalized
    FROM segment_embeddings se
    JOIN embedding_models em ON em.id = se.model_id
    WHERE se.model_id = @model_id
      AND se.embedding_type = 'combined'
      AND ${clause}
    ORDER BY se.segment_id ASC, se.id ASC
  `).all(params) as SegmentEmbeddingDbRow[];

  return rows.flatMap((row) => {
    const vector = validatedSegmentEmbeddingVector(row, warnings);
    return vector ? [{ segment_id: row.segment_id, vector }] : [];
  });
}

function validatedSegmentEmbeddingVector(row: SegmentEmbeddingDbRow, warnings: string[]): Float32Array | null {
  const label = `segment_embeddings row ${row.id} (${row.segment_id}/${row.embedding_type})`;
  if (row.dimension !== row.output_dimension) {
    warnings.push(`${label} skipped: dimension ${row.dimension} does not match embedding_models.output_dimension ${row.output_dimension}`);
    return null;
  }
  if (row.vector.byteLength !== row.dimension * 4) {
    warnings.push(`${label} skipped: vector byte length ${row.vector.byteLength} does not equal dimension * 4 (${row.dimension * 4})`);
    return null;
  }

  const vector = decodeVector(row.vector);
  let magnitudeSquared = 0;
  for (let index = 0; index < vector.length; index += 1) {
    const value = vector[index];
    if (!Number.isFinite(value)) {
      warnings.push(`${label} skipped: vector contains non-finite value at index ${index}`);
      return null;
    }
    magnitudeSquared += value * value;
  }

  if (row.normalized === 1) {
    const norm = Math.sqrt(magnitudeSquared);
    if (norm < 0.9 || norm > 1.1) {
      warnings.push(`${label} skipped: normalized vector L2 norm ${norm.toFixed(6)} is outside 0.9-1.1`);
      return null;
    }
  }

  return vector;
}

function hasSegmentEmbeddingsTables(db: Database.Database): boolean {
  const cached = segmentEmbeddingTableCache.get(db);
  if (cached != null) return cached;
  const exists = tableExists(db, "segment_embeddings") && tableExists(db, "embedding_models");
  segmentEmbeddingTableCache.set(db, exists);
  return exists;
}

function qwenEmbeddingTypesForQuery(
  mode: FootageSearchMode,
  text: string,
  visualInput: VisualInputValidation,
): QwenSearchEmbeddingType[] {
  const types = new Set<QwenSearchEmbeddingType>();
  if ((mode === "hybrid" || mode === "text" || mode === "multimodal") && text) {
    for (const type of QWEN_TEXT_QUERY_EMBEDDING_TYPES) types.add(type);
  }
  if ((mode === "visual" || mode === "multimodal") && visualInput.hasValidVisualQuery) {
    for (const type of QWEN_IMAGE_QUERY_EMBEDDING_TYPES) types.add(type);
  }
  return Array.from(types);
}

function audioEmbeddingTypesForQuery(
  mode: FootageSearchMode,
  text: string,
  audioInput: AudioInputValidation,
): AudioSearchEmbeddingType[] {
  if (mode === "audio" || mode === "hybrid" || mode === "multimodal" || audioInput.hasAudioIntent) {
    if (text || audioInput.hasValidAudioQuery) return [...CLAP_AUDIO_EMBEDDING_TYPES];
  }
  return [];
}

function loadQwenEmbeddingRows(
  db: Database.Database,
  segmentIds: string[],
  embeddingTypes: QwenSearchEmbeddingType[],
  warnings: string[],
): SegmentEmbeddingVectorMap {
  const result: SegmentEmbeddingVectorMap = new Map();
  if (segmentIds.length === 0 || embeddingTypes.length === 0 || !hasSegmentEmbeddingsTables(db)) return result;

  const params: Record<string, unknown> = {
    qwen_model_name: QWEN3VL_MODEL_NAME,
    qwen_output_dimension: QWEN3VL_OUTPUT_DIMENSION,
  };
  const segmentClause = inClause("se.segment_id", "qwen_segment_id", segmentIds, params);
  const typeClause = inClause("se.embedding_type", "qwen_embedding_type", embeddingTypes, params);
  const rows = db.prepare(`
    SELECT
      se.id,
      se.segment_id,
      se.embedding_type,
      se.dimension,
      se.vector,
      se.model_id,
      se.source_ref,
      se.source_timestamp_us,
      em.output_dimension,
      em.normalized
    FROM segment_embeddings se
    JOIN embedding_models em ON em.id = se.model_id
    WHERE em.name = @qwen_model_name
      AND em.output_dimension = @qwen_output_dimension
      AND em.input_modality IN ('multimodal', 'mixed', 'image', 'text')
      AND em.distance_metric = 'cosine'
      AND ${segmentClause}
      AND ${typeClause}
    ORDER BY se.segment_id ASC, se.embedding_type ASC, se.id ASC
  `).all(params) as SegmentEmbeddingDbRow[];

  for (const row of rows) {
    const vector = validatedSegmentEmbeddingVector(row, warnings);
    if (!vector) continue;
    const byType = result.get(row.segment_id) ?? new Map<string, SegmentEmbeddingVectorRow[]>();
    const values = byType.get(row.embedding_type) ?? [];
    values.push({
      id: row.id,
      segment_id: row.segment_id,
      embedding_type: row.embedding_type,
      model_id: row.model_id,
      source_ref: row.source_ref,
      source_timestamp_us: row.source_timestamp_us,
      vector,
    });
    byType.set(row.embedding_type, values);
    result.set(row.segment_id, byType);
  }

  return result;
}

function loadClapEmbeddingRows(
  db: Database.Database,
  segmentIds: string[],
  embeddingTypes: AudioSearchEmbeddingType[],
  warnings: string[],
): SegmentEmbeddingVectorMap {
  const result: SegmentEmbeddingVectorMap = new Map();
  if (segmentIds.length === 0 || embeddingTypes.length === 0 || !hasSegmentEmbeddingsTables(db)) return result;

  const params: Record<string, unknown> = {
    clap_model_name: CLAP_AUDIO_MODEL_NAME,
    clap_output_dimension: CLAP_AUDIO_OUTPUT_DIMENSION,
  };
  const segmentClause = inClause("se.segment_id", "clap_segment_id", segmentIds, params);
  const typeClause = inClause("se.embedding_type", "clap_embedding_type", embeddingTypes, params);
  const rows = db.prepare(`
    SELECT
      se.id,
      se.segment_id,
      se.embedding_type,
      se.dimension,
      se.vector,
      se.model_id,
      se.source_ref,
      se.source_timestamp_us,
      em.output_dimension,
      em.normalized
    FROM segment_embeddings se
    JOIN embedding_models em ON em.id = se.model_id
    WHERE em.name = @clap_model_name
      AND em.output_dimension = @clap_output_dimension
      AND em.input_modality IN ('audio', 'audio_text')
      AND em.distance_metric = 'cosine'
      AND ${segmentClause}
      AND ${typeClause}
    ORDER BY se.segment_id ASC, se.embedding_type ASC, se.id ASC
  `).all(params) as SegmentEmbeddingDbRow[];

  for (const row of rows) {
    const vector = validatedSegmentEmbeddingVector(row, warnings);
    if (!vector) continue;
    const byType = result.get(row.segment_id) ?? new Map<string, SegmentEmbeddingVectorRow[]>();
    const values = byType.get(row.embedding_type) ?? [];
    values.push({
      id: row.id,
      segment_id: row.segment_id,
      embedding_type: row.embedding_type,
      model_id: row.model_id,
      source_ref: row.source_ref,
      source_timestamp_us: row.source_timestamp_us,
      vector,
    });
    byType.set(row.embedding_type, values);
    result.set(row.segment_id, byType);
  }

  return result;
}

function segmentEmbeddingVectorCount(embeddings: SegmentEmbeddingVectorMap): number {
  let count = 0;
  for (const byType of embeddings.values()) {
    for (const rows of byType.values()) count += rows.length;
  }
  return count;
}

async function qwenScoresForRows(args: {
  db: Database.Database;
  rows: DbSearchRow[];
  text: string;
  mode: FootageSearchMode;
  visualInput: VisualInputValidation;
  embeddings: SegmentEmbeddingVectorMap;
  warnings: string[];
}): Promise<QwenScoreResult> {
  const scores = new Map<string, { qwenVisual?: number; qwenText?: number; matches: SearchEmbeddingMatch[] }>();
  const unavailableChannels = new Set<string>();
  let queryChannelAvailable = false;

  const scoreQueryVector = (
    queryVector: Float32Array,
    embeddingTypes: QwenSearchEmbeddingType[],
  ) => {
    for (const row of args.rows) {
      const byType = args.embeddings.get(row.segment_id);
      if (!byType) continue;
      for (const embeddingType of embeddingTypes) {
        const candidates = byType.get(embeddingType) ?? [];
        for (const candidate of candidates) {
          if (candidate.vector.length !== queryVector.length) {
            args.warnings.push(`qwen3vl embedding skipped for ${candidate.segment_id}/${candidate.embedding_type}: query dimension ${queryVector.length} does not match stored dimension ${candidate.vector.length}`);
            continue;
          }
          const score = roundScore(clamp01((cosineSimilarity(queryVector, candidate.vector) + 1) / 2));
          const previous = scores.get(row.segment_id) ?? { matches: [] };
          if (embeddingType === "text_combined_qwen") {
            previous.qwenText = Math.max(previous.qwenText ?? 0, score);
          }
          if (QWEN_VISUAL_EMBEDDING_TYPES.includes(embeddingType)) {
            previous.qwenVisual = Math.max(previous.qwenVisual ?? 0, score);
          }
          previous.matches.push({
            segment_embedding_id: candidate.id,
            embedding_type: embeddingType,
            model_id: candidate.model_id,
            score,
            source_ref: candidate.source_ref || undefined,
            source_timestamp_us: candidate.source_timestamp_us ?? undefined,
          });
          scores.set(row.segment_id, previous);
        }
      }
    }
  };

  if ((args.mode === "hybrid" || args.mode === "text" || args.mode === "multimodal") && args.text) {
    const queryVector = await qwenTextQueryVector(args.text, args.warnings);
    if (queryVector) {
      queryChannelAvailable = true;
      scoreQueryVector(queryVector, QWEN_TEXT_QUERY_EMBEDDING_TYPES);
    } else {
      unavailableChannels.add("qwen_visual");
      unavailableChannels.add("qwen_text");
    }
  }

  if ((args.mode === "visual" || args.mode === "multimodal") && args.visualInput.hasValidVisualQuery) {
    const queryVector = args.visualInput.imageQueryPath
      ? await qwenImageQueryVector(args.visualInput.imageQueryPath, args.warnings)
      : qwenAnchorQueryVector(args.db, args.visualInput.visualAnchor, args.warnings);
    if (queryVector) {
      queryChannelAvailable = true;
      scoreQueryVector(queryVector, QWEN_IMAGE_QUERY_EMBEDDING_TYPES);
    } else {
      unavailableChannels.add("qwen_visual");
    }
  }

  for (const score of scores.values()) {
    score.matches.sort((a, b) => b.score - a.score || a.embedding_type.localeCompare(b.embedding_type));
  }
  if (Array.from(scores.values()).some((score) => score.qwenVisual != null)) {
    unavailableChannels.delete("qwen_visual");
  }
  if (Array.from(scores.values()).some((score) => score.qwenText != null)) {
    unavailableChannels.delete("qwen_text");
  }

  return {
    present: queryChannelAvailable,
    available: scores.size > 0,
    scores,
    unavailableChannels: Array.from(unavailableChannels),
  };
}

async function audioScoresForRows(args: {
  rows: DbSearchRow[];
  text: string;
  mode: FootageSearchMode;
  audioInput: AudioInputValidation;
  embeddings: SegmentEmbeddingVectorMap;
  warnings: string[];
}): Promise<AudioScoreResult> {
  const scores = new Map<string, { audioSimilarity?: number; matches: SearchEmbeddingMatch[] }>();
  const unavailableChannels = new Set<string>();
  let queryChannelAvailable = false;

  const scoreQueryVector = (queryVector: Float32Array) => {
    for (const row of args.rows) {
      const byType = args.embeddings.get(row.segment_id);
      if (!byType) continue;
      for (const embeddingType of CLAP_AUDIO_EMBEDDING_TYPES) {
        const candidates = byType.get(embeddingType) ?? [];
        for (const candidate of candidates) {
          if (candidate.vector.length !== queryVector.length) {
            args.warnings.push(`clap audio embedding skipped for ${candidate.segment_id}/${candidate.embedding_type}: query dimension ${queryVector.length} does not match stored dimension ${candidate.vector.length}`);
            continue;
          }
          const score = roundScore(clamp01((cosineSimilarity(queryVector, candidate.vector) + 1) / 2));
          const previous = scores.get(row.segment_id) ?? { matches: [] };
          previous.audioSimilarity = Math.max(previous.audioSimilarity ?? 0, score);
          previous.matches.push({
            segment_embedding_id: candidate.id,
            embedding_type: candidate.embedding_type,
            model_id: candidate.model_id,
            score,
            source_ref: candidate.source_ref || undefined,
            source_timestamp_us: candidate.source_timestamp_us ?? undefined,
          });
          scores.set(row.segment_id, previous);
        }
      }
    }
  };

  if (args.audioInput.audioQueryPath) {
    const queryVector = await clapAudioQueryVector(args.audioInput.audioQueryPath, args.warnings);
    if (queryVector) {
      queryChannelAvailable = true;
      scoreQueryVector(queryVector);
    } else {
      unavailableChannels.add("audio_similarity");
    }
  } else if ((args.mode === "audio" || args.mode === "hybrid" || args.mode === "multimodal") && args.text) {
    const queryVector = await clapTextQueryVector(args.text, args.warnings);
    if (queryVector) {
      queryChannelAvailable = true;
      scoreQueryVector(queryVector);
    } else {
      unavailableChannels.add("audio_similarity");
    }
  }

  for (const score of scores.values()) {
    score.matches.sort((a, b) => b.score - a.score || a.embedding_type.localeCompare(b.embedding_type));
  }
  if (Array.from(scores.values()).some((score) => score.audioSimilarity != null)) {
    unavailableChannels.delete("audio_similarity");
  }

  return {
    present: queryChannelAvailable,
    available: scores.size > 0,
    scores,
    unavailableChannels: Array.from(unavailableChannels),
  };
}

async function qwenTextQueryVector(text: string, warnings: string[]): Promise<Float32Array | null> {
  const client = await getQwenClient(warnings);
  if (!client) return null;
  try {
    const response = await client.embedText([text], qwenQueryOptions());
    return validQwenQueryVector(response.vectors[0]?.vector, warnings, "text");
  } catch (error) {
    await markQwenClientUnavailable(error, warnings);
    return null;
  }
}

async function qwenImageQueryVector(imagePath: string, warnings: string[]): Promise<Float32Array | null> {
  const client = await getQwenClient(warnings);
  if (!client) return null;
  try {
    const response = await client.embedImage([imagePath], qwenQueryOptions());
    return validQwenQueryVector(response.vectors[0]?.vector, warnings, "image");
  } catch (error) {
    await markQwenClientUnavailable(error, warnings);
    return null;
  }
}

function qwenAnchorQueryVector(
  db: Database.Database,
  anchor: FootageVisualAnchor | undefined,
  warnings: string[],
): Float32Array | null {
  if (!anchor?.segment_id) return null;
  const frameType = anchor.frame_type ?? "visual_representative";
  const rows = loadQwenEmbeddingRows(db, [anchor.segment_id], [frameType], warnings);
  const vector = rows.get(anchor.segment_id)?.get(frameType)?.[0]?.vector;
  if (!vector) {
    warnings.push(`visual_anchor embedding unavailable for ${anchor.segment_id}/${frameType}`);
    return null;
  }
  return vector;
}

async function clapTextQueryVector(text: string, warnings: string[]): Promise<Float32Array | null> {
  const client = await getClapClient(warnings);
  if (!client) return null;
  try {
    const response = await client.embedText([text], clapQueryOptions());
    return validClapQueryVector(response.vectors[0]?.vector, warnings, "text");
  } catch (error) {
    await markClapClientUnavailable(error, warnings);
    return null;
  }
}

async function clapAudioQueryVector(audioPath: string, warnings: string[]): Promise<Float32Array | null> {
  const client = await getClapClient(warnings);
  if (!client) return null;
  try {
    const response = await client.embedAudio([audioPath], clapQueryOptions());
    return validClapQueryVector(response.vectors[0]?.vector, warnings, "audio");
  } catch (error) {
    await markClapClientUnavailable(error, warnings);
    return null;
  }
}

async function getQwenClient(warnings: string[]): Promise<Qwen3VlEmbeddingClient | null> {
  if (qwenClientUnavailable) return null;
  if (!qwenClientPromise) {
    qwenClientPromise = import("../connectors/qwen3vl-embedding-local.js")
      .then((connector) => connector.createQwen3VlEmbeddingLocalClient({ requestTimeoutMs: qwenRequestTimeoutMs() }))
      .catch((error) => {
        qwenClientUnavailable = true;
        warnings.push(`qwen3vl search embedding unavailable: ${error instanceof Error ? error.message : String(error)}`);
        return null;
      });
  }
  return qwenClientPromise;
}

async function getClapClient(warnings: string[]): Promise<ClapAudioEmbeddingClient | null> {
  if (clapClientUnavailable) return null;
  if (!clapClientPromise) {
    clapClientPromise = import("../connectors/clap-audio-local.js")
      .then((connector) => connector.createClapAudioEmbeddingLocalClient({ requestTimeoutMs: clapRequestTimeoutMs() }))
      .catch((error) => {
        clapClientUnavailable = true;
        warnings.push(`clap audio search embedding unavailable: ${error instanceof Error ? error.message : String(error)}`);
        return null;
      });
  }
  return clapClientPromise;
}

async function markQwenClientUnavailable(error: unknown, warnings: string[]): Promise<void> {
  qwenClientUnavailable = true;
  warnings.push(`qwen3vl search embedding unavailable: ${error instanceof Error ? error.message : String(error)}`);
  const promise = qwenClientPromise;
  const client = promise ? await promise.catch(() => null) : null;
  qwenClientPromise = null;
  await Promise.resolve(client?.shutdown()).catch(() => undefined);
}

async function markClapClientUnavailable(error: unknown, warnings: string[]): Promise<void> {
  clapClientUnavailable = true;
  warnings.push(`clap audio search embedding unavailable: ${error instanceof Error ? error.message : String(error)}`);
  const promise = clapClientPromise;
  const client = promise ? await promise.catch(() => null) : null;
  clapClientPromise = null;
  await Promise.resolve(client?.shutdown()).catch(() => undefined);
}

function qwenQueryOptions(): {
  instruction: string;
  outputDimension: number;
  normalize: boolean;
  preprocessVersion: string;
  timeoutMs?: number;
} {
  return {
    instruction: QWEN3VL_INSTRUCTION,
    outputDimension: QWEN3VL_OUTPUT_DIMENSION,
    normalize: true,
    preprocessVersion: QWEN3VL_PREPROCESS_VERSION,
    timeoutMs: qwenRequestTimeoutMs(),
  };
}

function clapQueryOptions(): {
  outputDimension: number;
  normalize: boolean;
  preprocessVersion: string;
  timeoutMs?: number;
} {
  return {
    outputDimension: CLAP_AUDIO_OUTPUT_DIMENSION,
    normalize: true,
    preprocessVersion: CLAP_AUDIO_PREPROCESS_VERSION,
    timeoutMs: clapRequestTimeoutMs(),
  };
}

function qwenRequestTimeoutMs(): number | undefined {
  const value = process.env.VOS_QWEN3VL_REQUEST_TIMEOUT_MS;
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function clapRequestTimeoutMs(): number | undefined {
  const value = process.env.VOS_CLAP_REQUEST_TIMEOUT_MS;
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function validQwenQueryVector(vector: Float32Array | undefined, warnings: string[], kind: "text" | "image"): Float32Array | null {
  if (!vector || vector.length === 0) {
    warnings.push(`qwen3vl ${kind} query embedding unavailable`);
    return null;
  }
  if (vector.length !== QWEN3VL_OUTPUT_DIMENSION) {
    warnings.push(`qwen3vl ${kind} query embedding dimension ${vector.length} does not match expected ${QWEN3VL_OUTPUT_DIMENSION}`);
    return null;
  }
  for (let index = 0; index < vector.length; index += 1) {
    if (!Number.isFinite(vector[index])) {
      warnings.push(`qwen3vl ${kind} query embedding contains non-finite value at index ${index}`);
      return null;
    }
  }
  return vector;
}

function validClapQueryVector(vector: Float32Array | undefined, warnings: string[], kind: "text" | "audio"): Float32Array | null {
  if (!vector || vector.length === 0) {
    warnings.push(`clap audio ${kind} query embedding unavailable`);
    return null;
  }
  if (vector.length !== CLAP_AUDIO_OUTPUT_DIMENSION) {
    warnings.push(`clap audio ${kind} query embedding dimension ${vector.length} does not match expected ${CLAP_AUDIO_OUTPUT_DIMENSION}`);
    return null;
  }
  for (let index = 0; index < vector.length; index += 1) {
    if (!Number.isFinite(vector[index])) {
      warnings.push(`clap audio ${kind} query embedding contains non-finite value at index ${index}`);
      return null;
    }
  }
  return vector;
}

function applyPostFilters(rows: DbSearchRow[], filters: FootageSearchFilters): DbSearchRow[] {
  const includeTags = (filters.include_tags_any ?? []).map((tag) => tag.toLowerCase());
  const customTags = (filters.custom_tags_any ?? []).map((tag) => tag.toLowerCase());
  const excludeFlags = (filters.exclude_quality_flags ?? []).map((flag) => flag.toLowerCase());
  const noiseFlagsExclude = (filters.noise_flags_exclude ?? []).map((flag) => flag.toLowerCase());
  return rows.filter((row) => {
    if (includeTags.length > 0) {
      const tags = [...jsonStrings(row.tags_json), ...jsonStrings(row.asset_tags_json)].map((tag) => tag.toLowerCase());
      if (!includeTags.some((tag) => tags.includes(tag))) return false;
    }
    if (customTags.length > 0) {
      const rowCustomTags = jsonStrings(row.custom_tags_json).map((tag) => tag.toLowerCase());
      if (!customTags.some((tag) => rowCustomTags.includes(tag))) return false;
    }
    if (excludeFlags.length > 0) {
      const flags = [...jsonStrings(row.quality_flags_json), ...jsonStrings(row.asset_quality_flags_json)]
        .map((flag) => flag.toLowerCase());
      if (excludeFlags.some((flag) => flags.includes(flag))) return false;
    }
    if (noiseFlagsExclude.length > 0) {
      const flags = jsonStrings(row.noise_flags_json).map((flag) => flag.toLowerCase());
      if (noiseFlagsExclude.some((flag) => flags.includes(flag))) return false;
    }
    return true;
  });
}

function marlinEventLookup(db: Database.Database, rows: DbSearchRow[]): Map<string, string[]> {
  const lookup = new Map<string, string[]>();
  const stmt = db.prepare(`
    SELECT description
    FROM marlin_events
    WHERE asset_id = @asset_id AND end_us > @src_in_us AND start_us < @src_out_us
    ORDER BY start_us ASC, end_us ASC, event_id ASC
  `);
  for (const row of rows) {
    const events = stmt.all({
      asset_id: row.asset_id,
      src_in_us: row.src_in_us,
      src_out_us: row.src_out_us,
    }) as Array<{ description: string }>;
    lookup.set(row.segment_id, events.map((event) => event.description).filter(Boolean));
  }
  return lookup;
}

function rowToResult(
  row: DbSearchRow,
  scoring: {
    semantic?: number;
    lexical?: number;
    qwenText?: number;
    qwenVisual?: number;
    audioSimilarity?: number;
    structured?: number;
    quality: number;
    peak: number;
    duration: number;
    final: number;
    weights: Record<string, number>;
    unavailableChannels: string[];
    embeddingMatches: SearchEmbeddingMatch[];
    marlinEvents: string[];
    contextExpansions: string[];
    query: SearchFootageInput;
  },
): FootageSearchResult {
  const quality = qualityValues(row);
  const tags = jsonStrings(row.tags_json);
  const qualityFlags = jsonStrings(row.quality_flags_json);
  const evidence = evidenceRefs(row, scoring, tags, qualityFlags);
  const reasonParts: string[] = [];
  if (scoring.semantic != null) reasonParts.push(`semantic match "${scoring.query.semantic ?? scoring.query.query}" against combined text`);
  if (scoring.lexical != null) reasonParts.push(`FTS lexical match score=${scoring.lexical.toFixed(3)}`);
  if (scoring.qwenVisual != null) reasonParts.push(`Qwen visual match score=${scoring.qwenVisual.toFixed(3)}`);
  if (scoring.qwenText != null) reasonParts.push(`Qwen text match score=${scoring.qwenText.toFixed(3)}`);
  if (scoring.audioSimilarity != null) reasonParts.push(`CLAP audio match score=${scoring.audioSimilarity.toFixed(3)}`);
  for (const [field, value] of Object.entries(quality)) {
    if (value != null) reasonParts.push(`${field}=${value.toFixed(2)}`);
  }
  if (tags.length > 0) reasonParts.push(`tags: ${tags.slice(0, 4).join(",")}`);
  const metadata = resultMetadata(row);
  if (metadata.camera_motion) reasonParts.push(`camera_motion=${metadata.camera_motion}`);
  if (metadata.shot_scale) reasonParts.push(`shot_scale=${metadata.shot_scale}`);
  if (metadata.usability) reasonParts.push(`usability=${metadata.usability}`);
  if (scoring.contextExpansions.length > 0) reasonParts.push(`context expansions: ${scoring.contextExpansions.join(",")}`);
  const matchedFrame = scoring.embeddingMatches.find((match) => match.embedding_type.startsWith("visual_") && match.source_ref)?.source_ref;

  return {
    segment_id: row.segment_id,
    asset_id: row.asset_id,
    src_in_us: row.src_in_us,
    src_out_us: row.src_out_us,
    duration_us: row.duration_us,
    score: scoring.final,
    scores: {
      semantic: scoring.semantic,
      e5_text: scoring.semantic,
      lexical: scoring.lexical,
      qwen_text: scoring.qwenText,
      qwen_visual: scoring.qwenVisual,
      audio_similarity: scoring.audioSimilarity,
      clap_audio: scoring.audioSimilarity,
      structured: scoring.structured,
      quality: scoring.quality,
      peak: scoring.peak,
      duration: scoring.duration,
      final: scoring.final,
      weights: scoring.weights,
      embedding_matches: scoring.embeddingMatches.length > 0 ? scoring.embeddingMatches : undefined,
      unavailable_channels: scoring.unavailableChannels.length > 0 ? scoring.unavailableChannels : undefined,
    },
    match_reason: reasonParts.join("; ") || "structured filters matched deterministic footage fields",
    summary: row.summary,
    key_frame_path: matchedFrame ?? row.frame_path ?? row.filmstrip_path ?? undefined,
    tags,
    quality_flags: qualityFlags,
    transcript_excerpt: row.transcript_text || row.transcript_excerpt || undefined,
    marlin_events: scoring.marlinEvents.length > 0 ? scoring.marlinEvents : undefined,
    quality,
    place_hint: row.place_hint_name || row.place_hint_category ? {
      name: row.place_hint_name,
      category: row.place_hint_category ?? undefined,
      confidence: row.place_hint_confidence ?? undefined,
    } : undefined,
    extracted_text: parsedExtractedText(row.extracted_text_json),
    peak: row.peak_timestamp_us != null ? {
      timestamp_us: row.peak_timestamp_us,
      type: row.peak_type ?? undefined,
      confidence: row.peak_confidence ?? undefined,
      description: row.peak_description ?? undefined,
    } : undefined,
    metadata,
    evidence_refs: evidence,
  };
}

function evidenceRefs(
  row: DbSearchRow,
  scoring: {
    semantic?: number;
    lexical?: number;
    quality: number;
    peak: number;
    marlinEvents: string[];
    contextExpansions: string[];
  },
  tags: string[],
  qualityFlags: string[],
): FootageEvidenceRef[] {
  const refs: FootageEvidenceRef[] = [];
  if (row.summary) refs.push({ field: "summary", value: row.summary, score: scoring.semantic ?? scoring.lexical });
  if (row.transcript_text || row.transcript_excerpt) {
    refs.push({ field: "transcript", value: row.transcript_text || row.transcript_excerpt, score: scoring.lexical });
  }
  for (const event of scoring.marlinEvents.slice(0, 3)) refs.push({ field: "marlin_event", value: event });
  for (const tag of tags.slice(0, 6)) refs.push({ field: "tag", value: tag });
  for (const flag of qualityFlags.slice(0, 6)) refs.push({ field: "quality_flag", value: flag });
  for (const [field, value] of Object.entries(qualityValues(row))) {
    if (value != null) refs.push({ field: "quality_score", value: `${field}=${value.toFixed(2)}`, score: value });
  }
  if (row.extracted_text_flat) refs.push({ field: "ocr", value: row.extracted_text_flat });
  if (row.place_hint_name || row.place_hint_category) {
    refs.push({ field: "place_hint", value: [row.place_hint_name, row.place_hint_category].filter(Boolean).join(" ") });
  }
  if (row.aesthetic_notes_flat) refs.push({ field: "aesthetic_note", value: row.aesthetic_notes_flat });
  if (row.peak_description) refs.push({ field: "peak", value: row.peak_description, score: row.peak_confidence ?? undefined });
  for (const term of scoring.contextExpansions) refs.push({ field: "context_expansion", value: term });
  return refs;
}

function finalScore(scores: {
  semantic?: number;
  lexical?: number;
  qwenVisual?: number;
  qwenText?: number;
  audioSimilarity?: number;
  quality: number;
  peak: number;
  duration: number;
  qwenPresent: boolean;
  audioPresent: boolean;
  qwenMode: QwenFusionMode;
  audioMode: "hybrid" | "audio";
}): ScoreFusionResult {
  if (scores.audioPresent) {
    if (scores.audioMode === "audio") {
      return qwenWeightedScore(
        {
          audio_similarity: 0.60,
          e5_text: 0.15,
          lexical: 0.10,
          quality: 0.10,
          peak: 0.05,
        },
        {
          audio_similarity: scores.audioSimilarity,
          e5_text: scores.semantic,
          lexical: scores.lexical,
          quality: scores.quality,
          peak: scores.peak,
        },
        ["audio_similarity", "e5_text", "lexical"],
        scores,
      );
    }

    return qwenWeightedScore(
      {
        e5_text: 0.25,
        qwen_visual: 0.20,
        qwen_text: 0.08,
        audio_similarity: 0.10,
        lexical: 0.20,
        quality: 0.10,
        peak: 0.05,
        duration: 0.02,
      },
      {
        e5_text: scores.semantic,
        qwen_visual: scores.qwenVisual,
        qwen_text: scores.qwenText,
        audio_similarity: scores.audioSimilarity,
        lexical: scores.lexical,
        quality: scores.quality,
        peak: scores.peak,
        duration: scores.duration,
      },
      ["e5_text", "qwen_visual", "qwen_text", "audio_similarity", "lexical"],
      scores,
    );
  }

  if (!scores.qwenPresent) {
    return legacyScore(scores);
  }

  if (scores.qwenMode === "image") {
    return qwenWeightedScore(
      {
        qwen_visual: 0.80,
        quality: 0.12,
        peak: 0.05,
        duration: 0.03,
      },
      {
        qwen_visual: scores.qwenVisual,
        quality: scores.quality,
        peak: scores.peak,
        duration: scores.duration,
      },
      ["qwen_visual"],
      scores,
    );
  }

  if (scores.qwenMode === "mixed") {
    return qwenWeightedScore(
      {
        qwen_visual: 0.55,
        e5_text: 0.15,
        lexical: 0.15,
        quality: 0.10,
        peak: 0.05,
      },
      {
        qwen_visual: scores.qwenVisual,
        e5_text: scores.semantic,
        lexical: scores.lexical,
        quality: scores.quality,
        peak: scores.peak,
      },
      ["qwen_visual", "e5_text", "lexical"],
      scores,
    );
  }

  return qwenWeightedScore(
    {
      qwen_visual: 0.35,
      qwen_text: 0.10,
      e5_text: 0.25,
      lexical: 0.15,
      quality: 0.10,
      peak: 0.05,
    },
    {
      qwen_visual: scores.qwenVisual,
      qwen_text: scores.qwenText,
      e5_text: scores.semantic,
      lexical: scores.lexical,
      quality: scores.quality,
      peak: scores.peak,
    },
    ["qwen_visual", "qwen_text", "e5_text", "lexical"],
    scores,
  );
}

function qwenFusionMode(mode: FootageSearchMode, text: string, visualInput: VisualInputValidation): QwenFusionMode {
  if ((mode === "visual" || mode === "multimodal") && visualInput.hasValidVisualQuery) {
    return text ? "mixed" : "image";
  }
  return "text";
}

function legacyScore(scores: {
  semantic?: number;
  lexical?: number;
  quality: number;
  peak: number;
  duration: number;
}): ScoreFusionResult {
  if (scores.semantic != null && scores.lexical != null) {
    const weights = { semantic: 0.55, lexical: 0.30, quality: 0.10, peak: 0.05 };
    return {
      final: roundScore(0.55 * scores.semantic + 0.30 * scores.lexical + 0.10 * scores.quality + 0.05 * scores.peak),
      weights,
      unavailableChannels: [],
    };
  }
  if (scores.semantic != null && scores.lexical == null) {
    const weights = { semantic: 0.80, quality: 0.15, peak: 0.05 };
    return {
      final: roundScore(0.80 * scores.semantic + 0.15 * scores.quality + 0.05 * scores.peak),
      weights,
      unavailableChannels: ["lexical"],
    };
  }
  if (scores.semantic == null && scores.lexical != null) {
    const weights = { lexical: 0.75, quality: 0.20, peak: 0.05 };
    return {
      final: roundScore(0.75 * scores.lexical + 0.20 * scores.quality + 0.05 * scores.peak),
      weights,
      unavailableChannels: ["semantic"],
    };
  }
  const weights = { quality: 0.70, peak: 0.20, duration: 0.10 };
  return {
    final: roundScore(0.70 * scores.quality + 0.20 * scores.peak + 0.10 * scores.duration),
    weights,
    unavailableChannels: ["semantic", "lexical"],
  };
}

function qwenWeightedScore(
  baseWeights: Record<string, number>,
  channelScores: Record<string, number | undefined>,
  retrievalChannels: string[],
  scores: {
    semantic?: number;
    lexical?: number;
    quality: number;
    peak: number;
    duration: number;
  },
): ScoreFusionResult {
  const retrievalSet = new Set(retrievalChannels);
  const unavailableChannels = Object.keys(baseWeights).filter((channel) => channelScores[channel] == null);
  const availableRetrieval = retrievalChannels.filter((channel) => channelScores[channel] != null && baseWeights[channel] != null);
  const missingRetrievalWeight = retrievalChannels
    .filter((channel) => channelScores[channel] == null)
    .reduce((sum, channel) => sum + (baseWeights[channel] ?? 0), 0);
  const availableRetrievalWeight = availableRetrieval.reduce((sum, channel) => sum + (baseWeights[channel] ?? 0), 0);
  if (availableRetrievalWeight <= 0) return legacyScore(scores);

  const weights: Record<string, number> = {};
  let final = 0;
  for (const [channel, baseWeight] of Object.entries(baseWeights)) {
    if (channelScores[channel] == null) continue;
    const weight = retrievalSet.has(channel)
      ? baseWeight + (missingRetrievalWeight * baseWeight / availableRetrievalWeight)
      : baseWeight;
    weights[channel] = roundScore(weight);
    final += weight * (channelScores[channel] ?? 0);
  }
  return {
    final: roundScore(final),
    weights,
    unavailableChannels,
  };
}

function qualityScore(row: DbSearchRow): number {
  const values = Object.values(qualityValues(row)).filter((value): value is number => typeof value === "number");
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function qualityValues(row: DbSearchRow): Partial<Record<FootageQualityField, number>> {
  return {
    light_quality: row.light_quality ?? undefined,
    subject_prominence: row.subject_prominence ?? undefined,
    emotional_expression: row.emotional_expression ?? undefined,
    composition_score: row.composition_score ?? undefined,
    motion_quality: row.motion_quality ?? undefined,
  };
}

function peakScore(row: DbSearchRow): number {
  return Math.max(row.peak_confidence ?? 0, row.fused_peak_score ?? 0);
}

function sortResults(
  results: FootageSearchResult[],
  rows: DbSearchRow[],
  sortBy: FootageSortBy,
): FootageSearchResult[] {
  const rowById = new Map(rows.map((row) => [row.segment_id, row]));
  return [...results].sort((a, b) => {
    const rowA = rowById.get(a.segment_id);
    const rowB = rowById.get(b.segment_id);
    if (sortBy === "quality") {
      const diff = (b.scores.quality ?? 0) - (a.scores.quality ?? 0);
      if (diff !== 0) return diff;
    } else if (sortBy === "chronological") {
      const diff = (rowA?.source_order ?? 0) - (rowB?.source_order ?? 0) || a.src_in_us - b.src_in_us;
      if (diff !== 0) return diff;
    } else if (sortBy === "duration") {
      const diff = b.duration_us - a.duration_us;
      if (diff !== 0) return diff;
    }
    return (
      b.score - a.score ||
      (rowB?.composition_score ?? -1) - (rowA?.composition_score ?? -1) ||
      (rowB?.light_quality ?? -1) - (rowA?.light_quality ?? -1) ||
      b.duration_us - a.duration_us ||
      (rowA?.source_order ?? 0) - (rowB?.source_order ?? 0) ||
      a.src_in_us - b.src_in_us ||
      a.segment_id.localeCompare(b.segment_id)
    );
  });
}

function fallbackSearch(
  projectDir: string,
  input: SearchFootageInput,
  mode: FootageSearchMode,
  limit: number,
  warnings: string[],
): FootageSearchResponse {
  const assets = readArrayFromFile(path.join(projectDir, "03_analysis/assets.json"), "items", "assets");
  const segments = readArrayFromFile(path.join(projectDir, "03_analysis/segments.json"), "items", "segments");
  const assetById = new Map(assets.map((asset, index) => [stringValue(asset.asset_id), { asset, index }]));
  const text = normalizeSearchText(input.text_match ?? input.query).toLowerCase();
  const filters = input.filters ?? {};
  const unsupportedMetadataFilters = requestedMetadataFilters(filters);
  let rows = segments.flatMap((segment, index): DbSearchRow[] => {
    const assetId = stringValue(segment.asset_id);
    const asset = assetById.get(assetId);
    const srcInUs = nonNegativeInteger(segment.src_in_us ?? segment.start_us);
    const srcOutUs = nonNegativeInteger(segment.src_out_us ?? segment.end_us);
    if (!asset || srcInUs == null || srcOutUs == null || srcOutUs <= srcInUs) return [];
    return [fallbackRow(segment, asset.asset, asset.index, srcInUs, srcOutUs, index)];
  });
  if (unsupportedMetadataFilters.length > 0) {
    warnings.push(`metadata filters require footage.db metadata tables; JSON fallback cannot evaluate: ${unsupportedMetadataFilters.join(", ")}`);
    rows = [];
  } else {
    rows = rows.filter((row) => fallbackFilter(row, filters));
  }
  if (mode !== "structured" && text) {
    rows = rows.filter((row) => fallbackText(row).toLowerCase().includes(text));
  }
  if ((mode === "visual" || mode === "multimodal") && !text) {
    warnings.push("visual search unavailable in JSON fallback; build footage.db with Qwen embeddings or provide a text query");
    rows = [];
  }
  if (mode === "audio") {
    warnings.push("audio search unavailable in JSON fallback; build footage.db with CLAP audio embeddings");
    rows = [];
  }
  rows = applyPostFilters(rows, filters);
  const durationScores = normalizeDurationScores(rows);
  const results = rows.map((row) => {
    const quality = qualityScore(row);
    const peak = peakScore(row);
    const lexical = text ? 1 : undefined;
    const fusion = finalScore({
      lexical,
      quality,
      peak,
      duration: durationScores.get(row.segment_id) ?? 0,
      qwenPresent: false,
      audioPresent: false,
      qwenMode: "text",
      audioMode: "hybrid",
    });
    return rowToResult(row, {
      lexical,
      quality,
      peak,
      duration: durationScores.get(row.segment_id) ?? 0,
      final: fusion.final,
      weights: fusion.weights,
      unavailableChannels: fusion.unavailableChannels,
      embeddingMatches: [],
      marlinEvents: [],
      contextExpansions: [],
      query: input,
    });
  });
  return {
    query: input,
    db_path: footageDbPath(projectDir),
    db_status: "fallback",
    mode_used: mode === "semantic" ? "text" : mode,
    results: sortResults(results, rows, input.sort_by ?? "relevance").slice(0, limit),
    warnings: Array.from(new Set(warnings)),
  };
}

function fallbackFilter(row: DbSearchRow, filters: FootageSearchFilters): boolean {
  if (filters.shooting_date && row.shooting_date !== filters.shooting_date) return false;
  if (filters.shooting_time_start && (!row.shooting_time || row.shooting_time < filters.shooting_time_start)) return false;
  if (filters.shooting_time_end && (!row.shooting_time || row.shooting_time > filters.shooting_time_end)) return false;
  if (filters.camera_type && row.camera_type !== filters.camera_type) return false;
  if (filters.place_hint_name && row.place_hint_name !== filters.place_hint_name) return false;
  if (filters.place_hint_category && row.place_hint_category !== filters.place_hint_category) return false;
  if (filters.asset_ids && filters.asset_ids.length > 0 && !filters.asset_ids.includes(row.asset_id)) return false;
  if (filters.segment_type && fallbackSegmentType(row) !== filters.segment_type) return false;
  if (filters.min_duration_us != null && row.duration_us < filters.min_duration_us) return false;
  if (filters.max_duration_us != null && row.duration_us > filters.max_duration_us) return false;
  if (filters.exclude_segment_ids?.includes(row.segment_id)) return false;
  if (filters.has_text === true && !fallbackHasText(row)) return false;
  if (filters.has_text === false && fallbackHasText(row)) return false;
  if (filters.has_dialogue === true && !fallbackHasDialogue(row)) return false;
  if (filters.has_dialogue === false && fallbackHasDialogue(row)) return false;
  for (const field of QUALITY_FIELDS) {
    const min = filters.quality_min?.[field];
    if (typeof min === "number" && ((row[field] ?? -Infinity) < min)) return false;
  }
  return true;
}

function fallbackRow(
  segment: Record<string, unknown>,
  asset: Record<string, unknown>,
  sourceOrder: number,
  srcInUs: number,
  srcOutUs: number,
  index: number,
): DbSearchRow {
  const quality = recordValue(recordValue(segment.visual_quality).scores);
  const appraisal = recordValue(segment.visual_appraisal);
  const placeHint = recordValue(appraisal.place_hint);
  const transcriptText = stringValue(segment.transcript_excerpt);
  const extractedText = extractedTextFlat(appraisal.extracted_text);
  return {
    segment_id: stringValue(segment.segment_id) || `SEG_${index + 1}`,
    asset_id: stringValue(segment.asset_id),
    src_in_us: srcInUs,
    src_out_us: srcOutUs,
    duration_us: srcOutUs - srcInUs,
    segment_type: nullableString(segment.segment_type),
    summary: stringValue(segment.summary),
    transcript_excerpt: transcriptText,
    transcript_text: transcriptText,
    tags_json: JSON.stringify([...arrayStrings(segment.tags), ...arrayStrings(segment.visual_tags)]),
    quality_flags_json: JSON.stringify(arrayStrings(segment.quality_flags)),
    asset_tags_json: JSON.stringify(arrayStrings(asset.tags)),
    asset_quality_flags_json: JSON.stringify(arrayStrings(asset.quality_flags)),
    filmstrip_path: nullableString(segment.filmstrip_path),
    source_order: sourceOrder,
    shooting_date: nullableString(asset.shooting_date),
    shooting_time: nullableString(asset.shooting_time),
    camera_type: nullableString(asset.camera_type),
    light_quality: scoreOrNull(quality.light_quality),
    subject_prominence: scoreOrNull(quality.subject_prominence),
    emotional_expression: scoreOrNull(quality.emotional_expression),
    composition_score: scoreOrNull(quality.composition_score),
    motion_quality: scoreOrNull(quality.motion_quality),
    frame_path: nullableString(appraisal.frame_path),
    extracted_text_json: JSON.stringify(appraisal.extracted_text ?? []),
    extracted_text_flat: extractedText,
    place_hint_name: nullableString(placeHint.name),
    place_hint_category: nullableString(placeHint.category),
    place_hint_confidence: scoreOrNull(placeHint.confidence),
    aesthetic_notes_flat: arrayStrings(appraisal.aesthetic_notes).join(" "),
    has_dialogue: transcriptText ? 1 : 0,
    fused_peak_score: null,
    peak_timestamp_us: null,
    peak_type: null,
    peak_confidence: null,
    peak_description: null,
    camera_motion: null,
    camera_motion_type: null,
    camera_motion_direction: null,
    shot_scale: null,
    stability: null,
    camera_stability: null,
    audio_role: null,
    has_music: null,
    has_ambient: null,
    peak_dbfs: null,
    integrated_lufs: null,
    silence_ratio: null,
    noise_flags_json: "[]",
    scene_number: null,
    shot_number: null,
    take_number: null,
    circle_take: null,
    best_take: null,
    custom_tags_json: "[]",
    logging_confidence: null,
    audio_confidence: null,
    visual_motion_confidence: null,
    visual_scale_confidence: null,
    dominant_subject_position: null,
    usability: null,
  };
}

function fallbackText(row: DbSearchRow): string {
  return [row.summary, row.transcript_excerpt, ...jsonStrings(row.tags_json), ...jsonStrings(row.asset_tags_json)].join(" ");
}

function fallbackSegmentType(row: DbSearchRow): string | null {
  return row.segment_type;
}

function fallbackHasText(row: DbSearchRow): boolean {
  return Boolean(row.extracted_text_flat.trim() || row.transcript_text.trim() || row.transcript_excerpt.trim());
}

function fallbackHasDialogue(row: DbSearchRow): boolean {
  return row.has_dialogue === 1 || row.segment_type === "dialogue";
}

function resultMetadata(row: DbSearchRow): NonNullable<FootageSearchResult["metadata"]> {
  const metadata: NonNullable<FootageSearchResult["metadata"]> = {};
  if (row.camera_motion) metadata.camera_motion = row.camera_motion;
  if (row.camera_motion_type) metadata.camera_motion_type = row.camera_motion_type;
  if (row.camera_motion_direction) metadata.camera_motion_direction = row.camera_motion_direction;
  if (row.shot_scale) metadata.shot_scale = row.shot_scale;
  if (row.stability) metadata.stability = row.stability;
  if (row.camera_stability) metadata.camera_stability = row.camera_stability;
  if (row.audio_role) metadata.audio_role = row.audio_role;
  if (row.scene_number) metadata.scene_number = row.scene_number;
  if (row.shot_number) metadata.shot_number = row.shot_number;
  if (row.take_number) metadata.take_number = row.take_number;
  if (row.circle_take != null) metadata.circle_take = row.circle_take === 1;
  if (row.dominant_subject_position) metadata.dominant_subject_position = row.dominant_subject_position;
  if (row.usability) metadata.usability = row.usability;
  metadata.has_dialogue = fallbackHasDialogue(row);
  return metadata;
}

async function segmentTextForSimilarity(projectDir: string, segmentId: string): Promise<string> {
  const status = readFootageDbStatus(projectDir);
  if (status.exists && status.status !== "malformed") {
    const db = new Database(footageDbPath(projectDir), { readonly: true, fileMustExist: true });
    try {
      const row = db.prepare(`
        SELECT s.summary, COALESCE(st.text, s.transcript_excerpt, '') AS transcript
        FROM segments s
        LEFT JOIN segment_transcripts st ON st.segment_id = s.segment_id
        WHERE s.segment_id = ?
      `).get(segmentId) as { summary?: string; transcript?: string } | undefined;
      if (row) return [row.summary, row.transcript].filter(Boolean).join(" ");
    } finally {
      db.close();
    }
  }
  const segments = readArrayFromFile(path.join(projectDir, "03_analysis/segments.json"), "items", "segments");
  const segment = segments.find((item) => stringValue(item.segment_id) === segmentId);
  return [stringValue(segment?.summary), stringValue(segment?.transcript_excerpt)].filter(Boolean).join(" ");
}

function metadataAvailability(db: Database.Database): MetadataAvailability {
  return {
    assetTechnical: tableExists(db, "asset_technical_metadata"),
    visualProfile: tableExists(db, "segment_visual_profile"),
    audioProfile: tableExists(db, "segment_audio_profile"),
    logging: tableExists(db, "segment_logging_profile"),
    usability: tableExists(db, "segment_usability_profile"),
    metadataFts: tableExists(db, "segment_metadata_fts"),
  };
}

function metadataJoinSql(metadata: MetadataAvailability): string {
  return [
    metadata.assetTechnical ? "LEFT JOIN asset_technical_metadata atm ON atm.asset_id = a.asset_id" : "",
    metadata.visualProfile ? "LEFT JOIN segment_visual_profile svp ON svp.segment_id = s.segment_id" : "",
    metadata.audioProfile ? "LEFT JOIN segment_audio_profile sap ON sap.segment_id = s.segment_id" : "",
    metadata.logging ? "LEFT JOIN segment_logging_profile slp ON slp.segment_id = s.segment_id" : "",
    metadata.usability ? "LEFT JOIN segment_usability_profile sup ON sup.segment_id = s.segment_id" : "",
  ].filter(Boolean).join("\n");
}

function tableExists(db: Database.Database, tableName: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type IN ('table', 'view') AND name = ? LIMIT 1").get(tableName));
}

function requestedMetadataFilters(filters: FootageSearchFilters): string[] {
  const names: string[] = [];
  if (filters.video_codec) names.push("video_codec");
  if (filters.recording_format) names.push("recording_format");
  if (filters.frame_rate_mode) names.push("frame_rate_mode");
  if (filters.min_width != null) names.push("min_width");
  if (filters.min_height != null) names.push("min_height");
  if (filters.camera_motion) names.push("camera_motion");
  if (filters.camera_motion_type) names.push("camera_motion_type");
  if (filters.camera_motion_direction) names.push("camera_motion_direction");
  if (filters.shot_scale) names.push("shot_scale");
  if (filters.stability) names.push("stability");
  if (filters.camera_stability) names.push("camera_stability");
  if (filters.audio_role) names.push("audio_role");
  if (filters.has_music != null) names.push("has_music");
  if (filters.has_ambient != null) names.push("has_ambient");
  if (filters.scene_number) names.push("scene_number");
  if (filters.shot_number) names.push("shot_number");
  if (filters.take_number) names.push("take_number");
  if (filters.circle_take != null) names.push("circle_take");
  if (filters.best_take != null) names.push("best_take");
  if (filters.usability) names.push("usability");
  if (filters.custom_tags_any?.length) names.push("custom_tags_any");
  if (filters.noise_flags_exclude?.length) names.push("noise_flags_exclude");
  return names;
}

function appendMissingIndexedDataWarnings(
  db: Database.Database,
  filters: FootageSearchFilters,
  metadata: MetadataAvailability,
  warnings: string[],
): void {
  if (filters.shooting_date && !db.prepare("SELECT 1 FROM assets WHERE shooting_date IS NOT NULL LIMIT 1").get()) {
    warnings.push("shooting_date filter requested, but no shooting_date values are indexed");
  }
  if ((filters.shooting_time_start || filters.shooting_time_end) && !db.prepare("SELECT 1 FROM assets WHERE shooting_time IS NOT NULL LIMIT 1").get()) {
    warnings.push("shooting_time filter requested, but no shooting_time values are indexed");
  }
  if (filters.camera_type && !db.prepare("SELECT 1 FROM assets WHERE camera_type IS NOT NULL LIMIT 1").get()) {
    warnings.push("camera_type filter requested, but no camera_type values are indexed");
  }
  if ((filters.place_hint_name || filters.place_hint_category) && !db.prepare("SELECT 1 FROM visual_appraisal WHERE place_hint_name IS NOT NULL OR place_hint_category IS NOT NULL LIMIT 1").get()) {
    warnings.push("place_hint filter requested, but no place_hint values are indexed");
  }
  const visualFilterRequested = Boolean(filters.camera_motion || filters.camera_motion_type || filters.camera_motion_direction || filters.shot_scale || filters.stability || filters.camera_stability);
  const audioFilterRequested = Boolean(filters.audio_role || filters.has_music != null || filters.has_ambient != null || filters.peak_dbfs_max != null || filters.integrated_lufs_min != null || filters.integrated_lufs_max != null || filters.silence_ratio_min != null || filters.silence_ratio_max != null || filters.noise_flags_exclude?.length);
  const loggingFilterRequested = Boolean(filters.scene_number || filters.shot_number || filters.take_number || filters.circle_take != null || filters.best_take != null || filters.custom_tags_any?.length);
  const technicalFilterRequested = Boolean(filters.video_codec || filters.recording_format || filters.frame_rate_mode || filters.min_width != null || filters.min_height != null || filters.color_primaries || filters.color_transfer || filters.reel_name || filters.card_id || filters.camera_id);
  if (technicalFilterRequested && !metadata.assetTechnical) {
    warnings.push("technical metadata filter requested, but asset_technical_metadata is missing in this footage DB");
  } else if (technicalFilterRequested && !db.prepare("SELECT 1 FROM asset_technical_metadata LIMIT 1").get()) {
    warnings.push("technical metadata filter requested, but no asset_technical_metadata rows are indexed");
  }
  if (visualFilterRequested && !metadata.visualProfile) {
    warnings.push("visual metadata filter requested, but segment_visual_profile is missing in this footage DB");
  } else if (visualFilterRequested && !db.prepare("SELECT 1 FROM segment_visual_profile LIMIT 1").get()) {
    warnings.push("visual metadata filter requested, but no segment_visual_profile rows are indexed");
  }
  if (audioFilterRequested && !metadata.audioProfile) {
    warnings.push("audio metadata filter requested, but segment_audio_profile is missing in this footage DB");
  } else if (audioFilterRequested && !db.prepare("SELECT 1 FROM segment_audio_profile LIMIT 1").get()) {
    warnings.push("audio metadata filter requested, but no segment_audio_profile rows are indexed");
  }
  if (loggingFilterRequested && !metadata.logging) {
    warnings.push("logging metadata filter requested, but segment_logging_profile is missing in this footage DB");
  } else if (loggingFilterRequested && !db.prepare("SELECT 1 FROM segment_logging_profile LIMIT 1").get()) {
    warnings.push("logging metadata filter requested, but no segment_logging_profile rows are indexed");
  }
  if (filters.usability && !metadata.usability) {
    warnings.push("usability filter requested, but segment_usability_profile is missing in this footage DB");
  } else if (filters.usability && !db.prepare("SELECT 1 FROM segment_usability_profile LIMIT 1").get()) {
    warnings.push("usability filter requested, but no segment_usability_profile rows are indexed");
  }
}

function contextTermsForQuery(query: string, context?: FootageSearchContext): string[] {
  if (!context) return [];
  const queryLower = query.toLowerCase();
  const terms: string[] = [];
  const maybeAdd = (name: string, aliases?: string[]) => {
    const options = [name, ...(aliases ?? [])].map((item) => item.trim()).filter(Boolean);
    if (options.some((item) => queryLower.includes(item.toLowerCase()))) terms.push(...options);
  };
  for (const item of context.terminology ?? []) maybeAdd(item.term, item.aliases);
  for (const item of context.locations ?? []) maybeAdd(item.name, item.aliases);
  for (const item of context.subjects ?? []) maybeAdd(item.name, item.aliases);
  return Array.from(new Set(terms));
}

function booleanFtsExpression(text: string): string {
  return text.split(/\s+/).map((token) => {
    if (token === "AND" || token === "OR" || token === "NOT") return token;
    return groupedPhraseClauses(token);
  }).filter(Boolean).join(" ");
}

function naturalFtsExpression(text: string): string {
  const tokens = text.split(/\s+/).map(groupedPhraseClauses).filter(Boolean);
  return tokens.join(" AND ");
}

function groupedPhraseClauses(text: string): string {
  const clauses = expandedPhraseClauses(text);
  if (clauses.length === 0) return "";
  return clauses.length === 1 ? clauses[0] : `(${clauses.join(" OR ")})`;
}

function expandedPhraseClauses(text: string): string[] {
  const phrases = [text, ...cjkSearchExpansions(text)];
  return Array.from(new Set(phrases.map(quoteFtsPhrase).filter(Boolean)));
}

function quoteFtsPhrase(text: string): string {
  const cleaned = normalizeSearchText(text).replace(/"/g, "\"\"");
  return cleaned ? `"${cleaned}"` : "";
}

function addStringFilter(
  clauses: string[],
  params: Record<string, unknown>,
  available: boolean,
  column: string,
  key: string,
  value: string | undefined,
): void {
  if (!value) return;
  if (!available) {
    clauses.push("0 = 1");
    return;
  }
  clauses.push(`${column} = @${key}`);
  params[key] = value;
}

function addStringArrayFilter(
  clauses: string[],
  params: Record<string, unknown>,
  available: boolean,
  column: string,
  key: string,
  value: string | string[] | undefined,
): void {
  const values = Array.isArray(value) ? value.filter(Boolean) : value ? [value] : [];
  if (values.length === 0) return;
  if (!available) {
    clauses.push("0 = 1");
    return;
  }
  clauses.push(inClause(column, key, values, params));
}

function addBooleanFilter(
  clauses: string[],
  params: Record<string, unknown>,
  available: boolean,
  column: string,
  key: string,
  value: boolean,
): void {
  if (!available) {
    clauses.push("0 = 1");
    return;
  }
  clauses.push(`${column} = @${key}`);
  params[key] = value ? 1 : 0;
}

function addRangeFilter(
  clauses: string[],
  params: Record<string, unknown>,
  available: boolean,
  column: string,
  key: string,
  operator: ">=" | "<=",
  value: number,
): void {
  if (!available) {
    clauses.push("0 = 1");
    return;
  }
  clauses.push(`${column} ${operator} @${key}`);
  params[key] = value;
}

function inClause(
  column: string,
  prefix: string,
  values: string[],
  params: Record<string, unknown>,
): string {
  const placeholders = values.map((value, index) => {
    const key = `${prefix}_${index}`;
    params[key] = value;
    return `@${key}`;
  });
  return `${column} IN (${placeholders.join(", ")})`;
}

function normalizeRankScores(rankMap: Map<string, number>): Map<string, number> {
  if (rankMap.size === 0) return new Map();
  const entries = Array.from(rankMap.entries());
  const ranks = entries.map(([, rank]) => rank);
  const min = Math.min(...ranks);
  const max = Math.max(...ranks);
  return new Map(entries.map(([id, rank]) => [id, max === min ? 1 : (max - rank) / (max - min)]));
}

function normalizeCosineScores(scores: Map<string, number>): Map<string, number> {
  return new Map(Array.from(scores.entries()).map(([id, score]) => [id, clamp01((score + 1) / 2)]));
}

function normalizeDurationScores(rows: DbSearchRow[]): Map<string, number> {
  if (rows.length === 0) return new Map();
  const max = Math.max(...rows.map((row) => row.duration_us));
  if (max <= 0) return new Map(rows.map((row) => [row.segment_id, 0]));
  return new Map(rows.map((row) => [row.segment_id, row.duration_us / max]));
}

function decodeVector(buffer: Buffer): Float32Array {
  return new Float32Array(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength));
}

function parsedExtractedText(json: string): FootageSearchResult["extracted_text"] {
  try {
    const value = JSON.parse(json) as unknown;
    if (!Array.isArray(value)) return [];
    return value.flatMap((item) => {
      if (typeof item === "string") return item ? [{ text: item }] : [];
      if (!item || typeof item !== "object") return [];
      const record = item as Record<string, unknown>;
      const text = stringValue(record.text);
      if (!text) return [];
      return [{
        text,
        language: stringValue(record.language) || undefined,
        confidence: scoreOrNull(record.confidence) ?? undefined,
      }];
    });
  } catch {
    return [];
  }
}

function readArrayFromFile(filePath: string, ...keys: string[]): Record<string, unknown>[] {
  if (!fs.existsSync(filePath)) return [];
  try {
    const data = JSON.parse(fs.readFileSync(filePath, "utf-8")) as Record<string, unknown>;
    for (const key of keys) {
      const value = data[key];
      if (Array.isArray(value)) return value.filter((item): item is Record<string, unknown> => !!item && typeof item === "object");
    }
  } catch {
    return [];
  }
  return [];
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function nullableString(value: unknown): string | null {
  const text = stringValue(value);
  return text.trim() ? text : null;
}

function arrayStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

function extractedTextFlat(value: unknown): string {
  if (!Array.isArray(value)) return "";
  return value.flatMap((item) => {
    if (typeof item === "string") return item.trim() ? [item.trim()] : [];
    const record = recordValue(item);
    const text = stringValue(record.text).trim();
    return text ? [text] : [];
  }).join(" ");
}

function jsonStrings(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function nonNegativeInteger(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  return Math.trunc(value);
}

function scoreOrNull(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) return null;
  return value;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function roundScore(value: number): number {
  return Math.round(clamp01(value) * 1_000_000) / 1_000_000;
}

function clampLimit(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_FOOTAGE_SEARCH_LIMIT;
  return Math.max(1, Math.min(MAX_FOOTAGE_SEARCH_LIMIT, Math.trunc(value)));
}
