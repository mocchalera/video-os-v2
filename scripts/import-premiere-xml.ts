#!/usr/bin/env npx tsx
/**
 * CLI: Import Premiere Pro XML (FCP7) back into timeline.json
 *
 * Usage:
 *   npx tsx scripts/import-premiere-xml.ts <project-path> --xml <edited.xml> [--apply] [--dry-run] [--json]
 *
 * Options:
 *   --xml <path>    Path to the FCP7 XML exported from Premiere Pro
 *   --receipt <path> Premiere roundtrip receipt (required with --apply)
 *   --apply         Apply mapped changes to timeline.json (default: preview)
 *   --dry-run       Compatibility alias for preview mode
 *   --json          Emit exactly one JSON result document
 *
 * Output:
 *   - Diff report to stdout
 *   - Updated timeline.json only with --apply and applicable mapped changes
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import type { TimelineIR } from "../runtime/compiler/types.js";
import {
  parseFcp7Sequence,
  detectDiffs,
  applyDiffs,
  type ImportDiffReport,
  type ClipDiff,
} from "../runtime/handoff/fcp7-xml-import.js";
import {
  parsePremiereRoundtripReceipt,
  validatePremiereRoundtripApply,
  type PremiereRoundtripReceipt,
  type PremiereRoundtripValidation,
} from "../runtime/handoff/premiere-roundtrip-receipt.js";
import { classifyPremiereVideoTreatments } from "../runtime/handoff/premiere-effect-bake.js";

// ── Arg parsing ─────────────────────────────────────────────────────

const USAGE =
  "Usage: npx tsx scripts/import-premiere-xml.ts <project-path> --xml <edited.xml> [--receipt <receipt.json>] [--apply] [--dry-run] [--json]";

type ImportMode = "preview" | "apply";

export function parseArgs(argv: string[]): {
  projectPath: string;
  xmlPath: string;
  receiptPath?: string;
  mode: ImportMode;
  jsonOutput: boolean;
} {
  const args = argv.slice(2);
  let projectPath: string | undefined;
  let xmlPath: string | undefined;
  let receiptPath: string | undefined;
  let apply = false;
  let dryRun = false;
  let jsonOutput = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--help" || arg === "-h") {
      console.log(USAGE);
      process.exit(0);
    } else if (arg === "--xml" && i + 1 < args.length) {
      xmlPath = args[++i];
    } else if (arg === "--receipt" && i + 1 < args.length) {
      receiptPath = args[++i];
    } else if (arg === "--apply") {
      apply = true;
    } else if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg === "--json") {
      jsonOutput = true;
    } else if (arg.startsWith("-")) {
      throw new Error(`Unknown argument: ${arg}`);
    } else if (!projectPath) {
      projectPath = arg;
    } else {
      throw new Error(`Unexpected argument: ${arg}`);
    }
  }

  if (apply && dryRun) {
    throw new Error("--apply and --dry-run cannot be used together");
  }

  if (!projectPath || !xmlPath) {
    throw new Error("Error: <project-path> and --xml <edited.xml> are required");
  }
  if (apply && !receiptPath) {
    throw new Error("--receipt is required with --apply");
  }

  return {
    projectPath: path.resolve(projectPath),
    xmlPath: path.resolve(xmlPath),
    receiptPath: receiptPath ? path.resolve(receiptPath) : undefined,
    mode: apply ? "apply" : "preview",
    jsonOutput,
  };
}

// ── Diff report formatting ──────────────────────────────────────────

/** Format microseconds as human-readable timecode (HH:MM:SS.mmm) */
function usToTimecode(us: number): string {
  const totalSec = us / 1_000_000;
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${s.toFixed(3).padStart(6, "0")}`;
  if (m > 0) return `${m}:${s.toFixed(3).padStart(6, "0")}`;
  return `${s.toFixed(3)}s`;
}

function formatDiffReport(report: ImportDiffReport): string {
  const lines: string[] = [];

  lines.push(`\n=== Premiere XML Import Diff Report ===`);
  lines.push(`Sequence: ${report.sequenceName}`);
  lines.push(`Total clips in XML: ${report.totalClipsInXml}`);
  lines.push(`  Mapped (with video_os marker): ${report.mappedClips}`);
  lines.push(`  Unmapped (new in Premiere): ${report.unmappedClips}`);
  lines.push(`Diffs detected: ${report.diffs.length}`);
  lines.push(`Unsupported edits detected: ${report.unsupportedEdits.length}`);
  lines.push(`Text-overlay edits detected: ${report.textOverlayEdits.length}`);
  lines.push(`Simple-transition edits detected: ${report.transitionEdits.length}`);
  lines.push(`Transition source-handle authority: ${report.transitionSourceHandleAuthority}`);
  lines.push(``);

  if (report.diffs.length === 0 && report.unsupportedEdits.length === 0 && report.textOverlayEdits.length === 0 && report.transitionEdits.length === 0) {
    lines.push(`No changes detected. Timeline is identical.`);
    return lines.join("\n");
  }

  // Group by kind
  const grouped = new Map<string, ClipDiff[]>();
  for (const diff of report.diffs) {
    const list = grouped.get(diff.kind) ?? [];
    list.push(diff);
    grouped.set(diff.kind, list);
  }

  for (const [kind, diffs] of grouped) {
    lines.push(`--- ${kind.toUpperCase()} (${diffs.length}) ---`);
    for (const diff of diffs) {
      lines.push(`  ${diff.clip_id}: ${diff.detail}`);
      if (diff.kind === "trim_changed" || diff.kind === "reordered") {
        if (diff.kind === "trim_changed") {
          lines.push(
            `    src_in:  ${usToTimecode(diff.original.src_in_us)} → ${usToTimecode(diff.updated.src_in_us)}`,
          );
          lines.push(
            `    src_out: ${usToTimecode(diff.original.src_out_us)} → ${usToTimecode(diff.updated.src_out_us)}`,
          );
          lines.push(
            `    duration: ${diff.original.timeline_duration_frames}f → ${diff.updated.timeline_duration_frames}f`,
          );
        }
        if (diff.kind === "reordered") {
          lines.push(
            `    position: frame ${diff.original.timeline_in_frame} → ${diff.updated.timeline_in_frame}`,
          );
        }
      }
      if (diff.kind === "audio_policy_changed") {
        const keys = new Set([
          ...Object.keys(diff.original_audio_policy),
          ...Object.keys(diff.updated_audio_policy),
        ]);
        const changes = [...keys]
          .filter(
            (key) =>
              diff.original_audio_policy[key as keyof typeof diff.original_audio_policy] !==
              diff.updated_audio_policy[key as keyof typeof diff.updated_audio_policy],
          )
          .map((key) => {
            const original = diff.original_audio_policy[key as keyof typeof diff.original_audio_policy];
            const updated = diff.updated_audio_policy[key as keyof typeof diff.updated_audio_policy];
            return `${key}: ${String(original ?? "unset")} → ${String(updated ?? "unset")}`;
          });
        lines.push(`    ${changes.join(", ")}`);
      }
    }
    lines.push(``);
  }

  if (report.unsupportedEdits.length > 0) {
    lines.push(
      `--- UNSUPPORTED_EDIT (${report.unsupportedEdits.length}) ---`,
    );
    for (const entry of report.unsupportedEdits) {
      lines.push(`  ${entry.clip_id}: ${entry.detail}`);
      lines.push(`    surface: ${entry.surface}`);
      lines.push(`    reason: ${entry.reason}`);
      lines.push(`    disposition: ${entry.disposition}`);
      lines.push(
        `    evidence_location: ${JSON.stringify(entry.evidence_location)}`,
      );
    }
    lines.push(``);
  }

  if (report.textOverlayEdits.length > 0) {
    lines.push(`--- TEXT_OVERLAY_EDIT (${report.textOverlayEdits.length}) ---`);
    for (const entry of report.textOverlayEdits) {
      lines.push(`  ${entry.clip_id ?? entry.xml_generator_id ?? "unmapped"}: ${entry.detail}`);
      lines.push(`    kind: ${entry.kind}`);
      lines.push(`    disposition: ${entry.disposition}`);
    }
    lines.push(``);
  }

  if (report.transitionEdits.length > 0) {
    lines.push(`--- SIMPLE_TRANSITION_EDIT (${report.transitionEdits.length}) ---`);
    for (const entry of report.transitionEdits) {
      lines.push(`  ${entry.transition_id ?? "unmapped"}: ${entry.detail}`);
      lines.push(`    kind: ${entry.kind}`);
      lines.push(`    disposition: ${entry.disposition}`);
      lines.push(`    source_handle_authority: ${entry.source_handle_authority}`);
    }
    lines.push(``);
  }

  return lines.join("\n");
}

/** Format diff report as structured JSON for programmatic consumption */
function formatDiffReportJson(
  report: ImportDiffReport,
  mode: ImportMode,
  applied: boolean,
  receiptValidation?: PremiereRoundtripValidation,
  applyBlocked = false,
  blockReason?: "unsupported_edit" | "text_overlay_edit" | "simple_transition_edit",
  preDiffBlock?: string,
): string {
  const grouped: Record<string, ClipDiff[]> = {};
  for (const diff of report.diffs) {
    (grouped[diff.kind] ??= []).push(diff);
  }

  const summary = {
    mode,
    applied,
    apply_blocked: applyBlocked,
    would_block_apply: Boolean(preDiffBlock) || applyBlocked,
    ...(blockReason || preDiffBlock ? { block_reason: blockReason ?? preDiffBlock } : {}),
    baked_visuals: [],
    baked_media_edits: preDiffBlock?.startsWith("baked_media_edit") ? [{ reason: preDiffBlock }] : [],
    artifact_failures: preDiffBlock?.startsWith("baked_media_unverified") ? [{ reason: preDiffBlock }] : [],
    ...(receiptValidation ? { receipt_validation: receiptValidation } : {}),
    sequence_name: report.sequenceName,
    total_clips_in_xml: report.totalClipsInXml,
    mapped_clips: report.mappedClips,
    unmapped_clips: report.unmappedClips,
    total_diffs: report.diffs.length,
    unsupported_edit_count: report.unsupportedEdits.length,
    text_overlay_edit_count: report.textOverlayEdits.length,
    simple_transition_edit_count: report.transitionEdits.length,
    transition_source_handle_authority: report.transitionSourceHandleAuthority,
    by_kind: Object.fromEntries(
      Object.entries(grouped).map(([kind, diffs]) => [kind, diffs.length]),
    ),
    diffs: report.diffs,
    unsupported_edits: report.unsupportedEdits,
    text_overlay_edits: report.textOverlayEdits,
    transition_edits: report.transitionEdits,
  };

  return JSON.stringify(summary, null, 2);
}

function emptyPreDiffReport(sequenceName: string, parsed: ReturnType<typeof parseFcp7Sequence>): ImportDiffReport {
  const clips = [...parsed.videoTracks.flat(), ...parsed.audioTracks.flat()];
  return { sequenceName, totalClipsInXml: clips.length, mappedClips: clips.filter((clip) => !!clip.videoOsMeta).length, unmappedClips: clips.filter((clip) => !clip.videoOsMeta).length, diffs: [], unsupportedEdits: [], textOverlayEdits: [], transitionEdits: [], transitionSourceHandleAuthority: "missing" };
}

// ── Main ────────────────────────────────────────────────────────────

function main(): void {
  try {
    const { projectPath: requestedProjectPath, xmlPath, receiptPath, mode, jsonOutput } = parseArgs(process.argv);
    const projectPath = fs.realpathSync(requestedProjectPath);

    // Read timeline.json
    const timelinePath = path.join(projectPath, "05_timeline", "timeline.json");
    if (!fs.existsSync(timelinePath)) {
      console.error(`timeline.json not found: ${timelinePath}`);
      process.exit(1);
    }

    const rawTimeline = fs.readFileSync(timelinePath);
    const timeline: TimelineIR = JSON.parse(rawTimeline.toString("utf-8"));
    if (!jsonOutput) console.log(`Reference timeline: ${timeline.sequence.name}`);

    // Read XML
    if (!fs.existsSync(xmlPath)) {
      console.error(`XML file not found: ${xmlPath}`);
      process.exit(1);
    }

    const xmlContent = fs.readFileSync(xmlPath, "utf-8");
    if (!jsonOutput) console.log(`Parsing XML: ${xmlPath}`);

    // Parse FCP7 XML
    const parsed = parseFcp7Sequence(xmlContent);
    if (!jsonOutput) {
      console.log(
        `Parsed: ${parsed.videoTracks.reduce((n, t) => n + t.length, 0)} video clips, ${parsed.audioTracks.reduce((n, t) => n + t.length, 0)} audio clips`,
      );
    }

    let receiptValidation: PremiereRoundtripValidation | undefined;
    let receipt: PremiereRoundtripReceipt | undefined;
    let preDiffBlock: string | undefined;
    if (receiptPath) {
      try {
        if (!fs.existsSync(receiptPath)) {
          throw new Error(`receipt file not found: ${receiptPath}`);
        }
        receipt = parsePremiereRoundtripReceipt(
          fs.readFileSync(receiptPath, "utf-8"),
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const receiptError = message.includes("fields are not exact")
          ? new Error(`unexpected receipt field: ${message}`)
          : error;
        receiptValidation = { provided: true, valid: false, error: receiptError instanceof Error ? receiptError.message : String(receiptError) };
        preDiffBlock = `baked_media_unverified: ${receiptValidation.error}`;
      }
    }

    const treatedBase = classifyPremiereVideoTreatments(timeline).some((item) => item.status !== "native");
    const bakedMarkers = parsed.videoTracks.flat().some((clip) => clip.videoOsMeta?.representation === "baked_visual");
    if (!receipt && !preDiffBlock && (treatedBase || bakedMarkers)) {
      preDiffBlock = "baked_media_unverified: receipt v2 required for treated base or baked marker";
    }
    if (receipt && !preDiffBlock) {
      try {
        validatePremiereRoundtripApply(
          receipt,
          timeline.project_id,
          rawTimeline,
          parsed,
          timeline,
          receipt.version === "premiere-roundtrip-receipt/v1" && (receipt.text_overlay_manifest?.length ?? 0) > 0,
          projectPath,
        );
        receiptValidation = { provided: true, valid: true };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        receiptValidation = { provided: true, valid: false, error: message };
        preDiffBlock = message.startsWith("baked_media_") ? message : `baked_media_unverified: ${message}`;
      }
    }

    if (preDiffBlock) {
      const report = emptyPreDiffReport(parsed.name, parsed);
      if (jsonOutput) console.log(formatDiffReportJson(report, mode, false, receiptValidation, true, undefined, preDiffBlock));
      else { if (receiptPath) console.error(`Receipt validation: invalid (${receiptValidation?.error})`); console.error(`Apply blocked: ${preDiffBlock}`); }
      if (mode === "apply") process.exitCode = 1;
      return;
    }

    // Receipt/base/artifact validation has completed before any edit detection.
    const report = detectDiffs(parsed, timeline, receipt?.text_overlay_manifest);
    if (receiptPath && !jsonOutput) {
      console.log(
        receiptValidation?.valid
          ? `Receipt validation: valid`
          : `Receipt validation: invalid (${receiptValidation?.error})`,
      );
    }

    if (!jsonOutput) {
      console.log(formatDiffReport(report));
    }

    if (mode === "preview") {
      if (jsonOutput) {
        console.log(formatDiffReportJson(report, mode, false, receiptValidation, false, undefined, preDiffBlock));
      } else {
        console.log(`[PREVIEW] No changes applied.`);
      }
      return;
    }

    if (report.unsupportedEdits.length > 0) {
      if (jsonOutput) {
        console.log(
          formatDiffReportJson(
            report,
            mode,
            false,
            receiptValidation,
            true,
            "unsupported_edit",
          ),
        );
      } else {
        console.log(
          `Apply blocked: unsupported Premiere clip edits require manual review.`,
        );
      }
      process.exitCode = 1;
      return;
    }

    if (report.textOverlayEdits.length > 0) {
      if (jsonOutput) {
        console.log(formatDiffReportJson(report, mode, false, receiptValidation, true, "text_overlay_edit"));
      } else {
        console.log(`Apply blocked: canonical text-overlay edits are report-only.`);
      }
      process.exitCode = 1;
      return;
    }

    if (report.transitionEdits.length > 0) {
      if (jsonOutput) {
        console.log(formatDiffReportJson(report, mode, false, receiptValidation, true, "simple_transition_edit"));
      } else {
        console.log(`Apply blocked: simple-transition edits are report-only and source-handle authority is missing.`);
      }
      process.exitCode = 1;
      return;
    }

    // Apply diffs
    if (report.diffs.length === 0) {
      if (jsonOutput) {
        console.log(formatDiffReportJson(report, mode, false, receiptValidation));
      } else {
        console.log(`No changes to apply.`);
      }
      return;
    }

    const applicableDiffs = report.diffs.filter(
      (d) => d.kind !== "added_unmapped",
    );
    if (applicableDiffs.length === 0) {
      if (jsonOutput) {
        console.log(formatDiffReportJson(report, mode, false, receiptValidation));
      } else {
        console.log(`Only unmapped clips detected. No changes to apply.`);
        console.log(
          `Warning: ${report.unmappedClips} new clip(s) in Premiere cannot be auto-imported.`,
        );
      }
      return;
    }

    const patched = applyDiffs(timeline, applicableDiffs);

    // Backup original
    const backupPath = timelinePath + ".bak";
    fs.copyFileSync(timelinePath, backupPath);
    if (!jsonOutput) console.log(`Backup: ${backupPath}`);

    // Write patched timeline
    fs.writeFileSync(timelinePath, JSON.stringify(patched, null, 2), "utf-8");
    if (jsonOutput) {
      console.log(formatDiffReportJson(report, mode, true, receiptValidation));
      return;
    }

    console.log(`Updated: ${timelinePath}`);
    console.log(`Applied ${applicableDiffs.length} change(s).`);

    if (report.unmappedClips > 0) {
      console.log(
        `Warning: ${report.unmappedClips} unmapped clip(s) were skipped (manual review needed).`,
      );
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[import-premiere-xml] ${message}`);
    console.error(USAGE);
    process.exit(1);
  }
}

const isMain = process.argv[1]
  ? import.meta.url === pathToFileURL(process.argv[1]).href
  : false;

if (isMain) {
  main();
}
