/**
 * LLM Caption Editorial
 *
 * Transforms caption_source.json into caption_draft.json via LLM-assisted editing.
 * The LLM function is injectable for testability (mock in tests).
 *
 * Operations:
 * - orthography: fix STT transcription errors (proper nouns, technical terms)
 * - punctuation: clean up invalid/excess punctuation
 * - linebreak: optimize line breaks for readability
 * - filler_removal: LLM-judged filler removal beyond deterministic patterns
 *
 * Fail-open: LLM failure → degraded status, raw text preserved.
 * Text authority: editorial does NOT change timing.
 */

import type { SpeechCaption, CaptionSource } from "./segmenter.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type EditorialOperation =
  | "orthography"
  | "punctuation"
  | "linebreak"
  | "filler_removal"
  | "proper_noun_normalization";

export interface EditorialEdit {
  captionId: string;
  editedText: string;
  operations: EditorialOperation[];
  glossaryHits: string[];
  confidence: number;
}

export interface EditorialDecision {
  decision: "confirm" | "override";
  edits: EditorialEdit[];
  styleNotes?: string;
  confidence: number;
}

export interface EditorialMetadata {
  sourceText: string;
  operations: EditorialOperation[];
  glossaryHits: string[];
  confidence: number;
  status: "clean" | "edited" | "degraded";
}

export interface CaptionDraftEntry {
  caption_id: string;
  asset_id: string;
  segment_id: string;
  timeline_in_frame: number;
  timeline_duration_frames: number;
  text: string;
  transcript_ref: string;
  transcript_item_ids: string[];
  source: "transcript" | "authored";
  styling_class: string;
  metrics: { cps: number; dwell_ms: number };
  editorial?: EditorialMetadata;
}

export interface CaptionDraft {
  version: string;
  project_id: string;
  base_timeline_version: string;
  caption_policy: CaptionSource["caption_policy"];
  speech_captions: CaptionDraftEntry[];
  text_overlays: CaptionSource["text_overlays"];
  draft_status: "ready_for_human_approval" | "needs_operator_fix";
  degraded_count: number;
}

export interface EditorialReport {
  version: string;
  project_id: string;
  total_captions: number;
  edited_count: number;
  degraded_count: number;
  glossary_hits: string[];
  retry_count: number;
  reject_reasons: string[];
}

// ---------------------------------------------------------------------------
// Injectable LLM function
// ---------------------------------------------------------------------------

/**
 * The editorial judge function — injectable for testing.
 * In production, calls an LLM. In tests, returns a mock decision.
 */
export interface EditorialJudge {
  judge(
    captions: SpeechCaption[],
    glossary: string[],
    language: string,
  ): Promise<EditorialDecision>;
}

// ---------------------------------------------------------------------------
// Glossary construction
// ---------------------------------------------------------------------------

export interface GlossarySource {
  mustInclude?: string[];
  projectNames?: string[];
  brandTerms?: string[];
  operatorCorrections?: Array<{ from: string; to: string }>;
}

export function buildGlossary(sources: GlossarySource): string[] {
  const terms = new Set<string>();

  for (const term of sources.mustInclude ?? []) terms.add(term);
  for (const term of sources.projectNames ?? []) terms.add(term);
  for (const term of sources.brandTerms ?? []) terms.add(term);
  for (const correction of sources.operatorCorrections ?? []) {
    terms.add(correction.to);
  }

  return [...terms];
}

// ---------------------------------------------------------------------------
// Must-keep token guard
// ---------------------------------------------------------------------------

/** Tokens that must survive editorial: numbers, dates, URLs, negations */
const MUST_KEEP_PATTERNS = [
  /\d+/g,                           // numbers
  /\d{4}[-/]\d{1,2}[-/]\d{1,2}/g,  // dates
  /https?:\/\/\S+/g,                // URLs
  /(?:ない|ません|ず|not|no|never|don't|doesn't|isn't|aren't|won't|can't)\b/gi, // negations
];

/**
 * Validate that must-keep tokens from source text survive in edited text.
 * Returns list of missing tokens.
 */
export function validateMustKeepTokens(
  sourceText: string,
  editedText: string,
  glossary: string[],
): string[] {
  const missing: string[] = [];

  // Check glossary terms
  for (const term of glossary) {
    if (sourceText.includes(term) && !editedText.includes(term)) {
      missing.push(term);
    }
  }

  // Check pattern-based must-keep tokens
  for (const pattern of MUST_KEEP_PATTERNS) {
    const sourceMatches = sourceText.match(pattern) ?? [];
    for (const match of sourceMatches) {
      if (!editedText.includes(match)) {
        missing.push(match);
      }
    }
  }

  return missing;
}

