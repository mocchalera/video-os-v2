/**
 * M3b local timestamp/frame verification.
 *
 * This is a separate, derived artifact from M3a's provider-only
 * `video-reasoning-evidence/v1`. It binds local evidence to the provider
 * observation and source identity, but never becomes timeline authority.
 */

import { execFile } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  validateVideoReasoningEvidenceIntegrity,
  type VideoReasoningEvidenceArtifact,
  type VideoReasoningEvidenceObservation,
} from "./video-reasoning-evidence.js";
import { sha256FileHex } from "../source-content-identity.js";

export const VIDEO_REASONING_LOCAL_VERIFICATION_ARTIFACT_VERSION =
  "video-reasoning-local-verification/v1" as const;
export const VIDEO_REASONING_LOCAL_VERIFICATION_SCHEMA_FILE =
  "video-reasoning-local-verification.schema.json" as const;

const MAX_SAFE_US = Number.MAX_SAFE_INTEGER;
const MAX_RECORDS = 32;
const DEFAULT_FRAMES_PER_OBSERVATION = 8;
const MAX_FRAMES_PER_OBSERVATION = 32;
const DEFAULT_MAX_TOTAL_FRAMES = 256;
const MAX_TOTAL_FRAMES = 256;
const LOCAL_VERIFICATION_WINDOW_PADDING_US = 500_000;
const MAX_FAILURE_CODES = 4;
const MAX_EVIDENCE_CODES = 16;
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const ASSET_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const OBSERVATION_ID_PATTERN = /^VREO_[a-f0-9]{64}$/;
const ARTIFACT_ID_PATTERN = /^VREA_[a-f0-9]{64}$/;
const LOCAL_ARTIFACT_ID_PATTERN = /^VLRV_[a-f0-9]{64}$/;
const CODE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

const OUTCOMES = ["confirmed", "adjusted", "rejected", "inconclusive"] as const;
const EXTRACTION_STATUSES = ["complete", "partial", "unavailable"] as const;
const VERIFICATION_STATUSES = ["verified", "inconclusive", "unavailable"] as const;
const FAILURE_CODES = [
  "ffmpeg_unavailable",
  "ffmpeg_decode_failed",
  "frame_not_decoded",
  "insufficient_frames",
  "no_provider_observations",
] as const;

export type VideoReasoningLocalVerificationRangeUs = [number, number];
export type VideoReasoningLocalVerificationOutcome = typeof OUTCOMES[number];
export type VideoReasoningLocalVerificationStatus = typeof VERIFICATION_STATUSES[number];
export type VideoReasoningLocalExtractionStatus = typeof EXTRACTION_STATUSES[number];
export type VideoReasoningLocalExtractionFailureCode = typeof FAILURE_CODES[number];

export interface VideoReasoningLocalVerificationSource {
  asset_id: string;
  source_content_sha256: string;
  source_duration_us: number;
  effective_source_range_us: VideoReasoningLocalVerificationRangeUs;
}

export interface VideoReasoningLocalVerificationRecord {
  provider_observation_id: string;
  asset_id: string;
  source_content_sha256: string;
  source_duration_us: number;
  effective_source_range_us: VideoReasoningLocalVerificationRangeUs;
  /** M3a's source.effective_source_range_us; M3a has no separate request window. */
  provider_requested_range_us: VideoReasoningLocalVerificationRangeUs;
  provider_candidate_range_us: VideoReasoningLocalVerificationRangeUs;
  local_verification_window_us: VideoReasoningLocalVerificationRangeUs;
  local_frame_timestamps_us: number[];
  local_verified_range_us: VideoReasoningLocalVerificationRangeUs | null;
  outcome: VideoReasoningLocalVerificationOutcome;
  rationale_code: string;
  assessor_evidence_codes: string[];
  planned_frame_count: number;
  frame_extraction_status: VideoReasoningLocalExtractionStatus;
  frame_extraction_failure_codes: VideoReasoningLocalExtractionFailureCode[];
}

export interface VideoReasoningLocalVerificationExtraction {
  tool: "ffmpeg";
  status: VideoReasoningLocalExtractionStatus;
  requested_frame_count: number;
  decoded_frame_count: number;
  failed_frame_count: number;
  failure_codes: VideoReasoningLocalExtractionFailureCode[];
}

export interface VideoReasoningLocalVerificationArtifact {
  artifact_id: string;
  artifact_version: typeof VIDEO_REASONING_LOCAL_VERIFICATION_ARTIFACT_VERSION;
  artifact_kind: "derived_local_verification";
  authority: "derived_evidence_only";
  provider_evidence_artifact_id: string;
  provider_evidence_artifact_sha256: string;
  source: VideoReasoningLocalVerificationSource;
  verification_status: VideoReasoningLocalVerificationStatus;
  extraction: VideoReasoningLocalVerificationExtraction;
  records: VideoReasoningLocalVerificationRecord[];
}

export class VideoReasoningLocalVerificationError extends Error {
  readonly code = "VIDEO_REASONING_LOCAL_VERIFICATION_REJECTED" as const;

  constructor(reason: string) {
    super(`video reasoning local verification rejected: ${reason}`);
    this.name = "VideoReasoningLocalVerificationError";
  }
}

function reject(reason: string): never {
  throw new VideoReasoningLocalVerificationError(reason);
}

