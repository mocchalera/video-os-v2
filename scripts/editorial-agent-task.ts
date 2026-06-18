#!/usr/bin/env tsx
/**
 * Cockpit-compatible wrapper for the two-pass unified editorial agent.
 *
 * Direct/headless:
 *   npx tsx scripts/editorial-agent-task.ts --project projects/ena-promo-ai
 *
 * Repo-side interactive:
 *   npx tsx scripts/editorial-agent-task.ts --project projects/ena-promo-ai --mode interactive
 *   # Read 04_plan/agent_tasks/rough_pass.md, write rough_response.json, rerun.
 */

import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { runEditorialPipeline } from "./editorial-pipeline.js";
import {
  fineCutRefinement,
  parseFineCutRefinementResponse,
  parseRoughCutPlanningResponse,
  roughCutPlanning,
  type EditorialInteractivePrompt,
} from "../runtime/agents/unified-editorial-agent.js";
import { loadCreativeBrief, validateArtifact } from "../runtime/artifacts/loaders.js";
import type { CreativeBrief, EditBlueprint, SelectsCandidates } from "../runtime/artifacts/types.js";
import type { SegmentItem } from "../runtime/connectors/ffmpeg-segmenter.js";
import type { MarlinEventsArtifact } from "../runtime/connectors/marlin-types.js";
import { detectProjectBgm } from "../runtime/compiler/index.js";
import { loadSourceMap } from "../runtime/media/source-map.js";
import {
  extractCraftKeyFrames,
  extractRepresentativeFrames,
} from "../runtime/pipeline/stages/craft-frames.js";

const execFileAsync = promisify(execFile);

const USAGE = [
  "Usage: npx tsx scripts/editorial-agent-task.ts --project <dir> [--mode headless|interactive] [--skip-fine] [--skip-render]",
  "       npx tsx scripts/editorial-agent-task.ts --project <dir> --mode interactive --rough-response <json> [--fine-response <json>]",
].join("\n");

interface EditorialAgentTaskArgs {
  projectDir: string;
  mode: "headless" | "interactive";
  skipFine: boolean;
  skipRender: boolean;
  roughResponse?: string;
  fineResponse?: string;
}

interface SegmentsDoc {
  items?: SegmentItem[];
}

function parseArgs(argv: string[] = process.argv): EditorialAgentTaskArgs {
  const args = argv.slice(2);
  let projectDir: string | undefined;
  let mode: "headless" | "interactive" = "headless";
  let skipFine = false;
  let skipRender = false;
  let roughResponse: string | undefined;
  let fineResponse: string | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--help" || arg === "-h") throw new Error(USAGE);
    if (arg === "--project" && index + 1 < args.length) {
      projectDir = args[++index];
      continue;
    }
    if (arg === "--mode" && index + 1 < args.length) {
      const value = args[++index];
      if (value !== "headless" && value !== "interactive") {
        throw new Error(`Invalid --mode: ${value}`);
      }
      mode = value;
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
    if (arg === "--rough-response" && index + 1 < args.length) {
      roughResponse = path.resolve(args[++index]);
      continue;
    }
    if (arg === "--fine-response" && index + 1 < args.length) {
      fineResponse = path.resolve(args[++index]);
      continue;
    }
    if (arg.startsWith("--")) throw new Error(`Unknown argument: ${arg}`);
    if (!projectDir) {
      projectDir = arg;
      continue;
    }
    throw new Error(`Unexpected extra argument: ${arg}`);
  }

  if (!projectDir) throw new Error(USAGE);
  return {
    projectDir: path.resolve(projectDir),
    mode,
    skipFine,
    skipRender,
    ...(roughResponse ? { roughResponse } : {}),
    ...(fineResponse ? { fineResponse } : {}),
  };
}

function readJson<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, "utf-8")) as T;
}

