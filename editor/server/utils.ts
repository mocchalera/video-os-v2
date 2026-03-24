/**
 * Shared server utilities: path traversal guard + per-project lock.
 */

import * as path from "node:path";

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
