import { useState } from 'react';
import type { ClipDiff, DiffChangeType } from '../hooks/useDiff';

type DiffMode = 'session' | 'remote';

interface DiffPanelProps {
  diffs: ClipDiff[];
  baselineRevision: string | null;
  remoteDiffs?: ClipDiff[] | null;
  remoteRevision?: string | null;
  /** Jump to a clip on the timeline (select + scroll) */
  onJumpToClip?: (clipId: string) => void;
}

const CHANGE_STYLES: Record<
  DiffChangeType,
  { bg: string; border: string; label: string }
> = {
  trimmed: { bg: 'rgba(245,158,11,0.08)', border: '#f59e0b', label: 'Trimmed' },
  swapped: { bg: 'rgba(6,182,212,0.08)', border: '#06b6d4', label: 'Swapped' },
  audio_adjusted: { bg: 'rgba(59,130,246,0.08)', border: '#3b82f6', label: 'Audio' },
  moved: { bg: 'rgba(168,85,247,0.08)', border: '#a855f7', label: 'Moved' },
  added: { bg: 'rgba(34,197,94,0.08)', border: '#22c55e', label: 'Added' },
  removed: { bg: 'rgba(239,68,68,0.08)', border: '#ef4444', label: 'Removed' },
  patch_apply: { bg: 'rgba(217,70,239,0.08)', border: '#d946ef', label: 'Patch' },
};