export interface VideoReasoningLocalVerificationIntegrityValidation {
  valid: boolean;
  errors: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function frozenClone<T>(value: T): T {
  const copy = structuredClone(value);
  const freeze = (current: unknown): void => {
    if (!Array.isArray(current) && !isRecord(current)) return;
    Object.freeze(current);
    for (const child of Object.values(current)) freeze(child);
  };
  freeze(copy);
  return copy;
}

function isSafeUs(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= MAX_SAFE_US;
}

function isPositiveUs(value: unknown): value is number {
  return isSafeUs(value) && value > 0;
}

function isHash(value: unknown): value is string {
  return typeof value === "string" && HASH_PATTERN.test(value);
}

function isCode(value: unknown): value is string {
  return typeof value === "string" && CODE_PATTERN.test(value);
}

function sameRange(left: readonly [number, number], right: readonly [number, number]): boolean {
  return left[0] === right[0] && left[1] === right[1];
}

function rangeInside(inner: readonly [number, number], outer: readonly [number, number]): boolean {
  return inner[0] >= outer[0] && inner[1] <= outer[1];
}

function timestampInsideHalfOpen(timestampUs: number, rangeUs: readonly [number, number]): boolean {
  return timestampUs >= rangeUs[0] && timestampUs < rangeUs[1];
}

function rangeCoveredByFrames(rangeUs: readonly [number, number], timestampsUs: readonly number[]): boolean {
  if (timestampsUs.length === 0) return false;
  const first = Math.min(...timestampsUs);
  const last = Math.max(...timestampsUs);
  return rangeUs[0] >= first && rangeUs[1] <= last;
}

function isOrderedSubset(values: readonly number[], plan: readonly number[]): boolean {
  let planIndex = 0;
  for (const value of values) {
    while (planIndex < plan.length && plan[planIndex] !== value) planIndex += 1;
    if (planIndex === plan.length) return false;
    planIndex += 1;
  }
  return true;
}

function localVerificationWindow(
  candidateRangeUs: readonly [number, number],
  effectiveRangeUs: readonly [number, number],
  paddingUs: number,
): VideoReasoningLocalVerificationRangeUs {
  return [
    Math.max(effectiveRangeUs[0], candidateRangeUs[0] - paddingUs),
    Math.min(effectiveRangeUs[1], candidateRangeUs[1] + paddingUs),
  ];
}

function parseRange(
  value: unknown,
  durationUs: number,
  field: string,
  errors: string[],
): VideoReasoningLocalVerificationRangeUs | undefined {
  if (!Array.isArray(value) || value.length !== 2 ||
      !isSafeUs(value[0]) || !isSafeUs(value[1]) || value[0] >= value[1] || value[1] > durationUs) {
    errors.push(`${field} invalid`);
    return undefined;
  }
  return [value[0], value[1]];
}

function requiredRange(
  value: unknown,
  durationUs: number,
  field: string,
): VideoReasoningLocalVerificationRangeUs {
  const errors: string[] = [];
  const range = parseRange(value, durationUs, field, errors);
  if (!range) reject(`${field} invalid`);
  return range;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value) as string;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) reject("non-finite identity value");
    return Object.is(value, -0) ? "0" : String(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  reject("unsupported identity value");
}

