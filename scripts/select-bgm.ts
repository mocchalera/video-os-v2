#!/usr/bin/env npx tsx

import { pathToFileURL } from "node:url";
import {
  BgmSelectionServiceError,
  selectBgmForProject,
  type BgmOutputScope,
  type ProjectBgmSelectionResult,
} from "../runtime/music/selection-service.js";

const OUTPUT_SCOPES = [
  "preview_internal",
  "external",
  "public_redistribution",
  "commercial",
] as const satisfies readonly BgmOutputScope[];

const USAGE = [
  "Usage: npx tsx scripts/select-bgm.ts --project <directory> [options]",
  "",
  "Options:",
  "  --mode <suggest|auto>       Selection mode (default: suggest)",
  "  --scope <scope>             preview_internal, external, public_redistribution, or commercial",
  "  --pack-root <directory>     Explicit local BGM pack root",
  "  --dry-run                   Rank candidates without writing bgm_selection.json",
  "  --json                      Emit machine-readable output",
].join("\n");

export interface SelectBgmCliArgs {
  project: string;
  mode: "suggest" | "auto";
  outputScope: BgmOutputScope;
  packRoot?: string;
  dryRun: boolean;
  json: boolean;
}

export interface SelectBgmCliIo {
  stdout: Pick<NodeJS.WriteStream, "write">;
  stderr: Pick<NodeJS.WriteStream, "write">;
}

export interface SelectBgmCliDependencies {
  select: typeof selectBgmForProject;
  now: () => Date;
}

export const SELECT_BGM_CLI_EXIT = {
  ok: 0,
  usage: 2,
  notFound: 3,
  inconclusive: 4,
  internal: 5,
} as const;

function isOutputScope(value: string): value is BgmOutputScope {
  return (OUTPUT_SCOPES as readonly string[]).includes(value);
}

export function parseSelectBgmArgs(argv: string[]): SelectBgmCliArgs {
  const args = argv.slice(2);
  let project: string | undefined;
  let mode: SelectBgmCliArgs["mode"] = "suggest";
  let outputScope: BgmOutputScope = "preview_internal";
  let packRoot: string | undefined;
  let dryRun = false;
  let json = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--project" && args[index + 1]) project = args[++index];
    else if (arg === "--mode" && (args[index + 1] === "suggest" || args[index + 1] === "auto")) {
      mode = args[++index] as SelectBgmCliArgs["mode"];
    } else if (arg === "--scope" && args[index + 1] && isOutputScope(args[index + 1])) {
      outputScope = args[++index] as BgmOutputScope;
    } else if (arg === "--pack-root" && args[index + 1]) packRoot = args[++index];
    else if (arg === "--dry-run") dryRun = true;
    else if (arg === "--json") json = true;
    else throw new Error(USAGE);
  }

  if (!project) throw new Error(USAGE);
  return { project, mode, outputScope, packRoot, dryRun, json };
}

function jsonPayload(result: ProjectBgmSelectionResult): Record<string, unknown> {
  return {
    ok: result.ok,
    command: "select",
    project_id: result.artifact.project_id,
    requested_mode: result.requested_mode,
    effective_mode: result.artifact.mode,
    selected: result.artifact.selected,
    ranked_candidates: result.artifact.candidates.filter((candidate) => candidate.status === "ranked").length,
    rejected_candidates: result.artifact.candidates.filter((candidate) => candidate.status === "rejected").length,
    wrote_artifact: result.wrote_artifact,
    output_ref: result.output_ref,
    issues: result.issues,
  };
}

function writeJson(io: SelectBgmCliIo, value: unknown): void {
  io.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

export async function runSelectBgmCli(
  argv: string[] = process.argv,
  io: SelectBgmCliIo = { stdout: process.stdout, stderr: process.stderr },
  dependencies: SelectBgmCliDependencies = { select: selectBgmForProject, now: () => new Date() },
): Promise<number> {
  const jsonRequested = argv.includes("--json");
  let args: SelectBgmCliArgs;
  try {
    args = parseSelectBgmArgs(argv);
  } catch {
    if (jsonRequested) {
      writeJson(io, { ok: false, command: "select", issues: [{ code: "BGM_SELECTION_USAGE", message: "Invalid select-bgm arguments." }] });
    } else {
      io.stderr.write(`${USAGE}\n`);
    }
    return SELECT_BGM_CLI_EXIT.usage;
  }

  try {
    const result = await dependencies.select({
      projectPath: args.project,
      requestedMode: args.mode,
      outputScope: args.outputScope,
      ...(args.packRoot ? { packRoot: args.packRoot } : {}),
      writeArtifact: !args.dryRun,
      createdAt: dependencies.now().toISOString(),
    });
    if (args.json) writeJson(io, jsonPayload(result));
    else if (result.artifact.selected) {
      io.stdout.write(`BGM ${result.artifact.mode}: ${result.artifact.selected.track_id} (${result.artifact.selected.score.toFixed(1)}/100)\n`);
    } else if (result.artifact.candidates.some((candidate) => candidate.status === "ranked")) {
      const top = result.artifact.candidates.find((candidate) => candidate.status === "ranked");
      io.stdout.write(`BGM suggestions ready${top ? `; top candidate: ${top.track_id} (${top.total_score?.toFixed(1)}/100)` : ""}.\n`);
    } else {
      io.stdout.write("BGM selection is inconclusive; review the ranked candidates and warnings.\n");
    }
    if (result.ok) return SELECT_BGM_CLI_EXIT.ok;
    if (result.issues.some((issue) => issue.code === "BGM_PACK_NOT_FOUND" || issue.code === "BGM_SELECTION_INPUT_MISSING")) {
      return SELECT_BGM_CLI_EXIT.notFound;
    }
    return SELECT_BGM_CLI_EXIT.inconclusive;
  } catch (error) {
    if (error instanceof BgmSelectionServiceError) {
      const payload = { ok: false, command: "select", issues: [error.issue] };
      if (args.json) writeJson(io, payload);
      else io.stderr.write(`${error.issue.message}\n`);
      return error.issue.code === "BGM_PACK_NOT_FOUND" || error.issue.code === "BGM_SELECTION_INPUT_MISSING"
        ? SELECT_BGM_CLI_EXIT.notFound
        : SELECT_BGM_CLI_EXIT.inconclusive;
    }
    const payload = { ok: false, command: "select", issues: [{ code: "BGM_SELECTION_INTERNAL", message: "BGM selection failed unexpectedly." }] };
    if (args.json) writeJson(io, payload);
    else io.stderr.write("BGM selection failed unexpectedly.\n");
    return SELECT_BGM_CLI_EXIT.internal;
  }
}

const isMain = process.argv[1]
  ? import.meta.url === pathToFileURL(process.argv[1]).href
  : false;

if (isMain) process.exitCode = await runSelectBgmCli(process.argv);
