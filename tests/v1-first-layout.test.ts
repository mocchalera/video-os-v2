import { describe, expect, it } from "vitest";
import { assemble } from "../runtime/compiler/assemble.js";
import type {
  DurationPolicy,
  NormalizedData,
  RankedCandidateTable,
  ScoredCandidate,
  ScoringParams,
} from "../runtime/compiler/types.js";

const params: ScoringParams = {
  motif_reuse_max: 3,
  adjacency_penalty: 0.7,
  beat_alignment_tolerance_frames: 12,
  duration_fit_tolerance_frames: 12,
  quality_flag_penalty: 0,
};

const guidePolicy: DurationPolicy = {
  mode: "guide",
  source: "explicit_brief",
  target_source: "explicit_brief",
  target_duration_sec: 40,
  min_duration_sec: 0,
  max_duration_sec: null,
  hard_gate: false,
  protect_vlm_peaks: true,
};

describe("V1-first track layout", () => {
  it("single mode places hero/support/texture sequentially on V1 and leaves V2 empty", () => {
    const normalized = makeNormalized(40);
    const table: RankedCandidateTable = new Map([
      [
        "b01",
        [
          score("seg_texture", "AST_C", "texture", 1.0),
          score("seg_support_same_asset", "AST_A", "support", 0.9),
          score("seg_support_other_asset", "AST_B", "support", 0.3),
          score("seg_hero", "AST_A", "hero", 0.1),
        ],
      ],
    ]);

    const assembled = assemble(
      normalized,
      table,
      params,
      1,
      1,
      guidePolicy,
      { audioPolicy: "bgm_only" },
    );

    const v1 = assembled.tracks.video.find((track) => track.track_id === "V1")!;
    const v2 = assembled.tracks.video.find((track) => track.track_id === "V2")!;

    expect(v2.clips).toEqual([]);
    expect(v1.clips.map((clip) => clip.segment_id)).toEqual([
      "seg_hero",
      "seg_support_other_asset",
      "seg_support_same_asset",
      "seg_texture",
    ]);
    expect(v1.clips.map((clip) => clip.role)).toEqual([
      "hero",
      "support",
      "support",
      "texture",
    ]);
    expect(v1.clips.map((clip) => clip.timeline_in_frame)).toEqual([0, 10, 20, 30]);
    expect(v1.clips.every((clip) => clip.timeline_duration_frames === 10)).toBe(true);
  });

  it("single mode does not overlap clips within a beat", () => {
    const normalized = makeNormalized(30);
    const table: RankedCandidateTable = new Map([
      [
        "b01",
        [
          score("seg_hero", "AST_A", "hero", 0.9),
          score("seg_support", "AST_B", "support", 0.8),
          score("seg_texture", "AST_C", "texture", 0.7),
        ],
      ],
    ]);

    const assembled = assemble(
      normalized,
      table,
      params,
      1,
      1,
      guidePolicy,
      { audioPolicy: "bgm_only" },
    );

    const v1 = assembled.tracks.video.find((track) => track.track_id === "V1")!;
    for (let i = 1; i < v1.clips.length; i += 1) {
      const prev = v1.clips[i - 1];
      const curr = v1.clips[i];
      expect(curr.timeline_in_frame).toBe(
        prev.timeline_in_frame + prev.timeline_duration_frames,
      );
    }
  });

  it("multi mode preserves hero on V1 and support/texture on V2", () => {
    const normalized = makeNormalized(30);
    const table: RankedCandidateTable = new Map([
      [
        "b01",
        [
          score("seg_texture", "AST_C", "texture", 0.95),
          score("seg_support", "AST_B", "support", 0.9),
          score("seg_hero", "AST_A", "hero", 0.1),
        ],
      ],
    ]);

    const assembled = assemble(
      normalized,
      table,
      params,
      1,
      1,
      guidePolicy,
      { trackLayout: "multi", audioPolicy: "bgm_only" },
    );

    const v1 = assembled.tracks.video.find((track) => track.track_id === "V1")!;
    const v2 = assembled.tracks.video.find((track) => track.track_id === "V2")!;

    expect(v1.clips.map((clip) => clip.segment_id)).toEqual(["seg_hero"]);
    expect(v2.clips.map((clip) => clip.segment_id)).toEqual(["seg_texture", "seg_support"]);
    expect(v2.clips.map((clip) => clip.timeline_in_frame)).toEqual([0, 10]);
  });
});

function makeNormalized(targetDurationFrames: number): NormalizedData {
  return {
    project_id: "v1-first",
    project_title: "V1 First",
    total_duration_frames: targetDurationFrames,
    role_quotas: { hero: 1, support: 2, transition: 0, texture: 1, dialogue: 0 },
    beats: [
      {
        beat_id: "b01",
        label: "Beat 1",
        target_duration_frames: targetDurationFrames,
        required_roles: ["hero"],
        preferred_roles: ["support", "texture"],
        purpose: "test",
      },
    ],
  };
}

function score(
  segmentId: string,
  assetId: string,
  role: "hero" | "support" | "texture",
  candidateScore: number,
): ScoredCandidate {
  return {
    beat_id: "b01",
    score: candidateScore,
    candidate: {
      segment_id: segmentId,
      asset_id: assetId,
      src_in_us: 0,
      src_out_us: 10_000_000,
      role,
      why_it_matches: segmentId,
      risks: [],
      confidence: 0.9,
      semantic_rank: 1,
    },
    breakdown: {
      semantic_rank_score: candidateScore,
      quality_penalty: 0,
      duration_fit_score: 1,
      motif_reuse_penalty: 0,
      adjacency_penalty: 0,
    },
  };
}
