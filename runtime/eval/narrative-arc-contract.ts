import {
  narrativeArcForMode,
  type NarrativeArcDefinition,
} from "../editorial/arc-registry.js";
import type {
  Beat,
  CreativeBrief,
  EditBlueprint,
  NarrativeMode,
  NormalizedBeat,
  NormalizedData,
  Role,
  SelectsCandidates,
} from "../compiler/types.js";

export type NarrativeArcContractIssueCode =
  | "narrative_mode_credibility_conflict"
  | "beat_count_mismatch"
  | "beat_id_mismatch"
  | "beat_ratio_mismatch"
  | "required_roles_mismatch"
  | "story_role_mismatch"
  | "emotional_valence_mismatch"
  | "evidence_required_mismatch"
  | "evidence_candidate_missing"
  | "eligible_beat_id_mismatch"
  | "planned_candidate_not_eligible";

export interface NarrativeArcContractIssue {
  code: NarrativeArcContractIssueCode;
  beat_id?: string;
  candidate_ref?: string;
  message: string;
  expected?: unknown;
  actual?: unknown;
  diff?: {
    missing?: unknown[];
    unexpected?: unknown[];
  };
}

export interface NarrativeArcContractResult {
  status: "not_applicable" | "pass" | "fail";
  narrative_mode?: NarrativeMode;
  arc_id?: string;
  issues: NarrativeArcContractIssue[];
}

/**
 * Typed boundary error for a blueprint that cannot be approved or compiled
 * against the registered editorial arc. The result retains the exact
 * expected/actual values so callers can show an actionable diff without
 * parsing a human-oriented message.
 */
export class NarrativeArcContractError extends Error {
  readonly code = "BLUEPRINT_CONTRACT_MISMATCH" as const;
  readonly result: NarrativeArcContractResult;

  constructor(result: NarrativeArcContractResult) {
    const messages = narrativeArcContractMessages(result);
    super(
      `Narrative arc contract failed: ${result.arc_id ? `arc=${result.arc_id} ` : ""}` +
        messages.join("; "),
    );
    this.name = "NarrativeArcContractError";
    this.result = result;
  }
}

interface ArcBeatView {
  id: string;
  target_duration_frames: number;
  required_roles: Role[];
  story_role?: Beat["story_role"];
  emotional_valence?: number;
  evidence_required?: boolean;
  candidate_plan?: Beat["candidate_plan"];
}

function narrativeMode(brief: CreativeBrief): NarrativeMode | undefined {
  return brief.narrative_mode === "personal_challenge" || brief.narrative_mode === "day_log"
    ? brief.narrative_mode
    : undefined;
}

function hasCredibilityFirstConflict(brief: CreativeBrief): boolean {
  return narrativeMode(brief) !== undefined && brief.editorial?.hook_priority === "credibility_first";
}

function candidateForReference(
  selects: SelectsCandidates,
  reference: string,
): SelectsCandidates["candidates"][number] | undefined {
  return selects.candidates.find((candidate) =>
    candidate.candidate_id === reference || candidate.segment_id === reference,
  );
}

function candidateHasEvidence(selects: SelectsCandidates, reference: string): boolean {
  return (candidateForReference(selects, reference)?.evidence?.length ?? 0) > 0;
}

function plannedReferences(beat: ArcBeatView): string[] {
  return [
    beat.candidate_plan?.primary_candidate_ref,
    ...(beat.candidate_plan?.fallback_candidate_refs ?? []),
  ].filter((reference): reference is string => typeof reference === "string" && reference.length > 0);
}

function beatHasEvidenceCandidate(beat: ArcBeatView, selects: SelectsCandidates): boolean {
  return plannedReferences(beat).some((reference) => candidateHasEvidence(selects, reference));
}

function sortedRoles(roles: readonly Role[] | undefined): Role[] {
  return [...(roles ?? [])].sort();
}

function setDiff(expected: readonly string[], actual: readonly string[]): {
  missing: string[];
  unexpected: string[];
} {
  const expectedSet = new Set(expected);
  const actualSet = new Set(actual);
  return {
    missing: expected.filter((value) => !actualSet.has(value)),
    unexpected: actual.filter((value) => !expectedSet.has(value)),
  };
}

