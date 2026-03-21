/**
 * OpenAI STT Connector — client-side chunking, diarized transcription,
 * chunk merge, speaker normalization, and transcript artifact generation.
 *
 * Per milestone-2-design.md §OpenAI STT Connector:
 * - Model: gpt-4o-transcribe-diarize
 * - Client-side audio chunking with silence-aware boundary splitting
 * - Chunk merge with 80% overlap duplicate removal
 * - Speaker label normalization (S1, S2, ...)
 * - Transcript artifact: TR_<asset_id>.json
 */

import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import {
  type TranscribeFn,
  type SttChunkResult,
  type SttUtterance,
  type SttPolicy,
  type TranscriptAlignmentThresholds,
  STT_CONNECTOR_VERSION,
} from "./stt-interface.js";
import { computeRequestHash, type AssetItem } from "./ffprobe.js";
import type { SegmentItem } from "./ffmpeg-segmenter.js";

// ── Types ──────────────────────────────────────────────────────────

/** A chunk boundary for client-side audio splitting. */
export interface ChunkBoundary {
  /** Chunk start in microseconds (asset-level) */
  start_us: number;
  /** Chunk end in microseconds (asset-level) */
  end_us: number;
  /** Index of this chunk (0-based) */
  index: number;
}

/** A merged, asset-level transcript item (post chunk-merge + normalization). */
export interface TranscriptItem {
  item_id: string;
  speaker: string;
  speaker_key: string;
  start_us: number;
  end_us: number;
  text: string;
  confidence?: number;
}

/** The full transcript artifact for one asset. */
export interface TranscriptArtifact {
  project_id: string;
  artifact_version: string;
  transcript_ref: string;
  asset_id: string;
  items: TranscriptItem[];
  language?: string;
  language_confidence?: number;
  analysis_status: string;
  word_timing_mode: string;
  provenance: {
    stage: string;
    method: string;
    connector_version: string;
    policy_hash: string;
    request_hash: string;
    model_alias: string;
    model_snapshot: string;
    response_format: string;
    chunking_strategy: string;
  };
}

/** Result from processing one asset through STT. */
export interface AssetSttResult {
  transcript: TranscriptArtifact;
  /** Whether the transcription completed successfully */
  success: boolean;
  /** Error message if failed */
  error?: string;
}

// ── Silence Detection ──────────────────────────────────────────────

/** A detected silence interval. */
export interface SilenceInterval {
  start_us: number;
  end_us: number;
}

/**
 * Detect silence intervals in an audio file using ffmpeg silencedetect.
 */
export async function detectSilence(
  audioPath: string,
  noiseDb: number,
  durationS: number,
): Promise<SilenceInterval[]> {
  return new Promise((resolve, reject) => {
    execFile(
      "ffmpeg",
      [
        "-i", audioPath,
        "-af", `silencedetect=noise=${noiseDb}dB:d=${durationS}`,
        "-f", "null",
        "-",
      ],
      { maxBuffer: 10 * 1024 * 1024 },
      (err, _stdout, stderr) => {
        // ffmpeg writes silencedetect output to stderr and exits 0
        if (err && !stderr) {
          reject(err);
          return;
        }
        const intervals: SilenceInterval[] = [];
        const regex = /silence_start:\s*([\d.]+)[\s\S]*?silence_end:\s*([\d.]+)/g;
        let match: RegExpExecArray | null;
        while ((match = regex.exec(stderr)) !== null) {
          intervals.push({
            start_us: Math.round(parseFloat(match[1]) * 1_000_000),
            end_us: Math.round(parseFloat(match[2]) * 1_000_000),
          });
        }
        resolve(intervals);
      },
    );
  });
}

// ── Audio Extraction ───────────────────────────────────────────────

/**
 * Extract mono 16kHz PCM WAV from a source file using ffmpeg.
 * Returns path to the extracted WAV file.
 */
