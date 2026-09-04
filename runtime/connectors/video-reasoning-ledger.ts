/**
 * Private request ledger for optional video reasoning calls.
 *
 * The ledger is an operator-facing safety boundary, not provider integration.
 * A caller reserves an identity before network work, records whether submission
 * was proven, and may only release a reservation before submission is proven.
 * A post-submit unknown is intentionally kept active until an operator records
 * an explicit resolution with an actor and bounded reason classification.
 */

import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

export const AGENTIC_REQUEST_LEDGER_RELATIVE_PATH =
  ".video-os/private-cache/agentic-request-ledger.json";
export const VIDEO_REASONING_LEDGER_VERSION = "agentic-request-ledger/v1" as const;
export const VIDEO_REASONING_REQUEST_IDENTITY_VERSION = "agentic-request-identity/v1" as const;
export const VIDEO_REASONING_PROMPT_CONTRACT_VERSION = "video-reasoning/v1" as const;
export const VIDEO_REASONING_OUTPUT_SCHEMA_VERSION = "video-reasoning-response/v1" as const;

const SHA256_PATTERN = /^(?:sha256:)?[0-9a-f]{64}$/i;
const REQUEST_ID_PATTERN = /^sha256:[0-9a-f]{64}$/;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/@+\-]{0,255}$/;
const ACTOR_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@+\-]{0,127}$/;
const CLASSIFICATION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 _.-]{0,127}$/;
const MAX_PROMPT_BYTES = 64 * 1024;

export type VideoReasoningLedgerJsonValue =
  | null
  | boolean
  | number
  | string
  | VideoReasoningLedgerJsonValue[]
  | { [key: string]: VideoReasoningLedgerJsonValue };

export interface VideoReasoningRequestIdentityInput {
  sourceContentSha256: string;
  effectiveSourceRangeUs?: readonly [number, number];
  sourceRangeUs?: readonly [number, number];
  rangeUs?: readonly [number, number];
  modelAliasOrSnapshot?: string;
  model?: string;
  modelAlias?: string;
  modelSnapshot?: string;
  processingMode?: string;
  processing?: string;
  normalizedPromptHash?: string;
  promptHash?: string;
  /** Accepted only to derive a hash; the raw prompt is never persisted. */
  prompt?: string;
  promptContractVersion?: string;
  /** Compatibility alias for promptContractVersion. */
  promptContract?: string;
  outputSchemaVersion?: string;
  outputSchema?: string;
}

export interface VideoReasoningRequestIdentity {
  sourceContentSha256: string;
  effectiveSourceRangeUs: readonly [number, number];
  modelAliasOrSnapshot: string;
  processingMode: string;
  normalizedPromptHash: string;
  promptContractVersion: string;
  outputSchemaVersion: string;
}

export interface VideoReasoningRequestIdentityWithId extends VideoReasoningRequestIdentity {
  requestId: string;
}

export type VideoReasoningLedgerStatus =
  | "reserved"
  | "submitted"
  | "unknown"
  | "completed"
  | "failed"
  | "released";

export type VideoReasoningLedgerOutcome =
  | "pending"
  | "unknown"
  | "completed"
  | "failed"
  | "released";

export type VideoReasoningLedgerSubmission = "not_submitted" | "submitted";
export type VideoReasoningLedgerReservation = "active" | "released" | "none";

export interface VideoReasoningLedgerUsage {
  inputTokens?: number;
  outputTokens?: number;
  thoughtTokens?: number;
  toolUseTokens?: number;
  totalTokens?: number;
  estimatedUsd?: number;
}

export type VideoReasoningOperatorResolutionAction =
  | "release_for_retry"
  | "mark_failed"
  | "mark_completed";

export interface VideoReasoningOperatorResolution {
  action: VideoReasoningOperatorResolutionAction;
  actor: string;
  reason: string;
  resolvedAt: string;
}

export interface VideoReasoningLedgerEntry {
  requestId: string;
  identity: VideoReasoningRequestIdentity;
  attempt: number;
  status: VideoReasoningLedgerStatus;
  outcome: VideoReasoningLedgerOutcome;
  submission: VideoReasoningLedgerSubmission;
  reservation: VideoReasoningLedgerReservation;
  retryable: boolean;
  reusable: boolean;
  createdAt: string;
  updatedAt: string;
  submittedAt?: string;
  completedAt?: string;
  providerRequestId?: string;
  /** Bounded identity for a reusable result; never the raw response body. */
  resultId?: string;
  failureClass?: string;
  releaseClass?: string;
  usage?: VideoReasoningLedgerUsage;
  expiresAt?: string | null;
  operatorResolution?: VideoReasoningOperatorResolution;
}

export interface VideoReasoningLedgerDocument {
  version: typeof VIDEO_REASONING_LEDGER_VERSION;
  entries: VideoReasoningLedgerEntry[];
}

export interface VideoReasoningLedgerOptions {
  now?: () => number | string | Date;
}

export interface VideoReasoningLedgerTransitionMetadata {
  providerRequestId?: string;
  resultId?: string;
  /** Compatibility alias; conflicting result identities are rejected. */
  resultIdentity?: string;
  failureClass?: string;
  releaseClass?: string;
  usage?: VideoReasoningLedgerUsage;
  expiresAt?: string | number | Date | null;
  reusable?: boolean;
}

export interface VideoReasoningOperatorResolutionInput {
  action: VideoReasoningOperatorResolutionAction;
  actor: string;
  reason: string;
  /** Required when marking an unknown result reusable. */
  resultId?: string;
  /** Compatibility alias for resultId; it must be equal when both are given. */
  resultIdentity?: string;
  reusable?: boolean;
  providerRequestId?: string;
  usage?: VideoReasoningLedgerUsage;
  expiresAt?: string | number | Date | null;
}

export type VideoReasoningRequestReference =
  | string
  | VideoReasoningRequestIdentityInput
  | VideoReasoningRequestIdentityWithId;

