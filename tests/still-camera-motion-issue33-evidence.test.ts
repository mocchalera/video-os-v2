import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ContentRenderPlan } from "../runtime/content/render-plan.js";
import { ingestAsset } from "../runtime/connectors/ffprobe.js";
import { probeStillCameraCapability } from "../runtime/connectors/still-camera-local.js";
import {
  cameraMotionTrajectory,
  resolveStillCameraMotion,
  type StillCameraFitMode,
  type StillCameraMotionPreset,
  type StillCameraMotionReceipt,
} from "../runtime/render/camera-motion.js";
import { assembleTimelineToMp4 } from "../runtime/render/assembler.js";
import { writeRenderRouteReceipt, resolveRenderRoute } from "../runtime/render/route-resolver.js";
import { renderStillMotionSegment } from "../runtime/render/still-motion-render.js";
import { validateAgainstSchema } from "../runtime/commands/shared.js";

const SOURCE_WIDTH = 941;
const SOURCE_HEIGHT = 1672;
const OUTPUT_WIDTH = 320;
const OUTPUT_HEIGHT = 568;
const PRODUCTION_WIDTH = 1080;
const PRODUCTION_HEIGHT = 1920;
const PRODUCTION_FPS = { num: 24, den: 1 };
const VERTICAL_BOUNDARY = 235;
const HORIZONTAL_BOUNDARY = 417;
const THIN_VERTICAL_LINE = 700;
const THIN_HORIZONTAL_LINE = 1100;
const THIN_LINE_WIDTH = 8;
// Decode gates are expressed in source pixels, so a 1px source reversal or
// 2px quantization jump cannot hide behind the 941->320 output scale.
const POSITION_TOLERANCE_SOURCE_PX = 3;
const TOTAL_DISPLACEMENT_TOLERANCE_SOURCE_PX = 3;
const DIRECTION_NOISE_SOURCE_PX = 0.5;
const CUMULATIVE_REVERSE_SOURCE_PX = 0.5;
// Smoothstep's first non-stalled decoded step can reach about 1.95 source px
// at this bounded probe; 1.99 still rejects the literal 2px old quantization.
const STOP_JUMP_SOURCE_PX = 1.99;
// The real 320px decoded probe can quantize a nonzero step to about 0.037
// source px; old integer/crop repeats are exactly stationary between jumps.
const STALLED_STEP_SOURCE_PX = 0.02;
const PERIODIC_STOP_JUMP_MIN_STALLS = 5;
const PERIODIC_STOP_JUMP_MIN_JUMPS = 2;

const tempDirs: string[] = [];

function ffmpeg(args: string[], input?: Buffer): Buffer {
  return execFileSync("ffmpeg", ["-v", "error", ...args], {
    input,
    maxBuffer: 512 * 1024 * 1024,
  });
}

function ffprobeJson(args: string[]): any {
  return JSON.parse(execFileSync("ffprobe", ["-v", "error", ...args], { encoding: "utf8" }));
}

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function makeIssue33Source(root: string): string {
  const sourcePath = path.join(root, "issue33-941x1672.png");
  const rgb = Buffer.alloc(SOURCE_WIDTH * SOURCE_HEIGHT * 3);
  let offset = 0;
  for (let y = 0; y < SOURCE_HEIGHT; y++) {
    for (let x = 0; x < SOURCE_WIDTH; x++) {
      const thinLine = (x >= THIN_VERTICAL_LINE && x < THIN_VERTICAL_LINE + THIN_LINE_WIDTH)
        || (y >= THIN_HORIZONTAL_LINE && y < THIN_HORIZONTAL_LINE + THIN_LINE_WIDTH);
      // Independent luminance levels keep the vertical and horizontal
      // tracking edges measurable in one high-contrast frame: 0->80 for the
      // vertical edge, 80->255 for the horizontal edge. This avoids chroma
      // subsampling becoming a false motion signal in the evidence reader.
      const value = thinLine
        ? 255
        : (x >= VERTICAL_BOUNDARY ? 80 : 0) + (y >= HORIZONTAL_BOUNDARY ? 175 : 0);
      rgb[offset++] = value;
      rgb[offset++] = value;
      rgb[offset++] = value;
    }
  }
  ffmpeg([
    "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", `${SOURCE_WIDTH}x${SOURCE_HEIGHT}`,
    "-i", "-", "-frames:v", "1", "-y", sourcePath,
  ], rgb);
  const stream = ffprobeJson([
    "-show_entries", "stream=width,height", "-of", "json", sourcePath,
  ]).streams[0];
  expect(stream).toMatchObject({ width: SOURCE_WIDTH, height: SOURCE_HEIGHT });
  return sourcePath;
}

function probeMedia(filePath: string): {
  streams: Array<Record<string, unknown>>;
  format: Record<string, unknown>;
} {
  return ffprobeJson([
    "-count_frames",
    "-show_entries", "stream=codec_type,width,height,r_frame_rate,avg_frame_rate,nb_read_frames,time_base,start_time,duration",
    "-show_entries", "format=duration",
    "-of", "json", filePath,
  ]);
}

interface RgbFrames {
  data: Buffer;
  width: number;
  height: number;
  count: number;
}

