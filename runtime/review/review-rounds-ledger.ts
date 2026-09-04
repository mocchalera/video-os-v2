import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { validateAgainstSchema } from "../commands/shared.js";
import { canonicalJson, hashCanonical } from "./social-review-generation.js";

/**
 * Durable, append-only review-round history (Issue #29 Phase 6).
 *
 * Ledger: one immutable JSON event file per record inside
 * `06_review/review-rounds/`, named `<identity-without-prefix>.json` where
 * `identity = sha256:hashCanonical(record)`. Records carry no timestamps so a
 * re-derivation is byte-identical and re-appends are idempotent. Integrity is
 * a linked chain: each record binds `predecessor` (the previous record's
 * identity; genesis is null). Forks, orphan records, duplicate round
 * identities, identity/filename mismatches, and ANY unexpected directory
 * entry (symlink, subdirectory, foreign or stale temp file, invalid name)
 * fail closed as malformed evidence — the scope is never reported complete
 * over them. The ledger directory itself must be a real, contained directory.
 *
 * Response artifacts: every response event binds its own immutable durable
 * artifact under `06_review/review-round-responses/` (identity-named, same
 * idempotent atomic discipline). The singleton compatibility pointer
 * `06_review/review-response.json` never authenticates a round.
 *
 * Temp discipline: writers use unique `.tmp-<pid>-<uuid>` names and only ever
 * remove their own temp in `finally`, plus (for heal paths) reclaim temps
 * whose owning PID is provably dead. One writer never deletes another
 * writer's active temp.
 *
 * Heal serialization: supersession/heal operations run under a claimed lock
 * (`06_review/review-round-heal.lock`) with liveness proof so concurrent
 * retries are idempotent and cannot supersede the wrong round.
 */

export const REVIEW_ROUNDS_DIR = "06_review/review-rounds";
export const REVIEW_ROUND_RESPONSES_DIR = "06_review/review-round-responses";
const HEAL_LOCK_PATH = "06_review/review-round-heal.lock";
const SHA256 = /^sha256:[a-f0-9]{64}$/;
const EVENT_FILE = /^[0-9a-f]{64}\.json$/;

export type ReviewRoundEventType = "ask" | "response" | "superseded";

export interface ReviewRoundEventBinding {
  path: string;
  sha256: string;
}

export interface ReviewRoundAskEvent {
  version: "review-round-ask/v1";
  project_id: string;
  generation_id: string;
  review_identity: string;
  review_ready_receipt: ReviewRoundEventBinding;
  qa_receipt: ReviewRoundEventBinding & { status: string };
  output: ReviewRoundEventBinding;
  timeline: { path: string; version: string; hash: string };
  ask_id: string;
  ask_payload_sha256: string;
  predecessor: string | null;
}

export interface ReviewRoundResponseEvent {
  version: "review-round-response/v1";
  project_id: string;
  generation_id: string;
  review_identity: string;
  ask_event: string;
  ask_id: string;
  decision: "approve" | "request_changes" | "free_text";
  text: string | null;
  response_sha256: string;
  artifact: ReviewRoundEventBinding;
  predecessor: string;
}

export interface ReviewRoundSupersededEvent {
  version: "review-round-superseded/v1";
  project_id: string;
  generation_id: string;
  review_identity: string;
  ask_event: string;
  ask_id: string;
  reason: string;
  predecessor: string;
}

export type ReviewRoundEvent = ReviewRoundAskEvent | ReviewRoundResponseEvent | ReviewRoundSupersededEvent;

export interface ReviewRoundResponseArtifact {
  version: "review-round-response-artifact/v1";
  project_id: string;
  generation_id: string;
  review_identity: string;
  ask_event: string;
  ask_id: string;
  decision: "approve" | "request_changes" | "free_text";
  text: string | null;
  output: ReviewRoundEventBinding;
}

export interface VerifiedRoundEvent {
  identity: string;
  file: string;
  event: ReviewRoundEvent;
  /** Byte hash captured from the same immutable read snapshot. */
  sha256: string;
}

export interface ReviewRoundLedger {
  /** Events in canonical chain order (genesis first). */
  chain: VerifiedRoundEvent[];
  /** Events that could not be verified (parse/schema/identity/filename/unexpected entries). */
  malformed: Array<{ file: string; reason: string }>;
  /** Chain conflicts (fork, orphan, cycle, duplicate round identity). */
  conflicts: string[];
}

export function reviewRoundEventIdentity(event: ReviewRoundEvent): string {
  return hashCanonical(event);
}

export function reviewRoundResponseArtifactIdentity(artifact: ReviewRoundResponseArtifact): string {
  return hashCanonical(artifact);
}

export function reviewRoundIdentity(askEventIdentity: string, responseEventIdentity: string): string {
  return hashCanonical({ version: "review-round/v1", ask_event: askEventIdentity, response_event: responseEventIdentity });
}

export function reviewRoundResponseHash(input: { ask_id: string; decision: string; text: string | null }): string {
  return hashCanonical({ version: "review-round-decision/v1", ask_id: input.ask_id, decision: input.decision, text: input.text });
}

export function buildReviewRoundAskEvent(input: Omit<ReviewRoundAskEvent, "version">): ReviewRoundAskEvent {
  return { version: "review-round-ask/v1", ...input };
}

export function buildReviewRoundResponseEvent(input: Omit<ReviewRoundResponseEvent, "version">): ReviewRoundResponseEvent {
  return { version: "review-round-response/v1", ...input };
}

export function buildReviewRoundSupersededEvent(input: Omit<ReviewRoundSupersededEvent, "version">): ReviewRoundSupersededEvent {
  return { version: "review-round-superseded/v1", ...input };
}

export function buildReviewRoundResponseArtifact(input: Omit<ReviewRoundResponseArtifact, "version">): ReviewRoundResponseArtifact {
  return { version: "review-round-response-artifact/v1", ...input };
}

function containedRealRoot(projectDir: string, namespace: string): string {
  const projectRoot = fs.realpathSync(path.resolve(projectDir));
  const namespaceRoot = path.join(projectRoot, namespace);
  return namespaceRoot;
}

function reviewRoundLedgerDirectory(projectDir: string): string {
  return path.join(containedRealRoot(projectDir, "06_review"), "review-rounds");
}

export function reviewRoundLedgerDir(projectDir: string): string {
  return path.resolve(path.join(path.resolve(projectDir), REVIEW_ROUNDS_DIR));
}

export function reviewRoundEventPath(projectDir: string, identity: string): string {
  return path.join(reviewRoundLedgerDir(projectDir), `${identity.slice("sha256:".length)}.json`);
}

export function reviewRoundResponseArtifactPath(projectDir: string, identity: string): string {
  return path.resolve(path.join(path.resolve(projectDir), REVIEW_ROUND_RESPONSES_DIR), `${identity.slice("sha256:".length)}.json`);
}

interface ImmutableFileSnapshot {
  dev: number;
  ino: number;
  nlink: number;
  mode: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
}

function snapshotFile(filePath: string): ImmutableFileSnapshot {
  const stats = fs.lstatSync(filePath);
  return { dev: stats.dev, ino: stats.ino, nlink: stats.nlink, mode: stats.mode, size: stats.size, mtimeMs: stats.mtimeMs, ctimeMs: stats.ctimeMs };
}

function sameSnapshot(left: ImmutableFileSnapshot, right: ImmutableFileSnapshot): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.nlink === right.nlink
    && left.mode === right.mode && left.size === right.size
    && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

interface NamespaceComponentSnapshot {
  path: string;
  dev: number;
  ino: number;
  mode: number;
}

function sha256String(bytes: string): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function snapshotComponent(componentPath: string): NamespaceComponentSnapshot {
  const stats = fs.lstatSync(componentPath);
  return { path: componentPath, dev: stats.dev, ino: stats.ino, mode: stats.mode };
}

function sameComponent(left: NamespaceComponentSnapshot, right: NamespaceComponentSnapshot): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode;
}

type ContainedNamespaceInspection =
  | { ok: true; components: NamespaceComponentSnapshot[] }
  | { ok: false; reason: string };

/**
 * Capture every directory component between a real project root and one
 * evidence file.  The file itself is checked separately so the namespace
 * snapshot can reject a parent symlink or a directory swap as well as a
 * symlinked file.
 */
function snapshotContainedNamespace(filePath: string, containmentRoot: string): ContainedNamespaceInspection {
  let projectRoot: string;
  try {
    projectRoot = fs.realpathSync(path.resolve(containmentRoot));
  } catch (error) {
    return { ok: false, reason: `containment root is not resolvable: ${error instanceof Error ? error.message : String(error)}` };
  }
  const absolutePath = path.resolve(filePath);
  const relativePath = path.relative(projectRoot, absolutePath);
  if (relativePath.length === 0 || path.isAbsolute(relativePath)
    || relativePath === ".." || relativePath.startsWith(`..${path.sep}`)) {
    return { ok: false, reason: "evidence path escapes the project containment root" };
  }

  const components: NamespaceComponentSnapshot[] = [];
  const recordDirectory = (componentPath: string): string | null => {
    let stats: fs.Stats;
    try {
      stats = fs.lstatSync(componentPath);
    } catch (error) {
      return `evidence namespace component is not statable: ${error instanceof Error ? error.message : String(error)}`;
    }
    if (stats.isSymbolicLink()) return "evidence namespace component is a symlink; external indirection is forbidden";
    if (!stats.isDirectory()) return "evidence namespace component is not a directory";
    let real: string;
    try {
      real = fs.realpathSync(componentPath);
    } catch (error) {
      return `evidence namespace component is not resolvable: ${error instanceof Error ? error.message : String(error)}`;
    }
    if (real !== projectRoot && !real.startsWith(`${projectRoot}${path.sep}`)) {
      return "evidence namespace escapes the project containment root";
    }
    components.push({ path: componentPath, dev: stats.dev, ino: stats.ino, mode: stats.mode });
    return null;
  };

  let error = recordDirectory(projectRoot);
  if (error) return { ok: false, reason: error };
  let cumulative = projectRoot;
  const parentPath = path.dirname(relativePath);
  if (parentPath !== ".") {
    for (const part of parentPath.split(path.sep)) {
      cumulative = path.join(cumulative, part);
      error = recordDirectory(cumulative);
      if (error) return { ok: false, reason: error };
    }
  }
  return { ok: true, components };
}

function sameContainedNamespace(
  left: NamespaceComponentSnapshot[],
  right: NamespaceComponentSnapshot[],
): boolean {
  return left.length === right.length && left.every((component, index) => {
    const other = right[index];
    return other !== undefined && component.path === other.path && sameComponent(component, other);
  });
}

export type ImmutableRecordInspection =
  | { ok: true; bytes: string; sha256: string; document: unknown }
  | { ok: false; reason: string };

/**
 * Inspect one immutable identity-named evidence file with fail-closed
 * filesystem integrity checks: it must be a plain regular file (never a
 * symlink, device, or other non-regular entry) with exactly one link
 * (nlink === 1 — hardlinked evidence is rejected), resolvable inside its
 * namespace, and its inode identity (dev/ino/nlink/mode/size) must be
 * UNCHANGED across the read (hardlink swaps or mutation between checks fail).
 */
