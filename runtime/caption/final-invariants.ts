import type { CaptionDraft, CaptionDraftEntry } from "./editorial.js";
import {
  computeCaptionCps,
  MIN_CAPTION_HARD_FLOOR_MS,
  MIN_CAPTION_TARGET_DWELL_MS,
} from "./segmenter.js";

export type FinalCaptionInvariantCode =
  | "non_positive_duration"
  | "caption_overlap"
  | "caption_separation_unresolved"
  | "below_hard_dwell_floor"
  | "below_target_dwell"
  | "stale_metrics"
  | "unresolved_reveal_anchor"
  | "premature_protected_reveal";

export interface FinalCaptionInvariantIssue {
  code: FinalCaptionInvariantCode;
  severity: "block" | "advisory";
  caption_id: string;
  message: string;
}

export interface FinalizeCaptionDraftTimingResult {
  draft: CaptionDraft;
  issues: FinalCaptionInvariantIssue[];
}

/**
 * Final timing pass for persisted caption drafts.
 *
 * Semantic timing may split, move, or extend cues. This pass therefore runs
 * after semantic timing, applies the one-frame separation contract, recomputes
 * metrics from the persisted values, and validates the resulting artifact.
 */
export function finalizeCaptionDraftTiming(
  draft: CaptionDraft,
  fps: number,
  language: string,
  gapFrames = 1,
): FinalizeCaptionDraftTimingResult {
  const gap = Math.max(0, Math.floor(gapFrames));
  const captions = draft.speech_captions
    .map((entry) => structuredClone(entry))
    .sort((a, b) =>
      a.timeline_in_frame - b.timeline_in_frame ||
      a.caption_id.localeCompare(b.caption_id)
    );
  const separationIssues: FinalCaptionInvariantIssue[] = [];

  for (let index = 0; index < captions.length; index += 1) {
    const entry = captions[index];
    const next = captions[index + 1];
    if (next) {
      const latestOut = next.timeline_in_frame - gap;
      const currentOut = entry.timeline_in_frame + entry.timeline_duration_frames;
      if (currentOut > latestOut) {
        const separatedDuration = latestOut - entry.timeline_in_frame;
        if (separatedDuration > 0) {
          entry.timeline_duration_frames = separatedDuration;
        } else {
          separationIssues.push({
            code: "caption_separation_unresolved",
            severity: "block",
            caption_id: entry.caption_id,
            message:
              `${entry.caption_id} cannot preserve a ${gap}-frame gap before ` +
              `${next.caption_id}`,
          });
        }
      }
    }
    recomputeCaptionMetrics(entry, fps, language);
  }

  const finalizedDraft: CaptionDraft = {
    ...draft,
    speech_captions: captions,
  };
  return {
    draft: finalizedDraft,
    issues: [
      ...separationIssues,
      ...validateFinalCaptionInvariants(captions, fps, language, gap),
    ],
  };
}

/**
 * Validate the exact cue values that will be approved or packaged.
 * Structural/semantic issues are never human-waivable; short target dwell is
 * advisory so an intentionally brief impact cue may still be approved.
 */
