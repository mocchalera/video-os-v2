/**
 * Rhythm Sync (Issue #35).
 *
 * Snaps canonical timeline cut boundaries onto admitted multi-source rhythm
 * events — authored lyric starts, transcript word heads, measured onsets /
 * section cues, and confidence-qualified downbeats — so that major music
 * section starts (chorus/break) align with video cuts at 1-frame precision.
 *
 * Contract (Issue #35):
 * - Candidate priority is authored lyric, transcript word, strong measured
 *   onset/section cue, then a sufficiently confident measured downbeat.
 * - Chorus section starts Hard Snap only to an admitted candidate in the
 *   ±1.5s search window; unsupported cues retain the original boundary.
 * - Break/bridge and remaining boundaries use the same priority policy within
 *   their configured tolerance; no midpoint or synthetic cue is invented.
 * - Snaps are pair-preserving boundary shifts: the timeline stays flush
 *   (Gap 0f) and total content length is unchanged (Overrun 0f).
 * - Scope: only the primary V1 video track is snap-selected and parity-
 *   measured. Overlay/secondary video tracks are never moved and never used
 *   as parity evidence.
 * - A parity gate verifies every major section start against the nearest
 *   primary cut, measured from the ACTUAL section start frame:
 *   offset < parity_max_offset_frames (default 2) passes; a chorus violation
 *   fails, other sections warn. With parity_gate "enforce" (default) a chorus
 *   parity failure blocks the canonical compile; "off" is the explicit,
 *   documented opt-out.
 * - Parity and integrity are re-measured after post-snap geometry passes
 *   (apex freeze holds ripple later clip positions) so the stamped contract
 *   reflects the final timeline.
 * - Fail-open: missing or ambiguous rhythm evidence never fabricates snaps.
 *   Degraded states are recorded explicitly in canonical metadata. Zero
 *   applied snaps degrade the pass even when section evidence existed.
 *
 * Time-origin assumption (same as beat-sync.ts): bgm_analysis seconds and the
 * music asset's transcript word microseconds share the timeline origin at
 * frame 0.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import {
  computeMediaSourceHash,
  computeMediaHeadSourceHash,
  loadBgmAnalysisFromProjectWithSource,
  type LoadedBgmAnalysis,
} from "../media/bgm-analyzer.js";
import type { BgmAnalysis, BgmCueEvent } from "./transition-types.js";
import { loadLyricLineInputs } from "../caption/lyric-delivery.js";
import {
  hasM2BgmProvenance,
  isBgmAnalysisAcceptedForConsumption,
} from "../media/bgm-analysis-contract.js";
import type { CompilerDefaults, TimelineClip, Track } from "./types.js";
import { RhythmParityGateError } from "./errors.js";
import {
  findRepoRoot,
  normalizeAuthorityDetail,
  validateTranscriptDoc,
} from "../validation/schema-validator.js";
import { isSpeechProtectedBeatBoundary, applyBoundaryShift } from "./beat-sync.js";

// ── Public types ────────────────────────────────────────────────────

export type RhythmSyncMode = "auto" | "on" | "off";
export type RhythmEventKind = "onset" | "downbeat" | "section_start" | "word_start";
export type RhythmEventProvenance =
  | "authored_lyric"
  | "transcript_word_start"
  | "measured_onset"
  | "measured_section"
  | "measured_downbeat"
  | "legacy_beat"
  | "legacy_downbeat";
export type RhythmSyncStatus = "applied" | "degraded" | "disabled";
export type RhythmParityStatus = "pass" | "warning" | "fail" | "degraded";
export type RhythmSyncSkipReason =
  | "speech_protected"
  | "still_image_boundary"
  | "min_duration"
  | "source_range_exceeded"
  | "max_shift_exceeded"
  | "no_event_in_window"
  | "locked_boundary"
  | "neighbor_collision"
  | "low_confidence"
  | "outside_tolerance"
  | "admission_rejected";
export type RhythmSyncRejectionReason = "low_confidence" | "outside_tolerance" | "admission_rejected";

/** Section labels treated as major section starts (Issue #35: サビやブレイクなど). */
export const MAJOR_SECTION_LABELS = ["chorus", "break", "bridge"] as const;
/** Sections that Hard Snap with top priority (Issue #35: 優先度最高). */
export const HARD_SNAP_SECTION_LABELS = ["chorus"] as const;

export interface RhythmEvent {
  /** Timeline frame (integer). Music/word time origin = timeline frame 0. */
  frame: number;
  time_sec: number;
  us: number;
  kind: RhythmEventKind;
  strength?: number;
  /** Normalized per-cue confidence used for admission and target receipts. */
  confidence?: number;
  /** Exact source class used by the deterministic priority policy. */
  provenance?: RhythmEventProvenance;
  word?: string;
  asset_id?: string;
  section_id?: string;
  section_label?: string;
}

export interface RhythmEventGrid {
  events: RhythmEvent[];
  /** Major sections (chorus/break/bridge) from bgm analysis, sorted by start_sec. */
  majorSections: Array<{
    id: string;
    label: string;
    start_frame: number;
    end_frame: number;
    start_sec: number;
    end_sec: number;
    hard_snap: boolean;
  }>;
  status: "ready" | "partial" | "unavailable";
  sources: {
    bgm_analysis: boolean;
    word_timestamps: boolean;
    beat_count: number;
    word_count: number;
    section_count: number;
    /** Optional because older in-memory callers do not have authored inputs. */
    authored_lyric?: boolean;
    authored_lyric_count?: number;
  };
  degraded_reasons: string[];
  /** Evidence binding and provenance recorded from the consumed artifacts. */
  evidence: RhythmSyncEvidenceProvenance;
}

/**
 * Binding of rhythm evidence to the consuming project (Issue #35 repair),
 * FAIL-CLOSED: evidence with a missing or foreign project id, a missing or
 * tampered source hash, or an unverifiable artifact identity is never
 * adopted — the corresponding events/word timestamps are discarded and the
 * binding is stamped "degraded" (identity check failed) or "unbound" (no
 * verifiable evidence present). Artifact path/hash always record the file
 * ACTUALLY consumed (primary or legacy fallback), never the primary when the
 * fallback was consumed.
 */
export interface RhythmSyncEvidenceProvenance {
  /** Project id recorded by the evidence artifacts (not the consuming project). */
  project_id?: string;
  /** Project-relative path of the bgm artifact file ACTUALLY consumed. */
  bgm_artifact_path?: string;
  /** Which artifact file was consumed (primary or the legacy fallback). */
  bgm_artifact_origin?: "primary" | "legacy_fallback";
  /** sha256 of the bgm artifact file as consumed (the resolved path, not the primary). */
  bgm_artifact_sha256?: string;
  /** music_asset.source_hash recorded in the bgm artifact. */
  bgm_source_sha256?: string;
  /** Detector/model provenance from the bgm artifact. */
  bgm_detector?: string;
  bgm_sample_rate_hz?: number;
  /** sha256 of the consumed music-asset transcript file. */
  transcript_artifact_sha256?: string;
  transcript_asset_id?: string;
  /** Project-relative path/hash of the canonical authored lyric script, if present. */
  authored_lyric_artifact_path?: string;
  authored_lyric_artifact_sha256?: string;
  /**
   * Per-file binding records for EVERY snapshotted transcript (deterministic
   * path/hash order): only "bound" files may have affected geometry.
   */
  transcripts?: readonly TranscriptBindingRecord[];
  /**
   * "bound": identity verified, evidence adopted; "degraded": an identity
   * check failed, evidence rejected; "unbound": no verifiable evidence present.
   */
  binding: "bound" | "degraded" | "unbound";
  /** Explicit binding failures (also mirrored into metadata.degraded_reasons). Frozen after snapshot. */
  binding_failures: readonly string[];
}

export interface RhythmSyncBoundaryResult {
  track_id: string;
  left_clip_id: string;
  right_clip_id: string;
  right_beat_id: string;
  cut_frame_before: number;
  cut_frame_after: number;
  /** Omitted only when no candidate was observed for this boundary. */
  target_frame?: number;
  target_kind?: RhythmEventKind;
  target_word?: string;
  target_provenance?: RhythmEventProvenance;
  /** null records an observed candidate whose confidence was unavailable. */
  target_confidence?: number | null;
  /** Configured candidate tolerance in timeline frames. */
  tolerance_frames: number;
  /** Explicit geometry decision for independent review. */
  decision: "snap_applied" | "retained" | "rejected";
  /** Deterministic reason for the decision. */
  reason: string;
  section_id?: string;
  section_label?: string;
  /** True when the boundary was snapped as a section start (Hard Snap for chorus). */
  section_snap: boolean;
  hard_snap: boolean;
  shift_frames: number;
  status: "snapped" | "unchanged" | "skipped";
  skip_reason?: RhythmSyncSkipReason;
}

export interface RhythmSectionParity {
  section_id: string;
  label: string;
  hard_snap: boolean;
  /** Actual section start frame from the analysis artifact (acceptance basis). */
  section_start_frame: number;
  /** Chosen snap target event frame; absent when no rhythm event evidenced the section. */
  target_frame?: number;
  target_kind?: RhythmEventKind;
  target_word?: string;
  target_provenance?: RhythmEventProvenance;
  target_confidence?: number;
  /** |target_frame - section_start_frame|; recorded for transparency. */
  target_offset_frames?: number;
  /** Nearest primary V1 cut frame; absent when the track has no cuts. */
  cut_frame?: number;
  /** Acceptance offset: |cut_frame - section_start_frame| (not vs the chosen target). */
  offset_frames?: number;
  status: RhythmParityStatus;
  reason?: string;
}

export interface RhythmSyncIntegrity {
  /** Positive holes between consecutive primary video clips after snapping. */
  gap_frames: number;
  /** Overhang/overlap between consecutive primary video clips after snapping. */
  overrun_frames: number;
  boundary_count: number;
  verified: boolean;
}

export interface RhythmSyncCompileMetadata {
  version: "1";
  mode: RhythmSyncMode;
  enabled: boolean;
  status: RhythmSyncStatus;
  disabled_reason?: "configured_off" | "no_rhythm_events";
  degraded_reasons: string[];
  sources: RhythmEventGrid["sources"];
  search_window_sec: number;
  max_shift_frames: number;
  parity_max_offset_frames: number;
  parity_gate: "enforce" | "off";
  /** Minimum measured cue confidence admitted by this pass. */
  min_cue_confidence?: number;
  /** True when parity/integrity were re-measured after post-snap geometry passes. */
  parity_recomputed_after_geometry_passes?: boolean;
  fps_num: number;
  fps_den: number;
  /** Evidence binding/provenance stamped from the consumed rhythm artifacts. */
  evidence_provenance?: RhythmSyncEvidenceProvenance;
  snaps: RhythmSyncBoundaryResult[];
  parity: {
    status: RhythmParityStatus;
    max_offset_frames: number;
    sections: RhythmSectionParity[];
  };
  integrity: RhythmSyncIntegrity;
  counts: {
    snapped: number;
    hard_snapped: number;
    section_snapped: number;
    unchanged: number;
    skipped: number;
    skipped_speech_protected: number;
    skipped_still_image: number;
    skipped_min_duration: number;
    skipped_source_range: number;
    skipped_max_shift: number;
    skipped_no_event: number;
    skipped_locked_boundary: number;
    skipped_neighbor_collision: number;
  };
}

