interface TransportBarProps {
  isPlaying: boolean;
  timecode: string;
  currentFrame: number;
  previewMode: 'none' | 'api' | 'mock';
  renderStatus: 'idle' | 'rendering' | 'ready' | 'error';
  onTogglePlayback: () => void;
  onRenderPreview: () => void;
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
    <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-white/10 bg-[rgba(10,16,30,0.82)] px-4 py-3">
      <div className="flex items-center gap-3">
        <button
          type="button"
          className="rounded-xl bg-[#57a4ff] px-4 py-2 text-sm font-semibold text-slate-950 transition hover:brightness-110"
          onClick={onTogglePlayback}
        >
          {isPlaying ? 'Stop' : 'Play'}
        </button>

        <button
          type="button"
          className="rounded-xl border border-white/10 bg-white/5 px-4 py-2 text-sm font-medium text-slate-100 transition hover:bg-white/10"
          onClick={onRenderPreview}
        >
          Render Preview
        </button>
      </div>

      <div className="flex items-center gap-4 text-right">
        <div>
          <div className="font-mono text-lg font-semibold text-slate-50">{timecode}</div>
          <div className="font-mono text-[11px] uppercase tracking-[0.18em] text-slate-500">
            frame {currentFrame}
          </div>
        </div>

        <div className="text-xs text-slate-400">
          <div>{previewMode === 'api' ? 'Backend preview linked' : 'Local transport mode'}</div>
          <div className="font-mono uppercase tracking-[0.18em] text-slate-500">
            {renderStatus}
          </div>
        </div>
      </div>
    </div>
  );
}
