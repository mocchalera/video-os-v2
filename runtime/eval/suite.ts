import * as fs from "node:fs";
import * as path from "node:path";
import { evaluateReviewVisualQA, type ReviewVisualQA } from "../review/visual-qa.js";
import {
  evaluateBriefAlignment,
  type EvaluateBriefAlignmentOptions,
} from "./brief-alignment.js";
import type { BriefAlignmentReport } from "./brief-alignment-types.js";
import { discoverGoldenProjects } from "./golden-registry.js";
import { selfEvaluateGolden } from "./index.js";
import type { EvalReport } from "./types.js";

export const DEFAULT_GOLDEN_SUITE_PROJECTS = [
  "fumoto-growth",
  "togakushi-camp",
  "ena-promo",
  "ax1-komatsu-testimonial-d4892",
  "ax1-female-testimonial-d4892",
] as const;

type StageStatus = "completed" | "skipped" | "failed";

export interface EvalSuiteStage<TReport = unknown> {
  status: StageStatus;
  score: number | null;
  reason?: string;
  error?: string;
  reference_only?: boolean;
  judge_source?: string;
  report?: TReport;
}

export interface EvalSuiteDivergence {
  status: "computed" | "skipped";
  threshold: number;
  structural_alignment_score: number | null;
  marlin_qa_score: number | null;
  difference: number | null;
  warning: boolean;
  reason?: string;
  previous?: {
    structural_alignment_delta?: number;
    marlin_qa_delta?: number;
    difference_delta?: number;
  };
}

export interface EvalSuiteProjectResult {
  project_id: string;
  project_dir: string;
  structure: EvalSuiteStage<EvalReport>;
  brief_alignment: EvalSuiteStage<BriefAlignmentReport>;
  marlin_qa: EvalSuiteStage<ReviewVisualQA>;
  structural_alignment_score: number | null;
  reference_structural_alignment_score: number | null;
  divergence: EvalSuiteDivergence;
}

export interface EvalSuiteSummary {
  version: "1";
  suite: "golden";
  evaluated_at: string;
  projects_requested: string[];
  divergence_threshold: number;
  previous_suite: {
    path: string;
    evaluated_at: string;
  } | null;
  totals: {
    projects: number;
    warnings: number;
    skipped_stages: number;
    failed_stages: number;
  };
  projects: EvalSuiteProjectResult[];
}

export interface RunEvalSuiteOptions {
  repoRoot?: string;
  outRoot?: string;
  suite?: "golden";
  projects?: string[];
  divergenceThreshold?: number;
  now?: () => Date;
  write?: boolean;
  briefAlignmentUseLlm?: boolean;
  runMarlinQA?: boolean;
  evaluateStructure?: (projectDir: string) => Promise<EvalReport>;
  evaluateBrief?: (projectDir: string) => Promise<BriefAlignmentReport>;
  evaluateVisualQA?: (projectDir: string, suiteDir: string) => Promise<ReviewVisualQA>;
}

export function resolveSuiteBriefAlignmentOptions(
  useLlm: boolean | undefined,
): EvaluateBriefAlignmentOptions {
  return { useLlm: useLlm === true };
}

export interface RunEvalSuiteResult {
  summary: EvalSuiteSummary;
  suiteDir: string;
  jsonPath?: string;
  markdownPath?: string;
}

interface PreviousProject {
  structural_alignment_score?: number | null;
  marlin_qa?: { score?: number | null };
  divergence?: { difference?: number | null };
}

const ARTIFACTS = {
  brief: "01_intent/creative_brief.yaml",
  selects: "04_plan/selects_candidates.yaml",
  blueprint: "04_plan/edit_blueprint.yaml",
  timeline: "05_timeline/timeline.json",
} as const;

function artifactPath(projectDir: string, artifact: keyof typeof ARTIFACTS): string {
  return path.join(projectDir, ARTIFACTS[artifact]);
}

