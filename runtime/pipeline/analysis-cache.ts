/**
 * Analysis cache — avoid redundant VLM/STT calls for unchanged source files.
 *
 * Cache key: SHA-256(first 1 MB of file content + file size + duration_us)
 * Manifest:  projects/<id>/03_analysis/cache_manifest.json
 *
 * Per roadmap-v2.1.md §M2-1
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

// ── Constants ──────────────────────────────────────────────────────

const CACHE_CHUNK_SIZE = 1 * 1024 * 1024; // 1 MB

// ── Types ──────────────────────────────────────────────────────────

export interface CacheManifestEntry {
  hash: string;
  asset_id: string;
  cached_at: string;
  source_path: string;
}

// ── Hash ───────────────────────────────────────────────────────────

/**
 * Compute cache hash: SHA-256(first 1 MB content + fileSize + durationUs).
 *
 * Path is intentionally excluded so file moves do not invalidate the cache.
 */
export function computeCacheHash(
  filePath: string,
  fileSize: number,
  durationUs: number,
): string {
  const fd = fs.openSync(filePath, "r");
  try {
    const chunkSize = Math.min(CACHE_CHUNK_SIZE, fileSize);
    const buffer = Buffer.alloc(chunkSize);
    fs.readSync(fd, buffer, 0, chunkSize, 0);

    const hash = createHash("sha256");
    hash.update(buffer);
    hash.update(String(fileSize));
    hash.update(String(durationUs));
    return hash.digest("hex");
  } finally {
    fs.closeSync(fd);
  }
}

// ── Manifest CRUD ──────────────────────────────────────────────────

/**
 * Load cache manifest from disk. Returns [] if file is missing or corrupt.
 */
export function loadCacheManifest(manifestPath: string): CacheManifestEntry[] {
  if (!fs.existsSync(manifestPath)) return [];
  try {
    return JSON.parse(fs.readFileSync(manifestPath, "utf-8")) as CacheManifestEntry[];
  } catch {
    return [];
  }
}

/**
 * Persist cache manifest atomically (tmp + rename).
 */
export function saveCacheManifest(
  manifestPath: string,
  entries: CacheManifestEntry[],
): void {
  const dir = path.dirname(manifestPath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = manifestPath + ".tmp." + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(entries, null, 2));
  fs.renameSync(tmp, manifestPath);
}

/**
 * Delete cache manifest file. Safe to call when file does not exist.
 */
export function clearCacheManifest(manifestPath: string): void {
  if (fs.existsSync(manifestPath)) {
    fs.unlinkSync(manifestPath);
  }
}

// ── Lookup ─────────────────────────────────────────────────────────

/**
 * Find manifest entry by hash.
 */
export function lookupCache(
  manifest: CacheManifestEntry[],
  hash: string,
): CacheManifestEntry | undefined {
  return manifest.find((e) => e.hash === hash);
}

// ── JSON helpers ───────────────────────────────────────────────────

/**
 * Safely load a JSON file. Returns null when missing or corrupt.
 */
export function loadJsonFile<T>(filePath: string): T | null {
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8")) as T;
  } catch {
    return null;
  }
}
