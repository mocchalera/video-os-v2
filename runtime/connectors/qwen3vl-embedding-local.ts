import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";

const DEFAULT_MODEL = "Qwen/Qwen3-VL-Embedding-2B";
const DEFAULT_DIMENSION = 2048;
const DEFAULT_SINGLE_TIMEOUT_MS = 30_000;
const DEFAULT_BATCH_TIMEOUT_MS = 120_000;
const VECTOR_ENCODING = "float32-le-base64";

export type Qwen3VlEmbeddingErrorCode =
  | "model_not_found"
  | "mps_unavailable"
  | "oom"
  | "invalid_input"
  | "timeout"
  | "dependency_missing"
  | "worker_crash";

export interface Qwen3VlEmbedOptions {
  instruction?: string;
  outputDimension?: number;
  normalize?: boolean;
  preprocessVersion?: string;
  timeoutMs?: number;
}

export interface Qwen3VlMixedInput {
  ref?: string;
  text: string;
  imagePath: string;
}

export type Qwen3VlBatchItem =
  | {
      ref?: string;
      kind: "text";
      text: string;
    }
  | {
      ref?: string;
      kind: "image";
      imagePath: string;
    }
  | {
      ref?: string;
      kind: "mixed";
      text: string;
      imagePath: string;
    };

export interface Qwen3VlVectorResult {
  ref: string;
  vector: Float32Array;
  dimension: number;
  normalized: boolean;
}

export interface Qwen3VlModelInfo {
  name: string;
  modelRevision: string;
  outputDimension: number;
  instruction?: string;
  preprocessVersion?: string;
  runnerName?: string;
  runnerVersion?: string;
  precision: string;
  device: string;
  distanceMetric?: string;
}

export interface Qwen3VlEmbeddingMetrics {
  peakRssMb?: number;
  firstEmbedPeakRssMb?: number;
  rssMb?: number;
}

export interface Qwen3VlEmbeddingResult {
  vectors: Qwen3VlVectorResult[];
  model: Qwen3VlModelInfo;
  elapsedMs: number;
  metrics?: Qwen3VlEmbeddingMetrics;
}

export interface Qwen3VlEmbeddingClient {
  embedText(texts: string[], options?: Qwen3VlEmbedOptions): Promise<Qwen3VlEmbeddingResult>;
  embedImage(imagePaths: string[], options?: Qwen3VlEmbedOptions): Promise<Qwen3VlEmbeddingResult>;
  embedMixed(items: Qwen3VlMixedInput[], options?: Qwen3VlEmbedOptions): Promise<Qwen3VlEmbeddingResult>;
  embedBatch(items: Qwen3VlBatchItem[], options?: Qwen3VlEmbedOptions): Promise<Qwen3VlEmbeddingResult>;
  shutdown(): Promise<void>;
}

export interface Qwen3VlEmbeddingLocalClientOptions {
  pythonBinary?: string;
  workerPath?: string;
  model?: string;
  device?: "auto" | "mps" | "cpu" | string;
  cacheDir?: string;
  mock?: boolean;
  cwd?: string;
  requestTimeoutMs?: number;
}

interface WorkerResponse<T> {
  id: number | null;
  ok: boolean;
  result?: T;
  error?: WorkerErrorPayload | string;
  elapsed_ms?: number;
}

interface WorkerErrorPayload {
  code?: string;
  message?: string;
  retryable?: boolean;
}

interface WorkerVectorResult {
  ref: string;
  vector: string;
  vector_encoding: string;
  dimension: number;
  normalized: boolean;
}

interface WorkerModelInfo {
  name: string;
  model_revision: string;
  output_dimension: number;
  instruction?: string;
  preprocess_version?: string;
  runner_name?: string;
  runner_version?: string;
  precision: string;
  device: string;
  distance_metric?: string;
}

interface WorkerEmbeddingMetrics {
  peak_rss_mb?: number;
  first_embed_peak_rss_mb?: number;
  rss_mb?: number;
}