export function inspectImmutableRecordFile(filePath: string, containmentRoot?: string): ImmutableRecordInspection {
  const containedBefore = containmentRoot === undefined
    ? null
    : snapshotContainedNamespace(filePath, containmentRoot);
  if (containedBefore !== null && !containedBefore.ok) return containedBefore;

  const parentPath = path.dirname(filePath);
  let parentBefore: NamespaceComponentSnapshot;
  let before: ImmutableFileSnapshot;
  let stats: fs.Stats;
  try {
    stats = fs.lstatSync(filePath);
  } catch (error) {
    return { ok: false, reason: `evidence file is not statable: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (stats.isSymbolicLink()) {
    return { ok: false, reason: "evidence file is a symlink; external indirection is forbidden" };
  }
  if (!stats.isFile()) {
    return { ok: false, reason: "evidence file is not a regular file" };
  }
  if (stats.nlink !== 1) {
    return { ok: false, reason: `evidence file has nlink=${stats.nlink}; hardlinked evidence is forbidden` };
  }
  // Ancestry identity: the containing directory must itself be stable across
  // the read so a namespace swap cannot invalidate the snapshot silently.
  try {
    parentBefore = snapshotComponent(parentPath);
    before = snapshotFile(filePath);
  } catch (error) {
    return { ok: false, reason: `evidence namespace is not stable: ${error instanceof Error ? error.message : String(error)}` };
  }
  let bytes: string;
  try {
    bytes = fs.readFileSync(filePath, "utf8");
  } catch (error) {
    return { ok: false, reason: `evidence file is unreadable: ${error instanceof Error ? error.message : String(error)}` };
  }
  let after: ImmutableFileSnapshot;
  let parentAfter: NamespaceComponentSnapshot;
  try {
    after = snapshotFile(filePath);
    parentAfter = snapshotComponent(parentPath);
  } catch (error) {
    return { ok: false, reason: `evidence namespace changed during the read: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (!sameSnapshot(before, after)) {
    return { ok: false, reason: "evidence file changed (inode, link count, type, size, or timestamps) during the read" };
  }
  if (!sameComponent(parentBefore, parentAfter)) {
    return { ok: false, reason: "evidence parent directory changed during the read" };
  }
  if (containedBefore !== null) {
    const containedAfter = snapshotContainedNamespace(filePath, containmentRoot!);
    if (!containedAfter.ok) return containedAfter;
    if (!sameContainedNamespace(containedBefore.components, containedAfter.components)) {
      return { ok: false, reason: "evidence namespace changed during the read" };
    }
  }
  let document: unknown;
  try {
    document = JSON.parse(bytes);
  } catch (error) {
    return { ok: false, reason: `evidence file is unparseable: ${error instanceof Error ? error.message : String(error)}` };
  }
  // Hash comes from the exact captured bytes; callers never re-open.
  const sha256 = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  return { ok: true, bytes, sha256, document };
}

/**
 * Validate (and create where missing) every writer namespace component
 * fail-closed: each component must be a real directory — never a symlink,
 * hardlinked file, or device — whose cumulative realpath stays contained in
 * the project, and whose inode identity is captured for re-verification
 * after the write. Writers never follow root or nested symlinks.
 */
function assertWriterNamespace(projectDir: string, namespace: string): NamespaceComponentSnapshot[] {
  const projectRoot = fs.realpathSync(path.resolve(projectDir));
  const snapshot: NamespaceComponentSnapshot[] = [];
  const recordSnapshot = (componentPath: string): void => {
    const stats = fs.lstatSync(componentPath);
    if (stats.isSymbolicLink()) throw new Error(`review round namespace component is a symlink: ${componentPath}`);
    if (!stats.isDirectory()) throw new Error(`review round namespace component is not a directory: ${componentPath}`);
    snapshot.push({ path: componentPath, dev: stats.dev, ino: stats.ino, mode: stats.mode });
  };
  recordSnapshot(projectRoot);
  let cumulative = projectRoot;
  for (const part of namespace.split("/")) {
    cumulative = path.join(cumulative, part);
    if (fs.existsSync(cumulative)) {
      const stats = fs.lstatSync(cumulative);
      if (stats.isSymbolicLink()) throw new Error(`review round namespace component is a symlink: ${cumulative}`);
      if (!stats.isDirectory()) throw new Error(`review round namespace component is not a directory: ${cumulative}`);
    } else {
      fs.mkdirSync(cumulative);
    }
    const real = fs.realpathSync(cumulative);
    if (real !== projectRoot && !real.startsWith(`${projectRoot}${path.sep}`)) {
      throw new Error(`review round namespace escapes the project: ${cumulative}`);
    }
    recordSnapshot(cumulative);
  }
  return snapshot;
}

function assertNamespaceUnchanged(snapshot: NamespaceComponentSnapshot[]): void {
  for (const component of snapshot) {
    let stats: fs.Stats;
    try {
      stats = fs.lstatSync(component.path);
    } catch {
      throw new Error(`review round namespace changed during the write: ${component.path}`);
    }
    if (stats.dev !== component.dev || stats.ino !== component.ino
      || stats.mode !== component.mode || stats.isSymbolicLink() || !stats.isDirectory()) {
      throw new Error(`review round namespace changed during the write: ${component.path}`);
    }
  }
}

let cachedProcessLstart: string | null | undefined;
const PROCESS_LSTART_MAX_OUTPUT_BYTES = 4 * 1024;
const PROCESS_LSTART_TIMEOUT_MS = 1_000;

/** Process start identity (lstart) so a reused PID can never impersonate a live claim owner. */
function processLstart(pid: number): string | null {
  if (pid === process.pid) {
    // A transient ps failure must not poison this process forever. A valid
    // identity remains safely reusable, while null is probed again on retry.
    if (cachedProcessLstart !== undefined) return cachedProcessLstart;
    const observed = readProcessLstart(pid);
    if (observed !== null) cachedProcessLstart = observed;
    return observed;
  }
  return readProcessLstart(pid);
}

/** Process start identity probe used by the lock owner-verification path. */
export function processLstartOf(pid: number): string | null {
  return processLstart(pid);
}

function readProcessLstart(pid: number): string | null {
  const result = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], {
    encoding: "utf8",
    maxBuffer: PROCESS_LSTART_MAX_OUTPUT_BYTES,
    timeout: PROCESS_LSTART_TIMEOUT_MS,
  });
  if (result.error !== undefined || result.status !== 0 || result.signal !== null
    || typeof result.stdout !== "string" || typeof result.stderr !== "string"
    || result.stderr.length !== 0
    || Buffer.byteLength(result.stdout, "utf8") > PROCESS_LSTART_MAX_OUTPUT_BYTES) return null;
  const match = result.stdout.match(
    /^(?<weekday>Mon|Tue|Wed|Thu|Fri|Sat|Sun)[ ](?<month>Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)(?:(?<singleDay>[ ]{2}[1-9])|(?<doubleDay>[ ](?:[12][0-9]|3[01])))[ ](?<hour>[0-9]{2}):(?<minute>[0-9]{2}):(?<second>[0-9]{2})[ ](?<year>[0-9]{4})(?:[ ]{4})?\n$/,
  );
  if (match === null || match.groups === undefined) return null;
  const { weekday, month, singleDay, doubleDay, hour, minute, second, year } = match.groups;
  const dayField = singleDay ?? doubleDay;
  if (dayField === undefined) return null;
  const day = Number(dayField);
  const monthIndex = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"].indexOf(month);
  const weekdayIndex = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(weekday);
  const numericYear = Number(year);
  const numericHour = Number(hour);
  const numericMinute = Number(minute);
  const numericSecond = Number(second);
  if (monthIndex < 0 || weekdayIndex < 0 || !Number.isInteger(day) || !Number.isInteger(numericYear)
    || !Number.isInteger(numericHour) || !Number.isInteger(numericMinute) || !Number.isInteger(numericSecond)) return null;
  const date = new Date(0);
  date.setUTCFullYear(numericYear, monthIndex, day);
  date.setUTCHours(numericHour, numericMinute, numericSecond, 0);
  if (!Number.isFinite(date.getTime()) || date.getUTCFullYear() !== numericYear || date.getUTCMonth() !== monthIndex
    || date.getUTCDate() !== day || date.getUTCHours() !== numericHour || date.getUTCMinutes() !== numericMinute
    || date.getUTCSeconds() !== numericSecond || date.getUTCDay() !== weekdayIndex) return null;
  return `${weekday} ${month}${dayField} ${hour}:${minute}:${second} ${year}`;
}

function isPidAlive(pid: number): boolean {
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Immutable identity-named file write shared by events and response
 * artifacts: atomic (fsync + link), idempotent, conflict-fail-closed. Temp
 * files are writer-owned (`.tmp-<pid>-<uuid>`); this function only ever
 * removes its own temp, plus reclaimable temps of provably dead writers.
 */
function writeIdentityNamedFile(projectDir: string, namespace: string, target: string, bytes: string, barrier?: () => void): { identity: string; file: string } {
  const boundProjectRoot = fs.realpathSync(path.resolve(projectDir));
  const activeHealLock = heldLocks.get(boundProjectRoot);
  if (activeHealLock) {
    return writeIdentityNamedFileAtHealHandle(boundProjectRoot, activeHealLock, target, bytes, barrier);
  }
  // A standalone append still gets one fixed namespace handle. The lifecycle
  // lock is not held in this compatibility path, but no write may fall back
  // to re-resolving target after the namespace has been inspected.
  const namespaceSnapshot = assertWriterNamespace(projectDir, namespace);
  const expectedDirectory = namespaceSnapshot[namespaceSnapshot.length - 1];
  if (!expectedDirectory) throw new Error(`review round namespace is empty: ${namespace}`);
  const directoryHandle = openHealDirectoryHandle(expectedDirectory.path);
  try {
    assertNamespaceUnchanged(namespaceSnapshot);
    const standaloneHeld: HeldHealLock = {
      uuid: "standalone",
      depth: 1,
      namespaceSnapshot,
      parentHandle: directoryHandle,
      directoryHandle,
    };
    const written = writeIdentityNamedFileAtHealHandle(boundProjectRoot, standaloneHeld, target, bytes, barrier, path.basename(target));
    assertNamespaceUnchanged(namespaceSnapshot);
    return written;
  } finally {
    closeHealDirectoryHandle(directoryHandle);
  }
}

/**
 * Reclaim only temporaries of provably dead writers. A live writer's temp is
 * never touched (ownership/liveness proof), so concurrent writers cannot
 * destroy each other's in-flight appends. Returns the number reclaimed.
 */
export function reclaimDeadWriterTemporaries(
  directory: string,
  expectedDir?: NamespaceComponentSnapshot,
  barrier?: () => void,
  projectRoot?: string,
): number {
  if (projectRoot) {
    const activeHealLock = heldLocks.get(projectRoot);
    if (activeHealLock) {
      return reclaimDeadWriterTemporariesAtHealHandle(
        projectRoot,
        activeHealLock,
        relativeHealPath(activeHealLock.directoryHandle, directory, activeHealLock.logicalProjectPath),
        barrier,
        undefined,
      );
    }
  }
  if (projectRoot) assertActiveHealBinding(projectRoot);
  if (!fs.existsSync(directory)) return 0;
  // Standalone sweep callers get the same fixed parent directory handle as a
  // lock-bound caller. There is no path-based unlink branch: even without an
  // active lifecycle lock, the child directory and every removal are rooted
  // at one opened 06_review generation.
  const directoryPath = path.resolve(directory);
  const parentHandle = openHealDirectoryHandle(path.dirname(directoryPath));
  try {
    return reclaimDeadWriterTemporariesAtHealHandle(
      projectRoot ?? "",
      { uuid: "standalone", depth: 1, logicalProjectPath: path.dirname(path.dirname(directoryPath)), namespaceSnapshot: [], parentHandle, directoryHandle: parentHandle },
      relativeHealPath(parentHandle, directoryPath),
      barrier,
      expectedDir,
    );
  } finally {
    closeHealDirectoryHandle(parentHandle);
  }
}

function reclaimDeadWriterTemporariesAtHealHandle(
  projectRoot: string,
  held: HeldHealLock,
  relativeDirectory: string,
  barrier?: () => void,
  expectedDirectory?: NamespaceComponentSnapshot,
): number {
  assertActiveHealBinding(projectRoot);
  const listing = listHealDirectoryAtHandle(held, relativeDirectory);
  if (listing.status === "missing") return 0;
  if (listing.status === "worker_failed") {
    throw new Error("review round maintenance sweep dependency failed; no path fallback is permitted");
  }
  if (listing.status !== "listed" || !listing.directory || !listing.entries) {
    throw new Error("review round maintenance sweep namespace identity could not be verified");
  }
  if (expectedDirectory
    && (listing.directory.dev !== expectedDirectory.dev || listing.directory.ino !== expectedDirectory.ino || listing.directory.mode !== expectedDirectory.mode)) {
    throw new Error("review round sweep directory was replaced after validation");
  }
  let reclaimed = 0;
  for (const entry of listing.entries) {
    if (!entry.regular || entry.symbolicLink) continue;
    const match = /\.tmp-(\d+)(?:-[0-9a-f-]+)?$/.exec(entry.name);
    if (!match) continue;
    const ownerPid = Number(match[1]);
    if (!Number.isInteger(ownerPid) || ownerPid === process.pid || isPidAlive(ownerPid)) continue;
    // Existing sweep callers use this barrier before final revalidation. The
    // active-lock hook below is the distinct final-check-to-delete seam.
    barrier?.();
    assertActiveHealBinding(projectRoot);
    held.beforeMaintenanceMutation?.();
    const removed = removeHealTemporaryAtHandle(
      held,
      relativeDirectory,
      listing.directory,
      entry,
      held.replaceTemporaryAfterFinalVerification,
    );
    if (removed !== "removed") {
      throw new Error(`review round maintenance temporary cleanup failed closed: ${removed}`);
    }
    reclaimed += 1;
    // A namespace swap at the seam must fail closed even though the helper
    // was safely bound to the retained original directory generation.
    assertActiveHealBinding(projectRoot);
  }
  assertActiveHealBinding(projectRoot);
  return reclaimed;
}

/**
 * Writer-side recovery: reclaim dead-writer temporaries before reading the
 * ledger. The metric reader never reclaims — it treats any foreign temp as
 * malformed evidence — but transaction heal paths must be able to complete a
 * rerun after a crash.
 */
export function sweepReviewRoundTemporaries(projectDir: string, barrier?: () => void): void {
  // Namespace guard FIRST: a symlinked or escaped review-rounds root must
  // make the sweep fail closed instead of enumerating/deleting outside.
  // The walk is read-only: missing components simply mean nothing to sweep.
  const projectRoot = fs.realpathSync(path.resolve(projectDir));
  assertActiveHealBinding(projectRoot);
  const activeHealLock = heldLocks.get(projectRoot);
  if (activeHealLock) {
    // Under a heal lock, even enumeration is rooted at the acquisition-time
    // 06_review handle. The path-based branch below remains for standalone
    // callers that have no lifecycle binding.
    reclaimDeadWriterTemporariesAtHealHandle(projectRoot, activeHealLock, "review-rounds", barrier);
    reclaimDeadWriterTemporariesAtHealHandle(projectRoot, activeHealLock, "review-round-responses", barrier);
    return;
  }
  let cumulative = projectRoot;
  for (const part of ["06_review", "review-rounds"]) {
    cumulative = path.join(cumulative, part);
    if (!fs.existsSync(cumulative)) return;
    const stats = fs.lstatSync(cumulative);
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw new Error(`review round namespace component is not a real directory: ${cumulative}`);
    }
    const real = fs.realpathSync(cumulative);
    if (real !== projectRoot && !real.startsWith(`${projectRoot}${path.sep}`)) {
      throw new Error(`review round namespace escapes the project: ${cumulative}`);
    }
  }
  const roundsSnapshot = snapshotComponent(cumulative);
  reclaimDeadWriterTemporaries(cumulative, roundsSnapshot, barrier, projectRoot);
  const responsesRoot = path.join(path.dirname(cumulative), "review-round-responses");
  if (!fs.existsSync(responsesRoot)) return;
  const responseStats = fs.lstatSync(responsesRoot);
  if (responseStats.isSymbolicLink() || !responseStats.isDirectory()) {
    throw new Error("review round response artifact namespace is not a real directory; sweep refused");
  }
  const responseReal = fs.realpathSync(responsesRoot);
  if (responseReal !== projectRoot && !responseReal.startsWith(`${projectRoot}${path.sep}`)) {
    throw new Error("review round response artifact namespace escapes the project; sweep refused");
  }
  reclaimDeadWriterTemporaries(responsesRoot, snapshotComponent(responsesRoot), barrier, projectRoot);
}

