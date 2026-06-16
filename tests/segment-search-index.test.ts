import { afterEach, describe, expect, it } from "vitest";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { stringify as stringifyYaml } from "yaml";
import { runTriage, type TriageAgent } from "../runtime/commands/triage.js";
import {
  computeSearchIndexManifestHash,
  computeSegmentTextIndexHash,
  currentSearchIndexInputHashes,
  generateSearchStaleCheck,
  isP4dSearchIndexEnabled,
  loadSearchIndexManifest,
  materializeSearchHash,
  searchIndexStaleReasons,
  validateTextIndexAssetRefs,
} from "../runtime/artifacts/p4d-segment-search-index.js";
import { writeProjectState } from "../runtime/state/reconcile.js";

const require_ = createRequire(import.meta.url);
const Ajv2020 = require_("ajv/dist/2020") as new (opts: Record<string, unknown>) => {
  compile(schema: object): { (data: unknown): boolean; errors?: unknown[] | null };
};
const addFormats = require_("ajv-formats") as (ajv: unknown) => void;

const SEARCH_FIXTURE_DIR = path.resolve("tests/fixtures/segment_search_index");
const TEXT_FIXTURE_DIR = path.resolve("tests/fixtures/segment_text_index");
const SEARCH_SCHEMA_PATH = path.resolve("schemas/segment-search-index-manifest.schema.json");
const TEXT_SCHEMA_PATH = path.resolve("schemas/segment-text-index.schema.json");

const tempDirs: string[] = [];

afterEach(() => {
  delete process.env.ENABLE_P4D_SEARCH_INDEX;
  delete process.env.SEARCH_INDEX_AUTONOMY;
  for (const dir of tempDirs.splice(0)) {
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  }
});

function readJson(filePath: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(filePath, "utf-8")) as Record<string, unknown>;
}

function schemaValidator(schemaPath: string): ReturnType<InstanceType<typeof Ajv2020>["compile"]> {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  return ajv.compile(readJson(schemaPath));
}

