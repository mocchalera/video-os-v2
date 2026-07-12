import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { createRequire } from "node:module";
import {
  buildAnalysisCoverageReport,
  validateAnalysisCoverageReport,
} from "../runtime/artifacts/p1-manifest-coverage.js";
import { runAnalyze, type AnalyzeRunner } from "../runtime/commands/analyze.js";
import { runStatus } from "../runtime/commands/status.js";

const require_ = createRequire(import.meta.url);
const Ajv2020 = require_("ajv/dist/2020") as new (opts: Record<string, unknown>) => {
  compile(schema: object): { (data: unknown): boolean; errors?: unknown[] | null };
};
const addFormats = require_("ajv-formats") as (ajv: unknown) => void;

const FIXTURE_DIR = path.resolve("tests/fixtures/analysis_coverage_report");
const SCHEMA_PATH = path.resolve("schemas/analysis-coverage-report.schema.json");
const SAMPLE_PROJECT = path.resolve("projects/sample");

const validFixtures = [
  "valid_ready_all_lanes.json",
  "valid_partial_override_stt.json",
  "valid_music_only_skipped_dialogue.json",
  "edge_stale_manifest_blocks.json",
  "edge_optional_embeddings_skipped.json",
];

const invalidFixtures = [
  "invalid_missing_source_manifest_hash.json",
  "invalid_ready_with_failed_required_lane.json",
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

function copyDirSync(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDirSync(srcPath, destPath);
    else fs.copyFileSync(srcPath, destPath);
  }
}

function makeProject(): string {
  const dir = fs.mkdtempSync(path.resolve("tests/.tmp-p1-coverage-"));
  tempDirs.push(dir);
  copyDirSync(SAMPLE_PROJECT, dir);
  return dir;
}

afterEach(() => {
  delete process.env.ENABLE_P1_MANIFEST_COVERAGE;
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("P1 analysis_coverage_report", () => {
  it.each(validFixtures)("accepts %s", (fixture) => {
    const validate = schemaValidator();
    const data = readJson(path.join(FIXTURE_DIR, fixture));

    expect(validate(data), JSON.stringify(validate.errors, null, 2)).toBe(true);
    expect(validateAnalysisCoverageReport(data).valid).toBe(true);
  });

  it.each(invalidFixtures)("rejects %s", (fixture) => {
    const validate = schemaValidator();
    const data = readJson(path.join(FIXTURE_DIR, fixture));
    const schemaOk = validate(data);
    const runnerOk = validateAnalysisCoverageReport(data).valid;

    expect(schemaOk && runnerOk).toBe(false);
  });

  it("blocks readiness when the source manifest lane is stale", () => {
    const report = readJson(path.join(FIXTURE_DIR, "edge_stale_manifest_blocks.json"));
    const validation = validateAnalysisCoverageReport(report);

    expect(validation.valid).toBe(true);
    expect((report as { summary: { status: string } }).summary.status).toBe("blocked");
  });

  it("allows optional embeddings to be skipped without compile_block impact", () => {
    const report = readJson(path.join(FIXTURE_DIR, "edge_optional_embeddings_skipped.json")) as {
      lanes: Array<{ lane_id: string; required: boolean; consumer_impact: string }>;
    };
    const embeddings = report.lanes.find((lane) => lane.lane_id === "embeddings");

    expect(validateAnalysisCoverageReport(report).valid).toBe(true);
    expect(embeddings).toMatchObject({ required: false, consumer_impact: "triage_warn" });
  });

  it("builds coverage from a manifest with missing source as blocked", () => {
    const manifest = readJson(path.resolve("tests/fixtures/source_media_manifest/edge_missing_source.json"));
    const report = buildAnalysisCoverageReport({
      projectId: "missing-source",
      manifest,
      createdAt: "2026-04-26T00:00:00Z",
    });

    expect(report.summary.status).toBe("blocked");
    expect(report.blockers[0].lane_id).toBe("source_manifest");
  });

  it("does not write manifest or coverage from analyze when the P1 flag is off", async () => {
    const projectDir = makeProject();
    const sourceFile = path.join(projectDir, "02_media/source/test.mov");
    fs.mkdirSync(path.dirname(sourceFile), { recursive: true });
    fs.writeFileSync(sourceFile, "media", "utf-8");
    const runner: AnalyzeRunner = {
      async run() {
        return { artifactsCreated: ["03_analysis/assets.json"] };
      },
    };

    const result = await runAnalyze(projectDir, {
      sourceFiles: [sourceFile],
      skipPreflight: true,
    }, runner);

    expect(result.success).toBe(true);
    expect(fs.existsSync(path.join(projectDir, "02_media/source_media_manifest.json"))).toBe(false);
    expect(fs.existsSync(path.join(projectDir, "03_analysis/analysis_coverage_report.json"))).toBe(false);
  });

  it("writes manifest and coverage from analyze when the P1 flag is on", async () => {
    process.env.ENABLE_P1_MANIFEST_COVERAGE = "1";
    const projectDir = makeProject();
    const sourceFile = path.join(projectDir, "02_media/source/test.mov");
    fs.mkdirSync(path.dirname(sourceFile), { recursive: true });
    fs.writeFileSync(sourceFile, "media", "utf-8");
    const runner: AnalyzeRunner = {
      async run() {
        return { artifactsCreated: ["03_analysis/assets.json"] };
      },
    };

    const result = await runAnalyze(projectDir, {
      sourceFiles: [sourceFile],
      skipPreflight: true,
    }, runner);

    expect(result.success).toBe(true);
    expect(fs.existsSync(path.join(projectDir, "02_media/source_media_manifest.json"))).toBe(true);
    expect(fs.existsSync(path.join(projectDir, "03_analysis/analysis_coverage_report.json"))).toBe(true);
    expect(result.artifactsCreated).toContain("03_analysis/analysis_coverage_report.json");
  });

  it("hides coverage status output when the P1 flag is off", () => {
    const projectDir = makeProject();
    fs.mkdirSync(path.join(projectDir, "03_analysis"), { recursive: true });
    fs.copyFileSync(
      path.join(FIXTURE_DIR, "edge_stale_manifest_blocks.json"),
      path.join(projectDir, "03_analysis/analysis_coverage_report.json"),
    );

    expect(runStatus(projectDir).coverage).toBeUndefined();
  });

  it("shows coverage status output when the P1 flag is on", () => {
    process.env.ENABLE_P1_MANIFEST_COVERAGE = "1";
    const projectDir = makeProject();
    fs.mkdirSync(path.join(projectDir, "03_analysis"), { recursive: true });
    fs.copyFileSync(
      path.join(FIXTURE_DIR, "edge_stale_manifest_blocks.json"),
      path.join(projectDir, "03_analysis/analysis_coverage_report.json"),
    );

    expect(runStatus(projectDir).coverage).toMatchObject({
      status: "blocked",
      blockedLaneCount: 1,
    });
  });
});
