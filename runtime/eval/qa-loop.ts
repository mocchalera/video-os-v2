import { execFile } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
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
import { runMarlinQA as runDefaultMarlinQA } from "./marlin-qa.js";
import { evaluateBriefAlignment } from "./brief-alignment.js";
import { detectIssues, isAudioOnlyTimeline, type QAIssue } from "./qa-issue-detector.js";
import {
  computeReviewMetrics,
  loadReviewMetricsInputs,
  type ReviewMetricsArtifact,
  type ReviewMetricsInputs,
} from "../review/metrics.js";
import { proposeFixes, type QAFix } from "./qa-fix-proposer.js";
import { applyFixes, type ApplyResult } from "./qa-fix-applier.js";
import { defaultDiscoveryContract, type QADiscoveryContract } from "./qa-source-discovery.js";
import {
  buildQAReport,
  writeQAImprovementReport,
  type QAFixDisposition,
  type QAImprovementReport,
  type QAReportedFix,
} from "./qa-improvement-report.js";

const execFileAsync = promisify(execFile);
const SCORE_COMPARISON_EPSILON = 0.0001;
const TRANSACTION_TEMP_PREFIX = "video-os-qa-transaction-";

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
  visual_qa: {
    status: "verified" | "blocked" | "not_applicable";
    reason?: string;
  };
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
  minSourceQualityScore?: number;
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
    discovery?: QADiscoveryContract,
  ) => Promise<QAFix[]>;
  compile?: (projectDir: string, selects: SelectsCandidates, blueprint: EditBlueprint, iteration: number) => Promise<TimelineIR> | TimelineIR;
  render?: (projectDir: string, timeline: TimelineIR, iteration: number) => Promise<string> | string;
  evaluateReviewMetrics?: (
    inputs: ReviewMetricsInputs,
    iteration: number,
  ) => Promise<ReviewMetricsArtifact> | ReviewMetricsArtifact;
}

interface Evaluation {
  marlin: MarlinQAReport;
  alignment: BriefAlignmentReport;
  available: boolean;
  unavailableReason?: string;
  score: number;
  reviewMetrics: ReviewMetricsArtifact;
  visualQaApplicable: boolean;
}

interface ArtifactSnapshot {
  path: string;
  existed: boolean;
  backupPath?: string;
}

interface TransactionSnapshot {
  tempDir: string;
  artifacts: ArtifactSnapshot[];
  selects: SelectsCandidates;
  blueprint: EditBlueprint;
  timeline: TimelineIR;
}

export class QATransactionRestoreError extends Error {
  readonly iteration: number;
  readonly transactionError: unknown;
  readonly restoreFailures: string[];

  constructor(iteration: number, transactionError: unknown, restoreFailures: string[]) {
    super(
      `QA iteration ${iteration} rollback failed after ${errorMessage(transactionError)}: ${restoreFailures.join("; ")}`,
    );
    this.name = "QATransactionRestoreError";
    this.iteration = iteration;
    this.transactionError = transactionError;
    this.restoreFailures = restoreFailures;
  }
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
  const discoveredSegmentIds = new Set<string>();

  let workingTimeline = timeline;
  let fixesAppliedTotal = 0;
  let iterations = 0;
  let convergenceReason: QALoopResult["convergence_reason"] = "max_iterations";
  let reportSequence = 0;
  let evaluationSequence = 1;

  let currentEvaluation = await evaluateIteration(
    absProjectDir,
    brief,
    workingTimeline,
    evaluationSequence,
    skipRender,
    opts,
    warnings,
  );
  evaluationSequence += 1;
  const initialScore = currentEvaluation.score;
  const qualityFloor = opts.qualityFloor ?? round3(initialScore - 0.05);

