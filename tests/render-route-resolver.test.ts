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
  remotionBaseRequired?: string[];
  visualElements?: ContentRenderPlan["visual_elements"];
  issues?: ContentRenderPlan["issues"];
} = {}): ContentRenderPlan {
  return {
    width: 1080,
    height: 1920,
    fps: 30,
    fps_num: 30,
    fps_den: 1,
    duration_frames: 300,
    remotion_clip_ids: input.remotion ?? [],
    remotion_base_required_clip_ids: input.remotionBaseRequired ?? [],
    remotion_elements: [],
    visual_elements: input.visualElements ?? [
      ...((input.hyperframes ?? 0) > 0
        ? Array.from({ length: input.hyperframes ?? 0 }, (_, index) => ({
            clip_id: `HF_${index}`,
            element_id: `HF_${index}`,
            renderer: "hyperframes" as const,
            layer_mode: "alpha_overlay" as const,
            composite_stage: "under_caption" as const,
            reuse_scope: "one_off" as const,
            requires_base_frame: false,
            z_index: 100 + index,
          }))
        : []),
      ...(input.remotion ?? []).map((clipId) => ({
        clip_id: clipId,
        element_id: clipId,
        renderer: "remotion" as const,
        layer_mode: "alpha_overlay" as const,
        composite_stage: "under_caption" as const,
        reuse_scope: "brand" as const,
        requires_base_frame: (input.remotionBaseRequired ?? []).includes(clipId),
        z_index: 200,
      })),
    ],
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

function visualElement(
  elementId: string,
  renderer: "hyperframes" | "remotion",
  zIndex: number,
): NonNullable<ContentRenderPlan["visual_elements"]>[number] {
  return {
    clip_id: elementId,
    element_id: elementId,
    renderer,
    layer_mode: "alpha_overlay",
    composite_stage: "under_caption",
    reuse_scope: renderer === "hyperframes" ? "one_off" : "brand",
    requires_base_frame: false,
    z_index: zIndex,
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
      version: "render-route/v2",
      assembly_engine: "ffmpeg",
      base_engine: "ffmpeg",
      hyperframes_overlay: false,
      genre: "social_talking_head",
      style_family: "bold_kinetic",
      speech_caption_engine: "ffmpeg-libass",
      caption_layer: {
        engine: "ffmpeg-libass",
        composite_stage: "caption",
      },
      delivery: {
        compositor: "ffmpeg",
        video_encoder: "ffmpeg",
        lossy_video_encode_passes: 2,
      },
    });
  });

  it("counts the base H.264 generation even when no final visual encode is required", () => {
    expect(resolveRenderRoute({
      requestedEngine: "auto",
      contentPlan: plan(),
      captionsEnabled: false,
    }).delivery).toMatchObject({
      lossy_video_encode_passes: 1,
      definition: "sequential_h264_generations/v1",
    });
  });

  it("keeps Remotion overlays separate from the FFmpeg base assembly", () => {
    expect(resolveRenderRoute({
      requestedEngine: "auto",
      contentPlan: plan({ remotion: ["TITLE"] }),
    })).toMatchObject({
      assembly_engine: "ffmpeg",
      base_engine: "ffmpeg",
      hyperframes_overlay: false,
      remotion_overlay_count: 1,
      visual_layers: [
        expect.objectContaining({
          renderer: "remotion",
          mode: "alpha_overlay",
          element_ids: ["TITLE"],
        }),
      ],
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
      visual_layers: [
        expect.objectContaining({
          renderer: "hyperframes",
          mode: "alpha_overlay",
          element_ids: ["HF_0", "HF_1"],
        }),
      ],
    });
  });

  it("uses one FFmpeg base plus separate Remotion and HyperFrames layers", () => {
    expect(resolveRenderRoute({
      requestedEngine: "auto",
      contentPlan: plan({ remotion: ["TITLE"], hyperframes: 2 }),
    })).toMatchObject({
      assembly_engine: "ffmpeg",
      hyperframes_overlay: true,
      visual_layers: [
        expect.objectContaining({ renderer: "hyperframes" }),
        expect.objectContaining({ renderer: "remotion" }),
      ],
    });
  });

  it("fails closed when renderer-grouped layers would reorder interleaved z-indexes", () => {
    expect(() => resolveRenderRoute({
      requestedEngine: "auto",
      contentPlan: plan({
        visualElements: [
          {
            clip_id: "HF_LOW",
            element_id: "HF_LOW",
            renderer: "hyperframes",
            layer_mode: "alpha_overlay",
            composite_stage: "under_caption",
            reuse_scope: "one_off",
            requires_base_frame: false,
            z_index: 100,
          },
          {
            clip_id: "REM_MID",
            element_id: "REM_MID",
            renderer: "remotion",
            layer_mode: "alpha_overlay",
            composite_stage: "under_caption",
            reuse_scope: "brand",
            requires_base_frame: false,
            z_index: 200,
          },
          {
            clip_id: "HF_HIGH",
            element_id: "HF_HIGH",
            renderer: "hyperframes",
            layer_mode: "alpha_overlay",
            composite_stage: "under_caption",
            reuse_scope: "one_off",
            requires_base_frame: false,
            z_index: 300,
          },
        ],
      }),
    })).toThrow(
      "renderer_z_order_interleaving_unsupported: stage=under_caption order=hyperframes:HF_LOW@100,remotion:REM_MID@200,hyperframes:HF_HIGH@300",
    );
  });

  it("rejects cross-renderer z-index ties whose element order cannot survive layer grouping", () => {
    expect(() => resolveRenderRoute({
      requestedEngine: "auto",
      contentPlan: plan({
        visualElements: [
          visualElement("REM_A", "remotion", 100),
          visualElement("HF_B", "hyperframes", 100),
        ],
      }),
    })).toThrow(
      "renderer_z_order_interleaving_unsupported: stage=under_caption ranges=hyperframes:100-100,remotion:100-100",
    );
  });

  it("rejects a separate layer authored below a base-frame Remotion treatment", () => {
    expect(() => resolveRenderRoute({
      requestedEngine: "auto",
      captionsEnabled: false,
      contentPlan: plan({
        remotionBaseRequired: ["REM_BASE"],
        visualElements: [
          visualElement("HF_LOW", "hyperframes", 100),
          {
            ...visualElement("REM_BASE", "remotion", 200),
            requires_base_frame: true,
          },
        ],
      }),
    })).toThrow(
      "renderer_z_order_interleaving_unsupported: stage=under_caption order=hyperframes:HF_LOW@100,remotion:REM_BASE@200 base_frame_layer_cannot_cover_later_composite",
    );
  });

  it("allows explicit FFmpeg when Remotion content is an alpha layer", () => {
    expect(resolveRenderRoute({
      requestedEngine: "ffmpeg",
      contentPlan: plan({ remotion: ["TITLE"] }),
    })).toMatchObject({
      assembly_engine: "ffmpeg",
      remotion_overlay_count: 1,
    });
  });

  it("fails closed when explicit FFmpeg would drop a base-frame Remotion treatment", () => {
    expect(() => resolveRenderRoute({
      requestedEngine: "ffmpeg",
      contentPlan: plan({
        remotion: ["TRANSFORM"],
        remotionBaseRequired: ["TRANSFORM"],
      }),
    })).toThrow("requires Remotion base assembly");
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

    expect(route.assembly_engine).toBe("ffmpeg");
    expect(route.hyperframes_overlay).toBe(true);
    expect(route.visual_layers.map((layer) => layer.renderer)).toEqual([
      "hyperframes",
      "remotion",
    ]);
    expect(route.genre).toBe(genre);
  });
});
