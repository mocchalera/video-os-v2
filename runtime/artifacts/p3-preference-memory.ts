import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { normalizeJsonValue } from "./p1-manifest-coverage.js";

export const EDITORIAL_PREFERENCE_MEMORY_CANONICAL_REL_PATH = "00_project/editorial_preference_memory.jsonl";
export const EDITORIAL_PREFERENCE_MEMORY_LEGACY_REL_PATH = "03_analysis/editorial_preference_memory.jsonl";

export type PreferenceType =
  | "pacing"
  | "chronology"
  | "transition_style"
  | "repetition_tolerance"
  | "bgm_loudness"
  | "caption_density"
  | "override_rationale"
  | "delivery_preference"
  | "redaction";

export interface EditorialPreferenceMemoryEntry {
  version: string;
  project_id: string;
  entry_id: string;
  created_at: string;
  actor: { type: "human" | "runtime_command" | "import_premiere" | "package_preflight"; id: string };
  source_event: {
    event_type: "operator_command" | "blueprint_acceptance" | "review_patch_acceptance" | "review_patch_rejection" | "premiere_import" | "package_approval" | "redaction";
    event_ref: string;
  };
  preference_type: PreferenceType;
  value: { kind: "string" | "number" | "boolean" | "enum" | "json"; data: unknown };
  scope: "project" | "series" | "profile" | "delivery" | "temporary";
  scope_ref?: string;
  confidence: { score: number; source: string; status: string; label?: string };
  status: "active" | "superseded" | "rejected" | "expired" | "redacted";
  supersedes_entry_id?: string | null;
  expires_at?: string | null;
  provenance: {
    producer: "operator-command" | "blueprint" | "review" | "import-premiere" | "package";
    inputs: Array<Record<string, unknown>>;
    hash_policy: Record<string, unknown>;
  };
}

export type WritablePreferenceType = Exclude<PreferenceType, "override_rationale" | "redaction">;
export type WritablePreferenceScope = "project" | "series" | "profile";
export type PrimitivePreferenceValue =
  | { kind: "string" | "enum"; data: string }
  | { kind: "number"; data: number }
  | { kind: "boolean"; data: boolean };

export interface RememberEditorialPreferenceInput {
  projectDir: string;
  projectId: string;
  actionId: string;
  actorId: string;
  sourceEvent: "blueprint_acceptance" | "review_patch_acceptance" | "review_patch_rejection";
  sourceArtifactPath: string;
  preferenceType: WritablePreferenceType;
  value: PrimitivePreferenceValue;
  scope: WritablePreferenceScope;
  scopeRef: string;
  supersedesEntryId?: string;
  createdAt?: string;
}

export interface RedactEditorialPreferenceInput {
  projectDir: string;
  projectId: string;
  actionId: string;
  actorId: string;
  targetEntryId: string;
  reason: string;
  createdAt?: string;
}

export interface PreferenceWriteOptions {
  lockTimeoutMs?: number;
  lockRetryMs?: number;
  fsOps?: {
    initializeLock?: (descriptor: number, lockPath: string) => void;
    beforePromote?: (temporaryPath: string, canonicalPath: string) => void;
    writeFileSync?: typeof fs.writeFileSync;
    renameSync?: typeof fs.renameSync;
  };
}

export interface PreferenceWriteResult {
  status: "appended" | "idempotent";
  entry: EditorialPreferenceMemoryEntry;
  path: string;
  consumedOffset: number;
  consumedHash: string;
}

export interface PreferenceEntryRecord {
  entry: EditorialPreferenceMemoryEntry;
  lineNumber: number;
  byteOffset: number;
}

export interface MalformedPreferenceLine {
  lineNumber: number;
  byteOffset: number;
  raw: string;
  error: string;
}

export interface ReadPreferenceEntriesOptions {
  validateEntry?: (entry: unknown) => boolean;
}

export interface PreferenceReadResult {
  entries: PreferenceEntryRecord[];
  malformedLines: MalformedPreferenceLine[];
  lastKnownGoodOffset: number;
}

export interface PreferenceConsumedReadResult extends PreferenceReadResult {
  errorsInConsumed: MalformedPreferenceLine[];
  warningsAfterConsumed: MalformedPreferenceLine[];
}

export interface PreferenceMemoryResolution {
  source: "canonical" | "legacy" | "absent";
  path: string;
  relativePath: string;
  canonicalPath: string;
  legacyPath: string;
  canonicalExists: boolean;
  legacyExists: boolean;
}

export interface ResolvedPreferenceReadResult extends PreferenceReadResult {
  resolution: PreferenceMemoryResolution;
}

export type PreferenceMemoryMigrationResult =
  | { status: "migrated"; canonicalPath: string; legacyPath: string; entryCount: number }
  | { status: "noop"; reason: "already_migrated" | "no_legacy"; canonicalPath: string; legacyPath: string; entryCount: number }
  | { status: "conflict"; reason: "canonical_content_differs"; canonicalPath: string; legacyPath: string }
  | { status: "rejected"; reason: "malformed" | "schema_invalid" | "project_mismatch"; canonicalPath: string; legacyPath: string; errors: string[] };

export function canonicalPreferenceMemoryPath(projectDir: string): string {
  return path.join(path.resolve(projectDir), EDITORIAL_PREFERENCE_MEMORY_CANONICAL_REL_PATH);
}

