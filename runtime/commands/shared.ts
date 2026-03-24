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

import * as fs from "node:fs";
import * as path from "node:path";
import { stringify as stringifyYaml } from "yaml";
import { createRequire } from "node:module";
import {
  reconcile,
  snapshotArtifacts,
  writeProjectState,
  readProjectStateWithRevision,
  computeRevision,
  ConflictError,
  type ProjectStateDoc,
  type ProjectState,
  type ReconcileResult,
  type ArtifactHashes,
  type WriteProjectStateOptions,
} from "../state/reconcile.js";
import { createHistoryEntry } from "../state/history.js";

// ── AJV setup (CJS interop) ─────────────────────────────────────

const require = createRequire(import.meta.url);
const Ajv2020 = require("ajv/dist/2020") as new (opts: Record<string, unknown>) => {
  compile(schema: object): {
    (data: unknown): boolean;
    errors?: Array<{ instancePath: string; message?: string }> | null;
  };
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
}

export interface PromoteResult {
  success: boolean;
  promoted: string[];
  errors: string[];
  failure_kind?: "validation" | "concurrent_edit" | "promote";
}

export interface PromoteOptions {
  preflightHashes?: ArtifactHashes;
  guardKeys?: Array<keyof ArtifactHashes>;
  fsOps?: {
    renameSync?: typeof fs.renameSync;
  };
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

export function validateAgainstSchema(
  data: unknown,
  schemaFile: string,
): { valid: boolean; errors: string[] } {
  const schemaPath = path.join(schemasDir, schemaFile);
  if (!fs.existsSync(schemaPath)) {
    return { valid: false, errors: [`Schema file not found: ${schemaFile}`] };
  }
  const schema = JSON.parse(fs.readFileSync(schemaPath, "utf-8"));
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
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

// ── Draft/Promote Pipeline ───────────────────────────────────────
//
// 1. Write draft to temp file (.draft.yaml / .draft.json)
// 2. Validate against schema
// 3. If all drafts valid → atomic rename to canonical path
// 4. If any invalid → leave drafts, return errors

export function draftAndPromote(
  projectDir: string,
  drafts: DraftFile[],
  options?: PromoteOptions,
): PromoteResult {
  const transactionId = `${process.pid}-${Date.now()}`;
  const draftPaths: Array<{ draft: string; final: string; backup?: string; promoted?: boolean }> = [];
  const errors: string[] = [];
  const renameSync = options?.fsOps?.renameSync ?? fs.renameSync;

  // Step 1: Write all drafts
  for (const d of drafts) {
    const finalPath = path.join(projectDir, d.relativePath);
    const draftPath = finalPath.replace(/\.(yaml|json)$/, `.draft.$1`);

    // Ensure directory exists
    fs.mkdirSync(path.dirname(draftPath), { recursive: true });

    // Serialize
    const serialized = d.format === "json"
      ? JSON.stringify(d.content, null, 2)
      : stringifyYaml(d.content);

    fs.writeFileSync(draftPath, serialized, "utf-8");
    draftPaths.push({ draft: draftPath, final: finalPath });

    // Step 2: Validate
    const result = validateAgainstSchema(d.content, d.schemaFile);
    if (!result.valid) {
      errors.push(`${d.relativePath}: ${result.errors.join("; ")}`);
    }
  }

  // If any validation failed, clean up drafts and return
  if (errors.length > 0) {
    for (const { draft } of draftPaths) {
      try { fs.unlinkSync(draft); } catch { /* ignore */ }
    }
    return { success: false, promoted: [], errors, failure_kind: "validation" };
  }

  if (options?.preflightHashes && (options.guardKeys?.length ?? 0) > 0) {
    const currentHashes = snapshotArtifacts(projectDir).hashes;
    const mismatches = options.guardKeys!
      .filter((key) => options.preflightHashes?.[key] !== currentHashes[key])
      .map((key) =>
        `${String(key)} changed from "${options.preflightHashes?.[key] ?? "null"}" ` +
        `to "${currentHashes[key] ?? "null"}"`,
      );
    if (mismatches.length > 0) {
      for (const { draft } of draftPaths) {
        try { fs.unlinkSync(draft); } catch { /* ignore */ }
      }
      return {
        success: false,
        promoted: [],
        errors: mismatches,
        failure_kind: "concurrent_edit",
      };
    }
  }

  // Step 3: Atomic promote with rollback
  const promoted: string[] = [];
  try {
    for (const entry of draftPaths) {
      if (fs.existsSync(entry.final)) {
        entry.backup = path.join(
          path.dirname(entry.final),
          `.${path.basename(entry.final)}.promote-backup-${transactionId}`,
        );
        renameSync(entry.final, entry.backup);
      }

      renameSync(entry.draft, entry.final);
      entry.promoted = true;
      promoted.push(entry.final);
    }
  } catch (err) {
    errors.push(`Failed to promote artifacts atomically: ${String(err)}`);

    for (const entry of [...draftPaths].reverse()) {
      if (entry.promoted && fs.existsSync(entry.final)) {
        try { fs.unlinkSync(entry.final); } catch { /* ignore */ }
      }

      if (entry.backup && fs.existsSync(entry.backup)) {
        try { renameSync(entry.backup, entry.final); } catch { /* ignore */ }
      }

      if (fs.existsSync(entry.draft)) {
        try { fs.unlinkSync(entry.draft); } catch { /* ignore */ }
      }
    }

    return { success: false, promoted: [], errors, failure_kind: "promote" };
  }

  for (const entry of draftPaths) {
    if (entry.backup && fs.existsSync(entry.backup)) {
      try { fs.unlinkSync(entry.backup); } catch { /* ignore */ }
    }
  }

  return { success: true, promoted, errors: [] };
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
