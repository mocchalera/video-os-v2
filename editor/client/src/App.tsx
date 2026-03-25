import { useEffect, useEffectEvent, useMemo, useState, type ReactNode } from 'react';
import AlternativesPanel from './components/AlternativesPanel';
import type { ClipOverlay, TrimSide } from './components/ClipBlock';
import CommandBar from './components/CommandBar';
import DiffPanel from './components/DiffPanel';
import PatchPanel from './components/PatchPanel';
import PreviewPlayer from './components/PreviewPlayer';
import PropertyPanel from './components/PropertyPanel';
import ReviewOverlay from './components/ReviewOverlay';
import Timeline from './components/Timeline';
import TransportBar from './components/TransportBar';
import { useAiJob } from './hooks/useAiJob';
import { useAlternatives, type AlternativeCandidate } from './hooks/useAlternatives';
import { useDiff } from './hooks/useDiff';
import { usePlayback } from './hooks/usePlayback';
import { useReview } from './hooks/useReview';
import { useSelection } from './hooks/useSelection';
import { useTimeline } from './hooks/useTimeline';
import type { AudioPolicy, Clip, EditorLane, PatchOperation, ReviewWarning, ReviewWeakness, SelectionState, TimelineIR } from './types';
import {
  clamp,
  durationFramesFromSource,
  formatClockFromFrames,
  framesToMicroseconds,
  getFps,
  microsecondsToFrames,
} from './utils/time';

const MAX_ZOOM = 24;
const MIN_ZOOM = 1.25;
const FALLBACK_ZOOM = 6;

function buildLanes(timeline: TimelineIR | null): EditorLane[] {
  if (!timeline) {
    return [
      { laneId: 'V1', label: 'V1', trackKind: 'video', trackId: null, clips: [] },
      { laneId: 'A1', label: 'A1', trackKind: 'audio', trackId: null, clips: [] },
      { laneId: 'A2', label: 'A2', trackKind: 'audio', trackId: null, clips: [] },
    ];
  }

  const lanes: EditorLane[] = [];

  for (const track of timeline.tracks.video) {
    lanes.push({
      laneId: track.track_id,
      label: track.track_id,
      trackKind: 'video',
      trackId: track.track_id,
      clips: track.clips,
    });
  }

  for (const track of timeline.tracks.audio) {
    if (track.clips.length > 0) {
      lanes.push({
        laneId: track.track_id,
        label: track.track_id,
        trackKind: 'audio',
        trackId: track.track_id,
        clips: track.clips,
      });
    }
  }

  if (lanes.length === 0) {
    return [
      { laneId: 'V1', label: 'V1', trackKind: 'video', trackId: null, clips: [] },
      { laneId: 'A1', label: 'A1', trackKind: 'audio', trackId: null, clips: [] },
    ];
  }

  return lanes;
}

function computeAutoFitZoom(totalFrames: number): number {
  const availableWidth = Math.max(560, window.innerWidth - 160);
  const fitted = availableWidth / Math.max(1, totalFrames);
  return clamp(fitted, MIN_ZOOM, MAX_ZOOM);
}

function findSelectedClip(
  timeline: TimelineIR | null,
  selection: SelectionState | null,
): Clip | null {
  if (!timeline || !selection) {
    return null;
  }

  const track = timeline.tracks[selection.trackKind].find(
    (candidate) => candidate.track_id === selection.trackId,
  );
  return track?.clips.find((candidate) => candidate.clip_id === selection.clipId) ?? null;
}

function getTotalFrames(timeline: TimelineIR | null): number {
  if (!timeline) {
    return 24 * 12;
  }

  const clipEnds = [...timeline.tracks.video, ...timeline.tracks.audio]
    .flatMap((track) => track.clips)
    .map((clip) => clip.timeline_in_frame + clip.timeline_duration_frames);
  const markerFrames = (timeline.markers ?? []).map((marker) => marker.frame);
  return Math.max(...clipEnds, ...markerFrames, 1);
}

function PanelBadge({ children }: { children: ReactNode }) {
  return (
    <span className="px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.22em] text-[color:var(--text-subtle)]">
      {children}
    </span>
  );
}