export function resolvePreferenceMemoryPath(projectDir: string): PreferenceMemoryResolution {
  const root = path.resolve(projectDir);
  const canonicalPath = path.join(root, EDITORIAL_PREFERENCE_MEMORY_CANONICAL_REL_PATH);
  const legacyPath = path.join(root, EDITORIAL_PREFERENCE_MEMORY_LEGACY_REL_PATH);
  const canonicalExists = fs.existsSync(canonicalPath);
  const legacyExists = fs.existsSync(legacyPath);
  if (canonicalExists) {
    return {
      source: "canonical",
      path: canonicalPath,
      relativePath: EDITORIAL_PREFERENCE_MEMORY_CANONICAL_REL_PATH,
      canonicalPath,
      legacyPath,
      canonicalExists,
      legacyExists,
    };
  }
  if (legacyExists) {
    return {
      source: "legacy",
      path: legacyPath,
      relativePath: EDITORIAL_PREFERENCE_MEMORY_LEGACY_REL_PATH,
      canonicalPath,
      legacyPath,
      canonicalExists,
      legacyExists,
    };
  }
  return {
    source: "absent",
    path: canonicalPath,
    relativePath: EDITORIAL_PREFERENCE_MEMORY_CANONICAL_REL_PATH,
    canonicalPath,
    legacyPath,
    canonicalExists,
    legacyExists,
  };
}

export function validatePreferenceMemoryEntry(entry: unknown): boolean {
  return preferenceMemorySchemaValidator()(entry);
}

let cachedPreferenceMemoryValidator: ((entry: unknown) => boolean) | undefined;
const cachedSourceArtifactValidators = new Map<string, (entry: unknown) => boolean>();

function preferenceMemorySchemaValidator(): (entry: unknown) => boolean {
  if (cachedPreferenceMemoryValidator) return cachedPreferenceMemoryValidator;
  const require = createRequire(import.meta.url);
  const Ajv2020 = require("ajv/dist/2020") as new (options: Record<string, unknown>) => {
    addSchema(schema: object): void;
    compile(schema: object): (entry: unknown) => boolean;
  };
  const addFormats = require("ajv-formats") as (ajv: unknown) => void;
  const schemaCandidates = [
    fileURLToPath(new URL("../../schemas/", import.meta.url)),
    fileURLToPath(new URL("../../../schemas/", import.meta.url)),
  ];
  const schemasDir = schemaCandidates.find((candidate) =>
    fs.existsSync(path.join(candidate, "editorial-preference-memory-entry.schema.json"))
  );
  if (!schemasDir) throw new Error("editorial preference memory schemas not found");
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  ajv.addSchema(JSON.parse(fs.readFileSync(path.join(schemasDir, "analysis-common.schema.json"), "utf-8")) as object);
  cachedPreferenceMemoryValidator = ajv.compile(
    JSON.parse(fs.readFileSync(path.join(schemasDir, "editorial-preference-memory-entry.schema.json"), "utf-8")) as object,
  );
  return cachedPreferenceMemoryValidator;
}

function sourceArtifactSchemaValidator(schemaFile: string): (entry: unknown) => boolean {
  const cached = cachedSourceArtifactValidators.get(schemaFile);
  if (cached) return cached;
  const require = createRequire(import.meta.url);
  const Ajv2020 = require("ajv/dist/2020") as new (options: Record<string, unknown>) => {
    compile(schema: object): (entry: unknown) => boolean;
  };
  const addFormats = require("ajv-formats") as (ajv: unknown) => void;
  const schemasDir = [
    fileURLToPath(new URL("../../schemas/", import.meta.url)),
    fileURLToPath(new URL("../../../schemas/", import.meta.url)),
  ].find((candidate) => fs.existsSync(path.join(candidate, schemaFile)));
  if (!schemasDir) throw new Error(`source artifact schema not found: ${schemaFile}`);
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  const validator = ajv.compile(JSON.parse(fs.readFileSync(path.join(schemasDir, schemaFile), "utf-8")) as object);
  cachedSourceArtifactValidators.set(schemaFile, validator);
  return validator;
}

export function readResolvedPreferenceEntries(
  projectDir: string,
  expectedProjectId?: string,
): ResolvedPreferenceReadResult {
  const resolution = resolvePreferenceMemoryPath(projectDir);
  const read = readPreferenceEntries(resolution.path, { validateEntry: validatePreferenceMemoryEntry });
  if (expectedProjectId === undefined) return { ...read, resolution };
  const mismatched = read.entries.filter(({ entry }) => entry.project_id !== expectedProjectId);
  const entries = read.entries.filter(({ entry }) => entry.project_id === expectedProjectId);
  const rawLines = resolution.source === "absent"
    ? []
    : fs.readFileSync(resolution.path, "utf-8").split("\n");
  const lastKnownGoodOffset = entries.reduce((offset, entry) => {
    const line = rawLines[entry.lineNumber - 1] ?? "";
    const hasTerminator = entry.lineNumber - 1 < rawLines.length - 1;
    return Math.max(offset, entry.byteOffset + Buffer.byteLength(line + (hasTerminator ? "\n" : ""), "utf-8"));
  }, 0);
  return {
    ...read,
    entries,
    malformedLines: [
      ...read.malformedLines,
      ...mismatched.map(({ entry, lineNumber, byteOffset }) => ({
        lineNumber,
        byteOffset,
        raw: rawLines[lineNumber - 1] ?? "",
        error: `project_id ${entry.project_id} does not match ${expectedProjectId}`,
      })),
    ].sort((left, right) => left.lineNumber - right.lineNumber),
    lastKnownGoodOffset,
    resolution,
  };
}

