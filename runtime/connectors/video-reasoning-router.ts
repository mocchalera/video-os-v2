/**
 * Deterministic Marlin-first route planning for optional video reasoning.
 *
 * This module only decides a route. It does not construct a provider client,
 * read media, inspect a prompt, reserve shared state, or invoke a connector.
 * The caller must apply the returned provider reservation before any network
 * work and must keep it reserved when a submitted request has an unknown
 * outcome.
 */

import type { VideoReasoningPrivacy, VideoReasoningTask } from "./video-reasoning-types.js";

export const VIDEO_REASONING_ROUTE_DECISIONS = [
  "local",
  "static_vlm",
  "agentic",
  "blocked",
] as const;

export type VideoReasoningRouteDecisionKind = typeof VIDEO_REASONING_ROUTE_DECISIONS[number];

export const VIDEO_REASONING_AGENTIC_TASKS = [
  "needle_search",
  "moment_refine",
  "trim_refine",
  "continuity_check",
  "roughcut_review",
  "anomaly_inspection",
] as const satisfies readonly VideoReasoningTask[];

export const VIDEO_REASONING_ROUTER_DEFAULTS = {
  longFormMinDurationUs: 600_000_000,
  marlinConfidenceThreshold: 0.75,
  marlinCoverageThreshold: 0.8,
} as const;

export type VideoReasoningRouteReasonCode =
  | "local_only_policy"
  | "marlin_evidence_sufficient"
  | "no_escalation_signal"
  | "local_fallback"
  | "static_frame_bundle_sufficient"
  | "static_vlm_selected"
  | "static_vlm_deferred"
  | "static_vlm_unavailable"
  | "static_cloud_disallowed"
  | "agentic_selected"
  | "agentic_deferred"
  | "agentic_escalation_required"
  | "agentic_deferred_privacy"
  | "long_form_needle_search"
  | "marlin_unavailable"
  | "marlin_degraded"
  | "marlin_confidence_below_threshold"
  | "marlin_coverage_incomplete"
  | "candidate_conflict"
  | "unresolved_uncertainty"
  | "editorial_impact_high"
  | "temporal_reasoning_required"
  | "whole_cut_review_requested"
  | "task_unsupported"
  | "semantic_review_not_requested"
  | "source_identity_invalid"
  | "source_range_invalid"
  | "source_upload_estimate_invalid"
  | "derivative_identity_missing"
  | "privacy_mode_invalid"
  | "cloud_consent_missing"
  | "cloud_consent_scope_mismatch"
  | "privacy_upload_disallowed"
  | "agentic_capability_unavailable"
  | "agentic_model_unsupported"
  | "provider_capability_ambiguous"
  | "budget_requests_exhausted"
  | "budget_upload_duration_exhausted"
  | "budget_upload_bytes_exhausted"
  | "budget_input_tokens_exhausted"
  | "budget_input_tokens_unknown"
  | "budget_estimated_usd_exhausted"
  | "budget_estimated_usd_unknown"
  | "budget_ambiguous"
  | "local_evidence_ambiguous"
  | "policy_invalid"
  | "budget_reserved";

export type VideoReasoningConstraintStatus =
  | "pass"
  | "fail"
  | "unknown"
  | "not_applicable";

export interface VideoReasoningRouteConsent {
  /** This is intentionally a boolean, so absence/false cannot be inferred as consent. */
  approved: boolean;
  scope?: string;
}

export interface VideoReasoningRouteSource {
  /** The caller has already checked the M1 source identity contract. */
  identityValid: boolean;
  /** Original source duration, in microseconds. */
  durationUs: number;
  /** Optional original-source range submitted to the reasoning capability. */
  rangeUs?: readonly [number, number];
  /** M1 requires a distinct submitted identity for derivative/range uploads. */
  submittedMediaIdentityDistinct?: boolean;
  /** Conservative bytes/duration estimate for the possible upload. */
  estimatedUploadDurationUs: number;
  estimatedUploadBytes: number;
}

export interface VideoReasoningRouteMarlinEvidence {
  available: boolean;
  /** Aggregated local confidence. Null means it was not established. */
  confidence: number | null;
  /** Fraction of the requested source/evidence covered, from 0 through 1. */
  coverage: number | null;
  /** Maps Marlin's degraded artifact status into an explicit routing input. */
  degraded?: boolean;
}

export interface VideoReasoningRouteProviderCapability {
  /** Existing static frame-bundle VlmFn can be used by the caller. */
  staticVlmAvailable: boolean;
  /** The selected Agentic provider/transport is available to the caller. */
  agenticAvailable: boolean;
  /** The selected Agentic model is supported by the available provider. */
  agenticModelSupported: boolean;
}

export interface VideoReasoningRouteBudget {
  remainingRequests: number;
  remainingUploadedDurationUs: number;
  remainingUploadedBytes: number;
  /** Optional because M1 keeps these limits optional until a cost model exists. */
  remainingInputTokens?: number;
  remainingEstimatedUsd?: number;
  /** Required when the corresponding optional remaining limit is supplied. */
  estimatedInputTokens?: number;
  estimatedUsd?: number;
}

export interface VideoReasoningRouterPolicy {
  longFormMinDurationUs?: number;
  marlinConfidenceThreshold?: number;
  marlinCoverageThreshold?: number;
}

