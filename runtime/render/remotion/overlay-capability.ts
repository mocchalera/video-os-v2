import { createHash } from "node:crypto";
import type { ClipOutput, TimelineIR } from "../../compiler/types.js";
import type { ContentElementV1, CreativeCompositeStage } from "../../content/types.js";
import { normalizeOverlayClipContent } from "../../content/normalize.js";
import { resolveRemotionOverlayClip } from "./overlay-clip-resolver.js";
import { resolveOverlayPreset } from "./styles/overlay-presets.js";

/**
 * Single versioned definition of which ContentElement layout/animation
 * fields this Remotion renderer actually honors. Plain data + pure
 * functions on purpose: no registry, no plugin surface.
 */

export const REMOTION_OVERLAY_CAPABILITY_VERSION = "remotion-overlay-capability/v1";

export interface RemotionOverlayCapabilityMatrix {
  /** Capability contract identity; see REMOTION_OVERLAY_CAPABILITY_VERSION. */
  version: string;
  renderer: "remotion";
  layout_fields: readonly string[];
  animation: {
    phases: readonly string[];
    presets: readonly string[];
    ref_fields: readonly string[];
  };
}

/** Mirrors ContentElementLayout — every field M1 rendering resolves. */
export const REMOTION_OVERLAY_CAPABILITY_MATRIX: RemotionOverlayCapabilityMatrix = {
  version: REMOTION_OVERLAY_CAPABILITY_VERSION,
  renderer: "remotion",
  layout_fields: [
    "anchor",
    "x",
    "y",
    "width",
    "height",
    "scale",
    "rotation_deg",
    "opacity",
    "safe_area",
    "z_index",
  ],
  // Existing safe vocabulary only: the registered overlay presets realize
  // fade / rise motion themselves (verified to reach the drawn frames).
  // Canonical refs outside it — including "none", which no preset can
  // honor because every preset animates — stay gated as unsupported.
  animation: {
    phases: ["in"],
    presets: ["fade", "fade-rise"],
    ref_fields: ["preset", "duration_frames", "delay_frames"],
  },
};

export function remotionCapabilityIdentityHash(
  matrix: RemotionOverlayCapabilityMatrix = REMOTION_OVERLAY_CAPABILITY_MATRIX,
): string {
  return createHash("sha256").update(JSON.stringify(matrix)).digest("hex");
}

export interface ResolvedOverlayLayoutIdentity {
  element_id: string;
  clip_id: string;
  layout: ContentElementV1["layout"];
  animation_in?: {
    preset: string;
    duration_frames?: number;
    delay_frames?: number;
  };
}

export interface RemotionOverlayCapabilityViolation {
  element_id: string;
  clip_id: string;
  field: string;
  renderer: string;
  reason: string;
}

export interface RemotionOverlayCapabilityReport {
  ok: boolean;
  capability_version: string;
  capability_sha256: string;
  resolved_layouts: ResolvedOverlayLayoutIdentity[];
  violations: RemotionOverlayCapabilityViolation[];
}

export interface InspectRemotionOverlayOptions {
  /** Only inspect clips whose creative_recipe.composite_stage matches (default: under_caption, mirroring layer selection). */
  compositeStage?: CreativeCompositeStage;
  /** Only inspect clips whose creative_recipe.requires_base_frame matches this flag. */
  requiresBaseFrame?: boolean;
  /** Only inspect clips whose element id was explicitly requested. */
  elementIds?: string[];
}

function violation(
  elementId: string,
  clipId: string,
  field: string,
  reason: string,
): RemotionOverlayCapabilityViolation {
  return { element_id: elementId, clip_id: clipId, field, renderer: "remotion", reason };
}

/**
 * True when no implemented renderer claims this element, so every render
 * path would silently drop it. Template elements route through the
 * template registry; non-template elements only have an implementation
 * when they carry an explicit supported renderer hint or a native_filter
 * recipe (executed by ffmpeg). Everything else — including raw auto-hinted
 * kinds that merely fall through to the ffmpeg default — is unowned.
 */
export function isUnownedElement(
  element: ContentElementV1,
  owner: "ffmpeg" | "remotion" | "hyperframes" | null,
): { unowned: boolean; field: string } {
  if (element.template_ref) return { unowned: false, field: "" };
  if (element.creative_recipe?.authoring_surface === "native_filter") {
    return { unowned: false, field: "" };
  }
  if (owner === null) return { unowned: true, field: "renderer_hint" };
  const explicitHint = element.renderer_hint !== undefined && element.renderer_hint !== "auto";
  return explicitHint
    ? { unowned: false, field: "" }
    : { unowned: true, field: "template_ref" };
}

function scopedClip(
  recipe: ContentElementV1["creative_recipe"],
  options: InspectRemotionOverlayOptions,
): boolean {
  if (options.requiresBaseFrame !== undefined) {
    if ((recipe?.requires_base_frame === true) !== options.requiresBaseFrame) return false;
  }
  if (options.compositeStage !== undefined && (recipe?.composite_stage ?? "under_caption") !== options.compositeStage) {
    return false;
  }
  return true;
}

/**
 * Pure inspection of a timeline's overlay clips against the Remotion
 * capability matrix. Everything the renderer would otherwise silently
 * drop (invalid element, unsupported template/preset/field) becomes an
 * explicit violation carrying element id and field/renderer names.
 */
