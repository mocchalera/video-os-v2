import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import {
  computeNormalizedJsonHash,
  validateSourceMediaManifest,
} from "../runtime/artifacts/p1-manifest-coverage.js";
import { initProject } from "../scripts/init-project.js";
import { runStatus } from "../runtime/commands/status.js";

const require_ = createRequire(import.meta.url);
const Ajv2020 = require_("ajv/dist/2020") as new (opts: Record<string, unknown>) => {
  compile(schema: object): { (data: unknown): boolean; errors?: unknown[] | null };
};
const addFormats = require_("ajv-formats") as (ajv: unknown) => void;

const FIXTURE_DIR = path.resolve("tests/fixtures/source_media_manifest");
const SCHEMA_PATH = path.resolve("schemas/source-media-manifest.schema.json");
const TEMPLATE_DIR = path.resolve("projects/_template");
const DEMO_TIMELINE = path.resolve("projects/demo/05_timeline/timeline.json");

const validFixtures = [
  "valid_minimal.json",
  "valid_mixed_media.json",
  "valid_inferred_timecode.json",
  "edge_missing_source.json",
  "edge_stale_source.json",
];

const invalidFixtures = [
  "invalid_missing_fingerprint.json",
  "invalid_bad_asset_prefix.json",
];

const tempDirs: string[] = [];

function readJson(filePath: string): unknown {
  return JSON.parse(fs.readFileSync(filePath, "utf-8"));
}

function schemaValidator(): ReturnType<InstanceType<typeof Ajv2020>["compile"]> {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  return ajv.compile(readJson(SCHEMA_PATH) as object);
}

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.resolve("tests/.tmp-p1-manifest-"));
  tempDirs.push(dir);
  return dir;
}

function sha256File(filePath: string): string {
  return execFileSync("shasum", ["-a", "256", filePath], { encoding: "utf-8" }).trim();
}

afterEach(() => {
  delete process.env.ENABLE_P1_MANIFEST_COVERAGE;
  delete process.env.ENABLE_P1_MANIFEST;
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("P1 source_media_manifest", () => {
  it.each(validFixtures)("accepts %s", (fixture) => {
    const validate = schemaValidator();
    const data = readJson(path.join(FIXTURE_DIR, fixture));

    expect(validate(data), JSON.stringify(validate.errors, null, 2)).toBe(true);
    expect(validateSourceMediaManifest(data).valid).toBe(true);
  });

  it.each(invalidFixtures)("rejects %s", (fixture) => {
    const validate = schemaValidator();
    const data = readJson(path.join(FIXTURE_DIR, fixture));
    const schemaOk = validate(data);
    const runnerOk = validateSourceMediaManifest(data).valid;

    expect(schemaOk && runnerOk).toBe(false);
  });

  it("keeps missing and stale source fixtures schema-valid for coverage to interpret", () => {
    const missing = validateSourceMediaManifest(readJson(path.join(FIXTURE_DIR, "edge_missing_source.json")));
    const stale = validateSourceMediaManifest(readJson(path.join(FIXTURE_DIR, "edge_stale_source.json")));

    expect(missing.valid).toBe(true);
    expect(stale.valid).toBe(true);
  });

  it("computes normalized-json-v1 hashes deterministically", () => {
    const one = { z: "last", nested: { b: 2, a: 1 }, list: ["x", "y"] };
    const two = { list: ["x", "y"], nested: { a: 1, b: 2 }, z: "last" };

    expect(computeNormalizedJsonHash(one)).toBe(computeNormalizedJsonHash(two));
    expect(computeNormalizedJsonHash(one)).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it("validates artifact_version, asset_id, and analysis_policy_ref patterns", () => {
    const validate = schemaValidator();
    const data = readJson(path.join(FIXTURE_DIR, "valid_minimal.json")) as Record<string, unknown>;

    data.artifact_version = "manifest";
    expect(validate(data)).toBe(false);

    const assetData = readJson(path.join(FIXTURE_DIR, "valid_minimal.json")) as { items: Array<Record<string, unknown>> };
    assetData.items[0].asset_id = "BAD_001";
    expect(validate(assetData)).toBe(false);

    const policyData = readJson(path.join(FIXTURE_DIR, "valid_minimal.json")) as { items: Array<Record<string, unknown>> };
    policyData.items[0].analysis_policy_ref = "POL_default";
    expect(validate(policyData)).toBe(false);
  });

  it("does not create a manifest from init-project when the P1 flag is off", () => {
    const root = makeTempDir();
    const sourceDir = path.join(root, "source");
    fs.mkdirSync(sourceDir);
    fs.writeFileSync(path.join(sourceDir, "clip.mov"), "media", "utf-8");

    const result = initProject("flag-off", {
      projectsDir: path.join(root, "projects"),
      templateDir: TEMPLATE_DIR,
      sourceDir,
    });

    expect(fs.existsSync(path.join(result.projectDir, "02_media/source_media_manifest.json"))).toBe(false);
  });

  it("creates an initial manifest from init-project when the P1 flag is on", () => {
    process.env.ENABLE_P1_MANIFEST_COVERAGE = "1";
    const root = makeTempDir();
    const sourceDir = path.join(root, "source");
    fs.mkdirSync(sourceDir);
    fs.writeFileSync(path.join(sourceDir, "clip.mov"), "media", "utf-8");

    const result = initProject("flag-on", {
      projectsDir: path.join(root, "projects"),
      templateDir: TEMPLATE_DIR,
      sourceDir,
    });
    const manifestPath = path.join(result.projectDir, "02_media/source_media_manifest.json");
    const manifest = readJson(manifestPath);

    expect(fs.existsSync(manifestPath)).toBe(true);
    expect(validateSourceMediaManifest(manifest).valid).toBe(true);
  });

  it("keeps demo timeline byte-stable when P1 flag is off", () => {
    delete process.env.ENABLE_P1_MANIFEST_COVERAGE;
    const before = sha256File(DEMO_TIMELINE);

    runStatus(path.resolve("projects/demo"));

    expect(sha256File(DEMO_TIMELINE)).toBe(before);
  });
});
