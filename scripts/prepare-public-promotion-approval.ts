import * as fs from "node:fs";
import * as path from "node:path";
import { isDirectRun } from "./helpers/direct-run.js";
import { canonicalJsonBytes, sha256Hex, writeExclusiveOutputFile } from "../runtime/release/public-projection.js";
import {
  approvalChoice,
  fixedPublicPromotionDestination,
  readPublicPromotionTrustConfig,
  type PromotionApprovalRequest,
} from "../runtime/release/public-promotion-adapters.js";

export function preparePublicPromotionApproval(options: {
  stageAReceipt: string;
  output: string;
}): { request: PromotionApprovalRequest; choice: string } {
  const stageABytes = fs.readFileSync(options.stageAReceipt);
  const config = readPublicPromotionTrustConfig();
  const request: PromotionApprovalRequest = {
    version: "public-promotion-approval-request/v1",
    stage_a_receipt_sha256: sha256Hex(stageABytes),
    destination: fixedPublicPromotionDestination(),
    operation_scope: {
      operation: "push-exact-projection",
      event: "push",
      workflow_path: config.workflow.path,
    },
  };
  writeExclusiveOutputFile({
    outputPath: options.output,
    protectedRoot: path.resolve("."),
    label: "Promotion approval request output",
    bytes: canonicalJsonBytes(request),
    mode: 0o400,
  });
  return { request, choice: approvalChoice(request) };
}

function main(): void {
  try {
    const argv = process.argv.slice(2);
    if (argv.length !== 4 || argv[0] !== "--stage-a" || argv[2] !== "--output") {
      throw new Error("Usage: prepare-public-promotion-approval --stage-a <receipt> --output <outside-repo-path>");
    }
    const prepared = preparePublicPromotionApproval({ stageAReceipt: argv[1], output: argv[3] });
    process.stdout.write(`${prepared.choice}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

if (isDirectRun(import.meta.url)) main();
