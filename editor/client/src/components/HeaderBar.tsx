import type { ProjectSummary } from '../types';
import type { AiJobPhase, useAiJob } from '../hooks/useAiJob';
import type { useTimeline } from '../hooks/useTimeline';
import CommandBar from './CommandBar';

export type EditorMode = 'nle' | 'ai';

interface HeaderBarProps {
  timelineState: Pick<ReturnType<typeof useTimeline>, 'projectId' | 'projects' | 'setProjectId' | 'connectionMode' | 'dirty' | 'timeline' | 'timelineRevision' | 'canUndo' | 'canRedo' | 'save' | 'undo' | 'redo'>;
  aiJob: Pick<ReturnType<typeof useAiJob>, 'status' | 'phase' | 'progress' | 'error' | 'isRunning' | 'startJob' | 'reset'>;
  transportTimecode: string;
  editorMode: EditorMode;
  onModeChange: (mode: EditorMode) => void;
}

function PanelBadge({ children }: { children: React.ReactNode }) {
  return (
    <span className="px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.22em] text-[color:var(--text-subtle)]">
      {children}
    </span>
  );
}

export default function HeaderBar({
  timelineState: ts,
  aiJob,
  transportTimecode,
  editorMode,
  onModeChange,
}: HeaderBarProps) {
  async function handleSaveThenRun(phase: AiJobPhase) {
    let revision = ts.timelineRevision;
    if (ts.dirty) {
      const result = await ts.save();
      if (!result.ok) return; // 409 → conflict dialog already shown by useTimeline
      revision = result.timelineRevision ?? revision;
    }
    void aiJob.startJob(phase, revision);
  }

  return (
    <header className="shrink-0 border-b border-white/[0.06] px-4 py-2.5">
      <div className="flex items-center justify-between gap-4">
        <div className="flex min-w-0 items-center gap-3">
          <div className="min-w-0">
            <div className="font-mono text-[10px] uppercase tracking-[0.28em] text-[color:var(--text-subtle)]">
              Video OS v2
            </div>
            <div className="truncate text-[28px] font-semibold leading-none text-white">
              Timeline Editor
            </div>
          </div>

          <div className="h-10 w-px bg-white/[0.08]" />

          <div className="flex items-center gap-2">
            <select
              className="min-w-[240px] border border-white/[0.06] bg-transparent px-3 py-1.5 text-[13px] font-medium text-neutral-100 outline-none transition focus:border-[var(--accent)]"
              value={ts.projectId}
              onChange={(e) => ts.setProjectId(e.target.value)}
            >
              {ts.projects.map((p) => (
                <option key={p.id} value={p.id} className="bg-[#11161d]">
                  {p.name}
                </option>
              ))}
            </select>
            <PanelBadge>{ts.connectionMode === 'api' ? 'Live API' : 'Mock Cache'}</PanelBadge>
          </div>

          <div className="h-10 w-px bg-white/[0.08]" />

          {/* NLE / AI Mode Toggle */}
          <div className="flex items-center gap-1 rounded border border-white/[0.06] p-0.5">
            <button
              type="button"
              className={`px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.12em] transition ${
                editorMode === 'nle'
                  ? 'bg-white/[0.1] text-white'
                  : 'text-[color:var(--text-subtle)] hover:text-neutral-300'
              }`}
              onClick={() => onModeChange('nle')}
            >
              NLE
            </button>
            <button
              type="button"
              className={`px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.12em] transition ${
                editorMode === 'ai'
                  ? 'bg-[var(--accent-strong)]/30 text-[var(--accent)]'
                  : 'text-[color:var(--text-subtle)] hover:text-neutral-300'
              }`}
              onClick={() => onModeChange('ai')}
            >
              AI
            </button>
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-4">
          <div className="hidden text-right md:block">
            <div className="font-mono text-[11px] uppercase tracking-[0.22em] text-[color:var(--text-subtle)]">
              Program TC
            </div>
            <div className="font-mono text-[24px] font-semibold tabular-nums tracking-[0.08em] text-white">
              {transportTimecode}
            </div>
          </div>

          <div className="h-8 w-px bg-white/[0.08]" />

          <CommandBar
            jobStatus={aiJob.status}
            jobPhase={aiJob.phase}
            progress={aiJob.progress}
            jobError={aiJob.error}
            dirty={ts.dirty}
            hasTimeline={!!ts.timeline}
            timelineRevision={ts.timelineRevision}
            onCompile={() => { void handleSaveThenRun('compile'); }}
            onReview={() => { void handleSaveThenRun('review'); }}
            onRender={() => { void handleSaveThenRun('render'); }}
            onSave={() => { void ts.save(); }}
            onDismissError={() => aiJob.reset()}
          />

          <div className="h-8 w-px bg-white/[0.08]" />

          <div className="flex items-center gap-2">
            <button
              type="button"
              className="border border-white/[0.06] bg-transparent px-3 py-1.5 text-[13px] font-medium text-neutral-200 transition hover:bg-white/[0.06] disabled:opacity-35"
              disabled={!ts.canUndo || aiJob.isRunning}
              onClick={() => ts.undo()}
            >
              Undo
            </button>
            <button
              type="button"
              className="border border-white/[0.06] bg-transparent px-3 py-1.5 text-[13px] font-medium text-neutral-200 transition hover:bg-white/[0.06] disabled:opacity-35"
              disabled={!ts.canRedo || aiJob.isRunning}
              onClick={() => ts.redo()}
            >
              Redo
            </button>
            <button
              type="button"
              className="bg-[color:var(--accent-strong)] px-3 py-1.5 text-[13px] font-semibold text-white transition hover:bg-[#4f95ff] disabled:opacity-35"
              disabled={!ts.timeline || aiJob.isRunning}
              onClick={() => { void ts.save(); }}
            >
              Save
            </button>
          </div>
        </div>
      </div>
    </header>
  );
}
