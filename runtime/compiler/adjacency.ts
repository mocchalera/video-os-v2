// Adjacency Analyzer
// Analyzes adjacent clip pairs on V1 and selects transition skills.
// Pure, deterministic. No LLM calls.

import * as fs from "node:fs";
import * as path from "node:path";
import type {
  Candidate,
  CaptionPolicySource,
  ContinuityCompileMetadata,
  ContinuityExemption,
  ContinuityIssue,
  ContinuityPolicy,
  ContinuityReorderEvent,
  ContinuityRepeatPolicy,
  ContinuityRun,
  CraftTransition,
  NormalizedBeat,
  TimelineClip,
  Track,
} from "./types.js";
import { getCandidateRef } from "./candidate-ref.js";
import type {
  TransitionSkillCard,
  PairEvidence,
  AdjacencyPairResult,
  AdjacencyAnalysis,
  TimelineTransition,
  TransitionType,
  TransitionEffects,
  BgmAnalysis,
  BgmSection,
  AdjacencyFeatures,
  PeakType,
  StoryRole,
  EvidenceCoverageStatus,
  DerivedEvidenceSource,
  DerivedFeatureEvidenceCoverage,
  SkillSelectionOutcome,
  ExplicitIntentEvidence,
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
  resolveShotScaleContinuity,
  resolveCadenceFit,
} from "./transition-skill-loader.js";
import { cosineSimilarity } from "./visual-cache.js";
import { TRANSITION_PRESET_DEFAULT_CROSSFADE_SEC } from "./transition-types.js";
import type { SegmentEvidence } from "../artifacts/segment-editorial-evidence.js";
import { classifyCutRelation } from "./cut-relation.js";

const SAME_ASSET_PUNCH_IN_SCALE = 1.08;
const SAME_ASSET_PUNCH_IN_MIN_GAP_US = 500_000;

// ── PairEvidence construction ───────────────────────────────────────