export async function extractAudioProxy(
  sourceFile: string,
  outputDir: string,
  assetId: string,
): Promise<string> {
  const wavPath = path.join(outputDir, `${assetId}_proxy.wav`);
  return new Promise((resolve, reject) => {
    execFile(
      "ffmpeg",
      [
        "-y",
        "-i", sourceFile,
        "-ac", "1",
        "-ar", "16000",
        "-f", "wav",
        wavPath,
      ],
      { maxBuffer: 10 * 1024 * 1024 },
      (err) => {
        if (err) reject(err);
        else resolve(wavPath);
      },
    );
  });
}

/**
 * Extract a chunk from a WAV file as a separate WAV file.
 */
export async function extractChunkWav(
  wavPath: string,
  outputDir: string,
  assetId: string,
  chunk: ChunkBoundary,
): Promise<string> {
  const chunkPath = path.join(outputDir, `${assetId}_chunk_${String(chunk.index).padStart(4, "0")}.wav`);
  const startSec = chunk.start_us / 1_000_000;
  const durationSec = (chunk.end_us - chunk.start_us) / 1_000_000;
  return new Promise((resolve, reject) => {
    execFile(
      "ffmpeg",
      [
        "-y",
        "-i", wavPath,
        "-ss", String(startSec),
        "-t", String(durationSec),
        "-c", "copy",
        chunkPath,
      ],
      { maxBuffer: 10 * 1024 * 1024 },
      (err) => {
        if (err) reject(err);
        else resolve(chunkPath);
      },
    );
  });
}

// ── Chunking Logic ─────────────────────────────────────────────────

/**
 * Compute chunk boundaries for an audio asset.
 *
 * Strategy per design doc:
 * 1. Try silence-aware splitting at chunk_target_us boundaries
 * 2. If no silence found before chunk_max_us, hard-cut at chunk_target_us
 * 3. Apply overlap between chunks
 */
export function computeChunkBoundaries(
  durationUs: number,
  silenceIntervals: SilenceInterval[],
  policy: Pick<SttPolicy, "chunk_target_us" | "chunk_max_us" | "chunk_overlap_us" | "chunk_boundary_silence_us">,
): ChunkBoundary[] {
  const { chunk_target_us, chunk_max_us, chunk_overlap_us } = policy;

  // Short audio: single chunk
  if (durationUs <= chunk_max_us) {
    return [{ start_us: 0, end_us: durationUs, index: 0 }];
  }

  const chunks: ChunkBoundary[] = [];
  let pos = 0;
  let index = 0;

  while (pos < durationUs) {
    const remaining = durationUs - pos;
    if (remaining <= chunk_max_us) {
      chunks.push({ start_us: pos, end_us: durationUs, index });
      break;
    }

    // Look for a silence boundary near chunk_target_us
    const targetEnd = pos + chunk_target_us;
    const maxEnd = pos + chunk_max_us;

    let bestSilenceMid: number | null = null;
    let bestDist = Infinity;

    // Search for silence in the range [target * 0.8, max] relative to chunk start
    const searchStart = pos + Math.round(chunk_target_us * 0.8);
    for (const silence of silenceIntervals) {
      const silenceMid = Math.round((silence.start_us + silence.end_us) / 2);
      if (silenceMid >= searchStart && silenceMid <= maxEnd) {
        const dist = Math.abs(silenceMid - targetEnd);
        if (dist < bestDist) {
          bestDist = dist;
          bestSilenceMid = silenceMid;
        }
      }
    }

    let chunkEnd: number;
    if (bestSilenceMid !== null) {
      chunkEnd = Math.round(bestSilenceMid);
    } else {
      // Hard-cut at target
      chunkEnd = targetEnd;
    }

    // Ensure we don't exceed duration
    chunkEnd = Math.min(chunkEnd, durationUs);

    chunks.push({ start_us: pos, end_us: chunkEnd, index });

    // Next chunk starts with overlap
    pos = Math.max(0, chunkEnd - chunk_overlap_us);
    index++;
  }

  return chunks;
}

// ── Chunk Merge ────────────────────────────────────────────────────

