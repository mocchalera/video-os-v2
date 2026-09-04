import * as fs from "node:fs";
import * as path from "node:path";
import { parse as parseYaml } from "yaml";
import { validateArtifact } from "../artifacts/loaders.js";
import type { ProfileDefinition } from "../compiler/types.js";
import {
  loadProfiles,
  resolveProfileAndPolicy,
  type EditorialBriefFields,
} from "../editorial/policy-resolver.js";
import {
  readCurrentReviewResponse,
  verifyCurrentReviewReady,
  type ReviewQaReceipt,
} from "./review-ready-transaction.js";
import type { SocialReviewGenerationReceipt } from "./social-review-generation.js";
import { hashCanonical, sha256File } from "./social-review-generation.js";

export const OPTIONAL_VLM_POLICY_VERSION = "optional-vlm-policy/v1" as const;
export const OPTIONAL_VLM_POLICY_PATH = "06_review/optional-vlm-policy.json" as const;

const SHA256 = /^sha256:[a-f0-9]{64}$/;
const DEFAULT_PROVIDER = "marlin-local";
const DEFAULT_MODEL = "NemoStation/Marlin-2B";

export type OptionalVlmCapabilityRequirement = "required" | "optional";
export type OptionalVlmClassification =
  | "available"
  | "unavailable_optional"
  | "execution_failed"
  | "invalid_result"
  | "qa_failed";

export type OptionalVlmErrorCode =
  | "HTTP_401"
  | "HTTP_403"
  | "GATED_REPOSITORY"
  | "MODEL_CACHE_MISSING"
  | "OPTIONAL_DEPENDENCY_MISSING"
  | "OPTIONAL_UNAVAILABLE"
  | "EXECUTION_TIMEOUT"
  | "EXECUTION_CRASH"
  | "EXECUTION_ERROR"
  | "MALFORMED_RESPONSE"
  | "MODEL_DETECTED_DEFECT";

export type OptionalVlmPolicyStatus =
  | "blocked"
  | "optional_unavailable"
  | "deterministic_qa_pending"
  | "human_approval_pending"
  | "skipped_unavailable_optional"
  | "available"
  | "execution_failed"
  | "invalid_result"
  | "qa_failed";

export type OptionalVlmQaCheck = "pass" | "pending" | "fail";

export interface OptionalVlmCapability {
  id: "visual_model";
  requirement: OptionalVlmCapabilityRequirement;
  provider: string;
  model: string;
}

export interface OptionalVlmCapabilityProfile {
  profile_id: string;
  capability: OptionalVlmCapability;
}

export interface OptionalVlmClassificationResult {
  classification: OptionalVlmClassification;
  provider: string;
  model: string;
  error_code: OptionalVlmErrorCode | null;
  result_fingerprint: string;
}

export interface OptionalVlmPolicyArtifact {
  version: typeof OPTIONAL_VLM_POLICY_VERSION;
  project_id: string;
  profile_id: string;
  capability: {
    id: "visual_model";
    requirement: OptionalVlmCapabilityRequirement;
  };
  generation: {
    generation_id: string;
    video_sha256: string;
    timeline_sha256: string;
  };
  provider: {
    provider: string;
    model: string;
  };
  outcome: {
    classification: OptionalVlmClassification;
    error_code: OptionalVlmErrorCode | null;
    result_fingerprint: string;
  };
  deterministic_qa: {
    status: "passed" | "pending" | "failed";
    full_decode: OptionalVlmQaCheck;
    black: OptionalVlmQaCheck;
    freeze: OptionalVlmQaCheck;
    inset: OptionalVlmQaCheck;
    layout: OptionalVlmQaCheck;
    caption: OptionalVlmQaCheck;
  };
  human_approval: {
    status: "approved" | "pending" | "rejected" | "identity_mismatch";
    actor?: string;
    generation_id?: string;
    video_sha256?: string;
    timeline_sha256?: string;
  };
  status: OptionalVlmPolicyStatus;
  retry: {
    same_unavailable_result: boolean;
    action: "not_applicable" | "not_retried" | "new_result";
  };
}

export interface OptionalVlmDeterministicQA {
  status: "passed" | "pending" | "failed";
  full_decode: OptionalVlmQaCheck;
  black: OptionalVlmQaCheck;
  freeze: OptionalVlmQaCheck;
  inset: OptionalVlmQaCheck;
  layout: OptionalVlmQaCheck;
  caption: OptionalVlmQaCheck;
}

export interface OptionalVlmPolicyInput {
  project_id: string;
  profile: OptionalVlmCapabilityProfile | ProfileDefinition | Record<string, unknown>;
  generation: {
    generation_id: string;
    video_sha256: string;
    timeline_sha256: string;
  };
  result: unknown;
  deterministic_qa?: unknown;
  human_approval?: unknown;
  previous?: OptionalVlmPolicyArtifact | null;
}

export interface OptionalVlmGateContext {
  generation_id?: string;
  video_sha256?: string;
  timeline_sha256?: string;
}

export type OptionalVlmIdentityStatus = "current" | "missing" | "mismatch";

