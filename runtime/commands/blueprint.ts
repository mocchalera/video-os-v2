export * from "./blueprint/index.js";

import * as fs from "node:fs";
import * as path from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import {
  runBlueprint as runBlueprintImpl,
  type BlueprintAgent,
  type BlueprintCommandOptions,
  type BlueprintCommandResult,
  type NarrativePhases,
} from "./blueprint/index.js";
import {
  computeAudioStoryGraphHash,
  isP2AudioStoryGraphEnabled,
  readAudioStoryGraph,
  type AudioStoryGraph,
} from "../artifacts/p2-audio-story-graph.js";
import {
  computeContinuityGraphHash,
  isP3ContinuityPreferenceEnabled,
  readContinuityGraph,
} from "../artifacts/p3-continuity-graph.js";
import {
  computePreferenceMemoryHash,
  readResolvedPreferenceEntries,
  resolveActivePreference,
  type PreferenceType,
} from "../artifacts/p3-preference-memory.js";
import type { EditBlueprint } from "../artifacts/types.js";

export async function runBlueprint(
  projectDir: string,
  agent: BlueprintAgent,
  options?: BlueprintCommandOptions,
  phases?: NarrativePhases,
): Promise<BlueprintCommandResult> {
  const result = await runBlueprintImpl(projectDir, agent, options, phases);
  if (!result.success) return result;

  const absDir = path.resolve(projectDir);
  const projectedP2 = isP2AudioStoryGraphEnabled() && projectAudioStoryRoles(absDir, result.blueprint);
  const projectedP3 = isP3ContinuityPreferenceEnabled() && projectP3ContinuityPreferenceSignals(absDir, result.blueprint);
  const projected = projectedP2 || projectedP3;
  if (!projected) return result;

  const blueprintPath = path.join(absDir, "04_plan/edit_blueprint.yaml");
  if (fs.existsSync(blueprintPath)) {
    const fileBlueprint = parseYaml(fs.readFileSync(blueprintPath, "utf-8")) as EditBlueprint;
    const changedP2 = isP2AudioStoryGraphEnabled() && projectAudioStoryRoles(absDir, fileBlueprint);
    const changedP3 = isP3ContinuityPreferenceEnabled() && projectP3ContinuityPreferenceSignals(absDir, fileBlueprint);
    if (changedP2 || changedP3) {
      fs.writeFileSync(blueprintPath, stringifyYaml(fileBlueprint), "utf-8");
    }
  }
  return result;
}

export function projectAudioStoryRoles(projectDir: string, blueprint?: EditBlueprint): boolean {
  if (!blueprint) return false;
  const graph = readAudioStoryGraph(projectDir);
  if (!graph) return false;
  const roles = summarizeStoryRoles(graph);
  if (roles.size === 0) return false;
  const graphHash = computeAudioStoryGraphHash(graph);
  let changed = false;
  const beats = (blueprint as unknown as { beats?: Array<Record<string, unknown>> }).beats ?? [];
  for (const beat of beats) {
    const label = String(beat.label ?? beat.id ?? "").toLowerCase();
    const role = chooseBeatRole(label, roles);
    if (!role) continue;
    const refs = roles.get(role) ?? [];
    beat.audio_story_role = {
      node_id: refs[0],
      role,
      evidence_node_ids: refs.slice(0, 3),
      graph_hash: graphHash,
    };
    changed = true;
  }
  if (changed) ensurePlanningMinorVersion(blueprint);
  return changed;
}

function summarizeStoryRoles(graph: AudioStoryGraph): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const node of graph.nodes) {
    const role = node.story_role === "payoff" ? "closing" : node.story_role;
    if (!role || role === "reaction") continue;
    if (!map.has(role)) map.set(role, []);
    map.get(role)!.push(node.node_id);
  }
  return map;
}

function chooseBeatRole(label: string, roles: Map<string, string[]>): string | null {
  if ((label.includes("hook") || label.includes("intro")) && roles.has("hook")) return "hook";
  if ((label.includes("setup") || label.includes("problem")) && roles.has("setup")) return "setup";
  if ((label.includes("closing") || label.includes("ending") || label.includes("payoff")) && roles.has("closing")) return "closing";
  if (roles.has("experience")) return "experience";
  return roles.keys().next().value ?? null;
}

export function projectP3ContinuityPreferenceSignals(projectDir: string, blueprint?: EditBlueprint): boolean {
  if (!blueprint) return false;
  let changed = false;
  const beats = (blueprint as unknown as { beats?: Array<Record<string, unknown>> }).beats ?? [];

  const graph = readContinuityGraph(projectDir);
  if (graph && beats.length > 0) {
    const graphHash = computeContinuityGraphHash(graph);
    const enforcedEntityIds = collectEnforcedEntityIds(graph);
    if (enforcedEntityIds.length > 0) {
      const chronology = graph.edges.some((edge) => edge.type === "chronologically_before")
        ? "chronological"
        : graph.risks.some((risk) => risk.type === "chronology_uncertain" || risk.type === "axis_break")
          ? "editorial_reorder"
          : "chronological";
      for (const beat of beats) {
        beat.continuity_constraint = {
          chronology,
          enforced_entity_ids: enforcedEntityIds,
          graph_hash: graphHash,
        };
        changed = true;
      }
    }
  }

  const preferenceRead = readResolvedPreferenceEntries(projectDir, blueprint.project_id);
  const preferences = preferenceRead.entries.map((item) => item.entry)
    .filter((entry) => entry.scope === "project" && (entry.scope_ref === undefined || entry.scope_ref === blueprint.project_id));
  const active = ([
    "pacing",
    "chronology",
    "transition_style",
    "repetition_tolerance",
    "bgm_loudness",
    "caption_density",
    "delivery_preference",
  ] as PreferenceType[])
    .map((type) => resolveActivePreference(preferences, type).active)
    .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry));
  if (active.length > 0) {
    const raw = fs.readFileSync(preferenceRead.resolution.path, "utf-8");
    const consumedHash = computePreferenceMemoryHash(raw);
    for (const beat of beats) {
      beat.applied_preferences = active.map((entry) => ({
        entry_id: entry.entry_id,
        preference_type: entry.preference_type,
        consumed_offset: preferenceRead.lastKnownGoodOffset,
        consumed_hash: consumedHash,
      }));
      changed = true;
    }
  }

  if (changed) ensurePlanningMinorVersion(blueprint);
  return changed;
}

function ensurePlanningMinorVersion(artifact: { version?: string }): void {
  if (!artifact.version) return;
  const match = artifact.version.match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!match) return;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  if (major === 1 && minor < 1) {
    artifact.version = "1.1.0";
  }
}

function collectEnforcedEntityIds(graph: NonNullable<ReturnType<typeof readContinuityGraph>>): string[] {
  const riskRefs = new Set(graph.risks.flatMap((risk) => risk.refs));
  const segmentToEntities = new Map(graph.segments.map((segment) => [segment.segment_id, segment.entity_ids]));
  const entityIds = new Set<string>();
  for (const ref of riskRefs) {
    if (/^ENT_(SUBJECT|LOCATION|PROP|MOTIF|ACTION)_/.test(ref)) {
      entityIds.add(ref);
      continue;
    }
    for (const entityId of segmentToEntities.get(ref) ?? []) {
      entityIds.add(entityId);
    }
  }
  if (entityIds.size === 0) {
    for (const entity of graph.entities) entityIds.add(entity.entity_id);
  }
  return Array.from(entityIds).sort();
}
