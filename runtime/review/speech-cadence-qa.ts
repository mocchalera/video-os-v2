import { createHash } from "node:crypto";
import type { AudioEventsArtifact } from "../artifacts/audio-events.js";
import type { TimelineIR } from "../compiler/types.js";
import {
  deriveShortFormRetentionProfile,
  type ShortFormRetentionMode,
} from "../editorial/short-form-retention.js";

export const SPEECH_CADENCE_QA_VERSION = "speech-cadence-qa/v1" as const;

export type SpeechCadenceIssueCode =
  | "excessive_head_silence"
  | "excessive_internal_silence"
  | "excessive_tail_silence";

export type SpeechCadenceSuggestedAction =
  | "trim_in"
  | "jump_cut"
  | "trim_out";

export interface SpeechCadenceQAThresholds {
  head_silence_max_ms: number;
  internal_silence_max_ms: number;
  tail_silence_max_ms: number;
  source: string;
}

export interface SpeechCadenceQAReviewItem {
  issue_id: string;
  code: SpeechCadenceIssueCode;
  severity: "review";
  clip_id: string;
  asset_id: string;
  silence_event_id: string;
  source_start_us: number;
  source_end_us: number;
  timeline_start_frame: number;
  timeline_end_frame: number;
  start_timecode: string;
  end_timecode: string;
  duration_ms: number;
  suggested_action: SpeechCadenceSuggestedAction;
  title_ja: string;
  remediation_ja: string;
}

export interface SpeechCadenceQAResult {
  version: typeof SPEECH_CADENCE_QA_VERSION;
  status:
    | "verified"
    | "review_required"
    | "incomplete"
    | "not_applicable";
  mode: ShortFormRetentionMode;
  checked_clip_count: number;
  silence_event_count: number;
  intentional_hold_count: number;
  thresholds: SpeechCadenceQAThresholds;
  reason?: string;
  review_items: SpeechCadenceQAReviewItem[];
}

export interface EvaluateSpeechCadenceQAInput {
  timeline: TimelineIR;
  brief: unknown;
  audioEvents?: AudioEventsArtifact;
}

interface DialogueClip {
  clip_id: string;
  asset_id: string;
  src_in_us: number;
  src_out_us: number;
  timeline_in_frame: number;
  timeline_duration_frames: number;
  metadata?: Record<string, unknown>;
}

const PRESENTATION: Record<
  SpeechCadenceIssueCode,
  {
    priority: number;
    action: SpeechCadenceSuggestedAction;
    title: string;
    remediation: string;
  }
> = {
  excessive_head_silence: {
    priority: 0,
    action: "trim_in",
    title: "発話前の間が長い",
    remediation:
      "音声波形の発話開始直前までIN点を詰め、言葉の頭を欠かない位置で確認してください。",
  },
  excessive_internal_silence: {
    priority: 1,
    action: "jump_cut",
    title: "発話中の間が長い",
    remediation:
      "文脈と表情を確認し、この無音区間をジャンプカットで詰めるか、意図した間として残すか判断してください。",
  },
  excessive_tail_silence: {
    priority: 2,
    action: "trim_out",
    title: "言い切り後の間が長い",
    remediation:
      "語尾と自然な表情を残しつつ、音声波形の無音開始後にOUT点を詰めてください。",
  },
};

/**
 * Project source-space silence evidence into the exact edited timeline.
 *
 * This is intentionally review-only. It never rewrites the timeline because a
 * pause can carry meaning, emotion, or an authored breath treatment.
 */
