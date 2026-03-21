// Phase 3: Assembly
// Build track layout (V1, V2, A1, A2, A3) by assigning best-scoring
// candidates per beat. Sets fallback_segment_ids.

import type {
  AssembledTimeline,
  Marker,
  NormalizedData,
  RankedCandidateTable,
  ScoredCandidate,
  ScoringParams,
  TimelineClip,
  Track,
} from "./types.js";

export function assemble(
  normalized: NormalizedData,
  rankedTable: RankedCandidateTable,
  params: ScoringParams,
): AssembledTimeline {
  const v1Clips: TimelineClip[] = []; // primary narrative (hero)
  const v2Clips: TimelineClip[] = []; // support / inserts
  const a1Clips: TimelineClip[] = []; // dialogue / nat sound
  const a2Clips: TimelineClip[] = []; // music (M1: empty allowed)
  const a3Clips: TimelineClip[] = []; // texture / room tone (M1: empty allowed)
  const markers: Marker[] = [];

  // Track used segments to apply adjacency penalty and prevent overuse
  const usedSegments = new Set<string>();
  let clipCounter = 0;
  let currentFrame = 0;

  // Track previous asset per track for adjacency penalty
  let prevV1Asset: string | null = null;
  let prevV2Asset: string | null = null;

  for (const beat of normalized.beats) {
    const beatCandidates = rankedTable.get(beat.beat_id) ?? [];

    // Add beat boundary marker
    markers.push({
      frame: currentFrame,
      kind: "beat",
      label: `${beat.beat_id}: ${beat.label}`,
    });

    // Collect candidates by role for this beat, applying adjacency penalty
    const byRole = groupByRole(beatCandidates);

    // V1: hero clips
    const heroClip = pickBest(
      byRole.get("hero") ?? [],
      usedSegments,
      prevV1Asset,
      params.adjacency_penalty,
    );
    if (heroClip) {
      const clip = makeClip(
        heroClip,
        beat.beat_id,
        currentFrame,
        beat.target_duration_frames,
        ++clipCounter,
        getRunnersUp(byRole.get("hero") ?? [], heroClip, usedSegments),
      );
      v1Clips.push(clip);
      usedSegments.add(heroClip.candidate.segment_id);
      prevV1Asset = heroClip.candidate.asset_id;
    }

    // V2: support + texture clips
    const supportCandidates = [
      ...(byRole.get("support") ?? []),
      ...(byRole.get("texture") ?? []),
    ];
    // Re-sort after merging (stable sort)
    supportCandidates.sort((a, b) => {
      const diff = b.score - a.score;
      if (diff !== 0) return diff;
      return a.candidate.segment_id.localeCompare(b.candidate.segment_id);
    });

    const supportClip = pickBest(
      supportCandidates,
      usedSegments,
      prevV2Asset,
      params.adjacency_penalty,
    );
    if (supportClip) {
      const clip = makeClip(
        supportClip,
        beat.beat_id,
        currentFrame,
        beat.target_duration_frames,
        ++clipCounter,
        getRunnersUp(supportCandidates, supportClip, usedSegments),
      );
      v2Clips.push(clip);
      usedSegments.add(supportClip.candidate.segment_id);
      prevV2Asset = supportClip.candidate.asset_id;
    }

    // A1: dialogue clips
    const dialogueClip = pickBest(
      byRole.get("dialogue") ?? [],
      usedSegments,
      null,
      0,
    );
    if (dialogueClip) {
      const clip = makeClip(
        dialogueClip,
        beat.beat_id,
        currentFrame,
        beat.target_duration_frames,
        ++clipCounter,
        getRunnersUp(byRole.get("dialogue") ?? [], dialogueClip, usedSegments),
      );
      a1Clips.push(clip);
      usedSegments.add(dialogueClip.candidate.segment_id);
    }

    // Transition clips go to V2 as well
    const transitionClip = pickBest(
      byRole.get("transition") ?? [],
      usedSegments,
      prevV2Asset,
      params.adjacency_penalty,
    );
    if (transitionClip) {
      const clip = makeClip(
        transitionClip,
        beat.beat_id,
        currentFrame,
        beat.target_duration_frames,
        ++clipCounter,
        getRunnersUp(byRole.get("transition") ?? [], transitionClip, usedSegments),
      );
      v2Clips.push(clip);
      usedSegments.add(transitionClip.candidate.segment_id);
      prevV2Asset = transitionClip.candidate.asset_id;
    }

    currentFrame += beat.target_duration_frames;
  }

  const video: Track[] = [
    { track_id: "V1", kind: "video", clips: v1Clips },
    { track_id: "V2", kind: "video", clips: v2Clips },
  ];

  const audio: Track[] = [
    { track_id: "A1", kind: "audio", clips: a1Clips },
    { track_id: "A2", kind: "audio", clips: [] }, // Music: M1 empty
    { track_id: "A3", kind: "audio", clips: [] }, // Texture/room tone: M1 empty
  ];

  return { tracks: { video, audio }, markers };
}

function groupByRole(
  candidates: ScoredCandidate[],
): Map<string, ScoredCandidate[]> {
  const groups = new Map<string, ScoredCandidate[]>();
  for (const c of candidates) {
    const role = c.candidate.role;
    const list = groups.get(role) ?? [];
    list.push(c);
    groups.set(role, list);
  }
  return groups;
}

function pickBest(
  candidates: ScoredCandidate[],
  usedSegments: Set<string>,
  prevAsset: string | null,
  adjacencyPenalty: number,
): ScoredCandidate | null {
  // Apply adjacency penalty and filter used segments, then pick best
  const available = candidates
    .filter((c) => !usedSegments.has(c.candidate.segment_id))
    .map((c) => {
      let adjustedScore = c.score;
      if (prevAsset !== null && c.candidate.asset_id === prevAsset) {
        adjustedScore -= adjacencyPenalty;
      }
      return { ...c, score: adjustedScore };
    });

  // Stable sort again after adjustment
  available.sort((a, b) => {
    const diff = b.score - a.score;
    if (diff !== 0) return diff;
    return a.candidate.segment_id.localeCompare(b.candidate.segment_id);
  });

  return available[0] ?? null;
}

function getRunnersUp(
  candidates: ScoredCandidate[],
  chosen: ScoredCandidate,
  usedSegments: Set<string>,
): string[] {
  return candidates
    .filter(
      (c) =>
        c.candidate.segment_id !== chosen.candidate.segment_id &&
        !usedSegments.has(c.candidate.segment_id),
    )
    .slice(0, 2)
    .map((c) => c.candidate.segment_id);
}

function makeClip(
  scored: ScoredCandidate,
  beatId: string,
  timelineInFrame: number,
  beatDurationFrames: number,
  clipNum: number,
  fallbacks: string[],
): TimelineClip {
  const c = scored.candidate;
  return {
    clip_id: `CLP_${String(clipNum).padStart(4, "0")}`,
    segment_id: c.segment_id,
    asset_id: c.asset_id,
    src_in_us: c.src_in_us,
    src_out_us: c.src_out_us,
    timeline_in_frame: timelineInFrame,
    timeline_duration_frames: beatDurationFrames,
    role: c.role as TimelineClip["role"],
    motivation: c.why_it_matches,
    beat_id: beatId,
    fallback_segment_ids: fallbacks,
    confidence: c.confidence,
    quality_flags: c.quality_flags ?? [],
  };
}
