// Assembly loss evaluator — Issue #11 Phase 2 milestone M2A.
//
// Pure deterministic diagnostic core. NOT a new source of truth and NOT a
// ranking/fitness/composite score: it observes what the assembled timeline
// retains or loses relative to the caller-supplied artifacts and optional
// evidence, and reports observations. All inputs are plain TypeScript values
// passed in by the caller; this module never reads the filesystem, never
// mutates its inputs, and never calls models.
//
// Same input => same output (canonical-JSON hashing; no wall clock, no RNG).
// A small local validator runs BEFORE hashing/measurement so NaN/Infinity or
// negative durations can never collide hashes or poison arithmetic, and the
// human-reference bag order is canonicalized before hashing.
//
// Measurement semantics (Sol review f5abeb98):
//  - Utterance retention is judged against the UNION of placed source ranges
//    per asset (never a single best-overlap clip). Interior loss from
//    same-source reuse surfaces as an explicit interior-gap total.
//  - The speech timeline is built from the clamped intersections of ALL
//    utterances x ALL placements (importance gates retention only).
//  - Kickoff is identified ONLY from creator_short_vo_broll provenance or an
//    explicit kickoff-named beat — never substituted with hook/first beat;
//    clips straddling the boundary contribute only their pre-kickoff part.
//  - Setup/payoff assembled presence requires matching timeline clips.
//  - Program end is the maximum clip end; ambient/action audio aggregates as
//    a timeline interval union (overlaps never double-counted).
//  - Causal edges are auxiliary evidence, accepted only setup -> payoff; edge
//    absence is never judged as causal absence and never affects the verdict.
//
// Grounding rule (Phase 0/1 HOLD discipline): when selects coverage or the
// supplied analysis coverage is failed/blocked, the verdict is HOLD.
// Ambient/silence measurements are observation-only by contract.

import { canonicalSha256 } from "./editorial-eye-suite.js";
import type {
  Beat,
  ClipOutput,
  CreativeBrief,
  EditBlueprint,
  SelectsCandidates,
  TimelineIR,
} from "../artifacts/types.js";

export const ASSEMBLY_LOSS_EVALUATOR_VERSION = "assembly-loss/v1" as const;

/**
 * Small, explicit ASR tolerance for utterance boundary comparisons.
 *
 * Rationale: provider word timings (OpenAI diarized STT today) jitter on the
 * order of ~100–200ms against the true audio boundaries, so sub-tolerance
 * head/tail differences between a transcript utterance and a clip's source
 * range are treated as measurement noise, not truncation. Deliberately small;
 * it must never absorb a real phrase-level cut.
 */
export const DEFAULT_ASR_TOLERANCE_US = 250_000;
export const ASR_TOLERANCE_RATIONALE =
  "provider word timings jitter ~100-200ms vs true audio boundaries; sub-tolerance boundary differences are measurement noise, not truncation";

const US_PER_SEC = 1_000_000;

/** Canonical story-role rank used only for order observation, never scoring. */
const STORY_ROLE_RANK: Record<string, number> = {
  hook: 0,
  setup: 1,
  experience: 2,
  closing: 3,
};

// ── Input contract ──────────────────────────────────────────────────

export interface AssemblyLossUtterance {
  speaker?: string;
  start_us: number;
  end_us: number;
  text: string;
}

/** Minimal transcript shape; compatible with transcripts/TR_*.json items. */
export interface AssemblyLossTranscript {
  transcript_id?: string;
  asset_id?: string;
  utterances: AssemblyLossUtterance[];
}

/** Optional causal evidence. Auxiliary ONLY: edge absence never implies causal absence. */
export interface CausalEdgeRef {
  from_beat_id: string;
  to_beat_id: string;
  kind?: string;
}

export interface HumanStructuralClip {
  segment_id: string;
  duration_us?: number;
}

/**
 * Optional human structural reference (e.g. human golden order). Compared at
 * unmatched-occurrence granularity as a multiset (bag) of segment_ids —
 * order changes are not counted as change. Bag order is canonicalized before
 * hashing.
 */
export interface HumanStructuralReference {
  label?: string;
  clips: HumanStructuralClip[];
}

export type WallClockBreakdown = Record<string, number>;

export interface AnalysisCoverageInput {
  status?: string;
  [key: string]: unknown;
}

export interface AssemblyLossInput {
  brief: CreativeBrief;
  selects: SelectsCandidates;
  blueprint: EditBlueprint;
  timeline: TimelineIR;
  /** Per-asset transcripts; absent/empty fail open to "unknown". */
  transcripts?: AssemblyLossTranscript[];
  causal_refs?: CausalEdgeRef[];
  human_structural_reference?: HumanStructuralReference | null;
  wall_clock_breakdown?: WallClockBreakdown | null;
  analysis_coverage?: AnalysisCoverageInput | null;
  /** Overrides DEFAULT_ASR_TOLERANCE_US; part of policy hash when set. */
  asr_tolerance_us?: number;
}

