import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type {
  CreativeBrief,
  EditBlueprint,
  SelectsCandidates,
} from "../runtime/artifacts/types.js";
import type { QALoopResult } from "../runtime/eval/qa-loop.js";
import {
  runEditorialDownstream,
} from "../scripts/editorial-downstream.js";

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

    expect(calls).toEqual(["compile", "render", "QA"]);
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
