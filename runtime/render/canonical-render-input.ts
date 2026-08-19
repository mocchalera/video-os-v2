import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import type { TimelineIR } from "../compiler/types.js";
import { loadSourceMap } from "../media/source-map.js";
import { sha256FileHex } from "../source-content-identity.js";
import { mediaKindForExtension } from "../media/media-kind-registry.js";
import { computeImageSequenceFrameSetContentSha256 } from "../media/image-sequence.js";

export const NORMALIZED_STILL_RELATIONSHIP = "normalized_still_frame" as const;
export const NORMALIZED_SEQUENCE_RELATIONSHIP = "normalized_image_sequence_proxy" as const;
const SUPPORTED_STILL_NORMALIZATION_PRODUCERS = new Set([
  "ffmpeg-still-normalizer",
  "macos-sips-heif-normalizer",
]);

export class CanonicalRenderInputError extends Error {
  constructor(
    public readonly reason:
      | "image_project_root_unresolved"
      | "still_image_identity_missing"
      | "still_image_normalized_path_invalid"
      | "still_image_normalized_path_escape"
      | "still_image_normalized_frame_missing"
      | "still_image_normalized_frame_empty"
      | "still_image_normalized_hash_mismatch"
      | "still_image_snapshot_invalid"
      | "still_image_snapshot_hash_mismatch"
      | "still_image_normalization_producer_mismatch"
      | "still_image_original_identity_missing"
      | "still_image_original_hash_mismatch"
      | "still_image_invalid_lane"
      | "sequence_project_root_unresolved"
      | "image_sequence_identity_missing"
      | "image_sequence_invalid_lane"
      | "image_sequence_normalization_producer_mismatch"
      | "image_sequence_source_set_missing"
      | "image_sequence_source_set_invalid"
      | "image_sequence_frame_link_invalid"
      | "image_sequence_frame_missing"
      | "image_sequence_frame_hash_mismatch"
      | "image_sequence_frame_set_hash_mismatch"
      | "image_sequence_proxy_path_invalid"
      | "image_sequence_proxy_path_escape"
      | "image_sequence_proxy_missing"
      | "image_sequence_proxy_hash_mismatch"
      | "image_sequence_snapshot_invalid"
      | "image_sequence_snapshot_hash_mismatch"
      | "source_map_entry_missing"
      | "source_missing",
    message: string,
    public readonly assetId?: string,
  ) {
    super(`${reason}: ${message}`);
    this.name = "CanonicalRenderInputError";
  }
}

interface RenderAsset {
  asset_id?: unknown;
  media_kind?: unknown;
  duration_semantics?: unknown;
  frame_rate_mode?: unknown;
  source_content_sha256?: unknown;
  still_image?: {
    normalized_frame_path?: unknown;
    normalized_frame_content_sha256?: unknown;
    normalization_producer?: unknown;
    normalization_producer_version?: unknown;
  };
  image_sequence?: {
    grouping_producer?: unknown;
    grouping_producer_version?: unknown;
    normalization_producer?: unknown;
    normalization_producer_version?: unknown;
    start_number?: unknown;
    end_number?: unknown;
    frame_count?: unknown;
    frame_set_content_sha256?: unknown;
    frame_content_sha256?: unknown;
    analysis_proxy_path?: unknown;
    analysis_proxy_content_sha256?: unknown;
    analysis_proxy_frame_count?: unknown;
  };
  filename?: unknown;
  source_locator?: unknown;
}

export interface CanonicalRenderInput {
  assetId: string;
  mediaKind: "image" | "video" | "audio" | "sequence" | "unknown";
  originalSourcePath: string;
  originalContentSha256: string;
  renderInputPath: string;
  renderInputContentSha256: string;
  relationship: "same_as_original" | "normalized_still_frame" | "normalized_image_sequence_proxy";
  analysisPath?: string;
  normalizationProducer?: string;
  normalizationProducerVersion?: string;
  originalFramePaths?: string[];
  originalFrameSetContentSha256?: string;
  frameCount?: number;
}

export interface CanonicalRenderInputSet {
  projectDir: string;
  byAssetId: Map<string, CanonicalRenderInput>;
  imageAssetIds: Set<string>;
  sequenceAssetIds: Set<string>;
}

