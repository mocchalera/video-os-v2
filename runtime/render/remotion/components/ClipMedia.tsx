import type { CSSProperties } from "react";
import { Img, OffthreadVideo } from "remotion";
import type { ClipOutput } from "../../../../compiler/types.js";
import { microsecondsToFrames, type RationalFrameRate } from "../../../../editor/shared/rational-timebase.js";

/**
 * Shared clip media element for the Remotion timeline and the transition
 * layer: stills render as fitted images, motion renders as OffthreadVideo.
 *
 * `startFrom` / `endAt` override the default full-clip source window
 * (frames in the source timeline); the transition layer uses them to show
 * the exact A-tail / B-head source frames inside a transition window.
 * `muted` silences the element — transition-layer duplicates must never
 * double the program audio of the underlying clip Sequences.
 */
export interface ClipMediaProps {
  clip: ClipOutput;
  source: string;
  frameRate: RationalFrameRate;
  objectFit: CSSProperties["objectFit"];
  stillAssetIds: string[];
  muted?: boolean;
  startFrom?: number;
  endAt?: number;
}

export function isStillClip(clip: ClipOutput, stillAssetIds: string[]): boolean {
  return (
    stillAssetIds.includes(clip.asset_id) ||
    clip.media_kind === "image" ||
    !!clip.still_image
  );
}

export function ClipMedia({
  clip,
  source,
  frameRate,
  objectFit,
  stillAssetIds,
  muted,
  startFrom,
  endAt,
}: ClipMediaProps) {
  if (isStillClip(clip, stillAssetIds)) {
    if (clip.still_image?.camera_motion || clip.still_image?.motion_mode === "camera_motion") {
      throw new Error("still_camera_motion_remotion_unsupported");
    }
    if (clip.still_image?.transform && clip.still_image.motion_mode !== "camera_motion") {
      throw new Error(
        "still_image_transform_remotion_unsupported"
        + ": still_image.transform requires the ffmpeg still-image lane.",
      );
    }
    const stillFit = clip.still_image?.fit_mode ?? "contain";
    const stillObjectFit = stillFit === "full_bleed" ? "cover" : stillFit;
    const stillBackground = clip.still_image?.background ?? "black";
    return (
      <Img
        src={source}
        style={{
          width: "100%",
          height: "100%",
          objectFit: stillObjectFit,
          backgroundColor:
            stillBackground === "transparent" ? "transparent" : stillBackground,
        }}
      />
    );
  }

  return (
    <OffthreadVideo
      src={source}
      startFrom={startFrom ?? microsecondsToFrames(clip.src_in_us, frameRate)}
      endAt={endAt ?? microsecondsToFrames(clip.src_out_us, frameRate)}
      muted={muted}
      style={{ width: "100%", height: "100%", objectFit }}
    />
  );
}

/** Letterbox policy → object-fit mapping shared by all clip consumers. */
export function objectFitForLetterboxPolicy(
  letterboxPolicy: "pillarbox" | "letterbox" | "none" | undefined,
): CSSProperties["objectFit"] {
  if (letterboxPolicy === "pillarbox" || letterboxPolicy === "letterbox") {
    return "contain";
  }

  return "cover";
}
