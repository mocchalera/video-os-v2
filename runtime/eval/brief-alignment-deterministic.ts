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

const MESSAGE_KEY_TERM_MATCH_THRESHOLD = 0.4;

const ENGLISH_MESSAGE_STOPWORDS = new Set([
  "a",
  "about",
  "above",
  "after",
  "again",
  "all",
  "also",
  "an",
  "and",
  "any",
  "are",
  "as",
  "at",
  "be",
  "because",
  "been",
  "being",
  "by",
  "can",
  "create",
  "creates",
  "do",
  "does",
  "for",
  "from",
  "has",
  "have",
  "in",
  "into",
  "is",
  "it",
  "its",
  "of",
  "on",
  "or",
  "our",
  "that",
  "the",
  "their",
  "there",
  "this",
  "through",
  "to",
  "with",
  "where",
  "who",
  "whose",
]);

const JAPANESE_MESSAGE_STOPWORDS = new Set([
  "から",
  "こと",
  "これ",
  "する",
  "その",
  "ため",
  "たち",
  "まで",
  "もの",
  "よう",
  "より",
]);

const MESSAGE_KEY_TERM_SYNONYMS = new Map<string, string[]>([
  ["aerial", ["drone", "wide", "scale"]],
  ["culture", ["craft", "crafts", "cultural", "traditional", "local"]],
  ["cultural", ["culture", "craft", "crafts", "traditional", "local"]],
  ["food", ["bbq", "cooking", "meal", "preparation"]],
  ["impressions", ["impression", "lasting", "memory"]],
  ["landscape", ["mountain", "mountains", "nature", "outdoor", "outdoors", "scenery"]],
  ["landscapes", ["landscape", "mountain", "mountains", "nature", "outdoor", "outdoors", "scenery"]],
  ["nature", ["landscape", "mountain", "mountains", "outdoor", "outdoors", "scenery"]],
  ["quiet", ["calm", "serene", "serenity"]],
  ["serenity", ["calm", "quiet", "serene"]],
  ["traditional", ["craft", "crafts", "culture", "cultural", "local"]],
  ["恵那", ["ena"]],
  ["戸隠", ["togakushi"]],
  ["環境", ["environment", "landscape", "nature", "outdoor", "outdoors"]],
  ["素晴らしさ", ["beauty", "scenery", "scenic"]],
  ["自然", ["landscape", "mountain", "mountains", "nature", "outdoor", "outdoors", "scenic"]],
  ["大自然", ["landscape", "mountain", "mountains", "nature", "outdoor", "outdoors", "scenic"]],
  ["山", ["mountain", "mountains"]],
  ["景色", ["landscape", "scenery"]],
  ["風景", ["landscape", "scenery"]],
  ["家族", ["family"]],
  ["子供", ["child", "children", "family", "kids"]],
  ["子供たち", ["child", "children", "family", "kids"]],
  ["成長", ["development", "grow", "growing", "growth"]],
  ["触れ合い", ["exploration", "explore", "nature", "outdoor", "play"]],
  ["キャンプ", ["camp", "campfire", "camping"]],
  ["非日常", ["adventure", "escape", "special"]],
  ["絆", ["bond", "connection", "family", "warmth"]],
  ["一歩", ["first_step", "first_steps", "step", "steps", "walking"]],
  ["一歩ずつ", ["first_step", "first_steps", "step", "steps", "walking"]],
  ["確実", ["confidence", "confident", "persistence", "steady"]],
  ["小さな", ["early", "infant", "small", "toddler"]],
  ["小さな足", ["first_steps", "steps", "walking"]],
  ["足", ["steps", "walking"]],
  ["刻んだ", ["growth", "journey", "story"]],
  ["年間", ["years"]],
  ["物語", ["arc", "journey", "narrative", "story"]],
  ["歩ける", ["first_steps", "walk", "walking"]],
  ["歩き", ["first_steps", "walk", "walking"]],
  ["喜び", ["celebration", "excited", "joy", "joyful"]],
  ["走れる", ["run", "running"]],
  ["走り", ["run", "running"]],
  ["自信", ["confidence", "confident"]],
  ["ストライダー", ["balance_bike", "balancebike", "strider"]],
  ["バランス", ["balance", "balance_bike", "balancebike"]],
  ["覚え", ["learn", "learning", "practice"]],
  ["日々", ["days", "journey", "period", "practice"]],
  ["自転車", ["bicycle", "bike", "ride", "riding"]],
  ["乗れた", ["mastered", "ride", "riding", "success", "successful"]],
  ["瞬間", ["climax", "moment", "peak"]],
  ["達成感", ["achievement", "breakthrough", "payoff", "success"]],
  ["親子", ["family", "parent_child", "parentchild"]],
  ["温かい", ["intimate", "warm", "warmth"]],
  ["温か", ["intimate", "warm", "warmth"]],
]);