export function evaluateSpeechCadenceQA(
  input: EvaluateSpeechCadenceQAInput,
): SpeechCadenceQAResult {
  const profile = deriveShortFormRetentionProfile(input.brief);
  const thresholds = thresholdsFor(profile.mode);
  if (!profile.enabled) {
    return result("not_applicable", profile.mode, thresholds, {
      reason: "short-social retention profile is not active",
    });
  }

  const clips = dialogueClips(input.timeline);
  if (clips.length === 0) {
    return result("not_applicable", profile.mode, thresholds, {
      reason: "timeline contains no dialogue clips",
    });
  }

  if (!input.audioEvents) {
    return result("incomplete", profile.mode, thresholds, {
      checkedClipCount: clips.length,
      reason: "03_analysis/audio_events.json is required for waveform-grounded cadence review",
    });
  }
  if (input.audioEvents.project_id !== input.timeline.project_id) {
    return result("incomplete", profile.mode, thresholds, {
      checkedClipCount: clips.length,
      reason:
        `audio_events project_id=${input.audioEvents.project_id} does not match ` +
        `timeline project_id=${input.timeline.project_id}`,
    });
  }

  const fpsNum = input.timeline.sequence.fps_num;
  const fpsDen = input.timeline.sequence.fps_den;
  if (!positiveInteger(fpsNum) || !positiveInteger(fpsDen)) {
    return result("incomplete", profile.mode, thresholds, {
      checkedClipCount: clips.length,
      reason: "timeline rational frame rate is missing or invalid",
    });
  }

  const silenceEvents = input.audioEvents.items.filter((event) =>
    event.type === "silence" &&
    nonNegativeInteger(event.start_us) &&
    positiveInteger(event.end_us) &&
    event.end_us > event.start_us
  );
  const reviewItems: SpeechCadenceQAReviewItem[] = [];
  let intentionalHoldCount = 0;

  for (const clip of clips) {
    const clipEvents = silenceEvents.filter((event) =>
      event.asset_id === clip.asset_id &&
      event.start_us < clip.src_out_us &&
      event.end_us > clip.src_in_us
    );
    for (const event of clipEvents) {
      let sourceStartUs = Math.max(clip.src_in_us, event.start_us);
      let sourceEndUs = Math.min(clip.src_out_us, event.end_us);
      let timelineStartFrame = mapSourceUsToTimelineFrame(
        sourceStartUs,
        clip,
      );
      let timelineEndFrame = mapSourceUsToTimelineFrame(
        sourceEndUs,
        clip,
      );
      if (timelineEndFrame <= timelineStartFrame) continue;

      const atHead = sourceStartUs === clip.src_in_us;
      const atTail = sourceEndUs === clip.src_out_us;
      const code: SpeechCadenceIssueCode = atHead && !atTail
        ? "excessive_head_silence"
        : atTail
          ? "excessive_tail_silence"
          : "excessive_internal_silence";

      if (code === "excessive_tail_silence") {
        const authoredFrames = authoredTailHoldFrames(clip);
        const clipOutFrame =
          clip.timeline_in_frame + clip.timeline_duration_frames;
        const authoredStartFrame = Math.max(
          clip.timeline_in_frame,
          clipOutFrame - authoredFrames,
        );
        if (
          authoredFrames > 0 &&
          timelineEndFrame > authoredStartFrame
        ) {
          intentionalHoldCount += 1;
          timelineEndFrame = Math.min(timelineEndFrame, authoredStartFrame);
          sourceEndUs = mapTimelineFrameToSourceUs(timelineEndFrame, clip);
          if (timelineEndFrame <= timelineStartFrame) continue;
        }
      }

      const durationMs = frameDurationMs(
        timelineEndFrame - timelineStartFrame,
        fpsNum,
        fpsDen,
      );
      if (durationMs <= thresholdForCode(thresholds, code)) continue;

      const presentation = PRESENTATION[code];
      const item: SpeechCadenceQAReviewItem = {
        issue_id: stableIssueID({
          code,
          clip_id: clip.clip_id,
          asset_id: clip.asset_id,
          silence_event_id: event.event_id,
          source_start_us: sourceStartUs,
          source_end_us: sourceEndUs,
          timeline_start_frame: timelineStartFrame,
          timeline_end_frame: timelineEndFrame,
        }),
        code,
        severity: "review",
        clip_id: clip.clip_id,
        asset_id: clip.asset_id,
        silence_event_id: event.event_id,
        source_start_us: sourceStartUs,
        source_end_us: sourceEndUs,
        timeline_start_frame: timelineStartFrame,
        timeline_end_frame: timelineEndFrame,
        start_timecode: formatFrameClock(
          timelineStartFrame,
          fpsNum,
          fpsDen,
        ),
        end_timecode: formatFrameClock(
          timelineEndFrame,
          fpsNum,
          fpsDen,
        ),
        duration_ms: durationMs,
        suggested_action: presentation.action,
        title_ja: presentation.title,
        remediation_ja: presentation.remediation,
      };
      reviewItems.push(item);
    }
  }

  reviewItems.sort((left, right) =>
    left.timeline_start_frame - right.timeline_start_frame ||
    PRESENTATION[left.code].priority - PRESENTATION[right.code].priority ||
    left.issue_id.localeCompare(right.issue_id, "en")
  );
  return result(
    reviewItems.length > 0 ? "review_required" : "verified",
    profile.mode,
    thresholds,
    {
      checkedClipCount: clips.length,
      silenceEventCount: silenceEvents.length,
      intentionalHoldCount,
      reviewItems,
    },
  );
}

function result(
  status: SpeechCadenceQAResult["status"],
  mode: ShortFormRetentionMode,
  thresholds: SpeechCadenceQAThresholds,
  options: {
    checkedClipCount?: number;
    silenceEventCount?: number;
    intentionalHoldCount?: number;
    reason?: string;
    reviewItems?: SpeechCadenceQAReviewItem[];
  } = {},
): SpeechCadenceQAResult {
  return {
    version: SPEECH_CADENCE_QA_VERSION,
    status,
    mode,
    checked_clip_count: options.checkedClipCount ?? 0,
    silence_event_count: options.silenceEventCount ?? 0,
    intentional_hold_count: options.intentionalHoldCount ?? 0,
    thresholds,
    ...(options.reason ? { reason: options.reason } : {}),
    review_items: options.reviewItems ?? [],
  };
}

