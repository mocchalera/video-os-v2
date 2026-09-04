/**
 * Canonical validation for Gemini still/frame VLM responses.
 *
 * The JSON schema is the contract source. This module deliberately exposes
 * only safe structural diagnostics: paths, error kinds, and schema-derived
 * expectations. Provider values, response text, and unknown property names
 * never leave the validator.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const Ajv2020 = require("ajv/dist/2020") as new (options: Record<string, unknown>) => {
  compile(schema: object): ValidateFunction;
};

export const VLM_GROUNDING_RESPONSE_SCHEMA_FILE = "vlm-grounding-response.schema.json";
export const VLM_GROUNDING_RESPONSE_SCHEMA_VERSION = "1.0.0";

export type VlmValidationErrorKind =
  | "missing"
  | "type"
  | "range"
  | "enum"
  | "additional"
  | "constraint";

export interface VlmValidationError {
  /** Canonical dotted path, never a provider-supplied property name. */
  path: string;
  /** Stable machine-readable error category. */
  code: VlmValidationErrorKind;
  kind: VlmValidationErrorKind;
  /** AJV keyword, retained only from the closed validator vocabulary. */
  keyword: string;
  /** Safe schema-derived expectation, when one is available. */
  expected?: string;
  /** Safe enum members copied from the canonical schema only. */
  allowed_values?: string[];
}

export interface VlmGroundingValidationResult {
  valid: boolean;
  errors: VlmValidationError[];
}

interface ValidateError {
  instancePath?: string;
  keyword?: string;
  params?: Record<string, unknown>;
}

interface ValidateFunction {
  (data: unknown): boolean;
  errors?: ValidateError[] | null;
}

type JsonSchema = Record<string, unknown>;

let canonicalSchema: JsonSchema | undefined;
let canonicalValidator: ValidateFunction | undefined;

function schemaPathCandidates(): string[] {
  return [
    fileURLToPath(new URL(`../../schemas/${VLM_GROUNDING_RESPONSE_SCHEMA_FILE}`, import.meta.url)),
    path.resolve(process.cwd(), "schemas", VLM_GROUNDING_RESPONSE_SCHEMA_FILE),
  ];
}

function loadCanonicalSchema(): JsonSchema {
  if (canonicalSchema) return canonicalSchema;
  const schemaPath = schemaPathCandidates().find((candidate) => fs.existsSync(candidate));
  if (!schemaPath) {
    throw new Error("vlm_grounding_response_schema_unavailable");
  }
  canonicalSchema = JSON.parse(fs.readFileSync(schemaPath, "utf-8")) as JsonSchema;
  return canonicalSchema;
}

function getCanonicalValidator(): ValidateFunction {
  if (canonicalValidator) return canonicalValidator;
  const ajv = new Ajv2020({ allErrors: true, strict: false, strictNumbers: true });
  canonicalValidator = ajv.compile(loadCanonicalSchema());
  return canonicalValidator;
}

/** Return a cloned canonical schema so callers cannot mutate validator state. */
export function getVlmGroundingResponseSchema(): JsonSchema {
  return structuredClone(loadCanonicalSchema());
}

/**
 * Return the same canonical schema in Gemini's responseSchema slot. Metadata
 * keywords are removed because the provider accepts the JSON Schema shape,
 * not the document metadata. No contract property is re-declared here.
 */
export function getVlmProviderResponseSchema(): JsonSchema {
  const schema = getVlmGroundingResponseSchema();
  delete schema.$schema;
  delete schema.$id;
  delete schema.title;
  delete schema.description;
  delete schema["x-schema-version"];
  return schema;
}

function pointerSegments(pointer: string): string[] {
  if (pointer === "") return [];
  if (!pointer.startsWith("/")) return [];
  return pointer.slice(1).split("/").map((segment) =>
    segment.replace(/~1/g, "/").replace(/~0/g, "~"),
  );
}

