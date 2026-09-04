/**
 * Issue #73 M4a: Provider-neutral runtime coordinator.
 *
 * Coordinates deterministic M2 routing, private M2b request ledger lifecycle,
 * M1 connector invocation, M3a provider evidence normalization, M3b local
 * timestamp verification, and M3b disagreement routing for explicit operator
 * manual requests.
 *
 * Invariants:
 * - Deterministic M2 router is evaluated first.
 * - Non-agentic routes (local_only, static_vlm, blocked) perform 0 connector
 *   calls and 0 paid ledger writes.
 * - Agentic route reuses the existing private request ledger, preserving
 *   pre-submit release, post-submit unknown semantics, and duplicate prevention.
 * - Provider results normalize to strict M3a derived evidence artifacts; they
 *   never attain canonical trim or timeline authority.
 * - Local verification seam is invoked only with a verified local source.
 * - Disagreement routes to review_required with no provider winner and
 *   timeline_authority: "none".
 * - Canonical artifacts and timeline.json are never mutated.
 * - Outputs and summaries are strictly secret-free and path-redacted.
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  DEFAULT_MAX_INLINE_VIDEO_BYTES,
  createGeminiAgenticVideoConnector,
} from "./gemini-agentic-video.js";
import {
  lookupGeminiFileRegistry,
  type GeminiDerivativeSpecification,
  type GeminiProviderScope,
} from "./gemini-video-file-cache.js";
import {
  createVideoReasoningRequestLedger,
  type VideoReasoningLedgerDecision,
  type VideoReasoningLedgerDecisionKind,
  type VideoReasoningLedgerOutcome,
  type VideoReasoningLedgerStatus,
  type VideoReasoningRequestIdentityInput,
  type VideoReasoningRequestLedger,
} from "./video-reasoning-ledger.js";
import {
  decideVideoReasoningRoute,
  type VideoReasoningRouteBudget,
  type VideoReasoningRouteBudgetSnapshot,
  type VideoReasoningRouteDecision,
  type VideoReasoningRouteDecisionKind,
  type VideoReasoningRouteInput,
  type VideoReasoningRouteMarlinEvidence,
  type VideoReasoningRouteProviderCapability,
  type VideoReasoningRouteReasonCode,
  type VideoReasoningRouteReservation,
} from "./video-reasoning-router.js";
import {
  VIDEO_REASONING_CONTRACT_VERSION,
  VIDEO_REASONING_RESPONSE_SCHEMA_VERSION,
  computePromptHash,
  type VideoReasoningConnector,
  type VideoReasoningConnectorContext,
  type VideoReasoningErrorCode,
  type VideoReasoningInput,
  type VideoReasoningObservation,
  type VideoReasoningOutcome,
  type VideoReasoningPrivacy,
  type VideoReasoningRequest,
  type VideoReasoningResult,
  type VideoReasoningTask,
  type VideoReasoningUsage,
} from "./video-reasoning-types.js";
import {
  normalizeVideoReasoningEvidence,
  type VideoReasoningEvidenceArtifact,
  type VideoReasoningEvidenceOutcome,
} from "../analysis/video-reasoning-evidence.js";
import {
  verifyVideoReasoningLocally,
  type DenseFrameRunner,
  type LocalFrameAssessor,
  type VideoReasoningLocalExtractionStatus,
  type VideoReasoningLocalVerificationArtifact,
  type VideoReasoningLocalVerificationStatus,
  type VerifyVideoReasoningLocallyOptions,
} from "../analysis/video-reasoning-local-verification.js";
import {
  routeVideoReasoningDisagreement,
  type RouteVideoReasoningDisagreementInput,
  type RouteVideoReasoningDisagreementResult,
  type VideoReasoningDisagreementReasonCode,
  type VideoReasoningDisagreementSignal,
} from "../analysis/video-reasoning-disagreement-router.js";
import { sha256FileHex } from "../source-content-identity.js";

export const VIDEO_REASONING_COORDINATOR_VERSION = "video-reasoning-coordinator/v1" as const;
export const VIDEO_REASONING_COORDINATOR_SUMMARY_VERSION = "video-reasoning-coordinator-summary/v1" as const;

export interface VideoReasoningCoordinatorRequest {
  projectDir?: string;
  projectOptIn?: boolean;
  task?: VideoReasoningTask;
  model?: string;
  prompt: string;
  source: {
    assetId: string;
    sourceContentSha256: string;
    sourceDurationUs: number;
    submittedMediaContentSha256?: string;
    rangeUs?: readonly [number, number];
  };
  input?: VideoReasoningInput;
  registryLookup?: {
    registryKey?: string;
    provider?: string;
    derivativeSpec?: GeminiDerivativeSpecification;
    providerScope?: GeminiProviderScope;
  };
  privacy?: VideoReasoningPrivacy;
  consentCloudUpload?: boolean;
  budget?: {
    maxRequests?: number;
    maxInputBytes?: number;
    maxUploadedDurationUs?: number;
    timeoutMs?: number;
    maxInputTokens?: number;
    maxEstimatedUsd?: number;
    remainingRequests?: number;
    remainingUploadedDurationUs?: number;
    remainingUploadedBytes?: number;
    remainingInputTokens?: number;
    remainingEstimatedUsd?: number;
    estimatedInputTokens?: number;
    estimatedUsd?: number;
  };
  marlin?: VideoReasoningRouteMarlinEvidence;
  candidateConflict?: boolean;
  unresolvedUncertainty?: boolean;
  temporalReasoningRequired?: boolean;
  staticEvidenceSufficient?: boolean;
  editorialImpact?: "low" | "medium" | "high" | string;
  providerCapability?: VideoReasoningRouteProviderCapability;
  semanticReviewRequested?: boolean;
  localVerification?: {
    sourcePath?: string;
    framesPerObservation?: number;
    maxTotalFrames?: number;
    enabled?: boolean;
  };
}

export interface VideoReasoningCoordinatorDependencies {
  connector?: VideoReasoningConnector;
  ledger?: VideoReasoningRequestLedger;
  decideRoute?: (input: VideoReasoningRouteInput) => VideoReasoningRouteDecision;
  normalizeEvidence?: (
    request: VideoReasoningRequest,
    result: VideoReasoningResult,
  ) => VideoReasoningEvidenceArtifact;
  verifyLocally?: (
    provider: VideoReasoningEvidenceArtifact,
    options: VerifyVideoReasoningLocallyOptions,
  ) => Promise<VideoReasoningLocalVerificationArtifact>;
  routeDisagreement?: (
    input: RouteVideoReasoningDisagreementInput,
  ) => RouteVideoReasoningDisagreementResult;
  denseFrameRunner?: DenseFrameRunner;
  localFrameAssessor?: LocalFrameAssessor;
  now?: () => number | string | Date;
}

export type VideoReasoningCoordinatorLocalVerificationStatus =
  | VideoReasoningLocalVerificationStatus
  | "not_run"
  | "source_unavailable"
  | "source_mismatch"
  | "failed";

export interface VideoReasoningCoordinatorSummary {
  version: typeof VIDEO_REASONING_COORDINATOR_SUMMARY_VERSION;
  assetId: string;
  sourceContentSha256: string;
  promptHash: string;
  task: VideoReasoningTask;
  model: string;
  privacy: VideoReasoningPrivacy;
  route: {
    decision: VideoReasoningRouteDecisionKind;
    reasonCodes: readonly VideoReasoningRouteReasonCode[];
    budgetBefore?: VideoReasoningRouteBudgetSnapshot;
    budgetReservation?: VideoReasoningRouteReservation;
  };
  ledger: {
    decision: VideoReasoningLedgerDecisionKind | "not_reserved";
    action: string;
    allowed: boolean;
    requestId: string | null;
    status?: VideoReasoningLedgerStatus;
    outcome?: VideoReasoningLedgerOutcome;
    retryable?: boolean;
    reusable?: boolean;
  };
  execution?: {
    outcome: VideoReasoningOutcome;
    errorCode: VideoReasoningErrorCode | "normalization_failed";
    submitted: boolean;
    providerRequestId?: string;
    usage?: {
      inputTokens?: number;
      outputTokens?: number;
      totalTokens?: number;
    };
  };
  evidence?: {
    artifactId?: string;
    authority: "derived_evidence_only";
    outcome: VideoReasoningEvidenceOutcome;
    observationCount: number;
    reasons?: readonly string[];
  };
  localVerification?: {
    verificationStatus: VideoReasoningCoordinatorLocalVerificationStatus;
    recordCount: number;
    decodedFrameCount: number;
    failedFrameCount: number;
    rationaleCode?: string;
  };
  disagreement?: {
    decision: RouteVideoReasoningDisagreementResult["decision"] | "not_applicable";
    reviewRequired: boolean;
    materialDisagreement: boolean;
    reasonCodes: readonly VideoReasoningDisagreementReasonCode[];
    timelineAuthority: "none";
    selectedSource: null;
  };
}

export interface VideoReasoningCoordinatorResult {
  ok: boolean;
  outcome:
    | "completed"
    | "failed"
    | "rejected"
    | "unknown"
    | "routed_local"
    | "routed_static_vlm"
    | "blocked"
    | "ledger_blocked";
  summary: VideoReasoningCoordinatorSummary;
  routeDecision: VideoReasoningRouteDecision;
  ledgerDecision?: VideoReasoningLedgerDecision;
  evidenceArtifact?: VideoReasoningEvidenceArtifact;
  localVerificationArtifact?: VideoReasoningLocalVerificationArtifact;
  disagreementResult?: RouteVideoReasoningDisagreementResult;
}

const SHA256_PATTERN = /^[0-9a-f]{64}$/i;
const REGISTRY_KEY_PATTERN = /^sha256:[0-9a-f]{64}$/;
const ASSET_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;

function isExplicitProviderScope(
  value: GeminiProviderScope | undefined,
): value is { projectId: string; accountId: string } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return keys.length === 2 && keys.includes("projectId") && keys.includes("accountId") &&
    typeof value.projectId === "string" && value.projectId.trim().length > 0 &&
    typeof value.accountId === "string" && value.accountId.trim().length > 0 &&
    value.accountId.trim() !== "unspecified";
}

function localSignalStatus(
  record: VideoReasoningLocalVerificationArtifact["records"][number],
): VideoReasoningDisagreementSignal["status"] {
  if (record.frame_extraction_status === "unavailable") return "unavailable";
  if (record.outcome === "confirmed" || record.outcome === "adjusted") return "supports";
  if (record.outcome === "rejected") return "rejects";
  return "inconclusive";
}

function toLedgerUsage(usage?: VideoReasoningUsage): {
  inputTokens?: number;
  outputTokens?: number;
  thoughtTokens?: number;
  toolUseTokens?: number;
  totalTokens?: number;
} | undefined {
  if (!usage) return undefined;
  const ledgerUsage: {
    inputTokens?: number;
    outputTokens?: number;
    thoughtTokens?: number;
    toolUseTokens?: number;
    totalTokens?: number;
  } = {};
  if (usage.promptTokens !== undefined) ledgerUsage.inputTokens = usage.promptTokens;
  if (usage.completionTokens !== undefined) ledgerUsage.outputTokens = usage.completionTokens;
  if (usage.totalTokens !== undefined) ledgerUsage.totalTokens = usage.totalTokens;
  if (usage.totalThoughtTokens !== undefined) ledgerUsage.thoughtTokens = usage.totalThoughtTokens;
  if (usage.totalToolUseTokens !== undefined) ledgerUsage.toolUseTokens = usage.totalToolUseTokens;
  return Object.keys(ledgerUsage).length > 0 ? ledgerUsage : undefined;
}

/**
 * Coordinate a single-asset, single-query manual video reasoning request.
 */
