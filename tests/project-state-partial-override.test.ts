import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { createRequire } from "node:module";
import { interpretPlanningGate } from "../runtime/commands/status.js";

const require_ = createRequire(import.meta.url);
const Ajv2020 = require_("ajv/dist/2020") as new (opts: Record<string, unknown>) => {
  compile(schema: object): { (data: unknown): boolean; errors?: unknown[] | null };
};
const addFormats = require_("ajv-formats") as (ajv: unknown) => void;

const SCHEMA_PATH = path.resolve("schemas/project-state.schema.json");
const FIXTURE_DIR = path.resolve("tests/fixtures/project_state");

function readJson(filePath: string): unknown {
  return JSON.parse(fs.readFileSync(filePath, "utf-8"));
}

function createValidator() {
  const schema = readJson(SCHEMA_PATH) as object;
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  return ajv.compile(schema);
}

describe("project_state planning_gate partial_override", () => {
  it("accepts partial_override as an additive planning_gate value", () => {
    const validate = createValidator();
    const fixture = readJson(path.join(FIXTURE_DIR, "partial-override-valid.json"));

    expect(validate(fixture), JSON.stringify(validate.errors, null, 2)).toBe(true);
  });

  it("treats blocked to partial_override as a warning-level non-blocking transition", () => {
    const transition = readJson(path.join(FIXTURE_DIR, "partial-override-transition.json")) as {
      from: { planning_gate: string };
      to: { planning_gate: string };
    };

    expect(interpretPlanningGate(transition.from.planning_gate)).toMatchObject({
      severity: "blocker",
      blocksRuntime: true,
    });
    expect(interpretPlanningGate(transition.to.planning_gate)).toMatchObject({
      severity: "warning",
      blocksRuntime: false,
    });
  });
});
