import { describe, it, expect, beforeEach } from "vitest";
import { buildMessageFrame, type FrameInput } from "../runtime/script/frame.js";
import { buildMaterialReading, type ReadInput } from "../runtime/script/read.js";
import { buildScriptDraft, type DraftInput } from "../runtime/script/draft.js";
import { evaluateScript, type EvaluateInput } from "../runtime/script/evaluate.js";
import { clearRegistryCache } from "../runtime/editorial/policy-resolver.js";
import type { Candidate, EditBlueprint, NormalizedBeat } from "../runtime/compiler/types.js";
import * as path from "node:path";

const PROFILES_DIR = path.resolve("runtime/editorial/profiles");
const POLICIES_DIR = path.resolve("runtime/editorial/policies");

const makeCandidate = (id: string, overrides: Partial<Candidate> = {}): Candidate => ({
  segment_id: `SEG_${id}`,
  asset_id: `AST_${id}`,
  src_in_us: 0,
  src_out_us: 5_000_000,
  role: "hero",
  why_it_matches: `Match for ${id}`,
  risks: [],
  confidence: 0.85,
  candidate_id: `cand_${id}`,
  semantic_rank: 1,
  ...overrides,
});

const makeBeats = (): NormalizedBeat[] => [
  { beat_id: "B1", label: "Hook", target_duration_frames: 72, required_roles: ["hero"], preferred_roles: [], purpose: "Opening hook" },
  { beat_id: "B2", label: "Setup", target_duration_frames: 96, required_roles: ["hero", "support"], preferred_roles: [], purpose: "Setup context" },
  { beat_id: "B3", label: "Experience", target_duration_frames: 120, required_roles: ["hero"], preferred_roles: ["support"], purpose: "Core story" },
  { beat_id: "B4", label: "Closing", target_duration_frames: 72, required_roles: ["hero"], preferred_roles: ["texture"], purpose: "Resolution" },
];

const makeBlueprint = (): EditBlueprint => ({
  version: "1",
  project_id: "test-proj",
  sequence_goals: ["Tell a compelling story"],
  beats: makeBeats().map((b) => ({
    id: b.beat_id,
    label: b.label,
    purpose: b.purpose,
    target_duration_frames: b.target_duration_frames,
    required_roles: b.required_roles as any,
    preferred_roles: b.preferred_roles as any,
  })),
  pacing: { opening_cadence: "moderate", middle_cadence: "steady", ending_cadence: "resolving" },
  music_policy: { start_sparse: true, allow_release_late: true, entry_beat: "B1", avoid_anthemic_lift: false, permitted_energy_curve: "steady" },
  dialogue_policy: { preserve_natural_breath: true, avoid_wall_to_wall_voiceover: false },
  transition_policy: { prefer_match_texture_over_flashy_fx: true },
  ending_policy: { should_feel: "resolved" },
  rejection_rules: ["no violence"],
  active_editing_skills: ["build_to_peak", "silence_beat"],
});

describe("Script Engine Phase A: Frame", () => {
  beforeEach(() => clearRegistryCache());

  it("builds message frame with resolved profile", () => {
    const input: FrameInput = {
      projectId: "test-proj",
      createdAt: "2026-03-22T00:00:00Z",
      storyPromise: "A journey of transformation",
      hookAngle: "Start with the moment of change",
      closingIntent: "End with hope",
      resolutionInput: {
        briefEditorial: { profile_hint: "interview-highlight" },
      },
      beatCount: 4,
      profilesDir: PROFILES_DIR,
      policiesDir: POLICIES_DIR,
    };
    const { frame, resolution } = buildMessageFrame(input);

    expect(frame.story_promise).toBe("A journey of transformation");
    expect(frame.hook_angle).toBe("Start with the moment of change");
    expect(frame.closing_intent).toBe("End with hope");
    expect(frame.resolved_profile_candidate.id).toBe("interview-highlight");
    expect(frame.resolved_policy_candidate.id).toBe("interview");
    expect(frame.beat_strategy.beat_count).toBe(4);
    expect(frame.beat_strategy.role_sequence).toEqual(["hook", "setup", "experience", "closing"]);
  });

  it("builds default role sequence for various beat counts", () => {
    const input: FrameInput = {
      projectId: "test-proj",
      createdAt: "2026-03-22T00:00:00Z",
      storyPromise: "Test",
      hookAngle: "Test",
      closingIntent: "Test",
      resolutionInput: {},
      beatCount: 6,
      profilesDir: PROFILES_DIR,
      policiesDir: POLICIES_DIR,
    };
    const { frame } = buildMessageFrame(input);
    expect(frame.beat_strategy.role_sequence).toEqual([
      "hook", "setup", "experience", "experience", "experience", "closing",
    ]);
  });
});

