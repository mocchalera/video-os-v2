import type { SegmentItem } from "../connectors/ffmpeg-segmenter.js";
import type { ClipOutput, TimelineIR } from "./types.js";
import type { UtteranceSpan } from "./trim.js";

export interface CutBreathPolicy {
  preserve_natural_breath: boolean;
  cut_tail_hold_sec?: number;
  cut_audio_fade_out_sec?: number;
}

export interface AppliedCutBreathTreatment {
  extendedCuts: number;
  totalExtendedFrames: number;
  fadedCuts: number;
}

/**
 * Add a short source post-roll after dialogue cuts and ripple the remainder of
 * the sequence. The treatment is opt-in through cut_tail_hold_sec so existing
 * blueprints retain their exact timing. Transcript speech is a hard boundary:
 * post-roll may retain room tone before the next utterance, but must never use
 * the next utterance itself as transition material. When that boundary shortens
 * the requested hold, the retained room-tone tail is faded out.
 */
export function applyCutBreathTreatment(
  timeline: TimelineIR,
  policy: CutBreathPolicy | undefined,
  segments: SegmentItem[],
  utteranceMap: Map<string, UtteranceSpan[]>,
  fps: number,
): AppliedCutBreathTreatment {
  const tailHoldSec = nonNegative(policy?.cut_tail_hold_sec, 0);
  const fallbackFadeSec = nonNegative(policy?.cut_audio_fade_out_sec, 0.16);
  if (
    policy?.preserve_natural_breath !== true ||
    tailHoldSec <= 0 ||
    !Number.isFinite(fps) ||
    fps <= 0
  ) {
    return { extendedCuts: 0, totalExtendedFrames: 0, fadedCuts: 0 };
  }

  const primaryVideoTrack = timeline.tracks.video.find((track) => track.track_id === "V1")
    ?? timeline.tracks.video[0];
  if (!primaryVideoTrack || primaryVideoTrack.clips.length < 2) {
    return { extendedCuts: 0, totalExtendedFrames: 0, fadedCuts: 0 };
  }

  const segmentById = new Map(segments.map((segment) => [segment.segment_id, segment]));
  const desiredTailFrames = Math.max(1, Math.round(tailHoldSec * fps));
  let extendedCuts = 0;
  let totalExtendedFrames = 0;
  let fadedCuts = 0;

  const ordered = primaryVideoTrack.clips
    .slice()
    .sort((left, right) => left.timeline_in_frame - right.timeline_in_frame || left.clip_id.localeCompare(right.clip_id));

  for (let index = 0; index < ordered.length - 1; index++) {
    const clip = ordered[index];
    const nextClip = ordered[index + 1];
    if (hasNonCutTransition(timeline, clip, nextClip)) continue;

    const originalCutFrame = clip.timeline_in_frame + clip.timeline_duration_frames;
    const originalSrcOutUs = clip.src_out_us;
    const segment = segmentById.get(clip.segment_id);
    if (!segment) continue;

    let availableHandleUs = Math.max(0, segment.src_out_us - originalSrcOutUs);
    // Never duplicate media that is already retained by the immediately
    // following clip from the same source.
    if (nextClip.asset_id === clip.asset_id && nextClip.src_in_us >= originalSrcOutUs) {
      availableHandleUs = Math.min(availableHandleUs, nextClip.src_in_us - originalSrcOutUs);
    }
    const nextSpeechStartUs = findNextSpeechStart(
      utteranceMap.get(clip.asset_id) ?? [],
      originalSrcOutUs,
    );
    const requestedSrcOutUs = originalSrcOutUs + Math.round(desiredTailFrames * 1_000_000 / fps);
    const clampedByNextSpeech = nextSpeechStartUs !== undefined && nextSpeechStartUs < requestedSrcOutUs;
    if (nextSpeechStartUs !== undefined) {
      availableHandleUs = Math.min(
        availableHandleUs,
        Math.max(0, nextSpeechStartUs - originalSrcOutUs),
      );
    }
    const availableFrames = Math.max(0, Math.floor(availableHandleUs * fps / 1_000_000));
    const extendedFrames = Math.min(desiredTailFrames, availableFrames);
    if (extendedFrames <= 0) continue;

    const extensionUs = Math.round(extendedFrames * 1_000_000 / fps);
    const mirroredAudio = findMirroredAudio(timeline, clip);
    const fadeOutFrames = clampedByNextSpeech
      ? Math.min(extendedFrames, Math.max(1, Math.round(fallbackFadeSec * fps)))
      : 0;

    shiftTimelineAfter(timeline, originalCutFrame, extendedFrames, new Set([
      clip.clip_id,
      ...mirroredAudio.map((audio) => audio.clip_id),
    ]));
    extendClip(clip, extensionUs, extendedFrames, fadeOutFrames, clampedByNextSpeech);
    for (const audio of mirroredAudio) {
      extendClip(audio, extensionUs, extendedFrames, fadeOutFrames, clampedByNextSpeech);
      if (fadeOutFrames > 0) {
        audio.audio_policy = {
          ...(audio.audio_policy ?? {}),
          fade_out_frames: Math.max(audio.audio_policy?.fade_out_frames ?? 0, fadeOutFrames),
          nat_sound_fade_out_frames: Math.max(
            audio.audio_policy?.nat_sound_fade_out_frames ?? 0,
            fadeOutFrames,
          ),
        };
      }
    }

    extendedCuts++;
    totalExtendedFrames += extendedFrames;
    if (fadeOutFrames > 0) fadedCuts++;
  }

  return { extendedCuts, totalExtendedFrames, fadedCuts };
}

