import { describe, expect, it } from "vitest";
import {
  CANONICAL_PIPELINE_STAGES,
  CANONICAL_STAGE_OBSERVABILITY,
  FULL_PIPELINE_RESUME_STAGE_ORDER,
  FULL_PIPELINE_TIMING_STAGE_ORDER,
  buildEditorialPipelineTimingStages,
  buildFullPipelineCommandPhases,
  buildFullPipelineCommandTimingStages,
  buildScriptFullPipelineTimingStages,
  isFullPipelinePhase,
  isFullPipelineResumeStage,
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

  it("keeps the public resume vocabulary separate from canonical stage names", () => {
    expect(FULL_PIPELINE_RESUME_STAGE_ORDER).toEqual([
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
    expect(FULL_PIPELINE_TIMING_STAGE_ORDER).toBe(FULL_PIPELINE_RESUME_STAGE_ORDER);
    expect(isFullPipelineResumeStage("embeddings")).toBe(true);
    expect(isFullPipelineResumeStage("footageDb")).toBe(false);

    // Compatibility guard for callers that used the historical timing-stage name.
    expect(isFullPipelineTimingStage("embeddings")).toBe(true);
    expect(isFullPipelineTimingStage("footageDb")).toBe(false);
  });

  it("makes canonical-to-observability folding explicit", () => {
    expect(CANONICAL_STAGE_OBSERVABILITY.visualQuality).toEqual({
      timingStages: ["visual-quality"],
      resumeStage: "visual-quality",
    });
    expect(CANONICAL_STAGE_OBSERVABILITY.footageDb).toEqual({
      timingStages: ["embeddings"],
      resumeStage: "embeddings",
    });
    expect(CANONICAL_STAGE_OBSERVABILITY.review).toEqual({
      timingStages: ["QA"],
      resumeStage: "QA",
    });
    expect(CANONICAL_STAGE_OBSERVABILITY.qa).toEqual({
      timingStages: ["QA"],
      resumeStage: "QA",
    });
    expect(CANONICAL_STAGE_OBSERVABILITY.package).toEqual({
      timingStages: [],
      resumeStage: null,
    });
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