export type VideoReasoningLedgerDecisionKind =
  | "available"
  | "reserved"
  | "retry_reserved"
  | "duplicate_active"
  | "duplicate_submitted"
  | "duplicate_unknown"
  | "duplicate_completed"
  | "retry_allowed"
  | "released"
  | "submitted"
  | "unknown_recorded"
  | "completed"
  | "failed"
  | "resolved"
  | "not_found"
  | "already_submitted"
  | "already_unknown"
  | "already_completed"
  | "already_failed"
  | "operator_resolution_required"
  | "invalid_request"
  | "malformed_state"
  | "ledger_busy"
  | "invalid_transition";

export interface VideoReasoningLedgerDecision {
  decision: VideoReasoningLedgerDecisionKind;
  action: "start" | "retry" | "reuse" | "blocked" | "recorded";
  allowed: boolean;
  requestId: string | null;
  ledgerPath: string;
  reason: string;
  entry?: VideoReasoningLedgerEntry;
  previousStatus?: VideoReasoningLedgerStatus;
}

export class VideoReasoningLedgerStateError extends Error {
  readonly code = "private_state_malformed" as const;

  constructor(message = "private video reasoning ledger state is malformed or unsupported") {
    super(message);
    this.name = "VideoReasoningLedgerStateError";
  }
}

export class VideoReasoningLedgerBusyError extends Error {
  readonly code = "private_state_busy" as const;

  constructor() {
    super("private video reasoning ledger state is busy");
    this.name = "VideoReasoningLedgerBusyError";
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
  if (typeof value !== "string") throw new VideoReasoningLedgerStateError(`invalid ${field}`);
  const normalized = value.trim().toLowerCase().replace(/^sha256:/, "");
  if (!/^[0-9a-f]{64}$/.test(normalized)) throw new VideoReasoningLedgerStateError(`invalid ${field}`);
  return normalized;
}

function normalizeIdentifier(value: unknown, field: string): string {
  if (typeof value !== "string") throw new VideoReasoningLedgerStateError(`invalid ${field}`);
  const normalized = value.normalize("NFC").trim();
  if (!IDENTIFIER_PATTERN.test(normalized) || normalized.includes("..")) {
    throw new VideoReasoningLedgerStateError(`invalid ${field}`);
  }
  return normalized;
}

function normalizeVersion(value: unknown, field: string): string {
  return normalizeIdentifier(value, field);
}

function normalizePrompt(prompt: unknown): string {
  if (typeof prompt !== "string") throw new VideoReasoningLedgerStateError("missing prompt or normalizedPromptHash");
  const normalized = prompt.normalize("NFC")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/g, ""))
    .join("\n")
    .trim();
  if (normalized.length === 0 || Buffer.byteLength(normalized, "utf8") > MAX_PROMPT_BYTES) {
    throw new VideoReasoningLedgerStateError("invalid prompt");
  }
  return normalized;
}

export function normalizeVideoReasoningPrompt(prompt: string): string {
  return normalizePrompt(prompt);
}

export function computeNormalizedPromptHash(prompt: string): string {
  return createHash("sha256").update(normalizePrompt(prompt), "utf8").digest("hex");
}

function normalizeRange(value: unknown): readonly [number, number] {
  if (!Array.isArray(value) || value.length !== 2 ||
      !Number.isSafeInteger(value[0]) || !Number.isSafeInteger(value[1]) ||
      (value[0] as number) < 0 || (value[1] as number) <= (value[0] as number)) {
    throw new VideoReasoningLedgerStateError("invalid effectiveSourceRangeUs");
  }
  return [value[0] as number, value[1] as number];
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") return Object.is(value, -0) ? "0" : String(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  throw new VideoReasoningLedgerStateError("unsupported private JSON value");
}

function hashIdentity(identity: VideoReasoningRequestIdentity): string {
  return `sha256:${createHash("sha256").update(canonicalJson({
    version: VIDEO_REASONING_REQUEST_IDENTITY_VERSION,
    ...identity,
  }), "utf8").digest("hex")}`;
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
      throw new VideoReasoningLedgerStateError(`conflicting ${field} aliases`);
    }
  }
  return first;
}

function normalizeIdentity(input: VideoReasoningRequestIdentityInput): VideoReasoningRequestIdentity {
  if (!isRecord(input as unknown)) throw new VideoReasoningLedgerStateError("invalid request identity");
  const range = selectEqualAlias("source range", [
    input.effectiveSourceRangeUs,
    input.sourceRangeUs,
    input.rangeUs,
  ], normalizeRange);
  const model = selectEqualAlias("model", [
    input.modelAliasOrSnapshot,
    input.model,
    input.modelAlias,
    input.modelSnapshot,
  ], (value) => normalizeIdentifier(value, "modelAliasOrSnapshot"));
  const processing = selectEqualAlias("processing mode", [input.processingMode, input.processing],
    (value) => normalizeIdentifier(value, "processingMode"));
  const promptHash = selectEqualAlias("prompt hash", [input.normalizedPromptHash, input.promptHash],
    (value) => normalizeHash(value, "normalizedPromptHash"));
  const normalizedPromptHash = promptHash === undefined
    ? computeNormalizedPromptHash(normalizePrompt(input.prompt))
    : promptHash;
  if (promptHash !== undefined && input.prompt !== undefined &&
      computeNormalizedPromptHash(input.prompt) !== normalizedPromptHash) {
    throw new VideoReasoningLedgerStateError("prompt does not match normalizedPromptHash");
  }
  return {
    sourceContentSha256: normalizeHash(input.sourceContentSha256, "sourceContentSha256"),
    effectiveSourceRangeUs: normalizeRange(range),
    modelAliasOrSnapshot: model ?? normalizeIdentifier(undefined, "modelAliasOrSnapshot"),
    processingMode: processing ?? normalizeIdentifier(undefined, "processingMode"),
    normalizedPromptHash,
    promptContractVersion: selectEqualAlias("prompt contract version", [
      input.promptContractVersion,
      input.promptContract,
    ], (value) => normalizeVersion(value, "promptContractVersion")) ?? VIDEO_REASONING_PROMPT_CONTRACT_VERSION,
    outputSchemaVersion: selectEqualAlias("output schema version", [
      input.outputSchemaVersion,
      input.outputSchema,
    ], (value) => normalizeVersion(value, "outputSchemaVersion")) ?? VIDEO_REASONING_OUTPUT_SCHEMA_VERSION,
  };
}

