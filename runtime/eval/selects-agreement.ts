// Selects agreement — how closely a candidate selects_candidates.yaml
// agrees with the golden's selection of segments, roles, and ranking.

import type { Candidate, SelectsCandidates } from "../artifacts/types.js";
import {
  clamp01,
  jaccard,
  matchSegments,
  spearmanCorrelation,
} from "./matching.js";
import type { MatchableSegment, SelectsAgreementReport } from "./types.js";

function toMatchable(c: Candidate): MatchableSegment {
  return {
    id: c.segment_id,
    asset_id: c.asset_id,
    src_in_us: c.src_in_us,
    src_out_us: c.src_out_us,
  };
}

function activeCandidates(selects: SelectsCandidates): Candidate[] {
  return selects.candidates.filter((c) => c.role !== "reject");
}

export function evaluateSelectsAgreement(
  golden: SelectsCandidates,
  candidate: SelectsCandidates,
): SelectsAgreementReport {
  const goldenActive = activeCandidates(golden);
  const candidateActive = activeCandidates(candidate);

  // Golden and candidate must use separate lookups — the same segment
  // can exist on both sides with different roles/ranks.
  const candidateKey = (c: Candidate): string =>
    `${c.segment_id}:${c.src_in_us}:${c.src_out_us}`;
  const matchableKey = (m: MatchableSegment): string =>
    `${m.id}:${m.src_in_us}:${m.src_out_us}`;
  const goldenByKey = new Map(goldenActive.map((c) => [candidateKey(c), c]));
  const candidateByKey = new Map(candidateActive.map((c) => [candidateKey(c), c]));

  const match = matchSegments(
    goldenActive.map(toMatchable),
    candidateActive.map(toMatchable),
  );

  const matchedCount = match.pairs.length;
  const precision = candidateActive.length > 0 ? matchedCount / candidateActive.length : 0;
  const recall = goldenActive.length > 0 ? matchedCount / goldenActive.length : 0;
  const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;

  // Role agreement over matched pairs.
  let roleMatches = 0;
  const goldenRanks: number[] = [];
  const candidateRanks: number[] = [];
  const beatOverlaps: number[] = [];
  for (const pair of match.pairs) {
    const g = goldenByKey.get(matchableKey(pair.golden));
    const c = candidateByKey.get(matchableKey(pair.candidate));
    if (!g || !c) continue;
    if (g.role === c.role) roleMatches += 1;
    if (g.semantic_rank !== undefined && c.semantic_rank !== undefined) {
      goldenRanks.push(g.semantic_rank);
      candidateRanks.push(c.semantic_rank);
    }
    if (g.eligible_beats && c.eligible_beats) {
      beatOverlaps.push(jaccard(new Set(g.eligible_beats), new Set(c.eligible_beats)));
    }
  }

  const roleAgreement = matchedCount > 0 ? roleMatches / matchedCount : null;
  const rankCorrelation = spearmanCorrelation(goldenRanks, candidateRanks);
  const beatEligibilityOverlap =
    beatOverlaps.length > 0
      ? beatOverlaps.reduce((s, v) => s + v, 0) / beatOverlaps.length
      : null;

  // Composite: selection overlap dominates; role/rank/beat refine it.
  const parts: Array<{ value: number; weight: number }> = [
    { value: f1, weight: 0.6 },
  ];
  if (roleAgreement !== null) parts.push({ value: roleAgreement, weight: 0.2 });
  if (rankCorrelation !== null) parts.push({ value: (rankCorrelation + 1) / 2, weight: 0.1 });
  if (beatEligibilityOverlap !== null) parts.push({ value: beatEligibilityOverlap, weight: 0.1 });
  const totalWeight = parts.reduce((s, p) => s + p.weight, 0);
  const score = clamp01(parts.reduce((s, p) => s + p.value * p.weight, 0) / totalWeight);

  return {
    golden_count: goldenActive.length,
    candidate_count: candidateActive.length,
    matched_count: matchedCount,
    precision,
    recall,
    f1,
    role_agreement: roleAgreement,
    rank_correlation: rankCorrelation,
    beat_eligibility_overlap: beatEligibilityOverlap,
    missing_from_candidate: match.unmatched_golden.map((m) => m.id),
    extra_in_candidate: match.unmatched_candidate.map((m) => m.id),
    score,
  };
}
