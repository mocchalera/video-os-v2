import * as fs from "node:fs";
import * as path from "node:path";
import Database from "better-sqlite3";

export interface CompileVisualCache {
  embeddings: Map<string, Float32Array>;
  timestamps: Map<string, number>;
  assetIds: Map<string, string>;
  sourceInUs: Map<string, number>;
  cameras: Map<string, string>;
}

interface SegmentEmbeddingDbRow {
  id: number;
  segment_id: string;
  dimension: number;
  vector: Buffer;
  output_dimension: number;
  normalized: number;
}

interface SegmentMetadataRow {
  segment_id: string;
  asset_id: string | null;
  src_in_us: number | null;
  filename: string | null;
  shooting_date: string | null;
  shooting_time: string | null;
  camera_type: string | null;
  logging_camera_id?: string | null;
  technical_camera_id?: string | null;
}

interface FilenameTimestamp {
  timestampUs: number;
  cameraKey?: string;
}

const QWEN3VL_MODEL_NAME = "Qwen/Qwen3-VL-Embedding-2B";
const QWEN3VL_OUTPUT_DIMENSION = 2048;

export function loadVisualCache(
  projectDir: string,
  segmentIds: string[],
  log?: (message: string) => void,
): CompileVisualCache | null {
  const ids = Array.from(new Set(segmentIds.filter(Boolean))).sort((a, b) => a.localeCompare(b));
  if (ids.length === 0) return null;

  const dbPath = path.join(projectDir, "03_analysis", "search", "footage.db");
  if (!fs.existsSync(dbPath)) return null;

  let db: Database.Database | undefined;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
    const embeddings = tableExists(db, "segment_embeddings") && tableExists(db, "embedding_models")
      ? loadVisualEmbeddings(db, ids)
      : new Map<string, Float32Array>();
    const metadata = loadSegmentMetadata(db, ids);
    if (embeddings.size === 0 &&
        metadata.timestamps.size === 0 &&
        metadata.assetIds.size === 0 &&
        metadata.sourceInUs.size === 0 &&
        metadata.cameras.size === 0) {
      return null;
    }
    return {
      embeddings,
      timestamps: metadata.timestamps,
      assetIds: metadata.assetIds,
      sourceInUs: metadata.sourceInUs,
      cameras: metadata.cameras,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log?.(`[compile] visual cache skipped: ${message}`);
    return null;
  } finally {
    db?.close();
  }
}

export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length === 0 || a.length !== b.length) return 0.5;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let index = 0; index < a.length; index += 1) {
    const av = a[index];
    const bv = b[index];
    if (!Number.isFinite(av) || !Number.isFinite(bv)) return 0.5;
    dot += av * bv;
    normA += av * av;
    normB += bv * bv;
  }
  if (normA <= 0 || normB <= 0) return 0.5;
  const score = dot / (Math.sqrt(normA) * Math.sqrt(normB));
  return Math.max(-1, Math.min(1, score));
}

function loadVisualEmbeddings(
  db: Database.Database,
  segmentIds: string[],
): Map<string, Float32Array> {
  const result = new Map<string, Float32Array>();
  const params: Record<string, unknown> = {
    qwen_model_name: QWEN3VL_MODEL_NAME,
    qwen_output_dimension: QWEN3VL_OUTPUT_DIMENSION,
  };
  const segmentClause = inClause("se.segment_id", "segment_id", segmentIds, params);
  const rows = db.prepare(`
    SELECT
      se.id,
      se.segment_id,
      se.dimension,
      se.vector,
      em.output_dimension,
      em.normalized
    FROM segment_embeddings se
    JOIN embedding_models em ON em.id = se.model_id
    WHERE em.name = @qwen_model_name
      AND em.output_dimension = @qwen_output_dimension
      AND em.input_modality IN ('multimodal', 'mixed', 'image', 'video')
      AND em.distance_metric = 'cosine'
      AND se.embedding_type = 'visual_representative'
      AND ${segmentClause}
    ORDER BY se.segment_id ASC, se.id ASC
  `).all(params) as SegmentEmbeddingDbRow[];

  for (const row of rows) {
    if (result.has(row.segment_id)) continue;
    const vector = validatedVector(row);
    if (vector) result.set(row.segment_id, vector);
  }
  return result;
}

function validatedVector(row: SegmentEmbeddingDbRow): Float32Array | null {
  if (row.dimension !== row.output_dimension) return null;
  if (row.vector.byteLength !== row.dimension * 4) return null;

  const vector = decodeVector(row.vector);
  let magnitudeSquared = 0;
  for (let index = 0; index < vector.length; index += 1) {
    const value = vector[index];
    if (!Number.isFinite(value)) return null;
    magnitudeSquared += value * value;
  }

  if (row.normalized === 1) {
    const norm = Math.sqrt(magnitudeSquared);
    if (norm < 0.9 || norm > 1.1) return null;
  }

  return vector;
}

