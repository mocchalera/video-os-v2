#!/usr/bin/env tsx

import * as fs from "node:fs";
import * as path from "node:path";
import {
  evaluateBriefAlignment,
  renderBriefAlignmentMarkdown,
  type EvaluateBriefAlignmentOptions,
} from "../runtime/eval/brief-alignment.js";

function usage(): never {
  console.error(
    "Usage: npx tsx scripts/eval-brief-alignment.ts --project <dir> [--stage selects,blueprint] [--no-llm]",
  );
  process.exit(1);
}

function parseArgs(argv: string[]): { projectDir: string; options: EvaluateBriefAlignmentOptions } {
  let projectDir = "";
  const options: EvaluateBriefAlignmentOptions = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--project") {
      projectDir = argv[++i] ?? "";
    } else if (arg === "--stage") {
      const raw = argv[++i] ?? "";
      const stages = raw.split(",").map((stage) => stage.trim()).filter(Boolean);
      const valid = stages.every((stage) => stage === "selects" || stage === "blueprint");
      if (!valid) usage();
      options.stages = stages as Array<"selects" | "blueprint">;
    } else if (arg === "--no-llm") {
      options.useLlm = false;
    } else {
      usage();
    }
  }
  if (!projectDir) usage();
  return { projectDir, options };
}

function timestampForFile(value: string): string {
  return value.replace(/[:.]/g, "-");
}

async function main(): Promise<void> {
  const { projectDir, options } = parseArgs(process.argv.slice(2));
  const absProject = path.resolve(projectDir);
  const report = await evaluateBriefAlignment(absProject, options);
  const reportsDir = path.resolve("reports/eval");
  fs.mkdirSync(reportsDir, { recursive: true });
  const base = `brief-alignment-${report.project}_${timestampForFile(report.evaluated_at)}`;
  const jsonPath = path.join(reportsDir, `${base}.json`);
  const mdPath = path.join(reportsDir, `${base}.md`);
  fs.writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
  fs.writeFileSync(mdPath, renderBriefAlignmentMarkdown(report));
  console.log(`Brief alignment composite: ${(report.composite * 100).toFixed(1)}%`);
  console.log(`JSON: ${jsonPath}`);
  console.log(`Markdown: ${mdPath}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
