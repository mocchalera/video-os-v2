/**
 * Resolves canonical asset IDs back to source paths for artifact-only routes.
 *
 * Candidate order is intentional: persisted source-map identities win over
 * asset metadata and project-layout fallbacks.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { loadSourceMap } from "../media/source-map.js";
import type { AssetsJson } from "./pipeline-types.js";

export function restoreSourceFileMap(
  absProjectDir: string,
  assetsJson: AssetsJson,
  sourceFiles: string[],
): Map<string, string> {
  const sourceMap = loadSourceMap(absProjectDir);
  const sourceFilesByBasename = new Map<string, string>();
  for (const file of sourceFiles) {
    if (!sourceFilesByBasename.has(path.basename(file))) {
      sourceFilesByBasename.set(path.basename(file), file);
    }
  }

  const result = new Map<string, string>();
  for (const asset of assetsJson.items) {
    const entry = sourceMap.entryMap.get(asset.asset_id);
    const candidates = uniqueStrings([
      entry?.local_source_path,
      entry?.source_locator,
      asset.source_locator ? resolveProjectPath(absProjectDir, asset.source_locator) : undefined,
      asset.image_sequence?.analysis_proxy_path
        ? path.resolve(absProjectDir, "03_analysis", asset.image_sequence.analysis_proxy_path)
        : undefined,
      sourceFilesByBasename.get(asset.filename),
      resolveProjectPath(absProjectDir, asset.filename),
      resolveProjectPath(absProjectDir, path.join("00_sources", asset.filename)),
      resolveProjectPath(absProjectDir, path.join("02_media", asset.filename)),
    ]);
    const existing = candidates.find((candidate) => fs.existsSync(candidate));
    const selected = existing ?? candidates[0];
    if (selected) {
      result.set(asset.asset_id, selected);
    }
    if (!existing) {
      console.warn(
        `[pipeline] --vlm-only: source file not found for ${asset.asset_id}; source-dependent fallbacks may be skipped`,
      );
    }
  }
  return result;
}

function resolveProjectPath(absProjectDir: string, value: string): string {
  return path.isAbsolute(value) ? value : path.resolve(absProjectDir, value);
}

function uniqueStrings(values: Array<string | undefined>): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (!value || seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
}
