import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
  FULL_PIPELINE_AGENT_SKILL_CONTRACT,
  FULL_PIPELINE_CLI_OPTIONS,
} from "../runtime/pipeline/full-pipeline-contract.js";
import { parseArgs } from "../scripts/full-pipeline.js";
import {
  AGENT_SKILL_CONTRACTS_MANIFEST_PATH,
  serializeAgentSkillContractsManifest,
} from "../scripts/generate-agent-skill-contracts.js";

function contractLineValues(markdown: string, label: string): string[] {
  const prefix = `- ${label}:`;
  const line = markdown.split("\n").find((candidate) => candidate.startsWith(prefix));
  expect(line, `missing ${label} contract line`).toBeDefined();
  return [...(line ?? "").matchAll(/`([^`]+)`/g)].map((match) => match[1]);
}

function skillArtifactValues(markdown: string): string[] {
  const section = markdown.split("## 出力 artifact")[1]?.split("\n## ")[0] ?? "";
  return [...section.matchAll(/`([^`]+)`/g)].map((match) => match[1]);
}

describe("Agent Skill executable contracts", () => {
  it("keeps the generated manifest current", () => {
    expect(fs.readFileSync(AGENT_SKILL_CONTRACTS_MANIFEST_PATH, "utf8"))
      .toBe(serializeAgentSkillContractsManifest());
  });

  it("binds every declared command to an executable entrypoint", () => {
    const packageJson = JSON.parse(fs.readFileSync("package.json", "utf8")) as {
      scripts: Record<string, string>;
    };
    for (const command of FULL_PIPELINE_AGENT_SKILL_CONTRACT.commands) {
      expect(fs.existsSync(command.entrypoint), command.entrypoint).toBe(true);
      if ("packageScript" in command) {
        expect(packageJson.scripts[command.packageScript], command.packageScript)
          .toContain(command.entrypoint);
      }
    }
  });

  it("keeps every public full-pipeline option accepted and present in help", () => {
    let help = "";
    try {
      parseArgs(["node", "scripts/full-pipeline.ts", "--help"]);
    } catch (error) {
      help = error instanceof Error ? error.message : String(error);
    }

    for (const option of FULL_PIPELINE_CLI_OPTIONS) {
      expect(help, option.flag).toContain(option.flag);
      if (option.flag === "--help") continue;
      const exampleValue = "exampleValue" in option ? option.exampleValue : undefined;
      const optionArgs = option.flag === "--project"
        ? [option.flag, exampleValue ?? "projects/demo"]
        : ["--project", "projects/demo", option.flag, ...(exampleValue ? [exampleValue] : [])];
      expect(() => parseArgs(["node", "scripts/full-pipeline.ts", ...optionArgs]), option.flag)
        .not.toThrow();
    }
  });

  it("keeps the full-pipeline Skill aligned with commands, flags, resume values, and artifact boundaries", () => {
    const contract = FULL_PIPELINE_AGENT_SKILL_CONTRACT;
    const markdown = fs.readFileSync(contract.skillPath, "utf8");

    expect(contractLineValues(markdown, "Manifest")).toEqual([contract.manifestPath]);
    expect(contractLineValues(markdown, "Commands")).toEqual(
      contract.commands.map((command) => command.invocation),
    );
    expect(contractLineValues(markdown, "Public flags")).toEqual(contract.flags);
    expect(contractLineValues(markdown, "Resume stages")).toEqual(contract.resumeStages);
    for (const reference of contract.prerequisiteReferences) {
      const referencePath = path.resolve(path.dirname(contract.skillPath), reference);
      expect(fs.existsSync(referencePath), referencePath).toBe(true);
      expect(markdown, reference).toContain(`\`${reference}\``);
    }
    for (const artifact of contract.producedArtifacts) {
      expect(markdown, artifact).toContain(`\`${artifact}\``);
    }
    expect(skillArtifactValues(markdown)).toEqual(contract.producedArtifacts);
    expect(contract.producedArtifacts).toContain("09_output/rough-cut.mp4");
  });
});
