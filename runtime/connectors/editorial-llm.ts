import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import {
  callGeminiJson,
  callGeminiMultimodal,
  type GeminiMultimodalImageInput,
} from "./gemini-json.js";
import { parseLlmResponse } from "../agents/llm-json.js";
import {
  createFileEditorialAttemptJournal,
  type EditorialAttemptJournal,
} from "./editorial-llm-journal.js";

export type EditorialLlmRuntime =
  | "auto"
  | "codex_exec"
  | "claude_cli"
  | "gemini"
  | "deterministic";
export type EditorialLlmConcreteRuntime = Exclude<EditorialLlmRuntime, "auto">;
export type EditorialLlmLiveRuntime = Exclude<EditorialLlmConcreteRuntime, "deterministic">;

export interface EditorialLlmRequest {
  role: string;
  prompt: string;
  responseSchema?: object;
  timeoutMs?: number;
  images?: GeminiMultimodalImageInput[];
}

export interface EditorialLlmCompletion {
  text: string;
  runtime: Exclude<EditorialLlmRuntime, "auto">;
  warnings: string[];
  attempts: EditorialLlmAttempt[];
}

export interface EditorialLlmAttempt {
  runtime: Exclude<EditorialLlmRuntime, "auto">;
  status: "success" | "failed" | "skipped";
  message?: string;
  /** Typed failure classification; present on failed attempts. */
  error_kind?: EditorialLlmErrorKind;
}

/**
 * Failure classification for the editorial LLM contract.
 *
 * - transport_timeout / transport_error: the runtime never produced usable
 *   text (spawn failure, non-zero exit, or timeout). These are not the
 *   model's fault and must not trigger a JSON repair retry.
 * - json_parse / schema_validation: text came back but did not satisfy the
 *   JSON contract. These are the only kinds eligible for a repair retry.
 */
export type EditorialLlmErrorKind =
  | "transport_timeout"
  | "transport_error"
  | "json_parse"
  | "schema_validation";

export class EditorialLlmError extends Error {
  readonly kind: EditorialLlmErrorKind;

  constructor(kind: EditorialLlmErrorKind, message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = "EditorialLlmError";
    this.kind = kind;
    if (options?.cause !== undefined) this.cause = options.cause;
  }
}

/**
 * Best-effort transport classification for errors thrown by injectable
 * executors/completers. Errors already typed as EditorialLlmError keep their
 * kind; plain timeout-looking errors are classified as transport timeouts.
 */
export function classifyTransportError(error: unknown): "transport_timeout" | "transport_error" {
  if (error instanceof EditorialLlmError) {
    return error.kind === "transport_timeout" ? "transport_timeout" : "transport_error";
  }
  const message = error instanceof Error ? error.message : String(error);
  return /timed?\s*-?\s*out|timeout/i.test(message) ? "transport_timeout" : "transport_error";
}

export type DecisionAuthor =
  | "llm"
  | "deterministic_fallback"
  | "human"
  | "agent_evidence_synthesis";

export interface DecisionRuntimeRecord {
  runtime: string;
  role: string;
  /**
   * Who actually authored the decision. LLM fallbacks must never masquerade
   * as model output; human-authored or agent-synthesized selects/blueprints
   * carry an explicit non-LLM author.
   */
  author?: DecisionAuthor;
  attempted_runtimes: EditorialLlmAttempt[];
  fallback_warnings?: string[];
}

export interface CompleteEditorialJsonRequest extends EditorialLlmRequest {
  parseJson?: (text: string) => Record<string, unknown>;
  validateJson?: (parsed: Record<string, unknown>) => void;
  repairPrompt?: (originalPrompt: string, raw: string, error: unknown) => string;
}

export interface EditorialLlmJsonCompletion extends EditorialLlmCompletion {
  parsed: Record<string, unknown>;
}

export interface EditorialLlmExecutorInput {
  command: string;
  args: string[];
  cwd: string;
  input?: string;
  timeoutMs: number;
  /**
   * Grace period between SIGTERM and SIGKILL when the runtime exceeds
   * timeoutMs. Defaults to DEFAULT_KILL_GRACE_MS; tests may shorten it.
   */
  killGraceMs?: number;
}

export interface EditorialLlmExecutorResult {
  stdout: string;
  stderr: string;
}

export type EditorialLlmExecutor = (input: EditorialLlmExecutorInput) => Promise<EditorialLlmExecutorResult>;
export type CommandExists = (command: string) => boolean;
export type GeminiTextCompleter = (
  prompt: string,
  model: string,
  options: { retryLabel: string; maxOutputTokens: number; temperature?: number; timeoutMs?: number },
) => Promise<string>;
export type GeminiMultimodalCompleter = (
  prompt: string,
  images: GeminiMultimodalImageInput[],
  model: string,
  options: { retryLabel: string; maxOutputTokens: number; temperature?: number; timeoutMs?: number },
) => Promise<string>;

