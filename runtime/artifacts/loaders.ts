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

// ── AJV setup (CJS interop) ─────────────────────────────────────

const require = createRequire(import.meta.url);
const Ajv2020 = require("ajv/dist/2020") as new (opts: Record<string, unknown>) => {
  compile(schema: object): {
    (data: unknown): boolean;
    errors?: Array<{ instancePath: string; message?: string }> | null;
  };
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

function getValidator(schemaFile: string): ValidateFn {
  const cached = compiledSchemas.get(schemaFile);
  if (cached) return cached;

  const schemaPath = path.join(schemasDir, schemaFile);
  if (!fs.existsSync(schemaPath)) {
    throw new ArtifactValidationError(schemaFile, [`Schema file not found: ${schemaFile}`]);
  }
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

function validateAndReturn<T>(data: unknown, schemaFile: string): T {
  const validate = getValidator(schemaFile);
  if (validate(data)) {
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
  const data = readAndParse(filePath);
  return validateAndReturn<EditBlueprint>(data, "edit-blueprint.schema.json");
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
 * Parse and validate already-loaded data against a named schema.
 * Use when the data is already in memory (e.g., from parseYaml).
 */
export function validateArtifact<T>(data: unknown, schemaFile: string): T {
  return validateAndReturn<T>(data, schemaFile);
}
