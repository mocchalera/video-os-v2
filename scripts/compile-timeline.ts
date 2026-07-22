// CLI entry point for the timeline compiler.
// Usage:
//   npx tsx scripts/compile-timeline.ts <project-path>
//   npx tsx scripts/compile-timeline.ts <project-path> --patch <patch-file>
//   npx tsx scripts/compile-timeline.ts <project-path> --source-map 02_media/source_map.json

import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { parse as parseYaml } from "yaml";
import { compile, applyPatch, detectProjectBgm } from "../runtime/compiler/index.js";
import { writePreviewManifest } from "../runtime/compiler/export.js";
import type { ReviewPatch } from "../runtime/compiler/patch.js";
import type { Candidate, EditBlueprint } from "../runtime/compiler/types.js";
import { loadSourceMap } from "../runtime/media/source-map.js";
import { validateProject } from "./validate-schemas.js";
import { ProgressTracker } from "../runtime/progress.js";
import { generateTimelineOverview } from "../runtime/preview/timeline-overview.js";
import { confirmBriefDefaults } from "../runtime/brief-confirmation.js";
import { inferExistingTimelineFps } from "../runtime/compiler/existing-timeline.js";

// ── Arg parsing ─────────────────────────────────────────────────────

export interface CompileTimelineArgs {
  projectPath: string;
  patchPath?: string;
  fpsNum?: number;
  sourceMapPath?: string;
  skipPreview?: boolean;
  skipConfirmations?: boolean;
  forceConfirmations?: boolean;
}

export function parseArgs(argv: string[] = process.argv): CompileTimelineArgs {
  const args = argv.slice(2);
  let projectPath: string | undefined;
  let patchPath: string | undefined;
  let fpsNum: number | undefined;
  let sourceMapPath: string | undefined;
  let skipPreview = false;
  let skipConfirmations: boolean | undefined;
  let forceConfirmations = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--patch" && i + 1 < args.length) {
      patchPath = args[++i];
    } else if (args[i] === "--fps" && i + 1 < args.length) {
      fpsNum = parseInt(args[++i], 10);
    } else if (args[i] === "--source-map" && i + 1 < args.length) {
      sourceMapPath = args[++i];
    } else if (args[i] === "--skip-preview") {
      skipPreview = true;
    } else if (args[i] === "--skip-confirmations" && i + 1 < args.length) {
      const value = args[++i];
      skipConfirmations = value === "true";
      forceConfirmations = value === "false";
    } else if (args[i] === "--skip-confirmations") {
      skipConfirmations = true;
    } else if (!projectPath) {
      projectPath = args[i];
    }
  }

  if (!projectPath) {
    throw new Error(
      "Usage: npx tsx scripts/compile-timeline.ts <project-path> [--patch <patch-file>] [--fps <num>] [--source-map <file>] [--skip-preview] [--skip-confirmations true|false]",
    );
  }

  return { projectPath, patchPath, fpsNum, sourceMapPath, skipPreview, skipConfirmations, forceConfirmations };
}

// ── Compile mode ────────────────────────────────────────────────────

