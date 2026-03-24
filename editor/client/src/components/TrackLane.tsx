import type { Clip, EditorLane } from '../types';
import { getRoleColor } from '../utils/draw';
import ClipBlock, { type TrimSide } from './ClipBlock';

interface TrackLaneProps {
  lane: EditorLane;
  width: number;
  laneHeight: number;
  pxPerFrame: number;
  fps: number;
  selectedClipId: string | null;
  onSelectClip: (trackKind: 'video' | 'audio', trackId: string, clip: Clip) => void;
  onTrimClip: (
    trackKind: 'video' | 'audio',
    trackId: string,
    baseClip: Clip,
    side: TrimSide,
    deltaFrames: number,
  ) => void;
}

export default function TrackLane({
  lane,
  width,
  laneHeight,
  pxPerFrame,
  fps,
  selectedClipId,
  onSelectClip,
  onTrimClip,
}: TrackLaneProps) {
  const empty = lane.clips.length === 0 || !lane.trackId;

  return (
    <div className="relative" style={{ width, height: laneHeight }}>
      {empty ? (
        <div className="pointer-events-none absolute inset-0 flex items-center px-4 text-xs text-slate-500">
          No clips on {lane.label}
        </div>
      ) : null}

      {lane.trackId
        ? lane.clips.map((clip) => (
            <ClipBlock
              key={clip.clip_id}
              clip={clip}
              pxPerFrame={pxPerFrame}
              fps={fps}
              selected={selectedClipId === clip.clip_id}
              color={getRoleColor(clip.role)}
              onSelect={() => onSelectClip(lane.trackKind, lane.trackId!, clip)}
              onTrim={(side, baseClip, deltaFrames) =>
                onTrimClip(lane.trackKind, lane.trackId!, baseClip, side, deltaFrames)
              }
            />
          ))
        : null}
    </div>
  );
}
