import { describe, expect, it } from "vitest";
import type { CreativeBrief, SelectsCandidates } from "../runtime/artifacts/types.js";
import type { SegmentItem } from "../runtime/agents/triage-enrichment.js";
import { quickBriefAlignmentCheck } from "../runtime/eval/brief-alignment-quick.js";

function brief(): CreativeBrief {
  return {
    version: "1",
    project_id: "quick-alignment-fixture",
    project: {
      id: "quick-alignment-fixture",
      title: "Trail confidence",
      strategy: "show a complete outdoor learning arc",
      runtime_target_sec: 60,
    },
    message: { primary: "practice creates confidence" },
    emotion_curve: ["uncertain start", "focused practice", "quiet confidence"],
    must_have: ["rope practice", "closing smile", "BGM fade out"],
  } as CreativeBrief;
}

function segments(): SegmentItem[] {
  return [
    { segment_id: "SEG_001", summary: "Opening rope practice on a mountain trail." } as SegmentItem,
    { segment_id: "SEG_002", summary: "Focused practice with coaching and repeated attempts." } as SegmentItem,
    { segment_id: "SEG_003", summary: "Closing smile after the outdoor lesson." } as SegmentItem,
    { segment_id: "SEG_004", summary: "Wide landscape texture shot for visual contrast." } as SegmentItem,
  ];
}

function selects(): SelectsCandidates {
  return {
    version: "1",
    project_id: "quick-alignment-fixture",
    candidates: [
      {
        segment_id: "SEG_001",
        asset_id: "A",
        src_in_us: 0,
        src_out_us: 8_000_000,
        role: "hero",
        why_it_matches: "Opening hook shows rope practice and an uncertain start.",
        risks: [],
        confidence: 0.9,
        evidence: ["rope practice"],
        eligible_beats: ["hook"],
        editorial_signals: { semantic_cluster_id: "practice", peak_strength_score: 0.7 },
      },
      {
        segment_id: "SEG_002",
        asset_id: "B",
        src_in_us: 0,
        src_out_us: 8_000_000,
        role: "dialogue",
        why_it_matches: "Experience beat shows focused practice with coaching.",
        risks: [],
        confidence: 0.85,
        evidence: ["focused practice"],
        eligible_beats: ["experience"],
        editorial_signals: { semantic_cluster_id: "coaching", reaction_intensity_score: 0.6 },
      },
      {
        segment_id: "SEG_003",
        asset_id: "C",
        src_in_us: 0,
        src_out_us: 7_000_000,
        role: "support",
        why_it_matches: "Closing payoff lands quiet confidence with a closing smile.",
        risks: [],
        confidence: 0.8,
        evidence: ["closing smile"],
        eligible_beats: ["closing"],
        editorial_signals: { semantic_cluster_id: "payoff", afterglow_score: 0.8 },
      },
      {
        segment_id: "SEG_004",
        asset_id: "D",
        src_in_us: 0,
        src_out_us: 5_000_000,
        role: "texture",
        why_it_matches: "Wide landscape provides visual contrast.",
        risks: [],
        confidence: 0.7,
        evidence: ["wide landscape"],
        editorial_signals: { semantic_cluster_id: "place" },
      },
    ],
  };
}

describe("quickBriefAlignmentCheck", () => {
  it("passes good selects with deterministic brief alignment evidence", () => {
    const result = quickBriefAlignmentCheck(brief(), selects(), segments());

    expect(result.passed).toBe(true);
    expect(result.score).toBeGreaterThanOrEqual(0.8);
    expect(result.gaps).toEqual([]);
  });

  it("generates a missing must-have gap", () => {
    const mutatedBrief = {
      ...brief(),
      must_have: ["rope practice", "closing smile", "zxqvplmn"],
    } as CreativeBrief;

    const result = quickBriefAlignmentCheck(mutatedBrief, selects(), segments());

    expect(result.gaps).toContainEqual(
      expect.objectContaining({
        axis: "must_have_coverage",
        feedback: "must_have 'zxqvplmn' has no matching candidate evidence",
      }),
    );
  });

  it("generates an emotion signal gap when candidates lack peak data", () => {
    const weak = selects();
    weak.candidates = weak.candidates.map((candidate) => ({
      ...candidate,
      role: candidate.role === "dialogue" ? "support" : candidate.role,
      editorial_signals: candidate.editorial_signals?.semantic_cluster_id
        ? { semantic_cluster_id: candidate.editorial_signals.semantic_cluster_id }
        : undefined,
    }));

    const result = quickBriefAlignmentCheck(brief(), weak, segments());

    expect(result.gaps).toContainEqual(
      expect.objectContaining({
        axis: "emotion_curve_alignment",
        feedback: "0/4 candidates carry emotion/peak signals -- add candidates with peak_analysis data",
      }),
    );
  });

  it("generates a low visual variety gap", () => {
    const weak = selects();
    weak.candidates = weak.candidates.map((candidate) => ({
      ...candidate,
      asset_id: "A",
      role: "support",
      editorial_signals: {
        ...candidate.editorial_signals,
        semantic_cluster_id: "same-scene",
      },
    }));

    const result = quickBriefAlignmentCheck(brief(), weak, segments());

    expect(result.gaps).toContainEqual(
      expect.objectContaining({
        axis: "visual_variety_and_focus",
        feedback: "only 1 unique semantic clusters -- increase visual diversity across scene types",
      }),
    );
  });

  it("generates actionable narrative feedback for missing closing story function", () => {
    const weak = selects();
    weak.candidates = weak.candidates.map((candidate) => ({
      ...candidate,
      why_it_matches: candidate.why_it_matches.replace(/Closing payoff|closing smile|Closing/gi, "Practice"),
      evidence: candidate.evidence?.map((item) => item.replace(/closing smile/gi, "practice")),
      eligible_beats: candidate.eligible_beats?.map((item) => item.replace(/closing/gi, "experience")),
    }));

    const result = quickBriefAlignmentCheck(brief(), weak, segments());

    expect(result.gaps).toContainEqual(
      expect.objectContaining({
        axis: "narrative_structure",
        feedback: "no candidates with closing/payoff story function -- add a clear ending candidate",
      }),
    );
  });

  it("honors threshold customization", () => {
    const mutatedBrief = {
      ...brief(),
      must_have: ["rope practice", "closing smile", "zxqvplmn", "qrzntblx"],
    } as CreativeBrief;

    const strict = quickBriefAlignmentCheck(mutatedBrief, selects(), segments());
    const lenient = quickBriefAlignmentCheck(mutatedBrief, selects(), segments(), {
      must_have_coverage: 0.4,
    });

    expect(strict.gaps.some((gap) => gap.axis === "must_have_coverage")).toBe(true);
    expect(lenient.gaps.some((gap) => gap.axis === "must_have_coverage")).toBe(false);
  });
});
