import { useCallback, useRef, useState } from 'react';
import type {
  Clip,
  EditorLane,
  TimelineIR,
  TrackHeaderState,
  TrimMode,
  TrimTarget,
} from '../types';
import {
  clamp,
  durationFramesFromSource,
  framesToMicroseconds,
} from '../utils/time';
import { validateOverlaps } from '@shared/timeline-validation';

// ── Types ─────────────────────────────────────────────────────────────

interface TrimSnapshot {
  timeline: TimelineIR;
  target: TrimTarget;
  /** Accumulated delta in frames from the trim start point */
  accumulatedDelta: number;
  /** Linked V/A partner targets — trimmed together unless Alt was held at begin */
  linkedTargets?: TrimTarget[];
}

interface UseTrimToolOptions {
  timeline: TimelineIR | null;
  fps: number;
  lanes: EditorLane[];
  trackStates: Record<string, TrackHeaderState>;
  /** Push a history entry and set new timeline */
  pushTimeline: (tl: TimelineIR, origin?: 'manual_trim') => void;
  /** Silent update (no history push — used during drag) */
  updateTimelineSilent: (tl: TimelineIR) => void;
  /** Whether linked V/A selection is enabled (Shift+L toggle) */
  linkedSelectionEnabled: boolean;
  /** Begin drag snapshot for undo grouping */
  beginDrag: () => void;
  /** End drag — commits the snapshot as one undo entry */
  endDrag: () => void;
  /** Snap drag helper — finds snap AND updates visual guide */
  snapDrag: (frame: number, excludeClipId?: string) => number;
  /** Clear snap guide visual */
  clearSnap: () => void;
}

// ── Helpers ────────────────────────────────────────────────────────────

function findClipInTimeline(
  timeline: TimelineIR,
  trackKind: 'video' | 'audio',
  trackId: string,
  clipId: string,
): Clip | null {
  const track = timeline.tracks[trackKind].find((t) => t.track_id === trackId);
  return track?.clips.find((c) => c.clip_id === clipId) ?? null;
}

function findAdjacentClips(
  timeline: TimelineIR,
  trackKind: 'video' | 'audio',
  trackId: string,
  clipId: string,
): { prev: Clip | null; next: Clip | null; clip: Clip | null } {
  const track = timeline.tracks[trackKind].find((t) => t.track_id === trackId);
  if (!track) return { prev: null, next: null, clip: null };

  const sorted = [...track.clips].sort(
    (a, b) => a.timeline_in_frame - b.timeline_in_frame,
  );
  const idx = sorted.findIndex((c) => c.clip_id === clipId);
  if (idx < 0) return { prev: null, next: null, clip: null };

  return {
    prev: idx > 0 ? sorted[idx - 1] : null,
    clip: sorted[idx],
    next: idx < sorted.length - 1 ? sorted[idx + 1] : null,
  };
}

/** Check if a proposed timeline state has overlaps on a specific track */
function hasOverlap(
  timeline: TimelineIR,
  trackKind: 'video' | 'audio',
  trackId: string,
  fps: number,
): boolean {
  const track = timeline.tracks[trackKind].find((t) => t.track_id === trackId);
  if (!track) return false;
  return validateOverlaps(trackKind, track, fps).length > 0;
}

/** Enforce source range: src_in_us >= 0 and src_out_us <= source_duration_us */
function enforceSourceBounds(clip: Clip): void {
  clip.src_in_us = Math.max(0, clip.src_in_us);
  if (clip.source_duration_us != null) {
    clip.src_out_us = Math.min(clip.source_duration_us, clip.src_out_us);
  }
  // Ensure src_in < src_out (at least 1μs gap)
  if (clip.src_in_us >= clip.src_out_us) {
    clip.src_out_us = clip.src_in_us + 1;
  }
}

/** Compute max positive delta (shrinking toward 0 frames) for head side */
function maxHeadDelta(clip: Clip, _fps: number): number {
  return clip.timeline_duration_frames - 1;
}

