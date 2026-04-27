import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import {
  buildContinuityGraph,
  computeContinuityGraphHash,
  isContinuityGraphStale,
  isP3ContinuityPreferenceEnabled,
  sortContinuityGraph,
  validateContinuityGraph,
} from "../runtime/artifacts/p3-continuity-graph.js";

const require_ = createRequire(import.meta.url);
const Ajv2020 = require_("ajv/dist/2020") as new (opts: Record<string, unknown>) => {
  addSchema(schema: object): void;
  compile(schema: object): { (data: unknown): boolean; errors?: unknown[] | null };
};
const addFormats = require_("ajv-formats") as (ajv: unknown) => void;

const FIXTURE_DIR = path.resolve("tests/fixtures/continuity_graph");
const SCHEMA_PATH = path.resolve("schemas/continuity-graph.schema.json");
const COMMON_SCHEMA_PATH = path.resolve("schemas/analysis-common.schema.json");
const DEMO_TIMELINE = path.resolve("projects/demo/05_timeline/timeline.json");
const MANIFEST_HASH = "sha256:1111111111111111111111111111111111111111111111111111111111111111";
const MANIFEST_ASSETS = ["AST_a", "AST_b"];

function readJson(filePath: string): unknown {
  return JSON.parse(fs.readFileSync(filePath, "utf-8"));
}

function schemaValidator(): ReturnType<InstanceType<typeof Ajv2020>["compile"]> {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  ajv.addSchema(readJson(COMMON_SCHEMA_PATH) as object);
  return ajv.compile(readJson(SCHEMA_PATH) as object);
}

function canonicalTimelineHash(): string {
  const data = readJson(DEMO_TIMELINE) as Record<string, unknown>;
  delete data.created_at;
  return execFileSync("shasum", ["-a", "256"], {
    input: JSON.stringify(data),
    encoding: "utf-8",
  }).trim().split(/\s+/)[0];
}

afterEach(() => {
  delete process.env.ENABLE_P3_CONTINUITY_PREFERENCE;
});

