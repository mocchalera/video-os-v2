import { useEffect, useRef, useState } from 'react';
import type { PreviewRequest, PreviewResponse } from '../types';
import { clamp, framesToSeconds, secondsToFrames } from '../utils/time';

interface UsePlaybackOptions {
  projectId: string;
  fps: number;
  durationFrames: number;
}

export function usePlayback({
  projectId,
  fps,
  durationFrames,
}: UsePlaybackOptions) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  const virtualSessionRef = useRef<{
    startTimestamp: number;
    startFrame: number;
  } | null>(null);
  const [playheadFrame, setPlayheadFrame] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewMode, setPreviewMode] = useState<'none' | 'api' | 'mock'>('none');
  const [renderStatus, setRenderStatus] = useState<'idle' | 'rendering' | 'ready' | 'error'>(
    'idle',
  );
  const [error, setError] = useState<string | null>(null);

  function cancelVirtualPlayback(): void {
    if (animationFrameRef.current !== null) {
      window.cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
    }
    virtualSessionRef.current = null;
  }

  function stop(): void {
    cancelVirtualPlayback();
    videoRef.current?.pause();
    setIsPlaying(false);
  }

  function stepVirtualPlayback(timestamp: number): void {
    const session = virtualSessionRef.current;
    if (!session) {
      return;
    }

    const elapsedSeconds = (timestamp - session.startTimestamp) / 1000;
    const nextFrame = clamp(
      session.startFrame + secondsToFrames(elapsedSeconds, fps),
      0,
      durationFrames,
    );

    setPlayheadFrame(nextFrame);

    if (nextFrame >= durationFrames) {
      stop();
      return;
    }

    animationFrameRef.current = window.requestAnimationFrame(stepVirtualPlayback);
  }

  function startVirtualPlayback(): void {
    cancelVirtualPlayback();
    virtualSessionRef.current = {
      startTimestamp: performance.now(),
      startFrame: playheadFrame,
    };
    setPreviewMode((current) => (current === 'api' ? 'api' : 'mock'));
    setIsPlaying(true);
    animationFrameRef.current = window.requestAnimationFrame(stepVirtualPlayback);
  }

  async function play(): Promise<void> {
    if (previewUrl && previewMode === 'api' && videoRef.current) {
      try {
        videoRef.current.currentTime = framesToSeconds(playheadFrame, fps);
        await videoRef.current.play();
        setIsPlaying(true);
        return;
      } catch {
        setError('Preview video could not start. Falling back to mock playback.');
      }
    }

    startVirtualPlayback();
  }

  async function togglePlayback(): Promise<void> {
    if (isPlaying) {
      stop();
      return;
    }

    await play();
  }

  function seekToFrame(frame: number): void {
    const nextFrame = clamp(Math.round(frame), 0, durationFrames);
    setPlayheadFrame(nextFrame);

    if (previewMode === 'api' && previewUrl && videoRef.current) {
      videoRef.current.currentTime = framesToSeconds(nextFrame, fps);
    }

    if (isPlaying && previewMode !== 'api') {
      virtualSessionRef.current = {
        startTimestamp: performance.now(),
        startFrame: nextFrame,
      };
    }
  }

  async function requestPreview(
    request: PreviewRequest,
  ): Promise<PreviewResponse | null> {
    if (!projectId) {
      return null;
    }

    setRenderStatus('rendering');
    setError(null);

    try {
      const response = await fetch(`/api/projects/${projectId}/preview`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(request),
      });

      if (!response.ok) {
        throw new Error(`Preview render failed (${response.status})`);
      }

      const payload = (await response.json()) as PreviewResponse;
      setPreviewUrl(payload.previewUrl);
      setPreviewMode('api');
      setRenderStatus('ready');

      if (videoRef.current) {
        videoRef.current.load();
        videoRef.current.currentTime = framesToSeconds(playheadFrame, fps);
      }

      return payload;
    } catch {
      setPreviewUrl(null);
      setPreviewMode('mock');
      setRenderStatus('error');
      setError('Preview API unavailable. Virtual playback mode is active.');
      return null;
    }
  }

  function handleVideoTimeUpdate(): void {
    if (!videoRef.current) {
      return;
    }

    setPlayheadFrame(
      clamp(secondsToFrames(videoRef.current.currentTime, fps), 0, durationFrames),
    );
  }

  function handleVideoLoadedMetadata(): void {
    if (!videoRef.current) {
      return;
    }

    videoRef.current.currentTime = framesToSeconds(playheadFrame, fps);
  }

  function handleVideoEnded(): void {
    stop();
    setPlayheadFrame(durationFrames);
  }

  useEffect(() => {
    stop();
    setPreviewUrl(null);
    setPreviewMode('none');
    setRenderStatus('idle');
    setError(null);
    setPlayheadFrame(0);
  }, [projectId]);

  useEffect(() => {
    setPlayheadFrame((current) => clamp(current, 0, durationFrames));
  }, [durationFrames]);

  useEffect(() => {
    return () => {
      cancelVirtualPlayback();
    };
  }, []);

  return {
    videoRef,
    playheadFrame,
    isPlaying,
    previewUrl,
    previewMode,
    renderStatus,
    error,
    seekToFrame,
    stop,
    togglePlayback,
    requestPreview,
    handleVideoTimeUpdate,
    handleVideoLoadedMetadata,
    handleVideoEnded,
  };
}
