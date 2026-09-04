/**
 * Framing projection for the editorial storyboard.
 *
 * Canvas geometry comes only from explicit sources (delivery profile,
 * compiled timeline sequence). Nothing about 9:16, safe areas, or face
 * positions is hard-coded here; overlays are derived from project policy
 * documents and are omitted (explicitly labeled) when no policy exists.
 */

import { selectPlatformSafeZoneProfile } from "../../platform/safe-zone-profile.js";
import type {
  FramingPlan,
  LoadedDeliveryProfileInfo,
  ResolvedCanvas,
} from "./types.js";

// ── Aspect parsing ──────────────────────────────────────────────────

export interface ParsedAspect {
  label: string;
  aspect: number;
}

/**
 * Parse any "W:H" ratio string (16:9, 9:16, 2.39:1, 21:9, ...).
 * Returns null when the string is not a usable ratio.
 */
export function parseAspectRatio(value: string): ParsedAspect | null {
  const match = /^\s*(\d+(?:\.\d+)?)\s*:\s*(\d+(?:\.\d+)?)\s*$/.exec(value);
  if (!match) return null;
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
  return { label: `${trimNumber(width)}:${trimNumber(height)}`, aspect: width / height };
}

function trimNumber(value: number): string {
  return String(Number(value.toFixed(6)));
}

export function aspectFromDimensions(width: number, height: number): ParsedAspect | null {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
  const divisor = gcd(Math.round(width), Math.round(height)) || 1;
  const w = Math.round(width) / divisor;
  const h = Math.round(height) / divisor;
  // Prefer a compact integer ratio when reasonably small; otherwise decimal.
  if (w <= 64 && h <= 64) return { label: `${w}:${h}`, aspect: width / height };
  return { label: trimNumber(width / height), aspect: width / height };
}

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b);
}

/**
 * Resolve the projection canvas without guessing:
 * 1. selected delivery profile (aspect_ratio, else its resolution)
 * 2. compiled timeline sequence (output_aspect_ratio, else width/height)
 * 3. unspecified — callers must fall back to source aspect explicitly.
 */
export function resolveCanvas(options: {
  profiles: LoadedDeliveryProfileInfo[];
  /** Explicit profile to resolve against, when one is intended. */
  requestedDeliveryId: string | null;
  timeline?: { fps_num: number; fps_den: number; width: number; height: number; output_aspect_ratio?: string } | null;
}): ResolvedCanvas {
  const profile = options.requestedDeliveryId
    ? options.profiles.find((p) => p.profile_id === options.requestedDeliveryId)
    : undefined;
  if (profile) {
    const parsed = profile.aspect_ratio && profile.aspect_ratio !== "custom"
      ? parseAspectRatio(profile.aspect_ratio)
      : null;
    const fromResolution =
      profile.resolution_width && profile.resolution_height
        ? aspectFromDimensions(profile.resolution_width, profile.resolution_height)
        : null;
    const chosen = parsed ?? fromResolution;
    if (chosen) {
      return {
        aspect_ratio_label: chosen.label,
        aspect: chosen.aspect,
        width: profile.resolution_width,
        height: profile.resolution_height,
        fps_num: fpsFromMode(profile.fps_mode),
        fps_den: fpsFromMode(profile.fps_mode) ? 1 : null,
        basis: "delivery_profile",
      };
    }
  }
  if (options.timeline) {
    const parsed = options.timeline.output_aspect_ratio
      ? parseAspectRatio(options.timeline.output_aspect_ratio)
      : null;
    const fromDimensions = aspectFromDimensions(options.timeline.width, options.timeline.height);
    const chosen = parsed ?? fromDimensions;
    if (chosen) {
      return {
        aspect_ratio_label: chosen.label,
        aspect: chosen.aspect,
        width: options.timeline.width,
        height: options.timeline.height,
        fps_num: options.timeline.fps_num,
        fps_den: options.timeline.fps_den,
        basis: "timeline_sequence",
      };
    }
  }
  return {
    aspect_ratio_label: "unspecified",
    aspect: null,
    width: null,
    height: null,
    fps_num: null,
    fps_den: null,
    basis: "unspecified",
  };
}

function fpsFromMode(mode: string | null): number | null {
  const match = /^cfr_(\d+(?:\.\d+)?)$/.exec(mode ?? "");
  return match ? Number(match[1]) : null;
}