export interface OptionalVlmPolicyStatusSummary {
  exists: boolean;
  path: string;
  valid: boolean;
  status: OptionalVlmPolicyStatus | "not_configured";
  classification?: OptionalVlmClassification;
  requirement?: OptionalVlmCapabilityRequirement;
  profile_id?: string;
  generation_id?: string;
  video_sha256?: string;
  timeline_sha256?: string;
  current_generation_id?: string;
  current_video_sha256?: string;
  current_timeline_sha256?: string;
  identity_status?: OptionalVlmIdentityStatus;
  error_code?: OptionalVlmErrorCode | null;
  closeable: boolean;
  error?: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function stringField(record: Record<string, unknown> | null, ...keys: string[]): string | undefined {
  if (!record) return undefined;
  for (const key of keys) {
    const value = stringValue(record[key]);
    if (value) return value;
  }
  return undefined;
}

function booleanField(record: Record<string, unknown> | null, ...keys: string[]): boolean | undefined {
  if (!record) return undefined;
  for (const key of keys) {
    if (typeof record[key] === "boolean") return record[key] as boolean;
  }
  return undefined;
}

function numberField(record: Record<string, unknown> | null, ...keys: string[]): number | undefined {
  if (!record) return undefined;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isInteger(value)) return value;
    if (typeof value === "string" && /^\d{3}$/.test(value)) return Number(value);
  }
  return undefined;
}

