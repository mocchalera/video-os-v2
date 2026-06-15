import { describe, it, expect } from "vitest";
import {
  buildSelectsRegenerationReport,
  isMustHave,
  type SegmentEvidence,
} from "../runtime/eval/regenerate-report.js";
import type { Candidate, SelectsCandidates } from "../runtime/artifacts/types.js";

/**
 * The creative regeneration report scores a freshly regenerated selection
 * against a human golden and, crucially, names WHAT diverged — especially
 * must-have moments the AI dropped, which are the costliest selection errors.
 */
function cand(overrides: Partial<Candidate>): Candidate {
  return {
    candidate_id: "c",
    segment_id: "SEG",
    asset_id: "AST_1",
    src_in_us: 0,
    src_out_us: 8_000_000,
    role: "hero",
    confidence: 0.8,
    ...overrides,
  } as Candidate;
}

const selects = (candidates: Candidate[]): SelectsCandidates =>
  ({ version: "1", project_id: "p", candidates } as unknown as SelectsCandidates);

describe("isMustHave", () => {
  it("flags brief must-have evidence and near-certain confidence", () => {
    expect(isMustHave(cand({ evidence: ["brief.must_have"] }))).toBe(true);
    expect(isMustHave(cand({ confidence: 0.98 }))).toBe(true);
    expect(isMustHave(cand({ confidence: 0.7, evidence: ["brief.message"] }))).toBe(false);
  });
});

describe("buildSelectsRegenerationReport", () => {
  const golden = selects([
    cand({ segment_id: "SEG_A", asset_id: "AST_1", src_in_us: 0, src_out_us: 8_000_000, role: "hero", confidence: 0.8 }),
    cand({ segment_id: "SEG_B", asset_id: "AST_2", src_in_us: 10_000_000, src_out_us: 18_000_000, role: "hero", confidence: 0.98, evidence: ["brief.must_have"], why_it_matches: "初成功の瞬間" }),
  ]);
  const candidate = selects([
    cand({ segment_id: "SEG_A", asset_id: "AST_1", src_in_us: 0, src_out_us: 8_000_000, role: "hero" }),
    cand({ segment_id: "SEG_C", asset_id: "AST_3", src_in_us: 20_000_000, src_out_us: 28_000_000, role: "support", why_it_matches: "綺麗な引き" }),
  ]);
  const segments: SegmentEvidence[] = [
    { segment_id: "SEG_B", transcript_excerpt: "やった、できた！", summary: "child succeeds" },
    { segment_id: "SEG_C", summary: "wide scenic shot" },
  ];

  const report = buildSelectsRegenerationReport(golden, candidate, segments, {
    goldenProject: "fumoto",
    candidateProject: "regen",
    evaluatedAt: "2026-06-15T00:00:00.000Z",
  });

  it("separates matched, missed-must-have, and added moments", () => {
    expect(report.agreement.matched_count).toBe(1); // SEG_A exact match
    expect(report.missedMustHave.map((c) => c.segment_id)).toEqual(["SEG_B"]);
    expect(report.extra.map((c) => c.segment_id)).toEqual(["SEG_C"]);
  });

  it("surfaces the missed moment's transcript and the human rationale", () => {
    expect(report.markdown).toContain("Missed must-have moments (1)");
    expect(report.markdown).toContain("SEG_B");
    expect(report.markdown).toContain("やった、できた！");
    expect(report.markdown).toContain("初成功の瞬間");
  });

  it("lists AI-added moments the human did not pick", () => {
    expect(report.markdown).toContain("Added moments (1)");
    expect(report.markdown).toContain("SEG_C");
  });

  it("reports F1/precision/recall consistent with the overlap", () => {
    // 1 matched of 2 golden / 2 candidate → P=R=0.5, F1=0.5
    expect(report.agreement.precision).toBeCloseTo(0.5, 5);
    expect(report.agreement.recall).toBeCloseTo(0.5, 5);
    expect(report.agreement.f1).toBeCloseTo(0.5, 5);
  });
});
