/**
 * STT Provider Interface — provider-agnostic types for speech-to-text connectors.
 *
 * Per milestone-2-design.md §STT Provider Migration Path:
 * M2 uses OpenAI gpt-4o-transcribe-diarize; future migration to Groq Whisper + pyannote
 * requires only implementing this interface, not changing downstream artifact shapes.
 */

// ── Transcript Result Types ─────────────────────────────────────────

/** A single diarized utterance from the STT provider. */
export interface SttUtterance {
  /** Provider-local speaker label (e.g. "speaker_0", "SPEAKER_00") */
  speaker: string;
  /** Start time in microseconds, relative to the audio chunk */
  start_us: number;
  /** End time in microseconds, relative to the audio chunk */
  end_us: number;
  /** Transcribed text */
  text: string;
  /** Per-utterance confidence score (0–1), if available */
  confidence?: number;
  /** Optional word-level timings */
  words?: SttWord[];
}

/** A word-level timing entry. */
export interface SttWord {
  word: string;
  start_us: number;
  end_us: number;
  confidence?: number;
}

/** Result from a single STT provider call (one audio chunk). */
export interface SttChunkResult {
  utterances: SttUtterance[];
  /** Detected language code (e.g. "en", "ja") */
  language?: string;
  /** Language detection confidence (0–1) */
  language_confidence?: number;
  /** Provider request ID for provenance tracking */
  provider_request_id?: string;
}

// ── Transcribe Function Signature ───────────────────────────────────

/** Options passed to the transcribe function. */
export interface TranscribeOptions {
  /** Model alias from analysis_policy.stt */
  model: string;
  /** Response format from analysis_policy.stt */
  response_format: string;
  /** Language hint (optional) */
  language?: string;
}

/**
 * Provider-agnostic transcription function signature.
 * Accepts a WAV audio file path and returns diarized utterances.
 *
 * Implementations:
 * - OpenAI: POST /v1/audio/transcriptions with gpt-4o-transcribe-diarize
 * - Future: Groq Whisper + pyannote (ASR + diarization reconciliation)
 */
export type TranscribeFn = (
  audioPath: string,
  options: TranscribeOptions,
) => Promise<SttChunkResult>;

// ── STT Policy Types ────────────────────────────────────────────────

/** STT-related fields from the resolved analysis policy. */
export interface SttPolicy {
  model_alias: string;
  model_snapshot: string;
  endpoint: string;
  response_format: string;
  /** ISO-639-1 language hint (e.g. "ja", "en"). Improves accuracy for non-English. */
  language?: string | null;
  chunk_target_us: number;
  chunk_max_us: number;
  chunk_overlap_us: number;
  chunk_boundary_silence_us: number;
  chunking_strategy: string;
  speaker_normalization: string;
  generate_words: boolean;
}

/** Quality thresholds relevant to transcript alignment. */
export interface TranscriptAlignmentThresholds {
  transcript_overlap_min_us: number;
  transcript_overlap_fraction_min: number;
}

// ── Connector Version ───────────────────────────────────────────────

export const STT_CONNECTOR_VERSION = "openai-stt-v2.0.0";