// ── Framing plan ────────────────────────────────────────────────────

export interface NormalizedRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

const ASPECT_EPSILON = 0.005;

/**
 * Compute the framing plan for one beat.
 *
 * - sourceAspect unknown → fit "unknown"; no crop invented.
 * - authored transform (registered visual intent crop) wins when provided.
 * - otherwise a deterministic centered cover-crop preview is computed and
 *   explicitly labeled as the default preview, never as an authored decision.
 */
export function computeFramingPlan(options: {
  canvas: ResolvedCanvas;
  sourceAspect: number | null;
  authoredCropRect?: NormalizedRect | null;
  canvasLabelOverride?: string;
}): FramingPlan {
  const canvas = options.canvas;
  const canvasAspect = canvas.aspect;

  if (canvasAspect === null || options.sourceAspect === null) {
    return {
      canvas,
      fit: "unknown",
      crop_rect: null,
      crop_basis: "none",
      note:
        canvasAspect === null
          ? "delivery aspect is unspecified; showing the source frame without framing assumptions"
          : "source aspect could not be determined (source file missing or not probeable); framed preview shows the delivery canvas with the source contained",
      safe_overlays: [],
      safe_area_note: "",
      primary_frame_relative_path: null,
    };
  }

  const ratio = options.sourceAspect / canvasAspect;
  let fit: FramingPlan["fit"];
  let cropRect: NormalizedRect | null = null;

  if (Math.abs(ratio - 1) <= ASPECT_EPSILON) {
    fit = "passthrough";
  } else if (options.authoredCropRect) {
    fit = ratio > 1 ? "crop" : "crop";
    cropRect = clampRect(options.authoredCropRect);
  } else if (ratio > 1) {
    // Source is wider than the canvas: horizontal center cover-crop.
    fit = "crop";
    const width = canvasAspect / options.sourceAspect;
    cropRect = { x: (1 - width) / 2, y: 0, width, height: 1 };
  } else {
    // Source is taller than the canvas: vertical center cover-crop.
    fit = "crop";
    const height = options.sourceAspect / canvasAspect;
    cropRect = { x: 0, y: (1 - height) / 2, width: 1, height };
  }

  const cropBasis: FramingPlan["crop_basis"] =
    fit === "crop" ? (options.authoredCropRect ? "registered_visual_intent" : "default_center_cover") : "none";

  const note = buildFramingNote({
    fit,
    canvasLabel: options.canvasLabelOverride ?? canvas.aspect_ratio_label,
    cropRect,
    authored: Boolean(options.authoredCropRect),
    sourceAspect: options.sourceAspect,
    canvasAspect,
  });

  return {
    canvas,
    fit,
    crop_rect: cropRect,
    crop_basis: cropBasis,
    note,
    safe_overlays: [],
    safe_area_note: "",
    primary_frame_relative_path: null,
  };
}

function clampRect(rect: NormalizedRect): NormalizedRect {
  const x = Math.min(Math.max(rect.x, 0), 1);
  const y = Math.min(Math.max(rect.y, 0), 1);
  const width = Math.min(Math.max(rect.width, 0.01), 1 - x);
  const height = Math.min(Math.max(rect.height, 0.01), 1 - y);
  return { x, y, width, height };
}

function buildFramingNote(options: {
  fit: FramingPlan["fit"];
  canvasLabel: string;
  cropRect: NormalizedRect | null;
  authored: boolean;
  sourceAspect: number;
  canvasAspect: number;
}): string {
  switch (options.fit) {
    case "passthrough":
      return `source aspect matches the ${options.canvasLabel} canvas; no crop applied`;
    case "crop": {
      const basis = options.authored
        ? "crop rect from the project's registered visual intent"
        : "default centered cover-crop preview (no authored reframe found)";
      return `source (${round6(options.sourceAspect)}) is ${
        options.sourceAspect > options.canvasAspect ? "wider" : "taller"
      } than the ${options.canvasLabel} canvas; ${basis}`;
    }
    case "letterbox":
      return `source contained inside the ${options.canvasLabel} canvas with letterbox bars`;
    case "pillarbox":
      return `source contained inside the ${options.canvasLabel} canvas with pillarbox bars`;
    default:
      return "framing cannot be projected from available artifacts";
  }
}

