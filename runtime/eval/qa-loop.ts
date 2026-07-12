import { execFile } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { promisify } from "node:util";
import { stringify as stringifyYaml } from "yaml";
import type {
  CreativeBrief,
  EditBlueprint,
  SelectsCandidates,
  TimelineIR,
} from "../artifacts/types.js";
import { compile, type CompileResult } from "../compiler/index.js";
import type { MarlinQAReport } from "./marlin-qa-types.js";
import { isMarlinQAReportVerified } from "./marlin-qa-types.js";
import type { BriefAlignmentReport } from "./brief-alignment-types.js";
import {
  defaultMarlinQAVideoPath,
  runMarlinQA as runDefaultMarlinQA,
} from "./marlin-qa.js";
import { evaluateBriefAlignment } from "./brief-alignment.js";
import { detectIssues, type QAIssue } from "./qa-issue-detector.js";
import { proposeFixes, type QAFix } from "./qa-fix-proposer.js";
import { applyFixes, type ApplyResult } from "./qa-fix-applier.js";
import {
  buildQAReport,
  writeQAImprovementReport,
  type QAImprovementReport,
} from "./qa-improvement-report.js";

const execFileAsync = promisify(execFile);

export interface QALoopResult {
  iterations: number;
  initial_score: number;
  final_score: number;
  improvement: number;
  fixes_applied_total: number;
  reports: QAImprovementReport[];
  converged: boolean;
  convergence_reason: "max_iterations" | "no_fixable_issues" | "quality_floor" | "no_improvement";
  warnings: string[];
}

export type QAImprovementIndexConvergenceReason =
  | "no_issues"
  | "max_iterations"
  | "score_plateau"
  | "no_fixable_issues";

export interface QAImprovementIndex {
  version: "1";
  project_id: string;
  run_id: string;
  base_timeline_hash: string;
  result_timeline_hash: string;
  convergence_reason: QAImprovementIndexConvergenceReason;
  iterations: { path: string; iteration: number }[];
}

export interface QALoopOptions {
  maxIterations?: number;
  qualityFloor?: number;
  maxFixesPerIteration?: number;
  skipRender?: boolean;
  now?: () => Date;
  runMarlinQA?: (projectDir: string, videoPath: string, brief: CreativeBrief) => Promise<MarlinQAReport>;
  runBriefAlignment?: (projectDir: string, brief: CreativeBrief, timeline: TimelineIR, iteration: number) => Promise<BriefAlignmentReport>;
  proposeFixes?: (
    issues: QAIssue[],
    timeline: TimelineIR,
    selects: SelectsCandidates,
    projectDir: string,
    iteration: number,
  ) => Promise<QAFix[]>;
  compile?: (projectDir: string, selects: SelectsCandidates, blueprint: EditBlueprint, iteration: number) => Promise<TimelineIR> | TimelineIR;
  render?: (projectDir: string, timeline: TimelineIR, iteration: number) => Promise<string> | string;
}

interface Evaluation {
  marlin: MarlinQAReport;
  marlinAvailable: boolean;
  alignment: BriefAlignmentReport;
  score: number;
}

