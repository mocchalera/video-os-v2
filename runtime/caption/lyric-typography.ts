/**
 * Lyric Typography Engine (Issue 36) — canonical telop typography for lyric
 * MVs and vertical videos.
 *
 * Owns, in one place:
 * 1. Strict pure-lyrics sanitizer: `//` comments, `[Verse]` / `[Chorus]`
 *    section tags, `(BGM)` style annotations, LRC timestamps, directive
 *    lines, and music decorations never reach a rendered telop.
 * 2. Japanese phrase-aware automatic two-tier line breaking: the main tier
 *    (100–116px) and the sub tier (75–85px) are auto-sized so every line is
 *    measured — never assumed — to fit the 1080px frame minus the 80px side
 *    safe zones (920px). Break points come from Intl.Segmenter word
 *    boundaries with line-start particle and punctuation guardrails.
 * 3. Poster boundary-cross positioning: the em-center of the main tier sits
 *    on the artwork (Y=320..1400) / background-blur boundary (Y=1400), which
 *    resolves to MarginV 450–480 at the 1080x1920 frame.
 * 4. Section-driven font pairing: A/B-melo verse -> Hiragino Mincho ProN,
 *    chorus -> bold Mincho (W6) + glow (cyan/amber) + bounce-in, punk/fast
 *    -> heavy Hiragino Sans (W8) kinetic staccato (one character per cue at
 *    screen center). Font capability is probed against the real installed
 *    fonts; when a requested family is not installed the engine falls back
 *    to the bundled Noto static faces and records `fallback_used: true`
 *    with the reason — it never claims a native face it did not verify.
 * 5. A real ASS document (PlayResX/Y pinned, per-section styles, inline
 *    sub-tier sizing, glow/bounce tags, staccato \pos events) — actual
 *    render output, not metadata only.
 *
 * Text integrity: the engine only removes metadata and never rewrites lyric
 * characters. Timing stays owned by the caller's lyric input.
 */
import * as crypto from "node:crypto";
import {
  ASS_BOLD_VIDEO_FONT,
  ASS_HEAVY_VIDEO_FONT,
} from "../../editor/shared/font-contract.js";
import { escapeAssCaptionText } from "../../editor/shared/caption-text-sanitizer.js";
import { measureDisplayUnits } from "./line-breaker.js";
import { probeInstalledFontFamily, type FontProbeResult } from "../fonts/system-font-probe.js";
import {
  hashFontFile,
  measureTextAdvancePx,
  resolveFontFaceIndex,
} from "../fonts/font-metrics.js";
import { resolveBundledFontPaths } from "../fonts/bundled-font.js";

// ── Frame geometry (Issue 36 constants) ──────────────────────────────────

export const LYRIC_FRAME = { width: 1080, height: 1920 } as const;
/** Left/right safe zone per side at 1080px width. */
export const LYRIC_SAFE_MARGIN_PX = 80;
/** 1080 - 2*80 — every measured line must fit this width. */
export const LYRIC_SAFE_WIDTH_PX = LYRIC_FRAME.width - LYRIC_SAFE_MARGIN_PX * 2;
/** Square artwork 1080x1080 at Y=320..1400. */
export const LYRIC_ARTWORK_RECT = { x: 0, y: 320, width: 1080, height: 1080 } as const;
/** Artwork / lower background-blur boundary the telop baseline crosses. */
export const LYRIC_BOUNDARY_Y = LYRIC_ARTWORK_RECT.y + LYRIC_ARTWORK_RECT.height;
/** Issue 36 pins MarginV to 450–480 for the boundary-cross composition. */
export const POSTER_MARGIN_V_RANGE = { min: 450, max: 480 } as const;

export const LYRIC_MAIN_SIZE_RANGE = { min: 100, max: 116 } as const;
export const LYRIC_SUB_SIZE_RANGE = { min: 75, max: 85 } as const;
export const LYRIC_STACCATO_SIZE_PX = 120;

export type LyricSectionRole = "verse" | "chorus" | "punk" | "instrumental";
export type LyricGlowColor = "cyan" | "amber";
export type LyricPositioning = "poster_boundary_cross" | "bottom_center";

/** Approval/timeline binding for a plan projected from the Issue #41 route. */
export interface LyricTypographyAuthority {
  kind: "authored_caption_approval";
  approval_sha256: string;
  timeline_sha256: string;
  text_authority_sha256: string;
  timing_authority_sha256: string;
}

/** RRGGBBAA. */
const GLOW_COLORS: Record<LyricGlowColor, string> = {
  cyan: "00FFFFFF",
  amber: "FFBF00FF",
};

/** ASS `\blur` radius used for chorus glow (must match chorusGlowTags). */
const GLOW_BLUR_PX = 5;

interface RoleStyle {
  role: Exclude<LyricSectionRole, "instrumental">;
  styleName: "LyricVerse" | "LyricChorus" | "LyricPunk";
  /** Requested (macOS-native) family per the issue's font pairing. */
  requestedFamily: string;
  /** Bundled static face used when the requested family is not installed. */
  fallbackFamily: string;
  fallbackWeight: 700 | 900;
  mainSizePx: number;
  subSizePx: number;
  outlinePx: number;
  glow?: LyricGlowColor;
}

/**
 * Issue 36 pairing:
 * - A/Bメロ: literary Mincho (Hiragino Mincho ProN).
 * - サビ: bold Mincho (W6) + glow + bounce-in.
 * - パンク・高速パート: heavy Gothic (Hiragino Sans W8), kinetic staccato.
 * Fallbacks map W3 -> the bundled 700 static face, W6/W8 -> the 900 face so
 * section switching stays observable even when Hiragino is absent.
 */
export const LYRIC_ROLE_STYLES: Record<Exclude<LyricSectionRole, "instrumental">, RoleStyle> = {
  verse: {
    role: "verse",
    styleName: "LyricVerse",
    requestedFamily: "Hiragino Mincho ProN",
    fallbackFamily: ASS_BOLD_VIDEO_FONT.family,
    fallbackWeight: 700,
    mainSizePx: 100,
    subSizePx: 75,
    outlinePx: 3,
  },
  chorus: {
    role: "chorus",
    styleName: "LyricChorus",
    requestedFamily: "Hiragino Mincho ProN W6",
    fallbackFamily: ASS_HEAVY_VIDEO_FONT.family,
    fallbackWeight: 900,
    mainSizePx: 116,
    subSizePx: 85,
    outlinePx: 5,
    glow: "cyan",
  },
  punk: {
    role: "punk",
    styleName: "LyricPunk",
    requestedFamily: "Hiragino Sans W8",
    fallbackFamily: ASS_HEAVY_VIDEO_FONT.family,
    fallbackWeight: 900,
    mainSizePx: LYRIC_STACCATO_SIZE_PX,
    subSizePx: LYRIC_STACCATO_SIZE_PX,
    outlinePx: 4,
  },
};

// ── Font capability receipts ─────────────────────────────────────────────

export interface LyricFontResolution {
  requested_family: string;
  resolved_family: string;
  /** true only when the probe verified the requested family is installed. */
  capability: "native" | "bundled_fallback";
  fallback_used: boolean;
  reason: string;
  /**
   * The exact binary bound for measurement AND rendering (verified against
   * its name table). Undefined only when no binary could be bound — which
   * fails delivery closed.
   */
  font_path?: string;
  /** Exact face index inside the binary (TTC collections). */
  face_index?: number;
  /** PostScript name (name ID 6) of the exact bound face. */
  postscript_name?: string;
  /** SHA-256 of the bound binary. */
  font_sha256?: string;
  /** binary_bound: requested native face; degraded: bundled fallback face. */
  render_binding: "binary_bound" | "degraded";
}

export type LyricFontProbe = (family: string) => Pick<FontProbeResult, "capability" | "detail" | "filePath">;

const defaultProbe: LyricFontProbe = (family) => {
  // filePath is REQUIRED for binary binding: measurement and libass
  // rendering must resolve to the same font binary.
  const result = probeInstalledFontFamily(family);
  return { capability: result.capability, detail: result.detail, filePath: result.filePath };
};

/**
 * Font receipts derived from the binding resolver, so the receipt family,
 * the measured binary, and the libass-facing style name can never diverge.
 */