function safePath(pointer: string | undefined): string {
  const segments = pointerSegments(pointer ?? "");
  if (segments.length === 0) return "$";
  return segments.map((segment) => /^\d+$/.test(segment) ? `[${segment}]` : segment)
    .reduce((result, segment) => segment.startsWith("[") ? `${result}${segment}` : `${result}${result ? "." : ""}${segment}`, "");
}

function safeMissingPath(instancePath: string | undefined, missing: unknown): string {
  const parent = safePath(instancePath);
  return typeof missing === "string" && /^[A-Za-z_][A-Za-z0-9_]*$/.test(missing)
    ? `${parent === "$" ? "" : `${parent}.`}${missing}` || "$"
    : parent;
}

function errorKind(keyword: string | undefined): VlmValidationErrorKind {
  switch (keyword) {
    case "required": return "missing";
    case "type": return "type";
    case "minimum":
    case "maximum":
    case "exclusiveMinimum":
    case "exclusiveMaximum":
    case "minLength":
    case "maxLength":
    case "minItems":
    case "maxItems":
      return "range";
    case "enum": return "enum";
    case "additionalProperties": return "additional";
    default: return "constraint";
  }
}

function safeExpected(keyword: string | undefined, params: Record<string, unknown> | undefined): string | undefined {
  switch (keyword) {
    case "required": return "required property";
    case "type": return typeof params?.type === "string" ? params.type : "schema type";
    case "minimum": return "number in range 0..1";
    case "maximum": return "number in range 0..1";
    case "exclusiveMinimum": return "number above schema minimum";
    case "exclusiveMaximum": return "number below schema maximum";
    case "enum": return "one documented enum value";
    case "minLength": return "non-empty string";
    case "minItems": return "array with required minimum items";
    case "additionalProperties": return "canonical properties only";
    default: return undefined;
  }
}

function safeAllowedValues(
  keyword: string | undefined,
  params: Record<string, unknown> | undefined,
): string[] | undefined {
  if (keyword !== "enum" || !Array.isArray(params?.allowed)) return undefined;
  const values = params.allowed.filter((value): value is string =>
    typeof value === "string" && value.length <= 80,
  );
  return values.length > 0 ? values : undefined;
}

function normalizeAjvError(error: ValidateError): VlmValidationError {
  const keyword = typeof error.keyword === "string" && error.keyword.length > 0
    ? error.keyword
    : "constraint";
  const kind = errorKind(keyword);
  return {
    path: keyword === "required"
      ? safeMissingPath(error.instancePath, error.params?.missingProperty)
      : safePath(error.instancePath),
    code: kind,
    kind,
    keyword,
    ...(safeExpected(keyword, error.params) ? { expected: safeExpected(keyword, error.params) } : {}),
    ...(safeAllowedValues(keyword, error.params)
      ? { allowed_values: safeAllowedValues(keyword, error.params) }
      : {}),
  };
}

function expandMissingEditorialConfidence(errors: VlmValidationError[]): VlmValidationError[] {
  const requiredPaths = [
    "editorial_observation.confidence.tags",
    "editorial_observation.confidence.motion",
    "editorial_observation.confidence.framing",
    "editorial_observation.confidence.direction",
    "editorial_observation.confidence.appearance",
    "editorial_observation.confidence.text",
  ];
  const confidenceParentMissing = errors.some((error) =>
    error.kind === "missing" && (
      error.path === "editorial_observation" ||
      error.path === "editorial_observation.confidence"
    ),
  );
  if (!confidenceParentMissing) {
    return errors;
  }
  const existing = new Set(errors.map((error) => `${error.path}|${error.kind}`));
  return [
    ...errors,
    ...requiredPaths
      .filter((pathValue) => !existing.has(`${pathValue}|missing`))
      .map((pathValue) => ({
        path: pathValue,
        code: "missing" as const,
        kind: "missing" as const,
        keyword: "required",
        expected: "required property",
      })),
  ];
}