export function appendReviewRoundEvent(projectDir: string, event: ReviewRoundEvent): { identity: string; file: string } {
  return appendReviewRoundEventInternal(projectDir, event);
}

/** @internal deterministic barrier seam for hostile tests (post-guard/pre-publish). */
export function appendReviewRoundEventInternal(projectDir: string, event: ReviewRoundEvent, barrier?: () => void): { identity: string; file: string } {
  const identity = reviewRoundEventIdentity(event);
  if (!SHA256.test(identity)) throw new Error("review round event identity must be a sha256 identity");
  const target = reviewRoundEventPath(projectDir, identity);
  const written = writeIdentityNamedFile(projectDir, REVIEW_ROUNDS_DIR, target, `${JSON.stringify(event, null, 2)}\n`, barrier);
  return { identity, file: written.file };
}

export function appendReviewRoundResponseArtifact(
  projectDir: string,
  artifact: ReviewRoundResponseArtifact,
  barrier?: () => void,
): { identity: string; file: string } {
  const identity = reviewRoundResponseArtifactIdentity(artifact);
  if (!SHA256.test(identity)) throw new Error("review round response artifact identity must be a sha256 identity");
  const target = reviewRoundResponseArtifactPath(projectDir, identity);
  return writeIdentityNamedFile(projectDir, REVIEW_ROUND_RESPONSES_DIR, target, `${JSON.stringify(artifact, null, 2)}\n`, barrier);
}

export function readReviewRoundLedger(projectDirInput: string): ReviewRoundLedger {
  const projectDir = path.resolve(projectDirInput);
  const ledger: ReviewRoundLedger = { chain: [], malformed: [], conflicts: [] };
  let ledgerDir: string;
  try {
    ledgerDir = reviewRoundLedgerDirectory(projectDir);
  } catch {
    return ledger;
  }
  if (!fs.existsSync(ledgerDir) || !fs.statSync(ledgerDir).isDirectory()) return ledger;
  // The ledger directory itself must be a real, canonical, contained
  // directory: reject symlinks, escapes, and identity changes mid-snapshot.
  if (fs.lstatSync(ledgerDir).isSymbolicLink()) {
    ledger.malformed.push({ file: REVIEW_ROUNDS_DIR, reason: "ledger directory is a symlink; external ledger roots are forbidden" });
    return ledger;
  }
  const ledgerRoot = fs.realpathSync(ledgerDir);
  const projectRoot = fs.realpathSync(path.resolve(projectDir));
  if (ledgerRoot !== path.join(projectRoot, "06_review", "review-rounds")) {
    ledger.malformed.push({ file: REVIEW_ROUNDS_DIR, reason: "ledger directory resolves outside the canonical review-round namespace" });
    return ledger;
  }
  const byIdentity = new Map<string, VerifiedRoundEvent>();
  const seenPaths = new Set<string>();
  const entries = fs.readdirSync(ledgerDir, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name, "en"));
  for (const entry of entries) {
    const filePath = path.join(ledgerDir, entry.name);
    if (!entry.isFile() || entry.isSymbolicLink() || fs.lstatSync(filePath).isSymbolicLink()) {
      ledger.malformed.push({ file: entry.name, reason: "unexpected non-regular entry in the immutable ledger directory" });
      continue;
    }
    let real: string;
    try {
      real = fs.realpathSync(filePath);
    } catch {
      ledger.malformed.push({ file: entry.name, reason: "ledger entry is not resolvable within the ledger root" });
      continue;
    }
    if (real !== path.join(ledgerRoot, entry.name)) {
      ledger.malformed.push({ file: entry.name, reason: "ledger entry escapes the immutable ledger root" });
      continue;
    }
    // Interrupted-append temporaries and any invalid name are malformed
    // evidence of an unfinished write; the scope is never reported complete
    // while they exist. Dead-writer temps are reclaimed by heal paths only.
    if (!EVENT_FILE.test(entry.name)) {
      ledger.malformed.push({ file: entry.name, reason: "unexpected file in the immutable ledger directory" });
      continue;
    }
    if (seenPaths.has(entry.name)) continue;
    seenPaths.add(entry.name);
    const inspection = inspectImmutableRecordFile(filePath);
    if (!inspection.ok) {
      ledger.malformed.push({ file: entry.name, reason: inspection.reason });
      continue;
    }
    const parsed = inspection.document;
    const validation = validateAgainstSchema(parsed, "review-round-event.schema.json");
    if (!validation.valid) {
      ledger.malformed.push({ file: entry.name, reason: `schema: ${validation.errors.slice(0, 2).join("; ")}` });
      continue;
    }
    const event = parsed as ReviewRoundEvent;
    const identity = reviewRoundEventIdentity(event);
    if (!SHA256.test(identity)) {
      ledger.malformed.push({ file: entry.name, reason: "identity is not a sha256 hash" });
      continue;
    }
    if (`${identity.slice("sha256:".length)}.json` !== entry.name) {
      ledger.malformed.push({ file: entry.name, reason: "identity does not match the immutable record filename" });
      continue;
    }
    if (byIdentity.has(identity)) {
      ledger.conflicts.push(`duplicate round event identity: ${identity}`);
      continue;
    }
    byIdentity.set(identity, { identity, file: entry.name, event, sha256: inspection.sha256 });
  }

  // Chain walk: exactly one genesis, unique successors, total reachability.
  const genesis = [...byIdentity.values()].filter((entry) => entry.event.predecessor === null);
  if (byIdentity.size > 0 && genesis.length !== 1) {
    ledger.conflicts.push(`expected exactly one genesis record, found ${genesis.length}`);
    return ledger;
  }
  const successorOf = new Map<string, VerifiedRoundEvent>();
  for (const entry of byIdentity.values()) {
    const predecessor = entry.event.predecessor;
    if (predecessor === null) continue;
    if (!SHA256.test(predecessor) || !byIdentity.has(predecessor)) {
      ledger.conflicts.push(`orphan round event ${entry.identity}: predecessor is missing`);
      continue;
    }
    if (successorOf.has(predecessor)) {
      ledger.conflicts.push(`forked round history at ${predecessor}`);
      continue;
    }
    successorOf.set(predecessor, entry);
  }
  if (ledger.conflicts.length > 0) return ledger;
  const chain: VerifiedRoundEvent[] = [];
  const visited = new Set<string>();
  let cursor: VerifiedRoundEvent | null = genesis[0] ?? null;
  while (cursor) {
    if (visited.has(cursor.identity)) {
      ledger.conflicts.push(`cycle in round history at ${cursor.identity}`);
      return ledger;
    }
    visited.add(cursor.identity);
    chain.push(cursor);
    cursor = successorOf.get(cursor.identity) ?? null;
  }
  if (visited.size !== byIdentity.size) {
    const unreachable = [...byIdentity.values()].filter((entry) => !visited.has(entry.identity));
    ledger.conflicts.push(`unreachable round events: ${unreachable.map((entry) => entry.identity).sort().join(", ")}`);
    return ledger;
  }
  ledger.chain = chain;
  return ledger;
}

/** Identity of the current chain head, or null for an empty/absent ledger. Throws on conflicts. */
export function reviewRoundLedgerHead(projectDir: string): string | null {
  const ledger = readReviewRoundLedger(projectDir);
  if (ledger.malformed.length > 0) {
    throw new Error(`review round history is malformed: ${ledger.malformed[0]?.file} ${ledger.malformed[0]?.reason}`);
  }
  if (ledger.conflicts.length > 0) {
    throw new Error(`review round history conflict: ${ledger.conflicts[0]}`);
  }
  return ledger.chain.length > 0 ? ledger.chain[ledger.chain.length - 1]!.identity : null;
}

export function findReviewRoundAskEvents(ledger: ReviewRoundLedger): VerifiedRoundEvent[] {
  return ledger.chain.filter((entry) => entry.event.version === "review-round-ask/v1");
}

export function canonicalEventJson(event: ReviewRoundEvent): string {
  return canonicalJson(event);
}

const HEAL_LOCK_RETRY_MS = 20;
const HEAL_LOCK_TIMEOUT_MS = 30_000;

interface HealClaimSnapshot {
  bytes: string;
  dev: number;
  ino: number;
  mode: number;
  nlink: number;
}

interface HealDirectoryHandleSnapshot {
  fd: number;
  path: string;
  dev: number;
  ino: number;
  mode: number;
}

type HealClaimReleaseStatus = "removed" | "absent" | "mismatch" | "residual_own" | "residual_foreign" | "worker_failed";

type HealClaimPythonStatus = "acquired" | "busy" | "absent" | "present" | "removed" | "mismatch" | "residual_own" | "residual_foreign" | "worker_failed";

interface HealClaimReleaseResult {
  status: HealClaimReleaseStatus;
}

interface HealClaimPythonResult {
  status: HealClaimPythonStatus;
  bytes?: string;
  dev?: number;
  ino?: number;
  mode?: number;
  nlink?: number;
}

interface HealMutationEntry {
  name: string;
  regular: boolean;
  symbolicLink: boolean;
  sha256: string | null;
  dev: number;
  ino: number;
  mode: number;
  nlink: number;
  size: number;
}

interface HealMutationDirectory {
  dev: number;
  ino: number;
  mode: number;
}

interface HealMutationFile {
  sha256: string;
  dev: number;
  ino: number;
  mode: number;
  nlink: number;
  size: number;
}

type HealMutationPythonStatus = "written" | "existing" | "missing" | "removed" | "absent" | "present" | "residual_own" | "residual_foreign" | "listed" | "mismatch" | "worker_failed";

interface HealMutationPythonResult {
  status: HealMutationPythonStatus;
  directory?: HealMutationDirectory;
  entries?: HealMutationEntry[];
  file?: HealMutationFile;
}

/** @internal deterministic hostile-test seams; production callers leave this unset. */
export interface ReviewRoundHealLockHostileHooks {
  afterDirectoryHandleOpen?: () => void;
  beforeOperation?: () => void;
  /** Fires after the final maintenance identity check and before mutation. */
  beforeMaintenanceMutation?: () => void;
  /** Creates a hostile private-name collision before acquire O_EXCL. */
  beforeClaimTempCreate?: (tempName: string) => void;
  /** Creates a hostile private-name collision before write O_EXCL. */
  beforeMaintenanceTempCreate?: (tempName: string) => void;
  /** Fires after the release identity check and before invoking the helper. */
  beforeReleaseUnlink?: () => void;
  /** Replace the claim after the helper's first identity verification. */
  replaceClaimAfterVerification?: string;
  /** Replace the claim after the helper's final identity verification. */
  replaceClaimAfterFinalVerification?: string;
  /** Replace a sweep target after its final captured-identity verification. */
  replaceTemporaryAfterFinalVerification?: string;
}

interface HeldHealLock {
  uuid: string;
  depth: number;
  logicalProjectPath?: string;
  namespaceSnapshot: NamespaceComponentSnapshot[];
  parentHandle: HealDirectoryHandleSnapshot;
  directoryHandle: HealDirectoryHandleSnapshot;
  beforeMaintenanceMutation?: () => void;
  beforeMaintenanceTempCreate?: (tempName: string) => void;
  replaceTemporaryAfterFinalVerification?: string;
}

const HEAL_DIRECTORY_OPEN_FLAGS = fs.constants.O_RDONLY
  | (fs.constants.O_DIRECTORY ?? 0)
  | (fs.constants.O_NOFOLLOW ?? 0);
const HEAL_LOCK_NAME = path.basename(HEAL_LOCK_PATH);

function sameHealClaimSnapshot(left: HealClaimSnapshot, right: HealClaimSnapshot): boolean {
  return left.bytes === right.bytes && left.dev === right.dev && left.ino === right.ino
    && left.mode === right.mode && left.nlink === right.nlink;
}

function openHealDirectoryHandle(directoryPath: string): HealDirectoryHandleSnapshot {
  const fd = fs.openSync(directoryPath, HEAL_DIRECTORY_OPEN_FLAGS);
  try {
    const handleStats = fs.fstatSync(fd);
    const nominalStats = fs.lstatSync(directoryPath);
    if (!handleStats.isDirectory() || handleStats.isSymbolicLink()
      || nominalStats.isSymbolicLink() || !nominalStats.isDirectory()
      || handleStats.dev !== nominalStats.dev || handleStats.ino !== nominalStats.ino
      || handleStats.mode !== nominalStats.mode) {
      throw new Error(`review round heal namespace directory changed while opening: ${directoryPath}`);
    }
    return { fd, path: directoryPath, dev: handleStats.dev, ino: handleStats.ino, mode: handleStats.mode };
  } catch (error) {
    fs.closeSync(fd);
    throw error;
  }
}