/** Max frames the head can extend left (negative delta) before src_in hits 0 */
function maxHeadExtendFrames(clip: Clip, fps: number): number {
  const frameMicros = framesToMicroseconds(1, fps);
  if (frameMicros <= 0) return 0;
  return Math.floor(clip.src_in_us / frameMicros);
}

/** Compute max delta that keeps source range valid (tail side) */
function maxTailDeltaForSource(clip: Clip, fps: number): number {
  if (clip.source_duration_us == null) return Infinity;
  const remainingSourceUs = clip.source_duration_us - clip.src_out_us;
  if (remainingSourceUs <= 0) return 0;
  return Math.floor((remainingSourceUs / 1_000_000) * fps);
}

// ── Hook ──────────────────────────────────────────────────────────────

export function useTrimTool({
  timeline,
  fps,
  lanes,
  trackStates,
  pushTimeline,
  updateTimelineSilent,
  linkedSelectionEnabled,
  beginDrag,
  endDrag,
  snapDrag,
  clearSnap,
}: UseTrimToolOptions) {
  const [trimMode, setTrimMode] = useState<TrimMode>('selection');
  const [activeTrimTarget, setActiveTrimTarget] = useState<TrimTarget | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [trimDelta, setTrimDelta] = useState(0);
  const trimSnapshotRef = useRef<TrimSnapshot | null>(null);

  // ── Mode switching ────────────────────────────────────────────────

  const setMode = useCallback((mode: TrimMode) => {
    setTrimMode(mode);
  }, []);

  // ── Begin trim ────────────────────────────────────────────────────

  const beginTrimCb = useCallback(
    (target: TrimTarget, opts?: { altKey?: boolean }) => {
      if (!timeline) return;

      // Check lock
      const state = trackStates[target.trackId];
      if (state?.locked) return;

      // Find linked V/A partners (unless Alt held or linked selection disabled)
      let linkedTargets: TrimTarget[] | undefined;
      if (!opts?.altKey && linkedSelectionEnabled) {
        const clip = findClipInTimeline(timeline, target.trackKind, target.trackId, target.clipId);
        const groupId = clip?.metadata?.link_group_id as string | undefined;
        if (groupId) {
          linkedTargets = [];
          for (const kind of ['video', 'audio'] as const) {
            for (const track of timeline.tracks[kind]) {
              if (trackStates[track.track_id]?.locked) continue;
              for (const c of track.clips) {
                if (c.clip_id !== target.clipId && c.metadata?.link_group_id === groupId) {
                  linkedTargets.push({
                    clipId: c.clip_id,
                    trackId: track.track_id,
                    trackKind: kind,
                    side: target.side,
                  });
                }
              }
            }
          }
          if (linkedTargets.length === 0) linkedTargets = undefined;
        }
      }

      trimSnapshotRef.current = {
        timeline: structuredClone(timeline),
        target,
        accumulatedDelta: 0,
        linkedTargets,
      };
      setActiveTrimTarget(target);
      setIsDragging(true);
      setTrimDelta(0);
      beginDrag();
    },
    [timeline, trackStates, linkedSelectionEnabled, beginDrag],
  );

  // ── Update trim ───────────────────────────────────────────────────

  const updateTrim = useCallback(
    (deltaFrames: number, opts?: { skipSnap?: boolean }) => {
      const snapshot = trimSnapshotRef.current;
      if (!snapshot || !timeline) return;

      const { target } = snapshot;
      const baseTl = snapshot.timeline;

      // Apply snap
      const baseClip = findClipInTimeline(
        baseTl,
        target.trackKind,
        target.trackId,
        target.clipId,
      );
      if (!baseClip) return;

      let snappedDelta = deltaFrames;
      if (trimMode !== 'slip' && !opts?.skipSnap) {
        const edgeFrame =
          target.side === 'head'
            ? baseClip.timeline_in_frame + deltaFrames
            : baseClip.timeline_in_frame +
              baseClip.timeline_duration_frames +
              deltaFrames;
        const snappedFrame = snapDrag(edgeFrame, baseClip.clip_id);
        snappedDelta =
          target.side === 'head'
            ? snappedFrame - baseClip.timeline_in_frame
            : snappedFrame -
              (baseClip.timeline_in_frame +
                baseClip.timeline_duration_frames);
      } else {
        clearSnap();
      }

      let nextTl = applyTrimToTimeline(
        baseTl,
        target,
        snappedDelta,
        trimMode,
        fps,
        trackStates,
      );

      if (!nextTl) return;

      // Apply to linked V/A partners
      if (snapshot.linkedTargets) {
        for (const lt of snapshot.linkedTargets) {
          nextTl = applyTrimInPlace(nextTl, lt, snappedDelta, trimMode, fps, trackStates);
          if (!nextTl) return;
        }
      }

      // Overlap preflight on target track
      if (hasOverlap(nextTl, target.trackKind, target.trackId, fps)) return;

      // For ripple mode, also check sync-locked tracks for overlaps
      if (trimMode === 'ripple') {
        for (const kind of ['video', 'audio'] as const) {
          for (const track of nextTl.tracks[kind]) {
            if (kind === target.trackKind && track.track_id === target.trackId) continue;
            const st = trackStates[track.track_id];
            if (st?.syncLock && hasOverlap(nextTl, kind, track.track_id, fps)) return;
          }
        }
      }

      snapshot.accumulatedDelta = snappedDelta;
      setTrimDelta(snappedDelta);
      updateTimelineSilent(nextTl);
    },
    [timeline, trimMode, fps, trackStates, snapDrag, clearSnap, updateTimelineSilent],
  );

  // ── Commit trim ───────────────────────────────────────────────────

  const commitTrim = useCallback(() => {
    setActiveTrimTarget(null);
    setIsDragging(false);
    setTrimDelta(0);
    trimSnapshotRef.current = null;
    clearSnap();
    endDrag();
  }, [endDrag, clearSnap]);

  // ── Cancel trim ───────────────────────────────────────────────────

  const cancelTrim = useCallback(() => {
    const snapshot = trimSnapshotRef.current;
    if (snapshot) {
      // Restore the original timeline
      updateTimelineSilent(snapshot.timeline);
    }
    setActiveTrimTarget(null);
    setIsDragging(false);
    setTrimDelta(0);
    trimSnapshotRef.current = null;
    clearSnap();
    endDrag();
  }, [endDrag, updateTimelineSilent, clearSnap]);

  // ── Keyboard trim step ────────────────────────────────────────────

  const keyboardTrimStep = useCallback(
    (stepFrames: number, fallbackTarget?: TrimTarget) => {
      const target = activeTrimTarget ?? fallbackTarget;
      if (!target || !timeline) return;

      // HIGH 3: Check track lock — keyboard trim must not bypass it
      if (trackStates[target.trackId]?.locked) return;

      const baseTl = structuredClone(timeline);

      // FATAL 1: Apply snap to keyboard trim
      const baseClip = findClipInTimeline(baseTl, target.trackKind, target.trackId, target.clipId);
      if (!baseClip) return;

      let effectiveDelta = stepFrames;
      if (trimMode !== 'slip') {
        const edgeFrame =
          target.side === 'head'
            ? baseClip.timeline_in_frame + stepFrames
            : baseClip.timeline_in_frame + baseClip.timeline_duration_frames + stepFrames;
        const snappedFrame = snapDrag(edgeFrame, baseClip.clip_id);
        effectiveDelta =
          target.side === 'head'
            ? snappedFrame - baseClip.timeline_in_frame
            : snappedFrame - (baseClip.timeline_in_frame + baseClip.timeline_duration_frames);
        // If already at a snap point, step past it (design 3-11)
        if (effectiveDelta === 0 && stepFrames !== 0) {
          effectiveDelta = stepFrames;
        }
      }
      clearSnap();

      let nextTl = applyTrimToTimeline(
        baseTl,
        target,
        effectiveDelta,
        trimMode,
        fps,
        trackStates,
      );

      if (!nextTl) return;

      // Apply to linked partners
      const snapshot = trimSnapshotRef.current;
      let linkedTargets = snapshot?.linkedTargets;
      // HIGH 2: If no active drag, find linked partners when linkedSelectionEnabled
      if (!linkedTargets && linkedSelectionEnabled) {
        const linkClip = findClipInTimeline(baseTl, target.trackKind, target.trackId, target.clipId);
        const groupId = linkClip?.metadata?.link_group_id as string | undefined;
        if (groupId) {
          linkedTargets = [];
          for (const kind of ['video', 'audio'] as const) {
            for (const track of baseTl.tracks[kind]) {
              if (trackStates[track.track_id]?.locked) continue;
              for (const c of track.clips) {
                if (c.clip_id !== target.clipId && c.metadata?.link_group_id === groupId) {
                  linkedTargets.push({
                    clipId: c.clip_id,
                    trackId: track.track_id,
                    trackKind: kind,
                    side: target.side,
                  });
                }
              }
            }
          }
          if (linkedTargets.length === 0) linkedTargets = undefined;
        }
      }
      if (linkedTargets) {
        for (const lt of linkedTargets) {
          nextTl = applyTrimInPlace(nextTl, lt, effectiveDelta, trimMode, fps, trackStates);
          if (!nextTl) return;
        }
      }

      if (hasOverlap(nextTl, target.trackKind, target.trackId, fps)) return;

      // For ripple, also check sync-locked tracks
      if (trimMode === 'ripple') {
        for (const kind of ['video', 'audio'] as const) {
          for (const track of nextTl.tracks[kind]) {
            if (kind === target.trackKind && track.track_id === target.trackId) continue;
            const st = trackStates[track.track_id];
            if (st?.syncLock && hasOverlap(nextTl, kind, track.track_id, fps)) return;
          }
        }
      }

      pushTimeline(nextTl, 'manual_trim');
    },
    [activeTrimTarget, timeline, trimMode, fps, trackStates, linkedSelectionEnabled, pushTimeline, snapDrag, clearSnap],
  );

  return {
    trimMode,
    activeTrimTarget,
    isDragging,
    trimDelta,
    setTrimMode: setMode,
    setActiveTrimTarget,
    beginTrim: beginTrimCb,
    updateTrim,
    commitTrim,
    cancelTrim,
    keyboardTrimStep,
  };
}

