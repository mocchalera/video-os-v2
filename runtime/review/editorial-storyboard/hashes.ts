/**
 * Deterministic hashing helpers for the editorial storyboard projection.
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs";

/** Hash file bytes and return the repo-standard `sha256:<hex>` form. */
export function sha256FileHash(filePath: string): string {
  const hash = createHash("sha256");
  hash.update(fs.readFileSync(filePath));
  return `sha256:${hash.digest("hex")}`;
}

/**
 * Stable content hash of a parsed YAML/JSON document with selected fields
 * excluded (mirrors computeNormalizedJsonHash semantics from p1-manifest-coverage).
 */
export function normalizedJsonHash(value: unknown, exclude: string[] = []): string {
  const canonical = canonicalize(value, new Set(exclude));
  return `sha256:${createHash("sha256").update(JSON.stringify(canonical)).digest("hex")}`;
}

function canonicalize(value: unknown, exclude: Set<string>): unknown {
  if (Array.isArray(value)) return value.map((item) => canonicalize(item, exclude));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([key]) => !exclude.has(key))
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, canonicalize(nested, exclude)]),
    );
  }
  return value;
}