export async function runCompileTimeline(options: CompileTimelineArgs): Promise<void> {
  const {
    projectPath,
    fpsNum: requestedFpsNum,
    sourceMapPath,
    skipPreview,
    skipConfirmations,
    forceConfirmations,
  } = options;
  const fpsNum = requestedFpsNum ?? inferExistingTimelineFps(projectPath);
  const pt = new ProgressTracker(projectPath, "compile", skipPreview ? 3 : 4);

  // Pre-compile validation: check Gate 1
  const preCheck = validateProject(projectPath);
  if (preCheck.compile_gate === "blocked") {
    pt.block("pre_validation", "Compile gate BLOCKED. Unresolved blockers exist.");
    console.error("Compile gate BLOCKED. Unresolved blockers exist.");
    for (const v of preCheck.violations) {
      if (v.rule === "compile_gate") {
        console.error(`  - ${v.message}`);
      }
    }
    throw new Error("Compile gate BLOCKED. Unresolved blockers exist.");
  }
  pt.advance();

  // Derive createdAt deterministically from the creative brief's created_at
  const briefPath = path.join(path.resolve(projectPath), "01_intent/creative_brief.yaml");
  const briefRaw = fs.readFileSync(briefPath, "utf-8");
  const brief = parseYaml(briefRaw) as { created_at?: string };
  const createdAt = brief.created_at ?? "1970-01-01T00:00:00Z";
  const confirmation = await confirmBriefDefaults(path.resolve(projectPath), {
    skipConfirmations,
    force: forceConfirmations,
  });
  if (confirmation.wrote) {
    console.log(`Brief confirmation: caption_policy=${confirmation.captionPolicy}, audio_policy=${confirmation.audioPolicy}, source=${confirmation.source}`);
  } else if (confirmation.skipped) {
    console.log("Brief confirmation: skipped");
  }

  const bgm = await detectProjectBgm(projectPath);
  if (bgm) {
    const durationSec = bgm.durationUs / 1_000_000;
    console.log(
      `BGM detected: ${bgm.filename} (${durationSec.toFixed(1)}s) — capping timeline at ${Math.floor(durationSec)}s`,
    );
  }

  // Compile
  const result = compile({
    projectPath,
    createdAt,
    fpsNum,
    sourceMapPath,
    bgm_duration_us: bgm?.durationUs,
  });
  pt.advance("timeline.json");

  console.log(`Timeline compiled: ${result.outputPath}`);
  console.log(`  Tracks: ${result.timeline.tracks.video.length} video, ${result.timeline.tracks.audio.length} audio`);
  console.log(`  Markers: ${result.timeline.markers.length}`);
  console.log(`  Resolution: ${JSON.stringify(result.resolution)}`);
  console.log(
    `  Continuity: ${result.continuity.reorders.length} reorder(s), ` +
      `${result.continuity.warnings.length} warning(s), ${result.continuity.errors.length} error(s)`,
  );
  if (result.beat_sync) {
    const beatSync = result.beat_sync;
    console.log(
      `  Beat sync: ${beatSync.enabled ? "enabled" : "disabled"} ` +
        `mode=${beatSync.cut_quantize} source=${beatSync.source ?? beatSync.disabled_reason ?? "none"} ` +
        `quantized=${beatSync.counts.quantized} skipped=${beatSync.counts.skipped}`,
    );
  }
  for (const warning of result.continuity.warnings) {
    console.warn(`  Continuity warning: ${warning.message} ${warning.suggested_fix}`);
  }

  // Post-compile validation: check Gate 2
  const postCheck = validateProject(projectPath);
  if (!postCheck.gate2_timeline_valid) {
    pt.fail("post_validation", "Generated timeline.json has validation issues");
    console.error("WARNING: Generated timeline.json has validation issues:");
    for (const v of postCheck.violations) {
      if (v.artifact === "05_timeline/timeline.json") {
        console.error(`  - [${v.rule}] ${v.message}`);
      }
    }
    throw new Error("Generated timeline.json has validation issues");
  }

  // Generate timeline overview image (unless skipped)
  if (!skipPreview) {
    const absProject = path.resolve(projectPath);
    const timelinePath = path.join(absProject, "05_timeline/timeline.json");
    const sourceMap = loadSourceMap(absProject, sourceMapPath);

    try {
      const overview = await generateTimelineOverview({
        projectDir: absProject,
        timelinePath,
        sourceMap,
      });
      pt.advance("timeline-overview.png");
      console.log(`Timeline overview: ${overview.outputPath} (${overview.clipCount} clips)`);
    } catch (err) {
      // Overview generation is best-effort — don't fail the compile
      console.error(`Warning: Timeline overview generation failed: ${String(err)}`);
      pt.advance();
    }
  }

  const artifacts = ["timeline.json", "timeline.otio", "preview-manifest.json"];
  if (!skipPreview) artifacts.push("timeline-overview.png");
  pt.complete(artifacts);
  console.log("Schema validation: PASSED");
}

// ── Patch mode ──────────────────────────────────────────────────────