export interface EditorialLlmConnectorOptions {
  runtime?: EditorialLlmRuntime;
  geminiModel?: string;
  commandExists?: CommandExists;
  executor?: EditorialLlmExecutor;
  geminiText?: GeminiTextCompleter;
  geminiMultimodal?: GeminiMultimodalCompleter;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  warn?: (message: string) => void;
  /**
   * Whole-stage budget shared by every runtime attempt in one completion call.
   * Each live runtime receives min(per-call timeout, remaining budget) as its
   * invocation timeout, so a chain of slow runtimes cannot exceed the stage
   * deadline. Defaults from VOS_EDITORIAL_LLM_STAGE_TIMEOUT_MS,
   * analysis-defaults.yaml editorial_llm.stage_timeout_ms, or
   * DEFAULT_STAGE_TIMEOUT_MS.
   */
  stageTimeoutMs?: number;
  /**
   * Project directory used to persist the sanitized attempt journal at
   * 03_analysis/editorial-llm-attempts.jsonl. The journal records role, mode,
   * transport runtime, requested/effective provider+model (unknown when the
   * transport cannot prove it), retry index, timings, status, and fallback
   * reason — never prompt bodies or credentials.
   */
  projectDir?: string;
  /** Direct journal injection (tests / custom sinks). Overrides projectDir. */
  journal?: EditorialAttemptJournal;
}

export interface ProviderModelEvidence {
  requested_provider: string;
  requested_model: string;
  effective_provider: string;
  effective_model: string;
  model_confirmed: boolean;
}

interface EditorialLlmDefaults {
  runtime: EditorialLlmRuntime;
  timeoutMs: number;
  stageTimeoutMs: number;
}

const DEFAULT_TIMEOUT_MS = 180_000;
const DEFAULT_STAGE_TIMEOUT_MS = 300_000;
const DEFAULT_KILL_GRACE_MS = 5_000;
const DEFAULT_GEMINI_MODEL = "gemini-2.5-flash-lite";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isRuntime(value: string | undefined): value is EditorialLlmRuntime {
  return value === "auto"
    || value === "codex_exec"
    || value === "claude_cli"
    || value === "gemini"
    || value === "deterministic";
}

function connectorRoot(): string {
  return path.dirname(fileURLToPath(import.meta.url));
}

function loadDefaults(): EditorialLlmDefaults {
  const defaultsPath = path.resolve(connectorRoot(), "../analysis-defaults.yaml");
  try {
    const parsed = parseYaml(fs.readFileSync(defaultsPath, "utf-8")) as unknown;
    const editorial = isRecord(parsed)
      && isRecord(parsed.editorial_llm)
      ? parsed.editorial_llm
      : {};
    const runtime = isRuntime(String(editorial.runtime ?? "auto"))
      ? String(editorial.runtime ?? "auto") as EditorialLlmRuntime
      : "auto";
    const timeoutMs = Number(editorial.timeout_ms ?? DEFAULT_TIMEOUT_MS);
    const stageTimeoutMs = Number(editorial.stage_timeout_ms ?? DEFAULT_STAGE_TIMEOUT_MS);
    return {
      runtime,
      timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.trunc(timeoutMs) : DEFAULT_TIMEOUT_MS,
      stageTimeoutMs: Number.isFinite(stageTimeoutMs) && stageTimeoutMs > 0
        ? Math.trunc(stageTimeoutMs)
        : DEFAULT_STAGE_TIMEOUT_MS,
    };
  } catch {
    return { runtime: "auto", timeoutMs: DEFAULT_TIMEOUT_MS, stageTimeoutMs: DEFAULT_STAGE_TIMEOUT_MS };
  }
}

function defaultCommandExists(command: string): boolean {
  const pathEnv = process.env.PATH ?? "";
  const names = process.platform === "win32" ? [command, `${command}.cmd`, `${command}.exe`] : [command];
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) continue;
    for (const name of names) {
      const candidate = path.join(dir, name);
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        return true;
      } catch {
        // Continue scanning PATH.
      }
    }
  }
  return false;
}

