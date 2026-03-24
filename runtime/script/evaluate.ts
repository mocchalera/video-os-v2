// Script Engine Phase D: Script Evaluation
// Deterministic quality evaluation of the script draft.
// No LLM calls. Computes metrics, detects issues, proposes repairs.

import type { Candidate, EditBlueprint, NormalizedBeat, QualityTargets } from "../compiler/types.js";
import type { ScriptDraft, BeatAssignment } from "./draft.js";
import { getCandidateRef, buildCandidateRefMap } from "../compiler/candidate-ref.js";

export interface EvaluationWarning {
  type: string;
  message: string;
  beat_id?: string;
  candidate_ref?: string;
}

export interface EvaluationRepair {
  from_candidate_ref: string;
  to_candidate_ref: string;
  reason: string;
  beat_id?: string;
}

export interface EvaluationMetrics {
  hook_density: number;
  novelty_rate: number;
  duration_pacing?: {
    total_duration_sec: number;
    target_duration_sec: number;
    within_tolerance: boolean;
  };
  emotion_gradient?: number;
  causal_connectivity?: number;
}

export interface ScriptEvaluation {
  version: string;
  project_id: string;
  created_at: string;
  metrics: EvaluationMetrics;
  warnings: EvaluationWarning[];
  repairs: EvaluationRepair[];
  missing_beats: string[];
  gate_pass: boolean;
}

export interface EvaluateInput {
  projectId: string;
  createdAt: string;
  draft: ScriptDraft;
  candidates: Candidate[];
  blueprint: EditBlueprint;
  beats: NormalizedBeat[];
  qualityTargets?: Partial<QualityTargets>;
}

/**
 * Evaluate script draft quality deterministically.
 * Computes metrics, checks for issues, proposes repairs.
 */