type WordSegment = { segment: string; isWordLike?: boolean };
type WordSegmenter = { segment(input: string): Iterable<WordSegment> };
type WordSegmenterConstructor = new (
  locales?: string | string[],
  options?: { granularity: "word" },
) => WordSegmenter;

function hasCjk(value: string): boolean {
  return /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(value);
}

function wordLikeSegments(value: string): string[] {
  const Segmenter = (Intl as unknown as { Segmenter?: WordSegmenterConstructor }).Segmenter;
  if (Segmenter) {
    const locale = hasCjk(value) ? "ja" : "en";
    const segmenter = new Segmenter(locale, { granularity: "word" });
    return Array.from(segmenter.segment(value))
      .filter((part) => part.isWordLike !== false)
      .map((part) => part.segment);
  }
  return normalize(value).split(/[^\p{L}\p{N}]+/u);
}

function messagePhraseFragments(value: string): string[] {
  return normalize(value).split(
    /[\s、。，．・:：;；,."'“”‘’!?！？()[\]{}<>「」『』【】\-_/]+|では|から|まで|より|なった|なる|する|した|して|の|と|が|を|に|で|は|も|へ|や/u,
  );
}

function isMessageStopword(term: string): boolean {
  const compact = searchable(term);
  return ENGLISH_MESSAGE_STOPWORDS.has(compact) || JAPANESE_MESSAGE_STOPWORDS.has(compact);
}

function extractKeyTerms(value: string): string[] {
  const seen = new Set<string>();
  const terms: string[] = [];
  const rawTerms = [...wordLikeSegments(value), ...messagePhraseFragments(value)];

  for (const raw of rawTerms) {
    const term = normalize(raw);
    const compact = searchable(term);
    if (!compact || seen.has(compact) || isMessageStopword(term)) continue;
    const minLength = hasCjk(term) ? 2 : 3;
    if (compact.length < minLength) continue;
    seen.add(compact);
    terms.push(term);
  }

  return terms;
}

function keyTermVariants(term: string): string[] {
  const variants = new Set<string>();
  const compact = searchable(term);
  if (!compact) return [];
  variants.add(compact);

  if (/^[a-z0-9]+$/u.test(compact)) {
    if (compact.endsWith("ies") && compact.length > 4) {
      variants.add(`${compact.slice(0, -3)}y`);
    }
    if (compact.endsWith("es") && compact.length > 4) {
      variants.add(compact.slice(0, -2));
    }
    if (compact.endsWith("s") && compact.length > 3) {
      variants.add(compact.slice(0, -1));
    }
    if (compact.endsWith("ing") && compact.length > 5) {
      variants.add(compact.slice(0, -3));
    }
    if (compact.endsWith("ed") && compact.length > 4) {
      variants.add(compact.slice(0, -2));
    }
  }

  if (hasCjk(compact) && compact.endsWith("たち") && compact.length > 2) {
    variants.add(compact.slice(0, -2));
  }
  for (const synonym of MESSAGE_KEY_TERM_SYNONYMS.get(compact) ?? []) {
    const searchableSynonym = searchable(synonym);
    if (searchableSynonym) variants.add(searchableSynonym);
  }

  return [...variants];
}

function messageMatchesPool(message: string, searchablePool: string): boolean {
  const keyTerms = extractKeyTerms(message);
  if (keyTerms.length === 0) return textMatchesTerm(searchablePool, message);
  const found = keyTerms.filter((term) =>
    keyTermVariants(term).some((variant) => searchablePool.includes(variant)),
  );
  return found.length >= Math.ceil(keyTerms.length * MESSAGE_KEY_TERM_MATCH_THRESHOLD);
}

function briefMessageItems(brief: CreativeBrief): string[] {
  return [brief.message?.primary, ...(brief.message?.secondary ?? [])]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0);
}

function candidateText(candidate: Candidate): string {
  return [
    candidate.why_it_matches,
    ...(candidate.evidence ?? []),
    candidate.transcript_excerpt ?? "",
    ...(candidate.motif_tags ?? []),
  ].join(" ");
}

