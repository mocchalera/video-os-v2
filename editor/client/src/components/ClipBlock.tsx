import { useState, type PointerEvent as ReactPointerEvent } from 'react';
import type { Clip, PatchOperation, ReviewWarning, ReviewWeakness } from '../types';
import { hexToRgba } from '../utils/draw';
import { formatMicroseconds } from '../utils/time';

export type TrimSide = 'start' | 'end';

export interface ClipOverlay {
  weaknesses: ReviewWeakness[];
  warnings: ReviewWarning[];
  patchOps: PatchOperation[];
}

// Design-spec patch op colors (修正R2-4)
const PATCH_OP_OVERLAY_COLORS: Record<string, { border: string; shadow: string }> = {
  replace_segment: { border: '#d946ef', shadow: 'rgba(217,70,239,0.15)' },  // magenta
  trim_segment:    { border: '#f59e0b', shadow: 'rgba(245,158,11,0.15)' },   // amber
  move_segment:    { border: '#06b6d4', shadow: 'rgba(6,182,212,0.15)' },    // cyan
  insert_segment:  { border: '#a855f7', shadow: 'rgba(168,85,247,0.15)' },   // purple
  remove_segment:  { border: '#6b7280', shadow: 'rgba(107,114,128,0.15)' },  // gray
  change_audio_policy: { border: '#8b5cf6', shadow: 'rgba(139,92,246,0.15)' }, // violet
};

interface ClipBlockProps {
  clip: Clip;
  pxPerFrame: number;
  fps: number;
  selected: boolean;
  color: string;
  overlay?: ClipOverlay;
  onSelect: () => void;
  onTrim: (side: TrimSide, baseClip: Clip, deltaFrames: number) => void;
}

function confidenceColor(confidence: number | undefined): {
  bg: string;
  text: string;
  label: string;
} {
  if (confidence == null) return { bg: 'transparent', text: 'transparent', label: '' };
  if (confidence >= 0.85) return { bg: '#16a34a', text: '#fff', label: 'H' };
  if (confidence >= 0.65) return { bg: '#ca8a04', text: '#fff', label: 'M' };
  return { bg: '#dc2626', text: '#fff', label: 'L' };
}

export default function ClipBlock({
  clip,
  pxPerFrame,
  fps,
  selected,
  color,
  overlay,
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
  const showBadge = width > 44 && clip.confidence != null;
  const conf = confidenceColor(clip.confidence);

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
      title={`${clip.clip_id}\n${clip.motivation}\nSource ${formatMicroseconds(clip.src_in_us, fps)} → ${formatMicroseconds(clip.src_out_us, fps)}${clip.confidence != null ? `\nConfidence: ${(clip.confidence * 100).toFixed(0)}%` : ''}`}
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

      <div className="flex h-full items-center justify-between gap-1 px-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <div className="truncate text-[10px] font-semibold uppercase tracking-[0.22em] text-black/60">
              {label}
            </div>
            {showBadge ? (
              <span
                className="inline-flex shrink-0 items-center justify-center rounded-sm px-1 py-px text-[8px] font-bold leading-none"
                style={{ background: conf.bg, color: conf.text }}
              >
                {conf.label}
              </span>
            ) : null}
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

      {/* Review weakness overlay — red dashed border */}
      {overlay && overlay.weaknesses.length > 0 ? (
        <div
          className="pointer-events-none absolute inset-0 rounded"
          style={{
            border: '2px dashed #ef4444',
            boxShadow: 'inset 0 0 6px rgba(239,68,68,0.15)',
          }}
        >
          <span className="absolute -top-1.5 right-1 rounded-sm bg-red-600 px-1 text-[7px] font-bold uppercase leading-tight text-white">
            {overlay.weaknesses.length}W
          </span>
        </div>
      ) : null}

      {/* Review warning overlay — yellow dashed border (修正R2-4) */}
      {overlay && overlay.warnings.length > 0 && overlay.weaknesses.length === 0 ? (
        <div
          className="pointer-events-none absolute inset-0 rounded"
          style={{
            border: '2px dashed #eab308',
            boxShadow: 'inset 0 0 6px rgba(234,179,8,0.15)',
          }}
        >
          <span className="absolute -top-1.5 right-1 rounded-sm bg-yellow-600 px-1 text-[7px] font-bold uppercase leading-tight text-white">
            {overlay.warnings.length}!
          </span>
        </div>
      ) : null}

      {/* Patch operation overlay — color-coded per op type (修正R2-4) */}
      {overlay && overlay.patchOps.length > 0 && overlay.weaknesses.length === 0 ? (() => {
        const primaryOp = overlay.patchOps[0];
        const colors = PATCH_OP_OVERLAY_COLORS[primaryOp.op] ?? { border: '#6b7280', shadow: 'rgba(107,114,128,0.15)' };
        return (
          <div
            className="pointer-events-none absolute inset-0 rounded"
            style={{
              border: `2px dashed ${colors.border}`,
              boxShadow: `inset 0 0 6px ${colors.shadow}`,
            }}
          >
            <span
              className="absolute -top-1.5 right-1 rounded-sm px-1 text-[7px] font-bold uppercase leading-tight text-white"
              style={{ background: colors.border }}
            >
              {overlay.patchOps.length}P
            </span>
          </div>
        );
      })() : null}
    </div>
  );
}
