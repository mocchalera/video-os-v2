/** Typed compile failures that must never be represented as an implicit gap. */

import type { PrimaryAudioGap, PrimaryVideoGap } from "./coverage.js";
import type { IntentionalGapOperation } from "./types.js";

/** A chorus (hard-snap) section whose post-snap parity measurement failed. */
export interface RhythmParityGateFailure {
  section_id: string;
  label: string;
  section_start_frame: number;
  cut_frame?: number;
  offset_frames?: number;
  parity_max_offset_frames: number;
}

/**
 * Blocking parity gate failure (Issue #35): a chorus section start does not
 * align with the nearest primary V1 cut within parity_max_offset_frames after
 * snapping and post-snap geometry passes. The canonical compile is blocked;
 * the documented opt-out is `rhythm_sync.parity_gate: "off"` in the compiler
 * defaults.
 */
export class RhythmParityGateError extends Error {
  readonly code = "RHYTHM_PARITY_GATE" as const;
  readonly failures: RhythmParityGateFailure[];

  constructor(failures: RhythmParityGateFailure[]) {
    super(
      `Rhythm parity gate failed for ${failures.length} chorus section(s): ` +
        failures.map((failure) =>
          `${failure.section_id}(${failure.label}) start=${failure.section_start_frame}f ` +
          `cut=${failure.cut_frame ?? "<none>"}f offset=${failure.offset_frames ?? "<unmeasured>"}f ` +
          `> ${failure.parity_max_offset_frames}f window`,
        ).join("; ") +
        `. Opt out explicitly with rhythm_sync.parity_gate: "off" in compiler defaults.`,
    );
    this.name = "RhythmParityGateError";
    this.failures = failures;
  }
}

export interface InsufficientContentDetails {
  target_frames: number;
  available_frames: number;
  shortfall_frames: number;
  reason: "source_duration" | "approved_range" | "renderable_content";
  beat_id?: string;
}

export class InsufficientContentError extends Error {
  readonly code = "INSUFFICIENT_CONTENT" as const;
  readonly details: InsufficientContentDetails;

  constructor(details: InsufficientContentDetails) {
    super(
      `Insufficient content for strict compile: available ${details.available_frames}f ` +
        `of ${details.target_frames}f (shortfall ${details.shortfall_frames}f); ` +
        `reason=${details.reason}${details.beat_id ? ` beat=${details.beat_id}` : ""}`,
    );
    this.name = "InsufficientContentError";
    this.details = details;
  }
}

export class GapFreeTimelineError extends Error {
  readonly code = "PRIMARY_VIDEO_GAP" as const;
  readonly gaps: PrimaryVideoGap[];

  constructor(gaps: PrimaryVideoGap[]) {
    super(`Primary video coverage invariant failed: ${formatPrimaryGaps(gaps)}`);
    this.name = "GapFreeTimelineError";
    this.gaps = gaps;
  }
}

export class PrimaryAudioGapError extends Error {
  readonly code = "PRIMARY_AUDIO_GAP" as const;
  readonly gaps: PrimaryAudioGap[];

  constructor(gaps: PrimaryAudioGap[]) {
    super(`Primary audio coverage invariant failed: ${formatPrimaryGaps(gaps)}`);
    this.name = "PrimaryAudioGapError";
    this.gaps = gaps;
  }
}

function formatPrimaryGaps(
  gaps: Array<Pick<PrimaryVideoGap, "track_id" | "start_frame" | "end_frame" | "duration_frames" | "previous_clip" | "next_clip" | "previous_beat_id" | "next_beat_id" | "recommended_fix">>,
): string {
  return gaps.map((gap) => {
    const previous = gap.previous_clip?.clip_id ?? "<start>";
    const next = gap.next_clip?.clip_id ?? "<end>";
    const beats = [gap.previous_beat_id, gap.next_beat_id].filter(Boolean).join(" -> ") || "<unknown>";
    return `${gap.track_id} frames ${gap.start_frame}-${gap.end_frame} ` +
      `duration=${gap.duration_frames}f previous=${previous} next=${next} beats=${beats} ` +
      `fix=${gap.recommended_fix}`;
  }).join("; ");
}

export class TimelineOperationError extends Error {
  readonly code = "INVALID_TIMELINE_OPERATION" as const;
  readonly operation: IntentionalGapOperation;
  readonly errors: string[];

  constructor(operation: IntentionalGapOperation, errors: string[]) {
    super(`Invalid timeline operation "${operation.operation_id}": ${errors.join("; ")}`);
    this.name = "TimelineOperationError";
    this.operation = operation;
    this.errors = errors;
  }
}
