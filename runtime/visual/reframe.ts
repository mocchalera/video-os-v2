import { createHash } from "node:crypto";
import { validateArtifact } from "../artifacts/loaders.js";
import type {
  FramingEvaluationInput,
  FramingObservation,
  FramingOutput,
  FramingPolicyDocument,
  FramingPolicyResult,
} from "./framing-policy.js";
import { canonicalJson, evaluateFramingPolicy, framingPolicyContentHash } from "./framing-policy.js";
import type { FramingMode, SourceEvidencePin, VisualTransform } from "./types.js";

export interface LocalVisionModelIdentity {
  id: string;
  version: string;
}

export interface LocalVisionProviderIdentity {
  id: string;
  version: string;
}

export interface LocalVisionCacheIdentity {
  status: "hit" | "miss" | "unavailable";
  key?: string;
  reason?: string;
}

export interface LocalVisionAnalysis {
  status: "ready" | "unavailable";
  observations: FramingObservation[];
  model: LocalVisionModelIdentity;
  cache: LocalVisionCacheIdentity;
  provider?: LocalVisionProviderIdentity;
}

export interface LocalVisionReframeRequest {
  source: SourceEvidencePin;
  output: FramingOutput;
  mode: FramingMode;
  policy: FramingPolicyDocument;
  manual_transform?: VisualTransform;
}

/**
 * Adapter boundary for optional local vision. Implementations may wrap Apple
 * Vision, a cached local detector, or another local provider. The compiler does
 * not require the adapter to be installed.
 */
export interface LocalVisionReframeAdapter {
  adapter_id: string;
  adapter_version: string;
  provider?: LocalVisionProviderIdentity;
  model?: LocalVisionModelIdentity;
  is_available?: () => boolean | Promise<boolean>;
  analyze: (request: LocalVisionReframeRequest) => Promise<LocalVisionAnalysis>;
}

export interface ReframeCandidateEvidence {
  version: "reframe-candidate/v1";
  source_identity: SourceEvidencePin;
  analyzed_range: SourceEvidencePin["source_range"];
  framing_policy: {
    id: string;
    version: "framing-policy/v1";
    content_hash: string;
  };
  framing_output: FramingOutput;
  model: LocalVisionModelIdentity;
  cache: LocalVisionCacheIdentity;
  provider: LocalVisionProviderIdentity;
  adapter: {
    id: string;
    version: string;
  };
  result: FramingPolicyResult;
  fallback: {
    manual_available: true;
    used: boolean;
    reason?: string;
  };
  result_hash: string;
  candidate_hash: string;
}

export class ReframeEvidenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReframeEvidenceError";
  }
}

export async function resolveVisionAssistedReframe(
  request: LocalVisionReframeRequest,
  adapter?: LocalVisionReframeAdapter,
): Promise<ReframeCandidateEvidence> {
  assertSourceEvidencePin(request.source);
  const adapterIdentity = adapterIdentityFor(adapter);
  const unavailableProvider = providerIdentityFor(adapter);
  const unavailableModel = adapter?.model ?? { id: "unavailable", version: "unavailable" };
  if (!adapter) {
    return createManualReframeCandidate(request, adapterIdentity, unavailableModel, {
      status: "unavailable",
      key: undefined,
      reason: "adapter_missing",
    }, "vision_unavailable:adapter_missing", unavailableProvider);
  }

  try {
    if (adapter.is_available && !(await adapter.is_available())) {
      return createManualReframeCandidate(request, adapterIdentity, unavailableModel, {
        status: "unavailable",
        reason: "local_model_or_cache_unavailable",
      }, "vision_unavailable:local_model_or_cache_unavailable", unavailableProvider);
    }
    const analysis = await adapter.analyze(request);
    const model = validModelIdentity(analysis.model) ? analysis.model : unavailableModel;
    const provider = validProviderIdentity(analysis.provider) ? analysis.provider : unavailableProvider;
    if (analysis.status !== "ready") {
      return createManualReframeCandidate(request, adapterIdentity, model, analysis.cache, "vision_unavailable", provider);
    }
    if (!validModelIdentity(model)) {
      return createManualReframeCandidate(request, adapterIdentity, unavailableModel, analysis.cache, "model_identity_missing", provider);
    }
    const evaluation = evaluateFramingPolicy({
      observations: analysis.observations,
      output: request.output,
      mode: request.mode,
      ...(request.manual_transform ? { manual_transform: request.manual_transform } : {}),
    }, request.policy);
    return buildCandidate(request, adapterIdentity, model, analysis.cache, provider, evaluation);
  } catch (error) {
    const reason = errorCode(error);
    return createManualReframeCandidate(request, adapterIdentity, unavailableModel, {
      status: "unavailable",
      reason,
    }, `vision_unavailable:${reason}`, unavailableProvider);
  }
}

