import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  ClapAudioEmbeddingLocalClient,
  ClapAudioWorkerError,
} from "../runtime/connectors/clap-audio-local.js";

function vectorNorm(vector: Float32Array): number {
  let sum = 0;
  for (const value of vector) {
    sum += value * value;
  }
  return Math.sqrt(sum);
}

function writeWorkerScript(source: string): { dir: string; file: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clap-worker-test-"));
  const file = path.join(dir, "worker.mjs");
  fs.writeFileSync(file, source);
  return { dir, file };
}

function runPythonWorkerRequest(request: Record<string, unknown>): Promise<Record<string, any>> {
  const pythonBinary = process.env.VOS_CLAP_PYTHON ?? "python3";
  const workerPath = path.resolve("python/clap_audio_worker.py");
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
        reject(new Error(`clap worker exited with ${code}: ${stderr}`));
        return;
      }
      const [line] = stdout.trim().split(/\r?\n/u).filter(Boolean);
      if (!line) {
        reject(new Error(`clap worker produced no response: ${stderr}`));
        return;
      }
      resolve(JSON.parse(line) as Record<string, any>);
    });
  });
}

function normalizedVectorPayload(dimension = 512): string {
  const buffer = Buffer.alloc(dimension * 4);
  const value = 1 / Math.sqrt(dimension);
  for (let index = 0; index < dimension; index += 1) {
    buffer.writeFloatLE(value, index * 4);
  }
  return buffer.toString("base64");
}

const WORKER_TEST_REQUEST_TIMEOUT_MS = 5_000;

describe("CLAP audio embedding connector", () => {
  let previousMock: string | undefined;
  const tempDirs: string[] = [];

  beforeEach(() => {
    previousMock = process.env.VOS_CLAP_MOCK;
    process.env.VOS_CLAP_MOCK = "1";
  });

  afterEach(() => {
    if (previousMock === undefined) {
      delete process.env.VOS_CLAP_MOCK;
    } else {
      process.env.VOS_CLAP_MOCK = previousMock;
    }
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("embedText returns a 512-dim normalized vector in mock mode", async () => {
    const client = new ClapAudioEmbeddingLocalClient();

    const result = await client.embedText(["quiet ambient sound"], {
      outputDimension: 512,
      normalize: true,
    });

    expect(result.vectors).toHaveLength(1);
    expect(result.vectors[0].vector).toBeInstanceOf(Float32Array);
    expect(result.vectors[0].dimension).toBe(512);
    expect(vectorNorm(result.vectors[0].vector)).toBeCloseTo(1, 6);
    expect(result.model.name).toBe("laion/clap-htsat-fused");
    expect(result.model.device).toBe("mock");
  });

  it("embedAudio returns a 512-dim normalized vector in mock mode", async () => {
    const client = new ClapAudioEmbeddingLocalClient();

    const result = await client.embedAudio(["/tmp/clap-fixture.wav"], {
      outputDimension: 512,
      normalize: true,
    });

    expect(result.vectors).toHaveLength(1);
    expect(result.vectors[0].dimension).toBe(512);
    expect(vectorNorm(result.vectors[0].vector)).toBeCloseTo(1, 6);
  });

  it("embedBatch returns the correct number of vectors in mock mode", async () => {
    const client = new ClapAudioEmbeddingLocalClient();

    const result = await client.embedBatch(
      [
        { ref: "txt", kind: "text", text: "quiet ambient sound" },
        { ref: "aud1", kind: "audio", audioPath: "/tmp/room-tone.wav" },
        { ref: "aud2", kind: "audio", audioPath: "/tmp/market.wav" },
      ],
      { outputDimension: 512, normalize: true }
    );

    expect(result.vectors.map((vector) => vector.ref)).toEqual(["txt", "aud1", "aud2"]);
    expect(result.vectors).toHaveLength(3);
    for (const vector of result.vectors) {
      expect(vector.dimension).toBe(512);
      expect(vectorNorm(vector.vector)).toBeCloseTo(1, 6);
    }
  });

  it("Python worker rejects unsupported audio extensions with invalid_input", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clap-worker-ext-"));
    tempDirs.push(dir);
    const audioPath = path.join(dir, "fixture.txt");
    fs.writeFileSync(audioPath, "not audio");

    const response = await runPythonWorkerRequest({
      id: 1,
      method: "embed_audio",
      params: {
        audio_paths: [audioPath],
        output_dimension: 512,
        normalize: true,
      },
    });

    expect(response.ok).toBe(false);
    expect(response.error).toMatchObject({
      code: "invalid_input",
      retryable: false,
    });
    expect(response.error.message).toContain(".wav, .mp3, .flac");
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
    const missingClient = new ClapAudioEmbeddingLocalClient({
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
    const timeoutClient = new ClapAudioEmbeddingLocalClient({
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
            vectors: [{ ref: "0", vector, vector_encoding: "float32-le-base64", dimension: 512, normalized: true }],
            model: {
              name: "laion/clap-htsat-fused",
              model_revision: "test",
              output_dimension: 512,
              precision: "mock",
              device: "mock"
            },
            elapsed_ms: 1
          }
        }));
      });
    `);
    tempDirs.push(workerScript.dir);

    const client = new ClapAudioEmbeddingLocalClient({
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

  it("worker errors use ClapAudioWorkerError", async () => {
    const error = new ClapAudioWorkerError("timeout", "request timed out", true);
    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe("timeout");
    expect(error.retryable).toBe(true);
  });
});
