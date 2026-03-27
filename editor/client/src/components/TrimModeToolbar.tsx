import type { TrimMode } from '../types';

interface TrimModeToolbarProps {
  trimMode: TrimMode;
  onSetTrimMode: (mode: TrimMode) => void;
}

const MODES: { mode: TrimMode; label: string; shortcut: string; description: string }[] = [
  { mode: 'selection', label: 'Select', shortcut: 'A', description: 'Selection tool — basic trim' },
  { mode: 'ripple', label: 'Ripple', shortcut: 'B', description: 'Ripple trim — shift downstream clips' },
  { mode: 'roll', label: 'Roll', shortcut: 'N', description: 'Roll trim — move cut point between adjacent clips' },
  { mode: 'slip', label: 'Slip', shortcut: 'Y', description: 'Slip — slide source in/out within clip duration' },
  { mode: 'slide', label: 'Slide', shortcut: 'U', description: 'Slide — move clip and compensate neighbors' },
];

export default function TrimModeToolbar({
  trimMode,
  onSetTrimMode,
}: TrimModeToolbarProps) {
  return (
    <div className="flex shrink-0 items-center gap-0.5 border-b border-white/[0.06] bg-[#0d1219] px-3 py-1">
      <span className="mr-2 text-[10px] font-medium uppercase tracking-[0.2em] text-[color:var(--text-subtle)]">
        Trim
      </span>
      {MODES.map(({ mode, label, shortcut, description }) => {
        const active = trimMode === mode;
        return (
          <button
            key={mode}
            type="button"
            title={description}
            className={`flex items-center gap-1.5 rounded px-2 py-1 text-[11px] font-medium transition-colors ${
              active
                ? 'bg-[var(--accent)]/20 text-[var(--accent)]'
                : 'text-[color:var(--text-muted)] hover:bg-white/[0.04] hover:text-[color:var(--text-main)]'
            }`}
            onClick={() => onSetTrimMode(mode)}
          >
            {label}
            <kbd
              className={`rounded px-1 py-px font-mono text-[9px] leading-none ${
                active
                  ? 'bg-[var(--accent)]/10 text-[var(--accent)]/80'
                  : 'bg-white/[0.06] text-[color:var(--text-subtle)]'
              }`}
            >
              {shortcut}
            </kbd>
          </button>
        );
      })}
    </div>
  );
}
