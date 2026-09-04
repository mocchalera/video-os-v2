import type {
  BlueprintSequence,
  EditBlueprint,
  HookLockProvenance,
  ResolvedShotAnchor,
  ShotAnchorResolutionProvenance,
  TimelineIR,
} from "./types.js";
import { computeHookFingerprint } from "./shot-anchor-resolver.js";

export interface HookMutationOperation {
  op?: string;
  target_clip_id?: string;
  from_clip_id?: string;
  to_clip_id?: string;
  beat_id?: string;
  new_timeline_in_frame?: number;
  new_duration_frames?: number;
  reason?: string;
}

export class HookLockViolationError extends Error {
  public readonly code = "HOOK_LOCKED" as const;

  constructor(public readonly reason: string) {
    super(`Hook is locked: ${reason}`);
    this.name = "HookLockViolationError";
  }
}

export function assertHookRecompileAllowed(
  existingTimeline: Pick<TimelineIR, "provenance"> | undefined,
  nextHookFingerprint: string | undefined,
): void {
  const existingLock = existingTimeline?.provenance.hook_lock;
  if (!existingLock) return;
  if (!nextHookFingerprint) {
    throw new HookLockViolationError(
      `the new compile has no explicit Hook fingerprint; expected ${existingLock.fingerprint}`,
    );
  }
  if (existingLock.fingerprint !== nextHookFingerprint) {
    throw new HookLockViolationError(
      `fingerprint mismatch (locked=${existingLock.fingerprint}, requested=${nextHookFingerprint})`,
    );
  }
}

export function buildHookLockProvenance(options: {
  blueprint: EditBlueprint;
  resolution?: ShotAnchorResolutionProvenance;
  timeline: TimelineIR;
  existingLock?: HookLockProvenance;
}): HookLockProvenance | undefined {
  const sequence = options.blueprint.hook_sequence ?? options.blueprint.hook;
  if (!sequence) {
    if (options.existingLock) {
      throw new HookLockViolationError(
        `the new blueprint has no Hook sequence; expected ${options.existingLock.fingerprint}`,
      );
    }
    return undefined;
  }

  const fingerprint = computeHookFingerprint(options.blueprint, options.resolution);
  if (!fingerprint) return undefined;
  if (options.existingLock && options.existingLock.fingerprint !== fingerprint) {
    throw new HookLockViolationError(
      `fingerprint mismatch (locked=${options.existingLock.fingerprint}, requested=${fingerprint})`,
    );
  }

  const shouldLock = sequence.locked === true || options.existingLock !== undefined;
  if (!shouldLock) return undefined;
  if (sequence.shots.length === 0) {
    throw new HookLockViolationError("an explicitly locked Hook must contain at least one shot");
  }

  const videoClips = options.timeline.tracks.video.flatMap((track) => track.clips);
  const a1Clips = options.timeline.tracks.audio
    .filter((track) => track.track_id === "A1")
    .flatMap((track) => track.clips);
  const resolvedAnchors = new Map(
    (options.resolution?.anchors ?? [])
      .filter((anchor) => anchor.sequence_kind === "hook")
      .map((anchor) => [anchor.shot_id, anchor]),
  );
  const protectedClipIds: string[] = [];
  const protectedBeatIds = new Set<string>();
  const anchorIds: string[] = [];
  const issues: string[] = [];

  for (const shot of sequence.shots) {
    if (shot.beat_id) protectedBeatIds.add(shot.beat_id);
    const resolvedAnchor = shot.shot_anchor ? resolvedAnchors.get(shot.shot_id) : undefined;
    if (shot.shot_anchor && resolvedAnchor) {
      anchorIds.push(resolvedAnchor.anchor_id);
      const clip = findAnchorClip(videoClips, resolvedAnchor);
      if (clip) addProtectedClipAndA1Companions(protectedClipIds, clip, a1Clips);
      else issues.push(`shot ${shot.shot_id} is not present in the canonical timeline`);
      continue;
    }
    if (shot.shot_anchor) {
      issues.push(`shot ${shot.shot_id} has no resolved anchor evidence`);
      continue;
    }
    const candidateRef = shot.candidate_ref;
    const clip = candidateRef
      ? videoClips.find((item) => item.candidate_ref === candidateRef || item.segment_id === candidateRef)
      : undefined;
    if (clip) addProtectedClipAndA1Companions(protectedClipIds, clip, a1Clips);
    else issues.push(`shot ${shot.shot_id} candidate_ref ${candidateRef ?? "<missing>"} is not present in the canonical timeline`);
  }

  if (issues.length > 0) throw new HookLockViolationError(issues.join("; "));
  if (protectedClipIds.length === 0) throw new HookLockViolationError("the locked Hook has no canonical clips to protect");

  return {
    policy: "hook-lock/v1",
    locked: true,
    sequence_id: sequence.sequence_id,
    lock_revision: options.existingLock?.lock_revision ?? sequence.lock_revision ?? 0,
    fingerprint,
    anchor_ids: [...new Set(anchorIds)].sort(),
    protected_clip_ids: [...new Set(protectedClipIds)].sort(),
    protected_beat_ids: [...protectedBeatIds].sort(),
    reason: options.existingLock ? "preserved_existing_lock" : "explicit_blueprint_lock",
  };
}

