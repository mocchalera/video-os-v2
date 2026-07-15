import type { SegmentItem } from "../connectors/ffmpeg-segmenter.js";
import type { ClipOutput, EndingPolicy, TimelineIR } from "./types.js";
import type { UtteranceSpan } from "./trim.js";

export type EndingFadeColor = "none" | "black" | "white";

export interface ResolvedEndingTreatment {
  tailHoldSec: number;
  audioFadeOutSec: number;
  videoFadeOutSec: number;
  videoFadeColor: EndingFadeColor;
}

export interface AppliedEndingTreatment extends ResolvedEndingTreatment {
  extendedFrames: number;
  audioClipCount: number;
  finalVideoClipId?: string;
}

const DEFAULT_AUDIO_FADE_OUT_SEC = 1;
const DEFAULT_VIDEO_FADE_OUT_SEC = 1;

export function resolveEndingTreatment(
  policy: EndingPolicy | undefined,
): ResolvedEndingTreatment {
  const strategy = policy?.final_visual_strategy?.toLowerCase() ?? "";
  const audioStrategy = policy?.final_audio_strategy?.toLowerCase() ?? "";
  const inferredColor: EndingFadeColor = strategy.includes("white")
    ? "white"
    : strategy.includes("black")
      ? "black"
      : "none";
  const videoFadeColor = policy?.video_fade_color ?? inferredColor;

  return {
    tailHoldSec: nonNegative(policy?.tail_hold_sec, 0),
    audioFadeOutSec: nonNegative(
      policy?.audio_fade_out_sec,
      audioStrategy.includes("fade") ? DEFAULT_AUDIO_FADE_OUT_SEC : 0,
    ),
    videoFadeOutSec: nonNegative(
      policy?.video_fade_out_sec,
      videoFadeColor === "none" ? 0 : DEFAULT_VIDEO_FADE_OUT_SEC,
    ),
    videoFadeColor,
  };
}

