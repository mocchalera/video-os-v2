#!/usr/bin/env npx tsx

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

import { validateArtifact } from "../runtime/artifacts/loaders.js";
import {
  projectSfxToTimeline,
  resolveSfxCuePlan,
} from "../runtime/audio/sfx-cues.js";
import type { TimelineIR } from "../runtime/compiler/types.js";

export interface ProjectSfxCuesArgs {
  projectDir: string;
  repoSfxRoot?: string;
  timelinePath: string;
  cuesPath: string;
  outputPath?: string;
  dryRun: boolean;
}

const USAGE = `Usage:
  npm run sfx:project -- --project <dir> --timeline <timeline.json> --cues <sfx_cues.json> [--repo-sfx-root <repo/resources/sfx>] [--output <new-timeline.json>] [--dry-run]

Validates the SFX library, rights/provenance and all content pins before
projecting formal SFX cues onto A3. --dry-run writes nothing. Non-dry-run
requires a new explicit output and never overwrites an existing artifact.`;

function required(values: string[], index: number, flag: string): string {
  const value = values[index];
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

export function parseProjectSfxCuesArgs(argv: string[]): ProjectSfxCuesArgs {
  const values = argv.slice(2);
  let projectDir: string | undefined;
  let repoSfxRoot: string | undefined;
  let timelinePath: string | undefined;
  let cuesPath: string | undefined;
  let outputPath: string | undefined;
  let dryRun = false;
  for (let index = 0; index < values.length; index += 1) {
    const arg = values[index];
    if (arg === "--help" || arg === "-h") throw new Error(USAGE);
    if (arg === "--project") projectDir = required(values, ++index, arg);
    else if (arg === "--repo-sfx-root") repoSfxRoot = required(values, ++index, arg);
    else if (arg === "--timeline") timelinePath = required(values, ++index, arg);
    else if (arg === "--cues") cuesPath = required(values, ++index, arg);
    else if (arg === "--output") outputPath = required(values, ++index, arg);
    else if (arg === "--dry-run") dryRun = true;
    else throw new Error(`Unknown argument: ${arg}\n${USAGE}`);
  }
  if (!projectDir || !timelinePath || !cuesPath) throw new Error(USAGE);
  if (!dryRun && !outputPath) {
    throw new Error(`--output is required unless --dry-run is set\n${USAGE}`);
  }
  return {
    projectDir: path.resolve(projectDir),
    ...(repoSfxRoot ? { repoSfxRoot: path.resolve(repoSfxRoot) } : {}),
    timelinePath: path.resolve(timelinePath),
    cuesPath: path.resolve(cuesPath),
    outputPath: outputPath ? path.resolve(outputPath) : undefined,
    dryRun,
  };
}

function hashJson(value: unknown): string {
  return `sha256:${createHash("sha256")
    .update(JSON.stringify(value))
    .digest("hex")}`;
}

function assertSafeNewOutput(outputPath: string, projectDir: string): void {
  const root = path.parse(outputPath).root;
  if (outputPath === root || outputPath === projectDir) {
    throw new Error(`unsafe output path: ${outputPath}`);
  }
  if (fs.existsSync(outputPath)) {
    throw new Error(`output already exists; refusing to overwrite: ${outputPath}`);
  }
}

export function runProjectSfxCues(
  args: ProjectSfxCuesArgs,
): Record<string, unknown> {
  const timeline = validateArtifact<TimelineIR>(
    JSON.parse(fs.readFileSync(args.timelinePath, "utf8")),
    "timeline-ir.schema.json",
  );
  const plan = resolveSfxCuePlan({
    projectDir: args.projectDir,
    ...(args.repoSfxRoot ? { repoSfxRoot: args.repoSfxRoot } : {}),
    timeline,
    cuesPath: args.cuesPath,
  });
  const projected = projectSfxToTimeline(timeline, plan);
  validateArtifact(projected, "timeline-ir.schema.json");
  const result = {
    version: "project-sfx-cues/v1",
    dry_run: args.dryRun,
    project_id: projected.project_id,
    plan_hash: hashJson(plan),
    input_timeline_hash: hashJson(timeline),
    output_timeline_hash: hashJson(projected),
    library: plan.library,
    cue_ids: plan.cues.map((cue) => cue.cue_id),
    a3_clip_count:
      projected.tracks.audio.find((track) => track.track_id === "A3")
        ?.clips.filter((clip) => clip.metadata?.sfx_cue).length ?? 0,
    wrote_files: !args.dryRun,
  };
  if (args.dryRun) return result;

  const outputPath = args.outputPath!;
  assertSafeNewOutput(outputPath, args.projectDir);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(projected, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
  });
  return { ...result, output_path: outputPath };
}

async function main(): Promise<void> {
  try {
    const result = runProjectSfxCues(parseProjectSfxCuesArgs(process.argv));
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}

const isMain = process.argv[1]
  ? import.meta.url === pathToFileURL(process.argv[1]).href
  : false;
if (isMain) void main();
