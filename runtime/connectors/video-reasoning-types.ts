import { createHash } from "node:crypto";

export const VIDEO_REASONING_CONTRACT_VERSION = "video-reasoning/v1";
export const VIDEO_REASONING_RESPONSE_SCHEMA_VERSION = "video-reasoning-response/v1";
export const VIDEO_REASONING_PROMPT_MAX_BYTES = 64 * 1024;

export type VideoReasoningTask =
  | "needle_search"
  | "moment_refine"
  | "trim_refine"
  | "continuity_check"
  | "roughcut_review"
  | "anomaly_inspection";

export type VideoReasoningPrivacy =
  | "local_only"
  | "bounded_derivative"
  | "source_allowed";

export interface VideoReasoningCloudConsent {
  approved: true;
  scope: Exclude<VideoReasoningPrivacy, "local_only">;
}

export interface VideoReasoningSourceBinding {
  assetId: string;
  /** SHA-256 of the original source bytes. */
  sourceContentSha256: string;
  /** Duration of the original source in microseconds. */
  sourceDurationUs: number;
  /** SHA-256 of submitted derivative bytes when they differ from the source. */
  submittedMediaContentSha256?: string;
  /**
   * Submitted media range within the original source. Provider timestamps are
   * relative to the submitted media and are offset into this source range.
   */
  rangeUs?: readonly [number, number];
}

export interface InlineVideoReasoningInput {
  kind: "inline";
  path: string;
  mimeType: string;
}

export interface ProviderUriVideoReasoningInput {
  kind: "provider_uri";
  /** Existing Gemini Files API or registered Cloud Storage URI. */
  uri: string;
  mimeType: string;
}

export type VideoReasoningInput =
  | InlineVideoReasoningInput
  | ProviderUriVideoReasoningInput;

export interface VideoReasoningBudget {
  /** A single M1 probe requires at least one request. */
  maxRequests?: number;
  /** Upper bound for raw inline bytes read and sent by the connector. */
  maxInputBytes?: number;
  /** Upper bound for submitted video duration in microseconds. */
  maxUploadedDurationUs?: number;
  /** Whole connector deadline, including response-body read. */
  timeoutMs?: number;
  /** Reserved for the M2 router and recorded in the request contract. */
  maxInputTokens?: number;
  /** Reserved for the M2 router and recorded in the request contract. */
  maxEstimatedUsd?: number;
}

export interface VideoReasoningRequest {
  task: VideoReasoningTask;
  model: string;
  prompt: string;
  source: VideoReasoningSourceBinding;
  input: VideoReasoningInput;
  privacy: VideoReasoningPrivacy;
  consent?: VideoReasoningCloudConsent;
  budget?: VideoReasoningBudget;
}

export type VideoReasoningOutcome =
  | "completed"
  | "rejected"
  | "failed"
  | "unknown";

export type VideoReasoningErrorCode =
  | "none"
  | "invalid_request"
  | "local_only"
  | "cloud_consent_required"
  | "cloud_consent_scope_mismatch"
  | "unsupported_model"
  | "provider_uri_not_allowed"
  | "request_budget_exceeded"
  | "duration_budget_exceeded"
  | "input_read_failed"
  | "input_too_large"
  | "request_too_large"
  | "input_content_hash_mismatch"
  | "api_key_missing"
  | "transport_timeout_unknown"
  | "transport_error_unknown"
  | "provider_http_error"
  | "provider_response_invalid"
  | "provider_response_too_large"
  | "interaction_incomplete"
  | "agentic_steps_missing"
  | "structured_output_invalid"
  | "pre_submit_error";

export interface VideoReasoningObservation {
  /** Original-source-relative normalized timestamp. */
  startUs: number;
  /** Original-source-relative normalized timestamp. */
  endUs: number;
  label: string;
  rationale: string;
  confidence: number;
  /** M1 never promotes provider timestamps directly into canonical edits. */
  localVerification: "not_run";
}

export interface VideoReasoningUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  totalThoughtTokens?: number;
  totalToolUseTokens?: number;
}

