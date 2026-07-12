import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const execFileMock = vi.hoisted(() => vi.fn());
const qwenCreateMock = vi.hoisted(() => vi.fn());
const qwenEmbedTextMock = vi.hoisted(() => vi.fn());
const qwenEmbedImageMock = vi.hoisted(() => vi.fn());
const qwenShutdownMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({
  execFile: execFileMock,
}));

vi.mock("../runtime/eval/semantic-match.js", () => {
  const TEST_EMBEDDING_DIMENSION = 384;

  function unitVector(axis: number): Float32Array {
    const vector = new Float32Array(TEST_EMBEDDING_DIMENSION);
    vector[axis % TEST_EMBEDDING_DIMENSION] = 1;
    return vector;
  }

  function vectorFor(text: string): Float32Array {
    const lower = text.toLowerCase();
    if (/chestnut|warm|sweet|food/.test(lower)) return unitVector(0);
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

vi.mock("../runtime/connectors/qwen3vl-embedding-local.js", () => ({
  createQwen3VlEmbeddingLocalClient: qwenCreateMock,
}));

const tempDirs: string[] = [];
const QWEN_DIMENSION = 2048;

beforeEach(() => {
  process.env.VOS_QWEN3VL_MOCK = "1";
  qwenEmbedTextMock.mockImplementation(async (texts: string[], options: { outputDimension?: number } = {}) => ({
    vectors: texts.map((text, index) => ({
      ref: String(index),
      vector: qwenVectorForText(text, options.outputDimension ?? QWEN_DIMENSION),
      dimension: options.outputDimension ?? QWEN_DIMENSION,
      normalized: true,
    })),
    model: qwenModel(options.outputDimension ?? QWEN_DIMENSION),
    elapsedMs: 0,
  }));
  qwenEmbedImageMock.mockImplementation(async (imagePaths: string[], options: { outputDimension?: number } = {}) => ({
    vectors: imagePaths.map((imagePath, index) => ({
      ref: String(index),
      vector: qwenVectorForImage(imagePath, options.outputDimension ?? QWEN_DIMENSION),
      dimension: options.outputDimension ?? QWEN_DIMENSION,
      normalized: true,
    })),
    model: qwenModel(options.outputDimension ?? QWEN_DIMENSION),
    elapsedMs: 0,
  }));
  qwenCreateMock.mockImplementation(() => ({
    embedText: qwenEmbedTextMock,
    embedImage: qwenEmbedImageMock,
    embedMixed: vi.fn(),
    embedBatch: vi.fn(),
    shutdown: qwenShutdownMock,
  }));
});

afterEach(async () => {
  delete process.env.VOS_QWEN3VL_MOCK;
  try {
    const { disposeFootageSearch } = await import("../runtime/tools/footage-search.js");
    await disposeFootageSearch();
  } catch {
    // Some validation-only tests return before the search module starts Qwen.
  }
  execFileMock.mockReset();
  qwenCreateMock.mockReset();
  qwenEmbedTextMock.mockReset();
  qwenEmbedImageMock.mockReset();
  qwenShutdownMock.mockReset();
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("footage search Qwen fusion", () => {
  it("preserves legacy hybrid weights and ranking when Qwen rows are absent", async () => {
    const projectDir = makeProject();
    await buildDb(projectDir, "require");
    const { searchFootage } = await import("../runtime/tools/footage-search.js");

    const response = await searchFootage(projectDir, {
      query: "warm chestnut",
      semantic: "warm chestnut",
      mode: "hybrid",
      limit: 2,
    });

    expect(qwenCreateMock).not.toHaveBeenCalled();
    expect(response.results.map((result) => result.segment_id)).toEqual(["SEG_food", "SEG_river"]);
    expect(response.results[0].scores.weights).toEqual({
      semantic: 0.55,
      lexical: 0.30,
      quality: 0.10,
      peak: 0.05,
    });
  });

  it("uses Qwen-present text fusion weights for hybrid text queries", async () => {
    const projectDir = makeProject();
    await buildDb(projectDir, "require");
    insertQwenRows(projectDir);
    const { searchFootage } = await import("../runtime/tools/footage-search.js");

    const response = await searchFootage(projectDir, {
      query: "warm chestnut",
      semantic: "warm chestnut",
      mode: "hybrid",
      limit: 2,
    });

    const top = response.results[0];
    expect(qwenCreateMock).toHaveBeenCalledTimes(1);
    expect(qwenEmbedTextMock).toHaveBeenCalledTimes(1);
    expect(top.segment_id).toBe("SEG_food");
    expect(top.scores.weights).toEqual({
      qwen_visual: 0.35,
      qwen_text: 0.10,
      e5_text: 0.25,
      lexical: 0.15,
      quality: 0.10,
      peak: 0.05,
    });
    expect(top.scores).toMatchObject({
      semantic: 1,
      e5_text: 1,
      lexical: 1,
      qwen_text: 1,
      qwen_visual: 1,
    });
    expect(top.scores.embedding_matches?.some((match) => match.embedding_type === "visual_representative")).toBe(true);
  });

  it("uses a heavy redistributed Qwen visual weight for image-only visual mode", async () => {
    const projectDir = makeProject();
    await buildDb(projectDir, "require");
    insertQwenRows(projectDir);
    const imagePath = writeQueryImage(projectDir, "food-query.jpg");
    const { searchFootage } = await import("../runtime/tools/footage-search.js");

    const response = await searchFootage(projectDir, {
      query: "",
      mode: "visual",
      image_query_path: imagePath,
      limit: 2,
    });

    const top = response.results[0];
    expect(qwenEmbedImageMock).toHaveBeenCalledTimes(1);
    expect(top.segment_id).toBe("SEG_food");
    expect(top.key_frame_path).toBe("03_analysis/frames/SEG_food/representative.jpg");
    expect(top.scores.weights).toEqual({
      qwen_visual: 0.80,
      quality: 0.12,
      peak: 0.05,
      duration: 0.03,
    });
    expect(top.scores.unavailable_channels).toBeUndefined();
  });

  it("accepts image_query_path under symlinked 03_analysis and 02_media roots", async () => {
    const projectDir = makeProject();
    await buildDb(projectDir, "require");
    insertQwenRows(projectDir);

    const analysisTargetParent = fs.mkdtempSync(path.join(os.tmpdir(), "footage-search-analysis-target-"));
    tempDirs.push(analysisTargetParent);
    const analysisTarget = path.join(analysisTargetParent, "03_analysis");
    fs.renameSync(path.join(projectDir, "03_analysis"), analysisTarget);
    fs.symlinkSync(analysisTarget, path.join(projectDir, "03_analysis"), "dir");

    const analysisFrame = path.join(projectDir, "03_analysis/frames/SEG_food/representative.jpg");
    fs.mkdirSync(path.dirname(analysisFrame), { recursive: true });
    fs.writeFileSync(analysisFrame, "analysis frame");

    const mediaTarget = fs.mkdtempSync(path.join(os.tmpdir(), "footage-search-media-target-"));
    tempDirs.push(mediaTarget);
    fs.symlinkSync(mediaTarget, path.join(projectDir, "02_media"), "dir");
    const mediaFrame = path.join(projectDir, "02_media/query-frame.jpg");
    fs.writeFileSync(mediaFrame, "media frame");

    const { searchFootage } = await import("../runtime/tools/footage-search.js");

    const analysisResponse = await searchFootage(projectDir, {
      query: "",
      mode: "visual",
      image_query_path: analysisFrame,
      limit: 1,
    });
    expect(analysisResponse.warnings.some((warning) => warning.includes("must resolve under the project root"))).toBe(false);
    expect(qwenEmbedImageMock).toHaveBeenCalledWith([fs.realpathSync(analysisFrame)], expect.any(Object));

    qwenEmbedImageMock.mockClear();
    const mediaResponse = await searchFootage(projectDir, {
      query: "",
      mode: "visual",
      image_query_path: mediaFrame,
      limit: 1,
    });
    expect(mediaResponse.warnings.some((warning) => warning.includes("must resolve under the project root"))).toBe(false);
    expect(qwenEmbedImageMock).toHaveBeenCalledWith([fs.realpathSync(mediaFrame)], expect.any(Object));
  });

  it("returns an empty visual result with a warning when no visual or text query is valid", async () => {
    const projectDir = makeProject();
    const { searchFootage } = await import("../runtime/tools/footage-search.js");

    const response = await searchFootage(projectDir, { query: "", mode: "visual" });

    expect(response.results).toEqual([]);
    expect(response.warnings.some((warning) => warning.includes("visual mode requires image_query_path or visual_anchor"))).toBe(true);
  });

  it("uses mixed-query fusion weights for multimodal text plus image searches", async () => {
    const projectDir = makeProject();
    await buildDb(projectDir, "require");
    insertQwenRows(projectDir);
    const imagePath = writeQueryImage(projectDir, "food-query.jpg");
    const { searchFootage } = await import("../runtime/tools/footage-search.js");

    const response = await searchFootage(projectDir, {
      query: "warm chestnut",
      semantic: "warm chestnut",
      mode: "multimodal",
      image_query_path: imagePath,
      limit: 2,
    });

    const top = response.results[0];
    expect(qwenEmbedTextMock).toHaveBeenCalledTimes(1);
    expect(qwenEmbedImageMock).toHaveBeenCalledTimes(1);
    expect(top.segment_id).toBe("SEG_food");
    expect(top.scores.weights).toEqual({
      qwen_visual: 0.55,
      e5_text: 0.15,
      lexical: 0.15,
      quality: 0.10,
      peak: 0.05,
    });
  });

  it("redistributes unavailable E5 weight when Qwen rows exist but E5 rows do not", async () => {
    const projectDir = makeProject();
    await buildDb(projectDir, "skip");
    insertQwenRows(projectDir);
    const { searchFootage } = await import("../runtime/tools/footage-search.js");

    const response = await searchFootage(projectDir, {
      query: "warm chestnut",
      semantic: "warm chestnut",
      mode: "hybrid",
      limit: 2,
    });

    const weights = response.results[0].scores.weights;
    expect(weights?.qwen_visual).toBeCloseTo(0.495833, 6);
    expect(weights?.qwen_text).toBeCloseTo(0.141667, 6);
    expect(weights?.lexical).toBeCloseTo(0.2125, 6);
    expect(weights?.quality).toBe(0.10);
    expect(weights?.peak).toBe(0.05);
    expect(response.results[0].scores.unavailable_channels).toContain("e5_text");
  });

  it("keeps text_combined_qwen in qwen_text instead of qwen_visual", async () => {
    const projectDir = makeProject();
    await buildDb(projectDir, "require");
    insertQwenTextOnlyRows(projectDir);
    const { searchFootage } = await import("../runtime/tools/footage-search.js");

    const response = await searchFootage(projectDir, {
      query: "warm chestnut",
      semantic: "warm chestnut",
      mode: "hybrid",
      limit: 2,
    });

    const top = response.results[0];
    expect(top.segment_id).toBe("SEG_food");
    expect(top.scores.qwen_text).toBe(1);
    expect(top.scores.qwen_visual).toBeUndefined();
    expect(top.scores.embedding_matches?.map((match) => match.embedding_type)).toEqual(["text_combined_qwen"]);
    expect(top.scores.weights?.qwen_visual).toBeUndefined();
    expect(top.scores.unavailable_channels).toContain("qwen_visual");
  });

  it("uses exact legacy weights when Qwen query embedding fails despite stored Qwen rows", async () => {
    const projectDir = makeProject();
    await buildDb(projectDir, "require");
    insertQwenRows(projectDir);
    qwenEmbedTextMock.mockRejectedValueOnce(new Error("worker down"));
    const { searchFootage } = await import("../runtime/tools/footage-search.js");

    const response = await searchFootage(projectDir, {
      query: "warm chestnut",
      semantic: "warm chestnut",
      mode: "hybrid",
      limit: 2,
    });

    expect(response.results[0].scores.weights).toEqual({
      semantic: 0.55,
      lexical: 0.30,
      quality: 0.10,
      peak: 0.05,
    });
    expect(response.results[0].scores.qwen_visual).toBeUndefined();
    expect(response.results[0].scores.qwen_text).toBeUndefined();
    expect(response.warnings.some((warning) => warning.includes("qwen3vl search embedding unavailable"))).toBe(true);
  });

  it("rejects image_query_path values that are not project-local image files", async () => {
    const projectDir = makeProject();
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "footage-search-outside-"));
    tempDirs.push(outsideDir);
    const outsidePath = path.join(outsideDir, "outside.jpg");
    fs.writeFileSync(outsidePath, "outside");
    const symlinkPath = path.join(projectDir, "escape.jpg");
    fs.symlinkSync(outsidePath, symlinkPath);
    const directoryPath = path.join(projectDir, "directory.jpg");
    fs.mkdirSync(directoryPath);
    const wrongExtensionPath = path.join(projectDir, "query.gif");
    fs.writeFileSync(wrongExtensionPath, "gif");
    const missingPath = path.join(projectDir, "missing.jpg");
    const { searchFootage } = await import("../runtime/tools/footage-search.js");

    const cases = [
      { imagePath: outsidePath, warning: "must resolve under the project root" },
      { imagePath: symlinkPath, warning: "must resolve under the project root" },
      { imagePath: directoryPath, warning: "is not a regular file" },
      { imagePath: missingPath, warning: "does not exist" },
      { imagePath: wrongExtensionPath, warning: "must be a .jpg, .jpeg, .png, or .webp file" },
    ];

    for (const testCase of cases) {
      const response = await searchFootage(projectDir, {
        query: "",
        mode: "visual",
        image_query_path: testCase.imagePath,
      });
      expect(response.results, testCase.imagePath).toEqual([]);
      expect(response.warnings.some((warning) => warning.includes(testCase.warning)), testCase.imagePath).toBe(true);
    }
    expect(qwenEmbedImageMock).not.toHaveBeenCalled();
  });

  it("continues without visual search for multimodal invalid image_query_path when text is present", async () => {
    const projectDir = makeProject();
    await buildDb(projectDir, "require");
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "footage-search-outside-"));
    tempDirs.push(outsideDir);
    const outsidePath = path.join(outsideDir, "outside.jpg");
    fs.writeFileSync(outsidePath, "outside");
    const { searchFootage } = await import("../runtime/tools/footage-search.js");

    const response = await searchFootage(projectDir, {
      query: "warm chestnut",
      semantic: "warm chestnut",
      mode: "multimodal",
      image_query_path: outsidePath,
      limit: 2,
    });

    expect(response.results.map((result) => result.segment_id)).toEqual(["SEG_food", "SEG_river"]);
    expect(response.warnings.some((warning) => warning.includes("must resolve under the project root"))).toBe(true);
    expect(qwenEmbedImageMock).not.toHaveBeenCalled();
  });

  it("falls back to legacy embeddings when segment_embeddings is absent", async () => {
    const projectDir = makeProject();
    await buildDb(projectDir, "require");
    const { footageDbPath } = await import("../runtime/artifacts/footage-db.js");
    const db = new Database(footageDbPath(projectDir));
    try {
      db.exec(`
        DROP TABLE segment_embeddings;
        DROP TABLE embedding_models;
      `);
    } finally {
      db.close();
    }
    const { searchFootage } = await import("../runtime/tools/footage-search.js");

    const response = await searchFootage(projectDir, {
      query: "warm chestnut",
      semantic: "warm chestnut",
      mode: "semantic",
      limit: 2,
    });

    expect(qwenCreateMock).not.toHaveBeenCalled();
    expect(response.results.map((result) => result.segment_id)).toEqual(["SEG_food", "SEG_river"]);
    expect(response.results[0].scores.semantic).toBeGreaterThan(response.results[1].scores.semantic ?? 0);
    expect(response.warnings.some((warning) => warning.includes("semantic embeddings unavailable"))).toBe(false);
  });
});

async function buildDb(projectDir: string, embeddingPolicy: "require" | "skip"): Promise<void> {
  const { buildFootageDb } = await import("../runtime/artifacts/footage-db-builder.js");
  await buildFootageDb({
    projectDir,
    embeddingPolicy,
    qwen3vlEnabled: false,
    skipAudioAnalysis: true,
    now: new Date("2026-06-19T00:00:00.000Z"),
  });
}

function insertQwenRows(projectDir: string): void {
  const dbPath = path.join(projectDir, "03_analysis/search/footage.db");
  const db = new Database(dbPath);
  try {
    const modelId = upsertQwenModel(db);
    const insert = db.prepare(`
      INSERT INTO segment_embeddings (
        segment_id, embedding_type, model_id, source_ref, source_timestamp_us,
        content_hash, dimension, vector, created_at
      ) VALUES (
        @segment_id, @embedding_type, @model_id, @source_ref, @source_timestamp_us,
        @content_hash, @dimension, @vector, @created_at
      )
    `);
    for (const row of [
      { segment_id: "SEG_food", embedding_type: "visual_representative", axis: 0, source_ref: "03_analysis/frames/SEG_food/representative.jpg", source_timestamp_us: 2_000_000 },
      { segment_id: "SEG_food", embedding_type: "text_combined_qwen", axis: 0, source_ref: "embedding_texts:combined", source_timestamp_us: null },
      { segment_id: "SEG_river", embedding_type: "visual_representative", axis: 1, source_ref: "03_analysis/frames/SEG_river/representative.jpg", source_timestamp_us: 3_000_000 },
      { segment_id: "SEG_river", embedding_type: "text_combined_qwen", axis: 1, source_ref: "embedding_texts:combined", source_timestamp_us: null },
    ]) {
      insert.run({
        segment_id: row.segment_id,
        embedding_type: row.embedding_type,
        model_id: modelId,
        source_ref: row.source_ref,
        source_timestamp_us: row.source_timestamp_us,
        content_hash: `${row.segment_id}:${row.embedding_type}`,
        dimension: QWEN_DIMENSION,
        vector: unitVectorBlob(QWEN_DIMENSION, row.axis),
        created_at: "2026-06-19T00:00:00.000Z",
      });
    }
  } finally {
    db.close();
  }
}

function insertQwenTextOnlyRows(projectDir: string): void {
  const dbPath = path.join(projectDir, "03_analysis/search/footage.db");
  const db = new Database(dbPath);
  try {
    const modelId = upsertQwenModel(db);
    const insert = db.prepare(`
      INSERT INTO segment_embeddings (
        segment_id, embedding_type, model_id, source_ref, source_timestamp_us,
        content_hash, dimension, vector, created_at
      ) VALUES (
        @segment_id, @embedding_type, @model_id, @source_ref, @source_timestamp_us,
        @content_hash, @dimension, @vector, @created_at
      )
    `);
    for (const row of [
      { segment_id: "SEG_food", axis: 0 },
      { segment_id: "SEG_river", axis: 1 },
    ]) {
      insert.run({
        segment_id: row.segment_id,
        embedding_type: "text_combined_qwen",
        model_id: modelId,
        source_ref: "embedding_texts:combined",
        source_timestamp_us: null,
        content_hash: `${row.segment_id}:text_combined_qwen`,
        dimension: QWEN_DIMENSION,
        vector: unitVectorBlob(QWEN_DIMENSION, row.axis),
        created_at: "2026-06-19T00:00:00.000Z",
      });
    }
  } finally {
    db.close();
  }
}

function upsertQwenModel(db: Database.Database): number {
  const params = {
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
    created_at: "2026-06-19T00:00:00.000Z",
  };
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
  if (!row) throw new Error("failed to insert Qwen model row");
  return row.id;
}

function makeProject(): string {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "footage-search-qwen-"));
  tempDirs.push(projectDir);
  fs.mkdirSync(path.join(projectDir, "03_analysis/transcripts"), { recursive: true });
  fs.mkdirSync(path.join(projectDir, "03_analysis/search"), { recursive: true });

  writeJson(projectDir, "03_analysis/assets.json", {
    project_id: "footage-search-qwen-fixture",
    artifact_version: "assets-v1",
    items: [
      {
        asset_id: "AST_food",
        filename: "food.mov",
        duration_us: 8_000_000,
        has_transcript: true,
        transcript_ref: "TR_AST_food",
        tags: ["food", "chestnut"],
        quality_flags: [],
        source_locator: "02_media/food.mov",
        source_fingerprint: "sha256:food",
      },
      {
        asset_id: "AST_river",
        filename: "river.mov",
        duration_us: 12_000_000,
        has_transcript: false,
        tags: ["river", "water"],
        quality_flags: [],
        source_locator: "02_media/river.mov",
        source_fingerprint: "sha256:river",
      },
    ],
  });

  writeJson(projectDir, "03_analysis/segments.json", {
    project_id: "footage-search-qwen-fixture",
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
        quality_flags: [],
        filmstrip_path: "filmstrips/SEG_food.png",
        visual_quality: {
          scores: {
            light_quality: 0.9,
            subject_prominence: 0.85,
            emotional_expression: 0.5,
            composition_score: 0.92,
            motion_quality: 0.8,
          },
        },
        visual_appraisal: {
          frame_us: 2_000_000,
          frame_path: "frames/SEG_food.jpg",
          aesthetic_notes: ["warm closeup with clear hands"],
        },
        peak_analysis: {
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
        quality_flags: [],
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
    project_id: "footage-search-qwen-fixture",
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

function writeQueryImage(projectDir: string, filename: string): string {
  const imagePath = path.join(projectDir, filename);
  fs.writeFileSync(imagePath, `mock image ${filename}`);
  return imagePath;
}

function writeJson(projectDir: string, relPath: string, value: unknown): void {
  const filePath = path.join(projectDir, relPath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}

function qwenVectorForText(text: string, dimension: number): Float32Array {
  return /chestnut|warm|sweet|food/i.test(text) ? unitVector(dimension, 0) : unitVector(dimension, 1);
}

function qwenVectorForImage(imagePath: string, dimension: number): Float32Array {
  return imagePath.includes("food") ? unitVector(dimension, 0) : unitVector(dimension, 1);
}

function unitVector(dimension: number, axis: number): Float32Array {
  const vector = new Float32Array(dimension);
  vector[axis % dimension] = 1;
  return vector;
}

function unitVectorBlob(dimension: number, axis: number): Buffer {
  const vector = unitVector(dimension, axis);
  return Buffer.from(vector.buffer);
}

function qwenModel(outputDimension: number): Record<string, unknown> {
  return {
    name: "Qwen/Qwen3-VL-Embedding-2B",
    modelRevision: "mock",
    outputDimension,
    instruction: "Retrieve relevant video footage for editing.",
    preprocessVersion: "qwen3vl-frame-v1",
    runnerName: "typescript-qwen3vl-mock",
    runnerVersion: "qwen3vl-worker-v1",
    precision: "mock",
    device: "mock",
    distanceMetric: "cosine",
  };
}
