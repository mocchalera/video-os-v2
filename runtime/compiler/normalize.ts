// Phase 1: Blueprint Normalization
// Reads creative_brief and edit_blueprint, produces a normalized beat sheet
// with role quotas.

import type {
  CreativeBrief,
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
    target_duration_frames: b.target_duration_frames,
    required_roles: [...b.required_roles],
    preferred_roles: b.preferred_roles ? [...b.preferred_roles] : [],
    purpose: b.purpose ?? "",
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
