#!/usr/bin/env npx tsx

import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import {
  applyCaptionReview,
  approveCaptionReview,
  canUndoCaptionReview,
  captionGlossaryProposals,
  captionReviewUndoDepth,
  editCaptionReview,
  initializeCaptionReviewPatch,
  inspectCaptionReviewOperationalState,
  loadCaptionReviewContext,
  mergeCaptionReview,
  proposeCaptionGlossaryTerm,
  queueCaptionReview,
  prepareCaptionReviewDraft,
  retimeCaptionReview,
  splitCaptionReview,
  undoCaptionReview,
  validateCaptionReview,
  verifySafeCaptionReview,
} from "../runtime/caption/review-service.js";
import type {
  CaptionReviewQueueItem,
  CaptionReviewSeverity,
} from "../runtime/caption/review-core.js";
import {
  resolveCaptionStylePreset,
  type CaptionStylePreset,
} from "../editor/shared/caption-style-tokens.js";

type CaptionReviewCommand = "queue" | "prepare" | "recover" | "init" | "verify-safe" | "edit" | "split" | "merge" | "retime" | "glossary-propose" | "undo" | "apply" | "validate" | "approve";
type QueueFormat = "json" | "csv" | "html";

export interface CaptionReviewCliArgs {
  command: CaptionReviewCommand;
  projectDir: string;
  patchPath?: string;
  reviewer?: string;
  captionID?: string;
  nextCaptionID?: string;
  text?: string;
  firstText?: string;
  secondText?: string;
  canonical?: string;
  variants: string[];
  state?: "unreviewed" | "verified" | "flagged";
  startFrame?: number;
  endFrame?: number;
  splitFrame?: number;
  baseTextHash?: string;
  nextBaseTextHash?: string;
  baseCaptionDraftHash?: string;
  captionTextHashes: Record<string, string>;
  note?: string;
  category?: "stt" | "proper_noun" | "kanji" | "punctuation" | "other";
  format: QueueFormat;
  outputPath?: string;
  limit?: number;
  severity: CaptionReviewSeverity | "all";
}

const USAGE = `Usage:
  npx tsx scripts/caption-review.ts queue --project <dir> [--reviewer <name>] [--format json|csv|html] [--output <file>] [--severity block|warn|info|all] [--limit N]
  npx tsx scripts/caption-review.ts prepare --project <dir>
  npx tsx scripts/caption-review.ts recover --project <dir>   # prepare alias
  npx tsx scripts/caption-review.ts init --project <dir> --reviewer <name> [--patch <file>]
  npx tsx scripts/caption-review.ts verify-safe --project <dir> --reviewer <name> --base-caption-draft-hash <hash> --caption-text-hash <id>=<hash> [...]
  npx tsx scripts/caption-review.ts edit --project <dir> --caption-id <id> [--text <text>] [--start-frame N --end-frame N] [--state unreviewed|verified|flagged] [--base-text-hash <hash>] [--category stt|proper_noun|kanji|punctuation|other] [--note <text>]
  npx tsx scripts/caption-review.ts split --project <dir> --caption-id <id> --split-frame N [--first-text <text> --second-text <text>] [--base-text-hash <hash>]
  npx tsx scripts/caption-review.ts merge --project <dir> --caption-id <id> --next-caption-id <id> [--text <text>] [--base-text-hash <hash> --next-base-text-hash <hash>]
  npx tsx scripts/caption-review.ts retime --project <dir> --reviewer <name>
  npx tsx scripts/caption-review.ts glossary-propose --project <dir> --caption-id <id> --canonical <term> [--variant <text> ...]
  npx tsx scripts/caption-review.ts undo --project <dir>
  npx tsx scripts/caption-review.ts apply --project <dir> [--patch <file>]
  npx tsx scripts/caption-review.ts validate --project <dir> [--patch <file>]
  npx tsx scripts/caption-review.ts approve --project <dir> --reviewer <name> [--patch <file>]`;

