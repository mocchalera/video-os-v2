#!/usr/bin/env tsx
/**
 * Hybrid two-pass editorial pipeline.
 *
 *   npx tsx scripts/editorial-pipeline.ts --project <dir> [--skip-fine] [--skip-render]
 */

import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { stringify as stringifyYaml } from "yaml";
import {
  fineCutRefinement,
  roughCutPlanning,
} from "../runtime/agents/unified-editorial-agent.js";
import { loadCreativeBrief, validateArtifact } from "../runtime/artifacts/loaders.js";
import type {
  CreativeBrief,
  EditBlueprint,
  SelectsCandidates,
} from "../runtime/artifacts/types.js";
import type { SegmentItem } from "../runtime/connectors/ffmpeg-segmenter.js";
import type { MarlinEventsArtifact } from "../runtime/connectors/marlin-types.js";
import { detectProjectBgm } from "../runtime/compiler/index.js";
import { loadSourceMap } from "../runtime/media/source-map.js";
import {
  extractCraftKeyFrames,
  extractRepresentativeFrames,
} from "../runtime/pipeline/stages/craft-frames.js";

const execFileAsync = promisify(execFile);

const USAGE = "Usage: npx tsx scripts/editorial-pipeline.ts --project <dir> [--skip-fine] [--skip-render]";

export interface EditorialPipelineArgs {
  projectDir: string;
  skipFine: boolean;
  skipRender: boolean;
}

interface SegmentsDoc {
  items?: SegmentItem[];
}

export function parseArgs(argv: string[] = process.argv): EditorialPipelineArgs {
  const args = argv.slice(2);
  let projectDir: string | undefined;
  let skipFine = false;
  let skipRender = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--help" || arg === "-h") {
      throw new Error(USAGE);
    }
    if (arg === "--project" && index + 1 < args.length) {
      projectDir = args[++index];
      continue;
    }
    if (arg === "--skip-fine") {
      skipFine = true;
      continue;
    }
    if (arg === "--skip-render") {
      skipRender = true;
      continue;
    }
    if (arg.startsWith("--")) {
      throw new Error(`Unknown argument: ${arg}`);
    }
    if (!projectDir) {
      projectDir = arg;
      continue;
    }
    throw new Error(`Unexpected extra argument: ${arg}`);
  }

  if (!projectDir) throw new Error(USAGE);
  return {
    projectDir: path.resolve(projectDir),
    skipFine,
    skipRender,
  };
}

function readJson<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, "utf-8")) as T;
}

function loadSegments(projectDir: string): SegmentItem[] {
  const filePath = path.join(projectDir, "03_analysis", "segments.json");
  if (!fs.existsSync(filePath)) throw new Error(`segments.json not found: ${filePath}`);
  const doc = readJson<SegmentsDoc>(filePath);
  if (!Array.isArray(doc.items)) throw new Error(`segments.json must contain an items array: ${filePath}`);
  return doc.items;
}

function loadMarlinEvents(projectDir: string): MarlinEventsArtifact {
  const filePath = path.join(projectDir, "03_analysis", "marlin_events.json");
  if (!fs.existsSync(filePath)) throw new Error(`marlin_events.json not found: ${filePath}`);
  return readJson<MarlinEventsArtifact>(filePath);
}

function writeYamlArtifact(
  projectDir: string,
  relativePath: string,
  data: unknown,
  schemaFile: string,
): void {
  validateArtifact(data, schemaFile);
  const filePath = path.join(projectDir, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, stringifyYaml(data), "utf-8");
  fs.renameSync(tmp, filePath);
}

async function runCommand(cmd: string, args: string[], cwd: string): Promise<void> {
  const { stdout, stderr } = await execFileAsync(cmd, args, {
    cwd,
    maxBuffer: 1024 * 1024 * 32,
  });
  if (stdout.trim()) process.stdout.write(stdout);
  if (stderr.trim()) process.stderr.write(stderr);
}

async function runCompile(projectDir: string): Promise<void> {
  await runCommand("npx", [
    "tsx",
    "scripts/compile-timeline.ts",
    projectDir,
    "--skip-preview",
    "--skip-confirmations",
    "true",
  ], path.resolve("."));
}

async function runRender(projectDir: string): Promise<void> {
  await runCommand("npx", [
    "tsx",
    "scripts/render-rough-cut.ts",
    "--project",
    projectDir,
  ], path.resolve("."));
}

export async function runEditorialPipeline(args: EditorialPipelineArgs): Promise<void> {
  const projectDir = path.resolve(args.projectDir);
  const briefPath = path.join(projectDir, "01_intent", "creative_brief.yaml");
  const brief: CreativeBrief = loadCreativeBrief(briefPath);
  const marlinEvents = loadMarlinEvents(projectDir);
  const segments = loadSegments(projectDir);
  const sourceMap = loadSourceMap(projectDir).entryMap;
  const bgm = await detectProjectBgm(projectDir, (message) => console.warn(message));
  const bgmDurationSec = bgm ? bgm.durationUs / 1_000_000 : null;

  console.log("[editorial] extracting representative frames");
  const representativeFrames = await extractRepresentativeFrames(
    projectDir,
    segments,
    marlinEvents,
    sourceMap,
  );

  console.log("[editorial] rough pass");
  const rough = await roughCutPlanning(
    brief,
    marlinEvents,
    representativeFrames,
    segments,
    bgmDurationSec,
  );
  writeYamlArtifact(
    projectDir,
    "04_plan/selects_candidates.yaml",
    rough.selects,
    "selects-candidates.schema.json",
  );
  writeYamlArtifact(
    projectDir,
    "04_plan/edit_blueprint.yaml",
    rough.blueprint,
    "edit-blueprint.schema.json",
  );

  let selects: SelectsCandidates = rough.selects;
  let blueprint: EditBlueprint = rough.blueprint;
  if (!args.skipFine) {
    console.log("[editorial] extracting fine-cut key frames");
    const keyFrames = await extractCraftKeyFrames(
      projectDir,
      selects.candidates,
      marlinEvents,
      sourceMap,
    );

    console.log("[editorial] fine pass");
    blueprint = await fineCutRefinement(
      brief,
      selects,
      blueprint,
      marlinEvents,
      keyFrames,
      bgmDurationSec,
    );
    writeYamlArtifact(
      projectDir,
      "04_plan/selects_candidates.yaml",
      selects,
      "selects-candidates.schema.json",
    );
    writeYamlArtifact(
      projectDir,
      "04_plan/edit_blueprint.yaml",
      blueprint,
      "edit-blueprint.schema.json",
    );
  } else {
    console.log("[editorial] fine pass skipped");
  }

  console.log("[editorial] compile");
  await runCompile(projectDir);

  if (args.skipRender) {
    console.log("[editorial] render skipped");
    return;
  }

  console.log("[editorial] render");
  await runRender(projectDir);
}

export async function main(argv: string[] = process.argv): Promise<number> {
  let args: EditorialPipelineArgs;
  try {
    args = parseArgs(argv);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }

  try {
    await runEditorialPipeline(args);
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

const isDirectRun =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  main().then((code) => {
    process.exitCode = code;
  }).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
