import { useEffect, useMemo, useRef, useState } from 'react';
import type { Clip, PreviewResponse, TimelineIR, TrackHeaderState } from '../types';
import { clamp, framesToSeconds, secondsToFrames } from '../utils/time';

interface UsePlaybackOptions {
  projectId: string;
  fps: number;
  durationFrames: number;
  /** Sequence start frame (usually 0). Playhead resets to this on project load. */
  startFrame?: number;
  timeline: TimelineIR | null;
  /** Track states for mute/solo filtering. If omitted, all tracks play. */
  trackStates?: Record<string, TrackHeaderState>;
}

interface SourceMapAsset {
  media_id: string;
  playback_strategy: {
    kind: string;
    url: string;
  };
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

interface RequestFullPreviewOptions {
  timelineRevision?: string | null;
}

interface PendingSourceSync {
  clip: Clip;
  frame: number;
  shouldPlay: boolean;
  mediaUrl: string;
}

interface GapPlaybackSession {
  startTimestamp: number;
  startFrame: number;
  endFrame: number;
}

const DRIFT_TOLERANCE_SEC = 0.05;

/**
 * Source-based playback hook.
 *
 * v3: Uses requestVideoFrameCallback for frame-accurate playback when available,
 * falls back to RAF polling. Supports transcode fallback on MEDIA_ERR_SRC_NOT_SUPPORTED.
 * Uses by-asset media URLs from source-map v3 assets map.
 */
export function usePlayback({
  projectId,
  fps,
  durationFrames,
  startFrame = 0,
  timeline,
  trackStates,
}: UsePlaybackOptions) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const activeClipRef = useRef<Clip | null>(null);
  const currentMediaUrlRef = useRef<string | null>(null);
  const pendingSourceSyncRef = useRef<PendingSourceSync | null>(null);
  const gapTimeoutRef = useRef<number | null>(null);
  const gapRafRef = useRef<number | null>(null);
  const gapSessionRef = useRef<GapPlaybackSession | null>(null);
  const sourceMapRef = useRef<SourceMapData | null>(null);
  const rVFCHandleRef = useRef<number | null>(null);
  const rafHandleRef = useRef<number | null>(null);
  /** Set of asset_ids for which transcode fallback has been attempted. */
  const transcodeFallbackAttemptedRef = useRef<Set<string>>(new Set());

  // ── Audio-only playback (hidden <audio> element for video-gap regions) ──
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const activeAudioClipRef = useRef<Clip | null>(null);
  const currentAudioUrlRef = useRef<string | null>(null);

