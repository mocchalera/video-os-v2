import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type {
  CreativeBrief,
  EditBlueprint,
  SelectsCandidates,
} from "../runtime/artifacts/types.js";
import type { QALoopResult } from "../runtime/eval/qa-loop.js";
import {
  runEditorialDownstream,
} from "../scripts/editorial-downstream.js";
import { runCompileTimeline } from "../scripts/compile-timeline.js";
import { evaluateBriefAlignment } from "../runtime/eval/brief-alignment.js";
import { loadBlueprint, loadCreativeBrief, loadSelects } from "../runtime/artifacts/loaders.js";

const brief = { project_id: "interactive-demo" } as CreativeBrief;
const selects = { candidates: [] } as unknown as SelectsCandidates;
const blueprint = {} as EditBlueprint;

function qaResult(): QALoopResult {
  return {
    iterations: 1,
    initial_score: 0.7,
    final_score: 0.85,
    improvement: 0.15,
    fixes_applied_total: 1,
    reports: [],
    converged: true,
    convergence_reason: "quality_floor",
    warnings: [],
    visual_qa: { status: "verified" },
  };
}

function projectWithTimeline(): string {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "editorial-downstream-"));
  fs.mkdirSync(path.join(projectDir, "05_timeline"), { recursive: true });
  fs.writeFileSync(path.join(projectDir, "05_timeline", "timeline.json"), "{}");
  return projectDir;
}

