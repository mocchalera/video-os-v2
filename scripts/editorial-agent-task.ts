#!/usr/bin/env tsx
/**
 * Cockpit agent wrapper for editorial-pipeline.
 *
 * Cockpit-compatible wrapper for the two-pass unified editorial agent.
 *
 * Direct/headless:
 *   npx tsx scripts/editorial-agent-task.ts --project projects/ena-promo-ai
 *
 * Repo-side interactive:
 *   npx tsx scripts/editorial-agent-task.ts --project projects/ena-promo-ai --mode interactive
 *   # Read 04_plan/agent_tasks/rough_pass.md, write rough_response.json, rerun.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { parse as parseYaml } from "yaml";
import { runEditorialPipeline } from "./editorial-pipeline.js";
import { runEditorialDownstream } from "./editorial-downstream.js";
import {
  fineCutRefinement,
  parseFineCutRefinementResponse,
  parseRoughCutPlanningResponseWithClusters,
  roughCutPlanning,
  type EditorialInteractivePrompt,
} from "../runtime/agents/unified-editorial-agent.js";
import { validateArtifact } from "../runtime/artifacts/loaders.js";
import type { EditBlueprint, SelectsCandidates } from "../runtime/artifacts/types.js";
import { detectProjectBgm } from "../runtime/compiler/index.js";
import {
  loadEditorialPlanningContext,
  writeValidatedYamlArtifact,
} from "../runtime/pipeline/editorial-context.js";
import {
  extractCraftKeyFrames,
  extractRepresentativeFrames,
} from "../runtime/pipeline/stages/craft-frames.js";

const USAGE = [
  "Usage: npx tsx scripts/editorial-agent-task.ts --project <dir> [--mode headless|interactive] [--skip-fine] [--skip-render] [--skip-qa]",
  "       npx tsx scripts/editorial-agent-task.ts --project <dir> --mode interactive --rough-response <json> [--fine-response <json>] [--skip-qa]",
].join("\n");

export interface EditorialAgentTaskArgs {
  projectDir: string;
  mode: "headless" | "interactive";
  skipFine: boolean;
  skipRender: boolean;
  skipQa: boolean;
  roughResponse?: string;
  fineResponse?: string;
}

export function parseArgs(argv: string[] = process.argv): EditorialAgentTaskArgs {
  const args = argv.slice(2);
  let projectDir: string | undefined;
  let mode: "headless" | "interactive" = "headless";
  let skipFine = false;
  let skipRender = false;
  let skipQa = false;
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
    if (arg === "--skip-qa") {
      skipQa = true;
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
    skipQa,
    ...(roughResponse ? { roughResponse } : {}),
    ...(fineResponse ? { fineResponse } : {}),
  };
}

function readYaml<T>(filePath: string): T {
  return parseYaml(fs.readFileSync(filePath, "utf-8")) as T;
}

function planPath(projectDir: string, relativePath: string): string {
  return path.join(projectDir, "04_plan", relativePath);
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

export type EditorialInteractiveTaskOutcome =
  | "awaiting_rough_response"
  | "awaiting_fine_response"
  | "completed";

export async function runInteractiveTask(
  args: EditorialAgentTaskArgs,
): Promise<EditorialInteractiveTaskOutcome> {
  const {
    projectDir,
    brief,
    marlinEvents,
    segments,
    sourceMap,
  } = loadEditorialPlanningContext(args.projectDir);
  const taskDir = defaultTaskDir(projectDir);
  const roughResponsePath = responsePath(taskDir, "rough", args.roughResponse);
  const fineResponsePath = responsePath(taskDir, "fine", args.fineResponse);
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
    plan = await parseRoughCutPlanningResponseWithClusters(roughResponse, {
      brief,
      marlinEvents,
      representativeFrames,
      segments,
      bgmDurationSec,
      projectDir,
    });
    writeValidatedYamlArtifact(
      projectDir,
      "04_plan/selects_candidates.yaml",
      plan.selects,
      "selects-candidates.schema.json",
    );
    writeValidatedYamlArtifact(
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
    console.log("[editorial-agent] completion pending: rough response required; QA/status not run");
    return "awaiting_rough_response";
  }

  if (args.skipFine) {
    await runEditorialDownstream({
      projectDir,
      brief,
      selects: plan.selects,
      blueprint: plan.blueprint,
      entrypoint: "editorial-agent-task",
      skipRender: args.skipRender,
      skipQa: args.skipQa,
      logPrefix: "editorial-agent",
    });
    return "completed";
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
    console.log("[editorial-agent] completion pending: fine response required; QA/status not run");
    return "awaiting_fine_response";
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
  writeValidatedYamlArtifact(
    projectDir,
    "04_plan/selects_candidates.yaml",
    plan.selects,
    "selects-candidates.schema.json",
  );
  writeValidatedYamlArtifact(
    projectDir,
    "04_plan/edit_blueprint.yaml",
    refinedBlueprint,
    "edit-blueprint.schema.json",
  );

  await runEditorialDownstream({
    projectDir,
    brief,
    selects: plan.selects,
    blueprint: refinedBlueprint,
    entrypoint: "editorial-agent-task",
    skipRender: args.skipRender,
    skipQa: args.skipQa,
    logPrefix: "editorial-agent",
  });
  return "completed";
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
        skipQa: args.skipQa,
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
