// Script Engine Phase B: Material Reading
// Reads triage-processed selects_candidates and organizes candidates
// per beat with top/backup assignments, coverage gaps, and dedupe groups.
// Semi-deterministic phase.

import type { Candidate, EditBlueprint, NormalizedBeat } from "../compiler/types.js";
import { getCandidateRef } from "../compiler/candidate-ref.js";

export interface BeatReading {
  beat_id: string;
  top_candidates: Array<{ candidate_ref: string; why_primary: string }>;
  backup_candidates: Array<{ candidate_ref: string; why_backup?: string }>;
  coverage_gaps: string[];
  asset_concentration: number;
  speaker_risks: string[];
  tone_risks: string[];
}

export interface MaterialReading {
  version: string;
  project_id: string;
  created_at: string;
  beat_readings: BeatReading[];
  dedupe_groups: Array<{ key: string; candidate_refs: string[] }>;
}

export interface ReadInput {
  projectId: string;
  createdAt: string;
  beats: NormalizedBeat[];
  candidates: Candidate[];
  blueprint: EditBlueprint;
}

/**
 * Deterministic material reading: assign candidates to beats
 * based on role matching, eligibility, and confidence.
 */
export function buildMaterialReading(input: ReadInput): MaterialReading {
  const nonReject = input.candidates.filter((c) => c.role !== "reject");

  // Build dedupe groups by semantic_dedupe_key
  const dedupeMap = new Map<string, string[]>();
  for (const c of nonReject) {
    const key = c.semantic_dedupe_key ?? getCandidateRef(c);
    const refs = dedupeMap.get(key) ?? [];
    refs.push(getCandidateRef(c));
    dedupeMap.set(key, refs);
  }
  const dedupe_groups = [...dedupeMap.entries()]
    .filter(([, refs]) => refs.length > 1)
    .map(([key, candidate_refs]) => ({ key, candidate_refs }));

  // Build per-beat readings
  const beat_readings: BeatReading[] = [];

  for (const beat of input.beats) {
    // Filter candidates eligible for this beat
    const eligible = nonReject.filter((c) => {
      if (c.eligible_beats && c.eligible_beats.length > 0) {
        return c.eligible_beats.includes(beat.beat_id);
      }
      return true;
    });

    // Filter by role match
    const roleMatched = eligible.filter((c) => {
      const role = c.role as string;
      return beat.required_roles.includes(role as any) ||
        beat.preferred_roles.includes(role as any);
    });

    // Sort by confidence * semantic_rank
    const sorted = [...roleMatched].sort((a, b) => {
      const aScore = a.confidence * (1 / (a.semantic_rank ?? 999));
      const bScore = b.confidence * (1 / (b.semantic_rank ?? 999));
      return bScore - aScore;
    });

    const top = sorted.slice(0, 2);
    const backup = sorted.slice(2, 4);

    // Check coverage gaps
    const coverage_gaps: string[] = [];
    for (const reqRole of beat.required_roles) {
      if (!sorted.some((c) => c.role === reqRole)) {
        coverage_gaps.push(`Missing ${reqRole} for beat ${beat.beat_id}`);
      }
    }

    // Asset concentration: ratio of candidates from the most-used asset
    const assetCounts = new Map<string, number>();
    for (const c of sorted) {
      assetCounts.set(c.asset_id, (assetCounts.get(c.asset_id) ?? 0) + 1);
    }
    const maxAssetCount = Math.max(0, ...assetCounts.values());
    const asset_concentration = sorted.length > 0 ? maxAssetCount / sorted.length : 0;

    // Speaker risks: interviewer in hero position
    const speaker_risks: string[] = [];
    for (const c of top) {
      if (c.speaker_role === "interviewer" && c.role === "hero") {
        speaker_risks.push(`Interviewer as hero in beat ${beat.beat_id}`);
      }
    }

    // Tone risks: low confidence in primary
    const tone_risks: string[] = [];
    if (top.length > 0 && top[0].confidence < 0.5) {
      tone_risks.push(`Low confidence primary (${top[0].confidence}) in beat ${beat.beat_id}`);
    }

    beat_readings.push({
      beat_id: beat.beat_id,
      top_candidates: top.map((c) => ({
        candidate_ref: getCandidateRef(c),
        why_primary: c.why_it_matches,
      })),
      backup_candidates: backup.map((c) => ({
        candidate_ref: getCandidateRef(c),
        why_backup: c.why_it_matches,
      })),
      coverage_gaps,
      asset_concentration,
      speaker_risks,
      tone_risks,
    });
  }

  return {
    version: "1",
    project_id: input.projectId,
    created_at: input.createdAt,
    beat_readings,
    dedupe_groups,
  };
}
