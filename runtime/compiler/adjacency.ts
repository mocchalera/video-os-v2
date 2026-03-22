// Adjacency Analyzer
// Analyzes adjacent clip pairs on V1 and selects transition skills.
// Pure, deterministic. No LLM calls.

import * as fs from "node:fs";
import * as path from "node:path";
import type { Candidate, NormalizedBeat, TimelineClip, Track } from "./types.js";
import type {
  TransitionSkillCard,
  PairEvidence,
  AdjacencyPairResult,
  AdjacencyAnalysis,
  TimelineTransition,
  TransitionType,
  BgmAnalysis,
  AdjacencyFeatures,
  PeakType,
} from "./transition-types.js";
import {
  getActiveTransitionCards,
  evaluatePredicateGroup,
  resolveSkillThreshold,
  resolveAxisScores,
  computeMurchScore,
  resolveEffectivePeakType,
  resolveSetupPayoff,
  resolveCompositionMatch,
  resolveAxisConsistency,
  resolveAxisBreakReadiness,
} from "./transition-skill-loader.js";

// ── PairEvidence construction ───────────────────────────────────────

interface SegmentEvidence {
  adjacency_features?: AdjacencyFeatures;
  peak_moments?: Array<{ type?: string }>;
  support_signals?: { fused_peak_score?: number };
}

function jaccard(a: string[], b: string[]): number {
  if (a.length === 0 && b.length === 0) return 0;
  const setA = new Set(a);
  const setB = new Set(b);
  let intersection = 0;
  for (const item of setA) {
    if (setB.has(item)) intersection++;
  }
  const union = setA.size + setB.size - intersection;
  return union > 0 ? intersection / union : 0;
}

function motionContinuity(leftMotion?: string, rightMotion?: string): number {
  if (!leftMotion || !rightMotion) return 0.5;
  if (leftMotion === rightMotion) return 0.9;
  // Similar motion families
  const similar = new Map<string, string[]>([
    ["pan", ["tilt", "tracking"]],
    ["tilt", ["pan", "tracking"]],
    ["tracking", ["pan", "tilt", "handheld"]],
    ["push_in", ["pull_out", "reveal"]],
    ["pull_out", ["push_in", "reveal"]],
    ["static", []],
    ["handheld", ["tracking"]],
    ["fast_action", []],
    ["reveal", ["push_in", "pull_out"]],
  ]);
  const family = similar.get(leftMotion);
  if (family && family.includes(rightMotion)) return 0.6;
  return 0.3;
}

