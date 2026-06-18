import { afterEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

vi.mock("../runtime/eval/semantic-match.js", () => {
  function normalize(values: number[]): Float32Array {
    const magnitude = Math.sqrt(values.reduce((sum, value) => sum + value * value, 0));
    return new Float32Array(magnitude > 0 ? values.map((value) => value / magnitude) : values);
  }

  function vectorFor(text: string): Float32Array {
    const lower = text.toLowerCase();
    if (/栗|chestnut|sweet|food|roast/.test(lower)) return normalize([1, 0, 0]);
    if (/river|water|mountain/.test(lower)) return normalize([0, 1, 0]);
    return normalize([0, 0, 1]);
  }

  return {
    SEMANTIC_EMBEDDING_MODEL: "Xenova/multilingual-e5-small",
    SEMANTIC_EMBEDDING_DTYPE: "q8",
    embedTexts: async (texts: string[]) => texts.map(vectorFor),
    cosineSimilarity: (a: Float32Array, b: Float32Array) => {
      if (a.length !== b.length) return 0;
      let score = 0;
      for (let index = 0; index < a.length; index += 1) score += a[index] * b[index];
      return score;
    },
  };
});

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("footage database", () => {
  it("builds SQLite tables, FTS rows, and a build report from mock analysis data", async () => {
    const projectDir = makeProject();
    const { buildFootageDb } = await import("../runtime/artifacts/footage-db-builder.js");
    const { footageDbPath, readFootageDbStatus } = await import("../runtime/artifacts/footage-db.js");

    const result = await buildFootageDb({ projectDir, embeddingPolicy: "skip", now: new Date("2026-06-19T00:00:00.000Z") });
    expect(result.counts).toMatchObject({
      assets: 2,
      segments: 2,
      fts_rows: 2,
      marlin_events: 2,
      transcript_segments: 1,
      embeddings: 0,
    });
    expect(result.embedding_status).toBe("skipped");
    expect(fs.existsSync(footageDbPath(projectDir))).toBe(true);
    expect(fs.existsSync(path.join(projectDir, "03_analysis/search/footage-db-build-report.json"))).toBe(true);

    const db = new Database(footageDbPath(projectDir), { readonly: true, fileMustExist: true });
    try {
      expect(db.prepare("PRAGMA integrity_check").pluck().get()).toBe("ok");
      expect(db.prepare("SELECT COUNT(*) FROM assets").pluck().get()).toBe(2);
      expect(db.prepare("SELECT COUNT(*) FROM segments").pluck().get()).toBe(2);
      expect(db.prepare("SELECT COUNT(*) FROM segments_fts").pluck().get()).toBe(2);
      expect(db.prepare("SELECT value FROM footage_db_meta WHERE key = 'artifact_version'").pluck().get()).toBe("footage-db-v1");
    } finally {
      db.close();
    }

    expect(readFootageDbStatus(projectDir).status).toBe("ready");
  });

  it("searches Japanese and English evidence through FTS", async () => {
    const projectDir = makeProject();
    const { buildFootageDb } = await import("../runtime/artifacts/footage-db-builder.js");
    const { searchFootage } = await import("../runtime/tools/footage-search.js");
    await buildFootageDb({ projectDir, embeddingPolicy: "skip" });

    const japanese = await searchFootage(projectDir, { query: "栗", mode: "text", limit: 3 });
    expect(japanese.db_status).toBe("ready");
    expect(japanese.results[0]?.segment_id).toBe("SEG_food");

    const english = await searchFootage(projectDir, { query: "栗 OR chestnut", mode: "text", limit: 3 });
    expect(english.rewritten_query?.fts_match).toContain("OR");
    expect(english.results[0]?.segment_id).toBe("SEG_food");
  });

  it("applies structured filters for date, quality, duration, place, and exclusion", async () => {
    const projectDir = makeProject();
    const { buildFootageDb } = await import("../runtime/artifacts/footage-db-builder.js");
    const { searchFootage } = await import("../runtime/tools/footage-search.js");
    await buildFootageDb({ projectDir, embeddingPolicy: "skip" });

    const date = await searchFootage(projectDir, {
      query: "",
      mode: "structured",
      filters: { shooting_date: "2026-06-01" },
    });
    expect(date.results.map((result) => result.segment_id)).toEqual(["SEG_food"]);

    const quality = await searchFootage(projectDir, {
      query: "",
      mode: "structured",
      filters: { quality_min: { composition_score: 0.8 } },
    });
    expect(quality.results.map((result) => result.segment_id)).toEqual(["SEG_food"]);

    const duration = await searchFootage(projectDir, {
      query: "",
      mode: "structured",
      filters: { max_duration_us: 5_000_000 },
    });
    expect(duration.results.map((result) => result.segment_id)).toEqual(["SEG_food"]);

    const place = await searchFootage(projectDir, {
      query: "",
      mode: "structured",
      filters: { place_hint_category: "market" },
    });
    expect(place.results.map((result) => result.segment_id)).toEqual(["SEG_food"]);

    const excluded = await searchFootage(projectDir, {
      query: "chestnut",
      mode: "text",
      filters: { exclude_segment_ids: ["SEG_food"] },
    });
    expect(excluded.results).toHaveLength(0);
  });

  it("stores local embeddings and ranks semantic matches by vector score", async () => {
    const projectDir = makeProject();
    const { buildFootageDb } = await import("../runtime/artifacts/footage-db-builder.js");
    const { searchFootage } = await import("../runtime/tools/footage-search.js");
    const build = await buildFootageDb({ projectDir, embeddingPolicy: "require" });
    expect(build.embedding_status).toBe("ready");
    expect(build.counts.embeddings).toBeGreaterThan(0);

    const response = await searchFootage(projectDir, {
      query: "sweet food",
      semantic: "sweet food",
      mode: "semantic",
      limit: 2,
    });
    expect(response.results.map((result) => result.segment_id)).toEqual(["SEG_food", "SEG_river"]);
    expect(response.results[0].scores.semantic).toBeGreaterThan(response.results[1].scores.semantic ?? 0);
  });

  it("falls back to segments.json when the DB file is missing", async () => {
    const projectDir = makeProject();
    const { searchFootage } = await import("../runtime/tools/footage-search.js");

    const response = await searchFootage(projectDir, { query: "chestnut", mode: "text" });
    expect(response.db_status).toBe("fallback");
    expect(response.results[0]?.segment_id).toBe("SEG_food");
  });

  it("detects mtime staleness after segments.json changes", async () => {
    const projectDir = makeProject();
    const { buildFootageDb } = await import("../runtime/artifacts/footage-db-builder.js");
    const { isFootageDbStale, readFootageDbStatus } = await import("../runtime/artifacts/footage-db.js");
    await buildFootageDb({ projectDir, embeddingPolicy: "skip" });

    expect(isFootageDbStale(projectDir)).toBe(false);
    const segmentsPath = path.join(projectDir, "03_analysis/segments.json");
    const future = new Date(Date.now() + 10_000);
    fs.utimesSync(segmentsPath, future, future);

    expect(isFootageDbStale(projectDir)).toBe(true);
    const status = readFootageDbStatus(projectDir);
    expect(status.status).toBe("stale");
    expect(status.stale_reasons?.some((reason) => reason.includes("mtime"))).toBe(true);
  });
});

function makeProject(): string {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "footage-db-"));
  tempDirs.push(projectDir);
  fs.mkdirSync(path.join(projectDir, "03_analysis/transcripts"), { recursive: true });
  fs.mkdirSync(path.join(projectDir, "03_analysis/search"), { recursive: true });

  writeJson(projectDir, "03_analysis/assets.json", {
    project_id: "footage-fixture",
    artifact_version: "assets-v1",
    items: [
      {
        asset_id: "AST_food",
        filename: "food.mov",
        display_name: "Food prep",
        role_guess: "b-roll",
        duration_us: 8_000_000,
        has_transcript: true,
        transcript_ref: "TR_AST_food",
        tags: ["food", "chestnut"],
        quality_flags: [],
        source_locator: "02_media/food.mov",
        source_fingerprint: "sha256:food",
        shooting_date: "2026-06-01",
        shooting_time: "10:00:00",
        camera_type: "bmpcc",
      },
      {
        asset_id: "AST_river",
        filename: "river.mov",
        display_name: "River",
        role_guess: "b-roll",
        duration_us: 12_000_000,
        has_transcript: false,
        tags: ["river", "mountain"],
        quality_flags: ["shaky"],
        source_locator: "02_media/river.mov",
        source_fingerprint: "sha256:river",
        shooting_date: "2026-06-02",
        shooting_time: "11:00:00",
        camera_type: "iphone",
      },
    ],
  });

  writeJson(projectDir, "03_analysis/segments.json", {
    project_id: "footage-fixture",
    artifact_version: "segments-v1",
    items: [
      {
        segment_id: "SEG_food",
        asset_id: "AST_food",
        src_in_us: 0,
        src_out_us: 4_000_000,
        rep_frame_us: 2_000_000,
        segment_type: "action",
        summary: "栗を焼く closeup of chestnut preparation",
        transcript_excerpt: "Fresh chestnut is sweet.",
        transcript_ref: "TR_AST_food",
        tags: ["栗", "chestnut", "food"],
        quality_flags: [],
        interest_points: [{ timestamp_us: 2_000_000, label: "hands" }],
        filmstrip_path: "filmstrips/SEG_food.png",
        visual_quality: {
          scores: {
            light_quality: 0.9,
            subject_prominence: 0.85,
            emotional_expression: 0.5,
            composition_score: 0.92,
            motion_quality: 0.8,
          },
          labels: {
            lighting_style: ["warm_light"],
            composition_tags: ["closeup"],
            expression_tags: [],
            motion_tags: ["hands_working"],
          },
        },
        visual_appraisal: {
          frame_us: 2_000_000,
          frame_path: "frames/SEG_food.jpg",
          extracted_text: [{ text: "栗", language: "ja", confidence: 0.9 }],
          place_hint: {
            name: "Chestnut market",
            category: "market",
            confidence: 0.8,
            evidence: ["visible food stall"],
          },
          aesthetic_notes: ["warm closeup with clear hands"],
        },
        peak_analysis: {
          recommended_in_out: { best_in_us: 1_000_000, best_out_us: 3_000_000, rationale: "hands turn the chestnuts" },
          support_signals: { motion_support_score: 0.9, audio_support_score: 0.4, fused_peak_score: 0.8 },
          peak_moments: [{
            peak_ref: "PK_SEG_food_1",
            timestamp_us: 2_100_000,
            type: "action_peak",
            confidence: 0.9,
            description: "hands turn roasted chestnuts",
            source_pass: "test",
          }],
        },
      },
      {
        segment_id: "SEG_river",
        asset_id: "AST_river",
        src_in_us: 0,
        src_out_us: 6_000_000,
        rep_frame_us: 3_000_000,
        segment_type: "static",
        summary: "quiet river water in the mountain",
        transcript_excerpt: "",
        tags: ["river", "water", "mountain"],
        quality_flags: ["shaky"],
        visual_quality: {
          scores: {
            light_quality: 0.4,
            subject_prominence: 0.3,
            emotional_expression: 0.2,
            composition_score: 0.5,
            motion_quality: 0.4,
          },
          labels: {
            lighting_style: ["flat_light"],
            composition_tags: ["wide"],
            expression_tags: [],
            motion_tags: ["static"],
          },
        },
      },
    ],
  });

  writeJson(projectDir, "03_analysis/marlin_events.json", {
    project_id: "footage-fixture",
    artifact_version: "marlin-events-v1",
    model: { provider: "marlin", model_alias: "test", model_snapshot: "test" },
    items: [
      {
        asset_id: "AST_food",
        source_path: "02_media/food.mov",
        scene: "warm food stall where chestnuts are roasted",
        caption: "Scene: chestnut roasting",
        events: [{
          event_id: "MEV_food_1",
          start_us: 500_000,
          end_us: 2_500_000,
          description: "hands roast chestnuts",
          confidence: 0.9,
          source_pass: "marlin_caption",
        }],
        find_results: [],
      },
      {
        asset_id: "AST_river",
        source_path: "02_media/river.mov",
        scene: "quiet river in mountain landscape",
        caption: "Scene: river",
        events: [{
          event_id: "MEV_river_1",
          start_us: 0,
          end_us: 6_000_000,
          description: "water flows through the river",
          confidence: 0.8,
          source_pass: "marlin_caption",
        }],
        find_results: [],
      },
    ],
  });

  writeJson(projectDir, "03_analysis/transcripts/TR_AST_food.json", {
    project_id: "footage-fixture",
    artifact_version: "transcript-v1",
    transcript_ref: "TR_AST_food",
    asset_id: "AST_food",
    items: [{
      item_id: "utt_1",
      speaker: "S1",
      start_us: 500_000,
      end_us: 2_000_000,
      text: "Fresh chestnut is sweet.",
      confidence: 0.95,
    }],
  });

  return projectDir;
}

function writeJson(projectDir: string, relPath: string, value: unknown): void {
  const filePath = path.join(projectDir, relPath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}