/**
 * Geometry for rendering the framed preview in HTML/CSS without scripts:
 * percentages for the <img> inside the fixed-aspect canvas element.
 */
export function framedPreviewGeometry(
  plan: FramingPlan,
  sourceAspect: number | null,
): { imgWidthPercent: number; imgHeightPercent: number; imgLeftPercent: number; imgTopPercent: number } {
  const canvasAspect = plan.canvas.aspect;
  if (canvasAspect === null || sourceAspect === null) {
    return { imgWidthPercent: 100, imgHeightPercent: 100, imgLeftPercent: 0, imgTopPercent: 0 };
  }
  if (plan.fit === "crop" && plan.crop_rect) {
    return {
      imgWidthPercent: round4((1 / plan.crop_rect.width) * 100),
      imgHeightPercent: round4((1 / plan.crop_rect.height) * 100),
      imgLeftPercent: round4(-plan.crop_rect.x / plan.crop_rect.width * 100),
      imgTopPercent: round4(-plan.crop_rect.y / plan.crop_rect.height * 100),
    };
  }
  const ratio = sourceAspect / canvasAspect;
  if (ratio > 1) {
    return { imgWidthPercent: 100, imgHeightPercent: round4((ratio * 100)), imgLeftPercent: 0, imgTopPercent: round4(-((ratio - 1) / 2) * 100) };
  }
  return { imgWidthPercent: round4((100 / ratio)), imgHeightPercent: 100, imgLeftPercent: round4(-((1 / ratio - 1) / 2) * 100), imgTopPercent: 0 };
}

function round4(value: number): number {
  return Number(value.toFixed(4));
}

function round6(value: number): string {
  return String(Number(value.toFixed(6)));
}

// ── Safe-area overlays (policy-derived only) ────────────────────────

const DELIVERY_PLATFORM_TO_SAFE_ZONE_PLATFORM: Record<string, "instagram" | "tiktok" | "youtube_shorts" | "fixture"> = {
  instagram: "instagram",
  instagram_reel: "instagram",
  instagram_feed: "instagram",
  tiktok: "tiktok",
  shorts: "youtube_shorts",
  youtube_shorts: "youtube_shorts",
};

export interface SafeAreaSelection {
  overlays: FramingPlan["safe_overlays"];
  note: string;
  evidence_status: string | null;
}

/**
 * Resolve safe-area overlay rectangles strictly from a registered platform
 * safe-zone profile. When no policy applies the overlay list stays empty and
 * the note says so — nothing platform-specific is assumed.
 */
export function selectSafeAreaOverlays(options: {
  rootDir: string;
  delivery: LoadedDeliveryProfileInfo | null;
}): SafeAreaSelection {
  const platformKey = options.delivery
    ? DELIVERY_PLATFORM_TO_SAFE_ZONE_PLATFORM[options.delivery.platform]
    : undefined;
  if (!platformKey) {
    return {
      overlays: [],
      note: options.delivery
        ? `no safe-area policy registered for platform "${options.delivery.platform}"; overlays omitted`
        : "no delivery profile; safe-area overlays omitted",
      evidence_status: null,
    };
  }
  try {
    const selection = selectPlatformSafeZoneProfile({ rootDir: options.rootDir, platform: platformKey, surface: "organic" });
    const regions = selection.profile?.profile.geometry.safe_regions.regions ?? [];
    const uiRegions = selection.profile?.profile.geometry.ui_regions.regions ?? [];
    const overlays = [...regions, ...uiRegions].map((region) => ({
      id: region.id,
      kind: region.kind,
      rect: region.rect,
      label: `${region.kind}:${region.id}`,
    }));
    if (overlays.length === 0) {
      return {
        overlays: [],
        note: `safe-zone profile "${selection.profile?.profile.profile_id ?? platformKey}" carries no measured regions; overlays omitted`,
        evidence_status: selection.profile?.profile.evidence_status ?? null,
      };
    }
    return {
      overlays,
      note: `safe-area overlay from platform safe-zone profile "${
        selection.profile?.profile.profile_id ?? ""
      }" (evidence: ${selection.status})`,
      evidence_status: selection.profile?.profile.evidence_status ?? null,
    };
  } catch (error) {
    return {
      overlays: [],
      note: `safe-zone profile could not be loaded (${
        error instanceof Error ? error.message : String(error)
      }); overlays omitted`,
      evidence_status: null,
    };
  }
}
