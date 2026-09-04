/**
 * Still-image camera motion (Issue 33 — still-camera-motion/v1).
 *
 * Deterministic, duration-synchronized subpixel camera work for still clips.
 *
 * Design invariants:
 * - The camera plan is provenance-carried on the timeline clip
 *   (`still_image.camera_motion`) and re-derived per render from the exact
 *   same pure math. Same inputs always produce the same trajectory.
 * - Motion is synchronized to the clip's real displayed frame count: eased
 *   progress starts at exactly 0 on frame 0 and reaches exactly 1 on the
 *   last displayed frame, so the authored camera move always completes
 *   within the timeline hold.
 * - The canonical FFmpeg lane renders true subpixel motion through the
 *   dedicated NumPy worker (python/still_camera_motion_worker.py): every
 *   frame evaluates a Float64 Lanczos kernel at the exact source coordinates
 *   from this planner's trajectory. OpenCV is used only for image
 *   decode/color conversion. There is no integer-pixel quantization stage
 *   anywhere — sub-0.001px plan steps survive rendering. Capability is
 *   fail-closed:
 *   without the worker (runtime/connectors/still-camera-local.ts), a
 *   requested camera move is an explicit error, never an integer fallback.
 * - Fail-closed: a clip that claims motion (`motion_mode: "camera_motion"`)
 *   without a valid executable plan — or an invalid plan — throws before any
 *   renderer side effect. Renderers never silently fall back to static when
 *   motion was authored.
 */

import type { StillImageTransform, StillParallaxIntent } from "../compiler/types.js";

export const STILL_CAMERA_MOTION_POLICY = "still-camera-motion/v1" as const;

export const STILL_CAMERA_MOTION_PRESETS = [
  "push_in",
  "pull_out",
  "horizontal_tracking",
  "tilt_down",
  "diagonal_drift",
  "pan_zoom",
] as const;

export type StillCameraMotionPreset = (typeof STILL_CAMERA_MOTION_PRESETS)[number];

/**
 * Still-image fit policy shared by the planner, worker, and static lanes.
 * `full_bleed` is an explicit cover alias: it fills the output edge-to-edge
 * while preserving the source aspect ratio, so no unsupported stretching is
 * introduced into the existing cover contract.
 */
export const STILL_CAMERA_FIT_MODES = ["contain", "cover", "full_bleed"] as const;
export type StillCameraFitMode = (typeof STILL_CAMERA_FIT_MODES)[number];

/** Canonical evidence emitted for each worker-rendered still-motion segment. */
export interface StillCameraMotionReceipt {
  backend: "numpy_float64_lanczos_worker";
  interpolation: "lanczos4";
  precision: "float64";
  source_dimensions: { width: number; height: number };
  output_dimensions: { width: number; height: number };
  fps: { num: number; den: number };
  duration_frames: number;
  clip_id?: string;
  source_still_id?: string;
  still_instance_id?: string;
  transform?: StillImageTransform;
  parallax?: StillParallaxIntent;
  hold?: {
    unit: "frames" | "seconds" | "beats" | "section_boundary";
    resolved_frames: number;
    section_id?: string;
    boundary?: "start" | "end";
    boundary_frame?: number;
  };
}

export const STILL_CAMERA_MOTION_EASINGS = ["smoothstep", "linear"] as const;
export type StillCameraMotionEasing = (typeof STILL_CAMERA_MOTION_EASINGS)[number];

/** Default and clamped bounds for the authored motion excursion. */
export const STILL_CAMERA_MOTION_DEFAULT_INTENSITY = 0.1;
export const STILL_CAMERA_MOTION_MIN_INTENSITY = 0.02;
export const STILL_CAMERA_MOTION_MAX_INTENSITY = 0.6;

/**
 * Coordinate granularity contract (Issue 33): the render path carries Float64
 * coordinates end to end. This planner is pure Float64 TypeScript; the NumPy
 * worker consumes the trajectory as Float64 and resamples at Float64 source
 * coordinates, so plan steps far below 0.001px are representable. Any
 * coarse quantization grid (e.g. the rejected 1/4px oversampled zoompan) is a
 * contract violation; hostile tests assert sub-grid plan steps and rendered
 * subpixel edge tracking against this planner.
 */
export const STILL_CAMERA_MOTION_COORDINATE_GRANULARITY_PX = 0.001;

