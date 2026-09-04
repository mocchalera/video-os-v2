import { spawn, type ChildProcess } from "node:child_process";
import * as net from "node:net";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Test-only launch/readiness/cleanup rig for the editor-server HTTP boundary
 * tests. Used exclusively by:
 *   - tests/editor-server-project-health-redaction.test.ts
 *   - tests/editor-server-source-map-route-redaction.test.ts
 *   - tests/editor-server-hook-lock.test.ts
 *
 * Contract (Issue #24 M1):
 *   - Captures bounded stdout/stderr tails instead of discarding them.
 *   - Fails fast with stable, differentiated diagnostics:
 *       spawn-error | early-exit | readiness-deadline | unexpected-http-status
 *   - Readiness deadline stays strictly below the unchanged Vitest 10s budget.
 *   - Cleanup awaits child termination (bounded SIGTERM, then SIGKILL only if
 *     needed) so fixtures are only removed after children are down.
 */

export const EDITOR_SERVER_READINESS_TIMEOUT_MS = 5_000;
const POLL_INTERVAL_MS = 50;
const TERMINATE_GRACE_MS = 3_000;
const KILL_GRACE_MS = 1_000;
const MAX_CAPTURED_BYTES = 16 * 1024;

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

export type EditorServerDiagnosticKind =
  | "spawn-error"
  | "early-exit"
  | "readiness-deadline"
  | "unexpected-http-status";

export interface EditorServerDiagnosticDetails {
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  lastHttpStatus?: number;
  lastErrorMessage?: string;
  stdoutTail?: string;
  stderrTail?: string;
}

export class EditorServerDiagnosticError extends Error {
  readonly kind: EditorServerDiagnosticKind;
  readonly exitCode?: number | null;
  readonly signal?: NodeJS.Signals | null;
  readonly lastHttpStatus?: number;
  readonly stdoutTail: string;
  readonly stderrTail: string;

  constructor(
    kind: EditorServerDiagnosticKind,
    message: string,
    details: EditorServerDiagnosticDetails = {},
  ) {
    const sections = [message];
    if (details.exitCode !== undefined || details.signal !== undefined) {
      sections.push(`exit_code=${details.exitCode ?? "null"} signal=${details.signal ?? "null"}`);
    }
    if (details.lastHttpStatus !== undefined) {
      sections.push(`last_http_status=${details.lastHttpStatus}`);
    }
    if (details.lastErrorMessage) {
      sections.push(`last_error=${details.lastErrorMessage}`);
    }
    if (details.stdoutTail) sections.push(`stdout tail:\n${details.stdoutTail}`);
    if (details.stderrTail) sections.push(`stderr tail:\n${details.stderrTail}`);
    super(`[editor-server-test-rig:${kind}] ${sections.join(" | ")}`);
    this.name = "EditorServerDiagnosticError";
    this.kind = kind;
    this.exitCode = details.exitCode;
    this.signal = details.signal;
    this.lastHttpStatus = details.lastHttpStatus;
    this.stdoutTail = details.stdoutTail ?? "";
    this.stderrTail = details.stderrTail ?? "";
  }
}

class BoundedTail {
  private chunks: string[] = [];
  private size = 0;

  push(chunk: Buffer | string): void {
    const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
    this.chunks.push(text);
    this.size += text.length;
    while (this.size > MAX_CAPTURED_BYTES && this.chunks.length > 1) {
      const dropped = this.chunks.shift();
      if (dropped === undefined) break;
      this.size -= dropped.length;
    }
    if (this.size > MAX_CAPTURED_BYTES && this.chunks.length > 0) {
      const only = this.chunks[0];
      this.chunks = [only.slice(only.length - MAX_CAPTURED_BYTES)];
      this.size = this.chunks[0].length;
    }
  }

  tail(): string {
    return this.chunks.join("").slice(-MAX_CAPTURED_BYTES);
  }
}

export interface ProcessFailureSnapshot {
  kind: "spawn-error" | "early-exit";
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  errorMessage?: string;
  stdoutTail?: string;
  stderrTail?: string;
}

export interface CapturedProcess {
  child: ChildProcess;
  stdoutTail(): string;
  stderrTail(): string;
  /** Classified terminal failure observed so far, if any. */
  failure(): ProcessFailureSnapshot | null;
}

export function startCapturedProcess(
  command: string,
  args: string[],
  options: { cwd?: string } = {},
): CapturedProcess {
  const stdout = new BoundedTail();
  const stderr = new BoundedTail();
  let spawnErrorMessage: string | undefined;
  let exitInfo: { code: number | null; signal: NodeJS.Signals | null } | undefined;

  const child = spawn(command, args, {
    cwd: options.cwd ?? repoRoot,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (chunk: Buffer | string) => stdout.push(chunk));
  child.stderr?.on("data", (chunk: Buffer | string) => stderr.push(chunk));
  child.on("error", (error) => {
    spawnErrorMessage = error instanceof Error ? error.message : String(error);
  });
  child.on("exit", (code, signal) => {
    exitInfo = { code, signal };
  });

  const handle: CapturedProcess = {
    child,
    stdoutTail: () => stdout.tail(),
    stderrTail: () => stderr.tail(),
    failure(): ProcessFailureSnapshot | null {
      if (spawnErrorMessage !== undefined) {
        return {
          kind: "spawn-error",
          errorMessage: spawnErrorMessage,
          stdoutTail: stdout.tail(),
          stderrTail: stderr.tail(),
        };
      }
      if (exitInfo !== undefined) {
        return {
          kind: "early-exit",
          exitCode: exitInfo.code,
          signal: exitInfo.signal,
          stdoutTail: stdout.tail(),
          stderrTail: stderr.tail(),
        };
      }
      return null;
    },
  };
  // Track every started process so afterEach/finally cleanup can stop them.
  managedProcesses.add(handle);
  return handle;
}

function isTerminated(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

function diagnosticFromFailure(
  failure: ProcessFailureSnapshot,
  context: string,
): EditorServerDiagnosticError {
  if (failure.kind === "spawn-error") {
    return new EditorServerDiagnosticError(
      "spawn-error",
      `${context}: child process failed to start (${failure.errorMessage ?? "unknown spawn error"})`,
      {
        lastErrorMessage: failure.errorMessage,
        stdoutTail: failure.stdoutTail,
        stderrTail: failure.stderrTail,
      },
    );
  }
  return new EditorServerDiagnosticError(
    "early-exit",
    `${context}: child exited before becoming ready`,
    {
      exitCode: failure.exitCode,
      signal: failure.signal,
      stdoutTail: failure.stdoutTail,
      stderrTail: failure.stderrTail,
    },
  );
}

/**
 * Races a body-read promise against the poll deadline's abort signal so a
 * stalled response body cannot outlive the readiness budget.
 */
async function readBodyWithDeadline<T>(bodyPromise: Promise<T>, signal: AbortSignal): Promise<T> {
  const stalled = new Promise<never>((_, reject) => {
    signal.addEventListener(
      "abort",
      () => reject(new DOMException("The HTTP body read was aborted at the readiness deadline.", "AbortError")),
      { once: true },
    );
  });
  return Promise.race([bodyPromise, stalled]);
}

export type HttpPollMode = "ok-json" | "response";

export interface HttpPollOptions {
  url: string;
  process?: CapturedProcess;
  init?: RequestInit;
  /**
   * "ok-json": resolve with the parsed JSON body of an HTTP 2xx response;
   * any completed non-2xx response fails fast as "unexpected-http-status".
   * "response": resolve with the Response as soon as its status is not in
   * retryStatuses (assertions own the status contract).
   */
  mode: HttpPollMode;
  retryStatuses?: number[];
  timeoutMs?: number;
  intervalMs?: number;
}

export async function pollHttp(options: HttpPollOptions): Promise<Response | unknown> {
  const timeoutMs = options.timeoutMs ?? EDITOR_SERVER_READINESS_TIMEOUT_MS;
  const intervalMs = options.intervalMs ?? POLL_INTERVAL_MS;
  const retryStatuses = new Set(options.retryStatuses ?? []);
  const startedAt = Date.now();
  let lastHttpStatus: number | undefined;
  let lastErrorMessage: string | undefined;

  const classifyTerminalFailure = (): EditorServerDiagnosticError | null => {
    const failure = options.process?.failure();
    if (!failure) return null;
    const error = diagnosticFromFailure(failure, `HTTP poll for ${options.url}`);
    return error;
  };

  while (Date.now() - startedAt < timeoutMs) {
    const terminal = classifyTerminalFailure();
    if (terminal) throw terminal;

    // Absolute deadline enforcement: the abort signal bounds both the fetch
    // headers and the response body consumption below.
    const remainingMs = Math.max(timeoutMs - (Date.now() - startedAt), 1);
    const controller = new AbortController();
    const abortTimer = setTimeout(() => controller.abort(), remainingMs);
    let response: Response | undefined;
    try {
      response = await fetch(options.url, { ...(options.init ?? {}), signal: controller.signal });
      lastHttpStatus = response.status;
      if (options.mode === "ok-json") {
        if (!response.ok) {
          const bodyText = await readBodyWithDeadline(response.text(), controller.signal);
          const bodySnippet = bodyText.slice(0, 512);
          throw new EditorServerDiagnosticError(
            "unexpected-http-status",
            `HTTP ${response.status} from ${options.url} while waiting for a 2xx readiness response: ${bodySnippet}`,
            {
              lastHttpStatus: response.status,
              stdoutTail: options.process?.stdoutTail(),
              stderrTail: options.process?.stderrTail(),
            },
          );
        }
        return await readBodyWithDeadline(response.json(), controller.signal);
      }
      if (!retryStatuses.has(response.status)) {
        return response;
      }
    } catch (error) {
      if (error instanceof EditorServerDiagnosticError) throw error;
      if (controller.signal.aborted) {
        lastErrorMessage = `stalled HTTP I/O aborted at the readiness deadline after ${remainingMs}ms`;
        try {
          await response?.body?.cancel();
        } catch {
          // best-effort cleanup of a hung body stream
        }
      } else {
        lastErrorMessage = error instanceof Error ? error.message : String(error);
      }
    } finally {
      clearTimeout(abortTimer);
    }

    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  const terminal = classifyTerminalFailure();
  if (terminal) throw terminal;

  throw new EditorServerDiagnosticError(
    "readiness-deadline",
    `readiness deadline of ${timeoutMs}ms exceeded for ${options.url}`,
    {
      lastHttpStatus,
      lastErrorMessage,
      stdoutTail: options.process?.stdoutTail(),
      stderrTail: options.process?.stderrTail(),
    },
  );
}

async function reservePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Failed to reserve port");
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}

export interface EditorServerLaunchOptions {
  projectsDir: string;
  port?: number;
}

export interface EditorServerHandle extends CapturedProcess {
  port: number;
  waitForJson(pathOrUrl: string): Promise<unknown>;
  waitForResponse(
    pathOrUrl: string,
    options?: { init?: RequestInit; retryStatuses?: number[]; timeoutMs?: number },
  ): Promise<Response>;
}

const managedProcesses = new Set<CapturedProcess>();

export async function launchEditorServer(
  options: EditorServerLaunchOptions,
): Promise<EditorServerHandle> {
  const port = options.port ?? (await reservePort());
  const handle = startCapturedProcess(process.execPath, [
    "--import",
    "tsx",
    "editor/server/index.ts",
    "--project",
    options.projectsDir,
    "--port",
    String(port),
  ]);
  managedProcesses.add(handle);

  const toUrl = (pathOrUrl: string): string =>
    /^https?:\/\//.test(pathOrUrl) ? pathOrUrl : `http://127.0.0.1:${port}${pathOrUrl}`;

  return {
    ...handle,
    port,
    waitForJson(pathOrUrl: string): Promise<unknown> {
      return pollHttp({
        url: toUrl(pathOrUrl),
        process: handle,
        mode: "ok-json",
      });
    },
    waitForResponse(
      pathOrUrl: string,
      pollOptions: { init?: RequestInit; retryStatuses?: number[]; timeoutMs?: number } = {},
    ): Promise<Response> {
      return pollHttp({
        url: toUrl(pathOrUrl),
        process: handle,
        mode: "response",
        init: pollOptions.init,
        retryStatuses: pollOptions.retryStatuses,
        timeoutMs: pollOptions.timeoutMs,
      }) as Promise<Response>;
    },
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Awaits child termination: bounded SIGTERM grace first, escalating to
 * SIGKILL only if the child is still alive after the grace window. Throws if
 * termination is still unconfirmed after SIGKILL, so callers never proceed to
 * fixture deletion with a live child. Safe to call multiple times.
 */
export async function stopEditorServer(target: CapturedProcess | undefined): Promise<void> {
  if (!target) return;
  const child = target.child;
  // A handle whose spawn itself failed can never terminate; nothing to await.
  if (isTerminated(child) || target.failure()?.kind === "spawn-error") return;

  const exited = new Promise<NodeJS.Signals | number | null>((resolve) => {
    child.once("exit", (code, signal) => resolve(signal ?? code));
  });

  child.kill("SIGTERM");
  let outcome = await Promise.race([exited, sleep(TERMINATE_GRACE_MS).then(() => "timeout" as const)]);
  if (outcome === "timeout" && !isTerminated(child)) {
    child.kill("SIGKILL");
    outcome = await Promise.race([exited, sleep(KILL_GRACE_MS).then(() => "timeout" as const)]);
  }
  if (outcome === "timeout" && !isTerminated(child)) {
    throw new Error(
      `[editor-server-test-rig] child pid=${child.pid ?? "unknown"} (${child.spawnfile}) did not terminate after SIGTERM (${TERMINATE_GRACE_MS}ms) and SIGKILL (${KILL_GRACE_MS}ms); refusing to report cleanup success`,
    );
  }
}

/** Stops every editor server launched by this worker, in launch order. */
export async function stopAllEditorServers(): Promise<void> {
  for (const handle of [...managedProcesses]) {
    await stopEditorServer(handle);
  }
  managedProcesses.clear();
}
