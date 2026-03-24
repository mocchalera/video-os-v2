interface TransportBarProps {
  isPlaying: boolean;
  timecode: string;
  currentFrame: number;
  previewMode: 'none' | 'api' | 'mock';
  renderStatus: 'idle' | 'rendering' | 'ready' | 'error';
  onTogglePlayback: () => void;
  onRenderPreview: () => void;
}

function chromeLabel(previewMode: 'none' | 'api' | 'mock'): string {
  if (previewMode === 'api') {
    return 'Backend';
  }

  if (previewMode === 'mock') {
    return 'Local';
  }

  return 'Detached';
}

export default function TransportBar({
  isPlaying,
  timecode,
  currentFrame,
  previewMode,
  renderStatus,
  onTogglePlayback,
  onRenderPreview,
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
      <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-[color:var(--text-subtle)]">
        {renderStatus}
      </span>

      <button
        type="button"
        className="border border-white/[0.06] bg-transparent px-2.5 py-1 text-[11px] font-medium text-neutral-200 transition hover:bg-white/[0.06]"
        onClick={onRenderPreview}
        title="Render Preview (Ctrl+Enter)"
      >
        Render
      </button>
    </div>
  );
}
