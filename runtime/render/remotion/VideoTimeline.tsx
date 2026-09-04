import type { CSSProperties } from "react";
import { AbsoluteFill, Img, OffthreadVideo, Sequence } from "remotion";
import type { TimelineIR, TrackOutput } from "../../compiler/types.js";
import {
  resolveVerticalStillComposition,
  type VerticalStillComposition,
} from "../camera-motion.js";
import { resolveStillClipMotion } from "./still-render-capability.js";
export { resolveStillClipMotion } from "./still-render-capability.js";
import {
  DEFAULT_VIDEO_WEB_FONT_ASSET,
  type VideoWebFontAsset,
} from "../../../editor/shared/font-contract.js";
import { BundledFontGate } from "./components/BundledFontGate.js";
import { TextOverlayLayer } from "./components/TextOverlayLayer.js";
import { TransitionLayer } from "./components/TransitionLayer.js";
import {
  frameRateValue,
  microsecondsToFrames,
  rationalFrameRate,
} from "../../../editor/shared/rational-timebase.js";

export interface VideoTimelineProps {
  timeline: TimelineIR;
  sourceMap: Record<string, string>;
  fontAsset?: VideoWebFontAsset;
  stillAssetIds?: string[];
}

function objectFitForLetterboxPolicy(
  letterboxPolicy: TimelineIR["sequence"]["letterbox_policy"],
): CSSProperties["objectFit"] {
  if (letterboxPolicy === "pillarbox" || letterboxPolicy === "letterbox") {
    return "contain";
  }

  return "cover";
}

/**
 * Automatic vertical blur-backdrop composite: blurred full-canvas backdrop
 * with a static sharp square foreground at the registered Y anchor. Camera
 * motion in the foreground is NOT rendered here — the Remotion lane has no
 * Float64 worker contract; resolveStillClipMotion rejects such clips.
 */
const VerticalStillComposite = ({
  source,
  composition,
}: {
  source: string;
  composition: VerticalStillComposition;
}) => {
  return (
    <AbsoluteFill style={{ backgroundColor: "black" }}>
      <Img
        src={source}
        style={{
          width: "100%",
          height: "100%",
          objectFit: "cover",
          filter: `blur(${composition.blurSigma}px)`,
        }}
      />
      <div
        style={{
          position: "absolute",
          left: 0,
          top: composition.fgY,
          width: composition.fgSize,
          height: composition.fgSize,
          overflow: "hidden",
        }}
      >
        <Img
          src={source}
          style={{ width: "100%", height: "100%", objectFit: "cover" }}
        />
      </div>
    </AbsoluteFill>
  );
};

export const VideoTimeline = ({
  timeline,
  sourceMap,
  fontAsset = DEFAULT_VIDEO_WEB_FONT_ASSET,
  stillAssetIds = [],
}: VideoTimelineProps) => {
  const frameRate = rationalFrameRate(
    timeline.sequence.fps_num,
    timeline.sequence.fps_den,
  );
  const fps = frameRateValue(frameRate);
  const objectFit = objectFitForLetterboxPolicy(timeline.sequence.letterbox_policy);
  const overlayTracks = (timeline.tracks as TimelineIR["tracks"] & { overlay?: TrackOutput[] }).overlay;

  return (
    <AbsoluteFill style={{ fontFamily: `"${fontAsset.family}", sans-serif` }}>
      <BundledFontGate asset={fontAsset} />
      {timeline.tracks.video.map((track) =>
        track.clips.map((clip) => {
          const source = sourceMap[clip.asset_id];
          if (!source) {
            return null;
          }

          const isStill = stillAssetIds.includes(clip.asset_id) || clip.media_kind === "image" || !!clip.still_image;
          const stillFit = clip.still_image?.fit_mode ?? "contain";
          const stillObjectFit = stillFit === "full_bleed" ? "cover" : stillFit;
          const stillBackground = clip.still_image?.background ?? "black";
          // Contract check + Remotion rejection for camera-motion stills
          // (throws still_camera_motion_remotion_unsupported).
          if (isStill) resolveStillClipMotion(clip.still_image, clip.timeline_duration_frames);
          const composition = isStill
            ? resolveVerticalStillComposition(
                timeline.sequence.width,
                timeline.sequence.height,
                clip.still_image?.composition,
              ) ?? undefined
            : undefined;
          return (
            <Sequence
              key={`${track.track_id}:${clip.clip_id}`}
              from={clip.timeline_in_frame}
              durationInFrames={clip.timeline_duration_frames}
              name={clip.clip_id}
            >
              {isStill && composition ? <VerticalStillComposite
                source={source}
                composition={composition}
              /> : isStill ? <Img
                src={source}
                style={{
                  width: "100%",
                  height: "100%",
                  objectFit: stillObjectFit,
                  backgroundColor: stillBackground === "transparent" ? "transparent" : stillBackground,
                }}
              /> : <OffthreadVideo
                src={source}
                startFrom={microsecondsToFrames(clip.src_in_us, frameRate)}
                endAt={microsecondsToFrames(clip.src_out_us, frameRate)}
                style={{ width: "100%", height: "100%", objectFit }}
              />}
            </Sequence>
          );
        }),
      )}
      <TransitionLayer
        transitions={timeline.transitions ?? []}
        tracks={timeline.tracks}
        fps={fps}
        frameRate={frameRate}
        sourceMap={sourceMap}
        stillAssetIds={stillAssetIds}
        letterboxPolicy={timeline.sequence.letterbox_policy}
      />
      <TextOverlayLayer tracks={overlayTracks} fps={fps} />
    </AbsoluteFill>
  );
};