export interface VerifiedStillSnapshotSet extends CanonicalRenderInputSet {
  /** Private 0700 directory containing only re-hashed, renderer-facing still bytes. */
  snapshotRoot: string;
  dispose(): void;
}

export interface MaterializeVerifiedStillSnapshotOptions {
  tempRoot?: string;
  copyFileImpl?: (source: string, destination: string) => void;
}

function sha(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  return /^[a-f0-9]{64}$/.test(normalized) ? normalized : undefined;
}

function projectRelativePath(projectDir: string, target: string): string {
  return path.relative(projectDir, target).split(path.sep).join("/");
}

export function isImageMediaTruth(...values: unknown[]): boolean {
  for (const value of values) {
    if (typeof value === "string") {
      if (value === "image" || mediaKindForExtension(value) === "image") return true;
      continue;
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const item = value as Record<string, unknown>;
    if (item.media_kind === "image" || item.duration_semantics === "single_frame_zero_duration" ||
      item.frame_rate_mode === "still_image" || (item.still_image && typeof item.still_image === "object")) return true;
    for (const key of ["filename", "source_locator", "local_source_path", "link_path", "source_path"]) {
      if (typeof item[key] === "string" && mediaKindForExtension(item[key] as string) === "image") return true;
    }
  }
  return false;
}

function timelineAssetUses(timeline: TimelineIR, includeVideo: boolean, includeAudio: boolean): Map<string, Set<string>> {
  const uses = new Map<string, Set<string>>();
  const tracks = timeline.tracks as unknown as Record<string, Array<{ clips?: Array<{ asset_id?: unknown }> }>>;
  for (const [lane, laneTracks] of Object.entries(tracks ?? {})) {
    if (lane === "video" && !includeVideo) continue;
    if (lane === "audio" && !includeAudio) continue;
    for (const track of laneTracks ?? []) for (const clip of track.clips ?? []) {
      if (typeof clip.asset_id !== "string" || !clip.asset_id) continue;
      const lanes = uses.get(clip.asset_id) ?? new Set<string>();
      lanes.add(lane);
      uses.set(clip.asset_id, lanes);
    }
  }
  const bgm = timeline.audio_mix?.bgm_asset_id;
  if (includeAudio && typeof bgm === "string" && bgm) {
    const lanes = uses.get(bgm) ?? new Set<string>();
    lanes.add("audio");
    uses.set(bgm, lanes);
  }
  return uses;
}

function secureNormalizedFrame(projectDir: string, assetId: string, rawPath: unknown): { absolute: string; analysisPath: string } {
  if (typeof rawPath !== "string" || rawPath.trim().length === 0 || path.isAbsolute(rawPath)) {
    throw new CanonicalRenderInputError("still_image_normalized_path_invalid", `Normalized frame path is not a non-empty relative path for ${assetId}`, assetId);
  }
  const normalized = path.normalize(rawPath.trim());
  if (normalized === ".." || normalized.startsWith(`..${path.sep}`)) {
    throw new CanonicalRenderInputError("still_image_normalized_path_escape", `Normalized frame path traverses outside analysis for ${assetId}`, assetId);
  }
  const analysisDir = path.join(projectDir, "03_analysis");
  if (!fs.existsSync(analysisDir) || !fs.statSync(analysisDir).isDirectory() || fs.lstatSync(analysisDir).isSymbolicLink()) {
    throw new CanonicalRenderInputError("still_image_normalized_path_escape", `Analysis root is missing, not a directory, or a symlink for ${assetId}`, assetId);
  }
  const absolute = path.resolve(analysisDir, normalized);
  const relative = path.relative(analysisDir, absolute);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new CanonicalRenderInputError("still_image_normalized_path_escape", `Normalized frame path escapes analysis for ${assetId}`, assetId);
  }
  if (!fs.existsSync(absolute)) {
    throw new CanonicalRenderInputError("still_image_normalized_frame_missing", `Normalized frame is missing for ${assetId}`, assetId);
  }
  const stat = fs.statSync(absolute);
  if (!stat.isFile() || stat.size <= 0) {
    throw new CanonicalRenderInputError("still_image_normalized_frame_empty", `Normalized frame is empty or not a file for ${assetId}`, assetId);
  }
  let component = analysisDir;
  for (const part of relative.split(path.sep).filter(Boolean)) {
    component = path.join(component, part);
    if (fs.lstatSync(component).isSymbolicLink()) {
      throw new CanonicalRenderInputError("still_image_normalized_path_escape", `Normalized frame path contains a symlink for ${assetId}`, assetId);
    }
  }
  const analysisReal = fs.realpathSync(analysisDir);
  const projectReal = fs.realpathSync(projectDir);
  const analysisRelative = path.relative(projectReal, analysisReal);
  if (analysisRelative === ".." || analysisRelative.startsWith(`..${path.sep}`) || path.isAbsolute(analysisRelative)) {
    throw new CanonicalRenderInputError("still_image_normalized_path_escape", `Analysis root resolves outside project for ${assetId}`, assetId);
  }
  const frameReal = fs.realpathSync(absolute);
  const realRelative = path.relative(analysisReal, frameReal);
  if (realRelative === ".." || realRelative.startsWith(`..${path.sep}`) || path.isAbsolute(realRelative)) {
    throw new CanonicalRenderInputError("still_image_normalized_path_escape", `Normalized frame resolves outside analysis for ${assetId}`, assetId);
  }
  return { absolute: frameReal, analysisPath: projectRelativePath(projectDir, absolute) };
}

