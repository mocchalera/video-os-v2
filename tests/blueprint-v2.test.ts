import { describe, expect, it } from "vitest";
import { sanitizeBlueprint, BlueprintSanitizationError } from "../runtime/blueprint/sanitizer.js";
import { validateAgainstSchema } from "../runtime/commands/shared.js";

const hash = `sha256:${"a".repeat(64)}`;

function baseBlueprint(): Record<string, unknown> {
  return {
    version: "2",
    project_id: "anonymous-fixture",
    sequence_goals: ["source grounded"],
    beats: [{ id: "B1", label: "Hook", target_duration_frames: 30, required_roles: ["dialogue"] }],
    pacing: { opening_cadence: "medium", middle_cadence: "varied", ending_cadence: "resolved" },
    music_policy: { start_sparse: true, allow_release_late: true, entry_beat: "B1" },
    dialogue_policy: { preserve_natural_breath: true, avoid_wall_to_wall_voiceover: true },
    transition_policy: { prefer_match_texture_over_flashy_fx: true },
    ending_policy: { should_feel: "resolved" },
    rejection_rules: ["unsupported"],
    policy_refs: { caption_policy_ref: { ref: "caption/default", version: "1", profile_hash: hash } },
    hook_sequence: {
      sequence_id: "HOOK",
      shots: [{ shot_id: "SHOT_1", beat_id: "B1", shot_anchor: {
        anchor_id: "ANCHOR_1", asset_id: "asset-anon", source_content_hash: hash,
        segment_id: "seg-anon", src_in_us: 0, src_out_us: 1_000_000,
      } }],
    },
    body_sequence: { sequence_id: "BODY", shots: [{ shot_id: "SHOT_2", candidate_ref: "candidate-anon" }] },
  };
}

describe("Blueprint v2 schema and sanitizer", () => {
  it("validates anonymous Hook/Body/Shot Anchor references and preserves hashes", () => {
    const blueprint = baseBlueprint();
    expect(validateAgainstSchema(blueprint, "edit-blueprint.schema.json")).toEqual({ valid: true, errors: [] });
    const result = sanitizeBlueprint(blueprint);
    expect(result.blueprint.hook_sequence?.shots[0].shot_anchor?.source_content_hash).toBe(hash);
    expect(result.blueprint.policy_refs?.caption_policy_ref?.profile_hash).toBe(hash);
  });

  it("keeps v1 untouched and rejects unknown v2 fields/values explicitly", () => {
    const v1 = { version: "1", project_id: "legacy" };
    expect(sanitizeBlueprint(v1).blueprint).toEqual(v1);
    const invalid = baseBlueprint();
    (invalid.hook_sequence as Record<string, unknown>).unexpected = true;
    expect(() => sanitizeBlueprint(invalid)).toThrow(BlueprintSanitizationError);
    const badAnchor = baseBlueprint();
    (((badAnchor.hook_sequence as Record<string, unknown>).shots as unknown[])[0] as Record<string, unknown>).shot_anchor = {
      ...( (((badAnchor.hook_sequence as Record<string, unknown>).shots as unknown[])[0] as Record<string, any>).shot_anchor as Record<string, unknown>),
      source_content_hash: "unknown",
    };
    expect(() => sanitizeBlueprint(badAnchor)).toThrow(/source_content_hash/);
  });
});
