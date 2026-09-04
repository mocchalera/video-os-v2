import { describe, expect, it } from "vitest";
import type { EditBlueprint } from "../runtime/compiler/types.js";
import {
  applyShortFormRetentionDefaults,
  auditShortFormRetention,
  deriveShortFormRetentionProfile,
  shortFormRetentionPromptLines,
} from "../runtime/editorial/short-form-retention.js";
import { buildLlmBlueprintPrompt } from "../runtime/agents/llm-blueprint-agent.js";
import { normalize } from "../runtime/compiler/normalize.js";

function socialBrief(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: "1",
    project_id: "short-social",
    project: {
      id: "short-social",
      title: "AIに本気を出させた",
      strategy: "payoff-led social comedy",
      format: "social",
      runtime_target_sec: 75,
      duration_mode: "strict",
    },
    message: { primary: "AIを追い込んだ結果を見せる" },
    emotion_curve: ["驚き", "無茶振り", "完成"],
    order_policy: "editorial",
    must_have: ["0〜2秒のコールドオープンで完成形を先出しする"],
    editorial: {
      distribution_channel: "social_feed",
      aspect_ratio: "9:16",
      hook_priority: "aggressive",
      credibility_bias: "medium",
      profile_hint: "social-comedy-dialogue",
    },
    ...overrides,
  };
}

function blueprint(beats: EditBlueprint["beats"], extra: Partial<EditBlueprint> = {}): EditBlueprint {
  return {
    version: "1",
    project_id: "short-social",
    sequence_goals: ["会話を構造化する"],
    beats,
    pacing: {
      opening_cadence: "brisk",
      middle_cadence: "varied",
      ending_cadence: "resolved",
    },
    music_policy: {
      start_sparse: true,
      allow_release_late: false,
      entry_beat: beats[0]?.id ?? "b01",
    },
    dialogue_policy: {
      preserve_natural_breath: true,
      avoid_wall_to_wall_voiceover: true,
    },
    transition_policy: { prefer_match_texture_over_flashy_fx: true },
    ending_policy: { should_feel: "resolved" },
    rejection_rules: ["素材にない結果を作らない"],
    story_arc: {
      summary: "先に結果を見せてから経緯をたどる",
      strategy: "peak_first",
      allow_time_reorder: true,
    },
    ...extra,
  };
}

const selects = {
  editorial_summary: {
    dominant_visual_mode: "talking_head",
    motion_profile: "low",
  },
  candidates: [
    { candidate_id: "cand_setup", segment_id: "seg_setup", story_role: "setup" },
    { candidate_id: "cand_payoff", segment_id: "seg_payoff", story_role: "payoff" },
  ],
};

