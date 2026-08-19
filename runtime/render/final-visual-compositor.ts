import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { INTERMEDIATE_X264, x264Args } from "../../editor/shared/encode-profiles.js";
import { materializeFileSync } from "../filesystem/materialize-file.js";
import {
  assertVisualTemporalCorrespondence,
  measureVisualTemporalCorrespondence,
  writeVisualTemporalCorrespondenceEvidence,
  type VisualCompositeTemporalCorrespondenceResult,
} from "./visual-composite-temporal-qa.js";

export type FinalVisualRenderer = "hyperframes" | "remotion" | "ffmpeg";
export type FinalVisualCompositeStage = "under_caption" | "over_caption";

export interface FinalVisualLayer {
  path: string;
  renderer: FinalVisualRenderer;
  compositeStage: FinalVisualCompositeStage;
  zIndex: number;
  elementIds?: string[];
}

export interface FinalVisualCompositorOptions {
  baseVideoPath: string;
  layers: FinalVisualLayer[];
  assPath?: string;
  fontsDir?: string;
  outputPath: string;
  width: number;
  height: number;
  fpsNum: number;
  fpsDen: number;
  durationFrames?: number;
  /**
   * When true (default for real encodes), fail closed if pre/post composite
   * frame correspondence exceeds the temporal threshold. Unit tests that only
   * inspect argv may leave this unset and skip measurement by not encoding.
   */
  enforceTemporalCorrespondence?: boolean;
  temporalCorrespondenceThresholdFrames?: number;
  temporalCorrespondenceEvidencePath?: string;
}

function escapeFilterValue(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/:/g, "\\:")
    .replace(/'/g, "'\\''");
}

function sortedLayers(layers: FinalVisualLayer[]): FinalVisualLayer[] {
  return [...layers].sort((left, right) =>
    (left.compositeStage === right.compositeStage
      ? left.zIndex - right.zIndex
      : left.compositeStage === "under_caption" ? -1 : 1)
    || left.renderer.localeCompare(right.renderer)
    || left.path.localeCompare(right.path)
  );
}

function fpsFilterExpression(fpsNum: number, fpsDen: number): string {
  return `fps=${fpsNum}/${fpsDen}`;
}

/**
 * Build the single delivery-visual encode. Renderer-owned alpha layers and
 * canonical ASS captions are applied in one filter graph, so adding creative
 * overlays never introduces an additional lossy H.264 generation.
 *
 * Frame-index contract:
 * - Every video input is normalized with `fps=num/den` first so cut
 *   discontinuities cannot collapse or restart PTS segments.
 * - Do NOT use `setpts=PTS-STARTPTS` / `setpts=N/...` here. On assembled bases
 *   with still→motion concat discontinuities those expressions re-init PTS at
 *   segment boundaries and make talking-head content lead by the still length.
 * - Optional end pad uses tpad after fps; exact length is enforced with
 *   `-frames:v` so pad never rewrites earlier frame indices.
 */
