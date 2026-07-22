import type { SegmentEvidence } from "../artifacts/segment-editorial-evidence.js";
import type {
  CutRelationAxis,
  CutRelationResult,
  CutRelationSignal,
  EvidenceCoverageStatus,
  ExplicitIntentEvidence,
  FieldEvidenceCoverage,
  SegmentEvidenceConfidenceGroup,
} from "./transition-types.js";

export const CUT_RELATION_THRESHOLDS = {
  minimum_comparable_axes: 4,
  minimum_continuity_matches: 3,
  minimum_major_discontinuities: 2,
  minimum_observation_confidence: 0.6,
  luma_match_delta_max: 0.12,
  luma_major_jump_delta_min: 0.35,
  color_match_overlap_min: 0.5,
  color_major_jump_overlap_max: 0.2,
  tag_match_overlap_min: 0.5,
  tag_jump_overlap_max: 0.2,
  visual_match_similarity_min: 0.75,
  visual_low_similarity_max: 0.35,
} as const;

const AXES: CutRelationAxis[] = [
  "shot_scale",
  "composition",
  "gaze_axis",
  "motion_flow",
  "luma",
  "dominant_color",
  "asset_identity",
  "visual_coherence",
  "visual_tags",
  "subject_type",
  "text_presence",
  "story_boundary",
];

const CONTINUITY_AXES = new Set<CutRelationAxis>(AXES.filter((axis) => axis !== "story_boundary"));
const CONTRAST_CRAFT_INTENTS = new Set(["hard_cut", "dissolve", "dip_to_black"]);
const HUMAN_ANNOTATION_CONTRAST_INTENT = "intentional_contrast";

type ObservationField = keyof SegmentEvidence["adjacency_features"];

export interface CutRelationSide {
  asset_id: string;
  beat_id: string;
  story_role?: string;
  evidence?: SegmentEvidence;
}

export interface CutRelationClassifierInput {
  left: CutRelationSide;
  right: CutRelationSide;
  visual_coherence_score?: number;
  explicit_intent_evidence?: ExplicitIntentEvidence[];
}

interface Component {
  field: ObservationField;
  group: SegmentEvidenceConfidenceGroup;
}