export function migrateLegacyPreferenceMemory(
  projectDir: string,
  expectedProjectId: string,
  options: {
    fsOps?: {
      beforePromote?: () => void;
      linkSync?: typeof fs.linkSync;
    };
  } = {},
): PreferenceMemoryMigrationResult {
  const resolution = resolvePreferenceMemoryPath(projectDir);
  if (!resolution.legacyExists) {
    const canonical = resolution.canonicalExists
      ? validateMigrationSource(resolution.canonicalPath, expectedProjectId)
      : { valid: true as const, entries: [] };
    if (!canonical.valid) {
      return {
        status: "rejected",
        reason: canonical.reason,
        canonicalPath: resolution.canonicalPath,
        legacyPath: resolution.legacyPath,
        errors: canonical.errors,
      };
    }
    return {
      status: "noop",
      reason: "no_legacy",
      canonicalPath: resolution.canonicalPath,
      legacyPath: resolution.legacyPath,
      entryCount: canonical.entries.length,
    };
  }

  const legacy = validateMigrationSource(resolution.legacyPath, expectedProjectId);
  if (!legacy.valid) {
    return {
      status: "rejected",
      reason: legacy.reason,
      canonicalPath: resolution.canonicalPath,
      legacyPath: resolution.legacyPath,
      errors: legacy.errors,
    };
  }
  const normalizedLegacy = normalizePreferenceJsonl(legacy.entries);

  if (resolution.canonicalExists) {
    const canonical = validateMigrationSource(resolution.canonicalPath, expectedProjectId);
    if (!canonical.valid) {
      return {
        status: "rejected",
        reason: canonical.reason,
        canonicalPath: resolution.canonicalPath,
        legacyPath: resolution.legacyPath,
        errors: canonical.errors,
      };
    }
    if (normalizePreferenceJsonl(canonical.entries) !== normalizedLegacy) {
      return {
        status: "conflict",
        reason: "canonical_content_differs",
        canonicalPath: resolution.canonicalPath,
        legacyPath: resolution.legacyPath,
      };
    }
    return {
      status: "noop",
      reason: "already_migrated",
      canonicalPath: resolution.canonicalPath,
      legacyPath: resolution.legacyPath,
      entryCount: legacy.entries.length,
    };
  }

  fs.mkdirSync(path.dirname(resolution.canonicalPath), { recursive: true });
  const temporaryPath = `${resolution.canonicalPath}.migration-${process.pid}-${Date.now()}.tmp`;
  try {
    fs.writeFileSync(temporaryPath, normalizedLegacy, { encoding: "utf-8", flag: "wx" });
    options.fsOps?.beforePromote?.();
    if (fs.existsSync(resolution.canonicalPath)) {
      const current = validateMigrationSource(resolution.canonicalPath, expectedProjectId);
      if (!current.valid || normalizePreferenceJsonl(current.entries) !== normalizedLegacy) {
        return {
          status: "conflict",
          reason: "canonical_content_differs",
          canonicalPath: resolution.canonicalPath,
          legacyPath: resolution.legacyPath,
        };
      }
      return {
        status: "noop",
        reason: "already_migrated",
        canonicalPath: resolution.canonicalPath,
        legacyPath: resolution.legacyPath,
        entryCount: legacy.entries.length,
      };
    }
    try {
      (options.fsOps?.linkSync ?? fs.linkSync)(temporaryPath, resolution.canonicalPath);
    } catch (error) {
      if (!fs.existsSync(resolution.canonicalPath)) throw error;
      const current = validateMigrationSource(resolution.canonicalPath, expectedProjectId);
      if (!current.valid || normalizePreferenceJsonl(current.entries) !== normalizedLegacy) {
        return {
          status: "conflict",
          reason: "canonical_content_differs",
          canonicalPath: resolution.canonicalPath,
          legacyPath: resolution.legacyPath,
        };
      }
      return {
        status: "noop",
        reason: "already_migrated",
        canonicalPath: resolution.canonicalPath,
        legacyPath: resolution.legacyPath,
        entryCount: legacy.entries.length,
      };
    }
  } finally {
    if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath);
  }
  return {
    status: "migrated",
    canonicalPath: resolution.canonicalPath,
    legacyPath: resolution.legacyPath,
    entryCount: legacy.entries.length,
  };
}

type MigrationValidation =
  | { valid: true; entries: EditorialPreferenceMemoryEntry[] }
  | { valid: false; reason: "malformed" | "schema_invalid" | "project_mismatch"; errors: string[]; entries: [] };

function validateMigrationSource(filePath: string, expectedProjectId: string): MigrationValidation {
  const unvalidated = readPreferenceEntries(filePath);
  if (unvalidated.malformedLines.length > 0) {
    return {
      valid: false,
      reason: "malformed",
      errors: unvalidated.malformedLines.map((line) => `line ${line.lineNumber}: ${line.error}`),
      entries: [],
    };
  }
  const invalid = unvalidated.entries.filter(({ entry }) => !validatePreferenceMemoryEntry(entry));
  if (invalid.length > 0) {
    return {
      valid: false,
      reason: "schema_invalid",
      errors: invalid.map((entry) => `line ${entry.lineNumber}: schema validation failed`),
      entries: [],
    };
  }
  const mismatched = unvalidated.entries.filter(({ entry }) => entry.project_id !== expectedProjectId);
  if (mismatched.length > 0) {
    return {
      valid: false,
      reason: "project_mismatch",
      errors: mismatched.map((entry) => `line ${entry.lineNumber}: project_id ${entry.entry.project_id} does not match ${expectedProjectId}`),
      entries: [],
    };
  }
  return { valid: true, entries: unvalidated.entries.map(({ entry }) => entry) };
}