export function buildFinalVisualCompositorArgs(
  options: FinalVisualCompositorOptions,
): string[] {
  if (!Number.isInteger(options.width) || options.width <= 0) {
    throw new Error(`Final visual compositor width must be a positive integer: ${options.width}`);
  }
  if (!Number.isInteger(options.height) || options.height <= 0) {
    throw new Error(`Final visual compositor height must be a positive integer: ${options.height}`);
  }
  if (!Number.isInteger(options.fpsNum) || options.fpsNum <= 0 ||
      !Number.isInteger(options.fpsDen) || options.fpsDen <= 0) {
    throw new Error(`Final visual compositor frame rate must be rational integers: ${options.fpsNum}/${options.fpsDen}`);
  }
  if (options.assPath && !options.fontsDir) {
    throw new Error("Final visual compositor requires fontsDir when assPath is present");
  }

  const layers = sortedLayers(options.layers);
  const args = ["-y", "-i", options.baseVideoPath];
  for (const layer of layers) {
    if (path.extname(layer.path).toLowerCase() === ".webm") {
      args.push("-c:v", "libvpx-vp9");
    }
    args.push("-i", layer.path);
  }

  const needsAlphaCompositing = layers.length > 0;
  const fpsExpr = fpsFilterExpression(options.fpsNum, options.fpsDen);
  const baseFilters = [
    fpsExpr,
    // Infinite end pad after fps keeps frame indices stable; -frames:v trims.
    ...(options.durationFrames === undefined
      ? []
      : ["tpad=stop_mode=add:stop=-1:color=black"]),
    ...(needsAlphaCompositing ? ["format=rgba"] : []),
  ];
  // Always retime through the graph when encoding so VFR/discontinuity bases
  // and alpha layers share one frame-index timeline.
  const shouldFilterBase = true;
  const filters: string[] = shouldFilterBase
    ? [`[0:v]${baseFilters.join(",")}[base0]`]
    : [];
  let current = shouldFilterBase ? "base0" : "0:v";
  let underCount = 0;
  let overCount = 0;

  for (const [index, layer] of layers.entries()) {
    const inputIndex = index + 1;
    const layerLabel = `layer${inputIndex}`;
    filters.push(
      `[${inputIndex}:v]${fpsExpr},scale=${options.width}:${options.height}:flags=lanczos,format=rgba[${layerLabel}]`,
    );
    if (layer.compositeStage === "under_caption") {
      underCount += 1;
      const next = `under${underCount}`;
      filters.push(
        `[${current}][${layerLabel}]overlay=eof_action=pass:shortest=0:format=auto[${next}]`,
      );
      current = next;
      continue;
    }
    // Over-caption layers are appended after the ASS stage below.
  }

  if (options.assPath) {
    filters.push(
      `[${current}]subtitles=filename='${escapeFilterValue(options.assPath)}':fontsdir='${escapeFilterValue(options.fontsDir!)}'[captioned]`,
    );
    current = "captioned";
  }

  for (const [index, layer] of layers.entries()) {
    if (layer.compositeStage !== "over_caption") continue;
    const inputIndex = index + 1;
    overCount += 1;
    const next = `over${overCount}`;
    filters.push(
      `[${current}][layer${inputIndex}]overlay=eof_action=pass:shortest=0:format=auto[${next}]`,
    );
    current = next;
  }
  filters.push(`[${current}]format=yuv420p[v]`);

  args.push(
    "-filter_complex", filters.join(";"),
    "-map", "[v]",
    "-an",
    "-r", `${options.fpsNum}/${options.fpsDen}`,
    "-fps_mode", "cfr",
  );
  if (options.durationFrames !== undefined) {
    if (!Number.isInteger(options.durationFrames) || options.durationFrames <= 0) {
      throw new Error(`Final visual compositor durationFrames must be a positive integer: ${options.durationFrames}`);
    }
    args.push("-frames:v", String(options.durationFrames));
  }
  args.push(
    ...x264Args(INTERMEDIATE_X264),
    "-pix_fmt", "yuv420p",
    options.outputPath,
  );
  return args;
}

export interface ComposeFinalVisualsResult {
  outputPath: string;
  temporalCorrespondence?: VisualCompositeTemporalCorrespondenceResult;
  temporalCorrespondenceEvidencePath?: string;
}

export async function composeFinalVisuals(
  options: FinalVisualCompositorOptions,
): Promise<string> {
  const result = await composeFinalVisualsWithEvidence(options);
  return result.outputPath;
}

export async function composeFinalVisualsWithEvidence(
  options: FinalVisualCompositorOptions,
): Promise<ComposeFinalVisualsResult> {
  fs.mkdirSync(path.dirname(options.outputPath), { recursive: true });
  if (options.layers.length === 0 && !options.assPath && options.durationFrames === undefined) {
    materializeFileSync(options.baseVideoPath, options.outputPath);
    return { outputPath: options.outputPath };
  }

  const args = buildFinalVisualCompositorArgs(options);
  await new Promise<void>((resolve, reject) => {
    execFile("ffmpeg", args, { maxBuffer: 100 * 1024 * 1024 }, (error, _stdout, stderr) => {
      if (error) {
        reject(new Error(`Final visual compositor failed: ${stderr || error.message}`));
        return;
      }
      resolve();
    });
  });

  const enforce = options.enforceTemporalCorrespondence !== false
    && (options.layers.length > 0 || options.durationFrames !== undefined || Boolean(options.assPath));
  if (!enforce) {
    return { outputPath: options.outputPath };
  }

  let temporalCorrespondence;
  try {
    temporalCorrespondence = await measureVisualTemporalCorrespondence({
      baseVideoPath: options.baseVideoPath,
      outputVideoPath: options.outputPath,
      thresholdFrames: options.temporalCorrespondenceThresholdFrames,
    });
  } catch (error) {
    // Probe infrastructure failures on degenerate fixtures must not mask encode
    // success, but real offset failures still fail closed below.
    throw new Error(
      `Final visual compositor temporal correspondence probe failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  const evidencePath = options.temporalCorrespondenceEvidencePath
    ?? `${options.outputPath}.temporal-correspondence.json`;
  writeVisualTemporalCorrespondenceEvidence(temporalCorrespondence, evidencePath);
  if (!temporalCorrespondence.skipped) {
    assertVisualTemporalCorrespondence(temporalCorrespondence);
  }
  return {
    outputPath: options.outputPath,
    temporalCorrespondence,
    temporalCorrespondenceEvidencePath: evidencePath,
  };
}
