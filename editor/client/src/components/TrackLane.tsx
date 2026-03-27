import { memo } from 'react';
import type { Clip, EditorLane, TrackHeight, TrimMode, TrimTarget } from '../types';
import { getTrackColor } from '../utils/draw';
import ClipBlock, { type ClipOverlay } from './ClipBlock';
import type { LinkData } from './ClipLayer';

interface TrackLaneProps {
  lane: EditorLane;
  width: number;
  laneHeight: number;
  pxPerFrame: number;
  fps: number;
  selectedClipIds: Set<string>;
  clipOverlays?: Map<string, ClipOverlay>;
  trackHeight: TrackHeight;
  projectId: string | null;
  locked: boolean;
  trimMode?: TrimMode;
  confidenceFilter?: 'all' | 'low' | 'warnings';
  editorMode?: 'nle' | 'ai';
  /** Pre-computed link data for J/L-cut badges */
  linkDataMap?: Map<string, LinkData>;
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

export default memo(function TrackLane({
  lane,
  width,
  laneHeight,
  pxPerFrame,
  fps,
  selectedClipIds,
  clipOverlays,
  trackHeight,
  projectId,
  locked,
  trimMode,
  confidenceFilter = 'all',
  editorMode = 'nle',
  linkDataMap,
  onSelectClip,
  onTrimBegin,
  onTrimUpdate,
  onTrimCommit,
}: TrackLaneProps) {
  const empty = lane.clips.length === 0 || !lane.trackId;
  const trackColor = getTrackColor(lane.laneId, lane.trackKind);

  // Compute gap regions (areas with no clips) for checkerboard
  const gapRegions = !empty && lane.trackKind === 'video'
    ? (() => {
        const sorted = [...lane.clips].sort((a, b) => a.timeline_in_frame - b.timeline_in_frame);
        const gaps: { left: number; width: number }[] = [];
        let cursor = 0;
        for (const clip of sorted) {
          if (clip.timeline_in_frame > cursor) {
            gaps.push({
              left: cursor * pxPerFrame,
              width: (clip.timeline_in_frame - cursor) * pxPerFrame,
            });
          }
          cursor = Math.max(cursor, clip.timeline_in_frame + clip.timeline_duration_frames);
        }
        // Trailing gap to track width
        const trailingLeft = cursor * pxPerFrame;
        if (trailingLeft < width) {
          gaps.push({ left: trailingLeft, width: width - trailingLeft });
        }
        return gaps;
      })()
    : [];

  return (
    <div className="relative" style={{ width, height: laneHeight }}>
      {empty ? (
        <div className="pointer-events-none absolute inset-0 flex items-center px-5 text-[11px] font-medium text-[color:var(--text-subtle)] gap-checkerboard">
          No clips on {lane.label}
        </div>
      ) : null}

      {/* Gap checkerboard for video tracks */}
      {gapRegions.map((gap, i) => (
        <div
          key={`gap-${i}`}
          className="pointer-events-none absolute gap-checkerboard"
          style={{ left: gap.left, width: gap.width, top: 0, height: laneHeight }}
        />
      ))}

      {lane.trackId
        ? lane.clips.map((clip) => {
            const ld = linkDataMap?.get(clip.clip_id);
            return (
              <ClipBlock
                key={clip.clip_id}
                clip={clip}
                pxPerFrame={pxPerFrame}
                fps={fps}
                laneHeight={laneHeight}
                selected={selectedClipIds.has(clip.clip_id)}
                color={trackColor}
                overlay={clipOverlays?.get(clip.clip_id)}
                trackKind={lane.trackKind}
                trackId={lane.trackId!}
                trackHeight={trackHeight}
                projectId={projectId}
                locked={locked}
                trimMode={trimMode}
                confidenceFilter={confidenceFilter}
                editorMode={editorMode}
                linkGroupId={ld?.groupId}
                linkOffset={ld?.offset}
                onSelect={(event) =>
                  onSelectClip(lane.trackKind, lane.trackId!, clip, event)
                }
                onTrimBegin={onTrimBegin}
                onTrimUpdate={onTrimUpdate}
                onTrimCommit={onTrimCommit}
              />
            );
          })
        : null}
    </div>
  );
});