function normalizePreferenceJsonl(entries: EditorialPreferenceMemoryEntry[]): string {
  return entries.length === 0
    ? ""
    : `${entries.map((entry) => JSON.stringify(normalizeJsonValue(entry))).join("\n")}\n`;
}

export function readPreferenceEntries(filePath: string, options: ReadPreferenceEntriesOptions = {}): PreferenceReadResult {
  if (!fs.existsSync(filePath)) {
    return { entries: [], malformedLines: [], lastKnownGoodOffset: 0 };
  }

  const raw = fs.readFileSync(filePath, "utf-8");
  const lines = raw.split("\n");
  const entries: PreferenceEntryRecord[] = [];
  const malformedLines: MalformedPreferenceLine[] = [];
  let byteOffset = 0;
  let lastKnownGoodOffset = 0;

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const hasTerminator = index < lines.length - 1;
    const byteLength = Buffer.byteLength(line + (hasTerminator ? "\n" : ""), "utf-8");
    if (line.length === 0 && index === lines.length - 1) break;
    if (line.trim().length === 0) {
      malformedLines.push({ lineNumber: index + 1, byteOffset, raw: line, error: "empty JSONL line" });
      byteOffset += byteLength;
      continue;
    }

    try {
      const entry = JSON.parse(line) as EditorialPreferenceMemoryEntry;
      if (options.validateEntry && !options.validateEntry(entry)) {
        malformedLines.push({ lineNumber: index + 1, byteOffset, raw: line, error: "schema validation failed" });
      } else {
        entries.push({ entry, lineNumber: index + 1, byteOffset });
        lastKnownGoodOffset = byteOffset + byteLength;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      malformedLines.push({ lineNumber: index + 1, byteOffset, raw: line, error: message });
    }
    byteOffset += byteLength;
  }

  return { entries, malformedLines, lastKnownGoodOffset };
}

export function readPreferenceEntriesWithConsumedOffset(
  filePath: string,
  consumedOffset: number,
  options: ReadPreferenceEntriesOptions = {},
): PreferenceConsumedReadResult {
  const result = readPreferenceEntries(filePath, options);
  const errorsInConsumed = result.malformedLines.filter((line) => line.byteOffset < consumedOffset);
  const warningsAfterConsumed = result.malformedLines.filter((line) => line.byteOffset >= consumedOffset);
  return { ...result, errorsInConsumed, warningsAfterConsumed };
}

export function resolveActivePreference(
  entries: EditorialPreferenceMemoryEntry[],
  preferenceType: PreferenceType,
): {
  active: EditorialPreferenceMemoryEntry | null;
  conflicts: EditorialPreferenceMemoryEntry[];
  errors: string[];
} {
  const relevant = entries.filter((entry) => entry.preference_type === preferenceType);
  const errors = validatePreferenceSupersessionGraph(entries);
  if (errors.length > 0) return { active: null, conflicts: [], errors };
  const byId = new Map(entries.map((entry) => [entry.entry_id, entry]));

  for (const entry of relevant) {
    const seen = new Set<string>();
    let cursor: EditorialPreferenceMemoryEntry | undefined = entry;
    while (cursor?.supersedes_entry_id) {
      if (seen.has(cursor.entry_id)) {
        errors.push(`supersession cycle detected at ${cursor.entry_id}`);
        break;
      }
      seen.add(cursor.entry_id);
      cursor = byId.get(cursor.supersedes_entry_id);
    }
  }

  const replacedIds = new Set(
    entries.flatMap((entry) =>
      entry.supersedes_entry_id && ["active", "superseded", "redacted"].includes(entry.status)
        ? [entry.supersedes_entry_id]
        : []
    ),
  );
  const active = relevant.filter((entry) => entry.status === "active" && !replacedIds.has(entry.entry_id));
  if (active.length === 0) return { active: null, conflicts: [], errors };
  if (active.length > 1) {
    errors.push(`unresolved active preference conflict for ${preferenceType}`);
    return { active: null, conflicts: active, errors };
  }
  return { active: active[0], conflicts: [], errors };
}

export function validatePreferenceSupersessionGraph(
  entries: EditorialPreferenceMemoryEntry[],
): string[] {
  const errors: string[] = [];
  const byId = new Map<string, EditorialPreferenceMemoryEntry>();
  for (const entry of entries) {
    if (byId.has(entry.entry_id)) errors.push(`duplicate entry_id: ${entry.entry_id}`);
    else byId.set(entry.entry_id, entry);
  }

  const childrenByTarget = new Map<string, EditorialPreferenceMemoryEntry[]>();
  for (const entry of entries) {
    const targetId = entry.supersedes_entry_id;
    if (!targetId) continue;
    const target = byId.get(targetId);
    if (!target) {
      errors.push(`missing supersession target: ${targetId}`);
      continue;
    }
    if (entry.preference_type !== "redaction" && entry.preference_type !== target.preference_type) {
      errors.push(`cross-type supersession: ${entry.entry_id} -> ${targetId}`);
    }
    const children = childrenByTarget.get(targetId) ?? [];
    children.push(entry);
    childrenByTarget.set(targetId, children);
  }
  for (const [targetId, children] of childrenByTarget) {
    const activeChildren = children.filter((entry) => entry.status === "active" || entry.status === "redacted");
    if (activeChildren.length > 1) {
      errors.push(`supersession branch at ${targetId}: ${activeChildren.map((entry) => entry.entry_id).join(", ")}`);
    }
  }
  for (const entry of entries) {
    const seen = new Set<string>();
    let cursor: EditorialPreferenceMemoryEntry | undefined = entry;
    while (cursor?.supersedes_entry_id) {
      if (seen.has(cursor.entry_id)) {
        errors.push(`supersession cycle detected at ${cursor.entry_id}`);
        break;
      }
      seen.add(cursor.entry_id);
      cursor = byId.get(cursor.supersedes_entry_id);
    }
  }
  return [...new Set(errors)];
}

