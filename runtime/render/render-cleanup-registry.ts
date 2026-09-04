import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ChildProcess } from "node:child_process";

/**
 * Active-render cleanup registry (Issue 33 audit follow-ups).
 *
 * A JS `finally` cannot run when the process dies from an OS signal
 * (SIGINT/SIGTERM terminate the event loop without unwinding), so
 * task-owned still-camera temp directories and partial outputs would
 * otherwise leak. This registry tracks EXPLICITLY registered paths and
 * installs signal handlers that synchronously remove exactly the registered
 * paths — no globs, no scanning — before terminating with honest signal
 * semantics. When cleanup succeeds, the handler removes itself and re-raises
 * the same signal, so the process dies NATIVELY BY that signal (a parent
 * observes signal=SIGINT/SIGTERM, exit code null — true WIFSIGNALED). A failed
 * cleanup is reported once; the signal handler removes itself before any
 * re-raise, so a retained entry cannot recursively deliver the same signal.
 *
 * Validation is evidence-based, never caller-claimed. Facts (kind, temp
 * root, approved prefix) are derived here and stored; cleanup honors the
 * stored facts:
 * - Directory targets must ALREADY EXIST as a real (non-symlink) directory
 *   directly under the exact allowed temp root (os.tmpdir()) with an
 *   approved task-owned basename prefix, and are removed recursively.
 * - File targets need an absolute, normalized path with a safe non-root
 *   existing parent; if the target exists it must be a regular (non-symlink)
 *   file, and it is removed non-recursively (unlink semantics).
 * - Raw relative paths, empty/dot/dot-dot segments, non-normalized paths,
 *   cwd, home, the temp root itself, and the filesystem root are rejected
 *   before anything is registered.
 *
 * Scope guarantees:
 * - Only registered paths are ever removed.
 * - Registration/unregistration is deterministic (Map keyed by resolved
 *   path) and idempotent (duplicate register / unknown unregister are
 *   no-ops); concurrent renders simply share the registry.
 * - Signal listeners exist only while at least one path is registered
 *   (installed on first registration, removed whenever the registry
 *   empties — via unregister AND via direct or signal-time cleanup), so
 *   idle processes and unrelated code are unaffected. A signal-time failure
 *   removes the handling listener before native re-raise; the retained entry
 *   remains available to a direct retry.
 * - If other listeners exist for a signal at delivery time, the handler
 *   cleans up and uninstalls ONLY its own listeners — it never exits,
 *   re-raises, or double-delivers a signal that unrelated listeners own.
 */

export type RenderCleanupPathKind = "dir" | "file";

interface RenderCleanupEntry {
  path: string;
  /** Validated fact, not the caller's claim: dirs remove recursively, files non-recursively. */
  kind: RenderCleanupPathKind;
  /** Validated fact: the parent/root directory the target was accepted under. */
  ownerRoot: string;
  /** Validated fact: the approved task-owned basename prefix (dirs only). */
  approvedPrefix: string | null;
}

/**
 * The ONLY directory root where task-owned temp dirs may live. Resolved
 * dynamically so a per-test private TMPDIR (set before validation) scopes
 * the root without changing production behavior.
 */
function allowedTempRoot(): string {
  return path.resolve(os.tmpdir());
}
/** Approved task-owned temp directory basename prefixes. */
const ALLOWED_DIR_PREFIXES = [
  "vos-still-base-",
  "vos-still-warp-",
  "vos-still-render-inputs-",
  "vos-assembler-",
] as const;

const entries = new Map<string, RenderCleanupEntry>();
const HANDLED_SIGNALS = ["SIGINT", "SIGTERM"] as const;
type HandledSignal = (typeof HANDLED_SIGNALS)[number];

interface RenderChildEntry {
  pid: number;
  label: string;
  child: ChildProcess;
  onSettled: () => void;
}

const renderChildren = new Map<number, RenderChildEntry>();
const CHILD_TERM_GRACE_MS = 2_000;
const CHILD_KILL_GRACE_MS = 1_000;

function reject(code: string, detail: string): never {
  throw new Error(`${code}:${detail}`);
}

function validateRawShape(rawTarget: string): string {
  if (typeof rawTarget !== "string" || rawTarget.trim().length === 0) {
    reject("render_cleanup_target_empty", String(rawTarget));
  }
  // Reject relative paths BEFORE any resolve — never guess a base dir.
  if (!path.isAbsolute(rawTarget)) {
    reject("render_cleanup_target_relative", rawTarget);
  }
  // Dot and dot-dot segments would silently widen the target.
  const segments = rawTarget.split(/[\\/]/);
  if (segments.some((segment) => segment === "." || segment === "..")) {
    reject("render_cleanup_target_dot_segment", rawTarget);
  }
  const resolved = path.resolve(rawTarget);
  if (resolved !== rawTarget) {
    // Non-normalized input (trailing slash, duplicate separators) — the
    // caller must pass the exact path it created.
    reject("render_cleanup_target_not_normalized", rawTarget);
  }
  return resolved;
}