export function assertHookPatchOperationAllowed(
  timeline: TimelineIR,
  operation: HookMutationOperation,
): void {
  const lock = timeline.provenance.hook_lock;
  if (!lock) return;
  if (operation.op === "add_marker" || operation.op === "add_note") return;

  const protectedIds = new Set(lock.protected_clip_ids);
  const referencedIds = [operation.target_clip_id, operation.from_clip_id, operation.to_clip_id]
    .filter((value): value is string => typeof value === "string");
  const hit = referencedIds.find((id) => protectedIds.has(id));
  if (hit) {
    throw new HookLockViolationError(
      `operation ${operation.op ?? "unknown"} targets protected clip ${hit}; ${operation.reason ?? "no override is permitted"}`,
    );
  }
  if (operation.op === "insert_segment") {
    if (operation.beat_id && lock.protected_beat_ids.includes(operation.beat_id)) {
      throw new HookLockViolationError(
        `insert_segment targets protected Hook beat ${operation.beat_id}`,
      );
    }
    if (typeof operation.new_timeline_in_frame === "number") {
      const protectedClips = allTimelineClips(timeline)
        .filter((clip) => protectedIds.has(clip.clip_id));
      const frame = operation.new_timeline_in_frame;
      const overlaps = protectedClips.some((clip) => {
        const end = clip.timeline_in_frame + clip.timeline_duration_frames;
        const duration = operation.new_duration_frames ?? 1;
        return frame < end && frame + duration > clip.timeline_in_frame;
      });
      if (overlaps) throw new HookLockViolationError("insert_segment overlaps the protected Hook range");
    }
  }
}

export function assertHookTimelineMutationAllowed(
  currentTimeline: TimelineIR,
  nextTimeline: TimelineIR,
): void {
  const lock = currentTimeline.provenance.hook_lock;
  if (!lock) return;
  const nextLock = nextTimeline.provenance.hook_lock;
  if (!nextLock || nextLock.fingerprint !== lock.fingerprint) {
    throw new HookLockViolationError(
      `Studio save would change the locked Hook fingerprint (expected ${lock.fingerprint})`,
    );
  }
  if (JSON.stringify(hookLockProjection(lock)) !== JSON.stringify(hookLockProjection(nextLock))) {
    throw new HookLockViolationError(
      "Studio save would change the authoritative Hook lock projection "
      + "(sequence, revision, anchors, protected beats/clips, or reason)",
    );
  }
  const currentClips = new Map(allTimelineClips(currentTimeline).map((clip) => [clip.clip_id, clip]));
  const nextClips = new Map(allTimelineClips(nextTimeline).map((clip) => [clip.clip_id, clip]));
  for (const clipId of lock.protected_clip_ids) {
    const before = currentClips.get(clipId);
    const after = nextClips.get(clipId);
    if (!before || !after) {
      throw new HookLockViolationError(`Studio save removed or renamed protected clip ${clipId}`);
    }
    if (JSON.stringify(protectedClipProjection(before)) !== JSON.stringify(protectedClipProjection(after))) {
      throw new HookLockViolationError(`Studio save changed protected clip ${clipId}`);
    }
  }
}

