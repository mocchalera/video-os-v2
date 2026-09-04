/**
 * Stage 10.6: deterministic ffmpeg visual-quality measurements.
 *
 * Writes sampled shake/sharpness/exposure measurements to segments.json without
 * relying on VLM labels. Failures are recorded as measured:false and do not
 * interrupt the pipeline.
 */

import type { SegmentItem } from "../../connectors/ffmpeg-segmenter.js";
import {
  FFMPEG_MOTION_CONNECTOR_VERSION,
  analyzeSegmentVisualQuality,
  analyzeStillImageVisualQuality,
  computeVisualQualityRequestHash,
  failedVisualQualityMeasurement,
  type FfmpegMotionOptions,
  type VisualQualityMeasurements,
} from "../../connectors/ffmpeg-motion.js";
import { atomicWriteJson } from "./_util.js";
import type { SegmentsJson } from "../pipeline-types.js";
import type { MediaKind } from "../../media/media-kind-registry.js";
import {
  deterministicObservationContribution,
  reduceEditorialObservation,
} from "./editorial-observation.js";

export const DEFAULT_VISUAL_QUALITY_CONCURRENCY = 2;
const IMAGE_SEQUENCE_MIN_SAMPLE_FPS = 8;

export type VisualQualityAnalyzeFn = (
  sourcePath: string,
  segment: SegmentItem,
  options?: FfmpegMotionOptions,
) => Promise<VisualQualityMeasurements>;

export interface VisualQualityStageOptions {
  segmentsJson: SegmentsJson;
  sourceFileMap: Map<string, string>;
  segmentsOutputPath: string;
  policyHash: string;
  concurrency?: number;
  analyzeFn?: VisualQualityAnalyzeFn;
  ffmpegOptions?: FfmpegMotionOptions;
  eligibleAssetIds?: ReadonlySet<string>;
  assetMediaKinds?: ReadonlyMap<string, MediaKind>;
  deadlineAtMs?: number;
}

export interface VisualQualitySegmentFailure {
  segment_id: string;
  asset_id: string;
  error: string;
}

export interface VisualQualityStageSummary {
  totalSegments: number;
  measuredSegments: number;
  partialSegments: number;
  failedSegments: VisualQualitySegmentFailure[];
  skippedSegments: number;
  timedOut: boolean;
}

interface VisualQualityShard {
  segment_id: string;
  asset_id: string;
  sourcePath?: string;
  result: VisualQualityMeasurements;
  requestHash?: string;
}

type SegmentWithVisualQualityMeasurements = SegmentItem & {
  visual_quality_measurements?: VisualQualityMeasurements;
  confidence: SegmentItem["confidence"] & {
    visual_quality_measurements?: { score: number; source: string; status: string };
  };
  provenance: SegmentItem["provenance"] & {
    visual_quality_measurements?: Record<string, string>;
  };
};

