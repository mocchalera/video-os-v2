import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import {
  executePipelinePhases,
  failPipelinePhase,
} from "../runtime/pipeline/phase-executor.js";

describe("pipeline phase executor", () => {
  it("is the sequencing authority for both full-pipeline orchestrators", () => {
    for (const file of [
      "runtime/pipeline/executor.ts",
      "runtime/commands/full-pipeline.ts",
    ]) {
      expect(fs.readFileSync(file, "utf-8")).toContain("executePipelinePhases");
    }
  });

  it("runs phases in order and records each completed phase", async () => {
    const calls: string[] = [];
    const result = await executePipelinePhases([
      { phase: "analyze", run: async () => { calls.push("analyze"); } },
      { phase: "plan", run: async () => { calls.push("plan"); } },
      { phase: "render", run: async () => { calls.push("render"); } },
    ]);

    expect(calls).toEqual(["analyze", "plan", "render"]);
    expect(result).toEqual({
      success: true,
      completedPhases: ["analyze", "plan", "render"],
    });
  });

  it("stops after an explicit failure without marking the failed phase complete", async () => {
    const calls: string[] = [];
    const result = await executePipelinePhases([
      { phase: "compile", run: async () => { calls.push("compile"); } },
      {
        phase: "review",
        run: async () => {
          calls.push("review");
          return failPipelinePhase({ stage: "QA", message: "review failed" });
        },
      },
      { phase: "render", run: async () => { calls.push("render"); } },
    ]);

    expect(calls).toEqual(["compile", "review"]);
    expect(result).toEqual({
      success: false,
      completedPhases: ["compile"],
      failedPhase: "review",
      failure: { stage: "QA", message: "review failed" },
    });
  });

  it("can retain a completed phase when its downstream follow-up fails", async () => {
    const result = await executePipelinePhases([
      {
        phase: "review",
        run: async () => failPipelinePhase(
          { stage: "QA", message: "patch compile failed" },
          { phaseCompleted: true },
        ),
      },
    ]);

    expect(result.completedPhases).toEqual(["review"]);
    expect(result.failure).toEqual({ stage: "QA", message: "patch compile failed" });
  });

  it("leaves thrown-error policy to the calling orchestrator", async () => {
    await expect(executePipelinePhases([
      {
        phase: "analyze",
        run: async () => {
          throw new Error("source missing");
        },
      },
    ])).rejects.toThrow("source missing");
  });
});
