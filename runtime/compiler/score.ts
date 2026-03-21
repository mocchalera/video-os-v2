// Phase 2: Candidate Scoring
// Deterministic scoring of each candidate against each beat.
// No LLM calls. No randomness.

import type {
  Candidate,
  NormalizedBeat,
  NormalizedData,
  RankedCandidateTable,
  ScoredCandidate,
  ScoringParams,
} from "./types.js";

export function scoreCandidates(
  normalized: NormalizedData,
  candidates: Candidate[],
  params: ScoringParams,
  fpsNum: number,
  fpsDen: number,
): RankedCandidateTable {
  const usPerFrame = (1_000_000 * fpsDen) / fpsNum;
  const nonReject = candidates.filter((c) => c.role !== "reject");

  // Pre-compute global motif usage counts for reuse penalty
  const motifCounts = new Map<string, number>();
  for (const c of nonReject) {
    for (const tag of c.motif_tags ?? []) {
      motifCounts.set(tag, (motifCounts.get(tag) ?? 0) + 1);
    }
  }

  // Pre-compute per-beat asset sets for adjacency penalty.
  // For each beat, track which asset_ids are eligible so we can penalize
  // candidates whose asset also appears in adjacent beats.
  const beatAssetSets = new Map<string, Set<string>>();
  for (const beat of normalized.beats) {
    const assets = new Set<string>();
    for (const c of nonReject) {
      if (
        c.eligible_beats &&
        c.eligible_beats.length > 0 &&
        !c.eligible_beats.includes(beat.beat_id)
      ) continue;
      assets.add(c.asset_id);
    }
    beatAssetSets.set(beat.beat_id, assets);
  }

  // Build ordered beat list for adjacency lookups
  const beatOrder = normalized.beats.map((b) => b.beat_id);

  const table: RankedCandidateTable = new Map();

  for (const beat of normalized.beats) {
    const scored: ScoredCandidate[] = [];

    for (const candidate of nonReject) {
      // Skip if candidate is not eligible for this beat
      if (
        candidate.eligible_beats &&
        candidate.eligible_beats.length > 0 &&
        !candidate.eligible_beats.includes(beat.beat_id)
      ) {
        continue;
      }

      // Skip if candidate's role is not required or preferred for this beat
      const isRequired = beat.required_roles.includes(candidate.role as typeof beat.required_roles[number]);
      const isPreferred = beat.preferred_roles.includes(candidate.role as typeof beat.preferred_roles[number]);
      if (!isRequired && !isPreferred) {
        continue;
      }

      // Compute adjacency: if this candidate's asset appears in adjacent beats,
      // it risks back-to-back same-asset usage.
      const beatIdx = beatOrder.indexOf(beat.beat_id);
      let adjacentAssetOverlap = 0;
      for (const offset of [-1, 1]) {
        const adjIdx = beatIdx + offset;
        if (adjIdx >= 0 && adjIdx < beatOrder.length) {
          const adjAssets = beatAssetSets.get(beatOrder[adjIdx]);
          if (adjAssets?.has(candidate.asset_id)) {
            adjacentAssetOverlap++;
          }
        }
      }

      const entry = scoreCandidate(
        candidate,
        beat,
        params,
        usPerFrame,
        motifCounts,
        adjacentAssetOverlap,
      );
      scored.push(entry);
    }

    // Stable sort: by score descending, tiebreak by segment_id ascending
    scored.sort((a, b) => {
      const diff = b.score - a.score;
      if (diff !== 0) return diff;
      return a.candidate.segment_id.localeCompare(b.candidate.segment_id);
    });

    table.set(beat.beat_id, scored);
  }

  return table;
}

function scoreCandidate(
  candidate: Candidate,
  beat: NormalizedBeat,
  params: ScoringParams,
  usPerFrame: number,
  motifCounts: Map<string, number>,
  adjacentAssetOverlap: number,
): ScoredCandidate {
  // 1. Semantic rank score: higher rank (lower number) → higher score
  //    Normalize: 1.0 for rank 1, decaying. Use 1 / rank.
  const rank = candidate.semantic_rank ?? 999;
  const semanticRankScore = 1.0 / rank;

  // 2. Quality flag penalty
  const flagCount = candidate.quality_flags?.length ?? 0;
  const qualityPenalty = flagCount * params.quality_flag_penalty;

  // 3. Duration fit: how well the candidate's duration matches the beat's target
  const candidateDurationUs = candidate.src_out_us - candidate.src_in_us;
  const candidateDurationFrames = candidateDurationUs / usPerFrame;
  const targetFrames = beat.target_duration_frames;
  const durationDiff = Math.abs(candidateDurationFrames - targetFrames);

  let durationFitScore: number;
  if (durationDiff <= params.duration_fit_tolerance_frames) {
    durationFitScore = 1.0;
  } else if (durationDiff <= params.beat_alignment_tolerance_frames) {
    // Linear decay from 1.0 to 0.5
    const range = params.beat_alignment_tolerance_frames - params.duration_fit_tolerance_frames;
    const excess = durationDiff - params.duration_fit_tolerance_frames;
    durationFitScore = 1.0 - 0.5 * (excess / range);
  } else {
    // Further decay, minimum 0.1
    const excess = durationDiff - params.beat_alignment_tolerance_frames;
    durationFitScore = Math.max(0.1, 0.5 - 0.01 * excess);
  }

  // 4. Motif reuse penalty: penalize candidates whose motif tags are overused
  let motifReusePenalty = 0;
  for (const tag of candidate.motif_tags ?? []) {
    const count = motifCounts.get(tag) ?? 0;
    if (count > params.motif_reuse_max) {
      motifReusePenalty += 0.05 * (count - params.motif_reuse_max);
    }
  }

  // 5. Adjacency penalty: penalize candidates whose asset appears in
  //    adjacent beats, as they risk back-to-back same-asset usage.
  //    Assembly may apply additional sequential adjustments.
  const adjacencyPenalty = adjacentAssetOverlap * params.adjacency_penalty;

  // Final score: weighted sum
  const score =
    semanticRankScore * 0.4 +
    durationFitScore * 0.3 -
    qualityPenalty -
    motifReusePenalty -
    adjacencyPenalty;

  return {
    candidate,
    beat_id: beat.beat_id,
    score,
    breakdown: {
      semantic_rank_score: semanticRankScore,
      quality_penalty: qualityPenalty,
      duration_fit_score: durationFitScore,
      motif_reuse_penalty: motifReusePenalty,
      adjacency_penalty: adjacencyPenalty,
    },
  };
}
