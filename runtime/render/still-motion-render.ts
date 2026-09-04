import { execFile as execFileDefault } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import {
  renderStillCameraWarp,
  requireStillCameraCapability,
  type StillCameraProbeOptions,
  type StillCameraWarpResult,
} from "../connectors/still-camera-local.js";
import {
  registerRenderChild,
  registerRenderCleanupPath,
  unregisterRenderCleanupPath,
} from "./render-cleanup-registry.js";
import {
  cameraMotionTrajectory,
  buildStillVerticalStaticFilter,
  type StillCameraFitMode,
  type StillCameraMotionReceipt,
  type StillCameraMotionPlan,
  type VerticalStillComposition,
} from "./camera-motion.js";
import { INTERMEDIATE_X264 } from "../../editor/shared/encode-profiles.js";

/**
 * Canonical render path for moving stills (Issue 33 — still-camera-motion/v1).
 *
 * Every rendered camera-motion frame comes from the dedicated NumPy worker:
 * Float64 coordinate evaluation with a Lanczos kernel (OpenCV is used only for
 * image decode/color conversion). This module is the single integration point
 * shared by the standalone final assembly, the transition-chain pre-render,
 * and the canonical preview, so all three produce identical moving-still
 * pixels by construction.
 *
 * Fail-closed: a requested camera move without worker capability throws an
 * explicit StillCameraCapabilityError before any output file is created.
 * There is no integer-pixel (zoompan) fallback lane anywhere in the repo.
 */

export type ExecFileLike = (
  file: string,
  args: readonly string[],
  options: { maxBuffer?: number },
  callback: (err: (Error & { code?: string | number | null }) | null, stdout?: string | Buffer, stderr?: string | Buffer) => void,
) => void;

const defaultExecFile: ExecFileLike = execFileDefault as unknown as ExecFileLike;

function runFfmpeg(execFileImpl: ExecFileLike, ffmpegBin: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = execFileImpl(
      ffmpegBin,
      args,
      { maxBuffer: 64 * 1024 * 1024 },
      (err, _stdout, stderr) => {
        if (err) {
          reject(new Error(`ffmpeg_failed:${String(stderr ?? err.message).trim().slice(-400)}`));
          return;
        }
        resolve();
      },
    ) as unknown as ChildProcess | undefined;
    registerRenderChild(child, `ffmpeg:${ffmpegBin}`);
  });
}

export interface StillMotionSegmentOptions extends StillCameraProbeOptions {
  execFileImpl?: ExecFileLike;
  ffmpegBin?: string;
  /** Verified still image source. */
  inputPath: string;
  outputPath: string;
  frameCount: number;
  /** Canvas/window geometry (fg window for the vertical composition). */
  width: number;
  height: number;
  fpsRational: string;
  motion: StillCameraMotionPlan;
  composition?: VerticalStillComposition;
  /** Fit policy applied directly from source pixels by the worker. */
  fitMode?: StillCameraFitMode;
  /** Existing still-image background token used for contain letterbox pixels. */
  background?: string;
  /** Canonical identity/hold receipt fields for the timeline instance. */
  clipId?: string;
  sourceStillId?: string;
  stillInstanceId?: string;
  hold?: StillCameraMotionReceipt["hold"];
  /** Prefix frame in the original plan to render (preview truncation uses 0). */
  motionFrameOffset?: number;
  /** Test seam for reporting a cleanup failure without changing fs state. */
  removePathImpl?: (target: string, options: { recursive?: boolean; force?: boolean }) => void;
}

/**
 * Render one moving-still segment (optionally composited over a blurred
 * backdrop) to a lossless intermediate mp4. Motion frames are warped by the
 * NumPy Float64 Lanczos worker; encode/composite run in ffmpeg with qp=0 so
 * pixels entering any downstream xfade or preview concat are identical across
 * paths.
 */
