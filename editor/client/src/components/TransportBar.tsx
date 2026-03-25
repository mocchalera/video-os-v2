interface TransportBarProps {
  isPlaying: boolean;
  timecode: string;
  currentFrame: number;
  previewMode: 'source' | 'none';
  renderStatus: 'idle' | 'rendering' | 'ready' | 'error';
  previewStale: boolean;
  onTogglePlayback: () => void;
  onExportRender: () => void;
}

function chromeLabel(previewMode: 'source' | 'none'): string {
  return previewMode === 'source' ? 'Source' : 'Offline';
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
    <div className="flex shrink-0 items-center gap-3 border-t border-white/[0.06] px-3 py-1.5">
      <button
        type="button"
        className="flex h-6 w-6 items-center justify-center bg-white/[0.06] text-[11px] text-white transition hover:bg-white/[0.12]"
        onClick={onTogglePlayback}
        title={isPlaying ? 'Stop (Space)' : 'Play (Space)'}
      >
        {isPlaying ? '\u25A0' : '\u25B6'}
      </button>

      <span className="font-mono text-[15px] font-semibold tabular-nums tracking-[0.06em] text-white">
        {timecode}
      </span>

      <span className="font-mono text-[10px] tabular-nums text-[color:var(--text-muted)]">
        {currentFrame}f
      </span>

      <div className="flex-1" />

      <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-[color:var(--text-subtle)]">
        {chromeLabel(previewMode)}
      </span>
      <span
        className={`font-mono text-[10px] uppercase tracking-[0.18em] ${previewStale ? 'text-[color:var(--warning)]' : 'text-[color:var(--text-subtle)]'}`}
      >
        {renderStatus === 'rendering'
          ? 'exporting\u2026'
          : previewStale
            ? 'stale'
            : renderStatus}
      </span>

      <button
        type="button"
        className={`border px-2.5 py-1 text-[11px] font-medium transition hover:bg-white/[0.06] ${
          previewStale
            ? 'border-[color:var(--warning)]/30 text-[color:var(--warning)]'
            : 'border-white/[0.06] text-neutral-200'
        }`}
        onClick={onExportRender}
        disabled={renderStatus === 'rendering'}
        title="Export full render (Ctrl+Enter)"
      >
        Export Render
      </button>
    </div>
  );
}
