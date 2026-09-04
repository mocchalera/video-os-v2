/**
 * M3a provider-neutral evidence normalization.
 *
 * The returned value is a derived, provider-only evidence artifact. It is not
 * a replacement for selects, edit_blueprint, review_report, or timeline.json.
 * This module deliberately has no filesystem, media, FFmpeg, network, provider
 * client, cache/ledger, pipeline, or canonical-artifact dependency.
 */

import { createHash } from "node:crypto";
import {
  computePromptHash,
  computeVideoReasoningRequestHash,
  validateVideoReasoningRequest,
  VIDEO_REASONING_CONTRACT_VERSION,
  VIDEO_REASONING_RESPONSE_SCHEMA_VERSION,
  type VideoReasoningErrorCode,
  type VideoReasoningOutcome,
  type VideoReasoningRequest,
  type VideoReasoningResult,
  type VideoReasoningUsage,
} from "../connectors/video-reasoning-types.js";
import {
  DEGRADED_CONFIDENCE_CEILING,
  type ConfidenceBasis,
} from "../eval/brief-alignment-types.js";

export const VIDEO_REASONING_EVIDENCE_ARTIFACT_VERSION =
  "video-reasoning-evidence/v1" as const;
export const VIDEO_REASONING_EVIDENCE_SCHEMA_FILE =
  "video-reasoning-evidence.schema.json" as const;

