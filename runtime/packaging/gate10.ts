/**
 * Gate 10: Source-of-truth declaration based on handoff_resolution.
 *
 * Determines whether the final package comes from the engine render
 * pipeline or from an NLE finishing workflow, based on the operator's
 * Gate 10 decision recorded in project_state.yaml.
 */

// ── Types ──────────────────────────────────────────────────────────

export type SourceOfTruth = "engine_render" | "nle_finishing";

export interface Gate10Check {
  passed: boolean;
  source_of_truth: SourceOfTruth | null;
  errors: string[];
}

// ── Gate 10 Check ──────────────────────────────────────────────────

/**
 * Check Gate 10 preconditions for packaging.
 *
 * Rules:
 * - current_state must be "approved"
 * - approval_record.status must be "clean" or "creative_override"
 * - handoff_resolution.status must be "decided"
 * - handoff_resolution.source_of_truth_decision must be
 *   "engine_render" or "nle_finishing"
 * - gates.review_gate must be "open"
 */
export function checkGate10(projectState: {
  current_state: string;
  handoff_resolution?: {
    handoff_id: string;
    status: string;
    source_of_truth_decision?: string;
  };
  gates?: {
    review_gate?: string;
    packaging_gate?: string;
  };
  approval_record?: {
    status: string;
  };
}): Gate10Check {
  const errors: string[] = [];

  // current_state must be "approved"
  if (projectState.current_state !== "approved") {
    errors.push(
      `current_state must be "approved", got "${projectState.current_state}"`,
    );
  }

  // approval_record.status must be "clean" or "creative_override"
  if (!projectState.approval_record) {
    errors.push("approval_record is missing");
  } else if (
    projectState.approval_record.status !== "clean" &&
    projectState.approval_record.status !== "creative_override"
  ) {
    errors.push(
      `approval_record.status must be "clean" or "creative_override", ` +
      `got "${projectState.approval_record.status}"`,
    );
  }

  // handoff_resolution.status must be "decided"
  if (!projectState.handoff_resolution) {
    errors.push("handoff_resolution is missing");
  } else if (projectState.handoff_resolution.status !== "decided") {
    errors.push(
      `handoff_resolution.status must be "decided", ` +
      `got "${projectState.handoff_resolution.status}"`,
    );
  }

  // handoff_resolution.source_of_truth_decision must be valid
  let sourceOfTruth: SourceOfTruth | null = null;
  if (projectState.handoff_resolution?.source_of_truth_decision) {
    const decision = projectState.handoff_resolution.source_of_truth_decision;
    if (decision === "engine_render" || decision === "nle_finishing") {
      sourceOfTruth = decision;
    } else {
      errors.push(
        `handoff_resolution.source_of_truth_decision must be ` +
        `"engine_render" or "nle_finishing", got "${decision}"`,
      );
    }
  } else if (projectState.handoff_resolution) {
    errors.push("handoff_resolution.source_of_truth_decision is missing");
  }

  // gates.review_gate must be "open"
  if (!projectState.gates) {
    errors.push("gates is missing");
  } else if (projectState.gates.review_gate !== "open") {
    errors.push(
      `gates.review_gate must be "open", got "${projectState.gates.review_gate}"`,
    );
  }

  return {
    passed: errors.length === 0,
    source_of_truth: errors.length === 0 ? sourceOfTruth : null,
    errors,
  };
}
