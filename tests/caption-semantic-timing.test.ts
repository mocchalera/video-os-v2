import { describe, expect, it } from "vitest";
import type { CaptionDraft, CaptionDraftEntry } from "../runtime/caption/editorial.js";
import { buildCaptionReviewQueue } from "../runtime/caption/review-core.js";
import { validateAgainstSchema } from "../runtime/commands/shared.js";
import {
  applyCaptionSemanticTiming,
  type RevealClipContext,
  type RevealTranscriptItem,
} from "../runtime/caption/semantic-timing.js";

const fps = 24;

function caption(overrides: Partial<CaptionDraftEntry> = {}): CaptionDraftEntry {
  return {
    caption_id: "SC_0001",
    asset_id: "AST_1",
    segment_id: "SEG_1",
    timeline_in_frame: 0,
    timeline_duration_frames: 100,
    text: "AI｜わかった。いくよ！",
    transcript_ref: "TR_1",
    transcript_item_ids: ["TRI_1"],
    source: "transcript",
    styling_class: "social-outline",
    metrics: { cps: 4, dwell_ms: 4167 },
    ...overrides,
  };
}

const clip: RevealClipContext = {
  segment_id: "SEG_1",
  asset_id: "AST_1",
  src_in_us: 0,
  src_out_us: 5_000_000,
  timeline_in_frame: 0,
  timeline_duration_frames: 120,
};

function items(item: RevealTranscriptItem): Map<string, RevealTranscriptItem> {
  return new Map([[item.item_id, item]]);
}

