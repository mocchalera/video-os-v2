import { describe, expect, it } from "vitest";
import {
  buildSelectionCoverageUncertaintyRegister,
  SelectionCoverageBlockedError,
} from "../runtime/pipeline/editorial-planning-contract.js";
import type { SelectsCandidates } from "../runtime/artifacts/types.js";

describe("editorial planning contract", () => {
  it("turns failed selects coverage into a canonical blocking uncertainty", () => {
    const selects = {
      version: "1",
      project_id: "coverage-blocked",
      candidates: [],
      coverage: {
        version: "1",
        policy: "analysis-defaults.selection",
        status: "failed",
        config: {
          min_candidates_per_cluster: 1,
          cluster_sampling_scale: "sqrt",
          max_candidates_per_cluster: 4,
        },
        clusters: [],
        must_have: [],
        unmet: [{
          type: "must_have",
          id: "must_have:finish",
          message: "must_have 'finish' has no matching non-rejected candidate",
          must_have: "finish",
        }],
      },
    } as SelectsCandidates;

    const register = buildSelectionCoverageUncertaintyRegister(selects);
    expect(register).toMatchObject({
      version: "1",
      project_id: "coverage-blocked",
      uncertainties: [{
        id: "U_SELECTS_COVERAGE",
        type: "coverage",
        status: "blocker",
        escalation_required: true,
      }],
    });
    expect(register.uncertainties[0].evidence).toEqual([
      "must_have 'finish' has no matching non-rejected candidate",
    ]);
    expect(() => SelectionCoverageBlockedError.assertReady(selects)).toThrow(
      /selects coverage failed/i,
    );
  });

  it("emits an empty canonical register when coverage is met", () => {
    const selects = {
      version: "1",
      project_id: "coverage-ready",
      candidates: [],
      coverage: {
        version: "1",
        policy: "analysis-defaults.selection",
        status: "met",
        config: {
          min_candidates_per_cluster: 1,
          cluster_sampling_scale: "sqrt",
          max_candidates_per_cluster: 4,
        },
        clusters: [],
        must_have: [],
        unmet: [],
      },
    } as SelectsCandidates;

    expect(buildSelectionCoverageUncertaintyRegister(selects).uncertainties).toEqual([]);
    expect(() => SelectionCoverageBlockedError.assertReady(selects)).not.toThrow();
  });
});