describe("shared editorial downstream", () => {
  it("accepts real compiler bgm, ducking, and ending output through eval and the render-before gate", async () => {
    const root = fs.mkdtempSync(path.resolve("tests/.tmp-editorial-downstream-compiled-policy-"));
    const projectDir = path.join(root, "sample");
    fs.cpSync(path.resolve("projects/sample"), projectDir, { recursive: true });
    try {
      const briefPath = path.join(projectDir, "01_intent", "creative_brief.yaml");
      const blueprintPath = path.join(projectDir, "04_plan", "edit_blueprint.yaml");
      const selectsPath = path.join(projectDir, "04_plan", "selects_candidates.yaml");
      const briefDoc = parseYaml(fs.readFileSync(briefPath, "utf-8")) as Record<string, unknown>;
      const blueprintDoc = parseYaml(fs.readFileSync(blueprintPath, "utf-8")) as Record<string, any>;
      const selectsDoc = parseYaml(fs.readFileSync(selectsPath, "utf-8")) as Record<string, any>;
      const selected = selectsDoc.candidates[0];
      briefDoc.must_have = ["BGMを全編で使用する", "声に合わせてBGMをダッキングする", "フェードアウトで終わる"];
      briefDoc.audio_policy = "ducking";
      blueprintDoc.music_policy = {
        ...blueprintDoc.music_policy,
        bgm_asset_id: selected.asset_id,
        bgm_segment_id: selected.segment_id,
        bgm_duration_sec: 20,
      };
      blueprintDoc.ending_policy = {
        ...blueprintDoc.ending_policy,
        video_fade_out_sec: 1,
        video_fade_color: "black",
      };
      blueprintDoc.timeline_operations = [
        {
          operation_id: "TEST_SAMPLE_AUTHORIZED_TAIL_GAP",
          type: "gap",
          track_id: "V1",
          start_frame: 479,
          duration_frames: 193,
          authority: "blueprint",
          reason: "The checked-in sample has no approved source window for its declared tail.",
        },
        {
          operation_id: "TEST_SAMPLE_AUTHORIZED_TAIL_AMBIENCE",
          type: "ambient_continuation",
          track_id: "A1",
          start_frame: 479,
          duration_frames: 193,
          authority: "blueprint",
          reason: "Continue the already approved natural ambience under the authorized tail gap.",
        },
      ];
      fs.writeFileSync(briefPath, stringifyYaml(briefDoc), "utf-8");
      fs.writeFileSync(blueprintPath, stringifyYaml(blueprintDoc), "utf-8");
      const mediaItems = ["AST_001", "AST_002", "AST_003", "AST_004", "AST_005", "AST_006"]
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
      fs.writeFileSync(path.join(projectDir, "02_media/source_map.json"), JSON.stringify({
        version: "1",
        project_id: "sample-mountain-reset",
        media_dir: "02_media",
        generated_at: "2026-08-26T00:00:00.000Z",
        items: mediaItems,
      }, null, 2));
      fs.rmSync(path.join(projectDir, "05_timeline", "timeline.json"), { force: true });

      await runCompileTimeline({ projectPath: projectDir, skipPreview: true, skipConfirmations: true });
      const timeline = JSON.parse(fs.readFileSync(
        path.join(projectDir, "05_timeline", "timeline.json"),
        "utf-8",
      )) as { tracks: { audio: Array<{ clips: Array<{ role?: string }> }> } };
      expect(timeline.tracks.audio.flatMap((track) => track.clips).some((clip) => clip.role === "bgm")).toBe(true);
      await expect(evaluateBriefAlignment(projectDir, {
        stages: ["blueprint"],
        useLlm: false,
        evaluatedAt: "2026-08-26T00:00:00.000Z",
      })).resolves.toMatchObject({ project: "sample" });

      const calls: string[] = [];
      await runEditorialDownstream({
        projectDir,
        brief: loadCreativeBrief(briefPath),
        selects: loadSelects(selectsPath),
        blueprint: loadBlueprint(blueprintPath),
        entrypoint: "editorial-pipeline",
        skipRender: false,
        skipQa: true,
      }, {
        runCompile: async () => { calls.push("compile"); },
        runRender: async () => { calls.push("render"); },
        roughRenderExists: () => true,
      });
      expect(calls).toEqual(["compile", "render"]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails closed after compile when a deferred caption directive is not enforced", async () => {
    const projectDir = projectWithTimeline();
    const calls: string[] = [];
    const directiveBrief = {
      project_id: "directive-gate",
      must_have: ["撮影日テロップを表示する"],
    } as unknown as CreativeBrief;
    const directiveBlueprint = {
      music_policy: {},
      ending_policy: { should_feel: "hard cut" },
    } as EditBlueprint;
    fs.copyFileSync(
      path.resolve("projects/demo/05_timeline/timeline.json"),
      path.join(projectDir, "05_timeline", "timeline.json"),
    );

    await expect(runEditorialDownstream({
      projectDir,
      brief: directiveBrief,
      selects,
      blueprint: directiveBlueprint,
      entrypoint: "editorial-pipeline",
      skipRender: false,
      skipQa: true,
    }, {
      runCompile: async () => { calls.push("compile"); },
      runRender: async () => { calls.push("render"); },
    })).rejects.toThrow(/production directive/i);
    expect(calls).toEqual(["compile"]);
  });

  it("runs interactive completion through compile, render, QA, and status writing", async () => {
    const projectDir = projectWithTimeline();
    const calls: string[] = [];

    const status = await runEditorialDownstream({
      projectDir,
      brief,
      selects,
      blueprint,
      entrypoint: "editorial-agent-task",
      skipRender: false,
      onFirstPreviewReady: () => { calls.push("preview-ready"); },
    }, {
      runCompile: async () => { calls.push("compile"); },
      runRender: async () => { calls.push("render"); },
      runQaLoop: async () => {
        calls.push("QA");
        return qaResult();
      },
      roughRenderExists: () => true,
      loadQaEnvironment: () => undefined,
      now: () => new Date("2026-07-22T00:00:00.000Z"),
    });

    expect(calls).toEqual(["compile", "render", "preview-ready", "QA"]);
    expect(status.entrypoint).toBe("editorial-agent-task");
    expect(status.qa.status).toBe("passed");
    expect(status.preview.status).toBe("available");
    expect(JSON.parse(fs.readFileSync(
      path.join(projectDir, "06_review", "editorial_pipeline_status.json"),
      "utf8",
    ))).toEqual(status);
  });

  it("records an explicit blocker when interactive completion skips QA", async () => {
    const projectDir = projectWithTimeline();
    const calls: string[] = [];

    const status = await runEditorialDownstream({
      projectDir,
      brief,
      selects,
      blueprint,
      entrypoint: "editorial-agent-task",
      skipRender: true,
      skipQa: true,
    }, {
      runCompile: async () => { calls.push("compile"); },
      runRender: async () => { calls.push("render"); },
      runQaLoop: async () => {
        calls.push("QA");
        return qaResult();
      },
      loadQaEnvironment: () => undefined,
      now: () => new Date("2026-07-22T00:00:00.000Z"),
    });

    expect(calls).toEqual(["compile"]);
    expect(status.qa.status).toBe("skipped");
    expect(status.preview.status).toBe("skipped");
    expect(status.blocking_issues.map((issue) => issue.code)).toEqual(["QA_SKIPPED"]);
  });

  it("preserves fail-open preview semantics when shared QA fails", async () => {
    const projectDir = projectWithTimeline();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const status = await runEditorialDownstream({
        projectDir,
        brief,
        selects,
        blueprint,
        entrypoint: "editorial-agent-task",
        skipRender: false,
      }, {
        runCompile: async () => undefined,
        runRender: async () => undefined,
        runQaLoop: async () => { throw new Error("visual review unavailable"); },
        roughRenderExists: () => true,
        loadQaEnvironment: () => undefined,
        now: () => new Date("2026-07-22T00:00:00.000Z"),
      });

      expect(status.preview.status).toBe("available");
      expect(status.qa.status).toBe("failed");
      expect(status.qa.message).toContain("visual review unavailable");
      expect(status.final_render).toEqual({ status: "blocked", reason: "QA_LOOP_FAILED" });
    } finally {
      warn.mockRestore();
    }
  });
});
