// Blueprint agreement — structural similarity between a candidate
// edit_blueprint.yaml and the golden's beat design, pacing, and music.

import type { Beat, EditBlueprint } from "../artifacts/types.js";
import { clamp01, longestCommonSubsequenceLength } from "./matching.js";
import type { BlueprintAgreementReport } from "./types.js";

function durationShares(beats: Beat[]): number[] {
  const total = beats.reduce((s, b) => s + b.target_duration_frames, 0);
  if (total <= 0) return beats.map(() => 0);
  return beats.map((b) => b.target_duration_frames / total);
}

export function evaluateBlueprintAgreement(
  golden: EditBlueprint,
  candidate: EditBlueprint,
): BlueprintAgreementReport {
  const gBeats = golden.beats;
  const cBeats = candidate.beats;

  const beatCountScore =
    Math.max(gBeats.length, cBeats.length) > 0
      ? 1 -
        Math.abs(gBeats.length - cBeats.length) /
          Math.max(gBeats.length, cBeats.length)
      : 1;

  // Story-role sequence (hook/setup/experience/closing) via LCS.
  let storyRoleAgreement: number | null = null;
  const gRoles: string[] = gBeats.flatMap((b) => (b.story_role ? [b.story_role] : []));
  const cRoles: string[] = cBeats.flatMap((b) => (b.story_role ? [b.story_role] : []));
  if (gRoles.length > 0 && cRoles.length > 0) {
    storyRoleAgreement =
      longestCommonSubsequenceLength(gRoles, cRoles) /
      Math.max(gRoles.length, cRoles.length);
  }

  // Duration-share deviation over order-aligned beats.
  const gShares = durationShares(gBeats);
  const cShares = durationShares(cBeats);
  const alignedCount = Math.min(gShares.length, cShares.length);
  let durationShareScore = 1;
  if (alignedCount > 0) {
    let dev = 0;
    for (let i = 0; i < alignedCount; i += 1) {
      dev += Math.abs(gShares[i] - cShares[i]);
    }
    // A 25% mean share drift zeroes this component.
    durationShareScore = clamp01(1 - dev / alignedCount / 0.25);
  }

  // Pacing cadences.
  const cadenceFields: Array<keyof EditBlueprint["pacing"]> = [
    "opening_cadence",
    "middle_cadence",
    "ending_cadence",
  ];
  const pacingMatches = cadenceFields.filter(
    (f) => golden.pacing[f] === candidate.pacing[f],
  ).length;
  const pacingAgreement = pacingMatches / cadenceFields.length;

  // Music policy: where the music enters and whether it starts sparse.
  const entryMatch = golden.music_policy.entry_beat === candidate.music_policy.entry_beat ? 1 : 0;
  const sparseMatch =
    golden.music_policy.start_sparse === candidate.music_policy.start_sparse ? 1 : 0;
  const musicAgreement = (entryMatch + sparseMatch) / 2;

  const parts: Array<{ value: number; weight: number }> = [
    { value: beatCountScore, weight: 0.2 },
    { value: durationShareScore, weight: 0.25 },
    { value: pacingAgreement, weight: 0.2 },
    { value: musicAgreement, weight: 0.1 },
  ];
  if (storyRoleAgreement !== null) parts.push({ value: storyRoleAgreement, weight: 0.25 });
  const totalWeight = parts.reduce((s, p) => s + p.weight, 0);
  const score = clamp01(parts.reduce((s, p) => s + p.value * p.weight, 0) / totalWeight);

  return {
    golden_beat_count: gBeats.length,
    candidate_beat_count: cBeats.length,
    beat_count_score: beatCountScore,
    story_role_agreement: storyRoleAgreement,
    duration_share_score: durationShareScore,
    pacing_agreement: pacingAgreement,
    music_agreement: musicAgreement,
    score,
  };
}