// ---------------------------------------------------------------------------
// Editorial pipeline
// ---------------------------------------------------------------------------

export interface EditorialOptions {
  /** The editorial judge (LLM or mock) */
  judge: EditorialJudge;
  /** Glossary terms to protect */
  glossary?: string[];
  /** Maximum retry attempts on validation failure */
  maxRetries?: number;
}

/**
 * Run LLM editorial on caption source to produce caption draft.
 * Fail-open: LLM errors result in degraded status, not failure.
 */
export async function runEditorial(
  captionSource: CaptionSource,
  options: EditorialOptions,
): Promise<{ draft: CaptionDraft; report: EditorialReport }> {
  const glossary = options.glossary ?? [];
  const maxRetries = options.maxRetries ?? 1;
  const language = captionSource.caption_policy.language;

  const draftEntries: CaptionDraftEntry[] = [];
  let editedCount = 0;
  let degradedCount = 0;
  const allGlossaryHits: string[] = [];
  const rejectReasons: string[] = [];
  let retryCount = 0;

  // Try LLM editorial
  let decision: EditorialDecision | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      decision = await options.judge.judge(
        captionSource.speech_captions,
        glossary,
        language,
      );

      // Validate must-keep tokens for all edits
      let valid = true;
      for (const edit of decision.edits) {
        const source = captionSource.speech_captions.find(
          (c) => c.caption_id === edit.captionId,
        );
        if (!source) continue;

        const missingTokens = validateMustKeepTokens(
          source.text, edit.editedText, glossary,
        );
        if (missingTokens.length > 0) {
          rejectReasons.push(
            `Caption ${edit.captionId}: missing must-keep tokens: ${missingTokens.join(", ")}`,
          );
          valid = false;
        }
      }

      if (valid) break;
      retryCount++;
      decision = null; // Retry
    } catch (err) {
      rejectReasons.push(
        `LLM editorial attempt ${attempt + 1} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      retryCount++;
      decision = null;
    }
  }

  // Build edit lookup
  const editMap = new Map<string, EditorialEdit>();
  if (decision) {
    for (const edit of decision.edits) {
      editMap.set(edit.captionId, edit);
    }
  }

  // Build draft entries
  for (const caption of captionSource.speech_captions) {
    const edit = editMap.get(caption.caption_id);

    if (edit) {
      // LLM provided an edit
      editedCount++;
      allGlossaryHits.push(...edit.glossaryHits);

      draftEntries.push({
        ...caption,
        text: edit.editedText,
        editorial: {
          sourceText: caption.text,
          operations: edit.operations,
          glossaryHits: edit.glossaryHits,
          confidence: edit.confidence,
          status: "edited",
        },
      });
    } else if (!decision) {
      // LLM failed entirely — degraded
      degradedCount++;
      draftEntries.push({
        ...caption,
        editorial: {
          sourceText: caption.text,
          operations: [],
          glossaryHits: [],
          confidence: 0,
          status: "degraded",
        },
      });
    } else {
      // LLM confirmed text as-is
      draftEntries.push({
        ...caption,
        editorial: {
          sourceText: caption.text,
          operations: [],
          glossaryHits: [],
          confidence: decision.confidence,
          status: "clean",
        },
      });
    }
  }

  const draftStatus = degradedCount > 0
    ? "needs_operator_fix" as const
    : "ready_for_human_approval" as const;

  const draft: CaptionDraft = {
    version: captionSource.version,
    project_id: captionSource.project_id,
    base_timeline_version: captionSource.base_timeline_version,
    caption_policy: captionSource.caption_policy,
    speech_captions: draftEntries,
    text_overlays: captionSource.text_overlays,
    draft_status: draftStatus,
    degraded_count: degradedCount,
  };

  const report: EditorialReport = {
    version: "1",
    project_id: captionSource.project_id,
    total_captions: captionSource.speech_captions.length,
    edited_count: editedCount,
    degraded_count: degradedCount,
    glossary_hits: [...new Set(allGlossaryHits)],
    retry_count: retryCount,
    reject_reasons: rejectReasons,
  };

  return { draft, report };
}
