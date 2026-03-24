/**
 * Stage 7–8: Speech-to-text (STT) + optional speaker diarization.
 *
 * resolveTranscribeFn — select STT provider based on policy/env.
 * sttMap              — per-asset audio extraction + STT API call + diarization.
 * sttReduce           — write transcript files + update assets/segments.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { AssetItem } from "../../connectors/ffprobe.js";
import type { SegmentItem } from "../../connectors/ffmpeg-segmenter.js";
import {
  processAssetStt,
  computeTranscriptExcerpt,
  createOpenAiTranscribeFn,
  extractAudioProxy,
  type AssetSttResult,
} from "../../connectors/openai-stt.js";
import {
  createGroqTranscribeFn,
  assignSpeakersToUtterances,
  normalizeSpeakerLabels,
} from "../../connectors/groq-stt.js";
import {
  diarizeAsset,
  type DiarizeTurn,
  type DiarizeOptions,
} from "../../connectors/pyannote-diarizer.js";
import type {
  TranscribeFn,
  SttPolicy,
  TranscriptAlignmentThresholds,
} from "../../connectors/stt-interface.js";
import { atomicWriteJson } from "./_util.js";
import type { AssetsJson, SegmentsJson, GapEntry } from "../pipeline-types.js";

/**
 * Resolve which STT provider to use based on:
 * 1. Explicit provider override from CLI
 * 2. Model alias in analysis policy
 * 3. Available API keys (GROQ_API_KEY → Groq, OPENAI_API_KEY → OpenAI)
 */
export function resolveTranscribeFn(
  sttPolicy: SttPolicy,
  providerOverride?: string,
): { transcribeFn: TranscribeFn; providerName: string } {
  // Explicit override takes priority
  if (providerOverride === "groq") {
    return { transcribeFn: createGroqTranscribeFn(), providerName: "groq-whisper" };
  }
  if (providerOverride === "openai") {
    return { transcribeFn: createOpenAiTranscribeFn(), providerName: "openai" };
  }

  // Infer from model_alias
  const model = sttPolicy.model_alias;
  if (model.startsWith("whisper-large-v3")) {
    return { transcribeFn: createGroqTranscribeFn(), providerName: "groq-whisper" };
  }
  if (model.startsWith("gpt-4o-transcribe")) {
    return { transcribeFn: createOpenAiTranscribeFn(), providerName: "openai" };
  }

  // Fallback: check available API keys
  if (process.env.GROQ_API_KEY) {
    return { transcribeFn: createGroqTranscribeFn(), providerName: "groq-whisper" };
  }
  return { transcribeFn: createOpenAiTranscribeFn(), providerName: "openai" };
}

/**
 * Stage 7: stt.map — per-asset audio extraction + STT API call + optional diarization.
 *
 * When diarization is enabled (skipDiarize=false) and the STT provider is Groq:
 * 1. processAssetStt runs Groq Whisper (all segments labeled S1)
 * 2. pyannote bridge runs on the same audio proxy → speaker turns
 * 3. Speaker turns are merged with STT utterances via time-overlap matching
 * 4. Labels are normalized to S1, S2, S3... in order of first appearance
 */
