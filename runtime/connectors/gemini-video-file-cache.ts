/**
 * Private, project-local Gemini Files registry.
 *
 * This module owns only the local registry state. It does not upload media or
 * call a provider. Callers must perform their own upload and record the
 * resulting bounded provider identifier after the upload has been proven.
 *
 * The registry is deliberately separate from tracked evidence. Its entries
 * contain the four inputs that make a File API object reusable plus bounded
 * provider identifiers and expiry/status metadata; local paths and secrets are
 * not part of the persisted shape.
 */

import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

export const GEMINI_FILE_REGISTRY_RELATIVE_PATH =
  ".video-os/private-cache/gemini-file-registry.json";
export const GEMINI_FILE_REGISTRY_VERSION = "gemini-file-registry/v1" as const;
export const GEMINI_FILE_REGISTRY_KEY_VERSION = "gemini-file-registry-key/v1" as const;

const SHA256_PATTERN = /^(?:sha256:)?[0-9a-f]{64}$/i;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/@+\-]{0,255}$/;
const MIME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9.+-]{0,63}\/[A-Za-z0-9][A-Za-z0-9.+-]{0,63}$/;
const SAFE_DERIVATIVE_KEY = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;
const FORBIDDEN_DERIVATIVE_KEY = /(path|prompt|secret|credential|password|token|api[_-]?key|uri|url)/i;
const ABSOLUTE_PATH_PATTERN = /^(?:[A-Za-z]:[\\/]|[\\/]{1,2}|~[\\/])/;

export type PrivateJsonValue =
  | null
  | boolean
  | number
  | string
  | PrivateJsonValue[]
  | { [key: string]: PrivateJsonValue };

export type GeminiFileRegistryStatus = "ready" | "failed" | "expired" | "unusable";

export type GeminiDerivativeSpecification = PrivateJsonValue | Readonly<Record<string, unknown>>;

export type GeminiProviderScope =
  | string
  | {
      projectId?: string;
      accountId?: string;
      project?: string;
      account?: string;
    };

export interface GeminiFileRegistryIdentityInput {
  sourceContentSha256: string;
  /** Submitted media identity. Required by M4a when resolving a provider URI. */
  submittedMediaContentSha256?: string;
  /** Either spelling is accepted; the canonical persisted field is explicit. */
  derivative?: GeminiDerivativeSpecification;
  derivativeSpec?: GeminiDerivativeSpecification;
  mimeType: string;
  providerScope?: GeminiProviderScope;
  /** Convenience aliases for callers that keep project/account separately. */
  providerProject?: string;
  providerAccount?: string;
}

export interface GeminiProviderScopeIdentity {
  projectId: string;
  accountId: string;
}

export interface GeminiFileRegistryIdentity {
  sourceContentSha256: string;
  submittedMediaContentSha256?: string;
  derivativeSpecification: PrivateJsonValue;
  mimeType: string;
  providerScope: GeminiProviderScopeIdentity;
}

export interface GeminiFileRegistryEntry {
  registryKey: string;
  sourceContentSha256: string;
  submittedMediaContentSha256?: string;
  derivativeSpecification: PrivateJsonValue;
  mimeType: string;
  providerScope: GeminiProviderScopeIdentity;
  status: GeminiFileRegistryStatus;
  providerFileId?: string;
  providerFileName?: string;
  providerUri?: string;
  createdAt: string;
  updatedAt: string;
  expiresAt: string | null;
  failureClass?: string;
  sizeBytes?: number;
  uploadedDurationUs?: number;
}

export interface GeminiFileRegistryDocument {
  version: typeof GEMINI_FILE_REGISTRY_VERSION;
  entries: GeminiFileRegistryEntry[];
}

export interface GeminiFileRegistryEntryInput extends GeminiFileRegistryIdentityInput {
  status?: GeminiFileRegistryStatus;
  providerFileId?: string;
  providerFileName?: string;
  providerUri?: string;
  expiresAt?: string | number | Date | null;
  failureClass?: string;
  sizeBytes?: number;
  uploadedDurationUs?: number;
  now?: string | number | Date;
}

