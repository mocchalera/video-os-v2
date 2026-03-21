// Script Engine Phase A: Message Frame
// Determines story_promise, hook_angle, closing_intent, profile/policy candidates,
// and beat strategy from the creative brief.
// Creative phase — can use LLM agent or deterministic defaults.

import type { ResolvedRef, QualityTargets } from "../compiler/types.js";
import type { ResolutionInput, ResolutionResult } from "../editorial/policy-resolver.js";
import { resolveProfileAndPolicy } from "../editorial/policy-resolver.js";

export interface MessageFrame {
  version: string;
  project_id: string;
  created_at: string;
  story_promise: string;
  hook_angle: string;
  closing_intent: string;
  resolved_profile_candidate: ResolvedRef;
  resolved_policy_candidate: ResolvedRef;
  beat_strategy: {
    beat_count: number;
    role_sequence: Array<"hook" | "setup" | "experience" | "closing">;
    chronology_bias?: string;
    target_duration_window?: { min_sec: number; max_sec: number };
  };
  quality_targets?: Partial<QualityTargets>;
}

export interface FrameInput {
  projectId: string;
  createdAt: string;
  /** From agent or deterministic extraction */
  storyPromise: string;
  hookAngle: string;
  closingIntent: string;
  /** Resolution input for profile/policy */
  resolutionInput: ResolutionInput;
  /** Beat count from agent or default */
  beatCount: number;
  /** Role sequence from agent or default */
  roleSequence?: Array<"hook" | "setup" | "experience" | "closing">;
  /** Profile/policy directories (for testing) */
  profilesDir?: string;
  policiesDir?: string;
}

/**
 * Build the message frame from inputs.
 * In production, storyPromise/hookAngle/closingIntent come from the blueprint-planner agent.
 * The profile/policy resolution is deterministic.
 */
export function buildMessageFrame(input: FrameInput): {
  frame: MessageFrame;
  resolution: ResolutionResult;
} {
  const resolution = resolveProfileAndPolicy(
    input.resolutionInput,
    input.profilesDir,
    input.policiesDir,
  );

  const roleSequence = input.roleSequence ?? buildDefaultRoleSequence(input.beatCount);

  const frame: MessageFrame = {
    version: "1",
    project_id: input.projectId,
    created_at: input.createdAt,
    story_promise: input.storyPromise,
    hook_angle: input.hookAngle,
    closing_intent: input.closingIntent,
    resolved_profile_candidate: resolution.resolvedProfile,
    resolved_policy_candidate: resolution.resolvedPolicy,
    beat_strategy: {
      beat_count: input.beatCount,
      role_sequence: roleSequence,
      chronology_bias: resolution.policyDefinition?.chronology_bias,
      target_duration_window: resolution.profileDefaults?.target_duration_sec
        ? {
            min_sec: resolution.profileDefaults.target_duration_sec * 0.8,
            max_sec: resolution.profileDefaults.target_duration_sec * 1.2,
          }
        : undefined,
    },
    quality_targets: resolution.profileDefaults?.quality_target_overrides,
  };

  return { frame, resolution };
}

function buildDefaultRoleSequence(
  count: number,
): Array<"hook" | "setup" | "experience" | "closing"> {
  if (count <= 1) return ["hook"];
  if (count === 2) return ["hook", "closing"];
  if (count === 3) return ["hook", "experience", "closing"];

  // General pattern: hook, setup, experience..., closing
  const seq: Array<"hook" | "setup" | "experience" | "closing"> = ["hook", "setup"];
  for (let i = 2; i < count - 1; i++) {
    seq.push("experience");
  }
  seq.push("closing");
  return seq;
}