export async function runQALoop(
  projectDir: string,
  brief: CreativeBrief,
  selects: SelectsCandidates,
  blueprint: EditBlueprint,
  timeline: TimelineIR,
  opts: QALoopOptions = {},
): Promise<QALoopResult> {
  const absProjectDir = path.resolve(projectDir);
  const maxIterations = Math.max(1, Math.floor(opts.maxIterations ?? 3));
  const maxFixesPerIteration = Math.max(1, Math.floor(opts.maxFixesPerIteration ?? 5));
  const skipRender = opts.skipRender === true;
  const runStartedAt = (opts.now ?? (() => new Date()))().toISOString();
  const baseTimelineHash = hashTimeline(timeline);
  const reports: QAImprovementReport[] = [];
  const reportRefs: QAImprovementIndex["iterations"] = [];
  const warnings: string[] = [];

  let workingTimeline = timeline;
  let initialScore: number | null = null;
  let finalScore = 0;
  let qualityFloor = opts.qualityFloor;
  let previousScore: number | null = null;
  let fixesAppliedTotal = 0;
  let iterations = 0;
  let convergenceReason: QALoopResult["convergence_reason"] = "max_iterations";

  for (let iteration = 1; iteration <= maxIterations; iteration += 1) {
    iterations = iteration;
    const evaluation = await evaluateIteration(absProjectDir, brief, workingTimeline, iteration, skipRender, opts, warnings);
    finalScore = evaluation.score;
    if (initialScore === null) {
      initialScore = evaluation.score;
      qualityFloor ??= round3(initialScore - 0.05);
    }

    const issues = detectIssues(evaluation.marlin, evaluation.alignment, workingTimeline);

    if (evaluation.score < (qualityFloor ?? 0)) {
      const report = writeIterationReport(absProjectDir, iteration, issues, [], evaluation, opts);
      reports.push(report);
      reportRefs.push(iterationReportRef(iteration));
      convergenceReason = "quality_floor";
      break;
    }

    if (previousScore !== null && evaluation.score <= previousScore + 0.0001) {
      const report = writeIterationReport(absProjectDir, iteration, issues, [], evaluation, opts);
      reports.push(report);
      reportRefs.push(iterationReportRef(iteration));
      convergenceReason = "no_improvement";
      break;
    }

    const fixableIssues = issues.filter((issue) => issue.fixable);
    if (fixableIssues.length === 0) {
      const report = writeIterationReport(absProjectDir, iteration, issues, [], evaluation, opts);
      reports.push(report);
      reportRefs.push(iterationReportRef(iteration));
      convergenceReason = "no_fixable_issues";
      break;
    }

    const proposedFixes = await (opts.proposeFixes ?? defaultProposeFixes)(
      fixableIssues,
      workingTimeline,
      selects,
      absProjectDir,
      iteration,
    );
    const fixes = proposedFixes.slice(0, maxFixesPerIteration);
    const report = writeIterationReport(absProjectDir, iteration, issues, fixes, evaluation, opts);
    reports.push(report);
    reportRefs.push(iterationReportRef(iteration));

    if (fixes.length === 0) {
      convergenceReason = "no_improvement";
      break;
    }

    const applyResult = await applyIterationFixes({
      projectDir: absProjectDir,
      iteration,
      fixes,
      selects,
      blueprint,
      timeline: workingTimeline,
      skipRender,
      opts,
      warnings,
    });

    warnings.push(...applyResult.result.warnings);
    if (!applyResult.result.selects_modified && !applyResult.result.blueprint_modified) {
      convergenceReason = "no_improvement";
      break;
    }

    fixesAppliedTotal += applyResult.result.applied.length;
    workingTimeline = applyResult.timeline;
    previousScore = evaluation.score;

    if (iteration === maxIterations) {
      const finalEvaluation = await evaluateIteration(absProjectDir, brief, workingTimeline, iteration + 1, skipRender, opts, warnings);
      finalScore = finalEvaluation.score;
      if (finalScore < (qualityFloor ?? 0)) {
        convergenceReason = "quality_floor";
      } else if (previousScore !== null && finalScore <= previousScore + 0.0001) {
        convergenceReason = "no_improvement";
      } else {
        convergenceReason = "max_iterations";
      }
    }
  }

  const initial = initialScore ?? finalScore;
  writeQAImprovementIndex(absProjectDir, {
    version: "1",
    project_id: brief.project?.id ?? brief.project_id ?? path.basename(absProjectDir),
    run_id: runStartedAt,
    base_timeline_hash: baseTimelineHash,
    result_timeline_hash: hashTimeline(workingTimeline),
    convergence_reason: indexConvergenceReason(convergenceReason, reports.at(-1)),
    iterations: reportRefs,
  });

  return {
    iterations,
    initial_score: round3(initial),
    final_score: round3(finalScore),
    improvement: round3(finalScore - initial),
    fixes_applied_total: fixesAppliedTotal,
    reports,
    converged: convergenceReason !== "max_iterations",
    convergence_reason: convergenceReason,
    warnings,
  };
}

async function applyIterationFixes(input: {
  projectDir: string;
  iteration: number;
  fixes: QAFix[];
  selects: SelectsCandidates;
  blueprint: EditBlueprint;
  timeline: TimelineIR;
  skipRender: boolean;
  opts: QALoopOptions;
  warnings: string[];
}): Promise<{ result: ApplyResult; timeline: TimelineIR }> {
  const {
    projectDir,
    iteration,
    fixes,
    selects,
    blueprint,
    timeline,
    skipRender,
    opts,
    warnings,
  } = input;
  const selectsPath = path.join(projectDir, "04_plan", "selects_candidates.yaml");
  const blueprintPath = path.join(projectDir, "04_plan", "edit_blueprint.yaml");
  const timelinePath = path.join(projectDir, "05_timeline", "timeline.json");
  const renderPath = defaultRenderPath(projectDir);
  const backups = backupIterationArtifacts(projectDir, iteration, { includeRender: !skipRender });
  const selectsBefore = structuredClone(selects);
  const blueprintBefore = structuredClone(blueprint);

  try {
    const result = applyFixes(fixes, selects, blueprint, timeline, { projectDir });
    if (!result.selects_modified && !result.blueprint_modified) {
      return { result, timeline };
    }

    if (result.selects_modified) writeYaml(selectsPath, selects);
    if (result.blueprint_modified) writeYaml(blueprintPath, blueprint);

    const nextTimeline = await (opts.compile ?? defaultCompile)(projectDir, selects, blueprint, iteration);
    writeJson(timelinePath, nextTimeline);

    if (!skipRender) {
      await (opts.render ?? defaultRender)(projectDir, nextTimeline, iteration);
    }

    return { result, timeline: nextTimeline };
  } catch (error) {
    restoreBackups([
      [backups.selects, selectsPath],
      [backups.blueprint, blueprintPath],
      [backups.timeline, timelinePath],
      [backups.render, renderPath],
    ]);
    replaceObject(selects, selectsBefore);
    replaceObject(blueprint, blueprintBefore);
    warnings.push(`Iteration ${iteration} failed and artifacts were restored: ${error instanceof Error ? error.message : String(error)}`);
    return {
      result: {
        applied: [],
        skipped: fixes,
        selects_modified: false,
        blueprint_modified: false,
        warnings: [`Iteration ${iteration} failed: ${error instanceof Error ? error.message : String(error)}`],
        modified_beat_ids: [],
      },
      timeline,
    };
  }
}

