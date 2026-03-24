// CLI entry point for checking pipeline progress.
// Usage:
//   npx tsx scripts/check-progress.ts <project-id>
//   npx tsx scripts/check-progress.ts <project-id> --json

import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { readProgress, type ProgressReport } from "../runtime/progress.js";

const USAGE = "Usage: npx tsx scripts/check-progress.ts <project-id> [--json]";

export interface CheckProgressCliArgs {
  projectId: string;
  jsonOutput: boolean;
}

export function parseArgs(argv: string[]): CheckProgressCliArgs {
  const args = argv.slice(2);
  let projectId: string | undefined;
  let jsonOutput = false;

  for (const arg of args) {
    if (arg === "--json") {
      jsonOutput = true;
    } else if (arg === "--help" || arg === "-h") {
      console.log(USAGE);
      process.exit(0);
    } else if (arg.startsWith("-")) {
      throw new Error(`Unknown argument: ${arg}`);
    } else if (!projectId) {
      projectId = arg;
    } else {
      throw new Error(`Unexpected argument: ${arg}`);
    }
  }

  if (!projectId) {
    throw new Error("Error: <project-id> is required");
  }

  return { projectId, jsonOutput };
}

export function resolveProjectDir(projectId: string): string {
  // Try as-is (absolute or relative path)
  if (fs.existsSync(path.join(path.resolve(projectId), "progress.json"))) {
    return path.resolve(projectId);
  }
  // Try under projects/
  const underProjects = path.resolve("projects", projectId);
  if (fs.existsSync(path.join(underProjects, "progress.json"))) {
    return underProjects;
  }
  // Return the projects/ path (readProgress will return null if not found)
  return fs.existsSync(underProjects) ? underProjects : path.resolve(projectId);
}

function formatDuration(sec: number | null): string {
  if (sec === null || sec === undefined) return "unknown";
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  const rem = sec % 60;
  return rem > 0 ? `${min}m ${rem}s` : `${min}m`;
}

const STATUS_ICONS: Record<string, string> = {
  running: "[RUNNING]",
  completed: "[DONE]",
  failed: "[FAILED]",
  blocked: "[BLOCKED]",
};

export function printHumanReadable(report: ProgressReport): void {
  const icon = STATUS_ICONS[report.status] ?? report.status;
  const pct = report.total > 0 ? Math.round((report.completed / report.total) * 100) : 0;

  console.log(`Project: ${report.project_id}`);
  console.log(`Phase:   ${report.phase} (gate ${report.gate})`);
  console.log(`Status:  ${icon}`);
  console.log(`Progress: ${report.completed}/${report.total} (${pct}%)`);
  console.log(`ETA:     ${formatDuration(report.eta_sec)}`);
  console.log(`Started: ${report.started_at}`);
  console.log(`Updated: ${report.updated_at}`);

  if (report.artifacts_created.length > 0) {
    console.log(`Artifacts: ${report.artifacts_created.join(", ")}`);
  }

  if (report.errors.length > 0) {
    console.log(`\nErrors (${report.errors.length}):`);
    for (const err of report.errors) {
      const retry = err.retriable ? " (retriable)" : "";
      console.log(`  - [${err.stage}] ${err.message}${retry}`);
    }
  }
}

function main(): void {
  try {
    const { projectId, jsonOutput } = parseArgs(process.argv);
    const projectDir = resolveProjectDir(projectId);
    const report = readProgress(projectDir);

    if (!report) {
      if (jsonOutput) {
        console.log(JSON.stringify({ error: "progress.json not found", project_id: projectId }));
      } else {
        console.error(`No progress.json found for project: ${projectId}`);
      }
      process.exit(1);
    }

    if (jsonOutput) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      printHumanReadable(report);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[check-progress] ${message}`);
    console.error(USAGE);
    process.exit(1);
  }
}

const isMain = process.argv[1]
  ? import.meta.url === pathToFileURL(process.argv[1]).href
  : false;

if (isMain) {
  main();
}
