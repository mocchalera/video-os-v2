/**
 * Stage 9–10: VLM enrichment — parallel analysis + reduce.
 *
 * Merged from former vlm-analysis.ts + vlmReduce from ingest.ts.
 *
 * hydrateCachedVlmSegments — reuse cached VLM enrichment data.
 * runParallelVlmAnalysis   — per-asset VLM enrichment with concurrency.
 * vlmReduce                — merge VLM shards into segments/assets.
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { AssetItem } from "../../connectors/ffprobe.js";
import type { SegmentItem } from "../../connectors/ffmpeg-segmenter.js";
import {
  type SamplingPolicy,
  type SegmentType,
  type VlmEnrichmentResult,
  type VlmFrameGrounding,
  type VlmFn,
  type VlmPolicy,
  type VlmVisualQuality,
  PROMPT_TEMPLATE_ID,
  VLM_CONNECTOR_VERSION,
  adjustFpsForBudget,
  computeFrameCount,
  computePromptHash,
  computeSampleTimestamps,
  computeVlmRequestHash,
  enrichSegment,
  getAdaptiveSampleFps,
  guessAssetRole,
  shouldSkipVlm,
} from "../../connectors/gemini-vlm.js";
import { atomicWriteJson } from "./_util.js";
import {
  extractGroundedFrames,
  GROUNDED_FRAME_CACHE_VERSION,
  GROUNDED_FRAME_PRODUCER_VERSION,
  inspectGroundedFrameCache,
  type FrameExecFileLike,
} from "./grounded-frames.js";
import { sha256FileHex, SourceContentIdentityCache } from "../../source-content-identity.js";
import type { AssetsJson, SegmentsJson } from "../pipeline-types.js";
import {
  reduceEditorialObservation,
  type ObservationContribution,
  type ObservationField,
  type ObservationValues,
} from "./editorial-observation.js";

// ── Constants ──────────────────────────────────────────────────────

export const DEFAULT_VLM_CONCURRENCY = 3;
export const VLM_CACHE_IDENTITY_VERSION = "grounded-vlm-cache-identity-v1";
export const VLM_PROVENANCE_SCHEMA_VERSION = "vlm-provenance-v2";

export function computeVlmCachePolicyHash(
  vlmPolicy: VlmPolicy,
  samplingPolicy: SamplingPolicy,
  minSegmentDurationUs: number,
  contentHint?: string,
): string {
  return createHash("sha256").update(JSON.stringify({
    vlm: vlmPolicy,
    sampling: samplingPolicy,
    min_segment_duration_us: minSegmentDurationUs,
    content_hint: contentHint ?? null,
  })).digest("hex");
}
const MARLIN_REPORTER_METHOD = "marlin_reporter";
const MARLIN_SUMMARY_PROMPT_TEMPLATE_ID = "marlin-caption-v1";
const VLM_QUALITY_FLAGS = new Set([
  "underexposed",
  "overexposed",
  "blurry",
  "shaky",
  "noisy",
  "interlaced",
  "letterboxed",
  "pillarboxed",
]);

// ── Types ──────────────────────────────────────────────────────────

export interface VlmRetryPolicy {
  initialDelayMs: number;
  maxDelayMs: number;
  maxRetries: number;
}

export const DEFAULT_VLM_RETRY_POLICY: VlmRetryPolicy = {
  initialDelayMs: 1_000,
  maxDelayMs: 30_000,
  maxRetries: 5,
};

export interface VlmShard {
  segment_id: string;
  media_kind?: AssetItem["media_kind"];
  result: VlmEnrichmentResult;
}

export interface VlmAssetFailure {
  assetId: string;
  filename: string;
  error: string;
}

export interface VlmProgressEvent {
  current: number;
  total: number;
  assetId: string;
  filename: string;
  status: "analyzing" | "cached" | "skipped";
}

export interface VlmProgressReporter {
  onAssetProgress?: (event: VlmProgressEvent) => void;
  onAssetFailure?: (failure: VlmAssetFailure) => void;
}

export interface VlmAssetRunSummary {
  totalAssets: number;
  cachedAssets: number;
  analyzedAssets: number;
  skippedAssets: number;
  failedAssets: VlmAssetFailure[];
  durationMs: number;
}

export interface RunParallelVlmAnalysisOptions {
  assets: AssetItem[];
  segments: SegmentItem[];
  vlmPolicy: VlmPolicy;
  samplingPolicy: SamplingPolicy;
  minSegmentDurationUs: number;
  vlmFn: VlmFn;
  sourceFileMap: Map<string, string>;
  outputDir: string;
  contentHint?: string;
  concurrency?: number;
  retryPolicy?: Partial<VlmRetryPolicy>;
  reporter?: VlmProgressReporter;
  cachedSegmentIds?: ReadonlySet<string>;
  sleepFn?: (ms: number) => Promise<void>;
  frameExecFileImpl?: FrameExecFileLike;
  policyHash?: string;
  sourceIdentityCache?: SourceContentIdentityCache;
  cacheDecisions?: ReadonlyMap<string, VlmCacheDecision>;
}

export interface HydrateCachedVlmSegmentsOptions {
  currentSegments: SegmentItem[];
  cachedSegments?: SegmentItem[];
  vlmPolicy: VlmPolicy;
  policyHash: string;
  samplingPolicy?: SamplingPolicy;
  minSegmentDurationUs?: number;
  sourceFileMap?: Map<string, string>;
  outputDir?: string;
  sourceIdentityCache?: SourceContentIdentityCache;
  cacheDecisions?: Map<string, VlmCacheDecision>;
  eligibleAssetIds?: ReadonlySet<string>;
  assets?: AssetItem[];
}

export interface VlmCacheDecision {
  status: "accepted" | "miss";
  reasons: string[];
}

interface VlmAssetPlan {
  asset: AssetItem;
  liveSegments: SegmentItem[];
}

type SegmentWithVisualQuality = SegmentItem & {
  visual_quality?: VlmVisualQuality;
  provenance: SegmentItem["provenance"] & {
    visual_quality?: Record<string, string>;
  };
};

// ── Concurrency Helpers ────────────────────────────────────────────

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export async function mapWithConcurrency<T, TResult>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<TResult>,
): Promise<TResult[]> {
  if (items.length === 0) return [];

  const limit = normalizeConcurrency(concurrency);
  const results = new Array<TResult>(items.length);
  let nextIndex = 0;

  async function runWorker(): Promise<void> {
    while (true) {
      const currentIndex = nextIndex++;
      if (currentIndex >= items.length) return;
      results[currentIndex] = await worker(items[currentIndex], currentIndex);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => runWorker()),
  );
  return results;
}

export async function withRateLimitRetry<T>(
  operation: () => Promise<T>,
  retryPolicy?: Partial<VlmRetryPolicy>,
  sleepFn: (ms: number) => Promise<void> = sleep,
): Promise<T> {
  const policy = resolveRetryPolicy(retryPolicy);
  let delayMs = policy.initialDelayMs;

  for (let attempt = 0; ; attempt++) {
    try {
      return await operation();
    } catch (error) {
      if (!isRateLimitError(error) || attempt >= policy.maxRetries) {
        throw error;
      }

      await sleepFn(Math.min(delayMs, policy.maxDelayMs));
      delayMs = Math.min(delayMs * 2, policy.maxDelayMs);
    }
  }
}

// ── Cache Hydration ────────────────────────────────────────────────

export function hydrateCachedVlmSegments(
  options: HydrateCachedVlmSegmentsOptions,
): Set<string> {
  const cachedById = new Map(
    (options.cachedSegments ?? []).map((segment) => [segment.segment_id, segment]),
  );
  const cachedSegmentIds = new Set<string>();
  const expectedPromptHash = computePromptHash();

  for (const segment of options.currentSegments) {
    if (options.eligibleAssetIds && !options.eligibleAssetIds.has(segment.asset_id)) continue;
    const cached = cachedById.get(segment.segment_id);
    if (!cached) {
      options.cacheDecisions?.set(segment.segment_id, {
        status: "miss",
        reasons: ["cached_segment_missing"],
      });
      continue;
    }

    const currentHasMarlinSummary = hasMarlinOwnedSummary(segment);
    const summaryReasons = getVlmCacheMismatchReasons(
      cached.provenance?.summary,
      segment,
      options,
      expectedPromptHash,
    );
    const tagsReasons = getVlmCacheMismatchReasons(
      cached.provenance?.tags,
      segment,
      options,
      expectedPromptHash,
    );
    const qualityFlagReasons = getVlmCacheMismatchReasons(
      cached.provenance?.quality_flags,
      segment,
      options,
      expectedPromptHash,
    );
    const observationReasons = getObservationCacheMismatchReasons(cached);
    const cachedSummaryReusable = summaryReasons.length === 0;
    const cachedTagsReusable = tagsReasons.length === 0;
    const cachedQualityFlagsReusable = qualityFlagReasons.length === 0;

    if (
      (!currentHasMarlinSummary && !cachedSummaryReusable) ||
      !cachedTagsReusable ||
      !cachedQualityFlagsReusable ||
      observationReasons.length > 0
    ) {
      const reasons = uniqueStrings([
        ...(!currentHasMarlinSummary ? summaryReasons : []),
        ...tagsReasons,
        ...qualityFlagReasons,
        ...observationReasons,
      ]);
      options.cacheDecisions?.set(segment.segment_id, { status: "miss", reasons });
      invalidateIncompatibleVlmFields(segment, options, expectedPromptHash);
      continue;
    }

    const cachedVisualQuality = (cached as SegmentWithVisualQuality).visual_quality;
    const cachedVisualQualityProvenance =
      (cached.provenance as Record<string, Record<string, string> | undefined>).visual_quality;
    const canReuseVisualQuality = cachedVisualQuality !== undefined &&
      getVlmCacheMismatchReasons(
        cachedVisualQualityProvenance,
        segment,
        options,
        expectedPromptHash,
      ).length === 0;

    if (!currentHasMarlinSummary) {
      segment.summary = cached.summary;
    }
    segment.tags = mergeTags(segment.tags, cached.tags);
    segment.quality_flags = [...new Set([...segment.quality_flags, ...cached.quality_flags])];
    segment.interest_points = mergeInterestPoints(segment.interest_points, cached.interest_points);
    if (canReuseVisualQuality) {
      (segment as SegmentWithVisualQuality).visual_quality = cloneVisualQuality(cachedVisualQuality);
    }
    const cachedObservationProducer = cached.editorial_observation?.provenance.producers.find(
      (producer) => producer.producer === "grounded_vlm",
    );
    if (cached.editorial_observation && cachedObservationProducer) {
      segment.editorial_observation = structuredClone(cached.editorial_observation);
      const producer = segment.editorial_observation.provenance.producers.find(
        (item) => item.producer === "grounded_vlm",
      );
      if (producer) producer.cache_decision = "accepted";
      const snapshotProducer = segment.editorial_observation.producer_snapshots?.grounded_vlm?.producer;
      if (snapshotProducer) snapshotProducer.cache_decision = "accepted";
    }
    segment.confidence = {
      ...segment.confidence,
      ...(!currentHasMarlinSummary && cached.confidence.summary
        ? { summary: { ...cached.confidence.summary } }
        : {}),
      ...(cached.confidence.tags ? { tags: { ...cached.confidence.tags } } : {}),
      ...(cached.confidence.quality_flags
        ? { quality_flags: { ...cached.confidence.quality_flags } }
        : {}),
    };
    segment.provenance = {
      ...segment.provenance,
      ...(!currentHasMarlinSummary && cached.provenance.summary
        ? { summary: markAcceptedProvenance(cached.provenance.summary) }
        : {}),
      ...(cached.provenance.tags ? { tags: markAcceptedProvenance(cached.provenance.tags) } : {}),
      ...(cached.provenance.quality_flags
        ? { quality_flags: markAcceptedProvenance(cached.provenance.quality_flags) }
        : {}),
      ...(canReuseVisualQuality && cachedVisualQualityProvenance
        ? { visual_quality: markAcceptedProvenance(cachedVisualQualityProvenance) }
        : {}),
    };
    options.cacheDecisions?.set(segment.segment_id, {
      status: "accepted",
      reasons: ["cache_identity_match", "verified_frame_cache_match"],
    });
    cachedSegmentIds.add(segment.segment_id);
  }

  return cachedSegmentIds;
}

// ── Parallel VLM Analysis ──────────────────────────────────────────

export async function runParallelVlmAnalysis(
  options: RunParallelVlmAnalysisOptions,
): Promise<{ shards: VlmShard[]; summary: VlmAssetRunSummary }> {
  const startedAt = Date.now();
  const assetSegments = new Map<string, SegmentItem[]>();
  const cachedSegmentIds = options.cachedSegmentIds ?? new Set<string>();
  const summary: VlmAssetRunSummary = {
    totalAssets: options.assets.length,
    cachedAssets: 0,
    analyzedAssets: 0,
    skippedAssets: 0,
    failedAssets: [],
    durationMs: 0,
  };
  const livePlans: VlmAssetPlan[] = [];
  let progressCount = 0;

  for (const segment of options.segments) {
    const existing = assetSegments.get(segment.asset_id);
    if (existing) {
      existing.push(segment);
    } else {
      assetSegments.set(segment.asset_id, [segment]);
    }
  }

  const emitProgress = (asset: AssetItem, status: VlmProgressEvent["status"]): void => {
    progressCount += 1;
    options.reporter?.onAssetProgress?.({
      current: progressCount,
      total: summary.totalAssets,
      assetId: asset.asset_id,
      filename: asset.filename,
      status,
    });
  };

  for (const asset of options.assets) {
    if (asset.audio_stream && !asset.video_stream) {
      summary.skippedAssets += 1;
      emitProgress(asset, "skipped");
      continue;
    }
    const segments = assetSegments.get(asset.asset_id) ?? [];
    const analyzableSegments = segments.filter((segment) => {
      if (asset.media_kind === "image" || asset.media_kind === "sequence") return true;
      const durationUs = segment.src_out_us - segment.src_in_us;
      return !shouldSkipVlm(
        segment.quality_flags,
        durationUs,
        options.minSegmentDurationUs,
      );
    });
    const liveSegments = analyzableSegments.filter(
      (segment) => !cachedSegmentIds.has(segment.segment_id),
    );

    if (analyzableSegments.length === 0) {
      summary.skippedAssets += 1;
      emitProgress(asset, "skipped");
      continue;
    }

    if (liveSegments.length === 0) {
      summary.cachedAssets += 1;
      emitProgress(asset, "cached");
      continue;
    }

    livePlans.push({ asset, liveSegments });
  }

  summary.analyzedAssets = livePlans.length;

  const liveResults = await mapWithConcurrency(
    livePlans,
    options.concurrency ?? DEFAULT_VLM_CONCURRENCY,
    async (plan) => {
      emitProgress(plan.asset, "analyzing");

      const shards: VlmShard[] = [];
      const segmentErrors: string[] = [];

      for (const segment of plan.liveSegments) {
        try {
          const result = await analyzeSegmentWithRetry(segment, options);
          shards.push({ segment_id: segment.segment_id, media_kind: plan.asset.media_kind, result });
          if (!result.success) {
            segmentErrors.push(`${segment.segment_id}: ${result.error ?? "unknown"}`);
          }
        } catch (error) {
          const message = `vlm_exception: ${
            error instanceof Error ? error.message : String(error)
          }`;
          shards.push({
            segment_id: segment.segment_id,
            media_kind: plan.asset.media_kind,
            result: makeFailedResult(options.vlmPolicy, message),
          });
          segmentErrors.push(`${segment.segment_id}: ${message}`);
        }
      }

      const failure = segmentErrors.length > 0
        ? {
          assetId: plan.asset.asset_id,
          filename: plan.asset.filename,
          error: summarizeErrors(segmentErrors),
        }
        : undefined;

      if (failure) {
        options.reporter?.onAssetFailure?.(failure);
      }

      return { shards, failure };
    },
  );

  const shards: VlmShard[] = [];
  for (const result of liveResults) {
    shards.push(...result.shards);
    if (result.failure) {
      summary.failedAssets.push(result.failure);
    }
  }

  summary.durationMs = Date.now() - startedAt;
  return { shards, summary };
}

// ── VLM Reduce ─────────────────────────────────────────────────────

export function vlmReduce(
  vlmShards: VlmShard[],
  assetsJson: AssetsJson,
  segmentsJson: SegmentsJson,
  policyHash: string,
  responseFormat: string,
  segmentsOutputPath: string,
  assetsOutputPath: string,
  persistOutputs = true,
): { segments: SegmentsJson; assets: AssetsJson } {
  // Build lookup by segment_id
  const shardMap = new Map<string, VlmShard>();
  for (const shard of vlmShards) {
    shardMap.set(shard.segment_id, shard);
  }

  // Enrich segments
  for (const seg of segmentsJson.items) {
    const shard = shardMap.get(seg.segment_id);
    if (!shard) continue;
    if (!shard.result.success || !shard.result.output || !isGroundedVlmResult(shard.result)) {
      seg.editorial_observation = reduceEditorialObservation(
        seg,
        seg.editorial_observation,
        [vlmObservationGap(shard, seg)],
      );
      continue;
    }

    const out = shard.result.output;
    const summaryOwnedByMarlin = hasMarlinOwnedSummary(seg);

    // Update enrichment fields
    if (!summaryOwnedByMarlin) {
      seg.summary = out.summary || seg.summary;
    }
    seg.tags = out.tags.length > 0 ? mergeTags(seg.tags, out.tags) : seg.tags;
    seg.quality_flags = out.quality_flags.length > 0
      ? [...new Set([...seg.quality_flags, ...out.quality_flags])]
      : seg.quality_flags;
    if (shard.media_kind !== "image") {
      seg.interest_points = mergeInterestPoints(seg.interest_points, out.interest_points);
    }
    if (out.visual_quality && shard.media_kind !== "image") {
      (seg as SegmentWithVisualQuality).visual_quality = out.visual_quality;
    }
    seg.editorial_observation = reduceEditorialObservation(
      seg,
      seg.editorial_observation,
      [groundedVlmObservation(shard, seg)],
    );

    // Confidence records
    if (!seg.confidence) {
      seg.confidence = {} as SegmentItem["confidence"];
    }
    if (!summaryOwnedByMarlin) {
      (seg.confidence as Record<string, unknown>).summary = {
        score: out.confidence.summary,
        source: `${shard.result.model_alias}`,
        status: "ready",
      };
    }
    (seg.confidence as Record<string, unknown>).tags = {
      score: out.confidence.tags,
      source: `${shard.result.model_alias}`,
      status: "ready",
    };
    (seg.confidence as Record<string, unknown>).quality_flags = {
      score: out.confidence.quality_flags,
      source: `${shard.result.model_alias}`,
      status: "ready",
    };

    // Provenance records
    if (!seg.provenance) {
      seg.provenance = {} as SegmentItem["provenance"];
    }
    const vlmProvenance = {
      stage: "vlm",
      method: "gemini_frame_bundle",
      connector_version: VLM_CONNECTOR_VERSION,
      policy_hash: policyHash,
      request_hash: computeVlmRequestHash({
        segment_id: seg.segment_id,
        model_snapshot: shard.result.model_snapshot,
        prompt_hash: shard.result.prompt_hash,
        frame_count: shard.result.frame_grounding?.frame_count ?? 0,
        sample_timestamps_us: shard.result.frame_grounding?.sample_timestamps_us ?? [],
        frame_cache_version: shard.result.frame_grounding?.frame_cache_version,
      }),
      model_alias: shard.result.model_alias,
      model_snapshot: shard.result.model_snapshot,
      prompt_template_id: PROMPT_TEMPLATE_ID,
      prompt_hash: shard.result.prompt_hash,
      response_format: responseFormat,
      provenance_schema_version: VLM_PROVENANCE_SCHEMA_VERSION,
      frame_count: shard.result.frame_grounding?.frame_count ?? 0,
      sample_timestamps_us: shard.result.frame_grounding?.sample_timestamps_us ?? [],
      requested_sample_timestamps_us:
        shard.result.frame_grounding?.requested_sample_timestamps_us ?? [],
      frame_cache_version:
        shard.result.frame_grounding?.frame_cache_version ?? GROUNDED_FRAME_CACHE_VERSION,
      frame_producer_version:
        shard.result.frame_grounding?.frame_producer_version ?? GROUNDED_FRAME_PRODUCER_VERSION,
      frame_cache_hits: shard.result.frame_grounding?.frame_cache_hits ?? 0,
      ...(shard.result.frame_grounding?.frame_content_sha256?.length
        ? { frame_content_sha256: shard.result.frame_grounding.frame_content_sha256 }
        : {}),
      ...(shard.result.frame_grounding?.asset_source_content_sha256
        ? { asset_source_content_sha256: shard.result.frame_grounding.asset_source_content_sha256 }
        : {}),
      ...(shard.result.frame_grounding?.source_content_sha256
        ? { source_content_sha256: shard.result.frame_grounding.source_content_sha256 }
        : {}),
      ...(typeof shard.result.frame_grounding?.segment_src_in_us === "number"
        ? { segment_src_in_us: shard.result.frame_grounding.segment_src_in_us }
        : {}),
      ...(typeof shard.result.frame_grounding?.segment_src_out_us === "number"
        ? { segment_src_out_us: shard.result.frame_grounding.segment_src_out_us }
        : {}),
      ...(shard.result.frame_grounding?.cache_identity
        ? { cache_identity: shard.result.frame_grounding.cache_identity }
        : {}),
      ...(shard.result.frame_grounding?.cache_decision
        ? { cache_decision: shard.result.frame_grounding.cache_decision }
        : {}),
      ...(shard.result.frame_grounding?.cache_decision_reasons?.length
        ? { cache_decision_reasons: shard.result.frame_grounding.cache_decision_reasons }
        : {}),
      ...(shard.result.frame_grounding?.frame_extraction_failures?.length
        ? { frame_extraction_failures: shard.result.frame_grounding.frame_extraction_failures }
        : {}),
    };
    if (!summaryOwnedByMarlin) {
      (seg.provenance as Record<string, unknown>).summary = vlmProvenance;
    }
    (seg.provenance as Record<string, unknown>).tags = vlmProvenance;
    (seg.provenance as Record<string, unknown>).quality_flags = vlmProvenance;
    if (out.visual_quality && shard.media_kind !== "image") {
      (seg.provenance as Record<string, unknown>).visual_quality = vlmProvenance;
    }
  }

  // Update asset role_guess based on combined STT + VLM evidence
  for (const asset of assetsJson.items) {
    const assetSegments = segmentsJson.items.filter((s) => s.asset_id === asset.asset_id);
    asset.role_guess = guessAssetRole(
      !!asset.has_transcript,
      assetSegments,
    );
  }

  if (persistOutputs) {
    atomicWriteJson(segmentsOutputPath, segmentsJson);
    atomicWriteJson(assetsOutputPath, assetsJson);
  }

  return { segments: segmentsJson, assets: assetsJson };
}

function groundedVlmObservation(shard: VlmShard, segment: SegmentItem): ObservationContribution {
  const grounding = shard.result.frame_grounding;
  const observation = shard.result.output?.editorial_observation;
  const values: ObservationValues = structuredClone(observation?.values ?? {
    visual_tags: shard.result.output?.tags ?? [],
  });
  if (shard.media_kind === "image") {
    delete values.motion_type;
    delete values.camera_motion_direction;
    delete values.subject_motion_direction;
  }
  const fields = (Object.keys(values) as ObservationField[]).filter((field) =>
    values[field as keyof typeof values] !== undefined
  );
  const framePaths = grounding?.verified_frame_paths ?? [];
  const frameCount = grounding?.frame_count ?? framePaths.length;
  const generationRef = grounding?.cache_identity ?? shard.result.prompt_hash;
  const evidence = Array.from({ length: frameCount }, (_, index) => ({
    evidence_ref: `vlm:${segment.segment_id}:${generationRef}:frame:${index}`,
    producer: "grounded_vlm" as const,
    evidence_type: "verified_frame" as const,
    fields,
    ...(framePaths[index] ? { artifact_ref: framePaths[index] } : {}),
    ...(typeof grounding?.sample_timestamps_us[index] === "number"
      ? { frame_us: grounding.sample_timestamps_us[index] }
      : {}),
  }));
  const evidenceRefs = evidence.map((item) => item.evidence_ref);
  const confidence = Object.fromEntries(
    Object.entries(observation?.confidence ?? { tags: shard.result.output?.confidence.tags ?? 0.5 })
      .map(([group, score]) => [group, { score, evidence_refs: evidenceRefs }]),
  ) as ObservationContribution["confidence"];
  return {
    status: observation ? "ready" : "partial",
    values,
    confidence,
    evidence,
    ...(!observation ? { warnings: ["grounded_vlm_observation_payload_missing"] } : {}),
    producer: {
      producer: "grounded_vlm",
      producer_version: VLM_CONNECTOR_VERSION,
      model: shard.result.model_alias,
      runtime: shard.result.model_snapshot,
      prompt_hash: shard.result.prompt_hash,
      actual_verified_frame_count: grounding?.frame_count ?? 0,
      evidence_refs: evidenceRefs,
      ...(grounding?.source_content_sha256
        ? { source_content_sha256: grounding.source_content_sha256 }
        : {}),
      ...(grounding?.cache_identity ? { cache_identity: grounding.cache_identity } : {}),
      ...(grounding?.cache_decision ? { cache_decision: grounding.cache_decision } : {}),
    },
  };
}

function vlmObservationGap(shard: VlmShard, segment: SegmentItem): ObservationContribution {
  const grounding = shard.result.frame_grounding;
  const warning = shard.result.error ?? "grounded_vlm_observation_failed";
  const generationRef = grounding?.cache_identity ?? shard.result.prompt_hash;
  const evidenceRef = `vlm:${segment.segment_id}:${generationRef}:gap`;
  return {
    status: "skipped",
    evidence: [{
      evidence_ref: evidenceRef,
      producer: "grounded_vlm",
      evidence_type: "producer_gap",
      fields: [],
      warning,
    }],
    warnings: [`grounded_vlm_gap:${warning}`],
    producer: {
      producer: "grounded_vlm",
      producer_version: VLM_CONNECTOR_VERSION,
      model: shard.result.model_alias,
      runtime: shard.result.model_snapshot,
      prompt_hash: shard.result.prompt_hash,
      actual_verified_frame_count: countVerifiedGroundedFramePairs(shard.result),
      evidence_refs: [evidenceRef],
      ...(grounding?.source_content_sha256
        ? { source_content_sha256: grounding.source_content_sha256 }
        : {}),
      ...(grounding?.cache_identity ? { cache_identity: grounding.cache_identity } : {}),
      ...(grounding?.cache_decision ? { cache_decision: grounding.cache_decision } : {}),
    },
  };
}

// ── Internal Helpers ───────────────────────────────────────────────

function normalizeConcurrency(concurrency: number | undefined): number {
  if (!Number.isFinite(concurrency) || !concurrency || concurrency < 1) {
    return DEFAULT_VLM_CONCURRENCY;
  }
  return Math.max(1, Math.floor(concurrency));
}

function resolveRetryPolicy(
  retryPolicy?: Partial<VlmRetryPolicy>,
): VlmRetryPolicy {
  return {
    initialDelayMs: retryPolicy?.initialDelayMs ?? DEFAULT_VLM_RETRY_POLICY.initialDelayMs,
    maxDelayMs: retryPolicy?.maxDelayMs ?? DEFAULT_VLM_RETRY_POLICY.maxDelayMs,
    maxRetries: retryPolicy?.maxRetries ?? DEFAULT_VLM_RETRY_POLICY.maxRetries,
  };
}

function isRateLimitError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return /\b429\b|rate limit|resource exhausted/i.test(error.message);
}

async function analyzeSegmentWithRetry(
  segment: SegmentItem,
  options: RunParallelVlmAnalysisOptions,
): Promise<VlmEnrichmentResult> {
  const asset = options.assets.find((candidate) => candidate.asset_id === segment.asset_id);
  const { timestampsUs: timestamps } = resolveVlmSampling(
    segment,
    options.vlmPolicy,
    options.samplingPolicy,
    asset?.media_kind,
  );
  const sourcePath = options.sourceFileMap.get(segment.asset_id);
  let sourceContentSha256: string | undefined;
  try {
    if (sourcePath) {
      sourceContentSha256 = (options.sourceIdentityCache ?? new SourceContentIdentityCache())
        .resolve(sourcePath).sha256;
    }
  } catch {
    // extractGroundedFrames records the concrete fail-open reason.
  }
  const frames = asset?.media_kind === "image"
    ? resolveStillImageGrounding(asset, options.outputDir, sourceContentSha256)
    : await extractGroundedFrames({
      sourcePath,
      outputDir: options.outputDir,
      namespace: "vlm_frames",
      assetId: segment.asset_id,
      segmentId: segment.segment_id,
      segmentStartUs: segment.src_in_us,
      segmentEndUs: segment.src_out_us,
      timestampsUs: timestamps,
      sourceContentSha256,
      sourceIdentityCache: options.sourceIdentityCache,
      execFileImpl: options.frameExecFileImpl,
    });
  const frameGrounding: VlmFrameGrounding = {
    frame_count: frames.framePaths.length,
    verified_frame_paths: frames.framePaths.map((framePath) => path.resolve(framePath)),
    sample_timestamps_us: frames.sampleTimestampsUs,
    requested_sample_timestamps_us: frames.requestedSampleTimestampsUs,
    frame_cache_version: frames.cacheVersion,
    frame_producer_version: frames.producerVersion,
    frame_cache_hits: frames.cacheHits,
    ...(frames.framePaths.length > 0
      ? { frame_content_sha256: frames.framePaths.map((framePath) => sha256FileHex(framePath)) }
      : {}),
    ...(asset?.media_kind === "image" && asset.source_content_sha256
      ? { asset_source_content_sha256: asset.source_content_sha256 }
      : {}),
    ...(frames.sourceContentSha256
      ? { source_content_sha256: frames.sourceContentSha256 }
      : {}),
    segment_src_in_us: segment.src_in_us,
    segment_src_out_us: segment.src_out_us,
    ...(frames.sourceContentSha256
      ? {
        cache_identity: computeResolvedVlmCacheIdentity({
          segment,
          sourceContentSha256: frames.sourceContentSha256,
          requestedTimestampsUs: frames.requestedSampleTimestampsUs,
          policyHash: options.policyHash ?? "",
          vlmPolicy: options.vlmPolicy,
          promptHash: computePromptHash(),
        }),
      }
      : {}),
    cache_decision: options.cacheDecisions?.get(segment.segment_id)?.status === "miss"
      ? "refreshed"
      : frames.cacheDecision === "accepted" ? "accepted" : "miss",
    cache_decision_reasons: uniqueStrings([
      ...(options.cacheDecisions?.get(segment.segment_id)?.reasons ?? []),
      ...frames.cacheDecisionReasons,
    ]),
    ...(frames.failures.length > 0 ? { frame_extraction_failures: frames.failures } : {}),
  };
  if (frames.framePaths.length === 0) {
    return makeFailedResult(
      options.vlmPolicy,
      `vlm_frame_extraction_failed:${frames.failures.join(";") || "no_verified_frames"}`,
      frameGrounding,
    );
  }
  const transcriptContext = segment.transcript_excerpt || undefined;
  const retryingVlmFn: VlmFn = (retryFramePaths, prompt, callOptions) =>
    withRateLimitRetry(
      () => options.vlmFn(retryFramePaths, prompt, callOptions),
      options.retryPolicy,
      options.sleepFn,
    );

  const result = await enrichSegment(
    retryingVlmFn,
    frames.framePaths,
    segment.src_in_us,
    segment.src_out_us,
    options.vlmPolicy,
    transcriptContext,
    options.contentHint,
  );
  return {
    ...result,
    ...(!result.success && frameGrounding.cache_decision_reasons?.length
      ? {
        error: `${result.error ?? "vlm_failed"};cache_invalidated:${frameGrounding.cache_decision_reasons.join(",")}`,
      }
      : {}),
    frame_grounding: frameGrounding,
  };
}

function makeFailedResult(
  vlmPolicy: VlmPolicy,
  error: string,
  frameGrounding?: VlmFrameGrounding,
): VlmEnrichmentResult {
  return {
    success: false,
    error,
    prompt_hash: computePromptHash(),
    model_alias: vlmPolicy.model_alias,
    model_snapshot: vlmPolicy.model_snapshot,
    ...(frameGrounding ? { frame_grounding: frameGrounding } : {}),
  };
}

function summarizeErrors(errors: string[]): string {
  if (errors.length === 1) return errors[0];
  return `${errors[0]} (+${errors.length - 1} more)`;
}

function resolveVlmSampling(
  segment: SegmentItem,
  vlmPolicy: VlmPolicy,
  samplingPolicy: SamplingPolicy,
  mediaKind?: AssetItem["media_kind"],
): { frameCount: number; timestampsUs: number[] } {
  if (mediaKind === "image") return { frameCount: 1, timestampsUs: [0] };
  const durationUs = segment.src_out_us - segment.src_in_us;
  const segmentType = (segment.segment_type || "general") as SegmentType;
  let fps = getAdaptiveSampleFps(segmentType, samplingPolicy);
  fps = adjustFpsForBudget(
    durationUs,
    fps,
    vlmPolicy.segment_visual_frame_cap,
    vlmPolicy.segment_visual_token_budget_max,
  );
  const frameCount = computeFrameCount(durationUs, fps, vlmPolicy.segment_visual_frame_cap);
  return {
    frameCount,
    timestampsUs: computeSampleTimestamps(segment.src_in_us, segment.src_out_us, frameCount),
  };
}

function resolveStillImageGrounding(
  asset: AssetItem,
  outputDir: string,
  sourceContentSha256?: string,
): Awaited<ReturnType<typeof extractGroundedFrames>> {
  const framePath = asset.still_image?.normalized_frame_path
    ? path.resolve(outputDir, asset.still_image.normalized_frame_path)
    : undefined;
  const failure = !asset.source_content_sha256
    ? "still_image_asset_source_identity_missing"
    : !sourceContentSha256
      ? "still_image_live_source_identity_missing"
      : asset.source_content_sha256 !== sourceContentSha256
        ? "still_image_source_identity_mismatch"
        : !asset.still_image?.normalized_frame_content_sha256
          ? "still_image_normalized_frame_identity_missing"
          : !framePath
            ? "still_image_normalized_frame_not_recorded"
    : !fs.existsSync(framePath) || fs.statSync(framePath).size <= 0
      ? "still_image_normalized_frame_missing_or_empty"
      : sha256FileHex(framePath) !== asset.still_image?.normalized_frame_content_sha256
        ? "still_image_normalized_frame_content_mismatch"
        : undefined;
  return {
    framePaths: failure ? [] : [framePath!],
    sampleTimestampsUs: failure ? [] : [0],
    requestedSampleTimestampsUs: [0],
    cacheHits: failure ? 0 : 1,
    failures: failure ? [failure] : [],
    cacheVersion: GROUNDED_FRAME_CACHE_VERSION,
    producerVersion: "ffmpeg-normalized-still-frame-v1",
    ...(sourceContentSha256 ? { sourceContentSha256 } : {}),
    segmentStartUs: 0,
    segmentEndUs: 1,
    cacheDecision: failure ? "unavailable" : "accepted",
    cacheDecisionReasons: failure ? [failure] : ["normalized_still_frame_identity_match"],
  };
}

function computeResolvedVlmCacheIdentity(input: {
  segment: SegmentItem;
  sourceContentSha256: string;
  requestedTimestampsUs: number[];
  policyHash: string;
  vlmPolicy: VlmPolicy;
  promptHash: string;
}): string {
  return createHash("sha256").update(JSON.stringify({
    identity_version: VLM_CACHE_IDENTITY_VERSION,
    source_content_sha256: input.sourceContentSha256,
    segment_id: input.segment.segment_id,
    segment_src_in_us: input.segment.src_in_us,
    segment_src_out_us: input.segment.src_out_us,
    requested_sample_timestamps_us: input.requestedTimestampsUs,
    policy_hash: input.policyHash,
    model_alias: input.vlmPolicy.model_alias,
    model_snapshot: input.vlmPolicy.model_snapshot,
    prompt_template_id: PROMPT_TEMPLATE_ID,
    prompt_hash: input.promptHash,
    response_format: input.vlmPolicy.response_format,
    provenance_schema_version: VLM_PROVENANCE_SCHEMA_VERSION,
    connector_version: VLM_CONNECTOR_VERSION,
    frame_cache_version: GROUNDED_FRAME_CACHE_VERSION,
    frame_producer_version: GROUNDED_FRAME_PRODUCER_VERSION,
  })).digest("hex");
}

function resolveExpectedVlmCacheIdentity(
  segment: SegmentItem,
  options: HydrateCachedVlmSegmentsOptions,
  promptHash: string,
): {
  sourceContentSha256: string;
  requestedTimestampsUs: number[];
  cacheIdentity: string;
} | { error: string } {
  if (!options.samplingPolicy || !options.sourceFileMap || !options.outputDir) {
    return { error: "cache_validation_context_unavailable" };
  }
  const sourcePath = options.sourceFileMap.get(segment.asset_id);
  if (!sourcePath) return { error: "source_file_not_mapped" };
  let sourceContentSha256: string;
  try {
    sourceContentSha256 = (options.sourceIdentityCache ?? new SourceContentIdentityCache())
      .resolve(sourcePath).sha256;
  } catch {
    return { error: "source_content_identity_unavailable" };
  }
  const requestedTimestampsUs = resolveVlmSampling(
    segment,
    options.vlmPolicy,
    options.samplingPolicy,
    options.assets?.find((asset) => asset.asset_id === segment.asset_id)?.media_kind,
  ).timestampsUs;
  return {
    sourceContentSha256,
    requestedTimestampsUs,
    cacheIdentity: computeResolvedVlmCacheIdentity({
      segment,
      sourceContentSha256,
      requestedTimestampsUs,
      policyHash: options.policyHash,
      vlmPolicy: options.vlmPolicy,
      promptHash,
    }),
  };
}

function markAcceptedProvenance(
  provenance: Record<string, string | number | string[] | number[]>,
): Record<string, string | number | string[] | number[]> {
  return {
    ...provenance,
    cache_decision: "accepted",
    cache_decision_reasons: ["cache_identity_match", "verified_frame_cache_match"],
  };
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function sameNumbers(value: unknown, expected: number[]): boolean {
  return Array.isArray(value) && value.length === expected.length &&
    value.every((item, index) => item === expected[index]);
}

function getVlmCacheMismatchReasons(
  provenance: Record<string, unknown> | undefined,
  segment: SegmentItem,
  options: HydrateCachedVlmSegmentsOptions,
  expectedPromptHash: string,
): string[] {
  if (!provenance) return ["provenance_missing"];
  const reasons: string[] = [];
  if (provenance.stage !== "vlm") reasons.push("stage_mismatch");
  if (provenance.connector_version !== VLM_CONNECTOR_VERSION) reasons.push("producer_revision_mismatch");
  if (provenance.model_alias !== options.vlmPolicy.model_alias) reasons.push("model_alias_mismatch");
  if (provenance.model_snapshot !== options.vlmPolicy.model_snapshot) reasons.push("model_snapshot_mismatch");
  if (provenance.prompt_template_id && provenance.prompt_template_id !== PROMPT_TEMPLATE_ID) {
    reasons.push("prompt_template_mismatch");
  }
  if (provenance.prompt_hash !== expectedPromptHash) reasons.push("prompt_hash_mismatch");
  if (provenance.response_format !== options.vlmPolicy.response_format) reasons.push("response_schema_mismatch");
  if (provenance.provenance_schema_version !== VLM_PROVENANCE_SCHEMA_VERSION) reasons.push("provenance_schema_mismatch");
  if (provenance.frame_cache_version !== GROUNDED_FRAME_CACHE_VERSION) reasons.push("frame_cache_revision_mismatch");
  const asset = options.assets?.find((item) => item.asset_id === segment.asset_id);
  const expectedFrameProducer = asset?.media_kind === "image"
    ? "ffmpeg-normalized-still-frame-v1"
    : GROUNDED_FRAME_PRODUCER_VERSION;
  if (provenance.frame_producer_version !== expectedFrameProducer) reasons.push("frame_producer_revision_mismatch");
  if (typeof provenance.frame_count !== "number" || provenance.frame_count < 1) reasons.push("verified_frame_count_missing");
  if (
    !Array.isArray(provenance.sample_timestamps_us) ||
    provenance.sample_timestamps_us.length !== provenance.frame_count
  ) reasons.push("verified_frame_timestamps_mismatch");
  if (provenance.policy_hash !== options.policyHash) reasons.push("policy_hash_mismatch");

  const expected = resolveExpectedVlmCacheIdentity(segment, options, expectedPromptHash);
  if ("error" in expected) {
    reasons.push(expected.error);
    return uniqueStrings(reasons);
  }
  if (provenance.source_content_sha256 !== expected.sourceContentSha256) reasons.push("source_content_mismatch");
  if (provenance.segment_src_in_us !== segment.src_in_us || provenance.segment_src_out_us !== segment.src_out_us) {
    reasons.push("segment_range_mismatch");
  }
  if (!sameNumbers(provenance.requested_sample_timestamps_us, expected.requestedTimestampsUs)) {
    reasons.push("requested_timestamps_mismatch");
  }
  if (provenance.cache_identity !== expected.cacheIdentity) reasons.push("cache_identity_mismatch");

  if (asset?.media_kind === "image") {
    const still = resolveStillImageGrounding(asset, options.outputDir!, expected.sourceContentSha256);
    if (still.framePaths.length !== 1) reasons.push(...still.failures);
    const recordedHashes = Array.isArray(provenance.frame_content_sha256)
      ? provenance.frame_content_sha256
      : [];
    if (recordedHashes.length !== 1 || recordedHashes[0] !== asset.still_image?.normalized_frame_content_sha256) {
      reasons.push("normalized_still_frame_hash_mismatch");
    }
    if (provenance.asset_source_content_sha256 !== asset.source_content_sha256) {
      reasons.push("asset_source_content_mismatch");
    }
  } else {
    const frameInspection = inspectGroundedFrameCache({
      sourcePath: options.sourceFileMap!.get(segment.asset_id),
      outputDir: options.outputDir!,
      namespace: "vlm_frames",
      assetId: segment.asset_id,
      segmentId: segment.segment_id,
      segmentStartUs: segment.src_in_us,
      segmentEndUs: segment.src_out_us,
      timestampsUs: expected.requestedTimestampsUs,
      sourceContentSha256: expected.sourceContentSha256,
      sourceIdentityCache: options.sourceIdentityCache,
    });
    if (!frameInspection.accepted) reasons.push(...frameInspection.reasons);
  }
  return uniqueStrings(reasons);
}

function getObservationCacheMismatchReasons(cached: SegmentItem): string[] {
  const observation = cached.editorial_observation;
  const producer = observation?.provenance.producers.find((item) => item.producer === "grounded_vlm");
  const snapshot = observation?.producer_snapshots?.grounded_vlm;
  if (!observation || !producer || !snapshot) return ["editorial_observation_snapshot_missing"];
  const tagsProvenance = cached.provenance?.tags;
  const expectedFrameCount = numberRecordValue(tagsProvenance, "frame_count");
  const expectedSourceHash = stringRecordValue(tagsProvenance, "source_content_sha256");
  const expectedCacheIdentity = stringRecordValue(tagsProvenance, "cache_identity");
  const reasons: string[] = [];
  const groundedEvidence = observation.evidence.filter((item) =>
    item.producer === "grounded_vlm" && item.evidence_type === "verified_frame"
  );
  const snapshotEvidence = snapshot.evidence.filter((item) => item.evidence_type === "verified_frame");
  if (producer.actual_verified_frame_count < 1) reasons.push("observation_verified_frame_count_missing");
  if (expectedFrameCount !== undefined && producer.actual_verified_frame_count !== expectedFrameCount) {
    reasons.push("observation_verified_frame_count_mismatch");
  }
  if (expectedSourceHash && producer.source_content_sha256 !== expectedSourceHash) {
    reasons.push("observation_source_identity_mismatch");
  }
  if (expectedCacheIdentity && producer.cache_identity !== expectedCacheIdentity) {
    reasons.push("observation_cache_identity_mismatch");
  }
  if (groundedEvidence.length !== producer.actual_verified_frame_count) {
    reasons.push("observation_evidence_count_mismatch");
  }
  if (snapshot.producer.cache_identity !== producer.cache_identity ||
      snapshot.producer.actual_verified_frame_count !== producer.actual_verified_frame_count) {
    reasons.push("observation_snapshot_provenance_mismatch");
  }
  if (!sameStringSet(snapshotEvidence.map((item) => item.evidence_ref), groundedEvidence.map((item) => item.evidence_ref))) {
    reasons.push("observation_snapshot_evidence_mismatch");
  }
  if (!sameStringSet(producer.evidence_refs, groundedEvidence.map((item) => item.evidence_ref))) {
    reasons.push("observation_evidence_refs_mismatch");
  }
  if (groundedEvidence.some((item) => !isExistingAbsoluteNonEmptyFile(item.artifact_ref))) {
    reasons.push("observation_evidence_artifact_invalid");
  }
  return reasons;
}

function isExistingAbsoluteNonEmptyFile(filePath: string | undefined): boolean {
  if (!filePath || !path.isAbsolute(filePath)) return false;
  try {
    const stat = fs.statSync(filePath);
    return stat.isFile() && stat.size > 0;
  } catch {
    return false;
  }
}

function sameStringSet(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value) => right.includes(value));
}

function stringRecordValue(record: SegmentItem["provenance"]["tags"], key: string): string | undefined {
  const value = record?.[key];
  return typeof value === "string" ? value : undefined;
}

function numberRecordValue(record: SegmentItem["provenance"]["tags"], key: string): number | undefined {
  const value = record?.[key];
  return typeof value === "number" ? value : undefined;
}

function isGroundedVlmResult(result: VlmEnrichmentResult): boolean {
  const grounding = result.frame_grounding;
  return grounding !== undefined &&
    grounding.frame_count > 0 &&
    grounding.sample_timestamps_us.length === grounding.frame_count &&
    grounding.verified_frame_paths?.length === grounding.frame_count &&
    countVerifiedGroundedFramePairs(result) === grounding.frame_count;
}

function countVerifiedGroundedFramePairs(result: VlmEnrichmentResult): number {
  const grounding = result.frame_grounding;
  if (!grounding) return 0;
  const framePaths = grounding.verified_frame_paths ?? [];
  return framePaths.slice(0, grounding.frame_count).reduce((count, framePath, index) => {
    const timestampUs = grounding.sample_timestamps_us[index];
    return count + (Number.isInteger(timestampUs) && isExistingAbsoluteNonEmptyFile(framePath) ? 1 : 0);
  }, 0);
}

function invalidateIncompatibleVlmFields(
  segment: SegmentItem,
  options: HydrateCachedVlmSegmentsOptions,
  expectedPromptHash: string,
): void {
  delete segment.editorial_observation;
  const summaryInvalid = isIncompatibleVlmProvenance(
    segment.provenance?.summary,
    segment,
    options,
    expectedPromptHash,
  );
  const tagsInvalid = isIncompatibleVlmProvenance(
    segment.provenance?.tags,
    segment,
    options,
    expectedPromptHash,
  );
  const qualityFlagsInvalid = isIncompatibleVlmProvenance(
    segment.provenance?.quality_flags,
    segment,
    options,
    expectedPromptHash,
  );
  const visualQualityProvenance = (
    segment.provenance as Record<string, Record<string, unknown> | undefined>
  ).visual_quality;
  const visualQualityInvalid = isIncompatibleVlmProvenance(
    visualQualityProvenance,
    segment,
    options,
    expectedPromptHash,
  );
  const invalidVisualResult = summaryInvalid || tagsInvalid || qualityFlagsInvalid ||
    visualQualityInvalid;

  if (summaryInvalid && !hasMarlinOwnedSummary(segment)) {
    segment.summary = "";
    delete segment.confidence.summary;
    delete segment.provenance.summary;
  }
  if (tagsInvalid) {
    segment.tags = [];
    delete segment.confidence.tags;
    delete segment.provenance.tags;
  }
  if (qualityFlagsInvalid) {
    segment.quality_flags = segment.quality_flags.filter((flag) => !VLM_QUALITY_FLAGS.has(flag));
    delete segment.confidence.quality_flags;
    delete segment.provenance.quality_flags;
  }
  if (visualQualityInvalid) {
    delete (segment as SegmentWithVisualQuality).visual_quality;
    delete (
      segment.provenance as Record<string, Record<string, unknown> | undefined>
    ).visual_quality;
  }
  if (invalidVisualResult && !hasMarlinOwnedSummary(segment)) {
    segment.interest_points = [];
  }
}

function isIncompatibleVlmProvenance(
  provenance: Record<string, unknown> | undefined,
  segment: SegmentItem,
  options: HydrateCachedVlmSegmentsOptions,
  expectedPromptHash: string,
): boolean {
  return provenance?.stage === "vlm" &&
    getVlmCacheMismatchReasons(provenance, segment, options, expectedPromptHash).length > 0;
}

function hasMarlinOwnedSummary(segment: SegmentItem): boolean {
  const provenance = segment.provenance?.summary as Record<string, string> | undefined;
  if (!provenance) return false;
  return provenance.method === MARLIN_REPORTER_METHOD ||
    provenance.source_pass === MARLIN_REPORTER_METHOD ||
    (
      provenance.stage === "marlin" &&
      provenance.prompt_template_id === MARLIN_SUMMARY_PROMPT_TEMPLATE_ID
    );
}

function mergeTags(current: string[], additions: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of [...current, ...additions]) {
    const tag = value.trim();
    if (!tag || seen.has(tag)) continue;
    seen.add(tag);
    result.push(tag);
  }
  return result;
}

function mergeInterestPoints(
  current: SegmentItem["interest_points"],
  additions: SegmentItem["interest_points"] | undefined,
): SegmentItem["interest_points"] {
  const result = [...(current ?? [])].map((point) => ({ ...point }));
  for (const point of additions ?? []) {
    const exists = result.some((item) =>
      Math.abs(item.frame_us - point.frame_us) <= 1 &&
      item.label === point.label
    );
    if (!exists) {
      result.push({ ...point });
    }
  }
  result.sort((a, b) => a.frame_us - b.frame_us || a.label.localeCompare(b.label));
  return result;
}

function cloneVisualQuality(visualQuality: VlmVisualQuality): VlmVisualQuality {
  return {
    scores: { ...visualQuality.scores },
    labels: {
      lighting_style: [...visualQuality.labels.lighting_style],
      composition_tags: [...visualQuality.labels.composition_tags],
      expression_tags: [...visualQuality.labels.expression_tags],
      motion_tags: [...visualQuality.labels.motion_tags],
    },
  };
}
