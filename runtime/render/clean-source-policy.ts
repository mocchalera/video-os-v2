import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import {
  isKnownGeneratedVideoPath,
  type MediaSourceOrigin,
} from "../media/source-origin.js";

export const CLEAN_BASE_ATTESTATION_VERSION = "clean-base-attestation/v1" as const;

export interface CleanBaseAttestationRef {
  path: string;
  sha256: string;
}

export interface CleanBaseAttestation {
  version: typeof CLEAN_BASE_ATTESTATION_VERSION;
  subject: {
    content_sha256: string;
  };
  claim: "caption_free_clean_base";
  verification: {
    method: "human_full_duration_visual_review";
    coverage: "full_duration";
    producer_id: string;
    verifier_id: string;
    verifier_type: "human";
    verified_at: string;
    evidence: CleanBaseAttestationRef;
  };
}

export interface CleanSourcePolicyInput {
  projectDir: string;
  assetId: string;
  sourcePath: string;
  contentSha256: string;
  mediaKind: string;
  declaredOrigin?: MediaSourceOrigin;
  cleanBaseAttestation?: CleanBaseAttestationRef;
}

export interface CleanSourcePolicyResult {
  source_origin: MediaSourceOrigin;
  caption_cleanliness:
    | "original_source"
    | "independently_attested_caption_free"
    | "not_applicable";
  generated_output_detected: boolean;
  clean_base_attestation?: CleanBaseAttestationRef;
}

export class CleanSourcePolicyError extends Error {
  constructor(
    public readonly reason:
      | "rendered_source_requires_clean_base_attestation"
      | "clean_base_attestation_path_invalid"
      | "clean_base_attestation_missing"
      | "clean_base_attestation_hash_mismatch"
      | "clean_base_attestation_invalid"
      | "clean_base_attestation_subject_mismatch"
      | "clean_base_attestation_not_independent"
      | "clean_base_attestation_evidence_missing"
      | "clean_base_attestation_evidence_hash_mismatch",
    message: string,
    public readonly assetId: string,
  ) {
    super(`${reason}: ${message}`);
    this.name = "CleanSourcePolicyError";
  }
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value);
}

function computeSha256(filePath: string): string {
  const hash = createHash("sha256");
  const descriptor = fs.openSync(filePath, "r");
  const buffer = Buffer.allocUnsafe(8 * 1024 * 1024);
  try {
    for (;;) {
      const bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    fs.closeSync(descriptor);
  }
  return `sha256:${hash.digest("hex")}`;
}

function resolveProjectArtifact(projectDir: string, rawPath: string, assetId: string): string {
  if (!rawPath || path.isAbsolute(rawPath)) {
    throw new CleanSourcePolicyError(
      "clean_base_attestation_path_invalid",
      "Attestation and evidence paths must be project-relative",
      assetId,
    );
  }
  const root = path.resolve(projectDir);
  const resolved = path.resolve(root, rawPath);
  const relative = path.relative(root, resolved);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new CleanSourcePolicyError(
      "clean_base_attestation_path_invalid",
      `Path escapes the project root: ${rawPath}`,
      assetId,
    );
  }
  return resolved;
}