/** Keep identities useful while stripping credentials, queries, and fragments. */
export function sanitizeOptionalVlmIdentity(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const withoutCredentials = value.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/@]+@/i, "");
  const withoutQuery = withoutCredentials.split(/[?#]/, 1)[0] ?? "";
  const normalized = withoutQuery
    .replace(/[^A-Za-z0-9._:/-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^[_./-]+|[_./-]+$/g, "")
    .slice(0, 128);
  return normalized || fallback;
}

function externalErrorText(record: Record<string, unknown>): string {
  const nested = asRecord(record.error);
  const nestedErrorMessage = record.error instanceof Error ? record.error.message : undefined;
  return [
    stringField(record, "error_code", "errorCode", "code"),
    stringField(record, "error", "message", "reason", "detail", "name", "type"),
    stringField(nested, "code", "message", "reason", "detail"),
    nestedErrorMessage,
  ].filter((value): value is string => Boolean(value)).join(" ");
}

function normalizedToken(value: string): string {
  return value.toUpperCase().replace(/[^A-Z0-9]+/g, "_");
}

function explicitErrorCode(
  record: Record<string, unknown>,
  text: string,
  statusCode: number | undefined,
  nestedRecords: Array<Record<string, unknown> | null> = [],
): OptionalVlmErrorCode | undefined {
  if (statusCode === 401 || /(?:^|\D)401(?:\D|$)/.test(text)) return "HTTP_401";
  if (statusCode === 403 || /(?:^|\D)403(?:\D|$)/.test(text)) return "HTTP_403";

  const rawCodes = [
    stringField(record, "error_code", "errorCode", "code"),
    ...nestedRecords.map((nested) => stringField(nested, "error_code", "errorCode", "code")),
  ].filter((value): value is string => Boolean(value));
  for (const rawCode of rawCodes) {
    const token = normalizedToken(rawCode);
    if (token.includes("GATED") || token.includes("ACCESS_DENIED")) return "GATED_REPOSITORY";
    if (token.includes("CACHE") || token.includes("MODEL_NOT_FOUND") || token.includes("MODEL_MISSING")) {
      return "MODEL_CACHE_MISSING";
    }
    if (token.includes("DEPENDENCY") || token.includes("MODULE_NOT_FOUND")) return "OPTIONAL_DEPENDENCY_MISSING";
    if (token.includes("OPTIONAL_UNAVAILABLE")) return "OPTIONAL_UNAVAILABLE";
    if (token.includes("TIMEOUT") || token.includes("ETIMEDOUT")) return "EXECUTION_TIMEOUT";
    if (token.includes("CRASH") || token.includes("SIGTERM") || token.includes("SIGKILL")) return "EXECUTION_CRASH";
    if (token.includes("MALFORMED") || token.includes("INVALID_RESULT") || token.includes("PARSE")) return "MALFORMED_RESPONSE";
    if (token.includes("DEFECT") || token.includes("QA_FAILED")) return "MODEL_DETECTED_DEFECT";
  }
  return undefined;
}

function unavailableCode(text: string): OptionalVlmErrorCode | undefined {
  if (/gated\s+(?:repo(?:sitory)?|model)|cannot access gated|access denied.*(?:repo|model)/i.test(text)) {
    return "GATED_REPOSITORY";
  }
  if (/(?:cache|weights?).*(?:missing|miss|not found|unavailable)|(?:missing|not found|unavailable).*(?:cache|weights?)/i.test(text)) {
    return "MODEL_CACHE_MISSING";
  }
  if (/(?:optional\s+)?dependenc(?:y|ies|module).*(?:missing|not found|unavailable)|module not found|cannot find (?:module|package)/i.test(text)) {
    return "OPTIONAL_DEPENDENCY_MISSING";
  }
  if (/(?:model|repository|repo).*(?:missing|not found|unavailable|cannot access)/i.test(text)) {
    return "MODEL_CACHE_MISSING";
  }
  return undefined;
}

function hasNonEmptyArray(record: Record<string, unknown> | null, ...keys: string[]): boolean {
  if (!record) return false;
  return keys.some((key) => Array.isArray(record[key]) && (record[key] as unknown[]).length > 0);
}

function makeClassification(
  classification: OptionalVlmClassification,
  provider: string,
  model: string,
  errorCode: OptionalVlmErrorCode | null,
): OptionalVlmClassificationResult {
  const sanitizedProvider = sanitizeOptionalVlmIdentity(provider, DEFAULT_PROVIDER);
  const sanitizedModel = sanitizeOptionalVlmIdentity(model, DEFAULT_MODEL);
  return {
    classification,
    provider: sanitizedProvider,
    model: sanitizedModel,
    error_code: errorCode,
    result_fingerprint: hashCanonical({
      version: OPTIONAL_VLM_POLICY_VERSION,
      classification,
      provider: sanitizedProvider,
      model: sanitizedModel,
      error_code: errorCode,
    }),
  };
}

/**
 * Convert an untrusted provider result/error to the Issue 44 taxonomy.
 * Only the returned fixed code and sanitized identities are safe to persist.
 */
export function classifyOptionalVlmResult(
  value: unknown,
  identity: { provider?: unknown; model?: unknown } = {},
): OptionalVlmClassificationResult {
  const record = asRecord(value);
  const provider = stringField(record, "provider", "provider_id") ?? stringValue(identity.provider) ?? DEFAULT_PROVIDER;
  const model = stringField(record, "model", "model_id", "model_alias") ?? stringValue(identity.model) ?? DEFAULT_MODEL;
  if (!record) return makeClassification("invalid_result", provider, model, "MALFORMED_RESPONSE");

  const direct = stringField(record, "classification", "outcome", "result_status")?.toLowerCase();
  const status = stringField(record, "status", "state")?.toLowerCase();
  const text = externalErrorText(record);
  const response = record.response ?? record.result ?? record.output ?? record.data;
  const responseRecord = asRecord(response);
  const responseStatus = stringField(responseRecord, "status", "classification")?.toLowerCase();
  const nestedError = asRecord(record.error);
  const statusCode = numberField(record, "http_status", "httpStatus", "status_code", "statusCode", "status")
    ?? numberField(nestedError, "http_status", "httpStatus", "status_code", "statusCode", "status")
    ?? numberField(responseRecord, "http_status", "httpStatus", "status_code", "statusCode", "status");
  const code = explicitErrorCode(record, text, statusCode, [nestedError, responseRecord]);

  if (statusCode === 401 || statusCode === 403 || code === "HTTP_401" || code === "HTTP_403") {
    return makeClassification(
      "unavailable_optional",
      provider,
      model,
      statusCode === 401 || code === "HTTP_401" ? "HTTP_401" : "HTTP_403",
    );
  }
  const unavailable = unavailableCode(text);
  if (unavailable) return makeClassification("unavailable_optional", provider, model, unavailable);
  if (code === "GATED_REPOSITORY"
    || code === "MODEL_CACHE_MISSING"
    || code === "OPTIONAL_DEPENDENCY_MISSING"
    || code === "OPTIONAL_UNAVAILABLE") {
    return makeClassification("unavailable_optional", provider, model, code);
  }

  const timedOut = booleanField(record, "timed_out", "timedOut", "timeout") === true
    || code === "EXECUTION_TIMEOUT"
    || statusCode === 408
    || statusCode === 504
    || status === "timeout"
    || status === "timed_out"
    || /timed?\s*out|\bETIMEDOUT\b/i.test(text);
  if (timedOut) return makeClassification("execution_failed", provider, model, "EXECUTION_TIMEOUT");

  const crashed = booleanField(record, "crashed", "crash", "process_crashed") === true
    || code === "EXECUTION_CRASH"
    || status === "crash"
    || status === "crashed"
    || /(?:worker|process).*(?:exited|crashed)|(?:SIGTERM|SIGKILL|segmentation fault)|\bcrashed?\b/i.test(text);
  if (crashed) return makeClassification("execution_failed", provider, model, "EXECUTION_CRASH");
  if (typeof statusCode === "number" && statusCode >= 500) {
    return makeClassification("execution_failed", provider, model, "EXECUTION_ERROR");
  }

  const modelDefect = booleanField(record, "model_detected_defect", "modelDetectedDefect", "defect", "qa_failed") === true;
  if (code === "MODEL_DETECTED_DEFECT" || modelDefect) {
    return makeClassification("qa_failed", provider, model, "MODEL_DETECTED_DEFECT");
  }
  if (code === "MALFORMED_RESPONSE") {
    return makeClassification("invalid_result", provider, model, "MALFORMED_RESPONSE");
  }

  if (direct === "unavailable_optional" || direct === "unavailable"
    || status === "unavailable_optional" || status === "unavailable") {
    return makeClassification("unavailable_optional", provider, model, code ?? unavailableCode(text) ?? "OPTIONAL_UNAVAILABLE");
  }
  if (direct === "execution_failed" || direct === "execution_failure"
    || status === "execution_failed" || status === "execution_failure" || status === "error") {
    return makeClassification("execution_failed", provider, model, code ?? "EXECUTION_ERROR");
  }
  if (direct === "invalid_result" || direct === "invalid" || direct === "malformed"
    || status === "invalid_result" || status === "invalid" || status === "malformed") {
    return makeClassification("invalid_result", provider, model, "MALFORMED_RESPONSE");
  }
  if (direct === "qa_failed" || direct === "defect"
    || status === "qa_failed" || status === "defect") {
    return makeClassification("qa_failed", provider, model, "MODEL_DETECTED_DEFECT");
  }
  if (direct === "available" || direct === "verified" || direct === "passed" || direct === "pass") {
    return makeClassification("available", provider, model, null);
  }

  const defect = responseStatus === "qa_failed" || responseStatus === "failed" || responseStatus === "defect"
    || hasNonEmptyArray(record, "defects", "findings", "violations")
    || hasNonEmptyArray(responseRecord, "defects", "findings", "violations");
  if (status === "qa_failed" || status === "defect" || defect || hasNonEmptyArray(record, "defects")) {
    return makeClassification("qa_failed", provider, model, "MODEL_DETECTED_DEFECT");
  }

  const malformed = booleanField(record, "malformed", "malformed_response", "invalid_result") === true
    || /malformed|invalid\s+(?:json|response|result)|parse\s+(?:error|failed)/i.test(text);
  if (malformed) return makeClassification("invalid_result", provider, model, "MALFORMED_RESPONSE");

  const success = status === "available" || status === "verified" || status === "passed" || status === "pass" || status === "ok"
    || record.ok === true
    || responseStatus === "available" || responseStatus === "verified" || responseStatus === "passed" || responseStatus === "pass";
  if (success) {
    if (record.error !== undefined && record.error !== null) {
      return makeClassification("execution_failed", provider, model, code ?? "EXECUTION_ERROR");
    }
    if (response !== undefined && response !== null && !responseRecord && !Array.isArray(response)) {
      return makeClassification("invalid_result", provider, model, "MALFORMED_RESPONSE");
    }
    return makeClassification("available", provider, model, null);
  }

  if (record.error !== undefined || text.length > 0) {
    return makeClassification("execution_failed", provider, model, code ?? "EXECUTION_ERROR");
  }
  return makeClassification("invalid_result", provider, model, "MALFORMED_RESPONSE");
}

export const classifyOptionalVlmOutcome = classifyOptionalVlmResult;

function outcomeView(value: unknown): {
  classification: OptionalVlmClassification;
  provider: string;
  model: string;
  error_code: OptionalVlmErrorCode | null;
} | null {
  const record = asRecord(value);
  const outcome = asRecord(record?.outcome) ?? record;
  const classification = stringField(outcome, "classification") as OptionalVlmClassification | undefined;
  if (!classification || !["available", "unavailable_optional", "execution_failed", "invalid_result", "qa_failed"].includes(classification)) {
    return null;
  }
  const providerRecord = asRecord(record?.provider);
  const provider = stringField(providerRecord, "provider") ?? stringField(record, "provider") ?? DEFAULT_PROVIDER;
  const model = stringField(providerRecord, "model") ?? stringField(record, "model") ?? DEFAULT_MODEL;
  const errorCode = stringField(outcome, "error_code") as OptionalVlmErrorCode | undefined;
  return {
    classification,
    provider: sanitizeOptionalVlmIdentity(provider, DEFAULT_PROVIDER),
    model: sanitizeOptionalVlmIdentity(model, DEFAULT_MODEL),
    error_code: errorCode ?? null,
  };
}

export function sameOptionalUnavailableResult(left: unknown, right: unknown): boolean {
  const a = outcomeView(left);
  const b = outcomeView(right);
  return Boolean(a && b
    && a.classification === "unavailable_optional"
    && b.classification === "unavailable_optional"
    && a.provider === b.provider
    && a.model === b.model
    && a.error_code === b.error_code);
}

/** Return false for an identical unavailable result so the expensive call is not retried. */
export function shouldRetryOptionalVlm(previous: unknown, current?: unknown): boolean {
  if (current === undefined) {
    return outcomeView(previous)?.classification !== "unavailable_optional";
  }
  return !sameOptionalUnavailableResult(previous, current);
}

function qaCheck(value: unknown): OptionalVlmQaCheck {
  if (value === true) return "pass";
  if (value === false) return "fail";
  if (typeof value === "string") {
    const normalized = value.toLowerCase();
    if (["pass", "passed", "verified", "complete", "ok", "true"].includes(normalized)) return "pass";
    if (["fail", "failed", "blocked", "error", "false"].includes(normalized)) return "fail";
    return "pending";
  }
  const record = asRecord(value);
  if (!record) return "pending";
  const status = stringField(record, "status", "verdict")?.toLowerCase();
  const issues = Array.isArray(record.issues) ? record.issues : [];
  const detections = Array.isArray(record.detections) ? record.detections : [];
  if (issues.length > 0 || detections.length > 0) return "fail";
  if (status === "complete" || status === "verified" || status === "pass" || status === "passed" || status === "ok") return "pass";
  if (status === "blocked" || status === "failed" || status === "fail" || status === "error"
    || status === "blocker" || status === "blocking" || status === "fatal") return "fail";
  return "pending";
}

function qaOverall(checks: OptionalVlmQaCheck[]): "passed" | "pending" | "failed" {
  if (checks.includes("fail")) return "failed";
  return checks.every((check) => check === "pass") ? "passed" : "pending";
}

/** Derive the six deterministic close-readiness checks from the current receipts. */
export function deriveOptionalVlmDeterministicQA(value: unknown): OptionalVlmDeterministicQA | null {
  if (value === undefined || value === null) return null;
  const root = asRecord(value);
  if (!root) return {
    status: "pending",
    full_decode: "pending",
    black: "pending",
    freeze: "pending",
    inset: "pending",
    layout: "pending",
    caption: "pending",
  };

  const generation = asRecord(root.generation_receipt) ?? asRecord(root.generation) ?? root;
  const qa = asRecord(generation.qa) ?? asRecord(root.qa) ?? root;
  const output = asRecord(qa.output);
  const scans = asRecord(output?.scans) ?? asRecord(root.scans);
  const layout = qa.layout ?? root.layout;
  const reviewReceipt = asRecord(root.review_receipt) ?? asRecord(root.review);
  const gaps = asRecord(reviewReceipt?.gaps) ?? asRecord(root.gaps);
  const captions = asRecord(reviewReceipt?.captions) ?? asRecord(root.captions);

  let fullDecode = qaCheck(root.full_decode ?? root.fullDecode ?? scans?.decode ?? root.decode ?? gaps?.primary_video);
  const outputStatus = stringField(output, "status")?.toLowerCase();
  if (outputStatus && outputStatus !== "verified" && fullDecode === "pass") fullDecode = "fail";
  const black = qaCheck(root.black ?? scans?.black ?? gaps?.black);
  const freeze = qaCheck(root.freeze ?? scans?.freeze ?? gaps?.freeze);
  const inset = qaCheck(root.inset ?? root.layout_inset ?? scans?.layout_inset);
  const layoutCheck = qaCheck(layout);
  const caption = qaCheck(root.caption ?? root.caption_qa ?? captions?.collision_status);
  const checks = [fullDecode, black, freeze, inset, layoutCheck, caption];
  return {
    status: qaOverall(checks),
    full_decode: fullDecode,
    black,
    freeze,
    inset,
    layout: layoutCheck,
    caption,
  };
}

function pendingDeterministicQA(): OptionalVlmDeterministicQA {
  return {
    status: "pending",
    full_decode: "pending",
    black: "pending",
    freeze: "pending",
    inset: "pending",
    layout: "pending",
    caption: "pending",
  };
}

function resolveCapabilityDeclaration(profile: Record<string, unknown> | null): Record<string, unknown> | null {
  const capabilities = asRecord(profile?.capabilities);
  return asRecord(capabilities?.visual_model)
    ?? asRecord(capabilities?.visual_qa)
    ?? asRecord(profile?.capability)
    ?? asRecord(profile?.visual_model);
}

export function resolveOptionalVlmCapability(
  profile: OptionalVlmCapabilityProfile | ProfileDefinition | Record<string, unknown> | string,
  fallbackProfileId = "generic-editorial",
): OptionalVlmCapabilityProfile {
  const profileRecord = typeof profile === "string" ? null : asRecord(profile);
  const declaration = resolveCapabilityDeclaration(profileRecord);
  const profileId = typeof profile === "string"
    ? profile
    : stringField(profileRecord, "profile_id", "id") ?? fallbackProfileId;
  const requirement = declaration?.requirement === "required" ? "required" : "optional";
  return {
    profile_id: profileId,
    capability: {
      id: "visual_model",
      requirement,
      provider: sanitizeOptionalVlmIdentity(declaration?.provider, DEFAULT_PROVIDER),
      model: sanitizeOptionalVlmIdentity(declaration?.model, DEFAULT_MODEL),
    },
  };
}

export function loadProjectOptionalVlmCapability(
  projectDir: string,
  profileId?: string,
): OptionalVlmCapabilityProfile {
  const briefPath = path.join(path.resolve(projectDir), "01_intent/creative_brief.yaml");
  let briefEditorial: EditorialBriefFields | undefined;
  if (fs.existsSync(briefPath)) {
    try {
      const brief = asRecord(parseYaml(fs.readFileSync(briefPath, "utf8")));
      const editorial = asRecord(brief?.editorial);
      briefEditorial = (editorial ?? {}) as EditorialBriefFields;
    } catch {
      briefEditorial = undefined;
    }
  }
  const resolved = resolveProfileAndPolicy({ briefEditorial });
  const id = profileId ?? resolved.resolvedProfile.id ?? "generic-editorial";
  const profile = loadProfiles().get(id);
  return resolveOptionalVlmCapability(profile ?? id, id);
}

function normalizeHumanApproval(
  value: unknown,
  generation: OptionalVlmPolicyInput["generation"],
): OptionalVlmPolicyArtifact["human_approval"] {
  const record = asRecord(value);
  if (!record) return { status: "pending" };
  const status = stringField(record, "status", "state")?.toLowerCase();
  const decision = stringField(record, "decision")?.toLowerCase();
  if (status === "rejected" || decision === "request_changes" || decision === "free_text") {
    return { status: "rejected" };
  }
  if (status === "identity_mismatch") return { status: "identity_mismatch" };

  const providedGeneration = stringField(record, "generation_id");
  const providedVideo = stringField(record, "video_sha256", "video_hash");
  const providedTimeline = stringField(record, "timeline_sha256", "timeline_hash");
  if ((providedGeneration && providedGeneration !== generation.generation_id)
    || (providedVideo && providedVideo !== generation.video_sha256)
    || (providedTimeline && providedTimeline !== generation.timeline_sha256)) {
    return { status: "identity_mismatch" };
  }

  const isApproval = status === "approved" || status === "current" || decision === "approve";
  if (!isApproval) return { status: "pending" };
  if (providedGeneration !== generation.generation_id
    || providedVideo !== generation.video_sha256
    || providedTimeline !== generation.timeline_sha256) {
    return { status: "identity_mismatch" };
  }
  const actor = sanitizeOptionalVlmIdentity(
    stringField(record, "actor", "approved_by", "answered_by"),
    "human",
  );
  return {
    status: "approved",
    actor,
    generation_id: generation.generation_id,
    video_sha256: generation.video_sha256,
    timeline_sha256: generation.timeline_sha256,
  };
}

function retryProjection(
  previous: OptionalVlmPolicyArtifact | null | undefined,
  current: OptionalVlmClassificationResult,
): OptionalVlmPolicyArtifact["retry"] {
  if (current.classification !== "unavailable_optional") {
    return { same_unavailable_result: false, action: "not_applicable" };
  }
  if (!previous) return { same_unavailable_result: false, action: "not_applicable" };
  const same = sameOptionalUnavailableResult(previous, current);
  return {
    same_unavailable_result: same,
    action: same ? "not_retried" : "new_result",
  };
}

function policyStatus(
  classification: OptionalVlmClassification,
  requirement: OptionalVlmCapabilityRequirement,
  deterministic: OptionalVlmDeterministicQA | null,
  deterministicInputProvided: boolean,
  human: OptionalVlmPolicyArtifact["human_approval"],
): OptionalVlmPolicyStatus {
  if (classification === "execution_failed" || classification === "invalid_result" || classification === "qa_failed") {
    return classification;
  }
  if (!deterministicInputProvided) {
    return classification === "unavailable_optional" ? "optional_unavailable" : "deterministic_qa_pending";
  }
  if (!deterministic || deterministic.status === "pending") return "deterministic_qa_pending";
  if (deterministic.status === "failed") return "blocked";

  if (classification === "unavailable_optional") {
    if (requirement === "required") return "blocked";
    if (human.status === "approved") return "skipped_unavailable_optional";
    if (human.status === "pending") return "human_approval_pending";
    return "blocked";
  }
  return "available";
}

export function evaluateOptionalVlmPolicy(input: OptionalVlmPolicyInput): OptionalVlmPolicyArtifact {
  if (!input.project_id || !SHA256.test(input.generation.generation_id)
    || !SHA256.test(input.generation.video_sha256) || !SHA256.test(input.generation.timeline_sha256)) {
    throw new Error("optional VLM policy requires project and generation sha256 identities");
  }
  const profile = resolveOptionalVlmCapability(input.profile);
  const result = classifyOptionalVlmResult(input.result, profile.capability);
  const deterministicInputProvided = input.deterministic_qa !== undefined && input.deterministic_qa !== null;
  const deterministic = deterministicInputProvided
    ? deriveOptionalVlmDeterministicQA(input.deterministic_qa)
    : null;
  const deterministicArtifact = deterministic ?? pendingDeterministicQA();
  const human = normalizeHumanApproval(input.human_approval, input.generation);
  const artifact: OptionalVlmPolicyArtifact = {
    version: OPTIONAL_VLM_POLICY_VERSION,
    project_id: input.project_id,
    profile_id: profile.profile_id,
    capability: {
      id: "visual_model",
      requirement: profile.capability.requirement,
    },
    generation: input.generation,
    provider: {
      provider: result.provider,
      model: result.model,
    },
    outcome: {
      classification: result.classification,
      error_code: result.error_code,
      result_fingerprint: result.result_fingerprint,
    },
    deterministic_qa: deterministicArtifact,
    human_approval: human,
    status: policyStatus(
      result.classification,
      profile.capability.requirement,
      deterministic,
      deterministicInputProvided,
      human,
    ),
    retry: retryProjection(input.previous, result),
  };
  validateArtifact<OptionalVlmPolicyArtifact>(artifact, "optional-vlm-policy.schema.json");
  return artifact;
}

function deterministicPasses(qa: OptionalVlmPolicyArtifact["deterministic_qa"]): boolean {
  return qa.status === "passed"
    && qa.full_decode === "pass"
    && qa.black === "pass"
    && qa.freeze === "pass"
    && qa.inset === "pass"
    && qa.layout === "pass"
    && qa.caption === "pass";
}

export function hasCompleteOptionalVlmGateContext(
  context: OptionalVlmGateContext | undefined,
): context is Required<OptionalVlmGateContext> {
  return Boolean(
    context?.generation_id
    && context.video_sha256
    && context.timeline_sha256,
  );
}

function identityMatchesContext(policy: OptionalVlmPolicyArtifact, context: OptionalVlmGateContext): boolean {
  return hasCompleteOptionalVlmGateContext(context)
    && context.generation_id === policy.generation.generation_id
    && context.video_sha256 === policy.generation.video_sha256
    && context.timeline_sha256 === policy.generation.timeline_sha256;
}

export interface OptionalVlmVisualQAGateInput {
  status?: string;
  optional_vlm_classification?: OptionalVlmClassification;
  optional_vlm_error_code?: OptionalVlmErrorCode;
  video_hash?: string;
  timeline_hash?: string;
}

const OPTIONAL_UNAVAILABLE_ERROR_CODES = new Set<OptionalVlmErrorCode>([
  "HTTP_401",
  "HTTP_403",
  "GATED_REPOSITORY",
  "MODEL_CACHE_MISSING",
  "OPTIONAL_DEPENDENCY_MISSING",
  "OPTIONAL_UNAVAILABLE",
]);

/**
 * The only narrow substitution for a blocked visual QA report. All policy,
 * current-receipt, deterministic, and human-approval bindings remain in the
 * shared policy gate; this helper additionally binds the report's media
 * hashes and requires the real Marlin result to be optional-unavailable.
 */
export function canSubstituteBlockedOptionalVlmVisualQA(
  visual: OptionalVlmVisualQAGateInput | undefined,
  policy: OptionalVlmPolicyArtifact,
  context: OptionalVlmGateContext | undefined,
): boolean {
  return visual?.status === "blocked"
    && visual.optional_vlm_classification === "unavailable_optional"
    && visual.optional_vlm_error_code !== undefined
    && OPTIONAL_UNAVAILABLE_ERROR_CODES.has(visual.optional_vlm_error_code)
    && policy.outcome.classification === "unavailable_optional"
    && policy.status === "skipped_unavailable_optional"
    && hasCompleteOptionalVlmGateContext(context)
    && visual.video_hash === context.video_sha256
    && visual.timeline_hash === context.timeline_sha256
    && optionalVlmPolicyGateReason(policy, context) === null;
}

/** Return a fixed, user-facing gate reason; never interpolate provider errors. */
export function optionalVlmPolicyGateReason(
  policy: OptionalVlmPolicyArtifact,
  context: OptionalVlmGateContext = {},
): string | null {
  if (!hasCompleteOptionalVlmGateContext(context)) return "optional_vlm_policy current review-ready identity is missing";
  if (!identityMatchesContext(policy, context)) return "optional_vlm_policy identity is stale for the current generation";
  if (policy.outcome.classification === "qa_failed") return "optional_vlm_policy qa_failed cannot use an unavailable waiver";
  if (policy.outcome.classification === "execution_failed") return "optional_vlm_policy execution_failed is fail-closed";
  if (policy.outcome.classification === "invalid_result") return "optional_vlm_policy invalid_result is fail-closed";
  if (policy.outcome.classification === "unavailable_optional") {
    if (policy.capability.requirement !== "optional") return "required visual_model capability is unavailable";
    if (policy.status !== "skipped_unavailable_optional") return `optional_vlm_policy is ${policy.status}`;
    if (!deterministicPasses(policy.deterministic_qa)) return "optional_vlm_policy deterministic QA is incomplete";
    const human = policy.human_approval;
    if (human.status !== "approved"
      || human.generation_id !== policy.generation.generation_id
      || human.video_sha256 !== policy.generation.video_sha256
      || human.timeline_sha256 !== policy.generation.timeline_sha256) {
      return "optional_vlm_policy human approval is missing or identity-mismatched";
    }
    return null;
  }
  if (policy.outcome.classification === "available") {
    return policy.status === "available" && deterministicPasses(policy.deterministic_qa)
      ? null
      : `optional_vlm_policy is ${policy.status}`;
  }
  return "optional_vlm_policy is blocked";
}

export function checkOptionalVlmPolicyGate(
  policy: OptionalVlmPolicyArtifact,
  context: OptionalVlmGateContext = {},
): { passed: boolean; reason: string | null } {
  const reason = optionalVlmPolicyGateReason(policy, context);
  return { passed: reason === null, reason };
}

export function isOptionalVlmPolicyCloseable(
  policy: OptionalVlmPolicyArtifact,
  context: OptionalVlmGateContext = {},
): boolean {
  return checkOptionalVlmPolicyGate(policy, context).passed;
}

export function readOptionalVlmPolicy(projectDirInput: string): OptionalVlmPolicyArtifact | null {
  const projectDir = path.resolve(projectDirInput);
  const filePath = path.join(projectDir, OPTIONAL_VLM_POLICY_PATH);
  if (!fs.existsSync(filePath)) return null;
  const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
  return validateArtifact<OptionalVlmPolicyArtifact>(parsed, "optional-vlm-policy.schema.json");
}

export function writeOptionalVlmPolicy(
  projectDirInput: string,
  policy: OptionalVlmPolicyArtifact,
): string {
  validateArtifact<OptionalVlmPolicyArtifact>(policy, "optional-vlm-policy.schema.json");
  const projectDir = path.resolve(projectDirInput);
  const filePath = path.join(projectDir, OPTIONAL_VLM_POLICY_PATH);
  const bytes = `${JSON.stringify(policy, null, 2)}\n`;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  if (fs.existsSync(filePath) && fs.readFileSync(filePath, "utf8") === bytes) return filePath;
  const temporary = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(temporary, bytes, { encoding: "utf8", flag: "wx" });
  try {
    fs.renameSync(temporary, filePath);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
  return filePath;
}

export function inspectOptionalVlmPolicy(projectDirInput: string): OptionalVlmPolicyStatusSummary {
  const projectDir = path.resolve(projectDirInput);
  const filePath = path.join(projectDir, OPTIONAL_VLM_POLICY_PATH);
  if (!fs.existsSync(filePath)) {
    return { exists: false, path: OPTIONAL_VLM_POLICY_PATH, valid: true, status: "not_configured", closeable: false };
  }
  try {
    const policy = readOptionalVlmPolicy(projectDir);
    if (!policy) return { exists: false, path: OPTIONAL_VLM_POLICY_PATH, valid: true, status: "not_configured", closeable: false };
    const policySummary = {
      exists: true,
      path: OPTIONAL_VLM_POLICY_PATH,
      valid: true,
      status: policy.status,
      classification: policy.outcome.classification,
      requirement: policy.capability.requirement,
      profile_id: policy.profile_id,
      generation_id: policy.generation.generation_id,
      video_sha256: policy.generation.video_sha256,
      timeline_sha256: policy.generation.timeline_sha256,
      error_code: policy.outcome.error_code,
    };
    let current: Required<OptionalVlmGateContext>;
    try {
      current = readCurrentOptionalVlmGateContext(projectDir);
    } catch {
      return {
        ...policySummary,
        valid: false,
        status: "blocked",
        identity_status: "missing",
        closeable: false,
        error: "optional_vlm_policy_current_identity_unavailable",
      };
    }
    const matches = identityMatchesContext(policy, current);
    return {
      ...policySummary,
      valid: matches,
      status: matches ? policy.status : "blocked",
      current_generation_id: current.generation_id,
      current_video_sha256: current.video_sha256,
      current_timeline_sha256: current.timeline_sha256,
      identity_status: matches ? "current" : "mismatch",
      closeable: matches && isOptionalVlmPolicyCloseable(policy, current),
      ...(matches ? {} : { error: "optional_vlm_policy_identity_mismatch" }),
    };
  } catch {
    return {
      exists: true,
      path: OPTIONAL_VLM_POLICY_PATH,
      valid: false,
      status: "blocked",
      closeable: false,
      error: "optional_vlm_policy_invalid",
    };
  }
}

/** Read the fully bound identity of the current review-ready receipt. */
export function readCurrentOptionalVlmGateContext(
  projectDirInput: string,
): Required<OptionalVlmGateContext> {
  const current = verifyCurrentReviewReady(path.resolve(projectDirInput));
  const identity = current.receipt.identity;
  if (!SHA256.test(identity.generation_id)
    || !SHA256.test(identity.video_sha256)
    || !SHA256.test(identity.timeline_sha256)) {
    throw new Error("current review-ready identity is unavailable");
  }
  return {
    generation_id: identity.generation_id,
    video_sha256: identity.video_sha256,
    timeline_sha256: identity.timeline_sha256,
  };
}

function resolveBoundProjectFile(projectDir: string, relativePath: string, expectedHash: string): string {
  const root = fs.realpathSync(projectDir);
  if (!relativePath || path.isAbsolute(relativePath) || relativePath.split(/[\\/]/).includes("..")) {
    throw new Error("current review generation artifact path is invalid");
  }
  const lexical = path.resolve(root, relativePath);
  if (!lexical.startsWith(`${root}${path.sep}`)) throw new Error("current review generation artifact escapes project");
  const real = fs.realpathSync(lexical);
  if (!real.startsWith(`${root}${path.sep}`) || !fs.statSync(real).isFile() || sha256File(real) !== expectedHash) {
    throw new Error("current review generation artifact identity is invalid");
  }
  return real;
}

function readCurrentGenerationReceipt(
  projectDir: string,
  receipt: ReviewQaReceipt,
): SocialReviewGenerationReceipt {
  const bound = receipt.artifacts.generation_receipt;
  const filePath = resolveBoundProjectFile(projectDir, bound.path, bound.sha256);
  return validateArtifact<SocialReviewGenerationReceipt>(
    JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown,
    "social-review-generation-receipt.schema.json",
  );
}

function currentHumanApproval(
  projectDir: string,
  generation: OptionalVlmPolicyInput["generation"],
): unknown {
  const responsePath = path.join(projectDir, "06_review/review-response.json");
  if (!fs.existsSync(responsePath)) return undefined;
  try {
    const response = readCurrentReviewResponse(projectDir);
    return {
      status: response.status,
      decision: response.decision,
      generation_id: response.generation_id,
      video_sha256: response.video_sha256,
      timeline_sha256: response.timeline_sha256,
      approved_by: "user",
    };
  } catch {
    return { status: "identity_mismatch" };
  }
}

/** Public project route: verify current immutable review inputs, then persist only sanitized policy state. */
export function evaluateProjectOptionalVlmPolicy(
  projectDirInput: string,
  result?: unknown,
  profileId?: string,
): { artifact: OptionalVlmPolicyArtifact; path: string } {
  const projectDir = path.resolve(projectDirInput);
  const current = verifyCurrentReviewReady(projectDir);
  const generationReceipt = readCurrentGenerationReceipt(projectDir, current.receipt);
  if (generationReceipt.generation_id !== current.receipt.identity.generation_id
    || generationReceipt.output.sha256 !== current.receipt.identity.video_sha256) {
    throw new Error("current review generation identity differs from the review-ready receipt");
  }
  const generation = {
    generation_id: current.receipt.identity.generation_id,
    video_sha256: current.receipt.identity.video_sha256,
    timeline_sha256: current.receipt.identity.timeline_sha256,
  };
  const previous = readOptionalVlmPolicy(projectDir);
  const inputResult = result ?? (previous ? {
    classification: previous.outcome.classification,
    provider: previous.provider.provider,
    model: previous.provider.model,
    error_code: previous.outcome.error_code,
  } : undefined);
  if (inputResult === undefined) throw new Error("optional VLM result is required for the first policy evaluation");
  const artifact = evaluateOptionalVlmPolicy({
    project_id: current.receipt.project_id,
    profile: loadProjectOptionalVlmCapability(projectDir, profileId),
    generation,
    result: inputResult,
    deterministic_qa: { generation_receipt: generationReceipt, review_receipt: current.receipt },
    human_approval: currentHumanApproval(projectDir, generation),
    previous,
  });
  return { artifact, path: writeOptionalVlmPolicy(projectDir, artifact) };
}
