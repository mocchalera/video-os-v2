// Script Engine Phase C: Script Draft
// Produces beat-to-candidate_ref assignments, story roles,
// transition proposals, and skill activation hints.
// Creative phase — in production uses LLM agent.
// This module provides the deterministic projection from material reading.

import type { Candidate, EditBlueprint, NormalizedBeat } from "../compiler/types.js";
import type { MaterialReading } from "./read.js";
import type { MessageFrame } from "./frame.js";

export interface BeatAssignment {
  beat_id: string;
  primary_candidate_ref: string;
  backup_candidate_refs: string[];
  story_role: "hook" | "setup" | "experience" | "closing";
  transition_proposal?: string;
  active_skill_hints: string[];
  rationale: string;
}

export interface ScriptDraft {
  version: string;
  project_id: string;
  created_at: string;
  delivery_order: string[];
  beat_assignments: BeatAssignment[];
}

export interface DraftInput {
  projectId: string;
  createdAt: string;
  frame: MessageFrame;
  reading: MaterialReading;
  blueprint: EditBlueprint;
  beats: NormalizedBeat[];
}

/**
 * Build script draft from material reading and message frame.
 * Uses the frame's role_sequence to assign story_roles and
 * the reading's top/backup candidates for assignments.
 */
export function buildScriptDraft(input: DraftInput): ScriptDraft {
  const roleSequence = input.frame.beat_strategy.role_sequence;
  const activeSkills = input.blueprint.active_editing_skills ?? [];

  const assignments: BeatAssignment[] = [];
  const deliveryOrder: string[] = [];

  for (let i = 0; i < input.beats.length; i++) {
    const beat = input.beats[i];
    const reading = input.reading.beat_readings.find((r) => r.beat_id === beat.beat_id);

    const storyRole = roleSequence[i] ?? "experience";
    const primaryRef = reading?.top_candidates[0]?.candidate_ref ?? "";
    const backupRefs = reading?.backup_candidates.map((b) => b.candidate_ref) ?? [];

    // Determine skill hints based on story role
    const skillHints: string[] = [];
    if (storyRole === "hook" && activeSkills.includes("reveal_then_payoff")) {
      skillHints.push("reveal_then_payoff");
    }
    if (storyRole === "closing" && activeSkills.includes("silence_beat")) {
      skillHints.push("silence_beat");
    }
    if (storyRole === "closing" && activeSkills.includes("cooldown_resolve")) {
      skillHints.push("cooldown_resolve");
    }
    if (activeSkills.includes("build_to_peak") && i > 0 && i < input.beats.length - 1) {
      skillHints.push("build_to_peak");
    }

    const rationale = reading?.top_candidates[0]?.why_primary
      ?? `Assigned to beat ${beat.beat_id} as ${storyRole}`;

    assignments.push({
      beat_id: beat.beat_id,
      primary_candidate_ref: primaryRef,
      backup_candidate_refs: backupRefs,
      story_role: storyRole,
      active_skill_hints: skillHints,
      rationale,
    });

    deliveryOrder.push(beat.beat_id);
  }

  return {
    version: "1",
    project_id: input.projectId,
    created_at: input.createdAt,
    delivery_order: deliveryOrder,
    beat_assignments: assignments,
  };
}
