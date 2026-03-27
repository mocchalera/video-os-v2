import type { TrimMode, TrimTarget } from '../types';

interface TrimPreviewOverlayProps {
  trimMode: TrimMode;
  activeTrimTarget: TrimTarget | null;
  isDragging: boolean;
  trimDelta: number;
  currentFrame: number;
  snapTargetLabel?: string | null;
}

export default function TrimPreviewOverlay({
  trimMode,
  activeTrimTarget,
  isDragging,
  trimDelta,
  currentFrame,
  snapTargetLabel,
}: TrimPreviewOverlayProps) {
  if (!activeTrimTarget || !isDragging) return null;

  const deltaSign = trimDelta >= 0 ? '+' : '';
  const deltaLabel = `${deltaSign}${trimDelta}f`;

  return (
    <div className="pointer-events-none absolute inset-0 z-50 flex items-center justify-center">
      {/* Trim info overlay */}
      <div className="flex flex-col items-center gap-2">
        {/* Mode-specific preview layout */}
        {(trimMode === 'ripple' || trimMode === 'roll') && (
          <div className="flex items-center gap-4">
            {/* Outgoing frame indicator */}
            <div className="flex flex-col items-center">
              <div className="h-16 w-24 rounded border border-white/20 bg-black/60 flex items-center justify-center">
                <span className="text-[10px] font-medium text-[color:var(--text-muted)]">OUT</span>
              </div>
            </div>
            {/* Delta display */}
            <div className="flex flex-col items-center gap-1">
              <span className={`font-mono text-lg font-bold ${
                trimDelta === 0
                  ? 'text-[color:var(--text-muted)]'
                  : trimDelta > 0
                    ? 'text-green-400'
                    : 'text-red-400'
              }`}>
                {deltaLabel}
              </span>
              <span className="text-[9px] font-medium uppercase tracking-wider text-[color:var(--text-subtle)]">
                {trimMode}
              </span>
            </div>
            {/* Incoming frame indicator */}
            <div className="flex flex-col items-center">
              <div className="h-16 w-24 rounded border border-white/20 bg-black/60 flex items-center justify-center">
                <span className="text-[10px] font-medium text-[color:var(--text-muted)]">IN</span>
              </div>
            </div>
          </div>
        )}

        {trimMode === 'slip' && (
          <div className="flex flex-col items-center gap-2">
            <div className="flex items-center gap-3">
              <span className="text-[10px] font-medium text-[color:var(--text-muted)]">SRC</span>
              <span className={`font-mono text-lg font-bold ${
                trimDelta === 0
                  ? 'text-[color:var(--text-muted)]'
                  : 'text-amber-400'
              }`}>
                {deltaLabel}
              </span>
            </div>
            <span className="text-[9px] font-medium uppercase tracking-wider text-[color:var(--text-subtle)]">
              slip
            </span>
          </div>
        )}

        {trimMode === 'slide' && (
          <div className="flex items-center gap-3">
            {/* 3-face preview placeholders */}
            <div className="h-12 w-16 rounded border border-white/20 bg-black/60 flex items-center justify-center">
              <span className="text-[8px] text-[color:var(--text-subtle)]">PREV</span>
            </div>
            <div className="flex flex-col items-center gap-1">
              <div className="h-14 w-20 rounded border border-[var(--accent)]/40 bg-black/60 flex items-center justify-center">
                <span className={`font-mono text-base font-bold ${
                  trimDelta === 0
                    ? 'text-[color:var(--text-muted)]'
                    : 'text-[var(--accent)]'
                }`}>
                  {deltaLabel}
                </span>
              </div>
              <span className="text-[9px] font-medium uppercase tracking-wider text-[color:var(--text-subtle)]">
                slide
              </span>
            </div>
            <div className="h-12 w-16 rounded border border-white/20 bg-black/60 flex items-center justify-center">
              <span className="text-[8px] text-[color:var(--text-subtle)]">NEXT</span>
            </div>
          </div>
        )}

        {trimMode === 'selection' && (
          <div className="flex flex-col items-center gap-1">
            <span className={`font-mono text-lg font-bold ${
              trimDelta === 0
                ? 'text-[color:var(--text-muted)]'
                : trimDelta > 0
                  ? 'text-green-400'
                  : 'text-red-400'
            }`}>
              {deltaLabel}
            </span>
            <span className="text-[9px] font-medium uppercase tracking-wider text-[color:var(--text-subtle)]">
              trim
            </span>
          </div>
        )}

        {/* Bottom info bar */}
        <div className="flex items-center gap-3 rounded bg-black/70 px-3 py-1">
          <span className="font-mono text-[10px] text-[color:var(--text-muted)]">
            F{currentFrame}
          </span>
          {snapTargetLabel && (
            <span className="text-[9px] font-medium text-[var(--accent)]">
              snap: {snapTargetLabel}
            </span>
          )}
          <span className="text-[9px] text-[color:var(--text-subtle)]">
            {activeTrimTarget.side === 'head' ? 'HEAD' : 'TAIL'}
          </span>
        </div>
      </div>
    </div>
  );
}
