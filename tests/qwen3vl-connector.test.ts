import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  Qwen3VlEmbeddingLocalClient,
  Qwen3VlWorkerError,
} from "../runtime/connectors/qwen3vl-embedding-local.js";

function vectorNorm(vector: Float32Array): number {
  let sum = 0;
  for (const value of vector) {
    sum += value * value;
  }
  return Math.sqrt(sum);
}

function writeWorkerScript(source: string): { dir: string; file: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qwen3vl-worker-test-"));
  const file = path.join(dir, "worker.mjs");
  fs.writeFileSync(file, source);
  return { dir, file };
}

function runPythonWorkerRequest(request: Record<string, unknown>): Promise<Record<string, any>> {
  const pythonBinary = process.env.VOS_QWEN3VL_PYTHON ?? "python3";
  const workerPath = path.resolve("python/qwen3vl_embedding_worker.py");
  const child = spawn(pythonBinary, [workerPath, "--mock"], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString("utf-8");
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf-8");
  });
  child.stdin.write(`${JSON.stringify(request)}\n`);
  child.stdin.write(`${JSON.stringify({ id: 2, method: "shutdown", params: {} })}\n`);
  child.stdin.end();

  return new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`qwen3vl worker exited with ${code}: ${stderr}`));
        return;
      }
      const [line] = stdout.trim().split(/\r?\n/u).filter(Boolean);
      if (!line) {
        reject(new Error(`qwen3vl worker produced no response: ${stderr}`));
        return;
      }
      resolve(JSON.parse(line) as Record<string, any>);
    });
  });
}

function normalizedVectorPayload(dimension = 2048): string {
  const buffer = Buffer.alloc(dimension * 4);
  const value = 1 / Math.sqrt(dimension);
  for (let index = 0; index < dimension; index += 1) {
    buffer.writeFloatLE(value, index * 4);
  }
  return buffer.toString("base64");
}

const WORKER_TEST_REQUEST_TIMEOUT_MS = 5_000;

