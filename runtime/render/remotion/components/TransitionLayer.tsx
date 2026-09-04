import type { ReactNode } from "react";
import { Sequence, useCurrentFrame } from "remotion";
import type {
  ClipOutput,
  TimelineTransitionOutput,
  TrackOutput,
} from "../../../compiler/types.js";
import type { RationalFrameRate } from "../../../../editor/shared/rational-timebase.js";
import { microsecondsToFrames } from "../../../../editor/shared/rational-timebase.js";
import { ClipMedia, objectFitForLetterboxPolicy } from "./ClipMedia.js";
import { preflightTransition } from "../preflight-transitions.js";
import { resolveTransitionPreset } from "../styles/transition-presets.js";
import { resolveTransitionWindow } from "../transition-window.js";

export interface TransitionLayerProps {
  transitions: TimelineTransitionOutput[];
  tracks: {
    video: TrackOutput[];
  };
  fps: number;
  frameRate?: RationalFrameRate;
  sourceMap?: Record<string, string>;
  stillAssetIds?: string[];
  letterboxPolicy?: "none" | "pillarbox" | "letterbox";
}

type RemotionTransition = TimelineTransitionOutput & {
  duration_frames?: number;
  start_frame?: number;
};

/** Issue #34 presets composite real A/B children inside the window. */
const OVERLAP_CHILD_PRESETS = new Set([
  "film_crossfade",
  "light_leak_flash",
  "dreamy_focus_blur",
]);

function findClipById(tracks: TrackOutput[], clipId: string): ClipOutput | null {
  for (const track of tracks) {
    const clip = track.clips.find((candidate) => candidate.clip_id === clipId);
    if (clip) {
      return clip;
    }
  }

  return null;
}

function transitionDurationFrames(t: RemotionTransition): number {
  return t.duration_frames ?? t.transition_frames ?? 0;
}

function isVisualNoOp(type: string): boolean {
  return type === "cut" || type === "j_cut" || type === "l_cut";
}

/**
 * Render the exact source frames a clip contributes to the transition
 * window [windowStart, windowStart + windowFrames).
 *
 * The element is muted: the underlying clip Sequences already carry the
 * program audio, so a second unmuted copy inside the transition layer would
 * double it. Still clips render as fitted images with no source window.
 */
function ClipWindowMedia({
  clip,
  windowStart,
  windowFrames,
  frameRate,
  sourceMap,
  stillAssetIds,
  objectFit,
}: {
  clip: ClipOutput;
  windowStart: number;
  windowFrames: number;
  frameRate: RationalFrameRate;
  sourceMap: Record<string, string>;
  stillAssetIds: string[];
  objectFit: "cover" | "contain";
}): ReactNode {
  const source = sourceMap[clip.asset_id];
  if (!source) {
    return null;
  }

  if (clip.still_image || clip.media_kind === "image" || stillAssetIds.includes(clip.asset_id)) {
    return (
      <ClipMedia
        clip={clip}
        source={source}
        frameRate={frameRate}
        objectFit={objectFit}
        stillAssetIds={stillAssetIds}
        muted
      />
    );
  }

  const clipEnd = clip.timeline_in_frame + clip.timeline_duration_frames;
  const visibleFrames = Math.min(windowFrames, clipEnd - windowStart);
  if (visibleFrames <= 0) {
    return null;
  }
  const offsetIntoWindow = Math.max(0, windowStart - clip.timeline_in_frame);
  const srcInFrames = microsecondsToFrames(clip.src_in_us, frameRate);
  const startFrom = srcInFrames + offsetIntoWindow;

  return (
    <ClipMedia
      clip={clip}
      source={source}
      frameRate={frameRate}
      objectFit={objectFit}
      stillAssetIds={stillAssetIds}
      muted
      startFrom={startFrom}
      endAt={startFrom + visibleFrames}
    />
  );
}