function candidateIntentMessageText(candidate: Candidate): string {
  return [
    candidateText(candidate),
    ...(candidate.eligible_beats ?? []),
    candidate.editorial_signals?.semantic_cluster_id ?? "",
    candidate.editorial_signals?.peak_type ?? "",
    ...(candidate.editorial_signals?.visual_tags ?? []),
    ...(candidate.peak_signals?.speech_keyword ?? []),
  ].join(" ");
}

const EMOTION_CURVE_SYNONYMS = new Map<string, string[]>([
  ["awe", ["wonder"]],
  ["calm", ["serene", "serenity"]],
  ["discover", ["discovery", "explore", "exploration"]],
  ["discovery", ["discover", "explore", "exploration"]],
  ["exploration", ["discover", "discovery", "explore"]],
  ["explore", ["discover", "discovery", "exploration"]],
  ["immerse", ["immersion", "immersive"]],
  ["immersion", ["immerse", "immersive"]],
  ["immersive", ["immerse", "immersion"]],
  ["serene", ["calm", "serenity"]],
  ["serenity", ["calm", "serene"]],
  ["warm", ["warmth"]],
  ["warmth", ["warm"]],
  ["wonder", ["awe"]],
  ["驚き", ["awe", "surprise", "wonder"]],
  ["温か", ["intimate", "warm", "warmth"]],
  ["温かい", ["intimate", "warm", "warmth"]],
  ["温かさ", ["intimate", "warm", "warmth"]],
  ["静けさ", ["calm", "quiet", "serene", "serenity"]],
  ["発見", ["discover", "discovery", "explore", "exploration"]],
  ["没入", ["immerse", "immersion", "immersive"]],
]);

function emotionCurveVariants(term: string): string[] {
  const variants = new Set<string>();
  const compact = searchable(term);
  if (!compact) return [];
  variants.add(term);
  for (const synonym of EMOTION_CURVE_SYNONYMS.get(compact) ?? []) {
    variants.add(synonym);
  }
  return [...variants];
}

function textMatchesEmotionCurveTerm(text: string, term: string): boolean {
  return emotionCurveVariants(term).some((variant) => textMatchesTerm(text, variant));
}

function candidateEmotionCurveText(candidate: Candidate): string {
  return [
    ...(candidate.eligible_beats ?? []),
    ...(candidate.motif_tags ?? []),
    ...(candidate.evidence ?? []),
    candidate.why_it_matches,
  ].join(" ");
}