export async function renderStillMotionSegment(opts: StillMotionSegmentOptions): Promise<StillCameraMotionReceipt> {
  const {
    inputPath, outputPath, frameCount, width, height, fpsRational, motion, composition,
  } = opts;
  if (!Number.isInteger(frameCount) || frameCount < 1) {
    throw new Error(`still_camera_motion_frame_count_invalid:${String(frameCount)}`);
  }
  const execFileImpl = opts.execFileImpl ?? defaultExecFile;
  const ffmpegBin = opts.ffmpegBin ?? "ffmpeg";
  const fpsParts = /^([1-9]\d*)\/([1-9]\d*)$/.exec(fpsRational);
  if (!fpsParts) throw new Error(`still_camera_motion_fps_invalid:${fpsRational}`);
  const fps = { num: Number(fpsParts[1]), den: Number(fpsParts[2]) };
  if (!Number.isSafeInteger(fps.num) || !Number.isSafeInteger(fps.den)) {
    throw new Error(`still_camera_motion_fps_invalid:${fpsRational}`);
  }

  const motionFrameOffset = opts.motionFrameOffset ?? 0;
  if (!Number.isInteger(motionFrameOffset) || motionFrameOffset < 0) {
    throw new Error(`still_camera_motion_frame_offset_invalid:${String(motionFrameOffset)}`);
  }

  // Canonical Float64 plan math stays in TypeScript: the worker renders
  // exactly this trajectory, serialized at full double precision. A preview
  // may request only a prefix of the original plan; it must not re-time the
  // easing curve over the shorter output duration.
  const trajectory = cameraMotionTrajectory(motion);
  const trajectoryEnd = motionFrameOffset + frameCount;
  if (trajectoryEnd > trajectory.length) {
    throw new Error(`still_camera_motion_trajectory_length_mismatch:${trajectory.length}<${trajectoryEnd}`);
  }
  const outputTrajectory = trajectory.slice(motionFrameOffset, trajectoryEnd);

  // Capability preflight FIRST — before any temp directory, base image, or
  // output file exists. A missing worker/cv2 must leave zero side effects.
  const capability = await requireStillCameraCapability(opts);

  // With the vertical composition the camera window is the square foreground;
  // without it, the window is the full canvas.
  const warpWindow = composition
    ? { width: composition.fgSize, height: composition.fgSize }
    : { width, height };

  // Own the requested output before the worker starts. If worker setup or
  // source decoding fails, a pre-existing/partial output is still covered by
  // the same exact-path cleanup contract.
  let outputRegistered = false;
  let warp: StillCameraWarpResult | undefined;
  let receipt: StillCameraMotionReceipt | undefined;
  let primaryError: unknown;
  const partialFailures: string[] = [];
  const removePath = opts.removePathImpl ?? ((target: string, options: { recursive?: boolean; force?: boolean }) => {
    fs.rmSync(target, options);
  });
  const cleanupOwnedPath = (
    target: string,
    kind: "dir" | "file",
  ): void => {
    try {
      removePath(target, kind === "dir" ? { recursive: true, force: true } : { force: true });
      unregisterRenderCleanupPath(target);
    } catch (error) {
      // Keep the registry entry when deletion failed: a later signal or retry
      // must still own the exact path, and the caller must see the failure.
      partialFailures.push(`${kind}:${target}:${String(error)}`);
    }
  };
  try {
    registerRenderCleanupPath(outputPath, "file");
    outputRegistered = true;
    warp = await renderStillCameraWarp({
      input: inputPath,
      window: warpWindow,
      fps,
      fit_mode: opts.fitMode ?? "cover",
      background: opts.background ?? "black",
      frame_count: frameCount,
      policy: "still-camera-motion/v1",
      trajectory: outputTrajectory,
    }, { ...opts, capability });
    if (warp.interpolation !== "lanczos4" || warp.precision !== "float64") {
      throw new Error(
        `still_camera_motion_worker_precision_invalid:${warp.interpolation}/${warp.precision}`,
      );
    }
    receipt = {
      backend: "numpy_float64_lanczos_worker",
      interpolation: "lanczos4",
      precision: "float64",
      source_dimensions: { width: warp.sourceWidth, height: warp.sourceHeight },
      output_dimensions: { width, height },
      fps,
      duration_frames: frameCount,
      ...(opts.clipId ? { clip_id: opts.clipId } : {}),
      ...(opts.sourceStillId ? { source_still_id: opts.sourceStillId } : {}),
      ...(opts.stillInstanceId ? { still_instance_id: opts.stillInstanceId } : {}),
      ...(motion.transform ? { transform: motion.transform } : {}),
      ...(motion.parallax ? { parallax: motion.parallax } : {}),
      ...(opts.hold ? { hold: opts.hold } : {}),
    };

    const rawInput = [
      "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", `${warpWindow.width}x${warpWindow.height}`,
      "-r", fpsRational, "-i", warp.rawPath,
    ];
    if (composition) {
      const filterComplex = [
        "[1:v]scale=" + composition.width + ":" + composition.height
          + ":force_original_aspect_ratio=increase:flags=lanczos,crop="
          + composition.width + ":" + composition.height
          + ",gblur=sigma=" + composition.blurSigma + ":steps=2[bgd]",
        // The blurred backdrop is the overlay base so the composite is
        // full-canvas; the warped foreground lands at the registered Y anchor.
        `[bgd][0:v]overlay=0:${composition.fgY}:format=auto,format=yuv420p,setsar=1[vout]`,
      ].join(";");
      await runFfmpeg(execFileImpl, ffmpegBin, [
        "-y", ...rawInput,
        // The backdrop input must be looped at the explicit sequence cadence:
        // an unlooped single-image input lets the output -r resampler
        // duplicate/drop foreground frames mid-segment (verified ±1 frame).
        "-loop", "1", "-framerate", fpsRational, "-i", inputPath,
        "-map", "[vout]", "-filter_complex", filterComplex,
        "-frames:v", String(frameCount), "-an",
        "-fps_mode", "cfr",
        "-c:v", "libx264", "-preset", INTERMEDIATE_X264.preset, "-qp", "0",
        "-pix_fmt", "yuv420p", outputPath,
      ]);
    } else {
      await runFfmpeg(execFileImpl, ffmpegBin, [
        "-y", ...rawInput,
        "-map", "0:v:0",
        "-frames:v", String(frameCount), "-an", "-r", fpsRational, "-fps_mode", "cfr",
        "-c:v", "libx264", "-preset", INTERMEDIATE_X264.preset, "-qp", "0",
        "-pix_fmt", "yuv420p", outputPath,
      ]);
    }
  } catch (error) {
    primaryError = error;
  } finally {
    // Recover every task-owned temp regardless of where this failed. A
    // requested output is removed only on failure; on success it remains for
    // the caller and its ownership is retired after the render completes.
    if (outputRegistered) {
      if (primaryError !== undefined) cleanupOwnedPath(outputPath, "file");
      else unregisterRenderCleanupPath(outputPath);
    }
    if (warp) {
      for (const dir of warp.cleanup) {
        cleanupOwnedPath(dir, "dir");
      }
    }
  }
  if (primaryError !== undefined) {
    if (partialFailures.length > 0) {
      const primaryMessage = primaryError instanceof Error ? primaryError.message : String(primaryError);
      throw new Error(
        `${primaryMessage}; still_camera_cleanup_failed:${partialFailures.join("|")}`,
        { cause: primaryError },
      );
    }
    throw primaryError;
  }
  if (partialFailures.length > 0) {
    throw new Error(`still_camera_cleanup_failed:${partialFailures.join("|")}`);
  }
  if (!receipt) throw new Error("still_camera_motion_receipt_missing");
  return receipt;
}

/** Args for a static vertical blur-backdrop composite (no camera motion). */
export function buildStillVerticalStaticArgs(
  inputPath: string,
  outputPath: string,
  frameCount: number,
  composition: VerticalStillComposition,
  fpsRational: string,
): string[] {
  return [
    "-y", "-loop", "1", "-framerate", fpsRational, "-i", inputPath,
    "-map", "[vout]", "-filter_complex", buildStillVerticalStaticFilter(composition),
    "-frames:v", String(frameCount), "-an", "-r", fpsRational,
    "-c:v", "libx264", "-preset", INTERMEDIATE_X264.preset, "-qp", "0",
    "-pix_fmt", "yuv420p", outputPath,
  ];
}