function TransitionInstance({
  transition,
  fromClip,
  toClip,
  fps,
  frameRate,
  sourceMap,
  stillAssetIds,
  letterboxPolicy,
}: {
  transition: RemotionTransition;
  fromClip: ClipOutput;
  toClip: ClipOutput;
  fps: number;
  frameRate?: RationalFrameRate;
  sourceMap?: Record<string, string>;
  stillAssetIds?: string[];
  letterboxPolicy?: "none" | "pillarbox" | "letterbox";
}) {
  const frame = useCurrentFrame();

  const durationFrames = transitionDurationFrames(transition);
  if (durationFrames <= 0) {
    return null;
  }

  const preflight = preflightTransition(
    transition,
    fromClip,
    toClip,
    fps,
  );
  if (isVisualNoOp(preflight.effective_type)) {
    return null;
  }

  const preset = resolveTransitionPreset(preflight.effective_type);
  if (preset === null) {
    return null;
  }

  // useCurrentFrame() is SEQUENCE-LOCAL: TransitionInstance only ever
  // renders inside the <Sequence from={window.startFrame}> mounted by
  // TransitionLayer, so Remotion has already subtracted the Sequence
  // offset. Subtracting the absolute windowStart here again would pin
  // localFrame below zero for the whole window (progress stuck at 0).
  const localFrame = frame;
  // ffmpeg's xfade alpha is 0 on the FIRST window frame. For a degenerate
  // 1-frame window that single frame must therefore show clip A to stay
  // aligned with the final render (and with the D < 2 styling skip in the
  // filtergraph). Legacy presets keep their historical D == 1 behavior.
  const progress =
    durationFrames <= 1
      ? OVERLAP_CHILD_PRESETS.has(preflight.effective_type)
        ? 0
        : 1
      : Math.max(0, Math.min(1, localFrame / (durationFrames - 1)));
  const opacity =
    preflight.effective_type === "match_cut_soft"
      ? Math.min(progress, 0.4)
      : progress;
  const window = resolveTransitionWindow(transition, toClip);

  // Issue #34 A/B roll presets composite the real outgoing/incoming media
  // inside the window — the underlying clip Sequences hard-cut at the
  // overlap start, so without real children these presets would render an
  // empty fill over a premature hard cut instead of a true A/B blend.
  let childrenA: ReactNode = null;
  let childrenB: ReactNode = null;
  if (OVERLAP_CHILD_PRESETS.has(preflight.effective_type) && frameRate && sourceMap) {
    const objectFit = objectFitForLetterboxPolicy(letterboxPolicy);
    childrenA = (
      <ClipWindowMedia
        clip={fromClip}
        windowStart={window.startFrame}
        windowFrames={window.durationInFrames}
        frameRate={frameRate}
        sourceMap={sourceMap}
        stillAssetIds={stillAssetIds ?? []}
        objectFit={objectFit}
      />
    );
    childrenB = (
      <ClipWindowMedia
        clip={toClip}
        windowStart={window.startFrame}
        windowFrames={window.durationInFrames}
        frameRate={frameRate}
        sourceMap={sourceMap}
        stillAssetIds={stillAssetIds ?? []}
        objectFit={objectFit}
      />
    );
  }

  return preset.render({
    progress,
    opacity,
    localFrame,
    durationInFrames: window.durationInFrames,
    metadata: transition.transition_params,
    childrenA,
    childrenB,
  });
}

export function TransitionLayer({ transitions, tracks, fps, frameRate, sourceMap, stillAssetIds, letterboxPolicy }: TransitionLayerProps) {
  if (transitions.length === 0) {
    return null;
  }

  return (
    <>
      {transitions.map((transition) => {
        const remotionTransition = transition as RemotionTransition;
        const fromClip = findClipById(tracks.video, remotionTransition.from_clip_id);
        const toClip = findClipById(tracks.video, remotionTransition.to_clip_id);
        const durationFrames = transitionDurationFrames(remotionTransition);
        if (!fromClip || !toClip || durationFrames <= 0) {
          return null;
        }

        const window = resolveTransitionWindow(remotionTransition, toClip);

        return (
          <Sequence
            key={remotionTransition.transition_id}
            from={window.startFrame}
            durationInFrames={window.durationInFrames}
            name={remotionTransition.transition_id}
          >
            <TransitionInstance
              transition={remotionTransition}
              fromClip={fromClip}
              toClip={toClip}
              fps={fps}
              frameRate={frameRate}
              sourceMap={sourceMap}
              stillAssetIds={stillAssetIds}
              letterboxPolicy={letterboxPolicy}
            />
          </Sequence>
        );
      })}
    </>
  );
}
