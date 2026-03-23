/**
 * Tests for analysis cache (M2-1).
 *
 * Covers: hash computation, manifest CRUD, cache lookup, CLI flag parsing,
 * and integration-level cache-hit filtering.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  computeCacheHash,
  loadCacheManifest,
  saveCacheManifest,
  clearCacheManifest,
  lookupCache,
  loadJsonFile,
  type CacheManifestEntry,
} from "../runtime/pipeline/analysis-cache.js";
import { parseArgs } from "../scripts/analyze.js";

// ── Fixture dir ────────────────────────────────────────────────────

let tmpDir: string;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "analysis-cache-test-"));
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── computeCacheHash ───────────────────────────────────────────────

describe("computeCacheHash", () => {
  it("returns consistent SHA-256 hex for same input", () => {
    const filePath = path.join(tmpDir, "consistent.bin");
    fs.writeFileSync(filePath, Buffer.alloc(2 * 1024 * 1024, 0x42));
    const stat = fs.statSync(filePath);

    const h1 = computeCacheHash(filePath, stat.size, 5_000_000);
    const h2 = computeCacheHash(filePath, stat.size, 5_000_000);

    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[0-9a-f]{64}$/); // SHA-256 hex = 64 chars
  });

  it("different file content → different hash", () => {
    const f1 = path.join(tmpDir, "content1.bin");
    const f2 = path.join(tmpDir, "content2.bin");
    fs.writeFileSync(f1, Buffer.alloc(1024, 0x41));
    fs.writeFileSync(f2, Buffer.alloc(1024, 0x42));

    const h1 = computeCacheHash(f1, 1024, 5_000_000);
    const h2 = computeCacheHash(f2, 1024, 5_000_000);
    expect(h1).not.toBe(h2);
  });

  it("different duration → different hash", () => {
    const filePath = path.join(tmpDir, "duration.bin");
    fs.writeFileSync(filePath, Buffer.alloc(1024, 0x42));

    const h1 = computeCacheHash(filePath, 1024, 5_000_000);
    const h2 = computeCacheHash(filePath, 1024, 10_000_000);
    expect(h1).not.toBe(h2);
  });

  it("different file size → different hash", () => {
    const f1 = path.join(tmpDir, "size1.bin");
    const f2 = path.join(tmpDir, "size2.bin");
    fs.writeFileSync(f1, Buffer.alloc(1024, 0x42));
    fs.writeFileSync(f2, Buffer.alloc(2048, 0x42));

    const h1 = computeCacheHash(f1, 1024, 5_000_000);
    const h2 = computeCacheHash(f2, 2048, 5_000_000);
    expect(h1).not.toBe(h2);
  });

  it("only reads first 1 MB — identical prefix produces identical hash", () => {
    const f1 = path.join(tmpDir, "big1.bin");
    const f2 = path.join(tmpDir, "big2.bin");

    const buf1 = Buffer.alloc(2 * 1024 * 1024, 0x42);
    const buf2 = Buffer.alloc(2 * 1024 * 1024, 0x42);
    // Differ AFTER the 1 MB boundary
    buf2[1 * 1024 * 1024 + 100] = 0xff;

    fs.writeFileSync(f1, buf1);
    fs.writeFileSync(f2, buf2);

    const h1 = computeCacheHash(f1, buf1.length, 5_000_000);
    const h2 = computeCacheHash(f2, buf2.length, 5_000_000);
    expect(h1).toBe(h2);
  });

  it("handles files smaller than 1 MB", () => {
    const filePath = path.join(tmpDir, "tiny.bin");
    fs.writeFileSync(filePath, Buffer.from("hello"));

    expect(() => computeCacheHash(filePath, 5, 1_000_000)).not.toThrow();
    const hash = computeCacheHash(filePath, 5, 1_000_000);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });
});

// ── Manifest CRUD ──────────────────────────────────────────────────

describe("manifest operations", () => {
  it("loadCacheManifest returns [] for non-existent file", () => {
    expect(loadCacheManifest(path.join(tmpDir, "nope.json"))).toEqual([]);
  });

  it("loadCacheManifest returns [] for corrupt JSON", () => {
    const p = path.join(tmpDir, "corrupt.json");
    fs.writeFileSync(p, "not valid json{{{");
    expect(loadCacheManifest(p)).toEqual([]);
  });

  it("save and load roundtrip", () => {
    const manifestPath = path.join(tmpDir, "roundtrip.json");
    const entries: CacheManifestEntry[] = [
      {
        hash: "abc123def456",
        asset_id: "AST_ABC12345",
        cached_at: "2024-01-01T00:00:00.000Z",
        source_path: "/path/to/test.mp4",
      },
      {
        hash: "789xyz",
        asset_id: "AST_789XYZ00",
        cached_at: "2024-06-15T12:00:00.000Z",
        source_path: "/path/to/other.mov",
      },
    ];

    saveCacheManifest(manifestPath, entries);
    const loaded = loadCacheManifest(manifestPath);
    expect(loaded).toEqual(entries);
  });

  it("saveCacheManifest creates parent directories", () => {
    const nested = path.join(tmpDir, "deep", "nested", "manifest.json");
    saveCacheManifest(nested, []);
    expect(fs.existsSync(nested)).toBe(true);
    expect(loadCacheManifest(nested)).toEqual([]);
  });

  it("clearCacheManifest removes the file", () => {
    const p = path.join(tmpDir, "to-clear.json");
    fs.writeFileSync(p, "[]");
    expect(fs.existsSync(p)).toBe(true);

    clearCacheManifest(p);
    expect(fs.existsSync(p)).toBe(false);
  });

  it("clearCacheManifest is safe for non-existent file", () => {
    expect(() =>
      clearCacheManifest(path.join(tmpDir, "already-gone.json")),
    ).not.toThrow();
  });
});

// ── lookupCache ────────────────────────────────────────────────────

describe("lookupCache", () => {
  const manifest: CacheManifestEntry[] = [
    { hash: "hash_a", asset_id: "AST_001", cached_at: "2024-01-01T00:00:00Z", source_path: "a.mp4" },
    { hash: "hash_b", asset_id: "AST_002", cached_at: "2024-01-01T00:00:00Z", source_path: "b.mp4" },
  ];

  it("finds entry by matching hash", () => {
    const entry = lookupCache(manifest, "hash_a");
    expect(entry).toBeDefined();
    expect(entry!.asset_id).toBe("AST_001");
  });

  it("returns undefined for unknown hash", () => {
    expect(lookupCache(manifest, "hash_unknown")).toBeUndefined();
  });

  it("returns undefined for empty manifest", () => {
    expect(lookupCache([], "hash_a")).toBeUndefined();
  });
});

// ── loadJsonFile ───────────────────────────────────────────────────

describe("loadJsonFile", () => {
  it("returns null for non-existent file", () => {
    expect(loadJsonFile(path.join(tmpDir, "nope.json"))).toBeNull();
  });

  it("returns null for corrupt JSON", () => {
    const p = path.join(tmpDir, "bad-json.json");
    fs.writeFileSync(p, "{invalid}");
    expect(loadJsonFile(p)).toBeNull();
  });

  it("parses valid JSON", () => {
    const p = path.join(tmpDir, "good.json");
    fs.writeFileSync(p, JSON.stringify({ foo: 42 }));
    expect(loadJsonFile<{ foo: number }>(p)).toEqual({ foo: 42 });
  });
});

// ── CLI flag parsing ───────────────────────────────────────────────

describe("parseArgs cache flags", () => {
  it("--no-cache sets noCache = true", () => {
    const result = parseArgs([
      "node", "analyze.ts",
      "video.mp4",
      "--project", "projects/test",
      "--no-cache",
    ]);
    expect(result.noCache).toBe(true);
    expect(result.clearCache).toBe(false);
  });

  it("--clear-cache sets clearCache = true", () => {
    const result = parseArgs([
      "node", "analyze.ts",
      "video.mp4",
      "--project", "projects/test",
      "--clear-cache",
    ]);
    expect(result.clearCache).toBe(true);
    expect(result.noCache).toBe(false);
  });

  it("default: both cache flags are false", () => {
    const result = parseArgs([
      "node", "analyze.ts",
      "video.mp4",
      "--project", "projects/test",
    ]);
    expect(result.noCache).toBe(false);
    expect(result.clearCache).toBe(false);
  });
});

// ── Cache-hit filtering logic (integration-level unit test) ────────

describe("cache-hit filtering", () => {
  it("identifies cached assets and filters new ones", () => {
    // Simulate the ingest + cache check flow from runPipeline
    const allShards = [
      { asset: { asset_id: "AST_001", duration_us: 5_000_000 }, sourceFile: "/path/a.mp4" },
      { asset: { asset_id: "AST_002", duration_us: 3_000_000 }, sourceFile: "/path/b.mp4" },
      { asset: { asset_id: "AST_003", duration_us: 7_000_000 }, sourceFile: "/path/c.mp4" },
    ];

    const manifest: CacheManifestEntry[] = [
      { hash: "hash_for_a", asset_id: "AST_001", cached_at: "2024-01-01T00:00:00Z", source_path: "/path/a.mp4" },
      { hash: "hash_for_c", asset_id: "AST_003", cached_at: "2024-01-01T00:00:00Z", source_path: "/path/c.mp4" },
    ];

    // Simulate hash lookup (in reality, computeCacheHash would be called)
    const hashMap: Record<string, string> = {
      AST_001: "hash_for_a",
      AST_002: "hash_for_b_new",
      AST_003: "hash_for_c",
    };

    const cacheHitIds = new Set<string>();
    for (const shard of allShards) {
      const hash = hashMap[shard.asset.asset_id];
      const entry = lookupCache(manifest, hash);
      if (entry && entry.asset_id === shard.asset.asset_id) {
        cacheHitIds.add(shard.asset.asset_id);
      }
    }

    const newShards = allShards.filter(
      (s) => !cacheHitIds.has(s.asset.asset_id),
    );

    expect(cacheHitIds.size).toBe(2);
    expect(cacheHitIds.has("AST_001")).toBe(true);
    expect(cacheHitIds.has("AST_003")).toBe(true);
    expect(newShards).toHaveLength(1);
    expect(newShards[0].asset.asset_id).toBe("AST_002");
  });

  it("--no-cache: empty manifest means no hits", () => {
    const noCache = true;
    const manifest = noCache ? [] : loadCacheManifest("/irrelevant/path");
    expect(manifest).toEqual([]);

    // With empty manifest, lookup always returns undefined
    expect(lookupCache(manifest, "any_hash")).toBeUndefined();
  });

  it("hash mismatch (file modified) → cache miss", () => {
    const manifest: CacheManifestEntry[] = [
      { hash: "old_hash", asset_id: "AST_001", cached_at: "2024-01-01T00:00:00Z", source_path: "a.mp4" },
    ];

    // File was modified → different hash
    const currentHash = "new_hash_after_edit";
    const entry = lookupCache(manifest, currentHash);
    expect(entry).toBeUndefined();
  });
});
