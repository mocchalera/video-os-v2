import { afterEach, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";

const repoRoot = path.resolve(".");
const children: ChildProcess[] = [];
const tempDirs: string[] = [];

afterEach(() => {
  for (const child of children.splice(0)) child.kill("SIGTERM");
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

async function reservePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Failed to reserve port");
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

async function waitForJson(url: string): Promise<unknown> {
  const deadline = Date.now() + 10_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return await response.json();
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw lastError;
}

function expectNoLocalPathLeak(value: unknown, forbiddenPrefixes: string[]): void {
  const visit = (current: unknown): void => {
    if (Array.isArray(current)) {
      current.forEach(visit);
      return;
    }
    if (current && typeof current === "object") {
      for (const [key, nested] of Object.entries(current)) {
        expect(["path", "projectsDir"]).not.toContain(key);
        visit(nested);
      }
      return;
    }
    if (typeof current !== "string") return;

    expect(path.posix.isAbsolute(current)).toBe(false);
    expect(path.win32.isAbsolute(current)).toBe(false);
    for (const prefix of forbiddenPrefixes) expect(current).not.toContain(prefix);
  };

  visit(value);
}

describe("editor server project and health path redaction", () => {
  it("preserves public fields without recursively leaking local paths", async () => {
    const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "editor-server-redaction-"));
    tempDirs.push(fixtureRoot);
    const projectsDir = path.join(fixtureRoot, "projects");
    const projectDir = path.join(projectsDir, "timeline-project");
    fs.mkdirSync(path.join(projectDir, "05_timeline"), { recursive: true });
    fs.writeFileSync(path.join(projectDir, "05_timeline", "timeline.json"), "{}\n");
    fs.mkdirSync(path.join(projectsDir, "not-a-project"), { recursive: true });

    const port = await reservePort();
    const child = spawn(
      process.execPath,
      ["--import", "tsx", "editor/server/index.ts", "--project", projectsDir, "--port", String(port)],
      { cwd: repoRoot, stdio: "ignore" },
    );
    children.push(child);

    const projects = await waitForJson(`http://127.0.0.1:${port}/api/projects`);
    const health = await waitForJson(`http://127.0.0.1:${port}/api/health`);

    expect(projects).toEqual({
      projects: [{ id: "timeline-project", name: "timeline-project", hasTimeline: true }],
    });
    expect(health).toMatchObject({ status: "ok", timestamp: expect.any(String) });
    expect(Number.isNaN(Date.parse((health as { timestamp: string }).timestamp))).toBe(false);

    const forbiddenPrefixes = [
      path.resolve("."),
      projectsDir,
      projectDir,
      fixtureRoot,
      "/Users/",
      "/home/",
    ];
    expectNoLocalPathLeak(projects, forbiddenPrefixes);
    expectNoLocalPathLeak(health, forbiddenPrefixes);
  });
});