interface WorkerEmbeddingResult {
  vectors: WorkerVectorResult[];
  model: WorkerModelInfo;
  elapsed_ms: number;
  metrics?: WorkerEmbeddingMetrics;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

export class Qwen3VlWorkerError extends Error {
  constructor(
    public readonly code: Qwen3VlEmbeddingErrorCode,
    message: string,
    public readonly retryable = false
  ) {
    super(message);
    this.name = "Qwen3VlWorkerError";
  }
}

export class Qwen3VlEmbeddingLocalClient implements Qwen3VlEmbeddingClient {
  private process: ChildProcessWithoutNullStreams | null = null;
  private stdoutLines: readline.Interface | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private stderrBuffer = "";

  constructor(private readonly options: Qwen3VlEmbeddingLocalClientOptions = {}) {}

  get diagnostics(): string {
    return this.stderrBuffer.trim();
  }

  get processId(): number | null {
    return this.process?.pid ?? null;
  }

  async embedText(texts: string[], options: Qwen3VlEmbedOptions = {}): Promise<Qwen3VlEmbeddingResult> {
    const params = {
      texts,
      ...toWorkerOptions(options),
    };
    return this.embeddingRequest("embed_text", params, options);
  }

  async embedImage(imagePaths: string[], options: Qwen3VlEmbedOptions = {}): Promise<Qwen3VlEmbeddingResult> {
    const params = {
      image_paths: imagePaths,
      ...toWorkerOptions(options),
    };
    return this.embeddingRequest("embed_image", params, options);
  }

  async embedMixed(items: Qwen3VlMixedInput[], options: Qwen3VlEmbedOptions = {}): Promise<Qwen3VlEmbeddingResult> {
    const params = {
      items: items.map((item) => ({
        ref: item.ref,
        text: item.text,
        image_path: item.imagePath,
      })),
      ...toWorkerOptions(options),
    };
    return this.embeddingRequest("embed_mixed", params, options);
  }

  async embedBatch(items: Qwen3VlBatchItem[], options: Qwen3VlEmbedOptions = {}): Promise<Qwen3VlEmbeddingResult> {
    const params = {
      items: items.map((item) => {
        if (item.kind === "image") {
          return { ref: item.ref, kind: item.kind, image_path: item.imagePath };
        }
        if (item.kind === "mixed") {
          return { ref: item.ref, kind: item.kind, text: item.text, image_path: item.imagePath };
        }
        return { ref: item.ref, kind: item.kind, text: item.text };
      }),
      ...toWorkerOptions(options),
    };
    return this.embeddingRequest("embed_batch", params, options, true);
  }

  async shutdown(): Promise<void> {
    if (this.isDirectMockMode()) {
      return;
    }
    const proc = this.process;
    if (!proc) {
      return;
    }

    try {
      await this.request("shutdown", {}, this.timeoutFor("shutdown"), false);
    } catch {
      // Teardown should not mask the original caller's failure.
    }

    this.stdoutLines?.close();
    this.stdoutLines = null;
    if (proc.exitCode === null && !proc.killed) {
      proc.kill();
    }
    if (this.process === proc) {
      this.process = null;
    }
  }

  async close(): Promise<void> {
    await this.shutdown();
  }

  private async embeddingRequest(
    method: "embed_text" | "embed_image" | "embed_mixed" | "embed_batch",
    params: Record<string, unknown>,
    options: Qwen3VlEmbedOptions,
    isBatch = false
  ): Promise<Qwen3VlEmbeddingResult> {
    if (this.isDirectMockMode()) {
      return this.mockEmbeddingResult(method, params, options);
    }

    const raw = await this.request<WorkerEmbeddingResult>(
      method,
      params,
      options.timeoutMs ?? this.timeoutFor(method, isBatch),
      true
    );
    return decodeWorkerEmbeddingResult(raw);
  }

