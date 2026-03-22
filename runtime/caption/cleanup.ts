/**
 * Deterministic caption text cleanup.
 *
 * Runs BEFORE LLM editorial to remove obvious STT noise:
 * - Rejoin split acronyms (A_I → AI, C_E_O → CEO)
 * - Remove stray/isolated punctuation
 * - Normalize duplicate punctuation
 * - Strip filler-only captions (delegated to segmenter)
 */

// ---------------------------------------------------------------------------
// Acronym rejoining
// ---------------------------------------------------------------------------

/**
 * Rejoin underscore-split or space-split uppercase letter sequences.
 * Examples: "A_I" → "AI", "C_E_O" → "CEO", "A I" → "AI"
 */
export function rejoinAcronyms(text: string): string {
  // Pattern: single uppercase letters separated by underscores: A_I, C_E_O, G_P_T
  let result = text.replace(
    /\b([A-Z])(?:[_]([A-Z]))+\b/g,
    (match) => match.replace(/_/g, ""),
  );

  // Pattern: single uppercase letters separated by spaces: "A I", "C E O"
  // Must be 2+ consecutive single-letter groups to avoid false positives
  result = result.replace(
    /\b([A-Z])\s(?:[A-Z]\s)*[A-Z]\b/g,
    (match) => match.replace(/\s/g, ""),
  );

  return result;
}

// ---------------------------------------------------------------------------
// Punctuation cleanup
// ---------------------------------------------------------------------------

/**
 * Remove stray/isolated punctuation marks that float alone or at invalid positions.
 * - Lone period/comma/。/、 with only whitespace around it
 * - Leading punctuation (. at start of caption)
 */
export function removeStrayPunctuation(text: string): string {
  // Remove lone punctuation surrounded by whitespace (or at boundaries)
  let result = text.replace(/(?:^|\s)[.。、,]+(?:\s|$)/g, " ");

  // Remove leading punctuation
  result = result.replace(/^[.。、,!！?？\s]+/, "");

  // Trim multiple spaces to single
  result = result.replace(/\s{2,}/g, " ").trim();

  return result;
}

/**
 * Normalize duplicate/consecutive punctuation.
 * - "。。" → "。"
 * - ".." → "."  (but "..." is preserved as ellipsis)
 * - "、、" → "、"
 * - "!!" → "!"
 * - "??" → "?"
 */
export function normalizePunctuation(text: string): string {
  // Preserve legitimate ellipsis (…, ...) but collapse others
  let result = text;

  // Japanese punctuation dedup
  result = result.replace(/。{2,}/g, "。");
  result = result.replace(/、{2,}/g, "、");
  result = result.replace(/！{2,}/g, "！");
  result = result.replace(/？{2,}/g, "？");

  // English punctuation dedup (preserve ... as ellipsis)
  result = result.replace(/\.{4,}/g, "...");
  result = result.replace(/,{2,}/g, ",");
  result = result.replace(/!{2,}/g, "!");
  result = result.replace(/\?{2,}/g, "?");

  return result;
}

// ---------------------------------------------------------------------------
// Combined cleanup pipeline
// ---------------------------------------------------------------------------

/**
 * Full deterministic cleanup pipeline.
 * Order matters: acronyms first (uses underscores), then punctuation.
 */
export function cleanupCaptionText(text: string): string {
  let result = text;

  // 1. Rejoin split acronyms
  result = rejoinAcronyms(result);

  // 2. Remove stray punctuation
  result = removeStrayPunctuation(result);

  // 3. Normalize duplicate punctuation
  result = normalizePunctuation(result);

  // 4. Final whitespace cleanup
  result = result.replace(/\s{2,}/g, " ").trim();

  return result;
}
