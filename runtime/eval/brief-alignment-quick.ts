import type { Candidate, CreativeBrief, SelectsCandidates } from "../artifacts/types.js";
import type { SegmentItem } from "../agents/triage-enrichment.js";
import {
  scoreMustHaveCoverage,
  scoreMustHaveCoverageWithSemantic,
  scoreSelectsEmotionCurve,
  scoreVisualVariety,
} from "./brief-alignment-deterministic.js";
import type { BriefAlignmentAxis } from "./brief-alignment-types.js";
import {
  analyzeSelectionCoverage,
  analyzeSelectionCoverageWithSemantic,
  type SelectionCoverageReport,
} from "./selection-coverage.js";

export interface BriefAlignmentQuickResult {
  score: number;
  gaps: BriefAlignmentGap[];
  passed: boolean;
}

export interface BriefAlignmentGap {
  axis: string;
  score: number;
  feedback: string;
}

const DEFAULT_THRESHOLDS: Partial<Record<BriefAlignmentAxis, number>> = {
  must_have_coverage: 0.9,
  emotion_curve_alignment: 0.8,
  narrative_structure: 0.5,
  visual_variety_and_focus: 0.6,
};

const QUICK_AXES = [
  "must_have_coverage",
  "emotion_curve_alignment",
  "narrative_structure",
  "visual_variety_and_focus",
] as const satisfies BriefAlignmentAxis[];

export function quickBriefAlignmentCheck(
  brief: CreativeBrief,
  selects: SelectsCandidates,
  segments: SegmentItem[],
  thresholds?: Partial<Record<BriefAlignmentAxis, number>>,
): BriefAlignmentQuickResult {
  const active = activeCandidates(selects);
  const resolvedThresholds = { ...DEFAULT_THRESHOLDS, ...thresholds };
  const axisScores: Record<(typeof QUICK_AXES)[number], number> = {
    must_have_coverage: scoreMustHaveCoverage(brief, selects, segments).score,
    emotion_curve_alignment: scoreSelectsEmotionCurve(brief, selects).score,
    narrative_structure: scoreNarrativeStructure(active),
    visual_variety_and_focus: scoreVisualVariety(selects, segments).score,
  };

  const gaps: BriefAlignmentGap[] = [
    ...minimumCutCountGaps(brief, active),
    ...mustHaveGaps(brief, selects, segments, axisScores.must_have_coverage, resolvedThresholds.must_have_coverage),
    ...emotionGaps(active, axisScores.emotion_curve_alignment, resolvedThresholds.emotion_curve_alignment),
    ...narrativeGaps(active, axisScores.narrative_structure, resolvedThresholds.narrative_structure),
    ...visualVarietyGaps(active, axisScores.visual_variety_and_focus, resolvedThresholds.visual_variety_and_focus),
  ];

  const score = round3(QUICK_AXES.reduce((total, axis) => total + axisScores[axis], 0) / QUICK_AXES.length);
  return {
    score,
    gaps,
    passed: gaps.length === 0,
  };
}

export async function quickBriefAlignmentCheckWithSemantic(
  brief: CreativeBrief,
  selects: SelectsCandidates,
  segments: SegmentItem[],
  thresholds?: Partial<Record<BriefAlignmentAxis, number>>,
): Promise<BriefAlignmentQuickResult> {
  const active = activeCandidates(selects);
  const resolvedThresholds = { ...DEFAULT_THRESHOLDS, ...thresholds };
  const mustHaveAxis = await scoreMustHaveCoverageWithSemantic(brief, selects, segments);
  const axisScores: Record<(typeof QUICK_AXES)[number], number> = {
    must_have_coverage: mustHaveAxis.score,
    emotion_curve_alignment: scoreSelectsEmotionCurve(brief, selects).score,
    narrative_structure: scoreNarrativeStructure(active),
    visual_variety_and_focus: scoreVisualVariety(selects, segments).score,
  };
  const mustHaveCoverage =
    axisScores.must_have_coverage < (resolvedThresholds.must_have_coverage ?? 0)
      ? await analyzeSelectionCoverageWithSemantic(selects, brief, segments)
      : null;

  const gaps: BriefAlignmentGap[] = [
    ...minimumCutCountGaps(brief, active),
    ...(mustHaveCoverage
      ? mustHaveGapsFromCoverage(mustHaveCoverage, axisScores.must_have_coverage, resolvedThresholds.must_have_coverage)
      : []),
    ...emotionGaps(active, axisScores.emotion_curve_alignment, resolvedThresholds.emotion_curve_alignment),
    ...narrativeGaps(active, axisScores.narrative_structure, resolvedThresholds.narrative_structure),
    ...visualVarietyGaps(active, axisScores.visual_variety_and_focus, resolvedThresholds.visual_variety_and_focus),
  ];

  const score = round3(QUICK_AXES.reduce((total, axis) => total + axisScores[axis], 0) / QUICK_AXES.length);
  return {
    score,
    gaps,
    passed: gaps.length === 0,
  };
}

function activeCandidates(selects: SelectsCandidates): Candidate[] {
  return selects.candidates.filter((candidate) => candidate.role !== "reject");
}

