/**
 * Tests for filler removal and speaker filtering in caption segmenter.
 *
 * Covers:
 * - Japanese filler word detection and removal
 * - Filler-only segment exclusion
 * - Speaker-based filtering (interviewer exclusion)
 * - Combined filler + speaker filtering
 * - Backward compatibility (options omitted)
 */

import { describe, it, expect } from "vitest";
import {
  generateCaptionSource,
  removeFillers,
  isFillerOnly,
  FILLER_PATTERN,
  type CaptionPolicy,
  type CaptionGenerationOptions,
} from "../runtime/caption/segmenter.js";

// ── Helpers ──────────────────────────────────────────────────────────

function makeTimeline(clips: Array<{
  clip_id: string;
  asset_id: string;
  src_in_us: number;
  src_out_us: number;
  timeline_in_frame: number;
  timeline_duration_frames: number;
}>) {
  return {
    project_id: "test-filler",
    timeline_version: "1",
    fps: 24,
    tracks: {
      video: [{ track_id: "V1", clips: [] }],
      audio: [
        {
          track_id: "A1",
          clips: clips.map((c) => ({
            ...c,
            segment_id: "SEG_001",
            role: "dialogue",
          })),
        },
      ],
    },
    markers: [],
  };
}

function makeTranscript(
  assetId: string,
  items: Array<{
    item_id: string;
    speaker: string;
    speaker_key: string;
    start_us: number;
    end_us: number;
    text: string;
  }>,
) {
  return {
    project_id: "test-filler",
    artifact_version: "2.0.0",
    transcript_ref: `TR_${assetId}`,
    asset_id: assetId,
    items,
  };
}

const defaultPolicy: CaptionPolicy = {
  language: "ja",
  delivery_mode: "burn_in",
  source: "transcript",
  styling_class: "default",
};

// ── removeFillers() unit tests ───────────────────────────────────────

describe("removeFillers", () => {
  it("removes えーと from text", () => {
    expect(removeFillers("えーと僕あんまりセミナーって出ないんですけど")).toBe(
      "僕あんまりセミナーって出ないんですけど",
    );
  });

  it("removes えー from text", () => {
    expect(removeFillers("えー正直AIについては")).toBe("正直AIについては");
  });

  it("removes えっと from text", () => {
    expect(removeFillers("えっと自分でアプリを作った")).toBe(
      "自分でアプリを作った",
    );
  });

  it("removes えーっと from text", () => {
    expect(removeFillers("えーっと自分でアプリを作った")).toBe(
      "自分でアプリを作った",
    );
  });

  it("removes あー from text", () => {
    expect(removeFillers("あー作れちゃったと")).toBe("作れちゃったと");
  });

  it("removes うーん from text", () => {
    expect(removeFillers("うーん気になった点")).toBe("気になった点");
  });

  it("removes まあ from text", () => {
    expect(removeFillers("まあそんな感じです")).toBe("そんな感じです");
  });

  it("removes なんか from text", () => {
    expect(removeFillers("なんか自分の中でも変化を感じます")).toBe(
      "自分の中でも変化を感じます",
    );
  });

  it("removes あの from text", () => {
    expect(removeFillers("あの実践的で")).toBe("実践的で");
  });

  it("removes その from text", () => {
    expect(removeFillers("その経験の壁")).toBe("経験の壁");
  });

  it("removes multiple fillers from same text", () => {
    expect(removeFillers("えーとまあなんか色々あって")).toBe("色々あって");
  });

  it("collapses multiple spaces after removal", () => {
    expect(removeFillers("えー 正直 あの AIについて")).toBe("正直 AIについて");
  });

  it("returns empty string for filler-only text", () => {
    expect(removeFillers("えーと")).toBe("");
  });

  it("preserves text without fillers", () => {
    expect(removeFillers("正直AIについては危機感をずっと持っていまして")).toBe(
      "正直AIについては危機感をずっと持っていまして",
    );
  });
});

// ── isFillerOnly() unit tests ────────────────────────────────────────

describe("isFillerOnly", () => {
  it("returns true for single filler word", () => {
    expect(isFillerOnly("えーと")).toBe(true);
  });

  it("returns true for multiple filler words", () => {
    expect(isFillerOnly("えーと まあ なんか")).toBe(true);
  });

  it("returns true for filler with punctuation", () => {
    expect(isFillerOnly("えーっと。")).toBe(true);
  });

  it("returns true for filler with whitespace", () => {
    expect(isFillerOnly("  えー  ")).toBe(true);
  });

  it("returns false for text with real content", () => {
    expect(isFillerOnly("えーと僕は")).toBe(false);
  });

  it("returns false for non-filler text", () => {
    expect(isFillerOnly("正直AIについて")).toBe(false);
  });

  it("returns true for empty string", () => {
    expect(isFillerOnly("")).toBe(true);
  });

  it("returns true for うん repeated", () => {
    expect(isFillerOnly("うん、うん、うん、")).toBe(true);
  });
});

