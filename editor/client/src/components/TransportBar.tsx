import type { PreviewMode } from '../types';

interface TransportBarProps {
  isPlaying: boolean;
  timecode: string;
  currentFrame: number;
  previewMode: PreviewMode;
  renderStatus: 'idle' | 'rendering' | 'ready' | 'error';
  previewStale: boolean;
  onTogglePlayback: () => void;
  onExportRender: () => void;
}

function chromeLabel(previewMode: PreviewMode): string {
  switch (previewMode) {
    case 'rendered_exact':
      return 'Exact';
    case 'source_approx':
      return 'Source';
    case 'none':
      return 'Offline';
  }
}

export default function TransportBar({
  isPlaying,
  timecode,
  currentFrame,
  previewMode,
  renderStatus,
  previewStale,
  onTogglePlayback,
  onExportRender,
}: TransportBarProps) {
  return (
    <div className="flex min-w-0 shrink-0 items-center gap-2 overflow-hidden border-t border-white/[0.06] px-3 py-1.5">
      <button
        type="button"
        className="flex h-6 w-6 items-center justify-center bg-white/[0.06] text-[11px] text-white transition hover:bg-white/[0.12]"
        onClick={onTogglePlayback}
        title={isPlaying ? 'Stop (Space)' : 'Play (Space)'}
        aria-label={isPlaying ? 'Program monitor stop' : 'Program monitor play'}
      >
        {isPlaying ? '\u25A0' : '\u25B6'}
      </button>

      <span className="shrink-0 font-mono text-[15px] font-semibold tabular-nums tracking-[0.06em] text-white">
        {timecode}
      </span>

      <span className="shrink-0 font-mono text-[10px] tabular-nums text-[color:var(--text-muted)]">
        {currentFrame}f
      </span>

      <div className="min-w-0 flex-1" />

      <div className="hidden shrink-0 items-center gap-2 min-[560px]:flex">
        <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-[color:var(--text-subtle)]">
          {chromeLabel(previewMode)}
        </span>
        <span
          className={`font-mono text-[10px] uppercase tracking-[0.18em] ${previewStale ? 'text-[color:var(--warning)]' : 'text-[color:var(--text-subtle)]'}`}
        >
          {renderStatus === 'rendering'
            ? 'rendering\u2026'
            : previewStale
              ? 'stale'
              : renderStatus}
        </span>
      </div>

      <button
        type="button"
        className={`shrink-0 whitespace-nowrap border px-2.5 py-1 text-[11px] font-medium transition hover:bg-white/[0.06] ${
          previewStale
            ? 'border-[color:var(--warning)]/30 text-[color:var(--warning)]'
            : 'border-white/[0.06] text-neutral-200'
        }`}
        onClick={onExportRender}
        disabled={renderStatus === 'rendering'}
        title="Export full render (Ctrl+Enter)"
        aria-label="Export render preview"
      >
        Export Render
      </button>
    </div>
  );
}