export type GeminiFileRegistryLookupDecision = "reuse" | "upload_required" | "blocked";
export type GeminiFileRegistryLookupReason =
  | "missing"
  | "ready"
  | "expired"
  | "failed"
  | "unusable"
  | "state_expired"
  | "identity_mismatch"
  | "malformed_state"
  | "invalid_request";

export interface GeminiFileRegistryLookupResult {
  decision: GeminiFileRegistryLookupDecision;
  reason: GeminiFileRegistryLookupReason;
  reusable: boolean;
  registryKey: string | null;
  entry?: GeminiFileRegistryEntry;
}

export interface GeminiFileRegistryMutationResult {
  path: string;
  entry: GeminiFileRegistryEntry;
  document: GeminiFileRegistryDocument;
}

export interface GeminiFileRegistryOptions {
  now?: () => number | string | Date;
}

export class GeminiFileRegistryStateError extends Error {
  readonly code = "private_state_malformed" as const;

  constructor(message = "private Gemini File registry state is malformed or unsupported") {
    super(message);
    this.name = "GeminiFileRegistryStateError";
  }
}

export class GeminiFileRegistryBusyError extends Error {
  readonly code = "cache_busy" as const;

  constructor() {
    super("private Gemini File registry state is busy");
    this.name = "GeminiFileRegistryBusyError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const allowedSet = new Set(allowed);
  return Object.keys(value).every((key) => allowedSet.has(key));
}

function normalizeHash(value: unknown, field: string): string {
  if (typeof value !== "string") throw new GeminiFileRegistryStateError(`invalid ${field}`);
  const normalized = value.trim().toLowerCase().replace(/^sha256:/, "");
  if (!SHA256_PATTERN.test(normalized)) throw new GeminiFileRegistryStateError(`invalid ${field}`);
  return normalized;
}

function normalizeIdentifier(value: unknown, field: string): string {
  if (typeof value !== "string") throw new GeminiFileRegistryStateError(`invalid ${field}`);
  const normalized = value.normalize("NFC").trim();
  if (!IDENTIFIER_PATTERN.test(normalized) || normalized.includes("..")) {
    throw new GeminiFileRegistryStateError(`invalid ${field}`);
  }
  return normalized;
}

function normalizeMimeType(value: unknown): string {
  if (typeof value !== "string") throw new GeminiFileRegistryStateError("invalid mimeType");
  const normalized = value.normalize("NFC").trim().toLowerCase();
  if (!MIME_PATTERN.test(normalized)) throw new GeminiFileRegistryStateError("invalid mimeType");
  return normalized;
}

function sanitizeDerivativeValue(value: unknown, depth = 0): PrivateJsonValue {
  if (depth > 5) throw new GeminiFileRegistryStateError("derivative specification is too deep");
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new GeminiFileRegistryStateError("derivative specification number is invalid");
    }
    return value;
  }
  if (typeof value === "string") {
    const normalized = value.normalize("NFC").trim();
    if (normalized.length === 0 || Buffer.byteLength(normalized, "utf8") > 512) {
      throw new GeminiFileRegistryStateError("derivative specification string is invalid");
    }
    if (ABSOLUTE_PATH_PATTERN.test(normalized) || normalized.includes("\\") || normalized.includes("://")) {
      throw new GeminiFileRegistryStateError("derivative specification contains a forbidden locator");
    }
    return normalized;
  }
  if (Array.isArray(value)) {
    if (value.length > 64) throw new GeminiFileRegistryStateError("derivative specification array is too large");
    return value.map((item) => sanitizeDerivativeValue(item, depth + 1));
  }
  if (!isRecord(value)) throw new GeminiFileRegistryStateError("derivative specification type is invalid");
  const keys = Object.keys(value).sort();
  if (keys.length > 64) throw new GeminiFileRegistryStateError("derivative specification object is too large");
  const result: { [key: string]: PrivateJsonValue } = {};
  for (const key of keys) {
    if (!SAFE_DERIVATIVE_KEY.test(key) || FORBIDDEN_DERIVATIVE_KEY.test(key)) {
      throw new GeminiFileRegistryStateError("derivative specification key is forbidden");
    }
    result[key] = sanitizeDerivativeValue(value[key], depth + 1);
  }
  return result;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") return Object.is(value, -0) ? "0" : String(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  throw new GeminiFileRegistryStateError("unsupported private JSON value");
}

