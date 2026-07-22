import type { TimelineIR } from "../../compiler/types.js";
import {
  DEFAULT_VIDEO_WEB_FONT_ASSET,
  type VideoWebFontAsset,
} from "../../../editor/shared/font-contract.js";

export const REMOTION_COMPOSITION_ID = "vos-timeline";

export interface RemotionCompositionProps {
  id: string;
  durationInFrames: number;
  fps: number;
  width: number;
  height: number;
  defaultProps: {
    timeline: TimelineIR;
    sourceMap: Record<string, string>;
    stillAssetIds: string[];
    fontAsset: VideoWebFontAsset;
  };
}

export function timelineToCompositionProps(
  timeline: TimelineIR,
  sourceMap: Record<string, string>,
  fontAsset: VideoWebFontAsset = DEFAULT_VIDEO_WEB_FONT_ASSET,
  stillAssetIds: string[] = [],
): RemotionCompositionProps {
  let durationInFrames = 0;

  for (const track of timeline.tracks.video) {
    for (const clip of track.clips) {
      durationInFrames = Math.max(
        durationInFrames,
        clip.timeline_in_frame + clip.timeline_duration_frames,
      );
    }
  }

  return {
    id: REMOTION_COMPOSITION_ID,
    durationInFrames: durationInFrames > 0 ? durationInFrames : 1,
    fps: Math.round(timeline.sequence.fps_num / timeline.sequence.fps_den),
    width: timeline.sequence.width,
    height: timeline.sequence.height,
    defaultProps: {
      timeline,
      sourceMap,
      stillAssetIds,
      fontAsset,
    },
  };
}