// ── Output contract ─────────────────────────────────────────────────

export interface ImportantUtteranceRetention {
  available: boolean;
  reason?: string;
  important_count?: number;
  full?: number;
  head_cut?: number;
  tail_cut?: number;
  both_cut?: number;
  missing?: number;
  retention_ratio?: number;
  /** Source microseconds lost to interior cuts (same-source reuse), not head/tail. */
  total_interior_gap_us?: number;
}

export interface HeadTailTruncation {
  available: boolean;
  reason?: string;
  truncated_head_count?: number;
  truncated_tail_count?: number;
  total_head_loss_us?: number;
  total_tail_loss_us?: number;
}

export interface KickoffBroll {
  available: boolean;
  reason?: string;
  detection_source?: "creator_short_vo_broll_provenance" | "explicit_kickoff_beat";
  kickoff_beat_id?: string | null;
  kickoff_clip_id?: string | null;
  broll_clip_count?: number;
  broll_total_sec?: number;
}

export interface SetupPayoffObservation {
  setup_present: boolean;
  payoff_present: boolean;
  order: "ok" | "reversed" | "not_observed";
  causal_edge_evidence: "present" | "absent" | "unavailable";
  note: string;
}

export interface SilentEnvironmentalAudio {
  available: boolean;
  reason?: string;
  no_speech_duration_sec?: number;
  longest_no_speech_interval_sec?: number;
  /** Union of ambient/nat-sound timeline intervals — overlaps never double-counted. */
  ambient_audio_track_duration_sec?: number;
  /** Tracks that contributed at least one ambient/nat-sound interval. */
  ambient_sources?: Array<{ track_id: string; role: string }>;
  observation_only: true;
}

export interface StoryRoleOrderObservation {
  observed_order: string[];
  /** Count of adjacent pairs whose canonical story-role rank decreases. */
  adjacent_rank_drops: number | null;
}

export interface HumanStructuralChange {
  available: boolean;
  reason?: string;
  reference_label?: string | null;
  changed_clip_count?: number;
  /** Null (unknown) when an unmatched reference occurrence lacks a duration. */
  changed_seconds?: number | null;
  method_note: string;
}

export interface AssemblyLossReport {
  evaluator_version: typeof ASSEMBLY_LOSS_EVALUATOR_VERSION;
  input_hash: string;
  policy_hash: string;
  policy: {
    asr_tolerance_us: number;
    asr_tolerance_rationale: string;
  };
  grounding: {
    coverage: "ready" | "failed";
    selects_coverage_status: string | null;
    analysis_coverage_status: string | null;
    notes: string[];
  };
  verdict: "READY" | "HOLD";
  measurements: {
    important_utterance_retention: ImportantUtteranceRetention;
    head_tail_truncation: HeadTailTruncation;
    kickoff_broll_before_kickoff: KickoffBroll;
    setup_payoff: SetupPayoffObservation;
    silent_environmental_audio: SilentEnvironmentalAudio;
    story_role_order: StoryRoleOrderObservation;
    human_structural_change: HumanStructuralChange;
    wall_clock_breakdown: WallClockBreakdown | null;
  };
}

// ── Local validation (runs BEFORE any hashing or measurement) ───────

interface Span {
  start_us: number;
  end_us: number;
}

function requireFinite(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`assembly-loss: ${label} must be a finite number (got ${String(value)})`);
  }
  return value;
}

function requireNonNegative(value: unknown, label: string): number {
  const finite = requireFinite(value, label);
  if (finite < 0) throw new Error(`assembly-loss: ${label} must be non-negative (got ${String(value)})`);
  return finite;
}