function assertHealDirectoryHandle(handle: HealDirectoryHandleSnapshot, label: string): void {
  const stats = fs.fstatSync(handle.fd);
  if (!stats.isDirectory() || stats.isSymbolicLink()
    || stats.dev !== handle.dev || stats.ino !== handle.ino || stats.mode !== handle.mode) {
    throw new Error(`review round heal ${label} directory handle identity changed`);
  }
}

function closeHealDirectoryHandle(handle: HealDirectoryHandleSnapshot | null): void {
  if (!handle) return;
  try {
    fs.closeSync(handle.fd);
  } catch {
    // Closing an already-closed descriptor is not a claim-release failure.
  }
}

const heldLocks = new Map<string, HeldHealLock>();

function assertActiveHealBinding(projectRoot: string): void {
  const held = heldLocks.get(projectRoot);
  if (!held) return;
  assertHealDirectoryHandle(held.parentHandle, "active parent");
  assertHealDirectoryHandle(held.directoryHandle, "active claim");
  assertNamespaceUnchanged(held.namespaceSnapshot);
}

// Node does not expose the directory-fd forms of the POSIX operations needed
// for lock claims. This helper receives the already-open acquisition directory
// as fd 3 and performs EVERY claim operation relative to that fd. If Python or
// its dir_fd support is unavailable, callers fail closed; there is no path
// fallback. Release/reclaim keeps the opened claim fd alive through the
// identity recheck and atomically quarantines the public name before unlinking;
// residual state is then verified through the same directory fd.
const HEAL_CLAIM_PYTHON = String.raw`
import base64
import ctypes
import errno
import fcntl
import hashlib
import json
import os
import stat
import sys

payload = json.loads(sys.argv[1])
directory_fd = 3
no_follow = getattr(os, "O_NOFOLLOW", None)
if no_follow is None:
    raise RuntimeError("required no-follow flag is unavailable")

def read_input():
    raw = sys.stdin.buffer.read()
    expected_size = payload.get("input_bytes")
    expected_hash = payload.get("input_sha256")
    if (not isinstance(expected_size, int) or isinstance(expected_size, bool)
            or expected_size < 0 or not isinstance(expected_hash, str)
            or len(raw) != expected_size
            or "sha256:" + hashlib.sha256(raw).hexdigest() != expected_hash):
        raise RuntimeError("claim helper input envelope mismatch")
    return raw

def input_object(required, optional=()):
    try:
        value = json.loads(read_input().decode("utf-8"))
    except Exception as error:
        raise RuntimeError("claim helper control input is not JSON") from error
    if not isinstance(value, dict):
        raise RuntimeError("claim helper control input is not an object")
    allowed = set(required) | set(optional)
    if set(value.keys()) != allowed and not (set(required) <= set(value.keys()) <= allowed):
        raise RuntimeError("claim helper control input schema mismatch")
    if any(not isinstance(value[key], str) for key in required):
        raise RuntimeError("claim helper control input field type mismatch")
    for key in optional:
        if key in value and not isinstance(value[key], str):
            raise RuntimeError("claim helper control input field type mismatch")
    return value

name = payload.get("name")
if not isinstance(name, str) or not name or "/" in name or name in (".", ".."):
    raise RuntimeError("claim name is unsafe")

def validate_name(value):
    if not isinstance(value, str) or not value or "/" in value or value in (".", ".."):
        raise RuntimeError("claim name is unsafe")

def validate_private_name(private_name):
    validate_name(private_name)
    if private_name == name:
        raise RuntimeError("private claim name is unsafe")

def lock_directory():
    fcntl.flock(directory_fd, fcntl.LOCK_EX)

def emit(status, data=None, claim_stat=None):
    result = {"status": status}
    if data is not None and claim_stat is not None:
        result.update({
            "bytes": base64.b64encode(data).decode("ascii"),
            "dev": claim_stat.st_dev,
            "ino": claim_stat.st_ino,
            "mode": claim_stat.st_mode,
            "nlink": claim_stat.st_nlink,
        })
    print(json.dumps(result, separators=(",", ":")))

def open_named(target_name):
    try:
        return "open", os.open(target_name, os.O_RDONLY | no_follow, dir_fd=directory_fd)
    except FileNotFoundError:
        return "absent", None
    except OSError:
        return "mismatch", None

def inspect_fd(target_fd):
    try:
        target_stat = os.fstat(target_fd)
        if not stat.S_ISREG(target_stat.st_mode):
            return "mismatch", None, None
        chunks = []
        while True:
            chunk = os.read(target_fd, 65536)
            if not chunk:
                break
            chunks.append(chunk)
        return "present", b"".join(chunks), target_stat
    except OSError:
        return "mismatch", None, None

def inspect_named(target_name):
    state, target_fd = open_named(target_name)
    if state != "open":
        return state, None, None
    try:
        return inspect_fd(target_fd)
    finally:
        os.close(target_fd)

def same_identity(left, right):
    return (
        left.st_dev == right["dev"]
        and left.st_ino == right["ino"]
        and left.st_mode == right["mode"]
        and left.st_nlink == right["nlink"]
    )

def matches_expected(data, target_stat, expected_bytes, expected):
    return data == expected_bytes and same_identity(target_stat, expected)

def same_stat(left, right):
    return (left.st_dev == right.st_dev
            and left.st_ino == right.st_ino
            and left.st_mode == right.st_mode
            and left.st_nlink == right.st_nlink
            and left.st_size == right.st_size)

def temp_identity_matches(actual, expected, expected_nlink):
    return (actual.st_dev == expected.st_dev
            and actual.st_ino == expected.st_ino
            and actual.st_mode == expected.st_mode
            and actual.st_size == expected.st_size
            and actual.st_nlink == expected_nlink)

def write_temp(temp_name, data):
    validate_private_name(temp_name)
    temp_fd = os.open(temp_name, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600, dir_fd=directory_fd)
    try:
        offset = 0
        while offset < len(data):
            written = os.write(temp_fd, data[offset:])
            if written <= 0:
                raise OSError("claim temp write made no progress")
            offset += written
        os.fsync(temp_fd)
        return os.fstat(temp_fd)
    finally:
        os.close(temp_fd)

def rename_noreplace(source, destination):
    validate_name(source)
    validate_name(destination)
    if source == destination:
        raise RuntimeError("claim rename source and destination must differ")
    libc = ctypes.CDLL(None, use_errno=True)
    if sys.platform == "darwin":
        function = getattr(libc, "renameatx_np", None)
        flags = 4  # RENAME_EXCL
    elif sys.platform.startswith("linux"):
        function = getattr(libc, "renameat2", None)
        flags = 1  # RENAME_NOREPLACE
    else:
        function = None
        flags = 0
    if function is None:
        raise RuntimeError("atomic no-replace rename is unavailable")
    function.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
    function.restype = ctypes.c_int
    result = function(directory_fd, os.fsencode(source), directory_fd, os.fsencode(destination), flags)
    if result == 0:
        return
    error_number = ctypes.get_errno()
    if error_number == errno.EEXIST:
        raise FileExistsError(error_number, os.strerror(error_number), destination)
    if error_number == errno.ENOENT:
        raise FileNotFoundError(error_number, os.strerror(error_number), source)
    raise OSError(error_number, os.strerror(error_number), source)

def unlink_owned(name_to_remove):
    libc = ctypes.CDLL(None, use_errno=True)
    function = getattr(libc, "unlinkat", None)
    if function is None:
        raise RuntimeError("atomic identity-bound unlink is unavailable")
    function.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int]
    function.restype = ctypes.c_int
    # macOS AT_UNIQUE makes the pathname lookup fail when a foreign hardlink
    # has replaced the verified entry. Other supported platforms still use
    # the fixed directory fd; an unavailable primitive never falls back to a
    # project path.
    flags = 0x8000 if sys.platform == "darwin" else 0
    result = function(directory_fd, os.fsencode(name_to_remove), flags)
    if result == 0:
        return
    error_number = ctypes.get_errno()
    if error_number == errno.ENOENT:
        raise FileNotFoundError(error_number, os.strerror(error_number), name_to_remove)
    raise OSError(error_number, os.strerror(error_number), name_to_remove)

def restore_named(source, destination, captured_stat, captured_data):
    try:
        rename_noreplace(source, destination)
    except FileExistsError:
        return "residual_foreign"
    except FileNotFoundError:
        return "worker_failed"
    restored_state, restored_data, restored_stat = inspect_named(destination)
    if (restored_state == "present" and restored_stat is not None
            and restored_data == captured_data and same_stat(restored_stat, captured_stat)):
        return "restored"
    return "residual_foreign"

def remove_owned_temp(temp_name, expected_stat, expected_nlink, expected_data, quarantine):
    if expected_nlink != 1:
        return "worker_failed"
    validate_private_name(quarantine)
    try:
        rename_noreplace(temp_name, quarantine)
    except FileNotFoundError:
        return "absent"
    except FileExistsError:
        return "worker_failed"
    captured_state, captured_data, captured_stat = inspect_named(quarantine)
    if (captured_state != "present" or captured_stat is None
            or captured_data != expected_data
            or not temp_identity_matches(captured_stat, expected_stat, expected_nlink)):
        restoration = restore_named(quarantine, temp_name, captured_stat, captured_data) if captured_stat is not None else "worker_failed"
        return "residual_foreign" if restoration in ("restored", "residual_foreign") else "worker_failed"
    final_quarantine = quarantine + ".final"
    validate_private_name(final_quarantine)
    try:
        # Capture the already-verified private name again immediately before
        # the final identity check. A same-name exchange is therefore inspected
        # as the captured inode instead of being sent to unlink blindly.
        rename_noreplace(quarantine, final_quarantine)
    except FileNotFoundError:
        return "absent"
    except FileExistsError:
        return "worker_failed"
    final_state, final_data, final_stat = inspect_named(final_quarantine)
    if (final_state != "present" or final_stat is None
            or final_data != expected_data
            or not temp_identity_matches(final_stat, expected_stat, expected_nlink)):
        restoration = restore_named(final_quarantine, quarantine, final_stat, final_data) if final_stat is not None else "worker_failed"
        return "residual_foreign" if restoration in ("restored", "residual_foreign") else "worker_failed"
    try:
        unlink_owned(final_quarantine)
    except FileNotFoundError:
        return "absent"
    after_state, after_data, after_stat = inspect_named(final_quarantine)
    source_state, source_data, source_stat = inspect_named(temp_name)
    return "removed" if after_state == "absent" and source_state == "absent" else "residual_foreign"

def install_foreign(foreign_bytes, suffix):
    foreign_temp = "." + name + "." + suffix + "-" + str(os.getpid())
    created_stat = None
    published = False
    try:
        created_stat = write_temp(foreign_temp, foreign_bytes)
        os.replace(foreign_temp, name, src_dir_fd=directory_fd, dst_dir_fd=directory_fd)
        published = True
    finally:
        if created_stat is not None and not published:
            cleanup = remove_owned_temp(
                foreign_temp,
                created_stat,
                created_stat.st_nlink,
                foreign_bytes,
                "." + foreign_temp + ".cleanup-" + str(os.getpid()),
            )
            if cleanup != "removed":
                raise RuntimeError("claim foreign temp cleanup failed closed")

def restore_captured_foreign(quarantine, data, target_stat):
    try:
        # No-replace restoration cannot overwrite a foreign name that arrived
        # while the public name was quarantined. On collision, leave both
        # inodes untouched and report fail-closed residual evidence.
        rename_noreplace(quarantine, name)
    except FileExistsError:
        return "residual_foreign"
    except FileNotFoundError:
        return "worker_failed"
    restored_state, restored_data, restored_stat = inspect_named(name)
    if restored_state == "present" and restored_stat is not None and restored_data == data:
        return "restored"
    return "residual_foreign"

def remove_claim(mode):
    control = input_object(
        ["expected_bytes"],
        ["replace_after_verify", "replace_after_final_verify"],
    )
    expected_bytes = control["expected_bytes"].encode("utf-8")
    expected = {
        "dev": payload.get("dev"),
        "ino": payload.get("ino"),
        "mode": payload.get("mode"),
        "nlink": payload.get("nlink"),
    }
    if expected["nlink"] != 1:
        emit("mismatch")
        return
    quarantine = payload.get("quarantine_name")
    validate_private_name(quarantine)

    state, claim_fd = open_named(name)
    if state != "open":
        emit(state)
        return
    try:
        status, data, claim_stat = inspect_fd(claim_fd)
    finally:
        os.close(claim_fd)
    if status != "present" or claim_stat is None or not matches_expected(data, claim_stat, expected_bytes, expected):
        emit("mismatch")
        return

    replacement = control.get("replace_after_verify")
    if replacement is not None:
        install_foreign(replacement.encode("utf-8"), "foreign")

    # Capture the public name atomically into a no-replace private quarantine.
    # The deletion below can therefore target only the captured inode; a
    # same-name exchange at the public claim can never redirect it.
    try:
        rename_noreplace(name, quarantine)
    except FileNotFoundError:
        emit("absent")
        return
    except FileExistsError:
        emit("mismatch")
        return

    quarantine_state, quarantine_fd = open_named(quarantine)
    if quarantine_state != "open":
        emit("worker_failed")
        return
    try:
        quarantine_status, quarantine_data, quarantine_stat = inspect_fd(quarantine_fd)
    finally:
        os.close(quarantine_fd)
    if quarantine_status != "present" or quarantine_stat is None:
        emit("worker_failed")
        return

    if not matches_expected(quarantine_data, quarantine_stat, expected_bytes, expected):
        restoration = restore_captured_foreign(quarantine, quarantine_data, quarantine_stat)
        emit("residual_foreign" if restoration in ("restored", "residual_foreign") else "worker_failed")
        return

    final_replacement = control.get("replace_after_final_verify")
    if final_replacement is not None:
        # This is the production final-check-to-unlink seam. The public name
        # is absent, so an injected foreign claim is never the private inode
        # removed by the following unlink.
        install_foreign(final_replacement.encode("utf-8"), "foreign-final")
    final_quarantine = quarantine + ".final"
    validate_private_name(final_quarantine)
    try:
        # The final mutation is also a no-replace capture. This closes the
        # check-to-unlink window on the quarantine name itself.
        rename_noreplace(quarantine, final_quarantine)
    except FileNotFoundError:
        emit("absent")
        return
    except FileExistsError:
        emit("mismatch")
        return
    final_state, final_data, final_stat = inspect_named(final_quarantine)
    if (final_state != "present" or final_stat is None
            or final_data != expected_bytes or not matches_expected(final_data, final_stat, expected_bytes, expected)):
        restoration = restore_named(final_quarantine, quarantine, final_stat, final_data) if final_stat is not None else "worker_failed"
        emit("residual_foreign" if restoration in ("restored", "residual_foreign") else "worker_failed")
        return
    try:
        unlink_owned(final_quarantine)
    except FileNotFoundError:
        emit("absent")
        return

    after_state, after_data, after_stat = inspect_named(name)
    if after_state == "absent":
        emit("removed")
    elif after_state == "present" and after_stat is not None and matches_expected(after_data, after_stat, expected_bytes, expected):
        emit("residual_own")
    else:
        emit("residual_foreign")

try:
    mode = payload.get("action")
    if mode not in ("acquire", "inspect", "reclaim", "release"):
        raise RuntimeError("unknown claim helper action")
    lock_directory()
    if mode == "acquire":
        control = input_object(["claim_bytes"])
        temp_name = payload.get("temp_name")
        validate_private_name(temp_name)
        temp_data = control["claim_bytes"].encode("utf-8")
        created_stat = None
        outcome = None
        try:
            created_stat = write_temp(temp_name, temp_data)
            try:
                rename_noreplace(temp_name, name)
            except FileExistsError:
                outcome = "busy"
            else:
                outcome = "acquired"
        finally:
            if created_stat is not None and outcome != "acquired":
                cleanup = remove_owned_temp(
                    temp_name,
                    created_stat,
                    created_stat.st_nlink,
                    temp_data,
                    "." + temp_name + ".cleanup-" + str(os.getpid()),
                )
                if cleanup != "removed":
                    raise RuntimeError("claim temp cleanup failed closed")
        if outcome is not None:
            emit(outcome)
    elif mode == "inspect":
        input_object([])
        state, data, claim_stat = inspect_named(name)
        if state != "present":
            emit(state)
        else:
            emit(state, data, claim_stat)
    else:
        remove_claim(mode)
except Exception:
    emit("worker_failed")
    raise SystemExit(1)
`;