  private async request<T>(
    method: string,
    params: Record<string, unknown>,
    timeoutMs: number,
    restartOnCrash: boolean
  ): Promise<T> {
    try {
      return await this.sendRequest<T>(method, params, timeoutMs);
    } catch (error) {
      if (
        restartOnCrash
        && error instanceof Qwen3VlWorkerError
        && error.code === "worker_crash"
      ) {
        this.clearProcess();
        return this.sendRequest<T>(method, params, timeoutMs);
      }
      throw error;
    }
  }

  private sendRequest<T>(
    method: string,
    params: Record<string, unknown>,
    timeoutMs: number
  ): Promise<T> {
    this.ensureStarted();
    const proc = this.process;
    if (!proc) {
      return Promise.reject(new Qwen3VlWorkerError("worker_crash", "Qwen3-VL worker did not start", true));
    }

    const id = this.nextId++;
    const payload = JSON.stringify({ id, method, params }) + "\n";

    const promise = new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        const diagnostics = summarizeDiagnostics(this.stderrBuffer);
        reject(
          new Qwen3VlWorkerError(
            "timeout",
            `Qwen3-VL worker request timed out after ${timeoutMs}ms for ${method}${diagnostics ? `: ${diagnostics}` : ""}`,
            true
          )
        );
        if (this.process === proc) {
          proc.kill();
          this.process = null;
        }
      }, timeoutMs);

      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timeout);
          resolve(value as T);
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        },
      });

      proc.stdin.write(payload, (error) => {
        if (error) {
          clearTimeout(timeout);
          this.pending.delete(id);
          reject(new Qwen3VlWorkerError("worker_crash", error.message, true));
        }
      });
    });

    return promise;
  }

  private ensureStarted(): void {
    if (this.process) {
      return;
    }

    const cwd = this.options.cwd ?? process.cwd();
    const python = this.options.pythonBinary ?? process.env.VOS_QWEN3VL_PYTHON ?? defaultQwen3VlPython(cwd);
    const workerPath =
      this.options.workerPath
      ?? process.env.VOS_QWEN3VL_WORKER
      ?? path.resolve(cwd, "python/qwen3vl_embedding_worker.py");
    const args = [workerPath];

    const model = this.options.model ?? process.env.VOS_QWEN3VL_MODEL;
    if (model) {
      args.push("--model", model);
    }
    const device = this.options.device ?? process.env.VOS_QWEN3VL_DEVICE;
    if (device) {
      args.push("--device", device);
    }
    const cacheDir = this.options.cacheDir ?? process.env.VOS_QWEN3VL_CACHE_DIR;
    if (cacheDir) {
      args.push("--cache-dir", cacheDir);
    }

    this.process = spawn(python, args, {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });

    const proc = this.process;
    this.stdoutLines = readline.createInterface({ input: proc.stdout });
    this.stdoutLines.on("line", (line) => this.handleLine(line));
    proc.stderr.on("data", (data: Buffer) => {
      this.stderrBuffer += data.toString("utf8");
    });
    proc.on("exit", (code, signal) => {
      const diagnostics = summarizeDiagnostics(this.stderrBuffer);
      const error = new Qwen3VlWorkerError(
        "worker_crash",
        `Qwen3-VL worker exited code=${code ?? "null"} signal=${signal ?? "null"}${diagnostics ? `: ${diagnostics}` : ""}`,
        true
      );
      for (const pending of this.pending.values()) {
        pending.reject(error);
      }
      this.pending.clear();
      this.stdoutLines?.close();
      this.stdoutLines = null;
      if (this.process === proc) {
        this.process = null;
      }
    });
  }

  private handleLine(line: string): void {
    let response: WorkerResponse<unknown>;
    try {
      response = JSON.parse(line) as WorkerResponse<unknown>;
    } catch {
      return;
    }

    if (response.id === null) {
      return;
    }

    const pending = this.pending.get(response.id);
    if (!pending) {
      return;
    }
    this.pending.delete(response.id);

    if (!response.ok) {
      pending.reject(toWorkerError(response.error));
      return;
    }

    pending.resolve(response.result);
  }

  private clearProcess(): void {
    this.stdoutLines?.close();
    this.stdoutLines = null;
    if (this.process && this.process.exitCode === null && !this.process.killed) {
      this.process.kill();
    }
    this.process = null;
  }

  private timeoutFor(method: string, isBatch = false): number {
    return (
      this.options.requestTimeoutMs
      ?? parsePositiveInt(process.env.VOS_QWEN3VL_REQUEST_TIMEOUT_MS)
      ?? (isBatch || method === "embed_batch" ? DEFAULT_BATCH_TIMEOUT_MS : DEFAULT_SINGLE_TIMEOUT_MS)
    );
  }

  private isDirectMockMode(): boolean {
    return this.options.mock ?? process.env.VOS_QWEN3VL_MOCK === "1";
  }

  private mockEmbeddingResult(
    method: "embed_text" | "embed_image" | "embed_mixed" | "embed_batch",
    params: Record<string, unknown>,
    options: Qwen3VlEmbedOptions
  ): Qwen3VlEmbeddingResult {
    const outputDimension = options.outputDimension ?? numberFromParams(params.output_dimension) ?? DEFAULT_DIMENSION;
    const normalize = options.normalize ?? booleanFromParams(params.normalize) ?? true;
    const instruction = options.instruction ?? stringFromParams(params.instruction);
    const preprocessVersion = options.preprocessVersion ?? stringFromParams(params.preprocess_version);
    const records = mockRecordsFor(method, params);
    const vectors = records.map((record) => ({
      ref: record.ref,
      vector: mockVector(`${method}:${record.seed}`, outputDimension, normalize),
      dimension: outputDimension,
      normalized: normalize,
    }));

    return {
      vectors,
      model: {
        name: this.options.model ?? process.env.VOS_QWEN3VL_MODEL ?? DEFAULT_MODEL,
        modelRevision: "mock",
        outputDimension,
        instruction,
        preprocessVersion,
        runnerName: "typescript-qwen3vl-mock",
        runnerVersion: "qwen3vl-worker-v1",
        precision: "mock",
        device: "mock",
        distanceMetric: "cosine",
      },
      elapsedMs: 0,
      metrics: {
        peakRssMb: 0,
        firstEmbedPeakRssMb: 0,
        rssMb: 0,
      },
    };
  }
}

