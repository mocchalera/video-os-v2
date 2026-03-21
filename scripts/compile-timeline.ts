// CLI entry point for the timeline compiler.
// Usage:
//   npx tsx scripts/compile-timeline.ts <project-path>
//   npx tsx scripts/compile-timeline.ts <project-path> --patch <patch-file>

import * as fs from "node:fs";
import * as path from "node:path";
import { parse as parseYaml } from "yaml";
import { compile, applyPatch } from "../runtime/compiler/index.js";
import type { ReviewPatch } from "../runtime/compiler/patch.js";
import type { Candidate } from "../runtime/compiler/types.js";
import { validateProject } from "./validate-schemas.js";

// ── Arg parsing ─────────────────────────────────────────────────────

function parseArgs(): { projectPath: string; patchPath?: string } {
  const args = process.argv.slice(2);
  let projectPath: string | undefined;
  let patchPath: string | undefined;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--patch" && i + 1 < args.length) {
      patchPath = args[++i];
    } else if (!projectPath) {
      projectPath = args[i];
    }
  }

  if (!projectPath) {
    console.error(
      "Usage: npx tsx scripts/compile-timeline.ts <project-path> [--patch <patch-file>]",
    );
    process.exit(1);
  }

  return { projectPath, patchPath };
}

// ── Compile mode ────────────────────────────────────────────────────

function runCompile(projectPath: string): void {
  // Pre-compile validation: check Gate 1
  const preCheck = validateProject(projectPath);
  if (preCheck.compile_gate === "blocked") {
    console.error("Compile gate BLOCKED. Unresolved blockers exist.");
    for (const v of preCheck.violations) {
      if (v.rule === "compile_gate") {
        console.error(`  - ${v.message}`);
      }
    }
    process.exit(1);
  }

  // Derive createdAt deterministically from the creative brief's created_at
  const briefPath = path.join(path.resolve(projectPath), "01_intent/creative_brief.yaml");
  const briefRaw = fs.readFileSync(briefPath, "utf-8");
  const brief = parseYaml(briefRaw) as { created_at?: string };
  const createdAt = brief.created_at ?? "1970-01-01T00:00:00Z";

  // Compile
  const result = compile({
    projectPath,
    createdAt,
  });

  console.log(`Timeline compiled: ${result.outputPath}`);
  console.log(`  Tracks: ${result.timeline.tracks.video.length} video, ${result.timeline.tracks.audio.length} audio`);
  console.log(`  Markers: ${result.timeline.markers.length}`);
  console.log(`  Resolution: ${JSON.stringify(result.resolution)}`);

  // Post-compile validation: check Gate 2
  const postCheck = validateProject(projectPath);
  if (!postCheck.gate2_timeline_valid) {
    console.error("WARNING: Generated timeline.json has validation issues:");
    for (const v of postCheck.violations) {
      if (v.artifact === "05_timeline/timeline.json") {
        console.error(`  - [${v.rule}] ${v.message}`);
      }
    }
    process.exit(1);
  }

  console.log("Schema validation: PASSED");
}

// ── Patch mode ──────────────────────────────────────────────────────

function runPatch(projectPath: string, patchPath: string): void {
  const absProject = path.resolve(projectPath);
  const timelinePath = path.join(absProject, "05_timeline/timeline.json");

  // Read existing timeline
  if (!fs.existsSync(timelinePath)) {
    console.error(`Timeline not found: ${timelinePath}`);
    console.error("Run compile first before applying a patch.");
    process.exit(1);
  }

  const timeline = JSON.parse(fs.readFileSync(timelinePath, "utf-8"));

  // Read patch
  const absPatch = path.resolve(patchPath);
  if (!fs.existsSync(absPatch)) {
    console.error(`Patch file not found: ${absPatch}`);
    process.exit(1);
  }
  const patch: ReviewPatch = JSON.parse(fs.readFileSync(absPatch, "utf-8"));

  // Read candidates for replacement lookup
  const selectsPath = path.join(absProject, "04_plan/selects_candidates.yaml");
  const selectsRaw = fs.readFileSync(selectsPath, "utf-8");
  const selects = parseYaml(selectsRaw) as { candidates: Candidate[] };

  // Apply patch
  const result = applyPatch(timeline, patch, selects.candidates);

  if (result.errors.length > 0) {
    console.error("Patch errors:");
    for (const err of result.errors) {
      console.error(`  [op ${err.op_index}] ${err.op}: ${err.message}`);
    }
    if (result.appliedOps === 0) {
      process.exit(1);
    }
  }

  // Write patched timeline
  fs.writeFileSync(timelinePath, JSON.stringify(result.timeline, null, 2), "utf-8");

  console.log(`Patch applied: ${result.appliedOps}/${patch.operations.length} ops`);
  console.log(`  Version: ${timeline.version} → ${result.timeline.version}`);
  console.log(`  Markers: ${result.timeline.markers.length}`);

  // Post-patch validation: check Gate 2
  const postCheck = validateProject(projectPath);
  if (!postCheck.gate2_timeline_valid) {
    console.error("WARNING: Patched timeline.json has validation issues:");
    for (const v of postCheck.violations) {
      if (v.artifact === "05_timeline/timeline.json") {
        console.error(`  - [${v.rule}] ${v.message}`);
      }
    }
    process.exit(1);
  }

  console.log("Schema validation: PASSED");
}

// ── Main ────────────────────────────────────────────────────────────

function main(): void {
  const { projectPath, patchPath } = parseArgs();

  if (patchPath) {
    runPatch(projectPath, patchPath);
  } else {
    runCompile(projectPath);
  }
}

main();
