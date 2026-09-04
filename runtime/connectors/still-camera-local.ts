import { execFile } from "node:child_process";
import {
  registerRenderChild,
  registerRenderCleanupPath,
  unregisterRenderCleanupPath,
} from "../render/render-cleanup-registry.js";
import type { StillCameraFitMode } from "../render/camera-motion.js";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * Node bridge for the still-camera-motion NumPy worker (Issue 33 —
 * still-camera-motion/v1), following the repo's external-worker pattern
 * (see marlin-local.ts). The worker performs the true subpixel render with
 * Float64 coordinate evaluation and a Lanczos kernel per frame; OpenCV is used
 * only for image decode/color conversion. The pure Float64 plan math stays in TypeScript
 * (runtime/render/camera-motion.ts); this bridge only probes capability and
 * shuttles validated requests.
 *
 * Capability is fail-closed: when a camera-motion preset is requested and cv2
 * is unavailable, callers get an explicit StillCameraCapabilityError. There is
 * no integer-pixel fallback lane.
 */

export const STILL_CAMERA_MOTION_WORKER_POLICY = "still-camera-motion/v1" as const;

export interface StillCameraProbeOptions {
  cwd?: string;
  pythonBinary?: string;
  workerPath?: string;
  timeoutMs?: number;
  /**
   * Pre-probed capability (injection/dedup seam). When provided and `ok`, the
   * warp skips its own probe so callers can run the capability gate BEFORE
   * creating any temp/output side effects without probing twice.
   */
  capability?: StillCameraCapability;
}

export interface StillCameraCapability {
  ok: boolean;
  pythonBinary?: string;
  workerPath?: string;
  cv2Version?: string;
  numpyVersion?: string;
  interpolation?: string;
  precision?: string;
  border?: string;
  error?: string;
}

export class StillCameraCapabilityError extends Error {
  readonly code: string;

  constructor(message: string, code = "still_camera_capability_missing") {
    super(message);
    this.name = "StillCameraCapabilityError";
    this.code = code;
  }
}

interface WorkerResult {
  ok: boolean;
  error?: string;
  frames?: number;
  width?: number;
  height?: number;
  cv2_version?: string;
  numpy_version?: string;
  policy?: string;
  interpolation?: string;
  precision?: string;
  border?: string;
  source_width?: number;
  source_height?: number;
  fps?: { num?: number; den?: number };
}

export function defaultStillCameraPython(cwd: string): string {
  for (const candidate of [
    path.resolve(cwd, "python/.venv-still-camera/bin/python3"),
    path.resolve(cwd, ".venv-still-camera/bin/python3"),
    path.resolve(cwd, ".venv/bin/python3"),
  ]) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return "python3";
}

export function defaultStillCameraWorkerPath(cwd: string): string {
  const override = process.env.VOS_STILL_CAMERA_WORKER;
  if (override) return override;
  return path.resolve(cwd, "python/still_camera_motion_worker.py");
}

function resolveStillCameraPython(cwd: string, override?: string): string {
  return override ?? process.env.VOS_STILL_CAMERA_PYTHON ?? defaultStillCameraPython(cwd);
}

function runWorkerJson(
  pythonBinary: string,
  workerPath: string,
  args: string[],
  timeoutMs: number,
): Promise<WorkerResult> {
  return new Promise<WorkerResult>((resolve, reject) => {
    const child = execFile(pythonBinary, [workerPath, ...args], {
      cwd: process.cwd(),
      timeout: timeoutMs,
      maxBuffer: 4 * 1024 * 1024,
    }, (err, stdout, stderr) => {
      if (err) {
        const combined = `${stderr || ""}\n${stdout || ""}`;
        const detail = combined.trim().split(/\r?\n/).filter(Boolean).slice(-2).join(" / ");
        reject(new Error(`still_camera_worker_spawn_failed:${detail || err.code || err.message}`));
        return;
      }
      const line = stdout.split(/\r?\n/).find((l) => l.trim().startsWith("{"));
      if (!line) {
        reject(new Error("still_camera_worker_response_missing"));
        return;
      }
      try {
        resolve(JSON.parse(line) as WorkerResult);
      } catch {
        reject(new Error("still_camera_worker_response_unparseable"));
      }
    });
    registerRenderChild(child, `python:${pythonBinary}`);
  });
}

/**
 * Probe the worker once. Returns a capability record — `ok: false` with a
 * reason when the Python binary, the worker, or cv2 itself is unavailable.
 */
