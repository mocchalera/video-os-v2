import { describe, expect, it, vi } from "vitest";
import {
  decideVideoReasoningRoute,
  type VideoReasoningRouteInput,
} from "../runtime/connectors/video-reasoning-router.js";

const SHORT_DURATION_US = 30_000_000;
const UPLOAD_BYTES = 12_000;

function routeInput(overrides: Partial<VideoReasoningRouteInput> = {}): VideoReasoningRouteInput {
  return {
    task: "moment_refine",
    privacy: "local_only",
    source: {
      identityValid: true,
      durationUs: SHORT_DURATION_US,
      submittedMediaIdentityDistinct: true,
      estimatedUploadDurationUs: SHORT_DURATION_US,
      estimatedUploadBytes: UPLOAD_BYTES,
    },
    marlin: {
      available: true,
      confidence: 0.92,
      coverage: 1,
      degraded: false,
    },
    candidateConflict: false,
    unresolvedUncertainty: false,
    temporalReasoningRequired: false,
    staticEvidenceSufficient: false,
    editorialImpact: "low",
    providerCapability: {
      staticVlmAvailable: true,
      agenticAvailable: true,
      agenticModelSupported: true,
    },
    budget: {
      remainingRequests: 1,
      remainingUploadedDurationUs: SHORT_DURATION_US,
      remainingUploadedBytes: UPLOAD_BYTES,
      remainingInputTokens: 1_000,
      remainingEstimatedUsd: 1,
      estimatedInputTokens: 100,
      estimatedUsd: 0.1,
    },
    semanticReviewRequested: false,
    ...overrides,
  };
}

function cloudInput(overrides: Partial<VideoReasoningRouteInput> = {}): VideoReasoningRouteInput {
  return routeInput({
    privacy: "bounded_derivative",
    consent: { approved: true, scope: "bounded_derivative" },
    ...overrides,
  });
}

function escalationInput(overrides: Partial<VideoReasoningRouteInput> = {}): VideoReasoningRouteInput {
  return cloudInput({
    marlin: {
      available: true,
      confidence: 0.32,
      coverage: 0.45,
      degraded: false,
    },
    candidateConflict: false,
    unresolvedUncertainty: false,
    temporalReasoningRequired: true,
    staticEvidenceSufficient: false,
    editorialImpact: "high",
    ...overrides,
  });
}