export async function runVisualQualityMeasurementStage(
  options: VisualQualityStageOptions,
): Promise<{ segmentsJson: SegmentsJson; summary: VisualQualityStageSummary }> {
  const summary: VisualQualityStageSummary = {
    totalSegments: options.segmentsJson.items.length,
    measuredSegments: 0,
    partialSegments: 0,
    failedSegments: [],
    skippedSegments: 0,
    timedOut: false,
  };
  if (options.segmentsJson.items.length === 0) {
    return { segmentsJson: options.segmentsJson, summary };
  }

  const analyzeFn = options.analyzeFn;
  const ffmpegOptions = options.ffmpegOptions ?? {};

  const candidates = options.segmentsJson.items.filter((segment) =>
    !options.eligibleAssetIds || options.eligibleAssetIds.has(segment.asset_id)
  );
  const shardsByIndex = new Array<VisualQualityShard | undefined>(candidates.length);
  const candidatesByAsset = new Map<string, Array<{ segment: SegmentItem; index: number }>>();
  for (const [index, segment] of candidates.entries()) {
    const group = candidatesByAsset.get(segment.asset_id) ?? [];
    group.push({ segment, index });
    candidatesByAsset.set(segment.asset_id, group);
  }

  const analyzeSegment = async (segment: SegmentItem): Promise<VisualQualityShard> => {
      const sourcePath = options.sourceFileMap.get(segment.asset_id);
      const durationUs = Math.max(0, segment.src_out_us - segment.src_in_us);
      const mediaKind = options.assetMediaKinds?.get(segment.asset_id);
      const effectiveFfmpegOptions = mediaKind === "sequence"
        ? { ...ffmpegOptions, sampleFps: Math.max(IMAGE_SEQUENCE_MIN_SAMPLE_FPS, ffmpegOptions.sampleFps ?? 0) }
        : ffmpegOptions;
      if (!sourcePath) {
        return {
          segment_id: segment.segment_id,
          asset_id: segment.asset_id,
          result: failedVisualQualityMeasurement("source_file_missing", {
            sampleFps: effectiveFfmpegOptions.sampleFps,
            maxWidth: effectiveFfmpegOptions.maxWidth,
            durationUs,
          }),
        };
      }

      try {
        const result = analyzeFn
          ? await analyzeFn(sourcePath, segment, effectiveFfmpegOptions)
          : mediaKind === "image"
            ? await analyzeStillImageVisualQuality(sourcePath, effectiveFfmpegOptions)
            : await defaultAnalyzeFn(sourcePath, segment, effectiveFfmpegOptions);
        const requestHash = computeVisualQualityRequestHash({
          sourcePath,
          segmentId: segment.segment_id,
          srcInUs: segment.src_in_us,
          srcOutUs: segment.src_out_us,
          policyHash: options.policyHash,
          sampleFps: result.sample_fps,
          maxWidth: result.max_width,
        });
        return {
          segment_id: segment.segment_id,
          asset_id: segment.asset_id,
          sourcePath,
          result,
          requestHash,
        };
      } catch (error) {
        return {
          segment_id: segment.segment_id,
          asset_id: segment.asset_id,
          sourcePath,
          result: failedVisualQualityMeasurement(errorMessage(error), {
            sampleFps: effectiveFfmpegOptions.sampleFps,
            maxWidth: effectiveFfmpegOptions.maxWidth,
            durationUs,
          }),
        };
      }
  };
  summary.timedOut = await processVisualQualityAssetGroups({
    assetGroups: [...candidatesByAsset.values()],
    concurrency: options.concurrency ?? DEFAULT_VISUAL_QUALITY_CONCURRENCY,
    deadlineAtMs: options.deadlineAtMs,
    analyzeSegment,
    shardsByIndex,
  });
  const shards = shardsByIndex.filter((shard): shard is VisualQualityShard => shard !== undefined);

  const shardBySegmentId = new Map(shards.map((shard) => [shard.segment_id, shard]));
  let updatedSegments = 0;
  for (const segment of options.segmentsJson.items as SegmentWithVisualQualityMeasurements[]) {
    const shard = shardBySegmentId.get(segment.segment_id);
    if (!shard) continue;
    updatedSegments += 1;

    segment.visual_quality_measurements = shard.result;
    segment.confidence = {
      ...segment.confidence,
      visual_quality_measurements: {
        score: computeMeasurementConfidence(shard.result),
        source: "ffmpeg",
        status: shard.result.measured ? "ready" : hasAnyMetric(shard.result) ? "partial" : "unsupported",
      },
    };
    segment.provenance = {
      ...segment.provenance,
      visual_quality_measurements: {
        stage: "visual_quality_measurements",
        method: shard.result.method,
        connector_version: FFMPEG_MOTION_CONNECTOR_VERSION,
        policy_hash: options.policyHash,
        request_hash: shard.requestHash ?? `failed:${shortReason(shard.result.failure_reason ?? "unknown")}`,
      },
    };
    segment.editorial_observation = reduceEditorialObservation(
      segment,
      segment.editorial_observation,
      [deterministicObservationContribution({
        segment,
        measurements: shard.result,
        sourcePath: shard.sourcePath,
        requestHash: shard.requestHash,
      })],
    );

    if (shard.result.measured) {
      summary.measuredSegments += 1;
    } else if (hasAnyMetric(shard.result)) {
      summary.partialSegments += 1;
      summary.failedSegments.push({
        segment_id: shard.segment_id,
        asset_id: shard.asset_id,
        error: shard.result.failure_reason ?? "partial_measurement",
      });
    } else {
      summary.failedSegments.push({
        segment_id: shard.segment_id,
        asset_id: shard.asset_id,
        error: shard.result.failure_reason ?? "measurement_failed",
      });
    }
  }

  summary.skippedSegments = Math.max(0, options.segmentsJson.items.length - updatedSegments);

  atomicWriteJson(options.segmentsOutputPath, options.segmentsJson);
  return { segmentsJson: options.segmentsJson, summary };
}

