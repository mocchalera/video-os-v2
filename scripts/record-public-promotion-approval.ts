import * as fs from "node:fs";
import * as path from "node:path";
import { isDirectRun } from "./helpers/direct-run.js";
import { canonicalJsonBytes, writeExclusiveOutputFile } from "../runtime/release/public-projection.js";
import {
  createPromotionApprovalReceiptFromCockpit,
  type PromotionApprovalRequest,
} from "../runtime/release/public-promotion-adapters.js";

export function recordPublicPromotionApproval(options: {
  requestPath: string;
  taskId: string;
  askId: string;
  output: string;
}): void {
  const requestBytes = fs.readFileSync(options.requestPath);
  const request = JSON.parse(requestBytes.toString("utf8")) as PromotionApprovalRequest;
  if (!requestBytes.equals(canonicalJsonBytes(request))) {
    throw new Error("Promotion approval request must be canonical JSON");
  }
  const receipt = createPromotionApprovalReceiptFromCockpit({
    request,
    taskId: options.taskId,
    askId: options.askId,
  });
  writeExclusiveOutputFile({
    outputPath: options.output,
    protectedRoot: path.resolve("."),
    label: "Cockpit approval receipt output",
    bytes: canonicalJsonBytes(receipt),
    mode: 0o400,
  });
}

function main(): void {
  try {
    const argv = process.argv.slice(2);
    const allowed = ["--request", "--task-id", "--ask-id", "--output"];
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
    recordPublicPromotionApproval({
      requestPath: values.get("--request")!,
      taskId: values.get("--task-id")!,
      askId: values.get("--ask-id")!,
      output: values.get("--output")!,
    });
    process.stdout.write(`${path.resolve(values.get("--output")!)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

if (isDirectRun(import.meta.url)) main();