// ── Pure trim logic ─────────────────────────────────────────────────

/** Apply trim in-place on an already-cloned timeline (used for linked partners) */
function applyTrimInPlace(
  tl: TimelineIR,
  target: TrimTarget,
  delta: number,
  mode: TrimMode,
  fps: number,
  trackStates: Record<string, TrackHeaderState>,
): TimelineIR | null {
  switch (mode) {
    case 'selection':
      return applySelectionTrim(tl, target, delta, fps);
    case 'ripple':
      return applyRippleTrim(tl, target, delta, fps, trackStates);
    case 'roll':
      return applyRollTrim(tl, target, delta, fps);
    case 'slip':
      return applySlipTrim(tl, target, delta, fps);
    case 'slide':
      return applySlideTrim(tl, target, delta, fps);
    default:
      return null;
  }
}

/**
 * Apply a trim operation to a deep-cloned timeline. Returns null if
 * the operation is invalid (e.g. no adjacent clip for roll/slide).
 */
function applyTrimToTimeline(
  baseTl: TimelineIR,
  target: TrimTarget,
  delta: number,
  mode: TrimMode,
  fps: number,
  trackStates: Record<string, TrackHeaderState>,
): TimelineIR | null {
  const tl = structuredClone(baseTl);
  return applyTrimInPlace(tl, target, delta, mode, fps, trackStates);
}

