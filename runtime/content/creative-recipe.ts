import type {
  ContentElementV1,
  ContentRendererId,
  CreativeRecipeV1,
} from "./types.js";
import type { ContentTemplateManifest } from "./template-registry.js";

export const CREATIVE_RECIPE_REUSE_SCOPES = [
  "one_off",
  "project",
  "brand",
  "campaign",
] as const;

export const CREATIVE_RECIPE_AUTHORING_SURFACES = [
  "html_motion",
  "typed_component",
  "native_filter",
] as const;

export const CREATIVE_RECIPE_LAYER_MODES = [
  "alpha_overlay",
  "full_frame",
  "native_filter",
] as const;

export const CREATIVE_RECIPE_COMPOSITE_STAGES = [
  "under_caption",
  "over_caption",
] as const;

export function defaultCreativeRecipe(): CreativeRecipeV1 {
  return {
    version: "creative-recipe/v1",
    reuse_scope: "project",
    authoring_surface: "html_motion",
    layer_mode: "alpha_overlay",
    composite_stage: "under_caption",
    requires_base_frame: false,
  };
}

function supportsRenderer(
  manifest: ContentTemplateManifest | null,
  renderer: ContentRendererId,
): boolean {
  if (manifest === null) return renderer === "ffmpeg";
  return manifest.preferred_renderer === renderer
    || manifest.fallback_renderers.includes(renderer as never);
}

export function preferredCreativeRenderer(
  recipe: CreativeRecipeV1,
): ContentRendererId {
  if (recipe.authoring_surface === "native_filter") return "ffmpeg";
  if (recipe.authoring_surface === "typed_component") return "remotion";
  if (recipe.authoring_surface === "html_motion") return "hyperframes";
  return recipe.reuse_scope === "one_off" ? "hyperframes" : "remotion";
}

/**
 * Resolve a renderer from creative intent without allowing intent to bypass
 * the template capability registry. Explicit supported renderer hints win;
 * otherwise the renderer-native authoring surface is preferred and the
 * template manifest remains the fail-closed capability boundary.
 */
export function resolveCreativeRenderer(
  element: ContentElementV1,
  manifest: ContentTemplateManifest | null,
): ContentRendererId | null {
  if (element.renderer_hint && element.renderer_hint !== "auto") {
    return supportsRenderer(manifest, element.renderer_hint)
      ? element.renderer_hint
      : null;
  }

  const recipe = element.creative_recipe;
  if (recipe) {
    const preferred = preferredCreativeRenderer(recipe);
    if (supportsRenderer(manifest, preferred)) return preferred;
  }

  if (manifest !== null) return manifest.preferred_renderer;
  return "ffmpeg";
}
