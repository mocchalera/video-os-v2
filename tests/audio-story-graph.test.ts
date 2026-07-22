import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import * as os from "node:os";
import { createRequire } from "node:module";
import {
  buildAudioStoryGraph,
  computeAudioStoryGraphHash,
  isP2AudioStoryGraphEnabled,
  isAudioStoryGraphStale,
  sortAudioStoryGraph,
  validateAudioStoryGraph,
} from "../runtime/artifacts/p2-audio-story-graph.js";
import { materializeAudioStoryGraphRefs } from "../runtime/commands/triage.js";
import { projectAudioStoryRoles } from "../runtime/commands/blueprint.js";

const require_ = createRequire(import.meta.url);
const Ajv2020 = require_("ajv/dist/2020") as new (opts: Record<string, unknown>) => {
  addSchema(schema: object): void;
  compile(schema: object): { (data: unknown): boolean; errors?: unknown[] | null };
};
const addFormats = require_("ajv-formats") as (ajv: unknown) => void;

const FIXTURE_DIR = path.resolve("tests/fixtures/audio_story_graph");
const SCHEMA_PATH = path.resolve("schemas/audio-story-graph.schema.json");
const COMMON_SCHEMA_PATH = path.resolve("schemas/analysis-common.schema.json");
const DEMO_TIMELINE = path.resolve("projects/demo/05_timeline/timeline.json");
const MANIFEST_HASH = "sha256:1111111111111111111111111111111111111111111111111111111111111111";
const MANIFEST_ASSETS = ["AST_dialogue_001", "AST_music_001"];

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
  delete process.env.ENABLE_P2_AUDIO_STORY_GRAPH;
});

