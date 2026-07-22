import * as path from "node:path";
import * as fs from "node:fs";
import type { RenderRemotionResult } from "./remotion/render-remotion.js";
import { renderRemotionAssembly } from "./remotion/render-remotion.js";
import { assembleTimelineToMp4 } from "./assembler.js";
import {
  createSourceInputAttestation,
  writeRenderFreshnessMetadata,
} from "./source-input-attestation.js";

export type AssemblyEngine = "remotion" | "ffmpeg";

export interface ProduceAssemblyOptions {
  timelinePath: string;
  sourceMap: Record<string, string>;
  outputPath: string;
  engine?: AssemblyEngine;
  bundleCacheDir?: string;
}

export interface ProduceAssemblyResult {
  assemblyPath: string;
  engine: AssemblyEngine;
}

export function resolveAssemblyEngine(
  optsEngine: AssemblyEngine | undefined,
): AssemblyEngine | null {
  if (optsEngine === "remotion" || optsEngine === "ffmpeg") return optsEngine;
  const env = process.env.VOS_RENDER_ENGINE;
  if (env === "remotion" || env === "ffmpeg") return env;
  return null;
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
  });
  const timeline = JSON.parse(fs.readFileSync(opts.timelinePath, "utf8")) as {
    sequence?: { fps_den?: number };
    tracks?: { audio?: Array<{ clips?: unknown[] }> };
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
  });
  writeRenderFreshnessMetadata(projectDir, result.outputPath, {
    sourceInputsBefore,
    sourceOverrides: opts.sourceMap,
  });
  return { assemblyPath: result.outputPath, engine: "ffmpeg" };
}
