/**
 * Genre-agnostic human correction taxonomy for downstream editorial learning.
 * The original note remains embedded in every normalized record; this module
 * only adds a stable reason and the provenance needed to trace it back.
 */

export const HUMAN_CORRECTION_REASONS = [
  "observation_gap",
  "unsupported_inference",
  "identity_confusion",
  "intent_mismatch",
  "chronology_context_confusion",
  "stalled_progression",
  "missing_whole_cut_evaluation",
] as const;

export type HumanCorrectionReason = (typeof HUMAN_CORRECTION_REASONS)[number];

/**
 * Bounded correction domains. Domain is an explicit note field and is never
 * inferred from the correction reason or free-form feedback.
 */
export const HUMAN_CORRECTION_DOMAINS = [
  "shot",
  "b_roll",
  "caption",
  "other",
  "unknown",
] as const;

export type HumanCorrectionDomain = (typeof HUMAN_CORRECTION_DOMAINS)[number];

export interface HumanCorrectionNote {
  id: string;
  timestamp: string;
  reviewer: string;
  observation: string;
  severity: "observation" | "suggestion" | "concern";
  correction_reason?: HumanCorrectionReason;
  domain?: HumanCorrectionDomain;
  directive_type?: "observation" | "replace_segment" | "insert_segment"
    | "remove_segment" | "move_segment" | "trim_segment";
  clip_ids?: string[];
  clip_refs?: string[];
  evidence_refs?: string[];
  approved_segment_ids?: string[];
  timeline_in_frame?: number;
  timeline_us?: number;
  timeline_tc?: string;
}

export interface HumanCorrectionProvenance {
  source_artifact_path: string;
  source_artifact_sha256: string;
  source_ref: string;
  clip_ids: string[];
  clip_refs: string[];
  evidence_refs: string[];
  timeline_in_frame?: number;
  timeline_us?: number;
  timeline_tc?: string;
}

export interface NormalizedHumanCorrection {
  note_id: string;
  reason: HumanCorrectionReason;
  original_feedback: string;
  source_note: HumanCorrectionNote;
  evidence_provenance: HumanCorrectionProvenance;
}

export interface HumanCorrectionSourceOptions {
  sourcePath: string;
  sourceSha256: string;
}

const GENERIC_REASON_PATTERNS: ReadonlyArray<readonly [HumanCorrectionReason, readonly string[]]> = [
  ["missing_whole_cut_evaluation", [
    "whole cut", "full cut", "start to finish", "entire cut", "only the first", "preview", "globally",
  ]],
  ["chronology_context_confusion", [
    "before", "after", "order", "chronology", "timeline", "context", "when did", "time shift",
  ]],
  ["identity_confusion", [
    "identity", "who carries", "who is", "protagonist", "subject is unclear", "unidentifiable",
  ]],
  ["unsupported_inference", [
    "guess", "guesses", "assume", "assumption", "inference", "inferred", "unsupported", "does not prove", "doesn't prove",
  ]],
  ["stalled_progression", [
    "stalled", "no progress", "does not advance", "doesn't advance", "repetition", "repeats", "static", "flat progression",
  ]],
  ["intent_mismatch", [
    "brief", "intent", "purpose", "message", "tone", "should feel", "does not fit", "doesn't fit",
  ]],
  ["observation_gap", [
    "not shown", "missing", "cannot see", "can't see", "not visible", "unobserved", "not enough evidence", "coverage",
  ]],
];

function inferReason(feedback: string): HumanCorrectionReason {
  const normalized = feedback.normalize("NFKC").toLocaleLowerCase();
  for (const [reason, patterns] of GENERIC_REASON_PATTERNS) {
    if (patterns.some((pattern) => normalized.includes(pattern))) return reason;
  }
  // A note without a more specific signal is conservatively treated as an
  // observation gap, never as proof of an inferred semantic failure.
  return "observation_gap";
}

function copyNote(note: HumanCorrectionNote): HumanCorrectionNote {
  return {
    ...note,
    ...(note.clip_ids ? { clip_ids: [...note.clip_ids] } : {}),
    ...(note.clip_refs ? { clip_refs: [...note.clip_refs] } : {}),
    ...(note.evidence_refs ? { evidence_refs: [...note.evidence_refs] } : {}),
    ...(note.approved_segment_ids ? { approved_segment_ids: [...note.approved_segment_ids] } : {}),
  };
}

export function normalizeHumanCorrection(
  note: HumanCorrectionNote,
  source: HumanCorrectionSourceOptions,
): NormalizedHumanCorrection {
  const sourceNote = copyNote(note);
  return {
    note_id: note.id,
    reason: note.correction_reason ?? inferReason(note.observation),
    original_feedback: note.observation,
    source_note: sourceNote,
    evidence_provenance: {
      source_artifact_path: source.sourcePath,
      source_artifact_sha256: source.sourceSha256,
      source_ref: `${source.sourcePath}#notes[${encodeURIComponent(note.id)}]`,
      clip_ids: [...(note.clip_ids ?? [])],
      clip_refs: [...(note.clip_refs ?? [])],
      evidence_refs: [...(note.evidence_refs ?? [])],
      ...(note.timeline_in_frame !== undefined ? { timeline_in_frame: note.timeline_in_frame } : {}),
      ...(note.timeline_us !== undefined ? { timeline_us: note.timeline_us } : {}),
      ...(note.timeline_tc !== undefined ? { timeline_tc: note.timeline_tc } : {}),
    },
  };
}

export function normalizeHumanCorrections(
  notes: { notes: HumanCorrectionNote[] },
  source: HumanCorrectionSourceOptions,
): NormalizedHumanCorrection[] {
  return notes.notes.map((note) => normalizeHumanCorrection(note, source));
}
