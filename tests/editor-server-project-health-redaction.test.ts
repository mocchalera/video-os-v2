import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  launchEditorServer,
  stopAllEditorServers,
} from "./helpers/editor-server-test-rig.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await stopAllEditorServers();
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

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

    const server = await launchEditorServer({ projectsDir });

    const projects = await server.waitForJson("/api/projects");
    const health = await server.waitForJson("/api/health");

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
