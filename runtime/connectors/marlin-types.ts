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

export interface MarlinFn {
  caption(videoPath: string): Promise<MarlinRawCaption>;
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

export interface MarlinAssetEvents {
  asset_id: string;
  source_path: string;
  scene: string;
  caption?: string;
  events: MarlinEvent[];
  find_results: MarlinFindResult[];
}

export interface MarlinEventsArtifact {
  project_id: string;
  artifact_version: string;
  model: MarlinModelRecord;
  items: MarlinAssetEvents[];
}