function contentSha256(value: unknown): string {
  return crypto.createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

function contentId(prefix: string, value: unknown): string {
  return `${prefix}${contentSha256(value)}`;
}

function validateSource(
  value: unknown,
  errors: string[],
): VideoReasoningLocalVerificationSource | undefined {
  if (!isRecord(value)) {
    errors.push("source invalid");
    return undefined;
  }
  if (typeof value.asset_id !== "string" || !ASSET_ID_PATTERN.test(value.asset_id)) {
    errors.push("source.asset_id invalid");
  }
  if (!isHash(value.source_content_sha256)) errors.push("source.source_content_sha256 invalid");
  if (!isPositiveUs(value.source_duration_us)) errors.push("source.source_duration_us invalid");
  const range = isPositiveUs(value.source_duration_us)
    ? parseRange(value.effective_source_range_us, value.source_duration_us, "source.effective_source_range_us", errors)
    : undefined;
  if (!range || typeof value.asset_id !== "string" || !ASSET_ID_PATTERN.test(value.asset_id) ||
      !isHash(value.source_content_sha256) || !isPositiveUs(value.source_duration_us)) return undefined;
  return {
    asset_id: value.asset_id,
    source_content_sha256: value.source_content_sha256,
    source_duration_us: value.source_duration_us,
    effective_source_range_us: range,
  };
}

function validateRecord(
  value: unknown,
  index: number,
  source: VideoReasoningLocalVerificationSource | undefined,
  providerObservations: Map<string, VideoReasoningEvidenceObservation> | undefined,
  errors: string[],
): void {
  const field = `records[${index}]`;
  if (!isRecord(value)) {
    errors.push(`${field} invalid`);
    return;
  }

  if (typeof value.provider_observation_id !== "string" || !OBSERVATION_ID_PATTERN.test(value.provider_observation_id)) {
    errors.push(`${field}.provider_observation_id invalid`);
  } else if (providerObservations && !providerObservations.has(value.provider_observation_id)) {
    errors.push(`${field}.provider_observation_id is not bound to provider evidence`);
  }
  const providerObservation = typeof value.provider_observation_id === "string" && OBSERVATION_ID_PATTERN.test(value.provider_observation_id)
    ? providerObservations?.get(value.provider_observation_id)
    : undefined;
  if (typeof value.asset_id !== "string" || !ASSET_ID_PATTERN.test(value.asset_id)) errors.push(`${field}.asset_id invalid`);
  if (!isHash(value.source_content_sha256)) errors.push(`${field}.source_content_sha256 invalid`);
  if (!isPositiveUs(value.source_duration_us)) errors.push(`${field}.source_duration_us invalid`);

  const durationUs = isPositiveUs(value.source_duration_us) ? value.source_duration_us : undefined;
  const effectiveRange = durationUs === undefined
    ? undefined
    : parseRange(value.effective_source_range_us, durationUs, `${field}.effective_source_range_us`, errors);
  const requestedRange = durationUs === undefined
    ? undefined
    : parseRange(value.provider_requested_range_us, durationUs, `${field}.provider_requested_range_us`, errors);
  const candidateRange = durationUs === undefined
    ? undefined
    : parseRange(value.provider_candidate_range_us, durationUs, `${field}.provider_candidate_range_us`, errors);
  const localWindow = durationUs === undefined
    ? undefined
    : parseRange(value.local_verification_window_us, durationUs, `${field}.local_verification_window_us`, errors);

  if (source && durationUs !== undefined && effectiveRange && requestedRange && candidateRange && localWindow) {
    if (value.asset_id !== source.asset_id) errors.push(`${field}.asset_id identity mismatch`);
    if (value.source_content_sha256 !== source.source_content_sha256) errors.push(`${field}.source_content_sha256 identity mismatch`);
    if (value.source_duration_us !== source.source_duration_us) errors.push(`${field}.source_duration_us identity mismatch`);
    if (!sameRange(effectiveRange, source.effective_source_range_us)) errors.push(`${field}.effective_source_range_us identity mismatch`);
    if (!sameRange(requestedRange, source.effective_source_range_us)) errors.push(`${field}.provider_requested_range_us identity mismatch`);
    if (!rangeInside(candidateRange, source.effective_source_range_us)) errors.push(`${field}.provider_candidate_range_us outside effective source range`);
    if (!rangeInside(localWindow, source.effective_source_range_us)) errors.push(`${field}.local_verification_window_us outside effective source range`);
    if (!rangeInside(candidateRange, localWindow)) errors.push(`${field}.provider_candidate_range_us outside local verification window`);
    if (providerObservation && !sameRange(candidateRange, providerObservation.provider_range_us)) {
      errors.push(`${field}.provider_candidate_range_us provider observation mismatch`);
    }
    const expectedLocalWindow = localVerificationWindow(
      candidateRange,
      source.effective_source_range_us,
      LOCAL_VERIFICATION_WINDOW_PADDING_US,
    );
    if (!sameRange(localWindow, expectedLocalWindow)) errors.push(`${field}.local_verification_window_us derived value mismatch`);
  }

  const frames = value.local_frame_timestamps_us;
  if (!Array.isArray(frames) || frames.length > MAX_FRAMES_PER_OBSERVATION || frames.some((timestamp) => !isSafeUs(timestamp))) {
    errors.push(`${field}.local_frame_timestamps_us invalid`);
  } else {
    if (new Set(frames).size !== frames.length) errors.push(`${field}.local_frame_timestamps_us contains duplicates`);
    if (localWindow && frames.some((timestamp) => !timestampInsideHalfOpen(timestamp, localWindow))) {
      errors.push(`${field}.local_frame_timestamps_us outside local verification window`);
    }
  }

  let localRange: VideoReasoningLocalVerificationRangeUs | null | undefined;
  if (value.local_verified_range_us === null) {
    localRange = null;
  } else if (durationUs !== undefined) {
    localRange = parseRange(value.local_verified_range_us, durationUs, `${field}.local_verified_range_us`, errors);
  }
  if (localRange && effectiveRange && !rangeInside(localRange, effectiveRange)) {
    errors.push(`${field}.local_verified_range_us outside effective source range`);
  }
  if (localRange && localWindow && !rangeInside(localRange, localWindow)) {
    errors.push(`${field}.local_verified_range_us outside local verification window`);
  }

  if (typeof value.outcome !== "string" || !(OUTCOMES as readonly string[]).includes(value.outcome)) errors.push(`${field}.outcome invalid`);
  if (!isCode(value.rationale_code)) errors.push(`${field}.rationale_code invalid`);
  const evidenceCodes = value.assessor_evidence_codes;
  if (!Array.isArray(evidenceCodes) || evidenceCodes.length > MAX_EVIDENCE_CODES || evidenceCodes.some((code) => !isCode(code))) {
    errors.push(`${field}.assessor_evidence_codes invalid`);
  } else if (new Set(evidenceCodes).size !== evidenceCodes.length) {
    errors.push(`${field}.assessor_evidence_codes contains duplicates`);
  }
  if (!isSafeUs(value.planned_frame_count) || value.planned_frame_count > MAX_FRAMES_PER_OBSERVATION) errors.push(`${field}.planned_frame_count invalid`);

  if (typeof value.frame_extraction_status !== "string" || !(EXTRACTION_STATUSES as readonly string[]).includes(value.frame_extraction_status)) {
    errors.push(`${field}.frame_extraction_status invalid`);
  }
  const failureCodes = value.frame_extraction_failure_codes;
  if (!Array.isArray(failureCodes) || failureCodes.length > MAX_FAILURE_CODES || failureCodes.some((code) => !(FAILURE_CODES as readonly string[]).includes(String(code)))) {
    errors.push(`${field}.frame_extraction_failure_codes invalid`);
  } else if (new Set(failureCodes).size !== failureCodes.length) {
    errors.push(`${field}.frame_extraction_failure_codes contains duplicates`);
  }

  const planned = isSafeUs(value.planned_frame_count) ? value.planned_frame_count : undefined;
  const decoded = Array.isArray(frames) ? frames.length : undefined;
  const failureCodeList = Array.isArray(failureCodes) ? failureCodes : [];
  const failuresValid = Array.isArray(failureCodes) && failureCodes.every((code) => (FAILURE_CODES as readonly string[]).includes(String(code)));
  const failed = planned !== undefined && decoded !== undefined && decoded <= planned ? planned - decoded : undefined;
  const plannedTimestamps = planned !== undefined && planned > 0 && planned <= MAX_FRAMES_PER_OBSERVATION && localWindow
    ? planDenseFrameTimestamps(localWindow, { frameCount: planned })
    : [];
  if (Array.isArray(frames) && planned !== undefined && frames.length > planned) {
    errors.push(`${field}.decoded frames exceed planned frames`);
  }
  if (planned !== undefined && localWindow && planned > 0 && plannedTimestamps.length !== planned) {
    errors.push(`${field}.planned_frame_count does not match deterministic plan`);
  }
  if (Array.isArray(frames) && frames.every(isSafeUs) &&
      (value.frame_extraction_status === "complete" || value.frame_extraction_status === "partial" || value.frame_extraction_status === "unavailable") &&
      !isOrderedSubset(frames, plannedTimestamps)) {
    errors.push(`${field}.local_frame_timestamps_us is not an ordered subset of deterministic plan`);
  }
  if (value.frame_extraction_status === "complete" && Array.isArray(frames) &&
      JSON.stringify(frames) !== JSON.stringify(plannedTimestamps)) {
    errors.push(`${field}.local_frame_timestamps_us does not match deterministic plan`);
  }
  if (planned !== undefined && decoded !== undefined && decoded < planned && failuresValid && !failureCodeList.includes("insufficient_frames")) {
    errors.push(`${field} incomplete extraction requires insufficient_frames`);
  }
  if ((value.outcome === "confirmed" || value.outcome === "adjusted") &&
      (!localRange || !Array.isArray(evidenceCodes) || evidenceCodes.length === 0 || value.frame_extraction_status !== "complete")) {
    errors.push(`${field}.${String(value.outcome)} requires complete assessor-backed evidence`);
  }
  if ((value.outcome === "rejected" || value.outcome === "inconclusive") && value.local_verified_range_us !== null) {
    errors.push(`${field}.${String(value.outcome)} cannot claim a local verified range`);
  }
  if (value.frame_extraction_status === "complete" &&
      (planned === undefined || planned <= 0 || decoded === undefined || decoded !== planned || failed !== 0 || !failuresValid || failureCodeList.length > 0)) {
    errors.push(`${field} complete extraction is inconsistent`);
  }
  if (value.frame_extraction_status === "partial" &&
      (planned === undefined || planned <= 0 || decoded === undefined || decoded <= 0 || decoded >= planned || failed === undefined || failed <= 0 || !failuresValid || failureCodeList.length === 0)) {
    errors.push(`${field} partial extraction is inconsistent`);
  }
  if (value.frame_extraction_status === "unavailable" &&
      (decoded !== undefined && decoded !== 0 || !failuresValid || failureCodeList.length === 0)) {
    errors.push(`${field} unavailable extraction is inconsistent`);
  }
  if ((value.outcome === "confirmed" || value.outcome === "adjusted") &&
      localRange && Array.isArray(frames) && !rangeCoveredByFrames(localRange, frames)) {
    errors.push(`${field}.local_verified_range_us is not covered by decoded local frames`);
  }
}

function expectedVerificationStatus(records: readonly VideoReasoningLocalVerificationRecord[]): VideoReasoningLocalVerificationStatus {
  if (records.length === 0 || records.every((record) => record.frame_extraction_status === "unavailable")) return "unavailable";
  return records.every((record) => record.frame_extraction_status === "complete" && record.outcome !== "inconclusive")
    ? "verified"
    : "inconclusive";
}

function expectedExtractionStatus(records: readonly VideoReasoningLocalVerificationRecord[]): VideoReasoningLocalExtractionStatus {
  const requested = records.reduce((sum, record) => sum + record.planned_frame_count, 0);
  const decoded = records.reduce((sum, record) => sum + record.local_frame_timestamps_us.length, 0);
  const failed = requested - decoded;
  const failureCodes = unique(records.flatMap((record) => record.frame_extraction_failure_codes));
  if (requested === 0 || decoded === 0) return "unavailable";
  if (decoded === requested && failed === 0 && failureCodes.length === 0 &&
      records.every((record) => record.frame_extraction_status === "complete")) return "complete";
  return "partial";
}

/** Validate JSON-schema-adjacent invariants and exact M3a identity binding. */
export function validateVideoReasoningLocalVerificationIntegrity(
  value: unknown,
  providerArtifact: VideoReasoningEvidenceArtifact,
): VideoReasoningLocalVerificationIntegrityValidation {
  const errors: string[] = [];
  if (!isRecord(value)) return { valid: false, errors: ["artifact must be an object"] };
  if (value.artifact_version !== VIDEO_REASONING_LOCAL_VERIFICATION_ARTIFACT_VERSION) errors.push("artifact_version invalid");
  if (value.artifact_kind !== "derived_local_verification") errors.push("artifact_kind invalid");
  if (value.authority !== "derived_evidence_only") errors.push("authority invalid");
  if (typeof value.artifact_id !== "string" || !LOCAL_ARTIFACT_ID_PATTERN.test(value.artifact_id)) errors.push("artifact_id invalid");
  if (typeof value.provider_evidence_artifact_id !== "string" || !ARTIFACT_ID_PATTERN.test(value.provider_evidence_artifact_id)) {
    errors.push("provider_evidence_artifact_id invalid");
  }
  if (!isHash(value.provider_evidence_artifact_sha256)) errors.push("provider_evidence_artifact_sha256 invalid");

  const source = validateSource(value.source, errors);
  let providerObservations: Map<string, VideoReasoningEvidenceObservation> | undefined;
  if (!isRecord(providerArtifact)) {
    errors.push("provider artifact is required for source-bound local verification");
  } else {
    const providerValidation = validateVideoReasoningEvidenceIntegrity(providerArtifact);
    errors.push(...providerValidation.errors.map((error) => `provider evidence ${error}`));
    if (providerValidation.valid) {
      providerObservations = new Map<string, VideoReasoningEvidenceObservation>();
      for (const observation of providerArtifact.observations) {
        if (providerObservations.has(observation.observation_id)) errors.push("provider evidence contains duplicate observation ids");
        providerObservations.set(observation.observation_id, observation);
      }
      if (value.provider_evidence_artifact_id !== providerArtifact.artifact_id) errors.push("provider evidence artifact id mismatch");
      if (isHash(value.provider_evidence_artifact_sha256) && value.provider_evidence_artifact_sha256 !== contentSha256(providerArtifact)) {
        errors.push("provider evidence artifact sha256 mismatch");
      }
      if (source) {
        if (source.asset_id !== providerArtifact.source.asset_id) errors.push("source.asset_id provider mismatch");
        if (source.source_content_sha256 !== providerArtifact.source.source_content_sha256) errors.push("source.source_content_sha256 provider mismatch");
        if (source.source_duration_us !== providerArtifact.source.source_duration_us) errors.push("source.source_duration_us provider mismatch");
        if (!sameRange(source.effective_source_range_us, providerArtifact.source.effective_source_range_us)) errors.push("source.effective_source_range_us provider mismatch");
      }
    }
  }

  if (typeof value.verification_status !== "string" || !(VERIFICATION_STATUSES as readonly string[]).includes(value.verification_status)) {
    errors.push("verification_status invalid");
  }

  const extraction = value.extraction;
  if (!isRecord(extraction)) {
    errors.push("extraction invalid");
  } else {
    if (extraction.tool !== "ffmpeg") errors.push("extraction.tool invalid");
    if (typeof extraction.status !== "string" || !(EXTRACTION_STATUSES as readonly string[]).includes(extraction.status)) errors.push("extraction.status invalid");
    for (const field of ["requested_frame_count", "decoded_frame_count", "failed_frame_count"]) {
      if (!isSafeUs(extraction[field])) errors.push(`extraction.${field} invalid`);
    }
    const failureCodes = extraction.failure_codes;
    if (!Array.isArray(failureCodes) || failureCodes.length > MAX_FAILURE_CODES || failureCodes.some((code) => !(FAILURE_CODES as readonly string[]).includes(String(code)))) {
      errors.push("extraction.failure_codes invalid");
    } else if (new Set(failureCodes).size !== failureCodes.length) {
      errors.push("extraction.failure_codes contains duplicates");
    }
    const requested = extraction.requested_frame_count;
    const decoded = extraction.decoded_frame_count;
    const failed = extraction.failed_frame_count;
    const countsValid = isSafeUs(requested) && isSafeUs(decoded) && isSafeUs(failed);
    const failureCodesValid = Array.isArray(failureCodes) && failureCodes.every((code) => (FAILURE_CODES as readonly string[]).includes(String(code)));
    const failureCodeList = Array.isArray(failureCodes) ? failureCodes : [];
    if (countsValid) {
      if (requested > MAX_TOTAL_FRAMES) errors.push("extraction requested frame count exceeds bound");
      if (decoded > requested) errors.push("extraction decoded frame count exceeds requested count");
      if (failed > requested) errors.push("extraction failed frame count exceeds requested count");
      if (decoded + failed !== requested) errors.push("extraction frame counts are incomplete");
      if (failureCodesValid && extraction.status === "complete" &&
          (requested <= 0 || decoded !== requested || failed !== 0 || failureCodeList.length > 0)) {
        errors.push("extraction complete status is inconsistent");
      }
      if (failureCodesValid && extraction.status === "partial" &&
          (requested <= 0 || decoded <= 0 || decoded >= requested || failed <= 0 || failureCodeList.length === 0)) {
        errors.push("extraction partial status is inconsistent");
      }
      if (failureCodesValid && extraction.status === "unavailable" &&
          (decoded !== 0 || failureCodeList.length === 0)) {
        errors.push("extraction unavailable status is inconsistent");
      }
    }
  }

  const recordsValue = value.records;
  const records: VideoReasoningLocalVerificationRecord[] = [];
  if (!Array.isArray(recordsValue) || recordsValue.length > MAX_RECORDS) {
    errors.push("records invalid");
  } else {
    const recordIds = new Set<string>();
    recordsValue.forEach((record, index) => {
      if (isRecord(record) && typeof record.provider_observation_id === "string") {
        if (recordIds.has(record.provider_observation_id)) errors.push("records contains duplicate provider observation ids");
        recordIds.add(record.provider_observation_id);
      }
      validateRecord(record, index, source, providerObservations, errors);
      if (isRecord(record)) records.push(record as unknown as VideoReasoningLocalVerificationRecord);
    });
  }

  if (records.length === 0 && Array.isArray(recordsValue) && recordsValue.length === 0 && isRecord(extraction) &&
      (!Array.isArray(extraction.failure_codes) || !extraction.failure_codes.includes("no_provider_observations"))) {
    errors.push("empty records require no_provider_observations");
  }
  if (providerObservations && Array.isArray(recordsValue) && recordsValue.length !== providerObservations.size) {
    errors.push("records must contain exactly one record per provider observation");
  }
  const recordsSummaryValid = Array.isArray(recordsValue) && recordsValue.every(isRecord) && records.every((record) =>
    isSafeUs(record.planned_frame_count) && Array.isArray(record.local_frame_timestamps_us) &&
    record.local_frame_timestamps_us.every(isSafeUs) && Array.isArray(record.frame_extraction_failure_codes));
  if (isRecord(extraction) && recordsSummaryValid) {
    const requested = records.reduce((sum, record) => sum + record.planned_frame_count, 0);
    const decoded = records.reduce((sum, record) => sum + record.local_frame_timestamps_us.length, 0);
    const failed = records.reduce((sum, record) => sum + Math.max(0, record.planned_frame_count - record.local_frame_timestamps_us.length), 0);
    const failureCodes = records.length === 0
      ? ["no_provider_observations"]
      : unique(records.flatMap((record) => record.frame_extraction_failure_codes)).slice(0, MAX_FAILURE_CODES);
    if (extraction.requested_frame_count !== requested) errors.push("extraction requested frame count disagrees with records");
    if (extraction.decoded_frame_count !== decoded) errors.push("extraction decoded frame count disagrees with records");
    if (extraction.failed_frame_count !== failed) errors.push("extraction failed frame count disagrees with records");
    if (!Array.isArray(extraction.failure_codes) || JSON.stringify(extraction.failure_codes) !== JSON.stringify(failureCodes)) {
      errors.push("extraction failure codes disagree with records");
    }
    if (typeof extraction.status === "string" && extraction.status !== expectedExtractionStatus(records)) errors.push("extraction status disagrees with records");
    if (typeof value.verification_status === "string" && (VERIFICATION_STATUSES as readonly string[]).includes(value.verification_status) && value.verification_status !== expectedVerificationStatus(records)) {
      errors.push("verification_status disagrees with records");
    }
  }
  if (typeof value.artifact_id === "string") {
    try {
      const { artifact_id: _artifactId, ...body } = value;
      if (value.artifact_id !== contentId("VLRV_", body)) errors.push("artifact_id content mismatch");
    } catch (error) {
      errors.push(`artifact identity could not be computed: ${error instanceof Error ? error.message : "invalid value"}`);
    }
  }
  return { valid: errors.length === 0, errors };
}

export function assertVideoReasoningLocalVerificationIntegrity(
  value: unknown,
  providerArtifact: VideoReasoningEvidenceArtifact,
): asserts value is VideoReasoningLocalVerificationArtifact {
  const validation = validateVideoReasoningLocalVerificationIntegrity(value, providerArtifact);
  if (!validation.valid) reject(`artifact integrity: ${validation.errors.join(",")}`);
}

export interface DenseFramePlanOptions {
  frameCount?: number;
}

/** Return a deterministic, bounded, source-relative midpoint plan. */
export function planDenseFrameTimestamps(
  rangeUs: readonly [number, number],
  options: DenseFramePlanOptions = {},
): number[] {
  if (!isSafeUs(rangeUs[0]) || !isSafeUs(rangeUs[1]) || rangeUs[0] >= rangeUs[1]) reject("invalid dense frame range");
  const frameCount = options.frameCount ?? DEFAULT_FRAMES_PER_OBSERVATION;
  if (!isSafeUs(frameCount) || frameCount < 1 || frameCount > MAX_FRAMES_PER_OBSERVATION) reject("invalid dense frame count");
  const start = BigInt(rangeUs[0]);
  const duration = BigInt(rangeUs[1]) - start;
  const denominator = BigInt(frameCount) * 2n;
  const timestamps: number[] = [];
  const seen = new Set<number>();
  for (let index = 0; index < frameCount; index += 1) {
    const raw = Number(start + (duration * BigInt(index * 2 + 1)) / denominator);
    const timestamp = Math.max(rangeUs[0], Math.min(rangeUs[1] - 1, raw));
    if (!seen.has(timestamp)) {
      seen.add(timestamp);
      timestamps.push(timestamp);
    }
  }
  return timestamps;
}

export interface DenseFrameRunnerRequest {
  command: "ffmpeg";
  args: readonly string[];
  source_path: string;
  timestamp_us: number;
  output_path: string;
}

export type DenseFrameRunner = (request: DenseFrameRunnerRequest) => Promise<void> | void;

export interface DenseFrameExtractionFailure {
  timestamp_us: number;
  code: Exclude<VideoReasoningLocalExtractionFailureCode, "insufficient_frames" | "no_provider_observations">;
}

export interface DenseFrameEvidence {
  timestamp_us: number;
  path: string;
}

export interface DenseFrameExtractionResult {
  status: VideoReasoningLocalExtractionStatus;
  requested_timestamps_us: number[];
  decoded_timestamps_us: number[];
  frames: DenseFrameEvidence[];
  failures: DenseFrameExtractionFailure[];
}

export interface ExtractDenseFramesOptions {
  outputDir: string;
  runner?: DenseFrameRunner;
}

function outputPath(outputDir: string, index: number, timestampUs: number): string {
  return path.join(path.resolve(outputDir), `frame-${String(index).padStart(3, "0")}-${timestampUs}.jpg`);
}

function imageExists(filePath: string): boolean {
  try {
    const stat = fs.statSync(filePath);
    return stat.isFile() && stat.size > 0;
  } catch {
    return false;
  }
}

function errorCode(error: unknown): string | undefined {
  return isRecord(error) && typeof error.code === "string" ? error.code : undefined;
}

function extractionFailure(error: unknown): DenseFrameExtractionFailure["code"] {
  const code = errorCode(error);
  const message = error instanceof Error ? error.message : String(error);
  if (code === "ENOENT" || /ffmpeg[^\n]*(?:enoent|not found|unavailable|missing)/i.test(message)) return "ffmpeg_unavailable";
  if (message === "frame_not_decoded") return "frame_not_decoded";
  return "ffmpeg_decode_failed";
}

function runFfmpeg(request: DenseFrameRunnerRequest): Promise<void> {
  return new Promise((resolve, rejectPromise) => {
    execFile(request.command, [...request.args], { maxBuffer: 4 * 1024 * 1024 }, (error, _stdout, stderr) => {
      if (!error) {
        resolve();
        return;
      }
      const wrapped = new Error(stderr || error.message);
      const code = errorCode(error);
      if (code) Object.assign(wrapped, { code });
      rejectPromise(wrapped);
    });
  });
}

const defaultRunner: DenseFrameRunner = runFfmpeg;

/** Extract only bounded local evidence; failures are explicit and fail-open. */
export async function extractDenseFrames(
  sourcePath: string,
  timestampsUs: readonly number[],
  options: ExtractDenseFramesOptions,
): Promise<DenseFrameExtractionResult> {
  const requested = [...timestampsUs];
  if (requested.length > MAX_TOTAL_FRAMES) reject("dense frame bound exceeded");
  if (requested.some((timestamp) => !isSafeUs(timestamp))) reject("invalid dense frame timestamp");
  if (new Set(requested).size !== requested.length) reject("duplicate dense frame timestamp");
  const absoluteSourcePath = path.resolve(sourcePath);
  const absoluteOutputDir = path.resolve(options.outputDir);
  fs.mkdirSync(absoluteOutputDir, { recursive: true });
  const frames: DenseFrameEvidence[] = [];
  const failures: DenseFrameExtractionFailure[] = [];
  let unavailable = false;

  for (const [index, timestampUs] of requested.entries()) {
    const filePath = outputPath(absoluteOutputDir, index, timestampUs);
    const args = [
      "-v", "error", "-y",
      "-ss", (timestampUs / 1_000_000).toFixed(6),
      "-i", absoluteSourcePath,
      "-frames:v", "1", "-q:v", "2", filePath,
    ];
    const request: DenseFrameRunnerRequest = {
      command: "ffmpeg",
      args,
      source_path: absoluteSourcePath,
      timestamp_us: timestampUs,
      output_path: filePath,
    };
    try {
      await (options.runner ?? defaultRunner)(request);
      if (!imageExists(filePath)) throw new Error("frame_not_decoded");
      frames.push({ timestamp_us: timestampUs, path: filePath });
    } catch (error) {
      const code = extractionFailure(error);
      failures.push({ timestamp_us: timestampUs, code });
      if (code === "ffmpeg_unavailable") unavailable = true;
    }
    if (unavailable) {
      for (const remaining of requested.slice(index + 1)) failures.push({ timestamp_us: remaining, code: "ffmpeg_unavailable" });
      break;
    }
  }

  return {
    status: frames.length === 0 ? "unavailable" : failures.length === 0 ? "complete" : "partial",
    requested_timestamps_us: requested,
    decoded_timestamps_us: frames.map((frame) => frame.timestamp_us),
    frames,
    failures,
  };
}

export interface LocalFrameAssessorInput {
  provider_observation: VideoReasoningEvidenceObservation;
  source: VideoReasoningLocalVerificationSource;
  provider_requested_range_us: VideoReasoningLocalVerificationRangeUs;
  provider_candidate_range_us: VideoReasoningLocalVerificationRangeUs;
  local_verification_window_us: VideoReasoningLocalVerificationRangeUs;
  frame_timestamps_us: readonly number[];
  frame_paths: readonly string[];
}

export interface LocalFrameAssessment {
  outcome: VideoReasoningLocalVerificationOutcome;
  local_verified_range_us?: VideoReasoningLocalVerificationRangeUs | null;
  rationale_code: string;
  evidence_codes?: readonly string[];
}

export type LocalFrameAssessor = (input: LocalFrameAssessorInput) => Promise<LocalFrameAssessment | undefined> | LocalFrameAssessment | undefined;

export interface VerifyVideoReasoningLocallyOptions {
  sourcePath: string;
  outputDir?: string;
  framesPerObservation?: number;
  maxTotalFrames?: number;
  runner?: DenseFrameRunner;
  assessor?: LocalFrameAssessor;
}

function sourceFromProvider(provider: VideoReasoningEvidenceArtifact): VideoReasoningLocalVerificationSource {
  return {
    asset_id: provider.source.asset_id,
    source_content_sha256: provider.source.source_content_sha256,
    source_duration_us: provider.source.source_duration_us,
    effective_source_range_us: [...provider.source.effective_source_range_us],
  };
}

function inconclusiveRecord(
  source: VideoReasoningLocalVerificationSource,
  observation: VideoReasoningEvidenceObservation,
  localWindow: VideoReasoningLocalVerificationRangeUs,
  plannedFrameCount: number,
  extractionStatus: VideoReasoningLocalExtractionStatus,
  failureCodes: readonly VideoReasoningLocalExtractionFailureCode[],
  rationaleCode: string,
  frames: readonly number[] = [],
): VideoReasoningLocalVerificationRecord {
  return {
    provider_observation_id: observation.observation_id,
    asset_id: source.asset_id,
    source_content_sha256: source.source_content_sha256,
    source_duration_us: source.source_duration_us,
    effective_source_range_us: [...source.effective_source_range_us],
    provider_requested_range_us: [...source.effective_source_range_us],
    provider_candidate_range_us: [...observation.provider_range_us],
    local_verification_window_us: [...localWindow],
    local_frame_timestamps_us: [...frames],
    local_verified_range_us: null,
    outcome: "inconclusive",
    rationale_code: isCode(rationaleCode) ? rationaleCode : "local_verification_inconclusive",
    assessor_evidence_codes: [],
    planned_frame_count: plannedFrameCount,
    frame_extraction_status: extractionStatus,
    frame_extraction_failure_codes: unique([...failureCodes]) as VideoReasoningLocalExtractionFailureCode[],
  };
}

function assessedRecord(
  assessment: LocalFrameAssessment,
  source: VideoReasoningLocalVerificationSource,
  localWindow: VideoReasoningLocalVerificationRangeUs,
  frameTimestampsUs: readonly number[],
): Pick<VideoReasoningLocalVerificationRecord, "outcome" | "local_verified_range_us" | "rationale_code" | "assessor_evidence_codes"> {
  if (!isRecord(assessment) || typeof assessment.outcome !== "string" || !(OUTCOMES as readonly string[]).includes(assessment.outcome)) reject("assessor outcome invalid");
  if (!isCode(assessment.rationale_code)) reject("assessor rationale code invalid");
  const evidenceCodes = assessment.evidence_codes === undefined ? [] : [...assessment.evidence_codes];
  if (evidenceCodes.length > MAX_EVIDENCE_CODES || evidenceCodes.some((code) => !isCode(code)) || new Set(evidenceCodes).size !== evidenceCodes.length) reject("assessor evidence codes invalid");

  let localRange: VideoReasoningLocalVerificationRangeUs | null = null;
  if (assessment.local_verified_range_us !== undefined && assessment.local_verified_range_us !== null) {
    localRange = requiredRange(assessment.local_verified_range_us, source.source_duration_us, "assessor local verified range");
    if (!rangeInside(localRange, source.effective_source_range_us)) reject("assessor local verified range outside effective source range");
    if (!rangeInside(localRange, localWindow)) reject("assessor local verified range outside local verification window");
    if (!rangeCoveredByFrames(localRange, frameTimestampsUs)) reject("assessor local verified range is not covered by decoded local frames");
  }
  const outcome = assessment.outcome as VideoReasoningLocalVerificationOutcome;
  if ((outcome === "confirmed" || outcome === "adjusted") && (localRange === null || evidenceCodes.length === 0)) reject(`${outcome} assessor result lacks explicit range/evidence`);
  if ((outcome === "rejected" || outcome === "inconclusive") && localRange !== null) reject(`${outcome} assessor result claims a range`);
  return { outcome, local_verified_range_us: localRange, rationale_code: assessment.rationale_code, assessor_evidence_codes: evidenceCodes };
}

function extractionSummary(records: readonly VideoReasoningLocalVerificationRecord[]): VideoReasoningLocalVerificationExtraction {
  const requested = records.reduce((sum, record) => sum + record.planned_frame_count, 0);
  const decoded = records.reduce((sum, record) => sum + record.local_frame_timestamps_us.length, 0);
  const failed = records.reduce((sum, record) => sum + Math.max(0, record.planned_frame_count - record.local_frame_timestamps_us.length), 0);
  const failureCodes = unique(records.flatMap((record) => record.frame_extraction_failure_codes)).slice(0, MAX_FAILURE_CODES) as VideoReasoningLocalExtractionFailureCode[];
  return {
    tool: "ffmpeg",
    status: expectedExtractionStatus(records),
    requested_frame_count: requested,
    decoded_frame_count: decoded,
    failed_frame_count: failed,
    failure_codes: failureCodes,
  };
}

function finishArtifact(
  provider: VideoReasoningEvidenceArtifact,
  source: VideoReasoningLocalVerificationSource,
  records: VideoReasoningLocalVerificationRecord[],
  extraction: VideoReasoningLocalVerificationExtraction,
): VideoReasoningLocalVerificationArtifact {
  const body: Omit<VideoReasoningLocalVerificationArtifact, "artifact_id"> = {
    artifact_version: VIDEO_REASONING_LOCAL_VERIFICATION_ARTIFACT_VERSION,
    artifact_kind: "derived_local_verification",
    authority: "derived_evidence_only",
    provider_evidence_artifact_id: provider.artifact_id,
    provider_evidence_artifact_sha256: contentSha256(provider),
    source,
    verification_status: expectedVerificationStatus(records),
    extraction,
    records,
  };
  const artifact: VideoReasoningLocalVerificationArtifact = { artifact_id: contentId("VLRV_", body), ...body };
  assertVideoReasoningLocalVerificationIntegrity(artifact, provider);
  return artifact;
}

/**
 * Verify provider candidates with a bounded local frame lane. Pixel decode is
 * never semantic confirmation; only explicit assessor evidence can produce a
 * confirmed, adjusted, or rejected record.
 */
export async function verifyVideoReasoningLocally(
  provider: VideoReasoningEvidenceArtifact,
  options: VerifyVideoReasoningLocallyOptions,
): Promise<VideoReasoningLocalVerificationArtifact> {
  const providerSnapshot = frozenClone(provider);
  const providerValidation = validateVideoReasoningEvidenceIntegrity(providerSnapshot);
  if (!providerValidation.valid) reject(`provider evidence integrity: ${providerValidation.errors.join(",")}`);
  if (providerSnapshot.observations.length > MAX_RECORDS) reject("provider observation count exceeds local bound");
  const observationIds = new Set<string>();
  for (const observation of providerSnapshot.observations) {
    if (observationIds.has(observation.observation_id)) reject("duplicate provider observation id");
    observationIds.add(observation.observation_id);
  }

  const source = frozenClone(sourceFromProvider(providerSnapshot));
  const sourcePath = path.resolve(options.sourcePath);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(sourcePath);
  } catch {
    reject("source_file_unavailable");
  }
  if (!stat.isFile()) reject("source_file_not_regular");
  let actualHash: string;
  try {
    actualHash = sha256FileHex(sourcePath);
  } catch {
    reject("source_content_hash_failed");
  }
  if (actualHash !== source.source_content_sha256) reject("source_content_identity_mismatch");

  const framesPerObservation = options.framesPerObservation ?? DEFAULT_FRAMES_PER_OBSERVATION;
  const maxTotalFrames = options.maxTotalFrames ?? DEFAULT_MAX_TOTAL_FRAMES;
  if (!isSafeUs(framesPerObservation) || framesPerObservation < 1 || framesPerObservation > MAX_FRAMES_PER_OBSERVATION) reject("invalid framesPerObservation");
  if (!isSafeUs(maxTotalFrames) || maxTotalFrames < 1 || maxTotalFrames > MAX_TOTAL_FRAMES) reject("invalid maxTotalFrames");

  const outputParent = path.resolve(options.outputDir ?? os.tmpdir());
  fs.mkdirSync(outputParent, { recursive: true });
  const runOutputDir = fs.mkdtempSync(path.join(outputParent, ".vos-local-verification-"));
  const records: VideoReasoningLocalVerificationRecord[] = [];
  try {
    let remainingFrames = maxTotalFrames;
    for (const [index, observation] of providerSnapshot.observations.entries()) {
      const localWindow = localVerificationWindow(
        observation.provider_range_us,
        source.effective_source_range_us,
        LOCAL_VERIFICATION_WINDOW_PADDING_US,
      );
      const planned = Math.min(framesPerObservation, remainingFrames);
      if (planned === 0) {
        records.push(inconclusiveRecord(source, observation, localWindow, 0, "unavailable", ["insufficient_frames"], "insufficient_frames"));
        continue;
      }
      const timestamps = planDenseFrameTimestamps(localWindow, { frameCount: planned });
      remainingFrames -= timestamps.length;
      const extraction = await extractDenseFrames(sourcePath, timestamps, {
        outputDir: path.join(runOutputDir, `observation-${String(index).padStart(2, "0")}`),
        runner: options.runner,
      });
      const failures = unique(extraction.failures.map((failure) => failure.code)) as VideoReasoningLocalExtractionFailureCode[];
      if (extraction.decoded_timestamps_us.length < timestamps.length && !failures.includes("insufficient_frames")) {
        failures.push("insufficient_frames");
      }
      if (extraction.status !== "complete") {
        records.push(inconclusiveRecord(source, observation, localWindow, timestamps.length, extraction.status, failures.length > 0 ? failures : ["frame_not_decoded"], failures[0] ?? "frame_not_decoded", extraction.decoded_timestamps_us));
        continue;
      }

      if (!options.assessor) {
        records.push(inconclusiveRecord(source, observation, localWindow, timestamps.length, "complete", [], "assessor_not_provided", extraction.decoded_timestamps_us));
        continue;
      }
      let assessment: LocalFrameAssessment | undefined;
      try {
        const assessorInput: LocalFrameAssessorInput = frozenClone({
          provider_observation: observation,
          source,
          provider_requested_range_us: [...source.effective_source_range_us] as VideoReasoningLocalVerificationRangeUs,
          provider_candidate_range_us: [...observation.provider_range_us] as VideoReasoningLocalVerificationRangeUs,
          local_verification_window_us: [...localWindow] as VideoReasoningLocalVerificationRangeUs,
          frame_timestamps_us: extraction.decoded_timestamps_us,
          frame_paths: extraction.frames.map((frame) => frame.path),
        });
        assessment = await options.assessor(assessorInput);
      } catch {
        assessment = undefined;
      }
      if (assessment === undefined) {
        records.push(inconclusiveRecord(source, observation, localWindow, timestamps.length, "complete", [], "assessor_failed", extraction.decoded_timestamps_us));
        continue;
      }
      try {
        records.push({
          ...inconclusiveRecord(source, observation, localWindow, timestamps.length, "complete", [], assessment.rationale_code, extraction.decoded_timestamps_us),
          ...assessedRecord(assessment, source, localWindow, extraction.decoded_timestamps_us),
        });
      } catch {
        records.push(inconclusiveRecord(source, observation, localWindow, timestamps.length, "complete", [], "assessor_invalid", extraction.decoded_timestamps_us));
      }
    }

    const extraction = providerSnapshot.observations.length === 0
      ? { tool: "ffmpeg" as const, status: "unavailable" as const, requested_frame_count: 0, decoded_frame_count: 0, failed_frame_count: 0, failure_codes: ["no_provider_observations" as const] }
      : extractionSummary(records);
    return finishArtifact(providerSnapshot, source, records, extraction);
  } finally {
    fs.rmSync(runOutputDir, { recursive: true, force: true });
  }
}