export function createManualReframeCandidate(
  request: LocalVisionReframeRequest,
  adapter: { id: string; version: string } = { id: "none", version: "none" },
  model: LocalVisionModelIdentity = { id: "unavailable", version: "unavailable" },
  cache: LocalVisionCacheIdentity = { status: "unavailable", reason: "manual_fallback" },
  reason = "vision_unavailable:manual_fallback",
  provider: LocalVisionProviderIdentity = { id: "unavailable", version: "unavailable" },
): ReframeCandidateEvidence {
  assertSourceEvidencePin(request.source);
  const result = evaluateFramingPolicy({
    observations: [],
    output: request.output,
    mode: request.mode,
    ...(request.manual_transform ? { manual_transform: request.manual_transform } : {}),
  }, request.policy);
  return buildCandidate(
    request,
    adapter,
    validModelIdentity(model) ? model : { id: "unavailable", version: "unavailable" },
    cache,
    provider,
    {
      ...result,
      degrade_reason: reason,
    },
  );
}

export function verifyReframeCandidateEvidence(
  candidate: ReframeCandidateEvidence,
): ReframeCandidateEvidence {
  try {
    validateArtifact(candidate, "reframe-candidate.schema.json");
  } catch (error) {
    throw new ReframeEvidenceError(
      `reframe candidate schema is invalid: ${error instanceof Error ? error.message : "unknown validation error"}`,
    );
  }

  assertSourceEvidencePin(candidate.source_identity);
  assertSourceRange(candidate.analyzed_range, "candidate analyzed_range");
  if (!sameRange(candidate.analyzed_range, candidate.source_identity.source_range)) {
    throw new ReframeEvidenceError("reframe candidate analyzed_range must exactly match source_identity.source_range");
  }
  if (!candidate.framing_policy.id.trim() || candidate.framing_policy.version !== "framing-policy/v1" ||
      !/^sha256:[0-9a-f]{64}$/.test(candidate.framing_policy.content_hash)) {
    throw new ReframeEvidenceError("reframe candidate framing_policy identity is invalid");
  }
  if (!validFramingOutput(candidate.framing_output)) {
    throw new ReframeEvidenceError("reframe candidate framing_output must contain positive integer dimensions");
  }
  if (!validModelIdentity(candidate.model)) {
    throw new ReframeEvidenceError("reframe candidate model identity is required");
  }
  if (!validProviderIdentity(candidate.provider)) {
    throw new ReframeEvidenceError("reframe candidate provider identity is required");
  }
  if (!candidate.adapter.id.trim() || !candidate.adapter.version.trim()) {
    throw new ReframeEvidenceError("reframe candidate adapter identity is required");
  }
  if (candidate.result.policy_id !== candidate.framing_policy.id || candidate.result.policy_version !== candidate.framing_policy.version) {
    throw new ReframeEvidenceError("reframe candidate result policy identity does not match framing_policy");
  }
  if (candidate.result.status !== "manual_fallback") {
    if (!/^weights-sha256:[0-9a-f]{64}$/.test(candidate.model.version)) {
      throw new ReframeEvidenceError("vision reframe candidate model.version must be a pinned weights-sha256 digest");
    }
    if (candidate.cache.status === "unavailable") {
      throw new ReframeEvidenceError("vision reframe candidate cannot use an unavailable cache");
    }
    if (candidate.provider.id === "unavailable" || candidate.provider.version === "unavailable" ||
        candidate.adapter.id === "none" || candidate.adapter.version === "none" || candidate.adapter.version === "unavailable") {
      throw new ReframeEvidenceError("vision reframe candidate must pin provider and adapter versions");
    }
  }
  if (candidate.cache.status === "hit" && !candidate.cache.key?.trim()) {
    throw new ReframeEvidenceError("cache hit candidates must pin cache.key");
  }
  if ((candidate.cache.status === "miss" || candidate.cache.status === "unavailable") && !candidate.cache.reason?.trim()) {
    throw new ReframeEvidenceError("cache miss/unavailable candidates must explain the cache state");
  }
  if (candidate.fallback.manual_available !== true) {
    throw new ReframeEvidenceError("manual fallback must remain available");
  }
  if (candidate.fallback.used !== (candidate.result.status === "manual_fallback")) {
    throw new ReframeEvidenceError("manual fallback usage does not match the framing result status");
  }
  if (candidate.result.status === "ready" && candidate.result.degraded) {
    throw new ReframeEvidenceError("ready framing results cannot be marked degraded");
  }
  if (candidate.result.status !== "ready" && !candidate.result.degraded) {
    throw new ReframeEvidenceError("degraded/manual framing results must explicitly mark degraded=true");
  }
  if (candidate.result.status === "manual_fallback" &&
      (candidate.result.applied_mode !== "manual" || !candidate.result.degrade_reason?.trim())) {
    throw new ReframeEvidenceError("manual fallback must identify manual mode and a degrade reason");
  }
  if (candidate.result.status === "degraded" && !candidate.result.degrade_reason?.trim()) {
    throw new ReframeEvidenceError("degraded framing results must identify a safe-degrade reason");
  }
  if (sha256(candidate.result) !== candidate.result_hash) {
    throw new ReframeEvidenceError("reframe candidate result_hash does not match the pinned result");
  }
  const base = structuredClone(candidate) as unknown as Record<string, unknown>;
  delete base.candidate_hash;
  if (sha256(base) !== candidate.candidate_hash) {
    throw new ReframeEvidenceError("reframe candidate candidate_hash does not match pinned evidence");
  }
  return candidate;
}