export function buildPairEvidence(
  leftClip: TimelineClip,
  rightClip: TimelineClip,
  leftCandidate: Candidate | undefined,
  rightCandidate: Candidate | undefined,
  leftBeat: NormalizedBeat | undefined,
  rightBeat: NormalizedBeat | undefined,
  leftSegEvidence: SegmentEvidence | undefined,
  rightSegEvidence: SegmentEvidence | undefined,
  durationMode: "strict" | "guide",
  bgmSnapDistanceFrames?: number,
): PairEvidence {
  const leftSignals = leftCandidate?.editorial_signals;
  const rightSignals = rightCandidate?.editorial_signals;

  const leftAdj = leftSegEvidence?.adjacency_features;
  const rightAdj = rightSegEvidence?.adjacency_features;

  // Visual tag overlap
  const leftTags = leftAdj?.visual_tags ?? leftSignals?.visual_tags ?? [];
  const rightTags = rightAdj?.visual_tags ?? rightSignals?.visual_tags ?? [];
  const visualTagOverlapScore = jaccard(leftTags, rightTags);

  // Motion continuity
  const motionContinuityScore = motionContinuity(leftAdj?.motion_type, rightAdj?.motion_type);

  // Semantic cluster change
  const leftCluster = leftSignals?.semantic_cluster_id;
  const rightCluster = rightSignals?.semantic_cluster_id;
  const semanticClusterChange = !!(leftCluster && rightCluster && leftCluster !== rightCluster);

  // Motif overlap
  const leftMotifs = leftCandidate?.motif_tags ?? [];
  const rightMotifs = rightCandidate?.motif_tags ?? [];
  const motifOverlapScore = jaccard(leftMotifs, rightMotifs);

  // Peak strength and type
  const leftPeakStrength = leftSignals?.peak_strength_score ??
    leftSegEvidence?.support_signals?.fused_peak_score ?? 0;
  const rightPeakStrength = rightSignals?.peak_strength_score ??
    rightSegEvidence?.support_signals?.fused_peak_score ?? 0;
  const leftPeakType = (leftSignals?.peak_type ??
    leftSegEvidence?.peak_moments?.[0]?.type) as PeakType | undefined;
  const rightPeakType = (rightSignals?.peak_type ??
    rightSegEvidence?.peak_moments?.[0]?.type) as PeakType | undefined;

  const { effective_peak_strength_score, effective_peak_type } = resolveEffectivePeakType({
    left_peak_strength_score: leftPeakStrength,
    right_peak_strength_score: rightPeakStrength,
    left_peak_type: leftPeakType,
    right_peak_type: rightPeakType,
  });

  // Energy delta (positive = incoming is higher energy)
  const leftEnergy = leftSignals?.speech_intensity_score ?? leftSignals?.audio_energy_score ?? 0.5;
  const rightEnergy = rightSignals?.speech_intensity_score ?? rightSignals?.audio_energy_score ?? 0.5;
  const energyDeltaScore = Math.max(0, Math.min(1, (rightEnergy - leftEnergy + 1) / 2));

  // Silence and afterglow
  const outgoingSilenceRatio = leftSignals?.silence_ratio ?? 0;
  const outgoingAfterglowScore = leftSignals?.afterglow_score ?? 0;
  const incomingReactionScore = rightSignals?.reaction_intensity_score ?? 0;

  // Story roles
  const leftStoryRole = leftBeat?.story_role;
  const rightStoryRole = rightBeat?.story_role;

  // Composition match
  const compositionMatchScore = resolveCompositionMatch(
    { shot_scale: leftAdj?.shot_scale, composition_anchor: leftAdj?.composition_anchor, screen_side: leftAdj?.screen_side },
    { shot_scale: rightAdj?.shot_scale, composition_anchor: rightAdj?.composition_anchor, screen_side: rightAdj?.screen_side },
  );

  // Axis consistency
  const axisConsistencyScore = resolveAxisConsistency(
    { screen_side: leftAdj?.screen_side, gaze_direction: leftAdj?.gaze_direction, camera_axis: leftAdj?.camera_axis },
    { screen_side: rightAdj?.screen_side, gaze_direction: rightAdj?.gaze_direction, camera_axis: rightAdj?.camera_axis },
  );

  // Cadence fit (simplified for P0)
  const cadenceFitScore = 0.5;

  // Setup/payoff
  const partialEvidence = {
    left_story_role: leftStoryRole,
    right_story_role: rightStoryRole,
    semantic_cluster_change: semanticClusterChange,
    motif_overlap_score: motifOverlapScore,
  } as PairEvidence;
  const setupPayoffRelationScore = resolveSetupPayoff(partialEvidence);

  // Same asset
  const sameAsset = leftClip.asset_id === rightClip.asset_id;
  const sameSpeakerRole = !!(leftCandidate?.speaker_role && rightCandidate?.speaker_role &&
    leftCandidate.speaker_role === rightCandidate.speaker_role);

  // B-roll candidate
  const hasBRollCandidate = !!(leftCandidate?.role === "support" || leftCandidate?.role === "texture" ||
    rightCandidate?.role === "support" || rightCandidate?.role === "texture");

  // Build partial evidence for axis break readiness computation
  const partialForAxis: PairEvidence = {
    left_candidate_ref: leftCandidate?.candidate_id ?? leftClip.clip_id,
    right_candidate_ref: rightCandidate?.candidate_id ?? rightClip.clip_id,
    same_asset: sameAsset,
    same_speaker_role: sameSpeakerRole,
    semantic_cluster_change: semanticClusterChange,
    motif_overlap_score: motifOverlapScore,
    setup_payoff_relation_score: setupPayoffRelationScore,
    visual_tag_overlap_score: visualTagOverlapScore,
    motion_continuity_score: motionContinuityScore,
    cadence_fit_score: cadenceFitScore,
    shot_scale_continuity_score: compositionMatchScore,
    composition_match_score: compositionMatchScore,
    axis_consistency_score: axisConsistencyScore,
    axis_break_readiness_score: 0, // placeholder
    energy_delta_score: energyDeltaScore,
    outgoing_silence_ratio: outgoingSilenceRatio,
    outgoing_afterglow_score: outgoingAfterglowScore,
    incoming_reaction_score: incomingReactionScore,
    left_peak_strength_score: leftPeakStrength,
    right_peak_strength_score: rightPeakStrength,
    effective_peak_strength_score,
    left_peak_type: leftPeakType,
    right_peak_type: rightPeakType,
    effective_peak_type,
    left_story_role: leftStoryRole,
    right_story_role: rightStoryRole,
    has_b_roll_candidate: hasBRollCandidate,
    same_asset_gap_us: sameAsset ? Math.abs(rightClip.src_in_us - leftClip.src_out_us) : undefined,
    bgm_snap_distance_frames: bgmSnapDistanceFrames,
    duration_mode: durationMode,
  };

  partialForAxis.axis_break_readiness_score = resolveAxisBreakReadiness(partialForAxis);

  return partialForAxis;
}

