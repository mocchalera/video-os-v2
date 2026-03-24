/**
 * Stage 9–10: VLM enrichment — parallel analysis + reduce.
 *
 * Merged from former vlm-analysis.ts + vlmReduce from ingest.ts.
 *
 * hydrateCachedVlmSegments — reuse cached VLM enrichment data.
 * runParallelVlmAnalysis   — per-asset VLM enrichment with concurrency.
 * vlmReduce                — merge VLM shards into segments/assets.
 */

import type { AssetItem } from "../../connectors/ffprobe.js";
import type { SegmentItem } from "../../connectors/ffmpeg-segmenter.js";
import {
  type SamplingPolicy,
  type SegmentType,
  type VlmEnrichmentResult,
  type VlmFn,
  type VlmPolicy,
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
import type { AssetsJson, SegmentsJson } from "../pipeline-types.js";

// ── Constants ──────────────────────────────────────────────────────

export const DEFAULT_VLM_CONCURRENCY = 3;

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
  contentHint?: string;
  concurrency?: number;
  retryPolicy?: Partial<VlmRetryPolicy>;
  reporter?: VlmProgressReporter;
  cachedSegmentIds?: ReadonlySet<string>;
  sleepFn?: (ms: number) => Promise<void>;
}

export interface HydrateCachedVlmSegmentsOptions {
  currentSegments: SegmentItem[];
  cachedSegments?: SegmentItem[];
  vlmPolicy: VlmPolicy;
  policyHash: string;
}