// The maintenance writer receives the acquisition-time 06_review directory
// as fd 3. It never resolves a project path after the lock is held. Directory
// traversal, atomic publication, and temporary reclamation all stay relative
// to that descriptor; missing Python/platform primitives are worker failures,
// never invitations to fall back to path operations.
const HEAL_MUTATION_PYTHON = String.raw`
import ctypes
import errno
import fcntl
import hashlib
import json
import os
import stat
import sys

payload = json.loads(sys.argv[1])
root_fd = 3
no_follow = getattr(os, "O_NOFOLLOW", None)
directory_flag = getattr(os, "O_DIRECTORY", None)
if no_follow is None or directory_flag is None:
    raise RuntimeError("required directory-fd flags are unavailable")

def read_input():
    raw = sys.stdin.buffer.read()
    expected_size = payload.get("input_bytes")
    expected_hash = payload.get("input_sha256")
    if (not isinstance(expected_size, int) or isinstance(expected_size, bool)
            or expected_size < 0 or not isinstance(expected_hash, str)
            or len(raw) != expected_size
            or "sha256:" + hashlib.sha256(raw).hexdigest() != expected_hash):
        raise RuntimeError("maintenance helper input envelope mismatch")
    return raw

def input_object(required, optional=()):
    try:
        value = json.loads(read_input().decode("utf-8"))
    except Exception as error:
        raise RuntimeError("maintenance helper control input is not JSON") from error
    if not isinstance(value, dict):
        raise RuntimeError("maintenance helper control input is not an object")
    allowed = set(required) | set(optional)
    if set(value.keys()) != allowed and not (set(required) <= set(value.keys()) <= allowed):
        raise RuntimeError("maintenance helper control input schema mismatch")
    if any(not isinstance(value[key], str) for key in required):
        raise RuntimeError("maintenance helper control input field type mismatch")
    for key in optional:
        if key in value and not isinstance(value[key], str):
            raise RuntimeError("maintenance helper control input field type mismatch")
    return value

def emit(status, directory=None, entries=None, file_info=None):
    result = {"status": status}
    if directory is not None:
        result["directory"] = directory
    if entries is not None:
        result["entries"] = entries
    if file_info is not None:
        result["file"] = file_info
    print(json.dumps(result, separators=(",", ":")))

def lock_root():
    fcntl.flock(root_fd, fcntl.LOCK_EX)

def parts_for(relative):
    if not isinstance(relative, str) or relative.startswith("/"):
        raise RuntimeError("maintenance path must be relative")
    parts = relative.split("/")
    if not parts or any(not part or part in (".", "..") for part in parts):
        raise RuntimeError("maintenance path contains an unsafe component")
    return parts

def open_directory(relative, create):
    parts = parts_for(relative)
    current_fd = os.dup(root_fd)
    try:
        for part in parts:
            try:
                next_fd = os.open(part, os.O_RDONLY | directory_flag | no_follow, dir_fd=current_fd)
            except FileNotFoundError:
                if not create:
                    raise
                os.mkdir(part, 0o755, dir_fd=current_fd)
                next_fd = os.open(part, os.O_RDONLY | directory_flag | no_follow, dir_fd=current_fd)
            current_stat = os.fstat(next_fd)
            if not stat.S_ISDIR(current_stat.st_mode):
                os.close(next_fd)
                raise RuntimeError("maintenance namespace component is not a directory")
            os.close(current_fd)
            current_fd = next_fd
        return current_fd
    except Exception:
        os.close(current_fd)
        raise

def open_parent(relative, create):
    parts = parts_for(relative)
    if len(parts) == 1:
        return os.dup(root_fd), parts[0]
    return open_directory("/".join(parts[:-1]), create), parts[-1]

def validate_private_name(name):
    if not isinstance(name, str) or not name or "/" in name or name in (".", ".."):
        raise RuntimeError("maintenance private name is unsafe")

def rename_noreplace(parent_fd, source, destination):
    validate_private_name(source)
    validate_private_name(destination)
    libc = ctypes.CDLL(None, use_errno=True)
    if sys.platform == "darwin":
        function = getattr(libc, "renameatx_np", None)
        flags = 4  # RENAME_EXCL
    elif sys.platform.startswith("linux"):
        function = getattr(libc, "renameat2", None)
        flags = 1  # RENAME_NOREPLACE
    else:
        function = None
        flags = 0
    if function is None:
        raise RuntimeError("atomic no-replace rename is unavailable")
    function.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
    function.restype = ctypes.c_int
    result = function(parent_fd, os.fsencode(source), parent_fd, os.fsencode(destination), flags)
    if result == 0:
        return
    error_number = ctypes.get_errno()
    if error_number == errno.EEXIST:
        raise FileExistsError(error_number, os.strerror(error_number), destination)
    if error_number == errno.ENOENT:
        raise FileNotFoundError(error_number, os.strerror(error_number), source)
    raise OSError(error_number, os.strerror(error_number), source)

def unlink_owned(parent_fd, name_to_remove):
    libc = ctypes.CDLL(None, use_errno=True)
    function = getattr(libc, "unlinkat", None)
    if function is None:
        raise RuntimeError("atomic identity-bound unlink is unavailable")
    function.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int]
    function.restype = ctypes.c_int
    # macOS AT_UNIQUE makes the pathname lookup fail when a foreign hardlink
    # has replaced the verified entry. Other supported platforms still use
    # the fixed parent fd; an unavailable primitive never falls back to a
    # project path.
    flags = 0x8000 if sys.platform == "darwin" else 0
    result = function(parent_fd, os.fsencode(name_to_remove), flags)
    if result == 0:
        return
    error_number = ctypes.get_errno()
    if error_number == errno.ENOENT:
        raise FileNotFoundError(error_number, os.strerror(error_number), name_to_remove)
    raise OSError(error_number, os.strerror(error_number), name_to_remove)

def restore_named(parent_fd, source, destination, captured_stat, captured_data):
    try:
        # The no-replace primitive prevents restoration from overwriting a
        # foreign name that appeared while the source was quarantined.
        rename_noreplace(parent_fd, source, destination)
    except FileExistsError:
        return "residual_foreign"
    except FileNotFoundError:
        return "worker_failed"
    try:
        restored_stat = os.stat(destination, dir_fd=parent_fd, follow_symlinks=False)
    except FileNotFoundError:
        return "worker_failed"
    if not same_stat(restored_stat, captured_stat):
        return "residual_foreign"
    if captured_data is not None:
        restored_state, restored_data, restored_open_stat = inspect_regular(parent_fd, destination, False)
        if (restored_state != "present" or restored_open_stat is None
                or restored_data != captured_data or not same_stat(restored_open_stat, captured_stat)):
            return "residual_foreign"
    return "restored"

def entry_identity(entry_stat):
    return {
        "dev": entry_stat.st_dev,
        "ino": entry_stat.st_ino,
        "mode": entry_stat.st_mode,
        "nlink": entry_stat.st_nlink,
        "size": entry_stat.st_size,
    }

def same_identity(actual, expected):
    return (actual.st_dev == expected["dev"]
            and actual.st_ino == expected["ino"]
            and actual.st_mode == expected["mode"]
            and actual.st_nlink == expected["nlink"]
            and actual.st_size == expected["size"])

def same_stat(left, right):
    return (left.st_dev == right.st_dev
            and left.st_ino == right.st_ino
            and left.st_mode == right.st_mode
            and left.st_nlink == right.st_nlink
            and left.st_size == right.st_size)

def same_directory_identity(actual, expected):
    return (actual.st_dev == expected["dev"]
            and actual.st_ino == expected["ino"]
            and actual.st_mode == expected["mode"])

def is_sha256(value):
    return (isinstance(value, str) and len(value) == 71
            and value.startswith("sha256:")
            and all(character in "0123456789abcdef" for character in value[7:]))

def inspect_regular(parent_fd, name, single_link=True):
    try:
        target_fd = os.open(name, os.O_RDONLY | no_follow, dir_fd=parent_fd)
    except FileNotFoundError:
        return "missing", None, None
    except OSError:
        return "mismatch", None, None
    try:
        target_stat = os.fstat(target_fd)
        if not stat.S_ISREG(target_stat.st_mode) or (single_link and target_stat.st_nlink != 1):
            return "mismatch", None, target_stat
        chunks = []
        while True:
            chunk = os.read(target_fd, 65536)
            if not chunk:
                break
            chunks.append(chunk)
        return "present", b"".join(chunks), target_stat
    except OSError:
        return "mismatch", None, None
    finally:
        os.close(target_fd)

def write_temp(parent_fd, name, data):
    validate_private_name(name)
    temp_fd = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600, dir_fd=parent_fd)
    try:
        offset = 0
        while offset < len(data):
            written = os.write(temp_fd, data[offset:])
            if written <= 0:
                raise OSError("maintenance temp write made no progress")
            offset += written
        os.fsync(temp_fd)
        return os.fstat(temp_fd)
    finally:
        os.close(temp_fd)

def temp_identity_matches(actual, expected, expected_nlink):
    return (actual.st_dev == expected.st_dev
            and actual.st_ino == expected.st_ino
            and actual.st_mode == expected.st_mode
            and actual.st_size == expected.st_size
            and actual.st_nlink == expected_nlink)

def restore_captured(parent_fd, name, quarantine, captured_stat, captured_data):
    return restore_named(parent_fd, quarantine, name, captured_stat, captured_data)

def remove_owned_temp(parent_fd, name, expected_stat, expected_nlink, expected_data, quarantine):
    if expected_nlink != 1:
        return "worker_failed"
    validate_private_name(quarantine)
    try:
        rename_noreplace(parent_fd, name, quarantine)
    except FileNotFoundError:
        return "absent"
    except FileExistsError:
        return "worker_failed"
    captured_state, captured_data, captured_stat = inspect_regular(parent_fd, quarantine, False)
    if (captured_state != "present" or captured_stat is None
            or captured_data != expected_data
            or not temp_identity_matches(captured_stat, expected_stat, expected_nlink)):
        if captured_stat is None:
            return "worker_failed"
        restoration = restore_captured(parent_fd, name, quarantine, captured_stat, captured_data)
        return "residual_foreign" if restoration in ("restored", "residual_foreign") else "worker_failed"
    final_quarantine = quarantine + ".final"
    validate_private_name(final_quarantine)
    try:
        rename_noreplace(parent_fd, quarantine, final_quarantine)
    except FileNotFoundError:
        return "absent"
    except FileExistsError:
        return "worker_failed"
    final_state, final_data, final_stat = inspect_regular(parent_fd, final_quarantine, False)
    if (final_state != "present" or final_stat is None
            or final_data != expected_data
            or not temp_identity_matches(final_stat, expected_stat, expected_nlink)):
        restoration = restore_named(parent_fd, final_quarantine, quarantine, final_stat, final_data) if final_stat is not None else "worker_failed"
        return "residual_foreign" if restoration in ("restored", "residual_foreign") else "worker_failed"
    try:
        unlink_owned(parent_fd, final_quarantine)
    except FileNotFoundError:
        return "absent"
    after_state, _, _ = inspect_regular(parent_fd, final_quarantine, False)
    source_state, _, _ = inspect_regular(parent_fd, name, False)
    return "removed" if after_state == "missing" and source_state == "missing" else "residual_foreign"

def install_foreign(parent_fd, name, foreign_bytes, suffix):
    foreign_temp = "." + name + "." + suffix + "-" + str(os.getpid())
    created_stat = None
    published = False
    try:
        created_stat = write_temp(parent_fd, foreign_temp, foreign_bytes)
        os.replace(foreign_temp, name, src_dir_fd=parent_fd, dst_dir_fd=parent_fd)
        published = True
    finally:
        if created_stat is not None and not published:
            cleanup = remove_owned_temp(
                parent_fd,
                foreign_temp,
                created_stat,
                created_stat.st_nlink,
                foreign_bytes,
                "." + foreign_temp + ".cleanup-" + str(os.getpid()),
            )
            if cleanup != "removed":
                raise RuntimeError("maintenance foreign temp cleanup failed closed")

def inspect_file():
    parent_fd, name = open_parent(payload["relative_path"], False)
    try:
        state, data, target_stat = inspect_regular(parent_fd, name)
        if state == "missing":
            emit("absent")
            return
        if state != "present" or target_stat is None:
            emit("mismatch")
            return
        emit("present", file_info={
            "sha256": "sha256:" + hashlib.sha256(data).hexdigest(),
            "dev": target_stat.st_dev,
            "ino": target_stat.st_ino,
            "mode": target_stat.st_mode,
            "nlink": target_stat.st_nlink,
            "size": target_stat.st_size,
        })
    finally:
        os.close(parent_fd)

def write_file():
    expected_bytes = read_input()
    parent_fd, name = open_parent(payload["relative_path"], True)
    try:
        state, current_bytes, current_stat = inspect_regular(parent_fd, name)
        if state == "present":
            emit("existing" if current_bytes == expected_bytes else "mismatch")
            return
        if state != "missing":
            emit("mismatch")
            return
        temp_name = payload["temp_name"]
        validate_private_name(temp_name)
        created_stat = None
        outcome = None
        try:
            created_stat = write_temp(parent_fd, temp_name, expected_bytes)
            try:
                rename_noreplace(parent_fd, temp_name, name)
            except FileExistsError:
                state, current_bytes, current_stat = inspect_regular(parent_fd, name)
                if state == "present" and current_bytes == expected_bytes:
                    outcome = "existing"
                else:
                    outcome = "mismatch"
            else:
                outcome = "linked"
        finally:
            if created_stat is not None and outcome != "linked":
                cleanup = remove_owned_temp(
                    parent_fd,
                    temp_name,
                    created_stat,
                    created_stat.st_nlink,
                    expected_bytes,
                    "." + temp_name + ".cleanup-" + str(os.getpid()),
                )
                if cleanup != "removed":
                    raise RuntimeError("maintenance temp cleanup failed closed")
        if outcome == "linked":
            state, current_bytes, current_stat = inspect_regular(parent_fd, name)
            emit("written" if state == "present" and current_bytes == expected_bytes else "mismatch")
        elif outcome is not None:
            emit(outcome)
    finally:
        os.close(parent_fd)

def list_directory():
    input_object([], [])
    directory_fd = open_directory(payload["relative_directory"], False)
    try:
        directory_stat = os.fstat(directory_fd)
        entries = []
        with os.scandir(directory_fd) as iterator:
            for entry in iterator:
                entry_stat = entry.stat(follow_symlinks=False)
                entry_info = {
                    "name": entry.name,
                    "regular": stat.S_ISREG(entry_stat.st_mode),
                    "symbolicLink": stat.S_ISLNK(entry_stat.st_mode),
                    "sha256": None,
                    **entry_identity(entry_stat),
                }
                if entry_info["regular"]:
                    captured_state, captured_data, captured_stat = inspect_regular(directory_fd, entry.name, False)
                    if (captured_state != "present" or captured_data is None or captured_stat is None
                            or not same_stat(captured_stat, entry_stat)):
                        raise RuntimeError("maintenance sweep entry changed while being captured")
                    entry_info["sha256"] = "sha256:" + hashlib.sha256(captured_data).hexdigest()
                entries.append(entry_info)
        emit("listed", {
            "dev": directory_stat.st_dev,
            "ino": directory_stat.st_ino,
            "mode": directory_stat.st_mode,
        }, entries)
    finally:
        os.close(directory_fd)

def remove_file():
    control = input_object([], ["replace_after_final_verify"])
    parent_fd, name = open_parent(payload["relative_path"], False)
    try:
        parent_stat = os.fstat(parent_fd)
        expected_directory = payload["expected_directory"]
        if not same_directory_identity(parent_stat, expected_directory):
            emit("mismatch")
            return
        expected_entry = payload["expected_entry"]
        if not isinstance(expected_entry, dict) or set(expected_entry.keys()) != {"dev", "ino", "mode", "nlink", "size", "sha256"}:
            raise RuntimeError("maintenance expected entry schema mismatch")
        if not is_sha256(expected_entry.get("sha256")):
            raise RuntimeError("maintenance expected entry hash schema mismatch")
        if expected_entry["nlink"] != 1:
            emit("mismatch")
            return
        quarantine = payload.get("quarantine_name")
        validate_private_name(quarantine)
        try:
            # Atomically move the public name to a private name that is known
            # to be empty. No later unlink ever targets the shared name.
            rename_noreplace(parent_fd, name, quarantine)
        except FileNotFoundError:
            emit("absent")
            return
        except FileExistsError:
            emit("mismatch")
            return

        try:
            captured_lstat = os.stat(quarantine, dir_fd=parent_fd, follow_symlinks=False)
        except FileNotFoundError:
            emit("worker_failed")
            return
        if not stat.S_ISREG(captured_lstat.st_mode):
            restoration = restore_captured(parent_fd, name, quarantine, captured_lstat, None)
            emit("residual_foreign" if restoration in ("restored", "residual_foreign") else "worker_failed")
            return
        captured_state, captured_data, captured_stat = inspect_regular(parent_fd, quarantine, False)
        if captured_state != "present" or captured_stat is None:
            emit("worker_failed")
            return
        captured_sha256 = "sha256:" + hashlib.sha256(captured_data).hexdigest() if captured_data is not None else None
        if (not same_identity(captured_stat, expected_entry)
                or captured_data is None or captured_sha256 != expected_entry["sha256"]):
            restoration = restore_captured(parent_fd, name, quarantine, captured_stat, captured_data)
            emit("residual_foreign" if restoration in ("restored", "residual_foreign") else "worker_failed")
            return

        final_replacement = control.get("replace_after_final_verify")
        if final_replacement is not None:
            # True final-check-to-unlink seam: the public name is absent and
            # the following unlink is private to the captured inode.
            install_foreign(parent_fd, name, final_replacement.encode("utf-8"), "foreign-final")
        final_quarantine = quarantine + ".final"
        validate_private_name(final_quarantine)
        try:
            # Capture the already-verified private name again immediately
            # before the final identity check. A same-name exchange is
            # inspected as the captured inode, never unlinked blindly.
            rename_noreplace(parent_fd, quarantine, final_quarantine)
        except FileNotFoundError:
            emit("absent")
            return
        except FileExistsError:
            emit("mismatch")
            return
        final_state, final_data, final_stat = inspect_regular(parent_fd, final_quarantine, False)
        final_sha256 = "sha256:" + hashlib.sha256(final_data).hexdigest() if final_data is not None else None
        if (final_state != "present" or final_stat is None
                or final_data is None or final_sha256 != expected_entry["sha256"]
                or not same_identity(final_stat, expected_entry)):
            restoration = restore_named(parent_fd, final_quarantine, quarantine, final_stat, final_data) if final_stat is not None else "worker_failed"
            emit("residual_foreign" if restoration in ("restored", "residual_foreign") else "worker_failed")
            return
        try:
            unlink_owned(parent_fd, final_quarantine)
        except FileNotFoundError:
            emit("absent")
            return

        after_state, after_data, after_stat = inspect_regular(parent_fd, name, False)
        if after_state == "missing":
            emit("removed")
        elif after_state == "present" and after_stat is not None and same_identity(after_stat, expected_entry):
            emit("residual_own")
        else:
            emit("residual_foreign")
    finally:
        os.close(parent_fd)

try:
    mode = payload.get("action")
    if mode not in ("write", "list", "remove", "inspect"):
        raise RuntimeError("unknown maintenance helper action")
    lock_root()
    if mode == "write":
        write_file()
    elif mode == "list":
        try:
            list_directory()
        except FileNotFoundError:
            emit("missing")
    elif mode == "remove":
        remove_file()
    elif mode == "inspect":
        input_object([], [])
        inspect_file()
    else:
        raise RuntimeError("unknown maintenance helper action")
except Exception:
    emit("worker_failed")
    raise SystemExit(1)
`;

