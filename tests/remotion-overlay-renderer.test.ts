import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const remotionMocks = vi.hoisted(() => ({
  bundle: vi.fn(),
  renderMedia: vi.fn(),
  selectComposition: vi.fn(),
}));

vi.mock("@remotion/bundler", () => ({ bundle: remotionMocks.bundle }));
vi.mock("@remotion/renderer", () => ({
  renderMedia: remotionMocks.renderMedia,
  selectComposition: remotionMocks.selectComposition,
}));

import {
  renderRemotionContentLayer,
} from "../runtime/render/remotion/render-remotion.js";
import { REMOTION_OVERLAY_COMPOSITION_ID } from "../runtime/render/remotion/timeline-to-props.js";

describe("Remotion renderer-owned alpha layer", () => {
  let projectDir: string;
  let timelinePath: string;
  let outputDir: string;
  const probedMedia = {
    version: "alpha-layer-media/v1" as const,
    codec_name: "vp9",
    pixel_format: "yuva420p",
    alpha_mode: "1",
    has_alpha: true,
    width: 640,
    height: 360,
    fps_num: 30_000,
    fps_den: 1_001,
    duration_frames: 60,
    time_base: "1/1000",
    audio_stream_count: 0,
  };

  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "vos-remotion-layer-"));
    timelinePath = path.join(projectDir, "05_timeline", "timeline.json");
    outputDir = path.join(projectDir, "07_package");
    fs.mkdirSync(path.dirname(timelinePath), { recursive: true });
    fs.writeFileSync(timelinePath, JSON.stringify(timeline()));

    remotionMocks.bundle.mockReset().mockResolvedValue("/tmp/remotion-bundle");
    remotionMocks.selectComposition.mockReset().mockResolvedValue({
      id: REMOTION_OVERLAY_COMPOSITION_ID,
      durationInFrames: 60,
      fps: 30_000 / 1_001,
      width: 640,
      height: 360,
    });
    remotionMocks.renderMedia.mockReset().mockImplementation(async (options: {
      outputLocation: string;
    }) => {
      fs.mkdirSync(path.dirname(options.outputLocation), { recursive: true });
      fs.writeFileSync(options.outputLocation, "transparent-vp9");
    });
  });

  afterEach(() => {
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  it("renders VP9 yuva420p without base video or audio and writes a hash-bound receipt", async () => {
    const result = await renderRemotionContentLayer({
      timelinePath,
      outputDir,
      compositeStage: "under_caption",
      elementIds: ["TITLE_1"],
      probeAlphaLayerImpl: async () => probedMedia,
    });

    expect(result).not.toBeNull();
    expect(remotionMocks.selectComposition).toHaveBeenCalledWith(expect.objectContaining({
      id: REMOTION_OVERLAY_COMPOSITION_ID,
    }));
    expect(remotionMocks.renderMedia).toHaveBeenCalledWith(expect.objectContaining({
      codec: "vp9",
      audioCodec: null,
      muted: true,
      imageFormat: "png",
      pixelFormat: "yuva420p",
    }));
    expect(JSON.parse(fs.readFileSync(result!.receiptPath, "utf8"))).toMatchObject({
      version: "remotion-layer-receipt/v2",
      renderer: "remotion",
      renderer_version: "4.0.452",
      composite_stage: "under_caption",
      element_ids: ["TITLE_1"],
      fps_num: 30_000,
      fps_den: 1_001,
      media: probedMedia,
    });
  });

  it("reuses the layer when only nonvisual timeline metadata changes", async () => {
    const first = await renderRemotionContentLayer({
      timelinePath,
      outputDir,
      compositeStage: "under_caption",
      elementIds: ["TITLE_1"],
      probeAlphaLayerImpl: async () => probedMedia,
    });
    const changed = JSON.parse(fs.readFileSync(timelinePath, "utf8"));
    changed.metadata = { audio_finish: "changed" };
    fs.writeFileSync(timelinePath, JSON.stringify(changed));

    const second = await renderRemotionContentLayer({
      timelinePath,
      outputDir,
      compositeStage: "under_caption",
      elementIds: ["TITLE_1"],
      probeAlphaLayerImpl: async () => probedMedia,
    });

    expect(second).toMatchObject({
      overlayPath: first!.overlayPath,
      receiptPath: first!.receiptPath,
      layerCacheHit: true,
    });
    expect(remotionMocks.renderMedia).toHaveBeenCalledTimes(1);
  });
});

function timeline() {
  return {
    version: "2",
    project_id: "remotion-layer",
    created_at: "2026-07-24T00:00:00.000Z",
    sequence: {
      name: "Layer",
      fps_num: 30_000,
      fps_den: 1_001,
      width: 640,
      height: 360,
      start_frame: 0,
      letterbox_policy: "none",
    },
    tracks: {
      video: [{
        track_id: "V1",
        kind: "video",
        clips: [{
          clip_id: "BASE",
          segment_id: "SEG_BASE",
          asset_id: "AST_BASE",
          src_in_us: 0,
          src_out_us: 2_002_000,
          timeline_in_frame: 0,
          timeline_duration_frames: 60,
          role: "dialogue",
          motivation: "test",
          beat_id: "B1",
          fallback_segment_ids: [],
          confidence: 1,
          quality_flags: [],
        }],
      }],
      audio: [],
      overlay: [{
        track_id: "O1",
        kind: "overlay",
        clips: [{
          clip_id: "TITLE_CLIP",
          segment_id: "SEG_TITLE",
          asset_id: "AST_BASE",
          src_in_us: 0,
          src_out_us: 1_001_000,
          timeline_in_frame: 0,
          timeline_duration_frames: 30,
          role: "title",
          motivation: "test",
          beat_id: "B1",
          fallback_segment_ids: [],
          confidence: 1,
          quality_flags: [],
          metadata: {
            content_element: {
              version: "content-element/v1",
              element_id: "TITLE_1",
              kind: "template",
              template_ref: "vos:content.title-card/v1",
              template_version: "1.0.0",
              props: { title: "再利用できる演出" },
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
              renderer_hint: "remotion",
              creative_recipe: {
                version: "creative-recipe/v1",
                reuse_scope: "brand",
                authoring_surface: "typed_component",
                layer_mode: "alpha_overlay",
                composite_stage: "under_caption",
                requires_base_frame: false,
              },
            },
          },
        }],
      }],
    },
    markers: [],
    provenance: {
      brief_path: "",
      blueprint_path: "",
      selects_path: "",
      compiler_version: "test",
    },
  };
}
