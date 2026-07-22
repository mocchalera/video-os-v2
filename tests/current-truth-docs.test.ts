import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

const currentTruthDocs = [
  "docs/CURRENT_ARCHITECTURE.md",
  "docs/DECISIONS.md",
  "docs/PIPELINE_STATES.md",
  "docs/SECURITY_MODEL.md",
  "docs/RELEASE_CHECKLIST.md",
  "docs/DEPRECATED.md",
] as const;

const requiredPathReferences: Record<(typeof currentTruthDocs)[number], string[]> = {
  "docs/CURRENT_ARCHITECTURE.md": [
    "apps/macos-studio",
    "editor/server",
    "runtime/pipeline/plan.ts",
    "runtime/pipeline/full-pipeline-contract.ts",
    "runtime/pipeline/executor.ts",
    "runtime/pipeline/phase-executor.ts",
    "scripts/full-pipeline.ts",
    "scripts/editorial-downstream.ts",
    ".agents/skills/agent-skill-contracts.json",
    "schemas/editorial-pipeline-status.schema.json",
    ".github/workflows/ci.yml",
  ],
  "docs/DECISIONS.md": [
    "runtime/state/reconcile.ts",
    "runtime/pipeline/plan.ts",
    "runtime/pipeline/executor.ts",
    "scripts/full-pipeline.ts",
    "apps/macos-studio",
    "editor/server",
    "Package.swift",
  ],
  "docs/PIPELINE_STATES.md": [
    "runtime/state/reconcile.ts",
    "runtime/state/history.ts",
    "runtime/packaging/gate10.ts",
    "runtime/commands/package.ts",
    "schemas/project-state.schema.json",
  ],
  "docs/SECURITY_MODEL.md": [
    "scripts/check-repo-hygiene.ts",
    "editor/server/utils.ts",
    "editor/server/routes/media.ts",
    "runtime/media/source-map.ts",
    ".github/workflows/speech-led-real-media.yml",
  ],
  "docs/RELEASE_CHECKLIST.md": [
    "runtime/artifacts/p4a-release-safety.ts",
  ],
  "docs/DEPRECATED.md": [
    "apps/macos-studio",
    "editor/server",
    "editor/shared",
    "editor/client",
    "editor/tsconfig.json",
  ],
};

function localMarkdownLinks(markdown: string): string[] {
  return [...markdown.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)]
    .map((match) => match[1].trim().replace(/^<|>$/g, ""))
    .filter((target) => !/^(?:https?:|mailto:|#)/.test(target))
    .map((target) => target.split("#", 1)[0])
    .filter(Boolean);
}

describe("current-truth documentation contract", () => {
  it("keeps all current-truth documents present and locally linked", () => {
    for (const documentPath of currentTruthDocs) {
      expect(fs.existsSync(documentPath), documentPath).toBe(true);
      const markdown = fs.readFileSync(documentPath, "utf8");
      for (const target of localMarkdownLinks(markdown)) {
        const resolved = path.resolve(path.dirname(documentPath), target);
        expect(fs.existsSync(resolved), `${documentPath} -> ${target}`).toBe(true);
      }
    }
  });

  it("keeps README and ARCHITECTURE navigation complete", () => {
    for (const entrypoint of ["README.md", "ARCHITECTURE.md"]) {
      const markdown = fs.readFileSync(entrypoint, "utf8");
      for (const documentPath of currentTruthDocs) {
        expect(markdown, `${entrypoint} -> ${documentPath}`).toContain(`](${documentPath})`);
      }
    }
  });

  it("keeps cited executable, schema, CI, and ownership paths valid", () => {
    for (const documentPath of currentTruthDocs) {
      const markdown = fs.readFileSync(documentPath, "utf8");
      for (const referencedPath of requiredPathReferences[documentPath]) {
        expect(markdown, `${documentPath} cites ${referencedPath}`).toContain(`\`${referencedPath}\``);
        expect(fs.existsSync(referencedPath), referencedPath).toBe(true);
      }
    }
  });

  it("records current-truth precedence over historical documents", () => {
    const deprecated = fs.readFileSync("docs/DEPRECATED.md", "utf8");
    expect(deprecated).toContain("do not override");
    expect(deprecated).toContain("CURRENT_ARCHITECTURE.md");
    expect(deprecated).toContain("current-truth documents linked from the root README");
    expect(deprecated).toContain("current schemas and canonical artifacts");
    expect(deprecated).toContain("executable runtime/CLI/Studio/server paths and required CI");
  });
});