function validateInput(input: AssemblyLossInput): void {
  const sequence = input.timeline?.sequence;
  if (!sequence) throw new Error("assembly-loss: timeline.sequence is required");
  const fpsNum = requireFinite(sequence.fps_num, "sequence.fps_num");
  const fpsDen = requireFinite(sequence.fps_den, "sequence.fps_den");
  // Both components must be strictly positive so the ratio is a finite,
  // positive frame rate (rejects fps_den = 0 and negative components).
  if (fpsNum <= 0) throw new Error("assembly-loss: sequence.fps_num must be > 0");
  if (fpsDen <= 0) throw new Error("assembly-loss: sequence.fps_den must be > 0");
  if (!Number.isFinite(fpsNum / fpsDen)) throw new Error("assembly-loss: sequence fps ratio must be finite");

  const wallClock = input.wall_clock_breakdown;
  if (wallClock) {
    for (const [key, value] of Object.entries(wallClock)) {
      const finite = requireFinite(value, `wall_clock_breakdown.${key}`);
      if (finite < 0) {
        throw new Error(`assembly-loss: wall_clock_breakdown.${key} must be non-negative`);
      }
    }
  }

  const tolerance = input.asr_tolerance_us ?? DEFAULT_ASR_TOLERANCE_US;
  if (!Number.isFinite(tolerance) || tolerance < 0) {
    throw new Error("assembly-loss: asr_tolerance_us must be a finite non-negative number");
  }

  const allTracks = [
    ...(input.timeline.tracks?.video ?? []),
    ...(input.timeline.tracks?.audio ?? []),
    ...(input.timeline.tracks?.overlay ?? []),
    ...(input.timeline.tracks?.caption ?? []),
  ];
  for (const track of allTracks) {
    for (const clip of track.clips ?? []) {
      // Source and timeline coordinates are non-negative time coordinates.
      const inUs = requireNonNegative(clip.src_in_us, `clip ${clip.clip_id}.src_in_us`);
      const outUs = requireNonNegative(clip.src_out_us, `clip ${clip.clip_id}.src_out_us`);
      if (outUs - inUs < 0) throw new Error(`assembly-loss: clip ${clip.clip_id} has negative source duration`);
      requireNonNegative(clip.timeline_in_frame, `clip ${clip.clip_id}.timeline_in_frame`);
      const durFrames = requireFinite(
        clip.timeline_duration_frames,
        `clip ${clip.clip_id}.timeline_duration_frames`,
      );
      if (durFrames < 0) throw new Error(`assembly-loss: clip ${clip.clip_id} has negative timeline duration`);
    }
  }

  for (const candidate of input.selects?.candidates ?? []) {
    const inUs = requireNonNegative(candidate.src_in_us, `candidate ${candidate.segment_id}.src_in_us`);
    const outUs = requireNonNegative(candidate.src_out_us, `candidate ${candidate.segment_id}.src_out_us`);
    if (outUs - inUs < 0) {
      throw new Error(`assembly-loss: candidate ${candidate.segment_id} has negative source duration`);
    }
  }

  for (const transcript of input.transcripts ?? []) {
    for (const utterance of transcript.utterances ?? []) {
      const start = requireNonNegative(utterance.start_us, "utterance.start_us");
      const end = requireNonNegative(utterance.end_us, "utterance.end_us");
      if (end - start < 0) throw new Error("assembly-loss: utterance has negative duration");
    }
  }

  const humanRef = input.human_structural_reference;
  if (humanRef) {
    for (const clip of humanRef.clips ?? []) {
      if (typeof clip.segment_id !== "string") {
        throw new Error("assembly-loss: human structural reference clips need string segment_id");
      }
      if (clip.duration_us !== undefined) {
        requireFinite(clip.duration_us, "human structural reference duration_us");
        if (clip.duration_us < 0) {
          throw new Error("assembly-loss: human structural reference duration_us must be non-negative");
        }
      }
    }
  }
}

/** Canonicalize the human-reference bag (order-independent) before hashing. */
function canonicalHumanRef(ref: HumanStructuralReference | null | undefined): HumanStructuralReference | null {
  if (!ref || !Array.isArray(ref.clips)) return null;
  return {
    ...(ref.label !== undefined ? { label: ref.label } : {}),
    clips: ref.clips
      .map((clip) => ({
        segment_id: clip.segment_id,
        ...(clip.duration_us !== undefined ? { duration_us: clip.duration_us } : {}),
      }))
      .sort((a, b) =>
        a.segment_id === b.segment_id
          ? (a.duration_us ?? Number.MAX_SAFE_INTEGER) - (b.duration_us ?? Number.MAX_SAFE_INTEGER)
          : a.segment_id.localeCompare(b.segment_id),
      ),
  };
}

// ── Interval helpers ────────────────────────────────────────────────

function overlap(a: Span, b: Span): number {
  return Math.min(a.end_us, b.end_us) - Math.max(a.start_us, b.start_us);
}

function normalizeText(value: string): string {
  return value.normalize("NFKC").toLowerCase();
}

function mergeSpans(spans: Span[]): Span[] {
  if (spans.length === 0) return [];
  const sorted = spans.slice().sort((a, b) => a.start_us - b.start_us || a.end_us - b.end_us);
  const merged: Span[] = [{ ...sorted[0] }];
  for (let i = 1; i < sorted.length; i += 1) {
    const last = merged[merged.length - 1];
    const next = sorted[i];
    if (next.start_us <= last.end_us) {
      last.end_us = Math.max(last.end_us, next.end_us);
    } else {
      merged.push({ ...next });
    }
  }
  return merged;
}

/** First index into disjoint sorted pieces whose end exceeds `bound`, or -1. */
function firstPieceAfter(pieces: Span[], boundUs: number): number {
  let lo = 0;
  let hi = pieces.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (pieces[mid].end_us > boundUs) {
      found = mid;
      hi = mid - 1;
    } else {
      lo = mid + 1;
    }
  }
  return found;
}

function videoClipsInTimelineOrder(timeline: TimelineIR): ClipOutput[] {
  const clips: ClipOutput[] = [];
  for (const track of timeline.tracks.video ?? []) {
    clips.push(...(track.clips ?? []));
  }
  return clips.sort((a, b) => a.timeline_in_frame - b.timeline_in_frame);
}