describe("P3 continuity_graph", () => {
  it.each([
    "valid_multi_asset_chronological.json",
    "valid_editorial_reorder.json",
    "valid_anonymous_subject_clusters.json",
  ])("accepts %s", (fixture) => {
    const validate = schemaValidator();
    const data = readJson(path.join(FIXTURE_DIR, fixture));

    expect(validate(data), JSON.stringify(validate.errors, null, 2)).toBe(true);
    expect(validateContinuityGraph(data, { manifestAssetIds: MANIFEST_ASSETS }).valid).toBe(true);
  });

  it("rejects confirmed editing-continuity identity labels unless human_confirmed", () => {
    const validate = schemaValidator();
    const data = readJson(path.join(FIXTURE_DIR, "invalid_confirmed_identity_without_human_status.json"));

    expect(validate(data), JSON.stringify(validate.errors, null, 2)).toBe(true);
    const result = validateContinuityGraph(data, { manifestAssetIds: MANIFEST_ASSETS });
    expect(result.valid).toBe(false);
    expect(result.violations.join("\n")).toContain("human_confirmed");
  });

  it("rejects segment asset refs outside the manifest", () => {
    const validate = schemaValidator();
    const data = readJson(path.join(FIXTURE_DIR, "invalid_missing_manifest_asset.json"));

    expect(validate(data)).toBe(false);
    const result = validateContinuityGraph(data, { manifestAssetIds: MANIFEST_ASSETS });
    expect(result.valid).toBe(false);
  });

  it.each([
    ["edge_screen_direction_break.json", "axis_break", "CONRISK_axis_001"],
    ["edge_duplicate_semantic_content.json", "duplicate_content", "CONRISK_duplicate_001"],
  ])("keeps %s schema-valid and materializes expected risks", (fixture, riskType, riskId) => {
    const validate = schemaValidator();
    const data = readJson(path.join(FIXTURE_DIR, fixture)) as { risks: Array<{ risk_id: string; type: string }> };

    expect(validate(data), JSON.stringify(validate.errors, null, 2)).toBe(true);
    expect(validateContinuityGraph(data, { manifestAssetIds: MANIFEST_ASSETS }).valid).toBe(true);
    expect(data.risks).toContainEqual(expect.objectContaining({ risk_id: riskId, type: riskType }));
  });

  it("enforces graph-local foreign reference integrity", () => {
    const data = readJson(path.join(FIXTURE_DIR, "valid_multi_asset_chronological.json")) as {
      entities: Array<{ evidence_segment_ids: string[] }>;
      segments: Array<{ entity_ids: string[] }>;
      edges: Array<{ to_ref: string }>;
    };
    data.edges[0].to_ref = "SEG_missing";
    data.entities[0].evidence_segment_ids.push("SEG_missing");
    data.segments[0].entity_ids.push("ENT_PROP_missing");

    const result = validateContinuityGraph(data, { manifestAssetIds: MANIFEST_ASSETS });
    expect(result.valid).toBe(false);
    expect(result.violations.join("\n")).toContain("SEG_missing");
    expect(result.violations.join("\n")).toContain("ENT_PROP_missing");
  });

  it("computes stable graph hashes with created_at excluded", () => {
    const graph = readJson(path.join(FIXTURE_DIR, "valid_multi_asset_chronological.json")) as Record<string, unknown>;
    const later = { ...graph, created_at: "2026-04-27T00:00:00Z" };

    expect(computeContinuityGraphHash(graph)).toBe(computeContinuityGraphHash(later));
    expect(computeContinuityGraphHash(graph)).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it("builds deterministic graph ordering and hash from identical inputs", () => {
    const input = {
      projectId: "continuity-build",
      manifest: {
        source_media_manifest_hash: MANIFEST_HASH,
        items: [{ asset_id: "AST_b" }, { asset_id: "AST_a" }],
      },
      coverageReport: {
        hash: "sha256:5555555555555555555555555555555555555555555555555555555555555555",
        lanes: [{ lane_id: "segments", status: "ready" }],
      },
      assets: {
        items: [
          { asset_id: "AST_b", segment_ids: ["SEG_b_payoff"] },
          { asset_id: "AST_a", segment_ids: ["SEG_a_intro"] },
        ],
      },
      segments: {
        items: [
          { segment_id: "SEG_b_payoff", asset_id: "AST_b", src_in_us: 3000000, src_out_us: 5000000, tags: ["park", "child", "ball"] },
          { segment_id: "SEG_a_intro", asset_id: "AST_a", src_in_us: 0, src_out_us: 2000000, tags: ["park", "child"] },
        ],
      },
      createdAt: "2026-04-26T00:00:00Z",
    };
    const first = buildContinuityGraph(input);
    const second = buildContinuityGraph(input);

    expect(computeContinuityGraphHash(first)).toBe(computeContinuityGraphHash(second));
    expect(first.entities.map((entity) => entity.entity_id)).toEqual([...first.entities.map((entity) => entity.entity_id)].sort());
    expect(first.segments.map((segment) => segment.segment_id)).toEqual(["SEG_a_intro", "SEG_b_payoff"]);
    expect(first.edges).toEqual(sortContinuityGraph({ ...first, edges: [...first.edges].reverse() }).edges);
    expect(first.risks).toEqual(sortContinuityGraph({ ...first, risks: [...first.risks].reverse() }).risks);
  });

  it("marks graph stale when source_media_manifest_hash differs", () => {
    const graph = readJson(path.join(FIXTURE_DIR, "valid_multi_asset_chronological.json"));

    expect(isContinuityGraphStale(graph, MANIFEST_HASH)).toBe(false);
    expect(isContinuityGraphStale(graph, "sha256:9999999999999999999999999999999999999999999999999999999999999999")).toBe(true);
  });

  it("treats only human_confirmed identity labels as release-safe", () => {
    const data = readJson(path.join(FIXTURE_DIR, "invalid_confirmed_identity_without_human_status.json")) as {
      entities: Array<Record<string, unknown>>;
    };
    data.entities[0].status = "human_confirmed";

    expect(validateContinuityGraph(data, { manifestAssetIds: MANIFEST_ASSETS }).valid).toBe(true);
  });

  it("keeps P3 flag off by default and preserves demo timeline canonical hash", () => {
    const before = canonicalTimelineHash();

    expect(isP3ContinuityPreferenceEnabled()).toBe(false);
    expect(canonicalTimelineHash()).toBe(before);
  });
});
