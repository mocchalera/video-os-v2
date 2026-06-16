#!/usr/bin/env npx tsx

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { config as dotenvConfig } from "dotenv";
import YAML from "yaml";

const require = createRequire(import.meta.url);
const Ajv2020 = require("ajv/dist/2020") as new (opts: Record<string, unknown>) => AjvLike;
const addFormats = require("ajv-formats") as (ajv: unknown) => void;

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const PROJECT_ID = "togakushi-camp";
const PROJECT_DIR = path.join(REPO_ROOT, "projects", PROJECT_ID);
const ANALYSIS_DIR = path.join(PROJECT_DIR, "03_analysis");
const PLAN_DIR = path.join(PROJECT_DIR, "04_plan");
const OUTPUT_FPS = 24;

dotenvConfig({ path: path.join(REPO_ROOT, ".env.local"), quiet: true });
dotenvConfig({ path: path.join(REPO_ROOT, ".env"), quiet: true });

type Role = "hero" | "support" | "texture";
type StoryRole = "hook" | "setup" | "experience" | "closing";

type HumanCut = {
  pos: number;
  take: string;
  playDurS: number;
  srcDurS: number;
  note: string;
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
  };
};

type ResolvedCandidate = {
  candidate: Candidate;
  take: string;
  positions: number[];
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

const HUMAN_CUTS: HumanCut[] = [
  { pos: 1, take: "T015", playDurS: 3.88, srcDurS: 7.09, note: "Opening: Togakushi landscape" },
  { pos: 2, take: "T012", playDurS: 2.46, srcDurS: 12.60, note: "Opening: landscape/campfire" },
  { pos: 3, take: "T016", playDurS: 2.83, srcDurS: 9.13, note: "Opening: landscape" },
  { pos: 4, take: "T020", playDurS: 2.83, srcDurS: 11.09, note: "Day 1: activity" },
  { pos: 5, take: "T018", playDurS: 3.83, srcDurS: 10.64, note: "Day 1: activity" },
  { pos: 6, take: "T023", playDurS: 3.83, srcDurS: 8.05, note: "Day 1: activity" },
  { pos: 7, take: "T026", playDurS: 3.50, srcDurS: 16.64, note: "Day 1: activity" },
  { pos: 8, take: "T029", playDurS: 4.71, srcDurS: 5.19, note: "Day 1: activity" },
  { pos: 9, take: "T031", playDurS: 5.75, srcDurS: 12.16, note: "Day 1: activity" },
  { pos: 10, take: "T035", playDurS: 3.67, srcDurS: 16.06, note: "Day 1: BBQ/evening" },
  { pos: 11, take: "T036", playDurS: 2.71, srcDurS: 11.55, note: "Day 1: evening" },
  { pos: 12, take: "T039", playDurS: 2.79, srcDurS: 10.09, note: "Day 1: campfire/night" },
  { pos: 13, take: "T042", playDurS: 2.92, srcDurS: 7.09, note: "Day 1: night" },
  { pos: 14, take: "T037", playDurS: 3.21, srcDurS: 17.10, note: "Day 1: night" },
  { pos: 15, take: "T050", playDurS: 5.92, srcDurS: 12.60, note: "Day 2 start" },
  { pos: 16, take: "T056", playDurS: 8.75, srcDurS: 12.75, note: "Day 2: morning" },
  { pos: 17, take: "T058", playDurS: 4.25, srcDurS: 13.31, note: "Day 2: morning" },
  { pos: 18, take: "T062", playDurS: 4.92, srcDurS: 10.73, note: "Day 2: activity" },
  { pos: 19, take: "T001", playDurS: 4.29, srcDurS: 17.60, note: "Day 2: activity" },
  { pos: 20, take: "T005", playDurS: 4.42, srcDurS: 15.57, note: "Day 2: activity" },
  { pos: 21, take: "T003", playDurS: 4.58, srcDurS: 11.88, note: "Day 2: activity" },
  { pos: 22, take: "T008", playDurS: 3.71, srcDurS: 49.13, note: "Day 2: activity" },
  { pos: 23, take: "T009", playDurS: 4.54, srcDurS: 21.06, note: "Day 2: activity" },
  { pos: 24, take: "T010", playDurS: 4.46, srcDurS: 18.14, note: "Day 2: activity" },
  { pos: 25, take: "T012", playDurS: 3.92, srcDurS: 18.06, note: "Bookend: reuse of opening" },
  { pos: 26, take: "T015", playDurS: 3.50, srcDurS: 7.09, note: "Bookend: reuse of opening" },
  { pos: 27, take: "T016", playDurS: 4.46, srcDurS: 10.09, note: "Bookend: reuse of opening" },
  { pos: 28, take: "T019", playDurS: 3.08, srcDurS: 7.09, note: "Closing" },
  { pos: 29, take: "T027", playDurS: 4.00, srcDurS: 6.79, note: "Closing" },
];

const BEATS: BeatSpec[] = [
  {
    id: "b01",
    label: "Opening — Togakushi Landscape",
    posStart: 1,
    posEnd: 3,
    purpose: "Establish Togakushi with spacious landscape and camp atmosphere before the activity montage begins.",
    storyRole: "hook",
    requiredRoles: ["hero"],
    preferredRoles: ["texture"],
  },
  {
    id: "b02",
    label: "Day 1 — Arrival & Play",
    posStart: 4,
    posEnd: 9,
    purpose: "Move from arrival energy into the first day of play and exploration.",
    storyRole: "setup",
    requiredRoles: ["support"],
    preferredRoles: ["hero"],
  },
  {
    id: "b03",
    label: "Day 1 — BBQ & Campfire",
    posStart: 10,
    posEnd: 14,
    purpose: "Shift into evening warmth with BBQ, campfire, and night texture.",
    storyRole: "experience",
    requiredRoles: ["support"],
    preferredRoles: ["texture"],
  },
  {
    id: "b04",
    label: "Day 2 — Morning",
    posStart: 15,
    posEnd: 18,
    purpose: "Restart the story with a slower morning cadence before day two activity.",
    storyRole: "experience",
    requiredRoles: ["support"],
    preferredRoles: ["hero"],
  },
  {
    id: "b05",
    label: "Day 2 — Activity & Exploration",
    posStart: 19,
    posEnd: 24,
    purpose: "Carry the main day two action with concise support cuts in the decoded human order.",
    storyRole: "experience",
    requiredRoles: ["support"],
    preferredRoles: ["texture"],
  },
  {
    id: "b06",
    label: "Closing — Bookend & Farewell",
    posStart: 25,
    posEnd: 29,
    purpose: "Reprise the opening landscape as a bookend, then land on a brief farewell texture.",
    storyRole: "closing",
    requiredRoles: ["hero", "texture"],
    preferredRoles: ["support"],
  },
];

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

function roleForPosition(pos: number): Role {
  if (pos >= 1 && pos <= 3) return "hero";
  if (pos >= 25 && pos <= 27) return "hero";
  if (pos >= 28 && pos <= 29) return "texture";
  return "support";
}

function beatIdForPosition(pos: number): string {
  const beat = BEATS.find((item) => pos >= item.posStart && pos <= item.posEnd);
  if (!beat) {
    throw new Error(`No beat maps to human cut position ${pos}`);
  }
  return beat.id;
}

function beatLabelForPosition(pos: number): string {
  return BEATS.find((item) => pos >= item.posStart && pos <= item.posEnd)?.label ?? `position ${pos}`;
}

function roleForCuts(cuts: HumanCut[]): Role {
  const roles = cuts.map((cut) => roleForPosition(cut.pos));
  if (roles.includes("hero")) return "hero";
  if (roles.includes("support")) return "support";
  return "texture";
}

function normalizeForTakeMatch(value: string): string {
  return path.basename(value, path.extname(value)).toUpperCase();
}

function takeMatchesValue(take: string, value: string | undefined): boolean {
  if (!value) return false;
  const normalized = normalizeForTakeMatch(value);
  const expected = `NINJAV_S001_S001_${take}`.toUpperCase();
  if (normalized === expected || normalized.includes(expected)) return true;

  const escaped = take.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const tokenPattern = new RegExp(`(^|[_\\-.\\s])${escaped}($|[_\\-.\\s])`, "i");
  return tokenPattern.test(normalized);
}

function findAssetForTake(take: string, assets: AssetItem[]): { asset: AssetItem; matchedBy: string } | null {
  const fields: Array<keyof AssetItem> = ["display_name", "filename", "source_locator"];
  for (const field of fields) {
    const matches = assets
      .filter((asset) => takeMatchesValue(take, typeof asset[field] === "string" ? asset[field] : undefined))
      .sort((a, b) => a.asset_id.localeCompare(b.asset_id));
    if (matches.length > 0) {
      if (matches.length > 1) {
        console.warn(`WARNING: take ${take} matched multiple assets by ${field}; using ${matches[0].asset_id}`);
      }
      return { asset: matches[0], matchedBy: field };
    }
  }
  return null;
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

function groupHumanCutsByTake(): Array<{ take: string; cuts: HumanCut[] }> {
  const groups = new Map<string, HumanCut[]>();
  for (const cut of HUMAN_CUTS) {
    const existing = groups.get(cut.take);
    if (existing) existing.push(cut);
    else groups.set(cut.take, [cut]);
  }

  return [...groups.entries()]
    .map(([take, cuts]) => ({ take, cuts: cuts.sort((a, b) => a.pos - b.pos) }))
    .sort((a, b) => a.cuts[0].pos - b.cuts[0].pos);
}

function describePositions(positions: number[]): string {
  return positions.length === 1 ? `position ${positions[0]}` : `positions ${positions.join(", ")}`;
}

function buildWhyItMatches(take: string, cuts: HumanCut[], role: Role): string {
  const positions = cuts.map((cut) => cut.pos);
  const beatLabels = unique(cuts.map((cut) => beatLabelForPosition(cut.pos)));
  const verb = positions.length === 1 ? "uses" : "use";
  return `${describePositions(positions)} ${verb} ${take} as a ${role} shot for ${beatLabels.join(" and ")}.`;
}

function buildCandidate(
  take: string,
  cuts: HumanCut[],
  asset: AssetItem,
  segment: SegmentItem,
  matchedBy: string,
): ResolvedCandidate | null {
  if (segment.src_out_us <= segment.src_in_us) {
    console.warn(`WARNING: segment ${segment.segment_id} for ${take} has invalid source bounds; skipping`);
    return null;
  }

  const positions = cuts.map((cut) => cut.pos);
  const role = roleForCuts(cuts);
  const segmentDurationUs = segment.src_out_us - segment.src_in_us;
  const preferredDurationUs = toUs(Math.max(...cuts.map((cut) => cut.playDurS)));
  const maxDurationUs = Math.max(preferredDurationUs, Math.min(segmentDurationUs, Math.round(preferredDurationUs * 1.5)));
  const minDurationUs = Math.max(1, Math.round(Math.min(preferredDurationUs, segmentDurationUs) * 0.75));
  const sourceCenterUs = typeof segment.rep_frame_us === "number"
    ? segment.rep_frame_us
    : segment.src_in_us + Math.round(segmentDurationUs / 2);
  const qualityFlags = unique([...(segment.quality_flags ?? []), ...(asset.quality_flags ?? [])]);
  const tags = unique([take.toLowerCase(), role, ...cuts.map((cut) => beatIdForPosition(cut.pos)), ...(segment.tags ?? [])]);

  const candidate: Candidate = {
    candidate_id: `cand_togakushi_${take.toLowerCase()}`,
    segment_id: segment.segment_id,
    asset_id: asset.asset_id,
    src_in_us: segment.src_in_us,
    src_out_us: segment.src_out_us,
    role,
    why_it_matches: buildWhyItMatches(take, cuts, role),
    risks: [],
    confidence: 0.95,
    semantic_rank: positions[0],
    quality_flags: qualityFlags,
    evidence: [
      "human_fcp_coredata",
      `take:${take}`,
      `positions:${positions.join(",")}`,
      `matched_by:${matchedBy}`,
      `human_play_durations_s:${cuts.map((cut) => cut.playDurS.toFixed(2)).join(",")}`,
      `human_source_durations_s:${cuts.map((cut) => cut.srcDurS.toFixed(2)).join(",")}`,
    ],
    eligible_beats: unique(cuts.map((cut) => beatIdForPosition(cut.pos))),
    motif_tags: tags,
    trim_hint: {
      source_center_us: sourceCenterUs,
      preferred_duration_us: preferredDurationUs,
      min_duration_us: minDurationUs,
      max_duration_us: maxDurationUs,
      window_start_us: segment.src_in_us,
      window_end_us: segment.src_out_us,
      interest_point_label: `decoded human edit ${take} ${describePositions(positions)}`,
      interest_point_confidence: 0.95,
      rationale: "FCP CoreData human edit order provides the golden trim intent.",
    },
  };

  if (segment.transcript_excerpt && segment.transcript_excerpt.trim().length > 0) {
    candidate.transcript_excerpt = segment.transcript_excerpt;
  }

  return { candidate, take, positions };
}

function buildSelects(
  projectId: string,
  analysisArtifactVersion: string | undefined,
  resolved: ResolvedCandidate[],
  missingTakes: string[],
): Record<string, unknown> {
  return {
    version: "1",
    project_id: projectId,
    created_at: new Date().toISOString(),
    analysis_artifact_version: analysisArtifactVersion ?? "unknown",
    selection_notes: [
      "Candidates are assembled from decoded human FCP CoreData decisions and current 03_analysis artifacts.",
      "Repeated opening/bookend takes are represented once and list all decoded timeline positions in evidence.",
      missingTakes.length > 0
        ? `Analysis is incomplete for unresolved human takes: ${missingTakes.join(", ")}.`
        : "All decoded human takes were resolved to analysis segments.",
    ],
    editorial_summary: {
      dominant_visual_mode: "event_broll",
      speaker_topology: "unknown",
      motion_profile: "medium",
      transcript_density: "sparse",
    },
    candidates: resolved.map((item) => item.candidate),
  };
}

function humanCutsForBeat(beat: BeatSpec): HumanCut[] {
  return HUMAN_CUTS.filter((cut) => cut.pos >= beat.posStart && cut.pos <= beat.posEnd);
}

function refsForBeat(beat: BeatSpec, resolved: ResolvedCandidate[]): string[] {
  const refs: string[] = [];
  const beatPositions = humanCutsForBeat(beat).map((cut) => cut.pos);

  for (const pos of beatPositions) {
    const found = resolved.find((item) => item.positions.includes(pos));
    if (found) refs.push(found.candidate.segment_id);
  }

  return unique(refs);
}

function buildBeats(resolved: ResolvedCandidate[]): Array<Record<string, unknown>> {
  return BEATS.map((beat) => {
    const cuts = humanCutsForBeat(beat);
    const refs = refsForBeat(beat, resolved);
    const targetDurationFrames = Math.max(1, Math.round(cuts.reduce((sum, cut) => sum + cut.playDurS, 0) * OUTPUT_FPS));
    const unresolvedPositions = cuts
      .map((cut) => cut.pos)
      .filter((pos) => !resolved.some((item) => item.positions.includes(pos)));
    const notes = [
      `human positions ${beat.posStart}-${beat.posEnd}`,
      unresolvedPositions.length > 0 ? `awaiting analysis for positions ${unresolvedPositions.join(", ")}` : "all human positions resolved",
    ].join("; ");
    const doc: Record<string, unknown> = {
      id: beat.id,
      label: beat.label,
      purpose: beat.purpose,
      target_duration_frames: targetDurationFrames,
      required_roles: beat.requiredRoles,
      preferred_roles: beat.preferredRoles,
      notes,
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

function buildBlueprint(projectId: string, resolved: ResolvedCandidate[]): Record<string, unknown> {
  const totalDurationSec = roundSeconds(HUMAN_CUTS.reduce((sum, cut) => sum + cut.playDurS, 0));

  return {
    version: "1",
    project_id: projectId,
    created_at: new Date().toISOString(),
    sequence_goals: [
      "reconstruct the decoded human edit order as the evaluation golden reference",
      "open with Togakushi landscape atmosphere, then follow the two-day camp experience",
      "reuse the opening landscape takes as an intentional bookend before the final farewell texture",
      "keep the pacing concise and observational, matching the human cut durations",
    ],
    beats: buildBeats(resolved),
    pacing: {
      opening_cadence: "spacious landscape hook",
      middle_cadence: "brisk chronological camp montage",
      ending_cadence: "warm bookend and short farewell",
      max_shot_length_frames: Math.round(9 * OUTPUT_FPS),
      default_duration_target_sec: totalDurationSec,
    },
    music_policy: {
      start_sparse: true,
      allow_release_late: true,
      entry_beat: "b01",
      avoid_anthemic_lift: false,
      permitted_energy_curve: "gentle scenic open, lively middle, restrained closing release",
    },
    dialogue_policy: {
      preserve_natural_breath: true,
      avoid_wall_to_wall_voiceover: true,
      prioritize_lines: ["camp ambience", "family reactions", "natural activity audio"],
    },
    transition_policy: {
      prefer_match_texture_over_flashy_fx: true,
      allow_hard_cuts: true,
      allow_crossfade_for_time_passage: true,
      avoid_speed_ramps: true,
      dissolve_overlap_frames: 12,
    },
    ending_policy: {
      should_feel: "warm, complete, lightly nostalgic",
      final_line_strategy: "finish on the decoded closing texture without adding narration",
      avoid_cta: true,
      final_hold_min_frames: 24,
      final_visual_strategy: "bookend the opening landscape, then land on the two farewell cuts",
      final_audio_strategy: "let natural audio and music taper cleanly through the final hold",
    },
    rejection_rules: [
      "reject candidates not present in the decoded human FCP timeline",
      "reject reordering that breaks the supplied 1-29 timeline positions",
      "reject duplicate candidates for reused opening/bookend takes; reuse the same segment reference instead",
      "reject flashy transitions that overpower the observational camp footage",
    ],
    story_arc: {
      summary: "Togakushi camp unfolds from scenic arrival through day-one play, evening campfire, day-two activity, and a landscape bookend farewell.",
      strategy: "chronological",
      chronology_bias: "two-day chronology with an intentional opening-shot reprise at the end",
      allow_time_reorder: true,
      causal_links: [
        "opening landscape establishes place before activity begins",
        "day-one play flows into evening BBQ and campfire texture",
        "day-two morning resets the pace before the main activity sequence",
        "bookend reuse of the opening shots creates closure",
      ],
    },
    active_editing_skills: ["human_golden_order", "bookend_reprise", "natural_audio_continuity"],
    quality_targets: {
      hook_density_min: 0.2,
      novelty_rate_min: 0.45,
      duration_pacing_tolerance_pct: 5,
      emotion_gradient_min: 0.55,
      causal_connectivity_min: 0.75,
    },
    trim_policy: {
      mode: "fixed",
      default_preferred_duration_frames: Math.round(4 * OUTPUT_FPS),
      default_min_duration_frames: Math.round(2 * OUTPUT_FPS),
      default_max_duration_frames: Math.round(9 * OUTPUT_FPS),
      action_cut_guard: true,
    },
    duration_policy: {
      mode: "guide",
      source: "explicit_brief",
      target_source: "explicit_brief",
      target_duration_sec: totalDurationSec,
      min_duration_sec: roundSeconds(totalDurationSec * 0.95),
      max_duration_sec: roundSeconds(totalDurationSec * 1.05),
      hard_gate: false,
      protect_vlm_peaks: true,
    },
    timeline_order: "editorial",
    track_layout: "single",
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

function writeYaml(file: string, data: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, YAML.stringify(data), "utf8");
}

function main(): void {
  const assetsDoc = readArtifactItems<AssetItem>(path.join(ANALYSIS_DIR, "assets.json"), "assets.json");
  const segmentsDoc = readArtifactItems<SegmentItem>(path.join(ANALYSIS_DIR, "segments.json"), "segments.json");
  const projectId = assetsDoc.project_id ?? PROJECT_ID;
  const resolved: ResolvedCandidate[] = [];
  const missingTakes: string[] = [];

  for (const { take, cuts } of groupHumanCutsByTake()) {
    const assetMatch = findAssetForTake(take, assetsDoc.items);
    if (!assetMatch) {
      console.warn(`WARNING: take ${take} (${describePositions(cuts.map((cut) => cut.pos))}) not found in assets.json`);
      missingTakes.push(take);
      continue;
    }

    if (assetMatch.matchedBy !== "display_name") {
      console.warn(`WARNING: take ${take} matched by ${assetMatch.matchedBy}; display_name did not contain the expected take token`);
    }

    const segment = findSegmentForAsset(assetMatch.asset, segmentsDoc.items);
    if (!segment) {
      console.warn(`WARNING: asset ${assetMatch.asset.asset_id} for take ${take} has no segment in segments.json`);
      missingTakes.push(take);
      continue;
    }

    const candidate = buildCandidate(take, cuts, assetMatch.asset, segment, assetMatch.matchedBy);
    if (candidate) resolved.push(candidate);
  }

  const selects = buildSelects(projectId, assetsDoc.artifact_version, resolved, unique(missingTakes));
  const blueprint = buildBlueprint(projectId, resolved);

  validateWithAjv("selects_candidates.yaml", "selects-candidates.schema.json", selects);
  validateSourceWindows(selects);
  validateWithAjv("edit_blueprint.yaml", "edit-blueprint.schema.json", blueprint);

  writeYaml(path.join(PLAN_DIR, "selects_candidates.yaml"), selects);
  writeYaml(path.join(PLAN_DIR, "edit_blueprint.yaml"), blueprint);

  console.log(`Generated ${path.relative(REPO_ROOT, path.join(PLAN_DIR, "selects_candidates.yaml"))}`);
  console.log(`Generated ${path.relative(REPO_ROOT, path.join(PLAN_DIR, "edit_blueprint.yaml"))}`);
  console.log(`Resolved ${resolved.length} unique candidate(s); unresolved take(s): ${unique(missingTakes).length}`);
}

main();
