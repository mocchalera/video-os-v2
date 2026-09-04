import { createRequire } from "node:module";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
  applySourceMediaContract,
  buildCandidateIndex,
  buildLlmBlueprintPrompt,
  createLlmBlueprintAgent,
} from "../runtime/agents/llm-blueprint-agent.js";
import type { EditBlueprint } from "../runtime/artifacts/types.js";
import type { LlmCompleter } from "../runtime/agents/llm-triage-agent.js";
import type { BlueprintAgentContext } from "../runtime/commands/blueprint.js";

const require = createRequire(import.meta.url);
const Ajv2020 = require("ajv/dist/2020") as new (opts: Record<string, unknown>) => {
  compile(schema: object): { (data: unknown): boolean; errors?: Array<{ instancePath: string; message?: string }> | null };
};
const addFormats = require("ajv-formats") as (ajv: unknown) => void;

function createValidator(schemaFile: string) {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  const schema = JSON.parse(fs.readFileSync(path.resolve("schemas", schemaFile), "utf-8")) as object;
  return ajv.compile(schema);
}

function briefContent(): Record<string, unknown> {
  return {
    version: "1",
    project_id: "test-project",
    project: {
      id: "test-project",
      title: "LLM blueprint fixture",
      strategy: "message-first",
      runtime_target_sec: 30,
      duration_mode: "guide",
    },
    message: {
      primary: "Show the first ride without over-explaining it.",
      secondary: ["warm family reaction"],
    },
    emotion_curve: ["recognition", "attempt", "payoff"],
    must_have: ["first ride", "family reaction"],
    order_policy: "editorial",
    caption_policy: "auto",
    editorial: {
      profile_hint: "family-growth-recap",
      policy_hint: "warm-recap",
    },
  };
}

function selectsContent(): Record<string, unknown> {
  return {
    version: "1",
    project_id: "test-project",
    selection_notes: ["approved candidate board"],
    editorial_summary: {
      dominant_visual_mode: "event_broll",
      speaker_topology: "unknown",
      motion_profile: "medium",
      transcript_density: "sparse",
    },
    candidates: [
      {
        candidate_id: "cand_hook",
        segment_id: "SEG_001",
        asset_id: "AST_001",
        src_in_us: 1000,
        src_out_us: 5000,
        role: "hero",
        why_it_matches: "Child starts riding with visible effort.",
        risks: [],
        confidence: 0.91,
        semantic_rank: 1,
        eligible_beats: ["b01"],
        evidence: ["first ride"],
        transcript_excerpt: "Look, I can ride.",
        motif_tags: ["bike", "attempt"],
      },
      {
        candidate_id: "cand_close",
        segment_id: "SEG_002",
        asset_id: "AST_002",
        src_in_us: 6000,
        src_out_us: 12000,
        role: "support",
        why_it_matches: "Family reacts after the ride.",
        risks: [],
        confidence: 0.88,
        semantic_rank: 2,
        eligible_beats: ["b02"],
        evidence: ["family reaction"],
        transcript_excerpt: "That was the first ride.",
        motif_tags: ["reaction", "payoff"],
      },
    ],
  };
}

function context(overrides: Partial<BlueprintAgentContext> = {}): BlueprintAgentContext {
  return {
    projectDir: "/tmp/video-os-llm-blueprint-test",
    projectId: "test-project",
    currentState: "selects_ready",
    autonomyMode: "collaborative",
    briefContent: briefContent(),
    blockersContent: { version: "1", project_id: "test-project", blockers: [] },
    selectsContent: selectsContent(),
    styleContent: "Use warm, restrained pacing and avoid flashy transitions.",
    ...overrides,
  };
}

