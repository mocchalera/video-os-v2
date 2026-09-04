/**
 * Operator diagnostics (Issue #6 P1).
 *
 * Turns compile results and failures into operator-readable reports:
 * - a beat allocation report (target vs resolved frames, gap/overrun, source
 *   ranges) so problems like a 65-frame hole are understandable without
 *   reading timeline.json by hand;
 * - the earliest gate an operator should return to after a failure;
 * - an explicit split between auto-fixable changes and structural changes
 *   that need human re-approval.
 */

import type { PrimaryTrackGap } from "./coverage.js";
import { GapFreeTimelineError, InsufficientContentError, PrimaryAudioGapError, TimelineOperationError } from "./errors.js";
import { AtomicArtifactValidationError } from "./atomic-finalize.js";
import { RenderSourceUnresolvedError } from "./render-readiness.js";
import type { ResolutionReport } from "./resolve.js";
import type { TrimRangeReport } from "./trim.js";
import type { TimelineIR } from "./types.js";

// ── Remedy classification ──────────────────────────────────────────

export type RemedyClass = "auto_fix" | "human_reapproval";

export const REMEDY_CLASS_REASON: Record<RemedyClass, string> = {
  auto_fix: "Mechanical change within already-approved material; no re-approval needed.",
  human_reapproval: "Structural or content change; requires human re-approval before compile.",
};

// ── Beat allocation report ─────────────────────────────────────────

export interface BeatAllocationSourceRange {
  clip_id: string;
  segment_id: string;
  asset_id: string;
  src_in_us: number;
  src_out_us: number;
  timeline_in_frame: number;
  duration_frames: number;
  /** Present when the compiler changed the authored range for this clip. */
  trim_adjustment?: {
    requested_duration_us: number;
    resolved_duration_us: number;
    reason: string;
  };
}

export interface BeatAllocationEntry {
  beat_id: string;
  target_frames: number;
  resolved_frames: number;
  /** resolved_frames - target_frames. Negative = shortfall, positive = overrun. */
  delta_frames: number;
  fill_ratio: number;
  status: "exact" | "short" | "over";
  source_ranges: BeatAllocationSourceRange[];
}

export interface BeatAllocationGap {
  track_id: string;
  start_frame: number;
  end_frame: number;
  duration_frames: number;
  previous_clip_id?: string;
  next_clip_id?: string;
  previous_beat_id?: string;
  next_beat_id?: string;
  recommended_fix: string;
  remedy_class: RemedyClass;
}

export interface BeatAllocationReport {
  version: "1";
  project_id: string;
  target_frames: number;
  resolved_frames: number;
  gap_frames: number;
  overrun_frames: number;
  beats: BeatAllocationEntry[];
  gaps: BeatAllocationGap[];
}

export interface BuildBeatAllocationReportOptions {
  projectId: string;
  timeline: Pick<TimelineIR, "tracks">;
  resolution: ResolutionReport;
  trimRangeReport?: TrimRangeReport[];
}

