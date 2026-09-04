#!/usr/bin/env npx tsx

import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { publishDegradedProjectOutput } from "../runtime/artifacts/project-writer-guard.js";

interface Args { projectDir: string; sourcePath: string; outputPath: string; receiptPath: string }

const USAGE = "Usage: npx tsx scripts/project-output-writer.ts --project <dir> --source <review-file> --output <project/09_output/file> --degraded-route-receipt <project/06_review/receipt.json>";

function value(argv: string[], index: number, flag: string): string {
  const candidate = argv[index];
  if (!candidate || candidate.startsWith("--")) throw new Error(`${flag} requires a value`);
  return candidate;
}

export function parseProjectOutputWriterArgs(argv: string[]): Args {
  let projectDir: string | undefined;
  let sourcePath: string | undefined;
  let outputPath: string | undefined;
  let receiptPath: string | undefined;
  const values = argv.slice(2);
  for (let index = 0; index < values.length; index += 1) {
    const flag = values[index];
    if (flag === "--project") projectDir = path.resolve(value(values, ++index, flag));
    else if (flag === "--source") sourcePath = path.resolve(value(values, ++index, flag));
    else if (flag === "--output") outputPath = path.resolve(value(values, ++index, flag));
    else if (flag === "--degraded-route-receipt") receiptPath = path.resolve(value(values, ++index, flag));
    else if (flag === "--help" || flag === "-h") throw new Error(USAGE);
    else throw new Error(`Unknown argument: ${flag}`);
  }
  if (!projectDir || !sourcePath || !outputPath || !receiptPath) throw new Error(USAGE);
  return { projectDir, sourcePath, outputPath, receiptPath };
}

export function runProjectOutputWriter(argv = process.argv, now?: string): Record<string, unknown> {
  const args = parseProjectOutputWriterArgs(argv);
  const receipt = publishDegradedProjectOutput({ ...args, now });
  return {
    status: "review_only_degraded",
    output_path: args.outputPath,
    output_hash: receipt.output.sha256,
    production_approval: receipt.production_approval,
    replaced_canonical: receipt.replaced_canonical,
  };
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  try {
    console.log(JSON.stringify(runProjectOutputWriter(), null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