  for (let iteration = 1; iteration <= maxIterations; iteration += 1) {
    iterations = iteration;
    const issues = detectIssues(
      currentEvaluation.marlin,
      currentEvaluation.alignment,
      workingTimeline,
      currentEvaluation.reviewMetrics,
    );

    if (!currentEvaluation.available) {
      reportSequence = recordIterationReport({
        projectDir: absProjectDir,
        reportSequence,
        issues,
        fixes: [],
        evaluation: currentEvaluation,
        timeline: workingTimeline,
        opts,
        reports,
        reportRefs,
      });
      convergenceReason = "no_fixable_issues";
      break;
    }

    if (!meetsQualityFloor(currentEvaluation.score, qualityFloor)) {
      reportSequence = recordIterationReport({
        projectDir: absProjectDir,
        reportSequence,
        issues,
        fixes: [],
        evaluation: currentEvaluation,
        timeline: workingTimeline,
        opts,
        reports,
        reportRefs,
      });
      convergenceReason = "quality_floor";
      break;
    }

    const fixableIssues = issues.filter((issue) => issue.fixable);
    if (fixableIssues.length === 0) {
      reportSequence = recordIterationReport({
        projectDir: absProjectDir,
        reportSequence,
        issues,
        fixes: [],
        evaluation: currentEvaluation,
        timeline: workingTimeline,
        opts,
        reports,
        reportRefs,
      });
      convergenceReason = "no_fixable_issues";
      break;
    }

    const discovery = {
      ...defaultDiscoveryContract(
        brief.project?.id ?? brief.project_id ?? selects.project_id,
        opts.minSourceQualityScore ?? 0.5,
      ),
      iterationExcludedSegmentIds: [...discoveredSegmentIds].sort(),
    };
    const proposedFixes = await (opts.proposeFixes ?? defaultProposeFixes)(
      fixableIssues,
      workingTimeline,
      selects,
      absProjectDir,
      iteration,
      discovery,
    );
    const fixes = proposedFixes.slice(0, maxFixesPerIteration);

    if (fixes.length === 0) {
      reportSequence = recordIterationReport({
        projectDir: absProjectDir,
        reportSequence,
        issues,
        fixes: proposedFixes.map((fix) => reportedFix(fix, "rejected", "iteration fix limit excluded this proposal")),
        evaluation: currentEvaluation,
        timeline: workingTimeline,
        opts,
        reports,
        reportRefs,
      });
      convergenceReason = "no_improvement";
      break;
    }

    backupIterationArtifacts(absProjectDir, iteration, { includeRender: !skipRender });
    const snapshot = captureTransactionSnapshot(absProjectDir, selects, blueprint, timeline);
    let applyResult: ApplyResult | undefined;
    let nextTimeline: TimelineIR | undefined;

    try {
      applyResult = applyFixes(fixes, selects, blueprint, workingTimeline, {
        projectDir: absProjectDir,
        discovery,
      });
      warnings.push(...applyResult.warnings);
      if (applyResult.selects_modified || applyResult.blueprint_modified) {
        persistPlanningArtifacts(absProjectDir, selects, blueprint, applyResult);
        nextTimeline = await (opts.compile ?? defaultCompile)(absProjectDir, selects, blueprint, iteration);
        writeJson(canonicalArtifactPaths(absProjectDir).timeline, nextTimeline);
        if (!skipRender) {
          await (opts.render ?? defaultRender)(absProjectDir, nextTimeline, iteration);
        }
      }
    } catch (error) {
      rollbackTransactionOrThrow(iteration, error, snapshot, selects, blueprint, timeline);
      workingTimeline = timeline;
      const reason = `transaction failed and was rolled back: ${errorMessage(error)}`;
      warnings.push(`Iteration ${iteration} ${reason}`);
      reportSequence = recordIterationReport({
        projectDir: absProjectDir,
        reportSequence,
        issues,
        fixes: dispositionFixes(proposedFixes, fixes, applyResult, "rolled_back", reason),
        evaluation: currentEvaluation,
        timeline: workingTimeline,
        opts,
        reports,
        reportRefs,
      });
      convergenceReason = "no_improvement";
      break;
    }

    if (!applyResult.selects_modified && !applyResult.blueprint_modified) {
      rollbackTransactionOrThrow(
        iteration,
        new Error("fix produced no canonical planning change"),
        snapshot,
        selects,
        blueprint,
        timeline,
      );
      workingTimeline = timeline;
      reportSequence = recordIterationReport({
        projectDir: absProjectDir,
        reportSequence,
        issues,
        fixes: dispositionFixes(
          proposedFixes,
          fixes,
          applyResult,
          "skipped",
          "fix produced no canonical planning change",
        ),
        evaluation: currentEvaluation,
        timeline: workingTimeline,
        opts,
        reports,
        reportRefs,
      });
      convergenceReason = "no_improvement";
      break;
    }

    if (!nextTimeline) {
      const error = new Error("compile did not produce a timeline");
      rollbackTransactionOrThrow(iteration, error, snapshot, selects, blueprint, timeline);
      workingTimeline = timeline;
      warnings.push(`Iteration ${iteration} transaction produced no timeline and was rolled back`);
      reportSequence = recordIterationReport({
        projectDir: absProjectDir,
        reportSequence,
        issues,
        fixes: dispositionFixes(proposedFixes, fixes, applyResult, "rolled_back", error.message),
        evaluation: currentEvaluation,
        timeline: workingTimeline,
        opts,
        reports,
        reportRefs,
      });
      convergenceReason = "no_improvement";
      break;
    }

    const candidateEvaluation = await evaluateIteration(
      absProjectDir,
      brief,
      nextTimeline,
      evaluationSequence,
      skipRender,
      opts,
      warnings,
    );
    evaluationSequence += 1;
    const rejectionReason = mutationRejectionReason(currentEvaluation, candidateEvaluation, qualityFloor);
    if (rejectionReason) {
      rollbackTransactionOrThrow(iteration, new Error(rejectionReason.message), snapshot, selects, blueprint, timeline);
      workingTimeline = timeline;
      warnings.push(`Iteration ${iteration} ${rejectionReason.message}; canonical state was restored`);
      reportSequence = recordIterationReport({
        projectDir: absProjectDir,
        reportSequence,
        issues,
        fixes: dispositionFixes(proposedFixes, fixes, applyResult, "rolled_back", rejectionReason.message),
        evaluation: currentEvaluation,
        timeline: workingTimeline,
        opts,
        reports,
        reportRefs,
      });
      convergenceReason = rejectionReason.convergenceReason;
      break;
    }

    replaceObject(timeline, nextTimeline);
    workingTimeline = timeline;
    fixesAppliedTotal += applyResult.applied.length;
    for (const appliedFix of applyResult.applied) {
      if (appliedFix.replacement?.snapshot) discoveredSegmentIds.add(appliedFix.replacement.segment_id);
    }
    try {
      reportSequence = recordIterationReport({
        projectDir: absProjectDir,
        reportSequence,
        issues,
        fixes: dispositionFixes(proposedFixes, fixes, applyResult, "applied", "measured improvement accepted"),
        evaluation: currentEvaluation,
        timeline: snapshot.timeline,
        opts,
        reports,
        reportRefs,
      });
    } finally {
      cleanupCommittedTransactionSnapshot(snapshot, iteration, warnings);
    }
    currentEvaluation = candidateEvaluation;

    if (iteration === maxIterations) {
      convergenceReason = "max_iterations";
    }
  }

