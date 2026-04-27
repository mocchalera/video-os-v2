import type { CSSProperties } from "react";
import { OffthreadVideo, Sequence } from "remotion";
import type { TimelineIR, TrackOutput } from "../../compiler/types.js";
import { TextOverlayLayer } from "./components/TextOverlayLayer.js";
import { TransitionLayer } from "./components/TransitionLayer.js";

export interface VideoTimelineProps {
  timeline: TimelineIR;
  sourceMap: Record<string, string>;
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

export const VideoTimeline = ({ timeline, sourceMap }: VideoTimelineProps) => {
  const fps = Math.round(timeline.sequence.fps_num / timeline.sequence.fps_den);
  const objectFit = objectFitForLetterboxPolicy(timeline.sequence.letterbox_policy);
  const overlayTracks = (timeline.tracks as TimelineIR["tracks"] & { overlay?: TrackOutput[] }).overlay;

  return (
    <>
      {timeline.tracks.video.map((track) =>
        track.clips.map((clip) => {
          const source = sourceMap[clip.asset_id];
          if (!source) {
            return null;
          }

          return (
            <Sequence
              key={`${track.track_id}:${clip.clip_id}`}
              from={clip.timeline_in_frame}
              durationInFrames={clip.timeline_duration_frames}
              name={clip.clip_id}
            >
              <OffthreadVideo
                src={source}
                startFrom={microsecondsToFrames(clip.src_in_us, fps)}
                endAt={microsecondsToFrames(clip.src_out_us, fps)}
                style={{
                  width: "100%",
                  height: "100%",
                  objectFit,
                }}
              />
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
    </>
  );
};