/** An utterance with asset-level timestamps (post chunk-offset adjustment). */
export interface MergedUtterance {
  speaker_raw: string;
  start_us: number;
  end_us: number;
  text: string;
  confidence?: number;
  /** Which chunk this came from */
  chunk_index: number;
}

/** Result from mergeChunkResults including cross-chunk speaker identity map. */
export interface MergeResult {
  merged: MergedUtterance[];
  /** Maps "chunk_index:speaker_raw" → canonical representative key for cross-chunk identity. */
  crossChunkSpeakerMap: Map<string, string>;
}

/**
 * Normalize text for duplicate comparison: lowercase, collapse whitespace, trim.
 */
export function normalizeText(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * Check if two utterances are duplicates per design doc rules:
 * - Normalized text matches
 * - Temporal overlap is at least 80%
 */
export function isDuplicate(a: MergedUtterance, b: MergedUtterance): boolean {
  if (normalizeText(a.text) !== normalizeText(b.text)) return false;

  const overlapStart = Math.max(a.start_us, b.start_us);
  const overlapEnd = Math.min(a.end_us, b.end_us);
  const overlapDuration = Math.max(0, overlapEnd - overlapStart);

  const aDuration = a.end_us - a.start_us;
  const bDuration = b.end_us - b.start_us;
  const minDuration = Math.min(aDuration, bDuration);

  if (minDuration === 0) return overlapDuration === 0;
  return overlapDuration / minDuration >= 0.8;
}

/**
 * Build a cross-chunk speaker identity map from overlap duplicate pairs.
 *
 * Per design doc §Speaker Label Normalization:
 * "overlap duplicates across adjacent chunks anchor speaker identity
 *  when the same utterance appears twice"
 *
 * Uses Union-Find to build equivalence classes of (chunk_index, speaker_raw) tuples.
 */
export function buildCrossChunkSpeakerMap(
  allUtterances: MergedUtterance[],
): Map<string, string> {
  // Collect cross-chunk duplicate pairs
  const equivalences: Array<[string, string]> = [];

  for (let i = 0; i < allUtterances.length; i++) {
    for (let j = i + 1; j < allUtterances.length; j++) {
      const a = allUtterances[i];
      const b = allUtterances[j];
      if (a.chunk_index === b.chunk_index) continue;
      if (!isDuplicate(a, b)) continue;

      const keyA = `${a.chunk_index}:${a.speaker_raw}`;
      const keyB = `${b.chunk_index}:${b.speaker_raw}`;
      if (keyA !== keyB) {
        equivalences.push([keyA, keyB]);
      }
    }
  }

  if (equivalences.length === 0) {
    return new Map();
  }

  // Union-Find with path compression
  const parent = new Map<string, string>();

  function find(x: string): string {
    if (!parent.has(x)) parent.set(x, x);
    let root = x;
    while (parent.get(root) !== root) {
      root = parent.get(root)!;
    }
    // Path compression
    let curr = x;
    while (curr !== root) {
      const next = parent.get(curr)!;
      parent.set(curr, root);
      curr = next;
    }
    return root;
  }

  function union(a: string, b: string): void {
    const rootA = find(a);
    const rootB = find(b);
    if (rootA !== rootB) {
      // Prefer the root with the lower chunk index for deterministic ordering
      const chunkA = parseInt(rootA.split(":")[0], 10);
      const chunkB = parseInt(rootB.split(":")[0], 10);
      if (chunkA <= chunkB) {
        parent.set(rootB, rootA);
      } else {
        parent.set(rootA, rootB);
      }
    }
  }

  for (const [a, b] of equivalences) {
    union(a, b);
  }

  // Build final map: each key → its canonical representative
  const result = new Map<string, string>();
  for (const key of parent.keys()) {
    result.set(key, find(key));
  }
  return result;
}

/**
 * Merge chunk results into a single list of asset-level utterances.
 *
 * Per design doc §Chunk Merge Rules:
 * 1. Convert chunk-relative times to asset-level
 * 2. Stable-sort by start_us, end_us, normalized text
 * 3. Remove duplicates (80% temporal overlap + matching text)
 * 4. Keep earliest duplicate
 *
 * Also builds a cross-chunk speaker identity map from overlap duplicate pairs.
 */
export function mergeChunkResults(
  chunkResults: Array<{ chunk: ChunkBoundary; result: SttChunkResult }>,
): MergeResult {
  // 1. Convert to asset-level timestamps
  const allUtterances: MergedUtterance[] = [];
  for (const { chunk, result } of chunkResults) {
    for (const utt of result.utterances) {
      allUtterances.push({
        speaker_raw: utt.speaker,
        start_us: utt.start_us + chunk.start_us,
        end_us: utt.end_us + chunk.start_us,
        text: utt.text,
        confidence: utt.confidence,
        chunk_index: chunk.index,
      });
    }
  }

  // 2. Stable-sort by start_us, end_us, normalized text
  allUtterances.sort((a, b) => {
    if (a.start_us !== b.start_us) return a.start_us - b.start_us;
    if (a.end_us !== b.end_us) return a.end_us - b.end_us;
    return normalizeText(a.text).localeCompare(normalizeText(b.text));
  });

  // Build cross-chunk speaker identity map BEFORE dedup
  const crossChunkSpeakerMap = buildCrossChunkSpeakerMap(allUtterances);

  // 3+4. Remove duplicates, keeping the earliest (first encountered)
  const merged: MergedUtterance[] = [];
  for (const utt of allUtterances) {
    const isDup = merged.some((existing) => isDuplicate(existing, utt));
    if (!isDup) {
      merged.push(utt);
    }
  }

  return { merged, crossChunkSpeakerMap };
}

// ── Speaker Normalization ──────────────────────────────────────────

/**
 * Normalize provider speaker labels to canonical S1, S2, ... labels.
 *
 * Per design doc §Speaker Label Normalization:
 * - First speaker encountered becomes S1, next distinct becomes S2, etc.
 * - Order follows merged sort order
 * - Overlap duplicates across adjacent chunks anchor speaker identity
 * - If a new chunk speaker cannot be matched through overlap anchoring,
 *   it receives the next canonical speaker id
 */
export function normalizeSpeakers(
  utterances: MergedUtterance[],
  assetId: string,
  crossChunkSpeakerMap?: Map<string, string>,
): Array<{ speaker: string; speaker_key: string; raw: string }> {
  const speakerMap = new Map<string, number>();
  let nextId = 1;

  return utterances.map((utt) => {
    // Resolve to canonical identity using cross-chunk map
    let identityKey: string;
    if (crossChunkSpeakerMap && crossChunkSpeakerMap.size > 0) {
      const key = `${utt.chunk_index}:${utt.speaker_raw}`;
      identityKey = crossChunkSpeakerMap.get(key) ?? key;
    } else {
      identityKey = utt.speaker_raw;
    }

    let canonId = speakerMap.get(identityKey);
    if (canonId === undefined) {
      canonId = nextId++;
      speakerMap.set(identityKey, canonId);
    }
    return {
      speaker: `S${canonId}`,
      speaker_key: `${assetId}:speaker_${canonId}`,
      raw: utt.speaker_raw,
    };
  });
}

// ── Transcript Artifact Builder ────────────────────────────────────

/**
 * Build a transcript artifact from merged utterances.
 */
export function buildTranscriptArtifact(
  mergedUtterances: MergedUtterance[],
  assetId: string,
  projectId: string,
  language: string | undefined,
  languageConfidence: number | undefined,
  sttPolicy: SttPolicy,
  policyHash: string,
  crossChunkSpeakerMap?: Map<string, string>,
): TranscriptArtifact {
  const speakers = normalizeSpeakers(mergedUtterances, assetId, crossChunkSpeakerMap);
  const transcriptRef = `TR_${assetId}`;

  const items: TranscriptItem[] = mergedUtterances.map((utt, i) => {
    const ordinal = String(i + 1).padStart(4, "0");
    return {
      item_id: `TRI_${assetId}_${ordinal}`,
      speaker: speakers[i].speaker,
      speaker_key: speakers[i].speaker_key,
      start_us: utt.start_us,
      end_us: utt.end_us,
      text: utt.text,
      ...(utt.confidence !== undefined ? { confidence: utt.confidence } : {}),
    };
  });

  const requestHash = computeRequestHash({
    connector_version: STT_CONNECTOR_VERSION,
    model_alias: sttPolicy.model_alias,
    model_snapshot: sttPolicy.model_snapshot,
    response_format: sttPolicy.response_format,
    chunking_strategy: sttPolicy.chunking_strategy,
  });

  return {
    project_id: projectId,
    artifact_version: "2.0.0",
    transcript_ref: transcriptRef,
    asset_id: assetId,
    items,
    ...(language ? { language } : {}),
    ...(languageConfidence !== undefined ? { language_confidence: languageConfidence } : {}),
    analysis_status: items.length > 0 ? "ready" : "failed",
    word_timing_mode: sttPolicy.generate_words ? "word" : "none",
    provenance: {
      stage: "stt",
      method: "openai_transcribe_diarize",
      connector_version: STT_CONNECTOR_VERSION,
      policy_hash: policyHash,
      request_hash: requestHash,
      model_alias: sttPolicy.model_alias,
      model_snapshot: sttPolicy.model_snapshot,
      response_format: sttPolicy.response_format,
      chunking_strategy: sttPolicy.chunking_strategy,
    },
  };
}

// ── Transcript Excerpt Alignment ───────────────────────────────────

/**
 * Compute transcript_excerpt for a segment from the transcript items.
 *
 * Per design doc §Transcript Alignment:
 * - Include items whose overlap with the segment is at least 250ms or 25% of item duration
 * - Concatenate overlapping text in source order
 * - No speaker labels in excerpt (plain text)
 */
export function computeTranscriptExcerpt(
  segmentInUs: number,
  segmentOutUs: number,
  transcriptItems: TranscriptItem[],
  thresholds: TranscriptAlignmentThresholds,
): string {
  const excerptParts: string[] = [];

  for (const item of transcriptItems) {
    const overlapStart = Math.max(item.start_us, segmentInUs);
    const overlapEnd = Math.min(item.end_us, segmentOutUs);
    const overlapDuration = Math.max(0, overlapEnd - overlapStart);

    if (overlapDuration <= 0) continue;

    const itemDuration = item.end_us - item.start_us;
    const fractionOverlap = itemDuration > 0 ? overlapDuration / itemDuration : 0;

    if (
      overlapDuration >= thresholds.transcript_overlap_min_us ||
      fractionOverlap >= thresholds.transcript_overlap_fraction_min
    ) {
      excerptParts.push(item.text);
    }
  }

  return excerptParts.join(" ");
}

// ── Default OpenAI TranscribeFn ────────────────────────────────────

/**
 * Create the real OpenAI transcription function.
 * Requires OPENAI_API_KEY environment variable.
 *
 * NOTE: This is NOT used in tests — tests inject a mock TranscribeFn.
 */
export function createOpenAiTranscribeFn(): TranscribeFn {
  return async (audioPath, options) => {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error("OPENAI_API_KEY environment variable is required");
    }

    // Use dynamic import + fetch for the multipart upload
    const audioData = fs.readFileSync(audioPath);
    const formData = new FormData();
    formData.append("file", new Blob([audioData], { type: "audio/wav" }), path.basename(audioPath));
    formData.append("model", options.model);
    formData.append("response_format", options.response_format);
    if (options.language) {
      formData.append("language", options.language);
    }

    const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
      body: formData,
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`OpenAI API error ${response.status}: ${body}`);
    }

    const data = await response.json() as {
      text?: string;
      language?: string;
      segments?: Array<{
        speaker?: string;
        start: number;
        end: number;
        text: string;
      }>;
      words?: Array<{
        word: string;
        start: number;
        end: number;
      }>;
    };

    // Parse diarized response into utterances
    const utterances: SttUtterance[] = (data.segments ?? []).map((seg) => ({
      speaker: seg.speaker ?? "speaker_0",
      start_us: Math.round(seg.start * 1_000_000),
      end_us: Math.round(seg.end * 1_000_000),
      text: seg.text,
    }));

    return {
      utterances,
      language: data.language,
    };
  };
}