// ── Filler removal in generateCaptionSource ──────────────────────────

describe("generateCaptionSource with filler removal", () => {
  it("removes fillers from caption text when removeFillers is true", () => {
    const timeline = makeTimeline([
      {
        clip_id: "c1",
        asset_id: "A_001",
        src_in_us: 0,
        src_out_us: 5_000_000,
        timeline_in_frame: 0,
        timeline_duration_frames: 120,
      },
    ]);

    const transcript = makeTranscript("A_001", [
      {
        item_id: "TRI_001",
        speaker: "S1",
        speaker_key: "A_001:speaker_1",
        start_us: 0,
        end_us: 2_000_000,
        text: "えーと僕あんまりセミナーって出ないんですけど",
      },
      {
        item_id: "TRI_002",
        speaker: "S1",
        speaker_key: "A_001:speaker_1",
        start_us: 3_000_000,
        end_us: 4_500_000,
        text: "えー正直AIについては危機感を持っていまして",
      },
    ]);

    const transcripts = new Map([["A_001", transcript]]);
    const result = generateCaptionSource(
      timeline,
      transcripts,
      defaultPolicy,
      "test",
      "1",
      { removeFillers: true },
    );

    // Fillers should be removed from text
    for (const cap of result.speech_captions) {
      expect(cap.text).not.toMatch(/えーと/);
      expect(cap.text).not.toMatch(/えー/);
    }
  });

  it("excludes filler-only segments", () => {
    const timeline = makeTimeline([
      {
        clip_id: "c1",
        asset_id: "A_001",
        src_in_us: 0,
        src_out_us: 6_000_000,
        timeline_in_frame: 0,
        timeline_duration_frames: 144,
      },
    ]);

    const transcript = makeTranscript("A_001", [
      {
        item_id: "TRI_001",
        speaker: "S1",
        speaker_key: "A_001:speaker_1",
        start_us: 0,
        end_us: 500_000,
        text: "えーっと",
      },
      {
        item_id: "TRI_002",
        speaker: "S1",
        speaker_key: "A_001:speaker_1",
        start_us: 2_000_000,
        end_us: 4_000_000,
        text: "正直AIについては危機感を持っていまして",
      },
    ]);

    const transcripts = new Map([["A_001", transcript]]);
    const result = generateCaptionSource(
      timeline,
      transcripts,
      defaultPolicy,
      "test",
      "1",
      { removeFillers: true },
    );

    // Only the real content segment should remain
    expect(result.speech_captions.length).toBe(1);
    expect(result.speech_captions[0].text).toBe(
      "正直AIについては危機感を持っていまして",
    );
  });

  it("preserves fillers when removeFillers is false", () => {
    const timeline = makeTimeline([
      {
        clip_id: "c1",
        asset_id: "A_001",
        src_in_us: 0,
        src_out_us: 3_000_000,
        timeline_in_frame: 0,
        timeline_duration_frames: 72,
      },
    ]);

    const transcript = makeTranscript("A_001", [
      {
        item_id: "TRI_001",
        speaker: "S1",
        speaker_key: "A_001:speaker_1",
        start_us: 0,
        end_us: 2_000_000,
        text: "えーと僕あんまりセミナーって出ないんですけど",
      },
    ]);

    const transcripts = new Map([["A_001", transcript]]);
    const result = generateCaptionSource(
      timeline,
      transcripts,
      defaultPolicy,
      "test",
      "1",
      { removeFillers: false },
    );

    expect(result.speech_captions[0].text).toContain("えーと");
  });

  it("backward compatible — no options means fillers preserved", () => {
    const timeline = makeTimeline([
      {
        clip_id: "c1",
        asset_id: "A_001",
        src_in_us: 0,
        src_out_us: 3_000_000,
        timeline_in_frame: 0,
        timeline_duration_frames: 72,
      },
    ]);

    const transcript = makeTranscript("A_001", [
      {
        item_id: "TRI_001",
        speaker: "S1",
        speaker_key: "A_001:speaker_1",
        start_us: 0,
        end_us: 2_000_000,
        text: "えーと僕あんまりセミナーって出ないんですけど",
      },
    ]);

    const transcripts = new Map([["A_001", transcript]]);
    const result = generateCaptionSource(
      timeline,
      transcripts,
      defaultPolicy,
      "test",
      "1",
    );

    expect(result.speech_captions[0].text).toContain("えーと");
  });
});

