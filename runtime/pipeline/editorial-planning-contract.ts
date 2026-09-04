import type { SelectsCandidates } from "../artifacts/types.js";
import type { UncertaintyRegister } from "../commands/blueprint/index.js";

export class SelectionCoverageBlockedError extends Error {
  readonly code = "SELECTS_COVERAGE_BLOCKED" as const;
  readonly evidence: string[];

  constructor(selects: SelectsCandidates) {
    const evidence = selects.coverage?.unmet.map((item) => item.message) ?? [];
    super(
      `Selects coverage failed: ${evidence.length > 0 ? evidence.join("; ") : "coverage status is failed"}`,
    );
    this.name = "SelectionCoverageBlockedError";
    this.evidence = evidence;
  }

  static assertReady(selects: SelectsCandidates): void {
    if (selects.coverage?.status === "failed") {
      throw new SelectionCoverageBlockedError(selects);
    }
  }
}

export function buildSelectionCoverageUncertaintyRegister(
  selects: SelectsCandidates,
): UncertaintyRegister {
  const evidence = selects.coverage?.unmet.map((item) => item.message) ?? [];
  return {
    version: "1",
    project_id: selects.project_id,
    uncertainties: selects.coverage?.status === "failed"
      ? [{
        id: "U_SELECTS_COVERAGE",
        type: "coverage",
        question: "Can the approved non-rejected selects satisfy the declared coverage contract?",
        status: "blocker",
        evidence: evidence.length > 0 ? evidence : ["selects coverage status is failed"],
        alternatives: [],
        escalation_required: true,
      }]
      : [],
  };
}