export function buildBeatAllocationReport(
  options: BuildBeatAllocationReportOptions,
): BeatAllocationReport {
  const beats: BeatAllocationEntry[] = (options.resolution.beat_fill ?? []).map((fill) => {
    const delta = fill.actual - fill.target;
    return {
      beat_id: fill.beat_id,
      target_frames: fill.target,
      resolved_frames: fill.actual,
      delta_frames: delta,
      fill_ratio: fill.fill_ratio,
      status: delta === 0 ? "exact" : delta < 0 ? "short" : "over",
      source_ranges: collectBeatSourceRanges(options.timeline, fill.beat_id),
    };
  });

  const trimAdjustments = new Map(
    (options.trimRangeReport ?? []).map((entry) => [entry.clip_id, entry]),
  );
  for (const beat of beats) {
    for (const range of beat.source_ranges) {
      const adjustment = trimAdjustments.get(range.clip_id);
      if (adjustment) {
        range.trim_adjustment = {
          requested_duration_us: adjustment.requested.duration_us,
          resolved_duration_us: adjustment.resolved.duration_us,
          reason: adjustment.reason,
        };
      }
    }
  }

  const gaps: BeatAllocationGap[] = [
    ...(options.resolution.gap_details ?? []),
    ...(options.resolution.audio_gap_details ?? []),
  ].map((gap) => ({
    track_id: gap.track_id,
    start_frame: gap.start_frame,
    end_frame: gap.end_frame,
    duration_frames: gap.duration_frames,
    ...(gap.previous_clip ? { previous_clip_id: gap.previous_clip.clip_id } : {}),
    ...(gap.next_clip ? { next_clip_id: gap.next_clip.clip_id } : {}),
    ...(gap.previous_beat_id ? { previous_beat_id: gap.previous_beat_id } : {}),
    ...(gap.next_beat_id ? { next_beat_id: gap.next_beat_id } : {}),
    recommended_fix: gap.recommended_fix,
    remedy_class: classifyRemedy(gap),
  }));

  const targetFrames = options.resolution.target_frames;
  const resolvedFrames = options.resolution.content_frames ?? options.resolution.total_frames;
  const videoGapFrames = options.resolution.gap_frames ??
    (options.resolution.gap_details ?? []).reduce((sum, gap) => sum + gap.duration_frames, 0);

  return {
    version: "1",
    project_id: options.projectId,
    target_frames: targetFrames,
    resolved_frames: resolvedFrames,
    gap_frames: videoGapFrames + (options.resolution.audio_gap_frames ?? 0),
    overrun_frames: Math.max(0, resolvedFrames - targetFrames),
    beats,
    gaps,
  };
}

function collectBeatSourceRanges(
  timeline: Pick<TimelineIR, "tracks">,
  beatId: string,
): BeatAllocationSourceRange[] {
  const ranges: BeatAllocationSourceRange[] = [];
  for (const track of [...timeline.tracks.video, ...timeline.tracks.audio]) {
    for (const clip of track.clips) {
      if (clip.beat_id !== beatId) continue;
      ranges.push({
        clip_id: clip.clip_id,
        segment_id: clip.segment_id,
        asset_id: clip.asset_id,
        src_in_us: clip.src_in_us,
        src_out_us: clip.src_out_us,
        timeline_in_frame: clip.timeline_in_frame,
        duration_frames: clip.timeline_duration_frames,
      });
    }
  }
  return ranges.sort((left, right) =>
    left.timeline_in_frame - right.timeline_in_frame || left.clip_id.localeCompare(right.clip_id),
  );
}

/**
 * Classify a primary-track gap fix by its primary recommendation: moving an
 * approved clip into place is mechanical; anything that re-cuts approved
 * content (replacing/extending source ranges) needs human re-approval.
 * Audio gap fixes classify conservatively as re-approval work because audio
 * boundaries are speech-bound; unknown fix texts also stay conservative.
 */
export function classifyRemedy(gap: Pick<PrimaryTrackGap, "recommended_fix">): RemedyClass {
  if (/^place the next approved clip/i.test(gap.recommended_fix)) return "auto_fix";
  return "human_reapproval";
}

// ── Recovery gate suggestion ───────────────────────────────────────

export type RecoveryGate =
  | "selects"
  | "blueprint"
  | "compile"
  | "media";

export interface RecoverySuggestion {
  gate: RecoveryGate;
  gate_label: string;
  action: string;
  remedy_class: RemedyClass;
  error_code?: string;
}

const GATE_LABELS: Record<RecoveryGate, string> = {
  selects: "Gate 3 (selects)",
  blueprint: "Gate 4 (blueprint approval)",
  compile: "Gate 5 (compile)",
  media: "Media relink / re-ingest",
};

/**
 * Suggest the earliest gate to return to after a compile failure. Typed
 * compiler errors map to their upstream gate; unknown failures stay at the
 * compile gate pending inspection.
 */
