import { describe, expect, it } from "vitest";
import {
  CANONICAL_PIPELINE_STAGES,
  FULL_PIPELINE_TIMING_STAGE_ORDER,
  buildEditorialPipelineTimingStages,
  buildFullPipelineCommandPhases,
  buildFullPipelineCommandTimingStages,
  buildScriptFullPipelineTimingStages,
  isFullPipelinePhase,
  isFullPipelineTimingStage,
  shouldRunScriptAnalyze,
  shouldRunScriptFootageDb,
} from "../runtime/pipeline/plan.js";

describe("canonical pipeline plan", () => {
  it("names the canonical cross-entrypoint stages explicitly", () => {
    expect(CANONICAL_PIPELINE_STAGES).toEqual([
      "ingest",
      "analyze",
      "stt",
      "marlin",
      "visualQuality",
      "peak",
      "embeddings",
      "footageDb",
      "triage",
      "blueprint",
      "compile",
      "review",
      "render",
      "qa",
      "package",
    ]);
  });

  it("uses one timing-stage order for the single-command CLI", () => {
    expect(FULL_PIPELINE_TIMING_STAGE_ORDER).toEqual([
      "ingest",
      "stt",
      "marlin",
      "visual-quality",
      "peak",
      "embeddings",
      "triage",
      "blueprint",
      "compile",
      "render",
      "QA",
    ]);
    expect(isFullPipelineTimingStage("embeddings")).toBe(true);
    expect(isFullPipelineTimingStage("footageDb")).toBe(false);
  });

  it("filters the script full-pipeline plan without changing resume semantics", () => {
    expect(buildScriptFullPipelineTimingStages({
      from: "embeddings",
      skipAnalyze: false,
      skipFootageDb: false,
      skipRender: true,
      skipQa: true,
    })).toEqual(["embeddings", "triage", "blueprint", "compile"]);

    expect(shouldRunScriptAnalyze({ from: "embeddings" })).toBe(false);
    expect(shouldRunScriptFootageDb({ from: "embeddings" })).toBe(true);
    expect(shouldRunScriptAnalyze({ from: "peak" })).toBe(true);
  });

  it("maps runtime full-pipeline phases into the same progress stages", () => {
    expect(isFullPipelinePhase("review")).toBe(true);
    expect(isFullPipelinePhase("QA")).toBe(false);

    expect(buildFullPipelineCommandPhases({
      from: "compile",
      target: "roughcut",
    })).toEqual(["compile", "review"]);

    expect(buildFullPipelineCommandTimingStages({
      from: "compile",
      target: "roughcut",
    })).toEqual(["compile", "QA"]);

    expect(buildFullPipelineCommandTimingStages({
      from: "analyze",
      target: "package",
      analyze: {
        skipStt: true,
        skipPeak: true,
      },
    })).toEqual([
      "ingest",
      "marlin",
      "visual-quality",
      "triage",
      "blueprint",
      "compile",
      "QA",
      "render",
    ]);
  });

  it("keeps editorial pipeline progress planning in the shared plan module", () => {
    expect(buildEditorialPipelineTimingStages({
      skipRender: false,
      qa: true,
    })).toEqual(["triage", "blueprint", "compile", "render", "QA"]);

    expect(buildEditorialPipelineTimingStages({
      skipRender: true,
      skipQa: true,
    })).toEqual(["triage", "blueprint", "compile"]);
  });
});
