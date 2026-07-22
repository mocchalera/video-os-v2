import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  lstatSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { bundle } from "@remotion/bundler";
import { renderMedia, selectComposition } from "@remotion/renderer";
import type { TimelineIR } from "../../compiler/types.js";
import { assertTimelineRenderSupported } from "../media-kind-guard.js";
import {
  materializeVerifiedStillSnapshots,
  resolveCanonicalRenderInputs,
  type CanonicalRenderInputSet,
} from "../canonical-render-input.js";
import { assertSourceInputsUnchanged, createSourceInputAttestation } from "../source-input-attestation.js";
import { sha256FileHex } from "../../source-content-identity.js";
import { normalizeOverlayClipContent } from "../../content/normalize.js";
import {
  collectWebFontStrings,
  stageWebFontAssets,
  type StagedWebFontAsset,
} from "../../fonts/web-font-subset.js";
import { getOverlayText } from "./styles/overlay-presets.js";
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
  /** Test-only observation seam; cannot replace the canonical snapshot copy. */
  onStageSourceForTest?: (phase: "before" | "after", source: string, destination: string) => void;
}

export interface RenderRemotionResult {
  assemblyPath: string;
  durationInFrames: number;
  fps: number;
  width: number;
  height: number;
  /** True when an unchanged base assembly was reused. */
  assemblyCacheHit: boolean;
  font: {
    mode: StagedWebFontAsset["mode"];
    format: StagedWebFontAsset["format"];
    sha256: string;
    sourceSha256: string;
    sizeBytes: number;
    characterCount: number;
    cacheHit: boolean;
  };
}

interface RemotionAssemblyCacheReceipt {
  version: "remotion-assembly-cache/v2";
  fingerprint: string;
  output: {
    contentSha256: string;
    sizeBytes: number;
  };
  result: RenderRemotionResult;
}

const REMOTION_ASSEMBLY_CACHE_VERSION = "remotion-base/v1";

function stripClipCaptions<T extends Record<string, unknown>>(clip: T): Omit<T, "captions"> {
  const { captions: _captions, ...base } = clip;
  return base;
}

/**
 * Hash only inputs that the base Remotion composition actually renders.
 * Speech captions and HyperFrames-owned overlays are deliberately excluded,
 * so those finishing-only changes can reuse the expensive base assembly.
 */
export function createRemotionAssemblyFingerprint(
  timeline: TimelineIR,
  sourceMap: Record<string, string>,
  timelinePath: string,
  canonicalInputs?: CanonicalRenderInputSet,
): string {
  const tracks = timeline.tracks as TimelineIR["tracks"] & {
    overlay?: TimelineIR["tracks"]["video"];
  };
  const remotionOverlayTracks = (tracks.overlay ?? []).map((track) => ({
    ...track,
    clips: track.clips
      .filter((clip) => normalizeOverlayClipContent(clip).renderer_owner === "remotion")
      .map((clip) => stripClipCaptions(clip as unknown as Record<string, unknown>)),
  })).filter((track) => track.clips.length > 0);
  const usedAssetIds = new Set<string>();
  for (const track of [...timeline.tracks.video, ...timeline.tracks.audio]) {
    for (const clip of track.clips) usedAssetIds.add(clip.asset_id);
  }
  const timelineDir = path.dirname(path.resolve(timelinePath));
  const sources = [...usedAssetIds].sort().map((assetId) => {
    const canonical = canonicalInputs?.byAssetId.get(assetId);
    const source = canonical?.renderInputPath ?? sourceMap[assetId];
    if (!source || URL_LIKE_SOURCE.test(source)) return { assetId, source: source ?? null };
    const absolute = path.isAbsolute(source) ? source : path.resolve(timelineDir, source);
    if (!existsSync(absolute)) return { assetId, source: absolute, missing: true };
    const stat = statSync(absolute);
    return {
      assetId,
      source: canonical?.analysisPath ?? absolute,
      size: stat.size,
      ...(canonical ? {} : { mtimeMs: stat.mtimeMs }),
      ...(canonical ? {
        relationship: canonical.relationship,
        contentSha256: canonical.renderInputContentSha256,
        originalContentSha256: canonical.originalContentSha256,
      } : {}),
    };
  });
  const renderInput = {
    version: REMOTION_ASSEMBLY_CACHE_VERSION,
    sequence: timeline.sequence,
    video: timeline.tracks.video.map((track) => ({
      ...track,
      clips: track.clips.map((clip) => stripClipCaptions(clip as unknown as Record<string, unknown>)),
    })),
    audio: timeline.tracks.audio.map((track) => ({
      ...track,
      clips: track.clips.map((clip) => stripClipCaptions(clip as unknown as Record<string, unknown>)),
    })),
    overlays: remotionOverlayTracks,
    transitions: timeline.transitions ?? [],
    sources,
  };
  return createHash("sha256").update(JSON.stringify(renderInput)).digest("hex");
}

