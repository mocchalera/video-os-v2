/**
 * Tests for Groq Whisper STT Connector — verbose_json parsing,
 * provider selection, word timestamp conversion, and pipeline integration.
 *
 * All tests use mock data — no real Groq API calls.
 */
import { describe, it, expect } from "vitest";
import {
  parseGroqWords,
  parseGroqSegments,
  parseGroqResponse,
  type GroqVerboseJsonResponse,
  type GroqSegment,
  type GroqWord,
} from "../runtime/connectors/groq-stt.js";
import { resolveTranscribeFn } from "../runtime/pipeline/ingest.js";
import type { SttPolicy } from "../runtime/connectors/stt-interface.js";

// ── Mock Policies ───────────────────────────────────────────────────

const GROQ_STT_POLICY: SttPolicy = {
  model_alias: "whisper-large-v3-turbo",
  model_snapshot: "test-snapshot",
  endpoint: "/v1/audio/transcriptions",
  response_format: "verbose_json",
  language: "ja",
  chunk_target_us: 20_000_000,
  chunk_max_us: 25_000_000,
  chunk_overlap_us: 500_000,
  chunk_boundary_silence_us: 350_000,
  chunking_strategy: "client_audio_chunks_v1",
  speaker_normalization: "overlap_anchor_v1",
  generate_words: true,
};

const OPENAI_STT_POLICY: SttPolicy = {
  model_alias: "gpt-4o-transcribe-diarize",
  model_snapshot: "test-snapshot",
  endpoint: "/v1/audio/transcriptions",
  response_format: "diarized_json",
  chunk_target_us: 20_000_000,
  chunk_max_us: 25_000_000,
  chunk_overlap_us: 500_000,
  chunk_boundary_silence_us: 350_000,
  chunking_strategy: "client_audio_chunks_v1",
  speaker_normalization: "overlap_anchor_v1",
  generate_words: false,
};

// ── Mock Groq Responses ─────────────────────────────────────────────

const MOCK_GROQ_RESPONSE: GroqVerboseJsonResponse = {
  text: "こんにちは、今日はよろしくお願いします。",
  language: "ja",
  segments: [
    {
      id: 0,
      start: 0.5,
      end: 2.1,
      text: "こんにちは、",
      words: [
        { word: "こんにちは、", start: 0.5, end: 1.8 },
      ],
    },
    {
      id: 1,
      start: 2.3,
      end: 4.5,
      text: "今日はよろしくお願いします。",
      words: [
        { word: "今日は", start: 2.3, end: 2.8 },
        { word: "よろしく", start: 2.9, end: 3.4 },
        { word: "お願いします。", start: 3.5, end: 4.5 },
      ],
    },
  ],
};

const MOCK_GROQ_RESPONSE_WORDS_ONLY: GroqVerboseJsonResponse = {
  text: "テスト音声です",
  language: "ja",
  words: [
    { word: "テスト", start: 0.0, end: 0.5 },
    { word: "音声", start: 0.6, end: 1.0 },
    { word: "です", start: 1.1, end: 1.5 },
  ],
};

const MOCK_GROQ_RESPONSE_TEXT_ONLY: GroqVerboseJsonResponse = {
  text: "テキストのみ",
  language: "ja",
};

const MOCK_GROQ_RESPONSE_EMPTY: GroqVerboseJsonResponse = {
  text: "",
  language: "ja",
};

// ── Unit Tests: parseGroqWords ──────────────────────────────────────

describe("Groq STT: parseGroqWords", () => {
  it("converts Groq words to SttWord with microsecond timestamps", () => {
    const words: GroqWord[] = [
      { word: "こんにちは", start: 0.5, end: 1.2 },
      { word: "世界", start: 1.3, end: 1.8 },
    ];
    const result = parseGroqWords(words);

    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({
      word: "こんにちは",
      start_us: 500_000,
      end_us: 1_200_000,
    });
    expect(result[1]).toEqual({
      word: "世界",
      start_us: 1_300_000,
      end_us: 1_800_000,
    });
  });

  it("filters out empty words", () => {
    const words: GroqWord[] = [
      { word: "", start: 0.0, end: 0.5 },
      { word: "  ", start: 0.5, end: 1.0 },
      { word: "有効", start: 1.0, end: 1.5 },
    ];
    const result = parseGroqWords(words);

    expect(result).toHaveLength(1);
    expect(result[0].word).toBe("有効");
  });

  it("filters out words where end <= start", () => {
    const words: GroqWord[] = [
      { word: "invalid", start: 1.0, end: 1.0 },
      { word: "also_invalid", start: 2.0, end: 1.5 },
      { word: "valid", start: 3.0, end: 3.5 },
    ];
    const result = parseGroqWords(words);

    expect(result).toHaveLength(1);
    expect(result[0].word).toBe("valid");
  });

  it("returns empty array for empty input", () => {
    expect(parseGroqWords([])).toEqual([]);
  });
});

