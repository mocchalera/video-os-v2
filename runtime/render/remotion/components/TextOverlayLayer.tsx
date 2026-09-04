import { AbsoluteFill, Sequence, useVideoConfig } from "remotion";
import type { TrackOutput } from "../../../compiler/types.js";
import { normalizeOverlayClipContent } from "../../../content/normalize.js";
import {
  resolveOverlayPreset,
  type OverlayPreset,
  type OverlayPresetProps,
} from "../styles/overlay-presets.js";
import {
  hasExplicitRect,
  overlayWrapperStyle,
} from "../overlay-layout.js";
import { resolveRemotionOverlayClip } from "../overlay-clip-resolver.js";

export interface TextOverlayLayerProps {
  tracks?: TrackOutput[];
  fps: number;
}

const ZERO_SAFE_AREA = { top: 0, right: 0, bottom: 0, left: 0 };

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
  const { width, height } = useVideoConfig();
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

          const layout = resolved.layout;
          const rectMode = layout !== undefined && hasExplicitRect(layout.width, layout.height);
          const wrapperStyle = overlayWrapperStyle({
            anchor: resolved.anchor,
            x: layout?.x ?? 0,
            y: layout?.y ?? 0,
            width: layout?.width,
            height: layout?.height,
            scale: resolved.scale ?? 1,
            rotationDeg: layout?.rotationDeg ?? 0,
            opacity: layout?.opacity ?? 1,
            safeArea: layout?.safeArea ?? true,
            zIndex: layout?.zIndex,
          }, { width, height });
          // In explicit-rect mode the wrapper already applied the anchored
          // safe margins; never inset the preset a second time.
          const safeAreaProp = rectMode || (layout !== undefined && !layout.safeArea)
            ? ZERO_SAFE_AREA
            : resolved.safeArea;
          const presetRenderer = (
            <OverlayPresetRenderer
              preset={preset}
              text={resolved.text}
              action_text={resolved.actionText}
              brand_text={resolved.brandText}
              writing_mode={resolved.writingMode}
              anchor={resolved.anchor}
              safe_area={safeAreaProp}
              animation_in={resolved.animationIn}
              durationInFrames={clip.timeline_duration_frames}
              fps={fps}
            />
          );

          return (
            <Sequence
              key={`${track.track_id}:${clip.clip_id}`}
              from={clip.timeline_in_frame}
              durationInFrames={clip.timeline_duration_frames}
              name={clip.clip_id}
            >
              {rectMode ? (
                <div style={wrapperStyle}>{presetRenderer}</div>
              ) : (
                <AbsoluteFill style={wrapperStyle}>{presetRenderer}</AbsoluteFill>
              )}
            </Sequence>
          );
        }),
      )}
    </>
  );
}
