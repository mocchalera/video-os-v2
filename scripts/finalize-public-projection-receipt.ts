import * as fs from "node:fs";
import * as path from "node:path";
import { isDirectRun } from "./helpers/direct-run.js";
import {
  buildPublicProjectionReceipt,
  canonicalJsonBytes,
  type ApprovedAttestationVerifier,
  type ProjectionGenerationSnapshot,
  type PublicProjectionReceipt,
  writeExclusiveOutputFile,
} from "../runtime/release/public-projection.js";
import {
  createBoundRepositorySecretScanVerifier,
} from "../runtime/release/public-projection-secret-scan.js";

interface FinalizePublicProjectionCommonArgs {
  source: string;
  staging: string;
  policy: string;
  scanAttestation: string;
  receiptOut: string;
  generationSnapshot: string;
}

export type FinalizePublicProjectionCliArgs = FinalizePublicProjectionCommonArgs & (
  | { scanSignature: string; wrapperExecutionReceipt?: never }
  | { scanSignature?: never; wrapperExecutionReceipt: string }
);

function parsePairs(
  argv: string[],
  allowed: string[],
): Map<string, string> {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const argument = argv[index];
    const value = argv[index + 1];
    if (!allowed.includes(argument)) throw new Error(`Unknown argument: ${argument}`);
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${argument}`);
    if (values.has(argument)) throw new Error(`Duplicate argument: ${argument}`);
    values.set(argument, value);
  }
  return values;
}

export function parseFinalizePublicProjectionArgs(argv: string[]): FinalizePublicProjectionCliArgs {
  const allowed = [
    "--source",
    "--staging",
    "--policy",
    "--scan-attestation",
    "--scan-signature",
    "--wrapper-execution-receipt",
    "--receipt-out",
    "--generation-snapshot",
  ];
  const values = parsePairs(argv, allowed);
  for (const required of [
    "--source",
    "--staging",
    "--policy",
    "--scan-attestation",
    "--receipt-out",
  ]) {
    if (!values.has(required)) throw new Error(`Missing required argument: ${required}`);
  }
  const hasSignature = values.has("--scan-signature");
  const hasWrapperReceipt = values.has("--wrapper-execution-receipt");
  if (hasSignature === hasWrapperReceipt) {
    throw new Error(
      "Exactly one of --scan-signature or --wrapper-execution-receipt is required",
    );
  }
  const staging = values.get("--staging")!;
  const common: FinalizePublicProjectionCommonArgs = {
    source: values.get("--source")!,
    staging,
    policy: values.get("--policy")!,
    scanAttestation: values.get("--scan-attestation")!,
    receiptOut: values.get("--receipt-out")!,
    generationSnapshot: values.get("--generation-snapshot")
      ?? `${path.resolve(staging)}.generation.json`,
  };
  return hasSignature
    ? { ...common, scanSignature: values.get("--scan-signature")! }
    : {
        ...common,
        wrapperExecutionReceipt: values.get("--wrapper-execution-receipt")!,
      };
}

export function finalizePublicProjectionReceiptWithApprovedVerifier(
  args: FinalizePublicProjectionCliArgs,
  attestationVerifier: ApprovedAttestationVerifier,
): PublicProjectionReceipt {
  const generationSnapshot = JSON.parse(
    fs.readFileSync(args.generationSnapshot, "utf8"),
  ) as ProjectionGenerationSnapshot;
  const verificationEvidence = args.scanSignature !== undefined
    ? { signatureBytes: fs.readFileSync(args.scanSignature) }
    : {
        verificationEvidence: {
          mechanism: "approved-wrapper-execution-receipt" as const,
          bytes: fs.readFileSync(args.wrapperExecutionReceipt!),
        },
      };
  const receipt = buildPublicProjectionReceipt({
    sourceRoot: args.source,
    stagingRoot: args.staging,
    policyPath: args.policy,
    generationSnapshot,
    attestationBytes: fs.readFileSync(args.scanAttestation),
    ...verificationEvidence,
    attestationVerifier,
  });
  writeExclusiveOutputFile({
    outputPath: args.receiptOut,
    protectedRoot: args.staging,
    label: "Stage A receipt output",
    bytes: canonicalJsonBytes(receipt),
    mode: 0o444,
  });
  return receipt;
}

function main(): void {
  try {
    const args = parseFinalizePublicProjectionArgs(process.argv.slice(2));
    if (args.scanSignature !== undefined) {
      throw new Error(
        "Stage A detached scan signatures are not configured; use the approved repository execution receipt route",
      );
    }
    const receipt = finalizePublicProjectionReceiptWithApprovedVerifier(
      args,
      createBoundRepositorySecretScanVerifier({ stagingRoot: args.staging }),
    );
    process.stdout.write(`${receipt.public_payload_sha256}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

if (isDirectRun(import.meta.url)) main();