export function resolveLyricFont(
  style: Pick<RoleStyle, "requestedFamily" | "fallbackFamily">,
  probe: LyricFontProbe = defaultProbe,
): LyricFontResolution {
  const bindings = resolveLyricFontBindings(probe);
  const role = (Object.keys(LYRIC_ROLE_STYLES) as Array<Exclude<LyricSectionRole, "instrumental">>)
    .find((candidate) => LYRIC_ROLE_STYLES[candidate].requestedFamily === style.requestedFamily
      && LYRIC_ROLE_STYLES[candidate].fallbackFamily === style.fallbackFamily);
  const binding = role ? bindings[role] : undefined;
  if (binding) {
    return {
      requested_family: style.requestedFamily,
      resolved_family: binding.family,
      capability: binding.binding === "binary_bound" ? "native" : "bundled_fallback",
      fallback_used: binding.binding === "degraded",
      reason: binding.detail,
      ...(binding.font_path ? { font_path: binding.font_path } : {}),
      ...(binding.face_index !== undefined ? { face_index: binding.face_index } : {}),
      ...(binding.postscript_name ? { postscript_name: binding.postscript_name } : {}),
      ...(binding.font_sha256 ? { font_sha256: binding.font_sha256 } : {}),
      render_binding: binding.binding,
    };
  }
  // Off-contract style pair: keep the legacy probe-only receipt but mark it
  // degraded — its family cannot be binary-bound.
  let probed: Pick<FontProbeResult, "capability" | "detail">;
  try {
    probed = probe(style.requestedFamily);
  } catch (error) {
    probed = { capability: "unknown", detail: error instanceof Error ? error.message : String(error) };
  }
  const native = probed.capability === "available";
  return {
    requested_family: style.requestedFamily,
    resolved_family: native ? style.requestedFamily : style.fallbackFamily,
    capability: native ? "native" : "bundled_fallback",
    fallback_used: !native,
    reason: `${native ? "installed family verified" : "requested family could not be verified"} by font probe (no binary binding): ${probed.detail}`,
    render_binding: "degraded",
  };
}

// ── Strict pure-lyrics sanitizer ─────────────────────────────────────────

export interface SanitizedLyricLine {
  /** Pure lyric text; empty when the line carried no lyric content. */
  text: string;
  /** Metadata tokens removed from the line, in removal order. */
  removedTokens: string[];
  isPureLyric: boolean;
}

export interface SanitizedLyrics {
  lines: string[];
  removed: Array<{ line: string; reason: string }>;
}

/** Metadata vocabulary that may appear inside parens/brackets. */
const PAREN_METADATA_VOCABULARY: RegExp[] = [
  /^(?:bgm|b\.g\.m|instrumental|inst\.?|off\s*vocal|offvocal|karaoke|backing\s*track|acapella|a\s*cappella)$/i,
  /^(?:intro|outro|interlude|verse|chorus|bridge|hook|refrain|solo|guitar\s*solo|piano\s*solo|rap|se|montage)$/i,
  /^(?:イントロ|アウトロ|間奏|前奏|後奏|インスト|オフヴォーカル|カラオケ|セリフ|モンタージュ)$/i,
  /^(?:[abcd]メロ|サビ|大サビ|ラスサビ|落ち|ブレイク)$/i,
  /^(?:くりかえし|繰り返し|リピート|x\s*\d+|×\s*\d+|\d+\s*回)$/i,
  /^\d{1,2}:\d{2}(?:[.:]\d{1,3})?$/, // LRC timestamps inside brackets
];

// Half- and full-width brackets/parens: ([【［ ... ］】])。
const BRACKET_TAG = /[（(\[【［]([^\）)\]】］]*)[）)\]】］]/g;
const LINE_COMMENT = /\/\/.*$/;
const BLOCK_COMMENT = /\/\*[\s\S]*?(?:\*\/|$)/g;
const DECORATION_MARKS = /[♪♫♬♩]+/g;
const DIRECTIVE_LINE =
  /^(?:title|曲名|作詞|作词|作曲|編曲|编曲|arrange|composition|composer|lyric(?:ist)?s?|vocal|vo|chorus|bpm|key|tempo|time|album|artist|singer|bgm|b\.g\.m|lyrics|歌詞)\s*[:：=]/i;
const SEPARATOR_ONLY = /^(?:[-_＝ー〜~\s·・…─―—–]+)$/;
const LRC_TIMESTAMP_TAG = /^\d{1,2}:\d{2}(?:[.:]\d{1,3})?$/;

function isMetadataParenContent(content: string): boolean {
  const normalized = content.normalize("NFKC").trim();
  if (!normalized) return true;
  return PAREN_METADATA_VOCABULARY.some((pattern) => pattern.test(normalized))
    || isSectionTagContent(normalized);
}

/**
 * Sanitize one raw lyric line. Bracketed section tags, LRC timestamps, `//`
 * comments, metadata parens, and decorations are removed; whatever remains
 * must be pure sung lyrics. Lyric characters are never rewritten.
 */
export function sanitizeLyricLine(rawLine: string): SanitizedLyricLine {
  const removedTokens: string[] = [];
  let line = rawLine;

  const strip = (pattern: RegExp, classify: (token: string) => boolean): void => {
    line = line.replace(pattern, (token) => {
      if (classify(token)) {
        removedTokens.push(token.trim());
        return " ";
      }
      return token;
    });
  };

  // `//` line comments (Issue 36: `//` and English comments never render).
  if (LINE_COMMENT.test(line)) {
    const match = line.match(LINE_COMMENT)!;
    removedTokens.push(match[0].trim());
    line = line.replace(LINE_COMMENT, " ");
  }
  strip(BLOCK_COMMENT, () => true);
  // Bracketed tokens: square tags (section markers) and LRC timestamps are
  // metadata only when their content matches the metadata vocabulary —
  // legitimate bracketed lyric text (e.g. `[F]` chords, invented labels) is
  // preserved. Parentheticals follow the same vocabulary rule as before.
  strip(BRACKET_TAG, (token) => {
    const inner = token.slice(1, -1);
    return isMetadataParenContent(inner) || LRC_TIMESTAMP_TAG.test(inner.trim());
  });
  strip(DECORATION_MARKS, () => true);

  // `※`-led annotation lines. Surrounding whitespace is structural here,
  // while whitespace in a metadata-free authored lyric remains source text.
  const trimmedLine = line.trim();
  if (trimmedLine.startsWith("※")) {
    removedTokens.push(trimmedLine);
    line = "";
  }

  // Only the display derivative that actually removed metadata is normalized.
  // A pure authored lyric is returned byte-for-byte (except blank lines,
  // which are not displayable lyric content).
  if (removedTokens.length > 0) {
    line = line.replace(/[ \t]{2,}/g, " ").trim();
  } else if (line.trim().length === 0) {
    line = "";
  }

  return {
    text: line,
    removedTokens,
    isPureLyric: line.length > 0,
  };
}

/**
 * Sanitize a multi-line engine input (e.g. an LRC slot merging metadata and
 * lyric lines): each physical line is sanitized independently so `//`
 * comments are stripped regardless of position, and surviving lyric lines
 * rejoin with authored manual breaks.
 */
export function sanitizeLyricEntryLines(entryText: string): SanitizedLyricLine {
  const parts = entryText.split(/\r?\n/);
  if (parts.length === 1) return sanitizeLyricLine(entryText);
  const sanitizedParts = parts.map((part) => sanitizeLyricLine(part));
  return {
    text: sanitizedParts.map((part) => part.text).filter((part) => part.length > 0).join("\n"),
    removedTokens: sanitizedParts.flatMap((part) => part.removedTokens),
    isPureLyric: sanitizedParts.some((part) => part.isPureLyric),
  };
}

/**
 * Sanitize a raw lyric script: returns only pure lyric lines plus an audit
 * of everything that was removed (the "100% no metadata" evidence).
 */
export function sanitizeLyrics(raw: string): SanitizedLyrics {
  const lines: string[] = [];
  const removed: Array<{ line: string; reason: string }> = [];
  for (const rawLine of raw.split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    if (!trimmed) continue;
    if (DIRECTIVE_LINE.test(trimmed.normalize("NFKC"))) {
      removed.push({ line: trimmed, reason: "directive line" });
      continue;
    }
    if (trimmed.startsWith("#") || trimmed.startsWith("※")) {
      removed.push({ line: trimmed, reason: "comment/annotation line" });
      continue;
    }
    if (SEPARATOR_ONLY.test(trimmed)) {
      removed.push({ line: trimmed, reason: "separator line" });
      continue;
    }
    const sanitized = sanitizeLyricLine(rawLine);
    if (!sanitized.isPureLyric) {
      if (sanitized.removedTokens.length > 0) {
        removed.push({ line: trimmed, reason: "metadata-only line" });
      }
      continue;
    }
    lines.push(sanitized.text);
    if (sanitized.removedTokens.length > 0) {
      removed.push({ line: trimmed, reason: `stripped metadata: ${sanitized.removedTokens.join(" ")}` });
    }
  }
  return { lines, removed };
}

// ── Section parsing ──────────────────────────────────────────────────────

