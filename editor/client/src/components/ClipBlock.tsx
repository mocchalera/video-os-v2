import { useState, type PointerEvent as ReactPointerEvent } from 'react';
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

  function beginTrim(side: TrimSide, event: ReactPointerEvent<HTMLDivElement>): void {
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

  const label = clip.beat_id ?? clip.role;
  const showMotivation = width > 140;
  const showDuration = width > 84;

  return (
    <div
      className="absolute cursor-pointer select-none overflow-hidden rounded border"
      style={{
        left,
        width,
        top: 5,
        bottom: 5,
        background: `linear-gradient(180deg, ${hexToRgba(color, 0.96)} 0%, ${hexToRgba(
          color,
          0.76,
        )} 100%)`,
        borderColor: selected ? '#f8fafc' : hexToRgba(color, 0.52),
        boxShadow: selected
          ? `0 0 0 1px rgba(248,250,252,0.9), 0 16px 32px ${hexToRgba(color, 0.28)}`
          : `inset 0 1px 0 rgba(255,255,255,0.12)`,
        opacity: trimSide ? 0.88 : 1,
      }}
      title={`${clip.clip_id}\n${clip.motivation}\nSource ${formatMicroseconds(clip.src_in_us, fps)} → ${formatMicroseconds(clip.src_out_us, fps)}`}
      onPointerDown={(event) => {
        event.stopPropagation();
      }}
      onClick={(event) => {
        event.stopPropagation();
        onSelect();
      }}
    >
      <div
        className="absolute inset-y-0 left-0 w-2 cursor-ew-resize transition-colors hover:bg-white/20"
        onPointerDown={(event) => beginTrim('start', event)}
      />

      <div className="flex h-full items-center justify-between gap-2 px-3">
        <div className="min-w-0 flex-1">
          <div className="truncate text-[10px] font-semibold uppercase tracking-[0.22em] text-black/60">
            {label}
          </div>
          {showMotivation ? (
            <div className="mt-1 truncate text-[12px] font-medium leading-tight text-slate-950/90">
              {clip.motivation}
            </div>
          ) : null}
        </div>
        {showDuration ? (
          <div className="shrink-0 bg-black/10 px-1.5 py-0.5 font-mono text-[10px] text-slate-950/55">
            {clip.timeline_duration_frames}f
          </div>
        ) : null}
      </div>

      <div
        className="absolute inset-y-0 right-0 w-2 cursor-ew-resize transition-colors hover:bg-white/20"
        onPointerDown={(event) => beginTrim('end', event)}
      />
    </div>
  );
}