// ── Selection trim (basic) ───────────────────────────────────────────

function applySelectionTrim(
  tl: TimelineIR,
  target: TrimTarget,
  delta: number,
  fps: number,
): TimelineIR | null {
  const clip = findClipInTimeline(tl, target.trackKind, target.trackId, target.clipId);
  if (!clip) return null;

  const { prev, next } = findAdjacentClips(tl, target.trackKind, target.trackId, target.clipId);

  if (target.side === 'head') {
    // Source-based clamp: head can't extend past src_in=0
    const srcExtend = maxHeadExtendFrames(clip, fps);
    const minDelta = Math.max(
      -(clip.timeline_duration_frames - 1),
      -srcExtend,
      prev
        ? prev.timeline_in_frame + prev.timeline_duration_frames - clip.timeline_in_frame
        : -clip.timeline_in_frame,
    );
    const maxDelta = clip.timeline_duration_frames - 1;
    const d = clamp(delta, minDelta, maxDelta);

    const deltaMicros = framesToMicroseconds(d, fps);
    clip.src_in_us = Math.max(0, clip.src_in_us + deltaMicros);
    clip.timeline_in_frame = Math.max(0, clip.timeline_in_frame + d);
    enforceSourceBounds(clip);
    clip.timeline_duration_frames = durationFramesFromSource(clip.src_in_us, clip.src_out_us, fps);
  } else {
    const minimumSrcOut = clip.src_in_us + framesToMicroseconds(1, fps);
    const maxEnd = next ? next.timeline_in_frame : Infinity;
    const maxDuration = maxEnd - clip.timeline_in_frame;
    const maxDelta = Math.min(
      maxDuration - clip.timeline_duration_frames,
      Infinity,
    );
    // Clamp for source_duration_us
    const srcMaxDelta = maxTailDeltaForSource(clip, fps);
    const minDelta = -(clip.timeline_duration_frames - 1);
    const d = clamp(delta, minDelta, Math.min(maxDelta, srcMaxDelta));

    clip.src_out_us = Math.max(
      minimumSrcOut,
      clip.src_out_us + framesToMicroseconds(d, fps),
    );
    enforceSourceBounds(clip);
    clip.timeline_duration_frames = durationFramesFromSource(clip.src_in_us, clip.src_out_us, fps);
  }

  return tl;
}

