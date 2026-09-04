import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { stringify as stringifyYaml } from "yaml";
import { ingestAsset } from "../runtime/connectors/ffprobe.js";
import {
  probeStillCameraCapability,
  renderStillCameraWarp,
  StillCameraCapabilityError,
  type StillCameraCapability,
} from "../runtime/connectors/still-camera-local.js";
import { assembleTimelineToMp4 } from "../runtime/render/assembler.js";
import {
  cleanupRegisteredRenderPathsSync,
  registeredRenderCleanupCount,
  unregisterRenderCleanupPath,
} from "../runtime/render/render-cleanup-registry.js";
import {
  renderStillMotionSegment,
  type ExecFileLike,
} from "../runtime/render/still-motion-render.js";
import { approveFinalRenderChecklist } from "../runtime/packaging/final-render-approval.js";
import {
  computeFileHash,
  writeProjectState,
  type ProjectStateDoc,
} from "../runtime/state/reconcile.js";
import { bundleFixture } from "./helpers/fixture-bundle.js";
import {
  expectNoSurvivors,
  fixtureProcessRows,
  OwnedRenderChild,
  rowsWithPgid,
  TeardownScope,
} from "./helpers/owned-render-child.js";
import { renderPreviewSegment } from "../runtime/preview/segment-renderer.js";
import { loadSourceMap } from "../runtime/media/source-map.js";
import {
  produceAssembly,
  timelineHasCameraMotionStill,
} from "../runtime/render/assembly-orchestrator.js";
import {
  cameraMotionTrajectory,
  cameraWindowState,
  resolveStillCameraMotion,
  type StillCameraMotionPlan,
} from "../runtime/render/camera-motion.js";

// ── Evidence bounds ─────────────────────────────────────────────────
/**
 * Plan accuracy bound: Lanczos4 phase bias + 8-bit measurement noise on a
 * rendered step edge. Deliberately far below the 1px output grid that defines
 * pixel-jump jitter and below the rejected 0.25px oversampled-zoompan
 * quantization (which this suite would catch as grid-locked residuals).
 */
const PLAN_TOLERANCE_PX = 0.2;
/** Total-displacement bound for duration-synchronized easing evidence. */
const TOTAL_DISP_TOLERANCE_PX = 0.1;
/**
 * A frame pair whose planned step is at or above this bound must render as a
 * distinct frame; pairs below it may legitimately round to identical 8-bit
 * frames. Integer-pixel panning would duplicate above-floor frames and then
 * jump a whole grid cell — impossible to pass with true float64 rendering
 * unless every above-floor step actually moves pixels.
 */
const DUPLICATE_STEP_FLOOR_PX = 0.05;

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

// ── Capability gate (honest, not silent) ────────────────────────────
let capability: StillCameraCapability | null = null;
beforeAll(async () => {
  capability = await probeStillCameraCapability();
});
afterAll(() => {
  if (capability && !capability.ok) {
    // Visible acceptance note: rendered subpixel evidence requires cv2.
    console.warn(
      `[still-camera-motion] RENDERED EVIDENCE NOT CLAIMED: cv2 unavailable (${capability.error}).`
      + " Provision python/requirements-still-camera.txt to enable the warp suite.",
    );
  }
});

function warpIt(name: string, fn: () => Promise<void>, timeout: number) {
  return it(name, async (ctx) => {
    if (!capability?.ok) {
      ctx.skip(true, `cv2 unavailable: ${capability?.error ?? "not probed"}`);
      return;
    }
    await fn();
  }, timeout);
}

function ffmpeg(args: string[]): Buffer {
  return execFileSync("ffmpeg", ["-v", "error", ...args], { maxBuffer: 300 * 1024 * 1024 });
}