/** Validate an already parsed provider response against the canonical schema. */
export function validateVlmGroundingResponse(value: unknown): VlmGroundingValidationResult {
  const validator = getCanonicalValidator();
  if (validator(value)) return { valid: true, errors: [] };
  const errors = expandMissingEditorialConfidence((validator.errors ?? []).map(normalizeAjvError));
  return { valid: false, errors };
}

/** Stable, provider-value-free text for a repair prompt. */
export function formatVlmValidationError(error: VlmValidationError): string {
  const kind = ["missing", "type", "range", "enum", "additional", "constraint"]
    .includes(error.kind)
    ? error.kind
    : "constraint";
  const path = /^(?:\$|[A-Za-z_][A-Za-z0-9_]*(?:\[\d+\])?(?:\.[A-Za-z_][A-Za-z0-9_]*(?:\[\d+\])?)*)$/.test(error.path)
    ? error.path
    : "$";
  const details = [
    [
      "required property",
      "string",
      "array",
      "object",
      "number",
      "integer",
      "number in range 0..1",
      "schema type",
      "one documented enum value",
      "canonical properties only",
      "non-empty string",
      "array with required minimum items",
    ].includes(error.expected ?? "") ? error.expected : undefined,
    ...(Array.isArray(error.allowed_values)
      ? (() => {
        const allowed = error.allowed_values.filter((value) =>
          typeof value === "string" && /^[A-Za-z_][A-Za-z0-9_]*$/.test(value),
        );
        return allowed.length > 0 ? [`allowed: ${allowed.join("|")}`] : [];
      })()
      : []),
  ].filter(Boolean);
  return `${path}: ${kind}${details.length > 0 ? ` (${details.join("; ")})` : ""}`;
}

export function getVlmRequiredPaths(): string[] {
  const paths: string[] = [];
  const visit = (schema: JsonSchema, prefix: string): void => {
    const properties = schema.properties;
    const required = schema.required;
    if (!isRecord(properties)) return;
    const requiredKeys = new Set(
      Array.isArray(required)
        ? required.filter((key): key is string => typeof key === "string")
        : [],
    );
    for (const [key, child] of Object.entries(properties)) {
      const currentPath = prefix ? `${prefix}.${key}` : key;
      if (requiredKeys.has(key)) paths.push(currentPath);
      if (isRecord(child) && child.type === "object") visit(child, currentPath);
    }
  };
  visit(loadCanonicalSchema(), "");
  return paths;
}

function isRecord(value: unknown): value is JsonSchema {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Build the schema-derived contract block embedded in the initial prompt. */
export function buildVlmSchemaContractPrompt(): string {
  const schema = loadCanonicalSchema();
  const requiredPaths = getVlmRequiredPaths();
  const enumLines: string[] = [];
  const boundedNumberPaths: string[] = [];

  const visit = (node: JsonSchema, prefix: string): void => {
    if (Array.isArray(node.enum)) {
      const values = node.enum.filter((value): value is string => typeof value === "string");
      if (values.length > 0) enumLines.push(`${prefix}: ${values.join("|")}`);
    }
    if (node.type === "number" && node.minimum === 0 && node.maximum === 1) {
      boundedNumberPaths.push(prefix);
    }
    if (isRecord(node.properties)) {
      for (const [key, child] of Object.entries(node.properties)) {
        if (isRecord(child)) visit(child, prefix ? `${prefix}.${key}` : key);
      }
    }
    if (isRecord(node.items)) visit(node.items, `${prefix}[]`);
  };
  visit(schema, "");

  return [
    "Canonical response contract (generated from vlm-grounding-response.schema.json):",
    `Required paths: ${requiredPaths.join(", ")}`,
    "Confidence score paths are finite numbers in the inclusive range 0..1:",
    ...boundedNumberPaths.map((pathValue) => `- ${pathValue}`),
    "Enum paths and allowed values:",
    ...enumLines.map((line) => `- ${line}`),
  ].join("\n");
}
