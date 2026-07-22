// Phase 2: Candidate Scoring
// Deterministic scoring of each candidate against each beat.
// No LLM calls. No randomness.

import type {
  Candidate,
  DurationPolicy,
  EditBlueprint,
  NormalizedBeat,
  NormalizedData,
  RankedCandidateTable,
  ScoredCandidate,
  ScoringParams,
  StillDurationPolicy,
} from "./types.js";
import { getSkillScoreAdjustment } from "../editorial/skill-registry.js";
import type { BgmSection } from "./transition-types.js";
import type { BeatEvent } from "../media/bgm-analyzer.js";
import { getCandidateRef } from "./candidate-ref.js";
import { resolveStillImageHold } from "../artifacts/still-image-policy.js";

// ── BGM-aware scoring context ───────────────────────────────────────

export interface BgmScoringContext {
  /** Downbeat timestamps in seconds. */
  downbeats_sec: number[];
  /** BGM sections with energy and labels. */
  sections: BgmSection[];
  /** Beat events with per-beat onset strength (optional). */
  beats?: BeatEvent[];
  /** Frames per second for time conversion. */
  fpsNum: number;
}

// ── Peak Salience Bonus ─────────────────────────────────────────────
// Per vlm-peak-detection-design.md §11.2

const BEAT_STORY_ROLE_WEIGHT: Record<string, number> = {
  hook: 1.00,
  experience: 0.85,
  closing: 0.70,
  setup: 0.45,
};

const PLAN_PRIMARY_BONUS = 2.5;
const PLAN_FALLBACK_BONUS = 0.75;
const EXACT_ELIGIBLE_BEAT_BONUS = 0.35;
const TEXTUAL_ELIGIBLE_BEAT_BONUS = 0.15;
const GENERIC_BEAT_PENALTY = 0.25;

const PEAK_TYPE_MATCH: Record<string, Record<string, number>> = {
  action_peak: { hero: 1.00, support: 1.00, transition: 0.55, texture: 0.55, dialogue: 0.55 },
  emotional_peak: { dialogue: 1.00, hero: 1.00, support: 0.55, transition: 0.55, texture: 0.55 },
  visual_peak: { support: 1.00, transition: 1.00, texture: 1.00, hero: 0.55, dialogue: 0.55 },
};

/**
 * Compute candidate-specific peak salience bonus.
 * Returns 0 if the candidate has no peak editorial signals.
 */
export function computePeakSalienceBonus(
  candidate: Candidate,
  beat: NormalizedBeat,
): number {
  const signals = candidate.editorial_signals;
  if (!signals?.peak_strength_score) return 0;

  const peakStrength = signals.peak_strength_score;
  const storyRole = beat.story_role ?? "experience";
  const storyRoleWeight = BEAT_STORY_ROLE_WEIGHT[storyRole] ?? 0.60;

  const peakType = signals.peak_type ?? "visual_peak";
  const candidateRole = candidate.role === "reject" ? "support" : candidate.role;
  const typeMatchWeight = PEAK_TYPE_MATCH[peakType]?.[candidateRole] ?? 0.55;

  return peakStrength * storyRoleWeight * typeMatchWeight;
}

export function computePeakPriorityBonus(candidate: Candidate): number {
  const signals = candidate.peak_signals;
  if (!signals) return 0;

  const motion = clamp01(signals.motion ?? 0);
  const audio = clamp01(signals.audio_rms ?? 0);
  const speech = Math.min(1, (signals.speech_keyword?.length ?? 0) / 3);
  const strongestSignal = Math.max(motion, audio, speech);

  if (strongestSignal <= 0) return 0;

  const roleWeight = candidate.role === "hero"
    ? 1
    : candidate.role === "support" || candidate.role === "dialogue"
    ? 0.8
    : 0.45;

  return Number((0.35 * strongestSignal * roleWeight).toFixed(3));
}