function lstatOrNull(target: string): fs.Stats | undefined {
  return fs.lstatSync(target, { throwIfNoEntry: false });
}

function validateDirTarget(resolved: string): { ownerRoot: string; approvedPrefix: string } {
  const ownerRoot = path.dirname(resolved);
  if (ownerRoot !== allowedTempRoot()) {
    reject("render_cleanup_dir_root_not_allowed", resolved);
  }
  const base = path.basename(resolved);
  const approvedPrefix = ALLOWED_DIR_PREFIXES.find((prefix) => base.startsWith(prefix));
  if (!approvedPrefix) {
    reject("render_cleanup_dir_prefix_not_approved", base);
  }
  const stats = lstatOrNull(resolved);
  if (stats === undefined) {
    reject("render_cleanup_dir_missing", resolved);
  }
  if (stats.isSymbolicLink()) {
    reject("render_cleanup_dir_symlink", resolved);
  }
  if (!stats.isDirectory()) {
    reject("render_cleanup_dir_not_directory", resolved);
  }
  return { ownerRoot, approvedPrefix };
}

function validateFileTarget(resolved: string): { ownerRoot: string } {
  const forbiddenRoots = [os.homedir(), process.cwd(), allowedTempRoot(), path.parse(resolved).root];
  if (forbiddenRoots.some((root) => root !== "" && root === resolved)) {
    reject("render_cleanup_file_forbidden_root", resolved);
  }
  const ownerRoot = path.dirname(resolved);
  if (ownerRoot === path.parse(resolved).root) {
    reject("render_cleanup_file_parent_is_root", resolved);
  }
  const parentStats = lstatOrNull(ownerRoot);
  if (parentStats === undefined) {
    reject("render_cleanup_file_parent_missing", ownerRoot);
  }
  if (parentStats.isSymbolicLink() || !parentStats.isDirectory()) {
    reject("render_cleanup_file_parent_not_directory", ownerRoot);
  }
  const stats = lstatOrNull(resolved);
  if (stats !== undefined) {
    if (stats.isSymbolicLink()) {
      reject("render_cleanup_file_symlink", resolved);
    }
    if (!stats.isFile()) {
      reject("render_cleanup_file_not_regular", resolved);
    }
  }
  return { ownerRoot };
}

/**
 * Register one task-owned path for signal-time removal. The kind is a
 * claim that must survive evidence validation; the stored facts are what
 * cleanup honors. Idempotent: re-registering the same resolved path is a
 * no-op (already-stored facts are kept).
 */
export function registerRenderCleanupPath(rawTarget: string, claimedKind: RenderCleanupPathKind = "dir"): void {
  const resolved = validateRawShape(rawTarget);
  if (claimedKind !== "dir" && claimedKind !== "file") {
    reject("render_cleanup_kind_invalid", String(claimedKind));
  }
  if (entries.has(resolved)) {
    return; // idempotent
  }
  if (claimedKind === "dir") {
    const facts = validateDirTarget(resolved);
    entries.set(resolved, {
      path: resolved,
      kind: "dir",
      ownerRoot: facts.ownerRoot,
      approvedPrefix: facts.approvedPrefix,
    });
  } else {
    const facts = validateFileTarget(resolved);
    entries.set(resolved, {
      path: resolved,
      kind: "file",
      ownerRoot: facts.ownerRoot,
      approvedPrefix: null,
    });
  }
  ensureSignalHandlers();
}

/** Unregister a path (e.g. after normal cleanup). Idempotent no-op if absent. */
export function unregisterRenderCleanupPath(target: string): void {
  entries.delete(path.resolve(target));
  if (entries.size === 0) ensureNoSignalHandlers();
}

/**
 * Track one exact child created by the render process. The returned
 * ChildProcess is the ownership proof: cleanup signals this handle's PID only
 * and never discovers or signals processes by command text.
 */
