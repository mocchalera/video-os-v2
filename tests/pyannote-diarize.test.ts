/**
 * Tests for pyannote speaker diarization integration:
 * - Speaker assignment logic (overlap computation, dominant threshold)
 * - Speaker label normalization
 * - Pipeline integration with mock Groq response + mock pyannote turns
 */
import { describe, it, expect } from "vitest";
import {
  overlapDuration,
  assignSpeakersToUtterances,
  normalizeSpeakerLabels,
} from "../runtime/connectors/groq-stt.js";
import type { SttUtterance } from "../runtime/connectors/stt-interface.js";
import type { DiarizeTurn } from "../runtime/connectors/pyannote-diarizer.js";

// ── Mock Data ──────────────────────────────────────────────────────

/** Two-speaker interview: interviewer (SPEAKER_00) and respondent (SPEAKER_01). */
const MOCK_TURNS: DiarizeTurn[] = [
  { speaker_id: "SPEAKER_00", start_us: 0, end_us: 2_000_000 },       // 0-2s interviewer
  { speaker_id: "SPEAKER_01", start_us: 2_500_000, end_us: 6_000_000 }, // 2.5-6s respondent
  { speaker_id: "SPEAKER_00", start_us: 6_500_000, end_us: 8_000_000 }, // 6.5-8s interviewer
  { speaker_id: "SPEAKER_01", start_us: 8_200_000, end_us: 12_000_000 }, // 8.2-12s respondent
];

/** Groq Whisper utterances (all S1 — no diarization). */
const MOCK_UTTERANCES: SttUtterance[] = [
  {
    speaker: "S1",
    start_us: 100_000,
    end_us: 1_800_000,
    text: "今日はお忙しいところありがとうございます。",
  },
  {
    speaker: "S1",
    start_us: 2_600_000,
    end_us: 5_800_000,
    text: "こちらこそ、お招きいただきありがとうございます。",
  },
  {
    speaker: "S1",
    start_us: 6_600_000,
    end_us: 7_900_000,
    text: "早速ですが、プロジェクトについてお伺いします。",
  },
  {
    speaker: "S1",
    start_us: 8_300_000,
    end_us: 11_800_000,
    text: "はい、まず背景からお話しますと、この企画は昨年から始まりました。",
  },
];

// ── Unit Tests: overlapDuration ─────────────────────────────────────

describe("Diarization: overlapDuration", () => {
  it("computes full overlap when ranges are identical", () => {
    expect(overlapDuration(100, 200, 100, 200)).toBe(100);
  });

  it("computes partial overlap", () => {
    expect(overlapDuration(100, 300, 200, 400)).toBe(100);
  });

  it("returns 0 for no overlap", () => {
    expect(overlapDuration(100, 200, 300, 400)).toBe(0);
  });

  it("returns 0 for adjacent ranges", () => {
    expect(overlapDuration(100, 200, 200, 300)).toBe(0);
  });

  it("handles containment (A contains B)", () => {
    expect(overlapDuration(100, 500, 200, 300)).toBe(100);
  });

  it("handles containment (B contains A)", () => {
    expect(overlapDuration(200, 300, 100, 500)).toBe(100);
  });
});

// ── Unit Tests: assignSpeakersToUtterances ──────────────────────────

