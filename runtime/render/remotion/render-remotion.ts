import {
  appendFileSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { bundle } from "@remotion/bundler";
import { renderMedia, selectComposition } from "@remotion/renderer";
import type { ClipOutput, TimelineIR } from "../../compiler/types.js";
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
import {
  assertRemotionOverlayCapabilities,
  REMOTION_OVERLAY_CAPABILITY_VERSION,
  remotionCapabilityIdentityHash,
} from "./overlay-capability.js";
import {
  resolveRemotionOverlayClip,
  type ResolvedRemotionOverlayClip,
  type ResolvedRemotionOverlayLayout,
} from "./overlay-clip-resolver.js";

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
  /** Content-addressed element media cache, separate from webpack bundles. */
  mediaCacheDir?: string;
  /** Immutable social-review generation consuming the final layer. */
  generationId?: string;
  progressJournalPath?: string;
  progressIntervalFrames?: number;
  progressIntervalMs?: number;
  onProgress?: (event: RemotionLayerProgressEvent) => void;
  probeAlphaLayerImpl?: ProbeAlphaLayerMedia;
  /** Test seam for the deterministic FFmpeg alpha compositor. */
  compositeAlphaLayersImpl?: (input: RemotionAlphaCompositeInput) => Promise<void>;
}

export interface RemotionLayerProgressEvent {
  version: "remotion-alpha-progress/v1";
  phase: "cache" | "rendering" | "compositing" | "complete" | "failed";
  completedFrames: number;
  totalFrames: number;
  elementIds: string[];
  elapsedMs: number;
  cacheState: "checking" | "hit" | "miss" | "compositing" | "complete" | "failed";
}

export interface RemotionAlphaCompositeElement {
  elementId: string;
  path: string;
  fingerprint: string;
}

