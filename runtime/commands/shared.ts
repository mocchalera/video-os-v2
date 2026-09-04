/**
 * Command Shared Infrastructure
 *
 * Common utilities for all slash commands:
 * - Project root resolution
 * - project_state.yaml reconcile
 * - Allowed start-state check
 * - Draft/promote pipeline (temp → validate → atomic promote)
 * - State transition + history recording
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { createRequire } from "node:module";
import { isProxy } from "node:util/types";
import {
  reconcile,
  snapshotArtifacts,
  writeProjectState,
  readProjectStateWithRevision,
  computeRevision,
  ConflictError,
  computeFileHash,
  ARTIFACT_IDENTITY_HASH_KEYS,
  type ProjectStateDoc,
  type ProjectState,
  type ReconcileResult,
  type ArtifactHashes,
  type WriteProjectStateOptions,
} from "../state/reconcile.js";
import { closeStaleRunningProgress } from "../progress.js";
import { createHistoryEntry } from "../state/history.js";

// ── AJV setup (CJS interop) ─────────────────────────────────────

const require = createRequire(import.meta.url);
const Ajv2020 = require("ajv/dist/2020") as new (opts: Record<string, unknown>) => {
  compile(schema: object): {
    (data: unknown): boolean;
    errors?: Array<{ instancePath: string; message?: string }> | null;
  };
  addSchema(schema: object): void;
};
const addFormats = require("ajv-formats") as (ajv: unknown) => void;

// ── Types ────────────────────────────────────────────────────────

export interface CommandContext {
  projectDir: string;
  reconcileResult: ReconcileResult;
  doc: ProjectStateDoc;
  preflightHashes: ArtifactHashes;
  /** Revision hash of project_state.yaml after reconcile write, for conflict detection. */
  stateRevision: string;
}

export interface DraftFile {
  /** Relative path inside project (e.g. "01_intent/creative_brief.yaml") */
  relativePath: string;
  /** Schema file name in schemas/ dir */
  schemaFile: string;
  /** The content to write (already parsed object, will be YAML-serialized) */
  content: unknown;
  /** File format */
  format: "yaml" | "json";
  /**
   * Optional route-specific gate applied to the object reparsed from the
   * bytes that are actually staged. This keeps canonical report gates on the
   * serialized representation, not only on the pre-serialization object.
   */
  serializedContentGate?: (parsed: unknown) => void;
}

export interface PromoteResult {
  success: boolean;
  promoted: string[];
  errors: string[];
  failure_kind?: "validation" | "concurrent_edit" | "promote" | "locked" | "recovery_required";
  /** Present only on recovery_required: everything an exact-owner recovery needs. */
  recovery?: {
    transaction_id: string;
    lock_path: string;
    journal_path: string;
    /** Private exact-owner claim, when the canonical lock was moved/linked. */
    claim_path?: string;
  };
}

export interface PromoteOptions {
  preflightHashes?: ArtifactHashes;
  guardKeys?: Array<keyof ArtifactHashes>;
}

export interface CommandError {
  code: "STATE_CHECK_FAILED" | "GATE_CHECK_FAILED" | "VALIDATION_FAILED" | "PROMOTE_FAILED";
  message: string;
  details?: unknown;
}

// ── Project Root Resolution ──────────────────────────────────────

export function resolveProjectRoot(inputPath: string): string {
  const abs = path.resolve(inputPath);
  if (!fs.existsSync(abs)) {
    throw new Error(`Project directory does not exist: ${abs}`);
  }
  return abs;
}

// ── Reconcile + State Check ──────────────────────────────────────

export function initCommand(
  projectDir: string,
  commandName: string,
  allowedStates: ProjectState[],
): CommandContext | CommandError {
  const absDir = resolveProjectRoot(projectDir);

  // Close progress.json left "running" by a dead process. Trackers created
  // by this very process carry the current pid and are never touched.
  closeStaleRunningProgress(absDir);

  // Reconcile on startup
  const result = reconcile(absDir, commandName, commandName);

  // Write reconciled state back (self-heal) — atomic write, no revision guard on init
  writeProjectState(absDir, result.doc);

  // Capture revision of what we just wrote for downstream conflict detection
  const stateRevision = readProjectStateWithRevision(absDir)?.revision ?? "";

  // Check allowed start states
  if (allowedStates.length > 0 && !allowedStates.includes(result.reconciled_state)) {
    return {
      code: "STATE_CHECK_FAILED",
      message: `Command ${commandName} requires state in [${allowedStates.join(", ")}], ` +
        `but current state is "${result.reconciled_state}"`,
      details: {
        current_state: result.reconciled_state,
        allowed_states: allowedStates,
      },
    };
  }

  return {
    projectDir: absDir,
    reconcileResult: result,
    doc: result.doc,
    preflightHashes: { ...(result.doc.artifact_hashes ?? {}) },
    stateRevision,
  };
}

export function isCommandError(v: CommandContext | CommandError): v is CommandError {
  return "code" in v;
}

export function reconcileAndPersist(
  projectDir: string,
  actor: string,
  trigger: string,
): ReconcileResult {
  const result = reconcile(projectDir, actor, trigger);
  result.doc.last_agent = actor;
  result.doc.last_command = trigger;
  writeProjectState(projectDir, result.doc);
  return result;
}

// ── Schema Validation ────────────────────────────────────────────

const schemasDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "../../schemas",
);

/**
 * Parse JSON without allowing duplicate object members. JSON.parse keeps the
 * last value for a duplicate key, which is unsafe for receipt and schema
 * authority: an attacker can make the bytes auditors read differ from the
 * value the runtime validates. The structural scan is deliberately small and
 * leaves grammar/number validation to JSON.parse itself.
 */
