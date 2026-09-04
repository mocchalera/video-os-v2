import * as fs from "node:fs";
import { describe, expect, it } from "vitest";

const skillPaths = [
  ".agents/skills/re-edit/SKILL.md",
  ".agents/skills/finish-creator-short/SKILL.md",
];

describe("Issue #16 caption edit Skill contracts", () => {
  it.each(skillPaths)("keeps %s on the canonical router and visual preview command", (skillPath) => {
    const source = fs.readFileSync(skillPath, "utf8");
    expect(source).toContain("npm run caption-edit-route -- --project projects/<project>");
    expect(source).toContain("scripts/caption-review.ts visual-author-preview --project projects/<project>");
    expect(source).toContain("--expected-patch-hash <hash-or-absent>");
    expect(source).toContain("--expected-approval-hash <caption-approval-binding-hash>");
    expect(source).toContain("caption_visual_treatment_preapproval_input.json");
    expect(source).toContain("caption_visual_treatment_preapproval_receipt.json");
    expect(source).toContain("preview-baseline-fast-full.mp4");
    expect(source).toMatch(/project-local ASS\/FFmpeg\/render script.*(?:書かない|を書かない)/);
    expect(source).toMatch(/degraded-route note.*停止/);
    expect(source).toMatch(/FFmpeg\/libass/);
    expect(source).toMatch(/registered content element \+ Remotion/);
    expect(source).toContain("npm run project-output:degraded -- --project projects/<project>");
    expect(source).toMatch(/書込み前.*停止/);
  });
});
