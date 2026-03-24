/**
 * Re-export barrel — all VLM analysis logic has moved to stages/vlm.ts.
 * This file maintains backward compatibility for existing import paths.
 */

export {
  DEFAULT_VLM_CONCURRENCY,
  DEFAULT_VLM_RETRY_POLICY,
  hydrateCachedVlmSegments,
  mapWithConcurrency,
  runParallelVlmAnalysis,
  vlmReduce,
  withRateLimitRetry,
  type HydrateCachedVlmSegmentsOptions,
  type RunParallelVlmAnalysisOptions,
  type VlmAssetFailure,
  type VlmAssetRunSummary,
  type VlmProgressEvent,
  type VlmProgressReporter,
  type VlmRetryPolicy,
  type VlmShard,
} from "./stages/vlm.js";
