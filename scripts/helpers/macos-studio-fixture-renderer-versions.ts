import type {
  RendererVersionProvider,
} from "../../runtime/packaging/renderer-version-provider.js";

type FixtureRendererVersionRoute = Parameters<
  RendererVersionProvider["rendererVersionsFor"]
>[0];

export const MACOS_STUDIO_FIXTURE_RENDERER_IDENTITY = Object.freeze({
  ffmpeg: "ffmpeg version VideoOS macOS Studio fixture/v1",
  hyperframes: "0.7.60",
  remotion: "4.0.452",
});

export const macosStudioFixtureRendererVersionProvider: RendererVersionProvider =
  Object.freeze({
    rendererVersionsFor(route: FixtureRendererVersionRoute) {
      return {
        ffmpeg: MACOS_STUDIO_FIXTURE_RENDERER_IDENTITY.ffmpeg,
        ...(route.visual_layers.some((layer) => layer.renderer === "hyperframes")
          ? { hyperframes: MACOS_STUDIO_FIXTURE_RENDERER_IDENTITY.hyperframes }
          : {}),
        ...(route.base_engine === "remotion"
          || route.visual_layers.some((layer) => layer.renderer === "remotion")
          ? { remotion: MACOS_STUDIO_FIXTURE_RENDERER_IDENTITY.remotion }
          : {}),
      };
    },
  });