export function parseJsonRejectDuplicateKeys<T = unknown>(
  source: string,
  label = "JSON",
): T {
  let index = 0;

  const fail = (message: string): never => {
    throw new Error(`${label}: ${message}`);
  };

  const skipWhitespace = (): void => {
    while (index < source.length && /\s/.test(source[index] ?? "")) index += 1;
  };

  const parseString = (): string => {
    const start = index;
    if (source[index] !== '"') fail(`expected a string at offset ${index}`);
    index += 1;
    while (index < source.length) {
      const char = source[index];
      if (char === "\\") {
        index += 2;
        continue;
      }
      if (char === '"') {
        index += 1;
        try {
          return JSON.parse(source.slice(start, index)) as string;
        } catch {
          fail(`invalid string at offset ${start}`);
        }
      }
      index += 1;
    }
    return fail(`unterminated string at offset ${start}`);
  };

  const parseValue = (): void => {
    skipWhitespace();
    const char = source[index];
    if (char === "{") {
      index += 1;
      skipWhitespace();
      const keys = new Set<string>();
      if (source[index] === "}") {
        index += 1;
        return;
      }
      while (index < source.length) {
        skipWhitespace();
        const key = parseString();
        if (keys.has(key)) fail(`duplicate object key ${JSON.stringify(key)}`);
        keys.add(key);
        skipWhitespace();
        if (source[index] !== ":") fail(`expected ':' after object key at offset ${index}`);
        index += 1;
        parseValue();
        skipWhitespace();
        if (source[index] === "}") {
          index += 1;
          return;
        }
        if (source[index] !== ",") fail(`expected ',' or '}' at offset ${index}`);
        index += 1;
      }
      fail("unterminated object");
    }
    if (char === "[") {
      index += 1;
      skipWhitespace();
      if (source[index] === "]") {
        index += 1;
        return;
      }
      while (index < source.length) {
        parseValue();
        skipWhitespace();
        if (source[index] === "]") {
          index += 1;
          return;
        }
        if (source[index] !== ",") fail(`expected ',' or ']' at offset ${index}`);
        index += 1;
      }
      fail("unterminated array");
    }
    if (char === '"') {
      parseString();
      return;
    }
    const start = index;
    while (index < source.length && !/[\s,\]}]/.test(source[index] ?? "")) index += 1;
    if (index === start) fail(`expected a value at offset ${index}`);
  };

  parseValue();
  skipWhitespace();
  if (index !== source.length) fail(`unexpected token at offset ${index}`);
  try {
    return JSON.parse(source) as T;
  } catch (error) {
    throw new Error(`${label}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function validateAgainstSchema(
  data: unknown,
  schemaFile: string,
): { valid: boolean; errors: string[] } {
  const schemaPath = path.join(schemasDir, schemaFile);
  if (!fs.existsSync(schemaPath)) {
    return { valid: false, errors: [`Schema file not found: ${schemaFile}`] };
  }
  let schema: object;
  try {
    schema = parseJsonRejectDuplicateKeys<object>(
      fs.readFileSync(schemaPath, "utf-8"),
      `schema ${schemaFile}`,
    );
  } catch (error) {
    return {
      valid: false,
      errors: [error instanceof Error ? error.message : String(error)],
    };
  }
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  if (schemaFile === "review-report.schema.json") {
    const wholeCutSchemaFile = "whole-cut-semantic-review.schema.json";
    const wholeCutSchemaPath = path.join(schemasDir, wholeCutSchemaFile);
    if (!fs.existsSync(wholeCutSchemaPath)) {
      return { valid: false, errors: [`Schema file not found: ${wholeCutSchemaFile}`] };
    }
    try {
      ajv.addSchema(parseJsonRejectDuplicateKeys<object>(
        fs.readFileSync(wholeCutSchemaPath, "utf-8"),
        `schema ${wholeCutSchemaFile}`,
      ));
    } catch (error) {
      return {
        valid: false,
        errors: [error instanceof Error ? error.message : String(error)],
      };
    }
  }
  const validate = ajv.compile(schema);
  const valid = validate(data);
  if (!valid) {
    const errors = (validate.errors ?? []).map(
      (e) => `${e.instancePath || "/"}: ${e.message ?? "unknown"}`,
    );
    return { valid: false, errors };
  }
  return { valid: true, errors: [] };
}

/**
 * Validate the data model that can be represented faithfully by the
 * canonical JSON/YAML artifact writers. Schema validators may walk inherited
 * properties and accessors even though JSON/YAML serialization does not, so
 * canonical gates must reject those values before asking AJV to validate.
 * Proxies are rejected explicitly: their traps can make validation and
 * serialization observe different values even when the visible shape looks
 * ordinary.
 */
export function validatePlainData(data: unknown): { valid: boolean; errors: string[] } {
  const active = new WeakSet<object>();
  const arrayIndex = /^(0|[1-9][0-9]*)$/;

  const visit = (value: unknown, location: string): string | null => {
    if (value === null || typeof value === "string" || typeof value === "boolean") return null;
    if (typeof value === "number") {
      return Number.isFinite(value) ? null : `${location}: non-finite numbers are not canonical data`;
    }
    if (typeof value !== "object") {
      return `${location}: ${typeof value} values are not canonical serialized data`;
    }
    if (isProxy(value)) return `${location}: proxy values are not accepted as canonical data`;
    if (active.has(value)) return `${location}: cyclic data is not accepted as canonical data`;
    active.add(value);
    try {
      let prototype: object | null;
      try {
        prototype = Object.getPrototypeOf(value);
      } catch {
        return `${location}: object prototype could not be inspected`;
      }
      const isArray = Array.isArray(value);
      if (isArray) {
        if (prototype !== Array.prototype && prototype !== null) {
          return `${location}: array must use the built-in or null prototype`;
        }
        const length = (value as unknown[]).length;
        for (let index = 0; index < length; index++) {
          if (!Object.prototype.hasOwnProperty.call(value, String(index))) {
            return `${location}: sparse arrays are not accepted as canonical data`;
          }
        }
      } else if (prototype !== Object.prototype && prototype !== null) {
        return `${location}: object must use the built-in or null prototype`;
      }

      let keys: Array<string | symbol>;
      try {
        keys = Reflect.ownKeys(value);
      } catch {
        return `${location}: own properties could not be inspected`;
      }
      for (const key of keys) {
        if (isArray && key === "length") continue;
        if (typeof key !== "string") return `${location}: symbol properties are not canonical data`;
        if (isArray && !arrayIndex.test(key)) {
          return `${location}.${key}: array properties must be numeric indices`;
        }
        let descriptor: PropertyDescriptor | undefined;
        try {
          descriptor = Object.getOwnPropertyDescriptor(value, key);
        } catch {
          return `${location}.${key}: property descriptor could not be inspected`;
        }
        if (!descriptor || !("value" in descriptor)) {
          return `${location}.${key}: accessor properties are not accepted as canonical data`;
        }
        if (!descriptor.enumerable) {
          return `${location}.${key}: non-enumerable properties are not serialized canonical data`;
        }
        const nestedError = visit(descriptor.value, `${location}.${key}`);
        if (nestedError) return nestedError;
      }
      return null;
    } finally {
      active.delete(value);
    }
  };

  const error = visit(data, "$");
  return error ? { valid: false, errors: [error] } : { valid: true, errors: [] };
}

// ── Draft/Promote Pipeline ───────────────────────────────────────
//
// 1. Write draft to temp file (.draft.yaml / .draft.json)
// 2. Validate against schema
// 3. If all drafts valid → transactional promote:
//    - precondition hash verification of guarded inputs
//    - task-owned lock (stale locks are recoverable only from process identity/liveness)
//    - re-verification under lock
//    - staged outputs with a durable journal of prior canonical files
//    - postcondition hash verification after renames
//    - rollback of promoted outputs if any guarded input changed after the
//      check or during rename; external mutations are preserved
// 4. If any invalid → leave drafts, return errors

const PROMOTE_LOCK_FILE = ".vos-promote.lock";
const PROMOTE_JOURNAL_PREFIX = ".vos-promote-journal-";
const PROMOTE_JOURNAL_TRASH_PREFIX = ".vos-promote-journal-trash-";
const PROMOTE_CLAIM_DIR_PREFIX = ".vos-promote-claim-";
const PROMOTE_RECOVERY_GUARD_PREFIX = ".vos-promote-recovery-";
const PROMOTE_RECOVERY_COMPLETION_FILE = "completion.json";
interface PromoteLockIdentity {
  host: string;
  pid: number;
  /**
   * Immutable OS process-start identity, compared as the exact normalized
   * value on every check: on Linux the kernel start tick from
   * /proc/<pid>/stat field 22 (boot-relative, wall-clock independent); on
   * macOS the LC_ALL=C `ps lstart` row parsed against the exact locale-stable
   * date grammar into one unambiguous normalized instant. Never derived from
   * Date.now and never an age.
   */
  start_identity: string;
  transaction_id: string;
  acquired_at: string;
}

function jsonDigest(value: unknown): string {
  return crypto.createHash("sha256").update(JSON.stringify(value), "utf-8").digest("hex");
}

const MAC_LSTART_GRAMMAR =
  /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) ([ \d]\d) (\d{2}):(\d{2}):(\d{2}) (\d{4})$/;
const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
};
const MONTH_INDEX: Record<string, number> = {
  Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5,
  Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11,
};

/**
 * Parse one C-locale `ps lstart` row (e.g. "Sun Aug 30 14:03:11 2026") into
 * one unambiguous normalized instant. Empty, multiline, wrong grammar, or
 * otherwise ambiguous output yields null (unknown) — never a guess.
 */
function normalizeMacLstart(row: string): string | null {
  const match = MAC_LSTART_GRAMMAR.exec(row);
  if (!match) return null;
  const [ , weekday, month, day, hh, mm, ss, year] = match;
  const instant = new Date(
    Number(year),
    MONTH_INDEX[month],
    Number(day),
    Number(hh),
    Number(mm),
    Number(ss),
  );
  if (Number.isNaN(instant.getTime())) return null;
  if (instant.getFullYear() !== Number(year) ||
    instant.getMonth() !== MONTH_INDEX[month] ||
    instant.getDate() !== Number(day) ||
    instant.getHours() !== Number(hh) ||
    instant.getMinutes() !== Number(mm) ||
    instant.getSeconds() !== Number(ss) ||
    instant.getDay() !== WEEKDAY_INDEX[weekday]) {
    return null;
  }
  return `macos:lstart:${instant.toISOString()}`;
}

function processStartIdentity(pid: number): string | null {
  if (process.platform === "linux") {
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf-8");
      const closeParen = stat.lastIndexOf(")");
      if (closeParen === -1) return null;
      const afterComm = stat.slice(closeParen + 2).split(" ");
      const startTicks = afterComm[19]; // overall field 22 (starttime ticks)
      if (!startTicks) return null;
      return `linux:starttick:${startTicks}`;
    } catch {
      return null;
    }
  }
  try {
    const out = execFileSync("ps", ["-p", String(pid), "-o", "lstart="], {
      encoding: "utf-8",
      env: { ...process.env, LC_ALL: "C" },
    });
    // Exactly one nonempty row is expected. Empty, multiline, or otherwise
    // ambiguous output is unknown — never guessed.
    const rows = out.split("\n").map((line) => line.trim()).filter((line) => line.length > 0);
    if (rows.length !== 1) return null;
    return normalizeMacLstart(rows[0]);
  } catch {
    return null;
  }
}

let selfStartIdentityCache: string | null = null;
function selfStartIdentity(): string | null {
  if (selfStartIdentityCache === null) {
    selfStartIdentityCache = processStartIdentity(process.pid);
  }
  return selfStartIdentityCache;
}

/**
 * Structural validation of a recoverable lock record. Every field is
 * required: host, PID, stable process-start identity, and a nonempty
 * transaction nonce. Missing or partial identity — including a missing
 * nonce — yields null, which callers must treat as unknown and fail closed.
 */
function parsePromoteLockIdentity(raw: unknown): PromoteLockIdentity | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  if (typeof record.host !== "string" || record.host.length === 0) return null;
  if (typeof record.pid !== "number" || !Number.isInteger(record.pid) || record.pid <= 0) return null;
  if (typeof record.start_identity !== "string" || record.start_identity.length === 0) return null;
  if (typeof record.transaction_id !== "string" ||
    !/^[A-Za-z0-9._-]+$/.test(record.transaction_id)) return null;
  if (typeof record.acquired_at !== "string" || record.acquired_at.length === 0) return null;
  return {
    host: record.host,
    pid: record.pid,
    start_identity: record.start_identity,
    transaction_id: record.transaction_id,
    acquired_at: record.acquired_at,
  };
}

type OwnerLiveness = "alive" | "dead" | "unknown";

/**
 * Prove whether the recorded lock owner is still alive by comparing the
 * immutable process-start identity as the exact normalized value — never age,
 * never a tolerance window, never wall-clock arithmetic:
 * - foreign host, unreadable identity, or EPERM is "unknown" and fails closed;
 * - ESRCH (no such process) is "dead";
 * - a running PID whose current start identity differs from the recorded one
 *   is a PID reuse — the recorded owner is dead;
 * - a self-PID record whose start identity fails to read or mismatches is
 *   "unknown" — a live or unreadable self is never dead or stealable.
 */
function ownerLiveness(identity: PromoteLockIdentity): OwnerLiveness {
  if (identity.host !== os.hostname()) return "unknown";

  if (identity.pid === process.pid) {
    const self = selfStartIdentity();
    if (self === null) return "unknown"; // self read failure is unknown
    return self === identity.start_identity ? "alive" : "unknown"; // self mismatch is unknown
  }

  const current = processStartIdentity(identity.pid);
  if (current === null) {
    try {
      process.kill(identity.pid, 0);
      return "unknown"; // exists but start identity unqueryable — fail closed
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ESRCH" ? "dead" : "unknown";
    }
  }
  return current === identity.start_identity ? "alive" : "dead";
}

interface ObservedLock {
  fd: number;
  ino: number;
  dev: number;
  identity: PromoteLockIdentity;
  raw_record: string;
  record_digest: string;
}

/**
 * Open the lock path and capture the exact filesystem identity (inode/device)
 * plus the complete parsed owner record and its digest. Symlinks, non-regular
 * objects, and partial records are rejected as unknown; hardlinks are
 * accepted only by the explicit recovery/release claim path. The returned
 * descriptor stays open and must be closed by the caller on every path.
 */
function observeLockFile(
  lockPath: string,
  options: { allowHardLink?: boolean } = {},
): ObservedLock | null {
  let lstat: fs.Stats;
  try {
    lstat = fs.lstatSync(lockPath);
  } catch {
    return null;
  }
  if (!lstat.isFile() || (!options.allowHardLink && lstat.nlink !== 1) ||
    (options.allowHardLink && lstat.nlink < 1)) return null;
  let fd: number;
  try {
    fd = fs.openSync(lockPath, "r");
  } catch {
    return null;
  }
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || (!options.allowHardLink && stat.nlink !== 1) ||
      (options.allowHardLink && stat.nlink < 1)) {
      fs.closeSync(fd);
      return null;
    }
    const rawRecord = fs.readFileSync(fd, "utf-8");
    const identity = parsePromoteLockIdentity(JSON.parse(rawRecord));
    if (!identity) {
      fs.closeSync(fd);
      return null;
    }
    return {
      fd,
      ino: stat.ino,
      dev: stat.dev,
      identity,
      raw_record: rawRecord,
      record_digest: jsonDigest(identity),
    };
  } catch {
    fs.closeSync(fd);
    return null;
  }
}

function recordsMatch(a: ObservedLock, b: ObservedLock): boolean {
  return a.ino === b.ino &&
    a.dev === b.dev &&
    a.record_digest === b.record_digest &&
    a.raw_record === b.raw_record &&
    a.identity.transaction_id === b.identity.transaction_id;
}

interface AcquiredLockRecord {
  identity: PromoteLockIdentity;
  raw_record: string;
  record_digest: string;
  ino: number;
  dev: number;
}

/**
 * Exclusively create the lock record and capture the exact bytes, digest,
 * and filesystem identity written at acquisition. Release later compares the
 * claimed moved record against THIS acquisition record — never against a
 * later observation or a nonce alone.
 */
function writeLockRecord(lockPath: string, identity: PromoteLockIdentity): AcquiredLockRecord {
  const rawRecord = JSON.stringify(identity, null, 2);
  const fd = fs.openSync(lockPath, "wx");
  try {
    fs.writeSync(fd, rawRecord, 0, "utf-8");
    fs.fsyncSync(fd);
    const stat = fs.fstatSync(fd);
    return {
      identity,
      raw_record: rawRecord,
      record_digest: jsonDigest(identity),
      ino: stat.ino,
      dev: stat.dev,
    };
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Create a private mode-0700 transaction directory with an exclusive
 * (EEXIST-retrying) collision-resistant unpredictable name for recovery
 * claims. The claim destination inside a freshly created directory is proven
 * absent, so a claim rename can never overwrite prior evidence.
 */
function createPrivateClaimDir(projectDir: string, nonce: string): string {
  for (let attempt = 0; attempt < 5; attempt++) {
    const claimDir = path.join(
      projectDir,
      `${PROMOTE_CLAIM_DIR_PREFIX}${nonce}-${crypto.randomUUID()}`,
    );
    try {
      fs.mkdirSync(claimDir, { mode: 0o700 });
      return claimDir;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  throw new Error("unable to create a private claim directory");
}

function removeEmptyClaimDir(claimDir: string): void {
  try { fs.rmdirSync(claimDir); } catch { /* preserve non-empty evidence */ }
}

function listRecoveryGuards(projectDir: string, transactionId?: string): string[] | null {
  const prefix = transactionId
    ? `${PROMOTE_RECOVERY_GUARD_PREFIX}${transactionId}-`
    : PROMOTE_RECOVERY_GUARD_PREFIX;
  try {
    return fs.readdirSync(projectDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith(prefix))
      .map((entry) => path.join(projectDir, entry.name));
  } catch {
    return null;
  }
}

function hasActiveRecoveryGuard(projectDir: string): boolean {
  const guards = listRecoveryGuards(projectDir);
  // An unreadable guard directory listing is treated as occupied. A writer
  // must never proceed while recovery ownership cannot be classified.
  return guards === null || guards.length > 0;
}

function createRecoveryGuard(
  projectDir: string,
  transactionId: string,
  owner: { host: string; pid: number; start_identity: string },
): string {
  for (let attempt = 0; attempt < 5; attempt++) {
    const guardDir = path.join(
      projectDir,
      `${PROMOTE_RECOVERY_GUARD_PREFIX}${transactionId}-${crypto.randomUUID()}`,
    );
    let createdGuard = false;
    try {
      fs.mkdirSync(guardDir, { mode: 0o700 });
      createdGuard = true;
      fs.chmodSync(guardDir, 0o700);
      const guardPath = path.join(guardDir, "guard.json");
      const fd = fs.openSync(guardPath, "wx", 0o600);
      try {
        fs.writeSync(fd, JSON.stringify({
          kind: "promote-recovery-guard",
          transaction_id: transactionId,
          owner,
        }, null, 2), 0, "utf-8");
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      syncFile(guardPath);
      syncDirectory(guardDir);
      syncDirectory(projectDir);
      return guardDir;
    } catch (error) {
      if (createdGuard) {
        try { fs.rmSync(guardDir, { recursive: true, force: true }); } catch { /* preserve the original failure */ }
      }
      if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
      throw error;
    }
  }
  throw new Error("unable to create a private recovery guard directory");
}

function recoveryGuardMatches(
  guardDir: string,
  transactionId: string,
  owner: { host: string; pid: number; start_identity: string },
): boolean {
  try {
    const dirStat = fs.lstatSync(guardDir);
    const guardPath = path.join(guardDir, "guard.json");
    const fileStat = fs.lstatSync(guardPath);
    if (!dirStat.isDirectory() || (dirStat.mode & 0o777) !== 0o700 ||
      !fileStat.isFile() || fileStat.nlink !== 1 || (fileStat.mode & 0o777) !== 0o600) return false;
    const parsed = JSON.parse(fs.readFileSync(guardPath, "utf-8")) as Record<string, unknown>;
    const recordedOwner = parsed.owner as Record<string, unknown> | undefined;
    return parsed.kind === "promote-recovery-guard" &&
      parsed.transaction_id === transactionId &&
      !!recordedOwner && !Array.isArray(recordedOwner) &&
      recordedOwner.host === owner.host &&
      recordedOwner.pid === owner.pid &&
      recordedOwner.start_identity === owner.start_identity;
  } catch {
    return false;
  }
}

function ensureRecoveryGuard(
  projectDir: string,
  transactionId: string,
  owner: { host: string; pid: number; start_identity: string },
): string {
  const guards = listRecoveryGuards(projectDir, transactionId);
  if (guards === null) throw new Error("recovery guard state could not be inspected");
  if (guards.length > 1) throw new Error("multiple recovery guards exist for the transaction");
  if (guards.length === 1) {
    if (!recoveryGuardMatches(guards[0], transactionId, owner)) {
      throw new Error("recovery guard does not match the transaction owner");
    }
    return guards[0];
  }
  return createRecoveryGuard(projectDir, transactionId, owner);
}

function removeRecoveryGuard(guardDir: string): void {
  fs.rmSync(guardDir, { recursive: true, force: true });
  try { syncDirectory(path.dirname(guardDir)); } catch { /* cleanup completed; retain no data */ }
}

function acquiredRecordMatches(observed: ObservedLock, acquired: AcquiredLockRecord): boolean {
  return observed.ino === acquired.ino &&
    observed.dev === acquired.dev &&
    observed.raw_record === acquired.raw_record &&
    observed.record_digest === acquired.record_digest &&
    observed.identity.transaction_id === acquired.identity.transaction_id &&
    observed.identity.host === acquired.identity.host &&
    observed.identity.pid === acquired.identity.pid &&
    observed.identity.start_identity === acquired.identity.start_identity;
}

/**
 * Remove the canonical lock only when it is still the exact record captured
 * at acquisition. A failed comparison keeps the competing evidence intact.
 */
function removeExactAcquiredLock(projectDir: string, acquired: AcquiredLockRecord): boolean {
  const lockPath = path.join(projectDir, PROMOTE_LOCK_FILE);
  const observed = observeLockFile(lockPath);
  if (!observed) return false;
  try {
    if (!acquiredRecordMatches(observed, acquired)) return false;
    fs.unlinkSync(lockPath);
    return true;
  } catch {
    return false;
  } finally {
    fs.closeSync(observed.fd);
  }
}

/**
 * Re-establish the exact owner record after canonical lock removal has
 * succeeded but a later journal-disposal step failed. The guard excludes
 * challengers while this is attempted; a foreign/replacement record is never
 * overwritten. The recreated record keeps the transaction identity and is
 * durable before recovery is allowed to inspect it.
 */
function restoreAcquiredLockRecord(projectDir: string, acquired: AcquiredLockRecord): boolean {
  const lockPath = path.join(projectDir, PROMOTE_LOCK_FILE);
  const existing = observeLockFile(lockPath, { allowHardLink: true });
  if (existing) {
    const matches = existing.raw_record === acquired.raw_record &&
      existing.record_digest === acquired.record_digest &&
      existing.identity.host === acquired.identity.host &&
      existing.identity.pid === acquired.identity.pid &&
      existing.identity.start_identity === acquired.identity.start_identity &&
      existing.identity.transaction_id === acquired.identity.transaction_id;
    fs.closeSync(existing.fd);
    return matches;
  }
  try {
    const restored = writeLockRecord(lockPath, acquired.identity);
    if (restored.raw_record !== acquired.raw_record ||
      restored.record_digest !== acquired.record_digest) return false;
    syncDirectory(projectDir);
    return true;
  } catch {
    return false;
  }
}

function acquirePromoteLock(
  projectDir: string,
  transactionId: string,
): { ok: boolean; lockedBy?: string; acquired?: AcquiredLockRecord } {
  const lockPath = path.join(projectDir, PROMOTE_LOCK_FILE);
  const selfIdentity = selfStartIdentity();
  if (selfIdentity === null) {
    // Self lock creation must fail rather than write a placeholder identity.
    return { ok: false, lockedBy: "own-process-start-identity-unavailable" };
  }
  for (let attempt = 0; attempt < 2; attempt++) {
    if (hasActiveRecoveryGuard(projectDir)) {
      return { ok: false, lockedBy: "recovery-in-progress" };
    }
    // An incomplete journal is recovery authority, not stale promotion
    // residue. Refuse both a fresh lock and dead-owner reclamation until the
    // public recovery route resolves it, so a new transaction cannot orphan
    // the prior copy or replace the journal's canonical owner.
    const incompleteJournals = findIncompleteJournalPaths(projectDir);
    if (incompleteJournals === null) {
      return { ok: false, lockedBy: "journal-state-unavailable" };
    }
    if (incompleteJournals.length > 0) {
      return {
        ok: false,
        lockedBy: "incomplete-journal-requires-public-recovery",
      };
    }
    try {
      const acquired = writeLockRecord(lockPath, {
        host: os.hostname(),
        pid: process.pid,
        start_identity: selfIdentity,
        transaction_id: transactionId,
        acquired_at: new Date().toISOString(),
      });
      // Recovery may have crossed its guard creation boundary while this
      // writer was creating the canonical lock. Remove only our exact record
      // and fail closed; never write through a recovery exclusion.
      if (hasActiveRecoveryGuard(projectDir)) {
        if (!removeExactAcquiredLock(projectDir, acquired)) {
          return { ok: false, lockedBy: "recovery-started-after-acquisition" };
        }
        return { ok: false, lockedBy: "recovery-in-progress" };
      }
      return { ok: true, acquired };
    } catch {
      // Contested. Recovery requires the exact observed owner record to be
      // structurally valid and positively proven dead, then a kernel-atomic
      // rename-to-private-claim claim — never a compare-then-unlink on the
      // shared canonical pathname.
      if (hasActiveRecoveryGuard(projectDir)) {
        return { ok: false, lockedBy: "recovery-in-progress" };
      }
      const observed = observeLockFile(lockPath);
      if (!observed) {
        return { ok: false, lockedBy: "malformed-or-partial-lock" };
      }
      const liveness = ownerLiveness(observed.identity);
      if (liveness !== "dead") {
        fs.closeSync(observed.fd);
        return { ok: false, lockedBy: `pid ${observed.identity.pid} (${liveness})` };
      }
      // Kernel-atomic claim: move the lock pathname into a newly created
      // private mode-0700 transaction directory whose claim destination is
      // proven absent, so the rename can never overwrite prior evidence.
      if (hasActiveRecoveryGuard(projectDir)) {
        fs.closeSync(observed.fd);
        return { ok: false, lockedBy: "recovery-in-progress" };
      }
      const claimDir = createPrivateClaimDir(projectDir, transactionId);
      const claimPath = path.join(claimDir, "claimed-lock.json");
      try {
        fs.renameSync(lockPath, claimPath);
      } catch {
        fs.closeSync(observed.fd);
        removeEmptyClaimDir(claimDir);
        return { ok: false, lockedBy: "claim-move-failed" };
      }
      // Revalidate the moved object as the exact previously observed complete
      // owner record (inode/device plus full record and digest).
      const moved = observeLockFile(claimPath);
      fs.closeSync(observed.fd);
      const exact = moved !== null && recordsMatch(observed, moved);
      if (moved) fs.closeSync(moved.fd);
      if (!exact) {
        // A different/replacement/live object was moved. Never delete it:
        // restore it to the canonical path when safely possible, otherwise
        // retain it in this transaction's clearly-owned private directory.
        if (!fs.existsSync(lockPath)) {
          try {
            fs.renameSync(claimPath, lockPath);
            removeEmptyClaimDir(claimDir);
          } catch { /* retained */ }
          return { ok: false, lockedBy: "lock-replaced-during-recovery" };
        }
        return { ok: false, lockedBy: "lock-replaced-and-canonical-reacquired" };
      }
      // Exact dead-owner record claimed. Acquisition of the canonical path
      // must still be exclusive: if another owner created it meanwhile, fail
      // closed and retain the claimed dead record (never deleted).
      let reacquired: AcquiredLockRecord;
      try {
        reacquired = writeLockRecord(lockPath, {
          host: os.hostname(),
          pid: process.pid,
          start_identity: selfIdentity,
          transaction_id: transactionId,
          acquired_at: new Date().toISOString(),
        });
      } catch {
        return { ok: false, lockedBy: "canonical-reacquired-by-another-owner" };
      }
      // The canonical lock is ours; the claimed dead record is a private,
      // validated object of this transaction and is removed.
      try { fs.unlinkSync(claimPath); } catch { /* non-destructive residue */ }
      removeEmptyClaimDir(claimDir);
      return { ok: true, acquired: reacquired };
    }
  }
  return { ok: false, lockedBy: "unrecoverable-lock" };
}

interface PromotedLockClaim {
  claimDir: string;
  claimPath: string;
}

/**
 * Move and validate the exact lock record written at acquisition. The caller
 * owns the returned private claim and decides when it is safe to remove it.
 */
function claimPromoteLock(
  projectDir: string,
  acquired: AcquiredLockRecord,
): { claim?: PromotedLockClaim; retainedClaim?: PromotedLockClaim; error?: string } {
  const transactionId = acquired.identity.transaction_id;
  const lockPath = path.join(projectDir, PROMOTE_LOCK_FILE);
  let claimDir: string;
  try {
    claimDir = createPrivateClaimDir(projectDir, `release-${transactionId}`);
  } catch (error) {
    return { error: `release-claim-directory-failed: ${String(error)}` };
  }
  const claimPath = path.join(claimDir, "claimed-lock.json");
  try {
    fs.renameSync(lockPath, claimPath);
  } catch (error) {
    removeEmptyClaimDir(claimDir);
    return { error: `release-move-failed: ${String(error)}` };
  }
  // Revalidate the moved object against the acquisition record.
  const moved = observeLockFile(claimPath);
  const exact = moved !== null && acquiredRecordMatches(moved, acquired);
  if (moved) fs.closeSync(moved.fd);
  if (!exact) {
    // A same-nonce foreign record or a replacement was moved: never delete
    // it — restore it to the canonical path when safely possible, otherwise
    // retain it in the transaction-private claim directory.
    if (!fs.existsSync(lockPath)) {
      try {
        fs.renameSync(claimPath, lockPath);
        removeEmptyClaimDir(claimDir);
      } catch { /* retained */ }
    }
    return {
      retainedClaim: { claimDir, claimPath },
      error: "release-moved-record-differs-from-acquisition",
    };
  }
  return { claim: { claimDir, claimPath } };
}

/**
 * Create a private hard-link claim while retaining the canonical pathname.
 * The two names deliberately share one inode so recovery/writer exclusion
 * survives the entire release and journal-disposal sequence.
 */
function linkPromoteLock(
  projectDir: string,
  acquired: AcquiredLockRecord,
): { claim?: PromotedLockClaim; retainedClaim?: PromotedLockClaim; error?: string } {
  const transactionId = acquired.identity.transaction_id;
  const lockPath = path.join(projectDir, PROMOTE_LOCK_FILE);
  let claimDir: string;
  try {
    claimDir = createPrivateClaimDir(projectDir, `release-${transactionId}`);
  } catch (error) {
    return { error: `release-claim-directory-failed: ${String(error)}` };
  }
  const claimPath = path.join(claimDir, "claimed-lock.json");
  try {
    fs.linkSync(lockPath, claimPath);
  } catch (error) {
    removeEmptyClaimDir(claimDir);
    return { error: `release-hard-link-failed: ${String(error)}` };
  }
  const canonical = observeLockFile(lockPath, { allowHardLink: true });
  const claimed = observeLockFile(claimPath, { allowHardLink: true });
  const exact = canonical !== null && claimed !== null &&
    acquiredRecordMatches(canonical, acquired) && acquiredRecordMatches(claimed, acquired);
  if (canonical) fs.closeSync(canonical.fd);
  if (claimed) fs.closeSync(claimed.fd);
  if (!exact) {
    return {
      retainedClaim: { claimDir, claimPath },
      error: "release-hard-linked-record-differs-from-acquisition",
    };
  }
  return { claim: { claimDir, claimPath } };
}

/**
 * Atomic lock release bound to the EXACT record written at acquisition. The
 * validated private claim is removed only after the caller has completed its
 * transaction state transition.
 */
function releasePromoteLock(
  projectDir: string,
  acquired: AcquiredLockRecord,
): { released: boolean; claim_path?: string; error?: string } {
  const claimed = claimPromoteLock(projectDir, acquired);
  if (!claimed.claim) {
    return {
      released: false,
      ...(claimed.retainedClaim ? { claim_path: claimed.retainedClaim.claimPath } : {}),
      error: claimed.error,
    };
  }
  // Full identity validation passed: remove the private claimed object.
  try {
    fs.unlinkSync(claimed.claim.claimPath);
  } catch (error) {
    return {
      released: false,
      claim_path: claimed.claim.claimPath,
      error: `release-claim-cleanup-failed: ${String(error)}`,
    };
  }
  removeEmptyClaimDir(claimed.claim.claimDir);
  return { released: true };
}

function guardedInputPaths(
  guardKeys: Array<keyof ArtifactHashes>,
  excludedRelPaths: Set<string>,
): Array<{ key: keyof ArtifactHashes; relPath: string }> {
  const keyToPath: Record<string, string> = {};
  for (const [relPath, key] of Object.entries(ARTIFACT_IDENTITY_HASH_KEYS)) {
    keyToPath[key] = relPath;
  }
  return guardKeys
    .map((key) => ({ key, relPath: keyToPath[String(key)] }))
    .filter((item): item is { key: keyof ArtifactHashes; relPath: string } =>
      !!item.relPath && !excludedRelPaths.has(item.relPath));
}

function verifyGuardedInputs(
  projectDir: string,
  preflightHashes: ArtifactHashes,
  guardKeys: Array<keyof ArtifactHashes>,
  excludedRelPaths: Set<string>,
): string[] {
  const mismatches: string[] = [];
  for (const { key, relPath } of guardedInputPaths(guardKeys, excludedRelPaths)) {
    const absPath = path.join(projectDir, relPath);
    const recorded = preflightHashes[key];
    if (!fs.existsSync(absPath)) {
      if (recorded) mismatches.push(`${String(key)} changed: ${relPath} was removed`);
      continue;
    }
    const current = computeFileHash(absPath);
    if (recorded !== current) {
      mismatches.push(
        `${String(key)} changed from "${recorded ?? "null"}" to "${current}" (${relPath})`,
      );
    }
  }
  return mismatches;
}

class PromoteConcurrentEditError extends Error {
  readonly mismatches: string[];
  constructor(mismatches: string[]) {
    super(`guarded inputs changed during promotion: ${mismatches.join("; ")}`);
    this.mismatches = mismatches;
  }
}

interface JournalEntry {
  /** Project-relative canonical output path. */
  final: string;
  /** Hash of the staged (new) bytes this transaction intended to promote. */
  staged_hash: string;
  staged_ino: number;
  staged_dev: number;
  /** Hash of the prior canonical bytes, when a prior file existed. */
  prior_hash: string | null;
  prior_ino: number | null;
  prior_dev: number | null;
  had_prior: boolean;
  /** Content-addressed journal file holding the prior bytes, if any. */
  prior_file: string | null;
}

interface TransactionJournal {
  kind: "promote-transaction-journal";
  transaction_id: string;
  owner: { host: string; pid: number; start_identity: string };
  phase: "intent";
  entries: JournalEntry[];
  recorded_at: string;
  record_digest: string;
}

interface RecoveryCompletionEntry {
  final: string;
  state: "present" | "absent";
  hash: string | null;
  ino: number | null;
  dev: number | null;
}

interface RecoveryCompletion {
  kind: "promote-recovery-completion";
  transaction_id: string;
  owner: { host: string; pid: number; start_identity: string };
  journal_digest: string;
  /** Digest also appears in the pre-established recovery-guard directory name. */
  anchor_digest: string;
  outcome: "commit" | "rollback";
  entries: RecoveryCompletionEntry[];
  record_digest: string;
}

function journalRecordDigest(journal: Omit<TransactionJournal, "record_digest">): string {
  return jsonDigest({
    transaction_id: journal.transaction_id,
    owner: journal.owner,
    phase: journal.phase,
    entries: journal.entries,
    recorded_at: journal.recorded_at,
  });
}

const FILE_HASH_GRAMMAR = /^[0-9a-f]{16}$/;
const DIGEST_GRAMMAR = /^[0-9a-f]{64}$/;

function regularSingleLink(pathname: string): fs.Stats | null {
  try {
    const stat = fs.lstatSync(pathname);
    return stat.isFile() && stat.nlink === 1 ? stat : null;
  } catch {
    return null;
  }
}

function lstatIfPresent(pathname: string): fs.Stats | null {
  try {
    return fs.lstatSync(pathname);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function syncDirectory(pathname: string): void {
  const fd = fs.openSync(pathname, "r");
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

function syncFile(pathname: string): void {
  const fd = fs.openSync(pathname, "r");
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

/**
 * Establish durability for a canonical output and its containing directory.
 * A missing output is still a directory mutation and therefore syncs only
 * the parent; symlinks and hardlinks are never opened as canonical files.
 */
function syncCanonicalOutput(pathname: string): void {
  if (regularSingleLink(pathname)) syncFile(pathname);
  syncDirectory(path.dirname(pathname));
}

function journalTransactionId(journalDir: string): string {
  const base = path.basename(journalDir);
  if (!base.startsWith(PROMOTE_JOURNAL_PREFIX)) {
    throw new Error(`invalid transaction journal path: ${journalDir}`);
  }
  return base.slice(PROMOTE_JOURNAL_PREFIX.length);
}

/**
 * Create the durable transaction journal: a private mode-0700 directory
 * holding an fsynced journal.json plus content-addressed copies of every
 * prior canonical byte. Created and fully persisted BEFORE any prior
 * canonical byte is moved or removed; any failure aborts before canonical
 * mutation.
 */
function createJournalBundle(
  projectDir: string,
  transactionId: string,
  owner: { host: string; pid: number; start_identity: string },
  draftPaths: Array<{
    final: string;
    stagedHash?: string;
    stagedIno?: number;
    stagedDev?: number;
    hadPrior?: boolean;
    draft: string;
  }>,
): { journalDir: string; journal: TransactionJournal } {
  const journalDir = path.join(projectDir, `${PROMOTE_JOURNAL_PREFIX}${transactionId}`);
  fs.mkdirSync(journalDir, { mode: 0o700 });
  try {
    fs.chmodSync(journalDir, 0o700);
    const priorDir = path.join(journalDir, "prior");
    fs.mkdirSync(priorDir, { mode: 0o700 });
    fs.chmodSync(priorDir, 0o700);
    const entries: JournalEntry[] = draftPaths.map((entry) => {
      const stagedStat = regularSingleLink(entry.draft);
      if (!stagedStat || computeFileHash(entry.draft) !== entry.stagedHash) {
        throw new Error(`staged bytes changed before the journal became durable: ${entry.draft}`);
      }
      if (!entry.hadPrior) {
        if (lstatIfPresent(entry.final)) {
          throw new Error(`canonical output appeared before the journal was durable: ${entry.final}`);
        }
        return {
          final: path.relative(projectDir, entry.final),
          staged_hash: entry.stagedHash!,
          staged_ino: entry.stagedIno!,
          staged_dev: entry.stagedDev!,
          prior_hash: null,
          prior_ino: null,
          prior_dev: null,
          had_prior: false,
          prior_file: null,
        };
      }
      // Copy (never move) the prior canonical bytes into the journal.
      const priorStat = regularSingleLink(entry.final);
      if (!priorStat) {
        throw new Error(`prior canonical output is not a regular single-linked file: ${entry.final}`);
      }
      const priorHash = computeFileHash(entry.final);
      const priorFile = path.join("prior", `${priorHash}.bin`);
      const priorPath = path.join(journalDir, priorFile);
      const existingPrior = lstatIfPresent(priorPath);
      if (existingPrior) {
        if (!existingPrior.isFile() || existingPrior.nlink !== 1) {
          throw new Error(`content-addressed prior copy is not a regular single-linked file: ${priorFile}`);
        }
        if (computeFileHash(priorPath) !== priorHash) {
          throw new Error(`content-addressed prior copy differs from its hash: ${priorFile}`);
        }
      } else {
        fs.copyFileSync(entry.final, priorPath);
      }
      syncFile(priorPath);
      const priorFd = fs.openSync(priorPath, "r");
      let priorIno = 0;
      let priorDev = 0;
      try {
        fs.fsyncSync(priorFd);
        const priorStat = fs.fstatSync(priorFd);
        priorIno = priorStat.ino;
        priorDev = priorStat.dev;
      } finally {
        fs.closeSync(priorFd);
      }
      if (computeFileHash(priorPath) !== priorHash) {
        throw new Error(`prior canonical bytes changed while journaling: ${entry.final}`);
      }
      return {
        final: path.relative(projectDir, entry.final),
        staged_hash: entry.stagedHash!,
        staged_ino: stagedStat.ino,
        staged_dev: stagedStat.dev,
        prior_hash: priorHash,
        prior_ino: priorIno,
        prior_dev: priorDev,
        had_prior: true,
        prior_file: priorFile,
      };
    });
    const journal: Omit<TransactionJournal, "record_digest"> = {
      kind: "promote-transaction-journal",
      transaction_id: transactionId,
      owner,
      phase: "intent",
      entries,
      recorded_at: new Date().toISOString(),
    };
    const recordDigest = journalRecordDigest(journal);
    const journalFd = fs.openSync(path.join(journalDir, "journal.json"), "w", 0o600);
    try {
      fs.writeSync(journalFd, JSON.stringify({ ...journal, record_digest: recordDigest }, null, 2), 0, "utf-8");
      fs.fsyncSync(journalFd);
    } finally {
      fs.closeSync(journalFd);
    }
    // Mandatory directory durability for the content-addressed prior files,
    // the journal, and its project parent.
    syncDirectory(priorDir);
    syncDirectory(journalDir);
    syncDirectory(projectDir);
    return { journalDir, journal: { ...journal, record_digest: recordDigest } };
  } catch (error) {
    // The incomplete bundle is ours; remove it before reporting failure.
    try { fs.rmSync(journalDir, { recursive: true, force: true }); } catch { /* ignore */ }
    throw error;
  }
}

interface PendingJournalDisposal {
  path: string;
}

/**
 * Cross the journal disposal rename boundary without deleting the retained
 * bytes yet. The caller can keep the pending bundle while it completes the
 * corresponding lock transition.
 */
function prepareJournalDisposal(
  journalDir: string,
): { pending?: PendingJournalDisposal; retainedPath?: string; error?: string } {
  const base = path.basename(journalDir);
  let trashPath: string;
  if (base.startsWith(PROMOTE_JOURNAL_TRASH_PREFIX)) {
    // A previous disposal already crossed the atomic rename boundary. Recovery
    // must finish removal in place, never attempt a second rename.
    trashPath = journalDir;
  } else {
    const transactionId = journalTransactionId(journalDir);
    trashPath = path.join(
      path.dirname(journalDir),
      `${PROMOTE_JOURNAL_TRASH_PREFIX}${transactionId}-${crypto.randomUUID()}`,
    );
    if (fs.existsSync(trashPath)) {
      return { retainedPath: journalDir, error: "journal trash destination already exists" };
    }
    try {
      fs.renameSync(journalDir, trashPath);
    } catch (error) {
      return { retainedPath: journalDir, error: `journal dispose rename failed: ${String(error)}` };
    }
    try {
      syncDirectory(path.dirname(journalDir));
    } catch (error) {
      return { retainedPath: trashPath, error: `journal dispose directory fsync failed: ${String(error)}` };
    }
  }
  return { pending: { path: trashPath } };
}

function finishJournalDisposal(
  pending: PendingJournalDisposal,
): { disposed: boolean; retainedPath?: string; error?: string } {
  try {
    fs.rmSync(pending.path, { recursive: true, force: true });
  } catch (error) {
    return { disposed: false, retainedPath: pending.path, error: `journal trash removal failed: ${String(error)}` };
  }
  return { disposed: true };
}

function readTransactionJournal(journalDir: string): TransactionJournal | null {
  try {
    const journalStat = fs.lstatSync(path.join(journalDir, "journal.json"));
    if (!journalStat.isFile() || journalStat.nlink !== 1) return null;
    const parsed = JSON.parse(fs.readFileSync(path.join(journalDir, "journal.json"), "utf-8")) as Record<string, unknown>;
    const { record_digest, ...payload } = parsed;
    const payloadKeys = Object.keys(payload).sort();
    if (typeof record_digest !== "string" || !DIGEST_GRAMMAR.test(record_digest)) return null;
    if (payloadKeys.join("\0") !== ["entries", "kind", "owner", "phase", "recorded_at", "transaction_id"].join("\0")) return null;
    if (payload.kind !== "promote-transaction-journal" || payload.phase !== "intent") return null;
    if (typeof payload.transaction_id !== "string" || !/^[A-Za-z0-9._-]+$/.test(payload.transaction_id)) return null;
    if (typeof payload.recorded_at !== "string") return null;
    const recordedAt = new Date(payload.recorded_at);
    if (!Number.isFinite(recordedAt.getTime()) || recordedAt.toISOString() !== payload.recorded_at) return null;
    if (!payload.owner || typeof payload.owner !== "object" || Array.isArray(payload.owner)) return null;
    const owner = payload.owner as Record<string, unknown>;
    if (Object.keys(owner).sort().join("\0") !== ["host", "pid", "start_identity"].join("\0") ||
      typeof owner.host !== "string" || owner.host.length === 0 ||
      typeof owner.pid !== "number" || !Number.isInteger(owner.pid) || owner.pid <= 0 ||
      typeof owner.start_identity !== "string" || owner.start_identity.length === 0) return null;
    if (!Array.isArray(payload.entries)) return null;
    for (const rawEntry of payload.entries) {
      if (!rawEntry || typeof rawEntry !== "object" || Array.isArray(rawEntry)) return null;
      const entry = rawEntry as Record<string, unknown>;
      if (Object.keys(entry).sort().join("\0") !== [
        "final", "had_prior", "prior_dev", "prior_file", "prior_hash", "prior_ino",
        "staged_dev", "staged_hash", "staged_ino",
      ].join("\0")) return null;
      if (typeof entry.final !== "string" || entry.final.length === 0 || path.isAbsolute(entry.final) ||
        entry.final.split(/[\\/]/).includes("..") ||
        typeof entry.staged_hash !== "string" || !FILE_HASH_GRAMMAR.test(entry.staged_hash) ||
        typeof entry.staged_ino !== "number" || !Number.isInteger(entry.staged_ino) || entry.staged_ino <= 0 ||
        typeof entry.staged_dev !== "number" || !Number.isInteger(entry.staged_dev) || entry.staged_dev < 0 ||
        typeof entry.had_prior !== "boolean") return null;
      if (entry.had_prior) {
        if (typeof entry.prior_hash !== "string" || !FILE_HASH_GRAMMAR.test(entry.prior_hash) ||
          typeof entry.prior_ino !== "number" || !Number.isInteger(entry.prior_ino) || entry.prior_ino <= 0 ||
          typeof entry.prior_dev !== "number" || !Number.isInteger(entry.prior_dev) || entry.prior_dev < 0 ||
          typeof entry.prior_file !== "string" ||
          entry.prior_file !== path.join("prior", `${entry.prior_hash}.bin`)) return null;
      } else if (entry.prior_hash !== null || entry.prior_ino !== null || entry.prior_dev !== null || entry.prior_file !== null) {
        return null;
      }
    }
    const journal = payload as unknown as Omit<TransactionJournal, "record_digest">;
    if (journalRecordDigest(journal) !== record_digest) return null; // tampered
    return { ...journal, record_digest };
  } catch {
    return null;
  }
}

function completionRecordDigest(record: Omit<RecoveryCompletion, "record_digest">): string {
  return jsonDigest({
    transaction_id: record.transaction_id,
    owner: record.owner,
    journal_digest: record.journal_digest,
    anchor_digest: record.anchor_digest,
    outcome: record.outcome,
    entries: record.entries,
  });
}

function completionAnchorDigest(
  transactionId: string,
  owner: { host: string; pid: number; start_identity: string },
  journalDigest: string,
  outcome: "commit" | "rollback",
  entries: Array<{ final: string; state: "present" | "absent"; hash: string | null; ino?: number | null; dev?: number | null }>,
): string {
  return jsonDigest({
    kind: "promote-recovery-anchor",
    transaction_id: transactionId,
    owner,
    journal_digest: journalDigest,
    outcome,
    // Rollback copies have a new inode, so the durable rollback anchor binds
    // their prior hash/state while the marker still records the post-copy
    // inode/device for final verification.
    entries: entries.map((entry) => entry.state === "present" && outcome === "rollback"
      ? { final: entry.final, state: entry.state, hash: entry.hash }
      : { final: entry.final, state: entry.state, hash: entry.hash, ino: entry.ino ?? null, dev: entry.dev ?? null }),
  });
}

function completionAnchorFromJournal(
  journal: TransactionJournal,
  outcome: "commit" | "rollback",
): string {
  return completionAnchorDigest(
    journal.transaction_id,
    journal.owner,
    journal.record_digest,
    outcome,
    journal.entries.map((entry) => outcome === "commit"
      ? { final: entry.final, state: "present", hash: entry.staged_hash, ino: entry.staged_ino, dev: entry.staged_dev }
      : entry.had_prior
        ? { final: entry.final, state: "present", hash: entry.prior_hash }
        : { final: entry.final, state: "absent", hash: null }),
  );
}

function completionAnchorFromMarker(completion: RecoveryCompletion): string {
  return completionAnchorDigest(
    completion.transaction_id,
    completion.owner,
    completion.journal_digest,
    completion.outcome,
    completion.entries,
  );
}

/**
 * Read optional postcondition evidence stored in a recovery guard. The marker
 * is intentionally strict, but it is never recovery authority by itself: the
 * public route requires the independently durable transaction journal.
 */
function readRecoveryCompletion(guardDir: string): RecoveryCompletion | null {
  try {
    const guardStat = fs.lstatSync(guardDir);
    const markerPath = path.join(guardDir, PROMOTE_RECOVERY_COMPLETION_FILE);
    const markerStat = fs.lstatSync(markerPath);
    if (!guardStat.isDirectory() || (guardStat.mode & 0o777) !== 0o700 ||
      !markerStat.isFile() || markerStat.nlink !== 1 || (markerStat.mode & 0o777) !== 0o600) return null;
    const parsed = JSON.parse(fs.readFileSync(markerPath, "utf-8")) as Record<string, unknown>;
    const { record_digest, ...payload } = parsed;
    const payloadKeys = Object.keys(payload).sort();
    if (payloadKeys.join("\0") !== ["anchor_digest", "entries", "journal_digest", "kind", "outcome", "owner", "transaction_id"].join("\0") ||
      typeof record_digest !== "string" || !DIGEST_GRAMMAR.test(record_digest) ||
      payload.kind !== "promote-recovery-completion" ||
      typeof payload.transaction_id !== "string" || !/^[A-Za-z0-9._-]+$/.test(payload.transaction_id) ||
      typeof payload.journal_digest !== "string" || !DIGEST_GRAMMAR.test(payload.journal_digest) ||
      typeof payload.anchor_digest !== "string" || !DIGEST_GRAMMAR.test(payload.anchor_digest) ||
      (payload.outcome !== "commit" && payload.outcome !== "rollback")) return null;
    if (!payload.owner || typeof payload.owner !== "object" || Array.isArray(payload.owner)) return null;
    const owner = payload.owner as Record<string, unknown>;
    if (Object.keys(owner).sort().join("\0") !== ["host", "pid", "start_identity"].join("\0") ||
      typeof owner.host !== "string" || owner.host.length === 0 ||
      typeof owner.pid !== "number" || !Number.isInteger(owner.pid) || owner.pid <= 0 ||
      typeof owner.start_identity !== "string" || owner.start_identity.length === 0 ||
      !Array.isArray(payload.entries)) return null;
    const entries: RecoveryCompletionEntry[] = [];
    for (const rawEntry of payload.entries) {
      if (!rawEntry || typeof rawEntry !== "object" || Array.isArray(rawEntry)) return null;
      const entry = rawEntry as Record<string, unknown>;
      if (Object.keys(entry).sort().join("\0") !== ["dev", "final", "hash", "ino", "state"].join("\0") ||
        typeof entry.final !== "string" || entry.final.length === 0 || path.isAbsolute(entry.final) ||
        entry.final.split(/[\\/]/).includes("..") ||
        (entry.state !== "present" && entry.state !== "absent")) return null;
      if (entry.state === "present") {
        if (typeof entry.hash !== "string" || !FILE_HASH_GRAMMAR.test(entry.hash) ||
          typeof entry.ino !== "number" || !Number.isInteger(entry.ino) || entry.ino <= 0 ||
          typeof entry.dev !== "number" || !Number.isInteger(entry.dev) || entry.dev < 0) return null;
      } else if (entry.hash !== null || entry.ino !== null || entry.dev !== null) {
        return null;
      }
      entries.push(entry as unknown as RecoveryCompletionEntry);
    }
    const completion = { ...payload, owner, entries, record_digest } as RecoveryCompletion;
    if (completionRecordDigest(completion) !== record_digest ||
      completionAnchorFromMarker(completion) !== completion.anchor_digest) return null;
    return completion;
  } catch {
    return null;
  }
}

function expectedRecoveryCompletion(
  projectDir: string,
  journal: TransactionJournal,
  outcome: "commit" | "rollback",
): RecoveryCompletion {
  const entries: RecoveryCompletionEntry[] = journal.entries.map((entry) => {
    const absFinal = path.resolve(projectDir, entry.final);
    if (outcome === "commit") {
      const stat = regularSingleLink(absFinal);
      if (!stat || stat.ino !== entry.staged_ino || stat.dev !== entry.staged_dev ||
        computeFileHash(absFinal) !== entry.staged_hash) {
        throw new Error(`canonical commit postcondition is not durable for ${entry.final}`);
      }
      return { final: entry.final, state: "present", hash: entry.staged_hash, ino: stat.ino, dev: stat.dev };
    }
    if (!entry.had_prior) {
      if (lstatIfPresent(absFinal)) throw new Error(`canonical rollback postcondition is not durable for ${entry.final}`);
      return { final: entry.final, state: "absent", hash: null, ino: null, dev: null };
    }
    const stat = regularSingleLink(absFinal);
    if (!stat || computeFileHash(absFinal) !== entry.prior_hash) {
      throw new Error(`canonical rollback postcondition is not durable for ${entry.final}`);
    }
    return { final: entry.final, state: "present", hash: entry.prior_hash, ino: stat.ino, dev: stat.dev };
  });
  const payload: Omit<RecoveryCompletion, "record_digest"> = {
    kind: "promote-recovery-completion",
    transaction_id: journal.transaction_id,
    owner: journal.owner,
    journal_digest: journal.record_digest,
    anchor_digest: completionAnchorFromJournal(journal, outcome),
    outcome,
    entries,
  };
  return { ...payload, record_digest: completionRecordDigest(payload) };
}

/**
 * Persist postcondition evidence before canonical lock removal while the
 * independently durable journal remains available. A marker cannot authorize
 * recovery after the journal is gone.
 */
function writeRecoveryCompletionMarker(
  projectDir: string,
  guardDir: string,
  journal: TransactionJournal,
  outcome: "commit" | "rollback",
): void {
  const completion = expectedRecoveryCompletion(projectDir, journal, outcome);
  const markerPath = path.join(guardDir, PROMOTE_RECOVERY_COMPLETION_FILE);
  const existing = lstatIfPresent(markerPath);
  if (existing) {
    const recorded = readRecoveryCompletion(guardDir);
    if (recorded && JSON.stringify(recorded) === JSON.stringify(completion)) return;
    if (!recorded || recorded.transaction_id !== completion.transaction_id ||
      recorded.journal_digest !== completion.journal_digest ||
      recorded.owner.host !== completion.owner.host || recorded.owner.pid !== completion.owner.pid ||
      recorded.owner.start_identity !== completion.owner.start_identity) {
      throw new Error("recovery completion marker already exists for a different transaction");
    }
  }
  const writePath = existing
    ? path.join(guardDir, `.${PROMOTE_RECOVERY_COMPLETION_FILE}.${crypto.randomUUID()}.tmp`)
    : markerPath;
  const fd = fs.openSync(writePath, "wx", 0o600);
  try {
    fs.chmodSync(writePath, 0o600);
    fs.writeSync(fd, JSON.stringify(completion, null, 2), 0, "utf-8");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  if (writePath !== markerPath) fs.renameSync(writePath, markerPath);
  syncFile(markerPath);
  syncDirectory(guardDir);
  syncDirectory(projectDir);
}

/**
 * Locate exactly one journal bundle for a claimed transaction. A standard
 * bundle and a retained disposal-trash bundle together are ambiguous and
 * fail closed; a single retained trash bundle is the recoverable journal.
 */
function findTransactionJournalDir(projectDir: string, transactionId: string): string | null {
  if (!/^[A-Za-z0-9._-]+$/.test(transactionId)) return null;
  const standardPath = path.join(projectDir, `${PROMOTE_JOURNAL_PREFIX}${transactionId}`);
  const standardStat = (() => {
    try { return fs.lstatSync(standardPath); } catch { return null; }
  })();
  const trashPaths: string[] = [];
  try {
    for (const entry of fs.readdirSync(projectDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.startsWith(`${PROMOTE_JOURNAL_TRASH_PREFIX}${transactionId}-`)) continue;
      trashPaths.push(path.join(projectDir, entry.name));
    }
  } catch {
    return null;
  }
  const hasStandard = !!standardStat && standardStat.isDirectory();
  if (hasStandard && trashPaths.length === 0) return standardPath;
  if (!hasStandard && trashPaths.length === 1) return trashPaths[0];
  return null;
}

/**
 * Any journal bundle (including retained disposal trash or a malformed
 * partial entry) blocks a new normal promotion. Recovery must first inspect
 * the canonical lock and resolve the journal while retaining its authority.
 */
function findIncompleteJournalPaths(projectDir: string): string[] | null {
  try {
    return fs.readdirSync(projectDir, { withFileTypes: true })
      .filter((entry) => entry.name.startsWith(PROMOTE_JOURNAL_PREFIX))
      .map((entry) => path.join(projectDir, entry.name));
  } catch {
    return null;
  }
}

/**
 * Adopt the only fully authenticated journal when a process died after
 * removing the canonical lock and before disposing the journal. The journal
 * itself is the pre-established recovery authority for this otherwise
 * lock-less state. Adoption accepts one strictly validated journal, and zero
 * or one matching guard; the exclusive canonical-lock create then serializes
 * adopters. A malformed, ambiguous, foreign, or live-owner state remains
 * fail-closed.
 */
function adoptOrphanJournalLock(
  projectDir: string,
): { observed?: ObservedLock; error?: string } {
  const lockPath = path.join(projectDir, PROMOTE_LOCK_FILE);
  if (lstatIfPresent(lockPath)) {
    return { error: "canonical lock path exists but its owner record is not valid; recovery refused" };
  }
  const journalPaths = findIncompleteJournalPaths(projectDir);
  if (journalPaths === null) return { error: "incomplete journal state could not be inspected" };
  if (journalPaths.length !== 1) {
    return {
      error: journalPaths.length === 0
        ? "recovery requires a canonical lock or one authenticated orphan journal"
        : "orphan journal adoption is ambiguous; recovery refused",
    };
  }
  const journalPath = journalPaths[0];
  const journal = readTransactionJournal(journalPath);
  if (!journal) return { error: "orphan journal is missing a valid digest or was tampered with; recovery refused" };
  if (findTransactionJournalDir(projectDir, journal.transaction_id) !== journalPath) {
    return { error: "orphan journal is missing or ambiguous for its transaction; recovery refused" };
  }
  try {
    const journalDirStat = fs.lstatSync(journalPath);
    const priorDirStat = fs.lstatSync(path.join(journalPath, "prior"));
    if (!journalDirStat.isDirectory() || (journalDirStat.mode & 0o777) !== 0o700 ||
      !priorDirStat.isDirectory() || (priorDirStat.mode & 0o777) !== 0o700) {
      return { error: "orphan journal is not a private mode-0700 bundle; recovery refused" };
    }
  } catch {
    return { error: "orphan journal bundle could not be inspected; recovery refused" };
  }

  const guards = listRecoveryGuards(projectDir);
  if (!guards || guards.length > 1 ||
    (guards.length === 1 && !recoveryGuardMatches(guards[0], journal.transaction_id, journal.owner))) {
    return { error: "orphan journal has an ambiguous or non-matching recovery guard; recovery refused" };
  }

  const adoptedIdentity: PromoteLockIdentity = {
    ...journal.owner,
    transaction_id: journal.transaction_id,
    acquired_at: journal.recorded_at,
  };
  const liveness = ownerLiveness(adoptedIdentity);
  if (liveness === "unknown") {
    return { error: "orphan journal owner identity could not be proven; recovery refused" };
  }
  if (liveness === "alive" &&
    !(adoptedIdentity.host === os.hostname() &&
      adoptedIdentity.pid === process.pid &&
      adoptedIdentity.start_identity === selfStartIdentity())) {
    return { error: "live orphan journal owner holds recovery authority; recovery refused" };
  }

  try {
    // The journal is the pre-established recovery authority. Recreate the
    // canonical lock with an exclusive create first when a crash occurred
    // after guard removal; the public recovery path establishes its guard
    // immediately afterwards. This ordering serializes concurrent adopters
    // on the canonical pathname without allowing either to replace evidence.
    const adopted = writeLockRecord(lockPath, adoptedIdentity);
    syncDirectory(projectDir);
    const observed = observeLockFile(lockPath, { allowHardLink: true });
    if (!observed || observed.raw_record !== adopted.raw_record ||
      observed.record_digest !== adopted.record_digest) {
      if (observed) fs.closeSync(observed.fd);
      return { error: "orphan journal lock adoption could not be durably verified; recovery refused" };
    }
    return { observed };
  } catch (error) {
    return { error: `orphan journal lock adoption failed; recovery refused: ${String(error)}` };
  }
}

export function draftAndPromote(
  projectDir: string,
  drafts: DraftFile[],
  options?: PromoteOptions,
): PromoteResult {
  // Transaction-unique id (pid + time + nonce): every staging, journal, and
  // claim path of this promotion is owned by this id alone.
  const transactionId = `${process.pid}-${Date.now()}-${crypto.randomUUID()}`;

  const selfIdentity = selfStartIdentity();
  if (selfIdentity === null) {
    return {
      success: false,
      promoted: [],
      errors: ["own process-start identity is unavailable; refusing to promote"],
      failure_kind: "promote",
    };
  }
  const ownerIdentity = { host: os.hostname(), pid: process.pid, start_identity: selfIdentity };

  // Guard keys are mandatory: derived deterministically from every tracked
  // canonical artifact present in the project when the caller does not pass
  // an explicit set. Every production caller uses the same transactional
  // promotion (locking, durable journal, postconditions, recovery).
  const preflightHashes = options?.preflightHashes ?? snapshotArtifacts(projectDir).hashes;
  const guardKeys = options?.guardKeys && options.guardKeys.length > 0
    ? options.guardKeys
    : Object.entries(ARTIFACT_IDENTITY_HASH_KEYS)
        .filter(([relPath]) => fs.existsSync(path.join(projectDir, relPath)))
        .map(([, key]) => key);

  // Precondition hash verification happens before the lock; it is read-only
  // and creates no staging state.
  const preMismatches = verifyGuardedInputs(projectDir, preflightHashes, guardKeys, new Set());
  if (preMismatches.length > 0) {
    return {
      success: false,
      promoted: [],
      errors: preMismatches,
      failure_kind: "concurrent_edit",
    };
  }

  const lock = acquirePromoteLock(projectDir, transactionId);
  if (!lock.ok || !lock.acquired) {
    return {
      success: false,
      promoted: [],
      errors: [`another promotion holds the project lock (${lock.lockedBy ?? "unknown"})`],
      failure_kind: "locked",
    };
  }
  // The exact record written at acquisition: release later compares the
  // claimed moved record against THIS record, never a later observation.
  const acquiredRecord: AcquiredLockRecord = lock.acquired;
  const draftPaths: Array<{
    draft: string;
    final: string;
    promoted?: boolean;
    stagedHash?: string;
    stagedIno?: number;
    stagedDev?: number;
    hadPrior?: boolean;
  }> = [];
  const errors: string[] = [];
  const promoted: string[] = [];
  let journalDir: string | null = null;
  let retainedClaimPath: string | undefined;

  const removeStaging = (): void => {
    for (const entry of [...draftPaths].reverse()) {
      if (fs.existsSync(entry.draft)) {
        try { fs.unlinkSync(entry.draft); } catch { /* non-destructive */ }
      }
    }
  };
  const recoveryRequired = (failureErrors: string[]): PromoteResult => {
    return {
      success: false,
      promoted: [...promoted],
      errors: failureErrors,
      failure_kind: "recovery_required",
      recovery: {
        transaction_id: transactionId,
        lock_path: path.join(projectDir, PROMOTE_LOCK_FILE),
        journal_path: journalDir ?? path.join(projectDir, `${PROMOTE_JOURNAL_PREFIX}${transactionId}`),
        ...(retainedClaimPath ? { claim_path: retainedClaimPath } : {}),
      },
    };
  };

  /**
   * Finish a rollback while retaining canonical lock ownership until both the
   * private claim cleanup and journal disposal succeed. Rollback paths can
   * also return recovery_required; they must provide the same retryable
   * ownership guarantees as the commit path.
   */
  const finishRollback = (
    activeJournalDir: string,
    failureErrors: string[],
    failureKind: "concurrent_edit" | "promote",
  ): PromoteResult => {
    journalDir = activeJournalDir;
    const prepared = prepareJournalDisposal(activeJournalDir);
    if (!prepared.pending) {
      journalDir = prepared.retainedPath ?? activeJournalDir;
      return recoveryRequired([
        ...failureErrors,
        `journal disposal failed after rollback: ${prepared.error ?? "unknown"}; retained at ${prepared.retainedPath}`,
      ]);
    }
    journalDir = prepared.pending.path;
    const rollbackJournal = readTransactionJournal(prepared.pending.path);
    if (!rollbackJournal) {
      return recoveryRequired([...failureErrors, "rollback completion authority could not validate the retained journal"]);
    }
    let recoveryGuard: string;
    try {
      recoveryGuard = ensureRecoveryGuard(projectDir, transactionId, ownerIdentity);
    } catch (error) {
      return recoveryRequired([...failureErrors, `recovery exclusion could not be established after rollback: ${String(error)}`]);
    }
    const lockClaim = linkPromoteLock(projectDir, acquiredRecord);
    if (!lockClaim.claim) {
      retainedClaimPath = lockClaim.retainedClaim?.claimPath;
      return recoveryRequired([...failureErrors, `lock release failed after rollback: ${lockClaim.error ?? "unknown"}`]);
    }
    retainedClaimPath = lockClaim.claim.claimPath;
    try {
      fs.unlinkSync(lockClaim.claim.claimPath);
    } catch (error) {
      return recoveryRequired([...failureErrors, `lock release cleanup failed after rollback: ${String(error)}`]);
    }
    retainedClaimPath = undefined;
    removeEmptyClaimDir(lockClaim.claim.claimDir);
    try {
      writeRecoveryCompletionMarker(projectDir, recoveryGuard, rollbackJournal, "rollback");
    } catch (error) {
      return recoveryRequired([...failureErrors, `rollback completion authority could not be persisted: ${String(error)}`]);
    }
    if (!removeExactAcquiredLock(projectDir, acquiredRecord)) {
      return recoveryRequired([...failureErrors, "canonical lock release failed before journal disposal; recovery authority retained"]);
    }
    // Remove the guard while the retained journal still authenticates the
    // transaction. A crash after this point leaves a journal-only state that
    // public recovery can adopt; it can never leave a guard-only dead end.
    try {
      removeRecoveryGuard(recoveryGuard);
    } catch (error) {
      return recoveryRequired([
        ...failureErrors,
        `recovery guard cleanup failed before journal disposal: ${String(error)}`,
      ]);
    }
    const disposal = finishJournalDisposal(prepared.pending);
    if (!disposal.disposed) {
      journalDir = disposal.retainedPath ?? prepared.pending.path;
      if (!restoreAcquiredLockRecord(projectDir, acquiredRecord)) {
        return recoveryRequired([
          ...failureErrors,
          `journal disposal failed after canonical lock release and the lock could not be restored: ${disposal.error ?? "unknown"}`,
        ]);
      }
      return recoveryRequired([
        ...failureErrors,
        `journal disposal failed after rollback: ${disposal.error ?? "unknown"}; retained at ${disposal.retainedPath}`,
      ]);
    }
    removeStaging();
    return {
      success: false,
      promoted: [],
      errors: failureErrors,
      failure_kind: failureKind,
    };
  };

  // Phase 1 — rollback-capable work. Anything thrown here is rolled back by
  // COPYING prior bytes from the immutable journal.
  try {
    // Re-verify under the lock so inputs cannot slip between the check and
    // the staging window.
    const underLockMismatches = verifyGuardedInputs(projectDir, preflightHashes, guardKeys, new Set());
    if (underLockMismatches.length > 0) {
      throw new PromoteConcurrentEditError(underLockMismatches);
    }

    // Staging: transaction-unique draft paths owned by this transaction.
    for (const d of drafts) {
      const finalPath = path.join(projectDir, d.relativePath);
      const draftPath = finalPath.replace(/\.(yaml|json)$/, `.draft-${transactionId}.$1`);
      fs.mkdirSync(path.dirname(draftPath), { recursive: true });
      const serialized = d.format === "json"
        ? JSON.stringify(d.content, null, 2)
        : stringifyYaml(d.content);
      fs.writeFileSync(draftPath, serialized, "utf-8");
      let stagedIno = 0;
      let stagedDev = 0;
      try {
        const draftFd = fs.openSync(draftPath, "r");
        try {
          fs.fsyncSync(draftFd);
          const draftStat = fs.fstatSync(draftFd);
          stagedIno = draftStat.ino;
          stagedDev = draftStat.dev;
        } finally {
          fs.closeSync(draftFd);
        }
      } catch (error) {
        try { fs.unlinkSync(draftPath); } catch { /* preserve the exact failure */ }
        throw error;
      }
      const priorStat = lstatIfPresent(finalPath);
      if (priorStat && (!priorStat.isFile() || priorStat.nlink !== 1)) {
        throw new Error(`canonical output is not a regular single-linked file: ${d.relativePath}`);
      }
      draftPaths.push({
        draft: draftPath,
        final: finalPath,
        promoted: false,
        stagedHash: computeFileHash(draftPath),
        stagedIno,
        stagedDev,
        hadPrior: priorStat !== null,
      });

      const result = validateAgainstSchema(d.content, d.schemaFile);
      if (!result.valid) {
        errors.push(`${d.relativePath}: ${result.errors.join("; ")}`);
        continue;
      }

      // Validate the bytes that will actually be promoted. A schema-valid
      // in-memory object is not enough when a serializer drops inherited or
      // otherwise non-representable values. Route-specific canonical gates
      // run only after this reparse, on the same object that reached disk.
      let serializedContent: unknown;
      try {
        const stagedBytes = fs.readFileSync(draftPath, "utf-8");
        serializedContent = d.format === "json" ? JSON.parse(stagedBytes) : parseYaml(stagedBytes);
      } catch (error) {
        errors.push(`${d.relativePath}: staged bytes could not be reparsed: ${String(error)}`);
        continue;
      }
      const serializedValidation = validateAgainstSchema(serializedContent, d.schemaFile);
      if (!serializedValidation.valid) {
        errors.push(`${d.relativePath}: serialized bytes failed schema validation: ${serializedValidation.errors.join("; ")}`);
        continue;
      }
      try {
        d.serializedContentGate?.(serializedContent);
      } catch (error) {
        errors.push(`${d.relativePath}: serialized bytes failed canonical gate: ${String(error)}`);
      }
    }
    if (errors.length > 0) {
      removeStaging();
      const release = releasePromoteLock(projectDir, acquiredRecord);
      if (!release.released) {
        retainedClaimPath = release.claim_path;
        return recoveryRequired([`lock release failed after validation failure: ${release.error ?? "unknown"}`]);
      }
      return { success: false, promoted: [], errors, failure_kind: "validation" };
    }

    // Durable transaction journal: created, fsynced (files AND directories),
    // holding content-addressed copies of every prior canonical byte —
    // BEFORE any prior canonical byte is moved or removed. Any failure
    // aborts before canonical mutation.
    try {
      const bundle = createJournalBundle(projectDir, transactionId, ownerIdentity, draftPaths);
      journalDir = bundle.journalDir;
    } catch (error) {
      removeStaging();
      const release = releasePromoteLock(projectDir, acquiredRecord);
      if (!release.released) {
        retainedClaimPath = release.claim_path;
        return recoveryRequired([`lock release failed after journal failure: ${release.error ?? "unknown"}`]);
      }
      return {
        success: false,
        promoted: [],
        errors: [`transaction journal could not be created; aborted before canonical mutation: ${String(error)}`],
        failure_kind: "promote",
      };
    }

    // Staged promote: canonical outputs are replaced atomically from the
    // staged drafts; the journal holds immutable copies of every prior byte.
    for (const entry of draftPaths) {
      fs.renameSync(entry.draft, entry.final);
      entry.promoted = true;
      // The rename is not durable until both the output and its parent
      // directory have been fsynced. A failure remains rollback-capable while
      // the journal is still retained.
      syncCanonicalOutput(entry.final);
    }
  } catch (err) {
    // Rollback-capable phase failure: restore prior bytes by COPYING from
    // the immutable journal — never consuming the only copy.
    errors.push(err instanceof Error ? err.message : String(err));
    const activeJournalDir = journalDir;
    if (!activeJournalDir) {
      removeStaging();
      const release = releasePromoteLock(projectDir, acquiredRecord);
      if (!release.released) {
        retainedClaimPath = release.claim_path;
        return recoveryRequired([`lock release failed before journal creation: ${release.error ?? "unknown"}`]);
      }
      return {
        success: false,
        promoted: [],
        errors,
        failure_kind: err instanceof PromoteConcurrentEditError ? "concurrent_edit" : "promote",
      };
    }
    const journal = readTransactionJournal(activeJournalDir);
    if (!journal) {
      promoted.length = 0;
      return recoveryRequired(["transaction journal is missing or invalid; canonical outputs and ownership are retained for recovery"]);
    }
    for (const entry of [...journal.entries].reverse()) {
      const absFinal = path.resolve(projectDir, entry.final);
      if (entry.had_prior && entry.prior_file) {
        const absPrior = path.resolve(activeJournalDir, entry.prior_file);
        if (!fs.existsSync(absPrior)) {
          promoted.length = 0;
          return recoveryRequired([`journal prior copy is missing for ${entry.final}; journal retained`]);
        }
        try {
          fs.copyFileSync(absPrior, absFinal);
          if (computeFileHash(absFinal) !== entry.prior_hash) {
            promoted.length = 0;
            return recoveryRequired([`rollback copy verification failed for ${entry.final}; journal retained`]);
          }
          syncCanonicalOutput(absFinal);
        } catch (error) {
          promoted.length = 0;
          return recoveryRequired([`rollback copy failed for ${entry.final}; journal retained: ${String(error)}`]);
        }
      } else if (!entry.had_prior && fs.existsSync(absFinal)) {
        try {
          fs.unlinkSync(absFinal);
          syncCanonicalOutput(absFinal);
        } catch (error) {
          promoted.length = 0;
          return recoveryRequired([`rollback removal failed for ${entry.final}; journal retained: ${String(error)}`]);
        }
      }
    }
    promoted.length = 0;
    return finishRollback(
      activeJournalDir,
      errors,
      err instanceof PromoteConcurrentEditError ? "concurrent_edit" : "promote",
    );
  }

  // Phase 2 — commit. The final canonical verification has passed with the
  // journal intact.
  let verificationFailed = false;
  const verificationErrors: string[] = [];
  for (const entry of draftPaths) {
    const finalStat = regularSingleLink(entry.final);
    if (!finalStat || computeFileHash(entry.final) !== entry.stagedHash) {
      verificationFailed = true;
      verificationErrors.push(
        `final canonical postcondition failed: ${path.relative(projectDir, entry.final)} is missing or altered`,
      );
    } else {
      try {
        syncCanonicalOutput(entry.final);
        promoted.push(entry.final);
      } catch (error) {
        verificationFailed = true;
        verificationErrors.push(
          `final canonical durability postcondition failed: ${path.relative(projectDir, entry.final)}: ${String(error)}`,
        );
      }
    }
  }
  const promotedRelPaths = new Set(
    draftPaths
      .filter((entry) => regularSingleLink(entry.final) !== null && computeFileHash(entry.final) === entry.stagedHash)
      .map((entry) => path.relative(projectDir, entry.final)),
  );
  const postMismatches = verifyGuardedInputs(projectDir, preflightHashes, guardKeys, promotedRelPaths);
  if (postMismatches.length > 0) {
    verificationFailed = true;
    verificationErrors.push(...postMismatches);
  }
  if (verificationFailed) {
    // Rollback-capable failure: copy prior bytes back from the immutable
    // journal for every entry, verify, then dispose.
    const activeJournalDir = journalDir;
    if (!activeJournalDir) {
      promoted.length = 0;
      return recoveryRequired(["transaction journal is missing; canonical outputs and ownership are retained for recovery"]);
    }
    const journal = readTransactionJournal(activeJournalDir);
    if (!journal) {
      promoted.length = 0;
      return recoveryRequired(["transaction journal is missing or invalid; canonical outputs and ownership are retained for recovery"]);
    }
    for (const entry of [...journal.entries].reverse()) {
      const absFinal = path.resolve(projectDir, entry.final);
      if (entry.had_prior && entry.prior_file) {
        const absPrior = path.resolve(activeJournalDir, entry.prior_file);
        if (!fs.existsSync(absPrior)) {
          promoted.length = 0;
          return recoveryRequired([`journal prior copy is missing for ${entry.final}; journal retained`]);
        }
        try {
          fs.copyFileSync(absPrior, absFinal);
          if (computeFileHash(absFinal) !== entry.prior_hash) {
            promoted.length = 0;
            return recoveryRequired([`rollback copy verification failed for ${entry.final}; journal retained`]);
          }
          syncCanonicalOutput(absFinal);
        } catch (error) {
          promoted.length = 0;
          return recoveryRequired([`rollback copy failed for ${entry.final}; journal retained: ${String(error)}`]);
        }
      } else if (!entry.had_prior && fs.existsSync(absFinal)) {
        try {
          fs.unlinkSync(absFinal);
          syncCanonicalOutput(absFinal);
        } catch (error) {
          promoted.length = 0;
          return recoveryRequired([`rollback removal failed for ${entry.final}; journal retained: ${String(error)}`]);
        }
      }
    }
    promoted.length = 0;
    return finishRollback(activeJournalDir, verificationErrors, "concurrent_edit");
  }

  // Phase 3 — commit. Final canonical postcondition immediately before the
  // atomic journal disposal; then release. Prior bytes can never be lost:
  // the journal is disposed only after every canonical output is verified.
  for (const entry of draftPaths) {
    const finalStat = regularSingleLink(entry.final);
    if (!finalStat || computeFileHash(entry.final) !== entry.stagedHash) {
      return recoveryRequired([
        `final canonical postcondition failed before journal disposal: ${path.relative(projectDir, entry.final)} is missing or altered`,
      ]);
    }
    try {
      syncCanonicalOutput(entry.final);
    } catch (error) {
      return recoveryRequired([
        `final canonical durability failed before journal disposal: ${path.relative(projectDir, entry.final)}: ${String(error)}`,
      ]);
    }
  }
  if (!journalDir) {
    return recoveryRequired(["transaction journal is missing before commit; canonical outputs and ownership are retained for recovery"]);
  }
  const activeJournalDir = journalDir;
  const preparedDisposal = prepareJournalDisposal(activeJournalDir);
  if (!preparedDisposal.pending) {
    journalDir = preparedDisposal.retainedPath ?? activeJournalDir;
    return recoveryRequired([
      `journal disposal failed: ${preparedDisposal.error ?? "unknown"}; retained at ${preparedDisposal.retainedPath}`,
    ]);
  }
  const pendingDisposal = preparedDisposal.pending;
  journalDir = pendingDisposal.path;
  const commitJournal = readTransactionJournal(pendingDisposal.path);
  if (!commitJournal) {
    return recoveryRequired(["commit completion authority could not validate the retained journal"]);
  }
  let recoveryGuard: string;
  try {
    recoveryGuard = ensureRecoveryGuard(projectDir, transactionId, ownerIdentity);
  } catch (error) {
    return recoveryRequired([`recovery exclusion could not be established before release: ${String(error)}`]);
  }
  // Keep the canonical lock pathname linked to a private exact-owner claim
  // while the journal disposal and lock release cross their failure points.
  // This closes the recovery/challenger gap created by moving the only lock
  // name away before the transaction has finished.
  const lockClaim = linkPromoteLock(projectDir, acquiredRecord);
  if (!lockClaim.claim) {
    retainedClaimPath = lockClaim.retainedClaim?.claimPath;
    return recoveryRequired([`lock release failed: ${lockClaim.error ?? "unknown"}`]);
  }
  retainedClaimPath = lockClaim.claim.claimPath;
  try {
    // Release the private name before disposing the journal. If this cleanup
    // fails, both the canonical lock and exact private claim remain, and the
    // returned recovery object is sufficient to resume.
    fs.unlinkSync(lockClaim.claim.claimPath);
  } catch (error) {
    return recoveryRequired([`lock release cleanup failed before journal disposal: ${String(error)}`]);
  }
  retainedClaimPath = undefined;
  removeEmptyClaimDir(lockClaim.claim.claimDir);
  try {
    writeRecoveryCompletionMarker(projectDir, recoveryGuard, commitJournal, "commit");
  } catch (error) {
    return recoveryRequired([`commit completion authority could not be persisted: ${String(error)}`]);
  }
  if (!removeExactAcquiredLock(projectDir, acquiredRecord)) {
    return recoveryRequired(["canonical lock release failed before journal disposal; recovery authority retained"]);
  }
  // The journal remains as the independent recovery authority through guard
  // removal. If the process dies here, public recovery adopts the journal;
  // no guard-only completion state is accepted.
  try {
    removeRecoveryGuard(recoveryGuard);
  } catch (error) {
    return recoveryRequired([`recovery guard cleanup failed before journal disposal: ${String(error)}`]);
  }
  const disposal = finishJournalDisposal(pendingDisposal);
  if (!disposal.disposed) {
    journalDir = disposal.retainedPath ?? pendingDisposal.path;
    if (!restoreAcquiredLockRecord(projectDir, acquiredRecord)) {
      return recoveryRequired([
        `journal disposal failed after canonical lock release and the lock could not be restored: ${disposal.error ?? "unknown"}`,
      ]);
    }
    return recoveryRequired([
      `journal disposal failed: ${disposal.error ?? "unknown"}; retained at ${disposal.retainedPath}`,
    ]);
  }
  return { success: true, promoted, errors: [] };
}

export interface PromoteRecoveryResult {
  recovered: boolean;
  restored: Array<{ final: string; from_journal: string }>;
  errors: string[];
  /** Existing ownership/journal paths are returned on every recoverable failure. */
  recovery?: {
    transaction_id: string;
    lock_path: string;
    journal_path: string;
    claim_path?: string;
  };
}

function findPrivateClaimForTransaction(
  projectDir: string,
  transactionId: string,
): PromotedLockClaim | null {
  const candidates: PromotedLockClaim[] = [];
  for (const entry of fs.readdirSync(projectDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith(PROMOTE_CLAIM_DIR_PREFIX) ||
      !entry.name.includes(transactionId)) continue;
    const claimDir = path.join(projectDir, entry.name);
    const claimPath = path.join(claimDir, "claimed-lock.json");
    try {
      const stat = fs.lstatSync(claimPath);
      if (stat.isFile()) candidates.push({ claimDir, claimPath });
    } catch { /* an incomplete private directory is not an ownership claim */ }
  }
  if (candidates.length > 1) {
    throw new Error("multiple private claims exist for the recovery transaction");
  }
  return candidates[0] ?? null;
}

/**
 * Recovery authority comes from the exact canonical lock record — the journal
 * is evidence, never authorization. Recovery creates a private hard-link
 * claim while retaining the canonical lock pathname and a durable recovery
 * guard. That exclusion remains active through whole-transaction preflight,
 * prior-byte restoration, postconditions, journal disposal, and lock release,
 * so a concurrent promoter cannot enter during the gap. Every journal entry
 * and current canonical object is preflighted with lstat (symlinks, hardlinks,
 * non-regular files, inode/device substitution, path escape) before any
 * mutation, and prior bytes are restored by COPYING from the immutable
 * journal — never consuming the only copy.
 */
export function recoverPromoteTransaction(
  projectDir: string,
): PromoteRecoveryResult {
  const errors: string[] = [];
  const restored: Array<{ final: string; from_journal: string }> = [];
  const lockPath = path.join(projectDir, PROMOTE_LOCK_FILE);
  let observed = observeLockFile(lockPath, { allowHardLink: true });
  if (!observed) {
    const adopted = adoptOrphanJournalLock(projectDir);
    observed = adopted.observed ?? null;
    if (observed) {
      // Continue through the same public recovery validation and mutation
      // path. Adoption only reconstructs the missing canonical name; it does
      // not bypass owner, guard, journal, or output postconditions.
    } else {
      return {
        recovered: false,
        restored,
        errors: [adopted.error ?? "recovery requires claiming the promotion lock; no lock record is present at the canonical path"],
      };
    }
  }
  const claimedNonce = observed.identity.transaction_id;
  const liveness = ownerLiveness(observed.identity);
  const ownerIdentity = {
    host: observed.identity.host,
    pid: observed.identity.pid,
    start_identity: observed.identity.start_identity,
  };
  let claimDir: string | null = null;
  let claimPath: string | null = null;
  let journalDir: string | null = null;
  let recoveryGuard: string | null = null;
  let observedFdOpen = true;
  const closeObserved = (): void => {
    if (observedFdOpen) {
      fs.closeSync(observed.fd);
      observedFdOpen = false;
    }
  };
  const recoveryInfo = (): PromoteRecoveryResult["recovery"] => ({
    transaction_id: claimedNonce,
    lock_path: lockPath,
    journal_path: journalDir ?? path.join(projectDir, `${PROMOTE_JOURNAL_PREFIX}${claimedNonce}`),
    ...(claimPath && fs.existsSync(claimPath) ? { claim_path: claimPath } : {}),
  });
  // Capture the adopted trash bundle before later guard/claim failures so a
  // recovery_required response always returns the actual retryable journal.
  journalDir = findTransactionJournalDir(projectDir, claimedNonce);
  try {
    if (liveness === "alive") {
      const self = selfStartIdentity();
      const isSelf = observed.identity.host === os.hostname() &&
        observed.identity.pid === process.pid &&
        self !== null && observed.identity.start_identity === self;
      if (!isSelf) {
        // Live non-self owner: refuse; the observed descriptor is closed.
        closeObserved();
        return {
          recovered: false,
          restored,
          errors: ["live owner holds the promotion lock; recovery refused"],
        };
      }
    } else if (liveness === "dead") {
      // Dead and same-process owners share the same hard-link claim path
      // below. The canonical lock remains present throughout recovery.
    } else {
      closeObserved();
      return {
        recovered: false,
        restored,
        errors: ["owner liveness could not be proven; recovery refused"],
      };
    }

    // Durable guard + hard-link claim: the canonical lock pathname remains
    // present while recovery validates and mutates the transaction.
    const guardsBefore = listRecoveryGuards(projectDir);
    if (!guardsBefore) throw new Error("recovery guard state could not be inspected");
    const transactionGuardPrefix = `${PROMOTE_RECOVERY_GUARD_PREFIX}${claimedNonce}-`;
    if (guardsBefore.some((candidate) => !path.basename(candidate).startsWith(transactionGuardPrefix))) {
      throw new Error("another recovery guard owns the project");
    }
    recoveryGuard = ensureRecoveryGuard(projectDir, claimedNonce, ownerIdentity);
    const allGuards = listRecoveryGuards(projectDir);
    if (!allGuards || allGuards.some((candidate) => candidate !== recoveryGuard)) {
      throw new Error("another recovery guard owns the project");
    }
    closeObserved();
    const existingClaim = findPrivateClaimForTransaction(projectDir, claimedNonce);
    if (existingClaim) {
      claimDir = existingClaim.claimDir;
      claimPath = existingClaim.claimPath;
    } else {
      claimDir = createPrivateClaimDir(projectDir, `recovery-${claimedNonce}`);
      claimPath = path.join(claimDir, "claimed-lock.json");
      fs.linkSync(lockPath, claimPath);
    }
    const canonical = observeLockFile(lockPath, { allowHardLink: true });
    const claimed = observeLockFile(claimPath, { allowHardLink: true });
    const exact = canonical !== null && claimed !== null &&
      recordsMatch(observed, canonical) && recordsMatch(observed, claimed);
    if (canonical) fs.closeSync(canonical.fd);
    if (claimed) fs.closeSync(claimed.fd);
    if (!exact) throw new Error("recovery claim did not reproduce the exact canonical owner record");

    // Journal verification: presence, strict structure, digest, nonce
    // binding, full owner equality with the claimed record — before any
    // mutation.
    journalDir = findTransactionJournalDir(projectDir, claimedNonce);
    if (!journalDir) throw new Error("transaction journal is missing or ambiguous");
    const journalDirStat = fs.lstatSync(journalDir); // throws when missing
    if (!journalDirStat.isDirectory() || (journalDirStat.mode & 0o777) !== 0o700) {
      throw new Error("transaction journal is not a private mode-0700 directory");
    }
    const priorDirStat = fs.lstatSync(path.join(journalDir, "prior"));
    if (!priorDirStat.isDirectory() || (priorDirStat.mode & 0o777) !== 0o700) {
      throw new Error("transaction journal prior directory is not private mode-0700");
    }
    const journal = readTransactionJournal(journalDir);
    if (!journal) {
      throw new Error("transaction journal is missing a valid digest or was tampered with");
    }
    if (journal.transaction_id !== claimedNonce) {
      throw new Error("transaction journal nonce does not match the claimed lock record");
    }
    if (journal.owner.host !== observed.identity.host ||
      journal.owner.pid !== observed.identity.pid ||
      journal.owner.start_identity !== observed.identity.start_identity) {
      throw new Error("transaction journal owner does not match the claimed lock record owner");
    }
    // Whole-transaction lstat preflight: every canonical and journal object
    // must be a regular single-linked file inside the project — symlinks,
    // hardlinks, substitutions, and escapes fail closed BEFORE any mutation.
    // Hashing through a link is forbidden.
    const projectRoot = fs.realpathSync(projectDir);
    const projectLexicalRoot = path.resolve(projectDir);
    const journalRoot = fs.realpathSync(journalDir);
    const journalLexicalRoot = path.resolve(journalDir);
    const isWithin = (root: string, candidate: string): boolean =>
      candidate === root || candidate.startsWith(root + path.sep);
    const resolved: Array<{
      absFinal: string;
      entry: JournalEntry;
      absPrior: string | null;
      finalState: "staged" | "prior" | "absent";
    }> = [];
    for (const entry of journal.entries) {
      const absFinal = path.resolve(projectDir, entry.final);
      if (!isWithin(projectLexicalRoot, absFinal)) {
        throw new Error(`journal entry final escapes the project directory: ${entry.final}`);
      }
      const finalParent = fs.realpathSync(path.dirname(absFinal));
      if (!isWithin(projectRoot, finalParent)) {
        throw new Error(`canonical output parent escapes the project directory: ${entry.final}`);
      }
      // Classification by immutable recorded identity + bytes:
      // - "staged": crash happened after the promotion rename;
      // - "prior": crash happened during rollback (prior bytes already
      //   restored by copy — hash authoritative);
      // - "absent": the output was never promoted or was already removed;
      // - anything else is a foreign/substituted object: fail closed.
      let finalLstat: fs.Stats | null = null;
      try {
        finalLstat = fs.lstatSync(absFinal);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      let finalState: "staged" | "prior" | "absent";
      if (!finalLstat) {
        finalState = "absent";
      } else {
        if (!finalLstat.isFile() || finalLstat.nlink !== 1) {
          throw new Error(`canonical output is a symlink, hardlinked, or non-regular object: ${entry.final}`);
        }
        const finalHash = computeFileHash(absFinal);
        if (finalLstat.ino === entry.staged_ino && finalLstat.dev === entry.staged_dev &&
          finalHash === entry.staged_hash) {
          finalState = "staged";
        } else if (entry.had_prior && entry.prior_hash !== null && finalHash === entry.prior_hash) {
          finalState = "prior";
        } else {
          throw new Error(`foreign canonical bytes at ${entry.final}; refusing to recover`);
        }
      }
      let absPrior: string | null = null;
      if (entry.had_prior && entry.prior_file && entry.prior_hash) {
        absPrior = path.resolve(journalDir, entry.prior_file);
        if (!isWithin(journalLexicalRoot, absPrior)) {
          throw new Error(`journal prior file escapes the journal directory: ${entry.prior_file}`);
        }
        const priorParent = fs.realpathSync(path.dirname(absPrior));
        if (!isWithin(journalRoot, priorParent)) {
          throw new Error(`journal prior file parent escapes the journal directory: ${entry.prior_file}`);
        }
        absPrior = path.join(priorParent, path.basename(absPrior));
        const priorLstat = fs.lstatSync(absPrior);
        if (!priorLstat.isFile() || priorLstat.nlink !== 1) {
          throw new Error(`journal prior file is a symlink, hardlinked, or non-regular object: ${entry.prior_file}`);
        }
        if (priorLstat.ino !== entry.prior_ino || priorLstat.dev !== entry.prior_dev) {
          throw new Error(`device/inode substitution detected on journal prior bytes: ${entry.prior_file}`);
        }
        if (computeFileHash(absPrior) !== entry.prior_hash) {
          throw new Error(`journal prior bytes differ from the recorded prior hash: ${entry.prior_file}`);
        }
      }
      resolved.push({ absFinal, entry, absPrior, finalState });
    }

    // Preflight passed for the WHOLE transaction: restore prior bytes by
    // COPYING from the immutable journal — never consuming the only copy.
    // Entries already in the prior state (crash during rollback) need no
    // further mutation.
    for (const resolvedEntry of resolved) {
      const { absFinal, absPrior, entry, finalState } = resolvedEntry;
      if (entry.had_prior && absPrior && finalState !== "prior") {
        fs.copyFileSync(absPrior, absFinal);
        if (computeFileHash(absFinal) !== (entry.prior_hash ?? "")) {
          throw new Error(`restored canonical bytes do not match the recorded prior hash: ${entry.final}`);
        }
        syncCanonicalOutput(absFinal);
        restored.push({ final: absFinal, from_journal: absPrior });
      } else if (!entry.had_prior && finalState === "staged") {
        // No prior canonical ever existed: the rollback removes the promoted
        // output entirely.
        fs.unlinkSync(absFinal);
        syncCanonicalOutput(absFinal);
      }
    }

    // Final canonical postcondition, then one atomic state transition:
    // dispose the journal (all-or-nothing rename + private removal) and end
    // the claim.
    for (const resolvedEntry of resolved) {
      const entry = resolvedEntry.entry;
      if (entry.had_prior) {
        if (!regularSingleLink(resolvedEntry.absFinal) ||
          computeFileHash(resolvedEntry.absFinal) !== (entry.prior_hash ?? "")) {
          throw new Error(`final recovery postcondition failed for ${entry.final}`);
        }
      } else if (lstatIfPresent(resolvedEntry.absFinal)) {
        throw new Error(`final recovery postcondition failed for ${entry.final}`);
      }
      syncCanonicalOutput(resolvedEntry.absFinal);
    }

    // The journal remains present until the private exact-owner claim is
    // successfully released. On cleanup failure, both paths are returned and
    // the canonical hard link still excludes all challengers.
    if (!claimPath || !fs.existsSync(claimPath)) {
      throw new Error("recovery exact-owner claim is missing before release");
    }
    try {
      fs.unlinkSync(claimPath);
    } catch (error) {
      return {
        recovered: false,
        restored,
        errors: [`recovery claim cleanup failed; journal and claim retained: ${String(error)}`],
        recovery: recoveryInfo(),
      };
    }
    removeEmptyClaimDir(claimDir!);
    claimPath = null;
    claimDir = null;

    try {
      writeRecoveryCompletionMarker(projectDir, recoveryGuard, journal, "rollback");
    } catch (error) {
      return {
        recovered: false,
        restored,
        errors: [`recovery completion authority could not be persisted: ${String(error)}`],
        recovery: recoveryInfo(),
      };
    }

    // Cross the journal rename boundary while the recovery guard and
    // canonical lock still exclude challengers. The retained trash bundle is
    // the durable recovery authority until every other ownership artifact is
    // gone.
    const prepared = prepareJournalDisposal(journalDir);
    if (!prepared.pending) {
      journalDir = prepared.retainedPath ?? journalDir;
      return {
        recovered: false,
        restored,
        errors: [`journal disposal failed; journal retained at ${journalDir}: ${prepared.error ?? "unknown"}`],
        recovery: recoveryInfo(),
      };
    }
    journalDir = prepared.pending.path;
    // Remove the canonical lock while the recovery guard and journal remain.
    // If the process dies after this unlink, the public orphan-journal path
    // can safely recreate the lock from the journal.
    const finalLock = observeLockFile(lockPath);
    if (!finalLock || !recordsMatch(observed, finalLock)) {
      if (finalLock) fs.closeSync(finalLock.fd);
      throw new Error("canonical lock changed before recovery release");
    }
    try {
      fs.unlinkSync(lockPath);
    } finally {
      fs.closeSync(finalLock.fd);
    }
    // Remove the guard before disposing the journal. A crash after this
    // point leaves a journal-only state, which is explicitly recoverable;
    // no guard-only state is treated as completion authority.
    if (recoveryGuard) removeRecoveryGuard(recoveryGuard);
    const disposal = finishJournalDisposal(prepared.pending);
    if (!disposal.disposed) {
      journalDir = disposal.retainedPath ?? journalDir;
      return {
        recovered: false,
        restored,
        errors: [`journal disposal failed; journal retained at ${journalDir}: ${disposal.error ?? "unknown"}`],
        recovery: recoveryInfo(),
      };
    }
    return { recovered: true, restored, errors: [] };
  } catch (error) {
    // Fail closed: retain the canonical lock, guard, journal, and private
    // claim whenever they exist. A retry can resume the same transaction
    // without guessing from age or journal contents.
    closeObserved();
    if (claimDir && claimPath && !fs.existsSync(claimPath)) removeEmptyClaimDir(claimDir);
    errors.push(error instanceof Error ? error.message : String(error));
    return { recovered: false, restored, errors, recovery: recoveryInfo() };
  }
}



// ── State Transition ─────────────────────────────────────────────

export function transitionState(
  projectDir: string,
  doc: ProjectStateDoc,
  toState: ProjectState,
  trigger: string,
  actor: string,
  note?: string,
  options?: { expectedRevision?: string },
): ProjectStateDoc {
  const fromState = doc.current_state;

  // Record history
  const entry = createHistoryEntry(fromState, toState, trigger, actor, note);
  if (!doc.history) doc.history = [];
  doc.history.push(entry);

  // Update state
  doc.current_state = toState;
  doc.last_agent = actor;
  doc.last_command = trigger;

  // Persist with revision guard
  writeProjectState(projectDir, doc, {
    expectedRevision: options?.expectedRevision,
  });

  return doc;
}