export function parseCaptionReviewArgs(argv: string[]): CaptionReviewCliArgs {
  const args = argv.slice(2);
  const command = args.shift() as CaptionReviewCommand | undefined;
  if (!command || !["queue", "prepare", "recover", "init", "verify-safe", "edit", "split", "merge", "retime", "glossary-propose", "undo", "apply", "validate", "approve"].includes(command)) {
    throw new Error(`A valid command is required.\n${USAGE}`);
  }

  let projectDir: string | undefined;
  let patchPath: string | undefined;
  let reviewer: string | undefined;
  let captionID: string | undefined;
  let nextCaptionID: string | undefined;
  let text: string | undefined;
  let firstText: string | undefined;
  let secondText: string | undefined;
  let canonical: string | undefined;
  const variants: string[] = [];
  let state: CaptionReviewCliArgs["state"];
  let startFrame: number | undefined;
  let endFrame: number | undefined;
  let splitFrame: number | undefined;
  let baseTextHash: string | undefined;
  let nextBaseTextHash: string | undefined;
  let baseCaptionDraftHash: string | undefined;
  const captionTextHashes: Record<string, string> = {};
  let note: string | undefined;
  let category: CaptionReviewCliArgs["category"];
  let format: QueueFormat = "json";
  let outputPath: string | undefined;
  let limit: number | undefined;
  let severity: CaptionReviewSeverity | "all" = "warn";

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--help" || arg === "-h") throw new Error(USAGE);
    if (arg === "--project") projectDir = requiredValue(args, ++index, arg);
    else if (arg === "--patch") patchPath = requiredValue(args, ++index, arg);
    else if (arg === "--reviewer") reviewer = requiredValue(args, ++index, arg);
    else if (arg === "--caption-id") captionID = requiredValue(args, ++index, arg);
    else if (arg === "--next-caption-id") nextCaptionID = requiredValue(args, ++index, arg);
    else if (arg === "--text") text = requiredValue(args, ++index, arg);
    else if (arg === "--first-text") firstText = requiredValue(args, ++index, arg);
    else if (arg === "--second-text") secondText = requiredValue(args, ++index, arg);
    else if (arg === "--canonical") canonical = requiredValue(args, ++index, arg);
    else if (arg === "--variant") variants.push(requiredValue(args, ++index, arg));
    else if (arg === "--start-frame") startFrame = integerValue(args, ++index, arg);
    else if (arg === "--end-frame") endFrame = integerValue(args, ++index, arg);
    else if (arg === "--split-frame") splitFrame = integerValue(args, ++index, arg);
    else if (arg === "--base-text-hash") baseTextHash = requiredValue(args, ++index, arg);
    else if (arg === "--next-base-text-hash") nextBaseTextHash = requiredValue(args, ++index, arg);
    else if (arg === "--base-caption-draft-hash") baseCaptionDraftHash = requiredValue(args, ++index, arg);
    else if (arg === "--caption-text-hash") {
      const value = requiredValue(args, ++index, arg);
      const separator = value.indexOf("=");
      if (separator <= 0 || separator === value.length - 1) throw new Error("--caption-text-hash requires <caption-id>=<hash>");
      captionTextHashes[value.slice(0, separator)] = value.slice(separator + 1);
    }
    else if (arg === "--state") {
      const value = requiredValue(args, ++index, arg);
      if (!isReviewState(value)) throw new Error(`Unsupported review state: ${value}`);
      state = value;
    } else if (arg === "--note") note = requiredValue(args, ++index, arg);
    else if (arg === "--category") {
      const value = requiredValue(args, ++index, arg);
      if (!isEditCategory(value)) throw new Error(`Unsupported edit category: ${value}`);
      category = value;
    } else if (arg === "--format") {
      const value = requiredValue(args, ++index, arg);
      if (!isQueueFormat(value)) throw new Error(`Unsupported queue format: ${value}`);
      format = value;
    } else if (arg === "--output") outputPath = requiredValue(args, ++index, arg);
    else if (arg === "--limit") {
      const value = Number.parseInt(requiredValue(args, ++index, arg), 10);
      if (!Number.isInteger(value) || value <= 0) throw new Error("--limit must be a positive integer");
      limit = value;
    } else if (arg === "--severity") {
      const value = requiredValue(args, ++index, arg);
      if (!isSeverity(value)) throw new Error(`Unsupported severity: ${value}`);
      severity = value;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!projectDir) throw new Error(`--project is required.\n${USAGE}`);
  if ((command === "init" || command === "approve" || command === "verify-safe" || command === "retime") && !reviewer?.trim()) {
    throw new Error(`--reviewer is required for ${command}`);
  }
  if (command === "verify-safe" && (!baseCaptionDraftHash || Object.keys(captionTextHashes).length === 0)) {
    throw new Error("verify-safe requires --base-caption-draft-hash and at least one --caption-text-hash");
  }
  if (command === "edit" && (!captionID ||
      (text === undefined && state === undefined && startFrame === undefined && endFrame === undefined))) {
    throw new Error("edit requires --caption-id and at least one text, timing, or review-state change");
  }
  if (command === "edit" && ((startFrame === undefined) !== (endFrame === undefined))) {
    throw new Error("edit timing requires both --start-frame and --end-frame");
  }
  if (command === "split" && (!captionID || splitFrame === undefined)) {
    throw new Error("split requires --caption-id and --split-frame");
  }
  if (command === "split" && ((firstText === undefined) !== (secondText === undefined))) {
    throw new Error("split text override requires both --first-text and --second-text");
  }
  if (command === "merge" && (!captionID || !nextCaptionID)) {
    throw new Error("merge requires --caption-id and --next-caption-id");
  }
  if (command === "glossary-propose" && (!captionID || !canonical?.trim())) {
    throw new Error("glossary-propose requires --caption-id and --canonical");
  }
  const mutationCommands: CaptionReviewCommand[] = ["edit", "split", "merge", "glossary-propose"];
  if (!mutationCommands.includes(command) && command !== "verify-safe" &&
      (captionID || nextCaptionID || text !== undefined || firstText !== undefined || secondText !== undefined ||
        state || note || category || startFrame !== undefined || endFrame !== undefined || splitFrame !== undefined ||
        baseTextHash || nextBaseTextHash || baseCaptionDraftHash || Object.keys(captionTextHashes).length > 0 || canonical || variants.length > 0)) {
    throw new Error("caption mutation arguments are only valid for edit, split, merge, or glossary-propose");
  }
  if (command !== "glossary-propose" && (canonical || variants.length > 0)) {
    throw new Error("--canonical and --variant are only valid for glossary-propose");
  }
  if (command !== "queue" && outputPath) throw new Error("--output is only valid for queue");
  if (command !== "queue" && (format !== "json" || limit !== undefined || severity !== "warn")) {
    throw new Error("--format, --limit, and --severity are only valid for queue");
  }

  return {
    command,
    projectDir: path.resolve(projectDir),
    patchPath: patchPath ? path.resolve(patchPath) : undefined,
    reviewer,
    captionID,
    nextCaptionID,
    text,
    firstText,
    secondText,
    canonical,
    variants,
    state,
    startFrame,
    endFrame,
    splitFrame,
    baseTextHash,
    nextBaseTextHash,
    baseCaptionDraftHash,
    captionTextHashes,
    note,
    category,
    format,
    outputPath: outputPath ? path.resolve(outputPath) : undefined,
    limit,
    severity,
  };
}

