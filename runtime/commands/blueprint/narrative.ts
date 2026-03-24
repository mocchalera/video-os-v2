import * as fs from "node:fs";
import * as path from "node:path";
import { parse as parseYaml } from "yaml";
import { buildMessageFrame, type FrameInput, type MessageFrame } from "../../script/frame.js";
import { buildMaterialReading, type ReadInput } from "../../script/read.js";
import { buildScriptDraft, type DraftInput } from "../../script/draft.js";
import { evaluateScript, type EvaluateInput } from "../../script/evaluate.js";
import type {
  Candidate,
  EditBlueprint,
  NormalizedBeat,
} from "../../artifacts/types.js";
import { buildDefaultStubBlueprint } from "./stub.js";
import type {
  BlueprintAgent,
  BlueprintAgentResult,
  ConfirmResult,
  DraftResult,
  EvaluateResult,
  FrameResult,
  LoopSummary,
  NarrativePhaseContext,
  NarrativePhases,
  ReadResult,
  RevisionBrief,
  UncertaintyRegister,
} from "./index.js";

interface NarrativeLoopResult {
  success: boolean;
  agentResult?: BlueprintAgentResult;
  loopSummary?: LoopSummary;
  evaluateResult?: EvaluateResult;
  confirmResult?: ConfirmResult;
  lastWarnings?: string[];
  errorMessage?: string;
}

export async function runNarrativeLoop(
  ctx: NarrativePhaseContext,
  phases: NarrativePhases,
  agent: BlueprintAgent,
  maxIterations: number,
  requireConfirmation: boolean,
): Promise<NarrativeLoopResult> {
  let evaluateRejectCount = 0;
  let humanDeclineCount = 0;
  let lastEvaluation: EvaluateResult | undefined;
  let lastConfirm: ConfirmResult | undefined;

  const frameResult = await phases.frame(ctx);
  const readResult = await phases.read(ctx, frameResult);

  let revisionBrief: RevisionBrief | undefined;
  let draftResult: DraftResult | undefined;

  for (let iteration = 0; iteration < maxIterations; iteration++) {
    draftResult = await phases.draft(ctx, frameResult, readResult, revisionBrief);
    lastEvaluation = await phases.evaluate(ctx, frameResult, readResult, draftResult);

    if (lastEvaluation.gatePassed) {
      break;
    }

    evaluateRejectCount++;
    revisionBrief = lastEvaluation.revisionBrief;

    if (iteration === maxIterations - 1) {
      return {
        success: false,
        loopSummary: {
          totalIterations: iteration + 1,
          evaluateRejectCount,
          humanDeclineCount,
          finalStatus: "rejected_max_iterations",
        },
        evaluateResult: lastEvaluation,
        lastWarnings: lastEvaluation.warnings,
      };
    }
  }

  if (!draftResult || !lastEvaluation?.gatePassed) {
    return {
      success: false,
      errorMessage: "Draft loop ended without passing gate",
      loopSummary: {
        totalIterations: evaluateRejectCount,
        evaluateRejectCount,
        humanDeclineCount,
        finalStatus: "rejected_max_iterations",
      },
      evaluateResult: lastEvaluation,
    };
  }

  if (ctx.autonomyMode === "collaborative" && requireConfirmation) {
    lastConfirm = await phases.confirm(ctx, draftResult, lastEvaluation);
    if (lastConfirm.status === "declined") {
      humanDeclineCount++;
      return {
        success: false,
        loopSummary: {
          totalIterations: evaluateRejectCount + 1,
          evaluateRejectCount,
          humanDeclineCount,
          finalStatus: "human_declined",
        },
        evaluateResult: lastEvaluation,
        confirmResult: lastConfirm,
      };
    }
  }

  const agentResult = await phases.project(ctx, draftResult, lastEvaluation);
  return {
    success: true,
    agentResult,
    loopSummary: {
      totalIterations: evaluateRejectCount + 1,
      evaluateRejectCount,
      humanDeclineCount,
      finalStatus: "accepted",
    },
    evaluateResult: lastEvaluation,
    confirmResult: lastConfirm,
  };
}

