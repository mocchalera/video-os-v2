import { describe, expect, it } from "vitest";
import type { TimelineIR, ClipOutput } from "../runtime/compiler/types.js";
import { timelineToCompositionProps } from "../runtime/render/remotion/timeline-to-props.js";
import { remotionTimelineFontStrings } from "../runtime/render/remotion/render-remotion.js";
import { resolveRemotionOverlayClip } from "../runtime/render/remotion/overlay-clip-resolver.js";
import {
  anchorTransformOrigin,
  hasExplicitRect,
  overlayWrapperStyle,
} from "../runtime/render/remotion/overlay-layout.js";

function makeClip(overrides: Partial<ClipOutput>): ClipOutput {
  return {
    clip_id: "clip-1",
    segment_id: "segment-1",
    asset_id: "asset-1",
    src_in_us: 0,
    src_out_us: 1_000_000,
    timeline_in_frame: 0,
    timeline_duration_frames: 30,
    role: "primary",
    motivation: "test",
    beat_id: "beat-1",
    fallback_segment_ids: [],
    confidence: 1,
    quality_flags: [],
    ...overrides,
  };
}

function makeTimeline(clips: ClipOutput[], fpsNum = 30, fpsDen = 1): TimelineIR {
  return {
    version: "1",
    project_id: "remotion-test",
    created_at: "2026-04-27T00:00:00.000Z",
    sequence: {
      name: "Remotion Test",
      fps_num: fpsNum,
      fps_den: fpsDen,
      width: 1920,
      height: 1080,
      start_frame: 0,
      letterbox_policy: "none",
    },
    tracks: {
      video: [
        {
          track_id: "V1",
          kind: "video",
          clips,
        },
      ],
      audio: [],
    },
    markers: [],
    provenance: {
      brief_path: "01_intent/creative_brief.yaml",
      blueprint_path: "02_blueprint/edit_blueprint.yaml",
      selects_path: "04_selects/selects_candidates.yaml",
      compiler_version: "test",
    },
  };
}