function decodeRgb(filePath: string): RgbFrames {
  const media = probeMedia(filePath);
  const video = media.streams.find((stream) => stream.codec_type === "video")!;
  const width = Number(video.width);
  const height = Number(video.height);
  const count = Number(video.nb_read_frames);
  const data = ffmpeg([
    "-i", filePath, "-map", "0:v:0", "-f", "rawvideo", "-pix_fmt", "rgb24", "-",
  ]);
  expect(data.length).toBe(width * height * count * 3);
  return { data, width, height, count };
}

function rgbAt(frames: RgbFrames, frame: number, x: number, y: number, channel: number): number {
  const index = ((frame * frames.width * frames.height) + (y * frames.width) + x) * 3 + channel;
  return frames.data[index];
}

function maxChannelNear(
  frames: RgbFrames,
  frame: number,
  x: number,
  y: number,
  channel: number,
  radius = 3,
): number {
  let max = 0;
  for (let yy = Math.max(0, y - radius); yy <= Math.min(frames.height - 1, y + radius); yy++) {
    for (let xx = Math.max(0, x - radius); xx <= Math.min(frames.width - 1, x + radius); xx++) {
      max = Math.max(max, rgbAt(frames, frame, xx, yy, channel));
    }
  }
  return max;
}

function stepBoundary(
  frames: RgbFrames,
  frame: number,
  axis: "x" | "y",
  channel: number,
  sampleCoordinate: number,
  near: number,
  low: number,
  high: number,
): number {
  const size = axis === "x" ? frames.width : frames.height;
  const fixed = Math.max(0, Math.min(
    axis === "x" ? frames.height - 1 : frames.width - 1,
    Math.round(sampleCoordinate),
  ));
  const start = Math.max(0, Math.floor(near) - 64);
  const end = Math.min(size - 1, Math.ceil(near) + 64);
  let normalizedArea = 0;
  for (let position = start; position <= end; position++) {
    const value = axis === "x"
      ? rgbAt(frames, frame, position, fixed, channel)
      : rgbAt(frames, frame, fixed, position, channel);
    normalizedArea += Math.max(0, Math.min(1, (value - low) / (high - low)));
  }
  // The area of a monotone step is its subpixel boundary position. Unlike a
  // single 8-bit threshold crossing, this remains stable when the lossless
  // luma edge spans different Lanczos phases after yuv420p decode.
  return end + 0.5 - normalizedArea;
}

function fitScaleFor(fitMode: StillCameraFitMode): number {
  return fitMode === "contain"
    ? Math.min(OUTPUT_WIDTH / SOURCE_WIDTH, OUTPUT_HEIGHT / SOURCE_HEIGHT)
    : Math.max(OUTPUT_WIDTH / SOURCE_WIDTH, OUTPUT_HEIGHT / SOURCE_HEIGHT);
}

function fittedBoundaryPosition(
  sourceBoundary: number,
  state: { zoom: number; centerX: number; centerY: number },
  axis: "x" | "y",
  fitMode: StillCameraFitMode,
): number {
  const fitScale = fitScaleFor(fitMode);
  const offset = axis === "x"
    ? (OUTPUT_WIDTH - SOURCE_WIDTH * fitScale) / 2
    : (OUTPUT_HEIGHT - SOURCE_HEIGHT * fitScale) / 2;
  const baseBoundary = sourceBoundary * fitScale + offset;
  const center = axis === "x" ? state.centerX : state.centerY;
  const dimension = axis === "x" ? OUTPUT_WIDTH : OUTPUT_HEIGHT;
  return (baseBoundary - center * dimension) * state.zoom + dimension / 2 - 0.5;
}