// ── Ripple trim ──────────────────────────────────────────────────────

function applyRippleTrim(
  tl: TimelineIR,
  target: TrimTarget,
  delta: number,
  fps: number,
  trackStates: Record<string, TrackHeaderState>,
): TimelineIR | null {
  const clip = findClipInTimeline(tl, target.trackKind, target.trackId, target.clipId);
  if (!clip) return null;

  const clipEndBefore = clip.timeline_in_frame + clip.timeline_duration_frames;

  if (target.side === 'head') {
    // FATAL 1: Save the old head position as the edit point BEFORE modifying the clip
    const oldInFrame = clip.timeline_in_frame;

    // Source-based clamp: head can't extend past src_in=0
    const srcExtend = maxHeadExtendFrames(clip, fps);
    const maxDelta = clip.timeline_duration_frames - 1;
    const minDelta = Math.max(-(clip.timeline_duration_frames - 1), -srcExtend);
    const d = clamp(delta, minDelta, maxDelta);

    clip.src_in_us = Math.max(0, clip.src_in_us + framesToMicroseconds(d, fps));
    clip.timeline_in_frame = Math.max(0, clip.timeline_in_frame + d);
    enforceSourceBounds(clip);
    clip.timeline_duration_frames = durationFramesFromSource(clip.src_in_us, clip.src_out_us, fps);

    const rippleDelta = d;
    // Head ripple: use old head as edit point, shift clips ending before it
    rippleDownstream(tl, target.trackKind, target.trackId, clip.clip_id, oldInFrame, rippleDelta, 'head');
    propagateRipple(tl, target.trackKind, target.trackId, oldInFrame, rippleDelta, trackStates, fps, 'head');
  } else {
    const minDelta = -(clip.timeline_duration_frames - 1);
    // Clamp for source_duration_us
    const srcMaxDelta = maxTailDeltaForSource(clip, fps);
    const d = clamp(delta, minDelta, srcMaxDelta === Infinity ? delta : srcMaxDelta);
    if (d < minDelta) return null;

    clip.src_out_us = Math.max(
      clip.src_in_us + framesToMicroseconds(1, fps),
      clip.src_out_us + framesToMicroseconds(d, fps),
    );
    enforceSourceBounds(clip);
    const newDuration = durationFramesFromSource(clip.src_in_us, clip.src_out_us, fps);
    const rippleDelta = newDuration - clip.timeline_duration_frames;
    clip.timeline_duration_frames = newDuration;

    // HIGH 5: Use old end (clipEndBefore) so clips at the prior cut point are correctly shifted
    rippleDownstream(tl, target.trackKind, target.trackId, clip.clip_id, clipEndBefore, rippleDelta, 'tail');
    propagateRipple(tl, target.trackKind, target.trackId, clipEndBefore, rippleDelta, trackStates, fps, 'tail');
  }

  return tl;
}

