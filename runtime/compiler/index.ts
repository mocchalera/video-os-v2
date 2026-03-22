// Timeline Compiler — Main entry point
// Orchestrates Phase 1-5 to produce timeline.json from project artifacts.
// Pure, deterministic. No LLM calls. No randomness.

import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { parse as parseYaml } from "yaml";
import { normalize } from "./normalize.js";
import { scoreCandidates } from "./score.js";
import { assemble } from "./assemble.js";
import { applyAdaptiveTrim } from "./trim.js";
import { applyDurationAdjust } from "./duration-adjust.js";
import { resolve } from "./resolve.js";
import { buildTimelineIR, exportOtio, writePreviewManifest, writeTimeline } from "./export.js";
import { applyPatch } from "./patch.js";
import { resolveDurationPolicyFromBlueprint } from "./duration-helpers.js";
import { activateSkills, computeRegistryHash, getSkillMetadataTags } from "../editorial/skill-registry.js";
import { adjacencyDecide, writeAdjacencyAnalysis } from "./adjacency.js";
import { loadBgmAnalysis } from "../connectors/bgm-beat-detector.js";
import type {
  CompileOptions,
  CompilerDefaults,
  CreativeBrief,
  DurationPolicy,
  EditBlueprint,
  SelectsCandidates,
  TimelineIR,
} from "./types.js";

export type { TimelineIR, CompileOptions };
export { applyPatch } from "./patch.js";
export type { ReviewPatch, PatchResult, PatchError, PatchOperation } from "./patch.js";
export type { ResolutionReport } from "./resolve.js";

export interface CompileResult {
  timeline: TimelineIR;
  outputPath: string;
  otioPath: string;
  previewManifestPath: string;
  resolution: {
    resolved_overlaps: number;
    resolved_duplicates: number;
    resolved_invalid_ranges: number;
    duration_fit: boolean;
    total_frames: number;
    target_frames: number;
    duration_mode?: string;
    target_source?: string;
    min_target_frames?: number;
    max_target_frames?: number | null;
    duration_status?: string;
    duration_delta_frames?: number;
    duration_delta_pct?: number;
  };
  duration_policy?: DurationPolicy;
}

function findRepoRoot(from: string): string {
  let dir = path.resolve(from);
  while (dir !== path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, "schemas"))) return dir;
    dir = path.dirname(dir);
  }
  throw new Error("Could not find repo root (directory containing schemas/)");
}

function readYaml<T>(filePath: string): T {
  const raw = fs.readFileSync(filePath, "utf-8");
  return parseYaml(raw) as T;
}