function assertNoReverseOrStopJump(
  measured: number[],
  intended: number[],
  fitScale: number,
  label = "motion",
): void {
  const measuredSource = measured.map((value) => value / fitScale);
  const intendedSource = intended.map((value) => value / fitScale);
  const intendedNet = intendedSource.at(-1)! - intendedSource[0];
  const measuredNet = measuredSource.at(-1)! - measuredSource[0];
  expect(Math.sign(measuredNet)).toBe(Math.sign(intendedNet));
  const measuredSteps = measuredSource.slice(1).map((value, index) => value - measuredSource[index]);
  const cumulativeTravel = measuredSource.map((value) => value - measuredSource[0]);
  const cumulativeReverse = intendedNet < 0
    ? Math.max(...cumulativeTravel)
    : Math.max(...cumulativeTravel.map((value) => -value));
  expect(cumulativeReverse, `${label} cumulative reverse`).toBeLessThanOrEqual(CUMULATIVE_REVERSE_SOURCE_PX);
  for (let i = 1; i < measured.length; i++) {
    if (intendedNet < 0) {
      expect(measuredSource[i]).toBeLessThanOrEqual(measuredSource[i - 1] + DIRECTION_NOISE_SOURCE_PX);
    } else {
      expect(measuredSource[i]).toBeGreaterThanOrEqual(measuredSource[i - 1] - DIRECTION_NOISE_SOURCE_PX);
    }
  }
  // A coarse integer/crop path exhibits repeated stops followed by a grid
  // jump. Preserve the two-stall check for the original failure mode.
  for (let i = 0; i + 2 < measuredSteps.length; i++) {
    if (Math.abs(measuredSteps[i]) <= STALLED_STEP_SOURCE_PX && Math.abs(measuredSteps[i + 1]) <= STALLED_STEP_SOURCE_PX) {
      expect(Math.abs(measuredSteps[i + 2]), `${label} stop-jump at frame ${i + 2}`).toBeLessThan(STOP_JUMP_SOURCE_PX);
    }
  }
  // A rounded path can alternate one stationary frame and one grid jump, so
  // requiring two adjacent stalls misses the periodic artifact. Count the
  // source-pixel-normalized pattern directly. Genuine Lanczos edge-area
  // measurements can contain isolated stalls and large steps, so the
  // non-adjacent fallback below requires actual source-pixel grid locking.
  let singleStallStopJumps = 0;
  for (let i = 0; i + 1 < measuredSteps.length; i++) {
    if (
      Math.abs(measuredSteps[i]) <= STALLED_STEP_SOURCE_PX
      && Math.abs(measuredSteps[i + 1]) >= STOP_JUMP_SOURCE_PX
    ) {
      singleStallStopJumps++;
    }
  }
  expect(singleStallStopJumps, `${label} periodic single-stall stop-jump`)
    .toBeLessThan(2);
  const stalledStepCount = measuredSteps.filter((step) => Math.abs(step) <= STALLED_STEP_SOURCE_PX).length;
  const stopJumpCount = measuredSteps.filter((step) => Math.abs(step) >= STOP_JUMP_SOURCE_PX).length;
  const sourcePixelGridLocked = measuredSource.every((position) =>
    Math.abs(position - Math.round(position)) <= STALLED_STEP_SOURCE_PX,
  );
  expect(
    stalledStepCount >= PERIODIC_STOP_JUMP_MIN_STALLS
      && stopJumpCount >= PERIODIC_STOP_JUMP_MIN_JUMPS
      && sourcePixelGridLocked,
    `${label} periodic rounded stop-jump quantization stalls=${stalledStepCount} jumps=${stopJumpCount} singleStallJumps=${singleStallStopJumps}`,
  ).toBe(false);
}

