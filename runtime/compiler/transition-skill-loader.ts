// Transition Skill Card loader
// Loads P0/P1 JSON skill cards from runtime/editorial/transition-skills/.
// Validates against schema. Deterministic, cached.

import * as fs from "node:fs";
import * as path from "node:path";
import type { TransitionSkillCard, PairEvidence, Predicate, PredicateGroup, MurchWeights, MurchAxisScores } from "./transition-types.js";

// ── Loader ──────────────────────────────────────────────────────────

const TRANSITION_SKILLS_DIR = path.resolve(
  import.meta.url ? path.dirname(new URL(import.meta.url).pathname) : __dirname,
  "../editorial/transition-skills",
);

let cardCache: Map<string, TransitionSkillCard> | null = null;

export function loadTransitionSkillCards(dir?: string): Map<string, TransitionSkillCard> {
  if (cardCache && !dir) return cardCache;
  const skillDir = dir ?? TRANSITION_SKILLS_DIR;
  const map = new Map<string, TransitionSkillCard>();
  if (!fs.existsSync(skillDir)) return map;
  for (const file of fs.readdirSync(skillDir).sort()) {
    if (!file.endsWith(".json")) continue;
    const raw = fs.readFileSync(path.join(skillDir, file), "utf-8");
    const card = JSON.parse(raw) as TransitionSkillCard;
    if (card.id) {
      map.set(card.id, card);
    }
  }
  if (!dir) cardCache = map;
  return map;
}

export function clearTransitionSkillCache(): void {
  cardCache = null;
}

/**
 * Get P0 cards that are active (intersection of transition cards and active_editing_skills).
 * Sorted by id for determinism.
 */
export function getActiveTransitionCards(
  activeEditingSkills: string[],
  phase?: "p0" | "p1",
  dir?: string,
): TransitionSkillCard[] {
  const allCards = loadTransitionSkillCards(dir);
  const activeSet = new Set(activeEditingSkills);
  const result: TransitionSkillCard[] = [];
  for (const [id, card] of allCards) {
    if (!activeSet.has(id)) continue;
    if (phase && card.phase !== phase) continue;
    result.push(card);
  }
  result.sort((a, b) => a.id.localeCompare(b.id));
  return result;
}

// ── Threshold resolution ────────────────────────────────────────────

/**
 * resolveSkillThreshold: returns card.min_score_threshold if present,
 * otherwise defaults to 0.3, clamped to [0, 1].
 */
export function resolveSkillThreshold(card: TransitionSkillCard): number {
  const raw = card.min_score_threshold ?? 0.3;
  return Math.max(0, Math.min(1, raw));
}

// ── Predicate Evaluator ─────────────────────────────────────────────

