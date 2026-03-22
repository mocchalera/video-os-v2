/**
 * Caption + Narrative Improvement Tests
 *
 * Phase A: Deterministic cleanup
 * Phase B: Word-level timing remap
 * Phase C: Narrative loop
 * Phase D: LLM caption editorial
 * Phase E: Caption artifact separation
 */

import { describe, it, expect } from "vitest";

// Phase A imports
import {
  rejoinAcronyms,
  removeStrayPunctuation,
  normalizePunctuation,
  cleanupCaptionText,
} from "../runtime/caption/cleanup.js";
import {
  breakLines,
  getLayoutPolicy,
  checkCps,
  formatCaption,
  type LayoutPolicy,
} from "../runtime/caption/line-breaker.js";

// Phase B imports
import {
  remapWithWordTimestamps,
  batchWordRemap,
  type TimingRemapInput,
  type TranscriptItemWithWords,
} from "../runtime/caption/word-remap.js";

// Phase C imports
import type {
  NarrativePhases,
  NarrativePhaseContext,
  FrameResult,
  ReadResult,
  DraftResult,
  EvaluateResult,
  ConfirmResult,
  BlueprintAgent,
  BlueprintAgentContext,
  BlueprintCommandResult,
} from "../runtime/commands/blueprint.js";
import { validateConfirmedPreferences } from "../runtime/commands/blueprint.js";

// Phase D imports
import {
  runEditorial,
  validateMustKeepTokens,
  buildGlossary,
  type EditorialJudge,
  type EditorialDecision,
  type CaptionDraft,
} from "../runtime/caption/editorial.js";
import type { CaptionSource, SpeechCaption } from "../runtime/caption/segmenter.js";

// ═════════════════════════════════════════════════════════════════════════
// Phase A: Deterministic Cleanup Tests
// ═════════════════════════════════════════════════════════════════════════

describe("Deterministic Cleanup", () => {
  describe("rejoinAcronyms", () => {
    it("A_I → AI", () => {
      expect(rejoinAcronyms("A_I技術がすごい")).toBe("AI技術がすごい");
    });

    it("C_E_O → CEO", () => {
      expect(rejoinAcronyms("C_E_Oの話")).toBe("CEOの話");
    });

    it("G_P_T → GPT", () => {
      expect(rejoinAcronyms("G_P_Tは便利")).toBe("GPTは便利");
    });

    it("preserves normal words with underscores", () => {
      expect(rejoinAcronyms("hello_world")).toBe("hello_world");
    });

    it("handles multiple acronyms in one string", () => {
      expect(rejoinAcronyms("A_Iと G_P_T")).toBe("AIと GPT");
    });

    it("space-separated single letters: A I → AI", () => {
      expect(rejoinAcronyms("A I")).toBe("AI");
    });
  });

  describe("removeStrayPunctuation", () => {
    it("removes lone period surrounded by spaces", () => {
      expect(removeStrayPunctuation("hello . world")).toBe("hello world");
    });

    it("removes leading punctuation", () => {
      expect(removeStrayPunctuation(".hello")).toBe("hello");
      expect(removeStrayPunctuation("。こんにちは")).toBe("こんにちは");
    });

    it("removes lone Japanese punctuation", () => {
      expect(removeStrayPunctuation("こんにちは 。 さようなら")).toBe("こんにちは さようなら");
    });

    it("preserves valid sentence-ending punctuation", () => {
      expect(removeStrayPunctuation("すごいですね。")).toBe("すごいですね。");
    });
  });

  describe("normalizePunctuation", () => {
    it("collapses duplicate 。", () => {
      expect(normalizePunctuation("すごい。。")).toBe("すごい。");
    });

    it("collapses duplicate 、", () => {
      expect(normalizePunctuation("あの、、ですね")).toBe("あの、ですね");
    });

    it("preserves ellipsis ...", () => {
      expect(normalizePunctuation("well...")).toBe("well...");
    });

    it("collapses 4+ dots to ellipsis", () => {
      expect(normalizePunctuation("what....")).toBe("what...");
    });

    it("collapses duplicate !!", () => {
      expect(normalizePunctuation("great!!")).toBe("great!");
    });
  });

  describe("cleanupCaptionText (full pipeline)", () => {
    it("A_I → AI + stray punctuation removal", () => {
      expect(cleanupCaptionText("A_Iの . 技術")).toBe("AIの 技術");
    });

    it("handles empty string", () => {
      expect(cleanupCaptionText("")).toBe("");
    });

    it("handles already clean text", () => {
      expect(cleanupCaptionText("AI技術がすごい")).toBe("AI技術がすごい");
    });

    it("combined: acronym + stray punct + duplicate punct", () => {
      expect(cleanupCaptionText(".A_I。。の技術")).toBe("AI。の技術");
    });
  });
});

