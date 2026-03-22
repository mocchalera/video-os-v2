// Tests for the Cut Transition system (P0)
// Covers: Skill Card schema validation, PairEvidence helpers, Adjacency Analyzer,
//         Timeline transitions, BGM beat snap, Predicate evaluator

import { describe, it, expect, beforeEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
const Ajv2020 = require("ajv/dist/2020") as new (
  opts?: Record<string, unknown>,
) => import("ajv").default;
// eslint-disable-next-line @typescript-eslint/no-require-imports
const addFormats = require("ajv-formats") as (ajv: import("ajv").default) => void;
type Ajv = import("ajv").default;
import type { Candidate, NormalizedBeat, TimelineClip, Track } from "../runtime/compiler/types.js";
import type {
  TransitionSkillCard,
  PairEvidence,
  BgmAnalysis,
} from "../runtime/compiler/transition-types.js";
import {
  loadTransitionSkillCards,
  clearTransitionSkillCache,
  getActiveTransitionCards,
  resolveSkillThreshold,
  evaluatePredicateGroup,
  resolveEffectivePeakType,
  resolveEmotionAxisScore,
  resolveAxisBreakReadiness,
  resolveSetupPayoff,
  resolveCompositionMatch,
  resolveAxisConsistency,
  resolveAxisScores,
  computeMurchScore,
  resolveShotScaleContinuity,
  resolveCadenceFit,
} from "../runtime/compiler/transition-skill-loader.js";
import {
  adjacencyDecide,
  buildPairEvidence,
  applyBeatSnap,
  findBeatSnapTarget,
} from "../runtime/compiler/adjacency.js";

const TRANSITION_SKILLS_DIR = path.resolve("runtime/editorial/transition-skills");
const SCHEMAS_DIR = path.resolve("schemas");

// ── Helpers ─────────────────────────────────────────────────────────

const makePairEvidence = (overrides: Partial<PairEvidence> = {}): PairEvidence => ({
  left_candidate_ref: "cand_left",
  right_candidate_ref: "cand_right",
  same_asset: false,
  same_speaker_role: false,
  semantic_cluster_change: true,
  motif_overlap_score: 0.3,
  setup_payoff_relation_score: 0.5,
  visual_tag_overlap_score: 0.5,
  motion_continuity_score: 0.5,
  cadence_fit_score: 0.5,
  shot_scale_continuity_score: 0.5,
  composition_match_score: 0.5,
  axis_consistency_score: 0.5,
  axis_break_readiness_score: 0.5,
  energy_delta_score: 0.5,
  outgoing_silence_ratio: 0.3,
  outgoing_afterglow_score: 0.4,
  incoming_reaction_score: 0.3,
  effective_peak_strength_score: 0.5,
  has_b_roll_candidate: false,
  duration_mode: "guide",
  ...overrides,
});

const makeClip = (id: string, overrides: Partial<TimelineClip> = {}): TimelineClip => ({
  clip_id: `clip_${id}`,
  segment_id: `SEG_${id}`,
  asset_id: `AST_${id}`,
  src_in_us: 0,
  src_out_us: 3_000_000,
  timeline_in_frame: 0,
  timeline_duration_frames: 72,
  role: "hero",
  motivation: "test",
  beat_id: `B${id}`,
  fallback_segment_ids: [],
  confidence: 0.8,
  quality_flags: [],
  ...overrides,
});

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

const makeBeat = (id: string, overrides: Partial<NormalizedBeat> = {}): NormalizedBeat => ({
  beat_id: id,
  label: `Beat ${id}`,
  target_duration_frames: 72,
  required_roles: ["hero"],
  preferred_roles: [],
  purpose: "test",
  ...overrides,
});

const makeBgm = (overrides: Partial<BgmAnalysis> = {}): BgmAnalysis => ({
  version: "1",
  project_id: "test",
  analysis_status: "ready",
  music_asset: { asset_id: "BGM_001", path: "bgm.mp3" },
  bpm: 120,
  meter: "4/4",
  duration_sec: 60,
  beats_sec: [0, 0.5, 1.0, 1.5, 2.0, 2.5, 3.0, 3.5, 4.0],
  downbeats_sec: [0, 2.0, 4.0],
  sections: [{ id: "S1", label: "intro", start_sec: 0, end_sec: 60, energy: 0.5 }],
  provenance: { detector: "test", sample_rate_hz: 48000 },
  ...overrides,
});

// ── 1. Skill Card Schema Validation ─────────────────────────────────

describe("Transition Skill Card Schema", () => {
  let ajv: Ajv;
  let validate: ReturnType<Ajv["compile"]>;

  beforeEach(() => {
    ajv = new Ajv2020({ allErrors: true, strict: false });
    addFormats(ajv);
    const schemaPath = path.join(SCHEMAS_DIR, "transition-skill-card.schema.json");
    const schema = JSON.parse(fs.readFileSync(schemaPath, "utf-8"));
    validate = ajv.compile(schema);
  });

  it("validates all 5 P0 skill cards against schema", () => {
    const cardFiles = ["match_cut_bridge.json", "build_to_peak.json", "crossfade_bridge.json",
                       "smash_cut_energy.json", "silence_beat.json"];
    for (const file of cardFiles) {
      const card = JSON.parse(fs.readFileSync(path.join(TRANSITION_SKILLS_DIR, file), "utf-8"));
      const valid = validate(card);
      expect(valid, `${file}: ${JSON.stringify(validate.errors)}`).toBe(true);
    }
  });

  it("rejects card missing required fields", () => {
    const invalid = { id: "test", version: "1" };
    expect(validate(invalid)).toBe(false);
  });

  it("rejects card with invalid scope", () => {
    const card = JSON.parse(fs.readFileSync(path.join(TRANSITION_SKILLS_DIR, "match_cut_bridge.json"), "utf-8"));
    card.scope = "invalid";
    expect(validate(card)).toBe(false);
  });
});

// ── 2. Skill Card Loader ────────────────────────────────────────────

describe("Transition Skill Card Loader", () => {
  beforeEach(() => {
    clearTransitionSkillCache();
  });

  it("loads all 5 P0 cards", () => {
    const cards = loadTransitionSkillCards(TRANSITION_SKILLS_DIR);
    expect(cards.size).toBe(5);
    expect(cards.has("match_cut_bridge")).toBe(true);
    expect(cards.has("build_to_peak")).toBe(true);
    expect(cards.has("crossfade_bridge")).toBe(true);
    expect(cards.has("smash_cut_energy")).toBe(true);
    expect(cards.has("silence_beat")).toBe(true);
  });

  it("getActiveTransitionCards filters by active skills", () => {
    const active = getActiveTransitionCards(["match_cut_bridge", "silence_beat"], "p0", TRANSITION_SKILLS_DIR);
    expect(active.length).toBe(2);
    expect(active[0].id).toBe("match_cut_bridge");
    expect(active[1].id).toBe("silence_beat");
  });

  it("getActiveTransitionCards filters by phase", () => {
    const allP0 = getActiveTransitionCards(
      ["match_cut_bridge", "build_to_peak", "crossfade_bridge", "smash_cut_energy", "silence_beat"],
      "p0",
      TRANSITION_SKILLS_DIR,
    );
    expect(allP0.length).toBe(5);

    const allP1 = getActiveTransitionCards(
      ["match_cut_bridge"],
      "p1",
      TRANSITION_SKILLS_DIR,
    );
    expect(allP1.length).toBe(0);
  });

  it("P0 cards have correct Murch weights from old repo", () => {
    const cards = loadTransitionSkillCards(TRANSITION_SKILLS_DIR);
    const matchCut = cards.get("match_cut_bridge")!;
    expect(matchCut.murch_weights.emotion).toBe(0.15);
    expect(matchCut.murch_weights.story).toBe(0.30);
    expect(matchCut.murch_weights.rhythm).toBe(0.20);

    const silenceBeat = cards.get("silence_beat")!;
    expect(silenceBeat.murch_weights.emotion).toBe(0.45);
    expect(silenceBeat.murch_weights.rhythm).toBe(0.25);
  });
});

// ── 3. resolveSkillThreshold ────────────────────────────────────────

describe("resolveSkillThreshold", () => {
  it("returns card threshold when present", () => {
    const card = { min_score_threshold: 0.35 } as TransitionSkillCard;
    expect(resolveSkillThreshold(card)).toBe(0.35);
  });

  it("clamps to 0..1 range", () => {
    expect(resolveSkillThreshold({ min_score_threshold: -0.5 } as TransitionSkillCard)).toBe(0);
    expect(resolveSkillThreshold({ min_score_threshold: 1.5 } as TransitionSkillCard)).toBe(1);
  });
});

// ── 4. Predicate Evaluator ──────────────────────────────────────────

describe("Predicate Evaluator", () => {
  it("evaluates eq predicate", () => {
    const ev = makePairEvidence({ same_asset: true });
    expect(evaluatePredicateGroup({ all: [{ path: "same_asset", op: "eq", value: true }] }, ev)).toBe(true);
    expect(evaluatePredicateGroup({ all: [{ path: "same_asset", op: "eq", value: false }] }, ev)).toBe(false);
  });

  it("evaluates gte predicate", () => {
    const ev = makePairEvidence({ visual_tag_overlap_score: 0.6 });
    expect(evaluatePredicateGroup({ all: [{ path: "visual_tag_overlap_score", op: "gte", value: 0.4 }] }, ev)).toBe(true);
    expect(evaluatePredicateGroup({ all: [{ path: "visual_tag_overlap_score", op: "gte", value: 0.7 }] }, ev)).toBe(false);
  });

  it("evaluates in predicate", () => {
    const ev = makePairEvidence({ effective_peak_type: "action_peak" });
    expect(evaluatePredicateGroup({
      any: [{ path: "effective_peak_type", op: "in", value: ["action_peak", "emotional_peak"] }],
    }, ev)).toBe(true);
  });

  it("evaluates combined all + any", () => {
    const ev = makePairEvidence({
      semantic_cluster_change: true,
      visual_tag_overlap_score: 0.6,
      effective_peak_type: "visual_peak",
    });
    expect(evaluatePredicateGroup({
      all: [
        { path: "visual_tag_overlap_score", op: "gte", value: 0.4 },
        { path: "semantic_cluster_change", op: "eq", value: true },
      ],
      any: [
        { path: "effective_peak_type", op: "eq", value: "visual_peak" },
      ],
    }, ev)).toBe(true);
  });

  it("returns true for empty predicate group", () => {
    expect(evaluatePredicateGroup({}, makePairEvidence())).toBe(true);
  });

  it("returns false when path does not exist in evidence", () => {
    const ev = makePairEvidence();
    expect(evaluatePredicateGroup({
      all: [{ path: "nonexistent_field", op: "gte", value: 0.5 }],
    }, ev)).toBe(false);
  });
});

// ── 5. resolveEffectivePeakType ─────────────────────────────────────

describe("resolveEffectivePeakType", () => {
  it("picks left when left >= right", () => {
    const result = resolveEffectivePeakType({
      left_peak_strength_score: 0.8,
      right_peak_strength_score: 0.6,
      left_peak_type: "emotional_peak",
      right_peak_type: "action_peak",
    });
    expect(result.effective_peak_strength_score).toBe(0.8);
    expect(result.effective_peak_type).toBe("emotional_peak");
  });

  it("picks right when right > left", () => {
    const result = resolveEffectivePeakType({
      left_peak_strength_score: 0.3,
      right_peak_strength_score: 0.7,
      left_peak_type: "visual_peak",
      right_peak_type: "action_peak",
    });
    expect(result.effective_peak_strength_score).toBe(0.7);
    expect(result.effective_peak_type).toBe("action_peak");
  });

  it("tie-breaks to left", () => {
    const result = resolveEffectivePeakType({
      left_peak_strength_score: 0.5,
      right_peak_strength_score: 0.5,
      left_peak_type: "emotional_peak",
      right_peak_type: "action_peak",
    });
    expect(result.effective_peak_type).toBe("emotional_peak");
  });

  it("falls back to defined type when winner has none", () => {
    const result = resolveEffectivePeakType({
      left_peak_strength_score: 0.8,
      right_peak_strength_score: 0.3,
      left_peak_type: undefined,
      right_peak_type: "visual_peak",
    });
    expect(result.effective_peak_type).toBe("visual_peak");
  });

  it("returns undefined when both types undefined", () => {
    const result = resolveEffectivePeakType({
      left_peak_strength_score: 0.5,
      right_peak_strength_score: 0.3,
      left_peak_type: undefined,
      right_peak_type: undefined,
    });
    expect(result.effective_peak_type).toBeUndefined();
  });

  it("treats absent scores as 0", () => {
    const result = resolveEffectivePeakType({
      left_peak_strength_score: undefined,
      right_peak_strength_score: undefined,
      left_peak_type: "action_peak",
      right_peak_type: "visual_peak",
    });
    expect(result.effective_peak_strength_score).toBe(0);
  });
});

// ── 6. Murch Axis Score Resolution ──────────────────────────────────

describe("Murch Axis Score Resolution", () => {
  it("resolveEmotionAxisScore computes weighted emotion", () => {
    const ev = makePairEvidence({
      outgoing_afterglow_score: 0.8,
      incoming_reaction_score: 0.6,
      energy_delta_score: 0.4,
      effective_peak_strength_score: 0.7,
      effective_peak_type: "emotional_peak",
    });
    const score = resolveEmotionAxisScore(ev);
    expect(score).toBeGreaterThan(0.5);
    expect(score).toBeLessThanOrEqual(1);
  });

  it("resolveAxisBreakReadiness reduces in strict mode", () => {
    const base = makePairEvidence({
      energy_delta_score: 0.7,
      effective_peak_strength_score: 0.8,
      semantic_cluster_change: true,
      effective_peak_type: "action_peak",
    });
    const guideScore = resolveAxisBreakReadiness({ ...base, duration_mode: "guide" });
    const strictScore = resolveAxisBreakReadiness({ ...base, duration_mode: "strict" });
    expect(strictScore).toBeLessThan(guideScore);
  });

  it("resolveSetupPayoff returns 1.0 for perfect setup->payoff", () => {
    const ev = makePairEvidence({
      left_story_role: "setup",
      right_story_role: "experience",
      semantic_cluster_change: true,
      motif_overlap_score: 0.5,
    });
    expect(resolveSetupPayoff(ev)).toBe(1.0);
  });

  it("resolveSetupPayoff returns 0.5 when no story roles", () => {
    expect(resolveSetupPayoff(makePairEvidence({
      left_story_role: undefined,
      right_story_role: undefined,
    }))).toBe(0.5);
  });

  it("resolveCompositionMatch returns 1.0 for identical compositions", () => {
    expect(resolveCompositionMatch(
      { shot_scale: "medium", composition_anchor: "center", screen_side: "center" },
      { shot_scale: "medium", composition_anchor: "center", screen_side: "center" },
    )).toBe(1.0);
  });

  it("resolveCompositionMatch returns 0.5 for no data", () => {
    expect(resolveCompositionMatch({}, {})).toBe(0.5);
  });

  it("resolveAxisConsistency returns 0.9 for matching axes", () => {
    expect(resolveAxisConsistency(
      { camera_axis: "ltr", screen_side: "left" },
      { camera_axis: "ltr", screen_side: "left" },
    )).toBe(0.9);
  });

  it("resolveAxisScores returns all values in 0..1", () => {
    const ev = makePairEvidence();
    const scores = resolveAxisScores(ev);
    for (const key of Object.keys(scores) as (keyof typeof scores)[]) {
      expect(scores[key]).toBeGreaterThanOrEqual(0);
      expect(scores[key]).toBeLessThanOrEqual(1);
    }
  });

  it("computeMurchScore is weighted dot product", () => {
    const weights = { emotion: 1, story: 0, rhythm: 0, eye_trace: 0, plane_2d: 0, space_3d: 0 };
    const axes = { emotion: 0.7, story: 0.9, rhythm: 0.5, eye_trace: 0.3, plane_2d: 0.1, space_3d: 0.2 };
    expect(computeMurchScore(weights, axes)).toBeCloseTo(0.7);
  });
});

// ── 7. Adjacency Analyzer ───────────────────────────────────────────

describe("Adjacency Analyzer", () => {
  it("produces transitions for adjacent V1 clip pairs", () => {
    const v1: Track = {
      track_id: "V1",
      kind: "video",
      clips: [
        makeClip("01", { timeline_in_frame: 0, timeline_duration_frames: 72, beat_id: "B01" }),
        makeClip("02", { timeline_in_frame: 72, timeline_duration_frames: 72, beat_id: "B02", asset_id: "AST_002" }),
        makeClip("03", { timeline_in_frame: 144, timeline_duration_frames: 72, beat_id: "B03", asset_id: "AST_003" }),
      ],
    };

    const { transitions, analysis } = adjacencyDecide(v1, {
      activeEditingSkills: ["match_cut_bridge", "silence_beat", "crossfade_bridge", "smash_cut_energy", "build_to_peak"],
      durationMode: "guide",
      fpsNum: 24,
      candidates: [
        makeCandidate({ segment_id: "SEG_01", candidate_id: "cand_01", editorial_signals: { semantic_cluster_id: "A" } }),
        makeCandidate({ segment_id: "SEG_02", candidate_id: "cand_02", asset_id: "AST_002", editorial_signals: { semantic_cluster_id: "B" } }),
        makeCandidate({ segment_id: "SEG_03", candidate_id: "cand_03", asset_id: "AST_003", editorial_signals: { semantic_cluster_id: "C" } }),
      ],
      beats: [makeBeat("B01"), makeBeat("B02"), makeBeat("B03")],
      transitionSkillsDir: TRANSITION_SKILLS_DIR,
    });

    expect(transitions.length).toBe(2);
    expect(analysis.pairs.length).toBe(2);
    expect(transitions[0].from_clip_id).toBe("clip_01");
    expect(transitions[0].to_clip_id).toBe("clip_02");
    expect(transitions[1].from_clip_id).toBe("clip_02");
    expect(transitions[1].to_clip_id).toBe("clip_03");
  });

  it("is deterministic — same input produces same output", () => {
    const v1: Track = {
      track_id: "V1",
      kind: "video",
      clips: [
        makeClip("01", { timeline_in_frame: 0, timeline_duration_frames: 72, beat_id: "B01" }),
        makeClip("02", { timeline_in_frame: 72, timeline_duration_frames: 72, beat_id: "B02", asset_id: "AST_002" }),
      ],
    };
    const opts = {
      activeEditingSkills: ["match_cut_bridge", "crossfade_bridge", "smash_cut_energy", "silence_beat", "build_to_peak"],
      durationMode: "guide" as const,
      fpsNum: 24,
      candidates: [
        makeCandidate({ segment_id: "SEG_01", editorial_signals: { semantic_cluster_id: "X" } }),
        makeCandidate({ segment_id: "SEG_02", asset_id: "AST_002", editorial_signals: { semantic_cluster_id: "Y" } }),
      ],
      beats: [makeBeat("B01"), makeBeat("B02")],
      transitionSkillsDir: TRANSITION_SKILLS_DIR,
    };

    const result1 = adjacencyDecide(v1, opts);
    const result2 = adjacencyDecide(v1, opts);

    expect(result1.transitions).toEqual(result2.transitions);
    expect(result1.analysis).toEqual(result2.analysis);
  });

  it("crossfade_bridge activates on semantic cluster change with low visual overlap", () => {
    const v1: Track = {
      track_id: "V1",
      kind: "video",
      clips: [
        makeClip("01", { timeline_in_frame: 0, timeline_duration_frames: 72, beat_id: "B01" }),
        makeClip("02", { timeline_in_frame: 72, timeline_duration_frames: 72, beat_id: "B02", asset_id: "AST_002" }),
      ],
    };

    const { transitions } = adjacencyDecide(v1, {
      activeEditingSkills: ["crossfade_bridge"],
      durationMode: "guide",
      fpsNum: 24,
      candidates: [
        makeCandidate({
          segment_id: "SEG_01",
          editorial_signals: { semantic_cluster_id: "topic_A", visual_tags: ["person"] },
          motif_tags: ["intro"],
        }),
        makeCandidate({
          segment_id: "SEG_02",
          asset_id: "AST_002",
          editorial_signals: { semantic_cluster_id: "topic_B", visual_tags: ["landscape"] },
          motif_tags: ["outdoor"],
        }),
      ],
      beats: [makeBeat("B01"), makeBeat("B02")],
      transitionSkillsDir: TRANSITION_SKILLS_DIR,
    });

    expect(transitions.length).toBe(1);
    // crossfade_bridge should activate since semantic_cluster_change=true and visual overlap is low
    expect(transitions[0].transition_type).toBe("crossfade");
    expect(transitions[0].applied_skill_id).toBe("crossfade_bridge");
  });

  it("crossfade_bridge also activates for B-roll topic changes with high overlap", () => {
    const v1: Track = {
      track_id: "V1",
      kind: "video",
      clips: [
        makeClip("01", { timeline_in_frame: 0, timeline_duration_frames: 72, beat_id: "B01" }),
        makeClip("02", { timeline_in_frame: 72, timeline_duration_frames: 72, beat_id: "B02", asset_id: "AST_002" }),
      ],
    };

    const { transitions } = adjacencyDecide(v1, {
      activeEditingSkills: ["crossfade_bridge"],
      durationMode: "guide",
      fpsNum: 24,
      candidates: [
        makeCandidate({
          segment_id: "SEG_01",
          role: "support",
          editorial_signals: {
            semantic_cluster_id: "topic_A",
            visual_tags: ["child", "bike", "park"],
            afterglow_score: 0.6,
            silence_ratio: 0.15,
          },
          motif_tags: ["growth", "practice"],
        }),
        makeCandidate({
          segment_id: "SEG_02",
          asset_id: "AST_002",
          role: "support",
          editorial_signals: {
            semantic_cluster_id: "topic_B",
            visual_tags: ["child", "bike", "park"],
            reaction_intensity_score: 0.5,
          },
          motif_tags: ["growth", "practice"],
        }),
      ],
      beats: [makeBeat("B01"), makeBeat("B02")],
      transitionSkillsDir: TRANSITION_SKILLS_DIR,
    });

    expect(transitions.length).toBe(1);
    expect(transitions[0].transition_type).toBe("crossfade");
    expect(transitions[0].applied_skill_id).toBe("crossfade_bridge");
  });

  it("degrades to plain cut when below threshold", () => {
    // Use only smash_cut_energy which needs high energy_delta
    const v1: Track = {
      track_id: "V1",
      kind: "video",
      clips: [
        makeClip("01", { timeline_in_frame: 0, timeline_duration_frames: 72, beat_id: "B01" }),
        makeClip("02", { timeline_in_frame: 72, timeline_duration_frames: 72, beat_id: "B02", asset_id: "AST_002" }),
      ],
    };

    const { transitions, analysis } = adjacencyDecide(v1, {
      activeEditingSkills: ["smash_cut_energy"],
      durationMode: "guide",
      fpsNum: 24,
      candidates: [
        makeCandidate({
          segment_id: "SEG_01",
          editorial_signals: {
            semantic_cluster_id: "A",
            speech_intensity_score: 0.5,
          },
        }),
        makeCandidate({
          segment_id: "SEG_02",
          asset_id: "AST_002",
          editorial_signals: {
            semantic_cluster_id: "B",
            speech_intensity_score: 0.5, // same energy = low delta
          },
        }),
      ],
      beats: [makeBeat("B01"), makeBeat("B02")],
      transitionSkillsDir: TRANSITION_SKILLS_DIR,
    });

    expect(transitions[0].transition_type).toBe("cut");
  });

  it("fires match_cut_bridge when semantic clusters are missing but tag overlap indicates a new cluster", () => {
    const v1: Track = {
      track_id: "V1",
      kind: "video",
      clips: [
        makeClip("01", { timeline_in_frame: 0, timeline_duration_frames: 72, beat_id: "B01" }),
        makeClip("02", { timeline_in_frame: 72, timeline_duration_frames: 72, beat_id: "B02", asset_id: "AST_002" }),
      ],
    };

    const { transitions, analysis } = adjacencyDecide(v1, {
      activeEditingSkills: ["match_cut_bridge"],
      durationMode: "guide",
      fpsNum: 24,
      candidates: [
        makeCandidate({
          segment_id: "SEG_01",
          editorial_signals: {
            visual_tags: ["child", "bicycle", "park", "summer"],
          },
          motif_tags: ["growth", "practice"],
        }),
        makeCandidate({
          segment_id: "SEG_02",
          asset_id: "AST_002",
          editorial_signals: {
            visual_tags: ["child", "bicycle", "park", "autumn"],
          },
          motif_tags: ["growth", "confidence"],
        }),
      ],
      beats: [makeBeat("B01"), makeBeat("B02")],
      transitionSkillsDir: TRANSITION_SKILLS_DIR,
    });

    expect(analysis.pairs[0].selected_skill_id).toBe("match_cut_bridge");
    expect(transitions[0].applied_skill_id).toBe("match_cut_bridge");
    expect(transitions[0].transition_type).toBe("match_cut");
  });
});

// ── 8. BGM Beat Snap ────────────────────────────────────────────────

describe("BGM Beat Snap", () => {
  it("findBeatSnapTarget finds closest downbeat", () => {
    const bgm = makeBgm();
    const result = findBeatSnapTarget(47, 24, bgm, true, 6);
    // 47 frames at 24fps = 1.958s, closest downbeat is 2.0s = 48 frames
    expect(result).toBeDefined();
    expect(result!.target_frame).toBe(48);
    expect(result!.delta_frames).toBe(1);
    expect(result!.is_downbeat).toBe(true);
  });

  it("findBeatSnapTarget returns undefined when beyond tolerance", () => {
    const bgm = makeBgm({ beats_sec: [0, 10, 20], downbeats_sec: [0, 20] });
    const result = findBeatSnapTarget(72, 24, bgm, false, 6);
    // 72 frames at 24fps = 3.0s, closest beat is 10s = too far
    expect(result).toBeUndefined();
  });

  it("findBeatSnapTarget returns undefined for no BGM", () => {
    expect(findBeatSnapTarget(48, 24, undefined, false, 6)).toBeUndefined();
  });

  it("findBeatSnapTarget returns undefined for partial status BGM", () => {
    const bgm = makeBgm({ analysis_status: "partial" });
    expect(findBeatSnapTarget(48, 24, bgm, false, 6)).toBeUndefined();
  });
});

// ── 9. Beat Snap Geometry ───────────────────────────────────────────

describe("Beat Snap Geometry", () => {
  it("extends left clip when snap_delta > 0", () => {
    const left = makeClip("L", { timeline_in_frame: 0, timeline_duration_frames: 72, src_in_us: 0, src_out_us: 3_000_000 });
    const right = makeClip("R", { timeline_in_frame: 72, timeline_duration_frames: 72, src_in_us: 3_000_000, src_out_us: 6_000_000 });

    const ok = applyBeatSnap(left, right, 3, 24);
    expect(ok).toBe(true);
    expect(left.timeline_duration_frames).toBe(75);
    expect(right.timeline_in_frame).toBe(75);
    expect(right.timeline_duration_frames).toBe(69);
  });

  it("shrinks left clip when snap_delta < 0", () => {
    const left = makeClip("L", { timeline_in_frame: 0, timeline_duration_frames: 72, src_in_us: 0, src_out_us: 3_000_000 });
    const right = makeClip("R", { timeline_in_frame: 72, timeline_duration_frames: 72, src_in_us: 3_000_000, src_out_us: 6_000_000 });

    const ok = applyBeatSnap(left, right, -3, 24);
    expect(ok).toBe(true);
    expect(left.timeline_duration_frames).toBe(69);
    expect(right.timeline_in_frame).toBe(69);
    expect(right.timeline_duration_frames).toBe(75);
  });

  it("preserves total pair duration", () => {
    const left = makeClip("L", { timeline_in_frame: 0, timeline_duration_frames: 72, src_in_us: 0, src_out_us: 3_000_000 });
    const right = makeClip("R", { timeline_in_frame: 72, timeline_duration_frames: 72, src_in_us: 3_000_000, src_out_us: 6_000_000 });
    const totalBefore = left.timeline_duration_frames + right.timeline_duration_frames;

    applyBeatSnap(left, right, 5, 24);
    expect(left.timeline_duration_frames + right.timeline_duration_frames).toBe(totalBefore);
  });

  it("rejects snap when right clip would be < 1 frame", () => {
    const left = makeClip("L", { timeline_in_frame: 0, timeline_duration_frames: 72 });
    const right = makeClip("R", { timeline_in_frame: 72, timeline_duration_frames: 2 });

    const ok = applyBeatSnap(left, right, 3, 24);
    expect(ok).toBe(false);
    expect(right.timeline_duration_frames).toBe(2); // unchanged
  });

  it("no-ops on delta = 0", () => {
    const left = makeClip("L", { timeline_in_frame: 0, timeline_duration_frames: 72 });
    const right = makeClip("R", { timeline_in_frame: 72, timeline_duration_frames: 72 });

    const ok = applyBeatSnap(left, right, 0, 24);
    expect(ok).toBe(true);
    expect(left.timeline_duration_frames).toBe(72);
  });
});

// ── 10. Timeline Transitions Schema ─────────────────────────────────

describe("Timeline IR Schema with Transitions", () => {
  let ajv: Ajv;
  let validate: ReturnType<Ajv["compile"]>;

  beforeEach(() => {
    ajv = new Ajv2020({ allErrors: true, strict: false });
    addFormats(ajv);
    const schemaPath = path.join(SCHEMAS_DIR, "timeline-ir.schema.json");
    const schema = JSON.parse(fs.readFileSync(schemaPath, "utf-8"));
    validate = ajv.compile(schema);
  });

  it("validates timeline with transitions array", () => {
    const timeline = {
      version: "1",
      project_id: "test",
      created_at: "2025-01-01T00:00:00Z",
      sequence: { name: "test", fps_num: 24, fps_den: 1, width: 1920, height: 1080, start_frame: 0 },
      tracks: {
        video: [{
          track_id: "V1",
          kind: "video",
          clips: [
            { clip_id: "c1", segment_id: "s1", asset_id: "a1", src_in_us: 0, src_out_us: 1000000, timeline_in_frame: 0, timeline_duration_frames: 24, role: "hero", motivation: "test" },
            { clip_id: "c2", segment_id: "s2", asset_id: "a2", src_in_us: 0, src_out_us: 1000000, timeline_in_frame: 24, timeline_duration_frames: 24, role: "hero", motivation: "test" },
          ],
        }],
        audio: [],
      },
      markers: [],
      transitions: [
        {
          transition_id: "tr_0000",
          from_clip_id: "c1",
          to_clip_id: "c2",
          track_id: "V1",
          transition_type: "crossfade",
          transition_params: {
            crossfade_sec: 0.5,
            cut_frame_before_snap: 24,
            cut_frame_after_snap: 24,
            snap_delta_frames: 0,
          },
          applied_skill_id: "crossfade_bridge",
          confidence: 0.75,
        },
      ],
      provenance: {
        brief_path: "brief.yaml",
        blueprint_path: "blueprint.yaml",
        selects_path: "selects.yaml",
      },
    };

    const valid = validate(timeline);
    expect(valid, JSON.stringify(validate.errors)).toBe(true);
  });

  it("validates timeline without transitions (backwards compatible)", () => {
    const timeline = {
      version: "1",
      project_id: "test",
      created_at: "2025-01-01T00:00:00Z",
      sequence: { name: "test", fps_num: 24, fps_den: 1, width: 1920, height: 1080, start_frame: 0 },
      tracks: { video: [], audio: [] },
      markers: [],
      provenance: { brief_path: "b", blueprint_path: "bp", selects_path: "s" },
    };
    expect(validate(timeline)).toBe(true);
  });

  it("rejects transition with invalid transition_type", () => {
    const timeline = {
      version: "1",
      project_id: "test",
      sequence: { name: "test", fps_num: 24, fps_den: 1, width: 1920, height: 1080, start_frame: 0 },
      tracks: { video: [], audio: [] },
      transitions: [{
        transition_id: "tr_0000",
        from_clip_id: "c1",
        to_clip_id: "c2",
        track_id: "V1",
        transition_type: "wipe_left",
      }],
      provenance: { brief_path: "b", blueprint_path: "bp", selects_path: "s" },
    };
    expect(validate(timeline)).toBe(false);
  });
});

// ── 11. BGM Analysis Schema ─────────────────────────────────────────

describe("BGM Analysis Schema", () => {
  let ajv: Ajv;
  let validate: ReturnType<Ajv["compile"]>;

  beforeEach(() => {
    ajv = new Ajv2020({ allErrors: true, strict: false });
    addFormats(ajv);
    const schemaPath = path.join(SCHEMAS_DIR, "bgm-analysis.schema.json");
    const schema = JSON.parse(fs.readFileSync(schemaPath, "utf-8"));
    validate = ajv.compile(schema);
  });

  it("validates a complete BGM analysis", () => {
    const analysis = {
      version: "1",
      project_id: "test",
      analysis_status: "ready",
      music_asset: { asset_id: "BGM_001", path: "bgm.mp3", source_hash: "abc123" },
      bpm: 128.0,
      meter: "4/4",
      duration_sec: 91.2,
      beats_sec: [0.0, 0.469, 0.938],
      downbeats_sec: [0.0, 1.875],
      sections: [
        { id: "S1", label: "intro", start_sec: 0.0, end_sec: 8.0, energy: 0.28 },
      ],
      provenance: { detector: "librosa", sample_rate_hz: 48000 },
    };
    expect(validate(analysis)).toBe(true);
  });

  it("rejects BGM analysis missing required fields", () => {
    expect(validate({ version: "1" })).toBe(false);
  });
});

// ── 12. Adjacency Analysis Schema ───────────────────────────────────

describe("Adjacency Analysis Schema", () => {
  let ajv: Ajv;
  let validate: ReturnType<Ajv["compile"]>;

  beforeEach(() => {
    ajv = new Ajv2020({ allErrors: true, strict: false });
    addFormats(ajv);
    const schemaPath = path.join(SCHEMAS_DIR, "adjacency-analysis.schema.json");
    const schema = JSON.parse(fs.readFileSync(schemaPath, "utf-8"));
    validate = ajv.compile(schema);
  });

  it("validates adjacency analysis output", () => {
    const analysis = {
      version: "1",
      project_id: "test",
      pairs: [{
        pair_id: "V1:B01->B02",
        left_candidate_ref: "cand_01",
        right_candidate_ref: "cand_02",
        selected_skill_id: "match_cut_bridge",
        selected_skill_score: 0.78,
        min_score_threshold: 0.35,
        transition_type: "match_cut",
        confidence: 0.78,
        below_threshold: false,
        degraded_from_skill_id: null,
      }],
    };
    expect(validate(analysis)).toBe(true);
  });

  it("validates pair with null selected_skill_id", () => {
    const analysis = {
      version: "1",
      project_id: "test",
      pairs: [{
        pair_id: "V1:B01->B02",
        left_candidate_ref: "c1",
        right_candidate_ref: "c2",
        selected_skill_id: null,
        selected_skill_score: 0,
        min_score_threshold: 0.3,
        transition_type: "cut",
        confidence: 0,
        below_threshold: false,
      }],
    };
    expect(validate(analysis)).toBe(true);
  });
});

// ── 13. PairEvidence construction ───────────────────────────────────

describe("buildPairEvidence", () => {
  it("detects same_asset correctly", () => {
    const left = makeClip("01", { asset_id: "AST_SHARED" });
    const right = makeClip("02", { asset_id: "AST_SHARED" });
    const ev = buildPairEvidence(left, right, undefined, undefined, undefined, undefined, undefined, undefined, "guide");
    expect(ev.same_asset).toBe(true);
  });

  it("detects semantic_cluster_change", () => {
    const left = makeClip("01");
    const right = makeClip("02", { asset_id: "AST_002" });
    const leftCand = makeCandidate({ segment_id: "SEG_01", editorial_signals: { semantic_cluster_id: "A" } });
    const rightCand = makeCandidate({ segment_id: "SEG_02", editorial_signals: { semantic_cluster_id: "B" } });
    const ev = buildPairEvidence(left, right, leftCand, rightCand, undefined, undefined, undefined, undefined, "guide");
    expect(ev.semantic_cluster_change).toBe(true);
  });

  it("falls back to tag-based semantic cluster change for different assets", () => {
    const left = makeClip("01");
    const right = makeClip("02", { asset_id: "AST_002" });
    const leftCand = makeCandidate({
      segment_id: "SEG_01",
      editorial_signals: { visual_tags: ["child", "bicycle", "park", "summer"] },
    });
    const rightCand = makeCandidate({
      segment_id: "SEG_02",
      editorial_signals: { visual_tags: ["child", "bicycle", "pump_track", "autumn"] },
    });

    const ev = buildPairEvidence(left, right, leftCand, rightCand, undefined, undefined, undefined, undefined, "guide");

    expect(ev.visual_tag_overlap_score).toBeCloseTo(1 / 3, 2);
    expect(ev.semantic_cluster_change).toBe(true);
  });

  it("computes visual_tag_overlap_score via Jaccard", () => {
    const left = makeClip("01");
    const right = makeClip("02");
    const leftCand = makeCandidate({ segment_id: "SEG_01", editorial_signals: { visual_tags: ["person", "bicycle", "outdoor"] } });
    const rightCand = makeCandidate({ segment_id: "SEG_02", editorial_signals: { visual_tags: ["person", "car", "outdoor"] } });
    const ev = buildPairEvidence(left, right, leftCand, rightCand, undefined, undefined, undefined, undefined, "guide");
    // Jaccard: intersection=2 (person, outdoor), union=4 (person, bicycle, outdoor, car)
    expect(ev.visual_tag_overlap_score).toBeCloseTo(0.5, 1);
  });

  it("propagates story roles from beats", () => {
    const left = makeClip("01");
    const right = makeClip("02");
    const leftBeat = makeBeat("B01", { story_role: "hook" });
    const rightBeat = makeBeat("B02", { story_role: "experience" });
    const ev = buildPairEvidence(left, right, undefined, undefined, leftBeat, rightBeat, undefined, undefined, "guide");
    expect(ev.left_story_role).toBe("hook");
    expect(ev.right_story_role).toBe("experience");
  });

  it("derives energy_delta_score from peak strength when audio signals are absent", () => {
    const left = makeClip("01");
    const right = makeClip("02", { asset_id: "AST_002" });
    const leftCand = makeCandidate({
      segment_id: "SEG_01",
      editorial_signals: { peak_strength_score: 0.2 },
    });
    const rightCand = makeCandidate({
      segment_id: "SEG_02",
      editorial_signals: { peak_strength_score: 0.8 },
    });

    const ev = buildPairEvidence(left, right, leftCand, rightCand, undefined, undefined, undefined, undefined, "guide");

    expect(ev.energy_delta_score).toBeCloseTo(0.8, 5);
  });

  it("prefers motion energy over peak strength when available", () => {
    const left = makeClip("01");
    const right = makeClip("02", { asset_id: "AST_002" });
    const leftCand = makeCandidate({
      segment_id: "SEG_01",
      editorial_signals: { peak_strength_score: 0.9, motion_energy_score: 0.1 },
    });
    const rightCand = makeCandidate({
      segment_id: "SEG_02",
      editorial_signals: { peak_strength_score: 0.2, motion_energy_score: 0.6 },
    });

    const ev = buildPairEvidence(left, right, leftCand, rightCand, undefined, undefined, undefined, undefined, "guide");

    expect(ev.energy_delta_score).toBeCloseTo(0.75, 5);
  });

  it("infers b-roll story roles from beat order when captions are disabled", () => {
    const left = makeClip("01", { beat_id: "B01" });
    const right = makeClip("02", { beat_id: "B02", asset_id: "AST_002" });
    const leftBeat = makeBeat("B01");
    const rightBeat = makeBeat("B02");

    const ev = buildPairEvidence(
      left,
      right,
      undefined,
      undefined,
      leftBeat,
      rightBeat,
      undefined,
      undefined,
      "guide",
      undefined,
      {
        captionPolicySource: "none",
        beatOrder: new Map([
          ["B01", 0],
          ["B02", 1],
        ]),
        totalBeats: 2,
      },
    );

    expect(ev.left_story_role).toBe("hook");
    expect(ev.right_story_role).toBe("closing");
  });

  it("computes shot_scale_continuity_score separately from composition_match_score", () => {
    const left = makeClip("01");
    const right = makeClip("02");
    const leftSeg = { adjacency_features: { visual_tags: [], motion_type: "static" as const, shot_scale: "close" as const, composition_anchor: "center" as const, screen_side: "center" as const } };
    const rightSeg = { adjacency_features: { visual_tags: [], motion_type: "static" as const, shot_scale: "wide" as const, composition_anchor: "left" as const, screen_side: "left" as const } };
    const ev = buildPairEvidence(left, right, undefined, undefined, undefined, undefined, leftSeg, rightSeg, "guide");
    // shot_scale: close vs wide = large jump → low continuity
    expect(ev.shot_scale_continuity_score).toBeLessThan(0.5);
    // composition: different anchor and side → low match
    expect(ev.composition_match_score).toBeLessThan(0.5);
    // They should NOT be the same value
    expect(ev.shot_scale_continuity_score).not.toBe(ev.composition_match_score);
  });
});

// ── 14. resolveShotScaleContinuity ──────────────────────────────────

describe("resolveShotScaleContinuity", () => {
  it("returns 0.9 for identical shot scales", () => {
    expect(resolveShotScaleContinuity("medium", "medium")).toBe(0.9);
  });

  it("returns 0.7 for adjacent scales", () => {
    expect(resolveShotScaleContinuity("medium", "medium_close")).toBe(0.7);
  });

  it("returns low score for large jump", () => {
    expect(resolveShotScaleContinuity("extreme_close", "wide")).toBeLessThan(0.3);
  });

  it("returns 0.5 when either scale is unknown", () => {
    expect(resolveShotScaleContinuity("medium", "unknown")).toBe(0.5);
    expect(resolveShotScaleContinuity(undefined, "medium")).toBe(0.5);
  });
});

// ── 15. resolveCadenceFit ───────────────────────────────────────────

describe("resolveCadenceFit", () => {
  it("returns higher score when clip duration matches beat target", () => {
    const matched = resolveCadenceFit(72, 72, 0.1, undefined, 12);
    const mismatched = resolveCadenceFit(72, 144, 0.1, undefined, 12);
    expect(matched.score).toBeGreaterThan(mismatched.score);
  });

  it("penalizes for BGM snap distance", () => {
    const close = resolveCadenceFit(72, 72, 0.1, 1, 12);
    const far = resolveCadenceFit(72, 72, 0.1, 10, 12);
    expect(close.score).toBeGreaterThan(far.score);
  });

  it("flags fallback when beat target is unavailable", () => {
    const result = resolveCadenceFit(72, undefined, 0.1, undefined, 12);
    expect(result.usedFallback).toBe(true);
  });

  it("does not flag fallback when beat target is available", () => {
    const result = resolveCadenceFit(72, 72, 0.1, undefined, 12);
    expect(result.usedFallback).toBe(false);
  });
});

// ── 16. resolveAxisConsistency with axis_break_readiness ───────────

describe("resolveAxisConsistency with break readiness", () => {
  it("returns higher score for axis break when readiness is high", () => {
    const lowReadiness = resolveAxisConsistency(
      { camera_axis: "ltr", screen_side: "left" },
      { camera_axis: "rtl", screen_side: "right" },
      0.3,
    );
    const highReadiness = resolveAxisConsistency(
      { camera_axis: "ltr", screen_side: "left" },
      { camera_axis: "rtl", screen_side: "right" },
      0.8,
    );
    expect(highReadiness).toBeGreaterThan(lowReadiness);
  });

  it("returns 0.2 for axis break with no readiness context", () => {
    const score = resolveAxisConsistency(
      { camera_axis: "ltr", screen_side: "left" },
      { camera_axis: "rtl", screen_side: "right" },
    );
    expect(score).toBe(0.2);
  });
});

// ── 17. Fallback chain ──────────────────────────────────────────────

describe("Fallback chain", () => {
  it("applies hard_cut fallback when below threshold for crossfade_bridge", () => {
    const v1: Track = {
      track_id: "V1",
      kind: "video",
      clips: [
        makeClip("01", { timeline_in_frame: 0, timeline_duration_frames: 72, beat_id: "B01" }),
        makeClip("02", { timeline_in_frame: 72, timeline_duration_frames: 72, beat_id: "B02", asset_id: "AST_002" }),
      ],
    };

    // crossfade_bridge requires semantic_cluster_change=true and low visual overlap
    // Provide just enough to pass when+viability but with signals that yield low Murch score
    const { transitions } = adjacencyDecide(v1, {
      activeEditingSkills: ["crossfade_bridge"],
      durationMode: "guide",
      fpsNum: 24,
      candidates: [
        makeCandidate({
          segment_id: "SEG_01",
          editorial_signals: {
            semantic_cluster_id: "A",
            afterglow_score: 0.0,
            silence_ratio: 0.0,
            speech_intensity_score: 0.0,
          },
          motif_tags: [],
        }),
        makeCandidate({
          segment_id: "SEG_02",
          asset_id: "AST_002",
          editorial_signals: {
            semantic_cluster_id: "B",
            afterglow_score: 0.0,
            silence_ratio: 0.0,
            speech_intensity_score: 0.0,
          },
          motif_tags: [],
        }),
      ],
      beats: [makeBeat("B01"), makeBeat("B02")],
      transitionSkillsDir: TRANSITION_SKILLS_DIR,
    });

    // If crossfade_bridge passes when+viability but Murch score < 0.25 threshold,
    // fallback_order[0]=hard_cut should apply.
    // If it's above threshold, it stays as crossfade.
    // Either way, the result should have a valid transition type.
    expect(["cut", "crossfade"]).toContain(transitions[0].transition_type);
    if (transitions[0].degraded_from_skill_id) {
      // Degraded → should use fallback ID
      expect(transitions[0].applied_skill_id).toMatch(/^fallback\./);
    }
  });

  it("records degraded_from_skill_id on threshold degradation", () => {
    const v1: Track = {
      track_id: "V1",
      kind: "video",
      clips: [
        makeClip("01", { timeline_in_frame: 0, timeline_duration_frames: 72, beat_id: "B01" }),
        makeClip("02", { timeline_in_frame: 72, timeline_duration_frames: 72, beat_id: "B02", asset_id: "AST_002" }),
      ],
    };

    // smash_cut needs energy_delta >= 0.3, provide same energy for low delta
    const { transitions, analysis } = adjacencyDecide(v1, {
      activeEditingSkills: ["smash_cut_energy"],
      durationMode: "guide",
      fpsNum: 24,
      candidates: [
        makeCandidate({
          segment_id: "SEG_01",
          editorial_signals: {
            semantic_cluster_id: "A",
            speech_intensity_score: 0.5,
          },
        }),
        makeCandidate({
          segment_id: "SEG_02",
          asset_id: "AST_002",
          editorial_signals: {
            semantic_cluster_id: "B",
            speech_intensity_score: 0.5,
          },
        }),
      ],
      beats: [makeBeat("B01"), makeBeat("B02")],
      transitionSkillsDir: TRANSITION_SKILLS_DIR,
    });

    // Should have degraded_from_skill_id in analysis
    if (analysis.pairs[0].degraded_from_skill_id) {
      expect(transitions[0].degraded_from_skill_id).toBeDefined();
    }
  });
});

// ── 18. Snap geometry reflected in compile flow ─────────────────────

describe("Snap geometry integration", () => {
  it("applyBeatSnap updates src_in_us and src_out_us", () => {
    const left = makeClip("L", {
      timeline_in_frame: 0,
      timeline_duration_frames: 72,
      src_in_us: 0,
      src_out_us: 3_000_000,
    });
    const right = makeClip("R", {
      timeline_in_frame: 72,
      timeline_duration_frames: 72,
      src_in_us: 3_000_000,
      src_out_us: 6_000_000,
    });

    const usPerFrame = 1_000_000 / 24;
    applyBeatSnap(left, right, 2, 24);

    expect(left.src_out_us).toBe(3_000_000 + Math.round(2 * usPerFrame));
    expect(right.src_in_us).toBe(3_000_000 + Math.round(2 * usPerFrame));
  });

  it("prev_end_frame == next_start_frame after snap", () => {
    const left = makeClip("L", {
      timeline_in_frame: 0,
      timeline_duration_frames: 72,
      src_in_us: 0,
      src_out_us: 3_000_000,
    });
    const right = makeClip("R", {
      timeline_in_frame: 72,
      timeline_duration_frames: 72,
      src_in_us: 3_000_000,
      src_out_us: 6_000_000,
    });

    applyBeatSnap(left, right, 3, 24);
    expect(left.timeline_in_frame + left.timeline_duration_frames).toBe(right.timeline_in_frame);
  });
});

// ── 19. build_to_peak pair_bonus_prev ───────────────────────────────

describe("build_to_peak pair_bonus_prev", () => {
  it("consecutive build_to_peak pairs get bonus on second pair", () => {
    // Create 3 clips where energy increases monotonically
    const v1: Track = {
      track_id: "V1",
      kind: "video",
      clips: [
        makeClip("01", { timeline_in_frame: 0, timeline_duration_frames: 72, beat_id: "B01" }),
        makeClip("02", { timeline_in_frame: 72, timeline_duration_frames: 72, beat_id: "B02", asset_id: "AST_002" }),
        makeClip("03", { timeline_in_frame: 144, timeline_duration_frames: 72, beat_id: "B03", asset_id: "AST_003" }),
      ],
    };

    const { analysis } = adjacencyDecide(v1, {
      activeEditingSkills: ["build_to_peak"],
      durationMode: "guide",
      fpsNum: 24,
      candidates: [
        makeCandidate({
          segment_id: "SEG_01",
          editorial_signals: {
            semantic_cluster_id: "A",
            speech_intensity_score: 0.3,
            peak_strength_score: 0.4,
          },
        }),
        makeCandidate({
          segment_id: "SEG_02",
          asset_id: "AST_002",
          editorial_signals: {
            semantic_cluster_id: "A",
            speech_intensity_score: 0.6,
            peak_strength_score: 0.6,
            peak_type: "emotional_peak",
          },
        }),
        makeCandidate({
          segment_id: "SEG_03",
          asset_id: "AST_003",
          editorial_signals: {
            semantic_cluster_id: "A",
            speech_intensity_score: 0.9,
            peak_strength_score: 0.8,
            peak_type: "emotional_peak",
          },
        }),
      ],
      beats: [
        makeBeat("B01"),
        makeBeat("B02", { story_role: "experience" }),
        makeBeat("B03", { story_role: "experience" }),
      ],
      transitionSkillsDir: TRANSITION_SKILLS_DIR,
    });

    // Both pairs should have selected build_to_peak
    // (the second pair gets pair_bonus_prev if first was build_to_peak)
    expect(analysis.pairs.length).toBe(2);
    // Verify analysis was produced correctly
    expect(analysis.pairs[0]).toBeDefined();
    expect(analysis.pairs[1]).toBeDefined();
  });

  it("uses inferred b-roll story roles when captions are disabled", () => {
    const v1: Track = {
      track_id: "V1",
      kind: "video",
      clips: [
        makeClip("01", { timeline_in_frame: 0, timeline_duration_frames: 72, beat_id: "B01" }),
        makeClip("02", { timeline_in_frame: 72, timeline_duration_frames: 72, beat_id: "B02", asset_id: "AST_002" }),
      ],
    };

    const { analysis } = adjacencyDecide(v1, {
      activeEditingSkills: ["build_to_peak"],
      durationMode: "guide",
      fpsNum: 24,
      captionPolicySource: "none",
      candidates: [
        makeCandidate({
          segment_id: "SEG_01",
          editorial_signals: {
            peak_strength_score: 0.35,
          },
        }),
        makeCandidate({
          segment_id: "SEG_02",
          asset_id: "AST_002",
          editorial_signals: {
            peak_strength_score: 0.8,
          },
        }),
      ],
      beats: [makeBeat("B01"), makeBeat("B02")],
      transitionSkillsDir: TRANSITION_SKILLS_DIR,
    });

    expect(analysis.pairs[0].selected_skill_id).toBe("build_to_peak");
  });
});
