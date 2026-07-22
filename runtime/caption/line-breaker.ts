/**
 * Caption auto line-break engine.
 *
 * Layout constraints by language:
 * - Japanese: 20 chars/line, 2 lines max, CPS 6.0
 * - English: 42 chars/line, 2 lines max, CPS 15.0
 *
 * Break priority:
 * 1. After punctuation
 * 2. At word/phrase boundary
 * 3. Near midpoint for balance
 * 4. Avoid line-start particles (ja) / orphan function words (en)
 * 5. If still too long, propose caption split
 */

// ---------------------------------------------------------------------------
// Layout policy
// ---------------------------------------------------------------------------

export interface LayoutPolicy {
  maxCharsPerLine: number;
  maxLines: number;
  maxCps: number;
  language: string;
}

export const LAYOUT_POLICIES: Record<string, LayoutPolicy> = {
  ja: { maxCharsPerLine: 20, maxLines: 2, maxCps: 6.0, language: "ja" },
  en: { maxCharsPerLine: 42, maxLines: 2, maxCps: 15.0, language: "en" },
};

export function getLayoutPolicy(
  language: string,
  stylingClass?: string,
): LayoutPolicy {
  if (language.startsWith("ja")) {
    if (
      stylingClass &&
      /(?:sns-vertical|speaker-separated.*outline|outline.*speaker-separated|social-short)/i.test(stylingClass)
    ) {
      return {
        ...LAYOUT_POLICIES.ja,
        maxCharsPerLine: 13,
        maxCps: 16,
      };
    }
    return LAYOUT_POLICIES.ja;
  }
  if (language.startsWith("en")) return LAYOUT_POLICIES.en;
  // Default to Japanese policy for CJK, English otherwise
  return LAYOUT_POLICIES.en;
}

// ---------------------------------------------------------------------------
// Break rules
// ---------------------------------------------------------------------------

/** Japanese line-start particles that must not begin a new line */
const JA_LINE_START_FORBIDDEN = new Set([
  "は", "が", "を", "に", "で", "と", "も", "の", "へ", "や", "か",
  "って", "った", "ます", "です", "ない", "する", "した", "って",
  "すぎ", "して", "しま", "ため", "ので", "のに", "けれ", "という",
  "こと", "もの", "区", "市", "県", "町", "村", "氏", "先生", "さん",
  "て", "る", "ん",
]);

const JA_LINE_END_DISCOURAGED = new Set([
  "は", "が", "を", "に", "で", "と", "も", "の", "へ", "や", "か",
  "から", "まで", "より", "って",
]);

/** English function words that should not be orphaned at line start */
const EN_ORPHAN_WORDS = new Set([
  "a", "an", "the", "to", "of", "and", "or", "in", "on", "at",
  "is", "it", "by", "as", "if", "so", "no",
]);

/** Japanese punctuation that makes good break points */
const JA_BREAK_AFTER = /[。、！？!?,.:;]/;

/** English punctuation break points */
const EN_BREAK_AFTER = /[.,;:!?)\]]/;

// ---------------------------------------------------------------------------
// Line break result
// ---------------------------------------------------------------------------

export interface LineBreakResult {
  lines: string[];
  needsSplit: boolean;
  layoutViolation: boolean;
}

// ---------------------------------------------------------------------------
// Core line-break logic
// ---------------------------------------------------------------------------

/**
 * Break caption text into lines according to layout policy.
 */
export function breakLines(
  text: string,
  policy: LayoutPolicy,
  protectedTerms: string[] = [],
): LineBreakResult {
  // If already has manual line breaks, validate them
  if (text.includes("\n")) {
    const existing = text.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
    if (existing.length <= policy.maxLines &&
        existing.every((l) => lineLength(l, policy.language) <= policy.maxCharsPerLine)) {
      return { lines: existing, needsSplit: false, layoutViolation: false };
    }
    // Re-break from flat text
    text = existing.join("");
  }

  const len = lineLength(text, policy.language);

  // Fits in one line
  if (len <= policy.maxCharsPerLine) {
    return { lines: [text], needsSplit: false, layoutViolation: false };
  }

  // Needs 2 lines
  if (len <= policy.maxCharsPerLine * policy.maxLines) {
    const lines = splitIntoTwoLines(text, policy, protectedTerms);
    return { lines, needsSplit: false, layoutViolation: false };
  }

  // Too long for 2 lines — try best effort 2-line, mark for split
  const lines = splitIntoTwoLines(text, policy, protectedTerms);
  const violation = lines.some(
    (l) => lineLength(l, policy.language) > policy.maxCharsPerLine,
  );

  return { lines, needsSplit: true, layoutViolation: violation };
}

