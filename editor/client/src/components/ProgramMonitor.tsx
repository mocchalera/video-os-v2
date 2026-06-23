import { formatClockFromFrames } from '../utils/time';
import type { PlaybackContractStatusResponse, PreviewMode } from '../types';
import PreviewPlayer from './PreviewPlayer';
import TransportBar from './TransportBar';

interface ProgramMonitorProps {
  isActive: boolean;
  onClick: () => void;
  playback: {
    videoRef: React.RefObject<HTMLVideoElement | null>;
    exactVideoRef: React.RefObject<HTMLVideoElement | null>;
    previewMode: PreviewMode;
    previewArtifact: {
      previewUrl: string | null;
    };
    renderStatus: 'idle' | 'rendering' | 'ready' | 'error';
    isPlaying: boolean;
    isBuffering: boolean;
    isGap: boolean;
    error: string | null;
    playheadFrame: number;
    previewStale: boolean;
    playbackContract: PlaybackContractStatusResponse | null;
    handleVideoLoadedMetadata: () => void;
    handleVideoCanPlayThrough: () => void;
    handleVideoTimeUpdate: () => void;
    handleVideoWaiting: () => void;
    handleVideoPlaying: () => void;
    handleVideoStalled: () => void;
    handleVideoEnded: () => void;
    handleVideoError: () => void;
    handleExactVideoTimeUpdate: () => void;
    handleExactVideoLoadedMetadata: () => void;
    handleExactVideoEnded: () => void;
    handleExactVideoError: () => void;
    togglePlayback: () => Promise<void>;
  };
  fps: number;
  markIn: number | null;
  markOut: number | null;
  transportTimecode: string;
  currentFrame: number;
  captionText: string | null;
  /** CSS caption style from buildCssCaptionStyle (MAJOR 5). */
  captionStyle: Record<string, string> | null;
  /** Phase 2: Current clip zoom for CSS approximation in source_approx mode. */
  clipZoom: number;
  onExportRender: () => void;
}

export default function ProgramMonitor({
  isActive,
  onClick,
  playback,
  fps,
  markIn,
  markOut,
  transportTimecode,
  currentFrame,
  captionText,
  captionStyle,
  clipZoom,
  onExportRender,
}: ProgramMonitorProps) {
  const isExact = playback.previewMode === 'rendered_exact';

  return (
    <section
      onClick={onClick}
      aria-label="Program Monitor"
      className={`flex h-full min-h-0 cursor-pointer flex-col overflow-hidden border-r border-white/[0.06] ${
        isActive ? 'monitor-active' : 'monitor-inactive'
      }`}
    >
      <div className="relative min-h-0 flex-1 overflow-hidden">
        <PreviewPlayer
          videoRef={playback.videoRef}
          exactVideoRef={playback.exactVideoRef}
          previewMode={playback.previewMode}
          previewUrl={playback.previewArtifact.previewUrl}
          renderStatus={playback.renderStatus}
          isPlaying={playback.isPlaying}
          isBuffering={playback.isBuffering}
          isGap={playback.isGap}
          error={playback.error}
          previewStale={playback.previewStale}
          playbackContract={playback.playbackContract}
          clipZoom={clipZoom}
          onLoadedMetadata={playback.handleVideoLoadedMetadata}
          onCanPlayThrough={playback.handleVideoCanPlayThrough}
          onTimeUpdate={playback.handleVideoTimeUpdate}
          onWaiting={playback.handleVideoWaiting}
          onPlaying={playback.handleVideoPlaying}
          onStalled={playback.handleVideoStalled}
          onEnded={playback.handleVideoEnded}
          onVideoError={playback.handleVideoError}
          onExactTimeUpdate={playback.handleExactVideoTimeUpdate}
          onExactLoadedMetadata={playback.handleExactVideoLoadedMetadata}
          onExactEnded={playback.handleExactVideoEnded}
          onExactError={playback.handleExactVideoError}
        />
        {/* CSS caption overlay — only shown in source_approx mode (Section 6.3).
            In rendered_exact mode, captions are burn-in in the preview artifact.
            MAJOR 5: Style driven by CaptionStylePreset via buildCssCaptionStyle. */}
        {captionText && !isExact && captionStyle ? (
          <div style={captionStyle}>
            {captionText.split('\n').map((line, index) => (
              <span key={`${index}-${line}`}>
                {index > 0 ? <br /> : null}
                {line}
              </span>
            ))}
          </div>
        ) : null}
        {/* I/O marks overlay */}
        {(markIn != null || markOut != null) && (
          <div className="pointer-events-none absolute bottom-1 left-2 right-2 flex items-center rounded bg-black/50 px-1.5 py-0.5">
            <span className="font-mono text-[9px] text-[var(--accent)]">
              {markIn != null ? `IN ${formatClockFromFrames(markIn, fps)}` : ''}
            </span>
            <span className="flex-1" />
            <span className="font-mono text-[9px] text-[var(--accent)]">
              {markOut != null ? `OUT ${formatClockFromFrames(markOut, fps)}` : ''}
            </span>
          </div>
        )}
      </div>
      <TransportBar
        isPlaying={playback.isPlaying}
        timecode={transportTimecode}
        currentFrame={currentFrame}
        previewMode={playback.previewMode}
        renderStatus={playback.renderStatus}
        previewStale={playback.previewStale}
        onTogglePlayback={() => { void playback.togglePlayback(); }}
        onExportRender={onExportRender}
      />
    </section>
  );
}
