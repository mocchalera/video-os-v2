#!/usr/bin/env npx tsx
/**
 * Read-only render-route preflight.
 *
 * Usage:
 *   npm run render-route -- projects/<project-id>
 *   npm run render-route -- projects/<project-id> --assembly-engine remotion --json
 */

import * as path from "node:path";
import { pathToFileURL } from "node:url";
import {
  resolveProjectRenderRoute,
  type AssemblyEngineRequest,
  type RenderRouteDecision,
} from "../runtime/render/route-resolver.js";

const USAGE = [
  "Usage: npm run render-route -- <project-path> [options]",
  "",
  "Options:",
  "  --assembly-engine <auto|ffmpeg|remotion>  Preview an engine request (default: auto)",
  "  --json                                     Print machine-readable JSON",
].join("\n");

export interface RenderRouteCliArgs {
  projectDir: string;
  assemblyEngine: AssemblyEngineRequest;
  json: boolean;
}

export function parseRenderRouteArgs(argv: string[]): RenderRouteCliArgs {
  const args = argv.slice(2);
  let projectDir = "";
  let assemblyEngine: AssemblyEngineRequest = "auto";
  let json = false;

  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--help" || arg === "-h") {
      console.log(USAGE);
      process.exit(0);
    }
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (arg === "--assembly-engine" && index + 1 < args.length) {
      const value = args[++index];
      if (value !== "auto" && value !== "ffmpeg" && value !== "remotion") {
        throw new Error(`Invalid --assembly-engine: ${value}`);
      }
      assemblyEngine = value;
      continue;
    }
    if (arg.startsWith("-")) {
      throw new Error(`Unknown or incomplete argument: ${arg}`);
    }
    if (projectDir) {
      throw new Error(`Unexpected argument: ${arg}`);
    }
    projectDir = arg;
  }

  if (!projectDir) throw new Error("<project-path> is required");
  return { projectDir: path.resolve(projectDir), assemblyEngine, json };
}

export function formatRenderRoute(decision: RenderRouteDecision): string {
  const layers = [
    decision.assembly_engine,
    ...(decision.hyperframes_overlay ? ["hyperframes-overlay"] : []),
    ...(decision.speech_caption_engine === "ffmpeg-libass" ? ["ffmpeg-libass-captions"] : []),
  ];
  return [
    `Render route: ${layers.join(" + ")}`,
    `Genre/style: ${decision.genre} / ${decision.style_family}`,
    ...decision.reasons.map((reason) => `- ${reason}`),
  ].join("\n");
}

export function runRenderRouteCli(argv = process.argv): RenderRouteDecision {
  const args = parseRenderRouteArgs(argv);
  const decision = resolveProjectRenderRoute(args.projectDir, args.assemblyEngine);
  console.log(args.json ? JSON.stringify(decision, null, 2) : formatRenderRoute(decision));
  return decision;
}

const isDirectRun = process.argv[1]
  ? import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
  : false;

if (isDirectRun) {
  try {
    runRenderRouteCli();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