export function runCaptionReviewCli(
  argv = process.argv,
  write: (message: string) => void = (message) => console.log(message),
): number {
  if (argv.slice(2).some((value) => value === "--help" || value === "-h")) {
    write(USAGE);
    return 0;
  }
  const args = parseCaptionReviewArgs(argv);
  switch (args.command) {
    case "queue": {
      const operational = inspectCaptionReviewOperationalState(
        args.projectDir,
        args.reviewer,
        args.patchPath,
      );
      if (operational.status === "needs_recovery") {
        if (args.format !== "json") throw new Error(operational.recoveryAction!.message);
        write(JSON.stringify({
          version: "caption-review-queue/v2",
          project: args.projectDir,
          status: operational.status,
          recovery_action: operational.recoveryAction,
          approval_readiness: operational.approvalReadiness,
          safe_bulk_review: operational.safeBulk,
          total_caption_count: 0,
          matched_caption_count: 0,
          exported_caption_count: 0,
          items: [],
        }, null, 2));
        return 0;
      }
      const allItems = operational.items;
      const filtered = filterQueue(allItems, args.severity);
      const items = args.limit === undefined ? filtered : filtered.slice(0, args.limit);
      const context = loadCaptionReviewContext(args.projectDir);
      const rendered = renderQueue(items, args.format, {
        projectDir: args.projectDir,
        total: allItems.length,
        selected: filtered.length,
        fps: context.fps,
        captionStyle: resolveCaptionStylePreset(context.draft.caption_policy.styling_class),
        canUndo: canUndoCaptionReview(args.projectDir),
        undoDepth: captionReviewUndoDepth(args.projectDir),
        glossaryProposals: captionGlossaryProposals(args.projectDir),
        baseCaptionDraftHash: operational.baseCaptionDraftHash!,
        approvalReadiness: operational.approvalReadiness,
        safeBulk: operational.safeBulk,
        fontContract: operational.fontContract!,
        currentApproval: operational.currentApproval,
        approvalWarning: operational.approvalWarning,
      });
      if (args.outputPath) {
        fs.mkdirSync(path.dirname(args.outputPath), { recursive: true });
        fs.writeFileSync(args.outputPath, rendered, "utf-8");
        write(JSON.stringify({ command: "queue", output_path: args.outputPath, item_count: items.length }));
      } else {
        write(rendered);
      }
      return 0;
    }
    case "prepare":
    case "recover": {
      const result = prepareCaptionReviewDraft(args.projectDir);
      write(JSON.stringify({
        command: args.command,
        status: result.status,
        caption_draft_path: result.draftPath,
        base_caption_draft_hash: result.draftHash,
      }, null, 2));
      return 0;
    }
    case "init": {
      const result = initializeCaptionReviewPatch(args.projectDir, args.reviewer!, {
        outputPath: args.patchPath,
      });
      write(JSON.stringify({
        command: "init",
        patch_path: result.patchPath,
        base_caption_draft_hash: result.patch.base_caption_draft_hash,
        base_timeline_hash: result.patch.base_timeline_hash,
      }, null, 2));
      return 0;
    }
    case "edit": {
      const result = editCaptionReview(args.projectDir, {
        captionID: args.captionID!,
        text: args.text,
        state: args.state,
        startFrame: args.startFrame,
        endFrame: args.endFrame,
        expectedTextHash: args.baseTextHash,
        note: args.note,
        category: args.category,
      });
      const edited = result.preview.speech_captions.find(
        (entry) => entry.caption_id === args.captionID,
      );
      write(JSON.stringify({
        command: "edit",
        patch_path: result.patchPath,
        preview_path: result.previewPath,
        operation_count: result.patch.operations.length,
        caption: edited && {
          caption_id: edited.caption_id,
          text: edited.text,
          text_hash: edited.text_hash,
          review_state: edited.review.state,
          risk_score: edited.risk_score,
          issues: edited.issues,
        },
        validation: result.preview.validation,
      }, null, 2));
      return 0;
    }
    case "verify-safe": {
      const result = verifySafeCaptionReview(args.projectDir, {
        reviewer: args.reviewer!,
        baseCaptionDraftHash: args.baseCaptionDraftHash!,
        captionTextHashes: args.captionTextHashes,
      });
      write(JSON.stringify({
        command: "verify-safe",
        patch_path: result.patchPath,
        preview_path: result.previewPath,
        verified_count: result.assessment.eligible_count,
        excluded_count: result.assessment.excluded.length,
        excluded: result.assessment.excluded,
        exclusion_reason_counts: result.assessment.exclusion_reason_counts,
        undo_depth: captionReviewUndoDepth(args.projectDir),
        validation: result.preview.validation,
      }, null, 2));
      return 0;
    }
    case "split": {
      const result = splitCaptionReview(args.projectDir, {
        captionID: args.captionID!,
        splitFrame: args.splitFrame!,
        firstText: args.firstText,
        secondText: args.secondText,
        expectedTextHash: args.baseTextHash,
      });
      writeMutationResult("split", result, write);
      return 0;
    }
    case "merge": {
      const result = mergeCaptionReview(args.projectDir, {
        firstCaptionID: args.captionID!,
        secondCaptionID: args.nextCaptionID!,
        text: args.text,
        expectedFirstTextHash: args.baseTextHash,
        expectedSecondTextHash: args.nextBaseTextHash,
      });
      writeMutationResult("merge", result, write);
      return 0;
    }
    case "retime": {
      const result = retimeCaptionReview(args.projectDir, args.reviewer!);
      write(JSON.stringify({
        command: "retime",
        patch_path: result.patchPath,
        preview_path: result.previewPath,
        timing_report_path: result.timingReportPath,
        adjusted_caption_count: result.adjustedCaptionCount,
        timing_report: result.timingReport,
        validation: result.preview.validation,
      }, null, 2));
      return 0;
    }
    case "glossary-propose": {
      const result = proposeCaptionGlossaryTerm(args.projectDir, {
        canonical: args.canonical!,
        variants: args.variants,
        sourceCaptionIDs: [args.captionID!],
      });
      writeMutationResult("glossary-propose", result, write);
      return 0;
    }
    case "undo": {
      const result = undoCaptionReview(args.projectDir);
      writeMutationResult("undo", result, write);
      return 0;
    }
    case "apply": {
      const result = applyCaptionReview(args.projectDir, args.patchPath);
      write(JSON.stringify({
        command: "apply",
        patch_path: result.patchPath,
        preview_path: result.previewPath,
        operation_count: result.patch.operations.length,
        diff_count: result.diffs.length,
        validation: result.preview.validation,
      }, null, 2));
      return 0;
    }
    case "validate": {
      const result = validateCaptionReview(args.projectDir, args.patchPath);
      write(JSON.stringify({
        command: "validate",
        valid: result.valid,
        validation: result.preview?.validation,
        errors: result.errors,
      }, null, 2));
      return result.valid ? 0 : 1;
    }
    case "approve": {
      const result = approveCaptionReview(args.projectDir, args.reviewer!, {
        patchPath: args.patchPath,
      });
      write(JSON.stringify({
        command: "approve",
        approval_path: result.approvalPath,
        approved_by: result.approval.approval.approved_by,
        approved_at: result.approval.approval.approved_at,
        caption_count: result.approval.speech_captions.length,
        caption_review_patch_hash: result.patchHash,
        validation_hash: result.validationHash,
        approval_hash: result.approvalHash,
        status: result.approval.approval.status,
      }, null, 2));
      return 0;
    }
  }
}