function beatMatchesWord(beat: Beat, word: string): boolean {
  const haystack = normalizeText(`${beat.id ?? ""} ${beat.label ?? ""} ${beat.purpose ?? ""}`);
  return haystack.includes(word);
}

function isSetupBeat(beat: Beat): boolean {
  return beat.story_role === "setup" || beatMatchesWord(beat, "setup") || beatMatchesWord(beat, "導入");
}

function isPayoffBeat(beat: Beat): boolean {
  // "closing" is the enum's structural analogue of a payoff; explicit payoff
  // wording in id/label/purpose also qualifies.
  return beat.story_role === "closing" || beatMatchesWord(beat, "payoff") || beatMatchesWord(beat, "着地");
}

function isBrollRole(role: string): boolean {
  return role === "support" || role === "texture";
}

function isAmbientFlagged(clip: ClipOutput): boolean {
  return (
    clip.audio_role === "ambient" ||
    clip.audio_role === "nat_sound" ||
    clip.role === "ambient" ||
    clip.role === "nat_sound"
  );
}

// ── Evaluator ───────────────────────────────────────────────────────

export function evaluateAssemblyLoss(input: AssemblyLossInput): AssemblyLossReport {
  validateInput(input);

  const toleranceUs =
    typeof input.asr_tolerance_us === "number" && input.asr_tolerance_us >= 0
      ? input.asr_tolerance_us
      : DEFAULT_ASR_TOLERANCE_US;

  // Policy hash covers every constant that can change a measurement.
  const policyHash = canonicalSha256({
    evaluator_version: ASSEMBLY_LOSS_EVALUATOR_VERSION,
    asr_tolerance_us: toleranceUs,
  });

  // Input hash excludes the tolerance override (policy, not input) and uses
  // the canonically ordered human-reference bag so bag permutations cannot
  // change the hash.
  const { asr_tolerance_us: _tolerance, ...coreInputs } = input;
  void _tolerance;
  const inputHash = canonicalSha256({
    ...coreInputs,
    human_structural_reference: canonicalHumanRef(coreInputs.human_structural_reference),
  });

  const frameRate = input.timeline.sequence.fps_num / input.timeline.sequence.fps_den;
  const clips = videoClipsInTimelineOrder(input.timeline);
  const programClips = [
    ...(input.timeline.tracks.video ?? []).flatMap((track) => track.clips ?? []),
    ...(input.timeline.tracks.audio ?? []).flatMap((track) => track.clips ?? []),
  ];

  // ── Timeline spine: program start/end are extremes over ALL clips ──
  let spineStartFrame = Number.POSITIVE_INFINITY;
  let spineEndFrame = Number.NEGATIVE_INFINITY;
  for (const clip of programClips) {
    spineStartFrame = Math.min(spineStartFrame, clip.timeline_in_frame);
    spineEndFrame = Math.max(spineEndFrame, clip.timeline_in_frame + clip.timeline_duration_frames);
  }
  const spineStartUs =
    programClips.length > 0 ? Math.round((spineStartFrame / frameRate) * US_PER_SEC) : 0;
  const spineEndUs =
    programClips.length > 0 ? Math.round((spineEndFrame / frameRate) * US_PER_SEC) : 0;

  const toTimelineSec = (clip: ClipOutput, srcUs: number): number => {
    const srcDur = clip.src_out_us - clip.src_in_us;
    const tlDurSec = clip.timeline_duration_frames / frameRate;
    if (srcDur <= 0) return clip.timeline_in_frame / frameRate;
    const scale = tlDurSec / (srcDur / US_PER_SEC);
    return clip.timeline_in_frame / frameRate + ((srcUs - clip.src_in_us) / US_PER_SEC) * scale;
  };

  // ── Per-asset indices (built once; sort-centered) ──
  const candidateUnionsByAsset = new Map<string, Span[]>();
  for (const candidate of input.selects.candidates) {
    if (candidate.role === "reject") continue;
    const list = candidateUnionsByAsset.get(candidate.asset_id) ?? [];
    list.push({ start_us: candidate.src_in_us, end_us: candidate.src_out_us });
    candidateUnionsByAsset.set(candidate.asset_id, list);
  }
  for (const [assetId, spans] of candidateUnionsByAsset) {
    candidateUnionsByAsset.set(assetId, mergeSpans(spans));
  }

  const clipSpansByAsset = new Map<string, Array<{ clip: ClipOutput; span: Span }>>();
  for (const clip of clips) {
    const list = clipSpansByAsset.get(clip.asset_id) ?? [];
    list.push({ clip, span: { start_us: clip.src_in_us, end_us: clip.src_out_us } });
    clipSpansByAsset.set(clip.asset_id, list);
  }
  const clipUnionsByAsset = new Map<string, Span[]>();
  for (const [assetId, entries] of clipSpansByAsset) {
    entries.sort((a, b) => a.span.start_us - b.span.start_us);
    clipUnionsByAsset.set(assetId, mergeSpans(entries.map((entry) => entry.span)));
  }

  const utterancesByAsset = new Map<string, AssemblyLossUtterance[]>();
  for (const transcript of input.transcripts ?? []) {
    const assetId = transcript.asset_id ?? "";
    const list = utterancesByAsset.get(assetId) ?? [];
    for (const utterance of transcript.utterances ?? []) list.push(utterance);
    utterancesByAsset.set(assetId, list);
  }
  for (const [, utts] of utterancesByAsset) {
    utts.sort((a, b) => a.start_us - b.start_us);
  }
  const utteranceUnionsByAsset = new Map<string, Span[]>();
  for (const [assetId, utts] of utterancesByAsset) {
    utteranceUnionsByAsset.set(
      assetId,
      mergeSpans(utts.map((utterance) => ({ start_us: utterance.start_us, end_us: utterance.end_us }))),
    );
  }

  const prioritizeLines = (input.blueprint.dialogue_policy?.prioritize_lines ?? []).map(normalizeText);

  // ── Speech timeline: per-placement intersections with per-asset utterance unions.
  // Each placement binary-searches the first utterance union fragment that can
  // overlap it, then advances only through fragments before the placement end.
  // Let C be clip placements, U input utterances, E union fragments, and K the
  // actual per-placement speech fragments emitted. Exact measurement requires
  // retaining K, so this path is O((C + U + E) log n + K), memory
  // O(C + U + E + K); K cannot be avoided without changing the metric.
  const speechTimelineSpansUs: Span[] = [];
  for (const [assetId, entries] of clipSpansByAsset) {
    const utterancePieces = utteranceUnionsByAsset.get(assetId) ?? [];
    if (entries.length === 0 || utterancePieces.length === 0) continue;
    for (const entry of entries) {
      if (entry.span.end_us <= entry.span.start_us) continue;
      const firstIndex = firstPieceAfter(utterancePieces, entry.span.start_us);
      if (firstIndex < 0) continue;
      for (let index = firstIndex; index < utterancePieces.length; index += 1) {
        const utteranceSpan = utterancePieces[index];
        if (utteranceSpan.start_us >= entry.span.end_us) break;
        const ovStart = Math.max(utteranceSpan.start_us, entry.span.start_us);
        const ovEnd = Math.min(utteranceSpan.end_us, entry.span.end_us);
        if (ovEnd <= ovStart) continue;
        speechTimelineSpansUs.push({
          start_us: Math.round(toTimelineSec(entry.clip, ovStart) * US_PER_SEC),
          end_us: Math.round(toTimelineSec(entry.clip, ovEnd) * US_PER_SEC),
        });
      }
    }
  }

  // ── Measurements 1+2: important utterance retention (per-asset union) ──
  let full = 0;
  let headCut = 0;
  let tailCut = 0;
  let bothCut = 0;
  let missing = 0;
  let totalHeadLossUs = 0;
  let totalTailLossUs = 0;
  let totalInteriorGapUs = 0;

  let importantCount = 0;
  for (const transcript of input.transcripts ?? []) {
    const assetId = transcript.asset_id ?? "";
    const utts = [...(transcript.utterances ?? [])].sort((a, b) => a.start_us - b.start_us);
    const candPieces = candidateUnionsByAsset.get(assetId) ?? [];
    const clipPieces = clipUnionsByAsset.get(assetId) ?? [];

    for (const utterance of utts) {
      const normalizedText = normalizeText(utterance.text);
      const uSpan: Span = { start_us: utterance.start_us, end_us: utterance.end_us };

      let important = prioritizeLines.some(
        (line) => line.length > 0 && (normalizedText.includes(line) || line.includes(normalizedText)),
      );
      if (!important && candPieces.length > 0) {
        const idx = firstPieceAfter(candPieces, uSpan.start_us);
        important = idx >= 0 && candPieces[idx].start_us < uSpan.end_us;
      }
      if (!important) continue;
      importantCount += 1;

      // Retention judged against the union of placed source ranges.
      const idx = firstPieceAfter(clipPieces, uSpan.start_us);
      if (idx < 0 || clipPieces[idx].start_us >= uSpan.end_us) {
        missing += 1;
        continue;
      }
      let firstStart = Number.POSITIVE_INFINITY;
      let lastEnd = Number.NEGATIVE_INFINITY;
      let covered = 0;
      let prevEnd: number | null = null;
      for (let p = idx; p < clipPieces.length && clipPieces[p].start_us < uSpan.end_us; p += 1) {
        const piece = clipPieces[p];
        const ov = overlap(uSpan, piece);
        if (ov <= 0) continue;
        firstStart = Math.min(firstStart, piece.start_us);
        lastEnd = Math.max(lastEnd, piece.end_us);
        covered += ov;
        if (prevEnd !== null) {
          const gapStart = Math.max(prevEnd, uSpan.start_us);
          const gapEnd = Math.min(piece.start_us, uSpan.end_us);
          if (gapEnd > gapStart) totalInteriorGapUs += gapEnd - gapStart;
        }
        prevEnd = piece.end_us;
      }
      const headLoss = firstStart - uSpan.start_us; // positive: opening trimmed
      const tailLoss = uSpan.end_us - lastEnd; // positive: ending trimmed
      const headTruncated = headLoss > toleranceUs;
      const tailTruncated = tailLoss > toleranceUs;
      if (headTruncated) totalHeadLossUs += headLoss;
      if (tailTruncated) totalTailLossUs += tailLoss;
      if (headTruncated && tailTruncated) bothCut += 1;
      else if (headTruncated) headCut += 1;
      else if (tailTruncated) tailCut += 1;
      else full += 1;
    }
  }

  const hasTranscripts = importantCount > 0 || speechTimelineSpansUs.length > 0 ||
    [...utterancesByAsset.values()].some((utts) => utts.length > 0);

  const retention: ImportantUtteranceRetention = hasTranscripts
    ? {
        available: true,
        important_count: importantCount,
        full,
        head_cut: headCut,
        tail_cut: tailCut,
        both_cut: bothCut,
        missing,
        retention_ratio: importantCount > 0 ? full / importantCount : 0,
        total_interior_gap_us: totalInteriorGapUs,
      }
    : { available: false, reason: "no transcripts supplied" };

  const truncation: HeadTailTruncation = hasTranscripts
    ? {
        available: true,
        truncated_head_count: headCut + bothCut,
        truncated_tail_count: tailCut + bothCut,
        total_head_loss_us: totalHeadLossUs,
        total_tail_loss_us: totalTailLossUs,
      }
    : { available: false, reason: "no transcripts supplied" };

  // ── Measurement 3: action support/texture B-roll before the kickoff clip ──
  const beats = input.blueprint.beats ?? [];
  const beatById = new Map(beats.map((beat) => [beat.id, beat]));
  let kickoffBroll: KickoffBroll;
  const metadataProvenance = readVoBrollProvenance(input.timeline);
  if (metadataProvenance) {
    const kickoffClip = findKickoffClipFromProvenance(clips, metadataProvenance);
    kickoffBroll = kickoffClip
      ? measureBrollBefore(clips, kickoffClip, frameRate, "creator_short_vo_broll_provenance", null)
      : {
          available: false,
          reason: "creator_short_vo_broll provenance does not resolve to an assembled clip",
          detection_source: "creator_short_vo_broll_provenance",
          broll_clip_count: 0,
        };
  } else {
    const kickoffBeat = beats.find((beat) => beatMatchesWord(beat, "kickoff"));
    const kickoffClip = kickoffBeat
      ? clips.find((clip) => clip.beat_id === kickoffBeat.id) ?? null
      : null;
    if (kickoffBeat && kickoffClip) {
      kickoffBroll = measureBrollBefore(clips, kickoffClip, frameRate, "explicit_kickoff_beat", kickoffBeat.id);
    } else {
      kickoffBroll = {
        available: false,
        reason:
          kickoffBeat && !kickoffClip
            ? "explicit kickoff beat has no assembled clip"
            : "kickoff not identifiable: no creator_short_vo_broll provenance or explicit kickoff beat",
        kickoff_beat_id: kickoffBeat ? kickoffBeat.id : null,
        broll_clip_count: 0,
      };
    }
  }

  // ── Measurement 4: setup/payoff assembled presence & order ──
  const setupBeatIds = new Set(beats.filter(isSetupBeat).map((beat) => beat.id));
  const payoffBeatIds = new Set(beats.filter(isPayoffBeat).map((beat) => beat.id));
  const firstSetupClip = clips.findIndex((clip) => setupBeatIds.has(clip.beat_id));
  const firstPayoffClip = clips.findIndex((clip) => payoffBeatIds.has(clip.beat_id));
  const setupPresent = firstSetupClip >= 0;
  const payoffPresent = firstPayoffClip >= 0;
  let order: SetupPayoffObservation["order"] = "not_observed";
  if (setupPresent && payoffPresent) {
    order = firstSetupClip < firstPayoffClip ? "ok" : "reversed";
  }
  const causalRefs = input.causal_refs ?? [];
  const supportingEdge = causalRefs.some(
    (edge) => setupBeatIds.has(edge.from_beat_id) && payoffBeatIds.has(edge.to_beat_id),
  );
  const setupPayoff: SetupPayoffObservation = {
    setup_present: setupPresent,
    payoff_present: payoffPresent,
    order,
    causal_edge_evidence:
      causalRefs.length === 0 ? "unavailable" : supportingEdge ? "present" : "absent",
    note:
      "causal edges are auxiliary evidence only (setup -> payoff direction); an absent edge is NOT judged as absent causality and does not affect the verdict",
  };

  // ── Measurements 5+6: silent/environmental audio & longest interval ──
  let silentEnvironmental: SilentEnvironmentalAudio;
  if (clips.length === 0 || !hasTranscripts) {
    silentEnvironmental = {
      available: false,
      reason: clips.length === 0 ? "timeline has no video clips" : "no transcripts supplied",
      observation_only: true,
    };
  } else {
    const mergedSpeech = mergeSpans(speechTimelineSpansUs);
    let noSpeechUs = 0;
    let longestGapUs = 0;
    let cursor = spineStartUs;
    for (const span of mergedSpeech) {
      if (cursor >= spineEndUs) break;
      if (span.start_us > cursor) {
        const gap = Math.min(span.start_us, spineEndUs) - cursor;
        if (gap > 0) {
          noSpeechUs += gap;
          longestGapUs = Math.max(longestGapUs, gap);
        }
      }
      cursor = Math.max(cursor, span.end_us);
    }
    if (cursor < spineEndUs) {
      const gap = spineEndUs - cursor;
      noSpeechUs += gap;
      longestGapUs = Math.max(longestGapUs, gap);
    }

    // Ambient/action: union of timeline intervals across ALL tracks, so
    // overlapping duplicate placements are never double-counted. A clip
    // counts when it is itself flagged ambient/nat-sound OR when its track's
    // role declares ambient/nat-sound (clip-level audio_role is optional).
    const ambientSpans: Span[] = [];
    const ambientSources = new Map<string, { track_id: string; role: string }>();
    for (const track of [
      ...(input.timeline.tracks.audio ?? []),
      ...(input.timeline.tracks.video ?? []),
    ]) {
      const trackAmbient = track.role === "ambient" || track.role === "nat_sound";
      let contributed = false;
      for (const clip of track.clips ?? []) {
        if (clip.timeline_duration_frames <= 0) continue;
        if (!isAmbientFlagged(clip) && !trackAmbient) continue;
        contributed = true;
        ambientSpans.push({
          start_us: Math.round((clip.timeline_in_frame / frameRate) * US_PER_SEC),
          end_us: Math.round(
            ((clip.timeline_in_frame + clip.timeline_duration_frames) / frameRate) * US_PER_SEC,
          ),
        });
      }
      if (contributed) {
        const role = track.role ?? "ambient";
        ambientSources.set(`${track.track_id}|${role}`, { track_id: track.track_id, role });
      }
    }
    const ambientUnionUs = mergeSpans(ambientSpans).reduce(
      (total, span) => total + (span.end_us - span.start_us),
      0,
    );
    silentEnvironmental = {
      available: true,
      no_speech_duration_sec: noSpeechUs / US_PER_SEC,
      longest_no_speech_interval_sec: longestGapUs / US_PER_SEC,
      ambient_audio_track_duration_sec: ambientUnionUs / US_PER_SEC,
      ambient_sources: [...ambientSources.values()],
      observation_only: true,
    };
  }

  // ── Measurement 7: story role order (observation) ──
  const observedRoles: string[] = [];
  for (const clip of clips) {
    const role = beatById.get(clip.beat_id)?.story_role;
    if (!role) continue;
    if (observedRoles[observedRoles.length - 1] !== role) observedRoles.push(role);
  }
  const ranks = observedRoles.map((role) => STORY_ROLE_RANK[role]);
  let adjacentRankDrops: number | null = null;
  if (ranks.length > 0 && ranks.every((rank) => Number.isFinite(rank))) {
    adjacentRankDrops = 0;
    for (let i = 1; i < ranks.length; i += 1) {
      if (ranks[i] < ranks[i - 1]) adjacentRankDrops += 1;
    }
  }

  // ── Measurement 8: human structural change (occurrence-level bag diff) ──
  const humanRef = canonicalHumanRef(input.human_structural_reference);
  let humanStructuralChange: HumanStructuralChange;
  if (!humanRef) {
    humanStructuralChange = {
      available: false,
      reason: "no human structural reference supplied",
      method_note:
        "multiset (bag) difference on segment_id at unmatched-occurrence granularity; order changes are not counted",
    };
  } else {
    // Group occurrences per segment_id in listed order.
    const refOccs = new Map<string, Array<number | undefined>>();
    for (const clip of humanRef.clips) {
      const list = refOccs.get(clip.segment_id) ?? [];
      list.push(clip.duration_us);
      refOccs.set(clip.segment_id, list);
    }
    const actOccs = new Map<string, number[]>();
    for (const clip of clips) {
      const list = actOccs.get(clip.segment_id) ?? [];
      list.push((clip.timeline_duration_frames / frameRate) * US_PER_SEC);
      actOccs.set(clip.segment_id, list);
    }
    const segmentIds = [...new Set([...refOccs.keys(), ...actOccs.keys()])].sort();
    let changedClipCount = 0;
    let changedUs = 0;
    let secondsKnown = true;
    for (const segmentId of segmentIds) {
      const refs = refOccs.get(segmentId) ?? [];
      const acts = actOccs.get(segmentId) ?? [];
      const matched = Math.min(refs.length, acts.length);
      const leftoverRefs = refs.slice(matched);
      const leftoverActs = acts.slice(matched);
      changedClipCount += leftoverRefs.length + leftoverActs.length;
      for (const duration of leftoverRefs) {
        if (duration === undefined) secondsKnown = false;
        else changedUs += duration;
      }
      for (const duration of leftoverActs) changedUs += duration;
    }
    humanStructuralChange = {
      available: true,
      reference_label: humanRef.label ?? null,
      changed_clip_count: changedClipCount,
      changed_seconds: secondsKnown ? changedUs / US_PER_SEC : null,
      method_note:
        "multiset (bag) difference on segment_id at unmatched-occurrence granularity; order changes are not counted",
    };
  }

  // ── Grounding / verdict ──
  const selectsCoverageStatus = input.selects.coverage?.status ?? null;
  const analysisCoverageStatus = input.analysis_coverage?.status ?? null;
  const notes: string[] = [];
  let coverageFailed = false;
  if (selectsCoverageStatus === "failed") {
    coverageFailed = true;
    notes.push("selects coverage status is 'failed'");
  }
  if (analysisCoverageStatus !== null && analysisCoverageStatus !== "ready") {
    coverageFailed = true;
    notes.push(`analysis coverage status is '${analysisCoverageStatus}'`);
  }
  notes.push(
    coverageFailed
      ? "observations are made under failed grounding and must not be read as an auto-assembly capability assessment"
      : "grounding coverage ready",
  );

  return {
    evaluator_version: ASSEMBLY_LOSS_EVALUATOR_VERSION,
    input_hash: inputHash,
    policy_hash: policyHash,
    policy: {
      asr_tolerance_us: toleranceUs,
      asr_tolerance_rationale: ASR_TOLERANCE_RATIONALE,
    },
    grounding: {
      coverage: coverageFailed ? "failed" : "ready",
      selects_coverage_status: selectsCoverageStatus,
      analysis_coverage_status: analysisCoverageStatus,
      notes,
    },
    verdict: coverageFailed ? "HOLD" : "READY",
    measurements: {
      important_utterance_retention: retention,
      head_tail_truncation: truncation,
      kickoff_broll_before_kickoff: kickoffBroll,
      setup_payoff: setupPayoff,
      silent_environmental_audio: silentEnvironmental,
      story_role_order: {
        observed_order: observedRoles,
        adjacent_rank_drops: adjacentRankDrops,
      },
      human_structural_change: humanStructuralChange,
      // Copy, never share the caller's object by reference.
      wall_clock_breakdown: input.wall_clock_breakdown ? { ...input.wall_clock_breakdown } : null,
    },
  };
}