/**
 * Split text into two balanced lines using priority rules.
 */
function splitIntoTwoLines(
  text: string,
  policy: LayoutPolicy,
  protectedTerms: string[],
): string[] {
  const isJa = policy.language.startsWith("ja");
  const jaWordBoundaries = isJa ? findJapaneseWordBoundaries(text) : new Set<number>();
  const allCandidates = findBreakCandidates(text, policy);
  const fittingCandidates = allCandidates.filter((idx) => {
    const line1 = text.slice(0, idx).trim();
    const line2 = text.slice(idx).trim();
    return lineLength(line1, policy.language) <= policy.maxCharsPerLine &&
      lineLength(line2, policy.language) <= policy.maxCharsPerLine &&
      !isInsideProtectedTerm(text, idx, protectedTerms);
  });
  // A two-line caption that fits the declared layout must never overflow just
  // to avoid a less desirable grammatical break. Apply linguistic scoring
  // only after enforcing the hard width constraint.
  const candidates = fittingCandidates.length > 0
    ? fittingCandidates
    : allCandidates;

  if (candidates.length === 0) {
    // No good break point; split at midpoint
    const mid = Math.floor(text.length / 2);
    return [text.slice(0, mid).trim(), text.slice(mid).trim()];
  }

  // Score each candidate: prefer balanced, valid breaks
  const target = text.length / 2;
  let bestIdx = candidates[0];
  let bestScore = Infinity;

  for (const idx of candidates) {
    const line1 = text.slice(0, idx).trim();
    const line2 = text.slice(idx).trim();
    const line1Len = lineLength(line1, policy.language);
    const line2Len = lineLength(line2, policy.language);

    // Penalty: imbalance
    let score = Math.abs(line1Len - line2Len);

    if (isJa) {
      // Natural Japanese captions should break at punctuation or a lexical
      // boundary before considering visual balance. Intl.Segmenter gives us
      // deterministic word-like boundaries without a morphology dependency.
      if (/[。、！？!?,.:;]$/.test(line1)) score -= 80;
      if (jaWordBoundaries.has(idx)) score -= 30;
      if (!jaWordBoundaries.has(idx) && isSameScriptContinuation(text[idx - 1], text[idx])) {
        // A visually balanced midpoint is still a bad subtitle break when it
        // tears one reading unit apart (e.g. こ|れ, 探そ|う, Gemini, 100).
        // Prefer the nearest lexical boundary even when the two lines are a
        // little less symmetrical.
        score += 100;
      }
      if (endsWithJaDiscouragedToken(line1)) score += 35;
      if (/^[。、！？!?,.:;）】」』]/.test(line2)) score += 80;
      if (isKanjiToHiraganaContinuation(text[idx - 1], text[idx])) score += 120;
    }

    // Penalty: line too long
    if (line1Len > policy.maxCharsPerLine) score += (line1Len - policy.maxCharsPerLine) * 5;
    if (line2Len > policy.maxCharsPerLine) score += (line2Len - policy.maxCharsPerLine) * 5;

    // Penalty: forbidden line start
    if (isJa && line2.length > 0 && isJaForbiddenLineStart(line2)) {
      score += 120;
    }
    if (!isJa && line2.length > 0 && isEnOrphanStart(line2)) {
      score += 20;
    }

    // Penalty: punctuation-only line
    if (isPunctuationOnly(line1) || isPunctuationOnly(line2)) {
      score += 50;
    }

    if (score < bestScore) {
      bestScore = score;
      bestIdx = idx;
    }
  }

  const line1 = text.slice(0, bestIdx).trim();
  const line2 = text.slice(bestIdx).trim();

  return [line1, line2].filter((l) => l.length > 0);
}

/**
 * Find candidate break positions in text.
 */
function findBreakCandidates(text: string, policy: LayoutPolicy): number[] {
  const isJa = policy.language.startsWith("ja");
  const positions: number[] = [];

  for (let i = 1; i < text.length; i++) {
    const prevChar = text[i - 1];
    const curChar = text[i];

    // Priority 1: After punctuation
    if (isJa ? JA_BREAK_AFTER.test(prevChar) : EN_BREAK_AFTER.test(prevChar)) {
      positions.push(i);
      continue;
    }

    // Priority 2: At word boundaries
    if (!isJa && prevChar === " ") {
      positions.push(i);
      continue;
    }

    // For Japanese: break between any two characters (word boundaries are implicit)
    if (isJa) {
      positions.push(i);
    }
  }

  return positions;
}

