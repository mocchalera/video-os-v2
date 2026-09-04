/**
 * Pure M3b disagreement routing.
 *
 * The router only returns inspectable uncertainty. It does not choose a
 * provider, alter a timeline, read media, or perform review/pipeline work.
 */

import type { JudgmentUncertainty, SourceEvidenceRef } from "../commands/review/index.js";

const MAX_SAFE_US = Number.MAX_SAFE_INTEGER;
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const ASSET_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const CLAIM_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const DEFAULT_RANGE_TOLERANCE_US = 500_000;
const SIGNAL_STATUSES = ["supports", "rejects", "inconclusive", "unavailable"] as const;

export const VIDEO_REASONING_DISAGREEMENT_SOURCES = [
  "provider",
  "local",
  "marlin",
  "static_vlm",
  "transcript",
  "audio",
] as const;

export type VideoReasoningDisagreementSource = typeof VIDEO_REASONING_DISAGREEMENT_SOURCES[number];
export type VideoReasoningDisagreementSignalStatus = typeof SIGNAL_STATUSES[number];
export type VideoReasoningDisagreementReasonCode =
  | "material_claim_disagreement"
  | "material_range_disagreement"
  | "duplicate_source_claim"
  | "intra_source_claim_disagreement"
  | "intra_source_range_disagreement"
  | "local_verification_inconclusive"
  | "local_verification_rejected"
  | "local_verification_unavailable"
  | "local_verification_missing"
  | "evidence_identity_mismatch"
  | "evidence_range_invalid";

export interface VideoReasoningDisagreementSourceIdentity {
  asset_id: string;
  source_content_sha256: string;
  source_duration_us: number;
  effective_source_range_us: readonly [number, number];
}

export interface VideoReasoningDisagreementSignal {
  source: VideoReasoningDisagreementSource;
  claim_id: string;
  status: VideoReasoningDisagreementSignalStatus;
  asset_id: string;
  source_content_sha256: string;
  range_us?: readonly [number, number];
}

export interface RouteVideoReasoningDisagreementInput {
  source: VideoReasoningDisagreementSourceIdentity;
  signals: readonly VideoReasoningDisagreementSignal[];
  material_range_tolerance_us?: number;
}

export interface RouteVideoReasoningDisagreementResult {
  decision: "no_disagreement" | "review_required";
  review_required: boolean;
  material_disagreement: boolean;
  reason_codes: readonly VideoReasoningDisagreementReasonCode[];
  contributing_sources: readonly VideoReasoningDisagreementSource[];
  selected_source: null;
  authority: "derived_evidence_only";
  timeline_authority: "none";
  confidence: number;
  confidence_basis: "degraded" | "unmeasured";
  evidence: SourceEvidenceRef[];
  uncertainty: JudgmentUncertainty | null;
}

function validRange(value: unknown, durationUs: number): value is readonly [number, number] {
  return Array.isArray(value) && value.length === 2 &&
    typeof value[0] === "number" && Number.isSafeInteger(value[0]) && value[0] >= 0 && value[0] <= MAX_SAFE_US &&
    typeof value[1] === "number" && Number.isSafeInteger(value[1]) && value[1] > value[0] && value[1] <= durationUs;
}

function sourceOrder(source: VideoReasoningDisagreementSource): number {
  return VIDEO_REASONING_DISAGREEMENT_SOURCES.indexOf(source);
}

function isSource(value: unknown): value is VideoReasoningDisagreementSource {
  return (VIDEO_REASONING_DISAGREEMENT_SOURCES as readonly string[]).includes(String(value));
}

function sourceRef(signal: VideoReasoningDisagreementSignal): SourceEvidenceRef {
  return {
    kind: "artifact_ref",
    ref: `video-reasoning:${signal.source}:${signal.claim_id}`,
    sha256: signal.source_content_sha256,
  };
}