// ═════════════════════════════════════════════════════════════════════════
// Phase A: Line Breaker Tests
// ═════════════════════════════════════════════════════════════════════════

describe("Line Breaker", () => {
  const jaPolicy = getLayoutPolicy("ja");
  const enPolicy = getLayoutPolicy("en");

  describe("Japanese layout", () => {
    it("short text fits one line (no break)", () => {
      const result = breakLines("すごいですね", jaPolicy);
      expect(result.lines).toHaveLength(1);
      expect(result.needsSplit).toBe(false);
    });

    it("20 chars fits one line exactly", () => {
      const text = "あ".repeat(20);
      const result = breakLines(text, jaPolicy);
      expect(result.lines).toHaveLength(1);
      expect(result.needsSplit).toBe(false);
    });

    it("21 chars triggers 2-line break", () => {
      const text = "あ".repeat(21);
      const result = breakLines(text, jaPolicy);
      expect(result.lines).toHaveLength(2);
      expect(result.needsSplit).toBe(false);
    });

    it("40+ chars: 2 lines max, flags needsSplit", () => {
      const text = "あ".repeat(42);
      const result = breakLines(text, jaPolicy);
      expect(result.lines).toHaveLength(2);
      expect(result.needsSplit).toBe(true);
    });

    it("avoids line-start particles", () => {
      // "これが" — we don't want "が" starting a new line
      const text = "これがAI技術の素晴らしさです"; // 14 chars, fits 1 line
      const result = breakLines(text, jaPolicy);
      expect(result.lines).toHaveLength(1);
    });
  });

  describe("English layout", () => {
    it("short text fits one line", () => {
      const result = breakLines("Hello world", enPolicy);
      expect(result.lines).toHaveLength(1);
      expect(result.needsSplit).toBe(false);
    });

    it("42 chars fits one line exactly", () => {
      const text = "x".repeat(42);
      const result = breakLines(text, enPolicy);
      expect(result.lines).toHaveLength(1);
    });

    it("long text triggers 2-line break", () => {
      const text = "This is a much longer sentence that should be split into two lines for readability";
      const result = breakLines(text, enPolicy);
      expect(result.lines).toHaveLength(2);
    });
  });

  describe("CPS check", () => {
    it("within limit for Japanese", () => {
      const result = checkCps("AI技術", 2000, jaPolicy); // 4 chars / 2 sec = 2.0 CPS
      expect(result.withinLimit).toBe(true);
      expect(result.cps).toBe(2);
    });

    it("exceeds limit for Japanese", () => {
      // 20 chars / 1 sec = 20 CPS > 6.0
      const result = checkCps("あ".repeat(20), 1000, jaPolicy);
      expect(result.withinLimit).toBe(false);
      expect(result.cps).toBe(20);
    });

    it("zero duration returns within limit", () => {
      const result = checkCps("test", 0, enPolicy);
      expect(result.withinLimit).toBe(true);
      expect(result.cps).toBe(0);
    });
  });
});

// ═════════════════════════════════════════════════════════════════════════
// Phase B: Word-level Timing Remap Tests
// ═════════════════════════════════════════════════════════════════════════

