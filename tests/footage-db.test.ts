import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const execFileMock = vi.hoisted(() => vi.fn());
const qwenCreateMock = vi.hoisted(() => vi.fn());
const qwenEmbedBatchMock = vi.hoisted(() => vi.fn());
const qwenShutdownMock = vi.hoisted(() => vi.fn());
const clapCreateMock = vi.hoisted(() => vi.fn());
const clapEmbedAudioMock = vi.hoisted(() => vi.fn());
const clapEmbedTextMock = vi.hoisted(() => vi.fn());
const clapShutdownMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({
  execFile: execFileMock,
}));

vi.mock("../runtime/connectors/qwen3vl-embedding-local.js", () => ({
  createQwen3VlEmbeddingLocalClient: qwenCreateMock,
}));

vi.mock("../runtime/connectors/clap-audio-local.js", () => ({
  createClapAudioEmbeddingLocalClient: clapCreateMock,
}));

vi.mock("../runtime/eval/semantic-match.js", () => {
  const TEST_EMBEDDING_DIMENSION = 384;

  function unitVector(axis: number): Float32Array {
    const vector = new Float32Array(TEST_EMBEDDING_DIMENSION);
    vector[axis] = 1;
    return vector;
  }

  function vectorFor(text: string): Float32Array {
    const lower = text.toLowerCase();
    if (/栗|chestnut|sweet|food|roast/.test(lower)) return unitVector(0);
    if (/river|water|mountain/.test(lower)) return unitVector(1);
    return unitVector(2);
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
const QWEN_DIMENSION = 2048;
const CLAP_DIMENSION = 512;

beforeEach(() => {
  qwenEmbedBatchMock.mockImplementation(async (items: Array<{ ref?: string }>, options: { outputDimension?: number } = {}) => ({
    vectors: items.map((item, index) => ({
      ref: item.ref ?? String(index),
      vector: unitVector(options.outputDimension ?? QWEN_DIMENSION, index),
      dimension: options.outputDimension ?? QWEN_DIMENSION,
      normalized: true,
    })),
    model: {
      name: "Qwen/Qwen3-VL-Embedding-2B",
      modelRevision: "mock",
      outputDimension: options.outputDimension ?? QWEN_DIMENSION,
      instruction: "Retrieve relevant video footage for editing.",
      preprocessVersion: "qwen3vl-frame-v1",
      runnerName: "typescript-qwen3vl-mock",
      runnerVersion: "qwen3vl-worker-v1",
      precision: "mock",
      device: "mock",
      distanceMetric: "cosine",
    },
    elapsedMs: 0,
  }));
  qwenCreateMock.mockImplementation(() => ({
    embedText: vi.fn(),
    embedImage: vi.fn(),
    embedMixed: vi.fn(),
    embedBatch: qwenEmbedBatchMock,
    shutdown: qwenShutdownMock,
  }));
  clapEmbedAudioMock.mockImplementation(async (audioPaths: string[], options: { outputDimension?: number } = {}) => ({
    vectors: audioPaths.map((_audioPath, index) => ({
      ref: String(index),
      vector: unitVector(options.outputDimension ?? CLAP_DIMENSION, index),
      dimension: options.outputDimension ?? CLAP_DIMENSION,
      normalized: true,
    })),
    model: {
      name: "laion/clap-htsat-fused",
      modelRevision: "mock",
      outputDimension: options.outputDimension ?? CLAP_DIMENSION,
      preprocessVersion: "clap-audio-window-v1",
      runnerName: "typescript-clap-audio-mock",
      runnerVersion: "clap-audio-worker-v1",
      precision: "mock",
      device: "mock",
      distanceMetric: "cosine",
    },
    elapsedMs: 0,
  }));
  clapEmbedTextMock.mockImplementation(async (texts: string[], options: { outputDimension?: number } = {}) => ({
    vectors: texts.map((_text, index) => ({
      ref: String(index),
      vector: unitVector(options.outputDimension ?? CLAP_DIMENSION, index),
      dimension: options.outputDimension ?? CLAP_DIMENSION,
      normalized: true,
    })),
    model: {
      name: "laion/clap-htsat-fused",
      modelRevision: "mock",
      outputDimension: options.outputDimension ?? CLAP_DIMENSION,
      preprocessVersion: "clap-audio-window-v1",
      runnerName: "typescript-clap-audio-mock",
      runnerVersion: "clap-audio-worker-v1",
      precision: "mock",
      device: "mock",
      distanceMetric: "cosine",
    },
    elapsedMs: 0,
  }));
  clapCreateMock.mockImplementation(() => ({
    embedText: clapEmbedTextMock,
    embedAudio: clapEmbedAudioMock,
    embedBatch: vi.fn(),
    shutdown: clapShutdownMock,
  }));
});

afterEach(() => {
  execFileMock.mockReset();
  qwenCreateMock.mockReset();
  qwenEmbedBatchMock.mockReset();
  qwenShutdownMock.mockReset();
  clapCreateMock.mockReset();
  clapEmbedAudioMock.mockReset();
  clapEmbedTextMock.mockReset();
  clapShutdownMock.mockReset();
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("footage database", () => {
  it("builds SQLite tables, FTS rows, and a build report from mock analysis data", async () => {
    const projectDir = makeProject();
    const { buildFootageDb } = await import("../runtime/artifacts/footage-db-builder.js");
    const { footageDbPath, readFootageDbStatus } = await import("../runtime/artifacts/footage-db.js");

    const result = await buildFootageDb({ projectDir, embeddingPolicy: "skip", qwen3vlEnabled: false, now: new Date("2026-06-19T00:00:00.000Z") });
    expect(result.counts).toMatchObject({
      assets: 2,
      segments: 2,
      fts_rows: 2,
      marlin_events: 2,
      transcript_segments: 1,
      embeddings: 0,
    });
    expect(result.embedding_status).toBe("skipped");
    expect(result.embedding_counts).toEqual({
      e5_text: 0,
      qwen_text: 0,
      qwen_visual: 0,
      qwen_mixed: 0,
      qwen_reranker: 0,
      clap_audio: 0,
    });
    expect(result.embedding_statuses).toEqual({
      e5_text: "skipped",
      qwen_text: "skipped",
      qwen_visual: "skipped",
      qwen_mixed: "unsupported",
      qwen_reranker: "deferred",
      clap_audio: "skipped",
    });
    expect(fs.existsSync(footageDbPath(projectDir))).toBe(true);
    const reportPath = path.join(projectDir, "03_analysis/search/footage-db-build-report.json");
    expect(fs.existsSync(reportPath)).toBe(true);
    const report = JSON.parse(fs.readFileSync(reportPath, "utf-8")) as {
      embedding_counts?: unknown;
      embedding_statuses?: unknown;
    };
    expect(report.embedding_counts).toEqual(result.embedding_counts);
    expect(report.embedding_statuses).toEqual(result.embedding_statuses);

    const db = new Database(footageDbPath(projectDir), { readonly: true, fileMustExist: true });
    try {
      expect(db.prepare("PRAGMA integrity_check").pluck().get()).toBe("ok");
      expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'embedding_models'").pluck().get()).toBe("embedding_models");
      expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'segment_embeddings'").pluck().get()).toBe("segment_embeddings");
      expect(db.prepare("SELECT COUNT(*) FROM assets").pluck().get()).toBe(2);
      expect(db.prepare("SELECT COUNT(*) FROM segments").pluck().get()).toBe(2);
      expect(db.prepare("SELECT COUNT(*) FROM segments_fts").pluck().get()).toBe(2);
      expect(db.prepare("SELECT COUNT(*) FROM asset_technical_metadata").pluck().get()).toBe(2);
      expect(db.prepare("SELECT COUNT(*) FROM segment_visual_profile").pluck().get()).toBe(2);
      expect(db.prepare("SELECT COUNT(*) FROM segment_audio_profile").pluck().get()).toBe(2);
      expect(db.prepare("SELECT COUNT(*) FROM segment_logging_profile").pluck().get()).toBe(2);
      expect(db.prepare("SELECT COUNT(*) FROM segment_metadata_fts").pluck().get()).toBe(2);
      expect(db.prepare("SELECT COUNT(*) FROM segment_usability_profile").pluck().get()).toBe(2);
      expect(db.prepare("SELECT value FROM footage_db_meta WHERE key = 'artifact_version'").pluck().get()).toBe("footage-db-v1");
      expect(db.prepare("SELECT value FROM footage_db_meta WHERE key = 'metadata_schema_version'").pluck().get()).toBe("1");
      expect(db.prepare("SELECT video_codec, width, height, fps_num, fps_den, audio_streams_json FROM asset_technical_metadata WHERE asset_id = 'AST_food'").get()).toMatchObject({
        video_codec: "prores",
        width: 3840,
        height: 2160,
        fps_num: 60000,
        fps_den: 1001,
      });
      expect(JSON.parse((db.prepare("SELECT audio_streams_json FROM asset_technical_metadata WHERE asset_id = 'AST_food'").pluck().get() as string))[0]).toMatchObject({
        channels: 4,
        sample_rate: 48000,
      });
      expect(db.prepare("SELECT camera_motion_type, camera_motion_direction, camera_stability, shot_scale FROM segment_visual_profile WHERE segment_id = 'SEG_food'").get()).toMatchObject({
        camera_motion_type: "pan",
        camera_motion_direction: "ltr",
        camera_stability: "unknown",
        shot_scale: "detail",
      });
      expect(db.prepare("SELECT audio_role, has_dialogue, peak_dbfs, rms_dbfs, integrated_lufs FROM segment_audio_profile WHERE segment_id = 'SEG_food'").get()).toMatchObject({
        audio_role: "dialogue",
        has_dialogue: 1,
        peak_dbfs: null,
        rms_dbfs: null,
        integrated_lufs: null,
      });
      expect(db.prepare("SELECT scene_number, shot_number, take_number, circle_take, source FROM segment_logging_profile WHERE segment_id = 'SEG_river'").get()).toMatchObject({
        scene_number: null,
        shot_number: null,
        take_number: null,
        circle_take: null,
        source: "unknown",
      });
      expect(db.prepare("SELECT usability FROM segment_usability_profile WHERE segment_id = 'SEG_river'").get()).toMatchObject({
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
    await buildFootageDb({ projectDir, embeddingPolicy: "skip", qwen3vlEnabled: false });

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

    const result = await buildFootageDb({ projectDir, qwen3vlEnabled: false });

    expect(result.embedding_status).toBe("ready");
    expect(result.counts.embeddings).toBeGreaterThan(0);
    expect(result.embedding_counts?.e5_text).toBe(result.counts.embeddings);
    expect(result.embedding_statuses?.e5_text).toBe("ready");
  });

  it("marks aggregate embedding_status ready when only Qwen visual retrieval is ready", async () => {
    const projectDir = makeProject();
    writeSourceMedia(projectDir);
    mockFrameExtraction();
    const { buildFootageDb } = await import("../runtime/artifacts/footage-db-builder.js");

    const result = await buildFootageDb({
      projectDir,
      embeddingPolicy: "skip",
      qwen3vlEnabled: true,
      qwen3vlEmbedTypes: ["visual_representative"],
      skipAudioAnalysis: true,
      now: new Date("2026-06-19T00:00:00.000Z"),
    });

    expect(result.embedding_status).toBe("ready");
    expect(result.embedding_statuses).toMatchObject({
      e5_text: "skipped",
      qwen_visual: "ready",
      qwen_text: "skipped",
    });
    expect(result.embedding_counts).toMatchObject({
      e5_text: 0,
      qwen_visual: 2,
      qwen_text: 0,
    });
  });

  it("extracts CLAP audio windows and stores audio/text CLAP embeddings", async () => {
    const projectDir = makeProject();
    writeSourceMedia(projectDir);
    mockFrameExtraction();
    const now = new Date("2026-06-20T00:00:00.000Z");
    const { buildFootageDb } = await import("../runtime/artifacts/footage-db-builder.js");
    const { footageDbPath } = await import("../runtime/artifacts/footage-db.js");

    const result = await buildFootageDb({
      projectDir,
      embeddingPolicy: "skip",
      qwen3vlEnabled: false,
      clapAudioEnabled: true,
      skipAudioAnalysis: true,
      now,
    });

    expect(clapCreateMock).toHaveBeenCalledTimes(1);
    expect(clapEmbedAudioMock).toHaveBeenCalledTimes(1);
    expect(clapEmbedTextMock).toHaveBeenCalledTimes(1);
    expect(result.embedding_status).toBe("ready");
    expect(result.embedding_counts).toMatchObject({ clap_audio: 4 });
    expect(result.embedding_statuses).toMatchObject({ clap_audio: "ready" });
    expect(result.counts.embeddings).toBe(4);

    const audioCall = clapEmbedAudioMock.mock.calls[0] as [string[]];
    expect(audioCall[0]).toEqual([
      path.join(projectDir, "03_analysis/audio_windows/SEG_food/full.wav"),
      path.join(projectDir, "03_analysis/audio_windows/SEG_river/full.wav"),
    ]);
    const ffmpegArgs = execFileMock.mock.calls[0][1] as string[];
    expect(ffmpegArgs).toEqual([
      "-ss",
      "0",
      "-t",
      "4",
      "-i",
      path.join(projectDir, "02_media/food.mov"),
      "-ac",
      "1",
      "-ar",
      "48000",
      "-f",
      "wav",
      "-acodec",
      "pcm_s16le",
      "-map",
      "0:a:0",
      path.join(projectDir, "03_analysis/audio_windows/SEG_food/full.wav"),
    ]);

    const manifest = JSON.parse(fs.readFileSync(path.join(projectDir, "03_analysis/audio_windows/SEG_food/manifest.json"), "utf-8")) as Record<string, unknown>;
    expect(manifest).toMatchObject({
      segment_id: "SEG_food",
      window_type: "full",
      source_ref: "02_media/food.mov",
      start_us: 0,
      end_us: 4_000_000,
      sample_rate: 48000,
      channels: 1,
      output_path: "03_analysis/audio_windows/SEG_food/full.wav",
      preprocess_version: "clap-audio-window-v1",
      created_at: now.toISOString(),
    });
    expect(typeof manifest.content_hash).toBe("string");

    const report = JSON.parse(fs.readFileSync(path.join(projectDir, "03_analysis/search/footage-db-build-report.json"), "utf-8")) as {
      embedding_counts: { clap_audio: number };
      embedding_statuses: { clap_audio: string };
    };
    expect(report.embedding_counts.clap_audio).toBe(4);
    expect(report.embedding_statuses.clap_audio).toBe("ready");

    const db = new Database(footageDbPath(projectDir), { readonly: true, fileMustExist: true });
    try {
      expect(db.prepare(`
        SELECT name, input_modality, output_dimension, runner_name, normalized, distance_metric
        FROM embedding_models
        WHERE name = 'laion/clap-htsat-fused'
      `).get()).toMatchObject({
        name: "laion/clap-htsat-fused",
        input_modality: "audio",
        output_dimension: 512,
        runner_name: "python-clap-audio-worker",
        normalized: 1,
        distance_metric: "cosine",
      });
      expect(db.prepare("SELECT COUNT(*) FROM segment_embeddings WHERE embedding_type = 'audio_representative'").pluck().get()).toBe(2);
      expect(db.prepare("SELECT COUNT(*) FROM segment_embeddings WHERE embedding_type = 'audio_text_clap'").pluck().get()).toBe(2);
      expect(db.prepare(`
        SELECT source_ref, source_timestamp_us, dimension, length(vector) AS byte_length, created_at
        FROM segment_embeddings
        WHERE segment_id = 'SEG_food' AND embedding_type = 'audio_representative'
      `).get()).toMatchObject({
        source_ref: "03_analysis/audio_windows/SEG_food/full.wav",
        source_timestamp_us: 0,
        dimension: 512,
        byte_length: 512 * 4,
        created_at: now.toISOString(),
      });
      expect(db.prepare(`
        SELECT source_ref, source_timestamp_us, dimension, length(vector) AS byte_length, created_at
        FROM segment_embeddings
        WHERE segment_id = 'SEG_food' AND embedding_type = 'audio_text_clap'
      `).get()).toMatchObject({
        source_ref: "embedding_texts:combined",
        source_timestamp_us: null,
        dimension: 512,
        byte_length: 512 * 4,
        created_at: now.toISOString(),
      });
    } finally {
      db.close();
    }
  });

  it("shuts down Qwen before starting the CLAP worker", async () => {
    const projectDir = makeProject();
    writeSourceMedia(projectDir);
    mockFrameExtraction();
    const lifecycle: string[] = [];
    qwenShutdownMock.mockImplementation(async () => {
      lifecycle.push("qwen_shutdown");
    });
    clapCreateMock.mockImplementation(() => {
      lifecycle.push("clap_create");
      return {
        embedText: clapEmbedTextMock,
        embedAudio: clapEmbedAudioMock,
        embedBatch: vi.fn(),
        shutdown: clapShutdownMock,
      };
    });
    const { buildFootageDb } = await import("../runtime/artifacts/footage-db-builder.js");

    await buildFootageDb({
      projectDir,
      embeddingPolicy: "skip",
      qwen3vlEnabled: true,
      qwen3vlEmbedTypes: ["visual_representative"],
      clapAudioEnabled: true,
      skipAudioAnalysis: true,
    });

    expect(lifecycle).toEqual(["qwen_shutdown", "clap_create"]);
  });

  it("refreshes representative frame cache when output, timestamp, or source identity changes", async () => {
    const projectDir = makeProject();
    writeSourceMedia(projectDir);
    mockFrameExtraction();
    const { buildFootageDb } = await import("../runtime/artifacts/footage-db-builder.js");

    await buildFootageDb({
      projectDir,
      embeddingPolicy: "skip",
      qwen3vlEnabled: true,
      qwen3vlEmbedTypes: ["visual_representative"],
      skipAudioAnalysis: true,
      now: new Date("2026-06-19T00:00:00.000Z"),
    });
    expect(execFileMock).toHaveBeenCalledTimes(2);

    execFileMock.mockClear();
    qwenCreateMock.mockClear();
    await buildFootageDb({
      projectDir,
      embeddingPolicy: "skip",
      qwen3vlEnabled: true,
      qwen3vlEmbedTypes: ["visual_representative"],
      skipAudioAnalysis: true,
      now: new Date("2026-06-19T00:01:00.000Z"),
    });
    expect(execFileMock).not.toHaveBeenCalled();
    expect(qwenCreateMock).not.toHaveBeenCalled();

    const riverFrame = path.join(projectDir, "03_analysis/frames/SEG_river/representative.jpg");
    fs.writeFileSync(riverFrame, "stale output");
    execFileMock.mockClear();
    await buildFootageDb({
      projectDir,
      embeddingPolicy: "skip",
      qwen3vlEnabled: true,
      qwen3vlEmbedTypes: ["visual_representative"],
      skipAudioAnalysis: true,
      now: new Date("2026-06-19T00:02:00.000Z"),
    });
    expect(execFileMock).toHaveBeenCalledTimes(1);
    expect((execFileMock.mock.calls[0][1] as string[])).toContain(path.join(projectDir, "02_media/river.mov"));

    updateSegment(projectDir, "SEG_river", { rep_frame_us: 4_000_000 });
    execFileMock.mockClear();
    await buildFootageDb({
      projectDir,
      embeddingPolicy: "skip",
      qwen3vlEnabled: true,
      qwen3vlEmbedTypes: ["visual_representative"],
      skipAudioAnalysis: true,
      now: new Date("2026-06-19T00:03:00.000Z"),
    });
    expect(execFileMock).toHaveBeenCalledTimes(1);
    expect((execFileMock.mock.calls[0][1] as string[])).toEqual(expect.arrayContaining(["-ss", "4"]));

    updateAsset(projectDir, "AST_river", {
      source_locator: "02_media/river-new.mov",
      source_fingerprint: "sha256:river-new",
    });
    fs.writeFileSync(path.join(projectDir, "02_media/river-new.mov"), "new river media");
    execFileMock.mockClear();
    await buildFootageDb({
      projectDir,
      embeddingPolicy: "skip",
      qwen3vlEnabled: true,
      qwen3vlEmbedTypes: ["visual_representative"],
      skipAudioAnalysis: true,
      now: new Date("2026-06-19T00:04:00.000Z"),
    });
    expect(execFileMock).toHaveBeenCalledTimes(1);
    expect((execFileMock.mock.calls[0][1] as string[])).toContain(path.join(projectDir, "02_media/river-new.mov"));
  });

  it("does not embed filmstrip images as representative frames", async () => {
    const projectDir = makeProject();
    fs.mkdirSync(path.join(projectDir, "03_analysis/filmstrips"), { recursive: true });
    fs.writeFileSync(path.join(projectDir, "03_analysis/filmstrips/SEG_food.png"), "filmstrip montage");
    mockFrameExtraction();
    const { buildFootageDb } = await import("../runtime/artifacts/footage-db-builder.js");

    const result = await buildFootageDb({
      projectDir,
      embeddingPolicy: "skip",
      qwen3vlEnabled: true,
      qwen3vlEmbedTypes: ["visual_representative"],
      skipAudioAnalysis: true,
    });

    expect(execFileMock).not.toHaveBeenCalled();
    expect(result.embedding_counts?.qwen_visual).toBe(0);
    expect(result.warnings.some((warning) => warning.includes("qwen3vl frame skipped"))).toBe(true);
  });

  it("uses explicit boolean mode only when requested and groups CJK alternatives", async () => {
    const projectDir = makeProject();
    const { buildFootageDb } = await import("../runtime/artifacts/footage-db-builder.js");
    const { buildFtsMatchQuery, searchFootage } = await import("../runtime/tools/footage-search.js");
    await buildFootageDb({ projectDir, embeddingPolicy: "skip", qwen3vlEnabled: false });

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
    await buildFootageDb({ projectDir, embeddingPolicy: "skip", qwen3vlEnabled: false });

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

  it("applies metadata filters for camera motion, shot scale, stability, dialogue, audio role, and usability", async () => {
    const projectDir = makeProject();
    const { buildFootageDb } = await import("../runtime/artifacts/footage-db-builder.js");
    const { searchFootage } = await import("../runtime/tools/footage-search.js");
    await buildFootageDb({ projectDir, embeddingPolicy: "skip", qwen3vlEnabled: false });

    const pan = await searchFootage(projectDir, {
      query: "",
      mode: "structured",
      filters: { camera_motion_type: "pan" },
    });
    expect(pan.results.map((result) => result.segment_id)).toEqual(["SEG_food"]);
    expect(pan.results[0].metadata).toMatchObject({ camera_motion_type: "pan", shot_scale: "detail" });

    const wide = await searchFootage(projectDir, {
      query: "",
      mode: "structured",
      filters: { shot_scale: "wide" },
    });
    expect(wide.results.map((result) => result.segment_id)).toEqual(["SEG_river"]);

    const shaky = await searchFootage(projectDir, {
      query: "",
      mode: "structured",
      filters: { camera_stability: "shaky" },
    });
    expect(shaky.results.map((result) => result.segment_id)).toEqual(["SEG_river"]);

    const dialogue = await searchFootage(projectDir, {
      query: "",
      mode: "structured",
      filters: { has_dialogue: true },
    });
    expect(dialogue.results.map((result) => result.segment_id)).toEqual(["SEG_food"]);

    const audioRole = await searchFootage(projectDir, {
      query: "",
      mode: "structured",
      filters: { audio_role: "dialogue" },
    });
    expect(audioRole.results.map((result) => result.segment_id)).toEqual(["SEG_food"]);

    const unusable = await searchFootage(projectDir, {
      query: "",
      mode: "structured",
      filters: { usability: "unusable" },
    });
    expect(unusable.results.map((result) => result.segment_id)).toEqual(["SEG_river"]);
  });

  it("loads footage_user_annotations sidecar into logging metadata", async () => {
    const projectDir = makeProject();
    writeJson(projectDir, "03_analysis/footage_user_annotations.json", {
      annotations: [{
        segment_id: "SEG_food",
        scene: "03",
        shot: "02",
        take: "01",
        circle_take: true,
        best_take: true,
        custom_tags: ["best-light", "hero"],
        operator_notes: "best light",
        camera_id: "A",
        card_id: "CARD_02",
      }],
    });
    const { buildFootageDb } = await import("../runtime/artifacts/footage-db-builder.js");
    const { searchFootage } = await import("../runtime/tools/footage-search.js");
    const { footageDbPath } = await import("../runtime/artifacts/footage-db.js");
    await buildFootageDb({ projectDir, embeddingPolicy: "skip", qwen3vlEnabled: false });

    const db = new Database(footageDbPath(projectDir), { readonly: true, fileMustExist: true });
    try {
      expect(db.prepare("SELECT scene_number, shot_number, take_number, circle_take, best_take, camera_id, card_id, source FROM segment_logging_profile WHERE segment_id = 'SEG_food'").get()).toMatchObject({
        scene_number: "03",
        shot_number: "02",
        take_number: "01",
        circle_take: 1,
        best_take: 1,
        camera_id: "A",
        card_id: "CARD_02",
        source: "user_annotation",
      });
    } finally {
      db.close();
    }

    const circle = await searchFootage(projectDir, {
      query: "",
      mode: "structured",
      filters: { scene_number: "03", take_number: "01", circle_take: true, custom_tags_any: ["hero"] },
    });
    expect(circle.results.map((result) => result.segment_id)).toEqual(["SEG_food"]);
  });

  it("queries segment_metadata_fts when segment FTS has no matching rows", async () => {
    const projectDir = makeProject();
    writeJson(projectDir, "03_analysis/footage_user_annotations.json", {
      annotations: [{ segment_id: "SEG_food", notes: "best light", custom_tags: ["circle-select"] }],
    });
    const { buildFootageDb } = await import("../runtime/artifacts/footage-db-builder.js");
    const { footageDbPath } = await import("../runtime/artifacts/footage-db.js");
    const { searchFootage } = await import("../runtime/tools/footage-search.js");
    await buildFootageDb({ projectDir, embeddingPolicy: "skip", qwen3vlEnabled: false });

    const db = new Database(footageDbPath(projectDir));
    try {
      db.prepare("DELETE FROM segments_fts").run();
    } finally {
      db.close();
    }

    const response = await searchFootage(projectDir, { query: "circle-select", mode: "text" });
    expect(response.results.map((result) => result.segment_id)).toEqual(["SEG_food"]);
  });

  it("extracts audio levels and silence from mocked ffmpeg output", async () => {
    const projectDir = makeProject();
    fs.mkdirSync(path.join(projectDir, "02_media"), { recursive: true });
    fs.writeFileSync(path.join(projectDir, "02_media/food.mov"), "mock media");
    execFileMock.mockImplementation((_cmd: string, args: string[], _options: unknown, cb: (error: Error | null, stdout: string, stderr: string) => void) => {
      const filter = args[args.indexOf("-af") + 1];
      if (filter === "volumedetect") {
        cb(null, "", "mean_volume: -20.0 dB\nmax_volume: -1.2 dB\n");
      } else if (filter.startsWith("ebur128")) {
        cb(null, "", "I: -18.4 LUFS\n");
      } else if (filter.startsWith("silencedetect")) {
        cb(null, "", "silence_start: 0\nsilence_end: 0.5 | silence_duration: 0.5\nsilence_start: 3.5\nsilence_end: 4.0 | silence_duration: 0.5\n");
      } else {
        cb(new Error(`unexpected filter ${filter}`), "", "");
      }
      return {} as never;
    });

    const { buildFootageDb } = await import("../runtime/artifacts/footage-db-builder.js");
    const { footageDbPath } = await import("../runtime/artifacts/footage-db.js");
    await buildFootageDb({ projectDir, embeddingPolicy: "skip", qwen3vlEnabled: false });

    const db = new Database(footageDbPath(projectDir), { readonly: true, fileMustExist: true });
    try {
      expect(db.prepare("SELECT peak_dbfs, rms_dbfs, integrated_lufs, silence_ratio, silence_head_us, silence_tail_us FROM segment_audio_profile WHERE segment_id = 'SEG_food'").get()).toMatchObject({
        peak_dbfs: -1.2,
        rms_dbfs: -20,
        integrated_lufs: -18.4,
        silence_ratio: 0.25,
        silence_head_us: 500000,
        silence_tail_us: 500000,
      });
    } finally {
      db.close();
    }
  });

  it("classifies partially usable segments from quality flags and mixed scores", async () => {
    const projectDir = makeProject();
    const segmentsPath = path.join(projectDir, "03_analysis/segments.json");
    const segmentsJson = JSON.parse(fs.readFileSync(segmentsPath, "utf-8")) as { items: Array<Record<string, unknown>> };
    segmentsJson.items[0].quality_flags = ["blur"];
    segmentsJson.items[0].visual_quality = {
      scores: {
        light_quality: 0.9,
        subject_prominence: 0.85,
        emotional_expression: 0.5,
        composition_score: 0.92,
        motion_quality: 0.2,
      },
    };
    fs.writeFileSync(segmentsPath, `${JSON.stringify(segmentsJson, null, 2)}\n`, "utf-8");
    const { buildFootageDb } = await import("../runtime/artifacts/footage-db-builder.js");
    const { footageDbPath } = await import("../runtime/artifacts/footage-db.js");
    await buildFootageDb({ projectDir, embeddingPolicy: "skip", qwen3vlEnabled: false });

    const db = new Database(footageDbPath(projectDir), { readonly: true, fileMustExist: true });
    try {
      const row = db.prepare("SELECT usability, confidence, evidence_json FROM segment_usability_profile WHERE segment_id = 'SEG_food'").get() as {
        usability: string;
        confidence: number;
        evidence_json: string;
      };
      expect(row.usability).toBe("partially_usable");
      expect(row.confidence).toBeGreaterThan(0.7);
      expect(JSON.parse(row.evidence_json)).toContain("quality_flag:blur");
    } finally {
      db.close();
    }
  });

  it("stores local embeddings and ranks semantic matches by vector score", async () => {
    const projectDir = makeProject();
    const { buildFootageDb } = await import("../runtime/artifacts/footage-db-builder.js");
    const { footageDbPath } = await import("../runtime/artifacts/footage-db.js");
    const { searchFootage } = await import("../runtime/tools/footage-search.js");
    const build = await buildFootageDb({ projectDir, embeddingPolicy: "require", qwen3vlEnabled: false });
    expect(build.embedding_status).toBe("ready");
    expect(build.counts.embeddings).toBeGreaterThan(0);
    expect(build.embedding_counts?.e5_text).toBe(build.counts.embeddings);
    expect(build.embedding_statuses?.e5_text).toBe("ready");

    const db = new Database(footageDbPath(projectDir));
    try {
      const legacyCount = db.prepare("SELECT COUNT(*) FROM embeddings").pluck().get() as number;
      const segmentEmbeddingCount = db.prepare("SELECT COUNT(*) FROM segment_embeddings").pluck().get() as number;
      expect(legacyCount).toBeGreaterThan(0);
      expect(segmentEmbeddingCount).toBe(legacyCount);
      expect(db.prepare(`
        SELECT
          name,
          model_revision,
          output_dimension,
          input_modality,
          instruction,
          preprocess_version,
          runner_name,
          runner_version,
          precision,
          normalized,
          distance_metric,
          license
        FROM embedding_models
      `).get()).toMatchObject({
        name: "Xenova/multilingual-e5-small",
        model_revision: "legacy-unpinned",
        output_dimension: 384,
        input_modality: "text",
        instruction: "e5-query-passage-prefix-v1",
        preprocess_version: "footage-db-text-bundle-v1",
        runner_name: "transformers.js",
        runner_version: "unknown",
        precision: "q8",
        normalized: 1,
        distance_metric: "cosine",
        license: "model-card-verified-before-release",
      });
      expect(db.prepare(`
        SELECT se.embedding_type, se.source_ref, se.source_timestamp_us, se.dimension, se.created_at
        FROM segment_embeddings se
        WHERE se.segment_id = 'SEG_food' AND se.embedding_type = 'combined'
      `).get()).toMatchObject({
        embedding_type: "combined",
        source_ref: "embedding_texts:combined",
        source_timestamp_us: null,
        dimension: 384,
      });
      db.prepare("DELETE FROM embeddings").run();
    } finally {
      db.close();
    }

    const response = await searchFootage(projectDir, {
      query: "sweet food",
      semantic: "sweet food",
      mode: "semantic",
      limit: 2,
    });
    expect(response.results.map((result) => result.segment_id)).toEqual(["SEG_food", "SEG_river"]);
    expect(response.results[0].scores.semantic).toBeGreaterThan(response.results[1].scores.semantic ?? 0);
  });

  it("skips corrupt segment_embeddings vectors with warnings", async () => {
    const projectDir = makeProject();
    const { buildFootageDb } = await import("../runtime/artifacts/footage-db-builder.js");
    const { footageDbPath } = await import("../runtime/artifacts/footage-db.js");
    const { searchFootage } = await import("../runtime/tools/footage-search.js");
    await buildFootageDb({ projectDir, embeddingPolicy: "require", qwen3vlEnabled: false });

    const dbPath = footageDbPath(projectDir);
    let db = new Database(dbPath);
    try {
      db.prepare(`
        UPDATE segment_embeddings
        SET vector = @vector
        WHERE segment_id = 'SEG_food' AND embedding_type = 'combined'
      `).run({ vector: Buffer.alloc(4) });
    } finally {
      db.close();
    }
    let response = await searchFootage(projectDir, { query: "sweet food", semantic: "sweet food", mode: "semantic" });
    expect(response.warnings.some((warning) => warning.includes("vector byte length"))).toBe(true);

    db = new Database(dbPath);
    try {
      db.prepare(`
        UPDATE segment_embeddings
        SET dimension = 384, vector = @vector
        WHERE segment_id = 'SEG_food' AND embedding_type = 'combined'
      `).run({ vector: unitVectorBlob(384, 0) });
      db.prepare(`
        UPDATE segment_embeddings
        SET vector = @vector
        WHERE segment_id = 'SEG_river' AND embedding_type = 'combined'
      `).run({ vector: nanVectorBlob(384) });
    } finally {
      db.close();
    }
    response = await searchFootage(projectDir, { query: "sweet food", semantic: "sweet food", mode: "semantic" });
    expect(response.warnings.some((warning) => warning.includes("non-finite value"))).toBe(true);

    db = new Database(dbPath);
    try {
      db.prepare(`
        UPDATE segment_embeddings
        SET vector = @vector
        WHERE segment_id = 'SEG_river' AND embedding_type = 'combined'
      `).run({ vector: unitVectorBlob(384, 1) });
      db.prepare(`
        UPDATE segment_embeddings
        SET dimension = 383, vector = @vector
        WHERE segment_id = 'SEG_food' AND embedding_type = 'combined'
      `).run({ vector: unitVectorBlob(383, 0) });
    } finally {
      db.close();
    }
    response = await searchFootage(projectDir, { query: "sweet food", semantic: "sweet food", mode: "semantic" });
    expect(response.warnings.some((warning) => warning.includes("does not match embedding_models.output_dimension"))).toBe(true);
  });

  it("falls back to legacy embeddings when segment_embeddings is absent", async () => {
    const projectDir = makeProject();
    const { buildFootageDb } = await import("../runtime/artifacts/footage-db-builder.js");
    const { footageDbPath } = await import("../runtime/artifacts/footage-db.js");
    const { searchFootage } = await import("../runtime/tools/footage-search.js");
    await buildFootageDb({ projectDir, embeddingPolicy: "require", qwen3vlEnabled: false });

    const db = new Database(footageDbPath(projectDir));
    try {
      db.exec(`
        DROP TABLE segment_embeddings;
        DROP TABLE embedding_models;
      `);
    } finally {
      db.close();
    }

    const response = await searchFootage(projectDir, {
      query: "sweet food",
      semantic: "sweet food",
      mode: "semantic",
      limit: 2,
    });
    expect(response.results.map((result) => result.segment_id)).toEqual(["SEG_food", "SEG_river"]);
    expect(response.warnings.some((warning) => warning.includes("semantic embeddings unavailable"))).toBe(false);
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
    await buildFootageDb({ projectDir, embeddingPolicy: "skip", qwen3vlEnabled: false });

    const db = new Database(footageDbPath(projectDir));
    try {
      db.exec(`
        DROP TABLE segment_metadata_fts;
        DROP TABLE segment_usability_profile;
        DROP TABLE segment_logging_profile;
        DROP TABLE segment_audio_profile;
        DROP TABLE segment_visual_profile;
        DROP TABLE asset_technical_metadata;
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
      filters: { camera_motion_type: "pan" },
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
    await buildFootageDb({ projectDir, embeddingPolicy: "skip", qwen3vlEnabled: false });

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

function writeSourceMedia(projectDir: string): void {
  fs.mkdirSync(path.join(projectDir, "02_media"), { recursive: true });
  fs.writeFileSync(path.join(projectDir, "02_media/food.mov"), "food media");
  fs.writeFileSync(path.join(projectDir, "02_media/river.mov"), "river media");
}

function mockFrameExtraction(): void {
  execFileMock.mockImplementation((_cmd: string, args: string[], _options: unknown, cb: (error: Error | null, stdout: string, stderr: string) => void) => {
    const outputPath = args[args.length - 1];
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, `frame:${args.join("|")}`);
    cb(null, "", "");
    return {} as never;
  });
}

function updateSegment(projectDir: string, segmentId: string, patch: Record<string, unknown>): void {
  const segmentsPath = path.join(projectDir, "03_analysis/segments.json");
  const segments = JSON.parse(fs.readFileSync(segmentsPath, "utf-8")) as { items: Array<Record<string, unknown>> };
  const segment = segments.items.find((item) => item.segment_id === segmentId);
  if (!segment) throw new Error(`missing segment fixture ${segmentId}`);
  Object.assign(segment, patch);
  fs.writeFileSync(segmentsPath, `${JSON.stringify(segments, null, 2)}\n`, "utf-8");
}

function updateAsset(projectDir: string, assetId: string, patch: Record<string, unknown>): void {
  const assetsPath = path.join(projectDir, "03_analysis/assets.json");
  const assets = JSON.parse(fs.readFileSync(assetsPath, "utf-8")) as { items: Array<Record<string, unknown>> };
  const asset = assets.items.find((item) => item.asset_id === assetId);
  if (!asset) throw new Error(`missing asset fixture ${assetId}`);
  Object.assign(asset, patch);
  fs.writeFileSync(assetsPath, `${JSON.stringify(assets, null, 2)}\n`, "utf-8");
}

function writeJson(projectDir: string, relPath: string, value: unknown): void {
  const filePath = path.join(projectDir, relPath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}

function unitVectorBlob(dimension: number, axis: number): Buffer {
  const vector = unitVector(dimension, axis);
  return Buffer.from(vector.buffer);
}

function unitVector(dimension: number, axis: number): Float32Array {
  const vector = new Float32Array(dimension);
  vector[axis % dimension] = 1;
  return vector;
}

function nanVectorBlob(dimension: number): Buffer {
  const vector = new Float32Array(dimension);
  vector[0] = Number.NaN;
  return Buffer.from(vector.buffer);
}