/** Background blur strength for the automatic vertical blur-backdrop composite. */
export const VERTICAL_BLUR_BACKDROP_SIGMA = 28;

export interface StillCameraMotionIntent {
  preset: StillCameraMotionPreset;
  easing?: StillCameraMotionEasing;
  intensity?: number;
  transform?: StillImageTransform;
  parallax?: StillParallaxIntent;
}

export interface StillCameraMotionPlan extends StillCameraMotionIntent {
  easing: StillCameraMotionEasing;
  intensity: number;
  /** Displayed frame count the motion is synchronized to (== clip hold_frames). */
  frame_count: number;
  policy: typeof STILL_CAMERA_MOTION_POLICY;
}

export interface StillCameraMotionIntentInput {
  preset?: unknown;
  easing?: unknown;
  intensity?: unknown;
  transform?: unknown;
  parallax?: unknown;
}

export function isStillCameraMotionPreset(value: unknown): value is StillCameraMotionPreset {
  return typeof value === "string" && (STILL_CAMERA_MOTION_PRESETS as readonly string[]).includes(value);
}

export function isStillCameraMotionEasing(value: unknown): value is StillCameraMotionEasing {
  return typeof value === "string" && (STILL_CAMERA_MOTION_EASINGS as readonly string[]).includes(value);
}

export function isStillCameraFitMode(value: unknown): value is StillCameraFitMode {
  return typeof value === "string" && (STILL_CAMERA_FIT_MODES as readonly string[]).includes(value);
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** Validate the normalized per-instance framing block before any renderer runs. */
export function sanitizeStillImageTransform(value: unknown): StillImageTransform | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`still_image_transform_invalid:${String(value)}`);
  }
  const raw = value as Record<string, unknown>;
  const result: StillImageTransform = {};
  if (raw.crop !== undefined) {
    if (!raw.crop || typeof raw.crop !== "object" || Array.isArray(raw.crop)) {
      throw new Error("still_image_transform_invalid_crop");
    }
    const crop = raw.crop as Record<string, unknown>;
    const values = [crop.x, crop.y, crop.width, crop.height];
    if (!values.every(finite) || (crop.x as number) < 0 || (crop.y as number) < 0 ||
      (crop.width as number) <= 0 || (crop.height as number) <= 0 ||
      (crop.x as number) + (crop.width as number) > 1 ||
      (crop.y as number) + (crop.height as number) > 1) {
      throw new Error("still_image_transform_invalid_crop");
    }
    result.crop = {
      x: crop.x as number,
      y: crop.y as number,
      width: crop.width as number,
      height: crop.height as number,
    };
  }
  for (const key of ["scale", "zoom"] as const) {
    if (raw[key] === undefined) continue;
    if (!finite(raw[key]) || (raw[key] as number) <= 0 || (raw[key] as number) > 8) {
      throw new Error(`still_image_transform_invalid_${key}`);
    }
    result[key] = raw[key] as number;
  }
  for (const key of ["pan", "anchor"] as const) {
    if (raw[key] === undefined) continue;
    if (!raw[key] || typeof raw[key] !== "object" || Array.isArray(raw[key])) {
      throw new Error(`still_image_transform_invalid_${key}`);
    }
    const point = raw[key] as Record<string, unknown>;
    if (!finite(point.x) || !finite(point.y)) {
      throw new Error(`still_image_transform_invalid_${key}`);
    }
    if (key === "anchor" && ((point.x as number) < 0 || (point.x as number) > 1 ||
      (point.y as number) < 0 || (point.y as number) > 1)) {
      throw new Error("still_image_transform_invalid_anchor");
    }
    if (key === "pan" && (Math.abs(point.x as number) > 1 || Math.abs(point.y as number) > 1)) {
      throw new Error("still_image_transform_invalid_pan");
    }
    result[key] = { x: point.x as number, y: point.y as number };
  }
  if (Object.keys(result).length === 0) {
    throw new Error("still_image_transform_empty");
  }
  return result;
}

export function sanitizeStillParallaxIntent(value: unknown): StillParallaxIntent | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error("still_parallax_invalid");
  }
  const raw = value as { amount?: unknown; axis?: unknown };
  if (!finite(raw.amount) || raw.amount <= 0 || raw.amount > 0.25) {
    throw new Error("still_parallax_invalid_amount");
  }
  if (raw.axis !== "horizontal" && raw.axis !== "vertical" && raw.axis !== "both") {
    throw new Error(`still_parallax_invalid_axis:${String(raw.axis)}`);
  }
  return { amount: raw.amount, axis: raw.axis };
}

