#!/usr/bin/env tsx

import { promoteStudioPatchFiles } from "../runtime/eval/studio-patch-promoter.js";

interface CLIArgs {
  projectPath: string;
  patchPath: string;
  dryRun: boolean;
  json: boolean;
  backupTimelinePath?: string;
}

const USAGE = "Usage: npx tsx scripts/promote-studio-patch.ts --project <path> --patch <file> [--backup-timeline <file>] [--dry-run] [--json]";

function parseArgs(argv: string[] = process.argv): CLIArgs {
  const args = argv.slice(2);
  let projectPath: string | undefined;
  let patchPath: string | undefined;
  let backupTimelinePath: string | undefined;
  let dryRun = false;
  let json = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--help" || arg === "-h") {
      throw new Error(USAGE);
    }
    if (arg === "--project" && index + 1 < args.length) {
      projectPath = args[++index];
      continue;
    }
    if (arg === "--patch" && index + 1 < args.length) {
      patchPath = args[++index];
      continue;
    }
    if (arg === "--backup-timeline" && index + 1 < args.length) {
      backupTimelinePath = args[++index];
      continue;
    }
    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (arg === "--json") {
      json = true;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}\n${USAGE}`);
  }

  if (!projectPath) throw new Error(`Missing --project.\n${USAGE}`);
  if (!patchPath) throw new Error(`Missing --patch.\n${USAGE}`);
  return { projectPath, patchPath, backupTimelinePath, dryRun, json };
}

function main() {
  const args = parseArgs();
  const result = promoteStudioPatchFiles(args.projectPath, args.patchPath, {
    dryRun: args.dryRun,
    backupTimelinePath: args.backupTimelinePath,
  });

  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`applied_ops: ${result.applied_ops}`);
    console.log(`skipped_ops: ${result.skipped_ops}`);
    console.log(`selects_modified: ${result.selects_modified}`);
    console.log(`blueprint_modified: ${result.blueprint_modified}`);
    console.log(`modified_beat_ids: ${result.modified_beat_ids.join(",") || "-"}`);
    for (const warning of result.warnings) {
      console.log(`warning: ${warning}`);
    }
  }

  if (result.applied_ops === 0) {
    process.exitCode = 1;
  }
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
