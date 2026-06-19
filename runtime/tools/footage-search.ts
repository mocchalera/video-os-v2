import Database from "better-sqlite3";
import * as fs from "node:fs";
import * as path from "node:path";
import { footageDbPath, readFootageDbStatus } from "../artifacts/footage-db.js";
import { cjkSearchExpansions, normalizeSearchText } from "../artifacts/footage-db-builder.js";
import {
  SEMANTIC_EMBEDDING_DTYPE,
  SEMANTIC_EMBEDDING_MODEL,
  cosineSimilarity,
  embedTexts,
} from "../eval/semantic-match.js";

export type FootageSearchMode = "hybrid" | "text" | "semantic" | "structured";
export type FootageSortBy = "relevance" | "quality" | "chronological" | "duration";

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
  camera_motion?: string;
  shot_scale?: string;
  stability?: string;
  usability?: string;
  include_tags_any?: string[];
  exclude_quality_flags?: string[];
  exclude_segment_ids?: string[];
}

export interface FootageSearchContext {
  project_id?: string;
  terminology?: Array<{ term: string; meaning: string; aliases?: string[] }>;
  locations?: Array<{ name: string; description?: string; category?: string; aliases?: string[] }>;
  subjects?: Array<{ name: string; role?: string; appearance?: string; aliases?: string[] }>;
}

export interface SearchFootageInput {
  query: string;
  mode?: FootageSearchMode;
  explicitBoolean?: boolean;
  text_match?: string;
  semantic?: string;
  filters?: FootageSearchFilters;
  sort_by?: FootageSortBy;
  limit?: number;
  context?: FootageSearchContext;
}

export interface FootageScoreBreakdown {
  semantic?: number;
  lexical?: number;
  quality?: number;
  peak?: number;
  final: number;
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
    shot_scale?: string;
    stability?: string;
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
  shot_scale: string | null;
  stability: string | null;
  dominant_subject_position: string | null;
  usability: string | null;
}

interface BuiltWhere {
  sql: string;
  params: Record<string, unknown>;
}

