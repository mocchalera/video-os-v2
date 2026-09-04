/**
 * Analysis cache — avoid redundant VLM/STT calls for unchanged source files.
 *
 * Cache key: SHA-256(full source-content SHA-256 + file size + duration_us)
 * Manifest:  projects/<id>/03_analysis/cache_manifest.json
 *
 * Per roadmap-v2.1.md §M2-1
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { sha256FileHex } from "../source-content-identity.js";
import { ArtifactValidationError, validateArtifact } from "../artifacts/loaders.js";

// ── Types ──────────────────────────────────────────────────────────

export interface CacheManifestEntry {
  hash: string;
  asset_id: string;
  cached_at: string;
  source_path: string;
  source_content_sha256?: string;
}

export interface AnalysisCacheEligibility {
  eligible: boolean;
  violations: Array<{ artifact: string; rule: string; message: string }>;
}

interface CanonicalAssetsDocument {
  items: Array<{ asset_id: string }>;
}

interface CanonicalSegmentsDocument {
  items: Array<{ asset_id: string }>;
}

/** Cache reuse is allowed only when both canonical analysis artifacts validate. */
export function inspectAnalysisCacheEligibility(projectDir: string): AnalysisCacheEligibility {
  const required = new Set([
    "03_analysis/assets.json",
    "03_analysis/segments.json",
  ]);
  for (const artifact of required) {
    if (!fs.existsSync(path.join(projectDir, artifact))) {
      return {
        eligible: false,
        violations: [{ artifact, rule: "cache_artifact_missing", message: `Required cache artifact not found: ${artifact}` }],
      };
    }
  }
  const violations: AnalysisCacheEligibility["violations"] = [];
  let assets: CanonicalAssetsDocument | undefined;
  let segments: CanonicalSegmentsDocument | undefined;
  for (const artifact of required) {
    try {
      const value = JSON.parse(fs.readFileSync(path.join(projectDir, artifact), "utf-8")) as unknown;
      validateArtifact(value, artifact.endsWith("assets.json") ? "assets.schema.json" : "segments.schema.json");
      if (artifact.endsWith("assets.json")) {
        assets = value as CanonicalAssetsDocument;
      } else {
        segments = value as CanonicalSegmentsDocument;
      }
    } catch (error) {
      violations.push({
        artifact,
        rule: error instanceof SyntaxError ? "parse_error" : "schema",
        message: error instanceof ArtifactValidationError
          ? error.validationErrors.join("; ")
          : error instanceof Error ? error.message : String(error),
      });
    }
  }
  if (assets && segments) {
    const segmentAssetIds = new Set(segments.items.map((segment) => segment.asset_id));
    for (const asset of assets.items) {
      if (!segmentAssetIds.has(asset.asset_id)) {
        violations.push({
          artifact: "03_analysis/segments.json",
          rule: "asset_segments_complete",
          message: `Canonical asset ${asset.asset_id} has no segment records`,
        });
      }
    }
  }
  return { eligible: violations.length === 0, violations };
}

// ── Hash ───────────────────────────────────────────────────────────

/**
 * Compute cache hash from the full source-content identity.
 *
 * Path is intentionally excluded so file moves do not invalidate the cache.
 */
export function computeCacheHash(
  filePath: string,
  fileSize: number,
  durationUs: number,
  sourceContentSha256: string = sha256FileHex(filePath),
): string {
  const hash = createHash("sha256");
  hash.update(sourceContentSha256);
  hash.update(String(fileSize));
  hash.update(String(durationUs));
  return hash.digest("hex");
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
