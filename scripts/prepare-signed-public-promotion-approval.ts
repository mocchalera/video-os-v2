import * as fs from "node:fs";
import * as path from "node:path";
import { isDirectRun } from "./helpers/direct-run.js";
import { canonicalJsonBytes, writeExclusiveOutputFile } from "../runtime/release/public-projection.js";
import {
  createExternalSignedPromotionApproval,
  type PromotionApprovalRequest,
} from "../runtime/release/public-promotion-adapters.js";

export function prepareSignedPublicPromotionApproval(options: {
  requestPath: string;
  approvalId: string;
  approverIdentity: string;
  approvedAt: string;
  output: string;
  protectedRoot?: string;
}): ReturnType<typeof createExternalSignedPromotionApproval> {
  const requestBytes = fs.readFileSync(options.requestPath);
  const request = JSON.parse(requestBytes.toString("utf8")) as PromotionApprovalRequest;
  if (!requestBytes.equals(canonicalJsonBytes(request))) {
    throw new Error("Promotion approval request must be canonical JSON");
  }
  const approval = createExternalSignedPromotionApproval({
    request,
    approvalId: options.approvalId,
    approverIdentity: options.approverIdentity,
    approvedAt: options.approvedAt,
  });
  writeExclusiveOutputFile({
    outputPath: options.output,
    protectedRoot: options.protectedRoot ?? path.resolve("."),
    label: "External signed promotion approval output",
    bytes: canonicalJsonBytes(approval),
    mode: 0o400,
  });
  return approval;
}

function parseArgs(argv: string[]): {
  requestPath: string;
  approvalId: string;
  approverIdentity: string;
  approvedAt: string;
  output: string;
} {
  const allowed = [
    "--request",
    "--approval-id",
    "--approver-identity",
    "--approved-at",
    "--output",
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
  return {
    requestPath: values.get("--request")!,
    approvalId: values.get("--approval-id")!,
    approverIdentity: values.get("--approver-identity")!,
    approvedAt: values.get("--approved-at")!,
    output: values.get("--output")!,
  };
}

function main(): void {
  try {
    const args = parseArgs(process.argv.slice(2));
    const approval = prepareSignedPublicPromotionApproval(args);
    process.stdout.write(`${approval.approval_id}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

if (isDirectRun(import.meta.url)) main();