function secureSequenceProxy(projectDir: string, assetId: string, rawPath: unknown): { absolute: string; analysisPath: string } {
  if (typeof rawPath !== "string" || rawPath.trim().length === 0 || path.isAbsolute(rawPath)) {
    throw new CanonicalRenderInputError("image_sequence_proxy_path_invalid", `Sequence proxy path is not a non-empty relative path for ${assetId}`, assetId);
  }
  const normalized = path.normalize(rawPath.trim());
  if (normalized === ".." || normalized.startsWith(`..${path.sep}`)) {
    throw new CanonicalRenderInputError("image_sequence_proxy_path_escape", `Sequence proxy path traverses outside analysis for ${assetId}`, assetId);
  }
  const analysisDir = path.join(projectDir, "03_analysis");
  if (!fs.existsSync(analysisDir) || !fs.statSync(analysisDir).isDirectory() || fs.lstatSync(analysisDir).isSymbolicLink()) {
    throw new CanonicalRenderInputError("image_sequence_proxy_path_escape", `Analysis root is missing, not a directory, or a symlink for ${assetId}`, assetId);
  }
  const absolute = path.resolve(analysisDir, normalized);
  const relative = path.relative(analysisDir, absolute);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new CanonicalRenderInputError("image_sequence_proxy_path_escape", `Sequence proxy path escapes analysis for ${assetId}`, assetId);
  }
  if (!fs.existsSync(absolute)) {
    throw new CanonicalRenderInputError("image_sequence_proxy_missing", `Sequence proxy is missing for ${assetId}`, assetId);
  }
  const stat = fs.statSync(absolute);
  if (!stat.isFile() || stat.size <= 0) {
    throw new CanonicalRenderInputError("image_sequence_proxy_missing", `Sequence proxy is empty or not a file for ${assetId}`, assetId);
  }
  let component = analysisDir;
  for (const part of relative.split(path.sep).filter(Boolean)) {
    component = path.join(component, part);
    if (fs.lstatSync(component).isSymbolicLink()) {
      throw new CanonicalRenderInputError("image_sequence_proxy_path_escape", `Sequence proxy path contains a symlink for ${assetId}`, assetId);
    }
  }
  const analysisReal = fs.realpathSync(analysisDir);
  const proxyReal = fs.realpathSync(absolute);
  const realRelative = path.relative(analysisReal, proxyReal);
  if (realRelative === ".." || realRelative.startsWith(`..${path.sep}`) || path.isAbsolute(realRelative)) {
    throw new CanonicalRenderInputError("image_sequence_proxy_path_escape", `Sequence proxy resolves outside analysis for ${assetId}`, assetId);
  }
  return { absolute: proxyReal, analysisPath: projectRelativePath(projectDir, absolute) };
}