export function buildDefaultPhases(
  absDir: string,
  projectId: string,
  selectsContent: unknown,
  briefContent: unknown,
  autonomyMode: "full" | "collaborative",
): NarrativePhases {
  const selects = selectsContent as {
    candidates?: Candidate[];
    beats?: NormalizedBeat[];
  };
  const candidates = selects?.candidates ?? [];

  const blueprintPath = path.join(absDir, "04_plan/edit_blueprint.yaml");
  let existingBlueprint: EditBlueprint | undefined;
  if (fs.existsSync(blueprintPath)) {
    try {
      existingBlueprint = parseYaml(fs.readFileSync(blueprintPath, "utf-8")) as EditBlueprint;
    } catch {
      // Ignore invalid rerun seed; downstream validation will catch issues.
    }
  }

  const beats: NormalizedBeat[] = selects?.beats
    ?? (existingBlueprint?.beats?.map((beat) => ({
      beat_id: beat.id,
      label: beat.label,
      target_duration_frames: beat.target_duration_frames,
      required_roles: beat.required_roles,
      preferred_roles: beat.preferred_roles ?? [],
      purpose: beat.purpose ?? beat.label,
    })) ?? []);
  const stubBlueprint = buildDefaultStubBlueprint(projectId, beats);

  return {
    async frame(ctx) {
      const brief = ctx.briefContent as {
        project?: {
          story_promise?: string;
          hook_angle?: string;
          closing_intent?: string;
          runtime_target_sec?: number;
        };
        editorial_profile_hint?: string;
        editorial_policy_hint?: string;
      };

      const frameInput: FrameInput = {
        projectId: ctx.projectId,
        createdAt: new Date().toISOString(),
        storyPromise: brief?.project?.story_promise ?? "Untitled story",
        hookAngle: brief?.project?.hook_angle ?? "cold open",
        closingIntent: brief?.project?.closing_intent ?? "resolve and reflect",
        resolutionInput: {
          briefEditorial: {
            profile_hint: brief?.editorial_profile_hint ?? "interview-highlight",
            policy_hint: brief?.editorial_policy_hint ?? "default",
          },
          runtimeTargetSec: brief?.project?.runtime_target_sec,
        },
        beatCount: beats.length || 4,
      };

      const { frame } = buildMessageFrame(frameInput);
      return {
        storyPromise: frame.story_promise,
        hookAngle: frame.hook_angle,
        closingIntent: frame.closing_intent,
        beatCount: frame.beat_strategy.beat_count,
        qualityTargets: frame.quality_targets,
      };
    },

    async read(ctx, frameResult) {
      const readInput: ReadInput = {
        projectId: ctx.projectId,
        createdAt: new Date().toISOString(),
        beats,
        candidates,
        blueprint: existingBlueprint ?? stubBlueprint,
      };

      const reading = buildMaterialReading(readInput);
      return {
        beatReadings: reading.beat_readings.map((beatReading) => ({
          beatId: beatReading.beat_id,
          topCandidates: beatReading.top_candidates.map((candidate) => candidate.candidate_ref),
          coverageGaps: beatReading.coverage_gaps,
        })),
      };
    },

    async draft(ctx, frameResult, readResult, revisionBrief) {
      const readingForDraft = {
        version: "1",
        project_id: ctx.projectId,
        created_at: new Date().toISOString(),
        beat_readings: readResult.beatReadings.map((beatReading) => ({
          beat_id: beatReading.beatId,
          top_candidates: beatReading.topCandidates.map((ref) => ({
            candidate_ref: ref,
            why_primary: "matched by reading",
          })),
          backup_candidates: [] as Array<{ candidate_ref: string; why_backup?: string }>,
          coverage_gaps: beatReading.coverageGaps,
          asset_concentration: 0,
          speaker_risks: [] as string[],
          tone_risks: [] as string[],
        })),
        dedupe_groups: [],
      };

      if (revisionBrief?.preferBackups) {
        for (const beatReading of readingForDraft.beat_readings) {
          const backups = revisionBrief.preferBackups.filter((backup) =>
            !beatReading.top_candidates.some((candidate) => candidate.candidate_ref === backup)
          );
          beatReading.backup_candidates = backups.map((ref) => ({
            candidate_ref: ref,
            why_backup: "suggested by revision brief",
          }));
        }
      }

      const draftFrame: MessageFrame = {
        version: "1",
        project_id: ctx.projectId,
        created_at: new Date().toISOString(),
        story_promise: frameResult.storyPromise,
        hook_angle: frameResult.hookAngle,
        closing_intent: frameResult.closingIntent,
        resolved_profile_candidate: { id: "default", source: "default" },
        resolved_policy_candidate: { id: "default", source: "default" },
        beat_strategy: {
          beat_count: frameResult.beatCount,
          role_sequence: buildDefaultRoleSequenceFromCount(frameResult.beatCount),
        },
      };

      const draftInput: DraftInput = {
        projectId: ctx.projectId,
        createdAt: new Date().toISOString(),
        frame: draftFrame,
        reading: readingForDraft,
        blueprint: existingBlueprint ?? stubBlueprint,
        beats,
      };

      const scriptDraft = buildScriptDraft(draftInput);
      return {
        deliveryOrder: scriptDraft.delivery_order,
        beatAssignments: scriptDraft.beat_assignments.map((assignment) => ({
          beatId: assignment.beat_id,
          primaryCandidateRef: assignment.primary_candidate_ref,
          backupCandidateRefs: assignment.backup_candidate_refs,
          storyRole: assignment.story_role,
        })),
      };
    },

    async evaluate(ctx, frameResult, readResult, draftResult) {
      const evalInput: EvaluateInput = {
        projectId: ctx.projectId,
        createdAt: new Date().toISOString(),
        draft: {
          version: "1",
          project_id: ctx.projectId,
          created_at: new Date().toISOString(),
          delivery_order: draftResult.deliveryOrder,
          beat_assignments: draftResult.beatAssignments.map((assignment) => ({
            beat_id: assignment.beatId,
            primary_candidate_ref: assignment.primaryCandidateRef,
            backup_candidate_refs: assignment.backupCandidateRefs,
            story_role: assignment.storyRole,
            active_skill_hints: [],
            rationale: "",
          })),
        },
        candidates,
        blueprint: existingBlueprint ?? stubBlueprint,
        beats,
        qualityTargets: frameResult.qualityTargets,
      };

      const evaluation = evaluateScript(evalInput);
      const revisionBrief: RevisionBrief | undefined = !evaluation.gate_pass
        ? {
            preserve: evaluation.warnings
              .filter((warning) => warning.type !== "missing_assignment")
              .map((warning) => warning.beat_id ?? "")
              .filter(Boolean),
            mustFix: evaluation.warnings.map((warning) => warning.message),
            brokenBeats: evaluation.missing_beats,
            preferBackups: evaluation.repairs.map((repair) => repair.to_candidate_ref),
          }
        : undefined;

      return {
        gatePassed: evaluation.gate_pass,
        metrics: {
          hookDensity: evaluation.metrics.hook_density,
          noveltyRate: evaluation.metrics.novelty_rate,
        },
        warnings: evaluation.warnings.map((warning) => warning.message),
        revisionBrief,
      };
    },

    async confirm(ctx, draftResult, evaluation) {
      if (ctx.autonomyMode === "collaborative") {
        return { status: "skipped" };
      }
      return { status: "skipped" };
    },

    async project(ctx, draftResult, evaluation) {
      const now = new Date().toISOString();
      const blueprint: EditBlueprint = {
        version: "1",
        project_id: ctx.projectId,
        created_at: now,
        sequence_goals: existingBlueprint?.sequence_goals ?? [],
        beats: beats.map((beat) => ({
          id: beat.beat_id,
          label: beat.label,
          target_duration_frames: beat.target_duration_frames,
          required_roles: beat.required_roles,
          preferred_roles: beat.preferred_roles,
        })),
        pacing: {
          opening_cadence: existingBlueprint?.pacing?.opening_cadence ?? "medium",
          middle_cadence: existingBlueprint?.pacing?.middle_cadence ?? "varied",
          ending_cadence: existingBlueprint?.pacing?.ending_cadence ?? "slow-fade",
          confirmed_preferences: {
            mode: ctx.autonomyMode,
            source: ctx.autonomyMode === "full" ? "ai_autonomous" : "human_confirmed",
            duration_target_sec: (ctx.briefContent as { project?: { runtime_target_sec?: number } })?.project?.runtime_target_sec ?? 120,
            confirmed_at: now,
          },
        },
        music_policy: existingBlueprint?.music_policy ?? {
          start_sparse: true,
          allow_release_late: true,
          entry_beat: beats[0]?.beat_id ?? "B1",
        },
        caption_policy: existingBlueprint?.caption_policy,
        dialogue_policy: existingBlueprint?.dialogue_policy ?? {
          preserve_natural_breath: true,
          avoid_wall_to_wall_voiceover: true,
        },
        transition_policy: existingBlueprint?.transition_policy ?? {
          prefer_match_texture_over_flashy_fx: true,
        },
        ending_policy: existingBlueprint?.ending_policy ?? {
          should_feel: "resolved",
        },
        rejection_rules: existingBlueprint?.rejection_rules ?? [],
      };

      const register: UncertaintyRegister = {
        version: "1",
        project_id: ctx.projectId,
        created_at: now,
        uncertainties: [],
      };

      return {
        blueprint,
        uncertaintyRegister: register,
        confirmed: true,
      };
    },
  };
}

function buildDefaultRoleSequenceFromCount(
  count: number,
): Array<"hook" | "setup" | "experience" | "closing"> {
  if (count <= 1) return ["hook"];
  if (count === 2) return ["hook", "closing"];
  if (count === 3) return ["hook", "experience", "closing"];
  const sequence: Array<"hook" | "setup" | "experience" | "closing"> = ["hook", "setup"];
  for (let i = 2; i < count - 1; i++) {
    sequence.push("experience");
  }
  sequence.push("closing");
  return sequence;
}