const MAX_OBSERVATIONS = 32;
const MAX_PROCESSING_STEPS = 1024;
const MAX_USAGE_VALUE = 1_000_000_000;
const SHA256_PATTERN = /^[a-f0-9]{64}$/i;
const ASSET_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const SAFE_IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/@+\-]{0,255}$/;
const PROVIDER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const PROVIDER_REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f-\u009f]/;
const PROVIDER_URI_PATTERN = /\b[A-Za-z][A-Za-z0-9+.-]{0,31}:\/\/[^\s"'<>]+/i;
const POSIX_ABSOLUTE_PATH_PATTERN = /(?:^|[^\p{L}\p{N}_])\/[^\s"'<>]+/u;
const HOME_RELATIVE_PATH_PATTERN = /(?:^|[\s"'=:(])~[\\/]/;
const WINDOWS_ABSOLUTE_PATH_PATTERN = /(?:^|[\s"'=:(])(?:[A-Za-z]:[\\/]|\\\\)[^\s"'<>]+/;
const SECRET_MARKER_PATTERN = /(?:\b(?:api[_ -]?key|access[_ -]?token|credential|password)\b\s*[:=]\s*\S+|\bsecret\b\s*[:=]\s*\S{8,}|\bbearer\b\s+[A-Za-z0-9._-]{8,}|(?:^|[\s"'(])sk-[A-Za-z0-9][A-Za-z0-9_-]{7,})/i;

const TASKS = new Set<VideoReasoningRequest["task"]>([
  "needle_search",
  "moment_refine",
  "trim_refine",
  "continuity_check",
  "roughcut_review",
  "anomaly_inspection",
]);

const RESULT_OUTCOMES = new Set<VideoReasoningOutcome>([
  "completed",
  "rejected",
  "failed",
  "unknown",
]);

const ERROR_CODES = new Set<VideoReasoningErrorCode>([
  "none",
  "invalid_request",
  "local_only",
  "cloud_consent_required",
  "cloud_consent_scope_mismatch",
  "unsupported_model",
  "provider_uri_not_allowed",
  "request_budget_exceeded",
  "duration_budget_exceeded",
  "input_read_failed",
  "input_too_large",
  "request_too_large",
  "input_content_hash_mismatch",
  "api_key_missing",
  "transport_timeout_unknown",
  "transport_error_unknown",
  "provider_http_error",
  "provider_response_invalid",
  "provider_response_too_large",
  "interaction_incomplete",
  "agentic_steps_missing",
  "structured_output_invalid",
]);

type NonNoneVideoReasoningErrorCode = Exclude<VideoReasoningErrorCode, "none">;

// This is the M1 connector's resultWithError truth table. Keep the sets
// provider-neutral here: the normalizer records the supplied provider, while
// outcome/error compatibility remains the versioned M1 contract.
const REJECTED_ERROR_CODES = new Set<NonNoneVideoReasoningErrorCode>([
  "invalid_request",
  "local_only",
  "cloud_consent_required",
  "cloud_consent_scope_mismatch",
  "unsupported_model",
  "provider_uri_not_allowed",
  "request_budget_exceeded",
  "duration_budget_exceeded",
  "input_too_large",
  "request_too_large",
  "input_content_hash_mismatch",
]);
const FAILED_ERROR_CODES = new Set<NonNoneVideoReasoningErrorCode>([
  "input_read_failed",
  "api_key_missing",
  "provider_http_error",
  "provider_response_invalid",
  "provider_response_too_large",
  "interaction_incomplete",
  "agentic_steps_missing",
  "structured_output_invalid",
]);
const UNKNOWN_ERROR_CODES = new Set<NonNoneVideoReasoningErrorCode>([
  "transport_timeout_unknown",
  "transport_error_unknown",
]);

export type VideoReasoningEvidenceProcessingObserved = "agentic" | "unverified";
export type VideoReasoningEvidenceOutcome = "completed" | "degraded" | "failed" | "unknown";
export type VideoReasoningEvidenceConfidenceBasis = Exclude<ConfidenceBasis, "measured">;

const EVIDENCE_OUTCOMES = new Set<VideoReasoningEvidenceOutcome>([
  "completed",
  "degraded",
  "failed",
  "unknown",
]);

/** M3b extension record; M3a never creates one. */
export interface LocalMomentVerification {
  provider_observation_id: string;
  requested_window_us: [number, number];
  verified_window_us?: [number, number];
  frame_timestamps_us: number[];
  source_content_sha256: string;
  outcome: "confirmed" | "adjusted" | "rejected" | "inconclusive";
  rationale_code: string;
}

/** Compatibility name for callers that treated this as an extension point. */
export type LocalMomentVerificationExtension = LocalMomentVerification;

export interface VideoReasoningLocalVerificationState {
  /** M3a never performs local verification; M3b may populate records. */
  status: "not_run";
  records: LocalMomentVerification[];
}

export interface VideoReasoningEvidenceObservation {
  observation_id: string;
  /** These two fields are provider labels, not #32 editorial judgments. */
  label: string;
  rationale: string;
  /** M1 does not supply the #32 semantic fields, so they remain explicit nulls. */
  observation: null;
  inference: null;
  editorial_intent: null;
  /** Original-source-relative provider range; never local verification timing. */
  provider_range_us: [number, number];
  confidence: number;
  confidence_basis: VideoReasoningEvidenceConfidenceBasis;
}

export interface VideoReasoningEvidenceSource {
  asset_id: string;
  source_content_sha256: string;
  submitted_media_content_sha256: string;
  source_duration_us: number;
  effective_source_range_us: [number, number];
}

export interface VideoReasoningEvidenceUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  total_thought_tokens?: number;
  total_tool_use_tokens?: number;
}

export interface VideoReasoningEvidenceExecution {
  provider_outcome: VideoReasoningOutcome;
  error_classification?: Exclude<VideoReasoningErrorCode, "none">;
  submitted: boolean;
  processing_call_count: number;
  processing_result_count: number;
  matched_processing_pair_count: number;
  elapsed_ms?: number;
}

/**
 * Provider-neutral, tracked-safe evidence. This derived artifact must not be
 * promoted as a canonical timeline, selects, blueprint, or review report.
 * Provider-only observations intentionally do not create #32 SourceEvidenceRef
 * entries or measured EditorialJudgment claims.
 */
export interface VideoReasoningEvidenceArtifact {
  artifact_id: string;
  artifact_version: typeof VIDEO_REASONING_EVIDENCE_ARTIFACT_VERSION;
  artifact_kind: "derived_evidence";
  authority: "derived_evidence_only";
  provider: string;
  connector_version: string;
  effective_model?: string;
  request_hash: string;
  prompt_hash: string;
  model: string;
  task: VideoReasoningRequest["task"];
  contract_version: typeof VIDEO_REASONING_CONTRACT_VERSION;
  response_schema_version: typeof VIDEO_REASONING_RESPONSE_SCHEMA_VERSION;
  processing_requested: "agentic";
  processing_observed: VideoReasoningEvidenceProcessingObserved;
  evidence_basis: "provider_only";
  provider_request_id?: string;
  source: VideoReasoningEvidenceSource;
  observations: VideoReasoningEvidenceObservation[];
  local_verification: VideoReasoningLocalVerificationState;
  confidence_basis: VideoReasoningEvidenceConfidenceBasis;
  outcome: VideoReasoningEvidenceOutcome;
  usage?: VideoReasoningEvidenceUsage;
  execution: VideoReasoningEvidenceExecution;
}

export type VideoReasoningEvidence = VideoReasoningEvidenceArtifact;

export class VideoReasoningEvidenceNormalizationError extends Error {
  readonly code = "VIDEO_REASONING_EVIDENCE_REJECTED" as const;

  constructor(reason: string) {
    super(`video reasoning evidence rejected: ${reason}`);
    this.name = "VideoReasoningEvidenceNormalizationError";
  }
}

function reject(reason: string): never {
  throw new VideoReasoningEvidenceNormalizationError(reason);
}

export interface VideoReasoningEvidenceIntegrityValidation {
  valid: boolean;
  errors: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSafeNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isSafePositiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function validateArtifactRange(
  value: unknown,
  field: string,
  upperBoundUs: number,
  errors: string[],
): [number, number] | undefined {
  if (!Array.isArray(value) || value.length !== 2 ||
      !isSafeNonNegativeInteger(value[0]) || !isSafeNonNegativeInteger(value[1]) ||
      value[0] >= value[1] || value[1] > upperBoundUs) {
    errors.push(`${field} invalid`);
    return undefined;
  }
  return [value[0], value[1]];
}

function hasGenericTrackedUnsafeText(value: string): boolean {
  return PROVIDER_URI_PATTERN.test(value) ||
    POSIX_ABSOLUTE_PATH_PATTERN.test(value) ||
    HOME_RELATIVE_PATH_PATTERN.test(value) ||
    WINDOWS_ABSOLUTE_PATH_PATTERN.test(value) ||
    SECRET_MARKER_PATTERN.test(value);
}

function validateArtifactTrackedText(
  value: unknown,
  field: string,
  maxBytes: number,
  errors: string[],
): void {
  if (typeof value !== "string" ||
      value.trim().length === 0 ||
      Buffer.byteLength(value, "utf8") > maxBytes ||
      CONTROL_CHARACTER_PATTERN.test(value) ||
      hasGenericTrackedUnsafeText(value)) {
    errors.push(`${field} contains unsafe text`);
  }
}

function isM1OutcomeErrorCompatible(
  outcome: VideoReasoningOutcome,
  errorCode: VideoReasoningErrorCode,
): boolean {
  if (outcome === "completed") return errorCode === "none";
  if (errorCode === "none") return false;
  if (outcome === "rejected") return REJECTED_ERROR_CODES.has(errorCode);
  if (outcome === "failed") return FAILED_ERROR_CODES.has(errorCode);
  if (outcome === "unknown") return UNKNOWN_ERROR_CODES.has(errorCode);
  return false;
}

interface VideoReasoningExecutionIntegrityInput {
  providerOutcome: unknown;
  errorCode: unknown;
  submitted: unknown;
  processingCallCount: unknown;
  processingResultCount: unknown;
  matchedProcessingPairCount: unknown;
  processingObserved: unknown;
  derivedOutcome: unknown;
}

/**
 * Shared execution truth gate for raw M1 diagnostics and tracked artifacts.
 * An omitted artifact error classification is treated as `none` so missing
 * non-completed classifications fail closed without changing the schema.
 */
function validateVideoReasoningExecutionIntegrity(
  input: VideoReasoningExecutionIntegrityInput,
): VideoReasoningEvidenceIntegrityValidation {
  const errors: string[] = [];
  const providerOutcome = input.providerOutcome;
  const errorCode = input.errorCode === undefined ? "none" : input.errorCode;
  const outcomeValid = typeof providerOutcome === "string" &&
    RESULT_OUTCOMES.has(providerOutcome as VideoReasoningOutcome);
  const errorCodeValid = typeof errorCode === "string" &&
    ERROR_CODES.has(errorCode as VideoReasoningErrorCode);
  const submittedValid = typeof input.submitted === "boolean";
  const countsValid = [
    input.processingCallCount,
    input.processingResultCount,
    input.matchedProcessingPairCount,
  ].every(isSafeNonNegativeInteger);
  const processingObservedValid = input.processingObserved === "agentic" ||
    input.processingObserved === "unverified";
  const derivedOutcomeValid = typeof input.derivedOutcome === "string" &&
    EVIDENCE_OUTCOMES.has(input.derivedOutcome as VideoReasoningEvidenceOutcome);

  if (!outcomeValid) errors.push("provider outcome invalid");
  if (!errorCodeValid) errors.push("error classification invalid");
  if (!submittedValid) errors.push("submitted invalid");
  if (!countsValid) errors.push("processing counts invalid");
  if (!processingObservedValid) errors.push("processing observed invalid");
  if (!derivedOutcomeValid) errors.push("derived outcome invalid");

  if (!outcomeValid || !errorCodeValid || !submittedValid || !countsValid ||
      !processingObservedValid || !derivedOutcomeValid) {
    return { valid: errors.length === 0, errors };
  }

  const typedOutcome = providerOutcome as VideoReasoningOutcome;
  const typedErrorCode = errorCode as VideoReasoningErrorCode;
  const processingCallCount = input.processingCallCount as number;
  const processingResultCount = input.processingResultCount as number;
  const matchedProcessingPairCount = input.matchedProcessingPairCount as number;
  const submitted = input.submitted as boolean;
  const processingObserved = input.processingObserved as VideoReasoningEvidenceProcessingObserved;
  const derivedOutcome = input.derivedOutcome as VideoReasoningEvidenceOutcome;

  if (!isM1OutcomeErrorCompatible(typedOutcome, typedErrorCode)) {
    errors.push("outcome/error classification mismatch");
  }
  if (matchedProcessingPairCount > processingCallCount ||
      matchedProcessingPairCount > processingResultCount) {
    errors.push("matched processing pair count exceeds processing counts");
  }
  if (!submitted && (processingCallCount > 0 || processingResultCount > 0 ||
      matchedProcessingPairCount > 0 || processingObserved !== "unverified")) {
    errors.push("unsubmitted execution contains processing evidence");
  }
  if (processingObserved === "agentic" &&
      (processingCallCount <= 0 || processingResultCount <= 0 || matchedProcessingPairCount <= 0)) {
    errors.push("agentic processing lacks positive execution counts");
  }
  if (processingObserved === "unverified" && matchedProcessingPairCount > 0) {
    errors.push("unverified processing claims a matched pair");
  }
  if (typedOutcome === "completed" && !submitted) {
    errors.push("completed provider outcome was not submitted");
  }
  if (typedOutcome === "unknown" && !submitted) {
    errors.push("unknown provider outcome was not submitted");
  }
  if (typedOutcome === "rejected" &&
      (submitted || processingCallCount > 0 || processingResultCount > 0 ||
       matchedProcessingPairCount > 0)) {
    errors.push("rejected provider outcome contains submitted processing state");
  }

  const expectedDerivedOutcome: VideoReasoningEvidenceOutcome = typedOutcome === "unknown"
    ? "unknown"
    : typedOutcome === "completed"
      ? processingObserved === "agentic" ? "completed" : "degraded"
      : "failed";
  if (derivedOutcome !== expectedDerivedOutcome) {
    errors.push("derived outcome disagrees with provider execution");
  }

  return { valid: errors.length === 0, errors };
}

function validateArtifactExecutionIntegrity(
  value: Record<string, unknown>,
  errors: string[],
): void {
  const execution = value.execution;
  if (!isRecord(execution)) {
    errors.push("execution invalid");
    return;
  }
  const validation = validateVideoReasoningExecutionIntegrity({
    providerOutcome: execution.provider_outcome,
    errorCode: execution.error_classification,
    submitted: execution.submitted,
    processingCallCount: execution.processing_call_count,
    processingResultCount: execution.processing_result_count,
    matchedProcessingPairCount: execution.matched_processing_pair_count,
    processingObserved: value.processing_observed,
    derivedOutcome: value.outcome,
  });
  errors.push(...validation.errors.map((error) => `execution ${error}`));
}

/**
 * Validate cross-field evidence invariants that JSON Schema cannot compare.
 * Call this after the strict artifact schema validator; it is also invoked by
 * the normalizer before returning an artifact.
 */
export function validateVideoReasoningEvidenceIntegrity(
  value: unknown,
): VideoReasoningEvidenceIntegrityValidation {
  const errors: string[] = [];
  if (!isRecord(value)) return { valid: false, errors: ["artifact must be an object"] };

  validateArtifactExecutionIntegrity(value, errors);

  validateArtifactTrackedText(value.provider, "provider", 64, errors);
  validateArtifactTrackedText(value.connector_version, "connector_version", 256, errors);
  validateArtifactTrackedText(value.model, "model", 256, errors);
  if (value.effective_model !== undefined) {
    validateArtifactTrackedText(value.effective_model, "effective_model", 256, errors);
  }
  if (value.provider_request_id !== undefined) {
    validateArtifactTrackedText(value.provider_request_id, "provider_request_id", 256, errors);
  }

  const source = value.source;
  const sourceRecord = isRecord(source) ? source : undefined;
  if (!sourceRecord) errors.push("source invalid");
  const sourceDurationUs = sourceRecord?.source_duration_us;
  const sourceDurationValid = isSafePositiveInteger(sourceDurationUs);
  if (!sourceDurationValid) errors.push("source.source_duration_us invalid");

  const effectiveRangeUs = sourceDurationValid
    ? validateArtifactRange(
        sourceRecord?.effective_source_range_us,
        "source.effective_source_range_us",
        sourceDurationUs,
        errors,
      )
    : undefined;

  const observations = value.observations;
  if (!Array.isArray(observations)) {
    errors.push("observations invalid");
  } else if (sourceDurationValid) {
    observations.forEach((observation, index) => {
      if (!isRecord(observation)) {
        errors.push(`observations[${index}] invalid`);
        return;
      }
      validateArtifactTrackedText(observation.label, `observations[${index}].label`, 256, errors);
      validateArtifactTrackedText(observation.rationale, `observations[${index}].rationale`, 2_000, errors);
      const providerRangeUs = validateArtifactRange(
        observation.provider_range_us,
        `observations[${index}].provider_range_us`,
        sourceDurationUs,
        errors,
      );
      if (providerRangeUs && effectiveRangeUs &&
          (providerRangeUs[0] < effectiveRangeUs[0] || providerRangeUs[1] > effectiveRangeUs[1])) {
        errors.push(`observations[${index}].provider_range_us outside effective range`);
      }
    });
  }

  const localVerification = value.local_verification;
  if (!isRecord(localVerification) || localVerification.status !== "not_run") {
    errors.push("local_verification.status must be not_run");
  }
  if (!isRecord(localVerification) || !Array.isArray(localVerification.records)) {
    errors.push("local_verification.records invalid");
  } else if (localVerification.records.length !== 0) {
    errors.push("local_verification.records must be empty");
  }

  return { valid: errors.length === 0, errors };
}

export function assertVideoReasoningEvidenceIntegrity(
  value: unknown,
): asserts value is VideoReasoningEvidenceArtifact {
  const validation = validateVideoReasoningEvidenceIntegrity(value);
  if (!validation.valid) reject(`artifact integrity: ${validation.errors.join(",")}`);
}

function readBoundedText(value: unknown, field: string, maxBytes: number): string {
  if (typeof value !== "string" ||
      value.trim().length === 0 ||
      Buffer.byteLength(value, "utf8") > maxBytes ||
      CONTROL_CHARACTER_PATTERN.test(value)) {
    return reject(`invalid ${field}`);
  }
  return value.trim();
}

function readSafeIdentifier(value: unknown, field: string, request: VideoReasoningRequest): string {
  const text = readProviderText(value, field, 256, request);
  if (!SAFE_IDENTIFIER_PATTERN.test(text)) return reject(`invalid ${field}`);
  return text;
}

function readProviderIdentity(value: unknown, field: string, request: VideoReasoningRequest): string {
  const text = readProviderText(value, field, 64, request);
  if (!PROVIDER_PATTERN.test(text)) return reject(`invalid ${field}`);
  return text;
}

function readHash(value: unknown, field: string): string {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) return reject(`invalid ${field}`);
  return value.toLowerCase();
}

function readRange(value: unknown, field: string, durationUs: number): [number, number] {
  if (!Array.isArray(value) || value.length !== 2 ||
      !isSafeNonNegativeInteger(value[0]) || !isSafeNonNegativeInteger(value[1]) ||
      value[0] >= value[1] || value[1] > durationUs) {
    return reject(`invalid ${field}`);
  }
  return [value[0], value[1]];
}

function readProviderRange(
  value: unknown,
  field: string,
  sourceDurationUs: number,
  effectiveRangeUs: readonly [number, number],
): [number, number] {
  const range = readRange(value, field, sourceDurationUs);
  if (range[0] < effectiveRangeUs[0] || range[1] > effectiveRangeUs[1]) {
    return reject(`${field} is outside effective source range`);
  }
  return range;
}

function assertEqual<T>(actual: T, expected: T, field: string): void {
  if (actual !== expected) reject(`${field} identity mismatch`);
}

function assertEqualRange(
  actual: readonly [number, number],
  expected: readonly [number, number],
  field: string,
): void {
  if (actual[0] !== expected[0] || actual[1] !== expected[1]) {
    reject(`${field} identity mismatch`);
  }
}

function assertSecretFreeProviderText(
  value: string,
  field: string,
  request: VideoReasoningRequest,
): void {
  const restrictedValues = [
    request.prompt,
    request.input.kind === "inline" ? request.input.path : request.input.uri,
  ];
  if (restrictedValues.some((restricted) => restricted.length >= 8 && value.includes(restricted))) {
    reject(`${field} contains restricted input`);
  }
  if (hasGenericTrackedUnsafeText(value)) {
    reject(`${field} contains a path or URI`);
  }
}

function readProviderText(
  value: unknown,
  field: string,
  maxBytes: number,
  request: VideoReasoningRequest,
): string {
  const text = readBoundedText(value, field, maxBytes);
  assertSecretFreeProviderText(text, field, request);
  return text;
}

function readCount(value: unknown, field: string): number {
  if (!isSafeNonNegativeInteger(value) || value > MAX_PROCESSING_STEPS) {
    return reject(`invalid ${field}`);
  }
  return value;
}

function readConfidence(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    return reject(`invalid ${field}`);
  }
  return value;
}

function normalizeUsage(value: unknown): VideoReasoningEvidenceUsage | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) return reject("invalid diagnostic.usage");
  const allowed = new Set([
    "promptTokens",
    "completionTokens",
    "totalTokens",
    "totalThoughtTokens",
    "totalToolUseTokens",
  ]);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    return reject("diagnostic.usage contains an unknown field");
  }
  const mapping: Array<[keyof VideoReasoningUsage, keyof VideoReasoningEvidenceUsage]> = [
    ["promptTokens", "prompt_tokens"],
    ["completionTokens", "completion_tokens"],
    ["totalTokens", "total_tokens"],
    ["totalThoughtTokens", "total_thought_tokens"],
    ["totalToolUseTokens", "total_tool_use_tokens"],
  ];
  const normalized: VideoReasoningEvidenceUsage = {};
  for (const [inputKey, outputKey] of mapping) {
    if (value[inputKey] === undefined) continue;
    if (!isSafeNonNegativeInteger(value[inputKey]) || value[inputKey] > MAX_USAGE_VALUE) {
      return reject(`invalid diagnostic.usage.${inputKey}`);
    }
    normalized[outputKey] = value[inputKey];
  }
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function normalizeElapsedMs(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (!isSafeNonNegativeInteger(value) || value > MAX_USAGE_VALUE) {
    return reject("invalid diagnostic.elapsedMs");
  }
  return value;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return reject("non-finite normalized value");
    return Object.is(value, -0) ? "0" : String(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return reject("unsupported normalized value");
}

function stableId(prefix: string, value: unknown): string {
  return `${prefix}${createHash("sha256").update(canonicalJson(value), "utf8").digest("hex")}`;
}

function normalizedOutcome(
  resultOutcome: VideoReasoningOutcome,
  processingObserved: VideoReasoningEvidenceProcessingObserved,
  errorCode: VideoReasoningErrorCode,
): VideoReasoningEvidenceOutcome {
  if (resultOutcome === "unknown") return "unknown";
  if (resultOutcome !== "completed") return "failed";
  return processingObserved === "agentic" && errorCode === "none" ? "completed" : "degraded";
}

/**
 * Normalize an already-produced M1 result without performing any I/O.
 * Provider timestamps are already original-source-relative in the M1 result;
 * this function validates them and never offsets, rounds, clamps, drops, or
 * converts them into canonical edit/timeline ranges.
 */
export function normalizeVideoReasoningEvidence(
  request: VideoReasoningRequest,
  result: VideoReasoningResult,
): VideoReasoningEvidenceArtifact {
  const requestValidation = validateVideoReasoningRequest(request);
  if (!requestValidation.ok) {
    reject(`request validation failed: ${requestValidation.errors.join(",")}`);
  }

  const rawResult: unknown = result;
  if (!isRecord(rawResult)) reject("result");
  const rawDiagnostic: unknown = rawResult.diagnostic;
  if (!isRecord(rawDiagnostic)) reject("result.diagnostic");

  const resultOutcome = rawResult.outcome;
  if (typeof resultOutcome !== "string" || !RESULT_OUTCOMES.has(resultOutcome as VideoReasoningOutcome)) {
    reject("invalid result.outcome");
  }
  const diagnosticOutcome = rawDiagnostic.outcome;
  if (typeof diagnosticOutcome !== "string" || !RESULT_OUTCOMES.has(diagnosticOutcome as VideoReasoningOutcome)) {
    reject("invalid diagnostic.outcome");
  }
  assertEqual(diagnosticOutcome, resultOutcome, "outcome");

  const sourceDurationUs = request.source.sourceDurationUs;
  const effectiveRangeUs = [
    requestValidation.sourceRangeUs[0],
    requestValidation.sourceRangeUs[1],
  ] as [number, number];
  const diagnosticRangeUs = readRange(rawDiagnostic.sourceRangeUs, "diagnostic.sourceRangeUs", sourceDurationUs);
  assertEqualRange(diagnosticRangeUs, effectiveRangeUs, "source range");

  const sourceContentSha256 = readHash(request.source.sourceContentSha256, "request.source.sourceContentSha256");
  const submittedMediaContentSha256 = readHash(
    request.source.submittedMediaContentSha256 ?? sourceContentSha256,
    "request.source.submittedMediaContentSha256",
  );
  assertEqual(readHash(rawDiagnostic.sourceContentSha256, "diagnostic.sourceContentSha256"), sourceContentSha256, "source content");
  assertEqual(
    readHash(rawDiagnostic.submittedMediaContentSha256, "diagnostic.submittedMediaContentSha256"),
    submittedMediaContentSha256,
    "submitted media content",
  );
  assertEqual(rawDiagnostic.sourceAssetId, request.source.assetId, "asset");
  if (typeof rawDiagnostic.sourceAssetId !== "string" || !ASSET_ID_PATTERN.test(rawDiagnostic.sourceAssetId)) {
    reject("invalid diagnostic.sourceAssetId");
  }
  if (Object.hasOwn(rawDiagnostic, "sourceDurationUs") && rawDiagnostic.sourceDurationUs !== undefined) {
    if (!isSafePositiveInteger(rawDiagnostic.sourceDurationUs) || rawDiagnostic.sourceDurationUs !== sourceDurationUs) {
      reject("source duration identity mismatch");
    }
  }

  const requestHash = readHash(rawDiagnostic.requestHash, "diagnostic.requestHash");
  const expectedRequestHash = computeVideoReasoningRequestHash(request, effectiveRangeUs);
  assertEqual(requestHash, expectedRequestHash, "request hash");
  const promptHash = readHash(rawDiagnostic.promptHash, "diagnostic.promptHash");
  assertEqual(promptHash, computePromptHash(request.prompt), "prompt hash");

  const provider = readProviderIdentity(rawDiagnostic.provider, "diagnostic.provider", request);
  const model = readProviderText(request.model.trim(), "request.model", 256, request);
  assertEqual(readProviderText(rawDiagnostic.model, "diagnostic.model", 256, request), model, "model");
  const effectiveModel = rawDiagnostic.effectiveModel === undefined
    ? undefined
    : readProviderText(rawDiagnostic.effectiveModel, "diagnostic.effectiveModel", 256, request);
  if (typeof rawDiagnostic.task !== "string" || !TASKS.has(rawDiagnostic.task as VideoReasoningRequest["task"])) {
    reject("invalid diagnostic.task");
  }
  assertEqual(rawDiagnostic.task, request.task, "task");
  assertEqual(rawDiagnostic.contractVersion, VIDEO_REASONING_CONTRACT_VERSION, "contract version");
  assertEqual(rawDiagnostic.responseSchemaVersion, VIDEO_REASONING_RESPONSE_SCHEMA_VERSION, "response schema version");
  assertEqual(rawDiagnostic.processingRequested, "agentic", "processing requested");
  if (rawDiagnostic.storeRequested !== false) reject("store requested is not false");
  if (rawDiagnostic.inputKind !== request.input.kind) reject("input kind identity mismatch");
  const diagnosticMimeType = readBoundedText(rawDiagnostic.mimeType, "diagnostic.mimeType", 128).toLowerCase();
  assertEqual(diagnosticMimeType, request.input.mimeType.toLowerCase(), "MIME type");
  if (!/^video\/[a-z0-9.+-]+$/i.test(diagnosticMimeType)) reject("invalid diagnostic.mimeType");

  if (typeof rawDiagnostic.connectorVersion !== "string") reject("invalid diagnostic.connectorVersion");
  const connectorVersion = readSafeIdentifier(rawDiagnostic.connectorVersion, "diagnostic.connectorVersion", request);
  if (typeof rawDiagnostic.submitted !== "boolean") reject("invalid diagnostic.submitted");
  if (typeof rawDiagnostic.agenticUsed !== "boolean") reject("invalid diagnostic.agenticUsed");
  const processingCallCount = readCount(rawDiagnostic.processingCallCount, "diagnostic.processingCallCount");
  const processingResultCount = readCount(rawDiagnostic.processingResultCount, "diagnostic.processingResultCount");
  const matchedProcessingPairCount = readCount(rawDiagnostic.matchedProcessingPairCount, "diagnostic.matchedProcessingPairCount");
  if (matchedProcessingPairCount > processingCallCount || matchedProcessingPairCount > processingResultCount) {
    reject("processing pair count exceeds processing counts");
  }
  const processingObserved: VideoReasoningEvidenceProcessingObserved =
    rawDiagnostic.agenticUsed && processingCallCount > 0 && processingResultCount > 0 && matchedProcessingPairCount > 0
      ? "agentic"
      : "unverified";
  const confidenceBasis: VideoReasoningEvidenceConfidenceBasis = processingObserved === "agentic" ? "degraded" : "unmeasured";

  const errorCode = rawDiagnostic.errorCode;
  if (typeof errorCode !== "string" || !ERROR_CODES.has(errorCode as VideoReasoningErrorCode)) {
    reject("invalid diagnostic.errorCode");
  }
  if (!isM1OutcomeErrorCompatible(
    resultOutcome as VideoReasoningOutcome,
    errorCode as VideoReasoningErrorCode,
  )) {
    reject("outcome/error classification mismatch");
  }
  if (!Array.isArray(rawResult.observations)) reject("invalid result.observations");
  if (rawDiagnostic.submitted === false &&
      (rawDiagnostic.agenticUsed || processingCallCount > 0 || processingResultCount > 0 || matchedProcessingPairCount > 0)) {
    reject("unsubmitted result contains processing evidence");
  }
  if (rawDiagnostic.agenticUsed !== (matchedProcessingPairCount > 0)) {
    reject("agentic usage contradicts processing pair count");
  }
  if (resultOutcome === "completed" && rawDiagnostic.submitted === false) {
    reject("completed result was not submitted");
  }
  if (resultOutcome === "completed" && errorCode !== "none") {
    reject("completed result has an error classification");
  }
  if (resultOutcome !== "completed" && rawResult.observations.length > 0) {
    reject("non-completed result contains observations");
  }
  if (resultOutcome === "rejected" &&
      (rawDiagnostic.submitted || rawDiagnostic.agenticUsed || processingCallCount > 0 ||
       processingResultCount > 0 || matchedProcessingPairCount > 0)) {
    reject("rejected result contains submitted processing state");
  }
  const outcome = normalizedOutcome(
    resultOutcome as VideoReasoningOutcome,
    processingObserved,
    errorCode as VideoReasoningErrorCode,
  );
  const executionIntegrity = validateVideoReasoningExecutionIntegrity({
    providerOutcome: resultOutcome,
    errorCode,
    submitted: rawDiagnostic.submitted,
    processingCallCount,
    processingResultCount,
    matchedProcessingPairCount,
    processingObserved,
    derivedOutcome: outcome,
  });
  if (!executionIntegrity.valid) {
    reject(`execution integrity: ${executionIntegrity.errors.join(",")}`);
  }
  const providerRequestId = rawDiagnostic.providerRequestId === undefined
    ? undefined
    : (() => {
        const requestId = readProviderText(
          rawDiagnostic.providerRequestId,
          "diagnostic.providerRequestId",
          256,
          request,
        );
        if (!PROVIDER_REQUEST_ID_PATTERN.test(requestId)) {
          return reject("invalid diagnostic.providerRequestId");
        }
        return requestId;
      })();
  const usage = normalizeUsage(rawDiagnostic.usage);
  const elapsedMs = normalizeElapsedMs(rawDiagnostic.elapsedMs);

  if (rawResult.observations.length > MAX_OBSERVATIONS) {
    reject("invalid result.observations");
  }
  const observations: VideoReasoningEvidenceObservation[] = rawResult.observations.map((rawObservation, index) => {
    if (!isRecord(rawObservation)) reject(`invalid observation #${index + 1}`);
    const providerRangeUs = readProviderRange(
      [rawObservation.startUs, rawObservation.endUs],
      `observation #${index + 1} range`,
      sourceDurationUs,
      effectiveRangeUs,
    );
    const label = readProviderText(rawObservation.label, `observation #${index + 1} label`, 256, request);
    const rationale = readProviderText(rawObservation.rationale, `observation #${index + 1} rationale`, 2_000, request);
    const providerConfidence = readConfidence(rawObservation.confidence, `observation #${index + 1} confidence`);
    if (rawObservation.localVerification !== "not_run") {
      reject(`observation #${index + 1} local verification is not not_run`);
    }
    const confidence = Math.min(DEGRADED_CONFIDENCE_CEILING, providerConfidence);
    const observationIdentity = {
      artifact_version: VIDEO_REASONING_EVIDENCE_ARTIFACT_VERSION,
      provider,
      source: {
        asset_id: request.source.assetId,
        source_content_sha256: sourceContentSha256,
        submitted_media_content_sha256: submittedMediaContentSha256,
        source_duration_us: sourceDurationUs,
        effective_source_range_us: effectiveRangeUs,
      },
      request_hash: requestHash,
      prompt_hash: promptHash,
      model,
      task: request.task,
      index,
      provider_range_us: providerRangeUs,
      label,
      rationale,
      confidence,
      confidence_basis: confidenceBasis,
    };
    return {
      observation_id: stableId("VREO_", observationIdentity),
      label,
      rationale,
      observation: null,
      inference: null,
      editorial_intent: null,
      provider_range_us: providerRangeUs,
      confidence,
      confidence_basis: confidenceBasis,
    };
  });

  const body: Omit<VideoReasoningEvidenceArtifact, "artifact_id"> = {
    artifact_version: VIDEO_REASONING_EVIDENCE_ARTIFACT_VERSION,
    artifact_kind: "derived_evidence",
    authority: "derived_evidence_only",
    provider,
    connector_version: connectorVersion,
    ...(effectiveModel === undefined ? {} : { effective_model: effectiveModel }),
    request_hash: requestHash,
    prompt_hash: promptHash,
    model,
    task: request.task,
    contract_version: VIDEO_REASONING_CONTRACT_VERSION,
    response_schema_version: VIDEO_REASONING_RESPONSE_SCHEMA_VERSION,
    processing_requested: "agentic",
    processing_observed: processingObserved,
    evidence_basis: "provider_only",
    ...(providerRequestId === undefined ? {} : { provider_request_id: providerRequestId }),
    source: {
      asset_id: request.source.assetId,
      source_content_sha256: sourceContentSha256,
      submitted_media_content_sha256: submittedMediaContentSha256,
      source_duration_us: sourceDurationUs,
      effective_source_range_us: effectiveRangeUs,
    },
    observations,
    local_verification: {
      status: "not_run",
      records: [],
    },
    confidence_basis: confidenceBasis,
    outcome,
    ...(usage === undefined ? {} : { usage }),
    execution: {
      provider_outcome: resultOutcome as VideoReasoningOutcome,
      ...(errorCode === "none" ? {} : { error_classification: errorCode as Exclude<VideoReasoningErrorCode, "none"> }),
      submitted: rawDiagnostic.submitted,
      processing_call_count: processingCallCount,
      processing_result_count: processingResultCount,
      matched_processing_pair_count: matchedProcessingPairCount,
      ...(elapsedMs === undefined ? {} : { elapsed_ms: elapsedMs }),
    },
  };

  const artifact: VideoReasoningEvidenceArtifact = {
    artifact_id: stableId("VREA_", body),
    ...body,
  };
  assertVideoReasoningEvidenceIntegrity(artifact);
  return artifact;
}

export const normalizeVideoReasoningEvidenceArtifact = normalizeVideoReasoningEvidence;
export const buildVideoReasoningEvidenceArtifact = normalizeVideoReasoningEvidence;
