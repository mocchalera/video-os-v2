import { useEffect, useRef } from 'react';
import type { ChangesSummary } from '../types';

interface MergeDialogProps {
  /** WS-triggered merge banner (remote changed while dirty). */
  showMergeBanner: boolean;
  pendingRemoteRevision: string | null;
  /** 409-triggered conflict (save revision mismatch). */
  conflict: { localRevision: string; remoteRevision: string } | null;
  /** Current local revision for display. */
  localRevision: string | null;
  dirty: boolean;
  /** Number of locally changed clips (from session diff). */
  localChangedCount?: number;
  /** Structured summary of local changes from session baseline. */
  localChangesSummary?: ChangesSummary | null;
  /** Structured summary of remote changes from session baseline. */
  remoteChangesSummary?: ChangesSummary | null;
  /** Actions — MergeDialog decides which callback maps to the trigger source. */
  onReloadRemote: () => void;
  onKeepLocal: () => void;
  onCompareFirst: () => void;
  /** Close the dialog (Escape). Defaults to onKeepLocal if not provided. */
  onClose?: () => void;
}

/**
 * Unified Merge / Conflict Dialog (v3 contract).
 *
 * Triggered by either:
 * 1. WS timeline.changed while dirty (merge banner)
 * 2. 409 Conflict on save (revision mismatch)
 *
 * Actions:
 * - Reload Remote — discard local, load server version
 * - Keep Local — stay dirty, dismiss dialog
 * - Compare First — open Diff panel in AI mode for manual resolution
 */
export default function MergeDialog({
  showMergeBanner,
  pendingRemoteRevision,
  conflict,
  localRevision,
  dirty,
  onReloadRemote,
  onKeepLocal,
  onCompareFirst,
  localChangedCount,
  localChangesSummary,
  remoteChangesSummary,
  onClose,
}: MergeDialogProps) {
  const visible = showMergeBanner || !!conflict;
  const dialogRef = useRef<HTMLDivElement>(null);

  // Auto-focus the dialog wrapper so Escape works immediately
  useEffect(() => {
    if (visible) dialogRef.current?.focus();
  }, [visible]);

  if (!visible) return null;

  const handleClose = onClose ?? onKeepLocal;

  const isConflict = !!conflict;
  const remoteRev = conflict?.remoteRevision ?? pendingRemoteRevision ?? 'unknown';
  const localRev = conflict?.localRevision ?? localRevision ?? 'unknown';

  return (
    <div
      ref={dialogRef}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); handleClose(); } }}
      role="dialog"
      tabIndex={-1}
    >
      <div className="w-[480px] border border-white/[0.1] bg-[#1a1f28] p-6 shadow-2xl">
        <h2 className="mb-1 text-[15px] font-semibold text-white">
          {isConflict ? 'Timeline Conflict' : 'Timeline Changed'}
        </h2>
        <p className="mb-4 text-[13px] text-neutral-400">
          {isConflict
            ? 'The timeline was modified externally while you had unsaved changes. Your save was rejected (revision mismatch).'
            : 'The timeline was updated on disk while you have unsaved edits.'}
        </p>

        {/* Revision & changes info */}
        <div className="mb-4 space-y-1 rounded border border-white/[0.06] bg-black/30 px-3 py-2 font-mono text-[11px] text-neutral-400">
          <div>
            Local rev: <span className="text-neutral-200">{localRev}</span>
            {dirty && <span className="ml-2 text-[color:var(--warning)]">(dirty)</span>}
          </div>
          <div>
            Remote rev: <span className="text-neutral-200">{remoteRev}</span>
          </div>

          {/* Your changes (session baseline → local) */}
          <div className="mt-2 border-t border-white/[0.04] pt-2">
            <div className="mb-1 text-[10px] font-bold uppercase tracking-[0.16em] text-neutral-300">Your changes</div>
            {localChangesSummary ? (
              <div className="flex gap-3">
                {localChangesSummary.added > 0 && <span className="text-green-400">+{localChangesSummary.added} added</span>}
                {localChangesSummary.removed > 0 && <span className="text-red-400">-{localChangesSummary.removed} removed</span>}
                {localChangesSummary.modified > 0 && <span className="text-[color:var(--accent)]">{localChangesSummary.modified} modified</span>}
                {localChangesSummary.added === 0 && localChangesSummary.removed === 0 && localChangesSummary.modified === 0 && (
                  <span>No clip changes</span>
                )}
              </div>
            ) : localChangedCount != null && localChangedCount > 0 ? (
              <span className="text-[color:var(--accent)]">{localChangedCount} clip{localChangedCount !== 1 ? 's' : ''} modified</span>
            ) : (
              <span>No clip changes</span>
            )}
          </div>

          {/* Remote changes (session baseline → remote) */}
          <div className="mt-2 border-t border-white/[0.04] pt-2">
            <div className="mb-1 text-[10px] font-bold uppercase tracking-[0.16em] text-neutral-300">Remote changes</div>
            {remoteChangesSummary ? (
              <div className="flex gap-3">
                {remoteChangesSummary.added > 0 && <span className="text-green-400">+{remoteChangesSummary.added} added</span>}
                {remoteChangesSummary.removed > 0 && <span className="text-red-400">-{remoteChangesSummary.removed} removed</span>}
                {remoteChangesSummary.modified > 0 && <span className="text-[color:var(--accent)]">{remoteChangesSummary.modified} modified</span>}
                {remoteChangesSummary.added === 0 && remoteChangesSummary.removed === 0 && remoteChangesSummary.modified === 0 && (
                  <span>No clip changes</span>
                )}
              </div>
            ) : (
              <span className="text-neutral-500">Loading…</span>
            )}
          </div>
        </div>

        {/* v3 contract: 3 fixed actions */}
        <div className="flex gap-2">
          <button
            type="button"
            className="flex-1 bg-[color:var(--accent-strong)] px-3 py-2 text-[13px] font-semibold text-white transition hover:bg-[#4f95ff]"
            onClick={onReloadRemote}
          >
            Reload Remote
          </button>
          <button
            type="button"
            className="flex-1 border border-[color:var(--danger)]/30 bg-[color:var(--danger)]/10 px-3 py-2 text-[13px] font-medium text-[color:var(--danger)] transition hover:bg-[color:var(--danger)]/20"
            onClick={onKeepLocal}
          >
            Keep Mine
          </button>
          <button
            type="button"
            className="flex-1 border border-white/[0.06] bg-transparent px-3 py-2 text-[13px] font-medium text-neutral-200 transition hover:bg-white/[0.06]"
            onClick={onCompareFirst}
          >
            Compare First
          </button>
        </div>
      </div>
    </div>
  );
}
