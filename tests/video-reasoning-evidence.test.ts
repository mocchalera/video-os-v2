import { describe, expect, it } from "vitest";
import { validateAgainstSchema } from "../runtime/commands/shared.js";
import { validateArtifact } from "../runtime/artifacts/loaders.js";
import {
  assertVideoReasoningEvidenceIntegrity,
  buildVideoReasoningEvidenceArtifact,
  normalizeVideoReasoningEvidence,
  validateVideoReasoningEvidenceIntegrity,
  VIDEO_REASONING_EVIDENCE_SCHEMA_FILE,
  VideoReasoningEvidenceNormalizationError,
} from "../runtime/analysis/video-reasoning-evidence.js";
import {
  computePromptHash,
  computeVideoReasoningRequestHash,
  VIDEO_REASONING_CONTRACT_VERSION,
  VIDEO_REASONING_RESPONSE_SCHEMA_VERSION,
  type VideoReasoningDiagnostic,
  type VideoReasoningRequest,
  type VideoReasoningResult,
} from "../runtime/connectors/video-reasoning-types.js";

const ORIGINAL_SHA256 = "a".repeat(64);
const SUBMITTED_SHA256 = "b".repeat(64);
const SOURCE_DURATION_US = 10_000_000;
const EFFECTIVE_RANGE_US = [2_000_000, 8_000_000] as const;

function makeRequest(overrides: Partial<VideoReasoningRequest> = {}): VideoReasoningRequest {
  return {
    task: "moment_refine",
    model: "gemini-3.7-flash",
    prompt: "Find the clearest reveal and return bounded evidence.",
    source: {
      assetId: "AST_001",
      sourceContentSha256: ORIGINAL_SHA256,
      submittedMediaContentSha256: SUBMITTED_SHA256,
      sourceDurationUs: SOURCE_DURATION_US,
      rangeUs: EFFECTIVE_RANGE_US,
    },
    input: {
      kind: "provider_uri",
      uri: "gs://registered-bucket/m3a-proxy.mp4",
      mimeType: "video/mp4",
    },
    privacy: "bounded_derivative",
    consent: { approved: true, scope: "bounded_derivative" },
    budget: { maxRequests: 1, maxUploadedDurationUs: 6_000_000 },
    ...overrides,
  };
}

function effectiveRange(request: VideoReasoningRequest): readonly [number, number] {
  return request.source.rangeUs ?? [0, request.source.sourceDurationUs];
}

function makeDiagnostic(
  request: VideoReasoningRequest,
  overrides: Partial<VideoReasoningDiagnostic> = {},
): VideoReasoningDiagnostic {
  const range = effectiveRange(request);
  return {
    provider: "gemini",
    connectorVersion: "gemini-agentic-video-v1.1",
    contractVersion: VIDEO_REASONING_CONTRACT_VERSION,
    responseSchemaVersion: VIDEO_REASONING_RESPONSE_SCHEMA_VERSION,
    requestHash: computeVideoReasoningRequestHash(request, range),
    promptHash: computePromptHash(request.prompt),
    sourceAssetId: request.source.assetId,
    sourceContentSha256: request.source.sourceContentSha256,
    submittedMediaContentSha256: request.source.submittedMediaContentSha256 ?? request.source.sourceContentSha256,
    sourceRangeUs: [...range],
    inputKind: request.input.kind,
    mimeType: request.input.mimeType,
    model: request.model,
    task: request.task,
    processingRequested: "agentic",
    storeRequested: false,
    agenticUsed: true,
    processingCallCount: 1,
    processingResultCount: 1,
    matchedProcessingPairCount: 1,
    submitted: true,
    outcome: "completed",
    errorCode: "none",
    elapsedMs: 12,
    providerRequestId: "interaction-123",
    usage: {
      promptTokens: 10,
      completionTokens: 5,
      totalTokens: 15,
      totalThoughtTokens: 2,
      totalToolUseTokens: 3,
    },
    ...overrides,
  };
}