export function compile(opts: CompileOptions): CompileResult {
  const projectPath = path.resolve(opts.projectPath);
  const repoRoot = opts.repoRoot
    ? path.resolve(opts.repoRoot)
    : findRepoRoot(projectPath);

  // ── Read input artifacts ──────────────────────────────────────────

  const briefPath = path.join(projectPath, "01_intent/creative_brief.yaml");
  const blueprintPath = path.join(projectPath, "04_plan/edit_blueprint.yaml");
  const selectsPath = path.join(projectPath, "04_plan/selects_candidates.yaml");
  const defaultsPath = path.join(repoRoot, "runtime/compiler-defaults.yaml");

  const brief = readYaml<CreativeBrief>(briefPath);
  const blueprint = opts.blueprintOverride ?? readYaml<EditBlueprint>(blueprintPath);
  const selects = readYaml<SelectsCandidates>(selectsPath);
  const defaults = readYaml<CompilerDefaults>(defaultsPath);

  // ── Phase 0.5: Resolve Duration Policy ──────────────────────────
  // Compute material total duration for guide+no-target case.
  const materialTotalSec = selects.candidates
    .filter((c) => c.role !== "reject")
    .reduce((sum, c) => sum + (c.src_out_us - c.src_in_us) / 1_000_000, 0);

  const durationPolicy = resolveDurationPolicyFromBlueprint(
    blueprint,
    brief,
    materialTotalSec,
  );

  // ── Phase 1: Normalize ────────────────────────────────────────────

  const normalized = normalize(brief, blueprint);

  // ── Phase 1.5: Skill Activation ──────────────────────────────────
  // Determine which editing skills are active based on blueprint + candidates.
  // Fail-open: if no active_editing_skills in blueprint, use empty set (no skill effects).

  const activeSkills = blueprint.active_editing_skills
    ? activateSkills(blueprint, selects.candidates, selects.editorial_summary)
    : [];

  // ── Phase 2: Score ────────────────────────────────────────────────

  // Use fps from compile options if provided, otherwise default to 24fps.
  // For source material at 30fps, pass fpsNum: 30 via compile options.
  const fpsNum = opts.fpsNum ?? 24;
  const fpsDen = 1;
  const rankedTable = scoreCandidates(
    normalized,
    selects.candidates,
    defaults.scoring,
    fpsNum,
    fpsDen,
    activeSkills,
    durationPolicy,
  );

  // ── Phase 3: Assemble ─────────────────────────────────────────────

  const assembled = assemble(normalized, rankedTable, defaults.scoring, fpsNum, fpsDen, durationPolicy);

  // ── Phase 3.5: Adaptive Trim ────────────────────────────────────
  // Apply center-based trim when trim_hint is available.
  // Falls back to authored range when no hints exist.

  const allAssembledClips = [
    ...assembled.tracks.video.flatMap((t) => t.clips),
    ...assembled.tracks.audio.flatMap((t) => t.clips),
  ];
  const usPerFrame = (1_000_000 * fpsDen) / fpsNum;
  applyAdaptiveTrim(allAssembledClips, selects.candidates, blueprint, normalized.beats, usPerFrame);

  // ── Phase 3.5b: Duration Adjustment (strict mode) ───────────────
  applyDurationAdjust(assembled, normalized.beats, selects.candidates, durationPolicy, fpsNum, fpsDen);

  // ── Phase 4: Resolve constraints ──────────────────────────────────

  const resolution = resolve(assembled, normalized.total_duration_frames, selects.candidates, durationPolicy, fpsNum, fpsDen);

  // ── Phase 4.5: Adjacency Decide ──────────────────────────────────
  // Analyze adjacent clip pairs on V1 and assign transition skills.
  // Only runs when active editing skills are available.

  let adjacencyTransitions: import("./transition-types.js").TimelineTransition[] = [];

  if (activeSkills.length > 0 && assembled.tracks.video.length > 0) {
    const v1Track = assembled.tracks.video[0];
    if (v1Track.clips.length > 1) {
      // Load BGM analysis if available
      const bgmAnalysis = loadBgmAnalysis(projectPath);

      const adjResult = adjacencyDecide(v1Track, {
        activeEditingSkills: activeSkills,
        durationMode: durationPolicy?.mode ?? "guide",
        fpsNum,
        bgmAnalysis,
        candidates: selects.candidates,
        beats: normalized.beats,
        transitionSkillsDir: opts.repoRoot
          ? path.join(opts.repoRoot, "runtime/editorial/transition-skills")
          : undefined,
      });

      adjacencyTransitions = adjResult.transitions;

      // Set project_id on analysis
      adjResult.analysis.project_id = normalized.project_id;

      // Write adjacency analysis artifact
      writeAdjacencyAnalysis(adjResult.analysis, projectPath);
    }
  }

  // ── Phase 5: Export ───────────────────────────────────────────────

  const createdAt = opts.createdAt;

  let timelineIR = buildTimelineIR(assembled, {
    projectId: normalized.project_id,
    projectTitle: normalized.project_title,
    projectPath,
    createdAt,
    briefRelPath: "01_intent/creative_brief.yaml",
    blueprintRelPath: "04_plan/edit_blueprint.yaml",
    selectsRelPath: "04_plan/selects_candidates.yaml",
    fpsNum,
    fpsDen,
    durationPolicy,
    transitions: adjacencyTransitions.length > 0 ? adjacencyTransitions : undefined,
  });

  // ── Phase 5.5: Editorial Metadata ─────────────────────────────────
  // Attach skill metadata and provenance hashes when active skills exist.

  if (activeSkills.length > 0) {
    // Add provenance hashes
    timelineIR.provenance.editorial_registry_hash = computeRegistryHash();

    // Attach editorial metadata to clips
    for (const trackGroup of [timelineIR.tracks.video, timelineIR.tracks.audio]) {
      for (const track of trackGroup) {
        for (const clip of track.clips) {
          // Find matching candidate for metadata tags
          const matchingCandidate = selects.candidates.find(
            (c) => c.segment_id === clip.segment_id &&
              c.src_in_us === clip.src_in_us &&
              c.src_out_us === clip.src_out_us,
          ) ?? selects.candidates.find((c) => c.segment_id === clip.segment_id);

          if (matchingCandidate) {
            const tags = getSkillMetadataTags(activeSkills, matchingCandidate);
            if (tags.length > 0) {
              if (!clip.metadata) clip.metadata = {};
              (clip.metadata as Record<string, unknown>).editorial = {
                applied_skills: activeSkills,
                skill_tags: tags,
                resolved_profile: blueprint.resolved_profile?.id,
                resolved_policy: blueprint.resolved_policy?.id,
              };
            }
          }
        }
      }
    }
  }

  // Add compiler defaults hash to provenance
  const defaultsHash = createHash("sha256")
    .update(JSON.stringify(defaults))
    .digest("hex")
    .slice(0, 16);
  timelineIR.provenance.compiler_defaults_hash = defaultsHash;

  let finalResolution = resolution;
  if (opts.reviewPatch) {
    const patchResult = applyPatch(
      timelineIR,
      opts.reviewPatch,
      selects.candidates,
      normalized.total_duration_frames,
      durationPolicy,
      fpsNum,
      fpsDen,
    );
    if (patchResult.errors.length > 0) {
      const details = patchResult.errors
        .map((error) => `${error.op}(${error.op_index}): ${error.message}`)
        .join("; ");
      throw new Error(`Review patch could not be applied during compile: ${details}`);
    }
    timelineIR = patchResult.timeline;
    finalResolution = patchResult.resolution;
  }

  const outputPath = writeTimeline(timelineIR, projectPath);
  const otioPath = exportOtio(timelineIR, projectPath);
  const previewManifestPath = writePreviewManifest(timelineIR, projectPath);

  return {
    timeline: timelineIR,
    outputPath,
    otioPath,
    previewManifestPath,
    resolution: finalResolution,
    duration_policy: durationPolicy,
  };
}
