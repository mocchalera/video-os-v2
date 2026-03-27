import { useEffect, useRef, useState } from 'react';
import type { WaveformData, TrackHeight } from '../types';

const DETAIL_FOR_HEIGHT: Record<TrackHeight, 'coarse' | 'medium' | 'fine'> = {
  S: 'coarse',
  M: 'medium',
  L: 'fine',
};

interface UseWaveformOptions {
  projectId: string | null;
  assetId: string;
  trackHeight: TrackHeight;
  /** Only fetch when clip is visible in viewport */
  visible: boolean;
}

interface WaveformEntry {
  data: WaveformData | null;
  loading: boolean;
  error: string | null;
}

/** In-memory cache keyed by `${projectId}:${assetId}:${detail}` */
const waveformCache = new Map<string, WaveformData>();

export function useWaveform({ projectId, assetId, trackHeight, visible }: UseWaveformOptions): WaveformEntry {
  const [entry, setEntry] = useState<WaveformEntry>({ data: null, loading: false, error: null });
  const abortRef = useRef<AbortController | null>(null);

  const detail = DETAIL_FOR_HEIGHT[trackHeight];

  useEffect(() => {
    if (!visible || !projectId || !assetId) {
      return;
    }

    const cacheKey = `${projectId}:${assetId}:${detail}`;
    const cached = waveformCache.get(cacheKey);
    if (cached) {
      setEntry({ data: cached, loading: false, error: null });
      return;
    }

    // Abort previous request
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setEntry({ data: null, loading: true, error: null });

    fetch(`/api/projects/${projectId}/waveform/${encodeURIComponent(assetId)}?detail=${detail}`, {
      signal: controller.signal,
    })
      .then((resp) => {
        if (!resp.ok) throw new Error(`Waveform fetch failed (${resp.status})`);
        return resp.json() as Promise<WaveformData>;
      })
      .then((data) => {
        waveformCache.set(cacheKey, data);
        setEntry({ data, loading: false, error: null });
      })
      .catch((err) => {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        setEntry({ data: null, loading: false, error: err instanceof Error ? err.message : 'Failed' });
      });

    return () => {
      controller.abort();
    };
  }, [projectId, assetId, detail, visible]);

  return entry;
}

/** Clear the waveform cache (e.g. on project change) */
export function clearWaveformCache(): void {
  waveformCache.clear();
}