interface MetadataAvailability {
  visualProfile: boolean;
  audioProfile: boolean;
  logging: boolean;
  metadataFts: boolean;
}

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
      pa.fused_peak_score,
      pm.timestamp_us AS peak_timestamp_us,
      pm.type AS peak_type,
      pm.confidence AS peak_confidence,
      pm.description AS peak_description,
      ${metadata.visualProfile ? "svp.camera_motion" : "NULL"} AS camera_motion,
      ${metadata.visualProfile ? "svp.shot_scale" : "NULL"} AS shot_scale,
      ${metadata.visualProfile ? "svp.stability" : "NULL"} AS stability,
      ${metadata.visualProfile ? "svp.dominant_subject_position" : "NULL"} AS dominant_subject_position,
      ${metadata.logging ? "sl.usability" : "NULL"} AS usability
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
  const mode = input.mode ?? "hybrid";
  const limit = clampLimit(input.limit);

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
    const response = await searchFootageWithDb(db, dbPath, input, mode, limit, warnings, status.status);
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

  let semanticScores = new Map<string, number>();
  let semanticAvailable = false;
  if ((mode === "hybrid" || mode === "semantic") && semanticText) {
    const semantic = await semanticScoresForRows(db, rows, semanticText, warnings);
    semanticScores = semantic.scores;
    semanticAvailable = semantic.available;
  }

  if (mode === "text") {
    rows = rows.filter((row) => lexicalScores.has(row.segment_id));
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
  } else if (mode === "hybrid" && fts.match && !semanticAvailable) {
    rows = rows.filter((row) => lexicalScores.has(row.segment_id));
  }

  const durationScores = normalizeDurationScores(rows);
  const eventLookup = marlinEventLookup(db, rows);
  const results = rows.map((row) => {
    const quality = qualityScore(row);
    const peak = peakScore(row);
    const lexical = lexicalScores.get(row.segment_id);
    const semantic = semanticScores.get(row.segment_id);
    const final = finalScore({
      semantic,
      lexical,
      quality,
      peak,
      duration: durationScores.get(row.segment_id) ?? 0,
    });
    return rowToResult(row, {
      semantic,
      lexical,
      quality,
      peak,
      final,
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
  if (filters.camera_motion) {
    if (metadata.visualProfile) {
      clauses.push("svp.camera_motion = @camera_motion");
      params.camera_motion = filters.camera_motion;
    } else {
      clauses.push("0 = 1");
    }
  }
  if (filters.shot_scale) {
    if (metadata.visualProfile) {
      clauses.push("svp.shot_scale = @shot_scale");
      params.shot_scale = filters.shot_scale;
    } else {
      clauses.push("0 = 1");
    }
  }
  if (filters.stability) {
    if (metadata.visualProfile) {
      clauses.push("svp.stability = @stability");
      params.stability = filters.stability;
    } else {
      clauses.push("0 = 1");
    }
  }
  if (filters.usability) {
    if (metadata.logging) {
      clauses.push("sl.usability = @usability");
      params.usability = filters.usability;
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
    return new Map(rows
      .filter((row) => allowedIds.has(row.segment_id))
      .map((row) => [row.segment_id, row.rank]));
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
  const vectorRows = loadEmbeddingRows(db, rows.map((row) => row.segment_id));
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
      raw.set(row.segment_id, cosineSimilarity(queryVector, decodeVector(row.vector)));
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
): Array<{ segment_id: string; vector: Buffer }> {
  if (segmentIds.length === 0) return [];
  const params: Record<string, unknown> = { model_id: EMBEDDING_MODEL_ID };
  const clause = inClause("segment_id", "semantic_segment_id", segmentIds, params);
  return db.prepare(`
    SELECT segment_id, vector
    FROM embeddings
    WHERE model_id = @model_id AND field = 'combined' AND ${clause}
  `).all(params) as Array<{ segment_id: string; vector: Buffer }>;
}

function applyPostFilters(rows: DbSearchRow[], filters: FootageSearchFilters): DbSearchRow[] {
  const includeTags = (filters.include_tags_any ?? []).map((tag) => tag.toLowerCase());
  const excludeFlags = (filters.exclude_quality_flags ?? []).map((flag) => flag.toLowerCase());
  return rows.filter((row) => {
    if (includeTags.length > 0) {
      const tags = [...jsonStrings(row.tags_json), ...jsonStrings(row.asset_tags_json)].map((tag) => tag.toLowerCase());
      if (!includeTags.some((tag) => tags.includes(tag))) return false;
    }
    if (excludeFlags.length > 0) {
      const flags = [...jsonStrings(row.quality_flags_json), ...jsonStrings(row.asset_quality_flags_json)]
        .map((flag) => flag.toLowerCase());
      if (excludeFlags.some((flag) => flags.includes(flag))) return false;
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
    quality: number;
    peak: number;
    final: number;
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
  for (const [field, value] of Object.entries(quality)) {
    if (value != null) reasonParts.push(`${field}=${value.toFixed(2)}`);
  }
  if (tags.length > 0) reasonParts.push(`tags: ${tags.slice(0, 4).join(",")}`);
  const metadata = resultMetadata(row);
  if (metadata.camera_motion) reasonParts.push(`camera_motion=${metadata.camera_motion}`);
  if (metadata.shot_scale) reasonParts.push(`shot_scale=${metadata.shot_scale}`);
  if (metadata.usability) reasonParts.push(`usability=${metadata.usability}`);
  if (scoring.contextExpansions.length > 0) reasonParts.push(`context expansions: ${scoring.contextExpansions.join(",")}`);

  return {
    segment_id: row.segment_id,
    asset_id: row.asset_id,
    src_in_us: row.src_in_us,
    src_out_us: row.src_out_us,
    duration_us: row.duration_us,
    score: scoring.final,
    scores: {
      semantic: scoring.semantic,
      lexical: scoring.lexical,
      quality: scoring.quality,
      peak: scoring.peak,
      final: scoring.final,
    },
    match_reason: reasonParts.join("; ") || "structured filters matched deterministic footage fields",
    summary: row.summary,
    key_frame_path: row.frame_path ?? row.filmstrip_path ?? undefined,
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
  quality: number;
  peak: number;
  duration: number;
}): number {
  if (scores.semantic != null && scores.lexical != null) {
    return roundScore(0.55 * scores.semantic + 0.30 * scores.lexical + 0.10 * scores.quality + 0.05 * scores.peak);
  }
  if (scores.semantic == null && scores.lexical != null) {
    return roundScore(0.75 * scores.lexical + 0.20 * scores.quality + 0.05 * scores.peak);
  }
  if (scores.semantic != null && scores.lexical == null) {
    return roundScore(0.80 * scores.semantic + 0.15 * scores.quality + 0.05 * scores.peak);
  }
  return roundScore(0.70 * scores.quality + 0.20 * scores.peak + 0.10 * scores.duration);
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
  rows = applyPostFilters(rows, filters);
  const durationScores = normalizeDurationScores(rows);
  const results = rows.map((row) => {
    const quality = qualityScore(row);
    const peak = peakScore(row);
    const lexical = text ? 1 : undefined;
    const final = finalScore({ lexical, quality, peak, duration: durationScores.get(row.segment_id) ?? 0 });
    return rowToResult(row, {
      lexical,
      quality,
      peak,
      final,
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
    shot_scale: null,
    stability: null,
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
  if (row.shot_scale) metadata.shot_scale = row.shot_scale;
  if (row.stability) metadata.stability = row.stability;
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
    visualProfile: tableExists(db, "segment_visual_profile"),
    audioProfile: tableExists(db, "segment_audio_profile"),
    logging: tableExists(db, "segment_logging"),
    metadataFts: tableExists(db, "metadata_fts"),
  };
}

function metadataJoinSql(metadata: MetadataAvailability): string {
  return [
    metadata.visualProfile ? "LEFT JOIN segment_visual_profile svp ON svp.segment_id = s.segment_id" : "",
    metadata.audioProfile ? "LEFT JOIN segment_audio_profile sap ON sap.segment_id = s.segment_id" : "",
    metadata.logging ? "LEFT JOIN segment_logging sl ON sl.segment_id = s.segment_id" : "",
  ].filter(Boolean).join("\n");
}

function tableExists(db: Database.Database, tableName: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type IN ('table', 'view') AND name = ? LIMIT 1").get(tableName));
}

function requestedMetadataFilters(filters: FootageSearchFilters): string[] {
  const names: string[] = [];
  if (filters.camera_motion) names.push("camera_motion");
  if (filters.shot_scale) names.push("shot_scale");
  if (filters.stability) names.push("stability");
  if (filters.usability) names.push("usability");
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
  if ((filters.camera_motion || filters.shot_scale || filters.stability) && !metadata.visualProfile) {
    warnings.push("visual metadata filter requested, but segment_visual_profile is missing in this footage DB");
  } else if ((filters.camera_motion || filters.shot_scale || filters.stability) && !db.prepare("SELECT 1 FROM segment_visual_profile LIMIT 1").get()) {
    warnings.push("visual metadata filter requested, but no segment_visual_profile rows are indexed");
  }
  if (filters.usability && !metadata.logging) {
    warnings.push("usability filter requested, but segment_logging is missing in this footage DB");
  } else if (filters.usability && !db.prepare("SELECT 1 FROM segment_logging LIMIT 1").get()) {
    warnings.push("usability filter requested, but no segment_logging rows are indexed");
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