export interface VideoReasoningRouteInput {
  /** Untrusted task vocabulary; unsupported values fail closed. */
  task: string;
  /** Omitted privacy deliberately defaults to local_only. */
  privacy?: VideoReasoningPrivacy | string;
  consent?: VideoReasoningRouteConsent;
  source: VideoReasoningRouteSource;
  marlin: VideoReasoningRouteMarlinEvidence;
  candidateConflict: boolean;
  unresolvedUncertainty: boolean;
  temporalReasoningRequired: boolean;
  /** Whether a static sampled frame bundle is sufficient for this question. */
  staticEvidenceSufficient: boolean;
  editorialImpact: "low" | "medium" | "high" | string;
  providerCapability: VideoReasoningRouteProviderCapability;
  budget: VideoReasoningRouteBudget;
  /** `roughcut_review` requires an explicit semantic-review request. */
  semanticReviewRequested?: boolean;
  /** Deliberately ignored: API-key presence never changes a route. */
  apiKeyPresent?: boolean;
  policy?: VideoReasoningRouterPolicy;
}

export interface VideoReasoningRouteBudgetSnapshot {
  requests: number | null;
  uploadedDurationUs: number | null;
  uploadedBytes: number | null;
  inputTokens: number | null;
  estimatedUsd: number | null;
}

export interface VideoReasoningRouteReservation {
  status: "none" | "reserved";
  purpose: "none" | "provider_request_preflight";
  requests: number;
  uploadedDurationUs: number;
  uploadedBytes: number;
  inputTokens: number | null;
  estimatedUsd: number | null;
  /** Reservation may be released only when the caller proves no submission. */
  release: "not_applicable" | "if_not_submitted";
  /** Unknown post-submit outcomes remain reserved for operator resolution. */
  unknownOutcome: "not_applicable" | "remain_reserved_until_operator_resolution";
}

export interface VideoReasoningRouteConstraints {
  source: {
    identity: VideoReasoningConstraintStatus;
    range: VideoReasoningConstraintStatus;
    derivativeBinding: VideoReasoningConstraintStatus;
  };
  task: {
    supported: VideoReasoningConstraintStatus;
    semanticReviewRequested: VideoReasoningConstraintStatus;
  };
  privacy: {
    mode: VideoReasoningPrivacy | "invalid";
    consent: VideoReasoningConstraintStatus;
    upload: VideoReasoningConstraintStatus;
  };
  marlin: {
    available: VideoReasoningConstraintStatus;
    confidence: VideoReasoningConstraintStatus;
    confidenceValue: number | null;
    confidenceThreshold: number;
    coverage: VideoReasoningConstraintStatus;
    coverageValue: number | null;
    coverageThreshold: number;
    degraded: VideoReasoningConstraintStatus;
    sufficient: VideoReasoningConstraintStatus;
  };
  escalation: {
    required: boolean | null;
    signals: readonly VideoReasoningRouteReasonCode[];
  };
  provider: {
    staticVlm: VideoReasoningConstraintStatus;
    agentic: VideoReasoningConstraintStatus;
    agenticModel: VideoReasoningConstraintStatus;
  };
  budget: {
    requests: VideoReasoningConstraintStatus;
    uploadedDurationUs: VideoReasoningConstraintStatus;
    uploadedBytes: VideoReasoningConstraintStatus;
    inputTokens: VideoReasoningConstraintStatus;
    estimatedUsd: VideoReasoningConstraintStatus;
  };
}

export interface VideoReasoningRouteDecision {
  decision: VideoReasoningRouteDecisionKind;
  reasonCodes: readonly VideoReasoningRouteReasonCode[];
  constraints: VideoReasoningRouteConstraints;
  /** Null when source/range validation did not produce a safe range. */
  sourceRangeUs: readonly [number, number] | null;
  estimatedUploadDurationUs: number | null;
  estimatedUploadBytes: number | null;
  budget: {
    before: VideoReasoningRouteBudgetSnapshot;
    reservation: VideoReasoningRouteReservation;
    afterReservation: VideoReasoningRouteBudgetSnapshot;
  };
}

interface NormalizedRouteInput {
  task: string | null;
  privacy: VideoReasoningPrivacy | "invalid";
  consentApproved: boolean | null;
  consentScope: string | null;
  sourceIdentityValid: boolean | null;
  sourceDurationUs: number | null;
  sourceRangeUs: readonly [number, number] | null;
  sourceRangeValid: boolean | null;
  submittedMediaIdentityDistinct: boolean | null;
  estimatedUploadDurationUs: number | null;
  estimatedUploadBytes: number | null;
  marlinAvailable: boolean | null;
  marlinConfidence: number | null;
  marlinCoverage: number | null;
  marlinDegraded: boolean | null;
  candidateConflict: boolean | null;
  unresolvedUncertainty: boolean | null;
  temporalReasoningRequired: boolean | null;
  staticEvidenceSufficient: boolean | null;
  editorialImpact: "low" | "medium" | "high" | null;
  staticVlmAvailable: boolean | null;
  agenticAvailable: boolean | null;
  agenticModelSupported: boolean | null;
  remainingRequests: number | null;
  remainingUploadedDurationUs: number | null;
  remainingUploadedBytes: number | null;
  remainingInputTokens: number | null;
  remainingEstimatedUsd: number | null;
  estimatedInputTokens: number | null;
  estimatedUsd: number | null;
  optionalBudgetFieldsValid: boolean;
  semanticReviewRequested: boolean | null;
  policy: {
    longFormMinDurationUs: number;
    marlinConfidenceThreshold: number;
    marlinCoverageThreshold: number;
  } | null;
}

