/**
 * Gate 10: Source-of-truth declaration based on handoff_resolution.
 *
 * Determines whether the final package comes from the engine render
 * pipeline or from an NLE finishing workflow, based on the operator's
 * Gate 10 decision recorded in project_state.yaml.
 */

import type { AutonomyMode } from "../autonomy.js";

// ── Types ──────────────────────────────────────────────────────────

export type SourceOfTruth = "engine_render" | "nle_finishing";

export interface Gate10HandoffResolution {
  handoff_id: string;
  status: string;
  source_of_truth_decision?: string;
  decided_by?: string;
  decided_at?: string;
}

export interface Gate10Check {
  passed: boolean;
  source_of_truth: SourceOfTruth | null;
  errors: string[];
  handoff_resolution?: Gate10HandoffResolution;
  auto_defaulted_handoff: boolean;
}

export interface Gate10Options {
  autonomyMode?: AutonomyMode;
  decidedAt?: string;
  currentTimelineVersion?: string;
  blueprint?: {
    caption_policy?: {
      source?: string;
    };
  } | null;
  captionApproval?: {
    base_timeline_version?: string;
    approval?: {
      status?: string;
    };
  } | null;
  musicCues?: {
    base_timeline_version?: string;
  } | null;
}

function buildAutoHandoffResolution(
  decidedAt: string,
): Gate10HandoffResolution {
  const compactTimestamp = decidedAt
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");

  return {
    handoff_id: `HND_auto_full_autonomy_${compactTimestamp}`,
    status: "decided",
    source_of_truth_decision: "engine_render",
    decided_by: "auto:full_autonomy",
    decided_at: decidedAt,
  };
}

function isCaptionApprovalStale(
  currentTimelineVersion: string | undefined,
  captionApproval: NonNullable<Gate10Options["captionApproval"]>,
): boolean {
  if (captionApproval.approval?.status === "stale") {
    return true;
  }

  return !!currentTimelineVersion &&
    !!captionApproval.base_timeline_version &&
    captionApproval.base_timeline_version !== currentTimelineVersion;
}

function isMusicCuesStale(
  currentTimelineVersion: string | undefined,
  musicCues: NonNullable<Gate10Options["musicCues"]>,
): boolean {
  return !!currentTimelineVersion &&
    !!musicCues.base_timeline_version &&
    musicCues.base_timeline_version !== currentTimelineVersion;
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
  handoff_resolution?: Gate10HandoffResolution | null;
  gates?: {
    review_gate?: string;
    packaging_gate?: string;
  };
  approval_record?: {
    status: string;
  };
}, options?: Gate10Options): Gate10Check {
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
  let resolvedHandoff = projectState.handoff_resolution ?? undefined;
  let autoDefaultedHandoff = false;
  if (!resolvedHandoff && options?.autonomyMode === "full") {
    resolvedHandoff = buildAutoHandoffResolution(
      options.decidedAt ?? new Date().toISOString(),
    );
    autoDefaultedHandoff = true;
  }

  if (!resolvedHandoff) {
    errors.push("handoff_resolution is missing");
  } else if (resolvedHandoff.status !== "decided") {
    errors.push(
      `handoff_resolution.status must be "decided", ` +
      `got "${resolvedHandoff.status}"`,
    );
  }

  // handoff_resolution.source_of_truth_decision must be valid
  let sourceOfTruth: SourceOfTruth | null = null;
  if (resolvedHandoff?.source_of_truth_decision) {
    const decision = resolvedHandoff.source_of_truth_decision;
    if (decision === "engine_render" || decision === "nle_finishing") {
      sourceOfTruth = decision;
    } else {
      errors.push(
        `handoff_resolution.source_of_truth_decision must be ` +
        `"engine_render" or "nle_finishing", got "${decision}"`,
      );
    }
  } else if (resolvedHandoff) {
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

  // Caption approval is optional unless an existing approval is stale.
  const captionsEnabled = options?.blueprint?.caption_policy?.source &&
    options.blueprint.caption_policy.source !== "none";
  if (captionsEnabled && options.captionApproval &&
      isCaptionApprovalStale(options.currentTimelineVersion, options.captionApproval)) {
    errors.push("caption_approval is stale");
  }

  // Music cues are optional unless an existing cues document is stale.
  if (options?.musicCues &&
      isMusicCuesStale(options.currentTimelineVersion, options.musicCues)) {
    errors.push("music_cues is stale");
  }

  return {
    passed: errors.length === 0,
    source_of_truth: errors.length === 0 ? sourceOfTruth : null,
    errors,
    handoff_resolution: resolvedHandoff,
    auto_defaulted_handoff: autoDefaultedHandoff,
  };
}
