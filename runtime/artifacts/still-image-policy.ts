import type {
  Candidate,
  CreativeBrief,
  ProfileDefaults,
  StillDurationPolicy,
  StillImageCandidateIntent,
  StillImageTimelineMetadata,
} from "../compiler/types.js";

export const GLOBAL_STILL_IMAGE_INTENT = Object.freeze({
  min_hold_sec: 1,
  default_hold_sec: 3,
  max_hold_sec: 10,
  motion_mode: "static" as const,
  fit_mode: "contain" as const,
  background: "black" as const,
});

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
    fit_mode: input.fit_mode ?? GLOBAL_STILL_IMAGE_INTENT.fit_mode,
    background: sanitizeStillBackground(input.background) ?? GLOBAL_STILL_IMAGE_INTENT.background,
  };
}

export function resolveStillImageHold(
  candidate: Pick<Candidate, "still_image">,
  policy: StillDurationPolicy,
  availableFrames: number,
): StillImageTimelineMetadata {
  const intent: StillImageCandidateIntent | undefined = candidate.still_image;
  const requestedFrames = positive(intent?.hold_duration_sec) !== undefined
    ? frames(intent!.hold_duration_sec!, policy.fps_num, policy.fps_den)
    : policy.default_hold_frames;
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
  return {
    hold_frames: holdFrames,
    min_hold_frames: min,
    max_hold_frames: max,
    hold_source: intent?.hold_duration_sec ? "candidate_override" : policy.source,
    policy_clamp: clamp,
    motion_mode: "static",
    ...(requestedMotion === "subtle_ken_burns"
      ? { requested_motion_mode: requestedMotion, motion_status: "pending_EYE-070C2B" as const }
      : {}),
    fit_mode: intent?.fit_mode ?? policy.fit_mode,
    background: sanitizeStillBackground(intent?.background) ?? policy.background,
  };
}
