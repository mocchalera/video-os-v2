import { Sequence } from "remotion";
import type { TrackOutput } from "../../../compiler/types.js";
import { normalizeOverlayClipContent } from "../../../content/normalize.js";
import {
  resolveOverlayPreset,
  type OverlayPreset,
  type OverlayPresetProps,
} from "../styles/overlay-presets.js";
import { resolveRemotionOverlayClip } from "../overlay-clip-resolver.js";

export interface TextOverlayLayerProps {
  tracks?: TrackOutput[];
  fps: number;
}

interface OverlayPresetRendererProps extends OverlayPresetProps {
  preset: OverlayPreset;
}

/**
 * Keep preset hooks inside the clip Sequence context. Calling
 * `preset.render()` while constructing the Sequence evaluates
 * `useCurrentFrame()` against the composition frame, which made every
 * non-zero-start overlay immediately reach its fade-out state.
 */
function OverlayPresetRenderer({ preset, ...props }: OverlayPresetRendererProps) {
  return preset.render(props);
}

export function TextOverlayLayer({ tracks, fps }: TextOverlayLayerProps) {
  if (!tracks || tracks.length === 0) {
    return null;
  }

  return (
    <>
      {tracks.map((track) =>
        track.clips.map((clip) => {
          const normalized = normalizeOverlayClipContent(clip);
          if (normalized.renderer_owner !== "remotion") {
            if (normalized.issues.length > 0) {
              console.warn(
                `Skipping overlay clip ${clip.clip_id}: ${normalized.issues.map((issue) => issue.message).join("; ")}`,
              );
            }
            return null;
          }

          const resolved = resolveRemotionOverlayClip(clip);
          if (!resolved) {
            console.warn(`Skipping overlay clip ${clip.clip_id}: unsupported Remotion template`);
            return null;
          }

          const preset = resolveOverlayPreset(resolved.presetId);
          if (preset === null) {
            console.warn(`Skipping overlay clip ${clip.clip_id}: unknown preset "${resolved.presetId}"`);
            return null;
          }

          return (
            <Sequence
              key={`${track.track_id}:${clip.clip_id}`}
              from={clip.timeline_in_frame}
              durationInFrames={clip.timeline_duration_frames}
              name={clip.clip_id}
            >
              <OverlayPresetRenderer
                preset={preset}
                text={resolved.text}
                action_text={resolved.actionText}
                brand_text={resolved.brandText}
                writing_mode={resolved.writingMode}
                anchor={resolved.anchor}
                safe_area={resolved.safeArea}
                durationInFrames={clip.timeline_duration_frames}
                fps={fps}
              />
            </Sequence>
          );
        }),
      )}
    </>
  );
}
