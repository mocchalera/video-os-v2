import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
const Ajv2020 = require("ajv/dist/2020") as new (
  opts?: Record<string, unknown>,
) => import("ajv").default;
import { classifyCutRelation } from "../runtime/compiler/cut-relation.js";
import { adjacencyDecide } from "../runtime/compiler/adjacency.js";
import type { SegmentEvidence } from "../runtime/artifacts/segment-editorial-evidence.js";
import type {
  AdjacencyFeatures,
  EvidenceCoverageStatus,
  SegmentEvidenceConfidenceGroup,
  SegmentEvidenceCoverage,
} from "../runtime/compiler/transition-types.js";

const COVERAGE_FIELDS = [
  "visual_tags", "motion_type", "shot_scale", "composition_anchor", "screen_side", "gaze_direction", "camera_axis",
  "camera_motion_direction", "subject_motion_direction", "dominant_subject_type", "avg_luma", "dominant_colors", "text_presence",
] as const;

function evidence(
  values: Partial<AdjacencyFeatures>,
  scores: Partial<Record<SegmentEvidenceConfidenceGroup, number>> = {},
  overrides: Partial<SegmentEvidenceCoverage> = {},
): SegmentEvidence {
  const adjacency_features: AdjacencyFeatures = {
    visual_tags: values.visual_tags ?? [],
    motion_type: values.motion_type ?? "unknown",
    ...values,
  };
  const coverage = Object.fromEntries(COVERAGE_FIELDS.map((field) => {
    const value = adjacency_features[field];
    let status: EvidenceCoverageStatus = "missing";
    if (value === "unknown") status = "unknown";
    else if (value === "not_applicable") status = "not_applicable";
    else if (value !== undefined && (!Array.isArray(value) || value.length > 0)) status = "known";
    return [field, overrides[field] ?? status];
  })) as SegmentEvidenceCoverage;
  return {
    adjacency_features,
    coverage,
    confidence: Object.fromEntries(Object.entries(scores).map(([group, score]) => [group, {
      score,
      evidence_refs: [`fixture:${group}`],
    }])),
  };
}

const MATCHING_VALUES: Partial<AdjacencyFeatures> = {
  visual_tags: ["person", "desk"],
  motion_type: "continuous",
  camera_motion_direction: "right",
  subject_motion_direction: "right",
  shot_scale: "medium",
  composition_anchor: "left",
  screen_side: "left",
  gaze_direction: "screen_right",
  camera_axis: "axis_left",
  dominant_subject_type: "person",
  avg_luma: 0.5,
  dominant_colors: ["blue", "white"],
  text_presence: "absent",
};

const HIGH_CONFIDENCE = {
  tags: 0.9,
  motion: 0.9,
  framing: 0.9,
  direction: 0.9,
  appearance: 0.9,
  text: 0.9,
} as const;

function matchingInput() {
  return {
    left: { asset_id: "AST_SHARED", beat_id: "B01", evidence: evidence(MATCHING_VALUES, HIGH_CONFIDENCE) },
    right: { asset_id: "AST_SHARED", beat_id: "B01", evidence: evidence(MATCHING_VALUES, HIGH_CONFIDENCE) },
  };
}

function contrastInput() {
  return {
    left: { asset_id: "AST_LEFT", beat_id: "B01", evidence: evidence(MATCHING_VALUES, HIGH_CONFIDENCE) },
    right: {
      asset_id: "AST_RIGHT",
      beat_id: "B02",
      evidence: evidence({
        visual_tags: ["landscape", "night"],
        motion_type: "rapid",
        camera_motion_direction: "left",
        subject_motion_direction: "left",
        shot_scale: "wide",
        composition_anchor: "right",
        screen_side: "right",
        gaze_direction: "screen_left",
        camera_axis: "axis_right",
        dominant_subject_type: "landscape",
        avg_luma: 0.95,
        dominant_colors: ["orange", "black"],
        text_presence: "present",
      }, HIGH_CONFIDENCE),
    },
  };
}

