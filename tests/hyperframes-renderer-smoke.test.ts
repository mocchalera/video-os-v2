import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { renderHyperFramesContentOverlay } from "../runtime/content/hyperframes-renderer.js";

const runRealRender = process.env.VOS_HYPERFRAMES_RENDER === "1";
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0, tempDirs.length)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("HyperFrames production content adapter", () => {
  it.skipIf(!runRealRender)("renders, alpha-composites, and writes a receipt", async () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "vos-hf-adapter-"));
    tempDirs.push(projectDir);
    const timelinePath = path.join(projectDir, "timeline.json");
    const baseAssemblyPath = path.join(projectDir, "base.mp4");
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
    execFileSync("ffmpeg", [
      "-v", "error", "-y",
      "-f", "lavfi", "-i", "color=c=0x24405f:s=640x360:r=30:d=1",
      "-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo",
      "-shortest", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac",
      baseAssemblyPath,
    ]);

    const result = await renderHyperFramesContentOverlay({
      timelinePath,
      baseAssemblyPath,
      outputDir,
    });

    expect(result).not.toBeNull();
    expect(fs.statSync(result!.compositePath).size).toBeGreaterThan(0);
    expect(fs.statSync(result!.overlayPath).size).toBeGreaterThan(0);
    expect(JSON.parse(fs.readFileSync(result!.receiptPath, "utf8"))).toMatchObject({
      version: "hyperframes-render-receipt/v1",
      renderer: "hyperframes",
      element_ids: ["HF"],
    });
    const probe = JSON.parse(execFileSync("ffprobe", [
      "-v", "error", "-select_streams", "v:0",
      "-show_entries", "stream=width,height,codec_name",
      "-of", "json", result!.compositePath,
    ], { encoding: "utf8" })) as { streams: Array<Record<string, unknown>> };
    expect(probe.streams[0]).toMatchObject({ width: 640, height: 360, codec_name: "h264" });
  }, 120_000);
});