export function hookLockStatus(timeline: Pick<TimelineIR, "provenance"> | undefined): {
  locked: boolean;
  fingerprint?: string;
  reason?: string;
  protected_clip_ids: string[];
} {
  const lock = timeline?.provenance.hook_lock;
  return lock
    ? {
        locked: true,
        fingerprint: lock.fingerprint,
        reason: "Hook is explicitly locked by the Blueprint; only non-Hook edits are allowed.",
        protected_clip_ids: lock.protected_clip_ids,
      }
    : { locked: false, protected_clip_ids: [] };
}

function findAnchorClip(
  clips: ReturnType<typeof allTimelineClips>,
  anchor: ResolvedShotAnchor,
) {
  return clips
    .filter((clip) =>
      clip.asset_id === anchor.asset_id &&
      clip.segment_id === anchor.segment_id &&
      clip.src_in_us <= anchor.src_in_us &&
      clip.src_out_us >= anchor.src_out_us,
    )
    .sort((left, right) =>
      left.timeline_in_frame - right.timeline_in_frame || left.clip_id.localeCompare(right.clip_id),
    )[0];
}

function allTimelineClips(timeline: TimelineIR) {
  return [...timeline.tracks.video, ...timeline.tracks.audio].flatMap((track) => track.clips);
}

function addProtectedClipAndA1Companions(
  protectedClipIds: string[],
  hookClip: ReturnType<typeof allTimelineClips>[number],
  a1Clips: ReturnType<typeof allTimelineClips>,
): void {
  protectedClipIds.push(hookClip.clip_id);
  for (const companion of a1Clips) {
    if (
      companion.asset_id === hookClip.asset_id
      && companion.src_in_us === hookClip.src_in_us
      && companion.src_out_us === hookClip.src_out_us
      && companion.timeline_in_frame === hookClip.timeline_in_frame
      && companion.timeline_duration_frames === hookClip.timeline_duration_frames
    ) {
      protectedClipIds.push(companion.clip_id);
    }
  }
}

function hookLockProjection(lock: HookLockProvenance): unknown {
  return {
    policy: lock.policy,
    locked: lock.locked,
    sequence_id: lock.sequence_id,
    lock_revision: lock.lock_revision,
    anchor_ids: lock.anchor_ids,
    protected_clip_ids: lock.protected_clip_ids,
    protected_beat_ids: lock.protected_beat_ids,
    reason: lock.reason,
  };
}

function protectedClipProjection(clip: ReturnType<typeof allTimelineClips>[number]): unknown {
  return {
    clip_id: clip.clip_id,
    segment_id: clip.segment_id,
    asset_id: clip.asset_id,
    src_in_us: clip.src_in_us,
    src_out_us: clip.src_out_us,
    timeline_in_frame: clip.timeline_in_frame,
    timeline_duration_frames: clip.timeline_duration_frames,
    role: clip.role,
    beat_id: clip.beat_id,
    candidate_ref: clip.candidate_ref,
    metadata: clip.metadata,
    audio_policy: clip.audio_policy,
    captions: clip.captions,
  };
}

export function hookSequence(blueprint: EditBlueprint): BlueprintSequence | undefined {
  return blueprint.hook_sequence ?? blueprint.hook;
}
