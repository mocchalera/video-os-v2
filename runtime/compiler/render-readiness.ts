/**
 * Render source readiness (Issue #6 P1).
 *
 * Resolves every asset ID referenced by the final timeline back to a source
 * path and reports unresolved, missing, hash-mismatched, or unreadable
 * sources before a render process can start. External (out-of-project)
 * references are recorded with their canonical source root and a read-only
 * authority flag so relinking never mutates operator media.
 *
 * The report is the single source mapping contract shared by the preview
 * manifest and the render route: both stamp/compare `source_mapping_hash`,
 * so a relink after compile is detectable without opening timeline.json.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { loadSourceMap, type LoadedSourceMap, type MediaSourceMapEntry } from "../media/source-map.js";
import type { ClipOutput, TimelineIR } from "./types.js";

export type RenderSourceStatus =
  | "resolved"
  | "unresolved"
  | "missing"
  | "hash_mismatch"
  | "permission_denied";

export interface RenderSourceResolution {
  asset_id: string;
  status: RenderSourceStatus;
  source_path?: string;
  expected_sha256?: string;
  actual_sha256?: string;
  issue?: string;
}

export interface ExternalSourceAuthority {
  canonical_source_root: string;
  asset_ids: string[];
  read_only_authority: true;
}

export interface RenderSourceReadinessReport {
  version: "1";
  project_id: string;
  generated_at: string;
  /** Identity of the source mapping this resolution was built from. */
  source_mapping_hash: string;
  status: "ready" | "blocked";
  resolved_count: number;
  blocked_count: number;
  resolutions: RenderSourceResolution[];
  external_sources: ExternalSourceAuthority[];
}

/**
 * Source authority emitted from the validated formal SFX cue plan. The map is
 * keyed by the projected A3 clip id, not by arbitrary clip metadata or asset
 * id, so only the compiler's validated sfx-cues/library projection can use it.
 */
export interface FormalSfxSourceAuthority {
  cue_id: string;
  asset_id: string;
  semantic_role: string;
  source_path: string;
  expected_sha256: string;
  authority_root: string;
  sfx_asset: {
    asset_id: string;
    source_path: string;
    library_id: string;
    library_version: string;
    library_manifest_hash: string;
    library_scope: "repo_common" | "project_local";
    asset_content_hash: string;
  };
}

export class RenderSourceUnresolvedError extends Error {
  readonly code = "RENDER_SOURCE_UNRESOLVED" as const;
  readonly report: RenderSourceReadinessReport;

  constructor(report: RenderSourceReadinessReport) {
    const issues = report.resolutions
      .filter((resolution) => resolution.status !== "resolved")
      .map((resolution) =>
        `${resolution.asset_id}: ${resolution.status}${resolution.issue ? ` (${resolution.issue})` : ""}`,
      )
      .join("; ");
    super(`Render sources are not ready (${report.blocked_count} blocked): ${issues}`);
    this.name = "RenderSourceUnresolvedError";
    this.report = report;
  }
}

export interface BuildRenderSourceReadinessOptions {
  projectPath: string;
  projectId: string;
  createdAt: string;
  timeline: Pick<TimelineIR, "tracks">;
  sourceMap: LoadedSourceMap;
  /** Validated formal SFX sources, keyed by projected clip id. */
  formalSfxSources?: ReadonlyMap<string, FormalSfxSourceAuthority>;
}

/** Stable identity of the source mapping used for a compile. */
export function computeSourceMappingHash(
  entries: Array<Pick<MediaSourceMapEntry, "asset_id" | "local_source_path" | "source_content_sha256">>,
): string {
  const canonical = entries
    .map((entry) => ({
      asset_id: entry.asset_id,
      local_source_path: entry.local_source_path,
      source_content_sha256: entry.source_content_sha256 ?? null,
    }))
    .sort((left, right) => left.asset_id.localeCompare(right.asset_id));
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(canonical))
    .digest("hex")
    .slice(0, 16);
}

