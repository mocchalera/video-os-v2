import { useCallback, useEffect, useRef, useState } from 'react';
import type { EditorLane, SelectionState, SnapTarget, TrackHeaderState } from '../types';
import { TRACK_HEIGHT_PX } from '../types';
import { formatTimecode } from '../utils/time';

interface OverlayLayerProps {
  width: number;
  height: number;
  pxPerFrame: number;
  fps: number;
  totalFrames: number;
  playheadFrame: number;
  lanes: EditorLane[];
  trackStates: Record<string, TrackHeaderState>;
  activeSnapGuide: SnapTarget | null;
  dropFrame: boolean;
  onSeek: (frame: number) => void;
  onClearSelection: () => void;
  onMarqueeSelect: (items: SelectionState[]) => void;
}

// ── Constants ────────────────────────────────────────────────────────
const PLAYHEAD_COLOR = '#f97316';
const PLAYHEAD_LINE_WIDTH = 2;
const PLAYHEAD_TRIANGLE_WIDTH = 10;
const PLAYHEAD_TRIANGLE_HEIGHT = 6;

const SNAP_COLOR = 'rgba(106, 168, 255, 0.7)';
const SNAP_DASH = [4, 3];
const SNAP_CHIP_BG = '#6aa8ff';
const SNAP_CHIP_FONT = '600 9px ui-monospace, SFMono-Regular, Menlo, monospace';
const SNAP_CHIP_PAD_X = 5;
const SNAP_CHIP_PAD_Y = 3;
const SNAP_CHIP_RADIUS = 3;
const SNAP_CHIP_OFFSET_Y = 4; // gap between chip bottom and canvas top

const MARQUEE_BORDER_COLOR = '#6aa8ff';
const MARQUEE_FILL_COLOR = 'rgba(106, 168, 255, 0.1)';
const MARQUEE_DASH = [4, 3];

