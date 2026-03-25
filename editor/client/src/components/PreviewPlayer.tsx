import type { RefObject } from 'react';

interface PreviewPlayerProps {
  videoRef: RefObject<HTMLVideoElement | null>;
  previewMode: 'source' | 'none';
  renderStatus: 'idle' | 'rendering' | 'ready' | 'error';
  isPlaying: boolean;
  isBuffering: boolean;
  isGap: boolean;
  error: string | null;
  onLoadedMetadata: () => void;
  onTimeUpdate: () => void;
  onWaiting: () => void;
  onPlaying: () => void;
  onStalled: () => void;
  onEnded: () => void;
  onVideoError: () => void;
}

export default function PreviewPlayer({
  videoRef,
  previewMode,
  renderStatus,
  isPlaying,
  isBuffering,
  isGap,
  error,
  onLoadedMetadata,
  onTimeUpdate,
  onWaiting,
  onPlaying,
  onStalled,
  onEnded,
  onVideoError,
}: PreviewPlayerProps) {
  const modeLabel = previewMode === 'source' ? 'Source' : 'No Source';

  return (
    <div className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden bg-black">
      {/* Video element — always mounted, src managed by usePlayback */}
      <video
        ref={videoRef}
        className={`h-full w-full bg-black object-contain ${isGap ? 'invisible' : ''}`}
        playsInline
        preload="auto"
        onLoadedMetadata={onLoadedMetadata}
        onTimeUpdate={onTimeUpdate}
        onWaiting={onWaiting}
        onPlaying={onPlaying}
        onStalled={onStalled}
        onEnded={onEnded}
        onError={onVideoError}
      />

      {/* Gap overlay — shown when playhead is between clips */}
      {isGap && previewMode === 'source' ? (
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
                Exporting…
              </div>
            </>
          ) : (
            <>
              <div className="font-mono text-[10px] uppercase tracking-[0.42em] text-[#64748b]">
                {modeLabel}
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

      {/* Buffering spinner */}
      {isBuffering && !isGap ? (
        <div className="absolute inset-0 flex items-center justify-center bg-black/40">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-white/20 border-t-white" />
        </div>
      ) : null}

      {/* Mode indicator */}
      <div className="pointer-events-none absolute top-2 left-2 flex items-center gap-1.5 bg-black/50 px-2 py-0.5 font-mono text-[9px] uppercase tracking-[0.2em] text-[#cbd5e1]">
        <span
          className={`h-1.5 w-1.5 rounded-full ${
            isPlaying ? 'bg-emerald-400' : 'bg-slate-500'
          }`}
        />
        {modeLabel}
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