  const finalIssues = detectIssues(
    currentEvaluation.marlin,
    currentEvaluation.alignment,
    workingTimeline,
    currentEvaluation.reviewMetrics,
  );
  reportSequence = recordIterationReport({
    projectDir: absProjectDir,
    reportSequence,
    issues: finalIssues,
    fixes: [],
    evaluation: currentEvaluation,
    timeline: workingTimeline,
    opts,
    reports,
    reportRefs,
  });
  const resultTimelineHash = hashTimeline(workingTimeline);
  writeQAImprovementIndex(absProjectDir, {
    version: "1",
    project_id: brief.project?.id ?? brief.project_id ?? path.basename(absProjectDir),
    run_id: runStartedAt,
    base_timeline_hash: baseTimelineHash,
    result_timeline_hash: resultTimelineHash,
    convergence_reason: indexConvergenceReason(convergenceReason, reports.at(-1)),
    iterations: reportRefs,
  });

  return {
    iterations,
    initial_score: round3(initialScore),
    final_score: round3(currentEvaluation.score),
    improvement: round3(currentEvaluation.score - initialScore),
    fixes_applied_total: fixesAppliedTotal,
    reports,
    converged: convergenceReason !== "max_iterations",
    convergence_reason: convergenceReason,
    warnings: [...new Set(warnings)],
    visual_qa: currentEvaluation.visualQaApplicable
      ? {
        status: isMarlinQAReportVerified(currentEvaluation.marlin) ? "verified" : "blocked",
        ...(currentEvaluation.marlin.visual_qa_reason
          ? { reason: currentEvaluation.marlin.visual_qa_reason }
          : {}),
      }
      : { status: "not_applicable", reason: "audio_only_timeline" },
  };
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
  const visualQaApplicable = !isAudioOnlyTimeline(timeline);
  let marlin: MarlinQAReport;
  if (!visualQaApplicable) {
    marlin = blockedMarlinReport(projectDir, videoPath, "audio_only_timeline");
  } else if (skipRender) {
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
  const marlinAvailable = !visualQaApplicable || (
    isMarlinQAReportVerified(marlin) && Number.isFinite(marlin.score)
  );
  let alignment: BriefAlignmentReport;
  let alignmentAvailable = true;
  try {
    alignment = await (opts.runBriefAlignment ?? defaultRunBriefAlignment)(projectDir, brief, timeline, iteration);
    alignmentAvailable = Number.isFinite(alignment.composite);
    if (!alignmentAvailable) {
      warnings.push("Brief alignment evaluation returned a non-finite composite score");
    }
  } catch (error) {
    alignmentAvailable = false;
    alignment = unavailableBriefAlignmentReport(projectDir, iteration, errorMessage(error), opts);
    warnings.push(`Brief alignment evaluation was unavailable: ${errorMessage(error)}`);
  }
  const unavailableReasons = [
    ...(!marlinAvailable ? [`visual QA is ${marlin.visual_qa ?? "unverified"}`] : []),
    ...(!alignmentAvailable ? ["brief alignment evaluation is unavailable"] : []),
  ];
  let reviewMetrics: ReviewMetricsArtifact;
  try {
    const reviewInputs = loadReviewMetricsInputs(projectDir);
    reviewInputs.timeline = timeline;
    reviewMetrics = await (opts.evaluateReviewMetrics ?? ((inputs) => computeReviewMetrics(inputs)))(
      reviewInputs,
      iteration,
    );
  } catch (error) {
    warnings.push(`Review metrics evaluation was unavailable: ${errorMessage(error)}`);
    reviewMetrics = computeReviewMetrics({ timeline });
  }
  return {
    marlin,
    alignment,
    available: unavailableReasons.length === 0,
    ...(unavailableReasons.length > 0 ? { unavailableReason: unavailableReasons.join("; ") } : {}),
    score: computeOverallScore(marlin, alignment, visualQaApplicable),
    reviewMetrics,
    visualQaApplicable,
  };
}

function writeIterationReport(input: {
  projectDir: string;
  iteration: number;
  issues: QAIssue[];
  fixes: QAReportedFix[];
  evaluation: Evaluation;
  timeline: TimelineIR;
  opts: QALoopOptions;
}): QAImprovementReport {
  const { projectDir, iteration, issues, fixes, evaluation, timeline, opts } = input;
  const report = buildQAReport(
    iteration,
    issues,
    fixes,
    evaluation.marlin,
    evaluation.alignment,
    {
      ...(opts.now ? { now: opts.now } : {}),
      evaluationStatus: evaluation.available ? "available" : "unavailable",
      ...(evaluation.unavailableReason ? { evaluationUnavailableReason: evaluation.unavailableReason } : {}),
      timelineHash: hashTimeline(timeline),
      visualQaApplicable: evaluation.visualQaApplicable,
    },
  );
  writeQAImprovementReport(projectDir, report, iterationReportRef(iteration).path);
  return report;
}

function recordIterationReport(input: {
  projectDir: string;
  reportSequence: number;
  issues: QAIssue[];
  fixes: QAReportedFix[];
  evaluation: Evaluation;
  timeline: TimelineIR;
  opts: QALoopOptions;
  reports: QAImprovementReport[];
  reportRefs: QAImprovementIndex["iterations"];
}): number {
  const iteration = input.reportSequence + 1;
  const report = writeIterationReport({ ...input, iteration });
  input.reports.push(report);
  input.reportRefs.push(iterationReportRef(iteration));
  return iteration;
}

function reportedFix(
  fix: QAFix,
  disposition: QAFixDisposition,
  reason?: string,
): QAReportedFix {
  return {
    ...fix,
    disposition,
    ...(reason ? { disposition_reason: reason } : {}),
  };
}

function dispositionFixes(
  proposedFixes: QAFix[],
  selectedFixes: QAFix[],
  applyResult: ApplyResult | undefined,
  appliedDisposition: Extract<QAFixDisposition, "applied" | "rolled_back" | "skipped">,
  reason: string,
): QAReportedFix[] {
  const selected = new Set(selectedFixes);
  const skipped = new Set(applyResult?.skipped ?? []);
  return proposedFixes.map((fix) => {
    if (!selected.has(fix)) {
      return reportedFix(fix, "rejected", "iteration fix limit excluded this proposal");
    }
    if (skipped.has(fix)) {
      return reportedFix(fix, "skipped", applyResult?.warnings.join("; ") || "fix was not applicable");
    }
    return reportedFix(fix, appliedDisposition, reason);
  });
}

function mutationRejectionReason(
  previous: Evaluation,
  candidate: Evaluation,
  qualityFloor: number,
): {
  convergenceReason: Extract<QALoopResult["convergence_reason"], "quality_floor" | "no_improvement">;
  message: string;
} | null {
  if (!candidate.available) {
    return {
      convergenceReason: "no_improvement",
      message: `post-fix evaluation was unavailable: ${candidate.unavailableReason ?? "unknown reason"}`,
    };
  }
  if (!meetsQualityFloor(candidate.score, qualityFloor)) {
    return {
      convergenceReason: "quality_floor",
      message: `post-fix score ${candidate.score} was below quality floor ${qualityFloor}`,
    };
  }
  if (!isMeasuredImprovement(previous.score, candidate.score)) {
    return {
      convergenceReason: "no_improvement",
      message: `post-fix score ${candidate.score} did not improve on ${previous.score}`,
    };
  }
  return null;
}

function meetsQualityFloor(score: number, qualityFloor: number): boolean {
  return Number.isFinite(score) && score >= qualityFloor;
}

function isMeasuredImprovement(previousScore: number, candidateScore: number): boolean {
  return Number.isFinite(candidateScore) && candidateScore > previousScore + SCORE_COMPARISON_EPSILON;
}

function persistPlanningArtifacts(
  projectDir: string,
  selects: SelectsCandidates,
  blueprint: EditBlueprint,
  result: ApplyResult,
): void {
  const paths = canonicalArtifactPaths(projectDir);
  if (result.selects_modified) writeYaml(paths.selects, selects);
  if (result.blueprint_modified) writeYaml(paths.blueprint, blueprint);
}

function canonicalArtifactPaths(projectDir: string): {
  selects: string;
  blueprint: string;
  timeline: string;
  adjacency: string;
  render: string;
  renderReport: string;
} {
  return {
    selects: path.join(projectDir, "04_plan", "selects_candidates.yaml"),
    blueprint: path.join(projectDir, "04_plan", "edit_blueprint.yaml"),
    timeline: path.join(projectDir, "05_timeline", "timeline.json"),
    adjacency: path.join(projectDir, "05_timeline", "adjacency_analysis.json"),
    render: defaultRenderPath(projectDir),
    renderReport: path.join(projectDir, "09_output", "render-report.json"),
  };
}

function captureTransactionSnapshot(
  projectDir: string,
  selects: SelectsCandidates,
  blueprint: EditBlueprint,
  timeline: TimelineIR,
): TransactionSnapshot {
  const paths = canonicalArtifactPaths(projectDir);
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), TRANSACTION_TEMP_PREFIX));
  try {
    return {
      tempDir,
      artifacts: Object.values(paths).map((filePath, index) => captureArtifactSnapshot(
        filePath,
        path.join(tempDir, `${index}-${path.basename(filePath)}`),
      )),
      selects: structuredClone(selects),
      blueprint: structuredClone(blueprint),
      timeline: structuredClone(timeline),
    };
  } catch (error) {
    try {
      cleanupTransactionSnapshot({ tempDir });
    } catch (cleanupError) {
      throw new Error(
        `QA transaction snapshot failed (${errorMessage(error)}) and temp cleanup also failed: ${errorMessage(cleanupError)}`,
      );
    }
    throw error;
  }
}