function readYaml<T>(filePath: string): T {
  return parseYaml(fs.readFileSync(filePath, "utf-8")) as T;
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

function planPath(projectDir: string, relativePath: string): string {
  return path.join(projectDir, "04_plan", relativePath);
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

function defaultTaskDir(projectDir: string): string {
  return path.join(projectDir, "04_plan", "agent_tasks");
}

function responsePath(taskDir: string, pass: "rough" | "fine", explicit?: string): string {
  return explicit ?? path.join(taskDir, `${pass}_response.json`);
}

function readOptionalResponse(filePath: string, explicit: boolean): string | undefined {
  if (!fs.existsSync(filePath)) {
    if (explicit) throw new Error(`Response file not found: ${filePath}`);
    return undefined;
  }
  const raw = fs.readFileSync(filePath, "utf-8").trim();
  if (!raw) {
    if (explicit) throw new Error(`Response file is empty: ${filePath}`);
    return undefined;
  }
  return raw;
}

function writePromptPacket(
  taskDir: string,
  packet: EditorialInteractivePrompt,
  responseFilePath: string,
): string {
  fs.mkdirSync(taskDir, { recursive: true });
  const promptPath = path.join(taskDir, `${packet.pass}_pass.md`);
  const body = [
    `# Unified editorial ${packet.pass} pass`,
    "",
    `Write the JSON response to: ${responseFilePath}`,
    "",
    packet.prompt,
  ].join("\n");
  fs.writeFileSync(promptPath, body, "utf-8");
  return promptPath;
}

function loadExistingPlan(projectDir: string): {
  selects: SelectsCandidates;
  blueprint: EditBlueprint;
} | undefined {
  const selectsPath = planPath(projectDir, "selects_candidates.yaml");
  const blueprintPath = planPath(projectDir, "edit_blueprint.yaml");
  if (!fs.existsSync(selectsPath) || !fs.existsSync(blueprintPath)) return undefined;
  const selects = readYaml<SelectsCandidates>(selectsPath);
  const blueprint = readYaml<EditBlueprint>(blueprintPath);
  validateArtifact<SelectsCandidates>(selects, "selects-candidates.schema.json");
  validateArtifact<EditBlueprint>(blueprint, "edit-blueprint.schema.json");
  return { selects, blueprint };
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

async function runCompileAndMaybeRender(projectDir: string, skipRender: boolean): Promise<void> {
  console.log("[editorial-agent] compile");
  await runCompile(projectDir);
  if (skipRender) {
    console.log("[editorial-agent] render skipped");
    return;
  }
  console.log("[editorial-agent] render");
  await runRender(projectDir);
}

async function runInteractiveTask(args: EditorialAgentTaskArgs): Promise<void> {
  const projectDir = path.resolve(args.projectDir);
  const taskDir = defaultTaskDir(projectDir);
  const roughResponsePath = responsePath(taskDir, "rough", args.roughResponse);
  const fineResponsePath = responsePath(taskDir, "fine", args.fineResponse);
  const briefPath = path.join(projectDir, "01_intent", "creative_brief.yaml");
  const brief: CreativeBrief = loadCreativeBrief(briefPath);
  const marlinEvents = loadMarlinEvents(projectDir);
  const segments = loadSegments(projectDir);
  const sourceMap = loadSourceMap(projectDir).entryMap;
  const bgm = await detectProjectBgm(projectDir, (message) => console.warn(message));
  const bgmDurationSec = bgm ? bgm.durationUs / 1_000_000 : null;

  console.log("[editorial-agent] extracting representative frames");
  const representativeFrames = await extractRepresentativeFrames(
    projectDir,
    segments,
    marlinEvents,
    sourceMap,
  );

  let plan = loadExistingPlan(projectDir);
  const roughResponse = readOptionalResponse(roughResponsePath, Boolean(args.roughResponse));

  if (roughResponse) {
    console.log("[editorial-agent] applying rough agent response");
    plan = parseRoughCutPlanningResponse(roughResponse, {
      brief,
      marlinEvents,
      representativeFrames,
      segments,
      bgmDurationSec,
    });
    writeYamlArtifact(
      projectDir,
      "04_plan/selects_candidates.yaml",
      plan.selects,
      "selects-candidates.schema.json",
    );
    writeYamlArtifact(
      projectDir,
      "04_plan/edit_blueprint.yaml",
      plan.blueprint,
      "edit-blueprint.schema.json",
    );
  }

  if (!plan) {
    const roughTask = await roughCutPlanning(
      brief,
      marlinEvents,
      representativeFrames,
      segments,
      bgmDurationSec,
      { mode: "interactive", projectDir },
    );
    const promptPath = writePromptPacket(taskDir, roughTask, roughResponsePath);
    console.log(`[editorial-agent] rough prompt written: ${promptPath}`);
    console.log(`[editorial-agent] read the listed frames, write JSON to: ${roughResponsePath}`);
    return;
  }

  if (args.skipFine) {
    await runCompileAndMaybeRender(projectDir, args.skipRender);
    return;
  }

  console.log("[editorial-agent] extracting fine-cut key frames");
  const keyFrames = await extractCraftKeyFrames(
    projectDir,
    plan.selects.candidates,
    marlinEvents,
    sourceMap,
  );

  const fineTask = await fineCutRefinement(
    brief,
    plan.selects,
    plan.blueprint,
    marlinEvents,
    keyFrames,
    bgmDurationSec,
    { mode: "interactive", projectDir },
  );
  const finePromptPath = writePromptPacket(taskDir, fineTask, fineResponsePath);
  const fineResponse = readOptionalResponse(fineResponsePath, Boolean(args.fineResponse));

  if (!fineResponse) {
    console.log(`[editorial-agent] fine prompt written: ${finePromptPath}`);
    console.log(`[editorial-agent] read the listed key frames, write JSON to: ${fineResponsePath}`);
    return;
  }

  console.log("[editorial-agent] applying fine agent response");
  const refinedBlueprint = parseFineCutRefinementResponse(fineResponse, {
    brief,
    selects: plan.selects,
    blueprint: plan.blueprint,
    marlinEvents,
    keyFrames,
    bgmDurationSec,
  });
  writeYamlArtifact(
    projectDir,
    "04_plan/selects_candidates.yaml",
    plan.selects,
    "selects-candidates.schema.json",
  );
  writeYamlArtifact(
    projectDir,
    "04_plan/edit_blueprint.yaml",
    refinedBlueprint,
    "edit-blueprint.schema.json",
  );

  await runCompileAndMaybeRender(projectDir, args.skipRender);
}

export async function main(argv: string[] = process.argv): Promise<number> {
  let args: EditorialAgentTaskArgs;
  try {
    args = parseArgs(argv);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }

  try {
    if (args.mode === "headless") {
      await runEditorialPipeline({
        projectDir: args.projectDir,
        skipFine: args.skipFine,
        skipRender: args.skipRender,
      });
    } else {
      await runInteractiveTask(args);
    }
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
