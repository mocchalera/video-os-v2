import { describe, expect, it } from "vitest";
import { validateAgainstSchema } from "../runtime/commands/shared.js";
import { migrateCaptionDraft, type CaptionDraft, type CaptionDraftEntry } from "../runtime/caption/editorial.js";
import {
  applyCaptionReviewPatch,
  buildCaptionReviewQueue,
  computeCaptionDraftHash,
  computeCaptionTextHash,
  assessSafeBulkReview,
  buildCaptionApprovalReadiness,
  type CaptionReviewPatch,
} from "../runtime/caption/review-core.js";

describe("caption review core", () => {
  it("blocks Japanese stem/okurigana breaks and ranks them first", () => {
    const draft = makeDraft([
      makeCaption("SC_0001", "まだまだ話したいことは聞きた\nいことがあるんですけど", 0, 80),
      makeCaption("SC_0002", "ありがとうございました", 80, 48),
    ]);

    const queue = buildCaptionReviewQueue(draft, { fps: 24 });

    expect(queue[0].caption_id).toBe("SC_0001");
    expect(queue[0].issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "unnatural_line_break", severity: "block" }),
    ]));
  });

  it("blocks line breaks inside protected glossary terms", () => {
    const draft = makeDraft([
      makeCaption("SC_0001", "精神科医To\nmyと語る", 0, 72),
    ]);

    const queue = buildCaptionReviewQueue(draft, {
      fps: 24,
      protectedTerms: ["精神科医Tomy", "Tomy"],
    });

    expect(queue[0].issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "protected_term_split", severity: "block" }),
    ]));
  });

  it("warns without blocking when a caption line exceeds the character guide", () => {
    const draft = makeDraft([
      makeCaption("SC_0001", "これは一行二十文字を超えても人が承認できる字幕テキストです", 0, 120),
    ]);

    const queue = buildCaptionReviewQueue(draft, { fps: 24 });

    expect(queue[0].issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "line_too_long", severity: "warn" }),
    ]));
    expect(queue[0].issues).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "line_too_long", severity: "block" }),
    ]));
  });

  it("rejects a stale draft hash without producing a preview", () => {
    const draft = makeDraft([makeCaption("SC_0001", "字幕です", 0, 48)]);
    const patch = makePatch(draft, [], {
      base_caption_draft_hash: `sha256:${"0".repeat(64)}`,
    });

    const result = applyCaptionReviewPatch(draft, patch, "timeline-hash");

    expect(result.success).toBe(false);
    if (!result.success) expect(result.errors.join(" ")).toContain("stale");
  });

  it("applies text, line break, split, merge, timing, review, and glossary operations deterministically", () => {
    const draft = makeDraft([
      makeCaption("SC_0001", "静止解富井と語る", 0, 48),
      makeCaption("SC_0002", "自分を取り戻すヒント精神科医Tomyと語る", 48, 72),
      makeCaption("SC_0003", "前半です後半です", 120, 48),
      makeCaption("SC_0004", "ありがとうございました", 168, 48),
    ]);
    const patch = makePatch(draft, [
      {
        op: "replace_text",
        caption_id: "SC_0001",
        base_text_hash: computeCaptionTextHash("静止解富井と語る"),
        text: "精神科医Tomyと語る",
        category: "proper_noun",
      },
      {
        op: "set_review_state",
        caption_id: "SC_0001",
        state: "verified",
      },
      {
        op: "set_line_break",
        caption_id: "SC_0002",
        base_text_hash: computeCaptionTextHash("自分を取り戻すヒント精神科医Tomyと語る"),
        lines: ["自分を取り戻すヒント", "精神科医Tomyと語る"],
      },
      {
        op: "split_caption",
        caption_id: "SC_0003",
        base_text_hash: computeCaptionTextHash("前半です後半です"),
        parts: [
          { caption_id: "SC_0003_A", text: "前半です", start_frame: 120, end_frame: 144 },
          { caption_id: "SC_0003_B", text: "後半です", start_frame: 144, end_frame: 168 },
        ],
      },
      {
        op: "merge_captions",
        caption_ids: ["SC_0003_A", "SC_0003_B"],
        base_text_hashes: [computeCaptionTextHash("前半です"), computeCaptionTextHash("後半です")],
        result: {
          caption_id: "SC_0003_M",
          text: "前半です、後半です",
          start_frame: 120,
          end_frame: 168,
        },
      },
      {
        op: "adjust_timing",
        caption_id: "SC_0003_M",
        start_frame: 121,
        end_frame: 167,
      },
      {
        op: "set_review_state",
        caption_id: "SC_0003_M",
        state: "verified",
      },
      {
        op: "propose_glossary_term",
        canonical: "精神科医Tomy",
        variants: ["静止解富井", "静止解富井"],
        source_caption_ids: ["SC_0001"],
      },
    ]);

    const result = applyCaptionReviewPatch(draft, patch, "timeline-hash", {
      fps: 24,
      protectedTerms: ["精神科医Tomy", "Tomy"],
    });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.diffs).toHaveLength(8);
    expect(result.preview.speech_captions.map((entry) => entry.caption_id)).toEqual([
      "SC_0001",
      "SC_0002",
      "SC_0003_M",
      "SC_0004",
    ]);
    expect(result.preview.speech_captions[0]).toMatchObject({
      text: "精神科医Tomyと語る",
      review: { state: "verified", edited: true },
    });
    expect(result.preview.speech_captions[1].text).toBe("自分を取り戻すヒント\n精神科医Tomyと語る");
    expect(result.preview.speech_captions[2]).toMatchObject({
      timeline_in_frame: 121,
      timeline_duration_frames: 46,
      review: { state: "verified", edited: true },
    });
    expect(result.preview.speech_captions[2].parent_ids).toEqual(["SC_0003_A", "SC_0003_B"]);
    expect(result.preview.glossary_proposals).toEqual([{
      canonical: "精神科医Tomy",
      variants: ["静止解富井"],
      source_caption_ids: ["SC_0001"],
    }]);
  });

  it("partitions word references when a reviewed caption is split", () => {
    const source = makeCaption("SC_0001", "どう思いますか答えです", 0, 72);
    source.timing = {
      source: "word_remap",
      confidence: 0.9,
      sourceWordRefs: [
        { word: "どう", start_us: 0, end_us: 100_000 },
        { word: "思います", start_us: 100_000, end_us: 300_000 },
        { word: "か", start_us: 300_000, end_us: 400_000 },
        { word: "答え", start_us: 500_000, end_us: 700_000 },
        { word: "です", start_us: 700_000, end_us: 800_000 },
      ],
      triggeredFallback: false,
      timelineInFrame: 0,
      timelineDurationFrames: 72,
    };
    const draft = makeDraft([source]);
    const patch = makePatch(draft, [{
      op: "split_caption",
      caption_id: "SC_0001",
      base_text_hash: computeCaptionTextHash(source.text),
      parts: [
        { caption_id: "SC_0001_A", text: "どう思いますか", start_frame: 0, end_frame: 36 },
        { caption_id: "SC_0001_B", text: "答えです", start_frame: 36, end_frame: 72 },
      ],
    }]);

    const result = applyCaptionReviewPatch(draft, patch, "timeline-hash");
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.preview.speech_captions[0].timing?.sourceWordRefs?.map((word) => word.word)).toEqual([
      "どう", "思います", "か",
    ]);
    expect(result.preview.speech_captions[1].timing?.sourceWordRefs?.map((word) => word.word)).toEqual([
      "答え", "です",
    ]);
    expect(result.preview.speech_captions[1].timing).toMatchObject({
      timelineInFrame: 36,
      timelineDurationFrames: 36,
    });
    expect(result.preview.speech_captions[0]).toMatchObject({
      root_id: "SC_0001",
      parent_ids: ["SC_0001"],
      lineage_hash: expect.stringMatching(/^sha256:/),
    });
  });

  it("migrates v1 drafts deterministically without changing timing or text", () => {
    const draft = makeDraft([makeCaption("SC_0001", "字幕です", 10, 20)]);
    const migrated = migrateCaptionDraft(draft);
    expect(migrated.speech_captions[0]).toMatchObject({
      caption_id: "SC_0001",
      timeline_in_frame: 10,
      timeline_duration_frames: 20,
      root_id: "SC_0001",
      parent_ids: [],
      lineage_hash: expect.stringMatching(/^sha256:/),
    });
    expect(migrated.migration).toEqual({
      from_version: draft.version,
      to_version: "caption-draft/v2",
      migrated_caption_count: 1,
    });
  });

  it("combines word references when reviewed captions are merged", () => {
    const first = makeCaption("SC_0001", "問いかけ", 0, 36);
    const second = makeCaption("SC_0002", "答え", 36, 36);
    first.timing = {
      source: "word_remap",
      confidence: 0.9,
      sourceWordRefs: [{ word: "問いかけ", start_us: 0, end_us: 400_000 }],
      triggeredFallback: false,
      timelineInFrame: 0,
      timelineDurationFrames: 36,
    };
    second.timing = {
      source: "word_remap",
      confidence: 0.8,
      sourceWordRefs: [{ word: "答え", start_us: 500_000, end_us: 800_000 }],
      triggeredFallback: false,
      timelineInFrame: 36,
      timelineDurationFrames: 36,
    };
    const draft = makeDraft([first, second]);
    const patch = makePatch(draft, [{
      op: "merge_captions",
      caption_ids: ["SC_0001", "SC_0002"],
      base_text_hashes: [computeCaptionTextHash(first.text), computeCaptionTextHash(second.text)],
      result: {
        caption_id: "SC_0001",
        text: "問いかけと答え",
        start_frame: 0,
        end_frame: 72,
      },
    }]);

    const result = applyCaptionReviewPatch(draft, patch, "timeline-hash");
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.preview.speech_captions[0].timing).toMatchObject({
      confidence: 0.8,
      timelineInFrame: 0,
      timelineDurationFrames: 72,
    });
    expect(result.preview.speech_captions[0].timing?.sourceWordRefs?.map((word) => word.word)).toEqual([
      "問いかけ", "答え",
    ]);
  });

  it("produces schema-valid patch and review preview documents", () => {
    const draft = makeDraft([makeCaption("SC_0001", "字幕です", 0, 48)]);
    const patch = makePatch(draft, [{
      op: "set_review_state",
      caption_id: "SC_0001",
      state: "verified",
    }]);

    expect(validateAgainstSchema(patch, "caption-review-patch.schema.json")).toEqual({
      valid: true,
      errors: [],
    });

    const result = applyCaptionReviewPatch(draft, patch, "timeline-hash");
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(validateAgainstSchema(result.preview, "caption-review-preview.schema.json")).toEqual({
      valid: true,
      errors: [],
    });
    expect(result.preview.validation).toMatchObject({
      valid: true,
      verified_count: 1,
      unreviewed_count: 0,
    });
  });

  it("surfaces timing fallback and low confidence in the risk queue", () => {
    const caption = makeCaption("SC_0001", "字幕です", 0, 48);
    caption.timing = {
      source: "clip_item_remap",
      confidence: 0.5,
      triggeredFallback: true,
      timelineInFrame: 0,
      timelineDurationFrames: 48,
    };
    const queue = buildCaptionReviewQueue(makeDraft([caption]));

    expect(queue[0].issues.map((issue) => issue.code)).toEqual(expect.arrayContaining([
      "timing_fallback",
      "low_timing_confidence",
    ]));
  });

  it("excludes risky captions from safe bulk review and reports every reason", () => {
    const draft = makeDraft([
      makeCaption("SC_0001", "よろしくお願いします", 0, 48),
      makeCaption("SC_0002", "Tomyは42回参加しました", 48, 48),
      makeCaption("SC_0003", "参加しないでください", 96, 48),
    ]);
    const queue = buildCaptionReviewQueue(draft, { protectedTerms: ["Tomy"] });

    const assessment = assessSafeBulkReview(queue, { protectedTerms: ["Tomy"] });

    expect(assessment.eligible_caption_ids).toEqual(["SC_0001"]);
    expect(assessment.excluded).toEqual(expect.arrayContaining([
      expect.objectContaining({ caption_id: "SC_0002", reasons: expect.arrayContaining(["proper_noun", "numeric"]) }),
      expect.objectContaining({ caption_id: "SC_0003", reasons: ["negation"] }),
    ]));
  });

  it("uses one readiness oracle and permits acknowledged warnings", () => {
    const validation = {
      valid: true,
      blocking_issue_count: 0,
      warning_issue_count: 1,
      unreviewed_count: 0,
      verified_count: 1,
      edited_count: 0,
      flagged_count: 0,
    };
    const ready = buildCaptionApprovalReadiness({
      reviewer: "editor",
      validation,
      stale: false,
      fontReady: true,
    });
    expect(ready).toMatchObject({ can_approve: true, blockers: [], warnings_acknowledged: true });

    const blocked = buildCaptionApprovalReadiness({
      reviewer: "",
      validation: { ...validation, valid: false, unreviewed_count: 1, flagged_count: 1, blocking_issue_count: 1 },
      stale: true,
      fontReady: false,
    });
    expect(blocked.can_approve).toBe(false);
    expect(blocked.blockers.map((entry) => entry.code)).toEqual([
      "reviewer_required", "unreviewed_captions", "flagged_captions",
      "blocking_issues", "stale_review", "font_contract_mismatch",
    ]);
  });
});