function buildCandidate(
  request: LocalVisionReframeRequest,
  adapter: { id: string; version: string },
  model: LocalVisionModelIdentity,
  cache: LocalVisionCacheIdentity,
  provider: LocalVisionProviderIdentity,
  result: FramingPolicyResult,
): ReframeCandidateEvidence {
  const resultHash = sha256(result);
  const base = {
    version: "reframe-candidate/v1" as const,
    source_identity: structuredClone(request.source),
    analyzed_range: structuredClone(request.source.source_range),
    framing_policy: {
      id: request.policy.policy_id,
      version: request.policy.version,
      content_hash: framingPolicyContentHash(request.policy),
    },
    framing_output: structuredClone(request.output),
    model: structuredClone(model),
    cache: structuredClone(cache),
    provider: structuredClone(provider),
    adapter: structuredClone(adapter),
    result: structuredClone(result),
    fallback: {
      manual_available: true as const,
      used: result.status === "manual_fallback",
      ...(result.degrade_reason ? { reason: result.degrade_reason } : {}),
    },
    result_hash: resultHash,
  };
  return {
    ...base,
    candidate_hash: sha256(base),
  };
}

function assertSourceEvidencePin(source: SourceEvidencePin): void {
  if (!source || typeof source.asset_id !== "string" || !source.asset_id.trim()) {
    throw new ReframeEvidenceError("source evidence asset_id is required");
  }
  if (typeof source.segment_id !== "string" || !source.segment_id.trim()) {
    throw new ReframeEvidenceError("source evidence segment_id is required");
  }
  if (!/^sha256:[0-9a-f]{64}$/.test(source.source_content_hash)) {
    throw new ReframeEvidenceError("source evidence source_content_hash must be sha256:<64 lowercase hex characters>");
  }
  assertSourceRange(source.source_range, "source evidence source_range");
}

function assertSourceRange(
  range: unknown,
  label: string,
): asserts range is SourceEvidencePin["source_range"] {
  if (!range || typeof range !== "object") {
    throw new ReframeEvidenceError(`${label} must be an object`);
  }
  const candidate = range as SourceEvidencePin["source_range"];
  if (!Number.isSafeInteger(candidate.src_in_us) || !Number.isSafeInteger(candidate.src_out_us) ||
      candidate.src_in_us < 0 || candidate.src_out_us <= candidate.src_in_us) {
    throw new ReframeEvidenceError(`${label} must be a non-empty non-negative range`);
  }
}

function sameRange(
  left: SourceEvidencePin["source_range"],
  right: SourceEvidencePin["source_range"],
): boolean {
  return left.src_in_us === right.src_in_us && left.src_out_us === right.src_out_us;
}

function adapterIdentityFor(adapter?: LocalVisionReframeAdapter): { id: string; version: string } {
  return {
    id: adapter?.adapter_id?.trim() || "optional-local-vision",
    version: adapter?.adapter_version?.trim() || "unavailable",
  };
}

function providerIdentityFor(adapter?: LocalVisionReframeAdapter): LocalVisionProviderIdentity {
  if (adapter?.provider && validProviderIdentity(adapter.provider)) return structuredClone(adapter.provider);
  if (adapter) {
    return {
      id: adapter.adapter_id?.trim() || "optional-local-vision",
      version: adapter.adapter_version?.trim() || "unavailable",
    };
  }
  return { id: "unavailable", version: "unavailable" };
}

function validModelIdentity(model: unknown): model is LocalVisionModelIdentity {
  return Boolean(model) && typeof model === "object" &&
    typeof (model as LocalVisionModelIdentity).id === "string" &&
    (model as LocalVisionModelIdentity).id.trim() !== "" &&
    typeof (model as LocalVisionModelIdentity).version === "string" &&
    (model as LocalVisionModelIdentity).version.trim() !== "";
}

function validProviderIdentity(provider: unknown): provider is LocalVisionProviderIdentity {
  return Boolean(provider) && typeof provider === "object" &&
    typeof (provider as LocalVisionProviderIdentity).id === "string" &&
    (provider as LocalVisionProviderIdentity).id.trim() !== "" &&
    typeof (provider as LocalVisionProviderIdentity).version === "string" &&
    (provider as LocalVisionProviderIdentity).version.trim() !== "";
}

function validFramingOutput(output: unknown): output is FramingOutput {
  return Boolean(output) && typeof output === "object" &&
    Number.isSafeInteger((output as FramingOutput).width) && (output as FramingOutput).width > 0 &&
    Number.isSafeInteger((output as FramingOutput).height) && (output as FramingOutput).height > 0;
}

function errorCode(error: unknown): string {
  if (error && typeof error === "object" && "code" in error && typeof error.code === "string") {
    return error.code;
  }
  if (error instanceof Error && error.message.trim()) return "adapter_error";
  return "unknown_error";
}

function sha256(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}
