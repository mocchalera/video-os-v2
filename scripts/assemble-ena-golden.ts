#!/usr/bin/env npx tsx

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { config as dotenvConfig } from "dotenv";
import YAML from "yaml";

const require = createRequire(import.meta.url);
const Ajv2020 = require("ajv/dist/2020") as new (opts: Record<string, unknown>) => AjvLike;
const addFormats = require("ajv-formats") as (ajv: unknown) => void;

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const PROJECT_ID = "ena-promo";
const PROJECT_DIR = path.join(REPO_ROOT, "projects", PROJECT_ID);
const ANALYSIS_DIR = path.join(PROJECT_DIR, "03_analysis");
const PLAN_DIR = path.join(PROJECT_DIR, "04_plan");
const TIMELINE_PATH = path.join(REPO_ROOT, "reports", "eval", "ena-golden", "_scratch", "full_timeline.json");
const OUTPUT_FPS = 24;
const GENERATED_AT = "2026-06-16T00:00:00.000Z";

dotenvConfig({ path: path.join(REPO_ROOT, ".env.local"), quiet: true });
dotenvConfig({ path: path.join(REPO_ROOT, ".env"), quiet: true });

type Role = "hero" | "support" | "texture";
type StoryRole = "hook" | "setup" | "experience" | "closing";

type TimelineEntry = {
  position?: number;
  display_name?: string;
  duration_s?: number;
  src_start_s?: number;
  type?: string;
};

type TimelineClip = {
  position: number;
  display_name: string;
  duration_s: number;
  src_start_s?: number;
  type: "clip";
  section?: string;
  source: "timeline" | "compound_section" | "all_clips";
};

type CompoundSection = {
  compound?: string;
  display_name?: string;
  clips?: TimelineEntry[];
};

type FullTimeline = {
  project?: string;
  sequence?: string;
  export_duration_s?: number;
  clip_count?: number;
  unique_source_count?: number;
  total_clip_duration_s?: number;
  timeline?: TimelineEntry[];
  sections?: CompoundSection[];
  all_clips?: TimelineEntry[];
  unique_sources?: string[];
};

type AssetItem = {
  asset_id: string;
  filename: string;
  display_name?: string;
  duration_us?: number;
  segment_ids?: string[];
  quality_flags?: string[];
  tags?: string[];
  source_locator?: string;
};

type SegmentItem = {
  segment_id: string;
  asset_id: string;
  src_in_us: number;
  src_out_us: number;
  duration_us?: number;
  rep_frame_us?: number;
  summary?: string;
  transcript_excerpt?: string;
  quality_flags?: string[];
  tags?: string[];
};

type ArtifactWithItems<T> = {
  project_id?: string;
  artifact_version?: string;
  items: T[];
};

type AnalysisData = {
  assetsDoc: ArtifactWithItems<AssetItem> | null;
  segmentsDoc: ArtifactWithItems<SegmentItem> | null;
  sourceMediaNames: string[];
  sourceMediaSource: string;
};

type Candidate = {
  candidate_id: string;
  segment_id: string;
  asset_id: string;
  src_in_us: number;
  src_out_us: number;
  role: Role;
  why_it_matches: string;
  risks: string[];
  confidence: number;
  semantic_rank: number;
  quality_flags: string[];
  evidence: string[];
  eligible_beats: string[];
  motif_tags: string[];
  transcript_excerpt?: string;
  trim_hint: {
    source_center_us: number;
    preferred_duration_us: number;
    min_duration_us: number;
    max_duration_us: number;
    window_start_us: number;
    window_end_us: number;
    interest_point_label: string;
    interest_point_confidence: number;
    rationale: string;
    recommended_in_us: number;
    recommended_out_us: number;
  };
};

type ResolvedClip = {
  candidate: Candidate;
  clip: TimelineClip;
  clipIndex: number;
  beatId: string;
  matchedBy: string;
};

type BeatSpec = {
  id: string;
  label: string;
  posStart: number;
  posEnd: number;
  purpose: string;
  storyRole: StoryRole;
  requiredRoles: Role[];
  preferredRoles: Role[];
};

type AjvValidateFunction = ((data: unknown) => boolean) & {
  errors?: Array<{
    instancePath?: string;
    schemaPath?: string;
    message?: string;
    params?: unknown;
  }> | null;
};

type AjvLike = {
  compile(schema: object): AjvValidateFunction;
};

function readJson<T>(file: string): T {
  return JSON.parse(fs.readFileSync(file, "utf8")) as T;
}

