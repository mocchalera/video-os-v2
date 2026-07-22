import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { parse as parseYaml } from "yaml";
import { computeNormalizedJsonHash } from "../artifacts/p1-manifest-coverage.js";
import type { BgmCatalog, CatalogTrack } from "./pack-types.js";

export type BgmOutputScope = "preview_internal" | "external" | "public_redistribution" | "commercial";

export interface ProjectSelectionSources {
  project_id: string;
  creative_brief: unknown;
  edit_blueprint: unknown;
  timeline: unknown;
  timeline_summary: Record<string, number>;
  input_hashes: {
    creative_brief: string;
    edit_blueprint: string;
    timeline: string;
    catalog: string;
  };
}

export interface SelectionRightsEvidence {
  status: string;
  content_hash_matches: boolean;
  integrity_verified: boolean;
  permitted_scopes: string[];
  expired: boolean;
  allowed: boolean;
  warnings: string[];
}

export interface PreparedCatalogCandidate {
  track: CatalogTrack;
  integrity_ok: boolean;
  rights_allowed: boolean;
  installed: boolean;
  readable: boolean;
  codec_supported: boolean;
  analysis?: Record<string, unknown>;
  rights: SelectionRightsEvidence;
  usage_count_90d: number;
  usage_penalty: number;
}

export interface PreparedCatalogEvidence {
  candidates: PreparedCatalogCandidate[];
  analysis_hashes: Array<{ track_id: string; analysis_hash: string }>;
  warnings: string[];
}

