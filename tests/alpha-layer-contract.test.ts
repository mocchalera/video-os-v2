import { describe, expect, it } from "vitest";
import {
  assertAlphaLayerMediaContract,
  parseAlphaLayerProbe,
  type AlphaLayerMediaContract,
} from "../runtime/render/alpha-layer-contract.js";

const valid: AlphaLayerMediaContract = {
  version: "alpha-layer-media/v1",
  codec_name: "vp9",
  pixel_format: "yuva420p",
  alpha_mode: "1",
  has_alpha: true,
  width: 1920,
  height: 1080,
  fps_num: 30_000,
  fps_den: 1_001,
  duration_frames: 300,
  time_base: "1/1000",
  audio_stream_count: 0,
};

describe("alpha layer media contract", () => {
  it("recognizes the case-insensitive Matroska ALPHA_MODE tag emitted by HyperFrames", () => {
    const media = parseAlphaLayerProbe(JSON.stringify({
      streams: [{
        codec_type: "video",
        codec_name: "vp9",
        pix_fmt: "yuv420p",
        width: 1920,
        height: 1080,
        avg_frame_rate: "30000/1001",
        time_base: "1/1000",
        nb_read_packets: "300",
        tags: { ALPHA_MODE: "1" },
      }],
    }));
    expect(media).toMatchObject({
      codec_name: "vp9",
      pixel_format: "yuv420p",
      alpha_mode: "1",
      has_alpha: true,
    });
  });

  it("requires every probed reuse field and exact timeline geometry", () => {
    expect(() => assertAlphaLayerMediaContract(valid, {
      width: 1920,
      height: 1080,
      fpsNum: 30_000,
      fpsDen: 1_001,
      durationFrames: 300,
    })).not.toThrow();

    for (const [field, value] of [
      ["codec_name", "h264"],
      ["pixel_format", "yuv444p"],
      ["has_alpha", false],
      ["width", 1280],
      ["height", 720],
      ["fps_num", 24],
      ["duration_frames", 299],
      ["time_base", "1/90000"],
      ["audio_stream_count", 1],
    ] as const) {
      expect(() => assertAlphaLayerMediaContract(
        { ...valid, [field]: value },
        {
          width: 1920,
          height: 1080,
          fpsNum: 30_000,
          fpsDen: 1_001,
          durationFrames: 300,
        },
      )).toThrow(`alpha_layer_media_contract_mismatch:${field}`);
    }
  });
});