function validBlueprintResponse(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    version: "1",
    project_id: "wrong-project",
    extra_top_level: "must be dropped",
    sequence_goals: ["Open on effort.", "Resolve on family warmth."],
    beats: [
      {
        id: "b01",
        label: "hook",
        purpose: "Start with the first ride effort.",
        target_duration_frames: 120,
        required_roles: ["hero"],
        preferred_roles: ["support"],
        story_role: "hook",
        emotional_valence: -0.8,
        evidence_required: true,
        candidate_plan: {
          primary_candidate_ref: "cand_hook",
          fallback_candidate_refs: ["cand_close", "cand_missing"],
        },
        craft: {
          in_point: "cut_on_action",
          out_point: "peak_hold",
          transition_out: "hard_cut",
          rhythm: "accelerando",
          shot_progression: "wide_to_close",
          beat_sync: true,
          hold_duration_bias: 0.9,
          unknown_craft_field: "must be dropped",
        },
        extra_beat_field: "must be dropped",
      },
      {
        id: "b02",
        label: "payoff",
        purpose: "Close on the reaction.",
        target_duration_frames: 180,
        required_roles: ["support"],
        story_role: "closing",
        candidate_plan: {
          primary_candidate_ref: "cand_close",
          fallback_candidate_refs: [],
        },
      },
    ],
    pacing: {
      opening_cadence: "brisk",
      middle_cadence: "steady",
      ending_cadence: "warm",
      max_shot_length_frames: 120,
    },
    story_arc: {
      summary: "From effort to family recognition.",
      strategy: "chronological",
      chronology_bias: "source order",
      allow_time_reorder: false,
      causal_links: ["effort earns the reaction"],
    },
    music_policy: {
      start_sparse: true,
      allow_release_late: true,
      entry_beat: "b02",
      avoid_anthemic_lift: true,
      permitted_energy_curve: "restrained_to_warm",
    },
    caption_policy: {
      language: "ja",
      delivery_mode: "burn_in",
      source: "transcript",
      styling_class: "clean-lower-third",
    },
    dialogue_policy: {
      preserve_natural_breath: true,
      avoid_wall_to_wall_voiceover: true,
      prioritize_lines: ["That was the first ride."],
    },
    transition_policy: {
      prefer_match_texture_over_flashy_fx: true,
      allow_hard_cuts: true,
      avoid_speed_ramps: true,
    },
    ending_policy: {
      should_feel: "warm",
      final_line_strategy: "hold on the reaction",
      avoid_cta: true,
      final_hold_min_frames: 12,
    },
    rejection_rules: ["Reject off-brief filler."],
    duration_policy: {
      mode: "guide",
      source: "explicit_brief",
      target_source: "explicit_brief",
      target_duration_sec: 30,
      min_duration_sec: 20,
      max_duration_sec: 40,
      hard_gate: false,
      protect_vlm_peaks: true,
    },
    timeline_order: "editorial",
    track_layout: "single",
    ...overrides,
  });
}

function codexJsonl(text: string): string {
  return `${JSON.stringify({ type: "agent_message", message: text })}\n`;
}

