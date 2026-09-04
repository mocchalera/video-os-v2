/**
 * Generic beat model for the editorial storyboard projection.
 *
 * Builds one card per canonical blueprint beat, resolves primary/fallback
 * candidate references without silent fallbacks, selects representative
 * frames by a documented deterministic order, and (for timeline/compare
 * modes) attaches compiled placement with gap / overrun / trim deltas.
 */

import {
  buildCandidateRefIndex,
  collectUncertainties,
  resolveBinding,
  type LoadedArtifacts,
  type TimelineClip,
  type TimelineDoc,
} from "./load.js";
import type {
  BeatCompiledPlacement,
  CompiledClipInfo,
  ResolvedCandidateBinding,
  RepresentativeFramePlan,
  StoryboardBeat,
  StoryboardMediaKind,
  UnassignedClipWarning,
} from "./types.js";

interface SegmentMidpointLike {
  segment_id: string;
  src_in_us: number;
  src_out_us: number;
}

export interface BeatModelResult {
  beats: StoryboardBeat[];
  unassignedWarnings: UnassignedClipWarning[];
}

export function buildBeatModel(
  loaded: LoadedArtifacts,
  mode: "blueprint" | "timeline" | "compare",
): BeatModelResult {
  const candidates = loaded.selects?.candidates ?? [];
  const index = buildCandidateRefIndex(loaded.blueprint.project_id ?? "", candidates);

  let planCursor = 0;
  const beats: StoryboardBeat[] = loaded.blueprint.beats.map((beatBlueprint) => {
    const primaryRef = beatBlueprint.candidate_plan?.primary_candidate_ref ?? null;
    const fallbackRefs = beatBlueprint.candidate_plan?.fallback_candidate_refs ?? [];
    const primary = primaryRef ? resolveBinding(primaryRef, index, loaded.sourceMapEntries) : null;
    const fallbacks = fallbackRefs.map((ref) => resolveBinding(ref, index, loaded.sourceMapEntries));

    const warnings: string[] = [];
    const invalidReasons: string[] = [];
    if (primary && !primary.resolved) {
      invalidReasons.push(
        `primary candidate "${primary.ref}" could not be resolved against selects_candidates.yaml`,
      );
    }
    for (const fallback of fallbacks) {
      if (!fallback.resolved) {
        invalidReasons.push(
          `fallback candidate "${fallback.ref}" could not be resolved against selects_candidates.yaml`,
        );
      }
    }
    if (!primaryRef) {
      warnings.push("beat has no candidate_plan.primary_candidate_ref; showing plan-only card");
    }
    if (primary?.resolved && primary.asset_missing) {
      warnings.push(
        `source asset ${primary.asset_id ?? "?"} is missing from 02_media/source_map.json or its file is absent; frame extraction will be skipped`,
      );
    }

    const mediaKind = primary?.resolved ? primary.media_kind : "unknown";
    const representative = selectRepresentativeTimestamp({
      binding: primary,
      segmentsBySegmentId: loaded.segmentsBySegmentId,
      mediaKind,
    });

    const planStart = planCursor;
    planCursor += beatBlueprint.target_duration_frames;

    return {
      index: 0,
      beat_id: beatBlueprint.id,
      label: beatBlueprint.label,
      viewer_label: beatBlueprint.viewer_label ?? null,
      purpose: beatBlueprint.purpose ?? null,
      story_role: beatBlueprint.story_role ?? null,
      required_roles: [...beatBlueprint.required_roles],
      notes: beatBlueprint.notes ?? null,
      media_kind: mediaKind,
      plan_start_frame: planStart,
      plan_duration_frames: beatBlueprint.target_duration_frames,
      primary,
      fallbacks,
      representative,
      transcript_excerpt:
        primary?.transcript_excerpt ??
        fallbacks.find((fallback) => fallback.transcript_excerpt)?.transcript_excerpt ??
        null,
      uncertainties: [],
      warnings,
      invalid_reasons: invalidReasons,
      compiled: null,
    } satisfies StoryboardBeat;
  });
  beats.forEach((beat, i) => {
    beat.index = i + 1;
  });

  attachUncertainties(loaded, beats);

  let unassignedWarnings: UnassignedClipWarning[] = [];
  if (mode !== "blueprint" && loaded.timeline) {
    unassignedWarnings = attachCompiledPlacement(beats, loaded.timeline).unassigned;
  }

  return { beats, unassignedWarnings };
}

