import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import AppShell from './components/AppShell';
import EditorLayout, { type BottomTab } from './components/EditorLayout';
import { type EditorMode } from './components/HeaderBar';
import { useAiJob } from './hooks/useAiJob';
import { useAlternatives, type AlternativeCandidate } from './hooks/useAlternatives';
import { useDiff, computeDiff, type ClipDiff } from './hooks/useDiff';
import { usePlayback } from './hooks/usePlayback';
import { useSourcePlayback } from './hooks/useSourcePlayback';
import { useProjectSync } from './hooks/useProjectSync';
import { useReview } from './hooks/useReview';
import { useSelection } from './hooks/useSelection';
import { useTimeline } from './hooks/useTimeline';
import { useTrackState } from './hooks/useTrackState';
import { useSnap } from './hooks/useSnap';
import { useTrimTool } from './hooks/useTrimTool';
import type { AudioPolicy, ChangesSummary, Clip, SelectionState, TimelineIR, Track } from './types';
import { buildLanes, computeAutoFitZoom, FALLBACK_ZOOM, findSelectedClip, getTotalFrames } from './utils/editor-helpers';
import { formatClockFromFrames, getFps, framesToMicroseconds, microsecondsToFrames } from './utils/time';

export default function App() {
  const [editorMode, setEditorMode] = useState<EditorMode>('nle');
  const [bottomTab, setBottomTab] = useState<BottomTab>('timeline');
  const [remoteDiffs, setRemoteDiffs] = useState<ClipDiff[] | null>(null);
  const [remoteCompareRevision, setRemoteCompareRevision] = useState<string | null>(null);
  const [activeMonitor, setActiveMonitor] = useState<'source' | 'program'>('program');
  const [confidenceFilter, setConfidenceFilter] = useState<'all' | 'low' | 'warnings'>('all');

  const ts = useTimeline();
  const sel = useSelection();
  const trackState = useTrackState(ts.projectId);
  const [zoom, setZoom] = useState(FALLBACK_ZOOM);
  const timeline = ts.timeline;
  const fps = timeline ? getFps(timeline.sequence) : 24;
  const lanes = useMemo(() => buildLanes(timeline), [timeline]);
  const totalFrames = useMemo(() => getTotalFrames(timeline), [timeline]);
  const selectedClip = findSelectedClip(timeline, sel.selection);
  const playback = usePlayback({ projectId: ts.projectId, fps, durationFrames: totalFrames, startFrame: timeline?.sequence?.start_frame ?? 0, timeline, trackStates: trackState.stateMap });
  const sourcePlayback = useSourcePlayback({ projectId: ts.projectId, fps });
  const snap = useSnap({ lanes, markers: timeline?.markers ?? [], playheadFrame: playback.playheadFrame, fps, zoom });
  const review = useReview(ts.projectId, {
    onConflict: (remoteRev) => ts.triggerConflict(remoteRev),
  });
  const selectedClipId = sel.selection?.clipId ?? null;
  const alts = useAlternatives(ts.projectId, selectedClipId);
  const clipDiffs = useDiff(ts.sessionBaseline, ts.timeline, ts.historyOrigins, ts.historySnapshots);
  const aiJob = useAiJob(ts.projectId, {
    onCompileComplete: () => { void ts.reload(); review.reload(); },
    onReviewComplete: () => { void ts.reload(); review.reload(); },
    onRenderComplete: () => { void ts.reload(); review.reload(); },
    onConflict: (remoteRev) => ts.triggerConflict(remoteRev),
  });
  const sync = useProjectSync({
    projectId: ts.projectId, localRevision: ts.timelineRevision, dirty: ts.dirty,
    onTimelineReload: async () => { await ts.reload(); },
    onReviewReload: () => { review.reload(); },
  });

  // ── Trim tool ────────────────────────────────────────────────────────
  const trim = useTrimTool({
    timeline,
    fps,
    lanes,
    trackStates: trackState.stateMap,
    linkedSelectionEnabled: sel.linkedSelectionEnabled,
    pushTimeline: ts.pushTimeline,
    updateTimelineSilent: ts.replacePresent,
    beginDrag: ts.beginDrag,
    endDrag: ts.endDrag,
    snapDrag: snap.snapDrag,
    clearSnap: snap.clearGuide,
  });

  // Keep linked selection in sync with timeline
  useEffect(() => { sel.setTimelineForLinks(timeline); }, [timeline]);

  useEffect(() => { sel.clearSelection(); }, [ts.projectId]);
  useEffect(() => { if (timeline) setZoom(computeAutoFitZoom(getTotalFrames(timeline))); }, [ts.projectId, timeline?.project_id]);
  useEffect(() => { if (ts.dirty) playback.markPreviewStale(); }, [ts.dirty]);
  useEffect(() => { if (sel.selection && !selectedClip) sel.clearSelection(); }, [selectedClip, sel.selection]);
  // Clear remote diffs when project changes or conflict resolves
  useEffect(() => { setRemoteDiffs(null); setRemoteCompareRevision(null); }, [ts.projectId]);

  // HIGH 2: Compute local changes summary from session diff
  const localChangesSummary: ChangesSummary = {
    added: clipDiffs.filter(d => d.changes.includes('added')).length,
    removed: clipDiffs.filter(d => d.changes.includes('removed')).length,
    modified: clipDiffs.filter(d => !d.changes.includes('added') && !d.changes.includes('removed')).length,
  };

  // HIGH 2: Fetch remote changes summary when merge dialog/banner triggers
  const [remoteChangesSummary, setRemoteChangesSummary] = useState<ChangesSummary | null>(null);
  useEffect(() => {
    const needsSummary = sync.showMergeBanner || !!ts.conflict;
    if (!needsSummary || !ts.sessionBaseline || !ts.projectId) {
      setRemoteChangesSummary(null);
      return;
    }
    let cancelled = false;
    fetch(`/api/projects/${ts.projectId}/timeline`)
      .then(resp => resp.ok ? resp.json() as Promise<TimelineIR> : null)
      .then(remote => {
        if (cancelled || !remote || !ts.sessionBaseline) return;
        const diffs = computeDiff(ts.sessionBaseline.timeline, remote, new Set());
        setRemoteChangesSummary({
          added: diffs.filter(d => d.changes.includes('added')).length,
          removed: diffs.filter(d => d.changes.includes('removed')).length,
          modified: diffs.filter(d => !d.changes.includes('added') && !d.changes.includes('removed')).length,
        });
      })
      .catch(() => { if (!cancelled) setRemoteChangesSummary(null); });
    return () => { cancelled = true; };
  }, [sync.showMergeBanner, !!ts.conflict, ts.projectId]);

  // ── Patch preview (temporarily apply a single op) ─────────────────
  const [previewingPatchIndex, setPreviewingPatchIndex] = useState<number | null>(null);
  const previewBaselineRef = useRef<TimelineIR | null>(null);

  const handlePreviewPatch = useCallback((filteredIdx: number) => {
    if (!timeline || !review.patch?.data) return;
    const operations = review.patch.safety?.filtered_patch?.operations ?? review.patch.data.operations;
    const op = operations[filteredIdx];
    if (!op) return;

    if (previewingPatchIndex === filteredIdx) {
      // Exit preview: restore baseline
      if (previewBaselineRef.current) {
        ts.replacePresent(previewBaselineRef.current);
        previewBaselineRef.current = null;
      }
      setPreviewingPatchIndex(null);
      return;
    }

    // Save baseline before first preview
    if (previewBaselineRef.current == null) {
      previewBaselineRef.current = structuredClone(timeline);
    } else {
      // Restore previous baseline before applying new preview
      ts.replacePresent(previewBaselineRef.current);
    }

    // Apply single op preview client-side
    const previewTl = structuredClone(previewBaselineRef.current ?? timeline);

    if (op.op === 'insert_segment') {
      // Insert a temporary clip on the target track (or first video track)
      const targetTrackId = op.target_track_id;
      let inserted = false;
      for (const kind of ['video', 'audio'] as const) {
        for (const track of previewTl.tracks[kind]) {
          if (targetTrackId ? track.track_id === targetTrackId : kind === 'video' && !inserted) {
            const newClip: Clip = {
              clip_id: `preview_insert_${filteredIdx}`,
              segment_id: op.with_segment_id ?? 'preview',
              asset_id: op.with_segment_id ?? 'preview',
              src_in_us: op.new_src_in_us ?? 0,
              src_out_us: op.new_src_out_us ?? 1_000_000,
              timeline_in_frame: op.new_timeline_in_frame ?? 0,
              timeline_duration_frames: op.new_duration_frames ?? 30,
              role: op.role ?? 'hero',
              motivation: op.reason ?? '[Preview insert]',
              confidence: op.confidence,
            };
            track.clips.push(newClip);
            inserted = true;
          }
        }
      }
    } else if (op.op === 'remove_segment' && op.target_clip_id) {
      // Remove the target clip
      for (const kind of ['video', 'audio'] as const) {
        for (const track of previewTl.tracks[kind]) {
          const idx = track.clips.findIndex(c => c.clip_id === op.target_clip_id);
          if (idx >= 0) track.clips.splice(idx, 1);
        }
      }
    } else if (op.op === 'change_audio_policy' && op.target_clip_id && op.audio_policy) {
      // Update audio policy on the target clip
      for (const kind of ['video', 'audio'] as const) {
        for (const track of previewTl.tracks[kind]) {
          const clip = track.clips.find(c => c.clip_id === op.target_clip_id);
          if (clip) clip.audio_policy = { ...clip.audio_policy, ...op.audio_policy };
        }
      }
    } else if (op.target_clip_id) {
      // trim_segment, replace_segment, move_segment
      for (const kind of ['video', 'audio'] as const) {
        for (const track of previewTl.tracks[kind]) {
          const clip = track.clips.find(c => c.clip_id === op.target_clip_id);
          if (!clip) continue;
          if (op.op === 'trim_segment') {
            if (op.new_src_in_us != null) clip.src_in_us = op.new_src_in_us;
            if (op.new_src_out_us != null) clip.src_out_us = op.new_src_out_us;
            if (op.new_duration_frames != null) clip.timeline_duration_frames = op.new_duration_frames;
          } else if (op.op === 'replace_segment' && op.with_segment_id) {
            clip.segment_id = op.with_segment_id;
            if (op.new_src_in_us != null) clip.src_in_us = op.new_src_in_us;
            if (op.new_src_out_us != null) clip.src_out_us = op.new_src_out_us;
          } else if (op.op === 'move_segment' && op.new_timeline_in_frame != null) {
            clip.timeline_in_frame = op.new_timeline_in_frame;
          }
        }
      }
    }
    // add_marker and add_note are non-visual: no preview effect needed

    ts.replacePresent(previewTl);
    setPreviewingPatchIndex(filteredIdx);
  }, [timeline, review.patch, ts.replacePresent, previewingPatchIndex]);

  // Exit preview when patch data changes
  useEffect(() => {
    if (previewingPatchIndex != null && previewBaselineRef.current) {
      ts.replacePresent(previewBaselineRef.current);
      previewBaselineRef.current = null;
      setPreviewingPatchIndex(null);
    }
  }, [review.patch?.revision]);

  async function handleApplyPatch(indexes: number[]): Promise<void> {
    if (!ts.timelineRevision || aiJob.isRunning) return;

    // Locked track preflight: skip ops targeting locked tracks
    const operations = review.patch?.safety?.filtered_patch?.operations ?? review.patch?.data?.operations ?? [];
    const lockedWarns: string[] = [];
    const safeIndexes = indexes.filter(idx => {
      const op = operations.find(o => (o.original_index ?? 0) === idx) ?? operations[idx];
      if (!op || !timeline) return true;

      // insert_segment: check target_track_id directly
      if (op.op === 'insert_segment') {
        if (op.target_track_id) {
          if (trackState.stateMap[op.target_track_id]?.locked) {
            lockedWarns.push(`Skipped insert on locked track ${op.target_track_id}`);
            return false;
          }
        } else if (!op.target_clip_id) {
          // No track or clip target — cannot determine lock, warn
          lockedWarns.push(`insert_segment has no target_track_id or target_clip_id — skipping lock check`);
        }
      }

      // target_clip_id-based check (all other ops + insert with clip ref)
      if (!op.target_clip_id) return true;
      for (const kind of ['video', 'audio'] as const) {
        for (const track of timeline.tracks[kind]) {
          if (track.clips.some(c => c.clip_id === op.target_clip_id)) {
            if (trackState.stateMap[track.track_id]?.locked) {
              lockedWarns.push(`Skipped op on locked track ${track.track_id}: ${op.target_clip_id}`);
              return false;
            }
          }
        }
      }
      return true;
    });

    if (lockedWarns.length > 0) {
      console.warn('[PatchPreflight]', lockedWarns.join('; '));
    }
    if (safeIndexes.length === 0) return;

    // Exit preview if active
    if (previewingPatchIndex != null && previewBaselineRef.current) {
      ts.replacePresent(previewBaselineRef.current);
      previewBaselineRef.current = null;
      setPreviewingPatchIndex(null);
    }

    const r = await review.applyPatch({ base_timeline_revision: ts.timelineRevision, operation_indexes: safeIndexes });
    if (r?.ok) { ts.commitRemoteMutation(r.timeline, r.timeline_revision_after); review.reload(); }
  }
  function handleSwapClip(c: AlternativeCandidate): void {
    const s = sel.selection;
    if (!s || aiJob.isRunning) return;
    ts.swapClip(s.trackKind, s.trackId, s.clipId, {
      segment_id: c.segment_id, asset_id: c.asset_id, src_in_us: c.src_in_us, src_out_us: c.src_out_us,
      confidence: c.confidence, quality_flags: c.quality_flags, candidate_ref: c.segment_id, why_it_matches: c.why_it_matches,
    });
  }
  async function handleExportRender(): Promise<void> {
    if (!timeline || aiJob.isRunning) return;
    let rev = ts.timelineRevision;
    if (ts.dirty || ts.status === 'saving') { const sr = await ts.save(); if (!sr.ok) return; rev = sr.timelineRevision ?? rev; }
    await playback.requestFullPreview({ timelineRevision: rev });
  }
  // ── Insert / Overwrite (F9 / F10) ───────────────────────────────────

  const handleInsert = useCallback(() => {
    if (!timeline || aiJob.isRunning) return;
    const srcAsset = sourcePlayback.currentAsset;
    if (!srcAsset) return;

    const srcInUs = sourcePlayback.markInUs ?? 0;
    const srcOutUs = sourcePlayback.markOutUs ?? Math.round(sourcePlayback.durationSec * 1_000_000);
    if (srcOutUs <= srcInUs) return;

    // Source topology gates: only create clips for media types that exist
    const createVideo = srcAsset.hasVideo;
    const createAudio = srcAsset.hasAudio;
    if (!createVideo && !createAudio) return;

    // Block if source has audio but no audio targets are active
    const audioTargetArr = Array.from(trackState.audioTargets);
    if (createAudio && audioTargetArr.length === 0) return;

    const insertDurationFrames = Math.max(1, microsecondsToFrames(srcOutUs - srcInUs, fps));
    const editPoint = playback.playheadFrame;

    // Check blocking: target tracks not locked
    const vTarget = trackState.videoTarget;
    if (createVideo && trackState.stateMap[vTarget]?.locked) return;
    if (createAudio) {
      for (const at of trackState.audioTargets) {
        if (trackState.stateMap[at]?.locked) return;
      }
    }

    const nextTimeline = structuredClone(timeline);

    // Create video clip on video target (only if source has video)
    if (createVideo) {
      const vTrack = nextTimeline.tracks.video.find((t: Track) => t.track_id === vTarget);
      if (vTrack) {
        const newClip: Clip = {
          clip_id: `ins_v_${Date.now()}`,
          segment_id: srcAsset.assetId,
          asset_id: srcAsset.assetId,
          src_in_us: srcInUs,
          src_out_us: srcOutUs,
          timeline_in_frame: editPoint,
          timeline_duration_frames: insertDurationFrames,
          role: 'hero',
          motivation: '[Insert from Source Monitor]',
        };

        splitAndRipple(vTrack, editPoint, insertDurationFrames, fps);
        vTrack.clips.push(newClip);
      }
    }

    // Create audio clips on audio targets (only if source has audio)
    if (createAudio) {
      for (let i = 0; i < audioTargetArr.length; i++) {
        const aTrack = nextTimeline.tracks.audio.find((t: Track) => t.track_id === audioTargetArr[i]);
        if (!aTrack) continue;

        const newClip: Clip = {
          clip_id: `ins_a${i}_${Date.now()}`,
          segment_id: srcAsset.assetId,
          asset_id: srcAsset.assetId,
          src_in_us: srcInUs,
          src_out_us: srcOutUs,
          timeline_in_frame: editPoint,
          timeline_duration_frames: insertDurationFrames,
          role: 'dialogue',
          motivation: '[Insert from Source Monitor]',
        };

        splitAndRipple(aTrack, editPoint, insertDurationFrames, fps);
        aTrack.clips.push(newClip);
      }
    }

    // Ripple sync-lock tracks
    for (const kind of ['video', 'audio'] as const) {
      for (const track of nextTimeline.tracks[kind]) {
        const isPatched = kind === 'video'
          ? (createVideo && track.track_id === vTarget)
          : (createAudio && trackState.audioTargets.has(track.track_id));
        if (isPatched) continue;
        const st = trackState.stateMap[track.track_id];
        if (!st?.syncLock || st?.locked) continue;
        rippleTrackDownstream(track, editPoint, insertDurationFrames, fps);
      }
    }

    ts.pushTimeline(nextTimeline);
  }, [timeline, aiJob.isRunning, sourcePlayback, playback.playheadFrame, fps, trackState, ts]);

  const handleOverwrite = useCallback(() => {
    if (!timeline || aiJob.isRunning) return;
    const srcAsset = sourcePlayback.currentAsset;
    if (!srcAsset) return;

    const srcInUs = sourcePlayback.markInUs ?? 0;
    const srcOutUs = sourcePlayback.markOutUs ?? Math.round(sourcePlayback.durationSec * 1_000_000);
    if (srcOutUs <= srcInUs) return;

    // Source topology gates
    const createVideo = srcAsset.hasVideo;
    const createAudio = srcAsset.hasAudio;
    if (!createVideo && !createAudio) return;

    // Block if source has audio but no audio targets are active
    const audioTargetArr = Array.from(trackState.audioTargets);
    if (createAudio && audioTargetArr.length === 0) return;

    const overwriteDuration = Math.max(1, microsecondsToFrames(srcOutUs - srcInUs, fps));
    const editPoint = playback.playheadFrame;
    const overwriteEnd = editPoint + overwriteDuration;

    const vTarget = trackState.videoTarget;
    if (createVideo && trackState.stateMap[vTarget]?.locked) return;
    if (createAudio) {
      for (const at of trackState.audioTargets) {
        if (trackState.stateMap[at]?.locked) return;
      }
    }

    const nextTimeline = structuredClone(timeline);

    // Overwrite on video target (only if source has video)
    if (createVideo) {
      const vTrack = nextTimeline.tracks.video.find((t: Track) => t.track_id === vTarget);
      if (vTrack) {
        clearRange(vTrack, editPoint, overwriteEnd, fps);
        vTrack.clips.push({
          clip_id: `ovw_v_${Date.now()}`,
          segment_id: srcAsset.assetId,
          asset_id: srcAsset.assetId,
          src_in_us: srcInUs,
          src_out_us: srcOutUs,
          timeline_in_frame: editPoint,
          timeline_duration_frames: overwriteDuration,
          role: 'hero',
          motivation: '[Overwrite from Source Monitor]',
        });
      }
    }

    // Overwrite on audio targets (only if source has audio)
    if (createAudio) {
      for (let i = 0; i < audioTargetArr.length; i++) {
        const aTrack = nextTimeline.tracks.audio.find((t: Track) => t.track_id === audioTargetArr[i]);
        if (!aTrack) continue;

        clearRange(aTrack, editPoint, overwriteEnd, fps);
        aTrack.clips.push({
          clip_id: `ovw_a${i}_${Date.now()}`,
          segment_id: srcAsset.assetId,
          asset_id: srcAsset.assetId,
          src_in_us: srcInUs,
          src_out_us: srcOutUs,
          timeline_in_frame: editPoint,
          timeline_duration_frames: overwriteDuration,
          role: 'dialogue',
          motivation: '[Overwrite from Source Monitor]',
        });
      }
    }

    ts.pushTimeline(nextTimeline);
  }, [timeline, aiJob.isRunning, sourcePlayback, playback.playheadFrame, fps, trackState, ts]);

  // ── Track IDs for patch matrix ─────────────────────────────────────
  const videoTrackIds = useMemo(() => timeline?.tracks.video.map(t => t.track_id) ?? [], [timeline]);
  const audioTrackIds = useMemo(() => timeline?.tracks.audio.map(t => t.track_id) ?? [], [timeline]);

  // ── Alternatives preview → Source Monitor ─────────────────────────
  const handlePreviewAlternative = useCallback((candidate: AlternativeCandidate) => {
    if (sourcePlayback.sourceMapLoaded) {
      sourcePlayback.loadSource(candidate.asset_id, candidate.segment_id);
    }
  }, [sourcePlayback.sourceMapLoaded, sourcePlayback.loadSource]);

  // ── Load source when clip selected ─────────────────────────────────
  useEffect(() => {
    if (selectedClip && sourcePlayback.sourceMapLoaded) {
      sourcePlayback.loadSource(selectedClip.asset_id, selectedClip.segment_id);
    }
  }, [sel.selection?.clipId, sourcePlayback.sourceMapLoaded]);

  // ── Link toggle (Cmd+L) for J/L-cut ─────────────────────────────────
  const handleToggleLink = useCallback(() => {
    if (!timeline || aiJob.isRunning) return;
    const primary = sel.selection;
    if (!primary) return;

    const clip = findSelectedClip(timeline, primary);
    if (!clip) return;

    const existingGroup = clip.metadata?.link_group_id as string | undefined;

    if (existingGroup) {
      // Unlink: remove link_group_id from all clips in this group
      ts.pushTimeline(
        (() => {
          const tl = structuredClone(timeline);
          for (const kind of ['video', 'audio'] as const) {
            for (const track of tl.tracks[kind]) {
              for (const c of track.clips) {
                if (c.metadata?.link_group_id === existingGroup) {
                  delete c.metadata.link_group_id;
                }
              }
            }
          }
          return tl;
        })(),
      );
    } else {
      // Link: find matching clip on opposite track kind (by asset_id)
      const oppositeKind = primary.trackKind === 'video' ? 'audio' : 'video';
      let partner: { trackId: string; clipId: string } | null = null;
      for (const track of timeline.tracks[oppositeKind]) {
        for (const c of track.clips) {
          if (c.asset_id === clip.asset_id) {
            partner = { trackId: track.track_id, clipId: c.clip_id };
            break;
          }
        }
        if (partner) break;
      }
      if (!partner) return;

      const groupId = `link_${clip.clip_id}_${partner.clipId}`;
      ts.pushTimeline(
        (() => {
          const tl = structuredClone(timeline);
          // Set link_group_id on both clips
          const setLink = (kind: 'video' | 'audio', tid: string, cid: string) => {
            const track = tl.tracks[kind].find((t) => t.track_id === tid);
            const c = track?.clips.find((cl) => cl.clip_id === cid);
            if (c) {
              c.metadata = { ...c.metadata, link_group_id: groupId };
            }
          };
          setLink(primary.trackKind, primary.trackId, primary.clipId);
          setLink(oppositeKind, partner!.trackId, partner!.clipId);
          return tl;
        })(),
      );
    }
  }, [timeline, aiJob.isRunning, sel.selection, ts.pushTimeline]);

  function handleUpdateAudio(field: keyof AudioPolicy, value: number | boolean): void {
    const s = sel.selection;
    if (!s || aiJob.isRunning) return;
    ts.updateClip(s.trackKind, s.trackId, s.clipId, (clip) => {
      clip.audio_policy = { ...clip.audio_policy, [field]: typeof value === 'number' ? (Number.isFinite(value) ? value : 0) : value };
    });
  }
  function handleMergeReload() { ts.conflict ? void ts.resolveConflictWithReload() : sync.acceptRemote(); setRemoteDiffs(null); }
  function handleMergeKeep() { ts.conflict ? ts.dismissConflict() : sync.keepLocal(); }
  async function handleMergeCompare() {
    // Fetch remote timeline for local-vs-remote diff
    if (ts.projectId && ts.timeline) {
      try {
        const resp = await fetch(`/api/projects/${ts.projectId}/timeline`);
        if (resp.ok) {
          const remote = (await resp.json()) as TimelineIR;
          const etag = resp.headers.get('ETag');
          const remoteRev = etag ? etag.replace(/^"|"$/g, '') : null;
          const diffs = computeDiff(remote, ts.timeline, new Set());
          setRemoteDiffs(diffs);
          setRemoteCompareRevision(remoteRev);
        }
      } catch { /* fetch failed — still open diff view */ }
    }

    if (ts.conflict) ts.dismissConflict();
    else sync.keepLocal();
    setEditorMode('ai');
    setBottomTab('diff');
  }

  // ── Jump to clip (from DiffPanel) ──────────────────────────────────
  const handleJumpToClip = useCallback((clipId: string) => {
    if (!timeline) return;
    // Find the clip in the timeline
    for (const kind of ['video', 'audio'] as const) {
      for (const track of timeline.tracks[kind]) {
        const clip = track.clips.find((c) => c.clip_id === clipId);
        if (clip) {
          sel.selectClip({ trackKind: kind, trackId: track.track_id, clipId: clip.clip_id });
          // Seek playhead to clip start
          playback.seekToFrame(clip.timeline_in_frame);
          return;
        }
      }
    }
  }, [timeline, sel.selectClip, playback.seekToFrame]);

  // ── Apply selected patch (from CommandPalette) ───────────────────
  const handleApplySelectedPatch = useCallback(() => {
    if (!sel.selection || !review.patch?.data || !timeline) return;
    const operations = review.patch.safety?.filtered_patch?.operations ?? review.patch.data.operations;
    const matchingOps = operations
      .map((op, i) => ({ op, idx: op.original_index ?? i }))
      .filter(({ op }) => op.target_clip_id === sel.selection?.clipId);
    if (matchingOps.length > 0) {
      void handleApplyPatch(matchingOps.map(m => m.idx));
    }
  }, [sel.selection, review.patch, timeline]);

  // ── Lift (delete with gap) ─────────────────────────────────────────
  const handleLift = useCallback(() => {
    if (!timeline || aiJob.isRunning) return;
    const s = sel.selection;
    if (!s) return;
    if (trackState.stateMap[s.trackId]?.locked) return;

    const nextTimeline = structuredClone(timeline);
    for (const kind of ['video', 'audio'] as const) {
      for (const track of nextTimeline.tracks[kind]) {
        const idx = track.clips.findIndex(c => c.clip_id === s.clipId);
        if (idx >= 0) {
          track.clips.splice(idx, 1);
          break;
        }
      }
    }
    sel.clearSelection();
    ts.pushTimeline(nextTimeline);
  }, [timeline, aiJob.isRunning, sel.selection, trackState.stateMap, ts.pushTimeline, sel.clearSelection]);

  // ── Ripple delete (Shift+Delete: remove clip + close gap) ─────────
  const handleRippleDelete = useCallback(() => {
    if (!timeline || aiJob.isRunning) return;
    const s = sel.selection;
    if (!s) return;
    if (trackState.stateMap[s.trackId]?.locked) return;

    const nextTimeline = structuredClone(timeline);
    let removedInFrame = -1;
    let removedDuration = 0;
    let removedTrackId: string | null = null;
    let removedKind: 'video' | 'audio' | null = null;

    // Remove the clip and record its position
    for (const kind of ['video', 'audio'] as const) {
      for (const track of nextTimeline.tracks[kind]) {
        const idx = track.clips.findIndex(c => c.clip_id === s.clipId);
        if (idx >= 0) {
          removedInFrame = track.clips[idx].timeline_in_frame;
          removedDuration = track.clips[idx].timeline_duration_frames;
          removedTrackId = track.track_id;
          removedKind = kind;
          track.clips.splice(idx, 1);
          // Ripple: shift downstream clips on this track
          for (const c of track.clips) {
            if (c.timeline_in_frame >= removedInFrame) {
              c.timeline_in_frame -= removedDuration;
            }
          }
          break;
        }
      }
      if (removedKind) break;
    }

    if (removedKind && removedTrackId && removedDuration > 0) {
      // Ripple sync-lock tracks — split straddling clips at editPoint
      const editPoint = removedInFrame;
      const delta = -removedDuration;
      for (const kind of ['video', 'audio'] as const) {
        for (const track of nextTimeline.tracks[kind]) {
          if (track.track_id === removedTrackId) continue;
          const st = trackState.stateMap[track.track_id];
          if (!st?.syncLock || st?.locked) continue;

          // 1. Find clips that straddle the edit point
          const toSplit: number[] = [];
          for (let i = 0; i < track.clips.length; i++) {
            const c = track.clips[i];
            const clipEnd = c.timeline_in_frame + c.timeline_duration_frames;
            if (c.timeline_in_frame < editPoint && clipEnd > editPoint) {
              toSplit.push(i);
            }
          }

          // 2. Split straddling clips (reverse to preserve indices)
          const splitCreatedIds = new Set<string>();
          for (let si = toSplit.length - 1; si >= 0; si--) {
            const idx = toSplit[si];
            const c = track.clips[idx];
            const framesBefore = editPoint - c.timeline_in_frame;
            const framesAfter = c.timeline_duration_frames - framesBefore;
            const srcSplitUs = c.src_in_us + framesToMicroseconds(framesBefore, fps);

            // Before-portion stays in place, after-portion shifts by delta
            const afterClip: Clip = {
              clip_id: `${c.clip_id}_rd${idx}`,
              segment_id: c.segment_id,
              asset_id: c.asset_id,
              src_in_us: srcSplitUs,
              src_out_us: c.src_out_us,
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
            // Original becomes before-portion
            c.src_out_us = srcSplitUs;
            c.timeline_duration_frames = framesBefore;
            track.clips.splice(idx + 1, 0, afterClip);
          }

          // 3. Shift non-split downstream clips
          for (const c of track.clips) {
            if (splitCreatedIds.has(c.clip_id)) continue;
            if (c.timeline_in_frame >= editPoint) {
              c.timeline_in_frame = Math.max(0, c.timeline_in_frame + delta);
            }
          }
        }
      }
    }

    sel.clearSelection();
    ts.pushTimeline(nextTimeline);
  }, [timeline, aiJob.isRunning, sel.selection, trackState.stateMap, ts.pushTimeline, sel.clearSelection]);

  // ── Match frame (F key) ───────────────────────────────────────────
  const handleMatchFrame = useCallback(() => {
    if (!timeline || !selectedClip) return;
    // Load the selected clip's source in the Source Monitor at the current playhead offset
    if (sourcePlayback.sourceMapLoaded) {
      sourcePlayback.loadSource(selectedClip.asset_id, selectedClip.segment_id);
      // Seek source to the same relative position as the program playhead
      const offset = playback.playheadFrame - selectedClip.timeline_in_frame;
      if (offset >= 0 && offset < selectedClip.timeline_duration_frames) {
        sourcePlayback.seekToFrame?.(offset);
      }
    }
  }, [timeline, selectedClip, sourcePlayback, playback.playheadFrame]);

  // ── Reveal low confidence clips ────────────────────────────────────
  const handleRevealLowConfidence = useCallback(() => {
    setConfidenceFilter('low');
    setBottomTab('timeline');
  }, []);

  // ── Stable callback refs for ClipLayer memo ──────────────────────────
  const trimBeginRef = useRef(trim.beginTrim);
  trimBeginRef.current = trim.beginTrim;
  const trimUpdateRef = useRef(trim.updateTrim);
  trimUpdateRef.current = trim.updateTrim;
  const trimCommitRef = useRef(trim.commitTrim);
  trimCommitRef.current = trim.commitTrim;

  const handleSelectClip = useCallback(
    (tk: 'video' | 'audio', tid: string, clip: Clip, event: { shiftKey: boolean; metaKey: boolean; ctrlKey: boolean }) => {
      if (event.shiftKey) {
        sel.addToSelection({ trackKind: tk, trackId: tid, clipId: clip.clip_id });
      } else if (event.metaKey || event.ctrlKey) {
        sel.toggleSelection({ trackKind: tk, trackId: tid, clipId: clip.clip_id });
      } else {
        sel.selectClip({ trackKind: tk, trackId: tid, clipId: clip.clip_id });
      }
    },
    [sel.addToSelection, sel.toggleSelection, sel.selectClip],
  );

  const handleMarqueeSelect = useCallback(
    (items: SelectionState[]) => sel.selectMultiple(items),
    [sel.selectMultiple],
  );

  const handleTrimBegin = useCallback(
    (target: import('./types').TrimTarget, opts?: { altKey?: boolean }) => trimBeginRef.current(target, opts),
    [],
  );
  const handleTrimUpdate = useCallback(
    (deltaFrames: number, opts?: { skipSnap?: boolean }) => trimUpdateRef.current(deltaFrames, opts),
    [],
  );
  const handleTrimCommit = useCallback(() => trimCommitRef.current(), []);

  return (
    <AppShell
      timelineState={ts}
      playback={playback}
      sourcePlayback={sourcePlayback}
      activeMonitor={activeMonitor}
      onSetActiveMonitor={setActiveMonitor}
      selectionState={sel}
      trimState={trim}
      aiJob={aiJob}
      sync={sync}
      localChangedCount={clipDiffs.length}
      localChangesSummary={localChangesSummary}
      remoteChangesSummary={remoteChangesSummary}
      editorMode={editorMode}
      onModeChange={setEditorMode}
      bottomTab={bottomTab}
      onBottomTabChange={setBottomTab}
      onExportRender={handleExportRender}
      onMergeReload={handleMergeReload}
      onMergeKeep={handleMergeKeep}
      onMergeCompare={handleMergeCompare}
      onToggleSnap={snap.toggle}
      onToggleLoop={() => {
        if (activeMonitor === 'source') {
          sourcePlayback.setLoopEnabled(!sourcePlayback.loopEnabled);
        } else {
          playback.setLoopEnabled(!playback.loopEnabled);
        }
      }}
      onLinkToggle={handleToggleLink}
      onRippleDelete={handleRippleDelete}
      onLift={handleLift}
      onInsert={handleInsert}
      onOverwrite={handleOverwrite}
      onMatchFrame={handleMatchFrame}
      onRevealLowConfidence={handleRevealLowConfidence}
      onApplySelectedPatch={handleApplySelectedPatch}
    >
      <EditorLayout
        mode={editorMode}
        activeMonitor={activeMonitor}
        onSetActiveMonitor={setActiveMonitor}
        playback={playback}
        sourcePlayback={sourcePlayback}
        transportTimecode={formatClockFromFrames(playback.playheadFrame, fps)}
        timeline={timeline} fps={fps} lanes={lanes} totalFrames={totalFrames} zoom={zoom} onZoomChange={setZoom}
        projectId={ts.projectId || null}
        selectedClipId={selectedClipId} selectedClipIds={sel.selectedClipIds} selectedClip={selectedClip}
        onSelectClip={handleSelectClip}
        onClearSelection={sel.clearSelection}
        onMarqueeSelect={handleMarqueeSelect}
        trimMode={trim.trimMode}
        activeTrimTarget={trim.activeTrimTarget}
        isDragging={trim.isDragging}
        trimDelta={trim.trimDelta}
        onSetTrimMode={trim.setTrimMode}
        onTrimBegin={handleTrimBegin}
        onTrimUpdate={handleTrimUpdate}
        onTrimCommit={handleTrimCommit}
        trackStates={trackState.stateMap}
        onToggleLock={trackState.toggleLock}
        onToggleMute={trackState.toggleMute}
        onToggleSolo={trackState.toggleSolo}
        onToggleSyncLock={trackState.toggleSyncLock}
        onCycleHeight={trackState.cycleHeight}
        snapEnabled={snap.enabled}
        activeSnapGuide={snap.activeGuide}
        onUpdateAudioNumber={(f, v) => handleUpdateAudio(f, v)} onUpdateAudioBoolean={(f, v) => handleUpdateAudio(f, v)}
        reviewReport={review.report} reviewPatch={review.patch} reviewBlueprint={review.blueprint}
        dirty={ts.dirty} timelineRevision={ts.timelineRevision}
        sessionBaselineRevision={ts.sessionBaseline?.baselineRevision ?? null}
        onApplyPatch={handleApplyPatch} alternatives={alts.alternatives} alternativesLoading={alts.loading}
        onSwapClip={handleSwapClip} clipDiffs={clipDiffs}
        remoteDiffs={remoteDiffs} remoteCompareRevision={remoteCompareRevision}
        aiJobIsRunning={aiJob.isRunning}
        videoTarget={trackState.videoTarget}
        audioTargets={trackState.audioTargets}
        videoTrackIds={videoTrackIds}
        audioTrackIds={audioTrackIds}
        onToggleVideoTarget={trackState.toggleVideoTarget}
        onToggleAudioTarget={trackState.toggleAudioTarget}
        onPreviewAlternative={handlePreviewAlternative}
        onExportRender={() => { void handleExportRender(); }}
        bottomTab={bottomTab} onBottomTabChange={setBottomTab}
        onJumpToClip={handleJumpToClip}
        confidenceFilter={confidenceFilter}
        onConfidenceFilterChange={setConfidenceFilter}
        onPreviewPatch={handlePreviewPatch}
        previewingPatchIndex={previewingPatchIndex} />
    </AppShell>
  );
}

// ── Insert/Overwrite helpers ─────────────────────────────────────────

/** Split clips straddling the edit point and ripple downstream by delta */
function splitAndRipple(track: Track, editPoint: number, delta: number, fps: number): void {
  // Split straddling clips
  const toSplit: number[] = [];
  for (let i = 0; i < track.clips.length; i++) {
    const c = track.clips[i];
    const end = c.timeline_in_frame + c.timeline_duration_frames;
    if (c.timeline_in_frame < editPoint && end > editPoint) {
      toSplit.push(i);
    }
  }

  for (let si = toSplit.length - 1; si >= 0; si--) {
    const idx = toSplit[si];
    const c = track.clips[idx];
    const framesBefore = editPoint - c.timeline_in_frame;
    const framesAfter = c.timeline_duration_frames - framesBefore;
    const srcSplitUs = c.src_in_us + framesToMicroseconds(framesBefore, fps);

    const afterClip: Clip = {
      clip_id: `${c.clip_id}_split${idx}`,
      segment_id: c.segment_id,
      asset_id: c.asset_id,
      src_in_us: srcSplitUs,
      src_out_us: c.src_out_us,
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

    // Trim original to before-portion
    c.src_out_us = srcSplitUs;
    c.timeline_duration_frames = framesBefore;
    track.clips.splice(idx + 1, 0, afterClip);
  }

  // Ripple downstream (non-split clips at or after editPoint)
  const splitIds = new Set(toSplit.map((idx) => `${track.clips[idx]?.clip_id}_split${idx}`));
  for (const c of track.clips) {
    if (splitIds.has(c.clip_id)) continue;
    if (c.timeline_in_frame >= editPoint) {
      c.timeline_in_frame += delta;
    }
  }
}

/** Ripple a sync-lock track downstream by delta at editPoint */
function rippleTrackDownstream(track: Track, editPoint: number, delta: number, fps: number): void {
  // Split straddling clips
  const toSplit: number[] = [];
  for (let i = 0; i < track.clips.length; i++) {
    const c = track.clips[i];
    const end = c.timeline_in_frame + c.timeline_duration_frames;
    if (c.timeline_in_frame < editPoint && end > editPoint) {
      toSplit.push(i);
    }
  }

  for (let si = toSplit.length - 1; si >= 0; si--) {
    const idx = toSplit[si];
    const c = track.clips[idx];
    const framesBefore = editPoint - c.timeline_in_frame;
    const framesAfter = c.timeline_duration_frames - framesBefore;
    const srcSplitUs = c.src_in_us + framesToMicroseconds(framesBefore, fps);

    const afterClip: Clip = {
      ...structuredClone(c),
      clip_id: `${c.clip_id}_rsplit${idx}`,
      src_in_us: srcSplitUs,
      timeline_in_frame: editPoint + delta,
      timeline_duration_frames: framesAfter,
    };

    c.src_out_us = srcSplitUs;
    c.timeline_duration_frames = framesBefore;
    track.clips.splice(idx + 1, 0, afterClip);
  }

  // Shift downstream
  for (const c of track.clips) {
    if (c.timeline_in_frame >= editPoint && !c.clip_id.endsWith(`_rsplit${toSplit[0]}`)) {
      c.timeline_in_frame += delta;
    }
  }
}

/** Clear (trim/split/remove) clips in range [start, end) for overwrite */
function clearRange(track: Track, start: number, end: number, fps: number): void {
  const toRemove: number[] = [];
  const toAdd: Clip[] = [];

  for (let i = 0; i < track.clips.length; i++) {
    const c = track.clips[i];
    const clipEnd = c.timeline_in_frame + c.timeline_duration_frames;

    // Completely inside range: remove
    if (c.timeline_in_frame >= start && clipEnd <= end) {
      toRemove.push(i);
      continue;
    }

    // Straddles start: trim tail
    if (c.timeline_in_frame < start && clipEnd > start && clipEnd <= end) {
      const keepFrames = start - c.timeline_in_frame;
      c.src_out_us = c.src_in_us + framesToMicroseconds(keepFrames, fps);
      c.timeline_duration_frames = keepFrames;
      continue;
    }

    // Straddles end: trim head
    if (c.timeline_in_frame >= start && c.timeline_in_frame < end && clipEnd > end) {
      const trimFrames = end - c.timeline_in_frame;
      c.src_in_us += framesToMicroseconds(trimFrames, fps);
      c.timeline_in_frame = end;
      c.timeline_duration_frames -= trimFrames;
      continue;
    }

    // Spans entire range: split into before and after
    if (c.timeline_in_frame < start && clipEnd > end) {
      const beforeFrames = start - c.timeline_in_frame;
      const afterFrames = clipEnd - end;
      const splitUs1 = c.src_in_us + framesToMicroseconds(beforeFrames, fps);
      const splitUs2 = c.src_in_us + framesToMicroseconds(beforeFrames + (end - start), fps);

      toAdd.push({
        ...structuredClone(c),
        clip_id: `${c.clip_id}_owafter`,
        src_in_us: splitUs2,
        timeline_in_frame: end,
        timeline_duration_frames: afterFrames,
      });

      c.src_out_us = splitUs1;
      c.timeline_duration_frames = beforeFrames;
    }
  }

  // Remove fully covered clips (reverse order)
  for (let i = toRemove.length - 1; i >= 0; i--) {
    track.clips.splice(toRemove[i], 1);
  }

  // Add split-off clips
  for (const c of toAdd) {
    track.clips.push(c);
  }
}