function filterQueue(
  items: CaptionReviewQueueItem[],
  severity: CaptionReviewSeverity | "all",
): CaptionReviewQueueItem[] {
  if (severity === "all") return items;
  const rank: Record<CaptionReviewSeverity, number> = { info: 1, warn: 2, block: 3 };
  const minimum = rank[severity];
  return items.filter((item) => item.issues.some((issue) => rank[issue.severity] >= minimum));
}

function renderQueue(
  items: CaptionReviewQueueItem[],
  format: QueueFormat,
  metadata: {
    projectDir: string;
    total: number;
    selected: number;
    fps: number;
    captionStyle: CaptionStylePreset;
    canUndo: boolean;
    undoDepth: number;
    glossaryProposals: ReturnType<typeof captionGlossaryProposals>;
    baseCaptionDraftHash: string;
    approvalReadiness: ReturnType<typeof inspectCaptionReviewOperationalState>["approvalReadiness"];
    safeBulk: ReturnType<typeof inspectCaptionReviewOperationalState>["safeBulk"];
    fontContract: NonNullable<ReturnType<typeof inspectCaptionReviewOperationalState>["fontContract"]>;
    currentApproval: ReturnType<typeof inspectCaptionReviewOperationalState>["currentApproval"];
    approvalWarning: ReturnType<typeof inspectCaptionReviewOperationalState>["approvalWarning"];
  },
): string {
  if (format === "json") {
    return JSON.stringify({
      version: "caption-review-queue/v2",
      project: metadata.projectDir,
      status: "ready",
      base_caption_draft_hash: metadata.baseCaptionDraftHash,
      fps: metadata.fps,
      caption_style: {
        preset_id: metadata.captionStyle.presetId,
        font_id: metadata.captionStyle.fontId,
        font_family: metadata.captionStyle.fontFamily,
        font_weight: metadata.captionStyle.fontWeight,
        font_size_px_1080: metadata.captionStyle.fontSizePx1080,
        line_height_px_1080: metadata.captionStyle.lineHeightPx1080,
        outline_px_1080: metadata.captionStyle.outlinePx1080,
        margin_v_1080: metadata.captionStyle.marginV1080,
        max_width_ratio: metadata.captionStyle.maxWidthRatio,
        alignment: metadata.captionStyle.alignment,
      },
      can_undo: metadata.canUndo,
      undo_depth: metadata.undoDepth,
      glossary_proposals: metadata.glossaryProposals,
      approval_readiness: metadata.approvalReadiness,
      safe_bulk_review: metadata.safeBulk,
      font_contract: metadata.fontContract,
      ...(metadata.currentApproval ? { current_approval: metadata.currentApproval } : {}),
      ...(metadata.approvalWarning ? { approval_warning: metadata.approvalWarning } : {}),
      total_caption_count: metadata.total,
      matched_caption_count: metadata.selected,
      exported_caption_count: items.length,
      items,
    }, null, 2);
  }
  if (format === "csv") {
    const rows = [
      ["caption_id", "timeline_in_frame", "timeline_duration_frames", "risk_score", "review_state", "text_hash", "issue_codes", "source_text", "text"],
      ...items.map((item) => [
        item.caption_id,
        String(item.timeline_in_frame),
        String(item.timeline_duration_frames),
        String(item.risk_score),
        item.review_state,
        item.text_hash,
        item.issues.map((issue) => issue.code).join("|"),
        item.source_text,
        item.text,
      ]),
    ];
    return rows.map((row) => row.map(csvCell).join(",")).join("\n") + "\n";
  }
  const rows = items.map((item) => `
      <tr>
        <td>${escapeHtml(item.caption_id)}</td>
        <td>${item.timeline_in_frame}</td>
        <td>${item.risk_score}</td>
        <td>${escapeHtml(item.issues.map((issue) => issue.code).join(", "))}</td>
        <td class="caption">${escapeHtml(item.text).replace(/\n/g, "<br>")}</td>
      </tr>`).join("");
  return `<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><title>Caption Review Queue</title>
<style>body{font-family:-apple-system,BlinkMacSystemFont,"Hiragino Sans",sans-serif;margin:32px;color:#171717}table{border-collapse:collapse;width:100%}th,td{border-bottom:1px solid #ddd;padding:10px;text-align:left;vertical-align:top}.caption{font-size:18px;line-height:1.55}th{position:sticky;top:0;background:#fff}</style></head>
<body><h1>字幕レビューキュー</h1><p>${metadata.selected} / ${metadata.total} 件（export ${items.length}件）</p>
<table><thead><tr><th>ID</th><th>Frame</th><th>Risk</th><th>Issues</th><th>Caption</th></tr></thead><tbody>${rows}</tbody></table></body></html>`;
}

