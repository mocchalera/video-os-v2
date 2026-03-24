import type {
  EditBlueprint,
  NormalizedBeat,
} from "../../artifacts/types.js";

export function buildDefaultStubBlueprint(
  projectId: string,
  beats: NormalizedBeat[],
): EditBlueprint {
  return {
    version: "1",
    project_id: projectId,
    sequence_goals: [],
    beats: [],
    pacing: {
      opening_cadence: "medium",
      middle_cadence: "varied",
      ending_cadence: "slow-fade",
    },
    music_policy: {
      start_sparse: true,
      allow_release_late: true,
      entry_beat: beats[0]?.beat_id ?? "B1",
      avoid_anthemic_lift: false,
      permitted_energy_curve: "default",
    },
    dialogue_policy: {
      preserve_natural_breath: true,
      avoid_wall_to_wall_voiceover: true,
    },
  };
}
