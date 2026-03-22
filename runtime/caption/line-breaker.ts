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

export function getLayoutPolicy(language: string): LayoutPolicy {
  if (language.startsWith("ja")) return LAYOUT_POLICIES.ja;
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
    const lines = splitIntoTwoLines(text, policy);
    return { lines, needsSplit: false, layoutViolation: false };
  }

  // Too long for 2 lines — try best effort 2-line, mark for split
  const lines = splitIntoTwoLines(text, policy);
  const violation = lines.some(
    (l) => lineLength(l, policy.language) > policy.maxCharsPerLine,
  );

  return { lines, needsSplit: true, layoutViolation: violation };
}

/**
 * Split text into two balanced lines using priority rules.
 */
function splitIntoTwoLines(text: string, policy: LayoutPolicy): string[] {
  const isJa = policy.language.startsWith("ja");
  const candidates = findBreakCandidates(text, policy);

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

    // Penalty: line too long
    if (line1Len > policy.maxCharsPerLine) score += (line1Len - policy.maxCharsPerLine) * 5;
    if (line2Len > policy.maxCharsPerLine) score += (line2Len - policy.maxCharsPerLine) * 5;

    // Penalty: forbidden line start
    if (isJa && line2.length > 0 && isJaForbiddenLineStart(line2)) {
      score += 20;
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
): LineBreakResult {
  const policy = getLayoutPolicy(language);
  return breakLines(text, policy);
}
