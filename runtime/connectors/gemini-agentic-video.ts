/**
 * Gemini Agentic Video connector.
 *
 * This is an optional, read-only whole-video reasoning capability. It does not
 * upload files automatically, mutate canonical project artifacts, retain an
 * Interaction server-side, or retry an ambiguous paid request. The existing
 * frame-bundle VlmFn remains unchanged.
 */
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  VIDEO_REASONING_CONTRACT_VERSION,
  VIDEO_REASONING_RESPONSE_SCHEMA_VERSION,
  computePromptHash,
  computeVideoReasoningRequestHash,
  validateVideoReasoningRequest,
  type VideoReasoningConnector,
  type VideoReasoningConnectorContext,
  type VideoReasoningDiagnostic,
  type VideoReasoningErrorCode,
  type VideoReasoningObservation,
  type VideoReasoningOutcome,
  type VideoReasoningRequest,
  type VideoReasoningResult,
  type VideoReasoningUsage,
} from "./video-reasoning-types.js";

export const GEMINI_AGENTIC_VIDEO_CONNECTOR_VERSION = "gemini-agentic-video-v1.1";
export const GEMINI_INTERACTIONS_ENDPOINT =
  "https://generativelanguage.googleapis.com/v1beta/interactions";
export const GEMINI_INTERACTIONS_API_REVISION = "2026-05-20";
export const DEFAULT_AGENTIC_VIDEO_TIMEOUT_MS = 120_000;
/**
 * Inline requests must remain below 20 MiB in total. Base64 expands source
 * bytes by about 4/3, so the raw-video default is intentionally conservative.
 */
export const DEFAULT_MAX_INLINE_VIDEO_BYTES = 14 * 1024 * 1024;
export const DEFAULT_MAX_INTERACTIONS_REQUEST_BYTES = 20 * 1024 * 1024;
export const DEFAULT_MAX_INTERACTIONS_RESPONSE_BYTES = 2 * 1024 * 1024;

export const GEMINI_AGENTIC_VIDEO_MODELS = [
  "gemini-3.7-flash",
  "gemini-3.6-flash",
  "gemini-3.5-flash-lite",
] as const;

const GEMINI_AGENTIC_VIDEO_MODEL_SET = new Set<string>(GEMINI_AGENTIC_VIDEO_MODELS);

/**
 * Provider-facing schema uses only the currently documented Interactions JSON
 * Schema subset. String byte/emptiness limits are enforced again locally.
 */
export const VIDEO_REASONING_RESPONSE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    timestamp_basis: {
      type: "string",
      enum: ["submitted_media"],
      description: "All observation timestamps are seconds from the beginning of the submitted video input.",
    },
    summary: {
      type: "string",
      description: "Concise answer to the requested editorial video question.",
    },
    observations: {
      type: "array",
      maxItems: 32,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          start_seconds: { type: "number", minimum: 0 },
          end_seconds: { type: "number", minimum: 0 },
          label: { type: "string" },
          rationale: { type: "string" },
          confidence: { type: "number", minimum: 0, maximum: 1 },
        },
        required: ["start_seconds", "end_seconds", "label", "rationale", "confidence"],
      },
    },
  },
  required: ["timestamp_basis", "summary", "observations"],
} as const;

export interface GeminiInteractionsHttpRequest {
  url: string;
  headers: Readonly<Record<string, string>>;
  body: string;
  signal: AbortSignal;
}

export interface GeminiInteractionsHttpResponse {
  status: number;
  body: string;
}

export type GeminiInteractionsTransport = (
  request: GeminiInteractionsHttpRequest,
) => Promise<GeminiInteractionsHttpResponse>;

export interface GeminiAgenticVideoConnectorOptions {
  apiKey?: string;
  transport?: GeminiInteractionsTransport;
  now?: () => number;
  maxInlineBytes?: number;
  maxRequestBytes?: number;
  maxResponseBytes?: number;
}

