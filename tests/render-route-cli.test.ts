import { describe, expect, it } from "vitest";
import {
  formatRenderRoute,
  parseRenderRouteArgs,
} from "../scripts/render-route.js";
import type { RenderRouteDecision } from "../runtime/render/route-resolver.js";

describe("render-route CLI", () => {
  it("defaults to capability-based auto routing", () => {
    expect(parseRenderRouteArgs(["node", "render-route", "projects/demo"]))
      .toMatchObject({ assemblyEngine: "auto", json: false });
  });

  it("accepts an explicit diagnostic engine and JSON mode", () => {
    expect(parseRenderRouteArgs([
      "node",
      "render-route",
      "projects/demo",
      "--assembly-engine",
      "remotion",
      "--json",
    ])).toMatchObject({ assemblyEngine: "remotion", json: true });
  });

  it("rejects unknown engines", () => {
    expect(() => parseRenderRouteArgs([
      "node",
      "render-route",
      "projects/demo",
      "--assembly-engine",
      "magic",
    ])).toThrow("Invalid --assembly-engine");
  });

  it("formats the selected layers and reasons", () => {
    const decision: RenderRouteDecision = {
      version: "render-route/v2",
      requested_assembly_engine: "auto",
      assembly_engine: "remotion",
      base_engine: "remotion",
      visual_layers: [{
        renderer: "hyperframes",
        mode: "alpha_overlay",
        composite_stage: "under_caption",
        reuse_scopes: ["one_off"],
        element_ids: ["HF"],
        z_index_min: 100,
        z_index_max: 100,
        embedded_in_base: false,
      }, {
        renderer: "remotion",
        mode: "alpha_overlay",
        composite_stage: "under_caption",
        reuse_scopes: ["brand"],
        element_ids: ["RM"],
        z_index_min: 110,
        z_index_max: 110,
        embedded_in_base: false,
      }],
      caption_layer: {
        engine: "ffmpeg-libass",
        composite_stage: "caption",
      },
      delivery: {
        compositor: "ffmpeg",
        video_encoder: "ffmpeg",
        definition: "sequential_h264_generations/v1",
        lossy_video_encode_passes: 2,
      },
      hyperframes_overlay: true,
      remotion_overlay_count: 1,
      hyperframes_element_count: 1,
      speech_caption_engine: "ffmpeg-libass",
      style_family: "bold_kinetic",
      genre: "social_talking_head",
      reasons: ["registered elements require programmable renderers"],
    };
    const formatted = formatRenderRoute(decision);
    expect(formatted).toContain("Base: remotion");
    expect(formatted).toContain(
      "Visual layers: hyperframes:alpha_overlay:under_caption + remotion:alpha_overlay:under_caption",
    );
    expect(formatted).toContain("Delivery: ffmpeg/ffmpeg (2 lossy video encode)");
  });
});
