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
}

export interface DecisionRuntimeRecord {
  runtime: string;
  role: string;
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
  options: { retryLabel: string; maxOutputTokens: number; temperature?: number },
) => Promise<string>;
export type GeminiMultimodalCompleter = (
  prompt: string,
  images: GeminiMultimodalImageInput[],
  model: string,
  options: { retryLabel: string; maxOutputTokens: number; temperature?: number },
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
}

interface EditorialLlmDefaults {
  runtime: EditorialLlmRuntime;
  timeoutMs: number;
}

const DEFAULT_TIMEOUT_MS = 180_000;
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
    return {
      runtime,
      timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.trunc(timeoutMs) : DEFAULT_TIMEOUT_MS,
    };
  } catch {
    return { runtime: "auto", timeoutMs: DEFAULT_TIMEOUT_MS };
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

function defaultExecutor(input: EditorialLlmExecutorInput): Promise<EditorialLlmExecutorResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(input.command, input.args, {
      cwd: input.cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`${input.command} timed out after ${input.timeoutMs}ms`));
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
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      reject(new Error(`${input.command} exited with ${code}: ${stderr.trim() || stdout.trim()}`));
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
): Promise<string> {
  const env = opts.env ?? process.env;
  const model = opts.geminiModel
    ?? env.EDITORIAL_LLM_GEMINI_MODEL
    ?? env.UNIFIED_EDITORIAL_MODEL
    ?? env.BLUEPRINT_MODEL
    ?? env.TRIAGE_MODEL
    ?? DEFAULT_GEMINI_MODEL;
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
    },
  );
}

function warningFor(runtime: string, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return `${runtime}: ${message}`;
}

export function decisionRuntimeRecord(
  completion: Pick<EditorialLlmCompletion, "runtime" | "warnings" | "attempts">,
  role: string,
): DecisionRuntimeRecord {
  return {
    runtime: completion.runtime,
    role,
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
    attempted_runtimes: [{ runtime: "deterministic", status: "success" }],
    ...(warnings.length > 0 ? { fallback_warnings: warnings } : {}),
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
  const warnings: string[] = [];
  const attempts: EditorialLlmAttempt[] = [];

  for (const runtime of runtimes) {
    if (runtime === "deterministic") {
      attempts.push({ runtime, status: "success" });
      return { text: "{}", runtime, warnings, attempts };
    }
    try {
      const text = runtime === "codex_exec"
        ? await runCodexExec(request, executor, timeoutMs)
        : runtime === "claude_cli"
          ? await runClaudeCli(request, executor, timeoutMs)
          : await runGemini(request, opts);
      attempts.push({ runtime, status: "success" });
      return { text, runtime, warnings, attempts };
    } catch (error) {
      const warning = warningFor(runtime, error);
      warnings.push(warning);
      attempts.push({ runtime, status: "failed", message: warning });
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
  const warnings: string[] = [];
  const attempts: EditorialLlmAttempt[] = [];

  for (const runtime of runtimes) {
    if (runtime === "deterministic") {
      attempts.push({ runtime, status: "success" });
      return { text: "{}", runtime, warnings, attempts, parsed: {} };
    }

    let firstText = "";
    try {
      firstText = runtime === "codex_exec"
        ? await runCodexExec(request, executor, timeoutMs)
        : runtime === "claude_cli"
          ? await runClaudeCli(request, executor, timeoutMs)
          : await runGemini(request, opts);
      const parsed = parseJson(firstText);
      validateParsed(parsed, request.validateJson);
      attempts.push({ runtime, status: "success" });
      return { text: firstText, runtime, warnings, attempts, parsed };
    } catch (firstError) {
      const firstWarning = warningFor(runtime, firstError);
      warnings.push(firstWarning);
      opts.warn?.(`[editorial-llm] ${firstWarning}`);
      try {
        const retryRequest = {
          ...request,
          prompt: repairPrompt(request.prompt, firstText, firstError),
        };
        const retryText = runtime === "codex_exec"
          ? await runCodexExec(retryRequest, executor, timeoutMs)
          : runtime === "claude_cli"
            ? await runClaudeCli(retryRequest, executor, timeoutMs)
            : await runGemini(retryRequest, opts);
        const parsed = parseJson(retryText);
        validateParsed(parsed, request.validateJson);
        attempts.push({
          runtime,
          status: "success",
          message: "succeeded after one JSON repair retry",
        });
        return { text: retryText, runtime, warnings, attempts, parsed };
      } catch (secondError) {
        const secondWarning = warningFor(runtime, secondError);
        warnings.push(secondWarning);
        attempts.push({ runtime, status: "failed", message: secondWarning });
        opts.warn?.(`[editorial-llm] ${secondWarning}`);
      }
    }
  }

  attempts.push({ runtime: "deterministic", status: "success" });
  return { text: "{}", runtime: "deterministic", warnings, attempts, parsed: {} };
}