/**
 * Sanitize an authored camera-motion intent. Returns undefined when nothing
 * was authored. Throws an explicit error on an authored-but-invalid block so
 * contract violations surface instead of quietly rendering static.
 */
export function sanitizeStillCameraMotionIntent(value: unknown): StillCameraMotionIntent | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`still_camera_motion_invalid:${JSON.stringify(value)}`);
  }
  const raw = value as StillCameraMotionIntentInput;
  if (!isStillCameraMotionPreset(raw.preset)) {
    throw new Error(`still_camera_motion_invalid_preset:${String(raw.preset)}`);
  }
  if (raw.easing !== undefined && !isStillCameraMotionEasing(raw.easing)) {
    throw new Error(`still_camera_motion_invalid_easing:${String(raw.easing)}`);
  }
  if (raw.intensity !== undefined
    && (typeof raw.intensity !== "number" || !Number.isFinite(raw.intensity) || raw.intensity <= 0)) {
    throw new Error(`still_camera_motion_invalid_intensity:${String(raw.intensity)}`);
  }
  return {
    preset: raw.preset,
    ...(raw.easing !== undefined ? { easing: raw.easing } : {}),
    ...(raw.intensity !== undefined ? { intensity: raw.intensity } : {}),
    ...(raw.transform !== undefined ? { transform: sanitizeStillImageTransform(raw.transform) } : {}),
    ...(raw.parallax !== undefined ? { parallax: sanitizeStillParallaxIntent(raw.parallax) } : {}),
  };
}

export class StillCameraMotionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StillCameraMotionError";
  }
}

function clampIntensity(intensity: number | undefined): number {
  const requested = typeof intensity === "number" && Number.isFinite(intensity) && intensity > 0
    ? intensity
    : STILL_CAMERA_MOTION_DEFAULT_INTENSITY;
  return Math.min(STILL_CAMERA_MOTION_MAX_INTENSITY, Math.max(STILL_CAMERA_MOTION_MIN_INTENSITY, requested));
}

/**
 * Resolve the executable, clamped motion plan for a clip. `frameCount` is the
 * clip's real displayed frame count (timeline hold) — motion is synchronized
 * to it. Throws on invalid authored metadata (fail-closed, never static).
 */
export function resolveStillCameraMotion(
  value: unknown,
  frameCount: number,
): StillCameraMotionPlan {
  if (!Number.isInteger(frameCount) || frameCount < 1) {
    throw new StillCameraMotionError(`still_camera_motion_frame_count_invalid:${String(frameCount)}`);
  }
  const intent = sanitizeStillCameraMotionIntent(value);
  if (!intent) {
    throw new StillCameraMotionError("still_camera_motion_metadata_without_plan");
  }
  return {
    preset: intent.preset,
    easing: intent.easing ?? "smoothstep",
    intensity: clampIntensity(intent.intensity),
    frame_count: frameCount,
    policy: STILL_CAMERA_MOTION_POLICY,
    ...(intent.transform ? { transform: { ...intent.transform } } : {}),
    ...(intent.parallax ? { parallax: { ...intent.parallax } } : {}),
  };
}

/** Canonical smoothstep easing: 3t² − 2t³ with exact 0 → 1 endpoints. */
export function smoothstepEase(t: number): number {
  const clamped = Math.min(1, Math.max(0, t));
  return clamped * clamped * (3 - 2 * clamped);
}

export function linearEase(t: number): number {
  return Math.min(1, Math.max(0, t));
}

export function easeProgress(easing: StillCameraMotionEasing, t: number): number {
  return easing === "linear" ? linearEase(t) : smoothstepEase(t);
}

/** Normalized camera window: zoom (≥1) plus window center in base-view units. */
export interface CameraWindowState {
  zoom: number;
  centerX: number;
  centerY: number;
}

/**
 * Camera window state for one displayed frame.
 *
 * `frame` counts displayed frames from 0; progress is eased over
 * frame/(frame_count−1) so the motion completes exactly on the last
 * displayed frame (single-frame holds resolve to the settled start state).
 */
