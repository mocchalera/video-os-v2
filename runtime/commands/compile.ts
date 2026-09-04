import * as fs from "node:fs";
import * as path from "node:path";
import { parse as parseYaml } from "yaml";
import {
  initCommand,
  isCommandError,
  type CommandError,
} from "./shared.js";
import { runCanonicalCompile, type CompileResult, type ReviewPatch } from "../compiler/index.js";
import { readProjectState, reconcileCompiledTimelineState, type ProjectState } from "../state/reconcile.js";
import { ProgressTracker } from "../progress.js";
import { confirmBriefDefaults, type BriefConfirmationOptions } from "../brief-confirmation.js";
import { inferExistingTimelineRate } from "../compiler/existing-timeline.js";

export interface CompileCommandOptions {
  createdAt?: string;
  fpsNum?: number;
  fpsDen?: number;
  sourceMapPath?: string;
  reviewPatch?: ReviewPatch;
  confirmations?: BriefConfirmationOptions;
}

export interface CompileCommandResult {
  success: boolean;
  error?: CommandError;
  compileResult?: CompileResult;
  previousState?: ProjectState;
  newState?: ProjectState;
  progressPath?: string;
  patchApplied?: boolean;
}

const ALLOWED_STATES: ProjectState[] = [
  "blueprint_ready",
  "blocked",
  "timeline_drafted",
  "critique_ready",
  "approved",
  "packaged",
];

export async function runCompilePhase(
  projectDir: string,
  options?: CompileCommandOptions,
): Promise<CompileCommandResult> {
  const pt = new ProgressTracker(projectDir, "compile", 3);
  const ctx = initCommand(projectDir, "/compile", ALLOWED_STATES);
  if (isCommandError(ctx)) {
    pt.fail("init", ctx.message);
    return { success: false, error: ctx };
  }
  pt.advance();

  const previousState = ctx.doc.current_state;
  const gates = ctx.reconcileResult.gates;

  if (gates.compile_gate === "blocked") {
    const error: CommandError = {
      code: "GATE_CHECK_FAILED",
      message: "Compile gate is blocked — unresolved blockers with status 'blocker' exist.",
      details: { compile_gate: gates.compile_gate },
    };
    pt.block("gates", error.message);
    return { success: false, error, previousState };
  }

  if (gates.planning_gate === "blocked") {
    const error: CommandError = {
      code: "GATE_CHECK_FAILED",
      message: "Planning gate is blocked — uncertainty_register has status 'blocker' entries.",
      details: { planning_gate: gates.planning_gate },
    };
    pt.block("gates", error.message);
    return { success: false, error, previousState };
  }

  try {
    await confirmBriefDefaults(ctx.projectDir, options?.confirmations);
    const existingRate = options?.fpsNum === undefined
      ? inferExistingTimelineRate(ctx.projectDir)
      : undefined;
    const compileResult = await runCanonicalCompile({
      projectPath: ctx.projectDir,
      createdAt: options?.createdAt ?? inferCreatedAt(ctx.projectDir),
      fpsNum: options?.fpsNum ?? existingRate?.fpsNum,
      fpsDen: options?.fpsNum !== undefined ? options.fpsDen : existingRate?.fpsDen,
      sourceMapPath: options?.sourceMapPath,
      reviewPatch: options?.reviewPatch,
      validateSourceArtifacts: true,
      onArtifactsPromoted: (_receipts, context) => {
        if (context.duration_policy.hard_gate && !context.resolution.duration_fit) {
          throw new Error(
            `Hard duration gate failed during atomic compile: target_frames=${context.resolution.target_frames}`,
          );
        }
        reconcileCompiledTimelineState(ctx.projectDir, "compile-timeline", "/compile");
      },
    });
    pt.advance("05_timeline/timeline.json");

    pt.advance("05_timeline/preview-manifest.json");
    pt.complete(collectCompileArtifacts(ctx.projectDir));

    return {
      success: true,
      compileResult,
      previousState,
      newState: readProjectState(ctx.projectDir)?.current_state,
      progressPath: pt.filePath,
      patchApplied: !!options?.reviewPatch,
    };
  } catch (err) {
    const error: CommandError = {
      code: "VALIDATION_FAILED",
      message: `Compile phase failed: ${err instanceof Error ? err.message : String(err)}`,
    };
    pt.fail("compile", error.message);
    return { success: false, error, previousState };
  }
}

function inferCreatedAt(projectDir: string): string {
  const briefPath = path.join(projectDir, "01_intent/creative_brief.yaml");
  if (!fs.existsSync(briefPath)) {
    return new Date().toISOString();
  }

  try {
    const brief = parseYaml(fs.readFileSync(briefPath, "utf-8")) as { created_at?: string };
    return brief.created_at ?? new Date().toISOString();
  } catch {
    return new Date().toISOString();
  }
}

function collectCompileArtifacts(projectDir: string): string[] {
  return [
    "05_timeline/timeline.json",
    "05_timeline/timeline.otio",
    "05_timeline/preview-manifest.json",
    "05_timeline/render-readiness.json",
    "05_timeline/beat-allocation-report.json",
  ].filter((relativePath) => fs.existsSync(path.join(projectDir, relativePath)));
}
