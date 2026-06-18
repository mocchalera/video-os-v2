import { describe, expect, it } from "vitest";
import { computePeakPriorityBonus, scoreCandidates } from "../runtime/compiler/score.js";
import { derivePeakSignalsForSegment } from "../runtime/pipeline/stages/peak.js";
import type { Candidate, NormalizedData, ScoringParams } from "../runtime/compiler/types.js";
import type { SegmentItem } from "../runtime/connectors/ffmpeg-segmenter.js";

const params: ScoringParams = {
  motif_reuse_max: 3,
  adjacency_penalty: 0,
  beat_alignment_tolerance_frames: 24,
  duration_fit_tolerance_frames: 12,
  quality_flag_penalty: 0,
};

function candidate(overrides: Partial<Candidate>): Candidate {
  return {
    segment_id: "seg",
    asset_id: "AST_A",
    src_in_us: 0,
    src_out_us: 4_000_000,
    role: "hero",
    why_it_matches: "fixture",
    risks: [],
    confidence: 0.8,
    semantic_rank: 5,
    eligible_beats: ["b01"],
    ...overrides,
  };
}

describe("peak detection scoring", () => {
  it("keeps candidate_plan refs eligible even when eligible_beats text does not match the beat", () => {
    const normalized: NormalizedData = {
      project_id: "p",
      project_title: "P",
      total_duration_frames: 120,
      role_quotas: { hero: 1, support: 0, transition: 0, texture: 0, dialogue: 0 },
      beats: [{
        beat_id: "b01",
        label: "closing impression",
        target_duration_frames: 120,
        required_roles: ["hero"],
        preferred_roles: [],
        purpose: "resolve",
        candidate_plan: {
          primary_candidate_ref: "cand_planned",
          fallback_candidate_refs: [],
        },
      }],
    };

    const ranked = scoreCandidates(
      normalized,
      [
        candidate({
          candidate_id: "cand_planned",
          segment_id: "planned",
          eligible_beats: ["unrelated discovery"],
        }),
      ],
      params,
      30,
      1,
    ).get("b01")!;

    expect(ranked.map((entry) => entry.candidate.segment_id)).toEqual(["planned"]);
  });

  it("prioritizes candidate_plan primary refs and exact eligible beat matches over generic candidates", () => {
    const normalized: NormalizedData = {
      project_id: "p",
      project_title: "P",
      total_duration_frames: 120,
      role_quotas: { hero: 0, support: 1, transition: 0, texture: 1, dialogue: 0 },
      beats: [{
        beat_id: "b05_serenity",
        label: "serenity",
        target_duration_frames: 120,
        required_roles: ["support"],
        preferred_roles: ["texture"],
        purpose: "close with quiet serenity",
        story_role: "closing",
        candidate_plan: {
          primary_candidate_ref: "cand_primary",
          fallback_candidate_refs: ["cand_fallback"],
        },
      }],
    };

    const ranked = scoreCandidates(
      normalized,
      [
        candidate({
          candidate_id: "cand_generic",
          segment_id: "generic",
          role: "texture",
          semantic_rank: 1,
          eligible_beats: undefined,
        }),
        candidate({
          candidate_id: "cand_fallback",
          segment_id: "fallback",
          role: "support",
          semantic_rank: 2,
          eligible_beats: ["b03_immersion"],
        }),
        candidate({
          candidate_id: "cand_primary",
          segment_id: "primary",
          role: "support",
          semantic_rank: 50,
          eligible_beats: ["b05_serenity"],
        }),
      ],
      params,
      30,
      1,
    ).get("b05_serenity")!;

    expect(ranked[0].candidate.segment_id).toBe("primary");
    expect(ranked[0].breakdown.plan_priority_bonus).toBeGreaterThan(
      ranked[1].breakdown.plan_priority_bonus ?? 0,
    );
    expect(ranked[0].breakdown.beat_match_bonus).toBeGreaterThan(0);
    expect(ranked.find((entry) => entry.candidate.segment_id === "generic")?.breakdown.generic_beat_penalty).toBeGreaterThan(0);
  });

  it("boosts explicit peak_signals enough to outrank a better semantic rank", () => {
    const normalized: NormalizedData = {
      project_id: "p",
      project_title: "P",
      total_duration_frames: 120,
      role_quotas: { hero: 1, support: 0, transition: 0, texture: 0, dialogue: 0 },
      beats: [{
        beat_id: "b01",
        label: "peak",
        target_duration_frames: 120,
        required_roles: ["hero"],
        preferred_roles: [],
        purpose: "payoff",
        story_role: "experience",
      }],
    };

    const ranked = scoreCandidates(
      normalized,
      [
        candidate({ segment_id: "semantic", semantic_rank: 1 }),
        candidate({
          segment_id: "peak",
          semantic_rank: 5,
          peak_signals: { motion: 0.95, audio_rms: 0.7, speech_keyword: ["cheer"] },
        }),
      ],
      params,
      30,
      1,
    ).get("b01")!;

    expect(ranked[0].candidate.segment_id).toBe("peak");
    expect(ranked[0].breakdown.peak_priority_bonus).toBeGreaterThan(0.3);
  });

  it("derives degraded peak signals from motion proxy, RMS, and speech keywords", () => {
    const segment = {
      segment_id: "seg_bike",
      asset_id: "AST_A",
      src_in_us: 0,
      src_out_us: 6_000_000,
      duration_us: 6_000_000,
      rep_frame_us: 3_000_000,
      summary: "child bicycle success with family voice",
      transcript_excerpt: "すごい、こげたね",
      quality_flags: [],
      tags: ["bike"],
      segment_type: "action",
      transcript_ref: null,
      confidence: { boundary: { score: 0.62, source: "ffmpeg_scene_detect", status: "ready" } },
      provenance: { boundary: { stage: "segment", method: "ffmpeg_scene_detect", connector_version: "x", policy_hash: "x", request_hash: "x" } },
    } satisfies SegmentItem;

    const signals = derivePeakSignalsForSegment(segment, 0.82);
    expect(signals.motion).toBeGreaterThan(0.7);
    expect(signals.audio_rms).toBe(0.82);
    expect(signals.speech_keyword).toEqual(expect.arrayContaining(["voice", "success"]));
    expect(computePeakPriorityBonus(candidate({ peak_signals: signals }))).toBeGreaterThan(0.25);
  });
});
