import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type {
  CreativeBrief,
  EditBlueprint,
  SelectsCandidates,
} from "../artifacts/types.js";
import {
  loadBlueprint,
  loadCreativeBrief,
  loadSelects,
} from "../artifacts/loaders.js";
import { clamp01 } from "./matching.js";
import type { SelectionCoverageSegment } from "./selection-coverage.js";
import {
  scoreBlueprintEmotionCurve,
  scoreBlueprintIntentMessage,
  scoreMustAvoidViolations,
  scoreMustHaveCoverageWithSemantic,
  scoreNarrativeStructureDeterministic,
  scorePacingDeterministic,
  scoreSelectsEmotionCurve,
  scoreSelectsIntentMessage,
  scoreVisualVariety,
} from "./brief-alignment-deterministic.js";
import {
  buildBriefAlignmentJudgePrompt,
  runBriefAlignmentJudge,
  type BriefAlignmentJudgeReport,
  type RunBriefAlignmentJudgeOptions,
} from "./brief-alignment-judge.js";
import {
  AXIS_WEIGHTS,
  BRIEF_ALIGNMENT_AXES,
  STAGE_WEIGHTS,
  type AxisScore,
  type BriefAlignmentAxis,
  type BriefAlignmentReport,
  type StageResult,
} from "./brief-alignment-types.js";

export interface EvaluateBriefAlignmentOptions {
  stages?: Array<"selects" | "blueprint">;
  useLlm?: boolean;
  evaluatedAt?: string;
  judge?: RunBriefAlignmentJudgeOptions;
}

