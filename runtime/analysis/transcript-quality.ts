// Deterministic transcript-quality classifier.
//
// STT on non-dialogue / b-roll footage produces unreliable text: Whisper's
// "ご視聴ありがとうございました" hallucination on near-silent clips, mojibake
// (replacement chars, stray Cyrillic/Hebrew/Latin-extended), and single-mora
// babble ("ん ん ん"). The creative-regeneration eval showed the triager trusts
// this noise and so DROPS visually-strong moments whose only transcript is
// garbage (it missed two hero moments — the training-wheels debut and the
// intended ending — both labelled only with the boilerplate hallucination).
//
// This classifier lets the selection stage suppress unreliable transcripts and
// fall back to visual evidence (summary, peak_analysis) instead of being misled.
// Pure and deterministic — no model calls.

export type TranscriptQuality = "ok" | "low" | "empty";

export interface TranscriptQualityResult {
  quality: TranscriptQuality;
  reasons: string[];
  /** Text safe to rely on (empty when the transcript is unreliable). */
  usableText: string;
}

// Known Whisper hallucinations emitted over silence / music / b-roll.
const HALLUCINATION_PHRASES = [
  "ご視聴ありがとうございました",
  "ご視聴ありがとうございます",
  "チャンネル登録",
  "高評価",
  "おやすみなさい",
];

// Characters outside ASCII + Japanese (kana/CJK) + common punctuation are
// strong mojibake markers in this corpus (Cyrillic, Hebrew, Latin-extended…).
const EXOTIC = /[Ѐ-ӿԀ-ԯ԰-֏֐-׿À-ɏḀ-ỿ]/g;

function stripBoilerplate(text: string): string {
  let out = text;
  for (const phrase of HALLUCINATION_PHRASES) out = out.split(phrase).join(" ");
  return out.replace(/[。、.,!?！？\s]+/g, " ").trim();
}

function dominantTokenRepetition(tokens: string[]): number {
  if (tokens.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const t of tokens) counts.set(t, (counts.get(t) ?? 0) + 1);
  return Math.max(...counts.values()) / tokens.length;
}

/**
 * Classify the reliability of a transcript excerpt. "low"/"empty" means the
 * selection stage should ignore the text and judge the segment on its visuals.
 */
export function classifyTranscriptQuality(raw: string | undefined): TranscriptQualityResult {
  const text = (raw ?? "").trim();
  if (!text) return { quality: "empty", reasons: ["blank"], usableText: "" };

  const reasons: string[] = [];

  // Mojibake markers.
  if (text.includes("�")) reasons.push("replacement_char");
  // A single Cyrillic/Hebrew/Latin-extended char in this Japanese corpus is
  // already a reliable mojibake marker.
  if ((text.match(EXOTIC) ?? []).length >= 1) reasons.push("exotic_script");

  // Boilerplate hallucination — what remains after stripping it.
  const meaningful = stripBoilerplate(text);
  if (text !== stripBoilerplate(text) && meaningful.length === 0) {
    return { quality: "empty", reasons: [...reasons, "boilerplate_only"], usableText: "" };
  }
  if (meaningful.length < text.replace(/[。、.,!?！？\s]+/g, "").length) {
    reasons.push("contains_boilerplate");
  }

  // Single-token babble ("ん ん ん", "ディアン ディアン …").
  const tokens = meaningful.split(/\s+/).filter(Boolean);
  if (tokens.length >= 4 && dominantTokenRepetition(tokens) >= 0.6) {
    reasons.push("repetitive_babble");
  }

  const isGarbage = reasons.includes("replacement_char") || reasons.includes("exotic_script");
  if (isGarbage) return { quality: "low", reasons, usableText: "" };
  if (reasons.includes("repetitive_babble")) return { quality: "low", reasons, usableText: "" };
  // Boilerplate-tainted but with some real text left: usable if substantial.
  if (reasons.includes("contains_boilerplate") && meaningful.length < 8) {
    return { quality: "low", reasons, usableText: "" };
  }
  return { quality: "ok", reasons, usableText: meaningful };
}
