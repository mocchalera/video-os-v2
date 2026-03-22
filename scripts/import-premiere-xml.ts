#!/usr/bin/env npx tsx
/**
 * CLI: Import Premiere Pro XML (FCP7) back into timeline.json
 *
 * Usage:
 *   npx tsx scripts/import-premiere-xml.ts <project-path> --xml <edited.xml> [--dry-run]
 *
 * Options:
 *   --xml <path>    Path to the FCP7 XML exported from Premiere Pro
 *   --dry-run       Show diff report only, do not modify timeline.json
 *
 * Output:
 *   - Diff report to stdout
 *   - Updated timeline.json (unless --dry-run)
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { TimelineIR } from "../runtime/compiler/types.js";
import {
  parseFcp7Sequence,
  detectDiffs,
  applyDiffs,
  type ImportDiffReport,
  type ClipDiff,
} from "../runtime/handoff/fcp7-xml-import.js";

// ── Arg parsing ─────────────────────────────────────────────────────

function parseArgs(): {
  projectPath: string;
  xmlPath: string;
  dryRun: boolean;
} {
  const args = process.argv.slice(2);
  let projectPath: string | undefined;
  let xmlPath: string | undefined;
  let dryRun = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--xml" && i + 1 < args.length) {
      xmlPath = args[++i];
    } else if (args[i] === "--dry-run") {
      dryRun = true;
    } else if (!projectPath) {
      projectPath = args[i];
    }
  }

  if (!projectPath || !xmlPath) {
    console.error(
      "Usage: npx tsx scripts/import-premiere-xml.ts <project-path> --xml <edited.xml> [--dry-run]",
    );
    process.exit(1);
  }

  return {
    projectPath: path.resolve(projectPath),
    xmlPath: path.resolve(xmlPath),
    dryRun,
  };
}

// ── Diff report formatting ──────────────────────────────────────────

function formatDiffReport(report: ImportDiffReport): string {
  const lines: string[] = [];

  lines.push(`\n=== Premiere XML Import Diff Report ===`);
  lines.push(`Sequence: ${report.sequenceName}`);
  lines.push(`Total clips in XML: ${report.totalClipsInXml}`);
  lines.push(`  Mapped (with video_os marker): ${report.mappedClips}`);
  lines.push(`  Unmapped (new in Premiere): ${report.unmappedClips}`);
  lines.push(`Diffs detected: ${report.diffs.length}`);
  lines.push(``);

  if (report.diffs.length === 0) {
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
      if (diff.original && diff.updated) {
        if (kind === "trim_changed") {
          lines.push(
            `    src_in:  ${diff.original.src_in_us}us → ${diff.updated.src_in_us}us`,
          );
          lines.push(
            `    src_out: ${diff.original.src_out_us}us → ${diff.updated.src_out_us}us`,
          );
          lines.push(
            `    duration: ${diff.original.timeline_duration_frames}f → ${diff.updated.timeline_duration_frames}f`,
          );
        }
        if (kind === "reordered") {
          lines.push(
            `    position: frame ${diff.original.timeline_in_frame} → ${diff.updated.timeline_in_frame}`,
          );
        }
      }
    }
    lines.push(``);
  }

  return lines.join("\n");
}

// ── Main ────────────────────────────────────────────────────────────

function main(): void {
  const { projectPath, xmlPath, dryRun } = parseArgs();

  // Read timeline.json
  const timelinePath = path.join(projectPath, "05_timeline", "timeline.json");
  if (!fs.existsSync(timelinePath)) {
    console.error(`timeline.json not found: ${timelinePath}`);
    process.exit(1);
  }

  const timeline: TimelineIR = JSON.parse(
    fs.readFileSync(timelinePath, "utf-8"),
  );
  console.log(`Reference timeline: ${timeline.sequence.name}`);

  // Read XML
  if (!fs.existsSync(xmlPath)) {
    console.error(`XML file not found: ${xmlPath}`);
    process.exit(1);
  }

  const xmlContent = fs.readFileSync(xmlPath, "utf-8");
  console.log(`Parsing XML: ${xmlPath}`);

  // Parse FCP7 XML
  const parsed = parseFcp7Sequence(xmlContent);
  console.log(
    `Parsed: ${parsed.videoTracks.reduce((n, t) => n + t.length, 0)} video clips, ${parsed.audioTracks.reduce((n, t) => n + t.length, 0)} audio clips`,
  );

  // Detect diffs
  const report = detectDiffs(parsed, timeline);
  console.log(formatDiffReport(report));

  if (dryRun) {
    console.log(`[DRY RUN] No changes applied.`);
    return;
  }

  // Apply diffs
  if (report.diffs.length === 0) {
    console.log(`No changes to apply.`);
    return;
  }

  const applicableDiffs = report.diffs.filter(
    (d) => d.kind !== "added_unmapped",
  );
  if (applicableDiffs.length === 0) {
    console.log(`Only unmapped clips detected. No changes to apply.`);
    console.log(
      `Warning: ${report.unmappedClips} new clip(s) in Premiere cannot be auto-imported.`,
    );
    return;
  }

  const patched = applyDiffs(timeline, applicableDiffs);

  // Backup original
  const backupPath = timelinePath + ".bak";
  fs.copyFileSync(timelinePath, backupPath);
  console.log(`Backup: ${backupPath}`);

  // Write patched timeline
  fs.writeFileSync(timelinePath, JSON.stringify(patched, null, 2), "utf-8");
  console.log(`Updated: ${timelinePath}`);
  console.log(
    `Applied ${applicableDiffs.length} change(s).`,
  );

  if (report.unmappedClips > 0) {
    console.log(
      `Warning: ${report.unmappedClips} unmapped clip(s) were skipped (manual review needed).`,
    );
  }
}

main();