function ffmpegAvailable(): boolean {
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
const ffit = ffmpegAvailable() ? it : it.skip;

async function makeStillProject(stillArgs: string[], root?: string): Promise<{ projectDir: string; sourcePath: string; assetId: string }> {
  // Per-test private root: the project fixture lives INSIDE a test-owned
  // root (an explicit caller root or a fresh owned root here), never
  // directly in the global temp area.
  const ownedRoot = root ?? fs.mkdtempSync(path.join(os.tmpdir(), "vos-still-e2e-root-"));
  if (root === undefined) dirs.push(ownedRoot);
  const projectDir = fs.mkdtempSync(path.join(ownedRoot, "vos-still-motion-e2e-"));
  dirs.push(projectDir);
  const sourcePath = path.join(projectDir, "source.png");
  ffmpeg(["-f", "lavfi", "-i", ...stillArgs, "-frames:v", "1", "-y", sourcePath]);
  const asset = await ingestAsset(sourcePath, { projectRoot: projectDir, mediaKind: "image", ffmpegVersion: "test" });
  fs.mkdirSync(path.join(projectDir, "02_media"), { recursive: true });
  fs.writeFileSync(path.join(projectDir, "02_media/source_map.json"), JSON.stringify({
    version: "1", project_id: "still-motion-e2e", media_dir: "02_media", generated_at: "2026-08-29T00:00:00Z",
    items: [{
      asset_id: asset.asset_id, source_locator: sourcePath, local_source_path: sourcePath,
      link_path: path.basename(sourcePath), media_kind: "image", source_content_sha256: asset.source_content_sha256,
    }],
  }));
  fs.mkdirSync(path.join(projectDir, "03_analysis"), { recursive: true });
  fs.writeFileSync(path.join(projectDir, "03_analysis/assets.json"), JSON.stringify({ items: [asset] }));
  fs.mkdirSync(path.join(projectDir, "05_timeline"), { recursive: true });
  return { projectDir, sourcePath, assetId: asset.asset_id };
}

/** Sharp vertical black→white edge at u=0.25 (x = size/4). */
const VERTICAL_EDGE_STILL = (size: number) => [
  `color=black:s=${size}x${size}`,
  "-vf", `drawbox=x=${size / 4}:y=0:w=${size - size / 4}:h=${size}:color=white:t=fill`,
];

/** Sharp horizontal black→white edge at v=0.25 (y = size/4). */
const HORIZONTAL_EDGE_STILL = (size: number) => [
  `color=black:s=${size}x${size}`,
  "-vf", `drawbox=x=0:y=${size / 4}:w=${size}:h=${size - size / 4}:color=white:t=fill`,
];

function makeTimeline(
  assetId: string,
  opts: {
    width: number;
    height: number;
    frames: number;
    fpsNum: number;
    fpsDen: number;
    cameraMotion?: Record<string, unknown>;
    motionMode?: "static" | "camera_motion";
    composition?: "fit" | "vertical_blur_backdrop";
  },
) {
  const stillImage: Record<string, unknown> = {
    hold_frames: opts.frames, min_hold_frames: 1, max_hold_frames: opts.frames,
    hold_source: "global_default", policy_clamp: "none",
    motion_mode: opts.motionMode ?? (opts.cameraMotion ? "camera_motion" : "static"),
    fit_mode: "cover", background: "black",
  };
  if (opts.cameraMotion) stillImage.camera_motion = opts.cameraMotion;
  if (opts.composition) stillImage.composition = opts.composition;
  return {
    version: "1", project_id: "still-motion-e2e", created_at: "2026-08-29T00:00:00Z",
    sequence: { name: "still-motion", fps_num: opts.fpsNum, fps_den: opts.fpsDen, width: opts.width, height: opts.height, start_frame: 0, letterbox_policy: "none" },
    tracks: { video: [{ track_id: "V1", kind: "video", clips: [{
      clip_id: "CLP_MOTION", segment_id: "SEG_MOTION", asset_id: assetId,
      media_kind: "image", src_in_us: 0, src_out_us: 1, timeline_in_frame: 0,
      timeline_duration_frames: opts.frames, role: "hero", motivation: "still", beat_id: "b01",
      fallback_segment_ids: [], confidence: 1, quality_flags: [],
      still_image: stillImage,
    }] }], audio: [] }, markers: [],
    provenance: { brief_path: "", blueprint_path: "", selects_path: "", compiler_version: "test" },
  };
}

function writePublicRenderGateArtifacts(projectDir: string, timelinePath: string): void {
  const writeYaml = (relativePath: string, value: unknown): void => {
    const target = path.join(projectDir, relativePath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, stringifyYaml(value), "utf8");
  };
  const writeJson = (relativePath: string, value: unknown): void => {
    const target = path.join(projectDir, relativePath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  };

  writeYaml("01_intent/creative_brief.yaml", {
    version: "1",
    project_id: "still-motion-e2e",
    project: { id: "still-motion-e2e", title: "Public render signal", runtime_target_sec: 8 },
    autonomy: { mode: "full", may_decide: ["render"], must_ask: [] },
  });
  writeYaml("01_intent/unresolved_blockers.yaml", {
    version: "1", project_id: "still-motion-e2e", blockers: [],
  });
  writeYaml("04_plan/selects_candidates.yaml", {
    version: "1", project_id: "still-motion-e2e", candidates: [],
  });
  writeYaml("04_plan/edit_blueprint.yaml", {
    version: "1",
    project_id: "still-motion-e2e",
    caption_policy: {
      language: "en", delivery_mode: "burn_in", source: "none", styling_class: "clean-lower-third",
    },
  });
  writeYaml("04_plan/uncertainty_register.yaml", {
    version: "1", project_id: "still-motion-e2e", uncertainties: [],
  });
  writeJson("06_review/review_patch.json", {
    version: "1", project_id: "still-motion-e2e", operations: [],
  });
  const reviewReportPath = path.join(projectDir, "06_review/review_report.yaml");
  writeYaml("06_review/review_report.yaml", {
    version: "1",
    project_id: "still-motion-e2e",
    fatal_issues: [],
    visual_qa: {
      status: "verified", score: 90, min_score: 70,
      issues: { total: 0, critical: 0, warning: 0, info: 0 }, issue_summaries: [],
      deterministic_scan: { status: "verified", duration_sec: 8, width: 1080, height: 1920, issues: [] },
    },
  });

  const timelineHash = computeFileHash(timelinePath);
  const reviewReportHash = computeFileHash(reviewReportPath);
  const reviewPatchHash = computeFileHash(path.join(projectDir, "06_review/review_patch.json"));
  const state: ProjectStateDoc = {
    version: 1,
    project_id: "still-motion-e2e",
    current_state: "approved",
    gates: {
      analysis_gate: "ready", compile_gate: "open", planning_gate: "open",
      timeline_gate: "open", review_gate: "open", packaging_gate: "open",
    },
    approval_record: {
      status: "clean", approved_by: "test", approved_at: "2026-08-31T00:00:00Z",
      artifact_versions: {
        timeline_version: timelineHash,
        editorial_timeline_hash: timelineHash,
        review_report_version: reviewReportHash,
        review_patch_hash: reviewPatchHash,
      },
    },
    handoff_resolution: {
      handoff_id: "HND_PUBLIC_SIGNAL", status: "decided", source_of_truth_decision: "engine_render",
      decided_by: "test", decided_at: "2026-08-31T00:00:00Z",
    },
  };
  writeProjectState(projectDir, state);
  approveFinalRenderChecklist(projectDir, {
    approvedBy: "test",
    approvedAt: "2026-08-31T00:00:00Z",
    checklist: {
      captions: "not_applicable",
      caption_typography: "not_applicable",
      section_titles: "not_applicable",
      audio: { decision: "preserve", preview_reviewed: false, bgm: "none" },
      output_spec: "approved",
    },
  });
}

interface GrayFrames { data: Buffer; width: number; height: number; count: number }

function probeStreams(output: string): Record<string, unknown> {
  return JSON.parse(execFileSync("ffprobe", [
    "-v", "error", "-count_frames", "-show_entries", "stream=width,height,nb_read_frames,r_frame_rate",
    "-of", "json", output,
  ], { encoding: "utf8" })).streams[0];
}

function decodeGray(output: string): GrayFrames {
  const stream = probeStreams(output);
  const width = Number(stream.width);
  const height = Number(stream.height);
  const count = Number(stream.nb_read_frames);
  const data = ffmpeg(["-i", output, "-map", "0:v", "-f", "rawvideo", "-pix_fmt", "gray", "-"]);
  if (data.length !== width * height * count) {
    throw new Error(`decoded size mismatch: ${data.length} != ${width * height * count}`);
  }
  return { data, width, height, count };
}

/** Subpixel 50% crossing of a vertical black→white edge, measured on one row. */
function verticalEdgeX(frame: GrayFrames, frameIndex: number, y: number, nearX: number): number {
  const base = frameIndex * frame.width * frame.height + y * frame.width;
  const at = (x: number) => frame.data[base + x];
  const searchFrom = Math.max(1, Math.round(nearX) - Math.round(frame.width / 4));
  for (let x = searchFrom; x < frame.width - 1; x++) {
    if (at(x - 1) < 125.5 && at(x) >= 125.5) {
      return x - 1 + (125.5 - at(x - 1)) / (at(x) - at(x - 1));
    }
  }
  throw new Error(`vertical edge not found near ${nearX}`);
}

/** Subpixel 50% crossing of a horizontal black→white edge, measured on one column. */
function horizontalEdgeY(frame: GrayFrames, frameIndex: number, x: number, nearY: number): number {
  const stride = frame.width * frame.height;
  const at = (y: number) => frame.data[frameIndex * stride + y * frame.width + x];
  const searchFrom = Math.max(1, Math.round(nearY) - Math.round(frame.height / 4));
  for (let y = searchFrom; y < frame.height - 1; y++) {
    if (at(y - 1) < 125.5 && at(y) >= 125.5) {
      return y - 1 + (125.5 - at(y - 1)) / (at(y) - at(y - 1));
    }
  }
  throw new Error(`horizontal edge not found near ${nearY}`);
}

function frameHashes(frame: GrayFrames): string[] {
  const size = frame.width * frame.height;
  const hashes: string[] = [];
  for (let i = 0; i < frame.count; i++) {
    hashes.push(createHash("sha256").update(frame.data.subarray(i * size, (i + 1) * size)).digest("hex"));
  }
  return hashes;
}

/** Screen-space position of base-view point u under one planned camera state.
 * The 50%-crossing of a sharp edge lives exactly halfway between adjacent
 * pixel centers, hence the −0.5 correction against the planner's center-space
 * contract (verified: at zoom 1, c=0.5 the fixture edge measures u·S − 0.5). */
function screenPos(u: number, state: { zoom: number; centerX: number; centerY: number }, size: number, axis: "x" | "y"): number {
  const c = axis === "x" ? state.centerX : state.centerY;
  return (u - c) * state.zoom * size + size / 2 - 0.5;
}

/** Planned inter-frame steps of the tracked edge, in output px. */
function plannedEdgeSteps(
  plan: StillCameraMotionPlan,
  u: number,
  size: number,
  axis: "x" | "y",
): number[] {
  const trajectory = cameraMotionTrajectory(plan);
  const positions = trajectory.map((state) => screenPos(u, state, size, axis));
  return positions.slice(1).map((p, i) => Math.abs(p - positions[i]));
}

/**
 * Jitter evidence: no stair-step. A frame pair whose planned step exceeds the
 * 8-bit measurement floor must render as a distinct frame; an integer-pixel
 * (or coarse-grid-quantized) renderer would duplicate above-floor frames and
 * then jump a whole grid cell.
 */
function assertNoStairStepJitter(decoded: GrayFrames, steps: number[]): void {
  const hashes = frameHashes(decoded);
  expect(hashes).toHaveLength(steps.length + 1);
  for (let i = 0; i < steps.length; i++) {
    if (steps[i] >= DUPLICATE_STEP_FLOOR_PX) {
      expect(hashes[i + 1]).not.toBe(hashes[i]);
    }
  }
}

function failVisible(error: unknown): never {
  throw error instanceof Error ? error : new Error(String(error));
}

function rowMean(frame: GrayFrames, frameIndex: number, y: number): number {
  const base = frameIndex * frame.width * frame.height + y * frame.width;
  let sum = 0;
  for (let x = 0; x < frame.width; x += 4) sum += frame.data[base + x];
  return sum / (frame.width / 4);
}

/** Mid-tone pixel count of a row: blurred rows spread the transition widely. */
function midToneCount(frame: GrayFrames, frameIndex: number, y: number): number {
  const base = frameIndex * frame.width * frame.height + y * frame.width;
  let count = 0;
  for (let x = 0; x < frame.width; x++) {
    const v = frame.data[base + x];
    if (v > 60 && v < 200) count++;
  }
  return count;
}


function framemd5(file: string): string[] {
  const text = execFileSync("ffmpeg", ["-v", "error", "-i", file, "-map", "0:v", "-f", "framemd5", "-"], { encoding: "utf8" });
  return text.split("\n").filter((line) => line && !line.startsWith("#")).map((line) => line.split(",").at(-1)!.trim());
}

function findFiles(root: string, pattern: string): string[] {
  const regex = new RegExp("^" + pattern.replace(/\*/g, ".*") + "$");
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (regex.test(entry.name)) found.push(full);
    }
  };
  walk(root);
  return found.sort();
}

