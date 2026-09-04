#!/usr/bin/env tsx

import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import {
  auditSkillContracts,
  SKILL_CONTRACT_SEVERITIES,
  skillContractExitCode,
  type SkillContractAuditResult,
  type SkillContractIssue,
} from "../runtime/skill-contracts/verify.js";
import {
  AGENT_SKILL_CONTRACTS_MANIFEST_PATH,
  serializeAgentSkillContractsManifest,
} from "./generate-agent-skill-contracts.js";

function formatIssue(issue: SkillContractIssue): string {
  return `[${issue.severity.toUpperCase()}] ${issue.code} ${issue.file}:${issue.line} `
    + `${JSON.stringify(issue.reference)} - ${issue.message}`;
}

export function appendManifestStaleIssue(
  result: SkillContractAuditResult,
  rootDir: string,
): void {
  const manifestPath = path.resolve(rootDir, AGENT_SKILL_CONTRACTS_MANIFEST_PATH);
  const expectedManifest = serializeAgentSkillContractsManifest();
  const actualManifest = fs.existsSync(manifestPath) ? fs.readFileSync(manifestPath, "utf8") : "";
  if (actualManifest === expectedManifest) return;
  result.issues.push({
    severity: SKILL_CONTRACT_SEVERITIES.manifest_stale,
    code: "manifest_stale",
    file: AGENT_SKILL_CONTRACTS_MANIFEST_PATH,
    line: 1,
    reference: AGENT_SKILL_CONTRACTS_MANIFEST_PATH,
    message: "Generated Agent Skill contract manifest is stale",
  });
}

export function main(argv: string[] = process.argv): number {
  const rootDir = path.resolve(".");
  const result = auditSkillContracts({ rootDir });
  appendManifestStaleIssue(result, rootDir);
  result.issues.sort((left, right) =>
    left.file.localeCompare(right.file)
    || left.line - right.line
    || left.code.localeCompare(right.code)
    || left.reference.localeCompare(right.reference));

  for (const issue of result.issues) console.log(formatIssue(issue));
  const errors = result.issues.filter((issue) => issue.severity === "error").length;
  const warnings = result.issues.filter((issue) => issue.severity === "warn").length;
  console.log(
    `Skill contract audit: documents=${result.documents.length} `
    + `artifacts=${result.verifiedArtifacts}/${result.artifactDeclarations} `
    + `errors=${errors} warnings=${warnings}`,
  );
  return skillContractExitCode(result.issues, argv.includes("--check"));
}

const isDirectRun = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) process.exitCode = main();
