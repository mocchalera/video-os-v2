import type {
  MarlinAssetEvents,
  MarlinEventsArtifact,
  MarlinFindResult,
  MarlinModelRecord,
  MarlinRawCaption,
  MarlinRawEvent,
  MarlinRawFind,
} from "./marlin-types.js";

export const MARLIN_CONNECTOR_VERSION = "marlin-local-v1";

export interface NormalizeMarlinCaptionInput {
  projectId: string;
  assetId: string;
  sourcePath: string;
  model: MarlinModelRecord;
  caption: MarlinRawCaption;
  findResults?: MarlinRawFind[];
  chunkOffsetUs?: number;
  chunkIndex?: number;
}

export function normalizeMarlinAssetEvents(input: NormalizeMarlinCaptionInput): MarlinAssetEvents {
  const chunkOffsetUs = input.chunkOffsetUs ?? 0;
  const events = (input.caption.events ?? [])
    .map((event, index) => normalizeMarlinEvent(event, input.assetId, index, chunkOffsetUs, input.chunkIndex))
    .filter((event): event is NonNullable<typeof event> => event !== null);

  const findResults = (input.findResults ?? []).map((result) => normalizeMarlinFindResult(result, chunkOffsetUs));

  return {
    asset_id: input.assetId,
    source_path: input.sourcePath,
    scene: input.caption.scene?.trim() ?? "",
    ...(input.caption.caption?.trim() ? { caption: input.caption.caption.trim() } : {}),
    events,
    find_results: findResults,
  };
}

export function createMarlinEventsArtifact(args: {
  projectId: string;
  model: MarlinModelRecord;
  items: MarlinAssetEvents[];
  artifactVersion?: string;
}): MarlinEventsArtifact {
  return {
    project_id: args.projectId,
    artifact_version: args.artifactVersion ?? "marlin-events-v1",
    model: {
      ...args.model,
      connector_version: args.model.connector_version ?? MARLIN_CONNECTOR_VERSION,
    },
    items: args.items,
  };
}

export function secondsToMicroseconds(value: number, offsetUs = 0): number {
  if (!Number.isFinite(value)) {
    return offsetUs;
  }
  return Math.max(0, Math.round(value * 1_000_000) + offsetUs);
}

export function normalizeMarlinEvent(
  raw: MarlinRawEvent,
  assetId: string,
  index: number,
  chunkOffsetUs = 0,
  chunkIndex?: number,
) {
  const startSec = raw.start_sec ?? raw.start;
  const endSec = raw.end_sec ?? raw.end;
  const description = raw.description?.trim();

  if (startSec === undefined || endSec === undefined || !description) {
    return null;
  }

  const startUs = secondsToMicroseconds(startSec, chunkOffsetUs);
  const endUs = secondsToMicroseconds(endSec, chunkOffsetUs);
  if (endUs <= startUs) {
    return null;
  }

  const eventNumber = String(index + 1).padStart(4, "0");
  const chunkPart = chunkIndex !== undefined
    ? `_C${String(chunkIndex + 1).padStart(4, "0")}`
    : "";

  return {
    event_id: `MEV_${sanitizeIdPart(assetId)}${chunkPart}_${eventNumber}`,
    start_us: startUs,
    end_us: endUs,
    description,
    ...(raw.confidence !== undefined ? { confidence: clamp01(raw.confidence) } : {}),
    source_pass: "marlin_caption" as const,
    ...(chunkIndex !== undefined ? { chunk_index: chunkIndex } : {}),
    ...(chunkOffsetUs > 0 ? { chunk_offset_us: chunkOffsetUs } : {}),
  };
}

export function normalizeMarlinFindResult(raw: MarlinRawFind, chunkOffsetUs = 0): MarlinFindResult {
  const query = raw.query?.trim() ?? "";
  const span = Array.isArray(raw.span) && raw.span.length === 2 ? raw.span : null;
  const hasValidSpan = Boolean(span && Number.isFinite(span[0]) && Number.isFinite(span[1]) && span[1] > span[0]);

  return {
    query,
    span_start_us: hasValidSpan ? secondsToMicroseconds(span![0], chunkOffsetUs) : null,
    span_end_us: hasValidSpan ? secondsToMicroseconds(span![1], chunkOffsetUs) : null,
    format_ok: raw.format_ok ?? hasValidSpan,
    ...(raw.confidence !== undefined ? { confidence: clamp01(raw.confidence) } : {}),
    ...(raw.raw !== undefined ? { raw: raw.raw } : {}),
  };
}

export function sanitizeIdPart(value: string): string {
  const sanitized = value.replace(/[^A-Za-z0-9_-]/g, "_").replace(/_+/g, "_").replace(/^_+|_+$/g, "");
  return sanitized || "ASSET";
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.min(1, Math.max(0, value));
}
