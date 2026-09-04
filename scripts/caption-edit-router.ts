#!/usr/bin/env npx tsx

import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import {
  inspectCaptionEditProject,
  routeCaptionEditInstruction,
} from "../runtime/caption/edit-router.js";

interface Args {
  projectDir: string;
  instruction: string;
  reviewer: string;
  subjectEvidence: boolean;
  writeReceipt: boolean;
}

const USAGE = `Usage:
  npx tsx scripts/caption-edit-router.ts --project <dir> --instruction <text> --reviewer <name> [--subject-evidence] [--write-receipt]

Routes one human instruction to caption_review_patch, caption_visual_treatment,
timeline_review_patch, or a reasoned hold. --write-receipt writes only
06_review/caption-edit-route.json; it never writes a patch or approval.`;

export function parseCaptionEditRouterArgs(argv: string[]): Args {
  const values = argv.slice(2);
  let projectDir: string | undefined;
  let instruction: string | undefined;
  let reviewer: string | undefined;
  let subjectEvidence = false;
  let writeReceipt = false;
  for (let index = 0; index < values.length; index += 1) {
    const flag = values[index];
    if (flag === "--help" || flag === "-h") throw new Error(USAGE);
    if (flag === "--project") projectDir = required(values, ++index, flag);
    else if (flag === "--instruction") instruction = required(values, ++index, flag);
    else if (flag === "--reviewer") reviewer = required(values, ++index, flag);
    else if (flag === "--subject-evidence") subjectEvidence = true;
    else if (flag === "--write-receipt") writeReceipt = true;
    else throw new Error(`Unknown argument: ${flag}\n${USAGE}`);
  }
  if (!projectDir || !instruction || !reviewer) throw new Error(USAGE);
  return { projectDir: path.resolve(projectDir), instruction, reviewer, subjectEvidence, writeReceipt };
}

function required(values: string[], index: number, flag: string): string {
  const value = values[index];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

function writeAtomicJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.renameSync(temporary, filePath);
}

export function runCaptionEditRouter(
  argv = process.argv,
  write: (message: string) => void = (message) => console.log(message),
): number {
  if (argv.slice(2).some((value) => value === "--help" || value === "-h")) {
    write(USAGE);
    return 0;
  }
  const args = parseCaptionEditRouterArgs(argv);
  const project = inspectCaptionEditProject(args.projectDir, args.reviewer);
  const route = routeCaptionEditInstruction(args.instruction, { subjectEvidence: args.subjectEvidence });
  const receiptPath = path.join(args.projectDir, "06_review/caption-edit-route.json");
  const result = {
    ...route,
    project,
    initialization_required:
      route.route === "caption_review_patch" || route.route === "caption_visual_treatment"
        ? project.caption_draft === "missing" || project.caption_approval !== "approved"
        : false,
    receipt_path: args.writeReceipt ? receiptPath : null,
  };
  if (args.writeReceipt) writeAtomicJson(receiptPath, route);
  write(JSON.stringify(result, null, 2));
  return route.status === "routed" && route.route !== null ? 0 : 2;
}

const isDirectRun = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  try {
    process.exitCode = runCaptionEditRouter();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