export function applyEndingTreatment(
  timeline: TimelineIR,
  policy: EndingPolicy | undefined,
  segments: SegmentItem[],
  fps: number,
  utteranceMap: Map<string, UtteranceSpan[]> = new Map(),
): AppliedEndingTreatment {
  const treatment = resolveEndingTreatment(policy);
  if (
    treatment.tailHoldSec === 0 &&
    treatment.audioFadeOutSec === 0 &&
    treatment.videoFadeOutSec === 0 &&
    treatment.videoFadeColor === "none"
  ) {
    return { ...treatment, extendedFrames: 0, audioClipCount: 0 };
  }
  const videoClips = timeline.tracks.video.flatMap((track) => track.clips);
  const finalVideoClip = [...videoClips].sort(compareClipEnd).at(-1);
  if (!finalVideoClip || !Number.isFinite(fps) || fps <= 0) {
    return { ...treatment, extendedFrames: 0, audioClipCount: 0 };
  }

  const segment = segments.find((item) => item.segment_id === finalVideoClip.segment_id);
  let availableHandleUs = segment
    ? Math.max(0, segment.src_out_us - finalVideoClip.src_out_us)
    : 0;
  const desiredTailFrames = Math.max(0, Math.round(treatment.tailHoldSec * fps));
  const requestedSrcOutUs = finalVideoClip.src_out_us + Math.round(desiredTailFrames * 1_000_000 / fps);
  const nextSpeechStartUs = findNextSpeechStart(
    utteranceMap.get(finalVideoClip.asset_id) ?? [],
    finalVideoClip.src_out_us,
  );
  const clampedByNextSpeech = nextSpeechStartUs !== undefined && nextSpeechStartUs < requestedSrcOutUs;
  if (nextSpeechStartUs !== undefined) {
    availableHandleUs = Math.min(
      availableHandleUs,
      Math.max(0, nextSpeechStartUs - finalVideoClip.src_out_us),
    );
  }
  const availableTailFrames = Math.max(0, Math.floor(availableHandleUs * fps / 1_000_000));
  const extendedFrames = Math.min(desiredTailFrames, availableTailFrames);
  const extensionUs = Math.round(extendedFrames * 1_000_000 / fps);

  if (extendedFrames > 0) {
    finalVideoClip.src_out_us += extensionUs;
    finalVideoClip.timeline_duration_frames += extendedFrames;
  }

  const audioFadeOutFrames = Math.min(
    finalVideoClip.timeline_duration_frames,
    Math.max(0, Math.round(treatment.audioFadeOutSec * fps)),
  );
  const videoFadeOutFrames = treatment.videoFadeColor === "none"
    ? 0
    : Math.min(
        finalVideoClip.timeline_duration_frames,
        Math.max(0, Math.round(treatment.videoFadeOutSec * fps)),
      );

  attachEndingMetadata(
    finalVideoClip,
    extendedFrames,
    audioFadeOutFrames,
    videoFadeOutFrames,
    treatment.videoFadeColor,
    clampedByNextSpeech,
  );

  const mirroredAudio = timeline.tracks.audio
    .flatMap((track) => track.clips)
    .filter((clip) =>
      clip.asset_id === finalVideoClip.asset_id &&
      clip.segment_id === finalVideoClip.segment_id &&
      clip.timeline_in_frame === finalVideoClip.timeline_in_frame &&
      clip.src_in_us === finalVideoClip.src_in_us
    );

  for (const clip of mirroredAudio) {
    if (extendedFrames > 0) {
      clip.src_out_us += extensionUs;
      clip.timeline_duration_frames += extendedFrames;
    }
    clip.audio_policy = {
      ...(clip.audio_policy ?? {}),
      fade_out_frames: Math.max(clip.audio_policy?.fade_out_frames ?? 0, audioFadeOutFrames),
      nat_sound_fade_out_frames: Math.max(
        clip.audio_policy?.nat_sound_fade_out_frames ?? 0,
        audioFadeOutFrames,
      ),
    };
    attachEndingMetadata(
      clip,
      extendedFrames,
      audioFadeOutFrames,
      videoFadeOutFrames,
      treatment.videoFadeColor,
      clampedByNextSpeech,
    );
  }

  return {
    ...treatment,
    extendedFrames,
    audioClipCount: mirroredAudio.length,
    finalVideoClipId: finalVideoClip.clip_id,
  };
}

function compareClipEnd(left: ClipOutput, right: ClipOutput): number {
  const leftEnd = left.timeline_in_frame + left.timeline_duration_frames;
  const rightEnd = right.timeline_in_frame + right.timeline_duration_frames;
  return leftEnd - rightEnd || left.clip_id.localeCompare(right.clip_id);
}

function attachEndingMetadata(
  clip: ClipOutput,
  extendedFrames: number,
  audioFadeOutFrames: number,
  videoFadeOutFrames: number,
  videoFadeColor: EndingFadeColor,
  clampedByNextSpeech: boolean,
): void {
  clip.metadata = {
    ...(clip.metadata ?? {}),
    ending_treatment: {
      extended_frames: extendedFrames,
      audio_fade_out_frames: audioFadeOutFrames,
      video_fade_out_frames: videoFadeOutFrames,
      video_fade_color: videoFadeColor,
      clamped_before_next_speech: clampedByNextSpeech,
    },
  };
}

function findNextSpeechStart(
  utterances: UtteranceSpan[],
  sourceOutUs: number,
): number | undefined {
  const overlapping = utterances
    .filter((utterance) => utterance.start_us < sourceOutUs && utterance.end_us > sourceOutUs)
    .sort((left, right) => left.start_us - right.start_us)[0];
  if (overlapping) return sourceOutUs;
  return utterances
    .filter((utterance) => utterance.start_us >= sourceOutUs)
    .sort((left, right) => left.start_us - right.start_us)[0]?.start_us;
}

function nonNegative(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
}
