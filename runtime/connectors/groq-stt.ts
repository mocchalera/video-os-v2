/**
 * Groq Whisper STT Connector — speech-to-text via Groq's OpenAI-compatible API.
 *
 * Uses whisper-large-v3-turbo model with verbose_json response format.
 * Groq Whisper provides superior Japanese native text output (kanji/kana)
 * compared to OpenAI's gpt-4o-transcribe-diarize which often produces
 * romaji-mixed output for Japanese content.
 *
 * Key differences from OpenAI connector:
 * - No diarization (Groq Whisper doesn't support it) — all utterances use speaker 'S1'
 * - response_format: verbose_json (with word-level timestamps)
 * - timestamp_granularities: [word, segment]
 * - Endpoint: https://api.groq.com/openai/v1/audio/transcriptions
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type {
  TranscribeFn,
  SttChunkResult,
  SttUtterance,
  SttWord,
} from "./stt-interface.js";
import type { DiarizeTurn } from "./pyannote-diarizer.js";

// ── Groq Response Types ─────────────────────────────────────────────

/** A word-level entry from Groq's verbose_json response. */
export interface GroqWord {
  word: string;
  start: number;
  end: number;
}

/** A segment-level entry from Groq's verbose_json response. */
export interface GroqSegment {
  id: number;
  start: number;
  end: number;
  text: string;
  words?: GroqWord[];
}

/** Groq verbose_json response shape. */
export interface GroqVerboseJsonResponse {
  text: string;
  language?: string;
  segments?: GroqSegment[];
  words?: GroqWord[];
}

// ── Connector Version ───────────────────────────────────────────────

export const GROQ_STT_CONNECTOR_VERSION = "groq-stt-v1.0.0";

// ── Response Parsing ────────────────────────────────────────────────

/**
 * Convert Groq verbose_json words into SttWord entries.
 */
export function parseGroqWords(words: GroqWord[]): SttWord[] {
  return words
    .filter((w) => w.word.trim().length > 0 && w.end > w.start)
    .map((w) => ({
      word: w.word.trim(),
      start_us: Math.round(w.start * 1_000_000),
      end_us: Math.round(w.end * 1_000_000),
    }));
}

/**
 * Convert Groq verbose_json segments into SttUtterance entries.
 *
 * Groq Whisper has no diarization — all utterances are assigned speaker 'S1'.
 * If segments have word-level data, those are included as SttWord arrays.
 */
export function parseGroqSegments(
  segments: GroqSegment[],
): SttUtterance[] {
  return segments
    .filter((seg) => seg.text.trim().length > 0)
    .map((seg) => {
      const utterance: SttUtterance = {
        speaker: "S1",
        start_us: Math.round(seg.start * 1_000_000),
        end_us: Math.round(seg.end * 1_000_000),
        text: seg.text.trim(),
      };

      if (seg.words && seg.words.length > 0) {
        utterance.words = parseGroqWords(seg.words);
      }

      return utterance;
    });
}

/**
 * Parse a complete Groq verbose_json response into SttChunkResult.
 *
 * Handles two fallback paths:
 * 1. Primary: use segments[] with embedded words[]
 * 2. Fallback: if no segments, build utterances from top-level words[]
 */
export function parseGroqResponse(
  data: GroqVerboseJsonResponse,
): SttChunkResult {
  let utterances: SttUtterance[];

  if (data.segments && data.segments.length > 0) {
    // Primary path: use segments
    utterances = parseGroqSegments(data.segments);
  } else if (data.words && data.words.length > 0) {
    // Fallback: build a single utterance from top-level words
    const words = parseGroqWords(data.words);
    if (words.length > 0) {
      utterances = [{
        speaker: "S1",
        start_us: words[0].start_us,
        end_us: words[words.length - 1].end_us,
        text: data.text.trim(),
        words,
      }];
    } else {
      utterances = [];
    }
  } else if (data.text && data.text.trim().length > 0) {
    // Last resort: text only, no timestamps
    utterances = [{
      speaker: "S1",
      start_us: 0,
      end_us: 0,
      text: data.text.trim(),
    }];
  } else {
    utterances = [];
  }

  return {
    utterances,
    language: data.language,
  };
}

// ── Speaker Assignment (Groq + pyannote merge) ─────────────────────

/**
 * Compute overlap duration between two time ranges (in microseconds).
 */
export function overlapDuration(
  aStart: number, aEnd: number,
  bStart: number, bEnd: number,
): number {
  const start = Math.max(aStart, bStart);
  const end = Math.min(aEnd, bEnd);
  return Math.max(0, end - start);
}