function evaluateEligibleBeats(
  blueprintBeatIds: readonly string[],
  beats: readonly ArcBeatView[],
  selects: SelectsCandidates,
): NarrativeArcContractIssue[] {
  const issues: NarrativeArcContractIssue[] = [];

  for (const candidate of selects.candidates) {
    const eligibleBeats = candidate.eligible_beats ?? [];
    if (eligibleBeats.length === 0) continue;
    const diff = setDiff(blueprintBeatIds, eligibleBeats);
    if (diff.unexpected.length > 0) {
      const candidateRef = candidate.candidate_id ?? candidate.segment_id;
      issues.push({
        code: "eligible_beat_id_mismatch",
        candidate_ref: candidateRef,
        message:
          `Candidate "${candidateRef}" eligible_beats contains IDs not present in the blueprint: ` +
          `${diff.unexpected.join(", ")}`,
        expected: [...blueprintBeatIds],
        actual: [...eligibleBeats],
        diff,
      });
    }
  }

  for (const beat of beats) {
    for (const reference of plannedReferences(beat)) {
      const candidate = candidateForReference(selects, reference);
      const eligibleBeats = candidate?.eligible_beats ?? [];
      if (!candidate || eligibleBeats.length === 0 || eligibleBeats.includes(beat.id)) continue;
      issues.push({
        code: "planned_candidate_not_eligible",
        beat_id: beat.id,
        candidate_ref: reference,
        message:
          `Beat "${beat.id}" plans candidate "${reference}", but selects eligible_beats ` +
          `does not include "${beat.id}"`,
        expected: [...eligibleBeats, beat.id],
        actual: [...eligibleBeats],
        diff: { missing: [beat.id], unexpected: [] },
      });
    }
  }

  return issues;
}

function evaluateArcBeats(
  arc: NarrativeArcDefinition,
  beats: readonly ArcBeatView[],
  selects?: SelectsCandidates,
): NarrativeArcContractIssue[] {
  const issues: NarrativeArcContractIssue[] = [];
  const expectedIds = arc.beats.map((beat) => beat.id);
  const actualIds = beats.map((beat) => beat.id);

  if (beats.length !== arc.beats.length) {
    const diff = setDiff(expectedIds, actualIds);
    issues.push({
      code: "beat_count_mismatch",
      message:
        `Narrative arc "${arc.id}" requires ${arc.beats.length} beats; received ${beats.length}. ` +
        `Expected order: ${expectedIds.join(" -> ")}; received: ${actualIds.join(" -> ")}`,
      expected: expectedIds,
      actual: actualIds,
      diff,
    });
  }

  const totalFrames = beats.reduce((sum, beat) => sum + beat.target_duration_frames, 0);
  for (let index = 0; index < arc.beats.length; index += 1) {
    const expected = arc.beats[index];
    const actual = beats[index];
    if (!actual) continue;
    if (actual.id !== expected.id) {
      issues.push({
        code: "beat_id_mismatch",
        beat_id: actual.id,
        message:
          `Narrative arc beat ${index + 1} must be "${expected.id}"; received "${actual.id}". ` +
          `Expected order: ${expectedIds.join(" -> ")}`,
        expected: expected.id,
        actual: actual.id,
        diff: { missing: [expected.id], unexpected: [actual.id] },
      });
    }

    const expectedRoles = sortedRoles(expected.required_roles);
    const actualRoles = sortedRoles(actual.required_roles);
    if (JSON.stringify(actualRoles) !== JSON.stringify(expectedRoles)) {
      const diff = setDiff(expectedRoles, actualRoles);
      issues.push({
        code: "required_roles_mismatch",
        beat_id: actual.id,
        message:
          `Beat "${actual.id}" required_roles must be [${expectedRoles.join(", ")}]; ` +
          `received [${actualRoles.join(", ")}].`,
        expected: expectedRoles,
        actual: actualRoles,
        diff,
      });
    }

    if (actual.story_role !== expected.story_role) {
      issues.push({
        code: "story_role_mismatch",
        beat_id: actual.id,
        message: `Beat "${actual.id}" story_role must be "${expected.story_role}"`,
        expected: expected.story_role,
        actual: actual.story_role,
      });
    }
    if (
      typeof actual.emotional_valence !== "number"
      || Math.abs(actual.emotional_valence - expected.valence) > 1e-9
    ) {
      issues.push({
        code: "emotional_valence_mismatch",
        beat_id: actual.id,
        message: `Beat "${actual.id}" emotional_valence must be ${expected.valence}`,
        expected: expected.valence,
        actual: actual.emotional_valence,
      });
    }
    const expectedEvidenceRequired = expected.evidence_required ?? false;
    if (actual.evidence_required !== expectedEvidenceRequired) {
      issues.push({
        code: "evidence_required_mismatch",
        beat_id: actual.id,
        message: `Beat "${actual.id}" evidence_required must be ${expectedEvidenceRequired}`,
        expected: expectedEvidenceRequired,
        actual: actual.evidence_required,
      });
    }
    if (totalFrames > 0) {
      const expectedFrames = expected.ratio * totalFrames;
      if (Math.abs(actual.target_duration_frames - expectedFrames) > 1) {
        issues.push({
          code: "beat_ratio_mismatch",
          beat_id: actual.id,
          message: `Beat "${actual.id}" duration must follow ratio ${expected.ratio} within one frame`,
          expected: expectedFrames,
          actual: actual.target_duration_frames,
        });
      }
    }
    if (
      expectedEvidenceRequired
      && selects
      && !beatHasEvidenceCandidate(actual, selects)
    ) {
      issues.push({
        code: "evidence_candidate_missing",
        beat_id: actual.id,
        message: `Beat "${actual.id}" requires a planned candidate with source evidence`,
        expected: "planned candidate with non-empty evidence",
        actual: plannedReferences(actual),
      });
    }
  }

  if (selects) {
    issues.push(...evaluateEligibleBeats(expectedIds, beats, selects));
  }
  return issues;
}

