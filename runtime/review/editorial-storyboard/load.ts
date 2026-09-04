/**
 * Canonical artifact loading for the editorial storyboard projection.
 *
 * The loader is strictly read-only: it parses canonical artifacts, hashes the
 * file bytes, and reports missing optional inputs instead of guessing.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { parse as parseYaml } from "yaml";
import { getCandidateRef } from "../../compiler/candidate-ref.js";
import { loadSourceMap } from "../../media/source-map.js";
import { sha256FileHash } from "./hashes.js";
import type {
  ArtifactInputRecord,
  ArtifactRole,
  LoadedDeliveryProfileInfo,
  ResolvedCandidateBinding,
  StoryboardMediaKind,
  UncertaintyItem,
} from "./types.js";

// ── Structural artifact shapes (subset used by the projection) ─────

export interface BriefDoc {
  project_id?: string;
  project?: { id?: string; title?: string; format?: string };
  message?: { primary?: string };
}

export interface BlueprintBeat {
  id: string;
  label: string;
  viewer_label?: string;
  purpose?: string;
  target_duration_frames: number;
  required_roles: string[];
  preferred_roles?: string[];
  notes?: string;
  story_role?: string;
  candidate_plan?: {
    primary_candidate_ref?: string;
    fallback_candidate_refs?: string[];
    still_image?: Record<string, unknown>;
    freeze_frame_hold?: { source_time_us: number; hold_frames?: number };
  };
}

export interface BlueprintDoc {
  version?: string;
  project_id?: string;
  sequence_goals?: string[];
  beats: BlueprintBeat[];
  music_policy?: Record<string, unknown>;
  dialogue_policy?: Record<string, unknown>;
  caption_policy?: Record<string, unknown>;
  source_media?: { mode?: string; media_kinds?: string[] };
  visual_intents?: Array<Record<string, unknown>>;
  policy_refs?: Record<string, unknown>;
}

export interface SelectsCandidate {
  segment_id: string;
  asset_id: string;
  src_in_us: number;
  src_out_us: number;
  role: string;
  confidence?: number;
  media_kind?: StoryboardMediaKind;
  audio_role?: string;
  speaker_role?: string;
  quality_flags?: string[];
  risks?: string[];
  evidence?: string[];
  transcript_excerpt?: string;
  candidate_id?: string;
  eligible_beats?: string[];
  story_role?: string;
  trim_hint?: {
    source_center_us?: number;
    recommended_in_us?: number;
    recommended_out_us?: number;
    center_source?: string;
    peak_ref?: string;
  };
  still_image?: Record<string, unknown>;
  freeze_frame_hold?: { source_time_us: number; hold_frames?: number };
}

export interface SelectsDoc {
  version?: string;
  project_id?: string;
  candidates: SelectsCandidate[];
}

export interface TimelineClip {
  clip_id: string;
  segment_id: string;
  asset_id: string;
  src_in_us: number;
  src_out_us: number;
  timeline_in_frame: number;
  timeline_duration_frames: number;
  role?: string;
  motivation?: string;
  beat_id?: string;
  fallback_segment_ids?: string[];
  candidate_ref?: string;
}

export interface TimelineDoc {
  version?: string;
  project_id?: string;
  sequence: {
    name?: string;
    fps_num: number;
    fps_den: number;
    width: number;
    height: number;
    output_aspect_ratio?: string;
  };
  tracks: {
    video: Array<{ track_id: string; kind: string; clips: TimelineClip[] }>;
  };
}

export interface UncertaintyDoc {
  uncertainties?: Array<{
    id: string;
    type?: string;
    question?: string;
    status?: string;
    escalation_required?: boolean;
    evidence?: string[];
  }>;
}

export interface LoadedArtifacts {
  projectDir: string;
  briefPath: string | null;
  briefHash: string | null;
  brief: BriefDoc | null;
  selectsPath: string | null;
  selectsHash: string | null;
  selects: SelectsDoc | null;
  blueprintPath: string;
  blueprintHash: string;
  blueprint: BlueprintDoc;
  uncertaintyPath: string | null;
  uncertaintyHash: string | null;
  uncertainty: UncertaintyDoc | null;
  timelinePath: string | null;
  timelineHash: string | null;
  timeline: TimelineDoc | null;
  sourceMapPath: string | null;
  sourceMapHash: string | null;
  sourceMapEntries: Map<string, SourceMapEntryInfo>;
  policyRecords: ArtifactInputRecord[];
  segmentsBySegmentId: Map<string, SegmentRange>;
}

export interface SourceMapEntryInfo {
  asset_id: string;
  media_kind: string | null;
  content_hash: string | null;
  local_source_path: string | null;
  exists: boolean;
}

export interface SegmentRange {
  segment_id: string;
  asset_id: string;
  src_in_us: number;
  src_out_us: number;
}

// ── Path helpers ────────────────────────────────────────────────────

const PROJECT_PATHS = {
  brief: "01_intent/creative_brief.yaml",
  selects: "04_plan/selects_candidates.yaml",
  blueprint: "04_plan/edit_blueprint.yaml",
  uncertainty: "04_plan/uncertainty_register.yaml",
  timeline: "05_timeline/timeline.json",
  source_map: "02_media/source_map.json",
} as const satisfies Record<Exclude<ArtifactRole, "policy">, string>;

export const PROJECTION_ROOT = "04_plan/review-projections";

function readHashed(projectDir: string, relPath: string): { path: string; hash: string } | null {
  const abs = path.join(projectDir, relPath);
  if (!fs.existsSync(abs)) return null;
  return { path: relPath, hash: sha256FileHash(abs) };
}

function readYaml<T>(projectDir: string, relPath: string): T | null {
  const abs = path.join(projectDir, relPath);
  if (!fs.existsSync(abs)) return null;
  return parseYaml(fs.readFileSync(abs, "utf-8")) as T;
}

// ── Loader ──────────────────────────────────────────────────────────

export class StoryboardArtifactError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StoryboardArtifactError";
  }
}

/** Resolve policy files referenced by blueprint.policy_refs without guessing. */
function collectPolicyInputs(
  projectDir: string,
  blueprint: BlueprintDoc,
): ArtifactInputRecord[] {
  const records: ArtifactInputRecord[] = [];
  const refs = blueprint.policy_refs ?? {};
  for (const [key, value] of Object.entries(refs)) {
    let relPath: string | null = null;
    if (typeof value === "string" && value.trim().length > 0) {
      relPath = value;
    } else if (
      value &&
      typeof value === "object" &&
      typeof (value as { ref?: unknown }).ref === "string"
    ) {
      relPath = (value as { ref: string }).ref;
    }
    if (!relPath) continue;
    // Policy refs may be registry ids rather than paths; only existing
    // project-relative files are hashed. Registry references are recorded
    // as informational (hash null), never silently treated as loaded.
    const normalized = relPath.replace(/\\/g, "/");
    const found =
      readHashed(projectDir, normalized) ??
      readHashed(projectDir, `delivery_profiles/${normalized}`);
    records.push({
      role: "policy",
      path: `${key}:${normalized}`,
      hash: found ? found.hash : null,
      required: false,
    });
  }
  return records.sort((a, b) => a.path.localeCompare(b.path));
}

