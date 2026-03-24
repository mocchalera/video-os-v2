/**
 * Timeline schema validation middleware using Ajv.
 *
 * Validates request bodies against schemas/timeline-ir.schema.json.
 */

import Ajv from "ajv";
import addFormats from "ajv-formats";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Request, Response, NextFunction } from "express";

// Resolve schema path relative to project root
const SCHEMA_PATH = path.resolve(
  import.meta.dirname,
  "..",
  "..",
  "..",
  "schemas",
  "timeline-ir.schema.json",
);

let cachedValidate: ReturnType<Ajv["compile"]> | null = null;

export function getTimelineValidator(): ReturnType<Ajv["compile"]> {
  if (cachedValidate) return cachedValidate;

  const schemaText = fs.readFileSync(SCHEMA_PATH, "utf-8");
  const schema = JSON.parse(schemaText);

  const ajv = new Ajv({ allErrors: true, strict: false });
  addFormats(ajv);

  cachedValidate = ajv.compile(schema);
  return cachedValidate;
}

/**
 * Express middleware that validates req.body against timeline-ir.schema.json.
 * On failure, responds with 400 and validation error details.
 */
export function validateTimeline(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const validate = getTimelineValidator();
  const valid = validate(req.body);

  if (!valid) {
    res.status(400).json({
      error: "Schema validation failed",
      details: validate.errors?.map((e) => ({
        path: e.instancePath,
        message: e.message,
        params: e.params,
      })),
    });
    return;
  }

  next();
}