export function registerRenderChild(
  child: ChildProcess | null | undefined,
  label = "render-child",
): void {
  const pid = child?.pid;
  if (!child || !Number.isInteger(pid) || (pid ?? 0) <= 0 || pid === process.pid) return;
  const existing = renderChildren.get(pid!);
  if (existing?.child === child) return;
  if (existing) unregisterRenderChild(existing.child);
  const onSettled = (): void => {
    const current = renderChildren.get(pid!);
    if (current?.child !== child) return;
    renderChildren.delete(pid!);
    child.removeListener("exit", onSettled);
    child.removeListener("error", onSettled);
  };
  child.once("exit", onSettled);
  child.once("error", onSettled);
  renderChildren.set(pid!, { pid: pid!, label, child, onSettled });
}

/** Unregister one exact child after its command has settled. */
export function unregisterRenderChild(child: ChildProcess | null | undefined): void {
  const pid = child?.pid;
  if (!child || !Number.isInteger(pid) || (pid ?? 0) <= 0) return;
  const current = renderChildren.get(pid!);
  if (!current || current.child !== child) return;
  renderChildren.delete(pid!);
  child.removeListener("exit", current.onSettled);
  child.removeListener("error", current.onSettled);
}

/** Number of exact render children currently owned by this process. */
export function registeredRenderChildCount(): number {
  return renderChildren.size;
}

function childIsLive(child: ChildProcess): boolean {
  return child.exitCode === null && child.signalCode === null;
}

function waitForRenderChildExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (!childIsLive(child)) return Promise.resolve(true);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (didExit: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.removeListener("exit", onExit);
      child.removeListener("error", onError);
      resolve(didExit || !childIsLive(child));
    };
    const onExit = (): void => finish(true);
    const onError = (): void => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    child.once("exit", onExit);
    child.once("error", onError);
    if (!childIsLive(child)) finish(true);
  });
}

interface RenderChildTermination {
  entry: RenderChildEntry;
  terminated: boolean;
  error?: string;
}

async function terminateOneRenderChild(
  entry: RenderChildEntry,
  signal: HandledSignal,
): Promise<RenderChildTermination> {
  if (!childIsLive(entry.child)) {
    unregisterRenderChild(entry.child);
    return { entry, terminated: true };
  }

  const errors: string[] = [];
  try {
    entry.child.kill(signal);
  } catch (error) {
    errors.push(`term:${String(error)}`);
  }
  let terminated = await waitForRenderChildExit(entry.child, CHILD_TERM_GRACE_MS);
  if (!terminated && childIsLive(entry.child)) {
    try {
      // Escalate only through the same positively-owned ChildProcess handle.
      entry.child.kill("SIGKILL");
    } catch (error) {
      errors.push(`kill:${String(error)}`);
    }
    terminated = await waitForRenderChildExit(entry.child, CHILD_KILL_GRACE_MS);
  }

  if (terminated || !childIsLive(entry.child)) {
    unregisterRenderChild(entry.child);
    return { entry, terminated: true, ...(errors.length > 0 ? { error: errors.join("|") } : {}) };
  }
  return {
    entry,
    terminated: false,
    error: errors.join("|") || "child_did_not_exit_after_exact_termination",
  };
}

export interface RenderChildCleanupOutcome {
  attempted: number;
  terminated: Array<{ pid: number; label: string }>;
  retained: Array<{ pid: number; label: string; error: string }>;
}

/**
 * Terminate every currently owned render child by its exact ChildProcess
 * handle, waiting for exit before path cleanup. This is intentionally
 * asynchronous so the public signal coordinator can finish child teardown
 * before it re-delivers the signal to itself.
 */
export async function terminateRegisteredRenderChildren(
  signal: HandledSignal,
): Promise<RenderChildCleanupOutcome> {
  const snapshot = [...renderChildren.values()].sort((a, b) => a.pid - b.pid);
  const results = await Promise.all(snapshot.map((entry) => terminateOneRenderChild(entry, signal)));
  const outcome: RenderChildCleanupOutcome = {
    attempted: snapshot.length,
    terminated: [],
    retained: [],
  };
  for (const result of results) {
    if (result.terminated) {
      outcome.terminated.push({ pid: result.entry.pid, label: result.entry.label });
    } else {
      outcome.retained.push({
        pid: result.entry.pid,
        label: result.entry.label,
        error: result.error ?? "child_termination_failed",
      });
    }
  }
  return outcome;
}

/** Number of currently registered paths (exposed for tests). */
export function registeredRenderCleanupCount(): number {
  return entries.size;
}

/** Whether the registry currently owns SIGINT/SIGTERM listeners (for tests). */
export function renderCleanupHasSignalListeners(): boolean {
  return HANDLED_SIGNALS.every((signal) =>
    process.listeners(signal).includes(handlerBySignal.get(signal)!),
  );
}

