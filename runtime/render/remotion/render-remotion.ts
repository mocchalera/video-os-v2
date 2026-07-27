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
  REMOTION_OVERLAY_COMPOSITION_ID,
  timelineToCompositionProps,
} from "./timeline-to-props.js";
import type { CreativeCompositeStage } from "../../content/types.js";
import {
  frameRateRatio,
  rationalFrameRate,
  type RationalFrameRate,
} from "../../../editor/shared/rational-timebase.js";
import {
  assertAlphaLayerMediaContract,
  probeAlphaLayerMedia,
  type AlphaLayerMediaContract,
  type ProbeAlphaLayerMedia,
} from "../alpha-layer-contract.js";

export const REMOTION_RENDERER_VERSION = "4.0.452";

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
  fpsNum: number;
  fpsDen: number;
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

export interface RenderRemotionLayerOptions {
  timelinePath: string;
  outputDir: string;
  compositeStage: CreativeCompositeStage;
  elementIds?: string[];
  /** Optional bundle cache dir; default = temp dir outside the worktree. */
  bundleCacheDir?: string;
  probeAlphaLayerImpl?: ProbeAlphaLayerMedia;
}

export interface RenderRemotionLayerResult {
  overlayPath: string;
  receiptPath: string;
  durationInFrames: number;
  fps: number;
  fpsNum: number;
  fpsDen: number;
  width: number;
  height: number;
  elementCount: number;
  layerCacheHit: boolean;
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

/** Replace Remotion's decimal FFmpeg rate operands with timeline identity. */
export function preserveRemotionFfmpegFrameRate(
  args: string[],
  rate: RationalFrameRate,
): string[] {
  const ratio = frameRateRatio(rate);
  const rewritten = [...args];
  for (let index = 0; index < rewritten.length - 1; index++) {
    if (rewritten[index] === "-r" || rewritten[index] === "-framerate") {
      rewritten[index + 1] = ratio;
    }
  }
  return rewritten;
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

const REMOTION_ASSEMBLY_CACHE_VERSION = "remotion-base/v3-layer-split-rational-timebase";

function stripClipCaptions<T extends Record<string, unknown>>(clip: T): Omit<T, "captions"> {
  const { captions: _captions, ...base } = clip;
  return base;
}

function filterTimelineForRemotionBase(timeline: TimelineIR): TimelineIR {
  const tracks = timeline.tracks as TimelineIR["tracks"] & {
    overlay?: TimelineIR["tracks"]["video"];
  };
  const overlay = (tracks.overlay ?? []).map((track) => ({
    ...track,
    clips: track.clips.filter((clip) => {
      const normalized = normalizeOverlayClipContent(clip);
      return normalized.renderer_owner === "remotion" &&
        normalized.element?.creative_recipe?.requires_base_frame === true;
    }),
  })).filter((track) => track.clips.length > 0);
  return {
    ...timeline,
    tracks: {
      ...timeline.tracks,
      overlay,
    },
  } as TimelineIR;
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
  const baseTimeline = filterTimelineForRemotionBase(timeline);
  const tracks = baseTimeline.tracks as TimelineIR["tracks"] & {
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
    sequence: baseTimeline.sequence,
    video: baseTimeline.tracks.video.map((track) => ({
      ...track,
      clips: track.clips.map((clip) => stripClipCaptions(clip as unknown as Record<string, unknown>)),
    })),
    audio: baseTimeline.tracks.audio.map((track) => ({
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

const REMOTION_LAYER_CONTRACT_VERSION = "remotion-alpha-layer/v2";

function remotionLayerBasename(stage: CreativeCompositeStage): string {
  return `remotion-${stage.replace("_", "-")}`;
}

function filterTimelineForRemotionLayer(
  timeline: TimelineIR,
  stage: CreativeCompositeStage,
  requestedElementIds?: string[],
): { timeline: TimelineIR; elementIds: string[] } {
  const requested = requestedElementIds ? new Set(requestedElementIds) : undefined;
  const tracks = timeline.tracks as TimelineIR["tracks"] & {
    overlay?: TimelineIR["tracks"]["video"];
  };
  const elementIds: string[] = [];
  const overlay = (tracks.overlay ?? []).map((track) => ({
    ...track,
    clips: track.clips.filter((clip) => {
      const normalized = normalizeOverlayClipContent(clip);
      if (normalized.renderer_owner !== "remotion") return false;
      const recipe = normalized.element?.creative_recipe;
      if (recipe?.requires_base_frame === true) return false;
      if ((recipe?.composite_stage ?? "under_caption") !== stage) return false;
      const elementId = normalized.element?.element_id ?? clip.clip_id;
      if (requested && !requested.has(elementId)) return false;
      elementIds.push(elementId);
      return true;
    }),
  })).filter((track) => track.clips.length > 0);
  return {
    timeline: {
      ...timeline,
      tracks: {
        ...timeline.tracks,
        overlay,
      },
    } as TimelineIR,
    elementIds,
  };
}

export function createRemotionLayerFingerprint(
  timeline: TimelineIR,
  stage: CreativeCompositeStage,
  elementIds?: string[],
): string {
  const selected = filterTimelineForRemotionLayer(timeline, stage, elementIds);
  const props = timelineToCompositionProps(selected.timeline, {});
  const tracks = selected.timeline.tracks as TimelineIR["tracks"] & {
    overlay?: TimelineIR["tracks"]["video"];
  };
  return createHash("sha256").update(JSON.stringify({
    version: REMOTION_LAYER_CONTRACT_VERSION,
    sequence: selected.timeline.sequence,
    duration_in_frames: props.durationInFrames,
    composite_stage: stage,
    element_ids: selected.elementIds,
    overlays: tracks.overlay ?? [],
  })).digest("hex");
}

export async function readValidRemotionLayerCache(input: {
  overlayPath: string;
  receiptPath: string;
  fingerprint: string;
  expected: {
    width: number;
    height: number;
    fpsNum: number;
    fpsDen: number;
    durationFrames: number;
  };
  probeAlphaLayerImpl?: ProbeAlphaLayerMedia;
}): Promise<RenderRemotionLayerResult | undefined> {
  if (!existsSync(input.overlayPath) || !existsSync(input.receiptPath)) return undefined;
  try {
    const overlayStat = lstatSync(input.overlayPath);
    const receiptStat = lstatSync(input.receiptPath);
    if (
      overlayStat.isSymbolicLink() ||
      !overlayStat.isFile() ||
      overlayStat.size <= 0 ||
      receiptStat.isSymbolicLink() ||
      !receiptStat.isFile()
    ) return undefined;
    const receipt = JSON.parse(readFileSync(input.receiptPath, "utf8")) as {
      version?: unknown;
      renderer_version?: unknown;
      fingerprint?: unknown;
      overlay_sha256?: unknown;
      media?: AlphaLayerMediaContract;
      result?: RenderRemotionLayerResult;
    };
    if (
      receipt.version !== "remotion-layer-receipt/v2"
      || receipt.renderer_version !== REMOTION_RENDERER_VERSION
      || receipt.fingerprint !== input.fingerprint
      || receipt.overlay_sha256 !== sha256FileHex(input.overlayPath)
      || !receipt.result
      || !receipt.media
    ) return undefined;
    const liveMedia = await (input.probeAlphaLayerImpl ?? probeAlphaLayerMedia)(
      input.overlayPath,
    );
    assertAlphaLayerMediaContract(liveMedia, input.expected);
    if (JSON.stringify(liveMedia) !== JSON.stringify(receipt.media)) return undefined;
    return receipt.result;
  } catch {
    return undefined;
  }
}

/**
 * Render a transparent, renderer-owned Remotion layer. This path never stages
 * or decodes base media; FFmpeg owns the only base/layer/caption composite.
 */
export async function renderRemotionContentLayer(
  opts: RenderRemotionLayerOptions,
): Promise<RenderRemotionLayerResult | null> {
  const timeline = JSON.parse(readFileSync(opts.timelinePath, "utf-8")) as TimelineIR;
  const selected = filterTimelineForRemotionLayer(
    timeline,
    opts.compositeStage,
    opts.elementIds,
  );
  if (selected.elementIds.length === 0) return null;

  const basename = remotionLayerBasename(opts.compositeStage);
  const videoDir = path.join(opts.outputDir, "video");
  const logsDir = path.join(opts.outputDir, "logs");
  const overlayPath = path.join(videoDir, `${basename}-overlay.webm`);
  const receiptPath = path.join(logsDir, `${basename}-layer-receipt.json`);
  mkdirSync(videoDir, { recursive: true });
  mkdirSync(logsDir, { recursive: true });
  const fingerprint = createRemotionLayerFingerprint(
    timeline,
    opts.compositeStage,
    opts.elementIds,
  );

  const cached = await readValidRemotionLayerCache({
    overlayPath,
    receiptPath,
    fingerprint,
    expected: {
      width: timeline.sequence.width,
      height: timeline.sequence.height,
      fpsNum: timeline.sequence.fps_num,
      fpsDen: timeline.sequence.fps_den,
      durationFrames: Math.max(
        ...selected.timeline.tracks.video.flatMap((track) =>
          track.clips.map((clip) => clip.timeline_in_frame + clip.timeline_duration_frames)
        ),
        ...((selected.timeline.tracks as TimelineIR["tracks"] & {
          overlay?: TimelineIR["tracks"]["video"];
        }).overlay ?? []).flatMap((track) =>
          track.clips.map((clip) => clip.timeline_in_frame + clip.timeline_duration_frames)
        ),
      ),
    },
    probeAlphaLayerImpl: opts.probeAlphaLayerImpl,
  });
  if (cached) {
    return {
      ...cached,
      overlayPath,
      receiptPath,
      layerCacheHit: true,
    };
  }

  const publicDir = mkdtempSync(path.join(os.tmpdir(), "vos-remotion-layer-public-"));
  const fontAsset = stageWebFontAssets(
    publicDir,
    remotionTimelineFontStrings(selected.timeline),
  );
  const compositionProps = timelineToCompositionProps(
    selected.timeline,
    {},
    fontAsset,
  );
  const frameRate = rationalFrameRate(compositionProps.fpsNum, compositionProps.fpsDen);
  const fontSizeBytes = statSync(fontAsset.fontPath).size;
  const entryPoint = fileURLToPath(new URL("./entry.tsx", import.meta.url));
  const outDir = opts.bundleCacheDir
    ?? mkdtempSync(path.join(os.tmpdir(), "vos-remotion-layer-bundle-"));

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
    id: REMOTION_OVERLAY_COMPOSITION_ID,
    inputProps: compositionProps.defaultProps,
  });
  await renderMedia({
    composition,
    serveUrl: bundleLocation,
    codec: "vp9",
    audioCodec: null,
    muted: true,
    imageFormat: "png",
    pixelFormat: "yuva420p",
    outputLocation: overlayPath,
    inputProps: compositionProps.defaultProps,
    ffmpegOverride: ({ args }) => preserveRemotionFfmpegFrameRate(args, frameRate),
  });
  const media = await (opts.probeAlphaLayerImpl ?? probeAlphaLayerMedia)(overlayPath);
  assertAlphaLayerMediaContract(media, {
    width: composition.width,
    height: composition.height,
    fpsNum: frameRate.fpsNum,
    fpsDen: frameRate.fpsDen,
    durationFrames: composition.durationInFrames,
  });

  const result: RenderRemotionLayerResult = {
    overlayPath,
    receiptPath,
    durationInFrames: composition.durationInFrames,
    fps: composition.fps,
    fpsNum: frameRate.fpsNum,
    fpsDen: frameRate.fpsDen,
    width: composition.width,
    height: composition.height,
    elementCount: selected.elementIds.length,
    layerCacheHit: false,
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
  writeFileSync(receiptPath, `${JSON.stringify({
    version: "remotion-layer-receipt/v2",
    renderer: "remotion",
    renderer_version: REMOTION_RENDERER_VERSION,
    contract_version: REMOTION_LAYER_CONTRACT_VERSION,
    fingerprint,
    timeline_path: path.resolve(opts.timelinePath),
    timeline_sha256: sha256FileHex(opts.timelinePath),
    composite_stage: opts.compositeStage,
    element_ids: selected.elementIds,
    fps_num: frameRate.fpsNum,
    fps_den: frameRate.fpsDen,
    overlay_path: overlayPath,
    overlay_sha256: sha256FileHex(overlayPath),
    media,
    result,
  }, null, 2)}\n`, "utf8");
  return result;
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
  const baseTimeline = filterTimelineForRemotionBase(timeline);
  const { sourceMap, publicDir, fontAsset } = stageSourceMapForRemotion(
    opts.sourceMap,
    opts.timelinePath,
    baseTimeline,
    canonicalInputs,
    opts.onStageSourceForTest,
  );
  const compositionProps = timelineToCompositionProps(baseTimeline, sourceMap, fontAsset, [...canonicalInputs.imageAssetIds].sort());
  const frameRate = rationalFrameRate(compositionProps.fpsNum, compositionProps.fpsDen);
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
    ffmpegOverride: ({ args }) => preserveRemotionFfmpegFrameRate(args, frameRate),
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
    fpsNum: frameRate.fpsNum,
    fpsDen: frameRate.fpsDen,
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
