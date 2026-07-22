import { resolveContentTemplate, validateTemplateProps } from "./template-registry.js";
import type {
  ContentAnimationRef,
  ContentElementLayout,
  ContentElementV1,
  JSONValue,
} from "./types.js";

export type ContentElementIssueCode =
  | "invalid_shape"
  | "invalid_version"
  | "invalid_id"
  | "invalid_kind"
  | "invalid_layout"
  | "invalid_animation"
  | "invalid_json"
  | "unsafe_asset_reference"
  | "unknown_template"
  | "unsupported_renderer"
  | "invalid_template_props";

export interface ContentElementIssue {
  path: string;
  code: ContentElementIssueCode;
  message: string;
}

export interface ContentElementValidationResult {
  ok: boolean;
  issues: ContentElementIssue[];
  value?: ContentElementV1;
}

const KINDS = new Set(["text", "image", "shape", "svg", "template", "group"]);
const ANCHORS = new Set([
  "top_left",
  "top_center",
  "top_right",
  "center_left",
  "center",
  "center_right",
  "bottom_left",
  "bottom_center",
  "bottom_right",
]);
const RENDERERS = new Set(["auto", "ffmpeg", "remotion", "hyperframes"]);
export const CONTENT_ANIMATION_PRESETS = new Set([
  "none",
  "fade",
  "fade-rise",
  "slide-left",
  "slide-up",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function numberInRange(value: unknown, min: number, max: number): value is number {
  return finiteNumber(value) && value >= min && value <= max;
}

function looksLikeUnsafeReference(value: string, key: string | undefined): boolean {
  const normalized = value.trim().replaceAll("\\", "/");
  if (
    normalized.startsWith("/") ||
    normalized.startsWith("//") ||
    normalized.startsWith("./") ||
    /^[A-Za-z]:\//.test(normalized) ||
    /^file:/i.test(normalized) ||
    /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(normalized) ||
    normalized.split("/").includes("..")
  ) {
    return true;
  }

  if (key === undefined || key === "asset_id" || key === "template_asset_ref") {
    return false;
  }

  return /(?:^|_)(?:src|path|url|href|file|filename)$/.test(key);
}

function validateJSONValue(
  value: unknown,
  path: string,
  issues: ContentElementIssue[],
  key?: string,
  depth = 0,
): value is JSONValue {
  if (depth > 12) {
    issues.push({ path, code: "invalid_json", message: "Content props exceed maximum nesting depth" });
    return false;
  }

  if (value === null || typeof value === "boolean") return true;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      issues.push({ path, code: "invalid_json", message: "Content props must use finite numbers" });
      return false;
    }
    return true;
  }
  if (typeof value === "string") {
    if (looksLikeUnsafeReference(value, key)) {
      issues.push({
        path,
        code: "unsafe_asset_reference",
        message: "Raw paths and remote URLs are forbidden; use asset_id or an allow-listed template asset",
      });
      return false;
    }
    return true;
  }
  if (Array.isArray(value)) {
    if (value.length > 256) {
      issues.push({ path, code: "invalid_json", message: "Content prop arrays may contain at most 256 items" });
      return false;
    }
    return value.every((entry, index) => validateJSONValue(entry, `${path}[${index}]`, issues, undefined, depth + 1));
  }
  if (isRecord(value)) {
    if (Object.keys(value).length > 256) {
      issues.push({ path, code: "invalid_json", message: "Content prop objects may contain at most 256 fields" });
      return false;
    }
    return Object.entries(value).every(([entryKey, entry]) =>
      validateJSONValue(entry, `${path}.${entryKey}`, issues, entryKey, depth + 1),
    );
  }

  issues.push({ path, code: "invalid_json", message: "Content props must be JSON-safe" });
  return false;
}

function validateLayout(value: unknown, issues: ContentElementIssue[]): value is ContentElementLayout {
  if (!isRecord(value)) {
    issues.push({ path: "layout", code: "invalid_layout", message: "layout must be an object" });
    return false;
  }

  const checks: Array<[boolean, string]> = [
    [typeof value.anchor === "string" && ANCHORS.has(value.anchor), "anchor is invalid"],
    [numberInRange(value.x, 0, 1), "x must be between 0 and 1"],
    [numberInRange(value.y, 0, 1), "y must be between 0 and 1"],
    [value.width === undefined || numberInRange(value.width, 0.01, 1), "width must be between 0.01 and 1"],
    [value.height === undefined || numberInRange(value.height, 0.01, 1), "height must be between 0.01 and 1"],
    [numberInRange(value.scale, 0.05, 8), "scale must be between 0.05 and 8"],
    [numberInRange(value.rotation_deg, -360, 360), "rotation_deg must be between -360 and 360"],
    [numberInRange(value.opacity, 0, 1), "opacity must be between 0 and 1"],
    [typeof value.safe_area === "boolean", "safe_area must be boolean"],
    [Number.isInteger(value.z_index) && numberInRange(value.z_index, -1000, 1000), "z_index must be an integer between -1000 and 1000"],
  ];

  for (const [ok, message] of checks) {
    if (!ok) issues.push({ path: "layout", code: "invalid_layout", message });
  }
  return checks.every(([ok]) => ok);
}