describe("P2 audio_story_graph", () => {
  it.each([
    "valid_dialogue_heavy.json",
    "valid_music_only_skipped_dialogue.json",
    "valid_audio_events_failed_partial.json",
  ])("accepts %s", (fixture) => {
    const validate = schemaValidator();
    const data = readJson(path.join(FIXTURE_DIR, fixture));

    expect(validate(data), JSON.stringify(validate.errors, null, 2)).toBe(true);
    expect(validateAudioStoryGraph(data, { manifestAssetIds: MANIFEST_ASSETS }).valid).toBe(true);
  });

  it.each([
    "invalid_node_missing_manifest_asset.json",
    "invalid_edge_unknown_node.json",
  ])("rejects %s", (fixture) => {
    const validate = schemaValidator();
    const data = readJson(path.join(FIXTURE_DIR, fixture));

    expect(validate(data), JSON.stringify(validate.errors, null, 2)).toBe(true);
    expect(validateAudioStoryGraph(data, { manifestAssetIds: MANIFEST_ASSETS }).valid).toBe(false);
  });

  it("keeps failed STT graph valid without inventing dialogue nodes", () => {
    const validate = schemaValidator();
    const graph = readJson(path.join(FIXTURE_DIR, "edge_failed_stt_no_dialogue_nodes.json")) as {
      coverage: { status: string; dialogue_lane: string };
      nodes: Array<{ node_type: string }>;
    };

    expect(validate(graph), JSON.stringify(validate.errors, null, 2)).toBe(true);
    expect(validateAudioStoryGraph(graph, { manifestAssetIds: MANIFEST_ASSETS }).valid).toBe(true);
    expect(graph.coverage).toMatchObject({ status: "partial", dialogue_lane: "failed" });
    expect(graph.nodes.some((node) => node.node_type === "utterance" || node.node_type === "speaker_turn")).toBe(false);
  });

  it("validates node and edge ID prefixes by schema", () => {
    const validate = schemaValidator();
    const graph = readJson(path.join(FIXTURE_DIR, "valid_dialogue_heavy.json")) as {
      nodes: Array<Record<string, unknown>>;
      edges: Array<Record<string, unknown>>;
    };
    graph.nodes[0].node_id = "BAD_intro_001";
    expect(validate(graph)).toBe(false);

    const edgeGraph = readJson(path.join(FIXTURE_DIR, "valid_dialogue_heavy.json")) as {
      edges: Array<Record<string, unknown>>;
    };
    edgeGraph.edges[0].edge_id = "EDGE_intro_001";
    expect(validate(edgeGraph)).toBe(false);
  });

  it("computes stable graph hashes with created_at excluded", () => {
    const graph = readJson(path.join(FIXTURE_DIR, "valid_dialogue_heavy.json")) as Record<string, unknown>;
    const later = { ...graph, created_at: "2026-04-27T00:00:00Z" };

    expect(computeAudioStoryGraphHash(graph)).toBe(computeAudioStoryGraphHash(later));
    expect(computeAudioStoryGraphHash(graph)).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it("builds deterministic graph ordering and hash from identical inputs", () => {
    const input = {
      projectId: "asg-build",
      manifest: {
        source_media_manifest_hash: MANIFEST_HASH,
        items: [{ asset_id: "AST_b" }, { asset_id: "AST_a" }],
      },
      coverageReport: {
        hash: "sha256:5555555555555555555555555555555555555555555555555555555555555555",
        lanes: [
          { lane_id: "stt", status: "ready" },
          { lane_id: "audio_events", status: "ready" },
          { lane_id: "bgm_analysis", status: "ready" },
        ],
      },
      transcripts: [
        {
          transcript_ref: "TR_b",
          asset_id: "AST_b",
          items: [{ item_id: "UTT_b_late", speaker_key: "SPK_b", start_us: 200, end_us: 300, text: "late", confidence: 0.8 }],
        },
        {
          transcript_ref: "TR_a",
          asset_id: "AST_a",
          items: [{ item_id: "UTT_a_early", speaker_key: "SPK_a", start_us: 100, end_us: 200, text: "early", confidence: 0.9 }],
        },
      ],
      audioEvents: {
        items: [{ event_id: "AE_a_hit", asset_id: "AST_a", type: "impact", start_us: 300, end_us: 350, confidence: { score: 0.7, source: "test", status: "ready" } }],
      },
      bgmAnalysis: {
        music_asset: { asset_id: "AST_b" },
        sections: [{ id: "BGM_b_intro", label: "intro", start_sec: 0, end_sec: 1, energy: 0.5 }],
      },
      createdAt: "2026-04-26T00:00:00Z",
    };
    const first = buildAudioStoryGraph(input);
    const second = buildAudioStoryGraph(input);

    expect(computeAudioStoryGraphHash(first)).toBe(computeAudioStoryGraphHash(second));
    expect(first.nodes.map((node) => node.node_id)).toEqual([
      "BGMREF_BGM_b_intro",
      "UTTREF_UTT_b_late",
      "UTTREF_UTT_a_early",
      "AEREF_AE_a_hit",
    ]);
    expect(first.edges).toEqual(sortAudioStoryGraph({ ...first, edges: [...first.edges].reverse() }).edges);
  });

  it("normalizes transcript speaker keys into audio-story speaker refs", () => {
    const validate = schemaValidator();
    const graph = buildAudioStoryGraph({
      projectId: "asg-speaker-ref",
      manifest: {
        source_media_manifest_hash: MANIFEST_HASH,
        items: [{ asset_id: "AST_dialogue_001" }],
      },
      coverageReport: {
        hash: "sha256:5555555555555555555555555555555555555555555555555555555555555555",
        lanes: [{ lane_id: "stt", status: "ready" }],
      },
      transcripts: [
        {
          transcript_ref: "TR_AST_dialogue_001",
          asset_id: "AST_dialogue_001",
          items: [
            {
              item_id: "UTT_intro",
              speaker_key: "AST_dialogue_001:speaker_1",
              start_us: 100,
              end_us: 200,
              text: "opening",
            },
          ],
        },
      ],
      createdAt: "2026-04-26T00:00:00Z",
    });

    expect(graph.nodes[0].refs.speaker_ref).toBe("SPK_AST_dialogue_001_speaker_1");
    expect(validate(graph), JSON.stringify(validate.errors, null, 2)).toBe(true);
  });

  it("schema-validates legacy BGM nodes and restricts BGM asset IDs to music sections", () => {
    const validate = schemaValidator();
    const graph = buildAudioStoryGraph({
      projectId: "asg-legacy-bgm",
      manifest: {
        source_media_manifest_hash: MANIFEST_HASH,
        items: [{ asset_id: "AST_dialogue_001" }],
      },
      coverageReport: {
        hash: "sha256:5555555555555555555555555555555555555555555555555555555555555555",
        lanes: [{ lane_id: "bgm_analysis", status: "ready" }],
      },
      bgmAnalysis: {
        music_asset: { asset_id: "BGM_legacy_theme" },
        sections: [{ id: "intro", label: "intro", start_sec: 0, end_sec: 1, energy: 0.5 }],
      },
      createdAt: "2026-04-26T00:00:00Z",
    });

    expect(validate(graph), JSON.stringify(validate.errors, null, 2)).toBe(true);
    expect(validateAudioStoryGraph(graph, {
      manifestAssetIds: ["AST_dialogue_001", "BGM_legacy_theme"],
    }).valid).toBe(true);

    const invalid = structuredClone(graph);
    invalid.nodes[0].node_type = "utterance";
    expect(validate(invalid)).toBe(false);
    expect(validateAudioStoryGraph(invalid, {
      manifestAssetIds: ["AST_dialogue_001", "BGM_legacy_theme"],
    }).valid).toBe(false);
  });

  it("marks graph stale when source_media_manifest_hash differs", () => {
    const graph = readJson(path.join(FIXTURE_DIR, "valid_dialogue_heavy.json"));

    expect(isAudioStoryGraphStale(graph, MANIFEST_HASH)).toBe(false);
    expect(isAudioStoryGraphStale(graph, "sha256:9999999999999999999999999999999999999999999999999999999999999999")).toBe(true);
  });

  it("keeps P2 flag off by default and preserves demo timeline canonical hash", () => {
    const before = canonicalTimelineHash();

    expect(isP2AudioStoryGraphEnabled()).toBe(false);
    expect(canonicalTimelineHash()).toBe(before);
  });

  it("materializes audio story refs into first-class planning fields without wrapper evidence", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "p2-first-class-"));
    fs.mkdirSync(path.join(tmpDir, "03_analysis"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, "03_analysis/audio_story_graph.json"),
      JSON.stringify(readJson(path.join(FIXTURE_DIR, "valid_dialogue_heavy.json")), null, 2),
    );
    const selects: any = {
      version: "1.0.0",
      project_id: "p2-first-class",
      candidates: [
        {
          segment_id: "SEG_001",
          asset_id: "AST_dialogue_001",
          src_in_us: 0,
          src_out_us: 2500000,
          role: "hero",
          why_it_matches: "test",
          risks: [],
          confidence: 0.5,
        },
      ],
    };

    materializeAudioStoryGraphRefs(tmpDir, selects);

    expect(selects.candidates[0].audio_story_refs?.map((ref: { node_id: string }) => ref.node_id)).toContain("UTTREF_intro_001");
    expect(selects.candidates[0].audio_story_refs?.[0].graph_hash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(selects.candidates[0].evidence).toBeUndefined();
  });

  it("projects audio story roles into first-class blueprint fields without notes wrappers", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "p2-blueprint-first-class-"));
    fs.mkdirSync(path.join(tmpDir, "03_analysis"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, "03_analysis/audio_story_graph.json"),
      JSON.stringify(readJson(path.join(FIXTURE_DIR, "valid_dialogue_heavy.json")), null, 2),
    );
    const blueprint: any = {
      version: "1.0.0",
      project_id: "p2-first-class",
      sequence_goals: ["test"],
      beats: [{ id: "B01", label: "setup", target_duration_frames: 24, required_roles: ["hero"] }],
      pacing: { opening_cadence: "a", middle_cadence: "b", ending_cadence: "c" },
      music_policy: { start_sparse: true, allow_release_late: true, entry_beat: "B01" },
      dialogue_policy: { preserve_natural_breath: true, avoid_wall_to_wall_voiceover: true },
      transition_policy: { prefer_match_texture_over_flashy_fx: true },
      ending_policy: { should_feel: "resolved" },
      rejection_rules: ["none"],
    };

    expect(projectAudioStoryRoles(tmpDir, blueprint)).toBe(true);
    expect(blueprint.beats[0].audio_story_role).toMatchObject({ role: "setup" });
    expect(blueprint.beats[0].audio_story_role?.evidence_node_ids).toContain("UTTREF_intro_001");
    expect(blueprint.beats[0].notes).toBeUndefined();
  });
});
