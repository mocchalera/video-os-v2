export const MAX_THUMBNAIL_SIZE = 2048;

export function parseThumbnailDimension(
  value: unknown,
  fallback: number,
): number | null {
  if (value === undefined) return fallback;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed === "") return fallback;
  if (!/^\d+$/.test(trimmed)) return null;

  const parsed = Number(trimmed);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > MAX_THUMBNAIL_SIZE) {
    return null;
  }
  return parsed;
}