export function readValidRemotionAssemblyCache(
  outputPath: string,
  cachePath: string,
  fingerprint: string,
): RenderRemotionResult | undefined {
  if (!existsSync(outputPath) || !existsSync(cachePath)) return undefined;
  try {
    const outputStat = lstatSync(outputPath);
    if (outputStat.isSymbolicLink() || !outputStat.isFile() || outputStat.size <= 0) return undefined;
    const cached = JSON.parse(readFileSync(cachePath, "utf-8")) as Partial<RemotionAssemblyCacheReceipt>;
    if (cached.version !== "remotion-assembly-cache/v2" || cached.fingerprint !== fingerprint) return undefined;
    if (!cached.output || cached.output.sizeBytes !== outputStat.size ||
      !/^[a-f0-9]{64}$/.test(cached.output.contentSha256)) return undefined;
    if (sha256FileHex(outputPath) !== cached.output.contentSha256) return undefined;
    if (!cached.result || typeof cached.result !== "object") return undefined;
    return cached.result;
  } catch {
    return undefined;
  }
}

export function stageSourceMapForRemotion(
  sourceMap: Record<string, string>,
  timelinePath: string,
  timeline: TimelineIR,
  canonicalInputs: CanonicalRenderInputSet,
  onStageSourceForTest?: RenderRemotionOptions["onStageSourceForTest"],
): { sourceMap: Record<string, string>; publicDir: string; fontAsset: StagedWebFontAsset } {
  const timelineDir = path.dirname(path.resolve(timelinePath));
  const publicDir = mkdtempSync(path.join(os.tmpdir(), "vos-remotion-public-"));
  const mediaDir = path.join(publicDir, "media");
  mkdirSync(mediaDir, { recursive: true });
  const fontAsset = stageWebFontAssets(publicDir, remotionTimelineFontStrings(timeline));

  const effectiveSourceMap = { ...sourceMap };
  for (const [assetId, input] of canonicalInputs.byAssetId) {
    if (input.relationship !== "same_as_original") effectiveSourceMap[assetId] = input.renderInputPath;
  }
  const remotionSourceMap = Object.fromEntries(
    Object.entries(effectiveSourceMap).map(([assetId, source]) => {
      if (URL_LIKE_SOURCE.test(source)) {
        return [assetId, source];
      }

      const absoluteSource = path.isAbsolute(source)
        ? source
        : path.resolve(timelineDir, source);
      const safeAssetId = assetId.replace(/[^a-z0-9_-]/gi, "_").slice(0, 48) || "asset";
      const assetIdHash = createHash("sha256").update(assetId).digest("hex").slice(0, 16);
      const stagedFilename = `${safeAssetId}-${assetIdHash}${path.extname(absoluteSource)}`;
      const stagedPath = path.join(mediaDir, stagedFilename);
      onStageSourceForTest?.("before", absoluteSource, stagedPath);
      copyFileSync(absoluteSource, stagedPath);
      onStageSourceForTest?.("after", absoluteSource, stagedPath);

      return [assetId, `/public/media/${stagedFilename}`];
    }),
  );

  return {
    sourceMap: remotionSourceMap,
    publicDir,
    fontAsset,
  };
}

export function remotionTimelineFontStrings(timeline: TimelineIR): string[] {
  const values: string[] = [];
  const tracks = timeline.tracks as TimelineIR["tracks"] & { overlay?: TimelineIR["tracks"]["video"] };
  for (const track of tracks.overlay ?? []) {
    for (const clip of track.clips) {
      if (normalizeOverlayClipContent(clip).renderer_owner !== "remotion") continue;
      const overlayText = getOverlayText(clip.metadata);
      if (overlayText !== null) values.push(overlayText);
      const metadata = clip.metadata as Record<string, unknown> | undefined;
      collectWebFontStrings(metadata?.content_element, values);
    }
  }
  return values;
}

