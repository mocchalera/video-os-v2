import * as fs from "node:fs";
import * as path from "node:path";
import { isDirectRun } from "./helpers/direct-run.js";
import { canonicalJsonBytes, writeExclusiveOutputFile } from "../runtime/release/public-projection.js";
import {
  configuredApprovalTrustRoot,
  createApprovalReceiptSignatureVerifier,
  parseExternalSignedPromotionApproval,
  readPublicPromotionTrustConfig,
  unconfiguredApprovalSignatureHandoff,
  type PromotionApprovalRequest,
} from "../runtime/release/public-promotion-adapters.js";

export function recordSignedPublicPromotionApproval(options: {
  requestPath: string;
  approvalPath: string;
  signaturePath: string;
  output: string;
  protectedRoot?: string;
}): void {
  const config = readPublicPromotionTrustConfig();
  if (!config.approval_authentication.configured) {
    throw Object.assign(new Error(unconfiguredApprovalSignatureHandoff().blocked_reason), {
      handoff: unconfiguredApprovalSignatureHandoff(),
    });
  }
  const requestBytes = fs.readFileSync(options.requestPath);
  const request = JSON.parse(requestBytes.toString("utf8")) as PromotionApprovalRequest;
  if (!requestBytes.equals(canonicalJsonBytes(request))) {
    throw new Error("Promotion approval request must be canonical JSON");
  }
  const approvalBytes = fs.readFileSync(options.approvalPath);
  parseExternalSignedPromotionApproval(approvalBytes, request);
  const trustRoot = configuredApprovalTrustRoot();
  const verified = createApprovalReceiptSignatureVerifier(
    trustRoot,
    options.signaturePath,
    request,
  ).verify(approvalBytes);
  if (!approvalBytes.equals(canonicalJsonBytes(verified.evidence))) {
    throw new Error("External signed approval is not canonical JSON");
  }
  writeExclusiveOutputFile({
    outputPath: options.output,
    protectedRoot: options.protectedRoot ?? path.resolve("."),
    label: "External signed promotion approval receipt output",
    bytes: approvalBytes,
    mode: 0o400,
  });
}

function parseArgs(argv: string[]): {
  requestPath: string;
  approvalPath: string;
  signaturePath: string;
  output: string;
} {
  const allowed = ["--request", "--approval", "--signature", "--output"];
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
  return {
    requestPath: values.get("--request")!,
    approvalPath: values.get("--approval")!,
    signaturePath: values.get("--signature")!,
    output: values.get("--output")!,
  };
}

function main(): void {
  try {
    const args = parseArgs(process.argv.slice(2));
    recordSignedPublicPromotionApproval(args);
    process.stdout.write(`${path.resolve(args.output)}\n`);
  } catch (error) {
    const handoff = (error as { handoff?: unknown }).handoff;
    if (handoff) {
      process.stderr.write(canonicalJsonBytes(handoff).toString("utf8"));
    } else {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    }
    process.exitCode = 1;
  }
}

if (isDirectRun(import.meta.url)) main();
