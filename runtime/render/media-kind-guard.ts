import * as fs from "node:fs";
import * as path from "node:path";
import { mediaKindForExtension, type MediaKind } from "../media/media-kind-registry.js";
import { enumerateTimelineClipValues } from "../timeline/track-clips.js";
import type { TimelineIR } from "../compiler/types.js";
import { CanonicalRenderInputError, isImageMediaTruth, resolveCanonicalRenderInputs } from "./canonical-render-input.js";

export class MediaKindRenderNotSupportedError extends Error {
  readonly code = "render_not_supported" as const;

  constructor(readonly assetIds: string[], readonly owner: string, readonly mediaKind: MediaKind) {
    super(`render_not_supported: ${mediaKind} timeline rendering is pending ${owner}; blocked asset(s): ${assetIds.join(", ")}`);
    this.name = "MediaKindRenderNotSupportedError";
  }
}

type TimelineLike = {
  tracks?: {
    video?: Array<{ clips?: unknown[] }>;
    audio?: Array<{ clips?: unknown[] }>;
    overlay?: Array<{ clips?: unknown[] }>;
    caption?: Array<{ clips?: unknown[] }>;
  };
};

export interface TimelineRenderSupportContext {
  projectDir?: string;
  timelinePath?: string;
  /** asset_id -> locator, LoadedSourceMap, or source-map-like entries. */
  sourceLocators?: unknown;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function standardProjectDirFromTimelinePath(timelinePath: string | undefined): string | undefined {
  if (!timelinePath) return undefined;
  const absolute = path.resolve(timelinePath);
  const timelineDir = path.dirname(absolute);
  return path.basename(timelineDir) === "05_timeline" ? path.dirname(timelineDir) : undefined;
}

function addKind(kinds: Map<string, Set<MediaKind>>, assetId: unknown, kind: unknown): void {
  if (typeof assetId !== "string" || (kind !== "image" && kind !== "sequence")) return;
  const values = kinds.get(assetId) ?? new Set<MediaKind>();
  values.add(kind);
  kinds.set(assetId, values);
}

function addLocatorKind(kinds: Map<string, Set<MediaKind>>, assetId: unknown, locator: unknown): void {
  if (typeof locator !== "string") return;
  addKind(kinds, assetId, mediaKindForExtension(locator));
}

function collectSourceEntry(kinds: Map<string, Set<MediaKind>>, value: unknown, fallbackAssetId?: string): void {
  if (typeof value === "string") {
    addLocatorKind(kinds, fallbackAssetId, value);
    return;
  }
  const entry = record(value);
  if (!entry) return;
  const assetId = typeof entry.asset_id === "string" ? entry.asset_id : fallbackAssetId;
  if (isImageMediaTruth(entry)) addKind(kinds, assetId, "image");
  addKind(kinds, assetId, entry.media_kind);
  for (const key of ["source_locator", "local_source_path", "link_path", "filename"]) {
    addLocatorKind(kinds, assetId, entry[key]);
  }
}

function collectPassedSourceLocators(kinds: Map<string, Set<MediaKind>>, value: unknown): void {
  if (value instanceof Map) {
    for (const [assetId, entry] of value) {
      collectSourceEntry(kinds, entry, typeof assetId === "string" ? assetId : undefined);
    }
    return;
  }
  const source = record(value);
  if (!source) return;
  for (const key of ["entryMap", "locatorMap"]) {
    if (source[key] instanceof Map) collectPassedSourceLocators(kinds, source[key]);
  }
  if (Array.isArray(source.entries)) {
    for (const entry of source.entries) collectSourceEntry(kinds, entry);
  }
  const document = record(source.document);
  if (Array.isArray(document?.items)) {
    for (const entry of document.items) collectSourceEntry(kinds, entry);
  }
  const sourceMapShape = "entryMap" in source || "locatorMap" in source || "entries" in source || "document" in source;
  if (!sourceMapShape) {
    for (const [assetId, entry] of Object.entries(source)) collectSourceEntry(kinds, entry, assetId);
  }
}

function readJson(filePath: string): unknown {
  if (!fs.existsSync(filePath)) return undefined;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return undefined;
  }
}

function collectProjectTruth(kinds: Map<string, Set<MediaKind>>, projectDir: string): void {
  const assets = record(readJson(path.join(projectDir, "03_analysis", "assets.json")));
  if (Array.isArray(assets?.items)) {
    for (const value of assets.items) {
      const asset = record(value);
      if (!asset) continue;
      collectSourceEntry(kinds, asset);
      if (record(asset.still_image) || asset.duration_semantics === "single_frame_zero_duration" || asset.frame_rate_mode === "still_image") {
        addKind(kinds, asset.asset_id, "image");
      }
    }
  }

  for (const relative of ["02_media/source_map.json", "03_analysis/source_map.json"]) {
    const sourceMap = record(readJson(path.join(projectDir, relative)));
    if (Array.isArray(sourceMap?.items)) {
      for (const entry of sourceMap.items) collectSourceEntry(kinds, entry);
    } else if (Array.isArray(sourceMap?.source_map)) {
      for (const entry of sourceMap.source_map) collectSourceEntry(kinds, entry);
    } else if (sourceMap) {
      for (const [assetId, entry] of Object.entries(sourceMap)) collectSourceEntry(kinds, entry, assetId);
    }
  }
}

export function assertTimelineRenderSupported(
  timeline: TimelineLike,
  context: TimelineRenderSupportContext = {},
): void {
  const authoritativeKinds = new Map<string, Set<MediaKind>>();
  const projectDir = context.projectDir
    ? path.resolve(context.projectDir)
    : standardProjectDirFromTimelinePath(context.timelinePath);
  if (projectDir) collectProjectTruth(authoritativeKinds, projectDir);
  collectPassedSourceLocators(authoritativeKinds, context.sourceLocators);

  const blockedImages = new Set<string>();
  const blockedSequences = new Set<string>();
  for (const value of enumerateTimelineClipValues(timeline)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const clip = value as { asset_id?: unknown; media_kind?: unknown; still_image?: unknown };
    const assetId = typeof clip.asset_id === "string" ? clip.asset_id : "unknown";
    const external = authoritativeKinds.get(assetId) ?? new Set<MediaKind>();
    if (clip.media_kind === "image" || (clip.still_image !== null && typeof clip.still_image === "object") || external.has("image")) {
      blockedImages.add(assetId);
    }
    if (clip.media_kind === "sequence" || external.has("sequence")) blockedSequences.add(assetId);
  }
  if (blockedImages.size > 0 || blockedSequences.size > 0) {
    if (!projectDir) {
      throw new CanonicalRenderInputError(
        blockedImages.size > 0 ? "image_project_root_unresolved" : "sequence_project_root_unresolved",
        "Derived-media timeline requires projectDir or a standard 05_timeline/timeline.json path",
      );
    }
    resolveCanonicalRenderInputs(timeline as TimelineIR, {
      projectDir,
      timelinePath: context.timelinePath,
      sourceOverrides: record(context.sourceLocators) as Record<string, string> | undefined,
    });
  }
}