function blueprintIntentMessageText(blueprint: EditBlueprint): string {
  return [
    ...blueprint.sequence_goals,
    blueprint.story_arc?.summary ?? "",
    blueprint.story_arc?.strategy ?? "",
    blueprint.story_arc?.chronology_bias ?? "",
    ...(blueprint.story_arc?.causal_links ?? []),
    ...blueprint.beats.map((beat) =>
      [
        beat.label,
        beat.purpose ?? "",
        beat.notes ?? "",
        beat.story_role ?? "",
        ...(beat.skill_hints ?? []),
        ...beat.required_roles,
        ...(beat.preferred_roles ?? []),
      ].join(" "),
    ),
    blueprint.pacing.opening_cadence,
    blueprint.pacing.middle_cadence,
    blueprint.pacing.ending_cadence,
    blueprint.pacing.confirmed_preferences?.structure_choice ?? "",
    blueprint.pacing.confirmed_preferences?.pacing_notes ?? "",
    blueprint.music_policy.permitted_energy_curve ?? "",
    ...(blueprint.dialogue_policy.prioritize_lines ?? []),
    blueprint.ending_policy?.should_feel ?? "",
    blueprint.ending_policy?.final_line_strategy ?? "",
    blueprint.ending_policy?.final_visual_strategy ?? "",
    blueprint.ending_policy?.final_audio_strategy ?? "",
    ...(blueprint.rejection_rules ?? []),
    ...(blueprint.active_editing_skills ?? []),
    blueprint.resolved_profile?.rationale ?? "",
    blueprint.resolved_policy?.rationale ?? "",
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
  const messages = briefMessageItems(brief);
  if (messages.length === 0) return axis(0.5, 0.5, ["no brief message defined"], []);
  if (active.length === 0) return axis(0, 0.9, [], ["no active candidates"]);

  const pool = searchable(active.map((candidate) => candidateIntentMessageText(candidate)).join(" "));
  const matched = messages.filter((message) => messageMatchesPool(message, pool));
  const avoid = scoreMustAvoidViolations(brief, selects);
  const matchScore = matched.length / messages.length;
  const score = Math.max(avoid.score === 0 ? 0.4 : 0, matchScore * 0.75 + avoid.score * 0.25);
  return axis(
    score,
    0.55,
    [`${matched.length}/${messages.length} brief message items represented across active candidates`],
    [
      ...(matched.length === 0 ? ["candidate evidence does not explicitly represent the brief message"] : []),
      ...(matched.length < messages.length ? ["not all brief message items are represented by active candidate evidence"] : []),
      ...avoid.gaps,
    ],
  );
}

export function scoreBlueprintIntentMessage(
  brief: CreativeBrief,
  blueprint: EditBlueprint,
): AxisScore {
  const messages = briefMessageItems(brief);
  if (messages.length === 0) return axis(0.5, 0.5, ["no brief message defined"], []);

  const searchableHaystack = searchable(blueprintIntentMessageText(blueprint));
  const matched = messages.filter((message) => messageMatchesPool(message, searchableHaystack));
  const score = matched.length / messages.length;
  return axis(
    score,
    0.55,
    [`${matched.length}/${messages.length} brief message items represented in blueprint text`],
    matched.length === messages.length
      ? []
      : ["blueprint does not explicitly represent every brief primary/secondary message"],
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

function hasEditorialEmotionSignal(candidate: Candidate): boolean {
  const signals = candidate.editorial_signals;
  return Boolean(
    signals?.afterglow_score
      || signals?.reaction_intensity_score
      || signals?.surprise_signal
      || signals?.hope_signal
      || signals?.peak_strength_score,
  );
}

function scoreSelectsEmotionCurveLegacy(selects: SelectsCandidates): AxisScore {
  const active = activeCandidates(selects);
  const withSignals = active.filter(hasEditorialEmotionSignal).length;
  const heroOrDialogue = active.filter((candidate) => candidate.role === "hero" || candidate.role === "dialogue").length;
  const score = active.length === 0 ? 0 : (withSignals / active.length) * 0.5 + clamp01(heroOrDialogue / Math.max(1, Math.ceil(active.length / 3))) * 0.5;
  return axis(
    score,
    0.45,
    [`${withSignals}/${active.length} active candidates carry emotion/peak signals`],
    withSignals === 0 ? ["selects expose little deterministic emotion-curve evidence"] : [],
  );
}

export function scoreSelectsEmotionCurve(
  brief: CreativeBrief,
  selects: SelectsCandidates,
): AxisScore;
export function scoreSelectsEmotionCurve(selects: SelectsCandidates): AxisScore;
export function scoreSelectsEmotionCurve(
  briefOrSelects: CreativeBrief | SelectsCandidates,
  maybeSelects?: SelectsCandidates,
): AxisScore {
  if (!maybeSelects) {
    return scoreSelectsEmotionCurveLegacy(briefOrSelects as SelectsCandidates);
  }

  const brief = briefOrSelects as CreativeBrief;
  const selects = maybeSelects;
  const active = activeCandidates(selects);
  if (active.length === 0) {
    return axis(0, 0.45, [], ["no active selected candidates"]);
  }

  const curve = stringArray(brief.emotion_curve);
  const searchableText = active.map(candidateEmotionCurveText).join(" ");
  const matched = curve.filter((term) => textMatchesEmotionCurveTerm(searchableText, term));
  const withSignals = active.filter(hasEditorialEmotionSignal).length;
  const withEligibleBeats = active.filter((candidate) => (candidate.eligible_beats ?? []).length > 0).length;

  const emotionCurveCoverage = curve.length === 0 ? 0.5 : matched.length / curve.length;
  const editorialSignalsPresence = withSignals / active.length;
  const eligibleBeatsRichness = withEligibleBeats / active.length;
  const score =
    emotionCurveCoverage * 0.6
    + editorialSignalsPresence * 0.2
    + eligibleBeatsRichness * 0.2;

  return axis(
    score,
    withEligibleBeats > 0 ? 0.7 : 0.45,
    [
      curve.length > 0
        ? `${matched.length}/${curve.length} brief emotion_curve terms found in candidate beats/evidence`
        : "brief has no emotion_curve terms",
      `${withSignals}/${active.length} active candidates carry emotion/peak signals`,
      `${withEligibleBeats}/${active.length} active candidates carry eligible_beats`,
    ],
    [
      ...(curve.length > 0 && matched.length < curve.length
        ? [`missing emotion_curve evidence for: ${curve.filter((term) => !matched.includes(term)).join(", ")}`]
        : []),
      ...(withSignals === 0 ? ["selects expose little deterministic emotion/peak signal data"] : []),
      ...(withEligibleBeats === 0 ? ["eligible_beats are missing from active candidates"] : []),
    ],
  );
}
