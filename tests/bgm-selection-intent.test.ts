import { describe, expect, it } from "vitest";

import { normalizeBgmSelectionIntent } from "../runtime/music/selection-intent.js";

describe("BGM selection intent normalization", () => {
  it("normalizes a dialogue-led AX-1 case study into ranked editorial intent", () => {
    const result = normalizeBgmSelectionIntent({
      creativeBrief: {
        project: {
          title: "AX-1 事例インタビュー",
          strategy: "受講前からAI実践、会社全体への変化を伝える",
          runtime_target_sec: 90,
        },
        message: { primary: "経営者本人の実践が会社のAI導入を前進させる" },
        audience: { primary: "経営者" },
        emotion_curve: ["以前の課題", "実践", "成果と未来"],
        must_have: ["秘書・経理への展開"],
        must_avoid: ["過度に煽る音楽"],
        audio_policy: "ducking",
        editorial: { distribution_channel: "web_lp", embed_context: "lp_embed" },
      },
      editBlueprint: {
        sequence_goals: ["事例を信頼できる流れで説明する"],
        beats: [
          { label: "Before", required_roles: ["dialogue"] },
          { label: "After", required_roles: ["dialogue"] },
        ],
        pacing: { opening_cadence: "restrained", middle_cadence: "steady", ending_cadence: "release" },
        music_policy: { start_sparse: true, allow_release_late: true, permitted_energy_curve: "build and release" },
        ending_policy: { should_feel: "resolved with余韻", final_audio_strategy: "fade" },
        rejection_rules: ["ボーカル曲を避ける"],
      },
      timeline: {
        duration_us: 92_000_000,
        speech_duration_us: 78_200_000,
        cut_count: 18,
      },
      outputMode: "external",
      commercial: true,
    });

    expect(result.intent.families).toEqual([
      "progress_uplift",
      "trust_clarity",
      "future_technology",
    ]);
    expect(result.intent.use_cases).toEqual(["case_study", "company_story", "explainer", "interview", "lp_hero", "technology"]);
    expect(result.intent.duration_us).toBe(92_000_000);
    expect(result.intent.speech_ratio).toBe(0.85);
    expect(result.intent.speech_density).toBe("dense");
    expect(result.intent.minimum_speech_friendliness).toBe(0.8825);
    expect(result.intent.target_bpm).toBeGreaterThanOrEqual(104);
    expect(result.intent.vocal_presence_allowed).toEqual(["none"]);
    expect(result.intent.required_rights_scopes).toEqual(["commercial", "external", "modification"]);
    expect(result.intent.explicit_exclusions).toEqual(["ボーカル曲を避ける", "過度に煽る音楽"]);
  });

  it("uses timeline facts ahead of planning duration and derives cut density", () => {
    const result = normalizeBgmSelectionIntent({
      creativeBrief: { project: { runtime_target_sec: 120 } },
      editBlueprint: {
        music_policy: { bgm_duration_sec: 110 },
        duration_policy: { target_duration_sec: 100 },
      },
      timeline: { duration_sec: 80, speech_ratio: 0.5, cut_count: 20 },
    });

    expect(result.intent.duration_us).toBe(80_000_000);
    expect(result.intent.cut_density_per_minute).toBe(15);
    expect(result.intent.speech_ratio).toBe(0.5);
  });

  it("normalizes and clamps an explicit timeline energy curve", () => {
    const result = normalizeBgmSelectionIntent({
      timeline: {
        duration_us: 30_000_000,
        speech_ratio: 1.4,
        target_energy: -0.2,
        target_bpm: 300,
        energy_curve: [
          { position: 1.2, value: 1.4 },
          { position: -0.2, energy: -0.3 },
          { position: 0.5, value: 0.7 },
        ],
      },
    });

    expect(result.intent.speech_ratio).toBe(1);
    expect(result.intent.target_energy).toBe(0);
    expect(result.intent.target_bpm).toBe(240);
    expect(result.intent.energy_curve).toEqual([
      { position: 0, value: 0 },
      { position: 0.5, value: 0.7 },
      { position: 1, value: 1 },
    ]);
    expect(result.intent.intensities).toEqual(["low", "high"]);
    expect(result.diagnostics.map((item) => item.code)).toContain("BGM_INTENT_INVALID_SPEECH_RATIO");
    expect(result.diagnostics.map((item) => item.code)).toContain("BGM_INTENT_INVALID_ENERGY");
    expect(result.diagnostics.map((item) => item.code)).toContain("BGM_INTENT_INVALID_BPM");
  });

  it("is fail-open and deterministic for absent artifacts", () => {
    const first = normalizeBgmSelectionIntent({});
    const second = normalizeBgmSelectionIntent({});

    expect(second).toEqual(first);
    expect(first.intent).toMatchObject({
      families: ["trust_clarity"],
      use_cases: ["general_editorial"],
      duration_us: 60_000_000,
      speech_ratio: 0.35,
      output_mode: "external",
      require_licensed_rights: true,
      require_verified_hash: true,
    });
    expect(first.diagnostics.map((item) => item.code)).toEqual([
      "BGM_INTENT_FAMILY_DEFAULT",
      "BGM_INTENT_USE_CASE_DEFAULT",
      "BGM_INTENT_DURATION_DEFAULT",
      "BGM_INTENT_SPEECH_RATIO_DEFAULT",
      "BGM_INTENT_ENERGY_DEFAULT",
      "BGM_INTENT_OUTPUT_MODE_DEFAULT",
    ]);
  });

  it("ignores malformed artifacts without throwing", () => {
    const result = normalizeBgmSelectionIntent({
      creativeBrief: "bad",
      editBlueprint: 42,
      timeline: [],
      outputMode: "send_everywhere",
    });

    expect(result.intent.duration_us).toBe(60_000_000);
    expect(result.intent.output_mode).toBe("external");
    expect(result.diagnostics.map((item) => item.code)).toEqual(expect.arrayContaining([
      "BGM_INTENT_INVALID_BRIEF",
      "BGM_INTENT_INVALID_BLUEPRINT",
      "BGM_INTENT_INVALID_TIMELINE",
      "BGM_INTENT_INVALID_OUTPUT_MODE",
    ]));
  });

  it("turns original-only audio policy into an explicit no-selection intent", () => {
    const result = normalizeBgmSelectionIntent({
      creativeBrief: { audio_policy: "original_only" },
      outputMode: "preview_internal",
    });

    expect(result.intent.bgm_enabled).toBe(false);
    expect(result.intent.require_licensed_rights).toBe(false);
    expect(result.intent.required_rights_scopes).toEqual(["modification", "preview_internal"]);
    expect(result.diagnostics.map((item) => item.code)).toContain("BGM_INTENT_BGM_DISABLED");
  });

  it("keeps public redistribution rights stricter and stable", () => {
    const result = normalizeBgmSelectionIntent({
      creativeBrief: { editorial: { distribution_channel: "social_feed" } },
      outputMode: "public",
    });

    expect(result.intent.output_mode).toBe("public_redistribution");
    expect(result.intent.required_rights_scopes).toEqual(["modification", "public_redistribution"]);
    expect(result.intent.require_licensed_rights).toBe(true);
    expect(result.intent.require_resolved_ending).toBe(true);
  });

  it("sorts free-text exclusions but preserves authored emotion order in semantic text", () => {
    const result = normalizeBgmSelectionIntent({
      creativeBrief: {
        emotion_curve: ["静かなBefore", "未来への変化", "成果"],
        must_avoid: ["z", "a", "z"],
        forbidden_interpretations: ["m"],
      },
      editBlueprint: { rejection_rules: ["b"] },
    });

    expect(result.intent.explicit_exclusions).toEqual(["a", "b", "m", "z"]);
    expect(result.intent.semantic_text).toContain("静かなBefore | 未来への変化 | 成果");
  });

  it("does not mutate canonical input objects", () => {
    const creativeBrief = Object.freeze({
      project: Object.freeze({ title: "Customer documentary", runtime_target_sec: 75 }),
      must_avoid: Object.freeze(["lead vocals"]),
    });
    const editBlueprint = Object.freeze({
      music_policy: Object.freeze({ start_sparse: false, allow_release_late: false }),
    });

    expect(() => normalizeBgmSelectionIntent({ creativeBrief, editBlueprint })).not.toThrow();
    expect(creativeBrief.must_avoid).toEqual(["lead vocals"]);
  });
});
