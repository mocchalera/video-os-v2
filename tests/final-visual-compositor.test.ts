import { describe, expect, it } from "vitest";
import {
  buildFinalVisualCompositorArgs,
  type FinalVisualLayer,
} from "../runtime/render/final-visual-compositor.js";

const layers: FinalVisualLayer[] = [
  {
    path: "/tmp/hyperframes.webm",
    renderer: "hyperframes",
    compositeStage: "under_caption",
    zIndex: 100,
    elementIds: ["section"],
  },
  {
    path: "/tmp/remotion.webm",
    renderer: "remotion",
    compositeStage: "over_caption",
    zIndex: 900,
    elementIds: ["callout"],
  },
];

describe("final visual compositor", () => {
  it("keeps caption-only burns on the base pixel format", () => {
    const args = buildFinalVisualCompositorArgs({
      baseVideoPath: "/tmp/base.mp4",
      layers: [],
      assPath: "/tmp/captions.ass",
      fontsDir: "/tmp/fonts",
      outputPath: "/tmp/final-visual.mp4",
      width: 640,
      height: 360,
      fpsNum: 30,
      fpsDen: 1,
      durationFrames: 120,
    });
    const graph = args[args.indexOf("-filter_complex") + 1];

    expect(graph).toContain("subtitles=filename=");
    expect(graph).toContain("tpad=stop_mode=add:stop_duration=4:color=black");
    expect(graph).not.toContain("format=rgba");
  });

  it("combines visual layers and ASS captions in one video encode", () => {
    const args = buildFinalVisualCompositorArgs({
      baseVideoPath: "/tmp/base.mp4",
      layers,
      assPath: "/tmp/captions.ass",
      fontsDir: "/tmp/fonts",
      outputPath: "/tmp/final-visual.mp4",
      width: 1920,
      height: 1080,
      fpsNum: 30_000,
      fpsDen: 1_001,
      durationFrames: 1_800,
    });
    const graph = args[args.indexOf("-filter_complex") + 1];

    expect(args.filter((value, index) =>
      value === "-c:v" && args[index + 1] === "libx264"
    )).toHaveLength(1);
    expect(args.slice(args.indexOf("-r"), args.indexOf("-r") + 2))
      .toEqual(["-r", "30000/1001"]);
    expect(args.slice(args.indexOf("-frames:v"), args.indexOf("-frames:v") + 2))
      .toEqual(["-frames:v", "1800"]);
    expect(graph.indexOf("[base0][layer1]overlay")).toBeLessThan(
      graph.indexOf("subtitles=filename="),
    );
    expect(graph.indexOf("subtitles=filename=")).toBeLessThan(
      graph.indexOf("[captioned][layer2]overlay"),
    );
    expect(args).toContain("-an");
  });

  it("sorts layers deterministically within each composite stage", () => {
    const args = buildFinalVisualCompositorArgs({
      baseVideoPath: "/tmp/base.mp4",
      layers: [
        { ...layers[0], path: "/tmp/high.webm", zIndex: 200 },
        { ...layers[0], path: "/tmp/low.webm", zIndex: 10 },
      ],
      outputPath: "/tmp/final-visual.mp4",
      width: 1280,
      height: 720,
      fpsNum: 24,
      fpsDen: 1,
    });

    expect(args.indexOf("/tmp/low.webm")).toBeLessThan(args.indexOf("/tmp/high.webm"));
  });
});