export function cameraWindowState(plan: StillCameraMotionPlan, frame: number): CameraWindowState {
  const count = plan.frame_count;
  if (!Number.isInteger(count) || count < 1) {
    throw new StillCameraMotionError(`still_camera_motion_frame_count_invalid:${String(count)}`);
  }
  const clampedFrame = Math.min(count - 1, Math.max(0, frame));
  const progress = easeProgress(plan.easing, count > 1 ? clampedFrame / (count - 1) : 0);
  const excursion = plan.intensity;
  const transform = plan.transform;
  const crop = transform?.crop;
  const cropZoom = crop ? Math.max(1 / crop.width, 1 / crop.height) : 1;
  const authoredZoom = Math.max(1, cropZoom * (transform?.scale ?? 1) * (transform?.zoom ?? 1));
  const maxMotionZoom = 1 + excursion;
  const motionZoom = 1 + excursion * progress;
  const settledZoom = authoredZoom * maxMotionZoom;
  const zoom = authoredZoom * motionZoom;
  const cropCenterX = crop ? crop.x + crop.width / 2 : 0.5;
  const cropCenterY = crop ? crop.y + crop.height / 2 : 0.5;
  const basePanRange = (1 - 1 / authoredZoom) / 2;
  const baseCenterX = clampCenter(
    (transform?.anchor?.x ?? cropCenterX) + (transform?.pan?.x ?? 0) * basePanRange,
    authoredZoom,
  );
  const baseCenterY = clampCenter(
    (transform?.anchor?.y ?? cropCenterY) + (transform?.pan?.y ?? 0) * basePanRange,
    authoredZoom,
  );
  const withParallax = (center: number, axis: "x" | "y", windowZoom = zoom): number => {
    const parallax = plan.parallax;
    if (!parallax || (parallax.axis !== "both" && parallax.axis !== (axis === "x" ? "horizontal" : "vertical"))) {
      return clampCenter(center, windowZoom);
    }
    return clampCenter(center + parallax.amount * progress, windowZoom);
  };
  const settled = settledZoom;
  const settledPanRange = (1 - 1 / settled) / 2;
  const trackingCenter = (base: number, direction: number): number =>
    clampCenter(base + direction * settledPanRange + 2 * settledPanRange * progress, settled);
  switch (plan.preset) {
    case "push_in":
      return { zoom, centerX: withParallax(baseCenterX, "x"), centerY: withParallax(baseCenterY, "y") };
    case "pull_out":
      return { zoom: authoredZoom * (maxMotionZoom - excursion * progress), centerX: withParallax(baseCenterX, "x"), centerY: withParallax(baseCenterY, "y") };
    case "horizontal_tracking":
      return { zoom: settled, centerX: withParallax(trackingCenter(baseCenterX, -1), "x", settled), centerY: withParallax(baseCenterY, "y", settled) };
    case "tilt_down":
      return { zoom: settled, centerX: withParallax(baseCenterX, "x", settled), centerY: withParallax(trackingCenter(baseCenterY, -1), "y", settled) };
    case "diagonal_drift": {
      const centerX = trackingCenter(baseCenterX, -1);
      const centerY = trackingCenter(baseCenterY, -1);
      return { zoom: settled, centerX: withParallax(centerX, "x", settled), centerY: withParallax(centerY, "y", settled) };
    }
    case "pan_zoom": {
      // Grow the usable pan range with the zoom so the moving window remains
      // inside the base view even at the identity start frame. Start at the
      // settled center and apply the growing range only in the travel
      // direction; subtracting the range before progress causes an initial
      // reverse translation while zoom is still close to identity.
      const currentPanRange = (1 - 1 / zoom) / 2;
      const centerX = baseCenterX + currentPanRange * progress;
      return { zoom, centerX: withParallax(centerX, "x"), centerY: withParallax(baseCenterY, "y") };
    }
  }
}

function clampCenter(center: number, zoom: number): number {
  const halfWindow = 1 / (2 * Math.max(1, zoom));
  return Math.min(1 - halfWindow, Math.max(halfWindow, center));
}

/**
 * Full trajectory (per displayed frame). Used by tests, the Remotion lane,
 * and objective jitter/duration evidence checks.
 */
export function cameraMotionTrajectory(plan: StillCameraMotionPlan): CameraWindowState[] {
  return Array.from({ length: plan.frame_count }, (_, frame) => cameraWindowState(plan, frame));
}