export function normalizeVideoReasoningRequestIdentity(
  input: VideoReasoningRequestIdentityInput,
): VideoReasoningRequestIdentity {
  return normalizeIdentity(input);
}

export function computeVideoReasoningRequestIdentity(
  input: VideoReasoningRequestIdentityInput,
): VideoReasoningRequestIdentityWithId {
  const identity = normalizeIdentity(input);
  return { requestId: hashIdentity(identity), ...identity };
}

export function computeVideoReasoningRequestLedgerKey(
  input: VideoReasoningRequestIdentityInput,
): string {
  return computeVideoReasoningRequestIdentity(input).requestId;
}

export const computeAgenticRequestIdentity = computeVideoReasoningRequestIdentity;
export const computeRequestLedgerKey = computeVideoReasoningRequestLedgerKey;

function toIsoTimestamp(value: unknown, field: string): string {
  let date: Date;
  if (value instanceof Date) date = value;
  else if (typeof value === "number") date = new Date(value);
  else if (typeof value === "string") date = new Date(value);
  else throw new VideoReasoningLedgerStateError(`invalid ${field}`);
  if (Number.isNaN(date.getTime())) throw new VideoReasoningLedgerStateError(`invalid ${field}`);
  return date.toISOString();
}

function nowIso(options: VideoReasoningLedgerOptions): string {
  return toIsoTimestamp(options.now?.() ?? Date.now(), "now");
}

function nowMilliseconds(options: VideoReasoningLedgerOptions): number {
  const timestamp = nowIso(options);
  const milliseconds = Date.parse(timestamp);
  if (Number.isNaN(milliseconds)) throw new VideoReasoningLedgerStateError("invalid now");
  return milliseconds;
}

function sanitizeClassification(value: unknown, field: string, required = false): string | undefined {
  if (value === undefined) {
    if (required) throw new VideoReasoningLedgerStateError(`missing ${field}`);
    return undefined;
  }
  if (typeof value !== "string") throw new VideoReasoningLedgerStateError(`invalid ${field}`);
  const normalized = value.normalize("NFC").trim().replace(/[ \t]+/g, " ");
  if (!CLASSIFICATION_PATTERN.test(normalized)) throw new VideoReasoningLedgerStateError(`invalid ${field}`);
  return normalized;
}

function sanitizeActor(value: unknown): string {
  if (typeof value !== "string") throw new VideoReasoningLedgerStateError("invalid operator actor");
  const normalized = value.normalize("NFC").trim();
  if (!ACTOR_PATTERN.test(normalized)) throw new VideoReasoningLedgerStateError("invalid operator actor");
  return normalized;
}

function sanitizeProviderRequestId(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  return normalizeIdentifier(value, "providerRequestId");
}

function sanitizeResultId(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  return normalizeIdentifier(value, "resultId");
}

function normalizeUsage(value: unknown): VideoReasoningLedgerUsage | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value) || !exactKeys(value, [
    "inputTokens", "outputTokens", "thoughtTokens", "toolUseTokens", "totalTokens", "estimatedUsd",
  ])) throw new VideoReasoningLedgerStateError("invalid usage metadata");
  const usage: VideoReasoningLedgerUsage = {};
  for (const key of ["inputTokens", "outputTokens", "thoughtTokens", "toolUseTokens", "totalTokens"] as const) {
    const candidate = value[key];
    if (candidate !== undefined) {
      if (!Number.isSafeInteger(candidate) || (candidate as number) < 0) {
        throw new VideoReasoningLedgerStateError("invalid usage metadata");
      }
      usage[key] = candidate as number;
    }
  }
  if (value.estimatedUsd !== undefined) {
    if (typeof value.estimatedUsd !== "number" || !Number.isFinite(value.estimatedUsd) || value.estimatedUsd < 0) {
      throw new VideoReasoningLedgerStateError("invalid usage metadata");
    }
    usage.estimatedUsd = value.estimatedUsd;
  }
  return Object.keys(usage).length > 0 ? usage : undefined;
}

function normalizeOptionalExpiry(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  return toIsoTimestamp(value, "expiresAt");
}

function baseEntry(
  identity: VideoReasoningRequestIdentityWithId,
  attempt: number,
  now: string,
): VideoReasoningLedgerEntry {
  return {
    requestId: identity.requestId,
    identity: {
      sourceContentSha256: identity.sourceContentSha256,
      effectiveSourceRangeUs: [...identity.effectiveSourceRangeUs] as [number, number],
      modelAliasOrSnapshot: identity.modelAliasOrSnapshot,
      processingMode: identity.processingMode,
      normalizedPromptHash: identity.normalizedPromptHash,
      promptContractVersion: identity.promptContractVersion,
      outputSchemaVersion: identity.outputSchemaVersion,
    },
    attempt,
    status: "reserved",
    outcome: "pending",
    submission: "not_submitted",
    reservation: "active",
    retryable: false,
    reusable: false,
    createdAt: now,
    updatedAt: now,
  };
}

function emptyLedger(): VideoReasoningLedgerDocument {
  return { version: VIDEO_REASONING_LEDGER_VERSION, entries: [] };
}

function validIdentityObject(value: unknown): value is VideoReasoningRequestIdentity {
  if (!isRecord(value) || !exactKeys(value, [
    "sourceContentSha256", "effectiveSourceRangeUs", "modelAliasOrSnapshot", "processingMode",
    "normalizedPromptHash", "promptContractVersion", "outputSchemaVersion",
  ])) return false;
  try {
    const identity = normalizeIdentity(value as unknown as VideoReasoningRequestIdentityInput);
    return canonicalJson(identity) === canonicalJson(value);
  } catch {
    return false;
  }
}

function validOperatorResolution(value: unknown): value is VideoReasoningOperatorResolution {
  if (!isRecord(value) || !exactKeys(value, ["action", "actor", "reason", "resolvedAt"]) ||
      (value.action !== "release_for_retry" && value.action !== "mark_failed" && value.action !== "mark_completed")) return false;
  try {
    sanitizeActor(value.actor);
    sanitizeClassification(value.reason, "operator reason", true);
    toIsoTimestamp(value.resolvedAt, "resolvedAt");
    return true;
  } catch {
    return false;
  }
}