function captureArtifactSnapshot(filePath: string, backupPath: string): ArtifactSnapshot {
  if (!fs.existsSync(filePath)) return { path: filePath, existed: false };
  fs.copyFileSync(filePath, backupPath);
  return {
    path: filePath,
    existed: true,
    backupPath,
  };
}

function rollbackTransactionOrThrow(
  iteration: number,
  transactionError: unknown,
  snapshot: TransactionSnapshot,
  selects: SelectsCandidates,
  blueprint: EditBlueprint,
  timeline: TimelineIR,
): void {
  const failures: string[] = [];
  for (const artifact of snapshot.artifacts) {
    try {
      restoreArtifactSnapshot(artifact);
    } catch (error) {
      failures.push(`${artifact.path}: ${errorMessage(error)}`);
    }
  }
  for (const [label, target, source] of [
    ["selects", selects, snapshot.selects],
    ["blueprint", blueprint, snapshot.blueprint],
    ["timeline", timeline, snapshot.timeline],
  ] as const) {
    try {
      replaceObject(target, source);
    } catch (error) {
      failures.push(`in-memory ${label}: ${errorMessage(error)}`);
    }
  }
  try {
    cleanupTransactionSnapshot(snapshot);
  } catch (error) {
    failures.push(`${snapshot.tempDir}: transaction temp cleanup failed: ${errorMessage(error)}`);
  }
  if (failures.length > 0) {
    throw new QATransactionRestoreError(iteration, transactionError, failures);
  }
}

