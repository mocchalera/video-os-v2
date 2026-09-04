import { afterAll, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { initProject, parseArgs as parseInitArgs } from "../scripts/init-project.js";
import { runCompileTimeline } from "../scripts/compile-timeline.js";
import { validateProject } from "../scripts/validate-schemas.js";
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
    expect(fs.existsSync(path.join(result.projectDir, "09_output"))).toBe(true);
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

    expect(fs.existsSync(path.join(result.projectDir, "04_plan/edit_blueprint.yaml"))).toBe(false);
    expect(fs.existsSync(path.join(result.projectDir, "05_timeline/v001.timeline.json"))).toBe(false);

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

describe("compile-timeline public planning preflight", () => {
  function prepareCoverageFailure(name: string): string {
    const workspace = createTempDir(name);
    const projectDir = path.join(workspace, "sample-project");
    copyDirSync(path.resolve("projects/sample"), projectDir);
    fs.rmSync(path.join(projectDir, "05_timeline/timeline.json"), { force: true });

    const sourceItems = ["AST_001", "AST_002", "AST_003", "AST_004", "AST_005", "AST_006"]
      .map((assetId) => {
        const relativePath = `02_media/${assetId}.mp4`;
        fs.mkdirSync(path.dirname(path.join(projectDir, relativePath)), { recursive: true });
        fs.copyFileSync(
          path.resolve("tests/fixtures/media/test-clip-5s.mp4"),
          path.join(projectDir, relativePath),
        );
        return {
          asset_id: assetId,
          source_locator: relativePath,
          local_source_path: relativePath,
          link_path: relativePath,
        };
      });
    fs.writeFileSync(
      path.join(projectDir, "02_media/source_map.json"),
      JSON.stringify({
        version: "1",
        project_id: "sample-mountain-reset",
        media_dir: "02_media",
        generated_at: "2026-08-26T00:00:00.000Z",
        items: sourceItems,
      }, null, 2),
      "utf-8",
    );

    const selectsPath = path.join(projectDir, "04_plan/selects_candidates.yaml");
    const selects = parseYaml(fs.readFileSync(selectsPath, "utf-8")) as Record<string, unknown>;
    selects.coverage = {
      version: "1",
      policy: "analysis-defaults.selection",
      status: "failed",
      config: {
        min_candidates_per_cluster: 1,
        cluster_sampling_scale: "sqrt",
        max_candidates_per_cluster: 4,
      },
      clusters: [],
      must_have: [],
      unmet: [{
        type: "must_have",
        id: "must_have:finish",
        message: "must_have finish has no matching non-rejected candidate",
        must_have: "finish",
      }],
    };
    fs.writeFileSync(selectsPath, stringifyYaml(selects), "utf-8");
    return projectDir;
  }

  it("blocks before compile when the required uncertainty register is missing", async () => {
    const projectDir = prepareCoverageFailure("tmp-compile-missing-register-");
    fs.rmSync(path.join(projectDir, "04_plan/uncertainty_register.yaml"), { force: true });

    const validation = validateProject(projectDir);
    expect(validation.valid).toBe(false);
    expect(validation.compile_gate).toBe("open");
    await expect(runCompileTimeline({
      projectPath: projectDir,
      skipPreview: true,
      skipConfirmations: true,
    })).rejects.toThrow(/uncertainty_register/i);
    expect(fs.existsSync(path.join(projectDir, "05_timeline/timeline.json"))).toBe(false);
  });

  it("blocks before compile when selects coverage has a planning blocker", async () => {
    const projectDir = prepareCoverageFailure("tmp-compile-coverage-blocker-");
    fs.writeFileSync(
      path.join(projectDir, "04_plan/uncertainty_register.yaml"),
      stringifyYaml({
        version: "1",
        project_id: "sample-mountain-reset",
        uncertainties: [{
          id: "U_SELECTS_COVERAGE",
          type: "coverage",
          question: "Can approved selects satisfy coverage?",
          status: "blocker",
          evidence: ["must_have finish is unmet"],
          alternatives: [],
          escalation_required: true,
        }],
      }),
      "utf-8",
    );

    expect(validateProject(projectDir).compile_gate).toBe("open");
    await expect(runCompileTimeline({
      projectPath: projectDir,
      skipPreview: true,
      skipConfirmations: true,
    })).rejects.toThrow("Planning gate BLOCKED. uncertainty_register has status 'blocker' entries.");
    expect(fs.existsSync(path.join(projectDir, "05_timeline/timeline.json"))).toBe(false);
  });
});