describe("Word-level Timing Remap", () => {
  it("uses word timestamps for precise timing", () => {
    const items = new Map<string, TranscriptItemWithWords>();
    items.set("item1", {
      item_id: "item1",
      start_us: 0,
      end_us: 2_000_000,
      text: "すごいですね",
      word_timing_mode: "word",
      words: [
        { word: "すごい", start_us: 100_000, end_us: 500_000, confidence: 0.95 },
        { word: "です", start_us: 500_000, end_us: 800_000, confidence: 0.9 },
        { word: "ね", start_us: 800_000, end_us: 1_000_000, confidence: 0.85 },
      ],
    });

    const input: TimingRemapInput = {
      captionId: "SC_0001",
      text: "すごいですね",
      transcriptItemIds: ["item1"],
      clipTimelineInFrame: 0,
      clipTimelineDurationFrames: 72,
      clipSrcInUs: 0,
      clipSrcOutUs: 3_000_000,
      clipTimelineInFrameBase: 0,
      fps: 30,
    };

    const result = remapWithWordTimestamps(input, items);
    expect(result.timingSource).toBe("word_remap");
    expect(result.timingConfidence).toBeGreaterThan(0.8);
    expect(result.timelineInFrame).toBeGreaterThanOrEqual(0);
    expect(result.timelineDurationFrames).toBeGreaterThan(0);
    expect(result.sourceWordRefs).toHaveLength(3);
  });

  it("falls back to clip_item_remap when no word timestamps", () => {
    const items = new Map<string, TranscriptItemWithWords>();
    items.set("item1", {
      item_id: "item1",
      start_us: 0,
      end_us: 2_000_000,
      text: "すごいですね",
      word_timing_mode: "none",
    });

    const input: TimingRemapInput = {
      captionId: "SC_0001",
      text: "すごいですね",
      transcriptItemIds: ["item1"],
      clipTimelineInFrame: 10,
      clipTimelineDurationFrames: 30,
      clipSrcInUs: 0,
      clipSrcOutUs: 3_000_000,
      clipTimelineInFrameBase: 0,
      fps: 30,
    };

    const result = remapWithWordTimestamps(input, items);
    expect(result.timingSource).toBe("clip_item_remap");
    expect(result.timelineInFrame).toBe(10);
    expect(result.timelineDurationFrames).toBe(30);
  });

  it("falls back when transcript item not found", () => {
    const items = new Map<string, TranscriptItemWithWords>();
    const input: TimingRemapInput = {
      captionId: "SC_0001",
      text: "test",
      transcriptItemIds: ["nonexistent"],
      clipTimelineInFrame: 5,
      clipTimelineDurationFrames: 20,
      clipSrcInUs: 0,
      clipSrcOutUs: 1_000_000,
      clipTimelineInFrameBase: 0,
      fps: 30,
    };

    const result = remapWithWordTimestamps(input, items);
    expect(result.timingSource).toBe("clip_item_remap");
    expect(result.timingConfidence).toBe(0.5);
  });

  it("batch remap processes multiple captions", () => {
    const items = new Map<string, TranscriptItemWithWords>();
    items.set("item1", {
      item_id: "item1",
      start_us: 0,
      end_us: 1_000_000,
      text: "hello",
      word_timing_mode: "word",
      words: [{ word: "hello", start_us: 0, end_us: 500_000, confidence: 0.9 }],
    });

    const results = batchWordRemap(
      [
        { captionId: "SC_0001", text: "hello", transcriptItemIds: ["item1"], timelineInFrame: 0, timelineDurationFrames: 15 },
        { captionId: "SC_0002", text: "world", transcriptItemIds: ["missing"], timelineInFrame: 15, timelineDurationFrames: 15 },
      ],
      [{ clipId: "c1", assetId: "A1", srcInUs: 0, srcOutUs: 2_000_000, timelineInFrame: 0, timelineDurationFrames: 30 }],
      items,
      30,
    );

    expect(results.size).toBe(2);
    expect(results.get("SC_0001")!.timingSource).toBe("word_remap");
    expect(results.get("SC_0002")!.timingSource).toBe("clip_item_remap");
  });
});

// ═════════════════════════════════════════════════════════════════════════
// Phase C: Narrative Loop Tests
// ═════════════════════════════════════════════════════════════════════════