interface BuildPairEvidenceContext {
  captionPolicySource?: CaptionPolicySource;
  beatOrder?: Map<string, number>;
  totalBeats?: number;
  segmentEvidenceCoverageEnabled?: boolean;
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
  if (["unknown", "not_applicable"].includes(leftMotion) || ["unknown", "not_applicable"].includes(rightMotion)) return 0.5;
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

function pairCoverageStatus(
  left: EvidenceCoverageStatus,
  right: EvidenceCoverageStatus,
): EvidenceCoverageStatus {
  if (left === "missing" || right === "missing") return "missing";
  if (left === "not_applicable" || right === "not_applicable") return "not_applicable";
  if (left === "unknown" || right === "unknown") return "unknown";
  return "known";
}

function missingSegmentCoverage(): import("./transition-types.js").SegmentEvidenceCoverage {
  return {
    visual_tags: "missing",
    motion_type: "missing",
    shot_scale: "missing",
    composition_anchor: "missing",
    screen_side: "missing",
    gaze_direction: "missing",
    camera_axis: "missing",
    camera_motion_direction: "missing",
    subject_motion_direction: "missing",
    dominant_subject_type: "missing",
    avg_luma: "missing",
    dominant_colors: "missing",
    text_presence: "missing",
  };
}

function buildEvidenceCoverage(
  left: SegmentEvidence["coverage"],
  right: SegmentEvidence["coverage"],
): import("./transition-types.js").PairEvidenceCoverage {
  const resolvedLeft = left ?? missingSegmentCoverage();
  const resolvedRight = right ?? missingSegmentCoverage();
  const fields = [
    "visual_tags",
    "motion_type",
    "shot_scale",
    "composition_anchor",
    "screen_side",
    "gaze_direction",
    "camera_axis",
    "camera_motion_direction",
    "subject_motion_direction",
    "dominant_subject_type",
    "avg_luma",
    "dominant_colors",
    "text_presence",
  ] as const;
  return Object.fromEntries(fields.map((field) => [field, {
    left: resolvedLeft[field] ?? "missing",
    right: resolvedRight[field] ?? "missing",
    pair: pairCoverageStatus(resolvedLeft[field] ?? "missing", resolvedRight[field] ?? "missing"),
  }])) as import("./transition-types.js").PairEvidenceCoverage;
}

function knownFeature<T>(value: T | undefined, status: import("./transition-types.js").EvidenceCoverageStatus | undefined): T | undefined {
  return status === undefined || status === "known" ? value : undefined;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

interface ResolvedSide<T> {
  value: T;
  status: EvidenceCoverageStatus;
  source: DerivedEvidenceSource;
}

function derivedCoverage(
  left: Pick<ResolvedSide<unknown>, "status" | "source">,
  right: Pick<ResolvedSide<unknown>, "status" | "source">,
): DerivedFeatureEvidenceCoverage {
  return {
    left: left.status,
    right: right.status,
    pair: pairCoverageStatus(left.status, right.status),
    source: { left: left.source, right: right.source },
  };
}

function resolveTags(
  segEvidence: SegmentEvidence | undefined,
  signals: Candidate["editorial_signals"] | undefined,
): ResolvedSide<string[]> {
  const canonicalStatus = segEvidence?.coverage?.visual_tags;
  if (canonicalStatus === "known") {
    const value = segEvidence?.adjacency_features.visual_tags ?? [];
    return {
      value,
      status: value.length > 0 ? "known" : "not_applicable",
      source: "canonical_metadata",
    };
  }
  if (canonicalStatus === "unknown" || canonicalStatus === "not_applicable") {
    return { value: [], status: canonicalStatus, source: "canonical_metadata" };
  }
  if (signals?.visual_tags !== undefined) {
    return {
      value: signals.visual_tags,
      status: signals.visual_tags.length > 0 ? "known" : "not_applicable",
      source: "candidate_metadata",
    };
  }
  return { value: [], status: "missing", source: "none" };
}

function resolveCluster(value: string | undefined): ResolvedSide<string | undefined> {
  const normalized = value?.trim();
  if (!normalized) return { value: undefined, status: "missing", source: "none" };
  if (normalized === "unknown") return { value: undefined, status: "unknown", source: "candidate_metadata" };
  if (normalized === "not_applicable") return { value: undefined, status: "not_applicable", source: "candidate_metadata" };
  return { value: normalized, status: "known", source: "candidate_metadata" };
}

function resolveSemanticClusterChange(
  leftCluster: ResolvedSide<string | undefined>,
  rightCluster: ResolvedSide<string | undefined>,
  sameAsset: boolean,
  visualTagOverlapScore: number,
  visualTagCoverage: DerivedFeatureEvidenceCoverage,
): { value: boolean; coverage: DerivedFeatureEvidenceCoverage } {
  const fallbackSide = (
    cluster: ResolvedSide<string | undefined>,
    tagStatus: EvidenceCoverageStatus,
    tagSource: DerivedEvidenceSource,
  ): Pick<ResolvedSide<unknown>, "status" | "source"> => {
    if (cluster.status !== "missing") return cluster;
    if (tagStatus !== "missing") return { status: tagStatus, source: tagSource };
    return cluster;
  };
  if (leftCluster.status === "known" && rightCluster.status === "known") {
    return {
      value: leftCluster.value !== rightCluster.value,
      coverage: derivedCoverage(leftCluster, rightCluster),
    };
  }
  if (sameAsset) {
    return {
      value: false,
      coverage: derivedCoverage(
        fallbackSide(leftCluster, visualTagCoverage.left, visualTagCoverage.source.left),
        fallbackSide(rightCluster, visualTagCoverage.right, visualTagCoverage.source.right),
      ),
    };
  }
  if (visualTagCoverage.pair === "known") {
    return {
      value: visualTagOverlapScore < 0.7,
      coverage: derivedCoverage(
        { status: "known", source: visualTagCoverage.source.left },
        { status: "known", source: visualTagCoverage.source.right },
      ),
    };
  }
  return {
    value: false,
    coverage: derivedCoverage(
      fallbackSide(leftCluster, visualTagCoverage.left, visualTagCoverage.source.left),
      fallbackSide(rightCluster, visualTagCoverage.right, visualTagCoverage.source.right),
    ),
  };
}

function resolveEnergyProxy(
  signals: Candidate["editorial_signals"] | undefined,
  segEvidence: SegmentEvidence | undefined,
): ResolvedSide<number> {
  const candidates: Array<[number | undefined, DerivedEvidenceSource]> = [
    [signals?.speech_intensity_score, "candidate_metadata"],
    [signals?.motion_energy_score, "candidate_metadata"],
    [segEvidence?.support_signals?.motion_support_score, "canonical_metadata"],
    [signals?.audio_energy_score, "candidate_metadata"],
    [signals?.peak_strength_score, "candidate_metadata"],
    [segEvidence?.support_signals?.fused_peak_score, "canonical_metadata"],
  ];
  for (const [value, source] of candidates) {
    if (typeof value === "number" && Number.isFinite(value)) {
      return { value: clamp01(value), status: "known", source };
    }
  }
  return { value: 0.5, status: "missing", source: "none" };
}

function inferBRollStoryRole(
  beatId: string | undefined,
  context: BuildPairEvidenceContext | undefined,
): StoryRole | undefined {
  if (context?.captionPolicySource !== "none") return undefined;
  if (!beatId || !context.beatOrder || !context.totalBeats || context.totalBeats < 1) return undefined;

  const beatIndex = context.beatOrder.get(beatId);
  if (beatIndex === undefined) return undefined;

  if (context.totalBeats === 1) return "experience";
  if (beatIndex === 0) return "hook";
  if (beatIndex === context.totalBeats - 1) return "closing";
  return "experience";
}

function resolveStoryRole(
  explicitRole: StoryRole | undefined,
  beatId: string | undefined,
  context: BuildPairEvidenceContext | undefined,
): StoryRole | undefined {
  return explicitRole ?? inferBRollStoryRole(beatId, context);
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
  context?: BuildPairEvidenceContext,
): PairEvidence {
  const leftSignals = leftCandidate?.editorial_signals;
  const rightSignals = rightCandidate?.editorial_signals;

  const leftAdj = leftSegEvidence?.adjacency_features;
  const rightAdj = rightSegEvidence?.adjacency_features;
  // Derived coverage is always emitted. The EYE-020 flag controls whether
  // canonical observation metadata is loaded, not whether missing data is
  // allowed to masquerade as a measured metric.
  const evidenceCoverage = buildEvidenceCoverage(leftSegEvidence?.coverage, rightSegEvidence?.coverage);
  const sameAsset = leftClip.asset_id === rightClip.asset_id;

  // Visual tag overlap
  const leftTags = resolveTags(leftSegEvidence, leftSignals);
  const rightTags = resolveTags(rightSegEvidence, rightSignals);
  const visualTagCoverage = derivedCoverage(leftTags, rightTags);
  const rawTagStatus = (
    segEvidence: SegmentEvidence | undefined,
    signals: Candidate["editorial_signals"] | undefined,
  ): EvidenceCoverageStatus => {
    const status = segEvidence?.coverage?.visual_tags;
    if (status === "known" || status === "unknown" || status === "not_applicable") return status;
    return signals?.visual_tags !== undefined ? "known" : "missing";
  };
  const leftStatus = rawTagStatus(leftSegEvidence, leftSignals);
  const rightStatus = rawTagStatus(rightSegEvidence, rightSignals);
  evidenceCoverage.visual_tags = {
    left: leftStatus,
    right: rightStatus,
    pair: pairCoverageStatus(leftStatus, rightStatus),
  };
  evidenceCoverage.visual_tag_overlap_score = visualTagCoverage;
  const visualTagOverlapScore = visualTagCoverage.pair === "known"
    ? jaccard(leftTags.value, rightTags.value)
    : 0.5;

  // Motion continuity
  const motionContinuityScore = motionContinuity(
    knownFeature(leftAdj?.motion_type, leftSegEvidence?.coverage?.motion_type),
    knownFeature(rightAdj?.motion_type, rightSegEvidence?.coverage?.motion_type),
  );

  // Semantic cluster change
  const semanticClusterResult = resolveSemanticClusterChange(
    resolveCluster(leftSignals?.semantic_cluster_id),
    resolveCluster(rightSignals?.semantic_cluster_id),
    sameAsset,
    visualTagOverlapScore,
    visualTagCoverage,
  );
  const semanticClusterChange = semanticClusterResult.value;
  evidenceCoverage.semantic_cluster_change = semanticClusterResult.coverage;

  // Motif overlap
  const leftMotifs = leftCandidate?.motif_tags ?? [];
  const rightMotifs = rightCandidate?.motif_tags ?? [];
  const motifOverlapScore = jaccard(leftMotifs, rightMotifs);

  // Peak strength and type
  const leftPeakStrengthValue = leftSignals?.peak_strength_score ??
    leftSegEvidence?.support_signals?.fused_peak_score;
  const rightPeakStrengthValue = rightSignals?.peak_strength_score ??
    rightSegEvidence?.support_signals?.fused_peak_score;
  const leftPeakStrength = leftPeakStrengthValue ?? 0;
  const rightPeakStrength = rightPeakStrengthValue ?? 0;
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

  // Signed energy delta in [-1, 1]: right_energy - left_energy.
  const leftEnergy = resolveEnergyProxy(leftSignals, leftSegEvidence);
  const rightEnergy = resolveEnergyProxy(rightSignals, rightSegEvidence);
  const energyCoverage = derivedCoverage(leftEnergy, rightEnergy);
  const energyDeltaScore = energyCoverage.pair === "known"
    ? Math.max(-1, Math.min(1, rightEnergy.value - leftEnergy.value))
    : 0;
  evidenceCoverage.energy_delta_score = energyCoverage;

  // Silence and afterglow
  const outgoingSilenceRatio = leftSignals?.silence_ratio ?? 0;
  const outgoingAfterglowScore = leftSignals?.afterglow_score ?? 0;
  const incomingReactionScore = rightSignals?.reaction_intensity_score ?? 0;

  // Story roles
  const leftStoryRole = resolveStoryRole(leftBeat?.story_role, leftClip.beat_id, context);
  const rightStoryRole = resolveStoryRole(rightBeat?.story_role, rightClip.beat_id, context);

  // Composition match
  const compositionMatchScore = resolveCompositionMatch(
    {
      shot_scale: knownFeature(leftAdj?.shot_scale, leftSegEvidence?.coverage?.shot_scale),
      composition_anchor: knownFeature(leftAdj?.composition_anchor, leftSegEvidence?.coverage?.composition_anchor),
      screen_side: knownFeature(leftAdj?.screen_side, leftSegEvidence?.coverage?.screen_side),
    },
    {
      shot_scale: knownFeature(rightAdj?.shot_scale, rightSegEvidence?.coverage?.shot_scale),
      composition_anchor: knownFeature(rightAdj?.composition_anchor, rightSegEvidence?.coverage?.composition_anchor),
      screen_side: knownFeature(rightAdj?.screen_side, rightSegEvidence?.coverage?.screen_side),
    },
  );

  // Shot scale continuity (separate from composition match)
  const shotScaleContinuityScore = resolveShotScaleContinuity(
    knownFeature(leftAdj?.shot_scale, leftSegEvidence?.coverage?.shot_scale),
    knownFeature(rightAdj?.shot_scale, rightSegEvidence?.coverage?.shot_scale),
  );
  const shotScaleDiagnostic = evidenceCoverage?.shot_scale.pair === "known" &&
    (leftAdj?.shot_scale === "insert" || rightAdj?.shot_scale === "insert")
    ? "unsupported_shot_scale_rank:insert"
    : undefined;

  // Cadence fit
  const snapToleranceFrames = durationMode === "strict" ? 6 : 12;
  const cadenceFitResult = resolveCadenceFit(
    leftClip.timeline_duration_frames,
    leftBeat?.target_duration_frames,
    leftSignals?.silence_ratio ?? 0,
    bgmSnapDistanceFrames,
    snapToleranceFrames,
  );
  const cadenceFitScore = cadenceFitResult.score;

  // Setup/payoff
  const partialEvidence = {
    left_story_role: leftStoryRole,
    right_story_role: rightStoryRole,
    semantic_cluster_change: semanticClusterChange,
    motif_overlap_score: motifOverlapScore,
  } as PairEvidence;
  const setupPayoffRelationScore = resolveSetupPayoff(partialEvidence);

  const sameSpeakerRole = !!(leftCandidate?.speaker_role && rightCandidate?.speaker_role &&
    leftCandidate.speaker_role === rightCandidate.speaker_role);

  // B-roll candidate
  const hasBRollCandidate = !!(
    context?.captionPolicySource === "none" ||
    leftCandidate?.role === "support" ||
    leftCandidate?.role === "texture" ||
    rightCandidate?.role === "support" ||
    rightCandidate?.role === "texture"
  );

  // Build partial evidence — compute axis_break_readiness first, then axis_consistency with it
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
    shot_scale_continuity_score: shotScaleContinuityScore,
    composition_match_score: compositionMatchScore,
    axis_consistency_score: 0, // will be recomputed below
    axis_break_readiness_score: 0, // will be computed below
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
    evidence_coverage: evidenceCoverage,
    ...(shotScaleDiagnostic ? {
      evidence_diagnostics: { shot_scale_continuity: shotScaleDiagnostic },
    } : {}),
  };

  // Compute axis_break_readiness first (does not depend on axis_consistency)
  partialForAxis.axis_break_readiness_score = resolveAxisBreakReadiness(partialForAxis);

  // Now compute axis_consistency with break readiness context
  partialForAxis.axis_consistency_score = resolveAxisConsistency(
    {
      screen_side: knownFeature(leftAdj?.screen_side, leftSegEvidence?.coverage?.screen_side),
      gaze_direction: knownFeature(leftAdj?.gaze_direction, leftSegEvidence?.coverage?.gaze_direction),
      camera_axis: knownFeature(leftAdj?.camera_axis, leftSegEvidence?.coverage?.camera_axis),
    },
    {
      screen_side: knownFeature(rightAdj?.screen_side, rightSegEvidence?.coverage?.screen_side),
      gaze_direction: knownFeature(rightAdj?.gaze_direction, rightSegEvidence?.coverage?.gaze_direction),
      camera_axis: knownFeature(rightAdj?.camera_axis, rightSegEvidence?.coverage?.camera_axis),
    },
    partialForAxis.axis_break_readiness_score,
  );

  return partialForAxis;
}

// ── Adjacency Decide ────────────────────────────────────────────────

export interface AdjacencyDecideOptions {
  activeEditingSkills: string[];
  durationMode: "strict" | "guide";
  fpsNum: number;
  bgmAnalysis?: BgmAnalysis;
  captionPolicySource?: CaptionPolicySource;
  candidates: Candidate[];
  beats: NormalizedBeat[];
  segmentEvidenceIndex?: Map<string, SegmentEvidence>;
  visualEmbeddings?: Map<string, Float32Array>;
  transitionSkillsDir?: string;
}

const CRAFT_TRANSITION_SCORE_BONUS = 0.2;
const VISUAL_DISSOLVE_THRESHOLD = 0.85;
const VISUAL_HARD_CUT_THRESHOLD = 0.95;

export function visualCoherenceScore(
  clipA: TimelineClip,
  clipB: TimelineClip,
  embeddings: Map<string, Float32Array>,
): number {
  const vecA = embeddings.get(clipA.segment_id);
  const vecB = embeddings.get(clipB.segment_id);
  if (!vecA || !vecB) return 0.5;
  return cosineSimilarity(vecA, vecB);
}

export function visualTransitionHint(
  score: number,
): "dissolve" | "hard_cut" | undefined {
  if (score < VISUAL_DISSOLVE_THRESHOLD) return "dissolve";
  if (score > VISUAL_HARD_CUT_THRESHOLD) return "hard_cut";
  return undefined;
}

export function craftTransitionToSkillId(transition: CraftTransition | undefined): string | undefined {
  switch (transition) {
    case "dissolve":
      return "crossfade_bridge";
    case "dip_to_black":
      return "silence_beat";
    // Issue #34 presets are handled directly by the craft override path
    // (no skill card indirection): the transition type equals the craft value.
    default:
      return undefined;
  }
}

export function hasCraftTransitions(beats: NormalizedBeat[]): boolean {
  return beats.some((beat) => !!beat.craft?.transition_in || !!beat.craft?.transition_out);
}

function activeSkillsWithCraftTransitionBias(
  activeEditingSkills: string[],
  beats: NormalizedBeat[],
): string[] {
  const ids = new Set(activeEditingSkills);
  for (const beat of beats) {
    const transitionIds = [
      craftTransitionToSkillId(beat.craft?.transition_in),
      craftTransitionToSkillId(beat.craft?.transition_out),
    ];
    for (const id of transitionIds) {
      if (id) ids.add(id);
    }
  }
  return [...ids].sort((a, b) => a.localeCompare(b));
}

function resolvePairCraftTransition(
  leftBeat: NormalizedBeat | undefined,
  rightBeat: NormalizedBeat | undefined,
): { transition: CraftTransition; source: "transition_out" | "transition_in" } | undefined {
  if (leftBeat?.craft?.transition_out) {
    return { transition: leftBeat.craft.transition_out, source: "transition_out" };
  }
  if (rightBeat?.craft?.transition_in) {
    return { transition: rightBeat.craft.transition_in, source: "transition_in" };
  }
  return undefined;
}

function pairCraftIntentEvidence(
  leftBeat: NormalizedBeat | undefined,
  rightBeat: NormalizedBeat | undefined,
): ExplicitIntentEvidence[] {
  const evidence: ExplicitIntentEvidence[] = [];
  if (!leftBeat || !rightBeat || leftBeat.beat_id === rightBeat.beat_id) return evidence;
  if (leftBeat?.craft?.transition_out) {
    evidence.push({
      source: "beat_craft",
      source_ref: `edit_blueprint.beats.${leftBeat.beat_id}.craft.transition_out`,
      intent: leftBeat.craft.transition_out,
    });
  }
  if (rightBeat?.craft?.transition_in) {
    evidence.push({
      source: "beat_craft",
      source_ref: `edit_blueprint.beats.${rightBeat.beat_id}.craft.transition_in`,
      intent: rightBeat.craft.transition_in,
    });
  }
  return evidence;
}

function metadataOnlyCraftTransition(transition: CraftTransition | undefined): boolean {
  return transition === "j_cut" || transition === "l_cut" || transition === "match_cut";
}

function defaultCraftTransitionType(transition: CraftTransition | undefined): TransitionType | undefined {
  switch (transition) {
    case "dissolve":
      return "crossfade";
    case "dip_to_black":
      return "fade_to_black";
    // Issue #34 presets: craft value maps 1:1 to the transition type.
    case "film_crossfade":
      return "film_crossfade";
    case "light_leak_flash":
      return "light_leak_flash";
    case "dreamy_focus_blur":
      return "dreamy_focus_blur";
    default:
      return undefined;
  }
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
 * Issue #34: find the chorus section start nearest a cut frame.
 *
 * The light-leak flash must fire exactly on the chorus head ("サビ頭で…
 * 1フレームのズレもなく発光"), so chorus section starts are first-class snap
 * targets for `light_leak_flash` transitions. Returns undefined when no
 * chorus section start lies within tolerance.
 */
export function findChorusSectionSnapTarget(
  cutFramePos: number,
  fpsNum: number,
  bgmAnalysis: BgmAnalysis | undefined,
  snapToleranceFrames: number,
): { target_sec: number; target_frame: number; delta_frames: number; section_id: string } | undefined {
  if (!bgmAnalysis || bgmAnalysis.analysis_status !== "ready") return undefined;

  const cutSec = cutFramePos / fpsNum;
  let best: { section: BgmSection; dist: number } | undefined;
  for (const section of bgmAnalysis.sections) {
    if (section.label !== "chorus") continue;
    const dist = Math.abs(section.start_sec - cutSec);
    if (dist < (best?.dist ?? Infinity)) {
      best = { section, dist };
    }
  }
  if (!best) return undefined;

  const targetFrame = Math.round(best.section.start_sec * fpsNum);
  const deltaFrames = targetFrame - cutFramePos;
  if (Math.abs(deltaFrames) > snapToleranceFrames) return undefined;

  return {
    target_sec: best.section.start_sec,
    target_frame: targetFrame,
    delta_frames: deltaFrames,
    section_id: best.section.id,
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
    activeSkillsWithCraftTransitionBias(opts.activeEditingSkills, opts.beats),
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
  const beatOrder = new Map<string, number>();
  for (const [index, b] of opts.beats.entries()) {
    beatMap.set(b.beat_id, b);
    beatOrder.set(b.beat_id, index);
  }

  const clips = v1Track.clips;
  const transitions: TimelineTransition[] = [];
  const pairs: AdjacencyPairResult[] = [];

  const snapToleranceFrames = opts.durationMode === "strict" ? 6 : 12;

  // Track previous pair's selected skill for pair_bonus_prev (build_to_peak P0 bias)
  let prevSelectedSkillId: string | null = null;

  for (let i = 0; i < clips.length - 1; i++) {
    const leftClip = clips[i];
    const rightClip = clips[i + 1];

    const leftCandidate = candidateMap.get(leftClip.candidate_ref ?? leftClip.segment_id);
    const rightCandidate = candidateMap.get(rightClip.candidate_ref ?? rightClip.segment_id);

    const leftBeat = beatMap.get(leftClip.beat_id);
    const rightBeat = beatMap.get(rightClip.beat_id);
    const craftTransition = resolvePairCraftTransition(leftBeat, rightBeat);
    const preferredCraftSkillId = craftTransitionToSkillId(craftTransition?.transition);
    const preferredCraftCard = preferredCraftSkillId
      ? cards.find((card) => card.id === preferredCraftSkillId)
      : undefined;

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
      {
        captionPolicySource: opts.captionPolicySource,
        beatOrder,
        totalBeats: opts.beats.length,
        segmentEvidenceCoverageEnabled: opts.segmentEvidenceIndex !== undefined,
      },
    );
    const visualScore = opts.visualEmbeddings && opts.visualEmbeddings.size > 0
      ? visualCoherenceScore(leftClip, rightClip, opts.visualEmbeddings)
      : undefined;
    const visualHint = visualScore == null ? undefined : visualTransitionHint(visualScore);
    if (visualScore != null) {
      evidence.visual_coherence_score = roundScore(visualScore);
    }
    if (visualHint) {
      evidence.visual_transition_hint = visualHint;
    }
    const cutRelation = opts.segmentEvidenceIndex !== undefined
      ? classifyCutRelation({
        left: {
          asset_id: leftClip.asset_id,
          beat_id: leftClip.beat_id,
          story_role: leftBeat?.story_role,
          evidence: leftSegEvidence,
        },
        right: {
          asset_id: rightClip.asset_id,
          beat_id: rightClip.beat_id,
          story_role: rightBeat?.story_role,
          evidence: rightSegEvidence,
        },
        visual_coherence_score: visualScore,
        explicit_intent_evidence: pairCraftIntentEvidence(leftBeat, rightBeat),
      })
      : undefined;

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
      viabilityGates: Array<{ gateId: string; passed: boolean; failureReason: string }>;
    }
    const scoredCards: ScoredCard[] = [];

    for (const card of cards) {
      // Check avoid_when first
      const passesAvoidWhen = card.avoid_when
        ? !evaluatePredicateGroup(card.avoid_when, evidence)
        : true;

      // Check when predicates
      const passesWhen = evaluatePredicateGroup(card.when, evidence);

      // Check viability gates
      const viabilityGates = card.minimum_viable.map(gate => ({
        gateId: gate.id,
        passed: evaluatePredicateGroup(gate.predicate, evidence),
        failureReason: gate.failure_reason,
      }));
      const passesViability = viabilityGates.every(gate => gate.passed);

      // Compute Murch score
      let score = computeMurchScore(card.murch_weights, axisScores);
      const threshold = resolveSkillThreshold(card);

      // pair_bonus_prev: if the previous pair used build_to_peak and this card
      // is also build_to_peak, add a continuity bonus to favor sustained build
      if (card.id === "build_to_peak" && prevSelectedSkillId === "build_to_peak") {
        score = Math.min(1, score + 0.08);
      }
      if (preferredCraftSkillId && card.id === preferredCraftSkillId) {
        score = Math.min(1, score + CRAFT_TRANSITION_SCORE_BONUS);
      }

      scoredCards.push({ card, score, threshold, passesWhen, passesAvoidWhen, passesViability, viabilityGates });
    }

    // Separate cards into: fully qualified, viability-failed (for fallback), threshold candidates
    const qualifiedCards = scoredCards.filter(sc => sc.passesAvoidWhen && sc.passesWhen && sc.passesViability);
    const viabilityFailedCards = scoredCards.filter(sc => sc.passesAvoidWhen && sc.passesWhen && !sc.passesViability);

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
    let activeTransitionEffects: TransitionEffects | undefined;
    let baseSelectionOutcome: Exclude<SkillSelectionOutcome, "craft_override" | "visual_override"> = "no_eligible";
    let selectionReasonCodes = ["no_eligible_card"];
    let selectionOverride: import("./transition-types.js").SkillSelectionRationale["override"];

    // Fallback resolution: walk fallback_order[] when below threshold or viability failed
    type FallbackResolution =
      | { resolved: true; transitionType: TransitionType; appliedSkillId: string; params: Record<string, unknown> }
      | { resolved: false; reasonCode: "fallback_skip_skill" | "fallback_order_exhausted" };
    const resolveFallback = (
      card: TransitionSkillCard,
    ): FallbackResolution => {
      for (const step of card.fallback_order) {
        switch (step.kind) {
          case "hard_cut":
            return {
              resolved: true,
              transitionType: step.transition_type ?? "cut",
              appliedSkillId: `fallback.hard_cut`,
              params: {},
            };
          case "crossfade":
            return {
              resolved: true,
              transitionType: step.transition_type ?? "crossfade",
              appliedSkillId: `fallback.crossfade`,
              params: step.crossfade_sec ? { crossfade_sec: step.crossfade_sec } : {},
            };
          case "same_asset_punch_in":
            if (evidence.same_asset) {
              return {
                resolved: true,
                transitionType: "cut",
                appliedSkillId: `fallback.same_asset_punch_in`,
                params: step.punch_in_scale ? { punch_in_scale: step.punch_in_scale } : {},
              };
            }
            continue; // try next step
          case "freeze_hold":
            return {
              resolved: true,
              transitionType: "cut",
              appliedSkillId: `fallback.freeze_hold`,
              params: {
                ...(step.hold_side ? { hold_side: step.hold_side } : {}),
                ...(step.hold_frames ? { hold_frames: step.hold_frames } : {}),
              },
            };
          case "skip_skill":
            return { resolved: false, reasonCode: "fallback_skip_skill" };
        }
      }
      return { resolved: false, reasonCode: "fallback_order_exhausted" };
    };

    let fallbackParams: Record<string, unknown> = {};

    if (selectedCard && !belowThreshold) {
      transitionType = selectedCard.card.pipeline_effects.transition_type;
      appliedSkillId = selectedCard.card.id;
      confidence = selectedCard.score;
      selectedSkillId = selectedCard.card.id;
      selectedSkillScore = selectedCard.score;
      minScoreThreshold = selectedCard.threshold;
      activeTransitionEffects = selectedCard.card.pipeline_effects;
      baseSelectionOutcome = "selected";
      selectionReasonCodes = ["threshold_qualified", "highest_score_selected"];
    } else if (selectedCard && belowThreshold) {
      // Below threshold — try fallback chain
      const fb = resolveFallback(selectedCard.card);
      if (fb.resolved) {
        transitionType = fb.transitionType;
        appliedSkillId = fb.appliedSkillId;
        degradedFromSkillId = selectedCard.card.id;
        fallbackParams = fb.params;
      } else {
        transitionType = "cut";
        degradedFromSkillId = selectedCard.card.id;
      }
      selectedSkillId = selectedCard.card.id;
      selectedSkillScore = selectedCard.score;
      minScoreThreshold = selectedCard.threshold;
      baseSelectionOutcome = "below_threshold_fallback";
      selectionReasonCodes = [
        "no_card_met_threshold",
        fb.resolved ? "fallback_order_applied" : fb.reasonCode,
      ];
    } else if (viabilityFailedCards.length > 0) {
      // Viability failed — try fallback chain on highest-scoring viability-failed card
      viabilityFailedCards.sort((a, b) => b.score - a.score || a.card.id.localeCompare(b.card.id));
      const failedCard = viabilityFailedCards[0];
      const fb = resolveFallback(failedCard.card);
      if (fb.resolved) {
        transitionType = fb.transitionType;
        appliedSkillId = fb.appliedSkillId;
        degradedFromSkillId = failedCard.card.id;
        fallbackParams = fb.params;
      }
      selectedSkillId = failedCard.card.id;
      selectedSkillScore = failedCard.score;
      minScoreThreshold = failedCard.threshold;
      belowThreshold = true;
      baseSelectionOutcome = "viability_fallback";
      selectionReasonCodes = [
        "minimum_viable_failed",
        fb.resolved ? "fallback_order_applied" : fb.reasonCode,
      ];
    }

    let selectionOutcome: SkillSelectionOutcome = baseSelectionOutcome;

    const forcedCraftTransitionType = defaultCraftTransitionType(craftTransition?.transition);
    if (craftTransition && forcedCraftTransitionType) {
      const replacedOutcome = baseSelectionOutcome;
      const craftEffects = preferredCraftCard?.pipeline_effects;
      transitionType = craftEffects?.transition_type ?? forcedCraftTransitionType;
      appliedSkillId = preferredCraftCard?.id ?? `craft.${craftTransition.transition}`;
      confidence = Math.max(confidence, 0.8);
      selectedSkillId = appliedSkillId;
      selectedSkillScore = Math.max(selectedSkillScore, confidence);
      minScoreThreshold = preferredCraftCard ? resolveSkillThreshold(preferredCraftCard) : 0;
      degradedFromSkillId = null;
      belowThreshold = false;
      fallbackParams = {};
      activeTransitionEffects = craftEffects ?? {
        transition_type: forcedCraftTransitionType,
        crossfade_sec: forcedCraftTransitionType === "crossfade" || forcedCraftTransitionType === "fade_to_black"
          ? 0.5
          : forcedCraftTransitionType === "film_crossfade" ||
              forcedCraftTransitionType === "light_leak_flash" ||
              forcedCraftTransitionType === "dreamy_focus_blur"
            ? TRANSITION_PRESET_DEFAULT_CROSSFADE_SEC[forcedCraftTransitionType]
            : undefined,
        // Issue #34 presets anchor the A/B window on the cut frame so the
        // overlap (and any chorus flash) starts exactly at the transition cut.
        ...(forcedCraftTransitionType === "film_crossfade" ||
        forcedCraftTransitionType === "light_leak_flash" ||
        forcedCraftTransitionType === "dreamy_focus_blur"
          ? { beat_snap: "beat" as const, snap_anchor: "cut_frame" as const }
          : {}),
      };
      selectionOutcome = "craft_override";
      selectionReasonCodes = ["craft_transition_override", `craft_transition:${craftTransition.transition}`];
      selectionOverride = {
        kind: "craft",
        selected_skill_id: appliedSkillId,
        replaced_outcome: replacedOutcome,
      };
    }

    const craftForcesCut = craftTransition?.transition === "hard_cut" ||
      metadataOnlyCraftTransition(craftTransition?.transition);
    if (craftForcesCut && craftTransition) {
      const replacedOutcome = baseSelectionOutcome;
      transitionType = "cut";
      appliedSkillId = craftTransition.transition === "hard_cut"
        ? "craft.hard_cut"
        : `craft.${craftTransition.transition}.metadata_only`;
      confidence = Math.max(confidence, 0.5);
      selectedSkillId = appliedSkillId;
      selectedSkillScore = Math.max(selectedSkillScore, confidence);
      minScoreThreshold = 0;
      degradedFromSkillId = null;
      belowThreshold = false;
      fallbackParams = {};
      activeTransitionEffects = undefined;
      selectionOutcome = "craft_override";
      selectionReasonCodes = ["craft_transition_override", `craft_transition:${craftTransition.transition}`];
      selectionOverride = {
        kind: "craft",
        selected_skill_id: appliedSkillId,
        replaced_outcome: replacedOutcome,
      };
    }

    if (!craftTransition && visualHint === "dissolve" && transitionType === "cut") {
      const replacedOutcome = baseSelectionOutcome;
      transitionType = "crossfade";
      appliedSkillId = "visual.dissolve";
      confidence = Math.max(confidence, 1 - (visualScore ?? VISUAL_DISSOLVE_THRESHOLD));
      selectedSkillId = appliedSkillId;
      selectedSkillScore = Math.max(selectedSkillScore, confidence);
      minScoreThreshold = 0;
      degradedFromSkillId = null;
      belowThreshold = false;
      fallbackParams = {};
      activeTransitionEffects = {
        transition_type: "crossfade",
        crossfade_sec: 0.5,
      };
      selectionOutcome = "visual_override";
      selectionReasonCodes = ["visual_coherence_override", "visual_hint:dissolve"];
      selectionOverride = {
        kind: "visual",
        selected_skill_id: appliedSkillId,
        replaced_outcome: replacedOutcome,
      };
    } else if (!craftTransition && visualHint === "hard_cut" && transitionType === "cut" && !appliedSkillId) {
      const replacedOutcome = baseSelectionOutcome;
      appliedSkillId = "visual.hard_cut";
      confidence = Math.max(confidence, visualScore ?? VISUAL_HARD_CUT_THRESHOLD);
      selectedSkillId = appliedSkillId;
      selectedSkillScore = Math.max(selectedSkillScore, confidence);
      minScoreThreshold = 0;
      selectionOutcome = "visual_override";
      selectionReasonCodes = ["visual_coherence_override", "visual_hint:hard_cut"];
      selectionOverride = {
        kind: "visual",
        selected_skill_id: appliedSkillId,
        replaced_outcome: replacedOutcome,
      };
    }

    applySameAssetPunchInTreatment({
      activeEditingSkills: opts.activeEditingSkills,
      transitionType,
      evidence,
      rightClip,
      rightCandidate,
    });

    // BGM beat snap — respect snap_anchor for windowed transitions
    let snapResult: ReturnType<typeof findBeatSnapTarget> | undefined;
    let chorusSectionId: string | undefined;
    if (activeTransitionEffects && !belowThreshold && !craftForcesCut) {
      const effects = activeTransitionEffects;
      const preferDownbeat = effects.beat_snap === "downbeat";
      const snapAnchor = effects.snap_anchor ?? "cut_frame";

      // Issue #34: the light-leak flash must fire exactly on the chorus head.
      // Chorus section starts take priority over generic beat targets for
      // light_leak_flash transitions anchored on the cut frame.
      if (transitionType === "light_leak_flash" && snapAnchor === "cut_frame") {
        const chorusSnap = findChorusSectionSnapTarget(
          cutFrame, opts.fpsNum, opts.bgmAnalysis, snapToleranceFrames,
        );
        if (chorusSnap) {
          snapResult = {
            target_sec: chorusSnap.target_sec,
            target_frame: chorusSnap.target_frame,
            is_downbeat: true,
            delta_frames: chorusSnap.delta_frames,
          };
          chorusSectionId = chorusSnap.section_id;
        }
      }

      // For transition_center anchor (crossfade, fade_to_black), compute center
      // as cut_frame + half the crossfade window in frames
      let snapReferenceFrame = cutFrame;
      if (snapAnchor === "transition_center" && effects.crossfade_sec) {
        const halfWindowFrames = Math.round((effects.crossfade_sec / 2) * opts.fpsNum);
        snapReferenceFrame = cutFrame + halfWindowFrames;
      }

      const rawSnap = snapResult ?? findBeatSnapTarget(
        snapReferenceFrame, opts.fpsNum, opts.bgmAnalysis,
        preferDownbeat, snapToleranceFrames,
      );

      // Convert snap result back to cut-frame-relative delta if using transition_center
      if (rawSnap && snapAnchor === "transition_center" && effects.crossfade_sec) {
        const halfWindowFrames = Math.round((effects.crossfade_sec / 2) * opts.fpsNum);
        // The snap target for the center → derive the cut frame target
        const cutFrameTarget = rawSnap.target_frame - halfWindowFrames;
        const cutFrameDelta = cutFrameTarget - cutFrame;
        if (Math.abs(cutFrameDelta) <= snapToleranceFrames) {
          snapResult = {
            target_sec: cutFrameTarget / opts.fpsNum,
            target_frame: cutFrameTarget,
            is_downbeat: rawSnap.is_downbeat,
            delta_frames: cutFrameDelta,
          };
        }
        // If converted delta exceeds tolerance, skip snap
      } else {
        snapResult = rawSnap;
      }
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

    if (!belowThreshold && activeTransitionEffects?.crossfade_sec) {
      params.crossfade_sec = activeTransitionEffects.crossfade_sec;
      hasParams = true;
    }

    // Merge fallback params (crossfade_sec, hold_side, hold_frames, etc.)
    if (Object.keys(fallbackParams).length > 0) {
      for (const [k, v] of Object.entries(fallbackParams)) {
        params[k] = v;
      }
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

    // Issue #34 overlap presets blend with a fixed linear law:
    // Frame = (1 - alpha) * A + alpha * B.
    if (
      transitionType === "film_crossfade" ||
      transitionType === "light_leak_flash" ||
      transitionType === "dreamy_focus_blur"
    ) {
      params.easing = "linear";
      hasParams = true;
      if (chorusSectionId) {
        transition.metadata = {
          ...transition.metadata,
          chorus_entry: {
            section_id: chorusSectionId,
            flash_start_frame: snapResult?.target_frame ?? cutFrame,
          },
        };
      }
    }

    if (hasParams) {
      transition.transition_params = params as TimelineTransition["transition_params"];
    }

    transitions.push(transition);

    // Build analysis pair
    const pairResult: AdjacencyPairResult = {
      pair_id: pairId,
      left_clip_id: leftClip.clip_id,
      right_clip_id: rightClip.clip_id,
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
        ...(evidence.evidence_coverage ? {
          shot_scale_continuity_score: evidence.shot_scale_continuity_score,
          composition_match_score: evidence.composition_match_score,
          axis_consistency_score: evidence.axis_consistency_score,
          evidence_coverage: evidence.evidence_coverage,
          ...(evidence.evidence_diagnostics ? { evidence_diagnostics: evidence.evidence_diagnostics } : {}),
        } : {}),
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
        visual_coherence_score: evidence.visual_coherence_score,
        visual_transition_hint: evidence.visual_transition_hint,
      },
      degraded_from_skill_id: degradedFromSkillId,
      ...(cutRelation ? { cut_relation: cutRelation } : {}),
      selection_rationale: {
        outcome: selectionOutcome,
        reason_codes: selectionReasonCodes,
        active_cards: scoredCards
          .map(scored => ({
            skill_id: scored.card.id,
            when_passed: scored.passesWhen,
            avoid_matched: !scored.passesAvoidWhen,
            viability_passed: scored.passesViability,
            viability_gates: scored.viabilityGates.map(gate => ({
              gate_id: gate.gateId,
              passed: gate.passed,
              failure_reason: gate.failureReason,
            })),
            score: roundScore(scored.score),
            threshold: scored.threshold,
            threshold_passed: scored.score >= scored.threshold,
            reason_code: !scored.passesAvoidWhen
              ? "avoid_matched" as const
              : !scored.passesWhen
                ? "when_failed" as const
                : !scored.passesViability
                  ? "viability_failed" as const
                  : scored.score < scored.threshold
                    ? "below_threshold" as const
                    : "eligible" as const,
          }))
          .sort((a, b) => a.skill_id.localeCompare(b.skill_id)),
        applied_skill_id: appliedSkillId ?? null,
        fallback_from_skill_id: degradedFromSkillId,
        ...(selectionOverride ? { override: selectionOverride } : {}),
      },
    };
    pairs.push(pairResult);

    // Track for pair_bonus_prev on next iteration
    prevSelectedSkillId = appliedSkillId ?? null;
  }

  const analysis: AdjacencyAnalysis = {
    version: "2",
    project_id: "",
    pairs,
  };

  return { transitions, analysis };
}

function applySameAssetPunchInTreatment(input: {
  activeEditingSkills: string[];
  transitionType: TransitionType;
  evidence: PairEvidence;
  rightClip: TimelineClip;
  rightCandidate?: Candidate;
}): boolean {
  if (!input.activeEditingSkills.includes("punch_in_emphasis")) return false;
  if (input.transitionType !== "cut" || !input.evidence.same_asset) return false;
  if ((input.evidence.same_asset_gap_us ?? 0) < SAME_ASSET_PUNCH_IN_MIN_GAP_US) return false;

  const signals = input.rightCandidate?.editorial_signals;
  if ((signals?.speech_intensity_score ?? 0) < 0.7 || signals?.face_detected !== true) return false;
  if (signals.visual_tags?.includes("screen_demo")) return false;
  if (typeof input.rightClip.metadata?.zoom === "number") return false;

  const metadata = input.rightClip.metadata ?? {};
  const existingEditorial = metadata.editorial && typeof metadata.editorial === "object"
    ? metadata.editorial as Record<string, unknown>
    : {};
  input.rightClip.metadata = {
    ...metadata,
    zoom: SAME_ASSET_PUNCH_IN_SCALE,
    editorial: {
      ...existingEditorial,
      camera_move: {
        type: "punch_in",
        scale: SAME_ASSET_PUNCH_IN_SCALE,
        reason: "same_asset_jump_cut",
      },
    },
  };
  return true;
}

// ── Timeline continuity hard constraints ────────────────────────────

export const DEFAULT_CONTINUITY_POLICY: ContinuityPolicy = {
  same_asset_repeat: "reorder_or_fail",
  same_cluster_repeat: "warn",
};

export interface TimelineContinuityOptions {
  candidates: Candidate[];
  beats: NormalizedBeat[];
  policy?: Partial<ContinuityPolicy>;
  reorders?: ContinuityReorderEvent[];
}

interface CandidateIndex {
  byRef: Map<string, Candidate>;
  bySegmentRange: Map<string, Candidate>;
  bySegment: Map<string, Candidate>;
}

interface OrderedClip {
  trackId: string;
  clip: TimelineClip;
}

interface RepeatRun {
  key: string;
  clips: OrderedClip[];
}

interface ExemptionState {
  exemptions: ContinuityExemption[];
  semanticClusters: Set<string>;
  assets: Set<string>;
}

export function resolveContinuityPolicy(
  policy?: Partial<ContinuityPolicy>,
): ContinuityPolicy {
  return {
    same_asset_repeat: policy?.same_asset_repeat ?? DEFAULT_CONTINUITY_POLICY.same_asset_repeat,
    same_cluster_repeat: policy?.same_cluster_repeat ?? DEFAULT_CONTINUITY_POLICY.same_cluster_repeat,
  };
}

export function evaluateTimelineContinuity(
  videoTracks: Track[],
  opts: TimelineContinuityOptions,
): ContinuityCompileMetadata {
  const policy = resolveContinuityPolicy(opts.policy);
  const ordered = orderedVideoClips(videoTracks);
  const candidateIndex = buildContinuityCandidateIndex(opts.candidates);
  const exemptionState = collectAllowRevisitExemptions(ordered, opts.beats, candidateIndex);
  const warnings: ContinuityIssue[] = [];
  const errors: ContinuityIssue[] = [];

  const assetIssues = detectNonAdjacentRepeatIssues({
    ordered,
    code: "same_asset_non_adjacent",
    severityPolicy: policy.same_asset_repeat,
    ignoredKeys: exemptionState.assets,
    keyFor: (item) => item.clip.asset_id,
    issueFieldsFor: (key) => ({ asset_id: key }),
    messageFor: (key, runs) =>
      `Continuity constraint failed: source asset ${key} appears in ${runs.length} non-adjacent timeline blocks.`,
    suggestedFix:
      "Move the repeated source asset into one contiguous beat block, choose alternate candidates upstream, or mark an intentional callback with beat.allow_revisit.",
  });
  partitionIssues(assetIssues, warnings, errors);

  const clusterIssues = detectNonAdjacentRepeatIssues({
    ordered,
    code: "same_cluster_non_adjacent",
    severityPolicy: policy.same_cluster_repeat,
    ignoredKeys: exemptionState.semanticClusters,
    keyFor: (item) => semanticClusterForClip(item.clip, candidateIndex),
    issueFieldsFor: (key) => ({ semantic_cluster_id: key }),
    messageFor: (key, runs) =>
      `Continuity warning: semantic_cluster_id ${key} appears in ${runs.length} non-adjacent timeline blocks.`,
    suggestedFix:
      "Keep each semantic cluster contiguous, choose alternate candidates upstream, or declare an intentional callback with beat.allow_revisit.",
  });
  partitionIssues(clusterIssues, warnings, errors);

  warnings.sort(compareContinuityIssues);
  errors.sort(compareContinuityIssues);

  return {
    policy,
    scope: "video_tracks",
    reorders: [...(opts.reorders ?? [])].sort(compareReorderEvents),
    exemptions: exemptionState.exemptions,
    warnings,
    errors,
  };
}

function orderedVideoClips(videoTracks: Track[]): OrderedClip[] {
  return videoTracks
    .flatMap((track) => track.clips.map((clip) => ({ trackId: track.track_id, clip })))
    .sort((a, b) =>
      a.clip.timeline_in_frame - b.clip.timeline_in_frame ||
      a.trackId.localeCompare(b.trackId) ||
      a.clip.clip_id.localeCompare(b.clip.clip_id)
    );
}

function buildContinuityCandidateIndex(candidates: Candidate[]): CandidateIndex {
  const byRef = new Map<string, Candidate>();
  const bySegmentRange = new Map<string, Candidate>();
  const bySegment = new Map<string, Candidate>();
  for (const candidate of candidates) {
    const ref = getCandidateRef(candidate);
    byRef.set(ref, candidate);
    if (candidate.candidate_id) byRef.set(candidate.candidate_id, candidate);
    byRef.set(candidate.segment_id, candidate);
    bySegmentRange.set(candidateRangeKey(candidate), candidate);
    if (!bySegment.has(candidate.segment_id)) {
      bySegment.set(candidate.segment_id, candidate);
    }
  }
  return { byRef, bySegmentRange, bySegment };
}

function candidateForContinuityClip(
  clip: TimelineClip,
  index: CandidateIndex,
): Candidate | undefined {
  if (clip.candidate_ref) {
    const byRef = index.byRef.get(clip.candidate_ref);
    if (byRef) return byRef;
  }
  return index.bySegmentRange.get(clipRangeKey(clip)) ?? index.bySegment.get(clip.segment_id);
}

function semanticClusterForClip(
  clip: TimelineClip,
  index: CandidateIndex,
): string | undefined {
  const cluster = candidateForContinuityClip(clip, index)?.editorial_signals?.semantic_cluster_id?.trim();
  return cluster || undefined;
}

function collectAllowRevisitExemptions(
  ordered: OrderedClip[],
  beats: NormalizedBeat[],
  candidateIndex: CandidateIndex,
): ExemptionState {
  const byBeat = new Map<string, OrderedClip[]>();
  for (const item of ordered) {
    const items = byBeat.get(item.clip.beat_id) ?? [];
    items.push(item);
    byBeat.set(item.clip.beat_id, items);
  }

  const exemptions: ContinuityExemption[] = [];
  const semanticClusters = new Set<string>();
  const assets = new Set<string>();

  for (const beat of beats) {
    if (!beat.allow_revisit) continue;
    const beatClips = byBeat.get(beat.beat_id) ?? [];
    const explicit = typeof beat.allow_revisit === "object" ? beat.allow_revisit : undefined;
    const semanticIds = explicit?.semantic_cluster_ids
      ? [...new Set(explicit.semantic_cluster_ids.map((id) => id.trim()).filter(Boolean))]
      : uniqueSorted(beatClips
          .map((item) => semanticClusterForClip(item.clip, candidateIndex))
          .filter((id): id is string => Boolean(id)));
    const assetIds = explicit?.asset_ids
      ? [...new Set(explicit.asset_ids.map((id) => id.trim()).filter(Boolean))]
      : uniqueSorted(beatClips.map((item) => item.clip.asset_id));

    for (const id of semanticIds) semanticClusters.add(id);
    for (const id of assetIds) assets.add(id);

    exemptions.push({
      code: "allow_revisit",
      beat_id: beat.beat_id,
      clip_ids: beatClips.map((item) => item.clip.clip_id).sort((a, b) => a.localeCompare(b)),
      ...(semanticIds.length > 0 ? { semantic_cluster_ids: semanticIds } : {}),
      ...(assetIds.length > 0 ? { asset_ids: assetIds } : {}),
      ...(explicit?.reason ? { reason: explicit.reason } : {}),
    });
  }

  exemptions.sort((a, b) => a.beat_id.localeCompare(b.beat_id));
  return { exemptions, semanticClusters, assets };
}

function detectNonAdjacentRepeatIssues(input: {
  ordered: OrderedClip[];
  code: ContinuityIssue["code"];
  severityPolicy: ContinuityRepeatPolicy;
  ignoredKeys: Set<string>;
  keyFor: (item: OrderedClip) => string | undefined;
  issueFieldsFor: (key: string) => Partial<Pick<ContinuityIssue, "asset_id" | "semantic_cluster_id">>;
  messageFor: (key: string, runs: ContinuityRun[]) => string;
  suggestedFix: string;
}): ContinuityIssue[] {
  if (input.severityPolicy === "off") return [];

  const runsByKey = new Map<string, RepeatRun[]>();
  let current: RepeatRun | undefined;
  const closeCurrent = () => {
    if (!current) return;
    const runs = runsByKey.get(current.key) ?? [];
    runs.push(current);
    runsByKey.set(current.key, runs);
    current = undefined;
  };

  for (const item of input.ordered) {
    const key = input.keyFor(item);
    if (!key || input.ignoredKeys.has(key)) {
      closeCurrent();
      continue;
    }
    if (current?.key === key) {
      current.clips.push(item);
    } else {
      closeCurrent();
      current = { key, clips: [item] };
    }
  }
  closeCurrent();

  const severity: ContinuityIssue["severity"] =
    input.severityPolicy === "reorder_or_fail" ? "error" : "warning";

  return [...runsByKey.entries()]
    .filter(([, runs]) => runs.length > 1)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, repeatRuns]) => {
      const runs = repeatRuns.map((run) => toContinuityRun(run.clips));
      return {
        code: input.code,
        severity,
        key,
        ...input.issueFieldsFor(key),
        runs,
        message: input.messageFor(key, runs),
        suggested_fix: input.suggestedFix,
      };
    });
}

