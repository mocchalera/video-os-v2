// Phase 3: Assembly
// Build track layout (V1, V2, A1, A2, A3) by assigning best-scoring
// candidates per beat. Sets fallback_segment_ids.
//
// v5 fixes:
// - Guide mode: place ALL support/texture/dialogue per beat (not just best)
// - Guide mode: frame advancement floor = beat.target_duration_frames
// - Guide mode: global fill pass for remaining unused candidates
// - Chronological ordering support for keepsake/event-recap profiles

import type {
  AssembledTimeline,
  DurationPolicy,
  Marker,
  NormalizedData,
  RankedCandidateTable,
  ScoredCandidate,
  ScoringParams,
  TimelineClip,
  Track,
} from "./types.js";
import { getCandidateRef } from "./candidate-ref.js";

export interface AssembleOptions {
  timelineOrder?: "chronological" | "editorial";
}

export function assemble(
  normalized: NormalizedData,
  rankedTable: RankedCandidateTable,
  params: ScoringParams,
  fpsNum: number = 24,
  fpsDen: number = 1,
  durationPolicy?: DurationPolicy,
  options?: AssembleOptions,
): AssembledTimeline {
  const isGuide = durationPolicy?.mode === "guide";
  const usPerFrame = (1_000_000 * fpsDen) / fpsNum;
  const v1Clips: TimelineClip[] = []; // primary narrative (hero)
  const v2Clips: TimelineClip[] = []; // support / inserts
  const a1Clips: TimelineClip[] = []; // dialogue / nat sound
  const a2Clips: TimelineClip[] = []; // music (M1: empty allowed)
  const a3Clips: TimelineClip[] = []; // texture / room tone (M1: empty allowed)
  const markers: Marker[] = [];

  // Track used segments to apply adjacency penalty and prevent overuse
  const usedClips = new Set<string>();
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

    // V1: hero clips (always pick best 1)
    const heroClip = pickBest(
      byRole.get("hero") ?? [],
      usedClips,
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
        getRunnersUp(byRole.get("hero") ?? [], heroClip, usedClips),
        usPerFrame,
      );
      v1Clips.push(clip);
      usedClips.add(clipUsageKey(heroClip.candidate));
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

    if (isGuide) {
      // Guide mode: place ALL available support/texture clips
      const allSupport = pickAvailable(
        supportCandidates,
        usedClips,
        prevV2Asset,
        params.adjacency_penalty,
      );
      for (const sc of allSupport) {
        const clip = makeClip(
          sc,
          beat.beat_id,
          currentFrame,
          beat.target_duration_frames,
          ++clipCounter,
          { segment_ids: [], candidate_refs: [] },
          usPerFrame,
        );
        v2Clips.push(clip);
        usedClips.add(clipUsageKey(sc.candidate));
        prevV2Asset = sc.candidate.asset_id;
      }
    } else {
      // Strict mode: pick best 1
      const supportClip = pickBest(
        supportCandidates,
        usedClips,
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
          getRunnersUp(supportCandidates, supportClip, usedClips),
          usPerFrame,
        );
        v2Clips.push(clip);
        usedClips.add(clipUsageKey(supportClip.candidate));
        prevV2Asset = supportClip.candidate.asset_id;
      }
    }

    // A1: dialogue clips
    if (isGuide) {
      // Guide mode: place ALL available dialogue clips
      const allDialogue = pickAvailable(
        byRole.get("dialogue") ?? [],
        usedClips,
        null,
        0,
      );
      for (const sc of allDialogue) {
        const clip = makeClip(
          sc,
          beat.beat_id,
          currentFrame,
          beat.target_duration_frames,
          ++clipCounter,
          { segment_ids: [], candidate_refs: [] },
          usPerFrame,
        );
        a1Clips.push(clip);
        usedClips.add(clipUsageKey(sc.candidate));
      }
    } else {
      const dialogueClip = pickBest(
        byRole.get("dialogue") ?? [],
        usedClips,
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
          getRunnersUp(byRole.get("dialogue") ?? [], dialogueClip, usedClips),
          usPerFrame,
        );
        a1Clips.push(clip);
        usedClips.add(clipUsageKey(dialogueClip.candidate));
      }
    }

    // Transition clips go to V2 as well
    const transitionClip = pickBest(
      byRole.get("transition") ?? [],
      usedClips,
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
        getRunnersUp(byRole.get("transition") ?? [], transitionClip, usedClips),
        usPerFrame,
      );
      v2Clips.push(clip);
      usedClips.add(clipUsageKey(transitionClip.candidate));
      prevV2Asset = transitionClip.candidate.asset_id;
    }

    // Frame advancement
    if (isGuide) {
      // Guide mode: use at least beat.target_duration_frames as floor.
      // target_duration is "at least this much", not an upper cap.
      const beatClips = [
        ...v1Clips.filter((c) => c.beat_id === beat.beat_id),
        ...v2Clips.filter((c) => c.beat_id === beat.beat_id),
      ];
      const maxClipDuration = beatClips.reduce(
        (max, c) => Math.max(max, c.timeline_duration_frames),
        0,
      );
      currentFrame += Math.max(maxClipDuration, beat.target_duration_frames);
    } else {
      currentFrame += beat.target_duration_frames;
    }
  }

  // ── Guide mode: global fill pass ────────────────────────────────────
  // Place any remaining unused candidates that appear in the ranked table.
  // This ensures material coverage (important for keepsake profiles).
  if (isGuide) {
    const unusedMap = new Map<string, ScoredCandidate>();
    for (const [, scored] of rankedTable) {
      for (const sc of scored) {
        const key = clipUsageKey(sc.candidate);
        if (!usedClips.has(key) && !unusedMap.has(key)) {
          unusedMap.set(key, sc);
        }
      }
    }

    const unused = [...unusedMap.values()].sort((a, b) => {
      const diff = b.score - a.score;
      if (diff !== 0) return diff;
      return a.candidate.segment_id.localeCompare(b.candidate.segment_id);
    });

    const lastBeatId = normalized.beats[normalized.beats.length - 1]?.beat_id ?? "fill";

    for (const sc of unused) {
      const sourceDurationUs = sc.candidate.src_out_us - sc.candidate.src_in_us;
      const sourceDurationFrames = Math.ceil(sourceDurationUs / usPerFrame);

      const clip: TimelineClip = {
        clip_id: `CLP_${String(++clipCounter).padStart(4, "0")}`,
        segment_id: sc.candidate.segment_id,
        asset_id: sc.candidate.asset_id,
        src_in_us: sc.candidate.src_in_us,
        src_out_us: sc.candidate.src_out_us,
        timeline_in_frame: currentFrame,
        timeline_duration_frames: sourceDurationFrames,
        role: sc.candidate.role as TimelineClip["role"],
        motivation: sc.candidate.why_it_matches,
        beat_id: lastBeatId,
        fallback_segment_ids: [],
        confidence: sc.candidate.confidence,
        quality_flags: sc.candidate.quality_flags ?? [],
        candidate_ref: getCandidateRef(sc.candidate),
        fallback_candidate_refs: [],
      };

      if (sc.candidate.role === "dialogue") {
        a1Clips.push(clip);
      } else {
        v2Clips.push(clip);
      }
      usedClips.add(clipUsageKey(sc.candidate));
      currentFrame += sourceDurationFrames;
    }
  }

  // ── Chronological reorder ───────────────────────────────────────────
  // For keepsake / event-recap profiles, reorder clips by source timestamp
  // (asset_id + src_in_us) instead of editorial score order.
  if (options?.timelineOrder === "chronological") {
    reorderChronological(v1Clips, v2Clips, a1Clips, markers);
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

// ── Chronological reorder ─────────────────────────────────────────────

function reorderChronological(
  v1Clips: TimelineClip[],
  v2Clips: TimelineClip[],
  a1Clips: TimelineClip[],
  markers: Marker[],
): void {
  if (v1Clips.length <= 1) return;

  // Sort V1 clips by source timestamp (asset_id then src_in_us)
  v1Clips.sort((a, b) => {
    const assetCmp = a.asset_id.localeCompare(b.asset_id);
    if (assetCmp !== 0) return assetCmp;
    return a.src_in_us - b.src_in_us;
  });

  // Reassign V1 timeline positions sequentially
  let frame = 0;
  for (const clip of v1Clips) {
    clip.timeline_in_frame = frame;
    frame += clip.timeline_duration_frames;
  }

  // Build beat → new frame position mapping from V1
  const beatPositionMap = new Map<string, number>();
  for (const clip of v1Clips) {
    if (!beatPositionMap.has(clip.beat_id)) {
      beatPositionMap.set(clip.beat_id, clip.timeline_in_frame);
    }
  }

  // Reorder V2 and A1 clips to follow the new beat positions
  for (const clips of [v2Clips, a1Clips]) {
    clips.sort((a, b) => {
      const posA = beatPositionMap.get(a.beat_id) ?? 0;
      const posB = beatPositionMap.get(b.beat_id) ?? 0;
      if (posA !== posB) return posA - posB;
      return a.src_in_us - b.src_in_us;
    });

    // Update timeline_in_frame to match new beat positions
    for (const clip of clips) {
      const newFrame = beatPositionMap.get(clip.beat_id);
      if (newFrame != null) {
        clip.timeline_in_frame = newFrame;
      }
    }
  }

  // Update beat markers to match new positions and re-sort
  for (const marker of markers) {
    if (marker.kind === "beat") {
      const beatId = marker.label.split(":")[0].trim();
      const newFrame = beatPositionMap.get(beatId);
      if (newFrame != null) {
        marker.frame = newFrame;
      }
    }
  }
  markers.sort((a, b) => a.frame - b.frame);
}

// ── Helpers ───────────────────────────────────────────────────────────

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

/**
 * Unique key for a candidate's source range.
 * Uses segment_id + src_in_us + src_out_us so that different sub-ranges
 * of the same segment (e.g. multiple interview excerpts from one long take)
 * are treated as distinct clips rather than duplicates.
 */
function clipUsageKey(c: { segment_id: string; src_in_us: number; src_out_us: number }): string {
  return `${c.segment_id}:${c.src_in_us}:${c.src_out_us}`;
}

function pickBest(
  candidates: ScoredCandidate[],
  usedClips: Set<string>,
  prevAsset: string | null,
  adjacencyPenalty: number,
): ScoredCandidate | null {
  // Apply adjacency penalty and filter used source ranges, then pick best
  const available = candidates
    .filter((c) => !usedClips.has(clipUsageKey(c.candidate)))
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

/**
 * Return ALL available candidates (guide mode fill).
 * Same logic as pickBest but returns the full sorted list.
 */
function pickAvailable(
  candidates: ScoredCandidate[],
  usedClips: Set<string>,
  prevAsset: string | null,
  adjacencyPenalty: number,
): ScoredCandidate[] {
  const available = candidates
    .filter((c) => !usedClips.has(clipUsageKey(c.candidate)))
    .map((c) => {
      let adjustedScore = c.score;
      if (prevAsset !== null && c.candidate.asset_id === prevAsset) {
        adjustedScore -= adjacencyPenalty;
      }
      return { ...c, score: adjustedScore };
    });

  available.sort((a, b) => {
    const diff = b.score - a.score;
    if (diff !== 0) return diff;
    return a.candidate.segment_id.localeCompare(b.candidate.segment_id);
  });

  return available;
}

function getRunnersUp(
  candidates: ScoredCandidate[],
  chosen: ScoredCandidate,
  usedClips: Set<string>,
): { segment_ids: string[]; candidate_refs: string[] } {
  const runners = candidates
    .filter(
      (c) =>
        clipUsageKey(c.candidate) !== clipUsageKey(chosen.candidate) &&
        !usedClips.has(clipUsageKey(c.candidate)),
    )
    .slice(0, 2);
  return {
    segment_ids: runners.map((c) => c.candidate.segment_id),
    candidate_refs: runners.map((c) => getCandidateRef(c.candidate)),
  };
}

function makeClip(
  scored: ScoredCandidate,
  beatId: string,
  timelineInFrame: number,
  beatDurationFrames: number,
  clipNum: number,
  fallbacks: { segment_ids: string[]; candidate_refs: string[] },
  usPerFrame: number,
): TimelineClip {
  const c = scored.candidate;
  // Cap timeline_duration_frames at the source material's actual duration.
  // Without this, a 10s clip assigned to a 40s beat would play in slow motion.
  const sourceDurationUs = c.src_out_us - c.src_in_us;
  const sourceDurationFrames = Math.ceil(sourceDurationUs / usPerFrame);
  const clampedDurationFrames = Math.min(beatDurationFrames, sourceDurationFrames);

  return {
    clip_id: `CLP_${String(clipNum).padStart(4, "0")}`,
    segment_id: c.segment_id,
    asset_id: c.asset_id,
    src_in_us: c.src_in_us,
    src_out_us: c.src_out_us,
    timeline_in_frame: timelineInFrame,
    timeline_duration_frames: clampedDurationFrames,
    role: c.role as TimelineClip["role"],
    motivation: c.why_it_matches,
    beat_id: beatId,
    fallback_segment_ids: fallbacks.segment_ids,
    confidence: c.confidence,
    quality_flags: c.quality_flags ?? [],
    candidate_ref: getCandidateRef(c),
    fallback_candidate_refs: fallbacks.candidate_refs,
  };
}
