import * as path from "node:path";

export type MediaSourceOrigin =
  | "original_source"
  | "rendered_output"
  | "verified_caption_free_proxy";

const GENERATED_VIDEO_LANES = new Set([
  "05_timeline",
  "06_review",
  "07_package",
  "09_output",
]);

/**
 * Detect repository-managed render/output lanes without relying on a filename.
 * An explicit `original_source` declaration never overrides this evidence.
 */
export function isKnownGeneratedVideoPath(sourcePath: string): boolean {
  const segments = path.resolve(sourcePath).split(path.sep).filter(Boolean);
  return segments.some((segment) => GENERATED_VIDEO_LANES.has(segment));
}
