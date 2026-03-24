/**
 * Shared server utilities: path traversal guard + per-project lock + atomic write.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";

// ── Path traversal prevention ────────────────────────────────────────

/**
 * Validate project ID and return resolved project directory.
 * Returns null if the ID would escape the projectsDir boundary.
 */
export function safeProjectDir(
  projectsDir: string,
  id: string,
): string | null {
  if (
    !id ||
    id.includes("..") ||
    id.includes("/") ||
    id.includes("\\") ||
    id.includes("\0")
  ) {
    return null;
  }
  const resolved = path.resolve(projectsDir, id);
  const normalizedBase = path.resolve(projectsDir) + path.sep;
  if (!resolved.startsWith(normalizedBase)) {
    return null;
  }
  return resolved;
}

// ── Per-project in-memory lock ───────────────────────────────────────

const projectLocks = new Map<string, string>();

export function acquireProjectLock(
  projectId: string,
  kind: string,
): boolean {
  if (projectLocks.has(projectId)) return false;
  projectLocks.set(projectId, kind);
  return true;
}

export function releaseProjectLock(projectId: string): void {
  projectLocks.delete(projectId);
}

export function getProjectLockKind(projectId: string): string | undefined {
  return projectLocks.get(projectId);
}

// ── Atomic file write (temp + rename) ──────────────────────────────

/**
 * Write content to filePath atomically using a temp file + rename.
 * This prevents partial writes on crash.
 */
export function atomicWriteFileSync(filePath: string, content: string): void {
  const dir = path.dirname(filePath);
  const tmpSuffix = `.tmp.${crypto.randomBytes(6).toString("hex")}`;
  const tmpPath = filePath + tmpSuffix;

  fs.writeFileSync(tmpPath, content, "utf-8");
  fs.renameSync(tmpPath, filePath);
}
