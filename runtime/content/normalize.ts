import { resolveContentTemplate } from "./template-registry.js";
import type {
  ContentAnchor,
  ContentElementLayout,
  ContentElementV1,
  ContentRendererId,
  JSONValue,
} from "./types.js";
import { validateContentElement, type ContentElementIssue } from "./validation.js";
import { resolveCreativeRenderer } from "./creative-recipe.js";

export interface OverlayClipLike {
  clip_id: string;
  content_element?: unknown;
  metadata?: Record<string, unknown>;
}

export interface NormalizedOverlayContent {
  element: ContentElementV1 | null;
  renderer_owner: ContentRendererId | null;
  source: "canonical" | "legacy" | "legacy-remotion" | "invalid";
  issues: ContentElementIssue[];
}

const LEGACY_HYPERFRAMES_MAP: Record<string, string> = {
  "vos:overlay.chapter-kicker": "vos:content.section-label/v1",
  "vos:overlay.lower-third": "vos:content.lower-third/v1",
};

const LEGACY_REMOTION_ONLY = new Set([
  "vos:overlay.title-card",
  "vos:overlay.hook-title",
  "vos:overlay.cta-card",
  "vos:overlay.location-tag",
  "vos:overlay.credit",
]);

const LEGACY_STYLE_ALIASES: Record<string, string> = {
  "title-card": "vos:overlay.title-card",
  "hook-title": "vos:overlay.hook-title",
  "cta-card": "vos:overlay.cta-card",
  "lower-third": "vos:overlay.lower-third",
  "chapter-kicker": "vos:overlay.chapter-kicker",
  "location-tag": "vos:overlay.location-tag",
  credit: "vos:overlay.credit",
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function legacyAnchor(value: unknown, fallback: ContentAnchor): ContentAnchor {
  if (typeof value !== "string") return fallback;
  const normalized = value.replaceAll("-", "_");
  const aliases: Record<string, ContentAnchor> = {
    top_left: "top_left",
    top_center: "top_center",
    top_right: "top_right",
    center_left: "center_left",
    center: "center",
    center_right: "center_right",
    bottom_left: "bottom_left",
    center_bottom: "bottom_center",
    bottom_center: "bottom_center",
    bottom_right: "bottom_right",
  };
  return aliases[normalized] ?? fallback;
}

function defaultLayout(anchor: ContentAnchor): ContentElementLayout {
  return {
    anchor,
    x: 0,
    y: 0,
    scale: 1,
    rotation_deg: 0,
    opacity: 1,
    safe_area: true,
    z_index: 100,
  };
}

function ownerFor(element: ContentElementV1): ContentRendererId | null {
  const manifest = element.template_ref
    ? resolveContentTemplate(element.template_ref)
    : null;
  if (element.template_ref && manifest === null) return null;
  return resolveCreativeRenderer(element, manifest);
}

function invalidIssue(path: string, message: string): ContentElementIssue {
  return { path, code: "unknown_template", message };
}

export function normalizeOverlayClipContent(clip: OverlayClipLike): NormalizedOverlayContent {
  const metadata = asRecord(clip.metadata);
  const canonical = clip.content_element ?? metadata?.content_element;
  if (canonical !== undefined) {
    const validation = validateContentElement(canonical);
    if (!validation.ok || validation.value === undefined) {
      return { element: null, renderer_owner: null, source: "invalid", issues: validation.issues };
    }
    return {
      element: validation.value,
      renderer_owner: ownerFor(validation.value),
      source: "canonical",
      issues: [],
    };
  }

  const overlay = asRecord(metadata?.overlay);
  const rawStylingClass = typeof overlay?.styling_class === "string" ? overlay.styling_class : null;
  const stylingClass = rawStylingClass === null
    ? null
    : LEGACY_STYLE_ALIASES[rawStylingClass] ?? rawStylingClass;
  if (!overlay || stylingClass === null) {
    return {
      element: null,
      renderer_owner: null,
      source: "invalid",
      issues: [invalidIssue("metadata.overlay", "Overlay clip has no content_element or legacy styling_class")],
    };
  }

  if (LEGACY_REMOTION_ONLY.has(stylingClass)) {
    return { element: null, renderer_owner: "remotion", source: "legacy-remotion", issues: [] };
  }

  const templateRef = LEGACY_HYPERFRAMES_MAP[stylingClass];
  const manifest = templateRef ? resolveContentTemplate(templateRef) : null;
  if (manifest === null) {
    return {
      element: null,
      renderer_owner: null,
      source: "invalid",
      issues: [invalidIssue("metadata.overlay.styling_class", `Unknown legacy styling_class ${stylingClass}`)],
    };
  }

  const text = typeof overlay.text === "string" ? overlay.text : "";
  const props: Record<string, JSONValue> = stylingClass === "vos:overlay.lower-third"
    ? { name: text }
    : { title: text };
  const element: ContentElementV1 = {
    version: "content-element/v1",
    element_id: typeof overlay.overlay_id === "string" ? overlay.overlay_id : clip.clip_id,
    kind: "template",
    template_ref: manifest.id,
    template_version: manifest.version,
    props,
    layout: defaultLayout(legacyAnchor(overlay.anchor, manifest.default_anchor)),
    animation: { in: { preset: "fade-rise", duration_frames: 12 } },
    renderer_hint: "auto",
  };
  const validation = validateContentElement(element);
  if (!validation.ok) {
    return { element: null, renderer_owner: null, source: "invalid", issues: validation.issues };
  }

  return { element, renderer_owner: manifest.preferred_renderer, source: "legacy", issues: [] };
}
