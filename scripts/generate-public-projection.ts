import * as path from "node:path";
import { isDirectRun } from "./helpers/direct-run.js";
import {
  canonicalJsonBytes,
  generatePublicProjection,
  writeExclusiveOutputFile,
} from "../runtime/release/public-projection.js";

export interface GeneratePublicProjectionCliArgs {
  source: string;
  output: string;
  policy: string;
  noReceipt: true;
}

export function parseGeneratePublicProjectionArgs(argv: string[]): GeneratePublicProjectionCliArgs {
  const values = new Map<string, string>();
  let noReceipt = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--no-receipt") {
      noReceipt = true;
      continue;
    }
    if (!["--source", "--output", "--policy"].includes(argument)) {
      throw new Error(`Unknown argument: ${argument}`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${argument}`);
    if (values.has(argument)) throw new Error(`Duplicate argument: ${argument}`);
    values.set(argument, value);
    index += 1;
  }
  if (!noReceipt) throw new Error("--no-receipt is required; Stage A is finalized only after trusted scan");
  for (const required of ["--source", "--output", "--policy"]) {
    if (!values.has(required)) throw new Error(`Missing required argument: ${required}`);
  }
  return {
    source: values.get("--source")!,
    output: values.get("--output")!,
    policy: values.get("--policy")!,
    noReceipt: true,
  };
}

export function runGeneratePublicProjection(args: GeneratePublicProjectionCliArgs): {
  generationSnapshotPath: string;
  publicPayloadSha256: string;
} {
  const snapshot = generatePublicProjection({
    sourceRoot: args.source,
    outputRoot: args.output,
    policyPath: args.policy,
  });
  const generationSnapshotPath = `${path.resolve(args.output)}.generation.json`;
  writeExclusiveOutputFile({
    outputPath: generationSnapshotPath,
    protectedRoot: args.source,
    label: "Projection generation snapshot",
    bytes: canonicalJsonBytes(snapshot),
    mode: 0o444,
  });
  return {
    generationSnapshotPath,
    publicPayloadSha256: snapshot.public_payload_sha256,
  };
}

function main(): void {
  try {
    const result = runGeneratePublicProjection(
      parseGeneratePublicProjectionArgs(process.argv.slice(2)),
    );
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

if (isDirectRun(import.meta.url)) main();