interface VlmAssetPlan {
  asset: AssetItem;
  liveSegments: SegmentItem[];
}

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
    const cached = cachedById.get(segment.segment_id);
    if (!cached) continue;

    if (!hasReusableProvenance(cached.provenance?.summary, options, expectedPromptHash)) {
      continue;
    }
    if (!hasReusableProvenance(cached.provenance?.tags, options, expectedPromptHash)) {
      continue;
    }
    if (!hasReusableProvenance(cached.provenance?.quality_flags, options, expectedPromptHash)) {
      continue;
    }

    segment.summary = cached.summary;
    segment.tags = [...cached.tags];
    segment.quality_flags = [...new Set([...segment.quality_flags, ...cached.quality_flags])];
    segment.interest_points = (cached.interest_points ?? []).map((point) => ({ ...point }));
    segment.confidence = {
      ...segment.confidence,
      ...(cached.confidence.summary ? { summary: { ...cached.confidence.summary } } : {}),
      ...(cached.confidence.tags ? { tags: { ...cached.confidence.tags } } : {}),
      ...(cached.confidence.quality_flags
        ? { quality_flags: { ...cached.confidence.quality_flags } }
        : {}),
    };
    segment.provenance = {
      ...segment.provenance,
      ...(cached.provenance.summary ? { summary: { ...cached.provenance.summary } } : {}),
      ...(cached.provenance.tags ? { tags: { ...cached.provenance.tags } } : {}),
      ...(cached.provenance.quality_flags
        ? { quality_flags: { ...cached.provenance.quality_flags } }
        : {}),
    };
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
    const segments = assetSegments.get(asset.asset_id) ?? [];
    const analyzableSegments = segments.filter((segment) => {
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
          shards.push({ segment_id: segment.segment_id, result });
          if (!result.success) {
            segmentErrors.push(`${segment.segment_id}: ${result.error ?? "unknown"}`);
          }
        } catch (error) {
          const message = `vlm_exception: ${
            error instanceof Error ? error.message : String(error)
          }`;
          shards.push({
            segment_id: segment.segment_id,
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
): { segments: SegmentsJson; assets: AssetsJson } {
  // Build lookup by segment_id
  const shardMap = new Map<string, VlmShard>();
  for (const shard of vlmShards) {
    shardMap.set(shard.segment_id, shard);
  }

  // Enrich segments
  for (const seg of segmentsJson.items) {
    const shard = shardMap.get(seg.segment_id);
    if (!shard || !shard.result.success || !shard.result.output) continue;

    const out = shard.result.output;

    // Update enrichment fields
    seg.summary = out.summary || seg.summary;
    seg.tags = out.tags.length > 0 ? out.tags : seg.tags;
    seg.quality_flags = out.quality_flags.length > 0
      ? [...new Set([...seg.quality_flags, ...out.quality_flags])]
      : seg.quality_flags;
    seg.interest_points = out.interest_points;

    // Confidence records
    if (!seg.confidence) {
      seg.confidence = {} as SegmentItem["confidence"];
    }
    (seg.confidence as Record<string, unknown>).summary = {
      score: out.confidence.summary,
      source: `${shard.result.model_alias}`,
      status: "ready",
    };
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
        frame_count: out.interest_points.length,
      }),
      model_alias: shard.result.model_alias,
      model_snapshot: shard.result.model_snapshot,
      prompt_hash: shard.result.prompt_hash,
      response_format: responseFormat,
    };
    (seg.provenance as Record<string, unknown>).summary = vlmProvenance;
    (seg.provenance as Record<string, unknown>).tags = vlmProvenance;
    (seg.provenance as Record<string, unknown>).quality_flags = vlmProvenance;
  }

  // Update asset role_guess based on combined STT + VLM evidence
  for (const asset of assetsJson.items) {
    const assetSegments = segmentsJson.items.filter((s) => s.asset_id === asset.asset_id);
    asset.role_guess = guessAssetRole(
      !!asset.has_transcript,
      assetSegments,
    );
  }

  atomicWriteJson(segmentsOutputPath, segmentsJson);
  atomicWriteJson(assetsOutputPath, assetsJson);

  return { segments: segmentsJson, assets: assetsJson };
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
  const durationUs = segment.src_out_us - segment.src_in_us;
  const segmentType = (segment.segment_type || "general") as SegmentType;
  let fps = getAdaptiveSampleFps(segmentType, options.samplingPolicy);

  fps = adjustFpsForBudget(
    durationUs,
    fps,
    options.vlmPolicy.segment_visual_frame_cap,
    options.vlmPolicy.segment_visual_token_budget_max,
  );

  const frameCount = computeFrameCount(
    durationUs,
    fps,
    options.vlmPolicy.segment_visual_frame_cap,
  );
  const timestamps = computeSampleTimestamps(
    segment.src_in_us,
    segment.src_out_us,
    frameCount,
  );
  const framePaths = timestamps.map((timestampUs) => `frame_${timestampUs}.jpg`);
  const transcriptContext = segment.transcript_excerpt || undefined;
  const retryingVlmFn: VlmFn = (retryFramePaths, prompt, callOptions) =>
    withRateLimitRetry(
      () => options.vlmFn(retryFramePaths, prompt, callOptions),
      options.retryPolicy,
      options.sleepFn,
    );

  return enrichSegment(
    retryingVlmFn,
    framePaths,
    segment.src_in_us,
    segment.src_out_us,
    options.vlmPolicy,
    transcriptContext,
    options.contentHint,
  );
}

function makeFailedResult(
  vlmPolicy: VlmPolicy,
  error: string,
): VlmEnrichmentResult {
  return {
    success: false,
    error,
    prompt_hash: computePromptHash(),
    model_alias: vlmPolicy.model_alias,
    model_snapshot: vlmPolicy.model_snapshot,
  };
}

function summarizeErrors(errors: string[]): string {
  if (errors.length === 1) return errors[0];
  return `${errors[0]} (+${errors.length - 1} more)`;
}

function hasReusableProvenance(
  provenance: Record<string, string> | undefined,
  options: HydrateCachedVlmSegmentsOptions,
  expectedPromptHash: string,
): boolean {
  if (!provenance) return false;
  if (provenance.stage !== "vlm") return false;
  if (provenance.connector_version !== VLM_CONNECTOR_VERSION) return false;
  if (provenance.model_snapshot !== options.vlmPolicy.model_snapshot) return false;
  if (provenance.prompt_hash !== expectedPromptHash) return false;
  if (provenance.policy_hash && provenance.policy_hash !== options.policyHash) return false;
  if (
    provenance.response_format &&
    provenance.response_format !== options.vlmPolicy.response_format
  ) {
    return false;
  }
  return true;
}