describe("Script Engine Phase B: Read", () => {
  it("produces beat readings with candidate assignments", () => {
    const candidates = [
      makeCandidate("001"),
      makeCandidate("002", { role: "support", semantic_rank: 2 }),
      makeCandidate("003", { role: "hero", confidence: 0.7, semantic_rank: 3 }),
      makeCandidate("004", { role: "texture", semantic_rank: 4 }),
    ];
    const input: ReadInput = {
      projectId: "test-proj",
      createdAt: "2026-03-22T00:00:00Z",
      beats: makeBeats(),
      candidates,
      blueprint: makeBlueprint(),
    };
    const reading = buildMaterialReading(input);

    expect(reading.beat_readings.length).toBe(4);
    for (const br of reading.beat_readings) {
      expect(br.top_candidates.length).toBeGreaterThan(0);
    }
  });

  it("detects coverage gaps", () => {
    // Only hero candidates, no support
    const candidates = [makeCandidate("001")];
    const input: ReadInput = {
      projectId: "test-proj",
      createdAt: "2026-03-22T00:00:00Z",
      beats: makeBeats(),
      candidates,
      blueprint: makeBlueprint(),
    };
    const reading = buildMaterialReading(input);
    // B2 requires support — should have a gap
    const b2 = reading.beat_readings.find((r) => r.beat_id === "B2");
    expect(b2?.coverage_gaps.length).toBeGreaterThan(0);
  });

  it("builds dedupe groups from semantic_dedupe_key", () => {
    const candidates = [
      makeCandidate("001", { semantic_dedupe_key: "topic_a" }),
      makeCandidate("002", { semantic_dedupe_key: "topic_a" }),
      makeCandidate("003", { semantic_dedupe_key: "topic_b" }),
    ];
    const input: ReadInput = {
      projectId: "test-proj",
      createdAt: "2026-03-22T00:00:00Z",
      beats: makeBeats(),
      candidates,
      blueprint: makeBlueprint(),
    };
    const reading = buildMaterialReading(input);
    expect(reading.dedupe_groups.length).toBe(1);
    expect(reading.dedupe_groups[0].key).toBe("topic_a");
    expect(reading.dedupe_groups[0].candidate_refs.length).toBe(2);
  });
});

describe("Script Engine Phase C: Draft", () => {
  it("assigns candidates to beats with story roles", () => {
    const candidates = [
      makeCandidate("001"),
      makeCandidate("002", { role: "support", semantic_rank: 2 }),
      makeCandidate("003", { role: "hero", confidence: 0.7, semantic_rank: 3 }),
    ];
    const beats = makeBeats();
    const blueprint = makeBlueprint();
    const reading = buildMaterialReading({
      projectId: "test-proj",
      createdAt: "2026-03-22T00:00:00Z",
      beats,
      candidates,
      blueprint,
    });
    const { frame } = buildMessageFrame({
      projectId: "test-proj",
      createdAt: "2026-03-22T00:00:00Z",
      storyPromise: "Test",
      hookAngle: "Test",
      closingIntent: "Test",
      resolutionInput: { briefEditorial: { profile_hint: "interview-highlight" } },
      beatCount: 4,
      profilesDir: PROFILES_DIR,
      policiesDir: POLICIES_DIR,
    });

    const draft = buildScriptDraft({
      projectId: "test-proj",
      createdAt: "2026-03-22T00:00:00Z",
      frame,
      reading,
      blueprint,
      beats,
    });

    expect(draft.beat_assignments.length).toBe(4);
    expect(draft.beat_assignments[0].story_role).toBe("hook");
    expect(draft.beat_assignments[3].story_role).toBe("closing");
    expect(draft.delivery_order).toEqual(["B1", "B2", "B3", "B4"]);
  });
});