const HEAL_WORKER_MAX_OUTPUT_BYTES = 64 * 1024;
// Every helper call must return before the 30s lock deadline can be consumed
// by one unbounded child. A timeout is a dependency failure, never success.
const HEAL_WORKER_TIMEOUT_MS = 1_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isSafeStatNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isCanonicalBase64(value: unknown): value is string {
  if (typeof value !== "string" || value.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) return false;
  return Buffer.from(value, "base64").toString("base64") === value;
}

function healWorkerInputDigest(input: Buffer): { input_bytes: number; input_sha256: string } {
  return {
    input_bytes: input.byteLength,
    input_sha256: `sha256:${createHash("sha256").update(input).digest("hex")}`,
  };
}

function runHealWorker(
  script: string,
  handle: HealDirectoryHandleSnapshot,
  payload: Record<string, unknown>,
  input: Buffer,
): Record<string, unknown> | null {
  const worker = spawnSync("python3", ["-c", script, JSON.stringify({ ...payload, ...healWorkerInputDigest(input) })], {
    input,
    encoding: "utf8",
    maxBuffer: HEAL_WORKER_MAX_OUTPUT_BYTES,
    timeout: HEAL_WORKER_TIMEOUT_MS,
    stdio: ["pipe", "pipe", "pipe", handle.fd],
  });
  if (worker.error !== undefined || worker.status !== 0 || worker.signal !== null
    || typeof worker.stdout !== "string" || typeof worker.stderr !== "string"
    || worker.stderr.length !== 0 || Buffer.byteLength(worker.stdout, "utf8") > HEAL_WORKER_MAX_OUTPUT_BYTES) {
    return null;
  }
  const output = worker.stdout.trim();
  if (output.length === 0) return null;
  try {
    const result: unknown = JSON.parse(output);
    return isRecord(result) ? result : null;
  } catch {
    return null;
  }
}

function validMutationDirectory(value: unknown): value is HealMutationDirectory {
  return isRecord(value) && hasExactKeys(value, ["dev", "ino", "mode"])
    && isSafeStatNumber(value.dev) && isSafeStatNumber(value.ino) && isSafeStatNumber(value.mode);
}

function validMutationEntry(value: unknown): value is HealMutationEntry {
  return isRecord(value) && hasExactKeys(value, ["name", "regular", "symbolicLink", "sha256", "dev", "ino", "mode", "nlink", "size"])
    && typeof value.name === "string" && value.name.length > 0 && !value.name.includes("/")
    && typeof value.regular === "boolean" && typeof value.symbolicLink === "boolean"
    && (value.regular ? typeof value.sha256 === "string" && SHA256.test(value.sha256) : value.sha256 === null)
    && isSafeStatNumber(value.dev) && isSafeStatNumber(value.ino) && isSafeStatNumber(value.mode)
    && isSafeStatNumber(value.nlink) && isSafeStatNumber(value.size);
}

function validMutationFile(value: unknown): value is HealMutationFile {
  return isRecord(value) && hasExactKeys(value, ["sha256", "dev", "ino", "mode", "nlink", "size"])
    && typeof value.sha256 === "string" && SHA256.test(value.sha256)
    && isSafeStatNumber(value.dev) && isSafeStatNumber(value.ino) && isSafeStatNumber(value.mode)
    && isSafeStatNumber(value.nlink) && isSafeStatNumber(value.size);
}