interface RawInteractionStep {
  type?: unknown;
  id?: unknown;
  call_id?: unknown;
  content?: unknown;
}

interface RawInteractionResponse {
  id?: unknown;
  object?: unknown;
  model?: unknown;
  status?: unknown;
  output_text?: unknown;
  steps?: unknown;
  usage?: unknown;
}

interface RawStructuredObservation {
  start_seconds: number;
  end_seconds: number;
  label: string;
  rationale: string;
  confidence: number;
}

interface RawStructuredOutput {
  timestamp_basis: "submitted_media";
  summary: string;
  observations: RawStructuredObservation[];
}

class GeminiAgenticVideoTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`Gemini Agentic Video request exceeded ${timeoutMs}ms`);
    this.name = "GeminiAgenticVideoTimeoutError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeNonNegativeInteger(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && (value as number) >= 0
    ? value as number
    : undefined;
}

function safeProviderRequestId(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > 256) return undefined;
  return /^[A-Za-z0-9._:-]+$/.test(value) ? value : undefined;
}

function safeEffectiveModel(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > 256) return undefined;
  return /^[A-Za-z0-9._:/@+-]+$/.test(value) ? value : undefined;
}

function safeElapsedMs(startedAt: number, now: () => number): number {
  const elapsed = now() - startedAt;
  return Number.isFinite(elapsed) && elapsed >= 0 ? Math.round(elapsed) : 0;
}

function normalizePositiveLimit(value: unknown, fallback: number): number {
  return Number.isSafeInteger(value) && (value as number) > 0
    ? value as number
    : fallback;
}

function normalizeTimeoutMs(request: VideoReasoningRequest): number {
  return normalizePositiveLimit(request.budget?.timeoutMs, DEFAULT_AGENTIC_VIDEO_TIMEOUT_MS);
}

function safeTask(request: VideoReasoningRequest): VideoReasoningDiagnostic["task"] {
  const value = (request as unknown as { task?: unknown })?.task;
  return typeof value === "string" &&
    [
      "needle_search",
      "moment_refine",
      "trim_refine",
      "continuity_check",
      "roughcut_review",
      "anomaly_inspection",
    ].includes(value)
    ? value as VideoReasoningDiagnostic["task"]
    : "invalid";
}

function createBaseDiagnostic(
  request: VideoReasoningRequest,
  sourceRangeUs: readonly [number, number],
  startedAt: number,
  now: () => number,
): VideoReasoningDiagnostic {
  const raw = isRecord(request as unknown) ? request as unknown as Record<string, unknown> : {};
  const source = isRecord(raw.source) ? raw.source : {};
  const input = isRecord(raw.input) ? raw.input : {};
  const sourceHash = typeof source.sourceContentSha256 === "string"
    ? source.sourceContentSha256.toLowerCase()
    : "0".repeat(64);
  const submittedHash = typeof source.submittedMediaContentSha256 === "string"
    ? source.submittedMediaContentSha256.toLowerCase()
    : sourceHash;
  const inputKind = input.kind === "inline" || input.kind === "provider_uri"
    ? input.kind
    : "invalid";

  return {
    provider: "gemini",
    connectorVersion: GEMINI_AGENTIC_VIDEO_CONNECTOR_VERSION,
    contractVersion: VIDEO_REASONING_CONTRACT_VERSION,
    responseSchemaVersion: VIDEO_REASONING_RESPONSE_SCHEMA_VERSION,
    requestHash: computeVideoReasoningRequestHash(request, sourceRangeUs),
    promptHash: computePromptHash(typeof raw.prompt === "string" ? raw.prompt : ""),
    sourceAssetId: typeof source.assetId === "string" ? source.assetId : "invalid",
    sourceContentSha256: sourceHash,
    submittedMediaContentSha256: submittedHash,
    sourceRangeUs,
    inputKind,
    mimeType: typeof input.mimeType === "string" ? input.mimeType.toLowerCase() : "invalid",
    model: typeof raw.model === "string" ? raw.model.trim() : "invalid",
    task: safeTask(request),
    processingRequested: "agentic",
    storeRequested: false,
    agenticUsed: false,
    processingCallCount: 0,
    processingResultCount: 0,
    matchedProcessingPairCount: 0,
    submitted: false,
    outcome: "failed",
    errorCode: "none",
    elapsedMs: safeElapsedMs(startedAt, now),
  };
}