describe("semantic caption timing", () => {
  it("splits setup from a protected word and lets audio arrive first", () => {
    const result = applyCaptionSemanticTiming({
      captions: [caption()],
      policy: {
        mode: "protect_reveals",
        ordinary_lead_frames: 2,
        audio_first_frames: 1,
        anchors: [{
          anchor_id: "reveal_go",
          role: "punchline",
          anchor_text: "いくよ",
          transcript_item_id: "TRI_1",
        }],
      },
      transcriptItems: items({
        item_id: "TRI_1",
        start_us: 0,
        end_us: 4_000_000,
        text: "わかった。いくよ！",
        word_timing_mode: "word",
        words: [
          { word: "わかった", start_us: 0, end_us: 1_000_000 },
          { word: "いくよ", start_us: 2_000_000, end_us: 2_600_000 },
        ],
      }),
      clips: [clip],
      fps,
    });

    expect(result.captions).toHaveLength(2);
    expect(result.captions[0]).toMatchObject({
      caption_id: "SC_0001_SETUP",
      text: "AI｜わかった。",
      timeline_in_frame: 0,
      timeline_duration_frames: 49,
      reveal_timing: { status: "setup_only", anchor_frame: 48 },
    });
    expect(result.captions[1]).toMatchObject({
      caption_id: "SC_0001",
      text: "AI｜いくよ！",
      timeline_in_frame: 49,
      timeline_duration_frames: 51,
      reveal_timing: { status: "protected", source: "word_timing", audio_first_frames: 1 },
    });
    expect(result.report).toMatchObject({ protected_caption_count: 1, split_count: 1, unresolved_count: 0 });
  });

  it("leaves ordinary captions and mode=off work unchanged", () => {
    const original = caption({ timeline_in_frame: 10 });
    const originalCaptions = [original];
    const result = applyCaptionSemanticTiming({
      captions: originalCaptions,
      policy: { mode: "off" },
      transcriptItems: new Map(),
      clips: [clip],
      fps,
    });

    expect(result.captions).toBe(originalCaptions);
    expect(result.captions).toEqual([original]);
    expect(result.report).toMatchObject({ mode: "off", adjusted_lead_count: 0, protected_caption_count: 0 });
  });

  it("does not guess an in-item reveal and blocks caption review", () => {
    const result = applyCaptionSemanticTiming({
      captions: [caption()],
      policy: {
        mode: "protect_reveals",
        anchors: [{
          anchor_id: "reveal_go",
          role: "punchline",
          anchor_text: "いくよ",
          transcript_item_id: "TRI_1",
        }],
      },
      transcriptItems: items({
        item_id: "TRI_1",
        start_us: 0,
        end_us: 4_000_000,
        text: "わかった。いくよ！",
        word_timing_mode: "none",
      }),
      clips: [clip],
      fps,
    });

    expect(result.report.unresolved_count).toBe(1);
    expect(result.captions[0].reveal_timing).toMatchObject({ status: "unresolved", source: "unresolved" });

    const draft: CaptionDraft = {
      version: "1",
      project_id: "reveal-test",
      base_timeline_version: "1",
      caption_policy: {
        language: "ja",
        delivery_mode: "burn_in",
        source: "transcript",
        styling_class: "social-outline",
        semantic_timing: { mode: "protect_reveals" },
      },
      speech_captions: result.captions,
      text_overlays: [],
      draft_status: "needs_operator_fix",
      degraded_count: 0,
    };
    expect(buildCaptionReviewQueue(draft)[0].issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "unresolved_reveal_anchor", severity: "block" }),
    ]));
  });

  it("speech_sync detects and clamps the 99-frame early-caption failure pattern without reveal anchors", () => {
    const result = applyCaptionSemanticTiming({
      captions: [caption({
        caption_id: "SC_0011",
        timeline_in_frame: 1008,
        timeline_duration_frames: 215,
        text: "画面｜本気で限界突破して",
        transcript_item_ids: ["TRI_BEATBOX"],
      })],
      policy: { mode: "speech_sync", ordinary_lead_frames: 2 },
      transcriptItems: items({
        item_id: "TRI_BEATBOX",
        start_us: 46_125_000,
        end_us: 51_125_000,
        text: "本気でやっても限界突破して",
      }),
      clips: [{ ...clip, src_in_us: 0, src_out_us: 60_000_000, timeline_in_frame: 0, timeline_duration_frames: 1440 }],
      fps,
    });

    expect(result.report.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "premature_caption_lead", caption_id: "SC_0011", lead_frames: 99 }),
    ]));
    expect(result.captions[0].timeline_in_frame).toBe(1105);
    expect(validateAgainstSchema(result.report, "caption-timing-report.schema.json")).toEqual({
      valid: true,
      errors: [],
    });
  });

  it("keeps a pause on the previous caption and reveals a question at audio onset", () => {
    const result = applyCaptionSemanticTiming({
      captions: [
        caption({
          caption_id: "SC_0001",
          timeline_in_frame: 0,
          timeline_duration_frames: 20,
          text: "前の発言です",
          transcript_item_ids: ["TRI_1"],
          timing: {
            source: "word_remap",
            confidence: 0.95,
            sourceWordRefs: [{ word: "前の発言です", start_us: 0, end_us: 1_000_000 }],
            triggeredFallback: false,
            timelineInFrame: 0,
            timelineDurationFrames: 24,
          },
        }),
        caption({
          caption_id: "SC_0002",
          timeline_in_frame: 18,
          timeline_duration_frames: 30,
          text: "どう思います？",
          transcript_item_ids: ["TRI_2"],
          timing: {
            source: "word_remap",
            confidence: 0.95,
            sourceWordRefs: [{ word: "どう思います", start_us: 1_250_000, end_us: 2_000_000 }],
            triggeredFallback: false,
            timelineInFrame: 30,
            timelineDurationFrames: 18,
          },
        }),
      ],
      policy: {
        mode: "speech_sync",
        ordinary_lead_frames: 2,
        question_audio_first_frames: 0,
        gap_ownership: "previous",
      },
      transcriptItems: new Map([
        ["TRI_1", { item_id: "TRI_1", start_us: 0, end_us: 1_000_000, text: "前の発言です" }],
        ["TRI_2", { item_id: "TRI_2", start_us: 1_250_000, end_us: 2_000_000, text: "どう思います？" }],
      ]),
      clips: [clip],
      fps,
    });

    expect(result.captions[0]).toMatchObject({
      caption_id: "SC_0001",
      timeline_in_frame: 0,
      timeline_duration_frames: 30,
    });
    expect(result.captions[1]).toMatchObject({
      caption_id: "SC_0002",
      timeline_in_frame: 30,
      timeline_duration_frames: 18,
    });
    expect(result.report).toMatchObject({
      question_caption_count: 1,
      question_adjusted_count: 1,
      previous_speech_guard_count: 1,
      gap_tail_hold_count: 1,
    });
    expect(result.report.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "question_caption_lead", caption_id: "SC_0002" }),
      expect.objectContaining({ code: "previous_speech_overlap", caption_id: "SC_0002" }),
    ]));
    expect(validateAgainstSchema(result.report, "caption-timing-report.schema.json")).toEqual({
      valid: true,
      errors: [],
    });
  });

  it("still permits a two-frame lead for ordinary text when prior speech has ended", () => {
    const result = applyCaptionSemanticTiming({
      captions: [caption({
        caption_id: "SC_0002",
        timeline_in_frame: 20,
        timeline_duration_frames: 30,
        text: "通常の次字幕",
        transcript_item_ids: ["TRI_2"],
      })],
      policy: { mode: "speech_sync", ordinary_lead_frames: 2, gap_ownership: "previous" },
      transcriptItems: items({
        item_id: "TRI_2",
        start_us: 916_667,
        end_us: 2_000_000,
        text: "通常の次字幕",
      }),
      clips: [clip],
      fps,
    });

    expect(result.captions[0].timeline_in_frame).toBe(20);
    expect(result.report.adjusted_lead_count).toBe(0);
  });

  it("does not spend an actual pause on ordinary-text reading lead", () => {
    const result = applyCaptionSemanticTiming({
      captions: [
        caption({
          caption_id: "SC_0001",
          timeline_in_frame: 0,
          timeline_duration_frames: 24,
          text: "前の発言",
          transcript_item_ids: ["TRI_1"],
        }),
        caption({
          caption_id: "SC_0002",
          timeline_in_frame: 34,
          timeline_duration_frames: 26,
          text: "通常の次字幕",
          transcript_item_ids: ["TRI_2"],
        }),
      ],
      policy: { mode: "speech_sync", ordinary_lead_frames: 2, gap_ownership: "previous" },
      transcriptItems: new Map([
        ["TRI_1", { item_id: "TRI_1", start_us: 0, end_us: 1_000_000, text: "前の発言" }],
        ["TRI_2", { item_id: "TRI_2", start_us: 1_500_000, end_us: 2_500_000, text: "通常の次字幕" }],
      ]),
      clips: [clip],
      fps,
    });

    expect(result.captions[0]).toMatchObject({
      caption_id: "SC_0001",
      timeline_in_frame: 0,
      timeline_duration_frames: 36,
    });
    expect(result.captions[1]).toMatchObject({
      caption_id: "SC_0002",
      timeline_in_frame: 36,
    });
    expect(result.report).toMatchObject({
      adjusted_lead_count: 1,
      gap_tail_hold_count: 1,
    });
    expect(result.report.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: "premature_caption_lead",
        caption_id: "SC_0002",
        message: expect.stringContaining("clamped to 0-frame reading lead"),
      }),
    ]));
  });

  it("uses transcript onset before a clip-remap fallback range", () => {
    const result = applyCaptionSemanticTiming({
      captions: [caption({
        caption_id: "SC_0002",
        timeline_in_frame: 34,
        timeline_duration_frames: 26,
        text: "フォールバックですか？",
        transcript_item_ids: ["TRI_2"],
        timing: {
          source: "clip_item_remap",
          confidence: 0.4,
          triggeredFallback: true,
          timelineInFrame: 34,
          timelineDurationFrames: 26,
        },
      })],
      policy: { mode: "speech_sync", ordinary_lead_frames: 2, gap_ownership: "previous" },
      transcriptItems: items({
        item_id: "TRI_2",
        start_us: 1_500_000,
        end_us: 2_500_000,
        text: "フォールバックですか？",
      }),
      clips: [clip],
      fps,
    });

    expect(result.captions[0]).toMatchObject({
      timeline_in_frame: 36,
      timeline_duration_frames: 24,
    });
    expect(result.report.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: "question_caption_lead",
        caption_id: "SC_0002",
        message: expect.stringContaining("aligned to question onset"),
      }),
    ]));
  });
});
