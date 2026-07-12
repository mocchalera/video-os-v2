import { Sequence, useCurrentFrame } from "remotion";
import type {
  ClipOutput,
  TimelineTransitionOutput,
  TrackOutput,
} from "../../../compiler/types.js";
import { preflightTransition } from "../preflight-transitions.js";
import { resolveTransitionPreset } from "../styles/transition-presets.js";

export interface TransitionLayerProps {
  transitions: TimelineTransitionOutput[];
  tracks: {
    video: TrackOutput[];
  };
  fps: number;
}

type RemotionTransition = TimelineTransitionOutput & {
  duration_frames?: number;
  start_frame?: number;
};

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

function transitionStartFrame(
  t: RemotionTransition,
  toClip: ClipOutput,
  durationFrames: number,
): number {
  return t.start_frame ?? Math.max(0, toClip.timeline_in_frame - durationFrames);
}

function isVisualNoOp(type: string): boolean {
  return type === "cut" || type === "j_cut" || type === "l_cut";
}

function TransitionInstance({
  transition,
  fromClip,
  toClip,
  fps,
}: {
  transition: RemotionTransition;
  fromClip: ClipOutput;
  toClip: ClipOutput;
  fps: number;
}) {
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

  const frame = useCurrentFrame();
  const localFrame = frame - transitionStartFrame(transition, toClip, durationFrames);
  const progress =
    durationFrames <= 1 ? 1 : Math.max(0, Math.min(1, localFrame / (durationFrames - 1)));
  const opacity =
    preflight.effective_type === "match_cut_soft"
      ? Math.min(progress, 0.4)
      : progress;

  return preset.render({
    progress,
    opacity,
    durationInFrames: durationFrames,
    metadata: transition.transition_params,
  });
}

export function TransitionLayer({ transitions, tracks, fps }: TransitionLayerProps) {
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

        return (
          <Sequence
            key={remotionTransition.transition_id}
            from={transitionStartFrame(remotionTransition, toClip, durationFrames)}
            durationInFrames={durationFrames}
            name={remotionTransition.transition_id}
          >
            <TransitionInstance
              transition={remotionTransition}
              fromClip={fromClip}
              toClip={toClip}
              fps={fps}
            />
          </Sequence>
        );
      })}
    </>
  );
}
