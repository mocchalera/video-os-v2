import { execFileSync } from "node:child_process";
import { HYPERFRAMES_RENDERER_VERSION } from "../content/hyperframes-renderer.js";
import {
  REMOTION_RENDERER_VERSION,
} from "../render/remotion/render-remotion.js";
import type {
  RenderRouteDecision,
  RenderRouteReceipt,
} from "../render/route-resolver.js";

type RendererVersionRoute = Pick<
  RenderRouteDecision,
  "base_engine" | "visual_layers"
>;

type RendererVersions = RenderRouteReceipt["renderer_versions"];

export interface RendererVersionProvider {
  rendererVersionsFor(route: RendererVersionRoute): RendererVersions;
}

export const liveRendererVersionProvider: RendererVersionProvider = Object.freeze({
  rendererVersionsFor(route: RendererVersionRoute): RendererVersions {
    const ffmpeg = execFileSync("ffmpeg", ["-version"], {
      encoding: "utf8",
    }).split(/\r?\n/, 1)[0].trim();
    return {
      ffmpeg,
      ...(route.visual_layers.some((layer) => layer.renderer === "hyperframes")
        ? { hyperframes: HYPERFRAMES_RENDERER_VERSION }
        : {}),
      ...(route.base_engine === "remotion"
        || route.visual_layers.some((layer) => layer.renderer === "remotion")
        ? { remotion: REMOTION_RENDERER_VERSION }
        : {}),
    };
  },
});