function runHealMutationPython(
  handle: HealDirectoryHandleSnapshot,
  action: "write" | "list" | "remove" | "inspect",
  payload: Record<string, unknown>,
  input: Buffer,
): HealMutationPythonResult {
  const result = runHealWorker(HEAL_MUTATION_PYTHON, handle, { ...payload, action }, input);
  if (!result || typeof result.status !== "string") return { status: "worker_failed" };
  if (action === "write" && hasExactKeys(result, ["status"])
    && (result.status === "written" || result.status === "existing" || result.status === "mismatch")) {
    return { status: result.status };
  }
  if (action === "list") {
    if (result.status === "missing" && hasExactKeys(result, ["status"])) return { status: "missing" };
    if (result.status === "listed" && hasExactKeys(result, ["status", "directory", "entries"])
      && validMutationDirectory(result.directory) && Array.isArray(result.entries)
      && result.entries.every((entry) => validMutationEntry(entry))) {
      return { status: "listed", directory: result.directory, entries: result.entries };
    }
    return { status: "worker_failed" };
  }
  if (action === "inspect") {
    if (result.status === "absent" && hasExactKeys(result, ["status"])) return { status: "absent" };
    if (result.status === "present" && hasExactKeys(result, ["status", "file"]) && validMutationFile(result.file)) {
      return { status: "present", file: result.file };
    }
    return { status: "worker_failed" };
  }
  const removeStatuses: HealMutationPythonStatus[] = ["removed", "absent", "mismatch", "residual_own", "residual_foreign"];
  if (removeStatuses.includes(result.status as HealMutationPythonStatus) && hasExactKeys(result, ["status"])) {
    return { status: result.status as HealMutationPythonStatus };
  }
  return { status: "worker_failed" };
}

function validClaimStatResult(value: Record<string, unknown>): value is Record<string, unknown> & {
  dev: number;
  ino: number;
  mode: number;
  nlink: number;
} {
  return isSafeStatNumber(value.dev) && isSafeStatNumber(value.ino)
    && isSafeStatNumber(value.mode) && isSafeStatNumber(value.nlink);
}

function runHealClaimPython(
  handle: HealDirectoryHandleSnapshot,
  action: "acquire" | "inspect" | "reclaim" | "release",
  payload: Record<string, unknown>,
  input: Buffer,
): HealClaimPythonResult {
  const result = runHealWorker(HEAL_CLAIM_PYTHON, handle, { ...payload, action }, input);
  if (!result || typeof result.status !== "string") return { status: "worker_failed" };
  if (action === "acquire" && hasExactKeys(result, ["status"])
    && (result.status === "acquired" || result.status === "busy")) {
    return { status: result.status };
  }
  if (action === "inspect") {
    if (result.status === "absent" && hasExactKeys(result, ["status"])) return { status: "absent" };
    if (result.status === "present" && hasExactKeys(result, ["status", "bytes", "dev", "ino", "mode", "nlink"])
      && isCanonicalBase64(result.bytes) && validClaimStatResult(result)) {
      return {
        status: "present",
        bytes: result.bytes,
        dev: result.dev,
        ino: result.ino,
        mode: result.mode,
        nlink: result.nlink,
      };
    }
    return { status: "worker_failed" };
  }
  const releaseStatuses: HealClaimPythonStatus[] = ["removed", "absent", "mismatch", "residual_own", "residual_foreign"];
  if (releaseStatuses.includes(result.status as HealClaimPythonStatus) && hasExactKeys(result, ["status"])) {
    return { status: result.status as HealClaimPythonStatus };
  }
  return { status: "worker_failed" };
}