function findJapaneseWordBoundaries(text: string): Set<number> {
  if (typeof Intl.Segmenter !== "function") return new Set<number>();
  return new Set(
    [...new Intl.Segmenter("ja", { granularity: "word" }).segment(text)]
      .map((segment) => segment.index)
      .filter((index) => index > 0 && index < text.length),
  );
}

function endsWithJaDiscouragedToken(line: string): boolean {
  if (typeof Intl.Segmenter === "function") {
    const segments = [...new Intl.Segmenter("ja", { granularity: "word" }).segment(line)];
    const last = segments.at(-1)?.segment;
    return last ? JA_LINE_END_DISCOURAGED.has(last) : false;
  }
  return [...JA_LINE_END_DISCOURAGED].some((token) => line === token);
}

function isKanjiToHiraganaContinuation(previous: string, next: string): boolean {
  if (!/[一-龯々]/.test(previous) || !/[ぁ-ゖ]/.test(next)) return false;
  // These single-character particles commonly form a valid bunsetsu break.
  return !/[はがをにでとのへもやか]/.test(next);
}

function isSameScriptContinuation(previous: string, next: string): boolean {
  if (!previous || !next) return false;
  return (
    (/[ぁ-ゖ]/.test(previous) && /[ぁ-ゖ]/.test(next)) ||
    (/[ァ-ヺー]/.test(previous) && /[ァ-ヺー]/.test(next)) ||
    (/[A-Za-z]/.test(previous) && /[A-Za-z]/.test(next)) ||
    (/[0-9]/.test(previous) && /[0-9]/.test(next))
  );
}

function isInsideProtectedTerm(
  text: string,
  index: number,
  protectedTerms: string[],
): boolean {
  for (const term of protectedTerms) {
    if (!term) continue;
    let start = text.indexOf(term);
    while (start >= 0) {
      if (index > start && index < start + term.length) return true;
      start = text.indexOf(term, start + term.length);
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Compute line length in display units.
 * Japanese: character count (each CJK char = 1)
 * English: character count
 */
function lineLength(text: string, language: string): number {
  return text.length;
}

function isJaForbiddenLineStart(line: string): boolean {
  if (line.length === 0) return false;
  // Check first character
  if (JA_LINE_START_FORBIDDEN.has(line[0])) return true;
  // Check first two characters (e.g. って, った)
  if (line.length >= 2 && JA_LINE_START_FORBIDDEN.has(line.slice(0, 2))) return true;
  // Check first three characters (e.g. ます, です)
  if (line.length >= 3 && JA_LINE_START_FORBIDDEN.has(line.slice(0, 3))) return true;
  return false;
}

function isEnOrphanStart(line: string): boolean {
  const firstWord = line.split(/\s/)[0]?.toLowerCase();
  return EN_ORPHAN_WORDS.has(firstWord ?? "");
}

function isPunctuationOnly(line: string): boolean {
  return line.replace(/[\s。、,.!?！？・…\-ー]+/g, "").length === 0;
}

// ---------------------------------------------------------------------------
// Caption CPS check
// ---------------------------------------------------------------------------

export interface CpsCheckResult {
  withinLimit: boolean;
  cps: number;
  limit: number;
}

/**
 * Check if caption CPS is within policy limit.
 */
export function checkCps(
  text: string,
  durationMs: number,
  policy: LayoutPolicy,
): CpsCheckResult {
  if (durationMs <= 0) return { withinLimit: true, cps: 0, limit: policy.maxCps };
  const seconds = durationMs / 1000;
  const len = text.replace(/\n/g, "").length;
  const cps = len / seconds;
  return {
    withinLimit: cps <= policy.maxCps,
    cps: Math.round(cps * 100) / 100,
    limit: policy.maxCps,
  };
}

/**
 * Format caption text with line breaks applied.
 */
export function formatCaption(
  text: string,
  language: string,
  protectedTerms: string[] = [],
  stylingClass?: string,
): LineBreakResult {
  const policy = getLayoutPolicy(language, stylingClass);
  return breakLines(text, policy, protectedTerms);
}