function hashCanonical(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalJson(value), "utf8").digest("hex")}`;
}

function selectEqualAlias<T>(
  field: string,
  values: readonly unknown[],
  normalize: (value: unknown) => T,
): T | undefined {
  const present = values.filter((value) => value !== undefined);
  if (present.length === 0) return undefined;
  const first = normalize(present[0]);
  for (const value of present.slice(1)) {
    const candidate = normalize(value);
    if (canonicalJson(candidate) !== canonicalJson(first)) {
      throw new GeminiFileRegistryStateError(`conflicting ${field} aliases`);
    }
  }
  return first;
}

function resolveProviderScope(input: GeminiFileRegistryIdentityInput): GeminiProviderScopeIdentity {
  const scope = input.providerScope;
  const projectAliases: unknown[] = [input.providerProject];
  const accountAliases: unknown[] = [input.providerAccount];
  if (typeof scope === "string") {
    projectAliases.push(scope);
  } else if (isRecord(scope)) {
    if (!exactKeys(scope, ["projectId", "accountId", "project", "account"])) {
      throw new GeminiFileRegistryStateError("unsupported provider scope shape");
    }
    projectAliases.push(scope.projectId, scope.project);
    accountAliases.push(scope.accountId, scope.account);
  } else if (scope !== undefined) {
    throw new GeminiFileRegistryStateError("invalid provider scope");
  }
  const project = selectEqualAlias("provider project", projectAliases,
    (value) => normalizeIdentifier(value, "providerScope.projectId"));
  const account = selectEqualAlias("provider account", accountAliases,
    (value) => normalizeIdentifier(value, "providerScope.accountId"));
  if (project === undefined) {
    throw new GeminiFileRegistryStateError("missing providerScope.projectId");
  }
  return {
    projectId: project,
    // A missing account is explicit "unspecified", but an explicitly supplied
    // account always survives alongside a string provider project/scope.
    accountId: account ?? "unspecified",
  };
}

function normalizeIdentity(input: GeminiFileRegistryIdentityInput): GeminiFileRegistryIdentity {
  if (!isRecord(input as unknown)) throw new GeminiFileRegistryStateError("invalid registry identity");
  const derivative = selectEqualAlias("derivative specification", [input.derivative, input.derivativeSpec], sanitizeDerivativeValue);
  if (derivative === undefined) throw new GeminiFileRegistryStateError("missing derivative specification");
  return {
    sourceContentSha256: normalizeHash(input.sourceContentSha256, "sourceContentSha256"),
    ...(input.submittedMediaContentSha256 === undefined ? {} : {
      submittedMediaContentSha256: normalizeHash(
        input.submittedMediaContentSha256,
        "submittedMediaContentSha256",
      ),
    }),
    derivativeSpecification: derivative,
    mimeType: normalizeMimeType(input.mimeType),
    providerScope: resolveProviderScope(input),
  };
}

export function normalizeGeminiFileRegistryIdentity(
  input: GeminiFileRegistryIdentityInput,
): GeminiFileRegistryIdentity {
  return normalizeIdentity(input);
}

export function computeGeminiFileRegistryKey(
  input: GeminiFileRegistryIdentityInput,
): string {
  const identity = normalizeIdentity(input);
  return hashCanonical({
    version: GEMINI_FILE_REGISTRY_KEY_VERSION,
    sourceContentSha256: identity.sourceContentSha256,
    ...(identity.submittedMediaContentSha256 === undefined ? {} : {
      submittedMediaContentSha256: identity.submittedMediaContentSha256,
    }),
    derivativeSpecification: identity.derivativeSpecification,
    mimeType: identity.mimeType,
    providerScope: identity.providerScope,
  });
}

function parseTimestamp(value: unknown, field: string, allowNull = false): string | null {
  if (value === null && allowNull) return null;
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 0) throw new GeminiFileRegistryStateError(`invalid ${field}`);
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) throw new GeminiFileRegistryStateError(`invalid ${field}`);
    return date.toISOString();
  }
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) throw new GeminiFileRegistryStateError(`invalid ${field}`);
    return value.toISOString();
  }
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    throw new GeminiFileRegistryStateError(`invalid ${field}`);
  }
  return new Date(value).toISOString();
}

function nowMilliseconds(value: unknown): number {
  const parsed = parseTimestamp(value, "now");
  if (parsed === null) throw new GeminiFileRegistryStateError("invalid now");
  return Date.parse(parsed);
}

function sanitizeClassification(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new GeminiFileRegistryStateError(`invalid ${field}`);
  const normalized = value.normalize("NFC").trim().replace(/[ \t]+/g, " ");
  if (!/^[A-Za-z0-9][A-Za-z0-9 _.-]{0,127}$/.test(normalized)) {
    throw new GeminiFileRegistryStateError(`invalid ${field}`);
  }
  return normalized;
}

function sanitizeProviderUri(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > 512) {
    throw new GeminiFileRegistryStateError("invalid providerUri");
  }
  const normalized = value.normalize("NFC").trim();
  if (normalized.includes("?") || normalized.includes("#") || normalized.includes("\\")) {
    throw new GeminiFileRegistryStateError("invalid providerUri");
  }
  if (normalized.startsWith("gs://")) {
    if (!/^gs:\/\/[A-Za-z0-9._-]+\/[A-Za-z0-9._/+-]+$/.test(normalized)) {
      throw new GeminiFileRegistryStateError("invalid providerUri");
    }
    return normalized;
  }
  try {
    const parsed = new URL(normalized);
    if (parsed.protocol !== "https:" || parsed.hostname !== "generativelanguage.googleapis.com" ||
        !parsed.pathname.startsWith("/v1beta/files/") || parsed.pathname.length <= "/v1beta/files/".length) {
      throw new Error("provider origin is not allowed");
    }
    return normalized;
  } catch {
    throw new GeminiFileRegistryStateError("invalid providerUri");
  }
}

function nonNegativeSafeInteger(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new GeminiFileRegistryStateError(`invalid ${field}`);
  }
  return value as number;
}

function normalizeEntry(input: GeminiFileRegistryEntryInput, nowValue: unknown): GeminiFileRegistryEntry {
  const identity = normalizeIdentity(input);
  const status = input.status ?? "ready";
  if (status !== "ready" && status !== "failed" && status !== "expired" && status !== "unusable") {
    throw new GeminiFileRegistryStateError("invalid registry status");
  }
  const providerFileId = input.providerFileId === undefined
    ? undefined
    : normalizeIdentifier(input.providerFileId, "providerFileId");
  const providerFileName = input.providerFileName === undefined
    ? undefined
    : normalizeIdentifier(input.providerFileName, "providerFileName");
  const providerUri = sanitizeProviderUri(input.providerUri);
  if (status === "ready" && !providerFileId && !providerFileName && !providerUri) {
    throw new GeminiFileRegistryStateError("ready registry entry has no provider identifier");
  }
  const now = parseTimestamp(nowValue, "now")!;
  const expiresAt = input.expiresAt === undefined
    ? null
    : parseTimestamp(input.expiresAt, "expiresAt", true);
  if (status === "ready" && expiresAt === null) {
    throw new GeminiFileRegistryStateError("ready registry entry has no expiry");
  }
  const entry: GeminiFileRegistryEntry = {
    registryKey: computeGeminiFileRegistryKey(input),
    ...identity,
    status,
    createdAt: now,
    updatedAt: now,
    expiresAt,
    ...(providerFileId ? { providerFileId } : {}),
    ...(providerFileName ? { providerFileName } : {}),
    ...(providerUri ? { providerUri } : {}),
    ...(sanitizeClassification(input.failureClass, "failureClass")
      ? { failureClass: sanitizeClassification(input.failureClass, "failureClass")! } : {}),
    ...(nonNegativeSafeInteger(input.sizeBytes, "sizeBytes") !== undefined
      ? { sizeBytes: nonNegativeSafeInteger(input.sizeBytes, "sizeBytes")! } : {}),
    ...(nonNegativeSafeInteger(input.uploadedDurationUs, "uploadedDurationUs") !== undefined
      ? { uploadedDurationUs: nonNegativeSafeInteger(input.uploadedDurationUs, "uploadedDurationUs")! } : {}),
  };
  return entry;
}

function validateProviderScope(value: unknown): value is GeminiProviderScopeIdentity {
  if (!isRecord(value) || !exactKeys(value, ["projectId", "accountId"])) return false;
  try {
    normalizeIdentifier(value.projectId, "providerScope.projectId");
    normalizeIdentifier(value.accountId, "providerScope.accountId");
    return true;
  } catch {
    return false;
  }
}

function validateRegistryEntry(value: unknown): value is GeminiFileRegistryEntry {
  if (!isRecord(value) || !exactKeys(value, [
    "registryKey", "sourceContentSha256", "submittedMediaContentSha256", "derivativeSpecification", "mimeType", "providerScope",
    "status", "providerFileId", "providerFileName", "providerUri", "createdAt", "updatedAt",
    "expiresAt", "failureClass", "sizeBytes", "uploadedDurationUs",
  ])) return false;
  if (typeof value.registryKey !== "string" || !/^sha256:[0-9a-f]{64}$/.test(value.registryKey)) return false;
  if (typeof value.sourceContentSha256 !== "string" || !/^[0-9a-f]{64}$/.test(value.sourceContentSha256)) return false;
  if (value.submittedMediaContentSha256 !== undefined &&
      (typeof value.submittedMediaContentSha256 !== "string" || !/^[0-9a-f]{64}$/.test(value.submittedMediaContentSha256))) return false;
  if (typeof value.mimeType !== "string" || !MIME_PATTERN.test(value.mimeType)) return false;
  if (!validateProviderScope(value.providerScope)) return false;
  if (value.status !== "ready" && value.status !== "failed" && value.status !== "expired" && value.status !== "unusable") return false;
  if (value.providerFileId !== undefined) {
    try { normalizeIdentifier(value.providerFileId, "providerFileId"); } catch { return false; }
  }
  if (value.providerFileName !== undefined) {
    try { normalizeIdentifier(value.providerFileName, "providerFileName"); } catch { return false; }
  }
  if (value.providerUri !== undefined) {
    try { sanitizeProviderUri(value.providerUri); } catch { return false; }
  }
  if (value.status === "ready" && !value.providerFileId && !value.providerFileName && !value.providerUri) return false;
  if (!isCanonicalTimestamp(value.createdAt) || !isCanonicalTimestamp(value.updatedAt)) return false;
  if (value.expiresAt !== null && !isCanonicalTimestamp(value.expiresAt)) return false;
  if (value.failureClass !== undefined && (typeof value.failureClass !== "string" || !/^[A-Za-z0-9][A-Za-z0-9 _.-]{0,127}$/.test(value.failureClass))) return false;
  if (value.sizeBytes !== undefined && (typeof value.sizeBytes !== "number" || !Number.isSafeInteger(value.sizeBytes) || value.sizeBytes < 0)) return false;
  if (value.uploadedDurationUs !== undefined && (typeof value.uploadedDurationUs !== "number" || !Number.isSafeInteger(value.uploadedDurationUs) || value.uploadedDurationUs < 0)) return false;
  try {
    const derivative = sanitizeDerivativeValue(value.derivativeSpecification);
    const expected = computeGeminiFileRegistryKey({
      sourceContentSha256: value.sourceContentSha256,
      ...(value.submittedMediaContentSha256 === undefined ? {} : {
        submittedMediaContentSha256: value.submittedMediaContentSha256,
      }),
      derivative,
      mimeType: value.mimeType,
      providerScope: value.providerScope,
    });
    return expected === value.registryKey && canonicalJson(derivative) === canonicalJson(value.derivativeSpecification);
  } catch {
    return false;
  }
}

function isCanonicalTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try { return parseTimestamp(value, "timestamp") === value; } catch { return false; }
}

function emptyRegistry(): GeminiFileRegistryDocument {
  return { version: GEMINI_FILE_REGISTRY_VERSION, entries: [] };
}

function readRegistryFile(registryPath: string): GeminiFileRegistryDocument {
  try {
    const stat = fs.lstatSync(registryPath);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("registry is not a regular file");
    const parsed = JSON.parse(fs.readFileSync(registryPath, "utf8")) as unknown;
    if (!isRecord(parsed) || !exactKeys(parsed, ["version", "entries"]) ||
        parsed.version !== GEMINI_FILE_REGISTRY_VERSION || !Array.isArray(parsed.entries)) {
      throw new Error("unsupported registry document");
    }
    const entries = parsed.entries as unknown[];
    if (entries.length > 10_000 || !entries.every(validateRegistryEntry)) {
      throw new Error("invalid registry entry");
    }
    const keys = entries.map((entry) => (entry as GeminiFileRegistryEntry).registryKey);
    if (new Set(keys).size !== keys.length) throw new Error("duplicate registry key");
    return {
      version: GEMINI_FILE_REGISTRY_VERSION,
      entries: entries as GeminiFileRegistryEntry[],
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyRegistry();
    if (error instanceof GeminiFileRegistryStateError) throw error;
    throw new GeminiFileRegistryStateError();
  }
}

function registryPathFor(projectDir: string): string {
  const resolved = path.resolve(projectDir);
  if (path.extname(resolved).toLowerCase() === ".json") {
    throw new GeminiFileRegistryStateError("registry path helper requires a project root");
  }
  return path.resolve(resolved, GEMINI_FILE_REGISTRY_RELATIVE_PATH);
}

function isExactRegistryPath(filePath: string): boolean {
  return path.basename(filePath) === "gemini-file-registry.json" &&
    path.basename(path.dirname(filePath)) === "private-cache" &&
    path.basename(path.dirname(path.dirname(filePath))) === ".video-os";
}

function resolveRegistryPath(projectDirOrPath: string): string {
  const resolved = path.resolve(projectDirOrPath);
  if (path.extname(resolved).toLowerCase() === ".json") {
    if (!isExactRegistryPath(resolved)) {
      throw new GeminiFileRegistryStateError("registry APIs require a project root or exact private registry path");
    }
    return resolved;
  }
  return registryPathFor(resolved);
}

function ensurePrivateDirectory(filePath: string): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(dir, 0o700); } catch { /* best effort on platforms without chmod */ }
}

function fsyncDirectory(dir: string): void {
  try {
    const fd = fs.openSync(dir, "r");
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  } catch {
    // Directory fsync is not available on every supported filesystem. The
    // file itself is still fsynced before rename.
  }
}

function atomicWriteRegistry(registryPath: string, document: GeminiFileRegistryDocument): void {
  ensurePrivateDirectory(registryPath);
  const tempPath = `${registryPath}.tmp-${process.pid}-${randomUUID()}`;
  let fd: number | undefined;
  try {
    fd = fs.openSync(tempPath, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
    fs.writeFileSync(fd, `${JSON.stringify(document, null, 2)}\n`, "utf8");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(tempPath, registryPath);
    try { fs.chmodSync(registryPath, 0o600); } catch { /* best effort */ }
    fsyncDirectory(path.dirname(registryPath));
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* cleanup only */ }
    }
    try { fs.unlinkSync(tempPath); } catch { /* the rename already removed it */ }
  }
}

function withRegistryLock<T>(registryPath: string, action: () => T): T {
  ensurePrivateDirectory(registryPath);
  const lockPath = `${registryPath}.lock`;
  let fd: number | undefined;
  let lockOwned = false;
  try {
    try {
      fd = fs.openSync(lockPath, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
      lockOwned = true;
      fs.writeFileSync(fd, `${JSON.stringify({ version: "private-state-lock/v1", pid: process.pid })}\n`, "utf8");
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = undefined;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new GeminiFileRegistryBusyError();
      throw error;
    }
    return action();
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* cleanup only */ }
    }
    if (lockOwned) {
      try { fs.unlinkSync(lockPath); } catch { /* do not mask the state result */ }
    }
  }
}

function registryNow(options: GeminiFileRegistryOptions): number {
  return nowMilliseconds(options.now?.() ?? Date.now());
}

function sameIdentity(entry: GeminiFileRegistryEntry, identity: GeminiFileRegistryIdentity): boolean {
  return entry.sourceContentSha256 === identity.sourceContentSha256 &&
    entry.submittedMediaContentSha256 === identity.submittedMediaContentSha256 &&
    entry.mimeType === identity.mimeType &&
    entry.providerScope.projectId === identity.providerScope.projectId &&
    entry.providerScope.accountId === identity.providerScope.accountId &&
    canonicalJson(entry.derivativeSpecification) === canonicalJson(identity.derivativeSpecification);
}

function lookupWithPath(
  registryPath: string,
  input: GeminiFileRegistryIdentityInput,
  options: GeminiFileRegistryOptions,
): GeminiFileRegistryLookupResult {
  let identity: GeminiFileRegistryIdentity;
  let registryKey: string;
  try {
    identity = normalizeIdentity(input);
    registryKey = computeGeminiFileRegistryKey(input);
  } catch {
    return { decision: "blocked", reason: "invalid_request", reusable: false, registryKey: null };
  }
  let document: GeminiFileRegistryDocument;
  try {
    document = readRegistryFile(registryPath);
  } catch {
    return { decision: "blocked", reason: "malformed_state", reusable: false, registryKey };
  }
  const entry = document.entries.find((candidate) => candidate.registryKey === registryKey);
  if (!entry) return { decision: "upload_required", reason: "missing", reusable: false, registryKey };
  if (!sameIdentity(entry, identity)) {
    return { decision: "upload_required", reason: "identity_mismatch", reusable: false, registryKey, entry };
  }
  if (entry.status !== "ready") {
    const reason: GeminiFileRegistryLookupReason = entry.status === "expired"
      ? "expired" : entry.status === "failed" ? "failed" : "unusable";
    return { decision: "upload_required", reason, reusable: false, registryKey, entry };
  }
  if (!entry.expiresAt || Date.parse(entry.expiresAt) <= registryNow(options) ||
      (!entry.providerFileId && !entry.providerFileName && !entry.providerUri)) {
    return { decision: "upload_required", reason: "state_expired", reusable: false, registryKey, entry };
  }
  return { decision: "reuse", reason: "ready", reusable: true, registryKey, entry };
}

export function geminiFileRegistryPath(projectDir: string): string {
  return registryPathFor(projectDir);
}

export const getGeminiFileRegistryPath = geminiFileRegistryPath;

export function loadGeminiFileRegistry(projectDirOrPath: string): GeminiFileRegistryDocument {
  return readRegistryFile(resolveRegistryPath(projectDirOrPath));
}

export function saveGeminiFileRegistry(
  projectDirOrPath: string,
  document: GeminiFileRegistryDocument,
): void {
  if (document.version !== GEMINI_FILE_REGISTRY_VERSION || !Array.isArray(document.entries) ||
      !document.entries.every(validateRegistryEntry)) {
    throw new GeminiFileRegistryStateError();
  }
  const filePath = resolveRegistryPath(projectDirOrPath);
  const normalized = {
    version: GEMINI_FILE_REGISTRY_VERSION,
    entries: [...document.entries].sort((a, b) => a.registryKey.localeCompare(b.registryKey)),
  } satisfies GeminiFileRegistryDocument;
  const keys = normalized.entries.map((entry) => entry.registryKey);
  if (new Set(keys).size !== keys.length) throw new GeminiFileRegistryStateError();
  withRegistryLock(filePath, () => {
    // Do not replace malformed private state through a normal save.
    readRegistryFile(filePath);
    atomicWriteRegistry(filePath, normalized);
  });
}

export function lookupGeminiFileRegistry(
  projectDirOrPath: string,
  input: GeminiFileRegistryIdentityInput,
  options: GeminiFileRegistryOptions = {},
): GeminiFileRegistryLookupResult {
  return lookupWithPath(resolveRegistryPath(projectDirOrPath), input, options);
}

export function recordGeminiFileRegistryEntry(
  projectDirOrPath: string,
  input: GeminiFileRegistryEntryInput,
  options: GeminiFileRegistryOptions = {},
): GeminiFileRegistryMutationResult {
  const filePath = resolveRegistryPath(projectDirOrPath);
  const now = input.now ?? options.now?.() ?? Date.now();
  const nextEntry = normalizeEntry(input, now);
  return withRegistryLock(filePath, () => {
    const current = readRegistryFile(filePath);
    const entries = current.entries.filter((entry) => entry.registryKey !== nextEntry.registryKey);
    const prior = current.entries.find((entry) => entry.registryKey === nextEntry.registryKey);
    const entry: GeminiFileRegistryEntry = prior
      ? { ...nextEntry, createdAt: prior.createdAt }
      : nextEntry;
    const document: GeminiFileRegistryDocument = {
      version: GEMINI_FILE_REGISTRY_VERSION,
      entries: [...entries, entry].sort((a, b) => a.registryKey.localeCompare(b.registryKey)),
    };
    atomicWriteRegistry(filePath, document);
    return { path: filePath, entry, document };
  });
}

export function recordGeminiFileReady(
  projectDirOrPath: string,
  input: Omit<GeminiFileRegistryEntryInput, "status">,
  options: GeminiFileRegistryOptions = {},
): GeminiFileRegistryMutationResult {
  return recordGeminiFileRegistryEntry(projectDirOrPath, { ...input, status: "ready" }, options);
}

export function recordGeminiFileFailure(
  projectDirOrPath: string,
  input: Omit<GeminiFileRegistryEntryInput, "status"> & { failureClass: string },
  options: GeminiFileRegistryOptions = {},
): GeminiFileRegistryMutationResult {
  return recordGeminiFileRegistryEntry(projectDirOrPath, { ...input, status: "failed" }, options);
}

export function markGeminiFileUnusable(
  projectDirOrPath: string,
  input: Omit<GeminiFileRegistryEntryInput, "status"> & { failureClass?: string },
  options: GeminiFileRegistryOptions = {},
): GeminiFileRegistryMutationResult {
  return recordGeminiFileRegistryEntry(projectDirOrPath, { ...input, status: "unusable" }, options);
}

export function inspectGeminiFileRegistry(projectDir: string): {
  path: string;
  state: "missing" | "valid" | "malformed";
  document?: GeminiFileRegistryDocument;
} {
  const filePath = registryPathFor(projectDir);
  if (!fs.existsSync(filePath)) return { path: filePath, state: "missing" };
  try {
    return { path: filePath, state: "valid", document: readRegistryFile(filePath) };
  } catch {
    return { path: filePath, state: "malformed" };
  }
}

export class GeminiVideoFileRegistry {
  readonly path: string;
  private readonly options: GeminiFileRegistryOptions;

  constructor(projectDir: string, options: GeminiFileRegistryOptions = {}) {
    this.path = registryPathFor(projectDir);
    this.options = options;
  }

  load(): GeminiFileRegistryDocument {
    return readRegistryFile(this.path);
  }

  lookup(input: GeminiFileRegistryIdentityInput): GeminiFileRegistryLookupResult {
    return lookupWithPath(this.path, input, this.options);
  }

  record(input: GeminiFileRegistryEntryInput): GeminiFileRegistryMutationResult {
    return recordGeminiFileRegistryEntry(this.path, input, this.options);
  }

  recordReady(input: Omit<GeminiFileRegistryEntryInput, "status">): GeminiFileRegistryMutationResult {
    return this.record({ ...input, status: "ready" });
  }

  recordFailure(input: Omit<GeminiFileRegistryEntryInput, "status"> & { failureClass: string }): GeminiFileRegistryMutationResult {
    return this.record({ ...input, status: "failed" });
  }

  markUnusable(input: Omit<GeminiFileRegistryEntryInput, "status"> & { failureClass?: string }): GeminiFileRegistryMutationResult {
    return this.record({ ...input, status: "unusable" });
  }
}

export const createGeminiVideoFileRegistry = (
  projectDir: string,
  options: GeminiFileRegistryOptions = {},
): GeminiVideoFileRegistry => new GeminiVideoFileRegistry(projectDir, options);

export const createGeminiFileRegistry = createGeminiVideoFileRegistry;
