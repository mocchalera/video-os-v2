#!/usr/bin/env npx tsx

import * as path from "node:path";
import { pathToFileURL } from "node:url";
import {
  approveFinalRenderChecklist,
  inspectFinalRenderApproval,
  type FinalRenderAudioDecision,
  type FinalRenderChecklistDecision,
} from "../runtime/packaging/final-render-approval.js";
import { computeSha256 } from "../runtime/packaging/manifest.js";

const USAGE = `Usage:
  npx tsx scripts/final-render-checklist.ts status --project <dir> [--json]
  npx tsx scripts/final-render-checklist.ts approve --project <dir> --approved-by <name> [options]

Approval options:
  --captions <approved|not_applicable>
  --typography <approved|not_applicable>
  --sections <approved|not_applicable>
  --visual-preview <project-relative manifest path>
                                             Required when any visual item is approved
  --audio <preserve|dialogue-clean|loudness-only>
  --audio-preview <project-relative path>       Required when --audio is not preserve
  --audio-preview-sha256 <sha256:...>           Required when --audio is not preserve
  --bgm <none|approved>
  --output-spec approved
  --approved-at <ISO date>
  --json`;

interface Args {
  command: "status" | "approve";
  projectDir: string;
  approvedBy?: string;
  approvedAt?: string;
  captions?: FinalRenderChecklistDecision;
  typography?: FinalRenderChecklistDecision;
  sections?: FinalRenderChecklistDecision;
  visualPreview?: string;
  audio?: FinalRenderAudioDecision;
  audioPreview?: string;
  audioPreviewSha256?: string;
  bgm?: "none" | "approved";
  outputSpec?: "approved";
  json: boolean;
}

export function parseFinalRenderChecklistArgs(argv: string[]): Args {
  const values = argv.slice(2);
  const command = values.shift();
  if (command !== "status" && command !== "approve") throw new Error(USAGE);
  let projectDir: string | undefined;
  let approvedBy: string | undefined;
  let approvedAt: string | undefined;
  let captions: FinalRenderChecklistDecision | undefined;
  let typography: FinalRenderChecklistDecision | undefined;
  let sections: FinalRenderChecklistDecision | undefined;
  let visualPreview: string | undefined;
  let audio: FinalRenderAudioDecision | undefined;
  let audioPreview: string | undefined;
  let audioPreviewSha256: string | undefined;
  let bgm: "none" | "approved" | undefined;
  let outputSpec: "approved" | undefined;
  let json = false;
  for (let index = 0; index < values.length; index += 1) {
    const flag = values[index];
    if (flag === "--project") projectDir = required(values, ++index, flag);
    else if (flag === "--approved-by") approvedBy = required(values, ++index, flag);
    else if (flag === "--approved-at") approvedAt = required(values, ++index, flag);
    else if (flag === "--captions") captions = checklistDecision(required(values, ++index, flag), flag);
    else if (flag === "--typography") typography = checklistDecision(required(values, ++index, flag), flag);
    else if (flag === "--sections") sections = checklistDecision(required(values, ++index, flag), flag);
    else if (flag === "--visual-preview") visualPreview = required(values, ++index, flag);
    else if (flag === "--audio") audio = audioDecision(required(values, ++index, flag));
    else if (flag === "--audio-preview") audioPreview = required(values, ++index, flag);
    else if (flag === "--audio-preview-sha256") audioPreviewSha256 = required(values, ++index, flag);
    else if (flag === "--bgm") bgm = bgmDecision(required(values, ++index, flag));
    else if (flag === "--output-spec") outputSpec = approved(required(values, ++index, flag));
    else if (flag === "--json") json = true;
    else if (flag === "--help" || flag === "-h") throw new Error(USAGE);
    else throw new Error(`unknown argument: ${flag}\n${USAGE}`);
  }
  if (!projectDir) throw new Error(`--project is required\n${USAGE}`);
  return {
    command,
    projectDir: path.resolve(projectDir),
    approvedBy,
    approvedAt,
    captions,
    typography,
    sections,
    visualPreview,
    audio,
    audioPreview,
    audioPreviewSha256,
    bgm,
    outputSpec,
    json,
  };
}