function resultWithError(
  request: VideoReasoningRequest,
  sourceRangeUs: readonly [number, number],
  startedAt: number,
  now: () => number,
  outcome: Exclude<VideoReasoningOutcome, "completed">,
  errorCode: Exclude<VideoReasoningErrorCode, "none">,
  diagnosticPatch: Partial<VideoReasoningDiagnostic> = {},
): VideoReasoningResult {
  const diagnostic = {
    ...createBaseDiagnostic(request, sourceRangeUs, startedAt, now),
    ...diagnosticPatch,
    outcome,
    errorCode,
    elapsedMs: safeElapsedMs(startedAt, now),
  } satisfies VideoReasoningDiagnostic;
  return { outcome, observations: [], diagnostic };
}

async function defaultTransport(
  request: GeminiInteractionsHttpRequest,
): Promise<GeminiInteractionsHttpResponse> {
  const response = await fetch(request.url, {
    method: "POST",
    headers: request.headers,
    body: request.body,
    signal: request.signal,
  });
  return { status: response.status, body: await response.text() };
}

function validatedProviderUri(uri: string): boolean {
  try {
    const parsed = new URL(uri);
    if (parsed.protocol === "gs:") {
      return parsed.hostname.length > 0 && parsed.pathname.length > 1;
    }
    return parsed.protocol === "https:" &&
      parsed.hostname === "generativelanguage.googleapis.com" &&
      parsed.pathname.startsWith("/v1beta/files/") &&
      parsed.pathname.length > "/v1beta/files/".length;
  } catch {
    return false;
  }
}

function buildInteractionBody(
  request: VideoReasoningRequest,
  inlineData?: string,
): string {
  const videoInput = request.input.kind === "inline"
    ? {
        type: "video",
        data: inlineData ?? "",
        mime_type: request.input.mimeType,
        processing: "agentic",
      }
    : {
        type: "video",
        uri: request.input.uri,
        mime_type: request.input.mimeType,
        processing: "agentic",
      };

  return JSON.stringify({
    model: request.model.trim(),
    /** This one-shot probe never needs server-side conversation retention. */
    store: false,
    input: [
      videoInput,
      { type: "text", text: request.prompt },
    ],
    response_format: {
      type: "text",
      mime_type: "application/json",
      schema: VIDEO_REASONING_RESPONSE_SCHEMA,
    },
  });
}

function normalizeSteps(value: unknown): RawInteractionStep[] {
  return Array.isArray(value)
    ? value.filter((item): item is RawInteractionStep => isRecord(item))
    : [];
}

function inspectProcessingSteps(steps: RawInteractionStep[]): {
  callCount: number;
  resultCount: number;
  matchedPairCount: number;
} {
  const callIds = new Set<string>();
  const resultCallIds = new Set<string>();

  for (const step of steps) {
    if (step.type === "processing_call" && typeof step.id === "string" && step.id.length > 0) {
      callIds.add(step.id);
    }
    if (step.type === "processing_result" &&
        typeof step.call_id === "string" && step.call_id.length > 0) {
      resultCallIds.add(step.call_id);
    }
  }

  let matchedPairCount = 0;
  for (const id of callIds) {
    if (resultCallIds.has(id)) matchedPairCount += 1;
  }

  return {
    callCount: callIds.size,
    resultCount: resultCallIds.size,
    matchedPairCount,
  };
}

