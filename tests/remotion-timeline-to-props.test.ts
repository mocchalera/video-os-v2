import { describe, expect, it } from "vitest";
import type { TimelineIR, ClipOutput } from "../runtime/compiler/types.js";
import { timelineToCompositionProps } from "../runtime/render/remotion/timeline-to-props.js";
import { remotionTimelineFontStrings } from "../runtime/render/remotion/render-remotion.js";
import { resolveRemotionOverlayClip } from "../runtime/render/remotion/overlay-clip-resolver.js";

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