function extendClip(
  clip: ClipOutput,
  extensionUs: number,
  extendedFrames: number,
  fadeOutFrames: number,
  clampedByNextSpeech: boolean,
): void {
  clip.src_out_us += extensionUs;
  clip.timeline_duration_frames += extendedFrames;
  clip.metadata = {
    ...(clip.metadata ?? {}),
    cut_breath_treatment: {
      extended_frames: extendedFrames,
      audio_fade_out_frames: fadeOutFrames,
      next_speech_intrusion: false,
      clamped_before_next_speech: clampedByNextSpeech,
    },
  };
}

function shiftTimelineAfter(
  timeline: TimelineIR,
  cutFrame: number,
  deltaFrames: number,
  excludedClipIds: Set<string>,
): void {
  const tracks = [
    ...timeline.tracks.video,
    ...timeline.tracks.audio,
  ];
  for (const track of tracks) {
    for (const clip of track.clips) {
      if (excludedClipIds.has(clip.clip_id) || clip.timeline_in_frame < cutFrame) continue;
      clip.timeline_in_frame += deltaFrames;
      if (clip.captions) {
        for (const caption of clip.captions) {
          caption.in_frame += deltaFrames;
          caption.out_frame += deltaFrames;
        }
      }
    }
  }
  for (const marker of timeline.markers) {
    if (marker.frame >= cutFrame) marker.frame += deltaFrames;
  }
}

function findMirroredAudio(timeline: TimelineIR, videoClip: ClipOutput): ClipOutput[] {
  return timeline.tracks.audio
    .flatMap((track) => track.clips)
    .filter((clip) =>
      clip.asset_id === videoClip.asset_id &&
      clip.segment_id === videoClip.segment_id &&
      clip.timeline_in_frame === videoClip.timeline_in_frame &&
      clip.src_in_us === videoClip.src_in_us &&
      clip.src_out_us === videoClip.src_out_us
    );
}

function findNextSpeechStart(
  utterances: UtteranceSpan[],
  sourceOutUs: number,
): number | undefined {
  const overlappingNextSpeech = utterances
    .filter((utterance) => utterance.start_us < sourceOutUs && utterance.end_us > sourceOutUs)
    .sort((left, right) => left.start_us - right.start_us)[0];
  if (overlappingNextSpeech) return sourceOutUs;

  return utterances
    .filter((utterance) => utterance.start_us >= sourceOutUs)
    .sort((left, right) => left.start_us - right.start_us)[0]?.start_us;
}

function hasNonCutTransition(
  timeline: TimelineIR,
  clip: ClipOutput,
  nextClip: ClipOutput,
): boolean {
  return (timeline.transitions ?? []).some((transition) =>
    transition.from_clip_id === clip.clip_id &&
    transition.to_clip_id === nextClip.clip_id &&
    transition.transition_type !== "cut"
  );
}

function nonNegative(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
}
