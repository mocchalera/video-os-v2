// Candidate Reference Utilities
// Deterministic candidate_id generation and legacy shim.

import { createHash } from "node:crypto";
import type { Candidate } from "./types.js";

/**
 * Generate a deterministic candidate_id from the authored candidate window.
 * Same inputs always produce the same id.
 *
 * Hash input: project_id + segment_id + asset_id + src_in_us + src_out_us + role
 * Output: URL-safe short string prefixed with "cand_"
 */
export function generateCandidateId(
  projectId: string,
  candidate: Pick<Candidate, "segment_id" | "asset_id" | "src_in_us" | "src_out_us" | "role">,
): string {
  const input = [
    projectId,
    candidate.segment_id,
    candidate.asset_id,
    String(candidate.src_in_us),
    String(candidate.src_out_us),
    candidate.role,
  ].join("|");

  const hash = createHash("sha256").update(input).digest("base64url");
  return `cand_${hash.slice(0, 12)}`;
}

/**
 * Legacy shim: synthesize a candidate_id for artifacts that lack one.
 * Format: "legacy:{segment_id}:{src_in_us}:{src_out_us}"
 *
 * This shim is for compile compatibility only and must not be
 * written back to canonical artifacts.
 */
export function legacyCandidateId(
  candidate: Pick<Candidate, "segment_id" | "src_in_us" | "src_out_us">,
): string {
  return `legacy:${candidate.segment_id}:${candidate.src_in_us}:${candidate.src_out_us}`;
}

/**
 * Get the candidate_ref for a candidate, using candidate_id if available,
 * falling back to legacy shim.
 */
export function getCandidateRef(candidate: Candidate): string {
  return candidate.candidate_id ?? legacyCandidateId(candidate);
}

/**
 * Build a lookup map from candidate_ref to candidate.
 * Supports both candidate_id and legacy shim.
 */
export function buildCandidateRefMap(candidates: Candidate[]): Map<string, Candidate> {
  const map = new Map<string, Candidate>();
  for (const c of candidates) {
    const ref = getCandidateRef(c);
    map.set(ref, c);
    // Also index by segment_id for backward compat
    if (!map.has(c.segment_id)) {
      map.set(c.segment_id, c);
    }
  }
  return map;
}

/**
 * Assign candidate_id to all candidates that don't have one.
 * Returns the mutated array.
 */
export function ensureCandidateIds(
  projectId: string,
  candidates: Candidate[],
): Candidate[] {
  for (const c of candidates) {
    if (!c.candidate_id) {
      c.candidate_id = generateCandidateId(projectId, c);
    }
  }
  return candidates;
}
