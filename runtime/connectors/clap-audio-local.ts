import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";

const DEFAULT_MODEL = "laion/clap-htsat-fused";
const DEFAULT_DIMENSION = 512;
const DEFAULT_SINGLE_TIMEOUT_MS = 30_000;
const DEFAULT_BATCH_TIMEOUT_MS = 120_000;
const VECTOR_ENCODING = "float32-le-base64";

export type ClapAudioEmbeddingErrorCode =
  | "model_not_found"
  | "mps_unavailable"
  | "oom"
  | "invalid_input"
  | "timeout"
  | "dependency_missing"
  | "audio_decode_failed"
  | "source_audio_missing"
  | "silent_window"
  | "worker_crash";

export interface ClapAudioEmbedOptions {
  outputDimension?: number;
  normalize?: boolean;
  preprocessVersion?: string;
  timeoutMs?: number;
}

export type ClapAudioBatchItem =
  | {
      ref?: string;
      kind: "text";
      text: string;
    }
  | {
      ref?: string;
      kind: "audio";
      audioPath: string;
    };

export interface ClapAudioVectorResult {
  ref: string;
  vector: Float32Array;
  dimension: number;
  normalized: boolean;
}

export interface ClapAudioModelInfo {
  name: string;
  modelRevision: string;
  outputDimension: number;
  preprocessVersion?: string;
  runnerName?: string;
  runnerVersion?: string;
  precision: string;
  device: string;
  distanceMetric?: string;
}

export interface ClapAudioEmbeddingMetrics {
  peakRssMb?: number;
  firstEmbedPeakRssMb?: number;
  rssMb?: number;
}

export interface ClapAudioEmbeddingResult {
  vectors: ClapAudioVectorResult[];
  model: ClapAudioModelInfo;
  elapsedMs: number;
  metrics?: ClapAudioEmbeddingMetrics;
}

export interface ClapAudioEmbeddingClient {
  embedText(texts: string[], options?: ClapAudioEmbedOptions): Promise<ClapAudioEmbeddingResult>;
  embedAudio(audioPaths: string[], options?: ClapAudioEmbedOptions): Promise<ClapAudioEmbeddingResult>;
  embedBatch(items: ClapAudioBatchItem[], options?: ClapAudioEmbedOptions): Promise<ClapAudioEmbeddingResult>;
  shutdown(): Promise<void>;
}

export interface ClapAudioEmbeddingLocalClientOptions {
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

export class ClapAudioWorkerError extends Error {
  constructor(
    public readonly code: ClapAudioEmbeddingErrorCode,
    message: string,
    public readonly retryable = false
  ) {
    super(message);
    this.name = "ClapAudioWorkerError";
  }
}

export class ClapAudioEmbeddingLocalClient implements ClapAudioEmbeddingClient {
  private process: ChildProcessWithoutNullStreams | null = null;
  private stdoutLines: readline.Interface | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private stderrBuffer = "";

  constructor(private readonly options: ClapAudioEmbeddingLocalClientOptions = {}) {}

  get diagnostics(): string {
    return this.stderrBuffer.trim();
  }

  get processId(): number | null {
    return this.process?.pid ?? null;
  }

  async embedText(texts: string[], options: ClapAudioEmbedOptions = {}): Promise<ClapAudioEmbeddingResult> {
    const params = {
      texts,
      ...toWorkerOptions(options),
    };
    return this.embeddingRequest("embed_text", params, options);
  }

  async embedAudio(audioPaths: string[], options: ClapAudioEmbedOptions = {}): Promise<ClapAudioEmbeddingResult> {
    const params = {
      audio_paths: audioPaths,
      ...toWorkerOptions(options),
    };
    return this.embeddingRequest("embed_audio", params, options);
  }

