import Database from "better-sqlite3";
import * as fs from "node:fs";
import * as path from "node:path";
import { computeNormalizedJsonHash } from "./p1-manifest-coverage.js";

export type FootageDbStatusKind = "ready" | "missing" | "stale" | "malformed";

export interface FootageDbStatus {
  status: FootageDbStatusKind;
  path: string;
  exists: boolean;
  schema_version?: string;
  artifact_version?: "footage-db-v1";
  project_id?: string;
  source_hashes?: Record<string, string>;
  stale_reasons?: string[];
  embedding_status?: "ready" | "skipped" | "unavailable" | "error";
  embedding_model_id?: string;
  errors?: string[];
}

export const FOOTAGE_DB_REL_PATH = "03_analysis/search/footage.db";
export const EDITORIAL_OBSERVATION_MATERIALIZATION_REVISION = "eye-010b-v1";

export function footageDbPath(projectDir: string): string {
  return path.join(projectDir, FOOTAGE_DB_REL_PATH);
}

export function isFootageDbStale(projectDir: string): boolean {
  const dbPath = footageDbPath(projectDir);
  const segmentsPath = path.join(projectDir, "03_analysis/segments.json");
  if (!fs.existsSync(dbPath)) return true;
  if (!fs.existsSync(segmentsPath)) return true;
  return fs.statSync(segmentsPath).mtimeMs > fs.statSync(dbPath).mtimeMs;
}

export function readFootageDbStatus(projectDir: string): FootageDbStatus {
  const dbPath = footageDbPath(projectDir);
  if (!fs.existsSync(dbPath)) {
    return { status: "missing", path: dbPath, exists: false };
  }

  try {
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    try {
      db.pragma("foreign_keys = ON");
      const meta = readMeta(db);
      const sourceHashes = readSourceHashes(db);
      const staleReasons = searchFootageDbStaleReasons(projectDir);
      const schemaVersion = meta.schema_version;
      const artifactVersion = meta.artifact_version;
      const errors: string[] = [];
      if (schemaVersion !== "1") errors.push(`unsupported schema_version: ${schemaVersion ?? "missing"}`);
      if (artifactVersion !== "footage-db-v1") {
        errors.push(`unsupported artifact_version: ${artifactVersion ?? "missing"}`);
      }
      if (errors.length > 0) {
        return { status: "malformed", path: dbPath, exists: true, source_hashes: sourceHashes, errors };
      }
      return {
        status: staleReasons.length > 0 ? "stale" : "ready",
        path: dbPath,
        exists: true,
        schema_version: schemaVersion,
        artifact_version: "footage-db-v1",
        project_id: meta.project_id,
        source_hashes: sourceHashes,
        stale_reasons: staleReasons.length > 0 ? staleReasons : undefined,
        embedding_status: parseEmbeddingStatus(meta.embedding_status),
        embedding_model_id: meta.embedding_model_id,
      };
    } finally {
      db.close();
    }
  } catch (error) {
    return {
      status: "malformed",
      path: dbPath,
      exists: true,
      errors: [error instanceof Error ? error.message : String(error)],
    };
  }
}

export function searchFootageDbStaleReasons(projectDir: string): string[] {
  const dbPath = footageDbPath(projectDir);
  if (!fs.existsSync(dbPath)) return ["footage DB missing"];
  const reasons: string[] = [];
  try {
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    try {
      const rows = db.prepare(`
        SELECT source_name, rel_path, hash, required
        FROM footage_db_sources
        ORDER BY source_name
      `).all() as Array<{ source_name: string; rel_path: string; hash: string; required: number }>;
      for (const row of rows) {
        const current = currentSourceHash(projectDir, row.rel_path);
        if (!current) {
          if (row.required === 1) reasons.push(`${row.rel_path}: required source missing`);
          else reasons.push(`${row.rel_path}: indexed optional source missing`);
          continue;
        }
        if (current !== row.hash) {
          reasons.push(`${row.rel_path}: db=${row.hash} current=${current}`);
        }
      }
      const meta = readMeta(db);
      if (segmentsContainEditorialObservation(projectDir)
        && meta.editorial_observation_materialization_revision !== EDITORIAL_OBSERVATION_MATERIALIZATION_REVISION) {
        reasons.push(
          `editorial observation materialization revision: db=${meta.editorial_observation_materialization_revision ?? "missing"} current=${EDITORIAL_OBSERVATION_MATERIALIZATION_REVISION}`,
        );
      }
    } finally {
      db.close();
    }
  } catch (error) {
    reasons.push(`footage DB malformed: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (isFootageDbStale(projectDir)) {
    reasons.push("03_analysis/segments.json mtime is newer than footage.db");
  }
  return Array.from(new Set(reasons));
}

function segmentsContainEditorialObservation(projectDir: string): boolean {
  const segmentsPath = path.join(projectDir, "03_analysis/segments.json");
  if (!fs.existsSync(segmentsPath)) return false;
  try {
    const document = JSON.parse(fs.readFileSync(segmentsPath, "utf-8")) as Record<string, unknown>;
    const items = Array.isArray(document.items)
      ? document.items
      : Array.isArray(document.segments)
        ? document.segments
        : [];
    return items.some((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return false;
      const observation = (item as Record<string, unknown>).editorial_observation;
      return observation != null && typeof observation === "object" && !Array.isArray(observation);
    });
  } catch {
    return false;
  }
}

function readMeta(db: Database.Database): Record<string, string> {
  const rows = db.prepare("SELECT key, value FROM footage_db_meta").all() as Array<{ key: string; value: string }>;
  return Object.fromEntries(rows.map((row) => [row.key, row.value]));
}

function readSourceHashes(db: Database.Database): Record<string, string> {
  const rows = db.prepare("SELECT rel_path, hash FROM footage_db_sources ORDER BY rel_path").all() as Array<{
    rel_path: string;
    hash: string;
  }>;
  return Object.fromEntries(rows.map((row) => [row.rel_path, row.hash]));
}

function currentSourceHash(projectDir: string, relPath: string): string | null {
  const filePath = path.join(projectDir, relPath);
  if (!fs.existsSync(filePath)) return null;
  try {
    return computeNormalizedJsonHash(JSON.parse(fs.readFileSync(filePath, "utf-8")), ["created_at"]);
  } catch {
    return null;
  }
}

function parseEmbeddingStatus(value: string | undefined): FootageDbStatus["embedding_status"] {
  if (value === "ready" || value === "skipped" || value === "unavailable" || value === "error") return value;
  return undefined;
}
