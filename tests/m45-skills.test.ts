import { describe, it, expect, beforeEach } from "vitest";
import {
  loadSkills,
  clearSkillCache,
  activateSkills,
  getSkillScoreAdjustment,
  getSkillMetadataTags,
  computeRegistryHash,
} from "../runtime/editorial/skill-registry.js";
import type { Candidate, EditBlueprint } from "../runtime/compiler/types.js";
import * as path from "node:path";

const SKILLS_DIR = path.resolve("runtime/editorial/skills");

const makeCandidate = (overrides: Partial<Candidate> = {}): Candidate => ({
  segment_id: "SEG_001",
  asset_id: "AST_001",
  src_in_us: 0,
  src_out_us: 5_000_000,
  role: "hero",
  why_it_matches: "test",
  risks: [],
  confidence: 0.9,
  ...overrides,
});

const makeBlueprint = (overrides: Partial<EditBlueprint> = {}): EditBlueprint => ({
  version: "1",
  project_id: "test",
  sequence_goals: ["test"],
  beats: [
    { id: "B1", label: "Hook", target_duration_frames: 72, required_roles: ["hero"] },
  ],
  pacing: { opening_cadence: "moderate", middle_cadence: "steady", ending_cadence: "resolving" },
  music_policy: { start_sparse: true, allow_release_late: true, entry_beat: "B1", avoid_anthemic_lift: false, permitted_energy_curve: "steady" },
  dialogue_policy: { preserve_natural_breath: true, avoid_wall_to_wall_voiceover: false },
  transition_policy: { prefer_match_texture_over_flashy_fx: true },
  ending_policy: { should_feel: "resolved" },
  rejection_rules: ["test"],
  ...overrides,
});

describe("Skill Registry", () => {
  beforeEach(() => {
    clearSkillCache();
  });

  it("loads all 12 supported skills", () => {
    const skills = loadSkills(SKILLS_DIR);
    expect(skills.size).toBe(12);
    expect(skills.has("build_to_peak")).toBe(true);
    expect(skills.has("silence_beat")).toBe(true);
    expect(skills.has("punch_in_emphasis")).toBe(true);
    expect(skills.has("reveal_then_payoff")).toBe(true);
    expect(skills.has("axis_hold_dialogue")).toBe(true);
    expect(skills.has("b_roll_bridge")).toBe(true);
    expect(skills.has("cooldown_resolve")).toBe(true);
    expect(skills.has("exposition_release")).toBe(true);
    expect(skills.has("match_cut_bridge")).toBe(true);
    expect(skills.has("shot_reverse_reaction")).toBe(true);
    expect(skills.has("smash_cut_energy")).toBe(true);
    expect(skills.has("deliberate_axis_break")).toBe(true);
  });

  it("excludes deferred skills", () => {
    const skills = loadSkills(SKILLS_DIR);
    expect(skills.has("crosscut_suspense")).toBe(false);
    expect(skills.has("montage_compress")).toBe(false);
    expect(skills.has("j_cut_lead_in")).toBe(false);
  });

  it("each skill has required fields", () => {
    const skills = loadSkills(SKILLS_DIR);
    for (const [id, skill] of skills) {
      expect(skill.id).toBe(id);
      expect(skill.category).toBeDefined();
      expect(skill.primary_phase).toBeDefined();
      expect(skill.status).toBe("active");
    }
  });
});