function extractTextFromModelOutputStep(step: RawInteractionStep): string {
  if (step.type !== "model_output" || !Array.isArray(step.content)) return "";
  return step.content
    .filter((block): block is Record<string, unknown> => isRecord(block))
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text as string)
    .join("");
}

function extractOutputText(response: RawInteractionResponse, steps: RawInteractionStep[]): string | null {
  if (typeof response.output_text === "string" && response.output_text.length > 0) {
    return response.output_text;
  }
  for (let index = steps.length - 1; index >= 0; index -= 1) {
    const text = extractTextFromModelOutputStep(steps[index]);
    if (text.length > 0) return text;
  }
  return null;
}

function extractUsage(value: unknown): VideoReasoningUsage | undefined {
  if (!isRecord(value)) return undefined;
  const usage: VideoReasoningUsage = {};
  const assign = (
    key: keyof VideoReasoningUsage,
    candidates: string[],
  ): void => {
    for (const candidate of candidates) {
      const parsed = safeNonNegativeInteger(value[candidate]);
      if (parsed !== undefined) {
        usage[key] = parsed;
        return;
      }
    }
  };

  assign("promptTokens", [
    "total_input_tokens",
    "totalInputTokens",
    "prompt_tokens",
    "promptTokens",
    "input_tokens",
    "inputTokens",
  ]);
  assign("completionTokens", [
    "total_output_tokens",
    "totalOutputTokens",
    "completion_tokens",
    "completionTokens",
    "output_tokens",
    "outputTokens",
  ]);
  assign("totalTokens", ["total_tokens", "totalTokens"]);
  assign("totalThoughtTokens", [
    "total_thought_tokens",
    "totalThoughtTokens",
    "thought_tokens",
    "thoughtTokens",
  ]);
  assign("totalToolUseTokens", [
    "total_tool_use_tokens",
    "totalToolUseTokens",
    "tool_use_tokens",
    "toolUseTokens",
  ]);

  return Object.keys(usage).length > 0 ? usage : undefined;
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const allowedSet = new Set(allowed);
  return Object.keys(value).every((key) => allowedSet.has(key));
}

function parseStructuredOutput(
  text: string,
  sourceRangeUs: readonly [number, number],
): { output?: RawStructuredOutput; observations?: VideoReasoningObservation[] } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return {};
  }
  if (!isRecord(parsed) ||
      !hasOnlyKeys(parsed, ["timestamp_basis", "summary", "observations"]) ||
      parsed.timestamp_basis !== "submitted_media" ||
      typeof parsed.summary !== "string" ||
      parsed.summary.trim().length === 0 ||
      Buffer.byteLength(parsed.summary, "utf8") > 4000 ||
      !Array.isArray(parsed.observations) ||
      parsed.observations.length > 32) {
    return {};
  }

  const offsetUs = sourceRangeUs[0];
  const submittedDurationUs = sourceRangeUs[1] - sourceRangeUs[0];
  const observations: VideoReasoningObservation[] = [];
  const rawObservations: RawStructuredObservation[] = [];

  for (const item of parsed.observations) {
    if (!isRecord(item) ||
        !hasOnlyKeys(item, ["start_seconds", "end_seconds", "label", "rationale", "confidence"]) ||
        typeof item.start_seconds !== "number" || !Number.isFinite(item.start_seconds) ||
        typeof item.end_seconds !== "number" || !Number.isFinite(item.end_seconds) ||
        item.start_seconds < 0 || item.end_seconds < item.start_seconds ||
        typeof item.label !== "string" || item.label.trim().length === 0 ||
        Buffer.byteLength(item.label, "utf8") > 256 ||
        typeof item.rationale !== "string" || item.rationale.trim().length === 0 ||
        Buffer.byteLength(item.rationale, "utf8") > 2000 ||
        typeof item.confidence !== "number" || !Number.isFinite(item.confidence) ||
        item.confidence < 0 || item.confidence > 1) {
      return {};
    }

    const relativeStartUs = Math.round(item.start_seconds * 1_000_000);
    const relativeEndUs = Math.round(item.end_seconds * 1_000_000);
    if (!Number.isSafeInteger(relativeStartUs) || !Number.isSafeInteger(relativeEndUs) ||
        relativeStartUs < 0 || relativeEndUs < relativeStartUs ||
        relativeEndUs > submittedDurationUs) {
      return {};
    }

    rawObservations.push({
      start_seconds: item.start_seconds,
      end_seconds: item.end_seconds,
      label: item.label.trim(),
      rationale: item.rationale.trim(),
      confidence: item.confidence,
    });
    observations.push({
      startUs: offsetUs + relativeStartUs,
      endUs: offsetUs + relativeEndUs,
      label: item.label.trim(),
      rationale: item.rationale.trim(),
      confidence: item.confidence,
      localVerification: "not_run",
    });
  }

  return {
    output: {
      timestamp_basis: "submitted_media",
      summary: parsed.summary.trim(),
      observations: rawObservations,
    },
    observations,
  };
}

