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
      version: "render-route/v1",
      requested_assembly_engine: "auto",
      assembly_engine: "remotion",
      hyperframes_overlay: true,
      remotion_overlay_count: 1,
      hyperframes_element_count: 1,
      speech_caption_engine: "ffmpeg-libass",
      style_family: "bold_kinetic",
      genre: "social_talking_head",
      reasons: ["registered elements require programmable renderers"],
    };
    expect(formatRenderRoute(decision)).toContain(
      "Render route: remotion + hyperframes-overlay + ffmpeg-libass-captions",
    );
  });
});