  const [playheadFrame, setPlayheadFrame] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isBuffering, setIsBuffering] = useState(false);
  const [isGap, setIsGap] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sourceMapLoaded, setSourceMapLoaded] = useState(false);
  const [renderStatus, setRenderStatus] = useState<
    'idle' | 'rendering' | 'ready' | 'error'
  >('idle');
  const [previewStale, setPreviewStale] = useState(false);

  // ── Phase 3: Shuttle, Marks, Loop ──────────────────────────────────
  const [shuttleSpeed, setShuttleSpeedState] = useState(0);
  const [markIn, setMarkInState] = useState<number | null>(null);
  const [markOut, setMarkOutState] = useState<number | null>(null);
  const [loopEnabled, setLoopEnabled] = useState(false);
  const shuttleSpeedRef = useRef(shuttleSpeed);
  shuttleSpeedRef.current = shuttleSpeed;
  const markInRef = useRef(markIn);
  markInRef.current = markIn;
  const markOutRef = useRef(markOut);
  markOutRef.current = markOut;
  const loopEnabledRef = useRef(loopEnabled);
  loopEnabledRef.current = loopEnabled;
  const reverseRafRef = useRef<number | null>(null);

  const playheadFrameRef = useRef(playheadFrame);
  playheadFrameRef.current = playheadFrame;
  const isPlayingRef = useRef(isPlaying);
  isPlayingRef.current = isPlaying;

  const videoClips = useMemo(() => {
    if (!timeline) return [];
    // Solo is per-kind: only check video tracks for video solo.
    // Audio solo must not black out video tracks.
    const hasVideoSolo = trackStates
      ? timeline.tracks.video.some((track) => trackStates[track.track_id]?.solo)
      : false;
    return timeline.tracks.video
      .filter((track) => {
        if (!trackStates) return true;
        const state = trackStates[track.track_id];
        if (!state) return true;
        if (hasVideoSolo) return state.solo;
        return !state.muted;
      })
      .flatMap((track) => track.clips)
      .sort((a, b) => a.timeline_in_frame - b.timeline_in_frame);
  }, [timeline, trackStates]);

  const audioClips = useMemo(() => {
    if (!timeline) return [];
    const hasAudioSolo = trackStates
      ? timeline.tracks.audio.some((track) => trackStates[track.track_id]?.solo)
      : false;
    return timeline.tracks.audio
      .filter((track) => {
        if (!trackStates) return true;
        const state = trackStates[track.track_id];
        if (!state) return true;
        if (hasAudioSolo) return state.solo;
        return !state.muted;
      })
      .flatMap((track) => track.clips)
      .sort((a, b) => a.timeline_in_frame - b.timeline_in_frame);
  }, [timeline, trackStates]);

  const videoClipsRef = useRef(videoClips);
  videoClipsRef.current = videoClips;
  const audioClipsRef = useRef(audioClips);
  audioClipsRef.current = audioClips;
  const fpsRef = useRef(fps);
  fpsRef.current = fps;
  const durationFramesRef = useRef(durationFrames);
  durationFramesRef.current = durationFrames;
  const projectIdRef = useRef(projectId);
  projectIdRef.current = projectId;
  const startFrameRef = useRef(startFrame);
  startFrameRef.current = startFrame;

  // Check if requestVideoFrameCallback is available
  const hasRVFC = typeof HTMLVideoElement !== 'undefined' &&
    'requestVideoFrameCallback' in HTMLVideoElement.prototype;

  // ── Source map loading ─────────────────────────────────────────────
  useEffect(() => {
    if (!projectId) {
      sourceMapRef.current = null;
      setSourceMapLoaded(false);
      return;
    }

    let cancelled = false;

    async function load(): Promise<void> {
      try {
        // v3: use the source-map API endpoint (not media/:filename)
        const response = await fetch(
          `/api/projects/${projectId}/source-map`,
        );
        if (!response.ok) {
          throw new Error('Not found');
        }

        const data = (await response.json()) as SourceMapData;
        if (cancelled) return;

        sourceMapRef.current = data;
        setSourceMapLoaded(true);
      } catch {
        if (cancelled) return;
        sourceMapRef.current = null;
        setSourceMapLoaded(false);
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  // ── Helpers ────────────────────────────────────────────────────────

  function getClipEndFrame(clip: Clip): number {
    return clip.timeline_in_frame + clip.timeline_duration_frames;
  }

  function clearGapPlayback(): void {
    if (gapTimeoutRef.current !== null) {
      window.clearTimeout(gapTimeoutRef.current);
      gapTimeoutRef.current = null;
    }
    if (gapRafRef.current !== null) {
      window.cancelAnimationFrame(gapRafRef.current);
      gapRafRef.current = null;
    }
    gapSessionRef.current = null;
  }

  function cancelFrameCallbacks(): void {
    if (rVFCHandleRef.current !== null && videoRef.current) {
      (videoRef.current as any).cancelVideoFrameCallback(rVFCHandleRef.current);
      rVFCHandleRef.current = null;
    }
    if (rafHandleRef.current !== null) {
      window.cancelAnimationFrame(rafHandleRef.current);
      rafHandleRef.current = null;
    }
  }

  function pauseVideoElement(): void {
    cancelFrameCallbacks();
    videoRef.current?.pause();
    setIsBuffering(false);
  }

  function clearVideoSource(): void {
    const video = videoRef.current;
    if (!video) return;

    cancelFrameCallbacks();
    video.pause();
    if (video.getAttribute('src')) {
      video.removeAttribute('src');
      video.load();
    }
  }

  /**
   * v3: Resolve media URL from source-map assets map (by-asset endpoint).
   * Falls back to legacy filename-based URL if assets map is unavailable.
   */
  function getMediaUrl(assetId: string): string | null {
    const sourceMap = sourceMapRef.current;
    if (!sourceMap) return null;

    // v3 assets map (preferred)
    if (sourceMap.assets?.[assetId]) {
      return sourceMap.assets[assetId].playback_strategy.url;
    }

    // Legacy fallback: filename-based URL
    const entry = sourceMap.items.find((item) => item.asset_id === assetId);
    if (!entry) return null;

    const filename =
      entry.filename
      ?? entry.link_path?.split('/').pop()
      ?? entry.local_source_path?.split('/').pop()
      ?? entry.source_locator?.split('/').pop();

    if (!filename) return null;
    return `/api/projects/${projectIdRef.current}/media/${encodeURIComponent(filename)}`;
  }

  /**
   * v3: Get transcode fallback URL for MEDIA_ERR_SRC_NOT_SUPPORTED recovery.
   * Appends ?transcode=1 to the by-asset URL to signal the server to force transcode.
   */
  function getTranscodeFallbackUrl(assetId: string): string | null {
    const baseUrl = getMediaUrl(assetId);
    if (!baseUrl) return null;
    const sep = baseUrl.includes('?') ? '&' : '?';
    return `${baseUrl}${sep}transcode=1`;
  }

  function findClipAtFrame(frame: number): Clip | null {
    const clips = videoClipsRef.current;
    for (const clip of clips) {
      const clipEnd = getClipEndFrame(clip);
      if (frame >= clip.timeline_in_frame && frame < clipEnd) {
        return clip;
      }
    }
    return null;
  }

  function findNextClipAfterFrame(frame: number): Clip | null {
    return videoClipsRef.current.find((clip) => clip.timeline_in_frame > frame) ?? null;
  }

  function findAudioClipAtFrame(frame: number): Clip | null {
    const clips = audioClipsRef.current;
    for (const clip of clips) {
      if (frame >= clip.timeline_in_frame && frame < getClipEndFrame(clip)) {
        return clip;
      }
    }
    return null;
  }

  function findNextAudioClipAfterFrame(frame: number): Clip | null {
    return audioClipsRef.current.find((clip) => clip.timeline_in_frame > frame) ?? null;
  }

  /** Sync the hidden audio element to an audio clip (for audio-only regions). */
  function syncAudioElement(clip: Clip, frame: number, shouldPlay: boolean): void {
    const audio = audioRef.current;
    if (!audio) return;

    const mediaUrl = getMediaUrl(clip.asset_id);
    if (!mediaUrl) {
      clearAudioElement();
      return;
    }

    activeAudioClipRef.current = clip;
    const sourceTime = computeSourceTimeSec(clip, frame);

    if (mediaUrl !== currentAudioUrlRef.current) {
      currentAudioUrlRef.current = mediaUrl;
      audio.pause();
      audio.src = mediaUrl;
      const onReady = () => {
        audio.removeEventListener('canplaythrough', onReady);
        audio.currentTime = sourceTime;
        if (shouldPlay) {
          const speed = shuttleSpeedRef.current;
          audio.playbackRate = speed > 0 ? Math.min(speed, 16) : 1;
          void audio.play().catch(() => {});
        }
      };
      audio.addEventListener('canplaythrough', onReady, { once: true });
      audio.load();
      return;
    }

    // Same source — seek if needed
    if (Math.abs(audio.currentTime - sourceTime) > DRIFT_TOLERANCE_SEC) {
      audio.currentTime = sourceTime;
    }
    if (shouldPlay) {
      const speed = shuttleSpeedRef.current;
      audio.playbackRate = speed > 0 ? Math.min(speed, 16) : 1;
      if (audio.paused) void audio.play().catch(() => {});
    } else {
      audio.pause();
    }
  }

  function clearAudioElement(): void {
    const audio = audioRef.current;
    if (!audio) return;
    audio.pause();
    if (audio.getAttribute('src') || audio.src) {
      audio.removeAttribute('src');
      audio.load();
    }
    activeAudioClipRef.current = null;
    currentAudioUrlRef.current = null;
  }

  function computeSourceTimeSec(clip: Clip, frame: number): number {
    const offsetFrames = clamp(
      frame - clip.timeline_in_frame,
      0,
      clip.timeline_duration_frames,
    );
    return clip.src_in_us / 1_000_000 + framesToSeconds(offsetFrames, fpsRef.current);
  }

  function computeTimelineFrameFromCurrentTime(
    clip: Clip,
    currentTimeSec: number,
  ): number {
    const elapsedSec = Math.max(0, currentTimeSec - clip.src_in_us / 1_000_000);
    const sourceOffsetFrames = secondsToFrames(elapsedSec, fpsRef.current);
    return clamp(
      clip.timeline_in_frame + sourceOffsetFrames,
      clip.timeline_in_frame,
      getClipEndFrame(clip),
    );
  }

  function stopPlaybackAtFrame(frame: number): void {
    clearGapPlayback();
    cancelFrameCallbacks();
    pendingSourceSyncRef.current = null;
    pauseVideoElement();
    audioRef.current?.pause();
    setIsPlaying(false);
    setPlayheadFrame(clamp(frame, startFrameRef.current, durationFramesRef.current));
  }

  function handlePlayRejection(playError: unknown): void {
    stopPlaybackAtFrame(playheadFrameRef.current);
    setError(
      playError instanceof Error
        ? playError.message
        : 'Video playback could not start.',
    );
  }

  // ── requestVideoFrameCallback loop ─────────────────────────────────
  function startRVFCLoop(): void {
    const video = videoRef.current;
    if (!video || !hasRVFC) return;

    const callback = (_now: number, metadata: { mediaTime: number }) => {
      const activeClip = activeClipRef.current;
      if (!activeClip || pendingSourceSyncRef.current) {
        // Re-register if still playing
        if (isPlayingRef.current && videoRef.current) {
          rVFCHandleRef.current = (videoRef.current as any).requestVideoFrameCallback(callback);
        }
        return;
      }

      const nextFrame = computeTimelineFrameFromCurrentTime(activeClip, metadata.mediaTime);
      setPlayheadFrame(nextFrame);

      // Loop detection: when reaching markOut, jump to markIn (only if loop enabled)
      if (loopEnabledRef.current) {
        const mOut = markOutRef.current;
        const mIn = markInRef.current;
        if (mOut != null && nextFrame >= mOut && mIn != null) {
          syncPlaybackToFrame(mIn, true);
          return;
        }
      }

      // Check clip boundary
      const clipEndFrame = getClipEndFrame(activeClip);
      const clipOutSec = activeClip.src_out_us / 1_000_000;
      const boundaryEpsilonSec = 0.5 / Math.max(fpsRef.current, 1);

      if (
        metadata.mediaTime >= clipOutSec - boundaryEpsilonSec ||
        nextFrame >= clipEndFrame
      ) {
        syncPlaybackToFrame(clipEndFrame, isPlayingRef.current);
        return;
      }

      // Continue loop
      if (isPlayingRef.current && videoRef.current) {
        rVFCHandleRef.current = (videoRef.current as any).requestVideoFrameCallback(callback);
      }
    };

    rVFCHandleRef.current = (video as any).requestVideoFrameCallback(callback);
  }

  // ── RAF fallback loop ──────────────────────────────────────────────
  function startRAFFallbackLoop(): void {
    const tick = () => {
      const video = videoRef.current;
      const activeClip = activeClipRef.current;
      if (!video || !activeClip || pendingSourceSyncRef.current) {
        if (isPlayingRef.current) {
          rafHandleRef.current = window.requestAnimationFrame(tick);
        }
        return;
      }

      const nextFrame = computeTimelineFrameFromCurrentTime(activeClip, video.currentTime);
      setPlayheadFrame(nextFrame);

      // Loop detection (only if loop enabled)
      if (loopEnabledRef.current) {
        const mOut = markOutRef.current;
        const mIn = markInRef.current;
        if (mOut != null && nextFrame >= mOut && mIn != null) {
          syncPlaybackToFrame(mIn, true);
          return;
        }
      }

      const clipEndFrame = getClipEndFrame(activeClip);
      const clipOutSec = activeClip.src_out_us / 1_000_000;
      const boundaryEpsilonSec = 0.5 / Math.max(fpsRef.current, 1);

      if (
        video.currentTime >= clipOutSec - boundaryEpsilonSec ||
        nextFrame >= clipEndFrame
      ) {
        syncPlaybackToFrame(clipEndFrame, isPlayingRef.current);
        return;
      }

      if (isPlayingRef.current) {
        rafHandleRef.current = window.requestAnimationFrame(tick);
      }
    };

    rafHandleRef.current = window.requestAnimationFrame(tick);
  }

  function startPlaybackLoop(): void {
    cancelFrameCallbacks();
    if (hasRVFC) {
      startRVFCLoop();
    } else {
      startRAFFallbackLoop();
    }
  }

  function startVideoPlayback(video: HTMLVideoElement): void {
    setIsBuffering(true);
    // Apply shuttle speed if active
    const speed = shuttleSpeedRef.current;
    if (speed > 0) {
      video.playbackRate = Math.min(speed, 16);
    } else if (speed === 0) {
      video.playbackRate = 1;
    }
    void video.play().then(() => {
      startPlaybackLoop();
    }).catch((playError) => {
      handlePlayRejection(playError);
    });
  }

  // ── Gap playback ──────────────────────────────────────────────────

  function startGapPlayback(startFrame: number, endFrame: number): void {
    clearGapPlayback();

    if (endFrame <= startFrame) return;

    gapSessionRef.current = {
      startTimestamp: performance.now(),
      startFrame,
      endFrame,
    };

    const tick = (timestamp: number) => {
      const session = gapSessionRef.current;
      if (!session || !isPlayingRef.current) return;

      const elapsedSec = (timestamp - session.startTimestamp) / 1000;
      const nextFrame = clamp(
        session.startFrame + secondsToFrames(elapsedSec, fpsRef.current),
        session.startFrame,
        session.endFrame,
      );

      setPlayheadFrame(nextFrame);

      if (nextFrame >= session.endFrame) return;

      gapRafRef.current = window.requestAnimationFrame(tick);
    };

    gapRafRef.current = window.requestAnimationFrame(tick);

    const gapDurationMs = framesToSeconds(endFrame - startFrame, fpsRef.current) * 1000;
    gapTimeoutRef.current = window.setTimeout(() => {
      clearGapPlayback();
      if (!isPlayingRef.current) return;
      syncPlaybackToFrame(endFrame, true);
    }, gapDurationMs);
  }

  function enterGap(frame: number, shouldPlay: boolean): void {
    pendingSourceSyncRef.current = null;
    activeClipRef.current = null;
    currentMediaUrlRef.current = null;
    cancelFrameCallbacks();
    setIsGap(true);
    setPlayheadFrame(frame);
    clearVideoSource();
    setIsBuffering(false);

    // Always clear previous gap audio before evaluating the new gap region
    clearAudioElement();

    // Check for audio clip at this frame (audio-only region)
    const audioClip = findAudioClipAtFrame(frame);
    if (audioClip) {
      syncAudioElement(audioClip, frame, shouldPlay);
    }

    if (!shouldPlay) {
      clearGapPlayback();
      return;
    }

    // Find next boundary: end of current audio clip, next video clip, or next audio clip
    const audioClipEnd = audioClip ? getClipEndFrame(audioClip) : Infinity;
    const nextVideoClip = findNextClipAfterFrame(frame);
    const nextAudioClip = findNextAudioClipAfterFrame(frame);

    let nextBoundary = durationFramesRef.current;
    if (audioClipEnd < nextBoundary) nextBoundary = audioClipEnd;
    if (nextVideoClip && nextVideoClip.timeline_in_frame < nextBoundary) {
      nextBoundary = nextVideoClip.timeline_in_frame;
    }
    if (nextAudioClip && nextAudioClip.timeline_in_frame < nextBoundary) {
      nextBoundary = nextAudioClip.timeline_in_frame;
    }

    if (nextBoundary <= frame) {
      if (frame < durationFramesRef.current) {
        startGapPlayback(frame, durationFramesRef.current);
      } else {
        stopPlaybackAtFrame(durationFramesRef.current);
      }
      return;
    }

    startGapPlayback(frame, nextBoundary);
  }

  // ── Clip synchronization ──────────────────────────────────────────

  function syncVideoToClip(
    clip: Clip,
    frame: number,
    shouldPlay: boolean,
  ): void {
    const video = videoRef.current;
    if (!video) return;

    clearGapPlayback();
    cancelFrameCallbacks();
    // Clear any stale audio element from a previous gap region to prevent double playback
    clearAudioElement();

    const mediaUrl = getMediaUrl(clip.asset_id);
    if (!mediaUrl) {
      stopPlaybackAtFrame(frame);
      setIsGap(true);
      setError(`Media source not found for asset ${clip.asset_id}.`);
      clearVideoSource();
      return;
    }

    const previousClipId = activeClipRef.current?.clip_id ?? null;
    activeClipRef.current = clip;
    setIsGap(false);
    setError(null);

    if (mediaUrl !== currentMediaUrlRef.current) {
      currentMediaUrlRef.current = mediaUrl;
      pendingSourceSyncRef.current = {
        clip,
        frame,
        shouldPlay,
        mediaUrl,
      };

      video.pause();
      video.src = mediaUrl;
      video.load();
      setIsBuffering(shouldPlay);
      return;
    }

    pendingSourceSyncRef.current = null;

    const sourceTime = computeSourceTimeSec(clip, frame);
    const needsSeek =
      previousClipId !== clip.clip_id
      || Math.abs(video.currentTime - sourceTime) > DRIFT_TOLERANCE_SEC;

    if (needsSeek) {
      video.currentTime = sourceTime;
    }

    if (shouldPlay) {
      startVideoPlayback(video);
      return;
    }

    pauseVideoElement();
  }

  function syncPlaybackToFrame(frame: number, shouldPlay: boolean): void {
    const nextFrame = clamp(Math.round(frame), startFrameRef.current, durationFramesRef.current);
    setPlayheadFrame(nextFrame);

    if (nextFrame >= durationFramesRef.current) {
      stopPlaybackAtFrame(nextFrame);
      enterGap(nextFrame, false);
      return;
    }

    const clip = findClipAtFrame(nextFrame);
    if (!clip) {
      enterGap(nextFrame, shouldPlay);
      return;
    }

    syncVideoToClip(clip, nextFrame, shouldPlay);
  }

  // ── Public API ────────────────────────────────────────────────────

  async function play(): Promise<void> {
    setIsPlaying(true);
    setError(null);
    syncPlaybackToFrame(playheadFrameRef.current, true);
  }

  function pause(): void {
    clearGapPlayback();
    cancelFrameCallbacks();
    pendingSourceSyncRef.current = null;
    pauseVideoElement();
    audioRef.current?.pause();
    setIsPlaying(false);
  }

  function stop(): void {
    pause();
    clearAudioElement();
  }

  async function togglePlayback(): Promise<void> {
    if (isPlayingRef.current) {
      pause();
      return;
    }
    await play();
  }

  function seekToFrame(frame: number): void {
    const shouldResume = isPlayingRef.current;
    clearGapPlayback();
    cancelFrameCallbacks();
    pendingSourceSyncRef.current = null;
    pauseVideoElement();
    setIsPlaying(shouldResume);
    syncPlaybackToFrame(frame, shouldResume);
  }

  async function requestFullPreview(
    options: RequestFullPreviewOptions = {},
  ): Promise<PreviewResponse | null> {
    if (!projectId) return null;

    setRenderStatus('rendering');
    setError(null);

    try {
      const response = await fetch(`/api/projects/${projectId}/preview`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mode: 'full',
          startFrame: 0,
          endFrame: durationFrames,
          resolution: '720p',
          timelineRevision: options.timelineRevision ?? undefined,
        }),
      });

      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as {
          error?: string;
        };
        throw new Error(
          body.error ?? `Export render failed (${response.status})`,
        );
      }

      const payload = (await response.json()) as PreviewResponse;
      setRenderStatus('ready');
      setPreviewStale(false);
      return payload;
    } catch (err) {
      setRenderStatus('error');
      if (err instanceof TypeError) {
        setError('Preview API unavailable.');
      } else {
        setError(
          err instanceof Error ? err.message : 'Export render failed.',
        );
      }
      return null;
    }
  }

  function markPreviewStale(): void {
    setPreviewStale(true);
  }

  // ── Video event handlers ──────────────────────────────────────────

  /**
   * v3: Use canplaythrough instead of loadedmetadata for more stable clip switching.
   * This ensures the browser has buffered enough data before we attempt seek + play.
   */
  function handleVideoCanPlayThrough(): void {
    const video = videoRef.current;
    const pendingSync = pendingSourceSyncRef.current;
    if (!video || !pendingSync) return;

    if (pendingSync.mediaUrl !== currentMediaUrlRef.current) return;

    const sourceTime = computeSourceTimeSec(pendingSync.clip, pendingSync.frame);
    video.currentTime = sourceTime;
    setPlayheadFrame(pendingSync.frame);
    pendingSourceSyncRef.current = null;

    if (pendingSync.shouldPlay) {
      startVideoPlayback(video);
      return;
    }

    pauseVideoElement();
  }

  function handleVideoLoadedMetadata(): void {
    // v3: Defer to canplaythrough for more stable switching.
    // Only act here if canplaythrough hasn't fired yet AND we have a pending sync
    // that needs at least a seek (for paused state).
    const video = videoRef.current;
    const pendingSync = pendingSourceSyncRef.current;
    if (!video || !pendingSync) return;
    if (pendingSync.mediaUrl !== currentMediaUrlRef.current) return;

    // For paused state, loadedmetadata is sufficient
    if (!pendingSync.shouldPlay) {
      const sourceTime = computeSourceTimeSec(pendingSync.clip, pendingSync.frame);
      video.currentTime = sourceTime;
      setPlayheadFrame(pendingSync.frame);
      pendingSourceSyncRef.current = null;
      pauseVideoElement();
    }
    // For playing state, wait for canplaythrough
  }

  /**
   * v3: timeupdate is demoted to coarse UI update and stall detection.
   * The playhead's authoritative source is rVFC/RAF loops.
   */
  function handleVideoTimeUpdate(): void {
    // Only used as stall detection fallback when rVFC/RAF loop isn't running
    if (rVFCHandleRef.current !== null || rafHandleRef.current !== null) return;

    const video = videoRef.current;
    const activeClip = activeClipRef.current;
    if (!video || !activeClip || pendingSourceSyncRef.current) return;

    const nextFrame = computeTimelineFrameFromCurrentTime(
      activeClip,
      video.currentTime,
    );
    setPlayheadFrame(nextFrame);

    const clipEndFrame = getClipEndFrame(activeClip);
    const clipOutSec = activeClip.src_out_us / 1_000_000;
    const boundaryEpsilonSec = 0.5 / Math.max(fpsRef.current, 1);

    if (
      video.currentTime >= clipOutSec - boundaryEpsilonSec
      || nextFrame >= clipEndFrame
    ) {
      syncPlaybackToFrame(clipEndFrame, isPlayingRef.current);
    }
  }

  function handleVideoWaiting(): void {
    setIsBuffering(true);
  }

  function handleVideoPlaying(): void {
    setIsBuffering(false);
  }

  function handleVideoStalled(): void {
    setIsBuffering(true);
  }

  function handleVideoEnded(): void {
    const activeClip = activeClipRef.current;
    if (!activeClip) {
      stopPlaybackAtFrame(playheadFrameRef.current);
      return;
    }
    syncPlaybackToFrame(getClipEndFrame(activeClip), isPlayingRef.current);
  }

  /**
   * v3: On MEDIA_ERR_SRC_NOT_SUPPORTED, attempt transcode fallback once per asset_id.
   * For other errors, stop playback and show error.
   */
  function handleVideoError(): void {
    clearGapPlayback();
    cancelFrameCallbacks();
    setIsBuffering(false);

    const video = videoRef.current;
    const mediaError = video?.error;
    const activeClip = activeClipRef.current;

    // MEDIA_ERR_SRC_NOT_SUPPORTED (code 4) — attempt transcode fallback
    if (
      mediaError?.code === MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED &&
      activeClip &&
      !transcodeFallbackAttemptedRef.current.has(activeClip.asset_id)
    ) {
      transcodeFallbackAttemptedRef.current.add(activeClip.asset_id);
      const fallbackUrl = getTranscodeFallbackUrl(activeClip.asset_id);
      if (fallbackUrl && video) {
        console.warn(
          `[playback] MEDIA_ERR_SRC_NOT_SUPPORTED for ${activeClip.asset_id}, trying transcode fallback`,
        );
        currentMediaUrlRef.current = fallbackUrl;
        pendingSourceSyncRef.current = {
          clip: activeClip,
          frame: playheadFrameRef.current,
          shouldPlay: isPlayingRef.current,
          mediaUrl: fallbackUrl,
        };
        video.src = fallbackUrl;
        video.load();
        setIsBuffering(true);
        return;
      }
    }

    // Non-recoverable error
    const message = mediaError
      ? `Video error: ${mediaError.message || `code ${mediaError.code}`}`
      : 'Video playback error';
    setError(message);
    pauseVideoElement();
    setIsPlaying(false);
  }

  // ── Lifecycle ─────────────────────────────────────────────────────

  useEffect(() => {
    pause();
    activeClipRef.current = null;
    currentMediaUrlRef.current = null;
    transcodeFallbackAttemptedRef.current.clear();
    clearAudioElement();
    setPlayheadFrame(startFrame);
    setIsBuffering(false);
    setIsGap(true);
    setError(null);
    setRenderStatus('idle');
    setPreviewStale(false);
    clearVideoSource();
  }, [projectId, startFrame]);

  useEffect(() => {
    setPlayheadFrame((current) => clamp(current, startFrame, durationFrames));
  }, [durationFrames, startFrame]);

  useEffect(() => {
    return () => {
      clearGapPlayback();
      cancelFrameCallbacks();
      cancelReverseRaf();
      clearAudioElement();
    };
  }, []);

  // Initialize hidden audio element for audio-only playback regions
  useEffect(() => {
    const audio = new Audio();
    audio.preload = 'auto';
    audioRef.current = audio;
    return () => {
      audio.pause();
      audio.removeAttribute('src');
      audioRef.current = null;
    };
  }, []);

  // ── Phase 3: Step, Marks, Shuttle, Loop ─────────────────────────────

  function stepFrame(delta: number): void {
    const wasPlaying = isPlayingRef.current;
    if (wasPlaying) pause();
    const newFrame = clamp(
      Math.round(playheadFrameRef.current + delta),
      startFrameRef.current,
      durationFramesRef.current,
    );
    syncPlaybackToFrame(newFrame, false);
  }

  function setMarkIn(): void {
    setMarkInState(playheadFrameRef.current);
  }

  function setMarkOut(): void {
    setMarkOutState(playheadFrameRef.current);
  }

  function clearMarkIn(): void { setMarkInState(null); }
  function clearMarkOut(): void { setMarkOutState(null); }

  function cancelReverseRaf(): void {
    if (reverseRafRef.current !== null) {
      window.cancelAnimationFrame(reverseRafRef.current);
      reverseRafRef.current = null;
    }
  }

  function startReverseShuttle(speed: number): void {
    cancelReverseRaf();
    let lastTime = performance.now();
    let frameAccumulator = 0;

    const tick = (now: number) => {
      if (!isPlayingRef.current || shuttleSpeedRef.current >= 0) return;
      const elapsed = (now - lastTime) / 1000;
      lastTime = now;

      // Accumulate fractional frames; only step when >= 1 whole frame
      frameAccumulator += Math.abs(speed) * fpsRef.current * elapsed;
      const wholeFrames = Math.floor(frameAccumulator);
      if (wholeFrames < 1) {
        reverseRafRef.current = window.requestAnimationFrame(tick);
        return;
      }
      frameAccumulator -= wholeFrames;
      const newFrame = Math.max(startFrameRef.current, playheadFrameRef.current - wholeFrames);

      if (newFrame <= startFrameRef.current) {
        stopPlaybackAtFrame(startFrameRef.current);
        setShuttleSpeedState(0);
        return;
      }

      // Loop detection (reverse, only if loop enabled)
      if (loopEnabledRef.current) {
        const mIn = markInRef.current;
        const mOut = markOutRef.current;
        if (mIn != null && newFrame <= mIn && mOut != null) {
          syncPlaybackToFrame(mOut, false);
          setPlayheadFrame(mOut);
          reverseRafRef.current = window.requestAnimationFrame(tick);
          return;
        }
      }

      setPlayheadFrame(newFrame);
      syncPlaybackToFrame(newFrame, false);
      reverseRafRef.current = window.requestAnimationFrame(tick);
    };

    reverseRafRef.current = window.requestAnimationFrame(tick);
  }

  function setShuttleSpeed(speed: number): void {
    setShuttleSpeedState(speed);
    const video = videoRef.current;
    const audio = audioRef.current;

    if (speed === 0) {
      cancelReverseRaf();
      cancelFrameCallbacks();
      clearGapPlayback();
      if (video) video.pause();
      if (audio) audio.pause();
      setIsPlaying(false);
      return;
    }

    setIsPlaying(true);
    setError(null);

    if (speed > 0) {
      cancelReverseRaf();
      if (video && !isGap) {
        video.playbackRate = Math.min(speed, 16);
      }
      if (audio && !audio.paused) {
        audio.playbackRate = Math.min(speed, 16);
      }
      syncPlaybackToFrame(playheadFrameRef.current, true);
    } else {
      // Reverse playback — pause video and audio, use RAF to step backward
      cancelFrameCallbacks();
      clearGapPlayback();
      if (video) video.pause();
      if (audio) audio.pause();
      startReverseShuttle(speed);
    }
  }

  const previewMode: 'source' | 'none' = sourceMapLoaded ? 'source' : 'none';

  return {
    videoRef,
    playheadFrame,
    isPlaying,
    isBuffering,
    isGap,
    previewMode,
    previewStale,
    renderStatus,
    error,
    seekToFrame,
    stop,
    togglePlayback,
    requestFullPreview,
    markPreviewStale,
    handleVideoLoadedMetadata,
    handleVideoCanPlayThrough,
    handleVideoTimeUpdate,
    handleVideoWaiting,
    handleVideoPlaying,
    handleVideoStalled,
    handleVideoEnded,
    handleVideoError,
    // Phase 3: Shuttle, Marks, Loop, Step
    shuttleSpeed,
    markIn,
    markOut,
    loopEnabled,
    setLoopEnabled,
    stepFrame,
    setMarkIn,
    setMarkOut,
    clearMarkIn,
    clearMarkOut,
    setShuttleSpeed,
  };
}