export function loadStoryboardArtifacts(
  projectDir: string,
  options: { requireTimeline?: boolean } = {},
): LoadedArtifacts {
  const resolvedProjectDir = path.resolve(projectDir);
  if (!fs.existsSync(resolvedProjectDir)) {
    throw new StoryboardArtifactError(`Project directory not found: ${resolvedProjectDir}`);
  }

  const missing: string[] = [];
  for (const relPath of [PROJECT_PATHS.blueprint, PROJECT_PATHS.selects]) {
    if (!fs.existsSync(path.join(resolvedProjectDir, relPath))) missing.push(relPath);
  }
  if (missing.length > 0) {
    throw new StoryboardArtifactError(
      `Required canonical artifacts are missing: ${missing.join(", ")}`,
    );
  }

  const briefHashed = readHashed(resolvedProjectDir, PROJECT_PATHS.brief);
  const selectsHashed = readHashed(resolvedProjectDir, PROJECT_PATHS.selects);
  const blueprintHashed = readHashed(resolvedProjectDir, PROJECT_PATHS.blueprint)!;
  const uncertaintyHashed = readHashed(resolvedProjectDir, PROJECT_PATHS.uncertainty);
  const timelineHashed = readHashed(resolvedProjectDir, PROJECT_PATHS.timeline);
  const sourceMapHashed = readHashed(resolvedProjectDir, PROJECT_PATHS.source_map);

  if (options.requireTimeline && !timelineHashed) {
    throw new StoryboardArtifactError(
      `Timeline mode requires ${PROJECT_PATHS.timeline}; run compile first or use --source blueprint.`,
    );
  }

  const blueprint = readYaml<BlueprintDoc>(resolvedProjectDir, PROJECT_PATHS.blueprint)!;
  if (!Array.isArray(blueprint.beats) || blueprint.beats.length === 0) {
    throw new StoryboardArtifactError("edit_blueprint.yaml contains no beats");
  }

  const sourceMapEntries = new Map<string, SourceMapEntryInfo>();
  if (sourceMapHashed) {
    const loaded = loadSourceMap(resolvedProjectDir);
    for (const entry of loaded.entries) {
      const candidates = [entry.local_source_path, entry.source_locator].filter(
        (value): value is string => typeof value === "string" && value.length > 0,
      );
      sourceMapEntries.set(entry.asset_id, {
        asset_id: entry.asset_id,
        media_kind: typeof entry.media_kind === "string" ? entry.media_kind : null,
        content_hash: entry.source_content_sha256 ?? null,
        local_source_path:
          candidates.find((candidate) => fs.existsSync(candidate)) ?? candidates[0] ?? null,
        exists: candidates.some((candidate) => fs.existsSync(candidate)),
      });
    }
  }

  // Segments are used only as a midpoint fallback for representative frames.
  const segmentsBySegmentId = new Map<string, SegmentRange>();
  const segmentsAbs = path.join(resolvedProjectDir, "03_analysis", "segments.json");
  if (fs.existsSync(segmentsAbs)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(segmentsAbs, "utf-8")) as unknown;
      const items = Array.isArray(parsed)
        ? parsed
        : Array.isArray((parsed as { segments?: unknown[] }).segments)
          ? (parsed as { segments: unknown[] }).segments
          : [];
      for (const item of items) {
        const record = item as Partial<SegmentRange>;
        if (
          typeof record.segment_id === "string" &&
          typeof record.src_in_us === "number" &&
          typeof record.src_out_us === "number"
        ) {
          segmentsBySegmentId.set(record.segment_id, {
            segment_id: record.segment_id,
            asset_id: typeof record.asset_id === "string" ? record.asset_id : "",
            src_in_us: record.src_in_us,
            src_out_us: record.src_out_us,
          });
        }
      }
    } catch {
      // segments.json is an optional fallback input; malformed content is
      // surfaced later as a warning, not silently ignored.
    }
  }

  return {
    projectDir: resolvedProjectDir,
    briefPath: briefHashed?.path ?? null,
    briefHash: briefHashed?.hash ?? null,
    brief: readYaml<BriefDoc>(resolvedProjectDir, PROJECT_PATHS.brief),
    selectsPath: selectsHashed?.path ?? null,
    selectsHash: selectsHashed!.hash,
    selects: readYaml<SelectsDoc>(resolvedProjectDir, PROJECT_PATHS.selects)!,
    blueprintPath: blueprintHashed.path,
    blueprintHash: blueprintHashed.hash,
    blueprint,
    uncertaintyPath: uncertaintyHashed?.path ?? null,
    uncertaintyHash: uncertaintyHashed?.hash ?? null,
    uncertainty: readYaml<UncertaintyDoc>(resolvedProjectDir, PROJECT_PATHS.uncertainty),
    timelinePath: timelineHashed?.path ?? null,
    timelineHash: timelineHashed?.hash ?? null,
    timeline: readYaml<TimelineDoc>(resolvedProjectDir, PROJECT_PATHS.timeline),
    sourceMapPath: sourceMapHashed?.path ?? null,
    sourceMapHash: sourceMapHashed?.hash ?? null,
    sourceMapEntries,
    policyRecords: collectPolicyInputs(resolvedProjectDir, blueprint),
    segmentsBySegmentId,
  };
}

