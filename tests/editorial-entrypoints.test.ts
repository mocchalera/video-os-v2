import * as fs from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  assertCompileDurationGate,
  main as compileTimelineMain,
  parseArgs as parseCompileTimelineArgs,
  runCompileTimeline,
} from "../scripts/compile-timeline.js";
import { renderRoughCut } from "../scripts/render-rough-cut.js";
import { parseArgs as parseEditorialAgentTaskArgs } from "../scripts/editorial-agent-task.js";

describe("editorial pipeline entrypoints", () => {
  it("exposes compile and rough-render functions without requiring CLI subprocesses", () => {
    expect(typeof runCompileTimeline).toBe("function");
    expect(typeof renderRoughCut).toBe("function");

    const args = parseCompileTimelineArgs([
      "node",
      "scripts/compile-timeline.ts",
      "projects/demo",
      "--skip-preview",
      "--skip-confirmations",
      "true",
    ]);

    expect(args).toMatchObject({
      projectPath: "projects/demo",
      skipPreview: true,
      skipConfirmations: true,
      forceConfirmations: false,
    });
  });

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