// ── Adjacency Decide ────────────────────────────────────────────────

export interface AdjacencyDecideOptions {
  activeEditingSkills: string[];
  durationMode: "strict" | "guide";
  fpsNum: number;
  bgmAnalysis?: BgmAnalysis;
  candidates: Candidate[];
  beats: NormalizedBeat[];
  segmentEvidenceIndex?: Map<string, SegmentEvidence>;
  transitionSkillsDir?: string;
}

/**
 * Find the closest beat/downbeat in the BGM grid to a given frame position.
 * Returns distance in frames, or undefined if no BGM analysis available.
 */
function findBgmSnapDistance(
  cutFramePos: number,
  fpsNum: number,
  bgmAnalysis?: BgmAnalysis,
): number | undefined {
  if (!bgmAnalysis || bgmAnalysis.analysis_status !== "ready") return undefined;

  const cutSec = cutFramePos / fpsNum;
  let minDist = Infinity;

  // Check beats
  for (const beatSec of bgmAnalysis.beats_sec) {
    const dist = Math.abs(beatSec - cutSec);
    if (dist < minDist) minDist = dist;
  }
  // Check downbeats (higher priority, but we just want distance here)
  for (const dbSec of bgmAnalysis.downbeats_sec) {
    const dist = Math.abs(dbSec - cutSec);
    if (dist < minDist) minDist = dist;
  }

  return minDist === Infinity ? undefined : Math.round(minDist * fpsNum);
}

/**
 * Find the closest beat or downbeat snap target for a cut frame.
 * Returns { target_sec, target_frame, is_downbeat } or undefined.
 */
