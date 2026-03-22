// Duration Mode helpers.
// Pure functions for resolving duration mode, computing frame boundaries,
// and building DurationPolicy snapshots.

import type { DurationMode, DurationPolicy, CreativeBrief, EditBlueprint, CreativeBriefEditorial } from "./types.js";

// ── Profile → Duration Mode mapping ────────────────────────────────

const PROFILE_MODE_MAP: Record<string, DurationMode> = {
  "interview-highlight": "guide",
  "interview-pro-highlight": "guide",
  "lp-testimonial": "strict",
  "vertical-short": "strict",
  "event-recap": "guide",
  "product-demo": "guide",
  "lecture-highlight": "guide",
};

/**
 * Resolve effective duration mode from brief + profile.
 * Follows the precedence: explicit brief > profile default > global default (guide).
 */
export function resolveDurationMode(
  brief: CreativeBrief,
  resolvedProfileId?: string,
): { mode: DurationMode; source: DurationPolicy["source"] } {
  const explicitMode = brief.project.duration_mode;
  const targetSec = brief.project.runtime_target_sec;

  // 1. Explicit brief
  if (explicitMode) {
    if (explicitMode === "strict" && (!targetSec || targetSec <= 0)) {
      throw new Error(
        "duration_mode: strict requires a positive runtime_target_sec in the creative brief",
      );
    }
    return { mode: explicitMode, source: "explicit_brief" };
  }

  // 2. Profile default
  if (resolvedProfileId) {
    const profileDefault = PROFILE_MODE_MAP[resolvedProfileId];
    if (profileDefault) {
      if (profileDefault === "strict" && (!targetSec || targetSec <= 0)) {
        // Downgrade to guide — strict requires target
        return { mode: "guide", source: "global_default" };
      }
      return { mode: profileDefault, source: "profile_default" };
    }
  }

  // 3. Global default
  return { mode: "guide", source: "global_default" };
}

// ── Frame boundary helpers ─────────────────────────────────────────

/**
 * Convert seconds to frames using rational fps (fpsNum/fpsDen).
 * Uses Math.round for target, Math.ceil for min, Math.floor for max.
 */
export function secToTargetFrames(sec: number, fpsNum: number, fpsDen: number): number {
  return Math.round(sec * fpsNum / fpsDen);
}

export function secToMinFrames(sec: number, fpsNum: number, fpsDen: number): number {
  return Math.ceil(sec * fpsNum / fpsDen);
}

export function secToMaxFrames(sec: number, fpsNum: number, fpsDen: number): number {
  return Math.floor(sec * fpsNum / fpsDen);
}

export interface DurationFrameBounds {
  target_frames: number;
  min_target_frames: number;
  max_target_frames: number | null; // null = unbounded
}

/**
 * Compute frame bounds from DurationPolicy.
 */
export function computeFrameBounds(
  policy: DurationPolicy,
  fpsNum: number,
  fpsDen: number,
): DurationFrameBounds {
  const target_frames = secToTargetFrames(policy.target_duration_sec, fpsNum, fpsDen);
  const min_target_frames = secToMinFrames(policy.min_duration_sec, fpsNum, fpsDen);
  const max_target_frames =
    policy.max_duration_sec != null
      ? secToMaxFrames(policy.max_duration_sec, fpsNum, fpsDen)
      : null;

  return { target_frames, min_target_frames, max_target_frames };
}

/**
 * Check if actual frames is within the duration window (inclusive).
 */
export function isWithinWindow(
  actualFrames: number,
  bounds: DurationFrameBounds,
): boolean {
  if (actualFrames < bounds.min_target_frames) return false;
  if (bounds.max_target_frames != null && actualFrames > bounds.max_target_frames) return false;
  return true;
}

// ── DurationPolicy builder ─────────────────────────────────────────

/**
 * Build a canonical DurationPolicy from resolved mode + brief.
 * This is the single source of truth for the compiler and all downstream consumers.
 */
export function buildDurationPolicy(
  brief: CreativeBrief,
  resolvedProfileId?: string,
  materialTotalDurationSec?: number,
): DurationPolicy {
  const { mode, source } = resolveDurationMode(brief, resolvedProfileId);
  const targetSec = brief.project.runtime_target_sec;

  if (mode === "strict") {
    // strict requires explicit target (enforced by resolveDurationMode)
    return {
      mode: "strict",
      source,
      target_source: "explicit_brief",
      target_duration_sec: targetSec!,
      min_duration_sec: targetSec! - 1,
      max_duration_sec: targetSec! + 1,
      hard_gate: true,
      protect_vlm_peaks: false,
    };
  }

  // guide mode
  if (targetSec && targetSec > 0) {
    return {
      mode: "guide",
      source,
      target_source: "explicit_brief",
      target_duration_sec: targetSec,
      min_duration_sec: targetSec * 0.7,
      max_duration_sec: targetSec * 1.3,
      hard_gate: false,
      protect_vlm_peaks: true,
    };
  }

  // guide + no target: use material-derived
  const derived = materialTotalDurationSec ?? 0;
  return {
    mode: "guide",
    source,
    target_source: "material_total",
    target_duration_sec: derived > 0 ? derived : 1, // Avoid zero — schema requires > 0
    min_duration_sec: 0,
    max_duration_sec: null,
    hard_gate: false,
    protect_vlm_peaks: true,
  };
}