function validEntry(value: unknown): value is VideoReasoningLedgerEntry {
  if (!isRecord(value) || !exactKeys(value, [
    "requestId", "identity", "attempt", "status", "outcome", "submission", "reservation", "retryable",
    "reusable", "createdAt", "updatedAt", "submittedAt", "completedAt", "providerRequestId", "resultId", "failureClass",
    "releaseClass", "usage", "expiresAt", "operatorResolution",
  ])) return false;
  if (typeof value.requestId !== "string" || !REQUEST_ID_PATTERN.test(value.requestId)) return false;
  if (!validIdentityObject(value.identity)) return false;
  try {
    const expectedId = hashIdentity(value.identity);
    if (expectedId !== value.requestId) return false;
  } catch {
    return false;
  }
  if (!Number.isSafeInteger(value.attempt) || (value.attempt as number) < 1) return false;
  if (!["reserved", "submitted", "unknown", "completed", "failed", "released"].includes(value.status as string)) return false;
  if (!["pending", "unknown", "completed", "failed", "released"].includes(value.outcome as string)) return false;
  if (value.submission !== "not_submitted" && value.submission !== "submitted") return false;
  if (value.reservation !== "active" && value.reservation !== "released" && value.reservation !== "none") return false;
  if (typeof value.retryable !== "boolean" || typeof value.reusable !== "boolean") return false;
  try {
    if (toIsoTimestamp(value.createdAt, "createdAt") !== value.createdAt ||
        toIsoTimestamp(value.updatedAt, "updatedAt") !== value.updatedAt) return false;
    if (value.submittedAt !== undefined && toIsoTimestamp(value.submittedAt, "submittedAt") !== value.submittedAt) return false;
    if (value.completedAt !== undefined && toIsoTimestamp(value.completedAt, "completedAt") !== value.completedAt) return false;
    if (value.expiresAt !== undefined && value.expiresAt !== null && toIsoTimestamp(value.expiresAt, "expiresAt") !== value.expiresAt) return false;
    if (value.providerRequestId !== undefined) sanitizeProviderRequestId(value.providerRequestId);
    if (value.resultId !== undefined) sanitizeResultId(value.resultId);
    if (value.failureClass !== undefined) sanitizeClassification(value.failureClass, "failureClass", true);
    if (value.releaseClass !== undefined) sanitizeClassification(value.releaseClass, "releaseClass", true);
    if (value.usage !== undefined) normalizeUsage(value.usage);
    if (value.operatorResolution !== undefined && !validOperatorResolution(value.operatorResolution)) return false;
  } catch {
    return false;
  }

  switch (value.status) {
    case "reserved":
      return value.outcome === "pending" && value.submission === "not_submitted" && value.reservation === "active" &&
        value.retryable === false && value.reusable === false;
    case "submitted":
      return value.outcome === "pending" && value.submission === "submitted" && value.reservation === "active" &&
        value.retryable === false && value.reusable === false && typeof value.submittedAt === "string";
    case "unknown":
      return value.outcome === "unknown" && value.submission === "submitted" && value.reservation === "active" &&
        value.retryable === false && value.reusable === false && typeof value.submittedAt === "string";
    case "completed":
      return value.outcome === "completed" && value.submission === "submitted" && value.reservation === "none" &&
        value.retryable === false && typeof value.completedAt === "string" &&
        (!value.reusable || typeof value.resultId === "string");
    case "failed":
      return value.outcome === "failed" && value.reservation === "none" && value.retryable === true &&
        value.reusable === false && typeof value.failureClass === "string";
    case "released":
      return value.outcome === "released" && value.submission === "not_submitted" && value.reservation === "none" &&
        value.retryable === true && value.reusable === false && typeof value.releaseClass === "string";
  }
  return false;
}

function validLedgerEntries(value: unknown): value is VideoReasoningLedgerEntry[] {
  if (!Array.isArray(value) || value.length > 10_000 || !value.every(validEntry)) return false;
  const byRequest = new Map<string, VideoReasoningLedgerEntry[]>();
  for (const entry of value) {
    const group = byRequest.get(entry.requestId) ?? [];
    group.push(entry);
    byRequest.set(entry.requestId, group);
  }
  for (const group of byRequest.values()) {
    for (let index = 0; index < group.length; index += 1) {
      if (group[index].attempt !== index + 1) return false;
      if (index < group.length - 1 && !["failed", "released"].includes(group[index].status)) return false;
    }
  }
  return true;
}

function readLedgerFile(ledgerPath: string): VideoReasoningLedgerDocument {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(ledgerPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyLedger();
    throw new VideoReasoningLedgerStateError();
  }
  try {
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("ledger is not a regular file");
    const parsed = JSON.parse(fs.readFileSync(ledgerPath, "utf8")) as unknown;
    if (!isRecord(parsed) || !exactKeys(parsed, ["version", "entries"]) ||
        parsed.version !== VIDEO_REASONING_LEDGER_VERSION || !Array.isArray(parsed.entries) ||
        !validLedgerEntries(parsed.entries)) {
      throw new Error("unsupported ledger document");
    }
    const entries = parsed.entries as VideoReasoningLedgerEntry[];
    return { version: VIDEO_REASONING_LEDGER_VERSION, entries };
  } catch (error) {
    if (error instanceof VideoReasoningLedgerStateError) throw error;
    throw new VideoReasoningLedgerStateError();
  }
}

function ledgerPathFor(projectDir: string): string {
  const resolved = path.resolve(projectDir);
  if (path.extname(resolved).toLowerCase() === ".json") {
    throw new VideoReasoningLedgerStateError("ledger path helper requires a project root");
  }
  return path.resolve(resolved, AGENTIC_REQUEST_LEDGER_RELATIVE_PATH);
}

function ensurePrivateDirectory(ledgerPath: string): void {
  const dir = path.dirname(ledgerPath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(dir, 0o700); } catch { /* best effort */ }
}

