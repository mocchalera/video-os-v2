import { useState } from 'react';
import type { PatchOperation, ReviewPatchResponse } from '../types';

interface PatchPanelProps {
  patchData: ReviewPatchResponse | null;
  dirty: boolean;
  timelineRevision: string | null;
  onApply: (operationIndexes: number[]) => Promise<void>;
  /** Preview a single operation (temporarily show result without committing) */
  onPreview?: (operationIndex: number) => void;
  /** Currently previewing operation index */
  previewingIndex?: number | null;
}

const OP_COLORS: Record<string, { border: string; bg: string; label: string }> = {
  replace_segment: { border: '#d946ef', bg: 'rgba(217,70,239,0.08)', label: 'Replace' },
  trim_segment: { border: '#f59e0b', bg: 'rgba(245,158,11,0.08)', label: 'Trim' },
  move_segment: { border: '#06b6d4', bg: 'rgba(6,182,212,0.08)', label: 'Move' },
  insert_segment: { border: '#a855f7', bg: 'rgba(168,85,247,0.08)', label: 'Insert' },
  remove_segment: { border: '#ef4444', bg: 'rgba(239,68,68,0.08)', label: 'Remove' },
  change_audio_policy: { border: '#3b82f6', bg: 'rgba(59,130,246,0.08)', label: 'Audio' },
  add_marker: { border: '#8b5cf6', bg: 'rgba(139,92,246,0.08)', label: 'Marker' },
  add_note: { border: '#8b5cf6', bg: 'rgba(139,92,246,0.08)', label: 'Note' },
};

function getOpStyle(op: PatchOperation) {
  return OP_COLORS[op.op] ?? { border: '#6b7280', bg: 'rgba(107,114,128,0.08)', label: op.op };
}

