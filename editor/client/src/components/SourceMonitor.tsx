import type { SourceAsset } from '../hooks/useSourcePlayback';
import { formatClockFromFrames } from '../utils/time';

interface SourceMonitorProps {
  isActive: boolean;
  onClick: () => void;
  fps: number;
  // Source playback state
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
  // Video event handlers
  onLoadedMetadata: () => void;
  onCanPlayThrough: () => void;
  onTimeUpdate: () => void;
  onWaiting: () => void;
  onPlaying: () => void;
  onEnded: () => void;
  onVideoError: () => void;
  // Transport
  onTogglePlayback: () => void;
  // Track targets (clickable patch matrix)
  videoTarget: string;
  audioTargets: Set<string>;
  videoTrackIds?: string[];
  audioTrackIds?: string[];
  onToggleVideoTarget?: (trackId: string) => void;
  onToggleAudioTarget?: (trackId: string) => void;
}

function shuttleLabel(speed: number): string {
  if (speed === 0) return '';
  if (speed === 0.25) return '0.25x';
  if (speed === -0.25) return '-0.25x';
  return `${speed > 0 ? '' : ''}${speed}x`;
}

export default function SourceMonitor({
  isActive,
  onClick,
  fps,
  videoRef,
  currentAsset,
  positionFrame,
  durationFrames,
  isPlaying,
  isBuffering,
  markInFrame,
  markOutFrame,
  shuttleSpeed,
  error,
  onLoadedMetadata,
  onCanPlayThrough,
  onTimeUpdate,
  onWaiting,
  onPlaying,
  onEnded,
  onVideoError,
  onTogglePlayback,
  videoTarget,
  audioTargets,
  videoTrackIds,
  audioTrackIds,
  onToggleVideoTarget,
  onToggleAudioTarget,
}: SourceMonitorProps) {
  const timecode = formatClockFromFrames(positionFrame, fps);
  const durationTc = formatClockFromFrames(durationFrames, fps);
  const hasSource = currentAsset !== null;
  const audioTargetList = Array.from(audioTargets).sort();

  return (
    <section
      onClick={onClick}
      className={`flex min-h-0 cursor-pointer flex-col overflow-hidden border-r border-white/[0.06] ${
        isActive ? 'monitor-active' : 'monitor-inactive'
      }`}
    >
      {/* Video / Black frame area */}
      <div className="relative flex min-h-0 flex-1 items-center justify-center bg-black">
        {hasSource ? (
          <>
            {/* Video element (hidden for audio-only sources) */}
            <video
              ref={videoRef}
              className={`h-full w-full object-contain ${currentAsset && !currentAsset.hasVideo ? 'hidden' : ''}`}
              muted={false}
              playsInline
              onLoadedMetadata={onLoadedMetadata}
              onCanPlayThrough={onCanPlayThrough}
              onTimeUpdate={onTimeUpdate}
              onWaiting={onWaiting}
              onPlaying={onPlaying}
              onEnded={onEnded}
              onError={onVideoError}
            />
            {/* Audio-only / no-media: black frame + conditional waveform */}
            {currentAsset && !currentAsset.hasVideo && (
              <div className="flex h-full w-full flex-col items-center justify-center">
                <div className="font-mono text-[11px] uppercase tracking-[0.2em] text-[color:var(--text-subtle)]">
                  {currentAsset.hasAudio ? 'Audio Only' : 'No Media'}
                </div>
                {currentAsset.hasAudio && (
                  <div className="mt-3 flex h-12 w-3/4 items-end justify-center gap-[2px]">
                    {Array.from({ length: 40 }, (_, i) => (
                      <div
                        key={i}
                        className="w-[3px] rounded-sm bg-[var(--accent)]/30"
                        style={{ height: `${20 + Math.abs(Math.sin(i * 0.7)) * 60}%` }}
                      />
                    ))}
                  </div>
                )}
              </div>
            )}
            {/* Buffering overlay */}
            {isBuffering && (
              <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
                <div className="h-5 w-5 animate-spin rounded-full border-2 border-white/30 border-t-white/80" />
              </div>
            )}
            {/* I/O marks bar */}
            {(markInFrame != null || markOutFrame != null) && (
              <div className="pointer-events-none absolute bottom-1 left-2 right-2 flex items-center rounded bg-black/50 px-1.5 py-0.5">
                <span className="font-mono text-[9px] text-[var(--accent)]">
                  {markInFrame != null ? `IN ${formatClockFromFrames(markInFrame, fps)}` : ''}
                </span>
                <span className="flex-1" />
                <span className="font-mono text-[9px] text-[var(--accent)]">
                  {markOutFrame != null ? `OUT ${formatClockFromFrames(markOutFrame, fps)}` : ''}
                </span>
              </div>
            )}
            {/* Shuttle speed indicator */}
            {shuttleSpeed !== 0 && (
              <div className="pointer-events-none absolute right-2 top-2 bg-black/60 px-1.5 py-0.5 font-mono text-[11px] font-bold text-[var(--accent)]">
                {shuttleLabel(shuttleSpeed)}
              </div>
            )}
          </>
        ) : (
          /* Empty state: no source loaded */
          <div className="flex flex-col items-center gap-1">
            <div className="font-mono text-[10px] uppercase tracking-[0.28em] text-[color:var(--text-subtle)]">
              Source Monitor
            </div>
            <div className="text-[12px] text-[color:var(--text-muted)]">
              Select a clip or alternative to preview
            </div>
          </div>
        )}
      </div>

      {/* Transport bar */}
      <div className="flex shrink-0 items-center gap-3 border-t border-white/[0.06] px-3 py-1.5">
        <button
          type="button"
          className="flex h-6 w-6 items-center justify-center bg-white/[0.06] text-[11px] text-white transition hover:bg-white/[0.12]"
          onClick={(e) => { e.stopPropagation(); onTogglePlayback(); }}
          title={isPlaying ? 'Stop (Space)' : 'Play (Space)'}
        >
          {isPlaying ? '\u25A0' : '\u25B6'}
        </button>

        <span className="font-mono text-[15px] font-semibold tabular-nums tracking-[0.06em] text-white">
          {timecode}
        </span>

        <span className="font-mono text-[10px] tabular-nums text-[color:var(--text-muted)]">
          {positionFrame}f
        </span>

        {hasSource && (
          <span className="font-mono text-[10px] text-[color:var(--text-subtle)]">
            / {durationTc}
          </span>
        )}

        <div className="flex-1" />

        {/* Source asset label */}
        {currentAsset && (
          <span className="max-w-[120px] truncate font-mono text-[10px] text-[color:var(--text-subtle)]">
            {currentAsset.label}
          </span>
        )}

        <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-[color:var(--text-subtle)]">
          Source
        </span>
      </div>

      {/* Patch matrix display (clickable) */}
      <div className="flex shrink-0 items-center gap-2 border-t border-white/[0.04] px-3 py-1">
        <span className="font-mono text-[9px] uppercase tracking-[0.12em] text-[color:var(--text-subtle)]">
          Patch
        </span>
        {/* Video target: click to cycle through available video tracks */}
        <button
          type="button"
          className="font-mono text-[9px] text-[var(--accent)] transition hover:text-white"
          onClick={(e) => {
            e.stopPropagation();
            if (!videoTrackIds?.length || !onToggleVideoTarget) return;
            const idx = videoTrackIds.indexOf(videoTarget);
            onToggleVideoTarget(videoTrackIds[(idx + 1) % videoTrackIds.length]);
          }}
          title="Click to cycle video target"
        >
          SV1→{videoTarget}
        </button>
        {/* Audio targets: click to toggle each */}
        {audioTrackIds && audioTrackIds.length > 0 && (
          <span className="flex items-center gap-1 font-mono text-[9px]">
            <span className="text-[color:var(--text-subtle)]">SA→</span>
            {audioTrackIds.map((tid) => (
              <button
                key={tid}
                type="button"
                className={`transition ${
                  audioTargets.has(tid)
                    ? 'text-[var(--accent)]'
                    : 'text-[color:var(--text-subtle)] opacity-50'
                } hover:text-white`}
                onClick={(e) => { e.stopPropagation(); onToggleAudioTarget?.(tid); }}
                title={`Toggle audio target ${tid}`}
              >
                {tid}
              </button>
            ))}
          </span>
        )}
      </div>

      {/* Error display */}
      {error && (
        <div className="shrink-0 border-t border-red-400/20 px-3 py-1 text-[10px] text-[color:var(--danger)]">
          {error}
        </div>
      )}
    </section>
  );
}