// ── Unit Tests: parseGroqSegments ───────────────────────────────────

describe("Groq STT: parseGroqSegments", () => {
  it("converts segments with speaker S1 (no diarization)", () => {
    const segments: GroqSegment[] = [
      {
        id: 0,
        start: 1.0,
        end: 3.5,
        text: "最初のセグメント",
        words: [
          { word: "最初の", start: 1.0, end: 2.0 },
          { word: "セグメント", start: 2.1, end: 3.5 },
        ],
      },
    ];
    const result = parseGroqSegments(segments);

    expect(result).toHaveLength(1);
    expect(result[0].speaker).toBe("S1");
    expect(result[0].start_us).toBe(1_000_000);
    expect(result[0].end_us).toBe(3_500_000);
    expect(result[0].text).toBe("最初のセグメント");
    expect(result[0].words).toHaveLength(2);
    expect(result[0].words![0]).toEqual({
      word: "最初の",
      start_us: 1_000_000,
      end_us: 2_000_000,
    });
  });

  it("filters out segments with empty text", () => {
    const segments: GroqSegment[] = [
      { id: 0, start: 0.0, end: 1.0, text: "" },
      { id: 1, start: 1.0, end: 2.0, text: "  " },
      { id: 2, start: 2.0, end: 3.0, text: "有効なテキスト" },
    ];
    const result = parseGroqSegments(segments);

    expect(result).toHaveLength(1);
    expect(result[0].text).toBe("有効なテキスト");
  });

  it("handles segments without words", () => {
    const segments: GroqSegment[] = [
      { id: 0, start: 0.0, end: 1.5, text: "ワードなし" },
    ];
    const result = parseGroqSegments(segments);

    expect(result).toHaveLength(1);
    expect(result[0].words).toBeUndefined();
  });

  it("handles multiple segments", () => {
    const segments: GroqSegment[] = [
      { id: 0, start: 0.0, end: 2.0, text: "一番" },
      { id: 1, start: 2.5, end: 4.0, text: "二番" },
      { id: 2, start: 4.5, end: 6.0, text: "三番" },
    ];
    const result = parseGroqSegments(segments);

    expect(result).toHaveLength(3);
    expect(result.every((u) => u.speaker === "S1")).toBe(true);
  });
});

// ── Unit Tests: parseGroqResponse ───────────────────────────────────