/** Resolved automatic vertical blur-backdrop composition geometry. */
export interface VerticalStillComposition {
  kind: "vertical_blur_backdrop";
  /** Canvas the composite targets (== sequence geometry). */
  width: number;
  height: number;
  /** Square foreground window size (1080 for the 1080x1920 canvas). */
  fgSize: number;
  /** Foreground top offset (320 for the 1080x1920 canvas). */
  fgY: number;
  blurSigma: number;
}

export const VERTICAL_COMPOSITION_ASPECT_TOLERANCE = 0.02;

/**
 * Automatic vertical composition resolver (Issue 33 AC 3): a 9:16 portrait
 * canvas renders the still as a sharp square foreground at the registered
 * Y anchor over a blurred fill background. 1080x1920 resolves to the
 * canonical 1080x1080 foreground at Y=320.
 */
export function resolveVerticalStillComposition(
  width: number,
  height: number,
  requested?: "fit" | "vertical_blur_backdrop",
): VerticalStillComposition | null {
  if (requested === "fit") return null;
  if (!Number.isInteger(width) || width < 1 || !Number.isInteger(height) || height < 1) {
    throw new StillCameraMotionError(`still_composition_canvas_invalid:${width}x${height}`);
  }
  if (requested === undefined) {
    // Auto: engage only for the registered 9:16 portrait geometry.
    if (height <= width) return null;
    if (Math.abs(height / width - 16 / 9) > VERTICAL_COMPOSITION_ASPECT_TOLERANCE) return null;
  }
  const fgSize = Math.min(width, height);
  const fgY = Math.min(height - fgSize, Math.max(0, Math.round(height / 6)));
  return {
    kind: "vertical_blur_backdrop",
    width,
    height,
    fgSize,
    fgY,
    blurSigma: VERTICAL_BLUR_BACKDROP_SIGMA,
  };
}

/**
 * Static-composite filter for a vertical blur-backdrop clip without camera
 * motion: blurred full-canvas backdrop with a static sharp square foreground
 * at the registered Y anchor. The input must be the verified still; output
 * frame count is capped by the caller. (Motion-bearing clips do NOT go
 * through ffmpeg filters — they render via the NumPy Float64 Lanczos worker
 * in runtime/render/still-motion-render.ts.)
 */
export function buildStillVerticalStaticFilter(
  composition: VerticalStillComposition,
): string {
  const bgFilter = [
    `scale=${composition.width}:${composition.height}:force_original_aspect_ratio=increase:flags=lanczos`,
    `crop=${composition.width}:${composition.height}`,
    `gblur=sigma=${composition.blurSigma}:steps=2`,
  ].join(",");
  const fgFilter = [
    `scale=${composition.fgSize}:${composition.fgSize}:force_original_aspect_ratio=increase:flags=lanczos`,
    `crop=${composition.fgSize}:${composition.fgSize}`,
  ].join(",");
  return [
    `[0:v]split=2[bgsrc][fgsrc]`,
    `[bgsrc]${bgFilter}[bgd]`,
    `[fgsrc]${fgFilter}[fgm]`,
    `[bgd][fgm]overlay=0:${composition.fgY}:format=auto,format=yuv420p,setsar=1[vout]`,
  ].join(";");
}

/**
 * CSS-space camera transform for the Remotion lane (integer-FPS stills only).
 * Returns zoom and the translate (in container px) that must be applied as
 * `transform: translate(tx px, ty px) scale(z)` with transform-origin center
 * on a cover-fitted image inside an overflow-hidden container, so the visible
 * window matches cameraWindowState exactly. Derived from the same pure
 * planner as the FFmpeg lane (cross-lane parity by construction).
 */
export function cameraMotionRemotionTransform(
  plan: StillCameraMotionPlan,
  frame: number,
  container: { width: number; height: number },
): { zoom: number; translateX: number; translateY: number } {
  const state = cameraWindowState(plan, frame);
  // scale(z) about the center maps image point u to 0.5+(u−0.5)·z; a
  // pre-scale translate of (0.5−c)·z·container px re-centers the window c.
  return {
    zoom: state.zoom,
    translateX: (0.5 - state.centerX) * state.zoom * container.width,
    translateY: (0.5 - state.centerY) * state.zoom * container.height,
  };
}
