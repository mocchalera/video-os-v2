import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { validateAgainstSchema } from "../runtime/commands/shared.js";

describe("speech-led first-run product default", () => {
  it("keeps the project template on interview-highlight without a parallel brief contract", () => {
    const templatePath = path.resolve("projects/_template/01_intent/creative_brief.yaml");
    const brief = parseYaml(fs.readFileSync(templatePath, "utf-8")) as {
      project?: { title?: string };
      editorial?: { profile_hint?: string; policy_hint?: string };
    };

    expect(brief.project?.title).toBe("Speech-Led Highlight");
    expect(brief.editorial).toMatchObject({
      profile_hint: "interview-highlight",
      policy_hint: "interview",
    });
    expect(validateAgainstSchema(brief, "creative-brief.schema.json")).toEqual({
      valid: true,
      errors: [],
    });
  });
});
