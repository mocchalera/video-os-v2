import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
  auditSkillContracts,
  SKILL_CONTRACT_SEVERITIES,
  skillContractExitCode,
} from "../runtime/skill-contracts/verify.js";
import { appendManifestStaleIssue } from "../scripts/verify-skill-contracts.js";

const FIXTURE_ROOT = path.resolve("tests/fixtures/skill_contracts");

function fixtureSnapshot(rootDir: string): string[] {
  const entries: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(entryPath);
      else if (entry.isFile()) {
        entries.push(`${path.relative(rootDir, entryPath)}\0${fs.readFileSync(entryPath, "utf8")}`);
      }
    }
  };
  visit(rootDir);
  return entries.sort();
}

describe("skill contract verifier", () => {
  it("rejects missing npm scripts, script files, templates, and parser flags from fixtures", () => {
    const fixtureRoot = path.join(FIXTURE_ROOT, "errors");
    const before = fixtureSnapshot(fixtureRoot);
    const result = auditSkillContracts({
      rootDir: fixtureRoot,
      flagContracts: { "scripts/good.ts": ["--good"] },
    });

    expect(result.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: "missing_npm_script",
        severity: "error",
        file: ".agents/skills/missing-npm/SKILL.md",
        reference: "absent",
      }),
      expect.objectContaining({
        code: "missing_script_file",
        severity: "error",
        file: ".agents/skills/missing-script/SKILL.md",
        reference: "scripts/absent.ts",
      }),
      expect.objectContaining({
        code: "unresolved_template_id",
        severity: "error",
        file: ".agents/skills/missing-template/SKILL.md",
        reference: "vos:content.not-real/v1",
      }),
      expect.objectContaining({
        code: "unknown_command_flag",
        severity: "error",
        file: ".agents/skills/unknown-flag/SKILL.md",
        reference: "scripts/good.ts --bad",
      }),
      expect.objectContaining({
        code: "flag_contract_missing",
        severity: "error",
        file: ".agents/skills/unknown-flag/SKILL.md",
        reference: "npm run indirect -- --bad",
      }),
      expect.objectContaining({
        code: "unknown_command_flag",
        severity: "error",
        file: ".agents/skills/unknown-flag/SKILL.md",
        reference: "scripts/good.ts --asset-id",
      }),
    ]));
    expect(result.issues).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "unresolved_template_id", reference: "vos:content.good/v1" }),
      expect.objectContaining({ code: "unresolved_template_id", reference: "vos:overlay.good" }),
    ]));
    expect(skillContractExitCode(result.issues, true)).toBe(1);
    expect(fixtureSnapshot(fixtureRoot)).toEqual(before);
  });

  it("requires explicit flags to occur in parser acceptance branches, not only help text", () => {
    const result = auditSkillContracts({
      rootDir: path.join(FIXTURE_ROOT, "errors"),
      flagContracts: { "scripts/good.ts": ["--help-only"] },
    });

    expect(result.issues).toContainEqual(expect.objectContaining({
      code: "flag_contract_parser_mismatch",
      severity: "error",
      reference: "--help-only",
    }));
  });

  it("rejects a SKILL.md declaration for an artifact with no producer", () => {
    const result = auditSkillContracts({
      rootDir: path.join(FIXTURE_ROOT, "warnings"),
      flagContracts: {},
    });

    expect(result.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "artifact_unverified", severity: "error" }),
      expect.objectContaining({
        code: "artifact_unverified",
        severity: "error",
        reference: "tree-not-produced.json",
      }),
      expect.objectContaining({ code: "artifact_zero_verified", severity: "error" }),
    ]));
    expect(result.issues.every((issue) => issue.severity === "error")).toBe(true);
    expect(skillContractExitCode(result.issues, true)).toBe(1);
  });

  it("allows the central policy to demote artifact failures for diagnostics", () => {
    const result = auditSkillContracts({
      rootDir: path.join(FIXTURE_ROOT, "warnings"),
      flagContracts: {},
      severities: {
        ...SKILL_CONTRACT_SEVERITIES,
        artifact_unverified: "warn",
        artifact_zero_verified: "warn",
      },
    });

    expect(result.issues).toContainEqual(expect.objectContaining({
      code: "artifact_zero_verified",
      severity: "warn",
    }));
    expect(skillContractExitCode(result.issues, true)).toBe(0);
  });

  it("exempts only the explicitly agent-authored output section from producer checks", () => {
    const result = auditSkillContracts({
      rootDir: path.join(FIXTURE_ROOT, "agent-authored"),
      flagContracts: {},
    });

    expect(result.artifactDeclarations).toBe(1);
    expect(result.issues).toContainEqual(expect.objectContaining({
      code: "artifact_unverified",
      severity: "error",
      reference: "code-required.json",
    }));
    expect(result.issues).toContainEqual(expect.objectContaining({
      code: "artifact_zero_verified",
      severity: "error",
      reference: "1 declaration(s)",
    }));
    expect(result.issues).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ reference: "agent-written.json" }),
    ]));
    expect(skillContractExitCode(result.issues, true)).toBe(1);
  });

  it("finds producer evidence across dynamic fragments, Python, Swift, and imported modules", () => {
    const result = auditSkillContracts({
      rootDir: path.join(FIXTURE_ROOT, "producers"),
      flagContracts: {},
    });

    expect(result.artifactDeclarations).toBe(3);
    expect(result.verifiedArtifacts).toBe(3);
    expect(result.issues).toEqual([]);
    expect(skillContractExitCode(result.issues, true)).toBe(0);
  });

  it("retains manifest-stale as an error without mutating the fixture", () => {
    const fixtureRoot = path.join(FIXTURE_ROOT, "warnings");
    const before = fixtureSnapshot(fixtureRoot);
    const result = auditSkillContracts({ rootDir: fixtureRoot, flagContracts: {} });

    appendManifestStaleIssue(result, fixtureRoot);

    expect(result.issues).toContainEqual(expect.objectContaining({
      code: "manifest_stale",
      severity: "error",
    }));
    expect(skillContractExitCode(result.issues, true)).toBe(1);
    expect(fixtureSnapshot(fixtureRoot)).toEqual(before);
  });

  it("checks the RFA-015 generic surface for local references, contamination, and ownership drift", () => {
    const result = auditSkillContracts({
      rootDir: path.join(FIXTURE_ROOT, "rfa015"),
      flagContracts: {},
    });

    expect(result.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: "unresolved_local_reference",
        severity: "error",
        reference: "references/missing.md",
      }),
      expect.objectContaining({
        code: "unresolved_local_reference",
        severity: "error",
        reference: "schemas/not-real.schema.json",
      }),
      expect.objectContaining({
        code: "generic_skill_contamination",
        severity: "error",
        reference: expect.stringContaining("/private/tmp/project/input.json"),
      }),
      expect.objectContaining({
        code: "ownership_contradiction",
        severity: "error",
        reference: expect.stringContaining("Remotion renders speech captions, not FFmpeg/libass"),
      }),
      expect.objectContaining({
        code: "unresolved_skill_reference",
        severity: "error",
        reference: "missing-skill",
      }),
    ]));
    expect(result.issues).not.toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: "generic_skill_contamination",
        reference: expect.stringContaining("https://example.com/guide"),
      }),
      expect.objectContaining({
        code: "ownership_contradiction",
        reference: expect.stringContaining("FFmpeg/libass owns speech captions"),
      }),
      expect.objectContaining({
        code: "unresolved_skill_reference",
        reference: "finish-creator-short",
      }),
    ]));
    expect(skillContractExitCode(result.issues, true)).toBe(1);
  });
});
