import {
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent as ReactWheelEvent,
} from 'react';
import type { Clip, EditorLane, Marker } from '../types';
import { drawTimelineBackdrop, resizeCanvas } from '../utils/draw';
import { clamp } from '../utils/time';
import type { TrimSide } from './ClipBlock';
import TrackLane from './TrackLane';

const TRACK_LABEL_WIDTH = 104;
const RULER_HEIGHT = 34;
const LANE_HEIGHT = 64;
const MIN_ZOOM = 1.25;
const MAX_ZOOM = 24;

interface TimelineProps {
  lanes: EditorLane[];
  markers: Marker[];
  fps: number;
  totalFrames: number;
  zoom: number;
  playheadFrame: number;
  selectedClipId: string | null;
  onZoomChange: (nextZoom: number) => void;
  onSeek: (frame: number) => void;
  onClearSelection: () => void;
  onSelectClip: (trackKind: 'video' | 'audio', trackId: string, clip: Clip) => void;
  onTrimClip: (
    trackKind: 'video' | 'audio',
    trackId: string,
    baseClip: Clip,
    side: TrimSide,
    deltaFrames: number,
  ) => void;
}

export default function Timeline({
  lanes,
  markers,
  fps,
  totalFrames,
  zoom,
  playheadFrame,
  selectedClipId,
  onZoomChange,
  onSeek,
  onClearSelection,
  onSelectClip,
  onTrimClip,
}: TimelineProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const [viewportWidth, setViewportWidth] = useState(0);
  const contentWidth = Math.max(viewportWidth, totalFrames * zoom + 240);
  const contentHeight = RULER_HEIGHT + lanes.length * LANE_HEIGHT;

  useEffect(() => {
    if (!viewportRef.current) {
      return;
    }

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      setViewportWidth(entry.contentRect.width);
    });
    observer.observe(viewportRef.current);

    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!canvasRef.current) {
      return;
    }

    const context = resizeCanvas(canvasRef.current, contentWidth, contentHeight);
    if (!context) {
      return;
    }

    drawTimelineBackdrop(context, {
      width: contentWidth,
      height: contentHeight,
      fps,
      pxPerFrame: zoom,
      totalFrames,
      rulerHeight: RULER_HEIGHT,
      laneHeight: LANE_HEIGHT,
      lanes,
      markers,
    });
  }, [contentHeight, contentWidth, fps, lanes, markers, totalFrames, zoom]);

  function getFrameFromPointer(event: ReactPointerEvent<HTMLDivElement>): number {
    const rect = event.currentTarget.getBoundingClientRect();
    return clamp((event.clientX - rect.left) / zoom, 0, totalFrames);
  }

  function handleWheel(event: ReactWheelEvent<HTMLDivElement>): void {
    const viewport = viewportRef.current;
    if (!viewport) {
      return;
    }

    if (event.ctrlKey || event.metaKey) {
      event.preventDefault();
      const rect = viewport.getBoundingClientRect();
      const pointerOffset = event.clientX - rect.left;
      const frameAtPointer = (pointerOffset + viewport.scrollLeft) / zoom;
      const nextZoom = clamp(
        zoom * (event.deltaY < 0 ? 1.12 : 0.9),
        MIN_ZOOM,
        MAX_ZOOM,
      );

      onZoomChange(nextZoom);
      window.requestAnimationFrame(() => {
        if (!viewportRef.current) {
          return;
        }

        viewportRef.current.scrollLeft = frameAtPointer * nextZoom - pointerOffset;
      });
      return;
    }

    if (event.shiftKey) {
      event.preventDefault();
      viewport.scrollLeft += event.deltaX + event.deltaY;
    }
  }

  return (
    <div
      className="grid h-full min-h-0 overflow-hidden"
      style={{ gridTemplateColumns: `${TRACK_LABEL_WIDTH}px minmax(0, 1fr)` }}
    >
      <div className="border-r border-white/[0.06]">
        <div className="flex h-[34px] items-center px-3 font-mono text-[10px] uppercase tracking-[0.24em] text-[color:var(--text-subtle)]">
          Tracks
        </div>

        {lanes.map((lane) => (
          <div
            key={lane.label}
            className="flex h-[64px] items-center border-t border-white/[0.05] px-3"
          >
            <div className="flex items-center gap-2">
              <span
                className={`h-2 w-2 rounded-full ${
                  lane.trackKind === 'video' ? 'bg-sky-400/80' : 'bg-emerald-400/80'
                }`}
              />
              <div>
                <div className="font-mono text-[11px] font-semibold uppercase tracking-[0.24em] text-neutral-100">
                  {lane.label}
                </div>
                <div className="mt-1 text-[10px] uppercase tracking-[0.18em] text-[color:var(--text-subtle)]">
                  {lane.trackKind === 'video' ? 'Picture' : 'Audio'}
                </div>
              </div>
            </div>
          </div>
        ))}
      </div>

      <div
        ref={viewportRef}
        className="editor-scrollbar overflow-x-auto overflow-y-hidden"
        onWheel={handleWheel}
      >
        <div className="relative" style={{ width: contentWidth, height: contentHeight }}>
          <canvas ref={canvasRef} className="absolute inset-0" />

          <div
            className="absolute inset-x-0 top-0 z-10 h-[34px] cursor-pointer"
            onPointerDown={(event) => {
              onClearSelection();
              onSeek(getFrameFromPointer(event));
            }}
          />

          <div
            className="absolute inset-x-0 top-[34px] z-10"
            style={{ height: lanes.length * LANE_HEIGHT }}
            onPointerDown={(event) => {
              onClearSelection();
              onSeek(getFrameFromPointer(event));
            }}
          />

          <div className="absolute inset-x-0 top-[34px] z-20">
            {lanes.map((lane) => (
              <TrackLane
                key={lane.label}
                lane={lane}
                width={contentWidth}
                laneHeight={LANE_HEIGHT}
                pxPerFrame={zoom}
                fps={fps}
                selectedClipId={selectedClipId}
                onSelectClip={onSelectClip}
                onTrimClip={onTrimClip}
              />
            ))}
          </div>

          <div
            className="pointer-events-none absolute top-0 bottom-0 z-30 w-px bg-[#f97316]"
            style={{ left: playheadFrame * zoom }}
          >
            <div className="absolute -top-px left-1/2 -translate-x-1/2">
              <div
                className="h-0 w-0"
                style={{
                  borderLeft: '6px solid transparent',
                  borderRight: '6px solid transparent',
                  borderTop: '7px solid #f97316',
                }}
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