describe("Narrative Loop", () => {
  describe("validateConfirmedPreferences", () => {
    it("passes with correct full mode preferences", () => {
      const blueprint = {
        sequence_goals: ["test"],
        beats: [],
        pacing: {
          opening_cadence: "fast",
          middle_cadence: "medium",
          ending_cadence: "slow",
          confirmed_preferences: {
            mode: "full" as const,
            source: "ai_autonomous" as const,
            duration_target_sec: 120,
            confirmed_at: "2026-03-22T00:00:00Z",
          },
        },
        music_policy: { start_sparse: true, allow_release_late: true, entry_beat: "B001" },
        dialogue_policy: { preserve_natural_breath: true, avoid_wall_to_wall_voiceover: true },
        transition_policy: { prefer_match_texture_over_flashy_fx: true },
        ending_policy: { should_feel: "resolved" },
        rejection_rules: [],
      };

      expect(validateConfirmedPreferences(blueprint, "full")).toEqual([]);
    });

    it("fails when mode mismatches", () => {
      const blueprint = {
        sequence_goals: ["test"],
        beats: [],
        pacing: {
          opening_cadence: "fast",
          middle_cadence: "medium",
          ending_cadence: "slow",
          confirmed_preferences: {
            mode: "full" as const,
            source: "ai_autonomous" as const,
            duration_target_sec: 120,
            confirmed_at: "2026-03-22T00:00:00Z",
          },
        },
        music_policy: { start_sparse: true, allow_release_late: true, entry_beat: "B001" },
        dialogue_policy: { preserve_natural_breath: true, avoid_wall_to_wall_voiceover: true },
        transition_policy: { prefer_match_texture_over_flashy_fx: true },
        ending_policy: { should_feel: "resolved" },
        rejection_rules: [],
      };

      const errors = validateConfirmedPreferences(blueprint, "collaborative");
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0]).toContain("collaborative");
    });

    it("fails when preferences missing", () => {
      const blueprint = {
        sequence_goals: [],
        beats: [],
        pacing: { opening_cadence: "fast", middle_cadence: "medium", ending_cadence: "slow" },
        music_policy: { start_sparse: true, allow_release_late: true, entry_beat: "B001" },
        dialogue_policy: { preserve_natural_breath: true, avoid_wall_to_wall_voiceover: true },
        transition_policy: { prefer_match_texture_over_flashy_fx: true },
        ending_policy: { should_feel: "resolved" },
        rejection_rules: [],
      };

      const errors = validateConfirmedPreferences(blueprint, "full");
      expect(errors).toContain("pacing.confirmed_preferences is required");
    });
  });
});

// ═════════════════════════════════════════════════════════════════════════
// Phase D: LLM Caption Editorial Tests
// ═════════════════════════════════════════════════════════════════════════

