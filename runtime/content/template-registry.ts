import type { ContentAnchor, ContentRendererId, JSONValue } from "./types.js";

export const CONTENT_TEMPLATE_IDS = [
  "vos:content.section-label/v1",
  "vos:content.question-card/v1",
  "vos:content.lower-third/v1",
  "vos:content.logo-bug/v1",
  "vos:content.title-card/v1",
  "vos:content.hook-title/v1",
  "vos:content.cta-card/v1",
  "vos:content.emphasis-word/v1",
] as const;

export type ContentTemplateId = (typeof CONTENT_TEMPLATE_IDS)[number];
export type ContentAspectRatio = "16:9" | "9:16" | "1:1" | "4:5";
export type ContentTemplatePropType = "string" | "asset_id";

export interface ContentTemplatePropDefinition {
  type: ContentTemplatePropType;
  required?: boolean;
  min_length?: number;
  max_length?: number;
}

export interface ContentTemplateManifest {
  id: ContentTemplateId;
  version: "1.0.0";
  semantic_role: "section_label" | "question" | "lower_third" | "logo_bug" | "title" | "cta" | "emphasis";
  props: Record<string, ContentTemplatePropDefinition>;
  additional_props: false;
  supported_aspect_ratios: readonly ContentAspectRatio[];
  default_anchor: ContentAnchor;
  preferred_renderer: ContentRendererId;
  fallback_renderers: readonly ContentRendererId[];
  preview: "exact" | "proxy_and_exact";
  font_policy: "bundled-font-v1";
  accessibility_label_prop: string;
}

const COMMON_RATIOS = ["16:9", "9:16", "1:1", "4:5"] as const;

const manifests: ContentTemplateManifest[] = [
  {
    id: "vos:content.section-label/v1",
    version: "1.0.0",
    semantic_role: "section_label",
    props: {
      title: { type: "string", required: true, min_length: 1, max_length: 80 },
      eyebrow: { type: "string", max_length: 40 },
    },
    additional_props: false,
    supported_aspect_ratios: COMMON_RATIOS,
    default_anchor: "top_left",
    preferred_renderer: "hyperframes",
    fallback_renderers: ["remotion"],
    preview: "proxy_and_exact",
    font_policy: "bundled-font-v1",
    accessibility_label_prop: "title",
  },
  {
    id: "vos:content.question-card/v1",
    version: "1.0.0",
    semantic_role: "question",
    props: {
      question: { type: "string", required: true, min_length: 1, max_length: 180 },
      label: { type: "string", max_length: 24 },
    },
    additional_props: false,
    supported_aspect_ratios: COMMON_RATIOS,
    default_anchor: "center",
    preferred_renderer: "hyperframes",
    fallback_renderers: [],
    preview: "proxy_and_exact",
    font_policy: "bundled-font-v1",
    accessibility_label_prop: "question",
  },
  {
    id: "vos:content.lower-third/v1",
    version: "1.0.0",
    semantic_role: "lower_third",
    props: {
      name: { type: "string", required: true, min_length: 1, max_length: 80 },
      role: { type: "string", max_length: 100 },
    },
    additional_props: false,
    supported_aspect_ratios: COMMON_RATIOS,
    default_anchor: "bottom_left",
    preferred_renderer: "hyperframes",
    fallback_renderers: ["remotion"],
    preview: "proxy_and_exact",
    font_policy: "bundled-font-v1",
    accessibility_label_prop: "name",
  },
  {
    id: "vos:content.logo-bug/v1",
    version: "1.0.0",
    semantic_role: "logo_bug",
    props: {
      asset_id: { type: "asset_id", required: true, min_length: 1, max_length: 160 },
      alt: { type: "string", max_length: 120 },
    },
    additional_props: false,
    supported_aspect_ratios: COMMON_RATIOS,
    default_anchor: "top_right",
    preferred_renderer: "hyperframes",
    fallback_renderers: [],
    preview: "exact",
    font_policy: "bundled-font-v1",
    accessibility_label_prop: "alt",
  },
  {
    id: "vos:content.title-card/v1",
    version: "1.0.0",
    semantic_role: "title",
    props: {
      title: { type: "string", required: true, min_length: 1, max_length: 120 },
      kicker: { type: "string", max_length: 40 },
    },
    additional_props: false,
    supported_aspect_ratios: COMMON_RATIOS,
    default_anchor: "top_center",
    preferred_renderer: "remotion",
    fallback_renderers: [],
    preview: "exact",
    font_policy: "bundled-font-v1",
    accessibility_label_prop: "title",
  },
  {
    id: "vos:content.hook-title/v1",
    version: "1.0.0",
    semantic_role: "title",
    props: {
      title: { type: "string", required: true, min_length: 1, max_length: 80 },
    },
    additional_props: false,
    supported_aspect_ratios: COMMON_RATIOS,
    default_anchor: "top_left",
    preferred_renderer: "remotion",
    fallback_renderers: [],
    preview: "exact",
    font_policy: "bundled-font-v1",
    accessibility_label_prop: "title",
  },
  {
    id: "vos:content.cta-card/v1",
    version: "1.0.0",
    semantic_role: "cta",
    props: {
      headline: { type: "string", required: true, min_length: 1, max_length: 80 },
      action: { type: "string", required: true, min_length: 1, max_length: 60 },
      brand: { type: "string", max_length: 40 },
    },
    additional_props: false,
    supported_aspect_ratios: COMMON_RATIOS,
    default_anchor: "center",
    preferred_renderer: "remotion",
    fallback_renderers: [],
    preview: "exact",
    font_policy: "bundled-font-v1",
    accessibility_label_prop: "headline",
  },
  {
    id: "vos:content.emphasis-word/v1",
    version: "1.0.0",
    semantic_role: "emphasis",
    props: {
      text: { type: "string", required: true, min_length: 1, max_length: 32 },
    },
    additional_props: false,
    supported_aspect_ratios: COMMON_RATIOS,
    default_anchor: "center",
    preferred_renderer: "remotion",
    fallback_renderers: [],
    preview: "exact",
    font_policy: "bundled-font-v1",
    accessibility_label_prop: "text",
  },
];

