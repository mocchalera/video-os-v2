import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type WheelEvent as ReactWheelEvent,
} from 'react';
import type {
  Clip,
  EditorLane,
  Marker,
  SelectionState,
  SnapTarget,
  TrackHeaderState,
  TrimMode,
  TrimTarget,
} from '../types';
import { TRACK_HEIGHT_PX } from '../types';
import { clamp } from '../utils/time';
import type { ClipOverlay } from './ClipBlock';
import TimelineRuler from './TimelineRuler';
import TrackHeader from './TrackHeader';
import TimelineCanvasLayer from './TimelineCanvasLayer';
import ClipLayer from './ClipLayer';
import OverlayLayer from './OverlayLayer';

const TRACK_LABEL_WIDTH = 120;
const RULER_HEIGHT = 34;
const MIN_ZOOM = 1.25;
const MAX_ZOOM = 24;

export interface TimelineHandle {
  scrollToFrame: (frame: number) => void;
}

interface TimelineProps {
  lanes: EditorLane[];
  markers: Marker[];
  fps: number;
  totalFrames: number;
  zoom: number;
  playheadFrame: number;
  selectedClipIds: Set<string>;
  clipOverlays?: Map<string, ClipOverlay>;
  dropFrame?: boolean;
  projectId: string | null;
  trimMode?: TrimMode;
  // Track header state
  trackStates: Record<string, TrackHeaderState>;
  onToggleLock: (trackId: string) => void;
  onToggleMute: (trackId: string) => void;
  onToggleSolo: (trackId: string) => void;
  onToggleSyncLock: (trackId: string) => void;
  onCycleHeight: (trackId: string) => void;
  // Snap
  snapEnabled: boolean;
  activeSnapGuide: SnapTarget | null;
  // Callbacks
  onZoomChange: (nextZoom: number) => void;
  onSeek: (frame: number) => void;
  onClearSelection: () => void;
  onSelectClip: (
    trackKind: 'video' | 'audio',
    trackId: string,
    clip: Clip,
    event: { shiftKey: boolean; metaKey: boolean; ctrlKey: boolean },
  ) => void;
  onTrimBegin: (target: TrimTarget, opts?: { altKey?: boolean }) => void;
  onTrimUpdate: (deltaFrames: number, opts?: { skipSnap?: boolean }) => void;
  onTrimCommit: () => void;
  onMarqueeSelect: (items: SelectionState[]) => void;
  // I/O marks for ruler overlay
  markIn?: number | null;
  markOut?: number | null;
  /** Active confidence filter for clip dimming */
  confidenceFilter?: 'all' | 'low' | 'warnings';
  /** Editor mode — forwarded to ClipBlock for AI-mode glow */
  editorMode?: 'nle' | 'ai';
}