export function defaultExecutor(input: EditorialLlmExecutorInput): Promise<EditorialLlmExecutorResult> {
  return new Promise((resolve, reject) => {
    // detached on POSIX gives the child its own process group so the whole
    // descendant tree can be signalled with -pid (CLI wrappers often spawn
    // grandchildren that outlive a bare child.kill).
    const child = spawn(input.command, input.args, {
      cwd: input.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let escalateTimer: NodeJS.Timeout | undefined;

    /** Signal the child's whole process group, falling back to the child. */
    const signalTree = (signal: NodeJS.Signals): void => {
      if (child.pid === undefined || child.exitCode !== null) return;
      try {
        process.kill(-child.pid, signal);
      } catch {
        try {
          child.kill(signal);
        } catch {
          // The child already exited; nothing left to terminate.
        }
      }
    };

    const clearEscalation = () => {
      if (escalateTimer) {
        clearTimeout(escalateTimer);
        escalateTimer = undefined;
      }
    };

    const timeout = setTimeout(() => {
      timedOut = true;
      // SIGTERM first so well-behaved runtimes can flush; escalate to SIGKILL
      // for the whole group after the grace period so no descendants survive.
      signalTree("SIGTERM");
      escalateTimer = setTimeout(() => signalTree("SIGKILL"), Math.max(0, input.killGraceMs ?? DEFAULT_KILL_GRACE_MS));
      escalateTimer.unref?.();
      reject(new EditorialLlmError(
        "transport_timeout",
        `${input.command} timed out after ${input.timeoutMs}ms`,
      ));
    }, input.timeoutMs);
    child.stdout.setEncoding("utf-8");
    child.stderr.setEncoding("utf-8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      clearEscalation();
      if (!timedOut) {
        reject(new EditorialLlmError("transport_error", `${input.command} failed to start: ${error.message}`, { cause: error }));
      }
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      clearEscalation();
      if (timedOut) return;
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      reject(new EditorialLlmError(
        "transport_error",
        `${input.command} exited with ${code}: ${stderr.trim() || stdout.trim()}`,
      ));
    });
    child.stdin.end(input.input ?? "");
  });
}

function requestedRuntime(
  opts: EditorialLlmConnectorOptions,
  env: NodeJS.ProcessEnv,
): EditorialLlmRuntime {
  if (isRuntime(opts.runtime)) return opts.runtime;
  const envRuntime = env.VOS_EDITORIAL_LLM;
  if (isRuntime(envRuntime)) return envRuntime;
  return loadDefaults().runtime;
}

function configuredTimeoutMs(request: EditorialLlmRequest, env: NodeJS.ProcessEnv): number {
  if (request.timeoutMs && request.timeoutMs > 0) return Math.trunc(request.timeoutMs);
  const envTimeout = Number(env.VOS_EDITORIAL_LLM_TIMEOUT_MS);
  if (Number.isFinite(envTimeout) && envTimeout > 0) return Math.trunc(envTimeout);
  return loadDefaults().timeoutMs;
}

function resolveGeminiModel(opts: EditorialLlmConnectorOptions, env: NodeJS.ProcessEnv): string {
  return opts.geminiModel
    ?? env.EDITORIAL_LLM_GEMINI_MODEL
    ?? env.UNIFIED_EDITORIAL_MODEL
    ?? env.BLUEPRINT_MODEL
    ?? env.TRIAGE_MODEL
    ?? DEFAULT_GEMINI_MODEL;
}

/**
 * Provider/model evidence for one runtime attempt. codex_exec and claude_cli
 * wrap their own model selection, so their internal models are NOT provable:
 * they stay "unknown" and must never be backfilled with a Gemini alias.
 * Gemini is called directly with an explicit model id, so requested ==
 * effective for that transport.
 */
function providerModelForRuntime(
  runtime: EditorialLlmConcreteRuntime,
  opts: EditorialLlmConnectorOptions,
  env: NodeJS.ProcessEnv,
): ProviderModelEvidence {
  if (runtime === "gemini") {
    const model = resolveGeminiModel(opts, env);
    return {
      requested_provider: "gemini",
      requested_model: model,
      effective_provider: "gemini",
      effective_model: model,
      model_confirmed: true,
    };
  }
  if (runtime === "codex_exec") {
    return {
      requested_provider: "codex",
      requested_model: "unknown",
      effective_provider: "codex_exec",
      effective_model: "unknown",
      model_confirmed: false,
    };
  }
  if (runtime === "claude_cli") {
    return {
      requested_provider: "claude",
      requested_model: "unknown",
      effective_provider: "claude_cli",
      effective_model: "unknown",
      model_confirmed: false,
    };
  }
  return {
    requested_provider: "deterministic",
    requested_model: "deterministic",
    effective_provider: "deterministic",
    effective_model: "deterministic",
    model_confirmed: true,
  };
}

function journalFor(opts: EditorialLlmConnectorOptions): EditorialAttemptJournal | undefined {
  if (opts.journal) return opts.journal;
  if (opts.projectDir) return createFileEditorialAttemptJournal(opts.projectDir);
  return undefined;
}

function configuredStageTimeoutMs(opts: EditorialLlmConnectorOptions, env: NodeJS.ProcessEnv): number {
  // An explicit 0 is honored: the stage budget starts already exhausted and
  // live runtimes are skipped immediately.
  if (opts.stageTimeoutMs !== undefined && Number.isFinite(opts.stageTimeoutMs) && opts.stageTimeoutMs >= 0) {
    return Math.trunc(opts.stageTimeoutMs);
  }
  const envStage = Number(env.VOS_EDITORIAL_LLM_STAGE_TIMEOUT_MS);
  if (Number.isFinite(envStage) && envStage >= 0) return Math.trunc(envStage);
  return loadDefaults().stageTimeoutMs;
}

/** Read the same configured whole-stage budget used by live editorial calls. */
export function resolveEditorialStageTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  return configuredStageTimeoutMs({}, env);
}

