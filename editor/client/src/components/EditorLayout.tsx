import { useRef, useMemo, useState } from 'react';
import ErrorBoundary from './ErrorBoundary';
import type { EditorMode } from './HeaderBar';
import type {
  AudioPolicy,
  Clip,
  EditorLane,
  ReviewPatchResponse,
  ReviewReportResponse,
  SelectionState,
  SnapTarget,
  TimelineIR,
  TrackHeaderState,
  TrimMode,
  TrimTarget,
} from '../types';
import type { ClipOverlay } from './ClipBlock';
import type { AlternativeCandidate } from '../hooks/useAlternatives';
import type { BlueprintResponse } from '../hooks/useReview';
import type { ClipDiff } from '../hooks/useDiff';
import type { SourceAsset } from '../hooks/useSourcePlayback';
import AiDecisionPanel from './AiDecisionPanel';
import AlternativesPanel from './AlternativesPanel';
import DiffPanel from './DiffPanel';
import PatchPanel from './PatchPanel';
import PropertyPanel from './PropertyPanel';
import ReviewOverlay from './ReviewOverlay';
import SourceMonitor from './SourceMonitor';
import ProgramMonitor from './ProgramMonitor';
import TrimModeToolbar from './TrimModeToolbar';
import TrimPreviewOverlay from './TrimPreviewOverlay';
import Timeline, { type TimelineHandle } from './Timeline';
import { MIN_ZOOM, MAX_ZOOM } from '../utils/editor-helpers';

export type BottomTab = 'timeline' | 'patches' | 'alternatives' | 'diff';

interface EditorLayoutProps {
  mode: EditorMode;
  // Active monitor (lifted to App.tsx)
  activeMonitor: 'source' | 'program';
  onSetActiveMonitor: (monitor: 'source' | 'program') => void;
  // Playback
  playback: {
    videoRef: React.RefObject<HTMLVideoElement | null>;
    previewMode: 'source' | 'none';
    renderStatus: 'idle' | 'rendering' | 'ready' | 'error';
    isPlaying: boolean;
    isBuffering: boolean;
    isGap: boolean;
    error: string | null;
    playheadFrame: number;
    previewStale: boolean;
    seekToFrame: (frame: number) => void;
    handleVideoLoadedMetadata: () => void;
    handleVideoCanPlayThrough: () => void;
    handleVideoTimeUpdate: () => void;
    handleVideoWaiting: () => void;
    handleVideoPlaying: () => void;
    handleVideoStalled: () => void;
    handleVideoEnded: () => void;
    handleVideoError: () => void;
    togglePlayback: () => Promise<void>;
    shuttleSpeed: number;
    markIn: number | null;
    markOut: number | null;
  };
  // Source playback
  sourcePlayback: {
    videoRef: React.RefObject<HTMLVideoElement | null>;
    currentAsset: SourceAsset | null;
    positionFrame: number;
    durationFrames: number;
    isPlaying: boolean;
    isBuffering: boolean;
    markInFrame: number | null;
    markOutFrame: number | null;
    shuttleSpeed: number;
    error: string | null;
    handleVideoLoadedMetadata: () => void;
    handleVideoCanPlayThrough: () => void;
    handleVideoTimeUpdate: () => void;
    handleVideoWaiting: () => void;
    handleVideoPlaying: () => void;
    handleVideoEnded: () => void;
    handleVideoError: () => void;
    togglePlayback: () => void;
  };
  transportTimecode: string;
  // Timeline
  timeline: TimelineIR | null;
  fps: number;
  lanes: EditorLane[];
  totalFrames: number;
  zoom: number;
  onZoomChange: (z: number) => void;
  projectId: string | null;
  // Selection (multi-select)
  selectedClipId: string | null;
  selectedClipIds: Set<string>;
  selectedClip: Clip | null;
  onSelectClip: (
    trackKind: 'video' | 'audio',
    trackId: string,
    clip: Clip,
    event: { shiftKey: boolean; metaKey: boolean; ctrlKey: boolean },
  ) => void;
  onClearSelection: () => void;
  onMarqueeSelect: (items: SelectionState[]) => void;
  // Trim
  trimMode: TrimMode;
  activeTrimTarget: TrimTarget | null;
  isDragging: boolean;
  trimDelta: number;
  onSetTrimMode: (mode: TrimMode) => void;
  onTrimBegin: (target: TrimTarget, opts?: { altKey?: boolean }) => void;
  onTrimUpdate: (deltaFrames: number, opts?: { skipSnap?: boolean }) => void;
  onTrimCommit: () => void;
  // Track header state
  trackStates: Record<string, TrackHeaderState>;
  onToggleLock: (trackId: string) => void;
  onToggleMute: (trackId: string) => void;
  onToggleSolo: (trackId: string) => void;
  onToggleSyncLock: (trackId: string) => void;
  onCycleHeight: (trackId: string) => void;
  // Snap
  snapEnabled: boolean;
  activeSnapGuide: SnapTarget | null;
  // Inspector
  onUpdateAudioNumber: (field: keyof AudioPolicy, value: number) => void;
  onUpdateAudioBoolean: (field: keyof AudioPolicy, value: boolean) => void;
  // Review
  reviewReport: ReviewReportResponse | null;
  reviewPatch: ReviewPatchResponse | null;
  reviewBlueprint: BlueprintResponse | null;
  // AI panels
  dirty: boolean;
  timelineRevision: string | null;
  sessionBaselineRevision: string | null;
  onApplyPatch: (indexes: number[]) => Promise<void>;
  alternatives: AlternativeCandidate[];
  alternativesLoading: boolean;
  onSwapClip: (candidate: AlternativeCandidate) => void;
  clipDiffs: ClipDiff[];
  remoteDiffs?: ClipDiff[] | null;
  remoteCompareRevision?: string | null;
  aiJobIsRunning: boolean;
  // Export
  onExportRender: () => void;
  // Track targets for patch matrix display (clickable)
  videoTarget: string;
  audioTargets: Set<string>;
  videoTrackIds?: string[];
  audioTrackIds?: string[];
  onToggleVideoTarget?: (trackId: string) => void;
  onToggleAudioTarget?: (trackId: string) => void;
  // Alternatives preview
  onPreviewAlternative?: (candidate: AlternativeCandidate) => void;
  // Bottom tab control (for Compare First in MergeDialog)
  bottomTab: BottomTab;
  onBottomTabChange: (tab: BottomTab) => void;
  /** Jump to a clip on the timeline (select + scroll) */
  onJumpToClip?: (clipId: string) => void;
  /** Confidence filter for overlays */
  confidenceFilter?: 'all' | 'low' | 'warnings';
  onConfidenceFilterChange?: (filter: 'all' | 'low' | 'warnings') => void;
  /** Patch preview */
  onPreviewPatch?: (filteredIndex: number) => void;
  previewingPatchIndex?: number | null;
}