export function findBeatSnapTarget(
  cutFramePos: number,
  fpsNum: number,
  bgmAnalysis: BgmAnalysis | undefined,
  preferDownbeat: boolean,
  snapToleranceFrames: number,
): { target_sec: number; target_frame: number; is_downbeat: boolean; delta_frames: number } | undefined {
  if (!bgmAnalysis || bgmAnalysis.analysis_status !== "ready") return undefined;

  const cutSec = cutFramePos / fpsNum;
  let bestTarget: { sec: number; isDownbeat: boolean } | undefined;
  let bestDist = Infinity;

  // Check downbeats first if preferred
  if (preferDownbeat) {
    for (const dbSec of bgmAnalysis.downbeats_sec) {
      const dist = Math.abs(dbSec - cutSec);
      if (dist < bestDist) {
        bestDist = dist;
        bestTarget = { sec: dbSec, isDownbeat: true };
      }
    }
  }

  // Check all beats
  for (const beatSec of bgmAnalysis.beats_sec) {
    const dist = Math.abs(beatSec - cutSec);
    if (dist < bestDist) {
      bestDist = dist;
      bestTarget = { sec: beatSec, isDownbeat: false };
    }
  }

  // Also check downbeats if not preferred (they still count as beats)
  if (!preferDownbeat) {
    for (const dbSec of bgmAnalysis.downbeats_sec) {
      const dist = Math.abs(dbSec - cutSec);
      if (dist < bestDist) {
        bestDist = dist;
        bestTarget = { sec: dbSec, isDownbeat: true };
      }
    }
  }

  if (!bestTarget) return undefined;

  const targetFrame = Math.round(bestTarget.sec * fpsNum);
  const deltaFrames = targetFrame - cutFramePos;

  if (Math.abs(deltaFrames) > snapToleranceFrames) return undefined;

  return {
    target_sec: bestTarget.sec,
    target_frame: targetFrame,
    is_downbeat: bestTarget.isDownbeat,
    delta_frames: deltaFrames,
  };
}

/**
 * Main adjacency decide: walk V1 clips left-to-right, evaluate skills,
 * produce transitions and adjacency analysis.
 */
