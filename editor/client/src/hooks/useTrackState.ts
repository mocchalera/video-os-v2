import { useCallback, useEffect, useState } from 'react';
import type { TrackHeaderState, TrackHeight } from '../types';
import { DEFAULT_TRACK_HEADER_STATE } from '../types';

const STORAGE_PREFIX = 'video-os-editor.workspace.';

type TrackStateMap = Record<string, TrackHeaderState>;

function storageKey(projectId: string | null): string {
  return `${STORAGE_PREFIX}${projectId ?? '_default'}`;
}

function readStored(projectId: string | null): TrackStateMap {
  if (typeof window === 'undefined') return {};
  try {
    const raw = window.localStorage.getItem(storageKey(projectId));
    return raw ? (JSON.parse(raw) as TrackStateMap) : {};
  } catch {
    return {};
  }
}

function writeStored(projectId: string | null, map: TrackStateMap): void {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(storageKey(projectId), JSON.stringify(map));
}

export function useTrackState(projectId?: string | null) {
  const pid = projectId ?? null;
  const [stateMap, setStateMap] = useState<TrackStateMap>(() => readStored(pid));

  // Phase 3: Track targets for Insert/Overwrite
  const [videoTarget, setVideoTarget] = useState('V1');
  const [audioTargets, setAudioTargets] = useState<Set<string>>(() => new Set(['A1']));

  // Re-read from storage when projectId changes
  useEffect(() => {
    setStateMap(readStored(pid));
  }, [pid]);

  function getTrackState(trackId: string): TrackHeaderState {
    return stateMap[trackId] ?? DEFAULT_TRACK_HEADER_STATE;
  }

  const updateTrack = useCallback(
    (trackId: string, partial: Partial<TrackHeaderState>) => {
      setStateMap((prev) => {
        const current = prev[trackId] ?? DEFAULT_TRACK_HEADER_STATE;
        const next = { ...prev, [trackId]: { ...current, ...partial } };
        writeStored(pid, next);
        return next;
      });
    },
    [pid],
  );

  const toggleLock = useCallback(
    (trackId: string) => {
      const current = stateMap[trackId] ?? DEFAULT_TRACK_HEADER_STATE;
      updateTrack(trackId, { locked: !current.locked });
    },
    [stateMap, updateTrack],
  );

  const toggleMute = useCallback(
    (trackId: string) => {
      const current = stateMap[trackId] ?? DEFAULT_TRACK_HEADER_STATE;
      updateTrack(trackId, { muted: !current.muted });
    },
    [stateMap, updateTrack],
  );

  const toggleSolo = useCallback(
    (trackId: string) => {
      const current = stateMap[trackId] ?? DEFAULT_TRACK_HEADER_STATE;
      updateTrack(trackId, { solo: !current.solo });
    },
    [stateMap, updateTrack],
  );

  const toggleSyncLock = useCallback(
    (trackId: string) => {
      const current = stateMap[trackId] ?? DEFAULT_TRACK_HEADER_STATE;
      updateTrack(trackId, { syncLock: !current.syncLock });
    },
    [stateMap, updateTrack],
  );

  const cycleHeight = useCallback(
    (trackId: string) => {
      const current = stateMap[trackId] ?? DEFAULT_TRACK_HEADER_STATE;
      const order: TrackHeight[] = ['S', 'M', 'L'];
      const idx = order.indexOf(current.height);
      const next = order[(idx + 1) % order.length];
      updateTrack(trackId, { height: next });
    },
    [stateMap, updateTrack],
  );

  const setHeight = useCallback(
    (trackId: string, height: TrackHeight) => {
      updateTrack(trackId, { height });
    },
    [updateTrack],
  );

  /** Check if any track has solo enabled */
  const hasSolo = Object.values(stateMap).some((s) => s.solo);

  // Phase 3: Track target toggles
  const toggleVideoTarget = useCallback(
    (trackId: string) => setVideoTarget(trackId),
    [],
  );

  const toggleAudioTarget = useCallback(
    (trackId: string) => {
      setAudioTargets((prev) => {
        const next = new Set(prev);
        if (next.has(trackId)) next.delete(trackId);
        else next.add(trackId);
        return next;
      });
    },
    [],
  );

  return {
    getTrackState,
    toggleLock,
    toggleMute,
    toggleSolo,
    toggleSyncLock,
    cycleHeight,
    setHeight,
    hasSolo,
    stateMap,
    // Phase 3: Track targets
    videoTarget,
    audioTargets,
    toggleVideoTarget,
    toggleAudioTarget,
  };
}
