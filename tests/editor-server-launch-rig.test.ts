import { afterEach, describe, expect, it } from "vitest";
import * as http from "node:http";
import type { AddressInfo, Socket } from "node:net";
import {
  EDITOR_SERVER_READINESS_TIMEOUT_MS,
  EditorServerDiagnosticError,
  pollHttp,
  startCapturedProcess,
  stopAllEditorServers,
  stopEditorServer,
  type EditorServerDiagnosticKind,
} from "./helpers/editor-server-test-rig.js";

afterEach(async () => {
  await stopAllEditorServers();
});

async function captureReject(run: () => Promise<unknown>): Promise<EditorServerDiagnosticError> {
  try {
    await run();
  } catch (error) {
    if (error instanceof EditorServerDiagnosticError) return error;
    throw error;
  }
  throw new Error("Expected the polled call to reject with an EditorServerDiagnosticError");
}

function expectKind(error: EditorServerDiagnosticError, kind: EditorServerDiagnosticKind): void {
  expect(error.kind, error.message).toBe(kind);
}

interface LocalHttpFixture {
  url: string;
  close(): Promise<void>;
}

/**
 * Self-contained in-process HTTP fixture (no editor server, no editor
 * dependencies) so this negative-coverage file is safe in the root-only CI
 * job as well.
 */
async function startLocalHttpFixture(
  handler: (request: http.IncomingMessage, response: http.ServerResponse) => void,
): Promise<LocalHttpFixture> {
  const sockets = new Set<Socket>();
  const server = http.createServer(handler);
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}

describe("editor server launch rig diagnostics", () => {
  it("classifies early nonzero exit quickly and surfaces the captured process stderr", async () => {
    const captured = startCapturedProcess(process.execPath, [
      "-e",
      "console.error('Projects directory not found'); process.exit(1);",
    ]);
    try {
      const startedAt = Date.now();
      const error = await captureReject(() =>
        pollHttp({
          url: "http://127.0.0.1:1/api/projects",
          process: captured,
          mode: "ok-json",
        }),
      );
      const elapsedMs = Date.now() - startedAt;

      expectKind(error, "early-exit");
      expect(error.exitCode).toBe(1);
      expect(error.stderrTail).toContain("Projects directory not found");
      expect(elapsedMs).toBeLessThan(EDITOR_SERVER_READINESS_TIMEOUT_MS);
    } finally {
      await stopEditorServer(captured);
    }
  }, 9_000);

  it("classifies spawn errors instead of polling the full deadline", async () => {
    const captured = startCapturedProcess("/nonexistent/editor-rig-binary", []);
    try {
      const error = await captureReject(() =>
        pollHttp({ url: "http://127.0.0.1:1/api/health", process: captured, mode: "response", timeoutMs: 2_000 }),
      );

      expectKind(error, "spawn-error");
      expect(error.message).toContain("failed to start");
    } finally {
      await stopEditorServer(captured);
    }
  }, 9_000);

  it("reports a readiness deadline strictly below the Vitest budget when nothing serves HTTP", async () => {
    const captured = startCapturedProcess(process.execPath, ["-e", "setInterval(() => {}, 250)"]);
    try {
      const startedAt = Date.now();
      const error = await captureReject(() =>
        pollHttp({
          url: "http://127.0.0.1:1/api/nothing",
          process: captured,
          mode: "response",
          timeoutMs: 800,
        }),
      );
      const elapsedMs = Date.now() - startedAt;

      expectKind(error, "readiness-deadline");
      expect(elapsedMs).toBeGreaterThanOrEqual(700);
      expect(elapsedMs).toBeLessThan(EDITOR_SERVER_READINESS_TIMEOUT_MS);
    } finally {
      await stopEditorServer(captured);
    }
  }, 9_000);

  it("fails fast on an unexpected HTTP status while waiting for a 2xx readiness response", async () => {
    const fixture = await startLocalHttpFixture((_request, response) => {
      response.statusCode = 404;
      response.end("no such route");
    });
    try {
      const startedAt = Date.now();
      const error = await captureReject(() => pollHttp({ url: `${fixture.url}/api/definitely-not-a-route`, mode: "ok-json" }));
      const elapsedMs = Date.now() - startedAt;

      expectKind(error, "unexpected-http-status");
      expect(error.lastHttpStatus).toBe(404);
      expect(elapsedMs).toBeLessThan(EDITOR_SERVER_READINESS_TIMEOUT_MS);
    } finally {
      await fixture.close();
    }
  }, 9_000);

  it("classifies stalled response bodies as a readiness deadline before the Vitest budget", async () => {
    // Sends 200 + partial JSON but never ends the body.
    const fixture = await startLocalHttpFixture((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.write("{");
    });
    try {
      const startedAt = Date.now();
      const error = await captureReject(() =>
        pollHttp({ url: `${fixture.url}/api/stalled`, mode: "ok-json", timeoutMs: 800 }),
      );
      const elapsedMs = Date.now() - startedAt;

      expectKind(error, "readiness-deadline");
      expect(error.message).toContain("stalled HTTP I/O");
      expect(elapsedMs).toBeGreaterThanOrEqual(700);
      expect(elapsedMs).toBeLessThan(EDITOR_SERVER_READINESS_TIMEOUT_MS);
    } finally {
      await fixture.close();
    }
  }, 9_000);

  it("awaits bounded SIGTERM termination and escalates to SIGKILL only when needed", async () => {
    const wellBehaved = startCapturedProcess(process.execPath, ["-e", "setInterval(() => {}, 250)"]);
    let stubborn: ReturnType<typeof startCapturedProcess> | undefined;
    try {
      await stopEditorServer(wellBehaved);
      expect(isTerminated(wellBehaved)).toBe(true);

      stubborn = startCapturedProcess(process.execPath, [
        "-e",
        "process.on('SIGTERM', () => {}); setInterval(() => {}, 250)",
      ]);
      await new Promise((resolve) => setTimeout(resolve, 150));
      await stopEditorServer(stubborn);
      expect(stubborn.child.signalCode === "SIGKILL" || stubborn.child.exitCode !== null).toBe(true);
    } finally {
      await stopAllEditorServers();
    }
  }, 9_000);
});

function isTerminated(handle: { child: { exitCode: number | null; signalCode: string | null } }): boolean {
  return handle.child.exitCode !== null || handle.child.signalCode !== null;
}