function hashBrief(raw: string): string {
  return `sha256:${crypto.createHash("sha256").update(raw).digest("hex")}`;
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function fallbackAxis(score: number, evidence: string[], gaps: string[]): AxisScore {
  return {
    score: round3(clamp01(score)),
    confidence: 0.45,
    judge_source: "deterministic",
    evidence,
    gaps,
  };
}

function activeCount(selects: SelectsCandidates): number {
  return selects.candidates.filter((candidate) => candidate.role !== "reject").length;
}

function selectedDurationSec(selects: SelectsCandidates): number {
  return selects.candidates
    .filter((candidate) => candidate.role !== "reject")
    .reduce((total, candidate) => total + Math.max(0, candidate.src_out_us - candidate.src_in_us), 0) / 1_000_000;
}

function scoreSelectsPacing(brief: CreativeBrief, selects: SelectsCandidates): AxisScore {
  const target = Number(brief.project?.runtime_target_sec ?? 0);
  const selected = selectedDurationSec(selects);
  if (target <= 0) {
    return fallbackAxis(0.65, [`${activeCount(selects)} active candidates selected`], ["brief runtime target is unavailable"]);
  }
  const ratio = selected / target;
  let score: number;
  if (ratio < 0.5) {
    score = (ratio / 0.5) * 0.4;
  } else if (ratio <= 1.5) {
    score = 0.7 + ((ratio - 0.5) / 1.0) * 0.3;
  } else if (ratio <= 4.0) {
    score = 1.0;
  } else if (ratio <= 8.0) {
    score = 1.0 - ((ratio - 4.0) / 4.0) * 0.3;
  } else {
    score = 0.7 - Math.min(0.3, ((ratio - 8.0) / 8.0) * 0.3);
  }
  return fallbackAxis(
    clamp01(score),
    [`selected source duration ${selected.toFixed(1)}s for ${target}s target`],
    score < 0.75 ? [`selected duration ratio ${ratio.toFixed(2)} may be weak for target runtime`] : [],
  );
}

function scoreSelectsNarrative(selects: SelectsCandidates): AxisScore {
  const active = selects.candidates.filter((candidate) => candidate.role !== "reject");
  const roles = new Set(active.map((candidate) => candidate.role));
  const hasBeats = active.some((c) => c.eligible_beats && c.eligible_beats.length > 0);
  const hasOpening = active.some(
    (candidate) => candidate.role === "hero" || candidate.eligible_beats?.some((beat) => /hook|opening|setup/i.test(beat)),
  );
  const hasMiddle = active.some(
    (candidate) => candidate.eligible_beats?.some((beat) => /experience|development|immersion|middle/i.test(beat)),
  );
  const hasClosing = active.some((candidate) => candidate.eligible_beats?.some((beat) => /closing|ending|payoff|release/i.test(beat)));
  const functionCount = [hasOpening, hasMiddle, hasClosing].filter(Boolean).length;
  const score = clamp01((roles.size / Math.min(4, Math.max(1, active.length))) * 0.3 + (functionCount / 3) * 0.7);
  const confidence = hasBeats ? 0.75 : 0.45;
  const evidence = [
    `${roles.size} role types represented in selects`,
    ...(hasBeats ? [`eligible_beats present on ${active.filter((c) => c.eligible_beats?.length).length}/${active.length} candidates`] : []),
    ...(hasOpening ? ["hook/opening function detected"] : []),
    ...(hasMiddle ? ["experience/development function detected"] : []),
    ...(hasClosing ? ["closing/payoff function detected"] : []),
  ];
  const gaps = [
    ...(hasOpening ? [] : ["selects do not expose a clear hook/opening candidate"]),
    ...(hasMiddle ? [] : ["selects do not expose experience/development candidates"]),
    ...(hasClosing ? [] : ["selects do not expose a clear closing/payoff candidate"]),
  ];
  return { score: round3(clamp01(score)), confidence, judge_source: "deterministic", evidence, gaps };
}

function computeStageScore(axes: Record<BriefAlignmentAxis, AxisScore>): number {
  const totalWeight = BRIEF_ALIGNMENT_AXES.reduce((total, axis) => total + AXIS_WEIGHTS[axis], 0);
  const weighted = BRIEF_ALIGNMENT_AXES.reduce(
    (total, axis) => total + axes[axis].score * AXIS_WEIGHTS[axis],
    0,
  );
  return round3(weighted / totalWeight);
}

function stageResult(axes: Record<BriefAlignmentAxis, AxisScore>): StageResult {
  return {
    score: computeStageScore(axes),
    axes,
  };
}

function mergeJudge(
  base: Record<BriefAlignmentAxis, AxisScore>,
  judge: BriefAlignmentJudgeReport | null,
): Record<BriefAlignmentAxis, AxisScore> {
  if (!judge) return base;
  const merged = { ...base };
  for (const axis of BRIEF_ALIGNMENT_AXES) {
    if (judge.axes[axis].confidence > base[axis].confidence) {
      merged[axis] = judge.axes[axis];
    }
  }
  return merged;
}

function loadSegments(projectDir: string): SelectionCoverageSegment[] {
  const filePath = path.join(projectDir, "03_analysis/segments.json");
  if (!fs.existsSync(filePath)) return [];
  const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8")) as unknown;
  const items = Array.isArray(parsed)
    ? parsed
    : Array.isArray((parsed as { items?: unknown }).items)
      ? (parsed as { items: unknown[] }).items
      : [];
  return items
    .map((item) => item as Record<string, unknown>)
    .map((item) => ({
      segment_id: String(item.segment_id ?? item.id ?? ""),
      summary: typeof item.summary === "string" ? item.summary : undefined,
    }))
    .filter((item) => item.segment_id.length > 0);
}

async function evaluateSelectsStage(
  brief: CreativeBrief,
  selects: SelectsCandidates,
  segments: SelectionCoverageSegment[],
  artifactYaml: string,
  options: EvaluateBriefAlignmentOptions,
): Promise<{ result: StageResult; notes: string[]; mustAvoidViolated: boolean; mustHaveScore: number }> {
  const avoid = scoreMustAvoidViolations(brief, selects);
  const base: Record<BriefAlignmentAxis, AxisScore> = {
    intent_message_alignment: scoreSelectsIntentMessage(brief, selects),
    must_have_coverage: await scoreMustHaveCoverageWithSemantic(brief, selects, segments),
    emotion_curve_alignment: scoreSelectsEmotionCurve(selects),
    narrative_structure: scoreSelectsNarrative(selects),
    pacing_coherence: scoreSelectsPacing(brief, selects),
    visual_variety_and_focus: scoreVisualVariety(selects, segments),
  };
  if (avoid.score === 0 && avoid.confidence >= base.intent_message_alignment.confidence) {
    base.intent_message_alignment = avoid;
  }
  const judge = options.useLlm === false
    ? null
    : await runBriefAlignmentJudge(
        { brief, stage: "selects", artifactYaml },
        options.judge,
      );
  const result = stageResult(mergeJudge(base, judge));
  return {
    result,
    notes: judge?.notes ?? [],
    mustAvoidViolated: avoid.score === 0,
    mustHaveScore: base.must_have_coverage.score,
  };
}

async function evaluateBlueprintStage(
  brief: CreativeBrief,
  blueprint: EditBlueprint,
  artifactYaml: string,
  options: EvaluateBriefAlignmentOptions,
): Promise<{ result: StageResult; notes: string[] }> {
  const narrative = scoreNarrativeStructureDeterministic(blueprint);
  const pacing = scorePacingDeterministic(brief, blueprint);
  const base: Record<BriefAlignmentAxis, AxisScore> = {
    intent_message_alignment: scoreBlueprintIntentMessage(brief, blueprint),
    must_have_coverage: fallbackAxis(
      blueprint.beats.length > 0 ? 0.7 : 0.3,
      [`${blueprint.beats.length} blueprint beats available for must_have placement`],
      blueprint.beats.length > 0 ? [] : ["blueprint has no beats to carry must_have requirements"],
    ),
    emotion_curve_alignment: scoreBlueprintEmotionCurve(brief, blueprint),
    narrative_structure: narrative,
    pacing_coherence: pacing,
    visual_variety_and_focus: fallbackAxis(
      blueprint.beats.some((beat) => beat.required_roles.length > 0) ? 0.65 : 0.45,
      [`${blueprint.beats.length} beats define role requirements`],
      blueprint.beats.some((beat) => beat.required_roles.length > 0)
        ? []
        : ["blueprint does not expose required role variety"],
    ),
  };
  const judge = options.useLlm === false
    ? null
    : await runBriefAlignmentJudge(
        { brief, stage: "blueprint", artifactYaml },
        options.judge,
      );
  const result = stageResult(mergeJudge(base, judge));
  return { result, notes: judge?.notes ?? [] };
}

export function computeBriefAlignmentComposite(stages: BriefAlignmentReport["stages"]): number {
  const parts: Array<{ value: number; weight: number }> = [];
  if (stages.selects) parts.push({ value: stages.selects.score, weight: STAGE_WEIGHTS.selects });
  if (stages.blueprint) parts.push({ value: stages.blueprint.score, weight: STAGE_WEIGHTS.blueprint });
  if (parts.length === 0) return 0;
  const totalWeight = parts.reduce((total, part) => total + part.weight, 0);
  return round3(parts.reduce((total, part) => total + part.value * part.weight, 0) / totalWeight);
}

export async function evaluateBriefAlignment(
  projectDir: string,
  options: EvaluateBriefAlignmentOptions = {},
): Promise<BriefAlignmentReport> {
  const stagesToRun = new Set(options.stages ?? ["selects", "blueprint"]);
  const briefPath = path.join(projectDir, "01_intent/creative_brief.yaml");
  const rawBrief = fs.readFileSync(briefPath, "utf-8");
  const brief = loadCreativeBrief(briefPath);
  const segments = loadSegments(projectDir);
  const notes: string[] = [];
  const stages: BriefAlignmentReport["stages"] = {};
  let mustHaveScore: number | null = null;
  let mustAvoidViolated = false;

  if (stagesToRun.has("selects")) {
    const selectsPath = path.join(projectDir, "04_plan/selects_candidates.yaml");
    if (fs.existsSync(selectsPath)) {
      const rawSelects = fs.readFileSync(selectsPath, "utf-8");
      const selects = loadSelects(selectsPath);
      const evaluated = await evaluateSelectsStage(brief, selects, segments, rawSelects, options);
      stages.selects = evaluated.result;
      notes.push(...evaluated.notes);
      mustHaveScore = evaluated.mustHaveScore;
      mustAvoidViolated = evaluated.mustAvoidViolated;
    } else {
      notes.push("selects stage skipped: 04_plan/selects_candidates.yaml not found");
    }
  }

  if (stagesToRun.has("blueprint")) {
    const blueprintPath = path.join(projectDir, "04_plan/edit_blueprint.yaml");
    if (fs.existsSync(blueprintPath)) {
      const rawBlueprint = fs.readFileSync(blueprintPath, "utf-8");
      const blueprint = loadBlueprint(blueprintPath);
      const evaluated = await evaluateBlueprintStage(brief, blueprint, rawBlueprint, options);
      stages.blueprint = evaluated.result;
      notes.push(...evaluated.notes);
    } else {
      notes.push("blueprint stage skipped: 04_plan/edit_blueprint.yaml not found");
    }
  }

  let composite = computeBriefAlignmentComposite(stages);
  if (mustHaveScore !== null && mustHaveScore < 0.5 && composite > 0.65) {
    composite = 0.65;
    notes.push("composite capped at 0.65 because selectable must_have coverage is below 0.5");
  }
  if (mustAvoidViolated && composite > 0.5) {
    composite = 0.5;
    notes.push("composite capped at 0.50 because must_avoid evidence was found");
  }

  return {
    version: "1",
    project: path.basename(path.resolve(projectDir)),
    evaluated_at: options.evaluatedAt ?? new Date().toISOString(),
    brief_hash: hashBrief(rawBrief),
    stages,
    composite: round3(composite),
    notes,
  };
}

function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

export function renderBriefAlignmentMarkdown(report: BriefAlignmentReport): string {
  const lines: string[] = [];
  lines.push("# Brief Alignment Report");
  lines.push("");
  lines.push(`- Project: ${report.project}`);
  lines.push(`- Evaluated at: ${report.evaluated_at}`);
  lines.push(`- Brief hash: ${report.brief_hash}`);
  lines.push("");
  lines.push(`## Composite: ${pct(report.composite)}`);
  lines.push("");
  for (const stageName of ["selects", "blueprint"] as const) {
    const stage = report.stages[stageName];
    if (!stage) continue;
    lines.push(`## ${stageName[0].toUpperCase()}${stageName.slice(1)} — ${pct(stage.score)}`);
    lines.push("");
    lines.push("| axis | score | confidence | source | evidence | gaps |");
    lines.push("| --- | ---: | ---: | --- | --- | --- |");
    for (const axisName of BRIEF_ALIGNMENT_AXES) {
      const axis = stage.axes[axisName];
      lines.push(
        `| ${axisName} | ${pct(axis.score)} | ${pct(axis.confidence)} | ${axis.judge_source} | ${axis.evidence.join("<br>") || "—"} | ${axis.gaps.join("<br>") || "—"} |`,
      );
    }
    lines.push("");
  }
  if (report.notes.length > 0) {
    lines.push("## Notes");
    lines.push("");
    for (const note of report.notes) lines.push(`- ${note}`);
    lines.push("");
  }
  return lines.join("\n");
}

export { buildBriefAlignmentJudgePrompt };
