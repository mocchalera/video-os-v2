import { createHash } from "node:crypto";
import type { CaptionApproval } from "../caption/approval.js";
import type {
  CaptionReviewPreview,
  ReviewedCaptionEntry,
} from "../caption/review-core.js";
import {
  MIN_CAPTION_TARGET_DWELL_MS,
} from "../caption/segmenter.js";
import type { TimelineIR } from "../compiler/types.js";
import {
  deriveShortFormRetentionProfile,
  type ShortFormRetentionMode,
} from "../editorial/short-form-retention.js";

export const CAPTION_DELIVERY_QA_VERSION =
  "caption-delivery-qa/v1" as const;

export type CaptionDeliveryIssueCode =
  | "premature_caption_lead"
  | "caption_lag"
  | "caption_ends_before_speech"
  | "insufficient_read_time";

export type CaptionDeliverySuggestedAction =
  | "delay_in"
  | "advance_in"
  | "extend_out"
  | "extend_read_time";

export interface CaptionDeliveryQAThresholds {
  ordinary_lead_frames: number;
  question_audio_first_frames: number;
  max_lag_ms: number;
  speech_end_tolerance_frames: number;
  min_dwell_ms: number;
  cps_limit: number;
  source: string;
}

export interface CaptionDeliveryQAReviewItem {
  issue_id: string;
  code: CaptionDeliveryIssueCode;
  severity: "review";
  caption_id: string;
  asset_id: string;
  segment_id: string;
  text_excerpt: string;
  caption_start_frame: number;
  caption_end_frame: number;
  audio_start_frame: number;
  audio_end_frame: number;
  timeline_start_frame: number;
  timeline_end_frame: number;
  start_timecode: string;
  end_timecode: string;
  measured_ms: number;
  threshold_ms: number;
  suggested_action: CaptionDeliverySuggestedAction;
  title_ja: string;
  remediation_ja: string;
}

export interface CaptionDeliveryQAResult {
  version: typeof CAPTION_DELIVERY_QA_VERSION;
  status:
    | "verified"
    | "review_required"
    | "incomplete"
    | "not_applicable";
  mode: ShortFormRetentionMode;
  checked_caption_count: number;
  evidence_caption_count: number;
  incomplete_caption_count: number;
  intentional_reveal_count: number;
  thresholds: CaptionDeliveryQAThresholds;
  reason?: string;
  review_items: CaptionDeliveryQAReviewItem[];
}

export interface EvaluateCaptionDeliveryQAInput {
  timeline: TimelineIR;
  brief: unknown;
  approval?: CaptionApproval;
  reviewPreview?: CaptionReviewPreview;
}

interface DialogueClip {
  clip_id: string;
  segment_id: string;
  asset_id: string;
  src_in_us: number;
  src_out_us: number;
  timeline_in_frame: number;
  timeline_duration_frames: number;
}

interface CaptionEvidence {
  approvalCaption: CaptionApproval["speech_captions"][number];
  previewCaption: ReviewedCaptionEntry;
  audioStartFrame: number;
  audioEndFrame: number;
}

const PRESENTATION: Record<
  CaptionDeliveryIssueCode,
  {
    priority: number;
    action: CaptionDeliverySuggestedAction;
    title: string;
    remediation: string;
  }
> = {
  premature_caption_lead: {
    priority: 0,
    action: "delay_in",
    title: "字幕が音声より先行",
    remediation:
      "単語の発話開始を基準に字幕INを後ろへ移し、内容を先に読ませすぎないタイミングへ合わせてください。",
  },
  caption_lag: {
    priority: 1,
    action: "advance_in",
    title: "字幕の出現が遅い",
    remediation:
      "発話の頭が字幕なしになっています。単語の発話開始へ字幕INを近づけ、音声との一体感を確認してください。",
  },
  caption_ends_before_speech: {
    priority: 2,
    action: "extend_out",
    title: "言い切る前に字幕が消える",
    remediation:
      "参照する最後の単語が終わるまで字幕OUTを延ばし、次字幕との間隔も合わせて確認してください。",
  },
  insufficient_read_time: {
    priority: 3,
    action: "extend_read_time",
    title: "字幕を読む時間が短い",
    remediation:
      "字幕OUTを延ばすか、前後字幕との分割・結合を見直し、言葉の強さに見合う読了時間を確保してください。",
  },
};

