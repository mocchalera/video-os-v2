import * as path from "node:path";
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
});
