import * as fs from "node:fs";
import * as path from "node:path";
import type {
  AudioSemanticRole,
  Candidate,
  SourceCapabilities,
  SourceMediaKind,
  SourceMediaSummary,
} from "../compiler/types.js";
import { MEDIA_KIND_REGISTRY } from "../media/media-kind-registry.js";
import { assertImageSequenceGrounding } from "./image-sequence-grounding.js";

export interface AssetMediaCapability {
  media_kind: SourceMediaKind;
  source_capabilities: SourceCapabilities;
}

export class MediaKindPlanningBlockedError extends Error {
  readonly code = "MEDIA_KIND_PLANNING_BLOCKED";
  constructor(readonly assetIds: string[]) {
    super(`Planning is not supported for asset(s): ${assetIds.join(", ")}`);
    this.name = "MediaKindPlanningBlockedError";
  }
}

export function readAssetMediaCapabilities(projectDir: string): Map<string, AssetMediaCapability> {
  const assetsPath = path.join(projectDir, "03_analysis", "assets.json");
  if (!fs.existsSync(assetsPath)) return new Map();
  try {
    const parsed = JSON.parse(fs.readFileSync(assetsPath, "utf-8")) as { items?: unknown };
    if (!Array.isArray(parsed.items)) return new Map();
    const result = new Map<string, AssetMediaCapability>();
    for (const value of parsed.items) {
      if (!value || typeof value !== "object") continue;
      const asset = value as { asset_id?: unknown; media_kind?: unknown; video_stream?: unknown; audio_stream?: unknown };
      if (typeof asset.asset_id !== "string" || asset.asset_id.length === 0) continue;
      const hasVideo = Boolean(asset.video_stream && typeof asset.video_stream === "object");
      const hasAudio = Boolean(asset.audio_stream && typeof asset.audio_stream === "object");
      const explicitKind = isSourceMediaKind(asset.media_kind) ? asset.media_kind : undefined;
      const mediaKind = explicitKind ?? (hasVideo ? "video" : hasAudio ? "audio" : "unknown");
      result.set(asset.asset_id, {
        media_kind: mediaKind,
        source_capabilities: mediaKind === "image"
          ? { has_video: true, has_audio: false }
          : { has_video: hasVideo, has_audio: hasAudio },
      });
    }
    return result;
  } catch {
    return new Map();
  }
}

/** Capabilities only for assets that explicitly declare an authoritative media_kind. */
export function readAuthoritativeAssetMediaCapabilities(projectDir: string): Map<string, AssetMediaCapability> {
  const assetsPath = path.join(projectDir, "03_analysis", "assets.json");
  if (!fs.existsSync(assetsPath)) return new Map();
  try {
    const parsed = JSON.parse(fs.readFileSync(assetsPath, "utf-8")) as { items?: unknown };
    if (!Array.isArray(parsed.items)) return new Map();
    const all = readAssetMediaCapabilities(projectDir);
    const result = new Map<string, AssetMediaCapability>();
    for (const value of parsed.items) {
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      const asset = value as { asset_id?: unknown; media_kind?: unknown };
      if (typeof asset.asset_id !== "string" || !isSourceMediaKind(asset.media_kind)) continue;
      const capability = all.get(asset.asset_id);
      if (capability) result.set(asset.asset_id, capability);
    }
    return result;
  } catch {
    return new Map();
  }
}

function isSourceMediaKind(value: unknown): value is SourceMediaKind {
  return typeof value === "string" && ["video", "audio", "image", "sequence", "unknown"].includes(value);
}

export function isAudioOnlyCandidate(candidate: Pick<Candidate, "media_kind" | "source_capabilities">): boolean {
  return candidate.media_kind === "audio" || (
    candidate.source_capabilities?.has_audio === true &&
    candidate.source_capabilities.has_video === false
  );
}

export function candidateSupportsVisual(candidate: Pick<Candidate, "media_kind" | "source_capabilities">): boolean {
  if (isAudioOnlyCandidate(candidate)) return false;
  return candidate.source_capabilities?.has_video !== false;
}

/** @deprecated Use candidateSupportsVisual; retained for additive API compatibility. */
export const candidateSupportsVideo = candidateSupportsVisual;

export function assertProjectPlanningMediaKindsSupported(projectDir: string): void {
  const assetsPath = path.join(projectDir, "03_analysis", "assets.json");
  if (!fs.existsSync(assetsPath)) {
    assertImageSequenceGrounding(projectDir);
    return;
  }
  let items: unknown[] = [];
  try {
    const parsed = JSON.parse(fs.readFileSync(assetsPath, "utf8")) as { items?: unknown };
    items = Array.isArray(parsed.items) ? parsed.items : [];
  } catch {
    assertImageSequenceGrounding(projectDir);
    return;
  }
  // Missing media_kind is a legacy artifact, not an authoritative "unknown"
  // declaration. Preserve its historical planning behavior; capability blocks
  // apply only to explicitly declared registry kinds.
  const blocked = items.flatMap((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [];
    const asset = value as { asset_id?: unknown; media_kind?: unknown };
    if (typeof asset.asset_id !== "string" || !isSourceMediaKind(asset.media_kind)) return [];
    return MEDIA_KIND_REGISTRY[asset.media_kind].capabilities.plan ? [] : [asset.asset_id];
  }).sort();
  if (blocked.length > 0) throw new MediaKindPlanningBlockedError(blocked);
  assertImageSequenceGrounding(projectDir);
}

export function assertCandidatePlanningMediaKindsSupported(
  candidates: Array<Pick<Candidate, "asset_id" | "media_kind">>,
): void {
  const blocked = [...new Set(candidates
    .filter((candidate) => candidate.media_kind && candidate.media_kind !== "unknown" && !MEDIA_KIND_REGISTRY[candidate.media_kind].capabilities.plan)
    .map((candidate) => candidate.asset_id))].sort();
  if (blocked.length > 0) throw new MediaKindPlanningBlockedError(blocked);
}

export function inferAudioRole(candidate: Pick<Candidate, "role" | "transcript_excerpt" | "motif_tags">): AudioSemanticRole {
  if (candidate.role === "dialogue" || candidate.transcript_excerpt?.trim()) return "dialogue";
  const tags = new Set((candidate.motif_tags ?? []).map((tag) => tag.trim().toLowerCase()));
  if (tags.has("music") || tags.has("bgm")) return "music";
  if (candidate.role === "texture" || tags.has("ambient") || tags.has("room_tone")) return "ambient";
  return "nat_sound";
}

export function summarizeCandidateMedia(candidates: Candidate[]): SourceMediaSummary {
  const audioOnlyCount = candidates.filter(isAudioOnlyCandidate).length;
  const visualCount = candidates.filter(candidateSupportsVisual).length;
  const kinds = [...new Set(candidates.map((candidate) => candidate.media_kind ?? "unknown"))]
    .sort((a, b) => a.localeCompare(b)) as SourceMediaKind[];
  return {
    mode: audioOnlyCount > 0 && visualCount > 0 ? "mixed" : audioOnlyCount > 0 ? "audio_only" : "video",
    media_kinds: kinds,
    visual_candidate_count: visualCount,
    audio_only_candidate_count: audioOnlyCount,
  };
}