describe("short-form retention planning", () => {
  it("activates aggressive retention only from explicit short-social delivery fields", () => {
    expect(deriveShortFormRetentionProfile(socialBrief())).toMatchObject({
      enabled: true,
      mode: "aggressive",
      cold_open_max_frames: 48,
      full_payoff_latest_ratio: 0.65,
    });

    expect(deriveShortFormRetentionProfile({
      project: { runtime_target_sec: 600, format: "event" },
      editorial: { distribution_channel: "presentation", aspect_ratio: "16:9", profile_hint: "longform-event" },
    })).toMatchObject({ enabled: false, mode: "off" });
  });

  it("keeps credibility-first social edits out of forced spoiler/cold-open behavior", () => {
    const brief = socialBrief({
      must_have: [],
      editorial: {
        distribution_channel: "social_feed",
        aspect_ratio: "9:16",
        hook_priority: "credibility_first",
        credibility_bias: "high",
        profile_hint: "lp-testimonial",
      },
    });
    const profile = deriveShortFormRetentionProfile(brief);
    expect(profile).toMatchObject({
      enabled: true,
      mode: "credibility_first",
      cold_open_max_frames: null,
      full_payoff_latest_ratio: null,
    });
    expect(shortFormRetentionPromptLines(brief).join("\n")).toContain("Do not force a spoiler montage");
  });

  it("detects the feedback failure pattern without applying it to non-social work", () => {
    const poor = blueprint([
      {
        id: "b01_hook",
        label: "HOOK",
        target_duration_frames: 120,
        required_roles: ["hero"],
        story_role: "hook",
        candidate_plan: { primary_candidate_ref: "cand_setup" },
      },
      {
        id: "b02_level",
        label: "LEVEL 1",
        target_duration_frames: 600,
        required_roles: ["support"],
        candidate_plan: { primary_candidate_ref: "cand_setup" },
      },
      {
        id: "b03_level",
        label: "LEVEL 2",
        target_duration_frames: 600,
        required_roles: ["support"],
        candidate_plan: { primary_candidate_ref: "cand_setup" },
      },
      {
        id: "b04_payoff",
        label: "PAYOFF",
        target_duration_frames: 480,
        required_roles: ["hero"],
        candidate_plan: { primary_candidate_ref: "cand_payoff" },
      },
    ], {
      story_arc: { summary: "chronological", strategy: "chronological", allow_time_reorder: false },
    });

    expect(auditShortFormRetention(socialBrief(), poor, selects).map((issue) => issue.code)).toEqual([
      "cold_open_too_long",
      "peak_first_missing",
      "payoff_too_late",
      "system_label_exposed",
      "visual_refresh_plan_missing",
    ]);

    const longformBrief = {
      project: { runtime_target_sec: 600, format: "event" },
      editorial: { distribution_channel: "presentation", profile_hint: "longform-event" },
    };
    expect(auditShortFormRetention(longformBrief, poor, selects)).toEqual([]);
  });

  it("accepts a cold open, early full payoff, audience copy, and semantic visual plan", () => {
    const strong = blueprint([
      {
        id: "b01_hook",
        label: "hook",
        viewer_label: "AIの本気を先にどうぞ",
        target_duration_frames: 48,
        required_roles: ["hero"],
        story_role: "hook",
        candidate_plan: { primary_candidate_ref: "cand_setup" },
      },
      {
        id: "b02_setup",
        label: "setup",
        viewer_label: "無茶振り開始",
        target_duration_frames: 552,
        required_roles: ["support"],
        candidate_plan: { primary_candidate_ref: "cand_setup" },
      },
      {
        id: "b03_payoff",
        label: "payoff",
        viewer_label: "ついに本気",
        target_duration_frames: 720,
        required_roles: ["hero"],
        candidate_plan: { primary_candidate_ref: "cand_payoff" },
      },
      {
        id: "b04_closing",
        label: "closing",
        viewer_label: "まさかの番組開始",
        target_duration_frames: 480,
        required_roles: ["texture"],
        story_role: "closing",
        candidate_plan: { primary_candidate_ref: "cand_setup" },
      },
    ], {
      active_editing_skills: ["build_to_peak", "punch_in_emphasis", "shot_reverse_reaction"],
    });

    expect(auditShortFormRetention(socialBrief(), strong, selects)).toEqual([]);
    const normalized = normalize(socialBrief() as never, strong);
    expect(normalized.beats[0]).toMatchObject({
      label: "hook",
      viewer_label: "AIの本気を先にどうぞ",
    });
  });

  it("repairs deterministic short-social fallbacks while preserving total duration", () => {
    const fallback = blueprint([
      { id: "b01_hook", label: "hook", target_duration_frames: 450, required_roles: ["hero"], story_role: "hook" },
      { id: "b02_setup", label: "setup", target_duration_frames: 450, required_roles: ["support"] },
      { id: "b03_payoff", label: "payoff", target_duration_frames: 450, required_roles: ["hero"] },
      { id: "b04_closing", label: "closing", target_duration_frames: 450, required_roles: ["texture"], story_role: "closing" },
    ], {
      story_arc: { summary: "fallback", strategy: "chronological", allow_time_reorder: false },
    });
    const repaired = applyShortFormRetentionDefaults(socialBrief(), fallback, selects);

    expect(repaired).not.toBe(fallback);
    expect(repaired.beats.reduce((sum, beat) => sum + beat.target_duration_frames, 0)).toBe(1800);
    expect(repaired.beats[0]).toMatchObject({
      viewer_label: "先に結果をどうぞ",
      target_duration_frames: 48,
      candidate_plan: { primary_candidate_ref: "cand_payoff" },
    });
    expect(repaired.story_arc).toMatchObject({ strategy: "peak_first", allow_time_reorder: true });
    expect(repaired.active_editing_skills).toEqual(expect.arrayContaining([
      "build_to_peak",
      "reveal_then_payoff",
      "punch_in_emphasis",
      "shot_reverse_reaction",
    ]));
    expect(auditShortFormRetention(socialBrief(), repaired, selects)).toEqual([]);

    const nonSocial = { project: { runtime_target_sec: 600 }, editorial: { distribution_channel: "presentation" } };
    expect(applyShortFormRetentionDefaults(nonSocial, fallback, selects)).toBe(fallback);
  });

  it("injects the retention contract into the blueprint prompt only when eligible", () => {
    const prompt = buildLlmBlueprintPrompt({
      projectId: "short-social",
      autonomyMode: "full",
      briefContent: socialBrief(),
      blockersContent: { blockers: [] },
      selectsContent: selects,
      styleContent: null,
    });
    expect(prompt).toContain("## Short-social retention contract");
    expect(prompt).toContain("registered payoff window");
    expect(prompt).not.toContain("6-12 seconds");
    expect(prompt).toContain("beat.viewer_label");
    expect(prompt).toContain("caption_policy.semantic_timing");
    expect(prompt).toContain("protected reveal");

    const nonSocialPrompt = buildLlmBlueprintPrompt({
      projectId: "event",
      autonomyMode: "full",
      briefContent: {
        project: { runtime_target_sec: 600, format: "event" },
        editorial: { distribution_channel: "presentation", profile_hint: "longform-event" },
      },
      blockersContent: { blockers: [] },
      selectsContent: selects,
      styleContent: null,
    });
    expect(nonSocialPrompt).not.toContain("## Short-social retention contract");
  });
});