export function scoreCandidates(
  normalized: NormalizedData,
  candidates: Candidate[],
  params: ScoringParams,
  fpsNum: number,
  fpsDen: number,
  activeSkills?: string[],
  durationPolicy?: DurationPolicy,
  bgmContext?: BgmScoringContext,
  stillDurationPolicy?: StillDurationPolicy,
): RankedCandidateTable {
  const usPerFrame = (1_000_000 * fpsDen) / fpsNum;
  const nonReject = candidates.filter((c) => c.role !== "reject");

  function candidateMatchesBeat(eligibleBeats: string[], beat: NormalizedBeat): boolean {
    if (eligibleBeats.includes(beat.beat_id)) return true;
    const beatText = [beat.label, beat.purpose].filter(Boolean).join(" ").toLowerCase();
    return eligibleBeats.some((eb) => beatText.includes(eb.toLowerCase()));
  }

  function candidatePlanPriority(candidate: Candidate, beat: NormalizedBeat): "primary" | "fallback" | undefined {
    const plan = beat.candidate_plan;
    if (!plan) return undefined;
    const candidateRefs = new Set([getCandidateRef(candidate), candidate.segment_id]);
    if (plan.primary_candidate_ref && candidateRefs.has(plan.primary_candidate_ref)) {
      return "primary";
    }
    if ((plan.fallback_candidate_refs ?? []).some((ref) => candidateRefs.has(ref))) {
      return "fallback";
    }
    return undefined;
  }

  // Pre-compute global motif usage counts for reuse penalty
  const motifCounts = new Map<string, number>();
  for (const c of nonReject) {
    for (const tag of c.motif_tags ?? []) {
      motifCounts.set(tag, (motifCounts.get(tag) ?? 0) + 1);
    }
  }

  // Pre-compute per-beat asset sets for adjacency penalty.
  // For each beat, track which asset_ids are eligible so we can penalize
  // candidates whose asset also appears in adjacent beats.
  const beatAssetSets = new Map<string, Set<string>>();
  for (const beat of normalized.beats) {
    const assets = new Set<string>();
    for (const c of nonReject) {
      const isPlanned = candidatePlanPriority(c, beat) !== undefined;
      if (
        !isPlanned &&
        c.eligible_beats &&
        c.eligible_beats.length > 0 &&
        !candidateMatchesBeat(c.eligible_beats, beat)
      ) continue;
      assets.add(c.asset_id);
    }
    beatAssetSets.set(beat.beat_id, assets);
  }

  // Build ordered beat list for adjacency lookups
  const beatOrder = normalized.beats.map((b) => b.beat_id);

  const table: RankedCandidateTable = new Map();

  for (const beat of normalized.beats) {
    const scored: ScoredCandidate[] = [];

    for (const candidate of nonReject) {
      const planPriority = candidatePlanPriority(candidate, beat);
      const isPlanned = planPriority !== undefined;
      if (
        !isPlanned &&
        candidate.eligible_beats &&
        candidate.eligible_beats.length > 0 &&
        !candidateMatchesBeat(candidate.eligible_beats, beat)
      ) {
        continue;
      }

      // Skip if candidate's role is not required or preferred for this beat
      const isRequired = beat.required_roles.includes(candidate.role as typeof beat.required_roles[number]);
      const isPreferred = beat.preferred_roles.includes(candidate.role as typeof beat.preferred_roles[number]);
      // candidate_plan is an explicit authored placement decision. Keep it
      // eligible even when the beat's broader role rubric would exclude that
      // occurrence (for example, a support cutaway inside a hero-led hook).
      if (!isPlanned && !isRequired && !isPreferred) {
        continue;
      }

      // Compute adjacency: if this candidate's asset appears in adjacent beats,
      // it risks back-to-back same-asset usage.
      const beatIdx = beatOrder.indexOf(beat.beat_id);
      let adjacentAssetOverlap = 0;
      for (const offset of [-1, 1]) {
        const adjIdx = beatIdx + offset;
        if (adjIdx >= 0 && adjIdx < beatOrder.length) {
          const adjAssets = beatAssetSets.get(beatOrder[adjIdx]);
          if (adjAssets?.has(candidate.asset_id)) {
            adjacentAssetOverlap++;
          }
        }
      }

      const entry = scoreCandidate(
        candidate,
        beat,
        params,
        usPerFrame,
        motifCounts,
        adjacentAssetOverlap,
        activeSkills,
        durationPolicy,
        bgmContext,
        planPriority,
        computeBeatMatchAdjustment(candidate, beat),
        stillDurationPolicy,
      );
      scored.push(entry);
    }

    // Stable sort: by score descending, tiebreak by segment_id ascending
    scored.sort((a, b) => {
      const diff = b.score - a.score;
      if (diff !== 0) return diff;
      return a.candidate.segment_id.localeCompare(b.candidate.segment_id);
    });

    table.set(beat.beat_id, scored);
  }

  return table;
}