export function validateFinalCaptionInvariants(
  captions: CaptionDraftEntry[],
  fps: number,
  language: string,
  gapFrames = 1,
): FinalCaptionInvariantIssue[] {
  const issues: FinalCaptionInvariantIssue[] = [];
  const gap = Math.max(0, Math.floor(gapFrames));
  const sorted = [...captions].sort((a, b) =>
    a.timeline_in_frame - b.timeline_in_frame ||
    a.caption_id.localeCompare(b.caption_id)
  );

  for (let index = 0; index < sorted.length; index += 1) {
    const entry = sorted[index];
    const durationMs = fps > 0
      ? entry.timeline_duration_frames / fps * 1000
      : 0;
    if (entry.timeline_duration_frames <= 0 || !Number.isFinite(durationMs)) {
      issues.push({
        code: "non_positive_duration",
        severity: "block",
        caption_id: entry.caption_id,
        message: `${entry.caption_id} has a non-positive or invalid duration`,
      });
    } else if (durationMs < MIN_CAPTION_HARD_FLOOR_MS) {
      issues.push({
        code: "below_hard_dwell_floor",
        severity: "block",
        caption_id: entry.caption_id,
        message:
          `${entry.caption_id} dwell ${Math.round(durationMs)}ms is below the ` +
          `${MIN_CAPTION_HARD_FLOOR_MS}ms hard floor`,
      });
    } else if (durationMs < MIN_CAPTION_TARGET_DWELL_MS) {
      issues.push({
        code: "below_target_dwell",
        severity: "advisory",
        caption_id: entry.caption_id,
        message:
          `${entry.caption_id} dwell ${Math.round(durationMs)}ms is below the ` +
          `${MIN_CAPTION_TARGET_DWELL_MS}ms target`,
      });
    }

    if (durationMs > 0 && Number.isFinite(durationMs)) {
      const expectedDwell = Math.round(durationMs);
      const expectedCps = Math.round(
        computeCaptionCps(entry.text, durationMs, language) * 100,
      ) / 100;
      if (
        entry.metrics.dwell_ms !== expectedDwell ||
        Math.abs(entry.metrics.cps - expectedCps) > 0.001
      ) {
        issues.push({
          code: "stale_metrics",
          severity: "block",
          caption_id: entry.caption_id,
          message:
            `${entry.caption_id} metrics do not match final timing/text ` +
            `(expected dwell=${expectedDwell}ms cps=${expectedCps})`,
        });
      }
    }

    const next = sorted[index + 1];
    if (
      next &&
      entry.timeline_in_frame + entry.timeline_duration_frames >
        next.timeline_in_frame - gap
    ) {
      issues.push({
        code: "caption_overlap",
        severity: "block",
        caption_id: entry.caption_id,
        message:
          `${entry.caption_id} overlaps the required ${gap}-frame gap before ` +
          `${next.caption_id}`,
      });
    }

    const reveal = entry.reveal_timing;
    if (reveal?.status === "unresolved" || reveal?.source === "unresolved") {
      issues.push({
        code: "unresolved_reveal_anchor",
        severity: "block",
        caption_id: entry.caption_id,
        message: `${entry.caption_id} has an unresolved reveal anchor`,
      });
    } else if (reveal?.status === "protected") {
      const earliestAllowed = reveal.anchor_frame === undefined
        ? undefined
        : reveal.anchor_frame + reveal.audio_first_frames;
      if (
        earliestAllowed === undefined ||
        entry.timeline_in_frame < earliestAllowed
      ) {
        issues.push({
          code: "premature_protected_reveal",
          severity: "block",
          caption_id: entry.caption_id,
          message:
            `${entry.caption_id} starts at frame ${entry.timeline_in_frame}; ` +
            `protected reveal may not precede frame ${earliestAllowed ?? "unresolved"}`,
        });
      }
    }
  }

  return dedupeIssues(issues);
}

function recomputeCaptionMetrics(
  entry: CaptionDraftEntry,
  fps: number,
  language: string,
): void {
  const dwellMs = fps > 0
    ? entry.timeline_duration_frames / fps * 1000
    : 0;
  entry.metrics = {
    dwell_ms: Math.round(dwellMs),
    cps: Math.round(computeCaptionCps(entry.text, dwellMs, language) * 100) / 100,
  };
  if (entry.timing) {
    entry.timing = {
      ...entry.timing,
      timelineInFrame: entry.timeline_in_frame,
      timelineDurationFrames: entry.timeline_duration_frames,
    };
  }
}

function dedupeIssues(
  issues: FinalCaptionInvariantIssue[],
): FinalCaptionInvariantIssue[] {
  const seen = new Set<string>();
  return issues.filter((issue) => {
    const key = `${issue.code}:${issue.caption_id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
