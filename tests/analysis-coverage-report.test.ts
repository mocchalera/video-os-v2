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
import { buildSourceLedger } from "../runtime/artifacts/source-ledger.js";
import { discoverRequestedSources } from "../runtime/media/source-discovery.js";
import type { AssetItem } from "../runtime/connectors/ffprobe.js";

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

function customRunnerLedger(projectId: string, sourceFile: string) {
  const discovery = discoverRequestedSources([sourceFile]);
  const canonicalPath = discovery.requests[0].canonical_path!;
  const asset = {
    asset_id: "AST_CUSTOM",
    filename: path.basename(sourceFile),
    duration_us: 1,
    has_transcript: false,
    transcript_ref: null,
    segments: 0,
    segment_ids: [],
    quality_flags: [],
    tags: [],
    source_fingerprint: "custom-fingerprint",
    contact_sheet_ids: [],
    analysis_status: "ready",
  } satisfies AssetItem;
  return buildSourceLedger(projectId, discovery, new Map([[canonicalPath, { canonicalPath, asset }]]), undefined, path.dirname(path.dirname(sourceFile)));
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

  it("writes canonical manifest and coverage from normal analyze even when the legacy P1 flag is off", async () => {
    const projectDir = makeProject();
    const sourceFile = path.join(projectDir, "02_media/source/test.mov");
    fs.mkdirSync(path.dirname(sourceFile), { recursive: true });
    fs.writeFileSync(sourceFile, "media", "utf-8");
    const runner: AnalyzeRunner = {
      async run(ctx) {
        return {
          artifactsCreated: ["03_analysis/assets.json"],
          sourceLedger: customRunnerLedger(ctx.projectId, sourceFile),
        };
      },
    };

    const result = await runAnalyze(projectDir, {
      sourceFiles: [sourceFile],
      skipPreflight: true,
    }, runner);

    expect(result.success, JSON.stringify(result.error)).toBe(true);
    expect(fs.existsSync(path.join(projectDir, "03_analysis/source_ledger.json"))).toBe(true);
    expect(fs.existsSync(path.join(projectDir, "02_media/source_media_manifest.json"))).toBe(true);
    expect(fs.existsSync(path.join(projectDir, "03_analysis/analysis_coverage_report.json"))).toBe(true);
  });

  it("writes manifest and coverage from analyze when the P1 flag is on", async () => {
    process.env.ENABLE_P1_MANIFEST_COVERAGE = "1";
    const projectDir = makeProject();
    const sourceFile = path.join(projectDir, "02_media/source/test.mov");
    fs.mkdirSync(path.dirname(sourceFile), { recursive: true });
    fs.writeFileSync(sourceFile, "media", "utf-8");
    const runner: AnalyzeRunner = {
      async run(ctx) {
        return {
          artifactsCreated: ["03_analysis/assets.json"],
          sourceLedger: customRunnerLedger(ctx.projectId, sourceFile),
        };
      },
    };

    const result = await runAnalyze(projectDir, {
      sourceFiles: [sourceFile],
      skipPreflight: true,
    }, runner);

    expect(result.success, JSON.stringify(result.error)).toBe(true);
    expect(fs.existsSync(path.join(projectDir, "02_media/source_media_manifest.json"))).toBe(true);
    expect(fs.existsSync(path.join(projectDir, "03_analysis/analysis_coverage_report.json"))).toBe(true);
    expect(result.artifactsCreated).toContain("03_analysis/analysis_coverage_report.json");
  });

  it("rejects a custom runner that omits the current-run ledger even when a stale ledger already exists", async () => {
    const projectDir = makeProject();
    const sourceFile = path.join(projectDir, "02_media/source/test.mov");
    fs.mkdirSync(path.dirname(sourceFile), { recursive: true });
    fs.writeFileSync(sourceFile, "media", "utf-8");
    const stale = customRunnerLedger("stale-project", sourceFile);
    fs.mkdirSync(path.join(projectDir, "03_analysis"), { recursive: true });
    fs.writeFileSync(path.join(projectDir, "03_analysis/source_ledger.json"), JSON.stringify(stale));
    const result = await runAnalyze(projectDir, {
      sourceFiles: [sourceFile],
      skipPreflight: true,
    }, { async run() { return {}; } });

    expect(result.success).toBe(false);
    expect(result.error?.message).toContain("must return the source ledger produced by the current run");
    expect(result.newState).toBeUndefined();
  });

  it("records both video and audio candidates as preflight failures when required tools are unavailable", async () => {
    const projectDir = makeProject();
    const video = path.join(projectDir, "02_media/source/video.mp4");
    const audio = path.join(projectDir, "02_media/source/audio.wav");
    fs.mkdirSync(path.dirname(video), { recursive: true });
    fs.writeFileSync(video, "video");
    fs.writeFileSync(audio, "audio");
    const originalPath = process.env.PATH;
    process.env.PATH = "";
    try {
      const result = await runAnalyze(projectDir, { sourceFiles: [video, audio] });
      expect(result.success).toBe(false);
    } finally {
      process.env.PATH = originalPath;
    }
    const ledger = readJson(path.join(projectDir, "03_analysis/source_ledger.json")) as {
      items: Array<{ media_kind: string; status: string; stage: string; reason: string }>;
    };
    expect(ledger.items.find((item) => item.media_kind === "video")).toMatchObject({
      status: "failed",
      stage: "preflight",
    });
    expect(ledger.items.find((item) => item.media_kind === "video")?.reason).toContain("preflight_failed:");
    expect(ledger.items.find((item) => item.media_kind === "audio")).toMatchObject({
      status: "failed",
      stage: "preflight",
    });
    expect(ledger.items.find((item) => item.media_kind === "audio")?.reason).toContain("preflight_failed:");
    expect((readJson(path.join(projectDir, "03_analysis/assets.json")) as { items: unknown[] }).items).toEqual([]);
    expect((readJson(path.join(projectDir, "03_analysis/segments.json")) as { items: unknown[] }).items).toEqual([]);
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
