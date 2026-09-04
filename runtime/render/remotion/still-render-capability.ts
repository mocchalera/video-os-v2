import type { TimelineIR } from "../../compiler/types.js";
import {
  resolveStillCameraMotion,
  type StillCameraMotionPlan,
} from "../camera-motion.js";

/**
 * Remotion has no equivalent of the canonical Float64 still-motion worker.
 * Keep this guard in a non-React module so direct callers and tests exercise
 * the same fail-closed capability contract as the composition.
 */
export function resolveStillClipMotion(
  stillImage: TimelineIR["tracks"]["video"][number]["clips"][number]["still_image"],
  frameCount: number,
): StillCameraMotionPlan | undefined {
  if (!stillImage) return undefined;
  const hasPlan = stillImage.camera_motion !== undefined && stillImage.camera_motion !== null;
  const claimsMotion = stillImage.motion_mode === "camera_motion";
  if (claimsMotion && !hasPlan) {
    throw new Error("still_camera_motion_metadata_without_plan");
  }
  if (hasPlan && !claimsMotion) {
    throw new Error(`still_camera_motion_mode_mismatch:${String(stillImage.motion_mode)}`);
  }
  if (hasPlan) {
    // Resolve first so malformed authored plans fail with the same contract
    // error before the renderer-capability error.
    resolveStillCameraMotion(stillImage.camera_motion, frameCount);
    throw new Error(
      "still_camera_motion_remotion_unsupported"
      + ": still_image.camera_motion requires the ffmpeg engine and the"
      + " still-camera-motion/v1 NumPy Float64 Lanczos worker.",
    );
  }
  if (stillImage.transform) {
    throw new Error(
      "still_image_transform_remotion_unsupported"
      + ": still_image.transform requires the ffmpeg still-image lane.",
    );
  }
  return undefined;
}