// ── Kickoff helpers ─────────────────────────────────────────────────

interface VoBrollProvenanceLike {
  candidate_ref?: string;
  asset_id?: string;
  source_time_us?: number;
}

function readVoBrollProvenance(timeline: TimelineIR): VoBrollProvenanceLike | null {
  // Canonical location per runtime/compiler/types.ts: TimelineIR.provenance
  // carries creator_short_vo_broll — timeline.metadata is NOT read.
  const provenance = timeline.provenance?.creator_short_vo_broll as VoBrollProvenanceLike | undefined;
  if (!provenance || typeof provenance !== "object") return null;
  return provenance;
}

function findKickoffClipFromProvenance(
  clips: ClipOutput[],
  provenance: VoBrollProvenanceLike,
): ClipOutput | null {
  if (typeof provenance.candidate_ref === "string" && provenance.candidate_ref.length > 0) {
    const byRef = clips.find((clip) => clip.candidate_ref === provenance.candidate_ref);
    if (byRef) return byRef;
  }
  if (
    typeof provenance.asset_id === "string" &&
    typeof provenance.source_time_us === "number" &&
    Number.isFinite(provenance.source_time_us)
  ) {
    return (
      clips.find(
        (clip) =>
          clip.asset_id === provenance.asset_id &&
          clip.src_in_us <= provenance.source_time_us! &&
          provenance.source_time_us! < clip.src_out_us,
      ) ?? null
    );
  }
  return null;
}

function measureBrollBefore(
  clips: ClipOutput[],
  kickoffClip: ClipOutput,
  frameRate: number,
  detectionSource: KickoffBroll["detection_source"],
  kickoffBeatId: string | null,
): KickoffBroll {
  const kickoffStartFrame = kickoffClip.timeline_in_frame;
  let brollClipCount = 0;
  let brollTotalFrames = 0;
  for (const clip of clips) {
    if (clip.clip_id === kickoffClip.clip_id) continue;
    if (!isBrollRole(String(clip.role))) continue;
    // Straddling placements contribute only their pre-kickoff portion.
    const frontFrames =
      Math.min(clip.timeline_in_frame + clip.timeline_duration_frames, kickoffStartFrame) -
      clip.timeline_in_frame;
    if (frontFrames > 0) {
      brollClipCount += 1;
      brollTotalFrames += frontFrames;
    }
  }
  return {
    available: true,
    detection_source: detectionSource,
    kickoff_beat_id: kickoffBeatId,
    kickoff_clip_id: kickoffClip.clip_id,
    broll_clip_count: brollClipCount,
    broll_total_sec: brollTotalFrames / (frameRate || 1),
  };
}
