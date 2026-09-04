export interface MarlinModelRecord {
  provider: "marlin";
  model_alias: string;
  model_snapshot: string;
  connector_version?: string;
  inference_mode?: "live" | "mock";
}

export interface MarlinRawEvent {
  start?: number;
  end?: number;
  start_sec?: number;
  end_sec?: number;
  description?: string;
  confidence?: number;
}

export interface MarlinRawCaption {
  scene?: string;
  caption?: string;
  events?: MarlinRawEvent[];
}

export interface MarlinRawFind {
  query?: string;
  span?: [number, number] | null;
  format_ok?: boolean;
  confidence?: number;
  raw?: string;
}

/** Per-request bounds for caption generation (bounded inference). */
export interface MarlinCaptionOptions {
  /** Hard upper bound on generated tokens for this caption request. */
  maxNewTokens?: number;
}

export interface MarlinFn {
  caption(videoPath: string, options?: MarlinCaptionOptions): Promise<MarlinRawCaption>;
  find(videoPath: string, event: string): Promise<MarlinRawFind>;
  close?(): Promise<void>;
}

export interface MarlinEvent {
  event_id: string;
  start_us: number;
  end_us: number;
  description: string;
  confidence?: number;
  source_pass?: "marlin_caption" | "marlin_find";
  chunk_index?: number;
  chunk_offset_us?: number;
}

export interface MarlinFindResult {
  query: string;
  span_start_us: number | null;
  span_end_us: number | null;
  format_ok: boolean;
  confidence?: number;
  raw?: string;
}

/** Which bounded operation failed for a chunk or asset. */
export type MarlinFailureStage = "probe" | "proxy" | "caption" | "find";

/** Shared failure classification (same classes as pipeline readiness reasons). */
export type MarlinFailureReasonClass =
  | "marlin_worker_timeout"
  | "marlin_model_unavailable"
  | "marlin_worker_unavailable"
  | "marlin_worker_failure";

/**
 * Non-secret degraded metadata for a failed chunk operation. Successful
 * events and find results are always preserved alongside these records.
 * Raw error text and raw query strings are deliberately excluded: only the
 * failure location (stage/chunk), a stable reason class, and a non-secret
 * query ordinal are stored.
 */
export interface MarlinFailureRecord {
  stage: MarlinFailureStage;
  reason_class: MarlinFailureReasonClass;
  /** Present when the failure is attributable to one chunk. */
  chunk_index?: number;
  /** Ordinal into the run's resolved find queries; never the query text. */
  query_index?: number;
}

export interface MarlinAssetEvents {
  asset_id: string;
  source_path: string;
  scene: string;
  caption?: string;
  events: MarlinEvent[];
  find_results: MarlinFindResult[];
  /** "degraded" when failures[] is non-empty; absent/complete otherwise. */
  evaluation_status?: "complete" | "degraded";
  failures?: MarlinFailureRecord[];
  /**
   * Chunk indices whose evaluation fully completed even when they produced
   * zero events, so resume does not re-run them.
   */
  completed_chunks?: number[];
  /**
   * Binding of this checkpoint to its inputs (source identity, chunk
   * plan/policy, model snapshot). Mismatched items are re-evaluated.
   */
  checkpoint_signature?: string;
}

export interface MarlinEventsArtifact {
  project_id: string;
  artifact_version: string;
  model: MarlinModelRecord;
  items: MarlinAssetEvents[];
}
