import { afterAll, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

import { parse as parseYaml } from "yaml";
import { initProject, parseArgs as parseInitArgs } from "../scripts/init-project.js";
import {
  formatStatusResult,
  parseArgs as parseStatusArgs,
} from "../scripts/status.js";
import { runStatus } from "../runtime/commands/status.js";

const tempDirs: string[] = [];

afterAll(() => {
  for (const dir of tempDirs) {
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

function createTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(path.resolve("tests"), prefix));
  tempDirs.push(dir);
  return dir;
}

function copyDirSync(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirSync(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

describe("init-project CLI", () => {
  it("parses --source-dir", () => {
    const parsed = parseInitArgs([
      "node",
      "scripts/init-project.ts",
      "my-project",
      "--source-dir",
      "/tmp/footage",
    ]);

    expect(parsed).toEqual({
      projectId: "my-project",
      sourceDir: "/tmp/footage",
    });
  });

  it("copies the template, fills project ids, and creates a source symlink", () => {
    const workspace = createTempDir("tmp-init-project-");
    const projectsDir = path.join(workspace, "projects");
    const sourceDir = path.join(workspace, "footage");
    fs.mkdirSync(projectsDir, { recursive: true });
    fs.mkdirSync(sourceDir, { recursive: true });
    fs.writeFileSync(path.join(sourceDir, "clip.mov"), "stub", "utf-8");

    const result = initProject("onboarding-smoke", {
      projectsDir,
      templateDir: path.resolve("projects/_template"),
      sourceDir,
    });

    expect(result.projectDir).toBe(path.join(projectsDir, "onboarding-smoke"));
    expect(fs.existsSync(path.join(result.projectDir, "02_media"))).toBe(true);
    expect(fs.existsSync(path.join(result.projectDir, "03_analysis"))).toBe(true);
    expect(fs.existsSync(path.join(result.projectDir, "07_export"))).toBe(true);
    expect(fs.existsSync(path.join(result.projectDir, "07_package"))).toBe(true);
    expect(result.nextStepCommand).toContain("scripts/analyze.ts");
    expect(result.nextStepCommand).toContain("projects/onboarding-smoke/02_media/source/*");

    const projectState = parseYaml(
      fs.readFileSync(path.join(result.projectDir, "project_state.yaml"), "utf-8"),
    ) as { project_id: string };
    expect(projectState.project_id).toBe("onboarding-smoke");

    const blockers = parseYaml(
      fs.readFileSync(path.join(result.projectDir, "01_intent/unresolved_blockers.yaml"), "utf-8"),
    ) as { project_id: string };
    expect(blockers.project_id).toBe("onboarding-smoke");

    const humanNotes = parseYaml(
      fs.readFileSync(path.join(result.projectDir, "06_review/human_notes.yaml"), "utf-8"),
    ) as { project_id: string };
    expect(humanNotes.project_id).toBe("onboarding-smoke");

    const seededTimeline = JSON.parse(
      fs.readFileSync(path.join(result.projectDir, "05_timeline/v001.timeline.json"), "utf-8"),
    ) as {
      project_id: string;
      provenance: { brief_path: string };
    };
    expect(seededTimeline.project_id).toBe("onboarding-smoke");
    expect(seededTimeline.provenance.brief_path).toBe(
      "projects/onboarding-smoke/01_intent/creative_brief.yaml",
    );

    const sourceLinkPath = path.join(result.projectDir, "02_media/source");
    expect(fs.lstatSync(sourceLinkPath).isSymbolicLink()).toBe(true);
    expect(path.resolve(result.projectDir, fs.readlinkSync(sourceLinkPath))).toBe(sourceDir);
  });
});

describe("status CLI", () => {
  it("parses --json", () => {
    const parsed = parseStatusArgs([
      "node",
      "scripts/status.ts",
      "projects/sample",
      "--json",
    ]);

    expect(parsed).toEqual({
      projectDir: "projects/sample",
      json: true,
    });
  });

  it("formats the status summary for a valid project", () => {
    const workspace = createTempDir("tmp-status-project-");
    const projectDir = path.join(workspace, "sample-project");
    copyDirSync(path.resolve("projects/sample"), projectDir);

    const result = runStatus(projectDir);
    expect(result.success).toBe(true);

    const summary = formatStatusResult(projectDir, result);
    expect(summary).toContain("State:");
    expect(summary).toContain("Gates:");
    expect(summary).toContain("Next:");
  });
});
