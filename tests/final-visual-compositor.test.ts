import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildFinalVisualCompositorArgs,
  composeFinalVisualsWithEvidence,
  type FinalVisualLayer,
} from "../runtime/render/final-visual-compositor.js";
import {
  assertVisualTemporalCorrespondence,
  measureVisualTemporalCorrespondence,
} from "../runtime/render/visual-composite-temporal-qa.js";

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

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function tmpDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function ffmpeg(args: string[]): void {
  execFileSync("ffmpeg", ["-v", "error", ...args], { maxBuffer: 64 * 1024 * 1024 });
}

/** Optional real NaruNaruGram base that exhibits setpts discontinuity lead. */
function productionBasePath(): string | null {
  const candidates = [
    path.resolve(
      "../video-os-v2-spec-p1-audio-foundation-integration-20260804-codex-narunarugram-heif-contract-fix-luna-max-20260804/tmp/narunarugram-heif-contract-fix-luna-max-20260804/work/final-local-rerender/base-dialogue.mp4",
    ),
    path.resolve(
      "/Users/operator/.agi-tools/worktrees/video-os-v2-spec-p1-audio-foundation-integration-20260804-codex-narunarugram-heif-contract-fix-luna-max-20260804/tmp/narunarugram-heif-contract-fix-luna-max-20260804/work/final-local-rerender/base-dialogue.mp4",
    ),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? null;
}

/**
 * Still opener + motion base via concat demuxer (same assembly shape as the
 * shared assembler). Used for GREEN regression of the fps-first contract.
 */
function buildStillLeadBase(options: {
  dir: string;
  width: number;
  height: number;
  fpsNum: number;
  fpsDen: number;
  stillFrames: number;
  motionFrames: number;
}): string {
  const fps = `${options.fpsNum}/${options.fpsDen}`;
  const stillSec = (options.stillFrames * options.fpsDen) / options.fpsNum;
  const motionSec = (options.motionFrames * options.fpsDen) / options.fpsNum;
  const stillPath = path.join(options.dir, "still.mp4");
  const motionPath = path.join(options.dir, "motion.mp4");
  const basePath = path.join(options.dir, "base-still-lead.mp4");

  ffmpeg([
    "-f", "lavfi",
    "-i", `color=c=0x2244aa:s=${options.width}x${options.height}:r=${fps}:d=${stillSec}`,
    "-frames:v", String(options.stillFrames),
    "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
    "-y", stillPath,
  ]);
  ffmpeg([
    "-f", "lavfi",
    "-i", `testsrc2=s=${options.width}x${options.height}:r=${fps}:d=${motionSec}`,
    "-frames:v", String(options.motionFrames),
    "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
    "-y", motionPath,
  ]);
  const listPath = path.join(options.dir, "concat.txt");
  fs.writeFileSync(
    listPath,
    `file '${stillPath.replace(/'/g, "'\\''")}'\nfile '${motionPath.replace(/'/g, "'\\''")}'\n`,
    "utf8",
  );
  ffmpeg(["-f", "concat", "-safe", "0", "-i", listPath, "-c", "copy", "-y", basePath]);
  return basePath;
}

/** Sparse alpha box; base pixels remain measurable for correspondence probes. */
function buildAlphaLayer(options: {
  dir: string;
  name: string;
  width: number;
  height: number;
  fpsNum: number;
  fpsDen: number;
  frames: number;
}): string {
  const fps = `${options.fpsNum}/${options.fpsDen}`;
  const durationSec = (options.frames * options.fpsDen) / options.fpsNum;
  const out = path.join(options.dir, `${options.name}.webm`);
  // geq alpha keeps most pixels transparent under VP9 alpha_mode=1.
  ffmpeg([
    "-f", "lavfi",
    "-i", `color=c=red:s=${options.width}x${options.height}:r=${fps}:d=${durationSec}`,
    "-vf", `format=yuva420p,geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='if(lt(X\\,24)*lt(Y\\,24)\\,180\\,0)'`,
    "-frames:v", String(options.frames),
    "-c:v", "libvpx-vp9",
    "-pix_fmt", "yuva420p",
    "-auto-alt-ref", "0",
    "-y", out,
  ]);
  return out;
}

function buildStaticBlackBaseWithDynamicOverlay(options: {
  dir: string;
  width: number;
  height: number;
  fps: number;
  frames: number;
}): { basePath: string; outputPath: string } {
  const durationSec = options.frames / options.fps;
  const basePath = path.join(options.dir, "black-base.mp4");
  const outputPath = path.join(options.dir, "black-base-dynamic-overlay.mp4");
  const source = `color=c=black:s=${options.width}x${options.height}:r=${options.fps}:d=${durationSec}`;

  ffmpeg([
    "-f", "lavfi",
    "-i", source,
    "-frames:v", String(options.frames),
    "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
    "-y", basePath,
  ]);
  ffmpeg([
    "-f", "lavfi",
    "-i", source,
    "-vf", "drawbox=x=0:y=0:w=80:h=60:color=white:t=fill:enable='between(n,20,47)'",
    "-frames:v", String(options.frames),
    "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
    "-y", outputPath,
  ]);
  return { basePath, outputPath };
}

function writeMinimalAss(dir: string): { assPath: string; fontsDir: string } {
  const fontsDir = path.join(dir, "fonts");
  fs.mkdirSync(fontsDir, { recursive: true });
  const assPath = path.join(dir, "captions.ass");
  fs.writeFileSync(assPath, `[Script Info]
ScriptType: v4.00+
PlayResX: 160
PlayResY: 120

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,16,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,1,0,2,8,8,8,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:00.50,0:00:01.50,Default,,0,0,0,,Test Caption
`, "utf8");
  return { assPath, fontsDir };
}

describe("final visual compositor args", () => {
  it("normalizes every input with fps=num/den and never uses setpts reset", () => {
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
    const graph = args[args.indexOf("-filter_complex") + 1]!;

    expect(graph).toContain("fps=30000/1001");
    expect(graph).toContain("tpad=stop_mode=add:stop=-1:color=black");
    expect(graph).not.toContain("setpts=");
    expect(graph.indexOf("[base0][layer1]overlay")).toBeLessThan(
      graph.indexOf("subtitles=filename="),
    );
    expect(graph.indexOf("subtitles=filename=")).toBeLessThan(
      graph.indexOf("[captioned][layer2]overlay"),
    );
    expect(args.slice(args.indexOf("-r"), args.indexOf("-r") + 2))
      .toEqual(["-r", "30000/1001"]);
    expect(args.slice(args.indexOf("-frames:v"), args.indexOf("-frames:v") + 2))
      .toEqual(["-frames:v", "1800"]);
  });

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
    const graph = args[args.indexOf("-filter_complex") + 1]!;

    expect(graph).toContain("fps=30/1");
    expect(graph).toContain("subtitles=filename=");
    expect(graph).toContain("tpad=stop_mode=add:stop=-1:color=black");
    expect(graph).not.toContain("format=rgba");
    expect(graph).not.toContain("setpts=");
  });

  it("sorts layers deterministically within each composite stage", () => {
    const args = buildFinalVisualCompositorArgs({
      baseVideoPath: "/tmp/base.mp4",
      layers: [
        { ...layers[0]!, path: "/tmp/high.webm", zIndex: 200 },
        { ...layers[0]!, path: "/tmp/low.webm", zIndex: 10 },
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

describe("final visual compositor temporal correspondence", () => {
  it("fail-first: static black base with a dynamic overlay is unobservable, not a false offset", async () => {
    const dir = tmpDir("vos-fvc-static-black-");
    const { basePath, outputPath } = buildStaticBlackBaseWithDynamicOverlay({
      dir,
      width: 160,
      height: 120,
      fps: 24,
      frames: 60,
    });

    const result = await measureVisualTemporalCorrespondence({
      baseVideoPath: basePath,
      outputVideoPath: outputPath,
      probeWidth: 16,
      probeHeight: 12,
      searchRadiusFrames: 48,
      sampleStartFrame: 9,
      sampleEndFrame: 48,
      sampleStride: 4,
      thresholdFrames: 1,
    });
    const unobservable = result as typeof result & {
      verdict?: string;
      unobservable_reason?: string;
    };

    expect(result.best_offset_frames).toBeNull();
    expect(unobservable.verdict).toBe("unobservable");
    expect(result.pass).toBe(false);
    expect(result.skipped).toBe(false);
    expect(result.sample_count).toBeGreaterThanOrEqual(4);
    expect(unobservable.unobservable_reason).toMatch(/temporal_discriminability/);
    expect(() => assertVisualTemporalCorrespondence(result))
      .toThrow("visual_composite_temporal_correspondence_unobservable");
  }, 120_000);

  it("fail-first: engineered still-lead (72f) is detected and fails closed", async () => {
    const dir = tmpDir("vos-fvc-engineered-lead-");
    const stillFrames = 72;
    const motionFrames = 168;
    const total = stillFrames + motionFrames;
    const basePath = buildStillLeadBase({
      dir,
      width: 160,
      height: 120,
      fpsNum: 24,
      fpsDen: 1,
      stillFrames,
      motionFrames,
    });
    // Engineered broken composite: drop the still opener so talking-head leads.
    const brokenPath = path.join(dir, "broken-lead.mp4");
    ffmpeg([
      "-i", basePath,
      "-vf", `select=gte(n\\,${stillFrames}),setpts=N/24/TB`,
      "-frames:v", String(motionFrames),
      "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
      "-y", brokenPath,
    ]);
    // Pad back to timeline length with black so duration/frame-count QA would still GREEN.
    const brokenPadded = path.join(dir, "broken-lead-padded.mp4");
    ffmpeg([
      "-i", brokenPath,
      "-vf", `tpad=start_mode=add:start_duration=0:stop_mode=add:stop_duration=${stillFrames / 24}:color=black`,
      "-frames:v", String(total),
      "-r", "24",
      "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
      "-y", brokenPadded,
    ]);

    const result = await measureVisualTemporalCorrespondence({
      baseVideoPath: basePath,
      outputVideoPath: brokenPadded,
      searchRadiusFrames: 96,
      sampleStartFrame: stillFrames + 8,
      sampleEndFrame: total - 8,
      sampleStride: 2,
      thresholdFrames: 1,
    });

    expect(result.verdict).toBe("fail");
    expect(result.best_offset_frames).not.toBeNull();
    expect(result.best_offset_frames!).toBeGreaterThanOrEqual(stillFrames - 4);
    expect(result.best_offset_frames!).toBeLessThanOrEqual(stillFrames + 4);
    expect(result.pass).toBe(false);
    expect(result.output_frame_count).toBe(total);
  }, 120_000);

  it("fail-first: legacy setpts graph on production still-cut base leads by ~still opener", async () => {
    const basePath = productionBasePath();
    if (!basePath) {
      // Keep CI green without private media; the engineered-lead test remains the always-on RED contract.
      return;
    }
    const dir = tmpDir("vos-fvc-legacy-prod-");
    const legacyOut = path.join(dir, "legacy.mp4");
    const total = 600;
    ffmpeg([
      "-y", "-i", basePath,
      "-filter_complex",
      `[0:v]setpts=PTS-STARTPTS,tpad=stop_mode=add:stop_duration=${total / 24}:color=black,format=yuv420p[v]`,
      "-map", "[v]",
      "-an",
      "-r", "24/1",
      "-fps_mode", "cfr",
      "-frames:v", String(total),
      "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
      legacyOut,
    ]);
    const result = await measureVisualTemporalCorrespondence({
      baseVideoPath: basePath,
      outputVideoPath: legacyOut,
      searchRadiusFrames: 96,
      sampleStartFrame: 96,
      sampleEndFrame: 480,
      sampleStride: 4,
      thresholdFrames: 1,
    });
    expect(result.verdict).toBe("fail");
    expect(result.best_offset_frames).not.toBeNull();
    expect(result.best_offset_frames!).toBeGreaterThanOrEqual(64);
    expect(result.pass).toBe(false);
  }, 180_000);

  it("preserves frame correspondence for multi-layer+caption 24fps still-lead bases", async () => {
    const dir = tmpDir("vos-fvc-fix-24-");
    const stillFrames = 72;
    const motionFrames = 168;
    const total = stillFrames + motionFrames;
    const basePath = buildStillLeadBase({
      dir,
      width: 160,
      height: 120,
      fpsNum: 24,
      fpsDen: 1,
      stillFrames,
      motionFrames,
    });
    const layerA = buildAlphaLayer({
      dir, name: "layer-a", width: 160, height: 120, fpsNum: 24, fpsDen: 1, frames: total,
    });
    const layerB = buildAlphaLayer({
      dir, name: "layer-b", width: 160, height: 120, fpsNum: 24, fpsDen: 1, frames: total,
    });
    const { assPath, fontsDir } = writeMinimalAss(dir);
    const outputPath = path.join(dir, "composited.mp4");

    const composed = await composeFinalVisualsWithEvidence({
      baseVideoPath: basePath,
      layers: [
        {
          path: layerA,
          renderer: "hyperframes",
          compositeStage: "under_caption",
          zIndex: 100,
        },
        {
          path: layerB,
          renderer: "remotion",
          compositeStage: "over_caption",
          zIndex: 200,
        },
      ],
      assPath,
      fontsDir,
      outputPath,
      width: 160,
      height: 120,
      fpsNum: 24,
      fpsDen: 1,
      durationFrames: total,
      enforceTemporalCorrespondence: true,
      temporalCorrespondenceThresholdFrames: 1,
    });

    expect(composed.temporalCorrespondence?.verdict).toBe("pass");
    expect(composed.temporalCorrespondence?.pass).toBe(true);
    expect(Math.abs(composed.temporalCorrespondence!.best_offset_frames!)).toBeLessThanOrEqual(1);
    expect(fs.existsSync(composed.temporalCorrespondenceEvidencePath!)).toBe(true);
  }, 180_000);

  it("preserves correspondence for caption-only and no-layer duration pad at 30000/1001", async () => {
    const dir = tmpDir("vos-fvc-fix-ntsc-");
    const stillFrames = 72;
    const motionFrames = 120;
    const total = stillFrames + motionFrames;
    const basePath = buildStillLeadBase({
      dir,
      width: 160,
      height: 120,
      fpsNum: 30_000,
      fpsDen: 1_001,
      stillFrames,
      motionFrames,
    });
    const { assPath, fontsDir } = writeMinimalAss(dir);

    const captionOnly = path.join(dir, "caption-only.mp4");
    const captionResult = await composeFinalVisualsWithEvidence({
      baseVideoPath: basePath,
      layers: [],
      assPath,
      fontsDir,
      outputPath: captionOnly,
      width: 160,
      height: 120,
      fpsNum: 30_000,
      fpsDen: 1_001,
      durationFrames: total,
      enforceTemporalCorrespondence: true,
    });
    expect(captionResult.temporalCorrespondence?.verdict).toBe("pass");
    expect(Math.abs(captionResult.temporalCorrespondence!.best_offset_frames!)).toBeLessThanOrEqual(1);

    const noLayer = path.join(dir, "no-layer.mp4");
    const noLayerResult = await composeFinalVisualsWithEvidence({
      baseVideoPath: basePath,
      layers: [],
      outputPath: noLayer,
      width: 160,
      height: 120,
      fpsNum: 30_000,
      fpsDen: 1_001,
      durationFrames: total,
      enforceTemporalCorrespondence: true,
    });
    expect(noLayerResult.temporalCorrespondence?.verdict).toBe("pass");
    expect(Math.abs(noLayerResult.temporalCorrespondence!.best_offset_frames!)).toBeLessThanOrEqual(1);
  }, 180_000);

  it("preserves correspondence for single-layer composites", async () => {
    const dir = tmpDir("vos-fvc-single-");
    const stillFrames = 48;
    const motionFrames = 96;
    const total = stillFrames + motionFrames;
    const basePath = buildStillLeadBase({
      dir,
      width: 128,
      height: 96,
      fpsNum: 24,
      fpsDen: 1,
      stillFrames,
      motionFrames,
    });
    const layer = buildAlphaLayer({
      dir, name: "single", width: 128, height: 96, fpsNum: 24, fpsDen: 1, frames: total,
    });
    const outputPath = path.join(dir, "single.mp4");
    const result = await composeFinalVisualsWithEvidence({
      baseVideoPath: basePath,
      layers: [{
        path: layer,
        renderer: "hyperframes",
        compositeStage: "under_caption",
        zIndex: 50,
      }],
      outputPath,
      width: 128,
      height: 96,
      fpsNum: 24,
      fpsDen: 1,
      durationFrames: total,
      enforceTemporalCorrespondence: true,
    });
    expect(result.temporalCorrespondence?.verdict).toBe("pass");
    expect(result.temporalCorrespondence?.pass).toBe(true);
    expect(Math.abs(result.temporalCorrespondence!.best_offset_frames!)).toBeLessThanOrEqual(1);
  }, 120_000);

  it("fixes production base lead when available (shared compositor contract)", async () => {
    const basePath = productionBasePath();
    if (!basePath) return;
    const dir = tmpDir("vos-fvc-prod-fix-");
    const outputPath = path.join(dir, "fixed.mp4");
    const result = await composeFinalVisualsWithEvidence({
      baseVideoPath: basePath,
      layers: [],
      outputPath,
      width: 1080,
      height: 1920,
      fpsNum: 24,
      fpsDen: 1,
      durationFrames: 600,
      enforceTemporalCorrespondence: true,
      temporalCorrespondenceThresholdFrames: 1,
    });
    expect(result.temporalCorrespondence?.verdict).toBe("pass");
    expect(result.temporalCorrespondence?.pass).toBe(true);
    expect(Math.abs(result.temporalCorrespondence!.best_offset_frames!)).toBeLessThanOrEqual(1);
  }, 180_000);
});
