import { describe, expect, it } from "vitest";
import type { Candidate, CreativeBrief, SelectsCandidates } from "../runtime/artifacts/types.js";
import {
  CLUSTER_MIN_SELECTED_RATIO,
  DENSITY_MIN,
  analyzeSelectionCoverage,
} from "../runtime/eval/selection-coverage.js";
import type { SelectionCoverageSegment } from "../runtime/eval/selection-coverage.js";

function brief(targetSec = 100, mustHave: string[] = []): CreativeBrief {
  return {
    version: "1",
    project_id: "p",
    project: {
      id: "p",
      title: "fixture",
      strategy: "test",
      runtime_target_sec: targetSec,
    },
    message: { primary: "primary" },
    emotion_curve: [],
    must_have: mustHave,
  } as CreativeBrief & { must_have: string[] };
}

function candidate(
  segmentId: string,
  role: Candidate["role"] = "hero",
  durationSec = 10,
  overrides: Partial<Candidate> = {},
): Candidate {
  return {
    segment_id: segmentId,
    asset_id: `AST_${segmentId}`,
    src_in_us: 0,
    src_out_us: durationSec * 1_000_000,
    role,
    why_it_matches: "",
    risks: [],
    confidence: 0.8,
    ...overrides,
  };
}

function selects(candidates: Candidate[]): SelectsCandidates {
  return { version: "1", project_id: "p", candidates };
}

function segment(segmentId: string, summary: string): SelectionCoverageSegment {
  return { segment_id: segmentId, summary };
}

describe("analyzeSelectionCoverage", () => {
  it("keeps runtime coverage as information only", () => {
    const report = analyzeSelectionCoverage(
      selects([candidate("SEG_1", "hero", 20)]),
      brief(100),
      [segment("SEG_1", "A child walks across the room.")],
    );

    expect(report.runtime_coverage.ratio).toBeCloseTo(0.2, 5);
    expect(report.gaps).toEqual([]);
    expect(report.score).toBe(1);
  });

  it("flags sparse selection density", () => {
    const report = analyzeSelectionCoverage(
      selects([candidate("SEG_1")]),
      brief(10),
      [
        segment("SEG_1", "A child walks across the room."),
        segment("SEG_2", "A parent smiles in the kitchen."),
        segment("SEG_3", "A bicycle rests outside."),
      ],
    );

    expect(DENSITY_MIN).toBe(0.55);
    expect(report.density.value).toBeCloseTo(1 / 3, 5);
    expect(report.density.sparse).toBe(true);
    expect(report.gaps.some((gap) => gap.startsWith("selection sparse:"))).toBe(true);
    expect(report.score).toBeLessThan(1);
  });

  it("flags under-sampled montage-like dense content clusters", () => {
    const trainingWheelSegments = [
      segment("SEG_1", "A child is learning to ride a bicycle with training wheels on a paved surface."),
      segment("SEG_2", "A child is learning to ride a bicycle with training wheels on a paved surface."),
      segment("SEG_3", "A child is learning to ride a bicycle with training wheels on a paved surface."),
      segment("SEG_4", "A child is shown riding a bicycle with training wheels on a paved surface."),
      segment("SEG_5", "A child is shown riding a bicycle with training wheels on a paved surface."),
    ];
    const report = analyzeSelectionCoverage(
      selects([candidate("SEG_1", "support"), candidate("SEG_4", "texture")]),
      brief(20),
      trainingWheelSegments,
    );

    expect(CLUSTER_MIN_SELECTED_RATIO).toBe(0.5);
    expect(report.cluster_coverage).toHaveLength(1);
    expect(report.cluster_coverage[0].cluster_size).toBe(5);
    expect(report.cluster_coverage[0].selected_count).toBe(2);
    expect(report.cluster_coverage[0].under_sampled).toBe(true);
    expect(report.gaps.some((gap) => gap.includes("dense cluster (5 similar shots)"))).toBe(true);
  });

  it("excludes non-content title-card clusters from cluster coverage", () => {
    const titleSegments = [
      segment("SEG_1", "A title card appears with Japanese text and a thank you message."),
      segment("SEG_2", "A title card appears with Japanese text and a thank you message."),
      segment("SEG_3", "A title card appears with Japanese text and a thank you message."),
      segment("SEG_4", "An end screen appears with Japanese text saying thank you for watching."),
      segment("SEG_5", "An end screen appears with Japanese text saying thank you for watching."),
      segment("SEG_6", "An end screen appears with Japanese text saying thank you for watching."),
    ];
    const report = analyzeSelectionCoverage(selects([]), brief(), titleSegments);

    expect(report.cluster_coverage).toEqual([]);
    expect(report.gaps.some((gap) => gap.includes("dense cluster"))).toBe(false);
  });

  it("returns no gaps and score 1 when density and clusters are covered", () => {
    const segments = [
      segment("SEG_1", "A child is learning to ride a bicycle with training wheels on a paved surface."),
      segment("SEG_2", "A child is learning to ride a bicycle with training wheels on a paved surface."),
      segment("SEG_3", "A child is learning to ride a bicycle with training wheels on a paved surface."),
      segment("SEG_4", "A child is learning to ride a bicycle with training wheels on a paved surface."),
    ];
    const report = analyzeSelectionCoverage(
      selects([candidate("SEG_1"), candidate("SEG_2"), candidate("SEG_3")]),
      brief(30),
      segments,
    );

    expect(report.density.sparse).toBe(false);
    expect(report.cluster_coverage[0].under_sampled).toBe(false);
    expect(report.gaps).toEqual([]);
    expect(report.score).toBeCloseTo(1, 5);
  });

  it("reports must-have best-effort matches with cross-language notes", () => {
    const report = analyzeSelectionCoverage(
      selects([
        candidate("SEG_1", "hero", 10, {
          why_it_matches: "自転車に乗れた瞬間を押さえている",
          evidence: ["brief.must_have"],
        }),
      ]),
      brief(10, ["自転車に乗れた達成シーン", "歩行の初めての瞬間"]),
      [segment("SEG_1", "自転車に乗れた達成シーン。家族が拍手している。")],
    );

    expect(report.must_have_coverage).toEqual([
      {
        item: "自転車に乗れた達成シーン",
        matched: true,
        note: "low-confidence (cross-language)",
      },
      {
        item: "歩行の初めての瞬間",
        matched: false,
        note: "low-confidence (cross-language)",
      },
    ]);
    expect(report.gaps).toContain("must_have uncertain: 歩行の初めての瞬間");
  });
});

