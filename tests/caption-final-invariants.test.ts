import { describe, expect, it } from "vitest";
import {
  finalizeCaptionDraftTiming,
  validateFinalCaptionInvariants,
} from "../runtime/caption/final-invariants.js";
import type { CaptionDraft, CaptionDraftEntry } from "../runtime/caption/editorial.js";

describe("final caption invariants", () => {
  it("runs separation after semantic splitting and persists recomputed metrics", () => {
    const draft = makeDraft([
      makeEntry("SC_1_SETUP", 0, 20, "問い"),
      makeEntry("SC_1", 20, 20, "答え"),
    ]);
    const result = finalizeCaptionDraftTiming(draft, 30, "ja");

    expect(result.draft.speech_captions[0]).toMatchObject({
      timeline_duration_frames: 19,
      metrics: { dwell_ms: 633, cps: 3.16 },
    });
    expect(result.issues.some((issue) => issue.severity === "block")).toBe(false);
  });

  it("blocks a semantic split that leaves a cue below 300ms", () => {
    const result = finalizeCaptionDraftTiming(makeDraft([
      makeEntry("SC_1_SETUP", 0, 30, "前提"),
      makeEntry("SC_1", 9, 30, "結論"),
    ]), 30, "ja");

    expect(result.draft.speech_captions[0].timeline_duration_frames).toBe(8);
    expect(result.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: "below_hard_dwell_floor",
        severity: "block",
        caption_id: "SC_1_SETUP",
      }),
    ]));
  });

  it("keeps 300-800ms impact cues advisory", () => {
    const result = finalizeCaptionDraftTiming(
      makeDraft([makeEntry("SC_1", 0, 15, "危機")]),
      30,
      "ja",
    );
    expect(result.issues).toEqual([
      expect.objectContaining({
        code: "below_target_dwell",
        severity: "advisory",
      }),
    ]);
  });

  it("blocks unresolved and one-frame-early protected reveals", () => {
    const unresolved = makeEntry("SC_1", 0, 30, "結論");
    unresolved.reveal_timing = {
      anchor_id: "A1",
      role: "payoff",
      anchor_text: "結論",
      status: "unresolved",
      source: "unresolved",
      audio_first_frames: 1,
      original_timeline_in_frame: 0,
    };
    const early = makeEntry("SC_2", 30, 30, "価値");
    early.reveal_timing = {
      anchor_id: "A2",
      role: "payoff",
      anchor_text: "価値",
      status: "protected",
      source: "word_timing",
      anchor_frame: 30,
      audio_first_frames: 1,
      original_timeline_in_frame: 30,
    };

    const issues = validateFinalCaptionInvariants(
      [unresolved, early],
      30,
      "ja",
    );
    expect(issues.map((issue) => issue.code)).toEqual(expect.arrayContaining([
      "unresolved_reveal_anchor",
      "premature_protected_reveal",
    ]));
  });

  it("blocks stale persisted metrics", () => {
    const entry = makeEntry("SC_1", 0, 30, "価値");
    entry.metrics = { dwell_ms: 500, cps: 99 };
    expect(validateFinalCaptionInvariants([entry], 30, "ja")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "stale_metrics", severity: "block" }),
      ]),
    );
  });
});

function makeDraft(entries: CaptionDraftEntry[]): CaptionDraft {
  return {
    version: "1.0",
    project_id: "P_TEST",
    base_timeline_version: "1",
    caption_policy: {
      language: "ja",
      delivery_mode: "burn_in",
      source: "transcript",
      styling_class: "social-short",
    },
    speech_captions: entries,
    text_overlays: [],
    draft_status: "ready_for_human_approval",
    degraded_count: 0,
  };
}

function makeEntry(
  captionId: string,
  start: number,
  duration: number,
  text: string,
): CaptionDraftEntry {
  return {
    caption_id: captionId,
    asset_id: "AST_1",
    segment_id: "SEG_1",
    timeline_in_frame: start,
    timeline_duration_frames: duration,
    text,
    transcript_ref: "TR_1",
    transcript_item_ids: ["ITEM_1"],
    source: "transcript",
    styling_class: "social-short",
    metrics: {
      dwell_ms: Math.round(duration / 30 * 1000),
      cps: Math.round(text.length / (duration / 30) * 100) / 100,
    },
  };
}