/** Shift clips on a single track by delta relative to the edit point.
 *  tail → shift clips starting at or after editPoint (standard)
 *  head → shift clips ending at or before editPoint (upstream close/open) */
function rippleDownstream(
  tl: TimelineIR,
  trackKind: 'video' | 'audio',
  trackId: string,
  excludeClipId: string,
  editPoint: number,
  delta: number,
  side: 'head' | 'tail' = 'tail',
): void {
  const track = tl.tracks[trackKind].find((t) => t.track_id === trackId);
  if (!track) return;

  for (const c of track.clips) {
    if (c.clip_id === excludeClipId) continue;
    if (side === 'head') {
      // Head ripple: shift clips whose end is at or before the edit point
      if (c.timeline_in_frame + c.timeline_duration_frames <= editPoint) {
        c.timeline_in_frame = Math.max(0, c.timeline_in_frame + delta);
      }
    } else {
      if (c.timeline_in_frame >= editPoint) {
        c.timeline_in_frame = Math.max(0, c.timeline_in_frame + delta);
      }
    }
  }
}

/** Propagate ripple to sync-locked tracks, splitting straddling clips */
function propagateRipple(
  tl: TimelineIR,
  editedTrackKind: 'video' | 'audio',
  editedTrackId: string,
  editPoint: number,
  delta: number,
  trackStates: Record<string, TrackHeaderState>,
  fps: number,
  side: 'head' | 'tail' = 'tail',
): void {
  for (const kind of ['video', 'audio'] as const) {
    for (const track of tl.tracks[kind]) {
      if (kind === editedTrackKind && track.track_id === editedTrackId) continue;

      const state = trackStates[track.track_id];
      if (!state?.syncLock || state?.locked) continue;

      // Find clips that straddle the edit point and need splitting
      const toSplit: number[] = [];
      for (let i = 0; i < track.clips.length; i++) {
        const c = track.clips[i];
        const clipEnd = c.timeline_in_frame + c.timeline_duration_frames;
        if (c.timeline_in_frame < editPoint && clipEnd > editPoint) {
          toSplit.push(i);
        }
      }

      // Split straddling clips (reverse order to preserve indices)
      // Collect split-created IDs during this phase for correct tracking
      const splitCreatedIds = new Set<string>();
      for (let si = toSplit.length - 1; si >= 0; si--) {
        const idx = toSplit[si];
        const c = track.clips[idx];
        const framesBefore = editPoint - c.timeline_in_frame;
        const framesAfter = c.timeline_duration_frames - framesBefore;

        const srcSplitUs = c.src_in_us + framesToMicroseconds(framesBefore, fps);
        const origSrcOut = c.src_out_us;
        const origSrcIn = c.src_in_us;
        const origStart = c.timeline_in_frame;

        if (side === 'head') {
          // Head ripple: before-portion shifts by delta, after-portion stays
          const beforeClip: Clip = {
            clip_id: `${c.clip_id}_r${idx}`,
            segment_id: c.segment_id,
            asset_id: c.asset_id,
            src_in_us: origSrcIn,
            src_out_us: srcSplitUs,
            timeline_in_frame: origStart + delta,
            timeline_duration_frames: framesBefore,
            role: c.role,
            motivation: c.motivation,
            beat_id: c.beat_id,
            confidence: c.confidence,
            quality_flags: c.quality_flags ? [...c.quality_flags] : undefined,
            audio_policy: c.audio_policy ? { ...c.audio_policy } : undefined,
            metadata: c.metadata ? { ...c.metadata } : undefined,
            source_duration_us: c.source_duration_us,
          };
          splitCreatedIds.add(beforeClip.clip_id);
          // Original becomes after-portion (stays at editPoint)
          c.src_in_us = srcSplitUs;
          c.timeline_in_frame = editPoint;
          c.timeline_duration_frames = framesAfter;
          track.clips.splice(idx, 0, beforeClip);
        } else {
          // Tail ripple: before-portion stays, after-portion shifts by delta
          const afterClip: Clip = {
            clip_id: `${c.clip_id}_r${idx}`,
            segment_id: c.segment_id,
            asset_id: c.asset_id,
            src_in_us: srcSplitUs,
            src_out_us: origSrcOut,
            timeline_in_frame: editPoint + delta,
            timeline_duration_frames: framesAfter,
            role: c.role,
            motivation: c.motivation,
            beat_id: c.beat_id,
            confidence: c.confidence,
            quality_flags: c.quality_flags ? [...c.quality_flags] : undefined,
            audio_policy: c.audio_policy ? { ...c.audio_policy } : undefined,
            metadata: c.metadata ? { ...c.metadata } : undefined,
            source_duration_us: c.source_duration_us,
          };
          splitCreatedIds.add(afterClip.clip_id);
          // Original stays as before-portion
          c.src_out_us = srcSplitUs;
          c.timeline_duration_frames = framesBefore;
          track.clips.splice(idx + 1, 0, afterClip);
        }
      }

      // Shift non-split clips based on ripple side
      for (const c of track.clips) {
        if (splitCreatedIds.has(c.clip_id)) continue;
        if (side === 'head') {
          // Head: shift clips ending at or before editPoint
          if (c.timeline_in_frame + c.timeline_duration_frames <= editPoint) {
            c.timeline_in_frame = Math.max(0, c.timeline_in_frame + delta);
          }
        } else {
          // Tail: shift clips starting at or after editPoint
          if (c.timeline_in_frame >= editPoint) {
            c.timeline_in_frame = Math.max(0, c.timeline_in_frame + delta);
          }
        }
      }
    }
  }
}

