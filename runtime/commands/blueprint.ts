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
  readPreferenceEntries,
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

function projectAudioStoryRoles(projectDir: string, blueprint?: EditBlueprint): boolean {
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
    beat.story_role = role;
    const refs = roles.get(role) ?? [];
    const suffix = `audio_story_graph:${graphHash} refs:${refs.slice(0, 3).join(",")}`;
    beat.notes = beat.notes ? `${beat.notes}\n${suffix}` : suffix;
    changed = true;
  }
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

function projectP3ContinuityPreferenceSignals(projectDir: string, blueprint?: EditBlueprint): boolean {
  if (!blueprint) return false;
  let changed = false;
  const beats = (blueprint as unknown as { beats?: Array<Record<string, unknown>> }).beats ?? [];

  const graph = readContinuityGraph(projectDir);
  if (graph && beats.length > 0) {
    const graphHash = computeContinuityGraphHash(graph);
    const riskRefs = graph.risks.map((risk) => risk.risk_id);
    if (riskRefs.length > 0) {
      for (const beat of beats) {
        const suffix = `continuity_graph:${graphHash} risks:${riskRefs.slice(0, 3).join(",")}`;
        beat.notes = beat.notes ? `${beat.notes}\n${suffix}` : suffix;
        changed = true;
      }
    }
  }

  const preferencePath = path.join(projectDir, "00_project/editorial_preference_memory.jsonl");
  const preferences = readPreferenceEntries(preferencePath).entries.map((item) => item.entry);
  const active = (["pacing", "chronology", "transition_style"] as PreferenceType[])
    .map((type) => resolveActivePreference(preferences, type).active)
    .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry));
  if (active.length > 0) {
    for (const beat of beats) {
      const suffix = `editorial_preference_memory refs:${active.map((entry) => entry.entry_id).join(",")}`;
      beat.notes = beat.notes ? `${beat.notes}\n${suffix}` : suffix;
      changed = true;
    }
  }

  return changed;
}