function resolveSequenceSourceSet(
  projectDir: string,
  assetId: string,
  asset: RenderAsset,
  sourceSet: ReturnType<typeof loadSourceMap>["entries"][number]["image_sequence"],
): { framePaths: string[]; frameSetContentSha256: string; frameCount: number } {
  const sequence = asset.image_sequence;
  const expectedSet = sha(sequence?.frame_set_content_sha256);
  const expectedHashes = Array.isArray(sequence?.frame_content_sha256)
    ? sequence.frame_content_sha256.map(sha)
    : [];
  const frameCount = sequence?.frame_count;
  if (!expectedSet || !Number.isInteger(frameCount) || (frameCount as number) < 2 || expectedHashes.some((value) => !value)) {
    throw new CanonicalRenderInputError("image_sequence_identity_missing", `Sequence ${assetId} lacks its ordered frame-set identity; re-ingest required`, assetId);
  }
  if (!sourceSet) {
    throw new CanonicalRenderInputError("image_sequence_source_set_missing", `Sequence ${assetId} lacks internal original-frame links; re-ingest required`, assetId);
  }
  if (
    sourceSet.frame_set_content_sha256 !== expectedSet ||
    sourceSet.frame_count !== frameCount ||
    sourceSet.frames.length !== frameCount ||
    expectedHashes.length !== frameCount
  ) {
    throw new CanonicalRenderInputError("image_sequence_source_set_invalid", `Sequence source-set metadata disagrees with assets.json for ${assetId}`, assetId);
  }
  const mediaDir = path.join(projectDir, "02_media");
  if (!fs.existsSync(mediaDir) || !fs.statSync(mediaDir).isDirectory() || fs.lstatSync(mediaDir).isSymbolicLink()) {
    throw new CanonicalRenderInputError("image_sequence_frame_link_invalid", `Media root is missing, not a directory, or a symlink for ${assetId}`, assetId);
  }
  const ordered = [...sourceSet.frames].sort((left, right) => left.frame_number - right.frame_number);
  const start = sequence?.start_number;
  const end = sequence?.end_number;
  if (!Number.isInteger(start) || !Number.isInteger(end) || (end as number) - (start as number) + 1 !== frameCount ||
    ordered.some((frame, index) => frame.frame_number !== (start as number) + index)) {
    throw new CanonicalRenderInputError("image_sequence_source_set_invalid", `Sequence frame numbers are incomplete or unordered for ${assetId}`, assetId);
  }
  const framePaths: string[] = [];
  const liveFrames: Array<{ frame_number: number; content_sha256: string; size_bytes: number }> = [];
  for (let index = 0; index < ordered.length; index++) {
    const frame = ordered[index];
    if (!sha(frame.content_sha256) || frame.content_sha256 !== expectedHashes[index] ||
      !Number.isInteger(frame.size_bytes) || frame.size_bytes <= 0 || path.isAbsolute(frame.frame_link_path)) {
      throw new CanonicalRenderInputError("image_sequence_source_set_invalid", `Sequence frame metadata is invalid for ${assetId}:${frame.frame_number}`, assetId);
    }
    const linkPath = path.resolve(projectDir, frame.frame_link_path);
    const relative = path.relative(mediaDir, linkPath);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new CanonicalRenderInputError("image_sequence_frame_link_invalid", `Sequence frame link escapes 02_media for ${assetId}:${frame.frame_number}`, assetId);
    }
    let parentComponent = mediaDir;
    for (const part of path.dirname(relative).split(path.sep).filter((value) => value && value !== ".")) {
      parentComponent = path.join(parentComponent, part);
      try {
        if (fs.lstatSync(parentComponent).isSymbolicLink()) {
          throw new CanonicalRenderInputError("image_sequence_frame_link_invalid", `Sequence frame link parent is a symlink for ${assetId}:${frame.frame_number}`, assetId);
        }
      } catch (error) {
        if (error instanceof CanonicalRenderInputError) throw error;
        throw new CanonicalRenderInputError("image_sequence_frame_missing", `Sequence frame link parent is missing for ${assetId}:${frame.frame_number}`, assetId);
      }
    }
    let linkStat: fs.Stats;
    try {
      linkStat = fs.lstatSync(linkPath);
    } catch {
      throw new CanonicalRenderInputError("image_sequence_frame_missing", `Original sequence frame is missing for ${assetId}:${frame.frame_number}`, assetId);
    }
    if (!linkStat.isSymbolicLink()) {
      throw new CanonicalRenderInputError("image_sequence_frame_link_invalid", `Original sequence frame capability is not a symlink for ${assetId}:${frame.frame_number}`, assetId);
    }
    let realPath: string;
    let stat: fs.Stats;
    try {
      realPath = fs.realpathSync(linkPath);
      stat = fs.statSync(realPath);
    } catch {
      throw new CanonicalRenderInputError("image_sequence_frame_missing", `Original sequence frame target is missing for ${assetId}:${frame.frame_number}`, assetId);
    }
    if (!stat.isFile() || stat.size !== frame.size_bytes) {
      throw new CanonicalRenderInputError("image_sequence_frame_hash_mismatch", `Original sequence frame size changed for ${assetId}:${frame.frame_number}`, assetId);
    }
    const liveHash = sha256FileHex(realPath);
    if (liveHash !== frame.content_sha256) {
      throw new CanonicalRenderInputError("image_sequence_frame_hash_mismatch", `Original sequence frame SHA-256 changed for ${assetId}:${frame.frame_number}`, assetId);
    }
    framePaths.push(realPath);
    liveFrames.push({ frame_number: frame.frame_number, content_sha256: liveHash, size_bytes: stat.size });
  }
  const liveSet = computeImageSequenceFrameSetContentSha256(liveFrames);
  if (liveSet !== expectedSet) {
    throw new CanonicalRenderInputError("image_sequence_frame_set_hash_mismatch", `Original ordered frame-set changed for ${assetId}`, assetId);
  }
  return { framePaths, frameSetContentSha256: liveSet, frameCount: frameCount as number };
}