export interface VideoReasoningDiagnostic {
  /** Provider identity supplied by the connector, not inferred by consumers. */
  provider: string;
  connectorVersion: string;
  contractVersion: typeof VIDEO_REASONING_CONTRACT_VERSION;
  responseSchemaVersion: typeof VIDEO_REASONING_RESPONSE_SCHEMA_VERSION;
  requestHash: string;
  promptHash: string;
  sourceAssetId: string;
  sourceContentSha256: string;
  submittedMediaContentSha256: string;
  sourceRangeUs: readonly [number, number];
  inputKind: VideoReasoningInput["kind"] | "invalid";
  mimeType: string;
  model: string;
  effectiveModel?: string;
  task: VideoReasoningTask | "invalid";
  processingRequested: "agentic";
  storeRequested: false;
  agenticUsed: boolean;
  processingCallCount: number;
  processingResultCount: number;
  matchedProcessingPairCount: number;
  submitted: boolean;
  outcome: VideoReasoningOutcome;
  errorCode: VideoReasoningErrorCode;
  elapsedMs: number;
  inputBytes?: number;
  requestBytes?: number;
  responseBytes?: number;
  httpStatus?: number;
  providerRequestId?: string;
  usage?: VideoReasoningUsage;
}

export interface VideoReasoningResult {
  outcome: VideoReasoningOutcome;
  summary?: string;
  observations: VideoReasoningObservation[];
  diagnostic: VideoReasoningDiagnostic;
}

export interface VideoReasoningConnectorContext {
  onBeforeSubmit?: () => void | Promise<void>;
}

export type VideoReasoningConnector = (
  request: VideoReasoningRequest,
  context?: VideoReasoningConnectorContext,
) => Promise<VideoReasoningResult>;

export interface VideoReasoningRequestValidation {
  ok: boolean;
  sourceRangeUs: readonly [number, number];
  submittedDurationUs: number;
  errors: string[];
}

