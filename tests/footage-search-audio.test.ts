import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const qwenCreateMock = vi.hoisted(() => vi.fn());
const qwenEmbedTextMock = vi.hoisted(() => vi.fn());
const qwenShutdownMock = vi.hoisted(() => vi.fn());
const clapCreateMock = vi.hoisted(() => vi.fn());
const clapEmbedTextMock = vi.hoisted(() => vi.fn());
const clapEmbedAudioMock = vi.hoisted(() => vi.fn());
const clapShutdownMock = vi.hoisted(() => vi.fn());

vi.mock("../runtime/eval/semantic-match.js", () => {
  const TEST_EMBEDDING_DIMENSION = 384;

  function unitVector(axis: number): Float32Array {
    const vector = new Float32Array(TEST_EMBEDDING_DIMENSION);
    vector[axis % TEST_EMBEDDING_DIMENSION] = 1;
    return vector;
  }

  function vectorFor(text: string): Float32Array {
    if (/warm|chestnut|food|sweet/i.test(text)) return unitVector(0);
    if (/river|water|ambient|room tone/i.test(text)) return unitVector(1);
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

vi.mock("../runtime/connectors/qwen3vl-embedding-local.js", () => ({
  createQwen3VlEmbeddingLocalClient: qwenCreateMock,
}));

vi.mock("../runtime/connectors/clap-audio-local.js", () => ({
  createClapAudioEmbeddingLocalClient: clapCreateMock,
}));

const tempDirs: string[] = [];
const QWEN_DIMENSION = 2048;
const CLAP_DIMENSION = 512;

beforeEach(() => {
  qwenEmbedTextMock.mockImplementation(async (texts: string[], options: { outputDimension?: number } = {}) => ({
    vectors: texts.map((text, index) => ({
      ref: String(index),
      vector: vectorForSearchText(text, options.outputDimension ?? QWEN_DIMENSION),
      dimension: options.outputDimension ?? QWEN_DIMENSION,
      normalized: true,
    })),
    model: { name: "Qwen/Qwen3-VL-Embedding-2B" },
    elapsedMs: 0,
  }));
  qwenCreateMock.mockImplementation(() => ({
    embedText: qwenEmbedTextMock,
    embedImage: vi.fn(),
    embedMixed: vi.fn(),
    embedBatch: vi.fn(),
    shutdown: qwenShutdownMock,
  }));
  clapEmbedTextMock.mockImplementation(async (texts: string[], options: { outputDimension?: number } = {}) => ({
    vectors: texts.map((text, index) => ({
      ref: String(index),
      vector: vectorForSearchText(text, options.outputDimension ?? CLAP_DIMENSION),
      dimension: options.outputDimension ?? CLAP_DIMENSION,
      normalized: true,
    })),
    model: { name: "laion/clap-htsat-fused" },
    elapsedMs: 0,
  }));
  clapEmbedAudioMock.mockImplementation(async (audioPaths: string[], options: { outputDimension?: number } = {}) => ({
    vectors: audioPaths.map((audioPath, index) => ({
      ref: String(index),
      vector: vectorForSearchText(audioPath, options.outputDimension ?? CLAP_DIMENSION),
      dimension: options.outputDimension ?? CLAP_DIMENSION,
      normalized: true,
    })),
    model: { name: "laion/clap-htsat-fused" },
    elapsedMs: 0,
  }));
  clapCreateMock.mockImplementation(() => ({
    embedText: clapEmbedTextMock,
    embedAudio: clapEmbedAudioMock,
    embedBatch: vi.fn(),
    shutdown: clapShutdownMock,
  }));
});

afterEach(async () => {
  try {
    const { disposeFootageSearch } = await import("../runtime/tools/footage-search.js");
    await disposeFootageSearch();
  } catch {
    // Validation-only tests may not import the search module.
  }
  qwenCreateMock.mockReset();
  qwenEmbedTextMock.mockReset();
  qwenShutdownMock.mockReset();
  clapCreateMock.mockReset();
  clapEmbedTextMock.mockReset();
  clapEmbedAudioMock.mockReset();
  clapShutdownMock.mockReset();
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("footage search CLAP audio fusion", () => {
  it("preserves legacy hybrid weights when CLAP rows are absent", async () => {
    const projectDir = makeProject();
    await buildDb(projectDir);
    const { searchFootage } = await import("../runtime/tools/footage-search.js");

    const response = await searchFootage(projectDir, {
      query: "warm chestnut",
      semantic: "warm chestnut",
      mode: "hybrid",
      limit: 2,
    });

    expect(clapCreateMock).not.toHaveBeenCalled();
    expect(response.results[0].scores.weights).toEqual({
      semantic: 0.55,
      lexical: 0.30,
      quality: 0.10,
      peak: 0.05,
    });
    expect(response.results[0].scores.audio_similarity).toBeUndefined();
  });

  it("uses audio_similarity in hybrid fusion when CLAP and Qwen channels are present", async () => {
    const projectDir = makeProject();
    await buildDb(projectDir);
    insertQwenRows(projectDir);
    insertClapRows(projectDir);
    const { searchFootage } = await import("../runtime/tools/footage-search.js");

    const response = await searchFootage(projectDir, {
      query: "warm chestnut",
      semantic: "warm chestnut",
      mode: "hybrid",
      limit: 2,
    });

    const top = response.results[0];
    expect(top.segment_id).toBe("SEG_food");
    expect(top.scores.weights).toEqual({
      e5_text: 0.25,
      qwen_visual: 0.20,
      qwen_text: 0.08,
      audio_similarity: 0.10,
      lexical: 0.20,
      quality: 0.10,
      peak: 0.05,
      duration: 0.02,
    });
    expect(top.scores.audio_similarity).toBe(1);
    expect(top.scores.clap_audio).toBe(1);
    expect(top.scores.embedding_matches?.some((match) => match.embedding_type === "audio_representative")).toBe(true);
  });

  it("uses audio mode with audio_query_path", async () => {
    const projectDir = makeProject();
    await buildDb(projectDir);
    insertClapRows(projectDir);
    const audioPath = path.join(projectDir, "03_analysis/reference-river.wav");
    fs.writeFileSync(audioPath, "river audio query");
    const { searchFootage } = await import("../runtime/tools/footage-search.js");

    const response = await searchFootage(projectDir, {
      query: "",
      mode: "audio",
      audio_query_path: audioPath,
      limit: 2,
    });

    expect(clapEmbedAudioMock).toHaveBeenCalledWith([fs.realpathSync(audioPath)], expect.any(Object));
    expect(response.results[0].segment_id).toBe("SEG_river");
    expect(response.results[0].scores.audio_similarity).toBe(1);
    expect(response.results[0].scores.weights?.audio_similarity).toBeCloseTo(0.85, 6);
    expect(response.results[0].scores.unavailable_channels).toEqual(expect.arrayContaining(["e5_text", "lexical"]));
  });

  it("returns an empty audio result with a warning when no audio path or text query is provided", async () => {
    const projectDir = makeProject();
    const { searchFootage } = await import("../runtime/tools/footage-search.js");

    const response = await searchFootage(projectDir, { query: "", mode: "audio" });

    expect(response.results).toEqual([]);
    expect(response.warnings.some((warning) => warning.includes("audio mode requires audio_query_path or query text"))).toBe(true);
    expect(clapCreateMock).not.toHaveBeenCalled();
  });

  it("falls back to exact current Qwen hybrid weights when CLAP query embedding fails", async () => {
    const projectDir = makeProject();
    await buildDb(projectDir);
    insertQwenRows(projectDir);
    insertClapRows(projectDir);
    clapEmbedTextMock.mockRejectedValueOnce(new Error("CLAP unavailable"));
    const { searchFootage } = await import("../runtime/tools/footage-search.js");

    const response = await searchFootage(projectDir, {
      query: "warm chestnut",
      semantic: "warm chestnut",
      mode: "hybrid",
      limit: 2,
    });

    expect(response.results[0].scores.weights).toEqual({
      qwen_visual: 0.35,
      qwen_text: 0.10,
      e5_text: 0.25,
      lexical: 0.15,
      quality: 0.10,
      peak: 0.05,
    });
    expect(response.results[0].scores.audio_similarity).toBeUndefined();
    expect(response.warnings.some((warning) => warning.includes("clap audio search embedding unavailable"))).toBe(true);
  });
});

async function buildDb(projectDir: string): Promise<void> {
  const { buildFootageDb } = await import("../runtime/artifacts/footage-db-builder.js");
  await buildFootageDb({
    projectDir,
    embeddingPolicy: "require",
    qwen3vlEnabled: false,
    clapAudioEnabled: false,
    skipAudioAnalysis: true,
    now: new Date("2026-06-20T00:00:00.000Z"),
  });
}

function insertQwenRows(projectDir: string): void {
  const db = new Database(path.join(projectDir, "03_analysis/search/footage.db"));
  try {
    const modelId = upsertQwenModel(db);
    insertEmbedding(db, modelId, "SEG_food", "visual_representative", QWEN_DIMENSION, 0, "03_analysis/frames/SEG_food/representative.jpg", 2_000_000);
    insertEmbedding(db, modelId, "SEG_food", "text_combined_qwen", QWEN_DIMENSION, 0, "embedding_texts:combined", null);
    insertEmbedding(db, modelId, "SEG_river", "visual_representative", QWEN_DIMENSION, 1, "03_analysis/frames/SEG_river/representative.jpg", 3_000_000);
    insertEmbedding(db, modelId, "SEG_river", "text_combined_qwen", QWEN_DIMENSION, 1, "embedding_texts:combined", null);
  } finally {
    db.close();
  }
}

function insertClapRows(projectDir: string): void {
  const db = new Database(path.join(projectDir, "03_analysis/search/footage.db"));
  try {
    const modelId = upsertClapModel(db);
    insertEmbedding(db, modelId, "SEG_food", "audio_representative", CLAP_DIMENSION, 0, "03_analysis/audio_windows/SEG_food/full.wav", 0);
    insertEmbedding(db, modelId, "SEG_food", "audio_text_clap", CLAP_DIMENSION, 0, "embedding_texts:combined", null);
    insertEmbedding(db, modelId, "SEG_river", "audio_representative", CLAP_DIMENSION, 1, "03_analysis/audio_windows/SEG_river/full.wav", 0);
    insertEmbedding(db, modelId, "SEG_river", "audio_text_clap", CLAP_DIMENSION, 1, "embedding_texts:combined", null);
  } finally {
    db.close();
  }
}

function insertEmbedding(
  db: Database.Database,
  modelId: number,
  segmentId: string,
  embeddingType: string,
  dimension: number,
  axis: number,
  sourceRef: string,
  sourceTimestampUs: number | null,
): void {
  db.prepare(`
    INSERT INTO segment_embeddings (
      segment_id, embedding_type, model_id, source_ref, source_timestamp_us,
      content_hash, dimension, vector, created_at
    ) VALUES (
      @segment_id, @embedding_type, @model_id, @source_ref, @source_timestamp_us,
      @content_hash, @dimension, @vector, @created_at
    )
  `).run({
    segment_id: segmentId,
    embedding_type: embeddingType,
    model_id: modelId,
    source_ref: sourceRef,
    source_timestamp_us: sourceTimestampUs,
    content_hash: `${segmentId}:${embeddingType}`,
    dimension,
    vector: unitVectorBlob(dimension, axis),
    created_at: "2026-06-20T00:00:00.000Z",
  });
}

function upsertQwenModel(db: Database.Database): number {
  return upsertModel(db, {
    name: "Qwen/Qwen3-VL-Embedding-2B",
    model_revision: "local-cache",
    output_dimension: QWEN_DIMENSION,
    input_modality: "multimodal",
    instruction: "Retrieve relevant video footage for editing.",
    preprocess_version: "qwen3vl-frame-v1",
    runner_name: "python-qwen3vl-worker",
    runner_version: "qwen3vl-worker-v1",
    precision: "fp16",
    normalized: 1,
    distance_metric: "cosine",
    license: "Apache-2.0",
    created_at: "2026-06-20T00:00:00.000Z",
  });
}

function upsertClapModel(db: Database.Database): number {
  return upsertModel(db, {
    name: "laion/clap-htsat-fused",
    model_revision: "local-cache",
    output_dimension: CLAP_DIMENSION,
    input_modality: "audio",
    instruction: "",
    preprocess_version: "clap-audio-window-v1",
    runner_name: "python-clap-audio-worker",
    runner_version: "clap-audio-worker-v1",
    precision: "fp32",
    normalized: 1,
    distance_metric: "cosine",
    license: "Apache-2.0",
    created_at: "2026-06-20T00:00:00.000Z",
  });
}

function upsertModel(db: Database.Database, params: Record<string, unknown>): number {
  db.prepare(`
    INSERT OR IGNORE INTO embedding_models (
      name, model_revision, output_dimension, input_modality, instruction, preprocess_version,
      runner_name, runner_version, precision, normalized, distance_metric, license, created_at
    ) VALUES (
      @name, @model_revision, @output_dimension, @input_modality, @instruction, @preprocess_version,
      @runner_name, @runner_version, @precision, @normalized, @distance_metric, @license, @created_at
    )
  `).run(params);
  const row = db.prepare(`
    SELECT id
    FROM embedding_models
    WHERE name = @name
      AND model_revision = @model_revision
      AND output_dimension = @output_dimension
      AND input_modality = @input_modality
      AND instruction = @instruction
      AND preprocess_version = @preprocess_version
      AND runner_name = @runner_name
      AND runner_version = @runner_version
      AND precision = @precision
      AND normalized = @normalized
      AND distance_metric = @distance_metric
    LIMIT 1
  `).get(params) as { id: number } | undefined;
  if (!row) throw new Error("failed to upsert embedding model");
  return row.id;
}

function makeProject(): string {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "footage-search-audio-"));
  tempDirs.push(projectDir);
  fs.mkdirSync(path.join(projectDir, "03_analysis/transcripts"), { recursive: true });
  fs.mkdirSync(path.join(projectDir, "03_analysis/search"), { recursive: true });

  writeJson(projectDir, "03_analysis/assets.json", {
    project_id: "footage-search-audio-fixture",
    artifact_version: "assets-v1",
    items: [
      {
        asset_id: "AST_food",
        filename: "food.mov",
        duration_us: 8_000_000,
        has_transcript: true,
        transcript_ref: "TR_AST_food",
        tags: ["food", "chestnut"],
        source_locator: "02_media/food.mov",
        source_fingerprint: "sha256:food",
      },
      {
        asset_id: "AST_river",
        filename: "river.mov",
        duration_us: 12_000_000,
        tags: ["river", "water"],
        source_locator: "02_media/river.mov",
        source_fingerprint: "sha256:river",
      },
    ],
  });

  writeJson(projectDir, "03_analysis/segments.json", {
    project_id: "footage-search-audio-fixture",
    artifact_version: "segments-v1",
    items: [
      {
        segment_id: "SEG_food",
        asset_id: "AST_food",
        src_in_us: 0,
        src_out_us: 4_000_000,
        rep_frame_us: 2_000_000,
        segment_type: "action",
        summary: "warm closeup of chestnut preparation",
        transcript_excerpt: "Fresh chestnut is sweet.",
        transcript_ref: "TR_AST_food",
        tags: ["chestnut", "food", "warm"],
        visual_quality: {
          scores: {
            light_quality: 0.9,
            subject_prominence: 0.85,
            emotional_expression: 0.5,
            composition_score: 0.92,
            motion_quality: 0.8,
          },
        },
        peak_analysis: {
          support_signals: { fused_peak_score: 0.8 },
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
        visual_quality: {
          scores: {
            light_quality: 0.2,
            subject_prominence: 0.2,
            emotional_expression: 0.2,
            composition_score: 0.2,
            motion_quality: 0.2,
          },
        },
      },
    ],
  });

  writeJson(projectDir, "03_analysis/transcripts/TR_AST_food.json", {
    project_id: "footage-search-audio-fixture",
    artifact_version: "transcript-v1",
    transcript_ref: "TR_AST_food",
    asset_id: "AST_food",
    items: [{
      item_id: "utt_1",
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

function vectorForSearchText(value: string, dimension: number): Float32Array {
  if (/warm|chestnut|food|sweet/i.test(value)) return unitVector(dimension, 0);
  if (/river|water|ambient|room tone/i.test(value)) return unitVector(dimension, 1);
  return unitVector(dimension, 2);
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
