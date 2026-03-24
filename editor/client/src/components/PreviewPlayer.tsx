import type { RefObject } from 'react';

interface PreviewPlayerProps {
  videoRef: RefObject<HTMLVideoElement | null>;
  previewUrl: string | null;
  previewMode: 'none' | 'api' | 'mock';
  renderStatus: 'idle' | 'rendering' | 'ready' | 'error';
  isPlaying: boolean;
  error: string | null;
  onTimeUpdate: () => void;
  onLoadedMetadata: () => void;
  onEnded: () => void;
}

export default function PreviewPlayer({
  videoRef,
  previewUrl,
  previewMode,
  renderStatus,
  isPlaying,
  error,
  onTimeUpdate,
  onLoadedMetadata,
  onEnded,
}: PreviewPlayerProps) {
  const modeLabel =
    previewMode === 'api'
      ? 'API Preview'
      : previewMode === 'mock'
        ? 'Mock Transport'
        : 'No Preview';

  return (
    <div className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden bg-[#04070d]">
      {previewUrl ? (
        <video
          ref={videoRef}
          src={previewUrl}
          className="h-full w-full bg-black object-contain"
          playsInline
          onTimeUpdate={onTimeUpdate}
          onLoadedMetadata={onLoadedMetadata}
          onEnded={onEnded}
        />
      ) : (
        <div className="px-6 text-center">
          <div className="font-mono text-[10px] uppercase tracking-[0.42em] text-[#64748b]">
            {modeLabel}
          </div>
          <div className="mt-3 text-[22px] font-semibold tracking-tight text-white">
            Render preview to attach playback
          </div>
          <div className="mx-auto mt-2 max-w-[360px] text-[13px] leading-6 text-[#94a3b8]">
            Space toggles transport. Ctrl+Enter renders the selected clip or a 5 second
            range from the playhead.
          </div>
        </div>
      )}

      <div className="pointer-events-none absolute top-2 left-2 flex items-center gap-1.5 bg-black/50 px-2 py-0.5 font-mono text-[9px] uppercase tracking-[0.2em] text-[#cbd5e1]">
        <span
          className={`h-1.5 w-1.5 rounded-full ${
            isPlaying ? 'bg-emerald-400' : 'bg-slate-500'
          }`}
        />
        {modeLabel}
      </div>

      {error ? (
        <div className="absolute inset-x-0 bottom-0 border-t border-amber-400/20 bg-amber-950/80 px-3 py-1.5 text-[11px] text-amber-300">
          {error}
        </div>
      ) : null}
    </div>
  );
}