// ── Speaker filtering in generateCaptionSource ───────────────────────

describe("generateCaptionSource with speaker filtering", () => {
  it("excludes utterances from excluded speakers", () => {
    const timeline = makeTimeline([
      {
        clip_id: "c1",
        asset_id: "A_001",
        src_in_us: 0,
        src_out_us: 10_000_000,
        timeline_in_frame: 0,
        timeline_duration_frames: 240,
      },
    ]);

    const transcript = makeTranscript("A_001", [
      {
        item_id: "TRI_001",
        speaker: "S1",
        speaker_key: "A_001:speaker_1",
        start_us: 0,
        end_us: 2_000_000,
        text: "なんか印象的だったセッションとかありますか？",
      },
      {
        item_id: "TRI_002",
        speaker: "S2",
        speaker_key: "A_001:speaker_2",
        start_us: 3_000_000,
        end_us: 6_000_000,
        text: "正直AIについては危機感をずっと持っていまして",
      },
      {
        item_id: "TRI_003",
        speaker: "S1",
        speaker_key: "A_001:speaker_1",
        start_us: 7_000_000,
        end_us: 9_000_000,
        text: "なるほど",
      },
    ]);

    const transcripts = new Map([["A_001", transcript]]);
    const result = generateCaptionSource(
      timeline,
      transcripts,
      defaultPolicy,
      "test",
      "1",
      { excludeSpeakers: ["S1"] },
    );

    // Only S2's utterance should remain
    expect(result.speech_captions.length).toBe(1);
    expect(result.speech_captions[0].text).toBe(
      "正直AIについては危機感をずっと持っていまして",
    );
  });

  it("excludes by speaker_key as well", () => {
    const timeline = makeTimeline([
      {
        clip_id: "c1",
        asset_id: "A_001",
        src_in_us: 0,
        src_out_us: 10_000_000,
        timeline_in_frame: 0,
        timeline_duration_frames: 240,
      },
    ]);

    const transcript = makeTranscript("A_001", [
      {
        item_id: "TRI_001",
        speaker: "S1",
        speaker_key: "A_001:speaker_1",
        start_us: 0,
        end_us: 2_000_000,
        text: "質問です",
      },
      {
        item_id: "TRI_002",
        speaker: "S2",
        speaker_key: "A_001:speaker_2",
        start_us: 3_000_000,
        end_us: 5_000_000,
        text: "回答です",
      },
    ]);

    const transcripts = new Map([["A_001", transcript]]);
    const result = generateCaptionSource(
      timeline,
      transcripts,
      defaultPolicy,
      "test",
      "1",
      { excludeSpeakers: ["A_001:speaker_1"] },
    );

    expect(result.speech_captions.length).toBe(1);
    expect(result.speech_captions[0].text).toBe("回答です");
  });

  it("includes all speakers when no filter specified", () => {
    const timeline = makeTimeline([
      {
        clip_id: "c1",
        asset_id: "A_001",
        src_in_us: 0,
        src_out_us: 10_000_000,
        timeline_in_frame: 0,
        timeline_duration_frames: 240,
      },
    ]);

    const transcript = makeTranscript("A_001", [
      {
        item_id: "TRI_001",
        speaker: "S1",
        speaker_key: "A_001:speaker_1",
        start_us: 0,
        end_us: 2_000_000,
        text: "質問です。",
      },
      {
        item_id: "TRI_002",
        speaker: "S2",
        speaker_key: "A_001:speaker_2",
        start_us: 3_000_000,
        end_us: 5_000_000,
        text: "回答です。",
      },
    ]);

    const transcripts = new Map([["A_001", transcript]]);
    const result = generateCaptionSource(
      timeline,
      transcripts,
      defaultPolicy,
      "test",
      "1",
    );

    // Both speakers should be present
    expect(result.speech_captions.length).toBe(2);
  });

  it("excludes multiple speakers", () => {
    const timeline = makeTimeline([
      {
        clip_id: "c1",
        asset_id: "A_001",
        src_in_us: 0,
        src_out_us: 15_000_000,
        timeline_in_frame: 0,
        timeline_duration_frames: 360,
      },
    ]);

    const transcript = makeTranscript("A_001", [
      {
        item_id: "TRI_001",
        speaker: "S1",
        speaker_key: "A_001:speaker_1",
        start_us: 0,
        end_us: 2_000_000,
        text: "インタビュアー1です",
      },
      {
        item_id: "TRI_002",
        speaker: "S2",
        speaker_key: "A_001:speaker_2",
        start_us: 3_000_000,
        end_us: 5_000_000,
        text: "本題の話です",
      },
      {
        item_id: "TRI_003",
        speaker: "S3",
        speaker_key: "A_001:speaker_3",
        start_us: 6_000_000,
        end_us: 8_000_000,
        text: "インタビュアー2です",
      },
    ]);

    const transcripts = new Map([["A_001", transcript]]);
    const result = generateCaptionSource(
      timeline,
      transcripts,
      defaultPolicy,
      "test",
      "1",
      { excludeSpeakers: ["S1", "S3"] },
    );

    expect(result.speech_captions.length).toBe(1);
    expect(result.speech_captions[0].text).toBe("本題の話です");
  });
});