export function collectTimelineAssetIds(timeline: Pick<TimelineIR, "tracks">): string[] {
  const ids = new Set<string>();
  for (const track of [...timeline.tracks.video, ...timeline.tracks.audio]) {
    for (const clip of track.clips) ids.add(clip.asset_id);
  }
  return [...ids].sort((left, right) => left.localeCompare(right));
}

/**
 * Resolve every timeline asset to its render source. Per-asset problems are
 * collected into the report; this function only throws on malformed input.
 */
export function buildRenderSourceReadiness(
  options: BuildRenderSourceReadinessOptions,
): RenderSourceReadinessReport {
  const projectRealPath = realpathIfExists(options.projectPath) ?? path.resolve(options.projectPath);
  const assetIds = collectTimelineAssetIds(options.timeline);
  const resolutions: RenderSourceResolution[] = [];
  const externalByRoot = new Map<string, Set<string>>();

  for (const assetId of assetIds) {
    const formalSfxSource = resolveFormalSfxSource(
      options.timeline,
      assetId,
      options.formalSfxSources,
    );
    const entry = options.sourceMap.entryMap.get(assetId);
    if (!entry && !formalSfxSource) {
      resolutions.push({
        asset_id: assetId,
        status: "unresolved",
        issue: "no source-map entry for asset",
      });
      continue;
    }

    const sourcePath = formalSfxSource?.source_path
      ?? entry?.local_source_path
      ?? entry?.source_locator;
    if (!sourcePath) {
      resolutions.push({
        asset_id: assetId,
        status: "unresolved",
        issue: "source-map entry has no local_source_path or source_locator",
      });
      continue;
    }

    const expectedSha256 = formalSfxSource
      ? normalizeHash(formalSfxSource.expected_sha256)
      : entry?.source_content_sha256
        ? normalizeHash(entry.source_content_sha256)
        : undefined;

    let formalAuthorityRoot: string | undefined;
    if (formalSfxSource) {
      if (!expectedSha256 || !/^[0-9a-f]{64}$/u.test(expectedSha256)) {
        resolutions.push({
          asset_id: assetId,
          status: "unresolved",
          source_path: sourcePath,
          issue: "formal SFX source has no valid content hash",
        });
        continue;
      }
      formalAuthorityRoot = realpathIfExists(formalSfxSource.authority_root);
      if (!formalAuthorityRoot) {
        resolutions.push({
          asset_id: assetId,
          status: "unresolved",
          source_path: sourcePath,
          ...(expectedSha256 ? { expected_sha256: expectedSha256 } : {}),
          issue: "formal SFX authority root is missing",
        });
        continue;
      }
      if (!path.isAbsolute(sourcePath) || !isContained(formalAuthorityRoot, path.resolve(sourcePath))) {
        resolutions.push({
          asset_id: assetId,
          status: "unresolved",
          source_path: sourcePath,
          ...(expectedSha256 ? { expected_sha256: expectedSha256 } : {}),
          issue: "formal SFX source path escapes its authority root",
        });
        continue;
      }
    }

    let stat: fs.Stats;
    try {
      stat = fs.statSync(sourcePath);
    } catch (error) {
      resolutions.push({
        asset_id: assetId,
        status: "missing",
        source_path: sourcePath,
        ...(expectedSha256 ? { expected_sha256: expectedSha256 } : {}),
        issue: `${(error as NodeJS.ErrnoException).code ?? "unknown"}: cannot stat source`,
      });
      continue;
    }
    if (!stat.isFile()) {
      resolutions.push({
        asset_id: assetId,
        status: "missing",
        source_path: sourcePath,
        issue: "source is not a regular file",
      });
      continue;
    }

    try {
      fs.accessSync(sourcePath, fs.constants.R_OK);
    } catch (error) {
      resolutions.push({
        asset_id: assetId,
        status: "permission_denied",
        source_path: sourcePath,
        issue: `not readable: ${(error as NodeJS.ErrnoException).code ?? "unknown"}`,
      });
      continue;
    }

    if (formalSfxSource) {
      const realSourcePath = realpathIfExists(sourcePath);
      if (!realSourcePath || !formalAuthorityRoot || !isContained(formalAuthorityRoot, realSourcePath)) {
        resolutions.push({
          asset_id: assetId,
          status: "unresolved",
          source_path: sourcePath,
          ...(expectedSha256 ? { expected_sha256: expectedSha256 } : {}),
          issue: "formal SFX source resolves outside its authority root",
        });
        continue;
      }
    }

    if (expectedSha256) {
      const expected = expectedSha256;
      const actual = hashFile(sourcePath);
      if (actual !== expected) {
        resolutions.push({
          asset_id: assetId,
          status: "hash_mismatch",
          source_path: sourcePath,
          expected_sha256: expected,
          actual_sha256: actual,
          issue: "source content changed since ingest",
        });
        continue;
      }
      resolutions.push({
        asset_id: assetId,
        status: "resolved",
        source_path: sourcePath,
        expected_sha256: expected,
        actual_sha256: actual,
      });
    } else {
      resolutions.push({
        asset_id: assetId,
        status: "resolved",
        source_path: sourcePath,
      });
    }

    if (isExternalPath(projectRealPath, sourcePath)) {
      const root = formalSfxSource && formalAuthorityRoot
        ? formalAuthorityRoot
        : path.dirname(sourcePath);
      const bucket = externalByRoot.get(root) ?? new Set<string>();
      bucket.add(assetId);
      externalByRoot.set(root, bucket);
    }
  }

  const blocked = resolutions.filter((resolution) => resolution.status !== "resolved");
  const external_sources: ExternalSourceAuthority[] = [...externalByRoot.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([root, assetIds]) => ({
      canonical_source_root: root,
      asset_ids: [...assetIds].sort((left, right) => left.localeCompare(right)),
      read_only_authority: true as const,
    }));

  return {
    version: "1",
    project_id: options.projectId,
    generated_at: options.createdAt,
    source_mapping_hash: computeSourceMappingHash(options.sourceMap.entries),
    status: blocked.length === 0 ? "ready" : "blocked",
    resolved_count: resolutions.length - blocked.length,
    blocked_count: blocked.length,
    resolutions,
    external_sources,
  };
}

