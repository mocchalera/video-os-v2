// CLI entry point for the timeline compiler.
// Usage:
//   npx tsx scripts/compile-timeline.ts <project-path>
//   npx tsx scripts/compile-timeline.ts <project-path> --patch <patch-file>
//   npx tsx scripts/compile-timeline.ts <project-path> --source-map 02_media/source_map.json

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parse as parseYaml } from "yaml";
import {
  assertCompileDurationGate,
  assertGeneratedTimelineValid,
  runCanonicalCompile,
  runCanonicalPatch,
  applyPatch,
  detectProjectBgm,
  type CompileResult,
} from "../runtime/compiler/index.js";
import type { ReviewPatch } from "../runtime/compiler/patch.js";
import type { Candidate, CompilerDefaults, DurationPolicy, EditBlueprint } from "../runtime/compiler/types.js";
import { loadSourceMap } from "../runtime/media/source-map.js";
import {
  assertRenderSourceReadiness,
  buildRenderSourceReadiness,
} from "../runtime/compiler/render-readiness.js";
import {
  buildBeatAllocationReport,
  formatBeatAllocationReport,
  suggestRecoveryGate,
} from "../runtime/compiler/diagnostics.js";
import { validateProject } from "./validate-schemas.js";
import { ProgressTracker } from "../runtime/progress.js";
import { generateTimelineOverview } from "../runtime/preview/timeline-overview.js";
import { confirmBriefDefaults } from "../runtime/brief-confirmation.js";
import { inferExistingTimelineRate } from "../runtime/compiler/existing-timeline.js";
import {
  finalizeCompileArtifactsAtomically,
  promoteArtifactFileAtomically,
} from "../runtime/compiler/atomic-finalize.js";
import { reconcileCompiledTimelineState } from "../runtime/state/reconcile.js";
import { validateAgainstSchema } from "../runtime/commands/shared.js";
import {
  buildDerivedMappingReceipt,
  buildReviewEditIdentityReceipt,
  computeArtifactSha256,
  stampReviewDerivation,
} from "../runtime/review/edit-identity.js";

const CANONICAL_REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// ── Arg parsing ─────────────────────────────────────────────────────

export interface CompileTimelineArgs {
  projectPath: string;
  repoSfxRoot?: string;
  patchPath?: string;
  fpsNum?: number;
  fpsDen?: number;
  sourceMapPath?: string;
  skipPreview?: boolean;
  skipConfirmations?: boolean;
  forceConfirmations?: boolean;
}

export function parseArgs(argv: string[] = process.argv): CompileTimelineArgs {
  const args = argv.slice(2);
  let projectPath: string | undefined;
  let repoSfxRoot: string | undefined;
  let patchPath: string | undefined;
  let fpsNum: number | undefined;
  let fpsDen: number | undefined;
  let sourceMapPath: string | undefined;
  let skipPreview = false;
  let skipConfirmations: boolean | undefined;
  let forceConfirmations = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--repo-sfx-root" && i + 1 < args.length) {
      repoSfxRoot = args[++i];
    } else if (args[i] === "--patch" && i + 1 < args.length) {
      patchPath = args[++i];
    } else if (args[i] === "--fps" && i + 1 < args.length) {
      const value = args[++i];
      const match = /^([1-9]\d*)(?:\/([1-9]\d*))?$/.exec(value);
      if (!match) throw new Error("--fps must be a positive integer or rational num/den value");
      const parsedNum = Number(match[1]);
      const parsedDen = Number(match[2] ?? "1");
      if (!Number.isSafeInteger(parsedNum) || !Number.isSafeInteger(parsedDen)) {
        throw new Error("--fps numerator and denominator must be safe integers");
      }
      fpsNum = parsedNum;
      fpsDen = parsedDen;
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
      "Usage: npx tsx scripts/compile-timeline.ts <project-path> [--repo-sfx-root <directory>] [--patch <patch-file>] [--fps <num|num/den>] [--source-map <file>] [--skip-preview] [--skip-confirmations true|false]",
    );
  }

  return {
    projectPath,
    ...(repoSfxRoot ? { repoSfxRoot: path.resolve(repoSfxRoot) } : {}),
    patchPath,
    fpsNum,
    fpsDen,
    sourceMapPath,
    skipPreview,
    skipConfirmations,
    forceConfirmations,
  };
}

