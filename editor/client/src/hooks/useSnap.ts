import { useCallback, useMemo, useState } from 'react';
import type { Clip, EditorLane, Marker, SnapTarget } from '../types';

const SNAP_PX_THRESHOLD = 6;
const SNAP_FRAME_THRESHOLD = 3;

interface SnapResult {
  snapped: boolean;
  frame: number;
  target: SnapTarget | null;
}

interface UseSnapOptions {
  lanes: EditorLane[];
  markers: Marker[];
  playheadFrame: number;
  fps: number;
  zoom: number; // px per frame
}

export function useSnap({ lanes, markers, playheadFrame, fps, zoom }: UseSnapOptions) {
  const [enabled, setEnabled] = useState(true);
  const [activeGuide, setActiveGuide] = useState<SnapTarget | null>(null);

  const toggle = useCallback(() => setEnabled((prev) => !prev), []);

  /** Build all snap targets from current state */
  const targets = useMemo((): SnapTarget[] => {
    const result: SnapTarget[] = [];

    // Playhead
    result.push({ frame: playheadFrame, kind: 'playhead' });

    // Clip edges
    for (const lane of lanes) {
      for (const clip of lane.clips) {
        result.push({ frame: clip.timeline_in_frame, kind: 'clip_in', label: clip.clip_id });
        result.push({
          frame: clip.timeline_in_frame + clip.timeline_duration_frames,
          kind: 'clip_out',
          label: clip.clip_id,
        });
      }
    }

    // Markers
    for (const marker of markers) {
      result.push({ frame: marker.frame, kind: 'marker', label: marker.label });
    }

    // Ruler ticks are computed at snap time based on zoom level
    return result;
  }, [lanes, markers, playheadFrame]);

  /** Find the closest snap target for a given frame position */
  const findSnap = useCallback(
    (frame: number, excludeClipId?: string): SnapResult => {
      if (!enabled) {
        return { snapped: false, frame, target: null };
      }

      const thresholdFrames = Math.min(
        SNAP_FRAME_THRESHOLD,
        Math.ceil(SNAP_PX_THRESHOLD / zoom),
      );

      let bestTarget: SnapTarget | null = null;
      let bestDistance = Infinity;

      for (const target of targets) {
        // Skip the clip we're dragging
        if (excludeClipId && target.label === excludeClipId) continue;

        const distance = Math.abs(target.frame - frame);
        if (distance <= thresholdFrames && distance < bestDistance) {
          bestDistance = distance;
          bestTarget = target;
        }
      }

      if (bestTarget) {
        return { snapped: true, frame: bestTarget.frame, target: bestTarget };
      }

      return { snapped: false, frame, target: null };
    },
    [enabled, targets, zoom],
  );

  /** Call during drag to update the active snap guide */
  const snapDrag = useCallback(
    (frame: number, excludeClipId?: string): number => {
      const result = findSnap(frame, excludeClipId);
      setActiveGuide(result.snapped ? result.target : null);
      return result.frame;
    },
    [findSnap],
  );

  /** Clear the active guide (call on drag end) */
  const clearGuide = useCallback(() => setActiveGuide(null), []);

  return {
    enabled,
    toggle,
    activeGuide,
    findSnap,
    snapDrag,
    clearGuide,
  };
}
