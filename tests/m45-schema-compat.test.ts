import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import * as fs from "node:fs";
import * as path from "node:path";

const require = createRequire(import.meta.url);
const Ajv2020 = require("ajv/dist/2020") as new (opts: Record<string, unknown>) => {
  compile(schema: object): { (data: unknown): boolean; errors?: Array<{ instancePath: string; message?: string }> | null };
  addSchema(schema: object): void;
};
const addFormats = require("ajv-formats") as (ajv: any) => void;

function loadSchema(name: string): object {
  const raw = fs.readFileSync(path.resolve("schemas", name), "utf-8");
  return JSON.parse(raw);
}

function createValidator() {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  return ajv;
}

describe("Schema Backward Compatibility", () => {
  it("M4 selects_candidates without M4.5 fields still validates", () => {
    const ajv = createValidator();
    const schema = loadSchema("selects-candidates.schema.json");
    const validate = ajv.compile(schema);

    // M4-era artifact — no candidate_id, no trim_hint, no editorial_signals
    const m4Selects = {
      version: "1",
      project_id: "test",
      candidates: [
        {
          segment_id: "SEG_001",
          asset_id: "AST_001",
          src_in_us: 0,
          src_out_us: 5000000,
          role: "hero",
          why_it_matches: "test",
          risks: [],
          confidence: 0.9,
        },
      ],
    };

    const valid = validate(m4Selects);
    expect(valid).toBe(true);
  });

  it("M4.5 selects_candidates with new fields validates", () => {
    const ajv = createValidator();
    const schema = loadSchema("selects-candidates.schema.json");
    const validate = ajv.compile(schema);

    const m45Selects = {
      version: "1",
      project_id: "test",
      candidates: [
        {
          segment_id: "SEG_001",
          asset_id: "AST_001",
          src_in_us: 0,
          src_out_us: 5000000,
          role: "hero",
          why_it_matches: "test",
          risks: [],
          confidence: 0.9,
          candidate_id: "cand_abc123",
          speaker_role: "primary",
          semantic_dedupe_key: "topic_1",
          editorial_signals: {
            speech_intensity_score: 0.8,
            afterglow_score: 0.3,
            face_detected: true,
          },
          trim_hint: {
            source_center_us: 2500000,
            preferred_duration_us: 3000000,
            min_duration_us: 1000000,
            max_duration_us: 4000000,
            interest_point_label: "key_moment",
            interest_point_confidence: 0.95,
          },
        },
      ],
      editorial_summary: {
        dominant_visual_mode: "talking_head",
        speaker_topology: "solo_primary",
        motion_profile: "low",
        transcript_density: "dense",
      },
    };

    const valid = validate(m45Selects);
    if (!valid) console.error(validate.errors);
    expect(valid).toBe(true);
  });

  it("M4 edit_blueprint without M4.5 fields still validates", () => {
    const ajv = createValidator();
    const schema = loadSchema("edit-blueprint.schema.json");
    const validate = ajv.compile(schema);

    const m4Blueprint = {
      sequence_goals: ["Tell a story"],
      beats: [
        {
          id: "B1",
          label: "Hook",
          target_duration_frames: 72,
          required_roles: ["hero"],
        },
      ],
      pacing: {
        opening_cadence: "moderate",
        middle_cadence: "steady",
        ending_cadence: "resolving",
      },
      music_policy: {
        start_sparse: true,
        allow_release_late: true,
        entry_beat: "B1",
      },
      dialogue_policy: {
        preserve_natural_breath: true,
        avoid_wall_to_wall_voiceover: false,
      },
      transition_policy: {
        prefer_match_texture_over_flashy_fx: true,
      },
      ending_policy: {
        should_feel: "resolved",
      },
      rejection_rules: ["no violence"],
    };

    const valid = validate(m4Blueprint);
    expect(valid).toBe(true);
  });

  it("M4.5 edit_blueprint with new fields validates", () => {
    const ajv = createValidator();
    const schema = loadSchema("edit-blueprint.schema.json");
    const validate = ajv.compile(schema);

    const m45Blueprint = {
      sequence_goals: ["Tell a story"],
      beats: [
        {
          id: "B1",
          label: "Hook",
          target_duration_frames: 72,
          required_roles: ["hero"],
          story_role: "hook",
          skill_hints: ["build_to_peak"],
          candidate_plan: {
            primary_candidate_ref: "cand_abc",
            fallback_candidate_refs: ["cand_def"],
          },
        },
      ],
      pacing: {
        opening_cadence: "moderate",
        middle_cadence: "steady",
        ending_cadence: "resolving",
        default_duration_target_sec: 60,
      },
      music_policy: {
        start_sparse: true,
        allow_release_late: true,
        entry_beat: "B1",
      },
      dialogue_policy: {
        preserve_natural_breath: true,
        avoid_wall_to_wall_voiceover: false,
      },
      transition_policy: {
        prefer_match_texture_over_flashy_fx: true,
      },
      ending_policy: {
        should_feel: "resolved",
      },
      rejection_rules: ["no violence"],
      story_arc: {
        summary: "A journey of growth",
        strategy: "peak_first",
        chronology_bias: "flexible",
        allow_time_reorder: true,
        causal_links: ["B1 → B2"],
      },
      resolved_profile: {
        id: "interview-highlight",
        source: "inferred",
        rationale: "Inferred from editorial summary",
      },
      resolved_policy: {
        id: "interview",
        source: "inferred",
        rationale: "Default policy for profile",
      },
      active_editing_skills: ["build_to_peak", "silence_beat"],
      dedupe_rules: {
        utterance_consumption: "unique",
        semantic_similarity_threshold: 0.85,
        allow_intentional_repetition: false,
      },
      quality_targets: {
        hook_density_min: 0.5,
        novelty_rate_min: 0.7,
      },
      trim_policy: {
        mode: "adaptive",
        default_preferred_duration_frames: 72,
        default_min_duration_frames: 24,
        default_max_duration_frames: 144,
      },
    };

    const valid = validate(m45Blueprint);
    if (!valid) console.error(validate.errors);
    expect(valid).toBe(true);
  });

  it("M4 timeline-ir without candidate_ref validates", () => {
    const ajv = createValidator();
    const schema = loadSchema("timeline-ir.schema.json");
    const validate = ajv.compile(schema);

    const m4Timeline = {
      version: "1",
      project_id: "test",
      created_at: "2026-03-22T00:00:00Z",
      sequence: {
        name: "Test",
        fps_num: 24,
        fps_den: 1,
        width: 1920,
        height: 1080,
        start_frame: 0,
      },
      tracks: {
        video: [
          {
            track_id: "V1",
            kind: "video",
            clips: [
              {
                clip_id: "CLP_0001",
                segment_id: "SEG_001",
                asset_id: "AST_001",
                src_in_us: 0,
                src_out_us: 3000000,
                timeline_in_frame: 0,
                timeline_duration_frames: 72,
                role: "hero",
                motivation: "test",
              },
            ],
          },
        ],
        audio: [],
      },
      markers: [],
      provenance: {
        brief_path: "01_intent/creative_brief.yaml",
        blueprint_path: "04_plan/edit_blueprint.yaml",
        selects_path: "04_plan/selects_candidates.yaml",
      },
    };

    const valid = validate(m4Timeline);
    expect(valid).toBe(true);
  });

  it("M4.5 timeline-ir with candidate_ref and provenance hashes validates", () => {
    const ajv = createValidator();
    const schema = loadSchema("timeline-ir.schema.json");
    const validate = ajv.compile(schema);

    const m45Timeline = {
      version: "1",
      project_id: "test",
      created_at: "2026-03-22T00:00:00Z",
      sequence: {
        name: "Test",
        fps_num: 24,
        fps_den: 1,
        width: 1920,
        height: 1080,
        start_frame: 0,
      },
      tracks: {
        video: [
          {
            track_id: "V1",
            kind: "video",
            clips: [
              {
                clip_id: "CLP_0001",
                segment_id: "SEG_001",
                asset_id: "AST_001",
                src_in_us: 0,
                src_out_us: 3000000,
                timeline_in_frame: 0,
                timeline_duration_frames: 72,
                role: "hero",
                motivation: "test",
                candidate_ref: "cand_abc123",
                fallback_candidate_refs: ["cand_def456"],
                metadata: {
                  editorial: {
                    applied_skills: ["build_to_peak"],
                    resolved_profile: "interview-highlight",
                  },
                },
              },
            ],
          },
        ],
        audio: [],
      },
      markers: [],
      provenance: {
        brief_path: "01_intent/creative_brief.yaml",
        blueprint_path: "04_plan/edit_blueprint.yaml",
        selects_path: "04_plan/selects_candidates.yaml",
        compiler_version: "1.0.0",
        compiler_defaults_hash: "abc123def456",
        editorial_registry_hash: "789ghi012jkl",
      },
    };

    const valid = validate(m45Timeline);
    if (!valid) console.error(validate.errors);
    expect(valid).toBe(true);
  });

  it("M4 review-patch without with_candidate_ref validates", () => {
    const ajv = createValidator();
    const schema = loadSchema("review-patch.schema.json");
    const validate = ajv.compile(schema);

    const m4Patch = {
      timeline_version: "1",
      operations: [
        {
          op: "replace_segment",
          target_clip_id: "CLP_0001",
          with_segment_id: "SEG_002",
          reason: "Better match",
        },
      ],
    };

    const valid = validate(m4Patch);
    expect(valid).toBe(true);
  });

  it("M4.5 review-patch with with_candidate_ref validates", () => {
    const ajv = createValidator();
    const schema = loadSchema("review-patch.schema.json");
    const validate = ajv.compile(schema);

    const m45Patch = {
      timeline_version: "1",
      operations: [
        {
          op: "replace_segment",
          target_clip_id: "CLP_0001",
          with_segment_id: "SEG_002",
          with_candidate_ref: "cand_abc123",
          reason: "Better match",
        },
      ],
    };

    const valid = validate(m45Patch);
    expect(valid).toBe(true);
  });

  it("creative-brief with editorial field validates", () => {
    const ajv = createValidator();
    const schema = loadSchema("creative-brief.schema.json");
    const validate = ajv.compile(schema);

    const brief = {
      project: { title: "Test", strategy: "interview" },
      message: { primary: "Test message" },
      audience: { primary: "testers" },
      emotion_curve: ["curiosity", "engagement", "resolution"],
      must_have: ["authenticity"],
      must_avoid: ["violence"],
      autonomy: { may_decide: ["pacing"], must_ask: [] },
      resolved_assumptions: ["All footage is available"],
      editorial: {
        distribution_channel: "web_lp",
        aspect_ratio: "16:9",
        embed_context: "standalone",
        hook_priority: "balanced",
        credibility_bias: "high",
        profile_hint: "interview-highlight",
        policy_hint: "interview",
        allow_inference: true,
      },
    };

    const valid = validate(brief);
    if (!valid) console.error(validate.errors);
    expect(valid).toBe(true);
  });

  it("creative-brief without editorial field validates (backward compat)", () => {
    const ajv = createValidator();
    const schema = loadSchema("creative-brief.schema.json");
    const validate = ajv.compile(schema);

    const brief = {
      project: { title: "Test", strategy: "interview" },
      message: { primary: "Test message" },
      audience: { primary: "testers" },
      emotion_curve: ["curiosity", "engagement", "resolution"],
      must_have: ["authenticity"],
      must_avoid: ["violence"],
      autonomy: { may_decide: ["pacing"], must_ask: [] },
      resolved_assumptions: ["All footage is available"],
    };

    const valid = validate(brief);
    expect(valid).toBe(true);
  });
});