export const contentTemplateRegistry = new Map<ContentTemplateId, ContentTemplateManifest>(
  manifests.map((manifest) => [manifest.id, manifest]),
);

export function resolveContentTemplate(templateRef: string): ContentTemplateManifest | null {
  return contentTemplateRegistry.get(templateRef as ContentTemplateId) ?? null;
}

export interface TemplatePropIssue {
  path: string;
  code: "unknown_prop" | "missing_prop" | "invalid_prop_type" | "invalid_prop_length";
  message: string;
}

export function validateTemplateProps(
  manifest: ContentTemplateManifest,
  props: Record<string, JSONValue>,
): TemplatePropIssue[] {
  const issues: TemplatePropIssue[] = [];

  for (const key of Object.keys(props)) {
    if (!(key in manifest.props)) {
      issues.push({
        path: `props.${key}`,
        code: "unknown_prop",
        message: `Template ${manifest.id} does not allow prop ${key}`,
      });
    }
  }

  for (const [key, definition] of Object.entries(manifest.props)) {
    const value = props[key];
    if (value === undefined) {
      if (definition.required) {
        issues.push({
          path: `props.${key}`,
          code: "missing_prop",
          message: `Template ${manifest.id} requires prop ${key}`,
        });
      }
      continue;
    }

    if (typeof value !== "string") {
      issues.push({
        path: `props.${key}`,
        code: "invalid_prop_type",
        message: `Template prop ${key} must be a string`,
      });
      continue;
    }

    const length = [...value].length;
    if (definition.min_length !== undefined && length < definition.min_length) {
      issues.push({
        path: `props.${key}`,
        code: "invalid_prop_length",
        message: `Template prop ${key} must contain at least ${definition.min_length} characters`,
      });
    }
    if (definition.max_length !== undefined && length > definition.max_length) {
      issues.push({
        path: `props.${key}`,
        code: "invalid_prop_length",
        message: `Template prop ${key} must contain at most ${definition.max_length} characters`,
      });
    }

    if (definition.type === "asset_id" && !/^[A-Za-z0-9._:-]+$/.test(value)) {
      issues.push({
        path: `props.${key}`,
        code: "invalid_prop_type",
        message: `Template prop ${key} must be a contained source-map asset_id`,
      });
    }
  }

  return issues;
}
