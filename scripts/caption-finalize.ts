#!/usr/bin/env npx tsx

import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { runCaptionFinalize } from "../runtime/caption/caption-finalize.js";
import type { LyricDeliveryOptions } from "../runtime/caption/lyric-delivery.js";
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
  --render-route-receipt <json>
                          Required output route receipt for --supplied-final;
                          route evidence is copied and bound before packaging
  --assembly-path <mp4>   Use a fresh prebuilt engine assembly
  --lyric-script <path>   LRC-style lyric script; writes burn-ready lyrics.ass
                          telops (Issue 36) alongside speech captions
  --lyric-reduced-motion  Static lyric cards: no bounce, no staccato flicker
  --lyric-tail-sec <n>    Lyric tail duration for the final line (default 4)
  --lyric-max-per-char-sec <n>  Staccato per-character slot cap (default 0.5)
  --lyric-max-hold-sec <n>      Staccato final-hold cap (default: per-char cap)
  --lyric-sections <json> JSON file of timed section ranges
                          ([{"role":"chorus","startSec":30,"endSec":60},...])
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
  renderRouteReceiptPath?: string;
  assemblyPath?: string;
  lyricScriptPath?: string;
  lyricOptions?: LyricDeliveryOptions;
  sourcePath?: string;
  createdAt?: string;
  skipRender: boolean;
  dryRun: boolean;
  json: boolean;
}

function optionalNumber(values: string[], index: number, flag: string): number | undefined {
  const raw = requiredValue(values, index, flag);
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${flag} requires a positive number, got: ${raw}`);
  }
  return value;
}

function loadLyricSections(filePath: string): NonNullable<LyricDeliveryOptions["sections"]> {
  const parsed: unknown = JSON.parse(fs.readFileSync(filePath, "utf8"));
  if (!Array.isArray(parsed)) throw new Error(`--lyric-sections must be a JSON array: ${filePath}`);
  return parsed as NonNullable<LyricDeliveryOptions["sections"]>;
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
  let renderRouteReceiptPath: string | undefined;
  let assemblyPath: string | undefined;
  let lyricScriptPath: string | undefined;
  let lyricReducedMotion = false;
  let lyricTailSec: number | undefined;
  let lyricMaxPerCharSec: number | undefined;
  let lyricMaxHoldSec: number | undefined;
  let lyricSectionsPath: string | undefined;
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
    else if (arg === "--render-route-receipt") {
      renderRouteReceiptPath = requiredValue(values, ++index, arg);
    }
    else if (arg === "--assembly-path") assemblyPath = requiredValue(values, ++index, arg);
    else if (arg === "--lyric-script") lyricScriptPath = requiredValue(values, ++index, arg);
    else if (arg === "--lyric-reduced-motion") lyricReducedMotion = true;
    else if (arg === "--lyric-tail-sec") lyricTailSec = optionalNumber(values, ++index, arg);
    else if (arg === "--lyric-max-per-char-sec") lyricMaxPerCharSec = optionalNumber(values, ++index, arg);
    else if (arg === "--lyric-max-hold-sec") lyricMaxHoldSec = optionalNumber(values, ++index, arg);
    else if (arg === "--lyric-sections") lyricSectionsPath = requiredValue(values, ++index, arg);
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
  const hasLyricOptions = lyricReducedMotion || lyricTailSec !== undefined
    || lyricMaxPerCharSec !== undefined || lyricMaxHoldSec !== undefined
    || lyricSectionsPath !== undefined;
  return {
    command: commandValue,
    projectDir: path.resolve(projectDir),
    approvalPath: approvalPath ? path.resolve(approvalPath) : undefined,
    suppliedFinalPath: suppliedFinalPath ? path.resolve(suppliedFinalPath) : undefined,
    suppliedFinalReceiptPath: suppliedFinalReceiptPath
      ? path.resolve(suppliedFinalReceiptPath)
      : undefined,
    renderRouteReceiptPath: renderRouteReceiptPath
      ? path.resolve(renderRouteReceiptPath)
      : undefined,
    assemblyPath: assemblyPath ? path.resolve(assemblyPath) : undefined,
    lyricScriptPath: lyricScriptPath ? path.resolve(lyricScriptPath) : undefined,
    lyricOptions: hasLyricOptions ? {
      ...(lyricReducedMotion ? { reducedMotion: true } : {}),
      ...(lyricTailSec !== undefined ? { tailSec: lyricTailSec } : {}),
      ...(lyricMaxPerCharSec !== undefined || lyricMaxHoldSec !== undefined ? {
        staccato: {
          ...(lyricMaxPerCharSec !== undefined ? { maxPerCharSec: lyricMaxPerCharSec } : {}),
          ...(lyricMaxHoldSec !== undefined ? { maxHoldSec: lyricMaxHoldSec } : {}),
        },
      } : {}),
      ...(lyricSectionsPath ? { sections: loadLyricSections(path.resolve(lyricSectionsPath)) } : {}),
    } : undefined,
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
      renderRouteReceiptPath: args.renderRouteReceiptPath,
      createdAt: args.createdAt,
      ...(args.lyricScriptPath ? { lyricScriptPath: args.lyricScriptPath } : {}),
      ...(args.lyricOptions ? { lyricOptions: args.lyricOptions } : {}),
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