function scoreCandidate(
  candidate: Candidate,
  beat: NormalizedBeat,
  params: ScoringParams,
  usPerFrame: number,
  motifCounts: Map<string, number>,
  adjacentAssetOverlap: number,
  activeSkills?: string[],
  durationPolicy?: DurationPolicy,
  bgmContext?: BgmScoringContext,
  planPriority?: "primary" | "fallback",
  beatMatchAdjustment?: BeatMatchAdjustment,
  stillDurationPolicy?: StillDurationPolicy,
): ScoredCandidate {
  // 1. Semantic rank score: higher rank (lower number) → higher score
  //    Normalize: 1.0 for rank 1, decaying. Use 1 / rank.
  const rank = candidate.semantic_rank ?? 999;
  const semanticRankScore = 1.0 / rank;

  // 2. Quality flag penalty
  const flagCount = candidate.quality_flags?.length ?? 0;
  const qualityPenalty = flagCount * params.quality_flag_penalty;

  // 3. Duration fit: how well the candidate's duration matches the beat's target
  const targetFrames = beat.target_duration_frames;
  const scoreCandidateStill = {
    still_image: planPriority === "primary"
      ? beat.candidate_plan?.still_image ?? candidate.still_image
      : candidate.still_image,
  };
  const unconstrainedStill = candidate.media_kind === "image" && stillDurationPolicy
    ? resolveStillImageHold(scoreCandidateStill, stillDurationPolicy, stillDurationPolicy.max_hold_frames)
    : undefined;
  const candidateDurationFrames = unconstrainedStill
    ? targetFrames < unconstrainedStill.min_hold_frames
      ? unconstrainedStill.min_hold_frames
      : resolveStillImageHold(scoreCandidateStill, stillDurationPolicy!, targetFrames).hold_frames
    : (candidate.src_out_us - candidate.src_in_us) / usPerFrame;
  const durationDiff = Math.abs(candidateDurationFrames - targetFrames);

  let durationFitScore: number;
  if (durationDiff <= params.duration_fit_tolerance_frames) {
    durationFitScore = 1.0;
  } else if (durationDiff <= params.beat_alignment_tolerance_frames) {
    // Linear decay from 1.0 to 0.5
    const range = params.beat_alignment_tolerance_frames - params.duration_fit_tolerance_frames;
    const excess = durationDiff - params.duration_fit_tolerance_frames;
    durationFitScore = 1.0 - 0.5 * (excess / range);
  } else {
    // Further decay, minimum 0.1
    const excess = durationDiff - params.beat_alignment_tolerance_frames;
    durationFitScore = Math.max(0.1, 0.5 - 0.01 * excess);
  }

  // 4. Motif reuse penalty: penalize candidates whose motif tags are overused
  let motifReusePenalty = 0;
  for (const tag of candidate.motif_tags ?? []) {
    const count = motifCounts.get(tag) ?? 0;
    if (count > params.motif_reuse_max) {
      motifReusePenalty += 0.05 * (count - params.motif_reuse_max);
    }
  }

  // 5. Adjacency penalty: penalize candidates whose asset appears in
  //    adjacent beats, as they risk back-to-back same-asset usage.
  //    Assembly may apply additional sequential adjustments.
  const adjacencyPenalty = adjacentAssetOverlap * params.adjacency_penalty;

  // 6. Skill adjustment: bonus/penalty from active editing skills
  const skillAdjustment = activeSkills && activeSkills.length > 0
    ? getSkillScoreAdjustment(activeSkills, candidate, beat.purpose)
    : 0;

  // 7. Peak salience bonus: candidate-specific, per design doc §11.2
  const peakSalienceBonus = computePeakSalienceBonus(candidate, beat);

  // 7.5. Peak priority bonus: explicit selects_candidates peak_signals
  // must be strong enough to reorder candidates toward the top.
  const peakPriorityBonus = computePeakPriorityBonus(candidate);

  // 8. BGM downbeat proximity bonus + chorus-peak priority
  const bgmBonus = bgmContext
    ? computeBgmBonus(candidate, beat, bgmContext, usPerFrame, candidateDurationFrames)
    : 0;

  // 8.5. Beat plan and explicit eligible-beat matching.
  // Candidate plans are authored downstream intent; exact eligible_beats are
  // source-selection intent. Both should beat generic candidates, but neither
  // is a hard filter.
  const planPriorityBonus = planPriority === "primary"
    ? PLAN_PRIMARY_BONUS
    : planPriority === "fallback"
    ? PLAN_FALLBACK_BONUS
    : 0;
  const beatMatchBonus = beatMatchAdjustment?.bonus ?? 0;
  const genericBeatPenalty = beatMatchAdjustment?.genericPenalty ?? 0;

  // 9. Duration mode adjustments
  //    - guide: duration fit is soft bonus (weight 0.15 instead of 0.3)
  //    - guide: peak-protected candidates get a duration_fit floor of 0.5
  //    - strict: unchanged (full 0.3 weight)
  const isGuide = durationPolicy?.mode === "guide";

  let effectiveDurationFitScore = durationFitScore;
  if (isGuide) {
    const isPeakProtected =
      (candidate.editorial_signals?.peak_strength_score != null &&
        candidate.editorial_signals.peak_strength_score >= 0.55) ||
      candidate.trim_hint?.peak_ref != null;
    if (isPeakProtected) {
      effectiveDurationFitScore = Math.max(durationFitScore, 0.5);
    }
  }

  const durationWeight = isGuide ? 0.15 : 0.3;
  const semanticWeight = isGuide ? 0.55 : 0.4;

  // Final score: weighted sum
  const score =
    semanticRankScore * semanticWeight +
    effectiveDurationFitScore * durationWeight -
    qualityPenalty -
    motifReusePenalty -
    adjacencyPenalty +
    skillAdjustment +
    peakSalienceBonus +
    peakPriorityBonus +
    bgmBonus +
    planPriorityBonus +
    beatMatchBonus -
    genericBeatPenalty;

  return {
    candidate,
    beat_id: beat.beat_id,
    score,
    breakdown: {
      semantic_rank_score: semanticRankScore,
      quality_penalty: qualityPenalty,
      duration_fit_score: durationFitScore,
      motif_reuse_penalty: motifReusePenalty,
      adjacency_penalty: adjacencyPenalty,
      peak_salience_bonus: peakSalienceBonus,
      peak_priority_bonus: peakPriorityBonus,
      bgm_bonus: bgmBonus,
      plan_priority_bonus: planPriorityBonus,
      beat_match_bonus: beatMatchBonus,
      generic_beat_penalty: genericBeatPenalty,
    },
  };
}

