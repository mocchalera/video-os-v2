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
  /**
   * ASS WrapStyle: 0=smart, 1=end-of-line, 2=no auto-wrap (manual breaks
   * only), 3=smart-wide. Undefined leaves ffmpeg's default. Captions are
   * already line-broken upstream (runtime/caption/line-breaker), so 2 keeps
   * the approved 2-line layout instead of letting ffmpeg re-wrap to 3 lines.
   */
  wrapStyle?: 0 | 1 | 2 | 3;
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
  wrapStyle: 2,
  alignment: "bottom_center",
  marginV1080: 44,
  maxWidthRatio: 0.88,
  safeArea: { top: 0, right: 0, bottom: 0, left: 0 },
};

// ── Preset registry (caption_policy.styling_class -> preset) ──────────

/**
 * Named presets selectable per project via caption_policy.styling_class.
 * Lets operators tune subtitle position/width/wrap per work without code
 * changes — pick a styling_class in the blueprint and the render path
 * resolves it here. Unknown classes fall back to the default preset.
 */
export const CAPTION_STYLE_PRESETS: Record<string, CaptionStylePreset> = {
  // Font sizes are 1080p-reference px (% of frame height); buildAssDocument
  // scales them to the real resolution. The genre sets the right ratio:
  // talking-head/digest captions are the subject so they read large;
  // cinematic captions stay restrained; vertical SNS captions are oversized.
  default: DEFAULT_CAPTION_STYLE_PRESET,
  "clean-lower-third": {
    ...DEFAULT_CAPTION_STYLE_PRESET,
    presetId: "clean-lower-third",
    fontSizePx1080: 60, // 5.6% — speech-led digest: readable on phone-sized playback
    lineHeightPx1080: 74,
    outlinePx1080: 3,
    marginV1080: 36,
    maxWidthRatio: 0.9,
    wrapStyle: 2,
  },
  cinematic: {
    ...DEFAULT_CAPTION_STYLE_PRESET,
    presetId: "cinematic",
    fontSizePx1080: 36, // 3.3% — film/doc: restrained, sits higher off the edge
    lineHeightPx1080: 46,
    marginV1080: 60,
    maxWidthRatio: 0.8,
    wrapStyle: 2,
  },
  "longform-event": {
    ...DEFAULT_CAPTION_STYLE_PRESET,
    presetId: "longform-event",
    fontFamily: "Hiragino Sans",
    fontSizePx1080: 56,
    lineHeightPx1080: 70,
    outlinePx1080: 4,
    marginV1080: 48,
    maxWidthRatio: 0.9,
    wrapStyle: 2,
  },
  "sns-vertical": {
    ...DEFAULT_CAPTION_STYLE_PRESET,
    presetId: "sns-vertical",
    fontWeight: 700,
    fontSizePx1080: 64, // 5.9% — vertical short-form: oversized, bold
    lineHeightPx1080: 80,
    outlinePx1080: 3,
    marginV1080: 120, // clear of platform UI chrome at the bottom
    maxWidthRatio: 0.92,
    wrapStyle: 2,
  },
};

/** Resolve a caption style preset from a caption_policy styling_class. */
export function resolveCaptionStylePreset(stylingClass?: string): CaptionStylePreset {
  if (
    stylingClass &&
    Object.prototype.hasOwnProperty.call(CAPTION_STYLE_PRESETS, stylingClass)
  ) {
    return CAPTION_STYLE_PRESETS[stylingClass];
  }
  return DEFAULT_CAPTION_STYLE_PRESET;
}

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

  if (preset.wrapStyle !== undefined) {
    parts.push(`WrapStyle=${preset.wrapStyle}`);
  }

  return parts.join(",");
}

// ── Full ASS document builder ────────────────────────────────────────