function assertDecodedMotionEvidence(
  frames: RgbFrames,
  preset: StillCameraMotionPreset,
  frameCount: number,
  axis: "x" | "y",
  channel: number,
  fitMode: "contain" | "cover" | "full_bleed" = "full_bleed",
): void {
  expect(frames.count).toBe(frameCount);
  const plan = resolveStillCameraMotion({ preset, easing: "smoothstep", intensity: 0.3 }, frameCount);
  const trajectory = cameraMotionTrajectory(plan);
  const intended = trajectory.map((state) => fittedBoundaryPosition(
    axis === "x" ? VERTICAL_BOUNDARY : HORIZONTAL_BOUNDARY,
    state,
    axis,
    fitMode,
  ));
  const sampleSourceBoundary = 400;
  const measured = trajectory.map((state, frame) => stepBoundary(
    frames,
    frame,
    axis,
    channel,
    fittedBoundaryPosition(
      sampleSourceBoundary,
      state,
      axis === "x" ? "y" : "x",
      fitMode,
    ),
    intended[frame],
    axis === "x" ? 0 : 80,
    axis === "x" ? 80 : 255,
  ));
  const fitScale = fitScaleFor(fitMode);
  const errors = measured.map((value, index) => Math.abs(value - intended[index]) / fitScale);
  expect(Math.max(...errors)).toBeLessThanOrEqual(POSITION_TOLERANCE_SOURCE_PX);
  expect(Math.abs((measured.at(-1)! - measured[0]) - (intended.at(-1)! - intended[0])) / fitScale)
    .toBeLessThanOrEqual(TOTAL_DISPLACEMENT_TOLERANCE_SOURCE_PX);
  expect(Math.abs(intended.at(-1)! - intended[0]) / fitScale).toBeGreaterThan(8);
  assertNoReverseOrStopJump(measured, intended, fitScale, preset);
}

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function makeAssemblyProject(
  sourcePath: string,
  root: string,
  opts: {
    frames: number;
    fpsNum: number;
    fpsDen: number;
    motion?: Record<string, unknown>;
    fitMode?: "contain" | "cover" | "full_bleed";
    captions?: Array<{ text: string; in_frame: number; out_frame: number; style: "simple-shadow" }>;
    audio?: string;
  },
): Promise<{ projectDir: string; timelinePath: string; sourceAssetId: string; audioAssetId?: string }> {
  const projectDir = fs.mkdtempSync(path.join(root, "project-"));
  const sourceAsset = await ingestAsset(sourcePath, {
    projectRoot: projectDir,
    mediaKind: "image",
    ffmpegVersion: "issue33-test",
  });
  const audioAsset = opts.audio
    ? await ingestAsset(opts.audio, {
        projectRoot: projectDir,
        mediaKind: "audio",
        ffmpegVersion: "issue33-test",
      })
    : undefined;
  const sourceItems = [{
    asset_id: sourceAsset.asset_id,
    source_locator: sourcePath,
    local_source_path: sourcePath,
    link_path: path.basename(sourcePath),
    media_kind: "image",
    source_content_sha256: sourceAsset.source_content_sha256,
  }, ...(audioAsset && opts.audio ? [{
    asset_id: audioAsset.asset_id,
    source_locator: opts.audio,
    local_source_path: opts.audio,
    link_path: path.basename(opts.audio),
    media_kind: "audio",
    source_content_sha256: audioAsset.source_content_sha256,
  }] : [])];
  writeJson(path.join(projectDir, "02_media/source_map.json"), {
    version: "1",
    project_id: "issue33-evidence",
    media_dir: "02_media",
    generated_at: "2026-09-01T00:00:00Z",
    items: sourceItems,
  });
  writeJson(path.join(projectDir, "03_analysis/assets.json"), {
    items: [sourceAsset, ...(audioAsset ? [audioAsset] : [])],
  });
  const stillImage: Record<string, unknown> = {
    hold_frames: opts.frames,
    min_hold_frames: 1,
    max_hold_frames: opts.frames,
    hold_source: "global_default",
    policy_clamp: "none",
    motion_mode: opts.motion ? "camera_motion" : "static",
    fit_mode: opts.fitMode ?? "full_bleed",
    background: "black",
    ...(opts.motion ? { camera_motion: opts.motion } : {}),
  };
  const videoClip: Record<string, unknown> = {
    clip_id: "V_MOTION",
    segment_id: "S_MOTION",
    asset_id: sourceAsset.asset_id,
    media_kind: "image",
    src_in_us: 0,
    src_out_us: 1,
    timeline_in_frame: 0,
    timeline_duration_frames: opts.frames,
    role: "hero",
    motivation: "Issue 33 evidence",
    beat_id: "b01",
    fallback_segment_ids: [],
    confidence: 1,
    quality_flags: [],
    still_image: stillImage,
    ...(opts.captions ? { captions: opts.captions } : {}),
  };
  const audioClips = audioAsset && opts.audio ? [{
    clip_id: "A_DIALOGUE",
    segment_id: "SA_DIALOGUE",
    asset_id: audioAsset.asset_id,
    media_kind: "audio",
    src_in_us: 0,
    src_out_us: Math.round((opts.frames / (opts.fpsNum / opts.fpsDen)) * 1_000_000),
    timeline_in_frame: 0,
    timeline_duration_frames: opts.frames,
    role: "dialogue",
    motivation: "Issue 33 synchronization evidence",
    beat_id: "b01",
    fallback_segment_ids: [],
    confidence: 1,
    quality_flags: [],
  }] : [];
  const timelinePath = path.join(projectDir, "05_timeline/timeline.json");
  writeJson(timelinePath, {
    version: "1",
    project_id: "issue33-evidence",
    created_at: "2026-09-01T00:00:00Z",
    sequence: {
      name: "Issue 33 evidence",
      fps_num: opts.fpsNum,
      fps_den: opts.fpsDen,
      width: OUTPUT_WIDTH,
      height: OUTPUT_HEIGHT,
      start_frame: 0,
      letterbox_policy: "none",
    },
    tracks: {
      video: [{ track_id: "V1", kind: "video", clips: [videoClip] }],
      audio: [{ track_id: "A1", kind: "audio", clips: audioClips }],
    },
    markers: [],
    transitions: [],
    provenance: {
      brief_path: "",
      blueprint_path: "",
      selects_path: "",
      compiler_version: "issue33-evidence",
    },
  });
  return {
    projectDir,
    timelinePath,
    sourceAssetId: sourceAsset.asset_id,
    ...(audioAsset ? { audioAssetId: audioAsset.asset_id } : {}),
  };
}