export function resolveProjectDirForTimeline(timelinePath: string | undefined, explicitProjectDir?: string): string | undefined {
  if (explicitProjectDir) return path.resolve(explicitProjectDir);
  if (!timelinePath) return undefined;
  const absolute = path.resolve(timelinePath);
  return path.basename(path.dirname(absolute)) === "05_timeline" ? path.dirname(path.dirname(absolute)) : undefined;
}

export function resolveCanonicalRenderInputs(
  timeline: TimelineIR,
  options: {
    projectDir?: string;
    timelinePath?: string;
    sourceOverrides?: Record<string, string>;
    includeVideo?: boolean;
    includeAudio?: boolean;
  } = {},
): CanonicalRenderInputSet {
  const projectDir = resolveProjectDirForTimeline(options.timelinePath, options.projectDir);
  const clipImageIds = new Set<string>();
  const clipSequenceIds = new Set<string>();
  const rawTracks = timeline.tracks as unknown as Record<string, Array<{ clips?: Array<{ asset_id?: unknown; media_kind?: unknown; still_image?: unknown }> }>>;
  for (const [lane, tracks] of Object.entries(rawTracks ?? {})) {
    for (const track of tracks ?? []) for (const clip of track.clips ?? []) {
      if (typeof clip.asset_id !== "string") continue;
      if (clip.media_kind === "image" || (clip.still_image && typeof clip.still_image === "object")) {
        clipImageIds.add(clip.asset_id);
        if (lane !== "video") {
          throw new CanonicalRenderInputError("still_image_invalid_lane", `Image ${clip.asset_id} is only supported on the video lane`, clip.asset_id);
        }
      }
      if (clip.media_kind === "sequence") {
        clipSequenceIds.add(clip.asset_id);
        if (lane !== "video") {
          throw new CanonicalRenderInputError("image_sequence_invalid_lane", `Image sequence ${clip.asset_id} is only supported on the video lane`, clip.asset_id);
        }
      }
    }
  }
  if (!projectDir) {
    if (clipImageIds.size > 0) throw new CanonicalRenderInputError("image_project_root_unresolved", "Image timeline requires a standard 05_timeline path or projectDir");
    if (clipSequenceIds.size > 0) throw new CanonicalRenderInputError("sequence_project_root_unresolved", "Image-sequence timeline requires a standard 05_timeline path or projectDir");
    return { projectDir: "", byAssetId: new Map(), imageAssetIds: clipImageIds, sequenceAssetIds: clipSequenceIds };
  }

  const assetsPath = path.join(projectDir, "03_analysis", "assets.json");
  const assetsRaw = fs.existsSync(assetsPath)
    ? JSON.parse(fs.readFileSync(assetsPath, "utf8")) as { items?: RenderAsset[]; assets?: RenderAsset[] }
    : {};
  const assets = new Map<string, RenderAsset>();
  for (const asset of assetsRaw.items ?? assetsRaw.assets ?? []) {
    if (typeof asset.asset_id === "string") assets.set(asset.asset_id, asset);
  }
  const sourceMap = loadSourceMap(projectDir);
  const byAssetId = new Map<string, CanonicalRenderInput>();
  const imageAssetIds = new Set(clipImageIds);
  const sequenceAssetIds = new Set(clipSequenceIds);

  const assetUses = timelineAssetUses(timeline, options.includeVideo !== false, options.includeAudio !== false);
  for (const assetId of [...assetUses.keys()].sort()) {
    const asset = assets.get(assetId);
    const source = sourceMap.entryMap.get(assetId);
    const sequence = asset?.media_kind === "sequence" || source?.media_kind === "sequence" || clipSequenceIds.has(assetId);
    const image = !sequence && isImageMediaTruth(asset, source, clipImageIds.has(assetId) ? "image" : undefined);
    if (sequence) sequenceAssetIds.add(assetId);
    if (image) imageAssetIds.add(assetId);
    if (image && [...(assetUses.get(assetId) ?? [])].some((lane) => lane !== "video")) {
      throw new CanonicalRenderInputError("still_image_invalid_lane", `Image ${assetId} is only supported on the video lane`, assetId);
    }
    if (sequence && [...(assetUses.get(assetId) ?? [])].some((lane) => lane !== "video")) {
      throw new CanonicalRenderInputError("image_sequence_invalid_lane", `Image sequence ${assetId} is only supported on the video lane`, assetId);
    }
    if (sequence) {
      if (!asset) throw new CanonicalRenderInputError("image_sequence_identity_missing", `No authoritative sequence asset for ${assetId}; re-ingest required`, assetId);
      if (!source) throw new CanonicalRenderInputError("source_map_entry_missing", `No source-map entry for ${assetId}`, assetId);
      const sequenceMetadata = asset.image_sequence;
      const producer = typeof sequenceMetadata?.normalization_producer === "string" ? sequenceMetadata.normalization_producer.trim() : "";
      const producerVersion = typeof sequenceMetadata?.normalization_producer_version === "string" ? sequenceMetadata.normalization_producer_version.trim() : "";
      const groupingProducer = typeof sequenceMetadata?.grouping_producer === "string" ? sequenceMetadata.grouping_producer.trim() : "";
      const groupingVersion = typeof sequenceMetadata?.grouping_producer_version === "string" ? sequenceMetadata.grouping_producer_version.trim() : "";
      if (producer !== "ffmpeg-image-sequence-normalizer" || producerVersion !== "1" ||
        groupingProducer !== "image-sequence-grouper" || groupingVersion !== "1") {
        throw new CanonicalRenderInputError("image_sequence_normalization_producer_mismatch", `Unsupported image-sequence producer contract for ${assetId}; re-ingest required`, assetId);
      }
      const original = resolveSequenceSourceSet(projectDir, assetId, asset, source.image_sequence);
      const declaredProxyHash = sha(sequenceMetadata?.analysis_proxy_content_sha256);
      const assetProxyHash = sha(asset.source_content_sha256);
      const sourceProxyHash = sha(source.source_content_sha256);
      if (!declaredProxyHash || assetProxyHash !== declaredProxyHash || sourceProxyHash !== declaredProxyHash ||
        sequenceMetadata?.analysis_proxy_frame_count !== original.frameCount) {
        throw new CanonicalRenderInputError("image_sequence_identity_missing", `Sequence proxy identity disagrees across canonical artifacts for ${assetId}; re-ingest required`, assetId);
      }
      const proxy = secureSequenceProxy(projectDir, assetId, sequenceMetadata?.analysis_proxy_path);
      const liveProxyHash = sha256FileHex(proxy.absolute);
      if (liveProxyHash !== declaredProxyHash) {
        throw new CanonicalRenderInputError("image_sequence_proxy_hash_mismatch", `Normalized sequence proxy SHA-256 changed for ${assetId}; re-ingest required`, assetId);
      }
      try {
        if (!source.source_locator || fs.realpathSync(source.source_locator) !== proxy.absolute) {
          throw new CanonicalRenderInputError("image_sequence_identity_missing", `Sequence source-map locator does not resolve to the canonical proxy for ${assetId}; re-ingest required`, assetId);
        }
      } catch (error) {
        if (error instanceof CanonicalRenderInputError) throw error;
        throw new CanonicalRenderInputError("source_missing", `Sequence source-map locator is missing for ${assetId}`, assetId);
      }
      byAssetId.set(assetId, {
        assetId,
        mediaKind: "sequence",
        originalSourcePath: original.framePaths[0],
        originalContentSha256: original.frameSetContentSha256,
        originalFramePaths: original.framePaths,
        originalFrameSetContentSha256: original.frameSetContentSha256,
        frameCount: original.frameCount,
        renderInputPath: proxy.absolute,
        renderInputContentSha256: liveProxyHash,
        relationship: NORMALIZED_SEQUENCE_RELATIONSHIP,
        analysisPath: proxy.analysisPath,
        normalizationProducer: producer,
        normalizationProducerVersion: producerVersion,
      });
      continue;
    }
    if (!image) continue;
    if (!source) throw new CanonicalRenderInputError("source_map_entry_missing", `No source-map entry for ${assetId}`, assetId);
    const originalPath = source.source_locator;
    if (!originalPath || !fs.existsSync(originalPath) || !fs.statSync(originalPath).isFile()) {
      throw new CanonicalRenderInputError("source_missing", `Original source is missing for ${assetId}`, assetId);
    }
    const originalHash = sha256FileHex(originalPath);
    const declaredOriginal = sha(asset?.source_content_sha256 ?? source.source_content_sha256);
    if (image && !declaredOriginal) {
      throw new CanonicalRenderInputError("still_image_original_identity_missing", `Image ${assetId} lacks its full original SHA-256; re-ingest required`, assetId);
    }
    if (image && declaredOriginal && declaredOriginal !== originalHash) {
      throw new CanonicalRenderInputError("still_image_original_hash_mismatch", `Original source SHA-256 changed for ${assetId}; re-ingest required`, assetId);
    }
    const still = asset?.still_image;
    const normalizedHash = sha(still?.normalized_frame_content_sha256);
    const producer = typeof still?.normalization_producer === "string" ? still.normalization_producer.trim() : "";
    const producerVersion = typeof still?.normalization_producer_version === "string" ? still.normalization_producer_version.trim() : "";
    if (!still || !normalizedHash || !producer || !producerVersion) {
      throw new CanonicalRenderInputError("still_image_identity_missing", `Image ${assetId} lacks C2B normalized-frame identity; re-ingest required`, assetId);
    }
    if (!SUPPORTED_STILL_NORMALIZATION_PRODUCERS.has(producer) || producerVersion !== "1") {
      throw new CanonicalRenderInputError("still_image_normalization_producer_mismatch", `Unsupported normalization producer ${producer}@${producerVersion} for ${assetId}; re-ingest required`, assetId);
    }
    const normalized = secureNormalizedFrame(projectDir, assetId, still.normalized_frame_path);
    const liveNormalizedHash = sha256FileHex(normalized.absolute);
    if (liveNormalizedHash !== normalizedHash) {
      throw new CanonicalRenderInputError("still_image_normalized_hash_mismatch", `Normalized frame SHA-256 changed for ${assetId}; re-ingest required`, assetId);
    }
    byAssetId.set(assetId, {
      assetId, mediaKind: "image", originalSourcePath: originalPath, originalContentSha256: originalHash,
      renderInputPath: normalized.absolute, renderInputContentSha256: liveNormalizedHash,
      relationship: NORMALIZED_STILL_RELATIONSHIP, analysisPath: normalized.analysisPath,
      normalizationProducer: producer, normalizationProducerVersion: producerVersion,
    });
  }
  return { projectDir, byAssetId, imageAssetIds, sequenceAssetIds };
}

