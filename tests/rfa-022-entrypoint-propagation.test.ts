import { describe, expect, it, vi } from "vitest";

const { resolveSharedAudioRenderPlanMock } = vi.hoisted(() => ({
  resolveSharedAudioRenderPlanMock: vi.fn(),
}));

vi.mock("../runtime/audio/render-route.js", () => ({
  resolveSharedAudioRenderPlan: resolveSharedAudioRenderPlanMock,
}));

import { runRenderPipeline } from "../runtime/render/pipeline.js";

describe("RFA-022 repository SFX root propagation", () => {
  it("passes repoSfxRoot through the direct render pipeline API", async () => {
    resolveSharedAudioRenderPlanMock.mockImplementation(() => {
      throw new Error("route-propagation-probe");
    });

    await expect(runRenderPipeline({
      projectDir: "/tmp/project",
      timelinePath: "/tmp/project/05_timeline/timeline.json",
      repoSfxRoot: "/tmp/repo/resources/sfx",
      outputDir: "/tmp/project/09_output",
      fps: 30,
      captionPolicy: {
        language: "en",
        delivery_mode: "sidecar",
        source: "none",
        styling_class: "clean-lower-third",
      },
    })).rejects.toThrow("route-propagation-probe");

    expect(resolveSharedAudioRenderPlanMock).toHaveBeenCalledWith(expect.objectContaining({
      repoSfxRoot: "/tmp/repo/resources/sfx",
    }));
  });
});