describe("still camera motion rendered evidence (Issue 33)", () => {
  warpIt("renders a horizontal tracking still with zero-jitter subpixel motion and exact duration", async () => {
    const frames = 45;
    const fixture = await makeStillProject(VERTICAL_EDGE_STILL(1080));
    const timelinePath = path.join(fixture.projectDir, "05_timeline/timeline.json");
    fs.writeFileSync(timelinePath, JSON.stringify(makeTimeline(fixture.assetId, {
      width: 1080, height: 1080, frames, fpsNum: 30, fpsDen: 1,
      cameraMotion: { preset: "horizontal_tracking", easing: "smoothstep", intensity: 0.3 },
    })));
    const output = path.join(fixture.projectDir, "05_timeline/assembly.mp4");
    await assembleTimelineToMp4({ projectDir: fixture.projectDir, timelinePath, outputPath: output });

    // Duration evidence: exactly the timeline hold at exactly 30fps.
    expect(probeStreams(output)).toMatchObject({
      width: 1080, height: 1080, r_frame_rate: "30/1", nb_read_frames: String(frames),
    });

    const plan = resolveStillCameraMotion({ preset: "horizontal_tracking", easing: "smoothstep", intensity: 0.3 }, frames);
    const trajectory = cameraMotionTrajectory(plan);
    const decoded = decodeGray(output);

    // Jitter evidence 1: with this plan the smallest eased step exceeds the
    // 8-bit measurement floor, so every frame must be distinct — the
    // strongest anti-integer-grid evidence.
    const steps = plannedEdgeSteps(plan, 0.25, decoded.width, "x");
    expect(Math.min(...steps)).toBeGreaterThan(DUPLICATE_STEP_FLOOR_PX);
    expect(new Set(frameHashes(decoded)).size).toBe(frames);
    assertNoStairStepJitter(decoded, steps);

    // Jitter evidence 2: measured subpixel edge positions match the planned
    // Float64 trajectory within the resample/measurement bound.
    const measured: number[] = [];
    const errors: number[] = [];
    for (let i = 0; i < frames; i++) {
      const plannedX = screenPos(0.25, trajectory[i], decoded.width, "x");
      const measuredX = verticalEdgeX(decoded, i, decoded.height >> 1, plannedX);
      measured.push(measuredX);
      errors.push(Math.abs(measuredX - plannedX));
    }
    expect(Math.max(...errors)).toBeLessThanOrEqual(PLAN_TOLERANCE_PX);

    // Jitter evidence 3: monotonic direction — no back-and-forth reversal.
    for (let i = 1; i < measured.length; i++) {
      expect(measured[i]).toBeLessThanOrEqual(measured[i - 1] + DUPLICATE_STEP_FLOOR_PX);
    }

    // Duration-synchronized easing evidence: the move completes on the last
    // displayed frame — measured total displacement equals the plan.
    const measuredTotal = Math.abs(measured[frames - 1] - measured[0]);
    const plannedTotal = Math.abs(screenPos(0.25, trajectory[frames - 1], decoded.width, "x")
      - screenPos(0.25, trajectory[0], decoded.width, "x"));
    expect(Math.abs(measuredTotal - plannedTotal)).toBeLessThanOrEqual(TOTAL_DISP_TOLERANCE_PX);
    expect(plannedTotal).toBeGreaterThan(50); // the move is plainly visible
  }, 120_000);

  warpIt("executes every preset with the planned direction and subpixel accuracy", async () => {
    const presetMatrix = [
      ["push_in", "vertical", -1],
      ["pull_out", "vertical", 1],
      ["horizontal_tracking", "vertical", -1],
      ["tilt_down", "horizontal", -1],
      ["diagonal_drift", "horizontal", -1],
    ] as const;
    for (const [preset, axis, sign] of presetMatrix) {
      const size = 540;
      const stillArgs = axis === "vertical" ? VERTICAL_EDGE_STILL(size) : HORIZONTAL_EDGE_STILL(size);
      const fixture = await makeStillProject(stillArgs);
      const frames = 21;
      const timelinePath = path.join(fixture.projectDir, "05_timeline/timeline.json");
      fs.writeFileSync(timelinePath, JSON.stringify(makeTimeline(fixture.assetId, {
        width: size, height: size, frames, fpsNum: 30, fpsDen: 1,
        cameraMotion: { preset, easing: "linear", intensity: 0.3 },
      })));
      const output = path.join(fixture.projectDir, "05_timeline/preset.mp4");
      await assembleTimelineToMp4({ projectDir: fixture.projectDir, timelinePath, outputPath: output });

      const plan = resolveStillCameraMotion({ preset, easing: "linear", intensity: 0.3 }, frames);
      const trajectory = cameraMotionTrajectory(plan);
      const decoded = decodeGray(output);
      const edgeAxis = axis === "vertical" ? "x" as const : "y" as const;
      const measured = axis === "vertical"
        ? (i: number) => verticalEdgeX(decoded, i, decoded.height >> 1, screenPos(0.25, trajectory[i], decoded.width, edgeAxis))
        : (i: number) => horizontalEdgeY(decoded, i, decoded.width >> 1, screenPos(0.25, trajectory[i], decoded.height, edgeAxis));

      for (let i = 0; i < frames; i++) {
        const planned = screenPos(0.25, trajectory[i], axis === "vertical" ? decoded.width : decoded.height, edgeAxis);
        expect(Math.abs(measured(i) - planned), `${preset} frame ${i}`).toBeLessThanOrEqual(PLAN_TOLERANCE_PX);
      }
      assertNoStairStepJitter(decoded, plannedEdgeSteps(plan, 0.25, axis === "vertical" ? decoded.width : decoded.height, edgeAxis));

      // Direction evidence: net displacement sign matches the preset contract.
      const net = measured(frames - 1) - measured(0);
      if (sign < 0) expect(net, `${preset} direction`).toBeLessThan(-30);
      else expect(net, `${preset} direction`).toBeGreaterThan(30);
    }
  }, 240_000);

  warpIt("auto-composes 1080x1080 foreground at Y=320 over 1080x1920 blurred background at 30fps", async () => {
    const frames = 60;
    const fixture = await makeStillProject(VERTICAL_EDGE_STILL(1080));
    const timelinePath = path.join(fixture.projectDir, "05_timeline/timeline.json");
    fs.writeFileSync(timelinePath, JSON.stringify(makeTimeline(fixture.assetId, {
      width: 1080, height: 1920, frames, fpsNum: 30, fpsDen: 1,
      cameraMotion: { preset: "push_in", easing: "smoothstep", intensity: 0.15 },
    })));
    const output = path.join(fixture.projectDir, "05_timeline/vertical.mp4");
    // Perf measurement (no acceptance threshold in the issue): record the
    // wall-clock render throughput as data for regression tracking only.
    const perfStart = Date.now();
    await assembleTimelineToMp4({ projectDir: fixture.projectDir, timelinePath, outputPath: output });
    const perfElapsedMs = Date.now() - perfStart;
    console.info(
      `[still-camera-motion perf] 1080x1920 ${frames}f composite render:`
      + ` ${perfElapsedMs}ms = ${(frames / (perfElapsedMs / 1000)).toFixed(2)} render-fps`,
    );

    expect(probeStreams(output)).toMatchObject({
      width: 1080, height: 1920, r_frame_rate: "30/1", nb_read_frames: String(frames),
    });

    const decoded = decodeGray(output);
    // Background rows stay static across the whole clip (blur backdrop).
    for (const y of [80, 200, 318]) {
      expect(Math.abs(rowMean(decoded, 0, y) - rowMean(decoded, frames - 1, y))).toBeLessThan(1.5);
    }
    // Foreground is sharp while the backdrop is blurred: the fg row keeps a
    // tight edge transition (<= 8 mid-tone columns) while the sigma-28 blur
    // spreads the same edge across dozens of columns.
    expect(midToneCount(decoded, 0, 700)).toBeLessThan(8);
    expect(midToneCount(decoded, 0, 200)).toBeGreaterThan(20);
    expect(midToneCount(decoded, 0, 200)).toBeGreaterThan(4 * midToneCount(decoded, 0, 700));

    // The foreground carries the motion exactly as planned: the u=0.25 edge
    // tracks the push_in trajectory (monotonic left drift as zoom grows).
    const plan = resolveStillCameraMotion({ preset: "push_in", easing: "smoothstep", intensity: 0.15 }, frames);
    const trajectory = cameraMotionTrajectory(plan);
    const errors: number[] = [];
    for (let i = 0; i < frames; i++) {
      const plannedX = screenPos(0.25, trajectory[i], decoded.width, "x");
      const measuredX = verticalEdgeX(decoded, i, 700, plannedX);
      errors.push(Math.abs(measuredX - plannedX));
    }
    expect(Math.max(...errors)).toBeLessThanOrEqual(PLAN_TOLERANCE_PX);
    assertNoStairStepJitter(decoded, plannedEdgeSteps(plan, 0.25, decoded.width, "x"));
  }, 120_000);

  warpIt("renders the identical moving-still pixels through canonical preview and final assembly", async () => {
    const fixture = await makeStillProject(VERTICAL_EDGE_STILL(540));
    const frames = 24;
    const timelinePath = path.join(fixture.projectDir, "05_timeline/timeline.json");
    fs.writeFileSync(timelinePath, JSON.stringify(makeTimeline(fixture.assetId, {
      width: 540, height: 540, frames, fpsNum: 30, fpsDen: 1,
      cameraMotion: { preset: "push_in", easing: "smoothstep", intensity: 0.18 },
    })));
    const preview = await renderPreviewSegment({
      projectDir: fixture.projectDir,
      timelinePath,
      sourceMap: loadSourceMap(fixture.projectDir),
      outputPath: path.join(fixture.projectDir, "05_timeline/preview.mp4"),
    });
    const assembly = path.join(fixture.projectDir, "05_timeline/assembly.mp4");
    await assembleTimelineToMp4({ projectDir: fixture.projectDir, timelinePath, outputPath: assembly });

    const decodedFrames = (file: string): string[] => {
      const text = execFileSync("ffmpeg", ["-v", "error", "-i", file, "-map", "0:v", "-f", "framemd5", "-"], { encoding: "utf8" });
      return text.split("\n").filter((line) => line && !line.startsWith("#")).map((line) => line.split(",").at(-1)!.trim());
    };
    expect(decodedFrames(preview.outputPath)).toEqual(decodedFrames(assembly));
    // and the preview actually moves (no silent static fallback)
    const decoded = decodeGray(preview.outputPath);
    expect(new Set(frameHashes(decoded)).size).toBe(frames);
  }, 120_000);

  warpIt("preserves the original still motion timebase when firstNSec truncates preview", async () => {
    const fullFrames = 60;
    const previewFrames = 30;
    const fixture = await makeStillProject(VERTICAL_EDGE_STILL(540));
    const timelinePath = path.join(fixture.projectDir, "05_timeline/timeline.json");
    fs.writeFileSync(timelinePath, JSON.stringify(makeTimeline(fixture.assetId, {
      width: 540, height: 540, frames: fullFrames, fpsNum: 30, fpsDen: 1,
      cameraMotion: { preset: "push_in", easing: "smoothstep", intensity: 0.3 },
    })));

    const preview = await renderPreviewSegment({
      projectDir: fixture.projectDir,
      timelinePath,
      sourceMap: loadSourceMap(fixture.projectDir),
      firstNSec: 1,
      outputPath: path.join(fixture.projectDir, "05_timeline/preview-first.mp4"),
    });
    const assembly = path.join(fixture.projectDir, "05_timeline/assembly-full.mp4");
    await assembleTimelineToMp4({ projectDir: fixture.projectDir, timelinePath, outputPath: assembly });

    // Production parity evidence: the one-second preview is the first 30
    // frames of the full render, not a newly eased 30-frame move.
    expect(framemd5(preview.outputPath)).toEqual(framemd5(assembly).slice(0, previewFrames));
    expect(probeStreams(preview.outputPath)).toMatchObject({
      width: 540, height: 540, r_frame_rate: "30/1", nb_read_frames: String(previewFrames),
    });

    // Objective timebase evidence: the boundary frame follows frame 29 of the
    // original 60-frame plan. A truncated-plan re-time would already be at
    // its final frame here and would miss this planned position.
    const plan = resolveStillCameraMotion({ preset: "push_in", easing: "smoothstep", intensity: 0.3 }, fullFrames);
    const trajectory = cameraMotionTrajectory(plan);
    const decoded = decodeGray(preview.outputPath);
    const plannedX = screenPos(0.25, trajectory[previewFrames - 1], decoded.width, "x");
    const measuredX = verticalEdgeX(decoded, previewFrames - 1, decoded.height >> 1, plannedX);
    expect(Math.abs(measuredX - plannedX)).toBeLessThanOrEqual(PLAN_TOLERANCE_PX);
    expect(Math.abs(plannedX - screenPos(0.25, trajectory[fullFrames - 1], decoded.width, "x"))).toBeGreaterThan(10);
  }, 180_000);

  warpIt("keeps combined still camera motion and transition preview frames identical to final", async () => {
    const frames = 30;
    const overlap = 8;
    const fixture = await makeStillProject(VERTICAL_EDGE_STILL(540));
    const timeline = makeTimeline(fixture.assetId, {
      width: 540, height: 540, frames, fpsNum: 30, fpsDen: 1,
      cameraMotion: { preset: "push_in", easing: "smoothstep", intensity: 0.22 },
    }) as any;
    const second = { ...structuredClone(timeline.tracks.video[0].clips[0]),
      clip_id: "CLP_MOTION_2", segment_id: "SEG_MOTION_2", timeline_in_frame: frames - overlap };
    second.still_image.camera_motion = {
      preset: "horizontal_tracking", easing: "linear", intensity: 0.18,
    };
    timeline.tracks.video[0].clips.push(second);
    timeline.transitions = [{
      transition_id: "TR_COMBINED", from_clip_id: "CLP_MOTION", to_clip_id: "CLP_MOTION_2",
      transition_type: "crossfade", transition_frames: overlap,
    }];
    const timelinePath = path.join(fixture.projectDir, "05_timeline/timeline.json");
    fs.writeFileSync(timelinePath, JSON.stringify(timeline));

    const preview = await renderPreviewSegment({
      projectDir: fixture.projectDir,
      timelinePath,
      sourceMap: loadSourceMap(fixture.projectDir),
      outputPath: path.join(fixture.projectDir, "05_timeline/preview-transition.mp4"),
    });
    const assembly = path.join(fixture.projectDir, "05_timeline/assembly-transition.mp4");
    await assembleTimelineToMp4({ projectDir: fixture.projectDir, timelinePath, outputPath: assembly });

    // One combined counterexample: both clips carry real camera plans and the
    // declared overlap is rendered by the same transition graph in preview
    // and final, so no hard-concat path can satisfy the frame/hash contract.
    expect(preview.clipCount).toBe(2);
    expect(preview.durationSec).toBeCloseTo((frames * 2 - overlap) / 30, 6);
    expect(framemd5(preview.outputPath)).toEqual(framemd5(assembly));
    expect(probeStreams(preview.outputPath)).toMatchObject({
      width: 540, height: 540, r_frame_rate: "30/1", nb_read_frames: String(frames * 2 - overlap),
    });
  }, 180_000);

  warpIt("surfaces output cleanup failure and retains ownership after ffmpeg failure", async () => {
    const fixture = await makeStillProject(VERTICAL_EDGE_STILL(540));
    const output = path.join(fixture.projectDir, "05_timeline/cleanup-failure.mp4");
    const motion = resolveStillCameraMotion({
      preset: "push_in", easing: "linear", intensity: 0.15,
    }, 2);
    const realExec = execFile as unknown as ExecFileLike;
    const failFinalEncode: ExecFileLike = (file, args, options, callback) => {
      if (args.includes("rawvideo")) {
        callback(Object.assign(new Error("synthetic ffmpeg failure"), { code: 1 }), "", "synthetic ffmpeg");
        return;
      }
      realExec(file, args, options, callback);
    };
    const removePathImpl = (target: string, options: { recursive?: boolean; force?: boolean }): void => {
      if (target === output) throw new Error("synthetic EPERM deleting output");
      fs.rmSync(target, options);
    };

    try {
      await expect(renderStillMotionSegment({
        inputPath: fixture.sourcePath,
        outputPath: output,
        frameCount: 2,
        width: 540,
        height: 540,
        fpsRational: "30/1",
        motion,
        execFileImpl: failFinalEncode,
        removePathImpl,
      })).rejects.toThrow(/ffmpeg_failed:synthetic ffmpeg.*still_camera_cleanup_failed/);
      expect(registeredRenderCleanupCount()).toBe(1);
    } finally {
      const retry = cleanupRegisteredRenderPathsSync();
      expect(retry.retained).toEqual([]);
    }
    expect(registeredRenderCleanupCount()).toBe(0);
    expect(fs.existsSync(output)).toBe(false);
  }, 120_000);

  warpIt("executes camera motion inside the shared transition chain graph", async () => {
    const fixture = await makeStillProject(HORIZONTAL_EDGE_STILL(540));
    const frames = 30;
    const timeline = makeTimeline(fixture.assetId, {
      width: 540, height: 540, frames, fpsNum: 30, fpsDen: 1,
      cameraMotion: { preset: "diagonal_drift", easing: "smoothstep", intensity: 0.3 },
    }) as any;
    // A second still clip overlapping via crossfade forces the whole-chain path.
    const second = { ...structuredClone(timeline.tracks.video[0].clips[0]), clip_id: "CLP_MOTION_2", segment_id: "SEG_MOTION_2", timeline_in_frame: frames - 6 };
    timeline.tracks.video[0].clips.push(second);
    timeline.transitions = [{ transition_id: "TR_1", from_clip_id: "CLP_MOTION", to_clip_id: "CLP_MOTION_2", transition_type: "crossfade", transition_frames: 6 }];
    const timelinePath = path.join(fixture.projectDir, "05_timeline/timeline.json");
    fs.writeFileSync(timelinePath, JSON.stringify(timeline));
    const output = path.join(fixture.projectDir, "05_timeline/chained.mp4");
    await assembleTimelineToMp4({ projectDir: fixture.projectDir, timelinePath, outputPath: output });

    expect(Number(probeStreams(output).nb_read_frames)).toBe(54);
    const decoded = decodeGray(output);
    // First clip's 24 solo frames all move (pre-rendered warp segments feed
    // the chain): no stair-step duplicates beyond the measurement floor,
    // monotonic edge drift.
    const plan = resolveStillCameraMotion({ preset: "diagonal_drift", easing: "smoothstep", intensity: 0.3 }, frames);
    const steps = plannedEdgeSteps(plan, 0.25, decoded.height, "y").slice(0, 23);
    const hashes = frameHashes(decoded).slice(0, 24);
    for (let i = 0; i < steps.length; i++) {
      if (steps[i] >= DUPLICATE_STEP_FLOOR_PX) expect(hashes[i + 1]).not.toBe(hashes[i]);
    }
    const edgeY = (i: number) => horizontalEdgeY(decoded, i, decoded.width >> 1, screenPos(0.25, cameraWindowState(plan, i), decoded.height, "y"));
    expect(edgeY(23)).toBeLessThan(edgeY(0) - 20);
  }, 120_000);

  warpIt("resolves a 0.001px screen step as genuinely different rendered pixels", async () => {
    // Direct worker evidence of the Issue 33 coordinate granularity: two
    // camera states exactly 0.001px apart on screen must produce different
    // frames through the float64 Lanczos warp — impossible under the rejected
    // 0.25px oversampled-zoompan grid (or OpenCV's 1/32px fixed-point warp).
    // The fixture is phase-diverse (diagonal stripes, ~97 distinct edge
    // phases per row cycle) so an 8-bit output can actually express a
    // 0.00077px source-coordinate shift somewhere in the frame.
    const size = 540;
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "vos-still-warp-gran-"));
    dirs.push(projectDir);
    const basePath = path.join(projectDir, "base.png");
    ffmpeg([
      "-f", "lavfi", "-i", `color=black:s=${size}x${size},format=gray`,
      "-vf", "geq=lum='if(lt(mod(X+Y/97,16),8),0,255)':cb=128:cr=128",
      "-frames:v", "1", "-y", basePath,
    ]);
    const zoom = 1.3;
    const pxToNormalized = 0.001 / (zoom * size);
    const trajectory = [
      { zoom, centerX: 0.5, centerY: 0.5 },
      { zoom, centerX: 0.5 + pxToNormalized, centerY: 0.5 },
    ];
    const warp = await renderStillCameraWarp({
      input: basePath,
      window: { width: size, height: size },
      fps: { num: 30, den: 1 },
      fit_mode: "cover",
      background: "black",
      frame_count: 2,
      policy: "still-camera-motion/v1",
      trajectory,
    });
    const bytes = fs.readFileSync(warp.rawPath);
    const frameSize = size * size * 3;
    expect(bytes.length).toBe(2 * frameSize);
    expect(bytes.subarray(0, frameSize).equals(bytes.subarray(frameSize))).toBe(false);
    // Determinism: the identical request warps to byte-identical output.
    const again = await renderStillCameraWarp({
      input: basePath,
      window: { width: size, height: size },
      fps: { num: 30, den: 1 },
      fit_mode: "cover",
      background: "black",
      frame_count: 2,
      policy: "still-camera-motion/v1",
      trajectory,
    });
    expect(fs.readFileSync(again.rawPath).equals(bytes)).toBe(true);
    for (const result of [warp, again]) {
      for (const dir of result.cleanup) {
        fs.rmSync(dir, { recursive: true, force: true });
        unregisterRenderCleanupPath(dir);
      }
    }
  }, 60_000);

  ffit("rejects metadata-only motion claims before any renderer side effect", async () => {
    const fixture = await makeStillProject(VERTICAL_EDGE_STILL(540));
    const timelinePath = path.join(fixture.projectDir, "05_timeline/timeline.json");
    const output = path.join(fixture.projectDir, "05_timeline/rejected.mp4");
    // motion_mode claims camera_motion but carries no executable plan
    fs.writeFileSync(timelinePath, JSON.stringify(makeTimeline(fixture.assetId, {
      width: 540, height: 540, frames: 12, fpsNum: 30, fpsDen: 1, motionMode: "camera_motion",
    })));
    await expect(assembleTimelineToMp4({ projectDir: fixture.projectDir, timelinePath, outputPath: output }))
      .rejects.toThrow("still_camera_motion_metadata_without_plan");
    expect(fs.existsSync(output)).toBe(false);

    // a plan without the matching mode is a provenance mismatch
    fs.writeFileSync(timelinePath, JSON.stringify(makeTimeline(fixture.assetId, {
      width: 540, height: 540, frames: 12, fpsNum: 30, fpsDen: 1,
      cameraMotion: { preset: "push_in" }, motionMode: "static",
    })));
    await expect(assembleTimelineToMp4({ projectDir: fixture.projectDir, timelinePath, outputPath: output }))
      .rejects.toThrow("still_camera_motion_mode_mismatch");
    expect(fs.existsSync(output)).toBe(false);
  }, 60_000);

  ffit("rejects invalid presets at render time instead of silently going static", async () => {
    const fixture = await makeStillProject(VERTICAL_EDGE_STILL(540));
    const timelinePath = path.join(fixture.projectDir, "05_timeline/timeline.json");
    fs.writeFileSync(timelinePath, JSON.stringify(makeTimeline(fixture.assetId, {
      width: 540, height: 540, frames: 12, fpsNum: 30, fpsDen: 1,
      cameraMotion: { preset: "spin_360" },
    })));
    const output = path.join(fixture.projectDir, "05_timeline/invalid.mp4");
    await expect(assembleTimelineToMp4({ projectDir: fixture.projectDir, timelinePath, outputPath: output }))
      .rejects.toThrow(/still_camera_motion_invalid_preset/);
    expect(fs.existsSync(output)).toBe(false);
  }, 60_000);

  warpIt("fails closed with an explicit capability error when cv2 is missing", async () => {
    // A python without cv2 (the default system interpreter on this host)
    // must produce an explicit capability failure — never a static render.
    const fixture = await makeStillProject(VERTICAL_EDGE_STILL(540));
    const timelinePath = path.join(fixture.projectDir, "05_timeline/timeline.json");
    fs.writeFileSync(timelinePath, JSON.stringify(makeTimeline(fixture.assetId, {
      width: 540, height: 540, frames: 12, fpsNum: 30, fpsDen: 1,
      cameraMotion: { preset: "push_in", easing: "smoothstep", intensity: 0.1 },
    })));
    const output = path.join(fixture.projectDir, "05_timeline/nocv.mp4");
    // Owner-scoped containment for the assembler's own working temp root,
    // removed in finally on every path (missing capability included).
    const scopedRoot = fs.mkdtempSync(path.join(os.tmpdir(), "vos-still-hostile-root-"));
    const probe = await probeStillCameraCapability({ pythonBinary: "python3" });
    const teardown = new TeardownScope();
    teardown.add("scoped root residue check", () => {
      // no camera segment may exist anywhere under the scoped assembler root
      expect(findFiles(scopedRoot, "still-motion-*.mp4")).toEqual([]);
    });
    teardown.add("scoped root removal", () => fs.rmSync(scopedRoot, { recursive: true, force: true }));
    try {
      if (probe.ok) {
        // Host has cv2 on the default python too; inject a missing-worker seam
        // instead so the capability gate still proves fail-closed behavior.
        await expect(assembleTimelineToMp4({
          projectDir: fixture.projectDir, timelinePath, outputPath: output,
          workingDirRoot: scopedRoot,
          stillCamera: { pythonBinary: "python3", workerPath: path.join(fixture.projectDir, "no-such-worker.py") },
        })).rejects.toThrow(/still_camera_capability_missing/);
      } else {
        await expect(assembleTimelineToMp4({
          projectDir: fixture.projectDir, timelinePath, outputPath: output,
          workingDirRoot: scopedRoot,
          stillCamera: { pythonBinary: "python3" },
        })).rejects.toThrow(StillCameraCapabilityError);
      }
    } finally {
      await teardown.run();
    }
    expect(fs.existsSync(output)).toBe(false);
  }, 60_000);
  it("rejects remotion-engine camera-motion timelines in the preflight gate", () => {
    const timeline = makeTimeline("asset-x", {
      width: 64, height: 64, frames: 12, fpsNum: 30, fpsDen: 1,
      cameraMotion: { preset: "push_in" },
    });
    expect(timelineHasCameraMotionStill(timeline)).toBe(true);
    const staticTimeline = makeTimeline("asset-x", {
      width: 64, height: 64, frames: 12, fpsNum: 30, fpsDen: 1,
    });
    expect(timelineHasCameraMotionStill(staticTimeline)).toBe(false);
  });

  it("64x64 hostile counterexample: produceAssembly(engine=remotion) must not render camera motion", async () => {
    const fixture = await makeStillProject(VERTICAL_EDGE_STILL(64));
    const timelinePath = path.join(fixture.projectDir, "05_timeline/timeline.json");
    fs.writeFileSync(timelinePath, JSON.stringify(makeTimeline(fixture.assetId, {
      width: 64, height: 64, frames: 12, fpsNum: 30, fpsDen: 1,
      cameraMotion: { preset: "push_in", easing: "smoothstep", intensity: 0.1 },
    })));
    const output = path.join(fixture.projectDir, "05_timeline/remotion.mp4");
    // Regression guard for the audited bypass: the Remotion CSS lane has no
    // Float64 worker/capability contract and no preview parity, so the
    // official final must be rejected in preflight — with a deliberately
    // broken worker env too (the gate is engine-level, not capability-level).
    const originalPython = process.env.VOS_STILL_CAMERA_PYTHON;
    try {
      for (const python of [undefined, "/nonexistent/still-camera-python"]) {
        if (python === undefined) delete process.env.VOS_STILL_CAMERA_PYTHON;
        else process.env.VOS_STILL_CAMERA_PYTHON = python;
        await expect(produceAssembly({
          timelinePath,
          sourceMap: { [fixture.assetId]: fixture.sourcePath },
          outputPath: output,
          engine: "remotion",
        })).rejects.toThrow(/still_camera_motion_remotion_unsupported/);
        expect(fs.existsSync(output)).toBe(false);
      }
    } finally {
      if (originalPython === undefined) delete process.env.VOS_STILL_CAMERA_PYTHON;
      else process.env.VOS_STILL_CAMERA_PYTHON = originalPython;
    }
  }, 60_000);

  warpIt("canonical 1080x1920: preview and final produce identical moving composite pixels", async () => {
    const frames = 36;
    const fixture = await makeStillProject(VERTICAL_EDGE_STILL(1080));
    const timelinePath = path.join(fixture.projectDir, "05_timeline/timeline.json");
    fs.writeFileSync(timelinePath, JSON.stringify(makeTimeline(fixture.assetId, {
      width: 1080, height: 1920, frames, fpsNum: 30, fpsDen: 1,
      cameraMotion: { preset: "push_in", easing: "smoothstep", intensity: 0.12 },
    })));
    const preview = await renderPreviewSegment({
      projectDir: fixture.projectDir,
      timelinePath,
      sourceMap: loadSourceMap(fixture.projectDir),
      outputPath: path.join(fixture.projectDir, "05_timeline/preview.mp4"),
    });
    const assembly = path.join(fixture.projectDir, "05_timeline/assembly.mp4");
    await assembleTimelineToMp4({ projectDir: fixture.projectDir, timelinePath, outputPath: assembly });

    const decodedFrames = (file: string): string[] => {
      const text = execFileSync("ffmpeg", ["-v", "error", "-i", file, "-map", "0:v", "-f", "framemd5", "-"], { encoding: "utf8" });
      return text.split("\n").filter((line) => line && !line.startsWith("#")).map((line) => line.split(",").at(-1)!.trim());
    };
    expect(decodedFrames(preview.outputPath)).toEqual(decodedFrames(assembly));
    expect(probeStreams(assembly)).toMatchObject({
      width: 1080, height: 1920, r_frame_rate: "30/1", nb_read_frames: String(frames),
    });
  }, 180_000);

  warpIt("canonical 1080x1920: motion composites survive the shared transition chain", async () => {
    const frames = 30;
    const fixture = await makeStillProject(VERTICAL_EDGE_STILL(1080));
    const timeline = makeTimeline(fixture.assetId, {
      width: 1080, height: 1920, frames, fpsNum: 30, fpsDen: 1,
      cameraMotion: { preset: "push_in", easing: "smoothstep", intensity: 0.25 },
    }) as any;
    const second = { ...structuredClone(timeline.tracks.video[0].clips[0]), clip_id: "CLP_MOTION_2", segment_id: "SEG_MOTION_2", timeline_in_frame: frames - 6 };
    timeline.tracks.video[0].clips.push(second);
    timeline.transitions = [{ transition_id: "TR_1", from_clip_id: "CLP_MOTION", to_clip_id: "CLP_MOTION_2", transition_type: "crossfade", transition_frames: 6 }];
    const timelinePath = path.join(fixture.projectDir, "05_timeline/timeline.json");
    fs.writeFileSync(timelinePath, JSON.stringify(timeline));
    const output = path.join(fixture.projectDir, "05_timeline/chained.mp4");
    await assembleTimelineToMp4({ projectDir: fixture.projectDir, timelinePath, outputPath: output });

    expect(Number(probeStreams(output).nb_read_frames)).toBe(54);
    expect(probeStreams(output)).toMatchObject({ width: 1080, height: 1920 });
    const decoded = decodeGray(output);
    // First clip's 24 solo frames still carry the planned push-in motion on
    // the foreground edge inside the composite (pre-rendered segments feed
    // the chain), with the blur backdrop behind them.
    const plan = resolveStillCameraMotion({ preset: "push_in", easing: "smoothstep", intensity: 0.25 }, frames);
    const trajectory = cameraMotionTrajectory(plan);
    const errors: number[] = [];
    for (let i = 0; i < 24; i++) {
      const plannedX = screenPos(0.25, trajectory[i], decoded.width, "x");
      const measuredX = verticalEdgeX(decoded, i, 700, plannedX);
      errors.push(Math.abs(measuredX - plannedX));
    }
    expect(Math.max(...errors)).toBeLessThanOrEqual(PLAN_TOLERANCE_PX);
    // Background rows above the foreground stay static.
    for (const y of [80, 200, 318]) {
      expect(Math.abs(rowMean(decoded, 0, y) - rowMean(decoded, 23, y))).toBeLessThan(1.5);
    }
  }, 180_000);
  warpIt("chain pre-render is byte-identical to the standalone camera segment (framemd5 1:1)", async () => {
    const frames = 30;
    const motion = { preset: "push_in", easing: "smoothstep", intensity: 0.3 } as const;

    // Standalone route: single-clip assembly; the final mux is -c:v copy, so
    // the final output's frames ARE the standalone camera segment's frames.
    const soloFixture = await makeStillProject(VERTICAL_EDGE_STILL(540));
    const soloPath = path.join(soloFixture.projectDir, "05_timeline/timeline.json");
    fs.writeFileSync(soloPath, JSON.stringify(makeTimeline(soloFixture.assetId, {
      width: 540, height: 540, frames, fpsNum: 30, fpsDen: 1, cameraMotion: { ...motion },
    })));
    const soloRoot = fs.mkdtempSync(path.join(os.tmpdir(), "vos-still-solo-root-"));
    dirs.push(soloRoot);
    const soloOutput = path.join(soloFixture.projectDir, "05_timeline/solo.mp4");
    await assembleTimelineToMp4({
      projectDir: soloFixture.projectDir, timelinePath: soloPath,
      outputPath: soloOutput, workingDirRoot: soloRoot,
    });
    const soloHashes = framemd5(soloOutput);

    // Chain route: the same clip crossfaded into a clone forces the
    // whole-chain path with its pre-rendered camera segment.
    const chainFixture = await makeStillProject(VERTICAL_EDGE_STILL(540));
    const timeline = makeTimeline(chainFixture.assetId, {
      width: 540, height: 540, frames, fpsNum: 30, fpsDen: 1, cameraMotion: { ...motion },
    }) as any;
    const second = { ...structuredClone(timeline.tracks.video[0].clips[0]), clip_id: "CLP_MOTION_2", segment_id: "SEG_MOTION_2", timeline_in_frame: frames - 6 };
    timeline.tracks.video[0].clips.push(second);
    timeline.transitions = [{ transition_id: "TR_1", from_clip_id: "CLP_MOTION", to_clip_id: "CLP_MOTION_2", transition_type: "crossfade", transition_frames: 6 }];
    const chainPath = path.join(chainFixture.projectDir, "05_timeline/timeline.json");
    fs.writeFileSync(chainPath, JSON.stringify(timeline));
    const chainRoot = fs.mkdtempSync(path.join(os.tmpdir(), "vos-still-chain-root-"));
    dirs.push(chainRoot);
    const chainOutput = path.join(chainFixture.projectDir, "05_timeline/chained.mp4");
    await assembleTimelineToMp4({
      projectDir: chainFixture.projectDir, timelinePath: chainPath,
      outputPath: chainOutput, workingDirRoot: chainRoot, cleanupTemp: false,
    });

    // 1:1 framemd5 comparison, chain pre-render vs standalone camera segment.
    // Both chain clips carry the same plan, so BOTH pre-rendered segments
    // must match the standalone segment byte-for-byte.
    const preRendered = findFiles(chainRoot, "still-motion-*.mp4");
    expect(preRendered).toHaveLength(2);
    for (const segment of preRendered) {
      const preRenderHashes = framemd5(segment);
      expect(preRenderHashes).toHaveLength(frames);
      expect(preRenderHashes).toEqual(soloHashes);
    }

    // End-to-end: the chain output's solo frames must also be byte-identical
    // to the standalone output's frames (no lossy generation in the chain).
    const chainHashes = framemd5(chainOutput);
    expect(chainHashes.slice(0, frames - 6)).toEqual(soloHashes.slice(0, frames - 6));
  }, 180_000);

  warpIt("public /render signal cleanup drains owned assembler, worker, and scratch resources", async () => {
    const frames = 240;
    const fixture = await makeStillProject(VERTICAL_EDGE_STILL(1080));
    const timelinePath = path.join(fixture.projectDir, "05_timeline/timeline.json");
    const assemblyPath = path.join(fixture.projectDir, "05_timeline/assembly.mp4");
    fs.writeFileSync(timelinePath, JSON.stringify(makeTimeline(fixture.assetId, {
      width: 1080, height: 1920, frames, fpsNum: 30, fpsDen: 1,
      cameraMotion: { preset: "push_in", easing: "smoothstep", intensity: 0.12 },
    })));
    writePublicRenderGateArtifacts(fixture.projectDir, timelinePath);

    const privateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "vos-public-render-childroot-"));
    const teardown = new TeardownScope();
    let owned: OwnedRenderChild | null = null;
    let childPath = "";
    let bundleRoot = "";
    const stdout: string[] = [];
    const stderr: string[] = [];
    const failureContext = (): string => `child stdout: ${stdout.join("")} stderr: ${stderr.join("")}`;
    teardown.add("owned public render group terminate", async () => {
      if (owned) await owned.terminate();
    });
    teardown.add("public render private root residue check", () => {
      if (!fs.existsSync(privateRoot)) return;
      const ownedPrefixes = [
        "vos-assembler-", "vos-still-base-", "vos-still-warp-", "vos-still-render-inputs-",
      ];
      const residual = fs.readdirSync(privateRoot)
        .filter((name) => ownedPrefixes.some((prefix) => name.startsWith(prefix)));
      expect(residual, `private root residue: ${JSON.stringify(residual)}`).toEqual([]);
    });
    teardown.add("public render private root removal", () => {
      fs.rmSync(privateRoot, { recursive: true, force: true });
    });
    teardown.add("public render bundle root removal", () => {
      if (bundleRoot) fs.rmSync(bundleRoot, { recursive: true, force: true });
    });

    try {
      // Keep the bundled entry under the repository so its deliberate
      // external yaml import resolves through the repository node_modules;
      // TMPDIR still isolates every render scratch path below privateRoot.
      bundleRoot = fs.mkdtempSync(path.join(process.cwd(), "tests/.public-render-bundle-"));
      childPath = bundleFixture("tests/fixtures/public-render-signal-child.ts", bundleRoot, {
        externalizePackages: true,
      });
      owned = new OwnedRenderChild([childPath, fixture.projectDir], {
        env: { ...process.env, TMPDIR: privateRoot },
      });
      owned.child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk.toString()));
      owned.child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk.toString()));

      const readyDeadline = Date.now() + 120_000;
      while (!stdout.join("").includes("READY") && !owned.exited && Date.now() < readyDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(stdout.join(""), failureContext()).toContain("READY");
      expect(owned.exited, failureContext()).toBe(false);

      // Do not send the parent-only scenario signal until the long-running
      // assembler rawvideo ffmpeg is actually visible in this exact PGID.
      // The observation is deliberately scoped to the owned group; it never
      // discovers or signals a PID from process-table text.
      const rawvideoDeadline = Date.now() + 120_000;
      let rawvideoObserved = false;
      while (!rawvideoObserved && !owned.exited && Date.now() < rawvideoDeadline) {
        rawvideoObserved = rowsWithPgid(owned.pgid).some((row) =>
          !row.stat.includes("Z")
          && /\bffmpeg\b/.test(row.command)
          && /\s-f\s+rawvideo(?:\s|$)/.test(row.command));
        if (!rawvideoObserved) await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(rawvideoObserved, failureContext()).toBe(true);
      expect(owned.exited, failureContext()).toBe(false);

      // Scenario signal is delivered to the public render parent PID only.
      // The parent must terminate its exact registered Python/ffmpeg children
      // before native SIGTERM re-delivery; the test never signals the group.
      owned.signal("SIGTERM");
      const exit = await Promise.race([
        owned.onceSettled(),
        new Promise<"EXIT_TIMEOUT">((resolve) => setTimeout(() => resolve("EXIT_TIMEOUT"), 30_000)),
      ]);
      expect(exit, failureContext()).toEqual({ code: null, signal: "SIGTERM" });
      expect(fs.existsSync(assemblyPath)).toBe(false);

      // Wait beyond the previously observed orphan window, then inspect only
      // the exact detached PGID. A live descendant would have been reparented
      // to PID 1 while retaining this PGID and would fail this assertion
      // before the owner-scoped teardown gets a chance to sweep it.
      await new Promise((resolve) => setTimeout(resolve, 500));
      const liveOwnedRows = rowsWithPgid(owned.pgid).filter((row) => !row.stat.includes("Z"));
      expect(liveOwnedRows, failureContext()).toEqual([]);
      const ownedPrefixes = [
        "vos-assembler-", "vos-still-base-", "vos-still-warp-", "vos-still-render-inputs-",
      ];
      const residualScratch = fs.readdirSync(privateRoot)
        .filter((name) => ownedPrefixes.some((prefix) => name.startsWith(prefix)));
      expect(residualScratch, failureContext()).toEqual([]);
    } finally {
      await teardown.run();
    }

    expect(owned!.groupAlive()).toBe(false);
    expect(fixtureProcessRows(childPath, { pgid: owned!.pgid })).toEqual([]);
    await expectNoSurvivors(childPath, [owned!.pgid]);
  }, 240_000);

  it("hostile: missing capability leaves zero temp and zero output side effects", async () => {
    const fixture = await makeStillProject(VERTICAL_EDGE_STILL(540));
    const timelinePath = path.join(fixture.projectDir, "05_timeline/timeline.json");
    fs.writeFileSync(timelinePath, JSON.stringify(makeTimeline(fixture.assetId, {
      width: 540, height: 540, frames: 12, fpsNum: 30, fpsDen: 1,
      cameraMotion: { preset: "push_in", easing: "smoothstep", intensity: 0.1 },
    })));
    const output = path.join(fixture.projectDir, "05_timeline/nocv.mp4");
    // Owner-scoped containment: the assembler's own working temp root is a
    // test-owned private root, removed in finally on every path. No global
    // temp-area assertions — an unrelated global vos-still dir cannot affect
    // this test.
    const scopedRoot = fs.mkdtempSync(path.join(os.tmpdir(), "vos-still-hostile-root-"));
    dirs.push(scopedRoot);
    const teardown = new TeardownScope();
    teardown.add("scoped root residue check", () => {
      expect(findFiles(scopedRoot, "still-motion-*.mp4")).toEqual([]);
    });
    teardown.add("scoped root removal", () => fs.rmSync(scopedRoot, { recursive: true, force: true }));

    const originalPython = process.env.VOS_STILL_CAMERA_PYTHON;
    try {
      process.env.VOS_STILL_CAMERA_PYTHON = "/nonexistent/still-camera-python";
      await expect(assembleTimelineToMp4({
        projectDir: fixture.projectDir, timelinePath, outputPath: output,
        workingDirRoot: scopedRoot,
      })).rejects.toThrow(/still_camera_capability_missing/);
    } catch (error) {
      failVisible(error);
    } finally {
      if (originalPython === undefined) delete process.env.VOS_STILL_CAMERA_PYTHON;
      else process.env.VOS_STILL_CAMERA_PYTHON = originalPython;
      await teardown.run();
    }
    expect(fs.existsSync(output)).toBe(false);
  }, 60_000);
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    warpIt(`hostile subprocess: real ${signal} mid-render removes temp and partial output with honest exit`, async () => {
      const fixture = await makeStillProject(VERTICAL_EDGE_STILL(1080));
      const output = path.join(fixture.projectDir, "05_timeline/partial.mp4");
      // 1080x1920 composite at 240f: the encode phase alone runs for
      // several seconds, so the signal reliably lands mid-render with a
      // genuine partial MP4 on disk.
      const frames = 240;

      // Teardown ownership begins BEFORE the first failure-capable
      // acquisition: the scope is created first and every resource registers
      // itself the moment it exists.
      const teardown = new TeardownScope();
      let privateRoot = "";
      let decoyDir = "";
      let childPath = "";
      let owned: OwnedRenderChild | null = null;
      teardown.add("owned group terminate", async () => {
        if (owned) await owned.terminate();
      });
      teardown.add("private root residue check", () => {
        if (!privateRoot || !fs.existsSync(privateRoot)) return;
        const residual = fs.readdirSync(privateRoot).filter((name) => name.startsWith("vos-still-"));
        expect(residual, `private root residue: ${JSON.stringify(residual)}`).toEqual([]);
      });
      teardown.add("private root removal", () => {
        if (privateRoot) fs.rmSync(privateRoot, { recursive: true, force: true });
      });
      teardown.add("global decoy dir removal (test-created only)", () => {
        if (decoyDir) fs.rmSync(decoyDir, { recursive: true, force: true });
      });
      try {
      // Private task-owned temp root: the child's TMPDIR points HERE, so its
      // registry/render temp dirs live only inside this exact root. A
      // concurrent unrelated vos-still directory in the global temp area is
      // neither attributed nor removed and cannot affect the assertions.
      privateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "vos-still-childroot-"));
      // simulates a concurrent worker's unrelated vos-still dir in the
      // global temp area: must never be attributed, touched, or removed
      decoyDir = fs.mkdtempSync(path.join(os.tmpdir(), "vos-still-base-decoy-"));
      // Launch the BUNDLED fixture with plain node through the ownership
      // wrapper: the child leads its own process group, so cleanup on ANY
      // exit path (pass, assertion failure, timeout) signals the exact group
      // and never orphans the render or its ffmpeg descendants. Bundling
      // (instead of a tsx loader) keeps an esbuild service out of the child's
      // process group — macOS refuses group signals (EPERM) while such a
      // member lives.
      childPath = bundleFixture("tests/fixtures/still-camera-signal-child.ts", privateRoot);
      const stdout: string[] = [];
      const stderr: string[] = [];
      const failureContext = (): string => `child stdout: ${stdout.join("")} stderr: ${stderr.join("")}`;
        owned = new OwnedRenderChild([childPath, fixture.sourcePath, output, String(frames)], {
          env: { ...process.env, TMPDIR: privateRoot },
        });
        owned.child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk.toString()));
        owned.child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk.toString()));
        const childTempEntries: string[] = [];
        const readiness = await Promise.race([
          new Promise<string>((resolve) => {
            let readySeen = false;
            let readyGrace: ReturnType<typeof setTimeout> | null = null;
            // The child prints READY and its NEWTEMP attribution lines in the
            // same tick but possibly in separate pipe chunks; resolve only
            // when both arrived so the attribution is complete.
            owned!.child.stdout.on("data", (chunk: Buffer) => {
              const lines = chunk.toString().split("\n");
              for (const l of lines) {
                if (l.startsWith("NEWTEMP:")) childTempEntries.push(l.slice(8).trim());
              }
              if (lines.some((l) => l.startsWith("READY")) && !readySeen) {
                readySeen = true;
                // Grace fallback AFTER READY: if attribution lines never
                // arrive, resolve with what we have — the assertion below
                // then fails with the collected evidence.
                readyGrace = setTimeout(() => resolve("READY"), 3_000);
              }
              const terminal = lines.find((l) => l.startsWith("TIMEOUT")
                || l.startsWith("RENDER_FINISHED_EARLY"));
              if (terminal) resolve(terminal.trim());
              if (readySeen && childTempEntries.some((n) => n.startsWith("vos-still-warp-"))) {
                if (readyGrace) clearTimeout(readyGrace);
                resolve("READY");
              }
            });
            owned!.onceSettled().then(() => resolve("CHILD_EXITED_EARLY"));
          }),
          new Promise<string>((resolve) => setTimeout(() => resolve("READY_WAIT_TIMEOUT"), 120_000)),
        ]);
        expect(readiness, failureContext()).toBe("READY");
        // the child must have created its worker request/temp dir
        expect(childTempEntries.some((name) => name.startsWith("vos-still-warp-")), failureContext()).toBe(true);

        owned!.signal(signal);
        // Honest exit semantics: the registry re-raises the received signal
        // as the sole handler, so the child dies NATIVELY by that signal
        // (exit code null) — never a clean exit(0) or an invented code.
        const exit = await Promise.race([
          owned!.onceSettled(),
          new Promise<"EXIT_TIMEOUT">((resolve) => setTimeout(() => resolve("EXIT_TIMEOUT"), 30_000)),
        ]);
        expect(exit, failureContext()).toEqual({ code: null, signal });

        // Zero side effects: every temp entry the child attributed to its
        // own render lived inside the CHILD-OWNED private root and is gone;
        // the decoy in the global temp area was neither attributed nor
        // removed; no partial output and no canonical mp4/render-report
        // anywhere under the project.
        for (const name of childTempEntries) {
          expect(name.includes("/"), `attribution must be root-relative: ${name}`).toBe(false);
          const resolved = path.join(privateRoot, name);
          expect(fs.existsSync(resolved), `leaked temp entry: ${resolved}`).toBe(false);
        }
        expect(decoyDir.startsWith(os.tmpdir())).toBe(true);
        expect(fs.existsSync(decoyDir), "the unrelated decoy must be untouched").toBe(true);
        expect(childTempEntries.includes(path.basename(decoyDir)), "the decoy must never be attributed").toBe(false);
        expect(fs.existsSync(output)).toBe(false);
        const leakedMp4 = findFiles(fixture.projectDir, "*.mp4");
        expect(leakedMp4).toEqual([]);
        expect(fs.existsSync(path.join(fixture.projectDir, "05_timeline/render-report.json"))).toBe(false);
      } finally {
        // Owner-scoped teardown on EVERY exit path (assertion failure,
        // timeout, rejection): the exact child group (child + ffmpeg
        // descendants) is swept via the negative PGID, then the private root
        // residue is verified and only the exact owned roots are removed.
        // Failures aggregate — a failing step never skips a later one.
        await teardown.run();
      }
      // Exact-group and exact-fixture verification — never broad matching.
      // Retried briefly: a group member orphaned by the leader's signal death
      // lingers as a zombie until the system reaper collects it.
      expect(owned!.groupAlive()).toBe(false);
      expect(fixtureProcessRows("tests/fixtures/still-camera-signal-child.ts", { pgid: owned!.pgid })).toEqual([]);
      await expectNoSurvivors(childPath, [owned!.pgid]);
    }, 240_000);
  }
});
