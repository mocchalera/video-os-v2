import type {
  Candidate,
  CreativeBrief,
  ProfileDefaults,
  StillDurationPolicy,
  StillHoldIntent,
  StillHoldResolution,
  StillImageCandidateIntent,
  StillImageTimelineMetadata,
} from "../compiler/types.js";
import type { BgmAnalysis } from "../compiler/transition-types.js";
import {
  resolveStillCameraMotion,
  sanitizeStillCameraMotionIntent,
  sanitizeStillImageTransform,
  sanitizeStillParallaxIntent,
  type StillCameraMotionIntent,
} from "../render/camera-motion.js";

export const GLOBAL_STILL_IMAGE_INTENT = Object.freeze({
  min_hold_sec: 1,
  default_hold_sec: 3,
  max_hold_sec: 10,
  motion_mode: "static" as const,
  fit_mode: "contain" as const,
  background: "black" as const,
});

export interface StillHoldResolutionContext {
  /** Median measured beat interval in sequence frames (legacy fallback). */
  beat_duration_frames?: number;
  /** Measured beat boundaries in sequence frames, in chronological order. */
  beat_frames?: number[];
  /** A frame collision means more than one source beat maps to one frame. */
  beat_grid_ambiguous?: boolean;
  section_boundaries?: Array<{
    id: string;
    start_frame: number;
    end_frame: number;
  }>;
}

type StillHoldBgmAnalysis = Pick<BgmAnalysis, "beats_sec" | "sections"> & {
  beats?: Array<{ time_sec: number }>;
};

/** Project-bound beat/section frame context used by authored still holds. */
export function buildStillHoldResolutionContext(
  analysis: StillHoldBgmAnalysis | undefined,
  fpsNum: number,
  fpsDen = 1,
): StillHoldResolutionContext | undefined {
  if (!analysis) return undefined;
  const beatSeconds = (analysis.beats ?? []).map((beat) => beat.time_sec)
    .filter((time) => Number.isFinite(time) && time >= 0);
  const fallbackBeatSeconds = analysis.beats_sec
    .filter((time) => Number.isFinite(time) && time >= 0);
  const times = [...new Set((beatSeconds.length > 1 ? beatSeconds : fallbackBeatSeconds).sort((a, b) => a - b))];
  const intervals = times.slice(1)
    .map((time, index) => time - times[index])
    .filter((duration) => duration > 0);
  const medianInterval = intervals.length > 0
    ? intervals.slice().sort((a, b) => a - b)[Math.floor(intervals.length / 2)]
    : undefined;
  const rawBeatFrames = times.map((time) => Math.max(0, Math.round(time * fpsNum / fpsDen)));
  const beatFrames = [...new Set(rawBeatFrames)].sort((a, b) => a - b);
  return {
    ...(medianInterval !== undefined
      ? { beat_duration_frames: Math.max(1, Math.round(medianInterval * fpsNum / fpsDen)) }
      : {}),
    ...(beatFrames.length > 0 ? { beat_frames: beatFrames } : {}),
    ...(rawBeatFrames.length !== beatFrames.length ? { beat_grid_ambiguous: true } : {}),
    section_boundaries: analysis.sections
      .filter((section) => Number.isFinite(section.start_sec) && Number.isFinite(section.end_sec) && section.end_sec > section.start_sec)
      .map((section) => ({
        id: section.id,
        start_frame: Math.max(0, Math.round(section.start_sec * fpsNum / fpsDen)),
        end_frame: Math.max(1, Math.round(section.end_sec * fpsNum / fpsDen)),
      })),
  };
}

export class StillImageHoldCannotFitError extends Error {
  readonly code = "still_image_hold_cannot_fit_beat";
  constructor(readonly availableFrames: number, readonly minHoldFrames: number) {
    super(`still_image_hold_cannot_fit_beat: available_frames=${availableFrames} min_hold_frames=${minHoldFrames}`);
    this.name = "StillImageHoldCannotFitError";
  }
}

const STILL_BACKGROUND_TOKENS = new Set(["black", "white", "transparent"]);

export function sanitizeStillBackground(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  if (STILL_BACKGROUND_TOKENS.has(normalized)) return normalized;
  return /^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/.test(normalized) ? normalized : undefined;
}

type BriefStillIntent = NonNullable<CreativeBrief["still_image_intent"]>;