describe("Diarization: assignSpeakersToUtterances", () => {
  it("assigns correct speakers based on time overlap", () => {
    const result = assignSpeakersToUtterances(MOCK_UTTERANCES, MOCK_TURNS);

    // Utterance 1 (0.1-1.8s) should match SPEAKER_00 (0-2s)
    expect(result[0].speaker).toBe("SPEAKER_00");

    // Utterance 2 (2.6-5.8s) should match SPEAKER_01 (2.5-6s)
    expect(result[1].speaker).toBe("SPEAKER_01");

    // Utterance 3 (6.6-7.9s) should match SPEAKER_00 (6.5-8s)
    expect(result[2].speaker).toBe("SPEAKER_00");

    // Utterance 4 (8.3-11.8s) should match SPEAKER_01 (8.2-12s)
    expect(result[3].speaker).toBe("SPEAKER_01");
  });

  it("returns original utterances when turns array is empty", () => {
    const result = assignSpeakersToUtterances(MOCK_UTTERANCES, []);

    expect(result).toEqual(MOCK_UTTERANCES);
  });

  it("does not mutate original utterances", () => {
    const origSpeakers = MOCK_UTTERANCES.map((u) => u.speaker);
    assignSpeakersToUtterances(MOCK_UTTERANCES, MOCK_TURNS);

    expect(MOCK_UTTERANCES.map((u) => u.speaker)).toEqual(origSpeakers);
  });

  it("preserves text and timing of original utterances", () => {
    const result = assignSpeakersToUtterances(MOCK_UTTERANCES, MOCK_TURNS);

    for (let i = 0; i < MOCK_UTTERANCES.length; i++) {
      expect(result[i].start_us).toBe(MOCK_UTTERANCES[i].start_us);
      expect(result[i].end_us).toBe(MOCK_UTTERANCES[i].end_us);
      expect(result[i].text).toBe(MOCK_UTTERANCES[i].text);
    }
  });

  it("handles utterances that span multiple speaker turns", () => {
    // An utterance that overlaps with both SPEAKER_00 (0-2s) and SPEAKER_01 (2.5-6s)
    const spanning: SttUtterance[] = [
      {
        speaker: "S1",
        start_us: 500_000,
        end_us: 5_500_000,  // 0.5-5.5s, overlaps both speakers
        text: "spanning utterance",
      },
    ];

    const result = assignSpeakersToUtterances(spanning, MOCK_TURNS);

    // SPEAKER_00 overlap: 0.5-2.0s = 1.5s
    // SPEAKER_01 overlap: 2.5-5.5s = 3.0s
    // SPEAKER_01 should win
    expect(result[0].speaker).toBe("SPEAKER_01");
  });

  it("uses word-level timings when available", () => {
    const withWords: SttUtterance[] = [
      {
        speaker: "S1",
        start_us: 0,
        end_us: 5_000_000,
        text: "mixed speaker utterance",
        words: [
          // Words falling in SPEAKER_00 range (0-2s)
          { word: "word1", start_us: 100_000, end_us: 800_000 },
          { word: "word2", start_us: 900_000, end_us: 1_500_000 },
          // Words falling in SPEAKER_01 range (2.5-6s)
          { word: "word3", start_us: 3_000_000, end_us: 3_500_000 },
          { word: "word4", start_us: 3_600_000, end_us: 4_500_000 },
          { word: "word5", start_us: 4_600_000, end_us: 4_900_000 },
        ],
      },
    ];

    const result = assignSpeakersToUtterances(withWords, MOCK_TURNS);

    // SPEAKER_00: word1 (0.7s) + word2 (0.6s) = 1.3s
    // SPEAKER_01: word3 (0.5s) + word4 (0.9s) + word5 (0.3s) = 1.7s
    // SPEAKER_01 should win
    expect(result[0].speaker).toBe("SPEAKER_01");
  });

  it("keeps original speaker when utterance has no overlap with any turn", () => {
    const noOverlap: SttUtterance[] = [
      {
        speaker: "S1",
        start_us: 20_000_000,
        end_us: 25_000_000,
        text: "no overlap",
      },
    ];

    const result = assignSpeakersToUtterances(noOverlap, MOCK_TURNS);
    expect(result[0].speaker).toBe("S1");
  });

  it("handles single-speaker scenario (all turns from one speaker)", () => {
    const singleSpeakerTurns: DiarizeTurn[] = [
      { speaker_id: "SPEAKER_00", start_us: 0, end_us: 15_000_000 },
    ];

    const result = assignSpeakersToUtterances(MOCK_UTTERANCES, singleSpeakerTurns);

    expect(result.every((u) => u.speaker === "SPEAKER_00")).toBe(true);
  });
});

// ── Unit Tests: normalizeSpeakerLabels ──────────────────────────────