function toWorkerOptions(options: Qwen3VlEmbedOptions): Record<string, unknown> {
  return {
    instruction: options.instruction,
    output_dimension: options.outputDimension,
    normalize: options.normalize,
    preprocess_version: options.preprocessVersion,
  };
}

function decodeWorkerEmbeddingResult(raw: WorkerEmbeddingResult): Qwen3VlEmbeddingResult {
  return {
    vectors: raw.vectors.map((vector) => ({
      ref: vector.ref,
      vector: decodeBase64Float32Le(vector),
      dimension: vector.dimension,
      normalized: vector.normalized,
    })),
    model: {
      name: raw.model.name,
      modelRevision: raw.model.model_revision,
      outputDimension: raw.model.output_dimension,
      instruction: raw.model.instruction,
      preprocessVersion: raw.model.preprocess_version,
      runnerName: raw.model.runner_name,
      runnerVersion: raw.model.runner_version,
      precision: raw.model.precision,
      device: raw.model.device,
      distanceMetric: raw.model.distance_metric,
    },
    elapsedMs: raw.elapsed_ms,
    metrics: raw.metrics
      ? {
          peakRssMb: raw.metrics.peak_rss_mb,
          firstEmbedPeakRssMb: raw.metrics.first_embed_peak_rss_mb,
          rssMb: raw.metrics.rss_mb,
        }
      : undefined,
  };
}

