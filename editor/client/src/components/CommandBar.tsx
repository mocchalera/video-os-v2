import type { AiJobPhase, AiJobProgress, AiJobStatus } from '../hooks/useAiJob';

// ── Types ───────────────────────────────────────────────────────

interface CommandBarProps {
  /** Current AI job status */
  jobStatus: AiJobStatus;
  /** Current AI job phase */
  jobPhase: AiJobPhase | null;
  /** Progress data from polling */
  progress: AiJobProgress | null;
  /** Job error message */
  jobError: string | null;
  /** Whether the timeline has unsaved changes */
  dirty: boolean;
  /** Whether a timeline is loaded */
  hasTimeline: boolean;
  /** Current timeline revision */
  timelineRevision: string | null;
  /** Callbacks */
  onCompile: () => void;
  onReview: () => void;
  onRender: () => void;
  onSave: () => void;
  onDismissError: () => void;
}

// ── Helpers ─────────────────────────────────────────────────────

function phaseLabel(phase: AiJobPhase): string {
  switch (phase) {
    case 'compile': return 'Compiling';
    case 'review': return 'Reviewing';
    case 'render': return 'Rendering';
  }
}

function progressPercent(progress: AiJobProgress | null): number {
  if (!progress || !progress.total || progress.total === 0) return 0;
  return Math.round((progress.completed / progress.total) * 100);
}

// ── Component ───────────────────────────────────────────────────

export default function CommandBar({
  jobStatus,
  jobPhase,
  progress,
  jobError,
  dirty,
  hasTimeline,
  timelineRevision,
  onCompile,
  onReview,
  onRender,
  onSave,
  onDismissError,
}: CommandBarProps) {
  const isRunning = jobStatus === 'queued' || jobStatus === 'running';
  const isDisabled = !hasTimeline || isRunning || dirty;
  const pct = progressPercent(progress);

  return (
    <div className="flex items-center gap-2">
      {/* ── Action buttons ─────────────────────────────── */}
      {!isRunning ? (
        <>
          <button
            type="button"
            className="border border-white/[0.06] bg-transparent px-2.5 py-1 text-[12px] font-medium text-neutral-300 transition hover:bg-white/[0.06] hover:text-white disabled:opacity-35 disabled:hover:bg-transparent"
            disabled={isDisabled}
            onClick={onCompile}
            title="Re-compile timeline from blueprint + selects"
          >
            Compile
          </button>
          <button
            type="button"
            className="border border-white/[0.06] bg-transparent px-2.5 py-1 text-[12px] font-medium text-neutral-300 transition hover:bg-white/[0.06] hover:text-white disabled:opacity-35 disabled:hover:bg-transparent"
            disabled={isDisabled}
            onClick={onReview}
            title="Run AI review on current timeline"
          >
            Review
          </button>
          <button
            type="button"
            className="border border-[var(--accent)]/30 bg-[var(--accent)]/10 px-2.5 py-1 text-[12px] font-medium text-[var(--accent)] transition hover:bg-[var(--accent)]/20 disabled:opacity-35 disabled:hover:bg-[var(--accent)]/10"
            disabled={isDisabled}
            onClick={onRender}
            title="Render final video"
          >
            Render
          </button>
        </>
      ) : (
        /* ── Running state: spinner + progress ──────── */
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1.5">
            {/* Spinner */}
            <svg
              className="h-3.5 w-3.5 animate-spin text-[var(--accent)]"
              viewBox="0 0 24 24"
              fill="none"
            >
              <circle
                className="opacity-25"
                cx="12"
                cy="12"
                r="10"
                stroke="currentColor"
                strokeWidth="3"
              />
              <path
                className="opacity-75"
                fill="currentColor"
                d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
              />
            </svg>

            <span className="text-[12px] font-medium text-[var(--accent)]">
              {jobPhase ? phaseLabel(jobPhase) : 'Starting'}
              {pct > 0 ? ` ${pct}%` : '…'}
            </span>
          </div>

          {/* Progress bar */}
          {progress && progress.total > 0 ? (
            <div className="h-1.5 w-20 overflow-hidden rounded-full bg-white/[0.08]">
              <div
                className="h-full rounded-full bg-[var(--accent)] transition-all duration-300"
                style={{ width: `${pct}%` }}
              />
            </div>
          ) : null}

          {/* ETA */}
          {progress?.eta_sec != null && progress.eta_sec > 0 ? (
            <span className="font-mono text-[10px] text-[color:var(--text-subtle)]">
              ~{progress.eta_sec}s
            </span>
          ) : null}
        </div>
      )}

      {/* ── Success flash ──────────────────────────── */}
      {jobStatus === 'succeeded' && jobPhase ? (
        <span className="text-[11px] font-medium text-[color:var(--success)]">
          {jobPhase.charAt(0).toUpperCase() + jobPhase.slice(1)} complete
        </span>
      ) : null}

      {/* ── Error display ──────────────────────────── */}
      {jobStatus === 'failed' && jobError ? (
        <div className="flex items-center gap-1.5">
          <span className="max-w-[280px] truncate text-[11px] text-[color:var(--danger)]" title={jobError}>
            {jobError}
          </span>
          <button
            type="button"
            className="text-[10px] text-[color:var(--text-subtle)] hover:text-neutral-300"
            onClick={onDismissError}
          >
            dismiss
          </button>
        </div>
      ) : null}

      {/* ── Dirty warning for commands ──────────────── */}
      {dirty && !isRunning ? (
        <span className="text-[10px] text-[color:var(--warning)]">
          Save first
        </span>
      ) : null}
    </div>
  );
}