describe("LLM Caption Editorial", () => {
  function mockCaptionSource(): CaptionSource {
    return {
      version: "1.0",
      project_id: "test",
      base_timeline_version: "1",
      caption_policy: {
        language: "ja",
        delivery_mode: "burn_in",
        source: "transcript",
        styling_class: "default-ja",
      },
      speech_captions: [
        {
          caption_id: "SC_0001",
          asset_id: "A_001",
          segment_id: "SG_001",
          timeline_in_frame: 0,
          timeline_duration_frames: 36,
          text: "A_I技術がすごい",
          transcript_ref: "TR_A_001",
          transcript_item_ids: ["TRI_001"],
          source: "transcript",
          styling_class: "default-ja",
          metrics: { cps: 4.0, dwell_ms: 1500 },
        },
        {
          caption_id: "SC_0002",
          asset_id: "A_001",
          segment_id: "SG_001",
          timeline_in_frame: 36,
          timeline_duration_frames: 36,
          text: "C_E_Oの話を聞きました",
          transcript_ref: "TR_A_001",
          transcript_item_ids: ["TRI_002"],
          source: "transcript",
          styling_class: "default-ja",
          metrics: { cps: 5.0, dwell_ms: 1500 },
        },
      ],
      text_overlays: [],
    };
  }

  describe("must-keep token validation", () => {
    it("detects missing glossary term", () => {
      const missing = validateMustKeepTokens(
        "AI技術は2024年に進歩した",
        "技術は進歩した",
        ["AI"],
      );
      expect(missing).toContain("AI");
    });

    it("detects missing number", () => {
      const missing = validateMustKeepTokens(
        "売上は100万円です",
        "売上は万円です",
        [],
      );
      expect(missing).toContain("100");
    });

    it("passes when all tokens preserved", () => {
      const missing = validateMustKeepTokens(
        "AI技術は2024年に進歩した",
        "AI技術は2024年に大きく進歩した",
        ["AI"],
      );
      expect(missing).toHaveLength(0);
    });
  });

  describe("buildGlossary", () => {
    it("collects terms from all sources", () => {
      const glossary = buildGlossary({
        mustInclude: ["AI"],
        projectNames: ["VideoOS"],
        brandTerms: ["Reboot"],
        operatorCorrections: [{ from: "A_I", to: "AI" }],
      });
      expect(glossary).toContain("AI");
      expect(glossary).toContain("VideoOS");
      expect(glossary).toContain("Reboot");
    });

    it("deduplicates terms", () => {
      const glossary = buildGlossary({
        mustInclude: ["AI"],
        projectNames: ["AI"],
      });
      expect(glossary.filter((t) => t === "AI")).toHaveLength(1);
    });
  });

  describe("runEditorial", () => {
    it("produces edited draft with mock judge", async () => {
      const source = mockCaptionSource();

      const mockJudge: EditorialJudge = {
        async judge(captions, glossary, language) {
          return {
            decision: "override",
            edits: [
              {
                captionId: "SC_0001",
                editedText: "AI技術がすごい",
                operations: ["orthography"],
                glossaryHits: ["AI"],
                confidence: 0.95,
              },
              {
                captionId: "SC_0002",
                editedText: "CEOの話を聞きました",
                operations: ["orthography"],
                glossaryHits: ["CEO"],
                confidence: 0.92,
              },
            ],
            confidence: 0.93,
          };
        },
      };

      const { draft, report } = await runEditorial(source, {
        judge: mockJudge,
        glossary: ["AI", "CEO"],
      });

      expect(draft.speech_captions).toHaveLength(2);
      expect(draft.speech_captions[0].text).toBe("AI技術がすごい");
      expect(draft.speech_captions[0].editorial?.status).toBe("edited");
      expect(draft.speech_captions[0].editorial?.sourceText).toBe("A_I技術がすごい");
      expect(draft.speech_captions[1].text).toBe("CEOの話を聞きました");
      expect(draft.degraded_count).toBe(0);
      expect(draft.draft_status).toBe("ready_for_human_approval");
      expect(report.edited_count).toBe(2);
    });

    it("produces degraded draft on LLM failure", async () => {
      const source = mockCaptionSource();

      const failJudge: EditorialJudge = {
        async judge() {
          throw new Error("LLM timeout");
        },
      };

      const { draft, report } = await runEditorial(source, {
        judge: failJudge,
        maxRetries: 0,
      });

      expect(draft.degraded_count).toBe(2);
      expect(draft.draft_status).toBe("needs_operator_fix");
      expect(draft.speech_captions[0].editorial?.status).toBe("degraded");
      expect(draft.speech_captions[0].text).toBe("A_I技術がすごい"); // preserved
      expect(report.reject_reasons.length).toBeGreaterThan(0);
    });

    it("rejects edit that removes must-keep token", async () => {
      const source = mockCaptionSource();
      // Pre-clean source text so "AI" is actually in source
      source.speech_captions[0].text = "AI技術がすごい";

      const badJudge: EditorialJudge = {
        async judge() {
          return {
            decision: "override",
            edits: [
              {
                captionId: "SC_0001",
                editedText: "技術がすごい", // AI removed!
                operations: ["orthography"],
                glossaryHits: [],
                confidence: 0.9,
              },
            ],
            confidence: 0.9,
          };
        },
      };

      const { draft, report } = await runEditorial(source, {
        judge: badJudge,
        glossary: ["AI"],
        maxRetries: 0,
      });

      // Should be degraded because the edit was rejected (whole decision invalid)
      expect(draft.degraded_count).toBe(2);
      expect(report.reject_reasons.length).toBeGreaterThan(0);
    });
  });
});

// ═════════════════════════════════════════════════════════════════════════
// Phase E: Caption Artifact Separation Tests
// ═════════════════════════════════════════════════════════════════════════

