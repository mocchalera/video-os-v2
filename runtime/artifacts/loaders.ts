// Typed artifact loaders with JSON Schema validation.
// Each loader reads a file, validates against the canonical schema,
// and returns a strongly-typed object or throws with specific errors.

import * as fs from "node:fs";
import * as path from "node:path";
import { createRequire } from "node:module";
import { parse as parseYaml } from "yaml";
import type {
  CreativeBrief,
  SelectsCandidates,
  EditBlueprint,
  TimelineIR,
} from "./types.js";
import {
  validateVideoReasoningEvidenceIntegrity,
  type VideoReasoningEvidenceArtifact,
} from "../analysis/video-reasoning-evidence.js";
import {
  validateVideoReasoningLocalVerificationIntegrity,
  type VideoReasoningLocalVerificationArtifact,
} from "../analysis/video-reasoning-local-verification.js";
import { sanitizeBlueprint } from "../blueprint/sanitizer.js";
import { validateBgmAnalysisContract } from "../media/bgm-analysis-contract.js";

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

const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);

// ── Schema loading ──────────────────────────────────────────────

const schemasDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "../../schemas",
);

type ValidateFn = {
  (data: unknown): boolean;
  errors?: Array<{ instancePath: string; message?: string }> | null;
};

const compiledSchemas = new Map<string, ValidateFn>();
let sharedSchemasLoaded = false;
let wholeCutSemanticSchemaLoaded = false;

function ensureSharedSchemas(): void {
  if (sharedSchemasLoaded) return;
  const commonPath = path.join(schemasDir, "analysis-common.schema.json");
  if (fs.existsSync(commonPath)) {
    ajv.addSchema(JSON.parse(fs.readFileSync(commonPath, "utf-8")) as object);
  }
  sharedSchemasLoaded = true;
}

function ensureWholeCutSemanticSchema(): void {
  if (wholeCutSemanticSchemaLoaded) return;
  const schemaPath = path.join(schemasDir, "whole-cut-semantic-review.schema.json");
  if (fs.existsSync(schemaPath)) {
    ajv.addSchema(JSON.parse(fs.readFileSync(schemaPath, "utf-8")) as object);
  }
  wholeCutSemanticSchemaLoaded = true;
}

function getValidator(schemaFile: string): ValidateFn {
  const cached = compiledSchemas.get(schemaFile);
  if (cached) return cached;

  const schemaPath = path.join(schemasDir, schemaFile);
  if (!fs.existsSync(schemaPath)) {
    throw new ArtifactValidationError(schemaFile, [`Schema file not found: ${schemaFile}`]);
  }
  ensureSharedSchemas();
  if (schemaFile === "review-report.schema.json") ensureWholeCutSemanticSchema();
  const schema = JSON.parse(fs.readFileSync(schemaPath, "utf-8"));
  const validate = ajv.compile(schema);
  compiledSchemas.set(schemaFile, validate);
  return validate;
}

// ── Error class ──────────────────────────────────────────────────

export class ArtifactValidationError extends Error {
  public readonly schemaFile: string;
  public readonly validationErrors: string[];

  constructor(schemaFile: string, errors: string[]) {
    const detail = errors.join("; ");
    super(`Artifact validation failed (${schemaFile}): ${detail}`);
    this.name = "ArtifactValidationError";
    this.schemaFile = schemaFile;
    this.validationErrors = errors;
  }
}

// ── Internal helpers ─────────────────────────────────────────────

