import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadProjectCaptionGlossary } from "../runtime/caption/project-glossary.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("project caption glossary", () => {
  it("loads canonical terms and sorts deterministic variants longest first", () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "caption-glossary-"));
    tempDirs.push(projectDir);
    fs.mkdirSync(path.join(projectDir, "01_intent"));
    fs.writeFileSync(path.join(projectDir, "01_intent", "caption_glossary.yaml"), [
      'version: "1"',
      "terms:",
      '  - canonical: "Lively"',
      "    variants:",
      '      - "株式会社ライブリー"',
      '      - "ライブリー"',
      "corrections:",
      '  - from: "ラビリー"',
      '    to: "Lively"',
    ].join("\n"));

    const loaded = loadProjectCaptionGlossary(projectDir);
    expect(loaded.sources.projectNames).toContain("Lively");
    expect(loaded.sources.operatorCorrections).toEqual([
      { from: "株式会社ライブリー", to: "Lively" },
      { from: "ライブリー", to: "Lively" },
      { from: "ラビリー", to: "Lively" },
    ]);
  });

  it("is backward compatible when the project has no glossary", () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "caption-glossary-none-"));
    tempDirs.push(projectDir);
    expect(loadProjectCaptionGlossary(projectDir)).toEqual({ sources: {} });
  });
});
