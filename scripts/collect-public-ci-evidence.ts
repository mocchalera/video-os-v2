import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import { devNull } from "node:os";
import * as path from "node:path";
import { isDirectRun } from "./helpers/direct-run.js";
import { canonicalJsonBytes, writeExclusiveOutputFile } from "../runtime/release/public-projection.js";
import {
  createGitHubProviderExecutionReceipt,
  readPublicPromotionTrustConfig,
} from "../runtime/release/public-promotion-adapters.js";

export interface CollectPublicCiEvidenceArgs {
  publicRepository: string;
  publicCommit: string;
  runId: string;
  output: string;
}

export function parseCollectPublicCiEvidenceArgs(argv: string[]): CollectPublicCiEvidenceArgs {
  const allowed = ["--public-repository", "--public-commit", "--run-id", "--output"];
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
    publicRepository: values.get("--public-repository")!,
    publicCommit: values.get("--public-commit")!,
    runId: values.get("--run-id")!,
    output: values.get("--output")!,
  };
}

function workflowBlob(args: CollectPublicCiEvidenceArgs): string {
  const config = readPublicPromotionTrustConfig();
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) if (!name.startsWith("GIT_")) env[name] = value;
  env.GIT_NO_REPLACE_OBJECTS = "1";
  env.GIT_CONFIG_NOSYSTEM = "1";
  env.GIT_CONFIG_GLOBAL = devNull;
  return execFileSync("git", [
    "--no-replace-objects", "rev-parse", "--verify", `${args.publicCommit}:${config.workflow.path}`,
  ], {
    cwd: args.publicRepository,
    encoding: "utf8",
    env,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

export function collectPublicCiEvidence(args: CollectPublicCiEvidenceArgs): void {
  const publicRepository = fs.realpathSync(args.publicRepository);
  const receipt = createGitHubProviderExecutionReceipt({
    runId: args.runId,
    workflowBlobSha: workflowBlob({ ...args, publicRepository }),
  });
  writeExclusiveOutputFile({
    outputPath: args.output,
    protectedRoot: publicRepository,
    label: "GitHub provider execution receipt output",
    bytes: canonicalJsonBytes(receipt),
    mode: 0o400,
  });
}

function main(): void {
  try {
    const args = parseCollectPublicCiEvidenceArgs(process.argv.slice(2));
    collectPublicCiEvidence(args);
    process.stdout.write(`${path.resolve(args.output)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

if (isDirectRun(import.meta.url)) main();