// ── Roll trim ────────────────────────────────────────────────────────

function applyRollTrim(
  tl: TimelineIR,
  target: TrimTarget,
  delta: number,
  fps: number,
): TimelineIR | null {
  const { prev, clip, next } = findAdjacentClips(
    tl,
    target.trackKind,
    target.trackId,
    target.clipId,
  );
  if (!clip) return null;

  if (target.side === 'head') {
    if (!prev) return null;

    // Source-based clamps: prev tail extend + clip head extend
    const prevSrcMax = maxTailDeltaForSource(prev, fps);
    const clipSrcExtend = maxHeadExtendFrames(clip, fps);
    const minDelta = Math.max(-(prev.timeline_duration_frames - 1), -clipSrcExtend);
    const maxDelta = clip.timeline_duration_frames - 1;
    const d = clamp(delta, minDelta, Math.min(maxDelta, prevSrcMax));

    prev.src_out_us = prev.src_out_us + framesToMicroseconds(d, fps);
    enforceSourceBounds(prev);
    prev.timeline_duration_frames = durationFramesFromSource(
      prev.src_in_us,
      prev.src_out_us,
      fps,
    );

    clip.src_in_us = clip.src_in_us + framesToMicroseconds(d, fps);
    clip.timeline_in_frame = clip.timeline_in_frame + d;
    enforceSourceBounds(clip);
    clip.timeline_duration_frames = durationFramesFromSource(
      clip.src_in_us,
      clip.src_out_us,
      fps,
    );
  } else {
    if (!next) return null;

    // Source-based clamps: clip tail extend + next head extend
    const srcMaxDelta = maxTailDeltaForSource(clip, fps);
    const nextSrcExtend = maxHeadExtendFrames(next, fps);
    const minDelta = Math.max(-(clip.timeline_duration_frames - 1), -nextSrcExtend);
    const maxDelta = next.timeline_duration_frames - 1;
    const d = clamp(delta, minDelta, Math.min(maxDelta, srcMaxDelta));

    clip.src_out_us = clip.src_out_us + framesToMicroseconds(d, fps);
    enforceSourceBounds(clip);
    clip.timeline_duration_frames = durationFramesFromSource(
      clip.src_in_us,
      clip.src_out_us,
      fps,
    );

    next.src_in_us = next.src_in_us + framesToMicroseconds(d, fps);
    next.timeline_in_frame = next.timeline_in_frame + d;
    enforceSourceBounds(next);
    next.timeline_duration_frames = durationFramesFromSource(
      next.src_in_us,
      next.src_out_us,
      fps,
    );
  }

  return tl;
}