/**
 * Review the exact caption delivery that will be packaged.
 *
 * The detector is intentionally read-only and advisory. Word timing comes
 * from the hash-bound review preview while cue text and ranges come from the
 * approved delivery artifact. Any mismatch is reported as incomplete instead
 * of treating stale timing evidence as verified.
 */
export function evaluateCaptionDeliveryQA(
  input: EvaluateCaptionDeliveryQAInput,
): CaptionDeliveryQAResult {
  const profile = deriveShortFormRetentionProfile(input.brief);
  const language = input.approval?.caption_policy.language ?? "ja";
  const ordinaryLeadFrames = Math.max(
    0,
    input.approval?.caption_policy.semantic_timing
      ?.ordinary_lead_frames ?? 2,
  );
  const questionAudioFirstFrames = Math.max(
    0,
    input.approval?.caption_policy.semantic_timing
      ?.question_audio_first_frames ?? 0,
  );
  const thresholds = thresholdsFor(
    profile.mode,
    language,
    ordinaryLeadFrames,
    questionAudioFirstFrames,
  );
  if (!profile.enabled) {
    return result("not_applicable", profile.mode, thresholds, {
      reason: "short-social retention profile is not active",
    });
  }

  const approval = input.approval;
  if (
    !approval ||
    approval.caption_policy.source === "none" ||
    approval.speech_captions.length === 0
  ) {
    return result("not_applicable", profile.mode, thresholds, {
      reason: "approved speech captions are not present",
    });
  }
  if (approval.project_id !== input.timeline.project_id) {
    return result("incomplete", profile.mode, thresholds, {
      checkedCaptionCount: approval.speech_captions.length,
      incompleteCaptionCount: approval.speech_captions.length,
      reason:
        `caption approval project_id=${approval.project_id} does not match ` +
        `timeline project_id=${input.timeline.project_id}`,
    });
  }

  const preview = input.reviewPreview;
  if (!preview) {
    return result("incomplete", profile.mode, thresholds, {
      checkedCaptionCount: approval.speech_captions.length,
      incompleteCaptionCount: approval.speech_captions.length,
      reason:
        "07_package/caption_review_preview.json is required for word-grounded caption delivery review",
    });
  }
  const previewIdentityIssue = validatePreviewIdentity(approval, preview);
  if (previewIdentityIssue) {
    return result("incomplete", profile.mode, thresholds, {
      checkedCaptionCount: approval.speech_captions.length,
      incompleteCaptionCount: approval.speech_captions.length,
      reason: previewIdentityIssue,
    });
  }

  const fpsNum = input.timeline.sequence.fps_num;
  const fpsDen = input.timeline.sequence.fps_den;
  if (!positiveInteger(fpsNum) || !positiveInteger(fpsDen)) {
    return result("incomplete", profile.mode, thresholds, {
      checkedCaptionCount: approval.speech_captions.length,
      incompleteCaptionCount: approval.speech_captions.length,
      reason: "timeline rational frame rate is missing or invalid",
    });
  }

  const previewByID = new Map(
    preview.speech_captions.map((caption) => [caption.caption_id, caption]),
  );
  const clips = dialogueClips(input.timeline);
  const evidence: CaptionEvidence[] = [];
  const incompleteCaptionIDs: string[] = [];

  for (const approvalCaption of approval.speech_captions) {
    const previewCaption = previewByID.get(approvalCaption.caption_id);
    if (
      !previewCaption ||
      !captionMatchesApproval(approvalCaption, previewCaption)
    ) {
      incompleteCaptionIDs.push(approvalCaption.caption_id);
      continue;
    }
    const wordRefs = previewCaption.timing?.sourceWordRefs;
    if (!wordRefs || wordRefs.length === 0) {
      incompleteCaptionIDs.push(approvalCaption.caption_id);
      continue;
    }
    const sourceStartUs = Math.min(...wordRefs.map((word) => word.start_us));
    const sourceEndUs = Math.max(...wordRefs.map((word) => word.end_us));
    if (
      !nonNegativeInteger(sourceStartUs) ||
      !positiveInteger(sourceEndUs) ||
      sourceEndUs <= sourceStartUs
    ) {
      incompleteCaptionIDs.push(approvalCaption.caption_id);
      continue;
    }
    const clip = bestMatchingClip(
      clips,
      approvalCaption.asset_id,
      approvalCaption.segment_id,
      sourceStartUs,
      sourceEndUs,
      approvalCaption.timeline_in_frame,
    );
    if (!clip) {
      incompleteCaptionIDs.push(approvalCaption.caption_id);
      continue;
    }
    const audioStartFrame = mapSourceUsToTimelineFrame(sourceStartUs, clip);
    const audioEndFrame = mapSourceUsToTimelineFrame(sourceEndUs, clip);
    if (audioEndFrame <= audioStartFrame) {
      incompleteCaptionIDs.push(approvalCaption.caption_id);
      continue;
    }
    evidence.push({
      approvalCaption,
      previewCaption,
      audioStartFrame,
      audioEndFrame,
    });
  }

  if (incompleteCaptionIDs.length > 0) {
    return result("incomplete", profile.mode, thresholds, {
      checkedCaptionCount: approval.speech_captions.length,
      evidenceCaptionCount: evidence.length,
      incompleteCaptionCount: incompleteCaptionIDs.length,
      reason:
        `caption review timing evidence does not match approval or lacks word timing: ` +
        incompleteCaptionIDs.join(","),
    });
  }

  const reviewItems: CaptionDeliveryQAReviewItem[] = [];
  let intentionalRevealCount = 0;
  for (const item of evidence) {
    const caption = item.approvalCaption;
    const captionStart = caption.timeline_in_frame;
    const captionEnd = captionStart + caption.timeline_duration_frames;
    const reveal = caption.reveal_timing;
    const protectedReveal = reveal?.status === "protected" &&
      reveal.anchor_frame !== undefined;
    if (protectedReveal) intentionalRevealCount += 1;

    const expectedStart = protectedReveal
      ? reveal.anchor_frame! + reveal.audio_first_frames
      : isQuestionCaption(caption.text)
        ? item.audioStartFrame + thresholds.question_audio_first_frames
        : item.audioStartFrame - thresholds.ordinary_lead_frames;

    if (captionStart < expectedStart) {
      reviewItems.push(buildReviewItem({
        code: "premature_caption_lead",
        caption,
        audioStartFrame: item.audioStartFrame,
        audioEndFrame: item.audioEndFrame,
        timelineStartFrame: captionStart,
        timelineEndFrame: expectedStart,
        measuredMs: frameDurationMs(
          expectedStart - captionStart,
          fpsNum,
          fpsDen,
        ),
        thresholdMs: frameDurationMs(
          protectedReveal
            ? 0
            : isQuestionCaption(caption.text)
              ? thresholds.question_audio_first_frames
              : thresholds.ordinary_lead_frames,
          fpsNum,
          fpsDen,
        ),
        fpsNum,
        fpsDen,
      }));
    } else {
      const lagReferenceStart = protectedReveal || isQuestionCaption(caption.text)
        ? expectedStart
        : item.audioStartFrame;
      const lagFrames = captionStart - lagReferenceStart;
      const lagMs = frameDurationMs(lagFrames, fpsNum, fpsDen);
      if (lagMs > thresholds.max_lag_ms) {
        reviewItems.push(buildReviewItem({
          code: "caption_lag",
          caption,
          audioStartFrame: item.audioStartFrame,
          audioEndFrame: item.audioEndFrame,
          timelineStartFrame: lagReferenceStart,
          timelineEndFrame: captionStart,
          measuredMs: lagMs,
          thresholdMs: thresholds.max_lag_ms,
          fpsNum,
          fpsDen,
        }));
      }
    }

    const missingSpeechFrames = item.audioEndFrame - captionEnd;
    if (missingSpeechFrames > thresholds.speech_end_tolerance_frames) {
      reviewItems.push(buildReviewItem({
        code: "caption_ends_before_speech",
        caption,
        audioStartFrame: item.audioStartFrame,
        audioEndFrame: item.audioEndFrame,
        timelineStartFrame: captionEnd,
        timelineEndFrame: item.audioEndFrame,
        measuredMs: frameDurationMs(
          missingSpeechFrames,
          fpsNum,
          fpsDen,
        ),
        thresholdMs: frameDurationMs(
          thresholds.speech_end_tolerance_frames,
          fpsNum,
          fpsDen,
        ),
        fpsNum,
        fpsDen,
      }));
    }

    const dwellMs = frameDurationMs(
      caption.timeline_duration_frames,
      fpsNum,
      fpsDen,
    );
    const requiredReadMs = requiredReadTimeMs(
      caption.text,
      thresholds.cps_limit,
    );
    if (dwellMs < requiredReadMs) {
      reviewItems.push(buildReviewItem({
        code: "insufficient_read_time",
        caption,
        audioStartFrame: item.audioStartFrame,
        audioEndFrame: item.audioEndFrame,
        timelineStartFrame: captionStart,
        timelineEndFrame: captionEnd,
        measuredMs: dwellMs,
        thresholdMs: requiredReadMs,
        fpsNum,
        fpsDen,
      }));
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
      checkedCaptionCount: approval.speech_captions.length,
      evidenceCaptionCount: evidence.length,
      intentionalRevealCount,
      reviewItems,
    },
  );
}