export async function runFinalRenderChecklistCli(argv = process.argv): Promise<number> {
  if (argv.slice(2).some((value) => value === "--help" || value === "-h")) {
    console.log(USAGE);
    return 0;
  }
  try {
    const args = parseFinalRenderChecklistArgs(argv);
    if (args.command === "status") {
      const result = inspectFinalRenderApproval(args.projectDir);
      console.log(args.json ? JSON.stringify(result, null, 2) : formatStatus(result));
      return result.ready ? 0 : 1;
    }
    for (const [name, value] of Object.entries({
      "--approved-by": args.approvedBy,
      "--captions": args.captions,
      "--typography": args.typography,
      "--sections": args.sections,
      "--audio": args.audio,
      "--bgm": args.bgm,
      "--output-spec": args.outputSpec,
    })) {
      if (!value) throw new Error(`${name} is required for approve`);
    }
    const approval = approveFinalRenderChecklist(args.projectDir, {
      approvedBy: args.approvedBy!,
      approvedAt: args.approvedAt,
      checklist: {
        captions: args.captions!,
        caption_typography: args.typography!,
        section_titles: args.sections!,
        ...(
          args.captions === "approved"
          || args.typography === "approved"
          || args.sections === "approved"
            ? {
              visual_preview: {
                reviewed: true,
                manifest_path: requireVisualPreview(args),
                manifest_sha256: computeSha256(resolveVisualPreviewPath(args)),
              },
            }
            : { visual_preview: { reviewed: false } }
        ),
        audio: {
          decision: args.audio!,
          preview_reviewed: args.audio === "preserve" ? false : true,
          ...(args.audioPreview ? { preview_path: args.audioPreview } : {}),
          ...(args.audioPreviewSha256 ? { preview_sha256: args.audioPreviewSha256 } : {}),
          bgm: args.bgm!,
        },
        output_spec: args.outputSpec!,
      },
    });
    console.log(args.json ? JSON.stringify(approval, null, 2) : [
      "[final-render-checklist] approved",
      `project: ${approval.project_id}`,
      `approval_key: ${approval.approval_key}`,
    ].join("\n"));
    return 0;
  } catch (error) {
    console.error(`[final-render-checklist] ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

function requireVisualPreview(args: Args): string {
  if (!args.visualPreview) {
    throw new Error(
      "--visual-preview is required when captions, typography, or sections are approved",
    );
  }
  if (path.isAbsolute(args.visualPreview)) {
    throw new Error("--visual-preview must be project-relative");
  }
  return args.visualPreview;
}

function resolveVisualPreviewPath(args: Args): string {
  const relativePath = requireVisualPreview(args);
  const candidate = path.resolve(args.projectDir, relativePath);
  const relative = path.relative(args.projectDir, candidate);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("--visual-preview must remain inside the project");
  }
  return candidate;
}

function formatStatus(result: ReturnType<typeof inspectFinalRenderApproval>): string {
  return [
    `[final-render-checklist] ${result.status}`,
    `path: ${result.path}`,
    ...result.issues.map((issue) => `- ${issue}`),
  ].join("\n");
}

function required(values: string[], index: number, flag: string): string {
  const value = values[index];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

function checklistDecision(value: string, flag: string): FinalRenderChecklistDecision {
  if (value === "approved" || value === "not_applicable") return value;
  throw new Error(`${flag} must be approved or not_applicable`);
}

function audioDecision(value: string): FinalRenderAudioDecision {
  if (value === "preserve" || value === "dialogue-clean" || value === "loudness-only") return value;
  throw new Error("--audio must be preserve, dialogue-clean, or loudness-only");
}

function bgmDecision(value: string): "none" | "approved" {
  if (value === "none" || value === "approved") return value;
  throw new Error("--bgm must be none or approved");
}

function approved(value: string): "approved" {
  if (value === "approved") return value;
  throw new Error("--output-spec must be approved");
}

const isMain = process.argv[1]
  ? import.meta.url === pathToFileURL(process.argv[1]).href
  : false;
if (isMain) {
  runFinalRenderChecklistCli().then((code) => { process.exitCode = code; });
}
