import { describe, expect, it } from "vitest";
import type { CaptionApproval } from "../runtime/caption/approval.js";
import {
  computeCaptionTextHash,
  type CaptionReviewPreview,
  type ReviewedCaptionEntry,
} from "../runtime/caption/review-core.js";
import type { TimelineIR } from "../runtime/compiler/types.js";
import { validateAgainstSchema } from "../runtime/commands/shared.js";
import {
  evaluateCaptionDeliveryQA,
} from "../runtime/review/caption-delivery-qa.js";

function socialBrief(): unknown {
  return {
    project: { format: "social_vertical", runtime_target_sec: 45 },
    editorial: {
      distribution_channel: "shorts",
      aspect_ratio: "9:16",
      hook_priority: "aggressive",
    },
    must_have: ["冒頭0〜2秒で結論を先出し"],
  };
}

function timeline(): TimelineIR {
  const clip = {
    clip_id: "CLIP_001",
    segment_id: "SEG_001",
    asset_id: "AST_001",
    src_in_us: 0,
    src_out_us: 10_000_000,
    timeline_in_frame: 0,
    timeline_duration_frames: 300,
    role: "dialogue",
    motivation: "speech",
    beat_id: "b01",
    fallback_segment_ids: [],
    confidence: 1,
    quality_flags: [],
  };
  return {
    version: "1",
    project_id: "caption-delivery-fixture",
    created_at: "2026-07-25T00:00:00Z",
    sequence: {
      fps_num: 30_000,
      fps_den: 1_001,
      width: 1080,
      height: 1920,
      pixel_aspect: "1:1",
      audio_sample_rate_hz: 48_000,
      channel_layout: "stereo",
      start_timecode: "00:00:00:00",
      drop_frame: false,
      letterbox_policy: "none",
    },
    tracks: {
      video: [{ track_id: "V1", kind: "video", clips: [clip] }],
      audio: [{
        track_id: "A1",
        kind: "audio",
        clips: [structuredClone(clip)],
      }],
    },
    transitions: [],
    markers: [],
    provenance: {},
  } as unknown as TimelineIR;
}

interface CaptionFixture {
  id: string;
  text: string;
  startFrame: number;
  durationFrames: number;
  wordStartUs: number;
  wordEndUs: number;
  reveal?: ReviewedCaptionEntry["reveal_timing"];
}

const CAPTIONS: CaptionFixture[] = [
  {
    id: "SC_LEAD",
    text: "結論を先に言います",
    startFrame: 20,
    durationFrames: 30,
    wordStartUs: 1_000_000,
    wordEndUs: 1_500_000,
  },
  {
    id: "SC_LAG",
    text: "時代が変わります",
    startFrame: 70,
    durationFrames: 30,
    wordStartUs: 2_000_000,
    wordEndUs: 2_500_000,
  },
  {
    id: "SC_EARLY_OUT",
    text: "最後まで言い切る",
    startFrame: 90,
    durationFrames: 30,
    wordStartUs: 3_000_000,
    wordEndUs: 4_500_000,
  },
  {
    id: "SC_FLASH",
    text: "馬鹿げてますよね",
    startFrame: 150,
    durationFrames: 15,
    wordStartUs: 5_000_000,
    wordEndUs: 5_200_000,
  },
  {
    id: "SC_REVEAL",
    text: "価値がある",
    startFrame: 181,
    durationFrames: 30,
    wordStartUs: 6_000_000,
    wordEndUs: 6_500_000,
    reveal: {
      anchor_id: "ANCHOR_VALUE",
      role: "payoff",
      anchor_text: "価値がある",
      status: "protected",
      source: "word_timing",
      anchor_frame: 180,
      audio_first_frames: 1,
      original_timeline_in_frame: 170,
    },
  },
];