describe("deterministic Marlin-first video reasoning router", () => {
  it("returns identical output for identical input and does not mutate the input", () => {
    const input = escalationInput();
    const before = structuredClone(input);

    const first = decideVideoReasoningRoute(input);
    const second = decideVideoReasoningRoute(input);

    expect(first).toEqual(second);
    expect(input).toEqual(before);
    expect(first.decision).toBe("agentic");
  });

  it("keeps local_only local even when an API key is present", () => {
    const provider = vi.fn();
    const result = decideVideoReasoningRoute(routeInput({
      apiKeyPresent: true,
      staticEvidenceSufficient: true,
    }));

    expect(result.decision).toBe("local");
    expect(result.reasonCodes).toContain("local_only_policy");
    expect(result.budget.reservation.status).toBe("none");
    expect(provider).not.toHaveBeenCalled();
  });

  it("keeps local_only local when cloud metadata is absent at runtime", () => {
    const result = decideVideoReasoningRoute(routeInput({
      consent: undefined,
      source: {
        identityValid: true,
        durationUs: SHORT_DURATION_US,
        submittedMediaIdentityDistinct: undefined as unknown as boolean,
        estimatedUploadDurationUs: undefined as unknown as number,
        estimatedUploadBytes: undefined as unknown as number,
      },
      providerCapability: undefined as unknown as VideoReasoningRouteInput["providerCapability"],
      budget: undefined as unknown as VideoReasoningRouteInput["budget"],
    }));

    expect(result.decision).toBe("local");
    expect(result.constraints.privacy.consent).toBe("not_applicable");
    expect(result.constraints.source.derivativeBinding).toBe("not_applicable");
    expect(result.constraints.provider.agentic).toBe("not_applicable");
    expect(result.constraints.budget.requests).toBe("not_applicable");
    expect(result.budget.reservation.status).toBe("none");
  });

  it("defaults omitted privacy to local_only", () => {
    const result = decideVideoReasoningRoute(routeInput({ privacy: undefined }));

    expect(result.decision).toBe("local");
    expect(result.constraints.privacy.mode).toBe("local_only");
    expect(result.reasonCodes).toContain("local_only_policy");
  });

  it("keeps a strong Marlin result local before checking cloud consent", () => {
    const provider = vi.fn();
    const result = decideVideoReasoningRoute(cloudInput({ consent: undefined }));

    expect(result.decision).toBe("local");
    expect(result.reasonCodes).toEqual([
      "marlin_evidence_sufficient",
      "no_escalation_signal",
    ]);
    expect(result.constraints.privacy.consent).toBe("not_applicable");
    expect(result.constraints.privacy.upload).toBe("not_applicable");
    expect(result.constraints.provider.agentic).toBe("not_applicable");
    expect(result.constraints.budget.requests).toBe("not_applicable");
    expect(result.budget.reservation.status).toBe("none");
    expect(provider).not.toHaveBeenCalled();
  });

  it("defers an Agentic route when consent scope does not match the requested privacy mode", () => {
    const provider = vi.fn();
    const result = decideVideoReasoningRoute(escalationInput({
      consent: { approved: true, scope: "source_allowed" },
    }));

    expect(result.decision).toBe("local");
    expect(result.reasonCodes).toContain("cloud_consent_scope_mismatch");
    expect(result.reasonCodes).toContain("agentic_deferred");
    expect(result.reasonCodes).toContain("local_fallback");
    expect(result.constraints.privacy.upload).toBe("fail");
    expect(result.budget.reservation.status).toBe("none");
    expect(provider).not.toHaveBeenCalled();
  });

  it("does not treat API-key presence as cloud consent", () => {
    const withKey = decideVideoReasoningRoute(escalationInput({
      consent: undefined,
      apiKeyPresent: true,
    }));
    const withoutKey = decideVideoReasoningRoute(escalationInput({ consent: undefined }));

    expect(withKey).toEqual(withoutKey);
    expect(withKey.decision).toBe("local");
    expect(withKey.reasonCodes).toContain("cloud_consent_missing");
    expect(withKey.reasonCodes).toContain("agentic_deferred");
    expect(withKey.budget.reservation.status).toBe("none");
  });

  it("defers eligible Agentic escalation to usable Marlin when consent is missing", () => {
    const result = decideVideoReasoningRoute(escalationInput({ consent: undefined }));

    expect(result.decision).toBe("local");
    expect(result.reasonCodes).toContain("agentic_escalation_required");
    expect(result.reasonCodes).toContain("cloud_consent_missing");
    expect(result.reasonCodes).toContain("agentic_deferred");
    expect(result.reasonCodes).toContain("local_fallback");
    expect(result.budget.reservation.status).toBe("none");
  });

  it("blocks an unsupported task before considering any route", () => {
    const provider = vi.fn();
    const result = decideVideoReasoningRoute(routeInput({ task: "unsupported_task" }));

    expect(result.decision).toBe("blocked");
    expect(result.reasonCodes).toContain("task_unsupported");
    expect(result.constraints.task.supported).toBe("fail");
    expect(provider).not.toHaveBeenCalled();
  });

  it("keeps source identity validation strict before any cloud decision", () => {
    const result = decideVideoReasoningRoute(cloudInput({
      source: {
        identityValid: false,
        durationUs: SHORT_DURATION_US,
        submittedMediaIdentityDistinct: true,
        estimatedUploadDurationUs: SHORT_DURATION_US,
        estimatedUploadBytes: UPLOAD_BYTES,
      },
    }));

    expect(result.decision).toBe("blocked");
    expect(result.reasonCodes).toContain("source_identity_invalid");
    expect(result.constraints.provider.agentic).toBe("not_applicable");
    expect(result.budget.reservation.status).toBe("none");
  });

  it("keeps source range validation strict before any cloud decision", () => {
    const result = decideVideoReasoningRoute(cloudInput({
      source: {
        identityValid: true,
        durationUs: SHORT_DURATION_US,
        rangeUs: [0, SHORT_DURATION_US + 1],
        submittedMediaIdentityDistinct: true,
        estimatedUploadDurationUs: SHORT_DURATION_US,
        estimatedUploadBytes: UPLOAD_BYTES,
      },
    }));

    expect(result.decision).toBe("blocked");
    expect(result.reasonCodes).toContain("source_range_invalid");
    expect(result.constraints.provider.agentic).toBe("not_applicable");
    expect(result.budget.reservation.status).toBe("none");
  });

  it("keeps a high-confidence, fully covered Marlin result local", () => {
    const provider = vi.fn();
    const result = decideVideoReasoningRoute(cloudInput());

    expect(result.decision).toBe("local");
    expect(result.reasonCodes).toEqual([
      "marlin_evidence_sufficient",
      "no_escalation_signal",
    ]);
    expect(result.constraints.marlin.sufficient).toBe("pass");
    expect(result.constraints.marlin.degraded).toBe("pass");
    expect(result.budget.reservation.status).toBe("none");
    expect(provider).not.toHaveBeenCalled();
  });

  it("selects static frame-bundle VLM for a short question it can answer", () => {
    const provider = vi.fn();
    const result = decideVideoReasoningRoute(cloudInput({
      marlin: {
        available: true,
        confidence: 0.4,
        coverage: 0.5,
        degraded: false,
      },
      temporalReasoningRequired: false,
      staticEvidenceSufficient: true,
      editorialImpact: "low",
    }));

    expect(result.decision).toBe("static_vlm");
    expect(result.reasonCodes).toEqual([
      "static_frame_bundle_sufficient",
      "static_vlm_selected",
    ]);
    expect(result.budget.reservation).toMatchObject({
      status: "reserved",
      purpose: "provider_request_preflight",
      requests: 1,
      uploadedDurationUs: SHORT_DURATION_US,
      uploadedBytes: UPLOAD_BYTES,
      inputTokens: 100,
      estimatedUsd: 0.1,
      release: "if_not_submitted",
      unknownOutcome: "remain_reserved_until_operator_resolution",
    });
    expect(result.budget.afterReservation).toEqual({
      requests: 0,
      uploadedDurationUs: 0,
      uploadedBytes: 0,
      inputTokens: 900,
      estimatedUsd: 0.9,
    });
    expect(provider).not.toHaveBeenCalled();
  });

  it("does not flag a long original asset when the selected needle range is short", () => {
    const result = decideVideoReasoningRoute(cloudInput({
      task: "needle_search",
      source: {
        identityValid: true,
        durationUs: 20 * 60 * 1_000_000,
        rangeUs: [0, SHORT_DURATION_US],
        submittedMediaIdentityDistinct: true,
        estimatedUploadDurationUs: SHORT_DURATION_US,
        estimatedUploadBytes: UPLOAD_BYTES,
      },
      marlin: {
        available: true,
        confidence: 0.4,
        coverage: 0.5,
        degraded: false,
      },
      staticEvidenceSufficient: true,
      editorialImpact: "low",
    }));

    expect(result.decision).toBe("static_vlm");
    expect(result.reasonCodes).not.toContain("long_form_needle_search");
  });

  it("flags a genuinely long selected needle range", () => {
    const selectedDurationUs = 10 * 60 * 1_000_000;
    const result = decideVideoReasoningRoute(cloudInput({
      task: "needle_search",
      source: {
        identityValid: true,
        durationUs: 20 * 60 * 1_000_000,
        rangeUs: [0, selectedDurationUs],
        submittedMediaIdentityDistinct: true,
        estimatedUploadDurationUs: selectedDurationUs,
        estimatedUploadBytes: UPLOAD_BYTES,
      },
      staticEvidenceSufficient: false,
      editorialImpact: "medium",
      budget: {
        ...routeInput().budget,
        remainingUploadedDurationUs: selectedDurationUs,
      },
    }));

    expect(result.decision).toBe("agentic");
    expect(result.reasonCodes).toContain("long_form_needle_search");
  });

  it("defers a static provider route to usable Marlin when its request budget is exhausted", () => {
    const result = cloudInput({
      marlin: {
        available: true,
        confidence: 0.4,
        coverage: 0.5,
        degraded: false,
      },
      temporalReasoningRequired: false,
      staticEvidenceSufficient: true,
      editorialImpact: "low",
      budget: {
        ...routeInput().budget,
        remainingRequests: 0,
      },
    });

    const decision = decideVideoReasoningRoute(result);

    expect(decision.decision).toBe("local");
    expect(decision.reasonCodes).toContain("budget_requests_exhausted");
    expect(decision.reasonCodes).toContain("static_vlm_deferred");
    expect(decision.reasonCodes).toContain("local_fallback");
    expect(decision.budget.reservation.status).toBe("none");
  });

  it("validates only the selected static capability", () => {
    const result = decideVideoReasoningRoute(cloudInput({
      marlin: {
        available: true,
        confidence: 0.4,
        coverage: 0.5,
        degraded: false,
      },
      staticEvidenceSufficient: true,
      providerCapability: {
        staticVlmAvailable: true,
        agenticAvailable: undefined as unknown as boolean,
        agenticModelSupported: undefined as unknown as boolean,
      },
    }));

    expect(result.decision).toBe("static_vlm");
    expect(result.constraints.provider.staticVlm).toBe("pass");
    expect(result.constraints.provider.agentic).toBe("not_applicable");
    expect(result.constraints.provider.agenticModel).toBe("not_applicable");
    expect(result.reasonCodes).not.toContain("provider_capability_ambiguous");
    expect(result.budget.reservation.status).toBe("reserved");
  });

  it("selects Agentic only for deterministic low-confidence/high-impact escalation", () => {
    const provider = vi.fn();
    const result = decideVideoReasoningRoute(escalationInput());

    expect(result.decision).toBe("agentic");
    expect(result.reasonCodes).toEqual([
      "agentic_escalation_required",
      "marlin_confidence_below_threshold",
      "marlin_coverage_incomplete",
      "editorial_impact_high",
      "temporal_reasoning_required",
      "agentic_selected",
      "budget_reserved",
    ]);
    expect(result.budget.reservation).toMatchObject({
      status: "reserved",
      purpose: "provider_request_preflight",
      requests: 1,
      uploadedDurationUs: SHORT_DURATION_US,
      uploadedBytes: UPLOAD_BYTES,
      inputTokens: 100,
      estimatedUsd: 0.1,
      release: "if_not_submitted",
      unknownOutcome: "remain_reserved_until_operator_resolution",
    });
    expect(result.budget.afterReservation).toEqual({
      requests: 0,
      uploadedDurationUs: 0,
      uploadedBytes: 0,
      inputTokens: 900,
      estimatedUsd: 0.9,
    });
    expect(provider).not.toHaveBeenCalled();
  });

  it("escalates a material candidate conflict even when Marlin confidence is high", () => {
    const result = decideVideoReasoningRoute(escalationInput({
      marlin: {
        available: true,
        confidence: 0.95,
        coverage: 1,
        degraded: false,
      },
      candidateConflict: true,
      temporalReasoningRequired: false,
      editorialImpact: "medium",
    }));

    expect(result.decision).toBe("agentic");
    expect(result.reasonCodes).toContain("candidate_conflict");
    expect(result.reasonCodes).not.toContain("marlin_confidence_below_threshold");
  });

  it("defers an eligible escalation to usable Marlin when Agentic is unavailable", () => {
    const provider = vi.fn();
    const result = decideVideoReasoningRoute(escalationInput({
      providerCapability: {
        staticVlmAvailable: true,
        agenticAvailable: false,
        agenticModelSupported: true,
      },
    }));

    expect(result.decision).toBe("local");
    expect(result.reasonCodes).toContain("agentic_capability_unavailable");
    expect(result.reasonCodes).toContain("agentic_deferred");
    expect(result.reasonCodes).toContain("local_fallback");
    expect(result.budget.reservation.status).toBe("none");
    expect(provider).not.toHaveBeenCalled();
  });

  it("uses static evidence when Marlin is unavailable and Agentic is not required", () => {
    const result = decideVideoReasoningRoute(cloudInput({
      marlin: {
        available: false,
        confidence: null,
        coverage: null,
        degraded: true,
      },
      staticEvidenceSufficient: true,
      temporalReasoningRequired: false,
      editorialImpact: "low",
    }));

    expect(result.decision).toBe("static_vlm");
    expect(result.constraints.escalation.signals).toContain("marlin_unavailable");
    expect(result.constraints.escalation.signals).not.toContain("marlin_degraded");
    expect(result.constraints.marlin.degraded).toBe("not_applicable");
  });

  it("allows an eligible Agentic fallback when Marlin is unavailable", () => {
    const result = decideVideoReasoningRoute(escalationInput({
      marlin: {
        available: false,
        confidence: null,
        coverage: null,
        degraded: false,
      },
      staticEvidenceSufficient: false,
    }));

    expect(result.decision).toBe("agentic");
    expect(result.reasonCodes).toContain("marlin_unavailable");
    expect(result.budget.reservation.status).toBe("reserved");
  });

  it("blocks when escalation is unavailable and Marlin is unavailable", () => {
    const result = decideVideoReasoningRoute(escalationInput({
      consent: undefined,
      marlin: {
        available: false,
        confidence: null,
        coverage: null,
        degraded: false,
      },
      providerCapability: {
        staticVlmAvailable: false,
        agenticAvailable: false,
        agenticModelSupported: false,
      },
      budget: {
        ...routeInput().budget,
        remainingRequests: 0,
      },
    }));

    expect(result.decision).toBe("blocked");
    expect(result.reasonCodes).toContain("cloud_consent_missing");
    expect(result.reasonCodes).toContain("agentic_capability_unavailable");
    expect(result.reasonCodes).toContain("budget_requests_exhausted");
    expect(result.reasonCodes).toContain("agentic_deferred");
    expect(result.reasonCodes).toContain("marlin_unavailable");
    expect(result.budget.reservation.status).toBe("none");
  });

  it.each([
    ["requests", "budget_requests_exhausted"],
    ["uploaded duration", "budget_upload_duration_exhausted"],
    ["uploaded bytes", "budget_upload_bytes_exhausted"],
    ["input tokens", "budget_input_tokens_exhausted"],
    ["estimated cost", "budget_estimated_usd_exhausted"],
  ] as const)("defers before provider work when %s budget is exhausted", (_label, reasonCode) => {
    const input = escalationInput();
    if (reasonCode === "budget_requests_exhausted") input.budget.remainingRequests = 0;
    if (reasonCode === "budget_upload_duration_exhausted") input.budget.remainingUploadedDurationUs = 0;
    if (reasonCode === "budget_upload_bytes_exhausted") input.budget.remainingUploadedBytes = 0;
    if (reasonCode === "budget_input_tokens_exhausted") input.budget.remainingInputTokens = 0;
    if (reasonCode === "budget_estimated_usd_exhausted") input.budget.remainingEstimatedUsd = 0;

    const provider = vi.fn();
    const result = decideVideoReasoningRoute(input);

    expect(result.decision).toBe("local");
    expect(result.reasonCodes).toContain(reasonCode);
    expect(result.reasonCodes).toContain("agentic_deferred");
    expect(result.reasonCodes).toContain("local_fallback");
    expect(result.budget.reservation.status).toBe("none");
    expect(provider).not.toHaveBeenCalled();
  });

  it("defers escalation under local_only while retaining Marlin as the only lane", () => {
    const provider = vi.fn();
    const result = decideVideoReasoningRoute(routeInput({
      marlin: {
        available: true,
        confidence: 0.3,
        coverage: 0.4,
        degraded: true,
      },
      editorialImpact: "high",
      temporalReasoningRequired: true,
    }));

    expect(result.decision).toBe("local");
    expect(result.reasonCodes).toContain("local_only_policy");
    expect(result.reasonCodes).toContain("agentic_deferred_privacy");
    expect(result.constraints.marlin.degraded).toBe("fail");
    expect(result.budget.reservation.status).toBe("none");
    expect(provider).not.toHaveBeenCalled();
  });

  it("fails closed for ambiguous local evidence before cloud capability checks", () => {
    const provider = vi.fn();
    const result = decideVideoReasoningRoute(routeInput({
      marlin: { available: true, confidence: null, coverage: 0.9 },
      providerCapability: {
        staticVlmAvailable: true,
        agenticAvailable: true,
        agenticModelSupported: undefined as unknown as boolean,
      },
    }));

    expect(result.decision).toBe("blocked");
    expect(result.reasonCodes).toContain("local_evidence_ambiguous");
    expect(result.reasonCodes).not.toContain("provider_capability_ambiguous");
    expect(result.constraints.provider.agentic).toBe("not_applicable");
    expect(provider).not.toHaveBeenCalled();
  });

  it("fails closed when required Marlin availability or editorial impact is absent", () => {
    const result = decideVideoReasoningRoute(routeInput({
      marlin: {
        available: undefined as unknown as boolean,
        confidence: 0.92,
        coverage: 1,
        degraded: false,
      },
      editorialImpact: undefined as unknown as string,
    }));

    expect(result.decision).toBe("blocked");
    expect(result.reasonCodes).toContain("local_evidence_ambiguous");
    expect(result.constraints.marlin.degraded).toBe("unknown");
  });

  it("reports an unknown Marlin degraded state as unknown and fails closed", () => {
    const result = decideVideoReasoningRoute(routeInput({
      marlin: {
        available: true,
        confidence: 0.92,
        coverage: 1,
        degraded: null as unknown as boolean,
      },
    }));

    expect(result.decision).toBe("blocked");
    expect(result.constraints.marlin.degraded).toBe("unknown");
  });

  it("keeps a strong Marlin result local when optional cloud budget metadata is malformed", () => {
    const result = decideVideoReasoningRoute(cloudInput({
      budget: {
        ...routeInput().budget,
        remainingInputTokens: -1,
      },
    }));

    expect(result.decision).toBe("local");
    expect(result.reasonCodes).toEqual([
      "marlin_evidence_sufficient",
      "no_escalation_signal",
    ]);
    expect(result.reasonCodes).not.toContain("budget_ambiguous");
    expect(result.constraints.budget.requests).toBe("not_applicable");
    expect(result.budget.reservation.status).toBe("none");
  });

  it("defers an Agentic route when a derivative identity is not distinct", () => {
    const provider = vi.fn();
    const result = decideVideoReasoningRoute(escalationInput({
      source: {
        identityValid: true,
        durationUs: SHORT_DURATION_US,
        submittedMediaIdentityDistinct: false,
        estimatedUploadDurationUs: SHORT_DURATION_US,
        estimatedUploadBytes: UPLOAD_BYTES,
      },
    }));

    expect(result.decision).toBe("local");
    expect(result.reasonCodes).toContain("derivative_identity_missing");
    expect(result.reasonCodes).toContain("agentic_deferred");
    expect(result.reasonCodes).toContain("local_fallback");
    expect(result.budget.reservation.status).toBe("none");
    expect(provider).not.toHaveBeenCalled();
  });

  it("keeps a strong Marlin result local when derivative and cloud metadata are absent", () => {
    const result = decideVideoReasoningRoute(cloudInput({
      source: {
        identityValid: true,
        durationUs: SHORT_DURATION_US,
        submittedMediaIdentityDistinct: undefined as unknown as boolean,
        estimatedUploadDurationUs: undefined as unknown as number,
        estimatedUploadBytes: undefined as unknown as number,
      },
      providerCapability: undefined as unknown as VideoReasoningRouteInput["providerCapability"],
      budget: undefined as unknown as VideoReasoningRouteInput["budget"],
    }));

    expect(result.decision).toBe("local");
    expect(result.reasonCodes).toEqual([
      "marlin_evidence_sufficient",
      "no_escalation_signal",
    ]);
    expect(result.constraints.source.derivativeBinding).toBe("not_applicable");
    expect(result.constraints.provider.staticVlm).toBe("not_applicable");
    expect(result.constraints.budget.requests).toBe("not_applicable");
    expect(result.budget.reservation.status).toBe("none");
  });

  it("blocks roughcut review without an explicit semantic-review request", () => {
    const result = decideVideoReasoningRoute(cloudInput({
      task: "roughcut_review",
      semanticReviewRequested: false,
    }));

    expect(result.decision).toBe("blocked");
    expect(result.reasonCodes).toContain("semantic_review_not_requested");
  });
});
