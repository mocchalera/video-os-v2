#!/usr/bin/env npx tsx

import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { retimeCaptionDraft } from "../runtime/commands/caption.js";

export const CAPTION_RETIME_USAGE = `Usage:
  npx tsx scripts/caption-retime.ts --project <dir> [--json]

Recomputes caption_draft timing from the current transcript word timestamps.
Caption text, IDs, review patch, approval, and project state are not rewritten.`;

export function runCaptionRetimeCli(argv = process.argv): number {
  const values = argv.slice(2);
  if (values.includes("--help") || values.includes("-h")) {
    console.log(CAPTION_RETIME_USAGE);
    return 0;
  }
  let projectDir: string | undefined;
  let json = false;
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--project") projectDir = values[++index];
    else if (value === "--json") json = true;
    else {
      console.error(`unknown argument: ${value}\n${CAPTION_RETIME_USAGE}`);
      return 1;
    }
  }
  if (!projectDir) {
    console.error(`--project is required\n${CAPTION_RETIME_USAGE}`);
    return 1;
  }
  const result = retimeCaptionDraft(path.resolve(projectDir));
  if (!result.success) {
    console.error(result.error?.message ?? "caption retime failed");
    return 1;
  }
  const output = {
    success: true,
    caption_count: result.captionDraft?.speech_captions.length ?? 0,
    draft_status: result.captionDraft?.draft_status,
    timing_report: result.captionTimingReport,
  };
  console.log(json ? JSON.stringify(output, null, 2) : [
    `[caption-retime] ${output.caption_count} captions`,
    `draft: ${output.draft_status}`,
    `question adjustments: ${output.timing_report?.question_adjusted_count ?? 0}`,
    `previous-speech guards: ${output.timing_report?.previous_speech_guard_count ?? 0}`,
    `gap tail holds: ${output.timing_report?.gap_tail_hold_count ?? 0}`,
  ].join("\n"));
  return 0;
}

const isMain = process.argv[1]
  ? import.meta.url === pathToFileURL(process.argv[1]).href
  : false;
if (isMain) process.exitCode = runCaptionRetimeCli();
