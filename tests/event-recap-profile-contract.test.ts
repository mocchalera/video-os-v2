import { describe, expect, it } from "vitest";
import type { CreativeBrief, EditBlueprint } from "../runtime/compiler/types.js";
import {
  buildDurationPolicy,
  resolveTimelineOrder,
} from "../runtime/compiler/duration-helpers.js";
import {
  clearRegistryCache,
  resolveProfileAndPolicy,
} from "../runtime/editorial/policy-resolver.js";
import { loadSkills } from "../runtime/editorial/skill-registry.js";
import { CANONICAL_PIPELINE_STAGES } from "../runtime/pipeline/plan.js";

const PROFILES_DIR = "runtime/editorial/profiles";
const POLICIES_DIR = "runtime/editorial/policies";

describe("event-recap shared-pipeline profile contract", () => {
  it("changes editorial defaults without introducing a second pipeline", () => {
    clearRegistryCache();
    const interview = resolveProfileAndPolicy(
      { briefEditorial: { profile_hint: "interview-highlight", allow_inference: false } },
      PROFILES_DIR,
      POLICIES_DIR,
    );
    const eventRecap = resolveProfileAndPolicy(
      { briefEditorial: { profile_hint: "event-recap", allow_inference: false } },
      PROFILES_DIR,
      POLICIES_DIR,
    );

    expect(interview.resolvedPolicy.id).toBe("interview");
    expect(eventRecap.resolvedPolicy.id).toBe("highlight");
    expect(eventRecap.resolvedProfile.source).toBe("explicit_hint");

    const interviewDefaults = interview.profileDefaults!;
    const eventDefaults = eventRecap.profileDefaults!;
    expect(eventDefaults.max_shot_length_frames).toBeLessThan(
      interviewDefaults.max_shot_length_frames!,
    );
    expect(eventDefaults.trim_policy_overrides?.default_preferred_duration_frames).toBeLessThan(
      interviewDefaults.trim_policy_overrides?.default_preferred_duration_frames!,
    );
    expect(eventDefaults.quality_target_overrides?.novelty_rate_min).toBeGreaterThan(
      interviewDefaults.quality_target_overrides?.novelty_rate_min!,
    );
    expect(eventDefaults.quality_target_overrides?.hook_density_min).toBeGreaterThan(
      interviewDefaults.quality_target_overrides?.hook_density_min!,
    );
    expect(eventDefaults.default_transition).toBe("crossfade");
    expect(eventDefaults.active_editing_skills).toEqual(expect.arrayContaining([
      "build_to_peak",
      "smash_cut_energy",
      "match_cut_bridge",
      "cooldown_resolve",
      "b_roll_bridge",
    ]));
    expect(eventDefaults.active_editing_skills).not.toEqual(expect.arrayContaining([
      "axis_hold_dialogue",
      "shot_reverse_reaction",
      "silence_beat",
    ]));

    expect(CANONICAL_PIPELINE_STAGES).toEqual([
      "ingest",
      "analyze",
      "stt",
      "marlin",
      "visualQuality",
      "peak",
      "embeddings",
      "footageDb",
      "triage",
      "blueprint",
      "compile",
      "review",
      "render",
      "qa",
      "package",
    ]);
  });

  it("uses registered skills, guide duration, and chronological assembly", () => {
    const eventRecap = resolveProfileAndPolicy(
      { briefEditorial: { profile_hint: "event-recap", allow_inference: false } },
      PROFILES_DIR,
      POLICIES_DIR,
    );
    const skillRegistry = loadSkills();
    for (const skillId of eventRecap.profileDefaults?.active_editing_skills ?? []) {
      expect(skillRegistry.has(skillId), `${skillId} must be a shared registered skill`).toBe(true);
    }

    const brief = {
      version: "1",
      project_id: "event-recap-contract",
      project: {
        id: "event-recap-contract",
        title: "Event recap contract",
        strategy: "chronological event recap",
        runtime_target_sec: 60,
      },
      message: { primary: "Show the event arc through visual moments" },
      emotion_curve: ["arrival", "energy", "resolve"],
      editorial: {
        profile_hint: "event-recap",
        policy_hint: "highlight",
        allow_inference: false,
      },
    } satisfies CreativeBrief;

    expect(buildDurationPolicy(brief, "event-recap", 180)).toMatchObject({
      mode: "guide",
      source: "profile_default",
      target_duration_sec: 60,
    });
    expect(resolveTimelineOrder({} as EditBlueprint, "event-recap", brief)).toBe("chronological");
    expect(resolveTimelineOrder({} as EditBlueprint, "interview-highlight", brief)).toBe("editorial");
  });
});