function makeProject(name = "p4d-search-index"): string {
  const projectDir = fs.mkdtempSync(path.resolve(`${name}-`));
  tempDirs.push(projectDir);
  for (const rel of ["01_intent", "02_media", "03_analysis/search", "03_analysis/transcripts", "04_plan", "05_timeline"]) {
    fs.mkdirSync(path.join(projectDir, rel), { recursive: true });
  }
  writeProjectState(projectDir, {
    version: 1,
    project_id: "p4d-runtime",
    current_state: "media_analyzed",
    history: [],
  });
  fs.writeFileSync(path.join(projectDir, "01_intent/creative_brief.yaml"), stringifyYaml({
    project: { title: "P4d", strategy: "search test", runtime_target_sec: 30 },
    message: { primary: "test" },
    audience: { primary: "operator" },
    emotion_curve: ["curiosity"],
    must_have: [],
    must_avoid: [],
    autonomy: { mode: "full", may_decide: [], must_ask: [] },
    resolved_assumptions: [],
  }));
  fs.writeFileSync(path.join(projectDir, "01_intent/unresolved_blockers.yaml"), stringifyYaml({
    version: "1",
    project_id: "p4d-runtime",
    blockers: [],
  }));
  writeJson(projectDir, "02_media/source_media_manifest.json", {
    version: "1.0.0",
    project_id: "p4d-runtime",
    artifact_version: "manifest-v1",
    created_at: "2026-04-27T00:00:00Z",
    source_root: { locator: ".", locator_kind: "local_path" },
    items: [{
      asset_id: "AST_runtime_001",
      source_locator: "media/a.mp4",
      filename: "a.mp4",
      content_hash: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      fingerprint: null,
      size_bytes: 1,
      mtime: "2026-04-27T00:00:00Z",
      media_kind: "video",
      ingest_status: "ready",
      rights_status: "operator_declared_ok",
      privacy_status: "operator_declared_ok",
      analysis_policy_ref: "APOL_default",
      capture_started_at: null,
      capture_timezone: null,
      timecode_start: null,
      timecode_format: "none",
      sample_rate: null,
      duration_us: 1000000,
      frame_rate_mode: "cfr",
      rotation: 0,
      audio_video_offset_ms: null,
      clock_source: "file_metadata",
    }],
    provenance: {
      producer: "analysis-ingest",
      inputs: [{ path: ".", hash: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" }],
      hash_policy: { algorithm: "sha256", canonicalization: "normalized-json-v1", excluded_fields: ["created_at"] },
    },
  });
  writeJson(projectDir, "03_analysis/assets.json", {
    version: "1.0.0",
    project_id: "p4d-runtime",
    assets: [{ asset_id: "AST_runtime_001", path: "media/a.mp4", kind: "video" }],
  });
  writeJson(projectDir, "03_analysis/segments.json", {
    version: "1.0.0",
    project_id: "p4d-runtime",
    segments: [{
      segment_id: "SEG_AST_runtime_001_0001",
      asset_id: "AST_runtime_001",
      start_us: 0,
      end_us: 1000000,
      transcript_excerpt: "今日は山に行く",
      visual_tags: ["mountain"],
    }],
  });
  writeJson(projectDir, "03_analysis/transcripts/AST_runtime_001.json", {
    version: "1.0.0",
    project_id: "p4d-runtime",
    asset_id: "AST_runtime_001",
    text: "今日は山に行く",
  });
  writeJson(projectDir, "03_analysis/analysis_coverage_report.json", {
    version: "1.0.0",
    project_id: "p4d-runtime",
    artifact_version: "analysis-v1",
    created_at: "2026-04-27T00:00:00Z",
    source_media_manifest_hash: "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
    summary: { status: "ready", required_lane_count: 1, ready_lane_count: 1, blocked_lane_count: 0, partial_lane_count: 0 },
    lanes: [],
    assets: [],
    blockers: [],
    overrides: [],
    provenance: { producer: "analysis-pipeline", inputs: [], hash_policy: { algorithm: "sha256", canonicalization: "normalized-json-v1", excluded_fields: ["created_at"] } },
  });
  writeJson(projectDir, "05_timeline/timeline.json", {
    version: "tl_fixture",
    project_id: "p4d-runtime",
    created_at: "2026-04-27T00:00:00Z",
  });
  return projectDir;
}

function makeTriageProject(): string {
  const projectDir = fs.mkdtempSync(path.resolve("p4d-triage-search-"));
  tempDirs.push(projectDir);
  copyDirSync(path.resolve("projects/sample"), projectDir);
  writeProjectState(projectDir, {
    version: 1,
    project_id: "p4d-runtime",
    current_state: "media_analyzed",
    history: [],
  });
  fs.mkdirSync(path.join(projectDir, "03_analysis/search"), { recursive: true });
  return projectDir;
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

function writeJson(projectDir: string, relPath: string, value: unknown): void {
  const filePath = path.join(projectDir, relPath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}

function copyFixture(projectDir: string, fixtureName: string): Record<string, unknown> {
  const manifest = readJson(path.join(SEARCH_FIXTURE_DIR, fixtureName));
  writeJson(projectDir, "03_analysis/search/segment_search_index_manifest.json", manifest);
  return manifest;
}

describe("P4d segment search index schemas", () => {
  it.each([
    "valid_minimal.json",
    "valid_full_index.json",
    "valid_no_vector_shards.json",
  ])("accepts valid manifest fixture %s", (fixture) => {
    const validate = schemaValidator(SEARCH_SCHEMA_PATH);
    const data = readJson(path.join(SEARCH_FIXTURE_DIR, fixture));

    expect(validate(data), JSON.stringify(validate.errors, null, 2)).toBe(true);
  });

  it.each([
    "invalid_missing_input_hash.json",
    "invalid_index_id_pattern.json",
  ])("rejects invalid manifest fixture %s", (fixture) => {
    const validate = schemaValidator(SEARCH_SCHEMA_PATH);
    const data = readJson(path.join(SEARCH_FIXTURE_DIR, fixture));

    expect(validate(data)).toBe(false);
  });

  it("keeps stale-input edge manifest schema-valid and runtime-stale", () => {
    const validate = schemaValidator(SEARCH_SCHEMA_PATH);
    const data = readJson(path.join(SEARCH_FIXTURE_DIR, "edge_stale_inputs.json"));
    const inputs = data.inputs as Record<string, unknown>;

    expect(validate(data), JSON.stringify(validate.errors, null, 2)).toBe(true);
    expect(searchIndexStaleReasons(data, {
      source_media_manifest_hash: "sha256:1111111111111111111111111111111111111111111111111111111111111111",
      assets_hash: inputs.assets_hash as string,
      segments_hash: inputs.segments_hash as string,
      transcripts_hashes: [],
      audio_story_graph_hash: null,
      continuity_graph_hash: null,
      editorial_preference_memory_hash: null,
      coverage_report_hash: inputs.coverage_report_hash as string,
    }).some((reason: string) => reason.includes("source_media_manifest_hash"))).toBe(true);
  });

  it.each([
    "valid_minimal.json",
    "valid_japanese_tokens.json",
  ])("accepts valid text index fixture %s", (fixture) => {
    const validate = schemaValidator(TEXT_SCHEMA_PATH);
    const data = readJson(path.join(TEXT_FIXTURE_DIR, fixture));

    expect(validate(data), JSON.stringify(validate.errors, null, 2)).toBe(true);
    expect(validateTextIndexAssetRefs(data, new Set(["AST_001", "AST_jp"])).valid).toBe(true);
  });

  it("rejects invalid text index segment id pattern", () => {
    const validate = schemaValidator(TEXT_SCHEMA_PATH);
    const data = readJson(path.join(TEXT_FIXTURE_DIR, "invalid_segment_id_pattern.json"));

    expect(validate(data)).toBe(false);
  });

  it("computes deterministic normalized-json-v1 hashes with created_at excluded", () => {
    const manifest = readJson(path.join(SEARCH_FIXTURE_DIR, "valid_full_index.json"));
    const textIndex = readJson(path.join(TEXT_FIXTURE_DIR, "valid_japanese_tokens.json"));

    expect(computeSearchIndexManifestHash(manifest)).toBe(computeSearchIndexManifestHash({ ...manifest, created_at: "2026-04-28T00:00:00Z" }));
    expect(computeSegmentTextIndexHash(textIndex)).toBe(computeSegmentTextIndexHash({ ...textIndex, created_at: "2026-04-28T00:00:00Z" }));
    expect(computeSearchIndexManifestHash(manifest)).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it("enforces index_id and shard_id prefixes through schema", () => {
    const validate = schemaValidator(SEARCH_SCHEMA_PATH);
    const data = readJson(path.join(SEARCH_FIXTURE_DIR, "valid_full_index.json"));
    data.index_id = "BAD_001";
    expect(validate(data)).toBe(false);

    data.index_id = "SIDX_full";
    (data.vector_shards as Array<Record<string, unknown>>)[0].shard_id = "BAD_001";
    expect(validate(data)).toBe(false);
  });

  it("rejects text index asset refs that are not present in the manifest asset set", () => {
    const index = readJson(path.join(TEXT_FIXTURE_DIR, "valid_minimal.json"));

    const result = validateTextIndexAssetRefs(index, new Set(["AST_other"]));

    expect(result.valid).toBe(false);
    expect(result.violations[0]).toContain("AST_001");
  });
});

describe("P4d search index runtime integration", () => {
  it("detects stale manifest inputs against current canonical artifact hashes", () => {
    const projectDir = makeProject();
    process.env.ENABLE_P4D_SEARCH_INDEX = "true";
    const manifest = copyFixture(projectDir, "valid_minimal.json");

    const current = currentSearchIndexInputHashes(projectDir);
    const reasons = searchIndexStaleReasons(manifest, current);

    expect(reasons.length).toBeGreaterThan(0);
  });

  it("generates source_manifest stale checks with autonomy-specific severity", () => {
    const manifest = readJson(path.join(SEARCH_FIXTURE_DIR, "edge_stale_inputs.json"));
    const current = {
      ...(manifest.inputs as Record<string, unknown>),
      source_media_manifest_hash: "sha256:1111111111111111111111111111111111111111111111111111111111111111",
    };

    expect(generateSearchStaleCheck(manifest, current, "full")?.severity).toBe("blocker");
    expect(generateSearchStaleCheck(manifest, current, "interactive")?.severity).toBe("warning");
  });

  it("materializes search index manifest hash as optional selects provenance", () => {
    const selects: Record<string, unknown> = {
      version: "1.0.0",
      project_id: "p4d-runtime",
      candidates: [],
    };

    materializeSearchHash(selects, "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");

    expect((selects.provenance as Record<string, unknown>).search_index_manifest_hash).toBe("sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  });

  it("triage materializes search hash only when the P4d feature flag is enabled", async () => {
    const projectDir = makeTriageProject();
    const manifest = copyFixture(projectDir, "valid_minimal.json");
    const hash = computeSearchIndexManifestHash(manifest);
    const agent: TriageAgent = {
      async run() {
        return {
          confirmed: true,
          selects: {
            version: "1.0.0",
            project_id: "p4d-runtime",
            candidates: [{
              segment_id: "SEG_AST_runtime_001_0001",
              asset_id: "AST_runtime_001",
              src_in_us: 0,
              src_out_us: 1000000,
              role: "dialogue",
              why_it_matches: "search result: 山",
              risks: [],
              confidence: 0.8,
              evidence: ["search:segment_text_index"],
              transcript_excerpt: "今日は山に行く",
            }],
          },
        };
      },
    };

    expect(isP4dSearchIndexEnabled()).toBe(false);
    const offResult = await runTriage(projectDir, agent);
    expect(offResult.success, JSON.stringify(offResult.error)).toBe(true);
    const offSelects = fs.readFileSync(path.join(projectDir, "04_plan/selects_candidates.yaml"), "utf-8");
    expect(offSelects).not.toContain("search_index_manifest_hash");

    process.env.ENABLE_P4D_SEARCH_INDEX = "true";
    const onResult = await runTriage(projectDir, agent);
    expect(onResult.success, JSON.stringify(onResult.error)).toBe(true);
    const onSelects = fs.readFileSync(path.join(projectDir, "04_plan/selects_candidates.yaml"), "utf-8");
    expect(onSelects).toContain(`search_index_manifest_hash: ${hash}`);
  });

  it("rebuild CLI requires the feature flag and writes manifest plus text index when enabled", () => {
    const projectDir = makeProject();
    const outputDir = path.join(projectDir, "03_analysis/search");

    expect(() => execFileSync("npx", ["tsx", "scripts/rebuild-segment-search-index.ts", "--project", projectDir, "--output-dir", outputDir, "--tokenizer", "japanese_morpheme"], {
      cwd: path.resolve("."),
      encoding: "utf-8",
      env: { ...process.env, ENABLE_P4D_SEARCH_INDEX: "" },
    })).toThrow();

    const output = execFileSync("npx", ["tsx", "scripts/rebuild-segment-search-index.ts", "--project", projectDir, "--output-dir", outputDir, "--tokenizer", "japanese_morpheme"], {
      cwd: path.resolve("."),
      encoding: "utf-8",
      env: { ...process.env, ENABLE_P4D_SEARCH_INDEX: "true" },
    });
    const parsed = JSON.parse(output) as { manifest: string; text_index: string; manifest_hash: string };

    expect(fs.existsSync(parsed.manifest)).toBe(true);
    expect(fs.existsSync(parsed.text_index)).toBe(true);
    expect(parsed.manifest_hash).toMatch(/^sha256:[a-f0-9]{64}$/);
    process.env.ENABLE_P4D_SEARCH_INDEX = "true";
    expect(loadSearchIndexManifest(projectDir).manifest?.hash).toBe(parsed.manifest_hash);
  }, 30_000);

  it("keeps demo timeline canonical hash unchanged with P4d disabled", () => {
    const timeline = readJson(path.resolve("projects/demo/05_timeline/timeline.json"));
    delete timeline.created_at;
    const hash = crypto.createHash("sha256").update(JSON.stringify(timeline), "utf-8").digest("hex");

    expect(hash).toBe("6d04dda3c5125310b8251801dd5258525132b1f9297bd963c5275d3565625f55");
  });
});
