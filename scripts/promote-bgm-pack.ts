#!/usr/bin/env npx tsx

import { pathToFileURL } from "node:url";
import {
  BgmPackPromotionError,
  buildBgmPromotionPlan,
  defaultBgmPromotionOutputPath,
  materializeBgmCandidatePack,
  validateBgmPromotionOutputPath,
  type BuildBgmPromotionPlanOptions,
  type BgmPackMaterializationResult,
  type BgmPromotionPlan,
  type MaterializeBgmCandidatePackOptions,
} from "../runtime/music/pack-promotion.js";

const USAGE = [
  "Usage: npm run bgm:promote-pack -- --source-root <directory> [options]",
  "",
  "Promote the generated Core BGM candidates into a new, verified local Video OS Pack.",
  "The command never modifies source audio and never overwrites an existing output.",
  "",
  "Options:",
  "  --source-root <directory>  Root containing candidate batch analysis/input directories",
  "  --output <directory>       New version directory (default: user Pack Registry path)",
  "  --dry-run                  Verify all candidates and print the deterministic plan only",
  "  --json                     Emit machine-readable output",
  "  --help                     Show this help",
].join("\n");

export interface PromoteBgmPackCliIo {
  stdout: Pick<NodeJS.WriteStream, "write">;
  stderr: Pick<NodeJS.WriteStream, "write">;
}

interface PromoteBgmPackCliArgs {
  sourceRoot: string;
  output?: string;
  dryRun: boolean;
  json: boolean;
  help: boolean;
}

export interface PromoteBgmPackCliDependencies {
  now: () => Date;
  plan: (options: BuildBgmPromotionPlanOptions) => BgmPromotionPlan;
  materialize: (options: MaterializeBgmCandidatePackOptions) => BgmPackMaterializationResult;
}

export const PROMOTE_BGM_PACK_CLI_EXIT = {
  ok: 0,
  usage: 2,
  unavailable: 3,
  integrity: 4,
  internal: 5,
} as const;

function parseArgs(argv: string[]): PromoteBgmPackCliArgs {
  const values = argv.slice(2);
  let sourceRoot: string | undefined;
  let output: string | undefined;
  let dryRun = false;
  let json = false;
  let help = false;

  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--source-root" && values[index + 1] && !values[index + 1].startsWith("--")) {
      sourceRoot = values[++index];
    } else if (value === "--output" && values[index + 1] && !values[index + 1].startsWith("--")) {
      output = values[++index];
    } else if (value === "--dry-run") {
      dryRun = true;
    } else if (value === "--json") {
      json = true;
    } else if (value === "--help" || value === "-h") {
      help = true;
    } else {
      throw new Error("usage");
    }
  }
  if (!help && !sourceRoot) throw new Error("usage");
  return {
    sourceRoot: sourceRoot ?? "",
    ...(output ? { output } : {}),
    dryRun,
    json,
    help,
  };
}