function readAttestation(
  input: CleanSourcePolicyInput,
  reference: CleanBaseAttestationRef,
): CleanBaseAttestation {
  if (!isSha256(reference.sha256)) {
    throw new CleanSourcePolicyError(
      "clean_base_attestation_invalid",
      "Attestation reference has an invalid SHA-256",
      input.assetId,
    );
  }
  const attestationPath = resolveProjectArtifact(input.projectDir, reference.path, input.assetId);
  if (!fs.existsSync(attestationPath)) {
    throw new CleanSourcePolicyError(
      "clean_base_attestation_missing",
      `Attestation not found: ${reference.path}`,
      input.assetId,
    );
  }
  const actualHash = computeSha256(attestationPath);
  if (actualHash !== reference.sha256) {
    throw new CleanSourcePolicyError(
      "clean_base_attestation_hash_mismatch",
      `Attestation hash mismatch (${reference.sha256} != ${actualHash})`,
      input.assetId,
    );
  }
  let value: CleanBaseAttestation;
  try {
    value = JSON.parse(fs.readFileSync(attestationPath, "utf8")) as CleanBaseAttestation;
  } catch (error) {
    throw new CleanSourcePolicyError(
      "clean_base_attestation_invalid",
      error instanceof Error ? error.message : String(error),
      input.assetId,
    );
  }
  const verification = value?.verification;
  if (
    value?.version !== CLEAN_BASE_ATTESTATION_VERSION
    || value?.claim !== "caption_free_clean_base"
    || !isSha256(value?.subject?.content_sha256)
    || verification?.method !== "human_full_duration_visual_review"
    || verification?.coverage !== "full_duration"
    || verification?.verifier_type !== "human"
    || typeof verification?.producer_id !== "string"
    || verification.producer_id.trim().length === 0
    || typeof verification?.verifier_id !== "string"
    || verification.verifier_id.trim().length === 0
    || Number.isNaN(Date.parse(verification?.verified_at))
    || !verification?.evidence
    || typeof verification.evidence.path !== "string"
    || !isSha256(verification.evidence.sha256)
  ) {
    throw new CleanSourcePolicyError(
      "clean_base_attestation_invalid",
      "Attestation must contain a full-duration human review bound to hashed evidence",
      input.assetId,
    );
  }
  if (value.subject.content_sha256 !== `sha256:${input.contentSha256}`) {
    throw new CleanSourcePolicyError(
      "clean_base_attestation_subject_mismatch",
      "Attestation subject does not match the live source bytes",
      input.assetId,
    );
  }
  if (verification.producer_id === verification.verifier_id) {
    throw new CleanSourcePolicyError(
      "clean_base_attestation_not_independent",
      "Producer and verifier must be different identities",
      input.assetId,
    );
  }
  const evidencePath = resolveProjectArtifact(
    input.projectDir,
    verification.evidence.path,
    input.assetId,
  );
  if (!fs.existsSync(evidencePath)) {
    throw new CleanSourcePolicyError(
      "clean_base_attestation_evidence_missing",
      `Verification evidence not found: ${verification.evidence.path}`,
      input.assetId,
    );
  }
  const evidenceHash = computeSha256(evidencePath);
  if (evidenceHash !== verification.evidence.sha256) {
    throw new CleanSourcePolicyError(
      "clean_base_attestation_evidence_hash_mismatch",
      `Evidence hash mismatch (${verification.evidence.sha256} != ${evidenceHash})`,
      input.assetId,
    );
  }
  return value;
}

export function assertCaptionCleanSourceEligibility(
  input: CleanSourcePolicyInput,
): CleanSourcePolicyResult {
  if (!["video", "mixed", "unknown"].includes(input.mediaKind)) {
    return {
      source_origin: input.declaredOrigin ?? "original_source",
      caption_cleanliness: "not_applicable",
      generated_output_detected: false,
    };
  }

  const generatedOutputDetected = isKnownGeneratedVideoPath(input.sourcePath);
  const requiresAttestation = generatedOutputDetected
    || input.declaredOrigin === "rendered_output"
    || input.declaredOrigin === "verified_caption_free_proxy";
  if (!requiresAttestation) {
    return {
      source_origin: "original_source",
      caption_cleanliness: "original_source",
      generated_output_detected: false,
    };
  }
  if (!input.cleanBaseAttestation) {
    throw new CleanSourcePolicyError(
      "rendered_source_requires_clean_base_attestation",
      `Asset ${input.assetId} resolves to rendered/derived video and cannot be reused without an independent caption-free attestation`,
      input.assetId,
    );
  }
  readAttestation(input, input.cleanBaseAttestation);
  return {
    source_origin: "verified_caption_free_proxy",
    caption_cleanliness: "independently_attested_caption_free",
    generated_output_detected: generatedOutputDetected || input.declaredOrigin === "rendered_output",
    clean_base_attestation: input.cleanBaseAttestation,
  };
}
