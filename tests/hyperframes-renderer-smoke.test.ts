import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  hyperFramesFpsArgument,
  hyperFramesVisualProjectionSha256,
  renderHyperFramesContentLayer,
} from "../runtime/content/hyperframes-renderer.js";
import { createHash } from "node:crypto";
import { loadContentRenderPlan } from "../runtime/content/render-plan.js";

const runRealRender = process.env.VOS_HYPERFRAMES_RENDER === "1";
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0, tempDirs.length)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("HyperFrames production content adapter", () => {
  it("passes exact rational frame rates to the HyperFrames CLI", () => {
    expect(hyperFramesFpsArgument({ fps_num: 30_000, fps_den: 1_001 })).toBe("30000/1001");
  });

  it("reuses a renderer-owned layer across unrelated base-timeline changes", async () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "vos-hf-cache-"));
    tempDirs.push(projectDir);
    const timelinePath = path.join(projectDir, "timeline.json");
    const outputDir = path.join(projectDir, "package");
    const overlayPath = path.join(outputDir, "video", "hyperframes-overlay.webm");
    const receiptPath = path.join(outputDir, "logs", "hyperframes-layer-receipt.json");
    const sha = (value: string) => createHash("sha256").update(value).digest("hex");
    const timeline = JSON.stringify({
      sequence: { width: 640, height: 360, fps_num: 30_000, fps_den: 1_001 },
      tracks: {
        overlay: [{
          track_id: "OV1",
          clips: [{
            clip_id: "HF",
            timeline_in_frame: 0,
            timeline_duration_frames: 30,
            metadata: {
              content_element: {
                version: "content-element/v1",
                element_id: "HF",
                kind: "template",
                template_ref: "vos:content.section-label/v1",
                template_version: "1.0.0",
                props: { title: "Section" },
                layout: { anchor: "top_left", x: 0, y: 0, scale: 1, rotation_deg: 0, opacity: 1, safe_area: true, z_index: 100 },
              },
            },
          }],
        }],
      },
    });
    fs.mkdirSync(path.dirname(overlayPath), { recursive: true });
    fs.mkdirSync(path.dirname(receiptPath), { recursive: true });
    fs.writeFileSync(timelinePath, timeline);
    fs.writeFileSync(overlayPath, "overlay");
    const media = {
      version: "alpha-layer-media/v1" as const,
      codec_name: "vp9",
      pixel_format: "yuva420p",
      alpha_mode: "1",
      has_alpha: true,
      width: 640,
      height: 360,
      fps_num: 30_000,
      fps_den: 1_001,
      duration_frames: 30,
      time_base: "1/1000",
      audio_stream_count: 0,
    };
    fs.writeFileSync(receiptPath, JSON.stringify({
      version: "hyperframes-layer-receipt/v3",
      renderer: "hyperframes",
      renderer_version: "0.7.60",
      timeline_path: timelinePath,
      timeline_sha256: sha(timeline),
      timeline_visual_projection_sha256:
        hyperFramesVisualProjectionSha256(loadContentRenderPlan(timelinePath)),
      overlay_path: overlayPath,
      element_ids: ["HF"],
      overlay_sha256: sha("overlay"),
      media,
    }));

    await expect(renderHyperFramesContentLayer({
      timelinePath,
      outputDir,
      executablePath: path.join(projectDir, "missing-hyperframes"),
      probeAlphaLayerImpl: async () => media,
    })).resolves.toMatchObject({ overlayPath, receiptPath, elementCount: 1 });

    fs.writeFileSync(timelinePath, JSON.stringify({
      ...JSON.parse(timeline),
      editorial_note: "base assembly changed; overlay projection did not",
    }));
    await expect(renderHyperFramesContentLayer({
      timelinePath,
      outputDir,
      executablePath: path.join(projectDir, "missing-hyperframes"),
      probeAlphaLayerImpl: async () => media,
    })).resolves.toMatchObject({ overlayPath, receiptPath, elementCount: 1 });

    await expect(renderHyperFramesContentLayer({
      timelinePath,
      outputDir,
      executablePath: path.join(projectDir, "missing-hyperframes"),
      probeAlphaLayerImpl: async () => ({ ...media, duration_frames: 29 }),
    })).rejects.toThrow("Pinned HyperFrames CLI is not installed");

    const changed = JSON.parse(timeline);
    changed.tracks.overlay[0].clips[0].metadata.content_element.props.title = "Changed";
    fs.writeFileSync(timelinePath, JSON.stringify(changed));
    await expect(renderHyperFramesContentLayer({
      timelinePath,
      outputDir,
      executablePath: path.join(projectDir, "missing-hyperframes"),
      probeAlphaLayerImpl: async () => media,
    })).rejects.toThrow("Pinned HyperFrames CLI is not installed");
  });

  it.skipIf(!runRealRender)("renders a transparent layer and writes a receipt", async () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "vos-hf-adapter-"));
    tempDirs.push(projectDir);
    const timelinePath = path.join(projectDir, "timeline.json");
    const outputDir = path.join(projectDir, "package");

    fs.writeFileSync(timelinePath, JSON.stringify({
      version: "2",
      project_id: "hf-smoke",
      sequence: { width: 640, height: 360, fps_num: 30, fps_den: 1 },
      tracks: {
        video: [{
          track_id: "V1",
          kind: "video",
          clips: [{
            clip_id: "VID",
            segment_id: "SEG",
            asset_id: "AST",
            src_in_us: 0,
            src_out_us: 1_000_000,
            timeline_in_frame: 0,
            timeline_duration_frames: 30,
            role: "hook",
            motivation: "smoke",
            beat_id: "B1",
            fallback_segment_ids: [],
            confidence: 1,
            quality_flags: [],
          }],
        }],
        audio: [],
        overlay: [{
          track_id: "V3",
          kind: "overlay",
          clips: [{
            clip_id: "HF",
            segment_id: "SEG",
            asset_id: "AST",
            src_in_us: 0,
            src_out_us: 1_000_000,
            timeline_in_frame: 0,
            timeline_duration_frames: 30,
            role: "overlay",
            motivation: "smoke",
            beat_id: "B1",
            fallback_segment_ids: [],
            confidence: 1,
            quality_flags: [],
            metadata: { overlay: { text: "AIビートボックス", styling_class: "vos:overlay.chapter-kicker" } },
          }],
        }],
      },
    }, null, 2));
    const result = await renderHyperFramesContentLayer({
      timelinePath,
      outputDir,
    });

    expect(result).not.toBeNull();
    expect(fs.statSync(result!.overlayPath).size).toBeGreaterThan(0);
    expect(JSON.parse(fs.readFileSync(result!.receiptPath, "utf8"))).toMatchObject({
      version: "hyperframes-layer-receipt/v3",
      renderer: "hyperframes",
      element_ids: ["HF"],
    });
    const probe = JSON.parse(execFileSync("ffprobe", [
      "-v", "error", "-select_streams", "v:0",
      "-show_entries", "stream=width,height,codec_name",
      "-of", "json", result!.overlayPath,
    ], { encoding: "utf8" })) as { streams: Array<Record<string, unknown>> };
    expect(probe.streams[0]).toMatchObject({ width: 640, height: 360 });
  }, 120_000);
});
