import * as fs from "node:fs";
import { isDirectRun } from "./helpers/direct-run.js";
import {
  canonicalJsonBytes,
  writeExclusiveOutputFile,
  type ProjectionGenerationSnapshot,
} from "../runtime/release/public-projection.js";
import {
  createRepositorySecretScanArtifacts,
} from "../runtime/release/public-projection-secret-scan.js";

export interface RunPublicProjectionSecretScanArgs {
  staging: string;
  generationSnapshot: string;
  attestationOut: string;
  executionReceiptOut: string;
}

export function parseRunPublicProjectionSecretScanArgs(
  argv: string[],
): RunPublicProjectionSecretScanArgs {
  const allowed = [
    "--staging",
    "--generation-snapshot",
    "--attestation-out",
    "--execution-receipt-out",
  ];
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!allowed.includes(key)) throw new Error(`Unknown argument: ${String(key)}`);
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${key}`);
    if (values.has(key)) throw new Error(`Duplicate argument: ${key}`);
    values.set(key, value);
  }
  for (const key of allowed) if (!values.has(key)) throw new Error(`Missing required argument: ${key}`);
  if (values.get("--attestation-out") === values.get("--execution-receipt-out")) {
    throw new Error("Attestation and execution receipt outputs must differ");
  }
  return {
    staging: values.get("--staging")!,
    generationSnapshot: values.get("--generation-snapshot")!,
    attestationOut: values.get("--attestation-out")!,
    executionReceiptOut: values.get("--execution-receipt-out")!,
  };
}

export function runPublicProjectionSecretScan(
  args: RunPublicProjectionSecretScanArgs,
): ReturnType<typeof createRepositorySecretScanArtifacts> {
  const snapshotBytes = fs.readFileSync(args.generationSnapshot);
  const snapshot = JSON.parse(snapshotBytes.toString("utf8")) as ProjectionGenerationSnapshot;
  if (!snapshotBytes.equals(canonicalJsonBytes(snapshot))) {
    throw new Error("Generation snapshot must be canonical JSON");
  }
  if (snapshot.version !== "public-projection-generation/v1") {
    throw new Error("Unsupported generation snapshot version");
  }
  const artifacts = createRepositorySecretScanArtifacts({
    stagingRoot: args.staging,
    generationSnapshot: snapshot,
  });
  if (artifacts.attestation.result.status !== "clean") {
    throw new Error(
      `Secret scan blocked publication with ${artifacts.attestation.result.finding_count} finding(s)`,
    );
  }
  writeExclusiveOutputFile({
    outputPath: args.attestationOut,
    protectedRoot: args.staging,
    label: "Secret scan attestation output",
    bytes: artifacts.attestationBytes,
    mode: 0o400,
  });
  writeExclusiveOutputFile({
    outputPath: args.executionReceiptOut,
    protectedRoot: args.staging,
    label: "Secret scan execution receipt output",
    bytes: artifacts.executionReceiptBytes,
    mode: 0o400,
  });
  return artifacts;
}

function main(): void {
  try {
    const artifacts = runPublicProjectionSecretScan(
      parseRunPublicProjectionSecretScanArgs(process.argv.slice(2)),
    );
    process.stdout.write(`${artifacts.attestation.target_payload_sha256}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

if (isDirectRun(import.meta.url)) main();
