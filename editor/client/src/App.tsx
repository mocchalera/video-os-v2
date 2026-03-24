import { useEffect, useEffectEvent, useMemo, useState, type ReactNode } from 'react';
import type { ClipOverlay, TrimSide } from './components/ClipBlock';
import PatchPanel from './components/PatchPanel';
import PreviewPlayer from './components/PreviewPlayer';
import PropertyPanel from './components/PropertyPanel';
import ReviewOverlay from './components/ReviewOverlay';
import Timeline from './components/Timeline';
import TransportBar from './components/TransportBar';
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
  secondsToFrames,
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
  });
  const reviewState = useReview(timelineState.projectId);
  const [bottomTab, setBottomTab] = useState<'timeline' | 'patches'>('timeline');

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
    if (selectionState.selection && !selectedClip) {
      selectionState.clearSelection();
    }
  }, [selectedClip, selectionState.selection]);

  async function handleApplyPatch(operationIndexes: number[]): Promise<void> {
    if (!timelineState.timelineRevision) return;

    const result = await reviewState.applyPatch({
      base_timeline_revision: timelineState.timelineRevision,
      operation_indexes: operationIndexes,
    });

    if (result?.ok) {
      timelineState.commitRemoteMutation(result.timeline, result.timeline_revision_after);
      reviewState.reload();
    }
  }

  async function handleRenderPreview(): Promise<void> {
    if (!timeline) {
      return;
    }

    const request = selectedClip
      ? {
          mode: 'clip' as const,
          clipId: selectedClip.clip_id,
          resolution: '720p' as const,
        }
      : {
          mode: 'range' as const,
          startFrame: playback.playheadFrame,
          endFrame: Math.min(
            totalFrames,
            playback.playheadFrame + secondsToFrames(5, fps),
          ),
          resolution: '720p' as const,
        };

    await playback.requestPreview(request);
  }

  function handleTrimClip(
    trackKind: 'video' | 'audio',
    trackId: string,
    baseClip: Clip,
    side: TrimSide,
    deltaFrames: number,
  ): void {
    if (!timeline) {
      return;
    }

    timelineState.updateClip(trackKind, trackId, baseClip.clip_id, (clip) => {
      if (side === 'start') {
        const minDelta = Math.max(
          -microsecondsToFrames(baseClip.src_in_us, fps),
          -baseClip.timeline_in_frame,
        );
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
      const nextSrcOutUs = Math.max(
        minimumSrcOut,
        baseClip.src_out_us + framesToMicroseconds(deltaFrames, fps),
      );

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
    if (!selection) {
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
    if (!selection) {
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
      await timelineState.save();
      return;
    }

    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
      event.preventDefault();
      await handleRenderPreview();
      return;
    }

    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') {
      event.preventDefault();
      if (event.shiftKey) {
        timelineState.redo();
        return;
      }

      timelineState.undo();
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

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
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

            <div className="flex items-center gap-2">
              <button
                type="button"
                className="border border-white/[0.06] bg-transparent px-3 py-1.5 text-[13px] font-medium text-neutral-200 transition hover:bg-white/[0.06] disabled:opacity-35"
                disabled={!timelineState.canUndo}
                onClick={() => timelineState.undo()}
              >
                Undo
              </button>
              <button
                type="button"
                className="border border-white/[0.06] bg-transparent px-3 py-1.5 text-[13px] font-medium text-neutral-200 transition hover:bg-white/[0.06] disabled:opacity-35"
                disabled={!timelineState.canRedo}
                onClick={() => timelineState.redo()}
              >
                Redo
              </button>
              <button
                type="button"
                className="bg-[color:var(--accent-strong)] px-3 py-1.5 text-[13px] font-semibold text-white transition hover:bg-[#4f95ff] disabled:opacity-35"
                disabled={!timelineState.timeline}
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
              previewUrl={playback.previewUrl}
              previewMode={playback.previewMode}
              renderStatus={playback.renderStatus}
              isPlaying={playback.isPlaying}
              error={playback.error}
              onTimeUpdate={playback.handleVideoTimeUpdate}
              onLoadedMetadata={playback.handleVideoLoadedMetadata}
              onEnded={playback.handleVideoEnded}
            />
            <TransportBar
              isPlaying={playback.isPlaying}
              timecode={transportTimecode}
              currentFrame={playback.playheadFrame}
              previewMode={playback.previewMode}
              renderStatus={playback.renderStatus}
              onTogglePlayback={() => {
                void playback.togglePlayback();
              }}
              onRenderPreview={() => {
                void handleRenderPreview();
              }}
            />
          </section>

          <section className="min-h-0 overflow-hidden">
            <PropertyPanel
              clip={selectedClip}
              fps={fps}
              reviewReport={reviewState.report}
              onUpdateAudioNumber={handleUpdateAudioNumber}
              onUpdateAudioBoolean={handleUpdateAudioBoolean}
            />
          </section>

          <section className="col-span-2 flex min-h-0 flex-col overflow-hidden border-t border-white/[0.06]">
            <div className="flex shrink-0 items-center gap-3 border-b border-white/[0.06] px-3 py-1.5">
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  className={`px-2 py-0.5 text-[13px] font-semibold transition ${
                    bottomTab === 'timeline'
                      ? 'text-white'
                      : 'text-[color:var(--text-subtle)] hover:text-neutral-300'
                  }`}
                  onClick={() => setBottomTab('timeline')}
                >
                  Assembly Dock
                </button>
                <span className="text-[color:var(--text-subtle)]">/</span>
                <button
                  type="button"
                  className={`px-2 py-0.5 text-[13px] font-semibold transition ${
                    bottomTab === 'patches'
                      ? 'text-white'
                      : 'text-[color:var(--text-subtle)] hover:text-neutral-300'
                  }`}
                  onClick={() => setBottomTab('patches')}
                >
                  Patches
                  {reviewState.patch?.data?.operations?.length ? (
                    <span className="ml-1.5 rounded-sm bg-[var(--accent)]/20 px-1 py-px font-mono text-[9px] text-[var(--accent)]">
                      {reviewState.patch.data.operations.length}
                    </span>
                  ) : null}
                </button>
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
                  />
                </div>
              </div>
            ) : (
              <PatchPanel
                patchData={reviewState.patch}
                dirty={timelineState.dirty}
                timelineRevision={timelineState.timelineRevision}
                onApply={handleApplyPatch}
              />
            )}
          </section>
        </div>
      </main>

      <footer className="flex h-8 shrink-0 items-center justify-between border-t border-white/[0.06] px-4 font-mono text-[11px] text-[color:var(--text-muted)]">
        <div className="flex items-center gap-4">
          <span className="uppercase tracking-[0.22em] text-[color:var(--text-subtle)]">
            {timelineState.status}
          </span>
          <span>{resolutionLabel}</span>
          <span>{fpsLabel}</span>
          <span>{durationTimecode}</span>
          <span>{lanes.length} tracks</span>
          {issueCount > 0 ? (
            <span className="text-[color:var(--warning)]">{issueCount} validation issues</span>
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
