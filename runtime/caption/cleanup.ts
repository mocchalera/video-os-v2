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

/** Well-known acronyms for safe space-split rejoining */
const KNOWN_ACRONYMS = new Set([
  "AI", "CEO", "CTO", "CFO", "COO", "GPT", "API", "SDK", "LLM", "NLP",
  "URL", "HTML", "CSS", "SQL", "AWS", "GCP", "USB", "CPU", "GPU", "RAM",
  "SSD", "HDD", "IoT", "VPN", "DNS", "HTTP", "SSH", "FTP", "TCP", "UDP",
  "PDF", "CSV", "JSON", "XML", "YAML", "CLI", "GUI", "IDE", "ORM", "MVC",
  "MVP", "SaaS", "PaaS", "IaaS", "DX", "UX", "UI", "PR", "QA", "CI", "CD",
  "ML", "DL", "RL", "NLU", "OCR", "TTS", "STT", "ASR", "VLM", "RAG",
]);

/**
 * Rejoin underscore-split or space-split uppercase letter sequences.
 * Examples: "A_I" → "AI", "C_E_O" → "CEO"
 *
 * Space-split rejoining is restricted to known acronyms to avoid
 * false positives like "Plan A B" → "Plan AB".
 */
export function rejoinAcronyms(text: string, extraAcronyms?: Set<string>): string {
  // Pattern: single uppercase letters separated by underscores: A_I, C_E_O, G_P_T
  // Underscore-split is always safe (STT artifact)
  let result = text.replace(
    /\b([A-Z])(?:[_]([A-Z]))+\b/g,
    (match) => match.replace(/_/g, ""),
  );

  // Pattern: single uppercase letters separated by spaces: "A I", "C E O"
  // Only rejoin if the result is a known acronym (safety check)
  const allKnown = extraAcronyms
    ? new Set([...KNOWN_ACRONYMS, ...extraAcronyms])
    : KNOWN_ACRONYMS;

  result = result.replace(
    /\b([A-Z])\s(?:[A-Z]\s)*[A-Z]\b/g,
    (match) => {
      const joined = match.replace(/\s/g, "");
      return allKnown.has(joined) ? joined : match;
    },
  );

  return result;
}

// ---------------------------------------------------------------------------
// Punctuation cleanup
// ---------------------------------------------------------------------------

/**
 * Remove stray/isolated punctuation marks that float alone or at invalid positions.
 * - Lone period/comma/。/、 with whitespace on either or both sides
 * - Leading punctuation (. at start of caption)
 * - Trailing lone punctuation preceded by whitespace
 */
export function removeStrayPunctuation(text: string): string {
  // Remove lone punctuation surrounded by whitespace (or at boundaries) — both sides
  let result = text.replace(/(?:^|\s)[.。、,]+(?:\s|$)/g, " ");

  // Remove lone punctuation with whitespace on one side only:
  // "hello .world" → "hello world", "こんにちは 。さようなら" → "こんにちは さようなら"
  result = result.replace(/\s[.。、,]+(?=\S)/g, " ");
  result = result.replace(/(?<=\S)[.。、,]+\s/g, " ");

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