// ── Slip trim ────────────────────────────────────────────────────────

function applySlipTrim(
  tl: TimelineIR,
  target: TrimTarget,
  delta: number,
  fps: number,
): TimelineIR | null {
  const clip = findClipInTimeline(tl, target.trackKind, target.trackId, target.clipId);
  if (!clip) return null;

  // Clamp delta to source boundaries before applying
  const srcExtend = maxHeadExtendFrames(clip, fps);
  const srcTailMax = maxTailDeltaForSource(clip, fps);
  const d = clamp(delta, -srcExtend, srcTailMax === Infinity ? delta : srcTailMax);
  if (d === 0 && delta !== 0) return null; // fully exhausted

  const deltaMicros = framesToMicroseconds(d, fps);
  clip.src_in_us = Math.max(0, clip.src_in_us + deltaMicros);
  clip.src_out_us = clip.src_out_us + deltaMicros;
  enforceSourceBounds(clip);
  clip.timeline_duration_frames = durationFramesFromSource(
    clip.src_in_us,
    clip.src_out_us,
    fps,
  );

  return tl;
}

// ── Slide trim ───────────────────────────────────────────────────────

function applySlideTrim(
  tl: TimelineIR,
  target: TrimTarget,
  delta: number,
  fps: number,
): TimelineIR | null {
  const { prev, clip, next } = findAdjacentClips(
    tl,
    target.trackKind,
    target.trackId,
    target.clipId,
  );
  if (!clip) return null;

  if (!prev || !next) return null;

  // Source-based clamps: prev tail extend (positive d) + next head extend (negative d)
  const prevSrcMax = maxTailDeltaForSource(prev, fps);
  const nextSrcExtend = maxHeadExtendFrames(next, fps);
  const minDelta = Math.max(
    -(clip.timeline_in_frame - (prev.timeline_in_frame + 1)),
    -nextSrcExtend,
  );
  const maxDelta = Math.min(
    next.timeline_in_frame + next.timeline_duration_frames - 1 -
      (clip.timeline_in_frame + clip.timeline_duration_frames),
    prevSrcMax === Infinity ? Infinity : prevSrcMax,
  );
  const d = clamp(delta, minDelta, maxDelta);

  // Move the clip
  clip.timeline_in_frame = clip.timeline_in_frame + d;

  // Adjust prev's tail symmetrically
  prev.src_out_us = prev.src_out_us + framesToMicroseconds(d, fps);
  enforceSourceBounds(prev);
  prev.timeline_duration_frames = durationFramesFromSource(
    prev.src_in_us,
    prev.src_out_us,
    fps,
  );

  // Adjust next's head symmetrically
  next.src_in_us = next.src_in_us + framesToMicroseconds(d, fps);
  next.timeline_in_frame = next.timeline_in_frame + d;
  enforceSourceBounds(next);
  next.timeline_duration_frames = durationFramesFromSource(
    next.src_in_us,
    next.src_out_us,
    fps,
  );
  // Restore next position (slide doesn't move neighbors on timeline)
  next.timeline_in_frame = clip.timeline_in_frame + clip.timeline_duration_frames;

  return tl;
}
