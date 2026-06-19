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
      expect(db.prepare("SELECT COUNT(*) FROM asset_technical").pluck().get()).toBe(2);
      expect(db.prepare("SELECT COUNT(*) FROM segment_visual_profile").pluck().get()).toBe(2);
      expect(db.prepare("SELECT COUNT(*) FROM segment_audio_profile").pluck().get()).toBe(2);
      expect(db.prepare("SELECT COUNT(*) FROM segment_logging").pluck().get()).toBe(2);
      expect(db.prepare("SELECT COUNT(*) FROM metadata_fts").pluck().get()).toBe(2);
      expect(db.prepare("SELECT value FROM footage_db_meta WHERE key = 'artifact_version'").pluck().get()).toBe("footage-db-v1");
      expect(db.prepare("SELECT value FROM footage_db_meta WHERE key = 'metadata_schema_version'").pluck().get()).toBe("1");
      expect(db.prepare("SELECT codec, resolution_width, resolution_height, fps_num, fps_den, audio_channels, audio_sample_rate FROM asset_technical WHERE asset_id = 'AST_food'").get()).toMatchObject({
        codec: "prores",
        resolution_width: 3840,
        resolution_height: 2160,
        fps_num: 60000,
        fps_den: 1001,
        audio_channels: 4,
        audio_sample_rate: 48000,
      });
      expect(db.prepare("SELECT camera_motion, motion_direction, stability, shot_scale FROM segment_visual_profile WHERE segment_id = 'SEG_food'").get()).toMatchObject({
        camera_motion: "pan_right",
        motion_direction: "right",
        stability: "stable",
        shot_scale: "detail",
      });
      expect(db.prepare("SELECT has_dialogue, peak_db, rms_db, loudness_lufs FROM segment_audio_profile WHERE segment_id = 'SEG_food'").get()).toMatchObject({
        has_dialogue: 1,
        peak_db: null,
        rms_db: null,
        loudness_lufs: null,
      });
      expect(db.prepare("SELECT scene_number, shot_number, take_number, usability FROM segment_logging WHERE segment_id = 'SEG_river'").get()).toMatchObject({
        scene_number: 20260619,
        shot_number: 143015,
        take_number: 7,
        usability: "unusable",
      });
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

    const english = await searchFootage(projectDir, { query: "栗 OR chestnut", mode: "text", explicitBoolean: true, limit: 3 });
    expect(english.rewritten_query?.fts_match).toContain("OR");
    expect(english.results[0]?.segment_id).toBe("SEG_food");
  });

  it("defaults embedding policy to auto", async () => {
    const projectDir = makeProject();
    const { buildFootageDb } = await import("../runtime/artifacts/footage-db-builder.js");

    const result = await buildFootageDb({ projectDir });

    expect(result.embedding_status).toBe("ready");
    expect(result.counts.embeddings).toBeGreaterThan(0);
  });

  it("uses explicit boolean mode only when requested and groups CJK alternatives", async () => {
    const projectDir = makeProject();
    const { buildFootageDb } = await import("../runtime/artifacts/footage-db-builder.js");
    const { buildFtsMatchQuery, searchFootage } = await import("../runtime/tools/footage-search.js");
    await buildFootageDb({ projectDir, embeddingPolicy: "skip" });

    const naturalNot = buildFtsMatchQuery({ text: "this is NOT that" });
    expect(naturalNot.match).toBe("\"this\" AND \"is\" AND \"NOT\" AND \"that\"");

    const cjkBoolean = buildFtsMatchQuery({ text: "栗山 AND chestnut", explicitBoolean: true });
    expect(cjkBoolean.match).toMatch(/^\(.+\) AND "chestnut"$/);
    expect(cjkBoolean.match).toContain(" OR ");

    const natural = await searchFootage(projectDir, { query: "栗 OR chestnut", mode: "text", limit: 3 });
    expect(natural.rewritten_query?.fts_match).toContain("\"OR\"");
    expect(natural.results).toHaveLength(0);

    const explicit = await searchFootage(projectDir, {
      query: "栗 OR chestnut",
      mode: "text",
      explicitBoolean: true,
      limit: 3,
    });
    expect(explicit.rewritten_query?.fts_match).toContain(" OR ");
    expect(explicit.results[0]?.segment_id).toBe("SEG_food");
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

  it("applies metadata filters for camera motion, shot scale, stability, dialogue, and usability", async () => {
    const projectDir = makeProject();
    const { buildFootageDb } = await import("../runtime/artifacts/footage-db-builder.js");
    const { searchFootage } = await import("../runtime/tools/footage-search.js");
    await buildFootageDb({ projectDir, embeddingPolicy: "skip" });

    const pan = await searchFootage(projectDir, {
      query: "",
      mode: "structured",
      filters: { camera_motion: "pan_right" },
    });
    expect(pan.results.map((result) => result.segment_id)).toEqual(["SEG_food"]);
    expect(pan.results[0].metadata).toMatchObject({ camera_motion: "pan_right", shot_scale: "detail" });

    const wide = await searchFootage(projectDir, {
      query: "",
      mode: "structured",
      filters: { shot_scale: "wide" },
    });
    expect(wide.results.map((result) => result.segment_id)).toEqual(["SEG_river"]);

    const shaky = await searchFootage(projectDir, {
      query: "",
      mode: "structured",
      filters: { stability: "shaky" },
    });
    expect(shaky.results.map((result) => result.segment_id)).toEqual(["SEG_river"]);

    const dialogue = await searchFootage(projectDir, {
      query: "",
      mode: "structured",
      filters: { has_dialogue: true },
    });
    expect(dialogue.results.map((result) => result.segment_id)).toEqual(["SEG_food"]);

    const unusable = await searchFootage(projectDir, {
      query: "",
      mode: "structured",
      filters: { usability: "unusable" },
    });
    expect(unusable.results.map((result) => result.segment_id)).toEqual(["SEG_river"]);
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

  it("keeps searching older footage DBs that do not have metadata tables", async () => {
    const projectDir = makeProject();
    const { buildFootageDb } = await import("../runtime/artifacts/footage-db-builder.js");
    const { footageDbPath } = await import("../runtime/artifacts/footage-db.js");
    const { searchFootage } = await import("../runtime/tools/footage-search.js");
    await buildFootageDb({ projectDir, embeddingPolicy: "skip" });

    const db = new Database(footageDbPath(projectDir));
    try {
      db.exec(`
        DROP TABLE metadata_fts;
        DROP TABLE segment_logging;
        DROP TABLE segment_audio_profile;
        DROP TABLE segment_visual_profile;
        DROP TABLE asset_technical;
      `);
    } finally {
      db.close();
    }

    const response = await searchFootage(projectDir, { query: "chestnut", mode: "text" });
    expect(response.db_status).toBe("ready");
    expect(response.results[0]?.segment_id).toBe("SEG_food");

    const metadataFiltered = await searchFootage(projectDir, {
      query: "",
      mode: "structured",
      filters: { camera_motion: "pan_right" },
    });
    expect(metadataFiltered.results).toHaveLength(0);
    expect(metadataFiltered.warnings).toContain("visual metadata filter requested, but segment_visual_profile is missing in this footage DB");
  });

  it("fallback search enforces date, time, camera, place, text, and dialogue filters", async () => {
    const projectDir = makeProject();
    const segmentsPath = path.join(projectDir, "03_analysis/segments.json");
    const segmentsJson = JSON.parse(fs.readFileSync(segmentsPath, "utf-8")) as {
      items: Array<Record<string, unknown>>;
    };
    segmentsJson.items[1].segment_type = "dialogue";
    fs.writeFileSync(segmentsPath, `${JSON.stringify(segmentsJson, null, 2)}\n`, "utf-8");
    const { searchFootage } = await import("../runtime/tools/footage-search.js");

    const date = await searchFootage(projectDir, {
      query: "",
      mode: "structured",
      filters: { shooting_date: "2026-06-01" },
    });
    expect(date.results.map((result) => result.segment_id)).toEqual(["SEG_food"]);

    const timeAndCamera = await searchFootage(projectDir, {
      query: "",
      mode: "structured",
      filters: { shooting_time_start: "10:30:00", shooting_time_end: "11:30:00", camera_type: "iphone" },
    });
    expect(timeAndCamera.results.map((result) => result.segment_id)).toEqual(["SEG_river"]);

    const place = await searchFootage(projectDir, {
      query: "",
      mode: "structured",
      filters: { place_hint_name: "Chestnut market", place_hint_category: "market" },
    });
    expect(place.results.map((result) => result.segment_id)).toEqual(["SEG_food"]);
    expect(place.results[0].place_hint).toMatchObject({ name: "Chestnut market", category: "market" });

    const hasText = await searchFootage(projectDir, {
      query: "",
      mode: "structured",
      filters: { has_text: true },
    });
    expect(hasText.results.map((result) => result.segment_id)).toEqual(["SEG_food"]);

    const noText = await searchFootage(projectDir, {
      query: "",
      mode: "structured",
      filters: { has_text: false },
    });
    expect(noText.results.map((result) => result.segment_id)).toEqual(["SEG_river"]);

    const dialogueByType = await searchFootage(projectDir, {
      query: "",
      mode: "structured",
      filters: { asset_ids: ["AST_river"], has_dialogue: true },
    });
    expect(dialogueByType.results.map((result) => result.segment_id)).toEqual(["SEG_river"]);
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
        filename: "NINJAV_S001_S001_T001.MOV",
        display_name: "Food prep",
        role_guess: "b-roll",
        duration_us: 8_000_000,
        has_transcript: true,
        transcript_ref: "TR_AST_food",
        tags: ["food", "chestnut"],
        quality_flags: [],
        source_locator: "02_media/food.mov",
        source_fingerprint: "sha256:food",
        video_stream: { width: 3840, height: 2160, fps_num: 60000, fps_den: 1001, codec: "prores" },
        audio_stream: { sample_rate: 48000, channels: 4, codec: "pcm_s24le" },
        shooting_date: "2026-06-01",
        shooting_time: "10:00:00",
        camera_type: "bmpcc",
      },
      {
        asset_id: "AST_river",
        filename: "A001_20260619_143015_C0007.mov",
        display_name: "River",
        role_guess: "b-roll",
        duration_us: 12_000_000,
        has_transcript: false,
        tags: ["river", "mountain"],
        quality_flags: ["shaky"],
        source_locator: "02_media/river.mov",
        source_fingerprint: "sha256:river",
        video_stream: { width: 1920, height: 1080, fps_num: 30, fps_den: 1, codec: "h264" },
        audio_stream: { sample_rate: 48000, channels: 2, codec: "aac" },
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
            light_quality: 0.2,
            subject_prominence: 0.2,
            emotional_expression: 0.2,
            composition_score: 0.2,
            motion_quality: 0.2,
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
          description: "The camera pans to the right in a detail of a person's hand roasting chestnuts",
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
          description: "Static wide shot of water flowing through the river with a shaky handheld feel",
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
