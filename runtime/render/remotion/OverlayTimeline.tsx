import { AbsoluteFill } from "remotion";
import type { TimelineIR, TrackOutput } from "../../compiler/types.js";
import {
  DEFAULT_VIDEO_WEB_FONT_ASSET,
  type VideoWebFontAsset,
} from "../../../editor/shared/font-contract.js";
import { frameRateValue, rationalFrameRate } from "../../../editor/shared/rational-timebase.js";
import { BundledFontGate } from "./components/BundledFontGate.js";
import { TextOverlayLayer } from "./components/TextOverlayLayer.js";

export interface OverlayTimelineProps {
  timeline: TimelineIR;
  sourceMap: Record<string, string>;
  fontAsset?: VideoWebFontAsset;
  stillAssetIds?: string[];
}

/** Transparent Remotion-only visual layer; never renders or decodes the base. */
export const OverlayTimeline = ({
  timeline,
  fontAsset = DEFAULT_VIDEO_WEB_FONT_ASSET,
}: OverlayTimelineProps) => {
  const fps = frameRateValue(rationalFrameRate(
    timeline.sequence.fps_num,
    timeline.sequence.fps_den,
  ));
  const tracks = (timeline.tracks as TimelineIR["tracks"] & {
    overlay?: TrackOutput[];
  }).overlay;

  return (
    <AbsoluteFill style={{
      backgroundColor: "transparent",
      fontFamily: `"${fontAsset.family}", sans-serif`,
    }}>
      <BundledFontGate asset={fontAsset} />
      <TextOverlayLayer tracks={tracks} fps={fps} />
    </AbsoluteFill>
  );
};