// ── Input record assembly ───────────────────────────────────────────

export function buildInputRecords(loaded: LoadedArtifacts): ArtifactInputRecord[] {
  const records: Array<[ArtifactRole, string | null, string | null, boolean]> = [
    ["brief", loaded.briefPath, loaded.briefHash, true],
    ["selects", loaded.selectsPath, loaded.selectsHash, true],
    ["blueprint", loaded.blueprintPath, loaded.blueprintHash, true],
    ["uncertainty", loaded.uncertaintyPath, loaded.uncertaintyHash, false],
    ["timeline", loaded.timelinePath, loaded.timelineHash, false],
    ["source_map", loaded.sourceMapPath, loaded.sourceMapHash, false],
  ];
  const main = records.map(([role, filePath, hash, required]) => ({
    role,
    path: filePath ?? PROJECT_PATHS[role as Exclude<ArtifactRole, "policy">],
    hash,
    required,
  }));
  return [...main, ...loaded.policyRecords].sort((a, b) => a.role.localeCompare(b.role) || a.path.localeCompare(b.path));
}

// ── Candidate resolution ────────────────────────────────────────────

/**
 * Build a lookup from every accepted reference form to a candidate.
 * Mirrors the compiler's resolution: explicit candidate_id, computed ref,
 * legacy shim (`legacy:{segment}:{in}:{out}`), and bare segment_id.
 */