// ── Combined filler + speaker filtering ──────────────────────────────

describe("generateCaptionSource with combined filtering", () => {
  it("applies both filler removal and speaker exclusion", () => {
    const timeline = makeTimeline([
      {
        clip_id: "c1",
        asset_id: "A_001",
        src_in_us: 0,
        src_out_us: 15_000_000,
        timeline_in_frame: 0,
        timeline_duration_frames: 360,
      },
    ]);

    const transcript = makeTranscript("A_001", [
      {
        item_id: "TRI_001",
        speaker: "S1",
        speaker_key: "A_001:speaker_1",
        start_us: 0,
        end_us: 2_000_000,
        text: "なんか印象的だったセッションとかありますか？",
      },
      {
        item_id: "TRI_002",
        speaker: "S2",
        speaker_key: "A_001:speaker_2",
        start_us: 3_000_000,
        end_us: 6_000_000,
        text: "えーと僕あんまりセミナーって出ないんですけど",
      },
      {
        item_id: "TRI_003",
        speaker: "S2",
        speaker_key: "A_001:speaker_2",
        start_us: 7_000_000,
        end_us: 10_000_000,
        text: "えー正直AIについては危機感をずっと持っていまして",
      },
    ]);

    const transcripts = new Map([["A_001", transcript]]);
    const result = generateCaptionSource(
      timeline,
      transcripts,
      defaultPolicy,
      "test",
      "1",
      { excludeSpeakers: ["S1"], removeFillers: true },
    );

    // Interviewer (S1) excluded, fillers removed from S2
    for (const cap of result.speech_captions) {
      expect(cap.text).not.toContain("なんか印象的だった");
      expect(cap.text).not.toMatch(/えーと/);
      expect(cap.text).not.toMatch(/えー/);
    }

    // Should still have content from S2
    const allText = result.speech_captions.map((c) => c.text).join(" ");
    expect(allText).toContain("僕あんまりセミナーって出ないんですけど");
    expect(allText).toContain("正直AIについては危機感をずっと持っていまして");
  });
});

// ── Timeline remapping correctness ───────────────────────────────────

describe("caption timeline remapping", () => {
  it("maps source times to correct timeline positions across multiple clips", () => {
    // Two clips at different timeline positions
    const timeline = makeTimeline([
      {
        clip_id: "c1",
        asset_id: "A_001",
        src_in_us: 8_000_000,
        src_out_us: 12_000_000,
        timeline_in_frame: 0,
        timeline_duration_frames: 96, // 4 seconds at 24fps
      },
      {
        clip_id: "c2",
        asset_id: "A_001",
        src_in_us: 50_000_000,
        src_out_us: 55_000_000,
        timeline_in_frame: 120, // starts at 5 seconds in timeline
        timeline_duration_frames: 120,
      },
    ]);

    const transcript = makeTranscript("A_001", [
      {
        item_id: "TRI_001",
        speaker: "S1",
        speaker_key: "A_001:speaker_1",
        start_us: 9_000_000, // 1s into clip 1
        end_us: 11_000_000,
        text: "最初のクリップ",
      },
      {
        item_id: "TRI_002",
        speaker: "S1",
        speaker_key: "A_001:speaker_1",
        start_us: 51_000_000, // 1s into clip 2
        end_us: 53_000_000,
        text: "二番目のクリップ",
      },
    ]);

    const transcripts = new Map([["A_001", transcript]]);
    const result = generateCaptionSource(
      timeline,
      transcripts,
      defaultPolicy,
      "test",
      "1",
    );

    expect(result.speech_captions.length).toBe(2);

    // First caption: source offset = 9M - 8M = 1M us = 1s → 24 frames from clip start (0)
    expect(result.speech_captions[0].timeline_in_frame).toBe(24);
    expect(result.speech_captions[0].text).toBe("最初のクリップ");

    // Second caption: source offset = 51M - 50M = 1M us = 1s → 24 frames from clip start (120)
    expect(result.speech_captions[1].timeline_in_frame).toBe(144);
    expect(result.speech_captions[1].text).toBe("二番目のクリップ");
  });
});