export function adjacencyDecide(
  v1Track: Track,
  opts: AdjacencyDecideOptions,
): { transitions: TimelineTransition[]; analysis: AdjacencyAnalysis } {
  const cards = getActiveTransitionCards(
    opts.activeEditingSkills,
    "p0",
    opts.transitionSkillsDir,
  );

  const candidateMap = new Map<string, Candidate>();
  for (const c of opts.candidates) {
    const key = c.candidate_id ?? c.segment_id;
    candidateMap.set(key, c);
    candidateMap.set(c.segment_id, c);
  }

  const beatMap = new Map<string, NormalizedBeat>();
  for (const b of opts.beats) {
    beatMap.set(b.beat_id, b);
  }

  const clips = v1Track.clips;
  const transitions: TimelineTransition[] = [];
  const pairs: AdjacencyPairResult[] = [];

  const snapToleranceFrames = opts.durationMode === "strict" ? 6 : 12;

  for (let i = 0; i < clips.length - 1; i++) {
    const leftClip = clips[i];
    const rightClip = clips[i + 1];

    const leftCandidate = candidateMap.get(leftClip.candidate_ref ?? leftClip.segment_id);
    const rightCandidate = candidateMap.get(rightClip.candidate_ref ?? rightClip.segment_id);

    const leftBeat = beatMap.get(leftClip.beat_id);
    const rightBeat = beatMap.get(rightClip.beat_id);

    const leftSegEvidence = opts.segmentEvidenceIndex?.get(leftClip.segment_id);
    const rightSegEvidence = opts.segmentEvidenceIndex?.get(rightClip.segment_id);

    // Compute cut frame position
    const cutFrame = leftClip.timeline_in_frame + leftClip.timeline_duration_frames;

    // Find BGM snap distance
    const bgmSnapDistFrames = findBgmSnapDistance(cutFrame, opts.fpsNum, opts.bgmAnalysis);

    // Build PairEvidence
    const evidence = buildPairEvidence(
      leftClip, rightClip,
      leftCandidate, rightCandidate,
      leftBeat, rightBeat,
      leftSegEvidence, rightSegEvidence,
      opts.durationMode,
      bgmSnapDistFrames,
    );

    // Resolve axis scores
    const axisScores = resolveAxisScores(evidence);

    // Evaluate each card
    interface ScoredCard {
      card: TransitionSkillCard;
      score: number;
      threshold: number;
      passesWhen: boolean;
      passesAvoidWhen: boolean;
      passesViability: boolean;
    }
    const scoredCards: ScoredCard[] = [];

    for (const card of cards) {
      // Check avoid_when first
      const passesAvoidWhen = card.avoid_when
        ? !evaluatePredicateGroup(card.avoid_when, evidence)
        : true;
      if (!passesAvoidWhen) continue;

      // Check when predicates
      const passesWhen = evaluatePredicateGroup(card.when, evidence);

      // Check viability gates
      const passesViability = card.minimum_viable.every(
        gate => evaluatePredicateGroup(gate.predicate, evidence),
      );

      // Compute Murch score
      const score = computeMurchScore(card.murch_weights, axisScores);
      const threshold = resolveSkillThreshold(card);

      scoredCards.push({ card, score, threshold, passesWhen, passesAvoidWhen, passesViability });
    }

    // Filter: must pass when + viability
    const qualifiedCards = scoredCards.filter(sc => sc.passesWhen && sc.passesViability);

    // Apply threshold filter
    const thresholdQualified = qualifiedCards.filter(sc => sc.score >= sc.threshold);

    // Select best skill
    let selectedCard: ScoredCard | undefined;
    let belowThreshold = false;
    let degradedFromSkillId: string | null = null;

    if (thresholdQualified.length > 0) {
      // argmax by score, tiebreak by id
      thresholdQualified.sort((a, b) => b.score - a.score || a.card.id.localeCompare(b.card.id));
      selectedCard = thresholdQualified[0];
    } else if (qualifiedCards.length > 0) {
      // All below threshold — pick highest raw score for reporting
      qualifiedCards.sort((a, b) => b.score - a.score || a.card.id.localeCompare(b.card.id));
      selectedCard = qualifiedCards[0];
      belowThreshold = true;
      degradedFromSkillId = selectedCard.card.id;
    }

    // Determine transition
    const pairId = `V1:${leftClip.beat_id}->${rightClip.beat_id}`;
    let transitionType: TransitionType = "cut";
    let appliedSkillId: string | undefined;
    let confidence = 0;
    let minScoreThreshold = 0.3;
    let selectedSkillScore = 0;
    let selectedSkillId: string | null = null;

    if (selectedCard && !belowThreshold) {
      transitionType = selectedCard.card.pipeline_effects.transition_type;
      appliedSkillId = selectedCard.card.id;
      confidence = selectedCard.score;
      selectedSkillId = selectedCard.card.id;
      selectedSkillScore = selectedCard.score;
      minScoreThreshold = selectedCard.threshold;
    } else if (selectedCard && belowThreshold) {
      transitionType = "cut";
      selectedSkillId = selectedCard.card.id;
      selectedSkillScore = selectedCard.score;
      minScoreThreshold = selectedCard.threshold;
    }

    // BGM beat snap
    let snapResult: ReturnType<typeof findBeatSnapTarget> | undefined;
    if (selectedCard && !belowThreshold) {
      const preferDownbeat = selectedCard.card.pipeline_effects.beat_snap === "downbeat";
      snapResult = findBeatSnapTarget(
        cutFrame, opts.fpsNum, opts.bgmAnalysis,
        preferDownbeat, snapToleranceFrames,
      );
    }

    // Build transition
    const transitionId = `tr_${String(i).padStart(4, "0")}`;
    const transition: TimelineTransition = {
      transition_id: transitionId,
      from_clip_id: leftClip.clip_id,
      to_clip_id: rightClip.clip_id,
      track_id: v1Track.track_id,
      transition_type: transitionType,
    };

    if (appliedSkillId) {
      transition.applied_skill_id = appliedSkillId;
    }
    if (degradedFromSkillId) {
      transition.degraded_from_skill_id = degradedFromSkillId;
    }
    if (confidence > 0) {
      transition.confidence = Math.round(confidence * 100) / 100;
    }

    // Build transition_params
    const params: Record<string, unknown> = {};
    let hasParams = false;

    if (selectedCard && !belowThreshold && selectedCard.card.pipeline_effects.crossfade_sec) {
      params.crossfade_sec = selectedCard.card.pipeline_effects.crossfade_sec;
      hasParams = true;
    }

    if (snapResult) {
      params.cut_frame_before_snap = cutFrame;
      params.cut_frame_after_snap = snapResult.target_frame;
      params.snap_delta_frames = snapResult.delta_frames;
      params.beat_snapped = true;
      params.beat_ref_sec = snapResult.target_sec;
      hasParams = true;
    } else {
      params.cut_frame_before_snap = cutFrame;
      params.cut_frame_after_snap = cutFrame;
      params.snap_delta_frames = 0;
      hasParams = true;
    }

    if (hasParams) {
      transition.transition_params = params as TimelineTransition["transition_params"];
    }

    transitions.push(transition);

    // Build analysis pair
    const pairResult: AdjacencyPairResult = {
      pair_id: pairId,
      left_candidate_ref: evidence.left_candidate_ref,
      right_candidate_ref: evidence.right_candidate_ref,
      selected_skill_id: selectedSkillId,
      selected_skill_score: Math.round(selectedSkillScore * 100) / 100,
      min_score_threshold: minScoreThreshold,
      transition_type: transitionType,
      confidence: Math.round(confidence * 100) / 100,
      below_threshold: belowThreshold,
      evidence: {
        visual_tag_overlap_score: evidence.visual_tag_overlap_score,
        motion_continuity_score: evidence.motion_continuity_score,
        effective_peak_type: evidence.effective_peak_type,
        left_peak_type: evidence.left_peak_type,
        right_peak_type: evidence.right_peak_type,
        left_peak_strength_score: evidence.left_peak_strength_score,
        right_peak_strength_score: evidence.right_peak_strength_score,
        effective_peak_strength_score: evidence.effective_peak_strength_score,
        energy_delta_score: evidence.energy_delta_score,
        semantic_cluster_change: evidence.semantic_cluster_change,
        outgoing_afterglow_score: evidence.outgoing_afterglow_score,
        outgoing_silence_ratio: evidence.outgoing_silence_ratio,
      },
      degraded_from_skill_id: degradedFromSkillId,
    };
    pairs.push(pairResult);
  }

  const analysis: AdjacencyAnalysis = {
    version: "1",
    project_id: "",
    pairs,
  };

  return { transitions, analysis };
}