function makeResult(
  request = makeRequest(),
  diagnosticOverrides: Partial<VideoReasoningDiagnostic> = {},
  resultOverrides: Partial<VideoReasoningResult> = {},
): VideoReasoningResult {
  const range = effectiveRange(request);
  return {
    outcome: "completed",
    summary: "Provider summary is deliberately not projected into tracked evidence.",
    observations: [{
      startUs: range[0],
      endUs: range[1],
      label: "clear_reveal",
      rationale: "The subject turns and the object becomes readable.",
      confidence: 0.84,
      localVerification: "not_run",
    }],
    diagnostic: makeDiagnostic(request, diagnosticOverrides),
    ...resultOverrides,
  };
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

describe("M3a video reasoning evidence normalization", () => {
  it("normalizes completed Agentic evidence and validates its strict schema", () => {
    const request = makeRequest();
    const artifact = normalizeVideoReasoningEvidence(request, makeResult(request));

    expect(artifact).toMatchObject({
      artifact_version: "video-reasoning-evidence/v1",
      artifact_kind: "derived_evidence",
      authority: "derived_evidence_only",
      provider: "gemini",
      request_hash: computeVideoReasoningRequestHash(request, EFFECTIVE_RANGE_US),
      prompt_hash: computePromptHash(request.prompt),
      model: "gemini-3.7-flash",
      task: "moment_refine",
      processing_requested: "agentic",
      processing_observed: "agentic",
      evidence_basis: "provider_only",
      confidence_basis: "degraded",
      outcome: "completed",
      local_verification: { status: "not_run", records: [] },
    });
    expect(artifact.source).toEqual({
      asset_id: "AST_001",
      source_content_sha256: ORIGINAL_SHA256,
      submitted_media_content_sha256: SUBMITTED_SHA256,
      source_duration_us: SOURCE_DURATION_US,
      effective_source_range_us: [...EFFECTIVE_RANGE_US],
    });
    expect(artifact.observations[0]).toMatchObject({
      label: "clear_reveal",
      rationale: "The subject turns and the object becomes readable.",
      observation: null,
      inference: null,
      editorial_intent: null,
      provider_range_us: [...EFFECTIVE_RANGE_US],
      confidence: 0.5,
      confidence_basis: "degraded",
    });
    expect(artifact.execution).toMatchObject({
      provider_outcome: "completed",
      processing_call_count: 1,
      processing_result_count: 1,
      matched_processing_pair_count: 1,
      elapsed_ms: 12,
    });
    expect(validateAgainstSchema(artifact, VIDEO_REASONING_EVIDENCE_SCHEMA_FILE)).toEqual({
      valid: true,
      errors: [],
    });
  });

  it("uses explicitly supplied non-Gemini provider provenance and binds it to IDs", () => {
    const request = makeRequest();
    const gemini = normalizeVideoReasoningEvidence(request, makeResult(request));
    const synthetic = normalizeVideoReasoningEvidence(
      request,
      makeResult(request, { provider: "synthetic-provider" }),
    );

    expect(synthetic.provider).toBe("synthetic-provider");
    expect(synthetic.artifact_id).not.toBe(gemini.artifact_id);
    expect(synthetic.observations[0].observation_id).not.toBe(gemini.observations[0].observation_id);
    expect(validateAgainstSchema(synthetic, VIDEO_REASONING_EVIDENCE_SCHEMA_FILE).valid).toBe(true);
    expect(() => normalizeVideoReasoningEvidence(
      request,
      makeResult(request, { provider: undefined }),
    )).toThrow(VideoReasoningEvidenceNormalizationError);
  });

  it("is deterministic, has stable IDs, and accepts the exact full-source boundary", () => {
    const request = makeRequest({
      source: {
        assetId: "AST_FULL",
        sourceContentSha256: ORIGINAL_SHA256,
        sourceDurationUs: SOURCE_DURATION_US,
      },
      privacy: "source_allowed",
      consent: { approved: true, scope: "source_allowed" },
    });
    const first = normalizeVideoReasoningEvidence(request, makeResult(request));
    const second = buildVideoReasoningEvidenceArtifact(request, makeResult(request));

    expect(second).toEqual(first);
    expect(first.artifact_id).toMatch(/^VREA_[a-f0-9]{64}$/);
    expect(first.observations[0].observation_id).toMatch(/^VREO_[a-f0-9]{64}$/);
    expect(first.observations[0].provider_range_us).toEqual([0, SOURCE_DURATION_US]);
  });

  it("accepts exact boundaries of a bounded effective source range", () => {
    const request = makeRequest();
    const artifact = normalizeVideoReasoningEvidence(request, makeResult(request));
    expect(artifact.observations[0].provider_range_us).toEqual([...EFFECTIVE_RANGE_US]);
  });

  it.each([
    ["negative start", { startUs: -1, endUs: 2_500_000 }],
    ["zero length", { startUs: 2_500_000, endUs: 2_500_000 }],
    ["non-integer start", { startUs: 2_000_000.5, endUs: 2_500_000 }],
    ["overflow", { startUs: Number.MAX_SAFE_INTEGER + 1, endUs: Number.MAX_SAFE_INTEGER + 2 }],
    ["outside source duration", { startUs: 7_500_000, endUs: SOURCE_DURATION_US + 1 }],
    ["outside effective range", { startUs: EFFECTIVE_RANGE_US[0] - 1, endUs: 2_500_000 }],
  ])("rejects %s provider timestamps without clamping or dropping", (_label, range) => {
    const request = makeRequest();
    const result = makeResult(request);
    result.observations[0] = {
      ...result.observations[0],
      ...range,
    };

    expect(() => normalizeVideoReasoningEvidence(request, result)).toThrow(VideoReasoningEvidenceNormalizationError);
  });

  it("fails closed for every request/diagnostic identity component", () => {
    const request = makeRequest();
    const result = makeResult(request);
    const mismatches: Array<[string, VideoReasoningRequest, Partial<VideoReasoningDiagnostic>]> = [
      ["asset", request, { sourceAssetId: "AST_OTHER" }],
      ["original source hash", request, { sourceContentSha256: "c".repeat(64) }],
      ["submitted media hash", request, { submittedMediaContentSha256: "d".repeat(64) }],
      ["source duration", {
        ...request,
        source: { ...request.source, sourceDurationUs: SOURCE_DURATION_US + 1_000_000 },
      }, {}],
      ["effective range", {
        ...request,
        source: { ...request.source, rangeUs: [3_000_000, 8_000_000] },
      }, {}],
      ["request hash", request, { requestHash: "e".repeat(64) }],
      ["prompt hash", request, { promptHash: "f".repeat(64) }],
      ["model", request, { model: "gemini-3.6-flash" }],
      ["task", request, { task: "needle_search" }],
      ["contract version", request, { contractVersion: "video-reasoning/v2" as typeof VIDEO_REASONING_CONTRACT_VERSION }],
      ["response schema version", request, { responseSchemaVersion: "video-reasoning-response/v2" as typeof VIDEO_REASONING_RESPONSE_SCHEMA_VERSION }],
      ["processing requested", request, { processingRequested: "static" as "agentic" }],
    ];

    for (const [label, mismatchedRequest, diagnosticOverrides] of mismatches) {
      expect(
        () => normalizeVideoReasoningEvidence(mismatchedRequest, {
          ...result,
          diagnostic: { ...result.diagnostic, ...diagnosticOverrides },
        }),
        label,
      ).toThrow(VideoReasoningEvidenceNormalizationError);
    }
  });

  it("does not claim Agentic processing when requested steps are unproved", () => {
    const request = makeRequest();
    const result = makeResult(request, {
      agenticUsed: false,
      processingCallCount: 0,
      processingResultCount: 0,
      matchedProcessingPairCount: 0,
    });
    const artifact = normalizeVideoReasoningEvidence(request, result);

    expect(artifact.processing_observed).toBe("unverified");
    expect(artifact.outcome).toBe("degraded");
    expect(artifact.confidence_basis).toBe("unmeasured");
    expect(artifact.observations[0].confidence).toBeLessThanOrEqual(0.5);
    expect(artifact.observations[0].confidence_basis).toBe("unmeasured");
  });

  it("rejects impossible M1 submitted/outcome/processing/observation combinations", () => {
    const request = makeRequest();
    const cases: Array<[string, VideoReasoningResult]> = [
      ["review reproduction: completed but not submitted", makeResult(request, { submitted: false })],
      ["completed with an error classification", makeResult(request, { errorCode: "provider_http_error" })],
      ["failed with no error classification", makeResult(request, {
        outcome: "failed",
        errorCode: "none",
        agenticUsed: false,
        processingCallCount: 0,
        processingResultCount: 0,
        matchedProcessingPairCount: 0,
      }, { outcome: "failed", observations: [] })],
      ["unknown with a failed-only error classification", makeResult(request, {
        outcome: "unknown",
        errorCode: "api_key_missing",
        agenticUsed: false,
        processingCallCount: 0,
        processingResultCount: 0,
        matchedProcessingPairCount: 0,
      }, { outcome: "unknown", observations: [] })],
      ["unknown transport error before submission", makeResult(request, {
        outcome: "unknown",
        errorCode: "transport_error_unknown",
        submitted: false,
        agenticUsed: false,
        processingCallCount: 0,
        processingResultCount: 0,
        matchedProcessingPairCount: 0,
      }, { outcome: "unknown", observations: [] })],
      ["rejected with no error classification", makeResult(request, {
        outcome: "rejected",
        errorCode: "none",
        agenticUsed: false,
        processingCallCount: 0,
        processingResultCount: 0,
        matchedProcessingPairCount: 0,
      }, { outcome: "rejected", observations: [] })],
      ["unsubmitted processing evidence", makeResult(request, {
        outcome: "failed",
        submitted: false,
        errorCode: "provider_http_error",
        agenticUsed: false,
        processingCallCount: 1,
        processingResultCount: 1,
        matchedProcessingPairCount: 0,
      }, { outcome: "failed", observations: [] })],
      ["failed result with observations", makeResult(request, {
        outcome: "failed",
        agenticUsed: false,
        processingCallCount: 0,
        processingResultCount: 0,
        matchedProcessingPairCount: 0,
        errorCode: "provider_http_error",
      }, { outcome: "failed" })],
      ["rejected result after submission", makeResult(request, {
        outcome: "rejected",
        errorCode: "local_only",
        submitted: true,
      }, { outcome: "rejected", observations: [] })],
      ["agentic flag contradicts matched pair count", makeResult(request, {
        agenticUsed: false,
      })],
      ["matched pair exceeds processing counts", makeResult(request, {
        processingCallCount: 0,
        processingResultCount: 1,
        matchedProcessingPairCount: 1,
      })],
    ];

    for (const [label, result] of cases) {
      expect(() => normalizeVideoReasoningEvidence(request, result), label)
        .toThrow(VideoReasoningEvidenceNormalizationError);
    }
  });

  it("preserves failed and unknown truth without fabricating usage or timing", () => {
    const request = makeRequest();
    const failed = normalizeVideoReasoningEvidence(request, makeResult(
      request,
      {
        outcome: "failed",
        errorCode: "provider_http_error",
        agenticUsed: false,
        processingCallCount: 0,
        processingResultCount: 0,
        matchedProcessingPairCount: 0,
        usage: undefined,
        elapsedMs: 20,
      },
      { outcome: "failed", observations: [] },
    ));
    const unknown = normalizeVideoReasoningEvidence(request, makeResult(
      request,
      {
        outcome: "unknown",
        errorCode: "transport_timeout_unknown",
        agenticUsed: false,
        processingCallCount: 0,
        processingResultCount: 0,
        matchedProcessingPairCount: 0,
        usage: undefined,
        elapsedMs: 21,
      },
      { outcome: "unknown", observations: [] },
    ));

    expect(failed).toMatchObject({
      outcome: "failed",
      execution: { provider_outcome: "failed", error_classification: "provider_http_error", elapsed_ms: 20 },
    });
    expect(failed).not.toHaveProperty("usage");
    expect(unknown).toMatchObject({
      outcome: "unknown",
      execution: { provider_outcome: "unknown", error_classification: "transport_timeout_unknown", elapsed_ms: 21 },
    });
    expect(unknown).not.toHaveProperty("usage");
    expect(failed).not.toHaveProperty("started_at");
    expect(unknown).not.toHaveProperty("completed_at");
  });

  it("accepts representative M1 execution truth states", () => {
    const request = makeRequest();
    type ExecutionCase = [
      string,
      Partial<VideoReasoningDiagnostic>,
      Partial<VideoReasoningResult>,
      "completed" | "degraded" | "failed" | "unknown",
    ];
    const cases: ExecutionCase[] = [
      ["completed agentic", {}, {}, "completed"],
      ["completed degraded without proof", {
        agenticUsed: false,
        processingCallCount: 0,
        processingResultCount: 0,
        matchedProcessingPairCount: 0,
      }, {}, "degraded"],
      ["completed degraded with unmatched processing", {
        agenticUsed: false,
        processingCallCount: 1,
        processingResultCount: 1,
        matchedProcessingPairCount: 0,
      }, {}, "degraded"],
      ["rejected pre-submit", {
        outcome: "rejected",
        errorCode: "local_only",
        submitted: false,
        agenticUsed: false,
        processingCallCount: 0,
        processingResultCount: 0,
        matchedProcessingPairCount: 0,
      }, { outcome: "rejected", observations: [] }, "failed"],
      ["failed pre-submit", {
        outcome: "failed",
        errorCode: "api_key_missing",
        submitted: false,
        agenticUsed: false,
        processingCallCount: 0,
        processingResultCount: 0,
        matchedProcessingPairCount: 0,
      }, { outcome: "failed", observations: [] }, "failed"],
      ["failed post-submit", {
        outcome: "failed",
        errorCode: "provider_http_error",
        submitted: true,
        agenticUsed: false,
        processingCallCount: 0,
        processingResultCount: 0,
        matchedProcessingPairCount: 0,
      }, { outcome: "failed", observations: [] }, "failed"],
      ["unknown post-submit", {
        outcome: "unknown",
        errorCode: "transport_error_unknown",
        submitted: true,
        agenticUsed: false,
        processingCallCount: 0,
        processingResultCount: 0,
        matchedProcessingPairCount: 0,
      }, { outcome: "unknown", observations: [] }, "unknown"],
    ];

    for (const [label, diagnosticOverrides, resultOverrides, expectedOutcome] of cases) {
      const artifact = normalizeVideoReasoningEvidence(
        request,
        makeResult(request, diagnosticOverrides, resultOverrides),
      );
      expect(artifact.outcome, label).toBe(expectedOutcome);
      expect(validateVideoReasoningEvidenceIntegrity(artifact), label)
        .toEqual({ valid: true, errors: [] });
      expect(validateArtifact(artifact, VIDEO_REASONING_EVIDENCE_SCHEMA_FILE), label)
        .toEqual(artifact);
    }
  });

  it("rejects schema-valid execution truth contradictions through the artifact loader", () => {
    const request = makeRequest();
    const artifact = normalizeVideoReasoningEvidence(request, makeResult(request));
    const executionTruthCounterexamples: Array<[string, Record<string, unknown>]> = [
      ["completed without submission", {
        ...artifact,
        outcome: "degraded",
        processing_observed: "unverified",
        execution: {
          ...artifact.execution,
          submitted: false,
          processing_call_count: 0,
          processing_result_count: 0,
          matched_processing_pair_count: 0,
        },
      }],
      ["unknown before submission", {
        ...artifact,
        outcome: "unknown",
        processing_observed: "unverified",
        observations: [],
        execution: {
          ...artifact.execution,
          provider_outcome: "unknown",
          error_classification: "transport_error_unknown",
          submitted: false,
          processing_call_count: 0,
          processing_result_count: 0,
          matched_processing_pair_count: 0,
        },
      }],
      ["agentic processing without counts", {
        ...artifact,
        outcome: "completed",
        processing_observed: "agentic",
        execution: {
          ...artifact.execution,
          submitted: true,
          processing_call_count: 0,
          processing_result_count: 0,
          matched_processing_pair_count: 0,
        },
      }],
      ["derived outcome mismatch", {
        ...artifact,
        outcome: "degraded",
      }],
      ["unsubmitted processing counts", {
        ...artifact,
        outcome: "failed",
        processing_observed: "unverified",
        observations: [],
        execution: {
          ...artifact.execution,
          provider_outcome: "failed",
          error_classification: "provider_http_error",
          submitted: false,
          processing_call_count: 1,
          processing_result_count: 1,
          matched_processing_pair_count: 0,
        },
      }],
      ["matched count exceeds processing counts", {
        ...artifact,
        outcome: "completed",
        processing_observed: "agentic",
        execution: {
          ...artifact.execution,
          submitted: true,
          processing_call_count: 0,
          processing_result_count: 1,
          matched_processing_pair_count: 1,
        },
      }],
      ["unverified processing claims a matched pair", {
        ...artifact,
        outcome: "degraded",
        processing_observed: "unverified",
        execution: {
          ...artifact.execution,
          submitted: true,
          processing_call_count: 1,
          processing_result_count: 1,
          matched_processing_pair_count: 1,
        },
      }],
      ["rejected after submission", {
        ...artifact,
        outcome: "failed",
        processing_observed: "unverified",
        observations: [],
        execution: {
          ...artifact.execution,
          provider_outcome: "rejected",
          error_classification: "local_only",
          submitted: true,
          processing_call_count: 0,
          processing_result_count: 0,
          matched_processing_pair_count: 0,
        },
      }],
    ];

    for (const [label, counterexample] of executionTruthCounterexamples) {
      expect(validateAgainstSchema(counterexample, VIDEO_REASONING_EVIDENCE_SCHEMA_FILE).valid, label)
        .toBe(true);
      expect(validateVideoReasoningEvidenceIntegrity(counterexample).valid, label)
        .toBe(false);
      expect(() => validateArtifact(counterexample, VIDEO_REASONING_EVIDENCE_SCHEMA_FILE), label)
        .toThrow();
    }
  });

  it("keeps provider label/rationale separate from fabricated #32 semantics", () => {
    const request = makeRequest();
    const artifact = normalizeVideoReasoningEvidence(request, makeResult(request));
    const observation = artifact.observations[0];

    expect(observation.label).toBe("clear_reveal");
    expect(observation.rationale).toBe("The subject turns and the object becomes readable.");
    expect(observation.observation).toBeNull();
    expect(observation.inference).toBeNull();
    expect(observation.editorial_intent).toBeNull();
    expect(observation.confidence_basis).not.toBe("measured");
    expect(artifact.local_verification.status).toBe("not_run");
  });

  it("does not project prompt, path, URI, or provider error sentinels", () => {
    const prompt = "RAW_PROMPT_SENTINEL_DO_NOT_TRACK";
    const request = makeRequest({
      prompt,
      input: {
        kind: "inline",
        path: "/private/project/RAW_LOCAL_PATH_SENTINEL/source.mp4",
        mimeType: "video/mp4",
      },
    });
    const artifact = normalizeVideoReasoningEvidence(request, makeResult(request));
    const serialized = JSON.stringify(artifact);

    expect(serialized).not.toContain(prompt);
    expect(serialized).not.toContain("RAW_LOCAL_PATH_SENTINEL");
    expect(serialized).not.toContain("gs://registered-bucket/m3a-proxy.mp4");
    expect(serialized).not.toContain("API_KEY=super-secret");
    expect(serialized).not.toContain("RAW_PROVIDER_ERROR_SENTINEL");
  });

  it.each([
    ["provider", (result: VideoReasoningResult) => { result.diagnostic.provider = "/mnt/private/provider"; }],
    ["connector version", (result: VideoReasoningResult) => { result.diagnostic.connectorVersion = "/mnt/private/connector"; }],
    ["effective model", (result: VideoReasoningResult) => { result.diagnostic.effectiveModel = "~/private/model"; }],
    ["POSIX mount label", (result: VideoReasoningResult) => {
      result.observations[0].label = "Read /mnt/private/clip.mp4";
    }],
    ["Markdown POSIX mount label", (result: VideoReasoningResult) => {
      result.observations[0].label = "Read `/mnt/private/clip.mp4`";
    }],
    ["provider URI rationale", (result: VideoReasoningResult) => {
      result.observations[0].rationale = "See provider://private/clip";
    }],
    ["label", (result: VideoReasoningResult) => {
      result.observations[0].label = "Read C:\\Users\\private\\label";
    }],
    ["rationale", (result: VideoReasoningResult) => {
      result.observations[0].rationale = "The source is at \\\\server\\\\private\\\\clip.mp4";
    }],
    ["provider request id", (result: VideoReasoningResult) => {
      result.diagnostic.providerRequestId = "API_KEY=super-secret";
    }],
    ["control character", (result: VideoReasoningResult) => {
      result.observations[0].label = "ordinary\nleak";
    }],
  ])("rejects tracked-unsafe %s provider-origin text", (_field, mutate) => {
    const request = makeRequest();
    const result = makeResult(request);
    mutate(result);
    expect(() => normalizeVideoReasoningEvidence(request, result))
      .toThrow(VideoReasoningEvidenceNormalizationError);
  });

  it("retains ordinary natural-language labels and rationales", () => {
    const request = makeRequest();
    const result = makeResult(request);
    result.observations[0].label = "Look left/right for a quiet reveal.";
    result.observations[0].rationale = "The subject settles and/or turns naturally.";

    const artifact = normalizeVideoReasoningEvidence(request, result);
    expect(artifact.observations[0].label).toBe("Look left/right for a quiet reveal.");
    expect(artifact.observations[0].rationale).toBe("The subject settles and/or turns naturally.");
  });

  it("does not mutate frozen inputs and does not create canonical artifact fields", () => {
    const request = deepFreeze(makeRequest());
    const result = deepFreeze(makeResult(request));
    const requestBefore = JSON.stringify(request);
    const resultBefore = JSON.stringify(result);
    const artifact = normalizeVideoReasoningEvidence(request, result);

    expect(JSON.stringify(request)).toBe(requestBefore);
    expect(JSON.stringify(result)).toBe(resultBefore);
    expect(artifact).not.toHaveProperty("timeline");
    expect(artifact).not.toHaveProperty("selects_candidates");
    expect(artifact).not.toHaveProperty("edit_blueprint");
    expect(artifact).not.toHaveProperty("review_report");
  });

  it("rejects unknown fields and invalid schema versions", () => {
    const request = makeRequest();
    const artifact = normalizeVideoReasoningEvidence(request, makeResult(request));

    expect(validateVideoReasoningEvidenceIntegrity(artifact)).toEqual({ valid: true, errors: [] });
    assertVideoReasoningEvidenceIntegrity(artifact);

    const crossFieldCounterexamples = [
      {
        ...artifact,
        observations: [{ ...artifact.observations[0], provider_range_us: [7_000_000, 3_000_000] }],
      },
      {
        ...artifact,
        observations: [{ ...artifact.observations[0], provider_range_us: [0, SOURCE_DURATION_US] }],
      },
    ];
    for (const counterexample of crossFieldCounterexamples) {
      expect(validateAgainstSchema(counterexample, VIDEO_REASONING_EVIDENCE_SCHEMA_FILE).valid).toBe(true);
      expect(validateVideoReasoningEvidenceIntegrity(counterexample).valid).toBe(false);
      expect(() => assertVideoReasoningEvidenceIntegrity(counterexample))
        .toThrow(VideoReasoningEvidenceNormalizationError);
      expect(() => validateArtifact(counterexample, VIDEO_REASONING_EVIDENCE_SCHEMA_FILE)).toThrow();
    }
    const unsafeTrackedArtifact = {
      ...artifact,
      observations: [{ ...artifact.observations[0], label: "Read /mnt/private/clip.mp4" }],
    };
    expect(validateAgainstSchema(unsafeTrackedArtifact, VIDEO_REASONING_EVIDENCE_SCHEMA_FILE).valid).toBe(true);
    expect(validateVideoReasoningEvidenceIntegrity(unsafeTrackedArtifact).valid).toBe(false);
    expect(() => validateArtifact(unsafeTrackedArtifact, VIDEO_REASONING_EVIDENCE_SCHEMA_FILE)).toThrow();
    const markdownUnsafeTrackedArtifact = {
      ...artifact,
      observations: [{ ...artifact.observations[0], label: "Read `/mnt/private/clip.mp4`" }],
    };
    expect(validateAgainstSchema(markdownUnsafeTrackedArtifact, VIDEO_REASONING_EVIDENCE_SCHEMA_FILE).valid).toBe(true);
    expect(validateVideoReasoningEvidenceIntegrity(markdownUnsafeTrackedArtifact).valid).toBe(false);
    expect(() => validateArtifact(markdownUnsafeTrackedArtifact, VIDEO_REASONING_EVIDENCE_SCHEMA_FILE)).toThrow();

    const { error_classification: ignoredErrorClassification, ...executionWithoutError } = artifact.execution;
    void ignoredErrorClassification;
    const outcomeErrorCounterexamples = [
      {
        label: "failed without error classification",
        value: {
          ...artifact,
          outcome: "failed",
          processing_observed: "unverified",
          confidence_basis: "unmeasured",
          observations: [],
          execution: {
            ...executionWithoutError,
            provider_outcome: "failed",
            submitted: true,
            processing_call_count: 0,
            processing_result_count: 0,
            matched_processing_pair_count: 0,
          },
        },
      },
      {
        label: "unknown with failed-only error classification",
        value: {
          ...artifact,
          outcome: "unknown",
          processing_observed: "unverified",
          confidence_basis: "unmeasured",
          observations: [],
          execution: {
            ...executionWithoutError,
            provider_outcome: "unknown",
            error_classification: "api_key_missing",
            submitted: false,
            processing_call_count: 0,
            processing_result_count: 0,
            matched_processing_pair_count: 0,
          },
        },
      },
      {
        label: "rejected without error classification",
        value: {
          ...artifact,
          outcome: "failed",
          processing_observed: "unverified",
          confidence_basis: "unmeasured",
          observations: [],
          execution: {
            ...executionWithoutError,
            provider_outcome: "rejected",
            submitted: false,
            processing_call_count: 0,
            processing_result_count: 0,
            matched_processing_pair_count: 0,
          },
        },
      },
    ];
    for (const counterexample of outcomeErrorCounterexamples) {
      expect(validateAgainstSchema(counterexample.value, VIDEO_REASONING_EVIDENCE_SCHEMA_FILE).valid, counterexample.label)
        .toBe(true);
      expect(validateVideoReasoningEvidenceIntegrity(counterexample.value).valid, counterexample.label)
        .toBe(false);
      expect(() => assertVideoReasoningEvidenceIntegrity(counterexample.value), counterexample.label)
        .toThrow(VideoReasoningEvidenceNormalizationError);
      expect(() => validateArtifact(counterexample.value, VIDEO_REASONING_EVIDENCE_SCHEMA_FILE), counterexample.label)
        .toThrow();
    }
    expect(validateVideoReasoningEvidenceIntegrity({
      ...artifact,
      local_verification: { status: "not_run", records: [{ fabricated: true }] },
    }).valid).toBe(false);

    expect(validateAgainstSchema({ ...artifact, unknown_field: true }, VIDEO_REASONING_EVIDENCE_SCHEMA_FILE).valid).toBe(false);
    expect(validateAgainstSchema({ ...artifact, artifact_version: "video-reasoning-evidence/v2" }, VIDEO_REASONING_EVIDENCE_SCHEMA_FILE).valid).toBe(false);
    expect(validateAgainstSchema({ ...artifact, confidence_basis: "measured" }, VIDEO_REASONING_EVIDENCE_SCHEMA_FILE).valid).toBe(false);
    expect(validateAgainstSchema({
      ...artifact,
      local_verification: { status: "not_run", records: [{ fabricated: true }] },
    }, VIDEO_REASONING_EVIDENCE_SCHEMA_FILE).valid).toBe(false);
    expect(validateAgainstSchema({
      ...artifact,
      observations: [{ ...artifact.observations[0], inference: "fabricated inference" }],
    }, VIDEO_REASONING_EVIDENCE_SCHEMA_FILE).valid).toBe(false);
  });
});