function approval(): CaptionApproval {
  return {
    version: "1",
    project_id: "caption-delivery-fixture",
    base_timeline_version: "1",
    caption_policy: {
      language: "ja",
      delivery_mode: "both",
      source: "transcript",
      styling_class: "sns-vertical-speaker-separated-outline",
      semantic_timing: {
        mode: "protect_reveals",
        ordinary_lead_frames: 2,
        audio_first_frames: 1,
      },
    },
    speech_captions: CAPTIONS.map((caption) => ({
      caption_id: caption.id,
      asset_id: "AST_001",
      segment_id: "SEG_001",
      timeline_in_frame: caption.startFrame,
      timeline_duration_frames: caption.durationFrames,
      text: caption.text,
      transcript_ref: "TR_AST_001",
      transcript_item_ids: [`TRI_${caption.id}`],
      source: "transcript",
      styling_class: "sns-vertical-speaker-separated-outline",
      metrics: {
        cps: Math.round(
          [...caption.text].length /
          (caption.durationFrames / (30_000 / 1_001)) *
          100,
        ) / 100,
        dwell_ms: Math.round(
          caption.durationFrames * 1_001 * 1_000 / 30_000,
        ),
      },
      ...(caption.reveal ? { reveal_timing: caption.reveal } : {}),
    })),
    text_overlays: [],
    approval: {
      status: "approved",
      approved_by: "tester",
      approved_at: "2026-07-25T00:00:00Z",
      base_caption_draft_hash:
        "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    },
  };
}

function reviewPreview(): CaptionReviewPreview {
  const speechCaptions: ReviewedCaptionEntry[] = CAPTIONS.map((caption) => ({
    caption_id: caption.id,
    asset_id: "AST_001",
    segment_id: "SEG_001",
    timeline_in_frame: caption.startFrame,
    timeline_duration_frames: caption.durationFrames,
    text: caption.text,
    text_hash: computeCaptionTextHash(caption.text),
    transcript_ref: "TR_AST_001",
    transcript_item_ids: [`TRI_${caption.id}`],
    source: "transcript",
    styling_class: "sns-vertical-speaker-separated-outline",
    metrics: {
      cps: Math.round(
        [...caption.text].length /
        (caption.durationFrames / (30_000 / 1_001)) *
        100,
      ) / 100,
      dwell_ms: Math.round(
        caption.durationFrames * 1_001 * 1_000 / 30_000,
      ),
    },
    timing: {
      source: "word_remap",
      confidence: 0.9,
      sourceWordRefs: [{
        word: caption.text,
        start_us: caption.wordStartUs,
        end_us: caption.wordEndUs,
      }],
      triggeredFallback: false,
      timelineInFrame: caption.startFrame,
      timelineDurationFrames: caption.durationFrames,
    },
    ...(caption.reveal ? { reveal_timing: caption.reveal } : {}),
    review: {
      state: "verified",
      edited: false,
      source_text: caption.text,
    },
    issues: [],
    risk_score: 0,
  }));
  return {
    version: "caption-review-preview/v1",
    project_id: "caption-delivery-fixture",
    base_caption_draft_hash:
      "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    base_timeline_hash: "sha256:timeline",
    caption_policy: approval().caption_policy,
    speech_captions: speechCaptions,
    glossary_proposals: [],
    validation: {
      valid: true,
      blocking_issue_count: 0,
      warning_issue_count: 0,
      unreviewed_count: 0,
      verified_count: speechCaptions.length,
      edited_count: 0,
      flagged_count: 0,
    },
  };
}

describe("actionable caption sync and readability QA", () => {
  it("maps lead, lag, premature exit, and unreadable dwell to stable editor review items", () => {
    const inputTimeline = timeline();
    const inputApproval = approval();
    const inputPreview = reviewPreview();
    const before = structuredClone({
      timeline: inputTimeline,
      approval: inputApproval,
      preview: inputPreview,
    });
    const first = evaluateCaptionDeliveryQA({
      timeline: inputTimeline,
      brief: socialBrief(),
      approval: inputApproval,
      reviewPreview: inputPreview,
    });
    const second = evaluateCaptionDeliveryQA({
      timeline: structuredClone(inputTimeline),
      brief: socialBrief(),
      approval: structuredClone(inputApproval),
      reviewPreview: structuredClone(inputPreview),
    });

    expect({
      timeline: inputTimeline,
      approval: inputApproval,
      preview: inputPreview,
    }).toEqual(before);
    expect(first).toEqual(second);
    expect(first).toMatchObject({
      version: "caption-delivery-qa/v1",
      status: "review_required",
      mode: "aggressive",
      checked_caption_count: 5,
      evidence_caption_count: 5,
      incomplete_caption_count: 0,
      intentional_reveal_count: 1,
      thresholds: {
        ordinary_lead_frames: 2,
        max_lag_ms: 120,
        min_dwell_ms: 800,
        cps_limit: 16,
      },
    });
    expect(first.review_items.map((item) => item.code)).toEqual([
      "premature_caption_lead",
      "caption_lag",
      "caption_ends_before_speech",
      "insufficient_read_time",
    ]);
    expect(first.review_items).toEqual([
      expect.objectContaining({
        issue_id: expect.stringMatching(/^CAPTIONQA_[A-F0-9]{16}$/),
        caption_id: "SC_LEAD",
        timeline_start_frame: 20,
        timeline_end_frame: 28,
        start_timecode: "00:00:00.667",
        end_timecode: "00:00:00.934",
        measured_ms: 267,
        suggested_action: "delay_in",
      }),
      expect.objectContaining({
        caption_id: "SC_LAG",
        timeline_start_frame: 60,
        timeline_end_frame: 70,
        measured_ms: 334,
        suggested_action: "advance_in",
      }),
      expect.objectContaining({
        caption_id: "SC_EARLY_OUT",
        timeline_start_frame: 120,
        timeline_end_frame: 135,
        measured_ms: 501,
        suggested_action: "extend_out",
      }),
      expect.objectContaining({
        caption_id: "SC_FLASH",
        timeline_start_frame: 150,
        timeline_end_frame: 165,
        measured_ms: 501,
        threshold_ms: 800,
        suggested_action: "extend_read_time",
      }),
    ]);
    expect(first.review_items.some((item) =>
      item.caption_id === "SC_REVEAL"
    )).toBe(false);
  });

  it("fails closed when timing evidence is missing or does not match approval", () => {
    expect(evaluateCaptionDeliveryQA({
      timeline: timeline(),
      brief: socialBrief(),
      approval: approval(),
    })).toMatchObject({
      status: "incomplete",
      evidence_caption_count: 0,
      review_items: [],
      reason: expect.stringContaining("caption_review_preview"),
    });

    const mismatched = reviewPreview();
    mismatched.speech_captions[0].text = "別の字幕";
    expect(evaluateCaptionDeliveryQA({
      timeline: timeline(),
      brief: socialBrief(),
      approval: approval(),
      reviewPreview: mismatched,
    })).toMatchObject({
      status: "incomplete",
      incomplete_caption_count: 1,
      reason: expect.stringContaining("does not match"),
    });
  });

  it("skips non-social work without requiring caption timing evidence", () => {
    expect(evaluateCaptionDeliveryQA({
      timeline: timeline(),
      brief: {
        project: { format: "lecture", runtime_target_sec: 600 },
        editorial: { distribution_channel: "presentation" },
      },
      approval: approval(),
    })).toMatchObject({
      status: "not_applicable",
      mode: "off",
      review_items: [],
    });
  });

  it("is accepted by the package QA schema as a review-only metric", () => {
    const result = evaluateCaptionDeliveryQA({
      timeline: timeline(),
      brief: socialBrief(),
      approval: approval(),
      reviewPreview: reviewPreview(),
    });
    expect(validateAgainstSchema({
      version: "1.0.0",
      project_id: "caption-delivery-fixture",
      source_of_truth: "engine_render",
      qa_profile: "engine_render",
      passed: true,
      checks: [],
      metrics: { caption_delivery_qa: result },
      artifacts: {},
    }, "package-qa-report.schema.json")).toEqual({
      valid: true,
      errors: [],
    });
  });
});
