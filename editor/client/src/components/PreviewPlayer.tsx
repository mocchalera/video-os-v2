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
    <div className="rounded-2xl border border-white/10 bg-[color:var(--panel-bg)] p-4 shadow-[0_18px_60px_rgba(0,0,0,0.25)]">
      <div className="relative overflow-hidden rounded-2xl border border-white/10 bg-[linear-gradient(180deg,rgba(19,28,50,1),rgba(9,14,26,1))]">
        <div className="aspect-video w-full">
          {previewUrl ? (
            <video
              ref={videoRef}
              src={previewUrl}
              className="h-full w-full object-contain"
              playsInline
              onTimeUpdate={onTimeUpdate}
              onLoadedMetadata={onLoadedMetadata}
              onEnded={onEnded}
            />
          ) : (
            <div className="flex h-full w-full items-center justify-center bg-[radial-gradient(circle_at_center,rgba(87,164,255,0.18),transparent_45%),linear-gradient(180deg,rgba(8,14,28,0.96),rgba(4,8,18,0.98))]">
              <div className="text-center">
                <div className="font-mono text-xs uppercase tracking-[0.26em] text-slate-500">
                  {modeLabel}
                </div>
                <div className="mt-3 text-lg font-medium text-slate-100">
                  {previewMode === 'mock'
                    ? 'Virtual playback is active while the preview API is unavailable.'
                    : 'Render preview to attach backend video playback.'}
                </div>
                <div className="mt-2 text-sm text-slate-400">
                  Space toggles transport. Ctrl+Enter renders the current clip or 5s range.
                </div>
              </div>
            </div>
          )}
        </div>

        <div className="pointer-events-none absolute top-3 left-3 flex items-center gap-2 rounded-full border border-white/10 bg-slate-950/60 px-3 py-1 font-mono text-[11px] uppercase tracking-[0.18em] text-slate-200">
          <span
            className={`h-2 w-2 rounded-full ${
              isPlaying ? 'bg-emerald-400' : 'bg-slate-500'
            }`}
          />
          {modeLabel}
        </div>

        <div className="pointer-events-none absolute top-3 right-3 rounded-full border border-white/10 bg-slate-950/60 px-3 py-1 font-mono text-[11px] uppercase tracking-[0.18em] text-slate-300">
          {renderStatus}
        </div>
      </div>

      {error ? <p className="mt-3 text-sm text-amber-300">{error}</p> : null}
    </div>
  );
}