/**
 * Apply beat snap to clip geometry (pair-preserving reallocation).
 * Modifies clips in-place. Returns true if snap was committed.
 */
export function applyBeatSnap(
  leftClip: TimelineClip,
  rightClip: TimelineClip,
  snapDeltaFrames: number,
  fpsNum: number,
): boolean {
  if (snapDeltaFrames === 0) return true;

  const usPerFrame = 1_000_000 / fpsNum;
  const absDelta = Math.abs(snapDeltaFrames);

  // Guard: both clips must remain at least 1 frame
  if (snapDeltaFrames > 0) {
    if (rightClip.timeline_duration_frames - absDelta < 1) return false;
  } else {
    if (leftClip.timeline_duration_frames - absDelta < 1) return false;
  }

  if (snapDeltaFrames > 0) {
    // Extend left, shrink right
    leftClip.timeline_duration_frames += absDelta;
    leftClip.src_out_us += Math.round(absDelta * usPerFrame);
    rightClip.timeline_in_frame += absDelta;
    rightClip.timeline_duration_frames -= absDelta;
    rightClip.src_in_us += Math.round(absDelta * usPerFrame);
  } else {
    // Shrink left, extend right
    leftClip.timeline_duration_frames -= absDelta;
    leftClip.src_out_us -= Math.round(absDelta * usPerFrame);
    rightClip.timeline_in_frame -= absDelta;
    rightClip.timeline_duration_frames += absDelta;
    rightClip.src_in_us -= Math.round(absDelta * usPerFrame);
  }

  return true;
}

/**
 * Write adjacency analysis artifact to project directory.
 */
export function writeAdjacencyAnalysis(
  analysis: AdjacencyAnalysis,
  projectPath: string,
): string {
  const outDir = path.join(projectPath, "05_timeline");
  if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
  }
  const outPath = path.join(outDir, "adjacency_analysis.json");
  fs.writeFileSync(outPath, JSON.stringify(analysis, null, 2), "utf-8");
  return outPath;
}