function exists(projectDir: string, artifact: keyof typeof ARTIFACTS): boolean {
  return fs.existsSync(artifactPath(projectDir, artifact));
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function average(values: number[]): number | null {
  if (values.length === 0) return null;
  return round1(values.reduce((total, value) => total + value, 0) / values.length);
}

function scoreFromBrief(report: BriefAlignmentReport): number {
  return round1(report.composite * 100);
}

function projectDirFor(repoRoot: string, project: string): string {
  return path.isAbsolute(project) ? project : path.join(repoRoot, "projects", project);
}

function projectIdFor(project: string): string {
  return path.basename(path.resolve(project));
}

function skipped<TReport>(reason: string): EvalSuiteStage<TReport> {
  return { status: "skipped", score: null, reason };
}

function failed<TReport>(error: unknown): EvalSuiteStage<TReport> {
  return {
    status: "failed",
    score: null,
    error: error instanceof Error ? error.message : String(error),
  };
}

function normalizeProjectList(projects: string[] | undefined): string[] {
  return (projects && projects.length > 0 ? projects : [...DEFAULT_GOLDEN_SUITE_PROJECTS])
    .map((project) => project.trim())
    .filter(Boolean);
}

function timestampForPath(date: Date): string {
  return date.toISOString().replace(/[:.]/g, "-");
}

function suiteDirFor(outRoot: string, evaluatedAt: Date): string {
  return path.join(outRoot, `suite-${timestampForPath(evaluatedAt)}`);
}

function latestPreviousSuite(outRoot: string): EvalSuiteSummary | null {
  if (!fs.existsSync(outRoot)) return null;
  const candidates = fs.readdirSync(outRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("suite-"))
    .map((entry) => path.join(outRoot, entry.name, "summary.json"))
    .filter((filePath) => fs.existsSync(filePath))
    .sort();
  const latest = candidates[candidates.length - 1];
  if (!latest) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(latest, "utf-8")) as EvalSuiteSummary;
    return {
      ...parsed,
      previous_suite: {
        path: latest,
        evaluated_at: parsed.evaluated_at,
      },
    };
  } catch {
    return null;
  }
}

function previousProjectMap(previous: EvalSuiteSummary | null): Map<string, PreviousProject> {
  return new Map((previous?.projects ?? []).map((project) => [project.project_id, project]));
}

async function evaluateStructureStage(
  projectDir: string,
  projectId: string,
  goldenIds: Set<string>,
  evaluateStructure: (projectDir: string) => Promise<EvalReport>,
): Promise<EvalSuiteStage<EvalReport>> {
  if (!fs.existsSync(projectDir)) return skipped("project_dir_missing");
  if (!goldenIds.has(projectId)) return skipped("golden_not_found_or_incomplete");
  if (!exists(projectDir, "timeline")) return skipped("golden_timeline_missing");
  try {
    const report = await evaluateStructure(projectDir);
    return { status: "completed", score: report.overall_score, report };
  } catch (error) {
    if (isIncompatibleGoldenTimelineError(error)) {
      return skipped("golden_timeline_incompatible");
    }
    return failed(error);
  }
}

function isIncompatibleGoldenTimelineError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("Artifact validation failed (timeline-ir.schema.json)") ||
    message.includes("Golden timeline not found:");
}

async function evaluateBriefStage(
  projectDir: string,
  evaluateBrief: (projectDir: string) => Promise<BriefAlignmentReport>,
): Promise<EvalSuiteStage<BriefAlignmentReport>> {
  if (!fs.existsSync(projectDir)) return skipped("project_dir_missing");
  if (!exists(projectDir, "brief")) return skipped("creative_brief_missing");
  if (!exists(projectDir, "selects") && !exists(projectDir, "blueprint")) {
    return skipped("brief_alignment_artifacts_missing");
  }
  try {
    const report = await evaluateBrief(projectDir);
    const referenceOnly = report.judge_source === "deterministic-only";
    return {
      status: "completed",
      score: scoreFromBrief(report),
      report,
      judge_source: report.judge_source ?? "unknown",
      ...(referenceOnly ? { reference_only: true } : {}),
      ...(referenceOnly ? { reason: "deterministic-only" } : {}),
    };
  } catch (error) {
    return failed(error);
  }
}

