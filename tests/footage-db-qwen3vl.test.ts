import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const execFileMock = vi.hoisted(() => vi.fn());
const qwenCreateMock = vi.hoisted(() => vi.fn());
const qwenEmbedBatchMock = vi.hoisted(() => vi.fn());
const qwenShutdownMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({
  execFile: execFileMock,
}));

vi.mock("../runtime/eval/semantic-match.js", () => {
  const TEST_EMBEDDING_DIMENSION = 384;
  function semanticUnitVector(axis: number): Float32Array {
    const vector = new Float32Array(TEST_EMBEDDING_DIMENSION);
    vector[axis % TEST_EMBEDDING_DIMENSION] = 1;
    return vector;
  }
  return {
    SEMANTIC_EMBEDDING_MODEL: "Xenova/multilingual-e5-small",
    SEMANTIC_EMBEDDING_DTYPE: "q8",
    embedTexts: async (texts: string[]) => texts.map((_text, index) => semanticUnitVector(index)),
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
  execFileMock.mockImplementation((_cmd: string, args: string[], _options: unknown, cb: (error: Error | null, stdout: string, stderr: string) => void) => {
    const outputPath = args[args.length - 1];
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, `frame:${args.join("|")}`);
    cb(null, "", "");
    return {} as never;
  });
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
});