describe("classifyCutRelation", () => {
  it("classifies sufficiently supported matches as continuous", () => {
    const result = classifyCutRelation(matchingInput());
    expect(result.relationship).toBe("continuous");
    expect(result.confidence).toBe(0.8);
    expect(result.reason_codes).toEqual(["sufficient_continuity_evidence", "no_major_unexplained_break"]);
  });

  it("classifies sufficiently covered unexplained discontinuities as risky_jump", () => {
    const result = classifyCutRelation(contrastInput());
    expect(result.relationship).toBe("risky_jump");
    expect(result.reason_codes).toContain("measured_contrast_without_explicit_intent");
  });

  it("requires measured contrast as well as pair-specific authored craft for intentional_contrast", () => {
    const result = classifyCutRelation({
      ...contrastInput(),
      explicit_intent_evidence: [{
        source: "beat_craft",
        source_ref: "edit_blueprint.beats.B01.craft.transition_out",
        intent: "hard_cut",
      }],
    });
    expect(result.relationship).toBe("intentional_contrast");
    expect(result.explicit_intent_evidence).toEqual([{
      source: "beat_craft",
      source_ref: "edit_blueprint.beats.B01.craft.transition_out",
      intent: "hard_cut",
    }]);

    const intentOnly = classifyCutRelation({
      left: { asset_id: "A", beat_id: "B01" },
      right: { asset_id: "B", beat_id: "B02" },
      explicit_intent_evidence: result.explicit_intent_evidence,
    });
    expect(intentOnly.relationship).toBe("unknown");
    expect(intentOnly.reason_codes).toContain("explicit_intent_without_measured_contrast");
  });

  it.each([
    { intent: "intentional_contrast", relationship: "intentional_contrast", intentUsed: true },
    { intent: "match_cut", relationship: "risky_jump", intentUsed: false },
    { intent: "keep_continuity", relationship: "risky_jump", intentUsed: false },
  ] as const)("classifies major breaks with human annotation $intent as $relationship", ({ intent, relationship, intentUsed }) => {
    const result = classifyCutRelation({
      ...contrastInput(),
      explicit_intent_evidence: [{
        source: "human_annotation",
        source_ref: "annotations.cut-pair-01",
        intent,
      }],
    });

    expect(result.relationship).toBe(relationship);
    expect(result.explicit_intent_evidence).toEqual(intentUsed ? [{
      source: "human_annotation",
      source_ref: "annotations.cut-pair-01",
      intent,
    }] : []);
    if (intentUsed) {
      expect(result.reason_codes).toContain("explicit_pair_intent_present");
      expect(result.reason_codes).not.toContain("non_contrast_intent_excluded");
    } else {
      expect(result.reason_codes).toContain("non_contrast_intent_excluded");
    }
  });

  it("returns unknown when comparable observation coverage is missing", () => {
    const result = classifyCutRelation({
      left: { asset_id: "A", beat_id: "B01" },
      right: { asset_id: "B", beat_id: "B02" },
    });
    expect(result.relationship).toBe("unknown");
    expect(result.coverage.comparable_axes).toBe(2);
    expect(result.reason_codes).toContain("insufficient_comparable_axes");
  });

  it("excludes low-confidence gaze and axis evidence from a hard continuity failure", () => {
    const left = evidence({
      shot_scale: "medium",
      gaze_direction: "screen_right",
      camera_axis: "axis_left",
      avg_luma: 0.5,
    }, { framing: 0.9, direction: 0.4, appearance: 0.9 });
    const right = evidence({
      shot_scale: "medium",
      gaze_direction: "screen_left",
      camera_axis: "axis_right",
      avg_luma: 0.52,
    }, { framing: 0.9, direction: 0.4, appearance: 0.9 });
    const result = classifyCutRelation({
      left: { asset_id: "AST_SHARED", beat_id: "B01", evidence: left },
      right: { asset_id: "AST_SHARED", beat_id: "B01", evidence: right },
    });
    expect(result.relationship).not.toBe("risky_jump");
    expect(result.signals.gaze_axis.coverage).toBe("low_confidence");
    expect(result.reason_codes).toContain("low_confidence_evidence_excluded");
  });

  it("does not turn low visual similarity alone into contrast or risk", () => {
    const result = classifyCutRelation({
      left: { asset_id: "A", beat_id: "B01" },
      right: { asset_id: "B", beat_id: "B02" },
      visual_coherence_score: 0.1,
    });
    expect(result.relationship).toBe("unknown");
    expect(result.reason_codes).toContain("visual_similarity_only_insufficient");
    expect(result.signals.visual_coherence.major_discontinuity).toBe(false);
  });

  it("uses same-asset identity as one real match without treating it as sufficient alone", () => {
    const result = classifyCutRelation(matchingInput());
    expect(result.relationship).toBe("continuous");
    expect(result.signals.asset_identity).toMatchObject({
      coverage: "known",
      evaluation: "match",
      reason_codes: ["same_asset"],
    });

    const sameAssetOnly = classifyCutRelation({
      left: { asset_id: "AST_SHARED", beat_id: "B01" },
      right: { asset_id: "AST_SHARED", beat_id: "B01" },
    });
    expect(sameAssetOnly.relationship).toBe("unknown");
  });

  it("tracks luma, color, and text changes as raw covered signals", () => {
    const result = classifyCutRelation(contrastInput());
    expect(result.relationship).toBe("risky_jump");
    expect(result.signals.luma).toMatchObject({ coverage: "known", evaluation: "contrast", major_discontinuity: true });
    expect(result.signals.dominant_color).toMatchObject({ coverage: "known", evaluation: "contrast", major_discontinuity: true });
    expect(result.signals.text_presence).toMatchObject({ coverage: "known", evaluation: "contrast", major_discontinuity: true });
    expect(result.signals.luma.raw).toEqual({ left: { avg_luma: 0.5 }, right: { avg_luma: 0.95 } });
    expect(result.signals.luma.source_refs.left).toContain("editorial_observation.avg_luma");
  });

  it.each([
    { transition: "hard_cut", relationship: "intentional_contrast", intentUsed: true },
    { transition: "match_cut", relationship: "risky_jump", intentUsed: false },
    { transition: "j_cut", relationship: "risky_jump", intentUsed: false },
    { transition: "l_cut", relationship: "risky_jump", intentUsed: false },
  ] as const)("classifies major breaks with authored $transition as $relationship", ({ transition, relationship, intentUsed }) => {
    const input = contrastInput();
    const { analysis } = adjacencyDecide({
      track_id: "V1",
      kind: "video",
      clips: [
        {
          clip_id: "clip_left", segment_id: "SEG_LEFT", asset_id: "AST_LEFT",
          src_in_us: 0, src_out_us: 1_000_000, timeline_in_frame: 0, timeline_duration_frames: 24,
          role: "hero", motivation: "fixture", beat_id: "B01", fallback_segment_ids: [], confidence: 1, quality_flags: [],
        },
        {
          clip_id: "clip_right", segment_id: "SEG_RIGHT", asset_id: "AST_RIGHT",
          src_in_us: 0, src_out_us: 1_000_000, timeline_in_frame: 24, timeline_duration_frames: 24,
          role: "hero", motivation: "fixture", beat_id: "B02", fallback_segment_ids: [], confidence: 1, quality_flags: [],
        },
      ],
    }, {
      activeEditingSkills: [],
      durationMode: "guide",
      fpsNum: 24,
      candidates: [],
      beats: [
        { beat_id: "B01", label: "left", target_duration_frames: 24, required_roles: ["hero"], preferred_roles: [], purpose: "left", craft: { transition_out: transition } },
        { beat_id: "B02", label: "right", target_duration_frames: 24, required_roles: ["hero"], preferred_roles: [], purpose: "right" },
      ],
      segmentEvidenceIndex: new Map([
        ["SEG_LEFT", input.left.evidence!],
        ["SEG_RIGHT", input.right.evidence!],
      ]),
    });

    expect(analysis.pairs[0].cut_relation).toMatchObject({
      relationship,
      explicit_intent_evidence: intentUsed ? [{
        source: "beat_craft",
        source_ref: "edit_blueprint.beats.B01.craft.transition_out",
        intent: transition,
      }] : [],
    });
    if (intentUsed) {
      expect(analysis.pairs[0].cut_relation?.explicit_intent_evidence[0].source_ref).not.toContain("selected_skill");
    } else {
      expect(analysis.pairs[0].cut_relation?.reason_codes).toContain("non_contrast_intent_excluded");
    }
  });

  it("does not hard-classify opposing observation axes when their confidence groups are missing", () => {
    const left = evidence({
      gaze_direction: "screen_right",
      camera_axis: "axis_left",
      avg_luma: 0.1,
      dominant_colors: ["black"],
      text_presence: "absent",
    });
    const right = evidence({
      gaze_direction: "screen_left",
      camera_axis: "axis_right",
      avg_luma: 0.9,
      dominant_colors: ["white"],
      text_presence: "present",
    });

    const result = classifyCutRelation({
      left: { asset_id: "AST_LEFT", beat_id: "B01", evidence: left },
      right: { asset_id: "AST_RIGHT", beat_id: "B02", evidence: right },
    });

    expect(result.relationship).toBe("unknown");
    expect(result.reason_codes).toContain("observation_confidence_missing");
    expect(result.reason_codes).not.toContain("observation_confidence_below_threshold");
    expect(result.coverage.low_confidence_axis_ids).toEqual(expect.arrayContaining([
      "gaze_axis", "luma", "dominant_color", "text_presence",
    ]));
    for (const axis of ["gaze_axis", "luma", "dominant_color", "text_presence"] as const) {
      expect(result.signals[axis]).toMatchObject({
        coverage: "low_confidence",
        evaluation: "unknown",
        major_discontinuity: false,
        reason_codes: ["observation_confidence_missing"],
      });
    }
  });
});

describe("adjacency analysis schema cut relation compatibility", () => {
  const schema = JSON.parse(fs.readFileSync(path.resolve("schemas/adjacency-analysis.schema.json"), "utf-8"));
  const validate = new Ajv2020({ allErrors: true, strict: false }).compile(schema);
  const legacyPair = {
    pair_id: "V1:B01->B02",
    left_candidate_ref: "left",
    right_candidate_ref: "right",
    selected_skill_id: null,
    selected_skill_score: 0,
    min_score_threshold: 0.3,
    transition_type: "cut",
    confidence: 0,
    below_threshold: false,
  };

  it.each(["1", "2"])("keeps legacy adjacency_analysis v%s readable", (version) => {
    expect(validate({ version, project_id: "project", pairs: [legacyPair] }), JSON.stringify(validate.errors)).toBe(true);
  });

  it("validates the additive v2 cut_relation result", () => {
    const current = {
      version: "2",
      project_id: "project",
      pairs: [{ ...legacyPair, cut_relation: classifyCutRelation(matchingInput()) }],
    };
    expect(validate(current), JSON.stringify(validate.errors)).toBe(true);
  });
});