export function evaluateScript(input: EvaluateInput): ScriptEvaluation {
  const candidateRefMap = buildCandidateRefMap(input.candidates);
  const warnings: EvaluationWarning[] = [];
  const repairs: EvaluationRepair[] = [];
  const missing_beats: string[] = [];

  // ── Metric: hook_density ──────────────────────────────────────
  // Ratio of opening beats with high-salience candidates
  const hookAssignments = input.draft.beat_assignments.filter(
    (a) => a.story_role === "hook",
  );
  const openingBeats = hookAssignments.length || 1;
  let highSalienceCount = 0;
  for (const a of hookAssignments) {
    const candidate = candidateRefMap.get(a.primary_candidate_ref);
    if (!candidate) continue;
    // Salience: confidence >= 0.65 or editorial_signals.speech_intensity_score >= 0.65
    const intensity = candidate.editorial_signals?.speech_intensity_score ?? 0;
    if (candidate.confidence >= 0.65 || intensity >= 0.65) {
      highSalienceCount++;
    }
  }
  const hook_density = highSalienceCount / openingBeats;

  // ── Metric: novelty_rate ──────────────────────────────────────
  // Unique semantic keys among primary beats
  const primaryRefs = new Set<string>();
  const primaryKeys = new Set<string>();
  for (const a of input.draft.beat_assignments) {
    if (!a.primary_candidate_ref) continue;
    primaryRefs.add(a.primary_candidate_ref);
    const candidate = candidateRefMap.get(a.primary_candidate_ref);
    const key = candidate?.semantic_dedupe_key ?? a.primary_candidate_ref;
    primaryKeys.add(key);
  }
  const novelty_rate = primaryRefs.size > 0 ? primaryKeys.size / primaryRefs.size : 1;

  // ── Metric: duration_pacing ───────────────────────────────────
  const totalFrames = input.beats.reduce((s, b) => s + b.target_duration_frames, 0);
  const totalDurationSec = totalFrames / 24; // assuming 24fps
  const blueprintProject = input.blueprint["project"] as { runtime_target_sec?: number } | undefined;
  const targetSec = input.blueprint.pacing?.default_duration_target_sec
    ?? blueprintProject?.runtime_target_sec
    ?? totalDurationSec;
  const tolerance = input.qualityTargets?.duration_pacing_tolerance_pct ?? 10;
  const withinTolerance =
    Math.abs(totalDurationSec - targetSec) / targetSec * 100 <= tolerance;

  // ── Checks ────────────────────────────────────────────────────

  // Check for unassigned beats
  for (const beat of input.beats) {
    const assignment = input.draft.beat_assignments.find((a) => a.beat_id === beat.beat_id);
    if (!assignment || !assignment.primary_candidate_ref) {
      missing_beats.push(beat.beat_id);
      warnings.push({
        type: "missing_assignment",
        message: `Beat ${beat.beat_id} has no primary candidate assigned`,
        beat_id: beat.beat_id,
      });
    }
  }

  // Check for closing beat support
  const closingAssignments = input.draft.beat_assignments.filter(
    (a) => a.story_role === "closing",
  );
  if (closingAssignments.length === 0 && input.beats.length > 2) {
    warnings.push({
      type: "closing_unsupported",
      message: "No closing beat assigned — story may feel unresolved",
    });
  }

  // Check utterance uniqueness (hard dedupe)
  const usedRefs = new Map<string, string>(); // ref -> first beat_id
  for (const a of input.draft.beat_assignments) {
    if (!a.primary_candidate_ref) continue;
    const prev = usedRefs.get(a.primary_candidate_ref);
    if (prev) {
      warnings.push({
        type: "duplicate_primary",
        message: `Candidate ${a.primary_candidate_ref} used in both ${prev} and ${a.beat_id}`,
        beat_id: a.beat_id,
        candidate_ref: a.primary_candidate_ref,
      });
      // Propose repair: swap to backup
      if (a.backup_candidate_refs.length > 0) {
        repairs.push({
          from_candidate_ref: a.primary_candidate_ref,
          to_candidate_ref: a.backup_candidate_refs[0],
          reason: `Duplicate primary usage; swapping to backup`,
          beat_id: a.beat_id,
        });
      }
    }
    usedRefs.set(a.primary_candidate_ref, a.beat_id);
  }

  // Check semantic near-duplicates in adjacent beats
  const assignments = input.draft.beat_assignments;
  for (let i = 1; i < assignments.length; i++) {
    const prev = candidateRefMap.get(assignments[i - 1].primary_candidate_ref);
    const curr = candidateRefMap.get(assignments[i].primary_candidate_ref);
    if (prev && curr && prev.semantic_dedupe_key && curr.semantic_dedupe_key) {
      if (prev.semantic_dedupe_key === curr.semantic_dedupe_key) {
        warnings.push({
          type: "adjacent_semantic_duplicate",
          message: `Adjacent beats ${assignments[i - 1].beat_id} and ${assignments[i].beat_id} have same semantic key`,
          beat_id: assignments[i].beat_id,
        });
      }
    }
  }

  // Check interviewer contamination in non-support beats
  for (const a of input.draft.beat_assignments) {
    const candidate = candidateRefMap.get(a.primary_candidate_ref);
    if (candidate?.speaker_role === "interviewer" &&
      a.story_role !== "setup" &&
      candidate.role !== "support") {
      warnings.push({
        type: "interviewer_contamination",
        message: `Interviewer as primary in ${a.story_role} beat ${a.beat_id}`,
        beat_id: a.beat_id,
        candidate_ref: a.primary_candidate_ref,
      });
    }
  }

  // ── Gate determination ────────────────────────────────────────
  const hookTarget = input.qualityTargets?.hook_density_min ?? 0.3;
  const noveltyTarget = input.qualityTargets?.novelty_rate_min ?? 0.5;

  const gate_pass =
    hook_density >= hookTarget &&
    novelty_rate >= noveltyTarget &&
    missing_beats.length === 0 &&
    !warnings.some((w) => w.type === "closing_unsupported");

  return {
    version: "1",
    project_id: input.projectId,
    created_at: input.createdAt,
    metrics: {
      hook_density,
      novelty_rate,
      duration_pacing: {
        total_duration_sec: totalDurationSec,
        target_duration_sec: targetSec,
        within_tolerance: withinTolerance,
      },
    },
    warnings,
    repairs,
    missing_beats,
    gate_pass,
  };
}