  async embedBatch(items: ClapAudioBatchItem[], options: ClapAudioEmbedOptions = {}): Promise<ClapAudioEmbeddingResult> {
    const params = {
      items: items.map((item) => {
        if (item.kind === "audio") {
          return { ref: item.ref, kind: item.kind, audio_path: item.audioPath };
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
    method: "embed_text" | "embed_audio" | "embed_batch",
    params: Record<string, unknown>,
    options: ClapAudioEmbedOptions,
    isBatch = false
  ): Promise<ClapAudioEmbeddingResult> {
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
        && error instanceof ClapAudioWorkerError
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
      return Promise.reject(new ClapAudioWorkerError("worker_crash", "CLAP audio worker did not start", true));
    }

    const id = this.nextId++;
    const payload = JSON.stringify({ id, method, params }) + "\n";

    const promise = new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        const diagnostics = summarizeDiagnostics(this.stderrBuffer);
        reject(
          new ClapAudioWorkerError(
            "timeout",
            `CLAP audio worker request timed out after ${timeoutMs}ms for ${method}${diagnostics ? `: ${diagnostics}` : ""}`,
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
          reject(new ClapAudioWorkerError("worker_crash", error.message, true));
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
    const python = this.options.pythonBinary ?? process.env.VOS_CLAP_PYTHON ?? defaultClapPython(cwd);
    const workerPath =
      this.options.workerPath
      ?? process.env.VOS_CLAP_WORKER
      ?? path.resolve(cwd, "python/clap_audio_worker.py");
    const args = [workerPath];

    const model = this.options.model ?? process.env.VOS_CLAP_MODEL;
    if (model) {
      args.push("--model", model);
    }
    const device = this.options.device ?? process.env.VOS_CLAP_DEVICE;
    if (device) {
      args.push("--device", device);
    }
    const cacheDir = this.options.cacheDir ?? process.env.VOS_CLAP_CACHE_DIR;
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
      const error = new ClapAudioWorkerError(
        "worker_crash",
        `CLAP audio worker exited code=${code ?? "null"} signal=${signal ?? "null"}${diagnostics ? `: ${diagnostics}` : ""}`,
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
      ?? parsePositiveInt(process.env.VOS_CLAP_REQUEST_TIMEOUT_MS)
      ?? (isBatch || method === "embed_batch" ? DEFAULT_BATCH_TIMEOUT_MS : DEFAULT_SINGLE_TIMEOUT_MS)
    );
  }

  private isDirectMockMode(): boolean {
    return this.options.mock ?? process.env.VOS_CLAP_MOCK === "1";
  }

  private mockEmbeddingResult(
    method: "embed_text" | "embed_audio" | "embed_batch",
    params: Record<string, unknown>,
    options: ClapAudioEmbedOptions
  ): ClapAudioEmbeddingResult {
    const outputDimension = options.outputDimension ?? numberFromParams(params.output_dimension) ?? DEFAULT_DIMENSION;
    const normalize = options.normalize ?? booleanFromParams(params.normalize) ?? true;
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
        name: this.options.model ?? process.env.VOS_CLAP_MODEL ?? DEFAULT_MODEL,
        modelRevision: "mock",
        outputDimension,
        preprocessVersion,
        runnerName: "typescript-clap-audio-mock",
        runnerVersion: "clap-audio-worker-v1",
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

function toWorkerOptions(options: ClapAudioEmbedOptions): Record<string, unknown> {
  return {
    output_dimension: options.outputDimension,
    normalize: options.normalize,
    preprocess_version: options.preprocessVersion,
  };
}

function decodeWorkerEmbeddingResult(raw: WorkerEmbeddingResult): ClapAudioEmbeddingResult {
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
    throw new ClapAudioWorkerError(
      "invalid_input",
      `unsupported vector encoding from CLAP audio worker: ${vector.vector_encoding}`
    );
  }
  const bytes = Buffer.from(vector.vector, "base64");
  if (bytes.byteLength !== vector.dimension * 4) {
    throw new ClapAudioWorkerError(
      "invalid_input",
      `CLAP audio worker vector byte length mismatch for ${vector.ref}: got ${bytes.byteLength}, expected ${vector.dimension * 4}`
    );
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const result = new Float32Array(vector.dimension);
  for (let index = 0; index < vector.dimension; index += 1) {
    result[index] = view.getFloat32(index * 4, true);
  }
  return result;
}

function toWorkerError(error: WorkerErrorPayload | string | undefined): ClapAudioWorkerError {
  if (typeof error === "string") {
    return new ClapAudioWorkerError("worker_crash", error, true);
  }
  const code = normalizeErrorCode(error?.code);
  return new ClapAudioWorkerError(code, error?.message ?? "CLAP audio worker request failed", Boolean(error?.retryable));
}

function normalizeErrorCode(code: string | undefined): ClapAudioEmbeddingErrorCode {
  switch (code) {
    case "model_not_found":
    case "mps_unavailable":
    case "oom":
    case "invalid_input":
    case "timeout":
    case "dependency_missing":
    case "audio_decode_failed":
    case "source_audio_missing":
    case "silent_window":
    case "worker_crash":
      return code;
    default:
      return "worker_crash";
  }
}

function defaultClapPython(cwd: string): string {
  for (const candidate of [
    path.resolve(cwd, "python/.venv-clap/bin/python3"),
    path.resolve(cwd, ".venv-clap/bin/python3"),
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
    return `${offline} Warm the CLAP cache explicitly or set VOS_CLAP_MODEL to a local path.`;
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
  method: "embed_text" | "embed_audio" | "embed_batch",
  params: Record<string, unknown>
): Array<{ ref: string; seed: string }> {
  if (method === "embed_text") {
    const texts = Array.isArray(params.texts) ? params.texts : [];
    return texts.map((text, index) => ({ ref: String(index), seed: String(text) }));
  }
  if (method === "embed_audio") {
    const audioPaths = Array.isArray(params.audio_paths) ? params.audio_paths : [];
    return audioPaths.map((audioPath, index) => ({ ref: String(index), seed: String(audioPath) }));
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

export function createClapAudioEmbeddingLocalClient(
  options?: ClapAudioEmbeddingLocalClientOptions
): ClapAudioEmbeddingClient {
  return new ClapAudioEmbeddingLocalClient(options);
}