export default forwardRef<TimelineHandle, TimelineProps>(function Timeline({
  lanes,
  markers,
  fps,
  totalFrames,
  zoom,
  playheadFrame,
  selectedClipIds,
  clipOverlays,
  dropFrame = false,
  projectId,
  trimMode = 'selection',
  trackStates,
  onToggleLock,
  onToggleMute,
  onToggleSolo,
  onToggleSyncLock,
  onCycleHeight,
  snapEnabled,
  activeSnapGuide,
  onZoomChange,
  onSeek,
  onClearSelection,
  onSelectClip,
  onTrimBegin,
  onTrimUpdate,
  onTrimCommit,
  onMarqueeSelect,
  markIn,
  markOut,
  confidenceFilter = 'all',
  editorMode = 'nle',
}: TimelineProps, ref) {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const [viewportWidth, setViewportWidth] = useState(0);

  // Expose scrollToFrame for external callers (e.g. DiffPanel jump)
  useImperativeHandle(ref, () => ({
    scrollToFrame(frame: number) {
      const vp = viewportRef.current;
      if (!vp) return;
      const targetX = frame * zoom - vp.clientWidth / 2 + TRACK_LABEL_WIDTH;
      vp.scrollLeft = Math.max(0, targetX);
    },
  }), [zoom]);

  // Compute total content height from lane heights
  const tracksHeight = useMemo(() => {
    return lanes.reduce((sum, lane) => {
      const state = trackStates[lane.laneId];
      return sum + (state ? TRACK_HEIGHT_PX[state.height] : 64);
    }, 0);
  }, [lanes, trackStates]);

  const contentWidth = Math.max(viewportWidth, totalFrames * zoom + 240);
  const contentHeight = tracksHeight;

  // Build a plain object from trackStates for stable reference
  const trackStatesObj = useMemo(() => {
    const obj: Record<string, TrackHeaderState> = {};
    for (const lane of lanes) {
      obj[lane.laneId] = trackStates[lane.laneId] ?? {
        locked: false,
        muted: false,
        solo: false,
        syncLock: false,
        height: 'M' as const,
      };
    }
    return obj;
  }, [lanes, trackStates]);

  // Viewport resize observer
  useEffect(() => {
    if (!viewportRef.current) return;

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      setViewportWidth(entry.contentRect.width);
    });
    observer.observe(viewportRef.current);
    return () => observer.disconnect();
  }, []);

  // Zoom/scroll with wheel
  function handleWheel(event: ReactWheelEvent<HTMLDivElement>) {
    const viewport = viewportRef.current;
    if (!viewport) return;

    if (event.ctrlKey || event.metaKey) {
      event.preventDefault();
      const rect = viewport.getBoundingClientRect();
      // Account for TRACK_LABEL_WIDTH offset in unified scroll container
      const pointerOffset = event.clientX - rect.left - TRACK_LABEL_WIDTH;
      const frameAtPointer = (pointerOffset + viewport.scrollLeft) / zoom;
      const nextZoom = clamp(
        zoom * (event.deltaY < 0 ? 1.12 : 0.9),
        MIN_ZOOM,
        MAX_ZOOM,
      );
      onZoomChange(nextZoom);
      window.requestAnimationFrame(() => {
        if (!viewportRef.current) return;
        viewportRef.current.scrollLeft = frameAtPointer * nextZoom - pointerOffset;
      });
      return;
    }

    if (event.shiftKey) {
      event.preventDefault();
      viewport.scrollLeft += event.deltaX + event.deltaY;
    }
  }

  // CSS Grid scroll container: the grid enables proper sticky positioning.
  // Column 1 (track labels) is sticky left; Row 1 (ruler) is sticky top.
  // The corner cell is sticky in both axes.
  return (
    <div
      ref={viewportRef}
      className="editor-scrollbar h-full min-h-0 overflow-auto"
      onWheel={handleWheel}
    >
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: `${TRACK_LABEL_WIDTH}px ${contentWidth}px`,
          gridTemplateRows: `${RULER_HEIGHT}px ${contentHeight}px`,
        }}
      >
        {/* ── Sticky top-left corner: ruler spacer + snap indicator ── */}
        <div
          className="z-40 flex items-center border-b border-r border-white/[0.06] bg-[#0b1017] px-3 font-mono text-[10px] uppercase tracking-[0.24em] text-[color:var(--text-subtle)]"
          style={{ position: 'sticky', top: 0, left: 0, height: RULER_HEIGHT }}
        >
          {snapEnabled ? (
            <span className="flex items-center gap-1">
              <span className="inline-block h-1.5 w-1.5 rounded-full bg-[var(--accent)]" />
              Snap
            </span>
          ) : (
            'Tracks'
          )}
        </div>

        {/* ── Ruler row (sticky top) ── */}
        <div
          className="z-30"
          style={{ position: 'sticky', top: 0 }}
        >
          <TimelineRuler
            width={contentWidth}
            height={RULER_HEIGHT}
            fps={fps}
            pxPerFrame={zoom}
            totalFrames={totalFrames}
            playheadFrame={playheadFrame}
            markers={markers}
            dropFrame={dropFrame}
            onSeek={(frame) => { onClearSelection(); onSeek(frame); }}
            markIn={markIn}
            markOut={markOut}
          />
        </div>

        {/* ── Track headers (sticky left) ── */}
        <div
          className="z-20 border-r border-white/[0.06] bg-[#0b1017]"
          style={{ position: 'sticky', left: 0 }}
        >
          {lanes.map((lane) => (
            <TrackHeader
              key={lane.laneId}
              lane={lane}
              state={trackStatesObj[lane.laneId]}
              onToggleLock={() => onToggleLock(lane.laneId)}
              onToggleMute={() => onToggleMute(lane.laneId)}
              onToggleSolo={() => onToggleSolo(lane.laneId)}
              onToggleSyncLock={() => onToggleSyncLock(lane.laneId)}
              onCycleHeight={() => onCycleHeight(lane.laneId)}
            />
          ))}
        </div>

        {/* ── Track content area (Canvas + Clips + Overlay) ── */}
        <div className="relative" style={{ width: contentWidth, height: contentHeight }}>
          {/* Empty timeline placeholder */}
          {lanes.every(l => l.clips.length === 0) && (
            <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center">
              <div className="rounded-lg border border-dashed border-white/[0.08] bg-white/[0.02] px-8 py-6 text-center">
                <div className="mb-1 text-[13px] font-medium text-[color:var(--text-muted)]">
                  No clips on timeline
                </div>
                <div className="text-[11px] text-[color:var(--text-subtle)]">
                  Drop clips here or run <kbd className="mx-0.5 rounded border border-white/[0.1] bg-white/[0.04] px-1 py-px font-mono text-[10px]">Cmd+Shift+B</kbd> to Compile
                </div>
              </div>
            </div>
          )}
          {/* Layer 1: Canvas background (grid, lane fills) */}
          <TimelineCanvasLayer
            width={contentWidth}
            height={contentHeight}
            fps={fps}
            pxPerFrame={zoom}
            totalFrames={totalFrames}
            lanes={lanes}
            trackStates={trackStatesObj}
          />

          {/* Layer 2: DOM clip blocks */}
          <ClipLayer
            lanes={lanes}
            trackStates={trackStatesObj}
            contentWidth={contentWidth}
            pxPerFrame={zoom}
            fps={fps}
            selectedClipIds={selectedClipIds}
            clipOverlays={clipOverlays}
            projectId={projectId}
            trimMode={trimMode}
            confidenceFilter={confidenceFilter}
            editorMode={editorMode}
            onSelectClip={onSelectClip}
            onTrimBegin={onTrimBegin}
            onTrimUpdate={onTrimUpdate}
            onTrimCommit={onTrimCommit}
          />

          {/* Layer 3: Overlays (playhead, snap guide, marquee) */}
          <OverlayLayer
            width={contentWidth}
            height={contentHeight}
            pxPerFrame={zoom}
            fps={fps}
            totalFrames={totalFrames}
            playheadFrame={playheadFrame}
            lanes={lanes}
            trackStates={trackStatesObj}
            activeSnapGuide={activeSnapGuide}
            dropFrame={dropFrame}
            onSeek={onSeek}
            onClearSelection={onClearSelection}
            onMarqueeSelect={onMarqueeSelect}
          />
        </div>
      </div>
    </div>
  );
});