function sha256(filePath: string): string {
  return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function makeContentPlan(): ContentRenderPlan {
  return {
    width: OUTPUT_WIDTH,
    height: OUTPUT_HEIGHT,
    fps: 24,
    fps_num: 24,
    fps_den: 1,
    duration_frames: 2,
    remotion_clip_ids: [],
    remotion_base_required_clip_ids: [],
    remotion_elements: [],
    hyperframes_elements: [],
    visual_elements: [],
    issues: [],
  };
}

describe("Issue 33 decoded and contract evidence", () => {
  it("rejects adversarial 1-source-pixel reverse and 2-source-pixel stop-jump controls", () => {
    const fitScale = fitScaleFor("full_bleed");
    const toOutput = (sourcePositions: number[]) => sourcePositions.map((position) => position * fitScale);

    // Every reverse step is below the 0.5-source-pixel per-frame noise gate,
    // but the accumulated excursion is one source pixel. The cumulative gate
    // must reject it instead of allowing per-frame tolerance to hide it.
    const intendedReverse = toOutput([100, 99, 98, 97, 96, 95, 94, 93, 92, 91, 90]);
    const onePixelReverse = toOutput([100, 100.25, 100.5, 100.75, 101, 100, 99, 98, 97, 96, 95]);
    expect(() => assertNoReverseOrStopJump(
      onePixelReverse,
      intendedReverse,
      fitScale,
      "adversarial-1-source-pixel-reverse",
    )).toThrow(/cumulative reverse/);

    // Two quantized frames followed by a literal two-source-pixel jump is the
    // periodic stop/jump failure mode; it must fail the normalized jump gate.
    const intendedJump = toOutput([0, 1, 2, 3, 4, 5]);
    const twoPixelJump = toOutput([0, 0, 0, 2, 3, 4]);
    expect(() => assertNoReverseOrStopJump(
      twoPixelJump,
      intendedJump,
      fitScale,
      "adversarial-2-source-pixel-stop-jump",
    )).toThrow(/stop-jump/);
  });

  it("rejects one-stall periodic and integer-source-pixel-rounded trajectories", () => {
    const fitScale = fitScaleFor("full_bleed");
    const toOutput = (sourcePositions: number[]) => sourcePositions.map((position) => position * fitScale);

    const alternatingHoldJump = toOutput([100, 100, 98, 98, 96, 96, 94, 94, 92, 92, 90]);
    const alternatingIntended = toOutput([100, 99, 98, 97, 96, 95, 94, 93, 92, 91, 90]);
    expect(() => assertNoReverseOrStopJump(
      alternatingHoldJump,
      alternatingIntended,
      fitScale,
      "adversarial-alternating-hold-jump",
    )).toThrow(/periodic single-stall stop-jump/);

    for (const entry of [
      { preset: "horizontal_tracking" as const, frameCount: 300, axis: "x" as const, boundary: VERTICAL_BOUNDARY },
      { preset: "tilt_down" as const, frameCount: 434, axis: "y" as const, boundary: HORIZONTAL_BOUNDARY },
    ]) {
      const plan = resolveStillCameraMotion({
        preset: entry.preset,
        easing: "smoothstep",
        intensity: 0.3,
      }, entry.frameCount);
      const intended = cameraMotionTrajectory(plan).map((state) => fittedBoundaryPosition(
        entry.boundary,
        state,
        entry.axis,
        "full_bleed",
      ));
      // Model the old integer-source-pixel crop path: round the source-space
      // boundary before mapping it back to the decoded output coordinate.
      const measured = intended.map((position) => Math.round(position / fitScale) * fitScale);
      const measuredSource = measured.map((position) => position / fitScale);
      const steps = measuredSource.slice(1).map((position, index) => position - measuredSource[index]);
      expect(steps.filter((step) => Math.abs(step) <= STALLED_STEP_SOURCE_PX).length)
        .toBeGreaterThanOrEqual(PERIODIC_STOP_JUMP_MIN_STALLS);
      expect(steps.filter((step) => Math.abs(step) >= STOP_JUMP_SOURCE_PX).length)
        .toBeGreaterThanOrEqual(PERIODIC_STOP_JUMP_MIN_JUMPS);
      expect(() => assertNoReverseOrStopJump(
        measured,
        intended,
        fitScale,
        `adversarial-integer-rounded-${entry.preset}-${entry.frameCount}f`,
      )).toThrow(/periodic rounded stop-jump quantization/);
    }
  });

  it("renders the 941x1672 fixture at exact 300/434 frames for every required motion", async (ctx) => {
    const capability = await probeStillCameraCapability();
    if (!capability.ok) {
      ctx.skip(true, `still camera worker unavailable: ${capability.error}`);
      return;
    }
    const root = makeTempDir("vos-issue33-evidence-");
    const sourcePath = makeIssue33Source(root);
    const cases: Array<{
      preset: StillCameraMotionPreset;
      frames: 300 | 434;
      axis: "x" | "y";
      channel: number;
    }> = [
      { preset: "push_in", frames: 300, axis: "x", channel: 0 },
      { preset: "pull_out", frames: 300, axis: "x", channel: 0 },
      { preset: "horizontal_tracking", frames: 300, axis: "x", channel: 0 },
      { preset: "tilt_down", frames: 434, axis: "y", channel: 1 },
      { preset: "diagonal_drift", frames: 434, axis: "x", channel: 0 },
      { preset: "pan_zoom", frames: 434, axis: "x", channel: 0 },
    ];
    for (const entry of cases) {
      const outputPath = path.join(root, `${entry.preset}-${entry.frames}.mp4`);
      const motion = resolveStillCameraMotion({
        preset: entry.preset,
        easing: "smoothstep",
        intensity: 0.3,
      }, entry.frames);
      const receipt = await renderStillMotionSegment({
        inputPath: sourcePath,
        outputPath,
        frameCount: entry.frames,
        width: OUTPUT_WIDTH,
        height: OUTPUT_HEIGHT,
        fpsRational: "24/1",
        motion,
        fitMode: "full_bleed",
        background: "black",
      });
      expect(receipt).toMatchObject({
        backend: "numpy_float64_lanczos_worker",
        interpolation: "lanczos4",
        precision: "float64",
        source_dimensions: { width: SOURCE_WIDTH, height: SOURCE_HEIGHT },
        output_dimensions: { width: OUTPUT_WIDTH, height: OUTPUT_HEIGHT },
        fps: { num: 24, den: 1 },
        duration_frames: entry.frames,
      });
      const media = probeMedia(outputPath);
      expect(media.streams.find((stream) => stream.codec_type === "video")).toMatchObject({
        width: OUTPUT_WIDTH,
        height: OUTPUT_HEIGHT,
        r_frame_rate: "24/1",
        nb_read_frames: String(entry.frames),
      });
      const decoded = decodeRgb(outputPath);
      assertDecodedMotionEvidence(decoded, entry.preset, entry.frames, entry.axis, entry.channel);
      if (entry.preset === "diagonal_drift") {
        assertDecodedMotionEvidence(decoded, entry.preset, entry.frames, "y", 1);
      }
      if (entry.preset === "pan_zoom") {
        expect(motion.preset).toBe("pan_zoom");
        expect(motion.frame_count).toBe(entry.frames);
        expect(cameraMotionTrajectory(motion).some((state) => state.zoom > 1 && state.centerX !== 0.5)).toBe(true);
      }
      if (entry.preset === "push_in") {
        const first = cameraMotionTrajectory(motion)[0];
        const verticalLineX = fittedBoundaryPosition(
          THIN_VERTICAL_LINE,
          first,
          "x",
          "full_bleed",
        );
        const verticalLineY = fittedBoundaryPosition(
          100,
          first,
          "y",
          "full_bleed",
        );
        const horizontalLineX = fittedBoundaryPosition(
          400,
          first,
          "x",
          "full_bleed",
        );
        const horizontalLineY = fittedBoundaryPosition(
          THIN_HORIZONTAL_LINE,
          first,
          "y",
          "full_bleed",
        );
        expect(maxChannelNear(decoded, 0, Math.round(verticalLineX), Math.round(verticalLineY), 2)).toBeGreaterThan(120);
        expect(maxChannelNear(decoded, 0, Math.round(horizontalLineX), Math.round(horizontalLineY), 2)).toBeGreaterThan(120);
      }
    }
  }, 300_000);

  it("executes production 1080x1920 worker transforms for exact 300/434 frames at 24fps", async (ctx) => {
    const capability = await probeStillCameraCapability();
    if (!capability.ok) {
      ctx.skip(true, `still camera worker unavailable: ${capability.error}`);
      return;
    }
    const root = makeTempDir("vos-issue33-production-");
    const sourcePath = makeIssue33Source(root);
    const cases: Array<{ preset: StillCameraMotionPreset; frames: 300 | 434 }> = [
      { preset: "push_in", frames: 300 },
      { preset: "pan_zoom", frames: 434 },
    ];
    for (const entry of cases) {
      const requestPath = path.join(root, `${entry.preset}-${entry.frames}.request.json`);
      const request = {
        input: sourcePath,
        window: { width: PRODUCTION_WIDTH, height: PRODUCTION_HEIGHT },
        fps: PRODUCTION_FPS,
        fit_mode: "full_bleed",
        background: "black",
        frame_count: entry.frames,
        policy: "still-camera-motion/v1",
        trajectory: cameraMotionTrajectory(resolveStillCameraMotion({
          preset: entry.preset,
          easing: "smoothstep",
          intensity: 0.3,
        }, entry.frames)),
      };
      writeJson(requestPath, request);
      const stdout = execFileSync(capability.pythonBinary!, [
        capability.workerPath!, "warp", "--request", requestPath, "--output", "/dev/null",
      ], { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 });
      const result = JSON.parse(stdout.split(/\r?\n/).find((line) => line.trim().startsWith("{"))!);
      expect(result).toMatchObject({
        ok: true,
        frames: entry.frames,
        width: PRODUCTION_WIDTH,
        height: PRODUCTION_HEIGHT,
        source_width: SOURCE_WIDTH,
        source_height: SOURCE_HEIGHT,
        fps: PRODUCTION_FPS,
        interpolation: "lanczos4",
        precision: "float64",
      });
    }
  }, 300_000);

  it("supports contain, cover, and full_bleed for the arbitrary portrait-to-landscape transform", async (ctx) => {
    const capability = await probeStillCameraCapability();
    if (!capability.ok) {
      ctx.skip(true, `still camera worker unavailable: ${capability.error}`);
      return;
    }
    const root = makeTempDir("vos-issue33-fit-");
    const sourcePath = makeIssue33Source(root);
    const outputs = new Map<string, Buffer>();
    for (const fitMode of ["contain", "cover", "full_bleed"] as const) {
      const outputPath = path.join(root, `${fitMode}.mp4`);
      await renderStillMotionSegment({
        inputPath: sourcePath,
        outputPath,
        frameCount: 3,
        width: 320,
        height: 180,
        fpsRational: "24/1",
        motion: resolveStillCameraMotion({ preset: "push_in", easing: "linear", intensity: 0.2 }, 3),
        fitMode,
        background: "black",
      });
      const decoded = decodeRgb(outputPath);
      expect(decoded.count).toBe(3);
      outputs.set(fitMode, decoded.data);
      if (fitMode === "contain") {
        expect(Math.max(rgbAt(decoded, 0, 0, 0, 0), rgbAt(decoded, 0, 0, 0, 1), rgbAt(decoded, 0, 0, 0, 2))).toBeLessThan(20);
      } else {
        // The portrait source fills the wide canvas under cover/full_bleed;
        // the top-left sample lands on the green high-contrast field.
        expect(rgbAt(decoded, 0, 0, 0, 1)).toBeGreaterThan(100);
      }
    }
    expect(outputs.get("cover")!.equals(outputs.get("full_bleed")!)).toBe(true);
  }, 120_000);

  it("preserves rational-fps PTS and frame count through the encoded motion segment", async (ctx) => {
    const capability = await probeStillCameraCapability();
    if (!capability.ok) {
      ctx.skip(true, `still camera worker unavailable: ${capability.error}`);
      return;
    }
    const root = makeTempDir("vos-issue33-pts-");
    const sourcePath = makeIssue33Source(root);
    const outputPath = path.join(root, "rational.mp4");
    const frameCount = 37;
    await renderStillMotionSegment({
      inputPath: sourcePath,
      outputPath,
      frameCount,
      width: OUTPUT_WIDTH,
      height: OUTPUT_HEIGHT,
      fpsRational: "30000/1001",
      motion: resolveStillCameraMotion({ preset: "diagonal_drift", easing: "linear", intensity: 0.2 }, frameCount),
      fitMode: "full_bleed",
      background: "black",
    });
    const media = probeMedia(outputPath);
    const video = media.streams.find((stream) => stream.codec_type === "video")!;
    expect(video).toMatchObject({
      width: OUTPUT_WIDTH,
      height: OUTPUT_HEIGHT,
      r_frame_rate: "30000/1001",
      nb_read_frames: String(frameCount),
    });
    const frames = ffprobeJson([
      "-select_streams", "v:0", "-show_frames",
      "-show_entries", "frame=best_effort_timestamp_time",
      "-of", "json", outputPath,
    ]).frames as Array<{ best_effort_timestamp_time: string }>;
    const pts = frames.map((frame) => Number(frame.best_effort_timestamp_time));
    const step = 1001 / 30000;
    expect(pts).toHaveLength(frameCount);
    expect(pts[0]).toBeCloseTo(0, 7);
    for (let i = 1; i < pts.length; i++) expect(pts[i] - pts[i - 1]).toBeCloseTo(step, 5);
    expect(pts.at(-1)).toBeCloseTo((frameCount - 1) * step, 5);
  }, 120_000);

  it("keeps motion frame, audio, caption, and static boundaries on the existing assembler paths", async (ctx) => {
    const capability = await probeStillCameraCapability();
    if (!capability.ok) {
      ctx.skip(true, `still camera worker unavailable: ${capability.error}`);
      return;
    }
    const root = makeTempDir("vos-issue33-sync-");
    const sourcePath = makeIssue33Source(root);
    const audioPath = path.join(root, "dialogue.wav");
    ffmpeg([
      "-f", "lavfi", "-i", "sine=frequency=880:duration=2",
      "-ar", "48000", "-ac", "2", "-y", audioPath,
    ]);
    const fixture = await makeAssemblyProject(sourcePath, root, {
      frames: 48,
      fpsNum: 24,
      fpsDen: 1,
      motion: { preset: "pan_zoom", easing: "smoothstep", intensity: 0.25 },
      fitMode: "full_bleed",
      captions: [{ text: "SYNC", in_frame: 12, out_frame: 24, style: "simple-shadow" }],
      audio: audioPath,
    });
    const captionedPath = path.join(fixture.projectDir, "captioned.mp4");
    const shiftedCaptionPath = path.join(fixture.projectDir, "shifted-caption.mp4");
    const captioned = await assembleTimelineToMp4({
      projectDir: fixture.projectDir,
      timelinePath: fixture.timelinePath,
      outputPath: captionedPath,
      legacyCaptionMode: "preview_burn",
    });
    const shiftedTimelinePath = path.join(fixture.projectDir, "shifted-timeline.json");
    const shiftedTimeline = JSON.parse(fs.readFileSync(fixture.timelinePath, "utf8"));
    shiftedTimeline.tracks.video[0].clips[0].captions = [
      { text: "SYNC", in_frame: 30, out_frame: 42, style: "simple-shadow" },
    ];
    writeJson(shiftedTimelinePath, shiftedTimeline);
    await assembleTimelineToMp4({
      projectDir: fixture.projectDir,
      timelinePath: shiftedTimelinePath,
      outputPath: shiftedCaptionPath,
      legacyCaptionMode: "preview_burn",
    });
    expect(captioned.still_camera_motion).toHaveLength(1);
    expect(captioned.still_camera_motion![0]).toMatchObject({
      source_dimensions: { width: SOURCE_WIDTH, height: SOURCE_HEIGHT },
      output_dimensions: { width: OUTPUT_WIDTH, height: OUTPUT_HEIGHT },
      fps: { num: 24, den: 1 },
      duration_frames: 48,
    });
    const captionedMedia = probeMedia(captionedPath);
    const video = captionedMedia.streams.find((stream) => stream.codec_type === "video")!;
    const audio = captionedMedia.streams.find((stream) => stream.codec_type === "audio")!;
    expect(video).toMatchObject({ r_frame_rate: "24/1", nb_read_frames: "48" });
    expect(Number(video.start_time ?? 0)).toBeCloseTo(0, 5);
    expect(Number(audio.start_time ?? 0)).toBeCloseTo(0, 2);
    expect(Number(audio.duration)).toBeCloseTo(2, 1);

    const withCaption = decodeRgb(captionedPath);
    const withoutCaption = decodeRgb(shiftedCaptionPath);
    const frameBytes = OUTPUT_WIDTH * OUTPUT_HEIGHT * 3;
    const differences = Array.from({ length: 48 }, (_, frame) => {
      let changed = 0;
      for (let i = 0; i < frameBytes; i++) {
        if (withCaption.data[frame * frameBytes + i] !== withoutCaption.data[frame * frameBytes + i]) changed++;
      }
      return changed;
    });
    const outsideCaptionNoise = Math.max(
      ...differences.filter((_difference, frame) => frame < 12 || (frame > 24 && frame < 30) || frame > 42),
    );
    const captionBoundarySignal = Math.min(
      differences[12], differences[24], differences[30], differences[42],
    );
    // Independent encodes have a small codec residual even when no caption is
    // present. The caption boundary must still dominate that measured noise.
    expect(differences[11]).toBeLessThanOrEqual(outsideCaptionNoise);
    expect(differences[25]).toBeLessThanOrEqual(outsideCaptionNoise);
    expect(differences[29]).toBeLessThanOrEqual(outsideCaptionNoise);
    expect(differences[43]).toBeLessThanOrEqual(outsideCaptionNoise);
    expect(captionBoundarySignal).toBeGreaterThan(outsideCaptionNoise * 4);

    const staticFixture = await makeAssemblyProject(sourcePath, root, {
      frames: 24,
      fpsNum: 24,
      fpsDen: 1,
      fitMode: "full_bleed",
    });
    const staticPath = path.join(staticFixture.projectDir, "static.mp4");
    const staticResult = await assembleTimelineToMp4({
      projectDir: staticFixture.projectDir,
      timelinePath: staticFixture.timelinePath,
      outputPath: staticPath,
    });
    expect(staticResult.still_camera_motion).toBeUndefined();
    const staticFrames = decodeRgb(staticPath);
    const staticFrameSize = staticFrames.width * staticFrames.height * 3;
    const firstFrame = staticFrames.data.subarray(0, staticFrameSize);
    for (let frame = 1; frame < staticFrames.count; frame++) {
      expect(staticFrames.data.subarray(frame * staticFrameSize, (frame + 1) * staticFrameSize).equals(firstFrame)).toBe(true);
    }
  }, 240_000);

  it("persists measured motion receipts and rejects malformed receipt consumers", async (ctx) => {
    const capability = await probeStillCameraCapability();
    if (!capability.ok) {
      ctx.skip(true, `still camera worker unavailable: ${capability.error}`);
      return;
    }
    const root = makeTempDir("vos-issue33-receipt-");
    const sourcePath = makeIssue33Source(root);
    const finalVideoPath = path.join(root, "final.mp4");
    const receipt = await renderStillMotionSegment({
      inputPath: sourcePath,
      outputPath: finalVideoPath,
      frameCount: 2,
      width: OUTPUT_WIDTH,
      height: OUTPUT_HEIGHT,
      fpsRational: "24/1",
      motion: resolveStillCameraMotion({ preset: "pan_zoom", easing: "linear", intensity: 0.2 }, 2),
      fitMode: "full_bleed",
      background: "black",
    });
    const timelinePath = path.join(root, "timeline.json");
    writeJson(timelinePath, { version: "issue33-evidence", project_id: "issue33-receipt" });
    const outputDir = path.join(root, "output");
    const routePath = writeRenderRouteReceipt(outputDir, resolveRenderRoute({
      requestedEngine: "ffmpeg",
      contentPlan: makeContentPlan(),
      captionsEnabled: false,
    }), {
      baseAssemblyPath: finalVideoPath,
      effectiveAssemblyPath: finalVideoPath,
      timelinePath,
      finalVideoPath,
      operations: [{ id: "base_assembly", kind: "lossy_video_generation", codec: "h264" }],
      stillCameraMotion: [receipt],
    });
    const route = JSON.parse(fs.readFileSync(routePath, "utf8")) as Record<string, any>;
    expect(route.still_camera_motion).toEqual([receipt]);
    expect(validateAgainstSchema(route, "render-route-receipt.schema.json").valid).toBe(true);
    const invalidRoute = structuredClone(route);
    invalidRoute.still_camera_motion[0].backend = "integer_ffmpeg_crop";
    expect(validateAgainstSchema(invalidRoute, "render-route-receipt.schema.json").valid).toBe(false);

    const fileRef = (filePath: string) => ({
      path: path.resolve(filePath),
      sha256: `sha256:${sha256(filePath)}`,
    });
    const report = {
      version: "render-report/v1",
      project_id: "issue33-receipt",
      created_at: "2026-09-01T00:00:00.000Z",
      route_receipt: fileRef(routePath),
      renderer_versions: route.renderer_versions,
      inputs: { timeline: fileRef(timelinePath) },
      geometry: {
        width: OUTPUT_WIDTH,
        height: OUTPUT_HEIGHT,
        fps_num: 24,
        fps_den: 1,
        duration_frames: 2,
      },
      caption_timing_hash: null,
      caption_visual_treatment: null,
      output: { final_video: fileRef(finalVideoPath) },
      delivery: {
        compositor: "ffmpeg",
        video_encoder: "ffmpeg",
        lossy_video_encode_passes: 1,
        caption_engine: "none",
        one_final_composite: true,
      },
      still_camera_motion: [receipt],
    };
    expect(validateAgainstSchema(report, "render-report.schema.json").valid).toBe(true);
    const invalidReport = structuredClone(report);
    invalidReport.still_camera_motion[0].fps.den = 0;
    expect(validateAgainstSchema(invalidReport, "render-report.schema.json").valid).toBe(false);
  }, 120_000);
});

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
