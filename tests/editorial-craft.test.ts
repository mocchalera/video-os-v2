import { createRequire } from "node:module";
import * as fs from "node:fs";
import * as path from "node:path";
import { parse as parseYaml } from "yaml";
import { describe, expect, it } from "vitest";
import { applyRhythmPattern } from "../runtime/compiler/assemble.js";
import { adjacencyDecide, craftTransitionToSkillId } from "../runtime/compiler/adjacency.js";
import { applyAdaptiveTrim } from "../runtime/compiler/trim.js";
import type {
  Candidate,
  EditBlueprint,
  NormalizedBeat,
  TimelineClip,
  Track,
} from "../runtime/compiler/types.js";

const require = createRequire(import.meta.url);
const Ajv2020 = require("ajv/dist/2020") as new (opts: Record<string, unknown>) => {
  compile(schema: object): { (data: unknown): boolean; errors?: unknown[] | null };
};
const addFormats = require("ajv-formats") as (ajv: unknown) => void;

const TRANSITION_SKILLS_DIR = path.resolve("runtime/editorial/transition-skills");

function createValidator(schemaFile: string) {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  const schema = JSON.parse(fs.readFileSync(path.resolve("schemas", schemaFile), "utf-8")) as object;
  return ajv.compile(schema);
}

const makeClip = (id: string, overrides: Partial<TimelineClip> = {}): TimelineClip => ({
  clip_id: `clip_${id}`,
  segment_id: `SEG_${id}`,
  asset_id: `AST_${id}`,
  src_in_us: 0,
  src_out_us: 4_000_000,
  timeline_in_frame: 0,
  timeline_duration_frames: 40,
  role: "hero",
  motivation: "test",
  beat_id: `B${id}`,
  fallback_segment_ids: [],
  confidence: 0.9,
  quality_flags: [],
  ...overrides,
});

const makeCandidate = (overrides: Partial<Candidate> = {}): Candidate => ({
  segment_id: "SEG_001",
  asset_id: "AST_001",
  src_in_us: 0,
  src_out_us: 6_000_000,
  role: "hero",
  why_it_matches: "test",
  risks: [],
  confidence: 0.9,
  ...overrides,
});

const makeBeat = (id: string, overrides: Partial<NormalizedBeat> = {}): NormalizedBeat => ({
  beat_id: id,
  label: `Beat ${id}`,
  target_duration_frames: 96,
  required_roles: ["hero"],
  preferred_roles: [],
  purpose: "test",
  ...overrides,
});

describe("editorial craft directives", () => {
  it("validates beat-level craft directives in edit_blueprint schema", () => {
    const blueprint = parseYaml(
      fs.readFileSync(path.resolve("projects/sample/04_plan/edit_blueprint.yaml"), "utf-8"),
    ) as { beats: Array<Record<string, unknown>> };
    blueprint.beats[0].craft = {
      in_point: "cut_on_action",
      transition_in: "hard_cut",
      transition_out: "dissolve",
      rhythm: "accelerando",
      shot_progression: "wide_to_close",
      beat_sync: true,
      hold_duration_bias: 1.1,
    };

    const validate = createValidator("edit-blueprint.schema.json");
    expect(validate(blueprint), JSON.stringify(validate.errors, null, 2)).toBe(true);
  });

  it("applies accelerando as decreasing clip durations", () => {
    const clips = [
      makeClip("01", { timeline_in_frame: 0, timeline_duration_frames: 40 }),
      makeClip("02", { timeline_in_frame: 40, timeline_duration_frames: 40 }),
      makeClip("03", { timeline_in_frame: 80, timeline_duration_frames: 40 }),
    ];

    applyRhythmPattern(clips, "accelerando", 24);

    expect(clips.map((clip) => clip.timeline_duration_frames)).toEqual([60, 40, 20]);
    expect(clips.map((clip) => clip.timeline_in_frame)).toEqual([0, 60, 100]);
  });

  it("passes beat craft.in_point into adaptive trim", () => {
    const candidate = makeCandidate({
      trim_hint: {
        source_center_us: 3_000_000,
        preferred_duration_us: 2_000_000,
      },
    });
    const clip = makeClip("001", {
      segment_id: candidate.segment_id,
      asset_id: candidate.asset_id,
      src_in_us: candidate.src_in_us,
      src_out_us: candidate.src_out_us,
      beat_id: "B01",
      timeline_duration_frames: 48,
    });
    const blueprint = { trim_policy: { mode: "adaptive" } } as EditBlueprint;
    const beat = makeBeat("B01", {
      craft: { in_point: "pre_roll_enter" },
      target_duration_frames: 72,
    });

    const result = applyAdaptiveTrim([clip], [candidate], blueprint, [beat], 1_000_000 / 24);

    expect(result.get(clip.clip_id)?.craft_in_point).toBe("pre_roll_enter");
    expect(clip.src_in_us).toBe(1_500_000);
    expect(clip.src_out_us).toBe(3_500_000);
    expect(clip.metadata?.trim).toMatchObject({ craft_in_point: "pre_roll_enter" });
  });

  it("biases dissolve craft toward crossfade_bridge", () => {
    expect(craftTransitionToSkillId("dissolve")).toBe("crossfade_bridge");

    const v1: Track = {
      track_id: "V1",
      kind: "video",
      clips: [
        makeClip("01", { timeline_in_frame: 0, timeline_duration_frames: 72, beat_id: "B01" }),
        makeClip("02", { timeline_in_frame: 72, timeline_duration_frames: 72, beat_id: "B02", asset_id: "AST_002" }),
      ],
    };

    const { transitions } = adjacencyDecide(v1, {
      activeEditingSkills: [],
      durationMode: "guide",
      fpsNum: 24,
      candidates: [
        makeCandidate({
          segment_id: "SEG_01",
          editorial_signals: { semantic_cluster_id: "topic_A", visual_tags: ["person"] },
        }),
        makeCandidate({
          segment_id: "SEG_02",
          asset_id: "AST_002",
          editorial_signals: { semantic_cluster_id: "topic_B", visual_tags: ["landscape"] },
        }),
      ],
      beats: [
        makeBeat("B01", { craft: { transition_out: "dissolve" } }),
        makeBeat("B02"),
      ],
      transitionSkillsDir: TRANSITION_SKILLS_DIR,
    });

    expect(transitions[0].transition_type).toBe("crossfade");
    expect(transitions[0].applied_skill_id).toBe("crossfade_bridge");
  });

  it("emits deferred craft transitions as metadata-only cuts", () => {
    const v1: Track = {
      track_id: "V1",
      kind: "video",
      clips: [
        makeClip("01", { timeline_in_frame: 0, timeline_duration_frames: 72, beat_id: "B01" }),
        makeClip("02", { timeline_in_frame: 72, timeline_duration_frames: 72, beat_id: "B02", asset_id: "AST_002" }),
      ],
    };

    const { transitions } = adjacencyDecide(v1, {
      activeEditingSkills: [],
      durationMode: "guide",
      fpsNum: 24,
      candidates: [
        makeCandidate({ segment_id: "SEG_01" }),
        makeCandidate({ segment_id: "SEG_02", asset_id: "AST_002" }),
      ],
      beats: [
        makeBeat("B01", { craft: { transition_out: "j_cut" } }),
        makeBeat("B02"),
      ],
      transitionSkillsDir: TRANSITION_SKILLS_DIR,
    });

    expect(transitions[0].transition_type).toBe("cut");
    expect(transitions[0].applied_skill_id).toBe("craft.j_cut.metadata_only");
  });
});