function evaluate(
  brief: CreativeBrief,
  beats: readonly ArcBeatView[],
  selects?: SelectsCandidates,
): NarrativeArcContractResult {
  const mode = narrativeMode(brief);
  if (!mode) return { status: "not_applicable", issues: [] };
  if (hasCredibilityFirstConflict(brief)) {
    return {
      status: "fail",
      narrative_mode: mode,
      issues: [{
        code: "narrative_mode_credibility_conflict",
        message: `creative_brief narrative_mode="${mode}" conflicts with editorial.hook_priority="credibility_first"`,
        expected: "non-credibility-first hook priority",
        actual: brief.editorial?.hook_priority,
      }],
    };
  }
  const arc = narrativeArcForMode(mode);
  const issues = evaluateArcBeats(arc, beats, selects);
  return {
    status: issues.length === 0 ? "pass" : "fail",
    narrative_mode: mode,
    arc_id: arc.id,
    issues,
  };
}

export function evaluateNarrativeArcBlueprintContract(
  brief: CreativeBrief,
  blueprint: EditBlueprint,
  selects?: SelectsCandidates,
): NarrativeArcContractResult {
  return evaluate(brief, blueprint.beats, selects);
}

export function assertNarrativeArcBlueprintContract(
  brief: CreativeBrief,
  blueprint: EditBlueprint,
  selects?: SelectsCandidates,
): NarrativeArcContractResult {
  const result = evaluateNarrativeArcBlueprintContract(brief, blueprint, selects);
  if (result.status === "fail") throw new NarrativeArcContractError(result);
  return result;
}

export function evaluateNormalizedNarrativeArcContract(
  brief: CreativeBrief,
  normalized: NormalizedData,
  selects?: SelectsCandidates,
): NarrativeArcContractResult {
  const beats: ArcBeatView[] = normalized.beats.map((beat: NormalizedBeat) => ({
    id: beat.beat_id,
    target_duration_frames: beat.target_duration_frames,
    required_roles: beat.required_roles,
    story_role: beat.story_role,
    emotional_valence: beat.emotional_valence,
    evidence_required: beat.evidence_required,
    candidate_plan: beat.candidate_plan,
  }));
  return evaluate(brief, beats, selects);
}

export function narrativeArcContractMessages(result: NarrativeArcContractResult): string[] {
  return result.issues.map((issue) => issue.message);
}