describe("timelineToCompositionProps", () => {
  it("uses fail-safe duration for an empty timeline", () => {
    const props = timelineToCompositionProps(makeTimeline([]), {});

    expect(props.durationInFrames).toBe(1);
    expect(props.fps).toBe(30);
    expect(props.width).toBe(1920);
    expect(props.height).toBe(1080);
    expect(props.defaultProps.fontAsset).toMatchObject({
      fontId: "noto-sans-jp",
      format: "truetype",
      webPublicPath: "fonts/NotoSansJP-Variable.ttf",
    });
  });

  it("computes duration from a single video clip", () => {
    const timeline = makeTimeline([
      makeClip({ timeline_in_frame: 12, timeline_duration_frames: 48 }),
    ]);

    expect(timelineToCompositionProps(timeline, {}).durationInFrames).toBe(60);
  });

  it("computes duration from the maximum clip end across gaps", () => {
    const timeline = makeTimeline([
      makeClip({
        clip_id: "clip-1",
        timeline_in_frame: 0,
        timeline_duration_frames: 30,
      }),
      makeClip({
        clip_id: "clip-2",
        timeline_in_frame: 72,
        timeline_duration_frames: 24,
      }),
    ]);

    expect(timelineToCompositionProps(timeline, {}).durationInFrames).toBe(96);
  });

  it("extends a transparent overlay composition through a trailing CTA", () => {
    const timeline = makeTimeline([
      makeClip({ timeline_in_frame: 0, timeline_duration_frames: 90 }),
    ]);
    (timeline.tracks as TimelineIR["tracks"] & {
      overlay: TimelineIR["tracks"]["video"];
    }).overlay = [{
      track_id: "OV1",
      kind: "overlay",
      clips: [makeClip({
        clip_id: "cta",
        asset_id: "__overlay__",
        timeline_in_frame: 90,
        timeline_duration_frames: 60,
      })],
    }];

    expect(timelineToCompositionProps(timeline, {}).durationInFrames).toBe(150);
  });

  it("preserves rational fps for Remotion instead of rounding to an integer rate", () => {
    const timeline = makeTimeline([], 24_000, 1_001);

    expect(timelineToCompositionProps(timeline, {}).fps).toBe(24_000 / 1_001);
  });

  it("collects only Remotion-displayed overlay strings for font subsetting", () => {
    const timeline = makeTimeline([
      makeClip({ captions: [{ text: "字幕です", in_frame: 0, out_frame: 20, style: "simple-shadow" }] }),
    ]);
    (timeline.tracks as TimelineIR["tracks"] & { overlay: TimelineIR["tracks"]["video"] }).overlay = [{
      track_id: "OV1",
      kind: "overlay",
      clips: [makeClip({
        clip_id: "overlay-1",
        metadata: {
          overlay: { text: "会社の変化", styling_class: "vos:overlay.title-card" },
          ignored_note: "これは描画されない",
        },
      })],
    }];

    // Speech captions are burned downstream from caption_approval.json, so
    // changing them must not invalidate the expensive base assembly cache.
    expect(remotionTimelineFontStrings(timeline)).toEqual(["会社の変化"]);
  });

  it("resolves canonical title and emphasis templates without arbitrary JSX", () => {
    const canonicalClip = (
      templateRef: string,
      props: Record<string, string>,
      rendererHint = "auto",
    ) => makeClip({
      clip_id: templateRef,
      metadata: {
        content_element: {
          version: "content-element/v1",
          element_id: templateRef.replace(/[^A-Za-z0-9._-]/g, "_"),
          kind: "template",
          template_ref: templateRef,
          template_version: "1.0.0",
          props,
          layout: {
            anchor: "top_center",
            x: 0,
            y: 0,
            scale: 1,
            rotation_deg: 0,
            opacity: 1,
            safe_area: true,
            z_index: 100,
          },
          renderer_hint: rendererHint,
        },
      },
    });

    expect(resolveRemotionOverlayClip(
      canonicalClip("vos:content.title-card/v1", { title: "本気のビートボックス" }),
    )).toMatchObject({
      presetId: "vos:overlay.title-card",
      text: "本気のビートボックス",
      anchor: "top-center",
      scale: 1,
    });
    expect(resolveRemotionOverlayClip(
      canonicalClip("vos:content.emphasis-word/v1", { text: "BOOM" }),
    )).toMatchObject({
      presetId: "vos:overlay.emphasis-word",
      text: "BOOM",
    });
    expect(resolveRemotionOverlayClip(
      canonicalClip("vos:content.hook-title/v1", { title: "AIに頼んだ結果" }),
    )).toMatchObject({
      presetId: "vos:overlay.hook-title",
      text: "AIに頼んだ結果",
      anchor: "top-center",
    });
    expect(resolveRemotionOverlayClip(
      canonicalClip("vos:content.cta-card/v1", { headline: "次の一歩を始める", action: "無料相談へ", brand: "VIDEO OS" }),
    )).toMatchObject({
      presetId: "vos:overlay.cta-card",
      text: "次の一歩を始める",
      actionText: "無料相談へ",
      brandText: "VIDEO OS",
    });
    expect(resolveRemotionOverlayClip(
      canonicalClip("vos:content.section-label/v1", { title: "第1次AI革命" }, "remotion"),
    )).toMatchObject({
      presetId: "vos:overlay.chapter-kicker",
      text: "第1次AI革命",
    });
    expect(resolveRemotionOverlayClip(
      canonicalClip("vos:content.lower-third/v1", { name: "坂本", role: "講師" }, "remotion"),
    )).toMatchObject({
      presetId: "vos:overlay.lower-third",
      text: "坂本\n講師",
    });
  });

  it("normalizes schema-valid legacy overlay anchors for Remotion presets", () => {
    expect(resolveRemotionOverlayClip(makeClip({
      clip_id: "legacy-title",
      metadata: {
        overlay: {
          text: "AIと縦動画の編集会議",
          styling_class: "vos:overlay.title-card",
          anchor: "top_left",
        },
      },
    }))).toMatchObject({
      presetId: "vos:overlay.title-card",
      text: "AIと縦動画の編集会議",
      anchor: "top-left",
    });
  });
});

describe("resolveRemotionOverlayClip content-element layout", () => {
  const canonicalWithLayout = (layout: Record<string, unknown>) => makeClip({
    clip_id: "layout-clip",
    metadata: {
      content_element: {
        version: "content-element/v1",
        element_id: "LAYOUT_1",
        kind: "template",
        template_ref: "vos:content.title-card/v1",
        template_version: "1.0.0",
        props: { title: "レイアウト" },
        layout,
        renderer_hint: "remotion",
      },
    },
  });

  it("resolves normalized x/y/width/height/rotation/opacity/z-order/safe-area deterministically", () => {
    expect(resolveRemotionOverlayClip(canonicalWithLayout({
      anchor: "bottom_right",
      x: 0.5,
      y: 0.4,
      width: 0.8,
      height: 0.3,
      scale: 1.25,
      rotation_deg: -6,
      opacity: 0.8,
      safe_area: false,
      z_index: 42,
    }))).toMatchObject({
      presetId: "vos:overlay.title-card",
      anchor: "bottom-right",
      scale: 1.25,
      layout: {
        x: 0.5,
        y: 0.4,
        width: 0.8,
        height: 0.3,
        rotationDeg: -6,
        opacity: 0.8,
        safeArea: false,
        zIndex: 42,
      },
    });
  });

  it("keeps anchor-only timelines compatible with the default layout", () => {
    expect(resolveRemotionOverlayClip(canonicalWithLayout({
      anchor: "top_center",
      x: 0,
      y: 0,
      scale: 1,
      rotation_deg: 0,
      opacity: 1,
      safe_area: true,
      z_index: 100,
    }))!.layout).toEqual({
      x: 0,
      y: 0,
      width: undefined,
      height: undefined,
      rotationDeg: 0,
      opacity: 1,
      safeArea: true,
      zIndex: 100,
    });
  });

  it("leaves legacy styling_class clips without a layout contract", () => {
    expect(resolveRemotionOverlayClip(makeClip({
      clip_id: "legacy-title",
      metadata: {
        overlay: {
          text: "AIと縦動画の編集会議",
          styling_class: "vos:overlay.title-card",
          anchor: "top_left",
        },
      },
    }))!.layout).toBeUndefined();
  });
});

