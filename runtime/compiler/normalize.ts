// Phase 1: Blueprint Normalization
// Reads creative_brief and edit_blueprint, produces a normalized beat sheet
// with role quotas.

import type {
  CreativeBrief,
  DurationPolicy,
  EditBlueprint,
  NormalizedBeat,
  NormalizedData,
  Role,
  RoleQuotas,
} from "./types.js";

const ALL_ROLES: Role[] = ["hero", "support", "transition", "texture", "dialogue"];

export function normalize(
  brief: CreativeBrief,
  blueprint: EditBlueprint,
): NormalizedData {
  const beats: NormalizedBeat[] = blueprint.beats.map((b) => ({
    beat_id: b.id,
    label: b.label,
    viewer_label: b.viewer_label,
    target_duration_frames: b.target_duration_frames,
    required_roles: [...b.required_roles],
    preferred_roles: b.preferred_roles ? [...b.preferred_roles] : [],
    purpose: b.purpose ?? "",
    story_role: b.story_role,
    craft: b.craft ? { ...b.craft } : undefined,
    skill_hints: b.skill_hints ? [...b.skill_hints] : undefined,
    candidate_plan: b.candidate_plan
      ? {
          primary_candidate_ref: b.candidate_plan.primary_candidate_ref,
          fallback_candidate_refs: b.candidate_plan.fallback_candidate_refs
            ? [...b.candidate_plan.fallback_candidate_refs]
            : undefined,
        }
      : undefined,
    allow_revisit: typeof b.allow_revisit === "object" && b.allow_revisit !== null
      ? {
          semantic_cluster_ids: b.allow_revisit.semantic_cluster_ids
            ? [...b.allow_revisit.semantic_cluster_ids]
            : undefined,
          asset_ids: b.allow_revisit.asset_ids ? [...b.allow_revisit.asset_ids] : undefined,
          reason: b.allow_revisit.reason,
        }
      : b.allow_revisit,
  }));

  const roleQuotas = computeRoleQuotas(beats);

  const totalDurationFrames = beats.reduce(
    (sum, b) => sum + b.target_duration_frames,
    0,
  );

  return {
    project_id: brief.project.id,
    project_title: brief.project.title,
    beats,
    role_quotas: roleQuotas,
    total_duration_frames: totalDurationFrames,
    duration_policy: blueprint.duration_policy,
  };
}

function computeRoleQuotas(beats: NormalizedBeat[]): RoleQuotas {
  const quotas: RoleQuotas = {
    hero: 0,
    support: 0,
    transition: 0,
    texture: 0,
    dialogue: 0,
  };

  for (const beat of beats) {
    for (const role of ALL_ROLES) {
      if (beat.required_roles.includes(role)) {
        quotas[role]++;
      } else if (beat.preferred_roles.includes(role)) {
        quotas[role]++;
      }
    }
  }

  return quotas;
}