export function suggestRecoveryGate(error: unknown): RecoverySuggestion {
  const code = errorCodeOf(error);

  switch (code) {
    case "INSUFFICIENT_CONTENT": {
      const details = error instanceof InsufficientContentError ? error.details : undefined;
      return {
        gate: "selects",
        gate_label: GATE_LABELS.selects,
        action: details?.beat_id
          ? `Return to selects: approve additional or longer source ranges for beat ${details.beat_id} to cover the ${details.shortfall_frames}f shortfall.`
          : `Return to selects: approve additional or longer source ranges to cover the ${details?.shortfall_frames ?? "?"}f shortfall.`,
        remedy_class: "human_reapproval",
        error_code: code,
      };
    }
    case "PRIMARY_VIDEO_GAP":
      return {
        gate: "compile",
        gate_label: GATE_LABELS.compile,
        action: "Stay at compile: move the next approved clip to the coverage end or authorize an explicit gap/hold operation with authority and reason.",
        remedy_class: "auto_fix",
        error_code: code,
      };
    case "PRIMARY_AUDIO_GAP": {
      const firstGap = error instanceof PrimaryAudioGapError ? error.gaps[0] : undefined;
      return {
        gate: "compile",
        gate_label: GATE_LABELS.compile,
        action: firstGap
          ? `Stay at compile: cover A1 frames ${firstGap.start_frame}-${firstGap.end_frame} with an approved audio clip, or authorize an explicit silence/ambient-continuation operation, or declare a primary-audio mix policy.`
          : "Stay at compile: cover the reported primary-audio range with approved audio, authorize explicit silence/ambient-continuation operations, or declare a primary-audio mix policy.",
        remedy_class: "human_reapproval",
        error_code: code,
      };
    }
    case "INVALID_TIMELINE_OPERATION":
      return {
        gate: "blueprint",
        gate_label: GATE_LABELS.blueprint,
        action: "Return to blueprint: fix the timeline_operations entry (type, track, frames, authority, reason) and re-approve.",
        remedy_class: "human_reapproval",
        error_code: code,
      };
    case "BLUEPRINT_CONTRACT_MISMATCH":
      return {
        gate: "blueprint",
        gate_label: GATE_LABELS.blueprint,
        action: "Return to blueprint validation: reconcile the blueprint with the editorial profile contract before human approval.",
        remedy_class: "human_reapproval",
        error_code: code,
      };
    case "RENDER_SOURCE_UNRESOLVED":
      return {
        gate: "media",
        gate_label: GATE_LABELS.media,
        action: "Relink or restore the reported sources (read-only), then recompile; no editorial re-approval needed when content hashes match ingest.",
        remedy_class: "auto_fix",
        error_code: code,
      };
    case "ATOMIC_ARTIFACT_VALIDATION_FAILED":
      return {
        gate: "compile",
        gate_label: GATE_LABELS.compile,
        action: "Stay at compile: fix the reported artifact issues; canonical artifacts were not replaced.",
        remedy_class: "auto_fix",
        error_code: code,
      };
    default:
      return {
        gate: "compile",
        gate_label: GATE_LABELS.compile,
        action: "Inspect the compile error; no earlier gate is implicated by a typed contract.",
        remedy_class: "human_reapproval",
        ...(code ? { error_code: code } : {}),
      };
  }
}

function errorCodeOf(error: unknown): string | undefined {
  if (error && typeof error === "object" && "code" in error) {
    const value = (error as { code?: unknown }).code;
    if (typeof value === "string") return value;
  }
  return undefined;
}

// ── Human-readable rendering ───────────────────────────────────────

export function formatBeatAllocationReport(report: BeatAllocationReport): string[] {
  const lines: string[] = [
    `Beat allocation: target=${report.target_frames}f resolved=${report.resolved_frames}f ` +
      `gap=${report.gap_frames}f overrun=${report.overrun_frames}f`,
  ];
  for (const beat of report.beats) {
    lines.push(
      `  ${beat.beat_id}: target=${beat.target_frames}f resolved=${beat.resolved_frames}f ` +
        `delta=${beat.delta_frames > 0 ? "+" : ""}${beat.delta_frames}f (${beat.status})` +
        ` sources=[${beat.source_ranges.map((range) =>
          `${range.clip_id}:${range.asset_id}@${range.src_in_us}-${range.src_out_us}`,
        ).join(", ")}]`,
    );
  }
  for (const gap of report.gaps) {
    lines.push(
      `  GAP ${gap.track_id} frames ${gap.start_frame}-${gap.end_frame} (${gap.duration_frames}f)` +
        `${gap.previous_clip_id ? ` after ${gap.previous_clip_id}` : ""}` +
        `${gap.next_clip_id ? ` before ${gap.next_clip_id}` : ""}: ` +
        `${gap.recommended_fix} [${gap.remedy_class}]`,
    );
  }
  return lines;
}
