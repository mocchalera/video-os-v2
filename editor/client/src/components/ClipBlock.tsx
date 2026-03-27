import { memo, useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import type { Clip, PatchOperation, ReviewWarning, ReviewWeakness, TrackHeight, TrimMode, TrimTarget } from '../types';
import { CONFIDENCE_HIGH, CONFIDENCE_MEDIUM } from '../types';
import { hexToRgba } from '../utils/draw';
import { formatMicroseconds } from '../utils/time';
import { useWaveform } from '../hooks/useWaveform';

export type TrimSide = 'start' | 'end';

export interface ClipOverlay {
  weaknesses: ReviewWeakness[];
  warnings: ReviewWarning[];
  patchOps: PatchOperation[];
}

// Design-spec patch op colors
const PATCH_OP_OVERLAY_COLORS: Record<string, { border: string; shadow: string }> = {
  replace_segment: { border: '#d946ef', shadow: 'rgba(217,70,239,0.15)' },
  trim_segment:    { border: '#f59e0b', shadow: 'rgba(245,158,11,0.15)' },
  move_segment:    { border: '#06b6d4', shadow: 'rgba(6,182,212,0.15)' },
  insert_segment:  { border: '#a855f7', shadow: 'rgba(168,85,247,0.15)' },
  remove_segment:  { border: '#6b7280', shadow: 'rgba(107,114,128,0.15)' },
  change_audio_policy: { border: '#8b5cf6', shadow: 'rgba(139,92,246,0.15)' },
};

/** Cursor style per trim mode */
const TRIM_CURSORS: Record<TrimMode, { edge: string; body: string }> = {
  selection: { edge: 'ew-resize', body: 'pointer' },
  ripple:    { edge: 'col-resize', body: 'pointer' },
  roll:      { edge: 'col-resize', body: 'pointer' },
  slip:      { edge: 'grab', body: 'grab' },
  slide:     { edge: 'move', body: 'move' },
};

interface ClipBlockProps {
  clip: Clip;
  pxPerFrame: number;
  fps: number;
  laneHeight: number;
  selected: boolean;
  color: string;
  overlay?: ClipOverlay;
  trackKind: 'video' | 'audio';
  trackId: string;
  trackHeight: TrackHeight;
  projectId: string | null;
  locked: boolean;
  trimMode?: TrimMode;
  /** Link group ID for J/L-cut display */
  linkGroupId?: string | null;
  /** Offset in frames from linked partner (positive = L-cut, negative = J-cut) */
  linkOffset?: number;
  /** Active confidence filter for dimming */
  confidenceFilter?: 'all' | 'low' | 'warnings';
  /** Editor mode — when 'ai', low-confidence clips always show glow */
  editorMode?: 'nle' | 'ai';
  onSelect: (event: { shiftKey: boolean; metaKey: boolean; ctrlKey: boolean }) => void;
  /** Begin a trim operation via useTrimTool (opts.altKey = single-side linked trim) */
  onTrimBegin: (target: TrimTarget, opts?: { altKey?: boolean }) => void;
  /** Update trim with accumulated delta from drag start */
  onTrimUpdate: (deltaFrames: number, opts?: { skipSnap?: boolean }) => void;
  /** Commit the trim operation */
  onTrimCommit: () => void;
}

function confidenceColor(confidence: number | undefined): {
  bg: string;
  text: string;
  label: string;
} {
  if (confidence == null) return { bg: 'transparent', text: 'transparent', label: '' };
  if (confidence >= CONFIDENCE_HIGH) return { bg: '#16a34a', text: '#fff', label: 'H' };
  if (confidence >= CONFIDENCE_MEDIUM) return { bg: '#ca8a04', text: '#fff', label: 'M' };
  return { bg: '#dc2626', text: '#fff', label: 'L' };
}

/** Clamp font size to zoom-appropriate range */
function clipFontSize(pxPerFrame: number): number {
  // Scale: at low zoom small text, at high zoom larger
  const size = 9 + (pxPerFrame / 24) * 4;
  return Math.max(10, Math.min(13, size));
}

/** Draw waveform peaks on a Canvas */
function drawWaveform(
  canvas: HTMLCanvasElement,
  peaks: number[],
  width: number,
  height: number,
  color: string,
) {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.floor(width * dpr);
  canvas.height = Math.floor(height * dpr);
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  ctx.clearRect(0, 0, width, height);

  if (peaks.length === 0) return;

  const midY = height / 2;
  const samplesPerPixel = peaks.length / width;

  ctx.fillStyle = color;
  ctx.globalAlpha = 0.6;

  for (let x = 0; x < width; x++) {
    const startSample = Math.floor(x * samplesPerPixel);
    const endSample = Math.min(peaks.length, Math.floor((x + 1) * samplesPerPixel));

    let maxVal = 0;
    for (let i = startSample; i < endSample; i++) {
      maxVal = Math.max(maxVal, Math.abs(peaks[i]));
    }

    const barHeight = maxVal * midY * 0.9;
    if (barHeight > 0.5) {
      ctx.fillRect(x, midY - barHeight, 1, barHeight * 2);
    }
  }
}

export default memo(function ClipBlock({
  clip,
  pxPerFrame,
  fps,
  laneHeight,
  selected,
  color,
  overlay,
  trackKind,
  trackId,
  trackHeight,
  projectId,
  locked,
  trimMode = 'selection',
  linkGroupId,
  linkOffset,
  confidenceFilter = 'all',
  editorMode = 'nle',
  onSelect,
  onTrimBegin,
  onTrimUpdate,
  onTrimCommit,
}: ClipBlockProps) {
  const [trimSide, setTrimSide] = useState<TrimSide | null>(null);
  const waveformCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const [thumbUrl, setThumbUrl] = useState<string | null>(null);
  const [thumbError, setThumbError] = useState(false);
  const clipRef = useRef<HTMLDivElement | null>(null);
  const [isVisible, setIsVisible] = useState(false);

  // IntersectionObserver for lazy fetch (200px buffer)
  useEffect(() => {
    const el = clipRef.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      ([entry]) => { setIsVisible(entry.isIntersecting); },
      { rootMargin: '200px' },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const left = clip.timeline_in_frame * pxPerFrame;
  const width = Math.max(24, clip.timeline_duration_frames * pxPerFrame);
  const topPad = 4;
  const bottomPad = 4;
  const clipHeight = laneHeight - topPad - bottomPad;

  // Waveform for audio tracks (and video audio in M/L height)
  const showWaveform = trackKind === 'audio' || (trackKind === 'video' && trackHeight !== 'S');
  const waveform = useWaveform({
    projectId,
    assetId: clip.asset_id,
    trackHeight,
    visible: isVisible && showWaveform && width > 30,
  });

  // Draw waveform when data arrives
  useEffect(() => {
    if (!waveformCanvasRef.current || !waveform.data) return;
    const waveH = trackKind === 'audio' ? clipHeight - 16 : Math.min(24, clipHeight / 3);
    drawWaveform(waveformCanvasRef.current, waveform.data.peaks, width - 4, waveH, color);
  }, [waveform.data, width, clipHeight, color, trackKind]);

  // Thumbnail for video tracks (only fetch when visible, with AbortController)
  const showThumbnail = trackKind === 'video' && width > 40 && isVisible;
  useEffect(() => {
    if (!showThumbnail || !projectId) {
      setThumbUrl(null);
      return;
    }
    setThumbError(false);

    const midUs = Math.round((clip.src_in_us + clip.src_out_us) / 2);
    const thumbH = trackHeight === 'S' ? 24 : trackHeight === 'M' ? 48 : 96;
    const thumbW = Math.round(thumbH * (16 / 9));
    const url = `/api/projects/${projectId}/thumbnail/by-asset/${encodeURIComponent(clip.asset_id)}?frame_us=${midUs}&width=${thumbW}&height=${thumbH}`;

    const controller = new AbortController();
    fetch(url, { signal: controller.signal })
      .then((r) => {
        if (!r.ok) throw new Error('thumb fetch failed');
        return r.blob();
      })
      .then((blob) => {
        const objectUrl = URL.createObjectURL(blob);
        setThumbUrl(objectUrl);
      })
      .catch((err) => {
        if ((err as DOMException).name !== 'AbortError') {
          setThumbError(true);
        }
      });

    return () => {
      controller.abort();
      // Revoke previous object URL to avoid memory leaks
      setThumbUrl((prev) => {
        if (prev?.startsWith('blob:')) URL.revokeObjectURL(prev);
        return null;
      });
    };
  }, [showThumbnail, projectId, clip.asset_id, clip.src_in_us, clip.src_out_us, trackHeight]);

  function handleTrimPointerDown(side: TrimSide, event: ReactPointerEvent<HTMLDivElement>): void {
    if (locked) return;
    event.preventDefault();
    event.stopPropagation();

    const startX = event.clientX;
    const trimTarget: TrimTarget = {
      clipId: clip.clip_id,
      trackId,
      trackKind,
      side: side === 'start' ? 'head' : 'tail',
    };

    setTrimSide(side);
    onSelect({ shiftKey: false, metaKey: false, ctrlKey: false });
    // HIGH 3: Pass altKey so beginTrim can decide linked vs single-side trim
    onTrimBegin(trimTarget, { altKey: event.altKey });

    // Maintain pointer capture during trim
    const el = event.currentTarget;
    el.setPointerCapture(event.pointerId);

    function handlePointerMove(moveEvent: PointerEvent): void {
      const deltaFrames = Math.round((moveEvent.clientX - startX) / pxPerFrame);
      // Alt key during trim = skip snap (HIGH 4)
      onTrimUpdate(deltaFrames, { skipSnap: moveEvent.altKey });
    }

    function handlePointerUp(upEvent: PointerEvent): void {
      setTrimSide(null);
      el.releasePointerCapture(upEvent.pointerId);
      onTrimCommit();
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
    }

    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp);
  }

  // ── Confidence filter: dimming & glow ─────────────────────────────
  const isLowConfidence = clip.confidence != null && clip.confidence < CONFIDENCE_MEDIUM;
  const hasWarnings = overlay && (overlay.warnings.length > 0 || overlay.weaknesses.length > 0);
  const isDimmed = confidenceFilter === 'low'
    ? !isLowConfidence
    : confidenceFilter === 'warnings'
      ? !hasWarnings
      : false;
  const showLowGlow = isLowConfidence && (confidenceFilter !== 'all' || editorMode === 'ai');

  const label = clip.beat_id ?? clip.role;
  const showMotivation = width > 140 && trackHeight !== 'S';
  const showDuration = width > 84;
  const showBadge = width > 44 && clip.confidence != null;
  const conf = confidenceColor(clip.confidence);

  return (
    <div
      ref={clipRef}
      className="pointer-events-auto absolute cursor-pointer select-none overflow-hidden rounded border"
      style={{
        left,
        width,
        top: topPad,
        height: clipHeight,
        background: `linear-gradient(180deg, ${hexToRgba(color, 0.96)} 0%, ${hexToRgba(
          color,
          0.76,
        )} 100%)`,
        borderWidth: selected ? 2 : 1,
        borderColor: selected ? 'var(--accent-strong)' : hexToRgba(color, 0.32),
        boxShadow: showLowGlow
          ? `0 0 0 2px rgba(239,68,68,0.6), 0 0 12px rgba(239,68,68,0.3)`
          : selected
            ? `0 0 0 1px var(--accent-strong), 0 16px 32px ${hexToRgba(color, 0.28)}`
            : `inset 0 1px 0 rgba(255,255,255,0.12)`,
        opacity: isDimmed ? 0.3 : trimSide ? 0.88 : locked ? 0.55 : 1,
        cursor: locked ? 'not-allowed' : TRIM_CURSORS[trimMode].body,
        transition: 'opacity 100ms ease-out, border-color 120ms ease-out',
      }}
      title={`${clip.clip_id}\n${clip.motivation}\nSource ${formatMicroseconds(clip.src_in_us, fps)} → ${formatMicroseconds(clip.src_out_us, fps)}${clip.confidence != null ? `\nConfidence: ${(clip.confidence * 100).toFixed(0)}%` : ''}`}
      onPointerDown={(event) => {
        event.stopPropagation();
      }}
      onClick={(event) => {
        event.stopPropagation();
        if (locked) return;
        onSelect({
          shiftKey: event.shiftKey,
          metaKey: event.metaKey,
          ctrlKey: event.ctrlKey,
        });
      }}
    >
      {/* Left trim handle — 8px hit area */}
      {!locked && (
        <div
          className="absolute inset-y-0 left-0 z-10 transition-colors hover:bg-white/25"
          style={{ width: 8, cursor: TRIM_CURSORS[trimMode].edge }}
          onPointerDown={(event) => handleTrimPointerDown('start', event)}
        >
          {/* Ripple bracket indicator */}
          {trimMode === 'ripple' && (
            <div className="absolute inset-y-1 left-0 w-0.5 bg-yellow-400/60" />
          )}
          {/* Roll double-bracket indicator */}
          {trimMode === 'roll' && (
            <>
              <div className="absolute inset-y-1 left-0 w-0.5 bg-cyan-400/60" />
              <div className="absolute inset-y-1 left-1 w-0.5 bg-cyan-400/40" />
            </>
          )}
        </div>
      )}

      {/* Thumbnail background for video clips */}
      {showThumbnail && thumbUrl && !thumbError && (
        <img
          src={thumbUrl}
          alt=""
          className="absolute inset-0 h-full w-full object-cover opacity-40"
          onError={() => setThumbError(true)}
          draggable={false}
        />
      )}

      {/* Content row */}
      <div className="relative flex h-full flex-col justify-between px-2 py-1">
        {/* Top: label + badge + duration */}
        <div className="flex items-center justify-between gap-1">
          <div className="flex min-w-0 items-center gap-1.5">
            <div
              className="truncate font-semibold uppercase tracking-[0.22em] text-black/60"
              style={{ fontSize: clipFontSize(pxPerFrame) }}
            >
              {label}
            </div>
            {showBadge ? (
              <span
                className="inline-flex shrink-0 items-center justify-center rounded-full px-1.5 py-px text-[8px] font-bold leading-none"
                style={{ background: conf.bg, color: conf.text }}
              >
                {conf.label}
              </span>
            ) : null}
          </div>
          {showDuration ? (
            <div className="shrink-0 rounded bg-black/10 px-1.5 py-0.5 font-mono text-[10px] text-slate-950/55">
              {clip.timeline_duration_frames}f
            </div>
          ) : null}
        </div>

        {/* Middle: motivation text */}
        {showMotivation ? (
          <div className="truncate text-[11px] font-medium leading-tight text-slate-950/80">
            {clip.motivation}
          </div>
        ) : null}

        {/* Bottom: waveform canvas */}
        {showWaveform && waveform.data && (
          <canvas
            ref={waveformCanvasRef}
            className="pointer-events-none"
            style={{ width: width - 4, height: trackKind === 'audio' ? clipHeight - 16 : Math.min(24, clipHeight / 3) }}
          />
        )}
      </div>

      {/* Right trim handle — 8px hit area */}
      {!locked && (
        <div
          className="absolute inset-y-0 right-0 z-10 transition-colors hover:bg-white/25"
          style={{ width: 8, cursor: TRIM_CURSORS[trimMode].edge }}
          onPointerDown={(event) => handleTrimPointerDown('end', event)}
        >
          {trimMode === 'ripple' && (
            <div className="absolute inset-y-1 right-0 w-0.5 bg-yellow-400/60" />
          )}
          {trimMode === 'roll' && (
            <>
              <div className="absolute inset-y-1 right-0 w-0.5 bg-cyan-400/60" />
              <div className="absolute inset-y-1 right-1 w-0.5 bg-cyan-400/40" />
            </>
          )}
        </div>
      )}

      {/* J/L-cut link badge */}
      {linkGroupId && linkOffset != null && linkOffset !== 0 && width > 60 && (
        <div className="pointer-events-none absolute -bottom-0.5 left-1/2 -translate-x-1/2 rounded-sm bg-[#1e293b] px-1.5 py-px font-mono text-[8px] font-bold leading-tight text-[color:var(--text-muted)] shadow">
          {linkOffset > 0 ? `L +${linkOffset}f` : `J +${Math.abs(linkOffset)}f`}
        </div>
      )}

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

      {/* Review warning overlay — yellow dashed border */}
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

      {/* Patch operation overlay — color-coded per op type */}
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
              className="absolute -top-1.5 right-1 rounded-full px-1 text-[7px] font-bold uppercase leading-tight text-white"
              style={{ background: colors.border }}
            >
              {overlay.patchOps.length}P
            </span>
          </div>
        );
      })() : null}
    </div>
  );
});