export default function DiffPanel({ diffs, baselineRevision, remoteDiffs, remoteRevision, onJumpToClip }: DiffPanelProps) {
  const hasRemote = remoteDiffs != null;
  const [mode, setMode] = useState<DiffMode>(hasRemote ? 'remote' : 'session');

  const activeDiffs = mode === 'remote' && remoteDiffs ? remoteDiffs : diffs;
  const activeRevision = mode === 'remote' && remoteRevision ? remoteRevision : baselineRevision;

  if (!baselineRevision && !hasRemote) {
    return (
      <div className="flex h-full items-center justify-center px-5 py-8">
        <div className="text-center">
          <div className="font-mono text-[10px] uppercase tracking-[0.24em] text-[color:var(--text-subtle)]">
            Diff
          </div>
          <p className="mt-2 text-[12px] text-[color:var(--text-muted)]">
            No baseline available for comparison.
          </p>
        </div>
      </div>
    );
  }

  if (activeDiffs.length === 0) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        {hasRemote && (
          <DiffModeToggle mode={mode} onModeChange={setMode} sessionCount={diffs.length} remoteCount={remoteDiffs?.length ?? 0} />
        )}
        <div className="flex flex-1 items-center justify-center px-5 py-8">
          <div className="text-center">
            <div className="font-mono text-[10px] uppercase tracking-[0.24em] text-[color:var(--text-subtle)]">
              No Changes
            </div>
            <p className="mt-2 text-[12px] text-[color:var(--text-muted)]">
              {mode === 'remote' ? 'Local matches remote.' : 'Timeline matches the session baseline.'}
            </p>
            {activeRevision && (
              <p className="mt-1 font-mono text-[9px] text-[color:var(--text-subtle)]">
                vs {activeRevision.slice(0, 20)}...
              </p>
            )}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {hasRemote && (
        <DiffModeToggle mode={mode} onModeChange={setMode} sessionCount={diffs.length} remoteCount={remoteDiffs?.length ?? 0} />
      )}
      <div className="flex shrink-0 items-center justify-between border-b border-white/[0.06] px-4 py-2">
        <div className="font-mono text-[10px] uppercase tracking-[0.24em] text-[color:var(--text-subtle)]">
          {mode === 'remote' ? 'Local vs Remote' : 'Changes'} ({activeDiffs.length})
        </div>
        <div className="font-mono text-[9px] text-[color:var(--text-subtle)]">
          vs {activeRevision?.slice(0, 16) ?? '—'}
        </div>
      </div>

      <div className="editor-scrollbar min-h-0 flex-1 overflow-y-auto">
        {activeDiffs.map((diff) => {
          const primary = diff.changes[0];
          const style = CHANGE_STYLES[primary] ?? CHANGE_STYLES.trimmed;

          return (
            <div
              key={diff.clip_id}
              className="border-b border-white/[0.04] px-4 py-3"
              style={{
                borderLeftWidth: 3,
                borderLeftColor: style.border,
                background: style.bg,
              }}
            >
              <div className="flex items-center gap-2">
                {onJumpToClip ? (
                  <button
                    type="button"
                    className="font-mono text-[10px] text-neutral-200 underline decoration-white/20 underline-offset-2 transition hover:text-[var(--accent)]"
                    onClick={() => onJumpToClip(diff.clip_id)}
                    title="Jump to clip on timeline"
                  >
                    {diff.clip_id}
                  </button>
                ) : (
                  <span className="font-mono text-[10px] text-neutral-200">
                    {diff.clip_id}
                  </span>
                )}
                {diff.changes.map((change) => {
                  const s = CHANGE_STYLES[change];
                  return (
                    <span
                      key={change}
                      className="rounded-sm px-1.5 py-px font-mono text-[8px] font-bold uppercase"
                      style={{ background: s.border, color: '#000' }}
                    >
                      {s.label}
                    </span>
                  );
                })}
              </div>

              {/* Show delta details for trimmed/moved */}
              {diff.baselineClip && diff.currentClip ? (
                <div className="mt-2 space-y-1 font-mono text-[10px] text-[color:var(--text-subtle)]">
                  {diff.changes.includes('swapped') ? (
                    <div>
                      seg: {diff.baselineClip.segment_id} → {diff.currentClip.segment_id}
                    </div>
                  ) : null}
                  {diff.changes.includes('trimmed') ? (
                    <>
                      {diff.baselineClip.src_in_us !== diff.currentClip.src_in_us ? (
                        <div>
                          in: {(diff.baselineClip.src_in_us / 1e6).toFixed(2)}s →{' '}
                          {(diff.currentClip.src_in_us / 1e6).toFixed(2)}s
                        </div>
                      ) : null}
                      {diff.baselineClip.src_out_us !== diff.currentClip.src_out_us ? (
                        <div>
                          out: {(diff.baselineClip.src_out_us / 1e6).toFixed(2)}s →{' '}
                          {(diff.currentClip.src_out_us / 1e6).toFixed(2)}s
                        </div>
                      ) : null}
                    </>
                  ) : null}
                  {diff.changes.includes('moved') ? (
                    <div>
                      frame: {diff.baselineClip.timeline_in_frame} →{' '}
                      {diff.currentClip.timeline_in_frame}
                    </div>
                  ) : null}
                </div>
              ) : null}

              {/* Removed clip info */}
              {diff.changes.includes('removed') && diff.baselineClip ? (
                <div className="mt-1 font-mono text-[10px] text-red-400">
                  removed: {diff.baselineClip.segment_id} ({diff.baselineClip.role})
                </div>
              ) : null}

              {/* Added clip info */}
              {diff.changes.includes('added') && diff.currentClip ? (
                <div className="mt-1 font-mono text-[10px] text-green-400">
                  added: {diff.currentClip.segment_id} ({diff.currentClip.role})
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Mode toggle (Session vs Remote) ─────────────────────────────────

function DiffModeToggle({
  mode,
  onModeChange,
  sessionCount,
  remoteCount,
}: {
  mode: DiffMode;
  onModeChange: (m: DiffMode) => void;
  sessionCount: number;
  remoteCount: number;
}) {
  return (
    <div className="flex shrink-0 items-center gap-1 border-b border-white/[0.06] px-3 py-1.5">
      {(['session', 'remote'] as const).map((m) => {
        const label = m === 'session' ? `Session (${sessionCount})` : `Local vs Remote (${remoteCount})`;
        return (
          <button
            key={m}
            type="button"
            className={`px-2 py-0.5 text-[11px] font-semibold transition ${
              mode === m
                ? 'text-[var(--accent)]'
                : 'text-[color:var(--text-subtle)] hover:text-neutral-300'
            }`}
            onClick={() => onModeChange(m)}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}
