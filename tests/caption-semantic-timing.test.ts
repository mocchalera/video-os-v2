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
      timeline_duration_frames: 48,
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
});
