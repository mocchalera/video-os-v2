import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import {
  averageAdjacentVisualCoherence,
  orderClipsBySceneContinuity,
} from "../runtime/compiler/scene-order.js";
import { loadVisualCache, type CompileVisualCache } from "../runtime/compiler/visual-cache.js";
import {
  adjacencyDecide,
  visualCoherenceScore,
  visualTransitionHint,
} from "../runtime/compiler/adjacency.js";
import type { Candidate, NormalizedBeat, TimelineClip, Track } from "../runtime/compiler/types.js";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("scene continuity ordering", () => {
  it("places clips from the same timestamp cluster adjacent within a beat", () => {
    const clips = [
      clip("A", { segment_id: "SEG_A", asset_id: "AST_A" }),
      clip("C", { segment_id: "SEG_C", asset_id: "AST_C", timeline_in_frame: 10 }),
      clip("B", { segment_id: "SEG_B", asset_id: "AST_B", timeline_in_frame: 20 }),
    ];
    const visualCache = cache({
      embeddings: {
        SEG_A: vec(1, 0),
        SEG_B: vec(1, 0),
        SEG_C: vec(0, 1),
      },
      timestamps: {
        SEG_A: 0,
        SEG_B: 10 * 60 * 1_000_000,
        SEG_C: 2 * 60 * 60 * 1_000_000,
      },
      cameras: {
        SEG_A: "cam-a",
        SEG_B: "cam-a",
        SEG_C: "cam-a",
      },
    });

    expect(orderClipsBySceneContinuity(clips, visualCache).map((item) => item.segment_id)).toEqual([
      "SEG_A",
      "SEG_B",
      "SEG_C",
    ]);
  });

  it("orders timestamp clusters by greedy visual similarity", () => {
    const clips = [
      clip("A", { segment_id: "SEG_A" }),
      clip("B", { segment_id: "SEG_B", timeline_in_frame: 10 }),
      clip("C", { segment_id: "SEG_C", timeline_in_frame: 20 }),
    ];
    const visualCache = cache({
      embeddings: {
        SEG_A: vec(1, 0),
        SEG_B: vec(0, 1),
        SEG_C: vec(0.9, 0.1),
      },
      timestamps: {
        SEG_A: 0,
        SEG_B: 2 * 60 * 60 * 1_000_000,
        SEG_C: 4 * 60 * 60 * 1_000_000,
      },
    });

    expect(orderClipsBySceneContinuity(clips, visualCache).map((item) => item.segment_id)).toEqual([
      "SEG_A",
      "SEG_C",
      "SEG_B",
    ]);
  });

  it("improves average visual coherence versus the original jumbled order", () => {
    const clips = [
      clip("A", { segment_id: "SEG_A" }),
      clip("B", { segment_id: "SEG_B", timeline_in_frame: 10 }),
      clip("C", { segment_id: "SEG_C", timeline_in_frame: 20 }),
    ];
    const visualCache = cache({
      embeddings: {
        SEG_A: vec(1, 0),
        SEG_B: vec(0, 1),
        SEG_C: vec(0.9, 0.1),
      },
      timestamps: {
        SEG_A: 0,
        SEG_B: 2 * 60 * 60 * 1_000_000,
        SEG_C: 4 * 60 * 60 * 1_000_000,
      },
    });

    const before = averageAdjacentVisualCoherence(clips, visualCache.embeddings);
    const ordered = orderClipsBySceneContinuity(clips, visualCache);
    const after = averageAdjacentVisualCoherence(ordered, visualCache.embeddings);

    expect(ordered.map((item) => item.segment_id)).toEqual(["SEG_A", "SEG_C", "SEG_B"]);
    expect(after).toBeGreaterThan(before);
  });

  it("falls back to asset grouping when timestamps are unavailable", () => {
    const clips = [
      clip("A", { segment_id: "SEG_A", asset_id: "AST_1", src_in_us: 10_000_000 }),
      clip("C", { segment_id: "SEG_C", asset_id: "AST_2", timeline_in_frame: 10 }),
      clip("B", { segment_id: "SEG_B", asset_id: "AST_1", src_in_us: 1_000_000, timeline_in_frame: 20 }),
    ];
    const visualCache = cache({
      embeddings: {
        SEG_A: vec(1, 0),
        SEG_B: vec(1, 0),
        SEG_C: vec(0, 1),
      },
      sourceInUs: {
        SEG_A: 10_000_000,
        SEG_B: 1_000_000,
        SEG_C: 0,
      },
    });

    expect(orderClipsBySceneContinuity(clips, visualCache).map((item) => item.segment_id)).toEqual([
      "SEG_B",
      "SEG_A",
      "SEG_C",
    ]);
  });

  it("preserves existing order when embeddings are unavailable", () => {
    const clips = [
      clip("A", { segment_id: "SEG_A" }),
      clip("C", { segment_id: "SEG_C", timeline_in_frame: 10 }),
      clip("B", { segment_id: "SEG_B", timeline_in_frame: 20 }),
    ];
    const visualCache = cache({
      embeddings: {},
      timestamps: {
        SEG_A: 0,
        SEG_B: 10 * 60 * 1_000_000,
        SEG_C: 2 * 60 * 60 * 1_000_000,
      },
    });

    expect(orderClipsBySceneContinuity(clips, visualCache).map((item) => item.segment_id)).toEqual([
      "SEG_A",
      "SEG_C",
      "SEG_B",
    ]);
  });
});