export async function coordinateVideoReasoning(
  request: VideoReasoningCoordinatorRequest,
  deps: VideoReasoningCoordinatorDependencies = {},
): Promise<VideoReasoningCoordinatorResult> {
  const nowFn = deps.now ?? Date.now;
  const decideRoute = deps.decideRoute ?? decideVideoReasoningRoute;
  const normalizeEvidence = deps.normalizeEvidence ?? normalizeVideoReasoningEvidence;
  const verifyLocally = deps.verifyLocally ?? verifyVideoReasoningLocally;
  const routeDisagreement = deps.routeDisagreement ?? routeVideoReasoningDisagreement;

  const projectDir = request.projectDir ?? ".";
  const task = request.task ?? "needle_search";
  const model = request.model ?? "gemini-3.7-flash";
  const privacy: VideoReasoningPrivacy = request.privacy ?? "local_only";
  const promptHash = computePromptHash(request.prompt ?? "");

  const sourceContentSha256 = (request.source.sourceContentSha256 ?? "").toLowerCase();
  const submittedMediaContentSha256 = (request.source.submittedMediaContentSha256 ?? sourceContentSha256).toLowerCase();
  const sourceDurationUs = request.source.sourceDurationUs;
  const rangeUs = request.source.rangeUs;

  const effectiveDurationUs = rangeUs !== undefined
    ? Math.max(1, rangeUs[1] - rangeUs[0])
    : sourceDurationUs;

  const identityValid =
    ASSET_ID_PATTERN.test(request.source.assetId) &&
    SHA256_PATTERN.test(sourceContentSha256) &&
    sourceDurationUs > 0 &&
    Number.isSafeInteger(sourceDurationUs);

  const submittedDistinct = submittedMediaContentSha256 !== sourceContentSha256;

  // Gate A: Project-scoped policy opt-in
  // Gate B: Operator manual action
  // Both are required for cloud reasoning.
  const projectOptIn = request.projectOptIn === true;
  const operatorConsent = request.consentCloudUpload === true;
  let routeConsentApproved = projectOptIn && operatorConsent && privacy !== "local_only";

  // Provider URI resolution via Private Gemini File Registry (no raw unverified URI)
  let resolvedProviderUri: string | null = null;
  if (request.input?.kind === "provider_uri" || request.registryLookup) {
    const registryLookup = request.registryLookup;
    const derivativeSpec = registryLookup?.derivativeSpec;
    const providerScope = registryLookup?.providerScope;
    const registryMimeType = request.input?.mimeType ?? "";
    const registryRequestValid =
      request.input?.kind === "provider_uri" &&
      request.input.uri.trim().length === 0 &&
      registryLookup?.provider === "gemini" &&
      typeof registryLookup.registryKey === "string" &&
      REGISTRY_KEY_PATTERN.test(registryLookup.registryKey) &&
      isExplicitProviderScope(providerScope) &&
      (privacy === "bounded_derivative"
        ? derivativeSpec !== undefined && derivativeSpec !== null && submittedDistinct
        : privacy === "source_allowed"
          ? derivativeSpec === null && !submittedDistinct
          : false);

    if (registryRequestValid) {
      const lookup = lookupGeminiFileRegistry(
        projectDir,
        {
          sourceContentSha256,
          submittedMediaContentSha256,
          derivative: derivativeSpec,
          mimeType: registryMimeType,
          providerScope,
        },
        { now: nowFn },
      );

      if (
        lookup.decision === "reuse" &&
        lookup.registryKey === registryLookup.registryKey &&
        lookup.entry?.registryKey === registryLookup.registryKey &&
        lookup.entry.providerUri &&
        lookup.entry.status === "ready" &&
        lookup.entry.sourceContentSha256 === sourceContentSha256 &&
        lookup.entry.submittedMediaContentSha256 === submittedMediaContentSha256
      ) {
        resolvedProviderUri = lookup.entry.providerUri;
      }
    }

    if (!resolvedProviderUri) routeConsentApproved = false;
  }

  // 1. Build deterministic M2 route input
  const routeBudget: VideoReasoningRouteBudget = {
    remainingRequests: request.budget?.remainingRequests ?? (request.budget?.maxRequests ?? 1),
    remainingUploadedDurationUs: request.budget?.remainingUploadedDurationUs ?? (request.budget?.maxUploadedDurationUs ?? effectiveDurationUs),
    remainingUploadedBytes: request.budget?.remainingUploadedBytes ?? (request.budget?.maxInputBytes ?? DEFAULT_MAX_INLINE_VIDEO_BYTES),
    ...(request.budget?.remainingInputTokens !== undefined ? { remainingInputTokens: request.budget.remainingInputTokens } : {}),
    ...(request.budget?.remainingEstimatedUsd !== undefined ? { remainingEstimatedUsd: request.budget.remainingEstimatedUsd } : {}),
    ...(request.budget?.estimatedInputTokens !== undefined ? { estimatedInputTokens: request.budget.estimatedInputTokens } : {}),
    ...(request.budget?.estimatedUsd !== undefined ? { estimatedUsd: request.budget.estimatedUsd } : {}),
  };

  // Fail-closed defaults: Omitted Marlin or providerCapability must NOT be assumed healthy/available!
  const marlinEvidence: VideoReasoningRouteMarlinEvidence = request.marlin ?? {
    available: false,
    confidence: 0,
    coverage: 0,
    degraded: false,
  };

  const providerCapability: VideoReasoningRouteProviderCapability = request.providerCapability ?? {
    staticVlmAvailable: false,
    agenticAvailable: false,
    agenticModelSupported: false,
  };

  const routeInput: VideoReasoningRouteInput = {
    task,
    privacy,
    consent: {
      approved: routeConsentApproved,
      ...(privacy !== "local_only" ? { scope: privacy } : {}),
    },
    source: {
      identityValid,
      durationUs: sourceDurationUs,
      ...(rangeUs !== undefined ? { rangeUs } : {}),
      submittedMediaIdentityDistinct: submittedDistinct,
      estimatedUploadDurationUs: effectiveDurationUs,
      estimatedUploadBytes: request.budget?.maxInputBytes ?? DEFAULT_MAX_INLINE_VIDEO_BYTES,
    },
    marlin: marlinEvidence,
    candidateConflict: request.candidateConflict ?? false,
    unresolvedUncertainty: request.unresolvedUncertainty ?? false,
    temporalReasoningRequired: request.temporalReasoningRequired ?? false,
    staticEvidenceSufficient: request.staticEvidenceSufficient ?? false,
    editorialImpact: request.editorialImpact ?? "low",
    providerCapability,
    budget: routeBudget,
    ...(request.semanticReviewRequested !== undefined ? { semanticReviewRequested: request.semanticReviewRequested } : {}),
  };

  // Step 1: Run deterministic M2 router
  const routeDecision = decideRoute(routeInput);

  // If the decision is NOT agentic: connector call = 0, paid ledger consumption = 0.
  if (routeDecision.decision !== "agentic") {
    const outcomeCode =
      routeDecision.decision === "local"
        ? "routed_local"
        : routeDecision.decision === "static_vlm"
          ? "routed_static_vlm"
          : "blocked";

    const summary: VideoReasoningCoordinatorSummary = {
      version: VIDEO_REASONING_COORDINATOR_SUMMARY_VERSION,
      assetId: request.source.assetId,
      sourceContentSha256,
      promptHash,
      task,
      model,
      privacy,
      route: {
        decision: routeDecision.decision,
        reasonCodes: routeDecision.reasonCodes,
        budgetBefore: routeDecision.budget.before,
        budgetReservation: routeDecision.budget.reservation,
      },
      ledger: {
        decision: "not_reserved",
        action: "none",
        allowed: false,
        requestId: null,
      },
      localVerification: {
        verificationStatus: "not_run",
        recordCount: 0,
        decodedFrameCount: 0,
        failedFrameCount: 0,
      },
      disagreement: {
        decision: "not_applicable",
        reviewRequired: false,
        materialDisagreement: false,
        reasonCodes: [],
        timelineAuthority: "none",
        selectedSource: null,
      },
    };

    return {
      ok: routeDecision.decision === "local" && privacy === "local_only",
      outcome: outcomeCode,
      summary,
      routeDecision,
    };
  }

  // Step 2: Agentic route selected. Check / reserve in private request ledger.
  const effectiveRangeUs: readonly [number, number] =
    routeDecision.sourceRangeUs ?? [0, sourceDurationUs];

  const ledger = deps.ledger ?? createVideoReasoningRequestLedger(projectDir, { now: nowFn });
  const requestIdentity: VideoReasoningRequestIdentityInput = {
    sourceContentSha256,
    effectiveSourceRangeUs: effectiveRangeUs,
    modelAliasOrSnapshot: model,
    processingMode: "agentic",
    normalizedPromptHash: promptHash,
    promptContractVersion: VIDEO_REASONING_CONTRACT_VERSION,
    outputSchemaVersion: VIDEO_REASONING_RESPONSE_SCHEMA_VERSION,
  };

  const reserveDecision = ledger.reserve(requestIdentity);

  if (!reserveDecision.allowed) {
    const summary: VideoReasoningCoordinatorSummary = {
      version: VIDEO_REASONING_COORDINATOR_SUMMARY_VERSION,
      assetId: request.source.assetId,
      sourceContentSha256,
      promptHash,
      task,
      model,
      privacy,
      route: {
        decision: routeDecision.decision,
        reasonCodes: routeDecision.reasonCodes,
        budgetBefore: routeDecision.budget.before,
        budgetReservation: routeDecision.budget.reservation,
      },
      ledger: {
        decision: reserveDecision.decision,
        action: reserveDecision.action,
        allowed: false,
        requestId: reserveDecision.requestId,
        status: reserveDecision.entry?.status,
        outcome: reserveDecision.entry?.outcome,
        retryable: reserveDecision.entry?.retryable,
        reusable: reserveDecision.entry?.reusable,
      },
      localVerification: {
        verificationStatus: "not_run",
        recordCount: 0,
        decodedFrameCount: 0,
        failedFrameCount: 0,
      },
      disagreement: {
        decision: "not_applicable",
        reviewRequired: false,
        materialDisagreement: false,
        reasonCodes: [],
        timelineAuthority: "none",
        selectedSource: null,
      },
    };

    return {
      ok: false,
      outcome: "ledger_blocked",
      summary,
      routeDecision,
      ledgerDecision: reserveDecision,
    };
  }

  const requestId = reserveDecision.requestId!;

  // Step 3: Invoke provider connector with narrow two-stage submitted seam (M1)
  const connector = deps.connector ?? createGeminiAgenticVideoConnector({ now: () => {
    const raw = nowFn();
    return raw instanceof Date ? raw.getTime() : typeof raw === "string" ? new Date(raw).getTime() : raw;
  } });

  const effectiveInput: VideoReasoningInput = resolvedProviderUri !== null
    ? { kind: "provider_uri", uri: resolvedProviderUri, mimeType: request.input?.mimeType ?? "video/mp4" }
    : (request.input ?? {
        kind: "inline",
        path: request.localVerification?.sourcePath ?? "",
        mimeType: "video/mp4",
      });

  const connectorRequest: VideoReasoningRequest = {
    task,
    model,
    prompt: request.prompt,
    source: {
      assetId: request.source.assetId,
      sourceContentSha256,
      submittedMediaContentSha256,
      sourceDurationUs,
      ...(rangeUs !== undefined ? { rangeUs } : {}),
    },
    input: effectiveInput,
    privacy,
    consent: {
      approved: true,
      scope: privacy as Exclude<VideoReasoningPrivacy, "local_only">,
    },
    budget: {
      maxRequests: request.budget?.maxRequests ?? 1,
      maxInputBytes: request.budget?.maxInputBytes ?? DEFAULT_MAX_INLINE_VIDEO_BYTES,
      maxUploadedDurationUs: request.budget?.maxUploadedDurationUs,
      timeoutMs: request.budget?.timeoutMs,
      maxInputTokens: request.budget?.maxInputTokens,
      maxEstimatedUsd: request.budget?.maxEstimatedUsd,
    },
  };

  let submittedToTransport = false;
  let ledgerTransitionDecision: VideoReasoningLedgerDecision = reserveDecision;
  const connectorContext: VideoReasoningConnectorContext = {
    onBeforeSubmit: async () => {
      // Transition ledger to submitted BEFORE network transport begins.
      const subDecision = ledger.recordSubmitted(requestId);
      ledgerTransitionDecision = subDecision;
      if (subDecision.decision !== "submitted" || subDecision.allowed !== true) {
        throw new Error("ledger_submitted_transition_failed");
      }
      submittedToTransport = true;
    },
  };

  let connectorResult: VideoReasoningResult;

  try {
    connectorResult = await connector(connectorRequest, connectorContext);
  } catch {
    if (!submittedToTransport) {
      // The transport did not run, so use the existing ledger release
      // transition. Its returned decision remains the only persisted truth.
      ledgerTransitionDecision = ledger.releaseBeforeSubmit(requestId, "pre_submit_error");

      const summary: VideoReasoningCoordinatorSummary = {
        version: VIDEO_REASONING_COORDINATOR_SUMMARY_VERSION,
        assetId: request.source.assetId,
        sourceContentSha256,
        promptHash,
        task,
        model,
        privacy,
        route: {
          decision: routeDecision.decision,
          reasonCodes: routeDecision.reasonCodes,
          budgetBefore: routeDecision.budget.before,
          budgetReservation: routeDecision.budget.reservation,
        },
        ledger: {
          decision: ledgerTransitionDecision.decision,
          action: ledgerTransitionDecision.action,
          allowed: false,
          requestId,
          status: ledgerTransitionDecision.entry?.status,
          outcome: ledgerTransitionDecision.entry?.outcome,
          retryable: ledgerTransitionDecision.entry?.retryable,
          reusable: ledgerTransitionDecision.entry?.reusable,
        },
        execution: {
          outcome: "rejected",
          errorCode: "pre_submit_error",
          submitted: false,
        },
        localVerification: {
          verificationStatus: "not_run",
          recordCount: 0,
          decodedFrameCount: 0,
          failedFrameCount: 0,
        },
        disagreement: {
          decision: "not_applicable",
          reviewRequired: false,
          materialDisagreement: false,
          reasonCodes: [],
          timelineAuthority: "none",
          selectedSource: null,
        },
      };

      return {
        ok: false,
        outcome: "rejected",
        summary,
        routeDecision,
        ledgerDecision: ledgerTransitionDecision,
      };
    } else {
      // Post-submit transport failure: record unknown and retain active reservation!
      ledgerTransitionDecision = ledger.recordUnknownPostSubmit(requestId);

      const summary: VideoReasoningCoordinatorSummary = {
        version: VIDEO_REASONING_COORDINATOR_SUMMARY_VERSION,
        assetId: request.source.assetId,
        sourceContentSha256,
        promptHash,
        task,
        model,
        privacy,
        route: {
          decision: routeDecision.decision,
          reasonCodes: routeDecision.reasonCodes,
          budgetBefore: routeDecision.budget.before,
          budgetReservation: routeDecision.budget.reservation,
        },
        ledger: {
          decision: ledgerTransitionDecision.decision,
          action: ledgerTransitionDecision.action,
          allowed: false,
          requestId,
          status: "unknown",
          outcome: "unknown",
          retryable: false,
          reusable: false,
        },
        execution: {
          outcome: "unknown",
          errorCode: "transport_error_unknown",
          submitted: true,
        },
        localVerification: {
          verificationStatus: "not_run",
          recordCount: 0,
          decodedFrameCount: 0,
          failedFrameCount: 0,
        },
        disagreement: {
          decision: "not_applicable",
          reviewRequired: false,
          materialDisagreement: false,
          reasonCodes: [],
          timelineAuthority: "none",
          selectedSource: null,
        },
      };

      return {
        ok: false,
        outcome: "unknown",
        summary,
        routeDecision,
        ledgerDecision: ledgerTransitionDecision,
      };
    }
  }

  // Step 4: Evidence Normalization (M3a) - No False Success
  let evidenceArtifact: VideoReasoningEvidenceArtifact | undefined;
  let normalizationFailed = false;

  if (connectorResult.outcome === "completed") {
    try {
      evidenceArtifact = normalizeEvidence(connectorRequest, connectorResult);
      if (!evidenceArtifact || evidenceArtifact.outcome === "failed") {
        normalizationFailed = true;
        evidenceArtifact = undefined;
      }
    } catch {
      normalizationFailed = true;
      evidenceArtifact = undefined;
    }
  }

  // Update ledger based on connector outcome & normalization truth
  const submitted = connectorResult.diagnostic.submitted || submittedToTransport;
  const providerRequestId = connectorResult.diagnostic.providerRequestId;
  const errorCode = connectorResult.diagnostic.errorCode;
  const usage = connectorResult.diagnostic.usage;
  const ledgerUsage = toLedgerUsage(usage);

  if (!submitted) {
    ledgerTransitionDecision = ledger.releaseBeforeSubmit(requestId, errorCode);
  } else {
    // Ensure submitted transition is recorded if connector set submitted directly
    if (!submittedToTransport) {
      ledger.recordSubmitted(requestId, {
        ...(providerRequestId ? { providerRequestId } : {}),
      });
    }

    if (normalizationFailed) {
      // Truthful post-submit failure! Never reusable, never fake resultId!
      ledgerTransitionDecision = ledger.fail(requestId, "normalization_failed", {
        ...(providerRequestId ? { providerRequestId } : {}),
        ...(ledgerUsage ? { usage: ledgerUsage } : {}),
      });
    } else if (connectorResult.outcome === "completed" && evidenceArtifact) {
      ledgerTransitionDecision = ledger.complete(requestId, {
        ...(providerRequestId ? { providerRequestId } : {}),
        ...(ledgerUsage ? { usage: ledgerUsage } : {}),
        resultId: evidenceArtifact.artifact_id,
        reusable: true,
      });
    } else if (connectorResult.outcome === "failed") {
      ledgerTransitionDecision = ledger.fail(requestId, errorCode, {
        ...(providerRequestId ? { providerRequestId } : {}),
        ...(ledgerUsage ? { usage: ledgerUsage } : {}),
      });
    } else {
      ledgerTransitionDecision = ledger.recordUnknownPostSubmit(requestId);
    }
  }

  // Step 5: Local Timestamp Verification (M3b narrow seam)
  // Local source path is strictly separated from upload derivative
  let localVerificationArtifact: VideoReasoningLocalVerificationArtifact | undefined;
  let localVerificationStatus: VideoReasoningCoordinatorLocalVerificationStatus = "not_run";
  let localVerificationRationale: string | undefined;

  const localSourcePath = request.localVerification?.sourcePath;
  const localVerificationEnabled = request.localVerification?.enabled ?? Boolean(localSourcePath);

  if (localVerificationEnabled && localSourcePath) {
    if (!fs.existsSync(localSourcePath)) {
      localVerificationStatus = "source_unavailable";
      localVerificationRationale = "source_file_missing";
    } else {
      let sourceHash: string;
      try {
        sourceHash = sha256FileHex(localSourcePath);
      } catch {
        sourceHash = "";
      }
      if (sourceHash.toLowerCase() !== sourceContentSha256) {
        localVerificationStatus = "source_mismatch";
        localVerificationRationale = "source_hash_mismatch";
      } else if (evidenceArtifact && evidenceArtifact.observations.length > 0) {
        try {
          localVerificationArtifact = await verifyLocally(evidenceArtifact, {
            sourcePath: localSourcePath,
            framesPerObservation: request.localVerification?.framesPerObservation,
            maxTotalFrames: request.localVerification?.maxTotalFrames,
            runner: deps.denseFrameRunner,
            assessor: deps.localFrameAssessor,
          });
          localVerificationStatus = localVerificationArtifact.verification_status;
        } catch {
          localVerificationStatus = "failed";
          localVerificationRationale = "verification_execution_error";
        }
      }
    }
  }

  // Step 6: Disagreement Routing (M3b)
  let disagreementResult: RouteVideoReasoningDisagreementResult | undefined;
  if (evidenceArtifact && evidenceArtifact.observations.length > 0) {
    const disagreementInput: RouteVideoReasoningDisagreementInput = {
      source: {
        asset_id: request.source.assetId,
        source_content_sha256: sourceContentSha256,
        source_duration_us: sourceDurationUs,
        effective_source_range_us: effectiveRangeUs,
      },
      signals: [
        ...evidenceArtifact.observations.map((obs) => ({
          source: "provider" as const,
          claim_id: obs.observation_id,
          status: "supports" as const,
          asset_id: request.source.assetId,
          source_content_sha256: sourceContentSha256,
          range_us: obs.provider_range_us,
        })),
        ...(localVerificationArtifact?.records.map((rec) => ({
          source: "local" as const,
          claim_id: rec.provider_observation_id,
          status: localSignalStatus(rec),
          asset_id: request.source.assetId,
          source_content_sha256: sourceContentSha256,
          ...(rec.local_verified_range_us ? { range_us: rec.local_verified_range_us } : {}),
        })) ?? (
          localVerificationStatus === "source_unavailable" || localVerificationStatus === "source_mismatch"
            ? evidenceArtifact.observations.map((obs) => ({
                source: "local" as const,
                claim_id: obs.observation_id,
                status: "unavailable" as const,
                asset_id: request.source.assetId,
                source_content_sha256: sourceContentSha256,
              }))
            : []
        )),
      ],
    };
    disagreementResult = routeDisagreement(disagreementInput);
  }

  // Determine final truthful outcome
  const finalOutcome: VideoReasoningCoordinatorResult["outcome"] =
    normalizationFailed
      ? "failed"
      : connectorResult.outcome;

  const ok = finalOutcome === "completed" && evidenceArtifact !== undefined;

  const summary: VideoReasoningCoordinatorSummary = {
    version: VIDEO_REASONING_COORDINATOR_SUMMARY_VERSION,
    assetId: request.source.assetId,
    sourceContentSha256,
    promptHash,
    task,
    model,
    privacy,
    route: {
      decision: routeDecision.decision,
      reasonCodes: routeDecision.reasonCodes,
      budgetBefore: routeDecision.budget.before,
      budgetReservation: routeDecision.budget.reservation,
    },
    ledger: {
      decision: ledgerTransitionDecision.decision,
      action: ledgerTransitionDecision.action,
      allowed: ledgerTransitionDecision.allowed,
      requestId,
      status: ledgerTransitionDecision.entry?.status,
      outcome: ledgerTransitionDecision.entry?.outcome,
      retryable: ledgerTransitionDecision.entry?.retryable,
      reusable: ledgerTransitionDecision.entry?.reusable,
    },
    execution: {
      outcome: finalOutcome,
      errorCode: normalizationFailed ? "normalization_failed" : errorCode,
      submitted,
      ...(providerRequestId ? { providerRequestId } : {}),
      ...(usage ? { usage: {
        inputTokens: usage.promptTokens,
        outputTokens: usage.completionTokens,
        totalTokens: usage.totalTokens,
      } } : {}),
    },
    ...(evidenceArtifact ? {
      evidence: {
        artifactId: evidenceArtifact.artifact_id,
        authority: "derived_evidence_only",
        outcome: evidenceArtifact.outcome,
        observationCount: evidenceArtifact.observations.length,
      },
    } : {}),
    localVerification: {
      verificationStatus: localVerificationStatus,
      recordCount: localVerificationArtifact?.records.length ?? 0,
      decodedFrameCount: localVerificationArtifact?.extraction.decoded_frame_count ?? 0,
      failedFrameCount: localVerificationArtifact?.extraction.failed_frame_count ?? 0,
      ...(localVerificationRationale ? { rationaleCode: localVerificationRationale } : {}),
    },
    disagreement: disagreementResult ? {
      decision: disagreementResult.decision,
      reviewRequired: disagreementResult.review_required,
      materialDisagreement: disagreementResult.material_disagreement,
      reasonCodes: disagreementResult.reason_codes,
      timelineAuthority: "none",
      selectedSource: null,
    } : {
      decision: "not_applicable",
      reviewRequired: false,
      materialDisagreement: false,
      reasonCodes: [],
      timelineAuthority: "none",
      selectedSource: null,
    },
  };

  return {
    ok,
    outcome: finalOutcome,
    summary,
    routeDecision,
    ledgerDecision: ledgerTransitionDecision,
    ...(evidenceArtifact ? { evidenceArtifact } : {}),
    ...(localVerificationArtifact ? { localVerificationArtifact } : {}),
    ...(disagreementResult ? { disagreementResult } : {}),
  };
}
