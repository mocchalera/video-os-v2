#!/usr/bin/env tsx
/**
 * Demo script — runs the deterministic compiler + schema validation
 * on the pre-built projects/demo/ artifacts.
 *
 * No API keys required. No VLM/STT calls.
 * Demonstrates: compile → validate → show results
 */

import * as path from "node:path";
import * as fs from "node:fs";
import { pathToFileURL } from "node:url";
import { compile } from "../runtime/compiler/index.js";

const repoRoot = path.resolve(import.meta.dirname, "..");
const projectPath = path.join(repoRoot, "projects/demo");

const USAGE = `Usage: npx tsx scripts/demo.ts

Runs the deterministic demo compile against projects/demo.
Options:
  --help, -h     Show this help`;

export interface DemoCliArgs {
  help: boolean;
}

export function parseArgs(argv: string[]): DemoCliArgs {
  const args = argv.slice(2);

  for (const arg of args) {
    if (arg === "--help" || arg === "-h") {
      return { help: true };
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return { help: false };
}

export async function runDemo(): Promise<void> {
  console.log("─────────────────────────────────────────────────");
  console.log("  RoughCut Agent — Demo (deterministic compile)");
  console.log("─────────────────────────────────────────────────\n");

  // ── Check demo artifacts exist ────────────────────────────────────
  const requiredFiles = [
    "01_intent/creative_brief.yaml",
    "04_plan/edit_blueprint.yaml",
    "04_plan/selects_candidates.yaml",
  ];

  for (const f of requiredFiles) {
    const fp = path.join(projectPath, f);
    if (!fs.existsSync(fp)) {
      throw new Error(`Missing required artifact: ${f}`);
    }
  }

  console.log("[1/3] Reading artifacts from projects/demo/...");
  console.log("  - creative_brief.yaml   (intent)");
  console.log("  - selects_candidates.yaml (candidates)");
  console.log("  - edit_blueprint.yaml   (structure)\n");

  // ── Compile ───────────────────────────────────────────────────────
  console.log("[2/3] Running deterministic compiler (Phase 0.5 → 5)...");

  const result = compile({
    projectPath,
    repoRoot,
    createdAt: new Date().toISOString(),
  });

  console.log("  Phase 0.5  Duration policy resolved");
  console.log("  Phase 1    Blueprint normalized");
  console.log("  Phase 2    Candidates scored");
  console.log("  Phase 3    Multi-track assembly");
  console.log("  Phase 4    Constraints resolved");
  console.log("  Phase 5    Timeline exported\n");

  // ── Results ───────────────────────────────────────────────────────
  console.log("[3/3] Compilation results:\n");

  const durationMode = result.duration_policy?.mode ?? "unknown";
  const totalSec = (result.resolution.total_frames / 24).toFixed(1);
  const targetSec = (result.resolution.target_frames / 24).toFixed(1);

  console.log(`  Duration mode:    ${durationMode}`);
  console.log(`  Target:           ${targetSec}s`);
  console.log(`  Compiled:         ${totalSec}s`);
  console.log(`  Duration fit:     ${result.resolution.duration_fit ? "YES" : "NO"}`);
  console.log(`  Overlaps fixed:   ${result.resolution.resolved_overlaps}`);
  console.log(`  Duplicates fixed: ${result.resolution.resolved_duplicates}`);
  console.log(`  Invalid ranges:   ${result.resolution.resolved_invalid_ranges}`);
  console.log(`  Output:           ${path.relative(repoRoot, result.outputPath)}`);

  // ── Show timeline summary ─────────────────────────────────────────
  const timeline = result.timeline;
  const videoTracks = timeline.tracks.video ?? [];
  const audioTracks = timeline.tracks.audio ?? [];
  const totalClips = [
    ...videoTracks.flatMap((track) => track.clips),
    ...audioTracks.flatMap((track) => track.clips),
  ].length;

  console.log(`\n  Timeline: "${timeline.sequence.name}"`);
  console.log(`  Tracks:   ${videoTracks.length} video + ${audioTracks.length} audio`);
  console.log(`  Clips:    ${totalClips} total`);

  // ── Show review report if present ─────────────────────────────────
  const reviewPath = path.join(projectPath, "06_review/review_report.yaml");
  if (fs.existsSync(reviewPath)) {
    console.log("\n  Pre-generated review (from roughcut-critic):");
    const { parse } = await import("yaml");
    const review = parse(fs.readFileSync(reviewPath, "utf-8"));
    console.log(`  Judgment:    ${review.summary_judgment.status}`);
    console.log(`  Confidence:  ${review.summary_judgment.confidence}`);
    console.log(`  Strengths:   ${review.strengths?.length ?? 0}`);
    console.log(`  Weaknesses:  ${review.weaknesses?.length ?? 0}`);
    console.log(`  Fatal:       ${review.fatal_issues?.length ?? 0}`);
  }

  console.log("\n─────────────────────────────────────────────────");
  console.log("  Demo complete. Explore projects/demo/ to see all artifacts.");
  console.log("─────────────────────────────────────────────────\n");
}

async function main(): Promise<void> {
  try {
    const args = parseArgs(process.argv);
    if (args.help) {
      console.log(USAGE);
      return;
    }

    await runDemo();
  } catch (err) {
    console.error("\nCompilation failed:", err instanceof Error ? err.message : String(err));
    console.error("\nThis may indicate missing dependencies. Run: npm install");
    process.exit(1);
  }
}

const isMain = process.argv[1]
  ? import.meta.url === pathToFileURL(process.argv[1]).href
  : false;

if (isMain) {
  void main();
}
