import { describe, expect, it } from "vitest";
import {
  exactCandidatePlanFrames,
  exactCandidatePlanRefs,
} from "../scripts/assemble-ena-golden.js";

describe("assemble Ena human golden", () => {
  it("uses occurrence-stable candidate ids when one segment has multiple source windows", () => {
    const refs = exactCandidatePlanRefs([
      { candidate: { candidate_id: "cand_ena_007", segment_id: "SEG_SHARED" } },
      { candidate: { candidate_id: "cand_ena_024", segment_id: "SEG_SHARED" } },
    ]);

    expect(refs).toEqual(["cand_ena_007", "cand_ena_024"]);
  });

  it("derives the exact beat budget from frame-quantized authored source windows", () => {
    expect(exactCandidatePlanFrames([
      { candidate: { src_in_us: 0, src_out_us: 416_667 } },
      { candidate: { src_in_us: 1_000_000, src_out_us: 2_250_000 } },
    ], 24)).toBe(41);
  });
});