function makeDraft(speechCaptions: CaptionDraftEntry[]): CaptionDraft {
  return {
    version: "1.0",
    project_id: "caption-review-test",
    base_timeline_version: "timeline-v1",
    caption_policy: {
      language: "ja",
      delivery_mode: "burn_in",
      source: "transcript",
      styling_class: "longform-event",
    },
    speech_captions: speechCaptions,
    text_overlays: [],
    draft_status: "ready_for_human_approval",
    degraded_count: 0,
  };
}

function makeCaption(
  captionId: string,
  text: string,
  timelineInFrame: number,
  durationFrames: number,
): CaptionDraftEntry {
  return {
    caption_id: captionId,
    asset_id: "AST_001",
    segment_id: "SEG_001",
    timeline_in_frame: timelineInFrame,
    timeline_duration_frames: durationFrames,
    text,
    transcript_ref: "TR_AST_001",
    transcript_item_ids: [`TRI_${captionId}`],
    source: "transcript",
    styling_class: "longform-event",
    metrics: { cps: 1, dwell_ms: 1000 },
    editorial: {
      sourceText: text,
      operations: [],
      glossaryHits: [],
      confidence: 1,
      status: "clean",
    },
  };
}

function makePatch(
  draft: CaptionDraft,
  operations: CaptionReviewPatch["operations"],
  overrides: Partial<CaptionReviewPatch> = {},
): CaptionReviewPatch {
  return {
    version: "caption-review-patch/v1",
    project_id: draft.project_id,
    base_caption_draft_hash: computeCaptionDraftHash(draft),
    base_timeline_hash: "timeline-hash",
    operations,
    session: {
      reviewer: "operator",
      started_at: "2026-07-14T00:00:00.000Z",
      updated_at: "2026-07-14T00:01:00.000Z",
    },
    ...overrides,
  };
}