// ── Component ────────────────────────────────────────────────────────
export default function OverlayLayer({
  width,
  height,
  pxPerFrame,
  fps,
  totalFrames,
  playheadFrame,
  lanes,
  trackStates,
  activeSnapGuide,
  dropFrame,
  onSeek,
  onClearSelection,
  onMarqueeSelect,
}: OverlayLayerProps) {
  // ── Refs for avoiding re-renders on playhead ticks ──────────────
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const rafIdRef = useRef<number>(0);
  const playheadFrameRef = useRef(playheadFrame);
  const marqueeRef = useRef<{
    startX: number;
    startY: number;
    endX: number;
    endY: number;
  } | null>(null);

  // Keep the ref in sync with the prop, but do NOT trigger a re-render.
  // The RAF draw loop reads from the ref.
  useEffect(() => {
    playheadFrameRef.current = playheadFrame;
  }, [playheadFrame]);

  // ── Stable refs for values the draw loop reads ──────────────────
  const propsRef = useRef({
    width,
    height,
    pxPerFrame,
    fps,
    totalFrames,
    activeSnapGuide,
    dropFrame,
  });
  useEffect(() => {
    propsRef.current = {
      width,
      height,
      pxPerFrame,
      fps,
      totalFrames,
      activeSnapGuide,
      dropFrame,
    };
  }, [width, height, pxPerFrame, fps, totalFrames, activeSnapGuide, dropFrame]);

  // ── Marquee state (needs React state for pointer capture UI) ────
  // We use a simple boolean state to toggle the crosshair cursor;
  // actual marquee coordinates live in marqueeRef to avoid re-renders
  // during drag.
  const [isDragging, setIsDragging] = useState(false);

  // ── Canvas draw function ────────────────────────────────────────
  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const {
      width: w,
      height: h,
      pxPerFrame: ppf,
      fps: currentFps,
      activeSnapGuide: snap,
      dropFrame: df,
    } = propsRef.current;
    const dpr = window.devicePixelRatio || 1;

    // Resize canvas backing store if needed
    const canvasW = Math.round(w * dpr);
    const canvasH = Math.round(h * dpr);
    if (canvas.width !== canvasW || canvas.height !== canvasH) {
      canvas.width = canvasW;
      canvas.height = canvasH;
    }

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    // ── 1. Playhead ─────────────────────────────────────────────
    const phX = playheadFrameRef.current * ppf;

    // Line
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(phX, 0);
    ctx.lineTo(phX, h);
    ctx.strokeStyle = PLAYHEAD_COLOR;
    ctx.lineWidth = PLAYHEAD_LINE_WIDTH;
    ctx.stroke();

    // Triangle head at top (pointing down)
    const triHalfW = PLAYHEAD_TRIANGLE_WIDTH / 2;
    ctx.beginPath();
    ctx.moveTo(phX - triHalfW, 0);
    ctx.lineTo(phX + triHalfW, 0);
    ctx.lineTo(phX, PLAYHEAD_TRIANGLE_HEIGHT);
    ctx.closePath();
    ctx.fillStyle = PLAYHEAD_COLOR;
    ctx.fill();
    ctx.restore();

    // ── 2. Snap guide ───────────────────────────────────────────
    if (snap) {
      const snapX = snap.frame * ppf;

      // Dashed line
      ctx.save();
      ctx.beginPath();
      ctx.setLineDash(SNAP_DASH);
      ctx.moveTo(snapX, 0);
      ctx.lineTo(snapX, h);
      ctx.strokeStyle = SNAP_COLOR;
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.restore();

      // Timecode chip at top
      const tc = formatTimecode(snap.frame, currentFps, df);
      ctx.save();
      ctx.font = SNAP_CHIP_FONT;
      const textMetrics = ctx.measureText(tc);
      const chipW = textMetrics.width + SNAP_CHIP_PAD_X * 2;
      const chipH = 14; // fixed chip height for 9px font
      const chipX = snapX - chipW / 2;
      const chipY = SNAP_CHIP_OFFSET_Y;

      // Rounded rect background
      ctx.beginPath();
      ctx.roundRect(chipX, chipY, chipW, chipH, SNAP_CHIP_RADIUS);
      ctx.fillStyle = SNAP_CHIP_BG;
      ctx.fill();

      // Text
      ctx.fillStyle = '#ffffff';
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'center';
      ctx.fillText(tc, snapX, chipY + chipH / 2);
      ctx.restore();
    }

    // ── 3. Marquee selection rectangle ──────────────────────────
    const mq = marqueeRef.current;
    if (mq) {
      const left = Math.min(mq.startX, mq.endX);
      const top = Math.min(mq.startY, mq.endY);
      const mqW = Math.abs(mq.endX - mq.startX);
      const mqH = Math.abs(mq.endY - mq.startY);

      if (mqW > 2) {
        ctx.save();

        // Fill
        ctx.fillStyle = MARQUEE_FILL_COLOR;
        ctx.fillRect(left, top, mqW, mqH);

        // Dashed border
        ctx.setLineDash(MARQUEE_DASH);
        ctx.strokeStyle = MARQUEE_BORDER_COLOR;
        ctx.lineWidth = 1;
        ctx.strokeRect(left, top, mqW, mqH);
        ctx.setLineDash([]);

        ctx.restore();
      }
    }
  }, []); // stable — reads everything from refs

  // ── RAF draw loop ───────────────────────────────────────────────
  useEffect(() => {
    let running = true;

    function loop() {
      if (!running) return;
      draw();
      rafIdRef.current = requestAnimationFrame(loop);
    }

    rafIdRef.current = requestAnimationFrame(loop);

    return () => {
      running = false;
      cancelAnimationFrame(rafIdRef.current);
    };
  }, [draw]);

  // ── Pointer handling for seek + marquee ─────────────────────────
  // We keep stable refs for callbacks that the native event listeners use.
  const lanesRef = useRef(lanes);
  const trackStatesRef = useRef(trackStates);
  const pxPerFrameRef = useRef(pxPerFrame);
  const totalFramesRef = useRef(totalFrames);
  const onSeekRef = useRef(onSeek);
  const onClearSelectionRef = useRef(onClearSelection);
  const onMarqueeSelectRef = useRef(onMarqueeSelect);

  useEffect(() => { lanesRef.current = lanes; }, [lanes]);
  useEffect(() => { trackStatesRef.current = trackStates; }, [trackStates]);
  useEffect(() => { pxPerFrameRef.current = pxPerFrame; }, [pxPerFrame]);
  useEffect(() => { totalFramesRef.current = totalFrames; }, [totalFrames]);
  useEffect(() => { onSeekRef.current = onSeek; }, [onSeek]);
  useEffect(() => { onClearSelectionRef.current = onClearSelection; }, [onClearSelection]);
  useEffect(() => { onMarqueeSelectRef.current = onMarqueeSelect; }, [onMarqueeSelect]);

  const handlePointerDown = useCallback(
    (event: React.PointerEvent<HTMLCanvasElement>) => {
      // Only start marquee on direct background click (not on clips above)
      if ((event.target as HTMLElement) !== event.currentTarget) return;

      onClearSelectionRef.current();
      const rect = event.currentTarget.getBoundingClientRect();
      const startX = event.clientX - rect.left;
      const startY = event.clientY - rect.top;

      // Seek to clicked position
      const ppf = pxPerFrameRef.current;
      const frame = Math.max(
        0,
        Math.min(totalFramesRef.current, startX / ppf),
      );
      onSeekRef.current(Math.round(frame));

      marqueeRef.current = { startX, startY, endX: startX, endY: startY };
      setIsDragging(true);

      const el = event.currentTarget;
      el.setPointerCapture(event.pointerId);

      function handleMove(e: PointerEvent) {
        const r = el.getBoundingClientRect();
        const prev = marqueeRef.current;
        if (prev) {
          marqueeRef.current = {
            ...prev,
            endX: e.clientX - r.left,
            endY: e.clientY - r.top,
          };
        }
      }

      function handleUp(e: PointerEvent) {
        el.removeEventListener('pointermove', handleMove);
        el.removeEventListener('pointerup', handleUp);

        const prev = marqueeRef.current;
        if (prev) {
          const finalEndX = e.clientX - el.getBoundingClientRect().left;
          const finalEndY = e.clientY - el.getBoundingClientRect().top;

          const minX = Math.min(prev.startX, finalEndX);
          const maxX = Math.max(prev.startX, finalEndX);
          const minY = Math.min(prev.startY, finalEndY);
          const maxY = Math.max(prev.startY, finalEndY);

          // Only trigger marquee if drag was significant (> 4px)
          if (maxX - minX >= 4 || maxY - minY >= 4) {
            const currentLanes = lanesRef.current;
            const currentTrackStates = trackStatesRef.current;
            const currentPpf = pxPerFrameRef.current;
            const items: SelectionState[] = [];
            let laneY = 0;

            for (const lane of currentLanes) {
              const state = currentTrackStates[lane.laneId];
              const laneH = state ? TRACK_HEIGHT_PX[state.height] : 64;
              const laneBottom = laneY + laneH;

              // Check if marquee overlaps this lane vertically; skip locked
              const isLocked =
                currentTrackStates[lane.laneId]?.locked ?? false;
              if (
                minY < laneBottom &&
                maxY > laneY &&
                lane.trackId &&
                !isLocked
              ) {
                for (const clip of lane.clips) {
                  const clipLeft = clip.timeline_in_frame * currentPpf;
                  const clipRight =
                    (clip.timeline_in_frame + clip.timeline_duration_frames) *
                    currentPpf;

                  // Check horizontal overlap
                  if (clipLeft < maxX && clipRight > minX) {
                    items.push({
                      trackKind: lane.trackKind,
                      trackId: lane.trackId,
                      clipId: clip.clip_id,
                    });
                  }
                }
              }
              laneY += laneH;
            }

            if (items.length > 0) {
              onMarqueeSelectRef.current(items);
            }
          }
        }

        marqueeRef.current = null;
        setIsDragging(false);
      }

      el.addEventListener('pointermove', handleMove);
      el.addEventListener('pointerup', handleUp);
    },
    [], // stable — reads everything from refs
  );

  return (
    <canvas
      ref={canvasRef}
      className="absolute inset-0 z-20"
      style={{
        width,
        height,
        cursor: isDragging ? 'crosshair' : undefined,
      }}
      onPointerDown={handlePointerDown}
    />
  );
}