function resolveFormalSfxSource(
  timeline: Pick<TimelineIR, "tracks">,
  assetId: string,
  sources: ReadonlyMap<string, FormalSfxSourceAuthority> | undefined,
): FormalSfxSourceAuthority | undefined {
  if (!sources || sources.size === 0) return undefined;

  const references = [...timeline.tracks.video, ...timeline.tracks.audio]
    .flatMap((track) => track.clips
      .filter((clip) => clip.asset_id === assetId)
      .map((clip) => ({ trackId: track.track_id, clip })));
  if (references.length === 0 || references.some((reference) => reference.trackId !== "A3")) {
    return undefined;
  }

  const authorities = references.map((reference) => sources.get(reference.clip.clip_id));
  if (authorities.some((authority, index) =>
    authority === undefined
    || !matchesFormalSfxProjection(references[index].clip, authority)
  )) return undefined;
  const first = authorities[0]!;
  if (authorities.some((authority) =>
    authority!.asset_id !== first.asset_id
    || authority!.source_path !== first.source_path
    || authority!.expected_sha256 !== first.expected_sha256
    || authority!.authority_root !== first.authority_root
  )) {
    return undefined;
  }
  return first.asset_id === assetId ? first : undefined;
}

function matchesFormalSfxProjection(
  clip: ClipOutput,
  authority: FormalSfxSourceAuthority,
): boolean {
  if (
    clip.clip_id !== `A3_${authority.cue_id}`
    || clip.segment_id !== authority.cue_id
    || clip.asset_id !== authority.asset_id
    || clip.role !== "sfx"
    || clip.audio_role !== "sfx"
  ) return false;

  const metadata = clip.metadata as Record<string, unknown> | undefined;
  const cue = asRecord(metadata?.sfx_cue);
  const asset = asRecord(metadata?.sfx_asset);
  if (!cue || !asset) return false;

  return cue.cue_id === authority.cue_id
    && cue.semantic_role === authority.semantic_role
    && asset.asset_id === authority.sfx_asset.asset_id
    && asset.source_path === authority.sfx_asset.source_path
    && asset.library_id === authority.sfx_asset.library_id
    && asset.library_version === authority.sfx_asset.library_version
    && asset.library_manifest_hash === authority.sfx_asset.library_manifest_hash
    && asset.library_scope === authority.sfx_asset.library_scope
    && asset.asset_content_hash === authority.sfx_asset.asset_content_hash;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

/** Fail-closed gate: a blocked readiness report must stop the render route. */
export function assertRenderSourceReadiness(report: RenderSourceReadinessReport): void {
  if (report.status === "ready") return;
  throw new RenderSourceUnresolvedError(report);
}

// ── Source mapping contract (preview manifest ⇄ render route) ──────

export type SourceMappingContractState =
  | "exact"
  | "stale_relink"
  | "stale_manifest"
  | "legacy_timeline"
  | "legacy_manifest"
  | "missing_timeline"
  | "missing_manifest";

export interface SourceMappingContractStatus {
  state: SourceMappingContractState;
  current_mapping_hash: string | null;
  timeline_mapping_hash: string | null;
  manifest_mapping_hash: string | null;
  /** False when the on-disk source map changed after the timeline was compiled (relink). */
  timeline_matches_current_mapping: boolean;
  /** False when the preview manifest was built from a different mapping than the timeline. */
  manifest_matches_timeline_mapping: boolean;
  recommendation: string;
}

const MAPPING_RECOMMENDATIONS: Record<SourceMappingContractState, string> = {
  exact: "Preview manifest and render route share the current source mapping.",
  stale_relink: "Sources were relinked after compile. Re-evaluate timeline identity and recompile before rendering.",
  stale_manifest: "Preview manifest was built from a different source mapping than the timeline. Recompile to regenerate it.",
  legacy_timeline: "Timeline predates source mapping stamping. Recompile to bind playback to the current mapping.",
  legacy_manifest: "Preview manifest predates source mapping stamping. Recompile to make playback approval-grade.",
  missing_timeline: "No timeline.json. Compile the rough cut first.",
  missing_manifest: "No preview manifest. Compile the timeline to generate one.",
};

/**
 * Re-evaluate the shared source mapping after any relink: compares the hash
 * stamped into timeline.json and preview-manifest.json against the current
 * source_map.json so staleness surfaces before render starts.
 */
export function evaluateSourceMappingContract(
  projectDir: string,
  options?: { sourceMap?: LoadedSourceMap; timelineMappingHash?: string | null },
): SourceMappingContractStatus {
  const timelinePath = path.join(projectDir, "05_timeline/timeline.json");
  const manifestPath = path.join(projectDir, "05_timeline/preview-manifest.json");

  const build = (
    state: SourceMappingContractState,
    fields: Partial<SourceMappingContractStatus> = {},
  ): SourceMappingContractStatus => ({
    state,
    current_mapping_hash: null,
    timeline_mapping_hash: null,
    manifest_mapping_hash: null,
    timeline_matches_current_mapping: false,
    manifest_matches_timeline_mapping: false,
    recommendation: MAPPING_RECOMMENDATIONS[state],
    ...fields,
  });

  const currentHash = computeSourceMappingHash(
    (options?.sourceMap ?? loadSourceMapLenient(projectDir)).entries,
  );

  if (options?.timelineMappingHash !== undefined) {
    if (options.timelineMappingHash === null) {
      return build("legacy_timeline", { current_mapping_hash: currentHash });
    }
    return classifyMappingContract(currentHash, options.timelineMappingHash, manifestPath, build);
  }

  if (!fs.existsSync(timelinePath)) return build("missing_timeline");
  const timelineHash = readStampedMappingHash(timelinePath);
  if (!timelineHash) return build("legacy_timeline", { current_mapping_hash: currentHash });
  return classifyMappingContract(currentHash, timelineHash, manifestPath, build);
}

function classifyMappingContract(
  currentHash: string,
  timelineHash: string,
  manifestPath: string,
  build: (
    state: SourceMappingContractState,
    fields?: Partial<SourceMappingContractStatus>,
  ) => SourceMappingContractStatus,
): SourceMappingContractStatus {
  const manifestExists = fs.existsSync(manifestPath);
  const manifestHash = manifestExists ? readStampedMappingHash(manifestPath) : null;
  if (!manifestHash) {
    return build(manifestExists ? "legacy_manifest" : "missing_manifest", {
      current_mapping_hash: currentHash,
      timeline_mapping_hash: timelineHash,
      timeline_matches_current_mapping: timelineHash === currentHash,
    });
  }

  const timelineMatchesCurrent = timelineHash === currentHash;
  const manifestMatchesTimeline = manifestHash === timelineHash;
  const state: SourceMappingContractState =
    !manifestMatchesTimeline ? "stale_manifest"
    : !timelineMatchesCurrent ? "stale_relink"
    : "exact";

  return build(state, {
    current_mapping_hash: currentHash,
    timeline_mapping_hash: timelineHash,
    manifest_mapping_hash: manifestHash,
    timeline_matches_current_mapping: timelineMatchesCurrent,
    manifest_matches_timeline_mapping: manifestMatchesTimeline,
  });
}

export class SourceMappingStaleError extends Error {
  readonly code = "SOURCE_MAPPING_STALE" as const;
  readonly status: SourceMappingContractStatus;

  constructor(status: SourceMappingContractStatus) {
    super(`Source mapping contract is ${status.state}: ${status.recommendation}`);
    this.name = "SourceMappingStaleError";
    this.status = status;
  }
}

/**
 * Fail-closed render gate: refuse to start a render when the timeline or the
 * preview manifest was built against a different source mapping than the one
 * currently on disk (a relink happened after compile).
 */
export function assertRenderMappingFresh(
  projectDir: string,
  options?: { sourceMap?: LoadedSourceMap; timelineMappingHash?: string | null },
): SourceMappingContractStatus {
  const status = evaluateSourceMappingContract(projectDir, options);
  if (status.state === "stale_relink" || status.state === "stale_manifest") {
    throw new SourceMappingStaleError(status);
  }
  return status;
}

/** Read the `metadata.source_mapping_hash` stamp from a timeline JSON file. */
export function readSourceMappingStamp(filePath: string): string | null {
  return readStampedMappingHash(filePath);
}

function loadSourceMapLenient(projectDir: string): LoadedSourceMap {
  try {
    return loadSourceMap(projectDir);
  } catch {
    return { locatorMap: new Map(), entryMap: new Map(), entries: [] };
  }
}

function readStampedMappingHash(filePath: string): string | null {
  try {
    const doc = JSON.parse(fs.readFileSync(filePath, "utf-8")) as {
      metadata?: Record<string, unknown>;
      source_mapping_hash?: unknown;
    };
    const value = doc.metadata?.source_mapping_hash ?? doc.source_mapping_hash;
    return typeof value === "string" && value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

function isContained(parentPath: string, childPath: string): boolean {
  const relative = path.relative(parentPath, childPath);
  return relative === ""
    || (
      relative !== ".."
      && !relative.startsWith(`..${path.sep}`)
      && !path.isAbsolute(relative)
    );
}

function isExternalPath(projectRealPath: string, sourcePath: string): boolean {
  const realSource = realpathIfExists(sourcePath) ?? sourcePath;
  const relative = path.relative(projectRealPath, realSource);
  return relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative);
}

function realpathIfExists(targetPath: string): string | undefined {
  try {
    return fs.realpathSync(targetPath);
  } catch {
    return undefined;
  }
}

function normalizeHash(value: string): string {
  return value.replace(/^sha256:/, "").toLowerCase();
}

function hashFile(filePath: string): string {
  const hash = crypto.createHash("sha256");
  const fd = fs.openSync(filePath, "r");
  const buffer = Buffer.allocUnsafe(8 * 1024 * 1024);
  try {
    let bytesRead = 0;
    do {
      bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (bytesRead > 0) hash.update(buffer.subarray(0, bytesRead));
    } while (bytesRead > 0);
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest("hex");
}
