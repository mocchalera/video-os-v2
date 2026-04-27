/**
 * CaptionStylePreset — single source of truth for subtitle/caption styling.
 *
 * Used to generate:
 * - ASS force_style strings for ffmpeg subtitles filter (exact preview + final)
 * - CSS style objects for ProgramMonitor approximate fallback
 *
 * All dimensional values are defined at 1080p reference resolution.
 * Builders scale proportionally when the actual sequence resolution differs.
 */

// ── Types ────────────────────────────────────────────────────────────

export interface CaptionStylePreset {
  presetId: string;
  fontFamily: string;
  fontWeight: 400 | 700;
  /** Font size in pixels at 1080p reference */
  fontSizePx1080: number;
  /** Line height in pixels at 1080p reference */
  lineHeightPx1080: number;
  /** Fill color as "RRGGBBAA" hex */
  fillRgba: string;
  /** Outline color as "RRGGBBAA" hex */
  outlineRgba: string;
  /** Outline width in pixels at 1080p reference */
  outlinePx1080: number;
  /** Shadow depth in pixels at 1080p reference */
  shadowPx1080: number;
  alignment: "bottom_center" | "center" | "top_center";
  /** Bottom margin in pixels at 1080p reference */
  marginV1080: number;
  /** Max width as ratio of sequence width (0-1) */
  maxWidthRatio: number;
  safeArea: { top: number; right: number; bottom: number; left: number };
}

export interface SequenceInfo {
  width: number;
  height: number;
  fps: number;
}

// ── Default preset ───────────────────────────────────────────────────

export const DEFAULT_CAPTION_STYLE_PRESET: CaptionStylePreset = {
  presetId: "default",
  fontFamily: "Arial",
  fontWeight: 700,
  fontSizePx1080: 24,
  lineHeightPx1080: 32,
  fillRgba: "FFFFFFFF",
  outlineRgba: "000000FF",
  outlinePx1080: 2,
  shadowPx1080: 0,
  alignment: "bottom_center",
  marginV1080: 44,
  maxWidthRatio: 0.88,
  safeArea: { top: 0, right: 0, bottom: 0, left: 0 },
};

// ── ASS force_style builder ──────────────────────────────────────────

/**
 * ASS alignment mapping.
 * ASS uses numpad layout: 2 = bottom-center, 5 = center, 8 = top-center.
 */
function assAlignment(align: CaptionStylePreset["alignment"]): number {
  switch (align) {
    case "bottom_center":
      return 2;
    case "center":
      return 5;
    case "top_center":
      return 8;
  }
}

/**
 * Convert "RRGGBBAA" to ASS "&HAABBGGRR" format.
 * ASS uses AABBGGRR order with & prefix and H marker.
 */
function rgbaToAss(rgba: string): string {
  const r = rgba.slice(0, 2);
  const g = rgba.slice(2, 4);
  const b = rgba.slice(4, 6);
  const a = rgba.slice(6, 8);
  // ASS alpha: 00 = opaque, FF = transparent (inverted from conventional)
  const assAlpha = (255 - parseInt(a, 16)).toString(16).padStart(2, "0").toUpperCase();
  return `&H${assAlpha}${b}${g}${r}`;
}

/**
 * Build an ASS force_style string from a CaptionStylePreset.
 *
 * This is the ONLY place force_style strings should be generated.
 * Hand-written force_style is prohibited by design (Section 8.3).
 */
export function buildAssForceStyle(
  preset: CaptionStylePreset,
  sequence: SequenceInfo,
): string {
  const scale = sequence.height / 1080;
  const fontSize = Math.round(preset.fontSizePx1080 * scale);
  const outline = Math.round(preset.outlinePx1080 * scale * 10) / 10;
  const shadow = Math.round(preset.shadowPx1080 * scale * 10) / 10;
  const marginV = Math.round(preset.marginV1080 * scale);

  const parts: string[] = [
    `FontName=${preset.fontFamily}`,
    `FontSize=${fontSize}`,
    `Bold=${preset.fontWeight >= 700 ? 1 : 0}`,
    `PrimaryColour=${rgbaToAss(preset.fillRgba)}`,
    `OutlineColour=${rgbaToAss(preset.outlineRgba)}`,
    `Outline=${outline}`,
    `Shadow=${shadow}`,
    `Alignment=${assAlignment(preset.alignment)}`,
    `MarginV=${marginV}`,
    `MarginL=${Math.round(sequence.width * (1 - preset.maxWidthRatio) / 2)}`,
    `MarginR=${Math.round(sequence.width * (1 - preset.maxWidthRatio) / 2)}`,
  ];

  return parts.join(",");
}

// ── CSS style builder ────────────────────────────────────────────────

/**
 * Build a CSS style object from a CaptionStylePreset.
 *
 * Used for the source_approx fallback in ProgramMonitor.
 * Not used for exact preview (which plays burn-in video).
 */
export function buildCssCaptionStyle(
  preset: CaptionStylePreset,
  sequence: SequenceInfo,
): Record<string, string> {
  const scale = sequence.height / 1080;
  const fontSize = Math.round(preset.fontSizePx1080 * scale);
  const outline = Math.round(preset.outlinePx1080 * scale);
  const marginBottom = Math.round(preset.marginV1080 * scale);

  // Text-shadow for outline effect (8-direction spread)
  const ox = outline;
  const oy = outline;
  const outlineColor = `#${preset.outlineRgba.slice(0, 6)}`;
  const textShadow = [
    `${-ox}px ${-oy}px 0 ${outlineColor}`,
    `${ox}px ${-oy}px 0 ${outlineColor}`,
    `${-ox}px ${oy}px 0 ${outlineColor}`,
    `${ox}px ${oy}px 0 ${outlineColor}`,
    `0 ${-oy}px 0 ${outlineColor}`,
    `0 ${oy}px 0 ${outlineColor}`,
    `${-ox}px 0 ${outlineColor}`,
    `${ox}px 0 ${outlineColor}`,
  ].join(", ");

  const textAlign = "center";
  const isTop = preset.alignment === "top_center";
  const isCenter = preset.alignment === "center";

  const safeTop = Math.round(preset.safeArea.top * scale);
  const safeRight = Math.round(preset.safeArea.right * scale);
  const safeBottom = Math.round(preset.safeArea.bottom * scale);
  const safeLeft = Math.round(preset.safeArea.left * scale);

  const style: Record<string, string> = {
    fontFamily: preset.fontFamily,
    fontSize: `${fontSize}px`,
    fontWeight: String(preset.fontWeight),
    lineHeight: `${Math.round(preset.lineHeightPx1080 * scale)}px`,
    color: `#${preset.fillRgba.slice(0, 6)}`,
    textShadow,
    textAlign,
    maxWidth: `${preset.maxWidthRatio * 100}%`,
    position: "absolute",
    left: "50%",
    transform: "translateX(-50%)",
    pointerEvents: "none",
  };

  if (isCenter) {
    style.top = "50%";
    style.transform = "translateX(-50%) translateY(-50%)";
  } else if (isTop) {
    style.top = `${marginBottom + safeTop}px`;
  } else {
    style.bottom = `${marginBottom + safeBottom}px`;
  }

  if (safeLeft > 0) style.paddingLeft = `${safeLeft}px`;
  if (safeRight > 0) style.paddingRight = `${safeRight}px`;

  return style;
}
