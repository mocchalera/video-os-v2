import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { createRequire } from "node:module";
import {
  computeConfidenceCalibrationReportHash,
  validateConfidenceCalibrationReportIntegrity,
} from "../runtime/artifacts/p4c-confidence-calibration.js";

const require_ = createRequire(import.meta.url);
const Ajv2020 = require_("ajv/dist/2020") as new (opts: Record<string, unknown>) => {
  compile(schema: object): { (data: unknown): boolean; errors?: unknown[] | null };
};
const addFormats = require_("ajv-formats") as (ajv: unknown) => void;

const FIXTURE_DIR = path.resolve("tests/fixtures/confidence_calibration_report");
const SCHEMA_PATH = path.resolve("schemas/confidence-calibration-report.schema.json");

function readFixture(fileName: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, fileName), "utf-8")) as Record<string, unknown>;
}

function schemaValidator(): ReturnType<InstanceType<typeof Ajv2020>["compile"]> {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  return ajv.compile(JSON.parse(fs.readFileSync(SCHEMA_PATH, "utf-8")));
}

describe("P4c confidence_calibration_report schema", () => {
  it.each([
    "valid_minimal.json",
    "valid_full_metrics.json",
    "valid_with_failures.json",
  ])("accepts valid fixture %s", (fixture) => {
    const validate = schemaValidator();
    const data = readFixture(fixture);

    expect(validate(data), JSON.stringify(validate.errors, null, 2)).toBe(true);
    expect(validateConfidenceCalibrationReportIntegrity(data).valid).toBe(true);
  });

  it.each([
    "invalid_missing_metrics.json",
    "invalid_bucket_inconsistency.json",
  ])("rejects invalid fixture %s", (fixture) => {
    const validate = schemaValidator();
    const data = readFixture(fixture);

    expect(validate(data)).toBe(false);
  });

  it("keeps the no-failures edge fixture schema-valid", () => {
    const validate = schemaValidator();
    const data = readFixture("edge_no_failures.json");

    expect(validate(data), JSON.stringify(validate.errors, null, 2)).toBe(true);
    expect(validateConfidenceCalibrationReportIntegrity(data).valid).toBe(true);
  });

  it("computes deterministic normalized-json-v1 hashes with created_at excluded", () => {
    const report = readFixture("valid_full_metrics.json");
    const later = { ...report, created_at: "2026-04-28T00:00:00Z" };

    expect(computeConfidenceCalibrationReportHash(report)).toBe(computeConfidenceCalibrationReportHash(later));
    expect(computeConfidenceCalibrationReportHash(report)).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it("enforces bucket consistency as a runner-level integrity rule", () => {
    const validate = schemaValidator();
    const report = readFixture("valid_minimal.json");
    report.buckets = [{
      bucket: "high",
      sample_count: 10,
      observed_accuracy: 0.5,
      expected_accuracy: 0.9,
    }];

    expect(validate(report), JSON.stringify(validate.errors, null, 2)).toBe(true);
    const integrity = validateConfidenceCalibrationReportIntegrity(report);
    expect(integrity.valid).toBe(false);
    expect(integrity.violations.some((violation) => violation.includes("bucket calibration drift"))).toBe(true);
  });

  it("validates artifact_versions hash format", () => {
    const validate = schemaValidator();
    const report = readFixture("valid_minimal.json");
    (report.artifact_versions as Record<string, unknown>).assets_version = {
      version: "assets-v1",
      hash: "not-a-hash",
    };

    expect(validate(report)).toBe(false);
  });
});