describe("Script Engine Phase D: Evaluate", () => {
  it("computes hook_density and novelty_rate", () => {
    const candidates = [
      makeCandidate("001", { confidence: 0.9 }),
      makeCandidate("002", { confidence: 0.8, semantic_dedupe_key: "unique_1" }),
      makeCandidate("003", { confidence: 0.7, semantic_dedupe_key: "unique_2" }),
      makeCandidate("004", { confidence: 0.6, semantic_dedupe_key: "unique_3" }),
    ];
    const beats = makeBeats();
    const blueprint = makeBlueprint();

    const draft = {
      version: "1",
      project_id: "test-proj",
      created_at: "2026-03-22T00:00:00Z",
      delivery_order: ["B1", "B2", "B3", "B4"],
      beat_assignments: [
        { beat_id: "B1", primary_candidate_ref: "cand_001", backup_candidate_refs: ["cand_002"], story_role: "hook" as const, active_skill_hints: [], rationale: "test" },
        { beat_id: "B2", primary_candidate_ref: "cand_002", backup_candidate_refs: [], story_role: "setup" as const, active_skill_hints: [], rationale: "test" },
        { beat_id: "B3", primary_candidate_ref: "cand_003", backup_candidate_refs: [], story_role: "experience" as const, active_skill_hints: [], rationale: "test" },
        { beat_id: "B4", primary_candidate_ref: "cand_004", backup_candidate_refs: [], story_role: "closing" as const, active_skill_hints: [], rationale: "test" },
      ],
    };

    const evaluation = evaluateScript({
      projectId: "test-proj",
      createdAt: "2026-03-22T00:00:00Z",
      draft,
      candidates,
      blueprint,
      beats,
    });

    expect(evaluation.metrics.hook_density).toBeGreaterThanOrEqual(0);
    expect(evaluation.metrics.hook_density).toBeLessThanOrEqual(1);
    expect(evaluation.metrics.novelty_rate).toBe(1); // all unique
    expect(evaluation.gate_pass).toBe(true);
  });

  it("detects duplicate primary usage", () => {
    const candidates = [makeCandidate("001")];
    const beats = makeBeats().slice(0, 2);
    const blueprint = makeBlueprint();

    const draft = {
      version: "1",
      project_id: "test-proj",
      created_at: "2026-03-22T00:00:00Z",
      delivery_order: ["B1", "B2"],
      beat_assignments: [
        { beat_id: "B1", primary_candidate_ref: "cand_001", backup_candidate_refs: [], story_role: "hook" as const, active_skill_hints: [], rationale: "test" },
        { beat_id: "B2", primary_candidate_ref: "cand_001", backup_candidate_refs: [], story_role: "setup" as const, active_skill_hints: [], rationale: "test" },
      ],
    };

    const evaluation = evaluateScript({
      projectId: "test-proj",
      createdAt: "2026-03-22T00:00:00Z",
      draft,
      candidates,
      blueprint,
      beats,
    });

    expect(evaluation.warnings.some((w) => w.type === "duplicate_primary")).toBe(true);
  });

  it("detects missing beats", () => {
    const candidates = [makeCandidate("001")];
    const beats = makeBeats();
    const blueprint = makeBlueprint();

    const draft = {
      version: "1",
      project_id: "test-proj",
      created_at: "2026-03-22T00:00:00Z",
      delivery_order: ["B1"],
      beat_assignments: [
        { beat_id: "B1", primary_candidate_ref: "cand_001", backup_candidate_refs: [], story_role: "hook" as const, active_skill_hints: [], rationale: "test" },
      ],
    };

    const evaluation = evaluateScript({
      projectId: "test-proj",
      createdAt: "2026-03-22T00:00:00Z",
      draft,
      candidates,
      blueprint,
      beats,
    });

    expect(evaluation.missing_beats.length).toBe(3); // B2, B3, B4 missing
    expect(evaluation.gate_pass).toBe(false);
  });

  it("detects adjacent semantic duplicates", () => {
    const candidates = [
      makeCandidate("001", { semantic_dedupe_key: "same_topic" }),
      makeCandidate("002", { semantic_dedupe_key: "same_topic" }),
    ];
    const beats = makeBeats().slice(0, 2);
    const blueprint = makeBlueprint();

    const draft = {
      version: "1",
      project_id: "test-proj",
      created_at: "2026-03-22T00:00:00Z",
      delivery_order: ["B1", "B2"],
      beat_assignments: [
        { beat_id: "B1", primary_candidate_ref: "cand_001", backup_candidate_refs: [], story_role: "hook" as const, active_skill_hints: [], rationale: "test" },
        { beat_id: "B2", primary_candidate_ref: "cand_002", backup_candidate_refs: [], story_role: "setup" as const, active_skill_hints: [], rationale: "test" },
      ],
    };

    const evaluation = evaluateScript({
      projectId: "test-proj",
      createdAt: "2026-03-22T00:00:00Z",
      draft,
      candidates,
      blueprint,
      beats,
    });

    expect(evaluation.warnings.some((w) => w.type === "adjacent_semantic_duplicate")).toBe(true);
  });
});