function minimumCutCountGaps(brief: CreativeBrief, active: Candidate[]): BriefAlignmentGap[] {
  const targetSec = Number(brief.project?.runtime_target_sec ?? 0);
  const MIN_CUT_DURATION_SEC = 5;
  const MAX_CUT_DURATION_SEC = 8;
  const minCutCount = targetSec > 0 ? Math.ceil(targetSec / MAX_CUT_DURATION_SEC) : 0;
  const idealCutCount = targetSec > 0 ? Math.ceil(targetSec / MIN_CUT_DURATION_SEC) : 0;
  if (minCutCount === 0 || active.length >= minCutCount) return [];
  return [
    {
      axis: "minimum_cut_count",
      score: idealCutCount > 0 ? round3(active.length / idealCutCount) : 0,
      feedback: `only ${active.length} candidates for a ${targetSec}s target -- need at least ${minCutCount} clips (avg 5-8s/cut). Select more diverse clips.`,
    },
  ];
}

function mustHaveGaps(
  brief: CreativeBrief,
  selects: SelectsCandidates,
  segments: SegmentItem[],
  score: number,
  threshold = 0,
): BriefAlignmentGap[] {
  if (score >= threshold) return [];
  const coverage = analyzeSelectionCoverage(selects, brief, segments);
  return mustHaveGapsFromCoverage(coverage, score, threshold);
}

function mustHaveGapsFromCoverage(
  coverage: SelectionCoverageReport,
  score: number,
  threshold = 0,
): BriefAlignmentGap[] {
  if (score >= threshold) return [];
  return coverage.must_have_coverage
    .filter((item) => item.selectable && !item.matched)
    .map((item) => ({
      axis: "must_have_coverage",
      score,
      feedback: `must_have '${item.item}' has no matching candidate evidence`,
    }));
}

function emotionGaps(
  active: Candidate[],
  score: number,
  threshold = 0,
): BriefAlignmentGap[] {
  if (score >= threshold) return [];
  const withSignals = active.filter(hasEmotionOrPeakSignal).length;
  return [
    {
      axis: "emotion_curve_alignment",
      score,
      feedback: `${withSignals}/${active.length} candidates carry emotion/peak signals -- add candidates with peak_analysis data`,
    },
  ];
}

function narrativeGaps(
  active: Candidate[],
  score: number,
  threshold = 0,
): BriefAlignmentGap[] {
  if (score >= threshold) return [];
  const feedback: string[] = [];
  if (!hasStoryFunction(active, ["hook", "opening", "setup"])) {
    feedback.push("no candidates with hook/setup story function -- add a clear opening candidate");
  }
  if (!hasStoryFunction(active, ["experience", "middle", "development"])) {
    feedback.push("no candidates with experience/development story function -- add a middle story candidate");
  }
  if (!hasStoryFunction(active, ["closing", "payoff", "ending", "release"])) {
    feedback.push("no candidates with closing/payoff story function -- add a clear ending candidate");
  }
  return (feedback.length > 0 ? feedback : ["story functions are unclear -- add hook, experience, and closing/payoff candidates"])
    .map((item) => ({
      axis: "narrative_structure",
      score,
      feedback: item,
    }));
}

function visualVarietyGaps(
  active: Candidate[],
  score: number,
  threshold = 0,
): BriefAlignmentGap[] {
  if (score >= threshold) return [];
  const clusterCount = uniqueSemanticClusterCount(active);
  const roleCount = new Set(active.map((candidate) => candidate.role)).size;
  const feedback =
    clusterCount > 0
      ? `only ${clusterCount} unique semantic clusters -- increase visual diversity across scene types`
      : `only ${roleCount} active roles and no semantic clusters -- increase visual diversity across scene types`;
  return [
    {
      axis: "visual_variety_and_focus",
      score,
      feedback,
    },
  ];
}

function scoreNarrativeStructure(active: Candidate[]): number {
  if (active.length === 0) return 0;
  const required: string[][] = [
    ["hook", "opening", "setup"],
    ["experience", "middle", "development"],
    ["closing", "payoff", "ending", "release"],
  ];
  const present = required.map((terms) => hasStoryFunction(active, terms));
  const baseScore = present.filter(Boolean).length / required.length;
  const hasClosing = present[2];
  return round3(hasClosing ? baseScore : Math.min(baseScore, 0.45));
}

function hasStoryFunction(active: Candidate[], terms: string[]): boolean {
  return active.some((candidate) => {
    const audioStoryRefs = (candidate as { audio_story_refs?: Array<{ role?: string }> }).audio_story_refs ?? [];
    const searchable = [
      candidate.why_it_matches,
      candidate.story_role,
      candidate.transcript_excerpt,
      ...(candidate.evidence ?? []),
      ...(candidate.eligible_beats ?? []),
      ...(candidate.motif_tags ?? []),
      ...audioStoryRefs.map((ref) => ref.role ?? ""),
    ].join(" ").toLowerCase();
    return terms.some((term) => searchable.includes(term));
  });
}

function hasEmotionOrPeakSignal(candidate: Candidate): boolean {
  const signals = candidate.editorial_signals;
  return Boolean(
    signals?.afterglow_score
      || signals?.reaction_intensity_score
      || signals?.surprise_signal
      || signals?.hope_signal
      || signals?.peak_strength_score
      || candidate.peak_signals?.motion
      || candidate.peak_signals?.audio_rms
      || candidate.peak_signals?.speech_keyword?.length,
  );
}

function uniqueSemanticClusterCount(active: Candidate[]): number {
  return new Set(
    active
      .map((candidate) => candidate.editorial_signals?.semantic_cluster_id)
      .filter((clusterId): clusterId is string => Boolean(clusterId)),
  ).size;
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}
