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
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
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

async function waitForResponse(url: string): Promise<Response> {
  const deadline = Date.now() + 10_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      return await fetch(url);
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw lastError;
}

function expectNoCapabilityPathLeak(value: unknown, forbiddenPrefixes: string[]): void {
  const visit = (current: unknown): void => {
    if (Array.isArray(current)) {
      current.forEach(visit);
      return;
    }
    if (current && typeof current === "object") {
      for (const [key, nested] of Object.entries(current)) {
        expect(["local_source_path", "link_path", "source_locator"]).not.toContain(key);
        visit(nested);
      }
      return;
    }
    if (typeof current !== "string") return;
    if (!current.startsWith("/api/")) {
      expect(path.posix.isAbsolute(current)).toBe(false);
      expect(path.win32.isAbsolute(current)).toBe(false);
    }
    for (const prefix of forbiddenPrefixes) expect(current).not.toContain(prefix);
  };
  visit(value);
}

describe("editor server source-map route redaction", () => {
  it("returns stable metadata and media URLs without capability paths", async () => {
    const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "editor-source-map-route-"));
    tempDirs.push(fixtureRoot);
    const projectsDir = path.join(fixtureRoot, "projects");
    const projectDir = path.join(projectsDir, "source-map-project");
    const mediaDir = path.join(projectDir, "02_media");
    fs.mkdirSync(mediaDir, { recursive: true });
    fs.writeFileSync(path.join(mediaDir, "source_map.json"), JSON.stringify({
      version: "1",
      items: [{
        asset_id: "AST_001",
        filename: "clip.mov",
        duration_us: 1_000_000,
        local_source_path: path.join(fixtureRoot, "private", "clip.mov"),
        link_path: "02_media/clip.mov",
        source_locator: `file://${path.join(fixtureRoot, "private", "clip.mov")}`,
      }],
    }));
    fs.mkdirSync(path.join(projectsDir, "missing-map"), { recursive: true });

    const port = await reservePort();
    const child = spawn(
      process.execPath,
      ["--import", "tsx", "editor/server/index.ts", "--project", projectsDir, "--port", String(port)],
      { cwd: repoRoot, stdio: "ignore" },
    );
    children.push(child);

    const success = await waitForResponse(`http://127.0.0.1:${port}/api/projects/source-map-project/source-map`);
    expect(success.status).toBe(200);
    const payload = await success.json();
    expect(payload).toEqual({
      version: "1",
      items: [{ asset_id: "AST_001", filename: "clip.mov", duration_us: 1_000_000 }],
      assets: {
        AST_001: {
          media_id: "media_AST_001",
          playback_strategy: {
            kind: "direct",
            url: "/api/projects/source-map-project/media/by-asset/AST_001",
          },
        },
      },
    });
    expectNoCapabilityPathLeak(payload, [fixtureRoot, projectsDir, projectDir, "/Users/", "/home/"]);

    const invalid = await waitForResponse(`http://127.0.0.1:${port}/api/projects/bad%5Cid/source-map`);
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toEqual({ error: "Invalid project ID" });

    const missing = await waitForResponse(`http://127.0.0.1:${port}/api/projects/missing-map/source-map`);
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: "Source map not found" });
  });
});
