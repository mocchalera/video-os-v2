import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { assertCompileDurationGate } from "../runtime/compiler/index.js";
import {
  main as compileTimelineMain,
  parseArgs as parseCompileTimelineArgs,
  runCompileTimeline,
} from "../scripts/compile-timeline.js";
import { renderRoughCut } from "../scripts/render-rough-cut.js";
import { parseArgs as parseEditorialAgentTaskArgs } from "../scripts/editorial-agent-task.js";
import { shouldSkipFineForFirstPreviewBudget } from "../scripts/editorial-pipeline.js";

const tempDirs: string[] = [];

afterAll(() => {
  for (const dir of tempDirs) {
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  }
});

function createExternalSampleProject(): string {
  const externalRoot = fs.mkdtempSync(path.join(os.tmpdir(), "video-os-external-compile-"));
  const projectDir = path.join(externalRoot, "project");
  tempDirs.push(externalRoot);
  fs.cpSync(path.resolve("projects/sample"), projectDir, { recursive: true });
  fs.rmSync(path.join(projectDir, "05_timeline/timeline.json"), { force: true });

  const sourceItems = ["AST_001", "AST_002", "AST_003", "AST_004", "AST_005", "AST_006"]
    .map((assetId) => {
      const relativePath = `02_media/${assetId}.mp4`;
      const target = path.join(projectDir, relativePath);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(path.resolve("tests/fixtures/media/test-clip-5s.mp4"), target);
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
      generated_at: "2026-09-02T00:00:00.000Z",
      items: sourceItems,
    }, null, 2),
    "utf-8",
  );
  return projectDir;
}

