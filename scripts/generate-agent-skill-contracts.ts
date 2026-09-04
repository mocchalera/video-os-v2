#!/usr/bin/env tsx

import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { SHORT_SOUND_DESIGN_AGENT_SKILL_CONTRACT } from "../runtime/audio/sound-design-contract.js";
import { FULL_PIPELINE_AGENT_SKILL_CONTRACT } from "../runtime/pipeline/full-pipeline-contract.js";

export const AGENT_SKILL_CONTRACTS_MANIFEST_PATH =
  FULL_PIPELINE_AGENT_SKILL_CONTRACT.manifestPath;

export function buildAgentSkillContractsManifest(): object {
  return {
    schemaVersion: 1,
    generatedFrom: [
      "runtime/pipeline/full-pipeline-contract.ts",
      "runtime/audio/sound-design-contract.ts",
    ],
    skills: {
      [FULL_PIPELINE_AGENT_SKILL_CONTRACT.skillName]: {
        skillPath: FULL_PIPELINE_AGENT_SKILL_CONTRACT.skillPath,
        commands: FULL_PIPELINE_AGENT_SKILL_CONTRACT.commands,
        flags: FULL_PIPELINE_AGENT_SKILL_CONTRACT.flags,
        resumeStages: FULL_PIPELINE_AGENT_SKILL_CONTRACT.resumeStages,
        prerequisiteReferences: FULL_PIPELINE_AGENT_SKILL_CONTRACT.prerequisiteReferences,
        producedArtifacts: FULL_PIPELINE_AGENT_SKILL_CONTRACT.producedArtifacts,
      },
      [SHORT_SOUND_DESIGN_AGENT_SKILL_CONTRACT.skillName]: {
        skillPath: SHORT_SOUND_DESIGN_AGENT_SKILL_CONTRACT.skillPath,
        commands: SHORT_SOUND_DESIGN_AGENT_SKILL_CONTRACT.commands,
        flags: SHORT_SOUND_DESIGN_AGENT_SKILL_CONTRACT.flags,
        commandFlagContracts: SHORT_SOUND_DESIGN_AGENT_SKILL_CONTRACT.commandFlagContracts,
        prerequisiteReferences:
          SHORT_SOUND_DESIGN_AGENT_SKILL_CONTRACT.prerequisiteReferences,
        producedArtifacts:
          SHORT_SOUND_DESIGN_AGENT_SKILL_CONTRACT.producedArtifacts,
      },
    },
  };
}

export function serializeAgentSkillContractsManifest(): string {
  return `${JSON.stringify(buildAgentSkillContractsManifest(), null, 2)}\n`;
}

export function main(argv: string[] = process.argv): number {
  const outputPath = path.resolve(AGENT_SKILL_CONTRACTS_MANIFEST_PATH);
  const expected = serializeAgentSkillContractsManifest();
  if (argv.includes("--check")) {
    const actual = fs.existsSync(outputPath) ? fs.readFileSync(outputPath, "utf8") : "";
    if (actual === expected) {
      console.log(`Agent Skill contracts are current: ${AGENT_SKILL_CONTRACTS_MANIFEST_PATH}`);
      return 0;
    }
    console.error(`Agent Skill contracts are stale: ${AGENT_SKILL_CONTRACTS_MANIFEST_PATH}`);
    return 1;
  }

  fs.writeFileSync(outputPath, expected, "utf8");
  console.log(`Generated ${AGENT_SKILL_CONTRACTS_MANIFEST_PATH}`);
  return 0;
}

const isDirectRun =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) process.exitCode = main();