function readAndParse(filePath: string): unknown {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Artifact file not found: ${filePath}`);
  }
  const raw = fs.readFileSync(filePath, "utf-8");
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".yaml" || ext === ".yml") {
    return parseYaml(raw);
  }
  return JSON.parse(raw);
}

function validateAndReturn<T>(
  data: unknown,
  schemaFile: string,
  providerArtifact?: VideoReasoningEvidenceArtifact,
): T {
  const validate = getValidator(schemaFile);
  if (validate(data)) {
    if (schemaFile === "video-reasoning-evidence.schema.json") {
      const integrity = validateVideoReasoningEvidenceIntegrity(data);
      if (!integrity.valid) {
        throw new ArtifactValidationError(schemaFile, integrity.errors);
      }
    }
    if (schemaFile === "video-reasoning-local-verification.schema.json") {
      if (!providerArtifact) {
        throw new ArtifactValidationError(schemaFile, ["provider artifact is required for source-bound local verification"]);
      }
      const integrity = validateVideoReasoningLocalVerificationIntegrity(data, providerArtifact);
      if (!integrity.valid) {
        throw new ArtifactValidationError(schemaFile, integrity.errors);
      }
    }
    if (schemaFile === "bgm-analysis.schema.json") {
      const contractFailures = validateBgmAnalysisContract(data);
      if (contractFailures.length > 0) {
        throw new ArtifactValidationError(schemaFile, contractFailures);
      }
    }
    return data as T;
  }
  const errors = (validate.errors ?? []).map(
    (e) => `${e.instancePath || "/"}: ${e.message ?? "unknown"}`,
  );
  throw new ArtifactValidationError(schemaFile, errors);
}

// ── Public loaders ──────────────────────────────────────────────

/**
 * Load and validate a creative brief from a YAML/JSON file.
 * Schema: creative-brief.schema.json
 */
export function loadCreativeBrief(filePath: string): CreativeBrief {
  const data = readAndParse(filePath);
  return validateAndReturn<CreativeBrief>(data, "creative-brief.schema.json");
}

/**
 * Load and validate selects candidates from a YAML/JSON file.
 * Schema: selects-candidates.schema.json
 */
export function loadSelects(filePath: string): SelectsCandidates {
  const data = readAndParse(filePath);
  return validateAndReturn<SelectsCandidates>(data, "selects-candidates.schema.json");
}

/**
 * Load and validate an edit blueprint from a YAML/JSON file.
 * Schema: edit-blueprint.schema.json
 */
export function loadBlueprint(filePath: string): EditBlueprint {
  return loadBlueprintData(readAndParse(filePath));
}

/** Validate and normalize an already parsed blueprint through the same path as the file loader. */
export function loadBlueprintData(data: unknown): EditBlueprint {
  // Blueprint v1 is intentionally read-compatible with historical projects whose
  // shape predates the current v2 policy fields. Only the versioned v2 branch is
  // subject to the v2 schema and sanitizer contract.
  if (!isBlueprintV2(data)) return data as EditBlueprint;
  const validated = validateAndReturn<EditBlueprint>(data, "edit-blueprint.schema.json");
  return sanitizeBlueprint(validated).blueprint;
}

function isBlueprintV2(data: unknown): data is { version: "2" } {
  return typeof data === "object" && data !== null && (data as { version?: unknown }).version === "2";
}

/**
 * Load and validate a timeline IR from a JSON file.
 * Schema: timeline-ir.schema.json
 */
export function loadTimeline(filePath: string): TimelineIR {
  const data = readAndParse(filePath);
  return validateAndReturn<TimelineIR>(data, "timeline-ir.schema.json");
}

/**
 * Load the source-bound M3b local-verification artifact with its M3a parent.
 */
export function loadVideoReasoningLocalVerification(
  filePath: string,
  providerArtifact: VideoReasoningEvidenceArtifact,
): VideoReasoningLocalVerificationArtifact {
  const data = readAndParse(filePath);
  return validateAndReturn<VideoReasoningLocalVerificationArtifact>(
    data,
    "video-reasoning-local-verification.schema.json",
    providerArtifact,
  );
}

/**
 * Parse and validate already-loaded data against a named schema.
 * Use when the data is already in memory (e.g., from parseYaml).
 */
export function validateArtifact<T>(data: unknown, schemaFile: string): T {
  return validateAndReturn<T>(data, schemaFile);
}
