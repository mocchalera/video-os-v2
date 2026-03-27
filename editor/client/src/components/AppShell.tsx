import { type ReactNode, useCallback, useEffect, useMemo, useState } from 'react';
import type { BottomTab } from './EditorLayout';
import CommandPalette, { type PaletteCommand } from './CommandPalette';
import HeaderBar, { type EditorMode } from './HeaderBar';
import MergeDialog from './MergeDialog';
import StatusBar from './StatusBar';
import { useEditorKeyboard } from '../hooks/useEditorKeyboard';
import type { TimelineValidationIssue } from '@shared/timeline-validation';
import type { AiJobPhase, AiJobProgress, AiJobStatus } from '../hooks/useAiJob';
import type { WebSocketStatus } from '../hooks/useWebSocket';
import type { ChangesSummary, ProjectSummary, TimelineIR, TimelineSaveResult, TrimMode } from '../types';
import { formatClockFromFrames, getFps } from '../utils/time';
import { getTotalFrames } from '../utils/editor-helpers';

/** Structural shape of useTimeline for AppShell (covers HeaderBar + StatusBar + MergeDialog needs). */
interface AppShellTimelineState {
  projectId: string;
  projects: ProjectSummary[];
  setProjectId: (id: string) => void;
  connectionMode: 'api' | 'mock';
  timeline: TimelineIR | null;
  status: string;
  error: string | null;
  dirty: boolean;
  timelineRevision: string | null;
  lastSavedAt: string | null;
  canUndo: boolean;
  canRedo: boolean;
  validationIssues: TimelineValidationIssue[];
  conflict: { localRevision: string; remoteRevision: string } | null;
  save: () => Promise<TimelineSaveResult>;
  reload: () => Promise<void>;
  undo: () => void;
  redo: () => void;
}

interface AppShellPlayback {
  playheadFrame: number;
  error: string | null;
  togglePlayback: () => Promise<void>;
  shuttleSpeed: number;
  setShuttleSpeed: (speed: number) => void;
  stepFrame: (delta: number) => void;
  markIn: number | null;
  markOut: number | null;
  setMarkIn: () => void;
  setMarkOut: () => void;
  clearMarkIn: () => void;
  clearMarkOut: () => void;
}

interface AppShellSourcePlayback {
  togglePlayback: () => void;
  positionFrame: number;
  shuttleSpeed: number;
  setShuttleSpeed: (speed: number) => void;
  stepFrame: (delta: number) => void;
  markInUs: number | null;
  markOutUs: number | null;
  setMarkIn: () => void;
  setMarkOut: () => void;
  clearMarkIn: () => void;
  clearMarkOut: () => void;
}

interface AppShellSelection {
  clearSelection: () => void;
  toggleLinkedSelection: () => void;
  selection: import('../types').SelectionState | null;
}

interface AppShellTrimState {
  activeTrimTarget: import('../types').TrimTarget | null;
  isDragging: boolean;
  cancelTrim: () => void;
  keyboardTrimStep: (step: number, fallbackTarget?: import('../types').TrimTarget) => void;
  setTrimMode: (mode: TrimMode) => void;
}

interface AppShellAiJob {
  status: AiJobStatus;
  phase: AiJobPhase | null;
  progress: AiJobProgress | null;
  error: string | null;
  isRunning: boolean;
  startJob: (phase: AiJobPhase, baseRevision?: string | null, options?: Record<string, unknown>) => Promise<boolean>;
  reset: () => void;
}

interface AppShellSync {
  wsStatus: WebSocketStatus;
  showMergeBanner: boolean;
  pendingRemoteRevision: string | null;
}

interface AppShellProps {
  timelineState: AppShellTimelineState;
  playback: AppShellPlayback;
  sourcePlayback: AppShellSourcePlayback | null;
  activeMonitor: 'source' | 'program';
  onSetActiveMonitor: (monitor: 'source' | 'program') => void;
  selectionState: AppShellSelection;
  trimState: AppShellTrimState;
  aiJob: AppShellAiJob;
  sync: AppShellSync;
  localChangedCount: number;
  localChangesSummary?: ChangesSummary | null;
  remoteChangesSummary?: ChangesSummary | null;
  editorMode: EditorMode;
  onModeChange: (mode: EditorMode) => void;
  bottomTab: BottomTab;
  onBottomTabChange: (tab: BottomTab) => void;
  onExportRender: () => Promise<void>;
  onMergeReload: () => void;
  onMergeKeep: () => void;
  onMergeCompare: () => void;
  onToggleSnap?: () => void;
  onToggleLoop?: () => void;
  onLinkToggle?: () => void;
  onRippleDelete?: () => void;
  onLift?: () => void;
  onInsert?: () => void;
  onOverwrite?: () => void;
  onMatchFrame?: () => void;
  onRevealLowConfidence?: () => void;
  /** Apply patch for the selected clip (from CommandPalette) */
  onApplySelectedPatch?: () => void;
  children: ReactNode;
}

