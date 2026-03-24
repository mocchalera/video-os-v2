import { useEffect, useEffectEvent, useState } from 'react';
import PreviewPlayer from './components/PreviewPlayer';
import PropertyPanel from './components/PropertyPanel';
import Timeline from './components/Timeline';
import TransportBar from './components/TransportBar';
import { usePlayback } from './hooks/usePlayback';
import { useSelection } from './hooks/useSelection';
import { useTimeline } from './hooks/useTimeline';
import type { AudioPolicy, Clip, EditorLane, SelectionState, TimelineIR } from './types';
import {
  clamp,
  durationFramesFromSource,
  formatClockFromFrames,
  framesToMicroseconds,
  getFps,
  microsecondsToFrames,
  secondsToFrames,
} from './utils/time';
import type { TrimSide } from './components/ClipBlock';

const DEFAULT_ZOOM = 6;

function buildLanes(timeline: TimelineIR | null): EditorLane[] {
  if (!timeline) {
    return [
      { laneId: 'V1', label: 'V1', trackKind: 'video', trackId: null, clips: [] },
      { laneId: 'A1', label: 'A1', trackKind: 'audio', trackId: null, clips: [] },
      { laneId: 'A2', label: 'A2', trackKind: 'audio', trackId: null, clips: [] },
    ];
  }

  const videoTrack =
    timeline.tracks.video.find((track) => track.track_id === 'V1') ??
    timeline.tracks.video[0] ??
    null;
  const primaryAudio =
    timeline.tracks.audio.find((track) => track.track_id === 'A1') ??
    timeline.tracks.audio[0] ??
    null;
  const secondaryAudio =
    timeline.tracks.audio.find((track) => track.track_id.startsWith('A2')) ??
    timeline.tracks.audio[1] ??
    null;

  return [
    {
      laneId: 'V1',
      label: 'V1',
      trackKind: 'video',
      trackId: videoTrack?.track_id ?? null,
      clips: videoTrack?.clips ?? [],
    },
    {
      laneId: 'A1',
      label: 'A1',
      trackKind: 'audio',
      trackId: primaryAudio?.track_id ?? null,
      clips: primaryAudio?.clips ?? [],
    },
    {
      laneId: 'A2',
      label: 'A2',
      trackKind: 'audio',
      trackId: secondaryAudio?.track_id ?? null,
      clips: secondaryAudio?.clips ?? [],
    },
  ];
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

export default function App() {
  const timelineState = useTimeline();
  const selectionState = useSelection();
  const [zoom, setZoom] = useState(DEFAULT_ZOOM);
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

  useEffect(() => {
    selectionState.clearSelection();
    setZoom(DEFAULT_ZOOM);
  }, [timelineState.projectId]);

  useEffect(() => {
    if (selectionState.selection && !selectedClip) {
      selectionState.clearSelection();
    }
  }, [selectedClip, selectionState.selection]);

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

  const hiddenTrackCount = timeline
    ? Math.max(0, timeline.tracks.video.length - 1) +
      Math.max(0, timeline.tracks.audio.length - 2)
    : 0;
  const transportTimecode = formatClockFromFrames(playback.playheadFrame, fps);
  const durationTimecode = formatClockFromFrames(totalFrames, fps);
  const zoomPercent = Math.round((zoom / DEFAULT_ZOOM) * 100);
  const primaryStatus =
    timelineState.error ??
    playback.error ??
    (timelineState.connectionMode === 'mock'
      ? 'API unavailable. Timeline saves fall back to local mock storage.'
      : 'Ready');

  return (
    <div className="min-h-screen p-4 text-[color:var(--text-main)]">
      <div className="mx-auto flex min-h-[calc(100vh-2rem)] max-w-[1600px] flex-col gap-4">
        <header className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-white/10 bg-[color:var(--panel-bg)] px-4 py-3 shadow-[0_16px_60px_rgba(0,0,0,0.22)]">
          <div className="flex flex-wrap items-center gap-3">
            <div>
              <div className="font-mono text-[11px] uppercase tracking-[0.22em] text-slate-500">
                Video OS v2
              </div>
              <div className="text-lg font-semibold text-slate-50">Timeline Editor MVP</div>
            </div>

            <label className="flex items-center gap-2 rounded-xl border border-white/10 bg-slate-950/40 px-3 py-2 text-sm">
              <span className="text-slate-400">Project</span>
              <select
                className="bg-transparent font-mono text-slate-100 outline-none"
                value={timelineState.projectId}
                onChange={(event) => timelineState.setProjectId(event.target.value)}
              >
                {timelineState.projects.map((project) => (
                  <option key={project.id} value={project.id} className="bg-slate-950">
                    {project.name}
                  </option>
                ))}
              </select>
            </label>

            <div className="rounded-xl border border-white/10 bg-slate-950/40 px-3 py-2 font-mono text-xs uppercase tracking-[0.18em] text-slate-400">
              {timelineState.connectionMode}
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              className="rounded-xl border border-white/10 bg-white/5 px-4 py-2 text-sm font-medium text-slate-100 transition hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-40"
              disabled={!timelineState.timeline}
              onClick={() => {
                void timelineState.save();
              }}
            >
              Save
            </button>

            <button
              type="button"
              className="rounded-xl border border-white/10 bg-white/5 px-4 py-2 text-sm font-medium text-slate-100 transition hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-40"
              disabled={!timelineState.canUndo}
              onClick={() => timelineState.undo()}
            >
              Undo
            </button>

            <div className="rounded-xl border border-white/10 bg-slate-950/40 px-3 py-2 font-mono text-xs uppercase tracking-[0.18em] text-slate-400">
              Zoom {zoomPercent}%
            </div>
          </div>
        </header>

        <main className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_320px] gap-4">
          <div className="grid min-h-0 grid-rows-[minmax(320px,42vh)_minmax(300px,1fr)] gap-4">
            <div className="min-h-0">
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
            </div>

            <div className="min-h-0">
              <Timeline
                lanes={lanes}
                markers={timeline?.markers ?? []}
                fps={fps}
                totalFrames={totalFrames}
                zoom={zoom}
                playheadFrame={playback.playheadFrame}
                selectedClipId={selectionState.selection?.clipId ?? null}
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

          <PropertyPanel
            clip={selectedClip}
            fps={fps}
            onUpdateAudioNumber={handleUpdateAudioNumber}
            onUpdateAudioBoolean={handleUpdateAudioBoolean}
          />
        </main>

        <footer className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-white/10 bg-[rgba(8,12,24,0.8)] px-4 py-3 text-sm text-slate-400">
          <div className="flex flex-wrap items-center gap-4">
            <span>Status: {timelineState.status}</span>
            <span>Duration: {durationTimecode}</span>
            <span>
              {timeline?.sequence.width ?? 1920}×{timeline?.sequence.height ?? 1080}
            </span>
            <span>{fps.toFixed(2).replace('.00', '')}fps</span>
            <span>Visible tracks: {lanes.length}</span>
            {hiddenTrackCount > 0 ? <span>Hidden tracks: {hiddenTrackCount}</span> : null}
          </div>

          <div className="flex flex-wrap items-center gap-4">
            {timelineState.lastSavedAt ? (
              <span className="font-mono text-xs text-slate-500">
                Last save {timelineState.lastSavedAt}
              </span>
            ) : null}
            <span
              className={
                timelineState.dirty ? 'text-amber-300' : 'text-emerald-300'
              }
            >
              {timelineState.dirty ? 'Unsaved changes' : 'Synced'}
            </span>
          </div>
        </footer>

        <div className="rounded-2xl border border-white/8 bg-slate-950/45 px-4 py-3 text-sm text-slate-300">
          {primaryStatus}
        </div>
      </div>
    </div>
  );
}