// ── Representative frame selection ──────────────────────────────────

/**
 * Deterministic representative timestamp order (Issue #7):
 * 1. authored freeze-frame timestamp
 * 2. still image (the image itself is the visual)
 * 3. trim_hint.source_center_us
 * 4. selected peak / recommended trim range center
 * 5. candidate source range midpoint
 * 6. analysis segment midpoint fallback
 */
export function selectRepresentativeTimestamp(options: {
  binding: ResolvedCandidateBinding | null;
  segmentsBySegmentId: Map<string, SegmentMidpointLike>;
  mediaKind: StoryboardMediaKind;
}): RepresentativeFramePlan {
  const binding = options.binding;
  if (!binding || !binding.resolved) {
    return {
      timestamp_us: null,
      basis: "unavailable",
      basis_detail: binding
        ? `candidate "${binding.ref}" is unresolved; no representative frame can be selected`
        : "beat declares no primary candidate",
      source_asset_id: null,
      source_asset_hash: null,
    };
  }

  const base = {
    source_asset_id: binding.asset_id,
    source_asset_hash: binding.asset_hash,
  };

  if (binding.freeze_frame_hold && binding.freeze_frame_hold.source_time_us !== null) {
    return {
      timestamp_us: binding.freeze_frame_hold.source_time_us,
      basis: "authored_freeze_frame",
      basis_detail: `authored freeze_frame_hold.source_time_us (${binding.freeze_frame_hold.source_time_us}us)`,
      ...base,
    };
  }
  if (options.mediaKind === "image") {
    return {
      timestamp_us: null,
      basis: "still_image",
      basis_detail: "still image candidate; the source image itself is the representative visual",
      ...base,
    };
  }
  if (binding.trim_hint?.source_center_us != null) {
    return {
      timestamp_us: binding.trim_hint.source_center_us,
      basis: "trim_hint_center",
      basis_detail: `trim_hint.source_center_us (${binding.trim_hint.source_center_us}us)`,
      ...base,
    };
  }
  if (
    binding.trim_hint?.recommended_in_us != null &&
    binding.trim_hint.recommended_out_us != null &&
    binding.trim_hint.center_source !== "midpoint_fallback"
  ) {
    const mid = Math.round(
      (binding.trim_hint.recommended_in_us + binding.trim_hint.recommended_out_us) / 2,
    );
    return {
      timestamp_us: mid,
      basis: "selected_peak",
      basis_detail: `center of selected recommended trim range [${binding.trim_hint.recommended_in_us}, ${binding.trim_hint.recommended_out_us}]${
        binding.trim_hint.peak_ref ? ` (peak_ref: ${binding.trim_hint.peak_ref})` : ""
      }`,
      ...base,
    };
  }
  if (binding.src_in_us !== null && binding.src_out_us !== null) {
    return {
      timestamp_us: Math.round((binding.src_in_us + binding.src_out_us) / 2),
      basis: "candidate_midpoint",
      basis_detail: `midpoint of candidate source range [${binding.src_in_us}, ${binding.src_out_us}]`,
      ...base,
    };
  }
  const segment = binding.segment_id
    ? options.segmentsBySegmentId.get(binding.segment_id)
    : undefined;
  if (segment) {
    return {
      timestamp_us: Math.round((segment.src_in_us + segment.src_out_us) / 2),
      basis: "segment_midpoint",
      basis_detail: `fallback midpoint of analysis segment ${segment.segment_id} [${segment.src_in_us}, ${segment.src_out_us}]`,
      ...base,
    };
  }
  return {
    timestamp_us: null,
    basis: "unavailable",
    basis_detail: "no authored hint, trim hint, peak, candidate range, or matching segment available",
    ...base,
  };
}

/** Representative plan used for fallback thumbnails. */
export function fallbackRepresentative(
  binding: ResolvedCandidateBinding,
  segmentsBySegmentId: Map<string, SegmentMidpointLike>,
): RepresentativeFramePlan {
  return selectRepresentativeTimestamp({
    binding,
    segmentsBySegmentId,
    mediaKind: binding.media_kind,
  });
}

