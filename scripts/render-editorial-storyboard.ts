#!/usr/bin/env npx tsx
/**
 * Render an editorial storyboard review projection (Issue #7).
 *
 * Usage:
 *   npx tsx scripts/render-editorial-storyboard.ts <projectDir> \
 *     --source blueprint|timeline|compare --delivery <profileId>|all \
 *     [--output <dir>] [--generated-at <iso>] [--skip-frames]
 *
 * Stale check:
 *   npx tsx scripts/render-editorial-storyboard.ts <projectDir> \
 *     --check-stale 04_plan/review-projections/<projection-id>
 *
 * Exit codes: 0 = ok/CURRENT, 1 = usage or generation error,
 * 2 = STALE (approval not allowed), 3 = INVALID.
 */

import * as path from "node:path";
import { pathToFileURL } from "node:url";
import {
  generateEditorialStoryboard,
  StoryboardGenerateError,
} from "../runtime/review/editorial-storyboard/generate.js";
import { evaluateStaleness, readProjectionManifest } from "../runtime/review/editorial-storyboard/manifest.js";

const USAGE = `Usage:
  npx tsx scripts/render-editorial-storyboard.ts <projectDir> --source blueprint|timeline|compare --delivery <deliveryProfileId>|all [options]

Modes:
  blueprint  compile-time plan review (default)
  timeline   compiled placement review (requires 05_timeline/timeline.json)
  compare    blueprint vs compiled timeline diff review

Delivery:
  <deliveryProfileId>  a profile in 07_package/delivery_profiles
  all                  every registered delivery profile side by side
  none                 no delivery profiles; source aspect used, ratio not inferred

Options:
  --output <dir>        projection output directory override
  --generated-at <iso>  deterministic generated_at override (testing)
  --skip-frames         skip ffmpeg extraction entirely (explicit warnings)
  --check-stale <dir>   evaluate an existing projection instead of generating

Exit codes: 0 ok / CURRENT · 1 error · 2 STALE · 3 INVALID`;

export interface StoryboardCliArgs {
  projectDir: string;
  sourceMode: "blueprint" | "timeline" | "compare";
  delivery: string | "all" | null;
  outputDir?: string;
  generatedAt?: string;
  skipFrames: boolean;
  checkStaleDir?: string;
}

export function parseStoryboardArgs(argv: string[]): StoryboardCliArgs {
  const values = argv.slice(2);
  let projectDir: string | undefined;
  let sourceMode: StoryboardCliArgs["sourceMode"] = "blueprint";
  let delivery: string | "all" | null | undefined;
  let outputDir: string | undefined;
  let generatedAt: string | undefined;
  let skipFrames = false;
  let checkStaleDir: string | undefined;

  for (let i = 0; i < values.length; i += 1) {
    const arg = values[i];
    if (arg === "--help" || arg === "-h") throw new Error(USAGE);
    else if (arg === "--source") sourceMode = parseSourceMode(required(values, ++i, arg));
    else if (arg === "--delivery") delivery = parseDelivery(required(values, ++i, arg));
    else if (arg === "--output") outputDir = required(values, ++i, arg);
    else if (arg === "--generated-at") generatedAt = required(values, ++i, arg);
    else if (arg === "--skip-frames") skipFrames = true;
    else if (arg === "--check-stale") checkStaleDir = required(values, ++i, arg);
    else if (!arg.startsWith("--") && projectDir === undefined) projectDir = arg;
    else throw new Error(`Unknown argument: ${arg}\n${USAGE}`);
  }

  if (!projectDir) throw new Error(`projectDir is required\n${USAGE}`);
  if (delivery === undefined) delivery = "all";
  if (generatedAt !== undefined && Number.isNaN(Date.parse(generatedAt))) {
    throw new Error(`--generated-at must be an ISO timestamp, got: ${generatedAt}`);
  }
  if (sourceMode !== "blueprint" && delivery !== "all" && !checkStaleDir) {
    // timeline/compare modes still accept any delivery scope; nothing to do here.
  }

  return {
    projectDir: path.resolve(projectDir),
    sourceMode,
    delivery,
    outputDir: outputDir ? path.resolve(outputDir) : undefined,
    generatedAt,
    skipFrames,
    checkStaleDir: checkStaleDir ? path.resolve(checkStaleDir) : undefined,
  };
}

