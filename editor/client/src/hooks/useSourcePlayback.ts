import { useEffect, useRef, useState } from 'react';
import { clamp, framesToSeconds, secondsToFrames } from '../utils/time';

// ── Source map types (shared shape with usePlayback) ─────────────────

interface SourceMapAsset {
  media_id: string;
  playback_strategy: { kind: string; url: string };
}

interface SourceMapItem {
  asset_id: string;
  link_path?: string;
  source_locator?: string;
  local_source_path?: string;
  filename?: string;
}

interface SourceMapData {
  items: SourceMapItem[];
  assets?: Record<string, SourceMapAsset>;
}

// ── Public types ─────────────────────────────────────────────────────

export interface SourceAsset {
  assetId: string;
  label: string;
  mediaUrl: string;
  hasVideo: boolean;
  hasAudio: boolean;
}

interface UseSourcePlaybackOptions {
  projectId: string;
  fps: number;
}

/**
 * Independent playback channel for Source Monitor.
 * Plays a single asset directly (not timeline-mapped).
 */
export function useSourcePlayback({ projectId, fps }: UseSourcePlaybackOptions) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const sourceMapRef = useRef<SourceMapData | null>(null);
  const rafRef = useRef<number | null>(null);
  const reverseRafRef = useRef<number | null>(null);

  const [currentAsset, setCurrentAsset] = useState<SourceAsset | null>(null);
  const [positionSec, setPositionSec] = useState(0);
  const [durationSec, setDurationSec] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isBuffering, setIsBuffering] = useState(false);
  const [markInUs, setMarkInState] = useState<number | null>(null);
  const [markOutUs, setMarkOutState] = useState<number | null>(null);
  const [shuttleSpeed, setShuttleSpeedState] = useState(0);
  const [loopEnabled, setLoopEnabled] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sourceMapLoaded, setSourceMapLoaded] = useState(false);

  // ── Stable refs ────────────────────────────────────────────────────
  const positionSecRef = useRef(positionSec);
  positionSecRef.current = positionSec;
  const isPlayingRef = useRef(isPlaying);
  isPlayingRef.current = isPlaying;
  const shuttleSpeedRef = useRef(shuttleSpeed);
  shuttleSpeedRef.current = shuttleSpeed;
  const markInUsRef = useRef(markInUs);
  markInUsRef.current = markInUs;
  const markOutUsRef = useRef(markOutUs);
  markOutUsRef.current = markOutUs;
  const fpsRef = useRef(fps);
  fpsRef.current = fps;
  const durationSecRef = useRef(durationSec);
  durationSecRef.current = durationSec;
  const loopEnabledRef = useRef(loopEnabled);
  loopEnabledRef.current = loopEnabled;

  // ── Derived values ─────────────────────────────────────────────────
  const positionFrame = secondsToFrames(positionSec, fps);
  const durationFrames = Math.max(1, secondsToFrames(durationSec, fps));
  const markInFrame =
    markInUs != null ? secondsToFrames(markInUs / 1_000_000, fps) : null;
  const markOutFrame =
    markOutUs != null ? secondsToFrames(markOutUs / 1_000_000, fps) : null;

  // ── Source map loading ─────────────────────────────────────────────
  useEffect(() => {
    if (!projectId) {
      sourceMapRef.current = null;
      setSourceMapLoaded(false);
      return;
    }

    let cancelled = false;
    fetch(`/api/projects/${projectId}/source-map`)
      .then((r) => (r.ok ? (r.json() as Promise<SourceMapData>) : Promise.reject()))
      .then((data) => {
        if (!cancelled) {
          sourceMapRef.current = data;
          setSourceMapLoaded(true);
        }
      })
      .catch(() => {
        if (!cancelled) {
          sourceMapRef.current = null;
          setSourceMapLoaded(false);
        }
      });

    return () => { cancelled = true; };
  }, [projectId]);

  // ── Helpers ────────────────────────────────────────────────────────

  function getMediaUrl(assetId: string): string | null {
    const sm = sourceMapRef.current;
    if (!sm) return null;

    if (sm.assets?.[assetId]) {
      return sm.assets[assetId].playback_strategy.url;
    }

    const entry = sm.items.find((i) => i.asset_id === assetId);
    if (!entry) return null;

    const filename =
      entry.filename ??
      entry.link_path?.split('/').pop() ??
      entry.local_source_path?.split('/').pop() ??
      entry.source_locator?.split('/').pop();
    if (!filename) return null;
    return `/api/projects/${projectId}/media/${encodeURIComponent(filename)}`;
  }

  function cancelAnimationFrames(): void {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    if (reverseRafRef.current !== null) {
      cancelAnimationFrame(reverseRafRef.current);
      reverseRafRef.current = null;
    }
  }

  // ── Playback loops ─────────────────────────────────────────────────

  function startPlaybackLoop(): void {
    cancelAnimationFrames();

    const tick = () => {
      const video = videoRef.current;
      if (!video || !isPlayingRef.current) return;

      setPositionSec(video.currentTime);

      // Loop detection: when reaching markOut, jump to markIn (only if loop enabled)
      if (loopEnabledRef.current) {
        const outUs = markOutUsRef.current;
        const inUs = markInUsRef.current;
        if (outUs != null && video.currentTime >= outUs / 1_000_000) {
          if (inUs != null) {
            video.currentTime = inUs / 1_000_000;
            setPositionSec(inUs / 1_000_000);
          }
        }
      }

      rafRef.current = requestAnimationFrame(tick);
    };

    rafRef.current = requestAnimationFrame(tick);
  }

  function startReverseLoop(speed: number): void {
    let lastTime = performance.now();
    let frameAccumulator = 0;

    const tick = (now: number) => {
      if (!isPlayingRef.current) return;
      const video = videoRef.current;
      if (!video) return;

      const elapsed = (now - lastTime) / 1000;
      lastTime = now;

      // Accumulate fractional frames; only step when >= 1 whole frame
      frameAccumulator += Math.abs(speed) * fpsRef.current * elapsed;
      const wholeFrames = Math.floor(frameAccumulator);
      if (wholeFrames < 1) {
        reverseRafRef.current = requestAnimationFrame(tick);
        return;
      }
      frameAccumulator -= wholeFrames;
      const seekDelta = wholeFrames / Math.max(fpsRef.current, 1);
      const newTime = Math.max(0, video.currentTime - seekDelta);
      video.currentTime = newTime;
      setPositionSec(newTime);

      // Reverse loop: when reaching markIn, jump to markOut (only if loop enabled)
      if (loopEnabledRef.current) {
        const inUs = markInUsRef.current;
        if (inUs != null && newTime <= inUs / 1_000_000) {
          const outUs = markOutUsRef.current;
          if (outUs != null) {
            video.currentTime = outUs / 1_000_000;
            setPositionSec(outUs / 1_000_000);
          }
        }
      }

      if (newTime <= 0) {
        setIsPlaying(false);
        setShuttleSpeedState(0);
        return;
      }

      reverseRafRef.current = requestAnimationFrame(tick);
    };

    reverseRafRef.current = requestAnimationFrame(tick);
  }

  // ── Public API ─────────────────────────────────────────────────────

  function loadSource(assetId: string, label: string): void {
    cancelAnimationFrames();
    const video = videoRef.current;
    if (video) video.pause();

    const mediaUrl = getMediaUrl(assetId);
    if (!mediaUrl) {
      setError(`Media not found for asset ${assetId}`);
      setCurrentAsset(null);
      return;
    }

    // Default topology — updated by server probe below
    setCurrentAsset({ assetId, label, mediaUrl, hasVideo: true, hasAudio: true });
    setPositionSec(0);
    setDurationSec(0);
    setIsPlaying(false);
    setIsBuffering(false);
    setMarkInState(null);
    setMarkOutState(null);
    setShuttleSpeedState(0);
    setError(null);

    if (video) {
      video.src = mediaUrl;
      video.load();
    }

    // Server-side probe for reliable has_video/has_audio (works on all browsers)
    fetch(`/api/projects/${projectId}/media/probe/${encodeURIComponent(assetId)}`)
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((probe: { has_video: boolean; has_audio: boolean }) => {
        setCurrentAsset((prev) =>
          prev && prev.assetId === assetId
            ? { ...prev, hasVideo: probe.has_video, hasAudio: probe.has_audio }
            : prev,
        );
      })
      .catch(() => { /* keep defaults on probe failure */ });
  }

  function play(): void {
    const video = videoRef.current;
    if (!video || !currentAsset) return;

    setIsPlaying(true);
    setIsBuffering(true);
    video.playbackRate = 1;
    void video.play().then(() => {
      startPlaybackLoop();
    }).catch(() => {
      setIsPlaying(false);
      setIsBuffering(false);
    });
  }

  function pause(): void {
    cancelAnimationFrames();
    videoRef.current?.pause();
    setIsPlaying(false);
    setIsBuffering(false);
    setShuttleSpeedState(0);
  }

  function togglePlayback(): void {
    if (isPlayingRef.current) pause();
    else play();
  }

  function seek(sec: number): void {
    const video = videoRef.current;
    if (!video) return;
    const clamped = clamp(sec, 0, durationSecRef.current || Infinity);
    video.currentTime = clamped;
    setPositionSec(clamped);
  }

  function seekToFrame(frame: number): void {
    seek(framesToSeconds(frame, fpsRef.current));
  }

  function stepFrame(delta: number): void {
    if (isPlayingRef.current) pause();
    const newFrame = clamp(positionFrame + delta, 0, durationFrames);
    seekToFrame(newFrame);
  }

  // ── Marks ──────────────────────────────────────────────────────────

  function setMarkIn(): void {
    setMarkInState(Math.round(positionSecRef.current * 1_000_000));
  }

  function setMarkOut(): void {
    setMarkOutState(Math.round(positionSecRef.current * 1_000_000));
  }

  function clearMarkIn(): void { setMarkInState(null); }
  function clearMarkOut(): void { setMarkOutState(null); }

  // ── Shuttle ────────────────────────────────────────────────────────

  function setShuttleSpeed(speed: number): void {
    setShuttleSpeedState(speed);
    const video = videoRef.current;
    if (!video || !currentAsset) return;

    if (speed === 0) {
      cancelAnimationFrames();
      video.pause();
      setIsPlaying(false);
      return;
    }

    setIsPlaying(true);

    if (speed > 0) {
      cancelAnimationFrames();
      video.playbackRate = Math.min(speed, 16);
      if (video.paused) {
        void video.play().then(() => startPlaybackLoop()).catch(() => {
          setIsPlaying(false);
        });
      } else {
        startPlaybackLoop();
      }
    } else {
      // Reverse: RAF-based frame stepping
      video.pause();
      cancelAnimationFrames();
      startReverseLoop(speed);
    }
  }

  // ── Video event handlers ───────────────────────────────────────────

  function handleVideoLoadedMetadata(): void {
    const video = videoRef.current;
    if (video && Number.isFinite(video.duration)) {
      setDurationSec(video.duration);
      // hasVideo/hasAudio are now set by server-side probe in loadSource()
    }
    setIsBuffering(false);
  }

  function handleVideoCanPlayThrough(): void {
    setIsBuffering(false);
  }

  function handleVideoTimeUpdate(): void {
    // Only as fallback when RAF loop isn't running
    if (rafRef.current !== null || reverseRafRef.current !== null) return;
    const video = videoRef.current;
    if (video) setPositionSec(video.currentTime);
  }

  function handleVideoWaiting(): void { setIsBuffering(true); }
  function handleVideoPlaying(): void { setIsBuffering(false); }

  function handleVideoEnded(): void {
    if (loopEnabledRef.current) {
      const inUs = markInUsRef.current;
      const outUs = markOutUsRef.current;
      if (inUs != null && outUs != null) {
        const video = videoRef.current;
        if (video) {
          video.currentTime = inUs / 1_000_000;
          void video.play();
          return;
        }
      }
    }
    setIsPlaying(false);
    setShuttleSpeedState(0);
  }

  function handleVideoError(): void {
    cancelAnimationFrames();
    setIsPlaying(false);
    setIsBuffering(false);
    const video = videoRef.current;
    const msg = video?.error
      ? `Source error: ${video.error.message || `code ${video.error.code}`}`
      : 'Source playback error';
    setError(msg);
  }

  // ── Lifecycle ──────────────────────────────────────────────────────

  useEffect(() => () => cancelAnimationFrames(), []);

  useEffect(() => {
    cancelAnimationFrames();
    videoRef.current?.pause();
    setCurrentAsset(null);
    setPositionSec(0);
    setDurationSec(0);
    setIsPlaying(false);
    setIsBuffering(false);
    setMarkInState(null);
    setMarkOutState(null);
    setShuttleSpeedState(0);
    setError(null);
  }, [projectId]);

  return {
    videoRef,
    currentAsset,
    positionSec,
    positionFrame,
    durationSec,
    durationFrames,
    isPlaying,
    isBuffering,
    markInUs,
    markOutUs,
    markInFrame,
    markOutFrame,
    shuttleSpeed,
    loopEnabled,
    setLoopEnabled,
    error,
    sourceMapLoaded,
    loadSource,
    play,
    pause,
    togglePlayback,
    seek,
    seekToFrame,
    stepFrame,
    setMarkIn,
    setMarkOut,
    clearMarkIn,
    clearMarkOut,
    setShuttleSpeed,
    handleVideoLoadedMetadata,
    handleVideoCanPlayThrough,
    handleVideoTimeUpdate,
    handleVideoWaiting,
    handleVideoPlaying,
    handleVideoEnded,
    handleVideoError,
  };
}