describe("Operational Schemas", () => {
  it("message-frame schema validates", () => {
    const ajv = createValidator();
    const schema = loadSchema("message-frame.schema.json");
    const validate = ajv.compile(schema);

    const frame = {
      story_promise: "A journey",
      hook_angle: "The moment",
      closing_intent: "Hope",
      beat_strategy: { beat_count: 4, role_sequence: ["hook", "setup", "experience", "closing"] },
    };
    expect(validate(frame)).toBe(true);
  });

  it("material-reading schema validates", () => {
    const ajv = createValidator();
    const schema = loadSchema("material-reading.schema.json");
    const validate = ajv.compile(schema);

    const reading = {
      version: "1",
      project_id: "test",
      beat_readings: [
        {
          beat_id: "B1",
          top_candidates: [{ candidate_ref: "cand_001", why_primary: "best match" }],
        },
      ],
    };
    expect(validate(reading)).toBe(true);
  });

  it("script-draft schema validates", () => {
    const ajv = createValidator();
    const schema = loadSchema("script-draft.schema.json");
    const validate = ajv.compile(schema);

    const draft = {
      version: "1",
      project_id: "test",
      beat_assignments: [
        {
          beat_id: "B1",
          primary_candidate_ref: "cand_001",
          story_role: "hook",
        },
      ],
    };
    expect(validate(draft)).toBe(true);
  });

  it("script-evaluation schema validates", () => {
    const ajv = createValidator();
    const schema = loadSchema("script-evaluation.schema.json");
    const validate = ajv.compile(schema);

    const evaluation = {
      version: "1",
      project_id: "test",
      metrics: { hook_density: 0.8, novelty_rate: 0.9 },
      gate_pass: true,
    };
    expect(validate(evaluation)).toBe(true);
  });
});
