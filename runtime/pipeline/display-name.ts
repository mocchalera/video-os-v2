/**
 * display_name generator — produces human-readable asset names from
 * VLM summaries and creation dates.
 *
 * Format: '{serial:02d}_{month}_{summary_short}'
 * Example: '01_aug_first_wobbly_ride', '03_sep_balance_practice'
 */

import * as fs from "node:fs";
import type { AssetItem } from "../connectors/ffprobe.js";
import type { SegmentItem } from "../connectors/ffmpeg-segmenter.js";

// ── Constants ──────────────────────────────────────────────────────

const MONTH_ABBREVS = [
  "jan", "feb", "mar", "apr", "may", "jun",
  "jul", "aug", "sep", "oct", "nov", "dec",
] as const;

const MAX_SHORT_NAME_LEN = 15;

// ── Helpers ────────────────────────────────────────────────────────

/**
 * Extract 3-letter month abbreviation from a Date.
 */
export function monthAbbrev(date: Date): string {
  return MONTH_ABBREVS[date.getMonth()];
}

/**
 * Convert a VLM summary (or tags fallback) to a short lower_snake_case label.
 * Max 15 characters. Handles non-ASCII (Japanese etc.) by stripping to ASCII
 * and falling back to tags.
 */
export function summarizeToShortName(summary: string, tags: string[]): string {
  let ascii = (summary || "").replace(/[^\x20-\x7E]/g, " ").trim();

  // If summary had no usable ASCII content, try tags
  if (ascii.length < 3 && tags.length > 0) {
    ascii = tags
      .map((t) => t.replace(/[^\x20-\x7E]/g, "").trim())
      .filter((t) => t.length > 0)
      .slice(0, 3)
      .join(" ");
  }

  // Final fallback
  if (ascii.length < 3) {
    return "clip";
  }

  // Convert to lower_snake_case
  let snake = ascii
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/_+/g, "_");

  // Truncate to MAX_SHORT_NAME_LEN, avoiding mid-word cuts
  if (snake.length > MAX_SHORT_NAME_LEN) {
    const truncated = snake.substring(0, MAX_SHORT_NAME_LEN);
    const lastUnderscore = truncated.lastIndexOf("_");
    snake =
      lastUnderscore > 5
        ? truncated.substring(0, lastUnderscore)
        : truncated.replace(/_+$/, "");
  }

  return snake;
}

/**
 * Get creation date for a source file via file stat birthtime.
 */
export function getCreationDate(filePath: string): Date {
  try {
    const stat = fs.statSync(filePath);
    return stat.birthtime;
  } catch {
    return new Date(0);
  }
}

// ── Main ───────────────────────────────────────────────────────────

export interface DisplayNameInput {
  asset: AssetItem;
  filePath: string;
  segments: SegmentItem[];
}

/**
 * Generate display_name values for a list of assets.
 *
 * Steps:
 * 1. Resolve creation date per asset (file stat birthtime)
 * 2. Sort assets by creation date
 * 3. For each asset, combine VLM summaries from its segments
 * 4. Build '{serial:02d}_{month}_{summary_short}'
 *
 * Returns a Map<asset_id, display_name>.
 */
export function generateDisplayNames(
  inputs: DisplayNameInput[],
): Map<string, string> {
  const withDates = inputs.map((input) => ({
    ...input,
    creationDate: getCreationDate(input.filePath),
  }));

  // Sort by creation date, then asset_id for determinism on ties
  withDates.sort((a, b) => {
    const dt = a.creationDate.getTime() - b.creationDate.getTime();
    if (dt !== 0) return dt;
    return a.asset.asset_id.localeCompare(b.asset.asset_id);
  });

  const result = new Map<string, string>();

  for (let i = 0; i < withDates.length; i++) {
    const { asset, segments, creationDate } = withDates[i];

    // Combine VLM summaries from segments belonging to this asset
    const combinedSummary = segments
      .filter((s) => s.summary)
      .map((s) => s.summary)
      .join(" ");

    // Combine tags from segments
    const combinedTags = segments.flatMap((s) => s.tags ?? []);

    const month = monthAbbrev(creationDate);
    const shortName = summarizeToShortName(combinedSummary, combinedTags);
    const serial = String(i + 1).padStart(2, "0");

    result.set(asset.asset_id, `${serial}_${month}_${shortName}`);
  }

  return result;
}
