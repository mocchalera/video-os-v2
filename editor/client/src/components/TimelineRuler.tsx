import { useEffect, useRef, useCallback } from 'react';
import { resizeCanvas } from '../utils/draw';
import { formatTimecode, getRulerTickStep } from '../utils/time';
import type { Marker } from '../types';

interface TimelineRulerProps {
  width: number;
  height: number;
  fps: number;
  pxPerFrame: number;
  totalFrames: number;
  playheadFrame: number;
  markers: Marker[];
  dropFrame: boolean;
  onSeek: (frame: number) => void;
  markIn?: number | null;
  markOut?: number | null;
}

export default function TimelineRuler({
  width,
  height,
  fps,
  pxPerFrame,
  totalFrames,
  playheadFrame,
  markers,
  dropFrame,
  onSeek,
  markIn,
  markOut,
}: TimelineRulerProps) {
  const staticCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const playheadCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const playheadFrameRef = useRef(playheadFrame);
  const rafIdRef = useRef<number>(0);

  // ── Static layer: ticks, timecodes, markers, I/O marks ──
  useEffect(() => {
    const canvas = staticCanvasRef.current;
    if (!canvas) return;

    const ctx = resizeCanvas(canvas, width, height);
    if (!ctx) return;

    // Background
    ctx.fillStyle = '#101722';
    ctx.fillRect(0, 0, width, height);

    // Bottom border
    ctx.beginPath();
    ctx.moveTo(0, height - 0.5);
    ctx.lineTo(width, height - 0.5);
    ctx.strokeStyle = 'rgba(148, 163, 184, 0.12)';
    ctx.lineWidth = 1;
    ctx.stroke();

    const { major, minor } = getRulerTickStep(fps, pxPerFrame);

    ctx.font = '10px "Geist Mono", monospace';
    ctx.textBaseline = 'middle';

    // Draw ticks
    for (let frame = 0; frame <= totalFrames + major; frame += minor) {
      const x = Math.round(frame * pxPerFrame) + 0.5;
      if (x > width) break;

      const isMajor = frame % major === 0;

      ctx.beginPath();
      if (isMajor) {
        ctx.moveTo(x, height - 12);
        ctx.lineTo(x, height);
        ctx.strokeStyle = 'rgba(148, 163, 184, 0.4)';
      } else {
        ctx.moveTo(x, height - 5);
        ctx.lineTo(x, height);
        ctx.strokeStyle = 'rgba(148, 163, 184, 0.14)';
      }
      ctx.lineWidth = 1;
      ctx.stroke();

      if (isMajor) {
        ctx.fillStyle = 'rgba(203, 213, 225, 0.62)';
        ctx.fillText(formatTimecode(frame, fps, dropFrame), x + 4, height / 2);
      }
    }

    // Draw markers on ruler
    for (const marker of markers) {
      const x = Math.round(marker.frame * pxPerFrame) + 0.5;
      if (x > width) continue;

      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, height);
      ctx.strokeStyle =
        marker.kind === 'beat'
          ? 'rgba(245, 158, 11, 0.5)'
          : 'rgba(248, 113, 113, 0.35)';
      ctx.setLineDash([3, 3]);
      ctx.stroke();
      ctx.setLineDash([]);

      // Marker diamond
      ctx.fillStyle = marker.kind === 'beat' ? '#f59e0b' : '#f87171';
      ctx.beginPath();
      ctx.moveTo(x, 2);
      ctx.lineTo(x + 4, 6);
      ctx.lineTo(x, 10);
      ctx.lineTo(x - 4, 6);
      ctx.closePath();
      ctx.fill();
    }

    // I/O range overlay
    if (markIn != null || markOut != null) {
      const mInX = markIn != null ? Math.round(markIn * pxPerFrame) : -1;
      const mOutX = markOut != null ? Math.round(markOut * pxPerFrame) : -1;

      // Range fill when both marks set
      if (mInX >= 0 && mOutX >= 0 && mOutX > mInX) {
        ctx.fillStyle = 'rgba(59, 130, 246, 0.12)';
        ctx.fillRect(mInX, 0, mOutX - mInX, height);
      }

      // Mark lines
      ctx.strokeStyle = 'rgba(59, 130, 246, 0.6)';
      ctx.lineWidth = 1;
      if (mInX >= 0) {
        ctx.beginPath();
        ctx.moveTo(mInX + 0.5, 0);
        ctx.lineTo(mInX + 0.5, height);
        ctx.stroke();
      }
      if (mOutX >= 0) {
        ctx.beginPath();
        ctx.moveTo(mOutX + 0.5, 0);
        ctx.lineTo(mOutX + 0.5, height);
        ctx.stroke();
      }
    }
  }, [width, height, fps, pxPerFrame, totalFrames, markers, dropFrame, markIn, markOut]);

  // ── Playhead layer: triangle + line, driven by ref + RAF ──
  const drawPlayhead = useCallback(() => {
    const canvas = playheadCanvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);

    const phX = Math.round(playheadFrameRef.current * pxPerFrame);

    ctx.fillStyle = '#f97316';
    ctx.beginPath();
    ctx.moveTo(phX - 6, 0);
    ctx.lineTo(phX + 6, 0);
    ctx.lineTo(phX + 6, 4);
    ctx.lineTo(phX, height - 2);
    ctx.lineTo(phX - 6, 4);
    ctx.closePath();
    ctx.fill();
  }, [width, height, pxPerFrame]);

  // Size the playhead canvas when dimensions change
  useEffect(() => {
    const canvas = playheadCanvasRef.current;
    if (!canvas) return;

    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.floor(width * dpr);
    canvas.height = Math.floor(height * dpr);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;

    drawPlayhead();
  }, [width, height, drawPlayhead]);

  // Update playhead via ref + RAF — no React re-render needed
  useEffect(() => {
    playheadFrameRef.current = playheadFrame;

    if (rafIdRef.current) {
      cancelAnimationFrame(rafIdRef.current);
    }
    rafIdRef.current = requestAnimationFrame(drawPlayhead);

    return () => {
      if (rafIdRef.current) {
        cancelAnimationFrame(rafIdRef.current);
      }
    };
  }, [playheadFrame, drawPlayhead]);

  function handlePointerDown(event: React.PointerEvent<HTMLCanvasElement>) {
    const rect = event.currentTarget.getBoundingClientRect();
    const frame = Math.max(0, Math.min(totalFrames, (event.clientX - rect.left) / pxPerFrame));
    onSeek(Math.round(frame));

    const el = event.currentTarget;
    el.setPointerCapture(event.pointerId);

    function handleMove(e: PointerEvent) {
      const r = el.getBoundingClientRect();
      const f = Math.max(0, Math.min(totalFrames, (e.clientX - r.left) / pxPerFrame));
      onSeek(Math.round(f));
    }
    function handleUp() {
      el.removeEventListener('pointermove', handleMove);
      el.removeEventListener('pointerup', handleUp);
    }
    el.addEventListener('pointermove', handleMove);
    el.addEventListener('pointerup', handleUp);
  }

  return (
    <div style={{ position: 'relative', width, height }}>
      {/* Static layer: ticks, timecodes, markers, I/O marks */}
      <canvas
        ref={staticCanvasRef}
        style={{ position: 'absolute', top: 0, left: 0, width, height }}
      />
      {/* Playhead layer: triangle only — redraws on playhead movement */}
      <canvas
        ref={playheadCanvasRef}
        className="cursor-pointer"
        style={{ position: 'absolute', top: 0, left: 0, width, height }}
        onPointerDown={handlePointerDown}
      />
    </div>
  );
}