export default function PatchPanel({
  patchData,
  dirty,
  timelineRevision,
  onApply,
  onPreview,
  previewingIndex,
}: PatchPanelProps) {
  const [rejectedIndexes, setRejectedIndexes] = useState<Set<number>>(new Set());
  const [applyingIndexes, setApplyingIndexes] = useState<Set<number>>(new Set());

  if (!patchData?.exists || !patchData.data) {
    return (
      <div className="flex h-full items-center justify-center px-5 py-8">
        <div className="text-center">
          <div className="font-mono text-[10px] uppercase tracking-[0.24em] text-[color:var(--text-subtle)]">
            No Patches
          </div>
          <p className="mt-2 text-[12px] text-[color:var(--text-muted)]">
            Run a review to generate patch suggestions.
          </p>
        </div>
      </div>
    );
  }

  // Use safety-filtered operations only; rejected_ops are shown as warning (修正R2-2)
  const safetyRejectedOps = patchData.safety?.rejected_ops ?? [];
  const operations = patchData.safety?.filtered_patch?.operations ?? patchData.data.operations;
  // filteredIdx = index within this filtered list (for UI state);
  // originalIdx = original_index from server (for API calls)
  const activeOps = operations
    .map((op, filteredIdx) => ({
      op,
      filteredIdx,
      originalIdx: op.original_index ?? filteredIdx,
    }))
    .filter(({ filteredIdx }) => !rejectedIndexes.has(filteredIdx));

  async function handleApply(filteredIdx: number, originalIdx: number): Promise<void> {
    setApplyingIndexes((prev) => new Set(prev).add(filteredIdx));
    try {
      await onApply([originalIdx]);
    } finally {
      setApplyingIndexes((prev) => {
        const next = new Set(prev);
        next.delete(filteredIdx);
        return next;
      });
    }
  }

  async function handleApplyAll(): Promise<void> {
    const originalIndexes = activeOps.map(({ originalIdx }) => originalIdx);
    if (originalIndexes.length === 0) return;
    setApplyingIndexes(new Set(activeOps.map(({ filteredIdx }) => filteredIdx)));
    try {
      await onApply(originalIndexes);
    } finally {
      setApplyingIndexes(new Set());
    }
  }

  function handleReject(index: number): void {
    setRejectedIndexes((prev) => new Set(prev).add(index));
  }

  const canApply = !dirty && timelineRevision != null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Header */}
      <div className="flex shrink-0 items-center justify-between border-b border-white/[0.06] px-4 py-2">
        <div className="font-mono text-[10px] uppercase tracking-[0.24em] text-[color:var(--text-subtle)]">
          Patches ({activeOps.length}/{operations.length})
        </div>

        <button
          type="button"
          className="rounded border border-[var(--accent)]/40 bg-[var(--accent)]/10 px-2.5 py-1 font-mono text-[10px] font-semibold uppercase tracking-[0.15em] text-[var(--accent)] transition hover:bg-[var(--accent)]/20 disabled:opacity-35 disabled:hover:bg-transparent"
          disabled={!canApply || activeOps.length === 0}
          onClick={() => {
            void handleApplyAll();
          }}
          title={dirty ? 'Save first to apply AI patch' : 'Apply all visible patches'}
        >
          Apply All
        </button>
      </div>

      {dirty ? (
        <div className="shrink-0 border-b border-amber-500/20 bg-amber-500/5 px-4 py-2 font-mono text-[10px] text-amber-400">
          Save first to apply AI patch
        </div>
      ) : null}

      {safetyRejectedOps.length > 0 ? (
        <div className="shrink-0 border-b border-red-500/20 bg-red-500/5 px-4 py-2 font-mono text-[10px] text-red-400">
          {safetyRejectedOps.length} operation{safetyRejectedOps.length > 1 ? 's' : ''} rejected by safety filter
        </div>
      ) : null}

      {/* Patch list */}
      <div className="editor-scrollbar min-h-0 flex-1 overflow-y-auto">
        {operations.map((op, filteredIdx) => {
          const rejected = rejectedIndexes.has(filteredIdx);
          const applying = applyingIndexes.has(filteredIdx);
          const originalIdx = op.original_index ?? filteredIdx;
          const style = getOpStyle(op);

          return (
            <div
              key={filteredIdx}
              className={`border-b border-white/[0.04] px-4 py-3 transition ${
                rejected ? 'opacity-30' : ''
              }`}
              style={{
                borderLeftWidth: 3,
                borderLeftColor: rejected ? '#6b7280' : style.border,
                background: rejected ? 'transparent' : style.bg,
              }}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span
                      className="rounded-sm px-1.5 py-px font-mono text-[9px] font-bold uppercase"
                      style={{
                        background: rejected ? '#6b7280' : style.border,
                        color: '#000',
                      }}
                    >
                      {style.label}
                    </span>
                    {op.target_clip_id ? (
                      <span className="font-mono text-[10px] text-[color:var(--text-subtle)]">
                        {op.target_clip_id}
                      </span>
                    ) : null}
                    {op.confidence != null ? (
                      <span className="font-mono text-[10px] text-neutral-400">
                        {(op.confidence * 100).toFixed(0)}%
                      </span>
                    ) : null}
                  </div>

                  {op.reason ? (
                    <div className="mt-1.5 text-[11px] leading-relaxed text-neutral-300">
                      {op.reason}
                    </div>
                  ) : null}
                </div>

                {!rejected ? (
                  <div className="flex shrink-0 gap-1.5">
                    {onPreview && (
                      <button
                        type="button"
                        className={`rounded border px-2 py-0.5 font-mono text-[9px] font-semibold uppercase transition ${
                          previewingIndex === filteredIdx
                            ? 'border-[var(--accent)]/50 bg-[var(--accent)]/20 text-[var(--accent)]'
                            : 'border-white/[0.12] bg-white/[0.04] text-neutral-300 hover:bg-white/[0.08]'
                        }`}
                        onClick={() => onPreview(filteredIdx)}
                        title="Preview this patch operation"
                      >
                        {previewingIndex === filteredIdx ? 'Exit' : 'Preview'}
                      </button>
                    )}
                    <button
                      type="button"
                      className="rounded border border-green-500/30 bg-green-500/10 px-2 py-0.5 font-mono text-[9px] font-semibold uppercase text-green-400 transition hover:bg-green-500/20 disabled:opacity-35"
                      disabled={!canApply || applying}
                      onClick={() => {
                        void handleApply(filteredIdx, originalIdx);
                      }}
                    >
                      {applying ? '...' : 'Apply'}
                    </button>
                    <button
                      type="button"
                      className="rounded border border-red-500/30 bg-red-500/10 px-2 py-0.5 font-mono text-[9px] font-semibold uppercase text-red-400 transition hover:bg-red-500/20"
                      onClick={() => handleReject(filteredIdx)}
                    >
                      Reject
                    </button>
                  </div>
                ) : (
                  <span className="font-mono text-[9px] uppercase text-neutral-500">
                    Rejected
                  </span>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