const LYRIC_SECTION_TAGS: Record<string, Exclude<LyricSectionRole, "instrumental">> = {
  // verse (A/Bメロ)
  verse: "verse",
  "aメロ": "verse",
  "bメロ": "verse",
  "cメロ": "verse",
  "dメロ": "verse",
  bridge: "verse",
  ブリッジ: "verse",
  // chorus (サビ)
  chorus: "chorus",
  サビ: "chorus",
  大サビ: "chorus",
  ラスサビ: "chorus",
  hook: "chorus",
  // punk / fast parts
  punk: "punk",
  fast: "punk",
  高速: "punk",
  rap: "punk",
  ラップ: "punk",
  落ち: "punk",
};

const INSTRUMENTAL_TAGS = new Set([
  "instrumental", "インスト", "intro", "イントロ", "outro", "アウトロ",
  "間奏", "前奏", "後奏", "se",
]);

export interface ParsedSection {
  role: LyricSectionRole;
  /** 0-based index of the first lyric line in this section. */
  startLineIndex: number;
  tag: string;
  glowColor: LyricGlowColor;
}

export interface SectionParseResult {
  sections: ParsedSection[];
  diagnostics: string[];
}

function normalizeTag(tag: string): string {
  return tag.normalize("NFKC").trim().toLowerCase();
}

function parseTagAttributes(inner: string): { label: string; glowColor?: LyricGlowColor } {
  const parts = inner.split(/\s+/).filter(Boolean);
  const label = normalizeTag(parts[0] ?? "");
  let glowColor: LyricGlowColor | undefined;
  for (const part of parts.slice(1)) {
    const [key, value] = part.split("=");
    if (key?.toLowerCase() === "glow" && (value === "amber" || value === "cyan")) {
      glowColor = value;
    }
  }
  return { label, glowColor };
}

/**
 * Section metadata may carry a human numbering token or render attributes,
 * e.g. `[Verse 1]`, `[Chorus glow=amber]`, and `[Aメロ 2]`.  Recognition is
 * structural (known section label in the first token), so a real bracketed
 * lyric such as `[F]` remains lyric text while section metadata is removed
 * wherever it appears in a line.
 */
function isSectionTagContent(content: string): boolean {
  const { label } = parseTagAttributes(content);
  return Boolean(LYRIC_SECTION_TAGS[label] || INSTRUMENTAL_TAGS.has(label));
}

/** True when the line is a script-level non-lyric line (never rendered). */
export function isNonLyricScriptLine(trimmedLine: string): boolean {
  if (!trimmedLine) return true;
  const normalized = trimmedLine.normalize("NFKC");
  return DIRECTIVE_LINE.test(normalized)
    || trimmedLine.startsWith("#")
    || trimmedLine.startsWith("※")
    || SEPARATOR_ONLY.test(trimmedLine);
}

/**
 * Extract section markers from a raw lyric line. ONLY standalone tags — the
 * whole trimmed line is exactly one bracket tag — are parsed as sections.
 * Recognized tags declare a section; unrecognized standalone tags (e.g.
 * `[Guitar Solo 2]`) are removed and reported instead of rendered; inline
 * bracketed text is left for the sanitizer, which preserves legitimate
 * bracketed lyric content.
 */
export function consumeSectionTags(
  rawLine: string,
): { text: string; sections: Array<{ role: LyricSectionRole; glowColor?: LyricGlowColor; tag: string }>; unknownTags: string[] } {
  const sections: Array<{ role: LyricSectionRole; glowColor?: LyricGlowColor; tag: string }> = [];
  const unknownTags: string[] = [];
  const lines = rawLine.split(/\r?\n/);
  const kept: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    const standalone = trimmed.match(/^(([（(\[【［])([^\）)\]】］]*)([）)\]】］]))$/);
    if (!standalone || !(standalone[2] === "[" || standalone[2] === "【" || standalone[2] === "［")) {
      kept.push(line);
      continue;
    }
    const token = standalone[1];
    const inner = standalone[3];
    const { label, glowColor } = parseTagAttributes(inner);
    if (LRC_TIMESTAMP_TAG.test(label)) continue; // timestamp line: dropped, no section
    if (INSTRUMENTAL_TAGS.has(label)) {
      sections.push({ role: "instrumental", tag: token.trim() });
      continue;
    }
    const role = LYRIC_SECTION_TAGS[label];
    if (role) {
      sections.push({ role, glowColor, tag: token.trim() });
      continue;
    }
    unknownTags.push(token.trim());
  }
  const text = kept.join("\n");
  return { text, sections, unknownTags };
}

// ── Measurement ──────────────────────────────────────────────────────────

const MEASURE_OPTIONS = { language: "ja", full_width_unit: 1, latin_unit: 0.5 } as const;

/**
 * Legacy display-unit estimate (full-width = 1 em, Latin = 0.5 em). Kept as
 * the honest fail-open fallback when no font binary can be measured; it is
 * NOT used when the resolved font's glyph advances are available (hostile
 * Latin like `WWWWWWWWWW` is ~0.935 em/char, not 0.5 em).
 */
export function measureLyricWidthPx(text: string, fontSizePx: number): number {
  return measureDisplayUnits(text, MEASURE_OPTIONS) * fontSizePx;
}

/** Role-aware text measurement in px at a given font size. */
export type LyricMeasureFn = (
  text: string,
  fontSizePx: number,
  role: Exclude<LyricSectionRole, "instrumental">,
) => number;

export type LyricMeasurementMethod = "glyph_advance/v1" | "display_units/v1";

/**
 * Binding between the font binary used for MEASUREMENT and the font the
 * renderer (libass) will use: `resolved_family` is verified against the
 * binary's name table, so width decisions and rendered pixels come from the
 * same glyphs. `degraded` means the requested native pairing could not be
 * bound and the bundled face is used for both — still consistent, but
 * explicitly recorded. `render_binding: "degraded"` never hides a mismatch:
 * the plan additionally reports a `font_binding` violation when NO binary
 * can be bound (fail-closed).
 */
export interface LyricFontBinding {
  font_path: string | undefined;
  /** Exact face index inside the binary (TTC collections). */
  face_index: number | undefined;
  /** PostScript name (name ID 6) of the exact bound face. */
  postscript_name: string | undefined;
  /** SHA-256 of the bound binary. */
  font_sha256: string | undefined;
  family: string;
  method: LyricMeasurementMethod;
  binding: "binary_bound" | "degraded";
  detail: string;
}

export type LyricRoleBinding = Record<Exclude<LyricSectionRole, "instrumental">, LyricFontBinding>;

/**
 * Resolve, per role, the single exact face used for both measurement and
 * rendering. Priority: a probed native binary whose face list contains the
 * requested family (exact face index + PostScript name recorded); otherwise
 * the bundled static face. Measurement always uses that exact face index —
 * TTC faces are never merged. Anything unresolvable reports
 * `display_units/v1` + degraded so the plan can fail closed.
 */
export function resolveLyricFontBindings(probe: LyricFontProbe = defaultProbe): LyricRoleBinding {
  const bundled = resolveBundledFontPaths();
  const bundledFaceFor = (role: Exclude<LyricSectionRole, "instrumental">): string =>
    role === "verse" ? bundled.assBoldFontPath : bundled.assHeavyFontPath;
  const roles: Array<Exclude<LyricSectionRole, "instrumental">> = ["verse", "chorus", "punk"];
  const bindings = {} as LyricRoleBinding;
  for (const role of roles) {
    const style = LYRIC_ROLE_STYLES[role];
    // 1) Native: probe verified the family AND handed us the binary; select
    //    the exact face whose name list contains the requested family.
    try {
      const probed = probe(style.requestedFamily);
      if (probed.capability === "available" && probed.filePath) {
        const { index, face } = resolveFontFaceIndex(probed.filePath, style.requestedFamily);
        bindings[role] = {
          font_path: probed.filePath,
          face_index: index,
          postscript_name: face.postScriptName,
          font_sha256: hashFontFile(probed.filePath),
          family: style.requestedFamily,
          method: "glyph_advance/v1",
          binding: "binary_bound",
          detail: `requested family verified in face ${index} (${face.postScriptName ?? "no PS name"}) of the measured binary: ${probed.detail}`,
        };
        continue;
      }
    } catch {
      // probe/face failure: fall through to the bundled face
    }
    // 2) Degraded: bundled face, exact face selected and verified.
    try {
      const facePath = bundledFaceFor(role);
      const { index, face } = resolveFontFaceIndex(facePath, style.fallbackFamily);
      const measureProbe = safeProbeDetail(probe, style.requestedFamily);
      bindings[role] = {
        font_path: facePath,
        face_index: index,
        postscript_name: face.postScriptName,
        font_sha256: hashFontFile(facePath),
        family: style.fallbackFamily,
        method: "glyph_advance/v1",
        binding: "degraded",
        detail: `requested family ${style.requestedFamily} could not be bound to a binary (${measureProbe}); measuring and rendering with the bundled face ${style.fallbackFamily} (face ${index}, ${face.postScriptName ?? "no PS name"})`,
      };
    } catch (error) {
      // 3) Unbindable: fail closed via the plan violation.
      bindings[role] = {
        font_path: undefined,
        face_index: undefined,
        postscript_name: undefined,
        font_sha256: undefined,
        family: style.fallbackFamily,
        method: "display_units/v1",
        binding: "degraded",
        detail: `no font binary could be bound for role ${role}: ${describeError(error)}`,
      };
    }
  }
  return bindings;
}

