import * as fs from "node:fs";
import * as path from "node:path";
import { isDirectRun } from "./helpers/direct-run.js";
import {
  verifyPublicProjectionReceipt,
  type ApprovedAttestationVerifier,
  type PublicProjectionReceipt,
} from "../runtime/release/public-projection.js";

export interface VerifyPublicProjectionCliArgs {
  source: string;
  public: string;
  policy: string;
  receipt: string;
}

export function parseVerifyPublicProjectionArgs(argv: string[]): VerifyPublicProjectionCliArgs {
  const values = new Map<string, string>();
  const allowed = ["--source", "--public", "--policy", "--receipt"];
  for (let index = 0; index < argv.length; index += 2) {
    const argument = argv[index];
    const value = argv[index + 1];
    if (!allowed.includes(argument)) throw new Error(`Unknown argument: ${argument}`);
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${argument}`);
    if (values.has(argument)) throw new Error(`Duplicate argument: ${argument}`);
    values.set(argument, value);
  }
  for (const required of allowed) {
    if (!values.has(required)) throw new Error(`Missing required argument: ${required}`);
  }
  return {
    source: values.get("--source")!,
    public: values.get("--public")!,
    policy: values.get("--policy")!,
    receipt: values.get("--receipt")!,
  };
}

export function verifyPublicProjectionWithApprovedVerifier(
  args: VerifyPublicProjectionCliArgs,
  attestationVerifier: ApprovedAttestationVerifier,
): PublicProjectionReceipt {
  return verifyPublicProjectionReceipt({
    sourceRoot: args.source,
    stagingRoot: args.public,
    policyPath: args.policy,
    receiptBytes: fs.readFileSync(args.receipt),
    attestationVerifier,
  });
}

function main(): void {
  try {
    parseVerifyPublicProjectionArgs(process.argv.slice(2));
    throw new Error(
      "Stage A verification blocked: no approved secret-scan attestation verifier is configured",
    );
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

if (isDirectRun(import.meta.url)) main();
