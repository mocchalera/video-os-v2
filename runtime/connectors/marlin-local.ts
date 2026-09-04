import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import * as readline from "node:readline";
import * as path from "node:path";
import * as fs from "node:fs";
import type { MarlinCaptionOptions, MarlinFn, MarlinRawCaption, MarlinRawFind } from "./marlin-types.js";

interface WorkerResponse<T> {
  id: number | null;
  ok: boolean;
  result?: T;
  error?: string;
}

export interface MarlinWorkerClientOptions {
  pythonBinary?: string;
  workerPath?: string;
  model?: string;
  device?: string;
  mock?: boolean;
  cwd?: string;
  requestTimeoutMs?: number;
  /** Policy ceiling clamping every caption token bound in the worker. */
  captionMaxNewTokensMax?: number;
}

export class MarlinWorkerClient implements MarlinFn {
  private process: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private readonly pending = new Map<
    number,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
    }
  >();
  private stderrBuffer = "";

  constructor(private readonly options: MarlinWorkerClientOptions = {}) {}

  async caption(videoPath: string, options?: MarlinCaptionOptions): Promise<MarlinRawCaption> {
    const params: Record<string, unknown> = { video_path: videoPath };
    const maxNewTokens = options?.maxNewTokens;
    if (Number.isInteger(maxNewTokens) && (maxNewTokens ?? 0) > 0) {
      params.max_new_tokens = maxNewTokens;
    }
    return this.request<MarlinRawCaption>("caption", params);
  }

  async find(videoPath: string, event: string): Promise<MarlinRawFind> {
    return this.request<MarlinRawFind>("find", { video_path: videoPath, event });
  }

  async close(): Promise<void> {
    if (!this.process) {
      return;
    }

    try {
      await this.request("shutdown", {});
    } catch {
      // Process teardown must be best-effort; pending request errors are surfaced elsewhere.
    }

    this.process.kill();
    this.process = null;
  }

  get diagnostics(): string {
    return this.stderrBuffer.trim();
  }

  private ensureStarted(): void {
    if (this.process) {
      return;
    }

    const cwd = this.options.cwd ?? process.cwd();
    const python = this.options.pythonBinary ?? process.env.VOS_MARLIN_PYTHON ?? defaultMarlinPython(cwd);
    const workerPath =
      this.options.workerPath ??
      process.env.VOS_MARLIN_WORKER ??
      path.resolve(process.cwd(), "python/marlin_worker.py");
    const args = [workerPath];

    if (this.options.mock ?? process.env.VOS_MARLIN_MOCK === "1") {
      args.push("--mock");
    }
    if (this.options.model) {
      args.push("--model", this.options.model);
    }
    if (this.options.device) {
      args.push("--device", this.options.device);
    }
    if (
      Number.isInteger(this.options.captionMaxNewTokensMax) &&
      (this.options.captionMaxNewTokensMax ?? 0) > 0
    ) {
      args.push("--caption-max-new-tokens-max", String(this.options.captionMaxNewTokensMax));
    }

    this.process = spawn(python, args, {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });

    const lines = readline.createInterface({ input: this.process.stdout });
    lines.on("line", (line) => this.handleLine(line));
    this.process.stderr.on("data", (data: Buffer) => {
      this.stderrBuffer += data.toString("utf8");
    });
    this.process.on("exit", (code, signal) => {
      const diagnostics = summarizeDiagnostics(this.stderrBuffer);
      const error = new Error(
        `Marlin worker exited code=${code ?? "null"} signal=${signal ?? "null"}${diagnostics ? `: ${diagnostics}` : ""}`
      );
      for (const pending of this.pending.values()) {
        pending.reject(error);
      }
      this.pending.clear();
      this.process = null;
    });
  }

  private request<T>(method: string, params: Record<string, unknown>): Promise<T> {
    this.ensureStarted();
    const proc = this.process;
    if (!proc) {
      return Promise.reject(new Error("Marlin worker did not start"));
    }

    const id = this.nextId++;
    const payload = JSON.stringify({ id, method, params }) + "\n";
    const timeoutMs = this.options.requestTimeoutMs ?? parsePositiveInt(process.env.VOS_MARLIN_REQUEST_TIMEOUT_MS) ?? 300_000;
    const promise = new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        const diagnostics = summarizeDiagnostics(this.stderrBuffer);
        reject(
          new Error(
            `Marlin worker request timed out after ${timeoutMs}ms for ${method}${diagnostics ? `: ${diagnostics}` : ""}`
          )
        );
        this.process?.kill();
        this.process = null;
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
    });
    proc.stdin.write(payload);
    return promise;
  }

  private handleLine(line: string): void {
    let response: WorkerResponse<unknown>;
    try {
      response = JSON.parse(line) as WorkerResponse<unknown>;
    } catch (error) {
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
      pending.reject(new Error(response.error ?? "Marlin worker request failed"));
      return;
    }

    pending.resolve(response.result);
  }
}

function defaultMarlinPython(cwd: string): string {
  for (const candidate of [
    path.resolve(cwd, "python/.venv-marlin/bin/python3"),
    path.resolve(cwd, ".venv-marlin/bin/python3"),
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
  const gated = lines.find((line) => line.includes("Cannot access gated repo"))
    ?? lines.find((line) => line.includes("You are trying to access a gated repo"))
    ?? lines.find((line) => line.includes("401 Client Error"));
  if (gated) {
    return `${gated} Set HF_TOKEN in .env.local after accepting model access.`;
  }
  return lines.slice(-4).join(" / ");
}

function parsePositiveInt(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

export function createMarlinWorkerClient(options?: MarlinWorkerClientOptions): MarlinFn {
  return new MarlinWorkerClient(options);
}