describe("Groq STT: parseGroqResponse", () => {
  it("parses full verbose_json response with segments and words", () => {
    const result = parseGroqResponse(MOCK_GROQ_RESPONSE);

    expect(result.language).toBe("ja");
    expect(result.utterances).toHaveLength(2);

    // First segment
    expect(result.utterances[0].speaker).toBe("S1");
    expect(result.utterances[0].text).toBe("こんにちは、");
    expect(result.utterances[0].start_us).toBe(500_000);
    expect(result.utterances[0].end_us).toBe(2_100_000);
    expect(result.utterances[0].words).toHaveLength(1);

    // Second segment
    expect(result.utterances[1].text).toBe("今日はよろしくお願いします。");
    expect(result.utterances[1].words).toHaveLength(3);
  });

  it("falls back to top-level words when no segments", () => {
    const result = parseGroqResponse(MOCK_GROQ_RESPONSE_WORDS_ONLY);

    expect(result.utterances).toHaveLength(1);
    expect(result.utterances[0].text).toBe("テスト音声です");
    expect(result.utterances[0].words).toHaveLength(3);
    expect(result.utterances[0].start_us).toBe(0);
    expect(result.utterances[0].end_us).toBe(1_500_000);
  });

  it("falls back to text-only when no segments or words", () => {
    const result = parseGroqResponse(MOCK_GROQ_RESPONSE_TEXT_ONLY);

    expect(result.utterances).toHaveLength(1);
    expect(result.utterances[0].text).toBe("テキストのみ");
    expect(result.utterances[0].start_us).toBe(0);
    expect(result.utterances[0].end_us).toBe(0);
    expect(result.utterances[0].words).toBeUndefined();
  });

  it("returns empty utterances for empty text", () => {
    const result = parseGroqResponse(MOCK_GROQ_RESPONSE_EMPTY);

    expect(result.utterances).toHaveLength(0);
    expect(result.language).toBe("ja");
  });

  it("preserves Japanese text without romaji corruption", () => {
    const response: GroqVerboseJsonResponse = {
      text: "映像制作における編集技術の重要性について説明します。",
      language: "ja",
      segments: [
        {
          id: 0,
          start: 0.0,
          end: 5.0,
          text: "映像制作における編集技術の重要性について説明します。",
          words: [
            { word: "映像制作", start: 0.0, end: 0.8 },
            { word: "における", start: 0.9, end: 1.3 },
            { word: "編集技術の", start: 1.4, end: 2.2 },
            { word: "重要性に", start: 2.3, end: 3.0 },
            { word: "ついて", start: 3.1, end: 3.5 },
            { word: "説明します。", start: 3.6, end: 5.0 },
          ],
        },
      ],
    };
    const result = parseGroqResponse(response);

    // All text should be native Japanese (kanji + kana), no romaji
    expect(result.utterances[0].text).not.toMatch(/[a-zA-Z]/);
    expect(result.utterances[0].words!.every((w) => !w.word.match(/[a-zA-Z]/))).toBe(true);
  });
});

// ── Unit Tests: Provider Selection ──────────────────────────────────

describe("Groq STT: resolveTranscribeFn", () => {
  it("selects Groq for whisper-large-v3-turbo model alias", () => {
    const { providerName } = resolveTranscribeFn(GROQ_STT_POLICY);
    expect(providerName).toBe("groq-whisper");
  });

  it("selects Groq for whisper-large-v3 model alias", () => {
    const policy: SttPolicy = { ...GROQ_STT_POLICY, model_alias: "whisper-large-v3" };
    const { providerName } = resolveTranscribeFn(policy);
    expect(providerName).toBe("groq-whisper");
  });

  it("selects OpenAI for gpt-4o-transcribe-diarize model alias", () => {
    const { providerName } = resolveTranscribeFn(OPENAI_STT_POLICY);
    expect(providerName).toBe("openai");
  });

  it("explicit provider override 'groq' forces Groq", () => {
    const { providerName } = resolveTranscribeFn(OPENAI_STT_POLICY, "groq");
    expect(providerName).toBe("groq-whisper");
  });

  it("explicit provider override 'openai' forces OpenAI", () => {
    const { providerName } = resolveTranscribeFn(GROQ_STT_POLICY, "openai");
    expect(providerName).toBe("openai");
  });

  it("returns a TranscribeFn function", () => {
    const { transcribeFn } = resolveTranscribeFn(GROQ_STT_POLICY);
    expect(typeof transcribeFn).toBe("function");
  });
});

// ── Unit Tests: Word Timing Integration ─────────────────────────────

describe("Groq STT: word timing integration", () => {
  it("word timestamps align within segment boundaries", () => {
    const result = parseGroqResponse(MOCK_GROQ_RESPONSE);
    const seg = result.utterances[1]; // second segment with 3 words

    expect(seg.words).toBeDefined();
    expect(seg.words!.length).toBe(3);

    // All words should be within segment boundaries
    for (const word of seg.words!) {
      expect(word.start_us).toBeGreaterThanOrEqual(seg.start_us);
      expect(word.end_us).toBeLessThanOrEqual(seg.end_us);
    }
  });

  it("words are in chronological order", () => {
    const result = parseGroqResponse(MOCK_GROQ_RESPONSE);
    const seg = result.utterances[1];

    for (let i = 1; i < seg.words!.length; i++) {
      expect(seg.words![i].start_us).toBeGreaterThanOrEqual(seg.words![i - 1].end_us);
    }
  });
});