// ── Compile mode ────────────────────────────────────────────────────

export async function runCompileTimeline(options: CompileTimelineArgs): Promise<void> {
  const {
    projectPath,
    repoSfxRoot,
    fpsNum: requestedFpsNum,
    fpsDen: requestedFpsDen,
    sourceMapPath,
    skipPreview,
    skipConfirmations,
    forceConfirmations,
  } = options;
  const existingRate = requestedFpsNum === undefined
    ? inferExistingTimelineRate(projectPath)
    : undefined;
  const fpsNum = requestedFpsNum ?? existingRate?.fpsNum;
  const fpsDen = requestedFpsDen ?? existingRate?.fpsDen ?? 1;
  const pt = new ProgressTracker(projectPath, "compile", skipPreview ? 3 : 4);

  try {

  // Pre-compile validation: check Gate 1
  const preCheck = validateProject(projectPath, { repoRoot: CANONICAL_REPO_ROOT });
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
  const missingRequired = preCheck.violations.filter((violation) =>
    violation.rule === "missing_required_artifact"
  );
  if (missingRequired.length > 0) {
    const artifacts = missingRequired.map((violation) => violation.artifact).join(", ");
    const message = `Compile preflight BLOCKED. Missing required artifact(s): ${artifacts}`;
    pt.block("pre_validation", message);
    throw new Error(message);
  }
  const planningBlockers = preCheck.violations.filter((violation) =>
    violation.artifact === "04_plan/uncertainty_register.yaml" &&
    violation.rule === "uncertainty_blocker_warning"
  );
  if (planningBlockers.length > 0) {
    const message = "Planning gate BLOCKED. uncertainty_register has status 'blocker' entries.";
    pt.block("pre_validation", message);
    throw new Error(message);
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
  const result = await runCanonicalCompile({
    projectPath,
    repoRoot: CANONICAL_REPO_ROOT,
    createdAt,
    fpsNum,
    fpsDen,
    sourceMapPath,
    bgm_duration_us: bgm?.durationUs,
    ...(repoSfxRoot ? { repoSfxRoot } : {}),
    validateSourceArtifacts: true,
    onArtifactsPromoted: (_receipts, context) => {
      assertCompileDurationGate({
        hardGate: context.duration_policy.hard_gate,
        resolution: context.resolution,
      });
      assertGeneratedTimelineValid(projectPath, CANONICAL_REPO_ROOT);
      reconcileCompiledTimelineState(projectPath, "compile-timeline", "/compile");
    },
  });

  try {
    assertCompileDurationGate({
      hardGate: result.duration_policy?.hard_gate === true,
      resolution: result.resolution,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    pt.fail("duration_gate", message);
    throw error;
  }
  pt.advance("05_timeline/timeline.json");

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
  if (result.rhythm_sync) {
    const rhythmSync = result.rhythm_sync;
    console.log(
      `  Rhythm sync: ${rhythmSync.enabled ? "enabled" : "disabled"} ` +
        `status=${rhythmSync.status} parity=${rhythmSync.parity.status} ` +
        `hard_snapped=${rhythmSync.counts.hard_snapped} snapped=${rhythmSync.counts.snapped} ` +
        `integrity(gap/overrun)=${rhythmSync.integrity.gap_frames}f/${rhythmSync.integrity.overrun_frames}f` +
        (rhythmSync.degraded_reasons.length > 0
          ? ` degraded=[${rhythmSync.degraded_reasons.join(", ")}]`
          : ""),
    );
    for (const section of rhythmSync.parity.sections) {
      if (section.status !== "pass") {
        console.warn(
          `  Rhythm parity ${section.status}: section=${section.section_id}(${section.label}) ` +
            `offset=${section.offset_frames ?? "?"}f target=${section.target_frame ?? "?"}` +
            (section.reason ? ` (${section.reason})` : ""),
        );
      }
    }
  }
  for (const warning of result.continuity.warnings) {
    console.warn(`  Continuity warning: ${warning.message} ${warning.suggested_fix}`);
  }
  if (result.beat_allocation_report) {
    console.log("  Beat allocation:");
    for (const line of formatBeatAllocationReport(result.beat_allocation_report)) {
      console.log(`    ${line}`);
    }
  }

  // Post-compile validation: check Gate 2
  const postCheck = validateProject(projectPath, { repoRoot: CANONICAL_REPO_ROOT });
  if (!postCheck.gate2_timeline_valid) throw new Error("Generated timeline.json has validation issues");
  if (postCheck.compile_gate === "blocked") throw new Error("Image QC compile gate blocked the patched timeline");

  // Generate timeline overview image (unless skipped)
  if (!skipPreview) {
    const absProject = path.resolve(projectPath);
    const timelinePath = path.join(absProject, "05_timeline/timeline.json");
    const sourceMap = loadSourceMap(absProject, sourceMapPath);
    const overviewTarget = path.join(absProject, "05_timeline/timeline-overview.png");
    const overviewStagingDir = fs.mkdtempSync(path.join(path.dirname(overviewTarget), ".overview-staging-"));
    const overviewStagingPath = path.join(overviewStagingDir, "timeline-overview.png");

    try {
      const overview = await generateTimelineOverview({
        projectDir: absProject,
        timelinePath,
        sourceMap,
        outputPath: overviewStagingPath,
      });
      promoteArtifactFileAtomically(overview.outputPath, overviewTarget, absProject);
      pt.advance("05_timeline/timeline-overview.png");
      console.log(`Timeline overview: ${overviewTarget} (${overview.clipCount} clips)`);
    } catch (err) {
      // Overview generation is best-effort — don't fail the compile
      console.error(`Warning: Timeline overview generation failed: ${String(err)}`);
      pt.advance();
    } finally {
      fs.rmSync(overviewStagingDir, { recursive: true, force: true });
    }
  }

  const artifacts = [
    "05_timeline/timeline.json",
    "05_timeline/preview-manifest.json",
    "05_timeline/render-readiness.json",
    "05_timeline/beat-allocation-report.json",
  ];
  if (!skipPreview) artifacts.push("05_timeline/timeline-overview.png");
  pt.complete(artifacts);
  console.log("Schema validation: PASSED");
  } catch (error) {
    if (pt.snapshot().status === "running") {
      pt.fail("compile", error instanceof Error ? error.message : String(error));
    }
    // Operator diagnostics (Issue #6 P1): point the operator at the earliest
    // gate that can unblock this failure and whether the fix needs
    // re-approval, without requiring a timeline.json deep-dive.
    const recovery = suggestRecoveryGate(error);
    console.error(
      `Recovery: return to ${recovery.gate_label} — ${recovery.action} ` +
        `[${recovery.remedy_class}]`,
    );
    throw error;
  }
}

// ── Patch mode ──────────────────────────────────────────────────────

export async function runPatch(
  projectPath: string,
  patchPath: string,
  sourceMapPath?: string,
  options: { defaultsOverride?: Partial<CompilerDefaults> } = {},
): Promise<void> {
  // Thin CLI wrapper: the canonical patch route (gate + binding verification
  // + sequenced mutation) lives in the compiler module and joins the same
  // project mutation sequencer as the compile route.
  // Preserve #35's parity override contract while keeping all patch
  // promotion and gate decisions inside the canonical route.
  await runCanonicalPatch(projectPath, patchPath, sourceMapPath, options);
}

// ── Main ────────────────────────────────────────────────────────────

export async function main(argv: string[] = process.argv): Promise<number> {
  try {
    const { projectPath, repoSfxRoot, patchPath, fpsNum, fpsDen, sourceMapPath, skipPreview, skipConfirmations, forceConfirmations } = parseArgs(argv);

    if (patchPath) {
      await runPatch(projectPath, patchPath, sourceMapPath);
    } else {
      await runCompileTimeline({
        projectPath,
        repoSfxRoot,
        fpsNum,
        fpsDen,
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
