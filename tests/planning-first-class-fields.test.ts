import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { createRequire } from "node:module";
import { parse as parseYaml } from "yaml";

const require_ = createRequire(import.meta.url);
const Ajv2020 = require_("ajv/dist/2020") as new (opts: Record<string, unknown>) => {
  addSchema(schema: object): void;
  compile(schema: object): { (data: unknown): boolean; errors?: unknown[] | null };
};
const addFormats = require_("ajv-formats") as (ajv: unknown) => void;

function readJson(filePath: string): unknown {
  return JSON.parse(fs.readFileSync(filePath, "utf-8"));
}

function readYaml(filePath: string): unknown {
  return parseYaml(fs.readFileSync(filePath, "utf-8"));
}

function createValidator(schemaFile: string): ReturnType<InstanceType<typeof Ajv2020>["compile"]> {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  ajv.addSchema(readJson(path.resolve("schemas/analysis-common.schema.json")) as object);
  return ajv.compile(readJson(path.resolve("schemas", schemaFile)) as object);
}

describe("planning first-class graph refs", () => {
  it.each([
    "valid_with_first_class_refs.json",
    "valid_empty_first_class_refs.json",
  ])("accepts selects_candidates fixture %s", (fixture) => {
    const validate = createValidator("selects-candidates.schema.json");
    const data = readJson(path.resolve("tests/fixtures/selects_candidates_first_class", fixture));

    expect(validate(data), JSON.stringify(validate.errors, null, 2)).toBe(true);
  });

  it.each([
    "valid_with_first_class_refs.json",
    "valid_empty_first_class_refs.json",
  ])("accepts edit_blueprint fixture %s", (fixture) => {
    const validate = createValidator("edit-blueprint.schema.json");
    const data = readJson(path.resolve("tests/fixtures/edit_blueprint_first_class", fixture));

    expect(validate(data), JSON.stringify(validate.errors, null, 2)).toBe(true);
  });

  it("keeps existing planning artifacts valid without first-class fields", () => {
    const selectsValidate = createValidator("selects-candidates.schema.json");
    const blueprintValidate = createValidator("edit-blueprint.schema.json");
    const planningFiles = findPlanningFiles();

    for (const filePath of planningFiles.selects) {
      const data = readYaml(filePath);
      expect(selectsValidate(data), `${filePath}\n${JSON.stringify(selectsValidate.errors, null, 2)}`).toBe(true);
    }
    for (const filePath of planningFiles.blueprints) {
      const data = readYaml(filePath);
      expect(blueprintValidate(data), `${filePath}\n${JSON.stringify(blueprintValidate.errors, null, 2)}`).toBe(true);
    }
  });

  it("rejects invalid first-class ID prefixes", () => {
    const selectsValidate = createValidator("selects-candidates.schema.json");
    const selects = readJson(path.resolve("tests/fixtures/selects_candidates_first_class/valid_with_first_class_refs.json")) as {
      candidates: Array<{ audio_story_refs: Array<{ node_id: string }>; continuity_refs: Array<{ entity_id: string; risk_id: string }> }>;
    };
    selects.candidates[0].audio_story_refs[0].node_id = "BAD_001";
    expect(selectsValidate(selects)).toBe(false);

    const blueprintValidate = createValidator("edit-blueprint.schema.json");
    const blueprint = readJson(path.resolve("tests/fixtures/edit_blueprint_first_class/valid_with_first_class_refs.json")) as {
      beats: Array<{ continuity_constraint: { enforced_entity_ids: string[] }; applied_preferences: Array<{ entry_id: string }> }>;
    };
    blueprint.beats[0].continuity_constraint.enforced_entity_ids = ["SEG_not_an_entity"];
    blueprint.beats[0].applied_preferences[0].entry_id = "BAD_pref";
    expect(blueprintValidate(blueprint)).toBe(false);
  });
});

function findPlanningFiles(): { selects: string[]; blueprints: string[] } {
  const projectsDir = path.resolve("projects");
  const selects: string[] = [];
  const blueprints: string[] = [];
  for (const project of fs.readdirSync(projectsDir)) {
    const planDir = path.join(projectsDir, project, "04_plan");
    if (!fs.existsSync(planDir)) continue;
    const selectsPath = path.join(planDir, "selects_candidates.yaml");
    const blueprintPath = path.join(planDir, "edit_blueprint.yaml");
    if (fs.existsSync(selectsPath)) selects.push(selectsPath);
    if (fs.existsSync(blueprintPath)) blueprints.push(blueprintPath);
  }
  return { selects: selects.sort(), blueprints: blueprints.sort() };
}
