/**
 * Restores reusable derivative, segment, and cache state from analysis artifacts.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { DerivativeResults, ContactSheetManifest } from "../connectors/ffmpeg-derivatives.js";
import type { SegmentItem } from "../connectors/ffmpeg-segmenter.js";
import type { AssetItem } from "../connectors/ffprobe.js";
import type { SourceContentIdentityCache } from "../source-content-identity.js";
import { computeCacheHash, type CacheManifestEntry } from "./analysis-cache.js";
import type { AssetsJson, SegmentsJson } from "./pipeline-types.js";
import { readJsonIfExists } from "./stages/_util.js";

export function loadExistingDerivativeResults(
  assetsJson: AssetsJson,
  segmentsJson: SegmentsJson,
  outputDir: string,
): Map<string, DerivativeResults> {
  const result = new Map<string, DerivativeResults>();
  const segmentsByAsset = groupSegmentsByAsset(segmentsJson.items);

  for (const asset of assetsJson.items) {
    const contactSheets: ContactSheetManifest[] = [];
    for (const contactSheetId of asset.contact_sheet_ids ?? []) {
      const manifestPath = path.join(outputDir, "contact_sheets", `${contactSheetId}.json`);
      const manifest = readJsonIfExists<ContactSheetManifest>(manifestPath);
      if (!manifest) {
        console.warn(
          `[pipeline] --vlm-only: missing contact sheet manifest ${manifestPath}; peak detection may skip ${asset.asset_id}`,
        );
        continue;
      }
      if (!derivativeRelPathExists(outputDir, manifest.image_path)) {
        console.warn(
          `[pipeline] --vlm-only: missing contact sheet image ${manifest.image_path}; peak detection may skip ${asset.asset_id}`,
        );
        continue;
      }
      contactSheets.push(manifest);
    }

    const posterPath = readExistingDerivativePath(outputDir, asset.poster_path, `${asset.asset_id} poster`);
    const waveformPath = readExistingDerivativePath(outputDir, asset.waveform_path, `${asset.asset_id} waveform`);
    const filmstripPaths = new Map<string, string>();
    for (const segment of segmentsByAsset.get(asset.asset_id) ?? []) {
      if (!segment.filmstrip_path) continue;
      if (!derivativeRelPathExists(outputDir, segment.filmstrip_path)) {
        console.warn(
          `[pipeline] --vlm-only: missing filmstrip ${segment.filmstrip_path}; peak detection may use contact sheet fallback`,
        );
        continue;
      }
      filmstripPaths.set(segment.segment_id, segment.filmstrip_path);
    }

    result.set(asset.asset_id, {
      contactSheets,
      posterPath,
      filmstripPaths,
      waveformPath,
    });
  }

  return result;
}

export function preserveVlmOnlySegmentFields(
  nextSegmentsJson: SegmentsJson,
  originalSegmentsJson: SegmentsJson,
): SegmentsJson {
  const originalById = new Map(
    originalSegmentsJson.items.map((segment) => [segment.segment_id, segment]),
  );
  return {
    ...nextSegmentsJson,
    items: nextSegmentsJson.items.map((segment) => {
      const original = originalById.get(segment.segment_id);
      if (!original) return segment;
      return {
        ...original,
        summary: segment.summary,
        tags: segment.tags,
        confidence: segment.confidence,
        provenance: segment.provenance,
        ...((segment as unknown as Record<string, unknown>).visual_quality
          ? { visual_quality: (segment as unknown as Record<string, unknown>).visual_quality }
          : {}),
        ...(segment.visual_quality_measurements
          ? { visual_quality_measurements: segment.visual_quality_measurements }
          : {}),
        ...(segment.editorial_observation
          ? { editorial_observation: segment.editorial_observation }
          : {}),
      };
    }),
  };
}

export function groupSegmentsByAsset(segments: SegmentItem[]): Map<string, SegmentItem[]> {
  const grouped = new Map<string, SegmentItem[]>();
  for (const segment of segments) {
    const current = grouped.get(segment.asset_id);
    if (current) {
      current.push(segment);
    } else {
      grouped.set(segment.asset_id, [segment]);
    }
  }
  return grouped;
}

export function buildManifestEntriesFromExistingAssets(
  assets: AssetItem[],
  sourceFileMap: Map<string, string>,
  previousManifest: CacheManifestEntry[],
  sourceIdentityCache: SourceContentIdentityCache,
): CacheManifestEntry[] {
  const now = new Date().toISOString();
  const previousByAssetId = new Map(previousManifest.map((entry) => [entry.asset_id, entry]));
  const entries: CacheManifestEntry[] = [];

  for (const asset of assets) {
    const sourcePath = sourceFileMap.get(asset.asset_id);
    if (sourcePath && fs.existsSync(sourcePath)) {
      const identity = sourceIdentityCache.resolve(sourcePath);
      entries.push({
        hash: computeCacheHash(sourcePath, identity.sizeBytes, asset.duration_us, identity.sha256),
        asset_id: asset.asset_id,
        cached_at: now,
        source_path: sourcePath,
        source_content_sha256: identity.sha256,
      });
      continue;
    }

    const previous = previousByAssetId.get(asset.asset_id);
    if (previous) {
      entries.push({ ...previous, cached_at: now });
    } else {
      console.warn(
        `[cache] --vlm-only: cache manifest entry skipped for ${asset.asset_id}; source file unavailable`,
      );
    }
  }

  return entries;
}

function readExistingDerivativePath(
  outputDir: string,
  relPath: string | undefined,
  label: string,
): string | null {
  if (!relPath) return null;
  if (derivativeRelPathExists(outputDir, relPath)) return relPath;
  console.warn(`[pipeline] --vlm-only: missing ${label} derivative ${relPath}`);
  return null;
}

function derivativeRelPathExists(outputDir: string, relPath: string | undefined): boolean {
  if (!relPath) return false;
  return fs.existsSync(path.isAbsolute(relPath) ? relPath : path.join(outputDir, relPath));
}
