import type { TimelineValidationIssue } from '../types';

interface StatusBarProps {
  aiJobIsRunning: boolean;
  aiJobPhase: string | null;
  timelineStatus: string;
  resolution: string;
  fpsLabel: string;
  duration: string;
  trackCount: number;
  validationIssues: TimelineValidationIssue[];
  dirty: boolean;
  lastSavedAt: string | null;
  wsStatus: string;
}

export default function StatusBar(props: StatusBarProps) {
  const { aiJobIsRunning, aiJobPhase, timelineStatus, resolution, fpsLabel, duration, trackCount, validationIssues, dirty, lastSavedAt, wsStatus } = props;
  const issueCount = validationIssues.length;

  return (
    <footer className="flex h-8 shrink-0 items-center justify-between border-t border-white/[0.06] px-4 font-mono text-[11px] text-[color:var(--text-muted)]">
      <div className="flex items-center gap-4">
        <span className="uppercase tracking-[0.22em] text-[color:var(--text-subtle)]">
          {aiJobIsRunning ? `AI ${aiJobPhase ?? ''}` : timelineStatus}
        </span>
        <span>{resolution}</span>
        <span>{fpsLabel}</span>
        <span>{duration}</span>
        <span>{trackCount} tracks</span>
        {issueCount > 0 && (
          <span
            className="cursor-help text-[color:var(--warning)]"
            title={validationIssues.map((i) => `${i.path}: ${i.message}`).join('\n')}
          >
            {issueCount} validation issue{issueCount !== 1 ? 's' : ''}
          </span>
        )}
        {aiJobIsRunning && (
          <span className="text-[var(--accent)]">AI job running — editing disabled</span>
        )}
      </div>

      <div className="flex items-center gap-4">
        {lastSavedAt && <span>Saved {lastSavedAt}</span>}
        <span className={dirty ? 'text-[color:var(--warning)]' : 'text-[color:var(--success)]'}>
          {dirty ? 'Unsaved' : 'Synced'}
        </span>
        <span
          className={
            wsStatus === 'connected'
              ? 'text-emerald-400'
              : wsStatus === 'connecting'
                ? 'text-amber-400'
                : 'text-neutral-500'
          }
        >
          {wsStatus === 'connected' ? 'WS' : wsStatus === 'connecting' ? 'WS...' : 'WS off'}
        </span>
      </div>
    </footer>
  );
}