export function stablePreferenceEntryId(actionId: string): string {
  const normalized = requireBoundedString(actionId, "action_id", 256);
  return `EPM_${crypto.createHash("sha256").update(normalized, "utf-8").digest("hex").slice(0, 24)}`;
}

export function rememberEditorialPreference(
  input: RememberEditorialPreferenceInput,
  options: PreferenceWriteOptions = {},
): PreferenceWriteResult {
  validateWriterIdentity(input.projectDir, input.projectId);
  const actorId = requireBoundedString(input.actorId, "actor_id", 256);
  const actionId = requireBoundedString(input.actionId, "action_id", 256);
  validateWritableValue(input.preferenceType, input.value);
  validateScopeRef(input.scope, input.scopeRef, input.projectId);
  const source = resolveRememberSource(input.projectDir, input.projectId, input.sourceEvent, input.sourceArtifactPath);
  const entry: EditorialPreferenceMemoryEntry = {
    version: "1.1.0",
    project_id: input.projectId,
    entry_id: stablePreferenceEntryId(actionId),
    created_at: input.createdAt ?? new Date().toISOString(),
    actor: { type: "human", id: actorId },
    source_event: {
      event_type: input.sourceEvent,
      event_ref: `${input.sourceEvent}:${actionId}:${source.relativePath}:${source.sha256}`,
    },
    preference_type: input.preferenceType,
    value: input.value,
    scope: input.scope,
    scope_ref: input.scopeRef,
    confidence: { score: 1, source: "explicit-human-action", status: "confirmed" },
    status: "active",
    supersedes_entry_id: input.supersedesEntryId ?? null,
    expires_at: null,
    provenance: {
      producer: input.sourceEvent === "blueprint_acceptance" ? "blueprint" : "review",
      inputs: [{ path: source.relativePath, raw_sha256: source.sha256 }],
      hash_policy: { algorithm: "sha256", canonicalization: "raw-bytes-v1", excluded_fields: [] },
    },
  };
  return appendExplicitPreferenceAction(input.projectDir, input.projectId, entry, options);
}

export function redactEditorialPreference(
  input: RedactEditorialPreferenceInput,
  options: PreferenceWriteOptions = {},
): PreferenceWriteResult {
  validateWriterIdentity(input.projectDir, input.projectId);
  const actionId = requireBoundedString(input.actionId, "action_id", 256);
  const actorId = requireBoundedString(input.actorId, "actor_id", 256);
  const reason = requireBoundedString(input.reason, "reason", 256);
  const targetEntryId = requireBoundedString(input.targetEntryId, "target_entry_id", 128);
  const entry: EditorialPreferenceMemoryEntry = {
    version: "1.1.0",
    project_id: input.projectId,
    entry_id: stablePreferenceEntryId(actionId),
    created_at: input.createdAt ?? new Date().toISOString(),
    actor: { type: "human", id: actorId },
    source_event: { event_type: "redaction", event_ref: `redaction:${actionId}:${targetEntryId}` },
    preference_type: "redaction",
    value: { kind: "string", data: reason },
    scope: "project",
    scope_ref: input.projectId,
    confidence: { score: 1, source: "explicit-human-action", status: "confirmed" },
    status: "redacted",
    supersedes_entry_id: targetEntryId,
    expires_at: null,
    provenance: {
      producer: "operator-command",
      inputs: [{ target_entry_id: targetEntryId }],
      hash_policy: { algorithm: "sha256", canonicalization: "jsonl-records-v1", excluded_fields: [] },
    },
  };
  return appendExplicitPreferenceAction(input.projectDir, input.projectId, entry, options, true);
}

function appendExplicitPreferenceAction(
  projectDir: string,
  projectId: string,
  entry: EditorialPreferenceMemoryEntry,
  options: PreferenceWriteOptions,
  isRedaction = false,
): PreferenceWriteResult {
  const resolution = resolvePreferenceMemoryPath(projectDir);
  if (resolution.source === "legacy") {
    throw new Error("migration_required: migrate legacy editorial preference memory before writing");
  }
  if (!validatePreferenceMemoryEntry(entry)) throw new Error("writer generated a schema-invalid preference entry");
  assertCanonicalWritePathSafe(projectDir, resolution.canonicalPath);
  const existingValidation = validateLedgerForWrite(resolution.canonicalPath, projectId);
  const duplicate = existingValidation.entries.find((candidate) => candidate.entry_id === entry.entry_id);
  if (duplicate) {
    if (sameActionContent(duplicate, entry)) return writeResult("idempotent", duplicate, resolution.canonicalPath);
    throw new Error(`action_id conflict for ${entry.entry_id}`);
  }
  if (isRedaction) {
    const target = existingValidation.entries.find((candidate) => candidate.entry_id === entry.supersedes_entry_id);
    if (!target) throw new Error(`missing redaction target: ${entry.supersedes_entry_id}`);
    if (target.preference_type === "redaction") throw new Error("redaction target must be a preference entry");
    const targetResolution = resolveActivePreference(existingValidation.entries, target.preference_type);
    if (targetResolution.active?.entry_id !== target.entry_id) {
      throw new Error(`redaction target is not an active leaf: ${target.entry_id}`);
    }
  } else if (entry.supersedes_entry_id) {
    const target = existingValidation.entries.find((candidate) => candidate.entry_id === entry.supersedes_entry_id);
    if (!target) throw new Error(`missing supersession target: ${entry.supersedes_entry_id}`);
    if (target.preference_type !== entry.preference_type) throw new Error("cross-type supersession is not allowed");
    const targetResolution = resolveActivePreference(existingValidation.entries, target.preference_type);
    if (targetResolution.active?.entry_id !== target.entry_id) {
      throw new Error(`supersession target is not an active leaf: ${target.entry_id}`);
    }
  }
  const graphErrors = validatePreferenceSupersessionGraph([...existingValidation.entries, entry]);
  if (graphErrors.length > 0) throw new Error(`invalid supersession graph: ${graphErrors.join("; ")}`);
  return appendEntryAtomically(projectDir, projectId, entry, options);
}