function relativeHealPath(handle: HealDirectoryHandleSnapshot, target: string, logicalProjectPath?: string): string {
  const targetPath = path.resolve(target);
  const candidates = [path.relative(handle.path, targetPath)];
  if (logicalProjectPath !== undefined) candidates.push(path.relative(path.join(logicalProjectPath, "06_review"), targetPath));
  for (const relative of candidates) {
    if (relative && !path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`)) {
      return relative.split(path.sep).join("/");
    }
  }
  throw new Error(`review round maintenance path is outside the acquired directory: ${target}`);
}

function healControlInput(value: Record<string, unknown>): Buffer {
  return Buffer.from(JSON.stringify(value), "utf8");
}

function writeIdentityNamedFileAtHealHandle(
  projectRoot: string,
  held: HeldHealLock,
  target: string,
  bytes: string,
  barrier?: () => void,
  relativeTarget?: string,
): { identity: string; file: string } {
  assertActiveHealBinding(projectRoot);
  const relativePath = relativeTarget ?? relativeHealPath(held.directoryHandle, target, held.logicalProjectPath);
  // This is the final check-to-mutation seam. The helper below receives only
  // the acquisition-time directory fd, so a swap at this point can mutate
  // only the retained original generation and can never redirect into the
  // replacement at the nominal path.
  barrier?.();
  held.beforeMaintenanceMutation?.();
  const tempName = `.${path.basename(target)}.tmp-${process.pid}-${randomUUID()}`;
  held.beforeMaintenanceTempCreate?.(tempName);
  const result = runHealMutationPython(held.directoryHandle, "write", {
    relative_path: relativePath,
    temp_name: tempName,
  }, Buffer.from(bytes, "utf8"));
  if (result.status === "worker_failed") {
    // A timed-out child may have published before it was killed. Inspect the
    // fixed directory generation before surfacing the dependency failure; the
    // inspection never mutates a residual or falls back to the nominal path.
    runHealMutationPython(held.directoryHandle, "inspect", {
      relative_path: relativePath,
    }, healControlInput({}));
    throw new Error("review round maintenance write dependency failed; no path fallback is permitted");
  }
  if (result.status !== "written" && result.status !== "existing") {
    throw new Error(`immutable review round record conflict or failed closed: ${result.status}`);
  }
  const postcondition = runHealMutationPython(held.directoryHandle, "inspect", {
    relative_path: relativePath,
  }, healControlInput({}));
  if (postcondition.status !== "present" || !postcondition.file
    || postcondition.file.sha256 !== sha256String(bytes)
    || postcondition.file.size !== Buffer.byteLength(bytes, "utf8")
    || postcondition.file.nlink !== 1) {
    throw new Error("review round maintenance write postcondition could not be independently verified");
  }
  assertActiveHealBinding(projectRoot);
  return { identity: `sha256:${path.basename(target).replace(/\.json$/, "")}`, file: target };
}

function listHealDirectoryAtHandle(
  held: HeldHealLock,
  relativeDirectory: string,
): { status: "listed" | "missing" | "mismatch" | "worker_failed"; directory?: HealMutationDirectory; entries?: HealMutationEntry[] } {
  const result = runHealMutationPython(held.directoryHandle, "list", {
    relative_directory: relativeDirectory,
  }, healControlInput({}));
  if (result.status === "worker_failed") return { status: "worker_failed" };
  if (result.status === "missing") return { status: "missing" };
  if (result.status !== "listed" || !result.directory || !Array.isArray(result.entries)) return { status: "mismatch" };
  return { status: "listed", directory: result.directory, entries: result.entries };
}

function removeHealTemporaryAtHandle(
  held: HeldHealLock,
  relativeDirectory: string,
  directory: HealMutationDirectory,
  entry: HealMutationEntry,
  replaceAfterFinalVerification?: string,
  ): "removed" | "absent" | "mismatch" | "residual_own" | "residual_foreign" | "worker_failed" {
  if (!entry.sha256) return "worker_failed";
  const result = runHealMutationPython(held.directoryHandle, "remove", {
    relative_path: `${relativeDirectory}/${entry.name}`,
    expected_directory: directory,
    expected_entry: {
      dev: entry.dev,
      ino: entry.ino,
      mode: entry.mode,
      nlink: entry.nlink,
      size: entry.size,
      sha256: entry.sha256,
    },
    quarantine_name: `.${entry.name}.quarantine-${process.pid}-${randomUUID()}`,
  }, healControlInput(replaceAfterFinalVerification === undefined ? {} : {
    replace_after_final_verify: replaceAfterFinalVerification,
  }));
  if (result.status === "worker_failed") {
    // Timeout/forced termination can occur after the child mutated. Establish
    // the authoritative residual state, but never infer success from it.
    runHealMutationPython(held.directoryHandle, "inspect", {
      relative_path: `${relativeDirectory}/${entry.name}`,
    }, healControlInput({}));
    return "worker_failed";
  }
  if (result.status === "absent" || result.status === "mismatch"
    || result.status === "residual_own" || result.status === "residual_foreign") return result.status;
  if (result.status !== "removed") return "worker_failed";
  const postcondition = runHealMutationPython(held.directoryHandle, "inspect", {
    relative_path: `${relativeDirectory}/${entry.name}`,
  }, healControlInput({}));
  if (postcondition.status === "absent") return "removed";
  if (postcondition.status === "worker_failed") return "worker_failed";
  return postcondition.status === "present" ? "residual_foreign" : "mismatch";
}

function inspectHealClaimAfterRelease(
  handle: HealDirectoryHandleSnapshot,
  ownClaim: HealClaimSnapshot,
): "absent" | "residual_own" | "residual_foreign" | "worker_failed" {
  const result = inspectHealClaimAtHandle(handle);
  if (result.status === "absent") return "absent";
  if (result.status === "worker_failed") return "worker_failed";
  if (result.status === "present" && result.snapshot) {
    return sameHealClaimSnapshot(result.snapshot, ownClaim) ? "residual_own" : "residual_foreign";
  }
  return "worker_failed";
}

function verifyHealClaimReleasePostcondition(
  handle: HealDirectoryHandleSnapshot,
  status: HealClaimReleaseStatus,
  ownClaim: HealClaimSnapshot,
): HealClaimReleaseStatus {
  if (status === "worker_failed") {
    const residual = inspectHealClaimAfterRelease(handle, ownClaim);
    if (residual === "absent") return "absent";
    if (residual === "residual_own") return "residual_own";
    if (residual === "residual_foreign") return "residual_foreign";
    return "worker_failed";
  }
  if (status !== "removed") return status;
  const residual = inspectHealClaimAfterRelease(handle, ownClaim);
  if (residual === "absent") return "removed";
  if (residual === "residual_foreign") return "residual_foreign";
  return residual === "worker_failed" ? "worker_failed" : "residual_own";
}

function inspectHealClaimAtHandle(handle: HealDirectoryHandleSnapshot): { status: "absent" | "present" | "mismatch" | "worker_failed"; snapshot?: HealClaimSnapshot } {
  assertHealDirectoryHandle(handle, "claim");
  const result = runHealClaimPython(handle, "inspect", {
    name: HEAL_LOCK_NAME,
  }, healControlInput({}));
  if (result.status === "worker_failed") return { status: "worker_failed" };
  if (result.status === "absent") return { status: "absent" };
  if (result.status !== "present"
    || typeof result.bytes !== "string"
    || typeof result.dev !== "number" || typeof result.ino !== "number"
    || typeof result.mode !== "number" || typeof result.nlink !== "number") {
    return { status: "mismatch" };
  }
  return {
    status: "present",
    snapshot: {
      bytes: Buffer.from(result.bytes, "base64").toString("utf8"),
      dev: result.dev,
      ino: result.ino,
      mode: result.mode,
      nlink: result.nlink,
    },
  };
}

function acquireHealClaimAtHandle(
  handle: HealDirectoryHandleSnapshot,
  claimBytes: string,
  beforeTempCreate?: (tempName: string) => void,
): "acquired" | "busy" | "worker_failed" {
  assertHealDirectoryHandle(handle, "claim");
  const tempName = `.${HEAL_LOCK_NAME}.tmp-${process.pid}-${randomUUID()}`;
  beforeTempCreate?.(tempName);
  const result = runHealClaimPython(handle, "acquire", {
    name: HEAL_LOCK_NAME,
    temp_name: tempName,
  }, healControlInput({ claim_bytes: claimBytes }));
  return result.status === "acquired" || result.status === "busy" ? result.status : "worker_failed";
}

function removeHealClaimAtHandle(
  handle: HealDirectoryHandleSnapshot,
  ownClaim: HealClaimSnapshot,
  mode: "reclaim" | "release",
  replaceClaimAfterVerification?: string,
  replaceClaimAfterFinalVerification?: string,
): HealClaimReleaseResult {
  assertHealDirectoryHandle(handle, "claim");
  const result = runHealClaimPython(handle, mode, {
    name: HEAL_LOCK_NAME,
    quarantine_name: `.${HEAL_LOCK_NAME}.quarantine-${process.pid}-${randomUUID()}`,
    dev: ownClaim.dev,
    ino: ownClaim.ino,
    mode: ownClaim.mode,
    nlink: ownClaim.nlink,
  }, healControlInput({
    expected_bytes: ownClaim.bytes,
    ...(replaceClaimAfterVerification === undefined ? {} : { replace_after_verify: replaceClaimAfterVerification }),
    ...(replaceClaimAfterFinalVerification === undefined ? {} : { replace_after_final_verify: replaceClaimAfterFinalVerification }),
  }));
  const status = ["removed", "absent", "mismatch", "residual_own", "residual_foreign"].includes(result.status)
    ? result.status as HealClaimReleaseStatus
    : "worker_failed";
  return { status: verifyHealClaimReleasePostcondition(handle, status, ownClaim) };
}

/**
 * Reclaim a stale heal claim ONLY when the on-disk claim is byte-for-byte and
 * inode-for-inode identical to the observed snapshot AND its recorded owner
 * no longer exists (dead PID or PID reused with a different lstart). This
 * closes the replacement race: a reaper that read an old claim can never
 * unlink a newer writer's claim, and a reused PID can never keep a dead
 * owner's claim alive.
 */
function isStaleHealClaimOwner(prior: HealClaimSnapshot): boolean {
  let owner: { pid?: number; lstart?: string; uuid?: string };
  try {
    owner = JSON.parse(prior.bytes) as { pid?: number; lstart?: string; uuid?: string };
  } catch {
    return false;
  }
  if (typeof owner.pid !== "number" || !Number.isInteger(owner.pid) || typeof owner.uuid !== "string"
    || typeof owner.lstart !== "string" || owner.lstart.length === 0) {
    // Missing or malformed identity axes are never reclaimable.
    return false;
  }
  // Liveness first: only a CONFIRMED dead PID (or a CONFIRMED start-identity
  // mismatch) may be reclaimed. A transient ps failure while the PID is
  // alive is "unknown" and never stale.
  let alive: boolean;
  try {
    process.kill(owner.pid, 0);
    alive = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") {
      alive = false;
    } else {
      return false; // EPERM or unknown: treat as live
    }
  }
  if (alive) {
    const ownerLstart = processLstart(owner.pid);
    if (ownerLstart === null) return false; // transient failure: unknown, never stale
    if (ownerLstart === owner.lstart) {
      return false; // the recorded owner process is still alive as itself
    }
    // Confirmed start-identity mismatch (PID reuse): the claiming process is
    // gone; fall through to the exact-snapshot recheck before unlinking.
  }
  return true;
}

function tryReclaimStaleHealClaimAtHandle(
  handle: HealDirectoryHandleSnapshot,
  prior: HealClaimSnapshot,
  replaceClaimAfterVerification?: string,
  replaceClaimAfterFinalVerification?: string,
): HealClaimReleaseStatus {
  const current = inspectHealClaimAtHandle(handle);
  if (current.status === "worker_failed") return "worker_failed";
  if (current.status !== "present" || !current.snapshot || !sameHealClaimSnapshot(current.snapshot, prior)) return "mismatch";
  if (!isStaleHealClaimOwner(prior)) return "mismatch";
  return removeHealClaimAtHandle(
    handle,
    prior,
    "reclaim",
    replaceClaimAfterVerification,
    replaceClaimAfterFinalVerification,
  ).status;
}

export function tryReclaimStaleHealClaim(
  lockPath: string,
  prior: HealClaimSnapshot,
  hooks?: Pick<ReviewRoundHealLockHostileHooks, "replaceClaimAfterVerification" | "replaceClaimAfterFinalVerification">,
): boolean {
  let directoryHandle: HealDirectoryHandleSnapshot | null = null;
  try {
    // Even this compatibility entry point takes a fixed directory handle; it
    // never verifies through one path and unlinks through another.
    directoryHandle = openHealDirectoryHandle(path.dirname(lockPath));
    return tryReclaimStaleHealClaimAtHandle(
      directoryHandle,
      prior,
      hooks?.replaceClaimAfterVerification,
      hooks?.replaceClaimAfterFinalVerification,
    ) === "removed";
  } catch {
    return false;
  } finally {
    closeHealDirectoryHandle(directoryHandle);
  }
}

/**
 * Serialize supersession/heal operations across processes. The lock is a
 * claimed file with liveness proof: a lock whose owning PID is provably dead
 * is reclaimed; a live owner is waited for (synchronously, so the sync
 * transaction paths stay atomic). Every caller releases only its own claim,
 * so concurrent retries are idempotent and serialized.
 */
export function withReviewRoundHealLock<T>(projectDir: string, operation: () => T, hooks?: ReviewRoundHealLockHostileHooks): T {
  const projectRoot = fs.realpathSync(path.resolve(projectDir));
  // Project-keyed ownership: a nested heal operation inside project B must
  // never bypass B's lock merely because project A holds one.
  const held = heldLocks.get(projectRoot);
  if (held) {
    held.depth += 1;
    try {
      assertActiveHealBinding(projectRoot);
      hooks?.beforeOperation?.();
      return operation();
    } finally {
      held.depth -= 1;
    }
  }
  // The heal-lock namespace is validated fail-closed before any claim read,
  // and the SAME snapshot is re-verified after the claim publish.
  const namespaceSnapshot = assertWriterNamespace(projectDir, "06_review");
  const expectedParent = namespaceSnapshot[0]!;
  const expectedDirectory = namespaceSnapshot[1]!;
  const parentHandle = openHealDirectoryHandle(expectedParent.path);
  let directoryHandle: HealDirectoryHandleSnapshot | null = null;
  let ownClaim: HealClaimSnapshot | null = null;
  let acquired = false;
  let claimAttempted = false;
  let claimBytes = "";
  try {
    directoryHandle = openHealDirectoryHandle(expectedDirectory.path);
    if (directoryHandle.dev !== expectedDirectory.dev || directoryHandle.ino !== expectedDirectory.ino
      || directoryHandle.mode !== expectedDirectory.mode) {
      throw new Error("review round heal namespace directory identity changed while acquiring");
    }
    assertHealDirectoryHandle(parentHandle, "parent");
    assertHealDirectoryHandle(directoryHandle, "claim");
    hooks?.afterDirectoryHandleOpen?.();

    const lockUuid = randomUUID();
    const lstart = processLstartOf(process.pid);
    if (lstart === null) {
      throw new Error("review round heal lock acquisition requires a current-process lstart identity; ps probe failed");
    }
    const claim = { pid: process.pid, uuid: lockUuid, lstart };
    claimBytes = `${JSON.stringify(claim, null, 2)}\n`;
    const deadline = Date.now() + HEAL_LOCK_TIMEOUT_MS;
    for (;;) {
      // Claim creation, inspection, and stale reclaim all use the directory
      // opened above. The nominal lockPath is intentionally never resolved
      // again after acquisition begins.
      claimAttempted = true;
      const attempt = acquireHealClaimAtHandle(directoryHandle, claimBytes, hooks?.beforeClaimTempCreate);
      if (attempt === "worker_failed") {
        throw new Error("review round heal lock acquisition dependency failed; no path fallback is permitted");
      }
      if (attempt === "acquired") {
        acquired = true;
        break;
      }
      const observed = inspectHealClaimAtHandle(directoryHandle);
      if (observed.status === "worker_failed") {
        throw new Error("review round heal lock inspection dependency failed; no path fallback is permitted");
      }
      if (observed.status === "present" && observed.snapshot) {
        const reclaimed = tryReclaimStaleHealClaimAtHandle(
          directoryHandle,
          observed.snapshot,
          hooks?.replaceClaimAfterVerification,
          hooks?.replaceClaimAfterFinalVerification,
        );
        if (reclaimed === "worker_failed") {
          throw new Error("review round stale heal claim reclaim dependency failed; no path fallback is permitted");
        }
        if (reclaimed === "removed") continue;
      }
      if (Date.now() > deadline) {
        throw new Error("review round heal lock could not be acquired before the deadline");
      }
      syncSleep(HEAL_LOCK_RETRY_MS);
    }
    const acquiredClaim = inspectHealClaimAtHandle(directoryHandle);
    if (acquiredClaim.status === "worker_failed") {
      throw new Error("review round heal lock claim inspection dependency failed; no path fallback is permitted");
    }
    const acquiredSnapshot = acquiredClaim.snapshot;
    if (acquiredClaim.status !== "present" || !acquiredSnapshot || acquiredSnapshot.bytes !== claimBytes) {
      throw new Error("review round heal lock claim was replaced during acquisition");
    }
    ownClaim = acquiredSnapshot;
    // The namespace that was validated before the claim must be unchanged now.
    assertNamespaceUnchanged(namespaceSnapshot);
    assertHealDirectoryHandle(parentHandle, "parent");
    assertHealDirectoryHandle(directoryHandle, "claim");
    heldLocks.set(projectRoot, {
      uuid: lockUuid,
      depth: 1,
      logicalProjectPath: path.resolve(projectDir),
      namespaceSnapshot,
      parentHandle,
      directoryHandle,
      beforeMaintenanceMutation: hooks?.beforeMaintenanceMutation,
      beforeMaintenanceTempCreate: hooks?.beforeMaintenanceTempCreate,
      replaceTemporaryAfterFinalVerification: hooks?.replaceTemporaryAfterFinalVerification,
    });
  } catch (error) {
    // Acquisition can race a namespace swap before the claim is bound to the
    // held descriptor. Recover only an exact own claim; a foreign replacement
    // is deliberately left untouched and reported by the caller's failure.
    let cleanupFailure: Error | null = null;
    if ((acquired || claimAttempted) && directoryHandle) {
      try {
        // There is deliberately no path-based fallback: an unavailable
        // directory-fd release helper must fail closed with the own claim
        // either absent or explicitly left for diagnosis.
        if (!ownClaim) {
          const recovered = inspectHealClaimAtHandle(directoryHandle);
          const recoveredSnapshot = recovered.snapshot;
          if (recovered.status === "present" && recoveredSnapshot && recoveredSnapshot.bytes === claimBytes) ownClaim = recoveredSnapshot;
        }
        if (ownClaim) {
          const cleanup = removeHealClaimAtHandle(directoryHandle, ownClaim, "release");
          if (!["removed", "absent"].includes(cleanup.status)) {
            cleanupFailure = new Error(`review round heal lock acquisition claim cleanup failed closed: ${cleanup.status}`);
          }
        }
      } catch {
        cleanupFailure = new Error("review round heal lock acquisition claim cleanup could not verify the original directory");
      }
    }
    closeHealDirectoryHandle(directoryHandle);
    closeHealDirectoryHandle(parentHandle);
    if (cleanupFailure) {
      throw new Error(`${error instanceof Error ? error.message : String(error)}; ${cleanupFailure.message}`);
    }
    throw error;
  }

  let operationError: { error: unknown } | null = null;
  let operationResult: T | undefined;
  let operationCompleted = false;
  let releaseFailure: Error | null = null;
  try {
    hooks?.beforeOperation?.();
    operationResult = operation();
    // Completion binding: the namespace ancestor identity is re-verified
    // after the operation and BEFORE release. A swap during the operation is
    // never reported as success.
    assertNamespaceUnchanged(namespaceSnapshot);
    operationCompleted = true;
  } catch (error) {
    operationError = { error };
  } finally {
    const heldEntry = heldLocks.get(projectRoot);
    if (heldEntry) {
      heldEntry.depth -= 1;
      if (heldEntry.depth <= 0) heldLocks.delete(projectRoot);
    }

    // Release is bound to both immutable directory handles, not to a fresh
    // resolution of projectRoot/06_review. A rename-retain therefore still
    // reaches the original directory, while a replacement at the nominal
    // path can never redirect the unlink into a new namespace.
    try {
      assertHealDirectoryHandle(parentHandle, "parent");
      assertHealDirectoryHandle(directoryHandle!, "claim");
      try {
        assertNamespaceUnchanged(namespaceSnapshot);
      } catch (error) {
        if (operationError === null) operationError = { error };
      }
      hooks?.beforeReleaseUnlink?.();
      const release = removeHealClaimAtHandle(
        directoryHandle!,
        ownClaim!,
        "release",
        hooks?.replaceClaimAfterVerification,
        hooks?.replaceClaimAfterFinalVerification,
      );
      if (release.status === "absent") {
        releaseFailure = new Error("review round heal lock release lost ownership of the claim");
      } else if (release.status === "mismatch") {
        releaseFailure = new Error("review round heal lock release refused a changed or foreign claim");
      } else if (release.status === "residual_own") {
        releaseFailure = new Error("review round heal lock namespace was swapped during the operation; the own claim remains in the original directory");
      } else if (release.status === "residual_foreign") {
        releaseFailure = new Error("review round heal lock release found a foreign claim in the original directory");
      } else if (release.status === "worker_failed") {
        releaseFailure = new Error("review round heal lock release could not verify the original directory claim");
      }
    } catch {
      releaseFailure = new Error("review round heal lock release could not verify the original parent/directory identity");
    }
    // Release itself must not change the held directory identity. The
    // nominal namespace is checked again after release so a swapped path is
    // never returned as successful even when the original claim was safely
    // recovered through the descriptor.
    try {
      assertHealDirectoryHandle(parentHandle, "parent");
      assertHealDirectoryHandle(directoryHandle!, "claim");
      try {
        assertNamespaceUnchanged(namespaceSnapshot);
      } catch (error) {
        if (operationError === null) operationError = { error };
      }
    } catch {
      if (releaseFailure === null) {
        releaseFailure = new Error("review round heal lock release changed the original parent/directory identity");
      }
    }
    closeHealDirectoryHandle(directoryHandle);
    closeHealDirectoryHandle(parentHandle);
  }
  if (releaseFailure !== null) {
    if (operationError !== null) {
      throw new Error(`${releaseFailure.message}; operation failed: ${operationError.error instanceof Error ? operationError.error.message : String(operationError.error)}`);
    }
    throw releaseFailure;
  }
  // Residual detection on the ORIGINAL expected namespace: a surviving claim
  if (operationError !== null) {
    throw operationError.error;
  }
  if (!operationCompleted) {
    throw new Error("review round heal lock operation did not complete");
  }
  return operationResult as T;
}

function syncSleep(milliseconds: number): void {
  try {
    const buffer = new Int32Array(new SharedArrayBuffer(4));
    Atomics.wait(buffer, 0, 0, milliseconds);
  } catch {
    const spinUntil = Date.now() + milliseconds;
    while (Date.now() < spinUntil) {
      // bounded busy wait where Atomics.wait is unavailable
    }
  }
}