function thresholdsFor(
  mode: ShortFormRetentionMode,
): SpeechCadenceQAThresholds {
  switch (mode) {
    case "aggressive":
      return {
        head_silence_max_ms: 350,
        internal_silence_max_ms: 600,
        tail_silence_max_ms: 350,
        source: "short-form-retention/aggressive/v1",
      };
    case "credibility_first":
      return {
        head_silence_max_ms: 600,
        internal_silence_max_ms: 1_000,
        tail_silence_max_ms: 600,
        source: "short-form-retention/credibility-first/v1",
      };
    case "standard":
      return {
        head_silence_max_ms: 450,
        internal_silence_max_ms: 750,
        tail_silence_max_ms: 450,
        source: "short-form-retention/standard/v1",
      };
    case "off":
      return {
        head_silence_max_ms: 0,
        internal_silence_max_ms: 0,
        tail_silence_max_ms: 0,
        source: "not-applicable",
      };
  }
}

function thresholdForCode(
  thresholds: SpeechCadenceQAThresholds,
  code: SpeechCadenceIssueCode,
): number {
  switch (code) {
    case "excessive_head_silence":
      return thresholds.head_silence_max_ms;
    case "excessive_internal_silence":
      return thresholds.internal_silence_max_ms;
    case "excessive_tail_silence":
      return thresholds.tail_silence_max_ms;
  }
}

function dialogueClips(timeline: TimelineIR): DialogueClip[] {
  const audioTracks = timeline.tracks.audio ?? [];
  const preferredAudioTracks = audioTracks.some((track) =>
      track.track_id === "A1"
    )
    ? audioTracks.filter((track) => track.track_id === "A1")
    : audioTracks;
  const audioClips = preferredAudioTracks.flatMap((track) => track.clips)
    .filter((clip) => clip.role === "dialogue");
  const candidates = audioClips.length > 0
    ? audioClips
    : timeline.tracks.video.flatMap((track) => track.clips)
      .filter((clip) => clip.role === "dialogue");
  return candidates
    .filter((clip) =>
      nonNegativeInteger(clip.src_in_us) &&
      positiveInteger(clip.src_out_us) &&
      clip.src_out_us > clip.src_in_us &&
      nonNegativeInteger(clip.timeline_in_frame) &&
      positiveInteger(clip.timeline_duration_frames)
    )
    .map((clip) => ({
      clip_id: clip.clip_id,
      asset_id: clip.asset_id,
      src_in_us: clip.src_in_us,
      src_out_us: clip.src_out_us,
      timeline_in_frame: clip.timeline_in_frame,
      timeline_duration_frames: clip.timeline_duration_frames,
      metadata: clip.metadata as Record<string, unknown> | undefined,
    }))
    .sort((left, right) =>
      left.timeline_in_frame - right.timeline_in_frame ||
      left.clip_id.localeCompare(right.clip_id)
    );
}

function mapSourceUsToTimelineFrame(
  sourceUs: number,
  clip: DialogueClip,
): number {
  const sourceSpan = clip.src_out_us - clip.src_in_us;
  const sourceOffset = clamp(sourceUs, clip.src_in_us, clip.src_out_us) -
    clip.src_in_us;
  return clip.timeline_in_frame +
    Math.round(sourceOffset / sourceSpan * clip.timeline_duration_frames);
}

function mapTimelineFrameToSourceUs(
  frame: number,
  clip: DialogueClip,
): number {
  const frameOffset = clamp(
    frame,
    clip.timeline_in_frame,
    clip.timeline_in_frame + clip.timeline_duration_frames,
  ) - clip.timeline_in_frame;
  return clip.src_in_us + Math.round(
    frameOffset / clip.timeline_duration_frames *
      (clip.src_out_us - clip.src_in_us),
  );
}

function authoredTailHoldFrames(clip: DialogueClip): number {
  const treatment = recordValue(clip.metadata?.cut_breath_treatment);
  const value = treatment.extended_frames;
  return nonNegativeInteger(value) ? value : 0;
}

function stableIssueID(
  value: Omit<
    SpeechCadenceQAReviewItem,
    | "issue_id"
    | "severity"
    | "start_timecode"
    | "end_timecode"
    | "duration_ms"
    | "suggested_action"
    | "title_ja"
    | "remediation_ja"
  >,
): string {
  const digest = createHash("sha256")
    .update(canonicalJson(value))
    .digest("hex")
    .slice(0, 16)
    .toUpperCase();
  return `CADENCEQA_${digest}`;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(record[key])}`
    ).join(",")}}`;
  }
  return JSON.stringify(value);
}

function frameDurationMs(
  frames: number,
  fpsNum: number,
  fpsDen: number,
): number {
  return Math.round(frames * fpsDen * 1_000 / fpsNum);
}

function formatFrameClock(
  frame: number,
  fpsNum: number,
  fpsDen: number,
): string {
  const totalMs = frameDurationMs(frame, fpsNum, fpsDen);
  const hours = Math.floor(totalMs / 3_600_000);
  const minutes = Math.floor((totalMs % 3_600_000) / 60_000);
  const seconds = Math.floor((totalMs % 60_000) / 1_000);
  const milliseconds = totalMs % 1_000;
  return [
    String(hours).padStart(2, "0"),
    String(minutes).padStart(2, "0"),
    String(seconds).padStart(2, "0"),
  ].join(":") + `.${String(milliseconds).padStart(3, "0")}`;
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function nonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