async function evaluateMarlinQAStage(
  projectDir: string,
  suiteDir: string,
  evaluateVisualQA: (projectDir: string, suiteDir: string) => Promise<ReviewVisualQA>,
): Promise<EvalSuiteStage<ReviewVisualQA>> {
  if (!fs.existsSync(projectDir)) return skipped("project_dir_missing");
  try {
    const report = await evaluateVisualQA(projectDir, suiteDir);
    if (report.status !== "verified") {
      return skipped(`visual_qa_${report.status}${report.reason ? `:${report.reason}` : ""}`);
    }
    return { status: "completed", score: report.score ?? null, report };
  } catch (error) {
    return failed(error);
  }
}

function computeStructuralScores(
  structure: EvalSuiteStage<EvalReport>,
  brief: EvalSuiteStage<BriefAlignmentReport>,
): { primary: number | null; reference: number | null } {
  const primary: number[] = [];
  const reference: number[] = [];
  if (structure.status === "completed" && typeof structure.score === "number") {
    primary.push(structure.score);
    reference.push(structure.score);
  }
  if (brief.status === "completed" && typeof brief.score === "number") {
    reference.push(brief.score);
    if (!brief.reference_only) {
      primary.push(brief.score);
    }
  }
  return { primary: average(primary), reference: average(reference) };
}

function computeDivergence(
  projectId: string,
  structuralScore: number | null,
  referenceStructuralScore: number | null,
  marlin: EvalSuiteStage<ReviewVisualQA>,
  threshold: number,
  previousProjects: Map<string, PreviousProject>,
): EvalSuiteDivergence {
  const marlinScore = marlin.status === "completed" && typeof marlin.score === "number"
    ? marlin.score
    : null;
  if (structuralScore === null || marlinScore === null) {
    return {
      status: "skipped",
      threshold,
      structural_alignment_score: structuralScore,
      marlin_qa_score: marlinScore,
      difference: null,
      warning: false,
      reason: structuralScore === null && referenceStructuralScore !== null
        ? "only_reference_alignment_score_available"
        : structuralScore === null
          ? "structural_alignment_score_unavailable"
          : "marlin_qa_score_unavailable",
    };
  }
  const difference = round1(Math.abs(structuralScore - marlinScore));
  const previous = previousProjects.get(projectId);
  const previousDiff = previous?.divergence?.difference;
  const previousStructural = previous?.structural_alignment_score;
  const previousMarlin = previous?.marlin_qa?.score;
  return {
    status: "computed",
    threshold,
    structural_alignment_score: structuralScore,
    marlin_qa_score: marlinScore,
    difference,
    warning: difference > threshold,
    ...(previous
      ? {
          previous: {
            ...(typeof previousStructural === "number"
              ? { structural_alignment_delta: round1(structuralScore - previousStructural) }
              : {}),
            ...(typeof previousMarlin === "number"
              ? { marlin_qa_delta: round1(marlinScore - previousMarlin) }
              : {}),
            ...(typeof previousDiff === "number"
              ? { difference_delta: round1(difference - previousDiff) }
              : {}),
          },
        }
      : {}),
  };
}

