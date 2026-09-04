#!/usr/bin/env npx tsx

import * as path from "node:path";
import { pathToFileURL } from "node:url";
import {
  approveCaptions,
  captionCommand,
  type ApproveCaptionsOptions,
  type CaptionCommandOptions,
} from "../runtime/commands/caption.js";

export const CAPTION_USAGE = `Usage:
  npm run caption -- --project <project-dir> --source authored --lyrics <path> --timing-plan <path>
  npm run caption -- approve --project <project-dir> --approved-by <human> [--approved-at <ISO>]

Options:
  --project <path>       Project directory (required)
  --source <source>      Caption source; authored is the Issue #41 route
  --lyrics <path>        Authored lyric text file
  --timing-plan <path>   JSON/YAML timing evidence or plan
  --approved-by <human>  Explicit human identity for approval
  --approved-at <ISO>    Deterministic approval timestamp
  --json                 Print machine-readable result
  -h, --help             Show this help`;

export interface CaptionCliArgs {
  command: "draft" | "approve";
  projectDir: string;
  source?: CaptionCommandOptions["source"];
  lyricsPath?: string;
  timingPlanPath?: string;
  approvedBy?: string;
  approvedAt?: string;
  json: boolean;
}

function requiredValue(values: string[], index: number, flag: string): string {
  const value = values[index];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value\n${CAPTION_USAGE}`);
  return value;
}

export function parseCaptionArgs(argv: string[] = process.argv): CaptionCliArgs {
  const values = argv.slice(2);
  let command: CaptionCliArgs["command"] = "draft";
  if (values[0] === "approve") {
    command = "approve";
    values.shift();
  }
  let projectDir: string | undefined;
  let source: CaptionCommandOptions["source"];
  let lyricsPath: string | undefined;
  let timingPlanPath: string | undefined;
  let approvedBy: string | undefined;
  let approvedAt: string | undefined;
  let json = false;
  for (let index = 0; index < values.length; index += 1) {
    const arg = values[index];
    if (arg === "--help" || arg === "-h") throw new Error(CAPTION_USAGE);
    if (arg === "--project") projectDir = requiredValue(values, ++index, arg);
    else if (arg === "--source") {
      const value = requiredValue(values, ++index, arg);
      if (value !== "authored" && value !== "transcript" && value !== "none") {
        throw new Error(`--source must be authored, transcript, or none\n${CAPTION_USAGE}`);
      }
      source = value;
    }
    else if (arg === "--lyrics") lyricsPath = requiredValue(values, ++index, arg);
    else if (arg === "--timing-plan") timingPlanPath = requiredValue(values, ++index, arg);
    else if (arg === "--approved-by") approvedBy = requiredValue(values, ++index, arg);
    else if (arg === "--approved-at") approvedAt = requiredValue(values, ++index, arg);
    else if (arg === "--json") json = true;
    else throw new Error(`unknown argument: ${arg}\n${CAPTION_USAGE}`);
  }
  if (!projectDir) throw new Error(`--project is required\n${CAPTION_USAGE}`);
  if (command === "draft" && source === "authored" && (!lyricsPath || !timingPlanPath)) {
    throw new Error(`authored source requires --lyrics and --timing-plan\n${CAPTION_USAGE}`);
  }
  if (command === "approve" && !approvedBy) {
    throw new Error(`approve requires --approved-by <human>\n${CAPTION_USAGE}`);
  }
  return {
    command,
    projectDir: path.resolve(projectDir),
    ...(source ? { source } : {}),
    ...(lyricsPath ? { lyricsPath: path.resolve(lyricsPath) } : {}),
    ...(timingPlanPath ? { timingPlanPath: path.resolve(timingPlanPath) } : {}),
    ...(approvedBy ? { approvedBy } : {}),
    ...(approvedAt ? { approvedAt } : {}),
    json,
  };
}

export function runCaptionCli(argv: string[] = process.argv): number {
  const args = parseCaptionArgs(argv);
  const result = args.command === "approve"
    ? approveCaptions(args.projectDir, {
      approvedBy: args.approvedBy!,
      ...(args.approvedAt ? { approvedAt: args.approvedAt } : {}),
    } satisfies ApproveCaptionsOptions)
    : captionCommand(args.projectDir, {
      ...(args.source ? { source: args.source } : {}),
      ...(args.lyricsPath ? { lyricsPath: args.lyricsPath } : {}),
      ...(args.timingPlanPath ? { timingPlanPath: args.timingPlanPath } : {}),
      editorialEnabled: false,
    } satisfies CaptionCommandOptions);
  if (args.json) console.log(JSON.stringify(result, null, 2));
  else {
    console.log(`[caption] ${result.success ? "ok" : "failed"}`);
    if (result.error) console.error(result.error.message);
    if (result.authoredPreview) {
      console.log(`Preview: 07_package/caption_preview.json`);
      console.log(`Projected timeline: ${result.authoredPreview.projected_timeline_hash}`);
      console.log(`Next: ${result.authoredPreview.next_command}`);
    }
    if (result.captionApproval) console.log("Caption approval and C1 projection promoted.");
  }
  return result.success ? 0 : 1;
}

function main(): void {
  try {
    if (process.argv.includes("--help") || process.argv.includes("-h")) {
      console.log(CAPTION_USAGE);
      return;
    }
    process.exitCode = runCaptionCli(process.argv);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

const isDirectRun = process.argv[1]
  ? import.meta.url === pathToFileURL(process.argv[1]).href
  : false;
if (isDirectRun) main();