describe("compile visual cache", () => {
  it("loads Qwen visual embeddings and metadata only for requested placed segments", () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "compiler-visual-cache-"));
    tempDirs.push(projectDir);
    fs.mkdirSync(path.join(projectDir, "03_analysis", "search"), { recursive: true });
    const db = new Database(path.join(projectDir, "03_analysis", "search", "footage.db"));
    try {
      db.exec(`
        CREATE TABLE segments (
          segment_id TEXT PRIMARY KEY,
          asset_id TEXT NOT NULL,
          src_in_us INTEGER NOT NULL
        );
        CREATE TABLE assets (
          asset_id TEXT PRIMARY KEY,
          filename TEXT NOT NULL,
          shooting_date TEXT,
          shooting_time TEXT,
          camera_type TEXT
        );
        CREATE TABLE embedding_models (
          id INTEGER PRIMARY KEY,
          name TEXT NOT NULL,
          output_dimension INTEGER NOT NULL,
          input_modality TEXT NOT NULL,
          normalized INTEGER NOT NULL,
          distance_metric TEXT NOT NULL
        );
        CREATE TABLE segment_embeddings (
          id INTEGER PRIMARY KEY,
          segment_id TEXT NOT NULL,
          embedding_type TEXT NOT NULL,
          model_id INTEGER NOT NULL,
          source_ref TEXT NOT NULL,
          source_timestamp_us INTEGER,
          dimension INTEGER NOT NULL,
          vector BLOB NOT NULL
        );
      `);
      db.prepare("INSERT INTO assets VALUES (?, ?, ?, ?, ?)").run(
        "AST_A",
        "Blackmagic Pocket Cinema Camera_1_2015-08-21_1013_C0021.mov",
        null,
        null,
        null,
      );
      db.prepare("INSERT INTO assets VALUES (?, ?, ?, ?, ?)").run(
        "AST_B",
        "A001_20260619_143015_C0007.mov",
        null,
        null,
        null,
      );
      db.prepare("INSERT INTO segments VALUES (?, ?, ?)").run("SEG_A", "AST_A", 2_000_000);
      db.prepare("INSERT INTO segments VALUES (?, ?, ?)").run("SEG_B", "AST_B", 0);
      db.prepare("INSERT INTO embedding_models VALUES (?, ?, ?, ?, ?, ?)").run(
        1,
        "Qwen/Qwen3-VL-Embedding-2B",
        2048,
        "multimodal",
        1,
        "cosine",
      );
      const insertEmbedding = db.prepare(`
        INSERT INTO segment_embeddings (
          id, segment_id, embedding_type, model_id, source_ref, source_timestamp_us, dimension, vector
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      insertEmbedding.run(1, "SEG_A", "visual_representative", 1, "frame-a.jpg", 2_000_000, 2048, unitVectorBlob(2048, 0));
      insertEmbedding.run(2, "SEG_B", "visual_representative", 1, "frame-b.jpg", 0, 2048, unitVectorBlob(2048, 1));
    } finally {
      db.close();
    }

    const loaded = loadVisualCache(projectDir, ["SEG_A"]);

    expect(loaded?.embeddings.has("SEG_A")).toBe(true);
    expect(loaded?.embeddings.has("SEG_B")).toBe(false);
    expect(loaded?.assetIds.get("SEG_A")).toBe("AST_A");
    expect(loaded?.timestamps.get("SEG_A")).toBe(Date.UTC(2015, 7, 21, 10, 13, 0) * 1000 + 2_000_000);
    expect(loaded?.cameras.get("SEG_A")).toBe("blackmagic pocket cinema camera_1");
  });
});

describe("visual coherence adjacency", () => {
  it("computes visual coherence from mock vectors", () => {
    const embeddings = new Map([
      ["SEG_A", vec(1, 0)],
      ["SEG_B", vec(1, 0)],
      ["SEG_C", vec(0, 1)],
    ]);

    expect(visualCoherenceScore(clip("A", { segment_id: "SEG_A" }), clip("B", { segment_id: "SEG_B" }), embeddings)).toBeCloseTo(1);
    expect(visualCoherenceScore(clip("A", { segment_id: "SEG_A" }), clip("C", { segment_id: "SEG_C" }), embeddings)).toBeCloseTo(0);
    expect(visualCoherenceScore(clip("A", { segment_id: "SEG_A" }), clip("D", { segment_id: "SEG_D" }), embeddings)).toBe(0.5);
  });

  it("maps low and high visual coherence to transition hints", () => {
    expect(visualTransitionHint(0.84)).toBe("dissolve");
    expect(visualTransitionHint(0.96)).toBe("hard_cut");
    expect(visualTransitionHint(0.9)).toBeUndefined();
  });

  it("emits dissolve and hard-cut visual hints in adjacency analysis", () => {
    const low = adjacencyDecide(track([
      clip("A", { segment_id: "SEG_A" }),
      clip("B", { segment_id: "SEG_B", timeline_in_frame: 10 }),
    ]), {
      activeEditingSkills: [],
      durationMode: "guide",
      fpsNum: 24,
      candidates: [candidate("SEG_A"), candidate("SEG_B")],
      beats: [beat("b01")],
      visualEmbeddings: new Map([
        ["SEG_A", vec(1, 0)],
        ["SEG_B", vec(0, 1)],
      ]),
    });

    expect(low.transitions[0].transition_type).toBe("crossfade");
    expect(low.transitions[0].applied_skill_id).toBe("visual.dissolve");
    expect(low.analysis.pairs[0].evidence.visual_coherence_score).toBe(0);
    expect(low.analysis.pairs[0].evidence.visual_transition_hint).toBe("dissolve");

    const high = adjacencyDecide(track([
      clip("A", { segment_id: "SEG_A" }),
      clip("B", { segment_id: "SEG_B", timeline_in_frame: 10 }),
    ]), {
      activeEditingSkills: [],
      durationMode: "guide",
      fpsNum: 24,
      candidates: [candidate("SEG_A"), candidate("SEG_B")],
      beats: [beat("b01")],
      visualEmbeddings: new Map([
        ["SEG_A", vec(1, 0)],
        ["SEG_B", vec(1, 0)],
      ]),
    });

    expect(high.transitions[0].transition_type).toBe("cut");
    expect(high.transitions[0].applied_skill_id).toBe("visual.hard_cut");
    expect(high.analysis.pairs[0].evidence.visual_coherence_score).toBe(1);
    expect(high.analysis.pairs[0].evidence.visual_transition_hint).toBe("hard_cut");
  });
});

function cache(input: {
  embeddings: Record<string, Float32Array>;
  timestamps?: Record<string, number>;
  assetIds?: Record<string, string>;
  sourceInUs?: Record<string, number>;
  cameras?: Record<string, string>;
}): CompileVisualCache {
  return {
    embeddings: new Map(Object.entries(input.embeddings)),
    timestamps: new Map(Object.entries(input.timestamps ?? {})),
    assetIds: new Map(Object.entries(input.assetIds ?? {})),
    sourceInUs: new Map(Object.entries(input.sourceInUs ?? {})),
    cameras: new Map(Object.entries(input.cameras ?? {})),
  };
}

function clip(id: string, overrides: Partial<TimelineClip> = {}): TimelineClip {
  return {
    clip_id: `CLP_${id}`,
    segment_id: `SEG_${id}`,
    asset_id: `AST_${id}`,
    src_in_us: 0,
    src_out_us: 10_000_000,
    timeline_in_frame: 0,
    timeline_duration_frames: 10,
    role: "support",
    motivation: "test",
    beat_id: "b01",
    fallback_segment_ids: [],
    confidence: 1,
    quality_flags: [],
    ...overrides,
  };
}

function track(clips: TimelineClip[]): Track {
  return { track_id: "V1", kind: "video", clips };
}

function candidate(segmentId: string): Candidate {
  return {
    segment_id: segmentId,
    asset_id: `AST_${segmentId}`,
    src_in_us: 0,
    src_out_us: 10_000_000,
    role: "support",
    why_it_matches: "test",
    risks: [],
    confidence: 1,
  };
}

function beat(beatId: string): NormalizedBeat {
  return {
    beat_id: beatId,
    label: beatId,
    target_duration_frames: 20,
    required_roles: ["support"],
    preferred_roles: ["support"],
    purpose: "test",
  };
}

function vec(...values: number[]): Float32Array {
  return new Float32Array(values);
}

function unitVectorBlob(dimension: number, axis: number): Buffer {
  const values = new Float32Array(dimension);
  values[axis] = 1;
  return Buffer.from(values.buffer);
}