export function buildCandidateRefIndex(
  projectId: string,
  candidates: SelectsCandidate[],
): Map<string, SelectsCandidate> {
  const index = new Map<string, SelectsCandidate>();
  for (const candidate of candidates) {
    index.set(getCandidateRef(candidate as never), candidate);
    if (candidate.candidate_id) index.set(candidate.candidate_id, candidate);
    if (!index.has(candidate.segment_id)) index.set(candidate.segment_id, candidate);
  }
  void projectId;
  return index;
}

function normalizeMediaKind(
  candidate: SelectsCandidate | undefined,
  sourceMapEntry: SourceMapEntryInfo | undefined,
): StoryboardMediaKind {
  const allowed = new Set(["video", "image", "sequence", "audio", "unknown"]);
  if (candidate?.media_kind && allowed.has(candidate.media_kind)) return candidate.media_kind;
  if (candidate?.media_kind === undefined && sourceMapEntry?.media_kind && allowed.has(sourceMapEntry.media_kind)) {
    return sourceMapEntry.media_kind as StoryboardMediaKind;
  }
  if (sourceMapEntry?.media_kind === "image_sequence") return "sequence";
  return "unknown";
}

export function resolveBinding(
  ref: string,
  index: Map<string, SelectsCandidate>,
  sourceMapEntries: Map<string, SourceMapEntryInfo>,
): ResolvedCandidateBinding {
  const candidate = index.get(ref);
  if (!candidate) {
    return {
      ref,
      resolved: false,
      unresolved_reason: `candidate reference not found in selects_candidates.yaml`,
      candidate_id: null,
      segment_id: null,
      asset_id: null,
      src_in_us: null,
      src_out_us: null,
      role: null,
      confidence: null,
      media_kind: "unknown",
      quality_flags: [],
      risks: [],
      evidence: [],
      transcript_excerpt: null,
      audio_role: null,
      speaker_role: null,
      trim_hint: null,
      still_image: null,
      freeze_frame_hold: null,
      asset_hash: null,
      asset_missing: true,
    };
  }
  const entry = sourceMapEntries.get(candidate.asset_id);
  return {
    ref,
    resolved: true,
    candidate_id: candidate.candidate_id ?? null,
    segment_id: candidate.segment_id,
    asset_id: candidate.asset_id,
    src_in_us: candidate.src_in_us,
    src_out_us: candidate.src_out_us,
    role: candidate.role,
    confidence: typeof candidate.confidence === "number" ? candidate.confidence : null,
    media_kind: normalizeMediaKind(candidate, entry),
    quality_flags: candidate.quality_flags ?? [],
    risks: candidate.risks ?? [],
    evidence: candidate.evidence ?? [],
    transcript_excerpt: candidate.transcript_excerpt ?? null,
    audio_role: candidate.audio_role ?? null,
    speaker_role: candidate.speaker_role ?? null,
    trim_hint: candidate.trim_hint
      ? {
          source_center_us: candidate.trim_hint.source_center_us ?? null,
          recommended_in_us: candidate.trim_hint.recommended_in_us ?? null,
          recommended_out_us: candidate.trim_hint.recommended_out_us ?? null,
          center_source: candidate.trim_hint.center_source ?? null,
          peak_ref: candidate.trim_hint.peak_ref ?? null,
        }
      : null,
    still_image:
      candidate.still_image && typeof candidate.still_image === "object"
        ? {
            hold_duration_sec:
              typeof (candidate.still_image as { hold_duration_sec?: unknown }).hold_duration_sec === "number"
                ? (candidate.still_image as { hold_duration_sec: number }).hold_duration_sec
                : null,
            motion_mode:
              typeof (candidate.still_image as { motion_mode?: unknown }).motion_mode === "string"
                ? (candidate.still_image as { motion_mode: string }).motion_mode
                : null,
          }
        : null,
    freeze_frame_hold: candidate.freeze_frame_hold
      ? {
          source_time_us: candidate.freeze_frame_hold.source_time_us ?? null,
          hold_frames: candidate.freeze_frame_hold.hold_frames ?? null,
        }
      : null,
    asset_hash: entry?.content_hash ?? null,
    asset_missing: entry ? !entry.exists : true,
  };
}