function replaceObject<T extends object>(target: T, source: T): void {
  for (const key of Object.keys(target) as Array<keyof T>) {
    delete target[key];
  }
  Object.assign(target, source);
}

async function evaluateIteration(
  projectDir: string,
  brief: CreativeBrief,
  timeline: TimelineIR,
  iteration: number,
  skipRender: boolean,
  opts: QALoopOptions,
  warnings: string[],
): Promise<Evaluation> {
  const videoPath = defaultRenderPath(projectDir);
  let marlin: MarlinQAReport;
  if (skipRender) {
    marlin = blockedMarlinReport(projectDir, videoPath, "render_skipped");
  } else if (opts.runMarlinQA !== undefined || fs.existsSync(videoPath)) {
    try {
      marlin = await (opts.runMarlinQA ?? defaultRunMarlinQA)(projectDir, videoPath, brief);
      if (!isMarlinQAReportVerified(marlin)) {
        warnings.push(`Marlin QA did not produce verified visual QA: ${marlin.visual_qa ?? "unverified"}`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      marlin = blockedMarlinReport(projectDir, videoPath, "marlin_unavailable", message);
      warnings.push(`Marlin QA blocked because Marlin was unavailable: ${message}`);
    }
  } else {
    marlin = blockedMarlinReport(projectDir, videoPath, "render_missing");
    warnings.push(`Marlin QA skipped because rendered video was not found: ${videoPath}`);
  }
  const marlinAvailable = isMarlinQAReportVerified(marlin);
  const alignment = await (opts.runBriefAlignment ?? defaultRunBriefAlignment)(projectDir, brief, timeline, iteration);
  return {
    marlin,
    marlinAvailable,
    alignment,
    score: computeOverallScore(marlin, alignment),
  };
}

function writeIterationReport(
  projectDir: string,
  iteration: number,
  issues: QAIssue[],
  fixes: QAFix[],
  evaluation: Evaluation,
  opts: QALoopOptions,
): QAImprovementReport {
  const report = buildQAReport(
    iteration,
    issues,
    fixes,
    evaluation.marlin,
    evaluation.alignment,
    opts.now ? { now: opts.now } : {},
  );
  writeQAImprovementReport(projectDir, report, iterationReportRef(iteration).path);
  return report;
}

function iterationReportRef(iteration: number): QAImprovementIndex["iterations"][number] {
  return {
    path: `06_review/qa-improvement-report-iter${iteration}.json`,
    iteration,
  };
}

function writeQAImprovementIndex(projectDir: string, index: QAImprovementIndex): string {
  const filePath = path.join(projectDir, "06_review", "qa-improvement-index.json");
  writeJson(filePath, index);
  return filePath;
}

function indexConvergenceReason(
  reason: QALoopResult["convergence_reason"],
  lastReport: QAImprovementReport | undefined,
): QAImprovementIndexConvergenceReason {
  if (reason === "max_iterations") return "max_iterations";
  if (reason === "no_fixable_issues") {
    return lastReport?.total_issues === 0 ? "no_issues" : "no_fixable_issues";
  }
  return "score_plateau";
}

async function defaultRunMarlinQA(
  projectDir: string,
  videoPath: string,
  brief: CreativeBrief,
): Promise<MarlinQAReport> {
  return runDefaultMarlinQA(projectDir, videoPath, brief);
}

async function defaultRunBriefAlignment(
  projectDir: string,
  _brief: CreativeBrief,
  _timeline: TimelineIR,
  iteration: number,
): Promise<BriefAlignmentReport> {
  return evaluateBriefAlignment(projectDir, {
    useLlm: false,
    evaluatedAt: `qa-loop-iter-${iteration}`,
  });
}

async function defaultProposeFixes(
  issues: QAIssue[],
  timeline: TimelineIR,
  selects: SelectsCandidates,
  projectDir: string,
): Promise<QAFix[]> {
  return proposeFixes(issues, timeline, selects, projectDir);
}

function defaultCompile(
  projectDir: string,
  _selects: SelectsCandidates,
  _blueprint: EditBlueprint,
  _iteration: number,
): TimelineIR {
  const result: CompileResult = compile({
    projectPath: projectDir,
    createdAt: new Date().toISOString(),
  });
  return result.timeline;
}

async function defaultRender(projectDir: string): Promise<string> {
  await execFileAsync("npx", [
    "tsx",
    "scripts/render-rough-cut.ts",
    "--project",
    projectDir,
  ], {
    cwd: findRepoRoot(process.cwd()),
    maxBuffer: 1024 * 1024 * 32,
  });
  return defaultRenderPath(projectDir);
}

export function computeOverallScore(
  marlinQaResult: MarlinQAReport | undefined,
  briefAlignmentResult: BriefAlignmentReport,
): number {
  const alignmentScore = clamp01(briefAlignmentResult.composite);
  if (!marlinQaResult || !isMarlinQAReportVerified(marlinQaResult)) {
    return round3(0.45 * alignmentScore);
  }
  const rawMarlin = Number.isFinite(marlinQaResult.score) ? marlinQaResult.score : 0;
  const marlinScore = clamp01(rawMarlin > 1 ? rawMarlin / 100 : rawMarlin);
  return round3(0.55 * marlinScore + 0.45 * alignmentScore);
}

function backupIterationArtifacts(
  projectDir: string,
  iteration: number,
  opts: { includeRender: boolean },
): { selects?: string; blueprint?: string; timeline?: string; render?: string } {
  return {
    selects: copyIfExists(
      path.join(projectDir, "04_plan", "selects_candidates.yaml"),
      path.join(projectDir, "04_plan", `selects_candidates-iter${iteration}.yaml`),
    ),
    blueprint: copyIfExists(
      path.join(projectDir, "04_plan", "edit_blueprint.yaml"),
      path.join(projectDir, "04_plan", `edit_blueprint-iter${iteration}.yaml`),
    ),
    timeline: copyIfExists(
      path.join(projectDir, "05_timeline", "timeline.json"),
      path.join(projectDir, "05_timeline", `timeline-iter${iteration}.json`),
    ),
    render: opts.includeRender
      ? copyIfExists(
          defaultRenderPath(projectDir),
          path.join(projectDir, "09_output", `rough-cut-iter${iteration}.mp4`),
        )
      : undefined,
  };
}

function restoreBackups(pairs: Array<[string | undefined, string]>): void {
  for (const [backup, destination] of pairs) {
    if (!backup || !fs.existsSync(backup)) continue;
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(backup, destination);
  }
}

function copyIfExists(source: string, destination: string): string | undefined {
  if (!fs.existsSync(source)) return undefined;
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(source, destination);
  return destination;
}

function writeYaml(filePath: string, data: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, stringifyYaml(data), "utf-8");
  fs.renameSync(tmp, filePath);
}

function writeJson(filePath: string, data: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, "utf-8");
  fs.renameSync(tmp, filePath);
}