function decodeBase64Float32Le(vector: WorkerVectorResult): Float32Array {
  if (vector.vector_encoding !== VECTOR_ENCODING) {
    throw new Qwen3VlWorkerError(
      "invalid_input",
      `unsupported vector encoding from Qwen3-VL worker: ${vector.vector_encoding}`
    );
  }
  const bytes = Buffer.from(vector.vector, "base64");
  if (bytes.byteLength !== vector.dimension * 4) {
    throw new Qwen3VlWorkerError(
      "invalid_input",
      `Qwen3-VL worker vector byte length mismatch for ${vector.ref}: got ${bytes.byteLength}, expected ${vector.dimension * 4}`
    );
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const result = new Float32Array(vector.dimension);
  for (let index = 0; index < vector.dimension; index += 1) {
    result[index] = view.getFloat32(index * 4, true);
  }
  return result;
}

function toWorkerError(error: WorkerErrorPayload | string | undefined): Qwen3VlWorkerError {
  if (typeof error === "string") {
    return new Qwen3VlWorkerError("worker_crash", error, true);
  }
  const code = normalizeErrorCode(error?.code);
  return new Qwen3VlWorkerError(code, error?.message ?? "Qwen3-VL worker request failed", Boolean(error?.retryable));
}

function normalizeErrorCode(code: string | undefined): Qwen3VlEmbeddingErrorCode {
  switch (code) {
    case "model_not_found":
    case "mps_unavailable":
    case "oom":
    case "invalid_input":
    case "timeout":
    case "dependency_missing":
    case "worker_crash":
      return code;
    default:
      return "worker_crash";
  }
}

function defaultQwen3VlPython(cwd: string): string {
  for (const candidate of [
    path.resolve(cwd, "python/.venv-qwen3vl/bin/python3"),
    path.resolve(cwd, ".venv-qwen3vl/bin/python3"),
    path.resolve(cwd, ".venv/bin/python3"),
  ]) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return "python3";
}

function summarizeDiagnostics(stderr: string): string {
  const lines = stderr
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const offline = lines.find((line) => line.toLowerCase().includes("local_files_only"))
    ?? lines.find((line) => line.toLowerCase().includes("offline"));
  if (offline) {
    return `${offline} Warm the Qwen3-VL cache explicitly or set VOS_QWEN3VL_MODEL to a local path.`;
  }
  return lines.slice(-4).join(" / ");
}

function parsePositiveInt(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function stringFromParams(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function numberFromParams(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function booleanFromParams(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function mockRecordsFor(
  method: "embed_text" | "embed_image" | "embed_mixed" | "embed_batch",
  params: Record<string, unknown>
): Array<{ ref: string; seed: string }> {
  if (method === "embed_text") {
    const texts = Array.isArray(params.texts) ? params.texts : [];
    return texts.map((text, index) => ({ ref: String(index), seed: String(text) }));
  }
  if (method === "embed_image") {
    const imagePaths = Array.isArray(params.image_paths) ? params.image_paths : [];
    return imagePaths.map((imagePath, index) => ({ ref: String(index), seed: String(imagePath) }));
  }
  const items = Array.isArray(params.items) ? params.items : [];
  return items.map((item, index) => {
    if (item && typeof item === "object") {
      const record = item as Record<string, unknown>;
      return {
        ref: typeof record.ref === "string" ? record.ref : String(index),
        seed: JSON.stringify(record),
      };
    }
    return { ref: String(index), seed: String(item) };
  });
}

function mockVector(seed: string, dimension: number, normalize: boolean): Float32Array {
  const hash = crypto.createHash("sha256").update(seed).digest();
  let state = hash.readUInt32LE(0) || 1;
  const vector = new Float32Array(dimension);
  let normSquared = 0;
  for (let index = 0; index < dimension; index += 1) {
    state = (Math.imul(1664525, state) + 1013904223) >>> 0;
    const value = (state / 0xFFFFFFFF) * 2 - 1;
    vector[index] = value;
    normSquared += value * value;
  }
  if (normalize) {
    const norm = Math.sqrt(normSquared) || 1;
    for (let index = 0; index < vector.length; index += 1) {
      vector[index] = vector[index] / norm;
    }
  }
  return vector;
}

export function createQwen3VlEmbeddingLocalClient(
  options?: Qwen3VlEmbeddingLocalClientOptions
): Qwen3VlEmbeddingClient {
  return new Qwen3VlEmbeddingLocalClient(options);
}