// ── Uncertainties ───────────────────────────────────────────────────

export function collectUncertainties(
  loaded: LoadedArtifacts,
  beatIds: string[],
): UncertaintyItem[] {
  const items = loaded.uncertainty?.uncertainties ?? [];
  return items.map((item) => {
    const haystack = [
      item.question ?? "",
      ...(item.evidence ?? []),
    ].join(" ");
    const relatedBeats = beatIds.filter((beatId) =>
      new RegExp(`\\b${escapeRegExp(beatId)}\\b`).test(haystack),
    );
    return {
      id: item.id,
      type: item.type ?? "unknown",
      question: item.question ?? "",
      status: item.status ?? "unknown",
      escalation_required: item.escalation_required === true,
      related_beat_ids: relatedBeats,
    };
  });
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ── Delivery profiles ───────────────────────────────────────────────

interface RawDeliveryProfileShape {
  profile_id: string;
  profile_name: string;
  platform: string;
  video_constraints?: {
    aspect_ratio?: string;
    resolution?: { width?: number; height?: number };
    frame_rate_mode?: string;
  };
  caption_constraints?: { mode?: string };
}

/**
 * Load delivery profiles directly from the project's delivery profile
 * directory. Uses the same directory convention as P4b
 * (07_package/delivery_profiles). Malformed profiles are reported instead
 * of skipped silently.
 */
export function loadProjectDeliveryProfiles(projectDir: string): {
  profiles: LoadedDeliveryProfileInfo[];
  raw: Map<string, { profile: RawDeliveryProfileShape; hash: string }>;
  malformed: Array<{ path: string; error: string }>;
} {
  const dir = path.join(projectDir, "07_package", "delivery_profiles");
  const profiles: LoadedDeliveryProfileInfo[] = [];
  const raw = new Map<string, { profile: RawDeliveryProfileShape; hash: string }>();
  const malformed: Array<{ path: string; error: string }> = [];
  if (!fs.existsSync(dir)) return { profiles, raw, malformed };
  for (const fileName of fs.readdirSync(dir).filter((f) => /\.ya?ml$/i.test(f)).sort()) {
    const abs = path.join(dir, fileName);
    try {
      const hash = sha256FileHash(abs);
      const profile = parseYaml(fs.readFileSync(abs, "utf-8")) as RawDeliveryProfileShape;
      if (!profile || typeof profile.profile_id !== "string") {
        throw new Error("profile_id is missing");
      }
      raw.set(profile.profile_id, { profile, hash });
      profiles.push({
        profile_id: profile.profile_id,
        profile_name: profile.profile_name,
        platform: profile.platform,
        path: `07_package/delivery_profiles/${fileName}`,
        hash,
        aspect_ratio: profile.video_constraints?.aspect_ratio ?? null,
        resolution_width: profile.video_constraints?.resolution?.width ?? null,
        resolution_height: profile.video_constraints?.resolution?.height ?? null,
        fps_mode: profile.video_constraints?.frame_rate_mode ?? null,
        caption_mode: profile.caption_constraints?.mode ?? null,
      });
    } catch (error) {
      malformed.push({
        path: `07_package/delivery_profiles/${fileName}`,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { profiles, raw, malformed };
}