/**
 * Build a stage deadline from the same configuration chain the connector
 * uses (explicit option > env > analysis-defaults.yaml). Callers driving
 * several completion calls inside one stage (bounded triage batches) share
 * this deadline and hand each call its remaining budget via stageTimeoutMs.
 */
export function createEditorialStageDeadline(
  opts: Pick<EditorialLlmConnectorOptions, "stageTimeoutMs"> = {},
  env: NodeJS.ProcessEnv = process.env,
): StageDeadline {
  return new StageDeadline(configuredStageTimeoutMs(opts as EditorialLlmConnectorOptions, env));
}

/**
 * Stage-wide deadline shared across the runtime chain. Each live runtime is
 * invoked with min(per-call timeout, remaining stage budget); once the budget
 * is exhausted the chain stops calling live runtimes and falls back.
 *
 * Multi-batch editorial stages (e.g. bounded triage batching) reuse this same
 * deadline shape across their batch loop via createEditorialStageDeadline, so
 * the whole stage shares one budget and never starts a new call after it is
 * exhausted.
 */
export class StageDeadline {
  private readonly startedAtMs: number;
  private readonly now: () => number;
  readonly budgetMs: number;

  constructor(budgetMs: number, now: () => number = Date.now) {
    this.startedAtMs = now();
    this.budgetMs = Math.max(0, Math.trunc(budgetMs));
    this.now = now;
  }

  /** Remaining milliseconds for the whole stage; <= 0 means exhausted. */
  remainingMs(): number {
    return this.budgetMs - (this.now() - this.startedAtMs);
  }

  /** Per-invocation timeout: never exceed either the call cap or the stage. */
  budgetForCall(perCallTimeoutMs: number): number {
    return Math.max(1, Math.min(Math.trunc(perCallTimeoutMs), Math.floor(this.remainingMs())));
  }

  get exhausted(): boolean {
    return this.remainingMs() <= 0;
  }
}

function runtimeChain(
  requested: EditorialLlmRuntime,
  commandExists: CommandExists,
  env: NodeJS.ProcessEnv,
): EditorialLlmConcreteRuntime[] {
  const available: EditorialLlmConcreteRuntime[] = [];
  if (commandExists("codex")) available.push("codex_exec");
  if (commandExists("claude")) available.push("claude_cli");
  if (env.GEMINI_API_KEY) available.push("gemini");
  available.push("deterministic");

  if (requested === "auto") return available;
  if (requested === "deterministic") return ["deterministic"];

  const start = available.indexOf(requested);
  if (start >= 0) return available.slice(start);
  return [requested, "deterministic"];
}

export function availableEditorialLlmRuntimes(
  request: Pick<EditorialLlmRequest, "images"> = {},
  opts: EditorialLlmConnectorOptions = {},
): EditorialLlmLiveRuntime[] {
  const env = opts.env ?? process.env;
  const commandExists = opts.commandExists ?? defaultCommandExists;
  const images = request.images ?? [];
  return runtimeChain(requestedRuntime(opts, env), commandExists, env).filter(
    (runtime): runtime is EditorialLlmLiveRuntime =>
      runtime !== "deterministic" &&
      !(runtime === "claude_cli" && images.length > 0),
  );
}

function writeSchemaFile(tempDir: string, schema: object | undefined): string | undefined {
  if (!schema) return undefined;
  const schemaPath = path.join(tempDir, "response-schema.json");
  fs.writeFileSync(schemaPath, JSON.stringify(schema, null, 2), "utf-8");
  return schemaPath;
}

function extractString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function extractTextFromContent(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return undefined;
  const parts = value.flatMap((part) => {
    if (typeof part === "string") return [part];
    if (!isRecord(part)) return [];
    return [
      extractString(part.text),
      extractString(part.content),
      extractString(part.message),
    ].filter((item): item is string => Boolean(item));
  });
  return parts.length > 0 ? parts.join("") : undefined;
}