function validateLedgerForWrite(filePath: string, projectId: string): { entries: EditorialPreferenceMemoryEntry[]; raw: string } {
  if (!fs.existsSync(filePath)) return { entries: [], raw: "" };
  const raw = fs.readFileSync(filePath, "utf-8");
  const unvalidated = readPreferenceEntries(filePath);
  if (unvalidated.malformedLines.length > 0) {
    throw new Error(`malformed canonical preference memory: ${unvalidated.malformedLines.map((line) => `line ${line.lineNumber}`).join(", ")}`);
  }
  for (const record of unvalidated.entries) {
    if (!validatePreferenceMemoryEntry(record.entry)) throw new Error(`schema-invalid canonical preference memory at line ${record.lineNumber}`);
    if (record.entry.project_id !== projectId) throw new Error(`cross-project canonical preference memory at line ${record.lineNumber}`);
  }
  const entries = unvalidated.entries.map((record) => record.entry);
  const graphErrors = validatePreferenceSupersessionGraph(entries);
  if (graphErrors.length > 0) throw new Error(`invalid canonical supersession graph: ${graphErrors.join("; ")}`);
  return { entries, raw };
}

function appendEntryAtomically(
  projectDir: string,
  projectId: string,
  entry: EditorialPreferenceMemoryEntry,
  options: PreferenceWriteOptions,
): PreferenceWriteResult {
  const canonicalPath = canonicalPreferenceMemoryPath(projectDir);
  assertCanonicalWritePathSafe(projectDir, canonicalPath);
  fs.mkdirSync(path.dirname(canonicalPath), { recursive: true });
  const lockPath = `${canonicalPath}.lock`;
  const release = acquireBoundedLock(
    lockPath,
    options.lockTimeoutMs ?? 1_000,
    options.lockRetryMs ?? 20,
    options.fsOps?.initializeLock,
  );
  const temporaryPath = `${canonicalPath}.append-${process.pid}-${crypto.randomUUID()}.tmp`;
  const rollbackPath = `${canonicalPath}.rollback-${process.pid}-${crypto.randomUUID()}.tmp`;
  let promoted = false;
  let originalRaw = "";
  let existedBefore = false;
  try {
    assertCanonicalWritePathSafe(projectDir, canonicalPath);
    const current = validateLedgerForWrite(canonicalPath, projectId);
    originalRaw = current.raw;
    existedBefore = fs.existsSync(canonicalPath);
    const duplicate = current.entries.find((candidate) => candidate.entry_id === entry.entry_id);
    if (duplicate) {
      if (sameActionContent(duplicate, entry)) return writeResult("idempotent", duplicate, canonicalPath);
      throw new Error(`action_id conflict for ${entry.entry_id}`);
    }
    const separator = current.raw.length > 0 && !current.raw.endsWith("\n") ? "\n" : "";
    const nextRaw = `${current.raw}${separator}${JSON.stringify(entry)}\n`;
    (options.fsOps?.writeFileSync ?? fs.writeFileSync)(temporaryPath, nextRaw, { encoding: "utf-8", flag: "wx" });
    const staged = validateLedgerForWrite(temporaryPath, projectId);
    if (staged.raw !== nextRaw || staged.entries.at(-1)?.entry_id !== entry.entry_id) {
      throw new Error("staged preference append verification failed");
    }
    options.fsOps?.beforePromote?.(temporaryPath, canonicalPath);
    (options.fsOps?.renameSync ?? fs.renameSync)(temporaryPath, canonicalPath);
    promoted = true;
    const verified = validateLedgerForWrite(canonicalPath, projectId);
    const stored = verified.entries.find((candidate) => candidate.entry_id === entry.entry_id);
    if (!stored || !sameActionContent(stored, entry)) throw new Error("preference append verification failed");
    const verifiedRaw = fs.readFileSync(canonicalPath, "utf-8");
    const appendedLine = `${separator}${JSON.stringify(entry)}\n`;
    if (!verifiedRaw.startsWith(current.raw) || verifiedRaw.slice(current.raw.length) !== appendedLine || verifiedRaw !== nextRaw) {
      throw new Error("preference append exact-prefix verification failed");
    }
    return writeResult("appended", stored, canonicalPath);
  } catch (error) {
    if (promoted) {
      if (existedBefore) {
        fs.writeFileSync(rollbackPath, originalRaw, { encoding: "utf-8", flag: "wx" });
        fs.renameSync(rollbackPath, canonicalPath);
      } else if (fs.existsSync(canonicalPath)) {
        fs.unlinkSync(canonicalPath);
      }
    }
    throw error;
  } finally {
    try {
      if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath);
    } finally {
      try {
        if (fs.existsSync(rollbackPath)) fs.unlinkSync(rollbackPath);
      } finally {
        release();
      }
    }
  }
}

