import { formatClockFromFrames } from '../utils/time';
import PreviewPlayer from './PreviewPlayer';
import TransportBar from './TransportBar';

interface ProgramMonitorProps {
  isActive: boolean;
  onClick: () => void;
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
    handleVideoLoadedMetadata: () => void;
    handleVideoCanPlayThrough: () => void;
    handleVideoTimeUpdate: () => void;
    handleVideoWaiting: () => void;
    handleVideoPlaying: () => void;
    handleVideoStalled: () => void;
    handleVideoEnded: () => void;
    handleVideoError: () => void;
    togglePlayback: () => Promise<void>;
  };
  fps: number;
  markIn: number | null;
  markOut: number | null;
  transportTimecode: string;
  currentFrame: number;
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
  onExportRender,
}: ProgramMonitorProps) {
  return (
    <section
      onClick={onClick}
      className={`flex min-h-0 cursor-pointer flex-col overflow-hidden border-r border-white/[0.06] ${
        isActive ? 'monitor-active' : 'monitor-inactive'
      }`}
    >
      <div className="relative min-h-0 flex-1">
      <PreviewPlayer
        videoRef={playback.videoRef}
        previewMode={playback.previewMode}
        renderStatus={playback.renderStatus}
        isPlaying={playback.isPlaying}
        isBuffering={playback.isBuffering}
        isGap={playback.isGap}
        error={playback.error}
        onLoadedMetadata={playback.handleVideoLoadedMetadata}
        onCanPlayThrough={playback.handleVideoCanPlayThrough}
        onTimeUpdate={playback.handleVideoTimeUpdate}
        onWaiting={playback.handleVideoWaiting}
        onPlaying={playback.handleVideoPlaying}
        onStalled={playback.handleVideoStalled}
        onEnded={playback.handleVideoEnded}
        onVideoError={playback.handleVideoError}
      />
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