describe("remotion overlay layout resolution (1080x1920 sequence)", () => {
  const frame = { width: 1080, height: 1920 };

  it.each([
    ["top-left", "0% 0%"],
    ["top-center", "50% 0%"],
    ["top-right", "100% 0%"],
    ["center-left", "0% 50%"],
    ["center", "50% 50%"],
    ["center-right", "100% 50%"],
    ["bottom-left", "0% 100%"],
    ["bottom-center", "50% 100%"],
    ["bottom-right", "100% 100%"],
  ])("pins scale to the %s anchor box point so the anchor never moves", (anchor, origin) => {
    expect(anchorTransformOrigin(anchor)).toBe(origin);
    expect(overlayWrapperStyle({
      anchor,
      x: 0,
      y: 0,
      scale: 3,
      rotationDeg: 45,
      opacity: 1,
      safeArea: true,
    }, frame).transformOrigin).toBe(origin);
  });

  it("resolves normalized x/y offsets as frame-fraction translation on the anchor origin", () => {
    expect(overlayWrapperStyle({
      anchor: "center",
      x: 0.5,
      y: 0.4,
      scale: 1,
      rotationDeg: 0,
      opacity: 1,
      safeArea: true,
    }, frame)).toEqual({
      transformOrigin: "50% 50%",
      transform: "translate(50%, 40%) scale(1) rotate(0deg)",
    });
  });

  it("resolves an explicit rect into absolute sequence pixels with rotation, opacity and z-order", () => {
    expect(hasExplicitRect(0.8, 0.3)).toBe(true);
    expect(hasExplicitRect(undefined, undefined)).toBe(false);
    expect(overlayWrapperStyle({
      anchor: "top_left",
      x: 0.5,
      y: 0.4,
      width: 0.8,
      height: 0.3,
      scale: 1.25,
      rotationDeg: -6,
      opacity: 0.8,
      safeArea: false,
      zIndex: 42,
    }, frame)).toEqual({
      position: "absolute",
      left: 540, // 0.5 * 1080
      top: 768, // 0.4 * 1920
      width: 864, // 0.8 * 1080
      height: 576, // 0.3 * 1920
      opacity: 0.8,
      zIndex: 42,
      // Anchor corner is pinned via transform-origin so scaling keeps it fixed.
      transformOrigin: "0% 0%",
      transform: "translate(0%, 0%) scale(1.25) rotate(-6deg)",
    });
  });

  it("keeps a width-only rect's auto height non-zero for AbsoluteFill content", () => {
    const style = overlayWrapperStyle({
      anchor: "top-left",
      x: 0,
      y: 0,
      width: 0.5,
      height: undefined,
      scale: 1,
      rotationDeg: 0,
      opacity: 1,
      safeArea: true,
    }, frame);
    expect(style).toMatchObject({
      position: "absolute",
      width: 540,
      minHeight: 1,
    });
    expect(style.height).toBeUndefined();
  });

  it("keeps a height-only rect's auto width non-zero for AbsoluteFill content", () => {
    const style = overlayWrapperStyle({
      anchor: "top-left",
      x: 0,
      y: 0,
      width: undefined,
      height: 0.25,
      scale: 1,
      rotationDeg: 0,
      opacity: 1,
      safeArea: true,
    }, frame);
    expect(style).toMatchObject({
      position: "absolute",
      minWidth: 1,
      height: 480,
    });
    expect(style.width).toBeUndefined();
  });

  it("applies hyperframes-parity safe margins inward from an anchored explicit rect", () => {
    // --safe-x = round(1080 * 0.05) = 54, --safe-y = round(1920 * 0.067) = 129
    expect(overlayWrapperStyle({
      anchor: "bottom_right",
      x: 0,
      y: 0,
      width: 0.5,
      height: 0.25,
      scale: 1,
      rotationDeg: 0,
      opacity: 1,
      safeArea: true,
    }, frame)).toMatchObject({
      position: "absolute",
      left: 1026, // 1080 - 54
      top: 1791, // 1920 - 129
      width: 540,
      height: 480,
      transformOrigin: "100% 100%",
      transform: "translate(-100%, -100%) scale(1) rotate(0deg)",
    });
  });

  it("drops safe margins when safe_area is false in rect mode", () => {
    expect(overlayWrapperStyle({
      anchor: "bottom_right",
      x: 0,
      y: 0,
      width: 0.5,
      height: 0.25,
      scale: 1,
      rotationDeg: 0,
      opacity: 1,
      safeArea: false,
    }, frame)).toMatchObject({ left: 1080, top: 1920 });
  });
});
