import * as fs from "node:fs";
import * as path from "node:path";
import type { TimelineIR } from "../compiler/types.js";
import { loadSourceMap } from "../media/source-map.js";
import {
  CanonicalRenderInputError,
  resolveCanonicalRenderInputs,
} from "../render/canonical-render-input.js";

export class ImageSequenceGroundingError extends Error {
  readonly code = "IMAGE_SEQUENCE_GROUNDING_INVALID";
  constructor(readonly issues: string[]) {
    super(`image_sequence_grounding_invalid: ${issues.join("; ")}`);
    this.name = "ImageSequenceGroundingError";
  }
}

function authoritativeSequenceAssetIds(projectDir: string): Set<string> {
  const result = new Set<string>();
  const assetsPath = path.join(projectDir, "03_analysis", "assets.json");
  if (fs.existsSync(assetsPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(assetsPath, "utf8")) as { items?: unknown[] };
      for (const value of parsed.items ?? []) {
        if (!value || typeof value !== "object" || Array.isArray(value)) continue;
        const asset = value as { asset_id?: unknown; media_kind?: unknown; image_sequence?: unknown };
        if (typeof asset.asset_id === "string" && (asset.media_kind === "sequence" || asset.image_sequence)) {
          result.add(asset.asset_id);
        }
      }
    } catch {
      // Canonical artifact parsing remains fail-closed below when an expected ID is missing.
    }
  }
  for (const entry of loadSourceMap(projectDir).entries) {
    if (entry.media_kind === "sequence" || entry.image_sequence) result.add(entry.asset_id);
  }
  return result;
}

function validateExpectedSequenceAssets(projectDir: string, expectedAssetIds: string[]): Set<string> {
  const assetIds = new Set([...authoritativeSequenceAssetIds(projectDir), ...expectedAssetIds]);
  if (assetIds.size === 0) return assetIds;
  const clips = [...assetIds].sort().map((assetId) => ({
    asset_id: assetId,
    media_kind: "sequence" as const,
  }));
  const timeline = {
    tracks: { video: [{ clips }], audio: [], caption: [], overlay: [] },
  } as unknown as TimelineIR;
  try {
    const canonical = resolveCanonicalRenderInputs(timeline, {
      projectDir,
      includeAudio: false,
    });
    const missing = clips
      .filter((clip) => !canonical.byAssetId.has(clip.asset_id))
      .map((clip) => `${clip.asset_id}:canonical_sequence_input_missing`);
    if (missing.length > 0) throw new ImageSequenceGroundingError(missing);
  } catch (error) {
    if (error instanceof ImageSequenceGroundingError) throw error;
    if (error instanceof CanonicalRenderInputError) {
      throw new ImageSequenceGroundingError([`${error.assetId ?? "unknown"}:${error.reason}`]);
    }
    throw error;
  }
  return assetIds;
}

export function assertImageSequenceGrounding(projectDir: string): void {
  validateExpectedSequenceAssets(path.resolve(projectDir), []);
}

export function assertImageSequenceCandidateGrounding(
  projectDir: string,
  candidates: Array<{ asset_id?: unknown; media_kind?: unknown }>,
): void {
  const expected = candidates
    .filter((candidate) => candidate.media_kind === "sequence")
    .map((candidate) => typeof candidate.asset_id === "string" ? candidate.asset_id : "unknown");
  const validated = validateExpectedSequenceAssets(path.resolve(projectDir), expected);
  const missing = [...new Set(expected)].filter((assetId) => !validated.has(assetId)).sort()
    .map((assetId) => `${assetId}:candidate_sequence_asset_not_grounded`);
  if (missing.length > 0) throw new ImageSequenceGroundingError(missing);
}
