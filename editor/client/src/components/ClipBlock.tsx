import { useState } from 'react';
import type { Clip } from '../types';
import { hexToRgba } from '../utils/draw';
import { formatMicroseconds } from '../utils/time';

export type TrimSide = 'start' | 'end';

interface ClipBlockProps {
  clip: Clip;
  pxPerFrame: number;
  fps: number;
  selected: boolean;
  color: string;
  onSelect: () => void;
  onTrim: (side: TrimSide, baseClip: Clip, deltaFrames: number) => void;
}

export default function ClipBlock({
  clip,
  pxPerFrame,
  fps,
  selected,
  color,
  onSelect,
  onTrim,
}: ClipBlockProps) {
  const [trimSide, setTrimSide] = useState<TrimSide | null>(null);
  const left = clip.timeline_in_frame * pxPerFrame;
  const width = Math.max(24, clip.timeline_duration_frames * pxPerFrame);

  function beginTrim(side: TrimSide, event: React.PointerEvent<HTMLDivElement>): void {
    event.preventDefault();
    event.stopPropagation();

    const startX = event.clientX;
    const baseClip = structuredClone(clip);
    setTrimSide(side);
    onSelect();

    function handlePointerMove(moveEvent: PointerEvent): void {
      const deltaFrames = Math.round((moveEvent.clientX - startX) / pxPerFrame);
      onTrim(side, baseClip, deltaFrames);
    }

    function handlePointerUp(): void {
      setTrimSide(null);
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
    }

    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp);
  }

  const summary =
    width > 168 ? clip.motivation : width > 96 ? clip.clip_id : clip.beat_id ?? clip.clip_id;

  return (
    <div
      className="absolute top-2 h-[56px] cursor-pointer select-none rounded-lg border shadow-[0_10px_26px_rgba(0,0,0,0.22)] transition"
      style={{
        left,
        width,
        background: `linear-gradient(135deg, ${hexToRgba(color, 0.96)} 0%, ${hexToRgba(
          color,
          0.8,
        )} 100%)`,
        borderColor: selected ? 'rgba(255,255,255,0.95)' : 'rgba(255,255,255,0.16)',
        boxShadow: selected
          ? `0 0 0 2px rgba(255,255,255,0.98), 0 12px 28px ${hexToRgba(color, 0.3)}`
          : `0 10px 26px ${hexToRgba(color, 0.18)}`,
        filter: trimSide ? 'brightness(1.08)' : undefined,
      }}
      title={`${clip.clip_id}
${clip.motivation}
Source ${formatMicroseconds(clip.src_in_us, fps)} → ${formatMicroseconds(
        clip.src_out_us,
        fps,
      )}`}
      onPointerDown={(event) => {
        event.stopPropagation();
      }}
      onClick={(event) => {
        event.stopPropagation();
        onSelect();
      }}
    >
      <div
        className="absolute inset-y-0 left-0 w-2 cursor-ew-resize rounded-l-lg bg-white/15 hover:bg-white/40"
        onPointerDown={(event) => beginTrim('start', event)}
      />

      <div className="flex h-full items-start justify-between gap-2 overflow-hidden px-3 py-2 text-left text-slate-950">
        <div className="min-w-0">
          <div className="font-mono text-[11px] font-semibold uppercase tracking-[0.16em] text-black/70">
            {clip.beat_id ?? clip.role}
          </div>
          <div className="mt-1 line-clamp-2 text-sm leading-tight font-medium">
            {summary}
          </div>
        </div>

        {width > 84 ? (
          <div className="shrink-0 rounded-full bg-black/15 px-2 py-1 font-mono text-[11px] font-semibold text-black/70">
            {clip.timeline_duration_frames}f
          </div>
        ) : null}
      </div>

      <div
        className="absolute inset-y-0 right-0 w-2 cursor-ew-resize rounded-r-lg bg-white/15 hover:bg-white/40"
        onPointerDown={(event) => beginTrim('end', event)}
      />
    </div>
  );
}
