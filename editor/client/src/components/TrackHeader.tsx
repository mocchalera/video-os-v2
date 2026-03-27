import type { TrackHeaderState, TrackHeight, EditorLane } from '../types';
import { TRACK_HEIGHT_PX } from '../types';

interface TrackHeaderProps {
  lane: EditorLane;
  state: TrackHeaderState;
  onToggleLock: () => void;
  onToggleMute: () => void;
  onToggleSolo: () => void;
  onToggleSyncLock: () => void;
  onCycleHeight: () => void;
}

const HEIGHT_LABELS: Record<TrackHeight, string> = { S: 'S', M: 'M', L: 'L' };

function IconButton({
  active,
  label,
  title,
  activeColor,
  onClick,
}: {
  active: boolean;
  label: string;
  title: string;
  activeColor: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      title={title}
      className="flex h-[18px] w-[18px] items-center justify-center rounded-sm text-[9px] font-bold uppercase leading-none transition-colors"
      style={{
        background: active ? activeColor : 'rgba(148, 163, 184, 0.08)',
        color: active ? '#fff' : 'rgba(148, 163, 184, 0.5)',
      }}
      onClick={(e) => { e.stopPropagation(); onClick(); }}
    >
      {label}
    </button>
  );
}

export default function TrackHeader({
  lane,
  state,
  onToggleLock,
  onToggleMute,
  onToggleSolo,
  onToggleSyncLock,
  onCycleHeight,
}: TrackHeaderProps) {
  const heightPx = TRACK_HEIGHT_PX[state.height];
  const isCompact = state.height === 'S';

  return (
    <div
      className="flex items-center border-t border-white/[0.05] px-2"
      style={{
        height: heightPx,
        opacity: state.muted ? 0.5 : 1,
      }}
    >
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        {/* Track label + kind */}
        <div className="flex items-center gap-1.5">
          <span
            className={`h-2 w-2 shrink-0 rounded-full ${
              lane.trackKind === 'video' ? 'bg-sky-400/80' : 'bg-emerald-400/80'
            }`}
          />
          <span className="font-mono text-[11px] font-semibold uppercase tracking-[0.24em] text-neutral-100">
            {lane.label}
          </span>
          {!isCompact && (
            <span className="text-[9px] uppercase tracking-[0.16em] text-[color:var(--text-subtle)]">
              {lane.trackKind === 'video' ? 'Pic' : 'Aud'}
            </span>
          )}
        </div>

        {/* Controls row */}
        <div className="flex items-center gap-0.5">
          <IconButton
            active={state.locked}
            label="L"
            title="Lock track"
            activeColor="#dc2626"
            onClick={onToggleLock}
          />
          <IconButton
            active={state.muted}
            label="M"
            title="Mute track"
            activeColor="#6b7280"
            onClick={onToggleMute}
          />
          <IconButton
            active={state.solo}
            label="S"
            title="Solo track"
            activeColor="#eab308"
            onClick={onToggleSolo}
          />
          {!isCompact && (
            <IconButton
              active={state.syncLock}
              label="⚡"
              title="Sync lock"
              activeColor="#3b82f6"
              onClick={onToggleSyncLock}
            />
          )}
          <button
            type="button"
            title={`Track height: ${state.height} (click to cycle)`}
            className="ml-auto flex h-[18px] items-center justify-center rounded-sm bg-white/[0.06] px-1.5 text-[8px] font-bold uppercase tracking-wider text-[color:var(--text-subtle)] transition-colors hover:bg-white/[0.12] hover:text-neutral-300"
            onClick={(e) => { e.stopPropagation(); onCycleHeight(); }}
          >
            {HEIGHT_LABELS[state.height]}
          </button>
        </div>
      </div>
    </div>
  );
}