// ── Main STT Processing Function ───────────────────────────────────

export interface ProcessAssetSttOptions {
  /** Source file path for audio extraction */
  sourceFile: string;
  /** The asset to transcribe */
  asset: AssetItem;
  /** Project ID for artifact naming */
  projectId: string;
  /** Output directory (03_analysis/) */
  outputDir: string;
  /** Resolved STT policy */
  sttPolicy: SttPolicy;
  /** Policy hash for provenance */
  policyHash: string;
  /** Transcript alignment thresholds */
  alignmentThresholds: TranscriptAlignmentThresholds;
  /** The transcription function (injectable for testing) */
  transcribeFn: TranscribeFn;
}

/**
 * Process a single asset through the STT pipeline:
 * 1. Extract mono 16kHz WAV proxy
 * 2. Compute chunk boundaries (silence-aware)
 * 3. Extract chunk WAVs + call transcribeFn per chunk
 * 4. Merge chunks, normalize speakers
 * 5. Build and write transcript artifact
 */
export async function processAssetStt(
  opts: ProcessAssetSttOptions,
): Promise<AssetSttResult> {
  const { asset, projectId, outputDir, sttPolicy, policyHash, transcribeFn } = opts;

  // Temp dir for audio chunks
  const tmpDir = path.join(outputDir, "_stt_tmp", asset.asset_id);
  fs.mkdirSync(tmpDir, { recursive: true });

  try {
    // 1. Extract audio proxy
    const wavPath = await extractAudioProxy(opts.sourceFile, tmpDir, asset.asset_id);

    // 2. Detect silence for chunk boundary selection
    const silenceIntervals = await detectSilence(
      wavPath,
      -35, // noise dB threshold
      sttPolicy.chunk_boundary_silence_us / 1_000_000,
    );

    // 3. Compute chunk boundaries
    const chunks = computeChunkBoundaries(
      asset.duration_us,
      silenceIntervals,
      sttPolicy,
    );

    // 4. Transcribe each chunk
    const chunkResults: Array<{ chunk: ChunkBoundary; result: SttChunkResult }> = [];
    let language: string | undefined;
    let languageConfidence: number | undefined;

    for (const chunk of chunks) {
      // Extract chunk WAV (or use full WAV if single chunk)
      const chunkWavPath = chunks.length === 1
        ? wavPath
        : await extractChunkWav(wavPath, tmpDir, asset.asset_id, chunk);

      const result = await transcribeFn(chunkWavPath, {
        model: sttPolicy.model_alias,
        response_format: sttPolicy.response_format,
      });

      chunkResults.push({ chunk, result });

      // Use first chunk's language detection
      if (!language && result.language) {
        language = result.language;
        languageConfidence = result.language_confidence;
      }
    }

    // 5. Merge chunks (returns merged utterances + cross-chunk speaker identity map)
    const { merged, crossChunkSpeakerMap } = mergeChunkResults(chunkResults);

    // 6. Build transcript artifact (with cross-chunk speaker anchoring)
    const transcript = buildTranscriptArtifact(
      merged,
      asset.asset_id,
      projectId,
      language,
      languageConfidence,
      sttPolicy,
      policyHash,
      crossChunkSpeakerMap,
    );

    // Return transcript data — file writing is handled by sttReduce
    return { transcript, success: true };
  } catch (err) {
    // Build a failed transcript artifact for gap tracking
    const transcript = buildTranscriptArtifact(
      [],
      asset.asset_id,
      projectId,
      undefined,
      undefined,
      sttPolicy,
      policyHash,
    );
    transcript.analysis_status = "failed";

    return {
      transcript,
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    // Clean up temp directory
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  }
}