function result(
  status: CaptionDeliveryQAResult["status"],
  mode: ShortFormRetentionMode,
  thresholds: CaptionDeliveryQAThresholds,
  options: {
    checkedCaptionCount?: number;
    evidenceCaptionCount?: number;
    incompleteCaptionCount?: number;
    intentionalRevealCount?: number;
    reason?: string;
    reviewItems?: CaptionDeliveryQAReviewItem[];
  } = {},
): CaptionDeliveryQAResult {
  return {
    version: CAPTION_DELIVERY_QA_VERSION,
    status,
    mode,
    checked_caption_count: options.checkedCaptionCount ?? 0,
    evidence_caption_count: options.evidenceCaptionCount ?? 0,
    incomplete_caption_count: options.incompleteCaptionCount ?? 0,
    intentional_reveal_count: options.intentionalRevealCount ?? 0,
    thresholds,
    ...(options.reason ? { reason: options.reason } : {}),
    review_items: options.reviewItems ?? [],
  };
}

function thresholdsFor(
  mode: ShortFormRetentionMode,
  language: string,
  ordinaryLeadFrames: number,
  questionAudioFirstFrames: number,
): CaptionDeliveryQAThresholds {
  const japanese = language === "ja" ||
    language === "jp" ||
    language.startsWith("ja-");
  const maxLagMs = mode === "aggressive"
    ? 120
    : mode === "standard"
      ? 200
      : mode === "credibility_first"
        ? 300
        : 0;
  return {
    ordinary_lead_frames: ordinaryLeadFrames,
    question_audio_first_frames: questionAudioFirstFrames,
    max_lag_ms: maxLagMs,
    speech_end_tolerance_frames: 1,
    min_dwell_ms: MIN_CAPTION_TARGET_DWELL_MS,
    cps_limit: japanese ? 16 : 15,
    source:
      `caption-semantic-timing+short-form-retention/${mode}/v1`,
  };
}