function loadSegmentMetadata(
  db: Database.Database,
  segmentIds: string[],
): Omit<CompileVisualCache, "embeddings"> {
  const assetIds = new Map<string, string>();
  const sourceInUs = new Map<string, number>();
  const timestamps = new Map<string, number>();
  const cameras = new Map<string, string>();
  if (!tableExists(db, "segments") || !tableExists(db, "assets")) {
    return { assetIds, sourceInUs, timestamps, cameras };
  }

  const hasLogging = tableExists(db, "segment_logging_profile");
  const hasTechnical = tableExists(db, "asset_technical_metadata");
  const params: Record<string, unknown> = {};
  const segmentClause = inClause("s.segment_id", "metadata_segment_id", segmentIds, params);
  const rows = db.prepare(`
    SELECT
      s.segment_id,
      s.asset_id,
      s.src_in_us,
      a.filename,
      a.shooting_date,
      a.shooting_time,
      a.camera_type
      ${hasLogging ? ", slp.camera_id AS logging_camera_id" : ""}
      ${hasTechnical ? ", atm.camera_id AS technical_camera_id" : ""}
    FROM segments s
    LEFT JOIN assets a ON a.asset_id = s.asset_id
    ${hasLogging ? "LEFT JOIN segment_logging_profile slp ON slp.segment_id = s.segment_id" : ""}
    ${hasTechnical ? "LEFT JOIN asset_technical_metadata atm ON atm.asset_id = s.asset_id" : ""}
    WHERE ${segmentClause}
    ORDER BY s.segment_id ASC
  `).all(params) as SegmentMetadataRow[];

  for (const row of rows) {
    if (row.asset_id) assetIds.set(row.segment_id, row.asset_id);
    if (typeof row.src_in_us === "number" && Number.isFinite(row.src_in_us)) {
      sourceInUs.set(row.segment_id, row.src_in_us);
    }

    const filenameTimestamp = parseFilenameTimestamp(row.filename ?? "");
    const assetTimestampUs =
      parseShootingDateTime(row.shooting_date, row.shooting_time) ??
      filenameTimestamp?.timestampUs;
    if (assetTimestampUs != null) {
      timestamps.set(row.segment_id, assetTimestampUs + Math.max(0, row.src_in_us ?? 0));
    }

    const camera = normalizeCameraKey(
      row.logging_camera_id ??
        row.technical_camera_id ??
        row.camera_type ??
        filenameTimestamp?.cameraKey ??
        undefined,
    );
    if (camera) cameras.set(row.segment_id, camera);
  }

  return { assetIds, sourceInUs, timestamps, cameras };
}

function parseShootingDateTime(
  dateValue: string | null | undefined,
  timeValue: string | null | undefined,
): number | null {
  if (!dateValue || !timeValue) return null;
  const date = dateValue.match(/(?<year>\d{4})[-/](?<month>\d{2})[-/](?<day>\d{2})/);
  const time = timeValue.match(/(?<hour>\d{2})(?::?(?<minute>\d{2}))(?::?(?<second>\d{2}))?/);
  if (!date?.groups || !time?.groups) return null;
  return utcTimestampUs({
    year: date.groups.year,
    month: date.groups.month,
    day: date.groups.day,
    hour: time.groups.hour,
    minute: time.groups.minute,
    second: time.groups.second ?? "00",
  });
}

function parseFilenameTimestamp(filename: string): FilenameTimestamp | null {
  const stem = path.basename(filename, path.extname(filename));

  const dashed = stem.match(/(?<prefix>.*?)(?<year>\d{4})-(?<month>\d{2})-(?<day>\d{2})[_\-\s](?<hour>\d{2})(?<minute>\d{2})(?<second>\d{2})?/);
  if (dashed?.groups) {
    return {
      timestampUs: utcTimestampUs(dashed.groups),
      cameraKey: cleanCameraPrefix(dashed.groups.prefix),
    };
  }

  const compact = stem.match(/(?<prefix>.*?)(?<year>\d{4})(?<month>\d{2})(?<day>\d{2})[_\-\s](?<hour>\d{2})(?<minute>\d{2})(?<second>\d{2})?/);
  if (compact?.groups) {
    return {
      timestampUs: utcTimestampUs(compact.groups),
      cameraKey: cleanCameraPrefix(compact.groups.prefix),
    };
  }

  return null;
}

function utcTimestampUs(groups: {
  year?: string;
  month?: string;
  day?: string;
  hour?: string;
  minute?: string;
  second?: string;
}): number {
  const year = Number(groups.year);
  const month = Number(groups.month);
  const day = Number(groups.day);
  const hour = Number(groups.hour);
  const minute = Number(groups.minute);
  const second = Number(groups.second ?? "00");
  return Date.UTC(year, month - 1, day, hour, minute, second) * 1000;
}

function cleanCameraPrefix(prefix: string | undefined): string | undefined {
  if (!prefix) return undefined;
  return normalizeCameraKey(prefix.replace(/[_\-\s]+$/g, ""));
}

function normalizeCameraKey(value: string | undefined): string | undefined {
  const key = value?.trim().replace(/\s+/g, " ");
  return key ? key.toLowerCase() : undefined;
}

function tableExists(db: Database.Database, tableName: string): boolean {
  return Boolean(
    db.prepare("SELECT 1 FROM sqlite_master WHERE type IN ('table', 'view') AND name = ? LIMIT 1").get(tableName),
  );
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

function decodeVector(buffer: Buffer): Float32Array {
  return new Float32Array(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength));
}