interface BeatMatchAdjustment {
  bonus: number;
  genericPenalty: number;
}

function computeBeatMatchAdjustment(candidate: Candidate, beat: NormalizedBeat): BeatMatchAdjustment {
  const eligibleBeats = candidate.eligible_beats ?? [];
  if (eligibleBeats.length === 0) {
    return { bonus: 0, genericPenalty: GENERIC_BEAT_PENALTY };
  }
  if (eligibleBeats.includes(beat.beat_id)) {
    return { bonus: EXACT_ELIGIBLE_BEAT_BONUS, genericPenalty: 0 };
  }
  const beatText = [beat.label, beat.purpose].filter(Boolean).join(" ").toLowerCase();
  if (eligibleBeats.some((eligibleBeat) => beatText.includes(eligibleBeat.toLowerCase()))) {
    return { bonus: TEXTUAL_ELIGIBLE_BEAT_BONUS, genericPenalty: 0 };
  }
  return { bonus: 0, genericPenalty: 0 };
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

// ── BGM Downbeat Proximity Bonus + Chorus-Peak Priority ─────────────
//
// Two bonuses for BGM-synchronized editing:
//
// 1. Downbeat proximity bonus:
//    If the clip's cut point (start of the beat in timeline) lands near a downbeat,
//    the candidate gets a bonus. This encourages cuts on musical downbeats.
//    Max bonus: 0.12 (within 2 frames), decaying to 0 at 8 frames distance.
//
// 2. Chorus-peak priority:
//    If the beat falls within a "chorus" section AND the candidate has peak signals,
//    the candidate gets an additional bonus. This ensures peak material lands in
//    musically intense sections.
//    Max bonus: 0.10

const DOWNBEAT_BONUS_MAX = 0.12;
const DOWNBEAT_TOLERANCE_FRAMES = 8;
const CHORUS_PEAK_BONUS = 0.10;

/**
 * Compute BGM-aware scoring bonus for a candidate.
 * Returns the sum of downbeat proximity bonus and chorus-peak priority bonus.
 */
export function computeBgmBonus(
  candidate: Candidate,
  beat: NormalizedBeat,
  bgm: BgmScoringContext,
  usPerFrame: number,
  resolvedDurationFrames?: number,
): number {
  let bonus = 0;

  // ── Downbeat proximity bonus ────────────────────────────────────
  // Estimate the clip's cut point in seconds from its timeline position.
  // We use the beat's target_duration_frames to estimate where this beat
  // starts in the timeline (accumulated from prior beats), but since we
  // don't have the exact timeline_in_frame here, we approximate using
  // the candidate's source timing against downbeat grid.
  if (bgm.downbeats_sec.length > 0) {
    const durationFrames = resolvedDurationFrames ?? (candidate.media_kind === "image"
      ? beat.target_duration_frames
      : (candidate.src_out_us - candidate.src_in_us) / usPerFrame);
    const candidateDurationSec = durationFrames * usPerFrame / 1_000_000;

    // Find the nearest downbeat to the beat's target duration
    // (in practice, the assembler will snap to downbeats, but scoring
    //  provides the preference signal)
    const beatDurationSec = beat.target_duration_frames * usPerFrame / 1_000_000;
    let minDistFrames = Infinity;

    for (const db of bgm.downbeats_sec) {
      // Check if the candidate's duration aligns with a downbeat interval
      const distSec = Math.abs(candidateDurationSec - beatDurationSec);
      // Also check if the downbeat falls near a beat boundary
      const modSec = candidateDurationSec > 0
        ? db % candidateDurationSec
        : db;
      const distToGrid = Math.min(modSec, candidateDurationSec - modSec);
      const distFrames = distToGrid * bgm.fpsNum;
      if (distFrames < minDistFrames) {
        minDistFrames = distFrames;
      }
    }

    if (minDistFrames <= DOWNBEAT_TOLERANCE_FRAMES) {
      // Linear decay: full bonus at 0 frames, 0 at DOWNBEAT_TOLERANCE_FRAMES
      bonus += DOWNBEAT_BONUS_MAX * (1 - minDistFrames / DOWNBEAT_TOLERANCE_FRAMES);
    }
  }

  // ── Chorus-peak priority bonus ──────────────────────────────────
  // If the candidate has peak signals and the beat's timing falls within
  // a chorus section, boost the candidate.
  if (bgm.sections.length > 0) {
    const hasPeakSignal = candidate.editorial_signals?.peak_strength_score != null &&
      candidate.editorial_signals.peak_strength_score >= 0.3;

    if (hasPeakSignal) {
      // Check if any chorus section overlaps with this beat's approximate timeline position
      const isChorusBeat = bgm.sections.some((s) =>
        s.label === "chorus" && s.energy >= 0.7
      );

      // For story_role = "hook" or "experience" beats in chorus sections,
      // peak candidates get a stronger boost
      if (isChorusBeat) {
        const storyRole = beat.story_role ?? "experience";
        const roleMultiplier = storyRole === "hook" || storyRole === "experience" ? 1.0 : 0.5;
        bonus += CHORUS_PEAK_BONUS * roleMultiplier * (candidate.editorial_signals!.peak_strength_score!);
      }
    }
  }

  return Math.round(bonus * 1000) / 1000;
}