function validatePreviewIdentity(
  approval: CaptionApproval,
  preview: CaptionReviewPreview,
): string | undefined {
  if (approval.approval.status !== "approved") {
    return "caption approval is not approved";
  }
  if (preview.project_id !== approval.project_id) {
    return (
      `caption_review_preview project_id=${preview.project_id} does not match ` +
      `approval project_id=${approval.project_id}`
    );
  }
  const approvedDraftHash = approval.approval.base_caption_draft_hash;
  if (!approvedDraftHash) {
    return "caption approval is missing base_caption_draft_hash";
  }
  if (
    preview.base_caption_draft_hash !== approvedDraftHash
  ) {
    return (
      `caption_review_preview base hash does not match approved caption draft ` +
      `hash`
    );
  }
  if (!preview.validation.valid) {
    return "caption_review_preview validation is not valid";
  }
  return undefined;
}

function captionMatchesApproval(
  approval: CaptionApproval["speech_captions"][number],
  preview: ReviewedCaptionEntry,
): boolean {
  return approval.caption_id === preview.caption_id &&
    approval.asset_id === preview.asset_id &&
    approval.segment_id === preview.segment_id &&
    approval.text === preview.text &&
    approval.timeline_in_frame === preview.timeline_in_frame &&
    approval.timeline_duration_frames === preview.timeline_duration_frames;
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
      segment_id: clip.segment_id,
      asset_id: clip.asset_id,
      src_in_us: clip.src_in_us,
      src_out_us: clip.src_out_us,
      timeline_in_frame: clip.timeline_in_frame,
      timeline_duration_frames: clip.timeline_duration_frames,
    }))
    .sort((left, right) =>
      left.timeline_in_frame - right.timeline_in_frame ||
      left.clip_id.localeCompare(right.clip_id)
    );
}