// ── Uncertainty attachment ──────────────────────────────────────────

function attachUncertainties(loaded: LoadedArtifacts, beats: StoryboardBeat[]): void {
  const items = collectUncertainties(loaded, beats.map((beat) => beat.beat_id));
  for (const item of items) {
    for (const beatId of item.related_beat_ids) {
      const beat = beats.find((candidate) => candidate.beat_id === beatId);
      if (beat) {
        beat.uncertainties.push(`${item.id} (${item.type}, ${item.status}): ${item.question}`);
      }
    }
  }
}

// ── Compiled placement (timeline / compare modes) ───────────────────

export function flattenTimelineClips(
  timeline: TimelineDoc,
): Array<{ clip: TimelineClip; track_id: string }> {
  const rows: Array<{ clip: TimelineClip; track_id: string }> = [];
  for (const track of timeline.tracks.video) {
    for (const clip of track.clips) {
      rows.push({ clip, track_id: track.track_id });
    }
  }
  return rows.sort(
    (a, b) =>
      a.clip.timeline_in_frame - b.clip.timeline_in_frame ||
      a.track_id.localeCompare(b.track_id),
  );
}

/**
 * Reading-track gaps are computed on the first declared video track ("V1"
 * when present). Multi-track overlay clips do not create false gaps.
 */
export function readingTrackId(timeline: TimelineDoc): string | null {
  const v1 = timeline.tracks.video.find((track) => track.track_id === "V1");
  return (v1 ?? timeline.tracks.video[0])?.track_id ?? null;
}

export function timelineSpanFrames(timeline: TimelineDoc): number {
  return flattenTimelineClips(timeline).reduce(
    (max, row) => Math.max(max, row.clip.timeline_in_frame + row.clip.timeline_duration_frames),
    0,
  );
}