afterEach(() => {
  delete process.env.VOS_QWEN3VL_MOCK;
  execFileMock.mockReset();
  qwenCreateMock.mockReset();
  qwenEmbedBatchMock.mockReset();
  qwenShutdownMock.mockReset();
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("footage database Qwen3-VL embeddings", () => {
  it("caches representative frames and stores Qwen visual/text embeddings in segment_embeddings", async () => {
    const projectDir = makeQwenProject();
    const now = new Date("2026-06-19T00:00:00.000Z");
    const { buildFootageDb } = await import("../runtime/artifacts/footage-db-builder.js");
    const { footageDbPath } = await import("../runtime/artifacts/footage-db.js");

    const result = await buildFootageDb({ projectDir, embeddingPolicy: "require", skipAudioAnalysis: true, now });

    expect(qwenCreateMock).toHaveBeenCalledTimes(1);
    expect(qwenEmbedBatchMock).toHaveBeenCalledTimes(2);
    expect(result.embedding_counts).toMatchObject({
      qwen_visual: 2,
      qwen_text: 2,
      qwen_mixed: 0,
      qwen_reranker: 0,
    });
    expect(result.embedding_statuses).toMatchObject({
      qwen_visual: "ready",
      qwen_text: "ready",
      qwen_mixed: "unsupported",
      qwen_reranker: "deferred",
    });
    expect(result.counts.embeddings).toBe((result.embedding_counts?.e5_text ?? 0) + 4);

    const framePath = path.join(projectDir, "03_analysis/frames/SEG_food/representative.jpg");
    expect(fs.existsSync(framePath)).toBe(true);
    const manifest = JSON.parse(fs.readFileSync(path.join(projectDir, "03_analysis/frames/SEG_food/manifest.json"), "utf-8")) as Record<string, unknown>;
    expect(manifest).toMatchObject({
      segment_id: "SEG_food",
      frame_type: "visual_representative",
      source_timestamp_us: 2_000_000,
      output_path: "03_analysis/frames/SEG_food/representative.jpg",
      preprocess_version: "qwen3vl-frame-v1",
      created_at: now.toISOString(),
    });
    expect(typeof manifest.frame_content_hash).toBe("string");

    const db = new Database(footageDbPath(projectDir), { readonly: true, fileMustExist: true });
    try {
      expect(db.prepare(`
        SELECT name, input_modality, output_dimension, runner_name, precision, normalized, distance_metric
        FROM embedding_models
        WHERE name = 'Qwen/Qwen3-VL-Embedding-2B'
      `).get()).toMatchObject({
        name: "Qwen/Qwen3-VL-Embedding-2B",
        input_modality: "multimodal",
        output_dimension: 2048,
        runner_name: "python-qwen3vl-worker",
        precision: "fp16",
        normalized: 1,
        distance_metric: "cosine",
      });
      expect(db.prepare("SELECT COUNT(*) FROM segment_embeddings WHERE embedding_type = 'visual_representative'").pluck().get()).toBe(2);
      expect(db.prepare("SELECT COUNT(*) FROM segment_embeddings WHERE embedding_type = 'text_combined_qwen'").pluck().get()).toBe(2);
      expect(db.prepare(`
        SELECT source_ref, source_timestamp_us, dimension, length(vector) AS byte_length, created_at
        FROM segment_embeddings
        WHERE segment_id = 'SEG_food' AND embedding_type = 'visual_representative'
      `).get()).toMatchObject({
        source_ref: "03_analysis/frames/SEG_food/representative.jpg",
        source_timestamp_us: 2_000_000,
        dimension: 2048,
        byte_length: 2048 * 4,
        created_at: now.toISOString(),
      });
      expect(db.prepare(`
        SELECT source_ref, source_timestamp_us, dimension, length(vector) AS byte_length, created_at
        FROM segment_embeddings
        WHERE segment_id = 'SEG_food' AND embedding_type = 'text_combined_qwen'
      `).get()).toMatchObject({
        source_ref: "embedding_texts:combined",
        source_timestamp_us: null,
        dimension: 2048,
        byte_length: 2048 * 4,
        created_at: now.toISOString(),
      });
    } finally {
      db.close();
    }
  });

  it("embeds sanitized realistic combined text for Qwen text rows in mock mode", async () => {
    const projectDir = makeQwenProject();
    writeJson(projectDir, "03_analysis/marlin_events.json", {
      project_id: "qwen-fixture",
      artifact_version: "marlin-events-v1",
      items: [{
        asset_id: "AST_food",
        source_path: "02_media/food.mov",
        scene: "warm kitchen prep with close hand movement",
        caption: "summary, tags, and Marlin events should stay useful after Qwen text preprocessing",
        events: [{
          event_id: "MEV_food_001",
          start_us: 0,
          end_us: 4_000_000,
          description: `hands turn roasted chestnuts with steam and warm light \u0000 ${"repeated marlin motion phrase ".repeat(220)}`,
        }],
      }],
    });
    const { buildFootageDb } = await import("../runtime/artifacts/footage-db-builder.js");

    const result = await buildFootageDb({
      projectDir,
      embeddingPolicy: "require",
      skipAudioAnalysis: true,
      now: new Date("2026-06-19T00:00:00.000Z"),
    });

    const textCall = qwenEmbedBatchMock.mock.calls.find(([items]) =>
      Array.isArray(items) && items.some((item) => item && typeof item === "object" && (item as { kind?: string }).kind === "text")
    ) as [Array<{ ref?: string; kind: string; text?: string }>, { outputDimension?: number }] | undefined;
    if (!textCall) throw new Error("expected Qwen text embedBatch call");
    const foodText = textCall[0].find((item) => item.ref === "SEG_food:text_combined_qwen")?.text;

    expect(result.embedding_counts).toMatchObject({ qwen_text: 2 });
    expect(foodText).toContain("warm chestnut close-up");
    expect(foodText).toContain("hands turn roasted chestnuts");
    expect(foodText).not.toMatch(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/);
    expect(foodText?.length).toBeLessThanOrEqual(4_096);
  });

  it("reuses unchanged frame/text content hashes without re-embedding", async () => {
    const projectDir = makeQwenProject();
    const { buildFootageDb } = await import("../runtime/artifacts/footage-db-builder.js");

    await buildFootageDb({ projectDir, embeddingPolicy: "require", skipAudioAnalysis: true, now: new Date("2026-06-19T00:00:00.000Z") });
    expect(qwenEmbedBatchMock).toHaveBeenCalledTimes(2);

    execFileMock.mockClear();
    qwenCreateMock.mockClear();
    qwenEmbedBatchMock.mockReset();
    qwenEmbedBatchMock.mockRejectedValue(new Error("should not re-embed unchanged rows"));

    const result = await buildFootageDb({ projectDir, embeddingPolicy: "require", skipAudioAnalysis: true, now: new Date("2026-06-19T00:01:00.000Z") });

    expect(execFileMock).not.toHaveBeenCalled();
    expect(qwenCreateMock).not.toHaveBeenCalled();
    expect(qwenEmbedBatchMock).not.toHaveBeenCalled();
    expect(result.embedding_counts).toMatchObject({ qwen_visual: 2, qwen_text: 2 });
    expect(result.embedding_statuses).toMatchObject({ qwen_visual: "ready", qwen_text: "ready" });
  });

  it("degrades gracefully when the Qwen worker is unavailable", async () => {
    const projectDir = makeQwenProject();
    qwenEmbedBatchMock.mockRejectedValueOnce(Object.assign(new Error("model weights missing"), { code: "model_not_found" }));
    const { buildFootageDb } = await import("../runtime/artifacts/footage-db-builder.js");
    const { footageDbPath } = await import("../runtime/artifacts/footage-db.js");

    const result = await buildFootageDb({ projectDir, embeddingPolicy: "require", skipAudioAnalysis: true });

    expect(result.embedding_status).toBe("ready");
    expect(result.embedding_counts).toMatchObject({ qwen_visual: 0, qwen_text: 0 });
    expect(result.embedding_statuses).toMatchObject({ qwen_visual: "unavailable", qwen_text: "unavailable" });
    expect(result.warnings.some((warning) => warning.includes("qwen3vl embedding unavailable"))).toBe(true);

    const db = new Database(footageDbPath(projectDir), { readonly: true, fileMustExist: true });
    try {
      expect(db.prepare("SELECT COUNT(*) FROM embedding_models WHERE name = 'Qwen/Qwen3-VL-Embedding-2B'").pluck().get()).toBe(1);
      expect(db.prepare("SELECT COUNT(*) FROM segment_embeddings WHERE embedding_type IN ('visual_representative', 'text_combined_qwen')").pluck().get()).toBe(0);
    } finally {
      db.close();
    }
  });

  it("constructs the representative-frame ffmpeg extraction command", async () => {
    const projectDir = makeQwenProject();
    const { buildFootageDb } = await import("../runtime/artifacts/footage-db-builder.js");

    await buildFootageDb({
      projectDir,
      embeddingPolicy: "require",
      skipAudioAnalysis: true,
      qwen3vlEmbedTypes: ["visual_representative"],
    });

    const [command, args] = execFileMock.mock.calls[0] as [string, string[]];
    expect(command).toBe("ffmpeg");
    expect(args).toEqual([
      "-ss",
      "2",
      "-i",
      path.join(projectDir, "02_media/food.mov"),
      "-vframes",
      "1",
      "-q:v",
      "2",
      "-vf",
      "scale=384:-2",
      path.join(projectDir, "03_analysis/frames/SEG_food/representative.jpg"),
    ]);
  });
});

function makeQwenProject(): string {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "footage-db-qwen-"));
  tempDirs.push(projectDir);
  fs.mkdirSync(path.join(projectDir, "02_media"), { recursive: true });
  fs.mkdirSync(path.join(projectDir, "03_analysis/search"), { recursive: true });
  fs.writeFileSync(path.join(projectDir, "02_media/food.mov"), "food media");
  fs.writeFileSync(path.join(projectDir, "02_media/river.mov"), "river media");

  writeJson(projectDir, "03_analysis/assets.json", {
    project_id: "qwen-fixture",
    artifact_version: "assets-v1",
    items: [
      {
        asset_id: "AST_food",
        filename: "food.mov",
        duration_us: 8_000_000,
        source_locator: "02_media/food.mov",
        source_fingerprint: "sha256:food",
        tags: ["food", "chestnut"],
      },
      {
        asset_id: "AST_river",
        filename: "river.mov",
        duration_us: 8_000_000,
        source_locator: "02_media/river.mov",
        source_fingerprint: "sha256:river",
        tags: ["river", "water"],
      },
    ],
  });

  writeJson(projectDir, "03_analysis/segments.json", {
    project_id: "qwen-fixture",
    artifact_version: "segments-v1",
    items: [
      {
        segment_id: "SEG_food",
        asset_id: "AST_food",
        src_in_us: 0,
        src_out_us: 4_000_000,
        rep_frame_us: 1_500_000,
        segment_type: "action",
        summary: "warm chestnut close-up",
        transcript_excerpt: "Fresh chestnut is sweet.",
        tags: ["chestnut", "warm"],
        visual_appraisal: {
          frame_us: 2_000_000,
          frame_path: "frames/missing-food.jpg",
          extracted_text: [{ text: "栗", confidence: 0.9 }],
          aesthetic_notes: ["warm closeup"],
        },
      },
      {
        segment_id: "SEG_river",
        asset_id: "AST_river",
        src_in_us: 0,
        src_out_us: 6_000_000,
        rep_frame_us: 3_000_000,
        segment_type: "static",
        summary: "quiet river and mountain water",
        transcript_excerpt: "",
        tags: ["river", "water"],
      },
    ],
  });

  return projectDir;
}

function writeJson(projectDir: string, relPath: string, value: unknown): void {
  const filePath = path.join(projectDir, relPath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}

function unitVector(dimension: number, axis: number): Float32Array {
  const vector = new Float32Array(dimension);
  vector[axis % dimension] = 1;
  return vector;
}