function readArtifactItems<T>(file: string, label: string): ArtifactWithItems<T> {
  const doc = readJson<unknown>(file);
  if (!isRecord(doc) || !Array.isArray(doc.items)) {
    throw new Error(`${label} must be an object with an items array: ${file}`);
  }
  return doc as ArtifactWithItems<T>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}

function toUs(seconds: number): number {
  return Math.round(seconds * 1_000_000);
}

function roundSeconds(seconds: number): number {
  return Number(seconds.toFixed(2));
}

function pad3(n: number): string {
  return String(n).padStart(3, "0");
}

function slug(value: string): string {
  const ascii = value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/^Blackmagic Pocket Cinema Camera_1_/i, "")
    .replace(/\.[^.]+$/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  const fallback = createHash("sha256").update(value).digest("hex").slice(0, 12);
  return ascii.length > 0 ? ascii : fallback;
}

function normalizeMediaName(value: string | undefined): string | null {
  if (!value) return null;
  const base = path.basename(value).replace(/\.[^.]+$/g, "");
  return base.replace(/^Blackmagic Pocket Cinema Camera_1_/i, "").toUpperCase();
}

function timelineClipFromEntry(entry: TimelineEntry, source: TimelineClip["source"], section?: string): TimelineClip | null {
  if (entry.type !== "clip") return null;
  if (!entry.display_name || typeof entry.duration_s !== "number" || entry.duration_s <= 0) return null;
  return {
    position: typeof entry.position === "number" ? entry.position : -1,
    display_name: entry.display_name,
    duration_s: entry.duration_s,
    src_start_s: typeof entry.src_start_s === "number" ? entry.src_start_s : undefined,
    type: "clip",
    section,
    source,
  };
}

function findSectionForCompound(sections: CompoundSection[], displayName: string | undefined): CompoundSection | null {
  if (!displayName) return null;
  return sections.find((section) => section.compound === displayName || section.display_name === displayName) ?? null;
}

function clipsFromTimelineDoc(doc: FullTimeline): TimelineClip[] {
  const sections = Array.isArray(doc.sections) ? doc.sections : [];

  if (Array.isArray(doc.timeline)) {
    const clips: TimelineClip[] = [];
    for (const entry of doc.timeline) {
      const clip = timelineClipFromEntry(entry, "timeline");
      if (clip) {
        clips.push(clip);
        continue;
      }

      if (entry.type === "compound_clip") {
        const section = findSectionForCompound(sections, entry.display_name);
        if (!section?.clips) {
          console.warn(`WARNING: compound clip ${entry.display_name ?? "(unnamed)"} has no sections entry; skipping placeholder`);
          continue;
        }

        for (const sectionEntry of section.clips) {
          const sectionClip = timelineClipFromEntry(
            {
              ...sectionEntry,
              position: typeof entry.position === "number" ? entry.position : sectionEntry.position,
            },
            "compound_section",
            entry.display_name,
          );
          if (sectionClip) clips.push(sectionClip);
        }
      }
    }
    return clips;
  }

  if (Array.isArray(doc.all_clips)) {
    return doc.all_clips
      .map((entry, index) => timelineClipFromEntry({ ...entry, position: index }, "all_clips", entry.display_name))
      .filter((clip): clip is TimelineClip => clip !== null);
  }

  if (sections.length > 0) {
    return sections.flatMap((section) =>
      (section.clips ?? [])
        .map((entry, index) =>
          timelineClipFromEntry({ ...entry, position: index }, "compound_section", section.compound ?? section.display_name),
        )
        .filter((clip): clip is TimelineClip => clip !== null),
    );
  }

  throw new Error(`No timeline clips found in ${TIMELINE_PATH}`);
}