function materiallyDifferentRanges(
  left: readonly [number, number],
  right: readonly [number, number],
  toleranceUs: number,
): boolean {
  return Math.abs(left[0] - right[0]) > toleranceUs || Math.abs(left[1] - right[1]) > toleranceUs;
}

function result(
  reviewRequired: boolean,
  reasonCodes: readonly VideoReasoningDisagreementReasonCode[],
  sources: readonly VideoReasoningDisagreementSource[],
  signals: readonly VideoReasoningDisagreementSignal[],
): RouteVideoReasoningDisagreementResult {
  const orderedSources = [...new Set(sources)].sort((left, right) => sourceOrder(left) - sourceOrder(right));
  const evidence = signals
    .filter((signal) => orderedSources.includes(signal.source))
    .sort((left, right) => sourceOrder(left.source) - sourceOrder(right.source) || left.claim_id.localeCompare(right.claim_id))
    .map(sourceRef);
  const uniqueEvidence = evidence.filter((ref, index, all) => index === all.findIndex((candidate) => candidate.ref === ref.ref));
  return {
    decision: reviewRequired ? "review_required" : "no_disagreement",
    review_required: reviewRequired,
    material_disagreement: reasonCodes.some((reason) => [
      "material_claim_disagreement",
      "material_range_disagreement",
      "intra_source_claim_disagreement",
      "intra_source_range_disagreement",
    ].includes(reason)),
    reason_codes: [...new Set(reasonCodes)],
    contributing_sources: orderedSources,
    selected_source: null,
    authority: "derived_evidence_only",
    timeline_authority: "none",
    confidence: reviewRequired ? 0 : 0.5,
    confidence_basis: reviewRequired ? "unmeasured" : "degraded",
    evidence: uniqueEvidence,
    uncertainty: reviewRequired
      ? {
        description: "video_reasoning_material_disagreement",
        impact: "high",
        clarification_question: {
          question: "Which source-bound moment should an editor confirm for this candidate?",
          observation: `Derived evidence differs across ${orderedSources.join(", ") || "the available sources"}.`,
          hypothesis: "No provider or derived source has automatic timeline authority.",
        },
      }
      : null,
  };
}

/**
 * Route material evidence disagreement to review-required uncertainty. A
 * provider signal is never selected as an automatic winner.
 */
