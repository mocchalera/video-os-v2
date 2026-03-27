import { memo, useMemo } from 'react';
import type { Clip, EditorLane, TrackHeaderState, TrimMode, TrimTarget } from '../types';
import { TRACK_HEIGHT_PX } from '../types';
import type { ClipOverlay } from './ClipBlock';
import TrackLane from './TrackLane';

export interface LinkData {
  groupId: string;
  offset: number;
}

interface ClipLayerProps {
  lanes: EditorLane[];
  trackStates: Record<string, TrackHeaderState>;
  contentWidth: number;
  pxPerFrame: number;
  fps: number;
  selectedClipIds: Set<string>;
  clipOverlays?: Map<string, ClipOverlay>;
  projectId: string | null;
  trimMode?: TrimMode;
  confidenceFilter?: 'all' | 'low' | 'warnings';
  editorMode?: 'nle' | 'ai';
  onSelectClip: (
    trackKind: 'video' | 'audio',
    trackId: string,
    clip: Clip,
    event: { shiftKey: boolean; metaKey: boolean; ctrlKey: boolean },
  ) => void;
  onTrimBegin: (target: TrimTarget, opts?: { altKey?: boolean }) => void;
  onTrimUpdate: (deltaFrames: number, opts?: { skipSnap?: boolean }) => void;
  onTrimCommit: () => void;
}

export default memo(function ClipLayer({
  lanes,
  trackStates,
  contentWidth,
  pxPerFrame,
  fps,
  selectedClipIds,
  clipOverlays,
  projectId,
  trimMode,
  confidenceFilter = 'all',
  editorMode = 'nle',
  onSelectClip,
  onTrimBegin,
  onTrimUpdate,
  onTrimCommit,
}: ClipLayerProps) {
  // HIGH 2: Pre-compute link data for J/L-cut badges
  const linkDataMap = useMemo(() => {
    const map = new Map<string, LinkData>();
    const groups = new Map<string, { clipId: string; frame: number }[]>();
    for (const lane of lanes) {
      for (const clip of lane.clips) {
        const gid = clip.metadata?.link_group_id as string | undefined;
        if (!gid) continue;
        if (!groups.has(gid)) groups.set(gid, []);
        groups.get(gid)!.push({ clipId: clip.clip_id, frame: clip.timeline_in_frame });
      }
    }
    for (const [gid, members] of groups) {
      if (members.length < 2) continue;
      for (const m of members) {
        const partner = members.find((p) => p.clipId !== m.clipId);
        if (partner) {
          map.set(m.clipId, { groupId: gid, offset: m.frame - partner.frame });
        }
      }
    }
    return map;
  }, [lanes]);

  return (
    <div className="pointer-events-none absolute inset-0">
      {lanes.map((lane) => {
        const state = trackStates[lane.laneId];
        const laneHeight = state ? TRACK_HEIGHT_PX[state.height] : 64;
        const isLocked = state?.locked ?? false;

        return (
          <TrackLane
            key={lane.laneId}
            lane={lane}
            width={contentWidth}
            laneHeight={laneHeight}
            pxPerFrame={pxPerFrame}
            fps={fps}
            selectedClipIds={selectedClipIds}
            clipOverlays={clipOverlays}
            trackHeight={state?.height ?? 'M'}
            projectId={projectId}
            locked={isLocked}
            trimMode={trimMode}
            confidenceFilter={confidenceFilter}
            editorMode={editorMode}
            linkDataMap={linkDataMap}
            onSelectClip={onSelectClip}
            onTrimBegin={onTrimBegin}
            onTrimUpdate={onTrimUpdate}
            onTrimCommit={onTrimCommit}
          />
        );
      })}
    </div>
  );
});