describe("editorial pipeline entrypoints", () => {
  it("rechecks the fine-cut budget after rough planning at the exact 600s boundary", () => {
    const budget = {
      firstPreviewDeadlineAtMs: 600_000,
      firstPreviewCompileRenderReserveMs: 63_400,
      firstPreviewFineEstimateMs: 48_000,
      firstPreviewFineProviderBudgetMs: 300_000,
    };
    expect(shouldSkipFineForFirstPreviewBudget({ ...budget, now: () => 236_600 })).toBe(false);
    expect(shouldSkipFineForFirstPreviewBudget({ ...budget, now: () => 236_601 })).toBe(true);
    expect(shouldSkipFineForFirstPreviewBudget({})).toBe(false);
  });

  it("exposes compile and rough-render functions without requiring CLI subprocesses", () => {
    expect(typeof runCompileTimeline).toBe("function");
    expect(typeof renderRoughCut).toBe("function");

    const args = parseCompileTimelineArgs([
      "node",
      "scripts/compile-timeline.ts",
      "projects/demo",
      "--repo-sfx-root",
      "/tmp/repo/resources/sfx",
      "--skip-preview",
      "--skip-confirmations",
      "true",
    ]);

    expect(args).toMatchObject({
      projectPath: "projects/demo",
      repoSfxRoot: "/tmp/repo/resources/sfx",
      skipPreview: true,
      skipConfirmations: true,
      forceConfirmations: false,
    });

    const compileSource = fs.readFileSync("scripts/compile-timeline.ts", "utf8");
    expect(compileSource).toContain("fileURLToPath(import.meta.url)");
    expect(compileSource).toMatch(/runCanonicalCompile\(\{[\s\S]*repoRoot: CANONICAL_REPO_ROOT[\s\S]*\}\);/);
    expect(compileSource).toMatch(/runCanonicalCompile\(\{[\s\S]*repoSfxRoot[\s\S]*\}\);/);
  });

  it("compiles a repo-external project through the public entrypoint", async () => {
    const projectDir = createExternalSampleProject();

    await expect(runCompileTimeline({
      projectPath: projectDir,
      skipPreview: true,
      skipConfirmations: true,
    })).resolves.toBeUndefined();
    expect(fs.existsSync(path.join(projectDir, "05_timeline/timeline.json"))).toBe(true);
  }, 30_000);

  it("ignores a project-local decoy schema during external compilation", async () => {
    const projectDir = createExternalSampleProject();
    const decoySchemaDir = path.join(projectDir, "schemas");
    fs.mkdirSync(decoySchemaDir, { recursive: true });
    fs.writeFileSync(path.join(decoySchemaDir, "timeline-ir.schema.json"), JSON.stringify({
      type: "object",
      required: ["decoy_only"],
    }), "utf-8");

    await expect(runCompileTimeline({
      projectPath: projectDir,
      skipPreview: true,
      skipConfirmations: true,
    })).resolves.toBeUndefined();
    expect(fs.existsSync(path.join(projectDir, "05_timeline/timeline.json"))).toBe(true);
  }, 30_000);

  it("allows unrelated optional review validation errors during external compilation", async () => {
    const projectDir = createExternalSampleProject();
    fs.writeFileSync(
      path.join(projectDir, "06_review/review_metrics.json"),
      "{ invalid json",
      "utf-8",
    );

    await expect(runCompileTimeline({
      projectPath: projectDir,
      skipPreview: true,
      skipConfirmations: true,
    })).resolves.toBeUndefined();
    expect(fs.existsSync(path.join(projectDir, "05_timeline/timeline.json"))).toBe(true);
  }, 30_000);

  it("keeps compile-timeline import-safe by returning a CLI status instead of exiting", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await expect(compileTimelineMain(["node", "scripts/compile-timeline.ts"])).resolves.toBe(1);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("fails closed only when a hard duration gate resolves outside its allowed window", () => {
    const shortResolution = {
      resolved_overlaps: 0,
      resolved_duplicates: 0,
      resolved_invalid_ranges: 0,
      duration_fit: false,
      total_frames: 636,
      target_frames: 1128,
      duration_mode: "strict",
      min_target_frames: 792,
      max_target_frames: 1464,
      duration_status: "short",
      content_frames: 300,
    };

    expect(() => assertCompileDurationGate({
      hardGate: true,
      resolution: shortResolution,
    })).toThrow(
      "Hard duration gate failed: status=short content_frames=300 allowed_frames=792..1464 target_frames=1128",
    );

    expect(() => assertCompileDurationGate({
      hardGate: false,
      resolution: shortResolution,
    })).not.toThrow();

    expect(() => assertCompileDurationGate({
      hardGate: true,
      resolution: {
        ...shortResolution,
        duration_fit: true,
        duration_status: "pass",
        content_frames: 1128,
      },
    })).not.toThrow();
  });

  it("does not shell out to compile or render CLIs from editorial orchestration", () => {
    const orchestrators = [
      "scripts/editorial-pipeline.ts",
      "scripts/editorial-agent-task.ts",
    ];

    for (const file of orchestrators) {
      const source = fs.readFileSync(file, "utf-8");
      expect(source).not.toContain("node:child_process");
      expect(source).not.toContain("scripts/compile-timeline.ts");
      expect(source).not.toContain("scripts/render-rough-cut.ts");
      expect(source).toContain('from "./editorial-downstream.js";');
    }

    const downstream = fs.readFileSync("scripts/editorial-downstream.ts", "utf-8");
    expect(downstream).toContain('from "./editorial-stages.js";');
    expect(downstream).not.toContain("node:child_process");

    const sharedStages = fs.readFileSync("scripts/editorial-stages.ts", "utf-8");
    expect(sharedStages).toContain('import { runCompileTimeline } from "./compile-timeline.js";');
    expect(sharedStages).toContain('import { renderRoughCut } from "./render-rough-cut.js";');
    expect(sharedStages).not.toContain("node:child_process");
  });

  it("keeps headless and interactive planning on the shared guarded context", () => {
    for (const file of ["scripts/editorial-pipeline.ts", "scripts/editorial-agent-task.ts"]) {
      const source = fs.readFileSync(file, "utf-8");
      expect(source).toContain("loadEditorialPlanningContext");
      expect(source).not.toContain("function loadMarlinEvents");
      expect(source).not.toContain("function loadSegments");
    }
  });

  it("makes interactive QA completion explicit and opt-out", () => {
    expect(parseEditorialAgentTaskArgs([
      "node",
      "scripts/editorial-agent-task.ts",
      "--project",
      "projects/demo",
      "--mode",
      "interactive",
      "--skip-qa",
    ])).toMatchObject({
      mode: "interactive",
      skipQa: true,
    });

    const interactiveSource = fs.readFileSync("scripts/editorial-agent-task.ts", "utf8");
    const headlessSource = fs.readFileSync("scripts/editorial-pipeline.ts", "utf8");
    for (const source of [interactiveSource, headlessSource]) {
      expect(source).toContain('from "./editorial-downstream.js";');
      expect(source).toContain("runEditorialDownstream");
    }
    expect(interactiveSource).not.toContain("runEditorialCompileAndMaybeRender");
  });
});
