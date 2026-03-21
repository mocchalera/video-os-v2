// Skill Registry — load, activate, and apply editing skills
// Deterministic. No LLM calls.

import * as fs from "node:fs";
import * as path from "node:path";
import { parse as parseYaml } from "yaml";
import { createHash } from "node:crypto";
import type {
  SkillDefinition,
  SkillEffect,
  EditBlueprint,
  Candidate,
  EditorialSummary,
  PolicyDefinition,
} from "../compiler/types.js";

// ── Registry Loading ──────────────────────────────────────────────

const SKILLS_DIR = path.resolve(
  import.meta.url ? path.dirname(new URL(import.meta.url).pathname) : __dirname,
  "skills",
);

let skillCache: Map<string, SkillDefinition> | null = null;

export function loadSkills(dir?: string): Map<string, SkillDefinition> {
  if (skillCache && !dir) return skillCache;
  const skillDir = dir ?? SKILLS_DIR;
  const map = new Map<string, SkillDefinition>();
  if (!fs.existsSync(skillDir)) return map;
  for (const file of fs.readdirSync(skillDir)) {
    if (!file.endsWith(".yaml") && !file.endsWith(".yml")) continue;
    if (file.startsWith("_")) continue; // skip deferred collection file
    const raw = fs.readFileSync(path.join(skillDir, file), "utf-8");
    const def = parseYaml(raw) as SkillDefinition;
    if (def.id && def.status !== "deferred_ir_required") {
      map.set(def.id, def);
    }
  }
  if (!dir) skillCache = map;
  return map;
}

export function clearSkillCache(): void {
  skillCache = null;
}

// ── Skill Activation ──────────────────────────────────────────────

/**
 * Determine which skills are active for a given blueprint.
 * 4-step activation per design doc §2:
 * 1. Read profile default active skills
 * 2. Apply policy suppressions/enforcements
 * 3. Check candidate signal requirements
 * 4. Return final active skill set
 */
export function activateSkills(
  blueprint: EditBlueprint,
  candidates: Candidate[],
  editorialSummary?: EditorialSummary,
  policy?: PolicyDefinition,
  skillsDir?: string,
): string[] {
  const registry = loadSkills(skillsDir);

  // Step 1: Start with blueprint's active_editing_skills or profile defaults
  let activeIds = new Set<string>(blueprint.active_editing_skills ?? []);

  // If no skills specified in blueprint, use all available skills
  if (activeIds.size === 0) {
    for (const [id] of registry) {
      activeIds.add(id);
    }
  }

  // Step 2: Apply policy suppressions and enforcements
  if (policy) {
    for (const suppressed of policy.skill_suppressions ?? []) {
      activeIds.delete(suppressed);
    }
    for (const enforced of policy.skill_enforcements ?? []) {
      if (registry.has(enforced)) {
        activeIds.add(enforced);
      }
    }
  }

  // Step 3: Check required_signals availability
  const availableSignals = collectAvailableSignals(candidates, editorialSummary);
  const validated: string[] = [];
  for (const id of activeIds) {
    const skill = registry.get(id);
    if (!skill) continue;
    // Check if all required signals are available
    const hasSignals = skill.required_signals.every((s) => availableSignals.has(s));
    if (hasSignals) {
      validated.push(id);
    }
  }

  // Step 4: Sort for determinism
  validated.sort();
  return validated;
}

function collectAvailableSignals(
  candidates: Candidate[],
  summary?: EditorialSummary,
): Set<string> {
  const signals = new Set<string>();
  // Always-available signals
  signals.add("confidence");
  signals.add("semantic_rank");

  if (summary) {
    if (summary.dominant_visual_mode) signals.add("dominant_visual_mode");
    if (summary.speaker_topology) signals.add("speaker_topology");
    if (summary.motion_profile) signals.add("motion_profile");
    if (summary.transcript_density) signals.add("transcript_density");
  }

  for (const c of candidates) {
    if (!c.editorial_signals) continue;
    const es = c.editorial_signals;
    if (es.silence_ratio !== undefined) signals.add("silence_ratio");
    if (es.afterglow_score !== undefined) signals.add("afterglow_score");
    if (es.speech_intensity_score !== undefined) signals.add("speech_intensity_score");
    if (es.reaction_intensity_score !== undefined) signals.add("reaction_intensity_score");
    if (es.authenticity_score !== undefined) signals.add("authenticity_score");
    if (es.surprise_signal !== undefined) signals.add("surprise_signal");
    if (es.hope_signal !== undefined) signals.add("hope_signal");
    if (es.face_detected !== undefined) signals.add("face_detected");
    if (es.visual_tags && es.visual_tags.length > 0) signals.add("visual_tags");
    if (es.semantic_cluster_id) signals.add("semantic_cluster_id");
  }

  return signals;
}

// ── Compiler Integration ──────────────────────────────────────────

/**
 * Get the aggregate scoring effect for active skills on a candidate.
 * Returns the total score bonus/penalty to apply.
 */
export function getSkillScoreAdjustment(
  activeSkills: string[],
  candidate: Candidate,
  beatStoryRole?: string,
  skillsDir?: string,
): number {
  const registry = loadSkills(skillsDir);
  let adjustment = 0;

  for (const skillId of activeSkills) {
    const skill = registry.get(skillId);
    if (!skill) continue;
    if (skill.primary_phase !== "score" && skill.primary_phase !== "normalize") continue;

    const effects = skill.effects;
    if (effects.score_bonus) {
      adjustment += effects.score_bonus;
    }
    if (effects.score_penalty) {
      // Penalty applies when condition is violated
      // For axis_hold_dialogue: penalize when speaker continuity breaks
      adjustment -= effects.score_penalty;
    }
  }

  return adjustment;
}

/**
 * Get the aggregate trim bias for active skills on a candidate.
 */
export function getSkillTrimEffects(
  activeSkills: string[],
  candidate: Candidate,
  beatStoryRole?: string,
  skillsDir?: string,
): { durationBiasUs: number; trimBias: number } {
  const registry = loadSkills(skillsDir);
  let durationBiasFrames = 0;
  let trimBias = 0;

  for (const skillId of activeSkills) {
    const skill = registry.get(skillId);
    if (!skill) continue;
    if (skill.primary_phase !== "resolve") continue;

    const effects = skill.effects;
    // Apply trim effects only for relevant beat roles
    if (skillId === "silence_beat" && beatStoryRole !== "closing") continue;
    if (skillId === "cooldown_resolve" && beatStoryRole !== "closing") continue;

    if (effects.duration_bias_frames) {
      durationBiasFrames += effects.duration_bias_frames;
    }
    if (effects.trim_bias) {
      trimBias += effects.trim_bias;
    }
  }

  return { durationBiasUs: durationBiasFrames, trimBias };
}

/**
 * Get metadata tags for active skills applicable to a clip.
 */
export function getSkillMetadataTags(
  activeSkills: string[],
  candidate: Candidate,
  skillsDir?: string,
): string[] {
  const registry = loadSkills(skillsDir);
  const tags: string[] = [];

  for (const skillId of activeSkills) {
    const skill = registry.get(skillId);
    if (!skill) continue;
    if (skill.effects.metadata_tags) {
      tags.push(...skill.effects.metadata_tags);
    }
  }

  return [...new Set(tags)].sort();
}

/**
 * Compute a hash of the editorial registry for provenance tracking.
 */
export function computeRegistryHash(skillsDir?: string): string {
  const registry = loadSkills(skillsDir);
  const entries = [...registry.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  const input = JSON.stringify(entries);
  return createHash("sha256").update(input).digest("hex").slice(0, 16);
}
