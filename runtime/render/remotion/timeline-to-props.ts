import type { TimelineIR } from "../../compiler/types.js";
import {
  DEFAULT_VIDEO_WEB_FONT_ASSET,
  type VideoWebFontAsset,
} from "../../../editor/shared/font-contract.js";
import {
  frameRateValue,
  rationalFrameRate,
} from "../../../editor/shared/rational-timebase.js";

export const REMOTION_COMPOSITION_ID = "vos-timeline";
export const REMOTION_OVERLAY_COMPOSITION_ID = "vos-overlay";

export interface RemotionCompositionProps {
  id: string;
  durationInFrames: number;
  fps: number;
  fpsNum: number;
  fpsDen: number;
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
  const frameRate = rationalFrameRate(
    timeline.sequence.fps_num,
    timeline.sequence.fps_den,
  );
  let durationInFrames = 0;

  const tracks = timeline.tracks as TimelineIR["tracks"] & {
    overlay?: TimelineIR["tracks"]["video"];
  };
  for (const track of [...timeline.tracks.video, ...(tracks.overlay ?? [])]) {
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
    fps: frameRateValue(frameRate),
    fpsNum: frameRate.fpsNum,
    fpsDen: frameRate.fpsDen,
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