function extractCodexEventText(event: unknown): string | undefined {
  if (!isRecord(event)) return undefined;
  for (const key of ["message", "text", "content", "final_response", "output"]) {
    const direct = key === "content" ? extractTextFromContent(event[key]) : extractString(event[key]);
    if (direct) return direct;
  }
  const item = isRecord(event.item) ? event.item : undefined;
  if (item) {
    const itemText = extractString(item.text)
      ?? extractTextFromContent(item.content)
      ?? extractString(item.message);
    if (itemText) return itemText;
  }
  const msg = isRecord(event.msg) ? event.msg : undefined;
  if (msg) {
    const msgText = extractString(msg.text)
      ?? extractTextFromContent(msg.content)
      ?? extractString(msg.message);
    if (msgText) return msgText;
  }
  return undefined;
}

export function parseCodexExecJsonl(stdout: string): string {
  const candidates: string[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const event = JSON.parse(trimmed) as unknown;
      const text = extractCodexEventText(event);
      if (text) candidates.push(text);
    } catch {
      if (trimmed.startsWith("{") || trimmed.startsWith("[")) continue;
      candidates.push(trimmed);
    }
  }
  return candidates[candidates.length - 1]?.trim() ?? "";
}

function imageFileExtension(mimeType: string): string {
  const subtype = mimeType.split("/")[1]?.toLowerCase() ?? "";
  if (subtype === "jpeg" || subtype === "jpg") return "jpg";
  if (subtype === "png") return "png";
  if (subtype === "webp") return "webp";
  if (subtype === "gif") return "gif";
  return "png";
}

/**
 * Materialize request images to files codex exec can attach via `-i`.
 * Path inputs are used in place; inline base64 payloads are written into
 * the per-request temp dir, which the caller removes afterwards.
 */
function materializeImageFiles(
  tempDir: string,
  images: GeminiMultimodalImageInput[],
): string[] {
  return images.map((image, index) => {
    if ("path" in image) return image.path;
    const filePath = path.join(
      tempDir,
      `image-${index + 1}.${imageFileExtension(image.mimeType)}`,
    );
    fs.writeFileSync(filePath, Buffer.from(image.data, "base64"));
    return filePath;
  });
}

