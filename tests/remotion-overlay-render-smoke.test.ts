import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { renderRemotionContentLayer } from "../runtime/render/remotion/render-remotion.js";

const runRealRender = process.env.VOS_REMOTION_LAYER_RENDER === "1";
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("Remotion transparent layer smoke", () => {
  it.skipIf(!runRealRender)("renders a compositable alpha WebM without base media", async () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "vos-remotion-alpha-"));
    tempDirs.push(projectDir);
    const timelinePath = path.join(projectDir, "05_timeline", "timeline.json");
    fs.mkdirSync(path.dirname(timelinePath), { recursive: true });
    fs.writeFileSync(timelinePath, JSON.stringify({
      version: "2",
      project_id: "alpha-smoke",
      created_at: "2026-07-24T00:00:00Z",
      sequence: {
        name: "Alpha",
        fps_num: 30,
        fps_den: 1,
        width: 320,
        height: 180,
        start_frame: 0,
        letterbox_policy: "none",
      },
      tracks: {
        video: [{
          track_id: "V1",
          kind: "video",
          clips: [{
            clip_id: "BASE",
            asset_id: "AST",
            segment_id: "SEG",
            src_in_us: 0,
            src_out_us: 400_000,
            timeline_in_frame: 0,
            timeline_duration_frames: 12,
            role: "dialogue",
          }],
        }],
        audio: [],
        overlay: [{
          track_id: "O1",
          kind: "overlay",
          clips: [{
            clip_id: "WORD_CLIP",
            asset_id: "AST",
            segment_id: "SEG",
            src_in_us: 0,
            src_out_us: 400_000,
            timeline_in_frame: 0,
            timeline_duration_frames: 12,
            role: "overlay",
            metadata: {
              content_element: {
                version: "content-element/v1",
                element_id: "WORD",
                kind: "template",
                template_ref: "vos:content.emphasis-word/v1",
                template_version: "1.0.0",
                props: { text: "AI" },
                layout: {
                  anchor: "center",
                  x: 0,
                  y: 0,
                  scale: 1,
                  rotation_deg: 0,
                  opacity: 1,
                  safe_area: true,
                  z_index: 500,
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
        compiler_version: "smoke",
      },
    }));

    const result = await renderRemotionContentLayer({
      timelinePath,
      outputDir: path.join(projectDir, "07_package"),
      compositeStage: "under_caption",
      elementIds: ["WORD"],
    });
    expect(result).not.toBeNull();
    const probe = JSON.parse(execFileSync("ffprobe", [
      "-v", "error",
      "-select_streams", "v:0",
      "-show_entries", "stream=codec_name,pix_fmt:stream_tags=alpha_mode",
      "-of", "json",
      result!.overlayPath,
    ], { encoding: "utf8" })) as {
      streams: Array<{ codec_name?: string; pix_fmt?: string; tags?: { alpha_mode?: string } }>;
    };
    expect(probe.streams[0]).toMatchObject({
      codec_name: "vp9",
      tags: { alpha_mode: "1" },
    });
  }, 120_000);
});
