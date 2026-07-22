import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SourceContentIdentityCache } from "../runtime/source-content-identity.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function fixture(name: string, contents: string): { dir: string; file: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `vos-identity-${name}-`));
  tempDirs.push(dir);
  const file = path.join(dir, "source.mp4");
  fs.writeFileSync(file, contents);
  return { dir, file };
}

function digest(contents: string): string {
  return createHash("sha256").update(contents).digest("hex");
}

describe("SourceContentIdentityCache primed identity validation", () => {
  it("returns an unchanged primed identity without invoking the hash function", () => {
    const { file } = fixture("unchanged", "original");
    const stat = fs.statSync(file);
    let hashCalls = 0;
    const cache = new SourceContentIdentityCache(() => {
      hashCalls += 1;
      return "unexpected";
    });
    cache.prime({
      absolutePath: file,
      sha256: digest("original"),
      sizeBytes: stat.size,
      mtimeMs: Math.round(stat.mtimeMs),
    });

    expect(cache.resolve(file).sha256).toBe(digest("original"));
    expect(hashCalls).toBe(0);
  });

  it("rehashes once and updates the identity when size or rounded mtime changes", () => {
    const { file } = fixture("changed", "old");
    const before = fs.statSync(file);
    let hashCalls = 0;
    const cache = new SourceContentIdentityCache((target) => {
      hashCalls += 1;
      return digest(fs.readFileSync(target, "utf-8"));
    });
    cache.prime({
      absolutePath: file,
      sha256: digest("old"),
      sizeBytes: before.size,
      mtimeMs: Math.round(before.mtimeMs),
    });
    fs.writeFileSync(file, "new-and-longer");
    fs.utimesSync(file, before.atime, new Date(before.mtimeMs + 2_000));

    const changed = cache.resolve(file);
    expect(changed.sha256).toBe(digest("new-and-longer"));
    expect(changed.sizeBytes).toBe(Buffer.byteLength("new-and-longer"));
    expect(hashCalls).toBe(1);
    expect(cache.resolve(file)).toEqual(changed);
    expect(hashCalls).toBe(1);
  });

  it("hard-fails for a non-file or disappeared primed path without hashing", () => {
    const { dir, file } = fixture("missing", "source");
    const stat = fs.statSync(file);
    let hashCalls = 0;
    const cache = new SourceContentIdentityCache(() => {
      hashCalls += 1;
      return "unexpected";
    });
    cache.prime({ absolutePath: file, sha256: digest("source"), sizeBytes: stat.size, mtimeMs: Math.round(stat.mtimeMs) });
    fs.unlinkSync(file);
    expect(() => cache.resolve(file)).toThrow();

    cache.prime({ absolutePath: dir, sha256: digest("directory"), sizeBytes: 0, mtimeMs: Math.round(fs.statSync(dir).mtimeMs) });
    expect(() => cache.resolve(dir)).toThrow("source_content_identity_requires_file:");
    expect(hashCalls).toBe(0);
  });
});