describe("Skill Activation", () => {
  beforeEach(() => {
    clearSkillCache();
  });

  it("activates skills listed in blueprint", () => {
    const bp = makeBlueprint({
      active_editing_skills: ["build_to_peak", "silence_beat"],
    });
    const c = makeCandidate({
      editorial_signals: {
        speech_intensity_score: 0.8,
        afterglow_score: 0.5,
        silence_ratio: 0.1,
      },
    });
    const active = activateSkills(bp, [c], undefined, undefined, SKILLS_DIR);
    expect(active).toContain("build_to_peak");
    expect(active).toContain("silence_beat");
  });

  it("applies policy suppressions", () => {
    const bp = makeBlueprint({
      active_editing_skills: ["smash_cut_energy", "build_to_peak"],
    });
    const c = makeCandidate({
      editorial_signals: { speech_intensity_score: 0.8 },
    });
    const active = activateSkills(
      bp,
      [c],
      undefined,
      { id: "interview", skill_suppressions: ["smash_cut_energy"], skill_enforcements: [] },
      SKILLS_DIR,
    );
    expect(active).not.toContain("smash_cut_energy");
    expect(active).toContain("build_to_peak");
  });

  it("applies policy enforcements", () => {
    const bp = makeBlueprint({
      active_editing_skills: ["build_to_peak"],
    });
    const active = activateSkills(
      bp,
      [makeCandidate()],
      undefined,
      { id: "interview", skill_suppressions: [], skill_enforcements: ["axis_hold_dialogue"] },
      SKILLS_DIR,
    );
    expect(active).toContain("axis_hold_dialogue");
  });

  it("filters by required signals", () => {
    const bp = makeBlueprint({
      active_editing_skills: ["shot_reverse_reaction"],
    });
    // shot_reverse_reaction requires reaction_intensity_score
    // Without it, skill should be filtered out
    const active = activateSkills(
      bp,
      [makeCandidate()], // no editorial_signals
      undefined,
      undefined,
      SKILLS_DIR,
    );
    expect(active).not.toContain("shot_reverse_reaction");
  });

  it("includes skills when required signals are available", () => {
    const bp = makeBlueprint({
      active_editing_skills: ["shot_reverse_reaction"],
    });
    const c = makeCandidate({
      editorial_signals: { reaction_intensity_score: 0.5 },
    });
    const active = activateSkills(bp, [c], undefined, undefined, SKILLS_DIR);
    expect(active).toContain("shot_reverse_reaction");
  });

  it("returns sorted list for determinism", () => {
    const bp = makeBlueprint({
      active_editing_skills: ["silence_beat", "build_to_peak", "b_roll_bridge"],
    });
    const active = activateSkills(bp, [makeCandidate()], undefined, undefined, SKILLS_DIR);
    const sorted = [...active].sort();
    expect(active).toEqual(sorted);
  });
});

describe("Skill Score Adjustment", () => {
  beforeEach(() => {
    clearSkillCache();
  });

  it("returns 0 when no active skills", () => {
    const adj = getSkillScoreAdjustment([], makeCandidate(), undefined, SKILLS_DIR);
    expect(adj).toBe(0);
  });

  it("returns positive adjustment for score-phase skills", () => {
    const adj = getSkillScoreAdjustment(
      ["b_roll_bridge", "exposition_release"],
      makeCandidate(),
      undefined,
      SKILLS_DIR,
    );
    expect(adj).toBeGreaterThan(0);
  });
});

describe("Skill Metadata Tags", () => {
  beforeEach(() => {
    clearSkillCache();
  });

  it("collects unique tags from active skills", () => {
    const tags = getSkillMetadataTags(
      ["build_to_peak", "silence_beat"],
      makeCandidate(),
      SKILLS_DIR,
    );
    expect(tags).toContain("intensity_gradient");
    expect(tags).toContain("intentional_hold");
  });

  it("deduplicates tags", () => {
    const tags = getSkillMetadataTags(
      ["build_to_peak"],
      makeCandidate(),
      SKILLS_DIR,
    );
    const uniqueCount = new Set(tags).size;
    expect(tags.length).toBe(uniqueCount);
  });
});

describe("Registry Hash", () => {
  beforeEach(() => {
    clearSkillCache();
  });

  it("produces a hex string", () => {
    const hash = computeRegistryHash(SKILLS_DIR);
    expect(hash).toMatch(/^[0-9a-f]{16}$/);
  });

  it("is deterministic", () => {
    const hash1 = computeRegistryHash(SKILLS_DIR);
    clearSkillCache();
    const hash2 = computeRegistryHash(SKILLS_DIR);
    expect(hash1).toBe(hash2);
  });
});