const PRIVACY_VALUES = new Set<VideoReasoningPrivacy>([
  "local_only",
  "bounded_derivative",
  "source_allowed",
]);
const EDITORIAL_IMPACTS = new Set(["low", "medium", "high"]);
const AGENTIC_TASK_SET = new Set<string>(VIDEO_REASONING_AGENTIC_TASKS);

type VideoReasoningRouteBudgetStatuses = {
  requests: VideoReasoningConstraintStatus;
  uploadedDurationUs: VideoReasoningConstraintStatus;
  uploadedBytes: VideoReasoningConstraintStatus;
  inputTokens: VideoReasoningConstraintStatus;
  estimatedUsd: VideoReasoningConstraintStatus;
};

type VideoReasoningRouteProviderStatuses = {
  staticVlm: VideoReasoningConstraintStatus;
  agentic: VideoReasoningConstraintStatus;
  agenticModel: VideoReasoningConstraintStatus;
};

interface VideoReasoningCloudEvaluation {
  consent: VideoReasoningConstraintStatus;
  upload: VideoReasoningConstraintStatus;
  derivativeBinding: VideoReasoningConstraintStatus;
  provider: VideoReasoningRouteProviderStatuses;
  budget: VideoReasoningRouteBudgetStatuses;
  reasonCodes: readonly VideoReasoningRouteReasonCode[];
  eligible: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSafeNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isSafePositiveInteger(value: unknown): value is number {
  return isSafeNonNegativeInteger(value) && value > 0;
}

function isUnitInterval(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function isNonNegativeFinite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function normalizeOptionalInteger(value: unknown): number | null {
  return value === undefined ? null : isSafeNonNegativeInteger(value) ? value : null;
}

function normalizeOptionalUsd(value: unknown): number | null {
  return value === undefined ? null : isNonNegativeFinite(value) ? value : null;
}

function optionalBudgetFieldsValid(budget: Record<string, unknown>): boolean {
  return (budget.remainingInputTokens === undefined || isSafeNonNegativeInteger(budget.remainingInputTokens)) &&
    (budget.estimatedInputTokens === undefined || isSafeNonNegativeInteger(budget.estimatedInputTokens)) &&
    (budget.remainingEstimatedUsd === undefined || isNonNegativeFinite(budget.remainingEstimatedUsd)) &&
    (budget.estimatedUsd === undefined || isNonNegativeFinite(budget.estimatedUsd));
}

function normalizeInput(input: unknown): NormalizedRouteInput {
  const raw = isRecord(input) ? input : {};
  const source = isRecord(raw.source) ? raw.source : {};
  const marlin = isRecord(raw.marlin) ? raw.marlin : {};
  const provider = isRecord(raw.providerCapability) ? raw.providerCapability : {};
  const budget = isRecord(raw.budget) ? raw.budget : {};
  const consent = isRecord(raw.consent) ? raw.consent : null;
  const rawPolicy = raw.policy === undefined ? {} : (isRecord(raw.policy) ? raw.policy : null);

  const privacyValue = raw.privacy === undefined ? "local_only" : raw.privacy;
  const privacy = typeof privacyValue === "string" && PRIVACY_VALUES.has(privacyValue as VideoReasoningPrivacy)
    ? privacyValue as VideoReasoningPrivacy
    : "invalid";
  const task = typeof raw.task === "string" ? raw.task : null;
  const sourceDurationUs = isSafePositiveInteger(source.durationUs) ? source.durationUs : null;
  const rawRange = source.rangeUs;
  let sourceRangeUs: readonly [number, number] | null = null;
  let sourceRangeValid: boolean | null = null;
  if (rawRange === undefined) {
    sourceRangeValid = sourceDurationUs !== null;
    sourceRangeUs = sourceDurationUs === null ? null : [0, sourceDurationUs];
  } else if (Array.isArray(rawRange) && rawRange.length === 2 &&
             isSafeNonNegativeInteger(rawRange[0]) && isSafeNonNegativeInteger(rawRange[1]) &&
             sourceDurationUs !== null && rawRange[0] < rawRange[1] && rawRange[1] <= sourceDurationUs) {
    sourceRangeValid = true;
    sourceRangeUs = [rawRange[0], rawRange[1]];
  } else {
    sourceRangeValid = false;
  }

  const identityValid = typeof source.identityValid === "boolean" ? source.identityValid : null;
  const submittedDistinct = typeof source.submittedMediaIdentityDistinct === "boolean"
    ? source.submittedMediaIdentityDistinct
    : null;
  const uploadDuration = isSafePositiveInteger(source.estimatedUploadDurationUs)
    ? source.estimatedUploadDurationUs
    : null;
  const uploadBytes = isSafePositiveInteger(source.estimatedUploadBytes)
    ? source.estimatedUploadBytes
    : null;

  const rawEditorialImpact = raw.editorialImpact;
  const editorialImpact = typeof rawEditorialImpact === "string" && EDITORIAL_IMPACTS.has(rawEditorialImpact)
    ? rawEditorialImpact as "low" | "medium" | "high"
    : null;

  const policy = rawPolicy === null ||
      (rawPolicy.longFormMinDurationUs !== undefined && !isSafePositiveInteger(rawPolicy.longFormMinDurationUs)) ||
      (rawPolicy.marlinConfidenceThreshold !== undefined && !isUnitInterval(rawPolicy.marlinConfidenceThreshold)) ||
      (rawPolicy.marlinCoverageThreshold !== undefined && !isUnitInterval(rawPolicy.marlinCoverageThreshold))
    ? null
    : {
      longFormMinDurationUs: rawPolicy.longFormMinDurationUs ?? VIDEO_REASONING_ROUTER_DEFAULTS.longFormMinDurationUs,
      marlinConfidenceThreshold: rawPolicy.marlinConfidenceThreshold ?? VIDEO_REASONING_ROUTER_DEFAULTS.marlinConfidenceThreshold,
      marlinCoverageThreshold: rawPolicy.marlinCoverageThreshold ?? VIDEO_REASONING_ROUTER_DEFAULTS.marlinCoverageThreshold,
    };

  return {
    task,
    privacy,
    consentApproved: consent === null ? null : typeof consent.approved === "boolean" ? consent.approved : null,
    consentScope: consent === null ? null : typeof consent.scope === "string" ? consent.scope : null,
    sourceIdentityValid: identityValid,
    sourceDurationUs,
    sourceRangeUs,
    sourceRangeValid,
    submittedMediaIdentityDistinct: submittedDistinct,
    estimatedUploadDurationUs: uploadDuration,
    estimatedUploadBytes: uploadBytes,
    marlinAvailable: typeof marlin.available === "boolean" ? marlin.available : null,
    marlinConfidence: marlin.confidence === null ? null : isUnitInterval(marlin.confidence) ? marlin.confidence : null,
    marlinCoverage: marlin.coverage === null ? null : isUnitInterval(marlin.coverage) ? marlin.coverage : null,
    marlinDegraded: typeof marlin.degraded === "boolean" ? marlin.degraded : null,
    candidateConflict: typeof raw.candidateConflict === "boolean" ? raw.candidateConflict : null,
    unresolvedUncertainty: typeof raw.unresolvedUncertainty === "boolean" ? raw.unresolvedUncertainty : null,
    temporalReasoningRequired: typeof raw.temporalReasoningRequired === "boolean" ? raw.temporalReasoningRequired : null,
    staticEvidenceSufficient: typeof raw.staticEvidenceSufficient === "boolean" ? raw.staticEvidenceSufficient : null,
    editorialImpact,
    staticVlmAvailable: typeof provider.staticVlmAvailable === "boolean" ? provider.staticVlmAvailable : null,
    agenticAvailable: typeof provider.agenticAvailable === "boolean" ? provider.agenticAvailable : null,
    agenticModelSupported: typeof provider.agenticModelSupported === "boolean" ? provider.agenticModelSupported : null,
    remainingRequests: normalizeOptionalInteger(budget.remainingRequests),
    remainingUploadedDurationUs: normalizeOptionalInteger(budget.remainingUploadedDurationUs),
    remainingUploadedBytes: normalizeOptionalInteger(budget.remainingUploadedBytes),
    remainingInputTokens: normalizeOptionalInteger(budget.remainingInputTokens),
    remainingEstimatedUsd: normalizeOptionalUsd(budget.remainingEstimatedUsd),
    estimatedInputTokens: normalizeOptionalInteger(budget.estimatedInputTokens),
    estimatedUsd: normalizeOptionalUsd(budget.estimatedUsd),
    optionalBudgetFieldsValid: optionalBudgetFieldsValid(budget),
    semanticReviewRequested: raw.semanticReviewRequested === undefined
      ? null
      : typeof raw.semanticReviewRequested === "boolean" ? raw.semanticReviewRequested : null,
    policy,
  };
}

function statusForBoolean(value: boolean | null): VideoReasoningConstraintStatus {
  return value === null ? "unknown" : value ? "pass" : "fail";
}

function statusForMarlinDegraded(
  available: boolean | null,
  degraded: boolean | null,
): VideoReasoningConstraintStatus {
  if (available === false) return "not_applicable";
  if (available === null || degraded === null) return "unknown";
  return degraded ? "fail" : "pass";
}

function uniqueReasonCodes(
  reasonCodes: readonly VideoReasoningRouteReasonCode[],
): readonly VideoReasoningRouteReasonCode[] {
  return [...new Set(reasonCodes)];
}

function budgetBefore(input: NormalizedRouteInput): VideoReasoningRouteBudgetSnapshot {
  return {
    requests: input.remainingRequests,
    uploadedDurationUs: input.remainingUploadedDurationUs,
    uploadedBytes: input.remainingUploadedBytes,
    inputTokens: input.remainingInputTokens,
    estimatedUsd: input.remainingEstimatedUsd,
  };
}

function noReservation(before: VideoReasoningRouteBudgetSnapshot): {
  reservation: VideoReasoningRouteReservation;
  afterReservation: VideoReasoningRouteBudgetSnapshot;
} {
  return {
    reservation: {
      status: "none",
      purpose: "none",
      requests: 0,
      uploadedDurationUs: 0,
      uploadedBytes: 0,
      inputTokens: null,
      estimatedUsd: null,
      release: "not_applicable",
      unknownOutcome: "not_applicable",
    },
    afterReservation: { ...before },
  };
}

function providerReservation(input: NormalizedRouteInput, before: VideoReasoningRouteBudgetSnapshot): {
  reservation: VideoReasoningRouteReservation;
  afterReservation: VideoReasoningRouteBudgetSnapshot;
} {
  const reservedInputTokens = input.estimatedInputTokens;
  const reservedUsd = input.estimatedUsd;
  const reservation: VideoReasoningRouteReservation = {
    status: "reserved",
    purpose: "provider_request_preflight",
    requests: 1,
    uploadedDurationUs: input.estimatedUploadDurationUs ?? 0,
    uploadedBytes: input.estimatedUploadBytes ?? 0,
    inputTokens: reservedInputTokens,
    estimatedUsd: reservedUsd,
    release: "if_not_submitted",
    unknownOutcome: "remain_reserved_until_operator_resolution",
  };
  return {
    reservation,
    afterReservation: {
      requests: before.requests === null ? null : before.requests - reservation.requests,
      uploadedDurationUs: before.uploadedDurationUs === null
        ? null
        : before.uploadedDurationUs - reservation.uploadedDurationUs,
      uploadedBytes: before.uploadedBytes === null ? null : before.uploadedBytes - reservation.uploadedBytes,
      inputTokens: before.inputTokens === null || reservedInputTokens === null
        ? before.inputTokens
        : before.inputTokens - reservedInputTokens,
      estimatedUsd: before.estimatedUsd === null || reservedUsd === null
        ? before.estimatedUsd
        : before.estimatedUsd - reservedUsd,
    },
  };
}

function buildConstraints(
  input: NormalizedRouteInput,
  taskSupported: boolean | null,
  semanticReview: VideoReasoningConstraintStatus,
  marlinSufficient: boolean | null,
  escalationRequired: boolean | null,
  escalationSignals: readonly VideoReasoningRouteReasonCode[],
  cloudEvaluation: VideoReasoningCloudEvaluation | null,
): VideoReasoningRouteConstraints {
  const cloud = cloudEvaluation ?? {
    consent: "not_applicable",
    upload: "not_applicable",
    derivativeBinding: "not_applicable",
    provider: {
      staticVlm: "not_applicable",
      agentic: "not_applicable",
      agenticModel: "not_applicable",
    },
    budget: {
      requests: "not_applicable",
      uploadedDurationUs: "not_applicable",
      uploadedBytes: "not_applicable",
      inputTokens: "not_applicable",
      estimatedUsd: "not_applicable",
    },
    reasonCodes: [],
    eligible: false,
  } satisfies VideoReasoningCloudEvaluation;
  const marlinConfidenceStatus = input.marlinAvailable === false
    ? "not_applicable"
    : input.marlinConfidence === null
      ? "unknown"
      : input.marlinConfidence >= (input.policy?.marlinConfidenceThreshold ?? VIDEO_REASONING_ROUTER_DEFAULTS.marlinConfidenceThreshold)
        ? "pass"
        : "fail";
  const marlinCoverageStatus = input.marlinAvailable === false
    ? "not_applicable"
    : input.marlinCoverage === null
      ? "unknown"
      : input.marlinCoverage >= (input.policy?.marlinCoverageThreshold ?? VIDEO_REASONING_ROUTER_DEFAULTS.marlinCoverageThreshold)
        ? "pass"
        : "fail";
  const confidenceThreshold = input.policy?.marlinConfidenceThreshold ??
    VIDEO_REASONING_ROUTER_DEFAULTS.marlinConfidenceThreshold;
  const coverageThreshold = input.policy?.marlinCoverageThreshold ??
    VIDEO_REASONING_ROUTER_DEFAULTS.marlinCoverageThreshold;

  return {
    source: {
      identity: statusForBoolean(input.sourceIdentityValid),
      range: statusForBoolean(input.sourceRangeValid),
      derivativeBinding: cloud.derivativeBinding,
    },
    task: {
      supported: statusForBoolean(taskSupported),
      semanticReviewRequested: semanticReview,
    },
    privacy: {
      mode: input.privacy,
      consent: cloud.consent,
      upload: cloud.upload,
    },
    marlin: {
      available: statusForBoolean(input.marlinAvailable),
      confidence: marlinConfidenceStatus,
      confidenceValue: input.marlinConfidence,
      confidenceThreshold,
      coverage: marlinCoverageStatus,
      coverageValue: input.marlinCoverage,
      coverageThreshold,
      degraded: statusForMarlinDegraded(input.marlinAvailable, input.marlinDegraded),
      sufficient: statusForBoolean(marlinSufficient),
    },
    escalation: {
      required: escalationRequired,
      signals: [...escalationSignals],
    },
    provider: {
      staticVlm: cloud.provider.staticVlm,
      agentic: cloud.provider.agentic,
      agenticModel: cloud.provider.agenticModel,
    },
    budget: cloud.budget,
  };
}

function providerBudgetFailureReasons(
  budgetStatuses: VideoReasoningRouteBudgetStatuses,
): VideoReasoningRouteReasonCode[] {
  const reasons: VideoReasoningRouteReasonCode[] = [];
  if (budgetStatuses.requests === "fail") reasons.push("budget_requests_exhausted");
  if (budgetStatuses.uploadedDurationUs === "fail") reasons.push("budget_upload_duration_exhausted");
  if (budgetStatuses.uploadedBytes === "fail") reasons.push("budget_upload_bytes_exhausted");
  if (budgetStatuses.inputTokens === "fail") reasons.push("budget_input_tokens_exhausted");
  if (budgetStatuses.inputTokens === "unknown") reasons.push("budget_input_tokens_unknown");
  if (budgetStatuses.estimatedUsd === "fail") reasons.push("budget_estimated_usd_exhausted");
  if (budgetStatuses.estimatedUsd === "unknown") reasons.push("budget_estimated_usd_unknown");
  return reasons;
}

function evaluateCloudRoute(
  input: NormalizedRouteInput,
  providerRoute: "static_vlm" | "agentic",
  effectiveSourceDurationUs: number,
  derivativeRequired: boolean,
): VideoReasoningCloudEvaluation {
  const consent = input.consentApproved !== true
    ? input.consentApproved === null ? "unknown" : "fail"
    : input.consentScope === input.privacy ? "pass" : "fail";
  const derivativeBinding: VideoReasoningConstraintStatus = !derivativeRequired
    ? "not_applicable"
    : input.submittedMediaIdentityDistinct === null
      ? "unknown"
      : input.submittedMediaIdentityDistinct ? "pass" : "fail";
  const uploadEstimateValid = input.estimatedUploadDurationUs !== null &&
    input.estimatedUploadBytes !== null &&
    input.estimatedUploadDurationUs <= effectiveSourceDurationUs;
  const budget: VideoReasoningRouteBudgetStatuses = {
    requests: input.remainingRequests === null
      ? "unknown"
      : input.remainingRequests >= 1 ? "pass" : "fail",
    uploadedDurationUs: input.remainingUploadedDurationUs === null || input.estimatedUploadDurationUs === null
      ? "unknown"
      : input.remainingUploadedDurationUs >= input.estimatedUploadDurationUs ? "pass" : "fail",
    uploadedBytes: input.remainingUploadedBytes === null || input.estimatedUploadBytes === null
      ? "unknown"
      : input.remainingUploadedBytes >= input.estimatedUploadBytes ? "pass" : "fail",
    inputTokens: input.remainingInputTokens === null
      ? "not_applicable"
      : input.estimatedInputTokens === null
        ? input.remainingInputTokens === 0 ? "fail" : "unknown"
        : input.remainingInputTokens >= input.estimatedInputTokens ? "pass" : "fail",
    estimatedUsd: input.remainingEstimatedUsd === null
      ? "not_applicable"
      : input.estimatedUsd === null
        ? input.remainingEstimatedUsd === 0 ? "fail" : "unknown"
        : input.remainingEstimatedUsd >= input.estimatedUsd ? "pass" : "fail",
  };
  const provider: VideoReasoningRouteProviderStatuses = {
    staticVlm: providerRoute === "static_vlm" ? statusForBoolean(input.staticVlmAvailable) : "not_applicable",
    agentic: providerRoute === "agentic" ? statusForBoolean(input.agenticAvailable) : "not_applicable",
    agenticModel: providerRoute === "agentic" ? statusForBoolean(input.agenticModelSupported) : "not_applicable",
  };

  const reasonCodes: VideoReasoningRouteReasonCode[] = [];
  if (consent !== "pass") {
    reasonCodes.push(consent === "fail" && input.consentApproved === true
      ? "cloud_consent_scope_mismatch"
      : "cloud_consent_missing");
  }
  if (derivativeBinding === "fail" || derivativeBinding === "unknown") {
    reasonCodes.push("derivative_identity_missing");
  }
  if (!uploadEstimateValid) reasonCodes.push("source_upload_estimate_invalid");

  if (providerRoute === "static_vlm") {
    if (provider.staticVlm === "fail") reasonCodes.push("static_vlm_unavailable");
    if (provider.staticVlm === "unknown") reasonCodes.push("provider_capability_ambiguous");
  } else {
    if (provider.agentic === "fail") reasonCodes.push("agentic_capability_unavailable");
    if (provider.agentic === "unknown" || provider.agenticModel === "unknown") {
      reasonCodes.push("provider_capability_ambiguous");
    }
    if (provider.agenticModel === "fail") reasonCodes.push("agentic_model_unsupported");
  }

  const requiredBudgetUnknown = budget.requests === "unknown" ||
    budget.uploadedDurationUs === "unknown" || budget.uploadedBytes === "unknown";
  if (requiredBudgetUnknown || !input.optionalBudgetFieldsValid) reasonCodes.push("budget_ambiguous");
  reasonCodes.push(...providerBudgetFailureReasons(budget));

  return {
    consent,
    upload: consent,
    derivativeBinding,
    provider,
    budget,
    reasonCodes: uniqueReasonCodes(reasonCodes),
    eligible: reasonCodes.length === 0,
  };
}

function decision(
  input: NormalizedRouteInput,
  kind: VideoReasoningRouteDecisionKind,
  reasonCodes: readonly VideoReasoningRouteReasonCode[],
  constraints: VideoReasoningRouteConstraints,
  reserveProvider: boolean,
): VideoReasoningRouteDecision {
  const before = budgetBefore(input);
  const budgetEffect = reserveProvider ? providerReservation(input, before) : noReservation(before);
  return {
    decision: kind,
    reasonCodes: uniqueReasonCodes(reasonCodes),
    constraints,
    sourceRangeUs: input.sourceRangeUs,
    estimatedUploadDurationUs: input.estimatedUploadDurationUs,
    estimatedUploadBytes: input.estimatedUploadBytes,
    budget: {
      before,
      reservation: budgetEffect.reservation,
      afterReservation: budgetEffect.afterReservation,
    },
  };
}

/**
 * Decide the next video-reasoning lane without invoking any provider.
 *
 * The returned provider reservation is a deterministic preview. A caller must
 * atomically apply equivalent accounting before invoking either provider;
 * this pure function itself cannot mutate a ledger. `apiKeyPresent` is ignored
 * by design and is never projected into the decision.
 */
export function decideVideoReasoningRoute(
  input: VideoReasoningRouteInput,
): VideoReasoningRouteDecision {
  const normalized = normalizeInput(input);
  const taskSupported = normalized.task === null ? null : AGENTIC_TASK_SET.has(normalized.task);
  const semanticReview = normalized.task === "roughcut_review"
    ? normalized.semanticReviewRequested === true ? "pass" : normalized.semanticReviewRequested === null ? "unknown" : "fail"
    : "not_applicable";

  const privacyIsCloud = normalized.privacy === "bounded_derivative" || normalized.privacy === "source_allowed";
  const rangeIsFull = normalized.sourceRangeUs !== null && normalized.sourceDurationUs !== null &&
    normalized.sourceRangeUs[0] === 0 && normalized.sourceRangeUs[1] === normalized.sourceDurationUs;
  const derivativeRequired = privacyIsCloud &&
    (normalized.privacy === "bounded_derivative" || !rangeIsFull);

  const marlinStateAmbiguous = normalized.marlinAvailable === true &&
    (normalized.marlinConfidence === null || normalized.marlinCoverage === null || normalized.marlinDegraded === null);
  const localEvidenceAmbiguous = normalized.candidateConflict === null ||
    normalized.unresolvedUncertainty === null ||
    normalized.temporalReasoningRequired === null ||
    normalized.staticEvidenceSufficient === null ||
    normalized.editorialImpact === null ||
    normalized.marlinAvailable === null;

  const effectiveSourceDurationUs = normalized.sourceRangeUs === null
    ? null
    : normalized.sourceRangeUs[1] - normalized.sourceRangeUs[0];
  const sourceInvalid = normalized.sourceIdentityValid !== true ||
    normalized.sourceRangeValid !== true ||
    normalized.sourceDurationUs === null ||
    effectiveSourceDurationUs === null ||
    !Number.isSafeInteger(effectiveSourceDurationUs) || effectiveSourceDurationUs <= 0;
  const policyInvalid = normalized.policy === null;

  const universalHardReasons: VideoReasoningRouteReasonCode[] = [];
  if (normalized.privacy === "invalid") universalHardReasons.push("privacy_mode_invalid");
  if (taskSupported !== true) universalHardReasons.push("task_unsupported");
  if (normalized.task === "roughcut_review" && normalized.semanticReviewRequested !== true) {
    universalHardReasons.push("semantic_review_not_requested");
  }
  if (normalized.sourceIdentityValid !== true) universalHardReasons.push("source_identity_invalid");
  if (normalized.sourceRangeValid !== true || normalized.sourceDurationUs === null) {
    universalHardReasons.push("source_range_invalid");
  }
  if (marlinStateAmbiguous || localEvidenceAmbiguous) universalHardReasons.push("local_evidence_ambiguous");
  if (policyInvalid) universalHardReasons.push("policy_invalid");

  const marlinSufficient = normalized.marlinAvailable === null || marlinStateAmbiguous
    ? null
    : normalized.marlinAvailable && normalized.marlinConfidence !== null && normalized.marlinCoverage !== null &&
      normalized.marlinDegraded === false &&
      normalized.marlinConfidence >= (normalized.policy?.marlinConfidenceThreshold ?? VIDEO_REASONING_ROUTER_DEFAULTS.marlinConfidenceThreshold) &&
      normalized.marlinCoverage >= (normalized.policy?.marlinCoverageThreshold ?? VIDEO_REASONING_ROUTER_DEFAULTS.marlinCoverageThreshold);

  const escalationSignals: VideoReasoningRouteReasonCode[] = [];
  if (normalized.marlinAvailable === false) escalationSignals.push("marlin_unavailable");
  if (normalized.marlinAvailable === true && normalized.marlinDegraded === true) {
    escalationSignals.push("marlin_degraded");
  }
  if (normalized.marlinConfidence !== null &&
      normalized.marlinConfidence < (normalized.policy?.marlinConfidenceThreshold ?? VIDEO_REASONING_ROUTER_DEFAULTS.marlinConfidenceThreshold)) {
    escalationSignals.push("marlin_confidence_below_threshold");
  }
  if (normalized.marlinCoverage !== null &&
      normalized.marlinCoverage < (normalized.policy?.marlinCoverageThreshold ?? VIDEO_REASONING_ROUTER_DEFAULTS.marlinCoverageThreshold)) {
    escalationSignals.push("marlin_coverage_incomplete");
  }
  if (effectiveSourceDurationUs !== null && normalized.task === "needle_search" &&
      effectiveSourceDurationUs >= (normalized.policy?.longFormMinDurationUs ?? VIDEO_REASONING_ROUTER_DEFAULTS.longFormMinDurationUs)) {
    escalationSignals.push("long_form_needle_search");
  }
  if (normalized.candidateConflict === true) escalationSignals.push("candidate_conflict");
  if (normalized.unresolvedUncertainty === true) escalationSignals.push("unresolved_uncertainty");
  if (normalized.editorialImpact === "high") escalationSignals.push("editorial_impact_high");
  if (normalized.temporalReasoningRequired === true) escalationSignals.push("temporal_reasoning_required");
  if (normalized.task === "roughcut_review" && normalized.semanticReviewRequested === true) {
    escalationSignals.push("whole_cut_review_requested");
  }
  // A weak/partial Marlin result does not by itself force whole-video
  // reasoning when the caller has explicitly established that a static frame
  // bundle is sufficient. Material temporal/semantic signals always remain
  // Agentic triggers; otherwise local evidence insufficiency becomes an
  // Agentic trigger only when static evidence is not sufficient.
  const localEvidenceSignals = new Set<VideoReasoningRouteReasonCode>([
    "marlin_unavailable",
    "marlin_degraded",
    "marlin_confidence_below_threshold",
    "marlin_coverage_incomplete",
  ]);
  const dynamicEscalationSignals = escalationSignals.filter((signal) => !localEvidenceSignals.has(signal));
  const localEvidenceNeedsEscalation = escalationSignals.some((signal) => localEvidenceSignals.has(signal));
  const universalEvidenceAmbiguous = marlinStateAmbiguous || localEvidenceAmbiguous;
  const escalationRequired: boolean | null = universalEvidenceAmbiguous
    ? null
    : dynamicEscalationSignals.length > 0 ||
      (localEvidenceNeedsEscalation && normalized.staticEvidenceSufficient !== true);
  const marlinUsable = normalized.marlinAvailable === true && !marlinStateAmbiguous;
  const noCloudConstraints = buildConstraints(
    normalized,
    taskSupported,
    semanticReview,
    marlinSufficient,
    escalationRequired,
    escalationSignals,
    null,
  );

  if (universalHardReasons.length > 0 || sourceInvalid) {
    return decision(
      normalized,
      "blocked",
      uniqueReasonCodes(universalHardReasons),
      noCloudConstraints,
      false,
    );
  }

  if (normalized.privacy === "local_only") {
    if (normalized.marlinAvailable !== true) {
      return decision(normalized, "blocked", ["local_only_policy", "marlin_unavailable"], noCloudConstraints, false);
    }
    const localReasons: VideoReasoningRouteReasonCode[] = ["local_only_policy"];
    if (marlinSufficient === true) localReasons.push("marlin_evidence_sufficient");
    if (escalationRequired === true) {
      localReasons.push("agentic_deferred_privacy", ...escalationSignals);
    } else if (marlinSufficient !== true) {
      localReasons.push("local_fallback");
    } else {
      localReasons.push("no_escalation_signal");
    }
    if (normalized.staticEvidenceSufficient === true) localReasons.push("static_cloud_disallowed");
    return decision(normalized, "local", localReasons, noCloudConstraints, false);
  }

  // A valid local result wins before any cloud-only preflight is inspected.
  if (marlinSufficient === true && escalationRequired === false) {
    return decision(normalized, "local", ["marlin_evidence_sufficient", "no_escalation_signal"], noCloudConstraints, false);
  }

  if (escalationRequired === false && normalized.staticEvidenceSufficient === true) {
    const staticEvaluation = evaluateCloudRoute(
      normalized,
      "static_vlm",
      effectiveSourceDurationUs,
      derivativeRequired,
    );
    const staticConstraints = buildConstraints(
      normalized,
      taskSupported,
      semanticReview,
      marlinSufficient,
      escalationRequired,
      escalationSignals,
      staticEvaluation,
    );
    if (staticEvaluation.eligible) {
      return decision(
        normalized,
        "static_vlm",
        ["static_frame_bundle_sufficient", "static_vlm_selected"],
        staticConstraints,
        true,
      );
    }
    const staticFallbackReasons: VideoReasoningRouteReasonCode[] = [
      ...staticEvaluation.reasonCodes,
      "static_vlm_deferred",
      "local_fallback",
    ];
    if (marlinUsable) {
      return decision(normalized, "local", staticFallbackReasons, staticConstraints, false);
    }
    return decision(
      normalized,
      "blocked",
      ["static_vlm_deferred", ...staticEvaluation.reasonCodes],
      staticConstraints,
      false,
    );
  }

  if (escalationRequired === false) {
    if (marlinUsable) {
      return decision(normalized, "local", ["local_fallback", "no_escalation_signal"], noCloudConstraints, false);
    }
    return decision(normalized, "blocked", ["marlin_unavailable", "agentic_escalation_required"], noCloudConstraints, false);
  }

  const agenticEvaluation = evaluateCloudRoute(
    normalized,
    "agentic",
    effectiveSourceDurationUs,
    derivativeRequired,
  );
  const agenticConstraints = buildConstraints(
    normalized,
    taskSupported,
    semanticReview,
    marlinSufficient,
    escalationRequired,
    escalationSignals,
    agenticEvaluation,
  );
  const escalationReasonCodes: VideoReasoningRouteReasonCode[] = [
    "agentic_escalation_required",
    ...escalationSignals,
  ];
  if (agenticEvaluation.eligible) {
    return decision(
      normalized,
      "agentic",
      [...escalationReasonCodes, "agentic_selected", "budget_reserved"],
      agenticConstraints,
      true,
    );
  }

  const agenticDeferredReasons: VideoReasoningRouteReasonCode[] = [
    ...escalationReasonCodes,
    ...agenticEvaluation.reasonCodes,
    "agentic_deferred",
  ];
  if (marlinUsable) {
    return decision(
      normalized,
      "local",
      [...agenticDeferredReasons, "local_fallback"],
      agenticConstraints,
      false,
    );
  }
  return decision(
    normalized,
    "blocked",
    [...agenticDeferredReasons, "marlin_unavailable"],
    agenticConstraints,
    false,
  );
}

/** Alias with a verb matching callers that treat the router as a pure planner. */
export const routeVideoReasoning = decideVideoReasoningRoute;
