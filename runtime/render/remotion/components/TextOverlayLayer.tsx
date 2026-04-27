import { Sequence } from "remotion";
import type { TrackOutput, ClipOutput } from "../../../compiler/types.js";
import {
  getOverlayText,
  resolveOverlayPreset,
  type OverlayPresetProps,
} from "../styles/overlay-presets.js";

export interface TextOverlayLayerProps {
  tracks?: TrackOutput[];
  fps: number;
}

type OverlayMetadata = {
  styling_class?: unknown;
  writing_mode?: unknown;
  anchor?: unknown;
  safe_area?: unknown;
};

function overlayMetadata(clip: ClipOutput): OverlayMetadata | null {
  const overlay = clip.metadata?.overlay;
  if (!overlay || typeof overlay !== "object") {
    return null;
  }

  return overlay as OverlayMetadata;
}

function overlayString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function overlayWritingMode(value: unknown): OverlayPresetProps["writing_mode"] | undefined {
  if (value === "horizontal_tb" || value === "vertical_rl" || value === "vertical_lr") {
    return value;
  }

  return undefined;
}

function overlaySafeArea(value: unknown): OverlayPresetProps["safe_area"] | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const input = value as Record<string, unknown>;
  return {
    top: typeof input.top === "number" ? input.top : undefined,
    right: typeof input.right === "number" ? input.right : undefined,
    bottom: typeof input.bottom === "number" ? input.bottom : undefined,
    left: typeof input.left === "number" ? input.left : undefined,
  };
}

export function TextOverlayLayer({ tracks, fps }: TextOverlayLayerProps) {
  if (!tracks || tracks.length === 0) {
    return null;
  }

  return (
    <>
      {tracks.map((track) =>
        track.clips.map((clip) => {
          const text = getOverlayText(clip.metadata);
          if (text === null) {
            console.warn(`Skipping overlay clip ${clip.clip_id}: missing overlay text`);
            return null;
          }

          const overlay = overlayMetadata(clip);
          const stylingClass = overlayString(overlay?.styling_class);
          if (!stylingClass) {
            console.warn(`Skipping overlay clip ${clip.clip_id}: missing styling_class`);
            return null;
          }

          const preset = resolveOverlayPreset(stylingClass);
          if (preset === null) {
            console.warn(`Skipping overlay clip ${clip.clip_id}: unknown styling_class "${stylingClass}"`);
            return null;
          }

          return (
            <Sequence
              key={`${track.track_id}:${clip.clip_id}`}
              from={clip.timeline_in_frame}
              durationInFrames={clip.timeline_duration_frames}
              name={clip.clip_id}
            >
              {preset.render({
                text,
                writing_mode: overlayWritingMode(overlay?.writing_mode),
                anchor: overlayString(overlay?.anchor),
                safe_area: overlaySafeArea(overlay?.safe_area),
                durationInFrames: clip.timeline_duration_frames,
                fps,
              })}
            </Sequence>
          );
        }),
      )}
    </>
  );
}
