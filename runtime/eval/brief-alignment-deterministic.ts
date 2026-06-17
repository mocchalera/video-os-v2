import type {
  Candidate,
  CreativeBrief,
  EditBlueprint,
  SelectsCandidates,
} from "../artifacts/types.js";
import { clamp01 } from "./matching.js";
import {
  analyzeSelectionCoverage,
  analyzeSelectionCoverageWithSemantic,
  type SelectionCoverageReport,
  type SelectionCoverageSegment,
} from "./selection-coverage.js";
import type { AxisScore } from "./brief-alignment-types.js";

const US_PER_SEC = 1_000_000;

function axis(
  score: number,
  confidence: number,
  evidence: string[],
  gaps: string[],
): AxisScore {
  return {
    score: round3(clamp01(score)),
    confidence: round3(clamp01(confidence)),
    judge_source: "deterministic",
    evidence,
    gaps,
  };
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function activeCandidates(selects: SelectsCandidates): Candidate[] {
  return selects.candidates.filter((candidate) => candidate.role !== "reject");
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map((item) => String(item)).filter((item) => item.trim().length > 0)
    : [];
}

function normalize(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function searchable(value: string): string {
  return normalize(value).replace(/[^\p{L}\p{N}]+/gu, "");
}

function textMatchesTerm(text: string, term: string): boolean {
  const normalizedText = searchable(text);
  const normalizedTerm = searchable(term);
  if (!normalizedText || !normalizedTerm) return false;
  if (normalizedText.includes(normalizedTerm)) return true;
  const tokens = normalize(term)
    .split(/[^\p{L}\p{N}]+/u)
    .map(searchable)
    .filter((token) => token.length >= 3);
  return tokens.length >= 2 && tokens.every((token) => normalizedText.includes(token));
}

function candidateText(candidate: Candidate): string {
  return [
    candidate.why_it_matches,
    ...(candidate.evidence ?? []),
    candidate.transcript_excerpt ?? "",
    ...(candidate.motif_tags ?? []),
  ].join(" ");
}

function mustAvoidTerms(brief: CreativeBrief): string[] {
  return stringArray((brief as { must_avoid?: unknown }).must_avoid);
}

function candidateDurationSec(candidate: Candidate): number {
  return Math.max(0, candidate.src_out_us - candidate.src_in_us) / US_PER_SEC;
}

export function scoreMustHaveCoverage(
  brief: CreativeBrief,
  selects: SelectsCandidates,
  segments: SelectionCoverageSegment[],
): AxisScore {
  const coverage = analyzeSelectionCoverage(selects, brief, segments);
  return scoreMustHaveCoverageReport(coverage);
}

function scoreMustHaveCoverageReport(coverage: SelectionCoverageReport): AxisScore {
  const selectable = coverage.must_have_coverage.filter((item) => item.selectable);
  const matched = selectable.filter((item) => item.matched);
  const score = selectable.length === 0 ? 1 : matched.length / selectable.length;
  const evidence = [
    `${matched.length}/${selectable.length} selectable must_have items matched`,
    `selection coverage analyzer score ${(coverage.score * 100).toFixed(1)}%`,
  ];
  const semanticMatched = matched.filter((item) => item.note.startsWith("semantic match"));
  if (semanticMatched.length > 0) {
    evidence.push(`${semanticMatched.length} must_have items matched by local semantic evidence`);
  }
  const gaps = selectable
    .filter((item) => !item.matched)
    .map((item) => `missing explicit candidate evidence for must_have: ${item.item}`);
  const productionDirectives = coverage.must_have_coverage.filter((item) => !item.selectable);
  if (productionDirectives.length > 0) {
    evidence.push(`${productionDirectives.length} production directive must_have items deferred`);
  }
  return axis(score, selectable.length === 0 ? 0.7 : 0.9, evidence, gaps);
}

export async function scoreMustHaveCoverageWithSemantic(
  brief: CreativeBrief,
  selects: SelectsCandidates,
  segments: SelectionCoverageSegment[],
): Promise<AxisScore> {
  try {
    const coverage = await analyzeSelectionCoverageWithSemantic(selects, brief, segments);
    return scoreMustHaveCoverageReport(coverage);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[brief-alignment] semantic must_have scoring failed; using text matcher (${message})`);
    return scoreMustHaveCoverage(brief, selects, segments);
  }
}

export function scoreMustAvoidViolations(
  brief: CreativeBrief,
  selects: SelectsCandidates,
): AxisScore {
  const terms = mustAvoidTerms(brief);
  const active = activeCandidates(selects);
  const violations: string[] = [];
  for (const candidate of active) {
    const text = candidateText(candidate);
    for (const term of terms) {
      if (textMatchesTerm(text, term)) {
        violations.push(`${candidate.segment_id}: ${term}`);
      }
    }
  }
  const score = violations.length === 0 ? 1 : 0;
  return axis(
    score,
    terms.length === 0 ? 0.65 : 0.9,
    violations.length === 0
      ? [`no must_avoid terms found across ${active.length} active candidates`]
      : [],
    violations.map((violation) => `must_avoid evidence found in ${violation}`),
  );
}

export function scoreVisualVariety(
  selects: SelectsCandidates,
  segments: SelectionCoverageSegment[],
): AxisScore {
  const active = activeCandidates(selects);
  if (active.length === 0) {
    return axis(0, 0.95, [], ["no active selected candidates"]);
  }

  const uniqueAssetRatio = new Set(active.map((candidate) => candidate.asset_id)).size / active.length;
  const roles = new Set(active.map((candidate) => candidate.role));
  const roleScore = clamp01(roles.size / Math.min(4, active.length));
  const clusters = new Set(
    active
      .map((candidate) => candidate.editorial_signals?.semantic_cluster_id)
      .filter((clusterId): clusterId is string => Boolean(clusterId)),
  );
  const clusterScore =
    clusters.size > 0
      ? clamp01(clusters.size / Math.min(4, active.length))
      : segments.length > 0
        ? clamp01(new Set(active.map((candidate) => candidate.segment_id)).size / Math.min(4, active.length))
        : uniqueAssetRatio;
  const heroOrSupport = active.filter(
    (candidate) => candidate.role === "hero" || candidate.role === "support" || candidate.role === "dialogue",
  ).length;
  const focusScore = heroOrSupport / active.length;
  const score = uniqueAssetRatio * 0.3 + roleScore * 0.25 + clusterScore * 0.25 + focusScore * 0.2;
  const gaps: string[] = [];
  if (uniqueAssetRatio < 0.7) gaps.push("selection repeats too few unique source assets");
  if (roles.size < Math.min(3, active.length)) gaps.push("role distribution is narrow");
  if (clusterScore < 0.5) gaps.push("cluster/segment coverage is narrow");
  if (focusScore < 0.5) gaps.push("selection leans away from focused hero/support/dialogue material");
  return axis(
    score,
    clusters.size > 0 ? 0.8 : 0.65,
    [
      `${new Set(active.map((candidate) => candidate.asset_id)).size}/${active.length} unique assets`,
      `${roles.size} active roles represented`,
      clusters.size > 0 ? `${clusters.size} semantic clusters represented` : "semantic clusters unavailable; used segment diversity fallback",
    ],
    gaps,
  );
}

export function scorePacingDeterministic(
  brief: CreativeBrief,
  blueprint: EditBlueprint,
): AxisScore {
  const target = Number(brief.project?.runtime_target_sec ?? 0);
  const policy = blueprint.duration_policy;
  const defaultTarget = Number(blueprint.pacing?.default_duration_target_sec ?? 0);
  const plannedTarget = policy?.target_duration_sec ?? defaultTarget;
  const strict = brief.project?.duration_mode === "strict" || policy?.mode === "strict";
  const tolerance = strict ? 0.08 : 0.2;
  const durationFit =
    target > 0 && plannedTarget > 0
      ? clamp01(1 - Math.max(0, Math.abs(plannedTarget - target) / target - tolerance) / (strict ? 0.25 : 0.5))
      : 0.65;
  const beatCount = blueprint.beats.length;
  const beatScore = beatCount >= 3 ? 1 : beatCount / 3;
  const policyScore = policy
    ? target > 0 && policy.min_duration_sec <= target && (policy.max_duration_sec === null || policy.max_duration_sec >= target)
      ? 1
      : 0.7
    : 0.55;
  const pacingFields = [
    blueprint.pacing?.opening_cadence,
    blueprint.pacing?.middle_cadence,
    blueprint.pacing?.ending_cadence,
  ].filter(Boolean).length;
  const cadenceScore = pacingFields / 3;
  const score = durationFit * 0.35 + beatScore * 0.2 + policyScore * 0.25 + cadenceScore * 0.2;
  const gaps: string[] = [];
  if (target > 0 && plannedTarget > 0 && durationFit < 0.8) {
    gaps.push(`planned duration ${plannedTarget}s is weakly aligned with target ${target}s`);
  }
  if (!policy) gaps.push("duration_policy is missing");
  if (beatCount < 3) gaps.push("blueprint has fewer than three beats");
  if (pacingFields < 3) gaps.push("opening/middle/ending pacing fields are incomplete");
  return axis(
    score,
    0.82,
    [
      target > 0 ? `brief target ${target}s; blueprint target ${plannedTarget || "unspecified"}s` : "brief has no runtime target",
      `${beatCount} beats planned`,
      policy ? `duration_policy mode=${policy.mode}` : "duration_policy unavailable",
    ],
    gaps,
  );
}

export function scoreNarrativeStructureDeterministic(blueprint: EditBlueprint): AxisScore {
  const roles = blueprint.beats.map((beat) => beat.story_role).filter((role): role is NonNullable<typeof role> => Boolean(role));
  const required = ["hook", "setup", "experience", "closing"] as const;
  const presentScore = required.filter((role) => roles.includes(role)).length / required.length;
  const indices = required.map((role) => roles.indexOf(role));
  const ordered =
    indices.every((index) => index >= 0) &&
    indices.every((index, i) => i === 0 || index >= indices[i - 1]);
  const sequenceScore = ordered ? 1 : presentScore * 0.6;
  const purposeScore =
    blueprint.beats.length === 0
      ? 0
      : blueprint.beats.filter((beat) => Boolean(beat.purpose || beat.notes || beat.label)).length / blueprint.beats.length;
  const arcScore = blueprint.story_arc?.summary || blueprint.story_arc?.strategy ? 1 : 0.65;
  const score = presentScore * 0.35 + sequenceScore * 0.3 + purposeScore * 0.2 + arcScore * 0.15;
  const gaps: string[] = [];
  for (const role of required) {
    if (!roles.includes(role)) gaps.push(`missing story_role: ${role}`);
  }
  if (roles.length > 0 && !ordered) gaps.push("story_role sequence is not hook -> setup -> experience -> closing");
  if (!blueprint.story_arc?.summary && !blueprint.story_arc?.strategy) gaps.push("story_arc summary/strategy is missing");
  return axis(
    score,
    0.85,
    [
      roles.length > 0 ? `story roles: ${roles.join(" -> ")}` : "no story roles declared",
      `${blueprint.beats.length} beats with ${blueprint.sequence_goals.length} sequence goals`,
    ],
    gaps,
  );
}

export function scoreSelectsIntentMessage(
  brief: CreativeBrief,
  selects: SelectsCandidates,
): AxisScore {
  const active = activeCandidates(selects);
  const messageTerms = [brief.message?.primary, ...(brief.message?.secondary ?? [])]
    .filter((value): value is string => Boolean(value))
    .join(" ");
  const matched = active.filter((candidate) => textMatchesTerm(candidateText(candidate), messageTerms)).length;
  const avoid = scoreMustAvoidViolations(brief, selects);
  const matchScore = active.length === 0 ? 0 : matched / active.length;
  const score = Math.max(avoid.score === 0 ? 0.4 : 0, matchScore * 0.75 + avoid.score * 0.25);
  return axis(
    score,
    0.55,
    [`${matched}/${active.length} active candidates mention primary/secondary message terms`],
    [
      ...(matched === 0 ? ["candidate evidence does not explicitly echo the brief message"] : []),
      ...avoid.gaps,
    ],
  );
}

export function scoreBlueprintIntentMessage(
  brief: CreativeBrief,
  blueprint: EditBlueprint,
): AxisScore {
  const haystack = [
    ...blueprint.sequence_goals,
    blueprint.story_arc?.summary ?? "",
    ...(blueprint.story_arc?.causal_links ?? []),
    ...blueprint.beats.map((beat) => [beat.label, beat.purpose ?? "", beat.notes ?? ""].join(" ")),
  ].join(" ");
  const messageTerms = [brief.message?.primary, ...(brief.message?.secondary ?? [])]
    .filter((value): value is string => Boolean(value))
    .join(" ");
  const score = messageTerms && textMatchesTerm(haystack, messageTerms) ? 0.85 : 0.55;
  return axis(
    score,
    0.55,
    score >= 0.8 ? ["blueprint text explicitly overlaps with brief message"] : ["blueprint has structural plan text"],
    score >= 0.8 ? [] : ["blueprint does not explicitly echo the brief primary/secondary message"],
  );
}

export function scoreBlueprintEmotionCurve(
  brief: CreativeBrief,
  blueprint: EditBlueprint,
): AxisScore {
  const curve = brief.emotion_curve ?? [];
  const haystack = [
    ...blueprint.sequence_goals,
    blueprint.story_arc?.summary ?? "",
    ...blueprint.beats.map((beat) => [beat.label, beat.purpose ?? "", beat.notes ?? ""].join(" ")),
  ].join(" ");
  const matched = curve.filter((item) => textMatchesTerm(haystack, item));
  const openingClosing = blueprint.beats.some((beat) => beat.story_role === "hook")
    && blueprint.beats.some((beat) => beat.story_role === "closing");
  const score = curve.length === 0 ? (openingClosing ? 0.75 : 0.6) : (matched.length / curve.length) * 0.75 + (openingClosing ? 0.25 : 0);
  return axis(
    score,
    0.55,
    [
      curve.length > 0
        ? `${matched.length}/${curve.length} emotion_curve terms appear in blueprint`
        : "brief has no emotion_curve terms",
      openingClosing ? "hook and closing beats are present" : "hook/closing pair incomplete",
    ],
    [
      ...(curve.length > 0 && matched.length < curve.length ? ["not all emotion_curve terms are explicit in blueprint"] : []),
      ...(openingClosing ? [] : ["blueprint lacks a clear opening and closing emotional container"]),
    ],
  );
}

export function scoreSelectsEmotionCurve(selects: SelectsCandidates): AxisScore {
  const active = activeCandidates(selects);
  const withSignals = active.filter((candidate) => {
    const signals = candidate.editorial_signals;
    return Boolean(
      signals?.afterglow_score
        || signals?.reaction_intensity_score
        || signals?.surprise_signal
        || signals?.hope_signal
        || signals?.peak_strength_score,
    );
  }).length;
  const heroOrDialogue = active.filter((candidate) => candidate.role === "hero" || candidate.role === "dialogue").length;
  const score = active.length === 0 ? 0 : (withSignals / active.length) * 0.5 + clamp01(heroOrDialogue / Math.max(1, Math.ceil(active.length / 3))) * 0.5;
  return axis(
    score,
    0.45,
    [`${withSignals}/${active.length} active candidates carry emotion/peak signals`],
    withSignals === 0 ? ["selects expose little deterministic emotion-curve evidence"] : [],
  );
}
