import { pathToFileURL } from "node:url";
import {
  compareAndWriteProjectTimelines,
} from "../runtime/compare/timelines.js";

export interface CompareTimelinesCliArgs {
  projectA: string;
  projectB: string;
  stdout: boolean;
}

export function parseArgs(argv: string[]): CompareTimelinesCliArgs {
  const args = argv.slice(2);
  const positional: string[] = [];
  let stdout = false;

  for (const arg of args) {
    if (arg === "--stdout") {
      stdout = true;
      continue;
    }
    positional.push(arg);
  }

  if (positional.length !== 2) {
    throw new Error(
      "Usage: npx tsx scripts/compare-timelines.ts <project-a> <project-b> [--stdout]",
    );
  }

  return {
    projectA: positional[0],
    projectB: positional[1],
    stdout,
  };
}

export function main(argv = process.argv): void {
  const args = parseArgs(argv);
  const result = compareAndWriteProjectTimelines(args.projectA, args.projectB);

  if (args.stdout) {
    process.stdout.write(`${JSON.stringify(result.report, null, 2)}\n`);
    return;
  }

  console.log(`Comparison JSON: ${result.json_path}`);
  console.log(`Comparison HTML: ${result.html_path}`);
}

const isMain = process.argv[1]
  ? import.meta.url === pathToFileURL(process.argv[1]).href
  : false;

if (isMain) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