export default function EditorLayout({
  mode,
  activeMonitor,
  onSetActiveMonitor,
  playback,
  sourcePlayback,
  transportTimecode,
  timeline,
  fps,
  lanes,
  totalFrames,
  zoom,
  onZoomChange,
  projectId,
  selectedClipId,
  selectedClipIds,
  selectedClip,
  onSelectClip,
  onClearSelection,
  onMarqueeSelect,
  trimMode,
  activeTrimTarget,
  isDragging,
  trimDelta,
  onSetTrimMode,
  onTrimBegin,
  onTrimUpdate,
  onTrimCommit,
  trackStates,
  onToggleLock,
  onToggleMute,
  onToggleSolo,
  onToggleSyncLock,
  onCycleHeight,
  snapEnabled,
  activeSnapGuide,
  onUpdateAudioNumber,
  onUpdateAudioBoolean,
  reviewReport,
  reviewPatch,
  reviewBlueprint,
  dirty,
  timelineRevision,
  sessionBaselineRevision,
  onApplyPatch,
  alternatives,
  alternativesLoading,
  onSwapClip,
  clipDiffs,
  remoteDiffs,
  remoteCompareRevision,
  aiJobIsRunning,
  onExportRender,
  videoTarget,
  audioTargets,
  videoTrackIds,
  audioTrackIds,
  onToggleVideoTarget,
  onToggleAudioTarget,
  onPreviewAlternative,
  bottomTab,
  onBottomTabChange,
  onJumpToClip,
  confidenceFilter = 'all',
  onConfidenceFilterChange,
  onPreviewPatch,
  previewingPatchIndex,
}: EditorLayoutProps) {

  const timelineRef = useRef<TimelineHandle>(null);

  // Compute clip overlays from review data
  const clipOverlays = useMemo(() => {
    const map = new Map<string, ClipOverlay>();

    function ensure(clipId: string): ClipOverlay {
      let entry = map.get(clipId);
      if (!entry) {
        entry = { weaknesses: [], warnings: [], patchOps: [] };
        map.set(clipId, entry);
      }
      return entry;
    }

    const weaknesses = reviewReport?.data?.weaknesses ?? [];
    for (const w of weaknesses) {
      if (w.clip_id) ensure(w.clip_id).weaknesses.push(w);
    }

    const warnings = reviewReport?.data?.warnings ?? [];
    for (const w of warnings) {
      if (w.clip_id) ensure(w.clip_id).warnings.push(w);
    }

    const patchOps = reviewPatch?.safety?.filtered_patch?.operations
      ?? reviewPatch?.data?.operations
      ?? [];
    for (const op of patchOps) {
      if (op.target_clip_id) ensure(op.target_clip_id).patchOps.push(op);
    }

    return map;
  }, [reviewReport, reviewPatch]);

  // Wrap onJumpToClip to also scroll the timeline viewport
  const handleJumpToClip = useMemo(() => {
    if (!onJumpToClip) return undefined;
    return (clipId: string) => {
      onJumpToClip(clipId);
      // Find the clip's frame to scroll to
      if (timeline) {
        for (const kind of ['video', 'audio'] as const) {
          for (const track of timeline.tracks[kind]) {
            const clip = track.clips.find(c => c.clip_id === clipId);
            if (clip) {
              timelineRef.current?.scrollToFrame(clip.timeline_in_frame);
              return;
            }
          }
        }
      }
    };
  }, [onJumpToClip, timeline]);

  const totalTrackCount = timeline
    ? timeline.tracks.video.length + timeline.tracks.audio.length
    : 0;
  const hiddenTrackCount = Math.max(0, totalTrackCount - lanes.length);
  const zoomLabel = zoom >= 2 ? `${zoom.toFixed(1)} px/f` : `${zoom.toFixed(2)} px/f`;

  const bottomTabs: { key: BottomTab; label: string; badge?: number }[] = [
    { key: 'timeline', label: 'Assembly Dock' },
    { key: 'patches', label: 'Patches', badge: reviewPatch?.data?.operations?.length },
    { key: 'alternatives', label: 'Alternatives', badge: alternatives.length || undefined },
    { key: 'diff', label: 'Diff', badge: clipDiffs.length || undefined },
  ];

  // Grid layout changes based on mode
  const gridStyle = mode === 'nle'
    ? { gridTemplateColumns: '1fr 1fr 320px', gridTemplateRows: 'minmax(0, 2fr) minmax(0, 3fr)' }
    : { gridTemplateColumns: 'minmax(0, 1fr) 320px', gridTemplateRows: 'minmax(0, 2fr) minmax(0, 3fr)' };

  return (
    <main className="min-h-0 flex-1 overflow-hidden">
      <div className="grid h-full min-h-0 overflow-hidden panel-transition" style={gridStyle}>
        {/* ── Row 1: Monitors + Right Panel ── */}

        {/* Source Monitor (NLE Mode only) */}
        {mode === 'nle' && (
          <ErrorBoundary label="Source Monitor"><SourceMonitor
            isActive={activeMonitor === 'source'}
            onClick={() => onSetActiveMonitor('source')}
            fps={fps}
            videoRef={sourcePlayback.videoRef}
            currentAsset={sourcePlayback.currentAsset}
            positionFrame={sourcePlayback.positionFrame}
            durationFrames={sourcePlayback.durationFrames}
            isPlaying={sourcePlayback.isPlaying}
            isBuffering={sourcePlayback.isBuffering}
            markInFrame={sourcePlayback.markInFrame}
            markOutFrame={sourcePlayback.markOutFrame}
            shuttleSpeed={sourcePlayback.shuttleSpeed}
            error={sourcePlayback.error}
            onLoadedMetadata={sourcePlayback.handleVideoLoadedMetadata}
            onCanPlayThrough={sourcePlayback.handleVideoCanPlayThrough}
            onTimeUpdate={sourcePlayback.handleVideoTimeUpdate}
            onWaiting={sourcePlayback.handleVideoWaiting}
            onPlaying={sourcePlayback.handleVideoPlaying}
            onEnded={sourcePlayback.handleVideoEnded}
            onVideoError={sourcePlayback.handleVideoError}
            onTogglePlayback={sourcePlayback.togglePlayback}
            videoTarget={videoTarget}
            audioTargets={audioTargets}
            videoTrackIds={videoTrackIds}
            audioTrackIds={audioTrackIds}
            onToggleVideoTarget={onToggleVideoTarget}
            onToggleAudioTarget={onToggleAudioTarget}
          /></ErrorBoundary>
        )}

        {/* Program Monitor + Trim Preview Overlay */}
        <ErrorBoundary label="Program Monitor"><div className="relative min-h-0 overflow-hidden">
          <ProgramMonitor
            isActive={mode === 'ai' || activeMonitor === 'program'}
            onClick={() => onSetActiveMonitor('program')}
            playback={playback}
            fps={fps}
            markIn={playback.markIn}
            markOut={playback.markOut}
            transportTimecode={transportTimecode}
            currentFrame={playback.playheadFrame}
            onExportRender={onExportRender}
          />
          <TrimPreviewOverlay
            trimMode={trimMode}
            activeTrimTarget={activeTrimTarget}
            isDragging={isDragging}
            trimDelta={trimDelta}
            currentFrame={playback.playheadFrame}
            snapTargetLabel={activeSnapGuide?.label ?? null}
          />
        </div></ErrorBoundary>

        {/* Right Panel: Inspector (NLE) or AI Workspace (AI) */}
        <ErrorBoundary label={mode === 'nle' ? 'Inspector' : 'AI Workspace'}><section className="min-h-0 overflow-hidden">
          {mode === 'nle' ? (
            <PropertyPanel
              clip={selectedClip}
              fps={fps}
              reviewReport={reviewReport}
              blueprint={reviewBlueprint}
              onUpdateAudioNumber={onUpdateAudioNumber}
              onUpdateAudioBoolean={onUpdateAudioBoolean}
            />
          ) : (
            <AiWorkspace
              selectedClip={selectedClip}
              fps={fps}
              reviewReport={reviewReport}
              reviewPatch={reviewPatch}
              reviewBlueprint={reviewBlueprint}
              dirty={dirty}
              timelineRevision={timelineRevision}
              onApplyPatch={onApplyPatch}
              alternatives={alternatives}
              alternativesLoading={alternativesLoading}
              selectedClipId={selectedClipId}
              onSwapClip={onSwapClip}
              clipDiffs={clipDiffs}
              remoteDiffs={remoteDiffs}
              remoteCompareRevision={remoteCompareRevision}
              sessionBaselineRevision={sessionBaselineRevision}
              onUpdateAudioNumber={onUpdateAudioNumber}
              onUpdateAudioBoolean={onUpdateAudioBoolean}
              onPreviewAlternative={onPreviewAlternative}
              onJumpToClip={handleJumpToClip}
              onPreviewPatch={onPreviewPatch}
              previewingPatchIndex={previewingPatchIndex}
            />
          )}
        </section></ErrorBoundary>

        {/* ── Row 2: Bottom Dock (full width) ── */}
        <section
          className="flex min-h-0 flex-col overflow-hidden border-t border-white/[0.06]"
          style={{ gridColumn: '1 / -1' }}
        >
          {/* Tab bar */}
          <div className="flex shrink-0 items-center gap-3 border-b border-white/[0.06] px-3 py-1.5">
            <div className="flex items-center gap-1">
              {bottomTabs.map(({ key, label, badge }, i) => (
                <span key={key} className="flex items-center">
                  {i > 0 && <span className="text-[color:var(--text-subtle)]">/</span>}
                  <button
                    type="button"
                    className={`px-2 py-0.5 text-[13px] font-semibold transition ${
                      bottomTab === key
                        ? 'text-white'
                        : 'text-[color:var(--text-subtle)] hover:text-neutral-300'
                    }`}
                    onClick={() => onBottomTabChange(key)}
                  >
                    {label}
                    {badge ? (
                      <span className="ml-1.5 rounded-sm bg-[var(--accent)]/20 px-1 py-px font-mono text-[9px] text-[var(--accent)]">
                        {badge}
                      </span>
                    ) : null}
                  </button>
                </span>
              ))}
            </div>

            <span className="font-mono text-[10px] text-[color:var(--text-subtle)]">
              {lanes.length}T{hiddenTrackCount > 0 ? ` +${hiddenTrackCount}h` : ''} · {timeline?.markers?.length ?? 0}M
            </span>

            <div className="flex-1" />

            <label className="flex items-center gap-2">
              <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-[color:var(--text-subtle)]">
                Zoom
              </span>
              <input
                className="range-input w-24"
                type="range"
                min={MIN_ZOOM}
                max={MAX_ZOOM}
                step={0.25}
                value={zoom}
                onChange={(e) => onZoomChange(Number(e.target.value))}
              />
              <span className="font-mono text-[10px] tabular-nums text-neutral-300">
                {zoomLabel}
              </span>
            </label>
          </div>

          {/* Confidence filter (visible when timeline tab is active) */}
          {bottomTab === 'timeline' && onConfidenceFilterChange && (
            <div className="flex shrink-0 items-center gap-1 border-b border-white/[0.04] px-3 py-1">
              <span className="mr-1 font-mono text-[9px] uppercase tracking-[0.15em] text-[color:var(--text-subtle)]">
                Filter
              </span>
              {(['all', 'low', 'warnings'] as const).map((f) => (
                <button
                  key={f}
                  type="button"
                  className={`px-2 py-0.5 text-[10px] font-medium transition ${
                    confidenceFilter === f
                      ? 'text-[var(--accent)]'
                      : 'text-[color:var(--text-subtle)] hover:text-neutral-300'
                  }`}
                  onClick={() => onConfidenceFilterChange(f)}
                >
                  {f === 'all' ? 'All' : f === 'low' ? 'Low Confidence' : 'Warnings'}
                </button>
              ))}
            </div>
          )}

          {/* Tab content */}
          <ErrorBoundary label="Bottom Dock">
          <div key={bottomTab} className={bottomTab !== 'timeline' ? 'min-h-0 flex-1 overflow-hidden tab-fade-enter' : 'min-h-0 flex-1 overflow-hidden'}>
          {bottomTab === 'timeline' ? (
            <div className="min-h-0 h-full flex flex-col">
              <TrimModeToolbar trimMode={trimMode} onSetTrimMode={onSetTrimMode} />
              <ReviewOverlay
                reviewReport={reviewReport}
                pxPerFrame={zoom}
                totalFrames={totalFrames}
                viewportWidth={800}
              />
              <div className="min-h-0 flex-1">
                <Timeline
                  ref={timelineRef}
                  lanes={lanes}
                  markers={timeline?.markers ?? []}
                  fps={fps}
                  totalFrames={totalFrames}
                  zoom={zoom}
                  playheadFrame={playback.playheadFrame}
                  selectedClipIds={selectedClipIds}
                  clipOverlays={clipOverlays}
                  dropFrame={timeline?.sequence?.timecode_format === 'DF'}
                  projectId={projectId}
                  trimMode={trimMode}
                  trackStates={trackStates}
                  onToggleLock={onToggleLock}
                  onToggleMute={onToggleMute}
                  onToggleSolo={onToggleSolo}
                  onToggleSyncLock={onToggleSyncLock}
                  onCycleHeight={onCycleHeight}
                  snapEnabled={snapEnabled}
                  activeSnapGuide={activeSnapGuide}
                  onZoomChange={onZoomChange}
                  onSeek={playback.seekToFrame}
                  onClearSelection={onClearSelection}
                  onSelectClip={onSelectClip}
                  onTrimBegin={onTrimBegin}
                  onTrimUpdate={onTrimUpdate}
                  onTrimCommit={onTrimCommit}
                  onMarqueeSelect={onMarqueeSelect}
                  markIn={playback.markIn}
                  markOut={playback.markOut}
                  confidenceFilter={confidenceFilter}
                  editorMode={mode}
                />
              </div>
            </div>
          ) : bottomTab === 'patches' ? (
            <PatchPanel
              patchData={reviewPatch}
              dirty={dirty}
              timelineRevision={timelineRevision}
              onApply={onApplyPatch}
              onPreview={onPreviewPatch}
              previewingIndex={previewingPatchIndex}
            />
          ) : bottomTab === 'alternatives' ? (
            <AlternativesPanel
              clipId={selectedClipId}
              alternatives={alternatives}
              loading={alternativesLoading}
              onSwap={onSwapClip}
              onPreview={onPreviewAlternative}
            />
          ) : (
            <DiffPanel
              diffs={clipDiffs}
              baselineRevision={sessionBaselineRevision}
              remoteDiffs={remoteDiffs}
              remoteRevision={remoteCompareRevision}
              onJumpToClip={handleJumpToClip}
            />
          )}
          </div>
          </ErrorBoundary>
        </section>
      </div>
    </main>
  );
}