export async function sttMap(
  sourceFileMap: Map<string, string>,
  assets: AssetItem[],
  projectId: string,
  outputDir: string,
  sttPolicy: SttPolicy,
  alignmentThresholds: TranscriptAlignmentThresholds,
  policyHash: string,
  transcribeFn: TranscribeFn,
  diarizeOpts?: {
    skipDiarize: boolean;
    providerName: string;
    diarizeFn?: (audioPath: string, options?: DiarizeOptions) => Promise<DiarizeTurn[]>;
    gapEntries: GapEntry[];
  },
): Promise<Map<string, AssetSttResult>> {
  const results = new Map<string, AssetSttResult>();

  for (const asset of assets) {
    // Skip assets without audio
    if (!asset.audio_stream) {
      continue;
    }

    const sourceFile = sourceFileMap.get(asset.asset_id);
    if (!sourceFile) {
      console.error(`[stt.map] No source file for ${asset.asset_id}`);
      continue;
    }

    const result = await processAssetStt({
      sourceFile,
      asset,
      projectId,
      outputDir,
      sttPolicy,
      policyHash,
      alignmentThresholds,
      transcribeFn,
    });

    // Diarization sub-stage: merge pyannote speaker turns with Groq STT output
    if (
      result.success &&
      result.transcript.items.length > 0 &&
      diarizeOpts &&
      !diarizeOpts.skipDiarize &&
      diarizeOpts.providerName === "groq-whisper"
    ) {
      try {
        // Extract a separate audio proxy for diarization
        // (processAssetStt cleans up its own tmp dir in a finally block)
        const diaTmpDir = path.join(outputDir, "_diarize_tmp", asset.asset_id);
        fs.mkdirSync(diaTmpDir, { recursive: true });

        console.log(`[diarize] Extracting audio proxy for ${asset.asset_id}...`);
        const wavPath = await extractAudioProxy(sourceFile, diaTmpDir, asset.asset_id);

        {
          console.log(`[diarize] Running pyannote on ${asset.asset_id}...`);

          const diaFn = diarizeOpts.diarizeFn ?? diarizeAsset;
          const turns = await diaFn(wavPath);

          if (turns.length > 0) {
            console.log(`[diarize] ${asset.asset_id}: ${new Set(turns.map(t => t.speaker_id)).size} speakers detected, ${turns.length} turns`);

            // Convert TranscriptItems to SttUtterances for speaker assignment
            const utterances = result.transcript.items.map((item) => ({
              speaker: item.speaker,
              start_us: item.start_us,
              end_us: item.end_us,
              text: item.text,
            }));

            // Assign speakers and normalize labels
            const withSpeakers = assignSpeakersToUtterances(utterances, turns);
            const normalized = normalizeSpeakerLabels(withSpeakers);

            // Update transcript items with diarized speaker labels
            for (let i = 0; i < result.transcript.items.length; i++) {
              result.transcript.items[i].speaker = normalized[i].speaker;
              result.transcript.items[i].speaker_key =
                `${asset.asset_id}:${normalized[i].speaker}`;
            }

            // Record diarization provenance
            const diarization = {
              provider: "pyannote",
              speaker_count: new Set(normalized.map((u) => u.speaker)).size,
              turn_count: turns.length,
            };
            (result.transcript as unknown as Record<string, unknown>).diarization = diarization;
          } else {
            console.warn(`[diarize] ${asset.asset_id}: no speaker turns detected (pyannote may not be available)`);
            if (diarizeOpts.gapEntries) {
              diarizeOpts.gapEntries.push({
                stage: "diarize",
                asset_id: asset.asset_id,
                issue: "diarization_no_turns: pyannote returned no speaker turns",
                severity: "warning",
              });
            }
          }

          // Clean up diarization temp dir
          try {
            fs.rmSync(diaTmpDir, { recursive: true, force: true });
          } catch {
            // Ignore cleanup errors
          }
        }
      } catch (err) {
        console.warn(`[diarize] ${asset.asset_id}: diarization failed: ${err instanceof Error ? err.message : String(err)}`);
        if (diarizeOpts?.gapEntries) {
          diarizeOpts.gapEntries.push({
            stage: "diarize",
            asset_id: asset.asset_id,
            issue: `diarization_failed: ${err instanceof Error ? err.message : String(err)}`,
            severity: "warning",
          });
        }
      }
    }

    results.set(asset.asset_id, result);
  }

  return results;
}

/**
 * Stage 8: stt.reduce — write transcript files + update assets.json and segments.json.
 *
 * Per design doc: stt.reduce writes final transcripts/TR_*.json files.
 * Both successful and failed transcript artifacts are persisted.
 */
export function sttReduce(
  sttResults: Map<string, AssetSttResult>,
  assetsJson: AssetsJson,
  segmentsJson: SegmentsJson,
  alignmentThresholds: TranscriptAlignmentThresholds,
  assetsOutputPath: string,
  segmentsOutputPath: string,
  outputDir: string,
): { assets: AssetsJson; segments: SegmentsJson } {
  // Write transcript files (both successful and failed)
  const transcriptsDir = path.join(outputDir, "transcripts");
  fs.mkdirSync(transcriptsDir, { recursive: true });

  for (const [, sttResult] of sttResults) {
    const transcriptRef = sttResult.transcript.transcript_ref;
    atomicWriteJson(path.join(transcriptsDir, `${transcriptRef}.json`), sttResult.transcript);
  }

  // Update assets with transcript info
  for (const asset of assetsJson.items) {
    const sttResult = sttResults.get(asset.asset_id);
    if (sttResult && sttResult.success) {
      asset.has_transcript = true;
      asset.transcript_ref = sttResult.transcript.transcript_ref;
    }
    // If no result (no audio), leave has_transcript as false (already default)
  }
  atomicWriteJson(assetsOutputPath, assetsJson);

  // Update segments with transcript excerpts
  for (const seg of segmentsJson.items) {
    const sttResult = sttResults.get(seg.asset_id);
    if (sttResult && sttResult.success && sttResult.transcript.items.length > 0) {
      seg.transcript_excerpt = computeTranscriptExcerpt(
        seg.src_in_us,
        seg.src_out_us,
        sttResult.transcript.items,
        alignmentThresholds,
      );
      seg.transcript_ref = sttResult.transcript.transcript_ref;
    }
  }
  atomicWriteJson(segmentsOutputPath, segmentsJson);

  return { assets: assetsJson, segments: segmentsJson };
}