export async function probeStillCameraCapability(opts: StillCameraProbeOptions = {}): Promise<StillCameraCapability> {
  const cwd = opts.cwd ?? process.cwd();
  const pythonBinary = resolveStillCameraPython(cwd, opts.pythonBinary);
  const workerPath = opts.workerPath ?? defaultStillCameraWorkerPath(cwd);
  if (!fs.existsSync(workerPath)) {
    return { ok: false, pythonBinary, workerPath, error: "still_camera_worker_missing" };
  }
  const timeoutMs = opts.timeoutMs ?? 15_000;
  try {
    const result = await runWorkerJson(pythonBinary, workerPath, ["probe"], timeoutMs);
    if (!result.ok) {
      return { ok: false, pythonBinary, workerPath, error: result.error ?? "still_camera_worker_probe_failed" };
    }
    if (result.policy !== STILL_CAMERA_MOTION_WORKER_POLICY) {
      return {
        ok: false,
        pythonBinary,
        workerPath,
        error: `still_camera_worker_policy_mismatch:${String(result.policy)}`,
      };
    }
    if (result.interpolation !== "lanczos4" || result.precision !== "float64") {
      return {
        ok: false,
        pythonBinary,
        workerPath,
        error: `still_camera_worker_capability_mismatch:${String(result.interpolation)}/${String(result.precision)}`,
      };
    }
    return {
      ok: true,
      pythonBinary,
      workerPath,
      cv2Version: result.cv2_version,
      numpyVersion: result.numpy_version,
      interpolation: result.interpolation,
      precision: result.precision,
      border: result.border,
    };
  } catch (error) {
    return {
      ok: false,
      pythonBinary,
      workerPath,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Fail-closed capability check for a requested camera-motion render. */
export async function requireStillCameraCapability(opts: StillCameraProbeOptions = {}): Promise<StillCameraCapability> {
  const capability = await probeStillCameraCapability(opts);
  if (!capability.ok) {
    throw new StillCameraCapabilityError(
      `still_camera_capability_missing:${capability.error ?? "unknown"}`
        + " — provision python/requirements-still-camera.txt to render still camera motion;"
        + " integer-pixel fallback is disabled by policy",
    );
  }
  return capability;
}

export interface StillCameraWarpRequest {
  /** Verified source image; the worker fits and warps it in one Float64 map. */
  input: string;
  window: { width: number; height: number };
  fps: { num: number; den: number };
  fit_mode: StillCameraFitMode;
  background: string;
  frame_count: number;
  policy: typeof STILL_CAMERA_MOTION_WORKER_POLICY;
  /**
   * Per-frame Float64 camera trajectory from the shared TypeScript planner
   * (cameraMotionTrajectory). The worker renders exactly these states.
   */
  trajectory: Array<{ zoom: number; centerX: number; centerY: number }>;
}

export interface StillCameraWarpResult {
  rawPath: string;
  frames: number;
  width: number;
  height: number;
  sourceWidth: number;
  sourceHeight: number;
  cv2Version: string;
  interpolation: string;
  precision: string;
  /** Caller-owned temp resources that must be removed after ffmpeg consumes them. */
  cleanup: string[];
}

/**
 * Render one moving-still segment's raw rgb24 frames through the NumPy
 * Float64 Lanczos worker. Throws StillCameraCapabilityError when the worker
 * or its image dependencies are missing — before any output is produced.
 */
export async function renderStillCameraWarp(
  request: StillCameraWarpRequest,
  opts: StillCameraProbeOptions = {},
): Promise<StillCameraWarpResult> {
  const capability = opts.capability?.ok
    ? opts.capability
    : await requireStillCameraCapability(opts);
  if (!capability.ok || !capability.pythonBinary || !capability.workerPath) {
    throw new StillCameraCapabilityError("still_camera_capability_missing:worker_unresolved");
  }
  const cwd = opts.cwd ?? process.cwd();
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "vos-still-warp-"));
  // Signal-safe (Issue 33): if the OS kills the process mid-warp, the
  // registry removes this directory synchronously — a JS finally cannot.
  registerRenderCleanupPath(workDir, "dir");
  const requestPath = path.join(workDir, "request.json");
  const rawPath = path.join(workDir, "frames.rgb24");
  fs.writeFileSync(requestPath, JSON.stringify(request), "utf8");
  const timeoutMs = opts.timeoutMs ?? 120_000;
  let result: WorkerResult;
  try {
    result = await runWorkerJson(
      capability.pythonBinary,
      capability.workerPath,
      ["warp", "--request", requestPath, "--output", rawPath],
      timeoutMs,
    );
  } catch (error) {
    fs.rmSync(workDir, { recursive: true, force: true });
    unregisterRenderCleanupPath(workDir);
    throw error;
  }
  if (!result.ok) {
    fs.rmSync(workDir, { recursive: true, force: true });
    unregisterRenderCleanupPath(workDir);
    throw new StillCameraCapabilityError(
      `still_camera_worker_warp_failed:${result.error ?? "unknown"}`,
      "still_camera_worker_warp_failed",
    );
  }
  const sourceWidth = result.source_width;
  const sourceHeight = result.source_height;
  if (result.frames !== request.frame_count || result.width !== request.window.width
    || result.height !== request.window.height || typeof sourceWidth !== "number"
    || typeof sourceHeight !== "number" || !Number.isInteger(sourceWidth)
    || !Number.isInteger(sourceHeight) || sourceWidth < 1 || sourceHeight < 1
    || result.policy !== request.policy
    || result.interpolation !== "lanczos4" || result.precision !== "float64"
    || result.fps?.num !== request.fps.num || result.fps?.den !== request.fps.den) {
    fs.rmSync(workDir, { recursive: true, force: true });
    unregisterRenderCleanupPath(workDir);
    throw new StillCameraCapabilityError(
      `still_camera_worker_output_mismatch:${result.frames}x${result.width}x${result.height}`,
      "still_camera_worker_output_mismatch",
    );
  }
  return {
    rawPath,
    frames: result.frames!,
    width: result.width!,
    height: result.height!,
    sourceWidth,
    sourceHeight,
    cv2Version: result.cv2_version ?? "unknown",
    interpolation: result.interpolation ?? "lanczos4",
    precision: result.precision ?? "float64",
    cleanup: [workDir],
  };
}