function writeMutationResult(
  command: "split" | "merge" | "glossary-propose" | "undo",
  result: ReturnType<typeof splitCaptionReview>,
  write: (message: string) => void,
): void {
  write(JSON.stringify({
    command,
    patch_path: result.patchPath,
    preview_path: result.previewPath,
    operation_count: result.patch.operations.length,
    validation: result.preview.validation,
  }, null, 2));
}

function csvCell(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character]!);
}

function requiredValue(args: string[], index: number, flag: string): string {
  const value = args[index];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

function integerValue(args: string[], index: number, flag: string): number {
  const value = Number.parseInt(requiredValue(args, index, flag), 10);
  if (!Number.isInteger(value) || value < 0) throw new Error(`${flag} requires a non-negative integer`);
  return value;
}

function isQueueFormat(value: string): value is QueueFormat {
  return value === "json" || value === "csv" || value === "html";
}

function isSeverity(value: string): value is CaptionReviewSeverity | "all" {
  return value === "block" || value === "warn" || value === "info" || value === "all";
}

function isReviewState(value: string): value is NonNullable<CaptionReviewCliArgs["state"]> {
  return value === "unreviewed" || value === "verified" || value === "flagged";
}

function isEditCategory(value: string): value is NonNullable<CaptionReviewCliArgs["category"]> {
  return value === "stt" || value === "proper_noun" || value === "kanji" || value === "punctuation" || value === "other";
}

const isMain = process.argv[1]
  ? import.meta.url === pathToFileURL(process.argv[1]).href
  : false;

if (isMain) {
  try {
    process.exitCode = runCaptionReviewCli(process.argv);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