function runPatch(projectPath: string, patchPath: string, sourceMapPath?: string): void {
  const absProject = path.resolve(projectPath);
  const timelinePath = path.join(absProject, "05_timeline/timeline.json");

  // Read existing timeline
  if (!fs.existsSync(timelinePath)) {
    console.error(`Timeline not found: ${timelinePath}`);
    console.error("Run compile first before applying a patch.");
    throw new Error(`Timeline not found: ${timelinePath}`);
  }

  const timeline = JSON.parse(fs.readFileSync(timelinePath, "utf-8"));

  // Read patch
  const absPatch = path.resolve(patchPath);
  if (!fs.existsSync(absPatch)) {
    console.error(`Patch file not found: ${absPatch}`);
    throw new Error(`Patch file not found: ${absPatch}`);
  }
  const patch: ReviewPatch = JSON.parse(fs.readFileSync(absPatch, "utf-8"));

  // Read candidates for replacement lookup
  const selectsPath = path.join(absProject, "04_plan/selects_candidates.yaml");
  const selectsRaw = fs.readFileSync(selectsPath, "utf-8");
  const selects = parseYaml(selectsRaw) as { candidates: Candidate[] };

  // Read edit_blueprint to get target duration for Phase 4 re-evaluation
  const blueprintPath = path.join(absProject, "04_plan/edit_blueprint.yaml");
  const blueprint = parseYaml(fs.readFileSync(blueprintPath, "utf-8")) as EditBlueprint;
  const targetDurationFrames = blueprint.beats.reduce(
    (sum, b) => sum + b.target_duration_frames,
    0,
  );

  // Apply patch with blueprint target duration
  const result = applyPatch(timeline, patch, selects.candidates, targetDurationFrames);

  if (result.errors.length > 0) {
    console.error("Patch errors:");
    for (const err of result.errors) {
      console.error(`  [op ${err.op_index}] ${err.op}: ${err.message}`);
    }
    if (result.appliedOps === 0) {
      throw new Error("Patch failed: no operations were applied");
    }
  }

  // Write patched timeline
  fs.writeFileSync(timelinePath, JSON.stringify(result.timeline, null, 2), "utf-8");

  // Regenerate preview-manifest from patched timeline
  const manifestPath = writePreviewManifest(
    result.timeline,
    absProject,
    loadSourceMap(absProject, sourceMapPath),
  );

  console.log(`Patch applied: ${result.appliedOps}/${patch.operations.length} ops`);
  console.log(`  Version: ${timeline.version} → ${result.timeline.version}`);
  console.log(`  Markers: ${result.timeline.markers.length}`);
  console.log(`  Preview manifest: ${manifestPath}`);
  console.log(`  Resolution: ${JSON.stringify(result.resolution)}`);

  // Warn if post-patch duration exceeds blueprint target
  if (!result.resolution.duration_fit) {
    console.error(
      `WARNING: Post-patch duration (${result.resolution.total_frames} frames) exceeds target (${result.resolution.target_frames} frames)`,
    );
  }

  // Post-patch validation: check Gate 2
  const postCheck = validateProject(projectPath);
  if (!postCheck.gate2_timeline_valid) {
    console.error("WARNING: Patched timeline.json has validation issues:");
    for (const v of postCheck.violations) {
      if (v.artifact === "05_timeline/timeline.json") {
        console.error(`  - [${v.rule}] ${v.message}`);
      }
    }
    throw new Error("Patched timeline.json has validation issues");
  }

  console.log("Schema validation: PASSED");
}

// ── Main ────────────────────────────────────────────────────────────

export async function main(argv: string[] = process.argv): Promise<number> {
  try {
    const { projectPath, patchPath, fpsNum, sourceMapPath, skipPreview, skipConfirmations, forceConfirmations } = parseArgs(argv);

    if (patchPath) {
      runPatch(projectPath, patchPath, sourceMapPath);
    } else {
      await runCompileTimeline({
        projectPath,
        fpsNum,
        sourceMapPath,
        skipPreview,
        skipConfirmations,
        forceConfirmations,
      });
    }
    return 0;
  } catch (err) {
    console.error(`Compile failed: ${String(err)}`);
    return 1;
  }
}

const isDirectRun =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  main().then((code) => {
    process.exitCode = code;
  }).catch((err) => {
    console.error(`Compile failed: ${String(err)}`);
    process.exitCode = 1;
  });
}