function hashTimeline(timeline: TimelineIR): string {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(timeline))
    .digest("hex");
}

function defaultRenderPath(projectDir: string): string {
  return path.join(projectDir, "09_output", "rough-cut.mp4");
}

function blockedMarlinReport(
  projectDir: string,
  videoPath: string,
  reason: "render_missing" | "render_skipped" | "marlin_unavailable",
  detail?: string,
): MarlinQAReport {
  const reasonText = visualQABlockedReasonText(reason);
  const detailText = detail ? `: ${detail}` : "";
  return {
    version: "1",
    project_id: path.basename(projectDir),
    video_path: videoPath,
    video_duration_sec: 0,
    overall_assessment: `Visual QA blocked because ${reasonText}${detailText}.`,
    scene_descriptions: [],
    issues: [],
    pacing_assessment: {
      too_fast: false,
      too_slow: false,
      notes: `Visual pacing was not measured because ${reasonText}.`,
    },
    emotion_arc_assessment: {
      follows_brief: false,
      notes: `Visual emotion arc was not measured because ${reasonText}.`,
    },
    score: 0,
    visual_qa: "blocked",
    visual_qa_reason: reason,
  };
}

function visualQABlockedReasonText(reason: "render_missing" | "render_skipped" | "marlin_unavailable"): string {
  if (reason === "render_missing") return "rendered video was not found";
  if (reason === "render_skipped") return "render was skipped";
  return "Marlin was unavailable";
}

function findRepoRoot(from: string): string {
  let dir = path.resolve(from);
  while (dir !== path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, "package.json")) && fs.existsSync(path.join(dir, "runtime"))) return dir;
    dir = path.dirname(dir);
  }
  return process.cwd();
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}