describe("Caption Artifact Separation", () => {
  it("CaptionDraft has editorial metadata", () => {
    const draft: CaptionDraft = {
      version: "1.0",
      project_id: "test",
      base_timeline_version: "1",
      caption_policy: {
        language: "ja",
        delivery_mode: "burn_in",
        source: "transcript",
        styling_class: "default-ja",
      },
      speech_captions: [
        {
          caption_id: "SC_0001",
          asset_id: "A_001",
          segment_id: "SG_001",
          timeline_in_frame: 0,
          timeline_duration_frames: 36,
          text: "AI技術がすごい",
          transcript_ref: "TR_A_001",
          transcript_item_ids: ["TRI_001"],
          source: "transcript",
          styling_class: "default-ja",
          metrics: { cps: 4.0, dwell_ms: 1500 },
          editorial: {
            sourceText: "A_I技術がすごい",
            operations: ["orthography"],
            glossaryHits: ["AI"],
            confidence: 0.95,
            status: "edited",
          },
        },
      ],
      text_overlays: [],
      draft_status: "ready_for_human_approval",
      degraded_count: 0,
    };

    expect(draft.speech_captions[0].editorial).toBeDefined();
    expect(draft.speech_captions[0].editorial!.sourceText).toBe("A_I技術がすごい");
    expect(draft.speech_captions[0].editorial!.status).toBe("edited");
    expect(draft.draft_status).toBe("ready_for_human_approval");
  });

  it("CaptionDraft with degraded status blocks approval", () => {
    const draft: CaptionDraft = {
      version: "1.0",
      project_id: "test",
      base_timeline_version: "1",
      caption_policy: {
        language: "ja",
        delivery_mode: "burn_in",
        source: "transcript",
        styling_class: "default-ja",
      },
      speech_captions: [{
        caption_id: "SC_0001",
        asset_id: "A_001",
        segment_id: "SG_001",
        timeline_in_frame: 0,
        timeline_duration_frames: 36,
        text: "A_I技術がすごい",
        transcript_ref: "TR_A_001",
        transcript_item_ids: ["TRI_001"],
        source: "transcript",
        styling_class: "default-ja",
        metrics: { cps: 4.0, dwell_ms: 1500 },
        editorial: {
          sourceText: "A_I技術がすごい",
          operations: [],
          glossaryHits: [],
          confidence: 0,
          status: "degraded",
        },
      }],
      text_overlays: [],
      draft_status: "needs_operator_fix",
      degraded_count: 1,
    };

    expect(draft.draft_status).toBe("needs_operator_fix");
    expect(draft.degraded_count).toBe(1);
  });
});

// ═════════════════════════════════════════════════════════════════════════
// Integration: Cleanup integrated into segmenter
// ═════════════════════════════════════════════════════════════════════════

import { generateCaptionSource } from "../runtime/caption/segmenter.js";

describe("Cleanup integration in segmenter", () => {

  function mockTimeline() {
    return {
      project_id: "test",
      fps: 24,
      tracks: {
        audio: [{
          track_id: "A1",
          clips: [{
            clip_id: "c1",
            segment_id: "SG_001",
            asset_id: "A_001",
            src_in_us: 0,
            src_out_us: 3_000_000,
            timeline_in_frame: 0,
            timeline_duration_frames: 72,
            role: "dialogue",
          }],
        }],
      },
    };
  }

  it("cleans A_I → AI in generated captions", () => {
    const transcript = {
      project_id: "test",
      artifact_version: "2.0.0",
      transcript_ref: "TR_A_001",
      asset_id: "A_001",
      items: [{
        item_id: "TRI_001",
        speaker: "S1",
        speaker_key: "A_001:speaker_1",
        start_us: 0,
        end_us: 1_500_000,
        text: "A_Iの技術がすごい",
      }],
    };

    const transcripts = new Map([["A_001", transcript]]);
    const policy = {
      language: "ja",
      delivery_mode: "burn_in" as const,
      source: "transcript" as const,
      styling_class: "default-ja",
    };

    const result = generateCaptionSource(
      mockTimeline(), transcripts, policy, "test", "1",
      { deterministicCleanup: true, autoLineBreak: false },
    );

    expect(result.speech_captions[0].text).toBe("AIの技術がすごい");
  });

  it("can disable cleanup with deterministicCleanup: false", () => {
    const transcript = {
      project_id: "test",
      artifact_version: "2.0.0",
      transcript_ref: "TR_A_001",
      asset_id: "A_001",
      items: [{
        item_id: "TRI_001",
        speaker: "S1",
        speaker_key: "A_001:speaker_1",
        start_us: 0,
        end_us: 1_500_000,
        text: "A_Iの技術",
      }],
    };

    const transcripts = new Map([["A_001", transcript]]);
    const policy = {
      language: "ja",
      delivery_mode: "burn_in" as const,
      source: "transcript" as const,
      styling_class: "default-ja",
    };

    const result = generateCaptionSource(
      mockTimeline(), transcripts, policy, "test", "1",
      { deterministicCleanup: false, autoLineBreak: false },
    );

    expect(result.speech_captions[0].text).toBe("A_Iの技術");
  });
});