function readSourceFilesIfPresent(): string[] | null {
  const sourceFilesPath = path.join(ANALYSIS_DIR, "source-files.txt");
  if (!fs.existsSync(sourceFilesPath)) return null;
  return fs
    .readFileSync(sourceFilesPath, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function readAnalysisData(doc: FullTimeline, clips: TimelineClip[]): AnalysisData {
  const assetsPath = path.join(ANALYSIS_DIR, "assets.json");
  const segmentsPath = path.join(ANALYSIS_DIR, "segments.json");
  const assetsDoc = fs.existsSync(assetsPath) ? readArtifactItems<AssetItem>(assetsPath, "assets.json") : null;
  const segmentsDoc = fs.existsSync(segmentsPath) ? readArtifactItems<SegmentItem>(segmentsPath, "segments.json") : null;

  const sourceFiles = readSourceFilesIfPresent();
  if (sourceFiles) {
    return {
      assetsDoc,
      segmentsDoc,
      sourceMediaNames: sourceFiles,
      sourceMediaSource: "projects/ena-promo/03_analysis/source-files.txt",
    };
  }

  if (assetsDoc) {
    return {
      assetsDoc,
      segmentsDoc,
      sourceMediaNames: unique(
        assetsDoc.items.flatMap((asset) => [asset.display_name, asset.filename, asset.source_locator].filter(Boolean) as string[]),
      ),
      sourceMediaSource: "projects/ena-promo/03_analysis/assets.json",
    };
  }

  return {
    assetsDoc,
    segmentsDoc,
    sourceMediaNames: Array.isArray(doc.unique_sources) && doc.unique_sources.length > 0
      ? doc.unique_sources
      : unique(clips.map((clip) => clip.display_name)),
    sourceMediaSource: "reports/eval/ena-golden/_scratch/full_timeline.json",
  };
}

function assetMatchKeys(asset: AssetItem): string[] {
  return unique(
    [asset.display_name, asset.filename, asset.source_locator]
      .map(normalizeMediaName)
      .filter((item): item is string => item !== null),
  );
}

function findAssetForClip(clip: TimelineClip, assets: AssetItem[]): { asset: AssetItem; matchedBy: string } | null {
  const target = normalizeMediaName(clip.display_name);
  if (!target) return null;

  const matches = assets
    .map((asset) => ({ asset, keys: assetMatchKeys(asset) }))
    .filter(({ keys }) => keys.includes(target))
    .sort((a, b) => a.asset.asset_id.localeCompare(b.asset.asset_id));

  if (matches.length === 0) return null;
  if (matches.length > 1) {
    console.warn(`WARNING: ${clip.display_name} matched multiple analysis assets; using ${matches[0].asset.asset_id}`);
  }

  const first = matches[0];
  const matchedBy = first.asset.display_name && normalizeMediaName(first.asset.display_name) === target
    ? "display_name"
    : first.asset.filename && normalizeMediaName(first.asset.filename) === target
    ? "filename"
    : "source_locator";
  return { asset: first.asset, matchedBy };
}

function findSegmentForAsset(asset: AssetItem, segments: SegmentItem[]): SegmentItem | null {
  const byId = new Map(segments.map((segment) => [segment.segment_id, segment]));
  for (const segmentId of asset.segment_ids ?? []) {
    const segment = byId.get(segmentId);
    if (segment) return segment;
  }

  const matches = segments
    .filter((segment) => segment.asset_id === asset.asset_id)
    .sort((a, b) => a.segment_id.localeCompare(b.segment_id));
  return matches[0] ?? null;
}

function syntheticAssetForClip(clip: TimelineClip): AssetItem {
  const sourceSlug = slug(clip.display_name);
  return {
    asset_id: `asset_ena_${sourceSlug}`,
    filename: clip.display_name,
    display_name: clip.display_name,
    duration_us: undefined,
    segment_ids: [],
    quality_flags: [],
    tags: ["timeline_derived"],
  };
}

function syntheticSegmentForClip(clip: TimelineClip, clipIndex: number, assetId: string, srcInUs: number, srcOutUs: number): SegmentItem {
  return {
    segment_id: `seg_ena_${pad3(clipIndex)}_${slug(clip.display_name)}`,
    asset_id: assetId,
    src_in_us: srcInUs,
    src_out_us: srcOutUs,
    duration_us: srcOutUs - srcInUs,
    rep_frame_us: srcInUs + Math.round((srcOutUs - srcInUs) / 2),
    summary: `Timeline-derived human golden clip ${clipIndex}: ${clip.display_name}`,
    transcript_excerpt: "",
    quality_flags: [],
    tags: ["human_golden", "timeline_derived"],
  };
}

function buildBeatSpecs(totalClips: number): BeatSpec[] {
  const templates: Array<Omit<BeatSpec, "posStart" | "posEnd"> & { endRatio: number }> = [
    {
      id: "b01",
      label: "Opening - Ena Place Hook",
      endRatio: 0.12,
      purpose: "Identify Ena quickly with concise scenic, city, and title-adjacent visual anchors.",
      storyRole: "hook",
      requiredRoles: ["hero"],
      preferredRoles: ["texture"],
    },
    {
      id: "b02",
      label: "Landscape - Arrival And Scale",
      endRatio: 0.25,
      purpose: "Broaden the sense of place with drone, mountain, river, and town-establishing shots.",
      storyRole: "setup",
      requiredRoles: ["hero", "support"],
      preferredRoles: ["texture"],
    },
    {
      id: "b03",
      label: "Local Texture - Food And Craft",
      endRatio: 0.42,
      purpose: "Move through tactile tourism details such as food, seasonal materials, shops, and handwork.",
      storyRole: "experience",
      requiredRoles: ["support"],
      preferredRoles: ["texture"],
    },
    {
      id: "b04",
      label: "Experience - Streets And People",
      endRatio: 0.62,
      purpose: "Sustain the middle montage with visitor movement, town life, and human-scale experience shots.",
      storyRole: "experience",
      requiredRoles: ["support"],
      preferredRoles: ["hero", "texture"],
    },
    {
      id: "b05",
      label: "Lift - Scenic Emotion",
      endRatio: 0.82,
      purpose: "Build emotional lift through broader vistas, expressive detail cuts, and slower scenic moments.",
      storyRole: "experience",
      requiredRoles: ["hero", "support"],
      preferredRoles: ["texture"],
    },
    {
      id: "b06",
      label: "Closing - Memory And Resolve",
      endRatio: 1,
      purpose: "Resolve the promotion with final scenic, destination, and atmosphere shots without adding new story claims.",
      storyRole: "closing",
      requiredRoles: ["hero", "texture"],
      preferredRoles: ["support"],
    },
  ];

  let start = 1;
  return templates.map((template, index) => {
    const end = index === templates.length - 1
      ? totalClips
      : Math.max(start, Math.round(totalClips * template.endRatio));
    const beat = {
      ...template,
      posStart: start,
      posEnd: end,
    };
    start = end + 1;
    return beat;
  });
}

function beatForClipIndex(clipIndex: number, beats: BeatSpec[]): BeatSpec {
  const beat = beats.find((item) => clipIndex >= item.posStart && clipIndex <= item.posEnd);
  if (!beat) {
    throw new Error(`No beat maps to timeline clip index ${clipIndex}`);
  }
  return beat;
}

function roleForClip(clip: TimelineClip, clipIndex: number, totalClips: number): Role {
  if (clip.display_name.startsWith("DJI_")) return "hero";
  if (clipIndex <= Math.max(4, Math.round(totalClips * 0.08))) return "hero";
  if (clipIndex > Math.round(totalClips * 0.9)) return clip.duration_s >= 1.25 ? "hero" : "texture";
  if (clip.duration_s <= 0.75) return "texture";
  if (clip.duration_s >= 3.25) return "hero";
  return "support";
}

function describeSourceWindow(clip: TimelineClip): string {
  if (typeof clip.src_start_s !== "number") return "unknown source start";
  return `${clip.src_start_s.toFixed(6)}s-${(clip.src_start_s + clip.duration_s).toFixed(6)}s`;
}

function buildWhyItMatches(clip: TimelineClip, clipIndex: number, role: Role, beat: BeatSpec): string {
  return `Human timeline clip ${clipIndex} uses ${clip.display_name} as a ${role} shot for ${beat.label}.`;
}

function buildCandidate(
  clip: TimelineClip,
  clipIndex: number,
  totalClips: number,
  beat: BeatSpec,
  analysis: AnalysisData,
): ResolvedClip | null {
  const assetMatch = analysis.assetsDoc ? findAssetForClip(clip, analysis.assetsDoc.items) : null;
  if (analysis.assetsDoc && !assetMatch) {
    console.warn(`WARNING: ${clip.display_name} not found in assets.json; using timeline-derived asset_id`);
  }

  const asset = assetMatch?.asset ?? syntheticAssetForClip(clip);
  const segment = assetMatch && analysis.segmentsDoc
    ? findSegmentForAsset(assetMatch.asset, analysis.segmentsDoc.items)
    : null;
  if (assetMatch && analysis.segmentsDoc && !segment) {
    console.warn(`WARNING: asset ${asset.asset_id} for ${clip.display_name} has no segment in segments.json; using timeline-derived segment_id`);
  }

  const srcInUs = typeof clip.src_start_s === "number"
    ? toUs(clip.src_start_s)
    : segment?.src_in_us ?? 0;
  const preferredDurationUs = Math.max(1, toUs(clip.duration_s));
  const srcOutUs = typeof clip.src_start_s === "number"
    ? srcInUs + preferredDurationUs
    : Math.min(segment?.src_out_us ?? srcInUs + preferredDurationUs, srcInUs + preferredDurationUs);

  if (srcOutUs <= srcInUs) {
    console.warn(`WARNING: ${clip.display_name} has invalid source window ${srcInUs}-${srcOutUs}; skipping`);
    return null;
  }

  const resolvedSegment = segment ?? syntheticSegmentForClip(clip, clipIndex, asset.asset_id, srcInUs, srcOutUs);
  const role = roleForClip(clip, clipIndex, totalClips);
  const durationUs = srcOutUs - srcInUs;
  const centerUs = srcInUs + Math.round(durationUs / 2);
  const matchedBy = assetMatch ? assetMatch.matchedBy : "timeline";
  const qualityFlags = unique([...(resolvedSegment.quality_flags ?? []), ...(asset.quality_flags ?? [])]);
  const risks = [
    ...(assetMatch ? [] : ["analysis_asset_match_missing"]),
    ...(segment ? [] : ["analysis_segment_match_missing"]),
  ];
  const motifTags = unique([
    "ena",
    "tourism_pv",
    role,
    beat.id,
    slug(clip.display_name),
    ...(clip.section ? [`compound_${slug(clip.section)}`] : []),
    ...(resolvedSegment.tags ?? []),
  ]);

  const candidate: Candidate = {
    candidate_id: `cand_ena_${pad3(clipIndex)}_${slug(clip.display_name)}`,
    segment_id: resolvedSegment.segment_id,
    asset_id: asset.asset_id,
    src_in_us: srcInUs,
    src_out_us: srcOutUs,
    role,
    why_it_matches: buildWhyItMatches(clip, clipIndex, role, beat),
    risks,
    confidence: assetMatch && segment ? 0.96 : 0.9,
    semantic_rank: clipIndex,
    quality_flags: qualityFlags,
    evidence: [
      "human_fcp_timeline",
      `timeline_position:${clip.position}`,
      `clip_index:${clipIndex}`,
      `display_name:${clip.display_name}`,
      `source_window:${describeSourceWindow(clip)}`,
      `used_duration_s:${clip.duration_s.toFixed(6)}`,
      `matched_by:${matchedBy}`,
      ...(clip.section ? [`compound_section:${clip.section}`] : []),
    ],
    eligible_beats: [beat.id],
    motif_tags: motifTags,
    trim_hint: {
      source_center_us: centerUs,
      preferred_duration_us: preferredDurationUs,
      min_duration_us: Math.max(1, Math.round(preferredDurationUs * 0.85)),
      max_duration_us: Math.max(preferredDurationUs, Math.round(preferredDurationUs * 1.15)),
      window_start_us: srcInUs,
      window_end_us: srcOutUs,
      interest_point_label: `decoded human edit clip ${clipIndex}`,
      interest_point_confidence: 0.96,
      rationale: "Decoded FCP timeline provides the human-selected source window and used duration.",
      recommended_in_us: srcInUs,
      recommended_out_us: srcOutUs,
    },
  };

  if (resolvedSegment.transcript_excerpt && resolvedSegment.transcript_excerpt.trim().length > 0) {
    candidate.transcript_excerpt = resolvedSegment.transcript_excerpt;
  }

  return {
    candidate,
    clip,
    clipIndex,
    beatId: beat.id,
    matchedBy,
  };
}

function resolveCandidates(clips: TimelineClip[], beats: BeatSpec[], analysis: AnalysisData): ResolvedClip[] {
  const resolved: ResolvedClip[] = [];
  clips.forEach((clip, index) => {
    const clipIndex = index + 1;
    const beat = beatForClipIndex(clipIndex, beats);
    const item = buildCandidate(clip, clipIndex, clips.length, beat, analysis);
    if (item) resolved.push(item);
  });
  return resolved;
}

function buildSelects(
  projectId: string,
  analysisArtifactVersion: string | undefined,
  resolved: ResolvedClip[],
  analysis: AnalysisData,
  doc: FullTimeline,
): Record<string, unknown> {
  return {
    version: "1",
    project_id: projectId,
    created_at: GENERATED_AT,
    analysis_artifact_version: analysisArtifactVersion ?? "timeline-derived",
    selection_notes: [
      "Candidates are assembled from the decoded Ena human FCP timeline.",
      "Only video clips with type=clip are represented; transitions, gaps, generators, and compound placeholders are excluded.",
      "Compound clips are expanded from full_timeline.sections when that field is present; otherwise only concrete timeline clip rows are used.",
      `Source media list loaded from ${analysis.sourceMediaSource} (${analysis.sourceMediaNames.length} source entries).`,
      `Decoded export duration is ${roundSeconds(doc.export_duration_s ?? 0)}s; candidate source windows use each clip's used timeline duration.`,
    ],
    editorial_summary: {
      dominant_visual_mode: "event_broll",
      speaker_topology: "unknown",
      motion_profile: "high",
      transcript_density: "sparse",
    },
    candidates: resolved.map((item) => item.candidate),
  };
}

function resolvedForBeat(beat: BeatSpec, resolved: ResolvedClip[]): ResolvedClip[] {
  return resolved.filter((item) => item.clipIndex >= beat.posStart && item.clipIndex <= beat.posEnd);
}

export function exactCandidatePlanRefs(
  items: Array<{ candidate: Pick<Candidate, "candidate_id" | "segment_id"> }>,
): string[] {
  return items.map((item) => item.candidate.candidate_id);
}

export function exactCandidatePlanFrames(
  items: Array<{ candidate: Pick<Candidate, "src_in_us" | "src_out_us"> }>,
  fps = OUTPUT_FPS,
): number {
  return items.reduce(
    (total, item) => total + Math.ceil(
      ((item.candidate.src_out_us - item.candidate.src_in_us) * fps) / 1_000_000,
    ),
    0,
  );
}

function buildBeats(beats: BeatSpec[], resolved: ResolvedClip[]): Array<Record<string, unknown>> {
  return beats.map((beat) => {
    const items = resolvedForBeat(beat, resolved);
    const beatClipDurationSec = items.reduce((sum, item) => sum + item.clip.duration_s, 0);
    const targetDurationFrames = Math.max(1, exactCandidatePlanFrames(items));
    // A segment can appear more than once with different human-selected source
    // windows. The exact-order contract therefore needs the occurrence-stable
    // candidate id, not the ambiguous segment id.
    const refs = exactCandidatePlanRefs(items);

    const doc: Record<string, unknown> = {
      id: beat.id,
      label: beat.label,
      purpose: beat.purpose,
      target_duration_frames: targetDurationFrames,
      required_roles: beat.requiredRoles,
      preferred_roles: beat.preferredRoles,
      notes: `human clips ${beat.posStart}-${beat.posEnd}; ${items.length} resolved clip candidates; ${roundSeconds(beatClipDurationSec)}s of used video`,
      story_role: beat.storyRole,
    };

    if (refs.length > 0) {
      doc.candidate_plan = {
        primary_candidate_ref: refs[0],
        fallback_candidate_refs: refs.slice(1),
      };
    }

    return doc;
  });
}

function buildBlueprint(projectId: string, beats: BeatSpec[], resolved: ResolvedClip[]): Record<string, unknown> {
  const targetDurationSec = roundSeconds(exactCandidatePlanFrames(resolved) / OUTPUT_FPS);

  return {
    version: "1",
    project_id: projectId,
    created_at: GENERATED_AT,
    sequence_goals: [
      "reconstruct the decoded human edit order as the Ena tourism promotion evaluation reference",
      "prioritize concrete destination imagery over transitions, generators, or placeholder compound clips",
      "preserve the fast montage rhythm and the source windows chosen in the human FCP timeline",
      "preserve the compact duration of decoded real-video placements while keeping excluded gaps, generators, and compound placeholders as provenance only",
    ],
    beats: buildBeats(beats, resolved),
    pacing: {
      opening_cadence: "fast place-identification hook",
      middle_cadence: "dense tourism montage with short scenic and texture cuts",
      ending_cadence: "slower destination-memory resolve",
      max_shot_length_frames: Math.round(7 * OUTPUT_FPS),
      default_duration_target_sec: targetDurationSec,
    },
    music_policy: {
      start_sparse: false,
      allow_release_late: true,
      entry_beat: "b01",
      avoid_anthemic_lift: false,
      permitted_energy_curve: "brisk promotional lift, textured middle detail, warm closing release",
    },
    dialogue_policy: {
      preserve_natural_breath: true,
      avoid_wall_to_wall_voiceover: true,
      prioritize_lines: ["destination ambience", "local activity sounds", "natural tourism texture"],
    },
    transition_policy: {
      prefer_match_texture_over_flashy_fx: true,
      allow_hard_cuts: true,
      allow_crossfade_for_time_passage: true,
      avoid_speed_ramps: false,
      dissolve_overlap_frames: 12,
    },
    ending_policy: {
      should_feel: "warm, inviting, and complete",
      final_line_strategy: "resolve on destination atmosphere without adding narration",
      avoid_cta: false,
      final_hold_min_frames: 24,
      final_visual_strategy: "land on the decoded closing montage shots as the final memory of Ena",
      final_audio_strategy: "let music and natural ambience taper without abrupt interruption",
    },
    rejection_rules: [
      "reject timeline entries that are not type=clip",
      "reject compound placeholders unless their section clips are explicitly expanded",
      "reject generated titles, gaps, and transitions as video selections",
      "reject source windows that do not preserve the decoded human used duration",
    ],
    story_arc: {
      summary: "Ena is presented through a rapid sequence of scenic place markers, local materials, food and craft textures, town experiences, and closing destination atmosphere.",
      strategy: "chronological",
      chronology_bias: "human editorial order from the decoded FCP timeline overrides source-date order",
      allow_time_reorder: true,
      causal_links: [
        "opening shots identify the destination before the broader tourism montage begins",
        "scenic and drone shots provide scale for the local detail sequence",
        "food, craft, and town textures give the place tactile specificity",
        "the closing montage returns to atmosphere and memory rather than adding a new claim",
      ],
    },
    active_editing_skills: ["human_golden_order", "tourism_montage_density", "destination_texture_bridge"],
    quality_targets: {
      hook_density_min: 0.3,
      novelty_rate_min: 0.6,
      duration_pacing_tolerance_pct: 5,
      emotion_gradient_min: 0.55,
      causal_connectivity_min: 0.7,
    },
    trim_policy: {
      mode: "fixed",
      default_preferred_duration_frames: Math.round(2 * OUTPUT_FPS),
      default_min_duration_frames: Math.round(0.5 * OUTPUT_FPS),
      default_max_duration_frames: Math.round(7 * OUTPUT_FPS),
      action_cut_guard: true,
    },
    duration_policy: {
      mode: "guide",
      source: "explicit_brief",
      target_source: "explicit_brief",
      target_duration_sec: targetDurationSec,
      min_duration_sec: roundSeconds(targetDurationSec * 0.95),
      max_duration_sec: roundSeconds(targetDurationSec * 1.05),
      hard_gate: false,
      protect_vlm_peaks: true,
    },
    timeline_order: "editorial",
    track_layout: "single",
  };
}

function sha256Yaml(data: unknown): string {
  return `sha256:${createHash("sha256").update(YAML.stringify(data)).digest("hex")}`;
}

function buildProjectState(
  projectId: string,
  analysisArtifactVersion: string | undefined,
  selects: Record<string, unknown>,
  blueprint: Record<string, unknown>,
  usedAnalysis: boolean,
): Record<string, unknown> {
  return {
    version: "1",
    project_id: projectId,
    current_state: "approved",
    last_updated: GENERATED_AT,
    last_agent: "operator",
    last_command: "scripts/assemble-ena-golden.ts",
    artifact_hashes: {
      analysis_artifact_version: analysisArtifactVersion ?? "timeline-derived",
      selects_hash: sha256Yaml(selects),
      blueprint_hash: sha256Yaml(blueprint),
    },
    approval_record: {
      status: "clean",
      approved_by: "operator",
      approved_at: GENERATED_AT,
      override_reason: "Human golden assembled from the decoded Ena FCP timeline for eval; eval registry derives tier=human from approved_by=operator.",
    },
    gates: {
      analysis_gate: usedAnalysis ? "ready" : "partial_override",
      compile_gate: "open",
      planning_gate: "open",
      timeline_gate: "open",
      review_gate: "open",
      packaging_gate: "blocked",
    },
    history: [
      {
        from_state: "intent_pending",
        to_state: usedAnalysis ? "media_analyzed" : "selects_ready",
        trigger: "human-golden-import",
        actor: "operator",
        timestamp: GENERATED_AT,
        note: usedAnalysis
          ? "Ena analysis artifacts were available during human golden assembly."
          : "No Ena 03_analysis assets were available; selections use timeline-derived source metadata.",
      },
      {
        from_state: usedAnalysis ? "media_analyzed" : "selects_ready",
        to_state: "blueprint_ready",
        trigger: "assemble-ena-golden",
        actor: "operator",
        timestamp: GENERATED_AT,
        note: "selects_candidates.yaml and edit_blueprint.yaml generated from the decoded human timeline.",
      },
      {
        from_state: "blueprint_ready",
        to_state: "approved",
        trigger: "operator-approval",
        actor: "operator",
        timestamp: GENERATED_AT,
        note: "Human-tier golden marker: approval_record.approved_by=operator.",
      },
    ],
  };
}

function readSchema(name: string): object {
  return readJson<object>(path.join(REPO_ROOT, "schemas", name));
}

function validateWithAjv(name: string, schemaName: string, data: unknown): void {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  const validate = ajv.compile(readSchema(schemaName));
  if (validate(data)) return;

  console.error(`${name} failed AJV validation against ${schemaName}:`);
  for (const error of validate.errors ?? []) {
    console.error(`- ${error.instancePath || "/"} ${error.message ?? ""} ${JSON.stringify(error.params ?? {})}`);
  }
  process.exit(1);
}

function validateSourceWindows(selects: Record<string, unknown>): void {
  const candidates = selects.candidates;
  if (!Array.isArray(candidates)) return;

  const invalid = candidates.filter((item) => {
    if (!isRecord(item)) return false;
    return typeof item.src_in_us === "number" && typeof item.src_out_us === "number" && item.src_in_us >= item.src_out_us;
  });
  if (invalid.length === 0) return;

  for (const item of invalid) {
    const candidate = item as Record<string, unknown>;
    console.error(`Invalid source window for ${String(candidate.segment_id)}: src_in_us must be < src_out_us`);
  }
  process.exit(1);
}

function writeYaml(file: string, data: unknown, header?: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${header ?? ""}${YAML.stringify(data)}`, "utf8");
}

function main(): void {
  const timelineDoc = readJson<FullTimeline>(TIMELINE_PATH);
  const clips = clipsFromTimelineDoc(timelineDoc);
  if (clips.length === 0) {
    throw new Error(`No type=clip entries found in ${TIMELINE_PATH}`);
  }

  const analysis = readAnalysisData(timelineDoc, clips);
  // Analysis may be reused from a sibling AI project, but this assembler owns
  // the canonical human golden identity.
  const projectId = PROJECT_ID;
  const analysisArtifactVersion = analysis.assetsDoc?.artifact_version ?? analysis.segmentsDoc?.artifact_version;
  const beats = buildBeatSpecs(clips.length);
  const resolved = resolveCandidates(clips, beats, analysis);
  if (resolved.length === 0) {
    throw new Error("No human clip candidates were resolved");
  }

  const selects = buildSelects(projectId, analysisArtifactVersion, resolved, analysis, timelineDoc);
  const blueprint = buildBlueprint(projectId, beats, resolved);
  const projectState = buildProjectState(
    projectId,
    analysisArtifactVersion,
    selects,
    blueprint,
    analysis.assetsDoc !== null && analysis.segmentsDoc !== null,
  );

  validateWithAjv("selects_candidates.yaml", "selects-candidates.schema.json", selects);
  validateSourceWindows(selects);
  validateWithAjv("edit_blueprint.yaml", "edit-blueprint.schema.json", blueprint);
  validateWithAjv("project_state.yaml", "project-state.schema.json", projectState);

  writeYaml(path.join(PLAN_DIR, "selects_candidates.yaml"), selects);
  writeYaml(path.join(PLAN_DIR, "edit_blueprint.yaml"), blueprint);
  writeYaml(
    path.join(PROJECT_DIR, "project_state.yaml"),
    projectState,
    "# tier: human (derived by eval registry from approval_record.approved_by: operator)\n",
  );

  const directClipCount = Array.isArray(timelineDoc.timeline)
    ? timelineDoc.timeline.filter((entry) => entry.type === "clip").length
    : 0;
  const compoundCount = Array.isArray(timelineDoc.timeline)
    ? timelineDoc.timeline.filter((entry) => entry.type === "compound_clip").length
    : 0;
  const syntheticCount = resolved.filter((item) => item.matchedBy === "timeline").length;

  console.log(`Generated ${path.relative(REPO_ROOT, path.join(PLAN_DIR, "selects_candidates.yaml"))}`);
  console.log(`Generated ${path.relative(REPO_ROOT, path.join(PLAN_DIR, "edit_blueprint.yaml"))}`);
  console.log(`Generated ${path.relative(REPO_ROOT, path.join(PROJECT_DIR, "project_state.yaml"))}`);
  console.log(`Resolved ${resolved.length} human video clip candidate(s) from ${clips.length} type=clip entry/entries`);
  console.log(`Timeline had ${directClipCount} direct clip(s) and ${compoundCount} compound placeholder(s)`);
  console.log(`Source media list: ${analysis.sourceMediaNames.length} entry/entries from ${analysis.sourceMediaSource}`);
  if (syntheticCount > 0) {
    console.log(`Timeline-derived fallback candidates: ${syntheticCount}`);
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  main();
}