export function inspectRemotionOverlayCapabilities(
  timeline: TimelineIR,
  options: InspectRemotionOverlayOptions = {},
): RemotionOverlayCapabilityReport {
  const resolvedLayouts: ResolvedOverlayLayoutIdentity[] = [];
  const violations: RemotionOverlayCapabilityViolation[] = [];
  const requested = options.elementIds ? new Set(options.elementIds) : undefined;
  const tracks = timeline.tracks as TimelineIR["tracks"] & {
    overlay?: TimelineIR["tracks"]["video"];
  };
  for (const track of tracks.overlay ?? []) {
    for (const clip of track.clips) {
      const normalized = normalizeOverlayClipContent(clip);
      const rawElement = (clip.metadata as Record<string, unknown> | undefined)?.content_element
        ?? (clip as unknown as Record<string, unknown>).content_element;
      const rawElementId = rawElement && typeof rawElement === "object"
        ? (rawElement as Record<string, unknown>).element_id
        : undefined;

      if (normalized.source === "invalid") {
        // Invalid elements are unreadable; fail closed unless an explicit
        // request targets other elements only.
        if (!requested || requested.has(clip.clip_id) || requested.has(String(rawElementId))) {
          const issue = normalized.issues[0];
          violations.push(violation(
            String(rawElementId ?? clip.clip_id),
            clip.clip_id,
            issue?.path ?? "content_element",
            `invalid_content_element: ${issue?.message ?? "unreadable"}`,
          ));
        }
        continue;
      }
      const element = normalized.element;
      if (normalized.renderer_owner !== "remotion") {
        // An element no implemented renderer claims is silently dropped by
        // every render path; fail closed instead of losing it.
        const ownership = element ? isUnownedElement(element, normalized.renderer_owner) : undefined;
        if (element && ownership?.unowned) {
          const ownerId = element.element_id;
          if (!requested || requested.has(ownerId) || requested.has(clip.clip_id)) {
            violations.push(violation(ownerId, clip.clip_id, ownership.field, "no_renderer_owner"));
          }
        }
        continue; // routed to another renderer
      }
      if (!scopedClip(element?.creative_recipe, options)) continue;

      const elementId = normalized.element?.element_id ?? clip.clip_id;
      if (requested && !requested.has(elementId)) continue;

      if (!element) {
        // Legacy remotion preset metadata without a canonical element:
        // resolution must still succeed for the render to proceed.
        const resolvedLegacy = resolveRemotionOverlayClip(clip as unknown as ClipOutput);
        if (!resolvedLegacy || resolveOverlayPreset(resolvedLegacy.presetId) === null) {
          violations.push(violation(elementId, clip.clip_id, "template_ref", "unsupported_remotion_template"));
        }
        continue;
      }

      // Unknown layout fields cannot be honored by the M1 layout mapping.
      for (const key of Object.keys(element.layout)) {
        if (!REMOTION_OVERLAY_CAPABILITY_MATRIX.layout_fields.includes(key)) {
          violations.push(violation(elementId, clip.clip_id, `layout.${key}`, "unsupported_layout_field"));
        }
      }

      // Remotion-owned elements must resolve to a registered overlay preset.
      const resolved = resolveRemotionOverlayClip(clip as unknown as ClipOutput);
      if (!resolved) {
        violations.push(violation(elementId, clip.clip_id, "template_ref", "unsupported_remotion_template"));
        continue;
      }
      if (resolveOverlayPreset(resolved.presetId) === null) {
        violations.push(violation(elementId, clip.clip_id, `preset:${resolved.presetId}`, "unknown_overlay_preset"));
      }

      const animation = element.animation;
      let animationIn: ResolvedOverlayLayoutIdentity["animation_in"];
      if (animation !== undefined) {
        for (const phase of Object.keys(animation) as Array<keyof NonNullable<ContentElementV1["animation"]>>) {
          if (!REMOTION_OVERLAY_CAPABILITY_MATRIX.animation.phases.includes(phase)) {
            violations.push(violation(elementId, clip.clip_id, `animation.${phase}`, "unsupported_animation_phase"));
            continue;
          }
          const ref = animation[phase];
          if (!ref) continue;
          if (!REMOTION_OVERLAY_CAPABILITY_MATRIX.animation.presets.includes(ref.preset)) {
            violations.push(violation(elementId, clip.clip_id, `animation.${phase}.preset`, `unsupported_animation_preset:${ref.preset}`));
          }
          for (const key of Object.keys(ref)) {
            if (!REMOTION_OVERLAY_CAPABILITY_MATRIX.animation.ref_fields.includes(key)) {
              violations.push(violation(elementId, clip.clip_id, `animation.${phase}.${key}`, "unsupported_animation_field"));
            }
          }
          if (phase === "in") {
            animationIn = {
              preset: ref.preset,
              ...(ref.duration_frames !== undefined ? { duration_frames: ref.duration_frames } : {}),
              ...(ref.delay_frames !== undefined ? { delay_frames: ref.delay_frames } : {}),
            };
          }
        }
      }

      resolvedLayouts.push({
        element_id: elementId,
        clip_id: clip.clip_id,
        layout: element.layout,
        ...(animationIn ? { animation_in: animationIn } : {}),
      });
    }
  }

  return {
    ok: violations.length === 0,
    capability_version: REMOTION_OVERLAY_CAPABILITY_VERSION,
    capability_sha256: remotionCapabilityIdentityHash(),
    resolved_layouts: resolvedLayouts,
    violations,
  };
}

/**
 * Fail-closed preflight: throws before any bundle/renderMedia call when a
 * timeline element exceeds the Remotion capability matrix.
 */
export function assertRemotionOverlayCapabilities(
  timeline: TimelineIR,
  options: InspectRemotionOverlayOptions = {},
): RemotionOverlayCapabilityReport {
  const report = inspectRemotionOverlayCapabilities(timeline, options);
  if (!report.ok) {
    const detail = report.violations
      .map((v) => `element=${v.element_id} field=${v.field} renderer=${v.renderer} reason=${v.reason}`)
      .join("; ");
    throw new Error(`remotion_overlay_capability_violation: ${detail}`);
  }
  return report;
}
