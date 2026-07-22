import type { CSSProperties } from "react";
import { AbsoluteFill, Img, OffthreadVideo, Sequence } from "remotion";
import type { TimelineIR, TrackOutput } from "../../compiler/types.js";
import {
  DEFAULT_VIDEO_WEB_FONT_ASSET,
  type VideoWebFontAsset,
} from "../../../editor/shared/font-contract.js";
import { BundledFontGate } from "./components/BundledFontGate.js";
import { TextOverlayLayer } from "./components/TextOverlayLayer.js";
import { TransitionLayer } from "./components/TransitionLayer.js";

export interface VideoTimelineProps {
  timeline: TimelineIR;
  sourceMap: Record<string, string>;
  fontAsset?: VideoWebFontAsset;
  stillAssetIds?: string[];
}

function microsecondsToFrames(microseconds: number, fps: number): number {
  return Math.round((microseconds / 1_000_000) * fps);
}

function objectFitForLetterboxPolicy(
  letterboxPolicy: TimelineIR["sequence"]["letterbox_policy"],
): CSSProperties["objectFit"] {
  if (letterboxPolicy === "pillarbox" || letterboxPolicy === "letterbox") {
    return "contain";
  }

  return "cover";
}

export const VideoTimeline = ({
  timeline,
  sourceMap,
  fontAsset = DEFAULT_VIDEO_WEB_FONT_ASSET,
  stillAssetIds = [],
}: VideoTimelineProps) => {
  const fps = Math.round(timeline.sequence.fps_num / timeline.sequence.fps_den);
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
          const stillBackground = clip.still_image?.background ?? "black";
          return (
            <Sequence
              key={`${track.track_id}:${clip.clip_id}`}
              from={clip.timeline_in_frame}
              durationInFrames={clip.timeline_duration_frames}
              name={clip.clip_id}
            >
              {isStill ? <Img
                src={source}
                style={{
                  width: "100%",
                  height: "100%",
                  objectFit: stillFit,
                  backgroundColor: stillBackground === "transparent" ? "transparent" : stillBackground,
                }}
              /> : <OffthreadVideo
                src={source}
                startFrom={microsecondsToFrames(clip.src_in_us, fps)}
                endAt={microsecondsToFrames(clip.src_out_us, fps)}
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
      />
      <TextOverlayLayer tracks={overlayTracks} fps={fps} />
    </AbsoluteFill>
  );
};
