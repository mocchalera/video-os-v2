import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import YAML from "yaml";

const repoRoot = path.resolve(import.meta.dirname, "..");
const skillRoot = path.join(repoRoot, ".agents/skills/short-sound-design");
const skillPath = path.join(skillRoot, "SKILL.md");
const openaiPath = path.join(skillRoot, "agents/openai.yaml");
const referencePath = path.join(skillRoot, "references/workflow.md");

function readFrontmatter(source: string): Record<string, unknown> {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(source);
  if (!match) throw new Error("SKILL.md frontmatter is missing");
  return YAML.parse(match[1]) as Record<string, unknown>;
}

describe("short-sound-design agent skill", () => {
  it("uses minimal frontmatter with bilingual concrete triggers", () => {
    const source = fs.readFileSync(skillPath, "utf8");
    const frontmatter = readFrontmatter(source);
    expect(Object.keys(frontmatter).sort()).toEqual(["description", "name"]);
    expect(frontmatter.name).toBe("short-sound-design");
    const description = String(frontmatter.description);
    for (const trigger of [
      "短尺SNS",
      "BGM",
      "効果音",
      "テンポ調整",
      "意味ベース配置",
      "rough cut",
    ]) {
      expect(description).toContain(trigger);
    }
  });

  it("documents the formal solver-to-render workflow and prohibitions", () => {
    const source = fs.readFileSync(skillPath, "utf8");
    for (const marker of [
      "sound-design:plan",
      "sfx:project",
      "render-audio-plan",
      "social-review",
      "semantic",
      "congestion",
      "provenance",
      "human",
      "公開",
      "固定間隔",
      "picture timing",
    ]) {
      expect(source).toContain(marker);
    }
    expect(source).toContain("references/workflow.md");
    expect(fs.existsSync(referencePath)).toBe(true);
  });

  it("keeps OpenAI UI metadata to the three required interface fields", () => {
    const parsed = YAML.parse(fs.readFileSync(openaiPath, "utf8")) as {
      interface?: Record<string, unknown>;
    };
    expect(Object.keys(parsed)).toEqual(["interface"]);
    expect(Object.keys(parsed.interface ?? {}).sort()).toEqual([
      "default_prompt",
      "display_name",
      "short_description",
    ]);
    const shortDescription = String(parsed.interface?.short_description);
    expect([...shortDescription].length).toBeGreaterThanOrEqual(25);
    expect([...shortDescription].length).toBeLessThanOrEqual(64);
    expect(String(parsed.interface?.default_prompt)).toContain(
      "$short-sound-design",
    );
  });

  it("is explicitly routed from finish-business-short without duplicating policy", () => {
    const parent = fs.readFileSync(
      path.join(repoRoot, ".agents/skills/finish-business-short/SKILL.md"),
      "utf8",
    );
    expect(parent).toContain("$short-sound-design");
  });

  it("keeps a self-contained skill structure without scaffolding placeholders", () => {
    expect(fs.readdirSync(skillRoot).sort()).toEqual([
      "SKILL.md",
      "agents",
      "references",
    ]);
    expect(fs.readdirSync(path.join(skillRoot, "agents"))).toEqual([
      "openai.yaml",
    ]);
    expect(fs.readdirSync(path.join(skillRoot, "references"))).toEqual([
      "workflow.md",
    ]);

    for (const filePath of [skillPath, openaiPath, referencePath]) {
      const source = fs.readFileSync(filePath, "utf8");
      expect(source.trim().length).toBeGreaterThan(0);
      expect(source).not.toMatch(/\bTODO\b|Replace with|TEMPLATE/i);
    }
  });
});