const SHA256_PATTERN = /^[0-9a-f]{64}$/i;
const ASSET_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const TASKS = new Set<VideoReasoningTask>([
  "needle_search",
  "moment_refine",
  "trim_refine",
  "continuity_check",
  "roughcut_review",
  "anomaly_inspection",
]);
const PRIVACY_VALUES = new Set<VideoReasoningPrivacy>([
  "local_only",
  "bounded_derivative",
  "source_allowed",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPositiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function boundedString(value: unknown, maxBytes: number): value is string {
  return typeof value === "string" &&
    value.trim().length > 0 &&
    Buffer.byteLength(value, "utf8") <= maxBytes;
}

export function validateVideoReasoningRequest(
  request: VideoReasoningRequest,
): VideoReasoningRequestValidation {
  const errors: string[] = [];
  const raw: unknown = request;
  if (!isRecord(raw)) {
    return {
      ok: false,
      sourceRangeUs: [0, 1],
      submittedDurationUs: 1,
      errors: ["request"],
    };
  }

  if (!TASKS.has(raw.task as VideoReasoningTask)) errors.push("task");
  if (!boundedString(raw.model, 256)) errors.push("model");
  if (!boundedString(raw.prompt, VIDEO_REASONING_PROMPT_MAX_BYTES)) errors.push("prompt");
  if (!PRIVACY_VALUES.has(raw.privacy as VideoReasoningPrivacy)) errors.push("privacy");

  const source = isRecord(raw.source) ? raw.source : null;
  if (!source || typeof source.assetId !== "string" || !ASSET_ID_PATTERN.test(source.assetId)) {
    errors.push("source.assetId");
  }
  if (!source || typeof source.sourceContentSha256 !== "string" ||
      !SHA256_PATTERN.test(source.sourceContentSha256)) {
    errors.push("source.sourceContentSha256");
  }
  if (!source || !isPositiveSafeInteger(source.sourceDurationUs)) {
    errors.push("source.sourceDurationUs");
  }
  if (source?.submittedMediaContentSha256 !== undefined &&
      (typeof source.submittedMediaContentSha256 !== "string" ||
       !SHA256_PATTERN.test(source.submittedMediaContentSha256))) {
    errors.push("source.submittedMediaContentSha256");
  }

  const durationUs = isPositiveSafeInteger(source?.sourceDurationUs)
    ? source.sourceDurationUs
    : 1;
  let sourceRangeUs: readonly [number, number] = [0, durationUs];
  let nonFullRange = false;
  if (source?.rangeUs !== undefined) {
    const range = source.rangeUs;
    if (!Array.isArray(range) || range.length !== 2 ||
        !isNonNegativeSafeInteger(range[0]) || !isNonNegativeSafeInteger(range[1]) ||
        range[0] >= range[1] || range[1] > durationUs) {
      errors.push("source.rangeUs");
    } else {
      sourceRangeUs = [range[0], range[1]];
      nonFullRange = range[0] !== 0 || range[1] !== durationUs;
    }
  }
  const originalHash = typeof source?.sourceContentSha256 === "string"
    ? source.sourceContentSha256.toLowerCase()
    : "";
  const submittedHash = typeof source?.submittedMediaContentSha256 === "string"
    ? source.submittedMediaContentSha256.toLowerCase()
    : "";
  if (nonFullRange && (!submittedHash || submittedHash === originalHash)) {
    errors.push("source.rangeUsRequiresDistinctDerivative");
  }
  if (raw.privacy === "bounded_derivative" &&
      (!submittedHash || submittedHash === originalHash)) {
    errors.push("source.boundedDerivativeRequiresDistinctIdentity");
  }

  const input = isRecord(raw.input) ? raw.input : null;
  if (!input || (input.kind !== "inline" && input.kind !== "provider_uri")) {
    errors.push("input.kind");
  } else {
    if (!boundedString(input.mimeType, 128) ||
        !/^video\/[a-z0-9.+-]+$/i.test(input.mimeType)) {
      errors.push("input.mimeType");
    }
    if (input.kind === "inline") {
      if (!boundedString(input.path, 4096)) errors.push("input.path");
    } else if (!boundedString(input.uri, 4096)) {
      errors.push("input.uri");
    }
  }

  const budget = raw.budget === undefined
    ? undefined
    : isRecord(raw.budget) ? raw.budget : null;
  if (budget === null) errors.push("budget");
  if (budget && budget.maxRequests !== undefined &&
      !isNonNegativeSafeInteger(budget.maxRequests)) {
    errors.push("budget.maxRequests");
  }
  if (budget && budget.maxInputBytes !== undefined &&
      !isNonNegativeSafeInteger(budget.maxInputBytes)) {
    errors.push("budget.maxInputBytes");
  }
  if (budget && budget.maxUploadedDurationUs !== undefined &&
      !isNonNegativeSafeInteger(budget.maxUploadedDurationUs)) {
    errors.push("budget.maxUploadedDurationUs");
  }
  if (budget && budget.timeoutMs !== undefined && !isPositiveSafeInteger(budget.timeoutMs)) {
    errors.push("budget.timeoutMs");
  }
  if (budget && budget.maxInputTokens !== undefined &&
      !isNonNegativeSafeInteger(budget.maxInputTokens)) {
    errors.push("budget.maxInputTokens");
  }
  if (budget && budget.maxEstimatedUsd !== undefined &&
      (typeof budget.maxEstimatedUsd !== "number" ||
       !Number.isFinite(budget.maxEstimatedUsd) || budget.maxEstimatedUsd < 0)) {
    errors.push("budget.maxEstimatedUsd");
  }

  return {
    ok: errors.length === 0,
    sourceRangeUs,
    submittedDurationUs: Math.max(1, sourceRangeUs[1] - sourceRangeUs[0]),
    errors,
  };
}

function safeString(value: unknown, fallback: string): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function safeHash(value: unknown): string {
  return typeof value === "string" && SHA256_PATTERN.test(value)
    ? value.toLowerCase()
    : "0".repeat(64);
}

export function computePromptHash(prompt: string): string {
  return createHash("sha256")
    .update(typeof prompt === "string" ? prompt : "", "utf8")
    .digest("hex");
}

/**
 * Privacy-safe request identity. Local paths, provider URIs, consent metadata,
 * raw prompt text, and budget values are deliberately excluded.
 */
export function computeVideoReasoningRequestHash(
  request: VideoReasoningRequest,
  sourceRangeUs: readonly [number, number],
): string {
  const raw = isRecord(request as unknown) ? request as unknown as Record<string, unknown> : {};
  const source = isRecord(raw.source) ? raw.source : {};
  const input = isRecord(raw.input) ? raw.input : {};
  const sourceHash = safeHash(source.sourceContentSha256);
  const payload = {
    contractVersion: VIDEO_REASONING_CONTRACT_VERSION,
    responseSchemaVersion: VIDEO_REASONING_RESPONSE_SCHEMA_VERSION,
    task: safeString(raw.task, "invalid"),
    model: safeString(raw.model, "invalid").trim(),
    promptHash: computePromptHash(safeString(raw.prompt, "")),
    sourceAssetId: safeString(source.assetId, "invalid"),
    sourceContentSha256: sourceHash,
    submittedMediaContentSha256: source.submittedMediaContentSha256 === undefined
      ? sourceHash
      : safeHash(source.submittedMediaContentSha256),
    sourceDurationUs: isPositiveSafeInteger(source.sourceDurationUs)
      ? source.sourceDurationUs
      : 0,
    sourceRangeUs,
    inputKind: safeString(input.kind, "invalid"),
    mimeType: safeString(input.mimeType, "invalid").toLowerCase(),
    processing: "agentic",
    privacy: safeString(raw.privacy, "invalid"),
    store: false,
  };
  return createHash("sha256").update(JSON.stringify(payload), "utf8").digest("hex");
}