function toContinuityRun(items: OrderedClip[]): ContinuityRun {
  const clips = items.map((item) => item.clip);
  return {
    track_ids: uniqueSorted(items.map((item) => item.trackId)),
    beat_ids: uniqueSorted(clips.map((clip) => clip.beat_id)),
    clip_ids: clips.map((clip) => clip.clip_id).sort((a, b) => a.localeCompare(b)),
    segment_ids: uniqueSorted(clips.map((clip) => clip.segment_id)),
    asset_ids: uniqueSorted(clips.map((clip) => clip.asset_id)),
    start_frame: Math.min(...clips.map((clip) => clip.timeline_in_frame)),
    end_frame: Math.max(...clips.map((clip) => clip.timeline_in_frame + clip.timeline_duration_frames)),
  };
}

function partitionIssues(
  issues: ContinuityIssue[],
  warnings: ContinuityIssue[],
  errors: ContinuityIssue[],
): void {
  for (const issue of issues) {
    if (issue.severity === "error") {
      errors.push(issue);
    } else {
      warnings.push(issue);
    }
  }
}

function compareContinuityIssues(a: ContinuityIssue, b: ContinuityIssue): number {
  return a.code.localeCompare(b.code) || a.key.localeCompare(b.key);
}

function compareReorderEvents(a: ContinuityReorderEvent, b: ContinuityReorderEvent): number {
  return a.track_id.localeCompare(b.track_id) ||
    a.beat_id.localeCompare(b.beat_id) ||
    a.code.localeCompare(b.code);
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

function candidateRangeKey(candidate: Candidate): string {
  return `${candidate.segment_id}:${candidate.src_in_us}:${candidate.src_out_us}`;
}

function clipRangeKey(clip: TimelineClip): string {
  return `${clip.segment_id}:${clip.src_in_us}:${clip.src_out_us}`;
}

function roundScore(value: number): number {
  return Math.round(value * 1000) / 1000;
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
  minDurationFrames = 1,
): boolean {
  if (leftClip.media_kind === "image" || rightClip.media_kind === "image") return false;
  if (snapDeltaFrames === 0) return true;

  const usPerFrame = 1_000_000 / fpsNum;
  const absDelta = Math.abs(snapDeltaFrames);
  const minFrames = Math.max(1, Math.floor(minDurationFrames));

  // Guard: both clips must remain renderable after pair-preserving reallocation.
  if (snapDeltaFrames > 0) {
    if (rightClip.timeline_duration_frames - absDelta < minFrames) return false;
  } else {
    if (leftClip.timeline_duration_frames - absDelta < minFrames) return false;
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
