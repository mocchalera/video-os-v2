#!/usr/bin/env npx tsx

import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { runCaptionFinalize } from "../runtime/caption/caption-finalize.js";
import { buildDirectRenderRepairPlan } from "../runtime/render/direct-render-staging.js";

export const CAPTION_FINALIZE_USAGE = `Usage:
  npx tsx scripts/caption-finalize.ts run --project <dir> [options]
  npm run caption-finalize -- run --project <dir> [options]
  npx tsx scripts/caption-finalize.ts repair-direct-render --project <dir> [--source <mp4>] --dry-run

Options:
  --approval <path>       Approved caption intent (default: 07_package/caption_approval.json)
  --supplied-final <mp4>  Receipt-stage an NLE/direct render before finalization
  --supplied-final-receipt <json>
                          Required provenance from the caption-finalize generation
                          whose caption/font-burned video stream is being remuxed
  --assembly-path <mp4>   Use a fresh prebuilt engine assembly
  --skip-render           Test/validation mode; does not invoke the real renderer
  --created-at <ISO>      Deterministic receipt timestamp
  --json                  Print the result as JSON
  --dry-run               Required by repair-direct-render; performs no writes
  -h, --help              Show this help`;

export interface CaptionFinalizeCliArgs {
  command: "run" | "repair-direct-render";
  projectDir: string;
  approvalPath?: string;
  suppliedFinalPath?: string;
  suppliedFinalReceiptPath?: string;
  assemblyPath?: string;
  sourcePath?: string;
  createdAt?: string;
  skipRender: boolean;
  dryRun: boolean;
  json: boolean;
}

export function parseCaptionFinalizeArgs(argv: string[]): CaptionFinalizeCliArgs {
  const values = argv.slice(2);
  if (values.includes("--help") || values.includes("-h")) throw new Error(CAPTION_FINALIZE_USAGE);
  const commandValue = values.shift();
  if (commandValue !== "run" && commandValue !== "repair-direct-render") {
    throw new Error(`command must be run or repair-direct-render\n${CAPTION_FINALIZE_USAGE}`);
  }
  let projectDir: string | undefined;
  let approvalPath: string | undefined;
  let suppliedFinalPath: string | undefined;
  let suppliedFinalReceiptPath: string | undefined;
  let assemblyPath: string | undefined;
  let sourcePath: string | undefined;
  let createdAt: string | undefined;
  let skipRender = false;
  let dryRun = false;
  let json = false;
  for (let index = 0; index < values.length; index += 1) {
    const arg = values[index];
    if (arg === "--project") projectDir = requiredValue(values, ++index, arg);
    else if (arg === "--approval") approvalPath = requiredValue(values, ++index, arg);
    else if (arg === "--supplied-final") suppliedFinalPath = requiredValue(values, ++index, arg);
    else if (arg === "--supplied-final-receipt") {
      suppliedFinalReceiptPath = requiredValue(values, ++index, arg);
    }
    else if (arg === "--assembly-path") assemblyPath = requiredValue(values, ++index, arg);
    else if (arg === "--source") sourcePath = requiredValue(values, ++index, arg);
    else if (arg === "--created-at") createdAt = requiredValue(values, ++index, arg);
    else if (arg === "--skip-render") skipRender = true;
    else if (arg === "--dry-run") dryRun = true;
    else if (arg === "--json") json = true;
    else throw new Error(`unknown argument: ${arg}\n${CAPTION_FINALIZE_USAGE}`);
  }
  if (!projectDir) throw new Error(`--project is required\n${CAPTION_FINALIZE_USAGE}`);
  if (commandValue === "repair-direct-render" && !dryRun) {
    throw new Error("repair-direct-render currently requires --dry-run; use run --supplied-final to stage and finalize");
  }
  return {
    command: commandValue,
    projectDir: path.resolve(projectDir),
    approvalPath: approvalPath ? path.resolve(approvalPath) : undefined,
    suppliedFinalPath: suppliedFinalPath ? path.resolve(suppliedFinalPath) : undefined,
    suppliedFinalReceiptPath: suppliedFinalReceiptPath
      ? path.resolve(suppliedFinalReceiptPath)
      : undefined,
    assemblyPath: assemblyPath ? path.resolve(assemblyPath) : undefined,
    sourcePath: sourcePath ? path.resolve(sourcePath) : undefined,
    createdAt,
    skipRender,
    dryRun,
    json,
  };
}

export async function runCaptionFinalizeCli(argv = process.argv): Promise<number> {
  if (argv.slice(2).some((value) => value === "--help" || value === "-h")) {
    console.log(CAPTION_FINALIZE_USAGE);
    return 0;
  }
  let args: CaptionFinalizeCliArgs;
  try {
    args = parseCaptionFinalizeArgs(argv);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
  if (args.command === "repair-direct-render") {
    const plan = buildDirectRenderRepairPlan(args.projectDir, args.sourcePath);
    console.log(JSON.stringify(plan, null, 2));
    return plan.source_exists ? 0 : 1;
  }
  try {
    const result = await runCaptionFinalize(args.projectDir, {
      approvalPath: args.approvalPath,
      suppliedFinalPath: args.suppliedFinalPath,
      suppliedFinalReceiptPath: args.suppliedFinalReceiptPath,
      createdAt: args.createdAt,
      packageOptions: {
        skipRender: args.skipRender,
        ...(args.assemblyPath ? { assemblyPath: args.assemblyPath } : {}),
      },
    });
    if (args.json) {
      console.log(JSON.stringify({
        success: result.success,
        reused: result.reused,
        generation_id: result.generationId,
        generation_dir: result.generationDir,
        active_delivery_path: result.activeDeliveryPath,
        active_delivery: result.activeDelivery,
        receipt: result.receipt,
      }, null, 2));
    } else {
      console.log([
        `[caption-finalize] ${result.reused ? "reused" : "activated"}`,
        `generation: ${result.generationId}`,
        `active pointer: ${result.activeDeliveryPath}`,
        `final: ${path.resolve(args.projectDir, result.activeDelivery.artifacts.final_video.path)}`,
      ].join("\n"));
    }
    return 0;
  } catch (error) {
    console.error(`[caption-finalize] failed: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

function requiredValue(values: string[], index: number, flag: string): string {
  const value = values[index];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

const isMain = process.argv[1]
  ? import.meta.url === pathToFileURL(process.argv[1]).href
  : false;
if (isMain) {
  runCaptionFinalizeCli().then((code) => { process.exitCode = code; });
}