/**
 * Resolve DurationPolicy from an existing blueprint (for compiler use).
 * If the blueprint already has duration_policy, return it.
 * Otherwise, build from brief + blueprint metadata (backward compat).
 */
export function resolveDurationPolicyFromBlueprint(
  blueprint: EditBlueprint,
  brief: CreativeBrief,
  materialTotalDurationSec?: number,
): DurationPolicy {
  if (blueprint.duration_policy) {
    return blueprint.duration_policy;
  }

  // Backward compat: build from brief
  return buildDurationPolicy(
    brief,
    blueprint.resolved_profile?.id,
    materialTotalDurationSec,
  );
}

// ── Output Dimensions ────────────────────────────────────────────────

export interface OutputDimensions {
  width: number;
  height: number;
  output_aspect_ratio: string;
  letterbox_policy: "none" | "pillarbox" | "letterbox";
}

export interface SourceVideoDimensions {
  width: number;
  height: number;
}

const ASPECT_RATIO_DIMENSIONS: Record<string, { width: number; height: number }> = {
  "16:9": { width: 1920, height: 1080 },
  "9:16": { width: 1080, height: 1920 },
  "1:1": { width: 1080, height: 1080 },
  "4:5": { width: 1080, height: 1350 },
};

const ASPECT_RATIO_VALUES = Object.fromEntries(
  Object.entries(ASPECT_RATIO_DIMENSIONS).map(([ratio, dims]) => [
    ratio,
    dims.width / dims.height,
  ]),
) as Record<string, number>;

function inferClosestAspectRatio(
  width: number,
  height: number,
): string | null {
  if (width <= 0 || height <= 0) return null;

  const actual = width / height;
  let bestRatio: string | null = null;
  let bestDelta = Number.POSITIVE_INFINITY;

  for (const [ratio, target] of Object.entries(ASPECT_RATIO_VALUES)) {
    const delta = Math.abs(actual - target);
    if (delta < bestDelta) {
      bestRatio = ratio;
      bestDelta = delta;
    }
  }

  return bestRatio;
}

export function inferDominantSourceAspectRatio(
  sourceDimensions: SourceVideoDimensions[] = [],
): string | null {
  const counts = new Map<string, number>();

  for (const dims of sourceDimensions) {
    const ratio = inferClosestAspectRatio(dims.width, dims.height);
    if (!ratio) continue;
    counts.set(ratio, (counts.get(ratio) ?? 0) + 1);
  }

  if (counts.size === 0) return null;

  const ranked = [...counts.entries()].sort(
    (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
  );
  return ranked[0][0];
}

function resolveLetterboxPolicy(
  sourceAspectRatio: string | null,
  outputAspectRatio: string,
): "none" | "pillarbox" | "letterbox" {
  if (!sourceAspectRatio || sourceAspectRatio === outputAspectRatio) {
    return "none";
  }

  const sourceValue = ASPECT_RATIO_VALUES[sourceAspectRatio];
  const outputValue = ASPECT_RATIO_VALUES[outputAspectRatio];
  if (!sourceValue || !outputValue || Math.abs(sourceValue - outputValue) < 0.001) {
    return "none";
  }

  return sourceValue < outputValue ? "pillarbox" : "letterbox";
}

/**
 * Resolve output dimensions from creative brief editorial settings.
 * Falls back to the dominant source aspect ratio, then 16:9 if unspecified.
 */
export function resolveOutputDimensions(
  editorial?: CreativeBriefEditorial,
  sourceDimensions: SourceVideoDimensions[] = [],
): OutputDimensions {
  const ratio = editorial?.aspect_ratio;
  const sourceAspectRatio = inferDominantSourceAspectRatio(sourceDimensions);

  let resolvedRatio: string | null = null;
  if (ratio && ratio !== "unknown" && ASPECT_RATIO_DIMENSIONS[ratio]) {
    resolvedRatio = ratio;
  } else if (sourceAspectRatio) {
    resolvedRatio = sourceAspectRatio;
  } else {
    resolvedRatio = "16:9";
  }

  const dims = ASPECT_RATIO_DIMENSIONS[resolvedRatio];
  return {
    width: dims.width,
    height: dims.height,
    output_aspect_ratio: resolvedRatio,
    letterbox_policy: resolveLetterboxPolicy(sourceAspectRatio, resolvedRatio),
  };
}

// ── Timeline Order ───────────────────────────────────────────────────

const PROFILE_TIMELINE_ORDER: Record<string, "chronological" | "editorial"> = {
  "keepsake": "chronological",
  "event-recap": "chronological",
  "interview-highlight": "editorial",
  "interview-pro-highlight": "editorial",
  "lp-testimonial": "editorial",
  "vertical-short": "editorial",
  "product-demo": "editorial",
  "lecture-highlight": "editorial",
};

/**
 * Resolve timeline ordering strategy.
 * Precedence: explicit blueprint > story_arc strategy > profile default > editorial.
 */
export function resolveTimelineOrder(
  blueprint: EditBlueprint,
  resolvedProfileId?: string,
): "chronological" | "editorial" {
  // 1. Explicit in blueprint
  if (blueprint.timeline_order) return blueprint.timeline_order;

  // 2. Infer from story_arc strategy
  if (blueprint.story_arc?.strategy === "chronological") return "chronological";

  // 3. Profile default
  if (resolvedProfileId) {
    return PROFILE_TIMELINE_ORDER[resolvedProfileId] ?? "editorial";
  }

  return "editorial";
}