async function processVisualQualityAssetGroups(options: {
  assetGroups: Array<Array<{ segment: SegmentItem; index: number }>>;
  concurrency: number;
  deadlineAtMs?: number;
  analyzeSegment: (segment: SegmentItem) => Promise<VisualQualityShard>;
  shardsByIndex: Array<VisualQualityShard | undefined>;
}): Promise<boolean> {
  if (options.assetGroups.length === 0) return false;
  const limit = Number.isFinite(options.concurrency) && options.concurrency >= 1
    ? Math.max(1, Math.floor(options.concurrency))
    : DEFAULT_VISUAL_QUALITY_CONCURRENCY;
  let nextAssetIndex = 0;
  let timedOut = options.deadlineAtMs !== undefined && Date.now() >= options.deadlineAtMs;

  async function runWorker(): Promise<void> {
    while (!timedOut && (options.deadlineAtMs === undefined || Date.now() < options.deadlineAtMs)) {
      const assetIndex = nextAssetIndex++;
      if (assetIndex >= options.assetGroups.length) return;
      for (const { segment, index } of options.assetGroups[assetIndex]) {
        if (timedOut || (options.deadlineAtMs !== undefined && Date.now() >= options.deadlineAtMs)) return;
        options.shardsByIndex[index] = await options.analyzeSegment(segment);
      }
    }
  }

  const completion = Promise.all(
    Array.from({ length: Math.min(limit, options.assetGroups.length) }, () => runWorker()),
  );
  if (options.deadlineAtMs === undefined) {
    await completion;
    return false;
  }
  if (timedOut) return true;

  let timer: ReturnType<typeof setTimeout> | undefined;
  const outcome = await Promise.race([
    completion.then(() => "complete" as const),
    new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => {
        timedOut = true;
        resolve("timeout");
      }, Math.max(0, options.deadlineAtMs! - Date.now()));
    }),
  ]);
  if (timer) clearTimeout(timer);
  return outcome === "timeout";
}

async function defaultAnalyzeFn(
  sourcePath: string,
  segment: SegmentItem,
  options?: FfmpegMotionOptions,
): Promise<VisualQualityMeasurements> {
  return analyzeSegmentVisualQuality(sourcePath, segment.src_in_us, segment.src_out_us, options);
}

function computeMeasurementConfidence(result: VisualQualityMeasurements): number {
  const values = [
    result.shake?.score,
    result.sharpness?.sharpness_score,
    result.exposure?.exposure_score,
  ].filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  if (values.length === 0) return 0;
  return round3(values.reduce((sum, value) => sum + value, 0) / values.length);
}

function hasAnyMetric(result: VisualQualityMeasurements): boolean {
  return result.metrics_measured.shake ||
    result.metrics_measured.sharpness ||
    result.metrics_measured.exposure;
}

function shortReason(reason: string): string {
  return reason.replace(/[^A-Za-z0-9_-]+/g, "_").slice(0, 48) || "unknown";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}