/** ASS timestamp: H:MM:SS.cc (centiseconds). */
function assTimestamp(seconds: number): string {
  const cs = Math.max(0, Math.round(seconds * 100));
  const h = Math.floor(cs / 360000);
  const m = Math.floor((cs % 360000) / 6000);
  const s = Math.floor((cs % 6000) / 100);
  const c = cs % 100;
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(c).padStart(2, "0")}`;
}

export interface AssCaptionCue {
  startSec: number;
  endSec: number;
  /** May contain "\n" for manual line breaks (converted to ASS "\N"). */
  text: string;
}

/**
 * Build a complete ASS subtitle document with an explicit PlayResX/Y header.
 *
 * burn-in MUST use this rather than SRT + force_style: when ffmpeg converts
 * an SRT it gives libass a default 384x288 PlayRes, so MarginV is scaled up
 * (e.g. 36 -> ~135px) and a bottom lower-third floats into mid-frame.
 * Pinning PlayResX/Y to the real frame makes MarginV/alignment exact, and
 * the style carries WrapStyle so approved line layout is preserved. The same
 * builder feeds the exact preview and the final render, keeping parity.
 */
export function buildAssDocument(
  cues: AssCaptionCue[],
  preset: CaptionStylePreset,
  sequence: SequenceInfo,
): string {
  const scale = sequence.height / 1080;
  const fontSize = Math.round(preset.fontSizePx1080 * scale);
  const outline = Math.round(preset.outlinePx1080 * scale * 10) / 10;
  const shadow = Math.round(preset.shadowPx1080 * scale * 10) / 10;
  const marginV = Math.round(preset.marginV1080 * scale);
  const marginH = Math.round((sequence.width * (1 - preset.maxWidthRatio)) / 2);
  const primary = rgbaToAss(preset.fillRgba);
  const outlineColour = rgbaToAss(preset.outlineRgba);
  const bold = preset.fontWeight >= 700 ? -1 : 0; // ASS: -1 = true
  const alignment = assAlignment(preset.alignment);
  const wrapStyle = preset.wrapStyle ?? 0;

  const lines: string[] = [
    "[Script Info]",
    "ScriptType: v4.00+",
    `PlayResX: ${sequence.width}`,
    `PlayResY: ${sequence.height}`,
    `WrapStyle: ${wrapStyle}`,
    "ScaledBorderAndShadow: yes",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    `Style: Default,${preset.fontFamily},${fontSize},${primary},${primary},${outlineColour},&H00000000,${bold},0,0,0,100,100,0,0,1,${outline},${shadow},${alignment},${marginH},${marginH},${marginV},1`,
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
  ];

  for (const cue of cues) {
    const text = cue.text.replace(/\r?\n/g, "\\N");
    lines.push(
      `Dialogue: 0,${assTimestamp(cue.startSec)},${assTimestamp(cue.endSec)},Default,,0,0,0,,${text}`,
    );
  }

  return lines.join("\n") + "\n";
}

/**
 * Parse SRT content into ASS cues. Lets the existing SRT generators stay
 * unchanged: the render path keeps producing the sidecar SRT and converts
 * it to a styled ASS just before burn-in via buildAssDocument.
 */
export function parseSrtCues(srt: string): AssCaptionCue[] {
  const cues: AssCaptionCue[] = [];
  const toSec = (h: string, m: string, s: string, ms: string): number =>
    Number(h) * 3600 + Number(m) * 60 + Number(s) + Number(ms) / 1000;
  for (const block of srt.trim().split(/\r?\n\s*\r?\n/)) {
    const blockLines = block.split(/\r?\n/);
    const timeIdx = blockLines.findIndex((l) =>
      /\d{2}:\d{2}:\d{2},\d{3}\s*-->\s*\d{2}:\d{2}:\d{2},\d{3}/.test(l),
    );
    if (timeIdx === -1) continue;
    const m = blockLines[timeIdx].match(
      /(\d{2}):(\d{2}):(\d{2}),(\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2}),(\d{3})/,
    );
    if (!m) continue;
    const text = blockLines.slice(timeIdx + 1).join("\n").trim();
    if (!text) continue;
    cues.push({
      startSec: toSec(m[1], m[2], m[3], m[4]),
      endSec: toSec(m[5], m[6], m[7], m[8]),
      text,
    });
  }
  return cues;
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
