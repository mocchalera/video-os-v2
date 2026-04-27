import type { RefObject } from 'react';
import type { PreviewMode } from '../types';

interface PreviewPlayerProps {
  videoRef: RefObject<HTMLVideoElement | null>;
  exactVideoRef: RefObject<HTMLVideoElement | null>;
  previewMode: PreviewMode;
  previewUrl: string | null;
  renderStatus: 'idle' | 'rendering' | 'ready' | 'error';
  isPlaying: boolean;
  isBuffering: boolean;
  isGap: boolean;
  error: string | null;
  previewStale: boolean;
  /** Phase 2: Current clip zoom for CSS approximation in source_approx mode. */
  clipZoom: number;
  onLoadedMetadata: () => void;
  onCanPlayThrough: () => void;
  onTimeUpdate: () => void;
  onWaiting: () => void;
  onPlaying: () => void;
  onStalled: () => void;
  onEnded: () => void;
  onVideoError: () => void;
  // Exact video handlers (FATAL 1)
  onExactTimeUpdate: () => void;
  onExactLoadedMetadata: () => void;
  onExactEnded: () => void;
  onExactError: () => void;
}

function modeLabel(mode: PreviewMode): string {
  switch (mode) {
    case 'rendered_exact':
      return 'Exact';
    case 'source_approx':
      return 'Source';
    case 'none':
      return 'No Source';
  }
}

function modeDotColor(mode: PreviewMode, isPlaying: boolean): string {
  if (!isPlaying) return 'bg-slate-500';
  switch (mode) {
    case 'rendered_exact':
      return 'bg-blue-400';
    case 'source_approx':
      return 'bg-emerald-400';
    case 'none':
      return 'bg-slate-500';
  }
}

export default function PreviewPlayer({
  videoRef,
  exactVideoRef,
  previewMode,
  previewUrl,
  renderStatus,
  isPlaying,
  isBuffering,
  isGap,
  error,
  previewStale,
  clipZoom,
  onLoadedMetadata,
  onCanPlayThrough,
  onTimeUpdate,
  onWaiting,
  onPlaying,
  onStalled,
  onEnded,
  onVideoError,
  onExactTimeUpdate,
  onExactLoadedMetadata,
  onExactEnded,
  onExactError,
}: PreviewPlayerProps) {
  const isExact = previewMode === 'rendered_exact';
  const isSource = previewMode === 'source_approx';

  return (
    <div className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden bg-black">
      {/* Source video element — always mounted, src managed by usePlayback */}
      {/* Phase 2: CSS zoom approximation in source_approx mode (Section 6.3).
          Exact parity is guaranteed only by rendered_exact; this is a visual hint.
          When zoom > 1, use object-cover inside overflow:hidden so only the video
          content is scaled — not the letterbox/pillarbox black bars. */}
      {isSource && clipZoom > 1 ? (
        <div
          className={`flex h-full w-full items-center justify-center overflow-hidden ${
            isExact || isGap ? 'invisible' : ''
          }`}
        >
          <video
            ref={videoRef}
            className="h-full w-full bg-black object-cover"
            style={{ transform: `scale(${clipZoom})`, transformOrigin: 'center center' }}
            playsInline
            preload="auto"
            onLoadedMetadata={onLoadedMetadata}
            onCanPlayThrough={onCanPlayThrough}
            onTimeUpdate={onTimeUpdate}
            onWaiting={onWaiting}
            onPlaying={onPlaying}
            onStalled={onStalled}
            onEnded={onEnded}
            onError={onVideoError}
          />
        </div>
      ) : (
        <video
          ref={videoRef}
          className={`h-full w-full bg-black object-contain ${
            isExact || isGap ? 'invisible' : ''
          }`}
          playsInline
          preload="auto"
          onLoadedMetadata={onLoadedMetadata}
          onCanPlayThrough={onCanPlayThrough}
          onTimeUpdate={onTimeUpdate}
          onWaiting={onWaiting}
          onPlaying={onPlaying}
          onStalled={onStalled}
          onEnded={onEnded}
          onError={onVideoError}
        />
      )}

      {/* Exact preview video element — visible only in rendered_exact mode */}
      {isExact && previewUrl ? (
        <video
          ref={exactVideoRef}
          className="h-full w-full bg-black object-contain"
          src={previewUrl}
          playsInline
          preload="auto"
          onTimeUpdate={onExactTimeUpdate}
          onLoadedMetadata={onExactLoadedMetadata}
          onEnded={onExactEnded}
          onError={onExactError}
        />
      ) : null}

      {/* Gap overlay — shown when playhead is between clips (source mode only) */}
      {isGap && isSource ? (
        <div className="absolute inset-0 flex items-center justify-center bg-black">
          <div className="font-mono text-[10px] uppercase tracking-[0.42em] text-[#3a3f4a]">
            No clip
          </div>
        </div>
      ) : null}

      {/* No source map — fallback state */}
      {previewMode === 'none' ? (
        <div className="absolute inset-0 flex flex-col items-center justify-center bg-[#04070d] px-6 text-center">
          {renderStatus === 'rendering' ? (
            <>
              <div className="flex justify-center">
                <div className="h-8 w-8 animate-spin rounded-full border-2 border-white/20 border-t-white" />
              </div>
              <div className="mt-3 text-[22px] font-semibold tracking-tight text-white">
                Rendering Preview&hellip;
              </div>
            </>
          ) : (
            <>
              <div className="font-mono text-[10px] uppercase tracking-[0.42em] text-[#64748b]">
                {modeLabel(previewMode)}
              </div>
              <div className="mt-3 text-[22px] font-semibold tracking-tight text-white">
                Preview
              </div>
              <div className="mx-auto mt-2 max-w-[360px] text-[13px] leading-6 text-[#94a3b8]">
                Space toggles playback. Source map not loaded — check project
                media.
              </div>
            </>
          )}
        </div>
      ) : null}

      {/* Rendering overlay — shown during preview generation in source mode */}
      {renderStatus === 'rendering' && previewMode !== 'none' ? (
        <div className="absolute top-2 right-2 flex items-center gap-1.5 bg-black/60 px-2 py-1 font-mono text-[9px] uppercase tracking-[0.18em] text-amber-300">
          <div className="h-2.5 w-2.5 animate-spin rounded-full border border-amber-300/30 border-t-amber-300" />
          rendering
        </div>
      ) : null}

      {/* Buffering spinner */}
      {isBuffering && !isGap ? (
        <div className="absolute inset-0 flex items-center justify-center bg-black/40">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-white/20 border-t-white" />
        </div>
      ) : null}

      {/* Mode indicator */}
      <div className="pointer-events-none absolute top-2 left-2 flex items-center gap-1.5 bg-black/50 px-2 py-0.5 font-mono text-[9px] uppercase tracking-[0.2em] text-[#cbd5e1]">
        <span
          className={`h-1.5 w-1.5 rounded-full ${modeDotColor(previewMode, isPlaying)}`}
        />
        {modeLabel(previewMode)}
        {previewStale && previewMode === 'source_approx' ? (
          <span className="ml-1 text-[color:var(--warning)]">stale</span>
        ) : null}
      </div>

      {/* Error bar */}
      {error ? (
        <div className="absolute inset-x-0 bottom-0 border-t border-amber-400/20 bg-amber-950/80 px-3 py-1.5 text-[11px] text-amber-300">
          {error}
        </div>
      ) : null}
    </div>
  );
}