function writeJson(io: PromoteBgmPackCliIo, value: unknown): void {
  io.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function selectionSummary(plan: BgmPromotionPlan): Array<Record<string, unknown>> {
  return plan.selections.map((selection) => ({
    track_id: selection.track_id,
    stable_id: selection.stable_id,
    source_content_hash: selection.source_content_hash,
    source_size_bytes: selection.source_size_bytes,
    generation_id: selection.generation_id,
    generated_at: selection.generated_at,
    duration_seconds: selection.duration_seconds,
    normalized_bpm: selection.normalized_bpm,
    technical_score: selection.technical_score,
  }));
}

function successPayload(
  plan: BgmPromotionPlan,
  outputPath: string,
  wrotePack: boolean,
  materialization?: BgmPackMaterializationResult,
): Record<string, unknown> {
  return {
    ok: true,
    command: "promote-bgm-pack",
    dry_run: !wrotePack,
    wrote_pack: wrotePack,
    output_path: outputPath,
    pack_id: plan.pack_id,
    pack_version: plan.pack_version,
    status: plan.status,
    candidate_count: plan.candidate_count,
    family_count: plan.family_count,
    selections: selectionSummary(plan),
    selection_method: plan.selection_method,
    source_integrity: plan.source_integrity,
    human_gates: plan.human_gates,
    release_status: plan.release_status,
    ...(materialization ? {
      registry_verification: {
        ok: materialization.verification.ok,
        pack_ref: materialization.verification.pack_ref,
        tracks: materialization.manifest.tracks.length,
        files_checked: materialization.verification.files_checked,
        bytes_checked: materialization.verification.bytes_checked,
        issues: materialization.verification.issues,
      },
    } : {}),
  };
}

function promotionExit(error: BgmPackPromotionError): number {
  if (error.code === "BGM_PACK_NOT_FOUND" || error.code === "BGM_PACK_BUSY") {
    return PROMOTE_BGM_PACK_CLI_EXIT.unavailable;
  }
  return PROMOTE_BGM_PACK_CLI_EXIT.integrity;
}

export async function runPromoteBgmPackCli(
  argv: string[] = process.argv,
  io: PromoteBgmPackCliIo = { stdout: process.stdout, stderr: process.stderr },
  dependencies: PromoteBgmPackCliDependencies = {
    now: () => new Date(),
    plan: buildBgmPromotionPlan,
    materialize: materializeBgmCandidatePack,
  },
): Promise<number> {
  const jsonRequested = argv.includes("--json");
  let args: PromoteBgmPackCliArgs;
  try {
    args = parseArgs(argv);
  } catch {
    if (jsonRequested) {
      writeJson(io, {
        ok: false,
        command: "promote-bgm-pack",
        issues: [{ code: "BGM_PROMOTION_USAGE", message: "Invalid BGM Pack promotion arguments." }],
      });
    } else {
      io.stderr.write(`${USAGE}\n`);
    }
    return PROMOTE_BGM_PACK_CLI_EXIT.usage;
  }

  if (args.help) {
    io.stdout.write(`${USAGE}\n`);
    return PROMOTE_BGM_PACK_CLI_EXIT.ok;
  }

  const createdAt = dependencies.now().toISOString();
  try {
    const outputPath = args.output ?? defaultBgmPromotionOutputPath();
    if (args.dryRun) {
      const validatedOutput = validateBgmPromotionOutputPath(outputPath, args.sourceRoot);
      const plan = dependencies.plan({ sourceRoot: args.sourceRoot, createdAt });
      if (args.json) writeJson(io, successPayload(plan, validatedOutput, false));
      else {
        io.stdout.write(
          `Verified ${plan.candidate_count} candidates; ${plan.family_count} family selections are ready for ${validatedOutput}.\n`,
        );
      }
      return PROMOTE_BGM_PACK_CLI_EXIT.ok;
    }

    const materialization = dependencies.materialize({
      sourceRoot: args.sourceRoot,
      outputPath,
      createdAt,
    });
    if (args.json) {
      writeJson(
        io,
        successPayload(materialization.plan, materialization.output_path, true, materialization),
      );
    } else {
      io.stdout.write(
        `Created verified candidate Pack ${materialization.manifest.pack_id}@${materialization.manifest.pack_version} with ${materialization.manifest.tracks.length} tracks at ${materialization.output_path}.\n`,
      );
    }
    return PROMOTE_BGM_PACK_CLI_EXIT.ok;
  } catch (error) {
    if (error instanceof BgmPackPromotionError) {
      const payload = {
        ok: false,
        command: "promote-bgm-pack",
        issues: [{
          code: error.code,
          message: error.message,
          recoverable: error.recoverable,
          affected_ref: error.affected_ref,
        }],
      };
      if (args.json) writeJson(io, payload);
      else io.stderr.write(`${error.message}\n`);
      return promotionExit(error);
    }
    const payload = {
      ok: false,
      command: "promote-bgm-pack",
      issues: [{ code: "BGM_PROMOTION_INTERNAL", message: "BGM Pack promotion failed unexpectedly." }],
    };
    if (args.json) writeJson(io, payload);
    else io.stderr.write("BGM Pack promotion failed unexpectedly.\n");
    return PROMOTE_BGM_PACK_CLI_EXIT.internal;
  }
}

const isMain = process.argv[1]
  ? import.meta.url === pathToFileURL(process.argv[1]).href
  : false;

if (isMain) process.exitCode = await runPromoteBgmPackCli(process.argv);