export async function runGoldenEvalSuite(
  options: RunEvalSuiteOptions = {},
): Promise<RunEvalSuiteResult> {
  const repoRoot = path.resolve(options.repoRoot ?? process.cwd());
  const outRoot = path.resolve(repoRoot, options.outRoot ?? "reports/eval");
  const now = options.now ?? (() => new Date());
  const evaluatedAtDate = now();
  const evaluatedAt = evaluatedAtDate.toISOString();
  const suiteDir = suiteDirFor(outRoot, evaluatedAtDate);
  const projects = normalizeProjectList(options.projects);
  const threshold = options.divergenceThreshold ?? 30;
  const previous = latestPreviousSuite(outRoot);
  const previousProjects = previousProjectMap(previous);
  const goldenIds = new Set(discoverGoldenProjects(repoRoot).map((project) => project.project_id));
  const evaluateStructure = options.evaluateStructure ?? (async (projectDir: string) =>
    (await selfEvaluateGolden(projectDir, { judge: false, now })).report
  );
  const evaluateBrief = options.evaluateBrief ?? ((projectDir: string) =>
    evaluateBriefAlignment(
      projectDir,
      resolveSuiteBriefAlignmentOptions(options.briefAlignmentUseLlm),
    )
  );
  const evaluateVisualQA = options.evaluateVisualQA ?? ((projectDir: string, dir: string) =>
    evaluateReviewVisualQA(projectDir, {
      render: false,
      repoRoot,
      marlinReportDir: dir,
      writeReport: options.write !== false,
      now,
    })
  );
  const shouldEvaluateMarlin = options.evaluateVisualQA !== undefined || options.runMarlinQA === true;

  const results: EvalSuiteProjectResult[] = [];
  for (const project of projects) {
    const projectDir = path.resolve(projectDirFor(repoRoot, project));
    const projectId = projectIdFor(projectDir);
    const structure = await evaluateStructureStage(projectDir, projectId, goldenIds, evaluateStructure);
    const brief = await evaluateBriefStage(projectDir, evaluateBrief);
    const marlin = shouldEvaluateMarlin
      ? await evaluateMarlinQAStage(projectDir, suiteDir, evaluateVisualQA)
      : skipped<ReviewVisualQA>("live_marlin_not_requested");
    const scores = computeStructuralScores(structure, brief);
    const divergence = computeDivergence(
      projectId,
      scores.primary,
      scores.reference,
      marlin,
      threshold,
      previousProjects,
    );
    results.push({
      project_id: projectId,
      project_dir: projectDir,
      structure,
      brief_alignment: brief,
      marlin_qa: marlin,
      structural_alignment_score: scores.primary,
      reference_structural_alignment_score: scores.reference,
      divergence,
    });
  }

  const summary: EvalSuiteSummary = {
    version: "1",
    suite: "golden",
    evaluated_at: evaluatedAt,
    projects_requested: projects,
    divergence_threshold: threshold,
    previous_suite: previous?.previous_suite
      ? {
          path: path.relative(repoRoot, previous.previous_suite.path),
          evaluated_at: previous.previous_suite.evaluated_at,
        }
      : null,
    totals: {
      projects: results.length,
      warnings: results.filter((project) => project.divergence.warning).length,
      skipped_stages: results.flatMap((project) => [
        project.structure,
        project.brief_alignment,
        project.marlin_qa,
      ]).filter((stage) => stage.status === "skipped").length,
      failed_stages: results.flatMap((project) => [
        project.structure,
        project.brief_alignment,
        project.marlin_qa,
      ]).filter((stage) => stage.status === "failed").length,
    },
    projects: results,
  };

  if (options.write === false) {
    return { summary, suiteDir };
  }

  fs.mkdirSync(suiteDir, { recursive: true });
  const jsonPath = path.join(suiteDir, "summary.json");
  const markdownPath = path.join(suiteDir, "summary.md");
  fs.writeFileSync(jsonPath, `${JSON.stringify(summary, null, 2)}\n`, "utf-8");
  fs.writeFileSync(markdownPath, renderEvalSuiteMarkdown(summary), "utf-8");
  return { summary, suiteDir, jsonPath, markdownPath };
}