function computeBytesSha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function withDeadline<T>(
  timeoutMs: number,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new GeminiAgenticVideoTimeoutError(timeoutMs));
    }, timeoutMs);
  });
  try {
    return await Promise.race([operation(controller.signal), timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export function createGeminiAgenticVideoConnector(
  options: GeminiAgenticVideoConnectorOptions = {},
): VideoReasoningConnector {
  const transport = options.transport ?? defaultTransport;
  const now = options.now ?? Date.now;
  const connectorInlineLimit = normalizePositiveLimit(
    options.maxInlineBytes,
    DEFAULT_MAX_INLINE_VIDEO_BYTES,
  );
  const connectorRequestLimit = normalizePositiveLimit(
    options.maxRequestBytes,
    DEFAULT_MAX_INTERACTIONS_REQUEST_BYTES,
  );
  const connectorResponseLimit = normalizePositiveLimit(
    options.maxResponseBytes,
    DEFAULT_MAX_INTERACTIONS_RESPONSE_BYTES,
  );

  return async (request: VideoReasoningRequest, context?: VideoReasoningConnectorContext): Promise<VideoReasoningResult> => {
    const startedAt = now();
    const validation = validateVideoReasoningRequest(request);
    const sourceRangeUs = validation.sourceRangeUs;

    if (!validation.ok) {
      return resultWithError(
        request,
        sourceRangeUs,
        startedAt,
        now,
        "rejected",
        "invalid_request",
      );
    }
    if (request.privacy === "local_only") {
      return resultWithError(request, sourceRangeUs, startedAt, now, "rejected", "local_only");
    }
    if (!request.consent?.approved) {
      return resultWithError(
        request,
        sourceRangeUs,
        startedAt,
        now,
        "rejected",
        "cloud_consent_required",
      );
    }
    if (request.consent.scope !== request.privacy) {
      return resultWithError(
        request,
        sourceRangeUs,
        startedAt,
        now,
        "rejected",
        "cloud_consent_scope_mismatch",
      );
    }
    if (!GEMINI_AGENTIC_VIDEO_MODEL_SET.has(request.model.trim())) {
      return resultWithError(
        request,
        sourceRangeUs,
        startedAt,
        now,
        "rejected",
        "unsupported_model",
      );
    }
    if (request.budget?.maxRequests !== undefined && request.budget.maxRequests < 1) {
      return resultWithError(
        request,
        sourceRangeUs,
        startedAt,
        now,
        "rejected",
        "request_budget_exceeded",
      );
    }
    if (request.budget?.maxUploadedDurationUs !== undefined &&
        validation.submittedDurationUs > request.budget.maxUploadedDurationUs) {
      return resultWithError(
        request,
        sourceRangeUs,
        startedAt,
        now,
        "rejected",
        "duration_budget_exceeded",
      );
    }

    const apiKey = options.apiKey ?? process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return resultWithError(
        request,
        sourceRangeUs,
        startedAt,
        now,
        "failed",
        "api_key_missing",
      );
    }

    let inlineData: string | undefined;
    let inputBytes: number | undefined;
    if (request.input.kind === "inline") {
      if (!path.isAbsolute(request.input.path)) {
        return resultWithError(
          request,
          sourceRangeUs,
          startedAt,
          now,
          "rejected",
          "invalid_request",
        );
      }
      try {
        const before = fs.lstatSync(request.input.path);
        if (before.isSymbolicLink() || !before.isFile() || before.size <= 0) {
          throw new Error("input_not_regular_file");
        }
        inputBytes = before.size;
        const requestLimit = request.budget?.maxInputBytes;
        const effectiveLimit = requestLimit === undefined
          ? connectorInlineLimit
          : Math.min(connectorInlineLimit, requestLimit);
        if (inputBytes > effectiveLimit) {
          return resultWithError(
            request,
            sourceRangeUs,
            startedAt,
            now,
            "rejected",
            "input_too_large",
            { inputBytes },
          );
        }
        const bytes = fs.readFileSync(request.input.path);
        inputBytes = bytes.length;
        const after = fs.lstatSync(request.input.path);
        if (after.isSymbolicLink() || !after.isFile() ||
            after.size !== before.size || after.mtimeMs !== before.mtimeMs ||
            inputBytes !== before.size) {
          throw new Error("input_changed_during_read");
        }
        if (inputBytes > effectiveLimit) {
          return resultWithError(
            request,
            sourceRangeUs,
            startedAt,
            now,
            "rejected",
            "input_too_large",
            { inputBytes },
          );
        }
        const actualHash = computeBytesSha256(bytes);
        const expectedHash = (
          request.source.submittedMediaContentSha256
          ?? request.source.sourceContentSha256
        ).toLowerCase();
        if (actualHash !== expectedHash) {
          return resultWithError(
            request,
            sourceRangeUs,
            startedAt,
            now,
            "rejected",
            "input_content_hash_mismatch",
            { inputBytes },
          );
        }
        inlineData = bytes.toString("base64");
      } catch {
        return resultWithError(
          request,
          sourceRangeUs,
          startedAt,
          now,
          "failed",
          "input_read_failed",
          inputBytes === undefined ? {} : { inputBytes },
        );
      }
    } else if (!validatedProviderUri(request.input.uri)) {
      return resultWithError(
        request,
        sourceRangeUs,
        startedAt,
        now,
        "rejected",
        "provider_uri_not_allowed",
      );
    }

    const body = buildInteractionBody(request, inlineData);
    const requestBytes = Buffer.byteLength(body, "utf8");
    if (requestBytes > connectorRequestLimit) {
      return resultWithError(
        request,
        sourceRangeUs,
        startedAt,
        now,
        "rejected",
        "request_too_large",
        { inputBytes, requestBytes },
      );
    }

    const timeoutMs = normalizeTimeoutMs(request);
    let submitted = false;
    let response: GeminiInteractionsHttpResponse;
    try {
      response = await withDeadline(timeoutMs, async (signal) => {
        if (context?.onBeforeSubmit) {
          await context.onBeforeSubmit();
        }
        submitted = true;
        return transport({
          url: GEMINI_INTERACTIONS_ENDPOINT,
          headers: {
            "Content-Type": "application/json",
            "x-goog-api-key": apiKey,
            "Api-Revision": GEMINI_INTERACTIONS_API_REVISION,
          },
          body,
          signal,
        });
      });
    } catch (error) {
      if (!submitted) {
        return resultWithError(
          request,
          sourceRangeUs,
          startedAt,
          now,
          "rejected",
          "pre_submit_error",
          { submitted: false, inputBytes, requestBytes },
        );
      }
      const errorCode: VideoReasoningErrorCode =
        error instanceof GeminiAgenticVideoTimeoutError
          ? "transport_timeout_unknown"
          : "transport_error_unknown";
      return resultWithError(
        request,
        sourceRangeUs,
        startedAt,
        now,
        "unknown",
        errorCode,
        { submitted, inputBytes, requestBytes },
      );
    }

    const responseBytes = Buffer.byteLength(response.body, "utf8");
    if (responseBytes > connectorResponseLimit) {
      return resultWithError(
        request,
        sourceRangeUs,
        startedAt,
        now,
        "failed",
        "provider_response_too_large",
        {
          submitted: true,
          inputBytes,
          requestBytes,
          responseBytes,
          httpStatus: Number.isInteger(response.status) ? response.status : undefined,
        },
      );
    }
    if (!Number.isInteger(response.status) || response.status < 200 || response.status >= 300) {
      return resultWithError(
        request,
        sourceRangeUs,
        startedAt,
        now,
        "failed",
        "provider_http_error",
        {
          submitted: true,
          inputBytes,
          requestBytes,
          responseBytes,
          httpStatus: Number.isInteger(response.status) ? response.status : undefined,
        },
      );
    }

    let raw: RawInteractionResponse;
    try {
      const parsed = JSON.parse(response.body) as unknown;
      if (!isRecord(parsed)) throw new Error("invalid_envelope");
      raw = parsed as RawInteractionResponse;
    } catch {
      return resultWithError(
        request,
        sourceRangeUs,
        startedAt,
        now,
        "failed",
        "provider_response_invalid",
        { submitted: true, inputBytes, requestBytes, responseBytes, httpStatus: response.status },
      );
    }

    const sharedResponseDiagnostic = {
      submitted: true,
      inputBytes,
      requestBytes,
      responseBytes,
      httpStatus: response.status,
      providerRequestId: safeProviderRequestId(raw.id),
      effectiveModel: safeEffectiveModel(raw.model),
      usage: extractUsage(raw.usage),
    } satisfies Partial<VideoReasoningDiagnostic>;

    if ((raw.object !== undefined && raw.object !== "interaction") ||
        raw.status !== "completed") {
      return resultWithError(
        request,
        sourceRangeUs,
        startedAt,
        now,
        "failed",
        raw.status === "completed" ? "provider_response_invalid" : "interaction_incomplete",
        sharedResponseDiagnostic,
      );
    }

    const steps = normalizeSteps(raw.steps);
    const processing = inspectProcessingSteps(steps);
    const sharedDiagnostic = {
      ...sharedResponseDiagnostic,
      processingCallCount: processing.callCount,
      processingResultCount: processing.resultCount,
      matchedProcessingPairCount: processing.matchedPairCount,
      agenticUsed: processing.matchedPairCount > 0,
    } satisfies Partial<VideoReasoningDiagnostic>;

    if (processing.matchedPairCount < 1) {
      return resultWithError(
        request,
        sourceRangeUs,
        startedAt,
        now,
        "failed",
        "agentic_steps_missing",
        sharedDiagnostic,
      );
    }

    const outputText = extractOutputText(raw, steps);
    if (outputText === null) {
      return resultWithError(
        request,
        sourceRangeUs,
        startedAt,
        now,
        "failed",
        "provider_response_invalid",
        sharedDiagnostic,
      );
    }

    const normalized = parseStructuredOutput(outputText, sourceRangeUs);
    if (!normalized.output || !normalized.observations) {
      return resultWithError(
        request,
        sourceRangeUs,
        startedAt,
        now,
        "failed",
        "structured_output_invalid",
        sharedDiagnostic,
      );
    }

    const diagnostic = {
      ...createBaseDiagnostic(request, sourceRangeUs, startedAt, now),
      ...sharedDiagnostic,
      outcome: "completed",
      errorCode: "none",
      elapsedMs: safeElapsedMs(startedAt, now),
    } satisfies VideoReasoningDiagnostic;

    return {
      outcome: "completed",
      summary: normalized.output.summary,
      observations: normalized.observations,
      diagnostic,
    };
  };
}