export interface RegistryCleanupOutcome {
  /** Registered paths this cleanup attempted to remove. */
  attempted: number;
  /** Paths confirmed removed; their entries were discarded. */
  removed: string[];
  /** Paths that could NOT be removed: entries are RETAINED (with their
   * signal listeners) for retry/evidence — a retained entry is an honest
   * partial outcome, never a claimed success. */
  retained: Array<{ path: string; error: string }>;
}

/**
 * Synchronously remove every registered path, honoring each entry's
 * VALIDATED kind: dirs recursively, files non-recursively (unlink). Every
 * path is attempted even after one fails; FAILED paths keep their registry
 * entries AND the registry's SIGINT/SIGTERM listeners (ownership is
 * retained for retry/evidence — never discarded on EPERM or any other
 * error), and the partial outcome is reported honestly. Direct cleanup leaves
 * listeners installed until a retry succeeds; signal-time handling removes
 * its own listener before any native re-raise. Unrelated listeners are never
 * touched.
 */
export function cleanupRegisteredRenderPathsSync(): RegistryCleanupOutcome {
  const snapshot = [...entries.values()].sort((a, b) => a.path.localeCompare(b.path));
  const outcome: RegistryCleanupOutcome = { attempted: snapshot.length, removed: [], retained: [] };
  for (const entry of snapshot) {
    try {
      if (entry.kind === "dir") {
        fs.rmSync(entry.path, { recursive: true, force: true });
      } else {
        fs.rmSync(entry.path, { force: true });
      }
      entries.delete(entry.path);
      outcome.removed.push(entry.path);
    } catch (error) {
      // Retain ownership: the entry stays until a retry succeeds. Direct
      // callers keep the listeners; signal handling removes only its own
      // listener before any native re-raise. The failure is never swallowed.
      outcome.retained.push({ path: entry.path, error: String(error) });
    }
  }
  if (entries.size === 0) ensureNoSignalHandlers();
  return outcome;
}

const signalTeardownsInFlight = new Set<HandledSignal>();

function handleSignal(signal: HandledSignal): void {
  // A signal can be delivered again while a handler is unwinding. Make the
  // registry teardown single-shot for this process and keep the failure
  // visible instead of entering a self-reentry loop.
  if (signalTeardownsInFlight.has(signal)) return;
  signalTeardownsInFlight.add(signal);
  try {
  // Decide BEFORE cleanup: cleanup empties the registry and uninstalls the
  // registry's own listeners, which would corrupt the check.
  const wasSoleListener = process.listenerCount(signal) === 1;
  const outcome = cleanupRegisteredRenderPathsSync();
  if (outcome.retained.length > 0) {
    process.stderr.write(
      `[render-cleanup] ${signal} cleanup retained ${outcome.retained.length}`
      + " path(s); ownership retained for retry\n",
    );
    // Do not leave the failing handler installed. If it owns termination,
    // removing it before the re-raise preserves native signal semantics while
    // preventing the same signal from re-entering this handler.
    const handler = handlerBySignal.get(signal)!;
    process.removeListener(signal, handler);
    if (wasSoleListener) process.kill(process.pid, signal);
    return;
  }
  // Honest exit semantics: when we are the ONLY listener for this signal,
  // re-raise so the process dies natively BY the signal (exit code null,
  // signal=<sig> to a waiting parent). Our own listeners were already
  // uninstalled by the cleanup above. When unrelated listeners exist we
  // neither exit nor re-raise — their handlers own the termination decision.
  if (wasSoleListener) {
    process.kill(process.pid, signal);
  }
  } finally {
    // This guards only the synchronous handler's active call. A later render
    // in a long-lived process must be able to handle the same signal again.
    signalTeardownsInFlight.delete(signal);
  }
}

const handlerBySignal = new Map<HandledSignal, () => void>();
for (const signal of HANDLED_SIGNALS) {
  handlerBySignal.set(signal, () => handleSignal(signal));
}

function ensureSignalHandlers(): void {
  for (const signal of HANDLED_SIGNALS) {
    const handler = handlerBySignal.get(signal)!;
    if (!process.listeners(signal).includes(handler)) {
      process.on(signal, handler);
    }
  }
}

function ensureNoSignalHandlers(): void {
  for (const signal of HANDLED_SIGNALS) {
    const handler = handlerBySignal.get(signal)!;
    if (process.listeners(signal).includes(handler)) {
      process.removeListener(signal, handler);
    }
  }
}

/** Disable this registry's handler for one signal before public re-delivery. */
export function disableRenderCleanupSignalHandler(signal: HandledSignal): void {
  const handler = handlerBySignal.get(signal);
  if (handler && process.listeners(signal).includes(handler)) {
    process.removeListener(signal, handler);
  }
}