describe("Diarization: normalizeSpeakerLabels", () => {
  it("normalizes SPEAKER_XX labels to S1, S2, ... in order of appearance", () => {
    const utterances: SttUtterance[] = [
      { speaker: "SPEAKER_00", start_us: 0, end_us: 1_000_000, text: "a" },
      { speaker: "SPEAKER_01", start_us: 1_000_000, end_us: 2_000_000, text: "b" },
      { speaker: "SPEAKER_00", start_us: 2_000_000, end_us: 3_000_000, text: "c" },
      { speaker: "SPEAKER_01", start_us: 3_000_000, end_us: 4_000_000, text: "d" },
    ];

    const result = normalizeSpeakerLabels(utterances);

    expect(result[0].speaker).toBe("S1");
    expect(result[1].speaker).toBe("S2");
    expect(result[2].speaker).toBe("S1");
    expect(result[3].speaker).toBe("S2");
  });

  it("handles three speakers", () => {
    const utterances: SttUtterance[] = [
      { speaker: "SPEAKER_02", start_us: 0, end_us: 1_000_000, text: "a" },
      { speaker: "SPEAKER_00", start_us: 1_000_000, end_us: 2_000_000, text: "b" },
      { speaker: "SPEAKER_01", start_us: 2_000_000, end_us: 3_000_000, text: "c" },
    ];

    const result = normalizeSpeakerLabels(utterances);

    // Order of first appearance: SPEAKER_02 → S1, SPEAKER_00 → S2, SPEAKER_01 → S3
    expect(result[0].speaker).toBe("S1");
    expect(result[1].speaker).toBe("S2");
    expect(result[2].speaker).toBe("S3");
  });

  it("does not mutate original utterances", () => {
    const utterances: SttUtterance[] = [
      { speaker: "SPEAKER_00", start_us: 0, end_us: 1_000_000, text: "a" },
    ];

    normalizeSpeakerLabels(utterances);
    expect(utterances[0].speaker).toBe("SPEAKER_00");
  });

  it("handles already-normalized labels (S1, S2)", () => {
    const utterances: SttUtterance[] = [
      { speaker: "S1", start_us: 0, end_us: 1_000_000, text: "a" },
      { speaker: "S2", start_us: 1_000_000, end_us: 2_000_000, text: "b" },
    ];

    const result = normalizeSpeakerLabels(utterances);
    expect(result[0].speaker).toBe("S1");
    expect(result[1].speaker).toBe("S2");
  });

  it("returns empty array for empty input", () => {
    expect(normalizeSpeakerLabels([])).toEqual([]);
  });
});

// ── Integration Test: Mock Groq + Mock Pyannote ─────────────────────

describe("Diarization: end-to-end mock integration", () => {
  it("transforms all-S1 Groq output into multi-speaker transcript", () => {
    // Simulate: Groq returns all S1, pyannote provides speaker turns
    const groqUtterances: SttUtterance[] = [
      { speaker: "S1", start_us: 0, end_us: 2_000_000, text: "Question one?" },
      { speaker: "S1", start_us: 2_500_000, end_us: 5_000_000, text: "Answer to question one." },
      { speaker: "S1", start_us: 5_500_000, end_us: 7_000_000, text: "Question two?" },
      { speaker: "S1", start_us: 7_500_000, end_us: 10_000_000, text: "Answer to question two." },
    ];

    const pyannoteTurns: DiarizeTurn[] = [
      { speaker_id: "SPEAKER_00", start_us: 0, end_us: 2_200_000 },
      { speaker_id: "SPEAKER_01", start_us: 2_300_000, end_us: 5_200_000 },
      { speaker_id: "SPEAKER_00", start_us: 5_300_000, end_us: 7_200_000 },
      { speaker_id: "SPEAKER_01", start_us: 7_300_000, end_us: 10_200_000 },
    ];

    // Step 1: Assign speakers
    const withSpeakers = assignSpeakersToUtterances(groqUtterances, pyannoteTurns);

    // Step 2: Normalize labels
    const normalized = normalizeSpeakerLabels(withSpeakers);

    // Verify alternating speakers (interviewer/respondent pattern)
    expect(normalized[0].speaker).toBe("S1"); // SPEAKER_00 → S1 (interviewer)
    expect(normalized[1].speaker).toBe("S2"); // SPEAKER_01 → S2 (respondent)
    expect(normalized[2].speaker).toBe("S1"); // SPEAKER_00 → S1
    expect(normalized[3].speaker).toBe("S2"); // SPEAKER_01 → S2

    // Verify original text and timing preserved
    expect(normalized[0].text).toBe("Question one?");
    expect(normalized[0].start_us).toBe(0);
    expect(normalized[0].end_us).toBe(2_000_000);
  });

  it("handles Japanese interview content", () => {
    const withSpeakers = assignSpeakersToUtterances(MOCK_UTTERANCES, MOCK_TURNS);
    const normalized = normalizeSpeakerLabels(withSpeakers);

    // Verify speaker separation
    const speakers = new Set(normalized.map((u) => u.speaker));
    expect(speakers.size).toBe(2);

    // Verify Japanese text preserved
    expect(normalized[0].text).toBe("今日はお忙しいところありがとうございます。");
    expect(normalized[0].text).not.toMatch(/[a-zA-Z]/);
  });

  it("gracefully handles empty turns (pyannote unavailable)", () => {
    const result = assignSpeakersToUtterances(MOCK_UTTERANCES, []);

    // All speakers should remain S1 (original Groq output)
    expect(result.every((u) => u.speaker === "S1")).toBe(true);
    expect(result).toEqual(MOCK_UTTERANCES);
  });
});