export interface RemotionAlphaCompositeInput {
  elements: RemotionAlphaCompositeElement[];
  outputPath: string;
  width: number;
  height: number;
  fpsNum: number;
  fpsDen: number;
  durationFrames: number;
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
  bundleIdentity?: string;
  compositeIdentity?: string;
  progressJournalPath?: string;
  elementCache?: {
    total: number;
    hits: number;
    misses: number;
    dirtyElementIds: string[];
    elements: Array<{
      elementId: string;
      fingerprint: string;
      cacheState: "hit" | "miss";
      reason: string;
    }>;
  };
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
  capability_version?: string;
  capability_sha256?: string;
  resolved_layout?: unknown[];
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
    overlay_capability_sha256: remotionCapabilityIdentityHash(),
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
    // Receipts without the Issue #15 capability identity predate this
    // contract; never accept them as cache hits.
    if (cached.capability_version !== REMOTION_OVERLAY_CAPABILITY_VERSION
      || cached.capability_sha256 !== remotionCapabilityIdentityHash()) return undefined;
    if (!Array.isArray(cached.resolved_layout)) return undefined;
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

const REMOTION_LAYER_CONTRACT_VERSION = "remotion-alpha-layer/v3-element-cache";
const REMOTION_BUNDLE_SOURCE_VERSION = "remotion-overlay-bundle/v1";

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

function orderedRemotionElementIds(
  timeline: TimelineIR,
  stage: CreativeCompositeStage,
  requestedElementIds?: string[],
): string[] {
  const requested = requestedElementIds ? new Set(requestedElementIds) : undefined;
  const tracks = timeline.tracks as TimelineIR["tracks"] & { overlay?: TimelineIR["tracks"]["video"] };
  const selected: Array<{ elementId: string; zIndex: number; ordinal: number }> = [];
  let ordinal = 0;
  for (const track of tracks.overlay ?? []) {
    for (const clip of track.clips) {
      const normalized = normalizeOverlayClipContent(clip);
      const recipe = normalized.element?.creative_recipe;
      const elementId = normalized.element?.element_id ?? clip.clip_id;
      if (
        normalized.renderer_owner === "remotion"
        && recipe?.requires_base_frame !== true
        && (recipe?.composite_stage ?? "under_caption") === stage
        && (!requested || requested.has(elementId))
      ) {
        selected.push({
          elementId,
          zIndex: normalized.element?.layout.z_index ?? 0,
          ordinal,
        });
      }
      ordinal += 1;
    }
  }
  return selected
    .sort((left, right) => left.zIndex - right.zIndex || left.ordinal - right.ordinal)
    .map((entry) => entry.elementId);
}

function assertUniqueRemotionElementIds(elementIds: string[]): void {
  const seen = new Set<string>();
  for (const elementId of elementIds) {
    if (elementId.trim().length === 0) {
      throw new Error("invalid_remotion_element_id:empty");
    }
    if (seen.has(elementId)) {
      throw new Error(`duplicate_remotion_element_id:${elementId}`);
    }
    seen.add(elementId);
  }
}

function resolvedRemotionMediaProjection(
  timeline: TimelineIR,
  stage: CreativeCompositeStage,
  requestedElementIds?: string[],
): Array<{
  timeline_in_frame: number;
  timeline_duration_frames: number;
  drawing: (Omit<ResolvedRemotionOverlayClip, "layout"> & {
    layout?: Omit<ResolvedRemotionOverlayLayout, "zIndex">;
  }) | null;
}> {
  const requested = requestedElementIds ? new Set(requestedElementIds) : undefined;
  const tracks = timeline.tracks as TimelineIR["tracks"] & { overlay?: TimelineIR["tracks"]["video"] };
  const projection = [];
  for (const track of tracks.overlay ?? []) {
    for (const clip of track.clips) {
      const normalized = normalizeOverlayClipContent(clip);
      const recipe = normalized.element?.creative_recipe;
      const elementId = normalized.element?.element_id ?? clip.clip_id;
      if (
        normalized.renderer_owner !== "remotion"
        || recipe?.requires_base_frame === true
        || (recipe?.composite_stage ?? "under_caption") !== stage
        || (requested && !requested.has(elementId))
      ) continue;
      const drawing = resolveRemotionOverlayClip(clip as ClipOutput);
      const mediaDrawing = drawing?.layout
        ? (() => {
          const { zIndex: _zIndex, ...layout } = drawing.layout;
          return { ...drawing, layout };
        })()
        : drawing;
      projection.push({
        timeline_in_frame: clip.timeline_in_frame,
        timeline_duration_frames: clip.timeline_duration_frames,
        drawing: mediaDrawing,
      });
    }
  }
  return projection;
}

function remotionResolvedOverlayFontStrings(timeline: TimelineIR): string[] {
  const values: string[] = [];
  const tracks = timeline.tracks as TimelineIR["tracks"] & { overlay?: TimelineIR["tracks"]["video"] };
  for (const track of tracks.overlay ?? []) {
    for (const clip of track.clips) {
      const resolved = resolveRemotionOverlayClip(clip as ClipOutput);
      if (!resolved) continue;
      for (const value of [resolved.text, resolved.actionText, resolved.brandText]) {
        if (typeof value === "string" && value.length > 0) values.push(value);
      }
    }
  }
  return values;
}

export function createRemotionBundleIdentity(input: {
  rendererVersion?: string;
  sourceVersion?: string;
} = {}): string {
  return createHash("sha256").update(JSON.stringify({
    version: "remotion-bundle-identity/v1",
    renderer_version: input.rendererVersion ?? REMOTION_RENDERER_VERSION,
    source_version: input.sourceVersion ?? REMOTION_BUNDLE_SOURCE_VERSION,
  })).digest("hex");
}

export interface RemotionLayerFingerprintIdentity {
  rendererVersion?: string;
  capabilitySha256?: string;
  bundleIdentity?: string;
}

export function createRemotionLayerFingerprint(
  timeline: TimelineIR,
  stage: CreativeCompositeStage,
  elementIds?: string[],
  identity: RemotionLayerFingerprintIdentity = {},
): string {
  const selected = filterTimelineForRemotionLayer(timeline, stage, elementIds);
  const props = timelineToCompositionProps(selected.timeline, {});
  return createHash("sha256").update(JSON.stringify({
    version: REMOTION_LAYER_CONTRACT_VERSION,
    sequence: {
      width: selected.timeline.sequence.width,
      height: selected.timeline.sequence.height,
      fps_num: selected.timeline.sequence.fps_num,
      fps_den: selected.timeline.sequence.fps_den,
    },
    duration_in_frames: props.durationInFrames,
    composite_stage: stage,
    renderer_version: identity.rendererVersion ?? REMOTION_RENDERER_VERSION,
    overlay_capability_sha256: identity.capabilitySha256 ?? remotionCapabilityIdentityHash(),
    bundle_identity: identity.bundleIdentity ?? createRemotionBundleIdentity(),
    resolved_drawing: resolvedRemotionMediaProjection(timeline, stage, elementIds),
  })).digest("hex");
}

function pathIsInside(root: string, candidate: string): boolean {
  const resolvedRoot = path.resolve(root);
  const resolvedCandidate = path.resolve(candidate);
  const relative = path.relative(resolvedRoot, resolvedCandidate);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) return false;
  const realRoot = realpathSync(resolvedRoot);
  const realCandidate = realpathSync(resolvedCandidate);
  return realCandidate.startsWith(`${realRoot}${path.sep}`);
}