export default function App() {
  const timelineState = useTimeline();
  const selectionState = useSelection();
  const [zoom, setZoom] = useState(FALLBACK_ZOOM);
  const timeline = timelineState.timeline;
  const fps = timeline ? getFps(timeline.sequence) : 24;
  const lanes = buildLanes(timeline);
  const totalFrames = getTotalFrames(timeline);
  const selectedClip = findSelectedClip(timeline, selectionState.selection);
  const playback = usePlayback({
    projectId: timelineState.projectId,
    fps,
    durationFrames: totalFrames,
    timeline,
  });
  const reviewState = useReview(timelineState.projectId);
  const selectedClipId = selectionState.selection?.clipId ?? null;
  const alternativesState = useAlternatives(timelineState.projectId, selectedClipId);
  const clipDiffs = useDiff(
    timelineState.sessionBaseline,
    timelineState.timeline,
    timelineState.historyOrigins,
    timelineState.historySnapshots,
  );
  const aiJob = useAiJob(timelineState.projectId, {
    onCompileComplete: () => {
      // Compile: timeline + review + baseline reset (reload resets baseline)
      void timelineState.reload();
      reviewState.reload();
    },
    onReviewComplete: () => {
      // Review: timeline + review + context
      void timelineState.reload();
      reviewState.reload();
    },
    onRenderComplete: () => {
      // Render: timeline + review (source playback is live — no preview needed)
      void timelineState.reload();
      reviewState.reload();
    },
  });

  const [bottomTab, setBottomTab] = useState<'timeline' | 'patches' | 'alternatives' | 'diff'>('timeline');

  // Build clip overlay map from review weaknesses + patch operations
  const clipOverlays = useMemo(() => {
    const map = new Map<string, ClipOverlay>();

    function ensure(clipId: string): ClipOverlay {
      let entry = map.get(clipId);
      if (!entry) {
        entry = { weaknesses: [], warnings: [], patchOps: [] };
        map.set(clipId, entry);
      }
      return entry;
    }

    // Collect weaknesses per clip
    const weaknesses = reviewState.report?.data?.weaknesses ?? [];
    for (const w of weaknesses) {
      if (w.clip_id) {
        ensure(w.clip_id).weaknesses.push(w);
      }
    }

    // Collect warnings per clip (修正R2-4)
    const warnings = reviewState.report?.data?.warnings ?? [];
    for (const w of warnings) {
      if (w.clip_id) {
        ensure(w.clip_id).warnings.push(w);
      }
    }

    // Collect patch operations per target clip — use safety-filtered ops only (修正R2-2)
    const patchOps = reviewState.patch?.safety?.filtered_patch?.operations
      ?? reviewState.patch?.data?.operations
      ?? [];
    for (const op of patchOps) {
      if (op.target_clip_id) {
        ensure(op.target_clip_id).patchOps.push(op);
      }
    }

    return map;
  }, [reviewState.report, reviewState.patch]);

  useEffect(() => {
    selectionState.clearSelection();
  }, [timelineState.projectId]);

  useEffect(() => {
    if (!timeline) {
      return;
    }

    setZoom(computeAutoFitZoom(getTotalFrames(timeline)));
  }, [timelineState.projectId, timeline?.project_id]);

  useEffect(() => {
    if (timelineState.dirty) {
      playback.markPreviewStale();
    }
  }, [timelineState.dirty]);

  useEffect(() => {
    if (selectionState.selection && !selectedClip) {
      selectionState.clearSelection();
    }
  }, [selectedClip, selectionState.selection]);

  async function handleApplyPatch(operationIndexes: number[]): Promise<void> {
    if (!timelineState.timelineRevision || aiJob.isRunning) return;

    const result = await reviewState.applyPatch({
      base_timeline_revision: timelineState.timelineRevision,
      operation_indexes: operationIndexes,
    });

    if (result?.ok) {
      timelineState.commitRemoteMutation(result.timeline, result.timeline_revision_after);
      reviewState.reload();
    }
  }

  function handleSwapClip(candidate: AlternativeCandidate): void {
    const sel = selectionState.selection;
    if (!sel || aiJob.isRunning) return;
    timelineState.swapClip(sel.trackKind, sel.trackId, sel.clipId, {
      segment_id: candidate.segment_id,
      asset_id: candidate.asset_id,
      src_in_us: candidate.src_in_us,
      src_out_us: candidate.src_out_us,
      confidence: candidate.confidence,
      quality_flags: candidate.quality_flags,
      candidate_ref: candidate.segment_id,
      why_it_matches: candidate.why_it_matches,
    });
  }

  async function handleExportRender(): Promise<void> {
    if (!timeline || aiJob.isRunning) {
      return;
    }

    let nextRevision = timelineState.timelineRevision;
    if (timelineState.dirty || timelineState.status === 'saving') {
      const saveResult = await timelineState.save();
      if (!saveResult.ok) {
        return;
      }
      nextRevision = saveResult.timelineRevision ?? nextRevision;
    }

    await playback.requestFullPreview({
      timelineRevision: nextRevision,
    });
  }

  function handleTrimClip(
    trackKind: 'video' | 'audio',
    trackId: string,
    baseClip: Clip,
    side: TrimSide,
    deltaFrames: number,
  ): void {
    if (!timeline || aiJob.isRunning) {
      return;
    }

    // Find neighboring clips for overlap prevention
    const track = timeline.tracks[trackKind].find(
      (t) => t.track_id === trackId,
    );
    const sortedClips = track
      ? [...track.clips].sort((a, b) => a.timeline_in_frame - b.timeline_in_frame)
      : [];
    const clipIndex = sortedClips.findIndex(
      (c) => c.clip_id === baseClip.clip_id,
    );
    const prevClip = clipIndex > 0 ? sortedClips[clipIndex - 1] : null;
    const nextClip =
      clipIndex >= 0 && clipIndex < sortedClips.length - 1
        ? sortedClips[clipIndex + 1]
        : null;

    timelineState.updateClipSilent(trackKind, trackId, baseClip.clip_id, (clip) => {
      if (side === 'start') {
        let minDelta = Math.max(
          -microsecondsToFrames(baseClip.src_in_us, fps),
          -baseClip.timeline_in_frame,
        );
        // Prevent overlap with previous clip
        if (prevClip) {
          const prevEnd =
            prevClip.timeline_in_frame + prevClip.timeline_duration_frames;
          minDelta = Math.max(minDelta, prevEnd - baseClip.timeline_in_frame);
        }
        const maxDelta = baseClip.timeline_duration_frames - 1;
        const clampedDelta = clamp(deltaFrames, minDelta, maxDelta);
        const nextSrcInUs = Math.max(
          0,
          baseClip.src_in_us + framesToMicroseconds(clampedDelta, fps),
        );

        clip.src_in_us = nextSrcInUs;
        clip.timeline_in_frame = Math.max(0, baseClip.timeline_in_frame + clampedDelta);
        clip.timeline_duration_frames = durationFramesFromSource(
          nextSrcInUs,
          baseClip.src_out_us,
          fps,
        );
        return;
      }

      const minimumSrcOut = baseClip.src_in_us + framesToMicroseconds(1, fps);
      let nextSrcOutUs = Math.max(
        minimumSrcOut,
        baseClip.src_out_us + framesToMicroseconds(deltaFrames, fps),
      );
      // Prevent overlap with next clip
      if (nextClip) {
        const maxDurationFrames =
          nextClip.timeline_in_frame - baseClip.timeline_in_frame;
        const maxSrcOutUs =
          baseClip.src_in_us + framesToMicroseconds(maxDurationFrames, fps);
        nextSrcOutUs = Math.min(
          nextSrcOutUs,
          Math.max(minimumSrcOut, maxSrcOutUs),
        );
      }

      clip.src_out_us = nextSrcOutUs;
      clip.timeline_duration_frames = durationFramesFromSource(
        baseClip.src_in_us,
        nextSrcOutUs,
        fps,
      );
    });
  }

  function handleUpdateAudioNumber(field: keyof AudioPolicy, value: number): void {
    const selection = selectionState.selection;
    if (!selection || aiJob.isRunning) {
      return;
    }

    timelineState.updateClip(selection.trackKind, selection.trackId, selection.clipId, (clip) => {
      clip.audio_policy = {
        ...clip.audio_policy,
        [field]: Number.isFinite(value) ? value : 0,
      };
    });
  }

  function handleUpdateAudioBoolean(field: keyof AudioPolicy, value: boolean): void {
    const selection = selectionState.selection;
    if (!selection || aiJob.isRunning) {
      return;
    }

    timelineState.updateClip(selection.trackKind, selection.trackId, selection.clipId, (clip) => {
      clip.audio_policy = {
        ...clip.audio_policy,
        [field]: value,
      };
    });
  }

  const handleKeyboard = useEffectEvent(async (event: KeyboardEvent) => {
    const target = event.target as HTMLElement | null;
    const isTextInput = Boolean(
      target?.closest('input, textarea, select, [contenteditable="true"]'),
    );

    if (event.key === ' ' && !isTextInput) {
      event.preventDefault();
      await playback.togglePlayback();
      return;
    }

    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
      event.preventDefault();
      if (!aiJob.isRunning) {
        await timelineState.save();
      }
      return;
    }

    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
      event.preventDefault();
      await handleExportRender();
      return;
    }

    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') {
      event.preventDefault();
      if (aiJob.isRunning) return;
      if (event.shiftKey) {
        timelineState.redo();
        return;
      }

      timelineState.undo();
      return;
    }

    if (event.ctrlKey && !event.metaKey && event.key.toLowerCase() === 'y') {
      event.preventDefault();
      if (aiJob.isRunning) return;
      timelineState.redo();
      return;
    }

    if (event.key === 'Escape') {
      selectionState.clearSelection();
    }
  });

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      void handleKeyboard(event);
    }

    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, []);

  const totalTrackCount = timeline
    ? timeline.tracks.video.length + timeline.tracks.audio.length
    : 0;
  const hiddenTrackCount = Math.max(0, totalTrackCount - lanes.length);
  const transportTimecode = formatClockFromFrames(playback.playheadFrame, fps);
  const durationTimecode = formatClockFromFrames(totalFrames, fps);
  const zoomLabel = zoom >= 2 ? `${zoom.toFixed(1)} px/f` : `${zoom.toFixed(2)} px/f`;
  const resolutionLabel = `${timeline?.sequence.width ?? 1920}x${timeline?.sequence.height ?? 1080}`;
  const fpsLabel = `${fps.toFixed(2).replace('.00', '')} fps`;
  const issueCount = timelineState.validationIssues.length;

  return (
    <div className="flex h-screen min-h-screen flex-col overflow-hidden bg-[color:var(--editor-bg)] text-[color:var(--text-main)]">
      <header className="shrink-0 border-b border-white/[0.06] px-4 py-2.5">
        <div className="flex items-center justify-between gap-4">
          <div className="flex min-w-0 items-center gap-3">
            <div className="min-w-0">
              <div className="font-mono text-[10px] uppercase tracking-[0.28em] text-[color:var(--text-subtle)]">
                Video OS v2
              </div>
              <div className="truncate text-[28px] font-semibold leading-none text-white">
                Timeline Editor
              </div>
            </div>

            <div className="h-10 w-px bg-white/[0.08]" />

            <div className="flex items-center gap-2">
              <select
                className="min-w-[240px] border border-white/[0.06] bg-transparent px-3 py-1.5 text-[13px] font-medium text-neutral-100 outline-none transition focus:border-[var(--accent)]"
                value={timelineState.projectId}
                onChange={(event) => timelineState.setProjectId(event.target.value)}
              >
                {timelineState.projects.map((project) => (
                  <option key={project.id} value={project.id} className="bg-[#11161d]">
                    {project.name}
                  </option>
                ))}
              </select>

              <PanelBadge>
                {timelineState.connectionMode === 'api' ? 'Live API' : 'Mock Cache'}
              </PanelBadge>
            </div>
          </div>

          <div className="flex shrink-0 items-center gap-4">
            <div className="hidden text-right md:block">
              <div className="font-mono text-[11px] uppercase tracking-[0.22em] text-[color:var(--text-subtle)]">
                Program TC
              </div>
              <div className="font-mono text-[24px] font-semibold tabular-nums tracking-[0.08em] text-white">
                {transportTimecode}
              </div>
            </div>

            <div className="h-8 w-px bg-white/[0.08]" />

            <CommandBar
              jobStatus={aiJob.status}
              jobPhase={aiJob.phase}
              progress={aiJob.progress}
              jobError={aiJob.error}
              dirty={timelineState.dirty}
              hasTimeline={!!timelineState.timeline}
              timelineRevision={timelineState.timelineRevision}
              onCompile={() => {
                void aiJob.startJob('compile', timelineState.timelineRevision);
              }}
              onReview={() => {
                void aiJob.startJob('review', timelineState.timelineRevision);
              }}
              onRender={() => {
                void aiJob.startJob('render', timelineState.timelineRevision);
              }}
              onSave={() => {
                void timelineState.save();
              }}
              onDismissError={() => aiJob.reset()}
            />

            <div className="h-8 w-px bg-white/[0.08]" />

            <div className="flex items-center gap-2">
              <button
                type="button"
                className="border border-white/[0.06] bg-transparent px-3 py-1.5 text-[13px] font-medium text-neutral-200 transition hover:bg-white/[0.06] disabled:opacity-35"
                disabled={!timelineState.canUndo || aiJob.isRunning}
                onClick={() => timelineState.undo()}
              >
                Undo
              </button>
              <button
                type="button"
                className="border border-white/[0.06] bg-transparent px-3 py-1.5 text-[13px] font-medium text-neutral-200 transition hover:bg-white/[0.06] disabled:opacity-35"
                disabled={!timelineState.canRedo || aiJob.isRunning}
                onClick={() => timelineState.redo()}
              >
                Redo
              </button>
              <button
                type="button"
                className="bg-[color:var(--accent-strong)] px-3 py-1.5 text-[13px] font-semibold text-white transition hover:bg-[#4f95ff] disabled:opacity-35"
                disabled={!timelineState.timeline || aiJob.isRunning}
                onClick={() => {
                  void timelineState.save();
                }}
              >
                Save
              </button>
            </div>
          </div>
        </div>
      </header>

      <main className="min-h-0 flex-1 overflow-hidden">
        <div
          className="grid h-full min-h-0 overflow-hidden"
          style={{
            gridTemplateColumns: 'minmax(0, 1fr) 320px',
            gridTemplateRows: 'minmax(0, 2fr) minmax(0, 3fr)',
          }}
        >
          <section className="flex min-h-0 flex-col overflow-hidden border-r border-white/[0.06]">
            <PreviewPlayer
              videoRef={playback.videoRef}
              previewMode={playback.previewMode}
              renderStatus={playback.renderStatus}
              isPlaying={playback.isPlaying}
              isBuffering={playback.isBuffering}
              isGap={playback.isGap}
              error={playback.error}
              onLoadedMetadata={playback.handleVideoLoadedMetadata}
              onTimeUpdate={playback.handleVideoTimeUpdate}
              onWaiting={playback.handleVideoWaiting}
              onPlaying={playback.handleVideoPlaying}
              onStalled={playback.handleVideoStalled}
              onEnded={playback.handleVideoEnded}
              onVideoError={playback.handleVideoError}
            />
            <TransportBar
              isPlaying={playback.isPlaying}
              timecode={transportTimecode}
              currentFrame={playback.playheadFrame}
              previewMode={playback.previewMode}
              renderStatus={playback.renderStatus}
              previewStale={playback.previewStale}
              onTogglePlayback={() => {
                void playback.togglePlayback();
              }}
              onExportRender={() => {
                void handleExportRender();
              }}
            />
          </section>

          <section className="min-h-0 overflow-hidden">
            <PropertyPanel
              clip={selectedClip}
              fps={fps}
              reviewReport={reviewState.report}
              blueprint={reviewState.blueprint}
              onUpdateAudioNumber={handleUpdateAudioNumber}
              onUpdateAudioBoolean={handleUpdateAudioBoolean}
            />
          </section>

          <section className="col-span-2 flex min-h-0 flex-col overflow-hidden border-t border-white/[0.06]">
            <div className="flex shrink-0 items-center gap-3 border-b border-white/[0.06] px-3 py-1.5">
              <div className="flex items-center gap-1">
                {(
                  [
                    { key: 'timeline' as const, label: 'Assembly Dock', badge: undefined as number | undefined },
                    { key: 'patches' as const, label: 'Patches', badge: reviewState.patch?.data?.operations?.length },
                    { key: 'alternatives' as const, label: 'Alternatives', badge: alternativesState.alternatives.length || undefined },
                    { key: 'diff' as const, label: 'Diff', badge: clipDiffs.length || undefined },
                  ]
                ).map(({ key, label, badge }, i) => (
                  <span key={key} className="flex items-center">
                    {i > 0 ? <span className="text-[color:var(--text-subtle)]">/</span> : null}
                    <button
                      type="button"
                      className={`px-2 py-0.5 text-[13px] font-semibold transition ${
                        bottomTab === key
                          ? 'text-white'
                          : 'text-[color:var(--text-subtle)] hover:text-neutral-300'
                      }`}
                      onClick={() => setBottomTab(key)}
                    >
                      {label}
                      {badge ? (
                        <span className="ml-1.5 rounded-sm bg-[var(--accent)]/20 px-1 py-px font-mono text-[9px] text-[var(--accent)]">
                          {badge}
                        </span>
                      ) : null}
                    </button>
                  </span>
                ))}
              </div>

              <span className="font-mono text-[10px] text-[color:var(--text-subtle)]">
                {lanes.length}T{hiddenTrackCount > 0 ? ` +${hiddenTrackCount}h` : ''} · {timeline?.markers?.length ?? 0}M
              </span>

              <div className="flex-1" />

              <label className="flex items-center gap-2">
                <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-[color:var(--text-subtle)]">
                  Zoom
                </span>
                <input
                  className="range-input w-24"
                  type="range"
                  min={MIN_ZOOM}
                  max={MAX_ZOOM}
                  step={0.25}
                  value={zoom}
                  onChange={(event) => setZoom(Number(event.target.value))}
                />
                <span className="font-mono text-[10px] tabular-nums text-neutral-300">
                  {zoomLabel}
                </span>
              </label>
            </div>

            {bottomTab === 'timeline' ? (
              <div className="min-h-0 flex-1 flex flex-col">
                <ReviewOverlay
                  reviewReport={reviewState.report}
                  pxPerFrame={zoom}
                  totalFrames={totalFrames}
                  viewportWidth={800}
                />
                <div className="min-h-0 flex-1">
                  <Timeline
                    lanes={lanes}
                    markers={timeline?.markers ?? []}
                    fps={fps}
                    totalFrames={totalFrames}
                    zoom={zoom}
                    playheadFrame={playback.playheadFrame}
                    selectedClipId={selectionState.selection?.clipId ?? null}
                    clipOverlays={clipOverlays}
                    onZoomChange={setZoom}
                    onSeek={playback.seekToFrame}
                    onClearSelection={selectionState.clearSelection}
                    onSelectClip={(trackKind, trackId, clip) =>
                      selectionState.selectClip({
                        trackKind,
                        trackId,
                        clipId: clip.clip_id,
                      })
                    }
                    onTrimClip={handleTrimClip}
                    onTrimStart={() => timelineState.beginDrag()}
                    onTrimEnd={() => timelineState.endDrag()}
                  />
                </div>
              </div>
            ) : bottomTab === 'patches' ? (
              <PatchPanel
                patchData={reviewState.patch}
                dirty={timelineState.dirty}
                timelineRevision={timelineState.timelineRevision}
                onApply={handleApplyPatch}
              />
            ) : bottomTab === 'alternatives' ? (
              <AlternativesPanel
                clipId={selectedClipId}
                alternatives={alternativesState.alternatives}
                loading={alternativesState.loading}
                onSwap={handleSwapClip}
              />
            ) : (
              <DiffPanel
                diffs={clipDiffs}
                baselineRevision={timelineState.sessionBaseline?.baselineRevision ?? null}
              />
            )}
          </section>
        </div>
      </main>

      <footer className="flex h-8 shrink-0 items-center justify-between border-t border-white/[0.06] px-4 font-mono text-[11px] text-[color:var(--text-muted)]">
        <div className="flex items-center gap-4">
          <span className="uppercase tracking-[0.22em] text-[color:var(--text-subtle)]">
            {aiJob.isRunning ? `AI ${aiJob.phase ?? ''}` : timelineState.status}
          </span>
          <span>{resolutionLabel}</span>
          <span>{fpsLabel}</span>
          <span>{durationTimecode}</span>
          <span>{lanes.length} tracks</span>
          {issueCount > 0 ? (
            <span
              className="cursor-help text-[color:var(--warning)]"
              title={timelineState.validationIssues
                .map((i) => `${i.path}: ${i.message}`)
                .join('\n')}
            >
              {issueCount} validation issue{issueCount !== 1 ? 's' : ''}
            </span>
          ) : null}
          {aiJob.isRunning ? (
            <span className="text-[var(--accent)]">
              AI job running — editing disabled
            </span>
          ) : null}
        </div>

        <div className="flex items-center gap-4">
          {timelineState.lastSavedAt ? <span>Saved {timelineState.lastSavedAt}</span> : null}
          <span className={timelineState.dirty ? 'text-[color:var(--warning)]' : 'text-[color:var(--success)]'}>
            {timelineState.dirty ? 'Unsaved' : 'Synced'}
          </span>
        </div>
      </footer>

      {timelineState.error || playback.error ? (
        <div className="shrink-0 border-t border-red-400/20 px-4 py-2 text-[12px] text-[color:var(--danger)]">
          {timelineState.error ?? playback.error}
        </div>
      ) : null}
    </div>
  );
}