// ── AI Workspace (right dock in AI mode) ─────────────────────────────

interface AiWorkspaceProps {
  selectedClip: Clip | null;
  fps: number;
  reviewReport: ReviewReportResponse | null;
  reviewPatch: ReviewPatchResponse | null;
  reviewBlueprint: BlueprintResponse | null;
  dirty: boolean;
  timelineRevision: string | null;
  onApplyPatch: (indexes: number[]) => Promise<void>;
  alternatives: AlternativeCandidate[];
  alternativesLoading: boolean;
  selectedClipId: string | null;
  onSwapClip: (candidate: AlternativeCandidate) => void;
  clipDiffs: ClipDiff[];
  remoteDiffs?: ClipDiff[] | null;
  remoteCompareRevision?: string | null;
  sessionBaselineRevision: string | null;
  onUpdateAudioNumber: (field: keyof AudioPolicy, value: number) => void;
  onUpdateAudioBoolean: (field: keyof AudioPolicy, value: boolean) => void;
  onPreviewAlternative?: (candidate: AlternativeCandidate) => void;
  onJumpToClip?: (clipId: string) => void;
  onPreviewPatch?: (filteredIndex: number) => void;
  previewingPatchIndex?: number | null;
}

function AiWorkspace({
  selectedClip,
  fps,
  reviewReport,
  reviewPatch,
  reviewBlueprint,
  dirty,
  timelineRevision,
  onApplyPatch,
  alternatives,
  alternativesLoading,
  selectedClipId,
  onSwapClip,
  clipDiffs,
  remoteDiffs,
  remoteCompareRevision,
  sessionBaselineRevision,
  onUpdateAudioNumber,
  onUpdateAudioBoolean,
  onPreviewAlternative,
  onJumpToClip,
  onPreviewPatch,
  previewingPatchIndex,
}: AiWorkspaceProps) {
  const [aiTab, setAiTab] = useState<'decision' | 'patches' | 'alternatives' | 'diff' | 'inspector'>('decision');

  const tabs: { key: typeof aiTab; label: string }[] = [
    { key: 'decision', label: 'Decision' },
    { key: 'patches', label: 'Patches' },
    { key: 'alternatives', label: 'Alts' },
    { key: 'diff', label: 'Diff' },
    { key: 'inspector', label: 'Inspector' },
  ];

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="flex shrink-0 items-center gap-0.5 border-b border-white/[0.06] px-2 py-1">
        {tabs.map(({ key, label }) => (
          <button
            key={key}
            type="button"
            className={`px-2 py-0.5 text-[11px] font-semibold uppercase tracking-[0.1em] transition ${
              aiTab === key
                ? 'text-[var(--accent)] ai-tab-active'
                : 'text-[color:var(--text-subtle)] hover:text-neutral-300'
            }`}
            onClick={() => setAiTab(key)}
          >
            {label}
          </button>
        ))}
      </div>
      <div key={aiTab} className="min-h-0 flex-1 overflow-hidden tab-fade-enter">
        {aiTab === 'decision' ? (
          <AiDecisionPanel
            clip={selectedClip}
            reviewReport={reviewReport}
            blueprint={reviewBlueprint}
          />
        ) : aiTab === 'patches' ? (
          <PatchPanel
            patchData={reviewPatch}
            dirty={dirty}
            timelineRevision={timelineRevision}
            onApply={onApplyPatch}
            onPreview={onPreviewPatch}
            previewingIndex={previewingPatchIndex}
          />
        ) : aiTab === 'alternatives' ? (
          <AlternativesPanel
            clipId={selectedClipId}
            alternatives={alternatives}
            loading={alternativesLoading}
            onSwap={onSwapClip}
            onPreview={onPreviewAlternative}
            enableStagedReplace
            currentClip={selectedClip}
          />
        ) : aiTab === 'diff' ? (
          <DiffPanel
            diffs={clipDiffs}
            baselineRevision={sessionBaselineRevision}
            remoteDiffs={remoteDiffs}
            remoteRevision={remoteCompareRevision}
            onJumpToClip={onJumpToClip}
          />
        ) : (
          <PropertyPanel
            clip={selectedClip}
            fps={fps}
            reviewReport={reviewReport}
            blueprint={reviewBlueprint}
            onUpdateAudioNumber={onUpdateAudioNumber}
            onUpdateAudioBoolean={onUpdateAudioBoolean}
          />
        )}
      </div>
    </div>
  );
}