function attachCompiledPlacement(
  beats: StoryboardBeat[],
  timeline: TimelineDoc,
): { unassigned: UnassignedClipWarning[] } {
  const byBeatId = new Map<string, StoryboardBeat>(beats.map((beat) => [beat.beat_id, beat]));
  const rows = flattenTimelineClips(timeline);
  const readingTrack = readingTrackId(timeline);

  const candidateIndexByRefAndSegment = new Map<string, ResolvedCandidateBinding>();
  for (const beat of beats) {
    if (beat.primary?.resolved) {
      candidateIndexByRefAndSegment.set(beat.primary.ref, beat.primary);
      if (beat.primary.segment_id) {
        candidateIndexByRefAndSegment.set(beat.primary.segment_id, beat.primary);
      }
    }
    for (const fallback of beat.fallbacks) {
      if (fallback.resolved) candidateIndexByRefAndSegment.set(fallback.ref, fallback);
    }
  }

  // Pass 1: bucket clips per beat, detect unassigned references.
  const clipsByBeat = new Map<string, Array<{ clip: TimelineClip; track_id: string }>>();
  const unassigned: UnassignedClipWarning[] = [];
  for (const row of rows) {
    const beatId = typeof row.clip.beat_id === "string" ? row.clip.beat_id : null;
    if (!beatId || !byBeatId.has(beatId)) {
      unassigned.push({
        clip_id: row.clip.clip_id,
        beat_id: beatId,
        reason: beatId
          ? `compiled clip references beat_id "${beatId}" which does not exist in the blueprint`
          : "compiled clip carries no beat_id",
      });
      continue;
    }
    const bucket = clipsByBeat.get(beatId) ?? [];
    bucket.push(row);
    clipsByBeat.set(beatId, bucket);
  }

  // Pass 2: reading-track gap before each beat's first reading clip.
  const gapBeforeByClip = new Map<string, number>();
  let previousReadingEnd: number | null = null;
  for (const row of rows) {
    if (row.track_id !== readingTrack) continue;
    const start = row.clip.timeline_in_frame;
    if (previousReadingEnd !== null && start > previousReadingEnd) {
      gapBeforeByClip.set(row.clip.clip_id, start - previousReadingEnd);
    }
    previousReadingEnd = Math.max(previousReadingEnd ?? 0, start + row.clip.timeline_duration_frames);
  }

  for (const beat of beats) {
    const bucket = clipsByBeat.get(beat.beat_id) ?? [];
    if (bucket.length === 0) {
      beat.compiled = emptyPlacement();
      beat.warnings.push("no compiled clips found for this beat in timeline.json");
      continue;
    }

    const clips: CompiledClipInfo[] = bucket.map(({ clip, track_id }) => {
      const binding =
        (clip.candidate_ref ? candidateIndexByRefAndSegment.get(clip.candidate_ref) : undefined) ??
        (clip.candidate_ref === beat.primary?.ref ? beat.primary : undefined) ??
        candidateIndexByRefAndSegment.get(clip.segment_id);
      const headTrim =
        binding && binding.resolved && binding.src_in_us !== null
          ? clip.src_in_us - binding.src_in_us
          : null;
      const tailTrim =
        binding && binding.resolved && binding.src_out_us !== null
          ? binding.src_out_us - clip.src_out_us
          : null;
      return {
        clip_id: clip.clip_id,
        track_id,
        asset_id: clip.asset_id,
        segment_id: clip.segment_id,
        candidate_ref: clip.candidate_ref ?? null,
        timeline_in_frame: clip.timeline_in_frame,
        timeline_duration_frames: clip.timeline_duration_frames,
        src_in_us: clip.src_in_us,
        src_out_us: clip.src_out_us,
        head_trim_us: headTrim,
        tail_trim_us: tailTrim,
        fallback_segment_ids: [...(clip.fallback_segment_ids ?? [])],
        motivation: clip.motivation ?? null,
      };
    });

    const sortedByStart = [...clips].sort(
      (a, b) => a.timeline_in_frame - b.timeline_in_frame || a.track_id.localeCompare(b.track_id),
    );
    const startFrame = sortedByStart[0].timeline_in_frame;
    const endFrame = Math.max(
      ...sortedByStart.map((clip) => clip.timeline_in_frame + clip.timeline_duration_frames),
    );
    const compiledFrames = clips.reduce(
      (sum, clip) => sum + clip.timeline_duration_frames,
      0,
    );

    let internalGap = 0;
    for (let i = 1; i < sortedByStart.length; i += 1) {
      const prevEnd =
        sortedByStart[i - 1].timeline_in_frame + sortedByStart[i - 1].timeline_duration_frames;
      if (sortedByStart[i].timeline_in_frame > prevEnd) {
        internalGap += sortedByStart[i].timeline_in_frame - prevEnd;
      }
    }

    const firstReadingClip = sortedByStart.find((clip) => clip.track_id === readingTrack);

    beat.compiled = {
      start_frame: startFrame,
      end_frame: endFrame,
      compiled_frames: compiledFrames,
      clip_count: clips.length,
      clips: sortedByStart,
      gap_before_frames: firstReadingClip
        ? (gapBeforeByClip.get(firstReadingClip.clip_id) ?? 0)
        : null,
      internal_gap_frames: internalGap,
      overrun_frames: compiledFrames - beat.plan_duration_frames,
    };

    const overrun = compiledFrames - beat.plan_duration_frames;
    if (internalGap > 0) {
      beat.warnings.push(`gap of ${internalGap} frames between compiled clips inside this beat`);
    }
    if (
      firstReadingClip &&
      (gapBeforeByClip.get(firstReadingClip.clip_id) ?? 0) > 0
    ) {
      beat.warnings.push(
        `gap of ${gapBeforeByClip.get(firstReadingClip.clip_id)} frames before this beat on the reading track`,
      );
    }
    if (overrun > 0) {
      beat.warnings.push(
        `compiled duration exceeds blueprint target by ${overrun} frames (overrun)`,
      );
    } else if (overrun < 0) {
      beat.warnings.push(
        `compiled duration falls short of blueprint target by ${Math.abs(overrun)} frames (shortfall)`,
      );
    }
  }

  return { unassigned };
}

function emptyPlacement(): BeatCompiledPlacement {
  return {
    start_frame: null,
    end_frame: null,
    compiled_frames: 0,
    clip_count: 0,
    clips: [],
    gap_before_frames: null,
    internal_gap_frames: 0,
    overrun_frames: null,
  };
}