interface ComparableComponent {
  field: ObservationField;
  left: unknown;
  right: unknown;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function round2(value: number): number {
  return Math.round(clamp01(value) * 100) / 100;
}

function valueOrNull(value: unknown): unknown {
  return value === undefined ? null : value;
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function coverageForField(
  evidence: SegmentEvidence | undefined,
  field: ObservationField,
): EvidenceCoverageStatus {
  const explicit = evidence?.coverage?.[field as keyof NonNullable<SegmentEvidence["coverage"]>];
  if (explicit) return explicit;
  const value = evidence?.adjacency_features[field];
  if (value === "unknown") return "unknown";
  if (value === "not_applicable") return "not_applicable";
  if (value === undefined) return "missing";
  if (Array.isArray(value) && value.length === 0) return "not_applicable";
  return "known";
}

function pairCoverage(left: EvidenceCoverageStatus, right: EvidenceCoverageStatus): EvidenceCoverageStatus {
  if (left === "missing" || right === "missing") return "missing";
  if (left === "not_applicable" || right === "not_applicable") return "not_applicable";
  if (left === "unknown" || right === "unknown") return "unknown";
  return "known";
}

function groupConfidence(
  evidence: SegmentEvidence | undefined,
  group: SegmentEvidenceConfidenceGroup,
): number | null {
  return evidence?.confidence?.[group]?.score ?? null;
}

function groupRefs(
  evidence: SegmentEvidence | undefined,
  group: SegmentEvidenceConfidenceGroup,
  fields: ObservationField[],
): string[] {
  const fieldRefs = fields
    .filter((field) => coverageForField(evidence, field) !== "missing")
    .map((field) => `editorial_observation.${field}`);
  return uniqueSorted([...fieldRefs, ...(evidence?.confidence?.[group]?.evidence_refs ?? [])]);
}

function hasLowConfidence(value: number): boolean {
  return value < CUT_RELATION_THRESHOLDS.minimum_observation_confidence;
}

function aggregateSideCoverage(values: EvidenceCoverageStatus[]): EvidenceCoverageStatus {
  if (values.includes("known")) return "known";
  if (values.includes("unknown")) return "unknown";
  if (values.includes("not_applicable")) return "not_applicable";
  return "missing";
}

function componentSignal(
  input: CutRelationClassifierInput,
  components: Component[],
  evaluate: (components: ComparableComponent[]) => Pick<CutRelationSignal, "evaluation" | "major_discontinuity" | "reason_codes">,
): CutRelationSignal {
  const leftRaw: Record<string, unknown> = {};
  const rightRaw: Record<string, unknown> = {};
  const leftCoverage: EvidenceCoverageStatus[] = [];
  const rightCoverage: EvidenceCoverageStatus[] = [];
  const comparable: ComparableComponent[] = [];
  const comparableGroups = new Set<SegmentEvidenceConfidenceGroup>();
  let excludedForMissingConfidence = false;
  let excludedForBelowThreshold = false;

  for (const component of components) {
    const leftStatus = coverageForField(input.left.evidence, component.field);
    const rightStatus = coverageForField(input.right.evidence, component.field);
    const leftValue = input.left.evidence?.adjacency_features[component.field];
    const rightValue = input.right.evidence?.adjacency_features[component.field];
    const leftConfidence = groupConfidence(input.left.evidence, component.group);
    const rightConfidence = groupConfidence(input.right.evidence, component.group);
    leftRaw[component.field] = valueOrNull(leftValue);
    rightRaw[component.field] = valueOrNull(rightValue);
    leftCoverage.push(leftStatus);
    rightCoverage.push(rightStatus);
    if (pairCoverage(leftStatus, rightStatus) !== "known") continue;
    if (leftConfidence === null || rightConfidence === null) {
      excludedForMissingConfidence = true;
      continue;
    }
    if (hasLowConfidence(leftConfidence) || hasLowConfidence(rightConfidence)) {
      excludedForBelowThreshold = true;
      continue;
    }
    comparable.push({ field: component.field, left: leftValue, right: rightValue });
    comparableGroups.add(component.group);
  }

  const rawCoverage: FieldEvidenceCoverage = {
    left: aggregateSideCoverage(leftCoverage),
    right: aggregateSideCoverage(rightCoverage),
    pair: pairCoverage(aggregateSideCoverage(leftCoverage), aggregateSideCoverage(rightCoverage)),
  };
  const groups = uniqueSorted(components.map((component) => component.group)) as SegmentEvidenceConfidenceGroup[];
  const scoredGroups = comparableGroups.size > 0 ? [...comparableGroups] : groups;
  const leftScores = scoredGroups.map((group) => groupConfidence(input.left.evidence, group)).filter((value): value is number => value !== null);
  const rightScores = scoredGroups.map((group) => groupConfidence(input.right.evidence, group)).filter((value): value is number => value !== null);
  const leftScore = leftScores.length > 0 ? Math.min(...leftScores) : null;
  const rightScore = rightScores.length > 0 ? Math.min(...rightScores) : null;
  const refsForSide = (side: "left" | "right"): string[] => {
    const evidence = input[side].evidence;
    return uniqueSorted(groups.flatMap((group) => groupRefs(
      evidence,
      group,
      components.filter((component) => component.group === group).map((component) => component.field),
    )));
  };
  const confidenceReasonCodes = [
    ...(excludedForMissingConfidence ? ["observation_confidence_missing"] : []),
    ...(excludedForBelowThreshold ? ["observation_confidence_below_threshold"] : []),
  ];

  if (comparable.length === 0) {
    return {
      coverage: confidenceReasonCodes.length > 0 ? "low_confidence" : rawCoverage.pair,
      evaluation: "unknown",
      major_discontinuity: false,
      raw: { left: leftRaw, right: rightRaw },
      raw_coverage: rawCoverage,
      source_refs: {
        left: refsForSide("left"),
        right: refsForSide("right"),
      },
      confidence: { left: leftScore, right: rightScore },
      reason_codes: confidenceReasonCodes.length > 0 ? confidenceReasonCodes : [`axis_${rawCoverage.pair}`],
    };
  }

  const result = evaluate(comparable);
  const reasonCodes = [...result.reason_codes, ...confidenceReasonCodes];
  return {
    coverage: "known",
    ...result,
    reason_codes: reasonCodes,
    raw: { left: leftRaw, right: rightRaw },
    raw_coverage: rawCoverage,
    source_refs: {
      left: refsForSide("left"),
      right: refsForSide("right"),
    },
    confidence: { left: leftScore, right: rightScore },
  };
}

function directSignal(options: {
  left: unknown;
  right: unknown;
  pair?: unknown;
  leftCoverage: EvidenceCoverageStatus;
  rightCoverage: EvidenceCoverageStatus;
  leftRefs: string[];
  rightRefs: string[];
  evaluate: () => Pick<CutRelationSignal, "evaluation" | "major_discontinuity" | "reason_codes">;
}): CutRelationSignal {
  const raw = {
    left: valueOrNull(options.left),
    right: valueOrNull(options.right),
    ...(options.pair !== undefined ? { pair: options.pair } : {}),
  };
  const rawCoverage = {
    left: options.leftCoverage,
    right: options.rightCoverage,
    pair: pairCoverage(options.leftCoverage, options.rightCoverage),
  };
  if (rawCoverage.pair !== "known") {
    return {
      coverage: rawCoverage.pair,
      evaluation: "unknown",
      major_discontinuity: false,
      raw,
      raw_coverage: rawCoverage,
      source_refs: { left: options.leftRefs, right: options.rightRefs },
      confidence: { left: null, right: null },
      reason_codes: [`axis_${rawCoverage.pair}`],
    };
  }
  return {
    coverage: "known",
    ...options.evaluate(),
    raw,
    raw_coverage: rawCoverage,
    source_refs: { left: options.leftRefs, right: options.rightRefs },
    confidence: { left: null, right: null },
  };
}

const SHOT_SCALE_RANK: Record<string, number> = {
  extreme_close: 0,
  extreme_close_up: 0,
  close: 1,
  close_up: 1,
  medium_close: 2,
  medium_close_up: 2,
  medium: 3,
  medium_wide: 4,
  wide: 5,
  extreme_wide: 6,
};

function shotScaleSignal(input: CutRelationClassifierInput): CutRelationSignal {
  return componentSignal(input, [{ field: "shot_scale", group: "framing" }], ([component]) => {
    const leftRank = SHOT_SCALE_RANK[String(component.left)];
    const rightRank = SHOT_SCALE_RANK[String(component.right)];
    if (leftRank === undefined || rightRank === undefined) {
      return { evaluation: "neutral", major_discontinuity: false, reason_codes: ["shot_scale_rank_unsupported"] };
    }
    const delta = Math.abs(leftRank - rightRank);
    if (delta === 0) return { evaluation: "match", major_discontinuity: false, reason_codes: ["shot_scale_matched"] };
    if (delta === 1) return { evaluation: "match", major_discontinuity: false, reason_codes: ["shot_scale_adjacent"] };
    return {
      evaluation: "contrast",
      major_discontinuity: delta >= 3,
      reason_codes: [delta >= 3 ? "shot_scale_major_jump" : "shot_scale_minor_jump"],
    };
  });
}

function isOpposite(left: unknown, right: unknown, pairs: Array<[string, string]>): boolean {
  return pairs.some(([a, b]) => (left === a && right === b) || (left === b && right === a));
}

function spatialSignal(
  input: CutRelationClassifierInput,
  components: Component[],
  oppositePairs: Array<[string, string]>,
  prefix: string,
): CutRelationSignal {
  return componentSignal(input, components, (comparable) => {
    const opposite = comparable.filter((item) => isOpposite(item.left, item.right, oppositePairs));
    if (opposite.length > 0) {
      return {
        evaluation: "contrast",
        major_discontinuity: true,
        reason_codes: uniqueSorted(opposite.map((item) => `${prefix}_${item.field}_opposed`)),
      };
    }
    const mismatches = comparable.filter((item) => item.left !== item.right);
    if (mismatches.length > 0) {
      return {
        evaluation: "contrast",
        major_discontinuity: false,
        reason_codes: uniqueSorted(mismatches.map((item) => `${prefix}_${item.field}_changed`)),
      };
    }
    return { evaluation: "match", major_discontinuity: false, reason_codes: [`${prefix}_matched`] };
  });
}

function motionSignal(input: CutRelationClassifierInput): CutRelationSignal {
  const components: Component[] = [
    { field: "motion_type", group: "motion" },
    { field: "camera_motion_direction", group: "direction" },
    { field: "subject_motion_direction", group: "direction" },
  ];
  return componentSignal(input, components, (comparable) => {
    const reasons: string[] = [];
    let breaks = 0;
    let matches = 0;
    let major = false;
    for (const item of comparable) {
      if (item.left === item.right) {
        matches += 1;
        reasons.push(`motion_${item.field}_matched`);
        continue;
      }
      const opposed = isOpposite(item.left, item.right, [
        ["left", "right"], ["up", "down"], ["toward_camera", "away_from_camera"],
      ]);
      const staticRapid = item.field === "motion_type" && isOpposite(item.left, item.right, [
        ["static", "rapid"], ["static", "fast_action"], ["subtle", "rapid"], ["subtle", "fast_action"],
      ]);
      if (opposed || staticRapid) {
        breaks += 1;
        major ||= staticRapid;
        reasons.push(`motion_${item.field}_${staticRapid ? "energy_jump" : "opposed"}`);
      } else {
        reasons.push(`motion_${item.field}_changed`);
      }
    }
    if (breaks > 0) {
      return { evaluation: "contrast", major_discontinuity: major || breaks >= 2, reason_codes: uniqueSorted(reasons) };
    }
    if (matches > 0 && comparable.length === matches) {
      return { evaluation: "match", major_discontinuity: false, reason_codes: uniqueSorted(reasons) };
    }
    return { evaluation: "neutral", major_discontinuity: false, reason_codes: uniqueSorted(reasons) };
  });
}

function normalizedOverlap(left: unknown, right: unknown): number | undefined {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length === 0 || right.length === 0) return undefined;
  const leftSet = new Set(left.filter((item): item is string => typeof item === "string").map((item) => item.trim().toLowerCase()).filter(Boolean));
  const rightSet = new Set(right.filter((item): item is string => typeof item === "string").map((item) => item.trim().toLowerCase()).filter(Boolean));
  if (leftSet.size === 0 || rightSet.size === 0) return undefined;
  let intersection = 0;
  for (const item of leftSet) if (rightSet.has(item)) intersection += 1;
  return intersection / (leftSet.size + rightSet.size - intersection);
}

function overlapSignal(
  input: CutRelationClassifierInput,
  field: "dominant_colors" | "visual_tags",
  group: "appearance" | "tags",
  matchThreshold: number,
  jumpThreshold: number,
  prefix: string,
  major: boolean,
): CutRelationSignal {
  return componentSignal(input, [{ field, group }], ([component]) => {
    const overlap = normalizedOverlap(component.left, component.right);
    if (overlap === undefined) return { evaluation: "neutral", major_discontinuity: false, reason_codes: [`${prefix}_not_comparable`] };
    if (overlap >= matchThreshold) return { evaluation: "match", major_discontinuity: false, reason_codes: [`${prefix}_matched`] };
    if (overlap <= jumpThreshold) return { evaluation: "contrast", major_discontinuity: major, reason_codes: [`${prefix}_jump`] };
    return { evaluation: "neutral", major_discontinuity: false, reason_codes: [`${prefix}_partial_overlap`] };
  });
}

function lumaSignal(input: CutRelationClassifierInput): CutRelationSignal {
  return componentSignal(input, [{ field: "avg_luma", group: "appearance" }], ([component]) => {
    const delta = Math.abs(Number(component.left) - Number(component.right));
    if (delta <= CUT_RELATION_THRESHOLDS.luma_match_delta_max) {
      return { evaluation: "match", major_discontinuity: false, reason_codes: ["luma_matched"] };
    }
    if (delta >= CUT_RELATION_THRESHOLDS.luma_major_jump_delta_min) {
      return { evaluation: "contrast", major_discontinuity: true, reason_codes: ["luma_major_jump"] };
    }
    return { evaluation: "neutral", major_discontinuity: false, reason_codes: ["luma_changed"] };
  });
}

function subjectTypeSignal(input: CutRelationClassifierInput): CutRelationSignal {
  return componentSignal(input, [{ field: "dominant_subject_type", group: "appearance" }], ([component]) => (
    component.left === component.right
      ? { evaluation: "match", major_discontinuity: false, reason_codes: ["subject_type_matched"] }
      : { evaluation: "contrast", major_discontinuity: false, reason_codes: ["subject_type_changed"] }
  ));
}

function textSignal(input: CutRelationClassifierInput): CutRelationSignal {
  return componentSignal(input, [{ field: "text_presence", group: "text" }], ([component]) => (
    component.left === component.right
      ? { evaluation: "match", major_discontinuity: false, reason_codes: ["text_presence_matched"] }
      : { evaluation: "contrast", major_discontinuity: true, reason_codes: ["text_presence_changed"] }
  ));
}

function visualCoherenceSignal(input: CutRelationClassifierInput): CutRelationSignal {
  const score = input.visual_coherence_score;
  const known = typeof score === "number" && Number.isFinite(score);
  return directSignal({
    left: undefined,
    right: undefined,
    pair: known ? round2(score) : undefined,
    leftCoverage: known ? "known" : "missing",
    rightCoverage: known ? "known" : "missing",
    leftRefs: known ? ["visual_embedding.cosine_similarity"] : [],
    rightRefs: known ? ["visual_embedding.cosine_similarity"] : [],
    evaluate: () => {
      if ((score ?? 0) >= CUT_RELATION_THRESHOLDS.visual_match_similarity_min) {
        return { evaluation: "match", major_discontinuity: false, reason_codes: ["visual_coherence_matched"] };
      }
      if ((score ?? 1) <= CUT_RELATION_THRESHOLDS.visual_low_similarity_max) {
        return { evaluation: "contrast", major_discontinuity: false, reason_codes: ["low_visual_similarity"] };
      }
      return { evaluation: "neutral", major_discontinuity: false, reason_codes: ["visual_coherence_neutral"] };
    },
  });
}

function buildSignals(input: CutRelationClassifierInput): Record<CutRelationAxis, CutRelationSignal> {
  return {
    shot_scale: shotScaleSignal(input),
    composition: spatialSignal(input, [
      { field: "composition_anchor", group: "framing" },
      { field: "screen_side", group: "framing" },
    ], [["left", "right"], ["center_left", "center_right"]], "composition"),
    gaze_axis: spatialSignal(input, [
      { field: "gaze_direction", group: "direction" },
      { field: "camera_axis", group: "direction" },
    ], [["left", "right"], ["screen_left", "screen_right"], ["axis_left", "axis_right"], ["ltr", "rtl"]], "gaze_axis"),
    motion_flow: motionSignal(input),
    luma: lumaSignal(input),
    dominant_color: overlapSignal(
      input, "dominant_colors", "appearance",
      CUT_RELATION_THRESHOLDS.color_match_overlap_min,
      CUT_RELATION_THRESHOLDS.color_major_jump_overlap_max,
      "dominant_color", true,
    ),
    asset_identity: directSignal({
      left: input.left.asset_id,
      right: input.right.asset_id,
      leftCoverage: "known",
      rightCoverage: "known",
      leftRefs: ["timeline_clip.asset_id"],
      rightRefs: ["timeline_clip.asset_id"],
      evaluate: () => input.left.asset_id === input.right.asset_id
        ? { evaluation: "match", major_discontinuity: false, reason_codes: ["same_asset"] }
        : { evaluation: "neutral", major_discontinuity: false, reason_codes: ["different_asset"] },
    }),
    visual_coherence: visualCoherenceSignal(input),
    visual_tags: overlapSignal(
      input, "visual_tags", "tags",
      CUT_RELATION_THRESHOLDS.tag_match_overlap_min,
      CUT_RELATION_THRESHOLDS.tag_jump_overlap_max,
      "visual_tag", false,
    ),
    subject_type: subjectTypeSignal(input),
    text_presence: textSignal(input),
    story_boundary: directSignal({
      left: { beat_id: input.left.beat_id, story_role: input.left.story_role ?? null },
      right: { beat_id: input.right.beat_id, story_role: input.right.story_role ?? null },
      leftCoverage: input.left.beat_id ? "known" : "missing",
      rightCoverage: input.right.beat_id ? "known" : "missing",
      leftRefs: input.left.beat_id
        ? ["timeline_clip.beat_id", ...(input.left.story_role ? [`edit_blueprint.beats.${input.left.beat_id}.story_role`] : [])]
        : [],
      rightRefs: input.right.beat_id
        ? ["timeline_clip.beat_id", ...(input.right.story_role ? [`edit_blueprint.beats.${input.right.beat_id}.story_role`] : [])]
        : [],
      evaluate: () => input.left.beat_id === input.right.beat_id
        ? { evaluation: "match", major_discontinuity: false, reason_codes: ["within_beat"] }
        : {
          evaluation: "neutral",
          major_discontinuity: false,
          reason_codes: [
            input.left.story_role && input.right.story_role && input.left.story_role !== input.right.story_role
              ? "story_role_boundary"
              : "beat_boundary",
          ],
        },
    }),
  };
}

/** Pure, deterministic cut-relation classifier. It has no model, DB, network, or filesystem boundary. */
export function classifyCutRelation(input: CutRelationClassifierInput): CutRelationResult {
  const signals = buildSignals(input);
  const providedIntent = [...(input.explicit_intent_evidence ?? [])]
    .sort((left, right) => left.source_ref.localeCompare(right.source_ref) || left.intent.localeCompare(right.intent));
  const explicitIntent = providedIntent.filter((item) => {
    if (item.source === "human_annotation") return item.intent === HUMAN_ANNOTATION_CONTRAST_INTENT;
    return CONTRAST_CRAFT_INTENTS.has(item.intent);
  });
  const excludedNonContrastIntent = explicitIntent.length !== providedIntent.length;
  const conflictingExplicitIntent = new Set(explicitIntent.map((item) => item.intent)).size > 1;
  const hasUsableExplicitIntent = explicitIntent.length > 0 && !conflictingExplicitIntent;
  const comparableAxisIds = AXES.filter((axis) => signals[axis].coverage === "known");
  const missingAxisIds = AXES.filter((axis) => signals[axis].coverage === "missing");
  const unknownAxisIds = AXES.filter((axis) => signals[axis].coverage === "unknown");
  const notApplicableAxisIds = AXES.filter((axis) => signals[axis].coverage === "not_applicable");
  const lowConfidenceAxisIds = AXES.filter((axis) =>
    signals[axis].coverage === "low_confidence" ||
    signals[axis].reason_codes.includes("observation_confidence_missing") ||
    signals[axis].reason_codes.includes("observation_confidence_below_threshold")
  );
  const hasMissingObservationConfidence = AXES.some((axis) =>
    signals[axis].reason_codes.includes("observation_confidence_missing")
  );
  const hasBelowThresholdObservationConfidence = AXES.some((axis) =>
    signals[axis].reason_codes.includes("observation_confidence_below_threshold")
  );
  const majorBreaks = AXES.filter((axis) => signals[axis].major_discontinuity);
  const contrastAxes = AXES.filter((axis) => signals[axis].evaluation === "contrast");
  const continuityMatches = AXES.filter((axis) =>
    CONTINUITY_AXES.has(axis) && signals[axis].evaluation === "match"
  );
  const sufficientCoverage = comparableAxisIds.length >= CUT_RELATION_THRESHOLDS.minimum_comparable_axes;
  const sufficientMeasuredBreak = majorBreaks.length >= CUT_RELATION_THRESHOLDS.minimum_major_discontinuities;

  let relationship: CutRelationResult["relationship"] = "unknown";
  let confidence = sufficientCoverage ? 0.4 : 0.25;
  const reasonCodes: string[] = [];

  if (!sufficientCoverage) {
    reasonCodes.push("insufficient_comparable_axes");
  } else if (sufficientMeasuredBreak && hasUsableExplicitIntent) {
    relationship = "intentional_contrast";
    confidence = 0.9;
    reasonCodes.push("major_discontinuity_detected", "explicit_pair_intent_present");
  } else if (sufficientMeasuredBreak) {
    relationship = "risky_jump";
    confidence = 0.8;
    reasonCodes.push("major_discontinuity_detected", "measured_contrast_without_explicit_intent");
  } else if (
    contrastAxes.length === 0 &&
    continuityMatches.length >= CUT_RELATION_THRESHOLDS.minimum_continuity_matches
  ) {
    relationship = "continuous";
    confidence = 0.8;
    reasonCodes.push("sufficient_continuity_evidence", "no_major_unexplained_break");
  } else {
    reasonCodes.push("mixed_or_ambiguous_evidence");
  }

  if (explicitIntent.length > 0 && !sufficientMeasuredBreak) {
    reasonCodes.push("explicit_intent_without_measured_contrast");
  }
  if (conflictingExplicitIntent) {
    reasonCodes.push("conflicting_explicit_intent");
  }
  if (excludedNonContrastIntent) {
    reasonCodes.push("non_contrast_intent_excluded");
  }
  if (hasMissingObservationConfidence) {
    reasonCodes.push("observation_confidence_missing");
  }
  if (hasBelowThresholdObservationConfidence) {
    reasonCodes.push("observation_confidence_below_threshold");
  }
  if (lowConfidenceAxisIds.length > 0) {
    reasonCodes.push("low_confidence_evidence_excluded");
  }
  if (contrastAxes.length === 1 && contrastAxes[0] === "visual_coherence") {
    reasonCodes.push("visual_similarity_only_insufficient");
  }

  return {
    relationship,
    confidence,
    coverage: {
      total_axes: AXES.length,
      comparable_axes: comparableAxisIds.length,
      comparable_axis_ids: comparableAxisIds,
      missing_axis_ids: missingAxisIds,
      unknown_axis_ids: unknownAxisIds,
      not_applicable_axis_ids: notApplicableAxisIds,
      low_confidence_axis_ids: lowConfidenceAxisIds,
    },
    reason_codes: reasonCodes,
    explicit_intent_evidence: explicitIntent,
    signals,
  };
}