describe("Qwen3-VL embedding connector", () => {
  let previousMock: string | undefined;
  const tempDirs: string[] = [];

  beforeEach(() => {
    previousMock = process.env.VOS_QWEN3VL_MOCK;
    process.env.VOS_QWEN3VL_MOCK = "1";
  });

  afterEach(() => {
    if (previousMock === undefined) {
      delete process.env.VOS_QWEN3VL_MOCK;
    } else {
      process.env.VOS_QWEN3VL_MOCK = previousMock;
    }
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("embedText returns a 2048-dim normalized vector in mock mode", async () => {
    const client = new Qwen3VlEmbeddingLocalClient();

    const result = await client.embedText(["温かみのある光のシーン"], {
      instruction: "Retrieve relevant video footage.",
      outputDimension: 2048,
      normalize: true,
    });

    expect(result.vectors).toHaveLength(1);
    expect(result.vectors[0].vector).toBeInstanceOf(Float32Array);
    expect(result.vectors[0].dimension).toBe(2048);
    expect(vectorNorm(result.vectors[0].vector)).toBeCloseTo(1, 6);
    expect(result.model.name).toBe("Qwen/Qwen3-VL-Embedding-2B");
    expect(result.model.device).toBe("mock");
  });

  it("embedImage returns a 2048-dim normalized vector in mock mode", async () => {
    const client = new Qwen3VlEmbeddingLocalClient();

    const result = await client.embedImage(["/tmp/qwen3vl-frame.png"], {
      outputDimension: 2048,
      normalize: true,
    });

    expect(result.vectors).toHaveLength(1);
    expect(result.vectors[0].dimension).toBe(2048);
    expect(vectorNorm(result.vectors[0].vector)).toBeCloseTo(1, 6);
  });

  it("embedBatch returns the correct number of vectors in mock mode", async () => {
    const client = new Qwen3VlEmbeddingLocalClient();

    const result = await client.embedBatch(
      [
        { ref: "txt", kind: "text", text: "warm light" },
        { ref: "img", kind: "image", imagePath: "/tmp/qwen3vl-frame.png" },
        { ref: "mix", kind: "mixed", text: "wood and morning light", imagePath: "/tmp/qwen3vl-frame.png" },
      ],
      { outputDimension: 2048, normalize: true }
    );

    expect(result.vectors.map((vector) => vector.ref)).toEqual(["txt", "img", "mix"]);
    expect(result.vectors).toHaveLength(3);
    for (const vector of result.vectors) {
      expect(vector.dimension).toBe(2048);
      expect(vectorNorm(vector.vector)).toBeCloseTo(1, 6);
    }
  });

  it("Python worker rejects unsupported image extensions with invalid_input", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qwen3vl-worker-ext-"));
    tempDirs.push(dir);
    const imagePath = path.join(dir, "frame.gif");
    fs.writeFileSync(imagePath, "gif");

    const response = await runPythonWorkerRequest({
      id: 1,
      method: "embed_image",
      params: {
        image_paths: [imagePath],
        output_dimension: 2048,
        normalize: true,
      },
    });

    expect(response.ok).toBe(false);
    expect(response.error).toMatchObject({
      code: "invalid_input",
      retryable: false,
    });
    expect(response.error.message).toContain(".jpg, .jpeg, .png, .webp");
  });

  it("surfaces model_not_found and timeout error codes", async () => {
    const missingModelWorker = writeWorkerScript(`
      import readline from "node:readline";
      const rl = readline.createInterface({ input: process.stdin });
      rl.on("line", (line) => {
        const request = JSON.parse(line);
        console.log(JSON.stringify({
          id: request.id,
          ok: false,
          error: { code: "model_not_found", message: "cache missing", retryable: false },
          elapsed_ms: 1
        }));
      });
    `);
    tempDirs.push(missingModelWorker.dir);
    const missingClient = new Qwen3VlEmbeddingLocalClient({
      pythonBinary: process.execPath,
      workerPath: missingModelWorker.file,
      mock: false,
      requestTimeoutMs: WORKER_TEST_REQUEST_TIMEOUT_MS,
    });

    await expect(missingClient.embedText(["query"])).rejects.toMatchObject({
      code: "model_not_found",
      message: "cache missing",
    });
    await missingClient.shutdown();

    const timeoutWorker = writeWorkerScript(`
      process.stdin.resume();
    `);
    tempDirs.push(timeoutWorker.dir);
    const timeoutClient = new Qwen3VlEmbeddingLocalClient({
      pythonBinary: process.execPath,
      workerPath: timeoutWorker.file,
      mock: false,
      requestTimeoutMs: 30,
    });

    await expect(timeoutClient.embedText(["query"])).rejects.toMatchObject({
      code: "timeout",
    });
    await timeoutClient.shutdown();
  });

  it("restarts once after a worker crash", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qwen3vl-restart-test-"));
    tempDirs.push(dir);
    const stateFile = path.join(dir, "crashed");
    const vector = normalizedVectorPayload();
    const worker = path.join(dir, "worker.mjs");
    fs.writeFileSync(
      worker,
      `
      import fs from "node:fs";
      import readline from "node:readline";
      const stateFile = ${JSON.stringify(stateFile)};
      const vector = ${JSON.stringify(vector)};
      if (!fs.existsSync(stateFile)) {
        fs.writeFileSync(stateFile, "1");
        process.exit(17);
      }
      const rl = readline.createInterface({ input: process.stdin });
      rl.on("line", (line) => {
        const request = JSON.parse(line);
        console.log(JSON.stringify({
          id: request.id,
          ok: true,
          result: {
            vectors: [{ ref: "0", vector, vector_encoding: "float32-le-base64", dimension: 2048, normalized: true }],
            model: {
              name: "Qwen/Qwen3-VL-Embedding-2B",
              model_revision: "test",
              output_dimension: 2048,
              precision: "mock",
              device: "mock"
            },
            elapsed_ms: 2
          }
        }));
      });
      `
    );

    const client = new Qwen3VlEmbeddingLocalClient({
      pythonBinary: process.execPath,
      workerPath: worker,
      mock: false,
      requestTimeoutMs: WORKER_TEST_REQUEST_TIMEOUT_MS,
    });

    const result = await client.embedText(["query"]);
    expect(result.vectors).toHaveLength(1);
    expect(result.vectors[0].dimension).toBe(2048);
    expect(vectorNorm(result.vectors[0].vector)).toBeCloseTo(1, 6);
    await client.shutdown();
  });

  it("shutdown cleans up the child process", async () => {
    const vector = normalizedVectorPayload();
    const workerScript = writeWorkerScript(`
      import readline from "node:readline";
      const vector = ${JSON.stringify(vector)};
      const rl = readline.createInterface({ input: process.stdin });
      rl.on("line", (line) => {
        const request = JSON.parse(line);
        if (request.method === "shutdown") {
          console.log(JSON.stringify({ id: request.id, ok: true, result: { shutdown: true, elapsed_ms: 0 } }));
          process.exit(0);
        }
        console.log(JSON.stringify({
          id: request.id,
          ok: true,
          result: {
            vectors: [{ ref: "0", vector, vector_encoding: "float32-le-base64", dimension: 2048, normalized: true }],
            model: {
              name: "Qwen/Qwen3-VL-Embedding-2B",
              model_revision: "test",
              output_dimension: 2048,
              precision: "mock",
              device: "mock"
            },
            elapsed_ms: 1
          }
        }));
      });
    `);
    tempDirs.push(workerScript.dir);

    const client = new Qwen3VlEmbeddingLocalClient({
      pythonBinary: process.execPath,
      workerPath: workerScript.file,
      mock: false,
      requestTimeoutMs: WORKER_TEST_REQUEST_TIMEOUT_MS,
    });

    await client.embedText(["query"]);
    expect(client.processId).toEqual(expect.any(Number));
    await client.shutdown();
    expect(client.processId).toBeNull();
  });

  it("worker errors use Qwen3VlWorkerError", async () => {
    const error = new Qwen3VlWorkerError("timeout", "request timed out", true);
    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe("timeout");
    expect(error.retryable).toBe(true);
  });
});