function receiptPayloadSha256(receipt: Record<string, unknown>): string {
  const { receipt_payload_sha256: _stored, ...payload } = receipt;
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

function sealCompleteReceipt<T extends Record<string, unknown>>(receipt: T): T & {
  receipt_payload_sha256: string;
} {
  return { ...receipt, receipt_payload_sha256: receiptPayloadSha256(receipt) };
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
  cacheRoot?: string;
  expectedGenerationId?: string | null;
  expectedBundleIdentity?: string;
  expectedCapabilitySha256?: string;
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
    if (input.cacheRoot && (
      !pathIsInside(input.cacheRoot, input.overlayPath)
      || !pathIsInside(input.cacheRoot, input.receiptPath)
    )) return undefined;
    const receipt = JSON.parse(readFileSync(input.receiptPath, "utf8")) as {
      version?: unknown;
      state?: unknown;
      complete?: unknown;
      renderer_version?: unknown;
      capability_sha256?: unknown;
      bundle_identity?: unknown;
      generation_id?: unknown;
      receipt_payload_sha256?: unknown;
      fingerprint?: unknown;
      overlay_sha256?: unknown;
      media?: AlphaLayerMediaContract;
      result?: RenderRemotionLayerResult;
    };
    if (
      receipt.version !== "remotion-layer-receipt/v3"
      || receipt.state !== "complete"
      || receipt.complete !== true
      || !/^[a-f0-9]{64}$/.test(String(receipt.receipt_payload_sha256 ?? ""))
      || receipt.receipt_payload_sha256 !== receiptPayloadSha256(receipt as Record<string, unknown>)
      || receipt.renderer_version !== REMOTION_RENDERER_VERSION
      || (input.expectedCapabilitySha256 !== undefined
        && receipt.capability_sha256 !== input.expectedCapabilitySha256)
      || (input.expectedBundleIdentity !== undefined
        && receipt.bundle_identity !== input.expectedBundleIdentity)
      || (input.expectedGenerationId !== undefined
        && receipt.generation_id !== input.expectedGenerationId)
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

function writeReceiptAtomically(receiptPath: string, value: unknown): void {
  mkdirSync(path.dirname(receiptPath), { recursive: true });
  const temporary = `${receiptPath}.partial-${process.pid}-${Date.now()}`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  renameSync(temporary, receiptPath);
}

export async function compositeRemotionAlphaLayers(
  input: RemotionAlphaCompositeInput,
): Promise<void> {
  if (input.elements.length === 0) throw new Error("Remotion alpha composite requires at least one element");
  const args = [
    "-y",
    "-f", "lavfi",
    "-i", `color=c=black@0.0:s=${input.width}x${input.height}:r=${input.fpsNum}/${input.fpsDen},format=rgba`,
  ];
  for (const element of input.elements) {
    args.push("-c:v", "libvpx-vp9", "-i", element.path);
  }
  const filters = ["[0:v]format=rgba[base0]"];
  let current = "base0";
  input.elements.forEach((_element, index) => {
    const layer = `layer${index + 1}`;
    const next = `composite${index + 1}`;
    filters.push(
      `[${index + 1}:v]fps=${input.fpsNum}/${input.fpsDen},scale=${input.width}:${input.height}:flags=lanczos,format=rgba[${layer}]`,
      `[${current}][${layer}]overlay=eof_action=pass:shortest=0:format=auto[${next}]`,
    );
    current = next;
  });
  filters.push(`[${current}]format=yuva420p[v]`);
  args.push(
    "-filter_complex", filters.join(";"),
    "-map", "[v]",
    "-an",
    "-frames:v", String(input.durationFrames),
    "-c:v", "libvpx-vp9",
    "-pix_fmt", "yuva420p",
    "-auto-alt-ref", "0",
    "-metadata:s:v:0", "alpha_mode=1",
    input.outputPath,
  );
  await new Promise<void>((resolve, reject) => {
    execFile("ffmpeg", args, { maxBuffer: 100 * 1024 * 1024 }, (error, _stdout, stderr) => {
      if (error) reject(new Error(`Remotion alpha composite failed: ${stderr || error.message}`));
      else resolve();
    });
  });
}

/**
 * Render a transparent, renderer-owned Remotion layer. This path never stages
 * or decodes base media; FFmpeg owns the only base/layer/caption composite.
 */
export async function renderRemotionContentLayer(
  opts: RenderRemotionLayerOptions,
): Promise<RenderRemotionLayerResult | null> {
  const timeline = JSON.parse(readFileSync(opts.timelinePath, "utf-8")) as TimelineIR;
  // Fail closed on unsupported/invalid overlay elements before any
  // bundle or renderMedia call; the renderer must never silently drop.
  const capabilities = assertRemotionOverlayCapabilities(timeline, {
    compositeStage: opts.compositeStage,
    elementIds: opts.elementIds,
  });
  const selected = filterTimelineForRemotionLayer(
    timeline,
    opts.compositeStage,
    opts.elementIds,
  );
  if (selected.elementIds.length === 0) return null;

  const elementIds = orderedRemotionElementIds(timeline, opts.compositeStage, opts.elementIds);
  assertUniqueRemotionElementIds(elementIds);
  const durationInFrames = timelineToCompositionProps(selected.timeline, {}).durationInFrames;
  const expected = {
    width: timeline.sequence.width,
    height: timeline.sequence.height,
    fpsNum: timeline.sequence.fps_num,
    fpsDen: timeline.sequence.fps_den,
    durationFrames: durationInFrames,
  };

  const basename = remotionLayerBasename(opts.compositeStage);
  const videoDir = path.join(opts.outputDir, "video");
  const logsDir = path.join(opts.outputDir, "logs");
  const overlayPath = path.join(videoDir, `${basename}-overlay.webm`);
  const receiptPath = path.join(logsDir, `${basename}-layer-receipt.json`);
  const progressJournalPath = opts.progressJournalPath
    ?? path.join(logsDir, `${basename}-progress.jsonl`);
  const mediaCacheDir = path.resolve(opts.mediaCacheDir
    ?? path.join(opts.outputDir, "cache", "remotion-elements"));
  mkdirSync(videoDir, { recursive: true });
  mkdirSync(logsDir, { recursive: true });
  mkdirSync(mediaCacheDir, { recursive: true });
  writeFileSync(progressJournalPath, "", "utf8");
  const startedAt = Date.now();
  const emit = (event: Omit<RemotionLayerProgressEvent, "version" | "elapsedMs">) => {
    const completeEvent: RemotionLayerProgressEvent = {
      version: "remotion-alpha-progress/v1",
      ...event,
      elapsedMs: Math.max(0, Date.now() - startedAt),
    };
    appendFileSync(progressJournalPath, `${JSON.stringify(completeEvent)}\n`, "utf8");
    opts.onProgress?.(completeEvent);
    console.log(`[remotion-alpha] ${JSON.stringify(completeEvent)}`);
  };
  const partialReceipt = {
    version: "remotion-layer-receipt/v3",
    state: "partial",
    complete: false,
    renderer: "remotion",
    renderer_version: REMOTION_RENDERER_VERSION,
    capability_version: REMOTION_OVERLAY_CAPABILITY_VERSION,
    capability_sha256: capabilities.capability_sha256,
    generation_id: opts.generationId ?? null,
    composite_stage: opts.compositeStage,
    element_ids: elementIds,
  };
  const cacheEntries: NonNullable<RenderRemotionLayerResult["elementCache"]>["elements"] = [];
  const renderedElements: RemotionAlphaCompositeElement[] = [];
  const elementResults: RenderRemotionLayerResult[] = [];
  const bundleIdentities: string[] = [];
  try {
    for (const elementId of elementIds) {
      emit({ phase: "cache", completedFrames: 0, totalFrames: durationInFrames, elementIds: [elementId], cacheState: "checking" });
      const elementSelection = filterTimelineForRemotionLayer(timeline, opts.compositeStage, [elementId]);
      const publicDir = mkdtempSync(path.join(os.tmpdir(), "vos-remotion-element-public-"));
      const fontAsset = stageWebFontAssets(publicDir, remotionResolvedOverlayFontStrings(elementSelection.timeline));
      const bundleIdentity = createRemotionBundleIdentity({
        sourceVersion: `${REMOTION_BUNDLE_SOURCE_VERSION}:${fontAsset.sha256}`,
      });
      bundleIdentities.push(bundleIdentity);
      const fingerprint = createRemotionLayerFingerprint(timeline, opts.compositeStage, [elementId], {
        capabilitySha256: capabilities.capability_sha256,
        bundleIdentity,
      });
      const elementOverlayPath = path.join(mediaCacheDir, `${fingerprint}.webm`);
      const elementReceiptPath = path.join(mediaCacheDir, `${fingerprint}.json`);
      const cached = await readValidRemotionLayerCache({
        overlayPath: elementOverlayPath,
        receiptPath: elementReceiptPath,
        fingerprint,
        expected,
        cacheRoot: mediaCacheDir,
        expectedBundleIdentity: bundleIdentity,
        expectedCapabilitySha256: capabilities.capability_sha256,
        probeAlphaLayerImpl: opts.probeAlphaLayerImpl,
      });
      if (cached) {
        rmSync(publicDir, { recursive: true, force: true });
        cacheEntries.push({ elementId, fingerprint, cacheState: "hit", reason: "valid_content_addressed_media" });
        renderedElements.push({ elementId, path: elementOverlayPath, fingerprint });
        elementResults.push(cached);
        emit({ phase: "cache", completedFrames: durationInFrames, totalFrames: durationInFrames, elementIds: [elementId], cacheState: "hit" });
        continue;
      }

      cacheEntries.push({ elementId, fingerprint, cacheState: "miss", reason: "missing_or_invalid_receipt_media_identity" });
      emit({ phase: "cache", completedFrames: 0, totalFrames: durationInFrames, elementIds: [elementId], cacheState: "miss" });
      writeReceiptAtomically(elementReceiptPath, {
        ...partialReceipt,
        element_ids: [elementId],
        bundle_identity: bundleIdentity,
        fingerprint,
      });
      const compositionProps = timelineToCompositionProps(elementSelection.timeline, {}, fontAsset);
      const frameRate = rationalFrameRate(compositionProps.fpsNum, compositionProps.fpsDen);
      const fontSizeBytes = statSync(fontAsset.fontPath).size;
      const entryPoint = fileURLToPath(new URL("./entry.tsx", import.meta.url));
      const outDir = opts.bundleCacheDir
        ? path.join(path.resolve(opts.bundleCacheDir), bundleIdentity)
        : mkdtempSync(path.join(os.tmpdir(), "vos-remotion-element-bundle-"));
      mkdirSync(outDir, { recursive: true });
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
      const temporaryOverlayPath = `${elementOverlayPath}.partial-${process.pid}-${Date.now()}.webm`;
      let lastProgressFrame = -1;
      let lastObservedProgressFrame = 0;
      let lastProgressAt = startedAt;
      let progressSeen = false;
      let progressEventCount = 0;
      let progressError: unknown;
      try {
        const compositionMismatches = [
          ...(composition.durationInFrames === expected.durationFrames
            ? [] : [`duration_frames=${composition.durationInFrames} expected=${expected.durationFrames}`]),
          ...(composition.width === expected.width ? [] : [`width=${composition.width} expected=${expected.width}`]),
          ...(composition.height === expected.height ? [] : [`height=${composition.height} expected=${expected.height}`]),
          ...(composition.fps === compositionProps.fps ? [] : [`fps=${composition.fps} expected=${compositionProps.fps}`]),
        ];
        if (compositionMismatches.length > 0) {
          throw new Error(`remotion_composition_contract_mismatch:${compositionMismatches.join(",")}`);
        }
        await renderMedia({
          composition,
          serveUrl: bundleLocation,
          codec: "vp9",
          audioCodec: null,
          muted: true,
          imageFormat: "png",
          pixelFormat: "yuva420p",
          outputLocation: temporaryOverlayPath,
          inputProps: compositionProps.defaultProps,
          ffmpegOverride: ({ args }) => preserveRemotionFfmpegFrameRate(args, frameRate),
          onProgress: ({ progress }) => {
            progressSeen = true;
            progressEventCount += 1;
            if (progressError !== undefined) return;
            const completedFrames = Math.max(
              lastObservedProgressFrame,
              Math.min(
                composition.durationInFrames,
                Math.max(0, Math.round(progress * composition.durationInFrames)),
              ),
            );
            lastObservedProgressFrame = completedFrames;
            const now = Date.now();
            const frameInterval = opts.progressIntervalFrames
              ?? Math.max(1, Math.ceil(composition.durationInFrames / 10));
            const timeInterval = opts.progressIntervalMs ?? 2_000;
            if (
              completedFrames === composition.durationInFrames
              || completedFrames - lastProgressFrame >= frameInterval
              || now - lastProgressAt >= timeInterval
            ) {
              lastProgressFrame = completedFrames;
              lastProgressAt = now;
              try {
                emit({ phase: "rendering", completedFrames, totalFrames: composition.durationInFrames, elementIds: [elementId], cacheState: "miss" });
              } catch (error) {
                progressError = error;
              }
            }
          },
        });
        if (progressError !== undefined) throw progressError;
        if (!progressSeen) throw new Error(`remotion_progress_evidence_missing:${elementId}`);
        const media = await (opts.probeAlphaLayerImpl ?? probeAlphaLayerMedia)(temporaryOverlayPath);
        assertAlphaLayerMediaContract(media, {
          width: composition.width,
          height: composition.height,
          fpsNum: frameRate.fpsNum,
          fpsDen: frameRate.fpsDen,
          durationFrames: composition.durationInFrames,
        });
        renameSync(temporaryOverlayPath, elementOverlayPath);
        const elementResult: RenderRemotionLayerResult = {
          overlayPath: elementOverlayPath,
          receiptPath: elementReceiptPath,
          durationInFrames: composition.durationInFrames,
          fps: composition.fps,
          fpsNum: frameRate.fpsNum,
          fpsDen: frameRate.fpsDen,
          width: composition.width,
          height: composition.height,
          elementCount: 1,
          layerCacheHit: false,
          bundleIdentity,
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
        writeReceiptAtomically(elementReceiptPath, sealCompleteReceipt({
          ...partialReceipt,
          state: "complete",
          complete: true,
          generation_id: null,
          element_ids: [elementId],
          bundle_identity: bundleIdentity,
          fingerprint,
          overlay_sha256: sha256FileHex(elementOverlayPath),
          media,
          progress_evidence: {
            version: "remotion-render-progress-evidence/v1",
            event_count: progressEventCount,
            completed_frames: lastObservedProgressFrame,
            total_frames: composition.durationInFrames,
          },
          result: elementResult,
        }));
        renderedElements.push({ elementId, path: elementOverlayPath, fingerprint });
        elementResults.push(elementResult);
      } catch (error) {
        rmSync(temporaryOverlayPath, { force: true });
        writeReceiptAtomically(elementReceiptPath, {
          ...partialReceipt,
          state: "failed",
          complete: false,
          element_ids: [elementId],
          bundle_identity: bundleIdentity,
          fingerprint,
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    }

    const compositeIdentity = createHash("sha256").update(JSON.stringify({
      version: "remotion-alpha-composite/v1",
      renderer_version: REMOTION_RENDERER_VERSION,
      capability_sha256: capabilities.capability_sha256,
      composite_stage: opts.compositeStage,
      order: renderedElements.map((element) => ({
        element_id: element.elementId,
        fingerprint: element.fingerprint,
        output_sha256: sha256FileHex(element.path),
      })),
      geometry: expected,
    })).digest("hex");
    const bundleIdentity = createHash("sha256").update(JSON.stringify(bundleIdentities)).digest("hex");
    const elementCache = {
      total: cacheEntries.length,
      hits: cacheEntries.filter((entry) => entry.cacheState === "hit").length,
      misses: cacheEntries.filter((entry) => entry.cacheState === "miss").length,
      dirtyElementIds: cacheEntries.filter((entry) => entry.cacheState === "miss").map((entry) => entry.elementId),
      elements: cacheEntries,
    };
    const cachedComposite = await readValidRemotionLayerCache({
      overlayPath,
      receiptPath,
      fingerprint: compositeIdentity,
      expected,
      cacheRoot: opts.outputDir,
      expectedGenerationId: opts.generationId ?? null,
      expectedCapabilitySha256: capabilities.capability_sha256,
      expectedBundleIdentity: bundleIdentity,
      probeAlphaLayerImpl: opts.probeAlphaLayerImpl,
    });
    if (cachedComposite) {
      emit({ phase: "complete", completedFrames: durationInFrames, totalFrames: durationInFrames, elementIds, cacheState: "complete" });
      return {
        ...cachedComposite,
        overlayPath,
        receiptPath,
        progressJournalPath,
        layerCacheHit: true,
        bundleIdentity,
        compositeIdentity,
        elementCache,
      };
    }

    emit({ phase: "compositing", completedFrames: 0, totalFrames: durationInFrames, elementIds, cacheState: "compositing" });
    writeReceiptAtomically(receiptPath, partialReceipt);
    const temporaryCompositePath = `${overlayPath}.partial-${process.pid}-${Date.now()}.webm`;
    const compositeInput: RemotionAlphaCompositeInput = {
      elements: renderedElements,
      outputPath: temporaryCompositePath,
      width: expected.width,
      height: expected.height,
      fpsNum: expected.fpsNum,
      fpsDen: expected.fpsDen,
      durationFrames: expected.durationFrames,
    };
    let media: AlphaLayerMediaContract;
    try {
      if (opts.compositeAlphaLayersImpl) await opts.compositeAlphaLayersImpl(compositeInput);
      else if (renderedElements.length === 1) copyFileSync(renderedElements[0].path, temporaryCompositePath);
      else await compositeRemotionAlphaLayers(compositeInput);
      media = await (opts.probeAlphaLayerImpl ?? probeAlphaLayerMedia)(temporaryCompositePath);
      assertAlphaLayerMediaContract(media, expected);
      renameSync(temporaryCompositePath, overlayPath);
    } catch (error) {
      rmSync(temporaryCompositePath, { force: true });
      throw error;
    }
    const first = elementResults[0];
    const result: RenderRemotionLayerResult = {
      overlayPath,
      receiptPath,
      durationInFrames,
      fps: expected.fpsNum / expected.fpsDen,
      fpsNum: expected.fpsNum,
      fpsDen: expected.fpsDen,
      width: expected.width,
      height: expected.height,
      elementCount: elementIds.length,
      layerCacheHit: false,
      bundleIdentity,
      compositeIdentity,
      progressJournalPath,
      elementCache,
      font: first.font,
    };
    writeReceiptAtomically(receiptPath, sealCompleteReceipt({
      ...partialReceipt,
      state: "complete",
      complete: true,
      contract_version: REMOTION_LAYER_CONTRACT_VERSION,
      resolved_layout: capabilities.resolved_layouts,
      bundle_identity: bundleIdentity,
      fingerprint: compositeIdentity,
      composite_identity: compositeIdentity,
      deterministic_order: renderedElements.map((element) => element.elementId),
      timeline_path: path.resolve(opts.timelinePath),
      timeline_sha256: sha256FileHex(opts.timelinePath),
      fps_num: expected.fpsNum,
      fps_den: expected.fpsDen,
      overlay_path: overlayPath,
      overlay_sha256: sha256FileHex(overlayPath),
      media,
      element_cache: elementCache,
      result,
    }));
    emit({ phase: "complete", completedFrames: durationInFrames, totalFrames: durationInFrames, elementIds, cacheState: "complete" });
    return result;
  } catch (error) {
    writeReceiptAtomically(receiptPath, {
      ...partialReceipt,
      state: "failed",
      complete: false,
      error: error instanceof Error ? error.message : String(error),
    });
    emit({ phase: "failed", completedFrames: 0, totalFrames: durationInFrames, elementIds, cacheState: "failed" });
    throw error;
  }
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
  // Fail closed on unsupported/invalid overlay elements before any cache
  // reuse or staging; a corrupted timeline must never mask as a cache hit.
  const capabilities = assertRemotionOverlayCapabilities(timeline, { requiresBaseFrame: true });
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
    capability_version: REMOTION_OVERLAY_CAPABILITY_VERSION,
    capability_sha256: remotionCapabilityIdentityHash(),
    resolved_layout: capabilities.resolved_layouts,
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
