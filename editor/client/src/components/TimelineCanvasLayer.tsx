import { memo, useEffect, useRef } from 'react';
import { resizeCanvas } from '../utils/draw';
import type { EditorLane, TrackHeaderState } from '../types';
import { TRACK_HEIGHT_PX } from '../types';
import { getRulerTickStep } from '../utils/time';

const LANE_FILLS = ['rgba(16, 23, 34, 0.96)', 'rgba(12, 18, 28, 0.96)'];

interface TimelineCanvasLayerProps {
  width: number;
  height: number;
  fps: number;
  pxPerFrame: number;
  totalFrames: number;
  lanes: EditorLane[];
  trackStates: Record<string, TrackHeaderState>;
}

export default memo(function TimelineCanvasLayer({
  width,
  height,
  fps,
  pxPerFrame,
  totalFrames,
  lanes,
  trackStates,
}: TimelineCanvasLayerProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = resizeCanvas(canvas, width, height);
    if (!ctx) return;

    // Background
    ctx.fillStyle = '#0b1017';
    ctx.fillRect(0, 0, width, height);

    // Lane backgrounds
    let y = 0;
    for (let i = 0; i < lanes.length; i++) {
      const lane = lanes[i];
      const state = trackStates[lane.laneId];
      const laneH = state ? TRACK_HEIGHT_PX[state.height] : 64;

      ctx.fillStyle = LANE_FILLS[i % LANE_FILLS.length];
      ctx.fillRect(0, y, width, laneH);

      // Muted overlay
      if (state?.muted) {
        ctx.fillStyle = 'rgba(0, 0, 0, 0.3)';
        ctx.fillRect(0, y, width, laneH);
      }

      // Locked hatch pattern
      if (state?.locked) {
        ctx.strokeStyle = 'rgba(220, 38, 38, 0.08)';
        ctx.lineWidth = 1;
        for (let hx = -laneH; hx < width; hx += 12) {
          ctx.beginPath();
          ctx.moveTo(hx, y);
          ctx.lineTo(hx + laneH, y + laneH);
          ctx.stroke();
        }
      }

      // Lane divider (border-soft)
      ctx.beginPath();
      ctx.moveTo(0, y + laneH + 0.5);
      ctx.lineTo(width, y + laneH + 0.5);
      ctx.strokeStyle = 'rgba(148, 163, 184, 0.10)';
      ctx.lineWidth = 1;
      ctx.stroke();

      y += laneH;
    }

    // Grid lines
    const { major, minor } = getRulerTickStep(fps, pxPerFrame);

    for (let frame = 0; frame <= totalFrames + major; frame += minor) {
      const x = Math.round(frame * pxPerFrame) + 0.5;
      if (x > width) break;

      const isMajor = frame % major === 0;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, height);
      ctx.strokeStyle = isMajor
        ? 'rgba(148, 163, 184, 0.12)'
        : 'rgba(148, 163, 184, 0.03)';
      ctx.lineWidth = isMajor ? 1 : 0.5;
      ctx.stroke();
    }
  }, [width, height, fps, pxPerFrame, totalFrames, lanes, trackStates]);

  return (
    <canvas
      ref={canvasRef}
      className="absolute inset-0"
      style={{ width, height }}
    />
  );
});