export async function renderRemotionAssembly(
  opts: RenderRemotionOptions,
): Promise<RenderRemotionResult> {
  const timeline = JSON.parse(readFileSync(opts.timelinePath, "utf-8")) as TimelineIR;
  assertTimelineRenderSupported(timeline, {
    timelinePath: opts.timelinePath,
    sourceLocators: opts.sourceMap,
  });
  const projectDir = path.dirname(path.dirname(path.resolve(opts.timelinePath)));
  const canonicalInputs = materializeVerifiedStillSnapshots(
    resolveCanonicalRenderInputs(timeline, {
      projectDir,
      timelinePath: opts.timelinePath,
      sourceOverrides: opts.sourceMap,
    }),
  );
  try {
  if (canonicalInputs.imageAssetIds.size > 0 && timeline.sequence.fps_den !== 1) {
    throw new Error(`remotion_rational_fps_unsupported_for_still:${timeline.sequence.fps_num}/${timeline.sequence.fps_den}; use ffmpeg assembly`);
  }
  const hasExplicitAudio = timeline.tracks.audio.some((track) => track.clips.length > 0) ||
    typeof timeline.audio_mix?.bgm_asset_id === "string";
  if (canonicalInputs.imageAssetIds.size > 0 && hasExplicitAudio) {
    throw new Error("remotion_explicit_audio_unsupported_for_still; use ffmpeg assembly");
  }
  const sourceInputsBefore = canonicalInputs.imageAssetIds.size > 0 || canonicalInputs.sequenceAssetIds.size > 0
    ? createSourceInputAttestation(projectDir, { timelinePath: opts.timelinePath, sourceOverrides: opts.sourceMap })
    : undefined;
  const cachePath = `${opts.outputPath}.remotion-cache.json`;
  const fingerprint = createRemotionAssemblyFingerprint(timeline, opts.sourceMap, opts.timelinePath, canonicalInputs);
  const cached = readValidRemotionAssemblyCache(opts.outputPath, cachePath, fingerprint);
  if (cached) {
    return { ...cached, assemblyPath: opts.outputPath, assemblyCacheHit: true };
  }
  const { sourceMap, publicDir, fontAsset } = stageSourceMapForRemotion(
    opts.sourceMap,
    opts.timelinePath,
    timeline,
    canonicalInputs,
    opts.onStageSourceForTest,
  );
  const compositionProps = timelineToCompositionProps(timeline, sourceMap, fontAsset, [...canonicalInputs.imageAssetIds].sort());
  const fontSizeBytes = statSync(fontAsset.fontPath).size;
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

  let lastProgressBucket = -1;
  await renderMedia({
    composition,
    serveUrl: bundleLocation,
    codec: "h264",
    audioCodec: canonicalInputs.imageAssetIds.size > 0 ? null : "aac",
    muted: canonicalInputs.imageAssetIds.size > 0,
    imageFormat: "png",
    pixelFormat: "yuv420p",
    outputLocation: opts.outputPath,
    inputProps: compositionProps.defaultProps,
    onProgress: ({ progress }) => {
      const bucket = Math.floor(progress * 10);
      if (bucket > lastProgressBucket) {
        lastProgressBucket = bucket;
        console.log(`[remotion] render ${Math.min(100, bucket * 10)}%`);
      }
    },
  });

  if (sourceInputsBefore) {
    try {
      const sourceInputsAfter = createSourceInputAttestation(projectDir, {
        timelinePath: opts.timelinePath,
        sourceOverrides: opts.sourceMap,
      });
      assertSourceInputsUnchanged(sourceInputsBefore, sourceInputsAfter);
    } catch (error) {
      rmSync(opts.outputPath, { force: true });
      rmSync(cachePath, { force: true });
      throw error;
    }
  }

  const result: RenderRemotionResult = {
    assemblyPath: opts.outputPath,
    durationInFrames: composition.durationInFrames,
    fps: composition.fps,
    width: composition.width,
    height: composition.height,
    assemblyCacheHit: false,
    font: {
      mode: fontAsset.mode,
      format: fontAsset.format,
      sha256: fontAsset.sha256,
      sourceSha256: fontAsset.sourceSha256,
      sizeBytes: fontSizeBytes,
      characterCount: fontAsset.characterCount,
      cacheHit: fontAsset.cacheHit,
    },
  };
  const receipt: RemotionAssemblyCacheReceipt = {
    version: "remotion-assembly-cache/v2",
    fingerprint,
    output: {
      contentSha256: sha256FileHex(opts.outputPath),
      sizeBytes: statSync(opts.outputPath).size,
    },
    result,
  };
  writeFileSync(cachePath, `${JSON.stringify(receipt, null, 2)}\n`, "utf-8");
  return result;
  } finally {
    canonicalInputs.dispose();
  }
}