export class BgmSelectionInputError extends Error {
  constructor(
    public readonly code: "BGM_SELECTION_INPUT_MISSING" | "BGM_SELECTION_INPUT_INVALID",
    public readonly affected_ref: string,
    message: string,
  ) {
    super(message);
    this.name = "BgmSelectionInputError";
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function fileHash(bytes: Buffer): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function readRequired(projectPath: string, relativePath: string, format: "yaml" | "json"): { value: unknown; hash: string } {
  const filePath = path.join(projectPath, relativePath);
  if (!fs.existsSync(filePath)) {
    throw new BgmSelectionInputError("BGM_SELECTION_INPUT_MISSING", relativePath, "A canonical BGM selection input is missing.");
  }
  try {
    const bytes = fs.readFileSync(filePath);
    const value = format === "yaml" ? parseYaml(bytes.toString("utf8")) : JSON.parse(bytes.toString("utf8"));
    return { value, hash: fileHash(bytes) };
  } catch {
    throw new BgmSelectionInputError("BGM_SELECTION_INPUT_INVALID", relativePath, "A canonical BGM selection input could not be parsed.");
  }
}

function timelineTracks(timeline: unknown): unknown[] {
  const tracks = record(record(timeline)?.tracks);
  if (!tracks) return [];
  return [
    ...(Array.isArray(tracks.video) ? tracks.video : []),
    ...(Array.isArray(tracks.audio) ? tracks.audio : []),
  ];
}

function mergeIntervals(intervals: Array<[number, number]>): number {
  const ordered = intervals
    .filter(([start, end]) => start >= 0 && end > start)
    .sort(([aStart, aEnd], [bStart, bEnd]) => aStart - bStart || aEnd - bEnd);
  let total = 0;
  let currentStart = -1;
  let currentEnd = -1;
  for (const [start, end] of ordered) {
    if (currentStart < 0) {
      currentStart = start;
      currentEnd = end;
    } else if (start <= currentEnd) {
      currentEnd = Math.max(currentEnd, end);
    } else {
      total += currentEnd - currentStart;
      currentStart = start;
      currentEnd = end;
    }
  }
  if (currentStart >= 0) total += currentEnd - currentStart;
  return total;
}

/** Derive only timing facts; editorial meaning remains owned by the canonical artifacts. */
export function summarizeTimelineForBgm(timeline: unknown): Record<string, number> {
  const root = record(timeline);
  const sequence = record(root?.sequence);
  const fpsNum = number(sequence?.fps_num) ?? 30;
  const fpsDen = number(sequence?.fps_den) ?? 1;
  const framesToUs = (frames: number): number => Math.round(frames * 1_000_000 * fpsDen / fpsNum);
  let durationFrames = 0;
  let videoCutCount = 0;
  const dialogueIntervals: Array<[number, number]> = [];

  for (const trackValue of timelineTracks(timeline)) {
    const track = record(trackValue);
    const clips = Array.isArray(track?.clips) ? track.clips : [];
    const isVideo = track?.kind === "video";
    if (isVideo) videoCutCount += clips.length;
    for (const clipValue of clips) {
      const clip = record(clipValue);
      const start = number(clip?.timeline_in_frame);
      const length = number(clip?.timeline_duration_frames);
      if (start === undefined || length === undefined || length <= 0) continue;
      durationFrames = Math.max(durationFrames, start + length);
      if (track?.kind === "audio" && track?.track_id !== "A2" && clip?.role === "dialogue") {
        dialogueIntervals.push([start, start + length]);
      }
    }
  }

  const explicitDuration = number(root?.duration_frames);
  if (explicitDuration !== undefined) durationFrames = Math.max(durationFrames, explicitDuration);
  const durationUs = Math.max(1, framesToUs(durationFrames));
  const speechDurationUs = framesToUs(mergeIntervals(dialogueIntervals));
  return {
    duration_us: durationUs,
    speech_duration_us: speechDurationUs,
    speech_ratio: Math.min(1, Math.max(0, speechDurationUs / durationUs)),
    cut_count: videoCutCount,
  };
}

function projectId(brief: unknown, timeline: unknown, projectPath: string): string {
  const fromBrief = record(brief)?.project_id;
  const fromTimeline = record(timeline)?.project_id;
  if (typeof fromBrief === "string" && fromBrief.length > 0) return fromBrief;
  if (typeof fromTimeline === "string" && fromTimeline.length > 0) return fromTimeline;
  return path.basename(path.resolve(projectPath));
}

function catalogIdentity(catalog: BgmCatalog): unknown {
  return catalog.tracks.map((entry) => ({
    pack_id: entry.pack_id,
    pack_version: entry.pack_version,
    manifest_hash: entry.manifest_hash,
    track_id: entry.track.track_id,
    content_hash: entry.track.full_mix.content_hash,
    rights_hash: entry.track.rights_ref.content_hash,
    analysis_hash: entry.track.analysis_ref.content_hash,
    family: entry.track.family,
    intensity: entry.track.intensity,
    axes: entry.track.axes,
  }));
}

export function loadProjectSelectionSources(projectPath: string, catalog: BgmCatalog): ProjectSelectionSources {
  const absoluteProjectPath = path.resolve(projectPath);
  const brief = readRequired(absoluteProjectPath, "01_intent/creative_brief.yaml", "yaml");
  const blueprint = readRequired(absoluteProjectPath, "04_plan/edit_blueprint.yaml", "yaml");
  const timeline = readRequired(absoluteProjectPath, "05_timeline/timeline.json", "json");
  return {
    project_id: projectId(brief.value, timeline.value, absoluteProjectPath),
    creative_brief: brief.value,
    edit_blueprint: blueprint.value,
    timeline: timeline.value,
    timeline_summary: summarizeTimelineForBgm(timeline.value),
    input_hashes: {
      creative_brief: brief.hash,
      edit_blueprint: blueprint.hash,
      timeline: timeline.hash,
      catalog: computeNormalizedJsonHash(catalogIdentity(catalog)),
    },
  };
}

function readStructured(filePath: string): Record<string, unknown> | undefined {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = path.extname(filePath).toLowerCase() === ".json" ? JSON.parse(raw) : parseYaml(raw);
    return record(parsed);
  } catch {
    return undefined;
  }
}

function rightsForTrack(
  document: Record<string, unknown> | undefined,
  track: CatalogTrack,
  requiredScopes: readonly string[],
  requireLicensed: boolean,
  now: Date,
): SelectionRightsEvidence {
  const items = Array.isArray(document?.items) ? document.items : [];
  const item = items.map(record).find((entry) => entry?.asset_id === track.track.track_id);
  const license = record(item?.license);
  const integrity = record(item?.integrity);
  const permittedScopes = Array.isArray(license?.permitted_scopes)
    ? license.permitted_scopes.filter((scope): scope is string => typeof scope === "string").sort()
    : [];
  const status = typeof item?.rights_status === "string" ? item.rights_status : "unknown";
  const contentHashMatches = item?.content_hash === track.track.full_mix.content_hash;
  const integrityVerified = integrity?.status === "verified" && integrity?.verified_hash === track.track.full_mix.content_hash;
  const expiresAt = typeof item?.expires_at === "string" ? Date.parse(item.expires_at) : Number.NaN;
  const expired = Number.isFinite(expiresAt) && expiresAt <= now.getTime();
  const statusAllowed = requireLicensed ? status === "licensed" : status === "licensed" || status === "operator_declared_ok";
  const scopesAllowed = requiredScopes.every((scope) => permittedScopes.includes(scope));
  const allowed = statusAllowed && contentHashMatches && integrityVerified && scopesAllowed && !expired;
  const warnings: string[] = [];
  if (!item) warnings.push("rights record missing");
  if (!statusAllowed) warnings.push("rights status does not satisfy requested output");
  if (!contentHashMatches || !integrityVerified) warnings.push("rights record is not hash-bound to the full mix");
  if (!scopesAllowed) warnings.push("license does not include every required scope");
  if (expired) warnings.push("rights record is expired");
  return {
    status,
    content_hash_matches: contentHashMatches,
    integrity_verified: integrityVerified,
    permitted_scopes: permittedScopes,
    expired,
    allowed,
    warnings: [...new Set(warnings)].sort(),
  };
}

export function prepareCatalogSelectionEvidence(
  catalog: BgmCatalog,
  options: {
    requiredScopes: readonly string[];
    requireLicensed: boolean;
    now: Date;
  },
): PreparedCatalogEvidence {
  const candidates: PreparedCatalogCandidate[] = [];
  const analysisHashes: Array<{ track_id: string; analysis_hash: string }> = [];
  const warnings: string[] = [];

  for (const track of catalog.tracks) {
    const pack = catalog.packs.find((candidate) => candidate.manifest.pack_id === track.pack_id
      && candidate.manifest.pack_version === track.pack_version
      && candidate.manifest_hash === track.manifest_hash);
    const assets = pack?.verification.verified_assets?.[track.track.track_id];
    const analysis = assets?.analysis_path ? readStructured(assets.analysis_path) : undefined;
    const rightsDocument = assets?.rights_path ? readStructured(assets.rights_path) : undefined;
    const rights = rightsForTrack(
      rightsDocument,
      track,
      options.requiredScopes,
      options.requireLicensed,
      options.now,
    );
    const readable = fs.existsSync(track.full_mix_path);
    if (!analysis) warnings.push(`${track.track.track_id}: analysis unavailable; authored metadata only`);
    warnings.push(...rights.warnings.map((warning) => `${track.track.track_id}: ${warning}`));
    analysisHashes.push({
      track_id: track.track.track_id,
      analysis_hash: typeof analysis?.analysis_hash === "string"
        ? analysis.analysis_hash
        : track.track.analysis_ref.content_hash,
    });
    candidates.push({
      track,
      integrity_ok: Boolean(pack?.verification.ok),
      rights_allowed: rights.allowed,
      installed: true,
      readable,
      codec_supported: true,
      ...(analysis ? { analysis } : {}),
      rights,
      usage_count_90d: 0,
      usage_penalty: 0,
    });
  }

  candidates.sort((left, right) => left.track.track.track_id.localeCompare(right.track.track.track_id)
    || left.track.track.full_mix.content_hash.localeCompare(right.track.track.full_mix.content_hash));
  analysisHashes.sort((left, right) => left.track_id.localeCompare(right.track_id)
    || left.analysis_hash.localeCompare(right.analysis_hash));
  return {
    candidates,
    analysis_hashes: analysisHashes,
    warnings: [...new Set(warnings)].sort(),
  };
}