export interface ResolvedRhythmSyncConfig {
  mode: RhythmSyncMode;
  searchWindowSec: number;
  maxShiftFrames: number;
  parityMaxOffsetFrames: number;
  minCueConfidence: number;
  /** "enforce" (default): a chorus parity fail blocks the canonical compile. */
  parityGate: "enforce" | "off";
}

// ── Config ──────────────────────────────────────────────────────────

export function resolveRhythmSyncConfig(defaults: CompilerDefaults): ResolvedRhythmSyncConfig {
  const raw = defaults.rhythm_sync;
  const mode: RhythmSyncMode = raw?.mode === "on" || raw?.mode === "off" ? raw.mode : "auto";
  const searchWindowSec = positiveFinite(raw?.search_window_sec) ? raw!.search_window_sec! : 1.5;
  const maxShiftFrames = positiveFinite(raw?.max_shift_frames)
    ? Math.max(0, Math.floor(raw!.max_shift_frames!))
    : 12;
  const parityMaxOffsetFrames = positiveFinite(raw?.parity_max_offset_frames)
    ? Math.max(1, Math.floor(raw!.parity_max_offset_frames!))
    : 2;
  const minCueConfidence = boundedConfidence(raw?.min_cue_confidence) ?? DEFAULT_MIN_CUE_CONFIDENCE;
  const parityGate: "enforce" | "off" = raw?.parity_gate === "off" ? "off" : "enforce";
  return { mode, searchWindowSec, maxShiftFrames, parityMaxOffsetFrames, minCueConfidence, parityGate };
}

