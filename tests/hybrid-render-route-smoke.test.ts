import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runRenderPipeline } from "../runtime/render/pipeline.js";

const runRealRender = process.env.VOS_HYBRID_RENDER === "1";
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0, tempDirs.length)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function overlayClip(
  clipId: string,
  startFrame: number,
  durationFrames: number,
  contentElement: Record<string, unknown>,
) {
  return {
    clip_id: clipId,
    segment_id: `TXT_${clipId}`,
    asset_id: "__overlay__",
    src_in_us: 0,
    src_out_us: Math.round(durationFrames / 24 * 1_000_000),
    timeline_in_frame: startFrame,
    timeline_duration_frames: durationFrames,
    role: "title",
    motivation: "hybrid render smoke",
    beat_id: "B1",
    fallback_segment_ids: [],
    confidence: 1,
    quality_flags: [],
    metadata: { content_element: contentElement },
  };
}

function contentElement(input: {
  id: string;
  template: string;
  props: Record<string, string>;
  anchor: string;
  zIndex: number;
}) {
  return {
    version: "content-element/v1",
    element_id: input.id,
    kind: "template",
    template_ref: input.template,
    template_version: "1.0.0",
    props: input.props,
    layout: {
      anchor: input.anchor,
      x: 0,
      y: 0,
      scale: 1,
      rotation_deg: 0,
      opacity: 1,
      safe_area: true,
      z_index: input.zIndex,
    },
    renderer_hint: "auto",
  };
}

describe("hybrid production render route", () => {
  it.skipIf(!runRealRender)(
    "renders canonical Remotion and HyperFrames elements through one package pipeline",
    async () => {
      const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "vos-hybrid-route-"));
      tempDirs.push(projectDir);
      const timelineDir = path.join(projectDir, "05_timeline");
      const timelinePath = path.join(timelineDir, "timeline.json");
      const sourcePath = path.join(projectDir, "source.mp4");
      const assemblyPath = path.join(timelineDir, "assembly.mp4");
      const outputDir = path.join(projectDir, "07_package");
      fs.mkdirSync(timelineDir, { recursive: true });

      execFileSync("ffmpeg", [
        "-v", "error", "-y",
        "-f", "lavfi", "-i", "color=c=0x26384f:s=320x568:r=24:d=1",
        "-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo",
        "-shortest", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac",
        sourcePath,
      ]);
      fs.mkdirSync(path.join(projectDir, "02_media"), { recursive: true });
      fs.writeFileSync(path.join(projectDir, "02_media/source_map.json"), JSON.stringify({
        version: "1",
        project_id: "hybrid-route-smoke",
        media_dir: "02_media",
        generated_at: "2026-07-20T00:00:00.000Z",
        items: [{
          asset_id: "AST",
          source_locator: sourcePath,
          local_source_path: sourcePath,
          link_path: "source.mp4",
        }],
      }));

      fs.writeFileSync(timelinePath, JSON.stringify({
        version: "1",
        project_id: "hybrid-route-smoke",
        created_at: "2026-07-17T00:00:00.000Z",
        sequence: {
          name: "Hybrid route smoke",
          fps_num: 24,
          fps_den: 1,
          width: 320,
          height: 568,
          start_frame: 0,
          letterbox_policy: "none",
        },
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
              timeline_duration_frames: 24,
              role: "hook",
              motivation: "hybrid render smoke",
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
            clips: [
              overlayClip("REMOTION_TITLE", 0, 12, contentElement({
                id: "title",
                template: "vos:content.title-card/v1",
                props: { title: "AIが本気を出す" },
                anchor: "top_center",
                zIndex: 100,
              })),
              overlayClip("HF_SECTION", 12, 12, contentElement({
                id: "section",
                template: "vos:content.section-label/v1",
                props: { title: "限界突破" },
                anchor: "top_left",
                zIndex: 110,
              })),
            ],
          }],
        },
        markers: [],
        provenance: {
          brief_path: "01_intent/creative_brief.yaml",
          blueprint_path: "04_plan/edit_blueprint.yaml",
          selects_path: "04_plan/selects_candidates.yaml",
          compiler_version: "hybrid-smoke",
        },
      }, null, 2));

      const result = await runRenderPipeline({
        projectDir,
        timelinePath,
        assemblyEngine: "remotion",
        assemblyOutputPath: assemblyPath,
        sourceMap: { AST: sourcePath },
        captionPolicy: {
          language: "ja",
          delivery_mode: "sidecar",
          source: "none",
          styling_class: "sns-vertical-outline",
        },
        outputDir,
        fps: 24,
      });

      expect(fs.statSync(result.finalVideoPath).size).toBeGreaterThan(0);
      expect(JSON.parse(fs.readFileSync(result.renderRouteReceiptPath, "utf8"))).toMatchObject({
        version: "render-route/v2",
        assembly_engine: "remotion",
        remotion_overlay_count: 1,
        hyperframes_overlay: true,
        hyperframes_element_count: 1,
        speech_caption_engine: "none",
      });
      expect(result.logs).toHaveProperty("hyperframes");
    },
    180_000,
  );
});