describe("createLlmBlueprintAgent", () => {
  it("removes visual craft only when the mixed beat primary candidate is audio", () => {
    const selects = selectsContent();
    selects.source_media = { mode: "mixed", media_kinds: ["audio", "video"], visual_candidate_count: 1, audio_only_candidate_count: 1 };
    const candidates = selects.candidates as Array<Record<string, unknown>>;
    candidates[0].media_kind = "video";
    candidates[0].source_capabilities = { has_video: true, has_audio: true };
    candidates[1].media_kind = "audio";
    candidates[1].source_capabilities = { has_video: false, has_audio: true };
    const blueprint = {
      version: "1", project_id: "test-project", sequence_goals: ["test"],
      beats: [
        { id: "b01", label: "visual", target_duration_frames: 24, required_roles: ["hero"], candidate_plan: { primary_candidate_ref: "cand_hook", fallback_candidate_refs: ["cand_close"] }, craft: { in_point: "cut_on_action", transition_out: "dissolve", rhythm: "steady" } },
        { id: "b02", label: "audio", target_duration_frames: 24, required_roles: ["support"], candidate_plan: { primary_candidate_ref: "cand_close", fallback_candidate_refs: [] }, craft: { in_point: "cut_on_action", transition_out: "dissolve", rhythm: "breath" } },
      ],
      pacing: {}, music_policy: {}, caption_policy: {}, dialogue_policy: {}, transition_policy: {},
      ending_policy: { should_feel: "resolved", final_visual_strategy: "invented motion", video_fade_out_sec: 1, video_fade_color: "black" },
      rejection_rules: [], timeline_order: "editorial", track_layout: "single",
    } as unknown as EditBlueprint;
    applySourceMediaContract(blueprint, selects.source_media as never, buildCandidateIndex(selects));

    expect(blueprint.beats[0].craft).toMatchObject({ in_point: "cut_on_action", transition_out: "dissolve" });
    expect(blueprint.beats[1].craft).toEqual({ rhythm: "breath" });
    expect(blueprint.ending_policy).toMatchObject({ final_visual_strategy: "black canvas for audio-only render", video_fade_out_sec: 0, video_fade_color: "none" });
  });

  it("returns a schema-valid EditBlueprint from a mocked JSON response", async () => {
    let prompt = "";
    const agent = createLlmBlueprintAgent({
      llm: async (nextPrompt) => {
        prompt = nextPrompt;
        return validBlueprintResponse();
      },
    });

    const result = await agent.run(context());

    expect(result.confirmed).toBe(true);
    expect(result.uncertaintyRegister).toEqual({
      version: "1",
      project_id: "test-project",
      uncertainties: [],
    });
    expect(result.blueprint.version).toBe("1");
    expect(result.blueprint.project_id).toBe("test-project");
    expect(result.blueprint.beats).toHaveLength(2);
    expect(result.blueprint.beats[0].candidate_plan).toEqual({
      primary_candidate_ref: "cand_hook",
      fallback_candidate_refs: ["cand_close"],
    });
    expect(result.blueprint.beats[0].craft).toEqual({
      in_point: "cut_on_action",
      out_point: "peak_hold",
      transition_out: "hard_cut",
      rhythm: "accelerando",
      shot_progression: "wide_to_close",
      beat_sync: true,
      hold_duration_bias: 0.9,
    });
    expect(result.blueprint.beats[0].emotional_valence).toBe(-0.8);
    expect(result.blueprint.beats[0].evidence_required).toBe(true);
    expect((result.blueprint as Record<string, unknown>).extra_top_level).toBeUndefined();
    expect((result.blueprint.beats[0] as unknown as Record<string, unknown>).extra_beat_field).toBeUndefined();
    expect(prompt).toContain("Show the first ride without over-explaining it.");
    expect(prompt).toContain("cand_hook");
    expect(prompt).toContain("Use warm, restrained pacing");
    expect(prompt).toContain("For each beat, choose an in_point technique");
    expect(prompt).toContain("choose an out_point technique");
    expect(prompt).toContain('"out_point": "peak_hold"');
    expect(prompt).toContain('"transition_out": "dissolve"');
    expect(prompt).toContain("質問テロップに頼らず主語または指示対象");
    expect(prompt).toContain("ASR item の端は意味上の文境界とは限りません");
    expect(prompt).toContain("cut_tail_hold_sec は言い切った後の呼吸・ルームトーン専用");
    expect(prompt).toContain("推薦文だけを単独で切り出さないでください");
    expect(prompt).toContain("最低1.5秒の動く元素材");
    expect(prompt).toContain("speech caption の単一レイヤー");
    expect(result.blueprint.ending_policy).toMatchObject({
      final_hold_min_frames: 12,
      tail_hold_sec: 1.5,
      audio_fade_out_sec: 1,
      video_fade_out_sec: 1,
      video_fade_color: "black",
    });

    const validate = createValidator("edit-blueprint.schema.json");
    expect(validate(result.blueprint), JSON.stringify(validate.errors, null, 2)).toBe(true);
  });

  it("selects the registered proportional arc only for an explicit narrative_mode", () => {
    const personalBrief = { ...briefContent(), narrative_mode: "personal_challenge" };
    const dayLogBrief = { ...briefContent(), narrative_mode: "day_log" };
    const personalPrompt = buildLlmBlueprintPrompt({
      ...context(),
      briefContent: personalBrief,
    });
    const dayLogPrompt = buildLlmBlueprintPrompt({
      ...context(),
      briefContent: dayLogBrief,
    });
    const legacyPrompt = buildLlmBlueprintPrompt(context());

    expect(personalPrompt).toContain('"id": "personal-challenge-comeback"');
    expect(personalPrompt).toContain('"id": "crisis_cluster"');
    expect(personalPrompt).toContain('"ratio": 0.22');
    expect(dayLogPrompt).toContain('"id": "vlog-day-log"');
    expect(dayLogPrompt).toContain('"id": "setup_purpose"');
    expect(dayLogPrompt).toContain('"ratio": 0.3175');
    expect(legacyPrompt).not.toContain('"id": "personal-challenge-comeback"');
    expect(legacyPrompt).not.toContain('"id": "vlog-day-log"');
  });

  it("rejects an explicit creator arc combined with credibility-first planning", () => {
    const brief = briefContent();
    brief.narrative_mode = "day_log";
    brief.editorial = {
      ...(brief.editorial as Record<string, unknown>),
      hook_priority: "credibility_first",
    };

    expect(() => buildLlmBlueprintPrompt({ ...context(), briefContent: brief })).toThrow(
      /narrative_mode="day_log" conflicts with editorial\.hook_priority="credibility_first"/,
    );
  });

  it("records decision_runtime when using the default editorial connector", async () => {
    const agent = createLlmBlueprintAgent({
      editorialLlm: {
        runtime: "codex_exec",
        commandExists: (command) => command === "codex",
        executor: async () => ({
          stdout: codexJsonl(validBlueprintResponse()),
          stderr: "",
        }),
        env: {},
      },
    });

    const result = await agent.run(context());

    expect(result.blueprint.decision_runtime).toMatchObject({
      runtime: "codex_exec",
      role: "blueprint-llm",
    });
    expect(result.blueprint.decision_runtime?.attempted_runtimes?.[0]).toMatchObject({
      runtime: "codex_exec",
      status: "success",
    });
  });

  it("records deterministic fallback authorship on the public blueprint path", async () => {
    const result = await createLlmBlueprintAgent({
      editorialLlm: { runtime: "deterministic", env: {} },
    }).run(context());

    expect(result.blueprint.decision_runtime).toEqual({
      runtime: "deterministic",
      role: "blueprint-llm",
      author: "deterministic_fallback",
      attempted_runtimes: [{ runtime: "deterministic", status: "success" }],
    });
  });

  it("promotes a valid fallback when primary_candidate_ref is not in selects", async () => {
    const agent = createLlmBlueprintAgent({
      llm: async () =>
        validBlueprintResponse({
          beats: [
            {
              id: "b01",
              label: "hook",
              target_duration_frames: 120,
              required_roles: ["hero"],
              candidate_plan: {
                primary_candidate_ref: "cand_missing",
                fallback_candidate_refs: ["cand_close", "cand_missing_2"],
              },
            },
          ],
        }),
    });

    const result = await agent.run(context());

    expect(result.blueprint.beats[0].candidate_plan).toEqual({
      primary_candidate_ref: "cand_close",
      fallback_candidate_refs: [],
    });
  });

  it("preserves beat-scoped freeze authorship at source frame zero for video", async () => {
    const selects = selectsContent();
    const first = (selects.candidates as Array<Record<string, unknown>>)[0];
    first.src_in_us = 0;
    first.media_kind = "video";
    first.source_capabilities = { has_video: true, has_audio: true };
    const agent = createLlmBlueprintAgent({
      llm: async () => validBlueprintResponse({
        beats: [{
          id: "b01",
          label: "apex",
          target_duration_frames: 120,
          required_roles: ["hero"],
          candidate_plan: {
            primary_candidate_ref: "cand_hook",
            fallback_candidate_refs: [],
            freeze_frame_hold: { source_time_us: 0, hold_frames: 33 },
          },
        }],
      }),
    });

    const result = await agent.run(context({ selectsContent: selects }));

    expect(result.blueprint.beats[0].candidate_plan?.freeze_frame_hold).toEqual({
      source_time_us: 0,
      hold_frames: 33,
    });
  });

  it("promotes a semantically complete dialogue fallback over a fragment primary", async () => {
    const dialogueSelects = {
      version: "1",
      project_id: "test-project",
      candidates: [
        {
          candidate_id: "cand_fragment",
          segment_id: "SEG_FRAGMENT",
          asset_id: "AST_001",
          role: "dialogue",
          transcript_excerpt: "判断できないと思いますけど",
          eligible_beats: ["b01"],
          evidence: [],
          motif_tags: [],
        },
        {
          candidate_id: "cand_complete",
          segment_id: "SEG_COMPLETE",
          asset_id: "AST_001",
          role: "dialogue",
          transcript_excerpt: "経営者の理解が浅いと、担当者の提案を正しく判断できないと思います",
          eligible_beats: ["b01"],
          evidence: [],
          motif_tags: [],
        },
      ],
    };
    const agent = createLlmBlueprintAgent({
      llm: async () => validBlueprintResponse({
        beats: [{
          id: "b01",
          label: "reason",
          target_duration_frames: 240,
          required_roles: ["dialogue"],
          candidate_plan: {
            primary_candidate_ref: "cand_fragment",
            fallback_candidate_refs: ["cand_complete"],
          },
        }],
      }),
    });

    const result = await agent.run(context({ selectsContent: dialogueSelects }));

    expect(result.blueprint.beats[0].candidate_plan).toEqual({
      primary_candidate_ref: "cand_complete",
      fallback_candidate_refs: ["cand_fragment"],
    });
  });

  it("parses fenced JSON with surrounding text", async () => {
    const agent = createLlmBlueprintAgent({
      llm: async () => `Here is the blueprint:\n\`\`\`json\n${validBlueprintResponse()}\n\`\`\`\nDone.`,
    });

    const result = await agent.run(context());

    expect(result.blueprint.beats[0].candidate_plan?.primary_candidate_ref).toBe("cand_hook");
  });

  it("throws after one JSON repair retry when parsing keeps failing", async () => {
    let calls = 0;
    const llm: LlmCompleter = async () => {
      calls += 1;
      return calls === 1 ? "not json" : "still not json";
    };
    const agent = createLlmBlueprintAgent({ llm });

    await expect(agent.run(context())).rejects.toThrow("LLM blueprint response was not valid JSON after retry");
    expect(calls).toBe(2);
  });
});