function positiveFinite(value: number | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

const DEFAULT_MIN_CUE_CONFIDENCE = 0.6;

function boundedConfidence(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1
    ? value
    : undefined;
}

// ── Rational time conversion (Issue #35 repair) ─────────────────────
// All rhythm time math goes through fpsNum/fpsDen rationals — never a bare
// fpsNum. At 30000/1001 (29.97fps), 1s maps to 30 frames and the ±1.5s
// window to 45 frames; frame→µs round trips stay within half a frame.

/** Seconds → nearest timeline frame at fpsNum/fpsDen. */
export function secondsToRhythmFrame(seconds: number, fpsNum: number, fpsDen: number): number {
  return Math.round((seconds * fpsNum) / fpsDen);
}

/** Microseconds → nearest timeline frame at fpsNum/fpsDen. */
export function usToRhythmFrame(us: number, fpsNum: number, fpsDen: number): number {
  return Math.round((us * fpsNum) / (1_000_000 * fpsDen));
}

/** Timeline frames → microseconds at fpsNum/fpsDen (source-range shifts). */
export function rhythmFramesToUs(frames: number, fpsNum: number, fpsDen: number): number {
  return Math.round((frames * 1_000_000 * fpsDen) / fpsNum);
}

// ── Multi-source rhythm event grid ──────────────────────────────────

interface TranscriptWordDoc {
  project_id?: string;
  asset_id?: string;
  word_timing_mode?: string;
  items?: Array<{
    start_us?: number;
    end_us?: number;
    words?: Array<{ word?: string; start_us?: number; end_us?: number }>;
  }>;
}

/**
 * Load the multi-source rhythm event grid for a project.
 *
 * Sources:
 * - 03_analysis/bgm_analysis.json (status "ready" only): admitted typed M2
 *   beat/onset/downbeat cues and measured sections; legacy beats_sec /
 *   downbeats_sec remain an explicitly labelled compatibility path.
 * - Word-level STT (items[].words[].start_us) from the transcript of the BGM
 *   asset (bgm_analysis.music_asset.asset_id). Word timestamps of other assets
 *   are source-local and would be false evidence on the timeline, so they are
 *   ignored deliberately.
 *
 * Never throws: missing or malformed evidence degrades explicitly.
 */
export interface RhythmEvidenceBinding {
  /**
   * Repository root for the canonical transcript.schema.json authority.
   * Compile passes its resolved root; when omitted it is discovered by
   * walking up from the project, and when it cannot be discovered the
   * schema check fails CLOSED (all transcripts degraded with
   * "transcript_schema_authority_unavailable").
   */
  repoRoot?: string;
  /**
   * Consuming project id. Providing it enables FAIL-CLOSED identity binding:
   * missing/foreign project ids, missing/tampered source hashes, missing
   * media, and missing artifact identity reject the evidence — the
   * corresponding events/word timestamps are never adopted. Without it the
   * loader stays lenient (analysis-time use); provenance is still recorded.
   */
  projectId?: string;
  /** Isolated media path used to verify a staged BGM artifact without rewriting it. */
  bgmMediaPathOverride?: string;
}

/** Project-relative posix path for provenance stamping. */
function toProjectRelative(projectPath: string, absolutePath: string): string {
  const rel = path.relative(path.resolve(projectPath), path.resolve(absolutePath));
  return rel.split(path.sep).join("/");
}

export interface AuthoredLyricSnapshot {
  /** Project-relative path of the exact script bytes consumed. */
  relativePath: string;
  /** sha256 of those exact bytes. */
  sha256: string;
  /** Timed line/phrase starts projected from the snapshotted script. */
  lines: ReadonlyArray<{ text: string; startSec: number; endSec: number }>;
  /** True when the file existed but its timing could not be parsed. */
  parseError: boolean;
}

/**
 * Snapshot the canonical authored lyric script without making it a required
 * input. The lyric-delivery parser already enforces timestamp ownership and
 * refuses to invent timing, so this route only promotes parsed line starts.
 */
export function snapshotAuthoredLyrics(
  projectPath: string,
  videoDurationSec?: number,
): AuthoredLyricSnapshot | undefined {
  const absolutePath = path.join(projectPath, "01_intent", "lyrics.lrc");
  if (!fs.existsSync(absolutePath)) return undefined;
  let bytes: Buffer;
  try {
    bytes = fs.readFileSync(absolutePath);
  } catch {
    return undefined;
  }
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  try {
    const lines = loadLyricLineInputs(bytes.toString("utf8"), {
      ...(Number.isFinite(videoDurationSec) && (videoDurationSec as number) > 0
        ? { videoDurationSec }
        : {}),
    }).map((line) => ({
      text: line.text,
      startSec: line.startSec,
      endSec: line.endSec,
    }));
    return Object.freeze({
      relativePath: toProjectRelative(projectPath, absolutePath),
      sha256,
      lines: Object.freeze(lines),
      parseError: false,
    });
  } catch {
    return Object.freeze({
      relativePath: toProjectRelative(projectPath, absolutePath),
      sha256,
      lines: Object.freeze([]),
      parseError: true,
    });
  }
}

/**
 * Load the multi-source rhythm event grid for a project.
 *
 * Sources:
 * - 03_analysis/bgm_analysis.json (status "ready" only): admitted typed M2
 *   beat/onset/downbeat cues and measured sections; legacy beats_sec /
 *   downbeats_sec remain an explicitly labelled compatibility path.
 * - Word-level STT (items[].words[].start_us) from the transcript of the BGM
 *   asset (bgm_analysis.music_asset.asset_id). Word timestamps of other assets
 *   are source-local and would be false evidence on the timeline, so they are
 *   ignored deliberately.
 *
 * Evidence binding: artifacts stamped with a different project id are foreign
 * and rejected; a recorded music source hash that disagrees with the media on
 * disk is rejected; malformed section/beat entries are filtered explicitly.
 * Every consumed artifact is hash-stamped into grid.evidence.
 *
 * All seconds→frame conversions use the rational fpsNum/fpsDen.
 *
 * Never throws: missing, foreign, malformed, or tampered evidence degrades
 * explicitly.
 */
export interface RhythmEvidenceSnapshot {
  /** Single-snapshot BGM consumption: parsed analysis + digest + path + origin. */
  bgm: LoadedBgmAnalysis | undefined;
  /** Single-snapshot transcript consumption: parsed words + digest. */
  words: MusicWordsSnapshot | undefined;
  /** EVERY transcript file, each read exactly once (utterance + word truth). */
  transcripts: TranscriptsDirSnapshot;
  /** Canonical authored lyric script captured once; never re-opened in grid build. */
  authoredLyrics?: AuthoredLyricSnapshot;
  /** Binding verdict + provenance computed ONCE at snapshot time. */
  evidence: RhythmSyncEvidenceProvenance;
  /** True when BGM identity is verified: its data may affect geometry phases. */
  bgmBound: boolean;
  /** True when transcript identity is verified: words may be adopted. */
  wordsBound: boolean;
  /** Entry-level degradations (binding failures mirrored; missing evidence). */
  degradedReasons: readonly string[];
}

/**
 * ONE immutable, strict, project-bound rhythm evidence snapshot for the whole
 * compile (Issue #35): the BGM artifact and the music transcript are each
 * read EXACTLY ONCE — bytes, digest, parsed data, resolved path, origin and
 * binding failures all derive from that same snapshot. Scoring, beat-sync,
 * adjacency and rhythm-sync must consume THIS snapshot; no phase may re-open
 * the artifact paths, so an A→B→A race cannot let one phase quantize V1 with
 * evidence whose provenance describes other bytes, and missing project ids /
 * source hashes are rejected BEFORE any geometry-affecting phase runs.
 *
 * Unbound/degraded BGM evidence (bgmBound false) must never be injected into
 * geometry-affecting phases. Frozen: treat as immutable.
 */
export function loadRhythmEvidenceSnapshot(
  projectPath: string,
  binding: RhythmEvidenceBinding = {},
): RhythmEvidenceSnapshot {
  const degradedReasons: string[] = [];
  const bindingFailures: string[] = [];
  const evidence: RhythmSyncEvidenceProvenance = {
    binding: "unbound",
    binding_failures: bindingFailures,
  };
  const bindFail = (reason: string): void => {
    bindingFailures.push(reason);
    evidence.binding = "degraded";
    degradedReasons.push(reason);
  };

  // Source-aware load: resolvedPath/origin record the artifact file ACTUALLY
  // consumed (primary 03_analysis or legacy 07_package fallback) — provenance
  // hashes never fake the primary when the fallback was consumed. Bytes,
  // digest and parsed analysis come from one single read.
  const loaded = loadBgmAnalysisFromProjectWithSource(projectPath);
  const bgm = loaded?.analysis;
  const bgmContractRejected = Boolean(
    bgm && hasM2BgmProvenance(bgm) && !isBgmAnalysisAcceptedForConsumption(bgm),
  );
  const strict = binding.projectId !== undefined;

  if (!bgm) {
    degradedReasons.push("bgm_analysis_missing_or_not_ready");
    if (strict) {
      bindingFailures.push("bgm_artifact_missing_or_not_ready");
    }
  }

  // ── Evidence binding (fail-closed under requested binding) ──
  let bgmBound = bgm !== undefined && bgm.analysis_status === "ready" && !bgmContractRejected;
  if (bgmContractRejected) bindFail("bgm_analysis_contract_rejected");
  if (bgm && loaded) {
    evidence.project_id = bgm.project_id;
    evidence.bgm_artifact_path = toProjectRelative(projectPath, loaded.resolvedPath);
    evidence.bgm_artifact_origin = loaded.origin;
    // The digest comes from the same bytes the analysis was parsed from.
    evidence.bgm_artifact_sha256 = loaded.artifactSha256;
    evidence.bgm_detector = bgm.provenance?.detector;
    evidence.bgm_sample_rate_hz = bgm.provenance?.sample_rate_hz;
    evidence.bgm_source_sha256 = bgm.music_asset?.source_hash;

    const artifactHashUnavailable = evidence.bgm_artifact_sha256 === undefined;
    const projectIdMissing = typeof bgm.project_id !== "string" || bgm.project_id.length === 0;
    const projectIdForeign = binding.projectId !== undefined &&
      !projectIdMissing && bgm.project_id !== binding.projectId;
    const sourceHashMissing = typeof bgm.music_asset?.source_hash !== "string" ||
      (bgm.music_asset?.source_hash as string).length === 0;

    if (strict) {
      // Required artifact identity: project id, source hash, consumable hash.
      if (artifactHashUnavailable) bindFail("bgm_artifact_hash_unavailable");
      if (projectIdMissing) bindFail("bgm_project_id_missing");
      else if (projectIdForeign) bindFail("bgm_analysis_project_id_mismatch");
      if (sourceHashMissing) bindFail("bgm_source_hash_missing");
      // Tamper check: recorded source hash must match the media on disk.
      if (!sourceHashMissing && bgm.music_asset?.path) {
        const recordedSourceHash = bgm.music_asset.source_hash as string;
        const mediaPath = binding.bgmMediaPathOverride ?? (path.isAbsolute(bgm.music_asset.path)
          ? bgm.music_asset.path
          : path.join(projectPath, bgm.music_asset.path));
        if (!fs.existsSync(mediaPath)) {
          bindFail("bgm_music_source_unverifiable");
        } else if ((recordedSourceHash.length === 64
          ? computeMediaSourceHash(mediaPath)
          : computeMediaHeadSourceHash(mediaPath)) !== recordedSourceHash) {
          bindFail("bgm_music_source_hash_mismatch");
        }
      }
      if (evidence.binding === "degraded") bgmBound = false;
      else evidence.binding = "bound";
    } else if (projectIdForeign) {
      // Lenient mode still never adopts foreign evidence.
      bindFail("bgm_analysis_project_id_mismatch");
      bgmBound = false;
    }
  }

  // EVERY transcript file is snapshotted exactly once here (readdir once,
  // one read per file) and bound to the consuming project — the music-asset
  // words AND all utterance projections derive from this single snapshot; no
  // consumer re-opens transcript paths.
  const transcripts = snapshotTranscriptsDirectory(projectPath, {
    projectId: binding.projectId,
    repoRoot: binding.repoRoot,
  });

  // Authored lyric timing is an optional, project-local input. It is captured
  // in the same entry snapshot so candidate selection cannot observe a
  // different script than the provenance receipt describes.
  const authoredLyrics = snapshotAuthoredLyrics(projectPath, bgm?.duration_sec);
  if (authoredLyrics?.parseError) {
    degradedReasons.push("authored_lyric_parse_failed");
  }
  if (authoredLyrics) {
    evidence.authored_lyric_artifact_path = authoredLyrics.relativePath;
    evidence.authored_lyric_artifact_sha256 = authoredLyrics.sha256;
  }

  // Music-asset words: pure projection of the snapshotted transcript bytes.
  let words: MusicWordsSnapshot | undefined;
  let wordsBound = false;
  if (bgmBound && bgm?.music_asset?.asset_id) {
    const failures: string[] = [];
    words = wordsFromTranscriptSnapshot(transcripts, bgm.music_asset.asset_id, {
      projectId: binding.projectId,
      bindingFailures: failures,
    });
    evidence.transcript_artifact_sha256 = words.artifactSha256;
    evidence.transcript_asset_id = bgm.music_asset.asset_id;
    for (const failure of failures) bindFail(failure);
    wordsBound = words.words.length > 0 && failures.length === 0;
  }

  return Object.freeze({
    bgm: loaded,
    words: words ? Object.freeze({ ...words, words: Object.freeze([...words.words]) }) : undefined,
    transcripts,
    ...(authoredLyrics ? {
      authoredLyrics: Object.freeze({
        ...authoredLyrics,
        lines: Object.freeze([...authoredLyrics.lines]),
      }),
    } : {}),
    evidence: Object.freeze({
      ...evidence,
      binding_failures: Object.freeze([...bindingFailures]),
      transcripts: Object.freeze(transcriptBindingRecords(transcripts)),
    }),
    bgmBound,
    wordsBound,
    degradedReasons: Object.freeze([...degradedReasons]),
  });
}

/**
 * Build the rhythm event grid from an entry snapshot WITHOUT touching the
 * filesystem — every phase consuming this grid sees exactly the snapshot that
 * binding and provenance describe.
 */
export function buildRhythmEventGridFromSnapshot(
  snapshot: RhythmEvidenceSnapshot,
  fpsNum: number,
  fpsDen = 1,
  minCueConfidence = DEFAULT_MIN_CUE_CONFIDENCE,
): RhythmEventGrid {
  const degradedReasons: string[] = [...snapshot.degradedReasons];
  const events: RhythmEvent[] = [];
  const sources = {
    bgm_analysis: false,
    word_timestamps: false,
    beat_count: 0,
    word_count: 0,
    section_count: 0,
    authored_lyric: false,
    authored_lyric_count: 0,
  };
  const evidence = snapshot.evidence;

  const bgm = snapshot.bgmBound ? snapshot.bgm?.analysis : undefined;
  const sections = bgm
    ? (bgm.sections ?? []).filter((section): section is BgmAnalysis["sections"][number] => {
        const ok = section !== null && typeof section === "object" &&
          typeof (section as { id?: unknown }).id === "string" &&
          typeof (section as { label?: unknown }).label === "string" &&
          Number.isFinite((section as { start_sec?: unknown }).start_sec) &&
          Number.isFinite((section as { end_sec?: unknown }).end_sec);
        // Malformed entries are a parsing degradation, not an identity
        // binding failure: valid sections stay usable, binding is unaffected.
        if (!ok) degradedReasons.push("bgm_malformed_sections_filtered");
        return ok;
      })
    : [];
  const sectionOf = (timeSec: number): { id: string; label: string } | undefined => {
    for (const section of sections) {
      if (timeSec >= section.start_sec && timeSec < section.end_sec) {
        return { id: section.id, label: section.label };
      }
    }
    return undefined;
  };

  const frameIndex = new Map<number, number>();
  const cueThreshold = boundedConfidence(minCueConfidence) ?? DEFAULT_MIN_CUE_CONFIDENCE;
  // Same-frame dedupe keeps the highest-value evidence and then the strongest
  // cue. This prevents a legacy beat projection from hiding a measured onset
  // or an authored lyric line at the same frame.
  const pushEvent = (event: RhythmEvent): void => {
    const existing = frameIndex.get(event.frame);
    if (existing === undefined) {
      frameIndex.set(event.frame, events.length);
      events.push(event);
      return;
    }
    if (eventEvidencePriority(event) > eventEvidencePriority(events[existing])) {
      events[existing] = event;
    }
  };

  if (bgm) {
    sources.bgm_analysis = true;
    const isMeasuredArtifact = hasM2BgmProvenance(bgm);
    const typedBeats = Array.isArray(bgm.beats)
      ? bgm.beats.filter((beat): beat is BgmCueEvent => isAdmittedMeasuredCue(beat, isMeasuredArtifact))
      : [];
    const typedOnsets = Array.isArray(bgm.onsets)
      ? bgm.onsets.filter((onset): onset is BgmCueEvent => isAdmittedMeasuredCue(onset, isMeasuredArtifact))
      : [];
    const pushCue = (
      cue: BgmCueEvent | undefined,
      timeSec: number,
      kind: RhythmEventKind,
      provenance: RhythmEventProvenance,
      section = sectionOf(timeSec),
    ): void => {
      const sec = Number.isFinite(cue?.time_sec) ? cue!.time_sec : timeSec;
      if (!Number.isFinite(sec) || sec < 0) return;
      const frame = secondsToRhythmFrame(sec, fpsNum, fpsDen);
      if (frame < 0) return;
      const confidence = boundedConfidence(cue?.strength);
      pushEvent({
        frame,
        time_sec: sec,
        us: Math.round(sec * 1_000_000),
        kind,
        ...(confidence !== undefined ? { strength: confidence, confidence } : {}),
        provenance,
        ...(section ? { section_id: section.id, section_label: section.label } : {}),
      });
    };

    if (isMeasuredArtifact) {
      // M2 admission requires typed measured beats/onsets. The untyped
      // downbeats_sec projection is deliberately not a fallback here.
      for (const beat of typedBeats) pushCue(beat, beat.time_sec, "onset", "measured_onset");
      for (const onset of typedOnsets) pushCue(onset, onset.time_sec, "onset", "measured_onset");
      const typedDownbeats = Array.isArray(bgm.downbeats)
        ? bgm.downbeats.filter((downbeat): downbeat is BgmCueEvent => isAdmittedMeasuredCue(downbeat, true))
        : [];
      for (const downbeat of typedDownbeats) {
        pushCue(downbeat, downbeat.time_sec, "downbeat", "measured_downbeat");
      }
    } else {
      // Legacy artifacts stay on their compatibility path, but the receipt
      // labels these candidates as legacy rather than measured evidence.
      const downbeatSeconds = new Set(finiteSeconds(bgm.downbeats_sec));
      const beatSeconds = finiteSeconds(bgm.beats_sec);
      for (const sec of beatSeconds) {
        const beat = bgm.beats?.find((candidate) => Math.abs(candidate.time_sec - sec) < 1e-6);
        pushCue(
          beat ? { time_sec: sec, strength: boundedConfidence(beat.strength) ?? 1 } : { time_sec: sec, strength: 1 },
          sec,
          downbeatSeconds.has(sec) ? "downbeat" : "onset",
          downbeatSeconds.has(sec) ? "legacy_downbeat" : "legacy_beat",
        );
      }
      for (const sec of downbeatSeconds) {
        const beat = bgm.beats?.find((candidate) => Math.abs(candidate.time_sec - sec) < 1e-6);
        pushCue(
          beat ? { time_sec: sec, strength: boundedConfidence(beat.strength) ?? 1 } : { time_sec: sec, strength: 1 },
          sec,
          "downbeat",
          "legacy_downbeat",
        );
      }
      for (const onset of typedOnsets) pushCue(onset, onset.time_sec, "onset", "legacy_beat");
    }
  }

  // Authored LRC line/phrase starts outrank all measured audio cues. They are
  // optional and are only projected after the BGM identity has been bound.
  let authoredLyricCount = 0;
  if (snapshot.bgmBound && bgm?.music_asset?.asset_id && snapshot.authoredLyrics && !snapshot.authoredLyrics.parseError) {
    for (const line of snapshot.authoredLyrics.lines) {
      if (!Number.isFinite(line.startSec) || line.startSec < 0 || line.text.trim().length === 0) continue;
      const frame = secondsToRhythmFrame(line.startSec, fpsNum, fpsDen);
      if (frame < 0) continue;
      const section = sectionOf(line.startSec);
      pushEvent({
        frame,
        time_sec: line.startSec,
        us: Math.round(line.startSec * 1_000_000),
        kind: "word_start",
        word: line.text,
        confidence: 1,
        provenance: "authored_lyric",
        asset_id: bgm.music_asset.asset_id,
        ...(section ? { section_id: section.id, section_label: section.label } : {}),
      });
      authoredLyricCount += 1;
    }
  }
  if (authoredLyricCount > 0) {
    sources.authored_lyric = true;
    sources.authored_lyric_count = authoredLyricCount;
  }

  // Word-level events from the transcript snapshot (single truth).
  let wordCount = 0;
  if (snapshot.bgmBound && bgm?.music_asset?.asset_id) {
    const words = snapshot.words?.words ?? [];
    const wordBindingFailures = snapshot.words?.bindingFailures ?? [];
    if (words.length === 0 && wordBindingFailures.length === 0 && authoredLyricCount === 0) {
      degradedReasons.push("no_word_timestamps_for_music_asset");
    }
    for (const word of words) {
      const frame = usToRhythmFrame(word.start_us, fpsNum, fpsDen);
      if (frame < 0) continue;
      const timeSec = word.start_us / 1_000_000;
      const section = sectionOf(timeSec);
      pushEvent({
        frame,
        time_sec: timeSec,
        us: word.start_us,
        kind: "word_start",
        word: word.word,
        confidence: 1,
        provenance: "transcript_word_start",
        asset_id: bgm.music_asset.asset_id,
        ...(section ? { section_id: section.id, section_label: section.label } : {}),
      });
      wordCount += 1;
    }
    if (wordCount > 0) sources.word_timestamps = true;
    sources.word_count = wordCount;
  }

  const majorSections = sections
    .filter((section) => (MAJOR_SECTION_LABELS as readonly string[]).includes(section.label))
    .map((section) => ({
      id: section.id,
      label: section.label,
      start_frame: secondsToRhythmFrame(section.start_sec, fpsNum, fpsDen),
      end_frame: secondsToRhythmFrame(section.end_sec, fpsNum, fpsDen),
      start_sec: section.start_sec,
      end_sec: section.end_sec,
      hard_snap: (HARD_SNAP_SECTION_LABELS as readonly string[]).includes(section.label),
    }))
    .sort((a, b) => a.start_frame - b.start_frame || a.id.localeCompare(b.id));
  sources.section_count = majorSections.length;
  if (sources.bgm_analysis && majorSections.length === 0) {
    degradedReasons.push("no_major_sections_in_bgm_analysis");
  }

  // A measured section boundary is a usable cue only when its measured
  // energy is strong enough. This is intentionally separate from the
  // section metadata used for parity: a weak section never creates a target.
  if (bgm && hasM2BgmProvenance(bgm)) {
    for (const section of majorSections) {
      const sourceSection = sections.find((candidate) => candidate.id === section.id);
      if (sourceSection?.evidence_classification !== "measured") continue;
      if (Number.isFinite(sourceSection.energy) && sourceSection.energy >= cueThreshold) {
        pushEvent({
          frame: section.start_frame,
          time_sec: section.start_sec,
          us: Math.round(section.start_sec * 1_000_000),
          kind: "section_start",
          strength: sourceSection.energy,
          confidence: sourceSection.energy,
          provenance: "measured_section",
          section_id: section.id,
          section_label: section.label,
          asset_id: bgm.music_asset.asset_id,
        });
      } else {
        degradedReasons.push("weak_section_cue:" + section.id);
      }
    }
  }

  sources.beat_count = events.filter((event) => event.kind !== "word_start").length;

  events.sort((a, b) => a.frame - b.frame || eventKindPriority(b.kind) - eventKindPriority(a.kind) ||
    eventProvenance(a).localeCompare(eventProvenance(b)) || (a.word ?? "").localeCompare(b.word ?? ""));

  const status: RhythmEventGrid["status"] =
    sources.bgm_analysis && (sources.word_timestamps || sources.authored_lyric || sources.beat_count > 0)
      ? (sources.word_timestamps || sources.authored_lyric ? "ready" : "partial")
      : sources.bgm_analysis
        ? "partial"
        : "unavailable";

  return { events, majorSections, status, sources, degraded_reasons: [...new Set(degradedReasons)], evidence };
}

/**
 * Compat loader: snapshot + grid build in one call (analysis-time use).
 * The compile route injects loadRhythmEvidenceSnapshot at entry instead so
 * every phase shares one immutable snapshot.
 */
export function loadRhythmEventGrid(
  projectPath: string,
  fpsNum: number,
  fpsDen = 1,
  binding: RhythmEvidenceBinding = {},
): RhythmEventGrid {
  return buildRhythmEventGridFromSnapshot(loadRhythmEvidenceSnapshot(projectPath, binding), fpsNum, fpsDen);
}

function eventKindPriority(kind: RhythmEventKind): number {
  return kind === "word_start" ? 4 : kind === "section_start" ? 3 : kind === "onset" ? 2 : 1;
}

function isAdmittedMeasuredCue(value: unknown, measuredOnly: boolean): value is BgmCueEvent {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const cue = value as Partial<BgmCueEvent>;
  const timeSec = cue.time_sec;
  const strength = cue.strength;
  if (typeof timeSec !== "number" || typeof strength !== "number" ||
    !Number.isFinite(timeSec) || !Number.isFinite(strength) ||
    timeSec < 0 || strength < 0 || strength > 1) return false;
  if (cue.evidence_classification === "synthetic" || cue.evidence_classification === "unavailable") return false;
  return !measuredOnly || cue.evidence_classification === "measured";
}

function eventProvenance(event: RhythmEvent): RhythmEventProvenance {
  if (event.provenance) return event.provenance;
  if (event.kind === "word_start") return "transcript_word_start";
  if (event.kind === "section_start") return "measured_section";
  if (event.kind === "downbeat") return "measured_downbeat";
  return "measured_onset";
}

function eventConfidence(event: RhythmEvent): number | undefined {
  const confidence = boundedConfidence(event.confidence ?? event.strength);
  if (confidence !== undefined) return confidence;
  // Word heads carry a timestamp-owned confidence, while legacy projections
  // are admitted only on their explicitly labelled compatibility path.
  if (event.kind === "word_start" || eventProvenance(event).startsWith("legacy_")) return 1;
  return undefined;
}

function eventCandidateTier(event: RhythmEvent): number {
  const provenance = eventProvenance(event);
  if (provenance === "authored_lyric") return 0;
  if (event.kind === "word_start" || provenance === "transcript_word_start") return 1;
  if (event.kind === "onset" || event.kind === "section_start" ||
    provenance === "measured_onset" || provenance === "measured_section") return 2;
  return 3;
}

function eventEvidencePriority(event: RhythmEvent): number {
  const tier = eventCandidateTier(event);
  const confidence = eventConfidence(event) ?? 0;
  return (4 - tier) * 1_000 + confidence * 100 + eventKindPriority(event.kind);
}

function finiteSeconds(values: number[] | undefined): number[] {
  if (!Array.isArray(values)) return [];
  return values.filter((value) => Number.isFinite(value) && value >= 0);
}

/**
 * One transcript FILE captured from a single read: digest and parsed doc both
 * derive from the same immutable bytes.
 */
export interface TranscriptArtifactSnapshot {
  /** Project-relative posix path of the transcript file. */
  relativePath: string;
  /** sha256 hex of the exact bytes parsed (undefined bytes never occur here). */
  sha256: string;
  /** Parsed JSON document; undefined when malformed. */
  doc: unknown;
  parseError: boolean;
}

export interface TranscriptBindingRecord {
  /** Deterministic project-relative path. */
  path: string;
  /** sha256 of the exact snapshotted bytes. */
  sha256: string;
  binding: "bound" | "degraded" | "unbound";
  /** Explicit per-file binding failures (empty when bound). */
  failures: readonly string[];
}

/**
 * Identity binding of ONE general transcript file against the consuming
 * project: only "bound" files (schema-valid doc, project_id exactly equal)
 * may affect geometry-affecting projections (creator-short V1/B-roll,
 * utterance snap, cut-breath, ending — and via the music file, rhythm-sync).
 */
export interface TranscriptArtifactSnapshot {
  /** Project-relative posix path of the transcript file. */
  relativePath: string;
  /** sha256 hex of the exact bytes parsed (undefined bytes never occur here). */
  sha256: string;
  /** Parsed JSON document; undefined when malformed. */
  doc: unknown;
  parseError: boolean;
  /** Per-file identity binding verdict computed at snapshot time. */
  binding: "bound" | "degraded" | "unbound";
  /** Explicit per-file binding failures (empty when bound). */
  bindingFailures: readonly string[];
}

/** The whole 03_analysis/transcripts directory, each file read EXACTLY once. */
export interface TranscriptsDirSnapshot {
  files: readonly TranscriptArtifactSnapshot[];
}

/**
 * Deterministic per-file binding records for provenance stamping (sorted by
 * path — readdir order is already deterministic).
 */
export function transcriptBindingRecords(
  transcripts: TranscriptsDirSnapshot,
): TranscriptBindingRecord[] {
  return transcripts.files.map((file) => Object.freeze({
    path: file.relativePath,
    sha256: file.sha256,
    binding: file.binding,
    failures: file.bindingFailures,
  }));
}

/**
 * Snapshot every transcript file in 03_analysis/transcripts with one
 * filesystem read per file (readdir once, read once, digest + parse from the
 * same bytes) and bind EACH file to the consuming project: missing, foreign,
 * malformed or non-schema-valid docs are stamped degraded with explicit
 * failures and must never be consumed. Compile calls this ONCE at entry;
 * consumers (utterance projections, rhythm word extraction) must use the
 * snapshot and never re-open transcript paths (Issue #35 A→B→A protection).
 */
export function snapshotTranscriptsDirectory(
  projectPath: string,
  options: { projectId?: string; repoRoot?: string } = {},
): TranscriptsDirSnapshot {
  const files: TranscriptArtifactSnapshot[] = [];
  const dir = path.join(projectPath, "03_analysis", "transcripts");
  // Canonical schema authority: explicit repoRoot, else discovery. Discovery
  // failure is fail-closed with the SAME deterministic normalized detail
  // format as read/parse/compile failures
  // (transcript_schema_authority_unavailable:<normalized-detail>) — no
  // absolute machine paths, no stacks, never a silent skip.
  let repoRoot: string | undefined = options.repoRoot;
  let authorityDetail: string | undefined;
  if (repoRoot === undefined) {
    try {
      repoRoot = findRepoRoot(path.resolve(projectPath));
    } catch (error) {
      repoRoot = undefined;
      const raw = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      authorityDetail = normalizeAuthorityDetail(raw, [path.resolve(projectPath)]);
    }
  }
  let entries: string[];
  try {
    if (!fs.existsSync(dir)) return Object.freeze({ files: Object.freeze(files) });
    entries = fs.readdirSync(dir).filter((f) => f.endsWith(".json")).sort((a, b) => a.localeCompare(b));
  } catch {
    return Object.freeze({ files: Object.freeze(files) });
  }
  for (const entry of entries) {
    const absolute = path.join(dir, entry);
    let bytes: Buffer;
    try {
      bytes = fs.readFileSync(absolute);
    } catch {
      continue; // vanished before the snapshot: nothing consumed, nothing hashed
    }
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    let doc: unknown;
    let parseError = false;
    try {
      doc = JSON.parse(bytes.toString("utf-8"));
    } catch {
      parseError = true;
    }
    // Per-file binding against the consuming project, gated by the CANONICAL
    // transcript.schema.json authority (artifact_version, transcript_ref,
    // project_id and structural item/asset requirements): schema-invalid
    // evidence is degraded with deterministic failure details and can never
    // be projected into words or utterances (Issue #35).
    const bindingFailures: string[] = [];
    let binding: TranscriptBindingRecord["binding"] = options.projectId !== undefined ? "degraded" : "unbound";
    if (parseError || !doc || typeof doc !== "object" || Array.isArray(doc)) {
      bindingFailures.push("transcript_malformed_json");
    } else if (repoRoot === undefined) {
      bindingFailures.push(`transcript_schema_authority_unavailable:${authorityDetail ?? "repository root could not be discovered"}`);
    } else {
      // Canonical authority: JSON Schema + repository semantic/path
      // invariants + supported artifact version, validated against the
      // snapshotted parsed bytes only (the path is never re-opened). An
      // unavailable authority degrades this file deterministically instead
      // of crashing the compile.
      const schemaCheck = validateTranscriptDoc(doc, {
        repoRoot,
        fileName: entry,
        requireSupportedVersion: true,
        // Consuming-project binding runs INSIDE the central authority —
        // the same complete check repository validation performs, with the
        // same deterministic failure details (no bare handwritten subset).
        expectedProjectId: options.projectId,
      });
      if (schemaCheck.status === "unavailable" || !schemaCheck.valid) {
        bindingFailures.push(...schemaCheck.failures);
      } else if (options.projectId !== undefined) {
        binding = "bound";
      }
    }
    files.push(Object.freeze({
      relativePath: toProjectRelative(projectPath, absolute),
      sha256,
      doc,
      parseError,
      binding,
      bindingFailures: Object.freeze([...bindingFailures]),
    }));
  }
  return Object.freeze({ files: Object.freeze(files) });
}

/**
 * A music-transcript consumption snapshot: the words were parsed from these
 * exact bytes, and the digest was computed from those same bytes — one read,
 * never re-opened.
 */
export interface MusicWordsSnapshot {
  /** Frozen after snapshot: treat as immutable. */
  words: ReadonlyArray<{ word: string; start_us: number; end_us: number }>;
  /** sha256 hex of the exact bytes the words were parsed from. */
  artifactSha256?: string;
  bindingFailures: string[];
}

/** Shared word extraction + fail-closed identity binding over a parsed doc. */
function wordsFromParsedTranscript(
  doc: TranscriptWordDoc,
  assetId: string,
  options: { projectId?: string; bindingFailures?: string[] },
  artifactSha256?: string,
): MusicWordsSnapshot {
  const failures = options.bindingFailures ?? [];
  if (options.projectId !== undefined) {
    // Fail-closed identity binding: required identity fields must be present
    // AND matching, or the word timestamps are not adopted.
    if (typeof doc.asset_id !== "string" || doc.asset_id.length === 0) {
      failures.push("transcript_asset_id_missing");
      return { words: [], artifactSha256, bindingFailures: failures };
    }
    if (doc.asset_id !== assetId) {
      failures.push("transcript_asset_id_mismatch");
      return { words: [], artifactSha256, bindingFailures: failures };
    }
    if (typeof doc.project_id !== "string" || doc.project_id.length === 0) {
      failures.push("transcript_project_id_missing");
      return { words: [], artifactSha256, bindingFailures: failures };
    }
    if (doc.project_id !== options.projectId) {
      failures.push("transcript_project_id_mismatch");
      return { words: [], artifactSha256, bindingFailures: failures };
    }
  } else if (doc.asset_id && doc.asset_id !== assetId) {
    return { words: [], artifactSha256, bindingFailures: failures };
  }
  const words: Array<{ word: string; start_us: number; end_us: number }> = [];
  for (const item of doc.items ?? []) {
    for (const word of item.words ?? []) {
      if (
        typeof word.start_us === "number" && Number.isInteger(word.start_us) && word.start_us >= 0 &&
        typeof word.end_us === "number" && Number.isInteger(word.end_us) && word.end_us > word.start_us &&
        typeof word.word === "string" && word.word.trim().length > 0
      ) {
        words.push({ word: word.word, start_us: word.start_us, end_us: word.end_us });
      }
    }
  }
  words.sort((a, b) => a.start_us - b.start_us || a.end_us - b.end_us);
  return { words, artifactSha256, bindingFailures: failures };
}

/**
 * Pure word projection of the immutable transcripts snapshot. Never reads a
 * path: the artifact must already carry the central authority verdict.
 * ONLY "bound" files (canonical schema + semantic/path invariants +
 * supported version + consuming project binding) are projected; every
 * unbound/degraded form — v999, foreign ref/asset/project, non-canonical
 * filename, malformed bytes, unavailable authority — yields zero words
 * with the recorded failure details for provenance.
 */
export function wordsFromTranscriptSnapshot(
  transcripts: TranscriptsDirSnapshot,
  assetId: string,
  options: { projectId?: string; bindingFailures?: string[] } = {},
): MusicWordsSnapshot {
  const artifact = transcripts.files.find(
    (file) => file.relativePath === `03_analysis/transcripts/TR_${assetId}.json`,
  );
  if (!artifact) return { words: [], bindingFailures: options.bindingFailures ?? [] };
  if (artifact.binding !== "bound") {
    const failures = options.bindingFailures ?? [];
    failures.push(...artifact.bindingFailures);
    return { words: [], artifactSha256: artifact.sha256, bindingFailures: failures };
  }
  return wordsFromParsedTranscript(artifact.doc as TranscriptWordDoc, assetId, options, artifact.sha256);
}

/**
 * Word-only projection of an ALREADY-SNAPSHOTTED transcript: the only public
 * word helper. It never reads a transcript path and never validates a
 * handwritten subset — words are admitted exclusively from files the central
 * authority marked "bound" (canonical schema + semantic/path invariants +
 * supported version + consuming project binding). Unbound/degraded evidence
 * yields zero words with the recorded failure details.
 */
export function loadMusicAssetWords(
  transcripts: TranscriptsDirSnapshot,
  assetId: string,
  options: { projectId?: string; bindingFailures?: string[] } = {},
): Array<{ word: string; start_us: number; end_us: number }> {
  return [...wordsFromTranscriptSnapshot(transcripts, assetId, options).words];
}

// ── Snap pass ───────────────────────────────────────────────────────

export interface ApplyRhythmSyncOptions {
  mode: RhythmSyncMode;
  grid: RhythmEventGrid;
  fpsNum: number;
  /** Frame-rate denominator (fps = fpsNum/fpsDen); required for rational time math. */
  fpsDen: number;
  searchWindowSec: number;
  maxShiftFrames: number;
  /** Minimum confidence for measured onset/section/downbeat candidates. */
  minCueConfidence?: number;
  parityMaxOffsetFrames: number;
  minDurationFrames: number;
  /** "enforce" (default): a chorus parity fail is surfaced for the compile gate. */
  parityGate: "enforce" | "off";
  /**
   * Known source media durations (µs) by asset id, from 03_analysis/assets.json.
   * Extensions of a clip's src_out_us are bounded by these values; unknown
   * durations fail open with an explicit skip.
   */
  sourceDurations?: Map<string, number>;
}

/**
 * Read per-asset source media durations (µs) from 03_analysis/assets.json.
 * Missing or malformed entries are skipped (fail-open); callers treat an
 * unknown duration as unverifiable for src_out extensions.
 */
export function loadSourceDurationsFromProject(projectPath: string): Map<string, number> {
  const durations = new Map<string, number>();
  const assetsPath = path.join(projectPath, "03_analysis", "assets.json");
  if (!fs.existsSync(assetsPath)) return durations;
  try {
    const doc = JSON.parse(fs.readFileSync(assetsPath, "utf-8")) as {
      items?: Array<{ asset_id?: string; duration_us?: number }>;
    };
    for (const item of doc.items ?? []) {
      if (
        typeof item.asset_id === "string" && item.asset_id.length > 0 &&
        typeof item.duration_us === "number" && Number.isFinite(item.duration_us) && item.duration_us > 0
      ) {
        durations.set(item.asset_id, item.duration_us);
      }
    }
  } catch {
    return durations;
  }
  return durations;
}

/**
 * Snap canonical cut boundaries onto rhythm events and run the parity gate.
 * Mutates clip geometry in place (pair-preserving) and returns the canonical
 * metadata stamped into timeline.metadata.rhythm_sync.
 *
 * Scope: only the primary V1 video track is snap-selected and parity-measured.
 * Overlay/secondary video tracks are never moved and never used as parity
 * evidence (secondary-track cuts near a section start must not fake
 * alignment of the program cut).
 */
export function applyRhythmSyncSnaps(
  assembled: import("./types.js").AssembledTimeline,
  options: ApplyRhythmSyncOptions,
): RhythmSyncCompileMetadata {
  const base = {
    version: "1" as const,
    mode: options.mode,
    search_window_sec: options.searchWindowSec,
    max_shift_frames: options.maxShiftFrames,
    parity_max_offset_frames: options.parityMaxOffsetFrames,
    parity_gate: options.parityGate,
    min_cue_confidence: boundedConfidence(options.minCueConfidence) ?? DEFAULT_MIN_CUE_CONFIDENCE,
    fps_num: options.fpsNum,
    fps_den: options.fpsDen,
    ...(options.grid.evidence ? { evidence_provenance: options.grid.evidence } : {}),
    sources: options.grid.sources,
  };

  if (options.mode === "off") {
    return {
      ...base,
      enabled: false,
      status: "disabled",
      disabled_reason: "configured_off",
      degraded_reasons: [],
      snaps: [],
      parity: { status: "degraded", max_offset_frames: options.parityMaxOffsetFrames, sections: [] },
      integrity: { gap_frames: 0, overrun_frames: 0, boundary_count: 0, verified: false },
      counts: emptyCounts(),
    };
  }

  const hasEvents = options.grid.events.length > 0;
  if (!hasEvents) {
    return {
      ...base,
      enabled: false,
      status: "degraded",
      disabled_reason: "no_rhythm_events",
      degraded_reasons: [...options.grid.degraded_reasons],
      snaps: [],
      parity: { status: "degraded", max_offset_frames: options.parityMaxOffsetFrames, sections: [] },
      integrity: { gap_frames: 0, overrun_frames: 0, boundary_count: 0, verified: false },
      counts: emptyCounts(),
    };
  }

  const windowFrames = Math.max(0, secondsToRhythmFrame(options.searchWindowSec, options.fpsNum, options.fpsDen));
  const minCueConfidence = boundedConfidence(options.minCueConfidence) ?? DEFAULT_MIN_CUE_CONFIDENCE;
  const snaps: RhythmSyncBoundaryResult[] = [];
  const paritySections: RhythmSectionParity[] = [];
  const degradedReasons = new Set(options.grid.degraded_reasons);
  const consumedBoundaryIds = new Set<string>();
  const touchedBeatIds = new Set<string>();
  const counts = emptyCounts();

  // Track boundary geometry accessor: adjacent flush clip pairs on a track.
  const readBoundaries = (track: Track): BoundaryRef[] => {
    const clips = [...track.clips].sort((a, b) =>
      a.timeline_in_frame - b.timeline_in_frame || a.clip_id.localeCompare(b.clip_id),
    );
    const boundaries: BoundaryRef[] = [];
    for (let i = 0; i < clips.length - 1; i += 1) {
      const left = clips[i];
      const right = clips[i + 1];
      const cutFrame = left.timeline_in_frame + left.timeline_duration_frames;
      if (cutFrame !== right.timeline_in_frame) continue;
      boundaries.push({ track, left, right, cutFrame, id: `${left.clip_id}->${right.clip_id}` });
    }
    return boundaries;
  };

  const tracks = assembled.tracks.video;
  const primaryTrack = tracks.find((track) => track.track_id === "V1") ?? tracks[0];
  // Primary program track only (V1): snap selection, shifts, parity, integrity.
  const primaryTracks: Track[] = primaryTrack ? [primaryTrack] : [];
  const initialIntegrity = measureTimelineIntegrity(primaryTrack ? [primaryTrack] : []);
  const initialIntegritySafe = initialIntegrity.gap_frames === 0 && initialIntegrity.overrun_frames === 0;
  if (!initialIntegritySafe) degradedReasons.add("timeline_integrity_precondition_failed");
  if (options.grid.events.length > 0 && !options.grid.events.some((event) => isSupportedRhythmEvent(event, minCueConfidence))) {
    degradedReasons.add("no_supported_rhythm_cues");
  }

  const applyGuardsAndShift = (
    track: Track,
    left: TimelineClip,
    right: TimelineClip,
    target: RhythmEvent,
    cutFrame: number,
    sectionSnap: boolean,
    hardSnap: boolean,
    toleranceFrames: number,
    sectionId?: string,
    sectionLabel?: string,
  ): RhythmSyncBoundaryResult => {
    const delta = target.frame - cutFrame;
    const baseResult = {
      track_id: track.track_id,
      left_clip_id: left.clip_id,
      right_clip_id: right.clip_id,
      right_beat_id: right.beat_id,
      cut_frame_before: cutFrame,
      target_frame: target.frame,
      target_kind: target.kind,
      ...(target.word ? { target_word: target.word } : {}),
      target_provenance: eventProvenance(target),
      ...(eventConfidence(target) !== undefined ? { target_confidence: eventConfidence(target) } : {}),
      tolerance_frames: toleranceFrames,
      ...(sectionId ? { section_id: sectionId } : {}),
      ...(sectionLabel ? { section_label: sectionLabel } : {}),
      section_snap: sectionSnap,
      hard_snap: hardSnap,
      shift_frames: delta,
    };
    const record = (
      status: "unchanged" | "skipped",
      reason: string,
      skipReason?: RhythmSyncSkipReason,
    ): RhythmSyncBoundaryResult => ({
      ...baseResult,
      cut_frame_after: cutFrame,
      status,
      decision: "retained",
      reason,
      ...(skipReason ? { skip_reason: skipReason } : {}),
    });

    if (isRhythmBoundaryLocked(left) || isRhythmBoundaryLocked(right)) {
      counts.skipped += 1;
      counts.skipped_locked_boundary += 1;
      return record("skipped", "locked_boundary", "locked_boundary");
    }
    if (!initialIntegritySafe || hasNeighborCollision(track, left, right, target.frame)) {
      counts.skipped += 1;
      counts.skipped_neighbor_collision += 1;
      return record("skipped", "neighbor_collision", "neighbor_collision");
    }
    if (left.media_kind === "image" || right.media_kind === "image") {
      counts.skipped += 1;
      counts.skipped_still_image += 1;
      return record("skipped", "still_image_boundary", "still_image_boundary");
    }
    if (isSpeechProtectedBeatBoundary(left, right)) {
      counts.skipped += 1;
      counts.skipped_speech_protected += 1;
      return record("skipped", "speech_protected", "speech_protected");
    }
    if (!sectionSnap && Math.abs(delta) > options.maxShiftFrames) {
      counts.skipped += 1;
      counts.skipped_max_shift += 1;
      return record("skipped", "max_shift_exceeded", "max_shift_exceeded");
    }
    if (!isSupportedRhythmEvent(target, minCueConfidence)) {
      counts.skipped += 1;
      counts.skipped_no_event += 1;
      return record("skipped", "no_cue_within_tolerance", "no_event_in_window");
    }
    if (delta !== 0 && !canApplyBoundaryShift(left, right, delta, options.minDurationFrames)) {
      counts.skipped += 1;
      counts.skipped_min_duration += 1;
      return record("skipped", "min_duration", "min_duration");
    }
    const deltaUs = rhythmFramesToUs(delta, options.fpsNum, options.fpsDen);
    if (delta < 0 && right.src_in_us + deltaUs < 0) {
      counts.skipped += 1;
      counts.skipped_source_range += 1;
      return record("skipped", "source_range_exceeded", "source_range_exceeded");
    }
    // Positive source-out bound: extending the left clip past the end of its
    // source media would render unplayable frames. Unknown durations cannot
    // be verified, so the extension fails open with an explicit skip.
    if (delta > 0) {
      const durationUs = options.sourceDurations?.get(left.asset_id);
      if (durationUs === undefined || left.src_out_us + deltaUs > durationUs) {
        degradedReasons.add(
          durationUs === undefined
            ? "source_duration_unknown:" + left.asset_id
            : "source_out_exceeds_media:" + left.asset_id,
        );
        counts.skipped += 1;
        counts.skipped_source_range += 1;
        return record("skipped", "source_range_exceeded", "source_range_exceeded");
      }
    }
    if (delta === 0) {
      counts.unchanged += 1;
      return record("unchanged", "already_aligned");
    }

    applyBoundaryShift(left, right, delta, options.fpsNum, options.fpsDen);
    counts.snapped += 1;
    if (hardSnap) counts.hard_snapped += 1;
    if (sectionSnap) counts.section_snapped += 1;
    touchedBeatIds.add(right.beat_id);
    return {
      ...baseResult,
      cut_frame_after: target.frame,
      status: "snapped",
      decision: "snap_applied",
      reason: "selected_cue_within_tolerance",
    };
  };

  const recordWithoutCue = (
    boundary: BoundaryRef,
    toleranceFrames: number,
    sectionSnap: boolean,
    hardSnap: boolean,
    sectionId?: string,
    sectionLabel?: string,
  ): RhythmSyncBoundaryResult => {
    counts.skipped += 1;
    counts.skipped_no_event += 1;
    return {
      track_id: boundary.track.track_id,
      left_clip_id: boundary.left.clip_id,
      right_clip_id: boundary.right.clip_id,
      right_beat_id: boundary.right.beat_id,
      cut_frame_before: boundary.cutFrame,
      cut_frame_after: boundary.cutFrame,
      tolerance_frames: toleranceFrames,
      section_snap: sectionSnap,
      hard_snap: hardSnap,
      shift_frames: 0,
      status: "skipped",
      skip_reason: "no_event_in_window",
      decision: "retained",
      reason: "no_cue_within_tolerance",
      ...(sectionId ? { section_id: sectionId } : {}),
      ...(sectionLabel ? { section_label: sectionLabel } : {}),
    };
  };

  const recordRejectedCandidate = (
    boundary: BoundaryRef,
    target: RhythmEvent,
    toleranceFrames: number,
    sectionSnap: boolean,
    hardSnap: boolean,
    rejection: RhythmSyncRejectionReason,
    sectionId?: string,
    sectionLabel?: string,
  ): RhythmSyncBoundaryResult => {
    counts.skipped += 1;
    counts.skipped_no_event += 1;
    return {
      track_id: boundary.track.track_id,
      left_clip_id: boundary.left.clip_id,
      right_clip_id: boundary.right.clip_id,
      right_beat_id: boundary.right.beat_id,
      cut_frame_before: boundary.cutFrame,
      cut_frame_after: boundary.cutFrame,
      target_frame: target.frame,
      target_kind: target.kind,
      ...(target.word ? { target_word: target.word } : {}),
      target_provenance: eventProvenance(target),
      target_confidence: eventConfidence(target) ?? null,
      tolerance_frames: toleranceFrames,
      section_snap: sectionSnap,
      hard_snap: hardSnap,
      shift_frames: target.frame - boundary.cutFrame,
      status: "skipped",
      skip_reason: rejection,
      decision: "rejected",
      reason: rejection === "low_confidence" ? "low_confidence_below_threshold" : rejection,
      ...(sectionId ? { section_id: sectionId } : {}),
      ...(sectionLabel ? { section_label: sectionLabel } : {}),
    };
  };

  // ── Pass 1: section-start snaps (chorus Hard Snap, break/bridge) ────
  for (const section of options.grid.majorSections) {
    const target = selectSectionTargetEvent(options.grid, section, windowFrames, minCueConfidence);
    if (!target) {
      const rejected = selectRejectedSectionCandidate(options.grid, section, windowFrames, minCueConfidence);
      // A cue just outside the section tolerance can still have a nearby
      // boundary (for example, cue and cut both at section_start + 46f).
      // Claim that boundary in the section pass so Pass 2 cannot downgrade
      // the receipt to a generic 12-frame boundary decision.
      const boundary = nearestBoundaryToFrame(readBoundaries, primaryTracks, section.start_frame, windowFrames, consumedBoundaryIds) ??
        (rejected
          ? nearestBoundaryToFrame(readBoundaries, primaryTracks, rejected.event.frame, windowFrames, consumedBoundaryIds)
          : undefined);
      if (boundary) {
        consumedBoundaryIds.add(boundary.id);
        snaps.push(rejected
          ? recordRejectedCandidate(
              boundary,
              rejected.event,
              windowFrames,
              true,
              section.hard_snap,
              rejected.reason,
              section.id,
              section.label,
            )
          : recordWithoutCue(
              boundary,
              windowFrames,
              true,
              section.hard_snap,
              section.id,
              section.label,
            ));
      } else {
        counts.skipped += 1;
        counts.skipped_no_event += 1;
      }
      paritySections.push({
        section_id: section.id,
        label: section.label,
        hard_snap: section.hard_snap,
        section_start_frame: section.start_frame,
        status: "degraded",
        reason: "no_rhythm_event_at_section_start",
      });
      degradedReasons.add("section_start_unverified:" + section.id);
      continue;
    }
    // Record the section with its target; recomputeRhythmParityAndIntegrity
    // measures the acceptance offset against section_start_frame below.
    paritySections.push({
      section_id: section.id,
      label: section.label,
      hard_snap: section.hard_snap,
      section_start_frame: section.start_frame,
      target_frame: target.frame,
      target_kind: target.kind,
      ...(target.word ? { target_word: target.word } : {}),
      target_provenance: eventProvenance(target),
      ...(eventConfidence(target) !== undefined ? { target_confidence: eventConfidence(target) } : {}),
      target_offset_frames: Math.abs(target.frame - section.start_frame),
      status: "degraded",
    });

    const boundary = nearestBoundaryToFrame(readBoundaries, primaryTracks, target.frame, windowFrames, consumedBoundaryIds);
    if (!boundary) {
      // No cut to align within the search window: nothing to snap, but the
      // parity gate below still evaluates the section offset honestly.
      degradedReasons.add("section_no_boundary_in_window:" + section.id);
      counts.skipped += 1;
      counts.skipped_no_event += 1;
      continue;
    }

    consumedBoundaryIds.add(boundary.id);
    const result = applyGuardsAndShift(
      boundary.track,
      boundary.left,
      boundary.right,
      target,
      boundary.cutFrame,
      true,
      section.hard_snap,
      windowFrames,
      section.id,
      section.label,
    );
    snaps.push(result);
    if (result.status === "skipped") {
      degradedReasons.add("section_snap_skipped:" + section.id + ":" + result.skip_reason);
    }
  }

  // ── Pass 2: remaining primary boundaries → nearest event within max_shift ──
  for (const track of primaryTracks) {
    for (const boundary of readBoundaries(track)) {
      if (consumedBoundaryIds.has(boundary.id)) continue;
      const target = nearestEventToFrame(options.grid.events, boundary.cutFrame, options.maxShiftFrames, minCueConfidence);
      if (!target) {
        const rejected = selectRejectedCandidate(options.grid.events, boundary.cutFrame, options.maxShiftFrames, minCueConfidence);
        snaps.push(rejected
          ? recordRejectedCandidate(
              boundary,
              rejected.event,
              options.maxShiftFrames,
              false,
              false,
              rejected.reason,
            )
          : recordWithoutCue(boundary, options.maxShiftFrames, false, false));
        continue;
      }
      snaps.push(applyGuardsAndShift(
        track,
        boundary.left,
        boundary.right,
        target,
        boundary.cutFrame,
        false,
        false,
        options.maxShiftFrames,
      ));
    }
  }

  // ── Beat markers follow snapped geometry (canonical marker truth) ──
  if (touchedBeatIds.size > 0 && primaryTrack) {
    const startFrameByBeat = new Map<string, number>();
    for (const clip of primaryTrack.clips) {
      if (!touchedBeatIds.has(clip.beat_id)) continue;
      const current = startFrameByBeat.get(clip.beat_id);
      startFrameByBeat.set(clip.beat_id, current === undefined ? clip.timeline_in_frame : Math.min(current, clip.timeline_in_frame));
    }
    for (const marker of assembled.markers) {
      if (marker.kind !== "beat") continue;
      const beatId = marker.label.split(":")[0]?.trim();
      if (!beatId || !touchedBeatIds.has(beatId)) continue;
      const newFrame = startFrameByBeat.get(beatId);
      if (newFrame !== undefined) marker.frame = newFrame;
    }
  }

  const metadata: RhythmSyncCompileMetadata = {
    ...base,
    enabled: true,
    status: counts.snapped > 0 ? "applied" : "degraded",
    degraded_reasons: [],
    snaps,
    parity: {
      status: "degraded",
      max_offset_frames: options.parityMaxOffsetFrames,
      sections: paritySections,
    },
    integrity: { gap_frames: 0, overrun_frames: 0, boundary_count: 0, verified: false },
    counts,
  };
  recomputeRhythmParityAndIntegrity(metadata, assembled);
  metadata.degraded_reasons = [...degradedReasons].sort();
  if (metadata.status === "degraded") {
    metadata.degraded_reasons.push("no_snaps_applied");
    metadata.degraded_reasons.sort();
  }
  return metadata;
}

/**
 * Structural geometry view consumed by the parity recompute. Both the
 * assembled timeline and the compiled TimelineIR (post review patch)
 * satisfy it, so the recompute can run after ANY geometry mutation.
 */
export interface RhythmParityGeometry {
  tracks: {
    video: Array<{
      track_id: string;
      clips: Array<{ clip_id: string; timeline_in_frame: number; timeline_duration_frames: number }>;
    }>;
  };
}

/**
 * Re-measure section parity (against the actual section start frame) and the
 * Gap 0f / Overrun 0f integrity from the CURRENT primary V1 geometry.
 *
 * Compile calls this after post-snap geometry passes (apex freeze holds ripple
 * later clip positions; review patches, cut-breath and ending treatments move
 * cuts) so the stamped parity contract reflects the final timeline, not a
 * pre-ripple snapshot. Sections without rhythm evidence stay degraded;
 * measured statuses are recomputed honestly.
 */
export function recomputeRhythmParityAndIntegrity(
  metadata: RhythmSyncCompileMetadata,
  assembled: RhythmParityGeometry,
): void {
  const videoTracks = assembled.tracks.video;
  const primaryTrack = videoTracks.find((track) => track.track_id === "V1") ?? videoTracks[0];
  const primaryClips = primaryTrack
    ? [...primaryTrack.clips].sort((a, b) =>
        a.timeline_in_frame - b.timeline_in_frame || a.clip_id.localeCompare(b.clip_id),
      )
    : [];
  const cutFrames: number[] = [];
  for (let i = 0; i < primaryClips.length - 1; i += 1) {
    cutFrames.push(primaryClips[i].timeline_in_frame + primaryClips[i].timeline_duration_frames);
  }

  for (const entry of metadata.parity.sections) {
    if (entry.status === "degraded" && entry.reason === "no_rhythm_event_at_section_start") {
      continue; // no rhythm evidence: cannot measure, stays degraded
    }
    const nearestCut = cutFrames.length > 0
      ? cutFrames.reduce((best, frame) =>
          Math.abs(frame - entry.section_start_frame) < Math.abs(best - entry.section_start_frame) ? frame : best,
        )
      : undefined;
    const offset = nearestCut === undefined
      ? undefined
      : Math.abs(nearestCut - entry.section_start_frame);
    const status: RhythmParityStatus = offset === undefined
      ? "degraded"
      : offset < metadata.parity.max_offset_frames
        ? "pass"
        : entry.hard_snap ? "fail" : "warning";
    entry.cut_frame = nearestCut;
    entry.offset_frames = offset;
    entry.status = status;
    entry.reason = offset === undefined
      ? "no_primary_boundary"
      : status === "pass"
        ? undefined
        : `section_start_offset_${offset}f_exceeds_${metadata.parity.max_offset_frames}f_parity_window`;
  }

  const checked = metadata.parity.sections.filter((entry) => entry.status !== "degraded");
  metadata.parity.status = checked.some((entry) => entry.status === "fail")
    ? "fail"
    : checked.some((entry) => entry.status === "warning")
      ? "warning"
      : checked.length > 0
        ? "pass"
        : "degraded";

  const integrity = measureTimelineIntegrity(primaryTrack ? [primaryTrack] : []);
  metadata.integrity = {
    ...integrity,
    verified: integrity.gap_frames === 0 && integrity.overrun_frames === 0,
  };
  metadata.parity_recomputed_after_geometry_passes = true;
}

/**
 * Recompute parity/integrity for the rhythm metadata attached to a timeline
 * and, when the gate is "enforce", block on any chorus parity failure.
 *
 * Call after EVERY geometry mutation that can move primary V1 cuts — apex
 * freeze holds, review patches (in-process opts.reviewPatch and the
 * scripts/compile-timeline patch route), cut-breath and ending treatments —
 * so the final stamped metadata reflects the final V1 cuts.
 *
 * Returns the same metadata instance (recomputed in place); undefined when
 * rhythm sync is not enabled (nothing to recompute, nothing to enforce).
 */
export function recomputeAndEnforceRhythmSync(
  geometry: RhythmParityGeometry,
  metadata: RhythmSyncCompileMetadata | undefined,
  parityGate: "enforce" | "off",
): RhythmSyncCompileMetadata | undefined {
  if (!metadata || metadata.enabled !== true) return metadata;
  recomputeRhythmParityAndIntegrity(metadata, geometry);
  // Stamp the gate decision actually in force for this promotion — a patch
  // route with the documented "off" opt-out must not keep the base compile's
  // "enforce" stamp.
  metadata.parity_gate = parityGate;
  if (parityGate === "enforce") {
    const gateFailures = metadata.parity.sections
      .filter((section) => section.hard_snap && section.status === "fail")
      .map((section) => ({
        section_id: section.section_id,
        label: section.label,
        section_start_frame: section.section_start_frame,
        ...(section.cut_frame !== undefined ? { cut_frame: section.cut_frame } : {}),
        ...(section.offset_frames !== undefined ? { offset_frames: section.offset_frames } : {}),
        parity_max_offset_frames: metadata.parity.max_offset_frames,
      }));
    if (gateFailures.length > 0) {
      throw new RhythmParityGateError(gateFailures);
    }
  }
  return metadata;
}

function emptyCounts(): RhythmSyncCompileMetadata["counts"] {
  return {
    snapped: 0,
    hard_snapped: 0,
    section_snapped: 0,
    unchanged: 0,
    skipped: 0,
    skipped_speech_protected: 0,
    skipped_still_image: 0,
    skipped_min_duration: 0,
    skipped_source_range: 0,
    skipped_max_shift: 0,
    skipped_no_event: 0,
    skipped_locked_boundary: 0,
    skipped_neighbor_collision: 0,
  };
}

/**
 * Pick a section target using the close-readiness priority contract:
 * authored lyric line/phrase onset, transcript word onset, strong measured
 * onset/section cue, then a sufficiently confident downbeat. Unsupported
 * low-confidence cues are never used as a last-resort target.
 */
function selectSectionTargetEvent(
  grid: RhythmEventGrid,
  section: RhythmEventGrid["majorSections"][number],
  windowFrames: number,
  minCueConfidence: number,
): RhythmEvent | undefined {
  const inWindow = sectionCandidateEvents(grid, section)
    .filter((event) => Math.abs(event.frame - section.start_frame) <= windowFrames);
  const lyricCandidates = inWindow.filter((event) =>
    event.kind === "word_start",
  );
  const authored = lyricCandidates.filter((event) => eventProvenance(event) === "authored_lyric");
  if (authored.length > 0) {
    return selectPrioritizedEvent(authored, section.start_frame, windowFrames, minCueConfidence);
  }
  if (lyricCandidates.length > 0) {
    return selectPrioritizedEvent(lyricCandidates, section.start_frame, windowFrames, minCueConfidence);
  }

  const measured = inWindow.filter((event) => event.kind === "onset" || event.kind === "section_start");
  const strongMeasured = selectPrioritizedEvent(measured, section.start_frame, windowFrames, minCueConfidence);
  if (strongMeasured) return strongMeasured;
  return nearestEventOfKind(inWindow, section.start_frame, windowFrames, "downbeat", minCueConfidence);
}

function sectionCandidateEvents(
  grid: RhythmEventGrid,
  section: RhythmEventGrid["majorSections"][number],
): RhythmEvent[] {
  return grid.events.filter((event) => {
    const withinSection =
      (event.section_id === undefined && event.section_label === undefined) ||
      event.section_id === section.id || event.section_label === section.label;
    if (!withinSection) return false;
    // A Hard Snap must not use a word that starts before the authored section;
    // measured events retain their normal section-window eligibility.
    return !section.hard_snap || event.kind !== "word_start" || event.frame >= section.start_frame;
  });
}

interface RejectedRhythmCandidate {
  event: RhythmEvent;
  reason: RhythmSyncRejectionReason;
}

function selectRejectedSectionCandidate(
  grid: RhythmEventGrid,
  section: RhythmEventGrid["majorSections"][number],
  windowFrames: number,
  minCueConfidence: number,
): RejectedRhythmCandidate | undefined {
  const candidates = sectionCandidateEvents(grid, section);
  const rejectedInWindow = prioritizeEvents(
    candidates
      .filter((event) => Math.abs(event.frame - section.start_frame) <= windowFrames)
      .filter((event) => !isSupportedRhythmEvent(event, minCueConfidence)),
    section.start_frame,
  )[0];
  if (rejectedInWindow) {
    return { event: rejectedInWindow, reason: rejectionReasonForEvent(rejectedInWindow, minCueConfidence) };
  }
  const outside = prioritizeEvents(
    candidates.filter((event) => Math.abs(event.frame - section.start_frame) > windowFrames),
    section.start_frame,
  )[0];
  return outside ? { event: outside, reason: "outside_tolerance" } : undefined;
}

function selectRejectedCandidate(
  events: RhythmEvent[],
  frame: number,
  windowFrames: number,
  minCueConfidence: number,
): RejectedRhythmCandidate | undefined {
  const rejectedInWindow = prioritizeEvents(
    events
      .filter((event) => Math.abs(event.frame - frame) <= windowFrames)
      .filter((event) => !isSupportedRhythmEvent(event, minCueConfidence)),
    frame,
  )[0];
  if (rejectedInWindow) {
    return { event: rejectedInWindow, reason: rejectionReasonForEvent(rejectedInWindow, minCueConfidence) };
  }
  const outside = prioritizeEvents(
    events.filter((event) => Math.abs(event.frame - frame) > windowFrames),
    frame,
  )[0];
  return outside ? { event: outside, reason: "outside_tolerance" } : undefined;
}

function nearestEventOfKind(
  events: RhythmEvent[],
  frame: number,
  windowFrames: number,
  kind: RhythmEventKind,
  minCueConfidence = DEFAULT_MIN_CUE_CONFIDENCE,
): RhythmEvent | undefined {
  return nearestEventToFrame(events.filter((event) => event.kind === kind), frame, windowFrames, minCueConfidence);
}

function nearestEventToFrame(
  events: RhythmEvent[],
  frame: number,
  windowFrames: number,
  minCueConfidence = DEFAULT_MIN_CUE_CONFIDENCE,
): RhythmEvent | undefined {
  return selectPrioritizedEvent(events, frame, windowFrames, minCueConfidence);
}

function selectPrioritizedEvent(
  events: RhythmEvent[],
  frame: number,
  windowFrames: number,
  minCueConfidence: number,
): RhythmEvent | undefined {
  return prioritizeEvents(
    events
    .filter((event) => Math.abs(event.frame - frame) <= windowFrames)
    .filter((event) => isSupportedRhythmEvent(event, minCueConfidence)),
    frame,
  )[0];
}

function prioritizeEvents(events: RhythmEvent[], frame: number): RhythmEvent[] {
  return events.sort((a, b) =>
      eventCandidateTier(a) - eventCandidateTier(b) ||
      Math.abs(a.frame - frame) - Math.abs(b.frame - frame) ||
      a.frame - b.frame ||
      eventKindPriority(b.kind) - eventKindPriority(a.kind) ||
      eventProvenance(a).localeCompare(eventProvenance(b)) ||
      (a.word ?? "").localeCompare(b.word ?? ""),
    );
}

function rejectionReasonForEvent(event: RhythmEvent, minCueConfidence: number): RhythmSyncRejectionReason {
  const confidence = eventConfidence(event);
  return confidence !== undefined && confidence < minCueConfidence
    ? "low_confidence"
    : "admission_rejected";
}

function isSupportedRhythmEvent(event: RhythmEvent, minCueConfidence: number): boolean {
  const confidence = eventConfidence(event);
  return confidence !== undefined && confidence >= minCueConfidence;
}

interface BoundaryRef {
  track: Track;
  left: TimelineClip;
  right: TimelineClip;
  cutFrame: number;
  id: string;
}

function nearestBoundaryToFrame(
  readBoundaries: (track: Track) => BoundaryRef[],
  tracks: Track[],
  frame: number,
  windowFrames: number,
  consumed: Set<string> | undefined,
): BoundaryRef | undefined {
  let best: BoundaryRef | undefined;
  let bestDist = Infinity;
  for (const track of tracks) {
    for (const boundary of readBoundaries(track)) {
      if (consumed?.has(boundary.id)) continue;
      const dist = Math.abs(boundary.cutFrame - frame);
      if (dist > windowFrames) continue;
      if (dist < bestDist || (dist === bestDist && best !== undefined && boundary.cutFrame < best.cutFrame)) {
        best = boundary;
        bestDist = dist;
      }
    }
  }
  return best;
}

function isRhythmBoundaryLocked(clip: TimelineClip): boolean {
  const metadata = clip.metadata;
  if (!metadata) return false;
  if (metadata.locked === true || metadata.boundary_locked === true ||
    metadata.lock_boundary === true || metadata.preserve_boundary === true ||
    metadata.rhythm_sync_locked === true) return true;
  const rhythm = metadata.rhythm_sync;
  return !!rhythm && typeof rhythm === "object" && !Array.isArray(rhythm) &&
    ((rhythm as Record<string, unknown>).locked === true ||
      (rhythm as Record<string, unknown>).boundary_locked === true);
}

/**
 * A pair-preserving shift must not be used on an already colliding topology
 * or on a target that would leave the left/right pair outside its neighbors.
 * The normal flush path therefore remains unchanged, while malformed or
 * colliding input fails closed with a separately counted reason.
 */
function hasNeighborCollision(
  track: Track,
  left: TimelineClip,
  right: TimelineClip,
  targetFrame: number,
): boolean {
  const clips = [...track.clips].sort((a, b) =>
    a.timeline_in_frame - b.timeline_in_frame || a.clip_id.localeCompare(b.clip_id),
  );
  const leftIndex = clips.findIndex((clip) => clip.clip_id === left.clip_id);
  const rightIndex = clips.findIndex((clip) => clip.clip_id === right.clip_id);
  if (leftIndex < 0 || rightIndex !== leftIndex + 1) return true;
  const leftStart = left.timeline_in_frame;
  const rightEnd = right.timeline_in_frame + right.timeline_duration_frames;
  if (targetFrame < leftStart || targetFrame > rightEnd) return true;
  const previous = clips[leftIndex - 1];
  if (previous && previous.timeline_in_frame + previous.timeline_duration_frames > leftStart) return true;
  const next = clips[rightIndex + 1];
  if (next && rightEnd > next.timeline_in_frame) return true;
  return false;
}

/**
 * Pair-preserving duration guard: shifting the cut must keep both clips at
 * least minDurationFrames long.
 */
function canApplyBoundaryShift(
  left: TimelineClip,
  right: TimelineClip,
  delta: number,
  minDurationFrames: number,
): boolean {
  const minFrames = Math.max(1, Math.floor(minDurationFrames));
  if (delta > 0) return right.timeline_duration_frames - delta >= minFrames;
  return left.timeline_duration_frames + delta >= minFrames;
}

/**
 * Sweep every video track for holes (gaps) and overhangs (overruns) between
 * consecutive clips. Pair-preserving snapping must keep both at 0 (AC2).
 */
export function measureTimelineIntegrity(tracks: RhythmParityGeometry["tracks"]["video"]): {
  gap_frames: number;
  overrun_frames: number;
  boundary_count: number;
} {
  let gapFrames = 0;
  let overrunFrames = 0;
  let boundaryCount = 0;
  for (const track of tracks) {
    const clips = [...track.clips].sort((a, b) =>
      a.timeline_in_frame - b.timeline_in_frame || a.clip_id.localeCompare(b.clip_id),
    );
    for (let i = 0; i < clips.length - 1; i += 1) {
      const leftEnd = clips[i].timeline_in_frame + clips[i].timeline_duration_frames;
      const rightStart = clips[i + 1].timeline_in_frame;
      if (rightStart > leftEnd) gapFrames += rightStart - leftEnd;
      else if (leftEnd > rightStart) overrunFrames += leftEnd - rightStart;
      boundaryCount += 1;
    }
  }
  return { gap_frames: gapFrames, overrun_frames: overrunFrames, boundary_count: boundaryCount };
}