/**
 * Assign speaker labels from pyannote DiarizeTurns to Groq STT utterances.
 *
 * Port of _assign_speakers_to_transcript_segments from the old video-edit-agent repo.
 *
 * For each utterance:
 * 1. If word-level timings are available, compute per-word overlap with speaker turns
 * 2. Otherwise, use utterance-level time range
 * 3. The speaker with the most overlap time wins
 * 4. If the dominant speaker has ≥ dominantThreshold share, assign that speaker
 * 5. Otherwise, assign the speaker with the most overlap (no threshold gate)
 *
 * Returns new utterances with updated speaker labels. Original utterances are not mutated.
 */
export function assignSpeakersToUtterances(
  utterances: SttUtterance[],
  turns: DiarizeTurn[],
  options: { dominantThreshold?: number } = {},
): SttUtterance[] {
  if (turns.length === 0) {
    return utterances;
  }

  const threshold = options.dominantThreshold ?? 0.70;

  return utterances.map((utt) => {
    // Determine time slices to check — prefer word-level granularity
    const slices: Array<{ start_us: number; end_us: number }> =
      utt.words && utt.words.length > 0
        ? utt.words
        : [{ start_us: utt.start_us, end_us: utt.end_us }];

    // Accumulate overlap duration per speaker
    const speakerDurations = new Map<string, number>();

    for (const slice of slices) {
      if (slice.end_us <= slice.start_us) continue;

      let bestOverlap = 0;
      let bestSpeaker: string | null = null;

      for (const turn of turns) {
        const overlap = overlapDuration(
          slice.start_us, slice.end_us,
          turn.start_us, turn.end_us,
        );
        if (overlap > bestOverlap) {
          bestOverlap = overlap;
          bestSpeaker = turn.speaker_id;
        }
      }

      if (bestSpeaker && bestOverlap > 0) {
        speakerDurations.set(
          bestSpeaker,
          (speakerDurations.get(bestSpeaker) ?? 0) + bestOverlap,
        );
      }
    }

    // Find dominant speaker
    const totalDuration = Array.from(speakerDurations.values()).reduce((a, b) => a + b, 0);
    if (totalDuration === 0) {
      return utt; // No overlap — keep original speaker
    }

    let dominantSpeaker = "";
    let dominantDuration = 0;
    for (const [spk, dur] of speakerDurations) {
      if (dur > dominantDuration) {
        dominantDuration = dur;
        dominantSpeaker = spk;
      }
    }

    const dominantShare = dominantDuration / totalDuration;

    // Normalize speaker label: SPEAKER_00 → S1, SPEAKER_01 → S2, etc.
    const assignedSpeaker = dominantShare >= threshold || speakerDurations.size === 1
      ? dominantSpeaker
      : dominantSpeaker; // Always assign best match, threshold only affects confidence

    return { ...utt, speaker: assignedSpeaker };
  });
}

/**
 * Normalize pyannote speaker labels to sequential S1, S2, S3... format.
 * Returns a new array of utterances with normalized speaker labels.
 */
export function normalizeSpeakerLabels(utterances: SttUtterance[]): SttUtterance[] {
  const labelMap = new Map<string, string>();
  let nextIndex = 1;

  return utterances.map((utt) => {
    if (!labelMap.has(utt.speaker)) {
      labelMap.set(utt.speaker, `S${nextIndex++}`);
    }
    return { ...utt, speaker: labelMap.get(utt.speaker)! };
  });
}

// ── Factory ─────────────────────────────────────────────────────────

/**
 * Create a Groq Whisper TranscribeFn.
 * Requires GROQ_API_KEY environment variable.
 *
 * Sends audio to Groq's OpenAI-compatible transcription endpoint
 * with verbose_json format and word+segment timestamp granularities.
 */
export function createGroqTranscribeFn(): TranscribeFn {
  return async (audioPath, options) => {
    const apiKey = process.env.GROQ_API_KEY;
    if (!apiKey) {
      throw new Error("GROQ_API_KEY environment variable is required");
    }

    const audioData = fs.readFileSync(audioPath);
    const formData = new FormData();
    formData.append(
      "file",
      new Blob([audioData], { type: "audio/wav" }),
      path.basename(audioPath),
    );
    formData.append("model", options.model);
    formData.append("response_format", "verbose_json");
    if (options.language) {
      formData.append("language", options.language);
    }
    // Request both word and segment level timestamps
    formData.append("timestamp_granularities[]", "word");
    formData.append("timestamp_granularities[]", "segment");

    const response = await fetch(
      "https://api.groq.com/openai/v1/audio/transcriptions",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
        },
        body: formData,
      },
    );

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Groq API error ${response.status}: ${body}`);
    }

    const data = (await response.json()) as GroqVerboseJsonResponse;
    return parseGroqResponse(data);
  };
}