/**
 * Materialize renderer-facing derived bytes after the read-only identity resolver
 * has validated the analysis artifact. Renderers must use the returned paths
 * and dispose the set in a finally block. Identity/freshness callers must keep
 * using resolveCanonicalRenderInputs directly so they never create temp files.
 */
export function materializeVerifiedStillSnapshots(
  canonicalInputs: CanonicalRenderInputSet,
  options: MaterializeVerifiedStillSnapshotOptions = {},
): VerifiedStillSnapshotSet {
  if (canonicalInputs.imageAssetIds.size === 0 && canonicalInputs.sequenceAssetIds.size === 0) {
    return {
      projectDir: canonicalInputs.projectDir,
      byAssetId: new Map([...canonicalInputs.byAssetId].map(([assetId, input]) => [assetId, { ...input }])),
      imageAssetIds: new Set(),
      sequenceAssetIds: new Set(canonicalInputs.sequenceAssetIds),
      snapshotRoot: "",
      dispose: () => undefined,
    };
  }
  const tempRoot = options.tempRoot ?? os.tmpdir();
  const snapshotRoot = fs.mkdtempSync(path.join(tempRoot, "vos-still-render-inputs-"));
  fs.chmodSync(snapshotRoot, 0o700);
  let disposed = false;
  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    fs.rmSync(snapshotRoot, { recursive: true, force: true });
  };
  const byAssetId = new Map<string, CanonicalRenderInput>();
  const copyFile = options.copyFileImpl ?? ((source: string, destination: string) => {
    fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
  });
  let stillIndex = 0;

  try {
    for (const [assetId, input] of canonicalInputs.byAssetId) {
      if (input.relationship !== NORMALIZED_STILL_RELATIONSHIP && input.relationship !== NORMALIZED_SEQUENCE_RELATIONSHIP) {
        byAssetId.set(assetId, { ...input });
        continue;
      }
      const extension = path.extname(input.renderInputPath).toLowerCase();
      const safeExtension = /^\.[a-z0-9]{1,8}$/.test(extension) ? extension : ".bin";
      const safeAssetId = assetId.replace(/[^a-z0-9_-]/gi, "_");
      const assetIdHash = createHash("sha256").update(assetId).digest("hex").slice(0, 16);
      const snapshotPath = path.join(
        snapshotRoot,
        `${String(stillIndex).padStart(4, "0")}-${safeAssetId.slice(0, 48)}-${assetIdHash}-${input.renderInputContentSha256}${safeExtension}`,
      );
      stillIndex += 1;
      copyFile(input.renderInputPath, snapshotPath);
      const snapshotStat = fs.lstatSync(snapshotPath);
      if (snapshotStat.isSymbolicLink() || !snapshotStat.isFile() || snapshotStat.size <= 0) {
        throw new CanonicalRenderInputError(
          input.relationship === NORMALIZED_SEQUENCE_RELATIONSHIP ? "image_sequence_snapshot_invalid" : "still_image_snapshot_invalid",
          `Verified derived snapshot is empty, non-regular, or a symlink for ${assetId}`,
          assetId,
        );
      }
      fs.chmodSync(snapshotPath, 0o600);
      const snapshotHash = sha256FileHex(snapshotPath);
      if (snapshotHash !== input.renderInputContentSha256) {
        throw new CanonicalRenderInputError(
          input.relationship === NORMALIZED_SEQUENCE_RELATIONSHIP ? "image_sequence_snapshot_hash_mismatch" : "still_image_snapshot_hash_mismatch",
          `Normalized render input changed while creating the verified snapshot for ${assetId}`,
          assetId,
        );
      }
      byAssetId.set(assetId, {
        ...input,
        renderInputPath: snapshotPath,
      });
    }
  } catch (error) {
    dispose();
    if (error instanceof CanonicalRenderInputError) throw error;
    throw new CanonicalRenderInputError(
      "still_image_snapshot_invalid",
      `Could not create a verified derived snapshot: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  return {
    projectDir: canonicalInputs.projectDir,
    byAssetId,
    imageAssetIds: new Set(canonicalInputs.imageAssetIds),
    sequenceAssetIds: new Set(canonicalInputs.sequenceAssetIds),
    snapshotRoot,
    dispose,
  };
}
