import { getCandidateRef } from "./candidate-ref.js";
import type {
  AssembledTimeline,
  Candidate,
  EditBlueprint,
  FreezeFrameHoldTimelineMetadata,
  TimelineClip,
} from "./types.js";

export interface ApexFreezeHoldConfig {
  policy: "apex-freeze-hold/v1";
  minHoldFrames: number;
  defaultHoldFrames: number;
  maxHoldFrames: number;
}

export interface ApexFreezeHoldResult {
  applied_clip_ids: string[];
  total_added_frames: number;
}

export interface CandidatePlanFreezeHold {
  beatId: string;
  candidateRef: string;
  intent: NonNullable<Candidate["freeze_frame_hold"]>;
}

export function materializeCandidatePlanFreezeHolds(
  blueprint: Pick<EditBlueprint, "beats">,
  candidates: Candidate[],
): CandidatePlanFreezeHold[] {
  const authored: CandidatePlanFreezeHold[] = [];
  for (const beat of blueprint.beats) {
    const intent = beat.candidate_plan?.freeze_frame_hold;
    const ref = beat.candidate_plan?.primary_candidate_ref;
    if (!intent || !ref) continue;
    const candidate = candidates.find((item) =>
      getCandidateRef(item) === ref || item.segment_id === ref
    );
    if (!candidate) {
      throw new Error(`apex_freeze_hold_candidate_not_found:${beat.id}:${ref}`);
    }
    if (
      candidate.freeze_frame_hold &&
      (
        candidate.freeze_frame_hold.source_time_us !== intent.source_time_us ||
        candidate.freeze_frame_hold.hold_frames !== intent.hold_frames
      )
    ) {
      throw new Error(`apex_freeze_hold_authorship_conflict:${beat.id}:${ref}`);
    }
    authored.push({ beatId: beat.id, candidateRef: getCandidateRef(candidate), intent: { ...intent } });
  }
  return authored;
}

function candidateForClip(candidates: Candidate[], clip: TimelineClip): Candidate | undefined {
  return candidates.find((candidate) =>
    getCandidateRef(candidate) === clip.candidate_ref ||
    (
      candidate.segment_id === clip.segment_id &&
      candidate.asset_id === clip.asset_id &&
      candidate.src_in_us <= clip.src_in_us &&
      candidate.src_out_us >= clip.src_out_us
    )
  );
}

function resolveFreezeMetadata(
  candidate: Candidate,
  clip: TimelineClip,
  config: ApexFreezeHoldConfig,
  intent: NonNullable<Candidate["freeze_frame_hold"]>,
): FreezeFrameHoldTimelineMetadata | null {
  if (clip.media_kind === "image") {
    throw new Error(`apex_freeze_hold_still_image_invalid:${clip.clip_id}`);
  }
  if (
    !Number.isInteger(intent.source_time_us) ||
    intent.source_time_us < candidate.src_in_us ||
    intent.source_time_us >= candidate.src_out_us
  ) {
    throw new Error(
      `apex_freeze_hold_source_time_out_of_range:${getCandidateRef(candidate)}:` +
      `${intent.source_time_us}:${candidate.src_in_us}-${candidate.src_out_us}`,
    );
  }
  // A candidate may be reused with a different trim. Only the placement that
  // actually contains the authored source frame can materialize the hold.
  if (intent.source_time_us < clip.src_in_us || intent.source_time_us >= clip.src_out_us) {
    return null;
  }
  const authored = intent.hold_frames;
  if (authored !== undefined && (!Number.isInteger(authored) || authored <= 0)) {
    throw new Error(`apex_freeze_hold_frames_invalid:${clip.clip_id}:${authored}`);
  }
  const requested = authored ?? config.defaultHoldFrames;
  const holdFrames = Math.max(config.minHoldFrames, Math.min(config.maxHoldFrames, requested));
  return {
    source_time_us: intent.source_time_us,
    hold_frames: holdFrames,
    hold_source: authored === undefined ? "skill_default" : "candidate_override",
    policy_clamp: holdFrames === requested
      ? "none"
      : requested < config.minHoldFrames ? "min" : "max",
    policy: config.policy,
  };
}