export default function AppShell({
  timelineState: ts,
  playback,
  sourcePlayback,
  activeMonitor,
  onSetActiveMonitor,
  selectionState: sel,
  trimState,
  aiJob,
  sync,
  localChangedCount,
  localChangesSummary,
  remoteChangesSummary,
  editorMode,
  onModeChange,
  bottomTab: _bottomTab,
  onBottomTabChange,
  onExportRender,
  onMergeReload,
  onMergeKeep,
  onMergeCompare,
  onToggleSnap,
  onToggleLoop,
  onLinkToggle,
  onRippleDelete,
  onLift,
  onInsert,
  onOverwrite,
  onMatchFrame,
  onRevealLowConfidence,
  onApplySelectedPatch,
  children,
}: AppShellProps) {
  const timeline = ts.timeline;
  const fps = timeline ? getFps(timeline.sequence) : 24;
  const totalFrames = getTotalFrames(timeline);
  const trackCount = timeline
    ? timeline.tracks.video.length + timeline.tracks.audio.length
    : 0;

  // ── Command Palette ──────────────────────────────────────────────────
  const [paletteOpen, setPaletteOpen] = useState(false);

  // Save-then-run helper for CommandPalette AI commands
  const handleSaveThenRun = useCallback(async (phase: AiJobPhase) => {
    let revision = ts.timelineRevision;
    if (ts.dirty) {
      const result = await ts.save();
      if (!result.ok) return;
      revision = result.timelineRevision ?? revision;
    }
    void aiJob.startJob(phase, revision);
  }, [ts.dirty, ts.timelineRevision, ts.save, aiJob.startJob]);

  const paletteCommands: PaletteCommand[] = useMemo(() => {
    const hasTimeline = !!ts.timeline;
    const isRunning = aiJob.isRunning;
    return [
      {
        id: 'compile',
        label: 'Compile',
        disabled: !hasTimeline || isRunning,
        action: () => { void handleSaveThenRun('compile'); },
      },
      {
        id: 'review',
        label: 'Review',
        disabled: !hasTimeline || isRunning,
        action: () => { void handleSaveThenRun('review'); },
      },
      {
        id: 'render',
        label: 'Render',
        disabled: !hasTimeline || isRunning,
        action: () => { void handleSaveThenRun('render'); },
      },
      {
        id: 'reload',
        label: 'Reload from disk',
        disabled: isRunning,
        action: () => { void ts.reload(); },
      },
      {
        id: 'apply-patch',
        label: 'Apply selected patch',
        disabled: !hasTimeline || isRunning,
        action: () => { onApplySelectedPatch?.(); },
      },
      {
        id: 'reveal-low',
        label: 'Reveal low confidence clips',
        disabled: !hasTimeline,
        action: () => { onRevealLowConfidence?.(); },
      },
      {
        id: 'open-diff',
        label: 'Open diff',
        disabled: !hasTimeline,
        action: () => { onBottomTabChange('diff'); },
      },
    ];
  }, [ts.timeline, ts.timelineRevision, aiJob.isRunning, onBottomTabChange, onRevealLowConfidence, onApplySelectedPatch, handleSaveThenRun]);

  // Cmd+K to open palette, Cmd+Shift+A to toggle mode
  useEffect(() => {
    function handleGlobalKeyDown(event: KeyboardEvent) {
      // Cmd/Ctrl+K: command palette
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setPaletteOpen((prev) => !prev);
      }
      // Cmd/Ctrl+Shift+A: toggle NLE/AI mode
      if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === 'a') {
        event.preventDefault();
        onModeChange(editorMode === 'nle' ? 'ai' : 'nle');
      }
    }
    window.addEventListener('keydown', handleGlobalKeyDown, true);
    return () => window.removeEventListener('keydown', handleGlobalKeyDown, true);
  }, [editorMode, onModeChange]);

  // MEDIUM 4: Banner → Dialog 2-stage for WS-triggered remote changes
  const [mergeModalOpen, setMergeModalOpen] = useState(false);
  useEffect(() => {
    if (!sync.showMergeBanner) setMergeModalOpen(false);
  }, [sync.showMergeBanner]);

  // Show informational banner when WS detects remote change while dirty (not 409 conflict)
  const showInfoBanner = sync.showMergeBanner && !mergeModalOpen && !ts.conflict;
  // Show full MergeDialog only when user clicks Resolve, OR on 409 conflict
  const showMergeModal = mergeModalOpen || !!ts.conflict;

  // Build source playback channel for keyboard routing
  const sourceChannel = sourcePlayback ? {
    togglePlayback: sourcePlayback.togglePlayback,
    playheadFrame: sourcePlayback.positionFrame,
    shuttleSpeed: sourcePlayback.shuttleSpeed,
    setShuttleSpeed: sourcePlayback.setShuttleSpeed,
    stepFrame: sourcePlayback.stepFrame,
    setMarkIn: sourcePlayback.setMarkIn,
    setMarkOut: sourcePlayback.setMarkOut,
    clearMarkIn: sourcePlayback.clearMarkIn,
    clearMarkOut: sourcePlayback.clearMarkOut,
  } : null;

  useEditorKeyboard({
    activeMonitor,
    onSetActiveMonitor,
    editorMode,
    programPlayback: {
      togglePlayback: playback.togglePlayback,
      playheadFrame: playback.playheadFrame,
      shuttleSpeed: playback.shuttleSpeed,
      setShuttleSpeed: playback.setShuttleSpeed,
      stepFrame: playback.stepFrame,
      setMarkIn: playback.setMarkIn,
      setMarkOut: playback.setMarkOut,
      clearMarkIn: playback.clearMarkIn,
      clearMarkOut: playback.clearMarkOut,
    },
    sourcePlayback: sourceChannel,
    timelineState: { timeline: ts.timeline, save: ts.save, undo: ts.undo, redo: ts.redo },
    selectionState: sel,
    trimState,
    aiJobIsRunning: aiJob.isRunning,
    paletteOpen,
    dialogOpen: showMergeModal,
    onExportRender,
    onToggleSnap,
    onToggleLoop,
    onLinkToggle,
    onRippleDelete,
    onLift,
    onInsert,
    onOverwrite,
    onMatchFrame,
    onCompile: () => { void handleSaveThenRun('compile'); },
    onReview: () => { void handleSaveThenRun('review'); },
    onRender: () => { void handleSaveThenRun('render'); },
    onApplySelectedPatch,
    onOpenDiff: () => onBottomTabChange('diff'),
  });

  const tc = formatClockFromFrames(playback.playheadFrame, fps);

  return (
    <div className="flex h-screen min-h-screen flex-col overflow-hidden bg-[color:var(--editor-bg)] text-[color:var(--text-main)]">
      <MergeDialog
        showMergeBanner={showMergeModal && !ts.conflict}
        pendingRemoteRevision={sync.pendingRemoteRevision}
        conflict={ts.conflict}
        localRevision={ts.timelineRevision}
        dirty={ts.dirty}
        localChangedCount={localChangedCount}
        localChangesSummary={localChangesSummary}
        remoteChangesSummary={remoteChangesSummary}
        onReloadRemote={onMergeReload}
        onKeepLocal={onMergeKeep}
        onCompareFirst={onMergeCompare}
        onClose={() => { if (ts.conflict) onMergeKeep(); else setMergeModalOpen(false); }}
      />
      <HeaderBar
        timelineState={ts}
        aiJob={aiJob}
        transportTimecode={tc}
        editorMode={editorMode}
        onModeChange={onModeChange}
      />
      {/* Informational banner: remote change detected while dirty (2-stage: banner → dialog) */}
      {showInfoBanner && (
        <div className="flex shrink-0 items-center justify-between border-b border-[color:var(--warning)]/20 bg-[color:var(--warning)]/[0.06] px-4 py-1.5">
          <div className="flex items-center gap-2">
            <span className="text-[12px] font-medium text-[color:var(--warning)]">
              Timeline changed on disk
            </span>
            {sync.pendingRemoteRevision && (
              <span className="font-mono text-[10px] text-[color:var(--text-subtle)]">
                rev {sync.pendingRemoteRevision.slice(0, 12)}…
              </span>
            )}
          </div>
          <button
            type="button"
            className="border border-[color:var(--warning)]/30 bg-[color:var(--warning)]/10 px-3 py-1 text-[11px] font-semibold text-[color:var(--warning)] transition hover:bg-[color:var(--warning)]/20"
            onClick={() => setMergeModalOpen(true)}
          >
            Resolve
          </button>
        </div>
      )}
      {children}
      <StatusBar
        aiJobIsRunning={aiJob.isRunning}
        aiJobPhase={aiJob.phase}
        timelineStatus={ts.status}
        resolution={`${timeline?.sequence.width ?? 1920}x${timeline?.sequence.height ?? 1080}`}
        fpsLabel={`${fps.toFixed(2).replace('.00', '')} fps`}
        duration={formatClockFromFrames(totalFrames, fps)}
        trackCount={trackCount}
        validationIssues={ts.validationIssues}
        dirty={ts.dirty}
        lastSavedAt={ts.lastSavedAt}
        wsStatus={sync.wsStatus}
      />
      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        commands={paletteCommands}
      />
      {(ts.error || playback.error) && (
        <div className="shrink-0 border-t border-red-400/20 px-4 py-2 text-[12px] text-[color:var(--danger)]">
          {ts.error ?? playback.error}
        </div>
      )}
    </div>
  );
}
