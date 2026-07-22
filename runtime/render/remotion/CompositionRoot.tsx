import { Composition, registerRoot } from "remotion";
import type { TimelineIR } from "../../compiler/types.js";
import type { VideoWebFontAsset } from "../../../editor/shared/font-contract.js";
import { VideoTimeline } from "./VideoTimeline.js";
import { timelineToCompositionProps } from "./timeline-to-props.js";

export interface VideoTimelineCompositionInput {
  [key: string]: unknown;
  timeline: TimelineIR;
  sourceMap: Record<string, string>;
  stillAssetIds?: string[];
  fontAsset?: VideoWebFontAsset;
}

const emptyTimeline: TimelineIR = {
  version: "1",
  project_id: "remotion-placeholder",
  created_at: "1970-01-01T00:00:00.000Z",
  sequence: {
    name: "Remotion Placeholder",
    fps_num: 30,
    fps_den: 1,
    width: 1920,
    height: 1080,
    start_frame: 0,
    letterbox_policy: "none",
  },
  tracks: {
    video: [],
    audio: [],
  },
  markers: [],
  provenance: {
    brief_path: "",
    blueprint_path: "",
    selects_path: "",
    compiler_version: "remotion-placeholder",
  },
};

const fallbackProps: VideoTimelineCompositionInput = {
  timeline: emptyTimeline,
  sourceMap: {},
};

export const CompositionRoot = () => {
  const compositionProps = timelineToCompositionProps(
    fallbackProps.timeline,
    fallbackProps.sourceMap,
  );

  return (
    <Composition<any, VideoTimelineCompositionInput>
      id={compositionProps.id}
      component={VideoTimeline}
      durationInFrames={compositionProps.durationInFrames}
      fps={compositionProps.fps}
      width={compositionProps.width}
      height={compositionProps.height}
      defaultProps={compositionProps.defaultProps}
      calculateMetadata={({ props }) => {
        const resolved = timelineToCompositionProps(props.timeline, props.sourceMap, undefined, props.stillAssetIds ?? []);
        return {
          durationInFrames: resolved.durationInFrames,
          fps: resolved.fps,
          width: resolved.width,
          height: resolved.height,
        };
      }}
    />
  );
};

registerRoot(CompositionRoot);
