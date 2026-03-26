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

// ── Cross-process advisory lock (filesystem-based) ──────────────────

interface LockPayload {
  pid: number;
  operation: string;
  holder: string;
  acquired_at: string;
}

/**
 * Resolve the lock file path for a project directory.
 * Lock file sits alongside timeline.json.
 */
function lockFilePath(projectDir: string): string {
  return path.join(projectDir, "05_timeline", "timeline.json.lock");
}

/** Check whether a process with the given PID is still alive. */
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Try to read and parse an existing lock file. Returns null if absent or unparseable. */
function readLockFile(lockPath: string): LockPayload | null {
  try {
    const raw = fs.readFileSync(lockPath, "utf-8");
    return JSON.parse(raw) as LockPayload;
  } catch {
    return null;
  }
}

/**
 * Acquire a filesystem-based advisory lock for a project.
 * Creates `timeline.json.lock` with PID and operation metadata.
 * Automatically clears stale locks (PID no longer alive).
 */
export function acquireProjectLock(
  _projectId: string,
  kind: string,
  projectDir: string,
): boolean {
  const lockPath = lockFilePath(projectDir);

  // Check for existing lock
  const existing = readLockFile(lockPath);
  if (existing) {
    if (isPidAlive(existing.pid)) {
      return false; // Lock is held by a live process
    }
    // Stale lock — owner PID is dead, force release
    try { fs.unlinkSync(lockPath); } catch { /* ignore */ }
  }

  const payload: LockPayload = {
    pid: process.pid,
    operation: kind,
    holder: `editor-server:${process.pid}`,
    acquired_at: new Date().toISOString(),
  };

  try {
    const dir = path.dirname(lockPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    // O_EXCL: fail if file was created between our check and write
    fs.writeFileSync(lockPath, JSON.stringify(payload, null, 2), {
      flag: "wx",
    });
    return true;
  } catch {
    // Another process grabbed it between check and write — that's fine
    return false;
  }
}

/**
 * Release the advisory lock by deleting the lock file.
 */
export function releaseProjectLock(
  _projectId: string,
  projectDir: string,
): void {
  const lockPath = lockFilePath(projectDir);
  try {
    fs.unlinkSync(lockPath);
  } catch {
    // Already removed or never existed
  }
}

/**
 * Read the current lock kind (operation) if the lock is held by a live process.
 * Returns undefined if no lock or lock is stale.
 */
export function getProjectLockKind(
  _projectId: string,
  projectDir: string,
): string | undefined {
  const lockPath = lockFilePath(projectDir);
  const existing = readLockFile(lockPath);
  if (!existing) return undefined;

  if (!isPidAlive(existing.pid)) {
    // Stale — clean up
    try { fs.unlinkSync(lockPath); } catch { /* ignore */ }
    return undefined;
  }
  return existing.operation;
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