function stageText(stage: EvalSuiteStage): string {
  if (stage.status === "completed") {
    const score = typeof stage.score === "number" ? `${stage.score.toFixed(1)}` : "score n/a";
    const reference = stage.reference_only ? " 参考値" : "";
    const judge = stage.judge_source ? ` (${stage.judge_source})` : "";
    return `${score}${reference}${judge}`;
  }
  if (stage.status === "skipped") return `skipped(${stage.reason ?? "unknown"})`;
  return `failed(${stage.error ?? "unknown"})`;
}

function deltaText(value: number | undefined): string {
  if (typeof value !== "number") return "";
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toFixed(1)}`;
}

function divergenceText(project: EvalSuiteProjectResult): string {
  const divergence = project.divergence;
  if (divergence.status === "skipped") return `skipped(${divergence.reason ?? "unknown"})`;
  const warning = divergence.warning ? " WARNING" : "";
  const previous = divergence.previous
    ? [
        deltaText(divergence.previous.structural_alignment_delta),
        deltaText(divergence.previous.marlin_qa_delta),
        deltaText(divergence.previous.difference_delta),
      ].map((value) => value || "—").join(" / ")
    : "—";
  return `${divergence.difference?.toFixed(1)}${warning} (prev Δ struct/marlin/diff: ${previous})`;
}

export function renderEvalSuiteMarkdown(summary: EvalSuiteSummary): string {
  const lines: string[] = [];
  lines.push("# Eval Suite Summary");
  lines.push("");
  lines.push(`- Suite: ${summary.suite}`);
  lines.push(`- Evaluated at: ${summary.evaluated_at}`);
  lines.push(`- Divergence threshold: ${summary.divergence_threshold}`);
  lines.push(`- Previous suite: ${summary.previous_suite ? `${summary.previous_suite.path} (${summary.previous_suite.evaluated_at})` : "none"}`);
  lines.push(`- Totals: ${summary.totals.projects} project(s), ${summary.totals.warnings} warning(s), ${summary.totals.skipped_stages} skipped stage(s), ${summary.totals.failed_stages} failed stage(s)`);
  lines.push("");
  lines.push("| project | structure | brief-alignment | marlin-qa | structure/alignment | divergence |");
  lines.push("| --- | --- | --- | --- | --- | --- |");
  for (const project of summary.projects) {
    const primary = project.structural_alignment_score === null
      ? "—"
      : project.structural_alignment_score.toFixed(1);
    const reference = project.reference_structural_alignment_score !== null &&
      project.reference_structural_alignment_score !== project.structural_alignment_score
      ? ` (参考値 incl. deterministic ${project.reference_structural_alignment_score.toFixed(1)})`
      : "";
    lines.push([
      project.project_id,
      stageText(project.structure),
      stageText(project.brief_alignment),
      stageText(project.marlin_qa),
      `${primary}${reference}`,
      divergenceText(project),
    ].map((value) => value.replace(/\|/g, "\\|")).join(" | ").replace(/^/, "| ").replace(/$/, " |"));
  }
  lines.push("");
  const warnings = summary.projects.filter((project) => project.divergence.warning);
  if (warnings.length > 0) {
    lines.push("## Warnings");
    lines.push("");
    for (const project of warnings) {
      lines.push(`- ${project.project_id}: structure/alignment ${project.divergence.structural_alignment_score?.toFixed(1)} vs marlin-qa ${project.divergence.marlin_qa_score?.toFixed(1)} differs by ${project.divergence.difference?.toFixed(1)} (> ${summary.divergence_threshold}).`);
    }
    lines.push("");
  }
  lines.push("## Notes");
  lines.push("");
  lines.push("- `deterministic-only` brief-alignment scores are marked as 参考値 and are excluded from the primary structure/alignment average.");
  lines.push("- Marlin QA is only counted when F-0023 visual_qa status is `verified`; missing, stale, blocked, or mock visual QA is summarized as skipped.");
  lines.push("");
  return lines.join("\n");
}