function restoreArtifactSnapshot(snapshot: ArtifactSnapshot): void {
  if (snapshot.existed) {
    if (!snapshot.backupPath) throw new Error("disk-backed snapshot path is missing");
    copyFileAtomically(snapshot.backupPath, snapshot.path);
    return;
  }
  if (!fs.existsSync(snapshot.path)) return;
  const stat = fs.lstatSync(snapshot.path);
  if (stat.isDirectory()) {
    throw new Error("cannot remove a directory created at a canonical artifact path");
  }
  fs.unlinkSync(snapshot.path);
}

function copyFileAtomically(sourcePath: string, destinationPath: string): void {
  fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
  const tmp = `${destinationPath}.restore.${process.pid}.${crypto.randomUUID()}`;
  try {
    fs.copyFileSync(sourcePath, tmp);
    fs.renameSync(tmp, destinationPath);
  } finally {
    if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
  }
}

function cleanupCommittedTransactionSnapshot(
  snapshot: TransactionSnapshot,
  iteration: number,
  warnings: string[],
): void {
  try {
    cleanupTransactionSnapshot(snapshot);
  } catch (error) {
    warnings.push(`Iteration ${iteration} committed but transaction temp cleanup failed: ${errorMessage(error)}`);
  }
}

function cleanupTransactionSnapshot(snapshot: Pick<TransactionSnapshot, "tempDir">): void {
  fs.rmSync(snapshot.tempDir, { recursive: true, force: true, maxRetries: 3 });
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

function unavailableBriefAlignmentReport(
  projectDir: string,
  iteration: number,
  detail: string,
  opts: QALoopOptions,
): BriefAlignmentReport {
  return {
    version: "1",
    project: path.basename(projectDir),
    evaluated_at: (opts.now ?? (() => new Date()))().toISOString(),
    brief_hash: "unavailable",
    stages: {},
    composite: 0,
    notes: [`Brief alignment evaluation ${iteration} was unavailable: ${detail}`],
  };
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
  _iteration: number,
  discovery?: QADiscoveryContract,
): Promise<QAFix[]> {
  return proposeFixes(issues, timeline, selects, projectDir, { discovery });
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
  visualQaApplicable = true,
): number {
  const alignmentScore = clamp01(briefAlignmentResult.composite);
  if (!visualQaApplicable) return round3(alignmentScore);
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
): { selects?: string; blueprint?: string; timeline?: string; render?: string; renderReport?: string } {
  const paths = canonicalArtifactPaths(projectDir);
  return {
    selects: copyIfExists(
      paths.selects,
      path.join(projectDir, "04_plan", `selects_candidates-iter${iteration}.yaml`),
    ),
    blueprint: copyIfExists(
      paths.blueprint,
      path.join(projectDir, "04_plan", `edit_blueprint-iter${iteration}.yaml`),
    ),
    timeline: copyIfExists(
      paths.timeline,
      path.join(projectDir, "05_timeline", `timeline-iter${iteration}.json`),
    ),
    render: opts.includeRender
      ? copyIfExists(
          paths.render,
          path.join(projectDir, "09_output", `rough-cut-iter${iteration}.mp4`),
        )
      : undefined,
    renderReport: opts.includeRender
      ? copyIfExists(
          paths.renderReport,
          path.join(projectDir, "09_output", `render-report-iter${iteration}.json`),
        )
      : undefined,
  };
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
  reason: "render_missing" | "render_skipped" | "marlin_unavailable" | "audio_only_timeline",
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

function visualQABlockedReasonText(
  reason: "render_missing" | "render_skipped" | "marlin_unavailable" | "audio_only_timeline",
): string {
  if (reason === "audio_only_timeline") return "visual QA is not applicable to an audio-only timeline";
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
