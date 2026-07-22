import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runRenderPipeline } from "../runtime/render/pipeline.js";

const originalVosRenderEngine = process.env.VOS_RENDER_ENGINE;

function minimalRenderOptions() {
  return {
    projectDir: "/tmp/vos-render-pipeline-engine-fallback",
    timelinePath: "/tmp/vos-render-pipeline-engine-fallback/timeline.json",
    captionPolicy: {
      language: "ja",
      delivery_mode: "sidecar" as const,
      source: "none" as const,
      styling_class: "clean-lower-third",
    },
    outputDir: "/tmp/vos-render-pipeline-engine-fallback/07_package",
    fps: 30,
  };
}

beforeEach(() => {
  delete process.env.VOS_RENDER_ENGINE;
});

afterEach(() => {
  if (originalVosRenderEngine === undefined) {
    delete process.env.VOS_RENDER_ENGINE;
  } else {
    process.env.VOS_RENDER_ENGINE = originalVosRenderEngine;
  }
});

describe("render pipeline alternate assembly engine fallback", () => {
  it("keeps throwing when assemblyPath and engine are both missing", async () => {
    await expect(
      runRenderPipeline({
        ...minimalRenderOptions(),
        assemblyPath: undefined,
        assemblyEngine: undefined,
      }),
    ).rejects.toThrow("No assemblyPath provided and no assembly engine selected");
  });

  it("requires alternate engine input options before dispatch", async () => {
    await expect(
      runRenderPipeline({
        ...minimalRenderOptions(),
        assemblyPath: undefined,
        assemblyEngine: "remotion",
        timelinePath: undefined,
      } as never),
    ).rejects.toThrow(
      "Alternate assembly engine requires timelinePath, sourceMap, and assemblyOutputPath options.",
    );
  });

  it("keeps the existing missing assembly file error", async () => {
    const assemblyPath = path.join(
      "/tmp/vos-render-pipeline-engine-fallback",
      "missing-assembly.mp4",
    );

    await expect(
      runRenderPipeline({
        ...minimalRenderOptions(),
        assemblyPath,
      }),
    ).rejects.toThrow(`Assembly file not found: ${assemblyPath}`);
  });

  it("fails closed when a prebuilt FFmpeg assembly could omit Remotion overlays", async () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "vos-route-prebuilt-"));
    const timelinePath = path.join(projectDir, "05_timeline", "timeline.json");
    const assemblyPath = path.join(projectDir, "05_timeline", "assembly.mp4");
    fs.mkdirSync(path.dirname(timelinePath), { recursive: true });
    fs.writeFileSync(assemblyPath, "stub");
    fs.writeFileSync(timelinePath, JSON.stringify({
      sequence: { width: 1080, height: 1920, fps_num: 30, fps_den: 1 },
      tracks: {
        video: [],
        audio: [],
        overlay: [{
          track_id: "O1",
          kind: "overlay",
          clips: [{
            clip_id: "TITLE",
            timeline_in_frame: 0,
            timeline_duration_frames: 30,
            metadata: {
              overlay: {
                text: "本気のビートボックス",
                styling_class: "vos:overlay.title-card",
              },
            },
          }],
        }],
      },
    }));

    try {
      await expect(runRenderPipeline({
        ...minimalRenderOptions(),
        projectDir,
        timelinePath,
        outputDir: path.join(projectDir, "07_package"),
        assemblyPath,
      })).rejects.toThrow("Prebuilt assemblyPath cannot prove that 1 Remotion-owned overlay");
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });
});
