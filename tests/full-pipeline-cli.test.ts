import { describe, expect, it } from "vitest";
import { FULL_PIPELINE_RESUME_STAGE_ORDER } from "../runtime/pipeline/plan.js";
import { parseArgs } from "../scripts/full-pipeline.js";

describe("full-pipeline CLI", () => {
  it("accepts every public resume stage", () => {
    for (const stage of FULL_PIPELINE_RESUME_STAGE_ORDER) {
      expect(parseArgs([
        "node",
        "scripts/full-pipeline.ts",
        "--project",
        "demo",
        "--from",
        stage,
      ]).from).toBe(stage);
    }
  });

  it("derives help and validation vocabulary from the public resume contract", () => {
    const pipeSeparatedStages = FULL_PIPELINE_RESUME_STAGE_ORDER.join("|");
    const commaSeparatedStages = FULL_PIPELINE_RESUME_STAGE_ORDER.join(", ");

    expect(() => parseArgs(["node", "scripts/full-pipeline.ts", "--help"]))
      .toThrow(`Resume hint: ${pipeSeparatedStages}.`);
    expect(() => parseArgs([
      "node",
      "scripts/full-pipeline.ts",
      "--project",
      "demo",
      "--from",
      "footageDb",
    ])).toThrow(`--from must be one of: ${commaSeparatedStages}`);
  });
});