function positive(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function frames(seconds: number, fpsNum: number, fpsDen: number): number {
  return Math.max(1, Math.round(seconds * fpsNum / fpsDen));
}

export function resolveStillDurationPolicy(
  brief: Pick<CreativeBrief, "still_image_intent">,
  profileDefaults: Pick<ProfileDefaults, "still_image_intent"> | undefined,
  fpsNum = 24,
  fpsDen = 1,
): StillDurationPolicy {
  const explicit = brief.still_image_intent;
  const profile = profileDefaults?.still_image_intent;
  const source: StillDurationPolicy["source"] = explicit
    ? "explicit_brief"
    : profile
      ? "profile_default"
      : "global_default";
  const input: BriefStillIntent = explicit ?? profile ?? GLOBAL_STILL_IMAGE_INTENT;
  const minSec = positive(input.min_hold_sec) ?? GLOBAL_STILL_IMAGE_INTENT.min_hold_sec;
  const maxSec = Math.max(minSec, positive(input.max_hold_sec) ?? GLOBAL_STILL_IMAGE_INTENT.max_hold_sec);
  const defaultSec = Math.min(maxSec, Math.max(minSec,
    positive(input.default_hold_sec) ?? GLOBAL_STILL_IMAGE_INTENT.default_hold_sec));
  const requestedMotion = input.motion_mode ?? GLOBAL_STILL_IMAGE_INTENT.motion_mode;
  const motionIntent = sanitizeStillCameraMotionIntent(input.camera_motion ?? input.ken_burns);
  const parallax = sanitizeStillParallaxIntent(input.parallax);
  const transform = sanitizeStillImageTransform(input.transform);
  return {
    source,
    fps_num: fpsNum,
    fps_den: fpsDen,
    min_hold_frames: frames(minSec, fpsNum, fpsDen),
    default_hold_frames: frames(defaultSec, fpsNum, fpsDen),
    max_hold_frames: frames(maxSec, fpsNum, fpsDen),
    motion_mode: "static",
    ...(requestedMotion === "subtle_ken_burns"
      ? { requested_motion_mode: requestedMotion, motion_status: "pending_EYE-070C2B" as const }
      : {}),
    ...(motionIntent ? { camera_motion: motionIntent } : {}),
    ...(input.ken_burns ? { ken_burns: motionIntent } : {}),
    ...(parallax ? { parallax } : {}),
    ...(transform ? { transform } : {}),
    ...(input.composition ? { composition: input.composition } : {}),
    fit_mode: input.fit_mode ?? GLOBAL_STILL_IMAGE_INTENT.fit_mode,
    background: sanitizeStillBackground(input.background) ?? GLOBAL_STILL_IMAGE_INTENT.background,
  };
}

export function resolveStillImageHold(
  candidate: Pick<Candidate, "still_image">,
  policy: StillDurationPolicy,
  availableFrames: number,
  context?: StillHoldResolutionContext,
  timelineStartFrame = 0,
): StillImageTimelineMetadata {
  const intent: StillImageCandidateIntent | undefined = candidate.still_image;
  const hold = resolveAuthoredHold(intent, policy, context, timelineStartFrame);
  const requestedFrames = hold?.requested_frames ?? policy.default_hold_frames;
  const candidateMin = positive(intent?.min_hold_sec) !== undefined
    ? frames(intent!.min_hold_sec!, policy.fps_num, policy.fps_den)
    : policy.min_hold_frames;
  const candidateMax = positive(intent?.max_hold_sec) !== undefined
    ? frames(intent!.max_hold_sec!, policy.fps_num, policy.fps_den)
    : policy.max_hold_frames;
  const min = Math.max(policy.min_hold_frames, Math.min(candidateMin, policy.max_hold_frames));
  const max = Math.max(min, Math.min(candidateMax, policy.max_hold_frames));
  if (availableFrames < min) throw new StillImageHoldCannotFitError(availableFrames, min);
  const policyClamped = Math.min(max, Math.max(min, requestedFrames));
  const holdFrames = Math.max(1, Math.min(policyClamped, availableFrames));
  // The final limiting constraint owns provenance. A beat budget can be
  // tighter than a policy clamp (for example request=100s, max=10s, beat=5s),
  // so detect that final placement constraint first.
  const clamp: StillImageTimelineMetadata["policy_clamp"] = holdFrames < policyClamped
    ? "beat_budget"
    : requestedFrames < min
      ? "min"
      : requestedFrames > max
        ? "max"
        : "none";
  const requestedMotion = intent?.motion_mode ?? policy.requested_motion_mode ?? policy.motion_mode;
  // Executable camera motion: candidate intent wins over the resolved policy
  // intent. The plan is clamped and synchronized to the final hold frame
  // count so provenance always matches what renderers will execute.
  const motionIntent: StillCameraMotionIntent | undefined
    = sanitizeStillCameraMotionIntent(intent?.camera_motion ?? intent?.ken_burns)
    ?? sanitizeStillCameraMotionIntent(policy.camera_motion ?? policy.ken_burns);
  const parallax = sanitizeStillParallaxIntent(intent?.parallax ?? policy.parallax);
  const transform = sanitizeStillImageTransform(intent?.transform ?? policy.transform);
  const effectiveMotion = motionIntent
    ? { ...motionIntent, ...(transform ? { transform } : {}), ...(parallax ? { parallax } : {}) }
    : parallax
      ? { preset: "diagonal_drift" as const, intensity: Math.max(0.02, parallax.amount), parallax, ...(transform ? { transform } : {}) }
      : undefined;
  const cameraMotion = motionIntent
    ? resolveStillCameraMotion(effectiveMotion, holdFrames)
    : parallax
      ? resolveStillCameraMotion(effectiveMotion, holdFrames)
    : undefined;
  const holdResolution = hold
    ? {
        ...hold,
        resolved_frames: holdFrames,
        status: holdFrames === hold.requested_frames ? "resolved" as const : "clamped" as const,
      }
    : undefined;
  return {
    hold_frames: holdFrames,
    min_hold_frames: min,
    max_hold_frames: max,
    hold_source: hold ? "candidate_override" : policy.source,
    policy_clamp: clamp,
    ...(intent?.hold ? { hold: { ...intent.hold } } : hold?.unit === "seconds" && intent?.hold_duration_sec
      ? { hold: { unit: "seconds" as const, value: intent.hold_duration_sec } }
      : {}),
    ...(holdResolution ? { hold_resolution: holdResolution } : {}),
    ...(intent?.source_still_id ? { source_still_id: intent.source_still_id } : {}),
    ...(intent?.still_instance_id ? { still_instance_id: intent.still_instance_id } : {}),
    ...(intent?.reuse ? { reuse: intent.reuse } : {}),
    ...(intent?.long_hold_reason ? { long_hold_reason: intent.long_hold_reason } : {}),
    motion_mode: cameraMotion ? "camera_motion" : "static",
    ...(requestedMotion === "subtle_ken_burns" && !cameraMotion
      ? { requested_motion_mode: requestedMotion, motion_status: "pending_EYE-070C2B" as const }
      : {}),
    ...(cameraMotion ? { camera_motion: cameraMotion, ken_burns: cameraMotion } : {}),
    ...(parallax ? { parallax } : {}),
    ...(transform ? { transform } : {}),
    ...(intent?.composition ?? policy.composition
      ? { composition: (intent?.composition ?? policy.composition)! }
      : {}),
    fit_mode: intent?.fit_mode ?? policy.fit_mode,
    background: sanitizeStillBackground(intent?.background) ?? policy.background,
  };
}

function resolveAuthoredHold(
  intent: StillImageCandidateIntent | undefined,
  policy: StillDurationPolicy,
  context: StillHoldResolutionContext | undefined,
  timelineStartFrame: number,
): StillHoldResolution | undefined {
  const authored = intent?.hold ?? (positive(intent?.hold_duration_sec) !== undefined
    ? { unit: "seconds" as const, value: intent!.hold_duration_sec }
    : undefined);
  if (!authored) return undefined;
  const hold = sanitizeStillHoldIntent(authored);
  let requestedFrames: number;
  let boundaryFrame: number | undefined;
  switch (hold.unit) {
    case "frames":
      requestedFrames = Math.max(1, Math.round(hold.value!));
      break;
    case "seconds":
      requestedFrames = frames(hold.value!, policy.fps_num, policy.fps_den);
      break;
    case "beats":
      if (context?.beat_frames) {
        const beatCount = hold.value!;
        if (!Number.isInteger(beatCount)) {
          throw new Error(`still_hold_beat_count_not_integer:${String(beatCount)}`);
        }
        const boundary = resolveBeatGridBoundary(context, beatCount, timelineStartFrame);
        boundaryFrame = boundary;
        requestedFrames = boundary - timelineStartFrame;
      } else if (!context?.beat_duration_frames) {
        throw new Error("still_hold_context_missing:beats");
      } else {
        requestedFrames = Math.max(1, Math.round(hold.value! * context.beat_duration_frames));
      }
      break;
    case "section_boundary": {
      const section = context?.section_boundaries?.find((item) => item.id === hold.section_id);
      if (!section) throw new Error(`still_hold_context_missing:section_boundary:${hold.section_id ?? ""}`);
      boundaryFrame = hold.boundary === "start" ? section.start_frame : section.end_frame;
      requestedFrames = boundaryFrame - timelineStartFrame;
      if (requestedFrames < 1) {
        throw new Error(`still_hold_section_boundary_before_clip:${hold.section_id}`);
      }
      break;
    }
  }
  return {
    unit: hold.unit,
    requested_frames: requestedFrames,
    resolved_frames: requestedFrames,
    ...(hold.value !== undefined ? { requested_value: hold.value } : {}),
    ...(hold.section_id ? { section_id: hold.section_id } : {}),
    ...(hold.boundary ? { boundary: hold.boundary } : {}),
    ...(boundaryFrame !== undefined ? { boundary_frame: boundaryFrame } : {}),
    status: "resolved",
  };
}

function resolveBeatGridBoundary(
  context: StillHoldResolutionContext,
  beatCount: number,
  timelineStartFrame: number,
): number {
  const beatFrames = context.beat_frames ?? [];
  if (context.beat_grid_ambiguous || beatFrames.length === 0 || !Number.isFinite(timelineStartFrame)) {
    throw new Error("still_hold_beat_boundary_unresolvable");
  }

  const intervals = beatFrames.slice(1).map((frame, index) => frame - beatFrames[index]);
  const uniform = intervals.length > 0 && intervals.every((interval) => interval === intervals[0]);
  const interval = context.beat_duration_frames ?? intervals[0];
  if (uniform && (!interval || interval < 1)) {
    throw new Error("still_hold_beat_boundary_unresolvable");
  }

  const firstNextIndex = beatFrames.findIndex((frame) => frame > timelineStartFrame);
  if (firstNextIndex >= 0) {
    const targetIndex = firstNextIndex + beatCount - 1;
    if (targetIndex < beatFrames.length) return beatFrames[targetIndex];
    if (!uniform) throw new Error("still_hold_beat_boundary_unresolvable");
    return beatFrames[beatFrames.length - 1] + (targetIndex - beatFrames.length + 1) * interval;
  }

  if (!uniform) throw new Error("still_hold_beat_boundary_unresolvable");
  const last = beatFrames[beatFrames.length - 1];
  const stepsToNext = Math.floor((timelineStartFrame - last) / interval) + 1;
  return last + (stepsToNext + beatCount - 1) * interval;
}

function sanitizeStillHoldIntent(value: StillHoldIntent): StillHoldIntent {
  if (!value || typeof value !== "object") throw new Error("still_hold_invalid");
  if (value.unit !== "frames" && value.unit !== "seconds" && value.unit !== "beats" && value.unit !== "section_boundary") {
    throw new Error(`still_hold_invalid_unit:${String(value.unit)}`);
  }
  if (value.unit !== "section_boundary" && positive(value.value) === undefined) {
    throw new Error(`still_hold_invalid_value:${String(value.value)}`);
  }
  if (value.unit === "section_boundary" && (!value.section_id || value.section_id.trim().length === 0)) {
    throw new Error("still_hold_section_id_missing");
  }
  if (value.unit === "section_boundary" && !value.boundary) {
    throw new Error("still_hold_boundary_missing");
  }
  if (value.boundary !== undefined && value.boundary !== "start" && value.boundary !== "end") {
    throw new Error(`still_hold_invalid_boundary:${String(value.boundary)}`);
  }
  return {
    unit: value.unit,
    ...(value.value !== undefined ? { value: value.value } : {}),
    ...(value.section_id ? { section_id: value.section_id } : {}),
    ...(value.boundary ? { boundary: value.boundary } : {}),
    ...(value.reason ? { reason: value.reason } : {}),
  };
}
