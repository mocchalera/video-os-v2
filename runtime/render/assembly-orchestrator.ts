import * as path from "node:path";
import type { RenderRemotionResult } from "./remotion/render-remotion.js";
import { renderRemotionAssembly } from "./remotion/render-remotion.js";
import { assembleTimelineToMp4 } from "./assembler.js";

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
  const engine = resolveAssemblyEngine(opts.engine);
  if (!engine) {
    throw new Error(
      "No assembly engine resolved. Set opts.engine or VOS_RENDER_ENGINE to 'remotion' or 'ffmpeg'.",
    );
  }
  if (engine === "remotion") {
    const result: RenderRemotionResult = await renderRemotionAssembly({
      timelinePath: opts.timelinePath,
      sourceMap: opts.sourceMap,
      outputPath: opts.outputPath,
      bundleCacheDir: opts.bundleCacheDir,
    });
    return { assemblyPath: result.assemblyPath, engine: "remotion" };
  }
  // ffmpeg engine: deterministic ffmpeg assembler that shares the preview
  // filtergraph builders (FATAL-1 parity path). The timeline lives at
  // <project>/05_timeline/timeline.json, so the project root is two up.
  const projectDir = path.dirname(path.dirname(path.resolve(opts.timelinePath)));
  const result = await assembleTimelineToMp4({
    projectDir,
    timelinePath: opts.timelinePath,
    outputPath: opts.outputPath,
    sourceOverrides: opts.sourceMap,
  });
  return { assemblyPath: result.outputPath, engine: "ffmpeg" };
}