function parseSourceMode(value: string): StoryboardCliArgs["sourceMode"] {
  if (value === "blueprint" || value === "timeline" || value === "compare") return value;
  throw new Error(`--source must be blueprint|timeline|compare, got: ${value}`);
}

function parseDelivery(value: string): string | "all" | null {
  if (value === "all") return "all";
  if (value === "none" || value === "source") return null;
  return value;
}

function required(values: string[], index: number, flag: string): string {
  const value = values[index];
  if (value === undefined || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

export interface CheckStaleOutcome {
  status: "CURRENT" | "STALE" | "INVALID" | "error";
  exitCode: number;
  report: Record<string, unknown>;
}

/** Evaluate an existing projection's staleness without regenerating. */
export function runCheckStale(projectDir: string, projectionDir: string): CheckStaleOutcome {
  const read = readProjectionManifest(projectionDir);
  if (!read.manifest) {
    return {
      status: "error",
      exitCode: 1,
      report: { ok: false, error: read.error },
    };
  }
  const result = evaluateStaleness({ projectDir: path.resolve(projectDir), manifest: read.manifest });
  return {
    status: result.status,
    exitCode: result.status === "CURRENT" ? 0 : result.status === "STALE" ? 2 : 3,
    report: {
      ok: true,
      projection_id: read.manifest.projection_id,
      status: result.status,
      approval_allowed: result.approval_allowed,
      approval_target: {
        artifact_hashes: read.manifest.approval_identity.artifact_hashes,
        delivery_hash: read.manifest.approval_identity.delivery_hash,
        beat_count: read.manifest.approval_identity.beat_count,
        total_frames: read.manifest.approval_identity.total_frames,
      },
      stale_inputs: result.stale_inputs,
      missing_inputs: result.missing_inputs,
      receipt_status: result.receipt_status,
      receipt_detail: result.receipt_detail,
      regenerate_command: result.regenerate_command,
      note:
        result.status === "CURRENT"
          ? "projection matches canonical artifacts"
          : "projection must not be approved; regenerate before review",
    },
  };
}

async function main(argv: string[]): Promise<number> {
  const args = parseStoryboardArgs(argv);
  if (args.checkStaleDir) {
    const outcome = runCheckStale(args.projectDir, args.checkStaleDir);
    console.log(JSON.stringify(outcome.report, null, 2));
    return outcome.exitCode;
  }
  const result = await generateEditorialStoryboard({
    projectDir: args.projectDir,
    sourceMode: args.sourceMode,
    delivery: args.delivery as string | "all" | null,
    outputDir: args.outputDir,
    generatedAt: args.generatedAt,
    skipFrames: args.skipFrames,
  });
  console.log(
    JSON.stringify(
      {
        ok: true,
        projection_id: result.projectionId,
        projection_dir: result.projectionDir,
        status: result.manifest.invalid.length > 0 ? "INVALID (with warnings)" : "generated",
        beat_count: result.manifest.beat_count,
        total_frames: result.manifest.total_frames,
        warnings: result.warnings,
        next: `npx tsx scripts/render-editorial-storyboard.ts ${args.projectDir} --check-stale ${result.projectionDir}`,
      },
      null,
      2,
    ),
  );
  return 0;
}

async function cliMain(): Promise<void> {
  try {
    process.exitCode = await main(process.argv);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = error instanceof StoryboardGenerateError ? 1 : 1;
  }
}

const isMain = process.argv[1]
  ? import.meta.url === pathToFileURL(process.argv[1]).href
  : false;
if (isMain) void cliMain();
