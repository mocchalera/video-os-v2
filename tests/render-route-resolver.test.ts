import { describe, expect, it } from "vitest";
import type { ContentRenderPlan } from "../runtime/content/render-plan.js";
import {
  classifyProjectGenre,
  resolveRenderRoute,
  resolveStyleFamily,
} from "../runtime/render/route-resolver.js";

function plan(input: {
  remotion?: string[];
  hyperframes?: number;
  issues?: ContentRenderPlan["issues"];
} = {}): ContentRenderPlan {
  return {
    width: 1080,
    height: 1920,
    fps: 30,
    duration_frames: 300,
    remotion_clip_ids: input.remotion ?? [],
    hyperframes_elements: Array.from({ length: input.hyperframes ?? 0 }, (_, index) => ({
      element: {
        version: "content-element/v1" as const,
        element_id: `HF_${index}`,
        kind: "template" as const,
        template_ref: "vos:content.section-label/v1",
        template_version: "1.0.0",
        props: { title: `Section ${index}` },
        layout: {
          anchor: "top_left" as const,
          x: 0,
          y: 0,
          scale: 1,
          rotation_deg: 0,
          opacity: 1,
          safe_area: true,
          z_index: 100,
        },
        renderer_hint: "hyperframes" as const,
      },
      start_frame: index * 30,
      duration_frames: 30,
    })),
    issues: input.issues ?? [],
  };
}

describe("capability-based render route", () => {
  it("keeps ordinary projects on FFmpeg even when the genre is social", () => {
    const route = resolveRenderRoute({
      requestedEngine: "auto",
      contentPlan: plan(),
      distributionChannel: "social_feed",
      aspectRatio: "9:16",
      captionStylingClass: "sns-vertical-outline",
      captionsEnabled: true,
    });

    expect(route).toMatchObject({
      assembly_engine: "ffmpeg",
      hyperframes_overlay: false,
      genre: "social_talking_head",
      style_family: "bold_kinetic",
      speech_caption_engine: "ffmpeg-libass",
    });
  });

  it("selects Remotion only when a Remotion-owned overlay requires it", () => {
    expect(resolveRenderRoute({
      requestedEngine: "auto",
      contentPlan: plan({ remotion: ["TITLE"] }),
    })).toMatchObject({
      assembly_engine: "remotion",
      hyperframes_overlay: false,
      remotion_overlay_count: 1,
    });
  });

  it("uses FFmpeg plus HyperFrames for HyperFrames-only content", () => {
    expect(resolveRenderRoute({
      requestedEngine: "auto",
      contentPlan: plan({ hyperframes: 2 }),
    })).toMatchObject({
      assembly_engine: "ffmpeg",
      hyperframes_overlay: true,
      hyperframes_element_count: 2,
    });
  });

  it("uses Remotion plus HyperFrames for mixed renderer ownership", () => {
    expect(resolveRenderRoute({
      requestedEngine: "auto",
      contentPlan: plan({ remotion: ["TITLE"], hyperframes: 2 }),
    })).toMatchObject({
      assembly_engine: "remotion",
      hyperframes_overlay: true,
    });
  });

  it("fails closed when explicit FFmpeg would drop Remotion content", () => {
    expect(() => resolveRenderRoute({
      requestedEngine: "ffmpeg",
      contentPlan: plan({ remotion: ["TITLE"] }),
    })).toThrow("cannot render 1 Remotion-owned overlay");
  });

  it("fails closed for invalid content instead of silently changing its look", () => {
    expect(() => resolveRenderRoute({
      requestedEngine: "auto",
      contentPlan: plan({ issues: [{ clip_id: "BAD", message: "unknown template" }] }),
    })).toThrow("BAD: unknown template");
  });
});

describe("genre isolation", () => {
  it.each([
    [{ profileHint: "longform-event" }, "longform"],
    [{ profileHint: "event-recap" }, "event"],
    [{ profileHint: "cinematic-documentary" }, "cinematic"],
    [{ profileHint: "interview-highlight" }, "interview"],
    [{ distributionChannel: "web", aspectRatio: "16:9" }, "general"],
  ] as const)("classifies %o as %s", (input, expected) => {
    expect(classifyProjectGenre(input)).toBe(expected);
  });

  it("does not leak the SNS outline family into cinematic or longform captions", () => {
    expect(resolveStyleFamily({
      genre: "cinematic",
      captionStylingClass: "single-layer-speaker-separated-safe-area-ja",
    }))
      .toBe("cinematic_minimal");
    expect(resolveStyleFamily({
      genre: "longform",
      captionStylingClass: "single-layer-speaker-separated-safe-area-ja",
    }))
      .toBe("clean_editorial");
    expect(resolveStyleFamily({ genre: "event", captionStylingClass: "sns-vertical-outline" }))
      .toBe("clean_editorial");
  });

  it.each([
    "interview",
    "event",
    "longform",
    "cinematic",
    "general",
  ] as const)("can select programmable renderers for %s without changing its genre", (genre) => {
    const profileHint = genre === "general" ? undefined : `${genre}-profile`;
    const route = resolveRenderRoute({
      requestedEngine: "auto",
      contentPlan: plan({ remotion: ["TITLE"], hyperframes: 1 }),
      profileHint,
      distributionChannel: genre === "general" ? "web" : undefined,
      aspectRatio: "16:9",
    });

    expect(route.assembly_engine).toBe("remotion");
    expect(route.hyperframes_overlay).toBe(true);
    expect(route.genre).toBe(genre);
  });
});