function fsyncDirectory(dir: string): void {
  try {
    const fd = fs.openSync(dir, "r");
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  } catch {
    // Some filesystems do not expose a directory fsync; the file is fsynced.
  }
}

function atomicWriteLedger(ledgerPath: string, document: VideoReasoningLedgerDocument): void {
  ensurePrivateDirectory(ledgerPath);
  const tempPath = `${ledgerPath}.tmp-${process.pid}-${randomUUID()}`;
  let fd: number | undefined;
  try {
    fd = fs.openSync(tempPath, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
    fs.writeFileSync(fd, `${JSON.stringify(document, null, 2)}\n`, "utf8");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(tempPath, ledgerPath);
    try { fs.chmodSync(ledgerPath, 0o600); } catch { /* best effort */ }
    fsyncDirectory(path.dirname(ledgerPath));
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* cleanup only */ }
    }
    try { fs.unlinkSync(tempPath); } catch { /* rename already removed it */ }
  }
}

function withLedgerLock<T>(ledgerPath: string, action: () => T): T {
  ensurePrivateDirectory(ledgerPath);
  const lockPath = `${ledgerPath}.lock`;
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
      if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new VideoReasoningLedgerBusyError();
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

function isExactLedgerPath(filePath: string): boolean {
  return path.basename(filePath) === "agentic-request-ledger.json" &&
    path.basename(path.dirname(filePath)) === "private-cache" &&
    path.basename(path.dirname(path.dirname(filePath))) === ".video-os";
}

function resolvePath(projectDirOrPath: string): string {
  const resolved = path.resolve(projectDirOrPath);
  if (path.extname(resolved).toLowerCase() === ".json") {
    if (!isExactLedgerPath(resolved)) {
      throw new VideoReasoningLedgerStateError("ledger APIs require a project root or exact private ledger path");
    }
    return resolved;
  }
  return ledgerPathFor(resolved);
}

function resolveRequestId(reference: VideoReasoningRequestReference): string {
  if (typeof reference === "string") {
    const normalized = reference.trim().toLowerCase();
    const requestId = normalized.startsWith("sha256:") ? normalized : `sha256:${normalized}`;
    if (!REQUEST_ID_PATTERN.test(requestId)) throw new VideoReasoningLedgerStateError("invalid requestId");
    return requestId;
  }
  if (isRecord(reference) && typeof reference.requestId === "string") {
    return resolveRequestId(reference.requestId);
  }
  return computeVideoReasoningRequestIdentity(reference).requestId;
}

function latestEntry(document: VideoReasoningLedgerDocument, requestId: string): VideoReasoningLedgerEntry | undefined {
  for (let index = document.entries.length - 1; index >= 0; index -= 1) {
    if (document.entries[index].requestId === requestId) return document.entries[index];
  }
  return undefined;
}

function entryDecision(
  ledgerPath: string,
  requestId: string,
  entry: VideoReasoningLedgerEntry | undefined,
  now: number,
): VideoReasoningLedgerDecision {
  if (!entry) return {
    decision: "available",
    action: "start",
    allowed: true,
    requestId,
    ledgerPath,
    reason: "no_prior_request",
  };
  switch (entry.status) {
    case "reserved":
      return { decision: "duplicate_active", action: "blocked", allowed: false, requestId, ledgerPath, reason: "active_reservation", entry };
    case "submitted":
      return { decision: "duplicate_submitted", action: "blocked", allowed: false, requestId, ledgerPath, reason: "request_submitted", entry };
    case "unknown":
      return { decision: "duplicate_unknown", action: "blocked", allowed: false, requestId, ledgerPath, reason: "unknown_post_submit_outcome", entry };
    case "completed":
      {
        const expiry = entry.expiresAt === undefined || entry.expiresAt === null
          ? undefined
          : Date.parse(entry.expiresAt);
        const reusable = entry.reusable && entry.resultId !== undefined &&
          (expiry === undefined || (!Number.isNaN(expiry) && expiry > now));
        return {
          decision: "duplicate_completed",
          action: reusable ? "reuse" : "blocked",
          allowed: false,
          requestId,
          ledgerPath,
          reason: reusable ? "completed_reusable" : "completed_not_reusable",
          entry,
        };
      }
    case "failed":
      return { decision: "retry_allowed", action: "retry", allowed: true, requestId, ledgerPath, reason: "known_failure", entry, previousStatus: entry.status };
    case "released":
      return { decision: "retry_allowed", action: "retry", allowed: true, requestId, ledgerPath, reason: "proven_pre_submit_release", entry, previousStatus: entry.status };
  }
}

function invalidDecision(ledgerPath: string, reason: string, requestId: string | null = null): VideoReasoningLedgerDecision {
  return { decision: "invalid_request", action: "blocked", allowed: false, requestId, ledgerPath, reason };
}

function safeInspect(
  ledgerPath: string,
  reference: VideoReasoningRequestReference,
  options: VideoReasoningLedgerOptions = {},
): VideoReasoningLedgerDecision {
  let requestId: string;
  try { requestId = resolveRequestId(reference); } catch { return invalidDecision(ledgerPath, "invalid_request"); }
  try {
    return entryDecision(ledgerPath, requestId, latestEntry(readLedgerFile(ledgerPath), requestId), nowMilliseconds(options));
  } catch {
    return { decision: "malformed_state", action: "blocked", allowed: false, requestId, ledgerPath, reason: "private_state_malformed" };
  }
}

function transitionResult(
  ledgerPath: string,
  decision: VideoReasoningLedgerDecisionKind,
  reason: string,
  requestId: string | null,
  entry?: VideoReasoningLedgerEntry,
  previousStatus?: VideoReasoningLedgerStatus,
): VideoReasoningLedgerDecision {
  return {
    decision,
    action: "recorded",
    allowed: decision === "submitted" || decision === "unknown_recorded" || decision === "completed" ||
      decision === "failed" || decision === "released" || decision === "resolved",
    requestId,
    ledgerPath,
    reason,
    ...(entry ? { entry } : {}),
    ...(previousStatus ? { previousStatus } : {}),
  };
}

function mutateEntry(
  ledgerPath: string,
  reference: VideoReasoningRequestReference,
  expected: readonly VideoReasoningLedgerStatus[],
  mutate: (entry: VideoReasoningLedgerEntry, now: string) => VideoReasoningLedgerEntry,
  options: VideoReasoningLedgerOptions,
  invalidReason = "invalid_transition",
): VideoReasoningLedgerDecision {
  let requestId: string;
  try { requestId = resolveRequestId(reference); } catch { return invalidDecision(ledgerPath, "invalid_request"); }
  try {
    return withLedgerLock(ledgerPath, () => {
      const document = readLedgerFile(ledgerPath);
      const current = latestEntry(document, requestId);
      if (!current) return transitionResult(ledgerPath, "not_found", "request_not_found", requestId);
      if (!expected.includes(current.status)) {
        if (current.status === "unknown" && expected.some((status) => status === "submitted" || status === "reserved")) {
          return transitionResult(ledgerPath, "operator_resolution_required", "unknown_requires_operator_resolution", requestId, current, current.status);
        }
        return transitionResult(ledgerPath, "invalid_transition", invalidReason, requestId, current, current.status);
      }
      const updated = mutate(current, nowIso(options));
      const nextEntries = document.entries.map((entry) => entry === current ? updated : entry);
      const nextDocument = { version: VIDEO_REASONING_LEDGER_VERSION, entries: nextEntries } satisfies VideoReasoningLedgerDocument;
      atomicWriteLedger(ledgerPath, nextDocument);
      return transitionResult(ledgerPath, updated.status === "unknown" ? "unknown_recorded" : updated.status, "state_recorded", requestId, updated, current.status);
    });
  } catch (error) {
    if (error instanceof VideoReasoningLedgerBusyError) {
      return { decision: "ledger_busy", action: "blocked", allowed: false, requestId, ledgerPath, reason: "private_state_busy" };
    }
    if (error instanceof VideoReasoningLedgerStateError) {
      return { decision: "malformed_state", action: "blocked", allowed: false, requestId, ledgerPath, reason: "private_state_malformed" };
    }
    throw error;
  }
}

function makeTransitionMetadata(metadata: VideoReasoningLedgerTransitionMetadata = {}): {
  providerRequestId?: string;
  resultId?: string;
  failureClass?: string;
  releaseClass?: string;
  usage?: VideoReasoningLedgerUsage;
  expiresAt?: string | null;
  reusable?: boolean;
} {
  const providerRequestId = sanitizeProviderRequestId(metadata.providerRequestId);
  const resultId = selectEqualAlias("result identity", [metadata.resultId, metadata.resultIdentity], sanitizeResultId);
  const failureClass = sanitizeClassification(metadata.failureClass, "failureClass");
  const releaseClass = sanitizeClassification(metadata.releaseClass, "releaseClass");
  const usage = normalizeUsage(metadata.usage);
  const expiresAt = normalizeOptionalExpiry(metadata.expiresAt);
  if (metadata.reusable !== undefined && typeof metadata.reusable !== "boolean") {
    throw new VideoReasoningLedgerStateError("invalid reusable");
  }
  if (metadata.reusable === true && resultId === undefined) {
    throw new VideoReasoningLedgerStateError("reusable completion requires a bounded result identity");
  }
  return {
    ...(providerRequestId ? { providerRequestId } : {}),
    ...(resultId ? { resultId } : {}),
    ...(failureClass ? { failureClass } : {}),
    ...(releaseClass ? { releaseClass } : {}),
    ...(usage ? { usage } : {}),
    ...(expiresAt !== undefined ? { expiresAt } : {}),
    ...(metadata.reusable !== undefined ? { reusable: metadata.reusable } : {}),
  };
}

function reserveAtPath(
  ledgerPath: string,
  input: VideoReasoningRequestIdentityInput,
  options: VideoReasoningLedgerOptions,
): VideoReasoningLedgerDecision {
  let identity: VideoReasoningRequestIdentityWithId;
  try { identity = computeVideoReasoningRequestIdentity(input); } catch { return invalidDecision(ledgerPath, "invalid_request"); }
  try {
    return withLedgerLock(ledgerPath, () => {
      const document = readLedgerFile(ledgerPath);
      const current = latestEntry(document, identity.requestId);
      const now = nowIso(options);
      const priorDecision = entryDecision(ledgerPath, identity.requestId, current, Date.parse(now));
      if (current && !["failed", "released"].includes(current.status)) return priorDecision;
      const attempt = current ? current.attempt + 1 : 1;
      const entry = baseEntry(identity, attempt, now);
      const nextDocument: VideoReasoningLedgerDocument = {
        version: VIDEO_REASONING_LEDGER_VERSION,
        entries: [...document.entries, entry],
      };
      atomicWriteLedger(ledgerPath, nextDocument);
      return {
        decision: current ? "retry_reserved" : "reserved",
        action: current ? "retry" : "start",
        allowed: true,
        requestId: identity.requestId,
        ledgerPath,
        reason: current ? current.status === "released" ? "proven_pre_submit_release" : "prior_known_failure" : "new_request",
        entry,
        ...(current ? { previousStatus: current.status } : {}),
      } satisfies VideoReasoningLedgerDecision;
    });
  } catch (error) {
    if (error instanceof VideoReasoningLedgerBusyError) {
      return { decision: "ledger_busy", action: "blocked", allowed: false, requestId: identity.requestId, ledgerPath, reason: "private_state_busy" };
    }
    if (error instanceof VideoReasoningLedgerStateError) {
      return { decision: "malformed_state", action: "blocked", allowed: false, requestId: identity.requestId, ledgerPath, reason: "private_state_malformed" };
    }
    throw error;
  }
}

export function videoReasoningLedgerPath(projectDir: string): string {
  return ledgerPathFor(projectDir);
}

export const getVideoReasoningLedgerPath = videoReasoningLedgerPath;

export function loadVideoReasoningLedger(projectDirOrPath: string): VideoReasoningLedgerDocument {
  return readLedgerFile(resolvePath(projectDirOrPath));
}

export function inspectVideoReasoningRequest(
  projectDirOrPath: string,
  reference: VideoReasoningRequestReference,
  options: VideoReasoningLedgerOptions = {},
): VideoReasoningLedgerDecision {
  return safeInspect(resolvePath(projectDirOrPath), reference, options);
}

export function reserveVideoReasoningRequest(
  projectDirOrPath: string,
  input: VideoReasoningRequestIdentityInput,
  options: VideoReasoningLedgerOptions = {},
): VideoReasoningLedgerDecision {
  return reserveAtPath(resolvePath(projectDirOrPath), input, options);
}

export function recordVideoReasoningSubmitted(
  projectDirOrPath: string,
  reference: VideoReasoningRequestReference,
  metadata: Pick<VideoReasoningLedgerTransitionMetadata, "providerRequestId"> = {},
  options: VideoReasoningLedgerOptions = {},
): VideoReasoningLedgerDecision {
  let safeMetadata: ReturnType<typeof makeTransitionMetadata>;
  try { safeMetadata = makeTransitionMetadata(metadata); } catch { return invalidDecision(resolvePath(projectDirOrPath), "invalid_metadata"); }
  const ledgerPath = resolvePath(projectDirOrPath);
  return mutateEntry(ledgerPath, reference, ["reserved"], (entry, now) => ({
    ...entry,
    status: "submitted",
    submission: "submitted",
    submittedAt: now,
    updatedAt: now,
    ...(safeMetadata.providerRequestId ? { providerRequestId: safeMetadata.providerRequestId } : {}),
  }), options, "request_not_reserved");
}

export function recordVideoReasoningPreSubmitRelease(
  projectDirOrPath: string,
  reference: VideoReasoningRequestReference,
  releaseClass = "proven_pre_submit_release",
  options: VideoReasoningLedgerOptions = {},
): VideoReasoningLedgerDecision {
  const ledgerPath = resolvePath(projectDirOrPath);
  let safeReleaseClass: string;
  try { safeReleaseClass = sanitizeClassification(releaseClass, "releaseClass", true)!; } catch { return invalidDecision(ledgerPath, "invalid_release_class"); }
  return mutateEntry(ledgerPath, reference, ["reserved"], (entry, now) => ({
    ...entry,
    status: "released",
    outcome: "released",
    submission: "not_submitted",
    reservation: "none",
    retryable: true,
    updatedAt: now,
    releaseClass: safeReleaseClass,
  }), options, "release_requires_proven_not_submitted");
}

export function recordVideoReasoningUnknownPostSubmit(
  projectDirOrPath: string,
  reference: VideoReasoningRequestReference,
  options: VideoReasoningLedgerOptions = {},
): VideoReasoningLedgerDecision {
  const ledgerPath = resolvePath(projectDirOrPath);
  return mutateEntry(ledgerPath, reference, ["submitted"], (entry, now) => ({
    ...entry,
    status: "unknown",
    outcome: "unknown",
    reservation: "active",
    retryable: false,
    reusable: false,
    updatedAt: now,
  }), options, "unknown_requires_submitted_request");
}

export function recordVideoReasoningCompleted(
  projectDirOrPath: string,
  reference: VideoReasoningRequestReference,
  metadata: VideoReasoningLedgerTransitionMetadata = {},
  options: VideoReasoningLedgerOptions = {},
): VideoReasoningLedgerDecision {
  let safeMetadata: ReturnType<typeof makeTransitionMetadata>;
  try { safeMetadata = makeTransitionMetadata(metadata); } catch { return invalidDecision(resolvePath(projectDirOrPath), "invalid_metadata"); }
  const ledgerPath = resolvePath(projectDirOrPath);
  return mutateEntry(ledgerPath, reference, ["submitted"], (entry, now) => ({
    ...entry,
    status: "completed",
    outcome: "completed",
    reservation: "none",
    retryable: false,
    reusable: safeMetadata.reusable ?? safeMetadata.resultId !== undefined,
    updatedAt: now,
    completedAt: now,
    ...(safeMetadata.providerRequestId ? { providerRequestId: safeMetadata.providerRequestId } : {}),
    ...(safeMetadata.resultId ? { resultId: safeMetadata.resultId } : {}),
    ...(safeMetadata.usage ? { usage: safeMetadata.usage } : {}),
    ...(safeMetadata.expiresAt !== undefined ? { expiresAt: safeMetadata.expiresAt } : {}),
  }), options, "complete_requires_submitted_request");
}

export function recordVideoReasoningFailed(
  projectDirOrPath: string,
  reference: VideoReasoningRequestReference,
  failureClass = "known_failure",
  metadata: Pick<VideoReasoningLedgerTransitionMetadata, "providerRequestId" | "usage"> = {},
  options: VideoReasoningLedgerOptions = {},
): VideoReasoningLedgerDecision {
  let safeClass: string;
  let safeMetadata: ReturnType<typeof makeTransitionMetadata>;
  try {
    safeClass = sanitizeClassification(failureClass, "failureClass", true)!;
    safeMetadata = makeTransitionMetadata({ ...metadata, failureClass: safeClass });
  } catch { return invalidDecision(resolvePath(projectDirOrPath), "invalid_failure_class"); }
  const ledgerPath = resolvePath(projectDirOrPath);
  return mutateEntry(ledgerPath, reference, ["reserved", "submitted"], (entry, now) => ({
    ...entry,
    status: "failed",
    outcome: "failed",
    reservation: "none",
    retryable: true,
    reusable: false,
    updatedAt: now,
    failureClass: safeClass,
    ...(safeMetadata.providerRequestId ? { providerRequestId: safeMetadata.providerRequestId } : {}),
    ...(safeMetadata.usage ? { usage: safeMetadata.usage } : {}),
  }), options, "fail_requires_known_request_outcome");
}

export function resolveVideoReasoningUnknown(
  projectDirOrPath: string,
  reference: VideoReasoningRequestReference,
  resolution: VideoReasoningOperatorResolutionInput,
  options: VideoReasoningLedgerOptions = {},
): VideoReasoningLedgerDecision {
  const ledgerPath = resolvePath(projectDirOrPath);
  let safeResolution: VideoReasoningOperatorResolution;
  let safeCompletionMetadata: ReturnType<typeof makeTransitionMetadata> = {};
  try {
    if (resolution.action !== "release_for_retry" && resolution.action !== "mark_failed" && resolution.action !== "mark_completed") {
      throw new Error("invalid action");
    }
    if (resolution.action === "mark_completed") {
      safeCompletionMetadata = makeTransitionMetadata({
        providerRequestId: resolution.providerRequestId,
        resultId: resolution.resultId,
        resultIdentity: resolution.resultIdentity,
        usage: resolution.usage,
        expiresAt: resolution.expiresAt,
        reusable: resolution.reusable,
      });
    } else if (resolution.resultId !== undefined || resolution.resultIdentity !== undefined ||
        resolution.reusable !== undefined || resolution.providerRequestId !== undefined ||
        resolution.usage !== undefined || resolution.expiresAt !== undefined) {
      throw new Error("completion metadata is only valid for mark_completed");
    }
    safeResolution = {
      action: resolution.action,
      actor: sanitizeActor(resolution.actor),
      reason: sanitizeClassification(resolution.reason, "operator reason", true)!,
      resolvedAt: nowIso(options),
    };
  } catch { return invalidDecision(ledgerPath, "invalid_operator_resolution"); }
  const result = mutateEntry(ledgerPath, reference, ["unknown"], (entry, now) => {
    if (safeResolution.action === "release_for_retry") {
      return {
        ...entry,
        status: "released",
        outcome: "released",
        submission: "not_submitted",
        reservation: "none",
        retryable: true,
        reusable: false,
        updatedAt: now,
        releaseClass: "operator_resolved_for_retry",
        operatorResolution: safeResolution,
      };
    }
    if (safeResolution.action === "mark_failed") {
      return {
        ...entry,
        status: "failed",
        outcome: "failed",
        reservation: "none",
        retryable: true,
        reusable: false,
        updatedAt: now,
        failureClass: "operator_resolved_failure",
        operatorResolution: safeResolution,
      };
    }
    return {
      ...entry,
      status: "completed",
      outcome: "completed",
      reservation: "none",
      retryable: false,
      reusable: safeCompletionMetadata.reusable ?? safeCompletionMetadata.resultId !== undefined,
      updatedAt: now,
      completedAt: now,
      ...(safeCompletionMetadata.providerRequestId ? { providerRequestId: safeCompletionMetadata.providerRequestId } : {}),
      ...(safeCompletionMetadata.resultId ? { resultId: safeCompletionMetadata.resultId } : {}),
      ...(safeCompletionMetadata.usage ? { usage: safeCompletionMetadata.usage } : {}),
      ...(safeCompletionMetadata.expiresAt !== undefined ? { expiresAt: safeCompletionMetadata.expiresAt } : {}),
      operatorResolution: safeResolution,
    };
  }, options, "operator_resolution_required");
  if (result.decision === "released" || result.decision === "failed" || result.decision === "completed") {
    return { ...result, decision: "resolved" };
  }
  return result;
}

export const releaseVideoReasoningBeforeSubmit = recordVideoReasoningPreSubmitRelease;
export const markVideoReasoningUnknown = recordVideoReasoningUnknownPostSubmit;
export const completeVideoReasoningRequest = recordVideoReasoningCompleted;
export const failVideoReasoningRequest = recordVideoReasoningFailed;
export const resolveUnknownVideoReasoningRequest = resolveVideoReasoningUnknown;

export class VideoReasoningRequestLedger {
  readonly path: string;
  private readonly options: VideoReasoningLedgerOptions;

  constructor(projectDir: string, options: VideoReasoningLedgerOptions = {}) {
    this.path = ledgerPathFor(projectDir);
    this.options = options;
  }

  load(): VideoReasoningLedgerDocument { return readLedgerFile(this.path); }

  inspect(reference: VideoReasoningRequestReference): VideoReasoningLedgerDecision {
    return safeInspect(this.path, reference, this.options);
  }

  reserve(input: VideoReasoningRequestIdentityInput): VideoReasoningLedgerDecision {
    return reserveAtPath(this.path, input, this.options);
  }

  recordSubmitted(reference: VideoReasoningRequestReference, metadata: Pick<VideoReasoningLedgerTransitionMetadata, "providerRequestId"> = {}): VideoReasoningLedgerDecision {
    return recordVideoReasoningSubmitted(this.path, reference, metadata, this.options);
  }

  releaseBeforeSubmit(reference: VideoReasoningRequestReference, releaseClass?: string): VideoReasoningLedgerDecision {
    return recordVideoReasoningPreSubmitRelease(this.path, reference, releaseClass, this.options);
  }

  recordUnknownPostSubmit(reference: VideoReasoningRequestReference): VideoReasoningLedgerDecision {
    return recordVideoReasoningUnknownPostSubmit(this.path, reference, this.options);
  }

  complete(reference: VideoReasoningRequestReference, metadata: VideoReasoningLedgerTransitionMetadata = {}): VideoReasoningLedgerDecision {
    return recordVideoReasoningCompleted(this.path, reference, metadata, this.options);
  }

  fail(reference: VideoReasoningRequestReference, failureClass?: string, metadata: Pick<VideoReasoningLedgerTransitionMetadata, "providerRequestId" | "usage"> = {}): VideoReasoningLedgerDecision {
    return recordVideoReasoningFailed(this.path, reference, failureClass, metadata, this.options);
  }

  resolveUnknown(reference: VideoReasoningRequestReference, resolution: VideoReasoningOperatorResolutionInput): VideoReasoningLedgerDecision {
    return resolveVideoReasoningUnknown(this.path, reference, resolution, this.options);
  }
}

export class VideoReasoningLedger extends VideoReasoningRequestLedger {}

export const createVideoReasoningRequestLedger = (
  projectDir: string,
  options: VideoReasoningLedgerOptions = {},
): VideoReasoningRequestLedger => new VideoReasoningRequestLedger(projectDir, options);

export const createVideoReasoningLedger = createVideoReasoningRequestLedger;
