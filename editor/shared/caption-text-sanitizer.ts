/**
 * Emoji rendering is not deterministic across libass, drawtext, browsers, and
 * host OS font fallback. Strip complete emoji grapheme clusters at the shared
 * render boundary so unsupported color glyphs can never become tofu boxes.
 * Authored/source text remains unchanged in canonical artifacts.
 */
const EMOJI_CLUSTER = /(?:\p{Regional_Indicator}{2}|[#*0-9]\uFE0F?\u20E3|\p{Extended_Pictographic}[\uFE0E\uFE0F]?(?:\p{Emoji_Modifier})?(?:\u200D\p{Extended_Pictographic}[\uFE0E\uFE0F]?(?:\p{Emoji_Modifier})?)*)/gu;

const ORPHAN_EMOJI_CODEPOINT = /[\u200D\uFE0E\uFE0F\p{Emoji_Modifier}]/gu;

export function sanitizeCaptionTextForRendering(text: string): string {
  const lines = text
    .normalize("NFC")
    .replace(EMOJI_CLUSTER, " ")
    .replace(ORPHAN_EMOJI_CODEPOINT, "")
    .split(/\r?\n/)
    .map((line) => line.replace(/[ \t]{2,}/g, " ").trim());
  const sanitized = lines.join("\n").trim();
  return sanitized.length > 0 ? sanitized : "…";
}

/** Escape sanitized authored text without allowing ASS override-tag injection. */
export function escapeAssCaptionText(text: string): string {
  return sanitizeCaptionTextForRendering(text)
    .split("\n")
    .map((line) => line
      .replace(/\\/g, "\\\\")
      .replace(/{/g, "\\{")
      .replace(/}/g, "\\}"))
    .join("\\N");
}