function sameSourcePlacement(left: TimelineClip, right: TimelineClip): boolean {
  return left.asset_id === right.asset_id &&
    left.segment_id === right.segment_id &&
    left.src_in_us === right.src_in_us &&
    left.src_out_us === right.src_out_us &&
    left.timeline_in_frame === right.timeline_in_frame;
}

/**
 * Materialize explicitly-authored freeze holds and ripple later events. The
 * source range remains unchanged: timeline duration grows solely by the hold.
 */
export function applyApexFreezeHolds(
  assembled: AssembledTimeline,
  candidates: Candidate[],
  config: ApexFreezeHoldConfig | null,
  candidatePlanHolds: CandidatePlanFreezeHold[] = [],
): ApexFreezeHoldResult {
  if (!config) return { applied_clip_ids: [], total_added_frames: 0 };
  // Keep the authored effect on the primary program track. Overlay tracks may
  // overlap or split the program and therefore cannot be rippled safely here.
  const primaryTrack = assembled.tracks.video.find((track) => track.track_id === "V1") ??
    assembled.tracks.video[0];
  const primary = [...(primaryTrack?.clips ?? [])]
    .sort((left, right) =>
      left.timeline_in_frame - right.timeline_in_frame || left.clip_id.localeCompare(right.clip_id)
    );
  const allClips = [
    ...assembled.tracks.video.flatMap((track) => track.clips),
    ...assembled.tracks.audio.flatMap((track) => track.clips),
  ];
  const originalProgramEnd = primary.reduce(
    (max, clip) => Math.max(max, clip.timeline_in_frame + clip.timeline_duration_frames),
    0,
  );
  const applied: string[] = [];
  let totalAddedFrames = 0;

  for (const videoClip of primary) {
    if (videoClip.freeze_frame_hold) continue;
    const candidate = candidateForClip(candidates, videoClip);
    if (!candidate) continue;
    const planHold = candidatePlanHolds.find((hold) =>
      hold.beatId === videoClip.beat_id &&
      (hold.candidateRef === getCandidateRef(candidate) || hold.candidateRef === candidate.segment_id)
    );
    const intent = planHold?.intent ?? candidate.freeze_frame_hold;
    if (!intent) continue;
    const freeze = resolveFreezeMetadata(candidate, videoClip, config, intent);
    if (!freeze) continue;
    const originalEnd = videoClip.timeline_in_frame + videoClip.timeline_duration_frames;
    const mirrors = allClips.filter((clip) =>
      clip !== videoClip && sameSourcePlacement(videoClip, clip)
    );

    for (const clip of allClips) {
      if (clip === videoClip || mirrors.includes(clip)) continue;
      if (clip.timeline_in_frame >= originalEnd) {
        clip.timeline_in_frame += freeze.hold_frames;
      }
    }
    for (const marker of assembled.markers) {
      if (marker.frame >= originalEnd) marker.frame += freeze.hold_frames;
    }
    videoClip.freeze_frame_hold = { ...freeze };
    videoClip.timeline_duration_frames += freeze.hold_frames;
    for (const mirror of mirrors) {
      mirror.freeze_frame_hold = { ...freeze };
      mirror.timeline_duration_frames += freeze.hold_frames;
      applied.push(mirror.clip_id);
    }
    applied.push(videoClip.clip_id);
    totalAddedFrames += freeze.hold_frames;
  }

  if (totalAddedFrames > 0) {
    for (const clip of assembled.tracks.audio.flatMap((track) => track.clips)) {
      const originalEnd = clip.timeline_in_frame + clip.timeline_duration_frames;
      if (
        (clip.role === "bgm" || clip.role === "music") &&
        clip.timeline_in_frame === 0 &&
        originalEnd >= originalProgramEnd
      ) {
        clip.timeline_duration_frames += totalAddedFrames;
      }
    }
  }
  for (const track of [...assembled.tracks.video, ...assembled.tracks.audio]) {
    track.clips.sort((left, right) =>
      left.timeline_in_frame - right.timeline_in_frame || left.clip_id.localeCompare(right.clip_id)
    );
  }
  assembled.markers.sort((left, right) => left.frame - right.frame);
  return {
    applied_clip_ids: [...new Set(applied)].sort(),
    total_added_frames: totalAddedFrames,
  };
}