function safeProbeDetail(probe: LyricFontProbe, family: string): string {
  try {
    const result = probe(family);
    return `${result.capability}: ${result.detail}`;
  } catch (error) {
    return describeError(error);
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Build the default measurement function from the role bindings: glyph
 * advances from the exact binary that rendering will use.
 */
export function createDefaultLyricMeasure(probe: LyricFontProbe = defaultProbe): {
  measure: LyricMeasureFn;
  method: LyricMeasurementMethod;
  bindings: LyricRoleBinding;
} {
  const bindings = resolveLyricFontBindings(probe);
  return {
    measure: (text, fontSizePx, role) => {
      const binding = bindings[role];
      if (binding.font_path && binding.face_index !== undefined && binding.method === "glyph_advance/v1") {
        // EXACT face only: the same face libass will render.
        return measureTextAdvancePx(text, binding.font_path, fontSizePx, binding.face_index);
      }
      return measureLyricWidthPx(text, fontSizePx);
    },
    method: Object.values(bindings).every((binding) => binding.method === "glyph_advance/v1")
      ? "glyph_advance/v1"
      : "display_units/v1",
    bindings,
  };
}

/** Ink width: text advance plus outline and glow blur on both sides. */
function inkPaddingPx(style: RoleStyle, hasGlow: boolean): number {
  return 2 * (style.outlinePx + (hasGlow ? GLOW_BLUR_PX : 0));
}

// ── Two-tier line breaking ───────────────────────────────────────────────

export interface TwoTierLine {
  text: string;
  tier: "main" | "sub";
  font_size_px: number;
  line_height_px: number;
  /** Glyph-advance (or fail-open display-unit) text width in px. */
  measured_width_px: number;
  /** Advance width plus outline and glow blur padding on both sides. */
  ink_width_px: number;
  fits_safe_width: boolean;
}

export interface TwoTierBreak {
  lines: TwoTierLine[];
  selection_reason: "single_main" | "phrase_boundary" | "balanced_midpoint";
  /** Non-empty when even the best effort exceeds the safe width. */
  violation?: string;
}

const JA_LINE_START_FORBIDDEN = new Set([
  "は", "が", "を", "に", "で", "と", "も", "の", "へ", "や", "か",
  "って", "った", "ます", "です", "ない", "した", "して", "しまう",
  "けれ", "ので", "のに", "こと", "もの", "て", "る", "ん", "ね", "よ", "な",
]);

const JA_CLOSING_PUNCTUATION = new Set(["。", "、", "！", "？", "）", "」", "』", "〕", "］"]);

function japaneseWordBoundaries(text: string): Set<number> {
  if (typeof Intl.Segmenter !== "function") return new Set<number>();
  return new Set(
    [...new Intl.Segmenter("ja", { granularity: "word" }).segment(text)]
      .map((segment) => segment.index)
      .filter((index) => index > 0 && index < text.length),
  );
}

function isForbiddenLineStart(line: string): boolean {
  if (!line) return false;
  if (JA_LINE_START_FORBIDDEN.has(line[0])) return true;
  if (line.length >= 2 && JA_LINE_START_FORBIDDEN.has(line.slice(0, 2))) return true;
  if (line.length >= 3 && JA_LINE_START_FORBIDDEN.has(line.slice(0, 3))) return true;
  return false;
}

function isKanjiToHiraganaContinuation(previous: string, next: string): boolean {
  if (!/[一-龯々]/.test(previous) || !/[ぁ-ゖ]/.test(next)) return false;
  return !/[はがをにでとのへもやか]/.test(next);
}

interface TierSizes {
  mainSizePx: number;
  subSizePx: number;
}

const MAIN_SIZE_LADDER = [116, 110, 105, 100];
const SUB_SIZE_LADDER = [85, 80, 75];

function ladderFor(role: Exclude<LyricSectionRole, "instrumental">, kind: "main" | "sub"): number[] {
  const sizes = kind === "main" ? MAIN_SIZE_LADDER : SUB_SIZE_LADDER;
  const roleSize = kind === "main"
    ? LYRIC_ROLE_STYLES[role].mainSizePx
    : LYRIC_ROLE_STYLES[role].subSizePx;
  // Role's declared size first (largest preferred), then smaller legal sizes.
  return [...sizes.filter((size) => size <= roleSize)].sort((a, b) => b - a);
}

interface TierMeasureContext {
  measure: LyricMeasureFn;
  role: Exclude<LyricSectionRole, "instrumental">;
  safeWidthPx: number;
  /** Role renders a glow (chorus): blur adds to the ink width. */
  glow: boolean;
}

function makeMeasureContext(
  role: Exclude<LyricSectionRole, "instrumental">,
  safeWidthPx: number,
  measure?: LyricMeasureFn,
): TierMeasureContext {
  return {
    measure: measure ?? createDefaultLyricMeasure().measure,
    role,
    safeWidthPx,
    glow: Boolean(LYRIC_ROLE_STYLES[role].glow),
  };
}

function measureTierPx(ctx: TierMeasureContext, text: string, sizePx: number): number {
  return ctx.measure(text, sizePx, ctx.role);
}

function measureInkPx(ctx: TierMeasureContext, text: string, sizePx: number): number {
  return measureTierPx(ctx, text, sizePx)
    + inkPaddingPx(LYRIC_ROLE_STYLES[ctx.role], ctx.glow);
}

function makeTierLine(text: string, tier: "main" | "sub", sizePx: number, ctx: TierMeasureContext): TwoTierLine {
  const measured = measureTierPx(ctx, text, sizePx);
  const ink = measureInkPx(ctx, text, sizePx);
  return {
    text,
    tier,
    font_size_px: sizePx,
    line_height_px: Math.round(sizePx * 1.2),
    measured_width_px: Math.round(measured * 10) / 10,
    ink_width_px: Math.round(ink * 10) / 10,
    // The INK (glyphs + outline + blur) must fit the safe width, not just
    // the advance: glow halos that spill past 80px margins still overflow.
    fits_safe_width: ink <= ctx.safeWidthPx,
  };
}

/**
 * Phrase-aware automatic two-tier break. Hard constraint: every emitted line
 * is measured to fit `safeWidthPx`; when even the smallest legal tier sizes
 * cannot achieve that, the best effort is returned with an explicit
 * `violation` — the engine never silently overflows the safe zone.
 */
export function breakLyricTwoTier(
  text: string,
  options: {
    role: Exclude<LyricSectionRole, "instrumental">;
    safeWidthPx?: number;
    protectedTerms?: string[];
    measure?: LyricMeasureFn;
  },
): TwoTierBreak {
  const safeWidthPx = options.safeWidthPx ?? LYRIC_SAFE_WIDTH_PX;
  const role = options.role;
  const ctx = makeMeasureContext(role, safeWidthPx, options.measure);
  const flat = text.replace(/\r?\n/g, "").trim();
  if (!flat) return { lines: [], selection_reason: "single_main" };

  const mainLadder = ladderFor(role, "main");
  const subLadder = ladderFor(role, "sub");

  // Single line at the role's main size.
  const largestMain = mainLadder[0];
  if (measureInkPx(ctx, flat, largestMain) <= safeWidthPx) {
    return {
      lines: [makeTierLine(flat, "main", largestMain, ctx)],
      selection_reason: "single_main",
    };
  }

  // Two tiers: pick the phrase boundary and tier sizes jointly.
  const boundaries = japaneseWordBoundaries(flat);
  const indices = [...boundaries].sort((a, b) => a - b);
  if (indices.length === 0) indices.push(Math.floor(flat.length / 2));

  interface Candidate {
    index: number;
    mainSize: number;
    subSize: number;
    mainWidth: number;
    subWidth: number;
    score: number;
    overflow: number;
  }
  const valid: Candidate[] = [];
  let bestEffort: Candidate | undefined;

  for (const index of indices) {
    const line1 = flat.slice(0, index).trim();
    const line2 = flat.slice(index).trim();
    if (!line1 || !line2) continue;
    if (options.protectedTerms?.some((term) => term && flat.includes(term)
      && !(line1.includes(term) || line2.includes(term)))) continue;

    const mainSize = mainLadder.find((size) => measureInkPx(ctx, line1, size) <= safeWidthPx) ?? mainLadder[mainLadder.length - 1];
    const mainWidth = measureTierPx(ctx, line1, mainSize);
    const subSize = subLadder.find((size) => measureInkPx(ctx, line2, size) <= safeWidthPx) ?? subLadder[subLadder.length - 1];
    const subWidth = measureTierPx(ctx, line2, subSize);
    const mainFits = measureInkPx(ctx, line1, mainSize) <= safeWidthPx;
    const subFits = measureInkPx(ctx, line2, subSize) <= safeWidthPx;

    let score = 0;
    score += (mainSize + subSize) * 10; // prefer larger type
    score += Math.abs(mainWidth - subWidth) / Math.max(mainWidth + subWidth, 1) * 200; // penalize imbalance
    if (isForbiddenLineStart(line2)) score += 500;
    if (JA_CLOSING_PUNCTUATION.has(line2[0])) score += 400;
    if (isKanjiToHiraganaContinuation(line1[line1.length - 1], line2[0])) score += 600;
    if (boundaries.has(index)) score -= 100;

    const candidate: Candidate = {
      index, mainSize, subSize, mainWidth, subWidth, score,
      overflow: Math.max(mainWidth - safeWidthPx, subWidth - safeWidthPx, 0),
    };
    if (mainFits && subFits) valid.push(candidate);
    if (!bestEffort || candidate.overflow < bestEffort.overflow) bestEffort = candidate;
  }

  if (valid.length > 0) {
    valid.sort((a, b) => a.score - b.score);
    const chosen = valid[0];
    const line1 = flat.slice(0, chosen.index).trim();
    const line2 = flat.slice(chosen.index).trim();
    return {
      lines: [
        makeTierLine(line1, "main", chosen.mainSize, ctx),
        makeTierLine(line2, "sub", chosen.subSize, ctx),
      ],
      selection_reason: boundaries.has(chosen.index) ? "phrase_boundary" : "balanced_midpoint",
    };
  }

  // No candidate fits both tiers: honest best-effort midpoint at minimum
  // sizes, flagged as a violation for the caller to split the lyric line.
  const mid = bestEffort?.index ?? Math.floor(flat.length / 2);
  const line1 = flat.slice(0, mid).trim();
  const line2 = flat.slice(mid).trim() || flat;
  const lines = [
    makeTierLine(line1, "main", 100, ctx),
    ...((line2 && line2 !== line1)
      ? [makeTierLine(line2, "sub", 75, ctx)]
      : []),
  ];
  return {
    lines,
    selection_reason: "balanced_midpoint",
    violation: `line cannot fit the ${safeWidthPx}px safe width even at minimum tier sizes (measured ${lines.map((l) => l.measured_width_px).join("/")}px); split the lyric line upstream`,
  };
}

// ── Poster boundary-cross positioning ────────────────────────────────────

export interface PosterPosition {
  /** Main-tier bottom margin (also the style-row fallback value). */
  margin_v_px: number;
  /** Per-event margins that actually render via the Dialogue columns. */
  margin_v_main_px: number;
  /** Sub-tier event margin; sub renders directly below the main tier. */
  margin_v_sub_px: number;
  text_top_y: number;
  text_bottom_y: number;
  /** True when the MAIN tier (not merely the block) spans the boundary. */
  crosses_boundary: boolean;
  boundary_y: number;
}

/**
 * Poster boundary-cross composition built from the render model up: with
 * alignment 2 the block bottom sits at `frameH - MarginV`, so the MAIN tier
 * crosses Y=boundary only if the main tier's own bottom edge is pinned
 * there. We set mainBottom = boundaryY + mainSize/2 (em-center on the
 * boundary) and emit per-event MarginV columns so each Dialogue renders at
 * exactly these values:
 * - margin_v_main = frameH - boundaryY - mainSize/2  (462..470 in the band)
 * - margin_v_sub  = margin_v_main - subLineHeight    (sub directly below)
 */
export function resolvePosterPosition(
  mainFontSizePx: number,
  blockHeightPx: number,
  frame: { width: number; height: number } = LYRIC_FRAME,
  boundaryY: number = LYRIC_BOUNDARY_Y,
  subLineHeightPx = 0,
): PosterPosition {
  const mainBottomY = boundaryY + Math.round(mainFontSizePx / 2);
  const marginVMain = Math.min(
    POSTER_MARGIN_V_RANGE.max,
    Math.max(POSTER_MARGIN_V_RANGE.min, frame.height - mainBottomY),
  );
  const renderedMainBottom = frame.height - marginVMain;
  const mainHeightPx = Math.max(blockHeightPx - subLineHeightPx, 0);
  const marginVSub = marginVMain - subLineHeightPx;
  const textBottomY = frame.height - Math.max(marginVSub, 0);
  const textTopY = textBottomY - blockHeightPx;
  const mainTopY = renderedMainBottom - mainHeightPx;
  return {
    margin_v_px: marginVMain,
    margin_v_main_px: marginVMain,
    margin_v_sub_px: Math.max(marginVSub, 0),
    text_top_y: textTopY,
    text_bottom_y: textBottomY,
    crosses_boundary: mainTopY < boundaryY && renderedMainBottom > boundaryY,
    boundary_y: boundaryY,
  };
}

/** Bottom-center alternative retained as an explicit, deterministic style. */
export function resolveBottomCenterPosition(
  mainFontSizePx: number,
  blockHeightPx: number,
  frame: { width: number; height: number } = LYRIC_FRAME,
  boundaryY: number = LYRIC_BOUNDARY_Y,
  subLineHeightPx = 0,
): PosterPosition {
  const marginVMain = 240;
  const renderedMainBottom = frame.height - marginVMain;
  const mainHeightPx = Math.max(blockHeightPx - subLineHeightPx, 0);
  const marginVSub = Math.max(0, marginVMain - subLineHeightPx);
  const textBottomY = frame.height - marginVSub;
  const textTopY = textBottomY - blockHeightPx;
  const mainTopY = renderedMainBottom - mainHeightPx;
  return {
    margin_v_px: marginVMain,
    margin_v_main_px: marginVMain,
    margin_v_sub_px: marginVSub,
    text_top_y: textTopY,
    text_bottom_y: textBottomY,
    crosses_boundary: mainTopY < boundaryY && renderedMainBottom > boundaryY,
    boundary_y: boundaryY,
  };
}

export function resolveHorizontalBounds(
  contentWidthPx: number,
  frame: { width: number; height: number } = LYRIC_FRAME,
  safeMarginPx: number = LYRIC_SAFE_MARGIN_PX,
): { content_width_px: number; left_x: number; right_x: number; within_safe_zone: boolean } {
  const centered = (frame.width - contentWidthPx) / 2;
  return {
    content_width_px: Math.round(contentWidthPx * 10) / 10,
    left_x: Math.round(centered * 10) / 10,
    right_x: Math.round((frame.width - centered) * 10) / 10,
    within_safe_zone: contentWidthPx <= frame.width - safeMarginPx * 2,
  };
}

// ── Kinetic staccato ─────────────────────────────────────────────────────

export interface StaccatoChar {
  char: string;
  start_sec: number;
  end_sec: number;
  font_size_px: number;
  measured_width_px: number;
  /** Advance width plus outline padding on both sides. */
  ink_width_px: number;
}

export interface StaccatoExpansion {
  chars: StaccatoChar[];
  violation?: string;
}

/**
 * One character per cue at screen center (Issue 36: 「右」「左」「橋」「坂」「息」).
 * Bounds: every character slot — including the FINAL character — is capped
 * at `maxPerCharSec` (default 0.5s; `maxHoldSec` caps the final hold
 * separately). Chars run back-to-back and stop when the bound is reached:
 * the tail of the cue stays dark instead of one character dawdling on
 * screen. `reducedMotion` collapses the expansion to a single static entry
 * spanning the whole cue (no flicker).
 */
export function expandKineticStaccato(
  text: string,
  startSec: number,
  endSec: number,
  options: {
    maxPerCharSec?: number;
    maxHoldSec?: number;
    reducedMotion?: boolean;
    /** Bound glyph measure; width decisions MUST use the rendered font. */
    measure?: LyricMeasureFn;
  } = {},
): StaccatoExpansion {
  const measure: LyricMeasureFn = options.measure
    ?? ((t, size) => measureLyricWidthPx(t, size));
  const staccatoAdvance = (s: string): number => measure(s, LYRIC_STACCATO_SIZE_PX, "punk");
  const duration = endSec - startSec;
  if (!(duration > 0)) {
    return { chars: [], violation: "staccato cue has a non-positive duration" };
  }
  const graphemes = typeof Intl.Segmenter === "function"
    ? [...new Intl.Segmenter("ja", { granularity: "grapheme" }).segment(text)].map((g) => g.segment)
    : [...text];
  const chars = graphemes.filter((g) => g.trim().length > 0);
  if (chars.length === 0) {
    return { chars: [], violation: "staccato cue has no displayable characters" };
  }
  const maxPerChar = options.maxPerCharSec ?? 0.5;
  if (!(maxPerChar > 0)) {
    return { chars: [], violation: "staccato maxPerCharSec must be positive" };
  }
  const maxHold = options.maxHoldSec ?? maxPerChar;
  if (!(maxHold > 0)) {
    return { chars: [], violation: "staccato maxHoldSec must be positive" };
  }
  const staccatoInk = (s: string): number =>
    staccatoAdvance(s) + 2 * LYRIC_ROLE_STYLES.punk.outlinePx;
  if (options.reducedMotion) {
    // Accessibility: one static card, zero flicker.
    return {
      chars: [{
        char: chars.join(""),
        start_sec: startSec,
        end_sec: endSec,
        font_size_px: LYRIC_STACCATO_SIZE_PX,
        measured_width_px: Math.round(staccatoAdvance(chars.join("")) * 10) / 10,
        ink_width_px: Math.round(staccatoInk(chars.join("")) * 10) / 10,
      }],
    };
  }
  const slot = Math.min(maxPerChar, duration / chars.length);
  const out: StaccatoChar[] = [];
  let cursor = startSec;
  for (let i = 0; i < chars.length; i += 1) {
    const isLast = i === chars.length - 1;
    const charStart = cursor;
    const charEnd = Math.min(endSec, charStart + (isLast ? Math.min(slot, maxHold) : slot));
    if (charEnd <= charStart) break;
    out.push({
      char: chars[i],
      start_sec: Math.round(charStart * 1000) / 1000,
      end_sec: Math.round(charEnd * 1000) / 1000,
      font_size_px: LYRIC_STACCATO_SIZE_PX,
      measured_width_px: Math.round(staccatoAdvance(chars[i]) * 10) / 10,
      ink_width_px: Math.round(staccatoInk(chars[i]) * 10) / 10,
    });
    cursor = charEnd;
  }
  return { chars: out };
}

// ── Plan ─────────────────────────────────────────────────────────────────

export interface LyricLineInput {
  /** One lyric line as authored (may contain metadata that gets sanitized). */
  text: string;
  startSec: number;
  endSec: number;
  /** Stable source identities from an approved authored caption cue. */
  lineId?: string;
  cueId?: string;
}

export interface LyricSectionInput {
  role: LyricSectionRole;
  startSec: number;
  endSec: number;
  glow_color?: LyricGlowColor;
}

export interface LyricTypographyInput {
  lyrics: LyricLineInput[];
  /**
   * Explicit section ranges (e.g. from BGM section analysis). When present
   * they take precedence over `[Chorus]`-style tags inside the lyrics.
   */
  sections?: LyricSectionInput[];
  frame?: { width: number; height: number };
  safeMarginPx?: number;
  artworkRect?: { x: number; y: number; width: number; height: number };
  /** Placement is a style choice; poster crossing is the default MVP style. */
  positioning?: LyricPositioning;
  staccato?: { maxPerCharSec?: number; maxHoldSec?: number };
  /** Injected capability probe (tests). Default: real system probe. */
  probe?: LyricFontProbe;
  /**
   * Injected measurement (tests / alternate font stacks). Default: real
   * glyph advances from the resolved font binary per role, failing open to
   * display units only when no binary is measurable.
   */
  measure?: LyricMeasureFn;
  /** Accessibility: disables bounce/staccato motion; text timing unchanged. */
  reducedMotion?: boolean;
  /** Present for plans projected from approved/authored caption cues. */
  authority?: LyricTypographyAuthority;
}

export interface LyricCuePlan {
  /** Stable plan-local identity, deterministic from the same input. */
  plan_cue_id: string;
  /** Source cue/line identities; authored routes retain the #41 IDs. */
  cue_id: string;
  line_id: string;
  kind: "two_tier" | "staccato";
  start_sec: number;
  end_sec: number;
  section_role: Exclude<LyricSectionRole, "instrumental">;
  style_name: string;
  lines?: TwoTierLine[];
  chars?: StaccatoChar[];
  /** Present only when the section style renders a glow (chorus). */
  glow_color?: LyricGlowColor;
  position: PosterPosition & { content_width_px: number; left_x: number; right_x: number; within_safe_zone: boolean };
  raw_text: string;
  sanitized_text: string;
  removed_tokens: string[];
}

export interface LyricTypographyPlan {
  version: "lyric-typography-plan/v1";
  plan_id: string;
  input_hash: string;
  positioning: LyricPositioning;
  frame: { width: number; height: number };
  safe_zone: { left_px: number; right_px: number; safe_width_px: number };
  boundary: { artwork_rect: { x: number; y: number; width: number; height: number }; boundary_y: number };
  /** How line widths were measured for the fit decisions. */
  measurement: { method: LyricMeasurementMethod };
  fonts: Record<"verse" | "chorus" | "punk", LyricFontResolution>;
  cues: LyricCuePlan[];
  removed_metadata: Array<{ line: string; reason: string }>;
  violations: Array<{ code: string; message: string }>;
  accessibility: { reduced_motion: boolean };
  authority?: LyricTypographyAuthority;
}

function canonicalInputJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalInputJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalInputJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

/** Hash only deterministic, user-visible plan inputs; functions/probes are excluded. */
export function hashLyricTypographyInput(input: LyricTypographyInput): string {
  const frame = input.frame ?? LYRIC_FRAME;
  const artworkRect = input.artworkRect ?? LYRIC_ARTWORK_RECT;
  const safeMarginPx = input.safeMarginPx ?? LYRIC_SAFE_MARGIN_PX;
  return `sha256:${crypto.createHash("sha256").update(canonicalInputJson({
    lyrics: input.lyrics.map((line) => ({
      cueId: line.cueId ?? null,
      lineId: line.lineId ?? null,
      text: line.text,
      startSec: line.startSec,
      endSec: line.endSec,
    })),
    sections: input.sections ?? [],
    frame,
    safeMarginPx,
    artworkRect,
    positioning: input.positioning ?? "poster_boundary_cross",
    staccato: input.staccato ?? {},
    reducedMotion: Boolean(input.reducedMotion),
    authority: input.authority ?? null,
  })).digest("hex")}`;
}

function roleAt(sections: ParsedSection[], lineIndex: number): ParsedSection {
  let current: ParsedSection | undefined;
  for (const section of sections) {
    if (section.startLineIndex <= lineIndex) current = section;
    else break;
  }
  return current ?? { role: "verse", startLineIndex: 0, tag: "(implicit)", glowColor: "cyan" };
}

function sectionRoleForTime(
  sections: LyricSectionInput[] | undefined,
  midSec: number,
): { role: LyricSectionRole; glowColor?: LyricGlowColor } | undefined {
  if (!sections) return undefined;
  const hit = sections.find((s) => midSec >= s.startSec && midSec < s.endSec);
  return hit ? { role: hit.role, glowColor: hit.glow_color } : undefined;
}

/** Build the canonical plan: sanitized cues, measured bounds, font receipts. */
export function planLyricTypography(input: LyricTypographyInput): LyricTypographyPlan {
  const frame = input.frame ?? LYRIC_FRAME;
  const safeMarginPx = input.safeMarginPx ?? LYRIC_SAFE_MARGIN_PX;
  const safeWidthPx = frame.width - safeMarginPx * 2;
  const artworkRect = input.artworkRect ?? LYRIC_ARTWORK_RECT;
  const boundaryY = artworkRect.y + artworkRect.height;
  const positioning = input.positioning ?? "poster_boundary_cross";
  const inputHash = hashLyricTypographyInput(input);
  const planId = `LTP_${inputHash.slice("sha256:".length, "sha256:".length + 24)}`;

  const violations: Array<{ code: string; message: string }> = [];
  const removedMetadata: Array<{ line: string; reason: string }> = [];

  // Tag-driven sections over line indices.
  const parsed: SectionParseResult = { sections: [], diagnostics: [] };
  const sanitizedInputs: Array<{ text: string; removedTokens: string[]; raw: string }> = [];
  input.lyrics.forEach((entry, index) => {
    const consumed = consumeSectionTags(entry.text);
    for (const tag of consumed.sections) {
      if (tag.role === "instrumental") {
        parsed.sections.push({ role: "instrumental", startLineIndex: index + 1, tag: tag.tag, glowColor: "cyan" });
      } else {
        parsed.sections.push({
          role: tag.role,
          startLineIndex: index,
          tag: tag.tag,
          glowColor: tag.glowColor ?? (tag.role === "chorus" ? "cyan" : "cyan"),
        });
      }
    }
    parsed.diagnostics.push(...consumed.unknownTags.map((tag) => `unknown section tag ${tag} treated as verse`));
    const sanitized = sanitizeLyricEntryLines(consumed.text);
    sanitizedInputs.push({ text: sanitized.text, removedTokens: sanitized.removedTokens, raw: entry.text });
  });
  for (const diagnostic of parsed.diagnostics) {
    violations.push({ code: "unknown_section_tag", message: diagnostic });
  }

  const defaultMeasure = createDefaultLyricMeasure(input.probe);
  const measure = input.measure ?? defaultMeasure.measure;
  // Fail closed when no binary could be bound: width decisions would not
  // correspond to any renderable font, so delivery must abort.
  for (const [role, binding] of Object.entries(defaultMeasure.bindings)) {
    if (binding.method !== "glyph_advance/v1" || !binding.font_path) {
      violations.push({ code: "font_binding", message: `${role}: ${binding.detail}` });
    }
  }

  const fontCache = new Map<string, LyricFontResolution>();
  const fontFor = (role: Exclude<LyricSectionRole, "instrumental">): LyricFontResolution => {
    const cached = fontCache.get(role);
    if (cached) return cached;
    const resolution = resolveLyricFont(LYRIC_ROLE_STYLES[role], input.probe);
    fontCache.set(role, resolution);
    return resolution;
  };

  const cues: LyricCuePlan[] = [];
  sanitizedInputs.forEach((entry, index) => {
    const lyric = input.lyrics[index];
    const cueIdentity = {
      plan_cue_id: `${planId}_C${String(index + 1).padStart(4, "0")}`,
      cue_id: lyric.cueId ?? `LC_${String(index + 1).padStart(4, "0")}`,
      line_id: lyric.lineId ?? `LL_${String(index + 1).padStart(4, "0")}`,
    };
    if (cues.some((cue) => cue.cue_id === cueIdentity.cue_id || cue.line_id === cueIdentity.line_id)) {
      violations.push({ code: "duplicate_source_identity", message: `duplicate lyric cue or line identity at input ${index}` });
      return;
    }
    if (lyric.endSec <= lyric.startSec) {
      violations.push({ code: "invalid_timing", message: `lyric line ${index} has end <= start (${lyric.startSec}..${lyric.endSec})` });
      return;
    }
    if (!entry.text) {
      if (entry.removedTokens.length > 0) {
        removedMetadata.push({ line: entry.raw, reason: `metadata-only line: ${entry.removedTokens.join(" ")}` });
      } else if (parsed.sections.some((section) => section.startLineIndex === index || section.startLineIndex === index + 1)) {
        removedMetadata.push({ line: entry.raw, reason: "section tag line" });
      }
      return;
    }

    // Explicit section ranges (by time) override tag-driven sections.
    const midSec = (lyric.startSec + lyric.endSec) / 2;
    const timedSection = sectionRoleForTime(input.sections, midSec);
    const tagSection = roleAt(parsed.sections, index);
    const effectiveRole = timedSection?.role ?? tagSection.role;
    if (effectiveRole === "instrumental") return;
    const role = effectiveRole as Exclude<LyricSectionRole, "instrumental">;
    const glowColor = timedSection?.glowColor ?? tagSection.glowColor ?? "cyan";
    const style = LYRIC_ROLE_STYLES[role];

    removedMetadata.push(...(entry.removedTokens.length > 0
      ? [{ line: entry.raw, reason: `stripped metadata: ${entry.removedTokens.join(" ")}` }]
      : []));

    if (role === "punk") {
      const expansion = expandKineticStaccato(entry.text, lyric.startSec, lyric.endSec, {
        ...(input.staccato ?? {}),
        ...(input.reducedMotion !== undefined ? { reducedMotion: input.reducedMotion } : {}),
        measure,
      });
      if (expansion.violation) {
        violations.push({ code: "staccato", message: expansion.violation });
        return;
      }
      const cardWidth = Math.max(...expansion.chars.map((c) => c.ink_width_px), 0);
      if (input.reducedMotion && cardWidth > safeWidthPx) {
        // A reduced-motion card wider than the safe zone is NOT shipped and
        // NOT silently overflowed: it falls back to the normal measured
        // two-tier breaker (line-broken + auto-scaled), and only fails
        // closed when even that cannot fit.
        const br = breakLyricTwoTier(entry.text, { role, safeWidthPx, measure });
        if (br.violation) {
          violations.push({ code: "safe_width", message: `line ${index}: ${br.violation}` });
        }
        const mainLine = br.lines.find((l) => l.tier === "main") ?? br.lines[0];
        const blockHeight = br.lines.reduce((sum, l) => sum + l.line_height_px, 0);
        const subLineHeight = br.lines.length > 1 ? br.lines[br.lines.length - 1].line_height_px : 0;
        const contentWidth = Math.max(...br.lines.map((l) => l.measured_width_px), 0);
        const position = positioning === "bottom_center"
          ? resolveBottomCenterPosition(mainLine.font_size_px, blockHeight, frame, boundaryY, subLineHeight)
          : resolvePosterPosition(mainLine.font_size_px, blockHeight, frame, boundaryY, subLineHeight);
        const horizontal = resolveHorizontalBounds(contentWidth, frame, safeMarginPx);
        cues.push({
          ...cueIdentity,
          kind: "two_tier",
          start_sec: lyric.startSec,
          end_sec: lyric.endSec,
          section_role: role,
          style_name: style.styleName,
          lines: br.lines,
          position: { ...position, ...horizontal },
          raw_text: entry.raw,
          sanitized_text: entry.text,
          removed_tokens: entry.removedTokens,
        });
        return;
      }
      const charWidth = cardWidth;
      const charHeight = Math.round(LYRIC_STACCATO_SIZE_PX * 1.2);
      const centerX = Math.round(frame.width / 2);
      const centerY = Math.round(frame.height / 2);
      // Fail closed: an overflowing kinetic staccato is a violation, not
      // just a recorded flag — the delivery layer refuses to write it.
      if (charWidth > safeWidthPx) {
        violations.push({
          code: "safe_width",
          message: `staccato line ${index}: ink ${Math.round(charWidth * 10) / 10}px exceeds the ${safeWidthPx}px safe width; split the staccato line upstream`,
        });
      }
      cues.push({
        ...cueIdentity,
        kind: "staccato",
        start_sec: lyric.startSec,
        end_sec: lyric.endSec,
        section_role: role,
        style_name: style.styleName,
        chars: expansion.chars,
        position: {
          margin_v_px: 0,
          margin_v_main_px: 0,
          margin_v_sub_px: 0,
          text_top_y: centerY - Math.round(charHeight / 2),
          text_bottom_y: centerY + Math.round(charHeight / 2),
          crosses_boundary: centerY + charHeight / 2 > boundaryY && centerY - charHeight / 2 < boundaryY,
          boundary_y: boundaryY,
          content_width_px: charWidth,
          left_x: centerX - charWidth / 2,
          right_x: centerX + charWidth / 2,
          within_safe_zone: charWidth <= safeWidthPx,
        },
        raw_text: entry.raw,
        sanitized_text: entry.text,
        removed_tokens: entry.removedTokens,
      });
      return;
    }

    const manualLines = entry.text.includes("\n")
      ? entry.text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
      : undefined;
    const ctx = makeMeasureContext(role, safeWidthPx, measure);
    const br = manualLines
      ? manualTwoTier(manualLines, ctx)
      : breakLyricTwoTier(entry.text, { role, safeWidthPx, measure });
    if (br.violation) {
      violations.push({ code: "safe_width", message: `line ${index}: ${br.violation}` });
    }
    const mainLine = br.lines.find((l) => l.tier === "main") ?? br.lines[0];
    const blockHeight = br.lines.reduce((sum, l) => sum + l.line_height_px, 0);
    const subLineHeight = br.lines.length > 1 ? br.lines[br.lines.length - 1].line_height_px : 0;
    const contentWidth = Math.max(...br.lines.map((l) => l.measured_width_px), 0);
    const position = positioning === "bottom_center"
      ? resolveBottomCenterPosition(mainLine.font_size_px, blockHeight, frame, boundaryY, subLineHeight)
      : resolvePosterPosition(mainLine.font_size_px, blockHeight, frame, boundaryY, subLineHeight);
    const horizontal = resolveHorizontalBounds(contentWidth, frame, safeMarginPx);
    cues.push({
      ...cueIdentity,
      kind: "two_tier",
      start_sec: lyric.startSec,
      end_sec: lyric.endSec,
      section_role: role,
      style_name: style.styleName,
      lines: br.lines,
      ...(style.glow ? { glow_color: glowColor } : {}),
      position: { ...position, ...horizontal },
      raw_text: entry.raw,
      sanitized_text: entry.text,
      removed_tokens: entry.removedTokens,
    });
  });

  return {
    version: "lyric-typography-plan/v1",
    plan_id: planId,
    input_hash: inputHash,
    positioning,
    frame: { width: frame.width, height: frame.height },
    safe_zone: { left_px: safeMarginPx, right_px: safeMarginPx, safe_width_px: safeWidthPx },
    boundary: {
      artwork_rect: { ...artworkRect },
      boundary_y: boundaryY,
    },
    measurement: { method: input.measure ? "glyph_advance/v1" : defaultMeasure.method },
    fonts: {
      verse: fontFor("verse"),
      chorus: fontFor("chorus"),
      punk: fontFor("punk"),
    },
    cues,
    removed_metadata: removedMetadata,
    violations,
    accessibility: { reduced_motion: Boolean(input.reducedMotion) },
    ...(input.authority ? { authority: input.authority } : {}),
  };
}

/**
 * Authored `\n` breaks: line 1 = main tier, line 2 = sub tier, auto-sized.
 * More than two authored lines are NORMALIZED without loss: the first line
 * becomes the main tier and the remaining lines are joined (characters
 * preserved, nothing dropped) into the sub tier; the measurement gate then
 * decides fit and fails closed with a violation when the joined tier cannot
 * fit — it never silently drops a line or overflows the safe zone.
 */
function manualTwoTier(
  lines: string[],
  ctx: TierMeasureContext,
): TwoTierBreak {
  const normalized = lines.length > 2
    ? [lines[0], lines.slice(1).join("")]
    : lines;
  const mainLadder = ladderFor(ctx.role, "main");
  const subLadder = ladderFor(ctx.role, "sub");
  const out: TwoTierLine[] = [];
  normalized.forEach((line, index) => {
    const ladder = index === 0 ? mainLadder : subLadder;
    const tier: "main" | "sub" = index === 0 ? "main" : "sub";
    const size = ladder.find((s) => measureInkPx(ctx, line, s) <= ctx.safeWidthPx) ?? ladder[ladder.length - 1];
    out.push(makeTierLine(line, tier, size, ctx));
  });
  const allFit = out.every((l) => l.fits_safe_width);
  return {
    lines: out,
    selection_reason: "phrase_boundary",
    ...(allFit ? {} : {
      violation: `manual line break does not fit the ${ctx.safeWidthPx}px safe width`,
    }),
  };
}

// ── ASS output ───────────────────────────────────────────────────────────

function assTimestamp(seconds: number): string {
  const cs = Math.max(0, Math.round(seconds * 100));
  const h = Math.floor(cs / 360000);
  const m = Math.floor((cs % 360000) / 6000);
  const s = Math.floor((cs % 6000) / 100);
  const c = cs % 100;
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(c).padStart(2, "0")}`;
}

/** RRGGBBAA -> ASS style colour &HAABBGGRR (alpha 00 = opaque). */
function assStyleColor(rgba: string): string {
  const r = rgba.slice(0, 2);
  const g = rgba.slice(2, 4);
  const b = rgba.slice(4, 6);
  const a = rgba.slice(6, 8);
  const assAlpha = (255 - parseInt(a, 16)).toString(16).padStart(2, "0").toUpperCase();
  return `&H${assAlpha}${b}${g}${r}`;
}

/** RRGGBB -> inline ASS override colour &HBBGGRR&. */
function assInlineColor(rgb: string): string {
  const r = rgb.slice(0, 2);
  const g = rgb.slice(2, 4);
  const b = rgb.slice(4, 6);
  return `&H${b}${g}${r}&`.toUpperCase();
}

function escapeOverrideText(text: string): string {
  return escapeAssCaptionText(text);
}

function chorusBounceTags(): string {
  // Bounce-in: pop from 60% -> 112% -> settle 100%.
  return "\\fscx60\\fscy60\\t(0,120,\\fscx112\\fscy112)\\t(120,240,\\fscx100\\fscy100)";
}

function chorusGlowTags(glowColor: LyricGlowColor): string {
  const glow = GLOW_COLORS[glowColor];
  return `\\3c${assInlineColor(glow.slice(0, 6))}\\blur5`;
}

function mainTierEventText(cue: LyricCuePlan, reducedMotion: boolean): string {
  const role = LYRIC_ROLE_STYLES[cue.section_role];
  const main = (cue.lines ?? [])[0];
  const prefix: string[] = [];
  // The style row carries the role's reference size; auto-downsized mains
  // restate the exact size inline so rendering always matches the measurement.
  prefix.push(`\\fs${main.font_size_px}`, `\\bord${Math.round(role.outlinePx * 10) / 10}`);
  if (cue.glow_color) {
    prefix.push(chorusGlowTags(cue.glow_color));
  }
  if (cue.glow_color && !reducedMotion) {
    prefix.push(chorusBounceTags());
  }
  return `{${prefix.join("")}}${escapeOverrideText(main.text)}`;
}

function subTierEventText(cue: LyricCuePlan): string | undefined {
  const role = LYRIC_ROLE_STYLES[cue.section_role];
  const lines = cue.lines ?? [];
  const main = lines[0];
  const sub = lines[1];
  if (!sub) return undefined;
  const subScale = sub.font_size_px / main.font_size_px;
  const subBord = Math.round(role.outlinePx * subScale * 10) / 10;
  const tags: string[] = [`\\fs${sub.font_size_px}\\bord${subBord}`];
  // The glow halo extends over both tiers; bounce stays main-only so the
  // sub tier never re-triggers motion independently.
  if (cue.glow_color) {
    tags.push(chorusGlowTags(cue.glow_color));
  }
  return `{${tags.join("")}}${escapeOverrideText(sub.text)}`;
}

function staccatoDialogueText(char: StaccatoChar, frameWidth: number, frameHeight: number, reducedMotion: boolean): string {
  const pop = reducedMotion ? "" : "\\fscx88\\fscy88\\t(0,60,\\fscx100\\fscy100)";
  return `{\\an5\\pos(${Math.round(frameWidth / 2)},${Math.round(frameHeight / 2)})${pop}}${escapeOverrideText(char.char)}`;
}

/**
 * Build the burn-ready ASS document from the plan. PlayRes is pinned to the
 * real frame so MarginV/alignment are exact; WrapStyle 2 keeps the approved
 * two-tier layout instead of letting libass re-wrap.
 *
 * Per-event margins: every two-tier Dialogue carries its own
 * MarginL/MarginR/MarginV columns (main and sub tiers are separate events)
 * so the planned composition — main tier em-center on the artwork boundary
 * — actually renders, instead of every cue inheriting one static style-row
 * MarginV. Staccato events keep 0/0/0 and override with \an5\pos.
 */
export function buildLyricAssDocument(plan: LyricTypographyPlan): string {
  const styleRows = (Object.values(LYRIC_ROLE_STYLES) as RoleStyle[]).map((style) => {
    const font = plan.fonts[style.role];
    const cuesForRole = plan.cues.filter((cue) => cue.section_role === style.role);
    const marginV = cuesForRole[0]?.position.margin_v_main_px ?? 0;
    return [
      `Style: ${style.styleName}`,
      font.resolved_family,
      String(style.mainSizePx),
      assStyleColor("FFFFFFFF"),
      assStyleColor("FFFFFFFF"),
      assStyleColor("0A0A0AFF"),
      "&H00000000",
      "0", // family name carries the weight; no synthetic bold
      "0", "0", "0", "100", "100", "0", "0",
      "1",
      String(Math.round(style.outlinePx * 10) / 10),
      "0",
      "2", // bottom-center; staccato events override with \an5\pos
      String(plan.safe_zone.left_px),
      String(plan.safe_zone.right_px),
      String(marginV),
      "1",
    ].join(",");
  });

  const lines: string[] = [
    "[Script Info]",
    "ScriptType: v4.00+",
    `PlayResX: ${plan.frame.width}`,
    `PlayResY: ${plan.frame.height}`,
    "WrapStyle: 2",
    "ScaledBorderAndShadow: yes",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    ...styleRows,
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
  ];

  const reducedMotion = plan.accessibility.reduced_motion;
  const safeMargin = String(plan.safe_zone.left_px);
  for (const cue of plan.cues) {
    if (cue.kind === "two_tier") {
      const span = `${assTimestamp(cue.start_sec)},${assTimestamp(cue.end_sec)}`;
      lines.push(
        `Dialogue: 0,${span},${cue.style_name},,${safeMargin},${safeMargin},${Math.round(cue.position.margin_v_main_px)},,${mainTierEventText(cue, reducedMotion)}`,
      );
      const subText = subTierEventText(cue);
      if (subText !== undefined) {
        lines.push(
          `Dialogue: 0,${span},${cue.style_name},,${safeMargin},${safeMargin},${Math.round(cue.position.margin_v_sub_px)},,${subText}`,
        );
      }
      continue;
    }
    // Kinetic staccato: one Dialogue per character, back-to-back. Under
    // reduced motion the expansion is a single static entry (no flicker).
    for (const char of cue.chars ?? []) {
      lines.push(
        `Dialogue: 0,${assTimestamp(char.start_sec)},${assTimestamp(char.end_sec)},${cue.style_name},,0,0,0,,${staccatoDialogueText(char, plan.frame.width, plan.frame.height, reducedMotion)}`,
      );
    }
  }
  return lines.join("\n") + "\n";
}
