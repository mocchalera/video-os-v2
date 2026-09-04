import * as path from "node:path";
import * as fs from "node:fs";
import type { RenderRemotionResult } from "./remotion/render-remotion.js";
import { renderRemotionAssembly } from "./remotion/render-remotion.js";
import { assembleTimelineToMp4 } from "./assembler.js";
import {
  createSourceInputAttestation,
  writeRenderFreshnessMetadata,
} from "./source-input-attestation.js";
import { assertMediaWriteReady } from "../system/media-write-doctor.js";
import type { StillCameraMotionReceipt } from "./camera-motion.js";

export type AssemblyEngine = "remotion" | "ffmpeg";

export interface ProduceAssemblyOptions {
  timelinePath: string;
  sourceMap: Record<string, string>;
  outputPath: string;
  engine?: AssemblyEngine;
  bundleCacheDir?: string;
  /**
   * Shared AudioRenderPlan owns A1/A2 when false. The picture assembly must
   * then remain video-only so pinned A2 cannot be mixed and finished early.
   */
  includeAudio?: boolean;
  assertMediaWriteReadyImpl?: typeof assertMediaWriteReady;
}

export interface ProduceAssemblyResult {
  assemblyPath: string;
  engine: AssemblyEngine;
  still_camera_motion?: StillCameraMotionReceipt[];
}

export function resolveAssemblyEngine(
  optsEngine: AssemblyEngine | undefined,
): AssemblyEngine | null {
  if (optsEngine === "remotion" || optsEngine === "ffmpeg") return optsEngine;
  const env = process.env.VOS_RENDER_ENGINE;
  if (env === "remotion" || env === "ffmpeg") return env;
  return null;
}

/**
 * True when any video clip carries executable still camera motion — either a
 * claimed `camera_motion` mode or an authored plan. Authored-but-invalid
 * blocks are intentionally NOT caught here: the contract validators in the
 * render lanes own those errors; this preflight only routes engines.
 */
export function timelineHasCameraMotionStill(timeline: {
  tracks?: {
    video?: Array<{
      clips?: Array<{ still_image?: { motion_mode?: string; camera_motion?: unknown } }>;
    }>;
  };
}): boolean {
  return (timeline.tracks?.video ?? []).some((track) =>
    (track.clips ?? []).some((clip) => {
      const still = clip.still_image;
      if (!still) return false;
      return still.motion_mode === "camera_motion"
        || (still.camera_motion !== undefined && still.camera_motion !== null);
    }),
  );
}

export async function produceAssembly(
  opts: ProduceAssemblyOptions,
): Promise<ProduceAssemblyResult> {
  let engine = resolveAssemblyEngine(opts.engine);
  if (!engine) {
    throw new Error(
      "No assembly engine resolved. Set opts.engine or VOS_RENDER_ENGINE to 'remotion' or 'ffmpeg'.",
    );
  }
  const projectDir = path.dirname(path.dirname(path.resolve(opts.timelinePath)));
  const sourceInputsBefore = createSourceInputAttestation(projectDir, {
    timelinePath: opts.timelinePath,
    sourceOverrides: opts.sourceMap,
    includeAudio: opts.includeAudio !== false,
  });
  const timeline = JSON.parse(fs.readFileSync(opts.timelinePath, "utf8")) as {
    sequence?: { fps_den?: number };
    tracks?: {
      audio?: Array<{ clips?: unknown[] }>;
      video?: Array<{ clips?: Array<{ still_image?: { motion_mode?: string; camera_motion?: unknown } }> }>;
    };
    audio_mix?: { bgm_asset_id?: unknown };
  };
  const hasStill = sourceInputsBefore.source_inputs.some(
    (entry) => entry.render_input_identity.relationship === "normalized_still_frame",
  );
  const hasExplicitAudio = (timeline.tracks?.audio ?? []).some(
    (track) => (track.clips?.length ?? 0) > 0,
  ) || typeof timeline.audio_mix?.bgm_asset_id === "string";
  if (engine === "remotion" && hasStill &&
    (timeline.sequence?.fps_den !== 1 || hasExplicitAudio)) {
    engine = "ffmpeg";
  }
  if (opts.includeAudio === false) {
    engine = "ffmpeg";
  }
  // Issue 33 preflight gate: still camera motion is executable ONLY through
  // the NumPy Float64 Lanczos worker contract shared by the canonical preview and
  // the ffmpeg final assembler. The Remotion CSS lane has no worker, no
  // capability gate, and no preview/final pixel parity, so a camera-motion
  // timeline is rejected here — before any output is created — instead of
  // silently rendering a non-contract final (or lying by falling back to
  // static). Static stills remain fully supported on Remotion.
  if (engine === "remotion" && timelineHasCameraMotionStill(timeline)) {
    throw new Error(
      "still_camera_motion_remotion_unsupported"
      + ": timeline contains still_image.camera_motion, which the Remotion"
      + " engine cannot render under the still-camera-motion/v1 float64"
      + " worker/capability contract. Use the ffmpeg engine"
      + " (VOS_RENDER_ENGINE=ffmpeg) or provision"
      + " python/requirements-still-camera.txt and drop engine=remotion.",
    );
  }
  if (engine === "remotion") {
    const result: RenderRemotionResult = await renderRemotionAssembly({
      timelinePath: opts.timelinePath,
      sourceMap: opts.sourceMap,
      outputPath: opts.outputPath,
      bundleCacheDir: opts.bundleCacheDir,
    });
    writeRenderFreshnessMetadata(projectDir, result.assemblyPath, {
      sourceInputsBefore,
      sourceOverrides: opts.sourceMap,
    });
    return { assemblyPath: result.assemblyPath, engine: "remotion" };
  }
  // ffmpeg engine: deterministic ffmpeg assembler that shares the preview
  // filtergraph builders (FATAL-1 parity path). The timeline lives at
  // <project>/05_timeline/timeline.json, so the project root is two up.
  const result = await assembleTimelineToMp4({
    projectDir,
    timelinePath: opts.timelinePath,
    outputPath: opts.outputPath,
    sourceOverrides: opts.sourceMap,
    includeAudio: opts.includeAudio,
    legacyCaptionMode: "reject",
    assertMediaWriteReadyImpl: opts.assertMediaWriteReadyImpl,
  });
  writeRenderFreshnessMetadata(projectDir, result.outputPath, {
    sourceInputsBefore,
    sourceOverrides: opts.sourceMap,
  });
  return {
    assemblyPath: result.outputPath,
    engine: "ffmpeg",
    ...(result.still_camera_motion && result.still_camera_motion.length > 0
      ? { still_camera_motion: result.still_camera_motion }
      : {}),
  };
}
