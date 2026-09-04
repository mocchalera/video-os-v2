// Narrative arc registry — deterministic YAML loading and validation.
// Arc ratios are provisional editorial hypotheses, not calibrated policy.

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import type { Beat, NarrativeMode, Role } from "../compiler/types.js";

const ARCS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "arcs");
const RATIO_SUM_TOLERANCE = 1e-9;

export interface NarrativeArcBeat {
  id: string;
  ratio: number;
  story_role: NonNullable<Beat["story_role"]>;
  required_roles: Role[];
  tempo: string;
  valence: number;
  evidence_required?: boolean;
}

export interface NarrativeArcDefinition {
  id: string;
  narrative_mode: NarrativeMode;
  status: "provisional";
  beats: NarrativeArcBeat[];
}

let arcCache: Map<string, NarrativeArcDefinition> | null = null;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function requireNonEmptyString(value: unknown, field: string, file: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Narrative arc ${file} requires non-empty ${field}`);
  }
  return value.trim();
}

const VALID_ROLES: Role[] = ["hero", "support", "transition", "texture", "dialogue"];

function parseArcBeat(value: unknown, index: number, file: string): NarrativeArcBeat {
  if (!isRecord(value)) throw new Error(`Narrative arc ${file} beat ${index + 1} must be an object`);
  const id = requireNonEmptyString(value.id, `beats[${index}].id`, file);
  const ratio = value.ratio;
  if (typeof ratio !== "number" || !Number.isFinite(ratio) || ratio <= 0 || ratio > 1) {
    throw new Error(`Narrative arc ${file} beat "${id}" requires ratio in (0, 1]`);
  }
  const storyRole = requireNonEmptyString(value.story_role, `beats[${index}].story_role`, file);
  if (!(["hook", "setup", "experience", "closing"] as string[]).includes(storyRole)) {
    throw new Error(`Narrative arc ${file} beat "${id}" has unsupported story_role "${storyRole}"`);
  }
  const requiredRoles = value.required_roles === undefined
    ? ["hero"]
    : value.required_roles;
  if (
    !Array.isArray(requiredRoles) ||
    requiredRoles.length === 0 ||
    requiredRoles.some((role) => typeof role !== "string" || !VALID_ROLES.includes(role as Role))
  ) {
    throw new Error(
      `Narrative arc ${file} beat "${id}" requires non-empty required_roles from ${VALID_ROLES.join(", ")}`,
    );
  }
  const uniqueRequiredRoles = [...new Set(requiredRoles as Role[])];
  const tempo = requireNonEmptyString(value.tempo, `beats[${index}].tempo`, file);
  const valence = value.valence;
  if (typeof valence !== "number" || !Number.isFinite(valence) || valence < -1 || valence > 1) {
    throw new Error(`Narrative arc ${file} beat "${id}" requires valence in [-1, 1]`);
  }
  if (value.evidence_required !== undefined && typeof value.evidence_required !== "boolean") {
    throw new Error(`Narrative arc ${file} beat "${id}" evidence_required must be boolean`);
  }
  return {
    id,
    ratio,
    story_role: storyRole as NarrativeArcBeat["story_role"],
    required_roles: uniqueRequiredRoles,
    tempo,
    valence,
    ...(typeof value.evidence_required === "boolean"
      ? { evidence_required: value.evidence_required }
      : {}),
  };
}

function parseArc(value: unknown, file: string): NarrativeArcDefinition {
  if (!isRecord(value)) throw new Error(`Narrative arc ${file} must be an object`);
  const id = requireNonEmptyString(value.id, "id", file);
  const narrativeMode = requireNonEmptyString(value.narrative_mode, "narrative_mode", file);
  if (narrativeMode !== "personal_challenge" && narrativeMode !== "day_log") {
    throw new Error(`Narrative arc ${file} has unsupported narrative_mode "${narrativeMode}"`);
  }
  if (value.status !== "provisional") {
    throw new Error(`Narrative arc ${file} status must be "provisional"`);
  }
  if (!Array.isArray(value.beats) || value.beats.length === 0) {
    throw new Error(`Narrative arc ${file} requires at least one beat`);
  }
  const beats = value.beats.map((beat, index) => parseArcBeat(beat, index, file));
  const ids = new Set<string>();
  for (const beat of beats) {
    if (ids.has(beat.id)) throw new Error(`Narrative arc ${file} repeats beat id "${beat.id}"`);
    ids.add(beat.id);
  }
  const ratioSum = beats.reduce((sum, beat) => sum + beat.ratio, 0);
  if (Math.abs(ratioSum - 1) > RATIO_SUM_TOLERANCE) {
    throw new Error(`Narrative arc ${file} beat ratios must sum to 1.0 (received ${ratioSum})`);
  }
  return {
    id,
    narrative_mode: narrativeMode,
    status: "provisional",
    beats,
  };
}

export function loadNarrativeArcs(dir?: string): Map<string, NarrativeArcDefinition> {
  if (arcCache && !dir) return arcCache;
  const arcDir = dir ?? ARCS_DIR;
  const arcs = new Map<string, NarrativeArcDefinition>();
  if (!fs.existsSync(arcDir)) return arcs;
  const modes = new Set<NarrativeMode>();
  for (const file of fs.readdirSync(arcDir).sort()) {
    if (!file.endsWith(".yaml") && !file.endsWith(".yml")) continue;
    const value = parseYaml(fs.readFileSync(path.join(arcDir, file), "utf8"));
    const arc = parseArc(value, file);
    if (arcs.has(arc.id)) throw new Error(`Narrative arc id "${arc.id}" is duplicated`);
    if (modes.has(arc.narrative_mode)) {
      throw new Error(`Narrative mode "${arc.narrative_mode}" is mapped by more than one arc`);
    }
    arcs.set(arc.id, arc);
    modes.add(arc.narrative_mode);
  }
  if (!dir) arcCache = arcs;
  return arcs;
}

export function narrativeArcForMode(
  mode: NarrativeMode,
  dir?: string,
): NarrativeArcDefinition {
  const arc = [...loadNarrativeArcs(dir).values()].find((candidate) => candidate.narrative_mode === mode);
  if (!arc) throw new Error(`No narrative arc is registered for narrative_mode "${mode}"`);
  return arc;
}

export function clearNarrativeArcCache(): void {
  arcCache = null;
}