async function runCodexExec(
  request: EditorialLlmRequest,
  executor: EditorialLlmExecutor,
  timeoutMs: number,
): Promise<string> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "vos-editorial-codex-"));
  try {
    const schemaPath = writeSchemaFile(tempDir, request.responseSchema);
    const outputPath = path.join(tempDir, "last-message.txt");
    const imagePaths = materializeImageFiles(tempDir, request.images ?? []);
    const args = [
      "exec",
      "-s",
      "read-only",
      "--json",
      "--ephemeral",
      "--skip-git-repo-check",
      "-C",
      tempDir,
      "-o",
      outputPath,
      ...(schemaPath ? ["--output-schema", schemaPath] : []),
      ...imagePaths.flatMap((imagePath) => ["-i", imagePath]),
      "-",
    ];
    const result = await executor({
      command: "codex",
      args,
      cwd: tempDir,
      input: request.prompt,
      timeoutMs,
    });
    const fromStdout = parseCodexExecJsonl(result.stdout);
    if (fromStdout) return fromStdout;
    if (fs.existsSync(outputPath)) return fs.readFileSync(outputPath, "utf-8").trim();
    return result.stdout.trim();
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function runClaudeCli(
  request: EditorialLlmRequest,
  executor: EditorialLlmExecutor,
  timeoutMs: number,
): Promise<string> {
  if ((request.images ?? []).length > 0) {
    throw new Error(
      "claude_cli does not support image inputs; falling through to the next runtime",
    );
  }
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "vos-editorial-claude-"));
  try {
    const args = [
      "-p",
      request.prompt,
      "--output-format",
      "text",
    ];
    const result = await executor({
      command: "claude",
      args,
      cwd,
      timeoutMs,
    });
    return result.stdout.trim();
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

async function runGemini(
  request: EditorialLlmRequest,
  opts: EditorialLlmConnectorOptions,
  timeoutMs: number,
): Promise<string> {
  const env = opts.env ?? process.env;
  const model = resolveGeminiModel(opts, env);
  const images = request.images ?? [];
  if (images.length > 0) {
    return (opts.geminiMultimodal ?? callGeminiMultimodal)(
      request.prompt,
      images,
      model,
      {
        retryLabel: request.role,
        maxOutputTokens: 32768,
        temperature: 0.15,
        timeoutMs,
      },
    );
  }
  return (opts.geminiText ?? callGeminiJson)(
    request.prompt,
    model,
    {
      retryLabel: request.role,
      maxOutputTokens: 32768,
      temperature: 0.15,
      timeoutMs,
    },
  );
}

function safeFailureMessage(error: unknown, kind: EditorialLlmErrorKind): string {
  const message = error instanceof Error ? error.message : String(error);
  if (kind === "transport_timeout") return "transport timeout";
  if (kind === "transport_error") {
    // Preserve one operator-useful, fixed configuration diagnostic without
    // persisting arbitrary provider/CLI output.
    return /does not support image inputs/i.test(message)
      ? "image inputs unsupported"
      : "transport_error";
  }
  if (kind === "json_parse") {
    // This stable detail keeps the existing parse-vs-transport evidence useful
    // while dropping all other parser/provider text.
    return /No JSON object found/i.test(message)
      ? "JSON parse failed: No JSON object found"
      : "JSON parse failed";
  }
  return "Schema validation failed";
}

function warningFor(
  runtime: string,
  error: unknown,
  kind: EditorialLlmErrorKind = classifyTransportError(error),
): string {
  return `${runtime}: ${safeFailureMessage(error, kind)}`;
}

export function decisionRuntimeRecord(
  completion: Pick<EditorialLlmCompletion, "runtime" | "warnings" | "attempts">,
  role: string,
): DecisionRuntimeRecord {
  return {
    runtime: completion.runtime,
    role,
    author: completion.runtime === "deterministic" ? "deterministic_fallback" : "llm",
    attempted_runtimes: completion.attempts,
    ...(completion.warnings.length > 0 ? { fallback_warnings: completion.warnings } : {}),
  };
}

export function deterministicDecisionRuntime(
  role: string,
  warnings: string[] = [],
): DecisionRuntimeRecord {
  return {
    runtime: "deterministic",
    role,
    author: "deterministic_fallback",
    attempted_runtimes: [{ runtime: "deterministic", status: "success" }],
    ...(warnings.length > 0 ? { fallback_warnings: warnings } : {}),
  };
}

/**
 * Provenance record for selects/blueprints authored by a human editor or an
 * agent evidence-synthesis pass (no LLM triage ran). This must never be
 * represented as an LLM success.
 */
export function nonLlmDecisionRuntime(
  role: string,
  author: Extract<DecisionAuthor, "human" | "agent_evidence_synthesis">,
  note?: string,
): DecisionRuntimeRecord {
  return {
    runtime: author === "human" ? "human" : "agent_evidence_synthesis",
    role,
    author,
    attempted_runtimes: [
      {
        // Attempt entries are typed as concrete LLM runtimes; the non-LLM
        // authorship lives on `author` above.
        runtime: "deterministic",
        status: "skipped",
        message:
          note ??
          (author === "human"
            ? "decision authored by a human editor; no LLM triage ran"
            : "decision synthesized from agent evidence; no LLM triage ran"),
      },
    ],
  };
}

export function injectedDecisionRuntime(role: string): DecisionRuntimeRecord {
  return {
    runtime: "injected",
    role,
    attempted_runtimes: [{ runtime: "deterministic", status: "skipped", message: "injected test/runtime completer" }],
  };
}

export async function complete(
  request: EditorialLlmRequest,
  opts: EditorialLlmConnectorOptions = {},
): Promise<EditorialLlmCompletion> {
  const env = opts.env ?? process.env;
  const commandExists = opts.commandExists ?? defaultCommandExists;
  const executor = opts.executor ?? defaultExecutor;
  const timeoutMs = configuredTimeoutMs(request, env);
  const runtimes = runtimeChain(requestedRuntime(opts, env), commandExists, env);
  const deadline = new StageDeadline(configuredStageTimeoutMs(opts, env));
  const warnings: string[] = [];
  const attempts: EditorialLlmAttempt[] = [];

  for (const runtime of runtimes) {
    if (runtime === "deterministic") {
      attempts.push({ runtime, status: "success" });
      return { text: "{}", runtime, warnings, attempts };
    }
    if (deadline.exhausted) {
      const warning = `${runtime}: stage deadline exhausted; skipping live runtime`;
      warnings.push(warning);
      opts.warn?.(`[editorial-llm] ${warning}`);
      attempts.push({ runtime, status: "skipped", message: warning, error_kind: "transport_timeout" });
      continue;
    }
    try {
      const text = await invokeRuntime(runtime, request, {
        executor,
        opts,
        timeoutMs: deadline.budgetForCall(timeoutMs),
      }).then((invocation) => invocation.text);
      attempts.push({ runtime, status: "success" });
      return { text, runtime, warnings, attempts };
    } catch (error) {
      const warning = warningFor(runtime, error);
      warnings.push(warning);
      attempts.push({ runtime, status: "failed", message: warning, error_kind: classifyTransportError(error) });
      opts.warn?.(`[editorial-llm] ${warning}`);
    }
  }

  attempts.push({ runtime: "deterministic", status: "success" });
  return { text: "{}", runtime: "deterministic", warnings, attempts };
}

function defaultRepairPrompt(originalPrompt: string, raw: string, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return [
    originalPrompt,
    "",
    "The previous response did not satisfy the required JSON contract.",
    `Schema/parse error: ${message}`,
    `Previous response excerpt: ${raw.slice(0, 1200)}`,
    "Return JSON only. No prose, no markdown fences.",
  ].join("\n");
}

function validateParsed(
  parsed: Record<string, unknown>,
  validateJson: ((parsed: Record<string, unknown>) => void) | undefined,
): void {
  if (validateJson) validateJson(parsed);
}

interface RuntimeInvocation {
  text: string;
}

async function invokeRuntime(
  runtime: EditorialLlmLiveRuntime,
  request: EditorialLlmRequest,
  deps: {
    executor: EditorialLlmExecutor;
    opts: EditorialLlmConnectorOptions;
    timeoutMs: number;
  },
): Promise<RuntimeInvocation> {
  const text = runtime === "codex_exec"
    ? await runCodexExec(request, deps.executor, deps.timeoutMs)
    : runtime === "claude_cli"
      ? await runClaudeCli(request, deps.executor, deps.timeoutMs)
      : await runGemini(request, deps.opts, deps.timeoutMs);
  return { text };
}

/**
 * Parse + validate a runtime response, classifying failures as
 * json_parse or schema_validation (the only repair-retryable kinds).
 */
function parseAndValidate(
  text: string,
  deps: {
    parseJson: (text: string) => Record<string, unknown>;
    validateJson?: (parsed: Record<string, unknown>) => void;
  },
): Record<string, unknown> {
  let parsed: Record<string, unknown>;
  try {
    parsed = deps.parseJson(text);
  } catch (error) {
    throw new EditorialLlmError(
      "json_parse",
      `JSON parse failed: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  try {
    validateParsed(parsed, deps.validateJson);
  } catch (error) {
    throw new EditorialLlmError(
      "schema_validation",
      `Schema validation failed: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  return parsed;
}

export async function completeEditorialJson(
  request: CompleteEditorialJsonRequest,
  opts: EditorialLlmConnectorOptions = {},
): Promise<EditorialLlmJsonCompletion> {
  const env = opts.env ?? process.env;
  const commandExists = opts.commandExists ?? defaultCommandExists;
  const timeoutMs = configuredTimeoutMs(request, env);
  const runtimes = runtimeChain(requestedRuntime(opts, env), commandExists, env);
  const executor = opts.executor ?? defaultExecutor;
  const parseJson = request.parseJson ?? parseLlmResponse;
  const repairPrompt = request.repairPrompt ?? defaultRepairPrompt;
  const deadline = new StageDeadline(configuredStageTimeoutMs(opts, env));
  const journal = journalFor(opts);
  const mode: "text" | "multimodal" = (request.images?.length ?? 0) > 0 ? "multimodal" : "text";
  const warnings: string[] = [];
  const attempts: EditorialLlmAttempt[] = [];

  const startJournalEntry = (
    runtime: EditorialLlmConcreteRuntime,
    retryIndex: number,
  ): string | undefined => journal?.start({
    role: request.role,
    mode,
    transport_runtime: runtime,
    retry_index: retryIndex,
    ...providerModelForRuntime(runtime, opts, env),
  });

  const finishJournalEntry = (
    attemptId: string | undefined,
    status: "success" | "failed" | "skipped",
    update?: { errorKind?: EditorialLlmErrorKind; note?: string },
  ): void => {
    if (!journal || !attemptId) return;
    journal.finish(attemptId, { status, ...update });
  };

  /** Deterministic terminal state: journal it when live runtimes fell back. */
  const deterministicResult = (): EditorialLlmJsonCompletion => {
    if (journal && warnings.length > 0) {
      const fallbackId = startJournalEntry("deterministic", 0);
      finishJournalEntry(fallbackId, "success", {
        note: `deterministic fallback: ${warnings.length} live attempt(s) failed or were skipped`,
      });
    }
    attempts.push({ runtime: "deterministic", status: "success" });
    return { text: "{}", runtime: "deterministic", warnings, attempts, parsed: {} };
  };

  for (const runtime of runtimes) {
    if (runtime === "deterministic") {
      return deterministicResult();
    }

    // The remaining stage budget is handed to each runtime as its invocation
    // timeout; once exhausted, stop waking live runtimes entirely.
    if (deadline.exhausted) {
      const warning = `${runtime}: stage deadline exhausted after ${warnings.length} failed attempt(s); skipping live runtime`;
      warnings.push(warning);
      opts.warn?.(`[editorial-llm] ${warning}`);
      attempts.push({
        runtime,
        status: "skipped",
        message: warning,
        error_kind: "transport_timeout",
      });
      const skippedId = startJournalEntry(runtime, 0);
      finishJournalEntry(skippedId, "skipped", { note: warning });
      continue;
    }
    const callBudgetMs = deadline.budgetForCall(timeoutMs);
    const firstAttemptId = startJournalEntry(runtime, 0);

    let firstText = "";
    try {
      firstText = (await invokeRuntime(runtime, request, { executor, opts, timeoutMs: callBudgetMs })).text;
    } catch (transportError) {
      // Transport-phase failure (spawn, exit, timeout). The model never saw a
      // contract violation, so a JSON repair retry on the same runtime cannot
      // help — fall through to the next runtime instead.
      const kind = classifyTransportError(transportError);
      const warning = warningFor(runtime, transportError, kind);
      warnings.push(warning);
      attempts.push({ runtime, status: "failed", message: warning, error_kind: kind });
      opts.warn?.(`[editorial-llm] ${warning}`);
      finishJournalEntry(firstAttemptId, "failed", { errorKind: kind, note: warning });
      continue;
    }

    let firstParsed: Record<string, unknown>;
    try {
      firstParsed = parseAndValidate(firstText, { parseJson, validateJson: request.validateJson });
    } catch (contractError) {
      const kind = contractError instanceof EditorialLlmError ? contractError.kind : "json_parse";
      const firstWarning = warningFor(runtime, contractError, kind);
      warnings.push(firstWarning);
      opts.warn?.(`[editorial-llm] ${firstWarning}`);
      finishJournalEntry(firstAttemptId, "failed", { errorKind: kind, note: firstWarning });

      // Contract failures are the only repair-retryable kind; the retry is
      // bounded by whatever stage budget remains. A repair is a new call, so
      // it must never start once the stage deadline is exhausted.
      if (deadline.exhausted) {
        const warning = `${runtime}: stage deadline exhausted; skipping JSON repair retry`;
        warnings.push(warning);
        opts.warn?.(`[editorial-llm] ${warning}`);
        const skippedRetryId = startJournalEntry(runtime, 1);
        finishJournalEntry(skippedRetryId, "skipped", { errorKind: "transport_timeout", note: warning });
        attempts.push({
          runtime,
          status: "skipped",
          message: warning,
          error_kind: "transport_timeout",
        });
        continue;
      }
      const retryRequest = {
        ...request,
        prompt: repairPrompt(request.prompt, firstText, contractError),
      };
      const retryBudgetMs = deadline.budgetForCall(timeoutMs);
      const retryAttemptId = startJournalEntry(runtime, 1);
      let retryOutcome: { ok: true; text: string; parsed: Record<string, unknown> } | {
        ok: false;
        kind: EditorialLlmErrorKind;
        warning: string;
      };
      try {
        const retryText = (
          await invokeRuntime(runtime, retryRequest, { executor, opts, timeoutMs: retryBudgetMs })
        ).text;
        try {
          const parsed = parseAndValidate(retryText, { parseJson, validateJson: request.validateJson });
          retryOutcome = { ok: true, text: retryText, parsed };
        } catch (retryContractError) {
          const retryKind = retryContractError instanceof EditorialLlmError
            ? retryContractError.kind
            : "json_parse";
          retryOutcome = {
            ok: false,
            kind: retryKind,
            warning: warningFor(runtime, retryContractError, retryKind),
          };
        }
      } catch (retryTransportError) {
        retryOutcome = {
          ok: false,
          kind: classifyTransportError(retryTransportError),
          warning: warningFor(runtime, retryTransportError, classifyTransportError(retryTransportError)),
        };
      }

      if (retryOutcome.ok) {
        attempts.push({
          runtime,
          status: "success",
          message: "succeeded after one JSON repair retry",
        });
        finishJournalEntry(retryAttemptId, "success", { note: "succeeded after one JSON repair retry" });
        return { text: retryOutcome.text, runtime, warnings, attempts, parsed: retryOutcome.parsed };
      }
      warnings.push(retryOutcome.warning);
      attempts.push({ runtime, status: "failed", message: retryOutcome.warning, error_kind: retryOutcome.kind });
      opts.warn?.(`[editorial-llm] ${retryOutcome.warning}`);
      finishJournalEntry(retryAttemptId, "failed", { errorKind: retryOutcome.kind, note: retryOutcome.warning });
      continue;
    }

    finishJournalEntry(firstAttemptId, "success");
    attempts.push({ runtime, status: "success" });
    return { text: firstText, runtime, warnings, attempts, parsed: firstParsed };
  }

  return deterministicResult();
}