export function routeVideoReasoningDisagreement(
  input: RouteVideoReasoningDisagreementInput,
): RouteVideoReasoningDisagreementResult {
  const source = input.source;
  const sourceValid = typeof source.asset_id === "string" && ASSET_ID_PATTERN.test(source.asset_id) &&
    typeof source.source_content_sha256 === "string" && HASH_PATTERN.test(source.source_content_sha256) &&
    typeof source.source_duration_us === "number" && Number.isSafeInteger(source.source_duration_us) && source.source_duration_us > 0 &&
    validRange(source.effective_source_range_us, source.source_duration_us);
  const tolerance = input.material_range_tolerance_us ?? DEFAULT_RANGE_TOLERANCE_US;
  const toleranceValid = typeof tolerance === "number" && Number.isSafeInteger(tolerance) && tolerance >= 0 && tolerance <= MAX_SAFE_US;
  const reasons: VideoReasoningDisagreementReasonCode[] = [];
  const sources: VideoReasoningDisagreementSource[] = [];
  const validSignals: VideoReasoningDisagreementSignal[] = [];

  if (!sourceValid || !toleranceValid) reasons.push("evidence_identity_mismatch");
  for (const signal of input.signals) {
    const signalShapeValid = isSource(signal.source) && typeof signal.claim_id === "string" && CLAIM_ID_PATTERN.test(signal.claim_id) &&
      (SIGNAL_STATUSES as readonly string[]).includes(signal.status);
    if (!signalShapeValid) {
      reasons.push("evidence_identity_mismatch");
      continue;
    }
    const identityMatches = sourceValid && signal.asset_id === source.asset_id && signal.source_content_sha256 === source.source_content_sha256;
    const rangeMatches = signal.range_us === undefined || (sourceValid && validRange(signal.range_us, source.source_duration_us) && signal.range_us[0] >= source.effective_source_range_us[0] && signal.range_us[1] <= source.effective_source_range_us[1]);
    if (!identityMatches) {
      reasons.push("evidence_identity_mismatch");
      sources.push(signal.source);
    }
    if (!rangeMatches) {
      reasons.push("evidence_range_invalid");
      sources.push(signal.source);
    }
    if (identityMatches && rangeMatches) validSignals.push(signal);
    if (signal.source === "local" && signal.status === "inconclusive") {
      reasons.push("local_verification_inconclusive");
      sources.push("local");
    }
    if (signal.source === "local" && signal.status === "rejects") {
      reasons.push("local_verification_rejected");
      sources.push("local");
    }
    if (signal.source === "local" && signal.status === "unavailable") {
      reasons.push("local_verification_unavailable");
      sources.push("local");
    }
  }

  const providerPresent = input.signals.some((signal) => signal.source === "provider");
  const localPresent = input.signals.some((signal) => signal.source === "local");
  if (providerPresent && !localPresent) {
    reasons.push("local_verification_missing");
    sources.push("provider");
  }
  if (providerPresent && localPresent && reasons.some((reason) => reason === "local_verification_inconclusive" || reason === "local_verification_rejected" || reason === "local_verification_unavailable")) {
    sources.push("provider");
  }

  const signalsByClaim = new Map<string, VideoReasoningDisagreementSignal[]>();
  for (const signal of validSignals) {
    const key = `${signal.source}\u0000${signal.claim_id}`;
    const group = signalsByClaim.get(key) ?? [];
    group.push(signal);
    signalsByClaim.set(key, group);
  }
  const crossSourceSignals: VideoReasoningDisagreementSignal[] = [];
  for (const group of signalsByClaim.values()) {
    const first = group[0];
    if (group.length > 1) {
      reasons.push("duplicate_source_claim");
      sources.push(first.source);
      if (group.some((signal) => signal.status === "supports") && group.some((signal) => signal.status === "rejects")) {
        reasons.push("intra_source_claim_disagreement");
        sources.push(first.source);
      }
      for (let leftIndex = 0; leftIndex < group.length; leftIndex += 1) {
        const left = group[leftIndex];
        if (!left.range_us) continue;
        for (let rightIndex = leftIndex + 1; rightIndex < group.length; rightIndex += 1) {
          const right = group[rightIndex];
          if (right.range_us && toleranceValid && materiallyDifferentRanges(left.range_us, right.range_us, tolerance)) {
            reasons.push("intra_source_range_disagreement");
            sources.push(first.source);
          }
        }
      }
    }
    crossSourceSignals.push(first);
  }

  for (let leftIndex = 0; leftIndex < crossSourceSignals.length; leftIndex += 1) {
    const left = crossSourceSignals[leftIndex];
    for (let rightIndex = leftIndex + 1; rightIndex < crossSourceSignals.length; rightIndex += 1) {
      const right = crossSourceSignals[rightIndex];
      if (left.claim_id !== right.claim_id || left.source === right.source) continue;
      const polarityDiff = (left.status === "supports" && right.status === "rejects") || (left.status === "rejects" && right.status === "supports");
      if (polarityDiff) {
        reasons.push("material_claim_disagreement");
        sources.push(left.source, right.source);
      }
      if (left.range_us && right.range_us && toleranceValid && materiallyDifferentRanges(left.range_us, right.range_us, tolerance)) {
        reasons.push("material_range_disagreement");
        sources.push(left.source, right.source);
      }
    }
  }

  const reviewRequired = reasons.length > 0;
  return result(reviewRequired, reasons, sources.length > 0 ? sources : validSignals.map((signal) => signal.source), validSignals);
}
