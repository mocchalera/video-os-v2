import * as fs from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  main as compileTimelineMain,
  parseArgs as parseCompileTimelineArgs,
  runCompileTimeline,
} from "../scripts/compile-timeline.js";
import { renderRoughCut } from "../scripts/render-rough-cut.js";

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

  it("does not shell out to compile or render CLIs from editorial orchestration", () => {
    const files = [
      "scripts/editorial-pipeline.ts",
      "scripts/editorial-agent-task.ts",
    ];

    for (const file of files) {
      const source = fs.readFileSync(file, "utf-8");
      expect(source).not.toContain("node:child_process");
      expect(source).not.toContain("scripts/compile-timeline.ts");
      expect(source).not.toContain("scripts/render-rough-cut.ts");
      expect(source).toContain('import { runCompileTimeline } from "./compile-timeline.js";');
      expect(source).toContain('import { renderRoughCut } from "./render-rough-cut.js";');
    }
  });
});
