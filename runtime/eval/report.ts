// Eval report composition and rendering.

import { clamp01 } from "./matching.js";
import type {
  EvalMode,
  EvalReport,
  EvalStageScores,
  LlmJudgeReport,
} from "./types.js";

/** Stage weights for the composite score (renormalized over present stages). */
const STAGE_WEIGHTS = {
  selects: 0.35,
  timeline: 0.45,
  blueprint: 0.2,
} as const;

/** When the judge runs, it owns this share of the overall score. */
const JUDGE_WEIGHT = 0.3;

export interface ComposeReportInput {
  mode: EvalMode;
  goldenProject: string;
  candidateProject: string;
  goldenApprovedBy: string | null;
  evaluatedAt: string;
  stages: EvalStageScores;
  llmJudge?: LlmJudgeReport | null;
  minScore?: number | null;
}

export function composeEvalReport(input: ComposeReportInput): EvalReport {
  const parts: Array<{ value: number; weight: number }> = [];
  for (const stage of ["selects", "timeline", "blueprint"] as const) {
    const report = input.stages[stage];
    if (report) parts.push({ value: report.score, weight: STAGE_WEIGHTS[stage] });
  }

  let structural = 0;
  if (parts.length > 0) {
    const totalWeight = parts.reduce((s, p) => s + p.weight, 0);
    structural = parts.reduce((s, p) => s + p.value * p.weight, 0) / totalWeight;
  }

  let overall = structural;
  if (input.llmJudge) {
    overall = structural * (1 - JUDGE_WEIGHT) + input.llmJudge.score * JUDGE_WEIGHT;
  }
  const overallScore = Math.round(clamp01(overall) * 1000) / 10;

  const minScore = input.minScore ?? null;
  return {
    version: "1",
    mode: input.mode,
    golden_project: input.goldenProject,
    candidate_project: input.candidateProject,
    evaluated_at: input.evaluatedAt,
    golden_approved_by: input.goldenApprovedBy,
    stages: input.stages,
    llm_judge: input.llmJudge ?? null,
    overall_score: overallScore,
    min_score: minScore,
    pass: minScore === null ? null : overallScore >= minScore,
  };
}

// ── Markdown rendering ──────────────────────────────────────────────

function pct(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  return `${(value * 100).toFixed(1)}%`;
}

function num(value: number | null | undefined, suffix = ""): string {
  if (value === null || value === undefined) return "—";
  return `${value.toFixed(1)}${suffix}`;
}

export function renderMarkdownReport(report: EvalReport): string {
  const lines: string[] = [];
  lines.push(`# Editorial Agreement Report`);
  lines.push("");
  lines.push(`- Mode: ${report.mode}`);
  lines.push(`- Golden: ${report.golden_project} (approved by: ${report.golden_approved_by ?? "unknown"})`);
  lines.push(`- Candidate: ${report.candidate_project}`);
  lines.push(`- Evaluated at: ${report.evaluated_at}`);
  lines.push("");
  const verdict =
    report.pass === null ? "" : report.pass ? " — PASS" : " — **FAIL**";
  lines.push(`## Overall score: ${report.overall_score} / 100${verdict}`);
  if (report.min_score !== null) {
    lines.push(`(threshold: ${report.min_score})`);
  }
  lines.push("");

  const selects = report.stages.selects;
  if (selects) {
    lines.push(`## Selects agreement — ${pct(selects.score)}`);
    lines.push("");
    lines.push(`| metric | value |`);
    lines.push(`| --- | --- |`);
    lines.push(`| precision / recall / F1 | ${pct(selects.precision)} / ${pct(selects.recall)} / ${pct(selects.f1)} |`);
    lines.push(`| matched / golden / candidate | ${selects.matched_count} / ${selects.golden_count} / ${selects.candidate_count} |`);
    lines.push(`| role agreement | ${pct(selects.role_agreement)} |`);
    lines.push(`| rank correlation (Spearman) | ${num(selects.rank_correlation)} |`);
    lines.push(`| beat eligibility overlap | ${pct(selects.beat_eligibility_overlap)} |`);
    if (selects.missing_from_candidate.length > 0) {
      lines.push("");
      lines.push(`Missing from candidate: ${selects.missing_from_candidate.join(", ")}`);
    }
    if (selects.extra_in_candidate.length > 0) {
      lines.push("");
      lines.push(`Extra in candidate: ${selects.extra_in_candidate.join(", ")}`);
    }
    lines.push("");
  }

  const blueprint = report.stages.blueprint;
  if (blueprint) {
    lines.push(`## Blueprint agreement — ${pct(blueprint.score)}`);
    lines.push("");
    lines.push(`| metric | value |`);
    lines.push(`| --- | --- |`);
    lines.push(`| beats (golden / candidate) | ${blueprint.golden_beat_count} / ${blueprint.candidate_beat_count} |`);
    lines.push(`| story role agreement | ${pct(blueprint.story_role_agreement)} |`);
    lines.push(`| duration share score | ${pct(blueprint.duration_share_score)} |`);
    lines.push(`| pacing agreement | ${pct(blueprint.pacing_agreement)} |`);
    lines.push(`| music agreement | ${pct(blueprint.music_agreement)} |`);
    lines.push("");
  }

  const timeline = report.stages.timeline;
  if (timeline) {
    lines.push(`## Timeline agreement — ${pct(timeline.score)}`);
    lines.push("");
    lines.push(`| metric | value |`);
    lines.push(`| --- | --- |`);
    lines.push(`| clip usage F1 | ${pct(timeline.clip_usage_f1)} |`);
    lines.push(`| matched / golden / candidate clips | ${timeline.matched_clip_count} / ${timeline.golden_clip_count} / ${timeline.candidate_clip_count} |`);
    lines.push(`| cut order agreement | ${pct(timeline.order_agreement)} |`);
    lines.push(`| mean src-in deviation | ${num(timeline.mean_cut_in_deviation_us !== null ? timeline.mean_cut_in_deviation_us / 1000 : null, "ms")} |`);
    lines.push(`| mean duration deviation | ${num(timeline.mean_duration_deviation_frames, " frames")} |`);
    lines.push(`| total duration deviation | ${pct(timeline.total_duration_deviation_pct)} |`);
    lines.push(`| beat structure score | ${pct(timeline.beat_structure_score)} |`);
    lines.push("");
  }

  if (report.llm_judge) {
    const judge = report.llm_judge;
    lines.push(`## LLM judge (${judge.model}) — ${pct(judge.score)}`);
    lines.push("");
    lines.push(`| dimension | score (0-10) |`);
    lines.push(`| --- | --- |`);
    lines.push(`| emotion | ${judge.scores.emotion} |`);
    lines.push(`| story | ${judge.scores.story} |`);
    lines.push(`| rhythm | ${judge.scores.rhythm} |`);
    lines.push(`| agreement with golden | ${judge.scores.agreement_with_golden} |`);
    lines.push("");
    lines.push(`> ${judge.rationale}`);
    lines.push("");
  }

  return lines.join("\n");
}