function validateAnimationRef(
  value: unknown,
  path: string,
  issues: ContentElementIssue[],
): value is ContentAnimationRef {
  if (!isRecord(value) || typeof value.preset !== "string" || !CONTENT_ANIMATION_PRESETS.has(value.preset)) {
    issues.push({ path, code: "invalid_animation", message: "animation preset is not allow-listed" });
    return false;
  }
  for (const field of ["duration_frames", "delay_frames"] as const) {
    if (value[field] !== undefined && (!Number.isInteger(value[field]) || (value[field] as number) < 0)) {
      issues.push({ path: `${path}.${field}`, code: "invalid_animation", message: `${field} must be a non-negative integer` });
    }
  }
  return true;
}

export function validateContentElement(input: unknown): ContentElementValidationResult {
  const issues: ContentElementIssue[] = [];
  if (!isRecord(input)) {
    return { ok: false, issues: [{ path: "$", code: "invalid_shape", message: "Content element must be an object" }] };
  }

  if (input.version !== "content-element/v1") {
    issues.push({ path: "version", code: "invalid_version", message: "version must be content-element/v1" });
  }
  if (typeof input.element_id !== "string" || !/^[A-Za-z0-9._:-]+$/.test(input.element_id)) {
    issues.push({ path: "element_id", code: "invalid_id", message: "element_id contains unsupported characters" });
  }
  if (typeof input.kind !== "string" || !KINDS.has(input.kind)) {
    issues.push({ path: "kind", code: "invalid_kind", message: "kind is invalid" });
  }
  if (!isRecord(input.props)) {
    issues.push({ path: "props", code: "invalid_json", message: "props must be an object" });
  } else {
    validateJSONValue(input.props, "props", issues);
  }
  validateLayout(input.layout, issues);

  if (input.renderer_hint !== undefined && (typeof input.renderer_hint !== "string" || !RENDERERS.has(input.renderer_hint))) {
    issues.push({ path: "renderer_hint", code: "unsupported_renderer", message: "renderer_hint is invalid" });
  }

  if (input.animation !== undefined) {
    if (!isRecord(input.animation)) {
      issues.push({ path: "animation", code: "invalid_animation", message: "animation must be an object" });
    } else {
      for (const phase of ["in", "loop", "out"] as const) {
        if (input.animation[phase] !== undefined) {
          validateAnimationRef(input.animation[phase], `animation.${phase}`, issues);
        }
      }
    }
  }

  if (input.kind === "template" && typeof input.template_ref !== "string") {
    issues.push({ path: "template_ref", code: "unknown_template", message: "template elements require template_ref" });
  }

  if (typeof input.template_ref === "string") {
    const manifest = resolveContentTemplate(input.template_ref);
    if (manifest === null) {
      issues.push({ path: "template_ref", code: "unknown_template", message: `Unknown template ${input.template_ref}` });
    } else if (isRecord(input.props)) {
      for (const issue of validateTemplateProps(manifest, input.props as Record<string, JSONValue>)) {
        issues.push({ path: issue.path, code: "invalid_template_props", message: issue.message });
      }
      if (input.template_version !== undefined && input.template_version !== manifest.version) {
        issues.push({
          path: "template_version",
          code: "unknown_template",
          message: `Template ${manifest.id} requires version ${manifest.version}`,
        });
      }
      if (
        typeof input.renderer_hint === "string" &&
        input.renderer_hint !== "auto" &&
        input.renderer_hint !== manifest.preferred_renderer &&
        !manifest.fallback_renderers.includes(input.renderer_hint as never)
      ) {
        issues.push({
          path: "renderer_hint",
          code: "unsupported_renderer",
          message: `Template ${manifest.id} does not support renderer ${input.renderer_hint}`,
        });
      }
    }
  }

  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, issues: [], value: input as unknown as ContentElementV1 };
}

export function assertValidContentElement(input: unknown): ContentElementV1 {
  const result = validateContentElement(input);
  if (!result.ok || result.value === undefined) {
    const detail = result.issues.map((issue) => `${issue.path}: ${issue.message}`).join("; ");
    throw new Error(`Invalid content element: ${detail}`);
  }
  return result.value;
}