function bestMatchingClip(
  clips: DialogueClip[],
  assetID: string,
  segmentID: string,
  sourceStartUs: number,
  sourceEndUs: number,
  captionStartFrame: number,
): DialogueClip | undefined {
  const exact = clips.filter((clip) =>
    clip.asset_id === assetID &&
    clip.segment_id === segmentID &&
    sourceStartUs >= clip.src_in_us &&
    sourceEndUs <= clip.src_out_us
  );
  const candidates = exact.length > 0
    ? exact
    : clips.filter((clip) =>
      clip.asset_id === assetID &&
      sourceStartUs >= clip.src_in_us &&
      sourceEndUs <= clip.src_out_us
    );
  return [...candidates].sort((left, right) =>
    Math.abs(
      mapSourceUsToTimelineFrame(sourceStartUs, left) - captionStartFrame,
    ) -
      Math.abs(
        mapSourceUsToTimelineFrame(sourceStartUs, right) - captionStartFrame,
      ) ||
    left.timeline_in_frame - right.timeline_in_frame ||
    left.clip_id.localeCompare(right.clip_id)
  )[0];
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

function requiredReadTimeMs(text: string, cpsLimit: number): number {
  const visibleText = text
    .replace(/^(?:AI|画面|坂本)[｜|]/u, "")
    .replace(/\s+/gu, "");
  const densityMs = Math.ceil(
    [...visibleText].length / Math.max(0.001, cpsLimit) * 1_000,
  );
  return Math.max(MIN_CAPTION_TARGET_DWELL_MS, densityMs);
}

function isQuestionCaption(text: string): boolean {
  const body = text
    .replace(/^(?:AI|画面|坂本)[｜|]/u, "")
    .replace(/\s+/gu, "");
  return /[?？]/u.test(body) ||
    /(?:ですか|ますか|でしょうか|ませんか|だろうか|なんだろう|できるかな|じゃないかな)[。！!…]*$/u
      .test(body);
}

function buildReviewItem(input: {
  code: CaptionDeliveryIssueCode;
  caption: CaptionApproval["speech_captions"][number];
  audioStartFrame: number;
  audioEndFrame: number;
  timelineStartFrame: number;
  timelineEndFrame: number;
  measuredMs: number;
  thresholdMs: number;
  fpsNum: number;
  fpsDen: number;
}): CaptionDeliveryQAReviewItem {
  const presentation = PRESENTATION[input.code];
  const captionStartFrame = input.caption.timeline_in_frame;
  const captionEndFrame = captionStartFrame +
    input.caption.timeline_duration_frames;
  const identity = {
    code: input.code,
    caption_id: input.caption.caption_id,
    asset_id: input.caption.asset_id,
    segment_id: input.caption.segment_id,
    caption_start_frame: captionStartFrame,
    caption_end_frame: captionEndFrame,
    audio_start_frame: input.audioStartFrame,
    audio_end_frame: input.audioEndFrame,
    timeline_start_frame: input.timelineStartFrame,
    timeline_end_frame: input.timelineEndFrame,
    measured_ms: input.measuredMs,
    threshold_ms: input.thresholdMs,
  };
  return {
    issue_id: stableIssueID(identity),
    code: input.code,
    severity: "review",
    caption_id: input.caption.caption_id,
    asset_id: input.caption.asset_id,
    segment_id: input.caption.segment_id,
    text_excerpt: input.caption.text.slice(0, 80),
    caption_start_frame: captionStartFrame,
    caption_end_frame: captionEndFrame,
    audio_start_frame: input.audioStartFrame,
    audio_end_frame: input.audioEndFrame,
    timeline_start_frame: input.timelineStartFrame,
    timeline_end_frame: input.timelineEndFrame,
    start_timecode: formatFrameClock(
      input.timelineStartFrame,
      input.fpsNum,
      input.fpsDen,
    ),
    end_timecode: formatFrameClock(
      input.timelineEndFrame,
      input.fpsNum,
      input.fpsDen,
    ),
    measured_ms: input.measuredMs,
    threshold_ms: input.thresholdMs,
    suggested_action: presentation.action,
    title_ja: presentation.title,
    remediation_ja: presentation.remediation,
  };
}

function stableIssueID(value: Record<string, unknown>): string {
  const digest = createHash("sha256")
    .update(canonicalJson(value))
    .digest("hex")
    .slice(0, 16)
    .toUpperCase();
  return `CAPTIONQA_${digest}`;
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

function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function nonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
