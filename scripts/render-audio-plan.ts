#!/usr/bin/env npx tsx

import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

import {
  executeAudioRenderPlan,
} from "../runtime/audio/render-executor.js";
import {
  hashAudioRenderPlan,
} from "../runtime/audio/render-plan.js";
import { resolveSharedAudioRenderPlan } from "../runtime/audio/render-route.js";

export interface AudioRenderPlanCliArgs {
  projectDir: string;
  timelinePath: string;
  musicCuesPath?: string;
  sfxCuesPath?: string;
  outputDir?: string;
  route: "social-review" | "final";
  dryRun: boolean;
  keepWork: boolean;
}

const USAGE = `Usage:
  npm run render-audio-plan -- --project <dir> --timeline <timeline.json> [--music-cues <music_cues.json>] [--sfx-cues <sfx_cues.json>] --route <social-review|final> [--output <new-dir>] [--dry-run] [--keep-work]

Resolves the pinned shared AudioRenderPlan and, unless --dry-run is set,
executes A1-only finishing, formal A2/A3 cue gain/fade/waveform ducking, mixing,
and one final mastering pass. At least one cue artifact is required. Output must
be a new directory. The route label does not change plan identity or execution
semantics.`;

function required(values: string[], index: number, flag: string): string {
  const value = values[index];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

export function parseAudioRenderPlanArgs(argv: string[]): AudioRenderPlanCliArgs {
  const values = argv.slice(2);
  let projectDir: string | undefined;
  let timelinePath: string | undefined;
  let musicCuesPath: string | undefined;
  let sfxCuesPath: string | undefined;
  let outputDir: string | undefined;
  let route: AudioRenderPlanCliArgs["route"] | undefined;
  let dryRun = false;
  let keepWork = false;
  for (let index = 0; index < values.length; index += 1) {
    const arg = values[index];
    if (arg === "--help" || arg === "-h") throw new Error(USAGE);
    if (arg === "--project") projectDir = required(values, ++index, arg);
    else if (arg === "--timeline") timelinePath = required(values, ++index, arg);
    else if (arg === "--music-cues") musicCuesPath = required(values, ++index, arg);
    else if (arg === "--sfx-cues") sfxCuesPath = required(values, ++index, arg);
    else if (arg === "--output") outputDir = required(values, ++index, arg);
    else if (arg === "--route") {
      const value = required(values, ++index, arg);
      if (value !== "social-review" && value !== "final") {
        throw new Error(`--route must be social-review or final\n${USAGE}`);
      }
      route = value;
    } else if (arg === "--dry-run") dryRun = true;
    else if (arg === "--keep-work") keepWork = true;
    else throw new Error(`Unknown argument: ${arg}\n${USAGE}`);
  }
  if (!projectDir || !timelinePath || (!musicCuesPath && !sfxCuesPath) || !route) {
    throw new Error(USAGE);
  }
  if (!dryRun && !outputDir) {
    throw new Error(`--output is required unless --dry-run is set\n${USAGE}`);
  }
  return {
    projectDir: path.resolve(projectDir),
    timelinePath: path.resolve(timelinePath),
    musicCuesPath: musicCuesPath ? path.resolve(musicCuesPath) : undefined,
    sfxCuesPath: sfxCuesPath ? path.resolve(sfxCuesPath) : undefined,
    outputDir: outputDir ? path.resolve(outputDir) : undefined,
    route,
    dryRun,
    keepWork,
  };
}

function assertSafeNewOutput(outputDir: string, projectDir: string): void {
  if (outputDir === path.parse(outputDir).root || outputDir === projectDir) {
    throw new Error(`unsafe output directory: ${outputDir}`);
  }
  if (fs.existsSync(outputDir)) {
    throw new Error(`output already exists; refusing to overwrite: ${outputDir}`);
  }
}

export async function runAudioRenderPlan(
  args: AudioRenderPlanCliArgs,
  dependencies: {
    resolveSharedAudioRenderPlanImpl?: typeof resolveSharedAudioRenderPlan;
    executeAudioRenderPlanImpl?: typeof executeAudioRenderPlan;
  } = {},
): Promise<Record<string, unknown>> {
  const plan = (
    dependencies.resolveSharedAudioRenderPlanImpl ?? resolveSharedAudioRenderPlan
  )({
    projectDir: args.projectDir,
    timelinePath: args.timelinePath,
    musicCuesPath: args.musicCuesPath,
    sfxCuesPath: args.sfxCuesPath,
  });
  if (!plan) {
    throw new Error("an enabled formal A2 music-cues/v2 or A3 sfx-cues/v1 projection is required");
  }
  const planHash = hashAudioRenderPlan(plan);
  if (args.dryRun) {
    return {
      version: "audio-render-plan-cli/v1",
      dry_run: true,
      route: args.route,
      plan_hash: planHash,
      plan,
      wrote_files: false,
    };
  }

  const outputDir = args.outputDir!;
  assertSafeNewOutput(outputDir, args.projectDir);
  fs.mkdirSync(outputDir, { recursive: true });
  const result = await (
    dependencies.executeAudioRenderPlanImpl ?? executeAudioRenderPlan
  )({
    plan,
    outputDir,
    workDirRoot: outputDir,
    cleanupWorkDir: !args.keepWork,
  });
  const planPath = path.join(outputDir, "audio-render-plan.json");
  fs.writeFileSync(planPath, `${JSON.stringify(plan, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
  });
  return {
    version: "audio-render-plan-cli/v1",
    dry_run: false,
    route: args.route,
    plan_hash: result.planHash,
    plan_path: planPath,
    raw_dialogue_path: result.rawDialoguePath,
    final_mix_path: result.finalMixPath,
    report_path: result.reportPath,
    ...(result.workDir ? { retained_work_dir: result.workDir } : {}),
    wrote_files: true,
  };
}

async function main(): Promise<void> {
  try {
    const result = await runAudioRenderPlan(parseAudioRenderPlanArgs(process.argv));
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

const isMain = process.argv[1]
  ? import.meta.url === pathToFileURL(process.argv[1]).href
  : false;
if (isMain) void main();