function acquireBoundedLock(
  lockPath: string,
  timeoutMs: number,
  retryMs: number,
  initializeLock?: (descriptor: number, lockPath: string) => void,
): () => void {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  while (true) {
    try {
      const descriptor = fs.openSync(lockPath, "wx");
      try {
        fs.writeFileSync(descriptor, `${process.pid}\n`, "utf-8");
        initializeLock?.(descriptor, lockPath);
      } catch (error) {
        try {
          fs.closeSync(descriptor);
        } finally {
          if (fs.existsSync(lockPath)) fs.unlinkSync(lockPath);
        }
        throw error;
      }
      return () => {
        try {
          fs.closeSync(descriptor);
        } finally {
          if (fs.existsSync(lockPath)) fs.unlinkSync(lockPath);
        }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (Date.now() >= deadline) throw new Error(`preference memory lock timeout: ${lockPath}`);
      Atomics.wait(
        new Int32Array(new SharedArrayBuffer(4)),
        0,
        0,
        Math.max(1, Math.min(retryMs, deadline - Date.now())),
      );
    }
  }
}

function writeResult(
  status: PreferenceWriteResult["status"],
  entry: EditorialPreferenceMemoryEntry,
  filePath: string,
): PreferenceWriteResult {
  const raw = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf-8") : "";
  return {
    status,
    entry,
    path: filePath,
    consumedOffset: Buffer.byteLength(raw, "utf-8"),
    consumedHash: computePreferenceMemoryHash(raw),
  };
}

function sameActionContent(left: EditorialPreferenceMemoryEntry, right: EditorialPreferenceMemoryEntry): boolean {
  const omitCreatedAt = (entry: EditorialPreferenceMemoryEntry) => {
    const { created_at: _createdAt, ...content } = entry;
    return normalizeJsonValue(content);
  };
  return JSON.stringify(omitCreatedAt(left)) === JSON.stringify(omitCreatedAt(right));
}

function validateWriterIdentity(projectDir: string, projectId: string): void {
  requireBoundedString(projectId, "project_id", 256);
  const statePath = path.join(path.resolve(projectDir), "project_state.yaml");
  if (!fs.existsSync(statePath)) throw new Error("project_state.yaml is required for an attributable preference action");
  const state = parseYaml(fs.readFileSync(statePath, "utf-8")) as { project_id?: unknown };
  if (state.project_id !== projectId) throw new Error(`project_id does not match project_state.yaml: ${String(state.project_id)}`);
}

function assertCanonicalWritePathSafe(projectDir: string, canonicalPath: string): void {
  const root = fs.realpathSync(path.resolve(projectDir));
  const parent = path.dirname(canonicalPath);
  if (fs.existsSync(canonicalPath)) {
    if (fs.lstatSync(canonicalPath).isSymbolicLink()) throw new Error("canonical preference memory must not be a symlink");
    if (!isPathInside(root, fs.realpathSync(canonicalPath))) throw new Error("canonical preference memory escapes the project");
  }
  if (fs.existsSync(parent) && !isPathInside(root, fs.realpathSync(parent))) {
    throw new Error("canonical preference memory directory escapes the project");
  }
}

function validateWritableValue(type: WritablePreferenceType, value: PrimitivePreferenceValue): void {
  const allowedKinds: Record<WritablePreferenceType, PrimitivePreferenceValue["kind"][]> = {
    pacing: ["string", "enum"],
    chronology: ["boolean", "enum"],
    transition_style: ["string", "enum"],
    repetition_tolerance: ["number", "enum"],
    bgm_loudness: ["number", "enum"],
    caption_density: ["number", "enum"],
    delivery_preference: ["string", "enum"],
  };
  if (!value || !allowedKinds[type]?.includes(value.kind)) {
    throw new Error(`${type} preference kind must be one of: ${(allowedKinds[type] ?? []).join(", ")}`);
  }
  if (value.kind === "number") {
    if (typeof value.data !== "number" || !Number.isFinite(value.data)) throw new Error("number preference data must be finite");
    const [minimum, maximum] = type === "bgm_loudness" ? [-60, 12] : [0, 1];
    if (value.data < minimum || value.data > maximum) {
      throw new Error(`${type} number preference data must be between ${minimum} and ${maximum}`);
    }
    return;
  }
  if (value.kind === "boolean") {
    if (typeof value.data !== "boolean") throw new Error("boolean preference data must be boolean");
    return;
  }
  const stringKind: "string" | "enum" = value.kind;
  if (typeof value.data !== "string") throw new Error(`${stringKind} preference data must be a string`);
  const maximum = value.kind === "enum" ? 64 : 256;
  requireBoundedString(value.data, "preference value", maximum);
  if (value.kind === "enum" && !/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(value.data)) {
    throw new Error("enum preference data contains unsupported characters");
  }
}

function validateScopeRef(scope: WritablePreferenceScope, scopeRef: string, projectId: string): void {
  requireBoundedString(scopeRef, "scope_ref", 256);
  if (scope === "project" && scopeRef !== projectId) throw new Error("project scope_ref must equal project_id");
}

function requireBoundedString(value: string, name: string, maximum: number): string {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum || value.trim() !== value) {
    throw new Error(`${name} must be a non-empty trimmed string of at most ${maximum} characters`);
  }
  return value;
}

