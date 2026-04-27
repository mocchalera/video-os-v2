import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { bundle } from "@remotion/bundler";
import { renderMedia, selectComposition } from "@remotion/renderer";
import type { TimelineIR } from "../../compiler/types.js";
import {
  REMOTION_COMPOSITION_ID,
  timelineToCompositionProps,
} from "./timeline-to-props.js";

const URL_LIKE_SOURCE = /^[a-z][a-z0-9+.-]*:/i;

export interface RenderRemotionOptions {
  timelinePath: string;
  sourceMap: Record<string, string>;
  outputPath: string;
  /** Optional bundle cache dir; default = temp dir outside the worktree. */
  bundleCacheDir?: string;
}

export interface RenderRemotionResult {
  assemblyPath: string;
  durationInFrames: number;
  fps: number;
  width: number;
  height: number;
}

function stageSourceMapForRemotion(
  sourceMap: Record<string, string>,
  timelinePath: string,
): { sourceMap: Record<string, string>; publicDir: string } {
  const timelineDir = path.dirname(path.resolve(timelinePath));
  const publicDir = mkdtempSync(path.join(os.tmpdir(), "vos-remotion-public-"));
  const mediaDir = path.join(publicDir, "media");
  mkdirSync(mediaDir, { recursive: true });

  const remotionSourceMap = Object.fromEntries(
    Object.entries(sourceMap).map(([assetId, source]) => {
      if (URL_LIKE_SOURCE.test(source)) {
        return [assetId, source];
      }

      const absoluteSource = path.isAbsolute(source)
        ? source
        : path.resolve(timelineDir, source);
      const stagedFilename = `${assetId.replace(/[^a-z0-9_-]/gi, "_")}${path.extname(
        absoluteSource,
      )}`;
      copyFileSync(absoluteSource, path.join(mediaDir, stagedFilename));

      return [assetId, `/public/media/${stagedFilename}`];
    }),
  );

  return {
    sourceMap: remotionSourceMap,
    publicDir,
  };
}

export async function renderRemotionAssembly(
  opts: RenderRemotionOptions,
): Promise<RenderRemotionResult> {
  const timeline = JSON.parse(readFileSync(opts.timelinePath, "utf-8")) as TimelineIR;
  const { sourceMap, publicDir } = stageSourceMapForRemotion(
    opts.sourceMap,
    opts.timelinePath,
  );
  const compositionProps = timelineToCompositionProps(timeline, sourceMap);
  const entryPoint = fileURLToPath(new URL("./entry.tsx", import.meta.url));
  const outDir =
    opts.bundleCacheDir ??
    mkdtempSync(path.join(os.tmpdir(), "vos-remotion-bundle-"));

  let bundleLocation: string;
  try {
    bundleLocation = await bundle({
      entryPoint,
      outDir,
      publicDir,
      webpackOverride: (currentConfiguration) => ({
        ...currentConfiguration,
        resolve: {
          ...currentConfiguration.resolve,
          extensionAlias: {
            ...currentConfiguration.resolve?.extensionAlias,
            ".js": [".tsx", ".ts", ".js"],
          },
        },
      }),
    });
  } finally {
    rmSync(publicDir, { recursive: true, force: true });
  }

  const composition = await selectComposition({
    serveUrl: bundleLocation,
    id: REMOTION_COMPOSITION_ID,
    inputProps: compositionProps.defaultProps,
  });

  await renderMedia({
    composition,
    serveUrl: bundleLocation,
    codec: "h264",
    imageFormat: "png",
    pixelFormat: "yuv420p",
    outputLocation: opts.outputPath,
    inputProps: compositionProps.defaultProps,
  });

  return {
    assemblyPath: opts.outputPath,
    durationInFrames: composition.durationInFrames,
    fps: composition.fps,
    width: composition.width,
    height: composition.height,
  };
}
