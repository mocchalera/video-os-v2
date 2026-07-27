import type { ClipOutput } from "../../compiler/types.js";
import { normalizeOverlayClipContent } from "../../content/normalize.js";
import {
  getOverlayText,
  type OverlayPresetProps,
} from "./styles/overlay-presets.js";

export interface ResolvedRemotionOverlayClip {
  presetId: string;
  text: string;
  actionText?: string;
  brandText?: string;
  writingMode?: OverlayPresetProps["writing_mode"];
  anchor?: string;
  safeArea?: OverlayPresetProps["safe_area"];
}

type OverlayMetadata = {
  styling_class?: unknown;
  writing_mode?: unknown;
  anchor?: unknown;
  safe_area?: unknown;
};

function overlayMetadata(clip: ClipOutput): OverlayMetadata | null {
  const overlay = clip.metadata?.overlay;
  if (!overlay || typeof overlay !== "object") {
    return null;
  }

  return overlay as OverlayMetadata;
}

function overlayString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function overlayWritingMode(value: unknown): OverlayPresetProps["writing_mode"] | undefined {
  if (value === "horizontal_tb" || value === "vertical_rl" || value === "vertical_lr") {
    return value;
  }

  return undefined;
}

function overlaySafeArea(value: unknown): OverlayPresetProps["safe_area"] | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const input = value as Record<string, unknown>;
  return {
    top: typeof input.top === "number" ? input.top : undefined,
    right: typeof input.right === "number" ? input.right : undefined,
    bottom: typeof input.bottom === "number" ? input.bottom : undefined,
    left: typeof input.left === "number" ? input.left : undefined,
  };
}

function contentAnchor(anchor: string): string {
  return anchor.replaceAll("_", "-");
}

/**
 * Resolve the declarative overlay dialect understood by the production
 * Remotion renderer. This deliberately maps only registered templates and
 * legacy preset metadata; arbitrary JSX is not accepted as project input.
 */
export function resolveRemotionOverlayClip(
  clip: ClipOutput,
): ResolvedRemotionOverlayClip | null {
  const normalized = normalizeOverlayClipContent(clip);
  if (normalized.renderer_owner !== "remotion") return null;

  if (normalized.element) {
    const templateRef = normalized.element.template_ref;
    if (templateRef === "vos:content.title-card/v1") {
      return {
        presetId: "vos:overlay.title-card",
        text: String(normalized.element.props.title ?? ""),
        anchor: contentAnchor(normalized.element.layout.anchor),
      };
    }
    if (templateRef === "vos:content.hook-title/v1") {
      return {
        presetId: "vos:overlay.hook-title",
        text: String(normalized.element.props.title ?? ""),
        anchor: contentAnchor(normalized.element.layout.anchor),
      };
    }
    if (templateRef === "vos:content.cta-card/v1") {
      return {
        presetId: "vos:overlay.cta-card",
        text: String(normalized.element.props.headline ?? ""),
        actionText: String(normalized.element.props.action ?? ""),
        brandText: typeof normalized.element.props.brand === "string"
          ? normalized.element.props.brand
          : undefined,
        anchor: contentAnchor(normalized.element.layout.anchor),
      };
    }
    if (templateRef === "vos:content.emphasis-word/v1") {
      return {
        presetId: "vos:overlay.emphasis-word",
        text: String(normalized.element.props.text ?? ""),
        anchor: contentAnchor(normalized.element.layout.anchor),
      };
    }
    if (templateRef === "vos:content.section-label/v1") {
      return {
        presetId: "vos:overlay.chapter-kicker",
        text: String(normalized.element.props.title ?? ""),
        anchor: contentAnchor(normalized.element.layout.anchor),
      };
    }
    if (templateRef === "vos:content.lower-third/v1") {
      const name = String(normalized.element.props.name ?? "");
      const role = typeof normalized.element.props.role === "string"
        ? normalized.element.props.role
        : "";
      return {
        presetId: "vos:overlay.lower-third",
        text: role ? `${name}\n${role}` : name,
        anchor: contentAnchor(normalized.element.layout.anchor),
      };
    }
    return null;
  }

  const text = getOverlayText(clip.metadata);
  const overlay = overlayMetadata(clip);
  const stylingClass = overlayString(overlay?.styling_class);
  if (text === null || !stylingClass) return null;
  return {
    presetId: stylingClass,
    text,
    writingMode: overlayWritingMode(overlay?.writing_mode),
    anchor: overlayString(overlay?.anchor) === undefined
      ? undefined
      : contentAnchor(overlayString(overlay?.anchor)!),
    safeArea: overlaySafeArea(overlay?.safe_area),
  };
}