function getNestedValue(obj: Record<string, unknown>, pathStr: string): unknown {
  const parts = pathStr.split(".");
  let current: unknown = obj;
  for (const part of parts) {
    if (current === null || current === undefined || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function evaluatePredicate(pred: Predicate, evidence: PairEvidence): boolean {
  const val = getNestedValue(evidence as unknown as Record<string, unknown>, pred.path);
  if (val === undefined || val === null) return false;

  switch (pred.op) {
    case "eq": return val === pred.value;
    case "neq": return val !== pred.value;
    case "gt": return typeof val === "number" && val > (pred.value as number);
    case "gte": return typeof val === "number" && val >= (pred.value as number);
    case "lt": return typeof val === "number" && val < (pred.value as number);
    case "lte": return typeof val === "number" && val <= (pred.value as number);
    case "in": return Array.isArray(pred.value) && pred.value.includes(val as string);
    case "contains":
      return Array.isArray(val) && typeof pred.value === "string" && val.includes(pred.value);
    default: return false;
  }
}

export function evaluatePredicateGroup(group: PredicateGroup, evidence: PairEvidence): boolean {
  if (group.all && group.all.length > 0) {
    if (!group.all.every(p => evaluatePredicate(p, evidence))) return false;
  }
  if (group.any && group.any.length > 0) {
    if (!group.any.some(p => evaluatePredicate(p, evidence))) return false;
  }
  // If neither all nor any is specified, the group passes
  return true;
}

// ── Murch Axis Score Resolution ─────────────────────────────────────

const NEUTRAL = 0.5;

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

/**
 * resolveEffectivePeakType: determine pair-level effective peak.
 * Returns { effective_peak_strength_score, effective_peak_type }.
 */
export function resolveEffectivePeakType(evidence: Pick<PairEvidence,
  "left_peak_strength_score" | "right_peak_strength_score" |
  "left_peak_type" | "right_peak_type"
>): { effective_peak_strength_score: number; effective_peak_type?: PairEvidence["effective_peak_type"] } {
  const left = evidence.left_peak_strength_score ?? 0;
  const right = evidence.right_peak_strength_score ?? 0;
  const maxScore = Math.max(left, right);

  let peakType: PairEvidence["effective_peak_type"] | undefined;
  if (left >= right) {
    peakType = evidence.left_peak_type ?? evidence.right_peak_type;
  } else {
    peakType = evidence.right_peak_type ?? evidence.left_peak_type;
  }

  return { effective_peak_strength_score: maxScore, effective_peak_type: peakType };
}

/**
 * resolveEmotionAxisScore: compute the emotion axis score from PairEvidence.
 */
export function resolveEmotionAxisScore(evidence: PairEvidence): number {
  const baseScore =
    0.45 * evidence.outgoing_afterglow_score +
    0.35 * evidence.incoming_reaction_score +
    0.20 * evidence.energy_delta_score;

  const peakTypeBonus =
    evidence.effective_peak_type === "emotional_peak" ? 0.20 :
    evidence.effective_peak_type === "action_peak" ? 0.12 :
    evidence.effective_peak_type === "visual_peak" ? 0.08 :
    0.0;

  return clamp01(baseScore * (1 + evidence.effective_peak_strength_score * peakTypeBonus));
}

/**
 * resolveAxisBreakReadiness: compute axis break readiness from PairEvidence.
 */
export function resolveAxisBreakReadiness(evidence: PairEvidence): number {
  const base =
    0.50 * evidence.energy_delta_score +
    0.30 * evidence.effective_peak_strength_score +
    0.20 * Number(evidence.semantic_cluster_change);

  const typeMultiplier =
    evidence.effective_peak_type === "action_peak" ? 1.00 :
    evidence.effective_peak_type === "emotional_peak" ? 0.85 :
    evidence.effective_peak_type === "visual_peak" ? 0.75 :
    0.70;

  const durationModeMultiplier = evidence.duration_mode === "strict" ? 0.85 : 1.0;

  return clamp01(base * typeMultiplier * durationModeMultiplier);
}

/**
 * resolveSetupPayoff: compute setup-payoff relation score.
 */
export function resolveSetupPayoff(evidence: PairEvidence): number {
  if (!evidence.left_story_role && !evidence.right_story_role) return 0.5;

  const isSetup = evidence.left_story_role === "hook" || evidence.left_story_role === "setup";
  const isPayoff = evidence.right_story_role === "experience" || evidence.right_story_role === "closing";

  if (isSetup && isPayoff && evidence.semantic_cluster_change && evidence.motif_overlap_score >= 0.35) {
    return 1.0;
  }
  if (isSetup && isPayoff) return 0.7;
  if (isSetup || isPayoff) return 0.4;
  return 0.2;
}

/**
 * resolveCompositionMatch: compare shot_scale, composition_anchor, screen_side.
 */
export function resolveCompositionMatch(
  leftComposition: { shot_scale?: string; composition_anchor?: string; screen_side?: string },
  rightComposition: { shot_scale?: string; composition_anchor?: string; screen_side?: string },
): number {
  let matches = 0;
  let total = 0;
  if (leftComposition.shot_scale && rightComposition.shot_scale) {
    total++;
    if (leftComposition.shot_scale === rightComposition.shot_scale) matches++;
  }
  if (leftComposition.composition_anchor && rightComposition.composition_anchor) {
    total++;
    if (leftComposition.composition_anchor === rightComposition.composition_anchor) matches++;
  }
  if (leftComposition.screen_side && rightComposition.screen_side) {
    total++;
    if (leftComposition.screen_side === rightComposition.screen_side) matches++;
  }
  return total > 0 ? matches / total : NEUTRAL;
}

/**
 * resolveShotScaleContinuity: compare shot_scale between adjacent clips.
 * Returns higher score when shot scales are identical or adjacent,
 * lower when they jump (e.g., extreme_close → wide).
 */
export function resolveShotScaleContinuity(
  leftShotScale?: string,
  rightShotScale?: string,
): number {
  if (!leftShotScale || !rightShotScale || leftShotScale === "unknown" || rightShotScale === "unknown") {
    return NEUTRAL;
  }
  if (leftShotScale === rightShotScale) return 0.9;

  const scaleOrder: string[] = [
    "extreme_close", "close", "medium_close", "medium",
    "medium_wide", "wide", "extreme_wide",
  ];
  const leftIdx = scaleOrder.indexOf(leftShotScale);
  const rightIdx = scaleOrder.indexOf(rightShotScale);
  if (leftIdx < 0 || rightIdx < 0) return NEUTRAL;

  const jump = Math.abs(leftIdx - rightIdx);
  // Adjacent scales = good continuity, larger jumps = lower
  if (jump === 1) return 0.7;
  if (jump === 2) return 0.5;
  if (jump === 3) return 0.35;
  return 0.2;
}

/**
 * resolveCadenceFit: compute cadence fit score for a pair.
 * P0 implementation uses clip duration vs beat target as a proxy for pacing match,
 * outgoing_silence_ratio, and BGM snap distance as penalty.
 *
 * When resolved_profile pacing cadence is unavailable, uses duration ratio as proxy.
 * Logs a fallback note via the returned diagnostics flag.
 */
export function resolveCadenceFit(
  leftClipDurationFrames: number,
  leftBeatTargetFrames: number | undefined,
  outgoingSilenceRatio: number,
  bgmSnapDistanceFrames: number | undefined,
  snapToleranceFrames: number,
): { score: number; usedFallback: boolean } {
  let usedFallback = false;

  // Duration match: how well does clip duration match the beat target?
  let durationMatch = NEUTRAL;
  if (leftBeatTargetFrames && leftBeatTargetFrames > 0 && leftClipDurationFrames > 0) {
    const ratio = leftClipDurationFrames / leftBeatTargetFrames;
    // Perfect match = 1.0, deviation penalized
    durationMatch = clamp01(1.0 - Math.abs(1.0 - ratio) * 0.8);
  } else {
    usedFallback = true;
  }

  // Silence contribution: moderate silence is rhythmically good
  const silenceContrib = outgoingSilenceRatio >= 0.05 && outgoingSilenceRatio <= 0.4
    ? 0.6 + 0.4 * (1 - Math.abs(outgoingSilenceRatio - 0.15) / 0.25)
    : clamp01(0.4 - outgoingSilenceRatio * 0.5);

  // BGM snap penalty: closer to beat = better cadence
  let bgmContrib = NEUTRAL;
  if (bgmSnapDistanceFrames !== undefined && snapToleranceFrames > 0) {
    bgmContrib = clamp01(1.0 - bgmSnapDistanceFrames / snapToleranceFrames);
  }

  const score = clamp01(
    0.40 * durationMatch +
    0.30 * silenceContrib +
    0.30 * bgmContrib,
  );

  return { score, usedFallback };
}

/**
 * resolveAxisConsistency: continuity of camera_axis, screen_side, and gaze_direction.
 * When both camera_axis and screen_side differ simultaneously, the score is low
 * unless axis_break_readiness_score is high (indicating a justified break).
 */
export function resolveAxisConsistency(
  leftFeatures: { screen_side?: string; gaze_direction?: string; camera_axis?: string },
  rightFeatures: { screen_side?: string; gaze_direction?: string; camera_axis?: string },
  axisBreakReadinessScore?: number,
): number {
  const axisSame = leftFeatures.camera_axis && rightFeatures.camera_axis &&
    leftFeatures.camera_axis === rightFeatures.camera_axis;
  const sideSame = leftFeatures.screen_side && rightFeatures.screen_side &&
    leftFeatures.screen_side === rightFeatures.screen_side;
  const gazeSame = leftFeatures.gaze_direction && rightFeatures.gaze_direction &&
    leftFeatures.gaze_direction === rightFeatures.gaze_direction;

  // Both same axis and side = high consistency
  if (axisSame && sideSame) return gazeSame ? 0.95 : 0.9;
  // One matches = moderate
  if (axisSame || sideSame) return gazeSame ? 0.65 : 0.6;
  // Both differ simultaneously = potential axis break
  if (leftFeatures.camera_axis && rightFeatures.camera_axis &&
      leftFeatures.screen_side && rightFeatures.screen_side) {
    // If axis break readiness is high, the break is justified → moderate score
    const readiness = axisBreakReadinessScore ?? 0;
    if (readiness >= 0.7) return 0.45;
    if (readiness >= 0.5) return 0.35;
    return 0.2;
  }
  return NEUTRAL;
}

/**
 * Resolve all Murch axis scores from PairEvidence.
 */
export function resolveAxisScores(evidence: PairEvidence): MurchAxisScores {
  const emotion = resolveEmotionAxisScore(evidence);

  const story =
    0.40 * Number(evidence.semantic_cluster_change) +
    0.30 * evidence.motif_overlap_score +
    0.30 * evidence.setup_payoff_relation_score;

  const bgmComponent = evidence.bgm_snap_distance_frames !== undefined
    ? clamp01(1 - evidence.bgm_snap_distance_frames / 12)
    : 0.5;
  const rhythm =
    0.35 * evidence.outgoing_silence_ratio +
    0.35 * evidence.cadence_fit_score +
    0.30 * bgmComponent;

  const eye_trace =
    0.50 * evidence.visual_tag_overlap_score +
    0.50 * evidence.motion_continuity_score;

  const plane_2d =
    0.50 * (evidence.shot_scale_continuity_score ?? NEUTRAL) +
    0.50 * (evidence.composition_match_score ?? NEUTRAL);
  const space_3d =
    0.50 * (evidence.axis_consistency_score ?? NEUTRAL) +
    0.50 * (evidence.axis_break_readiness_score ?? NEUTRAL);

  return {
    emotion: clamp01(emotion),
    story: clamp01(story),
    rhythm: clamp01(rhythm),
    eye_trace: clamp01(eye_trace),
    plane_2d: clamp01(plane_2d),
    space_3d: clamp01(space_3d),
  };
}

/**
 * Compute Murch weighted score for a skill card given axis scores.
 */
export function computeMurchScore(
  weights: MurchWeights,
  axisScores: MurchAxisScores,
): number {
  return (
    weights.emotion * axisScores.emotion +
    weights.story * axisScores.story +
    weights.rhythm * axisScores.rhythm +
    weights.eye_trace * axisScores.eye_trace +
    weights.plane_2d * axisScores.plane_2d +
    weights.space_3d * axisScores.space_3d
  );
}