function resolveRememberSource(
  projectDir: string,
  projectId: string,
  event: RememberEditorialPreferenceInput["sourceEvent"],
  sourceArtifactPath: string,
): { relativePath: string; sha256: string } {
  const lexicalRoot = path.resolve(projectDir);
  const root = fs.realpathSync(lexicalRoot);
  const requested = path.resolve(lexicalRoot, sourceArtifactPath);
  if (!isPathInside(lexicalRoot, requested) || !fs.existsSync(requested)) throw new Error("source artifact must exist inside the project");
  const real = fs.realpathSync(requested);
  if (!isPathInside(root, real)) throw new Error("source artifact symlink escapes the project");
  const relativePath = normalizeRelativeProjectPath(path.relative(lexicalRoot, requested));
  let registeredStudioPatch = false;
  if (event === "blueprint_acceptance") {
    if (relativePath !== "04_plan/edit_blueprint.yaml") throw new Error("blueprint acceptance source must be 04_plan/edit_blueprint.yaml");
    const blueprint = parseYaml(fs.readFileSync(real, "utf-8")) as { project_id?: unknown };
    if (!sourceArtifactSchemaValidator("edit-blueprint.schema.json")(blueprint)) throw new Error("blueprint source failed schema validation");
    if (blueprint.project_id !== projectId) throw new Error("cross-project blueprint source rejected");
  } else if (relativePath !== "06_review/review_patch.json") {
    const indexPath = path.join(root, "06_review/patch_history/index.json");
    if (!fs.existsSync(indexPath)) throw new Error("Studio review patch is not registered in patch_history index");
    const index = JSON.parse(fs.readFileSync(indexPath, "utf-8")) as { project_id?: unknown; records?: Array<{ patch_path?: unknown }> };
    if (index.project_id !== projectId) throw new Error("cross-project patch_history index rejected");
    registeredStudioPatch = (index.records ?? []).some((record) => {
      if (typeof record.patch_path !== "string") return false;
      const normalized = normalizeRelativeProjectPath(record.patch_path);
      const registeredPath = path.resolve(root, record.patch_path);
      if (normalized.startsWith("../") || path.isAbsolute(record.patch_path) || !isPathInside(root, registeredPath)) return false;
      if (!fs.existsSync(registeredPath) || !isPathInside(root, fs.realpathSync(registeredPath))) return false;
      return normalized === relativePath && fs.realpathSync(registeredPath) === real;
    });
    if (!registeredStudioPatch) throw new Error("Studio review patch is not registered in patch_history index");
  }
  if (event !== "blueprint_acceptance") {
    let reviewDocument: unknown;
    try {
      reviewDocument = JSON.parse(fs.readFileSync(real, "utf-8"));
    } catch {
      throw new Error("review patch source is not valid JSON");
    }
    let reviewPatch = reviewDocument;
    if (registeredStudioPatch && reviewDocument && typeof reviewDocument === "object" && "patch" in reviewDocument) {
      const envelope = reviewDocument as { project_id?: unknown; patch?: unknown };
      if (envelope.project_id !== projectId) throw new Error("cross-project Studio patch envelope rejected");
      reviewPatch = envelope.patch;
    }
    if (!sourceArtifactSchemaValidator("review-patch.schema.json")(reviewPatch)) {
      throw new Error("review patch source failed schema validation");
    }
  }
  const raw = fs.readFileSync(real);
  return {
    relativePath,
    sha256: `sha256:${crypto.createHash("sha256").update(raw).digest("hex")}`,
  };
}

function isPathInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function normalizeRelativeProjectPath(value: string): string {
  return value.split(path.sep).join("/");
}

export function appendPreferenceEntry(
  filePath: string,
  entry: EditorialPreferenceMemoryEntry,
  options: ReadPreferenceEntriesOptions = {},
): { consumedOffset: number; consumedHash: string } {
  if (options.validateEntry && !options.validateEntry(entry)) {
    throw new Error("editorial_preference_memory entry failed schema validation");
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, `${JSON.stringify(entry)}\n`, "utf-8");
  const raw = fs.readFileSync(filePath, "utf-8");
  return {
    consumedOffset: Buffer.byteLength(raw, "utf-8"),
    consumedHash: computePreferenceMemoryHash(raw),
  };
}

export function appendProjectPreferenceEntry(
  projectDir: string,
  entry: EditorialPreferenceMemoryEntry,
  options: ReadPreferenceEntriesOptions = {},
): { path: string; consumedOffset: number; consumedHash: string } {
  const resolution = resolvePreferenceMemoryPath(projectDir);
  if (resolution.source === "legacy") {
    throw new Error("editorial preference memory migration_required before canonical append");
  }
  if (options.validateEntry && !options.validateEntry(entry)) {
    throw new Error("editorial_preference_memory entry failed schema validation");
  }
  const result = appendEntryAtomically(projectDir, entry.project_id, entry, {});
  return { path: result.path, consumedOffset: result.consumedOffset, consumedHash: result.consumedHash };
}

export function computePreferenceMemoryHash(rawJsonl: string): string {
  const normalizedRecords = rawJsonl.split("\n")
    .filter((line, index, lines) => !(line === "" && index === lines.length - 1))
    .map((line) => JSON.stringify(normalizeJsonValue(JSON.parse(line))));
  const stream = normalizedRecords.length > 0 ? `${normalizedRecords.join("\n")}\n` : "";
  return `sha256:${crypto.createHash("sha256").update(stream, "utf-8").digest("hex")}`;
}
